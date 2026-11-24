import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { ImChannelConfig } from '../src/store.js';
import {
  AUDIO_STREAM_MAGIC_1CH_S32,
  AUDIO_STREAM_MAGIC_8CH_S16,
  beamformHexArray,
  computeRms,
  decodeInterleavedPcm16le,
  FRONTEND_SAMPLE_RATE,
  LX06_HEX_MIC_COORDS,
  OnlineHexBeamformer,
  parseAudioStreamHeader,
  PartitionedBlockAec,
  runOfflineAec,
  type DcBlockerState,
} from '../src/xiaoai/audio-frontend.js';
import {
  collectVoiceHotwords,
  createGeminiLiveTranscribeSession,
  createHybridAsrRecognizer,
  resolveGeminiLiveTranscribeWsUrl,
  transcribeWithGemini,
  type LiveAsrSession,
  type LiveAsrWebSocketLike,
} from '../src/xiaoai/asr-engine.js';
import {
  computeKwsIdleGateRms,
  XiaoaiKwsMonitor,
  type XiaoaiAsrRecognizer,
  type XiaoaiKwsSpotter,
  type XiaoaiSpeechDetector,
} from '../src/xiaoai/kws-monitor.js';
import {
  isXiaoaiFollowUpCancel,
  isXiaoaiSilenceCommand,
} from '../src/xiaoai-kws.js';
import { XiaoaiChannelAdapter } from '../src/im/channels/xiaoai.js';
import type { ImGatewayContext } from '../src/im/types.js';
import { SSH_PAUSE_COMMAND } from '../src/xiaoai/ssh.js';
import {
  SPEAKER_SAMPLE_RATE,
  XiaoaiSpeakerManager,
  type XiaoaiSpeakerExtractor,
} from '../src/xiaoai/speaker-verify.js';
import { enrichWechatVoice } from '../src/wechat/media-enrich.js';
import { until } from './helpers/async.js';

function encodeInterleavedInt16Frames(channels: readonly Float32Array[]): Buffer {
  const numChannels = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const buf = Buffer.allocUnsafe(numFrames * numChannels * 2);
  for (let f = 0; f < numFrames; f++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = channels[c]?.[f] ?? 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(clamped * 32767))), (f * numChannels + c) * 2);
    }
  }
  return buf;
}

function circularAzimuthDiffDeg(a: number, b: number): number {
  const diff = Math.abs(((a - b + 540) % 360) - 180);
  return diff;
}

function goertzelAmplitude(samples: Float32Array, freqHz: number, sampleRate: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const omega = (2 * Math.PI * freqHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + (samples[i] ?? 0);
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * Math.cos(omega);
  const imag = q2 * Math.sin(omega);
  return (2 * Math.hypot(real, imag)) / n;
}

function synthHexPlaneWave(params: {
  durationSec: number;
  azimuthDeg: number;
  sampleRate?: number;
  signalAtTime: (t: number) => number;
  dcOffsets?: readonly number[];
  noiseAmp?: number;
  seed?: number;
}): Float32Array[] {
  const sampleRate = params.sampleRate ?? FRONTEND_SAMPLE_RATE;
  const totalSamples = Math.round(params.durationSec * sampleRate);
  const rad = (params.azimuthDeg * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);

  let rngState = (params.seed ?? 1337) >>> 0;
  const nextRand = (): number => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0xffffffff - 0.5;
  };

  return LX06_HEX_MIC_COORDS.map(([xm, ym], idx) => {
    const out = new Float32Array(totalSamples);
    // Sound arriving FROM azimuthDeg reaches mics in the +u direction EARLIER by tau = (p . u) / c
    const tau = (xm * cosT + ym * sinT) / 343;
    const dc = params.dcOffsets?.[idx] ?? 0;
    const noiseAmp = params.noiseAmp ?? 0;
    for (let n = 0; n < totalSamples; n++) {
      const t = n / sampleRate + tau;
      out[n] = dc + params.signalAtTime(t) + noiseAmp * 2 * nextRand();
    }
    return out;
  });
}

test('audio-frontend: parseAudioStreamHeader and decodeInterleavedPcm16le demux 8ch S16_LE with split chunks and DC removal', () => {
  assert.equal(parseAudioStreamHeader(Buffer.alloc(0)), 'need_more');
  assert.equal(parseAudioStreamHeader(Buffer.from('FRPCM8', 'latin1')), 'need_more');
  assert.equal(parseAudioStreamHeader(Buffer.from('\x00\x01\x02\x03', 'latin1')), 'none');
  assert.equal(parseAudioStreamHeader(Buffer.from('RAWPCM00', 'latin1')), 'none');

  const h8 = parseAudioStreamHeader(Buffer.from(`${AUDIO_STREAM_MAGIC_8CH_S16}extra`, 'latin1'));
  assert.deepEqual(h8, { channels: 8, sampleFormat: 's16le', consumed: 8 });

  const h32 = parseAudioStreamHeader(Buffer.from(AUDIO_STREAM_MAGIC_1CH_S32, 'latin1'));
  assert.deepEqual(h32, { channels: 1, sampleFormat: 's32le', consumed: 8 });

  const frames = 2048;
  const channels = Array.from({ length: 8 }, (_, chIdx) => {
    const arr = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      if (chIdx < 6) {
        const dc = (chIdx + 1) * 0.02;
        const tone = 0.08 * Math.sin((2 * Math.PI * (300 + chIdx * 50) * i) / FRONTEND_SAMPLE_RATE);
        arr[i] = dc + tone;
      } else {
        arr[i] = chIdx === 6 ? 0.20 : 0.40;
      }
    }
    return arr;
  });

  const payload = encodeInterleavedInt16Frames(channels);
  // Split at arbitrary non-frame-aligned boundaries (5, 19, 1003 bytes...)
  const slices = [
    payload.subarray(0, 5),
    payload.subarray(5, 24),
    payload.subarray(24, 1027),
    payload.subarray(1027, 8191),
    payload.subarray(8191),
  ];

  const dcStates: DcBlockerState[] = [];
  let leftover: Buffer = Buffer.alloc(0);
  const micCollected = Array.from({ length: 6 }, () => [] as Float32Array[]);
  const refCollected: Float32Array[] = [];

  for (const slice of slices) {
    const res = decodeInterleavedPcm16le(slice, leftover, 8, dcStates);
    leftover = res.leftover;
    if ((res.mics[0]?.length ?? 0) > 0) {
      assert.equal(res.mics.length, 6);
      assert.ok(Math.abs(res.refRms - 0.30) < 0.005, `Expected averaged ch6+ch7 refRms ~0.30, got ${res.refRms}`);
      res.mics.forEach((m, idx) => micCollected[idx]!.push(m));
      refCollected.push(res.ref);
    }
  }

  assert.equal(leftover.length, 0);
  const totalDecoded = micCollected[0]!.reduce((s, c) => s + c.length, 0);
  assert.equal(totalDecoded, frames);

  // Tail after DC blocker warm-up should have near-zero DC mean
  const ch5Concat = Buffer.alloc(0);
  void ch5Concat;
  const ch5Last = micCollected[5]![micCollected[5]!.length - 1]!;
  let tailMean = 0;
  for (let i = Math.max(0, ch5Last.length - 400); i < ch5Last.length; i++) {
    tailMean += ch5Last[i]!;
  }
  tailMean /= Math.min(400, ch5Last.length);
  assert.ok(Math.abs(tailMean) < 0.015, `Expected DC offset removed after warm-up, got mean=${tailMean}`);
});

test('audio-frontend: PartitionedBlockAec and runOfflineAec achieve >=10dB ERLE, preserve double-talk, and bypass silence', () => {
  const sr = FRONTEND_SAMPLE_RATE;
  const total = sr * 2; // 2 seconds

  // Speech-like colored wideband speaker reference signal (300-3400Hz modulated envelope)
  const ref = new Float32Array(total);
  let rng = 42;
  let lp = 0;
  let hp = 0;
  let prevX = 0;
  for (let i = 0; i < total; i++) {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    const white = (rng / 0xffffffff - 0.5) * 0.8;
    lp = 0.65 * lp + 0.35 * white;
    hp = lp - prevX + 0.92 * hp;
    prevX = lp;
    const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 3.5 * i) / sr);
    ref[i] = hp * env;
  }

  // 3-tap room impulse response at 16, 64, and 180 samples delay
  const echoOnly = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const e1 = i >= 16 ? 0.45 * ref[i - 16]! : 0;
    const e2 = i >= 64 ? 0.22 * ref[i - 64]! : 0;
    const e3 = i >= 180 ? 0.12 * ref[i - 180]! : 0;
    echoOnly[i] = e1 + e2 + e3;
  }

  // 1. Offline two-pass AEC
  const offlineRes = runOfflineAec(echoOnly, ref);
  assert.ok(offlineRes.echoReductionDb >= 10, `Expected offline ERLE >= 10 dB, got ${offlineRes.echoReductionDb.toFixed(2)} dB`);

  // 2. Streaming online AEC across chunks (measure steady-state second half ERLE >= 10 dB)
  const onlineAec = new PartitionedBlockAec();
  const onlineOut = new Float32Array(total);
  for (let pos = 0; pos < total; pos += 320) {
    const end = Math.min(total, pos + 320);
    const cleanedChunk = onlineAec.process(echoOnly.subarray(pos, end), ref.subarray(pos, end));
    onlineOut.set(cleanedChunk, pos);
  }
  const secondHalfInRms = computeRms(echoOnly.subarray(sr));
  const secondHalfOutRms = computeRms(onlineOut.subarray(sr));
  const steadyErleDb = 20 * Math.log10(secondHalfInRms / Math.max(1e-9, secondHalfOutRms));
  assert.ok(steadyErleDb >= 10, `Expected steady-state online ERLE >= 10 dB, got ${steadyErleDb.toFixed(2)} dB`);

  // 3. Double-talk preservation & non-divergence
  const nearEndSpeech = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (i >= sr) {
      nearEndSpeech[i] =
        0.18 * Math.sin((2 * Math.PI * 520 * i) / sr)
        + 0.12 * Math.sin((2 * Math.PI * 1120 * i) / sr);
    }
  }
  const doubleTalkMic = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    doubleTalkMic[i] = echoOnly[i]! + nearEndSpeech[i]!;
  }
  const dtRes = runOfflineAec(doubleTalkMic, ref);
  assert.ok(
    computeRms(dtRes.samples) <= computeRms(doubleTalkMic) * 1.15,
    'AEC output must never diverge during double-talk',
  );
  // Check near-end speech correlation in second half
  let dot = 0;
  let normNear = 0;
  let normOut = 0;
  for (let i = sr + 512; i < total - 256; i++) {
    const s = nearEndSpeech[i]!;
    const o = dtRes.samples[i]!;
    dot += s * o;
    normNear += s * s;
    normOut += o * o;
  }
  const corr = dot / Math.sqrt(Math.max(1e-12, normNear * normOut));
  assert.ok(corr >= 0.70, `Expected near-end speech preserved during double-talk (corr=${corr.toFixed(3)})`);

  // 4. Silent reference bypass (fresh instance & after >2 silent blocks settle echo tail)
  const silentRef = new Float32Array(total);
  const freshAec = new PartitionedBlockAec();
  assert.equal(freshAec.process(nearEndSpeech, silentRef), nearEndSpeech);
  onlineAec.process(nearEndSpeech, silentRef); // transitions silentBlocks > 2 after active echo
  assert.equal(onlineAec.process(nearEndSpeech, silentRef), nearEndSpeech);
  const offlineSilent = runOfflineAec(nearEndSpeech, silentRef);
  assert.equal(offlineSilent.echoReductionDb, 0);
  assert.equal(offlineSilent.samples, nearEndSpeech);
});

test('audio-frontend: beamformHexArray recovers LX06 DOA within +-15deg, eliminates 3.65kHz comb null, and handles dead mics', () => {
  const signalFn = (t: number): number =>
    0.16 * Math.sin(2 * Math.PI * 420 * t)
    + 0.14 * Math.sin(2 * Math.PI * 1250 * t)
    + 0.14 * Math.sin(2 * Math.PI * 2400 * t)
    + 0.22 * Math.sin(2 * Math.PI * 3650 * t);

  for (const targetAz of [60, 210]) {
    const cleanMics = synthHexPlaneWave({
      durationSec: 0.8,
      azimuthDeg: targetAz,
      signalAtTime: signalFn,
      noiseAmp: 0.08,
      seed: targetAz + 7,
    });
    const steadyStart = 1024;
    const steadyEnd = cleanMics[0]!.length - 1024;
    const singleMic3650Amp = goertzelAmplitude(cleanMics[0]!.subarray(steadyStart, steadyEnd), 3650, FRONTEND_SAMPLE_RATE);

    // Blind sum of ch0+ch2+ch4 cancels 3.65 kHz due to hexagon geometry!
    const blindSum = new Float32Array(cleanMics[0]!.length);
    for (let i = 0; i < blindSum.length; i++) {
      blindSum[i] = 0.34 * cleanMics[0]![i]! + 0.33 * cleanMics[2]![i]! + 0.33 * cleanMics[4]![i]!;
    }
    const blind3650Amp = goertzelAmplitude(blindSum.subarray(steadyStart, steadyEnd), 3650, FRONTEND_SAMPLE_RATE);

    const bf = beamformHexArray(cleanMics, FRONTEND_SAMPLE_RATE);
    assert.equal(bf.usedChannels, 6);
    const errDeg = circularAzimuthDiffDeg(bf.azimuthDeg, targetAz);
    assert.ok(errDeg <= 15, `Expected DOA within 15deg of ${targetAz}deg, got ${bf.azimuthDeg}deg (err=${errDeg}deg)`);

    const bf3650Amp = goertzelAmplitude(bf.samples.subarray(steadyStart, steadyEnd), 3650, FRONTEND_SAMPLE_RATE);
    const ratio = bf3650Amp / Math.max(1e-6, singleMic3650Amp);
    assert.ok(
      ratio >= 0.85,
      `Expected >=0.85 preservation at 3.65kHz for az=${targetAz}deg, got ${ratio.toFixed(3)} (blind ratio=${(blind3650Amp / singleMic3650Amp).toFixed(3)})`,
    );

    // Check broadband uncorrelated noise suppression (> 3 dB over single noisy mic)
    const noiseFreqs = [4900, 5100, 5300, 5500, 5700, 5900, 6100, 6300, 6500, 6700, 6900, 7100];
    let singleNoisePwr = 0;
    let bfNoisePwr = 0;
    for (const freq of noiseFreqs) {
      const sa = goertzelAmplitude(cleanMics[0]!.subarray(steadyStart, steadyEnd), freq, FRONTEND_SAMPLE_RATE);
      const ba = goertzelAmplitude(bf.samples.subarray(steadyStart, steadyEnd), freq, FRONTEND_SAMPLE_RATE);
      singleNoisePwr += sa * sa;
      bfNoisePwr += ba * ba;
    }
    const snrGainDb = 10 * Math.log10(Math.max(1e-12, singleNoisePwr) / Math.max(1e-12, bfNoisePwr));
    assert.ok(snrGainDb > 3, `Expected >3 dB uncorrelated noise suppression, got ${snrGainDb.toFixed(2)} dB`);
  }

  // Dead channel resilience: mute mic 2
  const withDeadMic = synthHexPlaneWave({
    durationSec: 0.6,
    azimuthDeg: 60,
    signalAtTime: signalFn,
    noiseAmp: 0.02,
  });
  withDeadMic[2]!.fill(0);
  const deadRes = beamformHexArray(withDeadMic, FRONTEND_SAMPLE_RATE);
  assert.equal(deadRes.usedChannels, 5);
  assert.ok(circularAzimuthDiffDeg(deadRes.azimuthDeg, 60) <= 15);
});

test('audio-frontend: OnlineHexBeamformer tracks speech azimuth across 640-sample frames, suppresses directional noise, and survives dead mics', () => {
  const beamformer = new OnlineHexBeamformer(FRONTEND_SAMPLE_RATE);
  const frameLen = 640;

  // Phase 1: 0.48s (12 x 40ms frames) stationary directional noise from 210deg to adapt per-beam noise floors
  const noiseOnly = synthHexPlaneWave({
    durationSec: 0.48,
    azimuthDeg: 210,
    signalAtTime: t => 0.05 * Math.sin(2 * Math.PI * 1950 * t) + 0.04 * Math.cos(2 * Math.PI * 2650 * t),
    noiseAmp: 0.015,
    seed: 101,
  });
  for (let off = 0; off + frameLen <= noiseOnly[0]!.length; off += frameLen) {
    const out = beamformer.process(noiseOnly.map(m => m.subarray(off, off + frameLen)));
    assert.equal(out.samples.length, frameLen);
  }

  // Phase 2: 0.48s directional speech at 0deg with strong 3.65kHz mixed with the 210deg noise
  const speech0Only = synthHexPlaneWave({
    durationSec: 0.48,
    azimuthDeg: 0,
    signalAtTime: t => 0.14 * Math.sin(2 * Math.PI * 520 * t) + 0.18 * Math.sin(2 * Math.PI * 3650 * t),
  });
  const mixMics = speech0Only.map((m, idx) => {
    const combined = new Float32Array(m.length);
    for (let i = 0; i < m.length; i++) {
      combined[i] = m[i]! + noiseOnly[idx]![i]!;
    }
    return combined;
  });

  const outSpeech0 = new Float32Array(mixMics[0]!.length);
  let lastAz0 = -1;
  for (let off = 0; off + frameLen <= mixMics[0]!.length; off += frameLen) {
    const res = beamformer.process(mixMics.map(m => m.subarray(off, off + frameLen)));
    outSpeech0.set(res.samples, off);
    lastAz0 = res.azimuthDeg;
  }
  assert.equal(lastAz0, 0, `Expected OnlineHexBeamformer to lock onto 0deg speech, got ${lastAz0}deg`);

  const steady = outSpeech0.subarray(frameLen * 2);
  const pureRef3650 = goertzelAmplitude(speech0Only[0]!.subarray(frameLen * 2), 3650, FRONTEND_SAMPLE_RATE);
  const beam3650 = goertzelAmplitude(steady, 3650, FRONTEND_SAMPLE_RATE);
  assert.ok(beam3650 / Math.max(1e-6, pureRef3650) >= 0.85, `Expected 3.65kHz preserved >=0.85, got ${(beam3650 / pureRef3650).toFixed(3)}`);

  const ch0Steady = mixMics[0]!.subarray(frameLen * 2);
  const ch0Noise1950 = goertzelAmplitude(ch0Steady, 1950, FRONTEND_SAMPLE_RATE);
  const beamNoise1950 = goertzelAmplitude(steady, 1950, FRONTEND_SAMPLE_RATE);
  const snrCh0 = pureRef3650 / Math.max(1e-6, ch0Noise1950);
  const snrBeam = beam3650 / Math.max(1e-6, beamNoise1950);
  assert.ok(snrBeam > snrCh0 * 1.4, `Expected beamformer SNR > 1.4x ch0 (beam=${snrBeam.toFixed(2)}, ch0=${snrCh0.toFixed(2)})`);

  // Phase 3: 0.4s quiet gap followed by 0.4s speech from 120deg with dead ch2 (smooth crossfade, no NaN)
  const quietGap = synthHexPlaneWave({
    durationSec: 0.40,
    azimuthDeg: 210,
    signalAtTime: t => 0.02 * Math.sin(2 * Math.PI * 1950 * t),
    noiseAmp: 0.005,
    seed: 202,
  });
  for (let off = 0; off + frameLen <= quietGap[0]!.length; off += frameLen) {
    beamformer.process(quietGap.map(m => m.subarray(off, off + frameLen)));
  }
  const speech120 = synthHexPlaneWave({
    durationSec: 0.40,
    azimuthDeg: 120,
    signalAtTime: t => 0.16 * Math.sin(2 * Math.PI * 620 * t) + 0.16 * Math.sin(2 * Math.PI * 3650 * t),
  });
  speech120[2]!.fill(0); // dead channel must be excluded gracefully
  let lastAz120 = -1;
  for (let off = 0; off + frameLen <= speech120[0]!.length; off += frameLen) {
    const res = beamformer.process(speech120.map(m => m.subarray(off, off + frameLen)));
    lastAz120 = res.azimuthDeg;
    for (let i = 0; i < res.samples.length; i++) {
      assert.ok(Number.isFinite(res.samples[i]!), 'Beamformer output sample must be finite');
    }
  }
  assert.equal(lastAz120, 120, `Expected OnlineHexBeamformer to switch cleanly to 120deg, got ${lastAz120}deg`);
});

test('asr-engine: transcribeWithGemini, collectVoiceHotwords, and createHybridAsrRecognizer work with local fallback and key redaction', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-asr-engine-'));
  const secretKey = 'AIzaSyTestSecretKey_DoNotLeak999';
  const prevEnvHotwords = process.env.FRIDAY_ASR_HOTWORDS;
  const prevAsrProvider = process.env.FRIDAY_ASR_PROVIDER;
  try {
    // 1. Hotword collection priority, SQLite, JSON stores, dedup, and <=1000 cap
    await mkdir(join(home, 'xiaoai-kws'), { recursive: true });
    await mkdir(join(home, 'plugins', 'health-scale'), { recursive: true });
    await mkdir(join(home, 'plugins', 'miot'), { recursive: true });
    await mkdir(join(home, 'plugins', 'ninebot'), { recursive: true });
    await mkdir(join(home, 'plugins', 'netlea'), { recursive: true });
    await mkdir(join(home, 'plugins', 'music'), { recursive: true });

    await writeFile(join(home, 'xiaoai-kws', 'hotwords.txt'), '# custom comment\n定制设备A\n小九\n');
    process.env.FRIDAY_ASR_HOTWORDS = '客厅投影, 小九';
    await writeFile(
      join(home, 'xiaoai-kws', 'speakers.json'),
      JSON.stringify({ profiles: [{ name: '主人' }, { name: '小宝' }] }),
    );
    const db = new DatabaseSync(join(home, 'plugins', 'health-scale', 'health.db'));
    db.exec('CREATE TABLE profiles (name TEXT);');
    db.prepare('INSERT INTO profiles (name) VALUES (?)').run('郭蛋蛋');
    db.prepare('INSERT INTO profiles (name) VALUES (?)').run('小宝'); // duplicate
    db.close();

    await writeFile(
      join(home, 'plugins', 'miot', 'hub-cache.json'),
      JSON.stringify({
        devices: [
          { name: '主卧加湿器', room: '主卧' },
          { name: 'lumi_sensor_998877', room_name: '阳台' }, // opaque technical ID should be skipped
        ],
      }),
    );
    await writeFile(
      join(home, 'plugins', 'ninebot', 'config.json'),
      JSON.stringify({ deviceName: '小九一号' }),
    );
    await writeFile(
      join(home, 'plugins', 'netlea', 'config.json'),
      JSON.stringify({ savedCustomPresets: [{ name: '水草造景模式' }] }),
    );
    await writeFile(
      join(home, 'plugins', 'music', 'library.json'),
      JSON.stringify({ tracks: [{ artist: '周杰伦 / 梁静茹' }, { artist: '陈奕迅' }, { artist: '乱码\uFFFD歌手' }, { artist: 'ctrl\u0007term' }] }),
    );

    const hotwords = collectVoiceHotwords(home, { forceRefresh: true, maxTerms: 120 });
    assert.ok(hotwords.length > 10 && hotwords.length <= 120);
    assert.equal(hotwords[0], '定制设备A');
    assert.equal(hotwords[1], '小九');
    assert.ok(hotwords.indexOf('小九') < hotwords.indexOf('郭蛋蛋'));
    assert.ok(hotwords.indexOf('郭蛋蛋') < hotwords.indexOf('主卧加湿器'));
    assert.ok(hotwords.indexOf('主卧加湿器') < hotwords.indexOf('小九一号'));
    assert.ok(hotwords.indexOf('小九一号') < hotwords.indexOf('水草造景模式'));
    assert.ok(hotwords.includes('周杰伦') && hotwords.includes('梁静茹') && hotwords.includes('陈奕迅'));
    assert.ok(!hotwords.includes('lumi_sensor_998877'));
    assert.ok(!hotwords.some(w => /[\uFFFD\u0000-\u001F]/.test(w)), 'Replacement/control characters must be filtered');
    assert.equal(hotwords.filter(w => w === '小宝').length, 1);

    // 2. transcribeWithGemini request format and response variants
    const requests: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];
    let mockMode: 'steps' | 'output_text' | 'outputs' | 'error' = 'steps';
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url, apiKey: headers.get('x-goog-api-key'), body: parsedBody });
      if (mockMode === 'error') {
        return new Response(`upstream rejected key ${secretKey}`, { status: 500 });
      }
      if (mockMode === 'steps') {
        return new Response(JSON.stringify({
          steps: [{ type: 'model_output', content: [{ type: 'text', text: '<|zh|>打开尼特利鱼缸灯' }] }],
          usage: { total_input_tokens: 120, total_output_tokens: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (mockMode === 'output_text') {
        return new Response(JSON.stringify({ output_text: '查看郭蛋蛋体重' }), { status: 200 });
      }
      return new Response(JSON.stringify({ outputs: [{ type: 'text', text: '关闭客厅灯' }] }), { status: 200 });
    };

    const clip = new Float32Array(4000).fill(0.05);
    const res1 = await transcribeWithGemini({
      samples: clip,
      sampleRate: FRONTEND_SAMPLE_RATE,
      apiKey: secretKey,
      hotwords,
      fetchImpl: mockFetch,
    });
    assert.equal(res1.text, '打开尼特利鱼缸灯');
    assert.equal(res1.inputTokens, 120);
    assert.equal(res1.outputTokens, 8);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(requests[0]!.apiKey, secretKey);

    const body0 = requests[0]!.body as {
      model: string;
      input: Array<{ type: string; mime_type: string; data: string }>;
      generation_config: { transcription_config: { mode: string; language_codes: string[]; custom_vocabulary: string[] } };
    };
    assert.equal(body0.model, 'gemini-3.5-transcribe');
    assert.equal(body0.generation_config.transcription_config.mode, 'verbatim');
    assert.deepEqual(body0.generation_config.transcription_config.language_codes, ['cmn-Hans-CN']);
    assert.ok(body0.generation_config.transcription_config.custom_vocabulary.includes('郭蛋蛋'));
    const decodedWav = Buffer.from(body0.input[0]!.data, 'base64');
    assert.equal(decodedWav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(decodedWav.subarray(8, 12).toString('ascii'), 'WAVE');

    mockMode = 'output_text';
    const res2 = await transcribeWithGemini({ samples: clip, sampleRate: FRONTEND_SAMPLE_RATE, apiKey: secretKey, fetchImpl: mockFetch });
    assert.equal(res2.text, '查看郭蛋蛋体重');

    mockMode = 'outputs';
    const res3 = await transcribeWithGemini({ samples: clip, sampleRate: FRONTEND_SAMPLE_RATE, apiKey: secretKey, fetchImpl: mockFetch });
    assert.equal(res3.text, '关闭客厅灯');

    // 3. createHybridAsrRecognizer routing + key-redacted fallback
    delete process.env.FRIDAY_ASR_PROVIDER;
    const localCalls: Array<{ len: number }> = [];
    let freed = false;
    const warnedMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnedMessages.push(args.map(String).join(' '));
      origWarn(...args);
    };

    try {
      const hybrid = createHybridAsrRecognizer({
        homeDir: home,
        resolveGoogleCredentials: async () => ({ apiKey: secretKey }),
        fetchImpl: mockFetch,
        localRecognizerFactory: async () => ({
          transcribe: async (samples) => {
            localCalls.push({ len: samples.length });
            return '<|zh|>本地兜底识别';
          },
          free: () => { freed = true; },
        }),
      });

      const cloudCountBefore = requests.length;
      assert.equal(await hybrid.transcribe(clip, FRONTEND_SAMPLE_RATE, { localOnly: true }), '本地兜底识别');
      assert.equal(await hybrid.transcribe(clip, FRONTEND_SAMPLE_RATE, { preferFastLocal: true }), '本地兜底识别');
      assert.equal(requests.length, cloudCountBefore, 'localOnly & preferFastLocal must skip cloud');

      mockMode = 'steps';
      assert.equal(await hybrid.transcribe(clip, FRONTEND_SAMPLE_RATE), '打开尼特利鱼缸灯');

      mockMode = 'error';
      assert.equal(await hybrid.transcribe(clip, FRONTEND_SAMPLE_RATE), '本地兜底识别');
      assert.ok(warnedMessages.some(w => w.includes('falling back to local ASR')));
      assert.ok(!warnedMessages.some(w => w.includes(secretKey)), 'API key must never appear in logs');

      hybrid.free?.();
      assert.equal(freed, true);
    } finally {
      console.warn = origWarn;
    }
  } finally {
    if (prevEnvHotwords === undefined) delete process.env.FRIDAY_ASR_HOTWORDS;
    else process.env.FRIDAY_ASR_HOTWORDS = prevEnvHotwords;
    if (prevAsrProvider === undefined) delete process.env.FRIDAY_ASR_PROVIDER;
    else process.env.FRIDAY_ASR_PROVIDER = prevAsrProvider;
    await rm(home, { recursive: true, force: true });
  }
});

test('wechat/media-enrich: enrichWechatVoice uses Gemini cloud ASR with fallback to ilink_text without leaking API keys', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-wechat-asr-'));
  const prevAsrProvider = process.env.FRIDAY_ASR_PROVIDER;
  const secretKey = 'AIzaSyWechatSecret_999';
  try {
    delete process.env.FRIDAY_ASR_PROVIDER;
    const inboundDir = join(home, 'inbound');
    await mkdir(inboundDir, { recursive: true });
    const silkPath = join(inboundDir, 'voice.silk');
    await writeFile(silkPath, Buffer.from('SILK_DUMMY'));

    const pcmBytes = Buffer.alloc(24_000 * 2); // 1s at 24kHz
    const decodeSilk = async () => ({ data: pcmBytes, duration: 1000 });

    // Cloud success -> cloud_asr
    const cloudSuccessRes = await enrichWechatVoice({
      silkPath,
      inboundDir,
      homeDir: home,
      resolveGoogleCredentials: async () => ({ apiKey: secretKey }),
      fetchImpl: async () => new Response(JSON.stringify({ output_text: '帮我查一下体脂秤记录' }), { status: 200 }),
      deps: { decodeSilk },
    });
    assert.equal(cloudSuccessRes.transcoded, true);
    assert.equal(cloudSuccessRes.transcriptSource, 'cloud_asr');
    assert.equal(cloudSuccessRes.transcript, '帮我查一下体脂秤记录');

    // Cloud HTTP error containing secretKey + ilinkText fallback -> redacts secret and falls back cleanly
    const origWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
      origWarn(...args);
    };
    try {
      const fallbackRes = await enrichWechatVoice({
        silkPath,
        inboundDir,
        homeDir: home,
        ilinkText: '微信原自带转写',
        resolveGoogleCredentials: async () => ({ apiKey: secretKey }),
        fetchImpl: async () => new Response(`bad key ${secretKey}`, { status: 503 }),
        deps: { decodeSilk },
      });
      assert.equal(fallbackRes.transcriptSource, 'ilink_text');
      assert.equal(fallbackRes.transcript, '微信原自带转写');
      assert.ok(!(fallbackRes.transcriptError ?? '').includes(secretKey));
      assert.ok(!warns.some(w => w.includes(secretKey)));
    } finally {
      console.warn = origWarn;
    }
  } finally {
    if (prevAsrProvider === undefined) delete process.env.FRIDAY_ASR_PROVIDER;
    else process.env.FRIDAY_ASR_PROVIDER = prevAsrProvider;
    await rm(home, { recursive: true, force: true });
  }
});

test('speaker-verify regression: preserves owner utterance with quiet tail while trimming loud TV crosstalk tail', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-spk-quiet-tail-'));
  try {
    const factory = (): XiaoaiSpeakerExtractor => ({
      dim: 2,
      extract: (slice) => {
        const rms = computeRms(slice);
        // Simulate: TV crosstalk at high RMS (>0.115) looks completely non-owner; owner (<=0.11) matches well,
        // and low-RMS quiet tail (<0.025) loses formant energy in naive windows (score=0.36)
        if (rms > 0.115) return new Float32Array([0.1, Math.sqrt(0.99)]);
        if (rms < 0.025) return new Float32Array([0.36, Math.sqrt(1 - 0.36 * 0.36)]);
        return new Float32Array([1, 0]);
      },
      free() {},
    });

    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory: factory });
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [new Float32Array([1, 0])] });
    manager.configure({ threshold: 0.45 });

    // 1. 3.2s owner utterance (2.0s clear amp=0.10 + 1.2s quiet fading tail amp=0.015) -> must NOT be trimmed
    const ownerQuietTail = new Float32Array(Math.round(SPEAKER_SAMPLE_RATE * 3.2));
    for (let i = 0; i < Math.round(SPEAKER_SAMPLE_RATE * 2.0); i++) {
      ownerQuietTail[i] = 0.10 * Math.sin((2 * Math.PI * 220 * i) / SPEAKER_SAMPLE_RATE);
    }
    for (let i = Math.round(SPEAKER_SAMPLE_RATE * 2.0); i < ownerQuietTail.length; i++) {
      ownerQuietTail[i] = 0.015 * Math.sin((2 * Math.PI * 220 * i) / SPEAKER_SAMPLE_RATE);
    }
    const quietRes = manager.verifyAndTrimUtterance(ownerQuietTail, SPEAKER_SAMPLE_RATE);
    const asyncQuietRes = await manager.verifyAndTrimUtteranceAsync(ownerQuietTail, SPEAKER_SAMPLE_RATE);
    assert.equal(quietRes.matched, true);
    assert.equal(quietRes.trimmed, false);
    assert.equal(quietRes.samples.length, ownerQuietTail.length);
    assert.equal(asyncQuietRes.trimmed, false);

    // 2. 2.0s owner (amp=0.10) + 3.0s loud TV (amp=0.20 -> RMS ~0.141 > 0.115) -> still trimmed properly
    const ownerPlusTv = new Float32Array(SPEAKER_SAMPLE_RATE * 5);
    for (let i = 0; i < SPEAKER_SAMPLE_RATE * 2; i++) {
      ownerPlusTv[i] = 0.10 * Math.sin((2 * Math.PI * 220 * i) / SPEAKER_SAMPLE_RATE);
    }
    for (let i = SPEAKER_SAMPLE_RATE * 2; i < ownerPlusTv.length; i++) {
      ownerPlusTv[i] = 0.20 * Math.sin((2 * Math.PI * 3200 * i) / SPEAKER_SAMPLE_RATE);
    }
    const tvRes = manager.verifyAndTrimUtterance(ownerPlusTv, SPEAKER_SAMPLE_RATE);
    assert.equal(tvRes.matched, true);
    assert.equal(tvRes.trimmed, true);
    assert.ok(tvRes.samples.length <= Math.round(SPEAKER_SAMPLE_RATE * 2.9));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor: 8ch FRPCM8S2 stream runs AEC + beamformer + GTCRN denoiser for ASR while keeping un-denoised audio for enrollment', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-kws-8ch-e2e-'));
  let monitor: XiaoaiKwsMonitor | undefined;
  try {
    let audioStream: PassThrough | undefined;
    let wakeAtSample = -1;
    let processedSamples = 0;
    let wakeFired = false;

    const spotterFactory = (): XiaoaiKwsSpotter => ({
      createStream: () => ({}),
      acceptWaveform: (_s, samples) => {
        processedSamples += samples.length;
        if (!wakeFired && wakeAtSample >= 0 && processedSamples >= wakeAtSample) {
          wakeFired = true;
        }
      },
      isReady: () => wakeFired,
      decode: () => {},
      getResult: () => {
        if (!wakeFired) return '';
        wakeFired = false;
        return '你好星期五';
      },
      reset: () => { wakeFired = false; },
    });

    const vadFactory = (): XiaoaiSpeechDetector => ({
      isSpeech: (samples) => computeRms(samples) >= 0.008,
      reset: () => {},
    });

    let denoiserCalls = 0;
    let denoiserFreed = false;
    const denoiserFactory = () => ({
      denoise: (samples: Float32Array) => {
        denoiserCalls++;
        // Scale by 0.5 as a distinctive denoiser fingerprint so we can verify ASR gets denoised audio while onUtterance keeps un-denoised beamformed audio
        const out = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * 0.5;
        return out;
      },
      free: () => { denoiserFreed = true; },
    });

    let asrInputRms = 0;
    let asrInput3650Amp = 0;
    const recognizerFactory = async (): Promise<XiaoaiAsrRecognizer> => ({
      transcribe: async (samples) => {
        asrInputRms = computeRms(samples);
        asrInput3650Amp = goertzelAmplitude(samples, 3650, FRONTEND_SAMPLE_RATE);
        return '打开尼特利鱼缸灯';
      },
    });

    const wakeEvents: Array<{ keyword: string; chime?: boolean }> = [];
    const utterances: Array<{ text: string; samples?: Float32Array }> = [];

    monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      modelsDir: join(home, 'kws'),
      asrModelsDir: join(home, 'asr'),
      vadModelPath: join(home, 'vad.onnx'),
      // Omit probeDurationMs to exercise the new 220ms default + 35ms skip
      cooldownMs: 200,
      endSilenceMs: 250,
      asrWakeRescue: false,
      idleEnergyGate: false,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      spotterFactory,
      vadFactory,
      denoiserFactory,
      recognizerFactory,
      streamFactory: () => {
        audioStream = new PassThrough();
        return {
          stdout: audioStream,
          sampleFormat: 's16le',
          channels: 8,
          kill: () => audioStream?.end(),
          onClose: () => {},
        };
      },
      speakerGate: {
        isActive: () => true,
        isBypassed: () => true, // simulates active voiceprint enrollment so onUtterance.samples is forwarded
        verifyWake: () => ({ matched: true, score: 1, threshold: 0.3 }),
        verifyUtterance: () => ({ matched: true, score: 1, threshold: 0.3 }),
      },
      onWake: async (event) => {
        wakeEvents.push({ keyword: event.keyword, chime: event.chime });
        return { woken: true, suppressed: false };
      },
      onUtterance: async (event) => {
        utterances.push({ text: event.text, samples: event.samples });
      },
    });

    const channel: ImChannelConfig = {
      id: 'xiaoai-test',
      platform: 'xiaoai',
      name: 'XiaoAI Test',
      enabled: true,
      notifyAll: false,
      apiBase: 'ssh://lx06=root@127.0.0.1?kws=1&chime=1',
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    // Send 8-byte header in two chunks to test split header buffering
    const hdr = Buffer.from(AUDIO_STREAM_MAGIC_8CH_S16, 'latin1');
    audioStream!.write(hdr.subarray(0, 4));
    audioStream!.write(hdr.subarray(4));

    const write8Ch = async (mics: Float32Array[], ref: Float32Array) => {
      const combined = [...mics, ref, ref];
      const buf = encodeInterleavedInt16Frames(combined);
      for (let off = 0; off < buf.length; off += 1280) {
        audioStream!.write(buf.subarray(off, Math.min(buf.length, off + 1280)));
        await delay(2);
      }
    };

    // 1. Pre-wake echo calibration (0.6s speaker echo on ch6/ch7 + delayed echo on all 6 mics)
    const sr = FRONTEND_SAMPLE_RATE;
    const preLen = Math.round(sr * 0.6);
    const echoRefPre = new Float32Array(preLen);
    for (let i = 0; i < preLen; i++) {
      echoRefPre[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr) + 0.15 * Math.cos((2 * Math.PI * 980 * i) / sr);
    }
    const preMics = Array.from({ length: 6 }, () => {
      const m = new Float32Array(preLen);
      for (let i = 32; i < preLen; i++) m[i] = 0.40 * echoRefPre[i - 32]!;
      return m;
    });
    await write8Ch(preMics, echoRefPre);

    // 2. Wake keyword segment (0.3s) + trigger at its end
    wakeAtSample = preLen + Math.round(sr * 0.3);
    const wakeSeg = synthHexPlaneWave({
      durationSec: 0.3,
      azimuthDeg: 60,
      signalAtTime: t => 0.10 * Math.sin(2 * Math.PI * 500 * t),
    });
    await write8Ch(wakeSeg, new Float32Array(wakeSeg[0]!.length));

    // 3. Probe window (220ms): 20ms silence (<35ms skip) + 200ms continuous one-breath speech at 60deg with strong 3.65kHz + speaker echo!
    const probeLen = Math.round(sr * 0.22);
    const silenceSamples = Math.round(sr * 0.02);
    const speechPlusCmdTotal = Math.round(sr * 0.90); // 200ms in probe + 700ms continuation
    const cmdMicsFull = synthHexPlaneWave({
      durationSec: speechPlusCmdTotal / sr,
      azimuthDeg: 60,
      signalAtTime: t => 0.14 * Math.sin(2 * Math.PI * 650 * t) + 0.18 * Math.sin(2 * Math.PI * 3650 * t),
    });
    const echoCmd = new Float32Array(speechPlusCmdTotal);
    for (let i = 0; i < speechPlusCmdTotal; i++) {
      echoCmd[i] = 0.20 * Math.sin((2 * Math.PI * 330 * i) / sr);
      for (let m = 0; m < 6; m++) {
        if (i >= 32) cmdMicsFull[m]![i] = cmdMicsFull[m]![i]! + 0.40 * echoCmd[i - 32]!;
      }
    }

    const silence6 = Array.from({ length: 6 }, () => new Float32Array(silenceSamples));
    await write8Ch(silence6, new Float32Array(silenceSamples));

    const firstProbePart = probeLen - silenceSamples;
    await write8Ch(cmdMicsFull.map(m => m.subarray(0, firstProbePart)), echoCmd.subarray(0, firstProbePart));
    await write8Ch(cmdMicsFull.map(m => m.subarray(firstProbePart)), echoCmd.subarray(firstProbePart));

    // 4. Trailing silence (350ms) to trigger endpointing
    const trailLen = Math.round(sr * 0.35);
    await write8Ch(Array.from({ length: 6 }, () => new Float32Array(trailLen)), new Float32Array(trailLen));

    await until(() => utterances.length === 1);
    assert.equal(wakeEvents.length, 1);
    assert.equal(wakeEvents[0]!.chime, false, '220ms probe with 20ms initial pause + speech must classify as one-breath');
    assert.equal(utterances[0]!.text, '打开尼特利鱼缸灯');
    assert.equal(denoiserCalls, 1);

    const enrollSamples = utterances[0]!.samples;
    assert.ok(enrollSamples && enrollSamples.length > sr * 0.7);
    const enrollRms = computeRms(enrollSamples!);
    // Verify denoiser (0.5x gain) ran ONLY before ASR, NOT on enrollment samples!
    assert.ok(
      Math.abs(asrInputRms / enrollRms - 0.5) < 0.05,
      `Expected ASR samples denoised (ratio ~0.5), got ${(asrInputRms / enrollRms).toFixed(3)}`,
    );
    // Verify 3.65kHz signal preserved after beamforming + AEC (ASR got 0.5x * >=0.15)
    assert.ok(asrInput3650Amp > 0.05, `Expected strong 3.65kHz preserved after 6-mic beamforming, got ${asrInput3650Amp}`);

    monitor.close();
    monitor = undefined;
    assert.equal(denoiserFreed, true);
  } finally {
    monitor?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('asr-engine: createGeminiLiveTranscribeSession streams AGC audio, buffers pre-setup chunks, supports interim fallback, and redacts API keys', async () => {
  const secretKey = 'AIzaSyLiveSecretKey_NeverExpose888';
  assert.equal(
    resolveGeminiLiveTranscribeWsUrl('https://generativelanguage.googleapis.com', secretKey),
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(secretKey)}`,
  );
  assert.equal(
    resolveGeminiLiveTranscribeWsUrl('http://127.0.0.1:8080/v1beta', 'abc'),
    'ws://127.0.0.1:8080/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=abc',
  );

  class MockLiveWebSocket implements LiveAsrWebSocketLike {
    readyState = 0; // CONNECTING
    readonly sent: Record<string, unknown>[] = [];
    closed = false;
    private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();

    constructor(readonly url: string) {}

    addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (ev: unknown) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    send(data: string): void {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.emit('close', { code: 1000, reason: '' });
    }

    emit(type: string, ev: unknown): void {
      for (const fn of this.listeners.get(type) ?? []) {
        fn(ev);
      }
    }

    emitJson(payload: unknown): void {
      this.emit('message', { data: JSON.stringify(payload) });
    }
  }

  // 1. Happy path: pre-setup buffering + AGC + audioStreamEnd + final transcription
  let activeWs: MockLiveWebSocket | undefined;
  const session = createGeminiLiveTranscribeSession({
    apiKey: secretKey,
    hotwords: ['尼特利', '星期五'],
    webSocketFactory: (url) => {
      activeWs = new MockLiveWebSocket(url);
      return activeWs;
    },
  });
  assert.equal(session.isUsable(), true);
  assert.ok(activeWs);

  const quietFrame = new Float32Array(1600);
  for (let i = 0; i < quietFrame.length; i++) {
    quietFrame[i] = 0.005 * Math.sin((2 * Math.PI * 440 * i) / FRONTEND_SAMPLE_RATE);
  }
  session.pushSamples(quietFrame);
  session.pushSamples(quietFrame);
  assert.equal(activeWs!.sent.length, 0, 'Pre-handshake audio must buffer locally before WebSocket open/setupComplete');

  activeWs!.readyState = 1;
  activeWs!.emit('open', {});
  assert.equal(activeWs!.sent.length, 1);
  const setupMsg = activeWs!.sent[0] as {
    setup: {
      model: string;
      generationConfig: { responseModalities: string[] };
      inputAudioTranscription: { languageCodes: string[]; customVocabulary: string[] };
    };
  };
  assert.equal(setupMsg.setup.model, 'models/gemini-3.5-transcribe-live');
  assert.deepEqual(setupMsg.setup.generationConfig.responseModalities, ['TEXT']);
  assert.deepEqual(setupMsg.setup.inputAudioTranscription.languageCodes, ['cmn-Hans-CN']);
  assert.deepEqual(setupMsg.setup.inputAudioTranscription.customVocabulary, ['尼特利', '星期五']);

  activeWs!.emitJson({ setupComplete: {} });
  await delay(10);
  assert.equal(activeWs!.sent.length, 3, 'Queued 2 x 100ms chunks must flush immediately on setupComplete');

  const audioMsg1 = activeWs!.sent[1] as { realtimeInput: { audio: { data: string; mimeType: string } } };
  assert.equal(audioMsg1.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  const pcm1 = Buffer.from(audioMsg1.realtimeInput.audio.data, 'base64');
  let maxNorm = 0;
  for (let i = 0; i < pcm1.length; i += 2) {
    maxNorm = Math.max(maxNorm, Math.abs(pcm1.readInt16LE(i) / 32768));
  }
  assert.ok(maxNorm >= 0.25 && maxNorm <= 0.96, `Expected AGC to boost 0.005 input to [0.25, 0.96], got ${maxNorm.toFixed(3)}`);

  // Push partial 50ms tail then finish() -> tail flushed + audioStreamEnd sent
  session.pushSamples(quietFrame.subarray(0, 800));
  const finishPromise = session.finish({ timeoutMs: 800 });
  await delay(10);
  const tailMsg = activeWs!.sent[3] as { realtimeInput?: { audio?: { data: string } } };
  assert.equal(Buffer.from(tailMsg.realtimeInput!.audio!.data, 'base64').length, 1600);
  assert.deepEqual(activeWs!.sent[4], { realtimeInput: { audioStreamEnd: true } });

  activeWs!.emitJson({ serverContent: { interimInputTranscription: { text: '打开客厅' } } });
  activeWs!.emitJson({ serverContent: { inputTranscription: { text: '<|zh|>打开客厅灯。' } } });
  activeWs!.emitJson({ serverContent: { generationComplete: true } });
  const res1 = await finishPromise;
  assert.equal(res1?.text, '打开客厅灯。');
  assert.equal(res1?.interimFallback, undefined);
  assert.equal(activeWs!.readyState, 3);

  // 2. Interim fallback when generationComplete arrives without final inputTranscription
  let wsInterim: MockLiveWebSocket | undefined;
  const session2 = createGeminiLiveTranscribeSession({
    apiKey: secretKey,
    webSocketFactory: (url) => {
      wsInterim = new MockLiveWebSocket(url);
      wsInterim.readyState = 1;
      return wsInterim;
    },
  });
  wsInterim!.emit('open', {});
  wsInterim!.emitJson({ setupComplete: {} });
  await delay(5);
  session2.pushSamples(quietFrame);
  const p2 = session2.finish({ timeoutMs: 800 });
  await delay(5);
  wsInterim!.emitJson({ serverContent: { interimInputTranscription: { text: '查询天气' }, generationComplete: true } });
  const res2 = await p2;
  assert.equal(res2?.text, '查询天气');
  assert.equal(res2?.interimFallback, true);

  // 3. Error redaction: API key inside WS error text must never leak into logs
  const loggedErrors: string[] = [];
  let wsErr: MockLiveWebSocket | undefined;
  const session3 = createGeminiLiveTranscribeSession({
    apiKey: secretKey,
    onLogError: msg => loggedErrors.push(msg),
    webSocketFactory: (url) => {
      wsErr = new MockLiveWebSocket(url);
      return wsErr;
    },
  });
  wsErr!.emit('error', { message: `connect wss://example.com/?key=${secretKey} failed` });
  const res3 = await session3.finish({ timeoutMs: 300 });
  assert.equal(res3, undefined);
  assert.equal(session3.isUsable(), false);
  assert.ok(loggedErrors.length >= 1);
  assert.ok(!loggedErrors.some(e => e.includes(secretKey)), 'API key must be redacted from Live ASR logs');

  // 4. Ultra-quiet -56 dBFS (0.0015) speech AGC boost & immunity to premature empty turnComplete
  let wsQuiet: MockLiveWebSocket | undefined;
  const session4 = createGeminiLiveTranscribeSession({
    apiKey: secretKey,
    webSocketFactory: (url) => {
      wsQuiet = new MockLiveWebSocket(url);
      wsQuiet.readyState = 1;
      return wsQuiet;
    },
  });
  wsQuiet!.emit('open', {});
  wsQuiet!.emitJson({ setupComplete: {} });
  await delay(5);

  const ultraQuiet = new Float32Array(1600);
  for (let i = 0; i < ultraQuiet.length; i++) {
    ultraQuiet[i] = 0.0015 * Math.sin((2 * Math.PI * 520 * i) / FRONTEND_SAMPLE_RATE);
  }
  session4.pushSamples(ultraQuiet);
  assert.equal(wsQuiet!.sent.length, 2);
  const quietAudioMsg = wsQuiet!.sent[1] as { realtimeInput: { audio: { data: string } } };
  const quietPcm = Buffer.from(quietAudioMsg.realtimeInput.audio.data, 'base64');
  let quietPeak = 0;
  for (let i = 0; i < quietPcm.length; i += 2) {
    quietPeak = Math.max(quietPeak, Math.abs(quietPcm.readInt16LE(i) / 32768));
  }
  assert.ok(
    quietPeak >= 0.22 && quietPeak <= 0.96,
    `Expected ultra-quiet 0.0015 speech boosted into [0.22, 0.96], got ${quietPeak.toFixed(3)}`,
  );

  // Premature empty turnComplete during mid-speech pause must NOT truncate finish() before audioStreamEnd
  wsQuiet!.emitJson({ serverContent: { turnComplete: true } });
  await delay(5);
  const p4 = session4.finish({ timeoutMs: 600 });
  await delay(60);
  wsQuiet!.emitJson({ serverContent: { inputTranscription: { text: '打开鱼缸灯。' }, generationComplete: true } });
  const res4 = await p4;
  assert.equal(res4?.text, '打开鱼缸灯。');
});

test('XiaoaiKwsMonitor: Live ASR runs in parallel with speaker verification and falls back to batch when trimmed', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-kws-live-asr-'));
  let monitor: XiaoaiKwsMonitor | undefined;
  try {
    let audioStream: PassThrough | undefined;
    let wakeAtSample = -1;
    let processedSamples = 0;
    let wakeFired = false;
    let liveEnabledResult = '查询明天天气。';
    let trimmedByGate = false;
    let batchCalls = 0;
    const liveStats: Array<{ pushed: number; finished: boolean; aborted: boolean }> = [];

    const channel: ImChannelConfig = {
      id: 'xiaoai-live-test',
      platform: 'xiaoai',
      name: 'Live ASR Monitor Test',
      enabled: true,
      notifyAll: false,
      apiBase: 'ssh://lx06=root@127.0.0.1?kws=1&chime=0',
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const emitted: string[] = [];
    monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      modelsDir: join(home, 'kws'),
      cooldownMs: 30,
      probeDurationMs: 40,
      endSilenceMs: 120,
      speechRmsThreshold: 0.01,
      asrWakeRescue: false,
      idleEnergyGate: false,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      streamFactory: () => {
        audioStream = new PassThrough();
        return { stdout: audioStream, sampleFormat: 's16le', kill: () => audioStream?.end(), onClose: () => {} };
      },
      spotterFactory: (): XiaoaiKwsSpotter => ({
        createStream: () => ({}),
        acceptWaveform: (_s, samples) => {
          processedSamples += samples.length;
          if (!wakeFired && wakeAtSample >= 0 && processedSamples >= wakeAtSample) {
            wakeFired = true;
          }
        },
        isReady: () => wakeFired,
        decode: () => {},
        getResult: () => {
          if (!wakeFired) return '';
          wakeFired = false;
          return '星期五';
        },
        reset: () => { wakeFired = false; },
      }),
      vadFactory: (): XiaoaiSpeechDetector => ({
        isSpeech: (samples) => computeRms(samples) >= 0.01,
        reset: () => {},
      }),
      liveAsrSessionFactory: (): LiveAsrSession => {
        const st = { pushed: 0, finished: false, aborted: false };
        liveStats.push(st);
        return {
          isUsable: () => !st.aborted,
          pushSamples: (samples) => { st.pushed += samples.length; },
          finish: async () => {
            st.finished = true;
            await delay(10);
            return { text: liveEnabledResult, latencyMs: 120 };
          },
          abort: () => { st.aborted = true; },
        };
      },
      recognizerFactory: () => ({
        transcribe: async () => {
          batchCalls++;
          return '打开客厅灯';
        },
      }),
      speakerGate: {
        isActive: () => true,
        verifyWake: () => ({ matched: true, score: 0.9, threshold: 0.3, speaker: { id: 'o1', name: '主人', role: 'owner', score: 0.9 } }),
        verifyUtterance: () => ({ matched: true, score: 0.9, threshold: 0.3 }),
        verifyUtteranceAsync: async ({ samples }) => {
          await delay(15);
          return trimmedByGate
            ? {
                matched: true,
                speaker: { id: 'o1', name: '主人', role: 'owner', score: 0.85 },
                score: 0.85,
                threshold: 0.3,
                samples: samples.subarray(0, Math.floor(samples.length * 0.6)),
                trimmed: true,
              }
            : {
                matched: true,
                speaker: { id: 'o1', name: '主人', role: 'owner', score: 0.9 },
                score: 0.9,
                threshold: 0.3,
                trimmed: false,
              };
        },
      },
      onWake: async () => ({ woken: true, suppressed: false }),
      onUtterance: async (ev) => {
        emitted.push(ev.text);
      },
    });

    monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    const writeTone = (amp: number, ms: number) => {
      const count = Math.round((ms / 1000) * FRONTEND_SAMPLE_RATE);
      const arr = new Float32Array(count);
      if (amp > 0) {
        for (let i = 0; i < count; i++) {
          arr[i] = amp * Math.sin((2 * Math.PI * 500 * i) / FRONTEND_SAMPLE_RATE);
        }
      }
      audioStream!.write(encodeInterleavedInt16Frames([arr]));
    };

    // 1. Live ASR happy path skips batch recognizer
    wakeAtSample = processedSamples + Math.round(0.2 * FRONTEND_SAMPLE_RATE);
    writeTone(0.2, 200);
    await delay(10);
    writeTone(0.25, 650);
    writeTone(0, 220);
    await until(() => emitted.length === 1);
    assert.equal(emitted[0], '查询明天天气。');
    assert.equal(batchCalls, 0, 'Batch recognizer must not run when Live ASR succeeds without trim');
    assert.ok((liveStats[0]?.pushed ?? 0) > 8000);
    assert.equal(liveStats[0]?.finished, true);

    // 2. When speakerGate trims trailing crosstalk, Live ASR result is bypassed in favor of batch ASR on trimmed audio
    await delay(40);
    trimmedByGate = true;
    liveEnabledResult = '打开客厅灯然后电视广告杂音';
    wakeAtSample = processedSamples + Math.round(0.2 * FRONTEND_SAMPLE_RATE);
    writeTone(0.2, 200);
    await delay(10);
    writeTone(0.25, 650);
    writeTone(0, 220);
    await until(() => emitted.length === 2);
    assert.equal(emitted[1], '打开客厅灯');
    assert.equal(batchCalls, 1, 'Trimmed utterances must re-transcribe trimmed audio via batch recognizer');

    monitor.close();
    monitor = undefined;
  } finally {
    monitor?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('xiaoai silence command: "闭嘴。" stops music and pauses hardware silently without follow-up dismissal or TTS reply', async () => {
  assert.equal(isXiaoaiSilenceCommand('闭嘴。'), true);
  assert.equal(isXiaoaiSilenceCommand('请闭嘴吧！'), true);
  assert.equal(isXiaoaiSilenceCommand('退下呗。'), false);
  assert.equal(isXiaoaiSilenceCommand('打开客厅灯'), false);

  assert.equal(isXiaoaiFollowUpCancel('闭嘴。'), false);
  assert.equal(isXiaoaiFollowUpCancel('退下呗。'), true);
  assert.equal(isXiaoaiFollowUpCancel('闭嘴', { includeEnrollVariants: true }), true);

  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-silence-'));
  try {
    const fastpathCalls: Array<{ text: string; allowedPlugins?: readonly string[] | ReadonlySet<string> }> = [];
    const sshCalls: string[] = [];
    let sendCalls = 0;
    let ingestCalls = 0;

    const fakeCtx: ImGatewayContext = {
      homeDir: home,
      coordinator: {} as ImGatewayContext['coordinator'],
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      markMessageDelivered: () => {},
      clearMessageDelivered: () => {},
      getSeenMessageVersion: () => 0,
      sendToChannel: async () => { sendCalls++; },
      ingestMessage: async () => {
        ingestCalls++;
        return { ok: true, action: 'ok' };
      },
      markTrustedWechatInbound: () => {},
      scheduleChannelPoll: () => {},
      runVoiceFastpath: async (req) => {
        fastpathCalls.push({ text: req.text, allowedPlugins: req.allowedPlugins });
        return { handled: true, ok: true, plugin: 'music', action: 'stop' };
      },
    };

    const adapter = new XiaoaiChannelAdapter(fakeCtx);
    adapter.deps = {
      sshRunner: async (_target, cmd) => {
        sshCalls.push(cmd);
        return { stdout: '', stderr: '', code: 0 };
      },
    };

    const channel: ImChannelConfig = {
      id: 'xiaoai-silence-test',
      platform: 'xiaoai',
      name: 'Silence Test',
      enabled: true,
      notifyAll: false,
      apiBase: 'ssh://lx06=root@192.0.2.104?kws=1',
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const res = await adapter.tryHandleInbound(
      channel,
      {
        channelId: channel.id,
        externalId: 'lx06:kws-1',
        senderId: 'lx06',
        senderName: 'lx06',
        target: 'lx06',
        text: '闭嘴。',
        explicitWake: true,
      },
      'req-silence-1',
    );

    assert.deepEqual(res, { ok: true, action: 'xiaoai_silence' });
    assert.equal(fastpathCalls.length, 1);
    assert.equal(fastpathCalls[0]!.text, '停止播放');
    assert.deepEqual(fastpathCalls[0]!.allowedPlugins, ['music']);
    assert.ok(sshCalls.includes(SSH_PAUSE_COMMAND));
    assert.ok(sshCalls.some(c => c.includes('/bin/shut_led 1')));
    assert.equal(sendCalls, 0, 'Silence command must never talk back with TTS');
    assert.equal(ingestCalls, 0, 'Silence command must handle locally without Router LLM turn');
    await adapter.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('audio-frontend: beamformHexArray resists stationary 204deg room noise and locks onto transient 90deg speech', () => {
  const sr = FRONTEND_SAMPLE_RATE;
  const totalSec = 1.6;
  const stationaryNoise = synthHexPlaneWave({
    durationSec: totalSec,
    azimuthDeg: 204,
    signalAtTime: t =>
      0.04 * Math.sin(2 * Math.PI * 480 * t)
      + 0.035 * Math.cos(2 * Math.PI * 1650 * t)
      + 0.03 * Math.sin(2 * Math.PI * 2900 * t),
    noiseAmp: 0.008,
    seed: 204,
  });

  const transientSpeech90 = synthHexPlaneWave({
    durationSec: totalSec,
    azimuthDeg: 90,
    signalAtTime: (t) => {
      if (t < 0.50 || t > 1.00) return 0;
      return (
        0.15 * Math.sin(2 * Math.PI * 520 * t)
        + 0.14 * Math.sin(2 * Math.PI * 1450 * t)
        + 0.13 * Math.sin(2 * Math.PI * 2600 * t)
      );
    },
    seed: 90,
  });

  const combined = stationaryNoise.map((noiseCh, idx) => {
    const speechCh = transientSpeech90[idx]!;
    const out = new Float32Array(noiseCh.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = noiseCh[i]! + speechCh[i]!;
    }
    return out;
  });

  const bf = beamformHexArray(combined, sr);
  assert.equal(bf.usedChannels, 6);
  const errDeg = circularAzimuthDiffDeg(bf.azimuthDeg, 90);
  assert.ok(errDeg <= 15, `Expected transient speech DOA near 90deg despite 204deg stationary noise, got ${bf.azimuthDeg}deg`);
});

test('audio-frontend & kws-monitor: 12-beam OnlineHexBeamformer preserves 90deg low-gain speech and array8 idle gate unlocks quiet wake', () => {
  const array8Gate = computeKwsIdleGateRms(0.00024, 'array8');
  assert.ok(
    array8Gate >= 0.00038 && array8Gate <= 0.00045,
    `Expected array8 idle gate in [0.00038, 0.00045], got ${array8Gate}`,
  );
  assert.ok(
    computeKwsIdleGateRms(0.00035, 's32le') >= 0.00075,
    '1ch s32le idle gate floor must remain >= 0.00075',
  );

  const sr = FRONTEND_SAMPLE_RATE;
  const frameLen = 640;
  const beamformer = new OnlineHexBeamformer(sr);
  const noiseFloor = synthHexPlaneWave({
    durationSec: 0.48,
    azimuthDeg: 210,
    signalAtTime: t => 0.0002 * Math.sin(2 * Math.PI * 1500 * t),
    noiseAmp: 0.00025,
    seed: 91,
  });
  for (let off = 0; off + frameLen <= noiseFloor[0]!.length; off += frameLen) {
    beamformer.process(noiseFloor.map(m => m.subarray(off, off + frameLen)));
  }

  const speech90 = synthHexPlaneWave({
    durationSec: 0.40,
    azimuthDeg: 90,
    signalAtTime: t =>
      0.0008 * Math.sin(2 * Math.PI * 1000 * t)
      + 0.0008 * Math.sin(2 * Math.PI * 2500 * t)
      + 0.0008 * Math.sin(2 * Math.PI * 3600 * t),
    seed: 92,
  });
  const out90 = new Float32Array(speech90[0]!.length);
  let lastAz90 = -1;
  for (let off = 0; off + frameLen <= speech90[0]!.length; off += frameLen) {
    const res = beamformer.process(speech90.map(m => m.subarray(off, off + frameLen)));
    out90.set(res.samples, off);
    lastAz90 = res.azimuthDeg;
  }
  assert.equal(lastAz90, 90, `Expected 12-beam OnlineHexBeamformer to lock onto 90deg speech, got ${lastAz90}deg`);
  const inRms90 = computeRms(speech90[0]!.subarray(frameLen * 2));
  const outRms90 = computeRms(out90.subarray(frameLen * 2));
  assert.ok(
    outRms90 / Math.max(1e-6, inRms90) >= 0.85,
    `Expected >=0.85 RMS preservation at 90deg, got ${(outRms90 / Math.max(1e-6, inRms90)).toFixed(3)}`,
  );
});
