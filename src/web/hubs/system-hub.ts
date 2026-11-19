import { element } from '../shared/dom.js';
import { hooks } from '../state.js';
import { initModelHub } from './model-hub.js';
import { initUsageHub } from './usage-hub.js';

export type SystemHubTab = 'models' | 'usage';

export interface SystemHubController {
  openModal: (tab?: SystemHubTab, focusProviderId?: string) => void;
  closeModal: () => void;
  render: (force?: boolean) => void;
  isOpen: () => boolean;
}

export function initSystemHub(): SystemHubController {
  const openSystemHubTop = element<HTMLButtonElement>('open-system-hub-top');
  const systemTopBadge = element<HTMLElement>('system-top-badge');
  const systemHubBackdrop = element<HTMLElement>('system-hub-backdrop');
  const systemModalClose = element<HTMLButtonElement>('system-modal-close');
  const systemHubTabs = element<HTMLElement>('system-hub-tabs');
  const modelsTabBtn = element<HTMLButtonElement>('system-tab-models');
  const usageTabBtn = element<HTMLButtonElement>('system-tab-usage');
  const modelsPanel = element<HTMLElement>('system-panel-models');
  const usagePanel = element<HTMLElement>('system-panel-usage');

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
    openSystemHubTop.title = `系统底座 · ${modelSummary.detailText} · ${usageSummary.detailText}`;
  }

  const isVisible = (tab: SystemHubTab): boolean =>
    !systemHubBackdrop.hidden && activeTab === tab;

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

  function syncTabAttributes(): void {
    const isModels = activeTab === 'models';
    modelsTabBtn.classList.toggle('active', isModels);
    modelsTabBtn.setAttribute('aria-selected', isModels ? 'true' : 'false');
    modelsPanel.hidden = !isModels;

    usageTabBtn.classList.toggle('active', !isModels);
    usageTabBtn.setAttribute('aria-selected', isModels ? 'false' : 'true');
    usagePanel.hidden = isModels;
  }

  function switchTab(nextTab: SystemHubTab, focusProviderId?: string): void {
    activeTab = nextTab;
    syncTabAttributes();
    if (nextTab === 'models') {
      modelHub.activate(focusProviderId);
    } else {
      usageHub.activate();
    }
  }

  function openModal(tab: SystemHubTab = 'models', focusProviderId?: string): void {
    hooks.closeAllHubModals();
    systemHubBackdrop.hidden = false;
    switchTab(tab, focusProviderId);
  }

  function closeModal(): void {
    systemHubBackdrop.hidden = true;
  }

  function render(force = false): void {
    modelHub.render(force);
    usageHub.render(force);
  }

  openSystemHubTop.addEventListener('click', () => openModal(activeTab));
  systemModalClose.addEventListener('click', closeModal);
  systemHubBackdrop.addEventListener('click', event => {
    if (event.target === systemHubBackdrop) closeModal();
  });
  systemHubTabs.addEventListener('click', event => {
    const tabBtn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-system-tab]');
    const nextTab = tabBtn?.dataset.systemTab as SystemHubTab | undefined;
    if (!nextTab || (nextTab === activeTab && !systemHubBackdrop.hidden)) return;
    switchTab(nextTab);
  });

  return {
    openModal,
    closeModal,
    render,
    isOpen: () => !systemHubBackdrop.hidden,
  };
}
