import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { offlineFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import {
  classifyBashCommandCs80Scene,
  classifyFastpathCs80Scene,
  classifyPluginCs80Scene,
  formatInboundMarqueePreview,
} from '../src/cs80-scene.js';
import { SubconsciousController } from '../src/orchestrator/subconscious-loop.js';
import { listPlugins, runPlugin } from '../src/plugin.js';
import { Store } from '../src/store.js';
import { deriveFridayBotState } from '../src/web/shared/bot-avatar.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300, stepMs = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(stepMs);
  }
  throw new Error('Timed out waiting for condition');
}

test('1. SubconsciousController exposes live awake/REM status and Coordinator.view() includes subconscious', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-sub-'));
  const coordHome = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-coord-'));
  const store = new Store(home);
  const coordinator = new Coordinator(coordHome, offlineFactory(5));
  let releasePrompt!: () => void;
  const promptGate = new Promise<string>(res => {
    releasePrompt = () => res('{"impression":"测试梦境联想","salience":"vivid"}');
  });

  try {
    let virtualNow = new Date('2026-11-11T02:00:00').getTime();
    store.saveMemory({ topic: 'stub1', content: 'c1', tags: ['auto-consolidated'] });
    store.saveMemory({ topic: 'stub2', content: 'c2', tags: ['auto-consolidated'] });

    const sub = new SubconsciousController({
      store,
      factory: {
        mode: 'real',
        async create() {
          return {
            close() {},
            async prompt() {
              return await promptGate;
            },
          };
        },
      },
      modelHub: {
        getModelPool: () => [],
        async decideWorkerModel() {
          return { model: 'deepseek/deepseek-chat', tier: 'fast', thinkingLevel: 'low' };
        },
      } as never,
      runtime: { now: () => virtualNow, random: () => 0.01, checkIntervalMs: 1 },
      isClosing: () => false,
      hasRouter: () => true,
      hasActiveWork: () => false,
    });

    assert.equal(sub.status().sleeping, false);
    assert.equal(sub.status().phase, 'awake');

    virtualNow += 90 * 60_000;
    sub.tickSubconscious();
    await until(() => sub.status().sleeping && sub.status().phase === 'rem');
    assert.equal(sub.status().sleeping, true);
    assert.equal(sub.status().phase, 'rem');

    // Immediate wake-up (<1ms) when user activity arrives
    sub.arouse('User chat activity');
    assert.equal(sub.status().sleeping, false);
    assert.equal(sub.status().phase, 'awake');

    releasePrompt();
    await sub.awaitSettled();

    await coordinator.ready();
    const view = coordinator.view();
    assert.ok(view.subconscious, 'Coordinator.view() includes subconscious status');
    assert.equal(view.subconscious.sleeping, false);
    assert.equal(view.subconscious.phase, 'awake');
  } finally {
    releasePrompt();
    await coordinator.close();
    store.close();
    await rm(home, { recursive: true, force: true });
    await rm(coordHome, { recursive: true, force: true });
  }
});

test('2. build.sh compiles qdc1 & fast565.so and BGR565 endianness, 32x16 tile diff, xxh32, and MP3 chime synthesis pass', async () => {
  const tmpDir = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-py-'));
  try {
    execFileSync('bash', ['tools/cs80-face/build.sh'], { cwd: REPO_ROOT, stdio: 'pipe' });

    const pyCheck = `
import struct, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'tools', 'cs80-face'))})
from renderer import FaceRenderer, WIDTH, HEIGHT, FRAME_BYTES
from audio import xxh32, ensure_chime_mp3

r = FaceRenderer()
assert r.fast.loaded, "fast565.so failed to load"

# Verify BGRA -> BGR565 endianness (Red=0x001F, Green=0x07E0, Blue=0xF800)
bgra = bytearray(WIDTH * HEIGHT * 4)
# Pixel 0: Red (B=0, G=0, R=255, A=255)
bgra[0:4] = bytes([0, 0, 255, 255])
# Pixel 1: Green (B=0, G=255, R=0, A=255)
bgra[4:8] = bytes([0, 255, 0, 255])
# Pixel 2: Blue (B=255, G=0, R=0, A=255)
bgra[8:12] = bytes([255, 0, 0, 255])
# Pixel 3: White
bgra[12:16] = bytes([255, 255, 255, 255])

out565 = bytearray(FRAME_BYTES)
r.fast.bgra_to_bgr565(bgra, out565)
p0, p1, p2, p3, p4 = struct.unpack_from("<HHHHH", out565, 0)
assert (p0, p1, p2, p3, p4) == (0x001F, 0x07E0, 0xF800, 0xFFFF, 0x0000), (p0, p1, p2, p3, p4)

# Verify 32x16 tile diffing
curr565 = bytearray(out565)
off = (33 * WIDTH + 65) * 2  # inside tile (x=64, y=32)
struct.pack_into("<H", curr565, off, 0x1234)
tiles_buf = bytearray(160 * 1028)
dirty = r.fast.diff_tiles(out565, curr565, tiles_buf, 160)
assert dirty == 1, f"expected 1 dirty tile, got {dirty}"
tx, ty = struct.unpack_from("<HH", tiles_buf, 0)
assert (tx, ty) == (64, 32), (tx, ty)

# Verify xxh32 empty payload hash & MP3 chime synthesis
assert xxh32(b"") == 0x02CC5D05
mp3 = ensure_chime_mp3("ask_boss", Path(${JSON.stringify(tmpDir)}))
data = mp3.read_bytes()
assert 512 < len(data) <= 4 * 1024 * 1024, len(data)
assert data[:3] == b"ID3" or (data[0] == 0xFF and (data[1] & 0xE0) == 0xE0)
`;
    execFileSync('python3', ['-c', pyCheck], { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. End-to-end daemon.py --mock-sidecar integrates with cs80-face plugin for frames, tile patches, screen control, and audio', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-e2e-'));
  const mockLog = join(home, 'mock-sidecar.jsonl');
  const prevPortEnv = process.env.CS80_FACE_PORT;

  const proc = spawn(
    'python3',
    ['-u', 'tools/cs80-face/daemon.py', '--host', '127.0.0.1', '--port', '0', '--home', home, '--mock-sidecar', '--mock-log', mockLog],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.on('data', chunk => { stdoutBuf += String(chunk); });
  proc.stderr.on('data', chunk => { stderrBuf += String(chunk); });

  try {
    await until(() => /LISTENING http:\/\/127\.0\.0\.1:(\d+)/.test(stdoutBuf), 300, 25);
    const match = stdoutBuf.match(/LISTENING http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, `Missing listening port in stdout: ${stdoutBuf} / stderr: ${stderrBuf}`);
    const port = Number(match[1]);
    process.env.CS80_FACE_PORT = String(port);

    const discovered = await listPlugins(home);
    assert.ok(discovered.some(p => p.name === 'cs80-face'), 'cs80-face builtin plugin is discovered');

    // Wait for mock sidecar handshake & initial full frame
    let stRes!: Awaited<ReturnType<typeof runPlugin>>;
    await until(async () => {
      stRes = await runPlugin(home, 'cs80-face', 'status', {});
      const data = stRes.data as { device?: string; block?: number } | undefined;
      return Boolean(stRes.ok && data?.device === 'up' && data?.block === 520192);
    }, 200, 30);
    assert.equal((stRes.data as { fast565?: boolean }).fast565, true);

    // Fetch /preview.png
    const pngResp = await fetch(`http://127.0.0.1:${port}/preview.png`);
    assert.equal(pngResp.status, 200);
    const pngBuf = Buffer.from(await pngResp.arrayBuffer());
    assert.deepEqual([...pngBuf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    // Trigger express + poke + banner -> generates 0x02 dirty tile patches
    const exprRes = await runPlugin(home, 'cs80-face', 'express', {
      expr: 'happy',
      poke: 'bounce',
      text: '副屏联调成功',
      holdSec: 5,
    });
    assert.equal(exprRes.ok, true);
    await delay(350);

    // Control brightness (95 then back to 100)
    const scr95 = await runPlugin(home, 'cs80-face', 'screen', { brightness: 95 });
    assert.equal(scr95.ok, true);
    const scr100 = await runPlugin(home, 'cs80-face', 'screen', { brightness: 100 });
    assert.equal(scr100.ok, true);

    // Play ask_boss chime first time (uploads MP3) and second time (skips upload via VERIFY hash match)
    const snd1 = await runPlugin(home, 'cs80-face', 'sound', { chime: 'ask_boss', volume: 75 });
    assert.equal(snd1.ok, true);
    assert.equal((snd1.data as { play?: { uploaded?: boolean } }).play?.uploaded, true);

    const snd2 = await runPlugin(home, 'cs80-face', 'sound', { chime: 'ask_boss' });
    assert.equal(snd2.ok, true);
    assert.equal((snd2.data as { play?: { uploaded?: boolean } }).play?.uploaded, false);

    // Real-time voice listening / transcribing / idle fast control (<50ms)
    const vListen = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'voice', phase: 'listening', keyword: '星期五', speakerName: '主人' }),
    });
    assert.equal(vListen.status, 200);
    await until(async () => {
      const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
      return st.botState === 'listening';
    }, 50, 15);

    await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'voice', phase: 'transcribing', keyword: '星期五' }),
    });
    await until(async () => {
      const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
      return st.botState === 'thinking';
    }, 50, 15);

    await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'voice', phase: 'idle' }),
    });

    // Inbound message preview push + dynamic scene states + priority protection
    const inRes = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'inbound', channel: 'wechat', text: '帮我打开客厅空调并打印报表', holdSec: 8 }),
    });
    assert.equal(inRes.status, 200);

    for (const [scene, channel] of [
      ['speaking', 'xiaoai'],
      ['sending_msg', 'wechat'],
      ['sending_msg', 'telegram'],
      ['printing', ''],
      ['operating_xiaoai', ''],
      ['operating_tv', ''],
      ['managing_laifen', ''],
      ['weighing_scale', ''],
    ] as const) {
      const scResp = await fetch(`http://127.0.0.1:${port}/api/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'scene', scene, phase: 'start', channel, holdSec: 5, force: true }),
      });
      assert.equal(scResp.status, 200);
      await until(async () => {
        const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
        return st.botState === scene;
      }, 50, 15);
    }

    // Priority check: speaking (prio 1) must not overwrite active operating_xiaoai (prio 2)
    await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'scene', scene: 'operating_xiaoai', phase: 'start', holdSec: 5, force: true }),
    });
    await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'scene', scene: 'speaking', phase: 'start', channel: 'xiaoai', holdSec: 5 }),
    });
    const stPrio = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
    assert.equal(stPrio.botState, 'operating_xiaoai');

    // Explicit wake interrupts any scene back to listening, and idle restores auto state
    await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'voice', phase: 'listening', keyword: '星期五', followUp: false }),
    });
    const stWake = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
    assert.equal(stWake.botState, 'listening');
    await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'voice', phase: 'idle' }),
    });

    // Live health-scale BLE session file transitions daemon cleanly to weighing_scale and back to idle
    const hsSessDir = join(home, 'plugins', 'health-scale');
    await mkdir(hsSessDir, { recursive: true });
    await writeFile(
      join(hsSessDir, 'live-session.json'),
      JSON.stringify({ sessionId: 'm-live-1', phase: 'measuring', updatedAt: Date.now() }),
    );
    await until(async () => {
      const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
      return st.botState === 'weighing_scale';
    }, 80, 20);
    await writeFile(
      join(hsSessDir, 'live-session.json'),
      JSON.stringify({ sessionId: 'm-live-1', phase: 'completed', updatedAt: Date.now() }),
    );
    await until(async () => {
      const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { botState?: string };
      return st.botState !== 'weighing_scale';
    }, 80, 20);

    // Dashboard & layout actions via cs80-face plugin
    const dashRes = await runPlugin(home, 'cs80-face', 'dashboard', {});
    assert.equal(dashRes.ok, true);
    assert.equal(dashRes.notify, false);
    const dashData = dashRes.data as {
      layout?: { gridRows?: number; pages?: unknown[] };
      catalog?: Array<{ kind: string }>;
      previewDataUrl?: string;
    };
    assert.equal(dashData.layout?.gridRows, 2);
    assert.ok((dashData.catalog?.length ?? 0) >= 11);
    assert.match(String(dashData.previewDataUrl ?? ''), /^data:image\/png;base64,/);

    const layoutRes = await runPlugin(home, 'cs80-face', 'layout', {
      gridRows: 3,
      marqueeMode: 'continuous',
      pages: [
        {
          id: 'p-custom',
          name: '自定义页',
          cards: [
            { id: 'c-mem', kind: 'memory', size: '2x1' },
            { id: 'c-fund', kind: 'fund-tracker', size: '1x1' },
            { id: 'c-health', kind: 'health-scale', size: '1x1' },
            { id: 'c-miot', kind: 'miot', size: '2x1' },
          ],
        },
      ],
      includePreview: true,
      silent: true,
    });
    assert.equal(layoutRes.ok, true);
    assert.equal(layoutRes.notify, false);
    const layoutData = layoutRes.data as {
      layout?: { gridRows?: number; marqueeMode?: string };
      previewDataUrl?: string;
    };
    assert.equal(layoutData.layout?.gridRows, 3);
    assert.equal(layoutData.layout?.marqueeMode, 'continuous');
    assert.match(String(layoutData.previewDataUrl ?? ''), /^data:image\/png;base64,/);
    const savedLayout = JSON.parse(await readFile(join(home, 'plugins', 'cs80-face', 'layout.json'), 'utf8')) as {
      gridRows?: number;
      marqueeMode?: string;
    };
    assert.equal(savedLayout.gridRows, 3);
    assert.equal(savedLayout.marqueeMode, 'continuous');

    // Inspect binary protocol records captured by mock sidecar
    const lines = (await readFile(mockLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);

    assert.ok(lines.some(r => r.type === '0x04' && r.bytes === 2048000), '0x04 full BGR565 frame sent');
    assert.ok(lines.some(r => r.type === '0x02' && Number(r.tiles) > 0), '0x02 dirty tile patch sent');
    assert.ok(lines.some(r => r.type === '0x03' && r.cmd === 1 && r.arg === 95), '0x03 brightness=95 sent');
    assert.ok(lines.some(r => r.type === '0x03' && r.cmd === 1 && r.arg === 100), '0x03 brightness=100 sent');
    for (const sub of [2, 3, 4, 5, 6]) {
      assert.ok(lines.some(r => r.type === '0x05' && r.sub === sub), `0x05 audio sub=${sub} sent`);
    }
    assert.ok(lines.some(r => r.type === '0x06' && Number(r.len) > 0), '0x06 MP3 upload chunk sent');
  } finally {
    if (prevPortEnv === undefined) delete process.env.CS80_FACE_PORT;
    else process.env.CS80_FACE_PORT = prevPortEnv;
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise<void>(res => proc.once('exit', () => res())),
        delay(2000),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    await rm(home, { recursive: true, force: true });
  }
});

test('4. Marquee 2-loop auto-pause, Bento packer, all-plugin FakeCairo smoke render & deriveFridayBotState listening state pass', async () => {
  assert.equal(
    deriveFridayBotState({
      ready: true,
      authExpired: false,
      staleConnection: false,
      sending: false,
      draftTyping: false,
      voiceListening: true,
      voiceTranscribing: false,
      messages: [],
      works: [],
    }),
    'listening',
  );
  assert.equal(
    deriveFridayBotState({
      ready: true,
      authExpired: false,
      staleConnection: false,
      sending: false,
      draftTyping: false,
      voiceListening: false,
      voiceTranscribing: true,
      messages: [],
      works: [],
    }),
    'thinking',
  );

  const tmpHome = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-widgets-'));
  try {
    const customDir = join(tmpHome, 'plugins', 'demo-custom');
    await mkdir(customDir, { recursive: true });
    await writeFile(
      join(customDir, 'plugin.json'),
      JSON.stringify({
        name: 'demo-custom',
        title: '自定义测试插件',
        description: '测试自定义插件发现与动态卡片渲染',
        actions: ['status', 'dashboard'],
      }),
    );

    const pySmoke = `
import json, sys, types
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'tools', 'cs80-face'))})

# Synthetic FakeCairo verifying every _render_cairo / _fit_single_line_cairo / card branch cleanly
class _Extents:
    def __init__(self, txt):
        self.x_advance = float(len(txt) * 10)
        self.width = self.x_advance
        self.height = 18.0

class _Grad:
    def __init__(self, *args): pass
    def add_color_stop_rgba(self, *args): pass

class _Surf:
    created_widths = []
    def __init__(self, fmt, w, h):
        self._w, self._h = w, h
        _Surf.created_widths.append(w)
    @classmethod
    def create_for_data(cls, buf, fmt, w, h, stride):
        return cls(fmt, w, h)
    @classmethod
    def create_from_png(cls, path):
        return cls(0, 710, 624)
    def get_width(self): return self._w
    def get_height(self): return self._h
    def flush(self): pass
    def write_to_png(self, buf): buf.write(b"\\x89PNG\\r\\n\\x1a\\nfakepng")

class _Ctx:
    shown_texts = []
    def __init__(self, surf): self._surf = surf
    def save(self): pass
    def restore(self): pass
    def translate(self, x, y): pass
    def scale(self, sx, sy): pass
    def rotate(self, rad): pass
    def set_antialias(self, a): pass
    def set_source_rgb(self, *rgb): pass
    def set_source_rgba(self, *rgba): pass
    def set_source_surface(self, surf, x=0.0, y=0.0): pass
    def set_source(self, grad): pass
    def paint(self): pass
    def new_path(self): pass
    def new_sub_path(self): pass
    def close_path(self): pass
    def move_to(self, x, y): pass
    def line_to(self, x, y): pass
    def arc(self, *a): pass
    def rectangle(self, *a): pass
    def clip(self): pass
    def fill(self): pass
    def fill_preserve(self): pass
    def stroke(self): pass
    def set_line_width(self, w): pass
    def set_line_cap(self, c): pass
    def set_line_join(self, j): pass
    def select_font_face(self, *a): pass
    def set_font_size(self, s): pass
    def show_text(self, s):
        _Ctx.shown_texts.append(str(s or ""))
    def text_extents(self, s): return _Extents(str(s or ""))

fake_cairo = types.ModuleType("cairo")
fake_cairo.FORMAT_ARGB32 = 0
fake_cairo.ANTIALIAS_BEST = 0
fake_cairo.FONT_SLANT_NORMAL = 0
fake_cairo.FONT_WEIGHT_BOLD = 1
fake_cairo.FONT_WEIGHT_NORMAL = 0
fake_cairo.LINE_CAP_ROUND = 1
fake_cairo.LINE_JOIN_ROUND = 1
fake_cairo.ImageSurface = _Surf
fake_cairo.Context = _Ctx
fake_cairo.LinearGradient = _Grad
fake_cairo.RadialGradient = _Grad

import renderer as rmod
from avatar_math import BotAnimator
from widgets import LayoutStore, discover_widget_catalog, pack_bento_page

# 1. MarqueeController short fit, truncation cap <= 121 chars & 2-loop auto_pause settle
mc = rmod.MarqueeController()
mc.set_content("短文本消息", 100.0, 500.0, mode="auto_pause", speed_level=2)
assert mc.phase == "rest" and mc.next_wakeup_delay() is None

mc.set_content("长" * 2500, 900.0, 420.0, mode="auto_pause", speed_level=3)
assert len(mc.text) <= rmod.MAX_MARQUEE_CHARS + 1 and mc.text.endswith("…")

mc.set_content("这是一条超长的跑马灯通知消息，需要完整滚动两圈之后自动停止并回到开头", 900.0, 420.0, mode="auto_pause", speed_level=3)
assert mc.phase == "lead_pause"
for _ in range(6):
    mc.step(0.25)
assert mc.phase == "scroll"
for _ in range(400):
    mc.step(0.1)
    if mc.phase == "rest":
        break
assert mc.phase == "rest" and mc.loops_done == 2 and mc.scroll_x == 0.0 and mc.next_wakeup_delay() is None

# 1b. Verify bgra_band_to_bgr565 + diff_tiles_band produce exact (tx, ty) coordinates vs full diff
import struct as _st
r_band = rmod.FaceRenderer()
band_bgra = bytearray(rmod.WIDTH * rmod.HEIGHT * 4)
ref_565 = bytearray(rmod.FRAME_BYTES)
prev_565 = bytearray(rmod.FRAME_BYTES)
band_565 = bytearray(rmod.FRAME_BYTES)
off_px = (658 * rmod.WIDTH + 96) * 4
band_bgra[off_px : off_px + 4] = bytes([0x10, 0xB9, 0x81, 0xFF])
r_band.fast.bgra_to_bgr565(band_bgra, ref_565)
r_band.fast.bgra_band_to_bgr565(band_bgra, band_565, 640, 704)
assert band_565 == ref_565, "band BGR565 mismatch"
tiles_full = bytearray(160 * rmod.TILE_MSG_BYTES)
tiles_band = bytearray(160 * rmod.TILE_MSG_BYTES)
n_full = r_band.fast.diff_tiles(prev_565, ref_565, tiles_full, 160)
n_band = r_band.fast.diff_tiles_band(prev_565, band_565, tiles_band, 640, 704, 160)
assert n_full == 1 and n_band == 1, (n_full, n_band)
assert _st.unpack_from("<HH", tiles_band, 0) == (96, 656) and tiles_band[:1032] == tiles_full[:1032]

# 2. Check fallback tile-diff count stays <= 160 during marquee step
_orig_cairo = rmod.cairo
rmod.cairo = None
try:
    r_fb = rmod.FaceRenderer()
    anim = BotAnimator()
    anim.set_state("idle")
    snap = anim.step(0.05)
    hud_scroll = rmod.HudState(
        headline_source="WX · 22:00",
        headline_text="A" * 80,
        marquee_mode="continuous",
        friday_connected=True,
        clock_hm="22:00",
    )
    r_fb.render_frame(snap, hud_scroll)
    r_fb.marquee.phase = "scroll"
    r_fb.marquee.scroll_x += 32.0
    # Advance marquee only while keeping stage/bento identical
    r_fb._render_fallback_bgra(snap, hud_scroll, placed_cards=())
    r_fb.fast.bgra_to_bgr565(r_fb._bgra, r_fb._curr565)
    dirty = r_fb.fast.diff_tiles(r_fb._prev565, r_fb._curr565, r_fb._tiles_buf, 160)
    assert dirty <= 160, f"marquee step dirtied {dirty} tiles > 160"
finally:
    rmod.cairo = _orig_cairo

# 3. LayoutStore, Bento packer, all-15-builtin + custom plugin catalog & telemetry collectors
import sqlite3, time as _time
from widgets import WidgetDataHub, _extract_scalars, _localize_laifen_name, _localize_netlea_name, _wgs84_to_gcj02, default_pages_payload

assert _localize_laifen_name("LFTB01-P-640A") == "徕芬电动牙刷"
assert _localize_laifen_name("LFTB02-PRO") == "徕芬电动牙刷"
assert _localize_laifen_name("LFTB") == "徕芬电动牙刷"
assert _localize_laifen_name("") == "徕芬电动牙刷"
assert _localize_laifen_name("主卧牙刷") == "主卧牙刷"
assert _localize_netlea_name("SG-X-PRO-60w11") == "尼特利鱼缸灯"
assert _localize_netlea_name("SG-AT5-45") == "尼特利鱼缸灯"
assert _localize_netlea_name("") == "尼特利鱼缸灯"
assert _localize_netlea_name("客厅水草灯") == "客厅水草灯"

expected_builtin_kinds = {
    "fund-tracker", "health-scale", "miot", "ninebot", "laifen", "netlea", "apple-devices",
    "tv-agent", "tv-ir", "system-pulse", "memory", "timers", "usage", "weather", "workers",
}

def_pages = default_pages_payload()
assert len(def_pages) == 5, f"expected 5 default pages, got {len(def_pages)}"
def_kinds = {c["kind"] for p in def_pages for c in p["cards"]}
assert def_kinds == expected_builtin_kinds, f"default pages mismatch: missing={expected_builtin_kinds - def_kinds}, extra={def_kinds - expected_builtin_kinds}"

home = Path(${JSON.stringify(tmpHome)})
ls = LayoutStore(home / "plugins" / "cs80-face")
legacy_cfg, _, _ = ls.apply_patch({
    "weatherCity": "西安",
    "pages": [{
        "id": "legacy",
        "name": "旧版兼容",
        "cards": [
            {"id": "c-lf", "kind": "plugin:laifen", "plugin": "laifen", "action": "dashboard", "title": "徕芬扫振电动牙刷与口腔护理", "size": "2x1"},
            {"id": "c-nl", "kind": "plugin:netlea", "plugin": "netlea", "action": "dashboard", "title": "尼特利鱼缸灯蓝牙直控 (Netlea BLE)", "size": "2x1"},
        ],
    }],
})
assert legacy_cfg["weatherCity"] == "西安"
assert abs(legacy_cfg["weatherLat"] - 34.2658) < 1e-4 and abs(legacy_cfg["weatherLon"] - 108.9541) < 1e-4, legacy_cfg
assert [c["kind"] for c in legacy_cfg["pages"][0]["cards"]] == ["laifen", "netlea"], legacy_cfg["pages"]
assert "plugin" not in legacy_cfg["pages"][0]["cards"][0] and "title" not in legacy_cfg["pages"][0]["cards"][0]
reset_cfg, _, _ = ls.apply_patch({"reset": True})
assert len(reset_cfg["pages"]) == 5 and reset_cfg["weatherCity"] == "西安" and abs(reset_cfg["weatherLat"] - 34.2658) < 1e-4

cfg, grid_changed, added = ls.apply_patch({
    "gridRows": 3,
    "pages": [{
        "id": "p1",
        "name": "全插件混排",
        "cards": [
            {"id": "c1", "kind": "fund-tracker", "size": "2x1"},
            {"id": "c2", "kind": "health-scale", "size": "1x2"},
            {"id": "c3", "kind": "plugin:demo-custom", "action": "dashboard", "size": "1x1"},
            {"id": "c4", "kind": "miot", "size": "1x1"},
        ],
    }],
})
assert grid_changed and cfg["gridRows"] == 3 and "fund-tracker" in cfg["pages"][0]["cards"][0]["kind"]
catalog = discover_widget_catalog(home, repo_plugins_dir=Path(${JSON.stringify(join(REPO_ROOT, 'plugins'))}))
catalog_kinds = {item["kind"] for item in catalog}
assert expected_builtin_kinds.issubset(catalog_kinds), f"missing builtin kinds: {expected_builtin_kinds - catalog_kinds}"
assert "plugin:demo-custom" in catalog_kinds, "missing custom plugin in catalog"

# 3b. Verify _extract_scalars & _collect_custom_plugin strip internal noise keys and translate without action=status
noise_payload = {
    "pid": 4242,
    "updatedAt": 1700000000000,
    "fromCache": True,
    "refreshed": False,
    "targetMac": "AA:BB:CC:DD:EE:FF",
    "configPath": "/tmp/secret-config.json",
    "batteryPct": 86,
    "todayCount": 2,
    "streakDays": 5,
    "temperature": 24.5,
    "status": "running",
}
scalars = _extract_scalars(noise_payload)
scalar_labels = [k for k, _ in scalars]
for blocked in ("pid", "updatedAt", "fromCache", "refreshed", "targetMac", "configPath"):
    assert all(blocked.lower() not in lbl.lower() for lbl in scalar_labels), (blocked, scalars)
assert ("电量", "86%") in scalars, scalars
assert ("今日次数", "2次") in scalars, scalars
assert ("连续打卡", "5天") in scalars, scalars
assert ("状态", "运行中") in scalars, scalars

def _mock_rpc(req, timeout):
    plug = req.get("plugin")
    if plug == "demo-custom":
        return {"ok": True, "title": "自定义测试", "message": "", "data": dict(noise_payload)}
    if plug == "laifen":
        return {
            "ok": True,
            "data": {
                "device": {"name": "LFTB", "batteryPct": 90, "activeMode": 3, "activeStrength": 12, "activeRange": 9, "activeSpeed": 7, "durationSec": 120, "lastSyncedAt": int(_time.time() * 1000)},
                "stats": {"todayCount": 2, "dailyGoalCount": 2, "streakDays": 9, "totalSessions": 18, "last7Days": [{"count": 2}] * 7, "brushHead": {"daysLeft": 72, "percentLeft": 80.0}},
                "watchStatus": {"running": False},
                "config": {"dailyGoalCount": 2},
            },
        }
    if plug == "netlea":
        return {
            "ok": True,
            "data": {
                "updatedAt": int(_time.time() * 1000),
                "device": {"name": "尼特利水草灯"},
                "state": {"on": True, "channels": {"red": 69, "green": 54, "white": 98, "blue": 54, "fan": 2}, "master": {"lampMode": 0, "stateType": 1}},
                "config": {"defaultChannels": {"red": 69, "green": 54, "white": 98, "blue": 54}},
            },
        }
    if plug == "apple-devices":
        return {
            "ok": True,
            "data": {
                "authState": "authenticated",
                "fetchedAt": int(_time.time() * 1000),
                "devices": [{"name": "iPhone 16 Pro", "category": "iphone", "batteryPercent": 82, "batteryStatus": "NotCharging", "online": True, "place": {"name": "家", "inside": True}}],
                "config": {"minBatteryPct": 25},
            },
        }
    return {"ok": True, "data": {}}

hub = WidgetDataHub(home, _mock_rpc, ls, disable_network=True)
hub._collect_custom_plugin("plugin:demo-custom#dc", {"id": "dc", "kind": "plugin:demo-custom", "plugin": "demo-custom", "action": "status", "title": "自定义测试"}, connected=True)
custom_w = hub.get_widget("plugin:demo-custom", "dc")
assert custom_w["ok"] is True
assert ("电量", "86%") in custom_w["kpis"] and ("今日次数", "2次") in custom_w["kpis"], custom_w
custom_text = json.dumps(custom_w["kpis"], ensure_ascii=False) + " " + custom_w["headline"] + " " + custom_w["subline"] + " " + custom_w["message"]
for forbidden in ("pid", "updatedAt", "fromCache", "refreshed", "targetMac", "configPath", "action=status"):
    assert forbidden not in custom_text, (forbidden, custom_text)
hub._collect_custom_plugin("plugin:demo-custom#dc2", {"id": "dc2", "kind": "plugin:demo-custom", "plugin": "demo-custom", "action": "status", "title": "自定义测试"}, connected=False)
custom_off = hub.get_widget("plugin:demo-custom", "dc2")
assert "action=status" not in (custom_off["headline"] + " " + custom_off["subline"] + " " + custom_off["message"])

# 3c. Verify laifen, netlea, apple-devices collectors (local fallback & RPC) without exposing raw GPS coords
laifen_dir = home / "plugins" / "laifen"
laifen_dir.mkdir(parents=True, exist_ok=True)
(laifen_dir / "config.json").write_text(json.dumps({"dailyGoalCount": 2, "brushHeadLifespanDays": 90}), encoding="utf-8")
laifen_db = laifen_dir / "laifen.db"
now_ms = int(_time.time() * 1000)
con_lf = sqlite3.connect(str(laifen_db))
con_lf.execute("CREATE TABLE device_state (id TEXT PRIMARY KEY, name TEXT, battery_pct INTEGER, active_mode INTEGER, modes_json TEXT, duration_sec INTEGER, status TEXT, updated_at INTEGER, last_synced_at INTEGER)")
con_lf.execute("CREATE TABLE brush_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, brushed_at INTEGER)")
con_lf.execute("INSERT INTO device_state VALUES ('primary', 'LFTB', 84, 2, ?, 120, 'Idle', ?, ?)", (json.dumps({"2": {"strength": 10, "range": 8, "speed": 6}}), now_ms, now_ms))
con_lf.execute("INSERT INTO brush_sessions (brushed_at) VALUES (?)", (now_ms - 60000,))
con_lf.execute("INSERT INTO brush_sessions (brushed_at) VALUES (?)", (now_ms - 30000,))
con_lf.commit()
con_lf.close()
hub._collect_laifen(laifen_db, connected=False)
lf_w = hub.get_widget("laifen")
assert lf_w["ok"] is True and lf_w["battery"] == 84 and lf_w["modeLabel"] == "日常清洁" and lf_w["todayCount"] == 2 and len(lf_w["weekCounts"]) == 7, lf_w
assert "84%" in lf_w["headline"] and "今日 2/2 次" in lf_w["subline"], lf_w

netlea_dir = home / "plugins" / "netlea"
netlea_dir.mkdir(parents=True, exist_ok=True)
(netlea_dir / "config.json").write_text(json.dumps({"defaultChannels": {"red": 69, "green": 54, "white": 98, "blue": 54}}), encoding="utf-8")
netlea_state = netlea_dir / "last-state.json"
netlea_state.write_text(json.dumps({
    "updatedAt": now_ms,
    "device": {"name": "尼特利水草灯"},
    "state": {"on": True, "channels": {"red": 69, "green": 54, "white": 98, "blue": 54, "fan": 2}, "master": {"lampMode": 0, "stateType": 1}},
}), encoding="utf-8")
hub._collect_netlea(netlea_state, connected=False)
nl_w = hub.get_widget("netlea")
assert nl_w["ok"] is True and nl_w["on"] is True and nl_w["brightness"] == 100 and nl_w["modeLabel"] == "自动行程" and nl_w["fan"] == 2, nl_w
assert "开启" in nl_w["headline"] and "自动行程" in nl_w["subline"], nl_w

apple_dir = home / "plugins" / "apple-devices"
apple_dir.mkdir(parents=True, exist_ok=True)
(apple_dir / "session.json").write_text(json.dumps({"state": "authenticated"}), encoding="utf-8")
(apple_dir / "config.json").write_text(json.dumps({"minBatteryPct": 25, "places": {"家": {"lat": 31.2304, "lng": 121.4737, "radiusMeters": 300}}}), encoding="utf-8")
apple_cache = apple_dir / "devices-cache.json"
apple_cache.write_text(json.dumps({
    "fetchedAt": now_ms,
    "entries": [
        {"device": {"name": "iPhone 16 Pro", "category": "iphone", "batteryPercent": 85, "batteryStatus": "NotCharging", "online": True, "location": {"latitude": 31.2305, "longitude": 121.4738}}},
        {"device": {"name": "AirPods Pro", "category": "airpods", "batteryPercent": 15, "batteryStatus": "NotCharging", "online": True, "location": {"latitude": 31.2988, "longitude": 121.5299}}},
    ],
}), encoding="utf-8")
hub._collect_apple_devices(apple_cache, connected=False)
ap_w = hub.get_widget("apple-devices")
assert ap_w["ok"] is True and ap_w["total"] == 2 and ap_w["online"] == 2 and ap_w["lowCount"] == 1, ap_w
assert ap_w["devices"][0]["catLabel"] == "手机" and ap_w["devices"][0]["place"] == "在家", ap_w
ap_dump = json.dumps(ap_w, ensure_ascii=False)
for raw_geo in ("latitude", "longitude", "31.2305", "121.4738", "31.2988", "121.5299"):
    assert raw_geo not in ap_dump, (raw_geo, ap_dump)
for dev in ap_w["devices"]:
    assert not any(k in dev for k in ("location", "lat", "lon", "lng")), dev

# Also verify connected RPC path for laifen, netlea, apple-devices
hub._collect_laifen(laifen_db, connected=True)
assert hub.get_widget("laifen")["battery"] == 90
hub._collect_netlea(netlea_state, connected=True)
assert hub.get_widget("netlea")["brightness"] == 100
hub._collect_apple_devices(apple_cache, connected=True)
assert hub.get_widget("apple-devices")["online"] == 1

# Verify GCJ-02 geofence matches WGS-84 Apple location & outside-fence shortAddress displays without leaking coordinates
gcj_home_lat, gcj_home_lon = _wgs84_to_gcj02(31.2305, 121.4738)
(apple_dir / "config.json").write_text(json.dumps({
    "minBatteryPct": 25,
    "places": {"家": {"lat": gcj_home_lat, "lng": gcj_home_lon, "radiusMeters": 120}},
}), encoding="utf-8")
apple_cache.write_text(json.dumps({
    "fetchedAt": now_ms,
    "entries": [
        {"device": {"name": "张三的 iPhone 17 Pro Max", "category": "iphone", "batteryPercent": 88, "batteryStatus": "NotCharging", "online": True, "location": {"latitude": 31.2305, "longitude": 121.4738, "shortAddress": "黄浦区人民广场"}}},
        {"device": {"name": "我的 MacBook Pro 14-inch M4", "category": "mac", "batteryPercent": 72, "batteryStatus": "NotCharging", "online": True, "location": {"latitude": 31.2988, "longitude": 121.5299, "shortAddress": "杨浦区五角场万达"}}},
    ],
}), encoding="utf-8")
hub._collect_apple_devices(apple_cache, connected=False)
ap_geo_w = hub.get_widget("apple-devices")
assert ap_geo_w["devices"][0]["name"] == "张三的 iPhone 17 Pro Max", ap_geo_w
assert ap_geo_w["devices"][1]["name"] == "我的 MacBook Pro 14-inch M4", ap_geo_w
assert "张三的 iPhone 17 Pro Max" in ap_geo_w["subline"], ap_geo_w
assert ap_geo_w["devices"][0]["place"] == "在家", ap_geo_w
assert ap_geo_w["devices"][1]["place"] == "杨浦区五角场万达", ap_geo_w
ap_geo_dump = json.dumps(ap_geo_w, ensure_ascii=False)
for raw_geo in ("latitude", "longitude", "31.2305", "121.4738", "31.2988", "121.5299"):
    assert raw_geo not in ap_geo_dump, (raw_geo, ap_geo_dump)

# 4. FakeCairo smoke render across ALL 15 built-in cards + plugin:demo-custom, all 4 sizes, both grid_rows, and Chinese HUD checks
rmod.cairo = fake_cairo
try:
    _Ctx.shown_texts.clear()
    r_fc = rmod.FaceRenderer()
    anim.set_state("listening")
    lsnap = anim.step(0.08, center_x=400.0, center_y=272.0, base_radius=132.0)
    all_kinds = sorted(expected_builtin_kinds) + ["plugin:demo-custom"]
    all_sizes = ("1x1", "2x1", "1x2", "2x2")
    sample_data = {
        "fund-tracker": {"ok": True, "dailyPct": 1.25, "dailyPnl": 600, "totalPnl": 3200, "totalPnlPct": 8.4, "holdingCount": 3, "subline": "今日 +600", "spark": [100, 120, 115, 140], "holdings": [{"code": "000300", "name": "沪深300", "changePct": 1.25}]},
        "health-scale": {"ok": True, "weightKg": 68.2, "diffKg": -0.2, "bodyFat": 17.5, "musclePct": 44.1, "bmi": 22.0, "score": 89, "waterPct": 58.0, "visceral": 6, "spark": [68.9, 68.5, 68.2]},
        "miot": {"ok": True, "online": 4, "total": 5, "onCount": 2, "rooms": 3, "envTemp": 24.6, "envHum": 52, "devices": [{"name": "灯", "room": "客厅", "online": True, "on": True}]},
        "ninebot": {"ok": True, "name": "九号M95C", "battery": 80, "auxBattery": 93, "voltageV": 75.3, "tempC": 26.0, "charging": True, "chargingPowerW": 310, "remainChargeTime": "1h20m", "rangeKm": 99.6, "odometerKm": 1234.5, "powerOn": False, "locked": True, "address": "科技路1号", "monthKm": 88.2, "maxSpeedKmh": 68.0, "alertCount": 0, "updatedHm": "01:45", "spark": [90, 84, 78, 80]},
        "laifen": {"ok": True, "empty": False, "name": "徕芬声波牙刷", "battery": 84, "mode": 2, "modeLabel": "日常清洁", "todayCount": 2, "dailyGoal": 2, "streakDays": 12, "brushDaysLeft": 64, "brushPct": 71.1, "strength": 10, "range": 8, "speed": 6, "durationSec": 120, "watching": False, "weekCounts": [2, 1, 2, 2, 2, 1, 2], "updatedHm": "08:15"},
        "netlea": {"ok": True, "empty": False, "name": "尼特利水草灯", "on": True, "modeLabel": "自动行程", "brightness": 78, "red": 68, "green": 52, "white": 92, "blue": 48, "fan": 2, "updatedHm": "12:30"},
        "apple-devices": {"ok": True, "empty": False, "authState": "authenticated", "total": 3, "online": 2, "lowCount": 1, "devices": [{"name": "iPhone 16 Pro", "catLabel": "手机", "battery": 82, "charging": False, "online": True, "place": "在家中"}, {"name": "AirPods Pro", "catLabel": "耳机", "battery": 15, "charging": False, "online": True, "place": "距公司1km"}], "updatedHm": "12:40"},
        "system-pulse": {"ok": True, "cpuPct": 12.0, "memPct": 42.0, "memUsedGb": 3.1, "memTotalGb": 7.6, "diskPct": 50.0, "diskFreeGb": 100.0, "load1": 0.35, "nextTimer": "巡检 12:00"},
        "tv-agent": {"ok": True, "online": True, "appName": "哔哩哔哩", "volume": 24, "muted": False, "dlnaOk": True, "agentOk": True},
        "tv-ir": {"ok": True, "txReady": True, "learnedCount": 4, "headline": "全向红外就绪", "subline": "预设 12 键"},
        "memory": {"ok": True, "totalActive": 20, "pinnedCount": 4, "nodeCount": 6, "edges": [(0, 1, 0.8), (1, 2, 0.5)], "topics": ["CS80"]},
        "timers": {"ok": True, "enabled": 1, "total": 2, "rows": [{"name": "午间估值", "nextHm": "12:00", "goal": True}]},
        "usage": {"ok": True, "calls": 18, "tokStr": "12.4k", "costCny": 1.25, "costUsd": 0.17},
        "weather": {"ok": True, "city": "上海", "temp": 22.0, "feelsLike": 21.0, "tempMax": 25.0, "tempMin": 16.0, "humidity": 55, "wcode": 1, "desc": "晴", "windDesc": "轻风"},
        "workers": {"ok": True, "count": 1, "rows": [{"profile": "coding", "prompt": "测试", "elapsedSec": 8}]},
        "plugin:demo-custom#dc": {"ok": True, "plugin": "demo-custom", "action": "status", "title": "测试扩展", "kpis": [("电量", "86%"), ("今日次数", "2次"), ("状态", "运行中")]},
    }
    for rows in (2, 3):
        geo = rmod.stage_geometry_for_rows(rows)
        for kind in all_kinds:
            for sz in all_sizes:
                cid = "dc" if kind.startswith("plugin:") else "c0"
                cards, ov = pack_bento_page(
                    [{"id": cid, "kind": kind, "size": sz}],
                    grid_rows=rows,
                    x0=36.0,
                    y0=geo["grid_y"],
                    total_w=728.0,
                    total_h=geo["grid_h"],
                    gap=geo["gap"],
                )
                assert ov == 0 and len(cards) == 1, (rows, kind, sz, ov)
                hud_fc = rmod.HudState(
                    grid_rows=rows,
                    headline_source="XIAOAI",
                    headline_text="A" * 90,
                    voice_caption='已唤醒 "星期五"',
                    workers=(rmod.WorkerSummary(task_id="w1", profile="coding", prompt="校验渲染", elapsed_sec=8),),
                    channels=(("WX", True), ("XIAOAI", True), ("TG", False)),
                    speaker_muted=(sz == "2x2"),
                    friday_connected=True,
                    auto_task_overlay=False,
                    page_count=2,
                    active_page=0,
                )
                r_fc.render_frame(lsnap, hud_fc, placed_cards=cards, widget_data=sample_data)

    # Verify long Apple device names render untruncated (single-line & 2-line capsule wrap)
    geo2 = rmod.stage_geometry_for_rows(2)
    ap_cards, ap_ov = pack_bento_page(
        [{"id": "c-ap-long", "kind": "apple-devices", "size": "2x1"}],
        grid_rows=2,
        x0=36.0,
        y0=geo2["grid_y"],
        total_w=728.0,
        total_h=geo2["grid_h"],
        gap=geo2["gap"],
    )
    assert ap_ov == 0 and len(ap_cards) == 1
    ap_long_name_1 = "张三的 iPhone 16 Pro Max (主力)"
    ap_long_name_2 = "张三的 MacBook Pro 14-inch M4 Max 工作室主力机"
    ap_long_data = {
        "apple-devices": {
            "ok": True,
            "empty": False,
            "authState": "authenticated",
            "total": 2,
            "online": 2,
            "lowCount": 0,
            "devices": [
                {"name": ap_long_name_1, "catLabel": "手机", "battery": 88, "charging": True, "online": True, "place": "在家"},
                {"name": ap_long_name_2, "catLabel": "电脑", "battery": 76, "charging": False, "online": True, "place": "工作室"},
            ],
            "updatedHm": "12:40",
        }
    }
    mark_idx = len(_Ctx.shown_texts)
    r_fc._card_apple_devices(_Ctx(_Surf(0, 800, 1280)), ap_cards[0], ap_long_data["apple-devices"])
    ap_texts = _Ctx.shown_texts[mark_idx:]
    assert ap_long_name_1 in ap_texts, ap_texts
    wrapped_joined = "".join(t for t in ap_texts if t.startswith("张三的 MacBook") or t == "作室主力机")
    assert wrapped_joined == ap_long_name_2, (ap_texts, wrapped_joined)
    assert not any("…" in t and "MacBook" in t for t in ap_texts), ap_texts

    # Render all HUD states (incl. REM sleep + auto_task_overlay) and verify pure Chinese badges & labels
    for st_id, (badge_lbl, _) in rmod.STATE_BADGES.items():
        assert any(ord(ch) > 127 for ch in badge_lbl), (st_id, badge_lbl)
    for st_id in rmod.STATE_BADGES:
        anim_st = BotAnimator()
        sub_p = "rem" if st_id == "sleeping" else "awake"
        anim_st.set_state(st_id, sub_phase=sub_p, worker_count=(2 if st_id == "working" else 0))
        st_snap = anim_st.step(0.08, center_x=400.0, center_y=272.0, base_radius=132.0)
        hud_st = rmod.HudState(
            grid_rows=3,
            headline_source="WX · 22:00",
            headline_text="状态测试通知 ⚠️ ✅",
            ask_boss_question="确认继续执行吗？" if st_id == "sleeping" else "",
            workers=(rmod.WorkerSummary(task_id="w1", profile="research", prompt="中文任务摘要", elapsed_sec=12),),
            channels=(("WX", True), ("XIAOAI", True), ("TG", True)),
            speaker_muted=(st_id == "sleeping"),
            auto_task_overlay=(st_id == "sleeping"),
            friday_connected=True,
            page_count=1,
        )
        r_fc.render_frame(st_snap, hud_st, placed_cards=(), widget_data=sample_data)

    assert rmod._sanitize_hud_text("测试 ⚠️ ✅ ❌ 🔔") == "测试"
    all_rendered = " | ".join(_Ctx.shown_texts)
    for bad_tok in ("IDLE", "ONLINE", "TX READY", "SPK MUTE", "MEM ", "CALLS ", "ASK BOSS", "[!]", "[OK]", "P1/", "DLNA OK", "dashboard · OK", "batteryPct"):
        assert bad_tok not in all_rendered, f"found unlocalized token {bad_tok!r}"
    for good_tok in ("待机守候", "正在倾听", "梦境整理", "等待您的决策指示", "微信", "小爱", "电报", "已静音", "音量 65%"):
        assert good_tok in all_rendered, f"missing localized token {good_tok!r}"

    # Verify settled marquee-only scroll enters partial-band path and honors MAX_MARQUEE_SURF_W
    _Surf.created_widths.clear()
    anim_idle = BotAnimator()
    anim_idle.set_state("idle")
    s_idle = None
    for _ in range(30):
        s_idle = anim_idle.step(0.2, center_x=400.0, center_y=354.0, base_radius=168.0)
        if s_idle.settled:
            break
    assert s_idle is not None and s_idle.settled
    hud_long = rmod.HudState(
        grid_rows=2,
        headline_source="WX · 23:00",
        headline_text="长文本消息" * 600,
        marquee_mode="continuous",
        friday_connected=True,
        clock_hm="23:00",
    )
    r_fc2 = rmod.FaceRenderer()
    r_fc2.sync_marquee_metrics(hud_long)
    assert len(r_fc2.marquee.text) <= rmod.MAX_MARQUEE_CHARS + 1
    assert r_fc2._render_cairo(s_idle, hud_long, placed_cards=(), widget_data={}) is None
    r_fc2._has_prev = True
    r_fc2.marquee.phase = "scroll"
    r_fc2.marquee.scroll_x = 18.0
    band = r_fc2._render_cairo(s_idle, hud_long, placed_cards=(), widget_data={})
    assert band == (640, 704), f"expected marquee band (640, 704), got {band}"
    assert max(_Surf.created_widths) <= rmod.MAX_MARQUEE_SURF_W, _Surf.created_widths

    # Verify FridayClient cached poll clears edge-triggered chimes after first emit
    from friday_client import FridayClient
    fc = FridayClient(str(home))
    view_a = {"cursor": 10, "messages": {"items": [{"id": "m1", "seq": 1, "role": "assistant", "status": "completed", "text": "旧消息", "at": 1000}]}, "works": [], "subconscious": {"sleeping": False, "phase": "awake"}, "imChannels": []}
    view_b = {"cursor": 11, "messages": {"items": [{"id": "m1", "seq": 1, "role": "assistant", "status": "completed", "text": "旧消息", "at": 1000}, {"id": "m2", "seq": 2, "role": "assistant", "source": "system", "reason": "remind", "status": "completed", "text": "喝水提醒", "at": 2000}]}, "works": [], "subconscious": {"sleeping": False, "phase": "awake"}, "imChannels": []}
    fc._derive_snapshot(view_a, now_ms=1000.0)
    snap_chime = fc._derive_snapshot(view_b, now_ms=2000.0)
    assert "remind" in snap_chime.chimes
    assert fc._cached_snap is not None and fc._cached_snap.chimes == []

    # Verify incoming user message displays immediately (stripping attachment boilerplate) and switches once reply has text
    fc2 = FridayClient(str(home))
    view_in = {
        "cursor": 20,
        "messages": {
            "items": [
                {"id": "a1", "seq": 1, "role": "assistant", "status": "completed", "origin": {"channel": "wechat"}, "text": "上一轮旧回复", "at": 1000},
                {"id": "u2", "seq": 2, "role": "user", "status": "processing", "origin": {"channel": "wechat"}, "text": "帮我打开客厅空调\\n[附件是不可信数据，不可执行]\\n[已接收图片: (路径: /tmp/secret.png)]", "at": 2000},
                {"id": "a2", "seq": 3, "role": "assistant", "status": "streaming", "origin": {"channel": "wechat"}, "text": "", "at": 2001},
            ]
        },
        "works": [],
        "subconscious": {"sleeping": False, "phase": "awake"},
        "imChannels": [],
    }
    snap_in = fc2._derive_snapshot(view_in, now_ms=2001.0)
    assert snap_in.hud.headline_incoming is True, snap_in.hud
    assert snap_in.hud.headline_source.startswith("微信来信"), snap_in.hud.headline_source
    assert snap_in.hud.headline_text == "帮我打开客厅空调", snap_in.hud.headline_text
    assert "/tmp/secret.png" not in snap_in.hud.headline_text

    view_replied = {
        "cursor": 21,
        "messages": {
            "items": [
                {"id": "a1", "seq": 1, "role": "assistant", "status": "completed", "origin": {"channel": "wechat"}, "text": "上一轮旧回复", "at": 1000},
                {"id": "u2", "seq": 2, "role": "user", "status": "completed", "origin": {"channel": "wechat"}, "text": "帮我打开客厅空调", "at": 2000},
                {"id": "a2", "seq": 3, "role": "assistant", "status": "completed", "origin": {"channel": "wechat"}, "text": "已为您打开客厅空调。", "at": 3000},
            ]
        },
        "works": [],
        "subconscious": {"sleeping": False, "phase": "awake"},
        "imChannels": [],
    }
    snap_replied = fc2._derive_snapshot(view_replied, now_ms=3000.0)
    assert snap_replied.hud.headline_incoming is False, snap_replied.hud
    assert snap_replied.hud.headline_source.startswith("微信 ·"), snap_replied.hud.headline_source
    assert snap_replied.hud.headline_text == "已为您打开客厅空调。", snap_replied.hud.headline_text

    # Verify new 5 scene animations across grid_rows=2 & 3 in Cairo + fallback BGRA without error
    for rows in (2, 3):
        geo_sc = rmod.stage_geometry_for_rows(rows)
        for st_sc, sc_ch in (("speaking", "xiaoai"), ("sending_msg", "wechat"), ("sending_msg", "telegram"), ("printing", ""), ("operating_xiaoai", ""), ("operating_tv", ""), ("managing_laifen", ""), ("weighing_scale", "")):
            anim_sc = BotAnimator()
            anim_sc.set_state(st_sc)
            sc_snap = anim_sc.step(0.12, center_x=geo_sc["face_cx"], center_y=geo_sc["face_cy"], base_radius=geo_sc["face_r"])
            hud_sc = rmod.HudState(
                grid_rows=rows,
                headline_source="微信来信 · 15:20",
                headline_text="收到测试来信",
                headline_incoming=True,
                scene_channel=sc_ch,
                friday_connected=True,
                clock_hm="15:20",
            )
            r_fc.render_frame(sc_snap, hud_sc, placed_cards=(), widget_data={})
            r_fb._render_fallback_bgra(sc_snap, hud_sc, placed_cards=())

    # Verify Ninebot collector + renderer on locked low-battery M95C state (never misreports unlocked)
    nb_dir = home / "plugins" / "ninebot"
    nb_dir.mkdir(parents=True, exist_ok=True)
    (nb_dir / "config.json").write_text(json.dumps({"defaultSn": "M95C-LOCK-TST"}), encoding="utf-8")
    (nb_dir / "vehicle-dark.png").write_bytes(b"\\x89PNG\\r\\n\\x1a\\n" + b"\\x00" * 80)
    nb_db = nb_dir / "ninebot.sqlite"
    con_nb = sqlite3.connect(str(nb_db))
    con_nb.execute("CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT, captured_at INTEGER, battery INTEGER, aux_battery INTEGER, voltage_v REAL, temp_c REAL, charging INTEGER, charging_power_w REAL, effective_range_km REAL, odometer_km REAL, power_on INTEGER, locked INTEGER, gcj_lat REAL, gcj_lon REAL, address TEXT, payload_json TEXT)")
    con_nb.execute("CREATE TABLE trips (sn TEXT, travel_id TEXT, start_time INTEGER, end_time INTEGER, duration_sec INTEGER, distance_km REAL, max_speed_kmh REAL, avg_speed_kmh REAL, used_electricity REAL, month TEXT, payload_json TEXT, updated_at INTEGER)")
    con_nb.execute("CREATE TABLE alert_state (sn TEXT, alert_key TEXT, active INTEGER, last_notified_at INTEGER, last_value TEXT)")
    nb_payload = {"name": "小9", "modelName": "九号电动M95C", "color": "英伦绿", "capturedAt": now_ms, "battery": 12, "auxBattery": 100, "voltageV": 71.3, "temperatureC": 12, "charging": False, "effectiveRangeKm": 11.5, "odometerKm": 16529.8, "powerOn": False, "locked": True, "location": {"valid": True, "address": "科技路1号"}}
    con_nb.execute("INSERT INTO snapshots (sn, captured_at, battery, aux_battery, voltage_v, temp_c, charging, effective_range_km, odometer_km, power_on, locked, address, payload_json) VALUES (?, ?, 12, 100, 71.3, 12, 0, 11.5, 16529.8, 0, 1, '科技路1号', ?)", ("M95C-LOCK-TST", now_ms, json.dumps(nb_payload, ensure_ascii=False)))
    con_nb.execute("INSERT INTO alert_state VALUES (?, 'low_battery', 1, ?, '12')", ("M95C-LOCK-TST", now_ms))
    con_nb.commit()
    con_nb.close()
    hub._collect_ninebot(nb_db, connected=False)
    nb_w = hub.get_widget("ninebot")
    assert nb_w["ok"] is True and nb_w["locked"] is True and nb_w["powerOn"] is False, nb_w
    assert nb_w["subline"].startswith("已上锁") and nb_w["imagePath"].endswith("vehicle-dark.png"), nb_w

    _Ctx.shown_texts.clear()
    geo3 = rmod.stage_geometry_for_rows(3)
    for sz in ("1x1", "2x1", "1x2", "2x2"):
        cards_nb, _ = pack_bento_page([{"id": "nb", "kind": "ninebot", "size": sz}], grid_rows=3, x0=36.0, y0=geo3["grid_y"], total_w=728.0, total_h=geo3["grid_h"], gap=geo3["gap"])
        r_fc.render_frame(lsnap, rmod.HudState(grid_rows=3, friday_connected=True, auto_task_overlay=False), placed_cards=cards_nb, widget_data={"ninebot": nb_w})
    nb_rendered = " | ".join(_Ctx.shown_texts)
    assert "已上锁 · 低电" in nb_rendered and "已设防" in nb_rendered, nb_rendered
    assert "未锁车" not in nb_rendered and "未上锁" not in nb_rendered, nb_rendered
finally:
    rmod.cairo = _orig_cairo
`;
    execFileSync('python3', ['-c', pySmoke], { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

test('5. CS80 scene classifiers & inbound preview formatter accurately distinguish mutating actions from readonly queries', () => {
  assert.deepEqual(classifyPluginCs80Scene('tv-ir', 'press', { key: 'ok' })?.scene, 'operating_tv');
  assert.equal(classifyPluginCs80Scene('tv-ir', 'status', {}), undefined);
  assert.equal(classifyPluginCs80Scene('tv-ir', 'press', { key: 'ok', dryRun: true }), undefined);

  assert.deepEqual(classifyPluginCs80Scene('tv-agent', 'open_app', { app: 'bili' })?.scene, 'operating_tv');
  assert.deepEqual(classifyPluginCs80Scene('tv-agent', 'volume', { level: 30 })?.scene, 'operating_tv');
  assert.equal(classifyPluginCs80Scene('tv-agent', 'volume', {}), undefined);
  assert.equal(classifyPluginCs80Scene('tv-agent', 'cast', { op: 'info' }), undefined);
  assert.deepEqual(classifyPluginCs80Scene('tv-agent', 'cast', { op: 'play', url: 'http://x' })?.scene, 'operating_tv');

  assert.deepEqual(classifyPluginCs80Scene('miot', 'set', { device: '客厅灯', on: true })?.scene, 'operating_xiaoai');
  assert.deepEqual(classifyPluginCs80Scene('miot', 'set', { device: '客厅电视', on: false })?.scene, 'operating_tv');
  assert.equal(classifyPluginCs80Scene('miot', 'devices', { live: true }), undefined);
  assert.equal(classifyPluginCs80Scene('miot', 'cook', { op: 'status' }), undefined);
  assert.deepEqual(classifyPluginCs80Scene('miot', 'cook', { op: 'start', tempC: 180 })?.scene, 'operating_xiaoai');

  assert.deepEqual(classifyFastpathCs80Scene({ text: '打开客厅灯', platform: 'xiaoai' }, { handled: true, plugin: 'miot', action: 'set' })?.scene, 'operating_xiaoai');
  assert.deepEqual(classifyFastpathCs80Scene({ text: '确认', platform: 'xiaoai' }, { handled: true, plugin: 'tv-ir', action: 'press' })?.scene, 'operating_tv');
  assert.equal(classifyFastpathCs80Scene({ text: '', sessionState: { event: 'assistant_reply' } }, { handled: true, plugin: 'tv-ir', action: 'press' }), undefined);
  assert.equal(classifyFastpathCs80Scene({ text: '退出遥控', platform: 'xiaoai' }, { handled: true, plugin: 'tv-ir', action: 'tv_remote_exit' })?.phase, 'end');

  assert.deepEqual(classifyBashCommandCs80Scene('lp -d Office_HP /tmp/report.pdf')?.scene, 'printing');
  assert.deepEqual(classifyBashCommandCs80Scene('cd /tmp && lpr out.ps')?.scene, 'printing');
  assert.equal(classifyBashCommandCs80Scene('lpstat -p -d'), undefined);
  assert.equal(classifyBashCommandCs80Scene('grep lp README.md'), undefined);

  // Laifen toothbrush & Wolai A1 scale scenes (mutating triggers vs readonly queries)
  assert.deepEqual(classifyPluginCs80Scene('laifen', 'sync', {})?.scene, 'managing_laifen');
  assert.deepEqual(classifyPluginCs80Scene('laifen', 'set', { mode: 2 })?.scene, 'managing_laifen');
  assert.deepEqual(classifyPluginCs80Scene('laifen', 'status', { live: true })?.scene, 'managing_laifen');
  assert.equal(classifyPluginCs80Scene('laifen', 'status', {}), undefined);
  assert.equal(classifyPluginCs80Scene('laifen', 'dashboard', {}), undefined);
  assert.equal(classifyPluginCs80Scene('laifen', 'monitor-status', {}), undefined);
  assert.equal(classifyPluginCs80Scene('laifen', 'watch-start', {}), undefined);
  assert.equal(classifyPluginCs80Scene('laifen', 'config', {}), undefined);
  assert.equal(classifyPluginCs80Scene('laifen', 'monitor-stop', {})?.phase, 'end');

  assert.deepEqual(classifyPluginCs80Scene('health-scale', 'measure-start', { timeoutSec: 45 })?.scene, 'weighing_scale');
  assert.equal(classifyPluginCs80Scene('health-scale', 'measure-start', { timeoutSec: 45 })?.finishHoldSec, 50);
  assert.deepEqual(classifyPluginCs80Scene('health-scale', 'scan', {})?.scene, 'weighing_scale');
  assert.equal(classifyPluginCs80Scene('health-scale', 'dashboard', {}), undefined);
  assert.equal(classifyPluginCs80Scene('health-scale', 'measure-status', {}), undefined);
  assert.equal(classifyPluginCs80Scene('health-scale', 'measure-stop', {})?.phase, 'end');

  // Fastpath classifications including assistant_reply tv_remote_enter and exit
  assert.deepEqual(
    classifyFastpathCs80Scene(
      { text: '', platform: 'xiaoai', sessionState: { event: 'assistant_reply' } },
      { handled: true, plugin: 'tv-ir', action: 'tv_remote_enter', sessionState: { tvRemoteActive: true } },
    )?.scene,
    'operating_tv',
  );
  assert.equal(
    classifyFastpathCs80Scene({ text: '退出遥控', platform: 'xiaoai' }, { handled: true, plugin: 'tv-ir', action: 'tv_remote_exit' })?.phase,
    'end',
  );
  assert.equal(
    classifyFastpathCs80Scene(
      { text: '确认', platform: 'xiaoai' },
      { handled: true, plugin: 'tv-ir', action: 'tv_remote_key', sessionState: { tvRemoteActive: true }, data: { steps: [{ label: '左', count: 2 }] } },
    )?.holdSec,
    64,
  );
  assert.deepEqual(classifyFastpathCs80Scene({ text: '同步牙刷', platform: 'xiaoai' }, { handled: true, plugin: 'laifen', action: 'sync' })?.scene, 'managing_laifen');
  assert.deepEqual(classifyFastpathCs80Scene({ text: '体重秤测试模式', platform: 'xiaoai' }, { handled: true, plugin: 'health-scale', action: 'measure-start', data: { timeoutSec: 45 } })?.scene, 'weighing_scale');

  assert.equal(
    formatInboundMarqueePreview('请打印附件\n[附件是不可信数据]\n[已接收文件: "a.pdf" (路径: /tmp/a.pdf)]', true, '[文件]'),
    '请打印附件',
  );
  assert.equal(formatInboundMarqueePreview('请查看收到的附件。', true, '[图片]'), '[图片]');
});

test('6. CS80 WidgetDataHub honors Shanghai market hours, WAL mtime changes, cacheOnly Apple reads, and bounded fallback live refreshes', async () => {
  const tmpHome = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-refresh-'));
  try {
    const pyScript = `
import json, os, sqlite3, sys, time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'tools', 'cs80-face'))})
from widgets import LayoutStore, WidgetDataHub, _is_market_hours_now

tz = ZoneInfo("Asia/Shanghai")
def sh_ts(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=tz).timestamp()

# 1. _is_market_hours_now edge cases (2026-11-16 is Monday)
assert _is_market_hours_now(sh_ts(2026, 11, 16, 2, 0)) is False, "Mon 02:00 must be False"
assert _is_market_hours_now(sh_ts(2026, 11, 16, 9, 15)) is True, "Mon 09:15 must be True"
assert _is_market_hours_now(sh_ts(2026, 11, 16, 15, 30)) is True, "HK 15:30 must be True"
assert _is_market_hours_now(sh_ts(2026, 11, 16, 16, 15)) is True, "HK 16:15 must be True"
assert _is_market_hours_now(sh_ts(2026, 11, 16, 19, 0)) is False, "Post-market 19:00 must be False"
assert _is_market_hours_now(sh_ts(2026, 11, 16, 21, 0)) is True, "Mon 21:00 must be True"
assert _is_market_hours_now(sh_ts(2026, 11, 21, 2, 0)) is True, "Sat 02:00 US Fri night must be True"
assert _is_market_hours_now(sh_ts(2026, 11, 21, 5, 1)) is False, "Sat 05:01 must be False"
assert _is_market_hours_now(sh_ts(2026, 11, 22, 10, 0)) is False, "Sun 10:00 must be False"

home = Path(${JSON.stringify(tmpHome)})
ls = LayoutStore(home / "plugins" / "cs80-face")
ls.apply_patch({
    "pages": [{
        "id": "p1",
        "name": "测试页",
        "cards": [
            {"id": "c-fund", "kind": "fund-tracker", "size": "1x1"},
            {"id": "c-health", "kind": "health-scale", "size": "1x1"},
            {"id": "c-ninebot", "kind": "ninebot", "size": "1x1"},
        ],
    }],
})

now_ms = int(time.time() * 1000)
stale_ms = now_ms - (70 * 60 * 1000) # 70 min ago -> stale for all collectors

# Seed stale disk caches for all 5 plugins
fund_dir = home / "plugins" / "fund-tracker"
fund_dir.mkdir(parents=True, exist_ok=True)
(fund_dir / "config.json").write_text(json.dumps({"holdings": [{"code": "000001"}]}), encoding="utf-8")
fund_db = fund_dir / "funds.sqlite"
con_f = sqlite3.connect(str(fund_db))
con_f.execute("PRAGMA journal_mode=WAL")
con_f.execute("CREATE TABLE holdings (code TEXT PRIMARY KEY, name TEXT, cost REAL, shares REAL, last_nav REAL, last_nav_date TEXT)")
con_f.execute("CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, date TEXT, total_cost REAL, total_asset REAL, daily_pnl REAL, total_pnl REAL, detail_json TEXT, created_at INTEGER)")
con_f.execute("INSERT INTO holdings VALUES ('000001', '测试基', 1000, 1000, 1.0, '2026-11-20')")
con_f.execute("INSERT INTO snapshots (kind, date, total_cost, total_asset, daily_pnl, total_pnl, detail_json, created_at) VALUES ('status', '2026-11-20', 1000, 1010, 10, 10, '[]', ?)", (stale_ms,))
con_f.commit()

health_dir = home / "plugins" / "health-scale"
health_dir.mkdir(parents=True, exist_ok=True)
health_db = health_dir / "health.db"
con_h = sqlite3.connect(str(health_db))
con_h.execute("PRAGMA journal_mode=WAL")
con_h.execute("CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT, is_default INTEGER, updated_at INTEGER)")
con_h.execute("CREATE TABLE measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, weight_kg REAL, heart_rate INTEGER, measured_at INTEGER)")
con_h.execute("INSERT INTO profiles VALUES ('p1', '默认', 1, ?)", (now_ms,))
con_h.execute("INSERT INTO measurements (profile_id, weight_kg, heart_rate, measured_at) VALUES ('p1', 68.5, 70, ?)", (now_ms,))
con_h.commit()

miot_dir = home / "plugins" / "miot"
miot_dir.mkdir(parents=True, exist_ok=True)
(miot_dir / "config.json").write_text(json.dumps({"routerSsh": "root@192.0.2.1"}), encoding="utf-8")
miot_cache = miot_dir / "hub-cache.json"
miot_cache.write_text(json.dumps({
    "fetchedAt": stale_ms,
    "hotDataFetchedAt": stale_ms,
    "liveFetchedAt": stale_ms,
    "devices": [{"did": "d1", "dev_name": "客厅灯", "room_name": "客厅", "online": True, "controllable": True, "cachedState": {"properties": {"2.1": {"value": False}}}}],
}), encoding="utf-8")

nb_dir = home / "plugins" / "ninebot"
nb_dir.mkdir(parents=True, exist_ok=True)
(nb_dir / "session.json").write_text(json.dumps({"accessToken": "tok"}), encoding="utf-8")
nb_db = nb_dir / "ninebot.sqlite"
con_n = sqlite3.connect(str(nb_db))
con_n.execute("PRAGMA journal_mode=WAL")
con_n.execute("CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT, captured_at INTEGER, battery INTEGER, aux_battery INTEGER, voltage_v REAL, temp_c REAL, charging INTEGER, charging_power_w REAL, effective_range_km REAL, odometer_km REAL, power_on INTEGER, locked INTEGER, gcj_lat REAL, gcj_lon REAL, address TEXT, payload_json TEXT)")
con_n.execute("CREATE TABLE trips (sn TEXT, travel_id TEXT, end_time INTEGER, distance_km REAL, max_speed_kmh REAL)")
con_n.execute("CREATE TABLE alert_state (sn TEXT, alert_key TEXT, active INTEGER)")
con_n.execute("INSERT INTO snapshots (sn, captured_at, battery, effective_range_km, odometer_km, power_on, locked, address, payload_json) VALUES ('S1', ?, 80, 60.0, 120.0, 0, 1, '公司', ?)", (stale_ms, json.dumps({"name": "小9", "capturedAt": stale_ms, "battery": 80, "effectiveRangeKm": 60.0, "locked": True, "location": {"address": "公司"}})))
con_n.commit()

netlea_dir = home / "plugins" / "netlea"
netlea_dir.mkdir(parents=True, exist_ok=True)
(netlea_dir / "config.json").write_text(json.dumps({"targetMac": "11:22:33:44:55:66"}), encoding="utf-8")
netlea_state = netlea_dir / "last-state.json"
netlea_state.write_text(json.dumps({
    "updatedAt": stale_ms,
    "lastAddress": "11:22:33:44:55:66",
    "device": {"name": "尼特利水草灯", "address": "11:22:33:44:55:66"},
    "state": {"on": True, "channels": {"red": 40, "green": 50, "white": 70, "blue": 30, "fan": 1}, "master": {"lampMode": 0, "stateType": 1}},
}), encoding="utf-8")

apple_dir = home / "plugins" / "apple-devices"
apple_dir.mkdir(parents=True, exist_ok=True)
(apple_dir / "session.json").write_text(json.dumps({"state": "authenticated"}), encoding="utf-8")
apple_cache = apple_dir / "devices-cache.json"
apple_cache.write_text(json.dumps({
    "fetchedAt": stale_ms,
    "entries": [{"device": {"name": "我的 iPhone", "category": "iphone", "batteryPercent": 77, "batteryStatus": "NotCharging", "online": True}}],
}), encoding="utf-8")

# 2. disable_network=True must suppress ALL live fallback refreshes even when stale
offline_calls = []
def _offline_rpc(req, timeout):
    offline_calls.append((req.get("plugin"), req.get("action"), dict(req.get("args") or {}), timeout))
    if req.get("plugin") == "fund-tracker":
        return {"ok": True, "data": {"updatedAt": stale_ms, "summary": {"totalDailyPnl": 10, "dailyPnlPct": 1.0, "totalAsset": 1010, "totalPnl": 10, "totalPnlPct": 1.0, "holdings": [{"code": "000001", "name": "基", "changePct": 1.0, "dailyPnl": 10, "currentAsset": 1010}]}, "snapshots": []}}
    if req.get("plugin") == "ninebot":
        return {"ok": True, "data": {"configured": True, "snapshot": {"name": "小9", "capturedAt": stale_ms, "battery": 80, "effectiveRangeKm": 60.0, "locked": True}, "history": [], "tripSummary": {}, "activeAlerts": []}}
    if req.get("plugin") == "netlea":
        return {"ok": True, "data": {"updatedAt": stale_ms, "device": {"name": "水草灯", "address": "11:22:33:44:55:66"}, "state": {"on": True, "channels": {"red": 40, "green": 50, "white": 70, "blue": 30, "fan": 1}, "master": {}}, "config": {"targetMac": "11:22:33:44:55:66"}}}
    if req.get("plugin") == "apple-devices":
        return {"ok": True, "data": {"authState": "authenticated", "fetchedAt": stale_ms, "devices": [{"name": "我的 iPhone", "category": "iphone", "batteryPercent": 77, "batteryStatus": "NotCharging", "online": True}], "config": {"minBatteryPct": 25}}}
    return {"ok": True, "data": {}}

hub_off = WidgetDataHub(home, _offline_rpc, ls, disable_network=True)
hub_off._collect_fund_tracker(fund_db, connected=True)
hub_off._collect_miot(miot_cache, connected=True)
hub_off._collect_ninebot(nb_db, connected=True)
hub_off._collect_netlea(netlea_state, connected=True)
hub_off._collect_apple_devices(apple_cache, connected=True)
assert not any(args.get("refresh") is True or args.get("live") is True or act == "status" and plug == "netlea" for plug, act, args, _ in offline_calls), offline_calls
apple_off_call = next(c for c in offline_calls if c[0] == "apple-devices")
assert apple_off_call[2].get("cacheOnly") is True, apple_off_call

# 3. disable_network=False triggers bounded fallback live refreshes when stale & respects cooldown
live_calls = []
netlea_state_flag = {"refreshed": False}
def _live_rpc(req, timeout):
    plug = req.get("plugin")
    act = req.get("action")
    args = dict(req.get("args") or {})
    live_calls.append((plug, act, args, timeout))
    if plug == "fund-tracker":
        is_ref = bool(args.get("refresh"))
        return {"ok": True, "data": {"updatedAt": now_ms if is_ref else stale_ms, "summary": {"totalDailyPnl": 25 if is_ref else 10, "dailyPnlPct": 2.5 if is_ref else 1.0, "totalAsset": 1025, "totalPnl": 25, "totalPnlPct": 2.5, "holdings": [{"code": "000001", "name": "基", "changePct": 2.5, "dailyPnl": 25, "currentAsset": 1025}]}, "snapshots": []}}
    if plug == "miot":
        return {"ok": True, "data": {"devices": [{"did": "d1", "dev_name": "客厅灯", "room_name": "客厅", "online": True, "controllable": True, "state": {"on": True}}]}}
    if plug == "ninebot":
        is_ref = bool(args.get("refresh"))
        return {"ok": True, "data": {"configured": True, "snapshot": {"name": "小9", "capturedAt": now_ms if is_ref else stale_ms, "battery": 78 if is_ref else 80, "effectiveRangeKm": 58.0, "locked": True}, "history": [], "tripSummary": {}, "activeAlerts": []}}
    if plug == "netlea":
        if act == "status":
            netlea_state_flag["refreshed"] = True
            return {"ok": True, "data": {"state": {"on": False}}}
        is_ref = netlea_state_flag["refreshed"]
        return {"ok": True, "data": {"updatedAt": now_ms if is_ref else stale_ms, "device": {"name": "水草灯", "address": "11:22:33:44:55:66"}, "state": {"on": not is_ref, "channels": {"red": 0, "green": 0, "white": 0, "blue": 0, "fan": 0}, "master": {}}, "config": {"targetMac": "11:22:33:44:55:66"}}}
    if plug == "apple-devices":
        is_ref = bool(args.get("refresh"))
        return {"ok": True, "data": {"authState": "authenticated", "fetchedAt": now_ms if is_ref else stale_ms, "devices": [{"name": "我的 iPhone", "category": "iphone", "batteryPercent": 64 if is_ref else 77, "batteryStatus": "NotCharging", "online": True}], "config": {"minBatteryPct": 25}}}
    return {"ok": True, "data": {}}

hub_live = WidgetDataHub(home, _live_rpc, ls, disable_network=False)
hub_live._collect_fund_tracker(fund_db, connected=True)
hub_live._collect_miot(miot_cache, connected=True)
hub_live._collect_ninebot(nb_db, connected=True)
hub_live._collect_netlea(netlea_state, connected=True)
hub_live._collect_apple_devices(apple_cache, connected=True)

assert any(p == "fund-tracker" and a == "dashboard" and ag.get("refresh") is True and t >= 20.0 for p, a, ag, t in live_calls), live_calls
assert any(p == "miot" and a == "devices" and ag.get("refresh") is True and ag.get("live") is True and t >= 20.0 for p, a, ag, t in live_calls), live_calls
assert any(p == "ninebot" and a == "dashboard" and ag.get("refresh") is True and t >= 20.0 for p, a, ag, t in live_calls), live_calls
assert any(p == "netlea" and a == "status" and ag.get("minimal") is False and t >= 20.0 for p, a, ag, t in live_calls), live_calls
assert any(p == "apple-devices" and a == "status" and ag.get("cacheOnly") is True for p, a, ag, t in live_calls), live_calls
assert any(p == "apple-devices" and a == "status" and ag.get("refresh") is True and t >= 20.0 for p, a, ag, t in live_calls), live_calls
assert hub_live.get_widget("fund-tracker")["dailyPct"] == 2.5
assert hub_live.get_widget("miot")["onCount"] == 1
assert hub_live.get_widget("ninebot")["battery"] == 78
assert hub_live.get_widget("netlea")["on"] is False
assert hub_live.get_widget("apple-devices")["devices"][0]["battery"] == 64

# Cooldown suppresses immediate repeat live refresh if disk stays stale
calls_before_cd = len(live_calls)
hub_live._collect_apple_devices(apple_cache, connected=True)
apple_cd_calls = live_calls[calls_before_cd:]
assert len(apple_cd_calls) == 1 and apple_cd_calls[0][2].get("cacheOnly") is True, apple_cd_calls

# 4. netlea skips fallback live refresh when BLE peer is busy
netlea_state_flag["refreshed"] = False
(health_dir / "live-session.json").write_text(json.dumps({"phase": "measuring"}), encoding="utf-8")
hub_busy = WidgetDataHub(home, _live_rpc, ls, disable_network=False)
calls_before_busy = len(live_calls)
hub_busy._collect_netlea(netlea_state, connected=True)
assert not any(p == "netlea" and a == "status" for p, a, _, _ in live_calls[calls_before_busy:]), live_calls[calls_before_busy:]
(health_dir / "live-session.json").unlink()

# 5. refresh_due detects WAL mtime changes for fund-tracker, health-scale, and ninebot
wal_calls = []
def _wal_rpc(req, timeout):
    wal_calls.append(req.get("plugin"))
    return {"ok": True, "data": {}}

hub_wal = WidgetDataHub(home, _wal_rpc, ls, disable_network=True)
hub_wal.refresh_due(None, connected=True, force=False)
wal_calls.clear()

# Without WAL change & before TTL -> 0 calls
hub_wal.refresh_due(None, connected=True, force=False)
assert wal_calls == [], wal_calls

# Touch -wal files (ensure distinct mtime) -> all 3 re-collect immediately
future_s = time.time() + 10.0
for wal_name in (
    fund_dir / "funds.sqlite-wal",
    health_dir / "health.db-wal",
    nb_dir / "ninebot.sqlite-wal",
):
    if not wal_name.exists():
        wal_name.write_bytes(b"wal")
    os.utime(wal_name, (future_s, future_s))

hub_wal.refresh_due(None, connected=True, force=False)
assert set(wal_calls) == {"fund-tracker", "health-scale", "ninebot"}, wal_calls

# 6. Verify _collect_laifen and _collect_netlea localize BLE model names while preserving CJK custom names
laifen_loc_dir = home / "plugins" / "laifen"
laifen_loc_dir.mkdir(parents=True, exist_ok=True)
con_lf_loc = sqlite3.connect(str(laifen_loc_dir / "laifen.db"))
con_lf_loc.execute("CREATE TABLE device_state (id TEXT PRIMARY KEY, name TEXT, battery_pct INTEGER, active_mode INTEGER, modes_json TEXT, duration_sec INTEGER, status TEXT, updated_at INTEGER, last_synced_at INTEGER)")
con_lf_loc.execute("CREATE TABLE brush_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, brushed_at INTEGER)")
con_lf_loc.execute("INSERT INTO device_state VALUES ('primary', 'LFTB01-P-640A', 88, 2, ?, 120, 'Idle', ?, ?)", (json.dumps({"2": {"strength": 10, "range": 8, "speed": 6}}), now_ms, now_ms))
con_lf_loc.commit()
con_lf_loc.close()
hub_off._collect_laifen(laifen_loc_dir / "laifen.db", connected=False)
assert hub_off.get_widget("laifen")["name"] == "徕芬电动牙刷", hub_off.get_widget("laifen")

netlea_state.write_text(json.dumps({
    "updatedAt": now_ms,
    "lastAddress": "11:22:33:44:55:66",
    "device": {"name": "SG-X-PRO-60w11", "address": "11:22:33:44:55:66"},
    "state": {"on": True, "channels": {"red": 40, "green": 50, "white": 70, "blue": 30, "fan": 1}, "master": {"lampMode": 0, "stateType": 1}},
}), encoding="utf-8")
hub_off._collect_netlea(netlea_state, connected=False)
assert hub_off.get_widget("netlea")["name"] == "尼特利鱼缸灯", hub_off.get_widget("netlea")

con_f.close()
con_h.close()
con_n.close()
`;
    execFileSync('python3', ['-c', pyScript], { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});
