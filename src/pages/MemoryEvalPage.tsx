import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import { ArrowLeft, BookOpen, Bot, Brain, Check, Loader2, Plus, RefreshCw, Save, Send, Trash2 } from 'lucide-react';
import type { CustomMemory, MemoryEvaluationConfig, SessionMemoryState } from '../../shared/types';
import BrandMark from '../components/BrandMark';

interface EvalMessage {
  id: string;
  senderNickname: string;
  isAI: boolean;
  builderId?: string;
  characterId?: string;
  content: string;
  timestamp: number;
  memoryCondition: 'baseline' | 'memory';
}

interface PromptConfig { id: string; label: string; }

const EMPTY_MEMORY: SessionMemoryState = {
  characterState: { goal: '', location: '', appearance: '', health: '', attitude: '' },
  worldState: { setting: '', time: '', weather: '', location: '' },
  events: [], items: [], manualMemories: [], autoMemories: [], turnCount: 0, lastUpdatedTurn: 0,
  autoUpdateEnabled: true, updating: false, lastChangedFields: [],
};

function MessagePane({ title, tone, messages, evaluating, scrollRef }: {
  title: string; tone: { background: string; color: string; border: string }; messages: EvalMessage[]; evaluating: boolean; scrollRef: RefObject<HTMLDivElement | null>;
}) {
  return <section className="app-panel flex min-h-0 flex-col overflow-hidden" style={{ borderColor: tone.border }}>
    <div className="flex items-center justify-between border-b px-4 py-3" style={{ background: tone.background, borderColor: tone.border }}>
      <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: tone.color }} /><h2 className="text-sm font-semibold" style={{ color: tone.color }}>{title}</h2></div>
      <span className="text-xs" style={{ color: tone.color }}>{messages.length} 条</span>
    </div>
    <div ref={scrollRef} className="min-h-[330px] flex-1 space-y-3 overflow-y-auto p-4" style={{ background: '#fbfcfe', maxHeight: '54vh' }}>
      {messages.length === 0 && <div className="pt-24 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>从同一条玩家输入开始对照</div>}
      {messages.map((message) => <div key={message.id} className="flex" style={{ justifyContent: message.isAI ? 'flex-start' : 'flex-end' }}>
        <div className="max-w-[88%] rounded-md px-3 py-2 text-sm leading-6" style={{ background: message.isAI ? '#fff' : tone.background, border: `1px solid ${message.isAI ? 'var(--border-color)' : tone.border}`, color: 'var(--text-primary)' }}>
          <div className="mb-0.5 text-xs font-semibold" style={{ color: message.isAI ? tone.color : '#475467' }}>{message.senderNickname}</div>
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>)}
      {evaluating && <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}><Loader2 size={14} className="animate-spin" />正在生成同角色对照回复...</div>}
    </div>
  </section>;
}

function MemoryList({ title, type, items, socket }: { title: string; type: 'manual' | 'auto'; items: CustomMemory[]; socket: Socket | null }) {
  return <section>
    <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{items.length}/20</span></div>
    <div className="space-y-2">
      {items.length === 0 && <p className="py-2 text-xs" style={{ color: 'var(--text-secondary)' }}>暂无配置</p>}
      {items.map((item) => <div key={item.id} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: '#fff' }}>
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{item.title}</p>{item.keyword && <p className="mt-0.5 truncate text-xs" style={{ color: '#0f766e' }}>关键词：{item.keyword}</p>}</div><div className="flex gap-1"><button title={item.enabled ? '停用记忆' : '启用记忆'} onClick={() => socket?.emit('memory-eval-update-custom', { id: item.id, type, enabled: !item.enabled })} className="h-6 w-6 rounded text-xs" style={{ color: item.enabled ? '#15803d' : '#98a2b3' }}>{item.enabled ? '开' : '关'}</button><button title="删除记忆" onClick={() => socket?.emit('memory-eval-delete-custom', { id: item.id, type })} className="h-6 w-6 rounded" style={{ color: '#b42352' }}><Trash2 size={13} /></button></div></div>
        <p className="mt-1 text-xs leading-5" style={{ color: '#475467' }}>{item.content}</p>
      </div>)}
    </div>
  </section>;
}

export default function MemoryEvalPage() {
  const navigate = useNavigate();
  const nickname = sessionStorage.getItem('nickname') || '评测玩家';
  const [socket, setSocket] = useState<Socket | null>(null);
  const [config, setConfig] = useState<MemoryEvaluationConfig>({ builderId: 'prompt-b', updateEveryTurns: 10, baselineHistoryMessages: 8, retrievalLimit: 5 });
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [baselineMessages, setBaselineMessages] = useState<EvalMessage[]>([]);
  const [memoryMessages, setMemoryMessages] = useState<EvalMessage[]>([]);
  const [memoryState, setMemoryState] = useState<SessionMemoryState>(EMPTY_MEMORY);
  const [retrieved, setRetrieved] = useState<CustomMemory[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const [input, setInput] = useState('');
  const [customType, setCustomType] = useState<'manual' | 'auto'>('manual');
  const [customTitle, setCustomTitle] = useState('');
  const [customContent, setCustomContent] = useState('');
  const [customKeyword, setCustomKeyword] = useState('');
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const savePendingRef = useRef(false);
  const configDirtyRef = useRef(false);
  const baselineRef = useRef<HTMLDivElement>(null);
  const memoryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const connection = io(window.location.origin, { transports: ['websocket', 'polling'] });
    connection.on('connect', () => { setConnected(true); connection.emit('get-memory-eval-state'); });
    connection.on('prompt-config-updated', (items: PromptConfig[]) => setPrompts(Array.isArray(items) ? items : []));
    connection.on('memory-eval-state', (data) => {
      if (!configDirtyRef.current || savePendingRef.current) setConfig(data.config);
      setBaselineMessages(data.baselineMessages ?? []); setMemoryMessages(data.memoryMessages ?? []);
      setMemoryState(data.memoryState ?? EMPTY_MEMORY); setRetrieved(data.retrievedMemories ?? []); setEvaluating(Boolean(data.evaluating));
      if (savePendingRef.current) {
        savePendingRef.current = false;
        configDirtyRef.current = false;
        setConfigDirty(false);
        setConfigSaving(false);
        setConfigSaved(true);
        window.setTimeout(() => setConfigSaved(false), 1600);
      }
    });
    connection.on('memory-eval-turn-started', () => setEvaluating(true));
    connection.on('memory-eval-turn-completed', () => setEvaluating(false));
    connection.on('memory-eval-reset', () => { configDirtyRef.current = false; setConfigDirty(false); setInput(''); setEvaluating(false); });
    connection.on('disconnect', () => { setConnected(false); savePendingRef.current = false; setConfigSaving(false); });
    setSocket(connection);
    return () => { connection.disconnect(); };
  }, []);

  useEffect(() => { baselineRef.current?.scrollTo({ top: baselineRef.current.scrollHeight }); memoryRef.current?.scrollTo({ top: memoryRef.current.scrollHeight }); }, [baselineMessages.length, memoryMessages.length, evaluating]);

  const updateConfig = (patch: Partial<MemoryEvaluationConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    configDirtyRef.current = true;
    setConfigDirty(true);
    setConfigSaved(false);
  };
  const saveConfig = () => {
    if (!socket || !connected || !configDirty || configSaving) return;
    savePendingRef.current = true;
    setConfigSaving(true);
    socket.emit('memory-eval-config-save', config);
  };
  const leaveMemory = () => {
    if (configDirty && !window.confirm('实验设置尚未应用，仍要返回工作区吗？')) return;
    navigate('/');
  };
  const send = () => { const value = input.trim(); if (!value || evaluating) return; socket?.emit('memory-eval-send', { content: value, nickname }); setInput(''); };
  const addCustom = () => {
    if (!customTitle.trim() || !customContent.trim()) return;
    socket?.emit('memory-eval-add-custom', { type: customType, title: customTitle, content: customContent, keyword: customType === 'auto' ? customKeyword : undefined });
    setCustomTitle(''); setCustomContent(''); setCustomKeyword('');
  };
  const selectedBuilder = prompts.find((prompt) => prompt.id === config.builderId)?.label ?? 'Builder';

  return <div className="memory-page min-h-screen" style={{ background: 'var(--bg-primary)' }}>
    <header className="workspace-header sticky top-0 z-10 border-b" style={{ background: '#fff', borderColor: 'var(--border-color)' }}>
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3"><button title="返回工作区" onClick={leaveMemory} className="flex h-8 w-8 items-center justify-center rounded-md border" style={{ borderColor: 'var(--border-color)', color: '#475467' }}><ArrowLeft size={16} /></button><BrandMark size={30} /><div className="min-w-0"><h1 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>记忆系统评测</h1><p className="truncate text-xs" style={{ color: 'var(--text-secondary)' }}>同一角色、同一短历史，隔离比较记忆注入效果</p></div></div>
        <div className="memory-header-actions"><span className={`app-connection-status ${connected ? 'connected' : 'disconnected'}`}><i />{connected ? '已连接' : '连接中断'}</span><button disabled={!connected} onClick={() => { if (window.confirm('重启记忆实验并清空左右两侧会话与记忆状态？')) socket?.emit('memory-eval-reset'); }} className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold disabled:opacity-45" style={{ borderColor: '#fecaca', background: '#fff', color: '#b42352' }}><RefreshCw size={14} />重启实验</button></div>
      </div>
    </header>

    <main className="mx-auto max-w-[1440px] px-4 py-5">
      <section className="mb-5 grid gap-3 border-b pb-5 md:grid-cols-4" style={{ borderColor: 'var(--border-color)' }}>
        <label className="text-xs font-medium" style={{ color: '#475467' }}>对照 Prompt<select value={config.builderId} onChange={(event) => updateConfig({ builderId: event.target.value })} className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--border-color)' }}>{prompts.map((prompt) => <option key={prompt.id} value={prompt.id}>{prompt.label}</option>)}</select></label>
        <label className="text-xs font-medium" style={{ color: '#475467' }}>记忆更新频率（玩家轮）<input min="1" max="30" type="number" value={config.updateEveryTurns} onChange={(event) => updateConfig({ updateEveryTurns: Number(event.target.value) })} className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--border-color)' }} /></label>
        <label className="text-xs font-medium" style={{ color: '#475467' }}>两侧短历史（条）<input min="1" max="40" type="number" value={config.baselineHistoryMessages} onChange={(event) => updateConfig({ baselineHistoryMessages: Number(event.target.value) })} className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--border-color)' }} /></label>
        <div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs font-medium" style={{ color: '#475467' }}>RAG Top K<input min="1" max="10" type="number" value={config.retrievalLimit} onChange={(event) => updateConfig({ retrievalLimit: Number(event.target.value) })} className="mt-1.5 w-full rounded-md border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--border-color)' }} /></label><button onClick={saveConfig} disabled={!connected || !configDirty || configSaving} className="inline-flex h-9 items-center gap-1 rounded-md px-3 text-xs font-semibold disabled:opacity-45" style={{ background: 'var(--accent-primary)', color: '#fff' }}>{configSaved ? <Check size={13} /> : <Save size={13} />}{configSaved ? '已应用' : configSaving ? '应用中' : '应用设置'}</button></div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0"><div className="mb-3 flex items-center justify-between"><div><h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>双栏聊天对照</h2><p className="text-xs" style={{ color: 'var(--text-secondary)' }}>当前使用 {selectedBuilder}，每次随机角色名单在左右两侧保持一致</p></div><span className="text-xs font-medium" style={{ color: '#0f766e' }}>第 {memoryState.turnCount} 玩家轮</span></div>
          <div className="comparison-grid" style={{ '--builder-columns': 2 } as CSSProperties}><MessagePane title="无记忆基线" tone={{ background: '#f8fafc', color: '#475467', border: '#d0d5dd' }} messages={baselineMessages} evaluating={evaluating} scrollRef={baselineRef} /><MessagePane title="记忆系统" tone={{ background: '#f0fdfa', color: '#0f766e', border: '#99f6e4' }} messages={memoryMessages} evaluating={evaluating} scrollRef={memoryRef} /></div>
          <div className="mt-4 flex gap-2"><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="输入同一条玩家消息，发送到左右两个实验条件" rows={2} className="min-w-0 flex-1 resize-none rounded-md border bg-white px-3 py-2 text-sm" style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} /><button onClick={send} disabled={!connected || evaluating || !input.trim()} className="inline-flex w-20 flex-shrink-0 items-center justify-center gap-1 rounded-md text-xs font-semibold disabled:opacity-45" style={{ background: '#0f766e', color: '#fff' }}><Send size={14} />发送</button></div>
        </div>

        <aside className="space-y-5"><section className="app-panel p-4"><div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Brain size={16} style={{ color: '#0f766e' }} /><h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>会话记忆</h2></div><button title="立即更新记忆" onClick={() => socket?.emit('memory-eval-update-now')} disabled={memoryState.updating} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: '#99f6e4', color: '#0f766e' }}><RefreshCw size={12} className={memoryState.updating ? 'animate-spin' : ''} />更新</button></div>
          <label className="mb-3 flex items-center justify-between text-xs" style={{ color: '#475467' }}><span>自动异步更新</span><input type="checkbox" checked={memoryState.autoUpdateEnabled} onChange={(event) => socket?.emit('memory-eval-toggle-auto-update', event.target.checked)} /></label>
          <p className="mb-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>上次更新：第 {memoryState.lastUpdatedTurn || 0} 轮{memoryState.lastChangedFields.length ? ` · ${memoryState.lastChangedFields.join('、')}` : ''}</p>
          <div className="space-y-3 text-xs"><div><p className="mb-1 font-semibold" style={{ color: '#475467' }}>角色状态</p><p className="leading-5" style={{ color: 'var(--text-secondary)' }}>{memoryState.characterState.goal || '暂无'} {memoryState.characterState.location && `· ${memoryState.characterState.location}`} {memoryState.characterState.attitude && `· ${memoryState.characterState.attitude}`}</p></div><div><p className="mb-1 font-semibold" style={{ color: '#475467' }}>事件链</p>{memoryState.events.length ? memoryState.events.map((event) => <p key={event.id} className="mb-1 leading-5" style={{ color: 'var(--text-secondary)' }}>- {event.summary}</p>) : <p style={{ color: 'var(--text-secondary)' }}>暂无</p>}</div><div><p className="mb-1 font-semibold" style={{ color: '#475467' }}>关键物品</p>{memoryState.items.length ? memoryState.items.map((item) => <p key={item.id} className="mb-1 leading-5" style={{ color: 'var(--text-secondary)' }}>- {item.name}：{item.status}</p>) : <p style={{ color: 'var(--text-secondary)' }}>暂无</p>}</div></div>
        </section>

        <section className="app-panel p-4"><div className="mb-3 flex items-center gap-2"><BookOpen size={15} style={{ color: '#2563eb' }} /><h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>检索命中</h2></div>{retrieved.length ? retrieved.map((memory) => <div key={memory.id} className="mb-2 rounded-md border px-3 py-2 text-xs" style={{ borderColor: '#bfdbfe', background: '#f8fbff' }}><p className="font-semibold" style={{ color: '#1d4ed8' }}>{memory.title}</p><p className="mt-1 leading-5" style={{ color: '#475467' }}>{memory.content}</p></div>) : <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>本轮没有匹配的自定义记忆</p>}</section>

        <section className="app-panel p-4"><div className="mb-3 flex items-center gap-2"><Bot size={15} style={{ color: '#b45309' }} /><h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>自定义记忆</h2></div><div className="mb-3 flex rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)' }}><button onClick={() => setCustomType('manual')} className="flex-1 rounded px-2 py-1.5 text-xs" style={{ background: customType === 'manual' ? 'var(--accent-primary-soft)' : 'transparent', color: customType === 'manual' ? 'var(--accent-primary)' : '#667085' }}>手工记忆</button><button onClick={() => setCustomType('auto')} className="flex-1 rounded px-2 py-1.5 text-xs" style={{ background: customType === 'auto' ? '#f0fdfa' : 'transparent', color: customType === 'auto' ? '#0f766e' : '#667085' }}>自动槽位</button></div><input value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} placeholder="标题" className="mb-2 w-full rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-color)' }} />{customType === 'auto' && <input value={customKeyword} onChange={(event) => setCustomKeyword(event.target.value)} placeholder="触发关键词" className="mb-2 w-full rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'var(--border-color)' }} />}<textarea value={customContent} onChange={(event) => setCustomContent(event.target.value)} placeholder="明确事实或用户指定的长期信息" rows={3} className="mb-2 w-full resize-y rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: 'var(--border-color)' }} /><button onClick={addCustom} className="inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-xs font-semibold" style={{ background: 'var(--accent-primary)', color: '#fff' }}><Plus size={13} />添加</button><div className="mt-4 space-y-4"><MemoryList title="手工记忆（不会自动改写）" type="manual" items={memoryState.manualMemories} socket={socket} /><MemoryList title="自动记忆槽位" type="auto" items={memoryState.autoMemories} socket={socket} /></div></section>
        </aside>
      </div>
    </main>
  </div>;
}
