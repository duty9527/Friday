import {
  createLiveBotAvatar,
  createStaticBotSvg,
  type BotAvatarController,
  type BotPokeKind,
  type BotStateId,
} from '@friday/web/shared/bot-avatar.js';
import type { BotExpression } from '@friday/web/shared/bot-expressions.js';
import { useEffect, useRef } from 'react';

export function CompanionAvatar({
  botState,
  paused,
  size = 24,
}: {
  botState: BotStateId;
  paused: boolean;
  size?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<BotAvatarController | null>(null);
  const pokeSeqRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const avatar = createLiveBotAvatar({
      size,
      interactive: true,
      idPrefix: 'friday-companion',
    });
    ctrlRef.current = avatar;
    host.replaceChildren(avatar.svg);

    let rafId = 0;
    let pendingX = 0;
    let pendingY = 0;
    let reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    const onMotionChange = (e: MediaQueryListEvent) => {
      reducedMotion = e.matches;
      if (reducedMotion) avatar.setGaze(0, 0);
    };
    mql?.addEventListener?.('change', onMotionChange);

    const flushGaze = () => {
      rafId = 0;
      if (reducedMotion || paused) return;
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      avatar.setGaze((pendingX - cx) / 360, -(pendingY - cy) / 280);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (reducedMotion || paused) return;
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (!rafId) rafId = requestAnimationFrame(flushGaze);
    };
    const onPointerLeave = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      avatar.setGaze(0, 0);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      mql?.removeEventListener?.('change', onMotionChange);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      avatar.destroy();
      ctrlRef.current = null;
      host.replaceChildren();
    };
  }, [paused, size]);

  useEffect(() => {
    ctrlRef.current?.setState(botState);
  }, [botState]);

  const handleClick = () => {
    const seq: BotPokeKind[] = ['bounce', 'nod', 'spin'];
    const kind = seq[pokeSeqRef.current % seq.length]!;
    pokeSeqRef.current += 1;
    ctrlRef.current?.poke(kind, kind === 'spin' ? 2 : 1);
  };

  return (
    <div
      id="companion-avatar"
      ref={hostRef}
      role="button"
      tabIndex={0}
      aria-label="F.R.I.D.A.Y. 伴随头像（点击互动）"
      onClick={handleClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    />
  );
}

export function StaticBotAvatar({
  expr = 'neutral',
  size = 28,
  interactivePoke = false,
  className,
}: {
  expr?: BotExpression;
  size?: number;
  interactivePoke?: boolean;
  className?: string;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (interactivePoke) {
      const btn = createStaticBotSvg({
        expr,
        size,
        interactivePoke: true,
        className,
      });
      host.replaceChildren(btn);
      return () => host.replaceChildren();
    }
    const svg = createStaticBotSvg({
      expr,
      size,
      interactivePoke: false,
      className,
    });
    host.replaceChildren(svg);
    return () => host.replaceChildren();
  }, [className, expr, interactivePoke, size]);

  return <span ref={hostRef} className="inline-flex items-center justify-center shrink-0" />;
}
