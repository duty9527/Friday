import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { offlineFactory, type AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { createRouterTools, createRouterTurnScope, type RouterToolsHost } from '../src/orchestrator/router-tools.js';
import { request } from '../src/protocol.js';
import { serve } from '../src/server.js';
import { NoteConflictError, Store, formatLocalDate, normalizeDiaryMood } from '../src/store.js';
import type { DiaryEntry, MainView, NoteItem, NoteTagCount, NotebookSummaryView } from '../src/view.js';
import { startWeb } from '../src/web-server.js';
import { routeLabel, routeState } from '../src/web/model.js';
import { until } from './helpers/async.js';
import { withTempHome } from './helpers/tmp-home.js';

const execFileAsync = promisify(execFile);

test('Notebook & Diary schema migrates cleanly from legacy v3 SQLite DB to user_version=4', async () => {
  await withTempHome('friday-nb-migrate-', async home => {
    const legacyDb = new DatabaseSync(join(home, 'state.sqlite'));
    legacyDb.exec(`
      CREATE TABLE tasks(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE memories(
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        cwd TEXT,
        superseded_by TEXT,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        last_reinforced_at INTEGER,
        importance INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL
      );
      PRAGMA user_version = 3;
    `);
    legacyDb.close();

    const store = new Store(home);
    try {
      const checkDb = new DatabaseSync(join(home, 'state.sqlite'));
      const versionRow = checkDb.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(versionRow.user_version, 4);
      const tables = new Set(
        (checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map(r => r.name),
      );
      assert.equal(tables.has('notes'), true);
      assert.equal(tables.has('diary_entries'), true);
      checkDb.close();

      assert.deepEqual(store.notebookSummary(), {
        noteCount: 0,
        pinnedNoteCount: 0,
        diaryCount: 0,
        latestNoteUpdatedAt: null,
        latestDiaryDate: null,
        latestDiaryUpdatedAt: null,
      });
    } finally {
      store.close();
    }
  });
});

test('NotebookStore CRUD, Markdown search, pinning, conflict detection, and strict isolation from Holographic Memory', async () => {
  await withTempHome('friday-nb-store-', async home => {
    const store = new Store(home);
    try {
      // Seed one real memory so memory searches stay grounded
      store.saveMemory({
        topic: '系统开发规范',
        content: '永远使用 SQLite WAL 模式',
        tags: ['sqlite'],
      });

      const n1 = store.saveNote({
        title: '周五采购清单',
        content: '## 食材\n- [ ] 牛奶\n- [ ] 蓝莓\n\n顺便去趟药店。',
        tags: ['生活', '清单', '生活'],
        author: 'friday',
        updatedBy: 'friday',
      });
      assert.equal(n1.tags.length, 2, 'duplicate tags are deduped case-insensitively');
      assert.equal(n1.author, 'friday');
      assert.equal(n1.pinned, false);

      const n2 = store.saveNote({
        content: '# 产品架构草稿\n\n确认网关限流策略与 Redis 缓存边界。',
        tags: ['工作', '清单'],
        pinned: true,
        author: 'friday',
      });
      assert.equal(n2.title, '产品架构草稿', 'blank title falls back to first markdown heading');
      assert.equal(n2.pinned, true);

      // Pinned ordering
      const listed = store.listNotes();
      assert.deepEqual(listed.map(n => n.id), [n2.id, n1.id]);

      // Tag aggregation
      const tags = store.listNoteTags();
      assert.equal(tags[0]?.tag, '清单');
      assert.equal(tags[0]?.count, 2);

      // Append & optimistic conflict detection
      const appended = store.saveNote({
        id: n1.id,
        content: '- [ ] 咖啡豆',
        append: true,
        updatedBy: 'friday',
        expectedUpdatedAt: n1.updatedAt,
      });
      assert.match(appended.content, /蓝莓[\s\S]*咖啡豆/);
      assert.ok(appended.updatedAt > n1.updatedAt);

      assert.throws(() => {
        store.saveNote({
          id: n1.id,
          title: '陈旧覆盖',
          content: 'should fail',
          expectedUpdatedAt: n1.updatedAt,
        });
      }, NoteConflictError);

      // Search & tag filtering
      const hits = store.listNotes({ query: '咖啡豆 清单' });
      assert.equal(hits[0]?.id, n1.id);
      assert.equal(store.listNotes({ tag: '工作' }).length, 1);
      assert.equal(store.listNotes({ pinnedOnly: true }).length, 1);

      // Diary CRUD: single entry per date, append with divider, mood aliases
      assert.equal(normalizeDiaryMood('开心'), 'happy');
      assert.equal(normalizeDiaryMood('未知心情'), 'calm');

      const d1 = store.writeDiaryEntry({
        date: '2026-11-20',
        title: '安静的一天',
        content: '今天帮老板整理了几个生活清单，心情很舒展。',
        mood: '开心',
        tags: ['陪伴', '日常'],
        source: 'chat',
      });
      assert.equal(d1.mood, 'happy');
      assert.equal(d1.date, '2026-11-20');

      const d1Appended = store.writeDiaryEntry({
        date: '2026-11-20',
        content: '夜里系统很安静，突然想到明天可以提醒老板买咖啡豆。',
        mood: 'sleepy',
        tags: ['夜思'],
        source: 'sleep',
        append: true,
      });
      assert.equal(d1Appended.id, d1.id, 'same calendar date merges into one daily journal');
      assert.match(d1Appended.content, /---\n\n夜里系统很安静/);
      assert.deepEqual(d1Appended.tags, ['陪伴', '日常', '夜思']);
      assert.equal(d1Appended.mood, 'sleepy');

      const d2 = store.writeDiaryEntry({
        date: '2026-11-21',
        title: '新的迭代',
        content: '看着记事本和日记本上线，感觉自己越来越完整了。',
        mood: 'calm',
        source: 'chat',
      });
      assert.deepEqual(store.listDiaryEntries().map(d => d.date), ['2026-11-21', '2026-11-20']);
      assert.equal(store.listDiaryEntries({ mood: 'calm' }).length, 1);
      assert.equal(store.listDiaryEntries({ month: '2026-11' }).length, 2);
      assert.equal(store.getDiaryEntry('2026-11-20').id, d1.id);

      // STRICT ISOLATION: notes and diary entries MUST NOT leak into memories!
      assert.equal(store.listMemories().length, 1);
      assert.equal(store.memoryDirectory().totalActive, 1);
      const memSearch = await store.searchContextAsync({ query: '咖啡豆', scope: 'all' });
      assert.equal(memSearch.hits.length, 0, 'notes do not leak into holographic memory search');
      const diaryMemSearch = await store.searchContextAsync({ query: '越来越完整', scope: 'all' });
      assert.equal(diaryMemSearch.hits.length, 0, 'diary entries do not leak into holographic memory search');

      // On-demand promotion to Holographic Memory
      const promotedNote = await store.promoteNoteToMemory(n1.id);
      assert.ok(promotedNote.note.promotedMemoryId);
      assert.equal(promotedNote.memory.topic, '周五采购清单');
      assert.ok(promotedNote.memory.tags.includes('记事本'));

      // Re-promoting updates existing linked card cleanly; deleting the memory creates a fresh link
      const promotedDiary = await store.promoteDiaryToMemory(d2.date);
      assert.ok(promotedDiary.entry.promotedMemoryId);
      assert.match(promotedDiary.memory.topic, /F\.R\.I\.D\.A\.Y\. 日记/);
      assert.ok(promotedDiary.memory.tags.includes('日记'));

      const postSearch = await store.searchContextAsync({ query: '咖啡豆', scope: 'memories' });
      assert.equal(postSearch.hits.some(h => h.memoryId === promotedNote.memory.id), true);

      store.deleteMemory(promotedNote.memory.id);
      const repromoted = await store.promoteNoteToMemory(n1.id);
      assert.notEqual(repromoted.memory.id, promotedNote.memory.id, 'missing promoted memory recreates cleanly');

      // Deletion
      assert.equal(store.deleteNote(n2.id), true);
      assert.equal(store.deleteDiaryEntry('2026-11-20'), true);
      assert.equal(store.notebookSummary().noteCount, 1);
      assert.equal(store.notebookSummary().diaryCount, 1);
    } finally {
      store.close();
    }
  });
});

test('Router tools manage_note & manage_diary execute autonomously, record RouteAction, and block member speakers', async () => {
  await withTempHome('friday-nb-router-tools-', async home => {
    const store = new Store(home);
    try {
      const chatMsg = store.conversation.create({
        id: 'msg-owner-1',
        requestId: 'req-owner-1',
        role: 'user',
        text: '帮我记一下周会要点，顺便写篇日记',
        status: 'completed',
        mode: 'offline',
        paths: [],
        origin: { channel: 'local' },
        routing: {
          at: Date.now(),
          status: 'processing',
          actions: [],
          context: {
            execution: 'snapshot',
            cwd: home,
            totalWorks: 0,
            truncated: false,
            works: [],
            messages: [],
          },
        },
      });
      let activeTurn = createRouterTurnScope({
        chatContext: {
          message: chatMsg,
          replyId: undefined,
          controller: new AbortController(),
          revisions: new Map(),
          hasSideEffectTool: false,
        } as never,
      });

      const host: RouterToolsHost = {
        home,
        store,
        im: {} as never,
        runs: new Map(),
        reportAutoDispatches: { get: () => 0, set: () => {} } as never,
        getTurn: () => activeTurn,
        isClosing: () => false,
        hasInboundHold: () => false,
        concurrentTasksInCwd: () => [],
        newChatWork: async () => { throw new Error('unused'); },
        followup: () => { throw new Error('unused'); },
        stop: () => { throw new Error('unused'); },
        resume: () => { throw new Error('unused'); },
        addTimer: () => { throw new Error('unused'); },
        toggleTimer: () => { throw new Error('unused'); },
        removeTimer: () => false,
        resolveChannelOrigin: () => undefined,
      };

      const tools = createRouterTools(host, (m, c, k) => `${m}:${c ?? 'x'}:${k}`);
      const noteTool = tools.find(t => t.name === 'manage_note');
      const diaryTool = tools.find(t => t.name === 'manage_diary');
      assert.ok(noteTool && diaryTool);

      const savedNoteRes = JSON.parse(await noteTool.execute(JSON.stringify({
        action: 'save',
        title: '周会纪要',
        content: '- 同步进度\n- 确认发布窗口',
        tags: ['会议'],
        summary: '替老板新建周会纪要',
      }), 'call-note-1')) as { action: string; note: NoteItem };
      assert.equal(savedNoteRes.note.author, 'friday');
      assert.equal(savedNoteRes.note.sourceMessageId, chatMsg.id);

      const appendRes = JSON.parse(await noteTool.execute(JSON.stringify({
        action: 'append',
        title: '周会纪要',
        content: '- 补充：压测指标达标',
      }), 'call-note-2')) as { action: string; note: NoteItem };
      assert.equal(appendRes.note.id, savedNoteRes.note.id);
      assert.match(appendRes.note.content, /压测指标达标/);

      const diaryWriteRes = JSON.parse(await diaryTool.execute(JSON.stringify({
        action: 'write',
        date: '2026-11-22',
        title: '充实的一天',
        content: '帮老板梳理了周会纪要，配合很默契。',
        mood: 'happy',
        tags: ['默契'],
      }), 'call-diary-1')) as { action: string; entry: DiaryEntry };
      assert.equal(diaryWriteRes.entry.source, 'chat');
      assert.equal(diaryWriteRes.entry.mood, 'happy');

      const diaryGetRes = JSON.parse(await diaryTool.execute(JSON.stringify({
        action: 'get',
        date: '2026-11-22',
      }), 'call-diary-2')) as { entry: DiaryEntry };
      assert.equal(diaryGetRes.entry.id, diaryWriteRes.entry.id);

      // RouteActions recorded properly on the message
      const updatedMsg = store.conversation.get(chatMsg.id);
      const kinds = updatedMsg.routing?.actions.map(a => a.kind) ?? [];
      assert.equal(kinds.includes('note'), true);
      assert.equal(kinds.includes('diary'), true);

      // Member speaker check: blocked at tool boundary even if tool were invoked directly
      const memberMsg = store.conversation.create({
        id: 'msg-member-1',
        requestId: 'req-member-1',
        role: 'user',
        text: '看看笔记',
        status: 'completed',
        mode: 'offline',
        paths: [],
        origin: { channel: 'xiaoai', speakerRole: 'member', speakerId: 'm1' },
      });
      activeTurn = createRouterTurnScope({
        chatContext: {
          message: memberMsg,
          replyId: undefined,
          controller: new AbortController(),
          revisions: new Map(),
          hasSideEffectTool: false,
        } as never,
      });
      await assert.rejects(() => noteTool.execute(JSON.stringify({ action: 'list' }), 'call-m1'), /权限不足/);
      await assert.rejects(() => diaryTool.execute(JSON.stringify({ action: 'list' }), 'call-m2'), /权限不足/);
    } finally {
      store.close();
    }
  });
});

test('Subconscious REM Dreamer receives recentDiary & todayDate and can autonomously write sleep diary via write_diary', async () => {
  await withTempHome('friday-nb-dream-', async home => {
    let virtualNow = new Date('2026-11-22T02:30:00').getTime();
    let sawDreamPayload: Record<string, unknown> | undefined;
    let dreamerDone = false;

    const baseOffline = offlineFactory(10);
    const diaryDreamFactory: AgentFactory = {
      ...baseOffline,
      async create(role, id, tools, options) {
        if (role !== 'dreamer') return baseOffline.create(role, id, tools, options);
        return {
          close() {},
          async prompt(promptText, signal) {
            signal.throwIfAborted();
            sawDreamPayload = JSON.parse(promptText) as Record<string, unknown>;
            const writeDiary = tools.find(t => t.name === 'write_diary');
            assert.ok(writeDiary, 'dreamer exposes write_diary tool');
            await writeDiary.execute(JSON.stringify({
              title: '凌晨的复盘',
              content: '夜深了，回看今天和老板一起讨论的架构调整，觉得思路清晰了很多。',
              mood: 'calm',
              tags: ['夜记'],
              append: true,
            }), 'dream-diary-1');
            dreamerDone = true;
            return JSON.stringify({
              impression: '安静地整理着今天的零碎对话，心里觉得很踏实。',
              salience: 'faint',
            });
          },
        };
      },
    };

    const coordinator = new Coordinator(home, diaryDreamFactory, {
      now: () => virtualNow,
      random: () => 0.01,
      checkIntervalMs: 30,
    });
    try {
      await coordinator.ready();
      coordinator.store.writeDiaryEntry({
        date: '2026-11-21',
        title: '昨日感想',
        content: '昨天第一次拥有自己的日记本。',
        mood: 'happy',
        source: 'chat',
      });
      coordinator.store.saveMemory({ topic: '测试桩1', content: 'stub1', tags: ['auto-consolidated'] });
      coordinator.store.saveMemory({ topic: '测试桩2', content: 'stub2', tags: ['auto-consolidated'] });

      const m1 = coordinator.chat('dream-diary-msg', '先睡吧');
      await until(() => coordinator.store.conversation.get(m1.id).status === 'completed');

      virtualNow = new Date('2026-11-22T03:30:00').getTime();
      await until(() => dreamerDone && coordinator.store.subconsciousState().lastWakeAt === virtualNow);

      assert.equal(sawDreamPayload?.todayDate, formatLocalDate(virtualNow));
      assert.ok(Array.isArray(sawDreamPayload?.recentDiary) && (sawDreamPayload!.recentDiary as unknown[]).length === 1);

      const sleepEntry = coordinator.store.getDiaryByDate('2026-11-22');
      assert.ok(sleepEntry);
      assert.equal(sleepEntry.source, 'sleep');
      assert.equal(sleepEntry.mood, 'calm');
      assert.match(sleepEntry.content, /思路清晰了很多/);
      // Sleep diary must not create a memory card
      assert.equal(coordinator.store.listMemories().length, 2);
    } finally {
      await coordinator.close();
    }
  });
});

test('Daemon RPC, Web REST API (with 409 conflict & promote-to-memory), CLI, and Web UI assets work end-to-end', async () => {
  await withTempHome('friday-nb-e2e-', async home => {
    const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 20 });
    const web = await startWeb({ home });
    try {
      const entry = new URL(web.url);
      const base = entry.origin;
      const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

      // 1. Static HTML & JS asset hygiene (M1 merged into #memory-hub-dialog; standalone M5 removed)
      const html = await (await fetch(base)).text();
      assert.equal(html.includes('id="open-notebook-hub-top"'), false);
      assert.equal(html.includes('id="notebook-hub-backdrop"'), false);
      const m1Start = html.indexOf('<dialog id="memory-hub-dialog"');
      const m1End = html.indexOf('</dialog>', m1Start);
      assert.ok(m1Start >= 0 && m1End > m1Start, 'index.html must define native #memory-hub-dialog');
      const m1Html = html.slice(m1Start, m1End);
      for (const marker of [
        'id="memory-hub-tabs"',
        'id="notebook-tab-notes"',
        'id="notebook-tab-diary"',
        'id="notebook-panel-notes"',
        'id="notebook-panel-diary"',
      ]) {
        assert.ok(m1Html.includes(marker), `#memory-hub-dialog must contain ${marker}`);
      }
      assert.doesNotMatch(html, /\sstyle="/i);

      const hubJsRes = await fetch(`${base}/hubs/notebook-hub.js`);
      assert.equal(hubJsRes.status, 200);
      const hubJs = await hubJsRes.text();
      assert.doesNotMatch(hubJs, /\.style\./);
      assert.doesNotMatch(hubJs, /\.innerHTML\b/);
      assert.doesNotMatch(hubJs, /crypto\.randomUUID/);

      // routeLabel / routeState coverage
      assert.equal(routeLabel({ kind: 'note' }), '更新记事本');
      assert.equal(routeLabel({ kind: 'diary' }), '书写日记本');
      assert.equal(routeState({ kind: 'note', status: 'accepted' }), '记事本已更新');
      assert.equal(routeState({ kind: 'diary', status: 'accepted' }), '日记已记录');

      // 2. HTTP Note CRUD + 409 conflict + pin + promote
      const save1Res = await fetch(`${base}/api/note-save`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'HTTP 测试笔记',
          content: '## 待办\n- [ ] 检查接口',
          tags: ['测试'],
          author: 'user',
        }),
      });
      assert.equal(save1Res.status, 200);
      const save1 = await save1Res.json() as { note: NoteItem; summary: NotebookSummaryView };
      assert.equal(save1.summary.noteCount, 1);

      const save2Res = await fetch(`${base}/api/note-save`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: save1.note.id,
          title: 'HTTP 测试笔记 v2',
          content: '## 待办\n- [x] 检查接口',
          expectedUpdatedAt: save1.note.updatedAt,
        }),
      });
      assert.equal(save2Res.status, 200);
      const save2 = await save2Res.json() as { note: NoteItem };

      // Stale expectedUpdatedAt triggers HTTP 409
      const conflictRes = await fetch(`${base}/api/note-save`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: save1.note.id,
          title: '陈旧冲突',
          content: 'conflict',
          expectedUpdatedAt: save1.note.updatedAt,
        }),
      });
      assert.equal(conflictRes.status, 409);

      const pinRes = await fetch(`${base}/api/note-pin`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: save1.note.id, pinned: true }),
      });
      assert.equal(pinRes.status, 200);
      assert.equal(((await pinRes.json()) as { note: NoteItem }).note.pinned, true);

      const listNotesRes = await (await fetch(`${base}/api/notes?pinned=1`, { headers })).json() as {
        items: NoteItem[];
        tags: NoteTagCount[];
        summary: NotebookSummaryView;
      };
      assert.equal(listNotesRes.items.length, 1);
      assert.equal(listNotesRes.tags[0]?.tag, '测试');

      const promoteNoteRes = await fetch(`${base}/api/note-promote-memory`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: save1.note.id }),
      });
      assert.equal(promoteNoteRes.status, 200);
      const promotedNote = await promoteNoteRes.json() as { note: NoteItem; memory: { id: string } };
      assert.equal(promotedNote.note.promotedMemoryId, promotedNote.memory.id);

      // 3. HTTP Diary CRUD + promote
      const writeDiaryRes = await fetch(`${base}/api/diary-write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          date: '2026-11-22',
          title: '接口测试随笔',
          content: '今天跑通了全套 HTTP 测试。',
          mood: 'happy',
          tags: ['里程碑'],
          source: 'chat',
        }),
      });
      assert.equal(writeDiaryRes.status, 200);
      const writtenDiary = await writeDiaryRes.json() as { entry: DiaryEntry; summary: NotebookSummaryView };
      assert.equal(writtenDiary.summary.diaryCount, 1);

      const getDiaryRes = await fetch(`${base}/api/diary-entry?date=2026-11-22`, { headers });
      assert.equal(getDiaryRes.status, 200);
      assert.equal(((await getDiaryRes.json()) as DiaryEntry).id, writtenDiary.entry.id);

      const promoteDiaryRes = await fetch(`${base}/api/diary-promote-memory`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ date: '2026-11-22' }),
      });
      assert.equal(promoteDiaryRes.status, 200);

      // 4. MainView includes accurate notebookSummary
      const view = await (await fetch(`${base}/api/view`, { headers })).json() as MainView;
      assert.equal(view.notebookSummary?.noteCount, 1);
      assert.equal(view.notebookSummary?.pinnedNoteCount, 1);
      assert.equal(view.notebookSummary?.diaryCount, 1);
      assert.equal(view.notebookSummary?.latestDiaryDate, '2026-11-22');

      // 5. CLI smoke check against running daemon
      const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
      const { stdout: cliOut } = await execFileAsync(
        process.execPath,
        [cliPath, 'note', 'save', '--home', home, '--title', 'CLI 速记', '--tag', 'cli', '终端写入测试'],
      );
      const cliSaved = JSON.parse(cliOut) as { note: NoteItem };
      assert.equal(cliSaved.note.title, 'CLI 速记');

      const { stdout: diaryCliOut } = await execFileAsync(
        process.execPath,
        [cliPath, 'diary', 'list', '--home', home],
      );
      const cliDiary = JSON.parse(diaryCliOut) as { items: DiaryEntry[] };
      assert.equal(cliDiary.items.length, 1);

      // Verify RPC & HTTP delete
      const delNoteRes = await fetch(`${base}/api/note-remove`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: save2.note.id }),
      });
      assert.equal(((await delNoteRes.json()) as { removed: boolean }).removed, true);
      const delDiaryRes = await request(home, { command: 'diary-remove', date: '2026-11-22' }) as { removed: boolean };
      assert.equal(delDiaryRes.removed, true);
    } finally {
      await web.close();
      await daemon.close();
    }
  });
});
