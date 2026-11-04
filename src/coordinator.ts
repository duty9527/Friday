import { createHash, randomUUID } from 'node:crypto';
import { rm, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AgentFactory, AgentPort } from './agent.js';
import { readSnapshot, snapshot, type InputFile } from './files.js';
import { PromptTrace } from './trace.js';
import { integer, text } from './protocol.js';
import type { ChatMessage, MainView } from './view.js';
import { Executor } from './executor.js';
import { Store, type Operation, type Task, type TaskStatus } from './store.js';

const unsettled = (op: Operation) => ['requested', 'started', 'cancel_requested', 'unknown'].includes(op.status);
const taskStatusNeedsNotice = (status: TaskStatus) => ['paused', 'cancelled', 'failed'].includes(status);

interface Run {
  id: string; revision: number; controller: AbortController; worker?: AgentPort;
  jobs: number; activeCalls: number; clockUncertain: boolean;
  reads: Map<string, Promise<Operation>>; completions: Operation[];
  stopping?: 'paused' | 'cancelled' | 'failed'; lastTick: number; lastWall: number;
  trace?: PromptTrace; replyId?: string;
}
interface ChatRun { message: ChatMessage; controller: AbortController; revisions: Map<string, number>; replyId?: string;
  clock?: { lastTick: number; lastWall: number; activeMs: number } }
interface ChatWork { originMessageId: string; parentTaskId?: string; parentSpanId?: string; source?: Task; signal: AbortSignal; cwd?: string }
class SourceChangedError extends Error {}
function toolInput(input: string, keys: string[]): Record<string, unknown> {
  const value: unknown = JSON.parse(text(input, 'tool input', 65_536));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected Router tool fields');
  return value as Record<string, unknown>;
}
export class Coordinator {
  readonly store: Store;
  private readonly executor: Executor;
  private readonly runs = new Map<string, Run>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly submissions = new Set<Promise<Task>>();
  private router?: AgentPort;
  private routerQueue: Promise<void> = Promise.resolve();
  private dispatch?: () => Promise<string>;
  private routerTrace?: PromptTrace;
  private chatContext?: ChatRun;
  private readonly chatRuns = new Map<string, ChatRun>();
  private readonly chatJobs = new Set<Promise<void>>();
  private readonly timer: NodeJS.Timeout;
  private closing = false;
  constructor(private readonly home: string, private readonly factory: AgentFactory) {
    this.store = new Store(home);
    this.store.recover();
    this.executor = new Executor(home, op => this.store.operation(op));
    this.timer = setInterval(() => this.tick(), 200);
  }
  health() { return { executorPid: this.executor.pid, executorAvailable: this.executor.available }; }
  async ready() {
    await this.executor.ready;
    this.router = await this.factory.create('router', 'router', [{
      name: 'dispatch_worker', description: 'Dispatch the host-selected task to its isolated Worker. Input is a confirmation, not a replacement task.',
      execute: async () => {
        if (!this.dispatch) throw new Error('No task is eligible for dispatch');
        return this.dispatch();
      },
    }, {
      name: 'start_work', description: 'Start an isolated background task; returns immediately. Input JSON: {instruction, cwd?, sourceMessageId?, sourceTaskId?}. For native work cwd is an optional absolute existing working directory; paths named in conversation are enough, attachments are NOT required. Omit cwd to reuse the source work directory, first hint path directory, or service cwd. Native Workers have full local tools, not a sandbox. Snapshot/offline work still uses explicitly supplied source files. Do not use both sources.',
      execute: async (input, callId) => {
        const context = this.requireChat();
        const args = toolInput(input, ['instruction', 'cwd', 'sourceMessageId', 'sourceTaskId']);
        const instruction = text(args.instruction, 'instruction');
        if (args.sourceMessageId && args.sourceTaskId) throw new Error('Use one authorized source');
        const source = args.sourceTaskId ? this.chatWork(context, text(args.sourceTaskId, 'sourceTaskId', 128)) : undefined;
        if (source && ['queued', 'running'].includes(source.status)) throw new Error('Work is still active: use continue_work to append a follow-up instead of copying it');
        if (source?.status === 'paused') throw new Error('Paused work cannot be automatically continued; ask the user to provide inputs for a new independent execution');
        let paths: string[] = context.message.paths;
        if (args.sourceMessageId) {
          const message = this.store.conversation.get(text(args.sourceMessageId, 'sourceMessageId', 128));
          if (message.role !== 'user') throw new Error('Only user messages authorize file paths');
          paths = message.paths;
        }
        const task = await this.newChatWork(context, instruction, paths, callId, source,
          args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096));
        return JSON.stringify({ taskId: task.id, state: task.status, execution: task.execution, cwd: task.cwd, note: 'Background work accepted, not completed' });
      },
    }, {
      name: 'continue_work', description: 'Input JSON {taskId,instruction,cwd?}. Append a follow-up to queued/running work; completed/failed/cancelled work starts a related isolated execution using the CURRENT service execution capabilities and prior report. In native mode, even a legacy snapshot source creates a full-tool Worker in the current working directory, never another snapshot-only Worker. Optional cwd selects an absolute working directory. Paused or unknown work cannot be resumed automatically.',
      execute: async (input, callId) => {
        const context = this.requireChat();
        const args = toolInput(input, ['taskId', 'instruction', 'cwd']);
        const task = this.chatWork(context, text(args.taskId, 'taskId', 128));
        const instruction = text(args.instruction, 'instruction');
        if (['queued', 'running'].includes(task.status)) {
          this.store.transaction(() => {
            this.followup(task.id, this.toolRequest(context.message.id, callId, 'followup'), instruction);
            this.store.conversation.link(context.message.id, task.id);
          });
          return JSON.stringify({ taskId: task.id, state: 'followup_accepted' });
        }
        if (task.status === 'paused') throw new Error('Work is paused with unconfirmed progress; no automatic replay or resume');
        const next = await this.newChatWork(context, instruction, context.message.paths, callId, task,
          args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096));
        return JSON.stringify({ taskId: next.id, parentTaskId: task.id, state: next.status, execution: next.execution, cwd: next.cwd });
      },
    }, {
      name: 'inspect_work', description: 'Read persisted work status and prior report. Input JSON {taskId}. This does not run a Worker or read new host files.',
      execute: async input => {
        const context = this.requireChat();
        const args = toolInput(input, ['taskId']);
        const task = this.store.get(text(args.taskId, 'taskId', 128));
        this.store.conversation.link(context.message.id, task.id);
        return JSON.stringify({ id: task.id, prompt: task.prompt, status: task.status, mode: task.mode, reason: task.reason, report: task.report,
          execution: task.execution ?? 'snapshot', cwd: task.cwd, paths: task.paths,
          files: task.files, followups: this.store.events(task.id).map(({ id, text, state }) => ({ id, text, state })) });
      },
    }, {
      name: 'recall_messages', description: 'Read older pages of the SAME continuous transcript, without a new session. Input JSON {beforeSeq?} for a bounded page, or {messageId} for one full message. Page previews are truncated explicitly; use the returned message ID for full text. Source messages remain the only file authorization.',
      execute: async input => {
        this.requireChat();
        const args = toolInput(input, ['beforeSeq', 'messageId']);
        const compact = (message: ChatMessage, full: boolean) => ({ id: message.id, seq: message.seq, role: message.role, mode: message.mode, status: message.status,
          text: full ? message.text : message.text.slice(0, 4096), truncated: !full && message.text.length > 4096, taskIds: message.taskIds, fileCount: message.paths.length });
        if (args.messageId) return JSON.stringify(compact(this.store.conversation.get(text(args.messageId, 'messageId', 128)), true));
        const page = this.store.conversation.history(args.beforeSeq === undefined ? undefined : integer(args.beforeSeq, 0, 1, Number.MAX_SAFE_INTEGER));
        return JSON.stringify({ ...page, items: page.items.map(message => compact(message, false)) });
      },
    }, {
      name: 'stop_work', description: 'Request cancellation of a specific work. Input JSON {taskId}. A stop request is not proof of completed cancellation; report the returned state faithfully.',
      execute: async input => {
        const context = this.requireChat();
        const args = toolInput(input, ['taskId']);
        const selected = this.chatWork(context, text(args.taskId, 'taskId', 128));
        this.store.conversation.link(context.message.id, selected.id);
        const task = this.stop(selected.id);
        return JSON.stringify({ taskId: task.id, state: task.status, reason: task.reason });
      },
    }], { restore: this.store.conversation.meta('router_checkpoint'), onEvent: event => this.routerTrace?.observe(event) });
  }
  private requireChat(): ChatRun {
    if (!this.chatContext || this.chatContext.controller.signal.aborted || this.closing) throw new Error('No active main conversation request');
    return this.chatContext;
  }
  private chatWork(context: ChatRun, id: string) {
    const task = this.store.get(id);
    if (context.revisions.get(id) !== task.revision) throw new Error('Work changed or was stopped while Router was responding; inspect its current state before retrying');
    return task;
  }
  private toolRequest(messageId: string, callId: string | undefined, kind: string) {
    return createHash('sha256').update(JSON.stringify([messageId, callId ?? randomUUID(), kind])).digest('hex');
  }
  private async newChatWork(context: ChatRun, instruction: string, paths: string[], callId?: string, source?: Task, cwd?: string) {
    const task = await this.submit(this.toolRequest(context.message.id, callId, 'work'), instruction, paths, 600_000,
      { originMessageId: context.message.id, parentTaskId: source?.id, parentSpanId: this.routerTrace?.toolSpan(callId), source, cwd, signal: context.controller.signal });
    context.revisions.set(task.id, task.revision);
    return task;
  }
  view(): MainView {
    return { mode: this.factory.mode, health: { status: this.executor.available ? 'ready' : 'degraded', executorAvailable: this.executor.available },
      messages: this.store.conversation.history(), cursor: this.store.conversation.latestSeq(),
      works: this.store.list().slice(-80).map(({ id, prompt, status, mode, createdAt, activeMs, limitMs, reason, originMessageId, parentTaskId }) =>
        ({ id, prompt: prompt.slice(0, 240), status, mode, createdAt, activeMs, limitMs, reason, originMessageId, parentTaskId })) };
  }
  chat(requestId: string, content: string, paths: string[] = []): ChatMessage {
    if (this.closing) throw new Error('Service is shutting down');
    if (paths.length > 32 || paths.some(path => !isAbsolute(path))) throw new Error('Provide at most 32 explicit absolute paths (files or directories); do not use ~ or environment variables');
    const chat = this.store.conversation;
    const previous = chat.byRequest(requestId);
    if (previous) {
      if (previous.text !== content || JSON.stringify(previous.paths) !== JSON.stringify(paths)) throw new Error('Request ID already used for a different message');
      return previous;
    }
    const message = chat.create({ id: randomUUID(), requestId, role: 'user', text: content, status: 'queued', paths, mode: this.factory.mode });
    const context: ChatRun = { message, controller: new AbortController(), revisions: new Map() };
    this.chatRuns.set(message.id, context);
    const pending = this.routerQueue.then(async () => {
      if (context.controller.signal.aborted || this.closing) { chat.update(message.id, { status: 'interrupted', reason: 'Router 处理前已停止；不会自动重发。' }); return; }
      context.revisions = new Map(this.store.list().map(task => [task.id, task.revision]));
      this.chatContext = context;
      chat.update(message.id, { status: 'processing' });
      const reply = chat.create({ id: randomUUID(), replyTo: message.id, role: 'assistant', text: '', status: 'streaming', mode: this.factory.mode, paths: [] });
      context.replyId = reply.id;
      const trace = new PromptTrace(chat, { rootId: message.id, messageId: message.id, parentSpanId: message.id }, 'router', this.factory.mode, reply.id);
      this.routerTrace = trace;
      context.clock = { lastTick: performance.now(), lastWall: Date.now(), activeMs: 0 };
      try {
        const result = await trace.run(this.router!, JSON.stringify({ kind: 'CHAT', message, context: chat.recentContext(),
          execution: this.factory.nativeTools ? 'native' : 'snapshot', cwd: process.cwd(),
          works: this.store.list().slice(-40).map(({ id, prompt, status, revision, mode, reason, report, files, originMessageId, execution, cwd }) => ({ execution: execution ?? 'snapshot', cwd, id, prompt: prompt.slice(0, 512), status, revision, mode, reason, reportPreview: report?.slice(0, 1024), fileCount: files.length, originMessageId })) }), context.controller.signal);
        this.accrueChat(context);
        if (context.controller.signal.aborted) throw context.controller.signal.reason;
        this.store.transaction(() => {
          chat.update(reply.id, { text: result, status: 'completed' });
          chat.update(message.id, { status: 'completed' });
          for (const id of chat.get(message.id).taskIds) chat.link(reply.id, id);
          this.checkpoint();
        });
      } catch (error) {
        const status = context.controller.signal.aborted ? 'interrupted' : 'failed';
        chat.update(reply.id, { status, reason: 'Router 回复未完成；已保留公开输出和真实错误轨迹，不自动重放。' });
        chat.update(message.id, { status, reason: error instanceof Error ? '处理未完成，可查看执行轨迹。' : '处理失败。' });
      } finally { this.routerTrace = undefined; this.chatContext = undefined; }
    }).finally(() => { this.chatRuns.delete(message.id); this.chatJobs.delete(pending); });
    this.chatJobs.add(pending);
    this.routerQueue = pending.then(() => {}, () => {});
    return message;
  }
  stopReply(id: string) {
    const message = this.store.conversation.get(id);
    const run = this.chatRuns.get(message.role === 'assistant' ? message.replyTo ?? id : id);
    run?.controller.abort(new Error('User stopped the Router reply; independent background works are unchanged'));
    if (run && !run.replyId) this.store.conversation.update(run.message.id, { status: 'interrupted', reason: '已停止排队中的回复；后台工作不受影响。' });
    return { messageId: id, state: run ? 'stop_requested' : message.status };
  }
  private checkpoint() {
    if (this.router?.checkpoint) this.store.conversation.setMeta('router_checkpoint', this.router.checkpoint);
  }
  private launch(run: Run, work: () => Promise<void>) {
    run.jobs++;
    const job = work().catch(() => {
      if (!run.controller.signal.aborted) this.stop(run.id, '模型或执行器请求失败：已撤销派发，正在等待在途操作结算', 'failed');
    }).finally(async () => {
      if (run.stopping && run.reads.size) await Promise.all([...run.reads.values()]);
      run.jobs--; this.jobs.delete(job);
      if (run.stopping && run.jobs === 0) {
        const uncertain = this.store.operations(run.id).some(unsettled);
        if (run.stopping !== 'paused' && uncertain) {
          this.finish(run, 'paused', '取消或失败后无法确认操作结算；工作保持暂停，不会自动重放');
        } else this.finish(run, run.stopping, run.stopping === 'cancelled'
          ? '取消已确认：所有在途操作均已结算'
          : this.store.get(run.id).reason);
      }
    });
    this.jobs.add(job);
  }
  private valid(run: Run): boolean {
    const task = this.store.get(run.id);
    return !run.controller.signal.aborted && task.revision === run.revision && ['queued', 'running'].includes(task.status);
  }
  private serialRouter<T>(run: Run, work: () => Promise<T>): Promise<T> {
    const next = this.routerQueue.then(async () => {
      if (!this.valid(run)) throw new Error('Task no longer active');
      return work();
    });
    this.routerQueue = next.then(() => {}, () => {});
    return next;
  }
  submit(requestId: string, prompt: string, paths: string[], limitMs: number, chatWork?: ChatWork): Promise<Task> {
    const pending = this.submitTask(requestId, prompt, paths, limitMs, chatWork);
    this.submissions.add(pending);
    void pending.finally(() => this.submissions.delete(pending)).catch(() => {});
    return pending;
  }
  private async submitTask(requestId: string, prompt: string, paths: string[], limitMs: number, chatWork?: ChatWork): Promise<Task> {
    if (this.closing) throw new Error('Service is shutting down');
    const fingerprint = createHash('sha256').update(JSON.stringify({ prompt, paths, limitMs, sourceTaskId: chatWork?.source?.id, cwd: chatWork?.cwd })).digest('hex');
    const previous = this.store.byRequest(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID already used with different task parameters');
      return previous;
    }
    const id = randomUUID();
    const source = chatWork?.source;
    const native = this.factory.nativeTools === true;
    let cwd: string | undefined;
    if (native) {
      let candidate = chatWork?.cwd ?? paths[0] ?? source?.cwd ?? process.cwd();
      if (!isAbsolute(candidate)) throw new Error('Native working directory must be an absolute path');
      const info = await stat(candidate);
      if (chatWork?.cwd && !info.isDirectory()) throw new Error('cwd must be a directory');
      if (info.isFile()) candidate = dirname(candidate);
      else if (!info.isDirectory()) throw new Error('Native path hint must be a file or directory');
      cwd = await realpath(candidate);
    }
    if (source && !native) for (const file of source.files) await readSnapshot(this.home, source.id, file);
    const authorizedPaths = source ? source.files.map(file => join(this.home, 'tasks', source.id, 'inputs', file.id)) : paths;
    let files: InputFile[] = native || (chatWork && !authorizedPaths.length) ? [] : await snapshot(this.home, id, authorizedPaths);
    if (source && !native) {
      if (files.some((file, index) => file.sha256 !== source.files[index]!.sha256)) {
        await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
        throw new Error('Source snapshot changed during continuation');
      }
      files = files.map((file, index) => ({ ...file, name: source.files[index]!.name }));
    }
    const duplicate = this.store.byRequest(requestId);
    if (duplicate || this.closing || chatWork?.signal.aborted) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      if (this.closing) throw new Error('Service is shutting down');
      if (chatWork?.signal.aborted) throw new Error('Router request stopped before dispatch');
      const source = chatWork?.source;
      if (source) {
        const current = this.store.get(source.id);
        if (current.revision !== source.revision || !['completed', 'failed', 'cancelled'].includes(current.status)) throw new SourceChangedError('Source work changed before dispatch');
      }
      if (duplicate!.fingerprint !== fingerprint) throw new Error('Request ID already used with different task parameters');
      return duplicate!;
    }
    const task: Task = { id, requestId, fingerprint, prompt, files, limitMs, activeMs: 0,
      status: 'queued', revision: 0, mode: this.factory.mode, createdAt: Date.now(),
      execution: native ? 'native' : 'snapshot', cwd, paths: native ? (paths.length ? paths : source?.paths ?? []) : undefined,
      originMessageId: chatWork?.originMessageId, parentTaskId: chatWork?.parentTaskId, parentSpanId: chatWork?.parentSpanId };
    try {
      // No await between this re-validation and the commit: a stop that lands during snapshot work
      // cannot be overtaken by a related execution derived from a stale revision.
      this.store.transaction(() => {
        const source = chatWork?.source;
        if (source) {
          const current = this.store.get(source.id);
          if (current.revision !== source.revision || !['completed', 'failed', 'cancelled'].includes(current.status)) {
            throw new SourceChangedError('Source work changed or was stopped while preparing this dispatch; no related work was created');
          }
        }
        this.store.create(task);
        if (chatWork) this.store.conversation.link(chatWork.originMessageId, task.id);
      });
    } catch (error) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      throw error;
    }
    const run: Run = { id, revision: 0, controller: new AbortController(), jobs: 0, activeCalls: 0, clockUncertain: false, reads: new Map(), completions: [], lastTick: performance.now(), lastWall: Date.now() };
    this.runs.set(id, run);
    if (chatWork) {
      this.store.transition(id, 'running');
      this.launch(run, () => this.work(run));
      return this.store.get(id);
    }
    this.launch(run, async () => {
      await this.serialRouter(run, async () => {
        if (!this.valid(run)) return;
        this.store.transition(id, 'running'); run.lastTick = performance.now(); run.lastWall = Date.now();
        let dispatched = false;
        this.dispatch = async () => {
          if (!this.valid(run)) throw new Error('Task was stopped');
          if (!dispatched) { dispatched = true; this.launch(run, () => this.work(run)); }
          return JSON.stringify({ taskId: id, state: 'dispatched' });
        };
        try {
          await this.prompt(run, this.router!, JSON.stringify({ kind: 'NEW_TASK', taskId: id, prompt, files }));
          if (!dispatched && this.valid(run)) throw new Error('Router did not dispatch the task');
        } finally { this.dispatch = undefined; }
      });
    });
    return task;
  }
  private async work(run: Run) {
    const task = this.store.get(run.id);
    const worker = await this.factory.create('worker', run.id, task.execution === 'native' ? [] : [{
      name: 'start_read', description: 'Start an asynchronous read of a permitted snapshot file. Input must be a listed file ID, such as f0. Returns an operation ID, not file contents.',
      execute: async (fileId, callId) => {
        if (!this.valid(run)) throw new Error('Task is no longer active');
        const file = task.files.find(file => file.id === fileId);
        if (!file) throw new Error('File ID is not authorized');
        if (run.reads.size >= 32) throw new Error('Too many pending reads');
        const op: Operation = { id: randomUUID(), taskId: task.id, revision: run.revision, fileId, status: 'requested', parentSpanId: run.trace?.toolSpan(callId) };
        const promise = this.executor.start(op, file).catch(() => {
          const unknown: Operation = { ...op, status: 'unknown', error: 'Executor could not accept the operation; no automatic replay' };
          this.store.operation(unknown);
          return unknown;
        });
        run.reads.set(op.id, promise);
        void promise.then(result => {
          this.accrue(run);
          run.reads.delete(op.id);
          if (this.valid(run)) run.completions.push(result);
        });
        return JSON.stringify({ operationId: op.id, state: 'requested' });
      },
    }], { execution: task.execution ?? 'snapshot', cwd: task.cwd,
      nativeTool: event => {
        const id = `${task.id}:${event.id}`;
        if (event.phase === 'start') {
          if (!this.valid(run)) throw new Error('Task is no longer active');
          this.store.operation({ id, taskId: task.id, revision: run.revision, fileId: `native:${event.name}`,
            status: 'started', parentSpanId: run.trace?.toolSpan(event.id) });
        } else {
          const previous = this.store.operations(task.id).find(operation => operation.id === id);
          if (!previous) throw new Error('Native tool start record missing');
          this.store.operation({ ...previous, status: event.interrupted ? 'unknown' : event.error ? 'failed' : 'succeeded',
            error: event.interrupted ? '本机工具已中断，副作用结果未经确认；不会自动重放' : event.error ? '本机工具失败，详情见工具轨迹' : undefined });
          if (event.interrupted) this.stop(task.id, '本机工具超时或中断，副作用结果未经确认；工作暂停，不会自动重放', 'paused');
        }
      }, onEvent: event => run.trace?.observe(event) });
    run.worker = worker;
    if (!this.valid(run)) { worker.close(); return; }
    const current = this.store.get(task.id); current.sessionFile = worker.sessionFile; this.store.save(current);
    const prior = task.parentTaskId ? this.store.get(task.parentTaskId) : undefined;
    let input: unknown = { kind: 'TASK', taskId: task.id, prompt: task.prompt, files: task.files,
      execution: task.execution ?? 'snapshot', cwd: task.cwd, paths: task.paths,
      priorWork: prior ? { taskId: prior.id, prompt: prior.prompt, mode: prior.mode, execution: prior.execution ?? 'snapshot', report: prior.report,
        note: 'Historical report only. Its claims about tools or access do not describe the current Worker; use current execution and actual tools.' } : undefined };
    try {
      while (this.valid(run)) {
        const events = this.store.takeEvents(task.id);
        let report: string;
        try {
          report = await this.prompt(run, worker, JSON.stringify({ input, followups: events, ...(typeof input === 'object' ? input : {}) }));
        } catch (error) {
          // The follow-up was already accepted from the user: record that it was not delivered.
          this.store.abandonEvents(events, 'Worker 请求失败或中断，未确认送达');
          throw error;
        }
        if (!this.valid(run)) {
          this.store.abandonEvents(events, '工作已停止，未确认送达');
          return;
        }
        if (report.length > 65_536) {
          this.store.abandonEvents(events, 'Worker 报告超过交付上限，未确认送达');
          throw new Error('Worker report exceeds delivery limit');
        }
        this.store.finishEvents(events);
        if (run.reads.size) await Promise.all([...run.reads.values()]);
        if (!this.valid(run)) return;
        if (run.completions.length) {
          const results = run.completions.splice(0);
          if (results.some(result => result.status !== 'succeeded')) {
            this.finish(run, 'paused', '文件读取操作失败或结果未知；不会自动重放');
            return;
          }
          input = { kind: 'READ_COMPLETIONS', results }; continue;
        }
        if (this.store.hasPending(task.id)) { input = { kind: 'FOLLOWUP' }; continue; }
        if (this.store.operations(task.id).some(unsettled)) {
          this.finish(run, 'paused', '存在结果不明的工具调用；不会自动重放'); return;
        }
        const successfulReads = new Set(this.store.operations(task.id).filter(op => op.status === 'succeeded').map(op => op.fileId));
        if (task.files.some(file => !successfulReads.has(file.id))) {
          this.finish(run, 'paused', 'Worker 未读取全部明确提供的输入；拒绝交付无依据的成功报告');
          return;
        }
        const delivered = await this.serialRouter(run, async () => {
          const text = await this.prompt(run, this.router!, JSON.stringify({ kind: 'WORKER_REPORT', taskId: task.id, report }));
          if (this.store.hasPending(task.id)) return undefined;
          if (text.length > 65_536) throw new Error('Router report exceeds delivery limit');
          return text;
        });
        if (!this.valid(run)) return;
        if (delivered === undefined) { input = { kind: 'FOLLOWUP' }; continue; }
        this.finish(run, 'completed', undefined, delivered); return;
      }
    } finally { worker.close(); }
  }
  followup(id: string, requestId: string, text: string): Task {
    const task = this.store.get(id);
    if (!['queued', 'running'].includes(task.status)) throw new Error('Follow-ups require a queued or running task; submit a new task for terminal/paused results');
    this.store.addEvent(requestId, id, text);
    return task;
  }
  stop(id: string, reason = '已请求取消，等待在途操作结算', status: 'paused' | 'cancelled' | 'failed' = 'cancelled'): Task {
    const existing = this.runs.get(id);
    if (existing) this.accrue(existing);
    const task = this.store.get(id);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    const run = this.runs.get(id);
    if (!run) {
      const uncertain = this.store.operations(id).some(unsettled);
      if (uncertain) return this.store.transition(id, 'paused', '无法确认操作结算；工作保持暂停，不会自动重放');
      if (status === 'cancelled') return this.store.transition(id, 'cancelled', '已取消暂停中的工作；没有正在执行的进程');
      return task;
    }
    if (run.stopping) return this.store.get(id);
    task.revision++; task.status = 'paused'; task.reason = reason; this.store.save(task);
    this.store.notice(id, 'stop_requested', reason);
    run.stopping = status;
    run.controller.abort(new Error(reason));
    for (const op of this.store.operations(id)) {
      if (['requested', 'started'].includes(op.status)) { op.status = 'cancel_requested'; this.store.operation(op); if (!op.fileId.startsWith('native:')) this.executor.stop(op.id); }
    }
    if (!run.jobs) this.finish(run, status, reason);
    return this.store.get(id);
  }
  private finish(run: Run, status: TaskStatus, reason?: string, report?: string) {
    if (!this.accrue(run) && status === 'completed') {
      status = 'paused'; reason = '交付时检测到时钟或心跳缺口，无法证明活跃用时'; report = undefined;
    }
    const current = this.store.get(run.id);
    if (status === 'completed' && current.activeMs >= current.limitMs) {
      status = 'paused'; reason = '交付前已达到活跃执行时限；工作暂停'; report = undefined;
    }
    if (['completed', 'failed', 'cancelled'].includes(current.status)) return;
    if (run.controller.signal.aborted && !run.stopping) return;
    this.store.transaction(() => {
      this.store.transition(run.id, status, reason, report);
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        this.store.failPendingEvents(run.id, status === 'cancelled' ? '工作已取消' : '工作已结束');
      }
      if (!run.replyId && taskStatusNeedsNotice(status) && current.originMessageId) {
        const message = this.store.conversation.create({ id: randomUUID(), role: 'assistant', source: 'system',
          replyTo: current.originMessageId, text: '', status: status === 'failed' ? 'failed' : 'interrupted',
          reason: `后台工作${status === 'cancelled' ? '已取消' : status === 'failed' ? '失败' : '暂停'}：${reason ?? '未确认完成，可查看执行轨迹；没有自动重放。'}`,
          mode: this.factory.mode, paths: [] });        this.store.conversation.link(message.id, run.id);
      }
      if (run.replyId) {
        // Public text already shown to the user is never erased; the status carries "unverified".
        const reply = this.store.conversation.get(run.replyId);
        this.store.conversation.update(run.replyId, status === 'completed'
          ? { text: report ?? '', status: 'completed' }
          : { text: reply.text, status: status === 'failed' ? 'failed' : 'interrupted',
              reason: reason ? `${reason}；已显示的内容未核实，不视为最终交付。` : '工作未确认完成；已显示的内容未核实。' });
      }
    });
    if (!run.controller.signal.aborted) run.controller.abort(new Error('Task settled'));
    for (const id of run.reads.keys()) this.executor.stop(id);
    this.runs.delete(run.id);
  }
  private async prompt(run: Run, agent: AgentPort, input: string): Promise<string> {
    this.accrue(run); run.activeCalls++;
    const task = this.store.get(run.id);
    const router = agent === this.router;
    const event = JSON.parse(input) as { kind?: string };
    if (router && task.originMessageId && event.kind === 'WORKER_REPORT' && !run.replyId) {
      const reply = this.store.conversation.create({ id: randomUUID(), replyTo: task.originMessageId, role: 'assistant',
        text: '', status: 'streaming', mode: this.factory.mode, paths: [] });
      run.replyId = reply.id;
      this.store.conversation.link(reply.id, task.id);
    }
    const trace = new PromptTrace(this.store.conversation, { rootId: task.originMessageId ?? task.id,
      messageId: run.replyId ?? task.originMessageId, taskId: task.id, parentSpanId: task.id }, router ? 'router' : 'worker', this.factory.mode, router ? run.replyId : undefined);
    if (router) this.routerTrace = trace; else run.trace = trace;
    try {
      const result = await trace.run(agent, input, run.controller.signal);
      if (router) this.checkpoint();
      return result;
    } finally {
      if (router) this.routerTrace = undefined; else run.trace = undefined;
      this.accrue(run); run.activeCalls--;
    }
  }
  private accrue(run: Run): boolean {
    const now = performance.now();
    const elapsed = now - run.lastTick;
    const wallElapsed = Date.now() - run.lastWall;
    run.lastTick = now; run.lastWall = Date.now();
    const known = elapsed <= 1500 && Math.abs(wallElapsed - elapsed) <= 1500;
    const task = this.store.get(run.id);
    if (task.status === 'running' && (run.activeCalls > 0 || run.reads.size > 0)) {
      if (known) { task.activeMs += elapsed; this.store.save(task); }
      else run.clockUncertain = true;
    }
    return !run.clockUncertain;
  }
  private accrueChat(context: ChatRun) {
    if (!context.clock || context.controller.signal.aborted) return;
    const now = performance.now(); const wall = Date.now();
    const elapsed = now - context.clock.lastTick;
    const wallElapsed = wall - context.clock.lastWall;
    context.clock.lastTick = now; context.clock.lastWall = wall;
    if (elapsed > 1500 || Math.abs(wallElapsed - elapsed) > 1500) {
      context.controller.abort(new Error('Clock/heartbeat gap; Router progress interrupted without replay'));
    } else {
      context.clock.activeMs += elapsed;
      if (context.clock.activeMs >= 600_000) context.controller.abort(new Error('Router active execution time limit reached'));
    }
  }
  private tick() {
    if (this.chatContext) this.accrueChat(this.chatContext);
    for (const run of this.runs.values()) {
      if (run.stopping) continue;
      if (!this.accrue(run)) {
        this.stop(run.id, '检测到时钟或心跳缺口，无法证明活跃用时；工作暂停', 'paused'); continue;
      }
      const task = this.store.get(run.id);
      if (task.status === 'running' && task.activeMs >= task.limitMs) {
        this.stop(task.id, '已达到活跃执行时限；工作暂停。需要继续时请重新提供输入', 'paused');
      }
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true; clearInterval(this.timer);
    for (const context of this.chatRuns.values()) context.controller.abort(new Error('Service shutdown; reply interrupted without replay'));
    for (const run of this.runs.values()) this.stop(run.id, '服务关闭；工作暂停，不会自动重放', 'paused');
    await Promise.allSettled([...this.submissions]);
    await this.executor.close();
    await Promise.all([...this.jobs]);
    await Promise.allSettled([...this.chatJobs]);
    this.router?.close();
    this.store.close();
  }
}
