import {
  ArrowUpRightIcon,
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
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useFriday } from '@/lib/friday-store';

export function HubShellDialog() {
  const { activeHub, setActiveHub } = useFriday();

  return (
    <>
      {/* M1: 全息记忆（突触矩阵 + 记事本 + F.R.I.D.A.Y. 日记） */}
      <Dialog open={activeHub === 'memory'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="memory-hub-dialog"
          className="max-w-5xl"
          finalFocus={() => document.getElementById('open-memory-hub-top')}
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 pe-8">
            <DialogTitle className="flex items-center gap-2 text-base">
              <BrainIcon className="size-4 text-amber-500" />
              <span>M1 · 全息记忆与笔记本</span>
            </DialogTitle>
            <Button size="xs" variant="ghost" render={<a href="/legacy" />}>
              <span>经典控制台</span>
              <ArrowUpRightIcon className="size-3" />
            </Button>
          </DialogHeader>
          <DialogPanel>
            <MemoryHub />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button size="sm" variant="outline" onClick={() => setActiveHub(null)}>关闭</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* M2: 定时与目标 */}
      <Dialog open={activeHub === 'timer'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="timer-hub-dialog"
          className="max-w-4xl"
          finalFocus={() => document.getElementById('open-timer-hub-top')}
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 pe-8">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ClockIcon className="size-4" />
              <span>M2 · 定时与目标</span>
            </DialogTitle>
            <Button size="xs" variant="ghost" render={<a href="/legacy" />}>
              <span>经典控制台</span>
              <ArrowUpRightIcon className="size-3" />
            </Button>
          </DialogHeader>
          <DialogPanel>
            <TimerHub />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button size="sm" variant="outline" onClick={() => setActiveHub(null)}>关闭</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* M3: 应用与插件 */}
      <Dialog open={activeHub === 'plugin'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="plugin-hub-dialog"
          className="max-w-6xl"
          finalFocus={() => document.getElementById('open-plugin-hub-top')}
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 pe-8">
            <DialogTitle className="flex items-center gap-2 text-base">
              <PlugIcon className="size-4" />
              <span>M3 · 应用与插件</span>
            </DialogTitle>
            <Button size="xs" variant="ghost" render={<a href="/legacy" />}>
              <span>经典控制台</span>
              <ArrowUpRightIcon className="size-3" />
            </Button>
          </DialogHeader>
          <DialogPanel>
            <PluginHub />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button size="sm" variant="outline" onClick={() => setActiveHub(null)}>关闭</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* M4: IM 与声纹 */}
      <Dialog open={activeHub === 'im'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="im-hub-dialog"
          className="max-w-4xl"
          finalFocus={() => document.getElementById('open-im-hub-top')}
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 pe-8">
            <DialogTitle className="flex items-center gap-2 text-base">
              <RadioIcon className="size-4" />
              <span>M4 · IM 与声纹</span>
            </DialogTitle>
            <Button size="xs" variant="ghost" render={<a href="/legacy" />}>
              <span>经典控制台</span>
              <ArrowUpRightIcon className="size-3" />
            </Button>
          </DialogHeader>
          <DialogPanel>
            <ImVoiceHub />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button size="sm" variant="outline" onClick={() => setActiveHub(null)}>关闭</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* SYS: 系统底座 */}
      <Dialog open={activeHub === 'system'} onOpenChange={open => { if (!open) setActiveHub(null); }}>
        <DialogPopup
          id="system-hub-dialog"
          className="max-w-5xl"
          finalFocus={() => document.getElementById('open-system-hub-top')}
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 pe-8">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Settings2Icon className="size-4" />
              <span>SYS · 系统底座</span>
            </DialogTitle>
            <Button size="xs" variant="ghost" render={<a href="/legacy" />}>
              <span>经典控制台</span>
              <ArrowUpRightIcon className="size-3" />
            </Button>
          </DialogHeader>
          <DialogPanel>
            <SystemHub />
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button size="sm" variant="outline" onClick={() => setActiveHub(null)}>关闭</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
