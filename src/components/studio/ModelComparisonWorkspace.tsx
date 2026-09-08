import { Archive, CheckCircle2, Clock3, FlaskConical, LoaderCircle, Play, Plus, Scale, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StudioBootstrap, StudioModelComparison, StudioResourceKind } from '../../../shared/studio-types';
import { studioApi } from '../../studio/api';
import ModelComparisonResults from './ModelComparisonResults';

function when(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function statusLabel(status: StudioModelComparison['status']) {
  return status === 'draft' ? '待运行' : status === 'running' ? '运行中' : status === 'completed' ? '已完成' : status === 'failed' ? '失败' : '已归档';
}

export default function ModelComparisonWorkspace({ data, reload, notify }: { data: StudioBootstrap; reload: () => Promise<void>; notify: (message: string, type?: 'success' | 'error') => void }) {
  const active = (kind: StudioResourceKind) => data.resources.filter((item) => item.kind === kind && !item.deletedAt && item.status === 'active');
  const prompts = active('prompt');
  const suites = active('test-suite');
  const models = active('model-config');
  const characters = active('character');
  const worlds = active('world');
  const schedulers = active('scheduler-policy');
  const memories = active('memory-policy');
  const scorecards = active('scorecard');
  const comparisons = data.modelComparisons;
  const currentRole = data.projectMembers.find((item) => item.memberId === data.currentMember.id)?.role ?? 'viewer';
  const canEdit = currentRole === 'owner' || currentRole === 'editor';
  const [mode, setMode] = useState<'new' | 'history'>(comparisons.length ? 'history' : 'new');
  const [selectedId, setSelectedId] = useState(comparisons[0]?.id ?? '');
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? '');
  const versions = useMemo(() => data.promptVersions.filter((item) => item.promptId === promptId).sort((left, right) => right.number - left.number), [data.promptVersions, promptId]);
  const [versionId, setVersionId] = useState('');
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? '');
  const [judgeModelConfigResourceId, setJudgeModelConfigResourceId] = useState(models[0]?.id ?? '');
  const [targetModelConfigResourceIds, setTargetModelConfigResourceIds] = useState<string[]>(models.slice(0, 2).map((item) => item.id));
  const [worldResourceId, setWorldResourceId] = useState(worlds[0]?.id ?? '');
  const [schedulerPolicyResourceId, setSchedulerPolicyResourceId] = useState(schedulers[0]?.id ?? '');
  const [memoryPolicyResourceId, setMemoryPolicyResourceId] = useState(memories[0]?.id ?? '');
  const [scorecardResourceId, setScorecardResourceId] = useState(scorecards[0]?.id ?? '');
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const selected = comparisons.find((item) => item.id === selectedId) ?? comparisons[0];
  const selectedSuite = suites.find((item) => item.id === suiteId);
  const suiteCases = Array.isArray(selectedSuite?.data.cases) ? selectedSuite.data.cases : [];
  const caseCount = suiteCases.length;

  useEffect(() => {
    setVersionId((current) => versions.some((item) => item.id === current) ? current : versions[0]?.id ?? '');
  }, [versions]);

  const preflight = [
    { ok: Boolean(promptId && versionId), text: '已锁定一个 Prompt 版本' },
    { ok: caseCount > 0, text: `测试集包含 ${caseCount} 条案例` },
    { ok: targetModelConfigResourceIds.length >= 2, text: `已选择 ${targetModelConfigResourceIds.length} 个被测模型` },
    { ok: Boolean(judgeModelConfigResourceId), text: '已选择固定裁判模型' },
    { ok: characters.length > 0 && worldResourceId && schedulerPolicyResourceId && memoryPolicyResourceId && scorecardResourceId, text: '共享条件完整' },
  ];
  const canRun = canEdit && preflight.every((item) => item.ok) && !running;

  function toggleTarget(id: string) {
    setTargetModelConfigResourceIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 8));
  }

  async function createAndRun() {
    if (!canRun) return;
    setRunning(true); setError('');
    try {
      const created = await studioApi.createModelComparison({ name: name.trim() || undefined, promptId, versionId, suiteId, targetModelConfigResourceIds, judgeModelConfigResourceId, characterResourceIds: characters.map((item) => item.id), worldResourceId, schedulerPolicyResourceId, memoryPolicyResourceId, scorecardResourceId });
      notify('模型横评快照已冻结，正在并行运行');
      const completed = await studioApi.runModelComparison(created.id);
      setSelectedId(completed.id); setMode('history');
      notify(completed.status === 'completed' ? '模型横评已完成' : '模型横评结束，但存在模型服务失败', completed.status === 'completed' ? 'success' : 'error');
      await reload();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught); setError(message); notify(message, 'error'); await reload();
    } finally { setRunning(false); }
  }

  if (mode === 'new') return <div className="studio-evaluation-new">
    <header className="studio-page-heading"><div><div className="studio-eyebrow">MODEL BENCHMARK</div><h2>新建模型横评</h2><p>只改变被测模型；Prompt 版本、测试集、角色、世界观、调度、记忆和裁判模型全部冻结。</p></div>{comparisons.length > 0 && <button className="studio-button secondary" onClick={() => setMode('history')}><Clock3 size={15} />查看历史</button>}</header>
    <div className="studio-evaluation-setup-grid">
      <section className="studio-section-block"><header><div><h3>1. 锁定评测对象</h3><p>所有模型使用同一个不可变 Prompt 快照。</p></div><Scale size={18} /></header><div className="studio-form"><label className="studio-field"><span>横评名称（可选）</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：短对话模型横评" /></label><label className="studio-field"><span>Prompt</span><select value={promptId} onChange={(event) => setPromptId(event.target.value)}>{prompts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="studio-field"><span>Prompt 版本</span><select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.map((item) => <option key={item.id} value={item.id}>v{item.number} · {item.title}</option>)}</select></label><label className="studio-field"><span>测试集</span><select value={suiteId} onChange={(event) => setSuiteId(event.target.value)}>{suites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div></section>
      <section className="studio-section-block"><header><div><h3>2. 选择模型</h3><p>被测模型并行生成；裁判模型固定用于所有候选的统一评分。</p></div><FlaskConical size={18} /></header><div className="studio-form compact"><label className="studio-field"><span>固定裁判模型</span><select value={judgeModelConfigResourceId} onChange={(event) => setJudgeModelConfigResourceId(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name} · {String(item.data.model ?? '')}</option>)}</select></label><div className="studio-model-checklist">{models.map((item) => <label key={item.id}><input type="checkbox" checked={targetModelConfigResourceIds.includes(item.id)} onChange={() => toggleTarget(item.id)} />{item.name}<small>{String(item.data.provider ?? '')} · {String(item.data.model ?? '')}</small></label>)}</div></div></section>
    </div>
    <section className="studio-section-block"><header><div><h3>3. 锁定共享条件</h3><p>模型横评不会改变这些条件。</p></div></header><div className="studio-form-grid"><label className="studio-field"><span>世界观</span><select value={worldResourceId} onChange={(event) => setWorldResourceId(event.target.value)}>{worlds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="studio-field"><span>调度与历史窗口</span><select value={schedulerPolicyResourceId} onChange={(event) => setSchedulerPolicyResourceId(event.target.value)}>{schedulers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="studio-field"><span>记忆策略</span><select value={memoryPolicyResourceId} onChange={(event) => setMemoryPolicyResourceId(event.target.value)}>{memories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="studio-field"><span>评分卡</span><select value={scorecardResourceId} onChange={(event) => setScorecardResourceId(event.target.value)}>{scorecards.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div></section>
    <section className="studio-run-bar"><div className="studio-preflight">{preflight.map((item) => <span key={item.text} className={item.ok ? 'ok' : 'bad'}>{item.ok ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}{item.text}</span>)}</div><div className="studio-run-estimate"><span>{caseCount} 条案例 × {targetModelConfigResourceIds.length} 个模型</span><strong>预计 {caseCount * targetModelConfigResourceIds.length * 2} 次模型调用</strong><button className="studio-button primary" disabled={!canRun} onClick={createAndRun}>{running ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{running ? '正在并行生成与评分...' : '创建并运行横评'}</button></div></section>{error && <div className="studio-error">{error}</div>}
  </div>;

  return <div className="studio-evaluation-history"><aside className="studio-run-list"><header><div><h2>模型横评历史</h2><p>{comparisons.length} 次受控横评</p></div>{canEdit && <button className="studio-button primary small" onClick={() => setMode('new')}><Plus size={15} />新建横评</button>}</header><div>{comparisons.map((comparison) => <button key={comparison.id} className={selected?.id === comparison.id ? 'active' : ''} onClick={() => setSelectedId(comparison.id)}><span className={`studio-run-status ${comparison.status}`}><FlaskConical size={15} /></span><span><strong>{comparison.name}</strong><small>{when(comparison.createdAt)} · {comparison.sharedConfig.targetModels.length} 个模型</small></span><em>{statusLabel(comparison.status)}</em></button>)}</div></aside><main className="studio-run-detail">{selected ? <><header className="studio-detail-header"><div><div className="studio-eyebrow">MODEL BENCHMARK EVIDENCE</div><h2>{selected.name}</h2><p>Prompt v{data.promptVersions.find((item) => item.id === selected.versionId)?.number ?? '-'} · 裁判 {selected.sharedConfig.judgeModelConfig.model}</p></div><div className="studio-header-actions"><span className={`studio-status ${selected.status}`}>{statusLabel(selected.status)}</span>{canEdit && selected.status === 'draft' && <button className="studio-button primary" disabled={running} onClick={async () => { setRunning(true); try { await studioApi.runModelComparison(selected.id); await reload(); } finally { setRunning(false); } }}><Play size={15} />运行</button>}{canEdit && selected.status !== 'running' && selected.status !== 'archived' && <button className="studio-button secondary" onClick={async () => { await studioApi.archiveModelComparison(selected.id); await reload(); }}><Archive size={15} />归档</button>}</div></header><div className="studio-frozen-strip"><ShieldCheck size={15} /><span>冻结条件</span><strong>{selected.sharedConfig.targetModels.length} 个被测模型</strong><strong>裁判：{selected.sharedConfig.judgeModelConfig.model}</strong><strong>{selected.sharedConfig.suiteName}</strong></div>{selected.error && <div className="studio-error">{selected.error}</div>}<ModelComparisonResults comparison={selected} /></> : <div className="studio-empty"><Scale size={22} /><strong>还没有模型横评</strong></div>}</main></div>;
}
