import OpenAI from 'openai';
import type {
  StudioDebugOmittedParameter,
  StudioModelParameterName,
  StudioModelConfigData,
  StudioDebugSamplingOverrides,
  StudioModelProtocol,
} from '../../shared/studio-types.js';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelCompletion {
  text: string;
  totalTokens: number;
  appliedParameters: Record<string, unknown>;
  omittedParameters: StudioDebugOmittedParameter[];
}

export interface ModelRequestOptions extends StudioDebugSamplingOverrides {
  jsonMode?: boolean;
}

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const modelParameterNames = new Set<StudioModelParameterName>([
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'max_tokens',
  'stop',
]);

function defaultConfig(): StudioModelConfigData {
  return {
    provider: 'DeepSeek',
    protocol: 'openai-compatible',
    messageContentFormat: 'text',
    disabledParameters: [],
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    temperature: numberOr(process.env.DEEPSEEK_TEMPERATURE, 0.95),
    presencePenalty: numberOr(process.env.DEEPSEEK_PRESENCE_PENALTY, 0.25),
    frequencyPenalty: 0,
    topP: 1,
    maxTokens: 240,
    timeoutMs: 30000,
  };
}

const blockedExtraHeaders = new Set([
  'authorization',
  'cookie',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'x-api-key',
  'anthropic-version',
]);

function normalizeExtraHeaders(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const normalizedName = name.trim();
    const normalizedValue = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z0-9-]+$/.test(normalizedName) || blockedExtraHeaders.has(normalizedName.toLowerCase()) || !normalizedValue || !/^[\x20-\x7E]*$/.test(normalizedValue)) continue;
    if (normalizedName.length > 128 || normalizedValue.length > 2000) continue;
    headers[normalizedName] = normalizedValue;
  }
  return headers;
}

export function normalizeModelConfig(input?: StudioModelConfigData): StudioModelConfigData {
  const fallback = defaultConfig();
  const configured = input ?? fallback;
  const provider = configured.provider?.trim() || fallback.provider;
  const isDeepSeekLegacy = !configured.apiKeyEnv && !configured.apiKey && /deepseek/i.test(provider);
  return {
    ...fallback,
    ...configured,
    provider,
    protocol: configured.protocol === 'anthropic-messages' || configured.protocol === 'cloudsway-chat-completions'
      ? configured.protocol
      : 'openai-compatible',
    messageContentFormat: configured.messageContentFormat === 'text-parts' ? 'text-parts' : 'text',
    disabledParameters: Array.isArray(configured.disabledParameters)
      ? configured.disabledParameters.filter((item): item is StudioModelParameterName => typeof item === 'string' && modelParameterNames.has(item as StudioModelParameterName))
      : [],
    baseUrl: configured.baseUrl?.trim() || (isDeepSeekLegacy ? fallback.baseUrl : ''),
    apiKeyEnv: configured.apiKeyEnv?.trim() || (isDeepSeekLegacy ? 'DEEPSEEK_API_KEY' : ''),
    model: configured.model?.trim() || fallback.model,
    temperature: numberOr(configured.temperature, fallback.temperature),
    presencePenalty: numberOr(configured.presencePenalty, 0),
    frequencyPenalty: numberOr(configured.frequencyPenalty, 0),
    topP: configured.topP == null ? fallback.topP : numberOr(configured.topP, fallback.topP),
    maxTokens: Math.max(1, Math.floor(numberOr(configured.maxTokens, fallback.maxTokens))),
    timeoutMs: Math.max(1000, Math.floor(numberOr(configured.timeoutMs, fallback.timeoutMs))),
    stopSequences: Array.isArray(configured.stopSequences)
      ? configured.stopSequences.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 16)
      : [],
    extraParameters: configured.extraParameters && typeof configured.extraParameters === 'object'
      ? configured.extraParameters
      : {},
    extraHeaders: normalizeExtraHeaders(configured.extraHeaders),
  };
}

function resolveApiKey(config: StudioModelConfigData) {
  const storedKey = config.apiKey?.trim();
  if (config.credentialSource === 'stored') {
    if (storedKey) return storedKey;
    throw new Error(`模型“${config.model}”未配置卡片加密密钥`);
  }
  if (storedKey && config.credentialSource !== 'environment') return storedKey;
  const keyName = config.apiKeyEnv?.trim() || '';
  if (!/^[A-Z][A-Z0-9_]*$/.test(keyName)) {
    throw new Error(`模型“${config.model}”缺少有效的 API Key 或服务器环境变量名`);
  }
  const key = process.env[keyName];
  if (!key) throw new Error(`模型“${config.model}”未配置 ${keyName}`);
  return key;
}

function addParameter(
  applied: Record<string, unknown>,
  omitted: StudioDebugOmittedParameter[],
  key: string,
  value: unknown,
  supported: boolean,
  reason: string,
) {
  if (value == null) return;
  if (supported) applied[key] = value;
  else omitted.push({ key, reason });
}

function parameterDecision(
  config: StudioModelConfigData,
  protocol: StudioModelProtocol,
  key: StudioModelParameterName,
) {
  if (config.disabledParameters?.includes(key)) {
    return { supported: false, reason: '模型卡配置为不发送该参数' };
  }
  if (key === 'top_k' && (protocol === 'openai-compatible' || protocol === 'cloudsway-chat-completions')) {
    return { supported: false, reason: 'OpenAI 兼容接口通常不接受 top_k，请放入供应商专属参数后按需启用' };
  }
  if ((key === 'presence_penalty' || key === 'frequency_penalty') && protocol === 'anthropic-messages') {
    return { supported: false, reason: 'Anthropic Messages 不支持该参数' };
  }
  return { supported: true, reason: '当前协议不支持该参数' };
}

function buildSampling(
  config: StudioModelConfigData,
  options: ModelRequestOptions,
  protocol: StudioModelProtocol,
) {
  const applied: Record<string, unknown> = {};
  const omitted: StudioDebugOmittedParameter[] = [];
  const temperature = options.temperature ?? config.temperature;
  const topP = options.topP ?? config.topP;
  const topK = options.topK ?? config.topK;
  const presencePenalty = options.presencePenalty ?? config.presencePenalty;
  const frequencyPenalty = options.frequencyPenalty ?? config.frequencyPenalty;
  const maxTokens = options.maxTokens ?? config.maxTokens;
  const stopSequences = options.stopSequences ?? config.stopSequences;

  const temperatureDecision = parameterDecision(config, protocol, 'temperature');
  const topPDecision = parameterDecision(config, protocol, 'top_p');
  const topKDecision = parameterDecision(config, protocol, 'top_k');
  const presencePenaltyDecision = parameterDecision(config, protocol, 'presence_penalty');
  const frequencyPenaltyDecision = parameterDecision(config, protocol, 'frequency_penalty');
  const maxTokensDecision = parameterDecision(config, protocol, 'max_tokens');
  const stopDecision = parameterDecision(config, protocol, 'stop');
  addParameter(applied, omitted, 'temperature', temperature, temperatureDecision.supported, temperatureDecision.reason);
  addParameter(applied, omitted, 'top_p', topP, topPDecision.supported, topPDecision.reason);
  addParameter(applied, omitted, 'top_k', topK, topKDecision.supported, topKDecision.reason);
  addParameter(applied, omitted, 'presence_penalty', presencePenalty, presencePenaltyDecision.supported, presencePenaltyDecision.reason);
  addParameter(applied, omitted, 'frequency_penalty', frequencyPenalty, frequencyPenaltyDecision.supported, frequencyPenaltyDecision.reason);
  addParameter(applied, omitted, 'max_tokens', maxTokens, maxTokensDecision.supported, maxTokensDecision.reason);
  addParameter(applied, omitted, protocol === 'anthropic-messages' ? 'stop_sequences' : 'stop', stopSequences?.length ? stopSequences : undefined, stopDecision.supported, stopDecision.reason);

  const extraParameters = { ...(config.extraParameters ?? {}), ...(options.extraParameters ?? {}) };
  const reserved = new Set([
    'model', 'messages', 'system', 'stream', 'max_tokens', 'temperature', 'top_p', 'top_k',
    'presence_penalty', 'frequency_penalty', 'stop', 'stop_sequences', 'response_format',
  ]);
  const anthropicUnsupported = new Set(['presence_penalty', 'frequency_penalty', 'response_format', 'stop']);
  for (const [key, value] of Object.entries(extraParameters)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || reserved.has(key)) {
      omitted.push({ key, reason: '该字段属于平台保留参数或参数名不合法' });
      continue;
    }
    if (protocol === 'anthropic-messages' && anthropicUnsupported.has(key)) {
      omitted.push({ key, reason: 'Anthropic Messages 不支持该参数' });
      continue;
    }
    applied[key] = value;
  }
  return { applied, omitted };
}

function formatOpenAiMessages(messages: ModelMessage[], contentFormat: StudioModelConfigData['messageContentFormat']) {
  if (contentFormat !== 'text-parts') return messages;
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }));
}

function formatCloudswayMessages(messages: ModelMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }));
}

function extractMessageText(content: unknown) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        return (item as { text: string }).text;
      }
      return '';
    }).join('');
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  return '';
}

interface ChatCompletionsPayload {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

function errorMessage(payload: ChatCompletionsPayload, fallback: string) {
  if (typeof payload.error === 'string') return payload.error;
  return payload.error?.message || fallback;
}

function chatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

async function requestCloudswayCompletion(
  config: StudioModelConfigData,
  key: string,
  messages: ModelMessage[],
  sampling: ReturnType<typeof buildSampling>,
  options: ModelRequestOptions,
): Promise<ModelCompletion> {
  if (options.jsonMode) {
    sampling.omitted.push({ key: 'response_format', reason: 'Cloudsway 专用协议不声明 OpenAI response_format；请在 Prompt 中要求 JSON' });
  }
  const appliedParameters = {
    ...sampling.applied,
    stream_options: { include_usage: true },
  };
  const body: Record<string, unknown> = {
    messages: formatCloudswayMessages(messages),
    model: config.model,
    ...sampling.applied,
    stream_options: { include_usage: true },
  };
  const response = await fetch(chatCompletionsUrl(config.baseUrl!), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const raw = await response.text();
  let payload: ChatCompletionsPayload = {};
  try {
    payload = JSON.parse(raw) as ChatCompletionsPayload;
  } catch {
    if (!response.ok) throw new Error(`Cloudsway 请求失败 (${response.status})：${raw.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(errorMessage(payload, `Cloudsway 请求失败 (${response.status})`));
  return {
    text: extractMessageText(payload.choices?.[0]?.message?.content).trim(),
    totalTokens: payload.usage?.total_tokens ?? (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
    appliedParameters,
    omittedParameters: sampling.omitted,
  };
}

export async function requestModelCompletion(
  input: StudioModelConfigData | undefined,
  messages: ModelMessage[],
  options: ModelRequestOptions = {},
): Promise<ModelCompletion> {
  const config = normalizeModelConfig(input);
  const key = resolveApiKey(config);
  if (!config.baseUrl) throw new Error(`模型“${config.model}”缺少 API Base URL`);
  const sampling = buildSampling(config, options, config.protocol!);

  if (config.protocol === 'anthropic-messages') {
    const system = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n');
    const userMessages = messages.filter((item) => item.role !== 'system').map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.content,
    }));
    const body: Record<string, unknown> = {
      model: config.model,
      system,
      messages: userMessages,
      ...sampling.applied,
    };
    if (options.jsonMode) sampling.omitted.push({ key: 'response_format', reason: 'Anthropic Messages 不支持 OpenAI response_format；请在 Prompt 中要求 JSON' });
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const payload = await response.json() as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `Anthropic 请求失败 (${response.status})`);
    return {
      text: payload.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('').trim() || '',
      totalTokens: (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
      appliedParameters: sampling.applied,
      omittedParameters: sampling.omitted,
    };
  }

  if (config.protocol === 'cloudsway-chat-completions') {
    return requestCloudswayCompletion(config, key, messages, sampling, options);
  }

  const client = new OpenAI({ apiKey: key, baseURL: config.baseUrl, defaultHeaders: config.extraHeaders });
  const request: Record<string, unknown> = {
    model: config.model,
    messages: formatOpenAiMessages(messages, config.messageContentFormat),
    stream: false,
    ...sampling.applied,
  };
  if (options.jsonMode) request.response_format = { type: 'json_object' };
  const response = await client.chat.completions.create(request as unknown as Parameters<typeof client.chat.completions.create>[0], { timeout: config.timeoutMs });
  if (!('choices' in response)) throw new Error('模型返回了未预期的流式响应');
  return {
    text: response.choices[0]?.message?.content?.trim() || '',
    totalTokens: response.usage?.total_tokens ?? 0,
    appliedParameters: { ...sampling.applied, ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}) },
    omittedParameters: sampling.omitted,
  };
}
