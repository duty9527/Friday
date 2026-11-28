import { errorText } from '@friday/web/shared/format.js';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LayoutGridIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  SparklesIcon,
  Trash2Icon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { isSafePreviewImageUrl } from '@/components/shared/safeUrl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useFriday } from '@/lib/friday-store';

type CardSize = '1x1' | '2x1' | '1x2' | '2x2';

interface Cs80CardSpec {
  id: string;
  kind: string;
  size: CardSize;
  plugin?: string;
  action?: string;
  title?: string;
  ttlSec?: number;
}

interface Cs80PageSpec {
  id: string;
  name: string;
  cards: Cs80CardSpec[];
}

interface Cs80LayoutConfig {
  version: number;
  gridRows: 2 | 3;
  marqueeMode: 'auto_pause' | 'continuous' | 'static';
  marqueeSpeed: 1 | 2 | 3;
  pageRotateSec: number;
  autoTaskOverlay: boolean;
  activePage: number;
  weatherCity: string;
  weatherLat?: number;
  weatherLon?: number;
  pages: Cs80PageSpec[];
}

interface Cs80CatalogItem {
  kind: string;
  category: string;
  plugin?: string;
  title: string;
  subtitle: string;
  actions?: string[];
  defaultAction?: string;
  configurableAction?: boolean;
  defaultSize: CardSize;
}

interface Cs80WidgetSummary {
  headline: string;
  subline: string;
  ok: boolean;
}

interface Cs80ScreenPolicy {
  brightness?: number;
  nightStandbyEnabled: boolean;
  nightStandbyHours: string;
  idleStandbyEnabled: boolean;
  idleStandbyMin: number;
  tempWakeSec: number;
  manualStandby: boolean;
}

interface Cs80StatusData {
  ok: boolean;
  device?: string;
  usbSpeed?: number | null;
  botState?: string;
  subPhase?: string;
  expression?: string;
  standby?: boolean;
  standbyReason?: 'none' | 'manual' | 'night' | 'idle';
  standbyMode?: 'none' | 'hw_sleep' | 'backlight_off' | 'black_dim';
  tempWakeRemainingSec?: number;
  screenPolicy?: Cs80ScreenPolicy;
  brightness?: number;
  lastError?: string | null;
  stats?: { patchMs?: number };
  speaker?: { volume?: number; muted?: boolean; quietHours?: string };
}

interface Cs80DashboardPayload {
  ok: boolean;
  status: Cs80StatusData;
  layout: Cs80LayoutConfig;
  catalog: Cs80CatalogItem[];
  widgets: Record<string, Cs80WidgetSummary>;
  previewDataUrl?: string | null;
}

const CARD_SIZES: CardSize[] = ['1x1', '2x1', '1x2', '2x2'];
const BRIGHTNESS_OPTS = [100, 80, 60, 35, 15];
const VOLUME_OPTS = [100, 85, 65, 45, 25, 0];
const IDLE_MIN_OPTS = [5, 10, 15, 30, 60, 120];
const TEMP_WAKE_OPTS = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '60 秒' },
  { value: 90, label: '90 秒' },
  { value: 180, label: '3 分钟' },
  { value: 300, label: '5 分钟' },
];

function localizeStandbyReason(reason?: string): string {
  switch ((reason ?? '').trim().toLowerCase()) {
    case 'night':
      return '夜间待机';
    case 'idle':
      return '空闲待机';
    case 'manual':
      return '手动待机';
    default:
      return '待机';
  }
}

function localizeStandbyBanner(reason?: string): string {
  switch ((reason ?? '').trim().toLowerCase()) {
    case 'night':
      return '夜间定时息屏中';
    case 'idle':
      return '空闲超时息屏中';
    case 'manual':
      return '手动息屏待机中';
    default:
      return '待机息屏中';
  }
}

const BOT_STATE_LABELS: Record<string, string> = {
  idle: '待机守候',
  listening: '正在倾听',
  speaking: '语音播报',
  sending_msg: '发送消息',
  printing: '正在打印',
  operating_xiaoai: '操控小爱',
  operating_tv: '操控电视',
  managing_laifen: '牙刷管理',
  weighing_scale: '体脂测重',
  thinking: '思考推演',
  searching: '记忆检索',
  streaming: '正在回复',
  working: '协同执行',
  waiting: '等待指示',
  finished: '执行完成',
  failed: '执行受阻',
  sleeping: '静默休眠',
};

const EXPRESSION_LABELS: Record<string, string> = {
  auto: '自动表情',
  happy: '开心',
  listening: '专注倾听',
  speaking: '语音播报',
  sending_msg: '发送消息',
  printing: '正在打印',
  operating_xiaoai: '操控小爱',
  operating_tv: '操控电视',
  managing_laifen: '牙刷管理',
  weighing_scale: '体脂测重',
  inspecting: '打量',
  surprised: '惊喜',
  calm: '平静',
  sleepy: '困倦',
  neutral: '默认',
  squinted: '专注眯眼',
  confused: '疑惑',
  sad: '失落',
};

function localizeBotState(state?: string): string {
  const key = (state ?? 'idle').trim().toLowerCase();
  return BOT_STATE_LABELS[key] ?? state ?? '待机守候';
}

function localizeExpression(expr?: string): string {
  const key = (expr ?? 'auto').trim().toLowerCase();
  return EXPRESSION_LABELS[key] ?? expr ?? '自动表情';
}

const EXPRESSIONS: Array<{ expr: string; label: string; poke?: string; channel?: string }> = [
  { expr: 'listening', label: '倾听状态', poke: 'nod' },
  { expr: 'speaking', label: '小爱说话' },
  { expr: 'sending_msg', label: '微信发送', channel: 'wechat' },
  { expr: 'sending_msg', label: '电报发送', channel: 'telegram' },
  { expr: 'printing', label: '操作打印机' },
  { expr: 'operating_xiaoai', label: '操控小爱' },
  { expr: 'operating_tv', label: '操作电视' },
  { expr: 'managing_laifen', label: '牙刷管理' },
  { expr: 'weighing_scale', label: '体重秤测量' },
  { expr: 'happy', label: '开心弹跳', poke: 'bounce' },
  { expr: 'inspecting', label: '专注打量', poke: 'nod' },
  { expr: 'surprised', label: '转体惊喜', poke: 'spin' },
  { expr: 'auto', label: '恢复自动' },
];

const CHIMES = [
  { key: 'wake', label: '唤醒提示' },
  { key: 'ask_boss', label: '请示提醒' },
  { key: 'done', label: '任务完成' },
  { key: 'remind', label: '日程提醒' },
  { key: 'alert', label: '异常告警' },
];

function cloneLayout(src: Cs80LayoutConfig): Cs80LayoutConfig {
  return JSON.parse(JSON.stringify(src)) as Cs80LayoutConfig;
}

function estimateOverflowFlags(cards: readonly Cs80CardSpec[], gridRows: number): boolean[] {
  const rows = gridRows === 3 ? 3 : 2;
  const cols = 2;
  const occ: boolean[][] = Array.from({ length: rows }, () => [false, false]);
  const flags = new Array<boolean>(cards.length).fill(false);

  const fit = (ew: number, eh: number): [number, number] | undefined => {
    for (let r = 0; r <= rows - eh; r++) {
      for (let c = 0; c <= cols - ew; c++) {
        let free = true;
        for (let dr = 0; dr < eh; dr++) {
          for (let dc = 0; dc < ew; dc++) {
            if (occ[r + dr]![c + dc]) free = false;
          }
        }
        if (free) return [r, c];
      }
    }
    return undefined;
  };

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    const [rw, rh] = c.size.split('x').map(Number);
    const reqW = rw === 2 ? 2 : 1;
    const reqH = rh === 2 ? 2 : 1;
    const tries: Array<[number, number]> = [[reqW, reqH]];
    if (reqH === 2) tries.push([reqW, 1]);
    if (reqW === 2) tries.push([1, 1]);
    let placed: [number, number, number, number] | undefined;
    for (const [tw, th] of tries) {
      if (th > rows) continue;
      const pos = fit(tw, th);
      if (pos) {
        placed = [pos[0], pos[1], tw, th];
        break;
      }
    }
    if (!placed) {
      flags[i] = true;
    } else {
      for (let dr = 0; dr < placed[3]; dr++) {
        for (let dc = 0; dc < placed[2]; dc++) {
          occ[placed[0] + dr]![placed[1] + dc] = true;
        }
      }
    }
  }
  return flags;
}

export default function Cs80FaceSurface() {
  const { authExpired, api } = useFriday();
  const [payload, setPayload] = useState<Cs80DashboardPayload | null>(null);
  const [draftLayout, setDraftLayout] = useState<Cs80LayoutConfig | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [autoPreview, setAutoPreview] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [weatherCity, setWeatherCity] = useState('上海');
  const [weatherCityDirty, setWeatherCityDirty] = useState(false);
  const [bannerText, setBannerText] = useState('');
  const [quietHours, setQuietHours] = useState('');
  const [nightHoursDraft, setNightHoursDraft] = useState('23:00-07:30');
  const [nightHoursDirty, setNightHoursDirty] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  const [deletePageOpen, setDeletePageOpen] = useState(false);
  const [deleteCardTarget, setDeleteCardTarget] = useState<Cs80CardSpec | null>(null);

  const editRevRef = useRef(0);
  const seqRef = useRef(0);
  const editingInsideRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callFace = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
      return api<{ ok: boolean; message?: string; data?: T }>('/api/plugin-run', {
        plugin: 'cs80-face',
        action,
        args,
      }, { signal });
    },
    [api],
  );

  const applyPayload = useCallback(
    (data: Cs80DashboardPayload) => {
      setPayload(data);
      if (isSafePreviewImageUrl(data.previewDataUrl)) {
        setPreviewUrl(data.previewDataUrl!);
      }
      if (data.status?.speaker && !editingInsideRef.current) {
        setQuietHours(data.status.speaker.quietHours || '');
      }
      if (data.status?.screenPolicy && !editingInsideRef.current && !nightHoursDirty) {
        setNightHoursDraft(data.status.screenPolicy.nightStandbyHours || '23:00-07:30');
      }
      if (data.layout) {
        setDraftLayout(prev => {
          if (!dirty || !prev) {
            if (!weatherCityDirty) setWeatherCity(data.layout.weatherCity || '上海');
            return cloneLayout(data.layout);
          }
          return prev;
        });
      }
    },
    [dirty, nightHoursDirty, weatherCityDirty],
  );

  const refreshDashboard = useCallback(
    async (background = false, signal?: AbortSignal) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      const startRev = editRevRef.current;
      try {
        const res = await callFace<Cs80DashboardPayload>('dashboard', { includePreview: true }, signal);
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (res.ok && res.data) {
          if (editRevRef.current !== startRev) setDirty(true);
          applyPayload(res.data);
          if (!background) setStatus(null);
        } else if (!background) {
          setStatus({ text: res.message || 'CS80 守护进程尚未响应，请确认服务已启动。', tone: 'warn' });
        }
      } catch (err) {
        if (signal?.aborted || !mountedRef.current || seq !== seqRef.current) return;
        if (!background) setStatus({ text: `读取 CS80 副屏数据失败：${errorText(err)}`, tone: 'err' });
      }
    },
    [applyPayload, authExpired, callFace],
  );

  useEffect(() => {
    void refreshDashboard(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3.5s live screen preview poll while mounted and enabled
  useEffect(() => {
    if (!autoPreview || authExpired) return;
    let activeController = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden || busy || editingInsideRef.current) return;
      activeController.abort();
      activeController = new AbortController();
      void refreshDashboard(true, activeController.signal);
    }, 3500);
    return () => {
      clearInterval(timer);
      activeController.abort();
    };
  }, [autoPreview, authExpired, busy, refreshDashboard]);

  const syncLayout = async (nextLayout: Cs80LayoutConfig, patch?: Record<string, unknown>) => {
    setDraftLayout(nextLayout);
    setDirty(true);
    editRevRef.current++;
    const startRev = editRevRef.current;
    const seq = ++seqRef.current;
    setBusy(true);
    try {
      const args = patch
        ? { ...patch, includePreview: true }
        : {
            gridRows: nextLayout.gridRows,
            marqueeMode: nextLayout.marqueeMode,
            marqueeSpeed: nextLayout.marqueeSpeed,
            pageRotateSec: nextLayout.pageRotateSec,
            autoTaskOverlay: nextLayout.autoTaskOverlay,
            activePage: nextLayout.activePage,
            weatherCity: weatherCity.trim() || nextLayout.weatherCity || '上海',
            pages: nextLayout.pages,
            refreshWidgets: true,
            includePreview: true,
          };
      const res = await callFace<{ layout?: Cs80LayoutConfig; previewDataUrl?: string }>('layout', args);
      if (!mountedRef.current) return;
      if (res.ok && res.data?.layout) {
        if (seq === seqRef.current && editRevRef.current === startRev) {
          setDraftLayout(cloneLayout(res.data.layout));
          setDirty(false);
          if (!patch) setWeatherCityDirty(false);
        }
        if (isSafePreviewImageUrl(res.data.previewDataUrl)) {
          setPreviewUrl(res.data.previewDataUrl!);
        }
        setStatus(null);
      } else {
        setStatus({ text: res.message || '同步副屏布局失败', tone: 'err' });
      }
    } catch (err) {
      if (mountedRef.current) setStatus({ text: `同步副屏布局失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const runSimpleAction = async (errPrefix: string, fn: () => Promise<unknown>) => {
    if (authExpired) return;
    setBusy(true);
    try {
      await fn();
      if (mountedRef.current) setStatus(null);
    } catch (err) {
      if (mountedRef.current) setStatus({ text: `${errPrefix}：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const st = payload?.status;
  const up = st?.device === 'up';
  const activePageIdx = draftLayout ? Math.max(0, Math.min(draftLayout.pages.length - 1, draftLayout.activePage)) : 0;
  const curPage = draftLayout?.pages[activePageIdx];
  const overflowFlags = useMemo(
    () => (curPage && draftLayout ? estimateOverflowFlags(curPage.cards, draftLayout.gridRows) : []),
    [curPage, draftLayout],
  );

  const sendBanner = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = bannerText.trim();
    if (!text) {
      setStatus({ text: '请输入要投送到副屏跑马灯的文字内容。', tone: 'warn' });
      return;
    }
    await runSimpleAction('发送横幅消息失败', async () => {
      await callFace('express', { text, title: '控制台 · 互动消息', holdSec: 14 });
      setBannerText('');
      await refreshDashboard(true);
    });
  };

  return (
    <>
      <div
        className="flex flex-col gap-4 lg:grid lg:h-full lg:min-h-0 lg:flex-1 lg:grid-cols-[296px_minmax(0,1fr)] xl:grid-cols-[316px_minmax(0,1fr)] lg:overflow-hidden"
        onFocusCapture={() => { editingInsideRef.current = true; }}
        onBlurCapture={() => { editingInsideRef.current = false; }}
      >
        {/* Left Fixed Full-Height 800x1280 Portrait Mirror Column */}
        <div
          data-testid="cs80-left-panel"
          className="lg:flex lg:h-full lg:min-h-0 lg:flex-col"
        >
          <Card className="flex flex-col lg:h-full lg:min-h-0">
            <CardHeader className="shrink-0 px-4 pt-3.5 pb-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <CardTitle className="text-sm">物理副屏实时镜像</CardTitle>
                <div className="flex items-center gap-1">
                  <Badge size="sm" variant={up ? (st?.standby ? 'warning' : 'success') : 'secondary'}>
                    {st?.standby ? localizeStandbyReason(st.standbyReason) : (up ? `USB ${st?.usbSpeed ?? 480}M` : '仅预览')}
                  </Badge>
                  <Badge size="sm" variant={dirty ? 'warning' : 'secondary'}>
                    {dirty ? '同步中…' : '已同步'}
                  </Badge>
                </div>
              </div>
              <CardDescription className="text-xs">
                {localizeBotState(st?.botState)} · {localizeExpression(st?.expression)} · 亮度 {st?.brightness ?? 100}%
                {!st?.standby && (st?.tempWakeRemainingSec ?? 0) > 0 ? ` · 临时亮屏 ${st?.tempWakeRemainingSec}s` : ''}
                {st?.stats?.patchMs !== undefined ? ` · ${st.stats.patchMs}ms` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-3.5">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden lg:[container-type:size]">
                <div
                  data-testid="cs80-preview-frame"
                  className="relative flex aspect-[800/1280] items-center justify-center overflow-hidden rounded-2xl border-2 border-border bg-black shadow-inner lg:h-[min(100cqh,calc(100cqw*1280/800))] lg:w-[min(100cqw,calc(100cqh*800/1280))] max-lg:w-full max-lg:max-w-[264px]"
                >
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="CS80 实时帧预览"
                      className={`block size-full object-contain transition-opacity ${st?.standby ? 'opacity-30' : 'opacity-100'}`}
                      decoding="async"
                    />
                  ) : (
                    <div className="px-4 text-center text-xs text-zinc-400">
                      暂无画面帧（请确认守护进程已响应）
                    </div>
                  )}
                  {st?.standby && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-3">
                      <div className="rounded-full border border-amber-500/40 bg-zinc-950/85 px-3 py-1.5 text-center text-[11px] font-medium text-amber-200 shadow-lg">
                        {st.standbyMode === 'hw_sleep' || st.standbyMode === 'backlight_off'
                          ? '待机息屏中 · 背光已关'
                          : st.standbyMode === 'black_dim'
                            ? '待机息屏中 · 纯黑极暗'
                            : '待机息屏中'}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5">
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void runSimpleAction('重绘屏幕失败', async () => {
                  await callFace('screen', { refresh: true });
                  await refreshDashboard(false);
                })}>
                  <RefreshCwIcon className="size-3" />
                  <span>重绘屏幕</span>
                </Button>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void runSimpleAction('切换息屏失败', async () => {
                  await callFace('screen', { standby: !(st?.standby ?? false) });
                  await refreshDashboard(false);
                })}>
                  <span>{st?.standby ? '唤醒副屏' : '待机息屏'}</span>
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void runSimpleAction('重置默认布局失败', async () => {
                    const res = await callFace<{ layout?: Cs80LayoutConfig; previewDataUrl?: string }>('layout', {
                      reset: true,
                      refreshWidgets: true,
                      includePreview: true,
                    });
                    if (res.ok && res.data?.layout) {
                      setDraftLayout(cloneLayout(res.data.layout));
                      setDirty(false);
                      setWeatherCityDirty(false);
                    }
                    if (isSafePreviewImageUrl(res.data?.previewDataUrl)) {
                      setPreviewUrl(res.data!.previewDataUrl!);
                    }
                  })}
                >
                  <RotateCcwIcon className="size-3" />
                  <span>恢复默认</span>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Independently Scrollable Studio Toolbar & Controls */}
        <div
          data-testid="plugin-hub-scroll"
          className="min-w-0 space-y-4 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pe-1"
        >
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <MonitorIcon className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">桌面副屏 · CS80 互动工作台</h3>
            <Badge variant={up ? (st?.standby ? 'warning' : 'success') : 'secondary'}>
              {st?.standby
                ? localizeStandbyBanner(st.standbyReason)
                : (up ? `USB ${st?.usbSpeed ?? 480} Mbps 在线` : '未接入屏幕 / 仅渲染预览')}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs">
              <Switch checked={autoPreview} onCheckedChange={setAutoPreview} />
              <span>3.5s 实时图传</span>
            </label>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void refreshDashboard(false)}>
              <RefreshCwIcon className="size-3.5" />
              <span>刷新状态</span>
            </Button>
          </div>
        </div>

        {status && (
          <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
            <AlertDescription className="text-xs">{status.text}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <SparklesIcon className="size-4" />
              <span>表情控制、跑马灯与声音亮度</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1">
              {EXPRESSIONS.map(ex => (
                <Button
                  key={ex.label}
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void runSimpleAction('发送表情控制失败', async () => {
                    await callFace('express', {
                      expr: ex.expr,
                      ...(ex.poke ? { poke: ex.poke } : {}),
                      ...(ex.channel ? { channel: ex.channel } : {}),
                      holdSec: ex.expr === 'auto' ? 0 : 8,
                    });
                    await refreshDashboard(true);
                  })}
                >
                  {ex.label}
                </Button>
              ))}
            </div>

            <form onSubmit={e => void sendBanner(e)} className="flex gap-2">
              <Input
                size="sm"
                value={bannerText}
                onChange={e => setBannerText(e.target.value)}
                placeholder="发送一条文本投送到副屏跑马灯…"
              />
              <Button type="submit" size="sm" disabled={busy}>
                <SendIcon className="size-3.5" />
                <span>投送</span>
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">亮度：</span>
              {BRIGHTNESS_OPTS.map(b => (
                <Button
                  key={b}
                  size="xs"
                  variant={(st?.brightness ?? 100) === b ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => void runSimpleAction('调节亮度失败', async () => {
                    await callFace('screen', { brightness: b });
                    await refreshDashboard(true);
                  })}
                >
                  {b === 100 ? '100% 零频闪' : `${b}%`}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="flex items-center gap-1">
                <Volume2Icon className="size-3.5 text-muted-foreground" />
                <select
                  aria-label="喇叭音量"
                  value={String(Math.round(Number(st?.speaker?.volume ?? 65)))}
                  disabled={busy}
                  onChange={e => void runSimpleAction('调节音量失败', async () => {
                    await callFace('sound', { volume: Number(e.target.value) });
                    await refreshDashboard(true);
                  })}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  {VOLUME_OPTS.map(v => <option key={v} value={String(v)}>{v}%</option>)}
                </select>
              </div>
              <Button
                size="xs"
                variant={st?.speaker?.muted ? 'destructive' : 'outline'}
                disabled={busy}
                onClick={() => void runSimpleAction('切换静音失败', async () => {
                  await callFace('sound', { muted: !(st?.speaker?.muted ?? false) });
                  await refreshDashboard(true);
                })}
              >
                <VolumeXIcon className="size-3.5" />
                <span>{st?.speaker?.muted ? '取消静音' : '静音'}</span>
              </Button>
              <Input
                size="sm"
                className="w-36"
                value={quietHours}
                onChange={e => setQuietHours(e.target.value)}
                placeholder="23:00-07:30"
              />
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void runSimpleAction('保存免打扰时段失败', async () => {
                  await callFace('sound', { volume: Number(st?.speaker?.volume ?? 65), quietHours: quietHours.trim() });
                  await refreshDashboard(true);
                })}
              >
                应用时段
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">试音：</span>
              {CHIMES.map(c => (
                <Button
                  key={c.key}
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void runSimpleAction('试音失败', async () => {
                    const res = await callFace('sound', { chime: c.key, force: true });
                    if (!res.ok) setStatus({ text: res.message || '喇叭试音失败', tone: 'err' });
                  })}
                >
                  {c.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <MoonIcon className="size-4" />
              <span>自动待机与夜间息屏</span>
            </CardTitle>
            <CardDescription className="text-xs">
              待机期间自动关闭背光或切换纯黑极暗；仅语音唤醒或手动操作临时亮屏，微信与定时任务不打扰。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            {(() => {
              const policy = st?.screenPolicy;
              const nightEnabled = policy?.nightStandbyEnabled ?? true;
              const idleEnabled = policy?.idleStandbyEnabled ?? false;
              const idleMin = policy?.idleStandbyMin ?? 15;
              const tempWakeSec = policy?.tempWakeSec ?? 90;
              const idleChoices = IDLE_MIN_OPTS.includes(idleMin)
                ? IDLE_MIN_OPTS
                : [...IDLE_MIN_OPTS, idleMin].sort((a, b) => a - b);
              const tempWakeChoices = TEMP_WAKE_OPTS.some(opt => opt.value === tempWakeSec)
                ? TEMP_WAKE_OPTS
                : [...TEMP_WAKE_OPTS, { value: tempWakeSec, label: `${tempWakeSec} 秒` }].sort((a, b) => a.value - b.value);

              const updateScreenPolicy = async (patch: Record<string, unknown>, clearNightDirty = false) => {
                if (authExpired) return;
                setBusy(true);
                try {
                  const res = await callFace('screen', patch);
                  if (!mountedRef.current) return;
                  if (res.ok) {
                    if (clearNightDirty) setNightHoursDirty(false);
                    setStatus(null);
                    await refreshDashboard(true);
                  } else {
                    setStatus({ text: res.message || '更新待机策略失败', tone: 'err' });
                  }
                } catch (err) {
                  if (mountedRef.current) {
                    setStatus({ text: `更新待机策略失败：${errorText(err)}`, tone: 'err' });
                  }
                } finally {
                  if (mountedRef.current) setBusy(false);
                }
              };

              return (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Switch
                        checked={nightEnabled}
                        disabled={busy}
                        onCheckedChange={checked => void updateScreenPolicy({ nightStandbyEnabled: Boolean(checked) })}
                      />
                      <span>夜间定时自动息屏</span>
                    </label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        size="sm"
                        className="w-36"
                        aria-label="夜间息屏时段"
                        value={nightHoursDraft}
                        disabled={busy}
                        onChange={e => {
                          setNightHoursDirty(true);
                          setNightHoursDraft(e.target.value);
                        }}
                        placeholder="23:00-07:30"
                      />
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void updateScreenPolicy({ nightStandbyHours: nightHoursDraft.trim() }, true)}
                      >
                        保存时段
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Switch
                          checked={idleEnabled}
                          disabled={busy}
                          onCheckedChange={checked => void updateScreenPolicy({ idleStandbyEnabled: Boolean(checked) })}
                        />
                        <span>空闲超时自动息屏</span>
                      </label>
                      <select
                        aria-label="空闲超时时长"
                        value={String(idleMin)}
                        disabled={busy}
                        onChange={e => void updateScreenPolicy({ idleStandbyMin: Number(e.target.value) })}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
                      >
                        {idleChoices.map(m => (
                          <option key={m} value={String(m)}>
                            {m} 分钟
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">临时唤醒时长：</span>
                      <select
                        aria-label="临时唤醒时长"
                        value={String(tempWakeSec)}
                        disabled={busy}
                        onChange={e => void updateScreenPolicy({ tempWakeSec: Number(e.target.value) })}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
                      >
                        {tempWakeChoices.map(opt => (
                          <option key={opt.value} value={String(opt.value)}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              );
            })()}
          </CardContent>
        </Card>

        {/* Bento Layout Config */}
        {draftLayout && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <LayoutGridIcon className="size-4" />
                  <span>多屏卡片布局</span>
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Global layout settings */}
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 text-xs">
              <div className="space-y-1">
                <Label className="text-[11px]">网格行数</Label>
                <div className="flex gap-1">
                  {([2, 3] as const).map(rows => (
                    <Button
                      key={rows}
                      size="xs"
                      variant={draftLayout.gridRows === rows ? 'default' : 'outline'}
                      onClick={() => {
                        const next = cloneLayout(draftLayout);
                        next.gridRows = rows;
                        void syncLayout(next, { gridRows: rows });
                      }}
                    >
                      {rows} 行
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">跑马灯模式</Label>
                <select
                  value={draftLayout.marqueeMode}
                  onChange={e => {
                    const next = cloneLayout(draftLayout);
                    next.marqueeMode = e.target.value as Cs80LayoutConfig['marqueeMode'];
                    void syncLayout(next, { marqueeMode: next.marqueeMode });
                  }}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="auto_pause">自动暂停</option>
                  <option value="continuous">持续滚动</option>
                  <option value="static">静止显示</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">页面轮播秒数</Label>
                <select
                  value={String(draftLayout.pageRotateSec)}
                  onChange={e => {
                    const next = cloneLayout(draftLayout);
                    next.pageRotateSec = Number(e.target.value) || 0;
                    void syncLayout(next, { pageRotateSec: next.pageRotateSec });
                  }}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="0">不自动切换</option>
                  <option value="15">15 秒</option>
                  <option value="30">30 秒</option>
                  <option value="60">60 秒</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">天气城市</Label>
                <div className="flex gap-1">
                  <Input
                    size="sm"
                    value={weatherCity}
                    onChange={e => { setWeatherCityDirty(true); setWeatherCity(e.target.value); }}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      const next = cloneLayout(draftLayout);
                      next.weatherCity = weatherCity.trim() || '上海';
                      void syncLayout(next);
                    }}
                  >
                    应用
                  </Button>
                </div>
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={draftLayout.autoTaskOverlay}
                    onCheckedChange={v => {
                      const next = cloneLayout(draftLayout);
                      next.autoTaskOverlay = Boolean(v);
                      void syncLayout(next, { autoTaskOverlay: next.autoTaskOverlay });
                    }}
                  />
                  <span>任务自动浮层</span>
                </label>
              </div>
            </div>

            {/* Page Tabs + Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="flex flex-wrap items-center gap-1">
                {draftLayout.pages.map((pg, idx) => (
                  <Button
                    key={pg.id}
                    size="xs"
                    variant={idx === activePageIdx ? 'default' : 'outline'}
                    onClick={() => {
                      const next = cloneLayout(draftLayout);
                      next.activePage = idx;
                      void syncLayout(next, { activePage: idx });
                    }}
                  >
                    {pg.name} ({pg.cards.length})
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={draftLayout.pages.length >= 6}
                  onClick={() => {
                    const next = cloneLayout(draftLayout);
                    next.pages.push({
                      id: `page-${Date.now().toString(36).slice(-4)}`,
                      name: `副页 ${next.pages.length + 1}`,
                      cards: [],
                    });
                    next.activePage = next.pages.length - 1;
                    void syncLayout(next, { pages: next.pages, activePage: next.activePage });
                  }}
                >
                  <PlusIcon className="size-3" />
                  <span>新增页</span>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setRenameValue(curPage?.name ?? '');
                    setRenaming(v => !v);
                  }}
                >
                  重命名
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={draftLayout.pages.length <= 1}
                  onClick={() => setDeletePageOpen(true)}
                  aria-label="删除当前页"
                >
                  <Trash2Icon className="size-3.5 text-destructive" />
                </Button>
              </div>
            </div>

            {renaming && curPage && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/20 p-2">
                <Input size="sm" value={renameValue} maxLength={24} onChange={e => setRenameValue(e.target.value)} />
                <Button
                  size="xs"
                  onClick={() => {
                    const trimmed = renameValue.trim().slice(0, 24);
                    if (!trimmed) return;
                    const next = cloneLayout(draftLayout);
                    next.pages[activePageIdx]!.name = trimmed;
                    setRenaming(false);
                    void syncLayout(next, { pages: next.pages });
                  }}
                >
                  确定
                </Button>
              </div>
            )}

            {/* Current Page Cards */}
            {!curPage || curPage.cards.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">当前页为空，请从下方卡片库点击添加。</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {curPage.cards.map((card, idx) => {
                  const cat = payload?.catalog.find(c => c.kind === card.kind);
                  const wKey = card.kind.startsWith('plugin:') ? `${card.kind}#${card.id}` : card.kind;
                  const widget = payload?.widgets[wKey] ?? payload?.widgets[card.kind];
                  const overflow = overflowFlags[idx];
                  return (
                    <div key={card.id} className={`rounded-lg border p-2.5 space-y-2 ${overflow ? 'border-destructive' : ''}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold truncate">{card.title || cat?.title || card.kind}</span>
                        <Badge variant={overflow ? 'error' : 'warning'}>{overflow ? '超出格数' : card.size}</Badge>
                      </div>
                      <div className="text-xs">{widget?.headline || '等待数据采集'}</div>
                      {widget?.subline && <div className="text-[11px] text-muted-foreground truncate">{widget.subline}</div>}
                      <div className="flex flex-wrap items-center justify-between gap-1 pt-1">
                        <div className="flex gap-1">
                          {CARD_SIZES.map(sz => (
                            <Button
                              key={sz}
                              size="xs"
                              variant={card.size === sz ? 'default' : 'outline'}
                              onClick={() => {
                                const next = cloneLayout(draftLayout);
                                next.pages[activePageIdx]!.cards[idx]!.size = sz;
                                void syncLayout(next, { pages: next.pages, activePage: next.activePage });
                              }}
                            >
                              {sz.replace('x', '×')}
                            </Button>
                          ))}
                        </div>
                        <div className="flex gap-0.5">
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={idx === 0}
                            onClick={() => {
                              const next = cloneLayout(draftLayout);
                              const list = next.pages[activePageIdx]!.cards;
                              [list[idx - 1], list[idx]] = [list[idx]!, list[idx - 1]!];
                              void syncLayout(next, { pages: next.pages, activePage: next.activePage });
                            }}
                            aria-label="前移"
                          >
                            <ArrowUpIcon className="size-3" />
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={idx === curPage.cards.length - 1}
                            onClick={() => {
                              const next = cloneLayout(draftLayout);
                              const list = next.pages[activePageIdx]!.cards;
                              [list[idx + 1], list[idx]] = [list[idx]!, list[idx + 1]!];
                              void syncLayout(next, { pages: next.pages, activePage: next.activePage });
                            }}
                            aria-label="后移"
                          >
                            <ArrowDownIcon className="size-3" />
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setDeleteCardTarget(card)} aria-label="移除卡片">
                            <Trash2Icon className="size-3 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

              {/* Catalog Picker */}
              <div className="space-y-2 border-t pt-3">
                <div className="text-xs font-medium text-muted-foreground">添加副屏数据卡片 ({payload?.catalog.length ?? 0} 个可用源)</div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {(payload?.catalog ?? []).map(item => (
                    <div key={item.kind} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                      <div className="min-w-0 truncate">
                        <div className="font-medium truncate">{item.title}</div>
                        <div className="text-[10px] text-muted-foreground">{item.category}</div>
                      </div>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || (curPage?.cards.length ?? 0) >= 8}
                        onClick={() => {
                          const next = cloneLayout(draftLayout);
                          const pg = next.pages[activePageIdx];
                          if (!pg || pg.cards.length >= 8) {
                            setStatus({ text: '单页最多配置 8 张卡片，请新增副页。', tone: 'warn' });
                            return;
                          }
                          pg.cards.push({
                            id: `c-${Date.now().toString(36).slice(-5)}-${pg.cards.length + 1}`,
                            kind: item.kind,
                            size: item.defaultSize || '1x1',
                            ...(item.plugin ? { plugin: item.plugin } : {}),
                            ...(item.defaultAction ? { action: item.defaultAction } : {}),
                            ...(item.category === 'custom_plugin' ? { title: item.title, ttlSec: 120 } : {}),
                          });
                          void syncLayout(next, { pages: next.pages, activePage: next.activePage, refreshWidgets: true });
                        }}
                      >
                        添加
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        </div>
      </div>

      <ConfirmActionDialog
        open={deletePageOpen}
        onOpenChange={setDeletePageOpen}
        title="删除当前卡片页"
        description={`确定删除卡片页「${curPage?.name ?? ''}」及其 ${curPage?.cards.length ?? 0} 张卡片吗？`}
        busy={busy}
        onConfirm={async () => {
          setDeletePageOpen(false);
          if (!draftLayout || draftLayout.pages.length <= 1) return;
          const next = cloneLayout(draftLayout);
          next.pages.splice(activePageIdx, 1);
          next.activePage = Math.max(0, Math.min(next.pages.length - 1, next.activePage));
          await syncLayout(next, { pages: next.pages, activePage: next.activePage });
        }}
      />

      <ConfirmActionDialog
        open={Boolean(deleteCardTarget)}
        onOpenChange={open => { if (!open) setDeleteCardTarget(null); }}
        title="移除副屏卡片"
        description={`确定移除卡片「${deleteCardTarget?.title || deleteCardTarget?.kind || ''}」吗？`}
        busy={busy}
        onConfirm={async () => {
          const card = deleteCardTarget;
          setDeleteCardTarget(null);
          if (!draftLayout || !card) return;
          const next = cloneLayout(draftLayout);
          const pg = next.pages[activePageIdx];
          if (!pg) return;
          pg.cards = pg.cards.filter(c => c.id !== card.id);
          await syncLayout(next, { pages: next.pages, activePage: next.activePage });
        }}
      />
    </>
  );
}
