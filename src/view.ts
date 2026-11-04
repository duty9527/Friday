export type MessageState = 'queued' | 'processing' | 'streaming' | 'completed' | 'interrupted' | 'failed';
export type RouteKind = 'new_work' | 'followup' | 'related_work' | 'inspect' | 'stop' | 'resume' | 'recall' | 'timer' | 'reply';
export interface RouteAction {
  id: string; kind: RouteKind; status: 'pending' | 'accepted' | 'failed' | 'interrupted'; at: number;
  taskId?: string; taskLabel?: string; parentTaskId?: string; summary?: string; error?: string;
  followupId?: string; delivery?: string; messageIds?: string[];
}
export interface RoutingRecord {
  at: number; status: 'processing' | 'completed' | 'failed' | 'interrupted'; omittedActions?: number;
  context: { execution: 'native' | 'snapshot'; cwd: string; totalWorks: number; truncated: boolean;
    works: Array<{ id: string; prompt: string; status: string; revision: number }>;
    messages: Array<{ id: string; role: string; preview: string }> };
  actions: RouteAction[];
}
export interface ChatMessage {
  seq: number; version: number; id: string; requestId?: string; role: 'user' | 'assistant'; text: string;
  status: MessageState; at: number; mode: 'real' | 'offline'; paths: string[];
  replyTo?: string; taskIds: string[]; reason?: string; source?: 'router' | 'system'; routing?: RoutingRecord;
}
export interface TraceContext { rootId: string; messageId?: string; taskId?: string; spanId?: string; parentSpanId?: string }
export interface TraceEvent extends TraceContext {
  seq: number; id: string; type: 'trace' | 'message'; kind: string;
  actor: 'user' | 'router' | 'worker' | 'executor' | 'system';
  label: string; status: string; at: number; data?: unknown;
}
export interface MessagePage { items: ChatMessage[]; hasMore: boolean; before?: number }
export interface WorkView {
  id: string; prompt: string; status: string; mode: 'real' | 'offline'; createdAt: number;
  activeMs: number; limitMs: number; reason?: string; originMessageId?: string; parentTaskId?: string;
  cwd?: string; concurrentTaskIds?: string[];
}
export interface MainView {
  mode: 'real' | 'offline'; health: { status: string; executorAvailable: boolean };
  messages: MessagePage; works: WorkView[]; cursor: number;
}
