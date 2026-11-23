import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  isSafeUrl,
  parseInlineTokens,
  parseMarkdownBlocks,
  type InlineToken,
  type MarkdownBlock,
  type TableAlign,
} from '@friday/web/shared/markdown.js';
import { tokenizeBotMessageText } from '@friday/web/shared/bot-expressions.js';
import { FullContentDialog, ViewFullButton } from '@/components/shared/FullContentViewer';
import { StaticBotAvatar } from '@/components/CompanionAvatar';
import { Button } from '@/components/ui/button';

const CODE_COLLAPSE_LINES = 26;

function CodeBlock({
  lang,
  code,
  allowCodeModal = true,
}: {
  lang: string;
  code: string;
  allowCodeModal?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const lineCount = useMemo(() => code.split('\n').length, [code]);
  const collapsible = lineCount >= CODE_COLLAPSE_LINES;
  const canOpenModal = allowCodeModal && (lineCount >= 16 || code.length >= 600);
  const [expanded, setExpanded] = useState(!collapsible);
  const modalPayload = useMemo(
    () =>
      modalOpen
        ? {
            title: `代码块 · ${lang || 'text'}`,
            content: code,
            mode: 'code' as const,
          }
        : null,
    [modalOpen, lang, code],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-code text-code-foreground">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-mono uppercase tracking-wide">{lang || 'text'}</span>
        <div className="flex items-center gap-1">
          {collapsible && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setExpanded(prev => !prev)}
            >
              {expanded ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
              {expanded ? '收起' : `展开 ${lineCount} 行`}
            </Button>
          )}
          {canOpenModal && (
            <ViewFullButton onClick={() => setModalOpen(true)} />
          )}
          <Button type="button" size="xs" variant="ghost" onClick={() => void handleCopy()}>
            {copied ? <CheckIcon className="size-3.5 text-success-foreground" /> : <CopyIcon className="size-3.5" />}
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      </div>
      {expanded ? (
        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      ) : (
        <pre className="max-h-36 overflow-hidden p-3 text-xs leading-relaxed opacity-75">
          <code>{code.split('\n').slice(0, 8).join('\n')}</code>
        </pre>
      )}
      {canOpenModal && (
        <FullContentDialog
          payload={modalPayload}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function renderInlineList(tokens: InlineToken[], keyPrefix: string): ReactNode {
  return tokens.map((tok, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (tok.kind) {
      case 'text':
        return <Fragment key={key}>{tok.text}</Fragment>;
      case 'code':
        return <code key={key}>{tok.text}</code>;
      case 'bold':
        return <strong key={key}>{renderInlineList(tok.children, key)}</strong>;
      case 'italic':
        return <em key={key}>{renderInlineList(tok.children, key)}</em>;
      case 'strike':
        return <del key={key}>{renderInlineList(tok.children, key)}</del>;
      case 'link':
        return isSafeUrl(tok.href) ? (
          <a key={key} href={tok.href} target="_blank" rel="noopener noreferrer">
            {tok.label}
          </a>
        ) : (
          <Fragment key={key}>{tok.label}</Fragment>
        );
    }
  });
}

function renderRichInlineText(text: string, keyPrefix: string): ReactNode {
  const segs = tokenizeBotMessageText(text);
  return segs.map((seg, idx) => {
    const key = `${keyPrefix}-seg-${idx}`;
    if (seg.kind === 'emote' || seg.kind === 'sticker') {
      return (
        <span key={key} className="bot-inline-emote" title={seg.expr}>
          <StaticBotAvatar expr={seg.expr} size={20} />
        </span>
      );
    }
    return <Fragment key={key}>{renderInlineList(parseInlineTokens(seg.value), key)}</Fragment>;
  });
}

function alignClass(align: TableAlign): string {
  if (align === 'center') return 'text-center';
  if (align === 'right') return 'text-end';
  return 'text-start';
}

function renderBlocks(blocks: MarkdownBlock[], keyPrefix: string, allowCodeModal = true): ReactNode {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-b-${idx}`;
    switch (block.kind) {
      case 'heading': {
        const content = renderRichInlineText(block.text, key);
        if (block.level === 1) return <h2 key={key}>{content}</h2>;
        if (block.level === 2) return <h3 key={key}>{content}</h3>;
        if (block.level === 3) return <h4 key={key}>{content}</h4>;
        return <h5 key={key}>{content}</h5>;
      }
      case 'paragraph': {
        const segs = tokenizeBotMessageText(block.text);
        if (segs.length === 1 && (segs[0]?.kind === 'emote' || segs[0]?.kind === 'sticker')) {
          return (
            <p key={key} className="my-1.5">
              <span className="bot-sticker-wrap" title={segs[0].expr}>
                <StaticBotAvatar expr={segs[0].expr} size={46} />
              </span>
            </p>
          );
        }
        return <p key={key}>{renderRichInlineText(block.text, key)}</p>;
      }
      case 'code':
        return <CodeBlock key={key} lang={block.lang} code={block.code} allowCodeModal={allowCodeModal} />;
      case 'quote':
        return <blockquote key={key}>{renderBlocks(block.blocks, key, allowCodeModal)}</blockquote>;
      case 'hr':
        return <hr key={key} />;
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}>
            {block.items.map((item, liIdx) => {
              const itemKey = `${key}-li-${liIdx}`;
              return (
                <li key={itemKey} className={item.checked !== undefined ? 'list-none -ms-4 flex items-start gap-1.5' : undefined}>
                  {item.checked !== undefined && (
                    <input
                      type="checkbox"
                      checked={item.checked}
                      readOnly
                      aria-label="任务项"
                      className="mt-1 size-3.5 accent-primary"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    {renderRichInlineText(item.text, itemKey)}
                    {item.children?.length ? renderBlocks(item.children, itemKey, allowCodeModal) : null}
                  </div>
                </li>
              );
            })}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  {block.headers.map((header, hIdx) => (
                    <th key={`${key}-th-${hIdx}`} className={alignClass(block.aligns[hIdx] ?? 'none')}>
                      {renderRichInlineText(header, `${key}-th-${hIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rIdx) => (
                  <tr key={`${key}-tr-${rIdx}`}>
                    {block.headers.map((_, cIdx) => (
                      <td key={`${key}-td-${rIdx}-${cIdx}`} className={alignClass(block.aligns[cIdx] ?? 'none')}>
                        {renderRichInlineText(row[cIdx] ?? '', `${key}-td-${rIdx}-${cIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function MarkdownContent({
  text,
  mode = 'assistant',
  allowCodeModal = true,
}: {
  text: string;
  mode?: 'assistant' | 'user';
  allowCodeModal?: boolean;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  if (mode === 'user') {
    const lines = text.split('\n');
    return (
      <div className="message-text whitespace-pre-wrap break-words text-sm leading-relaxed">
        {lines.map((line, idx) => (
          <Fragment key={idx}>
            {idx > 0 && '\n'}
            {renderRichInlineText(line, `u-${idx}`)}
          </Fragment>
        ))}
      </div>
    );
  }
  return <div className="message-text friday-prose">{renderBlocks(blocks, 'md', allowCodeModal)}</div>;
}
