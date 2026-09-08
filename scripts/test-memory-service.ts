import assert from 'node:assert/strict';
import { createSessionMemoryState, formatMemoryContext, getRetrievedMemories, normalizeMemorySnapshot, preserveExplicitPlayerFacts } from '../api/services/memory.js';

const state = createSessionMemoryState('测试世界');
state.turnCount = 9;
state.manualMemories = [{ id: 'manual-1', title: '玩家约定', content: '玩家不接受替其做决定。', type: 'manual', enabled: true, updatedAt: 1 }];
state.autoMemories = [
  { id: 'auto-1', title: '戒指线索', content: '黑色戒指在石台上出现过。', keyword: '戒指', type: 'auto', enabled: true, updatedAt: 1 },
  { id: 'auto-2', title: '药草线索', content: '药草装在木盒里。', keyword: '药草', type: 'auto', enabled: true, updatedAt: 2 },
];

const snapshot = normalizeMemorySnapshot(state, {
  characterState: { goal: '找到出口', location: '地窟', appearance: '', health: '轻伤', attitude: '警惕' },
  worldState: { setting: '测试世界', time: '深夜', weather: '雨', location: '地窟石台' },
  events: Array.from({ length: 6 }, (_, index) => ({ id: `event-${index}`, summary: `事件${index + 1}`, source: index % 2 ? '诺亚' : '阿辰', authority: 'player', visibility: 'public', turn: index + 1 })),
  items: Array.from({ length: 6 }, (_, index) => ({ id: `item-${index}`, name: `物品${index + 1}`, source: '测试', status: '持有', lastSeenTurn: index + 1 })),
  manualMemories: [],
  autoMemories: [{ id: 'auto-1', title: '戒指线索', content: '黑色戒指已经戴在玩家手上。', keyword: '戒指', type: 'auto', enabled: true, updatedAt: 3 }],
});

assert.equal(snapshot.events.length, 5, '事件链必须压缩到 5 条');
assert.ok(snapshot.events[0].summary.startsWith('前情：'), '事件溢出时应合并最旧事件');
assert.equal(snapshot.items.length, 5, '关键物品必须淘汰到 5 条');
assert.equal(snapshot.items[0].name, '物品6', '应保留最近出现的物品');
assert.deepEqual(snapshot.manualMemories, state.manualMemories, '手工记忆不得被自动更新改写');
assert.equal(snapshot.autoMemories.length, 1, '自动更新不得新增未配置的槽位');
assert.equal(snapshot.autoMemories[0].content, '黑色戒指已经戴在玩家手上。');
assert.equal(snapshot.events.at(-1)?.source, '诺亚', '事件来源必须在快照中保留');

const retrieved = getRetrievedMemories(snapshot, '我摸到那枚戒指了', 5);
assert.equal(retrieved[0]?.id, 'auto-1', '关键词 RAG 应优先命中相关记忆');
const context = formatMemoryContext(snapshot, '戒指', 5);
assert.ok(context.includes('黑色戒指已经戴在玩家手上。'), '记忆上下文应包含命中的自定义记忆');
assert.ok(context.includes('找到出口'), '记忆上下文应包含公共状态');
assert.ok(context.includes('[player | 诺亚]'), '记忆上下文应包含事件来源和权威级别');

const fallback = preserveExplicitPlayerFacts(createSessionMemoryState('测试世界'), [
  { senderNickname: '评测玩家', isAI: false, content: '阿辰说相机电池只剩一格。诺亚确认北堤到捷运站要走十五分钟。' },
  { senderNickname: '阿辰', isAI: true, content: '我带了两块备用电池。' },
]);
assert.deepEqual(fallback.events.map((event) => [event.source, event.summary]), [
  ['阿辰', '相机电池只剩一格'],
  ['诺亚', '北堤到捷运站要走十五分钟'],
], '明确玩家转述必须按来源保底，AI 演绎不得进入公共事实');

console.log('memory service tests passed');
