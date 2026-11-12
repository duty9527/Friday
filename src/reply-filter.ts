/**
 * Host-layer hygiene for text the Router speaks to the Boss. The prompt already forbids these, but the
 * Router model does not always comply, so the host strips them deterministically before delivery:
 * - task / record IDs (full UUIDs anywhere, and short prefixes of known task IDs);
 * - internal staging paths under the service home (wechat-files, inbound-media, tasks, sdk).
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STAGING_PATH = /`?(?:~|\/Users\/[^/\s`]+)\/\.super-agent\/(?:wechat-files|inbound-media|tasks|sdk)\b[^\s`，。；、,;)）]*`?/g;

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizePublicReply(text: string, knownTaskIds: string[] = []): string {
  if (!text) return text;
  const shortIds = [...new Set(knownTaskIds.map(id => id.slice(0, 8).toLowerCase()))].filter(id => /^[0-9a-f]{8}$/.test(id));
  const idAlternatives = [UUID, ...shortIds.map(escape)].join('|');
  const idToken = `\`?(?:${idAlternatives})\`?`;
  const label = '(?:任务|工作|task|work)?\\s*(?:ID|id)?\\s*[:：]?\\s*';
  let out = text
    // "（任务 `84eeec04`）" / "(`bff1861b`)" -> removed entirely
    .replace(new RegExp(`\\s*[（(]\\s*${label}${idToken}\\s*[）)]`, 'gi'), '')
    // "任务 `84eeec04`" -> "任务"
    .replace(new RegExp(`(任务|工作|task|work)\\s*(?:ID|id)?\\s*[:：]?\\s*${idToken}`, 'gi'), '$1')
    // any remaining full UUID
    .replace(new RegExp(`\`?${UUID}\`?`, 'gi'), '')
    .replace(STAGING_PATH, '本地');
  out = out
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。；：！？,.;:!?])/g, '$1');
  return out;
}
