import type {
  ImChannelView,
  TelegramQuickConnectView,
  TelegramSyncCommandsView,
  VoiceprintStatusView,
  WechatQrLoginSession,
} from '../../view.js';
import { button, element, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
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

export function initImVoiceHub(): ImVoiceHubController {
  const imTopBadge = element<HTMLElement>('im-top-badge');
  const openImHubTop = element<HTMLButtonElement>('open-im-hub-top');
  const imHubBackdrop = element<HTMLElement>('im-hub-backdrop');
  const imModalClose = element<HTMLButtonElement>('im-modal-close');
  const imKpiGrid = element<HTMLElement>('im-kpi-grid');
  const imWechatQrBtn = element<HTMLButtonElement>('im-wechat-qr-btn');
  const imWechatQrBox = element<HTMLElement>('im-wechat-qr-box');
  const imWechatQrTitle = element<HTMLElement>('im-wechat-qr-title');
  const imWechatQrImg = element<HTMLImageElement>('im-wechat-qr-img');
  const imWechatQrStatus = element<HTMLElement>('im-wechat-qr-status');
  const imWechatQrRefresh = element<HTMLButtonElement>('im-wechat-qr-refresh');
  const imWechatQrClose = element<HTMLButtonElement>('im-wechat-qr-close');
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
  const imPlatformInput = element<HTMLSelectElement>('im-platform-input');
  const imNameInput = element<HTMLInputElement>('im-name-input');
  const imWebhookInput = element<HTMLInputElement>('im-webhook-input');
  const imTokenInput = element<HTMLInputElement>('im-token-input');
  const imSecretInput = element<HTMLInputElement>('im-secret-input');
  const imTargetInput = element<HTMLInputElement>('im-target-input');
  const imAccountInput = element<HTMLInputElement>('im-account-input');
  const imApibaseInput = element<HTMLInputElement>('im-apibase-input');
  const imAllowInput = element<HTMLInputElement>('im-allow-input');
  const imCancelEditBtn = element<HTMLButtonElement>('im-cancel-edit-btn');
  const imSaveBtn = element<HTMLButtonElement>('im-save-btn');
  const imListSubtitle = element<HTMLElement>('im-list-subtitle');
  const imList = element<HTMLElement>('im-list');

  let wechatQrPollTimer: ReturnType<typeof setInterval> | undefined;
  let wechatAutoHideTimer: ReturnType<typeof setTimeout> | undefined;
  let activeWechatQrChannelId: string | undefined;
  let editingImChannelId: string | undefined;
  let tgQuickBusy = false;
  const syncingTgChannels = new Set<string>();
  let voiceBusy = false;
  let armedVoiceDeleteKey: string | undefined;
  let armedVoiceDeleteTimer: ReturnType<typeof setTimeout> | undefined;

  function clearArmedVoiceDelete() {
    if (armedVoiceDeleteTimer) {
      clearTimeout(armedVoiceDeleteTimer);
      armedVoiceDeleteTimer = undefined;
    }
    armedVoiceDeleteKey = undefined;
  }

  function armVoiceDelete(key: string): boolean {
    if (armedVoiceDeleteKey === key) {
      clearArmedVoiceDelete();
      renderVoiceprints();
      return true;
    }
    clearArmedVoiceDelete();
    armedVoiceDeleteKey = key;
    armedVoiceDeleteTimer = setTimeout(() => {
      if (armedVoiceDeleteKey === key) {
        armedVoiceDeleteKey = undefined;
        renderVoiceprints();
      }
    }, 3500);
    renderVoiceprints();
    return false;
  }

  function stopWechatQrPoll() {
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
    imWechatQrBox.hidden = true;
  }

  async function startWechatQrFromUi(channelId?: string, channelName?: string) {
    stopWechatQrPoll();
    activeWechatQrChannelId = channelId;
    imWechatQrBox.hidden = false;
    imWechatQrTitle.textContent = channelName ? `微信扫码绑定 · ${channelName}` : '微信扫码绑定 F.R.I.D.A.Y.';
    imWechatQrStatus.textContent = '⏳ 正在向腾讯 iLink 申请微信登录二维码…';
    imWechatQrRefresh.disabled = true;
    try {
      const session = await api<WechatQrLoginSession>('/api/im-wechat-qr-start', {
        ...(channelId ? { id: channelId } : {}),
        ...(channelName ? { name: channelName } : {}),
      });
      if (!SAFE_DATA_IMAGE_RE.test(session.qrSvgDataUrl)) {
        imWechatQrImg.removeAttribute('src');
        imWechatQrStatus.textContent = '❌ 二维码格式不受支持，已阻止加载，请稍后重试。';
        return;
      }
      activeWechatQrChannelId = session.channelId;
      imWechatQrImg.src = session.qrSvgDataUrl;
      imWechatQrStatus.textContent = '📱 请使用手机微信扫描左侧二维码绑定 F.R.I.D.A.Y.…';
      await hooks.refreshView();

      let pollingBusy = false;
      let consecutiveErrors = 0;
      const pollStartedAt = Date.now();
      wechatQrPollTimer = setInterval(() => {
        if (pollingBusy) return;
        if (Date.now() - pollStartedAt > WECHAT_QR_MAX_POLL_MS) {
          stopWechatQrPoll();
          imWechatQrStatus.textContent = '⚠️ 二维码轮询已超时，请点击「🔄 刷新二维码」重新获取。';
          return;
        }
        pollingBusy = true;
        void (async () => {
          try {
            const current = await api<WechatQrLoginSession>('/api/im-wechat-qr-status', {
              sessionId: session.sessionId,
            });
            consecutiveErrors = 0;
            if (current.status === 'scaned') {
              imWechatQrStatus.textContent = '📲 已扫码！请在手机微信上点击「确认登录」…';
            } else if (current.status === 'confirmed') {
              stopWechatQrPoll();
              imWechatQrStatus.textContent = `✅ 微信扫码绑定成功！(${current.accountId ?? 'iLink 实时收发已激活'})`;
              await hooks.refreshView();
              wechatAutoHideTimer = setTimeout(() => {
                wechatAutoHideTimer = undefined;
                if (!wechatQrPollTimer) imWechatQrBox.hidden = true;
              }, 2500);
            } else if (current.status === 'expired') {
              stopWechatQrPoll();
              imWechatQrStatus.textContent = '⚠️ 二维码已过期，请点击「🔄 刷新二维码」重新获取。';
            } else if (current.status === 'error') {
              stopWechatQrPoll();
              imWechatQrStatus.textContent = `❌ 二维码登录失败：${current.error || '请刷新重试'}`;
            }
          } catch (error) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= WECHAT_QR_MAX_ERRORS) {
              stopWechatQrPoll();
              imWechatQrStatus.textContent = `⚠️ 状态轮询连续失败（${errorText(error)}），请点击「🔄 刷新二维码」重试。`;
            }
          } finally {
            pollingBusy = false;
          }
        })();
      }, WECHAT_QR_POLL_INTERVAL_MS);
    } catch (error) {
      imWechatQrStatus.textContent = `获取二维码失败：${errorText(error)}`;
    } finally {
      imWechatQrRefresh.disabled = false;
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
    imVoiceToggleBtn.disabled = disabled;
    imVoiceRefreshBtn.disabled = disabled;
    imVoiceClearBtn.hidden = profiles.length === 0;
    imVoiceClearBtn.disabled = disabled;
    const clearArmed = armedVoiceDeleteKey === '__all__';
    imVoiceClearBtn.textContent = clearArmed ? '⚠️ 确认清空' : '🧹 清空全部';
    imVoiceClearBtn.className = clearArmed ? 'mini-button danger-btn is-armed' : 'mini-button danger-btn';

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
      const delArmed = armedVoiceDeleteKey === p.id;
      const delBtn = button(
        delArmed ? '⚠️ 确认删除' : '🗑️ 删除',
        () => {
          if (armVoiceDelete(p.id)) void removeVoiceprintFromUi(p.id, p.name);
        },
        delArmed ? 'mini-button danger-btn is-armed' : 'mini-button danger-btn',
      );
      delBtn.disabled = disabled;
      actions.append(delBtn);
      head.append(actions);
      card.append(head);

      const badges = node('div', '', 'hub-badges-row');
      badges.append(
        node('span', `🎙️ 样本 ${p.sampleCount} 条`, 'hub-meta-chip'),
        node('span', `🧬 ${p.dim} 维特征`, 'hub-meta-chip'),
        node('span', `🕒 更新于 ${timestamp(p.updatedAt)}`, 'hub-meta-chip'),
        node('span', `🆔 ${p.id}`, 'hub-meta-chip mono-chip'),
      );
      card.append(badges);
      listFrag.append(card);
    }
    if (!profiles.length) {
      listFrag.append(node('p', '暂未录入任何声纹。直接对小爱音箱说「你好星期五，录入我的声纹」即可完成创建。', 'empty hub-empty-state'));
    }
    imVoiceList.replaceChildren(listFrag);
  }

  async function refreshVoiceprintsFromUi(silent = false) {
    if (!silent) {
      voiceBusy = true;
      renderVoiceprints();
    }
    try {
      appState.voiceprintState = await api<VoiceprintStatusView>('/api/voiceprints');
      render();
    } catch (error) {
      if (!silent) hooks.connection(`刷新声纹状态失败：${errorText(error)}`, true);
    } finally {
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
      hooks.connection(nextEnabled ? '已启用小爱声纹防串音门控。' : '已暂停小爱声纹防串音门控。');
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`切换声纹门控失败：${errorText(error)}`, true);
    } finally {
      voiceBusy = false;
      renderVoiceprints();
    }
  }

  async function removeVoiceprintFromUi(id: string, name: string) {
    voiceBusy = true;
    clearArmedVoiceDelete();
    renderVoiceprints();
    try {
      await api<unknown>('/api/voice-remove', { target: id });
      await refreshVoiceprintsFromUi(true);
      await hooks.refreshView();
      hooks.connection(`已删除「${name}」的声纹档案。`);
    } catch (error) {
      hooks.connection(`删除声纹档案失败：${errorText(error)}`, true);
    } finally {
      voiceBusy = false;
      renderVoiceprints();
    }
  }

  async function clearVoiceprintsFromUi() {
    voiceBusy = true;
    clearArmedVoiceDelete();
    renderVoiceprints();
    try {
      await api<unknown>('/api/voice-clear', {});
      await refreshVoiceprintsFromUi(true);
      await hooks.refreshView();
      hooks.connection('已清空全部声纹档案。');
    } catch (error) {
      hooks.connection(`清空声纹档案失败：${errorText(error)}`, true);
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
    imCancelEditBtn.hidden = true;
    imSaveBtn.textContent = '💾 保存 IM 通道配置';
    imFormSummary.textContent = '+ 手动配置通道（微信 / 小爱音箱 / 钉钉 / Telegram）';
  }

  function editImChannelFromUi(ch: ImChannelView) {
    editingImChannelId = ch.id;
    imPlatformInput.value = ch.platform;
    imNameInput.value = ch.name;
    imTargetInput.value = ch.defaultTarget ?? '';
    imAccountInput.value = ch.accountId ?? '';
    imApibaseInput.value = ch.apiBase ?? '';
    imAllowInput.value = ch.allowedSenders.join(', ');
    imCancelEditBtn.hidden = false;
    imSaveBtn.textContent = `💾 更新通道「${ch.name}」`;
    imFormSummary.textContent = `✏️ 编辑通道「${ch.name}」`;
    imAddDetails.open = true;
    imNameInput.focus();
  }

  async function saveImChannelFromUi() {
    const platform = imPlatformInput.value as 'dingtalk' | 'wechat' | 'telegram' | 'xiaoai';
    const name = imNameInput.value.trim() || `${imPlatformLabels[platform] ?? platform}助手`;
    const webhookUrl = imWebhookInput.value.trim() || undefined;
    const botToken = imTokenInput.value.trim() || undefined;
    const secret = imSecretInput.value.trim() || undefined;
    const defaultTarget = imTargetInput.value.trim() || undefined;
    const accountId = imAccountInput.value.trim() || undefined;
    const apiBase = imApibaseInput.value.trim() || undefined;
    const allowedSenders = imAllowInput.value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
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
      });
      resetImChannelForm();
      imAddDetails.open = false;
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`保存 IM 通道失败：${errorText(error)}`, true);
    } finally {
      imSaveBtn.disabled = false;
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

  async function removeImChannelFromUi(id: string) {
    try {
      await api<unknown>('/api/im-remove', { id });
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`删除 IM 通道失败：${errorText(error)}`, true);
    }
  }

  async function quickConnectTelegramFromUi() {
    if (tgQuickBusy) return;
    const botToken = imTgTokenInput.value.trim();
    if (!botToken) {
      imTgQuickStatus.hidden = false;
      imTgQuickStatus.className = 'telegram-quick-status is-error';
      imTgQuickStatus.textContent = '⚠️ 请先输入从 @BotFather 获取的 Bot Token。';
      imTgTokenInput.focus();
      return;
    }
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
      hooks.connection(`Telegram Bot ${botLabel} 已一键接入并启动长轮询。`);
      await hooks.refreshView();
    } catch (error) {
      imTgQuickStatus.className = 'telegram-quick-status is-error';
      imTgQuickStatus.textContent = `❌ Telegram 接入失败：${errorText(error)}`;
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
      hooks.connection(`已为「${name}」同步 ${res.count} 项 Telegram 常见命令菜单。`);
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`同步 Telegram 命令菜单失败：${errorText(error)}`, true);
    } finally {
      syncingTgChannels.delete(id);
      render(true);
    }
  }

  function render(force = false) {
    const channels = appState.view?.imChannels ?? [];
    const activeCount = channels.filter(c => c.enabled).length;
    imTopBadge.textContent = channels.length ? `${activeCount}/${channels.length}` : '0';

    if (imHubBackdrop.hidden && !force) {
      appState.dirtyModals.add('im');
      return;
    }
    appState.dirtyModals.delete('im');

    const controlsDisabled = appState.authExpired || !appState.ready;
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
        syncBtn.disabled = controlsDisabled || syncing;
        actions.append(syncBtn);
      }
      const testBtn = button('⚡ 自检', () => { void testImChannelFromUi(ch.id); }, 'mini-button');
      const editBtn = button('✏️ 编辑', () => { editImChannelFromUi(ch); }, 'mini-button');
      const toggleBtn = button(ch.enabled ? '⏸ 暂停' : '▶️ 启用', () => { void toggleImChannelFromUi(ch.id, !ch.enabled); }, 'mini-button');
      const delBtn = button('🗑️ 删除', () => { void removeImChannelFromUi(ch.id); }, 'mini-button danger-btn');
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
          const copyBtn = button('📋 复制地址', () => {
            void navigator.clipboard?.writeText(webhookPath).then(() => {
              copyBtn.textContent = '✅ 已复制';
              setTimeout(() => { copyBtn.textContent = '📋 复制地址'; }, 1800);
            });
          }, 'mini-button');
          endpointBox.append(copyBtn);
        }
      } else {
        endpointBox.append(node('code', `回调 Webhook: ${webhookPath}`, 'hub-endpoint-code'));
        const copyBtn = button('📋 复制地址', () => {
          void navigator.clipboard?.writeText(webhookPath).then(() => {
            copyBtn.textContent = '✅ 已复制';
            setTimeout(() => { copyBtn.textContent = '📋 复制地址'; }, 1800);
          });
        }, 'mini-button');
        endpointBox.append(copyBtn);
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
      if (ch.lastInboundAt) badgesRow.append(node('span', `最近收信: ${timestamp(ch.lastInboundAt)}`, 'hub-meta-chip'));
      card.append(badgesRow);

      if (ch.lastError) card.append(node('p', `⚠️ 最近异常：${ch.lastError}`, 'error hub-error-banner'));
      contents.append(card);
    }
    if (!channels.length) {
      contents.append(node('p', '暂无 IM 通道', 'empty hub-empty-state'));
    }
    imList.replaceChildren(contents);
  }

  function openModal() {
    hooks.closeAllHubModals();
    imHubBackdrop.hidden = false;
    render(true);
    if (!appState.authExpired && appState.ready) void refreshVoiceprintsFromUi(true);
  }

  function closeModal() {
    stopWechatQrPoll();
    clearArmedVoiceDelete();
    imHubBackdrop.hidden = true;
  }

  openImHubTop.addEventListener('click', openModal);
  imModalClose.addEventListener('click', closeModal);
  imHubBackdrop.addEventListener('click', event => {
    if (event.target === imHubBackdrop) closeModal();
  });
  imCancelEditBtn.addEventListener('click', () => {
    resetImChannelForm();
    imAddDetails.open = false;
  });
  imSaveBtn.addEventListener('click', () => { void saveImChannelFromUi(); });
  imTgQuickBtn.addEventListener('click', () => { void quickConnectTelegramFromUi(); });
  const onTgQuickKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void quickConnectTelegramFromUi();
    }
  };
  imTgTokenInput.addEventListener('keydown', onTgQuickKeyDown);
  imTgAllowInput.addEventListener('keydown', onTgQuickKeyDown);
  imWechatQrBtn.addEventListener('click', () => { void startWechatQrFromUi(); });
  imWechatQrRefresh.addEventListener('click', () => { void startWechatQrFromUi(activeWechatQrChannelId); });
  imWechatQrClose.addEventListener('click', closeWechatQrFromUi);
  imVoiceRefreshBtn.addEventListener('click', () => { void refreshVoiceprintsFromUi(false); });
  imVoiceToggleBtn.addEventListener('click', () => { void toggleVoiceprintFromUi(); });
  imVoiceClearBtn.addEventListener('click', () => {
    if (armVoiceDelete('__all__')) void clearVoiceprintsFromUi();
  });

  return {
    openModal,
    closeModal,
    render,
    stopWechatQrPoll,
  };
}
