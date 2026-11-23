import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DiaryEntry,
  DiaryMood,
  DiarySource,
  NotebookSummaryView,
  NoteAuthor,
  NoteItem,
  NoteTagCount,
} from '../view.js';

export const NOTE_TITLE_MAX = 160;
export const NOTE_CONTENT_MAX = 16_384;
export const DIARY_TITLE_MAX = 160;
export const DIARY_CONTENT_MAX = 16_384;
export const NOTEBOOK_MAX_TAGS = 12;
export const NOTEBOOK_MAX_TAG_LEN = 32;

const VALID_DIARY_MOODS: ReadonlySet<DiaryMood> = new Set([
  'neutral',
  'happy',
  'calm',
  'surprised',
  'inspecting',
  'squinted',
  'sleepy',
  'confused',
  'sad',
]);

const MOOD_ALIASES: Record<string, DiaryMood> = {
  neutral: 'neutral',
  default: 'neutral',
  '默认': 'neutral',
  '平常': 'neutral',
  happy: 'happy',
  joy: 'happy',
  excited: 'happy',
  '开心': 'happy',
  '高兴': 'happy',
  '欣慰': 'happy',
  calm: 'calm',
  peaceful: 'calm',
  serene: 'calm',
  '平静': 'calm',
  '柔和': 'calm',
  '安心': 'calm',
  surprised: 'surprised',
  amazed: 'surprised',
  '惊讶': 'surprised',
  '惊喜': 'surprised',
  inspecting: 'inspecting',
  curious: 'inspecting',
  thoughtful: 'inspecting',
  reflective: 'inspecting',
  '思考': 'inspecting',
  '好奇': 'inspecting',
  '打量': 'inspecting',
  squinted: 'squinted',
  focused: 'squinted',
  '专注': 'squinted',
  sleepy: 'sleepy',
  tired: 'sleepy',
  dreamy: 'sleepy',
  '犯困': 'sleepy',
  '困倦': 'sleepy',
  '微醺': 'sleepy',
  confused: 'confused',
  puzzled: 'confused',
  '疑惑': 'confused',
  '困惑': 'confused',
  sad: 'sad',
  melancholy: 'sad',
  sigh: 'sad',
  '难过': 'sad',
  '叹气': 'sad',
  '失落': 'sad',
};

export class NoteConflictError extends Error {
  constructor(message = 'Note was updated elsewhere; reload or resolve conflict before saving') {
    super(message);
    this.name = 'NoteConflictError';
  }
}

export interface SaveNoteInput {
  id?: string;
  title?: string;
  content?: string;
  tags?: string[];
  pinned?: boolean;
  author?: NoteAuthor;
  updatedBy?: NoteAuthor;
  sourceMessageId?: string;
  append?: boolean;
  expectedUpdatedAt?: number;
}

export interface ListNotesOptions {
  query?: string;
  tag?: string;
  pinnedOnly?: boolean;
  limit?: number;
}

export interface WriteDiaryInput {
  id?: string;
  date?: string;
  title?: string;
  content: string;
  mood?: string;
  tags?: string[];
  source?: DiarySource;
  sourceMessageId?: string;
  append?: boolean;
  createdAt?: number;
}

export interface ListDiaryOptions {
  query?: string;
  mood?: string;
  tag?: string;
  month?: string;
  date?: string;
  limit?: number;
}

export function formatLocalDate(ts = Date.now()): string {
  const dt = new Date(ts);
  const y = String(dt.getFullYear());
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDiaryLogicalDate(ts = Date.now(), nightCutoffHour = 5): string {
  const dt = new Date(ts);
  if (dt.getHours() < nightCutoffHour) {
    return formatLocalDate(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - 1).getTime());
  }
  return formatLocalDate(ts);
}

export function validateDateString(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error('Diary date must be in YYYY-MM-DD format');
  }
  const [y, m, d] = trimmed.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date: ${trimmed}`);
  }
  return trimmed;
}

export function normalizeDiaryMood(raw?: string): DiaryMood {
  if (!raw) return 'calm';
  const key = raw.trim().toLowerCase();
  if (VALID_DIARY_MOODS.has(key as DiaryMood)) return key as DiaryMood;
  return MOOD_ALIASES[key] ?? 'calm';
}

function normalizeDiarySource(raw?: string): DiarySource {
  if (raw === 'sleep' || raw === 'evening' || raw === 'chat') return raw;
  return 'chat';
}

function normalizeAuthor(raw?: string, fallback: NoteAuthor = 'user'): NoteAuthor {
  if (raw === 'friday' || raw === 'user') return raw;
  return fallback;
}

function normalizeTags(tags?: readonly string[]): string[] {
  if (!tags?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const clean = raw.trim().replace(/\s+/g, ' ').slice(0, NOTEBOOK_MAX_TAG_LEN);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= NOTEBOOK_MAX_TAGS) break;
  }
  return out;
}

function normalizeMarkdownBody(raw: string, max: number, label: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n');
  if (normalized.length > max) {
    throw new Error(`${label} exceeds maximum length of ${max} characters`);
  }
  return normalized;
}

function deriveFallbackTitle(content: string, fallback: string): string {
  for (const line of content.split('\n')) {
    const clean = line
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^[-*+>\d.)]+\s+/, '')
      .trim();
    if (clean) return clean.slice(0, NOTE_TITLE_MAX);
  }
  return fallback;
}

function parseTagsJson(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeTags(parsed.filter((item): item is string => typeof item === 'string')) : [];
  } catch {
    return [];
  }
}

function decodeNoteRow(row: Record<string, unknown>): NoteItem {
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content ?? ''),
    tags: parseTagsJson(row.tags_json),
    pinned: Number(row.pinned) === 1,
    author: normalizeAuthor(typeof row.author === 'string' ? row.author : undefined, 'friday'),
    updatedBy: normalizeAuthor(typeof row.updated_by === 'string' ? row.updated_by : undefined, 'friday'),
    ...(typeof row.source_message_id === 'string' && row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    ...(typeof row.promoted_memory_id === 'string' && row.promoted_memory_id ? { promotedMemoryId: row.promoted_memory_id } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function decodeDiaryRow(row: Record<string, unknown>): DiaryEntry {
  return {
    id: String(row.id),
    date: String(row.entry_date),
    title: String(row.title),
    content: String(row.content ?? ''),
    mood: normalizeDiaryMood(typeof row.mood === 'string' ? row.mood : undefined),
    tags: parseTagsJson(row.tags_json),
    source: normalizeDiarySource(typeof row.source === 'string' ? row.source : undefined),
    ...(typeof row.source_message_id === 'string' && row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function scoreSearchText(query: string, fields: { title: string; tags: string[]; content: string }): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const titleLower = fields.title.toLowerCase();
  const tagsLower = fields.tags.map(t => t.toLowerCase());
  const contentLower = fields.content.toLowerCase();

  let score = 0;
  if (titleLower.includes(q)) score += 6;
  if (tagsLower.some(t => t.includes(q))) score += 4;
  if (contentLower.includes(q)) score += 2;

  const tokens = q.split(/[\s,，、;；]+/).filter(Boolean);
  if (tokens.length > 1) {
    let matchedTokens = 0;
    for (const token of tokens) {
      let tokenScore = 0;
      if (titleLower.includes(token)) tokenScore += 3;
      if (tagsLower.some(t => t.includes(token))) tokenScore += 2;
      if (contentLower.includes(token)) tokenScore += 1;
      if (tokenScore > 0) {
        matchedTokens++;
        score += tokenScore;
      }
    }
    if (matchedTokens === tokens.length) score += 3;
  }

  return score;
}

export class NotebookStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(run: () => T) => T,
  ) {}

  summary(): NotebookSummaryView {
    const noteRow = this.db.prepare(
      'SELECT COUNT(*) AS cnt, COALESCE(SUM(pinned), 0) AS pinned_cnt, MAX(updated_at) AS max_updated FROM notes',
    ).get() as Record<string, unknown> | undefined;
    const diaryRow = this.db.prepare(
      'SELECT COUNT(*) AS cnt, MAX(entry_date) AS max_date, MAX(updated_at) AS max_updated FROM diary_entries',
    ).get() as Record<string, unknown> | undefined;

    return {
      noteCount: Number(noteRow?.cnt ?? 0),
      pinnedNoteCount: Number(noteRow?.pinned_cnt ?? 0),
      diaryCount: Number(diaryRow?.cnt ?? 0),
      latestNoteUpdatedAt: noteRow?.max_updated !== null && noteRow?.max_updated !== undefined ? Number(noteRow.max_updated) : null,
      latestDiaryDate: typeof diaryRow?.max_date === 'string' && diaryRow.max_date ? diaryRow.max_date : null,
      latestDiaryUpdatedAt: diaryRow?.max_updated !== null && diaryRow?.max_updated !== undefined ? Number(diaryRow.max_updated) : null,
    };
  }

  // --- Notes ---
  listNotes(options?: ListNotesOptions): NoteItem[] {
    const limit = Math.max(1, Math.min(500, options?.limit ?? 200));
    const rows = this.db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all() as Array<Record<string, unknown>>;
    let items = rows.map(decodeNoteRow);

    if (options?.pinnedOnly) {
      items = items.filter(item => item.pinned);
    }
    if (options?.tag?.trim()) {
      const targetTag = options.tag.trim().toLowerCase();
      items = items.filter(item => item.tags.some(t => t.toLowerCase() === targetTag));
    }
    if (options?.query?.trim()) {
      const query = options.query.trim();
      const scored = items
        .map(item => ({ item, score: scoreSearchText(query, item) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;
          return b.item.updatedAt - a.item.updatedAt;
        });
      return scored.slice(0, limit).map(entry => entry.item);
    }

    return items.slice(0, limit);
  }

  listNoteTags(): NoteTagCount[] {
    const rows = this.db.prepare('SELECT tags_json FROM notes').all() as Array<Record<string, unknown>>;
    const counts = new Map<string, { tag: string; count: number }>();
    for (const row of rows) {
      for (const tag of parseTagsJson(row.tags_json)) {
        const key = tag.toLowerCase();
        const existing = counts.get(key);
        if (existing) existing.count++;
        else counts.set(key, { tag, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  getNote(id: string): NoteItem {
    const row = this.db.prepare('SELECT * FROM notes WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Note not found: ${id}`);
    return decodeNoteRow(row);
  }

  findNoteByTitle(title: string): NoteItem | undefined {
    const clean = title.trim().toLowerCase();
    if (!clean) return undefined;
    const rows = this.db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const item = decodeNoteRow(row);
      if (item.title.trim().toLowerCase() === clean) return item;
    }
    return undefined;
  }

  saveNote(input: SaveNoteInput): NoteItem {
    return this.atomic(() => {
      const now = Date.now();
      if (input.id) {
        const row = this.db.prepare('SELECT * FROM notes WHERE id=?').get(input.id) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`Note not found: ${input.id}`);
        const existing = decodeNoteRow(row);
        if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
          throw new NoteConflictError();
        }
        const incomingContent = input.content !== undefined
          ? normalizeMarkdownBody(input.content, NOTE_CONTENT_MAX, 'Note content')
          : undefined;
        let nextContent = existing.content;
        if (input.append && incomingContent !== undefined) {
          nextContent = existing.content.trim() && incomingContent.trim()
            ? `${existing.content.replace(/\s+$/, '')}\n\n${incomingContent.replace(/^\s+/, '')}`
            : (existing.content.trim() ? existing.content : incomingContent);
          if (nextContent.length > NOTE_CONTENT_MAX) {
            throw new Error(`Note content exceeds maximum length of ${NOTE_CONTENT_MAX} characters`);
          }
        } else if (incomingContent !== undefined) {
          nextContent = incomingContent;
        }

        const trimmedTitle = input.title !== undefined ? input.title.trim().slice(0, NOTE_TITLE_MAX) : existing.title;
        const nextTitle = trimmedTitle || deriveFallbackTitle(nextContent, existing.title || '未命名笔记');
        const nextTags = input.append && input.tags !== undefined
          ? normalizeTags([...existing.tags, ...input.tags])
          : input.tags !== undefined
            ? normalizeTags(input.tags)
            : existing.tags;
        const nextPinned = input.pinned !== undefined ? input.pinned : existing.pinned;
        const nextUpdatedBy = normalizeAuthor(input.updatedBy ?? input.author, 'user');
        const nextSourceMsgId = input.sourceMessageId ?? existing.sourceMessageId;
        const updatedAt = Math.max(now, existing.updatedAt + 1);

        this.db.prepare(
          `UPDATE notes
           SET title=?, content=?, tags_json=?, pinned=?, updated_by=?, source_message_id=?, updated_at=?
           WHERE id=?`,
        ).run(
          nextTitle,
          nextContent,
          JSON.stringify(nextTags),
          nextPinned ? 1 : 0,
          nextUpdatedBy,
          nextSourceMsgId ?? null,
          updatedAt,
          existing.id,
        );
        return this.getNote(existing.id);
      }

      const content = input.content !== undefined
        ? normalizeMarkdownBody(input.content, NOTE_CONTENT_MAX, 'Note content')
        : '';
      const rawTitle = input.title !== undefined ? input.title.trim().slice(0, NOTE_TITLE_MAX) : '';
      const title = rawTitle || deriveFallbackTitle(content, '未命名笔记');
      const tags = normalizeTags(input.tags);
      const pinned = Boolean(input.pinned);
      const author = normalizeAuthor(input.author, 'user');
      const updatedBy = normalizeAuthor(input.updatedBy ?? input.author, author);
      const id = randomUUID();

      this.db.prepare(
        `INSERT INTO notes(id, title, content, tags_json, pinned, author, updated_by, source_message_id, promoted_memory_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        id,
        title,
        content,
        JSON.stringify(tags),
        pinned ? 1 : 0,
        author,
        updatedBy,
        input.sourceMessageId ?? null,
        now,
        now,
      );
      return this.getNote(id);
    });
  }

  pinNote(id: string, pinned: boolean): NoteItem {
    return this.atomic(() => {
      const existing = this.getNote(id);
      const updatedAt = Math.max(Date.now(), existing.updatedAt + 1);
      this.db.prepare('UPDATE notes SET pinned=?, updated_at=? WHERE id=?').run(pinned ? 1 : 0, updatedAt, id);
      return this.getNote(id);
    });
  }

  setNotePromotedMemory(id: string, memoryId: string): NoteItem {
    return this.atomic(() => {
      const existing = this.getNote(id);
      const updatedAt = Math.max(Date.now(), existing.updatedAt + 1);
      this.db.prepare('UPDATE notes SET promoted_memory_id=?, updated_at=? WHERE id=?').run(memoryId, updatedAt, id);
      return this.getNote(id);
    });
  }

  deleteNote(id: string): boolean {
    return this.atomic(() => {
      const res = this.db.prepare('DELETE FROM notes WHERE id=?').run(id) as { changes?: number | bigint };
      return Number(res.changes ?? 0) > 0;
    });
  }

  // --- Diary Entries ---
  listDiaryEntries(options?: ListDiaryOptions): DiaryEntry[] {
    const limit = Math.max(1, Math.min(500, options?.limit ?? 200));
    const rows = this.db.prepare('SELECT * FROM diary_entries ORDER BY entry_date DESC, created_at DESC, updated_at DESC').all() as Array<Record<string, unknown>>;
    let items = rows.map(decodeDiaryRow);

    if (options?.date?.trim()) {
      const validDate = validateDateString(options.date);
      items = items.filter(item => item.date === validDate);
    }
    if (options?.month?.trim()) {
      const month = options.month.trim();
      items = items.filter(item => item.date.startsWith(month));
    }
    if (options?.mood?.trim()) {
      const mood = normalizeDiaryMood(options.mood);
      items = items.filter(item => item.mood === mood);
    }
    if (options?.tag?.trim()) {
      const targetTag = options.tag.trim().toLowerCase();
      items = items.filter(item => item.tags.some(t => t.toLowerCase() === targetTag));
    }
    if (options?.query?.trim()) {
      const query = options.query.trim();
      const scored = items
        .map(item => ({ item, score: scoreSearchText(query, item) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return b.item.date.localeCompare(a.item.date) || (b.item.createdAt - a.item.createdAt);
        });
      return scored.slice(0, limit).map(entry => entry.item);
    }

    return items.slice(0, limit);
  }

  listDiaryByDate(date: string): DiaryEntry[] {
    const validDate = validateDateString(date);
    const rows = this.db.prepare(
      'SELECT * FROM diary_entries WHERE entry_date=? ORDER BY created_at DESC, updated_at DESC',
    ).all(validDate) as Array<Record<string, unknown>>;
    return rows.map(decodeDiaryRow);
  }

  listDiaryTags(): NoteTagCount[] {
    const rows = this.db.prepare('SELECT tags_json FROM diary_entries').all() as Array<Record<string, unknown>>;
    const counts = new Map<string, { tag: string; count: number }>();
    for (const row of rows) {
      for (const tag of parseTagsJson(row.tags_json)) {
        const key = tag.toLowerCase();
        const existing = counts.get(key);
        if (existing) existing.count++;
        else counts.set(key, { tag, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  listDiaryMonths(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT substr(entry_date, 1, 7) AS m FROM diary_entries WHERE length(entry_date) >= 7 ORDER BY m DESC',
    ).all() as Array<Record<string, unknown>>;
    return rows.map(row => String(row.m ?? '')).filter(Boolean);
  }

  getDiaryEntry(idOrDate: string): DiaryEntry {
    const clean = idOrDate.trim();
    const row = /^\d{4}-\d{2}-\d{2}$/.test(clean)
      ? (this.db.prepare(
          'SELECT * FROM diary_entries WHERE entry_date=? ORDER BY created_at DESC, updated_at DESC LIMIT 1',
        ).get(validateDateString(clean)) as Record<string, unknown> | undefined)
      : (this.db.prepare('SELECT * FROM diary_entries WHERE id=?').get(clean) as Record<string, unknown> | undefined);
    if (!row) throw new Error(`Diary entry not found: ${idOrDate}`);
    return decodeDiaryRow(row);
  }

  writeDiaryEntry(input: WriteDiaryInput): DiaryEntry {
    return this.atomic(() => {
      const now = Date.now();
      const incomingContent = normalizeMarkdownBody(input.content, DIARY_CONTENT_MAX, 'Diary content');
      if (!incomingContent.trim()) {
        throw new Error('Diary content must be non-empty');
      }

      if (input.id) {
        const row = this.db.prepare('SELECT * FROM diary_entries WHERE id=?').get(input.id) as Record<string, unknown> | undefined;
        if (!row) throw new Error(`Diary entry not found: ${input.id}`);
        const existing = decodeDiaryRow(row);
        const isAppend = input.append === true;
        let nextContent = incomingContent;
        if (isAppend && existing.content.trim()) {
          nextContent = `${existing.content.replace(/\s+$/, '')}\n\n---\n\n${incomingContent.replace(/^\s+/, '')}`;
          if (nextContent.length > DIARY_CONTENT_MAX) {
            throw new Error(`Diary content exceeds maximum length of ${DIARY_CONTENT_MAX} characters`);
          }
        }
        const trimmedTitle = input.title?.trim().slice(0, DIARY_TITLE_MAX);
        const nextTitle = trimmedTitle || existing.title;
        const nextMood = input.mood !== undefined ? normalizeDiaryMood(input.mood) : existing.mood;
        const nextTags = isAppend && input.tags !== undefined
          ? normalizeTags([...existing.tags, ...input.tags])
          : input.tags !== undefined
            ? normalizeTags(input.tags)
            : existing.tags;
        const nextSource = input.source ? normalizeDiarySource(input.source) : existing.source;
        const nextSourceMsgId = input.sourceMessageId ?? existing.sourceMessageId;
        const updatedAt = Math.max(now, existing.updatedAt + 1);

        this.db.prepare(
          `UPDATE diary_entries
           SET title=?, content=?, mood=?, tags_json=?, source=?, source_message_id=?, updated_at=?
           WHERE id=?`,
        ).run(
          nextTitle,
          nextContent,
          nextMood,
          JSON.stringify(nextTags),
          nextSource,
          nextSourceMsgId ?? null,
          updatedAt,
          existing.id,
        );
        return this.getDiaryEntry(existing.id);
      }

      const entryDate = input.date ? validateDateString(input.date) : formatLocalDate(now);
      const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? Math.round(input.createdAt)
        : now;
      const id = randomUUID();
      const title = input.title?.trim().slice(0, DIARY_TITLE_MAX)
        || deriveFallbackTitle(incomingContent, `${entryDate} 随记`).slice(0, DIARY_TITLE_MAX);
      const mood = normalizeDiaryMood(input.mood);
      const tags = normalizeTags(input.tags);
      const source = normalizeDiarySource(input.source);

      this.db.prepare(
        `INSERT INTO diary_entries(id, entry_date, title, content, mood, tags_json, source, source_message_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        entryDate,
        title,
        incomingContent,
        mood,
        JSON.stringify(tags),
        source,
        input.sourceMessageId ?? null,
        createdAt,
        createdAt,
      );
      return this.getDiaryEntry(id);
    });
  }

  deleteDiaryEntry(id: string): boolean {
    return this.atomic(() => {
      const clean = id.trim();
      if (!clean) return false;
      const res = this.db.prepare('DELETE FROM diary_entries WHERE id=?').run(clean) as { changes?: number | bigint };
      return Number(res.changes ?? 0) > 0;
    });
  }
}
