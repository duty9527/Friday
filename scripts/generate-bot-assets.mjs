#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePoseFrame, BOT_AMBER_PALETTE, renderBotStaticSvgString } from '../dist/web/shared/bot-avatar.js';
import { BOT_EXPRESSIONS } from '../dist/web/shared/bot-expressions.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS_DIR = join(REPO_ROOT, 'assets');
const WECHAT_ASSETS_DIR = join(ASSETS_DIR, 'wechat');
const TG_ASSETS_DIR = join(ASSETS_DIR, 'telegram');
const TG_CIRCLE_ASSETS_DIR = join(TG_ASSETS_DIR, 'circle');
const STICKERS_DIR = join(ASSETS_DIR, 'stickers');
const WEB_AVATAR_PATH = join(REPO_ROOT, 'src', 'web', 'avatar.png');
const DIST_WEB_AVATAR_PATH = join(REPO_ROOT, 'dist', 'web', 'avatar.png');

const SVG_NS = 'http://www.w3.org/2000/svg';
let imUidCounter = 0;

function hasCommand(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_RSVG_CONVERT = hasCommand('rsvg-convert');
const HAS_MAGICK = hasCommand('magick');
const HAS_FFMPEG = hasCommand('ffmpeg');

function renderSvgToPng(svgMarkup, outPath, sizePx) {
  if (HAS_RSVG_CONVERT) {
    execFileSync('rsvg-convert', ['-w', String(sizePx), '-h', String(sizePx), '-o', outPath], {
      input: svgMarkup,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('SVG rasterization requires rsvg-convert on non-macOS platforms.');
  }
  renderSvgBatchWithSwift([{ svgMarkup, outPath, sizePx }]);
}

async function renderSvgBatch(tasks, workDir) {
  if (HAS_RSVG_CONVERT) {
    for (const task of tasks) {
      renderSvgToPng(task.svgMarkup, task.outPath, task.sizePx);
    }
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('SVG rasterization requires rsvg-convert on non-macOS platforms.');
  }
  const manifest = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const svgPath = join(workDir, `batch-${i}.svg`);
    await writeFile(svgPath, task.svgMarkup, 'utf8');
    manifest.push({ svgPath, outPath: task.outPath, sizePx: task.sizePx });
  }
  const manifestPath = join(workDir, 'batch-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  renderSvgBatchWithSwiftManifest(manifestPath);
}

function renderSvgBatchWithSwift(tasks) {
  const payload = JSON.stringify(tasks);
  const swiftSrc = `
import AppKit
import Foundation

struct Task: Decodable {
  let svgMarkup: String
  let outPath: String
  let sizePx: Int
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
let tasks = try JSONDecoder().decode([Task].self, from: inputData)
for t in tasks {
  guard let img = NSImage(data: Data(t.svgMarkup.utf8)) else {
    fputs("Failed to decode SVG for \\(t.outPath)\\n", stderr)
    exit(1)
  }
  let w = t.sizePx
  let h = t.sizePx
  img.size = NSSize(width: w, height: h)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: w,
    pixelsHigh: h,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    fputs("Failed to allocate NSBitmapImageRep\\n", stderr)
    exit(1)
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor.clear.set()
  NSRect(x: 0, y: 0, width: w, height: h).fill()
  img.draw(in: NSRect(x: 0, y: 0, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1.0)
  NSGraphicsContext.restoreGraphicsState()
  guard let pngData = rep.representation(using: .png, properties: [:]) else {
    fputs("Failed to encode PNG\\n", stderr)
    exit(1)
  }
  try pngData.write(to: URL(fileURLWithPath: t.outPath))
}
`;
  execFileSync('swift', ['-e', swiftSrc], {
    input: payload,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function renderSvgBatchWithSwiftManifest(manifestPath) {
  const swiftSrc = `
import AppKit
import Foundation

struct Task: Decodable {
  let svgPath: String
  let outPath: String
  let sizePx: Int
}

let manifestData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let tasks = try JSONDecoder().decode([Task].self, from: manifestData)
for t in tasks {
  let svgData = try Data(contentsOf: URL(fileURLWithPath: t.svgPath))
  guard let img = NSImage(data: svgData) else {
    fputs("Failed to decode SVG at \\(t.svgPath)\\n", stderr)
    exit(1)
  }
  let w = t.sizePx
  let h = t.sizePx
  img.size = NSSize(width: w, height: h)
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: w,
    pixelsHigh: h,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    fputs("Failed to allocate NSBitmapImageRep\\n", stderr)
    exit(1)
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor.clear.set()
  NSRect(x: 0, y: 0, width: w, height: h).fill()
  img.draw(in: NSRect(x: 0, y: 0, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1.0)
  NSGraphicsContext.restoreGraphicsState()
  guard let pngData = rep.representation(using: .png, properties: [:]) else {
    fputs("Failed to encode PNG\\n", stderr)
    exit(1)
  }
  try pngData.write(to: URL(fileURLWithPath: t.outPath))
}
`;
  execFileSync('swift', ['-', manifestPath], {
    input: swiftSrc,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function flattenPng24(inputPng, outPng) {
  if (HAS_MAGICK) {
    execFileSync('magick', [inputPng, '-alpha', 'off', `PNG24:${outPng}`], {
      stdio: 'inherit',
    });
    return;
  }
  if (HAS_FFMPEG) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inputPng, '-pix_fmt', 'rgb24', outPng], {
      stdio: 'inherit',
    });
    return;
  }
  throw new Error('Flattening PNG24 requires either ImageMagick (magick) or ffmpeg.');
}

function formatEyePathMarkup(eye) {
  if (!eye.d || eye.opacity <= 0.01) return '';
  return `<path d="${eye.d}" fill="none" stroke="${BOT_AMBER_PALETTE.eye}" stroke-width="${eye.strokeWidth.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${eye.opacity.toFixed(3)}"/>`;
}

function buildDotEyesMarkup(cxLeft, cxRight, cy, radius) {
  return [
    `<circle cx="${cxLeft}" cy="${cy}" r="${radius}" fill="${BOT_AMBER_PALETTE.eye}"/>`,
    `<circle cx="${cxRight}" cy="${cy}" r="${radius}" fill="${BOT_AMBER_PALETTE.eye}"/>`,
  ].join('');
}

function renderWechatFullSvg({ variant }) {
  const uid = `friday-wx-${++imUidCounter}`;
  let defs = '';
  let bg = `<rect width="144" height="144" fill="${BOT_AMBER_PALETTE.body}"/>`;
  if (variant === '3d') {
    defs = [
      `<radialGradient id="${uid}-hi" cx="30%" cy="24%" r="78%">`,
      `<stop offset="0%" stop-color="#FBBF24" stop-opacity="0.52"/>`,
      `<stop offset="48%" stop-color="#F59E0B" stop-opacity="0.16"/>`,
      `<stop offset="100%" stop-color="#C96B04" stop-opacity="0.36"/>`,
      `</radialGradient>`,
      `<linearGradient id="${uid}-sh" x1="0%" y1="0%" x2="100%" y2="100%">`,
      `<stop offset="0%" stop-color="#FFFBEB" stop-opacity="0.10"/>`,
      `<stop offset="55%" stop-color="#E88B0A" stop-opacity="0"/>`,
      `<stop offset="100%" stop-color="#B45309" stop-opacity="0.26"/>`,
      `</linearGradient>`,
    ].join('');
    bg += `<rect width="144" height="144" fill="url(#${uid}-hi)"/><rect width="144" height="144" fill="url(#${uid}-sh)"/>`;
  }

  let eyesMarkup = '';
  if (variant === 'dots') {
    eyesMarkup = buildDotEyesMarkup(56.9, 87.1, 49.5, 10.5);
  } else {
    const frame = computePoseFrame({
      body: 'squircle',
      expr: 'neutral',
      rx: -4,
      ry: -10,
      rz: -1.5,
      px: 0.05,
      py: -0.13,
      baseRadius: 60,
    });
    eyesMarkup = formatEyePathMarkup(frame.eyeLeft) + formatEyePathMarkup(frame.eyeRight);
  }

  return [
    `<svg xmlns="${SVG_NS}" width="1024" height="1024" viewBox="0 0 144 144">`,
    defs ? `<defs>${defs}</defs>` : '',
    bg,
    eyesMarkup,
    `</svg>`,
  ].join('');
}

function renderTelegramSvg({ surface, pose, circleClip }) {
  const uid = `friday-tg-${++imUidCounter}`;
  const defs = [];
  let bg = '';
  if (surface === 'sphere') {
    defs.push(
      `<radialGradient id="${uid}-sphere" cx="38%" cy="32%" r="64%" fx="35%" fy="29%">`,
      `<stop offset="0%" stop-color="#FCD34D"/>`,
      `<stop offset="26%" stop-color="#F59E0B"/>`,
      `<stop offset="62%" stop-color="#E88B0A"/>`,
      `<stop offset="88%" stop-color="#CA6B04"/>`,
      `<stop offset="100%" stop-color="#B85A04"/>`,
      `</radialGradient>`,
      `<radialGradient id="${uid}-spec" cx="34%" cy="26%" r="36%">`,
      `<stop offset="0%" stop-color="#FFFBEB" stop-opacity="0.28"/>`,
      `<stop offset="45%" stop-color="#FEF3C7" stop-opacity="0.10"/>`,
      `<stop offset="82%" stop-color="#FFFBEB" stop-opacity="0.015"/>`,
      `<stop offset="100%" stop-color="#FFFBEB" stop-opacity="0"/>`,
      `</radialGradient>`,
    );
    bg = [
      `<rect width="144" height="144" fill="#B85A04"/>`,
      `<rect width="144" height="144" fill="url(#${uid}-sphere)"/>`,
      `<rect width="144" height="144" fill="url(#${uid}-spec)"/>`,
    ].join('');
  } else {
    bg = `<rect width="144" height="144" fill="${BOT_AMBER_PALETTE.body}"/>`;
  }

  let eyesMarkup = '';
  if (pose === 'dots') {
    eyesMarkup = buildDotEyesMarkup(56.8, 87.2, 55.5, 10.2);
  } else {
    const poseMap = {
      neutral: { body: 'sphere', expr: 'neutral', rx: -5, ry: -11, rz: -2, px: 0.10, py: -0.05, baseRadius: 58 },
      happy: { body: 'sphere', expr: 'happy', rx: -3, ry: -8, rz: -1.5, px: 0.08, py: -0.06, baseRadius: 60 },
      inspecting: { body: 'sphere', expr: 'inspecting', rx: -4, ry: -10, rz: -2, px: 0.09, py: -0.05, baseRadius: 58 },
    };
    const frame = computePoseFrame(poseMap[pose]);
    eyesMarkup = formatEyePathMarkup(frame.eyeLeft) + formatEyePathMarkup(frame.eyeRight);
  }

  if (circleClip) {
    defs.push(`<clipPath id="${uid}-clip"><circle cx="72" cy="72" r="72"/></clipPath>`);
  }

  const content = bg + eyesMarkup;
  return [
    `<svg xmlns="${SVG_NS}" width="1024" height="1024" viewBox="0 0 144 144">`,
    defs.length ? `<defs>${defs.join('')}</defs>` : '',
    circleClip ? `<g clip-path="url(#${uid}-clip)">${content}</g>` : content,
    `</svg>`,
  ].join('');
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

async function generateImAvatars(workDir) {
  await mkdir(WECHAT_ASSETS_DIR, { recursive: true });
  await mkdir(TG_ASSETS_DIR, { recursive: true });
  await mkdir(TG_CIRCLE_ASSETS_DIR, { recursive: true });

  const svgTasks = [];
  const flattenTasks = [];

  const wechatSpecs = [
    { name: 'avatar-wechat-full.png', variant: 'flat' },
    { name: 'avatar-wechat-full-3d.png', variant: '3d' },
    { name: 'avatar-wechat-full-dots.png', variant: 'dots' },
  ];
  for (const spec of wechatSpecs) {
    const rawPng = join(workDir, `raw-${spec.name}`);
    svgTasks.push({
      svgMarkup: renderWechatFullSvg({ variant: spec.variant }),
      outPath: rawPng,
      sizePx: 1024,
    });
    flattenTasks.push({
      inputPng: rawPng,
      outPng: join(WECHAT_ASSETS_DIR, spec.name),
    });
  }

  const tgSpecs = [
    { key: 'sphere-neutral', surface: 'sphere', pose: 'neutral' },
    { key: 'sphere-happy', surface: 'sphere', pose: 'happy' },
    { key: 'sphere-inspecting', surface: 'sphere', pose: 'inspecting' },
    { key: 'flat-neutral', surface: 'flat', pose: 'neutral' },
    { key: 'flat-dots', surface: 'flat', pose: 'dots' },
  ];
  for (const spec of tgSpecs) {
    const rawBleedPng = join(workDir, `raw-tg-${spec.key}.png`);
    svgTasks.push({
      svgMarkup: renderTelegramSvg({ surface: spec.surface, pose: spec.pose, circleClip: false }),
      outPath: rawBleedPng,
      sizePx: 1024,
    });
    flattenTasks.push({
      inputPng: rawBleedPng,
      outPng: join(TG_ASSETS_DIR, `avatar-tg-${spec.key}.png`),
    });

    svgTasks.push({
      svgMarkup: renderTelegramSvg({ surface: spec.surface, pose: spec.pose, circleClip: true }),
      outPath: join(TG_CIRCLE_ASSETS_DIR, `avatar-tg-circle-${spec.key}.png`),
      sizePx: 1024,
    });
  }

  await renderSvgBatch(svgTasks, workDir);
  for (const item of flattenTasks) {
    flattenPng24(item.inputPng, item.outPng);
  }
}

async function main() {
  const imOnly = process.argv.includes('--im-only');
  await mkdir(ASSETS_DIR, { recursive: true });

  const workDir = await mkdtemp(join(tmpdir(), 'friday-bot-assets-'));
  try {
    await generateImAvatars(workDir);
    if (imOnly) {
      console.log('Generated F.R.I.D.A.Y. WeChat full-bleed square & Telegram circle avatar suites.');
      return;
    }

    await mkdir(STICKERS_DIR, { recursive: true });

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

    console.log('Generated F.R.I.D.A.Y. bot PNG avatars, IM avatar suites, and 9 animated GIF stickers.');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
