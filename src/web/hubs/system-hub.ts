import { element } from '../shared/dom.js';
import {
  bindDialogLightDismiss,
  bindRovingTablist,
  closeModalDialog,
  isDialogOpen,
  openModalDialog,
  safeFocus,
  syncRovingTablist,
} from '../shared/ui-primitives.js';
import { hooks } from '../state.js';
import { initModelHub } from './model-hub.js';
import { initUsageHub } from './usage-hub.js';
import { initServicesHub } from './services-hub.js';

export type SystemHubTab = 'models' | 'usage' | 'services';

export interface SystemHubController {
  openModal: (tab?: SystemHubTab, focusProviderId?: string) => void;
  closeModal: () => void;
  render: (force?: boolean) => void;
  isOpen: () => boolean;
}

export function initSystemHub(): SystemHubController {
  const openSystemHubTop = element<HTMLButtonElement>('open-system-hub-top');
  const systemTopBadge = element<HTMLElement>('system-top-badge');
  const systemHubDialog = element<HTMLElement>('system-hub-dialog');
  const systemModalClose = element<HTMLButtonElement>('system-modal-close');
  const systemHubTabs = element<HTMLElement>('system-hub-tabs');
  const modelsTabBtn = element<HTMLButtonElement>('system-tab-models');
  const usageTabBtn = element<HTMLButtonElement>('system-tab-usage');
  const servicesTabBtn = element<HTMLButtonElement>('system-tab-services');
  const modelsPanel = element<HTMLElement>('system-panel-models');
  const usagePanel = element<HTMLElement>('system-panel-usage');
  const servicesPanel = element<HTMLElement>('system-panel-services');

  const lifecycleAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = lifecycleAc?.signal;

  let activeTab: SystemHubTab = 'models';
  let modelSummary: { ready: boolean; badgeText: string; detailText: string } = {
    ready: false,
    badgeText: '—',
    detailText: '模型提供方读取中',
  };
  let usageSummary: { calls: number; badgeText: string; moneyText: string; detailText: string } = {
    calls: 0,
    badgeText: '0',
    moneyText: '',
    detailText: '今日模型调用 0 次',
  };
  let servicesSummary: { configured: boolean; badgeText: string; detailText: string } = {
    configured: false,
    badgeText: '—',
    detailText: '位置服务读取中',
  };

  function syncTopBadge(): void {
    if (!modelSummary.ready && usageSummary.calls <= 0) {
      systemTopBadge.textContent = '—';
    } else if (usageSummary.calls > 0) {
      systemTopBadge.textContent = modelSummary.ready
        ? `${modelSummary.badgeText} · ${usageSummary.moneyText}`
        : usageSummary.badgeText;
    } else {
      systemTopBadge.textContent = modelSummary.badgeText;
    }
    openSystemHubTop.title = `系统底座 · ${modelSummary.detailText} · ${usageSummary.detailText} · ${servicesSummary.detailText}`;
  }

  const isVisible = (tab: SystemHubTab): boolean =>
    isDialogOpen(systemHubDialog) && activeTab === tab;

  const modelHub = initModelHub({
    isVisible: () => isVisible('models'),
    onBadgeChange: summary => {
      modelSummary = summary;
      syncTopBadge();
    },
  });

  const usageHub = initUsageHub({
    isVisible: () => isVisible('usage'),
    onBadgeChange: summary => {
      usageSummary = summary;
      syncTopBadge();
    },
  });

  const servicesHub = initServicesHub({
    isVisible: () => isVisible('services'),
    onBadgeChange: summary => {
      servicesSummary = summary;
      syncTopBadge();
    },
  });

  function tabButtonFor(tab: SystemHubTab): HTMLButtonElement {
    if (tab === 'usage') return usageTabBtn;
    if (tab === 'services') return servicesTabBtn;
    return modelsTabBtn;
  }

  function syncTabAttributes(): void {
    const isModels = activeTab === 'models';
    const isUsage = activeTab === 'usage';
    const isServices = activeTab === 'services';

    modelsTabBtn.classList.toggle('active', isModels);
    modelsPanel.hidden = !isModels;

    usageTabBtn.classList.toggle('active', isUsage);
    usagePanel.hidden = !isUsage;

    servicesTabBtn.classList.toggle('active', isServices);
    servicesPanel.hidden = !isServices;

    syncRovingTablist(systemHubTabs, tabButtonFor(activeTab));
  }

  function switchTab(nextTab: SystemHubTab, focusProviderId?: string): void {
    activeTab = nextTab;
    syncTabAttributes();
    if (nextTab === 'models') {
      modelHub.activate(focusProviderId);
    } else if (nextTab === 'usage') {
      usageHub.activate();
    } else {
      servicesHub.activate();
    }
  }

  function openModal(tab: SystemHubTab = 'models', focusProviderId?: string): void {
    if (!isDialogOpen(systemHubDialog)) {
      hooks.closeAllHubModals();
      openModalDialog(systemHubDialog);
    }
    switchTab(tab, focusProviderId);
    safeFocus(tabButtonFor(activeTab));
  }

  function closeModal(): void {
    closeModalDialog(systemHubDialog);
  }

  function render(force = false): void {
    modelHub.render(force);
    usageHub.render(force);
    servicesHub.render(force);
  }

  bindDialogLightDismiss(systemHubDialog, undefined, signal);
  bindRovingTablist(systemHubTabs, {
    onActivate: tabEl => {
      const nextTab = tabEl.dataset.systemTab as SystemHubTab | undefined;
      if (!nextTab || (nextTab === activeTab && isDialogOpen(systemHubDialog))) return;
      switchTab(nextTab);
    },
    signal,
  });

  const listenerOpts = signal ? { signal } : undefined;
  openSystemHubTop.addEventListener('click', () => openModal(activeTab), listenerOpts);
  systemModalClose.addEventListener('click', closeModal, listenerOpts);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      lifecycleAc?.abort();
    }, listenerOpts);
  }

  syncTabAttributes();

  return {
    openModal,
    closeModal,
    render,
    isOpen: () => isDialogOpen(systemHubDialog),
  };
}
