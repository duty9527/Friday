import {
  ActivityIcon,
  BrainIcon,
  ClockIcon,
  CommandIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlugIcon,
  RadioIcon,
  Settings2Icon,
  SunIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { useFriday, type HubKey } from '@/lib/friday-store';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

export function Topbar() {
  const {
    view,
    activeHub,
    setActiveHub,
    leftCollapsed,
    setLeftCollapsed,
    rightCollapsed,
    setRightCollapsed,
    mobileNavOpen,
    setMobileNavOpen,
    mobileWorksOpen,
    setMobileWorksOpen,
    setCommandOpen,
  } = useFriday();

  const { preference, setPreference } = useTheme();
  const mobileNavBtnRef = useRef<HTMLButtonElement>(null);
  const mobileCloseBtnRef = useRef<HTMLButtonElement>(null);
  const wasMobileNavOpen = useRef(false);

  useEffect(() => {
    document.body.classList.toggle('mobile-nav-open', mobileNavOpen);
    const mainEl = document.getElementById('main-content');
    const sidebarEl = document.getElementById('work-sidebar');
    if (mainEl) mainEl.inert = mobileNavOpen;
    if (sidebarEl) sidebarEl.inert = mobileNavOpen;

    if (mobileNavOpen) {
      mobileCloseBtnRef.current?.focus();
    } else if (wasMobileNavOpen.current) {
      mobileNavBtnRef.current?.focus();
    }
    wasMobileNavOpen.current = mobileNavOpen;

    return () => {
      if (mainEl) mainEl.inert = false;
      if (sidebarEl) sidebarEl.inert = false;
      document.body.classList.remove('mobile-nav-open');
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 1023px)');
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) {
        setMobileNavOpen(false);
        setMobileWorksOpen(false);
      }
    };
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [setMobileNavOpen, setMobileWorksOpen]);

  const memoryBadgeCount =
    (view?.memoryDirectory?.totalActive ?? 0) +
    (view?.notebookSummary?.noteCount ?? 0) +
    (view?.notebookSummary?.diaryCount ?? 0);
  const timerBadgeCount = (view?.timers ?? []).filter(t => t.enabled).length;
  const pluginBadgeCount = (view?.plugins ?? []).filter(p => p.enabled !== false).length;
  const imBadgeCount = (view?.imChannels ?? []).filter(c => c.enabled).length;
  const sysBadgeText = view?.modelHub?.mode === 'real' ? 'REAL' : view?.modelHub ? 'OFF' : '—';

  const openHub = (hub: HubKey) => {
    setMobileNavOpen(false);
    setActiveHub(hub);
  };

  return (
    <>
      <header
        id="app-topbar"
        className="flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur-sm"
      >
        {/* Left: Brand & Work drawer toggle */}
        <div className="flex min-w-0 items-center gap-2">
          <Button
            ref={mobileNavBtnRef}
            id="mobile-nav-btn"
            type="button"
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="打开导航菜单"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
          >
            <MenuIcon className="size-4" />
          </Button>

          <div className="flex items-center gap-2 select-none">
            <span className="size-2 rounded-full bg-amber-500 shadow-[0_0_8px_var(--color-amber-500)]" aria-hidden="true" />
            <span className="font-semibold text-sm tracking-tight">F.R.I.D.A.Y.</span>
          </div>

          <Separator orientation="vertical" className="hidden h-4 lg:block" />

          <Button
            id="desktop-work-fold"
            type="button"
            variant="ghost"
            size="xs"
            className="hidden lg:inline-flex"
            aria-pressed={leftCollapsed}
            title="收起或展开左侧任务舱"
            onClick={() => setLeftCollapsed(!leftCollapsed)}
          >
            {leftCollapsed ? <PanelLeftOpenIcon className="size-3.5" /> : <PanelLeftCloseIcon className="size-3.5" />}
            <span>任务舱</span>
          </Button>
        </div>

        {/* Center: M1 ~ M4 Primitives */}
        <nav
          className="topbar-hub-bar hidden items-center gap-1 md:flex"
          role="toolbar"
          aria-label="系统功能中心"
        >
          <Button
            id="open-memory-hub-top"
            type="button"
            variant={activeHub === 'memory' ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => openHub('memory')}
          >
            <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400" aria-hidden="true">M1</span>
            <BrainIcon className="size-3.5" />
            <span className="hidden xl:inline">全息记忆</span>
            <span className="xl:hidden">记忆</span>
            <Badge id="memory-top-badge" variant="secondary" size="sm" className="font-mono">
              {memoryBadgeCount}
            </Badge>
          </Button>

          <Button
            id="open-timer-hub-top"
            type="button"
            variant={activeHub === 'timer' ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => openHub('timer')}
          >
            <span className="font-mono text-[10px] text-muted-foreground" aria-hidden="true">M2</span>
            <ClockIcon className="size-3.5" />
            <span className="hidden xl:inline">定时与目标</span>
            <span className="xl:hidden">定时</span>
            <Badge id="timer-top-badge" variant="secondary" size="sm" className="font-mono">
              {timerBadgeCount}
            </Badge>
          </Button>

          <Button
            id="open-plugin-hub-top"
            type="button"
            variant={activeHub === 'plugin' ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => openHub('plugin')}
          >
            <span className="font-mono text-[10px] text-muted-foreground" aria-hidden="true">M3</span>
            <PlugIcon className="size-3.5" />
            <span className="hidden xl:inline">应用与插件</span>
            <span className="xl:hidden">插件</span>
            <Badge id="plugin-top-badge" variant="secondary" size="sm" className="font-mono">
              {pluginBadgeCount}
            </Badge>
          </Button>

          <Button
            id="open-im-hub-top"
            type="button"
            variant={activeHub === 'im' ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => openHub('im')}
          >
            <span className="font-mono text-[10px] text-muted-foreground" aria-hidden="true">M4</span>
            <RadioIcon className="size-3.5" />
            <span className="hidden xl:inline">IM 与声纹</span>
            <span className="xl:hidden">IM</span>
            <Badge id="im-top-badge" variant="secondary" size="sm" className="font-mono">
              {imBadgeCount}
            </Badge>
          </Button>
        </nav>

        {/* Right: Command Palette, SYS, Theme, Trace Fold */}
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="hidden lg:inline-flex gap-1.5 text-muted-foreground"
            onClick={() => setCommandOpen(true)}
            title="打开命令面板 (⌘K / Ctrl+K)"
          >
            <CommandIcon className="size-3" />
            <span>命令</span>
            <Kbd>⌘K</Kbd>
          </Button>

          <Button
            id="open-system-hub-top"
            type="button"
            variant={activeHub === 'system' ? 'secondary' : 'ghost'}
            size="xs"
            title="系统底座：模型与提供方、用量账本、位置与地图底座"
            onClick={() => openHub('system')}
          >
            <span className="font-mono text-[10px] text-muted-foreground" aria-hidden="true">SYS</span>
            <Settings2Icon className="size-3.5" />
            <span className="hidden sm:inline">系统底座</span>
            <Badge id="system-top-badge" variant="outline" size="sm" className="font-mono">
              {sysBadgeText}
            </Badge>
          </Button>

          <div
            id="theme-switcher"
            role="group"
            aria-label="界面视觉风格切换"
            className="hidden items-center rounded-lg border bg-muted/50 p-0.5 sm:inline-flex"
          >
            <Button
              id="theme-system-btn"
              type="button"
              size="xs"
              variant={preference === 'system' ? 'secondary' : 'ghost'}
              aria-pressed={preference === 'system'}
              title="跟随系统外观"
              className={cn('h-6 px-2', preference === 'system' && 'bg-background shadow-xs')}
              onClick={() => setPreference('system')}
            >
              <MonitorIcon className="size-3" />
              <span className="hidden xl:inline">系统</span>
            </Button>
            <Button
              id="theme-light-btn"
              type="button"
              size="xs"
              variant={preference === 'light' ? 'secondary' : 'ghost'}
              aria-pressed={preference === 'light'}
              title="浅色模式"
              className={cn('h-6 px-2', preference === 'light' && 'bg-background shadow-xs')}
              onClick={() => setPreference('light')}
            >
              <SunIcon className="size-3" />
              <span className="hidden xl:inline">浅色</span>
            </Button>
            <Button
              id="theme-dark-btn"
              type="button"
              size="xs"
              variant={preference === 'dark' ? 'secondary' : 'ghost'}
              aria-pressed={preference === 'dark'}
              title="深色模式"
              className={cn('h-6 px-2', preference === 'dark' && 'bg-background shadow-xs')}
              onClick={() => setPreference('dark')}
            >
              <MoonIcon className="size-3" />
              <span className="hidden xl:inline">深色</span>
            </Button>
          </div>

          <Button
            id="work-toggle"
            type="button"
            variant="outline"
            size="xs"
            className="lg:hidden"
            aria-expanded={mobileWorksOpen}
            aria-controls="work-sidebar"
            onClick={() => setMobileWorksOpen(!mobileWorksOpen)}
          >
            <ActivityIcon className="size-3.5" />
            <span>任务</span>
          </Button>

          <Button
            id="desktop-trace-fold"
            type="button"
            variant="ghost"
            size="xs"
            className="hidden lg:inline-flex"
            aria-pressed={rightCollapsed}
            title="收起或展开右侧执行链路"
            onClick={() => setRightCollapsed(!rightCollapsed)}
          >
            <span>执行链路</span>
            {rightCollapsed ? <PanelRightOpenIcon className="size-3.5" /> : <PanelRightCloseIcon className="size-3.5" />}
          </Button>
        </div>
      </header>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div
          id="mobile-nav-scrim"
          className="fixed inset-0 z-50 flex md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="功能导航菜单"
        >
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative z-10 flex h-full w-72 max-w-[85vw] flex-col gap-3 border-e bg-popover p-4 text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-amber-500" aria-hidden="true" />
                <span className="font-semibold text-sm">F.R.I.D.A.Y.</span>
              </div>
              <Button
                ref={mobileCloseBtnRef}
                id="mobile-nav-close"
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="关闭功能菜单"
                onClick={() => setMobileNavOpen(false)}
              >
                <XIcon className="size-4" />
              </Button>
            </div>

            <div className="flex flex-col gap-1">
              <Button variant="ghost" size="sm" className="justify-between" onClick={() => openHub('memory')}>
                <span className="flex items-center gap-2"><BrainIcon className="size-4 text-amber-500" />M1 全息记忆</span>
                <Badge variant="secondary" size="sm">{memoryBadgeCount}</Badge>
              </Button>
              <Button variant="ghost" size="sm" className="justify-between" onClick={() => openHub('timer')}>
                <span className="flex items-center gap-2"><ClockIcon className="size-4" />M2 定时与目标</span>
                <Badge variant="secondary" size="sm">{timerBadgeCount}</Badge>
              </Button>
              <Button variant="ghost" size="sm" className="justify-between" onClick={() => openHub('plugin')}>
                <span className="flex items-center gap-2"><PlugIcon className="size-4" />M3 应用与插件</span>
                <Badge variant="secondary" size="sm">{pluginBadgeCount}</Badge>
              </Button>
              <Button variant="ghost" size="sm" className="justify-between" onClick={() => openHub('im')}>
                <span className="flex items-center gap-2"><RadioIcon className="size-4" />M4 IM 与声纹</span>
                <Badge variant="secondary" size="sm">{imBadgeCount}</Badge>
              </Button>
              <Separator className="my-1" />
              <Button variant="ghost" size="sm" className="justify-between" onClick={() => openHub('system')}>
                <span className="flex items-center gap-2"><Settings2Icon className="size-4" />SYS 系统底座</span>
                <Badge variant="outline" size="sm">{sysBadgeText}</Badge>
              </Button>
            </div>

            <div className="mt-auto border-t pt-3">
              <div className="mb-2 text-xs text-muted-foreground">视觉主题</div>
              <div className="grid grid-cols-3 gap-1">
                <Button size="xs" variant={preference === 'system' ? 'secondary' : 'outline'} onClick={() => setPreference('system')}>系统</Button>
                <Button size="xs" variant={preference === 'light' ? 'secondary' : 'outline'} onClick={() => setPreference('light')}>浅色</Button>
                <Button size="xs" variant={preference === 'dark' ? 'secondary' : 'outline'} onClick={() => setPreference('dark')}>深色</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
