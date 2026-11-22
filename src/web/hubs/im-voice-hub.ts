import type {
  ImChannelView,
  TelegramQuickConnectView,
  TelegramSyncCommandsView,
  VoiceprintStatusView,
  WechatQrLoginSession,
} from '../../view.js';
import { button, element, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import {
  ensureInlineFormError,
  isDocumentHidden,
  replaceChildrenPreservingFocus,
  setInlineFormError,
  wireHubForm,
} from '../shared/plugin-catalog.js';
import {
  announceStatus,
  bindDialogLightDismiss,
  closeModalDialog,
  confirmAction,
  copyTextWithFeedback,
  isDialogOpen,
  isImeComposing,
  openModalDialog,
  safeFocus,
} from '../shared/ui-primitives.js';
import { api, appState, hooks } from '../state.js';

export interface ImVoiceHubController {
  openModal: () => void;
  closeModal: () => void;
  render: (force?: boolean) => void;
  stopWechatQrPoll: () => void;
}

const imPlatformLabels: Record<string, string> = {
  dingtalk: '🟦 钉钉机器人',
  wechat: '💬 微信 iLink',
  telegram: '✈️ Telegram Bot',
  xiaoai: '🔊 小爱音箱',
};

const WECHAT_QR_POLL_INTERVAL_MS = 1500;
const WECHAT_QR_MAX_POLL_MS = 5 * 60 * 1000;
const WECHAT_QR_MAX_ERRORS = 5;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:svg\+xml|png|jpeg|webp)[;,]/i;
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function initImVoiceHub(): ImVoiceHubController {
  const imTopBadge = element<HTMLElement>('im-top-badge');
  const openImHubTop = element<HTMLButtonElement>('open-im-hub-top');
  const imHubDialog = element<HTMLElement>('im-hub-dialog');
  const imModalClose = element<HTMLButtonElement>('im-modal-close');
  const imKpiGrid = element<HTMLElement>('im-kpi-grid');
  const imWechatQrBtn = element<HTMLButtonElement>('im-wechat-qr-btn');
  const imWechatQrNewBtn = element<HTMLButtonElement>('im-wechat-qr-new-btn');
  const imWechatQrBox = element<HTMLElement>('im-wechat-qr-box');
  const imWechatQrTitle = element<HTMLElement>('im-wechat-qr-title');
  const imWechatQrImg = element<HTMLImageElement>('im-wechat-qr-img');
  const imWechatQrStatus = element<HTMLElement>('im-wechat-qr-status');
  const imWechatQrVerifyRow = element<HTMLElement>('im-wechat-qr-verify-row');
  const imWechatQrVerifyForm = (imWechatQrVerifyRow.tagName === 'FORM' ? imWechatQrVerifyRow : null) as HTMLFormElement | null;
  const imWechatQrVerifyInput = element<HTMLInputElement>('im-wechat-qr-verify-input');
  const imWechatQrVerifyBtn = element<HTMLButtonElement>('im-wechat-qr-verify-btn');
  const imWechatQrRefresh = element<HTMLButtonElement>('im-wechat-qr-refresh');
  const imWechatQrCopy = element<HTMLButtonElement>('im-wechat-qr-copy');
  const imWechatQrOpen = element<HTMLAnchorElement>('im-wechat-qr-open');
  const imWechatQrClose = element<HTMLButtonElement>('im-wechat-qr-close');
  const imTgQuickForm = (typeof document !== 'undefined' ? document.getElementById('im-tg-quick-form') : null) as HTMLFormElement | null;
  const imTgTokenInput = element<HTMLInputElement>('im-tg-token-input');
  const imTgAllowInput = element<HTMLInputElement>('im-tg-allow-input');
  const imTgQuickBtn = element<HTMLButtonElement>('im-tg-quick-btn');
  const imTgQuickStatus = element<HTMLElement>('im-tg-quick-status');
  const imVoiceStatusBadge = element<HTMLElement>('im-voice-status-badge');
  const imVoiceRefreshBtn = element<HTMLButtonElement>('im-voice-refresh-btn');
  const imVoiceToggleBtn = element<HTMLButtonElement>('im-voice-toggle-btn');
  const imVoiceClearBtn = element<HTMLButtonElement>('im-voice-clear-btn');
  const imVoiceMetaRow = element<HTMLElement>('im-voice-meta-row');
  const imVoiceList = element<HTMLElement>('im-voice-list');
  const imAddDetails = element<HTMLDetailsElement>('im-add-details');
  const imFormSummary = element<HTMLElement>('im-form-summary');
  const imFormSummaryLabel = imFormSummary.querySelector<HTMLElement>('span') ?? imFormSummary;
  const imComposeForm = (typeof document !== 'undefined' ? document.getElementById('im-compose-form') : null) as HTMLFormElement | null;
  const imPlatformInput = element<HTMLSelectElement>('im-platform-input');
  const imNameInput = element<HTMLInputElement>('im-name-input');
  const imWebhookInput = element<HTMLInputElement>('im-webhook-input');
  const imTokenInput = element<HTMLInputElement>('im-token-input');
  const imSecretInput = element<HTMLInputElement>('im-secret-input');
  const imTargetInput = element<HTMLInputElement>('im-target-input');
  const imAccountInput = element<HTMLInputElement>('im-account-input');
  const imApibaseInput = element<HTMLInputElement>('im-apibase-input');
  const imAllowInput = element<HTMLInputElement>('im-allow-input');
  const imReadLinksInput = element<HTMLInputElement>('im-read-links-input');
  const imQuietEnabledInput = element<HTMLInputElement>('im-quiet-enabled-input');
  const imQuietStartInput = element<HTMLInputElement>('im-quiet-start-input');
  const imQuietEndInput = element<HTMLInputElement>('im-quiet-end-input');
  const imWechatOptsGrid = imComposeForm?.querySelector<HTMLElement>('.wechat-channel-opts-grid') ?? null;
  const imCancelEditBtn = element<HTMLButtonElement>('im-cancel-edit-btn');
  const imSaveBtn = element<HTMLButtonElement>('im-save-btn');
  const imListSubtitle = element<HTMLElement>('im-list-subtitle');
  const imList = element<HTMLElement>('im-list');

  const lifecycleAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = lifecycleAc?.signal;
  let qrPollAc: AbortController | null = null;
  let qrStartAc: AbortController | null = null;
  let voiceRefreshAc: AbortController | null = null;

  imWechatQrVerifyInput.required = true;
  imTgTokenInput.required = true;
  imQuietStartInput.pattern = '^([01]\\d|2[0-3]):[0-5]\\d$';
  imQuietEndInput.pattern = '^([01]\\d|2[0-3]):[0-5]\\d$';
  const imComposeErrorEl = ensureInlineFormError(imComposeForm, 'im-compose-error');

  const imWechatQrCopyStatus = node('span', '', 'visually-hidden');
  imWechatQrCopyStatus.id = 'im-wechat-qr-copy-status';
  imWechatQrCopyStatus.setAttribute('role', 'status');
  imWechatQrCopy.parentElement?.insertBefore(imWechatQrCopyStatus, imWechatQrCopy.nextSibling ?? null);

  let wechatQrPollTimer: ReturnType<typeof setInterval> | undefined;
  let wechatAutoHideTimer: ReturnType<typeof setTimeout> | undefined;
  let wechatQrOpSeq = 0;
  let wechatQrStartSeq = 0;
  let wechatQrStartPending = 0;
  let wechatQrVerifyBusy = false;
  let wechatQrPollTick: (() => void) | undefined;
  let imSaving = false;
  let activeWechatQrChannelId: string | undefined;
  let activeWechatQrSessionId: string | undefined;
  let activeWechatQrContent: string | undefined;
  let activeWechatQrNewAccount = false;
  let lastWechatQrDataUrl: string | undefined;
  let editingImChannelId: string | undefined;
  let tgQuickBusy = false;
  const syncingTgChannels = new Set<string>();
  let voiceBusy = false;

  function syncWechatOptionsVisibility() {
    if (!imWechatOptsGrid) return;
    imWechatOptsGrid.hidden = imPlatformInput.value !== 'wechat';
  }

  function stopWechatQrPoll() {
    ++wechatQrOpSeq;
    qrPollAc?.abort();
    qrPollAc = null;
    qrStartAc?.abort();
    qrStartAc = null;
    wechatQrPollTick = undefined;
    if (wechatQrPollTimer) {
      clearInterval(wechatQrPollTimer);
      wechatQrPollTimer = undefined;
    }
    if (wechatAutoHideTimer) {
      clearTimeout(wechatAutoHideTimer);
      wechatAutoHideTimer = undefined;
    }
  }

  function closeWechatQrFromUi() {
    stopWechatQrPoll();
    activeWechatQrSessionId = undefined;
    activeWechatQrContent = undefined;
    lastWechatQrDataUrl = undefined;
    imWechatQrVerifyRow.hidden = true;
    imWechatQrCopy.hidden = true;
    imWechatQrOpen.hidden = true;
    imWechatQrBox.hidden = true;
    imWechatQrRefresh.disabled = appState.authExpired || !appState.ready;
    imWechatQrVerifyBtn.disabled = appState.authExpired || !appState.ready;
  }

  function applyWechatQrVisuals(session: WechatQrLoginSession) {
    if (session.qrSvgDataUrl && session.qrSvgDataUrl !== lastWechatQrDataUrl && SAFE_DATA_IMAGE_RE.test(session.qrSvgDataUrl)) {
      lastWechatQrDataUrl = session.qrSvgDataUrl;
      imWechatQrImg.src = session.qrSvgDataUrl;
    }
    const content = (session.qrcodeContent || '').trim();
    activeWechatQrContent = content || undefined;
    imWechatQrCopy.hidden = !content;
    if (/^https:\/\//i.test(content)) {
      imWechatQrOpen.href = content;
      imWechatQrOpen.hidden = false;
    } else {
      imWechatQrOpen.removeAttribute('href');
      imWechatQrOpen.hidden = true;
    }
  }

  function handleWechatQrPollResult(current: WechatQrLoginSession): boolean {
    applyWechatQrVisuals(current);
    if (current.status === 'scaned') {
      imWechatQrVerifyRow.hidden = true;
      imWechatQrStatus.textContent = '📲 已扫码！请在手机微信上点击「确认登录」…';
      announceStatus(imWechatQrStatus.textContent, 'polite');
      return false;
    }
    if (current.status === 'verify_code') {
      stopWechatQrPoll();
      imWechatQrVerifyRow.hidden = false;
      imWechatQrStatus.textContent = `🔐 ${current.error || '请输入手机端显示的验证码继续登录'}`;
      announceStatus(imWechatQrStatus.textContent, 'polite');
      safeFocus(imWechatQrVerifyInput);
      return true;
    }
    if (current.status === 'confirmed') {
      stopWechatQrPoll();
      imWechatQrVerifyRow.hidden = true;
      imWechatQrStatus.textContent = `✅ 微信扫码绑定成功！(${current.accountId ?? 'iLink 实时收发已激活'})`;
      announceStatus(imWechatQrStatus.textContent, 'polite');
      void hooks.refreshView();
      wechatAutoHideTimer = setTimeout(() => {
        wechatAutoHideTimer = undefined;
        if (!wechatQrPollTimer) imWechatQrBox.hidden = true;
      }, 2500);
      return true;
    }
    if (current.status === 'binded_redirect') {
      stopWechatQrPoll();
      imWechatQrVerifyRow.hidden = true;
      imWechatQrStatus.textContent = `⚠️ ${current.error || '微信服务端仍绑定旧机器人，请先在手机微信解绑后重新扫码。'}`;
      announceStatus(imWechatQrStatus.textContent, 'assertive');
      return true;
    }
    if (current.status === 'expired') {
      stopWechatQrPoll();
      imWechatQrVerifyRow.hidden = true;
      imWechatQrStatus.textContent = '⚠️ 二维码已过期，请点击「🔄 刷新二维码」重新获取。';
      announceStatus(imWechatQrStatus.textContent, 'assertive');
      return true;
    }
    if (current.status === 'error') {
      stopWechatQrPoll();
      imWechatQrVerifyRow.hidden = true;
      imWechatQrStatus.textContent = `❌ 二维码登录失败：${current.error || '请刷新重试'}`;
      announceStatus(imWechatQrStatus.textContent, 'assertive');
      return true;
    }
    if (current.refreshCount && current.refreshCount > 0) {
      imWechatQrStatus.textContent = `📱 二维码已自动刷新（第 ${current.refreshCount} 次），请用手机微信扫码…`;
      announceStatus(imWechatQrStatus.textContent, 'polite');
    }
    return false;
  }

  function startWechatQrStatusLoop(sessionId: string) {
    stopWechatQrPoll();
    if (appState.authExpired || !appState.ready || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden) return;
    const opSeq = wechatQrOpSeq;
    let pollingBusy = false;
    let consecutiveErrors = 0;
    let activeElapsedMs = 0;
    let lastVisibleAt = isDocumentHidden() ? 0 : Date.now();

    const tick = () => {
      if (pollingBusy) return;
      if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden) {
        stopWechatQrPoll();
        return;
      }
      if (isDocumentHidden()) {
        if (lastVisibleAt) {
          activeElapsedMs += Date.now() - lastVisibleAt;
          lastVisibleAt = 0;
        }
        return;
      }
      const now = Date.now();
      if (lastVisibleAt) {
        activeElapsedMs += now - lastVisibleAt;
      }
      lastVisibleAt = now;
      if (activeElapsedMs > WECHAT_QR_MAX_POLL_MS) {
        stopWechatQrPoll();
        imWechatQrStatus.textContent = '⚠️ 二维码轮询已超时，请点击「🔄 刷新二维码」重新获取。';
        announceStatus(imWechatQrStatus.textContent, 'assertive');
        return;
      }
      pollingBusy = true;
      qrPollAc?.abort();
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      qrPollAc = ac;
      void (async () => {
        try {
          const current = await api<WechatQrLoginSession>(
            '/api/im-wechat-qr-status',
            { sessionId },
            {
              ...(ac ? { signal: ac.signal } : {}),
              priority: 'low',
            },
          );
          if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden || ac?.signal.aborted) return;
          consecutiveErrors = 0;
          handleWechatQrPollResult(current);
        } catch (error) {
          if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden || ac?.signal.aborted) return;
          consecutiveErrors += 1;
          if (consecutiveErrors >= WECHAT_QR_MAX_ERRORS) {
            stopWechatQrPoll();
            imWechatQrStatus.textContent = `⚠️ 状态轮询连续失败（${errorText(error)}），请点击「🔄 刷新二维码」重试。`;
            announceStatus(imWechatQrStatus.textContent, 'assertive');
          }
        } finally {
          if (qrPollAc === ac) qrPollAc = null;
          pollingBusy = false;
        }
      })();
    };
    wechatQrPollTick = tick;
    wechatQrPollTimer = setInterval(tick, WECHAT_QR_POLL_INTERVAL_MS);
  }

  async function submitWechatVerifyCodeFromUi() {
    if (!activeWechatQrSessionId || appState.authExpired || !appState.ready) return;
    const sessionId = activeWechatQrSessionId;
    const opSeq = wechatQrOpSeq;
    const verifyCode = imWechatQrVerifyInput.value.trim();
    if (!verifyCode) {
      imWechatQrVerifyInput.setAttribute('aria-invalid', 'true');
      imWechatQrStatus.textContent = '⚠️ 请输入手机端显示的验证码。';
      announceStatus(imWechatQrStatus.textContent, 'assertive');
      safeFocus(imWechatQrVerifyInput);
      return;
    }
    imWechatQrVerifyInput.setAttribute('aria-invalid', 'false');
    wechatQrVerifyBusy = true;
    imWechatQrVerifyBtn.disabled = true;
    imWechatQrStatus.textContent = '⏳ 正在提交验证码…';
    try {
      const current = await api<WechatQrLoginSession>('/api/im-wechat-qr-status', {
        sessionId,
        verifyCode,
      });
      if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden) return;
      imWechatQrVerifyInput.value = '';
      if (!handleWechatQrPollResult(current)) {
        imWechatQrVerifyRow.hidden = true;
        imWechatQrStatus.textContent = '⏳ 验证码已提交，等待微信确认登录…';
        announceStatus(imWechatQrStatus.textContent, 'polite');
        startWechatQrStatusLoop(sessionId);
      }
    } catch (error) {
      if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden) return;
      imWechatQrStatus.textContent = `❌ 提交验证码失败：${errorText(error)}`;
      announceStatus(imWechatQrStatus.textContent, 'assertive');
    } finally {
      wechatQrVerifyBusy = false;
      imWechatQrVerifyBtn.disabled = appState.authExpired || !appState.ready;
    }
  }

  async function startWechatQrFromUi(channelId?: string, channelName?: string, newAccount = false) {
    if (appState.authExpired || !appState.ready) return;
    stopWechatQrPoll();
    const opSeq = wechatQrOpSeq;
    const startSeq = ++wechatQrStartSeq;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    qrStartAc = ac;
    activeWechatQrChannelId = channelId;
    activeWechatQrNewAccount = newAccount;
    activeWechatQrSessionId = undefined;
    activeWechatQrContent = undefined;
    lastWechatQrDataUrl = undefined;
    imWechatQrVerifyRow.hidden = true;
    imWechatQrVerifyInput.value = '';
    imWechatQrVerifyInput.setAttribute('aria-invalid', 'false');
    imWechatQrCopy.hidden = true;
    imWechatQrOpen.hidden = true;
    imWechatQrBox.hidden = false;
    imWechatQrTitle.textContent = channelName
      ? `微信扫码绑定 · ${channelName}`
      : newAccount
        ? '新增微信账号扫码绑定'
        : '微信扫码绑定 F.R.I.D.A.Y.';
    imWechatQrStatus.textContent = '⏳ 正在向腾讯 iLink 申请微信登录二维码…';
    ++wechatQrStartPending;
    imWechatQrRefresh.disabled = true;
    try {
      const session = await api<WechatQrLoginSession>(
        '/api/im-wechat-qr-start',
        {
          ...(channelId ? { id: channelId } : {}),
          ...(channelName ? { name: channelName } : {}),
          ...(newAccount ? { newAccount: true } : {}),
        },
        ac ? { signal: ac.signal } : undefined,
      );
      if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden || ac?.signal.aborted) return;
      if (!SAFE_DATA_IMAGE_RE.test(session.qrSvgDataUrl)) {
        imWechatQrImg.removeAttribute('src');
        imWechatQrStatus.textContent = '❌ 二维码格式不受支持，已阻止加载，请稍后重试。';
        announceStatus(imWechatQrStatus.textContent, 'assertive');
        return;
      }
      activeWechatQrChannelId = session.channelId;
      activeWechatQrSessionId = session.sessionId;
      applyWechatQrVisuals(session);
      imWechatQrStatus.textContent = '📱 请使用手机微信扫描左侧二维码绑定 F.R.I.D.A.Y.…';
      announceStatus(imWechatQrStatus.textContent, 'polite');
      await hooks.refreshView();
      if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden || ac?.signal.aborted) return;
      startWechatQrStatusLoop(session.sessionId);
    } catch (error) {
      if (opSeq !== wechatQrOpSeq || appState.authExpired || !isDialogOpen(imHubDialog) || imWechatQrBox.hidden || ac?.signal.aborted) return;
      imWechatQrStatus.textContent = `获取二维码失败：${errorText(error)}`;
      announceStatus(imWechatQrStatus.textContent, 'assertive');
    } finally {
      if (qrStartAc === ac) qrStartAc = null;
      wechatQrStartPending = Math.max(0, wechatQrStartPending - 1);
      if (startSeq === wechatQrStartSeq) {
        imWechatQrRefresh.disabled = appState.authExpired || !appState.ready || wechatQrStartPending > 0;
      }
    }
  }

  function renderVoiceprints() {
    const vp = appState.voiceprintState ?? appState.view?.voiceprint;
    const profiles = vp?.profiles ?? [];
    const disabled = appState.authExpired || !appState.ready || voiceBusy;

    if (vp?.active) {
      imVoiceStatusBadge.textContent = '🛡️ 抗串音门控生效中';
      imVoiceStatusBadge.className = 'hub-badge badge-green';
    } else if (vp && !vp.enabled && profiles.length > 0) {
      imVoiceStatusBadge.textContent = '⏸ 声纹门控已暂停';
      imVoiceStatusBadge.className = 'hub-badge badge-amber';
    } else if (vp && !vp.modelReady) {
      imVoiceStatusBadge.textContent = '⚠️ 声纹模型未就绪';
      imVoiceStatusBadge.className = 'hub-badge badge-amber';
    } else {
      imVoiceStatusBadge.textContent = '⚪ 待语音录入';
      imVoiceStatusBadge.className = 'hub-badge badge-slate';
    }

    imVoiceToggleBtn.textContent = vp?.enabled === false ? '▶️ 启用门控' : '⏸ 暂停门控';
    imVoiceToggleBtn.setAttribute('aria-pressed', String(vp?.enabled !== false));
    imVoiceToggleBtn.disabled = disabled;
    imVoiceRefreshBtn.disabled = disabled;
    imVoiceClearBtn.hidden = profiles.length === 0;
    imVoiceClearBtn.disabled = disabled;
    imVoiceClearBtn.textContent = '🧹 清空全部';
    imVoiceClearBtn.className = 'mini-button danger-btn';

    const metaFrag = document.createDocumentFragment();
    metaFrag.append(
      node('span', `👥 已录入 ${profiles.length} 人`, 'hub-meta-chip'),
      node('span', `🎯 匹配阈值 ${(vp?.threshold ?? 0.45).toFixed(2)}`, 'hub-meta-chip'),
      node('span', `⚡ 唤醒预检 ${vp?.wakePrecheck !== false ? '已开启' : '已关闭'}`, 'hub-meta-chip'),
      node('span', `🧠 本地模型 ${vp?.modelReady ? '✅ 已就绪' : '⏳ 未下载'}`, 'hub-meta-chip'),
    );
    imVoiceMetaRow.replaceChildren(metaFrag);

    const listFrag = document.createDocumentFragment();
    for (const p of profiles) {
      const card = node('article', '', 'hub-entity-card');
      const head = node('div', '', 'hub-card-head');
      const titleGroup = node('div', '', 'hub-card-title-group');
      titleGroup.append(
        node('span', p.role === 'owner' ? '👑 主人' : '👤 家庭成员', `hub-badge ${p.role === 'owner' ? 'badge-amber' : 'badge-teal'}`),
        node('strong', p.name, 'hub-card-title'),
      );
      head.append(titleGroup);

      const actions = node('div', '', 'timer-actions');
      const delBtn = button(
        '🗑️ 删除',
        () => {
          void removeVoiceprintFromUi(p.id, p.name);
        },
        'mini-button danger-btn',
      );
      delBtn.dataset.focusKey = `voice-del:${p.id}`;
      delBtn.setAttribute('aria-label', `删除声纹档案 ${p.name}`);
      delBtn.disabled = disabled;
      actions.append(delBtn);
      head.append(actions);
      card.append(head);

      const badges = node('div', '', 'hub-badges-row');
      badges.append(
        node('span', `🎙️ 样本 ${p.sampleCount} 条`, 'hub-meta-chip'),
        node('span', `🧬 ${p.dim} 维特征`, 'hub-meta-chip'),
        node('span', `🕒 更新于 ${timestamp(p.updatedAt)}`, 'hub-meta-chip'),
      );
      card.append(badges);
      listFrag.append(card);
    }
    if (!profiles.length) {
      listFrag.append(node('p', '暂未录入任何声纹。直接对小爱音箱说「你好星期五，录入我的声纹」即可完成创建。', 'empty hub-empty-state'));
    }
    replaceChildrenPreservingFocus(imVoiceList, listFrag, () => imVoiceRefreshBtn);
  }

  async function refreshVoiceprintsFromUi(silent = false) {
    if (!silent) {
      voiceBusy = true;
      renderVoiceprints();
    }
    voiceRefreshAc?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    voiceRefreshAc = ac;
    try {
      appState.voiceprintState = await api<VoiceprintStatusView>(
        '/api/voiceprints',
        undefined,
        {
          ...(ac ? { signal: ac.signal } : {}),
          ...(silent ? { priority: 'low' as const } : {}),
        },
      );
      if (ac?.signal.aborted) return;
      render();
    } catch (error) {
      if (ac?.signal.aborted) return;
      if (!silent) {
        const msg = `刷新声纹状态失败：${errorText(error)}`;
        hooks.connection(msg, true);
        announceStatus(msg, 'assertive');
      }
    } finally {
      if (voiceRefreshAc === ac) voiceRefreshAc = null;
      if (!silent) {
        voiceBusy = false;
        renderVoiceprints();
      }
    }
  }

  async function toggleVoiceprintFromUi() {
    const current = appState.voiceprintState ?? appState.view?.voiceprint;
    const nextEnabled = current?.enabled === false;
    voiceBusy = true;
    renderVoiceprints();
    try {
      appState.voiceprintState = await api<VoiceprintStatusView>('/api/voice-config', { enabled: nextEnabled });
      const msg = nextEnabled ? '已启用小爱声纹防串音门控。' : '已暂停小爱声纹防串音门控。';
      hooks.connection(msg);
      announceStatus(msg, 'polite');
      await hooks.refreshView();
    } catch (error) {
      const msg = `切换声纹门控失败：${errorText(error)}`;
      hooks.connection(msg, true);
      announceStatus(msg, 'assertive');
    } finally {
      voiceBusy = false;
      renderVoiceprints();
    }
  }

  async function removeVoiceprintFromUi(id: string, name: string) {
    const confirmed = await confirmAction({
      title: '删除声纹档案',
      message: `确定要删除「${name}」的声纹档案吗？删除后需重新对小爱音箱录入声纹。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!confirmed || appState.authExpired || !appState.ready) return;
    voiceBusy = true;
    renderVoiceprints();
    try {
      await api<unknown>('/api/voice-remove', { target: id });
      await refreshVoiceprintsFromUi(true);
      await hooks.refreshView();
      const msg = `已删除「${name}」的声纹档案。`;
      hooks.connection(msg);
      announceStatus(msg, 'polite');
    } catch (error) {
      const msg = `删除声纹档案失败：${errorText(error)}`;
      hooks.connection(msg, true);
      announceStatus(msg, 'assertive');
    } finally {
      voiceBusy = false;
      renderVoiceprints();
    }
  }

  async function clearVoiceprintsFromUi() {
    const confirmed = await confirmAction({
      title: '清空全部声纹档案',
      message: '确定要清空所有已录入的家庭成员声纹档案吗？此操作无法撤销。',
      confirmLabel: '确认清空',
      danger: true,
    });
    if (!confirmed || appState.authExpired || !appState.ready) return;
    voiceBusy = true;
    renderVoiceprints();
    try {
      await api<unknown>('/api/voice-clear', {});
      await refreshVoiceprintsFromUi(true);
      await hooks.refreshView();
      const msg = '已清空全部声纹档案。';
      hooks.connection(msg);
      announceStatus(msg, 'polite');
    } catch (error) {
      const msg = `清空声纹档案失败：${errorText(error)}`;
      hooks.connection(msg, true);
      announceStatus(msg, 'assertive');
    } finally {
      voiceBusy = false;
      renderVoiceprints();
    }
  }

  function resetImChannelForm() {
    editingImChannelId = undefined;
    imNameInput.value = '';
    imWebhookInput.value = '';
    imTokenInput.value = '';
    imSecretInput.value = '';
    imTargetInput.value = '';
    imAccountInput.value = '';
    imApibaseInput.value = '';
    imAllowInput.value = '';
    imReadLinksInput.checked = true;
    imQuietEnabledInput.checked = false;
    imQuietStartInput.value = '23:00';
    imQuietEndInput.value = '07:00';
    imCancelEditBtn.hidden = true;
    imSaveBtn.textContent = '💾 保存 IM 通道配置';
    imFormSummaryLabel.textContent = '+ 手动配置通道（微信 / 小爱音箱 / 钉钉 / Telegram）';
    setInlineFormError(imComposeErrorEl, undefined, [imWebhookInput, imQuietStartInput, imQuietEndInput]);
    syncWechatOptionsVisibility();
  }

  function editImChannelFromUi(ch: ImChannelView) {
    editingImChannelId = ch.id;
    imPlatformInput.value = ch.platform;
    imNameInput.value = ch.name;
    imWebhookInput.value = '';
    imTokenInput.value = '';
    imSecretInput.value = '';
    imTargetInput.value = ch.defaultTarget ?? '';
    imAccountInput.value = ch.accountId ?? '';
    imApibaseInput.value = ch.apiBase ?? '';
    imAllowInput.value = ch.allowedSenders.join(', ');
    imReadLinksInput.checked = ch.readLinks !== false;
    imQuietEnabledInput.checked = Boolean(ch.quietHours?.enabled);
    imQuietStartInput.value = ch.quietHours?.start ?? '23:00';
    imQuietEndInput.value = ch.quietHours?.end ?? '07:00';
    imCancelEditBtn.hidden = false;
    imSaveBtn.textContent = `💾 更新通道「${ch.name}」`;
    imFormSummaryLabel.textContent = `✏️ 编辑通道「${ch.name}」`;
    setInlineFormError(imComposeErrorEl, undefined, [imWebhookInput, imQuietStartInput, imQuietEndInput]);
    syncWechatOptionsVisibility();
    imAddDetails.open = true;
    safeFocus(imNameInput);
  }

  async function saveImChannelFromUi() {
    const isEditing = Boolean(editingImChannelId);
    const platform = imPlatformInput.value as 'dingtalk' | 'wechat' | 'telegram' | 'xiaoai';
    const name = imNameInput.value.trim() || `${imPlatformLabels[platform] ?? platform}助手`;
    const webhookUrl = imWebhookInput.value.trim() || undefined;
    const botToken = imTokenInput.value.trim() || undefined;
    const secret = imSecretInput.value.trim() || undefined;
    const rawTarget = imTargetInput.value.trim();
    const rawAccount = imAccountInput.value.trim();
    const rawApiBase = imApibaseInput.value.trim();
    const defaultTarget = isEditing ? rawTarget : (rawTarget || undefined);
    const accountId = isEditing ? rawAccount : (rawAccount || undefined);
    const apiBase = isEditing ? rawApiBase : (rawApiBase || undefined);
    const allowedSenders = imAllowInput.value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    const readLinks = imReadLinksInput.checked;
    const quietEnabled = imQuietEnabledInput.checked;
    const quietStart = imQuietStartInput.value.trim() || '23:00';
    const quietEnd = imQuietEndInput.value.trim() || '07:00';
    if (webhookUrl && !/^https?:\/\/\S+/i.test(webhookUrl)) {
      setInlineFormError(imComposeErrorEl, 'Webhook URL 须以 http:// 或 https:// 开头', [imWebhookInput]);
      safeFocus(imWebhookInput);
      return;
    }
    if ((platform === 'wechat' || isEditing) && quietEnabled) {
      if (!HH_MM_RE.test(quietStart)) {
        setInlineFormError(imComposeErrorEl, '免打扰开始时间格式应为 HH:mm（例如 23:00）', [imQuietStartInput]);
        safeFocus(imQuietStartInput);
        return;
      }
      if (!HH_MM_RE.test(quietEnd)) {
        setInlineFormError(imComposeErrorEl, '免打扰结束时间格式应为 HH:mm（例如 07:00）', [imQuietEndInput]);
        safeFocus(imQuietEndInput);
        return;
      }
    }
    setInlineFormError(imComposeErrorEl, undefined, [imWebhookInput, imQuietStartInput, imQuietEndInput]);
    if (imSaving || appState.authExpired || !appState.ready) return;
    imSaving = true;
    imSaveBtn.disabled = true;
    try {
      await api<ImChannelView>('/api/im-save', {
        ...(editingImChannelId ? { id: editingImChannelId } : {}),
        platform,
        name,
        ...(webhookUrl !== undefined ? { webhookUrl } : {}),
        ...(botToken !== undefined ? { botToken } : {}),
        ...(secret !== undefined ? { secret } : {}),
        ...(defaultTarget !== undefined ? { defaultTarget } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(apiBase !== undefined ? { apiBase } : {}),
        ...(editingImChannelId || allowedSenders.length ? { allowedSenders } : {}),
        ...(platform === 'wechat' || isEditing ? {
          readLinks,
          quietHours: { enabled: quietEnabled, start: quietStart, end: quietEnd },
        } : {}),
      });
      resetImChannelForm();
      imAddDetails.open = false;
      announceStatus(`已保存 IM 通道「${name}」`, 'polite');
      await hooks.refreshView();
    } catch (error) {
      const errMsg = `保存 IM 通道失败：${errorText(error)}`;
      setInlineFormError(imComposeErrorEl, errMsg);
      hooks.connection(errMsg, true);
    } finally {
      imSaving = false;
      imSaveBtn.disabled = appState.authExpired || !appState.ready;
    }
  }

  async function allowStrangerFromUi(channelId: string, senderId: string) {
    try {
      await api<ImChannelView>('/api/im-allow-sender', { id: channelId, senderId });
      hooks.connection(`已将 ${senderId} 加入白名单。`);
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`加白失败：${errorText(error)}`, true);
    }
  }

  async function dismissStrangerFromUi(channelId: string, senderId?: string) {
    try {
      await api<ImChannelView>('/api/im-dismiss-stranger', {
        id: channelId,
        ...(senderId ? { senderId } : {}),
      });
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`移除记录失败：${errorText(error)}`, true);
    }
  }

  async function toggleImChannelFromUi(id: string, enabled: boolean) {
    try {
      await api<unknown>('/api/im-toggle', { id, enabled });
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`切换 IM 通道失败：${errorText(error)}`, true);
    }
  }

  async function testImChannelFromUi(id: string) {
    try {
      await api<unknown>('/api/im-test', { id });
      hooks.connection('已向该 IM 通道发送 FRIDAY 神经链路自检消息。');
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`IM 通道自检失败：${errorText(error)}`, true);
      await hooks.refreshView();
    }
  }

  async function removeImChannelFromUi(id: string, name: string) {
    const confirmed = await confirmAction({
      title: '删除 IM 通道',
      message: `确定要删除通道「${name}」及其保存的凭据和白名单配置吗？`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!confirmed || appState.authExpired || !appState.ready) return;
    try {
      await api<unknown>('/api/im-remove', { id });
      if (editingImChannelId === id) {
        resetImChannelForm();
        imAddDetails.open = false;
      }
      announceStatus(`已删除通道「${name}」`, 'polite');
      await hooks.refreshView();
    } catch (error) {
      const msg = `删除 IM 通道失败：${errorText(error)}`;
      hooks.connection(msg, true);
      announceStatus(msg, 'assertive');
    }
  }

  async function quickConnectTelegramFromUi() {
    if (tgQuickBusy) return;
    const botToken = imTgTokenInput.value.trim();
    if (!botToken) {
      imTgTokenInput.setAttribute('aria-invalid', 'true');
      imTgQuickStatus.hidden = false;
      imTgQuickStatus.className = 'telegram-quick-status is-error';
      imTgQuickStatus.textContent = '⚠️ 请先输入从 @BotFather 获取的 Bot Token。';
      announceStatus(imTgQuickStatus.textContent, 'assertive');
      safeFocus(imTgTokenInput);
      return;
    }
    imTgTokenInput.setAttribute('aria-invalid', 'false');
    const allowedSenders = imTgAllowInput.value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    tgQuickBusy = true;
    render(true);
    imTgQuickStatus.hidden = false;
    imTgQuickStatus.className = 'telegram-quick-status is-pending';
    imTgQuickStatus.textContent = '⏳ 正在校验 Bot Token、清理冲突 Webhook 并同步常见命令菜单…';
    try {
      const res = await api<TelegramQuickConnectView>('/api/im-telegram-quick', {
        botToken,
        ...(allowedSenders.length ? { allowedSenders } : {}),
      });
      imTgTokenInput.value = '';
      imTgAllowInput.value = '';
      const botLabel = res.bot.username ? `@${res.bot.username}` : `${res.bot.firstName} (#${res.bot.id})`;
      const cmdStatus = res.commandsRegistered
        ? '常见命令菜单已配置完成'
        : `命令菜单同步异常（${res.commandsError ?? '可稍后在下方通道点击「🔄 同步命令」重试'}）`;
      imTgQuickStatus.className = 'telegram-quick-status is-ok';
      imTgQuickStatus.textContent = `✅ 已接入 ${botLabel}（${res.bot.firstName}） · ${cmdStatus}。现在就可以在 Telegram 中打开 ${botLabel} 发送 /start 开始对话！`;
      announceStatus(`Telegram Bot ${botLabel} 已一键接入并启动长轮询。`, 'polite');
      hooks.connection(`Telegram Bot ${botLabel} 已一键接入并启动长轮询。`);
      await hooks.refreshView();
    } catch (error) {
      imTgQuickStatus.className = 'telegram-quick-status is-error';
      imTgQuickStatus.textContent = `❌ Telegram 接入失败：${errorText(error)}`;
      announceStatus(imTgQuickStatus.textContent, 'assertive');
      hooks.connection(`Telegram 快速接入失败：${errorText(error)}`, true);
    } finally {
      tgQuickBusy = false;
      render(true);
    }
  }

  async function syncTelegramCommandsFromUi(id: string, name: string) {
    if (syncingTgChannels.has(id)) return;
    syncingTgChannels.add(id);
    render(true);
    try {
      const res = await api<TelegramSyncCommandsView>('/api/im-telegram-sync', { id });
      const msg = `已为「${name}」同步 ${res.count} 项 Telegram 常见命令菜单。`;
      hooks.connection(msg);
      announceStatus(msg, 'polite');
      await hooks.refreshView();
    } catch (error) {
      const msg = `同步 Telegram 命令菜单失败：${errorText(error)}`;
      hooks.connection(msg, true);
      announceStatus(msg, 'assertive');
    } finally {
      syncingTgChannels.delete(id);
      render(true);
    }
  }

  function render(force = false) {
    const channels = appState.view?.imChannels ?? [];
    const activeCount = channels.filter(c => c.enabled).length;
    imTopBadge.textContent = channels.length ? `${activeCount}/${channels.length}` : '0';

    if (!isDialogOpen(imHubDialog) && !force) {
      return;
    }

    const controlsDisabled = appState.authExpired || !appState.ready;
    imSaveBtn.disabled = controlsDisabled || imSaving;
    imWechatQrBtn.disabled = controlsDisabled;
    imWechatQrNewBtn.disabled = controlsDisabled;
    imWechatQrRefresh.disabled = controlsDisabled || wechatQrStartPending > 0;
    imWechatQrVerifyBtn.disabled = controlsDisabled || wechatQrVerifyBusy;
    imTgTokenInput.disabled = controlsDisabled || tgQuickBusy;
    imTgAllowInput.disabled = controlsDisabled || tgQuickBusy;
    imTgQuickBtn.disabled = controlsDisabled || tgQuickBusy;

    const wechatBound = channels.some(c => c.platform === 'wechat' && c.hasBotToken);
    const telegramBound = channels.some(c => c.platform === 'telegram' && c.hasBotToken);
    const boundCount = channels.filter(c =>
      c.hasBotToken
      || Boolean(c.webhookUrlMasked)
      || (c.platform === 'xiaoai' && (Boolean(c.accountId) || Boolean(c.apiBase))),
    ).length;
    const totalIn = channels.reduce((sum, c) => sum + (c.inboundCount ?? 0), 0);
    const totalOut = channels.reduce((sum, c) => sum + (c.outboundCount ?? 0), 0);
    const vp = appState.voiceprintState ?? appState.view?.voiceprint;

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('启用通道', `${activeCount} / ${channels.length}`, channels.length ? `已绑定 ${boundCount} 个` : '暂无配置', activeCount > 0 ? 'positive' : 'default'),
      kpiCard(
        '直连绑定',
        wechatBound && telegramBound ? '✅ 微信 + TG' : wechatBound ? '✅ 微信已连' : telegramBound ? '✅ TG 已连' : '⚪ 未绑定',
        `微信 ${wechatBound ? '✓' : '—'} · Telegram ${telegramBound ? '✓' : '—'}`,
        wechatBound || telegramBound ? 'positive' : 'default',
      ),
      kpiCard(
        '声纹门控',
        vp?.active ? `🛡️ 已生效 (${vp.profiles.length}人)` : vp?.profiles.length ? `⏸ 已暂停 (${vp.profiles.length}人)` : '⚪ 待录入',
        '',
        vp?.active ? 'positive' : 'default',
      ),
      kpiCard('收发消息', `收 ${totalIn} · 发 ${totalOut}`, '', 'accent'),
    );
    imKpiGrid.replaceChildren(kpiFrag);
    renderVoiceprints();
    imListSubtitle.textContent = channels.length ? `${activeCount} / ${channels.length} 运行中` : '';

    const contents = document.createDocumentFragment();
    for (const ch of channels) {
      const card = node('article', '', `hub-entity-card im-card${ch.enabled ? ' is-active' : ' is-paused'}`);
      const head = node('div', '', 'hub-card-head');
      const titleGroup = node('div', '', 'hub-card-title-group');
      titleGroup.append(
        node('span', imPlatformLabels[ch.platform] ?? ch.platform, 'hub-badge badge-blue'),
        node('strong', ch.name, 'hub-card-title'),
        node('span', ch.enabled ? '● 已启用' : '⏸ 已暂停', `hub-badge ${ch.enabled ? 'badge-green' : 'badge-slate'}`),
      );
      head.append(titleGroup);

      const actions = node('div', '', 'timer-actions');
      if (ch.platform === 'wechat') {
        const qrBtn = button(ch.hasBotToken ? '📱 换绑扫码' : '📱 扫码绑定', () => { void startWechatQrFromUi(ch.id, ch.name); }, 'mini-button');
        qrBtn.dataset.focusKey = `im-qr:${ch.id}`;
        qrBtn.setAttribute('aria-label', `${ch.hasBotToken ? '换绑扫码' : '扫码绑定'} ${ch.name}`);
        qrBtn.disabled = controlsDisabled;
        actions.append(qrBtn);
      }
      if (ch.platform === 'telegram' && ch.hasBotToken) {
        const syncing = syncingTgChannels.has(ch.id);
        const syncBtn = button(
          syncing ? '⏳ 同步中…' : '🔄 同步命令',
          () => { void syncTelegramCommandsFromUi(ch.id, ch.name); },
          'mini-button',
        );
        syncBtn.dataset.focusKey = `im-sync:${ch.id}`;
        syncBtn.setAttribute('aria-label', `同步 ${ch.name} Telegram 命令菜单`);
        syncBtn.disabled = controlsDisabled || syncing;
        actions.append(syncBtn);
      }
      const testBtn = button('⚡ 自检', () => { void testImChannelFromUi(ch.id); }, 'mini-button');
      testBtn.dataset.focusKey = `im-test:${ch.id}`;
      testBtn.setAttribute('aria-label', `自检通道 ${ch.name}`);
      const editBtn = button('✏️ 编辑', () => { editImChannelFromUi(ch); }, 'mini-button');
      editBtn.dataset.focusKey = `im-edit:${ch.id}`;
      editBtn.setAttribute('aria-label', `编辑通道 ${ch.name}`);
      const toggleBtn = button(ch.enabled ? '⏸ 暂停' : '▶️ 启用', () => { void toggleImChannelFromUi(ch.id, !ch.enabled); }, 'mini-button');
      toggleBtn.dataset.focusKey = `im-toggle:${ch.id}`;
      toggleBtn.setAttribute('aria-pressed', String(ch.enabled));
      toggleBtn.setAttribute('aria-label', `${ch.enabled ? '暂停' : '启用'}通道 ${ch.name}`);
      const delBtn = button('🗑️ 删除', () => { void removeImChannelFromUi(ch.id, ch.name); }, 'mini-button danger-btn');
      delBtn.dataset.focusKey = `im-del:${ch.id}`;
      delBtn.setAttribute('aria-label', `删除通道 ${ch.name}`);
      editBtn.disabled = controlsDisabled;
      testBtn.disabled = controlsDisabled;
      toggleBtn.disabled = controlsDisabled;
      delBtn.disabled = controlsDisabled;
      actions.append(testBtn, editBtn, toggleBtn, delBtn);
      head.append(actions);
      card.append(head);

      const webhookPath = `${location.origin}/im/webhook/${encodeURIComponent(ch.id)}`;
      const endpointBox = node('div', '', 'hub-endpoint-row');
      if (ch.platform === 'wechat') {
        const bindText = ch.hasBotToken
          ? `✅ 微信 iLink 已扫码授权${ch.accountId ? ` · 绑定账号: ${ch.accountId}` : ''} · 本机长轮询实时收发已就绪`
          : ch.webhookUrlMasked
            ? `🔗 企微/网桥 Webhook: ${ch.webhookUrlMasked}`
            : '⚠️ 尚未完成微信扫码授权，请点击右上角「📱 扫码绑定」获取登录二维码';
        endpointBox.append(node('span', bindText, ch.hasBotToken ? 'hub-endpoint-text ok' : 'hub-endpoint-text warn'));
      } else if (ch.platform === 'telegram') {
        if (!ch.webhookUrlMasked) {
          const tgText = ch.hasBotToken
            ? `✅ Telegram 本机长轮询已就绪${ch.accountId ? ` · 机器人: ${ch.accountId}` : ''} · 常见命令菜单已配置`
            : '⚠️ 尚未配置 Telegram Bot Token，请使用上方「✈️ Telegram Bot 一键快速接入」或手动填写 Token';
          endpointBox.append(node('span', tgText, ch.hasBotToken ? 'hub-endpoint-text ok' : 'hub-endpoint-text warn'));
        } else {
          endpointBox.append(node('span', `🔗 Telegram Webhook 已配置: ${ch.webhookUrlMasked}`, 'hub-endpoint-text ok'));
        }
      } else if (ch.platform === 'xiaoai') {
        if (ch.apiBase?.startsWith('ssh://')) {
          endpointBox.append(node('span', `⚡ 局域网 SSH 直连: ${ch.apiBase}`, 'hub-endpoint-text ok'));
        } else if (ch.accountId) {
          endpointBox.append(node('span', `☁️ 小米云轮询账号: ${ch.accountId}`, 'hub-endpoint-text ok'));
        } else {
          endpointBox.append(node('code', `回调 Webhook: ${webhookPath}`, 'hub-endpoint-code'));
          const copyStatus = node('span', '', 'visually-hidden');
          copyStatus.setAttribute('role', 'status');
          const copyBtn = button('📋 复制地址', () => {
            void copyTextWithFeedback(copyBtn, webhookPath, { statusEl: copyStatus });
          }, 'mini-button copy-mini-btn');
          copyBtn.dataset.focusKey = `im-copy:${ch.id}`;
          copyBtn.setAttribute('aria-label', `复制 ${ch.name} 回调地址`);
          endpointBox.append(copyBtn, copyStatus);
        }
      } else {
        endpointBox.append(node('code', `回调 Webhook: ${webhookPath}`, 'hub-endpoint-code'));
        const copyStatus = node('span', '', 'visually-hidden');
        copyStatus.setAttribute('role', 'status');
        const copyBtn = button('📋 复制地址', () => {
          void copyTextWithFeedback(copyBtn, webhookPath, { statusEl: copyStatus });
        }, 'mini-button copy-mini-btn');
        copyBtn.dataset.focusKey = `im-copy:${ch.id}`;
        copyBtn.setAttribute('aria-label', `复制 ${ch.name} 回调地址`);
        endpointBox.append(copyBtn, copyStatus);
      }
      card.append(endpointBox);

      const badgesRow = node('div', '', 'hub-badges-row');
      badgesRow.append(
        node('span', `📥 收到 ${ch.inboundCount} 条`, 'hub-meta-chip'),
        node('span', `📤 发送 ${ch.outboundCount} 条`, 'hub-meta-chip'),
      );
      if (ch.defaultTarget) badgesRow.append(node('span', `🎯 默认目标: ${ch.defaultTarget}`, 'hub-meta-chip mono-chip'));
      if (ch.allowedSenders.length) {
        badgesRow.append(node('span', `🛡️ 白名单: ${ch.allowedSenders.join(', ')}`, 'hub-meta-chip'));
      } else {
        badgesRow.append(node('span', '🛡️ 允许全部已鉴权会话', 'hub-meta-chip'));
      }
      if (ch.quietHours?.enabled) {
        badgesRow.append(node('span', `🌙 免打扰 ${ch.quietHours.start}–${ch.quietHours.end}`, 'hub-meta-chip'));
      }
      if (ch.platform === 'wechat' && ch.readLinks === false) {
        badgesRow.append(node('span', '🔗 已禁用链接预读', 'hub-meta-chip'));
      }
      if (ch.lastInboundAt) badgesRow.append(node('span', `最近收信: ${timestamp(ch.lastInboundAt)}`, 'hub-meta-chip'));
      card.append(badgesRow);

      if (ch.rejectedSenders?.length) {
        const strangersBox = node('div', '', 'wechat-strangers-box');
        strangersBox.append(node('div', `🚫 被拦截的陌生人 (${ch.rejectedSenders.length})`, 'wechat-strangers-title'));
        for (const s of ch.rejectedSenders.slice(0, 5)) {
          const row = node('div', '', 'wechat-stranger-row');
          const info = node('div', '', 'wechat-stranger-info');
          const label = s.senderName ? `${s.senderName} (${s.senderId})` : s.senderId;
          info.append(
            node('code', label, 'mono-chip'),
            node('span', `×${s.count}`, 'hub-meta-chip'),
          );
          if (s.lastText) {
            info.append(node('span', s.lastText, 'wechat-stranger-preview'));
          }
          const rowActions = node('div', '', 'timer-actions');
          const allowBtn = button('✅ 一键加白', () => { void allowStrangerFromUi(ch.id, s.senderId); }, 'mini-button');
          allowBtn.dataset.focusKey = `im-allow:${ch.id}:${s.senderId}`;
          allowBtn.setAttribute('aria-label', `允许陌生人 ${s.senderId} 发送消息`);
          const dismissBtn = button('✕ 忽略', () => { void dismissStrangerFromUi(ch.id, s.senderId); }, 'mini-button');
          dismissBtn.dataset.focusKey = `im-dismiss:${ch.id}:${s.senderId}`;
          dismissBtn.setAttribute('aria-label', `忽略陌生人 ${s.senderId}`);
          allowBtn.disabled = controlsDisabled;
          dismissBtn.disabled = controlsDisabled;
          rowActions.append(allowBtn, dismissBtn);
          row.append(info, rowActions);
          strangersBox.append(row);
        }
        card.append(strangersBox);
      }

      if (ch.lastError) card.append(node('p', `⚠️ 最近异常：${ch.lastError}`, 'error hub-error-banner'));
      contents.append(card);
    }
    if (!channels.length) {
      contents.append(node('p', '暂无 IM 通道', 'empty hub-empty-state'));
    }
    replaceChildrenPreservingFocus(imList, contents, () => imWechatQrBtn);
  }

  function handleDialogClosed() {
    stopWechatQrPoll();
  }

  function openModal() {
    if (!isDialogOpen(imHubDialog)) {
      hooks.closeAllHubModals();
      openModalDialog(imHubDialog);
    }
    render(true);
    if (!appState.authExpired && appState.ready) void refreshVoiceprintsFromUi(true);
    safeFocus(imModalClose);
  }

  function closeModal() {
    handleDialogClosed();
    closeModalDialog(imHubDialog);
  }

  bindDialogLightDismiss(imHubDialog, handleDialogClosed, signal);

  const listenerOpts = signal ? { signal } : undefined;
  openImHubTop.addEventListener('click', openModal, listenerOpts);
  imModalClose.addEventListener('click', closeModal, listenerOpts);
  imPlatformInput.addEventListener('change', syncWechatOptionsVisibility, listenerOpts);
  imCancelEditBtn.addEventListener('click', () => {
    resetImChannelForm();
    imAddDetails.open = false;
  }, listenerOpts);
  wireHubForm(imComposeForm, imSaveBtn, () => { void saveImChannelFromUi(); }, signal);
  wireHubForm(imTgQuickForm, imTgQuickBtn, () => { void quickConnectTelegramFromUi(); }, signal);
  const onTgQuickKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !isImeComposing(event)) {
      event.preventDefault();
      if (imTgQuickForm && typeof (imTgQuickForm as { requestSubmit?: unknown }).requestSubmit === 'function') {
        imTgQuickForm.requestSubmit();
      } else {
        void quickConnectTelegramFromUi();
      }
    }
  };
  imTgTokenInput.addEventListener('keydown', onTgQuickKeyDown, listenerOpts);
  imTgAllowInput.addEventListener('keydown', onTgQuickKeyDown, listenerOpts);
  imWechatQrBtn.addEventListener('click', () => { void startWechatQrFromUi(); }, listenerOpts);
  imWechatQrNewBtn.addEventListener('click', () => { void startWechatQrFromUi(undefined, undefined, true); }, listenerOpts);
  imWechatQrRefresh.addEventListener('click', () => {
    void startWechatQrFromUi(activeWechatQrChannelId, undefined, activeWechatQrNewAccount && !activeWechatQrChannelId);
  }, listenerOpts);
  imWechatQrCopy.addEventListener('click', () => {
    if (!activeWechatQrContent) return;
    void copyTextWithFeedback(imWechatQrCopy, activeWechatQrContent, { statusEl: imWechatQrCopyStatus });
  }, listenerOpts);
  wireHubForm(imWechatQrVerifyForm, imWechatQrVerifyBtn, () => { void submitWechatVerifyCodeFromUi(); }, signal);
  imWechatQrVerifyInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !isImeComposing(event)) {
      event.preventDefault();
      if (imWechatQrVerifyForm && typeof (imWechatQrVerifyForm as { requestSubmit?: unknown }).requestSubmit === 'function') {
        imWechatQrVerifyForm.requestSubmit();
      } else {
        void submitWechatVerifyCodeFromUi();
      }
    }
  }, listenerOpts);
  imWechatQrClose.addEventListener('click', closeWechatQrFromUi, listenerOpts);
  imVoiceRefreshBtn.addEventListener('click', () => { void refreshVoiceprintsFromUi(false); }, listenerOpts);
  imVoiceToggleBtn.addEventListener('click', () => { void toggleVoiceprintFromUi(); }, listenerOpts);
  imVoiceClearBtn.addEventListener('click', () => {
    void clearVoiceprintsFromUi();
  }, listenerOpts);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!isDocumentHidden() && wechatQrPollTick && isDialogOpen(imHubDialog) && !imWechatQrBox.hidden) {
        wechatQrPollTick();
      }
    }, listenerOpts);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      stopWechatQrPoll();
      voiceRefreshAc?.abort();
      lifecycleAc?.abort();
    }, listenerOpts);
  }

  syncWechatOptionsVisibility();

  return {
    openModal,
    closeModal,
    render,
    stopWechatQrPoll,
  };
}
