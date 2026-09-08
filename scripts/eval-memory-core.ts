import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { io } from 'socket.io-client';

type Condition = 'baseline' | 'memory';
type EvalMessage = { id: string; senderNickname: string; isAI: boolean; content: string; memoryCondition: Condition; timestamp: number };
type EvalState = { sessionId: string; baselineMessages: EvalMessage[]; memoryMessages: EvalMessage[]; memoryState: { events: Array<{ summary: string }>; items: Array<{ name: string; status: string }>; lastUpdatedTurn: number; updating: boolean }; evaluating: boolean };

type CoreCase = {
  id: string;
  title: string;
  setup: string[];
  probe: string;
  expected: RegExp[];
  forbidden: RegExp[];
};

type KeywordScore = {
  expectedHits: number;
  expectedTotal: number;
  forbiddenHits: string[];
};

type CoreResult = CoreCase & {
  baselineReplies: EvalMessage[];
  memoryReplies: EvalMessage[];
  baselineScore: KeywordScore;
  memoryScore: KeywordScore;
  memorySnapshot: EvalState['memoryState'] | undefined;
};

const cases: CoreCase[] = [
  {
    id: 'MEM-01', title: '延迟事实回忆',
    setup: ['黑色戒指刻着北堤仓库的编号，我先放在口袋里。'],
    probe: '戒指上刻的是什么？现在在哪？',
    expected: [/北堤仓库/, /口袋/], forbidden: [/石台|吧台|不知道/],
  },
  {
    id: 'MEM-02', title: '冲突消解',
    setup: ['阿豪刚确认钥匙在吧台抽屉。', '小明刚把钥匙从抽屉拿出，交给诺亚保管了。'],
    probe: '钥匙现在谁拿着？',
    expected: [/诺亚/], forbidden: [/吧台抽屉|阿豪拿着/],
  },
  {
    id: 'MEM-03', title: '角色来源归属',
    setup: ['阿辰说相机电池只剩一格。', '诺亚说北堤到捷运站要走十五分钟。'],
    probe: '阿辰和诺亚各自确认过什么？',
    expected: [/阿辰/, /相机|电池/, /诺亚/, /十五分钟/], forbidden: [/阿辰.*路线|诺亚.*相机/],
  },
];

const serverUrl = process.env.EVAL_SERVER_URL || 'http://localhost:3001';
const fillers = ['雨声落在窗沿上。', '咖啡机轻响了一声。', '街灯映在湿漉漉的路面。', '店门口的风铃晃了晃。', '远处车流慢慢过去。', '桌上的热气散开了一点。', '窗边的雨痕又滑下一道。'];

function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function escapeMarkdown(value: string) { return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); }

async function main() {
  const socket = io(serverUrl, { transports: ['websocket'] });
  let state: EvalState | null = null;
  socket.on('memory-eval-state', (next: EvalState) => { state = next; });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('连接评测服务超时')), 10000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', reject);
  });

  const waitFor = <T>(event: string, predicate: (value: T) => boolean, timeoutMs = 45000) => new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(event, handler); reject(new Error(`${event} 超时`)); }, timeoutMs);
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });

  socket.emit('get-memory-eval-state');
  await waitFor<EvalState>('memory-eval-state', (next) => Boolean(next.sessionId));

  const results: CoreResult[] = [];
  for (const testCase of cases) {
    const resetWait = waitFor<{ sessionId: string }>('memory-eval-reset', () => true, 10000);
    socket.emit('memory-eval-reset');
    const resetEvent = await resetWait;
    await wait(250);
    socket.emit('memory-eval-config-save', {
      builderId: 'prompt-b', updateEveryTurns: 30, baselineHistoryMessages: 6, retrievalLimit: 5,
      temperature: 0.3, presencePenalty: 0, fixedCharacterIds: ['lia', 'a-chen', 'nuo-ya'],
    });
    socket.emit('memory-eval-toggle-auto-update', false);
    await wait(250);

    const sessionId = resetEvent.sessionId;
    const send = async (content: string) => {
      const completed = waitFor<{ sessionId: string }>('memory-eval-turn-completed', (event) => event.sessionId === sessionId);
      socket.emit('memory-eval-send', { content, nickname: '记忆评测员' });
      await completed;
      await wait(300);
    };

    for (const message of testCase.setup) await send(message);
    const updated = waitFor<{ memoryState: EvalState['memoryState'] }>('memory-eval-memory-updated', () => true);
    socket.emit('memory-eval-update-now');
    await updated;
    for (const filler of fillers) await send(filler);
    await send(testCase.probe);

    const latestPlayerIndex = (messages: EvalMessage[]) => messages.map((message, index) => !message.isAI ? index : -1).filter((index) => index >= 0).at(-1) ?? -1;
    const repliesAfterLastPlayer = (messages: EvalMessage[]) => messages.slice(latestPlayerIndex(messages) + 1).filter((message) => message.isAI);
    const baselineReplies = repliesAfterLastPlayer(state?.baselineMessages ?? []);
    const memoryReplies = repliesAfterLastPlayer(state?.memoryMessages ?? []);
    const baselineText = baselineReplies.map((reply) => reply.content).join('\n');
    const memoryText = memoryReplies.map((reply) => reply.content).join('\n');
    const evaluate = (text: string) => ({
      expectedHits: testCase.expected.filter((pattern) => pattern.test(text)).length,
      expectedTotal: testCase.expected.length,
      forbiddenHits: testCase.forbidden.filter((pattern) => pattern.test(text)).map(String),
    });
    const baselineScore = evaluate(baselineText);
    const memoryScore = evaluate(memoryText);
    results.push({
      ...testCase, baselineReplies, memoryReplies, baselineScore, memoryScore,
      memorySnapshot: state?.memoryState,
    });
    console.log(`${testCase.id} ${testCase.title}: 基线 ${baselineScore.expectedHits}/${baselineScore.expectedTotal}，记忆 ${memoryScore.expectedHits}/${memoryScore.expectedTotal}`);
  }

  const outputDir = path.join(process.cwd(), 'data/eval-results');
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `memory-core-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), serverUrl, config: { builderId: 'prompt-b', baselineHistoryMessages: 6, autoUpdate: false }, results }, null, 2), 'utf8');

  const lines = ['# 记忆系统核心有效性实测', '', '- 真实调用当前 `/memory` Socket 流程，不使用预写 AI 回复。', '- 两侧使用相同 Builder B、相同随机角色名单、相同 6 条短历史和相同玩家输入。', '- 每例在事实入库后关闭自动更新并发送 7 条无关填充，使事实退出基线短窗口；记忆侧保留一次结构化更新。', '- 下列关键词统计是可复现的初筛，原文仍需按记忆能力标准人工复核。', '', '| 用例 | 基线命中 | 记忆命中 | 基线禁忌 | 记忆禁忌 |', '|---|---:|---:|---:|---:|'];
  for (const result of results) lines.push(`| ${result.id} ${result.title} | ${result.baselineScore.expectedHits}/${result.baselineScore.expectedTotal} | ${result.memoryScore.expectedHits}/${result.memoryScore.expectedTotal} | ${result.baselineScore.forbiddenHits.length} | ${result.memoryScore.forbiddenHits.length} |`);
  for (const result of results) {
    lines.push('', `## ${result.id} ${result.title}`, '', `追问：${result.probe}`, '', '### 无记忆基线', '', result.baselineReplies.length ? result.baselineReplies.map((reply: EvalMessage) => `- **${reply.senderNickname}**：${escapeMarkdown(reply.content)}`).join('\n') : '- 无回复', '', '### 记忆系统', '', result.memoryReplies.length ? result.memoryReplies.map((reply: EvalMessage) => `- **${reply.senderNickname}**：${escapeMarkdown(reply.content)}`).join('\n') : '- 无回复', '', `记忆快照：第 ${result.memorySnapshot?.lastUpdatedTurn ?? 0} 轮更新；事件数 ${result.memorySnapshot?.events?.length ?? 0}；物品数 ${result.memorySnapshot?.items?.length ?? 0}。`);
  }
  lines.push('', `原始数据：${jsonPath}`);
  const reportPath = path.join(process.cwd(), 'docs', '记忆系统核心有效性实测.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`报告：${reportPath}`);
  console.log(`原始数据：${jsonPath}`);

  const clean = waitFor<{ sessionId: string }>('memory-eval-reset', () => true, 10000);
  socket.emit('memory-eval-reset');
  await clean;
  socket.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
