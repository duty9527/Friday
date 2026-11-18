import { randomUUID } from 'node:crypto';
import { resolveWorkerModelFromTiers } from '../models/catalog.js';
import type { ModelTierConfig, WorkerProfile } from '../view.js';
import type { AgentFactory } from './sdk-runtime.js';

export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function offlineFactory(delayMs = 100): AgentFactory {
  let currentModelTiers: ModelTierConfig = {
    provider: 'offline',
    router: 'gpt-4.1',
    fast: 'gpt-4.1-mini',
    balanced: 'gpt-4.1',
    strong: 'o4-mini',
    available: ['gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  };
  let disabledProviderSet = new Set<string>();
  const factoryObj: AgentFactory = {
    mode: 'offline',
    modelTiers: currentModelTiers,
    routerProvider: 'offline',
    resolveWorkerModel: input => resolveWorkerModelFromTiers(currentModelTiers, input),
    updateModelConfig(tiers, nextRouterProvider, _nextRouterModelId, disabledProviders) {
      if (disabledProviders) disabledProviderSet = new Set(disabledProviders);
      currentModelTiers = tiers;
      factoryObj.modelTiers = tiers;
      factoryObj.routerProvider = nextRouterProvider;
    },
    async create(role, _id, tools, options) {
      const effectiveProvider = role === 'router'
        ? (factoryObj.routerProvider ?? 'offline')
        : (options?.model?.includes('/') ? options.model.slice(0, options.model.indexOf('/')) : currentModelTiers.provider);
      if (disabledProviderSet.has(effectiveProvider)) {
        throw new Error(`提供方 "${effectiveProvider}" 已禁用，无法调用`);
      }
      const read = new Set<string>();
      const notes: string[] = [];
      return {
        async prompt(text, signal) {
          if (disabledProviderSet.has(effectiveProvider)) {
            throw new Error(`提供方 "${effectiveProvider}" 已禁用，无法调用`);
          }
          const turn = randomUUID();
          const emit = options?.onEvent;
          emit?.({ kind: 'turn_start', id: turn });
          const call = async (name: string, input: string) => {
            const tool = tools.find(tool => tool.name === name);
            if (!tool) throw new Error(`Offline tool unavailable: ${name}`);
            const id = randomUUID();
            emit?.({ kind: 'tool_start', id, parentId: turn, toolName: name, data: { input } });
            try {
              const result = await tool.execute(input, id);
              emit?.({ kind: 'tool_end', id, parentId: turn, toolName: name, data: result });
              return result;
            } catch (error) {
              emit?.({ kind: 'tool_end', id, parentId: turn, toolName: name, error: true });
              throw error;
            }
          };
          const respond = (result: string) => {
            emit?.({ kind: 'text_delta', id: turn, text: result });
            emit?.({ kind: 'turn_end', id: turn, data: { simulated: true } });
            return result;
          };
          await abortableDelay(delayMs, signal);
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'router') {
            if (event.kind === 'NEW_TASK') {
              await call('dispatch_worker', 'dispatch');
              return respond('[OFFLINE SIMULATION] Worker dispatched');
            }
            if (event.kind === 'WORKER_QUESTION') {
              const opts = Array.isArray(event.options) && event.options.length
                ? `\n可选方案：${(event.options as string[]).map((o, idx) => `${idx + 1}. ${o}`).join(' / ')}`
                : '';
              return respond(`[OFFLINE SIMULATION] 老板，后台任务推进到关键分岔需要您拍板：${String(event.question ?? '')}${opts}`);
            }
            if (event.kind === 'WORKER_FAILED') {
              return respond(`[OFFLINE SIMULATION] 后台工作没跑起来：${String(event.error ?? '未知错误')}`);
            }
            if (event.kind === 'CHAT') {
              const message = event.message as { id: string; text: string; paths: string[] };
              const works = event.works as Array<{ id: string; status: string; report?: string; pendingQuestion?: { question: string; options?: string[] } }>;
              const autoRecalled = (event.autoRecalled as Array<{ kind: string; memoryId?: string; title: string; snippet: string }> | undefined) ?? [];
              const inferProfile = (inputText: string): WorkerProfile =>
                /审查|审计|review|check|audit/i.test(inputText) ? 'review'
                : /调研|搜索|研究|research|investigate/i.test(inputText) ? 'research'
                : /代码|重构|实现|修改|测试|code|implement|refactor|fix/i.test(inputText) ? 'coding'
                : 'general';
              if (message.paths.length) {
                const memoryIds = autoRecalled.filter(hit => hit.kind === 'memory' && hit.memoryId).map(hit => hit.memoryId!);
                const contextBrief = memoryIds.length
                  ? autoRecalled.filter(hit => hit.kind === 'memory').map(hit => `${hit.title}: ${hit.snippet}`).join(' | ')
                  : undefined;
                await call('start_work', JSON.stringify({
                  instruction: message.text,
                  sourceMessageId: message.id,
                  profile: inferProfile(message.text),
                  ...(contextBrief ? { contextBrief } : {}),
                  ...(memoryIds.length ? { memoryIds } : {}),
                }));
                return respond('[OFFLINE SIMULATION] 已关联你明确提供的文件，并启动后台分析。你可以继续在这里补充要求。');
              }
              const sendFileMatch = message.text.match(/^(?:发送文件|发送附件|send\s+file)[:：\s]+([^\n|]+)(?:\|([\s\S]+))?/i);
              if (sendFileMatch && tools.some(tool => tool.name === 'send_file')) {
                const name = sendFileMatch[1]!.trim();
                const content = sendFileMatch[2]?.trim();
                await call('send_file', JSON.stringify({ name, ...(content ? { content } : {}), summary: `向微信发送文件 ${name}` }));
                return respond(`[OFFLINE SIMULATION] FRIDAY 已向当前微信会话发送附件：${name}`);
              }
              const switchChannelMatch = message.text.match(/(?:(?:在|用)(微信|telegram|dingtalk|钉钉|小爱同学|小爱音箱|小爱|音箱|xiaoai)(?:中|里|上)?回复|切到(微信|telegram|dingtalk|钉钉|小爱同学|小爱音箱|小爱|音箱|xiaoai)|switch\s+channel[:：\s]+([a-z0-9_-]+))/i);
              if (switchChannelMatch && tools.some(tool => tool.name === 'switch_channel')) {
                const rawTarget = (switchChannelMatch[1] ?? switchChannelMatch[2] ?? switchChannelMatch[3] ?? 'wechat').toLowerCase();
                const channel = rawTarget === '微信'
                  ? 'wechat'
                  : rawTarget === '钉钉'
                    ? 'dingtalk'
                    : /^(小爱同学|小爱音箱|小爱|音箱|xiaoai)$/.test(rawTarget)
                      ? 'xiaoai'
                      : rawTarget;
                await call('switch_channel', JSON.stringify({ channel, summary: `将本轮回复切换至 ${channel} 通道` }));
                return respond(`[OFFLINE SIMULATION] 老板，已经切到 ${channel} 这边了，我们接着聊。`);
              }
              const pluginMatch = message.text.match(/^(?:插件|运行插件|plugin)[:：\s]+([a-z0-9_-]+)(?:\s+([a-z0-9_-]+))?/i);
              if (pluginMatch && tools.some(tool => tool.name === 'run_plugin')) {
                const plugin = pluginMatch[1]!.trim();
                const pluginAction = pluginMatch[2]?.trim() || 'status';
                const ran = JSON.parse(await call('run_plugin', JSON.stringify({
                  action: 'run', plugin, pluginAction, summary: `调用插件 ${plugin}/${pluginAction}`,
                }))) as { message?: string };
                return respond(`[OFFLINE SIMULATION] 已执行插件 ${plugin}/${pluginAction}：\n${ran.message ?? ''}`);
              }
              const remindMatch = message.text.match(/^(?:提醒|一次性提醒|remind)[:：\s]+(?:(\d+)\s*(秒|分钟|s|m)(?:后)?\s*)?(.+)/i);
              if (remindMatch && tools.some(tool => tool.name === 'manage_timer')) {
                const rawAmount = remindMatch[1] ? Number(remindMatch[1]) : 5;
                const unit = remindMatch[2] ?? '秒';
                const delayMs = Math.max(500, rawAmount * (/分|m/i.test(unit) ? 60_000 : 1_000));
                const instruction = remindMatch[3]!.trim();
                const created = JSON.parse(await call('manage_timer', JSON.stringify({
                  action: 'add',
                  name: `提醒 · ${instruction.slice(0, 24)}`,
                  instruction,
                  delayMs,
                  once: true,
                  plugin: 'system-pulse',
                  pluginAction: 'remind',
                  summary: '创建一次性零 Token 准点提醒',
                }))) as { timer?: { id: string; name: string } };
                return respond(`[OFFLINE SIMULATION] 好的老板，已为您设定 ${Math.round(delayMs / 1000)} 秒后的一次性提醒：「${created.timer?.name ?? instruction}」。`);
              }
              const timerMatch = message.text.match(/^(?:定时|设置定时|timer)[:：\s]+(?:每\s*(\d+)\s*(秒|分钟|s|m)\s*)?(.+)/i);
              if (timerMatch && tools.some(tool => tool.name === 'manage_timer')) {
                const rawAmount = timerMatch[1] ? Number(timerMatch[1]) : 60;
                const unit = timerMatch[2] ?? '秒';
                const intervalMs = Math.max(1000, rawAmount * (/分|m/i.test(unit) ? 60_000 : 1_000));
                const instruction = timerMatch[3]!.trim();
                const created = JSON.parse(await call('manage_timer', JSON.stringify({
                  action: 'add', name: instruction.slice(0, 32), instruction, intervalMs, summary: '创建持久化定时任务',
                }))) as { timer?: { id: string; name: string } };
                return respond(`[OFFLINE SIMULATION] FRIDAY 已配置定时任务「${created.timer?.name ?? instruction}」（每 ${Math.round(intervalMs / 1000)} 秒）。`);
              }
              const delegateMatch = message.text.match(/^(?:派发|后台执行|调用子\s*AI|delegate)[:：\s]+(.+)/i);
              if (delegateMatch && tools.some(tool => tool.name === 'start_work')) {
                const instruction = delegateMatch[1]!.trim();
                const profile = inferProfile(instruction);
                const memoryIds = autoRecalled.filter(hit => hit.kind === 'memory' && hit.memoryId).map(hit => hit.memoryId!);
                const contextBrief = memoryIds.length
                  ? autoRecalled.filter(hit => hit.kind === 'memory').map(hit => `${hit.title}: ${hit.snippet}`).join(' | ')
                  : undefined;
                await call('start_work', JSON.stringify({
                  instruction, profile,
                  ...(contextBrief ? { contextBrief } : {}),
                  ...(memoryIds.length ? { memoryIds } : {}),
                  summary: `编译记忆上下文并派发 ${profile} 专职子 AI`,
                }));
                return respond(`[OFFLINE SIMULATION] FRIDAY 已编译全局记忆上下文，并派发 ${profile} 专职子 AI 在后台执行：${instruction}`);
              }
              const rememberMatch = message.text.match(/^(?:记住|保存记忆|remember)[:：\s]+(.+)/i);
              if (rememberMatch && tools.some(tool => tool.name === 'save_memory')) {
                const raw = rememberMatch[1]!.trim();
                const sep = raw.indexOf('=') >= 0 ? raw.indexOf('=') : raw.indexOf('：') >= 0 ? raw.indexOf('：') : raw.indexOf(':');
                const topic = sep > 0 ? raw.slice(0, sep).trim() : raw.slice(0, 32).trim();
                const content = sep > 0 ? raw.slice(sep + 1).trim() : raw;
                const saved = JSON.parse(await call('save_memory', JSON.stringify({ topic, content: content || raw, summary: '沉淀全局记忆' }))) as { memory?: { id: string; topic: string } };
                return respond(`[OFFLINE SIMULATION] 已存入全局记忆（主题：${saved.memory?.topic ?? topic}）。`);
              }
              const searchMatch = message.text.match(/^(?:搜索记忆|检索记忆|回忆|回想|search\s+memory)[:：\s]+(.+)/i);
              if (searchMatch && tools.some(tool => tool.name === 'search_memory')) {
                const query = searchMatch[1]!.trim();
                const found = JSON.parse(await call('search_memory', JSON.stringify({ query, summary: '按线索检索全局记忆' }))) as { hits?: Array<{ title: string; snippet: string }> };
                const preview = (found.hits ?? []).slice(0, 3).map(hit => `- ${hit.title}: ${hit.snippet}`).join('\n') || '（未找到匹配记忆）';
                return respond(`[OFFLINE SIMULATION] 已检索全局上下文记忆（线索：${query}）：\n${preview}`);
              }
              const candidates = works.filter(work => ['queued', 'running'].includes(work.status));
              const paused = works.filter(work => work.status === 'paused');
              if (/恢复|续跑|resume/i.test(message.text) && paused.length === 1) {
                await call('resume_work', JSON.stringify({ taskId: paused[0]!.id }));
                return respond('[OFFLINE SIMULATION] 已恢复暂停中的工作。');
              }
              const waitingDecision = candidates.filter(work => Boolean(work.pendingQuestion));
              if (!/停止|取消/.test(message.text) && waitingDecision.length === 1 && tools.some(tool => tool.name === 'continue_work')) {
                await call('continue_work', JSON.stringify({
                  taskId: waitingDecision[0]!.id,
                  instruction: message.text,
                  summary: '向等待拍板的后台工作传达老板决策',
                }));
                return respond(`[OFFLINE SIMULATION] 明白老板，已将您的拍板决定（「${message.text}」）同步给后台任务继续执行。`);
              }
              if (/停止|取消/.test(message.text) && candidates.length === 1) {
                await call('stop_work', JSON.stringify({ taskId: candidates[0]!.id }));
                return respond('[OFFLINE SIMULATION] 已请求停止相关工作，等待执行器确认。');
              }
              if (/继续|补充|改为|刚才|之前/.test(message.text) && works.length) {
                if (candidates.length > 1) return respond('[OFFLINE SIMULATION] 有多项后台工作，请描述你要补充的是哪一件事。无需提供任务 ID。');
                const selected = candidates[0] ?? works.at(-1)!;
                if (/继续|补充|改为/.test(message.text)) {
                  await call('continue_work', JSON.stringify({ taskId: selected.id, instruction: message.text }));
                  return respond('[OFFLINE SIMULATION] 已把补充要求关联到之前的工作。');
                }
                const prior = await call('inspect_work', JSON.stringify({ taskId: selected.id }));
                const summary = (JSON.parse(prior) as { report?: string }).report ?? '（该工作没有已交付报告）';
                return respond(`[OFFLINE SIMULATION] 这是之前工作的已交付报告；本模式不进行真实语义推理。\n${summary.slice(0, 2048)}`);
              }
              const memoryFlashback = autoRecalled.filter(hit => hit.kind === 'memory');
              const flashbackNote = memoryFlashback.length
                ? `\n[FRIDAY 潜意识记忆闪回] 已自动关联 ${memoryFlashback.length} 条全局记忆：${memoryFlashback.map(hit => `${hit.title}（${hit.snippet.slice(0, 80)}）`).join('；')}`
                : '';
              const sub = event.subconscious as {
                pendingInsight?: { id: string; insight: string };
                impressions?: Array<{ vividness: 'clear' | 'hazy'; text: string }>;
              } | undefined;
              if (/做梦|梦到|梦里|休息时在想|dream/i.test(message.text)) {
                const topImp = sub?.impressions?.[0];
                if (topImp) {
                  return respond(`[OFFLINE SIMULATION] 老板，${topImp.vividness === 'clear' ? '刚醒不久还隐约记得一点' : '醒来有些时候了，只剩一点模糊印象'}：${topImp.text}`);
                }
                return respond('[OFFLINE SIMULATION] 老板，之前休息得挺沉，醒来后已经记不清具体的梦境画面了。');
              }
              const insightTail = sub?.pendingInsight
                ? `\n（对了老板，休息回想时突然意识到：${sub.pendingInsight.insight}）`
                : '';
              return respond('[OFFLINE SIMULATION] 我在同一个主对话里接收到了：' + message.text + '\n当前为离线演示；可关联本机文本文件观察后台执行，真实回复需要 real 模式。' + flashbackNote + insightTail);
            }
            const report = String(event.report ?? '').replace(/^[\s\S]*?Read-only analysis, not an LLM response\.?/, '').trim();
            const taskPrompt = String(event.prompt ?? '');
            const supplementDirective = /\[NEEDS_SUPPLEMENT[:：]\s*([^\]]+)\]/i.exec(taskPrompt)?.[1]?.trim();
            if (supplementDirective && !/\[已完成补查/.test(taskPrompt) && tools.some(t => t.name === 'start_work')) {
              if (tools.some(t => t.name === 'inspect_work') && typeof event.taskId === 'string') {
                await call('inspect_work', JSON.stringify({ taskId: event.taskId, summary: '验收阶段报告' }));
              }
              if (tools.some(t => t.name === 'recall_messages')) {
                await call('recall_messages', JSON.stringify({ summary: '回溯对话要求' }));
              }
              await call('start_work', JSON.stringify({
                instruction: `[已完成补查] 补充核查：${supplementDirective}`,
                summary: `自动发起补查：${supplementDirective}`,
              }));
              return respond('好的老板，任务已下发。');
            }
            if (/\[INFINITE_SUPPLEMENT\]/i.test(taskPrompt) && tools.some(t => t.name === 'start_work')) {
              try {
                await call('start_work', JSON.stringify({
                  instruction: '[INFINITE_SUPPLEMENT] 继续补查 round',
                  summary: '自动追派补查',
                }));
                return respond('好的老板，任务已下发。');
              } catch (err) {
                return respond(`[OFFLINE SIMULATION] 已触发自动补查上限保护（${err instanceof Error ? err.message : String(err)}），现汇总已得结论：\n${(report || '（无报告正文）').slice(0, 300)}`);
              }
            }
            return respond(`[OFFLINE SIMULATION] 后台工作已交由 Router 汇总（真实模式由模型生成回复）。\n执行细节与操作结果保存在执行轨迹中；以下为 Worker 已交付报告的摘要：\n${(report || '（无报告正文）').slice(0, 400)}`);
          }
          if (role === 'distiller') {
            const payload = event as {
              kind?: string;
              task?: { prompt?: string; report?: string; cwd?: string };
              messages?: Array<{ role?: string; text?: string }>;
              existingRelatedMemories?: Array<{ id: string; topic: string; content: string; tags?: string[]; cwd?: string }>;
            };
            const existing = payload.existingRelatedMemories ?? [];
            const serializeTexts = [
              payload.task?.prompt ?? '',
              payload.task?.report ?? '',
              ...(payload.messages ?? []).map(m => m.text ?? ''),
            ].join('\n');
            if (/\[DISTILL_ERROR\]/i.test(serializeTexts)) {
              throw new Error('Simulated offline distiller failure');
            }
            const explicitMarker = /\[DISTILL_SAVE:\s*topic=([^|\]]+)\|\s*content=([^\]]+)\]/i.exec(serializeTexts);
            if (explicitMarker) {
              const topic = explicitMarker[1]!.trim();
              const content = explicitMarker[2]!.trim();
              const supersedeIds = existing
                .filter(m => m.topic.toLowerCase() === topic.toLowerCase() || content.toLowerCase().includes(m.topic.toLowerCase()))
                .map(m => m.id);
              return respond(JSON.stringify({
                operations: [{
                  action: 'save',
                  topic,
                  content,
                  tags: ['distilled', ...(payload.task ? ['task-finding'] : ['preference'])],
                  ...(payload.task?.cwd ? { cwd: payload.task.cwd } : {}),
                  importance: 75,
                  ...(supersedeIds.length ? { supersedeIds } : {}),
                }],
              }));
            }
            const isEphemeralOnly = /(?:基金净值|今天天气|帮我拍一张照|打开客厅灯|开一下空调|定个闹钟|查看.*状态)/i.test(serializeTexts)
              && !/(?:偏好|以后都|总是|记住|根因|固定端口|serial|序列号|architecture|决策|协议)/i.test(serializeTexts);
            if (isEphemeralOnly || serializeTexts.trim().length < 8) {
              return respond(JSON.stringify({ operations: [] }));
            }
            if (/(?:偏好|以后都|总是|根因|固定端口|serial|序列号|architecture|决策|修复方案|端口配置)/i.test(serializeTexts)) {
              const rawTitle = (payload.task?.prompt ?? payload.messages?.find(m => m.role === 'user')?.text ?? '对话沉淀知识')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 48);
              const overlap = existing[0];
              return respond(JSON.stringify({
                operations: [{
                  action: 'save',
                  topic: overlap ? overlap.topic : rawTitle,
                  content: serializeTexts.trim().slice(0, 600),
                  tags: [payload.task ? 'troubleshooting' : 'boss-preference'],
                  ...(payload.task?.cwd ? { cwd: payload.task.cwd } : {}),
                  importance: 72,
                  ...(overlap ? { supersedeIds: [overlap.id] } : {}),
                }],
              }));
            }
            return respond(JSON.stringify({ operations: [] }));
          }
          if (role === 'dreamer') {
            const mat = (event.material ?? {}) as {
              rawStubs?: Array<{ id: string; topic: string; content: string; cwd?: string; tags?: string[] }>;
              distantMemories?: Array<{ id: string; topic: string }>;
              undigestedMessages?: Array<{ role: string; text: string }>;
            };
            const stubs = mat.rawStubs ?? [];
            const distant = mat.distantMemories ?? [];
            let consolidatedId: string | undefined;
            if (stubs.length >= 2 && tools.some(t => t.name === 'consolidate_memory')) {
              const cleanTopics = stubs.map(s => s.topic.replace(/^任务经验\s*·\s*/, '')).join(' / ').slice(0, 80);
              const saved = JSON.parse(await call('consolidate_memory', JSON.stringify({
                topic: `阶段沉淀 · ${cleanTopics}`,
                content: stubs.map(s => s.content.slice(0, 300)).join('\n---\n'),
                tags: [...new Set(stubs.flatMap(s => (s.tags ?? []).filter(t => t !== 'auto-consolidated')))],
                cwd: stubs[0]?.cwd,
                supersedeIds: stubs.map(s => s.id),
              }))) as { memory?: { id: string } };
              consolidatedId = saved.memory?.id;
            }
            if ((consolidatedId || stubs[0]?.id) && distant[0]?.id && tools.some(t => t.name === 'connect_synapse')) {
              await call('connect_synapse', JSON.stringify({
                id: consolidatedId ?? stubs[0]!.id,
                targetId: distant[0]!.id,
              }));
            }
            const pieces = [
              stubs[0]?.topic ?? mat.undigestedMessages?.at(-1)?.text.slice(0, 36),
              distant[0]?.topic,
            ].filter(Boolean);
            return respond(JSON.stringify({
              impression: pieces.length >= 2
                ? `隐约把近期的「${pieces[0]}」和许久前的「${pieces[1]}」叠在了一起回想。`
                : `迷迷糊糊回放了白天关于「${pieces[0] ?? '近期琐事'}」的片段。`,
              salience: 'faint',
            }));
          }
          const files = event.files as Array<{ id: string; name: string }> | undefined;
          if (files) for (const file of files) {
            if (!read.has(file.id)) { await call('start_read', file.id); read.add(file.id); }
          }
          for (const item of [
            ...((event.priorFollowups as Array<{ text?: string }> | undefined) ?? []),
            ...((event.followups as Array<{ text?: string }> | undefined) ?? []),
          ]) {
            if (item.text && !notes.includes(item.text)) notes.push(item.text);
          }
          const promptText = String(event.prompt ?? (event.input as { prompt?: string } | undefined)?.prompt ?? '');
          const askDirective = /\[ASK_BOSS[:：]\s*([^\]]+)\]/i.exec(promptText)?.[1]?.trim();
          if (askDirective && notes.length === 0) {
            return respond(JSON.stringify({
              kind: 'ASK_BOSS',
              question: askDirective,
              options: ['方案 A（稳妥增量）', '方案 B（全量覆盖）'],
            }));
          }
          const received = notes.length ? `\n已收到补充要求：${notes.join(' / ').slice(0, 300)}` : '';
          const compiled = event.compiledContext as { profile?: string; contextBrief?: string; recalledMemories?: Array<{ topic: string }> } | undefined;
          const compiledNote = compiled
            ? `\n[已注入编译上下文 · 角色: ${compiled.profile ?? 'general'}${compiled.recalledMemories?.length ? ` · 记忆卡片: ${compiled.recalledMemories.map(m => m.topic).join(', ')}` : ''}]`
            : '';
          return respond(`[OFFLINE SIMULATION] 离线模拟 Worker：已按授权文件 ID 读取输入，本模式不产生真实模型分析。${received}${compiledNote}`);
        },
        close() {},
      };
    },
  };
  return factoryObj;
}
