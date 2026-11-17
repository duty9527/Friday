#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBotStaticSvgString } from '../dist/web/shared/bot-avatar.js';
import { BOT_EXPRESSIONS } from '../dist/web/shared/bot-expressions.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(REPO_ROOT, 'assets');
const STICKERS_DIR = join(ASSETS_DIR, 'stickers');
const WEB_AVATAR_PATH = join(REPO_ROOT, 'src', 'web', 'avatar.png');
const DIST_WEB_AVATAR_PATH = join(REPO_ROOT, 'dist', 'web', 'avatar.png');

function renderSvgToPng(svgMarkup, outPath, sizePx) {
  execFileSync('rsvg-convert', ['-w', String(sizePx), '-h', String(sizePx), '-o', outPath], {
    input: svgMarkup,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function flattenPng24(inputPng, outPng) {
  execFileSync('magick', [inputPng, '-alpha', 'off', `PNG24:${outPng}`], {
    stdio: 'inherit',
  });
}

function stickerPose(expr, frameIdx, totalFrames) {
  const p = frameIdx / totalFrames;
  const tau = Math.PI * 2;
  const blinkPulse = (center, width) => {
    const d = Math.abs(p - center);
    return d < width ? Math.cos((d / width) * (Math.PI / 2)) : 0;
  };

  switch (expr) {
    case 'happy':
      return {
        rx: -4 + Math.sin(p * tau * 2) * 5,
        ry: -4 + Math.sin(p * tau) * 10,
        rz: Math.sin(p * tau) * 6,
        py: -Math.abs(Math.sin(p * tau * 2)) * 0.13 + 0.03,
        sx: 1 - Math.sin(p * tau * 4) * 0.06,
        sy: 1 + Math.sin(p * tau * 4) * 0.08,
        scale: 1,
        lids: 0,
      };
    case 'surprised': {
      const pop = Math.sin(p * Math.PI);
      return {
        rx: -5 - pop * 4,
        ry: -6 + Math.sin(p * tau) * 6,
        rz: Math.sin(p * tau) * 3,
        py: -pop * 0.09,
        sx: 1 - pop * 0.04,
        sy: 1 + pop * 0.06,
        scale: 1 + pop * 0.07,
        lids: blinkPulse(0.75, 0.09),
      };
    }
    case 'inspecting':
      return {
        rx: -4 + Math.cos(p * tau) * 3,
        ry: Math.sin(p * tau) * 19,
        rz: Math.sin(p * tau) * 7,
        py: Math.sin(p * tau * 2) * 0.02,
        sx: 1,
        sy: 1,
        scale: 1.03,
        lids: 0,
      };
    case 'calm':
      return {
        rx: -2 + Math.sin(p * tau) * 2,
        ry: -6 + Math.sin(p * tau) * 6,
        rz: Math.sin(p * tau) * 6,
        py: Math.sin(p * tau) * 0.025,
        sx: 1 + Math.sin(p * tau) * 0.02,
        sy: 1 - Math.sin(p * tau) * 0.02,
        scale: 1,
        lids: blinkPulse(0.5, 0.11),
      };
    case 'squinted':
      return {
        rx: 4 + Math.sin(p * tau * 2) * 7,
        ry: -4 + Math.sin(p * tau) * 7,
        rz: Math.sin(p * tau) * 4,
        py: Math.sin(p * tau * 2) * 0.03,
        sx: 1 + Math.sin(p * tau * 2) * 0.04,
        sy: 1 - Math.sin(p * tau * 2) * 0.04,
        scale: 1,
        lids: 0,
      };
    case 'sleepy':
      return {
        rx: 11 + Math.sin(p * tau) * 4,
        ry: -5 + Math.sin(p * tau) * 3,
        rz: -5 + Math.sin(p * tau) * 2,
        py: 0.04 + Math.sin(p * tau) * 0.025,
        sx: 1.03 + Math.sin(p * tau) * 0.04,
        sy: 0.97 - Math.sin(p * tau) * 0.04,
        scale: 1,
        lids: 0,
      };
    case 'confused':
      return {
        rx: 4 + Math.sin(p * tau) * 3,
        ry: Math.sin(p * tau * 2) * 16,
        rz: 7 + Math.sin(p * tau) * 5,
        py: 0.01,
        sx: 1,
        sy: 1,
        scale: 1,
        lids: blinkPulse(0.65, 0.08),
      };
    case 'sad':
      return {
        rx: 12 + Math.sin(p * tau) * 4,
        ry: -4 + Math.sin(p * tau) * 5,
        rz: -3 + Math.sin(p * tau) * 2,
        py: 0.05 + Math.sin(p * tau) * 0.02,
        sx: 1.04 + Math.sin(p * tau) * 0.03,
        sy: 0.96 - Math.sin(p * tau) * 0.03,
        scale: 1,
        lids: 0,
      };
    case 'neutral':
    default:
      return {
        rx: -2 + Math.sin(p * tau * 2) * 3,
        ry: -4 + Math.sin(p * tau) * 15,
        rz: Math.sin(p * tau) * 3,
        py: Math.sin(p * tau * 2) * 0.018,
        sx: 1 + Math.sin(p * tau) * 0.02,
        sy: 1 - Math.sin(p * tau) * 0.02,
        scale: 1,
        lids: blinkPulse(0.55, 0.09),
      };
  }
}

async function main() {
  await mkdir(ASSETS_DIR, { recursive: true });
  await mkdir(STICKERS_DIR, { recursive: true });

  const workDir = await mkdtemp(join(tmpdir(), 'friday-bot-assets-'));
  try {
    // 1. Static PNGs (1024x1024 assets + 128x128 web icon)
    const transparentSvg = renderBotStaticSvgString({
      size: 1024,
      expr: 'neutral',
      body: 'squircle',
      rx: -3,
      ry: -12,
      rz: -2,
      baseRadius: 54,
      background: 'transparent',
    });
    renderSvgToPng(transparentSvg, join(ASSETS_DIR, 'avatar-transparent.png'), 1024);

    const webAvatarSvg = renderBotStaticSvgString({
      size: 128,
      expr: 'neutral',
      body: 'squircle',
      rx: -3,
      ry: -12,
      rz: -2,
      baseRadius: 54,
      background: 'transparent',
    });
    renderSvgToPng(webAvatarSvg, WEB_AVATAR_PATH, 128);
    await copyFile(WEB_AVATAR_PATH, DIST_WEB_AVATAR_PATH).catch(() => {});

    const bgSpecs = [
      { name: 'avatar.png', background: 'dark-glow' },
      { name: 'avatar-wechat-dark.png', background: 'wechat-dark' },
      { name: 'avatar-wechat-light.png', background: 'wechat-light' },
    ];
    for (const spec of bgSpecs) {
      const tmpPng = join(workDir, `raw-${spec.name}`);
      const svg = renderBotStaticSvgString({
        size: 1024,
        expr: 'neutral',
        body: 'squircle',
        rx: -3,
        ry: -12,
        rz: -2,
        baseRadius: 50,
        background: spec.background,
      });
      renderSvgToPng(svg, tmpPng, 1024);
      flattenPng24(tmpPng, join(ASSETS_DIR, spec.name));
    }

    // 2. 9 Transparent Animated GIF Stickers (200x200) for WeChat iLink image_item
    const totalFrames = 20;
    for (const expr of BOT_EXPRESSIONS) {
      const exprDir = join(workDir, `sticker-${expr}`);
      await mkdir(exprDir, { recursive: true });
      const framePaths = [];
      for (let i = 0; i < totalFrames; i++) {
        const pose = stickerPose(expr, i, totalFrames);
        const svg = renderBotStaticSvgString({
          size: 200,
          expr,
          body: 'squircle',
          ...pose,
          baseRadius: 48,
          background: 'transparent',
        });
        const framePng = join(exprDir, `frame_${String(i).padStart(2, '0')}.png`);
        const frameSvg = join(exprDir, `frame_${String(i).padStart(2, '0')}.svg`);
        await writeFile(frameSvg, svg, 'utf8');
        renderSvgToPng(svg, framePng, 200);
        framePaths.push(framePng);
      }
      const gifPath = join(STICKERS_DIR, `bot-${expr}.gif`);
      execFileSync(
        'magick',
        [
          '-dispose',
          'Background',
          '-delay',
          '7',
          '-loop',
          '0',
          ...framePaths,
          '-layers',
          'OptimizeTransparency',
          gifPath,
        ],
        { stdio: 'inherit' },
      );
    }

    console.log('Generated F.R.I.D.A.Y. bot PNG avatars and 9 animated GIF stickers.');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
