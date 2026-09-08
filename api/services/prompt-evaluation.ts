import OpenAI from 'openai';
import type { PromptBuilderItem, PromptEvaluationCaseResult, PromptEvaluationRawData, PromptQualityDimensions, PromptTestSuite } from '../../shared/types.js';
import type { StudioModelConfigData, StudioScorecardData } from '../../shared/studio-types.js';
import { evaluateBuilderCharacter } from './ai.js';
import { getConfig } from './config-store.js';
import { requestModelCompletion } from './model-provider.js';

const apiKey = process.env.DEEPSEEK_API_KEY || '';
const baseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const client = new OpenAI({ apiKey, baseURL });

const maximum: PromptQualityDimensions = { instruction: 15, relevance: 10, agency: 15, logic: 15, interest: 10, persona: 15, tone: 5, world: 5, group: 5, style: 5 };
const emptyDimensions: PromptQualityDimensions = { instruction: 0, relevance: 0, agency: 0, logic: 0, interest: 0, persona: 0, tone: 0, world: 0, group: 0, style: 0 };

function dimensionMaximum(scorecard?: StudioScorecardData): PromptQualityDimensions {
  if (!scorecard?.dimensions?.length) return maximum;
  const result = { ...maximum };
  for (const dimension of scorecard.dimensions) {
    if (dimension.key in result && Number.isFinite(dimension.weight)) {
      result[dimension.key] = Math.max(1, Math.round(dimension.weight));
    }
  }
  return result;
}

function safeDimensions(value: unknown, limits: PromptQualityDimensions): PromptQualityDimensions {
  const input = value as Partial<PromptQualityDimensions> | null;
  const result = { ...emptyDimensions };
  for (const key of Object.keys(limits) as Array<keyof PromptQualityDimensions>) {
    const number = Number(input?.[key]);
    result[key] = Number.isFinite(number) ? Math.max(0, Math.min(limits[key], Math.round(number))) : 0;
  }
  return result;
}

function averageDimensions(cases: PromptEvaluationCaseResult[]): PromptQualityDimensions {
  const scoredCases = cases.filter((item) => item.dimensions !== null);
  if (!scoredCases.length) return { ...emptyDimensions };
  const result = { ...emptyDimensions };
  for (const key of Object.keys(result) as Array<keyof PromptQualityDimensions>) {
    result[key] = Math.round(scoredCases.reduce((sum, item) => sum + item.dimensions![key], 0) / scoredCases.length * 10) / 10;
  }
  return result;
}

function parseJson(raw: string) {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch {
    // 兼容模型在 JSON 前后附带说明文字的情况，按字符串状态寻找完整对象。
    for (let start = normalized.indexOf('{'); start >= 0; start = normalized.indexOf('{', start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < normalized.length; index += 1) {
        const char = normalized[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) {
          try {
            return JSON.parse(normalized.slice(start, index + 1)) as Record<string, unknown>;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error('评分模型返回了无法解析的 JSON');
}

function validateJudgePayload(parsed: Record<string, unknown>) {
  const dimensions = parsed.dimensions as Record<string, unknown> | null;
  const complete = dimensions
    && Object.keys(maximum).every((key) => Number.isFinite(Number(dimensions[key])));
  if (!complete) throw new Error('评分模型返回的十维字段不完整');
  if (typeof parsed.rationale !== 'string' || !parsed.rationale.trim()) {
    throw new Error('评分模型未返回评分依据');
  }
}

async function requestJudgeCompletion(prompt: string, jsonMode: boolean, modelConfig?: StudioModelConfigData) {
  if (modelConfig) {
    const result = await requestModelCompletion(modelConfig, [
      { role: 'system', content: '只输出合法 JSON，不要 Markdown，不要解释文字。' },
      { role: 'user', content: prompt },
    ], { jsonMode, temperature: 0.1, maxTokens: 500 });
    return result.text;
  }
  const request: Parameters<typeof client.chat.completions.create>[0] = {
    model,
    messages: [
      { role: 'system', content: '只输出合法 JSON，不要 Markdown，不要解释文字。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 500,
    stream: false,
  };
  if (jsonMode) request.response_format = { type: 'json_object' };
  const result = await client.chat.completions.create(request, { timeout: 30000 });
  if (!('choices' in result)) throw new Error('评分模型返回了流式结果');
  return result.choices[0]?.message?.content?.trim() || '';
}

async function judgeResponse(
  worldSetting: string,
  testCase: PromptTestSuite['cases'][number],
  response: string,
  scorecard?: StudioScorecardData,
  judgeModelConfig?: StudioModelConfigData,
): Promise<{ score: Omit<PromptEvaluationCaseResult, 'caseId' | 'title' | 'input' | 'response' | 'rawData'>; rawResponse: string }> {
  const limits = dimensionMaximum(scorecard);
  const dimensionLines = scorecard?.dimensions?.length
    ? scorecard.dimensions.map((item) => `- ${item.key} ${item.weight}：${item.label}；${item.description}`).join('\n')
    : `- instruction 15：玩家指令遵循
- relevance 10：当前相关性与连续性
- agency 15：玩家行动权，不替玩家决定或行动
- logic 15：剧情发展合理性，时间地点因果自洽
- interest 10：剧情发展有趣性，有可接续变化但不抢戏
- persona 15：人设遵循与角色边界，不替其他角色发言
- tone 5：语气与风格差异化
- world 5：世界观遵循，不无依据扩张设定
- group 5：群像协作，不组织 NPC 自转剧情
- style 5：表达与节奏，短且清晰`;
  const blockingDefects = scorecard?.blockingDefects?.length
    ? scorecard.blockingDefects.join('、')
    : '冒充玩家、替玩家关键决定、替未发言角色确认意愿、明显违背世界规则';
  const prompt = `你是多人角色对话的严格评审。只根据下方评分标准评估 AI 回复，不要因为文风华丽额外加分。

世界观：
${worldSetting}

测试输入：
${testCase.input}

期望行为：
${testCase.expected}

AI 回复：
${response}

评分维度与满分：
${dimensionLines}

一票否决：${blockingDefects}，必须在 defects 中标记，并相应大幅扣分。

只返回 JSON：
{"dimensions":{"instruction":0,"relevance":0,"agency":0,"logic":0,"interest":0,"persona":0,"tone":0,"world":0,"group":0,"style":0},"defects":[""],"rationale":"不超过60字的依据"}`;
  let parsed: Record<string, unknown>;
  let rawResponse = '';
  try {
    rawResponse = await requestJudgeCompletion(prompt, true, judgeModelConfig);
    parsed = parseJson(rawResponse);
    validateJudgePayload(parsed);
  } catch (firstError) {
    // 有些兼容 OpenAI 的服务不支持 response_format，退回普通请求并重试一次。
    const retryPrompt = `${prompt}\n\n这是一次格式重试。请严格返回单个 JSON 对象，所有文字值必须使用双引号并正确转义。`;
    try {
      rawResponse = await requestJudgeCompletion(retryPrompt, false, judgeModelConfig);
      parsed = parseJson(rawResponse);
      validateJudgePayload(parsed);
    } catch (secondError) {
      throw new Error(`评分模型调用或格式异常：${String(secondError || firstError).slice(0, 180)}`);
    }
  }
  const dimensions = safeDimensions(parsed.dimensions, limits);
  return {
    score: { dimensions, total: Object.values(dimensions).reduce((sum, value) => sum + value, 0), defects: Array.isArray(parsed.defects) ? parsed.defects.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 6) : [], rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 160) : '' },
    rawResponse,
  };
}

export async function runPromptQualityEvaluation(
  builder: PromptBuilderItem,
  suite: PromptTestSuite,
  options: {
    characters?: Array<{ id: string; name: string; persona: string }>;
    worldSetting?: string;
    modelConfig?: StudioModelConfigData;
    judgeModelConfig?: StudioModelConfigData;
    scorecard?: StudioScorecardData;
  } = {},
): Promise<{ cases: PromptEvaluationCaseResult[]; dimensions: PromptQualityDimensions; responseValidity: number; averageLength: number; notes: string[] }> {
  if (!apiKey && !options.modelConfig) throw new Error('未配置可用的模型 API Key，无法执行 AI 评测');
  const config = getConfig();
  const characters = options.characters?.length
    ? options.characters
    : builder.characters?.length
      ? builder.characters
      : config.characters;
  const target = characters[0];
  if (!target) throw new Error('评测需要至少一个角色');
  const variables = builder.variableConfig;
  const worldSetting = options.worldSetting ?? builder.worldSetting ?? config.worldSetting;
  const cases: PromptEvaluationCaseResult[] = [];
  for (const testCase of suite.cases) {
    const generationContext = {
      trigger: 'chat' as const, targetCharacter: target, characters,
      worldSetting,
      taskDescription: variables?.taskDescriptions.chat || '直接回应最新玩家消息，只输出一条角色回复。',
      outputFormat: variables?.outputFormat || '只输出一条角色回复。',
      dialogueRules: variables?.dialogueRules || '不要代替玩家或其他角色发言。',
      recentMessages: [], latestMessage: `玩家：${testCase.input}`, mentionedNames: [],
      sampling: options.modelConfig ? {
        modelConfig: options.modelConfig,
        model: options.modelConfig.model,
        temperature: options.modelConfig.temperature,
        presencePenalty: options.modelConfig.presencePenalty,
        maxTokens: options.modelConfig.maxTokens,
        timeoutMs: options.modelConfig.timeoutMs,
      } : undefined,
    };
    const response = await evaluateBuilderCharacter(builder, generationContext);
    const text = response.reply.trim();
    const rawData: PromptEvaluationRawData = {
      generationRequest: {
        template: builder.template,
        roleName: target.name,
        rolePersona: target.persona,
        otherCharacters: characters.filter((character) => character.id !== target.id).map((character) => `${character.name}：${character.persona}`).join('\n'),
        worldSetting: generationContext.worldSetting,
        taskDescription: generationContext.taskDescription,
        outputFormat: generationContext.outputFormat,
        dialogueRules: generationContext.dialogueRules,
        recentMessages: [],
        latestMessage: generationContext.latestMessage,
        mentionedNames: [],
      },
      generationResponse: text,
      ...(response.error ? { generationError: response.error } : {}),
    };
    if (!text || response.error) {
      cases.push({ caseId: testCase.id, title: testCase.title, input: testCase.input, response: text || '（未生成有效回复）', total: null, dimensions: null, defects: [response.error ? '模型服务不可用' : '空回复'], rationale: '无法生成可评估回复。', rawData });
      continue;
    }
    try {
      const judged = await judgeResponse(worldSetting, testCase, text, options.scorecard, options.judgeModelConfig);
      cases.push({ caseId: testCase.id, title: testCase.title, input: testCase.input, response: text, ...judged.score, rawData: { ...rawData, judgeRequest: { worldSetting, input: testCase.input, expected: testCase.expected, response: text }, judgeResponse: judged.rawResponse } });
    } catch (error) {
      cases.push({ caseId: testCase.id, title: testCase.title, input: testCase.input, response: text, total: null, dimensions: null, defects: ['评审模型不可用'], rationale: `需要人工复核：${String(error).slice(0, 100)}`, rawData: { ...rawData, judgeRequest: { worldSetting, input: testCase.input, expected: testCase.expected, response: text } } });
    }
  }
  const valid = cases.filter((item) => item.response !== '（未生成有效回复）' && !item.defects.includes('模型服务不可用'));
  return {
    cases,
    dimensions: averageDimensions(cases),
    responseValidity: Math.round(valid.length / Math.max(1, cases.length) * 100),
    averageLength: valid.length ? Math.round(valid.reduce((sum, item) => sum + item.response.length, 0) / valid.length) : 0,
    notes: [`本次独立评测 ${cases.length} 轮；每轮 1 次生成、1 次评分。`, valid.length === cases.length ? '所有测试用例均生成了可评估回复。' : `${cases.length - valid.length} 条测试回复未生成或服务失败。`, '自动评分用于排序和筛选案例；发布前仍应人工复核低分和高风险缺陷。'],
  };
}
