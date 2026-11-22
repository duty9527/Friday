import type { AttachmentView } from '../view.js';
import type { Role } from './prompts.js';

const ROUTER_TRANSIENT_EVENT_KINDS = new Set([
  'CHAT',
  'WORKER_REPORT',
  'WORKER_QUESTION',
  'WORKER_FAILED',
]);

export function compactHostEventText(text: string, isHistorical: boolean): string {
  if (!text.startsWith('HOST_EVENT\n')) return text;
  try {
    const parsed = JSON.parse(text.slice('HOST_EVENT\n'.length)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
    let mutated = false;

    if (
      parsed.kind === 'CHAT'
      && parsed.message
      && typeof parsed.message === 'object'
      && !Array.isArray(parsed.message)
      && 'routing' in (parsed.message as Record<string, unknown>)
    ) {
      delete (parsed.message as Record<string, unknown>).routing;
      mutated = true;
    }

    if (isHistorical) {
      const msg = parsed.message as Record<string, unknown> | undefined;
      if (msg && Array.isArray(msg.attachments)) {
        const paths = new Set(
          (msg.attachments as AttachmentView[])
            .map(item => item.path)
            .filter((p): p is string => typeof p === 'string' && p.length > 0),
        );
        msg.paths = ((msg.paths as string[] | undefined) ?? []).filter((path: string) => !paths.has(path));
        msg.attachments = (msg.attachments as AttachmentView[]).map(
          ({ path: _path, ...metadata }) => metadata,
        );
        mutated = true;
      }

      if (typeof parsed.kind === 'string' && ROUTER_TRANSIENT_EVENT_KINDS.has(parsed.kind)) {
        for (const key of [
          'works',
          'memoryDirectory',
          'autoRecalled',
          'context',
          'imChannels',
          'voiceModeConstraint',
          'subconscious',
          'qualityGate',
          'autoDispatchesRemaining',
          'execution',
          'cwd',
        ]) {
          if (key in parsed) {
            delete parsed[key];
            mutated = true;
          }
        }
        if (typeof parsed.report === 'string' && parsed.report.length > 600) {
          parsed.report = `${parsed.report.slice(0, 599)}…`;
          mutated = true;
        }
      }
    }

    return mutated ? `HOST_EVENT\n${JSON.stringify(parsed)}` : text;
  } catch {
    return text;
  }
}

export const ROUTER_CONTEXT_KEEP_MAX = 24;
export const ROUTER_CONTEXT_PRUNE_STEP = 24;
export const ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS = 480;
export const ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS = 600;
export const ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS = 360;

const TOOL_RESULT_COMPACT_SUFFIX = '…[historical tool output compacted]';
const ASSISTANT_TEXT_COMPACT_SUFFIX = '…[historical reply compacted]';

function truncateWithSuffix(value: string, maxChars: number, suffix: string): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= suffix.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactValueByLimit(value: unknown, strLimit: number, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length <= strLimit ? value : truncateWithSuffix(value, strLimit, '…');
  }
  if (Array.isArray(value)) {
    const cap = depth >= 2 ? 3 : 8;
    const itemLimit = depth >= 2 ? Math.min(strLimit, 60) : strLimit;
    return value.slice(0, cap).map(item => compactValueByLimit(item, itemLimit, depth + 1));
  }
  if (isPlainRecord(value)) {
    if (depth >= 3) {
      return { _compacted: truncateWithSuffix(JSON.stringify(value), Math.min(strLimit, 80), '…') };
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = compactValueByLimit(item, strLimit, depth + 1);
    }
    return out;
  }
  return value;
}

function compactPlainObjectToBudget(obj: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  for (const limit of [180, 96, 48, 24]) {
    const candidate = compactValueByLimit(obj, limit) as Record<string, unknown>;
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }
  const priorityKeys = new Set([
    'action', 'plugin', 'pluginAction', 'taskId', 'id', 'name',
    'topic', 'query', 'channel', 'cwd', 'profile', 'instruction', 'input',
  ]);
  const entries = Object.entries(obj);
  const prioritized = entries.filter(([key]) => priorityKeys.has(key)).slice(0, 6);
  const kept = prioritized.length > 0 ? prioritized : entries.slice(0, 4);
  for (const limit of [48, 24]) {
    const subset: Record<string, unknown> = {};
    for (const [key, val] of kept) subset[key] = compactValueByLimit(val, limit);
    if (entries.length > kept.length) subset._omittedKeys = entries.length - kept.length;
    if (JSON.stringify(subset).length <= maxChars) return subset;
  }
  const raw = JSON.stringify(obj);
  let sliceLen = Math.max(8, maxChars - 24);
  while (sliceLen > 4) {
    const fallback = { _compacted: truncateWithSuffix(raw, sliceLen, '…') };
    if (JSON.stringify(fallback).length <= maxChars) return fallback;
    sliceLen = Math.floor(sliceLen * 0.7);
  }
  return { _compacted: '…' };
}

function compactToolCallArguments(
  args: unknown,
  maxChars = ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS,
): { changed: boolean; value: unknown } {
  if (typeof args === 'string') {
    if (args.length <= maxChars) return { changed: false, value: args };
    try {
      const parsed: unknown = JSON.parse(args);
      if (isPlainRecord(parsed)) {
        const compacted = JSON.stringify(compactPlainObjectToBudget(parsed, maxChars));
        if (compacted.length <= maxChars) return { changed: true, value: compacted };
      }
    } catch { /* treat as raw string */ }
    let fallbackLen = Math.max(4, maxChars - 20);
    while (fallbackLen >= 0) {
      const candidate = JSON.stringify({ _compacted: truncateWithSuffix(args, fallbackLen, '…') });
      if (candidate.length <= maxChars || fallbackLen === 0) {
        return { changed: true, value: candidate };
      }
      fallbackLen = Math.floor(fallbackLen * 0.6);
    }
    return { changed: true, value: JSON.stringify({ _compacted: '…' }) };
  }
  if (!isPlainRecord(args)) return { changed: false, value: args };
  const serialized = JSON.stringify(args);
  if (serialized.length <= maxChars) return { changed: false, value: args };

  if (typeof args.input === 'string') {
    const { input: rawInput, ...rest } = args;
    const hasRest = Object.keys(rest).length > 0;
    const restBudget = Math.min(120, Math.max(24, Math.floor(maxChars * 0.3)));
    const compactedRest = hasRest
      ? (JSON.stringify(rest).length <= restBudget ? rest : compactPlainObjectToBudget(rest, restBudget))
      : {};

    const fitStructuredInner = (
      innerObj: Record<string, unknown>,
      extra: Record<string, unknown>,
    ): Record<string, unknown> | undefined => {
      const extraOverhead = Object.keys(extra).length > 0 ? JSON.stringify(extra).length : 0;
      let budget = Math.max(24, maxChars - extraOverhead - 24);
      for (let attempt = 0; attempt < 8 && budget >= 16; attempt++) {
        const candidate = { input: JSON.stringify(compactPlainObjectToBudget(innerObj, budget)), ...extra };
        if (JSON.stringify(candidate).length <= maxChars) {
          return candidate;
        }
        budget = Math.floor(budget * 0.7);
      }
      const minimal = { input: JSON.stringify({ _compacted: '…' }), ...extra };
      return JSON.stringify(minimal).length <= maxChars ? minimal : undefined;
    };

    try {
      const inner: unknown = JSON.parse(rawInput.trim());
      if (isPlainRecord(inner)) {
        const fitted = fitStructuredInner(inner, compactedRest) ?? (hasRest ? fitStructuredInner(inner, {}) : undefined);
        return { changed: true, value: fitted ?? { input: '{}' } };
      }
    } catch { /* raw or malformed input string */ }

    const fitWrappedCompacted = (extra: Record<string, unknown>): Record<string, unknown> | undefined => {
      const extraOverhead = Object.keys(extra).length > 0 ? JSON.stringify(extra).length : 0;
      let sliceLen = Math.max(8, maxChars - extraOverhead - 40);
      while (sliceLen >= 0) {
        const candidate = {
          input: JSON.stringify({ _compacted: truncateWithSuffix(rawInput, sliceLen, '…') }),
          ...extra,
        };
        if (JSON.stringify(candidate).length <= maxChars) {
          return candidate;
        }
        if (sliceLen === 0) break;
        sliceLen = Math.floor(sliceLen * 0.6);
      }
      return undefined;
    };

    const fitPlainInput = (extra: Record<string, unknown>): Record<string, unknown> | undefined => {
      const extraOverhead = Object.keys(extra).length > 0 ? JSON.stringify(extra).length : 0;
      let sliceLen = Math.max(8, maxChars - extraOverhead - 20);
      while (sliceLen > 4) {
        const candidate = { input: truncateWithSuffix(rawInput, sliceLen, '…'), ...extra };
        if (JSON.stringify(candidate).length <= maxChars) {
          return candidate;
        }
        sliceLen = Math.floor(sliceLen * 0.7);
      }
      return undefined;
    };

    const trimmedInput = rawInput.trimStart();
    if (trimmedInput.startsWith('{') || trimmedInput.startsWith('[')) {
      const fitted = fitWrappedCompacted(compactedRest) ?? (hasRest ? fitWrappedCompacted({}) : undefined);
      return { changed: true, value: fitted ?? { input: '{}' } };
    }

    const fitted = fitPlainInput(compactedRest) ?? (hasRest ? fitPlainInput({}) : undefined);
    return { changed: true, value: fitted ?? { input: '…' } };
  }

  return { changed: true, value: compactPlainObjectToBudget(args, maxChars) };
}

export function isHostEventUserMessage(msg: { role?: string; content?: unknown } | undefined): boolean {
  if (!msg || msg.role !== 'user') return false;
  if (typeof msg.content === 'string') return msg.content.startsWith('HOST_EVENT\n');
  if (Array.isArray(msg.content)) {
    return msg.content.some(block =>
      Boolean(
        block
        && typeof block === 'object'
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
        && (block as { text: string }).text.startsWith('HOST_EVENT\n'),
      ),
    );
  }
  return false;
}

export function pruneRouterContextMessages<T extends { role?: string; content?: unknown }>(
  messages: T[],
  options?: { keepMax?: number; step?: number },
): T[] {
  const keepMax = Math.max(1, options?.keepMax ?? ROUTER_CONTEXT_KEEP_MAX);
  const step = Math.max(1, options?.step ?? ROUTER_CONTEXT_PRUNE_STEP);
  if (messages.length <= keepMax + step) return messages;

  const rawDrop = Math.floor((messages.length - keepMax) / step) * step;
  if (rawDrop <= 0) return messages;

  const maxForward = Math.min(messages.length - 1, rawDrop + step);
  let startIdx = -1;
  for (let i = rawDrop; i <= maxForward; i++) {
    if (isHostEventUserMessage(messages[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    for (let i = Math.min(rawDrop - 1, messages.length - 1); i >= 0; i--) {
      if (isHostEventUserMessage(messages[i])) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) {
    for (let i = maxForward + 1; i < messages.length; i++) {
      if (isHostEventUserMessage(messages[i])) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx <= 0) return messages;

  const preservedSystem = messages.slice(0, startIdx).filter(msg => msg.role === 'system');
  return preservedSystem.length > 0
    ? [...preservedSystem, ...messages.slice(startIdx)]
    : messages.slice(startIdx);
}

const ZERO_HISTORICAL_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function transformAgentContextMessages<T extends { role?: string; content?: unknown }>(
  messages: T[],
  role: Role = 'worker',
): T[] {
  const working = role === 'router' ? pruneRouterContextMessages(messages) : messages;
  const lastUser = working.findLastIndex(message => message.role === 'user');
  return working.map((message, index): T => {
    const isHistorical = index < lastUser;

    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (!message.content.startsWith('HOST_EVENT\n')) return message;
        const compacted = compactHostEventText(message.content, isHistorical);
        return compacted === message.content ? message : ({ ...message, content: compacted } as T);
      }
      if (!Array.isArray(message.content)) return message;
      const blocks = message.content as Array<{ type?: string; text?: string }>;
      const filtered = isHistorical ? blocks.filter(block => block?.type !== 'image') : blocks;
      let changed = filtered.length !== blocks.length;
      const mapped = filtered.map(block => {
        if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith('HOST_EVENT\n')) {
          return block;
        }
        const compacted = compactHostEventText(block.text, isHistorical);
        if (compacted === block.text) return block;
        changed = true;
        return { ...block, text: compacted };
      });
      return changed ? ({ ...message, content: mapped } as T) : message;
    }

    if (role !== 'router' || !isHistorical) {
      return message;
    }

    if (message.role === 'toolResult' && Array.isArray(message.content)) {
      const blocks = message.content as Array<{ type?: string; text?: string }>;
      let changed = false;
      const mapped = blocks.map(block => {
        if (
          block?.type === 'text'
          && typeof block.text === 'string'
          && block.text.length > ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS
        ) {
          changed = true;
          return {
            ...block,
            text: truncateWithSuffix(block.text, ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS, TOOL_RESULT_COMPACT_SUFFIX),
          };
        }
        return block;
      });
      return changed ? ({ ...message, content: mapped } as T) : message;
    }

    if (message.role === 'assistant') {
      const msgUsage = (message as { usage?: unknown }).usage as
        | { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
        | undefined;
      const hasNonZeroUsage = Boolean(
        msgUsage
        && typeof msgUsage === 'object'
        && (msgUsage.totalTokens || msgUsage.input || msgUsage.output || msgUsage.cacheRead || msgUsage.cacheWrite),
      );
      if (typeof message.content === 'string') {
        const textChanged = message.content.length > ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS;
        if (!textChanged && !hasNonZeroUsage) return message;
        return {
          ...message,
          ...(textChanged
            ? {
                content: truncateWithSuffix(
                  message.content,
                  ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS,
                  ASSISTANT_TEXT_COMPACT_SUFFIX,
                ),
              }
            : {}),
          ...(hasNonZeroUsage
            ? { usage: { ...ZERO_HISTORICAL_USAGE, cost: { ...ZERO_HISTORICAL_USAGE.cost } } }
            : {}),
        } as T;
      }

      const blocks = Array.isArray(message.content)
        ? (message.content as Array<{ type?: string; text?: string; arguments?: unknown }>)
        : undefined;
      const hasThinking = blocks ? blocks.some(block => block?.type === 'thinking') : false;
      const hasOtherNonEmpty = blocks
        ? blocks.some(
            block =>
              block?.type === 'toolCall'
              || (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0),
          )
        : false;
      let contentChanged = false;
      let nextContent: Array<{ type?: string; text?: string; arguments?: unknown }> | undefined;
      if (blocks) {
        const baseBlocks = hasThinking && hasOtherNonEmpty
          ? blocks.filter(block => block?.type !== 'thinking')
          : blocks;
        if (baseBlocks.length !== blocks.length) contentChanged = true;
        const mappedBlocks = baseBlocks.map(block => {
          if (
            block?.type === 'text'
            && typeof block.text === 'string'
            && block.text.length > ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS
          ) {
            contentChanged = true;
            return {
              ...block,
              text: truncateWithSuffix(
                block.text,
                ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS,
                ASSISTANT_TEXT_COMPACT_SUFFIX,
              ),
            };
          }
          if (block?.type === 'toolCall') {
            const compacted = compactToolCallArguments(block.arguments, ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS);
            if (compacted.changed) {
              contentChanged = true;
              return { ...block, arguments: compacted.value };
            }
          }
          return block;
        });
        if (contentChanged) nextContent = mappedBlocks;
      }
      if (!nextContent && !hasNonZeroUsage) return message;
      return {
        ...message,
        ...(nextContent ? { content: nextContent } : {}),
        ...(hasNonZeroUsage
          ? { usage: { ...ZERO_HISTORICAL_USAGE, cost: { ...ZERO_HISTORICAL_USAGE.cost } } }
          : {}),
      } as T;
    }

    return message;
  });
}
