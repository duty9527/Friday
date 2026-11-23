import {
  ActivityIcon,
  BrainIcon,
  ClockIcon,
  CompassIcon,
  ExternalLinkIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlugIcon,
  RadioIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SunIcon,
} from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useFriday } from '@/lib/friday-store';
import { useTheme } from '@/lib/theme';

interface CommandActionItem {
  value: string;
  label: string;
  group: 'navigation' | 'workspace' | 'theme' | 'works';
  icon: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
}

export function CommandPalette() {
  const {
    commandOpen,
    setCommandOpen,
    setActiveHub,
    leftCollapsed,
    setLeftCollapsed,
    rightCollapsed,
    setRightCollapsed,
    detailMode,
    setDetailMode,
    works,
    selectTrace,
    setMobilePanel,
  } = useFriday();

  const { setPreference } = useTheme();

  const items: CommandActionItem[] = [
    {
      value: 'hub-m1-memory',
      label: '打开全息记忆与笔记本',
      group: 'navigation',
      icon: <BrainIcon className="size-4 text-amber-500" />,
      onSelect: () => setActiveHub('memory'),
    },
    {
      value: 'hub-m2-timer',
      label: '打开定时与目标',
      group: 'navigation',
      icon: <ClockIcon className="size-4" />,
      onSelect: () => setActiveHub('timer'),
    },
    {
      value: 'hub-m3-plugin',
      label: '打开应用与插件',
      group: 'navigation',
      icon: <PlugIcon className="size-4" />,
      onSelect: () => setActiveHub('plugin'),
    },
    {
      value: 'hub-m4-im',
      label: '打开 IM 与声纹',
      group: 'navigation',
      icon: <RadioIcon className="size-4" />,
      onSelect: () => setActiveHub('im'),
    },
    {
      value: 'hub-sys-system',
      label: '打开系统底座',
      group: 'navigation',
      icon: <Settings2Icon className="size-4" />,
      onSelect: () => setActiveHub('system'),
    },
    {
      value: 'page-mindmap',
      label: '前往会话思考流程图',
      group: 'navigation',
      icon: <CompassIcon className="size-4" />,
      onSelect: () => { window.location.assign('/mindmap'); },
    },
    {
      value: 'page-legacy',
      label: '打开经典控制台',
      group: 'navigation',
      icon: <ExternalLinkIcon className="size-4" />,
      onSelect: () => { window.location.assign('/legacy'); },
    },
    {
      value: 'ws-toggle-left',
      label: leftCollapsed ? '展开左侧任务舱' : '收起左侧任务舱',
      group: 'workspace',
      icon: <PanelLeftIcon className="size-4" />,
      onSelect: () => setLeftCollapsed(!leftCollapsed),
    },
    {
      value: 'ws-toggle-right',
      label: rightCollapsed ? '展开右侧执行链路' : '收起右侧执行链路',
      group: 'workspace',
      icon: <PanelRightIcon className="size-4" />,
      onSelect: () => setRightCollapsed(!rightCollapsed),
    },
    {
      value: 'ws-toggle-detail',
      label: detailMode ? '关闭审计详情模式' : '开启审计详情模式',
      group: 'workspace',
      icon: <SlidersHorizontalIcon className="size-4" />,
      onSelect: () => setDetailMode(!detailMode),
    },
    {
      value: 'theme-system',
      label: '主题：跟随系统',
      group: 'theme',
      icon: <MonitorIcon className="size-4" />,
      onSelect: () => setPreference('system'),
    },
    {
      value: 'theme-light',
      label: '主题：切换浅色模式',
      group: 'theme',
      icon: <SunIcon className="size-4" />,
      onSelect: () => setPreference('light'),
    },
    {
      value: 'theme-dark',
      label: '主题：切换深色模式',
      group: 'theme',
      icon: <MoonIcon className="size-4" />,
      onSelect: () => setPreference('dark'),
    },
    ...works.slice(0, 12).map(w => ({
      value: `work-${w.id}`,
      label: `查看任务：${w.prompt || w.id}`,
      group: 'works' as const,
      icon: <ActivityIcon className="size-4" />,
      shortcut: w.status,
      onSelect: () => {
        selectTrace({ type: 'task', id: w.id, label: w.prompt }, true);
        setMobilePanel('trace');
      },
    })),
  ];

  const groups: Array<{ id: CommandActionItem['group']; label: string }> = [
    { id: 'navigation', label: '系统中心与视图' },
    { id: 'workspace', label: '工作台布局' },
    { id: 'theme', label: '外观主题' },
    { id: 'works', label: '近期任务' },
  ];

  return (
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandDialogPopup aria-label="F.R.I.D.A.Y. 命令面板">
        <Command items={items}>
          <CommandInput placeholder="搜索功能、任务或切换主题…" />
          <CommandEmpty>没有找到匹配的命令</CommandEmpty>
          <CommandList>
            {groups.map((grp, gIdx) => {
              const groupItems = items.filter(it => it.group === grp.id);
              if (!groupItems.length) return null;
              return (
                <div key={grp.id}>
                  {gIdx > 0 && <CommandSeparator />}
                  <CommandGroup>
                    <CommandGroupLabel>{grp.label}</CommandGroupLabel>
                    {groupItems.map(item => (
                      <CommandItem
                        key={item.value}
                        value={item}
                        onClick={() => {
                          setCommandOpen(false);
                          item.onSelect();
                        }}
                      >
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                        {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </div>
              );
            })}
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
