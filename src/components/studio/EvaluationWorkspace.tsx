import { Archive, Boxes, CheckCircle2, ChevronRight, Clock3, Code2, FileDiff, FlaskConical, LoaderCircle, LockKeyhole, Play, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StudioBootstrap, StudioEvaluation, StudioResourceKind } from '../../../shared/studio-types';
import { studioApi } from '../../studio/api';
import EvaluationResults from './EvaluationResults';
import ModelComparisonWorkspace from './ModelComparisonWorkspace';

function when(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function statusLabel(status: StudioEvaluation['status']) {
  if (status === 'draft') return '待运行';
  if (status === 'running') return '运行中';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return '已归档';
}

export default function EvaluationWorkspace({
  data,
  reload,
  notify,
  onOpenAssets,
  onOpenPrompts,
}: {
  data: StudioBootstrap;
  reload: () => Promise<void>;
  notify: (message: string, type?: 'success' | 'error') => void;
  onOpenAssets: () => void;
  onOpenPrompts: () => void;
}) {
  const prompts = data.resources.filter((item) => item.kind === 'prompt' && !item.deletedAt);
  const active = (kind: StudioResourceKind) =>
    data.resources.filter((item) => item.kind === kind && !item.deletedAt && item.status === 'active');
  const suites = active('test-suite');
  const characters = active('character');
  const worlds = active('world');
  const models = active('model-config');
  const schedulers = active('scheduler-policy');
  const memories = active('memory-policy');
  const scorecards = active('scorecard');
  const evaluations = data.evaluations.filter((item) => !item.deletedAt);

  const [mode, setMode] = useState<'new' | 'history'>(evaluations.length ? 'history' : 'new');
  const [selectedEvaluationId, setSelectedEvaluationId] = useState(evaluations[0]?.id ?? '');
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? '');
  const versions = useMemo(
    () => data.promptVersions.filter((item) => item.promptId === promptId).sort((left, right) => left.number - right.number),
    [data.promptVersions, promptId],
  );
  const [baselineVersionId, setBaselineVersionId] = useState('');
  const [candidateVersionId, setCandidateVersionId] = useState('');
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? '');
  const [worldId, setWorldId] = useState(worlds[0]?.id ?? '');
  const [modelId, setModelId] = useState(models[0]?.id ?? '');
  const [schedulerId, setSchedulerId] = useState(schedulers[0]?.id ?? '');
  const [memoryId, setMemoryId] = useState(memories[0]?.id ?? '');
  const [scorecardId, setScorecardId] = useState(scorecards[0]?.id ?? '');
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [evaluationType, setEvaluationType] = useState<'prompt' | 'model'>('prompt');
  const selectedEvaluation = evaluations.find((item) => item.id === selectedEvaluationId) ?? evaluations[0];
  const selectedSuite = suites.find((item) => item.id === suiteId);
  const caseCount = Array.isArray(selectedSuite?.data.cases) ? selectedSuite.data.cases.length : 0;
  const currentRole = data.projectMembers.find((item) => item.memberId === data.currentMember.id)?.role ?? 'viewer';
  const canCreate = currentRole === 'owner' || currentRole === 'editor';

  useEffect(() => {
    if (!versions.length) {
      setBaselineVersionId('');
      setCandidateVersionId('');
      return;
    }
    setBaselineVersionId((current) => versions.some((item) => item.id === current) ? current : versions[0].id);
    setCandidateVersionId((current) => versions.some((item) => item.id === current) ? current : versions[versions.length - 1].id);
  }, [versions]);

  const preflight = [
    { ok: Boolean(promptId), text: '已选择 Prompt' },
    { ok: Boolean(baselineVersionId && candidateVersionId && baselineVersionId !== candidateVersionId), text: '旧版与新版是两个不同快照' },
    { ok: caseCount > 0, text: `测试集包含 ${caseCount} 条案例` },
    { ok: characters.length > 0, text: `共享 ${characters.length} 个角色` },
    { ok: Boolean(worldId && modelId && schedulerId && memoryId && scorecardId), text: '共享配置完整' },
  ];
  const canRun = canCreate && preflight.every((item) => item.ok) && !running;
  const promptSetupMissing = !prompts.length || versions.length < 2;
  const sharedSetupMissing = !suites.length || !characters.length || !worlds.length || !models.length || !schedulers.length || !memories.length || !scorecards.length;

  if (evaluationType === 'model') {
    return <div className="studio-evaluation-type-page">
      <div className="studio-evaluation-type-switch" role="tablist" aria-label="评测类型">
        <button role="tab" aria-selected={false} onClick={() => setEvaluationType('prompt')}>Prompt 版本对比</button>
        <button role="tab" aria-selected={true}>模型横评</button>
      </div>
      <ModelComparisonWorkspace data={data} reload={reload} notify={notify} />
    </div>;
  }

  async function createAndRun() {
    if (!canRun) return;
    setRunning(true);
    setError('');
    try {
      const created = await studioApi.createEvaluation({
        name: name.trim() || undefined,
        promptId,
        baselineVersionId,
        candidateVersionId,
        suiteId,
        characterResourceIds: characters.map((item) => item.id),
        worldResourceId: worldId,
        modelConfigResourceId: modelId,
        schedulerPolicyResourceId: schedulerId,
        memoryPolicyResourceId: memoryId,
        scorecardResourceId: scorecardId,
      });
      setSelectedEvaluationId(created.id);
      notify('评测快照已冻结，正在运行');
      const completed = await studioApi.runEvaluation(created.id);
      setSelectedEvaluationId(completed.id);
      setMode('history');
      notify(completed.status === 'completed' ? '旧版 / 新版评测已完成' : '评测结束，但存在服务失败', completed.status === 'completed' ? 'success' : 'error');
      await reload();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      notify(message, 'error');
      await reload();
    } finally {
      setRunning(false);
    }
  }

  if (mode === 'new') {
    return (
      <div className="studio-evaluation-new">
        <header className="studio-page-heading">
          <div><div className="studio-eyebrow">CONTROLLED EVALUATION</div><h2>新建旧版 / 新版评测</h2><p>只改变 Prompt 版本；角色、世界、模型、历史窗口、调度、记忆和输入全部锁定。</p></div>
          {evaluations.length > 0 && <button className="studio-button secondary" onClick={() => setMode('history')}><Clock3 size={15} />查看历史</button>}
        </header>
        <div className="studio-evaluation-type-switch" role="tablist" aria-label="评测类型"><button role="tab" aria-selected={true}>Prompt 版本对比</button><button role="tab" aria-selected={false} onClick={() => setEvaluationType('model')}>模型横评</button></div>
        {(promptSetupMissing || sharedSetupMissing || !canCreate) && <div className="studio-setup-alert">
          <ShieldCheck size={18} />
          <div><strong>{!canCreate ? '当前账号为只读评测视图' : '运行前还需要补齐配置'}</strong><span>{!canCreate ? '负责人或编辑者可以创建和运行评测，你仍可查看历史结果。' : '正式评测至少需要两个 Prompt 版本，以及角色、世界观、测试集、评分卡、模型、调度和记忆策略。'}</span></div>
          {canCreate && <div className="studio-setup-alert-actions">{promptSetupMissing && <button className="studio-button secondary small" onClick={onOpenPrompts}><Code2 size={14} />Prompt 版本</button>}{sharedSetupMissing && <button className="studio-button secondary small" onClick={onOpenAssets}><Boxes size={14} />共享资源</button>}</div>}
        </div>}
        <div className="studio-evaluation-setup-grid">
          <section className="studio-section-block">
            <header><div><h3>1. 选择对比版本</h3><p>两侧必须来自同一个 Prompt。</p></div><FileDiff size={18} /></header>
            <div className="studio-form">
              <label className="studio-field"><span>评测名称（可选）</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：短回复规则回归" /></label>
              <label className="studio-field"><span>Prompt</span><select value={promptId} onChange={(event) => setPromptId(event.target.value)}><option value="">请选择 Prompt</option>{prompts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <div className="studio-old-new-picker">
                <label className="studio-field">
                  <span>旧版（基线）</span>
                  <select value={baselineVersionId} onChange={(event) => setBaselineVersionId(event.target.value)}>
                    {versions.map((item) => <option key={item.id} value={item.id}>v{item.number} · {item.title}</option>)}
                  </select>
                </label>
                <ChevronRight size={20} />
                <label className="studio-field">
                  <span>新版（候选）</span>
                  <select value={candidateVersionId} onChange={(event) => setCandidateVersionId(event.target.value)}>
                    {versions.map((item) => <option key={item.id} value={item.id}>v{item.number} · {item.title}</option>)}
                  </select>
                </label>
              </div>
              <label className="studio-field"><span>测试集</span><select value={suiteId} onChange={(event) => setSuiteId(event.target.value)}><option value="">请选择测试集</option>{suites.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            </div>
          </section>

          <section className="studio-section-block">
            <header><div><h3>2. 锁定共享条件</h3><p>创建后冻结快照；资源后续修改不会污染本次结果。</p></div><LockKeyhole size={18} /></header>
            <div className="studio-form compact">
              <label className="studio-field"><span>角色</span><div className="studio-locked-value">{characters.map((item) => item.name).join('、') || '无可用角色'}</div></label>
              <label className="studio-field"><span>世界观</span><select value={worldId} onChange={(event) => setWorldId(event.target.value)}>{worlds.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="studio-field"><span>模型参数</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="studio-field"><span>调度与历史窗口</span><select value={schedulerId} onChange={(event) => setSchedulerId(event.target.value)}>{schedulers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="studio-field"><span>记忆策略</span><select value={memoryId} onChange={(event) => setMemoryId(event.target.value)}>{memories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="studio-field"><span>评分卡</span><select value={scorecardId} onChange={(event) => setScorecardId(event.target.value)}>{scorecards.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            </div>
          </section>
        </div>
        <section className="studio-run-bar">
          <div className="studio-preflight">
            {preflight.map((item) => <span key={item.text} className={item.ok ? 'ok' : 'bad'}>{item.ok ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}{item.text}</span>)}
          </div>
          <div className="studio-run-estimate">
            <span>预计 {caseCount} 轮 / 版本</span>
            <strong>{caseCount * 4} 次模型调用</strong>
            <button className="studio-button primary" disabled={!canRun} onClick={createAndRun}>
              {running ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
              {running ? '正在生成与评分...' : '创建并运行评测'}
            </button>
          </div>
        </section>
        {error && <div className="studio-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="studio-evaluation-history">
      <div className="studio-evaluation-type-switch" role="tablist" aria-label="评测类型"><button role="tab" aria-selected={true}>Prompt 版本对比</button><button role="tab" aria-selected={false} onClick={() => setEvaluationType('model')}>模型横评</button></div>
      <aside className="studio-run-list">
        <header><div><h2>评测历史</h2><p>{evaluations.length} 次受控对比</p></div>{canCreate && <button className="studio-button primary small" onClick={() => setMode('new')}><Plus size={15} />新建评测</button>}</header>
        <div>
          {evaluations.map((evaluation) => (
            <button key={evaluation.id} className={selectedEvaluation?.id === evaluation.id ? 'active' : ''} onClick={() => setSelectedEvaluationId(evaluation.id)}>
              <span className={`studio-run-status ${evaluation.status}`}><FlaskConical size={15} /></span>
              <span><strong>{evaluation.name}</strong><small>{when(evaluation.createdAt)} · {evaluation.sharedConfig.cases.length} 轮</small></span>
              <em>{statusLabel(evaluation.status)}</em>
            </button>
          ))}
        </div>
      </aside>
      <main className="studio-run-detail">
        {selectedEvaluation ? (
          <>
            <header className="studio-detail-header">
              <div>
                <div className="studio-eyebrow">EVALUATION EVIDENCE</div>
                <h2>{selectedEvaluation.name}</h2>
                <p>创建于 {when(selectedEvaluation.createdAt)} · {selectedEvaluation.createdBy}</p>
              </div>
              <div className="studio-header-actions">
                <span className={`studio-status ${selectedEvaluation.status}`}>{statusLabel(selectedEvaluation.status)}</span>
                {selectedEvaluation.status === 'draft' && <button className="studio-button primary" disabled={running} onClick={async () => { setRunning(true); try { await studioApi.runEvaluation(selectedEvaluation.id); notify('评测已完成'); await reload(); } catch (caught) { notify(caught instanceof Error ? caught.message : String(caught), 'error'); } finally { setRunning(false); } }}><Play size={15} />运行</button>}
                {selectedEvaluation.status !== 'running' && selectedEvaluation.status !== 'archived' && <button className="studio-button secondary" onClick={async () => { await studioApi.archiveEvaluation(selectedEvaluation.id); notify('评测已归档'); await reload(); }}><Archive size={15} />归档</button>}
              </div>
            </header>
            <div className="studio-frozen-strip">
              <LockKeyhole size={15} />
              <span>冻结条件</span>
              <strong>{selectedEvaluation.sharedConfig.characters.length} 个角色</strong>
              <strong>{selectedEvaluation.sharedConfig.suiteName}</strong>
              <strong>{selectedEvaluation.sharedConfig.modelConfig.model}</strong>
              <strong>历史 {selectedEvaluation.sharedConfig.schedulerPolicy.historyRounds} 轮</strong>
              <strong>{selectedEvaluation.sharedConfig.memoryPolicy.enabled ? '启用记忆' : '无记忆'}</strong>
            </div>
            {selectedEvaluation.error && <div className="studio-error">{selectedEvaluation.error}</div>}
            <EvaluationResults evaluation={selectedEvaluation} />
          </>
        ) : <div className="studio-empty"><FlaskConical size={22} /><strong>还没有评测</strong><button className="studio-button primary" onClick={() => setMode('new')}>新建评测</button></div>}
      </main>
    </div>
  );
}
