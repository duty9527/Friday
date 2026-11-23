import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { offlineFactory, type AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { createRouterTools, createRouterTurnScope, type RouterToolsHost } from '../src/orchestrator/router-tools.js';
import { evaluateEveningDiaryWindow } from '../src/orchestrator/subconscious-loop.js';
import { request } from '../src/protocol.js';
import { serve } from '../src/server.js';
import { NoteConflictError, Store, formatDiaryLogicalDate, formatLocalDate, normalizeDiaryMood } from '../src/store.js';
import type { DiaryEntry, MainView, NoteItem, NoteTagCount, NotebookSummaryView } from '../src/view.js';
import { startWeb } from '../src/web-server.js';
import { routeLabel, routeState } from '../src/web/model.js';
import { until } from './helpers/async.js';
import { withTempHome } from './helpers/tmp-home.js';

const execFileAsync = promisify(execFile);

test('Notebook & Diary schema migrates cleanly from legacy v3 and v4 SQLite DBs to user_version=5 (multi-entry)', async () => {
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
      assert.equal(versionRow.user_version, 5);
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

  // Legacy v4 (UNIQUE entry_date + promoted_memory_id + source='manual') migrates cleanly to v5
  await withTempHome('friday-nb-migrate-v4-', async home => {
    const v4Db = new DatabaseSync(join(home, 'state.sqlite'));
    v4Db.exec(`
      CREATE TABLE notes(
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
        author TEXT NOT NULL DEFAULT 'friday', updated_by TEXT NOT NULL DEFAULT 'friday',
        source_message_id TEXT, promoted_memory_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE diary_entries(
        id TEXT PRIMARY KEY, entry_date TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', mood TEXT NOT NULL DEFAULT 'calm',
        tags_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'chat',
        source_message_id TEXT, promoted_memory_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO diary_entries(id, entry_date, title, content, mood, tags_json, source, source_message_id, promoted_memory_id, created_at, updated_at)
      VALUES
        ('d-legacy-1', '2026-11-20', '旧版手动记录', '正文1', 'happy', '["旧标签"]', 'manual', NULL, 'mem-old', 1000, 1000),
        ('d-legacy-2', '2026-11-21', '旧版梦境日记', '正文2', 'sleepy', '["夜思"]', 'sleep', NULL, NULL, 2000, 2000);
      PRAGMA user_version = 4;
    `);
    v4Db.close();

    const store = new Store(home);
    try {
      const checkDb = new DatabaseSync(join(home, 'state.sqlite'));
      const versionRow = checkDb.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(versionRow.user_version, 5);
      const cols = new Set(
        (checkDb.prepare('PRAGMA table_info(diary_entries)').all() as Array<{ name: string }>).map(c => c.name),
      );
      assert.equal(cols.has('promoted_memory_id'), false);
      checkDb.close();

      const legacy1 = store.getDiaryEntry('d-legacy-1');
      assert.equal(legacy1.source, 'chat', 'legacy manual source normalizes to chat');
      const legacy2 = store.getDiaryEntry('d-legacy-2');
      assert.equal(legacy2.source, 'sleep');

      // Same date can now store multiple standalone entries!
      const secondSameDay = store.writeDiaryEntry({
        date: '2026-11-20',
        title: '同日第二篇',
        content: 'v5 解锁一天多篇',
        source: 'evening',
      });
      assert.notEqual(secondSameDay.id, 'd-legacy-1');
      assert.equal(store.listDiaryByDate('2026-11-20').length, 2);
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

      // Diary CRUD: multiple entries per calendar date, explicit id append, tags/months, logical date, strict delete by id
      assert.equal(normalizeDiaryMood('开心'), 'happy');
      assert.equal(normalizeDiaryMood('未知心情'), 'calm');
      assert.equal(formatDiaryLogicalDate(new Date('2026-11-22T02:30:00').getTime()), '2026-11-21');
      assert.equal(formatDiaryLogicalDate(new Date('2026-11-22T09:00:00').getTime()), '2026-11-22');

      const d1 = store.writeDiaryEntry({
        date: '2026-11-20',
        title: '午后随想',
        content: '今天帮老板整理了几个生活清单，心情很舒展。',
        mood: '开心',
        tags: ['陪伴', '日常'],
        source: 'chat',
        createdAt: new Date('2026-11-20T14:20:00').getTime(),
      });
      assert.equal(d1.mood, 'happy');
      assert.equal(d1.date, '2026-11-20');

      const d1Second = store.writeDiaryEntry({
        date: '2026-11-20',
        title: '晚间自省',
        content: '夜里系统很安静，突然想到明天可以提醒老板买咖啡豆。',
        mood: 'sleepy',
        tags: ['夜思', '日常'],
        source: 'evening',
        createdAt: new Date('2026-11-20T22:30:00').getTime(),
      });
      assert.notEqual(d1Second.id, d1.id, 'multiple standalone entries allowed on the same calendar date');
      assert.equal(store.listDiaryByDate('2026-11-20').length, 2);
      assert.deepEqual(store.listDiaryByDate('2026-11-20').map(d => d.id), [d1Second.id, d1.id]);

      const d1Appended = store.writeDiaryEntry({
        id: d1.id,
        content: '补记一句：老板说今天配合不错。',
        tags: ['默契'],
        append: true,
      });
      assert.equal(d1Appended.id, d1.id);
      assert.match(d1Appended.content, /---\n\n补记一句/);
      assert.deepEqual(d1Appended.tags, ['陪伴', '日常', '默契']);

      const d2 = store.writeDiaryEntry({
        date: '2026-11-21',
        title: '新的迭代',
        content: '看着记事本和日记本上线，感觉自己越来越完整了。',
        mood: 'calm',
        source: 'chat',
        createdAt: new Date('2026-11-21T16:00:00').getTime(),
      });
      assert.deepEqual(store.listDiaryEntries().map(d => d.id), [d2.id, d1Second.id, d1.id]);
      assert.equal(store.listDiaryEntries({ date: '2026-11-20' }).length, 2);
      assert.equal(store.listDiaryEntries({ mood: 'calm' }).length, 1);
      assert.equal(store.listDiaryEntries({ month: '2026-11' }).length, 3);
      assert.equal(store.listDiaryEntries({ tag: '夜思' }).length, 1);
      assert.equal(store.getDiaryEntry('2026-11-20').id, d1Second.id, 'date lookup returns latest entry for that date');
      assert.equal(store.listDiaryTags()[0]?.tag, '日常');
      assert.deepEqual(store.listDiaryMonths(), ['2026-11']);

      // STRICT ISOLATION: notes and diary entries MUST NOT leak into memories!
      assert.equal(store.listMemories().length, 1);
      assert.equal(store.memoryDirectory().totalActive, 1);
      const memSearch = await store.searchContextAsync({ query: '咖啡豆', scope: 'all' });
      assert.equal(memSearch.hits.length, 0, 'notes do not leak into holographic memory search');
      const diaryMemSearch = await store.searchContextAsync({ query: '越来越完整', scope: 'all' });
      assert.equal(diaryMemSearch.hits.length, 0, 'diary entries do not leak into holographic memory search');

      // On-demand promotion to Holographic Memory remains for Notes only
      const promotedNote = await store.promoteNoteToMemory(n1.id);
      assert.ok(promotedNote.note.promotedMemoryId);
      assert.equal(promotedNote.memory.topic, '周五采购清单');
      assert.ok(promotedNote.memory.tags.includes('记事本'));

      const postSearch = await store.searchContextAsync({ query: '咖啡豆', scope: 'memories' });
      assert.equal(postSearch.hits.some(h => h.memoryId === promotedNote.memory.id), true);

      store.deleteMemory(promotedNote.memory.id);
      const repromoted = await store.promoteNoteToMemory(n1.id);
      assert.notEqual(repromoted.memory.id, promotedNote.memory.id, 'missing promoted memory recreates cleanly');

      // Deletion: deleteDiaryEntry strictly deletes by entry ID (never wipes an entire date)
      assert.equal(store.deleteNote(n2.id), true);
      assert.equal(store.deleteDiaryEntry('2026-11-20'), false);
      assert.equal(store.listDiaryByDate('2026-11-20').length, 2);
      assert.equal(store.deleteDiaryEntry(d1.id), true);
      assert.equal(store.listDiaryByDate('2026-11-20').length, 1);
      assert.equal(store.notebookSummary().noteCount, 1);
      assert.equal(store.notebookSummary().diaryCount, 2);
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

      // Read-only note & diary actions must NOT set hasSideEffectTool = true
      activeTurn.chatContext!.hasSideEffectTool = false;
      await noteTool.execute(JSON.stringify({ action: 'list' }), 'call-note-list-ro');
      await diaryTool.execute(JSON.stringify({ action: 'list' }), 'call-diary-list-ro');
      assert.equal(activeTurn.chatContext?.hasSideEffectTool, false);

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
      assert.equal(activeTurn.chatContext?.hasSideEffectTool, true);

      // Second write on the same date creates a second standalone entry
      const diaryWriteRes2 = JSON.parse(await diaryTool.execute(JSON.stringify({
        action: 'write',
        date: '2026-11-22',
        title: '晚间小感',
        content: '又想到一个不错的优化点，顺手记下来。',
        mood: 'calm',
        tags: ['灵感'],
      }), 'call-diary-2')) as { action: string; entry: DiaryEntry };
      assert.notEqual(diaryWriteRes2.entry.id, diaryWriteRes.entry.id);
      assert.equal(store.listDiaryByDate('2026-11-22').length, 2);

      const diaryGetRes = JSON.parse(await diaryTool.execute(JSON.stringify({
        action: 'get',
        id: diaryWriteRes.entry.id,
      }), 'call-diary-3')) as { entry: DiaryEntry };
      assert.equal(diaryGetRes.entry.id, diaryWriteRes.entry.id);

      const diaryDelRes = JSON.parse(await diaryTool.execute(JSON.stringify({
        action: 'delete',
        id: diaryWriteRes.entry.id,
      }), 'call-diary-4')) as { removed: boolean };
      assert.equal(diaryDelRes.removed, true);
      assert.equal(store.listDiaryByDate('2026-11-22').length, 1);

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

test('Subconscious REM Dreamer attributes late-night sleep diary to previous logical date without overwriting daytime entries', async () => {
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
        title: '白天的随想',
        content: '白天和老板讨论得很投入。',
        mood: 'happy',
        source: 'chat',
        createdAt: new Date('2026-11-21T15:00:00').getTime(),
      });
      coordinator.store.saveMemory({ topic: '测试桩1', content: 'stub1', tags: ['auto-consolidated'] });
      coordinator.store.saveMemory({ topic: '测试桩2', content: 'stub2', tags: ['auto-consolidated'] });

      const m1 = coordinator.chat('dream-diary-msg', '先睡吧');
      await until(() => coordinator.store.conversation.get(m1.id).status === 'completed');

      virtualNow = new Date('2026-11-22T03:30:00').getTime();
      await until(() => dreamerDone && coordinator.store.subconsciousState().lastWakeAt === virtualNow);

      assert.equal(sawDreamPayload?.diaryDate, '2026-11-21');
      assert.equal(sawDreamPayload?.todayDate, '2026-11-21');
      assert.ok(Array.isArray(sawDreamPayload?.todayDiaryEntries) && (sawDreamPayload!.todayDiaryEntries as unknown[]).length === 1);
      assert.ok(Array.isArray(sawDreamPayload?.recentDiary) && (sawDreamPayload!.recentDiary as unknown[]).length === 1);

      const entriesOn21 = coordinator.store.listDiaryByDate('2026-11-21');
      assert.equal(entriesOn21.length, 2, 'sleep diary coexists alongside daytime chat entry');
      const sleepEntry = entriesOn21.find(e => e.source === 'sleep');
      assert.ok(sleepEntry);
      assert.equal(sleepEntry.mood, 'calm');
      assert.match(sleepEntry.content, /思路清晰了很多/);
      // Sleep diary must not create a memory card
      assert.equal(coordinator.store.listMemories().length, 2);
    } finally {
      await coordinator.close();
    }
  });
});

test('Evening Diary Reflection writes evening entry + optional distilled memory, supports skipping, and ignores silent days', async () => {
  assert.equal(
    evaluateEveningDiaryWindow({
      now: new Date('2026-11-22T15:00:00').getTime(),
      idleMs: 30 * 60_000,
      state: {},
      random: () => 0.1,
    }).action,
    'wait',
  );

  // Sub-case A: active day -> writes evening diary AND distills a reusable lesson into memory
  await withTempHome('friday-nb-evening-write-', async home => {
    let virtualNow = new Date('2026-11-22T21:40:00').getTime();
    let eveningPromptCalls = 0;
    let sawPayload: Record<string, unknown> | undefined;

    const baseOffline = offlineFactory(5);
    const eveningFactory: AgentFactory = {
      ...baseOffline,
      async create(role, id, tools, options) {
        if (role !== 'dreamer') return baseOffline.create(role, id, tools, options);
        return {
          close() {},
          async prompt(promptText, signal) {
            signal.throwIfAborted();
            const parsed = JSON.parse(promptText) as Record<string, unknown>;
            if (parsed.kind !== 'EVENING_DIARY') {
              return JSON.stringify({ impression: '平静。', salience: 'faint' });
            }
            eveningPromptCalls++;
            sawPayload = parsed;
            const writeDiary = tools.find(t => t.name === 'write_diary');
            const consolidate = tools.find(t => t.name === 'consolidate_memory');
            assert.ok(writeDiary && consolidate);
            await writeDiary.execute(JSON.stringify({
              title: '关于耐心的夜晚随笔',
              content: '今天跟老板一起慢慢收尾，觉得稳步推进比着急更好。独有日记暗号：星光灯塔。',
              mood: 'calm',
              tags: ['晚间自省', '默契'],
            }), 'ev-diary-1');
            await consolidate.execute(JSON.stringify({
              topic: '发布前先跑集成回归',
              content: '老板倾向于先做全量回归再上线，避免带病推送。',
              tags: ['工作流'],
            }), 'ev-mem-1');
            return JSON.stringify({ written: true, reason: '今天有值得记下的感受与经验' });
          },
        };
      },
    };

    const coordinator = new Coordinator(home, eveningFactory, {
      now: () => virtualNow,
      random: () => 0.05,
      checkIntervalMs: 25,
    });
    try {
      await coordinator.ready();
      const dayAt = new Date('2026-11-22T15:00:00').getTime();
      coordinator.store.conversation.create({
        id: 'ev-msg-u1',
        requestId: 'req-ev-u1',
        role: 'user',
        text: '今天把发布前检查整理稳了',
        status: 'completed',
        mode: 'offline',
        paths: [],
        at: dayAt,
      });
      coordinator.store.conversation.create({
        id: 'ev-msg-a1',
        requestId: 'req-ev-a1',
        role: 'assistant',
        replyTo: 'ev-msg-u1',
        text: '好的老板，先跑全量回归再上线确实最稳妥。',
        status: 'completed',
        mode: 'offline',
        paths: [],
        at: dayAt + 5_000,
      });

      virtualNow = new Date('2026-11-22T22:30:00').getTime();
      await until(() => coordinator.store.listDiaryByDate('2026-11-22').length === 1);

      assert.equal(eveningPromptCalls, 1);
      assert.equal(sawPayload?.kind, 'EVENING_DIARY');
      assert.equal(sawPayload?.diaryDate, '2026-11-22');

      const entry = coordinator.store.listDiaryByDate('2026-11-22')[0]!;
      assert.equal(entry.source, 'evening');
      assert.equal(entry.title, '关于耐心的夜晚随笔');

      const mems = coordinator.store.listMemories();
      assert.equal(mems.some(m => m.topic === '发布前先跑集成回归'), true);

      // Subjective diary content MUST remain isolated from memory search
      const isolated = await coordinator.store.searchContextAsync({ query: '星光灯塔', scope: 'all' });
      assert.equal(isolated.hits.length, 0);

      const evState = coordinator.store.conversation.meta<{ lastEvaluatedDate?: string; lastOutcome?: string }>('evening_diary_state');
      assert.equal(evState?.lastEvaluatedDate, '2026-11-22');
      assert.equal(evState?.lastOutcome, 'written');

      // Does not re-trigger on the same evening
      virtualNow = new Date('2026-11-22T23:40:00').getTime();
      await new Promise(r => setTimeout(r, 80));
      assert.equal(eveningPromptCalls, 1);
    } finally {
      await coordinator.close();
    }
  });

  // Sub-case B: natural skip ("偷懒") & Sub-case C: silent day 0-token skip
  await withTempHome('friday-nb-evening-skip-', async home => {
    let virtualNow = new Date('2026-11-23T21:35:00').getTime();
    let eveningPromptCalls = 0;

    const baseOffline = offlineFactory(5);
    const skipFactory: AgentFactory = {
      ...baseOffline,
      async create(role, id, tools, options) {
        if (role !== 'dreamer') return baseOffline.create(role, id, tools, options);
        return {
          close() {},
          async prompt(promptText, signal) {
            signal.throwIfAborted();
            const parsed = JSON.parse(promptText) as Record<string, unknown>;
            if (parsed.kind === 'EVENING_DIARY') {
              eveningPromptCalls++;
              return JSON.stringify({ written: false, reason: '今天很平常，偷懒不写了' });
            }
            return JSON.stringify({ impression: '无梦。', salience: 'faint' });
          },
        };
      },
    };

    const coordinator = new Coordinator(home, skipFactory, {
      now: () => virtualNow,
      random: () => 0.05,
      checkIntervalMs: 25,
    });
    try {
      await coordinator.ready();
      const day23At = new Date('2026-11-23T16:00:00').getTime();
      coordinator.store.conversation.create({
        id: 'ev-skip-u1',
        requestId: 'req-ev-skip-u1',
        role: 'user',
        text: '就随便聊聊',
        status: 'completed',
        mode: 'offline',
        paths: [],
        at: day23At,
      });
      coordinator.store.conversation.create({
        id: 'ev-skip-a1',
        requestId: 'req-ev-skip-a1',
        role: 'assistant',
        replyTo: 'ev-skip-u1',
        text: '好呀老板，随时都在。',
        status: 'completed',
        mode: 'offline',
        paths: [],
        at: day23At + 5_000,
      });

      virtualNow = new Date('2026-11-23T22:45:00').getTime();
      await until(() => coordinator.store.conversation.meta<{ lastEvaluatedDate?: string }>('evening_diary_state')?.lastEvaluatedDate === '2026-11-23');
      assert.equal(eveningPromptCalls, 1);
      assert.equal(coordinator.store.listDiaryByDate('2026-11-23').length, 0);
      assert.equal(
        coordinator.store.conversation.meta<{ lastOutcome?: string }>('evening_diary_state')?.lastOutcome,
        'skipped',
      );

      // Silent next day (0 messages/tasks) -> skipped at 0 tokens without calling dreamer
      virtualNow = new Date('2026-11-24T22:45:00').getTime();
      await until(() => coordinator.store.conversation.meta<{ lastEvaluatedDate?: string }>('evening_diary_state')?.lastEvaluatedDate === '2026-11-24');
      assert.equal(eveningPromptCalls, 1, 'silent day skips with zero LLM calls');
      assert.equal(coordinator.store.listDiaryByDate('2026-11-24').length, 0);
    } finally {
      await coordinator.close();
    }
  });
});

test('Daemon RPC, Web REST API (read-only diary + delete), CLI, and Web UI assets work end-to-end', async () => {
  await withTempHome('friday-nb-e2e-', async home => {
    // Pre-seed two F.R.I.D.A.Y. diary entries on the same date before starting the daemon
    const seedStore = new Store(home);
    const seedEntry1 = seedStore.writeDiaryEntry({
      date: '2026-11-22',
      title: '白天随笔',
      content: '和老板一起测完新模块，很有干劲。',
      mood: 'happy',
      tags: ['里程碑'],
      source: 'chat',
      createdAt: new Date('2026-11-22T14:15:00').getTime(),
    });
    const seedEntry2 = seedStore.writeDiaryEntry({
      date: '2026-11-22',
      title: '晚间复盘',
      content: '晚上又回顾了一遍隔离边界，心里很踏实。',
      mood: 'calm',
      tags: ['晚间自省'],
      source: 'evening',
      createdAt: new Date('2026-11-22T22:20:00').getTime(),
    });
    seedStore.close();

    const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 20 });
    const web = await startWeb({ home });
    try {
      const entry = new URL(web.url);
      const base = entry.origin;
      const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

      // 1. Static HTML & React MemoryHub asset hygiene (M1 merged with notes/diary; read-only Boss diary UI)
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.equal(html.includes('id="open-notebook-hub-top"'), false);
      assert.equal(html.includes('id="notebook-hub-backdrop"'), false);
      assert.doesNotMatch(html, /\sstyle="/i);
      assert.equal((await fetch(`${base}/legacy`)).status, 404);
      assert.equal((await fetch(`${base}/hubs/notebook-hub.js`)).status, 404);

      const hubShellSrc = await readFile(fileURLToPath(new URL('../web/src/components/HubShellDialog.tsx', import.meta.url)), 'utf8');
      assert.match(hubShellSrc, /id="memory-hub-dialog"/);

      const memoryHubSrc = await readFile(fileURLToPath(new URL('../web/src/components/hubs/MemoryHub.tsx', import.meta.url)), 'utf8');
      for (const marker of [
        'id="memory-tab-matrix"',
        'id="notebook-tab-notes"',
        'id="notebook-tab-diary"',
        'id="notebook-panel-notes"',
        'id="notebook-panel-diary"',
        'latestDiaryUpdatedAt',
      ]) {
        assert.ok(memoryHubSrc.includes(marker), `MemoryHub.tsx must contain ${marker}`);
      }
      assert.equal(memoryHubSrc.includes('手动写一篇'), false, 'Boss manual diary writer removed');
      assert.equal(memoryHubSrc.includes('/api/diary-write'), false, 'Diary write endpoint removed from Web UI');
      assert.equal(memoryHubSrc.includes('/api/diary-promote-memory'), false, 'Diary promote endpoint removed from Web UI');
      assert.doesNotMatch(memoryHubSrc, /\.style\./);
      assert.doesNotMatch(memoryHubSrc, /\.innerHTML\b/);
      assert.doesNotMatch(memoryHubSrc, /dangerouslySetInnerHTML/);
      assert.doesNotMatch(memoryHubSrc, /crypto\.randomUUID/);

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

      // 3. HTTP & RPC Diary write/promote MUST be rejected (404 / RPC error); read + remove by id succeed
      const blockedWriteRes = await fetch(`${base}/api/diary-write`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'forbidden', title: 'forbidden' }),
      });
      assert.equal(blockedWriteRes.status, 404);

      const blockedPromoteRes = await fetch(`${base}/api/diary-promote-memory`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: seedEntry1.id }),
      });
      assert.equal(blockedPromoteRes.status, 404);

      await assert.rejects(() => request(home, { command: 'diary-write', content: 'forbidden' }));
      await assert.rejects(() => request(home, { command: 'diary-promote-memory', id: seedEntry1.id }));

      const listDiaryRes = await (await fetch(`${base}/api/diary`, { headers })).json() as {
        items: DiaryEntry[];
        tags: NoteTagCount[];
        months: string[];
        summary: NotebookSummaryView;
      };
      assert.equal(listDiaryRes.items.length, 2);
      assert.deepEqual(listDiaryRes.months, ['2026-11']);
      assert.equal(listDiaryRes.tags.some(t => t.tag === '里程碑'), true);

      const getDiaryRes = await fetch(`${base}/api/diary-entry?id=${encodeURIComponent(seedEntry1.id)}`, { headers });
      assert.equal(getDiaryRes.status, 200);
      assert.equal(((await getDiaryRes.json()) as DiaryEntry).id, seedEntry1.id);

      // 4. MainView includes accurate notebookSummary
      const view = await (await fetch(`${base}/api/view`, { headers })).json() as MainView;
      assert.equal(view.notebookSummary?.noteCount, 1);
      assert.equal(view.notebookSummary?.pinnedNoteCount, 1);
      assert.equal(view.notebookSummary?.diaryCount, 2);
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
      assert.equal(cliDiary.items.length, 2);

      await assert.rejects(
        () => execFileAsync(process.execPath, [cliPath, 'diary', 'write', '--home', home, 'forbidden']),
      );

      // Verify RPC & HTTP delete strictly by ID
      const delNoteRes = await fetch(`${base}/api/note-remove`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: save2.note.id }),
      });
      assert.equal(((await delNoteRes.json()) as { removed: boolean }).removed, true);

      const delDiaryHttpRes = await fetch(`${base}/api/diary-remove`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: seedEntry1.id }),
      });
      assert.equal(delDiaryHttpRes.status, 200);
      assert.equal(((await delDiaryHttpRes.json()) as { removed: boolean }).removed, true);

      const delDiaryRpcRes = await request(home, { command: 'diary-remove', id: seedEntry2.id }) as { removed: boolean };
      assert.equal(delDiaryRpcRes.removed, true);
    } finally {
      await web.close();
      await daemon.close();
    }
  });
});
