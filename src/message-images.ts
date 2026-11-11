import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { imageMime, MEDIA_LIMIT, type ReceivedAttachment } from './wechat-inbound.js';

/** Only current-message attachments enter model content; history remains metadata-only. */
export async function messageImages(text: string, supportsImages: boolean) {
  let event: { kind?: string; message?: { attachments?: ReceivedAttachment[] } };
  try { event = JSON.parse(text); } catch { return { text, images: [] }; }
  if (event.kind !== 'CHAT') return { text, images: [] };
  const attachments = event.message?.attachments ?? [];
  const images: { type: 'image'; data: string; mimeType: string }[] = [];
  const notes: string[] = [];
  for (const attachment of attachments.slice(0, 4)) {
    if (attachment.kind !== 'image' || attachment.status !== 'ready' || !attachment.path) continue;
    if (!supportsImages) { notes.push('当前模型配置不支持图像输入；图片已保存，但本轮不能看图。不可声称已看到图片内容。'); continue; }
    try {
      const file = await open(attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MEDIA_LIMIT || stat.size !== attachment.bytes) throw new Error('Invalid image');
        const bytes = await file.readFile();
        const mimeType = imageMime(bytes);
        if (!mimeType || mimeType !== attachment.mimeType) throw new Error('Invalid image');
        images.push({ type: 'image', data: bytes.toString('base64'), mimeType });
      } finally { await file.close(); }
    } catch { notes.push('图片读取失败；不可声称已看到图片。'); }
  }
  return { text: text + (notes.length ? '\nHOST_MEDIA_STATUS\n' + notes.join('\n') : ''), images };
}
