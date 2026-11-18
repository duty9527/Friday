export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type DecisionSource = 'gemini-decision-1' | 'heuristic';
export type MissingAspect =
  | 'none'
  | 'incomplete_requirements'
  | 'missing_verification'
  | 'unresolved_error'
  | 'superficial_analysis';

export interface QualityGateAssessment {
  score: number;
  maxScore: number;
  confidence: number;
  supplementProbability: number;
  shouldSupplement: boolean;
  missingAspect: MissingAspect;
  source: DecisionSource;
  evaluatedAt: number;
  skippedByRoute?: boolean;
}

export const GEMINI_DECISION_MODEL = 'gemini-decision-1';
export const DEFAULT_GEMINI_DECISION_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_DECISION_CHOICES = 255;

export interface DecisionCredentials {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface DecisionRouteCandidate {
  spec: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  thinkingLevels: ThinkingLevel[];
  supportsImages: boolean;
  reasoning: boolean;
  contextWindow: number;
  specialties: string[];
  costInput: number;
  costOutput: number;
  latencyMs?: number;
  successCount?: number;
  failCount?: number;
  avgQualityScore?: number;
}

export interface DecisionRouteTaskInput {
  instruction: string;
  contextBrief?: string;
  profile?: 'general' | 'coding' | 'research' | 'review';
  fileCount?: number;
  hasImages?: boolean;
  isTimer?: boolean;
  preferredLevel?: ThinkingLevel;
  excludedSpecs?: string[];
  excludedProviders?: string[];
}

export interface DecisionRouteResult {
  spec: string;
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  confidence?: number;
  needsQualityGate?: boolean;
  needsQualityGateProb?: number;
  source: DecisionSource;
  attempted: boolean;
  usage?: { inputTokens: number; outputTokens?: number; totalTokens: number };
  fallbackReason?: string;
}

export interface CompletionEvaluationInput {
  prompt: string;
  contextBrief?: string;
  profile?: 'general' | 'coding' | 'research' | 'review';
  followups?: string[];
  report: string;
  succeededOps: number;
  failedOps: number;
  skipRemote?: boolean;
}

export interface CompletionEvaluationResult {
  assessment: QualityGateAssessment;
  attempted: boolean;
  usage?: { inputTokens: number; outputTokens?: number; totalTokens: number };
  fallbackReason?: string;
}

export interface SessionContinuityTurnSummary {
  channel: string;
  userText: string;
  assistantReply?: string;
  taskPrompts?: string[];
  ageSec: number;
}

export interface SessionContinuityInput {
  recentTurns: SessionContinuityTurnSummary[];
  activeTaskPrompts?: string[];
  prevChannel: string;
  currentChannel: string;
  gapSec: number;
  currentText: string;
  heuristicSame?: boolean;
  heuristicRelation?: 'answer_clarification' | 'post_task_discussion' | 'topic_continuity' | 'dialogue_followup' | 'rapid_exchange';
}

export interface SessionContinuityResult {
  sameSession: boolean;
  probability: number;
  confidence?: number;
  relation: 'answer_clarification' | 'post_task_discussion' | 'topic_continuity' | 'dialogue_followup' | 'new_topic';
  source: DecisionSource;
  attempted: boolean;
  usage?: { inputTokens: number; outputTokens?: number; totalTokens: number };
  fallbackReason?: string;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Mirrors `@earendil-works/pi-ai` `getSupportedThinkingLevels` without adding a direct runtime dependency.
 */
export function getNativeThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  const levels = THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
  return levels.length ? levels : ['low', 'medium', 'high'];
}

export function clampNativeThinkingLevel(
  supported: readonly ThinkingLevel[],
  desired?: ThinkingLevel,
): ThinkingLevel {
  if (!supported.length) return 'off';
  if (!desired) {
    if (supported.includes('medium')) return 'medium';
    if (supported.includes('low')) return 'low';
    return supported[0]!;
  }
  if (supported.includes(desired)) return desired;
  const targetIdx = THINKING_LEVELS.indexOf(desired);
  let best = supported[0]!;
  let bestDist = Math.abs(THINKING_LEVELS.indexOf(best) - targetIdx);
  for (const lvl of supported) {
    const idx = THINKING_LEVELS.indexOf(lvl);
    const dist = Math.abs(idx - targetIdx);
    if (dist < bestDist || (dist === bestDist && idx > THINKING_LEVELS.indexOf(best))) {
      best = lvl;
      bestDist = dist;
    }
  }
  return best;
}

type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: string[] };

interface DecisionResponseAnswer {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
  noul?: number;
  score?: number;
  confidence?: number;
}

interface DecisionApiResponse {
  answers?: Record<string, DecisionResponseAnswer>;
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export type DecisionContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string };
export type DecisionInput = string | DecisionContentBlock[];

export function resolveDecisionEndpoint(baseUrl?: string): string {
  const clean = (baseUrl?.trim() || DEFAULT_GEMINI_DECISION_BASE_URL).replace(/\/+$/, '');
  if (clean.endsWith('/decisions')) return clean;
  if (/\/v\d+(?:alpha|beta)?$/i.test(clean)) return `${clean}/decisions`;
  return `${clean}/v1beta/decisions`;
}

function mergeDecisionUsage(res: {
  usage?: { inputTokens: number; totalTokens: number };
  outputTokens?: number;
}): { inputTokens: number; outputTokens?: number; totalTokens: number } | undefined {
  if (!res.usage) return undefined;
  return {
    inputTokens: res.usage.inputTokens,
    ...(res.outputTokens !== undefined ? { outputTokens: res.outputTokens } : {}),
    totalTokens: res.usage.totalTokens,
  };
}

export async function requestGeminiDecisions(
  credentials: DecisionCredentials,
  input: DecisionInput,
  questions: Record<string, DecisionQuestion>,
): Promise<{
  answers: Record<string, DecisionResponseAnswer>;
  usage?: { inputTokens: number; totalTokens: number };
  outputTokens?: number;
}> {
  const endpoint = resolveDecisionEndpoint(credentials.baseUrl);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-goog-api-key': credentials.apiKey,
    },
    body: JSON.stringify({
      model: GEMINI_DECISION_MODEL,
      input,
      questions,
    }),
    signal: AbortSignal.timeout(credentials.timeoutMs ?? 4500),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini Decision API HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const payload = (await res.json()) as DecisionApiResponse;
  if (!payload || typeof payload !== 'object' || !payload.answers || typeof payload.answers !== 'object') {
    throw new Error(payload?.error?.message || 'Gemini Decision API response missing answers');
  }
  if (!payload.usage) {
    return { answers: payload.answers };
  }
  const inputTokens = Number(payload.usage.total_input_tokens ?? 0);
  const rawTotal = Number(payload.usage.total_tokens ?? 0);
  const rawOut = payload.usage.total_output_tokens;
  const outputTokens = typeof rawOut === 'number' && Number.isFinite(rawOut)
    ? Math.max(0, rawOut)
    : Math.max(0, rawTotal - inputTokens);
  const usage = {
    inputTokens,
    totalTokens: rawTotal > 0 ? rawTotal : inputTokens + outputTokens,
  };
  return { answers: payload.answers, usage, outputTokens };
}

function resolveChoiceAnswer(answer: DecisionResponseAnswer | undefined, validKeys: Set<string>): { key?: string; confidence?: number } {
  if (!answer) return {};
  if (typeof answer.choice === 'string' && validKeys.has(answer.choice)) {
    return { key: answer.choice, confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined };
  }
  if (answer.probabilities && typeof answer.probabilities === 'object') {
    let bestKey: string | undefined;
    let bestProb = -Infinity;
    for (const [k, prob] of Object.entries(answer.probabilities)) {
      if (validKeys.has(k) && typeof prob === 'number' && prob > bestProb) {
        bestProb = prob;
        bestKey = k;
      }
    }
    if (bestKey) {
      return { key: bestKey, confidence: typeof answer.confidence === 'number' ? answer.confidence : Math.max(0, Math.min(1, bestProb)) };
    }
  }
  return {};
}

const LEVEL_HINTS: Record<ThinkingLevel, string> = {
  off: 'thinking=off (no reasoning overhead, lowest latency & cost, trivial lookup/status/echo)',
  minimal: 'thinking=minimal (very light reasoning, simple checks & formatting)',
  low: 'thinking=low (fast & economical reasoning, straightforward edits/summaries)',
  medium: 'thinking=medium (balanced reasoning depth for standard coding/research tasks)',
  high: 'thinking=high (deep multi-step reasoning for complex debugging/refactoring)',
  xhigh: 'thinking=xhigh (extended deep reasoning for architecture, concurrency & root-cause analysis)',
  max: 'thinking=max (maximum reasoning depth for security audits, hard proofs & critical design)',
};

const LEVEL_DEPTH: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const MIN_STATS_SAMPLE_SIZE = 3;

function hasReliableStats(candidate: DecisionRouteCandidate): boolean {
  return ((candidate.successCount ?? 0) + (candidate.failCount ?? 0)) >= MIN_STATS_SAMPLE_SIZE;
}

const STRONG_MODEL_ID_RE = /(?:^|[-_./:])(?:opus|o1|o3|o4|reasoner|r1|deepseek-r1|grok-4|qwen-max|glm-4\.5|pro|ultra|terra|astra|argon)(?:$|[-_./:\d])/i;
const FAST_MODEL_ID_RE = /(?:^|[-_./:])(?:flash|mini|haiku|turbo|nano|lite|luna)(?:$|[-_./:\d])/i;
const CODING_MODEL_ID_RE = /(?:claude|codex|gemini|gpt-(?:4\.1|4o|[5-9]|\d{2})|(?:^|[-_./:])(?:o3|o4)(?:$|[-_./:])|coder|deepseek|glm-4\.5|kimi-k[23]|qwen3)/i;

function candidateQualityRank(candidate: DecisionRouteCandidate): number {
  let rank = 0;
  if (hasReliableStats(candidate)) {
    if (candidate.avgQualityScore !== undefined) rank += Math.max(0, (candidate.avgQualityScore - 1.5) * 6);
    if ((candidate.failCount ?? 0) > (candidate.successCount ?? 0)) rank -= 20;
  }
  if ((candidate.latencyMs ?? 0) >= 600_000) rank -= 6;
  if (candidate.reasoning) rank += 12;
  if (candidate.supportsImages) rank += 6;
  if (candidate.contextWindow >= 256_000) rank += 6;
  if (candidate.costInput > 0) rank += Math.min(12, candidate.costInput * 2);
  return rank;
}

function pickRepresentativeLevels(levels: readonly ThinkingLevel[], maxPerModel: number): ThinkingLevel[] {
  if (levels.length <= maxPerModel) return [...levels];
  if (maxPerModel <= 1) return [levels[Math.floor(levels.length / 2)]!];
  const picked = new Set<ThinkingLevel>([levels[0]!, levels.at(-1)!]);
  if (maxPerModel >= 3) picked.add(levels[Math.floor(levels.length / 2)]!);
  for (const lvl of levels) {
    if (picked.size >= maxPerModel) break;
    picked.add(lvl);
  }
  return levels.filter(l => picked.has(l));
}

function buildExpandedOptions(
  candidates: readonly DecisionRouteCandidate[],
): Array<{ key: string; candidate: DecisionRouteCandidate; level: ThinkingLevel }> {
  const ordered = [...candidates].sort((a, b) => candidateQualityRank(b) - candidateQualityRank(a));
  const rawTotal = ordered.reduce((sum, c) => sum + Math.max(1, c.thinkingLevels.length), 0);
  const perModelCap = rawTotal > MAX_DECISION_CHOICES
    ? Math.max(1, Math.floor(MAX_DECISION_CHOICES / Math.max(1, ordered.length)))
    : 7;

  const options: Array<{ key: string; candidate: DecisionRouteCandidate; level: ThinkingLevel }> = [];
  for (const candidate of ordered) {
    const levels = candidate.thinkingLevels.length ? candidate.thinkingLevels : (['off'] as ThinkingLevel[]);
    const chosen = pickRepresentativeLevels(levels, perModelCap);
    for (const level of chosen) {
      if (options.length >= MAX_DECISION_CHOICES) break;
      options.push({
        key: `${candidate.spec}@${level}`,
        candidate,
        level,
      });
    }
    if (options.length >= MAX_DECISION_CHOICES) break;
  }
  return options;
}

function formatOptionCriterion(candidate: DecisionRouteCandidate, level: ThinkingLevel): string {
  const caps = [
    candidate.supportsImages ? 'vision' : 'text-only',
    candidate.reasoning ? 'reasoning' : 'non-reasoning',
    `${Math.round(candidate.contextWindow / 1000)}K ctx`,
  ];
  if (candidate.costInput > 0 || candidate.costOutput > 0) {
    caps.push(`cost $${candidate.costInput}/$${candidate.costOutput} per 1M`);
  }
  if (candidate.specialties.length) {
    caps.push(candidate.specialties.slice(0, 5).join('/'));
  }
  const statsParts: string[] = [];
  if (hasReliableStats(candidate)) {
    if (candidate.avgQualityScore !== undefined) {
      statsParts.push(`avgQuality=${candidate.avgQualityScore.toFixed(2)}/3`);
    }
    statsParts.push(`ok=${candidate.successCount ?? 0}/fail=${candidate.failCount ?? 0}`);
  }
  const stats = statsParts.length ? `; stats: ${statsParts.join(', ')}` : '';
  return `${candidate.providerName} ${candidate.modelName} | ${LEVEL_HINTS[level]} | ${caps.join(', ')}${stats}`;
}

export const COMPLEX_TASK_PATTERN = /重构|架构|根因|并发|竞态|死锁|安全|漏洞|审计|迁移|多文件|深入|全面|复杂|端到端|性能瓶颈|全量|refactor|architecture|root\s*cause|security|vulnerability|audit|concurrency|race\s*condition|deadlock|complex|migration|redesign|deep\s*dive/i;
export const SIMPLE_TASK_PATTERN = /^(?:查看|列出|检查|状态|概括|总结|读取|格式|重命名|巡检|health|status|list|check|summary|summarize|read|format|rename)\b|查看状态|列出文件|检查构建|健康检查|日常巡检|概括这|简单总结|快速检查|统计行数/i;

export type ComplexityTier = 'fast' | 'balanced' | 'strong';
const COMPLEXITY_TIERS = new Set<ComplexityTier>(['fast', 'balanced', 'strong']);

/** Infers task complexity tier from prompt, profile, and scope hints. */
export function inferTaskComplexityTier(input: {
  instruction?: string;
  profile?: string;
  model?: string;
  tier?: string;
  fileCount?: number;
  isTimer?: boolean;
}): ComplexityTier {
  if (input.tier && COMPLEXITY_TIERS.has(input.tier as ComplexityTier)) {
    return input.tier as ComplexityTier;
  }
  if (input.model && COMPLEXITY_TIERS.has(input.model as ComplexityTier)) {
    return input.model as ComplexityTier;
  }
  const text = (input.instruction ?? '').trim();
  if (input.profile === 'review' || COMPLEX_TASK_PATTERN.test(text) || text.length >= 240 || (input.fileCount ?? 0) >= 4) {
    return 'strong';
  }
  if ((input.isTimer || (text.length > 0 && text.length <= 90 && SIMPLE_TASK_PATTERN.test(text))) && input.profile !== 'coding') {
    return 'fast';
  }
  return 'balanced';
}

/** Classifies a model's execution depth tier and routing specialty tags. */
export function classifyModelSpecialties(
  providerId: string,
  modelId: string,
  caps?: {
    reasoning?: boolean;
    supportsImages?: boolean;
    contextWindow?: number;
    sampleTiers?: { fast?: string; balanced?: string; strong?: string };
  },
): { tier: ComplexityTier; specialties: string[] } {
  const id = modelId.toLowerCase();
  const sampleTiers = caps?.sampleTiers;
  let tier: ComplexityTier = 'balanced';
  if (sampleTiers?.strong === modelId && sampleTiers?.strong !== sampleTiers?.fast) {
    tier = 'strong';
  } else if (sampleTiers?.fast === modelId && sampleTiers?.fast !== sampleTiers?.balanced) {
    tier = 'fast';
  } else if (STRONG_MODEL_ID_RE.test(id)) {
    tier = 'strong';
  } else if (FAST_MODEL_ID_RE.test(id)) {
    tier = 'fast';
  }

  const specialties: string[] = [];
  if (
    CODING_MODEL_ID_RE.test(id)
    || providerId === 'anthropic'
    || providerId === 'openai-codex'
  ) {
    specialties.push('代码工程');
  }
  if (caps?.reasoning || /(?:opus|o1|o3|o4|reasoner|r1|thinking|grok-4|qwen-max)/i.test(id)) {
    specialties.push('深度推理');
  }
  if ((caps?.contextWindow ?? 0) >= 256_000) {
    specialties.push('超长上下文');
  }
  if (caps?.supportsImages) {
    specialties.push('多模态看图');
  }
  if (tier === 'fast') {
    specialties.push('极速响应');
  }
  if (!specialties.length) {
    specialties.push('通用执行');
  }
  return { tier, specialties };
}

function filterEligibleCandidates(
  candidates: readonly DecisionRouteCandidate[],
  task: DecisionRouteTaskInput,
): DecisionRouteCandidate[] {
  if (!candidates.length) {
    throw new Error('当前模型池为空，无法执行路由决策');
  }
  const excludedExact = new Set<string>();
  const excludedBare = new Set<string>();
  for (const raw of task.excludedSpecs ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(/@(?:off|minimal|low|medium|high|xhigh|max)$/i, '').trim();
    excludedExact.add(trimmed);
    excludedExact.add(stripped);
    if (!stripped.includes('/')) {
      excludedBare.add(stripped);
    }
  }
  const excludedProvSet = new Set((task.excludedProviders ?? []).map(p => p.trim()).filter(Boolean));
  const filtered = candidates.filter(c => {
    if (excludedProvSet.has(c.providerId)) return false;
    if (excludedExact.has(c.spec) || excludedBare.has(c.modelId)) return false;
    return true;
  });
  if (!filtered.length) {
    throw new Error('当前模型池中所有可用模型均已被排除，无可用候选模型');
  }
  if (task.hasImages) {
    const visionOnly = filtered.filter(c => c.supportsImages);
    if (visionOnly.length > 0) return visionOnly;
  }
  return filtered;
}

export function selectHeuristicRoute(
  candidates: readonly DecisionRouteCandidate[],
  task: DecisionRouteTaskInput,
): { candidate: DecisionRouteCandidate; thinkingLevel: ThinkingLevel } {
  const active = filterEligibleCandidates(candidates, task);
  const text = task.instruction.trim();

  const needsVision = task.hasImages === true
    || (task.hasImages !== false && /(?:图片|截图|看图|识图|视觉|二维码|照片|设计稿|OCR)/.test(text));
  const inferredTier = inferTaskComplexityTier({
    instruction: text,
    profile: task.profile,
    fileCount: task.fileCount,
    isTimer: task.isTimer,
  });
  const isComplex = inferredTier === 'strong';
  const isSimple = inferredTier === 'fast';
  const needsCoding = task.profile === 'coding'
    || /代码|实现|修改|组件|接口|函数|测试|构建|修复|报错|脚本|编译|类型|bug|fix|implement|code|typescript|javascript|python|rust|go|css|html/i.test(text);
  const needsLongContext = task.profile === 'research'
    || (task.fileCount ?? 0) >= 4
    || /调研|搜索|全局|通读|多文件|汇总|对比|长文|文档|全库|research|investigate|summarize\s+all/i.test(text);

  const desiredLevel: ThinkingLevel = task.preferredLevel
    ?? (isComplex ? 'high' : isSimple ? 'low' : 'medium');
  const desiredDepth = LEVEL_DEPTH[desiredLevel];

  let bestCandidate = active[0]!;
  let bestLevel = clampNativeThinkingLevel(bestCandidate.thinkingLevels, desiredLevel);
  let bestScore = -Infinity;

  for (const entry of active) {
    const levels = entry.thinkingLevels.length ? entry.thinkingLevels : (['off'] as ThinkingLevel[]);
    for (const level of levels) {
      let score = 0;
      const depth = LEVEL_DEPTH[level];

      if (task.preferredLevel) {
        score += level === task.preferredLevel ? 55 : Math.max(0, 28 - Math.abs(depth - desiredDepth) * 12);
      } else if (isComplex) {
        score += depth >= 4 ? 42 + (depth - 4) * 6 : depth * 6;
        if (entry.reasoning) score += 32;
        if (entry.specialties.includes('深度推理') || STRONG_MODEL_ID_RE.test(entry.modelId)) {
          score += 24;
        }
      } else if (isSimple) {
        score += depth <= 2 ? 42 - depth * 4 : Math.max(-15, 16 - depth * 6);
        if (FAST_MODEL_ID_RE.test(entry.modelId)) score += 28;
        if (STRONG_MODEL_ID_RE.test(entry.modelId) || entry.reasoning) score -= 12;
      } else {
        score += 36 - Math.abs(depth - 3) * 10;
        if (/(?:sonnet|flash|gpt-4\.1|gpt-4o|gpt-6-sol|gpt-6\.1-sol|deepseek-chat|gemini-2\.5|carbon|hydrogen)/i.test(entry.modelId)) score += 18;
      }

      if (needsVision) {
        score += entry.supportsImages ? 60 : -140;
      }
      if (needsCoding) {
        if (entry.specialties.includes('代码工程')) score += 26;
        if (CODING_MODEL_ID_RE.test(entry.modelId)) score += 18;
      }
      if (needsLongContext) {
        if (entry.contextWindow >= 500_000) score += 32;
        else if (entry.contextWindow >= 200_000) score += 18;
      }
      if (hasReliableStats(entry)) {
        if (entry.avgQualityScore !== undefined) {
          score += (entry.avgQualityScore - 1.5) * 18;
        }
        if ((entry.successCount ?? 0) > 0) score += Math.min(20, (entry.successCount ?? 0) * 3);
        if ((entry.failCount ?? 0) > (entry.successCount ?? 0)) score -= 45;
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = entry;
        bestLevel = level;
      }
    }
  }

  return { candidate: bestCandidate, thinkingLevel: bestLevel };
}

export async function decideWorkerRoute(
  candidates: readonly DecisionRouteCandidate[],
  task: DecisionRouteTaskInput,
  credentials?: DecisionCredentials,
): Promise<DecisionRouteResult> {
  const pool = filterEligibleCandidates(candidates, task);
  const expanded = buildExpandedOptions(pool);
  const heuristicPick = selectHeuristicRoute(pool, task);

  if (expanded.length <= 1 || !credentials?.apiKey?.trim()) {
    const only = expanded.length === 1 ? expanded[0]! : undefined;
    const candidate = only?.candidate ?? heuristicPick.candidate;
    const thinkingLevel = only?.level ?? heuristicPick.thinkingLevel;
    return {
      spec: candidate.spec,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      thinkingLevel,
      source: 'heuristic',
      attempted: false,
    };
  }

  const criteria: Record<string, string> = {};
  const byKey = new Map<string, { candidate: DecisionRouteCandidate; level: ThinkingLevel }>();
  for (const item of expanded) {
    criteria[item.key] = formatOptionCriterion(item.candidate, item.level);
    byKey.set(item.key, { candidate: item.candidate, level: item.level });
  }

  const complexityTier = inferTaskComplexityTier({
    instruction: task.instruction,
    profile: task.profile,
    fileCount: task.fileCount,
    isTimer: task.isTimer,
  });
  const preferredThinkingLevel = task.preferredLevel
    ?? (complexityTier === 'strong' ? 'high' : complexityTier === 'fast' ? 'low' : 'medium');

  const inputPayload = JSON.stringify({
    instruction: task.instruction.slice(0, 2000),
    ...(task.contextBrief ? { contextBrief: task.contextBrief.slice(0, 1200) } : {}),
    profile: task.profile ?? 'general',
    complexityTier,
    preferredThinkingLevel,
    fileCount: task.fileCount ?? 0,
    hasImages: Boolean(task.hasImages),
    isTimer: Boolean(task.isTimer),
  });

  try {
    const res = await requestGeminiDecisions(credentials, inputPayload, {
      route: {
        type: 'choice',
        instructions: 'Select the optimal "provider/model@thinkingLevel" candidate for this task. Match model capability class, pricing tier, and reasoning depth to complexityTier and preferredThinkingLevel: for "strong" or complex coding/debugging/research tasks, prefer full-capability flagship or balanced models over lightweight flash/mini/lite/luna models even when a lightweight model has prior stats; do not lock onto models with prior stats when stronger uncalibrated models in the pool better fit the task.',
        criteria,
      },
      needs_quality_gate: {
        type: 'noul',
        instructions: 'Does this task involve multi-step implementation, code/file changes, complex debugging/research/review, or verification risks that warrant a post-execution completion quality gate (versus a trivial status check, simple lookup, or single-step read)?',
      },
    });
    const rawGateProb = Number(res.answers.needs_quality_gate?.noul);
    const gateFields = Number.isFinite(rawGateProb)
      ? (() => {
          const prob = Number(Math.max(0, Math.min(1, rawGateProb)).toFixed(3));
          return { needsQualityGate: prob >= 0.45, needsQualityGateProb: prob };
        })()
      : {};
    const resolved = resolveChoiceAnswer(res.answers.route, new Set(byKey.keys()));
    const hit = resolved.key ? byKey.get(resolved.key) : undefined;
    if (hit) {
      return {
        spec: hit.candidate.spec,
        providerId: hit.candidate.providerId,
        modelId: hit.candidate.modelId,
        thinkingLevel: hit.level,
        confidence: resolved.confidence !== undefined ? Number(resolved.confidence.toFixed(3)) : undefined,
        ...gateFields,
        source: 'gemini-decision-1',
        attempted: true,
        usage: mergeDecisionUsage(res),
      };
    }
    return {
      spec: heuristicPick.candidate.spec,
      providerId: heuristicPick.candidate.providerId,
      modelId: heuristicPick.candidate.modelId,
      thinkingLevel: heuristicPick.thinkingLevel,
      ...gateFields,
      source: 'heuristic',
      attempted: true,
      usage: mergeDecisionUsage(res),
      fallbackReason: 'Gemini Decision API returned no valid candidate key',
    };
  } catch (error) {
    return {
      spec: heuristicPick.candidate.spec,
      providerId: heuristicPick.candidate.providerId,
      modelId: heuristicPick.candidate.modelId,
      thinkingLevel: heuristicPick.thinkingLevel,
      source: 'heuristic',
      attempted: true,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

const VALID_MISSING_ASPECTS = new Set<MissingAspect>([
  'none',
  'incomplete_requirements',
  'missing_verification',
  'unresolved_error',
  'superficial_analysis',
]);

function heuristicCompletionAssessment(input: CompletionEvaluationInput): QualityGateAssessment {
  const report = input.report.trim();
  const now = Date.now();
  if (!report || report.length < 4) {
    return {
      score: 0.5,
      maxScore: 3,
      confidence: 0.75,
      supplementProbability: 0.9,
      shouldSupplement: true,
      missingAspect: 'incomplete_requirements',
      source: 'heuristic',
      evaluatedAt: now,
    };
  }
  if (input.failedOps > 0 && input.succeededOps === 0) {
    return {
      score: 1.0,
      maxScore: 3,
      confidence: 0.72,
      supplementProbability: 0.82,
      shouldSupplement: true,
      missingAspect: 'unresolved_error',
      source: 'heuristic',
      evaluatedAt: now,
    };
  }
  if (/\[NEEDS_SUPPLEMENT[:：]/i.test(input.prompt) && !/\[已完成补查/.test(input.prompt)) {
    return {
      score: 1.4,
      maxScore: 3,
      confidence: 0.65,
      supplementProbability: 0.65,
      shouldSupplement: true,
      missingAspect: 'missing_verification',
      source: 'heuristic',
      evaluatedAt: now,
    };
  }
  const hasEvidence = input.succeededOps > 0 || report.length >= 40;
  return {
    score: hasEvidence ? 2.5 : 2.0,
    maxScore: 3,
    confidence: 0.7,
    supplementProbability: 0.15,
    shouldSupplement: false,
    missingAspect: 'none',
    source: 'heuristic',
    evaluatedAt: now,
  };
}

export async function evaluateWorkCompletion(
  input: CompletionEvaluationInput,
  credentials?: DecisionCredentials,
): Promise<CompletionEvaluationResult> {
  const fallback = heuristicCompletionAssessment(input);
  const canSkipRemote = Boolean(input.skipRemote)
    && !(input.followups?.length)
    && input.failedOps === 0
    && !fallback.shouldSupplement;
  if (canSkipRemote) {
    return {
      assessment: { ...fallback, skippedByRoute: true },
      attempted: false,
    };
  }
  if (!credentials?.apiKey?.trim()) {
    return { assessment: fallback, attempted: false };
  }

  const aspectCriteria: Record<MissingAspect, string> = {
    none: 'All explicit user requirements and necessary checks appear sufficiently addressed.',
    incomplete_requirements: 'One or more explicit task requirements or follow-ups were skipped or only partially answered.',
    missing_verification: 'Claims code changes or results without running or citing concrete verification/tests/reads.',
    unresolved_error: 'Report mentions unresolved failures, errors, blockers, or failed tool calls.',
    superficial_analysis: 'Surface-level summary or speculation lacking concrete evidence from inspected files or outputs.',
  };

  const evalInput = JSON.stringify({
    prompt: input.prompt.slice(0, 2000),
    ...(input.contextBrief ? { contextBrief: input.contextBrief.slice(0, 1000) } : {}),
    profile: input.profile ?? 'general',
    ...(input.followups?.length ? { followups: input.followups.slice(-6).map(f => f.slice(0, 400)) } : {}),
    toolStats: { succeededOps: input.succeededOps, failedOps: input.failedOps },
    report: input.report.slice(0, 3500),
  });

  try {
    const res = await requestGeminiDecisions(credentials, evalInput, {
      completion: {
        type: 'score',
        instructions: 'Rate how completely and verifiably the Worker report satisfies the task prompt and follow-ups.',
        criteria: [
          '0: Failed, off-topic, empty, or fabricated claims without doing the work.',
          '1: Partially complete; missed explicit requirements or lacks required verification/tests.',
          '2: Substantially complete and ready to deliver; only minor non-blocking polish omitted.',
          '3: Fully complete with concrete tool, file, or test verification evidence.',
        ],
      },
      should_supplement: {
        type: 'noul',
        instructions: 'Should this Worker report be sent back for a supplementary check or fix before delivering to the Boss?',
      },
      missing_aspect: {
        type: 'choice',
        instructions: 'Identify the primary completion gap if any, or "none" if ready to deliver.',
        criteria: aspectCriteria,
      },
    });

    const rawScore = Number(res.answers.completion?.score);
    const rawNoul = Number(res.answers.should_supplement?.noul);
    if (!Number.isFinite(rawScore) || !Number.isFinite(rawNoul)) {
      return {
        assessment: fallback,
        attempted: true,
        usage: mergeDecisionUsage(res),
        fallbackReason: 'Gemini Decision API returned non-numeric completion score or noul',
      };
    }

    const score = Number(Math.max(0, Math.min(3, rawScore)).toFixed(2));
    const supplementProbability = Number(Math.max(0, Math.min(1, rawNoul)).toFixed(3));
    const confParts = [
      res.answers.completion?.confidence,
      res.answers.should_supplement?.confidence,
      res.answers.missing_aspect?.confidence,
    ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const confidence = Number(
      (confParts.length ? confParts.reduce((a, b) => a + b, 0) / confParts.length : 0.75).toFixed(2),
    );
    const aspectPick = resolveChoiceAnswer(
      res.answers.missing_aspect,
      VALID_MISSING_ASPECTS as Set<string>,
    );
    const shouldSupplement = supplementProbability >= 0.55 || score < 1.6;
    const missingAspect: MissingAspect =
      !shouldSupplement && score >= 2.2
        ? 'none'
        : ((aspectPick.key as MissingAspect | undefined) ?? (shouldSupplement ? 'incomplete_requirements' : 'none'));

    return {
      assessment: {
        score,
        maxScore: 3,
        confidence,
        supplementProbability,
        shouldSupplement,
        missingAspect,
        source: 'gemini-decision-1',
        evaluatedAt: Date.now(),
      },
      attempted: true,
      usage: mergeDecisionUsage(res),
    };
  } catch (error) {
    return {
      assessment: fallback,
      attempted: true,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

const VALID_SESSION_RELATIONS = new Set<SessionContinuityResult['relation']>([
  'answer_clarification',
  'post_task_discussion',
  'topic_continuity',
  'dialogue_followup',
  'new_topic',
]);

export async function evaluateSessionContinuity(
  input: SessionContinuityInput,
  credentials?: DecisionCredentials,
): Promise<SessionContinuityResult> {
  const defaultSame = Boolean(input.heuristicSame);
  const defaultRel: SessionContinuityResult['relation'] = defaultSame
    ? (input.heuristicRelation === 'answer_clarification' || input.heuristicRelation === 'post_task_discussion' || input.heuristicRelation === 'topic_continuity'
        ? input.heuristicRelation
        : 'dialogue_followup')
    : 'new_topic';
  const fallback: SessionContinuityResult = {
    sameSession: defaultSame,
    probability: defaultSame ? 0.72 : 0.2,
    relation: defaultRel,
    source: 'heuristic',
    attempted: false,
  };
  if (!credentials?.apiKey?.trim()) {
    return fallback;
  }

  const relationCriteria: Record<SessionContinuityResult['relation'], string> = {
    answer_clarification: 'Current message directly answers, confirms, or responds to an assistant question or clarification request in the prior turn.',
    post_task_discussion: 'Current message discusses, inspects, modifies, or follows up on work or results from the ongoing session.',
    topic_continuity: 'Current message continues the same topic, project, entities, or context from recent turns.',
    dialogue_followup: 'Current message is a conversational reaction, short follow-up, or acknowledgment in the same ongoing session.',
    new_topic: 'Current message opens an unrelated new topic or standalone request not continuing the recent turns.',
  };

  const evalInput = JSON.stringify({
    recentTurns: input.recentTurns.slice(-4).map(t => ({
      channel: t.channel,
      ageSec: Math.max(0, Math.round(t.ageSec)),
      userText: t.userText.replace(/\s+/g, ' ').slice(0, 260),
      ...(t.assistantReply ? { assistantReply: t.assistantReply.replace(/\s+/g, ' ').slice(0, 260) } : {}),
      ...(t.taskPrompts?.length ? { taskPrompts: t.taskPrompts.slice(0, 3).map(p => p.slice(0, 180)) } : {}),
    })),
    ...(input.activeTaskPrompts?.length ? { activeTaskPrompts: input.activeTaskPrompts.slice(0, 4).map(p => p.slice(0, 180)) } : {}),
    prevChannel: input.prevChannel,
    currentChannel: input.currentChannel,
    gapSec: Math.max(0, Math.round(input.gapSec)),
    currentText: input.currentText.replace(/\s+/g, ' ').slice(0, 360),
  });

  try {
    const res = await requestGeminiDecisions(
      { ...credentials, timeoutMs: credentials.timeoutMs ?? 2500 },
      evalInput,
      {
        same_session: {
          type: 'noul',
          instructions: 'Return high probability (>=0.5) if currentText is a continuation, follow-up, clarification, answer, or reaction within the SAME conversation session as recentTurns/activeTaskPrompts; return low probability (<0.5) if currentText starts a brand-new unrelated topic or standalone request.',
        },
        relation: {
          type: 'choice',
          instructions: 'Classify how currentText relates to the prior session.',
          criteria: relationCriteria,
        },
      },
    );

    const sameAns = res.answers.same_session;
    const rawProb = typeof sameAns?.noul === 'number'
      ? sameAns.noul
      : typeof sameAns?.probabilities?.true === 'number'
        ? sameAns.probabilities.true
        : NaN;
    if (!Number.isFinite(rawProb)) {
      return {
        ...fallback,
        attempted: true,
        usage: mergeDecisionUsage(res),
        fallbackReason: 'Gemini Decision API returned non-numeric same_session probability',
      };
    }

    const probability = Number(Math.max(0, Math.min(1, rawProb)).toFixed(3));
    const relPick = resolveChoiceAnswer(res.answers.relation, VALID_SESSION_RELATIONS as Set<string>);
    const sameChannel = input.prevChannel === input.currentChannel;
    const sameSession = probability >= 0.5 || (Boolean(input.heuristicSame) && sameChannel && input.gapSec <= 120 && probability >= 0.3);
    const relation: SessionContinuityResult['relation'] = !sameSession
      ? 'new_topic'
      : (relPick.key && relPick.key !== 'new_topic'
          ? relPick.key as SessionContinuityResult['relation']
          : (defaultRel === 'new_topic' ? 'dialogue_followup' : defaultRel));
    const confParts = [sameAns?.confidence, res.answers.relation?.confidence]
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const confidence = confParts.length
      ? Number((confParts.reduce((a, b) => a + b, 0) / confParts.length).toFixed(2))
      : undefined;

    return {
      sameSession,
      probability,
      ...(confidence !== undefined ? { confidence } : {}),
      relation,
      source: 'gemini-decision-1',
      attempted: true,
      usage: mergeDecisionUsage(res),
    };
  } catch (error) {
    return {
      ...fallback,
      attempted: true,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}
