import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Conversation, publicData } from '../conversation.js';
import {
  computeLexicalConceptOverlap,
  computeSemanticContentHash,
  cosineSimilarity,
  deserializeEmbedding,
  EN_STOPWORDS,
  extractConceptTerms,
  l2Normalize,
  normalizeCwd,
  normalizeTopicForDedup,
  serializeEmbedding,
  tokenizeSearchQuery,
  ZH_STOPWORDS,
  type SemanticEmbedder,
} from '../semantic.js';
import type { ContextSearchHit, MemoryCard, MemoryDirectory, MemorySynapse, SynapseRelation } from '../view.js';
import type { TaskStore } from './task-store.js';

interface CachedMemoryEmbedding {
  memoryId: string;
  modelId: string;
  dim: number;
  contentHash: string;
  vector: Float32Array;
  updatedAt: number;
}

export interface SaveMemoryInput {
  id?: string;
  topic: string;
  content: string;
  tags?: string[];
  cwd?: string;
  sourceMessageId?: string;
  sourceTaskId?: string;
  supersedeId?: string;
  supersedeIds?: string[];
  pinned?: boolean;
  linkedMemoryIds?: string[];
  importance?: number;
  embedding?: Float32Array;
  embeddingModelId?: string;
}

export interface SearchContextOptions {
  query: string;
  scope?: 'all' | 'memories' | 'works' | 'messages';
  cwd?: string;
  limit?: number;
  includeSuperseded?: boolean;
  touch?: boolean;
  queryEmbedding?: Float32Array;
}

export interface SearchContextResult {
  query: string;
  scope: string;
  totalHits: number;
  hits: ContextSearchHit[];
  memoryDirectory: MemoryDirectory;
}

const AUTO_SYNAPSE_STOP_TAGS = new Set([
  'auto-consolidated', 'auto-summary', 'general', 'coding', 'research', 'review',
  'router', 'task', 'memory', 'config', 'fix', 'bug', 'test', 'dev', 'ts', 'js',
]);
const MAX_AUTO_SYNAPSES_PER_CARD = 8;
const MAX_AUTO_PEERS_PER_SAVE = 4;
const MAX_EMBEDDING_CACHE_SIZE = 4096;
const MEMORY_SELECT_COLS = 'body, access_count, last_accessed_at, last_reinforced_at, importance, pinned';

export function hasCwdConflict(cwdA?: string, cwdB?: string): boolean {
  const a = normalizeCwd(cwdA);
  const b = normalizeCwd(cwdB);
  if (!a || !b) return false;
  return a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
}

export function isAutoStubCard(card: Pick<MemoryCard, 'topic' | 'tags'>): boolean {
  const lowerTags = card.tags.map(t => t.trim().toLowerCase());
  return lowerTags.includes('auto-consolidated')
    || lowerTags.includes('auto-summary')
    || /^auto[-_ ]?summary\b/i.test(card.topic.trim());
}

export function defaultImportanceFor(card: { pinned?: boolean; topic: string; tags: string[] }): number {
  if (card.pinned) return 90;
  if (isAutoStubCard(card)) return 30;
  return 50;
}

export function memoryDocumentText(input: { topic: string; content: string; tags?: string[] }): string {
  const tagText = (input.tags ?? []).map(t => t.trim()).filter(Boolean).join(' ');
  return [input.topic.trim(), tagText, input.content.trim()].filter(Boolean).join('\n');
}

function decodeMemoryRow(row: Record<string, unknown>): MemoryCard {
  const card = JSON.parse(String(row.body)) as MemoryCard;
  if (row.access_count !== undefined && row.access_count !== null) {
    card.accessCount = Number(row.access_count);
  }
  if (row.last_accessed_at !== undefined && row.last_accessed_at !== null) {
    card.lastAccessedAt = Number(row.last_accessed_at);
  }
  if (row.last_reinforced_at !== undefined && row.last_reinforced_at !== null) {
    card.lastReinforcedAt = Number(row.last_reinforced_at);
  }
  if (row.importance !== undefined && row.importance !== null) {
    card.importance = Number(row.importance);
  }
  if (row.pinned !== undefined && row.pinned !== null) {
    if (Number(row.pinned) === 1) card.pinned = true;
    else delete card.pinned;
  }
  return card;
}

function parseMemoryRowSafe(row: Record<string, unknown>): MemoryCard | undefined {
  try {
    return decodeMemoryRow(row);
  } catch {
    return undefined;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function extractLexicalSqlKeywords(rawQuery: string): string[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) return [];
  const { lowerQuery, tokens } = tokenizeSearchQuery(trimmed);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    const clean = term.trim().toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  for (const token of tokens) {
    if (token.length < 2 || token.length > 64) continue;
    if (EN_STOPWORDS.has(token) || ZH_STOPWORDS.has(token)) continue;
    const isPureCjk = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(token);
    if (!isPureCjk || token.length <= 6) {
      push(token);
    }
  }
  for (const concept of extractConceptTerms(trimmed)) {
    if (concept.length >= 2 && concept.length <= 64) {
      push(concept);
    }
  }
  if (out.length === 0 && lowerQuery.length > 0) {
    push(lowerQuery.slice(0, 64));
  }
  return out.slice(0, 16);
}

/**
 * Persistence, deduplication, synaptic wiring, embedding cache, and hybrid retrieval
 * across global memory cards, tasks, and chat messages.
 */
export class MemoryStore {
  private semantic?: SemanticEmbedder;
  private readonly embeddingCache = new Map<string, CachedMemoryEmbedding>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(run: () => T) => T,
    private readonly tasks: TaskStore,
    private readonly conversation: Conversation,
  ) {
    this.hydrateEmbeddingCache();
  }

  attachSemanticEngine(engine?: SemanticEmbedder): void {
    this.semantic = engine;
  }

  getSemanticEngine(): SemanticEmbedder | undefined {
    return this.semantic;
  }

  private hydrateEmbeddingCache(): void {
    this.embeddingCache.clear();
    const rows = this.db.prepare(
      `SELECT e.memory_id, e.model_id, e.dim, e.content_hash, e.vector, e.updated_at
       FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
       WHERE m.superseded_by IS NULL
       ORDER BY m.updated_at DESC, m.rowid DESC
       LIMIT ?`,
    ).all(MAX_EMBEDDING_CACHE_SIZE);
    for (const row of rows.reverse()) {
      if (!(row.vector instanceof Uint8Array)) continue;
      const vec = deserializeEmbedding(row.vector, Number(row.dim));
      if (!vec) continue;
      this.embeddingCache.set(String(row.memory_id), {
        memoryId: String(row.memory_id),
        modelId: String(row.model_id),
        dim: vec.length,
        contentHash: String(row.content_hash),
        vector: vec,
        updatedAt: Number(row.updated_at),
      });
    }
  }

  private setCacheEntry(memoryId: string, entry: CachedMemoryEmbedding): void {
    if (this.embeddingCache.has(memoryId)) {
      this.embeddingCache.delete(memoryId);
    }
    while (this.embeddingCache.size >= MAX_EMBEDDING_CACHE_SIZE) {
      const oldest = this.embeddingCache.keys().next().value;
      if (oldest === undefined) break;
      this.embeddingCache.delete(oldest);
    }
    this.embeddingCache.set(memoryId, entry);
  }

  private upsertEmbeddingRecord(
    memoryId: string,
    modelId: string,
    contentHash: string,
    vec: Float32Array,
    updatedAt: number,
  ): void {
    const normalized = l2Normalize(vec);
    if (!normalized) return;
    const blob = serializeEmbedding(normalized);
    this.db.prepare(
      `INSERT INTO memory_embeddings(memory_id,model_id,dim,content_hash,vector,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(memory_id) DO UPDATE SET
         model_id=excluded.model_id,
         dim=excluded.dim,
         content_hash=excluded.content_hash,
         vector=excluded.vector,
         updated_at=excluded.updated_at`,
    ).run(memoryId, modelId, normalized.length, contentHash, blob, updatedAt);
    this.setCacheEntry(memoryId, {
      memoryId,
      modelId,
      dim: normalized.length,
      contentHash,
      vector: normalized,
      updatedAt,
    });
  }

  private deleteEmbeddingRecord(memoryId: string): void {
    this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?').run(memoryId);
    this.embeddingCache.delete(memoryId);
  }

  trimSynapses(list: MemorySynapse[]): MemorySynapse[] {
    const byTarget = new Map<string, MemorySynapse>();
    for (const syn of list) {
      if (!syn.targetId) continue;
      const prev = byTarget.get(syn.targetId);
      if (!prev || syn.weight > prev.weight || (syn.weight === prev.weight && syn.updatedAt > prev.updatedAt)) {
        byTarget.set(syn.targetId, syn);
      }
    }
    const deduped = [...byTarget.values()];
    const explicit = deduped.filter(s => s.relation === 'explicit');
    const auto = deduped
      .filter(s => s.relation !== 'explicit')
      .sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
      .slice(0, MAX_AUTO_SYNAPSES_PER_CARD);
    return [...explicit, ...auto].sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt);
  }

  private upsertSynapseOnCard(
    card: MemoryCard,
    targetId: string,
    targetTopic: string | undefined,
    relation: SynapseRelation,
    deltaOrInit?: number,
    now = Date.now(),
    mode: 'reinforce' | 'at_least' = 'reinforce',
  ): boolean {
    if (!targetId || targetId === card.id) return false;
    const rank: Record<SynapseRelation, number> = { explicit: 5, task_chain: 4, semantic: 3, co_activated: 2, shared_tag: 1 };
    const defaultInit: Record<SynapseRelation, number> = { explicit: 0.85, task_chain: 0.7, semantic: 0.7, co_activated: 0.5, shared_tag: 0.45 };
    const list = [...(card.synapses ?? [])];
    const existing = list.find(s => s.targetId === targetId);
    if (existing) {
      if (mode === 'at_least') {
        const floorW = deltaOrInit ?? defaultInit[relation];
        existing.weight = Math.min(1, Math.max(existing.weight, Number(floorW.toFixed(2))));
      } else {
        const inc = deltaOrInit ?? 0.15;
        existing.weight = Math.min(1, Number((existing.weight + inc).toFixed(2)));
      }
      if (rank[relation] > rank[existing.relation]) existing.relation = relation;
      if (targetTopic) existing.targetTopic = targetTopic;
      existing.updatedAt = now;
    } else {
      const initW = deltaOrInit ?? defaultInit[relation];
      list.push({
        targetId,
        ...(targetTopic ? { targetTopic } : {}),
        weight: Math.min(1, Math.max(0.1, Number(initW.toFixed(2)))),
        relation,
        updatedAt: now,
      });
    }
    const trimmed = this.trimSynapses(list);
    card.synapses = trimmed.length ? trimmed : undefined;
    return Boolean(card.synapses?.some(s => s.targetId === targetId));
  }

  linkMemories(
    idA: string,
    idB: string,
    relation: SynapseRelation = 'explicit',
    weightDelta?: number,
  ): { source: MemoryCard; target: MemoryCard } {
    if (idA === idB) throw new Error('Cannot link a memory neuron to itself');
    return this.atomic(() => {
      const cardA = this.getMemory(idA);
      const cardB = this.getMemory(idB);
      const now = Date.now();
      this.upsertSynapseOnCard(cardA, cardB.id, cardB.topic, relation, weightDelta, now);
      this.upsertSynapseOnCard(cardB, cardA.id, cardA.topic, relation, weightDelta, now);
      this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(cardA), cardA.id);
      this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(cardB), cardB.id);
      return { source: cardA, target: cardB };
    });
  }

  reinforceCoActivated(memoryIds: string[], relation: SynapseRelation = 'co_activated', delta = 0.12): void {
    const unique = [...new Set(memoryIds.filter(Boolean))].slice(0, 6);
    if (unique.length < 2) return;
    this.atomic(() => {
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          try {
            if (relation !== 'explicit') {
              const cardA = this.getMemory(unique[i]!);
              const cardB = this.getMemory(unique[j]!);
              if (normalizeCwd(cardA.cwd) !== normalizeCwd(cardB.cwd)) continue;
            }
            this.linkMemories(unique[i]!, unique[j]!, relation, delta);
          } catch { /* ignore missing or superseded edge errors */ }
        }
      }
    });
  }

  saveMemory(input: SaveMemoryInput): MemoryCard {
    const topic = String(publicData(input.topic.trim())).slice(0, 160);
    const content = String(publicData(input.content.trim())).slice(0, 8192);
    if (!topic || !content) throw new Error('Memory topic and content must be non-empty');
    const tags = [...new Set((input.tags ?? []).map(tag => String(publicData(tag.trim())).slice(0, 64)).filter(Boolean))].slice(0, 16);
    const cwd = input.cwd?.trim() || undefined;
    const normCwd = normalizeCwd(cwd);
    const now = Date.now();
    const normalizedInputVec = input.embedding ? l2Normalize(input.embedding) : undefined;
    const docText = memoryDocumentText({ topic, content, tags });
    const docHash = computeSemanticContentHash(docText);
    const modelId = input.embeddingModelId ?? this.semantic?.modelId ?? 'custom';
    const clampImp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

    return this.atomic(() => {
      let card: MemoryCard | undefined;
      if (input.id) {
        const existingRow = this.db.prepare(`SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE id=?`).get(input.id);
        if (existingRow) {
          const prev = parseMemoryRowSafe(existingRow);
          if (prev) {
            const nextTags = input.tags !== undefined ? tags : prev.tags;
            const nextPinned = input.pinned ?? prev.pinned;
            let nextPrePinImportance = prev.prePinImportance;
            let nextImportance: number;
            if (input.importance !== undefined) {
              nextImportance = clampImp(input.importance);
              if (input.pinned === false) nextPrePinImportance = undefined;
            } else if (input.pinned === true && !prev.pinned) {
              nextPrePinImportance = prev.importance ?? defaultImportanceFor({ pinned: false, topic: prev.topic, tags: prev.tags });
              nextImportance = Math.max(90, prev.importance ?? 90);
            } else if (input.pinned === false && prev.pinned) {
              nextImportance = prev.prePinImportance ?? defaultImportanceFor({ pinned: false, topic, tags: nextTags });
              nextPrePinImportance = undefined;
            } else {
              nextImportance = prev.importance ?? defaultImportanceFor({ pinned: nextPinned, topic, tags: nextTags });
            }
            card = {
              ...prev,
              topic,
              content,
              tags: nextTags,
              cwd: cwd ?? prev.cwd,
              sourceMessageId: input.sourceMessageId ?? prev.sourceMessageId,
              sourceTaskId: input.sourceTaskId ?? prev.sourceTaskId,
              pinned: nextPinned || undefined,
              importance: nextImportance,
              prePinImportance: nextPrePinImportance,
              updatedAt: now,
            };
            if (!nextPinned) delete card.pinned;
            if (card.prePinImportance === undefined) delete card.prePinImportance;
            this.db.prepare(
              `UPDATE memories
               SET topic=?,cwd=?,superseded_by=?,updated_at=?,access_count=?,last_accessed_at=?,last_reinforced_at=?,importance=?,pinned=?,body=?
               WHERE id=?`,
            ).run(
              card.topic,
              card.cwd ?? null,
              card.supersededBy ?? null,
              card.updatedAt,
              card.accessCount ?? 0,
              card.lastAccessedAt ?? null,
              card.lastReinforcedAt ?? null,
              card.importance ?? null,
              card.pinned ? 1 : 0,
              JSON.stringify(card),
              card.id,
            );
            const updatedHash = computeSemanticContentHash(memoryDocumentText(card));
            if (normalizedInputVec) {
              this.upsertEmbeddingRecord(card.id, modelId, updatedHash, normalizedInputVec, now);
            } else {
              const cached = this.embeddingCache.get(card.id);
              if (cached) {
                if (cached.contentHash !== updatedHash) this.deleteEmbeddingRecord(card.id);
              } else {
                const deleted = this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id=? AND content_hash!=?').run(card.id, updatedHash);
                if (deleted.changes > 0) this.embeddingCache.delete(card.id);
              }
            }
          }
        }
      }
      if (!card) {
        const id = input.id ?? randomUUID();
        const explicitSupersedeIds = [...new Set([
          ...(input.supersedeId ? [input.supersedeId] : []),
          ...(input.supersedeIds ?? []),
        ].map(s => s.trim()).filter(Boolean))];
        let priors: MemoryCard[];
        if (explicitSupersedeIds.length) {
          const priorRows = this.db.prepare(
            `SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE id IN (${explicitSupersedeIds.map(() => '?').join(',')}) AND superseded_by IS NULL`,
          ).all(...explicitSupersedeIds);
          priors = priorRows
            .map(row => parseMemoryRowSafe(row))
            .filter((prior): prior is MemoryCard => Boolean(prior && prior.id !== id));
        } else {
          const canonicalTopicKey = (value: string): string =>
            normalizeTopicForDedup(value).replace(/(?<=[\u4e00-\u9fff\u3400-\u4dbf])\s+|\s+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '');
          const normDedupTopic = canonicalTopicKey(topic);
          const isNewStub = isAutoStubCard({ topic, tags });
          const isDedupCandidate = (prior: MemoryCard): boolean => {
            if (prior.topic === topic) return true;
            if (normDedupTopic.length > 0 && canonicalTopicKey(prior.topic) === normDedupTopic) return true;
            if (prior.pinned) return false;
            const priorCached = this.embeddingCache.get(prior.id);
            const canUseEmbeddings = Boolean(
              normalizedInputVec
              && priorCached
              && priorCached.vector.length === normalizedInputVec.length
              && (!input.embeddingModelId || priorCached.modelId === modelId),
            );
            if (canUseEmbeddings) {
              return cosineSimilarity(normalizedInputVec, priorCached!.vector) >= 0.86;
            }
            if (isAutoStubCard(prior) !== isNewStub) return false;
            const overlap = computeLexicalConceptOverlap(docText, memoryDocumentText(prior));
            return overlap.jaccard >= 0.68 && overlap.sharedTerms >= 4;
          };
          priors = [];
          const pageSize = 500;
          for (let offset = 0; ; offset += pageSize) {
            const rows = this.db.prepare(
              `SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE superseded_by IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
            ).all(pageSize, offset) as Array<Record<string, unknown>>;
            if (!rows.length) break;
            for (const row of rows) {
              const prior = parseMemoryRowSafe(row);
              if (!prior || prior.id === id || normalizeCwd(prior.cwd) !== normCwd) continue;
              if (isDedupCandidate(prior)) priors.push(prior);
            }
            if (rows.length < pageSize) break;
          }
        }
        const inheritedPin = input.pinned ?? priors.some(p => p.pinned);
        const baseImp = defaultImportanceFor({ pinned: Boolean(inheritedPin), topic, tags });
        const inheritedImp = input.importance !== undefined
          ? clampImp(input.importance)
          : Math.max(baseImp, ...priors.map(p => p.importance ?? baseImp));
        const inheritedPrePinImp = inheritedPin
          ? priors.find(p => p.prePinImportance !== undefined)?.prePinImportance
            ?? (input.pinned === true && priors.length && priors.every(p => !p.pinned)
              ? Math.max(...priors.map(p => p.importance ?? defaultImportanceFor({ pinned: false, topic: p.topic, tags: p.tags })))
              : undefined)
          : undefined;
        card = {
          id,
          topic,
          content,
          tags,
          cwd,
          sourceMessageId: input.sourceMessageId,
          sourceTaskId: input.sourceTaskId,
          supersedes: priors[0]?.id,
          pinned: inheritedPin || undefined,
          importance: inheritedImp,
          ...(inheritedPrePinImp !== undefined ? { prePinImportance: inheritedPrePinImp } : {}),
          accessCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        // Inherit synapses from superseded prior neurons and redirect neighbor pointers.
        const supersededIdSet = new Set([card.id, ...priors.map(p => p.id)]);
        for (const prior of priors) {
          for (const syn of prior.synapses ?? []) {
            if (supersededIdSet.has(syn.targetId)) continue;
            try {
              const neighbor = this.getMemory(syn.targetId);
              if (neighbor.supersededBy) continue;
              this.upsertSynapseOnCard(card, syn.targetId, neighbor.topic ?? syn.targetTopic, syn.relation, syn.weight, now, 'at_least');
              neighbor.synapses = (neighbor.synapses ?? []).filter(s => !supersededIdSet.has(s.targetId));
              this.upsertSynapseOnCard(neighbor, card.id, card.topic, syn.relation, syn.weight, now, 'at_least');
              this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(neighbor), neighbor.id);
            } catch { /* ignore missing or corrupt neighbor */ }
          }
        }
        this.db.prepare(
          `INSERT INTO memories(id,topic,cwd,superseded_by,updated_at,access_count,last_accessed_at,last_reinforced_at,importance,pinned,body)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          card.id,
          card.topic,
          card.cwd ?? null,
          null,
          card.updatedAt,
          0,
          null,
          null,
          card.importance ?? null,
          card.pinned ? 1 : 0,
          JSON.stringify(card),
        );
        if (normalizedInputVec) {
          this.upsertEmbeddingRecord(card.id, modelId, docHash, normalizedInputVec, now);
        }
        for (const prior of priors) {
          prior.supersededBy = card.id;
          prior.updatedAt = now;
          this.db.prepare('UPDATE memories SET superseded_by=?,updated_at=?,body=? WHERE id=?')
            .run(card.id, now, JSON.stringify(prior), prior.id);
          this.deleteEmbeddingRecord(prior.id);
        }
      }
      // Wire explicit synapses
      const explicitLinked = new Set<string>();
      for (const linkedId of input.linkedMemoryIds ?? []) {
        if (linkedId && linkedId !== card.id) {
          try {
            this.linkMemories(card.id, linkedId, 'explicit');
            explicitLinked.add(linkedId);
          } catch { /* ignore unknown ID */ }
        }
      }
      // Domain-gated, high-threshold auto-wiring across active compatible peers
      const cardNormCwd = normalizeCwd(card.cwd);
      const cardVec = normalizedInputVec ?? this.embeddingCache.get(card.id)?.vector;
      const cardModelId = normalizedInputVec ? modelId : this.embeddingCache.get(card.id)?.modelId;
      const specificTags = new Set(
        card.tags.map(t => t.trim().toLowerCase()).filter(t => t && !AUTO_SYNAPSE_STOP_TAGS.has(t)),
      );
      if (specificTags.size >= 2 || card.sourceTaskId || cardVec) {
        const activePeers = this.listMemories({ includeSuperseded: false, limit: 200 })
          .filter(p => p.id !== card.id && !explicitLinked.has(p.id) && normalizeCwd(p.cwd) === cardNormCwd);
        const candidates: Array<{ peer: MemoryCard; relation: SynapseRelation; weight: number }> = [];
        for (const peer of activePeers) {
          if (peer.synapses?.some(s => s.targetId === card.id && s.relation === 'explicit')) continue;
          let best: { relation: SynapseRelation; weight: number } | undefined;
          const consider = (relation: SynapseRelation, weight: number) => {
            if (!best || weight > best.weight) best = { relation, weight };
          };
          if (card.sourceTaskId && peer.sourceTaskId === card.sourceTaskId) {
            consider('task_chain', 0.7);
          }
          if (cardVec) {
            const peerCached = this.embeddingCache.get(peer.id);
            if (peerCached && peerCached.vector.length === cardVec.length && (!cardModelId || peerCached.modelId === cardModelId)) {
              const sim = cosineSimilarity(cardVec, peerCached.vector);
              if (sim >= 0.68) {
                consider('semantic', Number(Math.min(0.85, sim).toFixed(2)));
              }
            }
          }
          if (specificTags.size >= 2) {
            const peerTags = new Set(peer.tags.map(t => t.trim().toLowerCase()).filter(Boolean));
            let sharedCount = 0;
            for (const tag of specificTags) {
              if (peerTags.has(tag)) sharedCount++;
            }
            if (sharedCount >= 2) {
              const initW = Number(Math.min(0.75, 0.48 + (sharedCount - 2) * 0.12).toFixed(2));
              consider('shared_tag', initW);
            }
          }
          if (best) candidates.push({ peer, ...best });
        }
        candidates.sort((a, b) => b.weight - a.weight || b.peer.updatedAt - a.peer.updatedAt);
        let wiredCount = 0;
        let freshCard = this.getMemory(card.id);
        for (const cand of candidates) {
          if (wiredCount >= MAX_AUTO_PEERS_PER_SAVE) break;
          const peerCopy: MemoryCard = { ...cand.peer, synapses: cand.peer.synapses ? cand.peer.synapses.map(s => ({ ...s })) : undefined };
          const cardCopy: MemoryCard = { ...freshCard, synapses: freshCard.synapses ? freshCard.synapses.map(s => ({ ...s })) : undefined };
          const keptOnPeer = this.upsertSynapseOnCard(peerCopy, cardCopy.id, cardCopy.topic, cand.relation, cand.weight, now, 'at_least');
          const keptOnCard = this.upsertSynapseOnCard(cardCopy, peerCopy.id, peerCopy.topic, cand.relation, cand.weight, now, 'at_least');
          if (!keptOnPeer || !keptOnCard) continue;
          this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(peerCopy), peerCopy.id);
          this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(cardCopy), cardCopy.id);
          freshCard = cardCopy;
          wiredCount++;
        }
      }
      return this.getMemory(card.id);
    });
  }

  async saveMemoryAsync(input: SaveMemoryInput): Promise<MemoryCard> {
    const rawTopic = input.topic.trim();
    const rawContent = input.content.trim();
    if (!rawTopic || !rawContent) return this.saveMemory(input);
    let embedding = input.embedding;
    let embeddingModelId = input.embeddingModelId;
    if (!embedding && this.semantic?.isReady()) {
      const topic = String(publicData(rawTopic)).slice(0, 160);
      const content = String(publicData(rawContent)).slice(0, 8192);
      let effectiveTagsInput = input.tags;
      if (effectiveTagsInput === undefined && input.id) {
        try {
          effectiveTagsInput = this.getMemory(input.id).tags;
        } catch { /* ignore if creating a new memory with explicit id */ }
      }
      const tags = [...new Set((effectiveTagsInput ?? []).map(tag => String(publicData(tag.trim())).slice(0, 64)).filter(Boolean))].slice(0, 16);
      const docText = memoryDocumentText({ topic, content, tags });
      const docHash = computeSemanticContentHash(docText);
      const existing = input.id ? this.embeddingCache.get(input.id) : undefined;
      if (existing && existing.modelId === this.semantic.modelId && existing.contentHash === docHash) {
        embedding = existing.vector;
        embeddingModelId = existing.modelId;
      } else {
        try {
          const vec = await this.semantic.embed(docText, 'document');
          if (vec) {
            embedding = vec;
            embeddingModelId = this.semantic.modelId;
          }
        } catch { /* graceful degradation */ }
      }
    }
    return this.saveMemory({ ...input, embedding, embeddingModelId });
  }

  pinMemory(id: string, pinned = true): MemoryCard {
    return this.atomic(() => {
      const card = this.getMemory(id);
      if (pinned) {
        if (!card.pinned) {
          card.prePinImportance = card.importance ?? defaultImportanceFor({ pinned: false, topic: card.topic, tags: card.tags });
        }
        card.pinned = true;
        card.importance = Math.max(90, card.importance ?? 90);
      } else {
        delete card.pinned;
        card.importance = card.prePinImportance ?? defaultImportanceFor({ pinned: false, topic: card.topic, tags: card.tags });
        delete card.prePinImportance;
      }
      card.updatedAt = Date.now();
      this.db.prepare('UPDATE memories SET updated_at=?,importance=?,pinned=?,body=? WHERE id=?')
        .run(card.updatedAt, card.importance, card.pinned ? 1 : 0, JSON.stringify(card), card.id);
      return card;
    });
  }

  /**
   * Lightweight column-only reinforcement/touch update to avoid rewriting full 8KB JSON blobs.
   */
  touchMemory(id: string, options?: { active?: boolean }): MemoryCard | undefined {
    const now = Date.now();
    if (!options?.active) {
      const row = this.db.prepare(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?
         WHERE id = ?
         RETURNING ${MEMORY_SELECT_COLS}`,
      ).get(now, id);
      return row ? decodeMemoryRow(row) : undefined;
    }
    return this.atomic(() => {
      const existing = this.db.prepare(`SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE id=?`).get(id);
      if (!existing) return undefined;
      const card = decodeMemoryRow(existing);
      const curImp = card.importance ?? defaultImportanceFor(card);
      const nextImp = curImp >= 75 ? curImp : Math.min(75, Math.max(curImp, 25) + 5);
      const updated = this.db.prepare(
        `UPDATE memories
         SET access_count = access_count + 1,
             last_accessed_at = ?,
             last_reinforced_at = ?,
             importance = ?
         WHERE id = ?
         RETURNING ${MEMORY_SELECT_COLS}`,
      ).get(now, now, nextImp, id);
      return updated ? decodeMemoryRow(updated) : undefined;
    });
  }

  updateCardFields(id: string, card: MemoryCard): void {
    this.db.prepare('UPDATE memories SET importance=?,body=? WHERE id=?')
      .run(card.importance ?? null, JSON.stringify(card), id);
  }

  getMemory(id: string): MemoryCard {
    const row = this.db.prepare(`SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE id=?`).get(id);
    if (!row) throw new Error('Memory not found');
    return decodeMemoryRow(row);
  }

  listMemories(options?: { includeSuperseded?: boolean; cwd?: string; topic?: string; limit?: number }): MemoryCard[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (!options?.includeSuperseded) clauses.push('superseded_by IS NULL');
    if (options?.cwd) { clauses.push('(cwd=? OR cwd IS NULL)'); args.push(options.cwd); }
    if (options?.topic) { clauses.push('topic=?'); args.push(options.topic); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(0, Math.floor(options?.limit ?? 100));
    const rows = this.db.prepare(
      `SELECT ${MEMORY_SELECT_COLS} FROM memories${where} ORDER BY pinned DESC, updated_at DESC, rowid DESC LIMIT ?`,
    ).all(...args, limit) as Array<Record<string, unknown>>;
    const cards: MemoryCard[] = [];
    for (const row of rows) {
      const card = parseMemoryRowSafe(row);
      if (card) cards.push(card);
    }
    return cards.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  }

  deleteMemory(id: string): boolean {
    return this.atomic(() => {
      let existing: MemoryCard | undefined;
      try { existing = this.getMemory(id); } catch { /* ignore */ }
      const incomingRows = this.db.prepare(
        `SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE id != ? AND json_valid(body)=1 AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.synapses') WHERE json_extract(value, '$.targetId') = ?)`,
      ).all(id, id) as Array<Record<string, unknown>>;
      // memory_embeddings uses ON DELETE CASCADE, so deleting the parent cleans embeddings automatically.
      const deleted = this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0;
      this.embeddingCache.delete(id);
      if (deleted) {
        const remainingOutgoingTargets = new Set<string>();
        for (const syn of existing?.synapses ?? []) {
          if (syn.targetId && syn.targetId !== id) remainingOutgoingTargets.add(syn.targetId);
        }
        for (const row of incomingRows) {
          const neighbor = parseMemoryRowSafe(row);
          if (!neighbor) continue;
          remainingOutgoingTargets.delete(neighbor.id);
          if (neighbor.synapses?.some(s => s.targetId === id)) {
            const nextSynapses = neighbor.synapses.filter(s => s.targetId !== id);
            neighbor.synapses = nextSynapses.length ? nextSynapses : undefined;
            this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(neighbor), neighbor.id);
          }
        }
        for (const targetId of remainingOutgoingTargets) {
          try {
            const neighbor = this.getMemory(targetId);
            if (neighbor.synapses?.some(s => s.targetId === id)) {
              const nextSynapses = neighbor.synapses.filter(s => s.targetId !== id);
              neighbor.synapses = nextSynapses.length ? nextSynapses : undefined;
              this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(neighbor), neighbor.id);
            }
          } catch { /* ignore */ }
        }
      }
      return deleted;
    });
  }

  memoryDirectory(limit = 24): MemoryDirectory {
    const totalRow = this.db.prepare('SELECT count(*) AS total FROM memories WHERE superseded_by IS NULL').get();
    const totalActive = Number(totalRow?.total ?? 0);
    const items = this.listMemories({ includeSuperseded: false, limit }).map(card => ({
      id: card.id,
      topic: card.topic,
      tags: card.tags,
      cwd: card.cwd,
      updatedAt: card.updatedAt,
      pinned: card.pinned,
      accessCount: card.accessCount,
      ...(card.synapses?.length ? { synapses: card.synapses } : {}),
      preview: card.content.slice(0, 120) + (card.content.length > 120 ? '…' : ''),
    }));
    return { totalActive, truncated: totalActive > items.length, items };
  }

  private collectExtendedMemoryCandidates(options: {
    includeSuperseded: boolean;
    queryText?: string;
    queryVec?: Float32Array;
    semanticThreshold: number;
    cwd?: string;
    excludeCwdConflict?: boolean;
  }): MemoryCard[] {
    const baseCards = this.listMemories({
      includeSuperseded: options.includeSuperseded,
      limit: 300,
    });
    const byId = new Map<string, MemoryCard>(baseCards.map(card => [card.id, card]));
    const skippedIds = new Set<string>();

    const queryVec = options.queryVec;
    if (queryVec) {
      const vecMatches: Array<{ memoryId: string; sim: number; updatedAt: number }> = [];
      for (const [memoryId, cached] of this.embeddingCache) {
        if (byId.has(memoryId)) continue;
        if (cached.vector.length !== queryVec.length) continue;
        if (this.semantic && cached.modelId !== this.semantic.modelId) continue;
        const sim = cosineSimilarity(queryVec, cached.vector);
        if (sim >= options.semanticThreshold) {
          vecMatches.push({ memoryId, sim, updatedAt: cached.updatedAt });
        }
      }
      if (vecMatches.length > 0) {
        vecMatches.sort((a, b) => b.sim - a.sim || b.updatedAt - a.updatedAt);
        const topIds = vecMatches.slice(0, 100).map(item => item.memoryId);
        const chunkSize = 50;
        const supersededFilter = options.includeSuperseded ? '' : ' AND superseded_by IS NULL';
        for (let offset = 0; offset < topIds.length; offset += chunkSize) {
          const chunk = topIds.slice(offset, offset + chunkSize);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = this.db.prepare(
            `SELECT ${MEMORY_SELECT_COLS} FROM memories WHERE id IN (${placeholders})${supersededFilter}`,
          ).all(...chunk);
          for (const row of rows) {
            const card = parseMemoryRowSafe(row);
            if (!card) continue;
            if (options.excludeCwdConflict && hasCwdConflict(options.cwd, card.cwd)) {
              skippedIds.add(card.id);
              continue;
            }
            byId.set(card.id, card);
          }
        }
      }
    }

    const qText = options.queryText?.trim() ?? '';
    if (baseCards.length >= 300 && qText) {
      const keywords = extractLexicalSqlKeywords(qText);
      if (keywords.length > 0) {
        const clauses: string[] = [];
        const args: Array<string | number> = [];
        if (!options.includeSuperseded) {
          clauses.push('superseded_by IS NULL');
        }
        const excludeIds = [...byId.keys(), ...skippedIds];
        if (excludeIds.length > 0) {
          clauses.push(`id NOT IN (${excludeIds.map(() => '?').join(',')})`);
          args.push(...excludeIds);
        }
        const likeParts: string[] = [];
        for (const kw of keywords) {
          const topicPattern = `%${escapeLikePattern(kw)}%`;
          const bodyPattern = `%${escapeLikePattern(kw.replace(/\\/g, '\\\\'))}%`;
          likeParts.push("(topic LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
          args.push(topicPattern, bodyPattern);
        }
        clauses.push(`(${likeParts.join(' OR ')})`);
        const where = ` WHERE ${clauses.join(' AND ')}`;
        const rows = this.db.prepare(
          `SELECT ${MEMORY_SELECT_COLS} FROM memories${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
        ).all(...args, 100);
        for (const row of rows) {
          const card = parseMemoryRowSafe(row);
          if (!card || byId.has(card.id)) continue;
          if (options.excludeCwdConflict && hasCwdConflict(options.cwd, card.cwd)) continue;
          byId.set(card.id, card);
        }
      }
    }

    return [...byId.values()];
  }

  memoriesForContext(options: {
    memoryIds?: string[];
    cwd?: string;
    queryText?: string;
    queryEmbedding?: Float32Array;
    limit?: number;
  }): MemoryCard[] {
    const selected = new Map<string, MemoryCard>();
    const limit = Math.max(1, options.limit ?? 8);
    const reqCwd = normalizeCwd(options.cwd);
    const explicitCards: MemoryCard[] = [];
    for (const id of [...new Set(options.memoryIds ?? [])]) {
      try {
        const card = this.touchMemory(id, { active: true }) ?? this.getMemory(id);
        selected.set(card.id, card);
        explicitCards.push(card);
      } catch { /* ignore unknown memory IDs */ }
    }
    if (explicitCards.length >= 2) {
      this.reinforceCoActivated(explicitCards.map(c => c.id), 'co_activated', 0.15);
      for (let i = 0; i < explicitCards.length; i++) {
        try {
          const refreshed = this.getMemory(explicitCards[i]!.id);
          explicitCards[i] = refreshed;
          selected.set(refreshed.id, refreshed);
        } catch { /* ignore */ }
      }
    }
    // (a) Up to 2 tightly gated 1-hop synaptic neighbors (weight >= 0.60 in compatible cwd)
    const neighborCandidates: Array<{ card: MemoryCard; weight: number }> = [];
    const seenNeighborIds = new Set<string>();
    for (const seed of explicitCards) {
      const expectedScope = reqCwd || normalizeCwd(seed.cwd);
      for (const syn of seed.synapses ?? []) {
        if (syn.weight < 0.60 || selected.has(syn.targetId) || seenNeighborIds.has(syn.targetId)) continue;
        try {
          const neighbor = this.getMemory(syn.targetId);
          if (neighbor.supersededBy) continue;
          if (normalizeCwd(neighbor.cwd) !== expectedScope) continue;
          seenNeighborIds.add(neighbor.id);
          neighborCandidates.push({ card: neighbor, weight: syn.weight });
        } catch { /* ignore */ }
      }
    }
    neighborCandidates.sort((a, b) => b.weight - a.weight || b.card.updatedAt - a.card.updatedAt);
    let addedNeighbors = 0;
    for (const { card: neighbor } of neighborCandidates) {
      if (selected.size >= limit || addedNeighbors >= 2) break;
      selected.set(neighbor.id, neighbor);
      addedNeighbors++;
    }

    // (c) Semantic (cosine >= 0.48) or strong lexical match against queryText/queryEmbedding
    const qText = options.queryText?.trim() ?? '';
    const qVec = options.queryEmbedding ? l2Normalize(options.queryEmbedding) : undefined;
    const activePool = selected.size < limit
      ? this.collectExtendedMemoryCandidates({
          includeSuperseded: false,
          queryText: qText,
          queryVec: qVec,
          semanticThreshold: 0.48,
          cwd: options.cwd,
          excludeCwdConflict: true,
        })
      : [];
    if (selected.size < limit && (qText || qVec)) {
      const lowerQ = qText.toLowerCase();
      const matched: Array<{ card: MemoryCard; score: number }> = [];
      for (const card of activePool) {
        if (selected.has(card.id)) continue;
        if (hasCwdConflict(options.cwd, card.cwd)) continue;
        const cached = this.embeddingCache.get(card.id);
        const canCompare = Boolean(
          qVec
          && cached
          && cached.vector.length === qVec.length
          && (!this.semantic || cached.modelId === this.semantic.modelId),
        );
        const semSim = canCompare ? cosineSimilarity(qVec, cached!.vector) : 0;
        let strongLex = false;
        let lexBonus = 0;
        if (qText) {
          const doc = memoryDocumentText(card);
          const overlap = computeLexicalConceptOverlap(qText, doc);
          const exactSub = lowerQ.length >= 3 && doc.toLowerCase().includes(lowerQ);
          strongLex = exactSub || overlap.sharedTerms >= 2 || (overlap.jaccard >= 0.35 && overlap.sharedTerms >= 1);
          lexBonus = (exactSub ? 40 : 0) + overlap.sharedTerms * 12 + overlap.jaccard * 30;
        }
        if (semSim < 0.48 && !strongLex) continue;
        const sameCwdBoost = reqCwd && normalizeCwd(card.cwd) === reqCwd ? 15 : 0;
        const total = (semSim >= 0.48 ? semSim * 100 : 0) + lexBonus + sameCwdBoost + (card.pinned ? 10 : 0);
        matched.push({ card, score: total });
      }
      matched.sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt);
      for (const item of matched) {
        if (selected.size >= limit) break;
        selected.set(item.card.id, item.card);
      }
    }

    // (b) Same normalized cwd active cards ONLY when non-empty cwd is provided; zero unrelated padding
    if (selected.size < limit && reqCwd) {
      for (const card of activePool) {
        if (selected.size >= limit) break;
        if (selected.has(card.id)) continue;
        if (normalizeCwd(card.cwd) === reqCwd) {
          selected.set(card.id, card);
        }
      }
    }
    return [...selected.values()];
  }

  async memoriesForContextAsync(options: {
    memoryIds?: string[];
    cwd?: string;
    queryText?: string;
    limit?: number;
  }): Promise<MemoryCard[]> {
    let queryEmbedding: Float32Array | undefined;
    const qText = options.queryText?.trim();
    if (qText && this.semantic?.isReady()) {
      try {
        queryEmbedding = await this.semantic.embed(qText, 'query');
      } catch { /* graceful degradation */ }
    }
    return this.memoriesForContext({ ...options, queryEmbedding });
  }

  searchContext(options: SearchContextOptions): SearchContextResult {
    const rawQuery = options.query.trim();
    if (!rawQuery) throw new Error('Search query must not be empty');
    const scope = options.scope ?? 'all';
    const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
    const reqCwd = normalizeCwd(options.cwd);
    const { lowerQuery, tokens, cjkBigrams } = tokenizeSearchQuery(rawQuery);
    const now = Date.now();
    const recencyBonus = (at: number) => Math.max(0, 8 - Math.max(0, now - at) / (24 * 3600_000));
    const cwdBonus = (itemCwd?: string) => {
      const normItem = normalizeCwd(itemCwd);
      if (!reqCwd || !normItem) return 0;
      if (normItem === reqCwd) return 25;
      if (normItem.startsWith(`${reqCwd}/`) || reqCwd.startsWith(`${normItem}/`)) return 15;
      return -25;
    };
    const scoreText = (header: string, bodyText: string) => {
      const h = header.toLowerCase();
      const b = bodyText.toLowerCase();
      const combined = `${h}\n${b}`;
      let score = 0;
      let matchedTokens = 0;
      let firstAnchor = '';
      if (combined.includes(lowerQuery)) {
        score += 50;
        matchedTokens++;
        firstAnchor = lowerQuery;
      }
      for (const token of tokens) {
        if (!token) continue;
        let hit = false;
        if (h.includes(token)) { score += 22; hit = true; }
        if (b.includes(token)) { score += 12; hit = true; }
        if (hit) {
          matchedTokens++;
          if (!firstAnchor) firstAnchor = token;
        }
      }
      if (cjkBigrams.size > 0) {
        let bigramHits = 0;
        for (const bg of cjkBigrams) {
          if (combined.includes(bg)) {
            bigramHits++;
            if (!firstAnchor) firstAnchor = bg;
          }
        }
        if (bigramHits >= Math.min(2, cjkBigrams.size)) {
          score += bigramHits * 6;
          matchedTokens += bigramHits;
        }
      }
      return { score: matchedTokens > 0 ? score : 0, firstAnchor };
    };
    const buildSnippet = (textValue: string, anchor: string, maxLen = 280) => {
      const clean = String(publicData(textValue));
      if (clean.length <= maxLen) return clean;
      const idx = anchor ? clean.toLowerCase().indexOf(anchor) : -1;
      if (idx < 0) return clean.slice(0, maxLen) + '…';
      const start = Math.max(0, idx - 80);
      const end = Math.min(clean.length, start + maxLen);
      return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
    };

    const queryVec = options.queryEmbedding ? l2Normalize(options.queryEmbedding) : undefined;
    const hits: ContextSearchHit[] = [];
    const directMemoryHits = new Map<string, { card: MemoryCard; hit: ContextSearchHit }>();
    if (scope === 'all' || scope === 'memories') {
      const includeSuperseded = options.includeSuperseded ?? false;
      const cards = this.collectExtendedMemoryCandidates({
        includeSuperseded,
        queryText: rawQuery,
        queryVec,
        semanticThreshold: 0.42,
        cwd: options.cwd,
        excludeCwdConflict: false,
      });
      const cardById = new Map(cards.map(c => [c.id, c]));
      for (const card of cards) {
        const header = `${card.topic} ${card.tags.join(' ')} ${card.cwd ?? ''}`;
        const { score: lexScore, firstAnchor } = scoreText(header, card.content);
        const cached = !card.supersededBy ? this.embeddingCache.get(card.id) : undefined;
        const canCompareVec = Boolean(
          queryVec
          && cached
          && cached.vector.length === queryVec.length
          && (!this.semantic || cached.modelId === this.semantic.modelId),
        );
        const semSim = canCompareVec ? cosineSimilarity(queryVec, cached!.vector) : 0;
        if (lexScore <= 0 && semSim < 0.42) continue;
        const base = card.supersededBy ? 5 : 30;
        const pinBonus = card.pinned ? 15 : 0;
        const ebbinghausBonus = Math.min(12, (card.accessCount ?? 0) * 2);
        const semScore = semSim >= 0.42 ? Math.max(0, (semSim - 0.30) * 90) : 0;
        const finalScore = Number((base + pinBonus + ebbinghausBonus + lexScore + semScore + cwdBonus(card.cwd) + recencyBonus(card.updatedAt)).toFixed(2));
        if (finalScore <= 0) continue;
        const hit: ContextSearchHit = {
          kind: 'memory',
          id: card.id,
          memoryId: card.id,
          score: finalScore,
          at: card.updatedAt,
          title: `记忆卡片${card.pinned ? ' [核心]' : ''} · ${card.topic}${card.supersededBy ? '（已被新记忆替代）' : ''}`,
          snippet: buildSnippet(card.content, firstAnchor, 360),
          cwd: card.cwd,
          tags: card.tags,
          ...(card.synapses?.length ? { synapses: card.synapses } : {}),
          taskId: card.sourceTaskId,
          messageId: card.sourceMessageId,
        };
        hits.push(hit);
        directMemoryHits.set(card.id, { card, hit });
      }
      // 1-hop Synaptic Spreading Activation across connected memory neurons (weight >= 0.60, spreadScore >= 32, domain-gated)
      const topSeeds = [...directMemoryHits.values()].sort((a, b) => b.hit.score - a.hit.score).slice(0, 5);
      const spreadCandidates = new Map<string, ContextSearchHit>();
      for (const { card: seedCard, hit: seedHit } of topSeeds) {
        for (const syn of seedCard.synapses ?? []) {
          if (syn.weight < 0.60) continue;
          let targetCard = cardById.get(syn.targetId);
          if (!targetCard) {
            try {
              const fetched = this.getMemory(syn.targetId);
              if (includeSuperseded || !fetched.supersededBy) {
                targetCard = fetched;
                cardById.set(fetched.id, fetched);
              }
            } catch { /* ignore missing target */ }
          }
          if (!targetCard) continue;
          if (hasCwdConflict(seedCard.cwd, targetCard.cwd) || hasCwdConflict(options.cwd, targetCard.cwd)) continue;
          const directTarget = directMemoryHits.get(targetCard.id);
          if (directTarget) {
            directTarget.hit.score = Number((directTarget.hit.score + syn.weight * 8).toFixed(2));
            continue;
          }
          const spreadScore = Number((seedHit.score * syn.weight * 0.45 + (targetCard.pinned ? 6 : 0)).toFixed(2));
          if (spreadScore < 32) continue;
          const prevSpread = spreadCandidates.get(targetCard.id);
          if (!prevSpread || spreadScore > prevSpread.score) {
            spreadCandidates.set(targetCard.id, {
              kind: 'memory',
              id: targetCard.id,
              memoryId: targetCard.id,
              score: spreadScore,
              at: targetCard.updatedAt,
              title: `记忆卡片${targetCard.pinned ? ' [核心]' : ''} · ${targetCard.topic}（⚡ 突触扩散激活）`,
              snippet: buildSnippet(targetCard.content, '', 360),
              cwd: targetCard.cwd,
              tags: targetCard.tags,
              ...(targetCard.synapses?.length ? { synapses: targetCard.synapses } : {}),
              activatedVia: { memoryId: seedCard.id, topic: seedCard.topic, weight: syn.weight, relation: syn.relation },
              taskId: targetCard.sourceTaskId,
              messageId: targetCard.sourceMessageId,
            });
          }
        }
      }
      for (const spreadHit of spreadCandidates.values()) hits.push(spreadHit);
    }

    if (scope === 'all' || scope === 'works') {
      for (const task of this.tasks.list(200)) {
        const header = `${task.prompt} ${task.cwd ?? ''} ${(task.paths ?? []).join(' ')} ${task.profile ?? ''}`;
        const bodyText = `${task.report ?? ''}\n${task.reason ?? ''}\n${task.contextBrief ?? ''}`;
        const { score, firstAnchor } = scoreText(header, bodyText);
        if (score <= 0) continue;
        const base = task.status === 'completed' ? 18 : 12;
        const finalScore = Number((base + score + cwdBonus(task.cwd) + recencyBonus(task.createdAt)).toFixed(2));
        if (finalScore <= 0) continue;
        hits.push({
          kind: 'work',
          id: task.id,
          taskId: task.id,
          score: finalScore,
          at: task.createdAt,
          title: `后台工作 (${task.status}) · ${String(publicData(task.prompt.slice(0, 100)))}`,
          snippet: buildSnippet(task.report ?? task.reason ?? task.prompt, firstAnchor, 320),
          cwd: task.cwd,
          status: task.status,
          parentTaskId: task.parentTaskId,
          originMessageId: task.originMessageId,
        });
      }
    }

    const msgSeqByHitId = new Map<string, number>();
    if (scope === 'all' || scope === 'messages') {
      for (const msg of this.conversation.allMessages(300)) {
        const header = `${msg.role} ${msg.paths.join(' ')}`;
        const { score, firstAnchor } = scoreText(header, msg.text);
        if (score <= 0) continue;
        const finalScore = Number((10 + score + recencyBonus(msg.at)).toFixed(2));
        hits.push({
          kind: 'message',
          id: msg.id,
          messageId: msg.id,
          score: finalScore,
          at: msg.at,
          title: `历史对话 (${msg.role === 'user' ? '用户' : 'F.R.I.D.A.Y.'}) · #${msg.seq}`,
          snippet: buildSnippet(msg.text, firstAnchor, 280),
          linkedTaskIds: msg.taskIds.length ? msg.taskIds : undefined,
        });
        msgSeqByHitId.set(msg.id, msg.seq);
      }
    }

    hits.sort((a, b) => b.score - a.score || b.at - a.at);
    const topHits = hits.slice(0, limit);

    // Fetch neighbors only for final message hits (avoids N+1 queries over discarded hits).
    const topMsgSeqs = topHits
      .filter(h => h.kind === 'message')
      .map(h => msgSeqByHitId.get(h.id))
      .filter((seq): seq is number => seq !== undefined);
    if (topMsgSeqs.length > 0) {
      const neighborsMap = this.conversation.neighborsBatch(topMsgSeqs, 1);
      for (const hit of topHits) {
        if (hit.kind !== 'message') continue;
        const seq = msgSeqByHitId.get(hit.id);
        if (seq !== undefined) hit.neighbors = neighborsMap.get(seq) ?? [];
      }
    }

    if (options.touch) {
      const touchIds = topHits
        .map(h => (h.kind === 'memory' ? h.memoryId : undefined))
        .filter((id): id is string => Boolean(id));
      if (touchIds.length > 0) {
        this.atomic(() => {
          for (const id of touchIds) this.touchMemory(id);
        });
      }
    }

    return {
      query: rawQuery,
      scope,
      totalHits: hits.length,
      hits: topHits,
      memoryDirectory: this.memoryDirectory(16),
    };
  }

  async searchContextAsync(options: SearchContextOptions): Promise<SearchContextResult> {
    const rawQuery = options.query.trim();
    if (!rawQuery) throw new Error('Search query must not be empty');
    let queryEmbedding = options.queryEmbedding;
    const needsMemorySearch = options.scope === undefined || options.scope === 'all' || options.scope === 'memories';
    if (!queryEmbedding && needsMemorySearch && this.semantic?.isReady()) {
      try {
        queryEmbedding = await this.semantic.embed(rawQuery, 'query');
      } catch { /* graceful degradation */ }
    }
    return this.searchContext({ ...options, queryEmbedding });
  }

  async backfillEmbeddings(limit = 64, signal?: AbortSignal): Promise<number> {
    const engine = this.semantic;
    if (!engine || signal?.aborted) return 0;
    if (!engine.isReady()) {
      if (!engine.ensureReady) return 0;
      try {
        const ok = await engine.ensureReady(signal);
        if (!ok || signal?.aborted) return 0;
      } catch {
        return 0;
      }
    }
    const maxCount = Math.max(1, Math.floor(limit));
    const pending: Array<{ card: MemoryCard; docText: string; docHash: string }> = [];
    const pageSize = 200;
    for (let offset = 0; pending.length < maxCount; offset += pageSize) {
      if (signal?.aborted) break;
      const rows = this.db.prepare(
        `SELECT m.body, m.access_count, m.last_accessed_at, m.last_reinforced_at, m.importance, m.pinned,
                e.model_id AS emb_model_id, e.content_hash AS emb_hash
         FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
         WHERE m.superseded_by IS NULL
         ORDER BY m.pinned DESC, m.updated_at DESC, m.rowid DESC
         LIMIT ? OFFSET ?`,
      ).all(pageSize, offset) as Array<Record<string, unknown>>;
      if (!rows.length) break;
      for (const row of rows) {
        if (pending.length >= maxCount) break;
        const card = parseMemoryRowSafe(row);
        if (!card) continue;
        const docText = memoryDocumentText(card);
        const docHash = computeSemanticContentHash(docText);
        if (row.emb_model_id === engine.modelId && row.emb_hash === docHash) continue;
        const cached = this.embeddingCache.get(card.id);
        if (cached && cached.modelId === engine.modelId && cached.contentHash === docHash) continue;
        pending.push({ card, docText, docHash });
      }
      if (rows.length < pageSize) break;
    }
    if (!pending.length) return 0;

    let updated = 0;
    const batchSize = 16;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (signal?.aborted) break;
      const chunk = pending.slice(offset, offset + batchSize);
      let vectors: Array<Float32Array | undefined>;
      try {
        if (engine.embedBatch) {
          vectors = await engine.embedBatch(chunk.map(item => item.docText), 'document');
        } else {
          vectors = [];
          for (const item of chunk) {
            if (signal?.aborted) break;
            vectors.push(await engine.embed(item.docText, 'document'));
          }
        }
      } catch {
        continue;
      }
      if (signal?.aborted) break;
      this.atomic(() => {
        const now = Date.now();
        for (let i = 0; i < Math.min(chunk.length, vectors.length); i++) {
          const item = chunk[i]!;
          const vec = vectors[i];
          if (!vec) continue;
          const row = this.db.prepare('SELECT superseded_by FROM memories WHERE id=?').get(item.card.id);
          if (!row || row.superseded_by !== null) continue;
          this.upsertEmbeddingRecord(item.card.id, engine.modelId, item.docHash, vec, now);
          updated++;
        }
      });
    }
    return updated;
  }
}
