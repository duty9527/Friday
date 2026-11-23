import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';
import {
  ensureMusicStreamSecret,
  MAX_MUSIC_UPLOAD_BYTES,
  signMusicStreamToken,
  verifyMusicStreamToken,
} from '../src/music-media.js';
import { tryPluginVoiceFastpath } from '../src/plugin.js';
import { runAction, stopAllMusicWatchers } from '../plugins/music/index.mjs';
import { parseMusicVoiceUtterance, handleMusicVoiceFastpath } from '../plugins/music/fastpath.mjs';
import { detectSourceFromUrl, searchOnlineTracks } from '../plugins/music/downloader.mjs';
import { scanLibrary, searchLocalTracks } from '../plugins/music/library.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function makeTempWorkspace(prefix = 'friday-music-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(root, 'home');
  const musicDir = join(root, 'music');
  const musicDir2 = join(root, 'music2');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(musicDir2, { recursive: true });
  return { root, homeDir, musicDir, musicDir2 };
}

test('music library scan, ffprobe metadata + fallback, cache invalidation on musicDir switch, search & playlists', async () => {
  const { root, homeDir, musicDir, musicDir2 } = makeTempWorkspace();
  try {
    const pluginDataDir = join(homeDir, 'plugins', 'music');
    await runAction('config', { musicDir }, { homeDir, pluginDataDir });

    writeFileSync(join(musicDir, '周杰伦 - 晴天.mp3'), Buffer.from('ID3mock-qingtian-bytes-1234567890'));
    writeFileSync(join(musicDir, '夜曲.flac'), Buffer.from('fLaCmock-yequ-bytes-1234567890'));
    writeFileSync(join(musicDir2, '稻香.mp3'), Buffer.from('ID3mock-daoxiang-bytes-1234567890'));

    let ffprobeCalls = 0;
    const mockExecFile = async (_cmd: string, args: string[]) => {
      ffprobeCalls += 1;
      const file = args.at(-1) ?? '';
      if (file.endsWith('夜曲.flac')) {
        return {
          stdout: JSON.stringify({
            format: { duration: '226.4', bit_rate: '960000', tags: { title: '夜曲', artist: '周杰伦', album: '十一月的萧邦' } },
            streams: [{ codec_type: 'audio', codec_name: 'flac' }],
          }),
        };
      }
      throw new Error('ffprobe unavailable for test fallback');
    };

    const first = await scanLibrary(pluginDataDir, musicDir, { quick: true }, { execFileFn: mockExecFile });
    assert.equal(first.total, 2);
    assert.equal(first.added, 2);
    assert.equal(ffprobeCalls, 2);

    const qingtian = first.tracks.find(t => t.filename === '周杰伦 - 晴天.mp3')!;
    assert.equal(qingtian.title, '晴天');
    assert.equal(qingtian.artist, '周杰伦');
    const yequ = first.tracks.find(t => t.filename === '夜曲.flac')!;
    assert.equal(yequ.title, '夜曲');
    assert.equal(yequ.durationSec, 226);
    assert.equal(yequ.album, '十一月的萧邦');

    // Quick rescan skips unchanged files
    const second = await scanLibrary(pluginDataDir, musicDir, { quick: true }, { execFileFn: mockExecFile });
    assert.equal(second.total, 2);
    assert.equal(ffprobeCalls, 2);

    // Search ranking supports Chinese "的" phrasing and normalized punctuation
    const matched = searchLocalTracks(second.tracks, '周杰伦的《晴天》');
    assert.equal(matched[0]?.id, qingtian.id);

    // Playlists CRUD + favorites
    const fav = await runAction('playlist', { op: 'toggle-favorite', trackId: qingtian.id }, { homeDir, pluginDataDir });
    assert.equal(fav.ok, true);
    assert.equal(fav.data?.favorited, true);

    const created = await runAction('playlist', { op: 'create', name: '夜晚车载', trackId: yequ.id }, { homeDir, pluginDataDir });
    assert.equal(created.ok, true);
    const plId = String(created.data?.playlist?.id ?? '');
    assert.ok(plId);

    const filtered = await runAction('tracks', { playlistId: plId }, { homeDir, pluginDataDir });
    assert.equal(filtered.data?.total, 1);
    assert.equal(filtered.data?.tracks?.[0]?.id, yequ.id);

    // Deleting built-in favorites is rejected
    const delBuiltIn = await runAction('playlist', { op: 'delete', playlistId: 'favorites' }, { homeDir, pluginDataDir });
    assert.equal(delBuiltIn.ok, false);

    // Switching musicDir invalidates cache & rescans new directory
    const switched = await runAction('config', { musicDir: musicDir2 }, { homeDir, pluginDataDir }, { execFileFn: mockExecFile });
    assert.equal(switched.ok, true);
    assert.equal(switched.data?.scan?.total, 1);
    assert.equal(switched.data?.scan?.tracks?.[0]?.title, '稻香');

    // Delete track removes file from musicDir2 and cleans index
    const targetId = String(switched.data?.scan?.tracks?.[0]?.id ?? '');
    const deleted = await runAction('delete-track', { trackId: targetId }, { homeDir, pluginDataDir });
    assert.equal(deleted.ok, true);
    assert.equal(existsSync(join(musicDir2, '稻香.mp3')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('music HTTP streaming (HMAC, 200/206/416, path traversal) & upload (/api/music/upload) work with strict auth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'friday-music-http-'));
  const home = join(root, 'home');
  const musicDir = join(root, 'music');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(musicDir, { recursive: true });
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 20 });
  const web = await startWeb({ home });
  const entry = new URL(web.url);
  const base = entry.origin;
  const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
  const authHeaders = { authorization: `Bearer ${token}` };

  try {
    await runAction('config', { musicDir }, { homeDir: home });
    const sampleAudio = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    writeFileSync(join(musicDir, 'test-song.mp3'), sampleAudio);
    const scanned = await runAction('scan', { quick: false }, { homeDir: home });
    const trackId = String(scanned.data?.tracks?.[0]?.id ?? '');
    assert.ok(trackId);

    const secret = await ensureMusicStreamSecret(home);
    const expFuture = Math.floor(Date.now() / 1000) + 600;
    const sig = signMusicStreamToken(secret, trackId, expFuture);
    assert.equal(verifyMusicStreamToken(secret, trackId, expFuture, sig), true);

    // 1. Tampered / expired signature -> 403
    const badSigRes = await fetch(`${base}/media/music/${trackId}.mp3?exp=${expFuture}&sig=${'0'.repeat(64)}`);
    assert.equal(badSigRes.status, 403);
    const expPast = Math.floor(Date.now() / 1000) - 10;
    const expiredSig = signMusicStreamToken(secret, trackId, expPast);
    const expiredRes = await fetch(`${base}/media/music/${trackId}.mp3?exp=${expPast}&sig=${expiredSig}`);
    assert.equal(expiredRes.status, 403);

    // 2. Path traversal -> 404
    const travRes = await fetch(`${base}/media/music/../../etc/passwd?exp=${expFuture}&sig=${sig}`);
    assert.equal(travRes.status, 404);

    // 3. Full 200 & HEAD
    const fullRes = await fetch(`${base}/media/music/${trackId}.mp3?exp=${expFuture}&sig=${sig}`);
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get('content-type'), 'audio/mpeg');
    assert.equal(fullRes.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await fullRes.arrayBuffer()), sampleAudio);

    const headRes = await fetch(`${base}/media/music/${trackId}.mp3?exp=${expFuture}&sig=${sig}`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-length'), String(sampleAudio.length));

    // 4. Range 206 & invalid 416
    const partRes = await fetch(`${base}/media/music/${trackId}.mp3?exp=${expFuture}&sig=${sig}`, {
      headers: { range: 'bytes=10-19' },
    });
    assert.equal(partRes.status, 206);
    assert.equal(partRes.headers.get('content-range'), `bytes 10-19/${sampleAudio.length}`);
    assert.equal(await partRes.text(), 'ABCDEFGHIJ');

    const badRangeRes = await fetch(`${base}/media/music/${trackId}.mp3?exp=${expFuture}&sig=${sig}`, {
      headers: { range: `bytes=${sampleAudio.length + 5}-` },
    });
    assert.equal(badRangeRes.status, 416);

    // 5. Upload endpoint enforces auth, extension allowlist, empty check, size check, and writes file
    const unauthUpload = await fetch(`${base}/api/music/upload`, {
      method: 'POST',
      headers: { 'x-music-filename': encodeURIComponent('demo.mp3') },
      body: Buffer.from('ID3data'),
    });
    assert.equal(unauthUpload.status, 401);

    const badExtUpload = await fetch(`${base}/api/music/upload`, {
      method: 'POST',
      headers: { ...authHeaders, 'x-music-filename': encodeURIComponent('evil.sh') },
      body: Buffer.from('#!/bin/sh'),
    });
    assert.equal(badExtUpload.status, 400);

    const emptyUpload = await fetch(`${base}/api/music/upload`, {
      method: 'POST',
      headers: { ...authHeaders, 'x-music-filename': encodeURIComponent('empty.mp3') },
      body: Buffer.alloc(0),
    });
    assert.equal(emptyUpload.status, 400);

    const baseUrlObj = new URL(base);
    const overUploadHead = await new Promise<string>((resolveSock, rejectSock) => {
      const sock = createConnection({ host: baseUrlObj.hostname, port: Number(baseUrlObj.port) }, () => {
        sock.write(
          `POST /api/music/upload HTTP/1.1\r\n`
          + `Host: ${baseUrlObj.host}\r\n`
          + `Authorization: Bearer ${token}\r\n`
          + `x-music-filename: huge.mp3\r\n`
          + `Content-Length: ${MAX_MUSIC_UPLOAD_BYTES + 1}\r\n`
          + `\r\n`
          + `ID3partial`,
        );
      });
      let raw = '';
      const timer = setTimeout(() => { sock.destroy(); rejectSock(new Error('413 upload timeout')); }, 2000);
      sock.on('data', chunk => { raw += chunk.toString('utf8'); });
      sock.on('close', () => { clearTimeout(timer); resolveSock(raw.split('\r\n\r\n')[0] ?? ''); });
      sock.once('error', () => {});
    });
    assert.match(overUploadHead, /^HTTP\/1\.1 413 /);

    const payload = Buffer.from('ID3uploaded-chinese-song-bytes');
    const okUpload = await fetch(`${base}/api/music/upload`, {
      method: 'POST',
      headers: { ...authHeaders, 'x-music-filename': encodeURIComponent('林俊杰 - 江南.mp3') },
      body: payload,
    });
    assert.equal(okUpload.status, 200);
    const upJson = await okUpload.json() as { ok: boolean; uploaded: { filePath: string }; scan: { data?: { total?: number } } };
    assert.equal(upJson.ok, true);
    assert.equal(existsSync(upJson.uploaded.filePath), true);
    assert.deepEqual(readFileSync(upJson.uploaded.filePath), payload);
    assert.equal(upJson.scan?.data?.total, 2);
  } finally {
    stopAllMusicWatchers();
    await web.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('LX06 playback, queue, volume/loop/timer, stop fallback, and auto-advance watcher', async () => {
  const { root, homeDir, musicDir } = makeTempWorkspace();
  try {
    writeFileSync(join(musicDir, '周杰伦 - 晴天.mp3'), Buffer.from('ID3qingtian'));
    writeFileSync(join(musicDir, '陈奕迅 - 十年.ogg'), Buffer.from('OggSshinian'));
    const pluginDataDir = join(homeDir, 'plugins', 'music');

    await runAction('config', {
      musicDir,
      streamBaseUrl: 'http://192.168.31.124:3210',
      speakerSsh: 'lx06=root@192.168.31.104',
    }, { homeDir, pluginDataDir });
    await scanLibrary(pluginDataDir, musicDir, { quick: false });

    const sshCalls: string[] = [];
    let lxStatusCode = 1;
    let transcodeInvoked = 0;

    const deps = {
      watcherIntervalMs: 60,
      watcherFastIntervalMs: 60,
      ffmpegPath: 'ffmpeg',
      execFileFn: async (cmd: string, args: string[]) => {
        if (cmd.includes('ffmpeg')) {
          transcodeInvoked += 1;
          const outPath = args.at(-1)!;
          writeFileSync(outPath, Buffer.from('ID3transcoded-mp3-data-0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789'));
          return { stdout: '', stderr: '' };
        }
        throw new Error('ffprobe unavailable');
      },
      sshRunner: async (_target: unknown, remoteCmd: string) => {
        sshCalls.push(remoteCmd);
        if (remoteCmd.includes('player_get_play_status')) {
          return { stdout: JSON.stringify({ code: 0, info: JSON.stringify({ status: lxStatusCode, volume: 48, loop_type: 0 }) }), stderr: '', code: 0 };
        }
        if (remoteCmd.includes('"action":"stop"')) {
          // Simulate firmware that rejects stop -> triggers pause fallback
          return { stdout: '', stderr: 'not supported', code: 1 };
        }
        return { stdout: '{"code":0}', stderr: '', code: 0 };
      },
    };

    // Play first song -> pushes HTTP URL with HMAC sig and starts watcher
    const p1 = await runAction('play', { query: '晴天' }, { homeDir, pluginDataDir }, deps);
    assert.equal(p1.ok, true);
    assert.equal(p1.data?.currentTrack?.title, '晴天');
    assert.match(String(p1.data?.streamUrl), /^http:\/\/192\.168\.31\.124:3210\/media\/music\/[a-f0-9]+\.mp3\?exp=\d+&sig=[a-f0-9]{64}$/);
    assert.ok(sshCalls.some(c => c.includes('player_play_url')));

    // Wait for watcher to observe status=1 (sawPlaying=true) then switch to status=0 -> auto-advances to 十年 (.ogg -> transcoded .mp3)
    await delay(110);
    lxStatusCode = 0;
    await delay(140);

    const dashAfterAdvance = await runAction('dashboard', { live: false }, { homeDir, pluginDataDir }, deps);
    assert.equal(dashAfterAdvance.data?.currentTrack?.title, '十年');
    assert.equal(transcodeInvoked, 1, '.ogg track must be transcoded to cached .mp3');

    // External pause (status=2) pauses without advancing
    lxStatusCode = 2;
    await delay(120);
    const dashPaused = await runAction('dashboard', { live: false }, { homeDir, pluginDataDir }, deps);
    assert.equal(dashPaused.data?.status, 'paused');
    assert.equal(dashPaused.data?.currentTrack?.title, '十年');

    // Volume, loop, timer, and stop fallback to pause
    const volRes = await runAction('volume', { volume: 60 }, { homeDir, pluginDataDir }, deps);
    assert.equal(volRes.ok, true);
    assert.equal(volRes.data?.volume, 60);

    const loopRes = await runAction('loop', { mode: 'single' }, { homeDir, pluginDataDir }, deps);
    assert.equal(loopRes.ok, true);
    assert.equal(loopRes.data?.loopMode, 'single');

    const timerRes = await runAction('timer', { minutes: 45 }, { homeDir, pluginDataDir }, deps);
    assert.equal(timerRes.ok, true);
    assert.equal(timerRes.data?.minutes, 45);

    const stopRes = await runAction('stop', {}, { homeDir, pluginDataDir }, deps);
    assert.equal(stopRes.ok, true);
    assert.ok(sshCalls.some(c => c.includes('"action":"pause"')), 'stop fallback must issue pause');
  } finally {
    stopAllMusicWatchers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('online music search, SSRF URL rejection, and download-to-library', async () => {
  const { root, homeDir, musicDir } = makeTempWorkspace();
  try {
    const pluginDataDir = join(homeDir, 'plugins', 'music');
    await runAction('config', { musicDir }, { homeDir, pluginDataDir });

    assert.throws(() => detectSourceFromUrl('file:///etc/passwd'), /协议/);
    assert.throws(() => detectSourceFromUrl('http://127.0.0.1:3210/test.mp3'), /局域网|本机/);
    assert.throws(() => detectSourceFromUrl('http://192.168.31.1/a.mp3'), /局域网|本机/);
    assert.equal(detectSourceFromUrl('https://www.bilibili.com/video/BV1xx').source, 'bilibili');
    assert.equal(detectSourceFromUrl('https://music.youtube.com/watch?v=abc').source, 'youtube');

    const mockExecFile = async (cmd: string, args: string[]) => {
      if (args.includes('--flat-playlist')) {
        return {
          stdout: [
            JSON.stringify({ id: 'live1', title: '直播中', is_live: true, duration: 100, url: 'https://www.youtube.com/watch?v=live1' }),
            JSON.stringify({ id: 'long1', title: '十小时合集', duration: 36000, url: 'https://www.youtube.com/watch?v=long1' }),
            JSON.stringify({ id: 'ok1', title: '稻香', artist: '周杰伦', duration: 223, webpage_url: 'https://www.youtube.com/watch?v=ok1' }),
          ].join('\n'),
        };
      }
      if (cmd.includes('yt-dlp')) {
        const outIdx = args.indexOf('-o');
        const template = outIdx >= 0 ? args[outIdx + 1]! : '';
        const outDir = resolve(template, '..');
        const outFile = join(outDir, '稻香.mp3');
        writeFileSync(outFile, Buffer.from('ID3downloaded-daoxiang-audio'));
        return { stdout: `${outFile}\n`, stderr: '' };
      }
      throw new Error('ffprobe unavailable');
    };

    const searchRes = await searchOnlineTracks('稻香 周杰伦', { source: 'youtube', limit: 5 }, { ytDlpPath: '/usr/bin/yt-dlp', execFileFn: mockExecFile });
    assert.equal(searchRes.candidates.length, 1);
    assert.equal(searchRes.candidates[0]?.title, '稻香');

    const dlRes = await runAction('download', { query: '稻香 周杰伦', playAfter: false }, { homeDir, pluginDataDir }, {
      ytDlpPath: '/usr/bin/yt-dlp',
      execFileFn: mockExecFile,
    });
    assert.equal(dlRes.ok, true);
    assert.equal(dlRes.data?.track?.title, '稻香');
    assert.equal(existsSync(String(dlRes.data?.filePath)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('music voice fastpath parses playback commands silently and bails out on TV/download/complex utterances', async () => {
  assert.deepEqual(parseMusicVoiceUtterance('星期五，放首歌'), { kind: 'play', shuffle: true });
  assert.deepEqual(parseMusicVoiceUtterance('播放《晴天》'), { kind: 'play', query: '晴天' });
  assert.deepEqual(parseMusicVoiceUtterance('下一首'), { kind: 'next' });
  assert.deepEqual(parseMusicVoiceUtterance('暂停音乐'), { kind: 'pause' });
  assert.deepEqual(parseMusicVoiceUtterance('继续播放'), { kind: 'resume' });
  assert.deepEqual(parseMusicVoiceUtterance('别放歌了'), { kind: 'stop' });
  assert.deepEqual(parseMusicVoiceUtterance('把音乐音量调到三十五'), { kind: 'volume', volume: 35 });
  assert.deepEqual(parseMusicVoiceUtterance('单曲循环'), { kind: 'loop', mode: 'single' });
  assert.deepEqual(parseMusicVoiceUtterance('20分钟后停止放歌'), { kind: 'timer', minutes: 20 });

  // Bail-outs
  assert.equal(parseMusicVoiceUtterance('帮我下载晴天'), undefined);
  assert.equal(parseMusicVoiceUtterance('搜一首稻香'), undefined);
  assert.equal(parseMusicVoiceUtterance('打开客厅电视'), undefined);
  assert.equal(parseMusicVoiceUtterance('明天早上8点播放音乐'), undefined);
  assert.equal(parseMusicVoiceUtterance('播放电视动画'), undefined);

  const { root, homeDir, musicDir } = makeTempWorkspace();
  try {
    writeFileSync(join(musicDir, '周杰伦 - 晴天.mp3'), Buffer.from('ID3qingtian'));
    await runAction('config', { musicDir }, { homeDir });
    await scanLibrary(join(homeDir, 'plugins', 'music'), musicDir, { quick: false });

    const fastRes = await tryPluginVoiceFastpath(homeDir, {
      text: '星期五，播放晴天',
      channelId: 'xiaoai-lx06',
      platform: 'xiaoai',
      speakerRole: 'member',
      explicitWake: true,
    });
    // Without mocked SSH on a test machine, play fails with missing speaker or returns handled error;
    // verify member access is allowed and fastpath claimed the utterance!
    assert.equal(fastRes?.handled, true);
    assert.equal(fastRes?.plugin, 'music');

    for (const phrase of ['播放晴天', '下一首', '上一首', '继续播放']) {
      const silentRes = await handleMusicVoiceFastpath(
        { text: phrase, channelId: 'xiaoai-lx06', platform: 'xiaoai' },
        { homeDir },
        async () => ({ ok: true, message: 'ok', data: { status: 'playing' } }),
      );
      assert.equal(silentRes.handled, true);
      assert.equal(silentRes.ok, true);
      assert.equal(silentRes.speech, undefined, `${phrase} must return silent speech=undefined`);
    }
  } finally {
    stopAllMusicWatchers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CS80 music widget collector reads playback-state/library and renderer handles all 4 card spans', () => {
  const { root, homeDir } = makeTempWorkspace('friday-cs80-music-');
  try {
    const musicPluginData = join(homeDir, 'plugins', 'music');
    mkdirSync(musicPluginData, { recursive: true });
    writeFileSync(join(musicPluginData, 'library.json'), JSON.stringify({
      updatedAt: Date.now(),
      musicDir: '/mnt/data/music',
      tracks: [
        { id: 't111111111111', title: '晴天', artist: '周杰伦', album: '叶惠美', durationSec: 269 },
        { id: 't222222222222', title: '稻香', artist: '周杰伦', album: '魔杰座', durationSec: 223 },
      ],
    }));
    writeFileSync(join(musicPluginData, 'playback-state.json'), JSON.stringify({
      status: 'playing',
      currentTrackId: 't111111111111',
      queue: ['t111111111111', 't222222222222'],
      queueIndex: 0,
      loopMode: 'list',
      volume: 52,
      startedAtMs: Date.now() - 45_000,
      positionSec: 0,
      updatedAt: Date.now(),
    }));

    const py = `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'tools', 'cs80-face'))})
from widgets import WidgetDataHub, discover_widget_catalog, PlacedCard
import renderer

home = Path(${JSON.stringify(homeDir)})
cat = discover_widget_catalog(home, repo_plugins_dir=Path(${JSON.stringify(join(REPO_ROOT, 'plugins'))}))
assert any(item["kind"] == "music" for item in cat), "music missing from CS80 catalog"

from widgets import LayoutStore
hub = WidgetDataHub(home, lambda _p, _t=5.0: {"ok": False}, LayoutStore(home / "cs80-layout.json"), disable_network=True)
hub._collect_music(home / "plugins" / "music" / "playback-state.json", home / "plugins" / "music" / "library.json")
data = hub.get_widget("music")
assert data["ok"] is True
assert data["playing"] is True
assert data["title"] == "晴天"
assert data["artist"] == "周杰伦"
assert data["trackCount"] == 2
assert data["volume"] == 52

if renderer.cairo is not None:
    fr = renderer.FaceRenderer()
    surf = renderer.cairo.ImageSurface(renderer.cairo.FORMAT_RGB16_565, 800, 1280)
    ctx = renderer.cairo.Context(surf)
    for ws, hs, w, h in ((1, 1, 356.0, 220.0), (2, 1, 728.0, 220.0), (1, 2, 356.0, 456.0), (2, 2, 728.0, 456.0)):
        card = PlacedCard(card_id=f"m-{ws}x{hs}", kind="music", x=36.0, y=560.0, w=w, h=h, w_span=ws, h_span=hs, title="音乐播放")
        fr._card_music(ctx, card, data)
print("CS80_MUSIC_OK")
`;
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
    assert.match(out, /CS80_MUSIC_OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
