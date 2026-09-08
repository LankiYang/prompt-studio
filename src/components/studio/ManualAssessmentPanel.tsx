import { ClipboardCheck, MessageSquareText, RotateCcw, UserRoundCheck } from 'lucide-react';
import { useState } from 'react';
import type { StudioBootstrap, StudioManualAssessment, StudioManualScores, StudioPromptVersion, StudioResource, StudioScorecardData } from '../../../shared/studio-types';
import type { PromptQualityDimensions } from '../../../shared/types';
import { studioApi } from '../../studio/api';
import StudioModal from './StudioModal';

const fallbackDimensions: Array<{ key: keyof PromptQualityDimensions; label: string; weight: number; description: string }> = [
  { key: 'instruction', label: '玩家指令遵循', weight: 15, description: '是否优先、准确地回应玩家要求。' },
  { key: 'relevance', label: '相关性与连续性', weight: 10, description: '是否紧贴最新消息和已知事实。' },
  { key: 'agency', label: '玩家行动权', weight: 15, description: '是否把决定权和行动权留给真人玩家。' },
  { key: 'logic', label: '剧情合理性', weight: 15, description: '时间、信息与因果是否自洽。' },
  { key: 'interest', label: '剧情有趣性', weight: 10, description: '是否带来可接续而不抢戏的变化。' },
  { key: 'persona', label: '人设与角色边界', weight: 15, description: '是否符合自身角色且不代演他人。' },
  { key: 'tone', label: '语气风格差异', weight: 5, description: '角色声音是否可辨认。' },
  { key: 'world', label: '世界观遵循', weight: 5, description: '是否遵守世界规则和事实。' },
  { key: 'group', label: '群像协作', weight: 5, description: '是否让真人参与，而非 NPC 自转。' },
  { key: 'style', label: '表达与节奏', weight: 5, description: '是否短、自然且留有接续空间。' },
];

function dimensions(data: StudioBootstrap) {
  const scorecard = data.resources.find((item) => item.kind === 'scorecard' && item.status === 'active' && !item.deletedAt);
  const source = scorecard?.data as Partial<StudioScorecardData> | undefined;
  return Array.isArray(source?.dimensions) && source.dimensions.length ? source.dimensions : fallbackDimensions;
}

function latestByMember(assessments: StudioManualAssessment[]) {
  const latest = new Map<string, StudioManualAssessment>();
  for (const assessment of assessments) {
    const current = latest.get(assessment.memberId);
    if (!current || assessment.revision > current.revision || (assessment.revision === current.revision && assessment.createdAt > current.createdAt)) latest.set(assessment.memberId, assessment);
  }
  return [...latest.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function AssessmentForm({ data, prompt, version, initial, onCancel, onSaved }: { data: StudioBootstrap; prompt: StudioResource; version: StudioPromptVersion; initial?: StudioManualAssessment; onCancel: () => void; onSaved: () => Promise<void> }) {
  const scoreDimensions = dimensions(data);
  const initialScores = Object.fromEntries(scoreDimensions.map((dimension) => [dimension.key, initial?.scores[dimension.key] ?? 3])) as StudioManualScores;
  const [scores, setScores] = useState<StudioManualScores>(initialScores);
  const [scenario, setScenario] = useState(initial?.scenario ?? '');
  const [turns, setTurns] = useState(String(initial?.turns || ''));
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const weightedScore = scoreDimensions.reduce((total, dimension) => total + scores[dimension.key] / 5 * dimension.weight, 0);
  return <form className="studio-form manual-assessment-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!comment.trim()) return setError('请填写你观察到的优点、问题或关键案例');
    setSaving(true);
    try {
      await studioApi.createManualAssessment({ projectId: data.project.id, promptId: prompt.id, versionId: version.id, scores, scenario, turns: Number(turns) || 0, comment: comment.trim() });
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false); }
  }}>
    <div className="studio-human-score-total"><span>按当前评分卡折算</span><strong>{weightedScore.toFixed(1)}</strong><small>/ 100</small></div>
    <div className="studio-manual-dimension-grid">{scoreDimensions.map((dimension) => <label key={dimension.key}><div><span>{dimension.label}</span><strong>{scores[dimension.key].toFixed(1)} / 5</strong></div><input type="range" min="1" max="5" step="0.5" value={scores[dimension.key]} onChange={(event) => setScores((current) => ({ ...current, [dimension.key]: Number(event.target.value) }))} /><small>{dimension.description} · 权重 {dimension.weight}%</small></label>)}</div>
    <div className="studio-form-grid"><label className="studio-field"><span>体验场景</span><input value={scenario} onChange={(event) => setScenario(event.target.value)} placeholder="例如：多人房间自由演绎" /></label><label className="studio-field"><span>实际体验轮数</span><input type="number" min="0" max="9999" value={turns} onChange={(event) => setTurns(event.target.value)} placeholder="例如：20" /></label></div>
    <label className="studio-field"><span>结论与证据</span><textarea rows={5} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="记录具体表现：玩家是否被抢戏、角色是否混淆、哪一句体现了优点或问题。" /><small>再次提交会保存为新的个人修订，团队汇总使用你的最新结论。</small></label>
    {error && <div className="studio-error">{error}</div>}
    <div className="studio-form-actions"><button type="button" className="studio-button secondary" onClick={onCancel}>取消</button><button className="studio-button primary" disabled={saving}>{saving ? '提交中...' : initial ? '提交新的评测修订' : '提交人工评测'}</button></div>
  </form>;
}

export default function ManualAssessmentPanel({ data, prompt, version, reload, notify }: { data: StudioBootstrap; prompt: StudioResource; version: StudioPromptVersion; reload: () => Promise<void>; notify: (message: string, type?: 'success' | 'error') => void }) {
  const [open, setOpen] = useState(false);
  const all = data.manualAssessments.filter((assessment) => assessment.versionId === version.id);
  const activeMemberIds = new Set(data.projectMembers.filter((membership) => membership.member?.status === 'active').map((membership) => membership.memberId));
  const latest = latestByMember(all).filter((assessment) => activeMemberIds.has(assessment.memberId));
  const myLatest = latest.find((assessment) => assessment.memberId === data.currentMember.id);
  const average = latest.length ? latest.reduce((sum, assessment) => sum + assessment.overallScore, 0) / latest.length : null;
  const historicalCount = all.length;
  return <section className="studio-manual-assessment-panel">
    <header><div><div className="studio-eyebrow">HUMAN EVALUATION</div><h4>团队人工评测</h4><p>每人独立体验并按十维评分卡提交结论；团队均分只取每位成员最新一次评测。</p></div><button className="studio-button secondary" onClick={() => setOpen(true)}>{myLatest ? <RotateCcw size={15} /> : <ClipboardCheck size={15} />}{myLatest ? '重新评测' : '人工评测此版本'}</button></header>
    <div className="studio-manual-summary"><div><small>团队均分</small><strong>{average == null ? '-' : average.toFixed(1)}</strong><em>/ 100</em></div><div><small>有效成员结论</small><strong>{latest.length}</strong><em>人</em></div><div><small>累计修订</small><strong>{historicalCount}</strong><em>次</em></div>{myLatest && <div><small>我的最新结论</small><strong>{myLatest.overallScore.toFixed(1)}</strong><em>v{myLatest.revision}</em></div>}</div>
    <div className="studio-manual-list">{latest.map((assessment) => <article key={assessment.memberId}><span className="studio-avatar">{assessment.memberName.slice(0, 1)}</span><div><header><strong>{assessment.memberName}</strong><small>第 {assessment.revision} 次修订 · {new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(assessment.createdAt)}</small></header><p>{assessment.comment}</p><footer>{assessment.scenario && <span><MessageSquareText size={12} />{assessment.scenario}</span>}{assessment.turns > 0 && <span><UserRoundCheck size={12} />{assessment.turns} 轮</span>}</footer></div><strong className="studio-manual-item-score">{assessment.overallScore.toFixed(1)}</strong></article>)}{!latest.length && <div className="studio-empty compact"><ClipboardCheck size={17} />还没有成员提交人工评测</div>}</div>
    {open && <StudioModal title={`人工评测 · v${version.number} ${version.title}`} subtitle="这是个人体验结论，不会覆盖 AI 自动评分或其他成员的意见。" wide onClose={() => setOpen(false)}><AssessmentForm data={data} prompt={prompt} version={version} initial={myLatest} onCancel={() => setOpen(false)} onSaved={async () => { setOpen(false); notify('人工评测已提交，并保留为个人新修订'); await reload(); }} /></StudioModal>}
  </section>;
}
