import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ChatMessage, TraceEvent, WorkView } from '../src/view.js';
import {
  buildExecutionChain,
  buildFallbackBundleFromAppState,
  extractReadableOperationOutput,
  type ExecutionTraceBundle,
} from '../src/web/trace-chain.js';

function makeEvent(overrides: Partial<TraceEvent> & { seq: number }): TraceEvent {
  return {
    id: `ev-${overrides.seq}`,
    rootId: 'msg-user-1',
    type: 'trace',
    kind: 'span',
    actor: 'router',
    label: 'span',
    status: 'completed',
    at: 1_700_000_000_000 + overrides.seq * 100,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: 'user' | 'assistant' }): ChatMessage {
  return {
    seq: 1,
    version: 1,
    requestId: `req-${overrides.id}`,
    text: '',
    status: 'completed',
    at: 1_700_000_000_000,
    mode: 'real',
    paths: [],
    taskIds: [],
    ...overrides,
  };
}

test('buildExecutionChain builds full end-to-end WeChat -> Router -> Jev -> Worker -> Tools -> Quality -> Delivery chain without duplicates or raw JSON', () => {
  const t0 = 1_700_000_000_000;
  const taskId = 'task-100';
  const msgUserId = 'msg-u1';
  const msgReplyId = 'msg-a1';

  const bundle: ExecutionTraceBundle = {
    scope: { type: 'task', id: taskId },
    cursor: 32,
    streamedTextBySpan: {
      'router-turn-2': '已为您在仓库执行校验并更新配置，12 项测试全部通过。',
    },
    messages: [
      makeMessage({
        id: msgUserId,
        seq: 1,
        version: 11,
        role: 'user',
        text: '帮我跑一下单测并修复配置问题',
        at: t0 + 100,
        taskIds: [taskId],
        origin: {
          channel: 'wechat',
          channelId: 'ch-wx-1',
          speakerId: 'sp-1',
          speakerName: '老板',
          speakerRole: 'owner',
        },
        sessionId: 'sess-1',
        sessionLink: {
          kind: 'topic_continuity',
          source: 'gemini-decision-1',
          gapSec: 12,
          confidence: 0.93,
          label: '延续当前项目调试',
          detail: '紧接上一轮仓库排查请求',
        },
        attachments: [{ kind: 'file', name: 'error.log', status: 'ready' }],
        paths: ['/workspace/Friday/config.json'],
      }),
      // Assistant message created BEFORE WORKER_REPORT Router turn (at t0 + 5000), updated AFTER at version 32
      makeMessage({
        id: msgReplyId,
        seq: 2,
        version: 32,
        role: 'assistant',
        replyTo: msgUserId,
        text: '已完成排查并修复 config.json，单测 12 项全部通过。',
        at: t0 + 5000,
        taskIds: [taskId],
        origin: { channel: 'wechat', channelId: 'ch-wx-1' },
      }),
    ],
    task: {
      id: taskId,
      originMessageId: msgUserId,
      prompt: '【任务：修复配置并运行测试】检查 config.json 并运行单测',
      status: 'completed',
      createdAt: t0 + 900,
      activeMs: 4100,
      limitMs: 600_000,
      cwd: '/workspace/Friday',
      profile: 'coding',
      workerModel: 'openai-codex/gpt-5.3-codex',
      modelTier: 'strong',
      thinkingLevel: 'high',
      decisionSource: 'gemini-decision-1',
      decisionConfidence: 0.91,
      skipQualityGate: false,
      qualityGate: {
        score: 3,
        maxScore: 3,
        confidence: 0.96,
        supplementProbability: 0.04,
        shouldSupplement: false,
        missingAspect: 'none',
        source: 'gemini-decision-1',
        evaluatedAt: t0 + 4900,
      },
      contextBrief: '用户在微信上传了 error.log，要求定位配置问题并跑通单测。',
      report: '已定位到 config.json 缺少 timeout 字段，修复后测试通过。',
      followups: [],
      memories: [
        { id: 'mem-1', topic: 'Friday 配置规范', tags: ['config', 'coding'], preview: 'timeout 默认建议 30000ms' },
      ],
      operations: [
        {
          id: `${taskId}:call-bash-1`,
          fileId: 'native:bash',
          status: 'succeeded',
          parentSpanId: `worker-req-1:call-bash-1`,
          hasFullResult: false,
        },
        {
          id: 'op-read-snap-1',
          fileId: 'f0',
          status: 'succeeded',
          parentSpanId: `worker-req-1:call-snap-1`,
          resultPreview: '{"content":[{"type":"text","text":"snapshot file preview"}]}',
          resultTruncated: true,
          hasFullResult: true,
        },
      ],
    },
    linkedTasks: [
      {
        id: taskId,
        prompt: '【任务：修复配置并运行测试】检查 config.json 并运行单测',
        status: 'completed',
        profile: 'coding',
        workerModel: 'openai-codex/gpt-5.3-codex',
        modelTier: 'strong',
        thinkingLevel: 'high',
        activeMs: 4100,
        createdAt: t0 + 900,
      },
    ],
    events: [
      // message_created must merge with bundle.messages[0], not duplicate
      makeEvent({ seq: 1, type: 'message', kind: 'message_created', actor: 'user', messageId: msgUserId, spanId: msgUserId, at: t0 + 100, label: '用户消息' }),
      makeEvent({
        seq: 2,
        kind: 'session_assigned',
        actor: 'system',
        messageId: msgUserId,
        at: t0 + 150,
        label: '延续当前项目调试',
        data: {
          sessionId: 'sess-1',
          sessionLink: {
            kind: 'topic_continuity',
            source: 'gemini-decision-1',
            gapSec: 12,
            confidence: 0.93,
            label: '延续当前项目调试',
            detail: '紧接上一轮仓库排查请求',
          },
        },
      }),
      // Bookkeeping noise events that must be ignored
      makeEvent({ seq: 3, kind: 'work_linked', actor: 'router', messageId: msgUserId, taskId, at: t0 + 180, label: '关联后台工作', status: 'linked' }),
      makeEvent({ seq: 4, kind: 'message_updated', type: 'message', actor: 'user', messageId: msgUserId, at: t0 + 190, label: '用户消息' }),
      makeEvent({ seq: 5, kind: 'thinking', actor: 'router', messageId: msgUserId, spanId: 'router-turn-1', at: t0 + 200, label: 'thinking' }),

      // Router CHAT turn
      makeEvent({
        seq: 6,
        spanId: 'router-req-1',
        parentSpanId: msgUserId,
        actor: 'router',
        label: 'Agent 请求',
        status: 'started',
        at: t0 + 210,
        messageId: msgUserId,
        data: { mode: 'real', trigger: { kind: 'CHAT', messageId: msgUserId, preview: '帮我跑一下单测并修复配置问题' }, input: { deliveryChannel: 'wechat' } },
      }),
      makeEvent({
        seq: 7,
        spanId: 'router-turn-1',
        parentSpanId: 'router-req-1',
        actor: 'router',
        label: '模型推理调用',
        status: 'started',
        at: t0 + 230,
        messageId: msgUserId,
        data: { mode: 'real', detail: { provider: 'openai', model: 'gpt-5-mini' } },
      }),
      // Router tool start_work + route_action (must merge & deduplicate!)
      makeEvent({
        seq: 8,
        spanId: 'router-req-1:call-start-work',
        parentSpanId: 'router-turn-1',
        actor: 'router',
        label: 'start_work',
        status: 'started',
        at: t0 + 400,
        messageId: msgUserId,
        data: {
          mode: 'real',
          detail: {
            input: {
              input: JSON.stringify({
                instruction: '检查 config.json 并运行单测',
                cwd: '/workspace/Friday',
                profile: 'coding',
                summary: '派发编码子 AI 进行排查',
              }),
            },
          },
          summary: { input: { instruction: '检查 config.json 并运行单测', cwd: '/workspace/Friday' } },
        },
      }),
      makeEvent({
        seq: 9,
        kind: 'route_action',
        spanId: 'ra-1',
        parentSpanId: 'router-req-1:call-start-work',
        actor: 'router',
        label: 'new_work',
        status: 'pending',
        at: t0 + 420,
        messageId: msgUserId,
        taskId,
        data: { id: 'ra-1', kind: 'new_work', status: 'pending', at: t0 + 420, taskId },
      }),
      makeEvent({
        seq: 10,
        kind: 'route_action',
        spanId: 'ra-1',
        parentSpanId: 'router-req-1:call-start-work',
        actor: 'router',
        label: 'new_work',
        status: 'accepted',
        at: t0 + 600,
        messageId: msgUserId,
        taskId,
        data: {
          id: 'ra-1',
          kind: 'new_work',
          status: 'accepted',
          at: t0 + 420,
          taskId,
          taskLabel: '修复配置并运行测试',
          workerProfile: 'coding',
          workerModel: 'openai-codex/gpt-5.3-codex',
          thinkingLevel: 'high',
          decisionSource: 'gemini-decision-1',
          summary: '已派发编码 Worker 排查配置与单测',
        },
      }),
      makeEvent({
        seq: 11,
        spanId: 'router-req-1:call-start-work',
        parentSpanId: 'router-turn-1',
        actor: 'router',
        label: 'start_work',
        status: 'completed',
        at: t0 + 620,
        messageId: msgUserId,
        data: { mode: 'real', summary: { output: JSON.stringify({ taskId, state: 'queued' }) } },
      }),
      makeEvent({
        seq: 12,
        spanId: 'router-turn-1',
        parentSpanId: 'router-req-1',
        actor: 'router',
        label: '模型推理调用',
        status: 'completed',
        at: t0 + 650,
        messageId: msgUserId,
        data: {
          mode: 'real',
          detail: {
            provider: 'openai',
            model: 'gpt-5-mini',
            stopReason: 'toolUse',
            thinkingPreview: '这是一个需要跑单测和改代码的任务，派发 coding worker。',
            usage: { input: 500, output: 120, cacheRead: 200, totalTokens: 820, cost: { total: 0.0021 } },
            toolCalls: [{ id: 'call-start-work', name: 'start_work', argsPreview: '{"instruction":"检查 config.json"}' }],
          },
          summary: { publicText: '' },
        },
      }),
      makeEvent({
        seq: 13,
        spanId: 'router-req-1',
        parentSpanId: msgUserId,
        actor: 'router',
        label: 'Agent 请求',
        status: 'completed',
        at: t0 + 700,
        messageId: msgUserId,
        data: { mode: 'real', output: '好的，我已安排子 AI 处理。' },
      }),

      // Jev model routing decision
      makeEvent({
        seq: 14,
        spanId: `${taskId}:decision:route`,
        parentSpanId: taskId,
        actor: 'system',
        label: 'Gemini Decision 1 选模定级',
        status: 'completed',
        at: t0 + 850,
        messageId: msgUserId,
        taskId,
        data: {
          request: { profile: 'coding', candidateCount: 4, fileCount: 1, hasImages: false, isTimer: false, instructionPreview: '检查 config.json 并运行单测' },
          model: 'openai-codex/gpt-5.3-codex',
          thinkingLevel: 'high',
          source: 'gemini-decision-1',
          confidence: 0.91,
          needsQualityGate: true,
          needsQualityGateProb: 0.84,
          usage: { inputTokens: 180, totalTokens: 210 },
        },
      }),
      // Redundant accepted/running task_state rows must be filtered out
      makeEvent({ seq: 15, kind: 'task_state', actor: 'system', taskId, spanId: taskId, status: 'accepted', at: t0 + 900, label: '任务', data: { mode: 'real' } }),
      makeEvent({ seq: 16, kind: 'task_state', actor: 'system', taskId, spanId: taskId, status: 'running', at: t0 + 920, label: '任务', data: { mode: 'real' } }),

      // Worker phase 1 Agent 请求
      makeEvent({
        seq: 17,
        spanId: 'worker-req-1',
        parentSpanId: taskId,
        actor: 'worker',
        label: 'Agent 请求',
        status: 'started',
        at: t0 + 1000,
        messageId: msgUserId,
        taskId,
        data: {
          mode: 'real',
          trigger: { kind: 'TASK', preview: '检查 config.json 并运行单测' },
          input: {
            prompt: '检查 config.json 并运行单测',
            execution: 'native',
            cwd: '/workspace/Friday',
            profile: 'coding',
            workerModel: 'openai-codex/gpt-5.3-codex',
            thinkingLevel: 'high',
          },
        },
      }),
      // Worker LLM #1: toolUse with NO publicText -> preview MUST list tools, never "本轮未记录公开说明"
      makeEvent({
        seq: 18,
        spanId: 'worker-turn-1',
        parentSpanId: 'worker-req-1',
        actor: 'worker',
        label: '模型推理调用',
        status: 'started',
        at: t0 + 1100,
        taskId,
        data: { mode: 'real', detail: { provider: 'openai-codex', model: 'gpt-5.3-codex' } },
      }),
      makeEvent({
        seq: 19,
        spanId: 'worker-turn-1',
        parentSpanId: 'worker-req-1',
        actor: 'worker',
        label: '模型推理调用',
        status: 'completed',
        at: t0 + 1500,
        taskId,
        data: {
          mode: 'real',
          detail: {
            provider: 'openai-codex',
            model: 'gpt-5.3-codex',
            thinkingLevel: 'high',
            stopReason: 'toolUse',
            usage: { input: 1200, output: 180, reasoning: 60, totalTokens: 1380, cost: { total: 0.011 } },
            toolCalls: [
              { id: 'call-bash-1', name: 'bash', argsPreview: '{"command":"npm test"}' },
              { id: 'call-read-1', name: 'read', argsPreview: '{"path":"config.json","offset":1,"limit":50}' },
            ],
          },
          summary: { publicText: '' },
        },
      }),
      // Worker bash tool
      makeEvent({
        seq: 20,
        spanId: 'worker-req-1:call-bash-1',
        parentSpanId: 'worker-turn-1',
        actor: 'worker',
        label: 'bash',
        status: 'started',
        at: t0 + 1550,
        taskId,
        data: {
          mode: 'real',
          detail: { input: { input: JSON.stringify({ command: 'npm test -- --grep trace', cwd: '/workspace/Friday', timeout: 30 }) } },
          summary: { input: { command: 'npm test -- --grep trace' } },
        },
      }),
      makeEvent({
        seq: 21,
        spanId: 'worker-req-1:call-bash-1',
        parentSpanId: 'worker-turn-1',
        actor: 'worker',
        label: 'bash',
        status: 'completed',
        at: t0 + 2100,
        taskId,
        data: {
          mode: 'real',
          detail: { output: { content: [{ type: 'text', text: '12 passing' }], details: { exitCode: 0 } } },
          summary: { output: '12 passing', exitCode: 0 },
        },
      }),
      // Worker read tool + start_read operation attachment
      makeEvent({
        seq: 22,
        spanId: 'worker-req-1:call-read-1',
        parentSpanId: 'worker-turn-1',
        actor: 'worker',
        label: 'read',
        status: 'started',
        at: t0 + 2150,
        taskId,
        data: {
          mode: 'real',
          detail: { input: { path: '/workspace/Friday/config.json', offset: 10, limit: 40 } },
        },
      }),
      makeEvent({
        seq: 23,
        spanId: 'worker-req-1:call-read-1',
        parentSpanId: 'worker-turn-1',
        actor: 'worker',
        label: 'read',
        status: 'completed',
        at: t0 + 2300,
        taskId,
        data: {
          mode: 'real',
          detail: { output: { content: [{ type: 'text', text: '{\n  "timeout": 1000\n}' }] } },
        },
      }),
      // Worker start_read snapshot tool + operation row
      makeEvent({
        seq: 24,
        spanId: 'worker-req-1:call-snap-1',
        parentSpanId: 'worker-turn-1',
        actor: 'worker',
        label: 'start_read',
        status: 'started',
        at: t0 + 2320,
        taskId,
        data: { mode: 'real', detail: { input: { input: 'f0' } }, summary: { input: { input: 'f0' } } },
      }),
      makeEvent({
        seq: 25,
        spanId: 'worker-req-1:call-snap-1',
        parentSpanId: 'worker-turn-1',
        actor: 'worker',
        label: 'start_read',
        status: 'completed',
        at: t0 + 2400,
        taskId,
        data: { mode: 'real', summary: { output: '{"operationId":"op-read-snap-1","state":"requested"}' } },
      }),
      makeEvent({
        seq: 26,
        kind: 'operation',
        spanId: 'op-read-snap-1',
        parentSpanId: 'worker-req-1:call-snap-1',
        actor: 'executor',
        label: '读取文件副本',
        status: 'succeeded',
        at: t0 + 2450,
        taskId,
        data: { fileId: 'f0', fileName: 'error.log', resultRef: 'op-read-snap-1', preview: 'ERR_TIMEOUT' },
      }),

      // Worker LLM #2: calls edit tool, has preceding tool context!
      makeEvent({
        seq: 27,
        spanId: 'worker-turn-2',
        parentSpanId: 'worker-req-1',
        actor: 'worker',
        label: '模型推理调用',
        status: 'completed',
        at: t0 + 2600,
        taskId,
        data: {
          mode: 'real',
          detail: {
            provider: 'openai-codex',
            model: 'gpt-5.3-codex',
            stopReason: 'toolUse',
            usage: { input: 1600, output: 110, totalTokens: 1710 },
          },
          summary: { publicText: '定位到 timeout 过短，开始修改 config.json。' },
        },
      }),
      makeEvent({
        seq: 28,
        spanId: 'worker-req-1:call-edit-1',
        parentSpanId: 'worker-turn-2',
        actor: 'worker',
        label: 'edit',
        status: 'completed',
        at: t0 + 3000,
        taskId,
        data: {
          mode: 'real',
          detail: {
            input: {
              path: '/workspace/Friday/config.json',
              oldText: '"timeout": 1000',
              newText: '"timeout": 30000',
            },
            output: { content: [{ type: 'text', text: 'Successfully replaced text in config.json' }] },
          },
        },
      }),
      makeEvent({
        seq: 29,
        spanId: 'worker-req-1',
        parentSpanId: taskId,
        actor: 'worker',
        label: 'Agent 请求',
        status: 'completed',
        at: t0 + 4200,
        taskId,
        data: { mode: 'real', output: '已定位并修复 timeout，测试通过。' },
      }),

      // Quality Gate
      makeEvent({
        seq: 30,
        spanId: `${taskId}:decision:quality`,
        parentSpanId: taskId,
        actor: 'system',
        label: 'Gemini Decision 1 完成度评估',
        status: 'completed',
        at: t0 + 4900,
        taskId,
        data: {
          score: 3,
          maxScore: 3,
          confidence: 0.96,
          shouldSupplement: false,
          missingAspect: 'none',
          source: 'gemini-decision-1',
          request: { succeededOps: 2, failedOps: 0, followupCount: 0, reportLength: 28 },
        },
      }),

      // Router WORKER_REPORT turn
      makeEvent({
        seq: 31,
        spanId: 'router-req-2',
        parentSpanId: taskId,
        actor: 'router',
        label: 'Agent 请求',
        status: 'started',
        at: t0 + 5050,
        messageId: msgReplyId,
        taskId,
        data: { mode: 'real', trigger: { kind: 'WORKER_REPORT', taskId, preview: '已定位到 config.json 缺少 timeout 字段' } },
      }),
      makeEvent({
        seq: 32,
        spanId: 'router-turn-2',
        parentSpanId: 'router-req-2',
        actor: 'router',
        label: '模型推理调用',
        status: 'completed',
        at: t0 + 5400,
        messageId: msgReplyId,
        taskId,
        data: {
          mode: 'real',
          detail: {
            provider: 'openai',
            model: 'gpt-5-mini',
            stopReason: 'stop',
            usage: { input: 400, output: 80, totalTokens: 480 },
          },
          summary: {},
        },
      }),
      makeEvent({
        seq: 33,
        spanId: 'router-req-2',
        parentSpanId: taskId,
        actor: 'router',
        label: 'Agent 请求',
        status: 'completed',
        at: t0 + 5500,
        messageId: msgReplyId,
        taskId,
        data: { mode: 'real', output: '已完成排查并修复 config.json，单测 12 项全部通过。' },
      }),
    ],
  };

  const view = buildExecutionChain(bundle);
  assert.ok(view.nodes.length >= 12);

  // Verify noise events & duplicate start_work / message_created are absent
  const titles = view.nodes.map(n => n.title);
  assert.equal(view.nodes.filter(n => n.title === '收到消息').length, 1, 'message_created must merge with bundle.messages');
  assert.equal(view.nodes.filter(n => n.title === '新建工作').length, 1, 'route_action must deduplicate with start_work');
  assert.ok(!view.nodes.some(n => n.status === 'accepted' && n.title.startsWith('任务状态')), 'pure accepted task_state filtered');
  assert.ok(!view.nodes.some(n => n.status === 'running' && n.title.startsWith('任务状态')), 'pure running task_state filtered');

  // Verify message channels, voiceprint speaker, session note, and reply ordering at the end
  const userMsgNode = view.nodes.find(n => n.id === `msg:${msgUserId}`)!;
  assert.equal(userMsgNode.category, 'message');
  assert.equal(userMsgNode.messageDetail?.channelLabel, '💬 微信');
  assert.equal(userMsgNode.messageDetail?.speakerLabel, '老板 (主人)');
  assert.match(userMsgNode.messageDetail?.sessionNote ?? '', /延续当前项目调试/);
  assert.equal(userMsgNode.messageDetail?.attachments[0]?.name, 'error.log');
  assert.deepEqual(userMsgNode.messageDetail?.paths, ['/workspace/Friday/config.json']);

  const replyNode = view.nodes.at(-1)!;
  assert.equal(replyNode.id, `msg:${msgReplyId}`, 'assistant delivery must sit at the end after WORKER_REPORT');
  assert.equal(replyNode.title, '公开回复交付');
  assert.equal(replyNode.at, t0 + 5500);

  // Verify Router LLM #1 toolDecisions resolves absorbed start_work -> ra-1 and has no "本轮未记录公开说明"
  const routerLlm1 = view.nodes.find(n => n.id === 'router-turn-1')!;
  assert.equal(routerLlm1.category, 'llm');
  assert.equal(routerLlm1.llmDetail?.stopReasonLabel, '决定调用工具');
  assert.equal(routerLlm1.llmDetail?.toolDecisions.length, 1);
  assert.equal(routerLlm1.llmDetail?.toolDecisions[0]?.spanId, 'ra-1', 'decision spanId points to merged routing node');
  assert.match(routerLlm1.preview, /决定调用 1 个工具/);
  assert.doesNotMatch(routerLlm1.preview, /本轮未记录公开说明/);

  // Verify Worker LLM #1 toolUse without publicText
  const workerLlm1 = view.nodes.find(n => n.id === 'worker-turn-1')!;
  assert.equal(workerLlm1.title, 'Worker 模型调用 #1');
  assert.match(workerLlm1.preview, /决定调用 3 个工具：执行命令 \(bash\) · 读取文件 \(read\) · 读取文件副本 \(start_read\)/);
  assert.equal(workerLlm1.llmDetail?.usage?.totalTokens, 1380);
  assert.equal(workerLlm1.llmDetail?.usage?.costUsd, 0.011);

  // Verify Worker LLM #2 inputContext summarizes preceding tools, and Router LLM #2 uses streamedTextBySpan
  const workerLlm2 = view.nodes.find(n => n.id === 'worker-turn-2')!;
  assert.match(workerLlm2.llmDetail?.inputContext ?? '', /前置 3 个工具返回/);
  assert.match(workerLlm2.llmDetail?.inputContext ?? '', /执行命令 \(bash\)/);

  const routerLlm2 = view.nodes.find(n => n.id === 'router-turn-2')!;
  assert.equal(routerLlm2.llmDetail?.publicText, '已为您在仓库执行校验并更新配置，12 项测试全部通过。');

  // Verify bash tool params & clean output unwrapping (zero raw JSON)
  const bashNode = view.nodes.find(n => n.id === 'worker-req-1:call-bash-1')!;
  assert.equal(bashNode.category, 'tool');
  assert.equal(bashNode.title, '执行命令');
  assert.deepEqual(bashNode.toolDetail?.params, [
    { label: '命令', value: 'npm test -- --grep trace', kind: 'code' },
    { label: '工作目录', value: '/workspace/Friday', kind: 'path' },
    { label: '超时', value: '30s', kind: 'badge' },
  ]);
  assert.equal(bashNode.toolDetail?.resultText, '12 passing');
  assert.equal(bashNode.toolDetail?.exitCode, 0);
  assert.equal(bashNode.toolDetail?.operationId, `${taskId}:call-bash-1`);
  assert.equal(bashNode.toolDetail?.hasFullOutput, false);

  // Verify read tool params
  const readNode = view.nodes.find(n => n.id === 'worker-req-1:call-read-1')!;
  assert.deepEqual(readNode.toolDetail?.params, [
    { label: '文件路径', value: '/workspace/Friday/config.json', kind: 'path' },
    { label: '行偏移/限制', value: '起始行 10 · 限制 40 行', kind: 'text' },
  ]);
  assert.match(readNode.toolDetail?.resultText ?? '', /timeout: 1000/);

  // Verify start_read snapshot tool attaches operation & fileName
  const snapNode = view.nodes.find(n => n.id === 'worker-req-1:call-snap-1')!;
  assert.equal(snapNode.toolDetail?.params[0]?.value, 'error.log');
  assert.equal(snapNode.toolDetail?.operationId, 'op-read-snap-1');
  assert.equal(snapNode.toolDetail?.hasFullOutput, true);
  assert.equal(snapNode.toolDetail?.resultText, 'snapshot file preview');

  // Verify edit tool diff params
  const editNode = view.nodes.find(n => n.id === 'worker-req-1:call-edit-1')!;
  assert.deepEqual(editNode.toolDetail?.params, [
    { label: '文件路径', value: '/workspace/Friday/config.json', kind: 'path' },
    { label: '修改前', value: '"timeout": 1000', kind: 'diff_old' },
    { label: '修改后', value: '"timeout": 30000', kind: 'diff_new' },
  ]);
  assert.equal(editNode.toolDetail?.resultText, 'Successfully replaced text in config.json');

  // Verify Jev Decision route & quality gate
  const routeDecision = view.nodes.find(n => n.id === `${taskId}:decision:route`)!;
  assert.equal(routeDecision.category, 'routing');
  assert.match(routeDecision.preview, /openai-codex\/gpt-5\.3-codex@high/);
  const qualityNode = view.nodes.find(n => n.id === `${taskId}:decision:quality`)!;
  assert.equal(qualityNode.category, 'routing');
  assert.match(qualityNode.preview, /得分 3\.00 \/ 3/);
  assert.equal(qualityNode.tone, 'ok');

  // Verify stats & waterfall bounds
  assert.equal(view.stats.message, 2);
  assert.equal(view.stats.llm, 4);
  assert.equal(view.stats.tool, 4);
  assert.equal(view.stats.failed, 0);
  assert.equal(view.stats.totalTokens, 820 + 1380 + 1710 + 480);
  assert.equal(view.stats.totalDurationMs, 5400);
  assert.ok(titles.includes('Worker 接收任务'));
  for (const node of view.nodes) {
    assert.ok(node.waterfallStartPermille >= 0 && node.waterfallStartPermille <= 1000);
    assert.ok(node.waterfallWidthPermille >= 18 && node.waterfallWidthPermille <= 1000);
    assert.ok(node.waterfallStartPermille + node.waterfallWidthPermille <= 1000);
  }
});

test('recognizes all IM/timer/local channels and handles write, grep, find, ls, run_plugin, and edit variants cleanly', () => {
  const t0 = 1_700_000_010_000;
  const bundle: ExecutionTraceBundle = {
    scope: { type: 'all' },
    cursor: 20,
    streamedTextBySpan: {},
    linkedTasks: [],
    messages: [
      makeMessage({ id: 'm-wx', seq: 1, role: 'user', text: 'wx', at: t0 + 1, origin: { channel: 'wechat' } }),
      makeMessage({ id: 'm-tg', seq: 2, role: 'user', text: 'tg', at: t0 + 2, origin: { channel: 'telegram' } }),
      makeMessage({ id: 'm-xa', seq: 3, role: 'user', text: 'xa', at: t0 + 3, origin: { channel: 'xiaoai', speakerName: '客厅', speakerRole: 'member' } }),
      makeMessage({ id: 'm-dt', seq: 4, role: 'user', text: 'dt', at: t0 + 4, origin: { channel: 'dingtalk' } }),
      makeMessage({ id: 'm-tm', seq: 5, role: 'user', text: '[定时触发 · 晨间简报] 汇总今日待办', source: 'system', at: t0 + 5 }),
      makeMessage({ id: 'm-lc', seq: 6, role: 'user', text: 'local', at: t0 + 6, origin: { channel: 'local' } }),
    ],
    events: [
      makeEvent({
        seq: 10,
        spanId: 't-write',
        actor: 'worker',
        label: 'write',
        status: 'completed',
        at: t0 + 100,
        data: { detail: { input: { file_path: '/tmp/out.txt', content: 'hello world' } } },
      }),
      makeEvent({
        seq: 11,
        spanId: 't-grep',
        actor: 'worker',
        label: 'grep',
        status: 'completed',
        at: t0 + 200,
        data: { detail: { input: { pattern: 'buildExecutionChain', path: 'src/web', ignoreCase: true, limit: 20 } } },
      }),
      makeEvent({
        seq: 12,
        spanId: 't-find',
        actor: 'worker',
        label: 'find',
        status: 'completed',
        at: t0 + 240,
        data: { detail: { input: { pattern: '*.ts', path: 'src/web' }, output: { content: [{ type: 'text', text: 'src/web/trace-chain.ts' }] } } },
      }),
      makeEvent({
        seq: 13,
        spanId: 't-ls',
        actor: 'worker',
        label: 'ls',
        status: 'completed',
        at: t0 + 260,
        data: { detail: { input: { path: 'src/web/panels', limit: 50 } } },
      }),
      makeEvent({
        seq: 14,
        spanId: 't-edit-alt',
        actor: 'worker',
        label: 'edit',
        status: 'completed',
        at: t0 + 300,
        data: {
          detail: {
            input: {
              path: 'src/app.ts',
              edits: [
                { old_str: 'const x = 1;', new_str: 'const x = 2;' },
                { target: 'foo()', replacement: 'bar()' },
              ],
            },
          },
        },
      }),
      makeEvent({
        seq: 15,
        spanId: 't-plugin',
        actor: 'router',
        label: 'run_plugin',
        status: 'completed',
        at: t0 + 400,
        data: {
          detail: {
            input: {
              input: JSON.stringify({
                action: 'run',
                plugin: 'health-scale',
                pluginAction: 'latest',
                args: { member: '主人', days: 7 },
              }),
            },
            output: { content: [{ type: 'text', text: '{"weightKg":68.5,"trend":"stable"}' }] },
          },
        },
      }),
      // Router run_plugin absorbed into route_action(kind='plugin')
      makeEvent({
        seq: 16,
        spanId: 'r-call-plugin-merged',
        parentSpanId: 'r-turn-plugin',
        actor: 'router',
        label: 'run_plugin',
        status: 'completed',
        at: t0 + 450,
        data: {
          detail: {
            input: { input: JSON.stringify({ plugin: 'fund-tracker', pluginAction: 'summary', args: { currency: 'CNY' } }) },
            output: { content: [{ type: 'text', text: '{"total":12345}' }] },
          },
        },
      }),
      makeEvent({
        seq: 17,
        kind: 'route_action',
        spanId: 'ra-plugin',
        parentSpanId: 'r-call-plugin-merged',
        actor: 'router',
        label: 'plugin',
        status: 'accepted',
        at: t0 + 470,
        data: { id: 'ra-plugin', kind: 'plugin', status: 'accepted', at: t0 + 470, summary: '查询基金汇总' },
      }),
    ],
  };

  const view = buildExecutionChain(bundle);
  const channels = view.nodes.filter(n => n.category === 'message').map(n => n.messageDetail?.channelLabel);
  assert.deepEqual(channels, ['💬 微信', '✈️ Telegram', '🔊 小爱音箱', '🟦 钉钉', '⏱️ 定时任务', '🖥️ Web 控制台']);

  const xiaoaiNode = view.nodes.find(n => n.id === 'msg:m-xa')!;
  assert.equal(xiaoaiNode.messageDetail?.speakerLabel, '客厅 (成员)');

  const writeNode = view.nodes.find(n => n.id === 't-write')!;
  assert.deepEqual(writeNode.toolDetail?.params, [
    { label: '文件路径', value: '/tmp/out.txt', kind: 'path' },
    { label: '写入内容', value: 'hello world', kind: 'code' },
  ]);

  const grepNode = view.nodes.find(n => n.id === 't-grep')!;
  assert.deepEqual(grepNode.toolDetail?.params, [
    { label: '匹配模式', value: 'buildExecutionChain', kind: 'code' },
    { label: '目标目录', value: 'src/web', kind: 'path' },
    { label: '其他过滤', value: 'ignoreCase: true · limit: 20', kind: 'text' },
  ]);

  const editAltNode = view.nodes.find(n => n.id === 't-edit-alt')!;
  assert.deepEqual(editAltNode.toolDetail?.params, [
    { label: '文件路径', value: 'src/app.ts', kind: 'path' },
    { label: '修改前 #1', value: 'const x = 1;', kind: 'diff_old' },
    { label: '修改后 #1', value: 'const x = 2;', kind: 'diff_new' },
    { label: '修改前 #2', value: 'foo()', kind: 'diff_old' },
    { label: '修改后 #2', value: 'bar()', kind: 'diff_new' },
  ]);

  const pluginNode = view.nodes.find(n => n.id === 't-plugin')!;
  assert.equal(pluginNode.category, 'tool');
  assert.equal(pluginNode.title, '调用插件');
  assert.deepEqual(pluginNode.toolDetail?.params, [
    { label: '插件', value: 'health-scale', kind: 'badge' },
    { label: '动作', value: 'latest', kind: 'badge' },
    { label: 'member', value: '主人', kind: 'text' },
    { label: 'days', value: '7', kind: 'badge' },
  ]);
  assert.equal(pluginNode.toolDetail?.resultText, 'weightKg: 68.5\ntrend: stable');

  const findNode = view.nodes.find(n => n.id === 't-find')!;
  assert.deepEqual(findNode.toolDetail?.params, [
    { label: '匹配模式', value: '*.ts', kind: 'code' },
    { label: '目标目录', value: 'src/web', kind: 'path' },
  ]);

  const lsNode = view.nodes.find(n => n.id === 't-ls')!;
  assert.deepEqual(lsNode.toolDetail?.params, [
    { label: '目标目录', value: 'src/web/panels', kind: 'path' },
    { label: '其他过滤', value: 'limit: 50', kind: 'text' },
  ]);

  // Merged run_plugin + route_action produces single routing node without duplicate tool node
  assert.equal(view.nodes.find(n => n.id === 'r-call-plugin-merged'), undefined);
  const mergedPluginRoute = view.nodes.find(n => n.id === 'ra-plugin')!;
  assert.equal(mergedPluginRoute.category, 'routing');
  assert.equal(mergedPluginRoute.title, '调用插件');
  assert.ok(mergedPluginRoute.routingDetail?.summaryItems.some(i => i.label === '插件' && i.value === 'fund-tracker'));
  assert.ok(mergedPluginRoute.routingDetail?.summaryItems.some(i => i.label === '参数 · currency' && i.value === 'CNY'));
  assert.equal(mergedPluginRoute.routingDetail?.reportText, 'total: 12345');
});

test('handles multi-phase Worker, ASK_BOSS question recovery, followup_state, failed bash, and zero-span fallback', () => {
  const t0 = 1_700_000_020_000;
  const taskId = 'task-multi';
  const bundle: ExecutionTraceBundle = {
    scope: { type: 'task', id: taskId },
    cursor: 20,
    streamedTextBySpan: {},
    messages: [],
    linkedTasks: [],
    task: {
      id: taskId,
      prompt: '更新生产配置并验证',
      status: 'failed',
      createdAt: t0,
      activeMs: 2500,
      limitMs: 600_000,
      workerModel: 'claude-sonnet-4',
      thinkingLevel: 'medium',
      decisionSource: 'heuristic',
      followups: [{ id: 'fu-1', text: '允许覆盖 prod.yaml，请继续执行', state: 'done' }],
      memories: [],
      operations: [],
    },
    events: [
      makeEvent({ seq: 1, spanId: 'w-req-1', actor: 'worker', label: 'Agent 请求', status: 'started', at: t0 + 100, taskId, data: { trigger: { kind: 'TASK', preview: '更新生产配置并验证' } } }),
      makeEvent({ seq: 2, spanId: 'w-req-1', actor: 'worker', label: 'Agent 请求', status: 'completed', at: t0 + 600, taskId }),
      makeEvent({ seq: 3, kind: 'task_state', actor: 'system', taskId, status: 'waiting_decision', at: t0 + 700, label: '更新生产配置并验证', data: { reason: '等待老板拍板：是否覆盖 prod.yaml？' } }),
      makeEvent({
        seq: 4,
        spanId: 'r-q-1',
        actor: 'router',
        label: 'Agent 请求',
        status: 'started',
        at: t0 + 720,
        taskId,
        data: { trigger: { kind: 'WORKER_QUESTION', taskId }, input: { question: '是否允许直接覆盖 prod.yaml？', options: ['允许覆盖', '先备份再写'] } },
      }),
      makeEvent({ seq: 5, kind: 'followup_state', spanId: 'ra-fu:delivery', actor: 'worker', label: '处理补充要求', status: 'done', at: t0 + 1200, taskId, data: { followupId: 'fu-1', state: 'done', taskLabel: '更新生产配置并验证' } }),
      makeEvent({ seq: 6, kind: 'task_state', actor: 'system', taskId, status: 'decision_received', at: t0 + 1250, label: '更新生产配置并验证', data: { reason: '已收到老板拍板，继续推进' } }),
      makeEvent({ seq: 7, spanId: 'w-req-2', actor: 'worker', label: 'Agent 请求', status: 'started', at: t0 + 1300, taskId, data: { trigger: { kind: 'BOSS_DECISION' } } }),
      makeEvent({
        seq: 8,
        spanId: 'w-req-2:call-fail',
        parentSpanId: 'w-req-2',
        actor: 'worker',
        label: 'bash',
        status: 'failed',
        at: t0 + 1500,
        taskId,
        data: {
          detail: { input: { command: 'exit 2' }, output: { content: [{ type: 'text', text: 'permission denied' }], details: { exitCode: 2 }, isError: true } },
          summary: { input: { command: 'exit 2' }, output: 'permission denied', exitCode: 2 },
        },
      }),
    ],
  };

  const view = buildExecutionChain(bundle);
  assert.ok(view.nodes.some(n => n.title === 'Gemini Decision 1 选模定级'), 'synthesizes decision node when span absent');
  assert.ok(view.nodes.some(n => n.title === 'Worker 接收任务'));
  assert.ok(view.nodes.some(n => n.title === 'Worker 第 2 阶段推进'));

  const askNode = view.nodes.find(n => n.title === 'ASK_BOSS 盘中请示')!;
  assert.equal(askNode.tone, 'warn');
  assert.equal(askNode.routingDetail?.promptText, '是否允许直接覆盖 prod.yaml？');
  assert.deepEqual(askNode.routingDetail?.options, ['允许覆盖', '先备份再写']);

  const fuNode = view.nodes.find(n => n.title === '补充指令交付')!;
  assert.equal(fuNode.routingDetail?.promptText, '允许覆盖 prod.yaml，请继续执行');

  const failBash = view.nodes.find(n => n.id === 'w-req-2:call-fail')!;
  assert.equal(failBash.tone, 'err');
  assert.equal(failBash.toolDetail?.exitCode, 2);
  assert.equal(view.stats.failed, 1);
});

test('handles zero-duration waterfall boundary and buildFallbackBundleFromAppState / extractReadableOperationOutput', () => {
  const t0 = 1_700_000_050_000;
  const events: TraceEvent[] = [
    makeEvent({ seq: 1, spanId: 'llm-1', actor: 'router', label: '模型推理调用', status: 'started', at: t0 }),
    makeEvent({ seq: 2, spanId: 'llm-1', kind: 'visible_text', actor: 'router', label: '增量', status: 'streaming', at: t0, data: { text: '你好，' } }),
    makeEvent({ seq: 3, spanId: 'llm-1', kind: 'visible_text', actor: 'router', label: '增量', status: 'streaming', at: t0, data: { text: '世界' } }),
    makeEvent({ seq: 4, spanId: 'llm-1', actor: 'router', label: '模型推理调用', status: 'completed', at: t0, data: { detail: { stopReason: 'stop' }, summary: {} } }),
  ];

  // 1) Bare TraceEvent[] passed to buildFallbackBundleFromAppState
  const bareBundle = buildFallbackBundleFromAppState(events);
  assert.equal(bareBundle.scope.type, 'all');
  assert.equal(bareBundle.streamedTextBySpan['llm-1'], '你好，世界');
  assert.equal(bareBundle.events.length, 2);

  const zeroChain = buildExecutionChain(bareBundle);
  assert.equal(zeroChain.stats.totalDurationMs, 0);
  assert.equal(zeroChain.nodes.length, 1);
  assert.equal(zeroChain.nodes[0]!.waterfallStartPermille, 0);
  assert.equal(zeroChain.nodes[0]!.waterfallWidthPermille, 18);
  assert.equal(zeroChain.nodes[0]!.llmDetail?.publicText, '你好，世界');

  // 2) Full appState-like object passed to buildFallbackBundleFromAppState
  const work: WorkView = {
    id: 'w-fb',
    prompt: '测试降级构造',
    status: 'completed',
    mode: 'real',
    createdAt: t0,
    activeMs: 500,
    limitMs: 60_000,
    originMessageId: 'm-fb',
    workerModel: 'gpt-5',
  };
  const msgMap = new Map<string, ChatMessage>([
    ['m-fb', makeMessage({ id: 'm-fb', seq: 1, role: 'user', text: '跑一下', at: t0, taskIds: ['w-fb'] })],
  ]);
  const appBundle = buildFallbackBundleFromAppState({
    selection: { type: 'task', id: 'w-fb', label: '测试降级构造' },
    traceEvents: events,
    messages: msgMap,
    workData: { ...work, report: 'OK', followups: [], operations: [{ id: 'op1', fileId: 'f0', status: 'succeeded' }] },
    view: { works: [work] },
    traceAfter: 4,
  });
  assert.equal(appBundle.scope.type, 'task');
  assert.equal(appBundle.scope.id, 'w-fb');
  assert.equal(appBundle.task?.report, 'OK');
  assert.equal(appBundle.task?.operations[0]?.hasFullResult, true);
  assert.equal(appBundle.messages.length, 1);

  // 3) extractReadableOperationOutput unwraps nested wrappers and never outputs raw JSON strings
  const op1 = extractReadableOperationOutput({
    id: 'op1',
    status: 'succeeded',
    result: JSON.stringify({ content: [{ type: 'text', text: 'line A\nline B' }] }),
  });
  assert.deepEqual(op1, { text: 'line A\nline B', status: 'succeeded' });

  const op2 = extractReadableOperationOutput({
    output: { content: [{ type: 'text', text: '{"ok":true,"items":["x","y"]}' }] },
    error: 'partial warning',
    status: 'failed',
  });
  assert.equal(op2.status, 'failed');
  assert.equal(op2.error, 'partial warning');
  assert.equal(op2.text, 'ok: true\nitems: x, y');
  assert.ok(!op2.text.startsWith('{'));

  const op3 = extractReadableOperationOutput('plain text output');
  assert.deepEqual(op3, { text: 'plain text output' });
});

test('src/web/trace-chain.ts obeys frontend security and module boundary redlines', async () => {
  const path = fileURLToPath(new URL('../src/web/trace-chain.ts', import.meta.url));
  const content = await readFile(path, 'utf8');
  assert.doesNotMatch(content, /\.style\./);
  assert.doesNotMatch(content, /\.innerHTML/);
  assert.doesNotMatch(content, /crypto\.randomUUID/);
  // Ensure no runtime relative imports escape src/web/
  const runtimeImports = [...content.matchAll(/^(?!import\s+type\b)\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]!);
  for (const spec of runtimeImports) {
    assert.ok(!spec.startsWith('../'), `runtime import ${spec} must not escape src/web/`);
  }
});
