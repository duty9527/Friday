import {
  BrainIcon,
  ClockIcon,
  PlugIcon,
  RadioIcon,
  Settings2Icon,
} from 'lucide-react';
import { ImVoiceHub } from '@/components/hubs/ImVoiceHub';
import { MemoryHub } from '@/components/hubs/MemoryHub';
import { PluginHub } from '@/components/hubs/PluginHub';
import { SystemHub } from '@/components/hubs/SystemHub';
import { TimerHub } from '@/components/hubs/TimerHub';
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useFriday } from '@/lib/friday-store';

export function HubShellDialog() {
  const { activeHub, setActiveHub } = useFriday();

  return (
    <>
      <Dialog open={activeHub === 'memory'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="memory-hub-dialog"
          className="h-[min(84dvh,780px)] max-w-5xl max-sm:h-[88dvh]"
          closeProps={{ 'aria-label': '关闭窗口' }}
          finalFocus={() => document.getElementById('open-memory-hub-top')}
        >
          <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 pe-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <BrainIcon className="size-4 text-amber-500" />
              <span>全息记忆与笔记本</span>
            </DialogTitle>
          </DialogHeader>
          <div
            data-slot="dialog-panel"
            className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6 pt-1"
          >
            <MemoryHub />
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog open={activeHub === 'timer'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="timer-hub-dialog"
          className="h-[min(84dvh,780px)] max-w-4xl max-sm:h-[88dvh]"
          closeProps={{ 'aria-label': '关闭窗口' }}
          finalFocus={() => document.getElementById('open-timer-hub-top')}
        >
          <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 pe-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ClockIcon className="size-4" />
              <span>定时与目标</span>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <TimerHub />
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <Dialog open={activeHub === 'plugin'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="plugin-hub-dialog"
          className="h-[min(84dvh,780px)] max-w-6xl max-sm:h-[88dvh]"
          closeProps={{ 'aria-label': '关闭窗口' }}
          finalFocus={() => document.getElementById('open-plugin-hub-top')}
        >
          <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 pe-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <PlugIcon className="size-4" />
              <span>应用与插件</span>
            </DialogTitle>
          </DialogHeader>
          <div
            data-slot="dialog-panel"
            className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6 pt-1 max-sm:px-4 max-sm:pb-4"
          >
            <PluginHub />
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog open={activeHub === 'im'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="im-hub-dialog"
          className="h-[min(84dvh,780px)] max-w-4xl max-sm:h-[88dvh]"
          closeProps={{ 'aria-label': '关闭窗口' }}
          finalFocus={() => document.getElementById('open-im-hub-top')}
        >
          <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 pe-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <RadioIcon className="size-4" />
              <span>IM 与声纹</span>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <ImVoiceHub />
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <Dialog open={activeHub === 'system'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="system-hub-dialog"
          className="h-[min(84dvh,780px)] max-w-5xl max-sm:h-[88dvh]"
          closeProps={{ 'aria-label': '关闭窗口' }}
          finalFocus={() => document.getElementById('open-system-hub-top')}
        >
          <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 pe-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Settings2Icon className="size-4" />
              <span>系统底座</span>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <SystemHub />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
