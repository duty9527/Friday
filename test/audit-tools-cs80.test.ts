import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runAction } from '../plugins/cs80-face/index.mjs';
import { notifyCs80Scene, postCs80Control } from '../src/cs80-scene.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CS80_DIR = join(REPO_ROOT, 'tools', 'cs80-face');

async function until(predicate: () => boolean | Promise<boolean>, attempts = 250, stepMs = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(stepMs);
  }
  throw new Error('Timed out waiting for condition');
}

test('1. qdc1.c & fast565.c C bounds checks, incompressible LZ4 fallback, and fbuf rollback safety', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-c-'));
  try {
    const harness = join(dir, 'c_audit_test.c');
    const bin = join(dir, 'c_audit_test');
    const cCode = `
#define main qdc1_orig_main
#include "qdc1.c"
#undef main
#include "fast565.c"
#include <assert.h>

static uint32_t pseudo_rand(uint32_t *s) {
  *s = (*s * 1664525u) + 1013904223u;
  return *s;
}

int main(void) {
  /* 1. fast565 null & tiny-dimension guards */
  bgra_to_bgr565(NULL, NULL, 100);
  bgr565_to_rgb24(NULL, NULL, 100);
  uint16_t tiny_a[4] = {1, 2, 3, 4}, tiny_b[4] = {1, 2, 3, 5};
  uint8_t tiny_out[16];
  assert(diff_tiles_32x16(tiny_a, tiny_b, 16, 16, tiny_out, 4) == 0);
  assert(diff_tiles_32x16(NULL, tiny_b, 32, 16, tiny_out, 4) == 0);
  assert(diff_tiles_32x16(tiny_a, tiny_b, 32, 16, NULL, 2) == 3);

  /* 2. send_cmd enforces tx_cap and never overflows l->tx */
  link_t l;
  memset(&l, 0, sizeof l);
  l.tx_cap = TX_BUF_BYTES;
  l.tx = malloc(l.tx_cap);
  assert(l.tx != NULL);
  assert(send_cmd(&l, QD_DATA, 0, 0, 0, "x", (uint32_t)(l.tx_cap - 31u)) == -1);

  /* 3. push_full_once handles incompressible 512000-byte blocks without overflowing l->tx */
  fbuf = malloc(FRAME_BYTES);
  uint16_t *orig_fbuf = malloc(FRAME_BYTES);
  assert(fbuf && orig_fbuf);
  uint32_t rng = 0x12345678u;
  for (size_t i = 0; i < FRAME_BYTES / 2u; i++) {
    fbuf[i] = (uint16_t)(pseudo_rand(&rng) >> 16);
  }
  memcpy(orig_fbuf, fbuf, FRAME_BYTES);

  /* Verify LZ4 worst-case bound exceeds BLOCK_BYTES on incompressible data */
  char *probe_comp = malloc((size_t)LZ4_compressBound(BLOCK_BYTES));
  assert(probe_comp != NULL);
  int worst_c = LZ4_compress_default((const char *)fbuf, probe_comp, BLOCK_BYTES, LZ4_compressBound(BLOCK_BYTES));
  assert(worst_c > (int)BLOCK_BYTES);
  free(probe_comp);

  /* 4. push_patch pre-validates coordinates without mutating fbuf */
  fbuf_valid = 1;
  fbuf_hash = xxh32(fbuf, FRAME_BYTES);
  uint8_t *tiles = malloc(MAX_TILES * TILE_MSG);
  assert(tiles != NULL);
  memset(tiles, 0, MAX_TILES * TILE_MSG);
  /* tile 0 is valid (0,0) with all 0xAA bytes; tile 1 is unaligned (x=31) */
  memset(tiles + 4, 0xAA, TILE_BYTES);
  tiles[TILE_MSG + 0] = 31; /* invalid x=31 */
  tiles[TILE_MSG + 1] = 0;
  uint32_t wire = 0, ms = 0;
  int rc_bad_coord = push_patch(&l, tiles, 2, &wire, &ms);
  assert(rc_bad_coord == -4);
  assert(memcmp(fbuf, orig_fbuf, FRAME_BYTES) == 0);

  /* 5. push_patch with MAX_TILES incompressible tiles fails cleanly (-5) and rolls back fbuf */
  for (uint32_t i = 0; i < MAX_TILES; i++) {
    uint8_t *t = tiles + i * TILE_MSG;
    uint16_t tx = (uint16_t)((i % 25u) * 32u);
    uint16_t ty = (uint16_t)((i / 25u) * 16u);
    t[0] = (uint8_t)(tx & 0xFFu);
    t[1] = (uint8_t)(tx >> 8);
    t[2] = (uint8_t)(ty & 0xFFu);
    t[3] = (uint8_t)(ty >> 8);
    for (size_t j = 0; j < TILE_BYTES; j++) {
      t[4 + j] = (uint8_t)(pseudo_rand(&rng) >> 24);
    }
  }
  int rc_big_patch = push_patch(&l, tiles, MAX_TILES, &wire, &ms);
  assert(rc_big_patch == -5);
  assert(memcmp(fbuf, orig_fbuf, FRAME_BYTES) == 0);
  assert(fbuf_valid == 1);

  free(tiles);
  free(orig_fbuf);
  free(fbuf);
  free(l.tx);
  return 0;
}
`;
    await writeFile(harness, cCode, 'utf8');
    // Stub Linux USB open/raw I/O by compiling with -D_WIN32? No, compile on Linux directly with -I CS80_DIR!
    execFileSync(
      'gcc',
      ['-O2', '-Wall', '-Wextra', '-I', CS80_DIR, '-o', bin, harness, join(CS80_DIR, 'lz4.c')],
      { stdio: 'pipe' },
    );
    execFileSync(bin, [], { stdio: 'pipe' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('2. layout includePreview=true preserves _prev565 diff so physical display receives patch & HTTP validates malformed inputs', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-daemon-'));
  const mockLog = join(home, 'mock-sidecar.jsonl');
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
    assert.ok(match, `Missing listening port: ${stdoutBuf} / ${stderrBuf}`);
    const port = Number(match[1]);

    // Wait for initial 0x04 full frame push
    await until(async () => {
      try {
        const raw = await readFile(mockLog, 'utf8');
        return raw.includes('"type":"0x04"');
      } catch {
        return false;
      }
    }, 200, 25);

    const beforeLines = (await readFile(mockLog, 'utf8')).trim().split('\n').filter(Boolean).length;

    // Switch activePage with includePreview=true (gridRows stays 2!) -> must still push update to mock sidecar
    const layoutRes = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'layout', activePage: 1, includePreview: true }),
    });
    assert.equal(layoutRes.status, 200);
    const layoutJson = (await layoutRes.json()) as { ok?: boolean; previewDataUrl?: string };
    assert.equal(layoutJson.ok, true);
    assert.match(String(layoutJson.previewDataUrl ?? ''), /^data:image\/png;base64,/);

    await until(async () => {
      const lines = (await readFile(mockLog, 'utf8')).trim().split('\n').filter(Boolean).slice(beforeLines);
      return lines.some(line => {
        const obj = JSON.parse(line) as { type?: string };
        return obj.type === '0x02' || obj.type === '0x04';
      });
    }, 100, 25);

    // Invalid numeric / NaN inputs return clean HTTP 400 JSON and do not wedge daemon
    for (const badBody of [
      { action: 'screen', brightness: 'not-a-number' },
      { action: 'express', expr: 'happy', holdSec: 'NaN' },
      { action: 'scene', scene: 'speaking', holdSec: 'Infinity' },
      { action: 'sound', volume: 'loud' },
    ]) {
      const badResp = await fetch(`http://127.0.0.1:${port}/api/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(badBody),
      });
      assert.equal(badResp.status, 400);
      const badJson = (await badResp.json()) as { ok?: boolean; err?: string };
      assert.equal(badJson.ok, false);
      assert.ok(badJson.err);
    }

    // Malformed live-session.json updatedAt does not crash _friday_poll_loop
    const hsDir = join(home, 'plugins', 'health-scale');
    await mkdir(hsDir, { recursive: true });
    await writeFile(join(hsDir, 'live-session.json'), JSON.stringify({ phase: 'measuring', updatedAt: 'bad-ts' }));
    await delay(500);

    const stResp = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(stResp.status, 200);
    const stJson = (await stResp.json()) as { ok?: boolean; device?: string };
    assert.equal(stJson.ok, true);
    assert.equal(stJson.device, 'up');
  } finally {
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

test('3. Python regressions: SidecarBridge audio reconnect, audio size precheck, animator wakeup, SQLite FD cleanup, renderer None safety, FridayClient cursor reset', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'friday-cs80-py-audit-'));
  const bigFile = join(dir, 'huge.wav');
  const fh = await open(bigFile, 'w');
  try {
    await fh.truncate(65 * 1024 * 1024);
  } finally {
    await fh.close();
  }

  try {
    const pyCheck = `
import json, math, os, sqlite3, sys, types
from pathlib import Path
from unittest import mock

sys.path.insert(0, ${JSON.stringify(CS80_DIR)})

from audio import SpeakerController, AUDIO_QUERY, AUDIO_VOLUME
from avatar_math import BotAnimator
from daemon import SidecarBridge
from friday_client import FridayClient
import renderer as renderer_mod
from renderer import FaceRenderer, HudState
from widgets import LayoutStore, PlacedCard, WidgetDataHub, _is_pid_alive

tmp = Path(${JSON.stringify(dir)})

# 1. SidecarBridge audio reconnect resets per-session n without hanging on _audio_n > new n
bridge = SidecarBridge(mock=True)
bridge._handle_event({"event": "ready", "block": 520192})
assert bridge.session == 1
# Simulate 10 audio events in session 1
for i in range(1, 11):
    bridge._handle_event({"event": "audio", "n": i, "sub": AUDIO_QUERY, "ok": 1})
assert bridge._audio_n == 10
# Session 2 starts -> sidecar restarts at n=1
bridge._handle_event({"event": "ready", "block": 520192})
assert bridge.session == 2 and bridge._audio_n == 0
seq_before = bridge._audio_seq
bridge._handle_event({"event": "audio", "n": 1, "sub": AUDIO_VOLUME, "ok": 1})
assert bridge._audio_seq == seq_before + 1
assert bridge._last_audio_ev["n"] == 1

# 2. SpeakerController handles non-dict config.json and checks play_file size before read_bytes
spk_dir = tmp / "spk"
spk_dir.mkdir(parents=True, exist_ok=True)
(spk_dir / "config.json").write_text("[]", encoding="utf-8")
sc = SpeakerController(spk_dir, bridge)
assert sc.config.volume == 65
with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("must not read oversized file")):
    res_big = sc.play_file(${JSON.stringify(bigFile)})
assert res_big["ok"] is False and res_big["err"] == "input-too-large", res_big

# 3. BotAnimator.next_wakeup_delay stays ~0.105 while springs are still settling after poke
anim = BotAnimator()
anim.set_state("idle")
for _ in range(30):
    if anim.step(0.2).settled:
        break
assert anim.next_wakeup_delay() > 0.5
anim.trigger_poke("bounce", 1)
# Step past poke duration (0.62s) while springs still have velocity/displacement
for _ in range(7):
    snap = anim.step(0.1)
if not snap.settled:
    assert anim.next_wakeup_delay() <= 0.12, f"froze mid-settle: {anim.next_wakeup_delay()}"

# 4. LayoutStore rejects NaN/Inf coords and outputs strict JSON
ls = LayoutStore(tmp / "layout")
cfg, _, _ = ls.apply_patch({"weatherLat": float("nan"), "weatherLon": float("inf")})
assert math.isfinite(cfg["weatherLat"]) and math.isfinite(cfg["weatherLon"])
json.loads((tmp / "layout" / "layout.json").read_text(encoding="utf-8"), parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))

# 5. WidgetDataHub SQLite readers close connections on corrupt/invalid schema & handle '?' in path
weird_dir = tmp / "dir?with#chars"
weird_dir.mkdir(parents=True, exist_ok=True)
bad_db = weird_dir / "bad.sqlite"
con = sqlite3.connect(str(bad_db))
con.execute("CREATE TABLE unrelated (x INT)")
con.commit()
con.close()
hub = WidgetDataHub(tmp, lambda req, timeout: {}, ls, disable_network=True)
fd_before = len(os.listdir("/proc/self/fd"))
for _ in range(5):
    hub._collect_fund_tracker(bad_db, connected=False)
    hub._collect_health_scale(bad_db, connected=False)
    hub._collect_ninebot(bad_db, connected=False)
    hub._collect_laifen(bad_db, connected=False)
fd_after = len(os.listdir("/proc/self/fd"))
assert fd_after <= fd_before + 1, f"FD leak detected: before={fd_before}, after={fd_after}"

# 6. _is_pid_alive returns True on PermissionError
with mock.patch("os.kill", side_effect=PermissionError("EPERM")):
    assert _is_pid_alive(12345) is True

# 7. FaceRenderer._card_system_pulse handles None optional numeric fields cleanly and _card_memory ignores negative indices
class _FakeExt:
    x_advance = 10.0
class _FakeCtx:
    def __init__(self):
        self.line_count = 0
    def select_font_face(self, *a): pass
    def set_font_size(self, s): pass
    def set_source_rgb(self, *a): pass
    def set_source_rgba(self, *a): pass
    def set_line_width(self, w): pass
    def set_dash(self, *a): pass
    def new_path(self): pass
    def new_sub_path(self): pass
    def close_path(self): pass
    def save(self): pass
    def restore(self): pass
    def clip(self): pass
    def rectangle(self, *a): pass
    def move_to(self, x, y): pass
    def line_to(self, x, y):
        self.line_count += 1
    def arc(self, *a): pass
    def fill(self): pass
    def fill_preserve(self): pass
    def stroke(self): pass
    def show_text(self, s): pass
    def text_extents(self, s): return _FakeExt()

r = FaceRenderer()
orig_cairo = renderer_mod.cairo
if renderer_mod.cairo is None:
    renderer_mod.cairo = types.SimpleNamespace(FONT_SLANT_NORMAL=0, FONT_WEIGHT_NORMAL=0, FONT_WEIGHT_BOLD=1)
try:
    card = PlacedCard(card_id="s1", kind="system-pulse", col=0, row=0, w_span=1, h_span=1, configured_size="1x1", effective_size="1x1", x=36.0, y=710.0, w=356.0, h=236.0)
    r._card_system_pulse(_FakeCtx(), card, {"cpuPct": None, "memPct": None, "diskPct": None, "load1": None, "memUsedGb": None, "memTotalGb": None, "diskFreeGb": None, "uptimeH": None, "timerCount": None})
    mem_card = PlacedCard(card_id="m1", kind="memory", col=1, row=0, w_span=1, h_span=1, configured_size="1x1", effective_size="1x1", x=408.0, y=710.0, w=356.0, h=236.0)
    neg_ctx = _FakeCtx()
    r._card_memory(neg_ctx, mem_card, {"totalActive": 3, "pinnedCount": 1, "nodeCount": 4, "edges": [[-1, 0, 0.8], [0, 99, 0.8]]})
    # Only the card header divider calls line_to (1); negative/OOB edges must not draw lines
    assert neg_ctx.line_count == 1, neg_ctx.line_count
finally:
    renderer_mod.cairo = orig_cairo

# 8. FridayClient resets _cursor if head < _cursor after DB reset
fc = FridayClient(str(tmp))
fc._cursor = 500
fc._last_connected = True
fc._last_view = {"cursor": 500, "messages": {"items": []}, "works": []}
fc._last_view_at = 1000.0
calls = []
def fake_rpc(payload, timeout=2.5):
    calls.append(payload["command"])
    if payload["command"] == "updates":
        return {"head": 2, "cursor": 2, "events": []}
    return {"cursor": 2, "messages": {"items": []}, "works": [], "subconscious": {"sleeping": False, "phase": "awake"}, "imChannels": []}
fc._rpc = fake_rpc
fc.poll(now_mono=1001.0)
assert "view" in calls and fc._cursor == 2, (calls, fc._cursor)
`;
    execFileSync('python3', ['-c', pyCheck], { cwd: REPO_ROOT, stdio: 'pipe' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('4. plugins/cs80-face/index.mjs & src/cs80-scene.ts prevent action override, null dashboard ok=true, and bad URL schemes', async () => {
  const received: Array<Record<string, unknown>> = [];
  let responseBody: unknown = { ok: true, brightness: { ok: true } };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length) {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });

  await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const prevUrl = process.env.CS80_FACE_URL;
  try {
    // 1. safeArgs.action must not overwrite dispatched action name
    const scrRes = await runAction(
      'screen',
      { action: 'sound', brightness: 90, silent: true },
      { env: { CS80_FACE_URL: baseUrl } },
    );
    assert.equal(scrRes.ok, true);
    assert.equal(received.at(-1)?.action, 'screen');

    // 2. null JSON from /api/dashboard must not report ok=true
    responseBody = null;
    const dashNull = await runAction('dashboard', { includePreview: false }, { env: { CS80_FACE_URL: baseUrl } });
    assert.equal(dashNull.ok, false);

    // 3. postCs80Control ignores non-http(s) URLs without throwing and ignores whitespace-only CS80_FACE_URL
    process.env.CS80_FACE_URL = 'ftp://127.0.0.1:9999';
    assert.doesNotThrow(() => postCs80Control({ action: 'scene', scene: 'speaking', phase: 'start' }));

    process.env.CS80_FACE_URL = '   ';
    assert.doesNotThrow(() => notifyCs80Scene({ scene: 'speaking', phase: 'start' }));
  } finally {
    if (prevUrl === undefined) delete process.env.CS80_FACE_URL;
    else process.env.CS80_FACE_URL = prevUrl;
    await new Promise<void>(res => server.close(() => res()));
  }
});
