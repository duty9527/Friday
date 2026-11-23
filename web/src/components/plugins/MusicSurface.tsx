import { hasOpenAuthCookie, OPEN_AUTH_SENTINEL_TOKEN } from '@friday/web/shared/auth-http.js';
import { errorText } from '@friday/web/shared/format.js';
import {
  ClockIcon,
  DownloadIcon,
  FolderPlusIcon,
  HeadphonesIcon,
  HeartIcon,
  ListMusicIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Repeat1Icon,
  RepeatIcon,
  SearchIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
  Volume2Icon,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { useFriday } from '@/lib/friday-store';

interface MusicTrackView {
  id: string;
  relPath: string;
  filename: string;
  folder: string;
  ext: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number | null;
  bitrateKbps: number | null;
  sizeBytes: number;
  previewUrl: string;
}

interface MusicPlaylistView {
  id: string;
  name: string;
  builtin?: boolean;
  trackIds: string[];
  updatedAt: number;
}

interface DownloadJobView {
  id: string;
  status: 'queued' | 'downloading' | 'done' | 'error';
  query: string;
  url: string;
  source: string;
  title: string;
  artist: string;
  trackId?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface OnlineCandidate {
  id: string;
  title: string;
  artist: string;
  durationSec: number | null;
  url: string;
  source: 'youtube' | 'bilibili' | 'direct';
}

interface MusicDashboardPayload {
  updatedAt: number;
  status: 'stopped' | 'playing' | 'paused';
  positionSec: number;
  loopMode: 'list' | 'single' | 'shuffle' | 'once';
  loopLabel: string;
  volume: number;
  timerEndsAtMs: number | null;
  currentTrack: MusicTrackView | null;
  queueIndex: number;
  queue: MusicTrackView[];
  trackCount: number;
  tracks: MusicTrackView[];
  playlists: MusicPlaylistView[];
  downloads: DownloadJobView[];
  speaker: {
    configured: boolean;
    id: string;
    userHost: string;
    source: string;
    live?: { status?: number | null; volume?: number | null; error?: string } | null;
  };
  ytDlpAvailable: boolean;
  streamBaseUrl: string;
  config: {
    musicDir: string;
    streamBaseUrl: string;
    speakerSsh: string;
    defaultVolume: number;
    downloadFormat: 'mp3' | 'm4a';
    defaultSearchSource: 'youtube' | 'bilibili';
    ytDlpPath: string;
    autoDownloadOnVoiceMiss: boolean;
  };
}

function formatDuration(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '--:--';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MusicSurface() {
  const { authExpired, api, token } = useFriday();
  const [data, setData] = useState<MusicDashboardPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const [activeTab, setActiveTab] = useState('library');

  const [libQuery, setLibQuery] = useState('');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>('all');
  const [previewTrack, setPreviewTrack] = useState<MusicTrackView | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number>(45);
  const [volumeDirty, setVolumeDirty] = useState(false);

  const [onlineInput, setOnlineInput] = useState('');
  const [onlineSource, setOnlineSource] = useState<'youtube' | 'bilibili'>('youtube');
  const [searchingOnline, setSearchingOnline] = useState(false);
  const [candidates, setCandidates] = useState<OnlineCandidate[]>([]);

  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [addTargetByTrack, setAddTargetByTrack] = useState<Record<string, string>>({});
  const [delTrackTarget, setDelTrackTarget] = useState<MusicTrackView | null>(null);

  const [cfgDirty, setCfgDirty] = useState(false);
  const [cfgMusicDir, setCfgMusicDir] = useState('');
  const [cfgStreamBaseUrl, setCfgStreamBaseUrl] = useState('');
  const [cfgSpeakerSsh, setCfgSpeakerSsh] = useState('');
  const [cfgDefaultVolume, setCfgDefaultVolume] = useState('45');
  const [cfgFormat, setCfgFormat] = useState<'mp3' | 'm4a'>('mp3');
  const [cfgSource, setCfgSource] = useState<'youtube' | 'bilibili'>('youtube');
  const [cfgAutoMiss, setCfgAutoMiss] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const onlineSourceInitRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callMusic = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}, timeoutMs?: number, signal?: AbortSignal) => {
      return api<{ ok: boolean; message?: string; data?: T }>('/api/plugin-run', {
        plugin: 'music',
        action,
        args,
      }, { ...(timeoutMs ? { timeoutMs } : {}), ...(signal ? { signal } : {}) });
    },
    [api],
  );

  const applyDashboard = useCallback((d: MusicDashboardPayload, forceSync = false) => {
    setData(d);
    if (forceSync || !volumeDirty) {
      setVolumeDraft(d.volume ?? 45);
    }
    if (forceSync || !cfgDirty) {
      setCfgMusicDir(d.config.musicDir || '');
      setCfgStreamBaseUrl(d.config.streamBaseUrl || '');
      setCfgSpeakerSsh(d.config.speakerSsh || '');
      setCfgDefaultVolume(String(d.config.defaultVolume ?? 45));
      setCfgFormat(d.config.downloadFormat || 'mp3');
      setCfgSource(d.config.defaultSearchSource || 'youtube');
      setCfgAutoMiss(Boolean(d.config.autoDownloadOnVoiceMiss));
      if (!onlineSourceInitRef.current) {
        onlineSourceInitRef.current = true;
        setOnlineSource(d.config.defaultSearchSource || 'youtube');
      }
    }
  }, [cfgDirty, volumeDirty]);

  const refreshDashboard = useCallback(async (live = false, quiet = true) => {
    if (authExpired) return;
    const seq = ++seqRef.current;
    try {
      const res = await callMusic<MusicDashboardPayload>('dashboard', { live });
      if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
      if (res.ok && res.data) applyDashboard(res.data);
      else if (!quiet) setStatus({ text: res.message || '加载音乐看板失败', tone: 'err' });
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (!quiet) setStatus({ text: errorText(err), tone: 'err' });
    }
  }, [applyDashboard, authExpired, callMusic]);

  useEffect(() => {
    void refreshDashboard(false, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasActiveDownloads = Boolean(data?.downloads?.some(j => j.status === 'queued' || j.status === 'downloading'));
  useEffect(() => {
    if ((!hasActiveDownloads && data?.status !== 'playing') || authExpired) return;
    const ac = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden || ac.signal.aborted) return;
      void callMusic<MusicDashboardPayload>('dashboard', { live: false }, undefined, ac.signal)
        .then(res => {
          if (mountedRef.current && res.ok && res.data) applyDashboard(res.data);
        })
        .catch(() => undefined);
    }, hasActiveDownloads ? 2500 : 5000);
    return () => {
      clearInterval(timer);
      ac.abort();
    };
  }, [applyDashboard, authExpired, callMusic, data?.status, hasActiveDownloads]);

  const runAction = async (label: string, fn: () => Promise<void>) => {
    if (busy || authExpired) return;
    setBusy(true);
    setStatus({ text: label, tone: 'warn' });
    try {
      await fn();
    } catch (err) {
      if (mountedRef.current) setStatus({ text: errorText(err), tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const favoritesSet = useMemo(() => {
    const fav = data?.playlists?.find(p => p.id === 'favorites');
    return new Set(fav?.trackIds ?? []);
  }, [data?.playlists]);

  const customPlaylists = useMemo(
    () => (data?.playlists ?? []).filter(p => p.id !== 'favorites'),
    [data?.playlists],
  );

  const visibleTracks = useMemo(() => {
    let list = data?.tracks ?? [];
    if (selectedPlaylistId !== 'all') {
      const pl = data?.playlists?.find(p => p.id === selectedPlaylistId);
      const idSet = new Set(pl?.trackIds ?? []);
      list = list.filter(t => idSet.has(t.id));
    }
    const q = libQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(t =>
      t.title.toLowerCase().includes(q)
      || t.artist.toLowerCase().includes(q)
      || t.album.toLowerCase().includes(q)
      || t.filename.toLowerCase().includes(q),
    );
  }, [data?.playlists, data?.tracks, libQuery, selectedPlaylistId]);

  const handleUploadFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0 || authExpired) return;
    setUploading(true);
    setStatus({ text: `正在上传 ${files.length} 个音频文件…`, tone: 'warn' });
    let okCount = 0;
    let lastError = '';
    try {
      for (const file of files) {
        const headers: Record<string, string> = {
          'x-music-filename': encodeURIComponent(file.name),
          'content-type': 'application/octet-stream',
        };
        if (token && !(token === OPEN_AUTH_SENTINEL_TOKEN && hasOpenAuthCookie())) {
          headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch('/api/music/upload', {
          method: 'POST',
          headers,
          body: file,
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({})) as { error?: string };
          lastError = payload.error || `上传失败 (${res.status})`;
          continue;
        }
        okCount += 1;
      }
      await refreshDashboard(false, true);
      if (mountedRef.current) {
        if (okCount === files.length) {
          setStatus({ text: `已上传并入库 ${okCount} 首歌曲`, tone: 'ok' });
        } else {
          setStatus({ text: `成功 ${okCount}/${files.length} 首${lastError ? `：${lastError}` : ''}`, tone: 'err' });
        }
      }
    } catch (err) {
      if (mountedRef.current) setStatus({ text: errorText(err), tone: 'err' });
    } finally {
      if (mountedRef.current) setUploading(false);
    }
  };

  const handleOnlineSearchOrDownload = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = onlineInput.trim();
    if (!trimmed || authExpired) return;
    if (/^https?:\/\//i.test(trimmed)) {
      await runAction('正在提交链接下载任务…', async () => {
        const res = await callMusic('download', { url: trimmed, async: true });
        setStatus({ text: res.message || '已开始后台下载', tone: res.ok ? 'ok' : 'err' });
        if (res.ok) setOnlineInput('');
        await refreshDashboard(false, true);
      });
      return;
    }
    setSearchingOnline(true);
    setStatus({ text: `正在搜索「${trimmed}」…`, tone: 'warn' });
    try {
      const res = await callMusic<{ source: string; candidates: OnlineCandidate[] }>('search-online', {
        query: trimmed,
        source: onlineSource,
        limit: 8,
      }, 45_000);
      if (!mountedRef.current) return;
      const list = res.data?.candidates ?? [];
      setCandidates(list);
      setStatus({
        text: list.length > 0 ? `找到 ${list.length} 个候选音源` : '未搜到匹配曲目，可切换音源或换个关键词',
        tone: list.length > 0 ? 'ok' : 'warn',
      });
    } catch (err) {
      if (mountedRef.current) setStatus({ text: errorText(err), tone: 'err' });
    } finally {
      if (mountedRef.current) setSearchingOnline(false);
    }
  };

  const triggerDownloadCandidate = async (cand: OnlineCandidate, playAfter: boolean) => {
    await runAction(playAfter ? `正在下载并准备播放《${cand.title}》…` : `正在加入后台下载《${cand.title}》…`, async () => {
      const res = await callMusic('download', {
        url: cand.url,
        titleHint: cand.title,
        artistHint: cand.artist,
        source: cand.source,
        playAfter,
        async: true,
      });
      setStatus({ text: res.message || '已开始后台下载', tone: res.ok ? 'ok' : 'err' });
      await refreshDashboard(false, true);
    });
  };

  const saveConfig = async (e: FormEvent) => {
    e.preventDefault();
    const vol = Number(cfgDefaultVolume);
    if (!Number.isFinite(vol) || vol < 0 || vol > 100) {
      setStatus({ text: '默认音量需在 0 ~ 100 之间', tone: 'warn' });
      return;
    }
    await runAction('正在保存音乐插件配置…', async () => {
      const res = await callMusic('config', {
        musicDir: cfgMusicDir.trim(),
        streamBaseUrl: cfgStreamBaseUrl.trim(),
        speakerSsh: cfgSpeakerSsh.trim(),
        defaultVolume: Math.round(vol),
        downloadFormat: cfgFormat,
        defaultSearchSource: cfgSource,
        autoDownloadOnVoiceMiss: cfgAutoMiss,
      });
      if (res.ok) setCfgDirty(false);
      setStatus({ text: res.message || '配置已保存', tone: res.ok ? 'ok' : 'err' });
      await refreshDashboard(false, true);
    });
  };

  const loopMode = data?.loopMode ?? 'list';
  const LoopIcon = loopMode === 'single' ? Repeat1Icon : loopMode === 'shuffle' ? ShuffleIcon : RepeatIcon;
  const curTrack = data?.currentTrack ?? null;
  const isPlaying = data?.status === 'playing';
  const isPaused = data?.status === 'paused';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <MusicIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">音乐点播 · 小爱曲库</h3>
          <Badge variant={isPlaying ? 'success' : isPaused ? 'warning' : 'outline'}>
            {isPlaying ? '播放中' : isPaused ? '已暂停' : '空闲'}
          </Badge>
          <Badge variant="outline">曲库 {data?.trackCount ?? 0} 首</Badge>
          {data?.speaker?.configured ? (
            <Badge variant="outline">LX06 · {data.speaker.userHost}</Badge>
          ) : (
            <Badge variant="warning">未绑定小爱音箱</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void runAction('正在同步小爱播放状态…', async () => {
              await refreshDashboard(true, false);
              setStatus({ text: '已同步音箱状态', tone: 'ok' });
            })}
          >
            <RefreshCwIcon className="size-3.5" />
            <span>同步状态</span>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void runAction('正在扫描本地曲库…', async () => {
              const res = await callMusic('scan', { quick: true });
              setStatus({ text: res.message || '扫描完成', tone: res.ok ? 'ok' : 'err' });
              await refreshDashboard(false, true);
            })}
          >
            <FolderPlusIcon className="size-3.5" />
            <span>扫描曲库</span>
          </Button>
          <Button
            size="xs"
            disabled={uploading || busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon className="size-3.5" />
            <span>{uploading ? '上传中…' : '上传音乐'}</span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".mp3,.flac,.m4a,.wav,.ogg,.opus,.aac,audio/*"
            className="hidden"
            onChange={(ev) => void handleUploadFiles(ev)}
          />
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <CardTitle className="truncate text-sm">
                {curTrack ? curTrack.title : '等待点歌播放'}
              </CardTitle>
              <CardDescription className="truncate text-xs">
                {curTrack
                  ? `${curTrack.artist || '未知歌手'}${curTrack.album ? ` · ${curTrack.album}` : ''} · ${formatDuration(curTrack.durationSec)}`
                  : '选择下方曲目推送小爱音箱 LX06，或语音说“星期五，放首歌”'}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                aria-label="上一首"
                onClick={() => void runAction('切至上一首…', async () => {
                  const res = await callMusic('prev', {});
                  setStatus({ text: res.message || '已切歌', tone: res.ok ? 'ok' : 'err' });
                  await refreshDashboard(false, true);
                })}
              >
                <SkipBackIcon className="size-3.5" />
              </Button>
              {isPlaying ? (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => void runAction('暂停播放…', async () => {
                    const res = await callMusic('pause', {});
                    setStatus({ text: res.message || '已暂停', tone: res.ok ? 'ok' : 'err' });
                    await refreshDashboard(false, true);
                  })}
                >
                  <PauseIcon className="size-3.5" />
                  <span>暂停</span>
                </Button>
              ) : (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => void runAction(isPaused ? '恢复播放…' : '开始播放…', async () => {
                    const res = await callMusic(isPaused ? 'resume' : 'play', isPaused ? {} : { shuffle: false });
                    setStatus({ text: res.message || '已开始播放', tone: res.ok ? 'ok' : 'err' });
                    await refreshDashboard(false, true);
                  })}
                >
                  <PlayIcon className="size-3.5" />
                  <span>{isPaused ? '继续' : '播放'}</span>
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                aria-label="停止播放"
                onClick={() => void runAction('停止播放…', async () => {
                  const res = await callMusic('stop', {});
                  setStatus({ text: res.message || '已停止', tone: res.ok ? 'ok' : 'err' });
                  await refreshDashboard(false, true);
                })}
              >
                <SquareIcon className="size-3.5" />
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                aria-label="下一首"
                onClick={() => void runAction('切至下一首…', async () => {
                  const res = await callMusic('next', {});
                  setStatus({ text: res.message || '已切歌', tone: res.ok ? 'ok' : 'err' });
                  await refreshDashboard(false, true);
                })}
              >
                <SkipForwardIcon className="size-3.5" />
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void runAction('切换循环模式…', async () => {
                  const res = await callMusic('loop', {});
                  setStatus({ text: res.message || '已切换循环模式', tone: res.ok ? 'ok' : 'err' });
                  await refreshDashboard(false, true);
                })}
              >
                <LoopIcon className="size-3.5" />
                <span>{data?.loopLabel ?? '列表循环'}</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-52 flex-1 items-center gap-2.5">
              <Volume2Icon className="size-4 shrink-0 text-muted-foreground" />
              <Slider
                min={0}
                max={100}
                value={volumeDraft}
                getAriaLabel={() => '小爱音箱音量'}
                onValueChange={(val) => {
                  const next = Array.isArray(val) ? val[0] : val;
                  if (typeof next === 'number') {
                    setVolumeDirty(true);
                    setVolumeDraft(next);
                  }
                }}
                onValueCommitted={(val) => {
                  const next = Array.isArray(val) ? val[0] : val;
                  setVolumeDirty(false);
                  if (typeof next === 'number') {
                    void runAction(`调整音量至 ${next}%…`, async () => {
                      const res = await callMusic('volume', { volume: next });
                      setStatus({ text: res.message || '音量已调整', tone: res.ok ? 'ok' : 'err' });
                      await refreshDashboard(false, true);
                    });
                  }
                }}
              />
              <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{volumeDraft}%</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <ClockIcon className="size-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">定时关闭：</span>
              {[15, 30, 60].map(mins => (
                <Button
                  key={mins}
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void runAction(`设置 ${mins} 分钟后停止播放…`, async () => {
                    const res = await callMusic('timer', { minutes: mins });
                    setStatus({ text: res.message || '已设置定时', tone: res.ok ? 'ok' : 'err' });
                    await refreshDashboard(false, true);
                  })}
                >
                  {mins}分
                </Button>
              ))}
              {data?.timerEndsAtMs && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void runAction('取消定时关闭…', async () => {
                    const res = await callMusic('timer', { cancel: true });
                    setStatus({ text: res.message || '已取消定时', tone: res.ok ? 'ok' : 'err' });
                    await refreshDashboard(false, true);
                  })}
                >
                  取消定时
                </Button>
              )}
            </div>
          </div>

          {previewTrack && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
              <HeadphonesIcon className="size-4 text-primary" />
              <span className="max-w-56 truncate text-xs font-medium">{previewTrack.title}</span>
              <audio controls preload="none" src={previewTrack.previewUrl} className="h-8 min-w-52 flex-1" />
              <Button size="xs" variant="ghost" onClick={() => setPreviewTrack(null)}>收起试听</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTab value="library">曲库 ({data?.trackCount ?? 0})</TabsTab>
          <TabsTab value="online">搜歌下载</TabsTab>
          <TabsTab value="playlists">队列与歌单</TabsTab>
          <TabsTab value="config">设置</TabsTab>
        </TabsList>

        <TabsPanel value="library" className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Input
                value={libQuery}
                onChange={(ev) => setLibQuery(ev.target.value)}
                placeholder="筛选歌名、歌手、专辑或文件名…"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="xs"
                variant={selectedPlaylistId === 'all' ? 'default' : 'outline'}
                onClick={() => setSelectedPlaylistId('all')}
              >
                全部
              </Button>
              {(data?.playlists ?? []).map(pl => (
                <Button
                  key={pl.id}
                  size="xs"
                  variant={selectedPlaylistId === pl.id ? 'default' : 'outline'}
                  onClick={() => setSelectedPlaylistId(pl.id)}
                >
                  {pl.name} ({pl.trackIds.length})
                </Button>
              ))}
            </div>
          </div>

          {visibleTracks.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-xs text-muted-foreground">
                当前筛选下暂无曲目。可点击右上角「上传音乐」，或切换到「搜歌下载」标签按歌名/链接下载到本地。
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-1.5">
              {visibleTracks.map(track => {
                const isFav = favoritesSet.has(track.id);
                const isCur = curTrack?.id === track.id;
                const chosenPl = addTargetByTrack[track.id] || customPlaylists[0]?.id || '';
                return (
                  <div
                    key={track.id}
                    className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${isCur ? 'border-primary/50 bg-primary/5' : 'bg-card'}`}
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{track.title}</span>
                        <Badge variant="outline" className="text-[10px]">{track.ext.replace('.', '').toUpperCase()}</Badge>
                        {isCur && isPlaying && <Badge variant="success" className="text-[10px]">正在播放</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {track.artist || '未知歌手'}
                        {track.album ? ` · ${track.album}` : ''}
                        {' · '}
                        {formatDuration(track.durationSec)}
                        {' · '}
                        {formatBytes(track.sizeBytes)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => void runAction(`在小爱音箱播放《${track.title}》…`, async () => {
                          const res = await callMusic('play', {
                            trackId: track.id,
                            ...(selectedPlaylistId !== 'all' ? { playlistId: selectedPlaylistId } : {}),
                          });
                          setStatus({ text: res.message || '开始播放', tone: res.ok ? 'ok' : 'err' });
                          await refreshDashboard(false, true);
                        })}
                      >
                        <PlayIcon className="size-3.5" />
                        <span>音箱播</span>
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setPreviewTrack(track)}
                      >
                        <HeadphonesIcon className="size-3.5" />
                        <span>试听</span>
                      </Button>
                      <Button
                        size="xs"
                        variant={isFav ? 'secondary' : 'outline'}
                        disabled={busy}
                        aria-label={isFav ? '取消收藏' : '收藏'}
                        onClick={() => void runAction('更新收藏…', async () => {
                          const res = await callMusic('playlist', { op: 'toggle-favorite', trackId: track.id });
                          setStatus({ text: res.message || '已更新收藏', tone: res.ok ? 'ok' : 'err' });
                          await refreshDashboard(false, true);
                        })}
                      >
                        <HeartIcon className={`size-3.5 ${isFav ? 'fill-current text-rose-500' : ''}`} />
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        aria-label="加入队列"
                        onClick={() => void runAction(`加入队列《${track.title}》…`, async () => {
                          const res = await callMusic('queue', { op: 'add', trackId: track.id });
                          setStatus({ text: res.message || '已加入队列', tone: res.ok ? 'ok' : 'err' });
                          await refreshDashboard(false, true);
                        })}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                      {customPlaylists.length > 0 && chosenPl && (
                        <div className="flex items-center gap-1">
                          <select
                            aria-label={`选择将 ${track.title} 加入的歌单`}
                            value={chosenPl}
                            onChange={(ev) => setAddTargetByTrack(prev => ({ ...prev, [track.id]: ev.target.value }))}
                            className="h-7 rounded-md border bg-background px-1.5 text-xs"
                          >
                            {customPlaylists.map(pl => (
                              <option key={pl.id} value={pl.id}>{pl.name}</option>
                            ))}
                          </select>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void runAction('加入歌单…', async () => {
                              const res = await callMusic('playlist', { op: 'add-track', playlistId: chosenPl, trackId: track.id });
                              setStatus({ text: res.message || '已加入歌单', tone: res.ok ? 'ok' : 'err' });
                              await refreshDashboard(false, true);
                            })}
                          >
                            入单
                          </Button>
                        </div>
                      )}
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`删除 ${track.title}`}
                        onClick={() => setDelTrackTarget(track)}
                      >
                        <Trash2Icon className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsPanel>

        <TabsPanel value="online" className="space-y-3 pt-2">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">在线搜歌与链接下载</CardTitle>
                  <CardDescription className="text-xs">
                    支持输入歌名/歌手关键词搜索，或直接粘贴 YouTube / Bilibili / 音频直链下载到 {data?.config?.musicDir || '/mnt/data/music'}
                  </CardDescription>
                </div>
                <Badge variant={data?.ytDlpAvailable ? 'success' : 'warning'}>
                  {data?.ytDlpAvailable ? 'yt-dlp 就绪' : '未检测到 yt-dlp'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <form onSubmit={(ev) => void handleOnlineSearchOrDownload(ev)} className="flex flex-wrap items-center gap-2">
                <Input
                  value={onlineInput}
                  onChange={(ev) => setOnlineInput(ev.target.value)}
                  placeholder="输入歌名（如：晴天 周杰伦）或粘贴视频/音频链接…"
                  className="min-w-60 flex-1"
                />
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant={onlineSource === 'youtube' ? 'default' : 'outline'}
                    onClick={() => setOnlineSource('youtube')}
                  >
                    YouTube
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={onlineSource === 'bilibili' ? 'default' : 'outline'}
                    onClick={() => setOnlineSource('bilibili')}
                  >
                    Bilibili
                  </Button>
                </div>
                <Button type="submit" size="sm" disabled={searchingOnline || busy || !onlineInput.trim()}>
                  {searchingOnline ? <Spinner className="size-3.5" /> : <SearchIcon className="size-3.5" />}
                  <span>{/^https?:\/\//i.test(onlineInput.trim()) ? '直接下载' : '搜索音源'}</span>
                </Button>
              </form>

              {candidates.length > 0 && (
                <div className="space-y-1.5">
                  {candidates.map(cand => (
                    <div key={`${cand.source}:${cand.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{cand.title}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {cand.source === 'bilibili' ? 'B站' : 'YouTube'}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {cand.artist || '未知作者'} · {formatDuration(cand.durationSec)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void triggerDownloadCandidate(cand, false)}>
                          <DownloadIcon className="size-3.5" />
                          <span>下载入库</span>
                        </Button>
                        <Button size="xs" disabled={busy} onClick={() => void triggerDownloadCandidate(cand, true)}>
                          <PlayIcon className="size-3.5" />
                          <span>下载并播</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(data?.downloads?.length ?? 0) > 0 && (
                <div className="space-y-1.5 pt-2">
                  <div className="text-xs font-medium text-muted-foreground">最近下载任务</div>
                  {(data?.downloads ?? []).slice(0, 8).map(job => (
                    <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                      <div className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{job.title}</span>
                        {job.error && <span className="ml-2 text-destructive">{job.error}</span>}
                      </div>
                      <Badge variant={job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : 'warning'}>
                        {job.status === 'done' ? '已完成' : job.status === 'error' ? '失败' : '下载中'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="playlists" className="space-y-3 pt-2">
          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ListMusicIcon className="size-4 text-primary" />
                    <CardTitle className="text-sm">当前播放队列 ({data?.queue?.length ?? 0})</CardTitle>
                  </div>
                  {(data?.queue?.length ?? 0) > 0 && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void runAction('清空播放队列…', async () => {
                        const res = await callMusic('queue', { op: 'clear' });
                        setStatus({ text: res.message || '队列已清空', tone: res.ok ? 'ok' : 'err' });
                        await refreshDashboard(false, true);
                      })}
                    >
                      清空
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {(data?.queue?.length ?? 0) === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">队列为空</p>
                ) : (
                  (data?.queue ?? []).map((item, idx) => (
                    <div
                      key={`${item.id}-${idx}`}
                      className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs ${idx === data?.queueIndex ? 'border-primary/50 bg-primary/5' : ''}`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {idx + 1}. {item.title}{item.artist ? ` - ${item.artist}` : ''}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void runAction(`播放《${item.title}》…`, async () => {
                            const res = await callMusic('play', { index: idx });
                            setStatus({ text: res.message || '开始播放', tone: res.ok ? 'ok' : 'err' });
                            await refreshDashboard(false, true);
                          })}
                        >
                          <PlayIcon className="size-3" />
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void runAction('移出队列…', async () => {
                            await callMusic('queue', { op: 'remove', trackId: item.id });
                            await refreshDashboard(false, true);
                          })}
                        >
                          <Trash2Icon className="size-3" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">歌单管理</CardTitle>
                <CardDescription className="text-xs">创建自建歌单并一键在 LX06 上连续播放</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <form
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    if (!newPlaylistName.trim()) return;
                    void runAction('创建歌单…', async () => {
                      const res = await callMusic('playlist', { op: 'create', name: newPlaylistName.trim() });
                      setStatus({ text: res.message || '歌单创建完成', tone: res.ok ? 'ok' : 'err' });
                      if (res.ok) setNewPlaylistName('');
                      await refreshDashboard(false, true);
                    });
                  }}
                  className="flex items-center gap-2"
                >
                  <Input
                    value={newPlaylistName}
                    onChange={(ev) => setNewPlaylistName(ev.target.value)}
                    placeholder="新歌单名称…"
                    className="flex-1"
                  />
                  <Button type="submit" size="xs" disabled={busy || !newPlaylistName.trim()}>创建</Button>
                </form>
                <div className="space-y-1.5">
                  {(data?.playlists ?? []).map(pl => (
                    <div key={pl.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                      <div className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{pl.name}</span>
                        <span className="ml-2 text-muted-foreground">{pl.trackIds.length} 首</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy || pl.trackIds.length === 0}
                          onClick={() => void runAction(`播放歌单「${pl.name}」…`, async () => {
                            const res = await callMusic('play', { playlistId: pl.id });
                            setStatus({ text: res.message || '开始播放歌单', tone: res.ok ? 'ok' : 'err' });
                            await refreshDashboard(false, true);
                          })}
                        >
                          <PlayIcon className="size-3" />
                          <span>播放</span>
                        </Button>
                        {!pl.builtin && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void runAction(`删除歌单「${pl.name}」…`, async () => {
                              const res = await callMusic('playlist', { op: 'delete', playlistId: pl.id });
                              setStatus({ text: res.message || '已删除歌单', tone: res.ok ? 'ok' : 'err' });
                              await refreshDashboard(false, true);
                            })}
                          >
                            <Trash2Icon className="size-3 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsPanel>

        <TabsPanel value="config" className="pt-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">曲库与音箱参数配置</CardTitle>
              <CardDescription className="text-xs">
                推流地址留空时自动检测主机局域网 IP:3210；音箱 SSH 留空时自动复用已绑定的 LX06 通道。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(ev) => void saveConfig(ev)} className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="music-cfg-dir" className="text-xs">音乐曲库目录</Label>
                    <Input
                      id="music-cfg-dir"
                      value={cfgMusicDir}
                      onChange={(ev) => { setCfgDirty(true); setCfgMusicDir(ev.target.value); }}
                      placeholder="/mnt/data/music"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="music-cfg-stream" className="text-xs">局域网流地址（可选）</Label>
                    <Input
                      id="music-cfg-stream"
                      value={cfgStreamBaseUrl}
                      onChange={(ev) => { setCfgDirty(true); setCfgStreamBaseUrl(ev.target.value); }}
                      placeholder={data?.streamBaseUrl || 'http://192.168.31.124:3210'}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="music-cfg-ssh" className="text-xs">小爱音箱 SSH（可选覆盖）</Label>
                    <Input
                      id="music-cfg-ssh"
                      value={cfgSpeakerSsh}
                      onChange={(ev) => { setCfgDirty(true); setCfgSpeakerSsh(ev.target.value); }}
                      placeholder="lx06=root@192.168.31.104"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="music-cfg-vol" className="text-xs">默认音量（0 ~ 100）</Label>
                    <Input
                      id="music-cfg-vol"
                      type="number"
                      min={0}
                      max={100}
                      value={cfgDefaultVolume}
                      onChange={(ev) => { setCfgDirty(true); setCfgDefaultVolume(ev.target.value); }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="music-cfg-fmt" className="text-xs">下载音频格式</Label>
                    <select
                      id="music-cfg-fmt"
                      value={cfgFormat}
                      onChange={(ev) => { setCfgDirty(true); setCfgFormat(ev.target.value === 'm4a' ? 'm4a' : 'mp3'); }}
                      className="h-9 w-full rounded-md border bg-background px-2.5 text-sm"
                    >
                      <option value="mp3">MP3（通用兼容）</option>
                      <option value="m4a">M4A（AAC）</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="music-cfg-src" className="text-xs">默认在线搜索源</Label>
                    <select
                      id="music-cfg-src"
                      value={cfgSource}
                      onChange={(ev) => { setCfgDirty(true); setCfgSource(ev.target.value === 'bilibili' ? 'bilibili' : 'youtube'); }}
                      className="h-9 w-full rounded-md border bg-background px-2.5 text-sm"
                    >
                      <option value="youtube">YouTube / YouTube Music</option>
                      <option value="bilibili">Bilibili</option>
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={cfgAutoMiss}
                    onCheckedChange={(checked) => { setCfgDirty(true); setCfgAutoMiss(Boolean(checked)); }}
                  />
                  <span>语音点歌本地未找到时，转交 AI 自动搜索下载并播放</span>
                </label>

                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy}>保存配置</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      <ConfirmActionDialog
        open={Boolean(delTrackTarget)}
        onOpenChange={(open) => { if (!open) setDelTrackTarget(null); }}
        title="删除本地曲目"
        description={delTrackTarget ? `确认从磁盘永久删除《${delTrackTarget.title}》？此操作不可撤销。` : ''}
        busy={busy}
        onConfirm={async () => {
          if (!delTrackTarget) return;
          const target = delTrackTarget;
          setDelTrackTarget(null);
          await runAction(`正在删除《${target.title}》…`, async () => {
            const res = await callMusic('delete-track', { trackId: target.id });
            setStatus({ text: res.message || '已删除', tone: res.ok ? 'ok' : 'err' });
            await refreshDashboard(false, true);
          });
        }}
      />
    </div>
  );
}
