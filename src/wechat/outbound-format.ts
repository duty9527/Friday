export const DEFAULT_WECHAT_CODE_FILE_CHARS = 1200;
export const DEFAULT_WECHAT_CHUNK_CHARS = 1500;

interface InlineAccumState {
  type: 'image' | 'bold3' | 'italic' | 'ubold3' | 'uitalic';
  acc: string;
}

/**
 * Character-level streaming Markdown filter ported from `@tencent-weixin/openclaw-weixin@2.4.10`.
 *
 * Preserves: code fences, inline code, tables, horizontal rules, `**bold**`, H1-H4,
 * lists, blockquotes, non-CJK italics, and all LF/CRLF whitespace.
 * Strips: H5/H6 markers (`##### ` / `###### `), CJK italics/bold-italics, and `![alt](url)`.
 */
export class StreamingMarkdownFilter {
  private buf = '';
  private fence = false;
  private sol = true;
  private inl: InlineAccumState | null = null;

  feed(delta: string): string {
    this.buf += delta;
    return this.pump(false);
  }

  flush(): string {
    return this.pump(true);
  }

  private pump(eof: boolean): string {
    let out = '';
    while (this.buf) {
      const sLen = this.buf.length;
      const sSol = this.sol;
      const sFence = this.fence;
      const sInl = this.inl;

      if (this.fence) out += this.pumpFence(eof);
      else if (this.inl) out += this.pumpInline();
      else if (this.sol) out += this.pumpSOL(eof);
      else out += this.pumpBody(eof);

      if (
        this.buf.length === sLen
        && this.sol === sSol
        && this.fence === sFence
        && this.inl === sInl
      ) {
        break;
      }
    }
    if (eof && this.inl) {
      const markers: Record<InlineAccumState['type'], string> = {
        image: '![',
        bold3: '***',
        italic: '*',
        ubold3: '___',
        uitalic: '_',
      };
      out += markers[this.inl.type] + this.inl.acc;
      this.inl = null;
    }
    return out;
  }

  private pumpFence(eof: boolean): string {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return '';
      if (this.buf.startsWith('```')) {
        const nl = this.buf.indexOf('\n', 3);
        if (nl !== -1) {
          this.fence = false;
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.fence = false;
          const line = this.buf;
          this.buf = '';
          return line;
        }
        return '';
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf('\n');
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf;
    this.buf = '';
    return chunk;
  }

  private pumpSOL(eof: boolean): string {
    const b = this.buf;
    if (b[0] === '\n') {
      this.buf = b.slice(1);
      return '\n';
    }
    if (b[0] === '`') {
      if (b.length < 3 && !eof) return '';
      if (b.startsWith('```')) {
        const nl = b.indexOf('\n', 3);
        if (nl !== -1) {
          this.fence = true;
          const line = b.slice(0, nl + 1);
          this.buf = b.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.buf = '';
          return b;
        }
        return '';
      }
      this.sol = false;
      return '';
    }
    if (b[0] === '>') {
      this.sol = false;
      return '';
    }
    if (b[0] === '#') {
      let n = 0;
      while (n < b.length && b[n] === '#') n++;
      if (n === b.length && !eof) return '';
      if (n >= 5 && n <= 6 && n < b.length && b[n] === ' ') {
        this.buf = b.slice(n + 1);
        this.sol = false;
        return '';
      }
      this.sol = false;
      return '';
    }
    if (b[0] === ' ' || b[0] === '\t') {
      if (b.search(/[^ \t]/) === -1 && !eof) return '';
      this.sol = false;
      return '';
    }
    if (b[0] === '-' || b[0] === '*' || b[0] === '_') {
      const ch = b[0];
      let j = 0;
      while (j < b.length && (b[j] === ch || b[j] === ' ')) j++;
      if (j === b.length && !eof) return '';
      if (j === b.length || b[j] === '\n') {
        let count = 0;
        for (let k = 0; k < j; k++) {
          if (b[k] === ch) count++;
        }
        if (count >= 3) {
          if (j < b.length) {
            this.buf = b.slice(j + 1);
            this.sol = true;
            return b.slice(0, j + 1);
          }
          this.buf = '';
          return b;
        }
      }
      this.sol = false;
      return '';
    }
    this.sol = false;
    return '';
  }

  private pumpBody(eof: boolean): string {
    let out = '';
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === '\n') {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }
      if (c === '!' && i + 1 < this.buf.length && this.buf[i + 1] === '[') {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: 'image', acc: '' };
        return out;
      }
      if (c === '~') {
        i++;
        continue;
      }
      if (c === '*') {
        if (i + 2 < this.buf.length && this.buf[i + 1] === '*' && this.buf[i + 2] === '*') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: 'bold3', acc: '' };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === '*') {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== ' ' && this.buf[i + 1] !== '\n') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: 'italic', acc: '' };
          return out;
        }
        i++;
        continue;
      }
      if (c === '_') {
        if (i + 2 < this.buf.length && this.buf[i + 1] === '_' && this.buf[i + 2] === '_') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: 'ubold3', acc: '' };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === '_') {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== ' ' && this.buf[i + 1] !== '\n') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: 'uitalic', acc: '' };
          return out;
        }
        i++;
        continue;
      }
      i++;
    }
    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith('**')) hold = 2;
      else if (this.buf.endsWith('__')) hold = 2;
      else if (this.buf.endsWith('*')) hold = 1;
      else if (this.buf.endsWith('_')) hold = 1;
      else if (this.buf.endsWith('!')) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : '';
    return out;
  }

  private pumpInline(): string {
    if (!this.inl) return '';
    this.inl.acc += this.buf;
    this.buf = '';
    switch (this.inl.type) {
      case 'bold3': {
        const idx = this.inl.acc.indexOf('***');
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          return StreamingMarkdownFilter.containsCJK(content) ? content : `***${content}***`;
        }
        return '';
      }
      case 'ubold3': {
        const idx = this.inl.acc.indexOf('___');
        if (idx !== -1) {
          const content = this.inl.acc.slice(0, idx);
          this.buf = this.inl.acc.slice(idx + 3);
          this.inl = null;
          return StreamingMarkdownFilter.containsCJK(content) ? content : `___${content}___`;
        }
        return '';
      }
      case 'italic': {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === '\n') {
            const r = `*${this.inl.acc.slice(0, j + 1)}`;
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === '*') {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === '*') {
              j++;
              continue;
            }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            return StreamingMarkdownFilter.containsCJK(content) ? content : `*${content}*`;
          }
        }
        return '';
      }
      case 'uitalic': {
        for (let j = 0; j < this.inl.acc.length; j++) {
          if (this.inl.acc[j] === '\n') {
            const r = `_${this.inl.acc.slice(0, j + 1)}`;
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            this.sol = true;
            return r;
          }
          if (this.inl.acc[j] === '_') {
            if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === '_') {
              j++;
              continue;
            }
            const content = this.inl.acc.slice(0, j);
            this.buf = this.inl.acc.slice(j + 1);
            this.inl = null;
            return StreamingMarkdownFilter.containsCJK(content) ? content : `_${content}_`;
          }
        }
        return '';
      }
      case 'image': {
        const cb = this.inl.acc.indexOf(']');
        if (cb === -1 || cb + 1 >= this.inl.acc.length) return '';
        if (this.inl.acc[cb + 1] !== '(') {
          const r = `![${this.inl.acc.slice(0, cb + 1)}`;
          this.buf = this.inl.acc.slice(cb + 1);
          this.inl = null;
          return r;
        }
        const cp = this.inl.acc.indexOf(')', cb + 2);
        if (cp !== -1) {
          this.buf = this.inl.acc.slice(cp + 1);
          this.inl = null;
          return '';
        }
        return '';
      }
    }
  }

  static containsCJK(text: string): boolean {
    return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(text);
  }
}

/** Run the full string through `StreamingMarkdownFilter` so rendering matches streamed chunks. */
export function filterWechatMarkdown(text: string): string {
  if (!text) return text;
  const filter = new StreamingMarkdownFilter();
  return filter.feed(text) + filter.flush();
}

const CODE_EXTENSIONS: Record<string, string> = {
  javascript: 'js', js: 'js', mjs: 'mjs', cjs: 'cjs',
  typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  python: 'py', py: 'py',
  json: 'json', jsonc: 'json', yaml: 'yml', yml: 'yml', toml: 'toml',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  sql: 'sql', css: 'css', scss: 'scss', html: 'html', xml: 'xml',
  go: 'go', rust: 'rs', rs: 'rs', java: 'java', kotlin: 'kt', swift: 'swift',
  ruby: 'rb', rb: 'rb', php: 'php', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp',
  csharp: 'cs', cs: 'cs', diff: 'diff', patch: 'diff', markdown: 'md', md: 'md',
  text: 'txt', txt: 'txt', plaintext: 'txt', log: 'log', ini: 'ini', csv: 'csv',
};

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_RULE_RE = /^\s*\|\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff);
  return wide ? 2 : 1;
}

function stringDisplayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charDisplayWidth(ch);
  return width;
}

function padDisplayEnd(text: string, targetWidth: number): string {
  const pad = targetWidth - stringDisplayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.replace(/\r$/, '').trim();
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map(cell => cell.trim());
}

function formatTableRun(run: string[]): string {
  const rows = run
    .filter(line => !TABLE_RULE_RE.test(line.replace(/\r$/, '')))
    .map(splitTableCells);
  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map(row => row.length));
  const widths = new Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c] ?? 0, stringDisplayWidth(row[c] ?? ''));
    }
  }
  return rows
    .map(row => {
      const cells: string[] = [];
      for (let c = 0; c < colCount; c++) {
        const cell = row[c] ?? '';
        cells.push(c === colCount - 1 ? cell : padDisplayEnd(cell, widths[c] ?? 0));
      }
      return cells.join('  ').replace(/\s+$/, '');
    })
    .join('\n');
}

/**
 * Convert Markdown tables into CJK-aware column-aligned plain text.
 * Leaves non-table text (and code fences) byte-for-byte untouched.
 */
export function renderMarkdownTables(text: string): string {
  if (!text || !text.includes('|')) return text;
  const lines = text.split('\n');
  const output: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.replace(/\r$/, '');
    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1]![0]!;
      output.push(rawLine);
      continue;
    }
    if (inFence) {
      if (fenceMatch && fenceMatch[1]![0] === fenceChar && fenceMatch[2] === '') {
        inFence = false;
        fenceChar = '';
      }
      output.push(rawLine);
      continue;
    }
    if (!TABLE_ROW_RE.test(line)) {
      output.push(rawLine);
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && TABLE_ROW_RE.test(lines[end + 1]!.replace(/\r$/, ''))) {
      end++;
    }
    const run = lines.slice(i, end + 1);
    if (!run.some(candidate => TABLE_RULE_RE.test(candidate.replace(/\r$/, '')))) {
      output.push(rawLine);
      continue;
    }
    changed = true;
    output.push(formatTableRun(run));
    i = end;
  }

  return changed ? output.join('\n') : text;
}

export interface WechatRichContentPlan {
  text: string;
  codeFiles: Array<{ name: string; content: string }>;
  notes: string[];
}

export function extensionForCodeLanguage(lang: string): string {
  const key = lang.trim().toLowerCase();
  return CODE_EXTENSIONS[key] ?? 'txt';
}

/**
 * Align Markdown tables and extract oversized fenced code blocks (`>= codeFileThreshold`)
 * into deliverable attachment files while keeping short blocks and plain messages verbatim.
 */
export function planWechatRichContent(
  markdown: string,
  options?: { codeFileThreshold?: number; allowCodeFiles?: boolean },
): WechatRichContentPlan {
  if (!markdown) return { text: markdown, codeFiles: [], notes: [] };

  const allowCodeFiles = options?.allowCodeFiles !== false;
  const threshold = Math.max(1, Math.floor(options?.codeFileThreshold ?? DEFAULT_WECHAT_CODE_FILE_CHARS));
  const withTables = renderMarkdownTables(markdown);
  const tablesChanged = withTables !== markdown;

  if (!allowCodeFiles || (!withTables.includes('```') && !withTables.includes('~~~'))) {
    return { text: withTables, codeFiles: [], notes: [] };
  }

  const lines = withTables.split('\n');
  const segments: string[] = [];
  const codeFiles: Array<{ name: string; content: string }> = [];
  const notes: string[] = [];
  let bufferLines: string[] = [];

  const flushProse = () => {
    if (bufferLines.length > 0) {
      segments.push(bufferLines.join('\n'));
      bufferLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const open = FENCE_OPEN_RE.exec(rawLine.replace(/\r$/, ''));
    if (!open) {
      bufferLines.push(rawLine);
      continue;
    }
    let close = -1;
    for (let scan = i + 1; scan < lines.length; scan++) {
      const candidate = FENCE_OPEN_RE.exec(lines[scan]!.replace(/\r$/, ''));
      if (candidate && candidate[1]![0] === open[1]![0] && candidate[2] === '') {
        close = scan;
        break;
      }
    }
    if (close === -1) {
      bufferLines.push(rawLine);
      continue;
    }
    const bodyLines = lines.slice(i + 1, close);
    const body = bodyLines.join('\n');
    if (body.length < threshold) {
      // Short code block stays verbatim with its fences.
      for (let k = i; k <= close; k++) {
        bufferLines.push(lines[k]!);
      }
      i = close;
      continue;
    }

    flushProse();
    const name = `snippet-${codeFiles.length + 1}.${extensionForCodeLanguage(open[2] ?? '')}`;
    codeFiles.push({ name, content: body.endsWith('\n') ? body : `${body}\n` });
    const note = `（代码 ${bodyLines.length} 行、${body.length} 字，已作为文件 ${name} 发出）`;
    notes.push(note);
    segments.push(note);
    i = close;
  }
  flushProse();

  if (codeFiles.length === 0) {
    return {
      text: tablesChanged ? withTables : markdown,
      codeFiles: [],
      notes: [],
    };
  }

  const rendered = segments.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: rendered, codeFiles, notes };
}

/**
 * Split long outbound text along paragraph, line, or word boundaries without
 * cutting UTF-16 surrogate pairs.
 */
export function chunkWechatText(text: string, maxLength = DEFAULT_WECHAT_CHUNK_CHARS): string[] {
  if (!text) return [];
  const limit = Math.max(1, Math.floor(maxLength));
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    const para = window.lastIndexOf('\n\n');
    if (para >= limit * 0.4) {
      cut = para + 2;
    } else {
      const nl = window.lastIndexOf('\n');
      if (nl >= limit * 0.5) {
        cut = nl + 1;
      } else {
        const space = window.lastIndexOf(' ');
        if (space >= limit * 0.5) cut = space + 1;
      }
    }
    if (cut <= 0) cut = limit;
    if (cut > 1) {
      const prevCode = rest.charCodeAt(cut - 1);
      if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
        cut -= 1;
      }
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
