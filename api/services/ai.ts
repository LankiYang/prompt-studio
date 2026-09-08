import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { SHORT_PUBLIC_DIALOGUE_STANDARD } from '../../shared/prompt-standards.js';
import type { StudioModelConfigData } from '../../shared/studio-types.js';
import { requestModelCompletion } from './model-provider.js';

const PROMPT_VERSION = 'v1';
const LOG_DIR = path.join(process.cwd(), 'data');
const LOG_FILE = path.join(LOG_DIR, 'ai-logs.jsonl');

function logAICall(entry: {
  triggerLine: string;
  characterId: string;
  characterName: string;
  promptVersion: string;
  input: { worldSetting: string; persona: string; history: string; newMessages: string };
  output: { rawText: string; action: 'reply' | 'pass' };
  metrics: { tokens: number; latency_ms: number };
}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // 日志失败不影响主流程
  }
}

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const TEMPERATURE = parseSamplingNumber(process.env.DEEPSEEK_TEMPERATURE, 0.95, 0, 2);
const PRESENCE_PENALTY = parseSamplingNumber(process.env.DEEPSEEK_PRESENCE_PENALTY, 0.25, -2, 2);

function parseSamplingNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const GENERATION_SAMPLING = {
  temperature: TEMPERATURE,
  presence_penalty: PRESENCE_PENALTY,
};

const client = new OpenAI({
  apiKey: API_KEY,
  baseURL: BASE_URL,
});

interface CharacterInfo {
  id: string;
  name: string;
  persona: string;
}

interface ChatMessage {
  senderNickname: string;
  isAI: boolean;
  characterId?: string;
  content: string;
  mentions?: string[];
}

interface CharacterReply {
  characterId: string;
  characterName: string;
  reply: string;
}

export interface PromptEvaluationResult {
  id: string;
  label: string;
  characterId?: string;
  characterName?: string;
  reply: string;
  latencyMs: number;
  tokens: number;
  error?: string;
}

export interface PromptBuilderConfig {
  id: string;
  label: string;
  template: string;
  maxSpeakers?: number;
  variableConfig?: {
    taskDescriptions: { chat: string; mention: string; proactive: string };
    outputFormat: string;
    dialogueRules: string;
  };
  worldSetting?: string;
  characters?: CharacterInfo[];
}

export type PromptTrigger = 'chat' | 'mention' | 'proactive';

export interface BuilderEvaluationContext {
  trigger: PromptTrigger;
  targetCharacter: CharacterInfo;
  characters: CharacterInfo[];
  worldSetting: string;
  taskDescription: string;
  outputFormat: string;
  dialogueRules: string;
  recentMessages: ChatMessage[];
  latestMessage: string;
  mentionedNames: string[];
  memoryContext?: string;
  sampling?: {
    modelConfig?: StudioModelConfigData;
    model?: string;
    temperature?: number;
    presencePenalty?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
}

function buildChatHistory(messages: ChatMessage[], maxCount: number): string {
  const recent = messages.slice(-maxCount);
  return recent
    .map((m) => {
      if (m.senderNickname === '系统') return null;
      const prefix = m.isAI ? `[${m.senderNickname}]` : m.senderNickname;
      return `${prefix}: ${m.content}`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildWorldPrompt(worldSetting: string): string {
  return `## 世界观\n${worldSetting}`;
}

function buildCharacterSysPrompt(worldSetting: string, character: CharacterInfo): string {
  return `你现在扮演一个角色进行群聊对话。

${buildWorldPrompt(worldSetting)}

## 你的角色：${character.name}
${character.persona}

## 规则
- 你就是${character.name}，用第一人称说话，保持角色一致性
- 角色已由调度器随机选中，本轮必须回复
- 如果话题关联较弱，给出一句最短的动作、情绪或现场反应
- 回复要简短自然，像真人聊天一样，不要写旁白或动作描述
- 不要重复其他角色说过的话`;
}

function noApiKeyFallback(characters: CharacterInfo[]): Promise<CharacterReply | null>[] {
  return characters.map((c) =>
    Promise.resolve({
      characterId: c.id,
      characterName: c.name,
      reply: '（AI未配置API密钥，请在 .env 文件中配置 DEEPSEEK_API_KEY）',
    }),
  );
}

export async function evaluatePromptPair(input: string, prompts: Array<{ id: string; label: string; prompt: string }>): Promise<PromptEvaluationResult[]> {
  if (!API_KEY) {
    return prompts.map((item) => ({
      id: item.id,
      label: item.label,
      reply: 'AI 未配置 API 密钥，请在 .env 文件中配置 DEEPSEEK_API_KEY。',
      latencyMs: 0,
      tokens: 0,
      error: 'missing_api_key',
    }));
  }

  return Promise.all(prompts.map(async (item) => {
    const startTime = Date.now();
    try {
      const res = await client.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: item.prompt },
            { role: 'user', content: input },
          ],
          max_tokens: 800,
          ...GENERATION_SAMPLING,
        },
        {
          timeout: 30000,
        },
      );

      return {
        id: item.id,
        label: item.label,
        reply: res.choices[0]?.message?.content?.trim() || '',
        latencyMs: Date.now() - startTime,
        tokens: res.usage?.total_tokens || 0,
      };
    } catch (e) {
      console.error(`[AI] prompt evaluation error (${item.label}):`, e);
      return {
        id: item.id,
        label: item.label,
        reply: 'AI 服务暂时不可用，请稍后再试。',
        latencyMs: Date.now() - startTime,
        tokens: 0,
        error: String(e),
      };
    }
  }));
}

function describeOtherCharacters(characters: CharacterInfo[], targetId: string): string {
  return characters
    .filter((character) => character.id !== targetId)
    .map((character) => `${character.name} 的初始人物介绍是：${character.persona}`)
    .join('\n');
}

function renderBuilderTemplate(template: string, context: BuilderEvaluationContext): string {
  const history = buildChatHistory(context.recentMessages, context.recentMessages.length) || '暂无前情。';
  const otherCharacters = describeOtherCharacters(context.characters, context.targetCharacter.id) || '暂无其他角色。';
  const allCharacterNames = context.characters
    .filter((c) => c.id !== context.targetCharacter.id)
    .map((c) => c.name)
    .join('、');

  const replacements: Record<string, string> = {
    roleName: context.targetCharacter.name,
    rolePersona: context.targetCharacter.persona,
    otherCharacters,
    storyBackground: context.worldSetting,
    taskDescription: context.taskDescription,
    outputFormat: context.outputFormat,
    dialogueRules: context.dialogueRules,
    recentMessages: history,
    latestMessage: context.latestMessage,
    trigger: context.trigger,
    mentionedCharacters: context.mentionedNames.join('、') || '无',
    allCharacterNames: allCharacterNames || '暂无其他角色',
    memoryContext: context.memoryContext || '无额外记忆。',
  };

  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{{${key}}}`).join(value);
  }

  return rendered;
}

export async function evaluateBuilderCharacter(
  builder: PromptBuilderConfig,
  context: BuilderEvaluationContext,
): Promise<PromptEvaluationResult> {
  const startTime = Date.now();
  const template = builder.template.trim() || buildFallbackBuilderTemplate();
  const systemPrompt = renderBuilderTemplate(template, context);
  const roleRoster = context.characters
    .map((character) => '- ' + character.name + '：' + character.persona)
    .join('\n');
  const systemPromptWithSharedContext = systemPrompt +
    (builder.id === 'prompt-b' ? SHORT_PUBLIC_DIALOGUE_STANDARD : '') +
    '\n\n## 本轮共享角色配置\n' + roleRoster +
    '\n\n## 本轮触发\n' + context.trigger +
    '\n\n## 本轮消息\n' + context.latestMessage +
    (context.memoryContext
      ? '\n\n' + context.memoryContext +
        '\n\n## 记忆使用规则\n会话记忆中的明确事实优先于角色自行猜测。最新消息若追问物品、地点、时间、归属或已确认事项，先完整、准确答出问题包含的全部事实要素；不要用“几个字”“大概”“记不清”等模糊说法替代已记录信息。记忆只用于承接当前问题，不额外替玩家作决定。'
      : '');

  if (!context.sampling?.modelConfig && !API_KEY) {
    return {
      id: builder.id,
      label: builder.label,
      characterId: context.targetCharacter.id,
      characterName: context.targetCharacter.name,
      reply: 'AI 未配置 API 密钥，请在 .env 文件中配置 DEEPSEEK_API_KEY。',
      latencyMs: 0,
      tokens: 0,
      error: 'missing_api_key',
    };
  }

  try {
    if (context.sampling?.modelConfig) {
      const completion = await requestModelCompletion(context.sampling.modelConfig, [
        { role: 'system', content: systemPromptWithSharedContext },
        { role: 'user', content: '请只以' + context.targetCharacter.name + '的身份完成本轮回复。' },
      ]);
      return {
        id: builder.id,
        label: builder.label,
        characterId: context.targetCharacter.id,
        characterName: context.targetCharacter.name,
        reply: completion.text,
        latencyMs: Date.now() - startTime,
        tokens: completion.totalTokens,
      };
    }
    const res = await client.chat.completions.create(
      {
        model: context.sampling?.model || MODEL,
        messages: [
          { role: 'system', content: systemPromptWithSharedContext },
          { role: 'user', content: '请只以' + context.targetCharacter.name + '的身份完成本轮回复。' },
        ],
        max_tokens: context.sampling?.maxTokens ?? (builder.id === 'prompt-b' ? 240 : 800),
        temperature: context.sampling?.temperature ?? GENERATION_SAMPLING.temperature,
        presence_penalty: context.sampling?.presencePenalty ?? GENERATION_SAMPLING.presence_penalty,
      },
      { timeout: context.sampling?.timeoutMs ?? 30000 },
    );

    return {
      id: builder.id,
      label: builder.label,
      characterId: context.targetCharacter.id,
      characterName: context.targetCharacter.name,
      reply: res.choices[0]?.message?.content?.trim() || '',
      latencyMs: Date.now() - startTime,
      tokens: res.usage?.total_tokens || 0,
    };
  } catch (e) {
    console.error('[AI] builder character evaluation error (' + builder.label + '/' + context.targetCharacter.name + '):', e);
    return {
      id: builder.id,
      label: builder.label,
      characterId: context.targetCharacter.id,
      characterName: context.targetCharacter.name,
      reply: 'AI 服务暂时不可用，请稍后再试。',
      latencyMs: Date.now() - startTime,
      tokens: 0,
      error: String(e),
    };
  }
}

function buildFallbackBuilderTemplate(): string {
  return `【你的身份】
你正在扮演{{roleName}}。
【你的角色介绍】
{{roleName}}的初始人物介绍是：{{rolePersona}}
【其他角色介绍】
{{otherCharacters}}
【故事背景】
{{storyBackground}}
【任务描述】
{{taskDescription}}
【输出格式】
{{outputFormat}}
【对话规则】
{{dialogueRules}}
【特别注意】
你只能以{{roleName}}的视角，扮演{{roleName}}生成回复！
【前情回顾】
{{recentMessages}}
【最新消息】
{{latestMessage}}`;
}

export async function evaluateBuilderPair(
  builders: PromptBuilderConfig[],
  context: { latestMessage: string; recentMessages: ChatMessage[] },
): Promise<PromptEvaluationResult[]> {
  if (!API_KEY) {
    return builders.map((builder) => ({
      id: builder.id,
      label: builder.label,
      reply: 'AI 未配置 API 密钥，请在 .env 文件中配置 DEEPSEEK_API_KEY。',
      latencyMs: 0,
      tokens: 0,
      error: 'missing_api_key',
    }));
  }

  const history = buildChatHistory(context.recentMessages, 30) || '暂无前情。';

  return Promise.all(builders.map(async (builder) => {
    const startTime = Date.now();
    const template = builder.template.trim();
    if (!template) {
      return {
        id: builder.id,
        label: builder.label,
        reply: '',
        latencyMs: 0,
        tokens: 0,
        error: 'empty_template',
      };
    }

    const systemPrompt = template;
    const userPrompt = `## 最近对话\n${history}\n\n## 最新消息\n${context.latestMessage}\n\n请按系统提示词的要求输出回复。`;

    try {
      const res = await client.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 800,
          ...GENERATION_SAMPLING,
        },
        {
          timeout: 30000,
        },
      );

      const text = res.choices[0]?.message?.content?.trim() || '';
      return {
        id: builder.id,
        label: builder.label,
        reply: text,
        latencyMs: Date.now() - startTime,
        tokens: res.usage?.total_tokens || 0,
      };
    } catch (e) {
      console.error(`[AI] builder evaluation error (${builder.label}):`, e);
      return {
        id: builder.id,
        label: builder.label,
        reply: 'AI 服务暂时不可用，请稍后再试。',
        latencyMs: Date.now() - startTime,
        tokens: 0,
        error: String(e),
      };
    }
  }));
}

async function getSingleCharacterReply(
  worldSetting: string,
  character: CharacterInfo,
  historyStr: string,
  newMessagesStr: string,
): Promise<CharacterReply | null> {
  const startTime = Date.now();
  const sysPrompt = buildCharacterSysPrompt(worldSetting, character);

  const userPrompt = `${historyStr ? '## 最近对话\n' + historyStr + '\n\n' : ''}## 最新消息
${newMessagesStr}

作为${character.name}，你已被随机选中，本轮必须直接输出一条简短自然的角色回复。即使关联较弱，也只给出一句最短的现场反应，不要静默。`;

  try {
    const res = await client.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 300,
        ...GENERATION_SAMPLING,
      },
      {
        timeout: 30000, // 30 秒超时
      },
    );

    const text = res.choices[0]?.message?.content?.trim() || '';
    const tokens = res.usage?.total_tokens || 0;
    const isPass = text === '[PASS]' || text.includes('[PASS]') || !text;

    logAICall({
      triggerLine: 'autonomous',
      characterId: character.id,
      characterName: character.name,
      promptVersion: PROMPT_VERSION,
      input: { worldSetting, persona: character.persona, history: historyStr, newMessages: newMessagesStr },
      output: { rawText: text, action: isPass ? 'pass' : 'reply' },
      metrics: { tokens, latency_ms: Date.now() - startTime },
    });

    if (isPass) return null;

    return {
      characterId: character.id,
      characterName: character.name,
      reply: text,
    };
  } catch (e) {
    logAICall({
      triggerLine: 'autonomous',
      characterId: character.id,
      characterName: character.name,
      promptVersion: PROMPT_VERSION,
      input: { worldSetting, persona: character.persona, history: historyStr, newMessages: newMessagesStr },
      output: { rawText: `[ERROR] ${e}`, action: 'pass' },
      metrics: { tokens: 0, latency_ms: Date.now() - startTime },
    });
    console.error(`[AI] ${character.name} reply error:`, e);
    return null;
  }
}

// ─── 发言线1：用户唤起线（全广播，每角色独立自主判断） ───

export function getAutonomousReplies(
  worldSetting: string,
  characters: CharacterInfo[],
  recentMessages: ChatMessage[],
  bundledMessages: ChatMessage[],
): Promise<CharacterReply | null>[] {
  if (!API_KEY) {
    return noApiKeyFallback(characters);
  }

  const historyStr = buildChatHistory(recentMessages, 30);
  const bundledStr = bundledMessages
    .map((m) => `${m.senderNickname}: ${m.content}`)
    .join('\n');

  // 所有角色并行独立判断，返回独立 promise 数组
  return characters.map((char) =>
    getSingleCharacterReply(worldSetting, char, historyStr, bundledStr),
  );
}

// ─── 发言线2：@ 唤起线（指定角色必须回复） ───

export function getMentionReplies(
  worldSetting: string,
  characters: CharacterInfo[],
  mentionedIds: string[],
  recentMessages: ChatMessage[],
  userMessage: ChatMessage,
): Promise<CharacterReply | null>[] {
  const mentionedChars = characters.filter((c) => mentionedIds.includes(c.id));
  if (mentionedChars.length === 0) return [];
  if (!API_KEY) {
    return noApiKeyFallback(mentionedChars);
  }

  const historyStr = buildChatHistory(recentMessages, 30);
  const msgStr = `${userMessage.senderNickname}: ${userMessage.content}`;

  // 被 @ 的角色必须回复，返回独立 promise 数组
  return mentionedChars.map(async (char) => {
    const startTime = Date.now();
    const sysPrompt = buildCharacterSysPrompt(worldSetting, char);
    const prompt = `${historyStr ? '## 最近对话\n' + historyStr + '\n\n' : ''}## 最新消息
${msgStr}

有人直接 @ 了你，你必须回应。直接输出你的回复。`;

    try {
      const res = await client.chat.completions.create(
        {
          model: MODEL,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: prompt },
          ],
          max_tokens: 300,
          ...GENERATION_SAMPLING,
        },
        {
          timeout: 30000,
        },
      );

      const text = res.choices[0]?.message?.content?.trim() || '';
      const tokens = res.usage?.total_tokens || 0;

      logAICall({
        triggerLine: 'mention',
        characterId: char.id,
        characterName: char.name,
        promptVersion: PROMPT_VERSION,
        input: { worldSetting, persona: char.persona, history: historyStr, newMessages: msgStr },
        output: { rawText: text, action: text ? 'reply' : 'pass' },
        metrics: { tokens, latency_ms: Date.now() - startTime },
      });

      if (!text) return null;
      return { characterId: char.id, characterName: char.name, reply: text };
    } catch (e) {
      logAICall({
        triggerLine: 'mention',
        characterId: char.id,
        characterName: char.name,
        promptVersion: PROMPT_VERSION,
        input: { worldSetting, persona: char.persona, history: historyStr, newMessages: msgStr },
        output: { rawText: `[ERROR] ${e}`, action: 'pass' },
        metrics: { tokens: 0, latency_ms: Date.now() - startTime },
      });
      console.error(`[AI] ${char.name} mention reply error:`, e);
      return null;
    }
  });
}

// ─── 发言线3：AI 主动线（衰减式主动发言） ───

export async function getProactiveReply(
  worldSetting: string,
  characters: CharacterInfo[],
  recentMessages: ChatMessage[],
): Promise<CharacterReply | null> {
  if (!API_KEY || characters.length === 0) return null;

  const startTime = Date.now();
  const historyStr = buildChatHistory(recentMessages, 20);

  // 随机选一个角色主动发言
  const char = characters[Math.floor(Math.random() * characters.length)];
  const sysPrompt = buildCharacterSysPrompt(worldSetting, char);

  const prompt = `${historyStr ? '## 最近对话\n' + historyStr + '\n\n' : ''}房间里一段时间没人说话了。作为${char.name}，你可以自然地发起一个新话题、提出问题、或对之前的对话做个延续。不要生硬地说"大家好"或"有人吗"。直接输出你说的话。`;

  try {
    const res = await client.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        ...GENERATION_SAMPLING,
      },
      {
        timeout: 30000,
      },
    );

    const text = res.choices[0]?.message?.content?.trim() || '';
    const tokens = res.usage?.total_tokens || 0;

    logAICall({
      triggerLine: 'proactive',
      characterId: char.id,
      characterName: char.name,
      promptVersion: PROMPT_VERSION,
      input: { worldSetting, persona: char.persona, history: historyStr, newMessages: '' },
      output: { rawText: text, action: text ? 'reply' : 'pass' },
      metrics: { tokens, latency_ms: Date.now() - startTime },
    });

    if (!text) return null;

    return {
      characterId: char.id,
      characterName: char.name,
      reply: text,
    };
  } catch (e) {
    logAICall({
      triggerLine: 'proactive',
      characterId: char.id,
      characterName: char.name,
      promptVersion: PROMPT_VERSION,
      input: { worldSetting, persona: char.persona, history: historyStr, newMessages: '' },
      output: { rawText: `[ERROR] ${e}`, action: 'pass' },
      metrics: { tokens: 0, latency_ms: Date.now() - startTime },
    });
    console.error('[AI] proactive reply error:', e);
    return null;
  }
}
