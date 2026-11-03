import { randomUUID } from 'node:crypto';
import type { AgentObservation, AgentPort } from './agent.js';
import { Conversation } from './conversation.js';
import type { TraceContext, TraceEvent } from './view.js';

export class PromptTrace {
  readonly id = randomUUID();
  private text = '';
  private chunk = '';
  private timer?: NodeJS.Timeout;
  private active = false;
  private readonly spans = new Map<string, string>();
  constructor(private readonly chat: Conversation, private readonly context: TraceContext,
    private readonly actor: 'router' | 'worker', private readonly mode: 'real' | 'offline',
    private readonly replyId?: string) {}
  toolSpan(callId?: string) { return callId ? `${this.id}:${callId}` : this.id; }
  private span(id: string, parentSpanId: string, label: string, status: string, data?: unknown) {
    if (status === 'started') this.spans.set(id, label); else this.spans.delete(id);
    this.chat.span({ ...this.context, spanId: id, parentSpanId }, this.actor, label, status, { mode: this.mode, detail: data });
  }
  observe(event: AgentObservation) {
    if (!this.active) return;
    const id = this.toolSpan(event.id);
    if (event.kind === 'text_delta') {
      const delta = (event.text ?? '').slice(0, Math.max(0, 65_536 - this.text.length));
      this.text += delta; this.chunk += delta;
      if (this.chunk.length >= 2048) this.flush();
      else if (!this.timer) { this.timer = setTimeout(() => this.flush(), 100); this.timer.unref(); }
    } else if (event.kind === 'turn_start') this.span(id, this.id, '模型推理调用', 'started');
    else if (event.kind === 'turn_end') {
      this.flush();
      const reason = event.data && typeof event.data === 'object' && 'stopReason' in event.data ? event.data.stopReason : undefined;
      this.span(id, this.id, '模型推理调用', reason === 'error' ? 'failed' : reason === 'aborted' ? 'interrupted' : 'completed', event.data);
    } else if (event.kind === 'tool_start') this.span(id, this.toolSpan(event.parentId), event.toolName ?? '工具调用', 'started', { input: event.data });
    else if (event.kind === 'tool_end') this.span(id, this.toolSpan(event.parentId), event.toolName ?? '工具调用', event.error ? 'failed' : 'completed', { output: event.data });
    else if (event.kind === 'compaction_start') this.span(id, this.toolSpan(event.parentId), '上下文压缩（SDK）', 'started', event.data);
    else if (event.kind === 'compaction_end') this.span(id, this.toolSpan(event.parentId), '上下文压缩（SDK）', event.error ? 'failed' : 'completed', event.data);
    else if (event.kind === 'retry_start') this.span(id, this.toolSpan(event.parentId), '模型请求重试（SDK）', 'started', event.data);
    else if (event.kind === 'retry_end') this.span(id, this.toolSpan(event.parentId), '模型请求重试（SDK）', event.error ? 'failed' : 'completed', event.data);
  }
  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.chunk) return;
    this.chat.emit({ ...this.context, type: 'trace', kind: 'visible_text', actor: this.actor,
      label: '模型公开输出增量', status: 'streaming', spanId: this.id, data: { text: this.chunk, mode: this.mode } });
    this.chunk = '';
    if (this.replyId) this.chat.update(this.replyId, { text: this.text, status: 'streaming' });
  }
  async run(agent: AgentPort, input: string, signal: AbortSignal): Promise<string> {
    this.active = true;
    this.chat.span({ ...this.context, spanId: this.id }, this.actor, 'Agent 请求', 'started', { mode: this.mode, input: JSON.parse(input) });
    try {
      const result = await agent.prompt(input, signal);
      if (signal.aborted) throw signal.reason;
      if (result.length > 65_536) throw new Error('Agent reply exceeds delivery limit');
      this.flush();
      this.chat.span({ ...this.context, spanId: this.id }, this.actor, 'Agent 请求', 'completed', { mode: this.mode, output: result });
      return result;
    } catch (error) {
      this.flush();
      const status = signal.aborted ? 'interrupted' : 'failed';
      for (const [id, label] of [...this.spans]) this.span(id, this.id, label, status, { reason: '请求未确认正常结束' });
      this.chat.span({ ...this.context, spanId: this.id }, this.actor, 'Agent 请求', status,
        { mode: this.mode, error: error instanceof Error ? error.message : 'Agent request failed' });
      throw error;
    } finally {
      this.active = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    }
  }
}
