import { Conversation } from './conversation.js';
import type { SemanticEmbedder } from './semantic.js';
import type {
  ChatSubconscious,
  DistillerState,
  DreamMaterial,
  HomeostaticPassOptions,
  HomeostaticPassResult,
  RecordDreamOutcomeInput,
  SubconsciousResidue,
  SubconsciousState,
} from './store/consolidation-store.js';
import { ConsolidationStore } from './store/consolidation-store.js';
import {
  memoryDocumentText,
  MemoryStore,
  type SaveMemoryInput,
  type SearchContextOptions,
  type SearchContextResult,
} from './store/memory-store.js';
import { RuntimeOpsStore, type ImChannelConfig, type Timer } from './store/runtime-ops-store.js';
import { SqliteDb } from './store/sqlite-db.js';
import {
  TaskStore,
  type Notice,
  type Operation,
  type Task,
  type TaskEvent,
  type TaskListOptions,
  type TaskStatus,
} from './store/task-store.js';
import type { ImChannelView, MemoryCard, MemoryDirectory, SynapseRelation } from './view.js';

export type {
  ChatSubconscious,
  DistillerState,
  DreamMaterial,
  HomeostaticPassOptions,
  HomeostaticPassResult,
  ImChannelConfig,
  Notice,
  Operation,
  RecordDreamOutcomeInput,
  SaveMemoryInput,
  SearchContextOptions,
  SearchContextResult,
  SubconsciousResidue,
  SubconsciousState,
  Task,
  TaskEvent,
  TaskListOptions,
  TaskStatus,
  Timer,
};
export { memoryDocumentText };

/**
 * Unified persistence facade delegating to specialized SQLite sub-stores while
 * preserving the single-object `Store` API consumed across Friday.
 */
export class Store {
  private readonly sqlite: SqliteDb;
  private readonly tasks: TaskStore;
  private readonly runtimeOps: RuntimeOpsStore;
  private readonly memories: MemoryStore;
  private readonly consolidation: ConsolidationStore;
  readonly conversation: Conversation;

  constructor(readonly home: string) {
    this.sqlite = new SqliteDb(home);
    const atomic = <T>(run: () => T): T => this.sqlite.transaction(run);
    this.conversation = new Conversation(this.sqlite.db, atomic);
    this.tasks = new TaskStore(this.sqlite.db, atomic, this.conversation);
    this.runtimeOps = new RuntimeOpsStore(this.sqlite.db);
    this.memories = new MemoryStore(this.sqlite.db, atomic, this.tasks, this.conversation);
    this.consolidation = new ConsolidationStore(
      this.sqlite.db,
      atomic,
      this.tasks,
      this.memories,
      this.conversation,
    );
  }

  attachSemanticEngine(engine?: SemanticEmbedder): void {
    this.memories.attachSemanticEngine(engine);
  }

  getSemanticEngine(): SemanticEmbedder | undefined {
    return this.memories.getSemanticEngine();
  }

  transaction<T>(run: () => T): T {
    return this.sqlite.transaction(run);
  }

  // --- Tasks, Events, Operations & Notices ---
  create(task: Task): void {
    this.tasks.create(task);
  }

  get(id: string): Task {
    return this.tasks.get(id);
  }

  byRequest(requestId: string): Task | undefined {
    return this.tasks.byRequest(requestId);
  }

  list(limitOrOptions?: number | TaskListOptions): Task[] {
    return this.tasks.list(limitOrOptions);
  }

  countTasks(): number {
    return this.tasks.countTasks();
  }

  countOrphanTasks(): number {
    return this.tasks.countOrphanTasks();
  }

  listOrphanTasks(limit = 200): Task[] {
    return this.tasks.listOrphanTasks(limit);
  }

  listTasksForMindmap(originMessageIds: string[], taskIds: string[] = []): Task[] {
    return this.tasks.listTasksForMindmap(originMessageIds, taskIds);
  }

  save(task: Task): void {
    this.tasks.save(task);
  }

  transition(id: string, status: TaskStatus, reason?: string, report?: string): Task {
    return this.tasks.transition(id, status, reason, report);
  }

  addEvent(id: string, taskId: string, text: string): boolean {
    return this.tasks.addEvent(id, taskId, text);
  }

  takeEvents(taskId: string): TaskEvent[] {
    return this.tasks.takeEvents(taskId);
  }

  finishEvents(events: TaskEvent[]): void {
    this.tasks.finishEvents(events);
  }

  abandonEvents(events: TaskEvent[], reason: string): void {
    this.tasks.abandonEvents(events, reason);
  }

  events(taskId: string): TaskEvent[] {
    return this.tasks.events(taskId);
  }

  hasPending(taskId: string): boolean {
    return this.tasks.hasPending(taskId);
  }

  failPendingEvents(taskId: string, reason: string): void {
    this.tasks.failPendingEvents(taskId, reason);
  }

  operation(op: Operation): void {
    this.tasks.operation(op);
  }

  operationById(id: string, taskId?: string): Operation | undefined {
    return this.tasks.operationById(id, taskId);
  }

  operations(taskId: string): Operation[] {
    return this.tasks.operations(taskId);
  }

  acknowledgeUnsettledOperations(taskId: string): void {
    this.tasks.acknowledgeUnsettledOperations(taskId);
  }

  notice(taskId: string, kind: string, text: string): void {
    this.tasks.notice(taskId, kind, text);
  }

  notices(after = 0): Notice[] {
    return this.tasks.notices(after);
  }

  // --- Timers & IM Channels ---
  saveTimer(timer: Timer): void {
    this.runtimeOps.saveTimer(timer);
  }

  getTimer(id: string): Timer {
    return this.runtimeOps.getTimer(id);
  }

  listTimers(): Timer[] {
    return this.runtimeOps.listTimers();
  }

  deleteTimer(id: string): boolean {
    return this.runtimeOps.deleteTimer(id);
  }

  saveImChannel(channel: ImChannelConfig): ImChannelConfig {
    return this.runtimeOps.saveImChannel(channel);
  }

  getImChannel(id: string): ImChannelConfig {
    return this.runtimeOps.getImChannel(id);
  }

  listImChannels(): ImChannelConfig[] {
    return this.runtimeOps.listImChannels();
  }

  toImChannelView(channel: ImChannelConfig): ImChannelView {
    return this.runtimeOps.toImChannelView(channel);
  }

  listImChannelViews(): ImChannelView[] {
    return this.runtimeOps.listImChannelViews();
  }

  deleteImChannel(id: string): boolean {
    return this.runtimeOps.deleteImChannel(id);
  }

  // --- Global Memories, Synapses & Hybrid Search ---
  linkMemories(
    idA: string,
    idB: string,
    relation: SynapseRelation = 'explicit',
    weightDelta?: number,
  ): { source: MemoryCard; target: MemoryCard } {
    return this.memories.linkMemories(idA, idB, relation, weightDelta);
  }

  reinforceCoActivated(memoryIds: string[], relation: SynapseRelation = 'co_activated', delta = 0.12): void {
    this.memories.reinforceCoActivated(memoryIds, relation, delta);
  }

  saveMemory(input: SaveMemoryInput): MemoryCard {
    return this.memories.saveMemory(input);
  }

  async saveMemoryAsync(input: SaveMemoryInput): Promise<MemoryCard> {
    return this.memories.saveMemoryAsync(input);
  }

  pinMemory(id: string, pinned = true): MemoryCard {
    return this.memories.pinMemory(id, pinned);
  }

  touchMemory(id: string, options?: { active?: boolean }): MemoryCard | undefined {
    return this.memories.touchMemory(id, options);
  }

  getMemory(id: string): MemoryCard {
    return this.memories.getMemory(id);
  }

  listMemories(options?: { includeSuperseded?: boolean; cwd?: string; topic?: string; limit?: number }): MemoryCard[] {
    return this.memories.listMemories(options);
  }

  deleteMemory(id: string): boolean {
    return this.memories.deleteMemory(id);
  }

  memoryDirectory(limit = 24): MemoryDirectory {
    return this.memories.memoryDirectory(limit);
  }

  memoriesForContext(options: {
    memoryIds?: string[];
    cwd?: string;
    queryText?: string;
    queryEmbedding?: Float32Array;
    limit?: number;
  }): MemoryCard[] {
    return this.memories.memoriesForContext(options);
  }

  async memoriesForContextAsync(options: {
    memoryIds?: string[];
    cwd?: string;
    queryText?: string;
    limit?: number;
  }): Promise<MemoryCard[]> {
    return this.memories.memoriesForContextAsync(options);
  }

  searchContext(options: SearchContextOptions): SearchContextResult {
    return this.memories.searchContext(options);
  }

  async searchContextAsync(options: SearchContextOptions): Promise<SearchContextResult> {
    return this.memories.searchContextAsync(options);
  }

  async backfillEmbeddings(limit = 64, signal?: AbortSignal): Promise<number> {
    return this.memories.backfillEmbeddings(limit, signal);
  }

  // --- Distiller & Subconscious / Dreamer State ---
  distillerState(): DistillerState {
    return this.consolidation.distillerState();
  }

  saveDistillerState(state: DistillerState): void {
    this.consolidation.saveDistillerState(state);
  }

  initDistillerStateIfMissing(): DistillerState {
    return this.consolidation.initDistillerStateIfMissing();
  }

  markDistilled(update: { latestMessageSeq?: number; taskIds?: string[]; now?: number }): void {
    this.consolidation.markDistilled(update);
  }

  subconsciousState(): SubconsciousState {
    return this.consolidation.subconsciousState();
  }

  saveSubconsciousState(state: SubconsciousState): void {
    this.consolidation.saveSubconsciousState(state);
  }

  homeostaticSleepPass(now = Date.now(), options?: HomeostaticPassOptions): HomeostaticPassResult {
    return this.consolidation.homeostaticSleepPass(now, options);
  }

  sampleDreamMaterial(random: () => number = Math.random): DreamMaterial {
    return this.consolidation.sampleDreamMaterial(random);
  }

  recordDreamOutcome(input: RecordDreamOutcomeInput): void {
    this.consolidation.recordDreamOutcome(input);
  }

  peekSubconsciousForChat(now = Date.now()): ChatSubconscious | undefined {
    return this.consolidation.peekSubconsciousForChat(now);
  }

  advanceSubconsciousTurn(surfacedInsightId?: string, now = Date.now()): void {
    this.consolidation.advanceSubconsciousTurn(surfacedInsightId, now);
  }

  // --- Recovery & Lifecycle ---
  recover(): void {
    this.transaction(() => {
      this.tasks.recoverTasks();
      this.conversation.recover();
    });
  }

  close(): void {
    this.sqlite.close();
  }
}
