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
    def get_height(self): return self._h
    def flush(self): pass
    def write_to_png(self, buf): buf.write(b"\\x89PNG\\r\\n\\x1a\\nfakepng")

class _Ctx:
    def __init__(self, surf): self._surf = surf
    def save(self): pass
    def restore(self): pass
    def translate(self, x, y): pass
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
    def show_text(self, s): pass
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

# 3. LayoutStore, Bento packer & custom plugin discovery
home = Path(${JSON.stringify(tmpHome)})
ls = LayoutStore(home / "plugins" / "cs80-face")
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
assert any(item["kind"] == "plugin:demo-custom" for item in catalog), "missing custom plugin in catalog"
assert any(item["kind"] == "ninebot" for item in catalog), "missing ninebot widget in catalog"

# 4. FakeCairo smoke render across ALL card kinds & sizes & listening state
rmod.cairo = fake_cairo
try:
    r_fc = rmod.FaceRenderer()
    anim.set_state("listening")
    lsnap = anim.step(0.08, center_x=400.0, center_y=272.0, base_radius=132.0)
    all_kinds = [
        ("fund-tracker", "2x2"), ("health-scale", "1x2"), ("miot", "1x1"), ("ninebot", "2x1"), ("ninebot", "1x2"), ("system-pulse", "2x1"),
        ("tv-agent", "1x1"), ("tv-ir", "1x1"), ("memory", "2x1"), ("timers", "1x1"),
        ("usage", "1x1"), ("weather", "1x1"), ("workers", "1x1"), ("plugin:demo-custom", "1x1"),
    ]
    sample_data = {
        "fund-tracker": {"ok": True, "dailyPct": 1.25, "dailyPnl": 600, "totalPnl": 3200, "totalPnlPct": 8.4, "holdingCount": 3, "subline": "今日 +600", "spark": [100, 120, 115, 140], "holdings": [{"code": "000300", "name": "沪深300", "changePct": 1.25}]},
        "health-scale": {"ok": True, "weightKg": 68.2, "diffKg": -0.2, "bodyFat": 17.5, "musclePct": 44.1, "bmi": 22.0, "score": 89, "waterPct": 58.0, "visceral": 6, "spark": [68.9, 68.5, 68.2]},
        "miot": {"ok": True, "online": 4, "total": 5, "onCount": 2, "devices": [{"name": "灯", "room": "客厅", "online": True, "on": True}]},
        "ninebot": {"ok": True, "name": "九号M95C", "battery": 80, "auxBattery": 93, "voltageV": 75.3, "tempC": 26.0, "charging": True, "chargingPowerW": 310, "remainChargeTime": "1h20m", "rangeKm": 99.6, "odometerKm": 1234.5, "powerOn": False, "locked": True, "address": "科技路1号", "monthKm": 88.2, "maxSpeedKmh": 68.0, "alertCount": 0, "updatedHm": "01:45", "spark": [90, 84, 78, 80]},
        "system-pulse": {"ok": True, "cpuPct": 12.0, "memPct": 42.0, "memUsedGb": 3.1, "memTotalGb": 7.6, "diskPct": 50.0, "diskFreeGb": 100.0, "load1": 0.35, "nextTimer": "巡检 12:00"},
        "tv-agent": {"ok": True, "online": True, "appName": "B站", "volume": 24, "muted": False, "dlnaOk": True, "agentOk": True},
        "tv-ir": {"ok": True, "txReady": True, "headline": "红外就绪", "subline": "预设 12 键"},
        "memory": {"ok": True, "totalActive": 20, "pinnedCount": 4, "nodeCount": 6, "edges": [(0, 1, 0.8), (1, 2, 0.5)], "topics": ["CS80"]},
        "timers": {"ok": True, "enabled": 1, "total": 2, "rows": [{"name": "午间估值", "nextHm": "12:00"}]},
        "usage": {"ok": True, "calls": 18, "tokStr": "12.4k", "costCny": 1.25, "costUsd": 0.17},
        "weather": {"ok": True, "city": "上海", "temp": 22.0, "desc": "晴", "subline": "湿度 55%"},
        "workers": {"ok": True, "count": 1, "rows": [{"profile": "coding", "prompt": "测试", "elapsedSec": 8}]},
        "plugin:demo-custom#dc": {"ok": True, "plugin": "demo-custom", "action": "status", "title": "测试", "kpis": [("状态", "正常"), ("延迟", "2ms")]},
    }
    for rows in (2, 3):
        geo = rmod.stage_geometry_for_rows(rows)
        for kind, sz in all_kinds:
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
                friday_connected=True,
                auto_task_overlay=False,
                page_count=2,
                active_page=0,
            )
            r_fc.render_frame(lsnap, hud_fc, placed_cards=cards, widget_data=sample_data)

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
finally:
    rmod.cairo = None
`;
    execFileSync('python3', ['-c', pySmoke], { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    await rm(tmpHome, { recursive: true, force: true });
  }
});
