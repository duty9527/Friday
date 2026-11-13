import type { SessionContinuityTurnSummary } from './decision.js';
import type { ModelHub } from './model-hub.js';
import type { Store, Task } from './store.js';
import type { ChatMessage, RouteAction, SessionLinkKind, SessionTurnLink } from './view.js';

export const SESSION_AI_META_KEY = 'mindmap_session_ai_v1';

export type SessionAiCacheEntry = { same: boolean; prob: number; at: number };

const STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'should', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  'not', 'but', 'all', 'any', 'use', 'using', 'into', 'out', 'about', 'just', 'like', 'some', 'more',
  'your', 'you', 'our', 'their', 'http', 'https', 'com', 'org', 'net', 'www', 'true', 'false', 'null',
  'undefined', 'file', 'files', 'code', 'test', 'json', 'markdown', 'users', 'duty', 'friday',
]);

const STOP_CJK = new Set([
  '可以', '怎么', '什么', '一下', '一个', '现在', '今天', '昨天', '明天', '自己', '不会', '帮我', '看看', '觉得',
  '为什么', '有没有', '是不是', '还是', '或者', '以及', '如果', '因为', '所以', '但是', '不过', '就是', '这个', '那个',
  '这些', '那些', '这里', '那里', '这样', '那样', '你们', '我们', '他们', '老板', '主控', '任务', '继续', '进行',
  '开始', '完成', '一下吗', '可以吗', '行不行', '好不好', '怎么说', '搞定', '看看吧', '说说', '分析', '一下这',
]);

export const STRONG_BACKREF_RE = /^(那|那么|还有|另外|顺便|接着|继续|刚才|上面|前面|上一个|前一个|同一个|这几个|那几个|再把|再帮|再看|再查|不对|不是这个|我是说|我说的是|换个|换成|是(?:吗|的|吧|哦|这|那)?\b|是\s)/;
export const INLINE_BACKREF_RE = /(刚才|上面说|前面说|上一个任务|接着刚才|你自己不会|你不会去|还没完|之前那个)/;
export const STANDALONE_OPENER_RE = /^(帮我定时|每天|每周|早上|晚上|查一下天气|看下天气|帮我看下今天|给我总结一下今天)/;

export interface EntityBag {
  all: Set<string>;
  eng: Set<string>;
}

export function formatFlowSessionId(firstMessageId: string): string {
  return `session:flow:${firstMessageId}`;
}

export function formatTaskSessionId(taskId: string): string {
  return `session:task:${taskId}`;
}

export function isTimerOrSystemMessage(msg: Pick<ChatMessage, 'source' | 'text'>): boolean {
  return msg.source === 'system' || /^\[定时触发\s*·/.test(msg.text.trim());
}

export function formatGapCompact(gapSec: number): string {
  const s = Math.max(0, Math.round(gapSec));
  if (s < 60) return `+${s}秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `+${m}分${rem}秒` : `+${m}分钟`;
}

export function extractEntities(text: string): EntityBag {
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  const eng = new Set<string>();
  const all = new Set<string>();
  for (const m of clean.matchAll(/[A-Za-z][A-Za-z0-9._-]{2,}/g)) {
    const tok = m[0].toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
    if (tok.length >= 3 && !STOP_EN.has(tok) && !/^\d+$/.test(tok)) {
      eng.add(tok);
      all.add(tok);
    }
  }
  for (const m of clean.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seq = m[0];
    if (seq.length <= 6 && !STOP_CJK.has(seq)) all.add(seq);
    if (seq.length > 2) {
      for (let i = 0; i <= seq.length - 2; i += 1) {
        const bg = seq.slice(i, i + 2);
        if (!STOP_CJK.has(bg)) all.add(bg);
      }
    }
  }
  return { all, eng };
}

export function detectAssistantQuestion(text: string): boolean {
  const tail = text.trim().slice(-90);
  if (!tail) return false;
  if (/[？?]\s*$/.test(tail)) return true;
  return /(?:你说一声|说一句|告诉我|确认一下|指哪个|哪一个|哪方面|要不要我|请确认|需要哪)/.test(tail);
}

export interface HeuristicSessionMatch {
  same: boolean;
  kind: SessionLinkKind;
  label: string;
  detail?: string;
}

export function evaluateHeuristicSessionMatch(input: {
  prevTurnCount: number;
  prevChannel: string;
  curChannel: string;
  prevHasTasks: boolean;
  recentUserEntities: EntityBag[];
  lastAssistantAsked: boolean;
  gapSec: number;
  curText: string;
}): HeuristicSessionMatch | undefined {
  const cleanText = input.curText.replace(/\s+/g, ' ').trim();
  const sameChannel = input.prevChannel === input.curChannel;

  if (input.lastAssistantAsked && input.gapSec <= 420) {
    return {
      same: true,
      kind: 'answer_clarification',
      label: `💬 ${formatGapCompact(input.gapSec)} · 回答主控澄清追问`,
    };
  }
  if (cleanText.length <= 6 && input.gapSec <= 240) {
    return {
      same: true,
      kind: 'dialogue_followup',
      label: `💬 ${formatGapCompact(input.gapSec)} · 短语追问延续`,
    };
  }
  if (input.prevHasTasks && sameChannel && input.gapSec <= 260 && !STANDALONE_OPENER_RE.test(cleanText)) {
    return {
      same: true,
      kind: 'post_task_discussion',
      label: `🔗 ${formatGapCompact(input.gapSec)} · 围绕上一任务继续讨论`,
    };
  }

  const curEnt = extractEntities(cleanText);
  const seenPrev = new Set<string>();
  const seenPrevEng = new Set<string>();
  for (const bucket of input.recentUserEntities) {
    for (const e of bucket.eng) seenPrevEng.add(e);
    for (const e of bucket.all) seenPrev.add(e);
  }
  let engMatches = 0;
  let allMatches = 0;
  for (const e of curEnt.eng) if (seenPrevEng.has(e)) engMatches += 1;
  for (const e of curEnt.all) if (seenPrev.has(e)) allMatches += 1;
  if ((engMatches >= 1 || allMatches >= 2) && input.gapSec <= 600) {
    return {
      same: true,
      kind: 'topic_continuity',
      label: `🧠 ${formatGapCompact(input.gapSec)} · 同主题实体延续`,
    };
  }
  if (sameChannel && input.gapSec <= 90 && !STANDALONE_OPENER_RE.test(cleanText) && input.prevTurnCount > 0) {
    return {
      same: true,
      kind: 'rapid_exchange',
      label: `⚡ ${formatGapCompact(input.gapSec)} · 同端快速连续对话`,
    };
  }
  return undefined;
}

export function detectAiContextSynthesis(
  recentUserEntities: EntityBag[],
  curUserText: string,
  tasks: Array<{ prompt: string; contextBrief?: string }>,
): string | undefined {
  if (!tasks.length || !recentUserEntities.length) return undefined;
  const curUserEnt = extractEntities(curUserText);
  const prevUniqueAll = new Set<string>();
  const prevUniqueEng = new Set<string>();
  for (const bucket of recentUserEntities) {
    for (const e of bucket.eng) if (!curUserEnt.eng.has(e)) prevUniqueEng.add(e);
    for (const e of bucket.all) if (!curUserEnt.all.has(e)) prevUniqueAll.add(e);
  }
  const synthesized = tasks.map(t => `${t.prompt} ${t.contextBrief ?? ''}`).join(' ');
  const synthEnt = extractEntities(synthesized);
  const hitEng: string[] = [];
  const hitAll: string[] = [];
  for (const e of prevUniqueEng) if (synthEnt.eng.has(e)) hitEng.push(e);
  for (const e of prevUniqueAll) if (synthEnt.all.has(e)) hitAll.push(e);
  if (hitEng.length >= 1 || hitAll.length >= 2) {
    return [...new Set([...hitEng, ...hitAll])].slice(0, 3).join(', ');
  }
  return undefined;
}

interface RecentSessionContext {
  prevUser: ChatMessage;
  prevSessionId: string;
  prevChannel: string;
  curChannel: string;
  gapSec: number;
  sessionUsers: ChatMessage[];
  sessionMsgIds: Set<string>;
  sessionTaskIds: Set<string>;
  lastAssistantText: string;
  lastAssistantAsked: boolean;
  lastSwitchedChannel: boolean;
  recentUserEntities: EntityBag[];
  activeTaskPrompts: string[];
  hasPendingQuestion: boolean;
  recentTurnsForAi: SessionContinuityTurnSummary[];
}

function loadRecentSessionContext(
  store: Store,
  current: { seq?: number; at: number; origin?: ChatMessage['origin'] },
  knownWorks: Task[],
): RecentSessionContext | undefined {
  const beforeSeq = current.seq ?? Number.MAX_SAFE_INTEGER;
  const recentHumans = store.conversation.recentHumanUserMessages(beforeSeq, 10);
  if (!recentHumans.length) return undefined;
  const prevUser = recentHumans[recentHumans.length - 1]!;
  const prevSessionId = prevUser.sessionId ?? formatFlowSessionId(prevUser.id);
  const sessionUsers = recentHumans.filter(m => (m.sessionId ?? formatFlowSessionId(m.id)) === prevSessionId);
  if (!sessionUsers.length) sessionUsers.push(prevUser);

  const prevReplies = store.conversation.repliesForMessages(sessionUsers.map(m => m.id));
  const repliesByParent = new Map<string, ChatMessage[]>();
  const sessionMsgIds = new Set<string>();
  const sessionTaskIds = new Set<string>();
  for (const u of sessionUsers) {
    sessionMsgIds.add(u.id);
    for (const tid of u.taskIds) sessionTaskIds.add(tid);
  }
  for (const r of prevReplies) {
    sessionMsgIds.add(r.id);
    for (const tid of r.taskIds) sessionTaskIds.add(tid);
    if (r.replyTo) {
      const list = repliesByParent.get(r.replyTo) ?? [];
      list.push(r);
      repliesByParent.set(r.replyTo, list);
    }
  }
  for (const t of knownWorks) {
    if (t.sessionId === prevSessionId || (t.originMessageId && sessionMsgIds.has(t.originMessageId))) {
      sessionTaskIds.add(t.id);
    }
  }

  const prevLastReplies = repliesByParent.get(prevUser.id) ?? [];
  const lastAssistantText = prevLastReplies.at(-1)?.text ?? '';
  const lastAssistantAsked = detectAssistantQuestion(lastAssistantText);
  const lastSwitchedChannel = Boolean(prevUser.routing?.actions.some(a => a.kind === 'switch_channel'));
  const gapSec = Math.max(0, Math.round((current.at - prevUser.at) / 1000));
  const prevChannel = prevUser.origin?.channel ?? 'local';
  const curChannel = current.origin?.channel ?? 'local';
  const recentUserEntities = sessionUsers.slice(-4).map(m => extractEntities(m.text));

  const tasksById = new Map(knownWorks.map(t => [t.id, t]));
  const activeTaskPrompts = [...sessionTaskIds]
    .map(id => tasksById.get(id))
    .filter((t): t is Task => Boolean(t && ['queued', 'running'].includes(t.status)))
    .map(t => t.prompt);
  const hasPendingQuestion = [...sessionTaskIds]
    .some(id => Boolean(tasksById.get(id)?.pendingQuestion && ['queued', 'running'].includes(tasksById.get(id)!.status)));

  const recentTurnsForAi: SessionContinuityTurnSummary[] = sessionUsers.slice(-4).map(u => {
    const rList = repliesByParent.get(u.id) ?? [];
    const replyText = rList.map(r => r.text).filter(Boolean).join('\n');
    const taskPrompts = u.taskIds
      .map(id => tasksById.get(id)?.prompt)
      .filter((p): p is string => Boolean(p));
    return {
      channel: u.origin?.channel ?? 'local',
      userText: u.text,
      ...(replyText ? { assistantReply: replyText } : {}),
      ...(taskPrompts.length ? { taskPrompts } : {}),
      ageSec: Math.max(0, Math.round((current.at - u.at) / 1000)),
    };
  });

  return {
    prevUser,
    prevSessionId,
    prevChannel,
    curChannel,
    gapSec,
    sessionUsers,
    sessionMsgIds,
    sessionTaskIds,
    lastAssistantText,
    lastAssistantAsked,
    lastSwitchedChannel,
    recentUserEntities,
    activeTaskPrompts,
    hasPendingQuestion,
    recentTurnsForAi,
  };
}

function checkDeterministicCausalLink(
  ctx: RecentSessionContext,
  curMessage: { text: string; origin?: ChatMessage['origin'] },
  nowAt: number,
): SessionTurnLink | undefined {
  const { prevChannel, curChannel, gapSec, lastSwitchedChannel, lastAssistantAsked, hasPendingQuestion, activeTaskPrompts } = ctx;
  const sameChannel = prevChannel === curChannel;
  const cleanText = curMessage.text.replace(/\s+/g, ' ').trim();

  if (curMessage.origin?.replyToMessageId && ctx.sessionMsgIds.has(curMessage.origin.replyToMessageId)) {
    return {
      kind: 'msg_link',
      source: 'causal',
      gapSec,
      label: `💬 ${formatGapCompact(gapSec)} · 引用回复前序消息`,
      evaluatedAt: nowAt,
    };
  }
  if (hasPendingQuestion && sameChannel && gapSec <= 3600) {
    return {
      kind: 'answer_clarification',
      source: 'causal',
      gapSec,
      label: `💬 ${formatGapCompact(gapSec)} · 拍板回复挂起任务`,
      evaluatedAt: nowAt,
    };
  }
  if (lastSwitchedChannel && gapSec <= 600) {
    return {
      kind: 'switch_channel',
      source: 'causal',
      gapSec,
      label: `📱 ${formatGapCompact(gapSec)} · 跨端切换继续对话`,
      evaluatedAt: nowAt,
    };
  }
  if (gapSec <= 15 && !STANDALONE_OPENER_RE.test(cleanText)) {
    return {
      kind: lastAssistantAsked ? 'answer_clarification'
        : (STRONG_BACKREF_RE.test(cleanText) || INLINE_BACKREF_RE.test(cleanText)) ? 'explicit_backref'
          : 'in_flight',
      source: 'causal',
      gapSec,
      label: `⚡ ${formatGapCompact(gapSec)} · 连续补充输入`,
      evaluatedAt: nowAt,
    };
  }
  if (activeTaskPrompts.length > 0 && sameChannel && gapSec <= 900 && !STANDALONE_OPENER_RE.test(cleanText)) {
    return {
      kind: 'in_flight',
      source: 'causal',
      gapSec,
      label: `⚡ ${formatGapCompact(gapSec)} · 同任务执行中连续对话`,
      evaluatedAt: nowAt,
    };
  }
  if (gapSec <= 1800 && (STRONG_BACKREF_RE.test(cleanText) || INLINE_BACKREF_RE.test(cleanText))) {
    return {
      kind: 'explicit_backref',
      source: 'causal',
      gapSec,
      label: `🔗 ${formatGapCompact(gapSec)} · 上下文追问与指代延续`,
      evaluatedAt: nowAt,
    };
  }
  if (lastAssistantAsked && sameChannel && gapSec <= 180) {
    return {
      kind: 'answer_clarification',
      source: 'causal',
      gapSec,
      label: `💬 ${formatGapCompact(gapSec)} · 回答主控澄清追问`,
      evaluatedAt: nowAt,
    };
  }
  return undefined;
}

/**
 * Ultra-fast synchronous initial attribution at `Coordinator.chat()` intake (<1ms SQLite only),
 * giving newly created ChatMessages an immediate native sessionId before async Router/JEV execution.
 */
export function assignInitialMessageSessionSync(
  store: Store,
  draft: { id: string; text: string; origin?: ChatMessage['origin']; source?: 'router' | 'system'; at: number },
  knownWorks: Task[],
): { sessionId: string; sessionLink?: SessionTurnLink } {
  if (isTimerOrSystemMessage(draft)) {
    return { sessionId: formatFlowSessionId(draft.id) };
  }
  const ctx = loadRecentSessionContext(store, { at: draft.at, origin: draft.origin }, knownWorks);
  if (!ctx) return { sessionId: formatFlowSessionId(draft.id) };

  const causal = checkDeterministicCausalLink(ctx, { text: draft.text, origin: draft.origin }, draft.at);
  if (causal) return { sessionId: ctx.prevSessionId, sessionLink: causal };

  if (ctx.gapSec <= 2700) {
    const heuristic = evaluateHeuristicSessionMatch({
      prevTurnCount: ctx.sessionUsers.length,
      prevChannel: ctx.prevChannel,
      curChannel: ctx.curChannel,
      prevHasTasks: ctx.prevUser.taskIds.length > 0,
      recentUserEntities: ctx.recentUserEntities,
      lastAssistantAsked: ctx.lastAssistantAsked,
      gapSec: ctx.gapSec,
      curText: draft.text,
    });
    if (heuristic?.same) {
      return {
        sessionId: ctx.prevSessionId,
        sessionLink: {
          kind: heuristic.kind,
          source: 'heuristic',
          gapSec: ctx.gapSec,
          label: heuristic.label,
          ...(heuristic.detail ? { detail: heuristic.detail } : {}),
          evaluatedAt: draft.at,
        },
      };
    }
  }
  return { sessionId: formatFlowSessionId(draft.id) };
}

/**
 * Authoritative runtime attribution right before Router execution (after IM coalescing settles):
 * evaluates causal links, heuristic continuity, and real-time Gemini Decision 1 `same_session` judgment.
 */
export async function resolveRuntimeMessageSession(
  store: Store,
  modelHub: ModelHub,
  currentMessage: ChatMessage,
  knownWorks: Task[],
): Promise<{ sessionId: string; sessionLink?: SessionTurnLink }> {
  if (isTimerOrSystemMessage(currentMessage)) {
    return { sessionId: formatFlowSessionId(currentMessage.id) };
  }
  const ctx = loadRecentSessionContext(
    store,
    { seq: currentMessage.seq, at: currentMessage.at, origin: currentMessage.origin },
    knownWorks,
  );
  if (!ctx) return { sessionId: formatFlowSessionId(currentMessage.id) };

  const nowAt = Date.now();
  const causal = checkDeterministicCausalLink(ctx, currentMessage, nowAt);
  if (causal) {
    return { sessionId: ctx.prevSessionId, sessionLink: causal };
  }

  if (ctx.gapSec <= 2700) {
    const heuristic = evaluateHeuristicSessionMatch({
      prevTurnCount: ctx.sessionUsers.length,
      prevChannel: ctx.prevChannel,
      curChannel: ctx.curChannel,
      prevHasTasks: ctx.prevUser.taskIds.length > 0,
      recentUserEntities: ctx.recentUserEntities,
      lastAssistantAsked: ctx.lastAssistantAsked,
      gapSec: ctx.gapSec,
      curText: currentMessage.text,
    });

    if (modelHub.hasDecisionEngine()) {
      const heuristicRel = heuristic?.kind === 'answer_clarification'
        || heuristic?.kind === 'post_task_discussion'
        || heuristic?.kind === 'topic_continuity'
        || heuristic?.kind === 'dialogue_followup'
        || heuristic?.kind === 'rapid_exchange'
        ? heuristic.kind
        : undefined;
      const ai = await modelHub.decideSessionContinuity({
        recentTurns: ctx.recentTurnsForAi,
        activeTaskPrompts: ctx.activeTaskPrompts,
        prevChannel: ctx.prevChannel,
        currentChannel: ctx.curChannel,
        gapSec: ctx.gapSec,
        currentText: currentMessage.text,
        heuristicSame: heuristic?.same,
        heuristicRelation: heuristicRel,
      });

      if (ai.source === 'gemini-decision-1') {
        if (ai.sameSession) {
          const kind: SessionLinkKind = ai.relation === 'new_topic'
            ? (heuristic?.kind ?? 'dialogue_followup')
            : ai.relation;
          return {
            sessionId: ctx.prevSessionId,
            sessionLink: {
              kind,
              source: 'gemini-decision-1',
              gapSec: ctx.gapSec,
              confidence: ai.confidence ?? Number(ai.probability.toFixed(2)),
              label: `🎯 ${formatGapCompact(ctx.gapSec)} · JEV 实时归并会话 (${Math.round(ai.probability * 100)}%)`,
              ...(heuristic?.label ? { detail: heuristic.label } : {}),
              evaluatedAt: Date.now(),
              ...(ai.usage ? { usage: ai.usage } : {}),
            },
          };
        }
        // Authoritative AI split: starts a fresh session even if fast sync intake tentatively linked it.
        return { sessionId: formatFlowSessionId(currentMessage.id) };
      }

      if (heuristic?.same) {
        return {
          sessionId: ctx.prevSessionId,
          sessionLink: {
            kind: heuristic.kind,
            source: 'heuristic',
            gapSec: ctx.gapSec,
            label: heuristic.label,
            ...(heuristic.detail ? { detail: heuristic.detail } : {}),
            evaluatedAt: Date.now(),
            ...(ai.fallbackReason ? { fallbackReason: ai.fallbackReason } : {}),
          },
        };
      }
      return { sessionId: formatFlowSessionId(currentMessage.id) };
    }

    if (heuristic?.same) {
      return {
        sessionId: ctx.prevSessionId,
        sessionLink: {
          kind: heuristic.kind,
          source: 'heuristic',
          gapSec: ctx.gapSec,
          label: heuristic.label,
          ...(heuristic.detail ? { detail: heuristic.detail } : {}),
          evaluatedAt: nowAt,
        },
      };
    }
  }

  return { sessionId: formatFlowSessionId(currentMessage.id) };
}

function resolveHumanTaskSession(store: Store, task: Task): string | undefined {
  if (task.originMessageId) {
    try {
      const originMsg = store.conversation.get(task.originMessageId);
      if (isTimerOrSystemMessage(originMsg)) return undefined;
      return originMsg.sessionId ?? formatFlowSessionId(originMsg.id);
    } catch { /* fall through to task.sessionId */ }
  }
  if (task.sessionId && task.sessionId.startsWith('session:flow:')) return task.sessionId;
  return undefined;
}

/**
 * Upgrades the active turn's persisted sessionId when Router tools deterministically link to a prior
 * task, recall prior conversation messages, or synthesize prior-turn entities into a new task.
 * Never mutates historical settled Task records.
 */
export function reconcileRuntimeSessionAfterTool(
  store: Store,
  messageId: string,
  toolName: string,
  action: RouteAction,
): { updated: boolean; sessionId: string } {
  const msg = store.conversation.get(messageId);
  const currentSessionId = msg.sessionId ?? formatFlowSessionId(msg.id);
  if (isTimerOrSystemMessage(msg)) return { updated: false, sessionId: currentSessionId };

  const createdTask = action.taskId
    ? (() => { try { return store.get(action.taskId); } catch { return undefined; } })()
    : undefined;
  const isNewlyCreatedTaskForTurn = Boolean(createdTask && createdTask.originMessageId === msg.id);

  // 1) Task continuation / inspection / resume / stop linking to an existing human session
  const refTaskId = action.parentTaskId
    ?? (toolName !== 'start_work' || action.kind === 'related_work' ? action.taskId : undefined);
  if (refTaskId) {
    try {
      const refTask = store.get(refTaskId);
      const targetSessionId = resolveHumanTaskSession(store, refTask);
      if (targetSessionId && (targetSessionId !== currentSessionId || (action.kind !== 'inspect' && msg.sessionLink?.kind !== 'task_link'))) {
        const gapSec = Math.max(0, Math.round((msg.at - refTask.createdAt) / 1000));
        const nextLink: SessionTurnLink = {
          kind: 'task_link',
          source: 'causal',
          gapSec,
          label: `🔗 ${action.kind === 'followup' || action.kind === 'related_work' ? '续接' : '关联'}后台任务 #${refTask.id.slice(0, 6)}`,
          ...(msg.sessionLink?.usage ? { usage: msg.sessionLink.usage } : {}),
          ...(msg.sessionLink?.confidence !== undefined ? { confidence: msg.sessionLink.confidence } : {}),
          evaluatedAt: Date.now(),
        };
        store.transaction(() => {
          store.conversation.assignSession(msg.id, targetSessionId, nextLink, targetSessionId !== currentSessionId);
          if (isNewlyCreatedTaskForTurn && createdTask && createdTask.sessionId !== targetSessionId) {
            store.save({ ...createdTask, sessionId: targetSessionId });
          }
        });
        return { updated: true, sessionId: targetSessionId };
      }
    } catch { /* ignore unknown ref task */ }
  }

  // 2) Cross-turn entity synthesis by Router when dispatching start_work
  if (createdTask && isNewlyCreatedTaskForTurn) {
    const knownWorks = store.list();
    const ctx = loadRecentSessionContext(store, { seq: msg.seq, at: msg.at, origin: msg.origin }, knownWorks);
    if (ctx && ctx.gapSec <= 480) {
      const sample = detectAiContextSynthesis(ctx.recentUserEntities, msg.text, [createdTask]);
      if (sample) {
        const targetSessionId = ctx.prevSessionId;
        const alreadyMergedSame = msg.sessionId === targetSessionId && Boolean(msg.sessionLink);
        const detail = `主控在任务指令中自动融入前序关键实体: ${sample}`;
        const nextLink: SessionTurnLink = alreadyMergedSame && msg.sessionLink
          ? { ...msg.sessionLink, detail: msg.sessionLink.detail ? `${msg.sessionLink.detail} · ${detail}` : detail }
          : {
              kind: 'ai_context_synthesis',
              source: 'causal',
              gapSec: ctx.gapSec,
              label: `🧠 ${formatGapCompact(ctx.gapSec)} · AI 合成前序轮次意图派单`,
              detail,
              evaluatedAt: Date.now(),
            };
        store.transaction(() => {
          store.conversation.assignSession(msg.id, targetSessionId, nextLink, targetSessionId !== currentSessionId);
          if (createdTask.sessionId !== targetSessionId) {
            store.save({ ...createdTask, sessionId: targetSessionId });
          }
        });
        return { updated: true, sessionId: targetSessionId };
      }
    }
  }

  // 3) recall_messages / search_memory explicitly pulled an older human session within 1 hour
  if (action.messageIds?.length && !msg.sessionLink) {
    let bestTarget: ChatMessage | undefined;
    for (const mid of action.messageIds) {
      try {
        const hit = store.conversation.get(mid);
        if (hit.seq >= msg.seq || isTimerOrSystemMessage(hit)) continue;
        const rootHit = hit.role === 'assistant' && hit.replyTo ? store.conversation.get(hit.replyTo) : hit;
        if (isTimerOrSystemMessage(rootHit)) continue;
        if (msg.at - rootHit.at <= 3600_000 && (!bestTarget || rootHit.seq > bestTarget.seq)) {
          bestTarget = rootHit;
        }
      } catch { /* ignore missing message ID */ }
    }
    if (bestTarget) {
      const targetSessionId = bestTarget.sessionId ?? formatFlowSessionId(bestTarget.id);
      if (targetSessionId !== currentSessionId) {
        const gapSec = Math.max(0, Math.round((msg.at - bestTarget.at) / 1000));
        const nextLink: SessionTurnLink = {
          kind: 'msg_link',
          source: 'causal',
          gapSec,
          label: '🔗 引用前序会话消息',
          evaluatedAt: Date.now(),
        };
        store.transaction(() => {
          store.conversation.assignSession(msg.id, targetSessionId, nextLink, true);
          if (isNewlyCreatedTaskForTurn && createdTask) {
            store.save({ ...createdTask, sessionId: targetSessionId });
          }
        });
        return { updated: true, sessionId: targetSessionId };
      }
    }
  }

  return { updated: false, sessionId: currentSessionId };
}

/**
 * Idempotent startup backfill for historical databases upgraded to native runtime sessionIds.
 * Reuses existing cached `mindmap_session_ai_v1` judgments without making network calls or adding journal rows.
 */
export function backfillPersistedSessions(store: Store): number {
  if (!store.conversation.hasUnassignedUserMessages()) return 0;
  const users = store.conversation.allUserMessagesChronological();
  if (!users.length) return 0;

  const allReplies = store.conversation.repliesForMessages(users.map(u => u.id));
  const repliesByParent = new Map<string, ChatMessage[]>();
  for (const r of allReplies) {
    if (!r.replyTo) continue;
    const list = repliesByParent.get(r.replyTo) ?? [];
    list.push(r);
    repliesByParent.set(r.replyTo, list);
  }
  const tasks = store.list();
  const tasksById = new Map(tasks.map(t => [t.id, t]));
  const aiCache = store.conversation.meta<Record<string, SessionAiCacheEntry>>(SESSION_AI_META_KEY) ?? {};
  const userSessionMap = new Map<string, string>();
  const updates: Array<{ msg: ChatMessage; sessionId: string; link?: SessionTurnLink }> = [];

  let activeUsers: ChatMessage[] = [];
  let activeSessionId = '';
  const activeTaskIds = new Set<string>();
  const activeMsgIds = new Set<string>();
  let recentEntities: EntityBag[] = [];
  let lastAsked = false;
  let lastSwitched = false;

  for (const user of users) {
    const replies = repliesByParent.get(user.id) ?? [];
    const userTasks = user.taskIds.map(id => tasksById.get(id)).filter((t): t is Task => Boolean(t));

    if (isTimerOrSystemMessage(user)) {
      const sid = user.sessionId ?? formatFlowSessionId(user.id);
      userSessionMap.set(user.id, sid);
      if (!user.sessionId) updates.push({ msg: user, sessionId: sid });
      continue;
    }

    if (user.sessionId) {
      const sid = user.sessionId;
      userSessionMap.set(user.id, sid);
      if (!activeUsers.length || sid !== activeSessionId) {
        activeUsers = [user];
        activeSessionId = sid;
        activeTaskIds.clear();
        activeMsgIds.clear();
        recentEntities = [];
      } else {
        activeUsers.push(user);
      }
      for (const t of userTasks) activeTaskIds.add(t.id);
      activeMsgIds.add(user.id);
      for (const r of replies) activeMsgIds.add(r.id);
      recentEntities = [...recentEntities.slice(-3), extractEntities(user.text)];
      lastAsked = detectAssistantQuestion(replies.at(-1)?.text ?? '');
      lastSwitched = Boolean(user.routing?.actions.some(a => a.kind === 'switch_channel'));
      continue;
    }

    let resolvedSessionId = formatFlowSessionId(user.id);
    let resolvedLink: SessionTurnLink | undefined;

    if (activeUsers.length > 0) {
      const prevUser = activeUsers[activeUsers.length - 1]!;
      const gapSec = Math.max(0, Math.round((user.at - prevUser.at) / 1000));
      const curChannel = user.origin?.channel ?? 'local';
      const prevChannel = prevUser.origin?.channel ?? 'local';
      const sameChannel = curChannel === prevChannel;
      const cleanText = user.text.replace(/\s+/g, ' ').trim();

      // 1) Causal taskId / parentTaskId / routeAction linkage
      let causal: SessionTurnLink | undefined;
      for (const t of userTasks) {
        if (activeTaskIds.has(t.id) || (t.parentTaskId && activeTaskIds.has(t.parentTaskId))) {
          causal = { kind: 'task_link', source: 'causal', gapSec, label: `🔗 续接后台任务 #${t.id.slice(0, 6)}` };
          break;
        }
      }
      if (!causal) {
        for (const act of user.routing?.actions ?? []) {
          if (act.taskId && activeTaskIds.has(act.taskId)) {
            causal = { kind: 'task_link', source: 'causal', gapSec, label: `🔗 关联后台任务 #${act.taskId.slice(0, 6)}` };
            break;
          }
          if (act.messageIds?.some(mid => activeMsgIds.has(mid))) {
            causal = { kind: 'msg_link', source: 'causal', gapSec, label: '🔗 引用前序会话消息' };
            break;
          }
        }
      }
      if (!causal && lastSwitched && gapSec <= 600) {
        causal = { kind: 'switch_channel', source: 'causal', gapSec, label: `📱 ${formatGapCompact(gapSec)} · 跨端切换继续对话` };
      }
      if (!causal && gapSec <= 15 && !STANDALONE_OPENER_RE.test(cleanText)) {
        causal = { kind: 'in_flight', source: 'causal', gapSec, label: `⚡ ${formatGapCompact(gapSec)} · 连续补充输入` };
      }
      if (!causal && gapSec <= 1800 && (STRONG_BACKREF_RE.test(cleanText) || INLINE_BACKREF_RE.test(cleanText))) {
        causal = { kind: 'explicit_backref', source: 'causal', gapSec, label: `🔗 ${formatGapCompact(gapSec)} · 上下文追问与指代延续` };
      }
      if (!causal && gapSec <= 480 && userTasks.length > 0) {
        const sample = detectAiContextSynthesis(recentEntities, user.text, userTasks);
        if (sample) {
          causal = {
            kind: 'ai_context_synthesis',
            source: 'causal',
            gapSec,
            label: `🧠 ${formatGapCompact(gapSec)} · AI 合成前序轮次意图派单`,
            detail: `主控在任务指令中自动融入前序关键实体: ${sample}`,
          };
        }
      }
      if (!causal && lastAsked && sameChannel && gapSec <= 180) {
        causal = { kind: 'answer_clarification', source: 'causal', gapSec, label: `💬 ${formatGapCompact(gapSec)} · 回答主控澄清追问` };
      }

      if (causal) {
        resolvedSessionId = activeSessionId;
        resolvedLink = causal;
      } else if (gapSec <= 2700) {
        const heuristic = evaluateHeuristicSessionMatch({
          prevTurnCount: activeUsers.length,
          prevChannel,
          curChannel,
          prevHasTasks: prevUser.taskIds.length > 0,
          recentUserEntities: recentEntities,
          lastAssistantAsked: lastAsked,
          gapSec,
          curText: user.text,
        });
        const pairKey = `flow:${prevUser.id}->flow:${user.id}`;
        const cachedAi = aiCache[pairKey];
        if (cachedAi) {
          if (cachedAi.prob >= 0.5 || (heuristic?.same && sameChannel && gapSec <= 120 && cachedAi.prob >= 0.3)) {
            resolvedSessionId = activeSessionId;
            resolvedLink = {
              kind: heuristic?.kind ?? 'dialogue_followup',
              source: 'gemini-decision-1',
              gapSec,
              confidence: Number(cachedAi.prob.toFixed(2)),
              label: `🎯 ${formatGapCompact(gapSec)} · JEV 语义判定延续 (${Math.round(cachedAi.prob * 100)}%)`,
              ...(heuristic?.label ? { detail: heuristic.label } : {}),
              evaluatedAt: cachedAi.at,
            };
          }
        } else if (heuristic?.same) {
          resolvedSessionId = activeSessionId;
          resolvedLink = {
            kind: heuristic.kind,
            source: 'heuristic',
            gapSec,
            label: heuristic.label,
            ...(heuristic.detail ? { detail: heuristic.detail } : {}),
          };
        }
      }
    }

    userSessionMap.set(user.id, resolvedSessionId);
    updates.push({ msg: user, sessionId: resolvedSessionId, link: resolvedLink });

    if (resolvedLink && activeUsers.length > 0 && resolvedSessionId === activeSessionId) {
      activeUsers.push(user);
    } else {
      activeUsers = [user];
      activeSessionId = resolvedSessionId;
      activeTaskIds.clear();
      activeMsgIds.clear();
      recentEntities = [];
    }
    for (const t of userTasks) activeTaskIds.add(t.id);
    activeMsgIds.add(user.id);
    for (const r of replies) activeMsgIds.add(r.id);
    recentEntities = [...recentEntities.slice(-3), extractEntities(user.text)];
    lastAsked = detectAssistantQuestion(replies.at(-1)?.text ?? '');
    lastSwitched = Boolean(user.routing?.actions.some(a => a.kind === 'switch_channel'));
  }

  let updatedCount = 0;
  store.transaction(() => {
    for (const u of updates) {
      store.conversation.quietSetMessageSession(u.msg.id, u.sessionId, u.link);
      updatedCount += 1;
    }
    for (const task of tasks) {
      if (!task.sessionId && task.originMessageId && userSessionMap.has(task.originMessageId)) {
        const sid = userSessionMap.get(task.originMessageId)!;
        store.save({ ...task, sessionId: sid });
      }
    }
  });
  return updatedCount;
}
