import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Conversation, publicData } from '../conversation.js';
import type { MemoryCard, MemorySynapse, WorkerProfile } from '../view.js';
import { defaultImportanceFor, isAutoStubCard, type MemoryStore } from './memory-store.js';
import type { TaskStore } from './task-store.js';

export interface SubconsciousResidue {
  id: string;
  impression: string;
  insight?: string;
  insightSurfaced?: boolean;
  salience: 'faint' | 'vivid';
  interrupted?: boolean;
  createdAt: number;
  turnsElapsed: number;
}

export interface SubconsciousState {
  lastWakeAt: number;
  lastMessageSeq: number;
  digestedTaskIds: string[];
  nextLatencyMs?: number;
  refractoryMs?: number;
  residues: SubconsciousResidue[];
  cursorVersion?: number;
}

export interface DreamMaterial {
  undigestedMessages: Array<{ id: string; seq: number; role: 'user' | 'assistant'; text: string; at: number }>;
  undigestedTasks: Array<{ id: string; prompt: string; cwd?: string; profile?: WorkerProfile; reportSnippet: string; createdAt: number }>;
  rawStubs: MemoryCard[];
  distantMemories: MemoryCard[];
  candidateCwds: string[];
  latestMessageSeq: number;
  completedTaskIds: string[];
}

export interface ChatSubconscious {
  pendingInsight?: { id: string; insight: string };
  impressions: Array<{ vividness: 'clear' | 'hazy'; text: string; interrupted?: boolean; hoursAgo: number }>;
}

export interface DistillerState {
  lastMessageSeq: number;
  distilledTaskIds: string[];
  lastRunAt: number;
}

export interface HomeostaticPassOptions {
  decayAfterMs?: number;
  decayFactor?: number;
  minWeight?: number;
  stubMaxAgeMs?: number;
  coldMaxAgeMs?: number;
  coldDecayIntervalMs?: number;
  coldImportanceThreshold?: number;
  coldDecayStep?: number;
  coldPruneThreshold?: number;
  force?: boolean;
}

export interface HomeostaticPassResult {
  scaledSynapses: number;
  prunedSynapses: number;
  forgottenStubs: number;
  decayedCards: number;
  prunedColdCards: number;
}

export interface RecordDreamOutcomeInput {
  now?: number;
  completed: boolean;
  latestMessageSeq?: number;
  digestedTaskIds?: string[];
  refractoryMs?: number;
  nextLatencyMs?: number;
  residue?: { impression: string; insight?: string; salience: 'faint' | 'vivid'; interrupted?: boolean };
}

/**
 * Manages decoupled cursors for background memory distillation and offline
 * dream consolidation, homeostatic synaptic decay, and dream residues.
 */
export class ConsolidationStore {
  private hasResiduesCache = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(run: () => T) => T,
    private readonly tasks: TaskStore,
    private readonly memories: MemoryStore,
    private readonly conversation: Conversation,
  ) {
    this.migrateSubconsciousCursor();
    this.hasResiduesCache = (this.conversation.meta<SubconsciousState>('subconscious_state')?.residues?.length ?? 0) > 0;
  }

  /**
   * Older releases coupled `markDistilled` with `subconscious_state`, causing Distiller to
   * silently advance Dreamer's cursors and starve `sampleDreamMaterial`. Reset/clamp legacy
   * poisoned cursors once without disturbing real completed Dreamer wakeups.
   */
  private migrateSubconsciousCursor(): void {
    const savedSub = this.conversation.meta<SubconsciousState>('subconscious_state');
    if (!savedSub || typeof savedSub !== 'object' || (savedSub.cursorVersion ?? 0) >= 2) return;

    const lastWakeAt = Number(savedSub.lastWakeAt ?? 0);
    let lastMessageSeq = Number(savedSub.lastMessageSeq ?? 0);
    let digestedTaskIds = Array.isArray(savedSub.digestedTaskIds) ? [...savedSub.digestedTaskIds] : [];

    if (lastWakeAt <= 0) {
      lastMessageSeq = 0;
      digestedTaskIds = [];
    } else {
      const distiller = this.conversation.meta<DistillerState>('memory_distiller_state');
      if (distiller && Number(distiller.lastRunAt ?? 0) > lastWakeAt) {
        const seqRow = this.db.prepare(
          `SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE coalesce(CAST(CASE WHEN json_valid(body) THEN json_extract(body, '$.at') END AS INTEGER), 0) <= ?`,
        ).get(lastWakeAt);
        lastMessageSeq = Math.min(lastMessageSeq, Number(seqRow?.seq ?? 0));
        const distilledSet = new Set(Array.isArray(distiller.distilledTaskIds) ? distiller.distilledTaskIds : []);
        if (distilledSet.size > 0) {
          digestedTaskIds = digestedTaskIds.filter(id => {
            if (!distilledSet.has(id)) return true;
            try {
              return this.tasks.get(id).createdAt <= lastWakeAt;
            } catch {
              return false;
            }
          });
        }
      }
    }

    this.saveSubconsciousState({
      ...savedSub,
      lastWakeAt,
      lastMessageSeq,
      digestedTaskIds: digestedTaskIds.slice(-120),
      residues: Array.isArray(savedSub.residues) ? savedSub.residues : [],
      cursorVersion: 2,
    });
  }

  distillerState(): DistillerState {
    const saved = this.conversation.meta<DistillerState>('memory_distiller_state');
    if (saved && typeof saved === 'object') {
      return {
        lastMessageSeq: Number(saved.lastMessageSeq ?? 0),
        distilledTaskIds: Array.isArray(saved.distilledTaskIds) ? saved.distilledTaskIds.slice(-200) : [],
        lastRunAt: Number(saved.lastRunAt ?? 0),
      };
    }
    return { lastMessageSeq: 0, distilledTaskIds: [], lastRunAt: 0 };
  }

  saveDistillerState(state: DistillerState): void {
    this.conversation.setMeta('memory_distiller_state', {
      lastMessageSeq: Math.max(0, Number(state.lastMessageSeq ?? 0)),
      distilledTaskIds: [...new Set((state.distilledTaskIds ?? []).filter(Boolean))].slice(-200),
      lastRunAt: Math.max(0, Number(state.lastRunAt ?? 0)),
    });
  }

  initDistillerStateIfMissing(): DistillerState {
    const saved = this.conversation.meta<DistillerState>('memory_distiller_state');
    if (saved && typeof saved === 'object') return this.distillerState();
    const latestSeq = this.conversation.allMessages(1)[0]?.seq ?? 0;
    const existingCompletedIds = this.tasks.list(120)
      .filter(task => task.status === 'completed')
      .map(task => task.id)
      .slice(-200);
    const initial: DistillerState = {
      lastMessageSeq: latestSeq,
      distilledTaskIds: existingCompletedIds,
      lastRunAt: 0,
    };
    this.saveDistillerState(initial);
    return initial;
  }

  markDistilled(update: { latestMessageSeq?: number; taskIds?: string[]; now?: number }): void {
    this.atomic(() => {
      const prev = this.distillerState();
      const nextSeq = update.latestMessageSeq !== undefined
        ? Math.max(prev.lastMessageSeq, update.latestMessageSeq)
        : prev.lastMessageSeq;
      const nextTaskIds = update.taskIds?.length
        ? [...new Set([...prev.distilledTaskIds, ...update.taskIds.filter(Boolean)])].slice(-200)
        : prev.distilledTaskIds;
      this.saveDistillerState({
        lastMessageSeq: nextSeq,
        distilledTaskIds: nextTaskIds,
        lastRunAt: update.now ?? Date.now(),
      });
    });
  }

  subconsciousState(): SubconsciousState {
    const saved = this.conversation.meta<SubconsciousState>('subconscious_state');
    if (saved && typeof saved === 'object') {
      return {
        lastWakeAt: Number(saved.lastWakeAt ?? 0),
        lastMessageSeq: Number(saved.lastMessageSeq ?? 0),
        digestedTaskIds: Array.isArray(saved.digestedTaskIds) ? saved.digestedTaskIds.slice(-120) : [],
        ...(typeof saved.nextLatencyMs === 'number' ? { nextLatencyMs: saved.nextLatencyMs } : {}),
        ...(typeof saved.refractoryMs === 'number' ? { refractoryMs: saved.refractoryMs } : {}),
        residues: Array.isArray(saved.residues) ? saved.residues : [],
      };
    }
    return { lastWakeAt: 0, lastMessageSeq: 0, digestedTaskIds: [], residues: [] };
  }

  saveSubconsciousState(state: SubconsciousState): void {
    const trimmedResidues = state.residues.slice(-3);
    this.hasResiduesCache = trimmedResidues.length > 0;
    this.conversation.setMeta('subconscious_state', {
      ...state,
      digestedTaskIds: state.digestedTaskIds.slice(-120),
      residues: trimmedResidues,
      cursorVersion: 2,
    });
  }

  homeostaticSleepPass(now = Date.now(), options?: HomeostaticPassOptions): HomeostaticPassResult {
    const decayAfterMs = options?.decayAfterMs ?? 24 * 3600_000;
    const decayFactor = options?.decayFactor ?? 0.82;
    const minWeight = options?.minWeight ?? 0.30;
    const stubMaxAgeMs = options?.stubMaxAgeMs ?? 7 * 24 * 3600_000;
    const coldMaxAgeMs = options?.coldMaxAgeMs ?? 45 * 24 * 3600_000;
    const coldDecayIntervalMs = options?.coldDecayIntervalMs ?? 15 * 24 * 3600_000;
    const coldImportanceThreshold = options?.coldImportanceThreshold ?? 55;
    const coldPruneThreshold = options?.coldPruneThreshold ?? 20;
    const dayKey = new Date(now).toISOString().slice(0, 10);
    let scaledSynapses = 0;
    let prunedSynapses = 0;
    let forgottenStubs = 0;
    let decayedCards = 0;
    let prunedColdCards = 0;
    return this.atomic(() => {
      if (!options?.force) {
        const lastRun = this.conversation.meta<{ dayKey?: string; ranAt?: number }>('homeostatic_sleep_pass_v1');
        if (lastRun?.dayKey === dayKey) {
          return { scaledSynapses, prunedSynapses, forgottenStubs, decayedCards, prunedColdCards };
        }
      }

      const prunedPairs: Array<{ fromId: string; toId: string }> = [];
      let cursorUpdatedAt = -1;
      let cursorRowId = -1;
      const pageSize = 500;

      while (true) {
        const rows = this.db.prepare(
          `SELECT rowid AS _rowid, updated_at AS _updated_at, pinned AS _pinned, body, access_count, last_accessed_at, last_reinforced_at, importance
           FROM memories
           WHERE superseded_by IS NULL
             AND (updated_at > ? OR (updated_at = ? AND rowid > ?))
           ORDER BY updated_at ASC, rowid ASC
           LIMIT ?`,
        ).all(cursorUpdatedAt, cursorUpdatedAt, cursorRowId, pageSize) as Array<Record<string, unknown>>;
        if (!rows.length) break;

        for (const row of rows) {
          cursorUpdatedAt = Number(row._updated_at);
          cursorRowId = Number(row._rowid);
          let card: MemoryCard;
          try {
            card = JSON.parse(String(row.body)) as MemoryCard;
          } catch {
            continue;
          }
          if (row.access_count !== undefined && row.access_count !== null) card.accessCount = Number(row.access_count);
          if (row.last_accessed_at !== undefined && row.last_accessed_at !== null) card.lastAccessedAt = Number(row.last_accessed_at);
          if (row.last_reinforced_at !== undefined && row.last_reinforced_at !== null) card.lastReinforcedAt = Number(row.last_reinforced_at);
          if (row.importance !== undefined && row.importance !== null) card.importance = Number(row.importance);
          if (row._pinned !== undefined && row._pinned !== null) {
            if (Number(row._pinned) === 1) card.pinned = true;
            else delete card.pinned;
          }

          const imp = card.importance ?? defaultImportanceFor(card);
          const recentlyReinforced = Boolean(card.lastReinforcedAt && now - card.lastReinforcedAt < stubMaxAgeMs);
          if (
            isAutoStubCard(card)
            && !card.pinned
            && imp < 85
            && (card.accessCount ?? 0) < 3
            && !recentlyReinforced
            && now - card.updatedAt >= stubMaxAgeMs
          ) {
            if (this.memories.deleteMemory(card.id)) forgottenStubs++;
            continue;
          }
          let cardMutated = false;
          const lastActiveAt = Math.max(card.lastAccessedAt ?? 0, card.lastReinforcedAt ?? 0, card.updatedAt);
          const coldAgeMs = now - lastActiveAt;
          const coldCooldownOk = !card.lastDecayedAt || now - card.lastDecayedAt >= coldDecayIntervalMs;
          if (!card.pinned && imp < 75 && imp < coldImportanceThreshold && coldAgeMs >= coldMaxAgeMs && coldCooldownOk) {
            const overdueBuckets = Math.floor((coldAgeMs - coldMaxAgeMs) / (15 * 24 * 3600_000));
            const decayStep = options?.coldDecayStep ?? Math.min(35, 15 + overdueBuckets * 10);
            const nextImp = Math.max(0, imp - decayStep);
            if (nextImp <= coldPruneThreshold) {
              if (this.memories.deleteMemory(card.id)) prunedColdCards++;
              continue;
            }
            if (nextImp !== imp) {
              card.importance = nextImp;
              card.lastDecayedAt = now;
              decayedCards++;
              cardMutated = true;
            }
          }
          if (card.synapses?.length) {
            let synMutated = false;
            const nextSynapses: MemorySynapse[] = [];
            for (const syn of card.synapses) {
              if (syn.relation === 'explicit' || now - syn.updatedAt < decayAfterMs) {
                nextSynapses.push(syn);
                continue;
              }
              const decayed = Number((syn.weight * decayFactor).toFixed(2));
              if (decayed < minWeight) {
                prunedSynapses++;
                prunedPairs.push({ fromId: card.id, toId: syn.targetId });
                synMutated = true;
              } else {
                if (decayed !== syn.weight) {
                  scaledSynapses++;
                  synMutated = true;
                }
                nextSynapses.push({ ...syn, weight: decayed });
              }
            }
            if (synMutated) {
              const trimmed = this.memories.trimSynapses(nextSynapses);
              card.synapses = trimmed.length ? trimmed : undefined;
              cardMutated = true;
            }
          }
          if (cardMutated) {
            this.memories.updateCardFields(card.id, card);
          }
        }
        if (rows.length < pageSize) break;
      }

      // Clean any asymmetric reverse non-explicit synapse leftovers on surviving targets.
      for (const pair of prunedPairs) {
        try {
          const target = this.memories.getMemory(pair.toId);
          if (target.synapses?.some(s => s.targetId === pair.fromId && s.relation !== 'explicit')) {
            const remaining = target.synapses.filter(s => !(s.targetId === pair.fromId && s.relation !== 'explicit'));
            target.synapses = remaining.length ? remaining : undefined;
            this.memories.updateCardFields(target.id, target);
          }
        } catch { /* ignore deleted/missing target */ }
      }

      this.conversation.setMeta('homeostatic_sleep_pass_v1', { dayKey, ranAt: now });
      return { scaledSynapses, prunedSynapses, forgottenStubs, decayedCards, prunedColdCards };
    });
  }

  sampleDreamMaterial(random: () => number = Math.random): DreamMaterial {
    const state = this.subconsciousState();
    const recentMsgs = this.conversation.allMessages(60).reverse();
    const afterCursor = recentMsgs.filter(m => m.seq > state.lastMessageSeq);
    const firstIncompleteIdx = afterCursor.findIndex(m => ['queued', 'processing', 'streaming'].includes(m.status));
    const settledAfterCursor = firstIncompleteIdx >= 0 ? afterCursor.slice(0, firstIncompleteIdx) : afterCursor;
    const eligibleMsgs = settledAfterCursor
      .filter(m => m.status === 'completed' && m.source !== 'system' && m.origin?.speakerRole !== 'member' && m.text.trim().length > 0);
    const sampledMsgs = eligibleMsgs.slice(0, 24);
    const latestMessageSeq = sampledMsgs.length > 0
      ? sampledMsgs.at(-1)!.seq
      : (settledAfterCursor.at(-1)?.seq ?? state.lastMessageSeq);
    const undigestedMessages = sampledMsgs
      .map(m => ({ id: m.id, seq: m.seq, role: m.role, text: String(publicData(m.text.slice(0, 800))), at: m.at }));

    const digestedSet = new Set(state.digestedTaskIds);
    const completedTasks = this.tasks.list(60).filter(t => t.status === 'completed' && Boolean(t.report));
    const undigestedTasks = completedTasks
      .filter(t => !digestedSet.has(t.id))
      .slice(0, 8)
      .map(t => ({
        id: t.id,
        prompt: String(publicData(t.prompt.slice(0, 240))),
        cwd: t.cwd,
        profile: t.profile,
        reportSnippet: String(publicData((t.report ?? '').slice(0, 1000))),
        createdAt: t.createdAt,
      }));

    const allActive = this.memories.listMemories({ includeSuperseded: false, limit: 250 });
    const rawStubs = allActive.filter(c => c.tags.includes('auto-consolidated')).slice(0, 8);
    const stubIds = new Set(rawStubs.map(c => c.id));
    const recentCwds = new Set<string>();
    const recentTags = new Set<string>();
    for (const t of undigestedTasks) if (t.cwd) recentCwds.add(t.cwd);
    for (const s of rawStubs) {
      if (s.cwd) recentCwds.add(s.cwd);
      for (const tag of s.tags) if (tag !== 'auto-consolidated') recentTags.add(tag.toLowerCase());
    }

    // Weighted reservoir-like random pick favoring distant / cross-domain neurons
    const pool = allActive.filter(c => !stubIds.has(c.id));
    const distantMemories: MemoryCard[] = [];
    const targetCount = Math.min(pool.length, random() < 0.5 ? 2 : 3);
    const candidates = [...pool];
    while (distantMemories.length < targetCount && candidates.length > 0) {
      const weights = candidates.map(card => {
        const diffCwd = !card.cwd || !recentCwds.has(card.cwd) ? 2.2 : 0.7;
        const hasOverlapTag = card.tags.some(t => recentTags.has(t.toLowerCase()));
        const novelty = hasOverlapTag ? 0.8 : 2.0;
        const dormancy = Math.max(0.6, 1.8 - Math.min(1.2, (card.accessCount ?? 0) * 0.15));
        return diffCwd * novelty * dormancy;
      });
      const sum = weights.reduce((acc, w) => acc + w, 0);
      let r = random() * sum;
      let pickedIdx = 0;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!;
        if (r <= 0) { pickedIdx = i; break; }
      }
      distantMemories.push(candidates.splice(pickedIdx, 1)[0]!);
    }

    const candidateCwds = [...new Set([
      ...undigestedTasks.map(t => t.cwd),
      ...rawStubs.map(c => c.cwd),
      ...distantMemories.map(c => c.cwd),
    ].filter((c): c is string => Boolean(c)))].slice(0, 3);

    return {
      undigestedMessages,
      undigestedTasks,
      rawStubs,
      distantMemories,
      candidateCwds,
      latestMessageSeq,
      completedTaskIds: undigestedTasks.map(t => t.id),
    };
  }

  private classifyResidueVividness(r: SubconsciousResidue, now: number): 'clear' | 'hazy' | 'forgotten' {
    const ageMs = Math.max(0, now - r.createdAt);
    if (r.interrupted) {
      return ageMs <= 2 * 3600_000 && r.turnsElapsed <= 1 ? 'hazy' : 'forgotten';
    }
    if (r.salience === 'vivid') {
      if (ageMs <= 8 * 3600_000 && r.turnsElapsed <= 3) return 'clear';
      if (ageMs <= 24 * 3600_000 && r.turnsElapsed <= 7) return 'hazy';
      return 'forgotten';
    }
    if (ageMs <= 3 * 3600_000 && r.turnsElapsed <= 2) return 'clear';
    if (ageMs <= 12 * 3600_000 && r.turnsElapsed <= 5) return 'hazy';
    return 'forgotten';
  }

  recordDreamOutcome(input: RecordDreamOutcomeInput): void {
    const now = input.now ?? Date.now();
    this.atomic(() => {
      const state = this.subconsciousState();
      if (input.completed) {
        state.lastWakeAt = now;
        if (input.latestMessageSeq !== undefined) state.lastMessageSeq = Math.max(state.lastMessageSeq, input.latestMessageSeq);
        if (input.digestedTaskIds?.length) {
          state.digestedTaskIds = [...new Set([...state.digestedTaskIds, ...input.digestedTaskIds])].slice(-120);
        }
        if (input.refractoryMs !== undefined) state.refractoryMs = input.refractoryMs;
      }
      if (input.nextLatencyMs !== undefined) state.nextLatencyMs = input.nextLatencyMs;
      state.residues = state.residues.filter(r => this.classifyResidueVividness(r, now) !== 'forgotten');
      if (input.residue && input.residue.impression.trim()) {
        const cleanImpression = String(publicData(input.residue.impression.trim())).slice(0, 480);
        const cleanInsight = input.residue.insight?.trim()
          ? String(publicData(input.residue.insight.trim())).slice(0, 360)
          : undefined;
        state.residues.push({
          id: randomUUID(),
          impression: cleanImpression,
          ...(cleanInsight ? { insight: cleanInsight } : {}),
          salience: cleanInsight && input.residue.salience === 'vivid' ? 'vivid' : 'faint',
          ...(input.residue.interrupted ? { interrupted: true } : {}),
          createdAt: now,
          turnsElapsed: 0,
        });
      }
      this.saveSubconsciousState(state);
    });
  }

  peekSubconsciousForChat(now = Date.now()): ChatSubconscious | undefined {
    if (!this.hasResiduesCache) return undefined;
    const state = this.subconsciousState();
    const alive = state.residues.filter(r => this.classifyResidueVividness(r, now) !== 'forgotten');
    if (alive.length !== state.residues.length) {
      state.residues = alive;
      this.saveSubconsciousState(state);
    }
    if (!alive.length) return undefined;
    const vividPending = [...alive].reverse().find(r =>
      r.salience === 'vivid' && r.insight && !r.insightSurfaced && (now - r.createdAt) <= 36 * 3600_000,
    );
    const impressions = alive.map(r => {
      const vividness = this.classifyResidueVividness(r, now) as 'clear' | 'hazy';
      const text = vividness === 'clear'
        ? r.impression
        : r.impression.slice(0, 110) + (r.impression.length > 110 ? '…（醒来已久，其余画面已模糊）' : '');
      return {
        vividness,
        text,
        ...(r.interrupted ? { interrupted: true } : {}),
        hoursAgo: Number((Math.max(0, now - r.createdAt) / 3600_000).toFixed(1)),
      };
    });
    return {
      ...(vividPending ? { pendingInsight: { id: vividPending.id, insight: vividPending.insight! } } : {}),
      impressions,
    };
  }

  advanceSubconsciousTurn(surfacedInsightId?: string, now = Date.now()): void {
    if (!this.hasResiduesCache) return;
    const state = this.subconsciousState();
    if (!state.residues.length) return;
    let changed = false;
    const next: SubconsciousResidue[] = [];
    for (const r of state.residues) {
      const updated: SubconsciousResidue = {
        ...r,
        turnsElapsed: r.turnsElapsed + 1,
        ...(surfacedInsightId && r.id === surfacedInsightId ? { insightSurfaced: true } : {}),
      };
      changed = true;
      if (this.classifyResidueVividness(updated, now) !== 'forgotten') next.push(updated);
    }
    if (changed) {
      state.residues = next;
      this.saveSubconsciousState(state);
    }
  }
}
