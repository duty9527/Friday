import { AlertCircleIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect } from 'react';
import { ChatPanel } from '@/components/ChatPanel';
import { CommandPalette } from '@/components/CommandPalette';
import { HubShellDialog } from '@/components/HubShellDialog';
import { RoutingDetailDialog } from '@/components/RoutingDetailDialog';
import { Topbar } from '@/components/Topbar';
import { TracePanel } from '@/components/TracePanel';
import { WorksSidebar } from '@/components/WorksSidebar';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useFriday } from '@/lib/friday-store';
import { cn } from '@/lib/utils';

export function App() {
  const {
    authExpired,
    connectionStale,
    connectionText,
    reconnect,
    srStatusText,
    srAlertText,
    mobilePanel,
    setMobilePanel,
    mobileNavOpen,
    setMobileNavOpen,
    mobileWorksOpen,
    setMobileWorksOpen,
    traceWide,
    commandOpen,
    setCommandOpen,
    activeHub,
    routingDetailMessageId,
  } = useFriday();

  // Global Cmd+K / Ctrl+K shortcut & Escape layering
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(!commandOpen);
        return;
      }
      if (event.key === 'Escape') {
        if (activeHub || routingDetailMessageId || commandOpen) return;
        if (mobileNavOpen) {
          setMobileNavOpen(false);
        } else if (mobileWorksOpen) {
          setMobileWorksOpen(false);
        } else if (
          typeof window.matchMedia === 'function'
          && window.matchMedia('(max-width: 1023px)').matches
          && mobilePanel === 'trace'
        ) {
          setMobilePanel('chat');
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    activeHub,
    commandOpen,
    mobileNavOpen,
    mobilePanel,
    mobileWorksOpen,
    routingDetailMessageId,
    setCommandOpen,
    setMobileNavOpen,
    setMobilePanel,
    setMobileWorksOpen,
  ]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <a
        href="#main-content"
        className="skip-link sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-1.5 focus:text-xs focus:font-medium focus:shadow-md"
      >
        跳到主内容
      </a>
      <div id="sr-status-live" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {srStatusText}
      </div>
      <div id="sr-alert-live" className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {srAlertText}
      </div>

      <Topbar />

      <div id="connection-banner" hidden={!connectionStale} className="shrink-0 border-b px-3 py-2">
        <Alert variant={authExpired ? 'error' : 'warning'} className="mx-auto max-w-4xl py-2">
          <AlertCircleIcon />
          <AlertDescription id="connection" className="text-xs">
            {connectionText}
          </AlertDescription>
          <AlertAction>
            <Button
              id="reconnect"
              type="button"
              size="xs"
              variant="outline"
              disabled={authExpired}
              onClick={reconnect}
            >
              <RefreshCwIcon className="size-3" />
              <span>重新连接</span>
            </Button>
          </AlertAction>
        </Alert>
      </div>

      {/* Mobile / Tablet Panel Switcher (Chat vs Execution Trace) */}
      <nav
        aria-label="面板导航"
        className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-3 py-1.5 lg:hidden"
      >
        <Button
          id="show-chat"
          type="button"
          size="xs"
          variant={mobilePanel === 'chat' ? 'secondary' : 'ghost'}
          aria-pressed={mobilePanel === 'chat'}
          className={cn('flex-1', mobilePanel === 'chat' && 'bg-background shadow-2xs')}
          onClick={() => setMobilePanel('chat')}
        >
          主对话
        </Button>
        <Button
          id="show-trace"
          type="button"
          size="xs"
          variant={mobilePanel === 'trace' ? 'secondary' : 'ghost'}
          aria-pressed={mobilePanel === 'trace'}
          className={cn('flex-1', mobilePanel === 'trace' && 'bg-background shadow-2xs')}
          onClick={() => setMobilePanel('trace')}
        >
          执行链路
        </Button>
      </nav>

      {/* Main 3-Column Stage */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorksSidebar />
        <div
          id="panels"
          className={cn(
            'flex min-h-0 min-w-0 flex-1 overflow-hidden',
            traceWide && 'trace-wide',
          )}
        >
          <div className={cn('min-h-0 min-w-0 flex-1', mobilePanel === 'trace' ? 'hidden lg:flex' : 'flex')}>
            <ChatPanel />
          </div>
          <TracePanel />
        </div>
      </div>

      <RoutingDetailDialog />
      <HubShellDialog />
      <CommandPalette />
    </div>
  );
}
