import 'dotenv/config';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import app from './app.js';
import { evaluateBuilderCharacter, type PromptBuilderConfig, type PromptTrigger } from './services/ai.js';
import { getConfig, updateConfig } from './services/config-store.js';
import { createSessionMemoryState, formatMemoryContext, getRetrievedMemories, updateSessionMemory, type MemoryTranscriptMessage } from './services/memory.js';
import type { CustomMemory, MemoryEvaluationConfig, SessionMemoryState, WorldConfig } from '../shared/types.js';

const PORT = process.env.PORT || 3001;

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST'],
  },
});

interface RoomUser {
  id: string;
  nickname: string;
  joinedAt: number;
  currentRoomId: string;
}

interface RoomMessage {
  id: string;
  sessionId?: string;
  senderNickname: string;
  isAI: boolean;
  builderId?: string;
  characterId?: string;
  content: string;
  timestamp: number;
  mentions?: string[];
}

const room: {
  users: Map<string, RoomUser>;
  messages: RoomMessage[];
  sessionId: string;
} = {
  users: new Map(),
  messages: [],
  sessionId: uuidv4(),
};

const MAX_MESSAGES = 1000;
const BUNDLE_WINDOW_MS = 3000;
const PROACTIVE_INTERVALS_MS = [15000, 30000];
const DEFAULT_MAX_SPEAKERS = 3;
let roomPrompts: PromptBuilderConfig[] = (() => {
  const saved = getConfig().builderPrompts;
  if (!saved || saved.length < 2) return [];
  const prompts = saved.map((prompt) => ({
    id: prompt.id,
    label: prompt.label,
    template: prompt.template,
    maxSpeakers: prompt.maxSpeakers,
    variableConfig: prompt.variableConfig,
    worldSetting: prompt.worldSetting,
    characters: prompt.characters,
  }));
  if (!prompts.some((prompt) => prompt.id === 'prompt-c')) {
    const source = prompts.find((prompt) => prompt.id === 'prompt-b') ?? prompts[1];
    prompts.push({ ...source, id: 'prompt-c', label: 'Builder C' });
  }
  return prompts;
})();
const DEFAULT_VARIABLE_CONFIG = {
  taskDescriptions: {
    chat: '扮演{{roleName}}，基于当前群聊上下文直接输出一条符合角色设定的群聊回复；角色已被随机选中，关联较弱时也用最短的现场反应承接。',
    mention: '有人在群聊中明确提到了{{roleName}}，请扮演{{roleName}}直接回应。只输出一条符合角色设定的群聊回复。',
    proactive: '',
  },
  outputFormat: '只输出一条自己的对话回复。不要解释，不要输出分析过程。',
  dialogueRules: '保持角色一致。不要代替其他角色发言。不要重复前文。角色已被随机选中，必须回复；关联较弱时用最短反应承接现场。',
};

let pendingUserMessages: Array<{ senderNickname: string; content: string; mentions: string[] }> = [];
let bundleTimer: ReturnType<typeof setTimeout> | null = null;
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
let proactiveStage = 0;
let userActivityVersion = 0;
const busyTasks = new Map<string, string>();

interface MemoryEvaluationMessage extends RoomMessage {
  memoryCondition: 'baseline' | 'memory';
}

interface MemoryEvaluationSession {
  sessionId: string;
  config: MemoryEvaluationConfig;
  baselineMessages: MemoryEvaluationMessage[];
  memoryMessages: MemoryEvaluationMessage[];
  memoryState: SessionMemoryState;
  updateStartIndex: number;
  evaluating: boolean;
}

type SavedPromptConfig = Omit<PromptBuilderConfig, 'template'> & {
  template?: string;
  prompt?: string;
};

function createMemoryEvaluationSession(): MemoryEvaluationSession {
  const initialConfig: MemoryEvaluationConfig = {
    builderId: roomPrompts.find((builder) => builder.id === 'prompt-b')?.id ?? roomPrompts[0]?.id ?? 'prompt-b',
    updateEveryTurns: 10,
    baselineHistoryMessages: 8,
    retrievalLimit: 5,
    temperature: 0.3,
    presencePenalty: 0,
    fixedCharacterIds: [],
  };
  return {
    sessionId: uuidv4(),
    config: initialConfig,
    baselineMessages: [],
    memoryMessages: [],
    memoryState: createSessionMemoryState(getConfig().worldSetting),
    updateStartIndex: 0,
    evaluating: false,
  };
}

let memoryEvaluation = createMemoryEvaluationSession();

function getBuilderCharacters(builder: PromptBuilderConfig) {
  const config = getConfig();
  return builder.characters ?? config.characters;
}

function getSpeakerLimit(builder: PromptBuilderConfig) {
  const value = Number(builder.maxSpeakers ?? DEFAULT_MAX_SPEAKERS);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEFAULT_MAX_SPEAKERS;
}

function pickRandomCharacters(characters: ReturnType<typeof getBuilderCharacters>, count: number) {
  const randomCount = Math.floor(Math.random() * Math.min(count, characters.length)) + 1;
  return [...characters]
    .sort(() => Math.random() - 0.5)
    .slice(0, randomCount);
}

function pickMemoryCharacters(characters: ReturnType<typeof getBuilderCharacters>, count: number) {
  const fixedIds = memoryEvaluation.config.fixedCharacterIds ?? [];
  const fixed = fixedIds
    .map((id) => characters.find((character) => character.id === id))
    .filter((character): character is (typeof characters)[number] => Boolean(character));
  return fixed.length > 0 ? fixed.slice(0, Math.min(count, fixed.length)) : pickRandomCharacters(characters, count);
}

function toContextMessages(messages: RoomMessage[]) {
  return messages.map((m) => ({
    senderNickname: m.senderNickname,
    isAI: m.isAI,
    characterId: m.characterId,
    content: m.content,
    mentions: m.mentions,
  }));
}

function getContextMessages() {
  const maxCharacterCount = Math.max(
    1,
    ...roomPrompts.map((builder) => getBuilderCharacters(builder).length),
    getConfig().characters.length,
  );
  const contextLimit = Math.min(MAX_MESSAGES, Math.max(100, 100 * maxCharacterCount));
  return toContextMessages(room.messages.slice(-contextLimit));
}

function getRecentFiveRoundsMessages() {
  const playerMessageIndexes = room.messages
    .map((message, index) => message.isAI ? -1 : index)
    .filter((index) => index >= 0);
  const startIndex = playerMessageIndexes.length > 5
    ? playerMessageIndexes[playerMessageIndexes.length - 5]
    : 0;
  return toContextMessages(room.messages.slice(startIndex));
}

function hasOnlineUsers(): boolean {
  return room.users.size > 0;
}

function pushMessage(msg: RoomMessage) {
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) {
    room.messages = room.messages.slice(-MAX_MESSAGES);
  }
}

function emitMessage(msg: RoomMessage) {
  const message = { ...msg, sessionId: msg.sessionId ?? room.sessionId };
  pushMessage(message);
  io.emit('new-message', message);
}

function extractReplyText(raw: string): string {
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.reply === 'string') return parsed.reply;
    }
  } catch {
    // 不是合法 JSON，返回原文
  }
  return raw;
}

function shouldEmitReply(text: string): boolean {
  const trimmed = extractReplyText(text).trim();
  return Boolean(trimmed) && trimmed !== '[PASS]' && !trimmed.includes('[PASS]');
}

function replySimilarity(left: string, right: string) {
  const normalize = (value: string) => value.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').slice(0, 180);
  const leftGrams = new Set([...normalize(left)].map((_, index, chars) => chars.slice(index, index + 2).join('')));
  const rightGrams = new Set([...normalize(right)].map((_, index, chars) => chars.slice(index, index + 2).join('')));
  if (leftGrams.size < 8 || rightGrams.size < 8) return 0;
  const intersection = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  return intersection / new Set([...leftGrams, ...rightGrams]).size;
}

function shouldDropBuilderBReply(content: string, trigger: PromptTrigger, previousReplies: string[]) {
  if (trigger !== 'mention') {
    if (previousReplies.some((previous) => replySimilarity(content, previous) >= 0.55)) return true;
  }
  return false;
}

function compactBuilderBReply(content: string) {
  const normalized = content.trim();
  const characters = [...normalized];
  if (characters.length <= 60) return normalized;
  const shortened = characters.slice(0, 60).join('');
  const boundary = Math.max(shortened.lastIndexOf('。'), shortened.lastIndexOf('！'), shortened.lastIndexOf('？'), shortened.lastIndexOf('」'));
  return boundary >= 28 ? shortened.slice(0, boundary + 1) : shortened.slice(0, 59) + '…';
}

function emitPromptReply(reply: {
  id: string;
  label: string;
  characterId?: string;
  characterName?: string;
  reply: string;
  latencyMs: number;
  tokens: number;
  error?: string;
}, forceReply = false, trigger: PromptTrigger = 'chat', previousReplies: string[] = []) {
  let actualReply = extractReplyText(reply.reply).trim();
  if (reply.id === 'prompt-b') actualReply = compactBuilderBReply(actualReply);
  if (!actualReply && !forceReply) return;
  if (!forceReply && !shouldEmitReply(reply.reply)) return;
  if (reply.id === 'prompt-b' && shouldDropBuilderBReply(actualReply, trigger, previousReplies)) return;
  const content = forceReply && (!actualReply || actualReply.includes('[PASS]'))
    ? '（稍作停顿）我看到你的消息了。'
    : actualReply;
  emitMessage({
    id: uuidv4(),
    senderNickname: reply.label + (reply.characterName ? ' · ' + reply.characterName : ''),
    isAI: true,
    builderId: reply.id,
    characterId: reply.characterId,
    content,
    timestamp: Date.now(),
  });
  if (reply.id === 'prompt-b' && content) previousReplies.push(content);
}

function getMentionedCharacterNames(content: string): string[] {
  const names = new Set<string>();
  for (const builder of roomPrompts) {
    for (const character of getBuilderCharacters(builder)) {
      if (content.includes('@' + character.name)) names.add(character.name);
    }
  }
  for (const character of getConfig().characters) {
    if (content.includes('@' + character.name)) names.add(character.name);
  }
  return [...names];
}

function fillSharedText(value: string, characterName: string, allCharacterNames: string[], mentionedNames: string[], trigger: PromptTrigger) {
  const replacements: Record<string, string> = {
    roleName: characterName,
    allCharacterNames: allCharacterNames.join('、') || '无',
    mentionedCharacters: mentionedNames.join('、') || '无',
    trigger,
  };
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.split('{{' + key + '}}').join(replacement),
    value,
  );
}

function getBuilderVariableConfig(builder: PromptBuilderConfig) {
  return {
    ...DEFAULT_VARIABLE_CONFIG,
    ...(builder.variableConfig ?? {}),
    taskDescriptions: {
      ...DEFAULT_VARIABLE_CONFIG.taskDescriptions,
      ...(builder.variableConfig?.taskDescriptions ?? {}),
    },
  };
}

function getEvaluationTasks(trigger: PromptTrigger, mentionedNames: string[]) {
  return roomPrompts.filter((builder) => builder.id !== 'prompt-c').flatMap((builder) => {
    const characters = getBuilderCharacters(builder);
    const eligibleCharacters = characters.filter((character) => !busyTasks.has(builder.id + ':' + character.id));
    const targetCharacters = trigger === 'mention'
      ? eligibleCharacters.filter((character) => mentionedNames.includes(character.name))
      : pickRandomCharacters(eligibleCharacters, getSpeakerLimit(builder));
    return targetCharacters
      .map((character) => ({ builder, character }));
  });
}

function getBuilderCCharacters(trigger: PromptTrigger, mentionedNames: string[]) {
  const builder = roomPrompts.find((item) => item.id === 'prompt-c');
  if (!builder) return { builder: null, characters: [] as ReturnType<typeof getBuilderCharacters> };
  const characters = getBuilderCharacters(builder);
  const eligibleCharacters = characters.filter((character) => !busyTasks.has(builder.id + ':' + character.id));
  const selectedCharacters = trigger === 'mention'
    ? eligibleCharacters.filter((character) => mentionedNames.includes(character.name))
    : pickRandomCharacters(eligibleCharacters, getSpeakerLimit(builder));
  return { builder, characters: selectedCharacters };
}

async function runBuilderCSerialEvaluation(
  trigger: PromptTrigger,
  latestMessage: string,
  mentionedNames: string[],
  sessionIdAtStart: string,
  activityVersionAtStart: number,
  results: Array<Awaited<ReturnType<typeof evaluateBuilderCharacter>>>,
) {
  const { builder, characters } = getBuilderCCharacters(trigger, mentionedNames);
  if (!builder) return;
  let previousReply = '';
  for (const character of characters) {
    if (sessionIdAtStart !== room.sessionId || activityVersionAtStart !== userActivityVersion) return;
    const taskKey = builder.id + ':' + character.id;
    busyTasks.set(taskKey, sessionIdAtStart);
    try {
      const variableConfig = getBuilderVariableConfig(builder);
      const allCharacterNames = getBuilderCharacters(builder)
        .filter((item) => item.id !== character.id)
        .map((item) => item.name);
      const serialInput = previousReply
        ? latestMessage + '\n上一位 AI 的回复：' + previousReply
        : latestMessage;
      const result = await evaluateBuilderCharacter(builder, {
        trigger,
        targetCharacter: character,
        characters: getBuilderCharacters(builder),
        worldSetting: builder.worldSetting ?? getConfig().worldSetting,
        taskDescription: trigger === 'proactive'
          ? ''
          : fillSharedText(variableConfig.taskDescriptions[trigger], character.name, allCharacterNames, mentionedNames, trigger),
        outputFormat: fillSharedText(variableConfig.outputFormat, character.name, allCharacterNames, mentionedNames, trigger),
        dialogueRules: fillSharedText(variableConfig.dialogueRules, character.name, allCharacterNames, mentionedNames, trigger),
        recentMessages: getRecentFiveRoundsMessages(),
        latestMessage: serialInput,
        mentionedNames,
      });
      if (sessionIdAtStart !== room.sessionId || activityVersionAtStart !== userActivityVersion) return;
      results.push(result);
      emitPromptReply(result, trigger === 'mention', trigger);
      const replyText = extractReplyText(result.reply).trim();
      if (replyText && !replyText.includes('[PASS]')) previousReply = replyText;
    } finally {
      if (busyTasks.get(taskKey) === sessionIdAtStart) busyTasks.delete(taskKey);
    }
  }
}

async function runBuilderEvaluation(trigger: PromptTrigger, latestMessage: string, mentionedNames: string[] = []) {
  const sessionIdAtStart = room.sessionId;
  const tasks = getEvaluationTasks(trigger, mentionedNames);
  const hasBuilderC = Boolean(roomPrompts.find((builder) => builder.id === 'prompt-c'));
  if (tasks.length === 0 && !hasBuilderC) {
    scheduleProactiveTurn();
    return;
  }

  const activityVersionAtStart = userActivityVersion;
  tasks.forEach(({ builder, character }) => busyTasks.set(builder.id + ':' + character.id, sessionIdAtStart));
  io.emit('prompt-evaluation-started', {
    input: latestMessage,
    trigger,
    taskCount: tasks.length + (hasBuilderC ? 1 : 0),
    sessionId: sessionIdAtStart,
  });

  const results: Array<Awaited<ReturnType<typeof evaluateBuilderCharacter>>> = [];
  const builderBReplies: string[] = [];
  try {
    await Promise.all(tasks.map(async ({ builder, character }) => {
      const characters = getBuilderCharacters(builder);
      const variableConfig = getBuilderVariableConfig(builder);
      const allCharacterNames = characters
        .filter((item) => item.id !== character.id)
        .map((item) => item.name);
      const result = await evaluateBuilderCharacter(builder, {
        trigger,
        targetCharacter: character,
        characters,
        worldSetting: builder.worldSetting ?? getConfig().worldSetting,
        taskDescription: trigger === 'proactive'
          ? ''
          : fillSharedText(variableConfig.taskDescriptions[trigger], character.name, allCharacterNames, mentionedNames, trigger),
        outputFormat: fillSharedText(variableConfig.outputFormat, character.name, allCharacterNames, mentionedNames, trigger),
        dialogueRules: fillSharedText(variableConfig.dialogueRules, character.name, allCharacterNames, mentionedNames, trigger),
        recentMessages: getContextMessages(),
        latestMessage,
        mentionedNames,
      });
      if (sessionIdAtStart !== room.sessionId) return result;
      results.push(result);
      emitPromptReply(result, trigger === 'mention', trigger, builderBReplies);
      return result;
    }));
    if (sessionIdAtStart === room.sessionId && activityVersionAtStart === userActivityVersion) {
      await runBuilderCSerialEvaluation(trigger, latestMessage, mentionedNames, sessionIdAtStart, activityVersionAtStart, results);
    }
    if (sessionIdAtStart === room.sessionId) {
      io.emit('prompt-evaluation-result', {
        success: true,
        input: latestMessage,
        trigger,
        results,
        sessionId: room.sessionId,
      });
    }
  } finally {
    tasks.forEach(({ builder, character }) => {
      const key = builder.id + ':' + character.id;
      if (busyTasks.get(key) === sessionIdAtStart) busyTasks.delete(key);
    });
    if (sessionIdAtStart === room.sessionId && activityVersionAtStart === userActivityVersion) {
      if (trigger === 'proactive') {
        proactiveStage = Math.min(proactiveStage + 1, PROACTIVE_INTERVALS_MS.length - 1);
      } else {
        proactiveStage = 0;
      }
      scheduleProactiveTurn();
    }
  }
}

function stopProactiveTimer() {
  if (proactiveTimer) {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
  }
}

function scheduleProactiveTurn() {
  stopProactiveTimer();
  if (!hasOnlineUsers() || proactiveStage >= PROACTIVE_INTERVALS_MS.length) return;
  const delay = PROACTIVE_INTERVALS_MS[proactiveStage];
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    void runBuilderEvaluation('proactive', '');
  }, delay);
}

function clearPendingBundle() {
  if (bundleTimer) clearTimeout(bundleTimer);
  bundleTimer = null;
  pendingUserMessages = [];
}

function queueUserMessage(message: { senderNickname: string; content: string; mentions: string[] }) {
  pendingUserMessages.push(message);
  if (bundleTimer) clearTimeout(bundleTimer);
  bundleTimer = setTimeout(() => {
    bundleTimer = null;
    const bundled = pendingUserMessages;
    pendingUserMessages = [];
    const mentionedNames = [...new Set(bundled.flatMap((message) => message.mentions))];
    const latestMessage = bundled
      .map((message) => message.senderNickname + ': ' + message.content)
      .join('\n');
    void runBuilderEvaluation(mentionedNames.length > 0 ? 'mention' : 'chat', latestMessage, mentionedNames);
  }, BUNDLE_WINDOW_MS);
}

function getMemoryBuilder(): PromptBuilderConfig | undefined {
  return roomPrompts.find((builder) => builder.id === memoryEvaluation.config.builderId) ?? roomPrompts[0];
}

function toMemoryTranscript(messages: MemoryEvaluationMessage[]): MemoryTranscriptMessage[] {
  return messages.map((message) => ({ senderNickname: message.senderNickname, isAI: message.isAI, content: message.content }));
}

function getMemoryEvaluationPayload() {
  const state = memoryEvaluation.memoryState;
  const lastPlayerMessage = [...memoryEvaluation.memoryMessages].reverse().find((message) => !message.isAI)?.content ?? '';
  return {
    sessionId: memoryEvaluation.sessionId,
    config: memoryEvaluation.config,
    baselineMessages: memoryEvaluation.baselineMessages,
    memoryMessages: memoryEvaluation.memoryMessages,
    memoryState: state,
    retrievedMemories: getRetrievedMemories(state, lastPlayerMessage, memoryEvaluation.config.retrievalLimit),
    evaluating: memoryEvaluation.evaluating,
  };
}

function emitMemoryEvaluationState(target?: import('socket.io').Socket) {
  (target ?? io).emit('memory-eval-state', getMemoryEvaluationPayload());
}

function normalizeMemoryConfig(input: Partial<MemoryEvaluationConfig>): MemoryEvaluationConfig {
  const builderExists = roomPrompts.some((builder) => builder.id === input.builderId);
  return {
    builderId: builderExists ? String(input.builderId) : (getMemoryBuilder()?.id ?? 'prompt-b'),
    updateEveryTurns: Math.max(1, Math.min(30, Math.floor(Number(input.updateEveryTurns) || 10))),
    baselineHistoryMessages: Math.max(1, Math.min(40, Math.floor(Number(input.baselineHistoryMessages) || 8))),
    retrievalLimit: Math.max(1, Math.min(10, Math.floor(Number(input.retrievalLimit) || 5))),
    temperature: Number.isFinite(Number(input.temperature)) ? Math.max(0, Math.min(2, Number(input.temperature))) : 0.3,
    presencePenalty: Number.isFinite(Number(input.presencePenalty)) ? Math.max(-2, Math.min(2, Number(input.presencePenalty))) : 0,
    fixedCharacterIds: Array.isArray(input.fixedCharacterIds)
      ? input.fixedCharacterIds.filter((id): id is string => typeof id === 'string').slice(0, 6)
      : [],
  };
}

function createCustomMemory(input: Partial<CustomMemory>, type: 'manual' | 'auto'): CustomMemory | null {
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 80) : '';
  const content = typeof input.content === 'string' ? input.content.trim().slice(0, 280) : '';
  if (!title || !content) return null;
  return {
    id: uuidv4(), title, content, type,
    keyword: typeof input.keyword === 'string' && input.keyword.trim() ? input.keyword.trim().slice(0, 60) : undefined,
    enabled: input.enabled !== false, updatedAt: Date.now(),
  };
}

async function evaluateMemoryCharacterWithRetry(
  builder: PromptBuilderConfig,
  context: Parameters<typeof evaluateBuilderCharacter>[1],
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await evaluateBuilderCharacter(builder, context);
    if (!result.error && extractReplyText(result.reply).trim()) return result;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    else return result;
  }
  throw new Error('unreachable');
}

function scheduleMemoryUpdate(force = false) {
  const sessionAtStart = memoryEvaluation.sessionId;
  const state = memoryEvaluation.memoryState;
  if (state.updating || (!force && (!state.autoUpdateEnabled || state.turnCount === 0 || state.turnCount % memoryEvaluation.config.updateEveryTurns !== 0))) return;
  const updateStartIndex = memoryEvaluation.updateStartIndex;
  const allDelta = memoryEvaluation.memoryMessages.slice(updateStartIndex);
  // Generated roleplay is intentionally excluded: it may contain guesses and scene detail.
  // Public memory is updated only from explicit player input until AI facts have provenance checks.
  const delta = allDelta.filter((message) => !message.isAI);
  if (delta.length === 0) {
    memoryEvaluation.updateStartIndex = updateStartIndex + allDelta.length;
    return;
  }
  memoryEvaluation.memoryState = { ...state, updating: true };
  emitMemoryEvaluationState();
  void updateSessionMemory(memoryEvaluation.memoryState, toMemoryTranscript(delta)).then((next) => {
    if (memoryEvaluation.sessionId !== sessionAtStart) return;
    const current = memoryEvaluation.memoryState;
    const originalAutoById = new Map(state.autoMemories.map((memory) => [memory.id, memory]));
    const updatedAutoById = new Map(next.autoMemories.map((memory) => [memory.id, memory]));
    const mergedAutoMemories = current.autoMemories.map((memory) => {
      const original = originalAutoById.get(memory.id);
      const updated = updatedAutoById.get(memory.id);
      return original && updated && memory.updatedAt === original.updatedAt ? updated : memory;
    });
    memoryEvaluation.memoryState = {
      ...next,
      turnCount: current.turnCount,
      autoUpdateEnabled: current.autoUpdateEnabled,
      manualMemories: current.manualMemories,
      autoMemories: mergedAutoMemories,
    };
    memoryEvaluation.updateStartIndex = updateStartIndex + allDelta.length;
    io.emit('memory-eval-memory-updated', { memoryState: memoryEvaluation.memoryState, changedFields: next.lastChangedFields });
    emitMemoryEvaluationState();
  });
}

async function runMemoryEvaluationTurn(content: string, senderNickname: string) {
  if (memoryEvaluation.evaluating) return;
  const builder = getMemoryBuilder();
  if (!builder) return;
  const characters = getBuilderCharacters(builder);
  if (characters.length === 0) return;
  const sessionAtStart = memoryEvaluation.sessionId;
  memoryEvaluation.evaluating = true;
  const timestamp = Date.now();
  const userMessage = (condition: 'baseline' | 'memory'): MemoryEvaluationMessage => ({
    id: uuidv4(), senderNickname, isAI: false, content, timestamp, memoryCondition: condition,
  });
  memoryEvaluation.baselineMessages.push(userMessage('baseline'));
  memoryEvaluation.memoryMessages.push(userMessage('memory'));
  memoryEvaluation.memoryState = { ...memoryEvaluation.memoryState, turnCount: memoryEvaluation.memoryState.turnCount + 1 };
  io.emit('memory-eval-turn-started', { sessionId: sessionAtStart, content });
  emitMemoryEvaluationState();

  const selected = pickMemoryCharacters(characters, getSpeakerLimit(builder));
  const variableConfig = getBuilderVariableConfig(builder);
  const recentFor = (messages: MemoryEvaluationMessage[]) => toContextMessages(messages.slice(-memoryEvaluation.config.baselineHistoryMessages));
  try {
    await Promise.all(selected.map(async (character) => {
      const otherNames = characters.filter((item) => item.id !== character.id).map((item) => item.name);
      const common = {
        trigger: 'chat' as PromptTrigger,
        targetCharacter: character,
        characters,
        worldSetting: builder.worldSetting ?? getConfig().worldSetting,
        taskDescription: fillSharedText(variableConfig.taskDescriptions.chat, character.name, otherNames, [], 'chat'),
        outputFormat: fillSharedText(variableConfig.outputFormat, character.name, otherNames, [], 'chat'),
        dialogueRules: fillSharedText(variableConfig.dialogueRules, character.name, otherNames, [], 'chat'),
        latestMessage: `${senderNickname}: ${content}`,
        mentionedNames: [],
        sampling: {
          temperature: memoryEvaluation.config.temperature,
          presencePenalty: memoryEvaluation.config.presencePenalty,
        },
      };
      const memoryContext = formatMemoryContext(memoryEvaluation.memoryState, content, memoryEvaluation.config.retrievalLimit);
      const [baselineResult, memoryResult] = await Promise.all([
        evaluateMemoryCharacterWithRetry(builder, { ...common, recentMessages: recentFor(memoryEvaluation.baselineMessages) }),
        evaluateMemoryCharacterWithRetry(builder, { ...common, recentMessages: recentFor(memoryEvaluation.memoryMessages), memoryContext }),
      ]);
      if (memoryEvaluation.sessionId !== sessionAtStart) return;
      const appendResult = (condition: 'baseline' | 'memory', result: Awaited<ReturnType<typeof evaluateBuilderCharacter>>) => {
        const response = extractReplyText(result.reply).trim() || '（本轮未生成有效回复）';
        const message: MemoryEvaluationMessage = {
          id: uuidv4(), senderNickname: `${builder.label} · ${result.characterName ?? character.name}`,
          isAI: true, builderId: builder.id, characterId: result.characterId, content: response,
          timestamp: Date.now(), memoryCondition: condition,
        };
        if (condition === 'baseline') memoryEvaluation.baselineMessages.push(message);
        else memoryEvaluation.memoryMessages.push(message);
        io.emit('memory-eval-message', message);
      };
      appendResult('baseline', baselineResult);
      appendResult('memory', memoryResult);
    }));
  } finally {
    if (memoryEvaluation.sessionId === sessionAtStart) {
      memoryEvaluation.evaluating = false;
      io.emit('memory-eval-turn-completed', { sessionId: sessionAtStart, selectedCharacterIds: selected.map((character) => character.id) });
      emitMemoryEvaluationState();
      scheduleMemoryUpdate();
    }
  }
}

// ─── Socket.IO 连接处理 ───

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  socket.on('get-config', () => {
    socket.emit('config-updated', getConfig());
  });

  socket.on('get-prompt-config', () => {
    socket.emit('prompt-config-updated', roomPrompts);
  });

  socket.on('get-memory-eval-state', () => {
    emitMemoryEvaluationState(socket);
    socket.emit('prompt-config-updated', roomPrompts);
    socket.emit('config-updated', getConfig());
  });

  socket.on('memory-eval-send', ({ content, nickname }: { content?: string; nickname?: string }) => {
    const trimmed = content?.trim();
    if (!trimmed) return;
    void runMemoryEvaluationTurn(trimmed.slice(0, 1000), nickname?.trim().slice(0, 20) || '评测玩家');
  });

  socket.on('memory-eval-reset', () => {
    memoryEvaluation = createMemoryEvaluationSession();
    io.emit('memory-eval-reset', { sessionId: memoryEvaluation.sessionId });
    emitMemoryEvaluationState();
  });

  socket.on('memory-eval-config-save', (data: Partial<MemoryEvaluationConfig>) => {
    memoryEvaluation.config = normalizeMemoryConfig(data ?? {});
    emitMemoryEvaluationState();
  });

  socket.on('memory-eval-toggle-auto-update', (enabled: boolean) => {
    memoryEvaluation.memoryState = { ...memoryEvaluation.memoryState, autoUpdateEnabled: Boolean(enabled) };
    emitMemoryEvaluationState();
  });

  socket.on('memory-eval-update-now', () => scheduleMemoryUpdate(true));

  socket.on('memory-eval-add-custom', (input: Partial<CustomMemory> & { type?: 'manual' | 'auto' }) => {
    const type = input?.type === 'auto' ? 'auto' : 'manual';
    const memory = createCustomMemory(input ?? {}, type);
    if (!memory) return;
    const key = type === 'manual' ? 'manualMemories' : 'autoMemories';
    const current = memoryEvaluation.memoryState[key];
    if (current.length >= (type === 'manual' ? 20 : 20)) return;
    memoryEvaluation.memoryState = { ...memoryEvaluation.memoryState, [key]: [...current, memory] };
    emitMemoryEvaluationState();
  });

  socket.on('memory-eval-update-custom', (input: Partial<CustomMemory> & { id?: string; type?: 'manual' | 'auto' }) => {
    const type = input?.type === 'auto' ? 'auto' : 'manual';
    if (!input?.id) return;
    const key = type === 'manual' ? 'manualMemories' : 'autoMemories';
    memoryEvaluation.memoryState = {
      ...memoryEvaluation.memoryState,
      [key]: memoryEvaluation.memoryState[key].map((memory) => memory.id === input.id ? {
        ...memory,
        title: typeof input.title === 'string' ? input.title.trim().slice(0, 80) || memory.title : memory.title,
        content: typeof input.content === 'string' ? input.content.trim().slice(0, 280) || memory.content : memory.content,
        keyword: typeof input.keyword === 'string' ? input.keyword.trim().slice(0, 60) || undefined : memory.keyword,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : memory.enabled,
        updatedAt: Date.now(),
      } : memory),
    };
    emitMemoryEvaluationState();
  });

  socket.on('memory-eval-delete-custom', ({ id, type }: { id?: string; type?: 'manual' | 'auto' }) => {
    if (!id) return;
    const key = type === 'auto' ? 'autoMemories' : 'manualMemories';
    memoryEvaluation.memoryState = { ...memoryEvaluation.memoryState, [key]: memoryEvaluation.memoryState[key].filter((memory) => memory.id !== id) };
    emitMemoryEvaluationState();
  });

  socket.on('get-builder-variable-config', () => {
    // 每个 builder 有自己的变量配置，返回空对象（前端从 prompt-config 中获取）
    socket.emit('builder-variable-config-updated', { taskDescriptions: { chat: '', mention: '', proactive: '' }, outputFormat: '', dialogueRules: '' });
  });

  socket.on('save-prompt-config', (data: SavedPromptConfig[]) => {
    roomPrompts = (data ?? []).slice(0, 3).map((item, index) => ({
      id: item.id || `prompt-${index + 1}`,
      label: item.label || `Builder ${index + 1}`,
      template: item.template ?? item.prompt ?? '',
      maxSpeakers: Number.isFinite(Number(item.maxSpeakers)) ? Math.max(1, Math.floor(Number(item.maxSpeakers))) : DEFAULT_MAX_SPEAKERS,
      variableConfig: item.variableConfig,
      worldSetting: item.worldSetting,
      characters: item.characters,
    }));
    io.emit('prompt-config-updated', roomPrompts);
    // 保存到文件
    const current = getConfig();
    updateConfig({
      ...current,
      builderPrompts: roomPrompts,
    });
  });

  socket.on('save-config', (data: WorldConfig) => {
    const newConfig = updateConfig({
      ...data,
      builderPrompts: roomPrompts,
    });
    io.emit('config-updated', newConfig);
    console.log('[配置] 世界观已更新');
  });

  socket.on('join-room', ({ nickname }) => {
    const user: RoomUser = {
      id: socket.id,
      nickname,
      joinedAt: Date.now(),
      currentRoomId: 'text-room',
    };
    room.users.set(socket.id, user);

    socket.emit('room-history', {
      messages: room.messages.slice(-50),
      users: Array.from(room.users.values()).map((u) => ({ id: u.id, nickname: u.nickname })),
      sessionId: room.sessionId,
    });
    socket.emit('prompt-config-updated', roomPrompts);

    socket.broadcast.emit('user-joined', {
      nickname,
      onlineCount: room.users.size,
    });

    const joinMessage: RoomMessage = {
      id: uuidv4(),
      senderNickname: '系统',
      isAI: false,
      content: `${nickname} 加入了聊天室`,
      timestamp: Date.now(),
    };
    emitMessage(joinMessage);

    console.log(`[加入] ${nickname} (${socket.id})`);

    socket.emit('config-updated', getConfig());
    scheduleProactiveTurn();
  });

  socket.on('send-message', async ({ content }) => {
    const user = room.users.get(socket.id);
    if (!user) return;
    const trimmed = content?.trim();
    if (!trimmed) return;

    const mentionedNames = getMentionedCharacterNames(trimmed);
    emitMessage({
      id: uuidv4(),
      senderNickname: user.nickname,
      isAI: false,
      content: trimmed,
      timestamp: Date.now(),
      mentions: mentionedNames,
    });

    userActivityVersion += 1;
    proactiveStage = 0;
    stopProactiveTimer();
    queueUserMessage({
      senderNickname: user.nickname,
      content: trimmed,
      mentions: mentionedNames,
    });
  });
  socket.on('clear-room-history', () => {
    const user = room.users.get(socket.id);
    if (!user) return;

    clearPendingBundle();
    room.messages = [];
    busyTasks.clear();
    room.sessionId = uuidv4();
    proactiveStage = 0;
    userActivityVersion += 1;
    stopProactiveTimer();
    io.emit('room-history-cleared', { sessionId: room.sessionId });
    scheduleProactiveTurn();
    console.log('[清空记录] ' + user.nickname + ' (' + socket.id + ')');
  });
  socket.on('disconnect', () => {
    const user = room.users.get(socket.id);
    if (user) {
      room.users.delete(socket.id);

      io.emit('user-left', {
        socketId: socket.id,
        nickname: user.nickname,
        onlineCount: room.users.size,
      });

      const leaveMessage: RoomMessage = {
        id: uuidv4(),
        senderNickname: '系统',
        isAI: false,
        content: `${user.nickname} 离开了聊天室`,
        timestamp: Date.now(),
      };
      emitMessage(leaveMessage);

      console.log(`[离开] ${user.nickname} (${socket.id})`);
      if (!hasOnlineUsers()) {
        stopProactiveTimer();
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server ready on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received');
  stopProactiveTimer();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received');
  stopProactiveTimer();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
