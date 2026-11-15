import { randomUUID } from 'node:crypto';
import { cosineSimilarity } from '../semantic.js';
import {
  computeCentroid,
  SPEAKER_SAMPLE_RATE,
  type XiaoaiSpeakerProfile,
} from './speaker-verify.js';
import { isXiaoaiFollowUpCancel, stripLeadingAssistantWake } from './utterance-utils.js';

export const DEFAULT_MIN_ENROLL_DURATION_MS = 900;
export const DEFAULT_ENROLL_UTTERANCES = 3;
export const APPEND_ENROLL_UTTERANCES = 2;
export const DEFAULT_ENROLL_STEP_TTL_MS = 45_000;

export type SpeakerVoiceCommand =
  | { kind: 'enroll'; targetName?: string; mode: 'replace' | 'append' }
  | { kind: 'whoami' }
  | { kind: 'list' }
  | { kind: 'remove'; targetName?: string }
  | { kind: 'clear' }
  | { kind: 'toggle'; enabled: boolean };

export interface XiaoaiEnrollSessionSnapshot {
  sessionId: string;
  channelId: string;
  targetId: string;
  speakerName: string;
  role: 'owner' | 'member';
  mode: 'replace' | 'append';
  status: 'preparing_model' | 'collecting' | 'completed' | 'cancelled' | 'failed';
  step: number;
  totalSteps: number;
  message: string;
  error?: string;
  profileId?: string;
  updatedAt: number;
}

interface ActiveEnrollSession {
  sessionId: string;
  channelId: string;
  targetId: string;
  speakerName: string;
  role: 'owner' | 'member';
  mode: 'replace' | 'append';
  status: 'preparing_model' | 'collecting';
  step: number;
  totalSteps: number;
  message: string;
  collectedEmbeddings: Float32Array[];
  retryCount: number;
  emptyRetryCount: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

function normalizeSpeakerTargetToken(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^[的给帮为]+/, '')
    .replace(/(?:的|一下)+$/g, '')
    .trim();
  if (!cleaned || /^(?:我|本人|自己|我的|咱|咱们)$/.test(cleaned)) {
    return undefined;
  }
  return cleaned.slice(0, 24);
}

export function parseSpeakerVoiceCommand(rawText: string): SpeakerVoiceCommand | undefined {
  const cleaned = stripLeadingAssistantWake(rawText);
  if (!cleaned) return undefined;

  // 1. Toggle verification on/off
  if (/^(?:请|帮我|麻烦)?(?:暂停|关闭|停用|关掉)(?:声纹|音色)(?:识别|过滤|验证|保护|门禁)?$/.test(cleaned)) {
    return { kind: 'toggle', enabled: false };
  }
  if (/^(?:请|帮我|麻烦)?(?:开启|打开|恢复|启用)(?:声纹|音色)(?:识别|过滤|验证|保护|门禁)?$/.test(cleaned)) {
    return { kind: 'toggle', enabled: true };
  }

  // 2. Clear all voiceprints
  if (/^(?:请|帮我|麻烦)?(?:清空|删除|清除|重置)(?:所有|全部)(?:人的?)?(?:声纹|音色)(?:档案|信息|记录)?$/.test(cleaned)) {
    return { kind: 'clear' };
  }

  // 3. Who am I / voice test
  if (
    /^(?:请问)?(?:我是谁|听听我是谁|猜猜我是谁|你能听出我是谁吗|听得出我是谁吗|识别(?:一下)?我的(?:声纹|音色)|测试(?:一下)?(?:我的)?(?:声纹|音色)|声纹自检|音色自检)$/.test(
      cleaned,
    )
  ) {
    return { kind: 'whoami' };
  }

  // 4. List / status
  if (
    /^(?:请|帮我|麻烦)?(?:查看|查询|看看|列出|播报)?(?:已录入的?|现有的?|当前的?)?(?:声纹|音色)(?:列表|名单|状态|管理|情况|成员|档案)$/.test(
      cleaned,
    )
    || /^(?:请|帮我|麻烦)?(?:查看|查询|看看|列出|播报)(?:已录入的?)?(?:声纹|音色)$/.test(cleaned)
    || /^(?:家里|目前|现在)?(?:有|录了)(?:哪些|几个|谁的)(?:声纹|音色|声音)(?:啊|吗|呢)?$/.test(cleaned)
  ) {
    return { kind: 'list' };
  }

  // 5. Remove single speaker
  let match = /^(?:请|帮我|麻烦)?(?:删除|移除|清除|删掉)(.{1,16}?)的(?:声纹|音色)(?:档案|记录)?$/.exec(cleaned);
  if (match) {
    const rawTarget = match[1]?.trim() ?? '';
    if (!/^(?:所有|全部)/.test(rawTarget)) {
      const targetName = normalizeSpeakerTargetToken(rawTarget);
      return targetName ? { kind: 'remove', targetName } : { kind: 'remove' };
    }
  }
  match = /^(?:请|帮我|麻烦)?(?:删除|移除|清除)(?:声纹|音色)[:：,\s，]+(.{1,16})$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'remove', targetName } : { kind: 'remove' };
  }

  // 6. Append / supplement existing voiceprint
  match = /^(?:请|帮我|麻烦)?(?:帮|给|为)(.{1,16}?)(?:补充|追加|完善|加强)(?:一下)?(?:声纹|音色)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'append' } : { kind: 'enroll', mode: 'append' };
  }
  match = /^(?:请|帮我|麻烦)?(?:补充|追加|完善|加强)(?:一下)?(?:(.{1,16}?)的)?(?:声纹|音色)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'append' } : { kind: 'enroll', mode: 'append' };
  }

  // 7. Enroll / register / re-record voiceprint
  match = /^(?:请|帮我|麻烦)?(?:帮|给|为)(.{1,16}?)(?:重新)?(?:录入|注册|添加|新增|采集|重录)(?:一下)?(?:声纹|音色|声音)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'replace' } : { kind: 'enroll', mode: 'replace' };
  }
  match = /^(?:请|帮我|麻烦)?(?:重新)?(?:录入|注册|添加|新增|采集|保存|记住|重录)(?:一下)?(?:(.{1,16}?)的)?(?:声纹|音色|声音)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'replace' } : { kind: 'enroll', mode: 'replace' };
  }
  match = /^(?:请|帮我|麻烦)?(?:录入|注册|添加|新增)(?:家人|家庭|成员)?(?:声纹|音色)[:：,\s，]+(.{1,16})$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'replace' } : { kind: 'enroll', mode: 'replace' };
  }

  return undefined;
}

export function isEnrollCancelPhrase(rawText: string): boolean {
  return isXiaoaiFollowUpCancel(rawText, { includeEnrollVariants: true });
}

function buildStepPrompt(step: number, totalSteps: number, speakerName: string, mode: 'replace' | 'append'): string {
  const examples = [
    '星期五，今天天气怎么样',
    '帮我看一下家里哪些灯开着',
    '请把客厅的电视声音调小一点',
    '明天早上八点记得叫我起床',
  ];
  const example = examples[(step - 1) % examples.length] ?? examples[0]!;
  if (step === 1) {
    const prefix = mode === 'append' ? `开始为${speakerName}补充声纹` : `好的，开始为${speakerName}录入声纹`;
    return `${prefix}，共 ${totalSteps} 句。请先自然说第 1 句，比如：${example}。`;
  }
  return `第 ${step - 1} 句已收到。请说第 ${step} 句，例如：${example}。`;
}

export class XiaoaiSpeakerEnrollController {
  private readonly active = new Map<string, ActiveEnrollSession>();
  private readonly history = new Map<string, XiaoaiEnrollSessionSnapshot>();
  private readonly stepTtlMs: number;

  constructor(options?: { stepTtlMs?: number }) {
    this.stepTtlMs = options?.stepTtlMs ?? DEFAULT_ENROLL_STEP_TTL_MS;
  }

  private key(channelId: string, targetId: string): string {
    return `${channelId}:${targetId}`;
  }

  private toSnapshot(session: ActiveEnrollSession): XiaoaiEnrollSessionSnapshot {
    return {
      sessionId: session.sessionId,
      channelId: session.channelId,
      targetId: session.targetId,
      speakerName: session.speakerName,
      role: session.role,
      mode: session.mode,
      status: session.status,
      step: session.step,
      totalSteps: session.totalSteps,
      message: session.message,
      updatedAt: session.updatedAt,
    };
  }

  private saveHistory(snapshot: XiaoaiEnrollSessionSnapshot): void {
    this.history.set(snapshot.sessionId, snapshot);
    if (this.history.size > 32) {
      const oldestKey = this.history.keys().next().value;
      if (oldestKey) this.history.delete(oldestKey);
    }
  }

  isActive(channelId: string, targetId: string, now = Date.now()): boolean {
    const k = this.key(channelId, targetId);
    const session = this.active.get(k);
    if (!session) return false;
    if (session.expiresAt <= now) {
      this.active.delete(k);
      this.saveHistory({
        ...this.toSnapshot(session),
        status: 'failed',
        error: '声纹录入已超时',
        message: '声纹录入已超时，请重新开始。',
        updatedAt: now,
      });
      return false;
    }
    return true;
  }

  getActive(channelId: string, targetId: string): XiaoaiEnrollSessionSnapshot | undefined {
    if (!this.isActive(channelId, targetId)) return undefined;
    const session = this.active.get(this.key(channelId, targetId));
    return session ? this.toSnapshot(session) : undefined;
  }

  getStatus(sessionId: string): XiaoaiEnrollSessionSnapshot | undefined {
    for (const session of this.active.values()) {
      if (session.sessionId === sessionId) {
        if (!this.isActive(session.channelId, session.targetId)) break;
        return this.toSnapshot(session);
      }
    }
    return this.history.get(sessionId);
  }

  createPreparingSession(params: {
    channelId: string;
    targetId: string;
    speakerName: string;
    role: 'owner' | 'member';
    mode: 'replace' | 'append';
  }): XiaoaiEnrollSessionSnapshot {
    const k = this.key(params.channelId, params.targetId);
    const prev = this.active.get(k);
    if (prev) {
      this.saveHistory({
        ...this.toSnapshot(prev),
        status: 'cancelled',
        message: '已被新的声纹录入任务取代',
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const totalSteps = params.mode === 'append' ? APPEND_ENROLL_UTTERANCES : DEFAULT_ENROLL_UTTERANCES;
    const session: ActiveEnrollSession = {
      sessionId: `enroll_${randomUUID().slice(0, 12)}`,
      channelId: params.channelId,
      targetId: params.targetId,
      speakerName: params.speakerName,
      role: params.role,
      mode: params.mode,
      status: 'preparing_model',
      step: 0,
      totalSteps,
      message: '正在准备声纹模型，请稍候。',
      collectedEmbeddings: [],
      retryCount: 0,
      emptyRetryCount: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + Math.max(this.stepTtlMs, 95_000),
    };
    this.active.set(k, session);
    const snap = this.toSnapshot(session);
    this.saveHistory(snap);
    return snap;
  }

  activateSession(sessionId: string): { snapshot: XiaoaiEnrollSessionSnapshot; prompt: string } | undefined {
    for (const session of this.active.values()) {
      if (session.sessionId !== sessionId) continue;
      const now = Date.now();
      session.status = 'collecting';
      session.step = 1;
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = buildStepPrompt(1, session.totalSteps, session.speakerName, session.mode);
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { snapshot: snap, prompt };
    }
    return undefined;
  }

  failSession(sessionId: string, errorMessage: string): XiaoaiEnrollSessionSnapshot | undefined {
    for (const [k, session] of this.active.entries()) {
      if (session.sessionId !== sessionId) continue;
      this.active.delete(k);
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'failed',
        error: errorMessage,
        message: errorMessage,
        updatedAt: Date.now(),
      };
      this.saveHistory(snap);
      return snap;
    }
    const existing = this.history.get(sessionId);
    if (existing) {
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...existing,
        status: 'failed',
        error: errorMessage,
        message: errorMessage,
        updatedAt: Date.now(),
      };
      this.saveHistory(snap);
      return snap;
    }
    return undefined;
  }

  cancelByIdOrTarget(idOrChannel?: { sessionId?: string; channelId?: string; targetId?: string }): XiaoaiEnrollSessionSnapshot | undefined {
    const now = Date.now();
    for (const [k, session] of this.active.entries()) {
      const matchesSession = idOrChannel?.sessionId && session.sessionId === idOrChannel.sessionId;
      const matchesTarget = idOrChannel?.channelId && idOrChannel?.targetId
        && session.channelId === idOrChannel.channelId && session.targetId === idOrChannel.targetId;
      const matchesAny = !idOrChannel?.sessionId && !idOrChannel?.channelId;
      if (!matchesSession && !matchesTarget && !matchesAny) continue;
      this.active.delete(k);
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'cancelled',
        message: '已取消声纹录入。',
        updatedAt: now,
      };
      this.saveHistory(snap);
      return snap;
    }
    return idOrChannel?.sessionId ? this.history.get(idOrChannel.sessionId) : undefined;
  }

  processSample(params: {
    channelId: string;
    targetId: string;
    samples?: Float32Array;
    sampleRate?: number;
    transcript: string;
    extractor: (samples: Float32Array, sampleRate: number) => Float32Array | undefined;
    existingProfile?: XiaoaiSpeakerProfile;
    minEnrollDurationMs?: number;
  }):
    | { outcome: 'inactive' }
    | { outcome: 'cancelled'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'retry'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'failed'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'next_step'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'ready_to_save'; embeddings: Float32Array[]; session: XiaoaiEnrollSessionSnapshot } {
    const k = this.key(params.channelId, params.targetId);
    if (!this.isActive(params.channelId, params.targetId)) {
      return { outcome: 'inactive' };
    }
    const session = this.active.get(k);
    if (!session) {
      return { outcome: 'inactive' };
    }
    const now = Date.now();

    if (isEnrollCancelPhrase(params.transcript)) {
      this.active.delete(k);
      const prompt = '好的，已取消声纹录入。';
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'cancelled',
        message: prompt,
        updatedAt: now,
      };
      this.saveHistory(snap);
      return { outcome: 'cancelled', prompt, snapshot: snap };
    }

    if (session.status !== 'collecting') {
      return {
        outcome: 'retry',
        prompt: '声纹模型还在准备中，请稍等片刻。',
        snapshot: this.toSnapshot(session),
      };
    }

    const sampleRate = params.sampleRate ?? SPEAKER_SAMPLE_RATE;
    const minDurationMs = params.minEnrollDurationMs ?? DEFAULT_MIN_ENROLL_DURATION_MS;
    const minSamples = Math.max(Math.round(sampleRate * 0.35), Math.round((sampleRate * minDurationMs) / 1000));
    if (!params.samples || params.samples.length < minSamples) {
      session.retryCount++;
      session.emptyRetryCount = 0;
      if (session.retryCount > 4) {
        this.active.delete(k);
        const prompt = '连续几次句子太短，声纹录入已退出。';
        const snap: XiaoaiEnrollSessionSnapshot = {
          ...this.toSnapshot(session),
          status: 'failed',
          error: prompt,
          message: prompt,
          updatedAt: now,
        };
        this.saveHistory(snap);
        return { outcome: 'failed', prompt, snapshot: snap };
      }
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = '刚才这句话太短了，请靠近音箱自然多说几个字。';
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'retry', prompt, snapshot: snap };
    }

    const emb = params.extractor(params.samples, sampleRate);
    if (!emb) {
      session.retryCount++;
      session.emptyRetryCount = 0;
      if (session.retryCount > 4) {
        this.active.delete(k);
        const prompt = '未能提取到有效声纹，已退出录入。';
        const snap: XiaoaiEnrollSessionSnapshot = {
          ...this.toSnapshot(session),
          status: 'failed',
          error: prompt,
          message: prompt,
          updatedAt: now,
        };
        this.saveHistory(snap);
        return { outcome: 'failed', prompt, snapshot: snap };
      }
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = '刚才没听清您的音色，请清晰再说一句。';
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'retry', prompt, snapshot: snap };
    }

    let consistent = true;
    if (session.collectedEmbeddings.length > 0) {
      const centroid = computeCentroid(session.collectedEmbeddings);
      if (centroid && cosineSimilarity(emb, centroid) < 0.28) {
        consistent = false;
      }
    }
    if (consistent && session.mode === 'append' && params.existingProfile && params.existingProfile.dim === emb.length) {
      if (cosineSimilarity(emb, params.existingProfile.centroid) < 0.28) {
        consistent = false;
      }
    }

    if (!consistent) {
      session.retryCount++;
      session.emptyRetryCount = 0;
      if (session.retryCount > 4) {
        this.active.delete(k);
        const prompt = '多次采集到的音色差异过大，已退出声纹录入。';
        const snap: XiaoaiEnrollSessionSnapshot = {
          ...this.toSnapshot(session),
          status: 'failed',
          error: prompt,
          message: prompt,
          updatedAt: now,
        };
        this.saveHistory(snap);
        return { outcome: 'failed', prompt, snapshot: snap };
      }
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = '这句话和前面音色不太一致，可能是电视或他人干扰，请本人清晰再说一句。';
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'retry', prompt, snapshot: snap };
    }

    session.collectedEmbeddings.push(emb);
    session.retryCount = 0;
    session.emptyRetryCount = 0;
    session.updatedAt = now;
    session.expiresAt = now + this.stepTtlMs;

    if (session.collectedEmbeddings.length < session.totalSteps) {
      session.step = session.collectedEmbeddings.length + 1;
      const prompt = buildStepPrompt(session.step, session.totalSteps, session.speakerName, session.mode);
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'next_step', prompt, snapshot: snap };
    }

    return {
      outcome: 'ready_to_save',
      embeddings: [...session.collectedEmbeddings],
      session: this.toSnapshot(session),
    };
  }

  completeSession(sessionId: string, profileId: string, message: string): XiaoaiEnrollSessionSnapshot | undefined {
    for (const [k, session] of this.active.entries()) {
      if (session.sessionId !== sessionId) continue;
      this.active.delete(k);
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'completed',
        step: session.totalSteps,
        message,
        profileId,
        updatedAt: Date.now(),
      };
      this.saveHistory(snap);
      return snap;
    }
    return undefined;
  }

  handleCaptureTimeoutOrEmpty(
    channelId: string,
    targetId: string,
    reason: 'timeout' | 'empty',
  ):
    | { action: 'inactive' }
    | { action: 'rearm'; speakHint?: string }
    | { action: 'cancelled'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot } {
    const k = this.key(channelId, targetId);
    if (!this.isActive(channelId, targetId)) {
      return { action: 'inactive' };
    }
    const session = this.active.get(k);
    if (!session) {
      return { action: 'inactive' };
    }
    if (session.status === 'preparing_model') {
      return { action: 'rearm' };
    }
    session.emptyRetryCount++;
    const now = Date.now();
    if (session.emptyRetryCount <= 2) {
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      this.saveHistory(this.toSnapshot(session));
      return {
        action: 'rearm',
        speakHint: reason === 'timeout' && session.emptyRetryCount === 1
          ? '我还在听，请直接说话，或说取消退出。'
          : undefined,
      };
    }
    this.active.delete(k);
    const prompt = '未检测到有效说话声，已退出声纹录入。';
    const snap: XiaoaiEnrollSessionSnapshot = {
      ...this.toSnapshot(session),
      status: 'cancelled',
      message: prompt,
      updatedAt: now,
    };
    this.saveHistory(snap);
    return { action: 'cancelled', prompt, snapshot: snap };
  }

  clear(): void {
    this.active.clear();
    this.history.clear();
  }
}
