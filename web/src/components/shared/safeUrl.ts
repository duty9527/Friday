export function isSafeHttpUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSafePreviewImageUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);/i.test(trimmed)) {
    return true;
  }
  return isSafeHttpUrl(trimmed);
}
