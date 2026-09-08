import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import type { CustomMemory, MemoryEvent, MemoryItem, SessionMemoryState } from '../../shared/types.js';

export interface MemoryTranscriptMessage {
  senderNickname: string;
  isAI: boolean;
  content: string;
}

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
const FIELD_LIMIT = 280;
const MAX_EVENTS = 5;
const MAX_ITEMS = 5;

export function createSessionMemoryState(worldSetting: string): SessionMemoryState {
  return {
    characterState: { goal: '', location: '', appearance: '', health: '', attitude: '' },
    worldState: { setting: worldSetting.slice(0, 1200), time: '', weather: '', location: '' },
    events: [],
    items: [],
    manualMemories: [],
    autoMemories: [],
    turnCount: 0,
    lastUpdatedTurn: 0,
    autoUpdateEnabled: true,
    updating: false,
    lastChangedFields: [],
  };
}

function clampText(value: unknown, limit = FIELD_LIMIT): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\u4e00-\u9fff\w]/g, '');
}

function characterBigrams(value: string): Set<string> {
  const normalized = normalizeText(value);
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function rankMemory(memory: CustomMemory, query: string): number {
  const target = normalizeText(`${memory.title} ${memory.content} ${memory.keyword ?? ''}`);
  const queryText = normalizeText(query);
  if (!target || !queryText) return 0;
  const queryGrams = characterBigrams(queryText);
  const memoryGrams = characterBigrams(target);
  const overlap = [...queryGrams].filter((gram) => memoryGrams.has(gram)).length;
  const keywordBoost = memory.keyword && queryText.includes(normalizeText(memory.keyword)) ? 12 : 0;
  const titleBoost = queryText.includes(normalizeText(memory.title)) ? 6 : 0;
  return overlap + keywordBoost + titleBoost;
}

export function getRetrievedMemories(state: SessionMemoryState, query: string, limit = 5): CustomMemory[] {
  return [...state.manualMemories, ...state.autoMemories]
    .filter((memory) => memory.enabled && memory.content.trim())
    .map((memory) => ({ memory, score: rankMemory(memory, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.memory.updatedAt - left.memory.updatedAt)
    .slice(0, Math.max(0, limit))
    .map(({ memory }) => memory);
}

export function formatMemoryContext(state: SessionMemoryState, query: string, retrievalLimit = 5): string {
  const retrieved = getRetrievedMemories(state, query, retrievalLimit);
  const character = state.characterState;
  const world = state.worldState;
  const events = state.events.length
    ? state.events.map((event) => `- [${event.authority ?? 'player'} | ${event.source || '来源未知'}] ${event.summary}`).join('\n')
    : '- 暂无';
  const items = state.items.length ? state.items.map((item) => `- ${item.name}：来源/归属 ${item.source || '未知'}；状态 ${item.status}`).join('\n') : '- 暂无';
  const customs = retrieved.length ? retrieved.map((memory) => `- ${memory.title}：${memory.content}`).join('\n') : '- 无匹配自定义记忆';
  return `## 会话记忆（只把其中明确事实作为已知信息；没有记录不要编造）\n\n### 角色状态\n- 目标：${character.goal || '未知'}\n- 位置：${character.location || '未知'}\n- 外观：${character.appearance || '未知'}\n- 健康：${character.health || '未知'}\n- 态度/关系：${character.attitude || '未知'}\n\n### 世界状态\n- 设定：${world.setting || '未知'}\n- 时间：${world.time || '未知'}\n- 天气：${world.weather || '未知'}\n- 地点：${world.location || '未知'}\n\n### 事件链\n${events}\n\n### 关键物品\n${items}\n\n### 相关自定义记忆\n${customs}`;
}

function toSafeCustomMemory(value: unknown, type: 'manual' | 'auto'): CustomMemory | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CustomMemory>;
  const title = clampText(candidate.title, 80);
  const content = clampText(candidate.content, FIELD_LIMIT);
  if (!title || !content) return null;
  return {
    id: typeof candidate.id === 'string' ? candidate.id : uuidv4(),
    title,
    content,
    type,
    keyword: clampText(candidate.keyword, 60) || undefined,
    enabled: candidate.enabled !== false,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  };
}

function normalizeItems(input: unknown, turn: number): MemoryItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as Partial<MemoryItem>;
      const name = clampText(candidate.name, 80);
      if (!name) return null;
      return {
        id: typeof candidate.id === 'string' ? candidate.id : uuidv4(),
        name,
        source: clampText(candidate.source, 120),
        status: clampText(candidate.status, FIELD_LIMIT),
        lastSeenTurn: typeof candidate.lastSeenTurn === 'number' ? candidate.lastSeenTurn : turn,
      };
    })
    .filter((item): item is MemoryItem => Boolean(item))
    .sort((left, right) => right.lastSeenTurn - left.lastSeenTurn)
    .slice(0, MAX_ITEMS);
}

function normalizeEvents(input: unknown, turn: number): MemoryEvent[] {
  const events = Array.isArray(input)
    ? input.map<MemoryEvent | null>((event) => {
      if (!event || typeof event !== 'object') return null;
      const candidate = event as { id?: unknown; summary?: unknown; source?: unknown; authority?: unknown; visibility?: unknown; turn?: unknown };
      const summary = clampText(candidate.summary, FIELD_LIMIT);
      const authority = candidate.authority === 'ai' || candidate.authority === 'manual' ? candidate.authority : 'player';
      const visibility = candidate.visibility === 'private' ? 'private' : 'public';
      return summary ? {
        id: typeof candidate.id === 'string' ? candidate.id : uuidv4(),
        summary,
        source: clampText(candidate.source, 80),
        authority,
        visibility,
        turn: typeof candidate.turn === 'number' ? candidate.turn : turn,
      } as MemoryEvent : null;
    }).filter((event): event is MemoryEvent => Boolean(event))
    : [];
  while (events.length > MAX_EVENTS) {
    const first = events.shift();
    const second = events.shift();
    if (!first || !second) break;
    events.unshift({
      id: uuidv4(),
      summary: `前情：${first.source ? `${first.source}：` : ''}${first.summary}；${second.source ? `${second.source}：` : ''}${second.summary}`.slice(0, FIELD_LIMIT),
      source: '多来源',
      authority: 'player',
      visibility: 'public',
      turn: second.turn,
    });
  }
  return events;
}

function transcriptText(messages: MemoryTranscriptMessage[]): string {
  return messages.map((message) => `${message.isAI ? `[${message.senderNickname}]` : message.senderNickname}：${message.content}`).join('\n');
}

interface ExplicitPlayerFact {
  source: string;
  summary: string;
}

function extractExplicitPlayerFacts(messages: MemoryTranscriptMessage[]): ExplicitPlayerFact[] {
  const meaningfulFact = /[0-9０-９]|刻|交给|保管|放在|剩|分钟|路线|钥匙|戒指|相机|电池|地图|车票|封路|借给|拿着|持有/;
  return messages.filter((message) => !message.isAI).flatMap((message) => message.content
    .split(/[。！？]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && meaningfulFact.test(sentence))
    .map((sentence) => {
      const attributed = sentence.match(/^([\u4e00-\u9fffA-Za-z]{1,12}?)(?:刚)?(?:说|确认|表示|提到|告知)(.+)$/);
      const reported = sentence.match(/^([\u4e00-\u9fffA-Za-z]{1,12})刚(.+)$/);
      const source = attributed?.[1] || reported?.[1] || message.senderNickname;
      return { source, summary: (attributed?.[2] || reported?.[2] || sentence).trim().slice(0, FIELD_LIMIT) };
    }));
}

/**
 * Model summarization must never erase a concrete player fact. This conservative fallback
 * stores only high-signal player statements and does not derive any new information.
 */
export function preserveExplicitPlayerFacts(state: SessionMemoryState, messages: MemoryTranscriptMessage[]): SessionMemoryState {
  const missing = extractExplicitPlayerFacts(messages).filter((fact) => !state.events.some((event) =>
    event.source === fact.source && (event.summary.includes(fact.summary) || fact.summary.includes(event.summary)),
  ));
  if (missing.length === 0) return state;
  const fallbackEvents: MemoryEvent[] = missing.map((fact) => ({
    id: uuidv4(),
    summary: fact.summary,
    source: fact.source,
    authority: 'player',
    visibility: 'public',
    turn: state.turnCount,
  }));
  const next = { ...state, events: normalizeEvents([...state.events, ...fallbackEvents], state.turnCount) };
  next.lastChangedFields = changedFields(state, next);
  return next;
}

function parseMemoryJson(raw: string): Partial<SessionMemoryState> {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed) as Partial<SessionMemoryState>;
  } catch {
    // Some compatible models add a short explanation around an otherwise valid JSON object.
    const start = trimmed.indexOf('{');
    if (start < 0) throw new Error('memory update did not contain JSON');
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(trimmed.slice(start, index + 1)) as Partial<SessionMemoryState>;
      }
    }
    throw new Error('memory update JSON object was incomplete');
  }
}

function changedFields(before: SessionMemoryState, after: SessionMemoryState): string[] {
  const fields: string[] = [];
  if (JSON.stringify(before.characterState) !== JSON.stringify(after.characterState)) fields.push('角色状态');
  if (JSON.stringify(before.worldState) !== JSON.stringify(after.worldState)) fields.push('世界状态');
  if (JSON.stringify(before.events) !== JSON.stringify(after.events)) fields.push('事件链');
  if (JSON.stringify(before.items) !== JSON.stringify(after.items)) fields.push('关键物品');
  if (JSON.stringify(before.autoMemories) !== JSON.stringify(after.autoMemories)) fields.push('自动记忆');
  return fields;
}

function normalizeAutoMemories(state: SessionMemoryState, input: unknown): CustomMemory[] {
  if (!Array.isArray(input)) return state.autoMemories;
  return input.reduce<CustomMemory[]>((result, value) => {
    const candidate = toSafeCustomMemory(value, 'auto');
    if (!candidate) return result;
    const configured = state.autoMemories.find((memory) => memory.id === candidate.id || memory.title === candidate.title);
    if (configured) result.push({ ...candidate, id: configured.id, keyword: configured.keyword, type: 'auto' });
    return result;
  }, []);
}

export function normalizeMemorySnapshot(state: SessionMemoryState, parsed: Partial<SessionMemoryState>): SessionMemoryState {
  const next: SessionMemoryState = {
    ...state,
    characterState: {
      goal: clampText(parsed.characterState?.goal), location: clampText(parsed.characterState?.location), appearance: clampText(parsed.characterState?.appearance), health: clampText(parsed.characterState?.health), attitude: clampText(parsed.characterState?.attitude),
    },
    worldState: {
      setting: clampText(parsed.worldState?.setting, 1200) || state.worldState.setting, time: clampText(parsed.worldState?.time), weather: clampText(parsed.worldState?.weather), location: clampText(parsed.worldState?.location),
    },
    events: normalizeEvents(parsed.events, state.turnCount),
    items: normalizeItems(parsed.items, state.turnCount),
    manualMemories: state.manualMemories,
    autoMemories: normalizeAutoMemories(state, parsed.autoMemories),
    lastUpdatedTurn: state.turnCount,
    updating: false,
    lastChangedFields: [],
  };
  next.lastChangedFields = changedFields(state, next);
  return next;
}

export async function updateSessionMemory(state: SessionMemoryState, messages: MemoryTranscriptMessage[]): Promise<SessionMemoryState> {
  if (!API_KEY || messages.length === 0) return { ...state, updating: false, lastChangedFields: [] };
  const previous = structuredClone(state);
  const memoryForModel = { ...state, manualMemories: state.manualMemories };
  const prompt = `你是多人文字冒险的会话记忆管理器。请根据已有记忆与新增的玩家消息，返回完整更新后的 JSON。\n\n事实优先级：\n1. 输入中的每一行都是人类玩家明确陈述，属于最高优先级事实，必须记录；不要把玩家转述的角色归属改成玩家本人。\n2. 本次输入没有 AI 回复。不得凭空补充任何 AI 角色的行动、物品、意图、路线、数字或环境细节。\n3. 新的人类明确事实可覆盖同一对象的旧人类事实；没有冲突的旧事实必须保留。\n\n落盘要求：\n- 每一条新增且会影响后续理解的明确事实，必须写进 events。每个 event 都必须带 source、authority: "player"、visibility: "public" 和 turn。\n- 转述也必须保留被转述角色：例如“阿辰说相机电池只剩一格”写为 source: "阿辰"、summary: "相机电池只剩一格"；“诺亚说北堤到捷运站要走十五分钟”写为 source: "诺亚"、summary: "北堤到捷运站步行十五分钟"。二者必须是两条独立 events，绝不能合并。\n- 每个关键实体物品写入 items。name 为物品名，source 写当前持有人或明确来源，status 写最新位置/状态。路线、时间、承诺等非物品事实只能写 events，不能因为没有物品而省略。\n- 不得生成输入中未出现的物品，例如备用电池；不要从氛围描写、猜测或反问推导事实。\n- events 最多 5 条；若超过，将最旧两条合并为一条“前情：...”，仍保留原来源。items 最多 5 条，保留最近出现的物品。\n- manualMemories 是人工维护的，不得修改、删除或新增。autoMemories 不得新增；仅当 keyword 与新增对话明确相关时更新其 content。\n- 保持字段结构：characterState、worldState、events、items、manualMemories、autoMemories。只输出 JSON，不要 Markdown。\n\n已有记忆：\n${JSON.stringify(memoryForModel)}\n\n新增玩家消息：\n${transcriptText(messages)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'system', content: '你只输出严格合法的 JSON 对象，不要使用 Markdown 或解释。' }, { role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1800,
      }, { timeout: 30000 });
      const raw = response.choices[0]?.message?.content?.trim() || '';
      const normalized = normalizeMemorySnapshot(state, parseMemoryJson(raw));
      const next = preserveExplicitPlayerFacts(normalized, messages);
      next.lastChangedFields = changedFields(previous, next);
      return next;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  console.error('[Memory] update failed after retry:', lastError);
  const fallback = preserveExplicitPlayerFacts({ ...state, updating: false, lastChangedFields: [] }, messages);
  return {
    ...fallback,
    lastChangedFields: fallback.lastChangedFields.length
      ? [...fallback.lastChangedFields, '更新失败，已使用玩家事实保底']
      : ['更新失败，已保留上一版记忆'],
  };
}
