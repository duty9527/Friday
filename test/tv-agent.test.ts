import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  buildDidlLite,
  isOpenOnlyGoal,
  executeTvAgentAction,
  formatRelTime,
  resolveDecisionEndpoint,
  runAction,
  stateFingerprint,
} from '../plugins/tv-agent/index.mjs';

const HOST = '192.0.2.182';
const AGENT = `http://${HOST}:8989`;
const DLNA = `http://${HOST}:49152`;

type Node = Record<string, unknown>;

interface Call {
  method: string;
  url: string;
  body?: any;
  headers?: Record<string, string>;
  soap?: string;
}

interface DecisionPlan {
  goal?: number;
  choice?: string;
  confidence?: number;
}

function node(id: string, text: string, extra: Node = {}): Node {
  return {
    id, text, desc: '', viewId: '', cls: 'android.view.View', pkg: 'x', focused: false, selected: false,
    clickable: true, editable: false, scrollable: false, bounds: [0, 0, 100, 100], cx: 50, cy: 50, ...extra,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function soapResponse(action: string, inner = '') {
  return new Response(
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`,
    { status: 200, headers: { 'content-type': 'text/xml' } },
  );
}

/** In-memory fake of the TV (:8989 agent + :49152 DLNA) and the Decision API. */
function createMockTv(opts: Partial<{
  agentUp: boolean; dlnaUp: boolean; awake: boolean; volume: number; muted: boolean;
  pkg: string; apps: Array<{ package: string; label: string }>;
  trees: Node[][]; decisions: DecisionPlan[]; soapFail: boolean; decisionStatus: number;
}> = {}) {
  const tv = {
    agentUp: opts.agentUp ?? true,
    dlnaUp: opts.dlnaUp ?? true,
    awake: opts.awake ?? true,
    volume: opts.volume ?? 20,
    muted: opts.muted ?? false,
    pkg: opts.pkg ?? 'com.example.launcher',
    apps: opts.apps ?? [
      { package: 'com.bili.tv.bili_tv_app', label: '哔哩哔哩' },
      { package: 'org.smarttube.stable', label: 'SmartTube' },
      { package: 'com.example.music', label: 'Super Music' },
    ],
    trees: opts.trees ?? [],
    decisions: opts.decisions ?? [],
    soapFail: opts.soapFail ?? false,
    decisionStatus: opts.decisionStatus ?? 200,
    treeIdx: 0,
    decisionIdx: 0,
    calls: [] as Call[],
    onAct: undefined as undefined | ((body: any) => void),
    onIr: undefined as undefined | (() => void),
  };

  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = String(init.method ?? 'GET');
    const rawBody = typeof init.body === 'string' ? init.body : undefined;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { method, url, headers };
    if (rawBody) {
      if (url.startsWith(DLNA)) call.soap = rawBody;
      else call.body = JSON.parse(rawBody);
    }
    tv.calls.push(call);

    if (url.startsWith(AGENT)) {
      if (!tv.agentUp) throw new Error('connect ECONNREFUSED');
      const path = url.slice(AGENT.length);
      if (path === '/status') {
        return json({
          ok: true, version: '1.0.0', awake: tv.awake, a11yBound: true, guardedLauncherEnabled: true,
          packageName: tv.pkg, className: 'Main', volume: 7, maxVolume: 15, apps: tv.apps,
        });
      }
      if (path.startsWith('/tree')) {
        const nodes = tv.trees[Math.min(tv.treeIdx, tv.trees.length - 1)] ?? [];
        tv.treeIdx++;
        return json({ ok: true, awake: tv.awake, a11yBound: true, packageName: tv.pkg, windowCount: 1, nodes });
      }
      if (path.startsWith('/screenshot')) {
        return json({ ok: true, mimeType: 'image/jpeg', width: 960, height: 540, base64: Buffer.from('JPEGDATA').toString('base64') });
      }
      if (path === '/act') {
        tv.onAct?.(call.body);
        return json({ ok: true, action: call.body?.action, detail: 'done' });
      }
      return json({ ok: false }, 404);
    }

    if (url.startsWith(DLNA)) {
      if (!tv.dlnaUp) throw new Error('connect ECONNREFUSED');
      if (url.endsWith('/description.xml')) {
        return new Response('<root><device><friendlyName>客厅电视</friendlyName></device></root>', { status: 200 });
      }
      if (tv.soapFail) return new Response('<UPnPError><errorCode>501</errorCode><errorDescription>Action Failed</errorDescription></UPnPError>', { status: 500 });
      const action = /#(\w+)"?$/.exec(headers.SOAPACTION ?? '')?.[1] ?? '';
      switch (action) {
        case 'GetVolume': return soapResponse(action, `<CurrentVolume>${tv.volume}</CurrentVolume>`);
        case 'SetVolume': tv.volume = Number(/<DesiredVolume>(\d+)</.exec(rawBody ?? '')?.[1]); return soapResponse(action);
        case 'GetMute': return soapResponse(action, `<CurrentMute>${tv.muted ? 1 : 0}</CurrentMute>`);
        case 'SetMute': tv.muted = /<DesiredMute>1</.test(rawBody ?? ''); return soapResponse(action);
        case 'GetTransportInfo':
          return soapResponse(action, '<CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>');
        case 'GetPositionInfo':
          return soapResponse(action, '<TrackDuration>0:10:00</TrackDuration><TrackURI>http://m/v.mp4</TrackURI><RelTime>0:01:30</RelTime>');
        default: return soapResponse(action);
      }
    }

    if (url.includes('/decisions')) {
      if (tv.decisionStatus !== 200) return new Response('boom', { status: tv.decisionStatus });
      const plan = tv.decisions[Math.min(tv.decisionIdx, tv.decisions.length - 1)] ?? {};
      tv.decisionIdx++;
      return json({
        answers: {
          goal_reached: { type: 'noul', noul: plan.goal ?? 0.05 },
          next_action: { type: 'choice', choice: plan.choice ?? 'key_back', confidence: plan.confidence ?? 0.9 },
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const irCalls: Array<{ action: string; args: any }> = [];
  const irRunner = async (action: string, args: any) => {
    irCalls.push({ action, args });
    tv.onIr?.();
    return { ok: true, message: 'sent' };
  };
  const sleep = async () => {};
  const mockDataDir = mkdtempSync(join(tmpdir(), 'tv-agent-mock-'));
  writeFileSync(join(mockDataDir, 'config.json'), JSON.stringify({ tvHost: HOST }) + '\n', { mode: 0o600 });
  const deps = {
    fetch,
    irRunner,
    sleep,
    pollMs: 100,
    env: { PLUGIN_DATA_DIR: mockDataDir, FRIDAY_HOME: mockDataDir },
  } as any;
  const actBodies = () => tv.calls.filter(c => c.url === `${AGENT}/act` && c.method === 'POST').map(c => c.body);
  const decisionCalls = () => tv.calls.filter(c => c.url.includes('/decisions'));
  const soapActions = () => tv.calls.filter(c => c.soap).map(c => /#(\w+)"?$/.exec(c.headers?.SOAPACTION ?? '')?.[1]);
  return { tv, deps, irCalls, actBodies, decisionCalls, soapActions };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'tv-agent-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('tv-agent status reports online power state, foreground app, a11yBound, exact DLNA volume and apps', async () => {
  const m = createMockTv({ volume: 33, muted: true, pkg: 'com.bili.tv.bili_tv_app' });
  const r = await executeTvAgentAction('status', {}, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.data.powerState, 'online');
  assert.equal(r.data.packageName, 'com.bili.tv.bili_tv_app');
  assert.equal(r.data.appName, '哔哩哔哩');
  assert.equal(r.data.a11yBound, true);
  assert.equal(r.data.volume, 33);
  assert.equal(r.data.volumeSource, 'dlna');
  assert.equal(r.data.muted, true);
  assert.equal(r.data.friendlyName, '客厅电视');
  assert.equal(r.data.apps.length, 3);
  assert.match(r.message, /电视在线/);
});

test('tv-agent status reports standby_or_off when both :8989 and :49152 are unreachable', async () => {
  const m = createMockTv({ agentUp: false, dlnaUp: false });
  const r = await executeTvAgentAction('status', {}, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.data.powerState, 'standby_or_off');
  assert.equal(r.data.volume, undefined);
});

test('tv-agent status falls back to agent volume when DLNA is down', async () => {
  const m = createMockTv({ dlnaUp: false });
  const r = await executeTvAgentAction('status', {}, m.deps);
  assert.equal(r.data.powerState, 'online');
  assert.equal(r.data.volume, 7);
  assert.equal(r.data.volumeSource, 'agent');
});

// ---------------------------------------------------------------------------
// power (idempotent)
// ---------------------------------------------------------------------------

test('tv-agent power on when already on: wake only, NO IR toggle', async () => {
  const m = createMockTv();
  const r = await executeTvAgentAction('power', { state: 'on' }, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.message, '电视已处于开机状态');
  assert.equal(m.irCalls.length, 0);
  assert.deepEqual(m.actBodies(), [{ action: 'wake' }]);
});

test('tv-agent power off when already off: NO IR toggle', async () => {
  const m = createMockTv({ agentUp: false, dlnaUp: false });
  const r = await executeTvAgentAction('power', { state: 'off' }, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.message, '电视已处于关机/待机状态');
  assert.equal(m.irCalls.length, 0);
});

test('tv-agent power on when off: sends IR power once, then polls until online', async () => {
  const m = createMockTv({ agentUp: false, dlnaUp: false });
  let sleeps = 0;
  m.deps.sleep = async () => {
    sleeps++;
    if (sleeps === 3) { m.tv.agentUp = true; m.tv.dlnaUp = true; }
  };
  const r = await executeTvAgentAction('power', { state: 'on', waitMs: 22000 }, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.message, '电视已开机');
  assert.deepEqual(m.irCalls, [{ action: 'press', args: { key: 'power' } }]);
  assert.equal(r.data.irSent, true);
  assert.equal(r.data.polls, 3);
});

test('tv-agent power on times out cleanly when TV never comes online', async () => {
  const m = createMockTv({ agentUp: false, dlnaUp: false });
  const r = await executeTvAgentAction('power', { state: 'on', waitMs: 500 }, m.deps);
  assert.equal(r.ok, false);
  assert.equal(m.irCalls.length, 1);
  assert.equal(r.data.powerState, 'standby_or_off');
});

test('tv-agent power off when on: sends IR power and confirms standby', async () => {
  const m = createMockTv();
  m.tv.onIr = () => { m.tv.agentUp = false; m.tv.dlnaUp = false; };
  const r = await executeTvAgentAction('power', { state: 'off' }, m.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(m.irCalls, [{ action: 'press', args: { key: 'power' } }]);
  assert.equal(r.data.powerState, 'standby_or_off');
});

test('tv-agent power toggle picks direction from current state; IR failure is reported', async () => {
  const on = createMockTv();
  on.tv.onIr = () => { on.tv.agentUp = false; on.tv.dlnaUp = false; };
  await executeTvAgentAction('power', { state: 'toggle' }, on.deps);
  assert.equal(on.irCalls.length, 1);

  const off = createMockTv({ agentUp: false, dlnaUp: false });
  off.deps.irRunner = async () => ({ ok: false, message: 'LX06 unreachable' });
  const r = await executeTvAgentAction('power', { state: 'on' }, off.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /LX06 unreachable/);

  const bad = await executeTvAgentAction('power', { state: 'sideways' }, on.deps);
  assert.equal(bad.ok, false);
});

test('tv-agent power on with agent alive but screen asleep tries wake before IR', async () => {
  const m = createMockTv({ awake: false, dlnaUp: false });
  m.tv.onAct = body => { if (body.action === 'wake') m.tv.awake = true; };
  const r = await executeTvAgentAction('power', { state: 'on' }, m.deps);
  assert.equal(r.ok, true);
  assert.equal(m.irCalls.length, 0);
});

// ---------------------------------------------------------------------------
// volume
// ---------------------------------------------------------------------------

test('tv-agent volume reads exact volume via SOAP GetVolume', async () => {
  const m = createMockTv({ volume: 42 });
  const r = await executeTvAgentAction('volume', {}, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.data.volume, 42);
  assert.equal(r.data.via, 'dlna');
  const get = m.tv.calls.find(c => c.soap?.includes('GetVolume'))!;
  assert.equal(get.url, `${DLNA}/smartshare/render/_urn:schemas-upnp-org:service:RenderingControl_control`);
  assert.equal(get.headers?.SOAPACTION, '"urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"');
  assert.match(get.soap!, /<InstanceID>0<\/InstanceID><Channel>Master<\/Channel>/);
  assert.equal(m.irCalls.length, 0);
});

test('tv-agent volume level sets SetVolume with clamping', async () => {
  const m = createMockTv({ volume: 20 });
  const r = await executeTvAgentAction('volume', { level: 35 }, m.deps);
  assert.equal(r.data.volume, 35);
  assert.equal(m.tv.volume, 35);
  const set = m.tv.calls.find(c => c.soap?.includes('<u:SetVolume'))!;
  assert.match(set.soap!, /<DesiredVolume>35<\/DesiredVolume>/);

  await executeTvAgentAction('volume', { level: 250 }, m.deps);
  assert.equal(m.tv.volume, 100);
  await executeTvAgentAction('volume', { level: -9 }, m.deps);
  assert.equal(m.tv.volume, 0);
});

test('tv-agent volume delta reads GetVolume first then SetVolume(cur + delta), clamped', async () => {
  const m = createMockTv({ volume: 20 });
  const r = await executeTvAgentAction('volume', { delta: 8 }, m.deps);
  assert.equal(r.data.before, 20);
  assert.equal(r.data.volume, 28);
  assert.deepEqual(m.soapActions().slice(0, 2), ['GetVolume', 'SetVolume']);

  const down = await executeTvAgentAction('volume', { delta: -50 }, m.deps);
  assert.equal(down.data.volume, 0);
  m.tv.volume = 95;
  const up = await executeTvAgentAction('volume', { delta: 30 }, m.deps);
  assert.equal(up.data.volume, 100);
});

test('tv-agent volume mute toggles via SetMute', async () => {
  const m = createMockTv();
  const r = await executeTvAgentAction('volume', { mute: true }, m.deps);
  assert.equal(r.ok, true);
  assert.equal(m.tv.muted, true);
  assert.equal(r.data.muted, true);
  const set = m.tv.calls.find(c => c.soap?.includes('<u:SetMute'))!;
  assert.match(set.soap!, /<DesiredMute>1<\/DesiredMute>/);
  await executeTvAgentAction('volume', { mute: false }, m.deps);
  assert.equal(m.tv.muted, false);
});

test('tv-agent volume falls back to tv-ir vol_up/vol_down only when DLNA fails', async () => {
  const m = createMockTv({ dlnaUp: false });
  const up = await executeTvAgentAction('volume', { delta: 3 }, m.deps);
  assert.equal(up.ok, true);
  assert.equal(up.data.via, 'ir');
  assert.deepEqual(m.irCalls, [{ action: 'press', args: { key: 'vol_up', count: 3 } }]);

  const soapFail = createMockTv({ soapFail: true });
  const down = await executeTvAgentAction('volume', { delta: -2 }, soapFail.deps);
  assert.deepEqual(soapFail.irCalls, [{ action: 'press', args: { key: 'vol_down', count: 2 } }]);
  assert.equal(down.data.via, 'ir');

  // level fallback converts DLNA 0-100 percentage against maxVolume (15): 67% -> 10 steps (10 - 7 = +3)
  const lvl = createMockTv({ dlnaUp: false });
  await executeTvAgentAction('volume', { level: 67 }, lvl.deps);
  assert.deepEqual(lvl.irCalls, [{ action: 'press', args: { key: 'vol_up', count: 3 } }]);

  // 20% of 15 = 3 steps -> 3 - 7 = -4 (vol_down x4), and simultaneous mute is explicitly flagged as unapplied
  const lvlDown = createMockTv({ dlnaUp: false });
  const downRes = await executeTvAgentAction('volume', { level: 20, mute: true }, lvlDown.deps);
  assert.equal(downRes.ok, true);
  assert.deepEqual(lvlDown.irCalls, [{ action: 'press', args: { key: 'vol_down', count: 4 } }]);
  assert.equal(downRes.data.muteIgnored, true);
  assert.match(downRes.message, /静音/);

  const none = createMockTv({ dlnaUp: false });
  await executeTvAgentAction('volume', {}, none.deps);
  assert.equal(none.irCalls.length, 0);
});

test('tv-agent volume rejects non-numeric level', async () => {
  const m = createMockTv();
  const r = await executeTvAgentAction('volume', { level: 'loud' }, m.deps);
  assert.equal(r.ok, false);
  assert.equal(m.tv.calls.length, 0);
});

// ---------------------------------------------------------------------------
// cast
// ---------------------------------------------------------------------------

test('tv-agent cast play sends SetAVTransportURI (XML-escaped) with DIDL-Lite title, then Play', async () => {
  const m = createMockTv();
  const url = 'http://10.0.0.5/v.mp4?a=1&b=2';
  const r = await executeTvAgentAction('cast', { op: 'play', url, title: 'A <B> & C' }, m.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(m.soapActions(), ['SetAVTransportURI', 'Play']);
  const set = m.tv.calls.find(c => c.soap?.includes('<u:SetAVTransportURI'))!;
  assert.equal(set.url, `${DLNA}/smartshare/render/_urn:schemas-upnp-org:service:AVTransport_control`);
  assert.equal(set.headers?.SOAPACTION, '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"');
  assert.match(set.soap!, /<CurrentURI>http:\/\/10\.0\.0\.5\/v\.mp4\?a=1&amp;b=2<\/CurrentURI>/);
  // title is escaped twice: once inside DIDL, once as SOAP argument
  assert.match(set.soap!, /&lt;dc:title&gt;A &amp;lt;B&amp;gt; &amp;amp; C&lt;\/dc:title&gt;/);
  assert.doesNotMatch(set.soap!, /<DIDL-Lite/);
  const play = m.tv.calls.find(c => c.soap?.includes('<u:Play'))!;
  assert.match(play.soap!, /<Speed>1<\/Speed>/);
});

test('tv-agent cast play without title sends empty metadata; pause/resume/stop/seek/info map to AVTransport actions', async () => {
  const m = createMockTv();
  await executeTvAgentAction('cast', { url: 'https://x/y.m3u8' }, m.deps);
  const set = m.tv.calls.find(c => c.soap?.includes('<u:SetAVTransportURI'))!;
  assert.match(set.soap!, /<CurrentURIMetaData><\/CurrentURIMetaData>/);

  const fresh = createMockTv();
  await executeTvAgentAction('cast', { op: 'pause' }, fresh.deps);
  await executeTvAgentAction('cast', { op: 'resume' }, fresh.deps);
  await executeTvAgentAction('cast', { op: 'stop' }, fresh.deps);
  const seek = await executeTvAgentAction('cast', { op: 'seek', position: '1:05' }, fresh.deps);
  assert.equal(seek.data.position, '0:01:05');
  assert.deepEqual(fresh.soapActions(), ['Pause', 'Play', 'Stop', 'Seek']);
  const seekCall = fresh.tv.calls.find(c => c.soap?.includes('<u:Seek'))!;
  assert.match(seekCall.soap!, /<Unit>REL_TIME<\/Unit><Target>0:01:05<\/Target>/);

  const info = await executeTvAgentAction('cast', { op: 'info' }, fresh.deps);
  assert.equal(info.data.transportState, 'PLAYING');
  assert.equal(info.data.relTime, '0:01:30');
  assert.equal(info.data.duration, '0:10:00');
});

test('tv-agent cast validates url/seek input and reports DLNA errors', async () => {
  const m = createMockTv();
  assert.equal((await executeTvAgentAction('cast', { op: 'play', url: 'file:///etc/passwd' }, m.deps)).ok, false);
  assert.equal((await executeTvAgentAction('cast', { op: 'seek', position: 'soon' }, m.deps)).ok, false);
  assert.equal((await executeTvAgentAction('cast', { op: 'dance' }, m.deps)).ok, false);
  assert.equal(m.tv.calls.length, 0);

  const bad = createMockTv({ soapFail: true });
  const r = await executeTvAgentAction('cast', { op: 'pause' }, bad.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /501/);
});

test('tv-agent cast helpers: formatRelTime and buildDidlLite', () => {
  assert.equal(formatRelTime(3725), '1:02:05');
  assert.equal(formatRelTime('90'), '0:01:30');
  assert.equal(formatRelTime('00:02:03'), '0:02:03');
  assert.equal(formatRelTime('abc'), undefined);
  assert.equal(buildDidlLite('http://x/a.mp3', ''), '');
  assert.match(buildDidlLite('http://x/a.mp3', 'T'), /object\.item\.audioItem\.musicTrack/);
});

// ---------------------------------------------------------------------------
// open_app
// ---------------------------------------------------------------------------

test('tv-agent open_app resolves built-in aliases (Chinese + English) to packages', async () => {
  const cases: Array<[string, string]> = [
    ['bili', 'com.bili.tv.bili_tv_app'],
    ['B站', 'com.bili.tv.bili_tv_app'],
    ['哔哩哔哩', 'com.bili.tv.bili_tv_app'],
    ['bilitv', 'com.bili.tv.bili_tv_app'],
    ['YouTube', 'org.smarttube.stable'],
    ['油管', 'org.smarttube.stable'],
    ['SmartTube', 'org.smarttube.stable'],
    ['yt', 'org.smarttube.stable'],
  ];
  for (const [alias, pkg] of cases) {
    const m = createMockTv();
    const r = await executeTvAgentAction('open_app', { app: alias }, m.deps);
    assert.equal(r.ok, true, alias);
    assert.deepEqual(m.actBodies(), [{ action: 'launch_app', package: pkg }], alias);
    // aliases never need the app list
    assert.equal(m.tv.calls.some(c => c.url.endsWith('/status')), false, alias);
  }

  for (const [alias, pkg] of [
    ['直播', 'com.example.livetv'],
    ['mediabox', 'com.example.mediabox'],
    ['桌面', 'com.example.launcher'],
    ['home', 'com.example.launcher'],
  ]) {
    const m = createMockTv();
    const r = await executeTvAgentAction('open_app', {
      app: alias,
      appAliases: {
        'com.example.livetv': ['直播', 'livetv'],
        'com.example.mediabox': ['mediabox', '媒体箱'],
        'com.example.launcher': ['桌面', 'home'],
      },
    }, m.deps);
    assert.equal(r.ok, true, alias);
    assert.deepEqual(m.actBodies(), [{ action: 'launch_app', package: pkg }], alias);
    assert.equal(m.tv.calls.some(c => c.url.endsWith('/status')), false, alias);
  }
});

test('tv-agent open_app accepts exact package names, fuzzy installed labels, and uri', async () => {
  const exact = createMockTv();
  await executeTvAgentAction('open_app', { app: 'com.foo.bar' }, exact.deps);
  assert.deepEqual(exact.actBodies(), [{ action: 'launch_app', package: 'com.foo.bar' }]);

  const fuzzy = createMockTv();
  const r = await executeTvAgentAction('open_app', { app: 'super music' }, fuzzy.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(fuzzy.actBodies(), [{ action: 'launch_app', package: 'com.example.music' }]);

  const uri = createMockTv();
  await executeTvAgentAction('open_app', { app: 'bili', uri: 'bilibili://video/123' }, uri.deps);
  assert.deepEqual(uri.actBodies(), [{ action: 'open_uri', uri: 'bilibili://video/123', package: 'com.bili.tv.bili_tv_app' }]);

  const missing = createMockTv();
  const nope = await executeTvAgentAction('open_app', { app: 'nonexistent thing' }, missing.deps);
  assert.equal(nope.ok, false);
  assert.equal(missing.actBodies().length, 0);

  const noArg = await executeTvAgentAction('open_app', {}, missing.deps);
  assert.equal(noArg.ok, false);
});

// ---------------------------------------------------------------------------
// tree / screenshot / act / config
// ---------------------------------------------------------------------------

test('tv-agent tree, screenshot and act are structured wrappers over :8989', async () => {
  const m = createMockTv({ trees: [[node('n0', 'Hello')]] });
  const tree = await executeTvAgentAction('tree', { maxNodes: 25 }, m.deps);
  assert.equal(tree.ok, true);
  assert.equal(tree.data.nodes.length, 1);
  assert.ok(m.tv.calls.some(c => c.url === `${AGENT}/tree?maxNodes=25`));

  await withTmp(async dir => {
    const scDeps = { ...m.deps, env: { PLUGIN_DATA_DIR: dir, FRIDAY_HOME: dir } };
    await writeFile(join(dir, 'config.json'), JSON.stringify({ tvHost: HOST }) + '\n');
    const shot = await executeTvAgentAction('screenshot', { savePath: 'shot.jpg' }, scDeps);
    assert.equal(shot.ok, true);
    assert.equal(shot.data.base64, undefined);
    const savedOut = join(dir, 'screenshots', 'shot.jpg');
    assert.equal(shot.data.savedTo, savedOut);
    assert.equal((await readFile(savedOut)).toString(), 'JPEGDATA');
    assert.ok(m.tv.calls.some(c => c.url === `${AGENT}/screenshot?maxWidth=960&quality=70`));

    // Reject path traversal or outside-sandbox paths
    const badRel = await executeTvAgentAction('screenshot', { savePath: '../outside.jpg' }, scDeps);
    assert.equal(badRel.ok, false);
    const badAbs = await executeTvAgentAction('screenshot', { savePath: '/tmp/outside-shot.jpg' }, scDeps);
    assert.equal(badAbs.ok, false);

    const withData = await executeTvAgentAction('screenshot', { includeBase64: true }, m.deps);
    assert.equal(Buffer.from(withData.data.base64, 'base64').toString(), 'JPEGDATA');
  });

  const act = await executeTvAgentAction('act', { action: 'global', name: 'back' }, m.deps);
  assert.equal(act.ok, true);
  assert.deepEqual(m.actBodies(), [{ action: 'global', name: 'back' }]);
  assert.equal((await executeTvAgentAction('act', {}, m.deps)).ok, false);

  const down = createMockTv({ agentUp: false });
  assert.equal((await executeTvAgentAction('tree', {}, down.deps)).ok, false);
  assert.equal((await executeTvAgentAction('act', { action: 'wake' }, down.deps)).ok, false);
});

test('tv-agent config persists tvHost/ports/sshTarget in PLUGIN_DATA_DIR and applies them', async () => {
  await withTmp(async dir => {
    const m = createMockTv();
    const deps = { ...m.deps, env: { PLUGIN_DATA_DIR: dir, SUPER_AGENT_HOME: dir } };
    const initial = await executeTvAgentAction('config', {}, deps);
    assert.equal(initial.data.tvHost, '');
    assert.equal(initial.data.agentPort, 8989);
    assert.equal(initial.data.dlnaPort, 49152);

    const set = await executeTvAgentAction('config', { tvHost: '10.1.2.3', agentPort: 9000, dlnaPort: 50000, sshTarget: 'root@lx06' }, deps);
    assert.equal(set.ok, true);
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(saved, { tvHost: '10.1.2.3', tvToken: '', agentPort: 9000, dlnaPort: 50000, sshTarget: 'root@lx06', appAliases: {} });

    const seen: string[] = [];
    deps.fetch = async (url: string) => { seen.push(String(url)); throw new Error('down'); };
    await executeTvAgentAction('status', {}, deps);
    assert.ok(seen.includes('http://10.1.2.3:9000/status'));
    assert.ok(seen.includes('http://10.1.2.3:50000/description.xml'));

    assert.equal((await executeTvAgentAction('config', { tvHost: 'bad host/../x' }, deps)).ok, false);
    assert.equal((await executeTvAgentAction('config', { agentPort: 99999 }, deps)).ok, false);
  });
});

test('tv-agent rejects unknown actions', async () => {
  const r = await executeTvAgentAction('explode', {}, createMockTv().deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /navigate/);
});

// ---------------------------------------------------------------------------
// navigate (gemini-decision-1 loop)
// ---------------------------------------------------------------------------

const NAV_ARGS = { apiKey: 'test-key', baseUrl: 'https://decision.test', settleMs: 0 };

const homeTree = [
  node('n0', 'Projectivy', { clickable: false }),
  node('n1', '搜索', { viewId: 'a:id/search_btn', focused: true }),
  node('n2', '推荐', { viewId: 'a:id/tab_rec' }),
  node('n3', '动态', { viewId: 'a:id/tab_dyn' }),
];
const searchTree = [
  node('n0', '搜索', { clickable: false }),
  node('n1', '', { editable: true, viewId: 'a:id/search_box', cls: 'android.widget.EditText' }),
  node('n2', '历史记录', { viewId: 'a:id/history' }),
];
const resultTree = [
  node('n0', '周杰伦 - 晴天', { viewId: 'a:id/result' }),
  node('n1', '周杰伦 - 稻香', { viewId: 'a:id/result' }),
];

test('tv-agent navigate multi-step: click → set_text search injection → goal_reached termination (text-only input)', async () => {
  const m = createMockTv({
    pkg: 'com.bili.tv.bili_tv_app',
    trees: [homeTree, searchTree, resultTree],
    decisions: [
      { goal: 0.02, choice: 'click_n1' },
      { goal: 0.1, choice: 'type_n1' },
      { goal: 0.93, choice: 'click_n0' },
    ],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '搜索 "周杰伦" 并播放', maxSteps: 6 }, m.deps);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data.goalReached, true);
  assert.equal(r.data.steps, 3);

  // wake first, then click, then set_text; no click on the final (goal reached) step
  assert.deepEqual(m.actBodies(), [
    { action: 'wake' },
    { action: 'click', id: 'n1' },
    { action: 'set_text', id: 'n1', text: '周杰伦' },
  ]);

  // rich text tree => plain string input and no screenshot calls
  assert.equal(m.tv.calls.some(c => c.url.includes('/screenshot')), false);
  const decisions = m.decisionCalls();
  assert.equal(decisions.length, 3);
  assert.equal(decisions[0]!.url, 'https://decision.test/v1beta/decisions');
  assert.equal(decisions[0]!.headers?.['x-goog-api-key'], 'test-key');
  const first = decisions[0]!.body;
  assert.equal(first.model, 'gemini-decision-1');
  assert.equal(typeof first.input, 'string');
  assert.match(first.input, /搜索 "周杰伦" 并播放/);
  assert.match(first.input, /搜索/);
  assert.equal(first.questions.goal_reached.type, 'noul');
  assert.equal(first.questions.next_action.type, 'choice');
  const keys = Object.keys(first.questions.next_action.criteria);
  for (const k of ['click_n1', 'click_n2', 'scroll_down', 'scroll_up', 'scroll_right', 'scroll_left', 'dpad_left', 'dpad_right', 'dpad_up', 'dpad_down', 'dpad_center', 'key_back', 'key_home', 'request_screenshot', 'done_now', 'abort_impossible']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  assert.ok(keys.length <= 255);
  // searchText derived from the quoted keyword => type option on editable node in step 2
  assert.ok(Object.keys(decisions[1]!.body.questions.next_action.criteria).includes('type_n1'));
  // history is fed back to the model
  assert.match(decisions[1]!.body.input, /click_n1/);
});

test('tv-agent navigate attaches /screenshot as multimodal inline_data when tree is empty or sparse', async () => {
  const m = createMockTv({
    trees: [[], resultTree],
    decisions: [
      { goal: 0.0, choice: 'key_home' },
      { goal: 0.9, choice: 'done_now' },
    ],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '回到主页' }, m.deps);
  assert.equal(r.ok, true, r.message);

  const decisions = m.decisionCalls();
  const first = decisions[0]!.body;
  assert.ok(Array.isArray(first.input));
  assert.equal(first.input[0].type, 'image');
  assert.equal(first.input[0].mime_type, 'image/jpeg');
  assert.equal(first.input[0].inline_data, undefined);
  assert.equal(Buffer.from(first.input[0].data, 'base64').toString(), 'JPEGDATA');
  assert.equal(first.input[1].type, 'text');
  assert.equal(typeof first.input[1].text, 'string');
  assert.ok(m.tv.calls.some(c => c.url === `${AGENT}/screenshot?maxWidth=960&quality=68`));
  // screenshot already attached => request_screenshot is not offered
  assert.equal(Object.keys(first.questions.next_action.criteria).includes('request_screenshot'), false);
  assert.deepEqual(m.actBodies().slice(1), [{ action: 'global', name: 'home' }]);
  // second tree has 2 labelled nodes => text-only again
  assert.equal(typeof decisions[1]!.body.input, 'string');
});

test('tv-agent navigate: choosing request_screenshot re-evaluates the same step with the screenshot attached (no step wasted)', async () => {
  const m = createMockTv({
    trees: [homeTree],
    decisions: [
      { goal: 0.1, choice: 'request_screenshot' },
      { goal: 0.95, choice: 'done_now' },
    ],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '看看现在在哪', maxSteps: 3 }, m.deps);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data.steps, 1);
  const decisions = m.decisionCalls();
  assert.equal(decisions.length, 2);
  assert.equal(typeof decisions[0]!.body.input, 'string');
  assert.ok(Array.isArray(decisions[1]!.body.input));
  assert.equal(r.data.trace[0].requestedScreenshot, true);
  assert.equal(r.data.trace[0].screenshot, true);
});

test('tv-agent navigate launches app first (args.app or goal alias) and waits for launch settle', async () => {
  const sleeps: number[] = [];
  const m = createMockTv({
    pkg: 'com.example.launcher',
    trees: [resultTree],
    decisions: [{ goal: 0.95, choice: 'done_now' }],
  });
  m.deps.sleep = async (ms: number) => { sleeps.push(ms); };
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '打开 B站 看推荐' }, m.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(m.actBodies(), [{ action: 'wake' }, { action: 'launch_app', package: 'com.bili.tv.bili_tv_app' }]);
  assert.deepEqual(sleeps, [1400]);

  // already foreground => no re-launch from goal alias
  const fg = createMockTv({ pkg: 'org.smarttube.stable', trees: [resultTree], decisions: [{ goal: 0.95 }] });
  await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '在 SmartTube 里找首页' }, fg.deps);
  assert.deepEqual(fg.actBodies(), [{ action: 'wake' }]);

  // explicit args.app always launches, configurable settle
  const ex = createMockTv({ trees: [resultTree], decisions: [{ goal: 0.95 }] });
  ex.deps.sleep = async () => {};
  const rr = await executeTvAgentAction('navigate', {
    ...NAV_ARGS,
    goal: '随便看看',
    app: 'mediabox',
    appAliases: { 'com.example.mediabox': ['mediabox'] },
    launchSettleMs: 5,
  }, ex.deps);
  assert.equal(rr.ok, true);
  assert.deepEqual(ex.actBodies()[1], { action: 'launch_app', package: 'com.example.mediabox' });

  // goals that mention the desktop/launcher must be navigated by the model, not short-circuited
  const desk = createMockTv({ trees: [homeTree], decisions: [{ goal: 0.1, choice: 'click_n2' }, { goal: 0.9 }] });
  await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '在桌面上找到并打开 SmartTube 应用' }, desk.deps);
  assert.equal(desk.actBodies().some(b => b.action === 'launch_app'), false);
});

test('tv-agent navigate aborts on abort_impossible with diagnostic trace', async () => {
  const m = createMockTv({
    trees: [[node('n0', '请扫码登录', { clickable: false }), node('n1', '二维码', { clickable: false })]],
    decisions: [{ goal: 0.0, choice: 'abort_impossible' }],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '播放我的收藏' }, m.deps);
  assert.equal(r.ok, false);
  assert.equal(r.data.aborted, true);
  assert.equal(r.data.trace.at(-1).choice, 'abort_impossible');
  assert.match(r.message, /阻塞|扫码/);
  assert.deepEqual(m.actBodies(), [{ action: 'wake' }]);
});

test('tv-agent navigate stops when the same action repeats on an unchanged screen', async () => {
  const m = createMockTv({
    trees: [homeTree],
    decisions: [{ goal: 0.0, choice: 'click_n2' }],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '进入推荐', maxSteps: 10 }, m.deps);
  assert.equal(r.ok, false);
  assert.equal(r.data.steps, 2);
  assert.equal(m.actBodies().filter(b => b.action === 'click').length, 1);
  // unchanged state after an action forces the screenshot fallback on the next evaluation
  const decisions = m.decisionCalls();
  assert.ok(Array.isArray(decisions[1]!.body.input));
  // already-tried actions on the same screen state are no longer offered
  assert.ok('click_n2' in decisions[0]!.body.questions.next_action.criteria);
  assert.equal('click_n2' in decisions[1]!.body.questions.next_action.criteria, false);
  assert.ok('dpad_left' in decisions[1]!.body.questions.next_action.criteria);
  assert.match(decisions[1]!.body.input[1].text, /dpad_left/);
});

test('tv-agent navigate exhausts maxSteps (clamped 1..12) and reports unfinished', async () => {
  let n = 0;
  const trees = Array.from({ length: 20 }, (_, i) => [node('n0', `页面${i}`), node('n1', `项目${i}`)]);
  const m = createMockTv({ trees, decisions: [{ goal: 0.1, choice: 'scroll_down' }] });
  const origFetch = m.deps.fetch;
  m.deps.fetch = async (...a: any[]) => { n++; return origFetch(...a); };
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '一直往下找', maxSteps: 3 }, m.deps);
  assert.equal(r.ok, false);
  assert.equal(r.data.steps, 3);
  assert.equal(m.actBodies().filter(b => b.action === 'scroll').length, 3);

  const big = createMockTv({ trees, decisions: [{ goal: 0.1, choice: 'scroll_down' }] });
  const rb = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: 'x', maxSteps: 99 }, big.deps);
  assert.equal(rb.data.steps, 12);
  const small = createMockTv({ trees, decisions: [{ goal: 0.1, choice: 'scroll_down' }] });
  const rs = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: 'x', maxSteps: 0 }, small.deps);
  assert.ok(rs.data.steps >= 1 && rs.data.steps <= 8);
  assert.ok(n > 0);
});

test('tv-agent navigate low confidence forces screenshot on the next step', async () => {
  const m = createMockTv({
    trees: [homeTree, searchTree],
    decisions: [
      { goal: 0.0, choice: 'click_n2', confidence: 0.2 },
      { goal: 0.9, choice: 'done_now' },
    ],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '进入推荐' }, m.deps);
  assert.equal(r.ok, true);
  const decisions = m.decisionCalls();
  assert.equal(typeof decisions[0]!.body.input, 'string');
  assert.ok(Array.isArray(decisions[1]!.body.input));
});

test('tv-agent navigate uses explicit searchText for set_text on a search box without quotes in goal', async () => {
  const m = createMockTv({
    trees: [searchTree],
    decisions: [{ goal: 0.0, choice: 'type_n1' }, { goal: 0.9 }],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '搜索歌手', searchText: '陈奕迅' }, m.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(m.actBodies()[1], { action: 'set_text', id: 'n1', text: '陈奕迅' });
});

test('tv-agent navigate credentials: reads model-hub.json (decision then google provider) and fails clearly without a key', async () => {
  await withTmp(async dir => {
    await mkdir(join(dir, 'sdk'), { recursive: true });
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'config.json'), JSON.stringify({ tvHost: HOST }));
    await writeFile(join(dir, 'sdk', 'model-hub.json'), JSON.stringify({
      providers: { google: { apiKey: 'google-key' } },
    }));
    const m = createMockTv({ trees: [resultTree], decisions: [{ goal: 0.95 }] });
    const deps = { ...m.deps, env: { SUPER_AGENT_HOME: dir, PLUGIN_DATA_DIR: join(dir, 'data') } };
    const r = await executeTvAgentAction('navigate', { goal: 'g', settleMs: 0 }, deps);
    assert.equal(r.ok, true, r.message);
    const call = m.decisionCalls()[0]!;
    assert.equal(call.headers?.['x-goog-api-key'], 'google-key');
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/decisions');

    await writeFile(join(dir, 'sdk', 'model-hub.json'), JSON.stringify({
      decision: { apiKey: 'decision-key', baseUrl: 'https://proxy.example.com' },
      providers: { google: { apiKey: 'google-key' } },
    }));
    const m2 = createMockTv({ trees: [resultTree], decisions: [{ goal: 0.95 }] });
    const r2 = await executeTvAgentAction('navigate', { goal: 'g' }, { ...m2.deps, env: deps.env });
    assert.equal(r2.ok, true);
    assert.equal(m2.decisionCalls()[0]!.headers?.['x-goog-api-key'], 'decision-key');
    assert.equal(m2.decisionCalls()[0]!.url, 'https://proxy.example.com/v1beta/decisions');

    // explicit args.apiKey wins over the hub
    const m3 = createMockTv({ trees: [resultTree], decisions: [{ goal: 0.95 }] });
    await executeTvAgentAction('navigate', { goal: 'g', apiKey: 'explicit' }, { ...m3.deps, env: deps.env });
    assert.equal(m3.decisionCalls()[0]!.headers?.['x-goog-api-key'], 'explicit');

    // no key anywhere
    await rm(join(dir, 'sdk', 'model-hub.json'));
    const m4 = createMockTv({ trees: [resultTree] });
    const none = await executeTvAgentAction('navigate', { goal: 'g' }, { ...m4.deps, env: deps.env });
    assert.equal(none.ok, false);
    assert.match(none.message, /密钥/);
    assert.equal(m4.tv.calls.length, 0);
  });
});

test('tv-agent navigate surfaces Decision API and TV agent failures', async () => {
  const api = createMockTv({ trees: [homeTree], decisionStatus: 503 });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: 'g' }, api.deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /503/);

  const down = createMockTv({ agentUp: false });
  const d = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: 'g' }, down.deps);
  assert.equal(d.ok, false);
  assert.equal(down.decisionCalls().length, 0);

  const noGoal = await executeTvAgentAction('navigate', { ...NAV_ARGS }, createMockTv().deps);
  assert.equal(noGoal.ok, false);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('tv-agent resolveDecisionEndpoint handles /v1beta, bare origin, and /decisions suffixes', () => {
  assert.equal(resolveDecisionEndpoint('https://generativelanguage.googleapis.com/v1beta'), 'https://generativelanguage.googleapis.com/v1beta/decisions');
  assert.equal(resolveDecisionEndpoint('https://proxy.example.com/'), 'https://proxy.example.com/v1beta/decisions');
  assert.equal(resolveDecisionEndpoint('https://proxy.example.com/v1beta/decisions'), 'https://proxy.example.com/v1beta/decisions');
  assert.equal(resolveDecisionEndpoint(undefined), 'https://generativelanguage.googleapis.com/v1beta/decisions');
});

test('tv-agent stateFingerprint is stable and sensitive to focus/text changes', () => {
  const a = { packageName: 'p', nodes: [node('n0', 'A'), node('n1', 'B')] };
  const same = { packageName: 'p', nodes: [node('n0', 'A'), node('n1', 'B')] };
  const focused = { packageName: 'p', nodes: [node('n0', 'A', { focused: true }), node('n1', 'B')] };
  assert.equal(stateFingerprint(a), stateFingerprint(same));
  assert.notEqual(stateFingerprint(a), stateFingerprint(focused));
  assert.notEqual(stateFingerprint(a), stateFingerprint({ ...a, packageName: 'q' }));
});

test('tv-agent navigate keeps exploring untried actions on an unchanged screen (hidden items to the left)', async () => {
  const m = createMockTv({
    trees: [homeTree],
    decisions: [
      { goal: 0.0, choice: 'scroll_right', confidence: 0.6 },
      { goal: 0.0, choice: 'dpad_left', confidence: 0.6 },
      { goal: 0.9, choice: 'done_now' },
    ],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '在桌面上找到 SmartTube', maxSteps: 6 }, m.deps);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(m.actBodies().slice(1), [
    { action: 'scroll', direction: 'right' },
    { action: 'global', name: 'dpad_left' },
  ]);
  const crit = m.decisionCalls().map(c => Object.keys(c.body.questions.next_action.criteria));
  assert.ok(crit[0]!.includes('scroll_right') && crit[0]!.includes('scroll_left'));
  assert.equal(crit[1]!.includes('scroll_right'), false);
  assert.equal(crit[2]!.includes('scroll_right') || crit[2]!.includes('dpad_left'), false);
});

test('tv-agent navigate open-only goal finishes deterministically once the target app is foreground (no overshoot)', async () => {
  const m = createMockTv({
    trees: [homeTree, resultTree],
    decisions: [{ goal: 0.0, choice: 'click_n2' }, { goal: 0.0, choice: 'key_home' }],
  });
  m.tv.onAct = body => { if (body.action === 'click') m.tv.pkg = 'org.smarttube.stable'; };
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '在桌面上找到并打开 SmartTube 应用' }, m.deps);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.data.deterministic, true);
  assert.equal(r.data.steps, 2);
  assert.equal(m.decisionCalls().length, 1); // model not consulted again after the app is up
  assert.equal(m.actBodies().some(b => b.action === 'launch_app'), false);
  assert.equal(m.actBodies().some(b => b.action === 'global'), false);
});

test('tv-agent navigate does not short-circuit goals with follow-up tasks; isOpenOnlyGoal classification', async () => {
  assert.equal(isOpenOnlyGoal('在桌面上找到并打开 SmartTube 应用'), true);
  assert.equal(isOpenOnlyGoal('打开B站'), true);
  assert.equal(isOpenOnlyGoal('打开 B站 搜索周杰伦'), false);
  assert.equal(isOpenOnlyGoal('在 SmartTube 里找首页'), false);
  const m = createMockTv({
    pkg: 'org.smarttube.stable',
    trees: [resultTree],
    decisions: [{ goal: 0.95, choice: 'done_now' }],
  });
  const r = await executeTvAgentAction('navigate', { ...NAV_ARGS, goal: '打开 SmartTube 搜索 "周杰伦"' }, m.deps);
  assert.equal(r.ok, true);
  assert.equal(r.data.deterministic, undefined);
  assert.equal(m.decisionCalls().length, 1);
});

test('tv-agent DEFAULT_CONFIG is empty/neutral and non-config actions reject before tvHost is configured', async () => {
  assert.equal(DEFAULT_CONFIG.tvHost, '');
  assert.equal(DEFAULT_CONFIG.tvToken, '');
  assert.equal(DEFAULT_CONFIG.sshTarget, '');
  assert.deepEqual(DEFAULT_CONFIG.appAliases, {});

  const dataDir = await mkdtemp(join(tmpdir(), 'tv-agent-empty-'));
  try {
    const unconf = await runAction('status', {}, { pluginDataDir: dataDir });
    assert.equal(unconf.ok, false);
    assert.equal(unconf.title, '电视 Agent 未配置');

    const cfgRes = await runAction('config', {
      tvHost: '192.0.2.182',
      tvToken: 'tok-xyz',
      sshTarget: 'speaker=root@192.0.2.104',
      appAliases: { 'com.example.video': ['示例视频'] },
    }, { pluginDataDir: dataDir });
    assert.equal(cfgRes.ok, true);
    const st = await stat(join(dataDir, 'config.json'));
    assert.equal(st.mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(saved.tvHost, '192.0.2.182');
    assert.equal(saved.tvToken, 'tok-xyz');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('tv-agent sends X-TV-Token header when configured and forwards sshTarget to callPlugin("tv-ir", ...)', async () => {
  const seenHeaders: Array<Record<string, string>> = [];
  const irPluginCalls: Array<{ plugin: string; action: string; args: Record<string, unknown> }> = [];
  const dataDir = await mkdtemp(join(tmpdir(), 'tv-agent-token-'));
  try {
    await runAction('config', {
      tvHost: '192.0.2.182',
      tvToken: 'secret-tv-token',
      sshTarget: 'speaker=root@192.0.2.104',
    }, { pluginDataDir: dataDir });

    const offlineFetch = async (_url: string, init: { headers?: Record<string, string> } = {}) => {
      seenHeaders.push(init.headers ?? {});
      throw new Error('EHOSTUNREACH');
    };

    const stRes = await runAction('status', {}, {
      pluginDataDir: dataDir,
      fetch: offlineFetch,
    });
    assert.equal(stRes.ok, true);
    assert.ok(seenHeaders.some(h => h['X-TV-Token'] === 'secret-tv-token'));

    const pwrRes = await runAction('power', { state: 'on', waitMs: 5, pollMs: 1 }, {
      pluginDataDir: dataDir,
      fetch: offlineFetch,
      sleep: async () => {},
      callPlugin: async (plugin: string, action: string, args: Record<string, unknown>) => {
        irPluginCalls.push({ plugin, action, args });
        return { ok: true, message: 'sent' };
      },
    });
    assert.equal(pwrRes.ok, false);
    assert.equal(irPluginCalls.length, 1);
    assert.deepEqual(irPluginCalls[0], {
      plugin: 'tv-ir',
      action: 'press',
      args: { key: 'power', sshTarget: 'speaker=root@192.0.2.104' },
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
