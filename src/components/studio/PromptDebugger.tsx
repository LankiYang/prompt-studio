import {
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Eraser,
  MessageSquareText,
  Play,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  StudioBootstrap,
  StudioDebugChatResult,
  StudioDebugMessage,
  StudioDebugSamplingOverrides,
  StudioPromptVersion,
  StudioResource,
} from '../../../shared/studio-types';
import { studioApi } from '../../studio/api';

type SideKey = 'left' | 'right';

interface SideDraft {
  modelId: string;
  prompt: string;
  temperature: number;
  topP: number;
  topK: number | undefined;
  presencePenalty: number;
  frequencyPenalty: number;
  maxTokens: number;
  stopSequences: string[];
  extraParametersText: string;
}

interface DebugTurn {
  id: string;
  input: string;
  left?: StudioDebugChatResult;
  right?: StudioDebugChatResult;
  leftError?: string;
  rightError?: string;
}

interface DebuggerSession {
  left: SideDraft;
  right: SideDraft;
  turns: DebugTurn[];
  input: string;
}

const DEBUGGER_SESSION_KEY = 'prompt-studio-debugger-session';

function readDebuggerSession(key: string): DebuggerSession | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) as DebuggerSession : null;
  } catch {
    return null;
  }
}

function modelCards(data: StudioBootstrap) {
  return data.resources.filter((item) => item.kind === 'model-config' && !item.deletedAt && item.status === 'active');
}

function promptVersions(data: StudioBootstrap) {
  return [...data.promptVersions].sort((left, right) => {
    if (left.status === 'published' && right.status !== 'published') return -1;
    if (right.status === 'published' && left.status !== 'published') return 1;
    return right.createdAt - left.createdAt;
  });
}

function defaultPrompt(data: StudioBootstrap) {
  return promptVersions(data)[0]?.snapshot.template || '请根据用户消息自然回复。';
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cardData(card?: StudioResource) {
  return card?.data ?? {};
}

function draftFromCard(card: StudioResource | undefined, prompt: string): SideDraft {
  const config = cardData(card);
  return {
    modelId: card?.id ?? '',
    prompt,
    temperature: numberValue(config.temperature, 0.7),
    topP: numberValue(config.topP, 1),
    topK: config.topK == null ? undefined : numberValue(config.topK, 0),
    presencePenalty: numberValue(config.presencePenalty, 0),
    frequencyPenalty: numberValue(config.frequencyPenalty, 0),
    maxTokens: Math.max(1, Math.floor(numberValue(config.maxTokens, 512))),
    stopSequences: Array.isArray(config.stopSequences) ? config.stopSequences.filter((item): item is string => typeof item === 'string') : [],
    extraParametersText: JSON.stringify(config.extraParameters ?? {}, null, 2),
  };
}

function messageHistory(turns: DebugTurn[], side: SideKey, input: string): StudioDebugMessage[] {
  const messages: StudioDebugMessage[] = [];
  for (const turn of turns) {
    messages.push({ role: 'user', content: turn.input });
    const response = side === 'left' ? turn.left?.text : turn.right?.text;
    if (response) messages.push({ role: 'assistant', content: response });
  }
  messages.push({ role: 'user', content: input });
  return messages;
}

function renderPrompt(template: string, data: StudioBootstrap, turns: DebugTurn[], side: SideKey, input: string) {
  const characters = data.resources
    .filter((item) => item.kind === 'character' && !item.deletedAt && item.status === 'active')
    .map((item) => `${String(item.data.name || item.name)}：${String(item.data.persona || '')}`);
  const firstCharacter = data.resources.find((item) => item.kind === 'character' && !item.deletedAt && item.status === 'active');
  const world = data.resources.find((item) => item.kind === 'world' && !item.deletedAt && item.status === 'active');
  const recentMessages = messageHistory(turns, side, input)
    .slice(0, -1)
    .map((message) => `${message.role === 'assistant' ? 'AI' : '用户'}：${message.content}`)
    .join('\n');
  const values: Record<string, string> = {
    roleName: String(firstCharacter?.data.name || firstCharacter?.name || '助手'),
    rolePersona: String(firstCharacter?.data.persona || ''),
    otherCharacters: characters.slice(1).join('\n'),
    storyBackground: String(world?.data.content || ''),
    taskDescription: '根据当前对话回应用户，保持上下文连贯。',
    outputFormat: '只输出本轮回复，不输出分析。',
    dialogueRules: '不要代替用户行动或替其他角色发言。',
    recentMessages,
    latestMessage: `用户：${input}`,
    trigger: 'chat',
    mentionedCharacters: '',
  };
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (match, key: string) => values[key.trim()] ?? match);
}

function parseExtraParameters(value: string) {
  const parsed = JSON.parse(value || '{}') as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('其他参数必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function sideOverrides(draft: SideDraft): StudioDebugSamplingOverrides {
  return {
    temperature: draft.temperature,
    topP: draft.topP,
    topK: draft.topK,
    presencePenalty: draft.presencePenalty,
    frequencyPenalty: draft.frequencyPenalty,
    maxTokens: draft.maxTokens,
    stopSequences: draft.stopSequences,
    extraParameters: parseExtraParameters(draft.extraParametersText),
  };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="studio-debugger-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function resultLabel(result: StudioDebugChatResult) {
  return `${result.latencyMs}ms · ${result.totalTokens || 0} tokens`;
}

export default function PromptDebugger({
  data,
  notify,
  onOpenAssets,
  onOpenPrompts,
}: {
  data: StudioBootstrap;
  notify: (message: string, type?: 'success' | 'error') => void;
  onOpenAssets: () => void;
  onOpenPrompts: () => void;
}) {
  const cards = modelCards(data);
  const versions = promptVersions(data);
  const initialPrompt = defaultPrompt(data);
  const initialCard = cards[0];
  const debuggerSessionKey = `${DEBUGGER_SESSION_KEY}:${data.project.id}:${data.currentMember.id}`;
  const [restoredSession] = useState(() => readDebuggerSession(debuggerSessionKey));
  const [left, setLeft] = useState<SideDraft>(() => restoredSession?.left && cards.some((item) => item.id === restoredSession.left.modelId) ? restoredSession.left : draftFromCard(initialCard, initialPrompt));
  const [right, setRight] = useState<SideDraft>(() => restoredSession?.right && cards.some((item) => item.id === restoredSession.right.modelId) ? restoredSession.right : draftFromCard(cards[1] ?? initialCard, initialPrompt));
  const [turns, setTurns] = useState<DebugTurn[]>(() => restoredSession?.turns ?? []);
  const [input, setInput] = useState(() => restoredSession?.input ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [copiedSide, setCopiedSide] = useState<SideKey | null>(null);

  const selectedCards = useMemo(() => ({
    left: cards.find((item) => item.id === left.modelId),
    right: cards.find((item) => item.id === right.modelId),
  }), [cards, left.modelId, right.modelId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(debuggerSessionKey, JSON.stringify({ left, right, turns, input } satisfies DebuggerSession));
    } catch {
      sessionStorage.removeItem(debuggerSessionKey);
    }
  }, [debuggerSessionKey, input, left, right, turns]);

  function updateSide(side: SideKey, patch: Partial<SideDraft>) {
    if (side === 'left') setLeft((current) => ({ ...current, ...patch }));
    else setRight((current) => ({ ...current, ...patch }));
  }

  function selectCard(side: SideKey, id: string) {
    const card = cards.find((item) => item.id === id);
    const currentPrompt = side === 'left' ? left.prompt : right.prompt;
    updateSide(side, draftFromCard(card, currentPrompt));
  }

  function loadVersion(side: SideKey, id: string) {
    const version = versions.find((item) => item.id === id);
    if (version) updateSide(side, { prompt: version.snapshot.template });
  }

  function copyPrompt(from: SideKey, to: SideKey) {
    const source = from === 'left' ? left.prompt : right.prompt;
    updateSide(to, { prompt: source });
    setCopiedSide(from);
    window.setTimeout(() => setCopiedSide(null), 1200);
  }

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    if (!left.modelId || !right.modelId) {
      setError('请先为左右两侧选择模型卡');
      return;
    }
    setError('');
    const turn: DebugTurn = { id: `debug-${Date.now()}`, input: message };
    setTurns((current) => [...current, turn]);
    setInput('');
    setSending(true);
    const runSide = async (side: SideKey, draft: SideDraft) => {
      const response = await studioApi.debugChat({
        modelConfigResourceId: draft.modelId,
        systemPrompt: renderPrompt(draft.prompt, data, turns, side, message),
        messages: messageHistory(turns, side, message),
        overrides: sideOverrides(draft),
      });
      return { side, response };
    };
    const results = await Promise.allSettled([runSide('left', left), runSide('right', right)]);
    setTurns((current) => current.map((item) => {
      if (item.id !== turn.id) return item;
      const next = { ...item };
      for (const result of results) {
        if (result.status === 'fulfilled') {
          next[result.value.side] = result.value.response;
        } else {
          const key = result.reason instanceof Error ? result.reason.message : String(result.reason);
          if (result === results[0]) next.leftError = key;
          else next.rightError = key;
        }
      }
      return next;
    }));
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed) {
      setError(`${failed} 侧模型调用失败，请查看对应窗口的错误信息`);
      notify('本轮有模型调用失败', 'error');
    } else {
      notify('两侧回复已完成');
    }
    setSending(false);
  }

  function clearConversation() {
    setTurns([]);
    setError('');
  }

  function resetSide(side: SideKey) {
    const card = side === 'left' ? selectedCards.left : selectedCards.right;
    updateSide(side, draftFromCard(card, initialPrompt));
  }

  function renderSide(side: SideKey, title: string) {
    const draft = side === 'left' ? left : right;
    const card = selectedCards[side];
    const protocol = String(card?.data.protocol || 'openai-compatible');
    return <section className="studio-debugger-panel">
      <header className="studio-debugger-panel-head">
        <div className="studio-debugger-side-title"><span className={`studio-debugger-side-dot ${side}`} /> <div><strong>{title}</strong><small>{card ? `${String(card.data.provider || '')} · ${String(card.data.model || '')}` : '未选择模型卡'}</small></div></div>
        <div className="studio-debugger-panel-actions">
          <button className="studio-icon-button" aria-label="恢复当前模型卡默认参数" title="恢复当前模型卡默认参数" onClick={() => resetSide(side)}><Eraser size={15} /></button>
          <button className="studio-icon-button" aria-label="复制 Prompt 到另一侧" title="复制 Prompt 到另一侧" onClick={() => copyPrompt(side, side === 'left' ? 'right' : 'left')}><Copy size={15} /></button>
        </div>
      </header>
      <div className="studio-debugger-controls">
        <Field label="模型卡">
          <select value={draft.modelId} onChange={(event) => selectCard(side, event.target.value)}>
            <option value="">请选择模型卡</option>
            {cards.map((item) => <option value={item.id} key={item.id}>{item.name} · {String(item.data.model || '')}</option>)}
          </select>
          {card && <small className={card.data.apiKeyConfigured ? 'studio-debugger-key-ok' : 'studio-debugger-key-missing'}>{card.data.apiKeyConfigured ? '密钥已配置' : '密钥未配置'} · {protocol === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI 兼容'}</small>}
        </Field>
        <Field label="载入 Prompt 版本">
          <select defaultValue="" onChange={(event) => loadVersion(side, event.target.value)}>
            <option value="">不载入，继续编辑当前内容</option>
            {versions.map((version: StudioPromptVersion) => <option value={version.id} key={version.id}>v{version.number} · {version.title}</option>)}
          </select>
        </Field>
      </div>
      <div className="studio-debugger-prompt-wrap">
        <div className="studio-debugger-label"><span><Braces size={14} />System Prompt</span><small>{draft.prompt.length} 字符</small></div>
        <textarea className="studio-debugger-prompt" value={draft.prompt} onChange={(event) => updateSide(side, { prompt: event.target.value })} spellCheck={false} />
      </div>
      <details className="studio-debugger-params">
        <summary><span><SlidersHorizontal size={14} />采样参数</span><ChevronDown size={15} /></summary>
        <div className="studio-debugger-param-grid">
          <Field label="Temperature"><input type="number" min={0} max={2} step={0.05} value={draft.temperature} onChange={(event) => updateSide(side, { temperature: numberValue(event.target.value, draft.temperature) })} /></Field>
          <Field label="Top P"><input type="number" min={0} max={1} step={0.05} value={draft.topP} onChange={(event) => updateSide(side, { topP: numberValue(event.target.value, draft.topP) })} /></Field>
          <Field label="Top K"><input type="number" min={0} max={1000} value={draft.topK ?? ''} onChange={(event) => updateSide(side, { topK: event.target.value ? numberValue(event.target.value, 0) : undefined })} /></Field>
          <Field label="Presence penalty"><input type="number" min={-2} max={2} step={0.05} value={draft.presencePenalty} onChange={(event) => updateSide(side, { presencePenalty: numberValue(event.target.value, draft.presencePenalty) })} /></Field>
          <Field label="Frequency penalty"><input type="number" min={-2} max={2} step={0.05} value={draft.frequencyPenalty} onChange={(event) => updateSide(side, { frequencyPenalty: numberValue(event.target.value, draft.frequencyPenalty) })} /></Field>
          <Field label="Max tokens"><input type="number" min={1} max={32000} value={draft.maxTokens} onChange={(event) => updateSide(side, { maxTokens: Math.max(1, Math.floor(numberValue(event.target.value, draft.maxTokens))) })} /></Field>
          <Field label="停止序列"><input value={draft.stopSequences.join('，')} onChange={(event) => updateSide(side, { stopSequences: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean) })} /></Field>
        </div>
        <Field label="其他参数 JSON" hint={protocol === 'anthropic-messages' ? 'Anthropic 只发送协议允许的参数，已知冲突项会在回复下方标记' : '可填写供应商专属参数，例如 seed、logprobs'}>
          <textarea className="studio-debugger-extra" rows={3} value={draft.extraParametersText} onChange={(event) => updateSide(side, { extraParametersText: event.target.value })} spellCheck={false} />
        </Field>
      </details>
      <div className="studio-debugger-transcript">
        {!turns.length && <div className="studio-debugger-empty"><MessageSquareText size={20} /><strong>等待第一条消息</strong><span>左右两侧会使用同一条用户输入，各自沿用自己的对话历史。</span></div>}
        {turns.map((turn) => {
          const response = side === 'left' ? turn.left : turn.right;
          const responseError = side === 'left' ? turn.leftError : turn.rightError;
          return <article className="studio-debugger-turn" key={turn.id}>
            <div className="studio-debugger-user-message"><span>用户</span><p>{turn.input}</p></div>
            <div className="studio-debugger-ai-message"><span><Bot size={13} />{title}</span>{response ? <><p>{response.text || '模型返回空内容'}</p><small>{resultLabel(response)}</small>{response.omittedParameters.length > 0 && <div className="studio-debugger-omitted"><CircleAlert size={13} />已忽略：{response.omittedParameters.map((item) => `${item.key}（${item.reason}）`).join('、')}</div>}</> : responseError ? <p className="studio-debugger-response-error"><CircleAlert size={14} />{responseError}</p> : <p className="studio-debugger-pending">本轮未返回</p>}</div>
          </article>;
        })}
        {sending && <div className="studio-debugger-loading"><Play size={14} className="spin" />正在等待 {title}...</div>}
      </div>
    </section>;
  }

  return <div className="studio-debugger-page">
    <header className="studio-page-heading studio-debugger-heading">
      <div><div className="studio-eyebrow">PROMPT DEBUGGER</div><h2>Prompt 调试器</h2><p>选模型、改 Prompt、调参数，并用同一条输入实时对比两套配置。对话只保留在当前浏览器会话，不会自动写入评测历史。</p></div>
      <div className="studio-debugger-heading-actions"><button className="studio-button secondary" onClick={onOpenAssets}><Bot size={15} />模型卡</button><button className="studio-button primary" onClick={onOpenPrompts}><Check size={15} />版本管理</button><button className="studio-icon-button danger" aria-label="清空当前对话" title="清空当前对话" disabled={!turns.length} onClick={() => { if (!turns.length || window.confirm('清空左右两侧的当前调试对话？Prompt 草稿和参数会继续保留。')) clearConversation(); }}><Trash2 size={15} /></button></div>
    </header>
    {!cards.length && <div className="studio-debugger-no-card"><CircleAlert size={20} /><div><strong>还没有可用模型卡</strong><span>先在共享资源中创建供应商、模型、协议和密钥配置，调试器才能发起调用。</span></div><button className="studio-button primary" onClick={onOpenAssets}>创建模型卡</button></div>}
    <div className="studio-debugger-toolbar"><span><Settings2 size={14} />两侧独立配置</span><span><MessageSquareText size={14} />同一用户输入</span><span><Sparkles size={14} />服务端真实调用</span>{copiedSide && <span className="studio-debugger-copied"><Check size={14} />Prompt 已复制</span>}</div>
    <div className="studio-debugger-grid">{renderSide('left', '参考配置 A')}{renderSide('right', '候选配置 B')}</div>
    <form className="studio-debugger-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="studio-debugger-compose-icon"><Send size={17} /></div>
      <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入一条消息，同时发送到窗口 A 和窗口 B" rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} />
      <button className="studio-button primary" type="submit" disabled={sending || !input.trim() || !cards.length}><Send size={15} />{sending ? '生成中...' : '发送'}</button>
    </form>
    {error && <div className="studio-error studio-debugger-error"><CircleAlert size={15} />{error}</div>}
    <div className="studio-debugger-tip"><Sparkles size={14} />Prompt 中的 <code>{'{{变量名}}'}</code> 会在发送前使用当前共享角色、世界观和对话历史展开；左右窗口仍会保留各自的回复历史。</div>
  </div>;
}
