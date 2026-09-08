import { CheckCircle2, ChevronDown, ChevronUp, ClipboardCheck, FileSearch, MessageSquarePlus, RotateCcw, Rows3, Send, UserRoundCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StudioBootstrap, StudioReviewComment, StudioReviewRequest, StudioScorecardData } from '../../../shared/studio-types';
import { studioApi } from '../../studio/api';
import StudioModal from './StudioModal';
import ReviewCaseAssessment from './ReviewCaseAssessment';

const statusLabel: Record<StudioReviewRequest['status'], string> = {
  open: '进行中',
  approved: '已通过',
  changes_requested: '需要修改',
  closed: '已关闭',
};

function formatDate(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function latestForReviewer(review: StudioReviewRequest, memberId: string, caseId: string) {
  return review.caseItems
    .flatMap((item) => item.assessments)
    .filter((item) => item.caseId === caseId && item.reviewerId === memberId)
    .sort((left, right) => right.revision - left.revision)[0];
}

function reviewProgress(review: StudioReviewRequest, memberId: string) {
  if (!review.caseItems.length) return null;
  const reviewed = review.caseItems.filter((item) => latestForReviewer(review, memberId, item.caseId));
  return { completed: reviewed.length, total: review.caseItems.length };
}

function anyReviewerProgress(review: StudioReviewRequest) {
  if (!review.caseItems.length) return null;
  const reviewed = review.caseItems.filter((item) => item.assessments.length > 0);
  return { completed: reviewed.length, total: review.caseItems.length };
}

function ReviewForm({
  data,
  onSave,
  onCancel,
}: {
  data: StudioBootstrap;
  onSave: (value: { evaluationId: string; title: string; description: string; reviewerIds: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const evaluations = data.evaluations.filter((item) => item.status === 'completed' && item.result && !item.deletedAt);
  const [evaluationId, setEvaluationId] = useState(evaluations[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const reviewers = data.projectMembers.filter((item) => item.memberId !== data.currentMember.id && item.member?.status === 'active');
  const selectedEvaluation = evaluations.find((item) => item.id === evaluationId);
  const baseline = selectedEvaluation && data.promptVersions.find((item) => item.id === selectedEvaluation.baselineVersionId);
  const candidate = selectedEvaluation && data.promptVersions.find((item) => item.id === selectedEvaluation.candidateVersionId);

  return <form className="studio-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!evaluationId) return setError('请先完成一条新旧版本对比评测');
    if (!reviewerIds.length) return setError('请至少选择一位评审人');
    setSaving(true);
    try {
      await onSave({ evaluationId, title, description, reviewerIds });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }}>
    {evaluations.length ? (
      <label className="studio-field"><span>选择已完成评测</span><select value={evaluationId} onChange={(event) => setEvaluationId(event.target.value)}>{evaluations.map((evaluation) => {
        const oldVersion = data.promptVersions.find((item) => item.id === evaluation.baselineVersionId);
        const newVersion = data.promptVersions.find((item) => item.id === evaluation.candidateVersionId);
        return <option key={evaluation.id} value={evaluation.id}>{evaluation.name} · v{oldVersion?.number ?? '?'} 对 v{newVersion?.number ?? '?'}</option>;
      })}</select></label>
    ) : (
      <div className="studio-form-callout"><Rows3 size={16} /><div><strong>暂无可发起的证据评审</strong><span>请先在“评测与结果”中完成一条旧版 / 新版对比评测，评审会以其中每条生成结果为冻结证据。</span></div></div>
    )}
    {selectedEvaluation && <div className="studio-review-selection"><FileSearch size={16} /><div><strong>{selectedEvaluation.name}</strong><span>{baseline ? `旧版 v${baseline.number} · ${baseline.title}` : '旧版不可用'} → {candidate ? `新版 v${candidate.number} · ${candidate.title}` : '新版不可用'}</span><small>{selectedEvaluation.result?.totalCaseCount ?? selectedEvaluation.sharedConfig.cases.length} 条案例 · {selectedEvaluation.result?.pairedCaseCount ?? 0} 条成对自动评分证据</small></div></div>}
    <label className="studio-field"><span>评审标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：复核玩家行动权优化是否成立" /></label>
    <label className="studio-field"><span>评审说明</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="说明这次逐案例复核要关注的变化和风险。" /></label>
    <fieldset className="studio-reviewer-picker"><legend>指定评审人</legend>{reviewers.map((membership) => <label key={membership.memberId}><input type="checkbox" checked={reviewerIds.includes(membership.memberId)} onChange={(event) => setReviewerIds((current) => event.target.checked ? [...current, membership.memberId] : current.filter((id) => id !== membership.memberId))} />{membership.member?.name}<small>{membership.role}</small></label>)}{!reviewers.length && <p>当前项目还没有可指定的其他已激活成员。</p>}</fieldset>
    {error && <div className="studio-error">{error}</div>}
    <div className="studio-form-actions"><button type="button" className="studio-button secondary" onClick={onCancel}>取消</button><button className="studio-button primary" disabled={saving || !evaluations.length}>{saving ? '发起中...' : '发起逐案例评审'}</button></div>
  </form>;
}

export default function ReviewWorkspace({ data, reload, notify, onOpenEvaluations }: { data: StudioBootstrap; reload: () => Promise<void>; notify: (message: string, type?: 'success' | 'error') => void; onOpenEvaluations: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [expandedReviews, setExpandedReviews] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const currentRole = data.projectMembers.find((item) => item.memberId === data.currentMember.id)?.role ?? 'viewer';
  const canRequest = currentRole === 'owner' || currentRole === 'editor';
  const canReview = currentRole === 'owner' || currentRole === 'editor' || currentRole === 'reviewer';
  const completedEvaluations = useMemo(() => data.evaluations.filter((item) => item.status === 'completed' && item.result && !item.deletedAt), [data.evaluations]);

  async function reply(reviewId: string, decision: StudioReviewComment['decision']) {
    const content = (drafts[reviewId] ?? '').trim();
    if (!content) return notify('请先填写评审意见', 'error');
    try {
      await studioApi.addReviewComment(reviewId, { content, decision });
      setDrafts((current) => ({ ...current, [reviewId]: '' }));
      notify(decision === 'approve' ? '已提交通过结论' : decision === 'changes_requested' ? '已请求修改' : '意见已提交');
      await reload();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  }

  return <div className="studio-review-page">
    <header className="studio-page-heading"><div><div className="studio-eyebrow">EVIDENCE REVIEW</div><h2>版本评审</h2><p>评审对象是一条“Prompt 版本 + AI 生成对话”的评测证据。评审人需要逐案例对照旧版与新版，再提交人工分数和结论。</p></div>{canRequest && <button className="studio-button primary" onClick={() => completedEvaluations.length ? setShowForm(true) : onOpenEvaluations()}>{completedEvaluations.length ? <MessageSquarePlus size={16} /> : <FileSearch size={16} />}{completedEvaluations.length ? '发起证据评审' : '先完成评测'}</button>}</header>
    <section className="studio-review-summary"><div><ClipboardCheck size={18} /><span><small>进行中</small><strong>{data.reviews.filter((item) => item.status === 'open').length}</strong></span></div><div><CheckCircle2 size={18} /><span><small>已通过</small><strong>{data.reviews.filter((item) => item.status === 'approved').length}</strong></span></div><div><RotateCcw size={18} /><span><small>需要修改</small><strong>{data.reviews.filter((item) => item.status === 'changes_requested').length}</strong></span></div></section>
    {!completedEvaluations.length && canRequest && <div className="studio-setup-alert"><FileSearch size={18} /><div><strong>先完成一条新旧版本评测</strong><span>版本评审必须引用逐案例冻结证据，不能只对 Prompt 正文笼统打分。</span></div><button className="studio-button secondary small" onClick={onOpenEvaluations}>进入评测与结果</button></div>}
    <div className="studio-review-list">{data.reviews.map((review) => {
      const evaluation = data.evaluations.find((item) => item.id === review.evaluationId);
      const baseline = data.promptVersions.find((item) => item.id === review.versionId) && evaluation ? data.promptVersions.find((item) => item.id === evaluation.baselineVersionId) : undefined;
      const candidate = data.promptVersions.find((item) => item.id === review.versionId);
      const isReviewer = review.reviewerIds.includes(data.currentMember.id);
      const progress = reviewProgress(review, data.currentMember.id);
      const teamProgress = anyReviewerProgress(review);
      const scorecard = evaluation?.sharedConfig.scorecard ?? (data.resources.find((item) => item.kind === 'scorecard' && !item.deletedAt)?.data as unknown as StudioScorecardData | undefined) ?? {} as StudioScorecardData;
      const expanded = expandedReviews[review.id] ?? false;
      const canAssess = canReview && isReviewer && review.status !== 'closed';
      const legacyDecision = canReview && isReviewer && review.status === 'open' && !review.caseItems.length;
      return <article key={review.id} className={`studio-review-card ${expanded ? 'expanded' : ''}`}>
        <header className="studio-review-card-heading"><div><span className={`studio-status ${review.status}`}>{statusLabel[review.status]}</span><h3>{review.title}</h3><p>发起人：{review.requestedByName} · {formatDate(review.createdAt)}</p></div><div className="studio-review-card-actions"><span className="studio-review-version">{candidate ? `新版 v${candidate.number}` : '历史版本'}</span><button className="studio-icon-button" title={expanded ? '收起评审证据' : '展开评审证据'} onClick={() => setExpandedReviews((current) => ({ ...current, [review.id]: !expanded }))}>{expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button></div></header>
        {review.description && <p className="studio-review-description">{review.description}</p>}
        <div className="studio-review-evidence"><FileSearch size={14} /><span>{evaluation ? `评测证据：${evaluation.name}` : '历史版本级评审，无冻结案例证据'}</span>{evaluation && <span>{baseline ? `旧版 v${baseline.number}` : '旧版不可用'} → {candidate ? `新版 v${candidate.number}` : '新版不可用'}</span>}<span>{review.caseItems.length ? isReviewer ? `${progress?.completed ?? 0}/${progress?.total ?? review.caseItems.length} 条由我复核` : `已有 ${teamProgress?.completed ?? 0}/${teamProgress?.total ?? review.caseItems.length} 条案例复核` : '旧流程评论'}</span></div>
        {!expanded && review.caseItems.length > 0 && <button className="studio-review-expand-hint" onClick={() => setExpandedReviews((current) => ({ ...current, [review.id]: true }))}><Rows3 size={15} />展开 {review.caseItems.length} 条案例，逐条对比和打分<ChevronDown size={14} /></button>}
        {expanded && review.caseItems.length > 0 && <section className="studio-review-evidence-panel"><header><div><span className="studio-eyebrow">FROZEN EVIDENCE</span><h4>逐案例复核</h4><p>{evaluation ? '本次评审引用的是发起时冻结的生成结果，后续重跑评测不会改写这些证据。' : '评测记录当前不可用，以下内容直接来自发起评审时冻结的案例快照。'}</p></div><span className="studio-review-case-count"><Rows3 size={15} />{review.caseItems.length} 条</span></header>{review.caseItems.map((caseItem) => <ReviewCaseAssessment key={caseItem.id} reviewId={review.id} caseItem={caseItem} scorecard={scorecard} baselineLabel={baseline ? `旧版 v${baseline.number} · ${baseline.title}` : '旧版不可用'} candidateLabel={candidate ? `新版 v${candidate.number} · ${candidate.title}` : '新版不可用'} currentMemberId={data.currentMember.id} canAssess={canAssess} notify={notify} onSaved={reload} />)}</section>}
        {expanded && review.caseItems.length === 0 && !evaluation && <div className="studio-review-legacy-notice">这是一条历史版本级评审，原始评测证据尚未冻结；下方仍可保留协作评论。</div>}
        <div className="studio-comment-thread">{review.comments.map((comment) => <div key={comment.id}><span className="studio-avatar">{comment.authorName.slice(0, 1)}</span><div><strong>{comment.authorName}</strong><small>{comment.decision === 'approve' ? '通过' : comment.decision === 'changes_requested' ? '要求修改' : '评论'}</small><p>{comment.content}</p></div></div>)}{!review.comments.length && <div className="studio-empty compact"><UserRoundCheck size={16} />等待协作评论</div>}</div>
        {canReview && review.status !== 'closed' && <div className="studio-review-compose"><textarea value={drafts[review.id] ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [review.id]: event.target.value }))} placeholder={review.caseItems.length ? '补充对整次评审的协作意见，不替代逐案例结论...' : '留下协作意见...'} /><div><button className="studio-button secondary small" onClick={() => void reply(review.id, 'comment')}><Send size={14} />评论</button>{legacyDecision && <><button className="studio-button danger small" onClick={() => void reply(review.id, 'changes_requested')}><RotateCcw size={14} />要求修改</button><button className="studio-button primary small" onClick={() => void reply(review.id, 'approve')}><CheckCircle2 size={14} />通过</button></>}</div></div>}
      </article>;
    })}{!data.reviews.length && <div className="studio-empty"><ClipboardCheck size={22} /><strong>还没有版本评审</strong><span>{completedEvaluations.length ? '发起评审后，指定成员会逐条复核冻结的旧版 / 新版对话。' : '先完成一条旧版 / 新版对比评测，再发起证据评审。'}</span>{canRequest && (completedEvaluations.length ? <button className="studio-button primary" onClick={() => setShowForm(true)}>发起首个评审</button> : <button className="studio-button primary" onClick={onOpenEvaluations}>进入评测与结果</button>)}</div>}</div>
    {showForm && <StudioModal title="发起逐案例证据评审" subtitle="评审人将对每条 AI 生成结果逐一对比、打分和提交结论；通过后仍需由项目负责人执行发布。" wide onClose={() => setShowForm(false)}><ReviewForm data={data} onCancel={() => setShowForm(false)} onSave={async (value) => { await studioApi.createReview({ ...value, projectId: data.project.id }); setShowForm(false); notify('逐案例评审已发起'); await reload(); }} /></StudioModal>}
  </div>;
}
