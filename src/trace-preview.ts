import { publicData } from './conversation.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function tracePreview(kind: 'input' | 'output', value: unknown): Record<string, unknown> {
  const safe = publicData(value);
  if (kind === 'input') {
    let args = object(safe);
    const raw = args.input;
    if (typeof raw === 'string') {
      try { args = object(JSON.parse(raw)); } catch { return { input: { input: raw.slice(0, 400) }, inputTruncated: raw.length > 400 }; }
    }
    const entries = Object.entries(args);
    let truncated = entries.length > 8;
    const input = Object.fromEntries(entries.slice(0, 8).map(([key, item]) => {
      const text = typeof item === 'string' ? item : JSON.stringify(item) ?? '—';
      if (text.length > 160) truncated = true;
      return [key, text.slice(0, 160)];
    }));
    return { input, inputTruncated: truncated };
  }
  const result = object(safe);
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter(item => object(item).type === 'text').map(item => String(object(item).text ?? ''));
  const text = typeof safe === 'string' ? safe : texts.length ? texts.join('\n') : JSON.stringify(safe) ?? '';
  const exitCode = object(result.details).exitCode;
  return { output: text.slice(0, 1600), outputTruncated: text.length > 1600,
    exitCode: typeof exitCode === 'number' ? exitCode : undefined };
}
export function boundedTraceData(value: unknown): unknown {
  const safe = publicData(value);
  const encoded = JSON.stringify(safe);
  return encoded && encoded.length > 3000 ? { preview: encoded.slice(0, 1500), truncated: true } : safe;
}
