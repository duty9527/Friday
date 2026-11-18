import type { DecisionRouteCandidate, DecisionSource } from '../decision.js';
import type { PooledModelEntry } from '../view.js';
import { parseModelSpec, splitModelAndLevel, type ModelEffectStats } from './catalog.js';

export interface DecisionEraTaskRecord {
  id: string;
  workerModel?: string;
  status: string;
  activeMs: number;
  createdAt: number;
  parentTaskId?: string;
  decisionSource?: DecisionSource;
  qualityGate?: { score: number; source: DecisionSource };
}

/** Aggregates completed/failed decision-routed task outcomes into model stats. */
export function accumulateDecisionEraStats(
  tasks: readonly DecisionEraTaskRecord[],
  cachedPool: readonly PooledModelEntry[],
  defaultProvider: string,
): Record<string, ModelEffectStats> {
  const supplementedIds = new Set(
    tasks.map(t => t.parentTaskId).filter((id): id is string => Boolean(id)),
  );
  const jevTasks = tasks
    .filter(t => Boolean(t.decisionSource) && (t.status === 'completed' || t.status === 'failed') && Boolean(t.workerModel))
    .sort((a, b) => a.createdAt - b.createdAt);

  const knownProviders = cachedPool.map(item => item.providerId);
  const nextStats: Record<string, ModelEffectStats> = {};
  for (const task of jevTasks) {
    const rawModel = splitModelAndLevel(task.workerModel!).model;
    if (!rawModel) continue;
    const poolHit = cachedPool.find(item => item.spec === rawModel || item.modelId === rawModel);
    const spec = poolHit
      ? poolHit.spec
      : parseModelSpec(rawModel, { fallbackProvider: defaultProvider, knownProviders }).spec;
    const ok = task.status === 'completed';
    const prev = nextStats[spec] ?? { successCount: 0, failCount: 0, updatedAt: task.createdAt || Date.now() };
    let qualityScoreSum = prev.qualityScoreSum ?? 0;
    let qualityCount = prev.qualityCount ?? 0;
    if (ok && task.qualityGate?.source === 'gemini-decision-1' && Number.isFinite(task.qualityGate.score)) {
      const clamped = Math.max(0, Math.min(3, task.qualityGate.score));
      const effective = supplementedIds.has(task.id) ? Math.min(clamped, 1.2) : clamped;
      qualityScoreSum += effective;
      qualityCount += 1;
    }
    const avgQualityScore = qualityCount > 0
      ? Number((qualityScoreSum / qualityCount).toFixed(2))
      : prev.avgQualityScore;
    nextStats[spec] = {
      ...prev,
      successCount: prev.successCount + (ok ? 1 : 0),
      failCount: prev.failCount + (ok ? 0 : 1),
      ...(task.activeMs > 0 ? { lastLatencyMs: Math.round(task.activeMs) } : {}),
      ...(qualityCount > 0 ? { qualityScoreSum: Number(qualityScoreSum.toFixed(2)), qualityCount, avgQualityScore } : {}),
      updatedAt: task.createdAt || Date.now(),
    };
  }
  return nextStats;
}

/** Converts pooled entries + cached pricing into routing candidates. */
export function toDecisionCandidates(
  entries: readonly PooledModelEntry[],
  cachedCosts: ReadonlyMap<string, { costInput: number; costOutput: number }>,
): DecisionRouteCandidate[] {
  return entries.map(entry => {
    const cost = cachedCosts.get(entry.spec);
    return {
      spec: entry.spec,
      providerId: entry.providerId,
      providerName: entry.providerName,
      modelId: entry.modelId,
      modelName: entry.modelName,
      thinkingLevels: entry.thinkingLevels.length ? entry.thinkingLevels : ['off'],
      supportsImages: entry.supportsImages,
      reasoning: entry.reasoning,
      contextWindow: entry.contextWindow,
      specialties: entry.specialties,
      costInput: cost?.costInput ?? 0,
      costOutput: cost?.costOutput ?? 0,
      latencyMs: entry.latencyMs,
      successCount: entry.successCount,
      failCount: entry.failCount,
      avgQualityScore: entry.avgQualityScore,
    };
  });
}

/** Builds a descriptive error listing enabled pool specs when a requested model is missing. */
export function formatModelNotInPoolError(rawModel: string, cachedPool: readonly PooledModelEntry[]): Error {
  const limit = 12;
  const specs = cachedPool.map(p => p.spec);
  const listed = specs.slice(0, limit).join(', ') + (specs.length > limit ? ` 等 ${specs.length} 个` : '');
  return new Error(`模型 "${rawModel}" 未在模型中心启用；当前可用：${listed || '无'}`);
}
