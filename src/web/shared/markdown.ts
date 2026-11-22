import { tokenizeBotMessageText, type BotExpression } from './bot-expressions.js';
import { copyTextWithFeedback } from './ui-primitives.js';

export type TableAlign = 'left' | 'center' | 'right' | 'none';

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; code: string; closed: boolean }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: 'table'; headers: string[]; aligns: TableAlign[]; rows: string[][] }
  | { kind: 'hr' };

export interface MarkdownListItem {
  text: string;
  checked?: boolean;
  children?: MarkdownBlock[];
}

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; children: InlineToken[] }
  | { kind: 'italic'; children: InlineToken[] }
  | { kind: 'strike'; children: InlineToken[] }
  | { kind: 'link'; label: string; href: string };

export interface MarkdownRenderOptions {
  createEmote: (expr: BotExpression) => Node;
  createSticker: (expr: BotExpression) => Node;
  doc?: Document;
  onCopyCode?: (code: string, button: HTMLButtonElement) => void;
}

const CODE_COLLAPSE_LINE_THRESHOLD = 26;
const BARE_URL_PREFIX_RE = /^https?:\/\/[^\s<>"'\[\]（）【】《》「」『』、，。；：！？\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/i;
const BARE_URL_GLOBAL_RE = /https?:\/\/[^\s<>"'\[\]（）【】《》「」『』、，。；：！？\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/gi;

/**
 * Checks whether a URL uses an allowed safe protocol (`http:`, `https:`, or `mailto:`).
 */
export function isSafeUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAlignRow(line: string): TableAlign[] | undefined {
  if (!line.includes('|')) return undefined;
  const cells = splitTableRow(line);
  if (!cells.length) return undefined;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (!/^:?-{3,}:?$/.test(trimmed)) return undefined;
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : 'none');
  }
  return aligns;
}

function isHorizontalRule(line: string): boolean {
  return /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function matchFenceStart(line: string): { char: '`' | '~'; len: number; lang: string } | undefined {
  const match = /^\s*(`{3,}|~{3,})\s*([^\s`~]*).*$/.exec(line);
  if (!match) return undefined;
  const fence = match[1]!;
  const char = fence[0] as '`' | '~';
  return { char, len: fence.length, lang: (match[2] ?? '').trim() };
}

function isFenceEnd(line: string, char: '`' | '~', minLen: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minLen) return false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== char) return false;
  }
  return true;
}

function matchHeading(line: string): { level: 1 | 2 | 3 | 4; text: string } | undefined {
  const match = /^\s*(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
  if (!match) return undefined;
  return {
    level: match[1]!.length as 1 | 2 | 3 | 4,
    text: match[2]!,
  };
}

function matchListLine(line: string): { indent: number; ordered: boolean; start: number; text: string; checked?: boolean } | undefined {
  const unordered = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (unordered) {
    let body = unordered[2] ?? '';
    let checked: boolean | undefined;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (task) {
      checked = task[1]!.toLowerCase() === 'x';
      body = task[2] ?? '';
    }
    return {
      indent: unordered[1]!.replace(/\t/g, '  ').length,
      ordered: false,
      start: 1,
      text: body,
      ...(checked !== undefined ? { checked } : {}),
    };
  }
  const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
  if (ordered) {
    return {
      indent: ordered[1]!.replace(/\t/g, '  ').length,
      ordered: true,
      start: Number(ordered[2]),
      text: ordered[3] ?? '',
    };
  }
  return undefined;
}

function isBlockBoundary(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return true;
  if (matchFenceStart(line)) return true;
  if (isHorizontalRule(line)) return true;
  if (matchHeading(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (matchListLine(line)) return true;
  if (line.includes('|') && index + 1 < lines.length && parseTableAlignRow(lines[index + 1]!) !== undefined) {
    return true;
  }
  return false;
}

/**
 * Parses Markdown text into structured blocks without interpreting raw HTML.
 */
export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const normalized = input.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return [];
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = matchFenceStart(line);
    if (fence) {
      i++;
      const codeLines: string[] = [];
      let closed = false;
      while (i < lines.length) {
        if (isFenceEnd(lines[i]!, fence.char, fence.len)) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: 'code', lang: fence.lang, code: codeLines.join('\n'), closed });
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading.level, text: heading.text });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*> ?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', blocks: parseMarkdownBlocks(quoteLines.join('\n')) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableAlignRow(lines[i + 1]!);
      if (aligns) {
        const headers = splitTableRow(line);
        const colCount = Math.max(headers.length, aligns.length);
        while (headers.length < colCount) headers.push('');
        while (aligns.length < colCount) aligns.push('none');
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length) {
          const rowLine = lines[i]!;
          if (!rowLine.trim() || !rowLine.includes('|')) break;
          if (matchFenceStart(rowLine) || matchHeading(rowLine) || isHorizontalRule(rowLine) || /^\s*>/.test(rowLine)) break;
          const cells = splitTableRow(rowLine);
          while (cells.length < colCount) cells.push('');
          rows.push(cells.slice(0, colCount));
          i++;
        }
        blocks.push({ kind: 'table', headers: headers.slice(0, colCount), aligns, rows });
        continue;
      }
    }

    const firstList = matchListLine(line);
    if (firstList) {
      const baseIndent = firstList.indent;
      const ordered = firstList.ordered;
      const start = firstList.start;
      const items: MarkdownListItem[] = [];

      while (i < lines.length) {
        const current = matchListLine(lines[i]!);
        if (!current) break;
        if (current.indent > baseIndent + 1 && items.length > 0) {
          const nestedLines: string[] = [];
          while (i < lines.length) {
            const sub = matchListLine(lines[i]!);
            if (sub && sub.indent > baseIndent + 1) {
              nestedLines.push(lines[i]!.slice(Math.min(lines[i]!.length, baseIndent + 2)));
              i++;
            } else if (!lines[i]!.trim() && i + 1 < lines.length) {
              const peek = matchListLine(lines[i + 1]!);
              if (peek && peek.indent > baseIndent + 1) {
                nestedLines.push('');
                i++;
              } else {
                break;
              }
            } else {
              break;
            }
          }
          const lastItem = items[items.length - 1]!;
          const nested = parseMarkdownBlocks(nestedLines.join('\n'));
          if (nested.length) {
            lastItem.children = [...(lastItem.children ?? []), ...nested];
          }
          continue;
        }
        if (current.indent < baseIndent || current.ordered !== ordered) break;

        const textLines = [current.text];
        i++;
        while (i < lines.length) {
          const nextLine = lines[i]!;
          if (!nextLine.trim()) break;
          if (matchListLine(nextLine)) break;
          if (matchFenceStart(nextLine) || matchHeading(nextLine) || isHorizontalRule(nextLine) || /^\s*>/.test(nextLine)) break;
          if (/^\s{2,}\S/.test(nextLine)) {
            textLines.push(nextLine.trim());
            i++;
          } else {
            break;
          }
        }
        items.push({
          text: textLines.join('\n'),
          ...(current.checked !== undefined ? { checked: current.checked } : {}),
        });
        if (i < lines.length && !lines[i]!.trim()) {
          const nextNonEmpty = lines[i + 1];
          const nextItem = nextNonEmpty ? matchListLine(nextNonEmpty) : undefined;
          if (nextItem && nextItem.indent >= baseIndent && nextItem.ordered === ordered) {
            i++;
            continue;
          }
          break;
        }
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && !isBlockBoundary(lines, i)) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

function pushInlineText(tokens: InlineToken[], text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === 'text') {
    last.text += text;
  } else {
    tokens.push({ kind: 'text', text });
  }
}

function trimBareUrlTrailing(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';
  while (url.length > 0) {
    const ch = url[url.length - 1]!;
    if (/[.,;:!?。，；：！？、》」』】'"\u201d\u2019]/.test(ch)) {
      trailing = ch + trailing;
      url = url.slice(0, -1);
      continue;
    }
    if (ch === ')' || ch === '）') {
      const openChar = ch === ')' ? '(' : '（';
      let opens = 0;
      let closes = 0;
      for (const c of url) {
        if (c === openChar) opens++;
        else if (c === ch) closes++;
      }
      if (closes > opens) {
        trailing = ch + trailing;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return { url, trailing };
}

function findMatchingDelimiter(input: string, start: number, marker: string): number {
  let cursor = start;
  while (cursor <= input.length - marker.length) {
    if (input[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (input[cursor] === '`') {
      let tickLen = 0;
      while (input[cursor + tickLen] === '`') tickLen++;
      const closeTick = input.indexOf('`'.repeat(tickLen), cursor + tickLen);
      if (closeTick !== -1) {
        cursor = closeTick + tickLen;
        continue;
      }
    }
    if (input.startsWith(marker, cursor)) {
      const inner = input.slice(start, cursor);
      if (inner.length > 0 && !/^\s|\s$/.test(inner)) {
        if (marker === '*' && input.startsWith('**', cursor)) {
          cursor += 2;
          continue;
        }
        return cursor;
      }
    }
    cursor++;
  }
  return -1;
}

/**
 * Parses inline Markdown tokens (code, links, safe bare URLs, bold, italic, strikethrough) safely.
 */
export function parseInlineTokens(input: string, depth = 0): InlineToken[] {
  if (!input) return [];
  if (depth > 8) return [{ kind: 'text', text: input }];

  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // Escaped punctuation
    if (ch === '\\' && i + 1 < input.length && /[\\`*_{}[\]()#+\-.!~|]/.test(input[i + 1]!)) {
      pushInlineText(tokens, input[i + 1]!);
      i += 2;
      continue;
    }

    // Inline code span
    if (ch === '`') {
      let tickLen = 0;
      while (input[i + tickLen] === '`') tickLen++;
      const fence = '`'.repeat(tickLen);
      const closeIdx = input.indexOf(fence, i + tickLen);
      if (closeIdx !== -1 && input[closeIdx - 1] !== '`') {
        let codeText = input.slice(i + tickLen, closeIdx);
        if (codeText.length >= 2 && codeText.startsWith(' ') && codeText.endsWith(' ') && codeText.trim().length > 0) {
          codeText = codeText.slice(1, -1);
        }
        tokens.push({ kind: 'code', text: codeText });
        i = closeIdx + tickLen;
        continue;
      }
    }

    // Never emit <img> for Markdown image syntax ![alt](url); keep readable literal text
    if (ch === '!' && input[i + 1] === '[') {
      const imgMatch = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(input.slice(i));
      if (imgMatch) {
        const alt = imgMatch[1]!.trim();
        pushInlineText(tokens, alt ? `[图片: ${alt}]` : imgMatch[0]);
        i += imgMatch[0].length;
        continue;
      }
    }

    // Markdown link [label](url)
    if (ch === '[') {
      const linkMatch = /^\[([^\[\]\n]+)\]\(\s*<?([^>\s)\n]+)>?(?:\s+"[^"]*")?\s*\)/.exec(input.slice(i));
      if (linkMatch) {
        const label = linkMatch[1]!;
        const href = linkMatch[2]!;
        if (isSafeUrl(href)) {
          tokens.push({ kind: 'link', label, href });
          i += linkMatch[0].length;
          continue;
        }
      }
    }

    // Bare http(s):// URL autolink
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(input.slice(i))) {
      const prev = i > 0 ? input[i - 1]! : '';
      if (!prev || /[\s(（\[【<"'：:，,。；;]/.test(prev)) {
        const rawMatch = BARE_URL_PREFIX_RE.exec(input.slice(i));
        if (rawMatch) {
          const { url, trailing } = trimBareUrlTrailing(rawMatch[0]);
          if (isSafeUrl(url)) {
            tokens.push({ kind: 'link', label: url, href: url });
            if (trailing) pushInlineText(tokens, trailing);
            i += rawMatch[0].length;
            continue;
          }
        }
      }
    }

    // Bold **...**
    if (input.startsWith('**', i)) {
      const closeIdx = findMatchingDelimiter(input, i + 2, '**');
      if (closeIdx !== -1) {
        tokens.push({ kind: 'bold', children: parseInlineTokens(input.slice(i + 2, closeIdx), depth + 1) });
        i = closeIdx + 2;
        continue;
      }
    }

    // Strikethrough ~~...~~
    if (input.startsWith('~~', i)) {
      const closeIdx = findMatchingDelimiter(input, i + 2, '~~');
      if (closeIdx !== -1) {
        tokens.push({ kind: 'strike', children: parseInlineTokens(input.slice(i + 2, closeIdx), depth + 1) });
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic *...* (intentionally avoids _..._ so snake_case symbols stay untouched)
    if (ch === '*' && input[i + 1] !== '*') {
      const closeIdx = findMatchingDelimiter(input, i + 1, '*');
      if (closeIdx !== -1) {
        tokens.push({ kind: 'italic', children: parseInlineTokens(input.slice(i + 1, closeIdx), depth + 1) });
        i = closeIdx + 1;
        continue;
      }
    }

    pushInlineText(tokens, ch);
    i++;
  }

  return tokens;
}

function appendTextWithBotEmotes(parent: Node, text: string, opts: MarkdownRenderOptions, doc: Document): void {
  const parts = text.split('\n');
  for (let lineIdx = 0; lineIdx < parts.length; lineIdx++) {
    if (lineIdx > 0) parent.appendChild(doc.createElement('br'));
    const segment = parts[lineIdx]!;
    if (!segment) continue;
    const botTokens = tokenizeBotMessageText(segment);
    if (!botTokens.length) {
      parent.appendChild(doc.createTextNode(segment));
      continue;
    }
    for (const token of botTokens) {
      if (token.kind === 'text') {
        parent.appendChild(doc.createTextNode(token.value));
      } else if (token.kind === 'emote') {
        parent.appendChild(opts.createEmote(token.expr));
      } else {
        parent.appendChild(opts.createSticker(token.expr));
      }
    }
  }
}

function appendInlineDom(parent: Node, tokens: readonly InlineToken[], opts: MarkdownRenderOptions, doc: Document): void {
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        appendTextWithBotEmotes(parent, token.text, opts, doc);
        break;
      case 'code': {
        const codeEl = doc.createElement('code');
        codeEl.className = 'md-inline-code';
        codeEl.textContent = token.text;
        parent.appendChild(codeEl);
        break;
      }
      case 'bold': {
        const el = doc.createElement('strong');
        appendInlineDom(el, token.children, opts, doc);
        parent.appendChild(el);
        break;
      }
      case 'italic': {
        const el = doc.createElement('em');
        appendInlineDom(el, token.children, opts, doc);
        parent.appendChild(el);
        break;
      }
      case 'strike': {
        const el = doc.createElement('del');
        appendInlineDom(el, token.children, opts, doc);
        parent.appendChild(el);
        break;
      }
      case 'link': {
        const a = doc.createElement('a');
        a.className = 'md-link';
        a.href = token.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = token.label;
        parent.appendChild(a);
        break;
      }
    }
  }
}

function defaultCopyCode(code: string, btn: HTMLButtonElement, statusEl?: HTMLElement | null): void {
  void copyTextWithFeedback(btn, code, {
    statusEl,
    successLabel: '✓ 已复制',
    failLabel: '复制失败',
    defaultLabel: '复制',
  });
}

function renderBlocksInto(container: Node, blocks: readonly MarkdownBlock[], opts: MarkdownRenderOptions, doc: Document): void {
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const domLevel = Math.min(6, block.level + 2) as 3 | 4 | 5 | 6;
        const tag = `h${domLevel}` as 'h3' | 'h4' | 'h5' | 'h6';
        const h = doc.createElement(tag);
        h.className = `md-h md-h${block.level}`;
        appendInlineDom(h, parseInlineTokens(block.text), opts, doc);
        container.appendChild(h);
        break;
      }
      case 'paragraph': {
        const p = doc.createElement('p');
        p.className = 'md-p';
        appendInlineDom(p, parseInlineTokens(block.text), opts, doc);
        container.appendChild(p);
        break;
      }
      case 'hr': {
        const hr = doc.createElement('hr');
        hr.className = 'md-hr';
        container.appendChild(hr);
        break;
      }
      case 'quote': {
        const q = doc.createElement('blockquote');
        q.className = 'md-quote';
        renderBlocksInto(q, block.blocks, opts, doc);
        container.appendChild(q);
        break;
      }
      case 'list': {
        const listEl = doc.createElement(block.ordered ? 'ol' : 'ul');
        listEl.className = block.ordered ? 'md-list md-ol' : 'md-list md-ul';
        if (block.ordered && block.start !== 1) {
          (listEl as HTMLOListElement).start = block.start;
        }
        for (const item of block.items) {
          const li = doc.createElement('li');
          li.className = item.checked !== undefined ? 'md-li md-task-li' : 'md-li';
          if (item.checked !== undefined) {
            const box = doc.createElement('span');
            box.className = `md-task-box${item.checked ? ' checked' : ''}`;
            box.setAttribute('aria-hidden', 'true');
            box.textContent = item.checked ? '✓' : '';
            li.appendChild(box);
            const srState = doc.createElement('span');
            srState.className = 'visually-hidden';
            srState.textContent = item.checked ? '已完成 ' : '未完成 ';
            li.appendChild(srState);
          }
          const bodySpan = doc.createElement('span');
          bodySpan.className = 'md-li-body';
          appendInlineDom(bodySpan, parseInlineTokens(item.text), opts, doc);
          li.appendChild(bodySpan);
          if (item.children?.length) {
            renderBlocksInto(li, item.children, opts, doc);
          }
          listEl.appendChild(li);
        }
        container.appendChild(listEl);
        break;
      }
      case 'table': {
        const wrap = doc.createElement('div');
        wrap.className = 'md-table-wrap';
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', '数据表');
        const table = doc.createElement('table');
        table.className = 'md-table';
        const thead = doc.createElement('thead');
        const headTr = doc.createElement('tr');
        for (let col = 0; col < block.headers.length; col++) {
          const th = doc.createElement('th');
          th.setAttribute('scope', 'col');
          const align = block.aligns[col] ?? 'none';
          if (align !== 'none') th.className = `align-${align}`;
          appendInlineDom(th, parseInlineTokens(block.headers[col] ?? ''), opts, doc);
          headTr.appendChild(th);
        }
        thead.appendChild(headTr);
        table.appendChild(thead);

        if (block.rows.length) {
          const tbody = doc.createElement('tbody');
          for (const row of block.rows) {
            const tr = doc.createElement('tr');
            for (let col = 0; col < block.headers.length; col++) {
              const td = doc.createElement('td');
              const align = block.aligns[col] ?? 'none';
              if (align !== 'none') td.className = `align-${align}`;
              appendInlineDom(td, parseInlineTokens(row[col] ?? ''), opts, doc);
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
        }
        wrap.appendChild(table);
        container.appendChild(wrap);
        break;
      }
      case 'code': {
        const lineCount = block.code ? block.code.split('\n').length : 0;
        const collapsible = lineCount > CODE_COLLAPSE_LINE_THRESHOLD;
        const shell = doc.createElement('div');
        shell.className = `md-code-block${collapsible ? ' is-collapsible' : ''}`;

        const head = doc.createElement('div');
        head.className = 'md-code-head';
        const langEl = doc.createElement('span');
        langEl.className = 'md-code-lang';
        langEl.textContent = block.lang || '代码';
        const metaEl = doc.createElement('span');
        metaEl.className = 'md-code-lines meta';
        metaEl.textContent = block.closed ? `${lineCount} 行` : `${lineCount} 行 · 输出中`;

        const codeLabel = `${block.lang || '代码'}代码块`;
        const copyWrap = doc.createElement('span');
        copyWrap.className = 'md-copy-wrap';
        const copyBtn = doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'md-code-copy mini-button';
        copyBtn.textContent = '复制';
        copyBtn.setAttribute('aria-label', `复制${codeLabel}`);
        const copyStatus = doc.createElement('span');
        copyStatus.className = 'md-copy-status visually-hidden';
        copyStatus.setAttribute('role', 'status');
        copyBtn.addEventListener('click', () => {
          if (opts.onCopyCode) opts.onCopyCode(block.code, copyBtn);
          else defaultCopyCode(block.code, copyBtn, copyStatus);
        });
        copyWrap.appendChild(copyBtn);
        copyWrap.appendChild(copyStatus);

        const headLeft = doc.createElement('div');
        headLeft.className = 'md-code-head-left';
        headLeft.appendChild(langEl);
        headLeft.appendChild(metaEl);
        head.appendChild(headLeft);
        head.appendChild(copyWrap);

        const pre = doc.createElement('pre');
        pre.className = 'md-code-pre';
        pre.setAttribute('tabindex', '0');
        pre.setAttribute('role', 'region');
        pre.setAttribute('aria-label', codeLabel);
        const codeEl = doc.createElement('code');
        codeEl.className = 'md-code';
        codeEl.textContent = block.code;
        pre.appendChild(codeEl);

        shell.appendChild(head);
        shell.appendChild(pre);

        if (collapsible) {
          const toggleBtn = doc.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'md-code-expand-btn mini-button';
          toggleBtn.setAttribute('aria-expanded', 'false');
          toggleBtn.textContent = `展开全部 ${lineCount} 行`;
          toggleBtn.addEventListener('click', () => {
            const expanded = shell.classList.toggle('is-expanded');
            toggleBtn.setAttribute('aria-expanded', String(expanded));
            toggleBtn.textContent = expanded ? '收起代码' : `展开全部 ${lineCount} 行`;
          });
          shell.appendChild(toggleBtn);
        }

        container.appendChild(shell);
        break;
      }
    }
  }
}

/**
 * Safely renders assistant Markdown text into pure DOM nodes (no HTML parsing, no img tags, safe links, bot emotes).
 */
export function renderMarkdownContent(text: string, opts: MarkdownRenderOptions): DocumentFragment {
  const doc = opts.doc ?? document;
  const frag = doc.createDocumentFragment();
  const blocks = parseMarkdownBlocks(text);
  if (!blocks.length && text) {
    const p = doc.createElement('p');
    p.className = 'md-p';
    appendTextWithBotEmotes(p, text, opts, doc);
    frag.appendChild(p);
    return frag;
  }
  renderBlocksInto(frag, blocks, opts, doc);
  return frag;
}

/**
 * Renders user message content preserving exact line breaks while linking safe bare URLs and rendering bot emotes.
 */
export function renderUserMessageContent(text: string, opts: MarkdownRenderOptions): DocumentFragment {
  const doc = opts.doc ?? document;
  const frag = doc.createDocumentFragment();
  if (!text) return frag;

  BARE_URL_GLOBAL_RE.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_URL_GLOBAL_RE.exec(text)) !== null) {
    if (match.index > last) {
      appendTextWithBotEmotes(frag, text.slice(last, match.index), opts, doc);
    }
    const { url, trailing } = trimBareUrlTrailing(match[0]);
    if (isSafeUrl(url)) {
      const a = doc.createElement('a');
      a.className = 'md-link';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url;
      frag.appendChild(a);
      if (trailing) appendTextWithBotEmotes(frag, trailing, opts, doc);
    } else {
      appendTextWithBotEmotes(frag, match[0], opts, doc);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    appendTextWithBotEmotes(frag, text.slice(last), opts, doc);
  }
  return frag;
}
