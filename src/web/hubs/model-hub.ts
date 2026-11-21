import type { ModelHubView, ModelProbeResult, ModelProviderView } from '../../view.js';
import { button, element, kpiCard, node } from '../shared/dom.js';
import { errorText } from '../shared/format.js';
import { api, appState, hooks } from '../state.js';

export interface ModelHubOptions {
  isVisible: () => boolean;
  onBadgeChange?: (summary: { ready: boolean; badgeText: string; detailText: string }) => void;
}

export interface ModelHubController {
  activate: (focusProviderId?: string) => void;
  render: (force?: boolean) => void;
}

function hasVisibleProbeResult(container: HTMLElement): boolean {
  for (const el of container.querySelectorAll<HTMLElement>('.model-probe-result')) {
    if (!el.hidden) return true;
  }
  return false;
}

export function initModelHub(options: ModelHubOptions): ModelHubController {
  const modelTopBadge = element<HTMLElement>('model-top-badge');
  const modelCurrentStatus = element<HTMLElement>('model-current-status');
  const modelProvidersList = element<HTMLElement>('model-providers-list');
  const modalProviderTabs = element<HTMLElement>('modal-provider-tabs');
  const modalAuthProviderTitle = element<HTMLElement>('modal-auth-provider-title');
  const modalAuthStatusBadge = element<HTMLElement>('modal-auth-status-badge');
  const modalAuthToggleBtn = element<HTMLButtonElement>('modal-auth-toggle-btn');
  const modalAuthKeyInput = element<HTMLInputElement>('modal-auth-key-input');
  const modalAuthBaseurlInput = element<HTMLInputElement>('modal-auth-baseurl-input');
  const modalAuthCustomModelsInput = element<HTMLInputElement>('modal-auth-custom-models-input');
  const modalAuthModelSource = element<HTMLElement>('modal-auth-model-source');
  const modalAuthTestModelSelect = element<HTMLSelectElement>('modal-auth-test-model-select');
  const modalAuthFetchBtn = element<HTMLButtonElement>('modal-auth-fetch-btn');
  const modalAuthTestBtn = element<HTMLButtonElement>('modal-auth-test-btn');
  const modalAuthSaveTestBtn = element<HTMLButtonElement>('modal-auth-save-test-btn');
  const modalAuthClearBtn = element<HTMLButtonElement>('modal-auth-clear-btn');
  const modalAuthProbeResult = element<HTMLElement>('modal-auth-probe-result');
  const modalAuthPoolSummary = element<HTMLElement>('modal-auth-pool-summary');
  const modalAuthPoolList = element<HTMLElement>('modal-auth-pool-list');
  const modalAuthPoolSaveBtn = element<HTMLButtonElement>('modal-auth-pool-save-btn');
  const modalCustomProviderDetails = element<HTMLDetailsElement>('modal-custom-provider-details');
  const customProvIdInput = element<HTMLInputElement>('custom-prov-id-input');
  const customProvNameInput = element<HTMLInputElement>('custom-prov-name-input');
  const customProvUrlInput = element<HTMLInputElement>('custom-prov-url-input');
  const customProvKeyInput = element<HTMLInputElement>('custom-prov-key-input');
  const customProvModelsInput = element<HTMLInputElement>('custom-prov-models-input');
  const customProvSaveBtn = element<HTMLButtonElement>('custom-prov-save-btn');
  const modalSaveRoutingBtn = element<HTMLButtonElement>('modal-save-routing-btn');
  const modalRouterProviderSelect = element<HTMLSelectElement>('modal-router-provider-select');
  const modalRouterModelSelect = element<HTMLSelectElement>('modal-router-model-select');
  const modalTestRouterBtn = element<HTMLButtonElement>('modal-test-router-btn');
  const modalRouterProbeResult = element<HTMLElement>('modal-router-probe-result');
  const modelPoolSubtitle = element<HTMLElement>('model-pool-subtitle');
  const modelPoolMatrix = element<HTMLElement>('model-pool-matrix');

  let activeAuthProviderTab = 'deepseek';
  let lastModalAuthProvId = '';
  let lastSyncedModalBaseUrl = '';
  let modalAuthOpSeq = 0;
  let modalToggleBusy = false;
  let modalPoolSaveBusy = false;
  let modalFetchBusy = false;
  let modalTestBusy = false;
  let customProvBusy = false;
  let modalClearBusy = false;
  let modalRoutingSaveBusy = false;
  let modalRouterProbeBusy = false;

  function syncAuthActionStates() {
    const blocked = appState.authExpired || !appState.ready;
    const hub = appState.view?.modelHub;
    const currentProv = hub?.providers.find(p => p.id === activeAuthProviderTab);
    const isDisabled = currentProv?.enabled === false;
    const hasPoolRows = modalAuthPoolList.querySelectorAll('.modal-pool-select-row').length > 0;
    modalAuthToggleBtn.disabled = blocked || modalToggleBusy || !currentProv;
    modalAuthFetchBtn.disabled = blocked || modalFetchBusy || !currentProv || isDisabled;
    modalAuthTestBtn.disabled = blocked || modalTestBusy || !currentProv || isDisabled;
    modalAuthSaveTestBtn.disabled = blocked || modalTestBusy;
    modalAuthClearBtn.disabled = blocked || modalClearBusy;
    modalAuthPoolSaveBtn.disabled = blocked || modalPoolSaveBusy || !hasPoolRows;
    customProvSaveBtn.disabled = blocked || customProvBusy;
    modalSaveRoutingBtn.disabled = blocked || modalRoutingSaveBusy;
    modalTestRouterBtn.disabled = blocked || modalRouterProbeBusy;
  }

  function providerStatusText(prov: ModelProviderView): string {
    const prefix = prov.enabled === false ? '🚫 已禁用 · ' : '';
    if (prov.authType === 'oauth') return `${prefix}✅ OAuth 已授权`;
    if (prov.authType === 'api_key') return `${prefix}✅ Key 已保存 (${prov.keyHint ?? '已配置'})`;
    if (prov.authType === 'environment') return `${prefix}✅ 环境变量凭据`;
    if (prov.baseUrl) return `${prefix}🌐 自定义网关 (${prov.baseUrl})`;
    return `${prefix}⚠️ 未配置凭据`;
  }

  function renderProbeInto(container: HTMLElement, probe: ModelProbeResult | undefined) {
    if (!probe) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    container.hidden = false;
    container.replaceChildren();
    container.className = `model-probe-result ${probe.ok ? 'probe-ok' : 'probe-err'}`;
    const head = node(
      'p',
      `${probe.ok ? '✅ 连通正常' : '❌ 探针异常'} · ${probe.provider}/${probe.model} · 延迟 ${probe.latencyMs}ms · ${probe.supportsImages ? '🖼️ 支持多模态看图' : '📝 纯文本模型'}`,
      probe.ok ? 'probe-title-ok' : 'error',
    );
    const body = node(
      'p',
      probe.ok ? `模型响应：${probe.reply ?? '响应成功'}` : `错误详情：${probe.error ?? '请求失败'}`,
      probe.ok ? 'memory-preview' : 'error',
    );
    container.append(head, body);
  }

  function populateProviderSelect(selectEl: HTMLSelectElement, providers: ModelProviderView[], selectedId: string) {
    const frag = document.createDocumentFragment();
    for (const prov of providers) {
      const opt = document.createElement('option');
      opt.value = prov.id;
      const disabled = prov.enabled === false;
      opt.disabled = disabled;
      opt.textContent = `${prov.name}${disabled ? ' (已禁用)' : (prov.configured ? ' ✓' : '')}`;
      if (prov.id === selectedId) opt.selected = true;
      frag.append(opt);
    }
    selectEl.replaceChildren(frag);
    if ([...selectEl.options].some(o => o.value === selectedId)) selectEl.value = selectedId;
  }

  function populateModelSelect(selectEl: HTMLSelectElement, prov: ModelProviderView | undefined, selectedModelId?: string) {
    const frag = document.createDocumentFragment();
    const models = prov?.models ?? [];
    const hasSelected = Boolean(selectedModelId && models.some(m => m.id === selectedModelId));
    if (selectedModelId && !hasSelected) {
      const customOpt = document.createElement('option');
      customOpt.value = selectedModelId;
      customOpt.textContent = `${selectedModelId}（当前指定）`;
      customOpt.selected = true;
      frag.append(customOpt);
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const visionTag = m.supportsImages ? '🖼️看图' : '📝文本';
      const ctxTag = `${Math.round(m.contextWindow / 1000)}K`;
      const priceTag = m.costInput > 0 ? `$${m.costInput}/$${m.costOutput}` : '免费/内置';
      opt.textContent = `${m.id} — ${m.name} (${visionTag} · ${ctxTag} · ${priceTag})`;
      if (m.id === selectedModelId) opt.selected = true;
      frag.append(opt);
    }
    selectEl.replaceChildren(frag);
    if (selectedModelId && [...selectEl.options].some(o => o.value === selectedModelId)) {
      selectEl.value = selectedModelId;
    }
  }

  function renderModalPoolSelection(prov: ModelProviderView) {
    const selected = new Set((prov.selectedModels ?? []).map(item => item.id));
    modalAuthPoolSummary.textContent = `Worker 模型池：已勾选 ${selected.size} 款`;
    const ids = [...new Set([...prov.models.map(m => m.id), ...selected])];
    const frag = document.createDocumentFragment();
    for (const id of ids) {
      const row = node('div', '', 'modal-pool-select-row');
      row.dataset.modelId = id;
      const label = node('label', '', 'hub-checkbox-label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(id);
      const modelInfo = prov.models.find(m => m.id === id);
      const name = modelInfo?.name;
      label.append(checkbox, node('span', name && name !== id ? `${id} — ${name}` : id));
      const nativeLevels = modelInfo?.thinkingLevels?.length ? modelInfo.thinkingLevels : ['off'];
      const levelsChip = node('span', `原生等级: ${nativeLevels.join(' / ')}`, 'hub-meta-chip');
      row.append(label, levelsChip);
      frag.append(row);
    }
    if (!ids.length) frag.append(node('p', '该提供方暂无可选模型，请先接入并拉取模型', 'empty hub-empty-state'));
    modalAuthPoolList.replaceChildren(frag);
    syncAuthActionStates();
  }

  function renderModalAuthSection() {
    const hub = appState.view?.modelHub;
    if (!hub) {
      syncAuthActionStates();
      return;
    }
    const providers = hub.providers;
    if (!providers.some(p => p.id === activeAuthProviderTab) && providers[0]) {
      activeAuthProviderTab = providers[0].id;
    }
    const tabsFrag = document.createDocumentFragment();
    for (const prov of providers) {
      const isCurrent = prov.id === activeAuthProviderTab;
      const statusIcon = prov.enabled === false ? '🚫' : (prov.configured ? '🟢' : '⚪');
      const tabBtn = button(
        `${statusIcon} ${prov.name} (${prov.models.length})`,
        () => {
          ++modalAuthOpSeq;
          activeAuthProviderTab = prov.id;
          modalAuthKeyInput.value = '';
          modalAuthProbeResult.hidden = true;
          renderModalAuthSection();
        },
        `modal-tab-btn${isCurrent ? ' active' : ''}`,
      );
      tabsFrag.append(tabBtn);
    }
    modalProviderTabs.replaceChildren(tabsFrag);

    const currentProv = providers.find(p => p.id === activeAuthProviderTab);
    if (!currentProv) {
      syncAuthActionStates();
      return;
    }
    const isDisabled = currentProv.enabled === false;
    modalAuthProviderTitle.textContent = currentProv.name;
    modalAuthStatusBadge.textContent = providerStatusText(currentProv);
    modalAuthStatusBadge.className = `hub-badge ${isDisabled ? 'badge-slate' : (currentProv.configured ? 'badge-green' : 'badge-amber')}`;
    modalAuthToggleBtn.textContent = isDisabled ? '▶️ 启用提供方' : '🚫 禁用提供方';
    modalAuthToggleBtn.className = `mini-button${isDisabled ? '' : ' danger-btn'}`;
    const nextBaseUrl = currentProv.baseUrl ?? '';
    if (
      currentProv.id !== lastModalAuthProvId
      || (document.activeElement !== modalAuthBaseurlInput && modalAuthBaseurlInput.value === lastSyncedModalBaseUrl)
    ) {
      modalAuthBaseurlInput.value = nextBaseUrl;
    }
    lastModalAuthProvId = currentProv.id;
    lastSyncedModalBaseUrl = nextBaseUrl;
    if (currentProv.modelSource === 'remote_api') {
      modalAuthModelSource.textContent = `🌐 远端同步 (${currentProv.models.length} 款)`;
    } else {
      modalAuthModelSource.textContent = `📦 预置目录 (${currentProv.models.length} 款)`;
    }
    const defaultTestModel = currentProv.id === 'deepseek'
      ? 'deepseek-flash'
      : (currentProv.defaultBalanced ?? currentProv.models[0]?.id);
    populateModelSelect(modalAuthTestModelSelect, currentProv, defaultTestModel);
    renderModalPoolSelection(currentProv);
  }

  function syncModalRouterModels(preferredModel?: string) {
    const hub = appState.view?.modelHub;
    if (!hub) return;
    const provId = modalRouterProviderSelect.value;
    const prov = hub.providers.find(p => p.id === provId);
    const targetModel = preferredModel
      ?? (provId === hub.routerProvider ? hub.routerModel : undefined)
      ?? (provId === 'deepseek' ? 'deepseek-flash' : prov?.defaultBalanced ?? prov?.models[0]?.id);
    populateModelSelect(modalRouterModelSelect, prov, targetModel);
  }

  async function runInlineProbe(
    provider: string,
    model: string,
    targetBox: HTMLElement,
    triggerBtn?: HTMLButtonElement,
    inlineCreds?: { apiKey?: string; baseUrl?: string },
    shouldRender: () => boolean = () => true,
  ): Promise<ModelProbeResult | undefined> {
    if (!model) return undefined;
    if (triggerBtn === modalTestRouterBtn) {
      modalRouterProbeBusy = true;
      syncAuthActionStates();
    } else if (triggerBtn) {
      triggerBtn.disabled = true;
    }
    targetBox.hidden = false;
    targetBox.replaceChildren(node('p', `⏳ 正在实测 ${provider}/${model} 连通性与响应延迟…`, 'meta'));
    try {
      const probe = await api<ModelProbeResult>('/api/model-probe', {
        provider,
        model,
        ...(inlineCreds?.apiKey ? { apiKey: inlineCreds.apiKey } : {}),
        ...(inlineCreds?.baseUrl ? { baseUrl: inlineCreds.baseUrl } : {}),
      });
      if (appState.view?.modelHub) appState.view.modelHub.lastProbe = probe;
      if (shouldRender()) renderProbeInto(targetBox, probe);
      return probe;
    } catch (error) {
      if (shouldRender()) targetBox.replaceChildren(node('p', `❌ 探针请求失败：${errorText(error)}`, 'error'));
      return undefined;
    } finally {
      if (triggerBtn === modalTestRouterBtn) {
        modalRouterProbeBusy = false;
        syncAuthActionStates();
      } else if (triggerBtn) {
        triggerBtn.disabled = appState.authExpired || !appState.ready;
      }
    }
  }

  async function toggleProviderEnabledFromUi(providerId: string, enabled: boolean) {
    modalToggleBusy = true;
    syncAuthActionStates();
    try {
      const updated = await api<ModelHubView>('/api/model-configure', { providerId, enabled });
      if (appState.view) {
        appState.view.modelHub = updated;
        appState.view.modelTiers = updated.tiers;
      }
      render(true);
      renderModalAuthSection();
      populateProviderSelect(modalRouterProviderSelect, updated.providers, updated.routerProvider);
      syncModalRouterModels(updated.routerModel);
      const provName = updated.providers.find(p => p.id === providerId)?.name ?? providerId;
      hooks.connection(enabled ? `✅ 已启用模型提供方「${provName}」` : `🚫 已禁用模型提供方「${provName}」，后续请求将无法调用该提供方`);
    } catch (error) {
      hooks.connection(`${enabled ? '启用' : '禁用'}提供方失败：${errorText(error)}`, true);
    } finally {
      modalToggleBusy = false;
      syncAuthActionStates();
    }
  }

  async function saveModalPoolSelectionFromUi() {
    const providerId = activeAuthProviderTab;
    const selectedModels: Array<{ id: string }> = [];
    for (const row of modalAuthPoolList.querySelectorAll<HTMLElement>('.modal-pool-select-row')) {
      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const id = row.dataset.modelId;
      if (id && checkbox?.checked) selectedModels.push({ id });
    }
    modalPoolSaveBusy = true;
    syncAuthActionStates();
    try {
      const updated = await api<ModelHubView>('/api/model-configure', { providerId, selectedModels });
      if (appState.view) {
        appState.view.modelHub = updated;
        appState.view.modelTiers = updated.tiers;
      }
      render(true);
      renderModalAuthSection();
      hooks.connection(`✅ 已保存「${updated.providers.find(p => p.id === providerId)?.name ?? providerId}」的 Worker 模型池勾选（${selectedModels.length} 款）`);
    } catch (error) {
      hooks.connection(`保存模型池勾选失败：${errorText(error)}`, true);
    } finally {
      modalPoolSaveBusy = false;
      syncAuthActionStates();
    }
  }

  async function fetchAuthProviderModelsFromModal() {
    const providerId = activeAuthProviderTab;
    const opSeq = ++modalAuthOpSeq;
    const apiKey = modalAuthKeyInput.value.trim() || undefined;
    const baseUrl = modalAuthBaseurlInput.value.trim() || undefined;
    modalFetchBusy = true;
    syncAuthActionStates();
    modalAuthProbeResult.hidden = false;
    modalAuthProbeResult.replaceChildren(node('p', `⏳ 正在请求 ${providerId} 官方 /models 接口拉取真实模型列表…`, 'meta'));
    try {
      const updated = await api<ModelHubView>('/api/model-fetch', {
        providerId,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
      if (appState.view) {
        appState.view.modelHub = updated;
        appState.view.modelTiers = updated.tiers;
      }
      render(true);
      renderModalAuthSection();
      syncModalRouterModels();
      if (opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId) {
        const prov = updated.providers.find(p => p.id === providerId);
        modalAuthProbeResult.hidden = false;
        modalAuthProbeResult.replaceChildren(
          node('p', `✅ 已从 ${prov?.name ?? providerId} 接口实时同步 ${prov?.models.length ?? 0} 款模型并加入 F.R.I.D.A.Y. 调度池`, 'memory-topic'),
          node('p', `返回模型：${(prov?.models ?? []).slice(0, 12).map(m => m.id).join(', ')}${(prov?.models.length ?? 0) > 12 ? ' …' : ''}`, 'memory-preview'),
        );
      }
    } catch (error) {
      if (opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId) {
        modalAuthProbeResult.hidden = false;
        modalAuthProbeResult.replaceChildren(node('p', `❌ 拉取模型列表失败：${errorText(error)}`, 'error'));
      }
    } finally {
      modalFetchBusy = false;
      syncAuthActionStates();
    }
  }

  async function testAuthProviderFromModal(saveFirst: boolean) {
    const providerId = activeAuthProviderTab;
    const opSeq = ++modalAuthOpSeq;
    const apiKey = modalAuthKeyInput.value.trim() || undefined;
    const baseUrl = modalAuthBaseurlInput.value.trim();
    const customModels = modalAuthCustomModelsInput.value.split(/[,，\s]+/).map(m => m.trim()).filter(Boolean);
    const testModel = modalAuthTestModelSelect.value;
    modalTestBusy = true;
    syncAuthActionStates();
    try {
      if (saveFirst) {
        const updated = await api<ModelHubView>('/api/model-configure', {
          providerId,
          ...(apiKey ? { apiKey } : {}),
          baseUrl,
          ...(customModels.length ? { customModels } : {}),
        });
        if (appState.view) {
          appState.view.modelHub = updated;
          appState.view.modelTiers = updated.tiers;
        }
        if (activeAuthProviderTab === providerId) {
          modalAuthKeyInput.value = '';
          modalAuthCustomModelsInput.value = '';
        }
        render(true);
        renderModalAuthSection();
        populateProviderSelect(modalRouterProviderSelect, updated.providers, updated.routerProvider);
        syncModalRouterModels();
        if (activeAuthProviderTab === providerId && [...modalAuthTestModelSelect.options].some(o => o.value === testModel)) {
          modalAuthTestModelSelect.value = testModel;
        }
      }
      if (opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId) {
        await runInlineProbe(
          providerId,
          modalAuthTestModelSelect.value || testModel,
          modalAuthProbeResult,
          undefined,
          { apiKey, baseUrl: baseUrl || undefined },
          () => opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId,
        );
      }
      await hooks.refreshView();
    } catch (error) {
      if (opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId) {
        modalAuthProbeResult.hidden = false;
        modalAuthProbeResult.replaceChildren(node('p', `❌ 保存或测试失败：${errorText(error)}`, 'error'));
      }
    } finally {
      modalTestBusy = false;
      syncAuthActionStates();
    }
  }

  async function addCustomProviderFromModal() {
    const providerId = customProvIdInput.value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const providerName = customProvNameInput.value.trim() || providerId;
    const baseUrl = customProvUrlInput.value.trim();
    const apiKey = customProvKeyInput.value.trim() || undefined;
    const customModels = customProvModelsInput.value.split(/[,，\s]+/).map(m => m.trim()).filter(Boolean);
    if (!providerId || !baseUrl) {
      hooks.connection('请填写自定义提供方 ID 和 Base URL', true);
      return;
    }
    customProvBusy = true;
    syncAuthActionStates();
    try {
      const updated = await api<ModelHubView>('/api/model-configure', {
        providerId,
        providerName,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(customModels.length ? { customModels } : {}),
      });
      if (appState.view) {
        appState.view.modelHub = updated;
        appState.view.modelTiers = updated.tiers;
      }
      ++modalAuthOpSeq;
      activeAuthProviderTab = providerId;
      customProvIdInput.value = '';
      customProvNameInput.value = '';
      customProvUrlInput.value = '';
      customProvKeyInput.value = '';
      customProvModelsInput.value = '';
      modalCustomProviderDetails.open = false;
      render(true);
      renderModalAuthSection();
      populateProviderSelect(modalRouterProviderSelect, updated.providers, updated.routerProvider);
      syncModalRouterModels();
      hooks.connection(`✅ 已添加提供方「${providerName}」并接入 F.R.I.D.A.Y. 跨方模型调度池`);
    } catch (error) {
      hooks.connection(`添加提供方失败：${errorText(error)}`, true);
    } finally {
      customProvBusy = false;
      syncAuthActionStates();
    }
  }

  async function clearAuthProviderFromModal() {
    const providerId = activeAuthProviderTab;
    const opSeq = ++modalAuthOpSeq;
    modalClearBusy = true;
    syncAuthActionStates();
    try {
      const updated = await api<ModelHubView>('/api/model-configure', {
        providerId,
        clearApiKey: true,
      });
      if (appState.view) {
        appState.view.modelHub = updated;
        appState.view.modelTiers = updated.tiers;
      }
      if (activeAuthProviderTab === providerId) {
        modalAuthKeyInput.value = '';
      }
      render(true);
      renderModalAuthSection();
      if (opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId) {
        modalAuthProbeResult.hidden = false;
        modalAuthProbeResult.replaceChildren(node('p', `已清除提供方 ${providerId} 的已存凭据。`, 'meta'));
      }
    } catch (error) {
      if (opSeq === modalAuthOpSeq && activeAuthProviderTab === providerId) {
        modalAuthProbeResult.hidden = false;
        modalAuthProbeResult.replaceChildren(node('p', `清除失败：${errorText(error)}`, 'error'));
      }
    } finally {
      modalClearBusy = false;
      syncAuthActionStates();
    }
  }

  async function saveModalRoutingFromUi() {
    const routerProvider = modalRouterProviderSelect.value;
    const routerModel = modalRouterModelSelect.value;
    modalRoutingSaveBusy = true;
    syncAuthActionStates();
    try {
      const updated = await api<ModelHubView>('/api/model-configure', {
        routerProvider,
        routerModel: `${routerProvider}/${routerModel}`,
      });
      if (appState.view) {
        appState.view.modelHub = updated;
        appState.view.modelTiers = updated.tiers;
      }
      render(true);
      hooks.connection(`✅ 已设定 F.R.I.D.A.Y. 主控模型为 ${updated.routerProvider}/${updated.routerModel}`);
    } catch (error) {
      hooks.connection(`设定 F.R.I.D.A.Y. 主控模型失败：${errorText(error)}`, true);
    } finally {
      modalRoutingSaveBusy = false;
      syncAuthActionStates();
    }
  }

  function render(force = false) {
    const hub = appState.view?.modelHub;
    const tiers = hub?.tiers ?? appState.view?.modelTiers;
    if (!hub && !tiers) {
      modelTopBadge.textContent = '—';
      options.onBadgeChange?.({
        ready: false,
        badgeText: '—',
        detailText: '模型提供方未就绪',
      });
      syncAuthActionStates();
      if (options.isVisible() || force) {
        modelCurrentStatus.replaceChildren();
      }
      return;
    }
    const configuredCount = hub?.providers.filter(p => p.configured && p.enabled !== false).length ?? 0;
    const pool = hub?.modelPool ?? [];
    const badgeText = `${configuredCount}方·${pool.length}模`;
    const routerModel = hub?.routerModel ?? tiers?.router ?? '—';
    const routerProvider = hub?.routerProvider ? `${hub.routerProvider}/` : '';
    modelTopBadge.textContent = badgeText;
    options.onBadgeChange?.({
      ready: true,
      badgeText,
      detailText: `主控 ${routerProvider}${routerModel} · 已接入 ${configuredCount} 个提供方 / ${pool.length} 款 Worker 模型`,
    });
    syncAuthActionStates();

    if (!options.isVisible() && !force) {
      return;
    }

    const disabledCount = hub?.providers.filter(p => p.enabled === false).length ?? 0;
    const totalProviders = hub?.providers.length ?? 0;
    const reasoningCount = pool.filter(m => m.reasoning || m.specialties.includes('深度推理')).length;
    const visionCount = pool.filter(m => m.supportsImages).length;
    const routerShort = hub?.routerModel ?? tiers?.router ?? '—';

    const engine = hub?.decisionEngine;
    const engineActive = Boolean(engine?.enabled && engine?.configured);
    const engineTitle = engineActive ? engine!.model : '启发式回退';
    const engineSub = engineActive
      ? `${engine!.credentialSource === 'google_provider' ? '复用 Google Key' : engine!.credentialSource === 'decision_config' ? '独立 Key' : '环境变量'}${engine!.keyHint ? ` · ${engine!.keyHint}` : ''}`
      : (engine?.enabled === false ? '已手动停用' : '接入 Google Key 后启用');
    const statusFrag = document.createDocumentFragment();
    statusFrag.append(
      kpiCard('🤖 F.R.I.D.A.Y. 主控', routerShort, hub?.routerProvider ?? '', 'accent'),
      kpiCard('🎯 Jev 决策引擎', engineTitle, engineSub, engineActive ? 'positive' : 'default'),
      kpiCard('🟢 已启用提供方', `${configuredCount} / ${totalProviders}`, disabledCount > 0 ? `已禁用 ${disabledCount} 个` : '', configuredCount > 0 ? 'positive' : 'warning'),
      kpiCard('🧩 跨方调度池', `${pool.length} 款模型`, '', pool.length > 0 ? 'positive' : 'default'),
      kpiCard('🧠 推理 / 🖼️ 看图', `${reasoningCount} / ${visionCount}`, '', 'default'),
    );
    modelCurrentStatus.replaceChildren(statusFrag);

    modelPoolSubtitle.textContent = pool.length ? `${configuredCount} 个提供方 · ${pool.length} 款模型` : '';

    // Preserve active inline probe banners inside #model-pool-matrix across background SSE ticks.
    if (force || !hasVisibleProbeResult(modelPoolMatrix)) {
      const poolFrag = document.createDocumentFragment();
      for (const item of pool) {
        const card = node('article', '', `hub-entity-card pool-card${item.tier === 'strong' ? ' is-pinned' : ' is-active'}`);
        const head = node('div', '', 'hub-card-head');
        const titleGroup = node('div', '', 'hub-card-title-group');
        const tierBadge = item.tier === 'strong'
          ? node('span', '🧠 强力', 'hub-badge badge-amber')
          : item.tier === 'fast'
            ? node('span', '⚡ 极速', 'hub-badge badge-teal')
            : node('span', '⚖️ 均衡', 'hub-badge badge-blue');
        titleGroup.append(
          node('span', item.providerName, 'hub-badge badge-green'),
          tierBadge,
          node('strong', item.modelId, 'hub-card-title'),
        );
        head.append(titleGroup);

        const probeBox = node('div', '', 'model-probe-result');
        probeBox.hidden = true;
        const probeBtn = button('⚡ 实测', () => {
          void runInlineProbe(item.providerId, item.modelId, probeBox, probeBtn);
        }, 'mini-button');
        probeBtn.disabled = appState.authExpired || !appState.ready;
        head.append(probeBtn);
        card.append(head);

        const badgesRow = node('div', '', 'hub-badges-row');
        for (const specTag of item.specialties) {
          badgesRow.append(node('span', specTag, 'hub-tag-chip'));
        }
        if (item.thinkingLevels?.length) {
          badgesRow.append(node('span', `🎚️ ${item.thinkingLevels.join('/')}`, 'hub-meta-chip'));
        }
        badgesRow.append(node('span', `📐 ${Math.round(item.contextWindow / 1000)}K 上下文`, 'hub-meta-chip'));
        if (item.latencyMs) {
          badgesRow.append(node('span', `⏱️ ${item.latencyMs}ms`, 'hub-meta-chip'));
        }
        if (item.successCount || item.failCount) {
          badgesRow.append(node('span', `📊 成 ${item.successCount ?? 0} / 败 ${item.failCount ?? 0}`, 'hub-meta-chip'));
        }
        if (item.avgQualityScore !== undefined) {
          badgesRow.append(node('span', `⭐ 均分 ${item.avgQualityScore.toFixed(2)}/3`, 'hub-meta-chip'));
        }
        card.append(badgesRow, probeBox);
        poolFrag.append(card);
      }
      if (!pool.length) {
        poolFrag.append(node('p', '暂无已就绪模型', 'empty hub-empty-state'));
      }
      modelPoolMatrix.replaceChildren(poolFrag);
    }

    const listFrag = document.createDocumentFragment();
    for (const prov of hub?.providers ?? []) {
      const isDisabled = prov.enabled === false;
      const card = node('article', '', `hub-entity-card provider-card${isDisabled ? ' is-paused' : (prov.configured ? ' is-active' : '')}`);
      const head = node('div', '', 'hub-card-head');
      const titleGroup = node('div', '', 'hub-card-title-group');
      const badgeLabel = isDisabled ? '🚫 已禁用' : (prov.configured ? '🟢 已接入' : '⚪ 待接入');
      const badgeClass = isDisabled ? 'badge-slate' : (prov.configured ? 'badge-green' : 'badge-slate');
      titleGroup.append(
        node('span', badgeLabel, `hub-badge ${badgeClass}`),
        node('strong', prov.name, 'hub-card-title'),
      );
      head.append(titleGroup);
      const actions = node('div', '', 'timer-actions');
      const toggleBtn = button(isDisabled ? '▶️ 启用' : '🚫 禁用', () => {
        void toggleProviderEnabledFromUi(prov.id, isDisabled);
      }, `mini-button${isDisabled ? '' : ' danger-btn'}`);
      const configBtn = button(prov.configured ? '⚙️ 管理凭据 ↑' : '➕ 接入提供方 ↑', () => {
        ++modalAuthOpSeq;
        activeAuthProviderTab = prov.id;
        modalAuthKeyInput.value = '';
        modalAuthCustomModelsInput.value = '';
        modalAuthProbeResult.hidden = true;
        renderModalAuthSection();
        modalProviderTabs.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 'mini-button');
      toggleBtn.disabled = appState.authExpired || !appState.ready;
      configBtn.disabled = appState.authExpired || !appState.ready;
      actions.append(toggleBtn, configBtn);
      head.append(actions);
      card.append(head);

      const srcTag = prov.modelSource === 'remote_api' ? `🌐 接口同步 (${prov.models.length} 款)` : `📦 目录模型 (${prov.models.length} 款)`;
      const badgesRow = node('div', '', 'hub-badges-row');
      badgesRow.append(
        node('span', providerStatusText(prov), 'hub-meta-chip'),
        node('span', srcTag, 'hub-meta-chip'),
      );
      card.append(badgesRow);
      listFrag.append(card);
    }
    modelProvidersList.replaceChildren(listFrag);
  }

  function activate(focusProviderId?: string) {
    const hub = appState.view?.modelHub;
    if (!hub) {
      hooks.connection('正在读取模型中心数据，请稍候…');
      return;
    }
    ++modalAuthOpSeq;
    if (focusProviderId) activeAuthProviderTab = focusProviderId;
    modalAuthKeyInput.value = '';
    modalAuthCustomModelsInput.value = '';
    modalAuthProbeResult.hidden = true;
    render(true);
    renderModalAuthSection();

    const routerProv = hub.providers.some(p => p.id === hub.routerProvider) ? hub.routerProvider : 'deepseek';
    populateProviderSelect(modalRouterProviderSelect, hub.providers, routerProv);
    syncModalRouterModels(hub.routerModel);
  }

  modalRouterProviderSelect.addEventListener('change', () => {
    modalRouterProbeResult.hidden = true;
    syncModalRouterModels();
  });
  modalAuthToggleBtn.addEventListener('click', () => {
    const currentProv = appState.view?.modelHub?.providers.find(p => p.id === activeAuthProviderTab);
    if (!currentProv) return;
    void toggleProviderEnabledFromUi(currentProv.id, currentProv.enabled === false);
  });
  modalAuthFetchBtn.addEventListener('click', () => { void fetchAuthProviderModelsFromModal(); });
  modalAuthTestBtn.addEventListener('click', () => { void testAuthProviderFromModal(false); });
  modalAuthSaveTestBtn.addEventListener('click', () => { void testAuthProviderFromModal(true); });
  modalAuthClearBtn.addEventListener('click', () => { void clearAuthProviderFromModal(); });
  modalAuthPoolSaveBtn.addEventListener('click', () => { void saveModalPoolSelectionFromUi(); });
  customProvSaveBtn.addEventListener('click', () => { void addCustomProviderFromModal(); });
  modalTestRouterBtn.addEventListener('click', () => {
    void runInlineProbe(modalRouterProviderSelect.value, modalRouterModelSelect.value, modalRouterProbeResult, modalTestRouterBtn);
  });
  modalSaveRoutingBtn.addEventListener('click', () => { void saveModalRoutingFromUi(); });

  return {
    activate,
    render,
  };
}
