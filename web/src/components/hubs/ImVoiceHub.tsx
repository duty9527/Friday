import type {
  ImChannelView,
  TelegramQuickConnectView,
  TelegramSyncCommandsView,
  VoiceprintProfileView,
  VoiceprintStatusView,
  WechatQrLoginSession,
} from '@friday/view.js';
import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  CheckCircle2Icon,
  CopyIcon,
  MicIcon,
  PlusIcon,
  QrCodeIcon,
  RadioIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserPlusIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { isSafeHttpUrl, isSafePreviewImageUrl } from '@/components/shared/safeUrl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { useFriday } from '@/lib/friday-store';

const PLATFORM_LABELS: Record<string, string> = {
  wechat: '微信',
  telegram: 'Telegram',
  dingtalk: '钉钉',
  xiaoai: '小爱音箱',
};

export function ImVoiceHub() {
  const { view, ready, authExpired, api, refreshView } = useFriday();
  const channels = view?.imChannels ?? [];
  const [tab, setTab] = useState<'im' | 'voice'>('im');

  // WeChat QR state
  const [qrSession, setQrSession] = useState<WechatQrLoginSession | null>(null);
  const [qrStatusText, setQrStatusText] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrSeqRef = useRef(0);

  // Telegram quick connect
  const [tgToken, setTgToken] = useState('');
  const [tgAllow, setTgAllow] = useState('');
  const [tgStatus, setTgStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [tgBusy, setTgBusy] = useState(false);

  // Channel Editor
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<'wechat' | 'telegram' | 'dingtalk' | 'xiaoai'>('wechat');
  const [chName, setChName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [botToken, setBotToken] = useState('');
  const [secret, setSecret] = useState('');
  const [defaultTarget, setDefaultTarget] = useState('');
  const [accountId, setAccountId] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [allowedSenders, setAllowedSenders] = useState('');
  const [readLinks, setReadLinks] = useState(true);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState('23:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [imErr, setImErr] = useState('');
  const [imBusy, setImBusy] = useState(false);
  const [deleteChannel, setDeleteChannel] = useState<ImChannelView | null>(null);

  // Voiceprints
  const [voiceStatus, setVoiceStatus] = useState<VoiceprintStatusView | null>(view?.voiceprint ?? null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState('');
  const [deleteProfile, setDeleteProfile] = useState<VoiceprintProfileView | null>(null);
  const [clearAllVoice, setClearAllVoice] = useState(false);

  const stopQrPoll = useCallback(() => {
    qrSeqRef.current += 1;
    if (qrTimerRef.current) {
      clearInterval(qrTimerRef.current);
      qrTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopQrPoll();
  }, [stopQrPoll]);

  const loadVoiceprints = useCallback(async () => {
    if (!ready || authExpired) return;
    try {
      const vp = await api<VoiceprintStatusView>('/api/voiceprints');
      setVoiceStatus(vp);
    } catch {
      // ignore
    }
  }, [api, authExpired, ready]);

  useEffect(() => {
    if (tab === 'voice') void loadVoiceprints();
  }, [loadVoiceprints, tab]);

  const startQrPoll = (sessionId: string, seq: number) => {
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    qrTimerRef.current = setInterval(async () => {
      if (seq !== qrSeqRef.current || document.hidden) return;
      try {
        const res = await api<WechatQrLoginSession>('/api/im-wechat-qr-status', { sessionId }, { priority: 'low' });
        if (seq !== qrSeqRef.current) return;
        setQrSession(res);
        if (res.status === 'scaned') {
          setQrStatusText('📱 已扫码，请在手机微信上点击确认登录…');
        } else if (res.status === 'verify_code') {
          stopQrPoll();
          setQrStatusText('🔐 微信要求输入手机端显示的验证码：');
        } else if (res.status === 'confirmed') {
          stopQrPoll();
          setQrStatusText(`✅ 微信绑定成功：${res.userId ?? res.accountId ?? res.channelName}`);
          await refreshView();
        } else if (res.status === 'expired' || res.status === 'error') {
          stopQrPoll();
          setQrStatusText(`⚠️ ${res.error ?? '二维码已过期，请重新生成'}`);
        }
      } catch (e) {
        if (seq === qrSeqRef.current) setQrStatusText(`轮询异常：${errorText(e)}`);
      }
    }, 2000);
  };

  const startWechatQr = async (channelId?: string, channelName?: string, newAccount = false) => {
    if (!ready || authExpired) return;
    stopQrPoll();
    const seq = ++qrSeqRef.current;
    setQrBusy(true);
    setQrStatusText('⏳ 正在申请微信登录二维码…');
    try {
      const session = await api<WechatQrLoginSession>('/api/im-wechat-qr-start', {
        ...(channelId ? { id: channelId } : {}),
        ...(channelName ? { name: channelName } : {}),
        ...(newAccount ? { newAccount: true } : {}),
      });
      if (seq !== qrSeqRef.current) return;
      setQrSession(session);
      setQrStatusText('📱 请使用微信扫码绑定 F.R.I.D.A.Y.…');
      await refreshView();
      startQrPoll(session.sessionId, seq);
    } catch (e) {
      setQrStatusText(`获取二维码失败：${errorText(e)}`);
    } finally {
      setQrBusy(false);
    }
  };

  const submitQrVerifyCode = async () => {
    if (!qrSession || !verifyCode.trim()) return;
    const seq = ++qrSeqRef.current;
    setQrBusy(true);
    try {
      const res = await api<WechatQrLoginSession>('/api/im-wechat-qr-status', {
        sessionId: qrSession.sessionId,
        verifyCode: verifyCode.trim(),
      });
      setVerifyCode('');
      setQrSession(res);
      if (res.status === 'confirmed') {
        setQrStatusText(`✅ 微信绑定成功：${res.userId ?? res.accountId ?? res.channelName}`);
        await refreshView();
      } else {
        setQrStatusText('⏳ 验证码已提交，等待手机端确认…');
        startQrPoll(res.sessionId, seq);
      }
    } catch (e) {
      setQrStatusText(`验证码提交失败：${errorText(e)}`);
    } finally {
      setQrBusy(false);
    }
  };

  const quickConnectTelegram = async () => {
    const token = tgToken.trim();
    if (!token) {
      setTgStatus({ ok: false, text: '请先输入 @BotFather 获取的 Bot Token' });
      return;
    }
    setTgBusy(true);
    setTgStatus(null);
    try {
      const allowed = tgAllow.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      const res = await api<TelegramQuickConnectView>('/api/im-telegram-quick', {
        botToken: token,
        ...(allowed.length ? { allowedSenders: allowed } : {}),
      });
      setTgToken('');
      setTgAllow('');
      const label = res.bot.username ? `@${res.bot.username}` : res.bot.firstName;
      setTgStatus({
        ok: true,
        text: `已接入 ${label}，${res.commandsRegistered ? '命令菜单已同步' : '命令同步异常可稍后重试'}`,
      });
      await refreshView();
    } catch (e) {
      setTgStatus({ ok: false, text: errorText(e) });
    } finally {
      setTgBusy(false);
    }
  };

  const openEditChannel = (ch: ImChannelView) => {
    setEditingId(ch.id);
    setPlatform(ch.platform);
    setChName(ch.name);
    setWebhookUrl('');
    setBotToken('');
    setSecret('');
    setDefaultTarget(ch.defaultTarget ?? '');
    setAccountId(ch.accountId ?? '');
    setApiBase(ch.apiBase ?? '');
    setAllowedSenders(ch.allowedSenders.join(', '));
    setReadLinks(ch.readLinks !== false);
    setQuietEnabled(Boolean(ch.quietHours?.enabled));
    setQuietStart(ch.quietHours?.start ?? '23:00');
    setQuietEnd(ch.quietHours?.end ?? '07:00');
    setImErr('');
    setShowEditor(true);
  };

  const resetChannelEditor = () => {
    setEditingId(null);
    setChName('');
    setWebhookUrl('');
    setBotToken('');
    setSecret('');
    setDefaultTarget('');
    setAccountId('');
    setApiBase('');
    setAllowedSenders('');
    setReadLinks(true);
    setQuietEnabled(false);
    setQuietStart('23:00');
    setQuietEnd('07:00');
    setImErr('');
    setShowEditor(false);
  };

  const saveChannel = async () => {
    if (webhookUrl.trim() && !isSafeHttpUrl(webhookUrl.trim())) {
      setImErr('Webhook URL 须以 http:// 或 https:// 开头');
      return;
    }
    if ((platform === 'wechat' || editingId) && quietEnabled && (!/^\d{2}:\d{2}$/.test(quietStart) || !/^\d{2}:\d{2}$/.test(quietEnd))) {
      setImErr('免打扰时间格式应为 HH:mm');
      return;
    }
    setImBusy(true);
    setImErr('');
    try {
      const senders = allowedSenders.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      await api<ImChannelView>('/api/im-save', {
        ...(editingId ? { id: editingId } : {}),
        platform,
        name: chName.trim() || `${PLATFORM_LABELS[platform] ?? platform}助手`,
        ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}),
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(editingId || defaultTarget.trim() ? { defaultTarget: defaultTarget.trim() } : {}),
        ...(editingId || accountId.trim() ? { accountId: accountId.trim() } : {}),
        ...(editingId || apiBase.trim() ? { apiBase: apiBase.trim() } : {}),
        ...(editingId || senders.length ? { allowedSenders: senders } : {}),
        ...(platform === 'wechat' || editingId
          ? { readLinks, quietHours: { enabled: quietEnabled, start: quietStart, end: quietEnd } }
          : {}),
      });
      resetChannelEditor();
      await refreshView();
    } catch (e) {
      setImErr(errorText(e));
    } finally {
      setImBusy(false);
    }
  };

  const disabled = !ready || authExpired;
  const vp = voiceStatus ?? view?.voiceprint;

  return (
    <Tabs value={tab} onValueChange={v => setTab(v as 'im' | 'voice')}>
      <TabsList activateOnFocus>
        <TabsTab value="im">IM 渠道 ({channels.length})</TabsTab>
        <TabsTab value="voice">小爱声纹门禁 ({vp?.profiles.length ?? 0})</TabsTab>
      </TabsList>

      <TabsPanel value="im" className="mt-3 space-y-4">
        {/* Quick Connect Cards */}
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <QrCodeIcon className="size-4 text-success-foreground" />
                <span>微信扫码绑定</span>
              </CardTitle>
              <CardDescription className="text-xs">支持个人微信收发图文/文件与多账号绑定</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5">
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" disabled={disabled || qrBusy} onClick={() => void startWechatQr()}>
                  <QrCodeIcon className="size-3.5" />
                  <span>生成微信二维码</span>
                </Button>
                <Button size="xs" variant="outline" disabled={disabled || qrBusy} onClick={() => void startWechatQr(undefined, undefined, true)}>
                  <PlusIcon className="size-3.5" />
                  <span>新增微信账号</span>
                </Button>
              </div>
              {qrSession && (
                <div className="rounded-lg border bg-muted/25 p-3 space-y-2 text-xs">
                  {isSafePreviewImageUrl(qrSession.qrSvgDataUrl) && (
                    <div className="flex justify-center rounded bg-white p-2">
                      <img src={qrSession.qrSvgDataUrl} alt="微信登录二维码" className="size-36" />
                    </div>
                  )}
                  <p>{qrStatusText}</p>
                  {qrSession.qrcodeContent && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void navigator.clipboard?.writeText(qrSession.qrcodeContent)}
                    >
                      <CopyIcon className="size-3" />
                      <span>复制二维码链接</span>
                    </Button>
                  )}
                  {qrSession.status === 'verify_code' && (
                    <div className="flex gap-1.5">
                      <Input size="sm" placeholder="输入手机验证码" value={verifyCode} onChange={e => setVerifyCode(e.target.value)} />
                      <Button size="xs" disabled={qrBusy} onClick={() => void submitQrVerifyCode()}>提交</Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <SendIcon className="size-4 text-info-foreground" />
                <span>Telegram 一键接入</span>
              </CardTitle>
              <CardDescription className="text-xs">校验 Token、自动同步 Slash 命令并开启长轮询</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input
                id="im-tg-token-input"
                size="sm"
                type="password"
                disabled={disabled || tgBusy}
                placeholder="Bot Token (来自 @BotFather)"
                value={tgToken}
                onChange={e => setTgToken(e.target.value)}
              />
              <Input
                id="im-tg-allow-input"
                size="sm"
                disabled={disabled || tgBusy}
                placeholder="允许发送者 ID（逗号分隔，可选）"
                value={tgAllow}
                onChange={e => setTgAllow(e.target.value)}
              />
              <Button id="im-tg-quick-btn" size="xs" disabled={disabled || tgBusy} onClick={() => void quickConnectTelegram()}>
                一键校验并接入
              </Button>
              {tgStatus && (
                <p id="im-tg-quick-status" className={`text-xs ${tgStatus.ok ? 'text-success-foreground' : 'text-destructive-foreground'}`}>
                  {tgStatus.text}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Manual Channel Editor Toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">已配置通道 ({channels.length})</span>
          <Button size="xs" variant="outline" onClick={() => { resetChannelEditor(); setShowEditor(v => !v); }}>
            <PlusIcon className="size-3.5" />
            <span>手动配置通道</span>
          </Button>
        </div>

        {showEditor && (
          <Card>
            <CardContent className="pt-4 space-y-2.5 text-xs">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">平台类型</Label>
                  <select
                    value={platform}
                    disabled={Boolean(editingId)}
                    onChange={e => setPlatform(e.target.value as typeof platform)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="wechat">微信</option>
                    <option value="telegram">Telegram</option>
                    <option value="dingtalk">钉钉</option>
                    <option value="xiaoai">小爱音箱</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">通道名称</Label>
                  <Input size="sm" value={chName} onChange={e => setChName(e.target.value)} placeholder="如：主力微信" />
                </div>
                <Input size="sm" type="password" placeholder="Bot Token（留空保持）" value={botToken} onChange={e => setBotToken(e.target.value)} />
                <Input size="sm" type="password" placeholder="Secret / 密钥（留空保持）" value={secret} onChange={e => setSecret(e.target.value)} />
                <Input size="sm" placeholder="Webhook URL (可选)" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} />
                <Input size="sm" placeholder="白名单发送者 ID（逗号分隔）" value={allowedSenders} onChange={e => setAllowedSenders(e.target.value)} />
                <Input size="sm" placeholder="默认目标 ID (defaultTarget)" value={defaultTarget} onChange={e => setDefaultTarget(e.target.value)} />
                <Input size="sm" placeholder="自定义 API Base (可选)" value={apiBase} onChange={e => setApiBase(e.target.value)} />
              </div>

              {(platform === 'wechat' || editingId) && (
                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox checked={readLinks} onCheckedChange={v => setReadLinks(Boolean(v))} />
                    <span>自动解析微信文章链接</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <Checkbox checked={quietEnabled} onCheckedChange={v => setQuietEnabled(Boolean(v))} />
                    <span>免打扰时段</span>
                  </label>
                  {quietEnabled && (
                    <div className="flex items-center gap-1">
                      <Input size="sm" className="w-20 font-mono" value={quietStart} onChange={e => setQuietStart(e.target.value)} />
                      <span>-</span>
                      <Input size="sm" className="w-20 font-mono" value={quietEnd} onChange={e => setQuietEnd(e.target.value)} />
                    </div>
                  )}
                </div>
              )}

              {imErr && <p className="text-destructive-foreground">{imErr}</p>}
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="ghost" onClick={resetChannelEditor}>取消</Button>
                <Button size="xs" disabled={disabled || imBusy} onClick={() => void saveChannel()}>
                  {editingId ? '更新通道' : '保存通道'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Channel Cards */}
        <div className="space-y-2">
          {channels.map(ch => (
            <div key={ch.id} className="rounded-xl border bg-card p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <RadioIcon className="size-3.5 text-muted-foreground" />
                  <span className="font-semibold text-sm text-foreground">{ch.name}</span>
                  <Badge size="sm" variant="outline">{PLATFORM_LABELS[ch.platform] ?? ch.platform}</Badge>
                  <Badge size="sm" variant={ch.enabled ? 'success' : 'secondary'}>
                    {ch.enabled ? '已启用' : '已停用'}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={async () => {
                      await api('/api/im-test', { id: ch.id }).catch(e => setImErr(errorText(e)));
                      await refreshView();
                    }}
                  >
                    自检
                  </Button>
                  {ch.platform === 'telegram' && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={async () => {
                        await api<TelegramSyncCommandsView>('/api/im-telegram-sync', { id: ch.id }).catch(e => setImErr(errorText(e)));
                        await refreshView();
                      }}
                    >
                      同步命令
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" disabled={disabled} onClick={() => openEditChannel(ch)}>编辑</Button>
                  <Switch
                    checked={ch.enabled}
                    disabled={disabled}
                    onCheckedChange={async next => {
                      await api('/api/im-toggle', { id: ch.id, enabled: next }).catch(e => setImErr(errorText(e)));
                      await refreshView();
                    }}
                  />
                  <Button size="icon-xs" variant="ghost" disabled={disabled} onClick={() => setDeleteChannel(ch)}>
                    <Trash2Icon className="size-3.5 text-destructive-foreground" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span>入站 {ch.inboundCount} / 出站 {ch.outboundCount}</span>
                {ch.accountId && <span>· 账号 {ch.accountId}</span>}
                {ch.allowedSenders.length > 0 && <span>· 白名单 {ch.allowedSenders.length} 人</span>}
                {ch.lastError && <span className="text-destructive-foreground">· 异常：{ch.lastError}</span>}
              </div>

              {ch.rejectedSenders && ch.rejectedSenders.length > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning/8 p-2 space-y-1.5">
                  <div className="font-medium text-warning-foreground">近期拦截的陌生发送者</div>
                  {ch.rejectedSenders.map(stranger => (
                    <div key={stranger.senderId} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="truncate">
                        {stranger.senderName || stranger.senderId} ({stranger.count}次) {stranger.lastText ? `· "${stranger.lastText.slice(0, 30)}"` : ''}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={async () => {
                            await api('/api/im-allow-sender', { id: ch.id, senderId: stranger.senderId });
                            await refreshView();
                          }}
                        >
                          <UserPlusIcon className="size-3" />
                          <span>加白</span>
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={async () => {
                            await api('/api/im-dismiss-stranger', { id: ch.id, senderId: stranger.senderId });
                            await refreshView();
                          }}
                        >
                          忽略
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </TabsPanel>

      <TabsPanel value="voice" className="mt-3 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheckIcon className="size-4" />
                <span>本地声纹门禁</span>
              </CardTitle>
              <div className="flex items-center gap-2 text-xs">
                <span>{vp?.enabled ? '门禁已启用' : '门禁已暂停'}</span>
                <Switch
                  checked={Boolean(vp?.enabled)}
                  disabled={disabled || voiceBusy}
                  onCheckedChange={async next => {
                    setVoiceBusy(true);
                    try {
                      const updated = await api<VoiceprintStatusView>('/api/voice-config', { enabled: next });
                      setVoiceStatus(updated);
                      setVoiceMsg(next ? '已启用声纹防串音门控' : '已暂停声纹防串音门控');
                      await refreshView();
                    } catch (e) {
                      setVoiceMsg(errorText(e));
                    } finally {
                      setVoiceBusy(false);
                    }
                  }}
                />
              </div>
            </div>
            <CardDescription className="text-xs">
              模型状态：{vp?.modelReady ? '声纹模型已就绪' : '未加载'} · 门限 {vp?.threshold ?? '—'} · 唤醒前检 {vp?.wakePrecheck ? '开启' : '关闭'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" disabled={disabled || voiceBusy} onClick={() => void loadVoiceprints()}>
                <RefreshCwIcon className="size-3" />
                <span>刷新声纹</span>
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={disabled || voiceBusy || !(vp?.profiles.length)}
                onClick={() => setClearAllVoice(true)}
              >
                <Trash2Icon className="size-3" />
                <span>清空全部声纹</span>
              </Button>
            </div>
            {voiceMsg && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2Icon className="size-3.5 text-success-foreground" />
                <span>{voiceMsg}</span>
              </p>
            )}
            <div className="space-y-1.5">
              {!vp?.profiles.length ? (
                <p className="text-xs text-muted-foreground">尚未录入声纹档案，可通过小爱音箱说「你好星期五，录入我的声纹」。</p>
              ) : (
                vp.profiles.map(p => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border bg-background px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <MicIcon className="size-3.5 text-muted-foreground" />
                      <span className="font-medium">{p.name}</span>
                      <Badge size="sm" variant={p.role === 'owner' ? 'warning' : 'secondary'}>
                        {p.role === 'owner' ? '机主' : '家庭成员'}
                      </Badge>
                      <span className="text-muted-foreground">样本 {p.sampleCount} · {timestamp(p.updatedAt)}</span>
                    </div>
                    <Button size="icon-xs" variant="ghost" disabled={disabled || voiceBusy} onClick={() => setDeleteProfile(p)}>
                      <Trash2Icon className="size-3.5 text-destructive-foreground" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </TabsPanel>

      <ConfirmActionDialog
        open={Boolean(deleteChannel)}
        onOpenChange={o => { if (!o) setDeleteChannel(null); }}
        title="删除 IM 通道"
        description={`确定要删除通道「${deleteChannel?.name ?? ''}」及其保存的凭据吗？`}
        busy={imBusy}
        onConfirm={async () => {
          if (!deleteChannel) return;
          setImBusy(true);
          try {
            await api('/api/im-remove', { id: deleteChannel.id });
            if (editingId === deleteChannel.id) resetChannelEditor();
            setDeleteChannel(null);
            await refreshView();
          } finally {
            setImBusy(false);
          }
        }}
      />

      <ConfirmActionDialog
        open={Boolean(deleteProfile)}
        onOpenChange={o => { if (!o) setDeleteProfile(null); }}
        title="删除声纹档案"
        description={`确定要删除「${deleteProfile?.name ?? ''}」的声纹档案吗？`}
        busy={voiceBusy}
        onConfirm={async () => {
          if (!deleteProfile) return;
          setVoiceBusy(true);
          try {
            await api('/api/voice-remove', { target: deleteProfile.id });
            setDeleteProfile(null);
            await loadVoiceprints();
            await refreshView();
          } finally {
            setVoiceBusy(false);
          }
        }}
      />

      <ConfirmActionDialog
        open={clearAllVoice}
        onOpenChange={setClearAllVoice}
        title="清空全部声纹档案"
        description="确定要清空所有已录入的声纹档案吗？此操作无法撤销。"
        confirmLabel="确认清空"
        busy={voiceBusy}
        onConfirm={async () => {
          setVoiceBusy(true);
          try {
            await api('/api/voice-clear', {});
            setClearAllVoice(false);
            await loadVoiceprints();
            await refreshView();
          } finally {
            setVoiceBusy(false);
          }
        }}
      />
    </Tabs>
  );
}
