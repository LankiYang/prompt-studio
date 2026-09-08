import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  StudioCreateResourceInput,
  StudioResource,
  StudioResourceKind,
  StudioScoreDimension,
  StudioModelParameterName,
} from '../../../shared/studio-types';
import type { PromptQualityDimensions, PromptTestCase } from '../../../shared/types';

const editableKinds: Array<{ value: StudioResourceKind; label: string }> = [
  { value: 'character', label: '角色' },
  { value: 'world', label: '世界观' },
  { value: 'test-suite', label: '测试集' },
  { value: 'scorecard', label: '评分卡' },
  { value: 'model-config', label: '模型卡' },
  { value: 'scheduler-policy', label: '调度策略' },
  { value: 'memory-policy', label: '记忆策略' },
];

const standardDimensions: StudioScoreDimension[] = [
  ['instruction', '玩家指令遵循', 15],
  ['relevance', '相关性与连续性', 10],
  ['agency', '玩家行动权', 15],
  ['logic', '剧情合理性', 15],
  ['interest', '剧情有趣性', 10],
  ['persona', '人设与角色边界', 15],
  ['tone', '语气风格差异', 5],
  ['world', '世界观遵循', 5],
  ['group', '群像协作', 5],
  ['style', '表达与节奏', 5],
].map(([key, label, weight]) => ({
  key: key as keyof PromptQualityDimensions,
  label: String(label),
  weight: Number(weight),
  description: '',
}));

const modelParameterOptions: Array<{ value: StudioModelParameterName; label: string }> = [
  { value: 'temperature', label: 'Temperature' },
  { value: 'top_p', label: 'Top P' },
  { value: 'top_k', label: 'Top K' },
  { value: 'presence_penalty', label: 'Presence penalty' },
  { value: 'frequency_penalty', label: 'Frequency penalty' },
  { value: 'max_tokens', label: 'Max tokens' },
  { value: 'stop', label: 'Stop sequences' },
];

function defaultData(kind: StudioResourceKind): Record<string, unknown> {
  if (kind === 'character') return { name: '', persona: '' };
  if (kind === 'world') return { content: '' };
  if (kind === 'test-suite') return { cases: [] };
  if (kind === 'scorecard') {
    return {
      passScore: 75,
      blockingDefects: [],
      dimensions: standardDimensions,
    };
  }
  if (kind === 'model-config') {
    return {
      provider: 'DeepSeek Compatible API',
      protocol: 'openai-compatible',
      messageContentFormat: 'text',
      disabledParameters: [],
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      model: 'deepseek-v4-flash',
      temperature: 0.95,
      topP: 1,
      topK: undefined,
      presencePenalty: 0.25,
      frequencyPenalty: 0,
      maxTokens: 240,
      timeoutMs: 30000,
      stopSequences: [],
      extraParameters: {},
      credentialSource: 'environment',
    };
  }
  if (kind === 'scheduler-policy') {
    return {
      historyRounds: 5,
      maxSpeakers: 3,
      executionMode: 'parallel',
      bundleWindowMs: 3000,
      mentionEnabled: true,
      proactiveEnabled: true,
      proactiveIntervalsSeconds: [15, 30],
    };
  }
  return {
    enabled: false,
    updateEveryTurns: 10,
    retrievalLimit: 5,
    injectManualMemory: true,
    injectAutoMemory: true,
  };
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="studio-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function ResourceEditor({
  initial,
  initialKind = 'character',
  onSave,
  onCancel,
}: {
  initial?: StudioResource;
  initialKind?: StudioResourceKind;
  onSave: (input: StudioCreateResourceInput | Partial<StudioResource>) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<StudioResourceKind>(initial?.kind ?? initialKind);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [owner, setOwner] = useState(initial?.owner ?? '团队成员');
  const [tags, setTags] = useState(initial?.tags.join('，') ?? '');
  const [data, setData] = useState<Record<string, unknown>>(
    initial?.data ?? defaultData(initialKind),
  );
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [extraParametersText, setExtraParametersText] = useState(() => JSON.stringify(initial?.data?.extraParameters ?? {}, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const cases = useMemo(
    () => (Array.isArray(data.cases) ? data.cases : []) as PromptTestCase[],
    [data.cases],
  );
  const dimensions = useMemo(
    () => (Array.isArray(data.dimensions) ? data.dimensions : standardDimensions) as StudioScoreDimension[],
    [data.dimensions],
  );
  const disabledParameters = useMemo(
    () => (Array.isArray(data.disabledParameters) ? data.disabledParameters : []) as StudioModelParameterName[],
    [data.disabledParameters],
  );

  function switchKind(next: StudioResourceKind) {
    setKind(next);
    setData(defaultData(next));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('请填写资源名称');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const nextData = { ...data };
      if (kind === 'model-config') {
        if (apiKeyDraft.trim()) nextData.apiKey = apiKeyDraft.trim();
        if (clearApiKey) nextData.clearApiKey = true;
        try {
          const parsed = JSON.parse(extraParametersText || '{}');
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('其他参数必须是 JSON 对象');
          nextData.extraParameters = parsed;
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : '其他参数 JSON 格式不正确');
          setSaving(false);
          return;
        }
      }
      await onSave({
        ...(initial ? {} : { kind }),
        name: name.trim(),
        description,
        owner,
        tags: tags.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
        data: nextData,
      } as StudioCreateResourceInput);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  function patchData(key: string, value: unknown) {
    setData((current) => ({ ...current, [key]: value }));
  }

  function addCase() {
    const next: PromptTestCase = {
      id: `case-${Date.now()}`,
      title: '新测试案例',
      category: '未分类',
      input: '',
      expected: '',
      labels: [],
    };
    patchData('cases', [...cases, next]);
  }

  function patchCase(index: number, patch: Partial<PromptTestCase>) {
    patchData('cases', cases.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  return (
    <form className="studio-form" onSubmit={submit}>
      <div className="studio-form-grid">
        {!initial && (
          <Field label="资源类型">
            <select value={kind} onChange={(event) => switchKind(event.target.value as StudioResourceKind)}>
              {editableKinds.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="名称">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
        </Field>
        <Field label="负责人">
          <input value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={40} />
        </Field>
        <Field label="标签" hint="用逗号分隔">
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </Field>
      </div>
      <Field label="说明">
        <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>

      <div className="studio-form-section">
        <h3>类型配置</h3>
        {kind === 'character' && (
          <>
            <Field label="角色显示名">
              <input value={text(data.name)} onChange={(event) => patchData('name', event.target.value)} />
            </Field>
            <Field label="角色人设" hint="包含稳定身份、性格、说话方式、边界和已知事实。">
              <textarea rows={8} value={text(data.persona)} onChange={(event) => patchData('persona', event.target.value)} />
            </Field>
          </>
        )}

        {kind === 'world' && (
          <Field label="世界观正文" hint="写明时间、地点、物理规则、阵营与禁止扩张的设定。">
            <textarea rows={13} value={text(data.content)} onChange={(event) => patchData('content', event.target.value)} />
          </Field>
        )}

        {kind === 'test-suite' && (
          <div className="studio-case-editor">
            <div className="studio-inline-heading">
              <div>
                <strong>测试案例</strong>
                <span>{cases.length} 条</span>
              </div>
              <button type="button" className="studio-button secondary small" onClick={addCase}>
                <Plus size={14} />新增案例
              </button>
            </div>
            {cases.map((item, index) => (
              <section className="studio-case-edit-row" key={item.id}>
                <div className="studio-case-edit-head">
                  <strong>{index + 1}</strong>
                  <input value={item.title} onChange={(event) => patchCase(index, { title: event.target.value })} aria-label="案例标题" />
                  <button
                    type="button"
                    className="studio-icon-button danger"
                    title="删除案例"
                    onClick={() => patchData('cases', cases.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="studio-form-grid">
                  <Field label="分类">
                    <input value={item.category} onChange={(event) => patchCase(index, { category: event.target.value })} />
                  </Field>
                  <Field label="标签">
                    <input
                      value={item.labels.join('，')}
                      onChange={(event) => patchCase(index, {
                        labels: event.target.value.split(/[，,]/).map((value) => value.trim()).filter(Boolean),
                      })}
                    />
                  </Field>
                </div>
                <Field label="输入">
                  <textarea rows={2} value={item.input} onChange={(event) => patchCase(index, { input: event.target.value })} />
                </Field>
                <Field label="期望行为">
                  <textarea rows={2} value={item.expected} onChange={(event) => patchCase(index, { expected: event.target.value })} />
                </Field>
              </section>
            ))}
            {!cases.length && <div className="studio-empty compact">暂无案例。至少添加一条后才能创建评测。</div>}
          </div>
        )}

        {kind === 'scorecard' && (
          <>
            <div className="studio-form-grid">
              <Field label="通过分">
                <input type="number" min={0} max={100} value={number(data.passScore, 75)} onChange={(event) => patchData('passScore', number(event.target.value))} />
              </Field>
              <Field label="一票否决缺陷" hint="用逗号分隔">
                <input
                  value={Array.isArray(data.blockingDefects) ? data.blockingDefects.join('，') : ''}
                  onChange={(event) => patchData('blockingDefects', event.target.value.split(/[，,]/).map((value) => value.trim()).filter(Boolean))}
                />
              </Field>
            </div>
            <div className="studio-dimension-editor">
              {dimensions.map((item, index) => (
                <div key={item.key}>
                  <span>{item.label}</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={item.weight}
                    aria-label={`${item.label}权重`}
                    onChange={(event) => patchData('dimensions', dimensions.map((dimension, dimensionIndex) =>
                      dimensionIndex === index ? { ...dimension, weight: number(event.target.value, 1) } : dimension))}
                  />
                  <input
                    value={item.description}
                    placeholder="评分锚点"
                    aria-label={`${item.label}说明`}
                    onChange={(event) => patchData('dimensions', dimensions.map((dimension, dimensionIndex) =>
                      dimensionIndex === index ? { ...dimension, description: event.target.value } : dimension))}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        {kind === 'model-config' && (
          <>
            <div className="studio-form-grid">
              <Field label="供应商">
                <select value={text(data.provider)} onChange={(event) => {
                  const provider = event.target.value;
                  const presets: Record<string, Record<string, unknown>> = {
                    'DeepSeek Compatible API': { protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY', credentialSource: 'environment' },
                    OpenAI: { protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
                    '阿里云百炼 / Qwen': { protocol: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
                    SiliconFlow: { protocol: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY' },
                    Moonshot: { protocol: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
                    Anthropic: { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
                    'Cloudsway GenAI': {
                      protocol: 'openai-compatible',
                      baseUrl: 'https://genaiapi.cloudsway.net/v1',
                      apiKeyEnv: 'CLOUDSWAY_API_KEY',
                      model: 'MaaS_Cl_sonnet_4.5_20250929',
                      messageContentFormat: 'text-parts',
                      disabledParameters: ['presence_penalty', 'frequency_penalty'],
                      extraParameters: { stream_options: { include_usage: true } },
                      credentialSource: 'environment',
                    },
                    'OpenAI 兼容服务': { protocol: 'openai-compatible', baseUrl: '', apiKeyEnv: '' },
                  };
                  setData((current) => ({ ...current, provider, ...(presets[provider] ?? {}) }));
                }}>
                  {['DeepSeek Compatible API', 'OpenAI', '阿里云百炼 / Qwen', 'SiliconFlow', 'Moonshot', 'Anthropic', 'Cloudsway GenAI', 'OpenAI 兼容服务'].map((provider) => <option value={provider} key={provider}>{provider}</option>)}
                </select>
              </Field>
              <Field label="调用协议">
                <select value={text(data.protocol) || 'openai-compatible'} onChange={(event) => patchData('protocol', event.target.value)}>
                  <option value="openai-compatible">OpenAI 兼容 Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </select>
              </Field>
              <Field label="消息内容格式" hint="供应商示例使用文本块数组时选择“文本块数组”。">
                <select value={text(data.messageContentFormat) || 'text'} onChange={(event) => patchData('messageContentFormat', event.target.value)}>
                  <option value="text">纯文本字符串</option>
                  <option value="text-parts">文本块数组</option>
                </select>
              </Field>
              <Field label="模型">
                <input value={text(data.model)} onChange={(event) => patchData('model', event.target.value)} />
              </Field>
              <Field label="API Base URL">
                <input value={text(data.baseUrl)} onChange={(event) => patchData('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" />
              </Field>
              <Field label="密钥来源">
                <select value={text(data.credentialSource) || 'environment'} onChange={(event) => patchData('credentialSource', event.target.value)}>
                  <option value="environment">服务端环境变量</option>
                  <option value="stored">模型卡密钥</option>
                </select>
              </Field>
              {text(data.credentialSource) !== 'stored' && <Field label="服务端密钥环境变量" hint="例如 OPENAI_API_KEY；密钥名会进入模型卡，密钥本身不进入浏览器">
                <input value={text(data.apiKeyEnv)} onChange={(event) => patchData('apiKeyEnv', event.target.value.toUpperCase())} placeholder="OPENAI_API_KEY" />
              </Field>}
              {text(data.credentialSource) === 'stored' && <Field label="模型卡 API Key" hint={data.apiKeyConfigured ? '已配置，留空保持不变；服务端会加密保存' : '仅保存到服务端，浏览器不会回显原始密钥'}>
                <input type="password" value={apiKeyDraft} onChange={(event) => { setApiKeyDraft(event.target.value); setClearApiKey(false); }} placeholder={data.apiKeyConfigured ? '已配置，留空保持不变' : 'sk-...'} autoComplete="new-password" />
                {data.apiKeyConfigured && <label className="studio-inline-check"><input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />清除已保存密钥</label>}
              </Field>}
              <Field label="Temperature">
                <input type="number" min={0} max={2} step={0.05} value={number(data.temperature)} onChange={(event) => patchData('temperature', number(event.target.value))} />
              </Field>
              <Field label="Top P">
                <input type="number" min={0} max={1} step={0.05} value={number(data.topP, 1)} onChange={(event) => patchData('topP', number(event.target.value, 1))} />
              </Field>
              <Field label="Top K" hint="Anthropic 常用；OpenAI 兼容接口默认不发送">
                <input type="number" min={0} max={1000} step={1} value={data.topK == null ? '' : number(data.topK)} onChange={(event) => patchData('topK', event.target.value ? number(event.target.value) : undefined)} />
              </Field>
              <Field label="Presence penalty">
                <input type="number" min={-2} max={2} step={0.05} value={number(data.presencePenalty)} onChange={(event) => patchData('presencePenalty', number(event.target.value))} />
              </Field>
              <Field label="Frequency penalty" hint="Anthropic 会自动忽略">
                <input type="number" min={-2} max={2} step={0.05} value={number(data.frequencyPenalty)} onChange={(event) => patchData('frequencyPenalty', number(event.target.value))} />
              </Field>
              <Field label="最大输出 tokens">
                <input type="number" min={16} max={8000} value={number(data.maxTokens)} onChange={(event) => patchData('maxTokens', number(event.target.value))} />
              </Field>
              <Field label="超时（毫秒）">
                <input type="number" min={1000} value={number(data.timeoutMs)} onChange={(event) => patchData('timeoutMs', number(event.target.value))} />
              </Field>
            </div>
            <Field label="停止序列" hint="用逗号分隔；Anthropic 会映射为 stop_sequences">
              <input value={Array.isArray(data.stopSequences) ? data.stopSequences.join('，') : ''} onChange={(event) => patchData('stopSequences', event.target.value.split(/[，,]/).map((value) => value.trim()).filter(Boolean))} placeholder="例如：\n" />
            </Field>
            <Field label="其他供应商参数" hint="填写 JSON 对象；系统会过滤协议保留字段和 Anthropic 已知不支持字段">
              <textarea rows={5} value={extraParametersText} onChange={(event) => setExtraParametersText(event.target.value)} spellCheck={false} placeholder={'{\n  "seed": 42\n}'} />
            </Field>
            <div className="studio-field">
              <span>发送标准参数</span>
              <small>关闭后本次请求不会携带对应字段，适合不接受 OpenAI 采样参数的 Claude 网关。</small>
              <div className="studio-check-row">
                {modelParameterOptions.map((item) => (
                  <label key={item.value}>
                    <input
                      type="checkbox"
                      checked={!disabledParameters.includes(item.value)}
                      onChange={(event) => patchData('disabledParameters', event.target.checked
                        ? disabledParameters.filter((value) => value !== item.value)
                        : [...disabledParameters, item.value])}
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="studio-callout">模型卡是共享资源。评测快照只保存非敏感配置，运行时通过模型卡 ID 解析服务端密钥；Anthropic 会自动跳过 presence penalty、frequency penalty 和 OpenAI 专属 response_format。</div>
          </>
        )}

        {kind === 'scheduler-policy' && (
          <>
            <div className="studio-form-grid">
              <Field label="历史轮数">
                <input type="number" min={1} max={100} value={number(data.historyRounds)} onChange={(event) => patchData('historyRounds', number(event.target.value))} />
              </Field>
              <Field label="每轮最多角色">
                <input type="number" min={1} max={20} value={number(data.maxSpeakers)} onChange={(event) => patchData('maxSpeakers', number(event.target.value))} />
              </Field>
              <Field label="执行方式">
                <select value={text(data.executionMode)} onChange={(event) => patchData('executionMode', event.target.value)}>
                  <option value="parallel">并行</option>
                  <option value="serial">串行</option>
                </select>
              </Field>
              <Field label="用户消息打包窗口（毫秒）">
                <input type="number" min={0} value={number(data.bundleWindowMs)} onChange={(event) => patchData('bundleWindowMs', number(event.target.value))} />
              </Field>
            </div>
            <div className="studio-check-row">
              <label><input type="checkbox" checked={Boolean(data.mentionEnabled)} onChange={(event) => patchData('mentionEnabled', event.target.checked)} />启用 @ 唤起线</label>
              <label><input type="checkbox" checked={Boolean(data.proactiveEnabled)} onChange={(event) => patchData('proactiveEnabled', event.target.checked)} />启用 AI 主动线</label>
            </div>
          </>
        )}

        {kind === 'memory-policy' && (
          <>
            <div className="studio-check-row">
              <label><input type="checkbox" checked={Boolean(data.enabled)} onChange={(event) => patchData('enabled', event.target.checked)} />启用记忆</label>
              <label><input type="checkbox" checked={Boolean(data.injectManualMemory)} onChange={(event) => patchData('injectManualMemory', event.target.checked)} />注入手工记忆</label>
              <label><input type="checkbox" checked={Boolean(data.injectAutoMemory)} onChange={(event) => patchData('injectAutoMemory', event.target.checked)} />注入自动记忆</label>
            </div>
            <div className="studio-form-grid">
              <Field label="每 N 轮更新">
                <input type="number" min={1} value={number(data.updateEveryTurns)} onChange={(event) => patchData('updateEveryTurns', number(event.target.value))} />
              </Field>
              <Field label="检索 Top K">
                <input type="number" min={1} max={50} value={number(data.retrievalLimit)} onChange={(event) => patchData('retrievalLimit', number(event.target.value))} />
              </Field>
            </div>
          </>
        )}
      </div>

      {error && <div className="studio-error">{error}</div>}
      <div className="studio-form-actions">
        <button type="button" className="studio-button secondary" onClick={onCancel}>取消</button>
        <button type="submit" className="studio-button primary" disabled={saving}>{saving ? '保存中...' : '保存资源'}</button>
      </div>
    </form>
  );
}
