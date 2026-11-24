import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';
import {
  ensureMusicStreamSecret,
  MAX_MUSIC_COOKIES_BYTES,
  MAX_MUSIC_UPLOAD_BYTES,
  signMusicStreamToken,
  verifyMusicStreamToken,
} from '../src/music-media.js';
import { tryPluginVoiceFastpath } from '../src/plugin.js';
import { runAction, stopAllMusicWatchers } from '../plugins/music/index.mjs';
import { parseMusicVoiceUtterance, handleMusicVoiceFastpath } from '../plugins/music/fastpath.mjs';
import {
  detectSourceFromUrl,
  formatYtDlpError,
  parseYtDlpProgressLine,
  searchOnlineTracks,
  upsertDownloadJob,
} from '../plugins/music/downloader.mjs';
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

    // SoundCloud URL detection & scsearch routing
    assert.equal(detectSourceFromUrl('https://soundcloud.com/artist/track-name').source, 'soundcloud');
    assert.equal(detectSourceFromUrl('https://on.soundcloud.com/abc123').source, 'soundcloud');
    let sawScSearch = false;
    const scRes = await searchOnlineTracks('晴天 周杰伦', { source: 'soundcloud', limit: 3 }, {
      ytDlpPath: '/usr/bin/yt-dlp',
      execFileFn: async (_cmd: string, args: string[]) => {
        sawScSearch = args.some(a => a.startsWith('scsearch3:'));
        return {
          stdout: JSON.stringify({
            id: 'sc1',
            title: '晴天（SoundCloud）',
            uploader: 'ArtistSC',
            duration: 210,
            webpage_url: 'https://soundcloud.com/artist/qingtian',
          }),
        };
      },
    });
    assert.equal(sawScSearch, true);
    assert.equal(scRes.source, 'soundcloud');
    assert.equal(scRes.candidates[0]?.source, 'soundcloud');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('yt-dlp error formatting, ephemeral cookies.txt handling, legacy job normalization, and /api/music/cookies endpoint', async () => {
  // 1. formatYtDlpError unit checks
  const ytNoCookie = formatYtDlpError({
    message: 'Command failed: /home/duty/.local/bin/yt-dlp ...',
    stderr: 'ERROR: [youtube] L3GughXEmyY: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
  }, { source: 'youtube', hasCookies: false });
  assert.match(ytNoCookie, /YouTube 触发风控校验.*SoundCloud/);

  const ytWithCookie = formatYtDlpError(
    'ERROR: [youtube] abc: Sign in to confirm you\'re not a bot.',
    { source: 'youtube', hasCookies: true },
  );
  assert.match(ytWithCookie, /cookies\.txt 可能已过期/);

  const biliNoCookie = formatYtDlpError('ERROR: HTTP Error 412: Precondition Failed', { source: 'bilibili', hasCookies: false });
  assert.match(biliNoCookie, /HTTP 412.*BV/);

  const biliWithCookie = formatYtDlpError('ERROR: HTTP Error 412: Precondition Failed', { source: 'bilibili', hasCookies: true });
  assert.match(biliWithCookie, /HTTP 412.*已失效/);

  const ytGuestCookieErr = formatYtDlpError(
    'ERROR: [youtube] abc: Sign in to confirm you\'re not a bot.',
    { source: 'youtube', hasCookies: true, hasYouTubeAuth: false },
  );
  assert.match(ytGuestCookieErr, /访客 Cookie（缺少账号登录态）/);

  const drmErr = formatYtDlpError('[soundcloud] 2439405147: This video is DRM protected');
  assert.match(drmErr, /DRM 版权加密保护/);

  const badCookieErr = formatYtDlpError('ERROR: cookies.txt does not look like a Netscape format cookies file', {});
  assert.match(badCookieErr, /cookies\.txt 格式无效/);

  const genericErr = formatYtDlpError({
    message: 'Command failed: /usr/bin/yt-dlp https://example.com/a',
    stderr: 'ERROR: [generic] Unsupported URL: https://example.com/a See https://github.com/yt-dlp/yt-dlp',
  });
  assert.equal(genericErr.includes('Command failed:'), false);
  assert.match(genericErr, /Unsupported URL/);

  // 2. HTTP /api/music/cookies upload, ephemeral --cookies copy, legacy error normalization, and clearCookies
  const root = mkdtempSync(join(tmpdir(), 'friday-music-cookies-'));
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

    // Auth required
    const unauth = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      body: '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsecretval\n',
    });
    assert.equal(unauth.status, 401);

    // Reject empty, binary NUL, invalid format, and oversized body
    const emptyRes = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      headers: authHeaders,
      body: '',
    });
    assert.equal(emptyRes.status, 400);

    const nulRes = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      headers: authHeaders,
      body: '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc\0def\n',
    });
    assert.equal(nulRes.status, 400);

    const badFormatRes = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      headers: authHeaders,
      body: '{"not":"netscape"}\nhello world\n',
    });
    assert.equal(badFormatRes.status, 400);

    const overRes = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      headers: authHeaders,
      body: 'x'.repeat(MAX_MUSIC_COOKIES_BYTES + 10),
    });
    assert.equal(overRes.status, 413);

    // Reject YouTube guest-only cookies (no SID/HSID/SAPISID/LOGIN_INFO)
    const guestOnlyRes = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'text/plain; charset=utf-8' },
      body: [
        '.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\ttz=Asia.Shanghai',
        '.youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tabcdef12345',
        '.youtube.com\tTRUE\t/\tTRUE\t1811008334\tVISITOR_INFO1_LIVE\txyz12345678',
      ].join('\n'),
    });
    assert.equal(guestOnlyRes.status, 400);
    const guestErrJson = await guestOnlyRes.json() as { error?: string };
    assert.match(String(guestErrJson.error), /访客 Cookie|缺少账号登录态/);

    // Valid Netscape lines WITHOUT header -> auto-prepends header, sets 0600, redacts secret values
    const sampleCookies = [
      '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tHSID\tsuper-secret-yt-cookie',
      '.bilibili.com\tTRUE\t/\tFALSE\t1893456000\tSESSDATA\tsuper-secret-bili-cookie',
    ].join('\n');
    const okCookies = await fetch(`${base}/api/music/cookies`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'text/plain; charset=utf-8' },
      body: sampleCookies,
    });
    assert.equal(okCookies.status, 200);
    const cookiesPayload = await okCookies.json() as {
      ok: boolean;
      cookies: {
        configured: boolean;
        cookieCount: number;
        hasYouTube: boolean;
        hasYouTubeAuth: boolean;
        hasBilibili: boolean;
        hasBilibiliAuth: boolean;
        warning?: string;
        domains: string[];
      };
    };
    const serialized = JSON.stringify(cookiesPayload);
    assert.equal(cookiesPayload.ok, true);
    assert.equal(cookiesPayload.cookies.configured, true);
    assert.equal(cookiesPayload.cookies.cookieCount, 2);
    assert.equal(cookiesPayload.cookies.hasYouTube, true);
    assert.equal(cookiesPayload.cookies.hasYouTubeAuth, true);
    assert.equal(cookiesPayload.cookies.hasBilibili, true);
    assert.equal(cookiesPayload.cookies.hasBilibiliAuth, true);
    assert.equal(cookiesPayload.cookies.warning, undefined);
    assert.equal(serialized.includes('super-secret'), false, 'cookie values must never be echoed');
    assert.equal(serialized.includes('SESSDATA'), false, 'cookie names must never be echoed');

    const pluginDataDir = join(home, 'plugins', 'music');
    const savedCookiesPath = join(pluginDataDir, 'cookies.txt');
    assert.equal(existsSync(savedCookiesPath), true);
    assert.equal(statSync(savedCookiesPath).mode & 0o777, 0o600);
    const savedText = readFileSync(savedCookiesPath, 'utf8');
    assert.match(savedText, /^# Netscape HTTP Cookie File\n/);

    // Verify ephemeral --cookies copy is passed to yt-dlp during search-online & download, then cleaned up
    const seenCookiePaths: string[] = [];
    const mockExecFile = async (_cmd: string, args: string[]) => {
      const idx = args.indexOf('--cookies');
      assert.ok(idx >= 0, 'yt-dlp must receive --cookies flag when cookies.txt is configured');
      const passedCookiePath = args[idx + 1]!;
      assert.notEqual(passedCookiePath, savedCookiesPath, 'must use ephemeral copy rather than mutating stored cookies.txt');
      assert.equal(existsSync(passedCookiePath), true);
      seenCookiePaths.push(passedCookiePath);

      if (args.includes('--flat-playlist')) {
        return {
          stdout: JSON.stringify({ id: 'yt1', title: '晴天', artist: '周杰伦', duration: 269, webpage_url: 'https://www.youtube.com/watch?v=yt1' }),
        };
      }
      const outIdx = args.indexOf('-o');
      const outDir = resolve(args[outIdx + 1]!, '..');
      const outFile = join(outDir, '晴天.mp3');
      writeFileSync(outFile, Buffer.from('ID3mock-mp3-data'));
      return { stdout: `${outFile}\n`, stderr: '' };
    };

    const searchActionRes = await runAction('search-online', { query: '晴天', source: 'youtube' }, { homeDir: home }, {
      ytDlpPath: '/usr/bin/yt-dlp',
      execFileFn: mockExecFile,
    });
    assert.equal(searchActionRes.ok, true);

    const dlActionRes = await runAction('download', { url: 'https://www.youtube.com/watch?v=yt1', playAfter: false }, { homeDir: home }, {
      ytDlpPath: '/usr/bin/yt-dlp',
      execFileFn: mockExecFile,
    });
    assert.equal(dlActionRes.ok, true);
    assert.equal(seenCookiePaths.length, 2);
    for (const tmpCookie of seenCookiePaths) {
      assert.equal(existsSync(tmpCookie), false, 'ephemeral cookie copy must be cleaned up after yt-dlp finishes');
    }

    // Legacy raw errors (YouTube bot-check + SoundCloud DRM) in downloads.json are normalized on dashboard
    writeFileSync(join(pluginDataDir, 'downloads.json'), JSON.stringify({
      updatedAt: Date.now(),
      jobs: [
        {
          id: 'dl-sc-drm',
          status: 'error',
          query: '',
          url: 'https://soundcloud.com/artist/drm-track',
          source: 'soundcloud',
          title: 'DRM 曲目',
          artist: '歌手',
          error: '[soundcloud] 2439405147: This video is DRM protected',
          startedAt: Date.now() - 500,
          finishedAt: Date.now() - 100,
        },
        {
          id: 'dl-legacy',
          status: 'error',
          query: '',
          url: 'https://www.youtube.com/watch?v=L3GughXEmyY',
          source: 'youtube',
          title: '慌啥子嘛',
          artist: 'Z Y',
          error: 'Command failed: /home/duty/.local/bin/yt-dlp ... https://www.youtube.com/watch?v=L3GughXEmyY\nERROR: [youtube] L3GughXEmyY: Sign in to confirm you’re not a bot.',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now(),
        },
      ],
    }));

    const dashBeforeClear = await runAction('dashboard', { live: false }, { homeDir: home });
    assert.equal(dashBeforeClear.ok, true);
    assert.equal(dashBeforeClear.data?.cookies?.configured, true);
    assert.equal(dashBeforeClear.data?.cookies?.hasYouTubeAuth, true);
    assert.match(String(dashBeforeClear.data?.downloads?.[0]?.error), /DRM 版权加密保护/);
    assert.equal(dashBeforeClear.data?.downloads?.[1]?.error.includes('Command failed:'), false);
    assert.match(String(dashBeforeClear.data?.downloads?.[1]?.error), /cookies\.txt 可能已过期/);

    // Pre-existing guest-only cookies.txt on disk reports warning and guest-cookie guidance
    writeFileSync(savedCookiesPath, [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tguest-only',
      '.youtube.com\tTRUE\t/\tTRUE\t1811008334\tVISITOR_INFO1_LIVE\tvisitor123',
    ].join('\n'), { mode: 0o600 });
    const dashGuestCookies = await runAction('dashboard', { live: false }, { homeDir: home });
    assert.equal(dashGuestCookies.data?.cookies?.configured, true);
    assert.equal(dashGuestCookies.data?.cookies?.hasYouTubeAuth, false);
    assert.ok(String(dashGuestCookies.data?.cookies?.warning || '').length > 0);
    assert.match(String(dashGuestCookies.data?.downloads?.[1]?.error), /访客 Cookie（缺少账号登录态）/);

    // Clear cookies via config action
    const cleared = await runAction('config', { clearCookies: true }, { homeDir: home });
    assert.equal(cleared.ok, true);
    assert.equal(existsSync(savedCookiesPath), false);
    assert.equal(cleared.data?.cookies?.configured, false);
    const dashAfterClear = await runAction('dashboard', { live: false }, { homeDir: home });
    assert.equal(dashAfterClear.data?.cookies?.configured, false);
    assert.match(String(dashAfterClear.data?.downloads?.[1]?.error), /YouTube 触发风控校验/);
  } finally {
    stopAllMusicWatchers();
    await web.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('streaming download progress parsing, live dashboard progress, active-job protection, and downloads history cleanup', async () => {
  // 1. Progress line parser checks
  const dlProg = parseYtDlpProgressLine('FRIDAY_DL_PROGRESS:downloading| 42.3%| 1.25MiB/s|00:08|1500000|3500000|NA');
  assert.equal(dlProg?.phase, 'downloading');
  assert.equal(dlProg?.progressPercent, 42.3);
  assert.equal(dlProg?.downloadedBytes, 1_500_000);
  assert.equal(dlProg?.totalBytes, 3_500_000);
  assert.match(String(dlProg?.progressText), /42%.*1\.25MiB\/s.*00:08/);

  const dlFin = parseYtDlpProgressLine('FRIDAY_DL_PROGRESS:finished|100%|2.00MiB/s|00:00|3500000|3500000|NA');
  assert.equal(dlFin?.phase, 'processing');
  assert.equal(dlFin?.progressPercent, 96);

  const ppProg = parseYtDlpProgressLine('FRIDAY_PP_PROGRESS:started|ExtractAudio');
  assert.equal(ppProg?.phase, 'processing');
  assert.equal(ppProg?.progressPercent, 97);
  assert.match(String(ppProg?.progressText), /提取并转码音频/);

  const stdProg = parseYtDlpProgressLine('[download]  65.0% of 4.00MiB at 2.00MiB/s ETA 00:01');
  assert.equal(stdProg?.phase, 'downloading');
  assert.equal(stdProg?.progressPercent, 65);
  assert.match(String(stdProg?.progressText), /65%.*2\.00MiB\/s.*00:01/);

  assert.equal(parseYtDlpProgressLine('/tmp/music/song.mp3'), null);

  // 2. Live streaming download via mocked spawnFn + history cleanup via downloads action
  const { root, homeDir, musicDir } = makeTempWorkspace('friday-music-prog-');
  try {
    const pluginDataDir = join(homeDir, 'plugins', 'music');
    await runAction('config', { musicDir }, { homeDir, pluginDataDir });

    const childOut = new PassThrough();
    const childErr = new PassThrough();
    const mockChild = Object.assign(new EventEmitter(), {
      stdout: childOut,
      stderr: childErr,
      kill: () => {},
    });
    let spawned = false;
    let capturedOutDir = '';

    const mockSpawn = (_cmd: string, args: string[]) => {
      const outIdx = args.indexOf('-o');
      capturedOutDir = resolve(args[outIdx + 1]!, '..');
      spawned = true;
      return mockChild;
    };

    const dlStart = await runAction('download', {
      url: 'https://soundcloud.com/artist/live-progress-song',
      titleHint: '实时进度测试曲目',
      artistHint: '测试歌手',
      playAfter: false,
      async: true,
    }, { homeDir, pluginDataDir }, {
      ytDlpPath: '/usr/bin/yt-dlp',
      spawnFn: mockSpawn,
    });
    assert.equal(dlStart.ok, true);
    const jobId = String(dlStart.data?.jobId ?? '');
    assert.ok(jobId);

    for (let i = 0; i < 20 && !spawned; i += 1) {
      await delay(10);
    }
    assert.equal(spawned, true, 'mock child process must be spawned');

    // Push live download progress chunk
    childErr.write('FRIDAY_DL_PROGRESS:downloading| 48.0%| 1.50MiB/s|00:04|1680000|3500000|NA\n');
    await delay(20);

    const dashDownloading = await runAction('dashboard', { live: false }, { homeDir, pluginDataDir });
    const liveJob = dashDownloading.data?.downloads?.find((j: any) => j.id === jobId);
    assert.equal(liveJob?.status, 'downloading');
    assert.equal(liveJob?.progressPercent, 48);
    assert.equal(liveJob?.downloadedBytes, 1_680_000);
    assert.equal(liveJob?.totalBytes, 3_500_000);
    assert.match(String(liveJob?.progressText), /48%.*1\.50MiB\/s/);

    // Active download must be protected from removal
    const blockedRemove = await runAction('downloads', { op: 'remove', jobId }, { homeDir, pluginDataDir });
    assert.equal(blockedRemove.ok, false);
    assert.match(String(blockedRemove.message), /正在进行中/);

    // Push postprocess chunk then finish
    childErr.write('FRIDAY_PP_PROGRESS:started|ExtractAudio\n');
    await delay(20);
    const dashProcessing = await runAction('dashboard', { live: false }, { homeDir, pluginDataDir });
    assert.equal(dashProcessing.data?.downloads?.find((j: any) => j.id === jobId)?.phase, 'processing');
    assert.equal(dashProcessing.data?.downloads?.find((j: any) => j.id === jobId)?.progressPercent, 97);

    const producedFile = join(capturedOutDir, '实时进度测试曲目.mp3');
    writeFileSync(producedFile, Buffer.from('ID3streaming-progress-done'));
    childOut.write(`${producedFile}\n`);
    childOut.end();
    childErr.end();
    mockChild.emit('close', 0);

    let finishedStatus = '';
    let finishedPercent: unknown = null;
    for (let i = 0; i < 40; i += 1) {
      const d = await runAction('dashboard', { live: false }, { homeDir, pluginDataDir });
      const j = d.data?.downloads?.find((item: any) => item.id === jobId);
      if (j?.status === 'done') {
        finishedStatus = j.status;
        finishedPercent = j.progressPercent;
        break;
      }
      await delay(15);
    }
    assert.equal(finishedStatus, 'done');
    assert.equal(finishedPercent, 100);

    // Seed two additional history jobs and test remove / clear failed / clear all
    upsertDownloadJob(pluginDataDir, {
      id: 'dl-err-1',
      status: 'error',
      query: '',
      url: 'https://soundcloud.com/a/err1',
      source: 'soundcloud',
      title: '失败记录 1',
      artist: '',
      error: '[soundcloud] 1: This video is DRM protected',
      startedAt: Date.now() - 2000,
      finishedAt: Date.now() - 1000,
    });
    upsertDownloadJob(pluginDataDir, {
      id: 'dl-err-2',
      status: 'error',
      query: '',
      url: 'https://soundcloud.com/a/err2',
      source: 'soundcloud',
      title: '失败记录 2',
      artist: '',
      error: '超时',
      startedAt: Date.now() - 1500,
      finishedAt: Date.now() - 500,
    });

    const listRes = await runAction('downloads', { op: 'list' }, { homeDir, pluginDataDir });
    assert.equal(listRes.data?.jobs?.length, 3);

    const rmOne = await runAction('downloads', { op: 'remove', jobId: 'dl-err-2' }, { homeDir, pluginDataDir });
    assert.equal(rmOne.ok, true);
    assert.equal(rmOne.data?.removed, 1);
    assert.equal(rmOne.data?.remaining, 2);

    const clearFailed = await runAction('downloads', { op: 'clear', scope: 'failed' }, { homeDir, pluginDataDir });
    assert.equal(clearFailed.ok, true);
    assert.equal(clearFailed.data?.removed, 1);
    assert.equal(clearFailed.data?.remaining, 1);
    assert.equal(clearFailed.data?.jobs?.[0]?.id, jobId);

    const clearAll = await runAction('downloads', { op: 'clear', scope: 'all' }, { homeDir, pluginDataDir });
    assert.equal(clearAll.ok, true);
    assert.equal(clearAll.data?.removed, 1);
    assert.equal(clearAll.data?.remaining, 0);
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
