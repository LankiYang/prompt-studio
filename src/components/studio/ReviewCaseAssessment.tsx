import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Database, RotateCcw, Save, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  StudioManualScores,
  StudioReviewCase,
  StudioReviewCaseAssessment as ReviewCaseAssessmentRecord,
  StudioScorecardData,
} from '../../../shared/studio-types';
import type { PromptEvaluationCaseResult, PromptQualityDimensions } from '../../../shared/types';
import { studioApi } from '../../studio/api';

const fallbackLabels: Record<keyof PromptQualityDimensions, string> = {
  instruction: '玩家指令遵循',
  relevance: '相关性与连续性',
  agency: '玩家行动权',
  logic: '剧情合理性',
  interest: '剧情有趣性',
  persona: '人设与角色边界',
  tone: '语气风格差异',
  world: '世界观遵循',
  group: '群像协作',
  style: '表达与节奏',
};

const defaultScores: StudioManualScores = {
  instruction: 3,
  relevance: 3,
  agency: 3,
  logic: 3,
  interest: 3,
  persona: 3,
  tone: 3,
  world: 3,
  group: 3,
  style: 3,
};

type Side = 'baseline' | 'candidate';

function scoreText(value: number | null | undefined) {
  return value == null ? '待复核' : value.toFixed(1);
}

function decisionText(decision: ReviewCaseAssessmentRecord['decision']) {
  return decision === 'approve' ? '通过' : decision === 'changes_requested' ? '需要修改' : '仅评论';
}

function sideLabel(side: Side) {
  return side === 'baseline' ? '旧版' : '新版';
}

function latestAssessments(items: ReviewCaseAssessmentRecord[]) {
  const latest = new Map<string, ReviewCaseAssessmentRecord>();
  for (const item of items) {
    const current = latest.get(item.reviewerId);
    if (!current || current.revision < item.revision) latest.set(item.reviewerId, item);
  }
  return [...latest.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function scoresFrom(assessment?: ReviewCaseAssessmentRecord): StudioManualScores {
  return assessment ? { ...defaultScores, ...assessment.scores } : { ...defaultScores };
}

function ReplyEvidence({ side, item, versionLabel }: { side: Side; item: PromptEvaluationCaseResult | null; versionLabel: string }) {
  return (
    <section className={`studio-review-side ${side}`}>
      <header>
        <div>
          <span className="studio-review-side-label">{sideLabel(side)}</span>
          <strong>{versionLabel}</strong>
        </div>
        <b>{scoreText(item?.total)}</b>
      </header>
      <p className="studio-review-reply">{item?.response || '这一侧没有生成可用回复。'}</p>
      {item?.defects?.length ? (
        <div className="studio-review-defects"><AlertTriangle size={13} />{item.defects.join(' · ')}</div>
      ) : item ? (
        <div className="studio-review-no-defect"><CheckCircle2 size={13} />自动评测未标记缺陷</div>
      ) : null}
      {item?.rationale && <p className="studio-review-rationale">自动评分依据：{item.rationale}</p>}
      <details className="studio-review-raw">
        <summary><ChevronDown size={13} />查看本侧原始证据</summary>
        <pre>{JSON.stringify(item?.rawData ?? null, null, 2)}</pre>
      </details>
    </section>
  );
}

export default function ReviewCaseAssessment({
  reviewId,
  caseItem,
  scorecard,
  baselineLabel,
  candidateLabel,
  currentMemberId,
  canAssess,
  notify,
  onSaved,
}: {
  reviewId: string;
  caseItem: StudioReviewCase;
  scorecard: StudioScorecardData;
  baselineLabel: string;
  candidateLabel: string;
  currentMemberId: string;
  canAssess: boolean;
  notify: (message: string, type?: 'success' | 'error') => void;
  onSaved: () => Promise<void>;
}) {
  const currentAssessment = useMemo(
    () => [...caseItem.assessments]
      .filter((item) => item.reviewerId === currentMemberId)
      .sort((left, right) => right.revision - left.revision)[0],
    [caseItem.assessments, currentMemberId],
  );
  const dimensions = scorecard.dimensions?.length
    ? scorecard.dimensions
    : (Object.keys(defaultScores) as Array<keyof PromptQualityDimensions>).map((key) => ({
      key,
      label: fallbackLabels[key],
      weight: 10,
      description: '',
    }));
  const [scores, setScores] = useState<StudioManualScores>(() => scoresFrom(currentAssessment));
  const [decision, setDecision] = useState<ReviewCaseAssessmentRecord['decision']>(currentAssessment?.decision ?? 'comment');
  const [comment, setComment] = useState(currentAssessment?.comment ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setScores(scoresFrom(currentAssessment));
    setDecision(currentAssessment?.decision ?? 'comment');
    setComment(currentAssessment?.comment ?? '');
  }, [currentAssessment]);

  async function save() {
    if (!comment.trim()) {
      notify('请填写这条案例的评审依据', 'error');
      return;
    }
    setSaving(true);
    try {
      await studioApi.addReviewCaseAssessment(reviewId, caseItem.caseId, { scores, decision, comment });
      notify(`${caseItem.title} 已保存第 ${(currentAssessment?.revision ?? 0) + 1} 次复核`, 'success');
      await onSaved();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setSaving(false);
    }
  }

  const delta = caseItem.baseline?.total != null && caseItem.candidate?.total != null
    ? caseItem.candidate.total - caseItem.baseline.total
    : null;
  const reviewers = latestAssessments(caseItem.assessments);

  return (
    <article className="studio-review-case">
      <header className="studio-review-case-heading">
        <div>
          <span className="studio-case-index">案例 {String(caseItem.caseIndex + 1).padStart(2, '0')} · {caseItem.category}</span>
          <h4>{caseItem.title}</h4>
        </div>
        <span className={`studio-review-case-delta ${delta != null && delta >= 0 ? 'positive' : 'negative'}`}>
          自动分差 {delta == null ? '待复核' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}
        </span>
      </header>
      <div className="studio-review-case-context">
        <div><span>玩家输入</span><p>{caseItem.input || '未提供输入'}</p></div>
        <div><span>期望行为</span><p>{caseItem.expected || '未提供期望行为'}</p></div>
      </div>
      <div className="studio-review-comparison">
        <ReplyEvidence side="baseline" item={caseItem.baseline} versionLabel={baselineLabel} />
        <ReplyEvidence side="candidate" item={caseItem.candidate} versionLabel={candidateLabel} />
      </div>

      <section className="studio-review-assessment">
        <header>
          <div>
            <span className="studio-eyebrow">HUMAN REVIEW</span>
            <h5>逐条人工复核</h5>
            <p>请只根据本条输入、两侧回复和期望行为评分，依据会随修订保留。</p>
          </div>
          {currentAssessment && <span className="studio-review-revision"><Clock3 size={13} />当前第 {currentAssessment.revision} 次</span>}
        </header>
        {canAssess ? (
          <>
            <div className="studio-review-score-grid">
              {dimensions.map((dimension) => (
                <label key={dimension.key}>
                  <span>{dimension.label}<small>{dimension.weight}%</small></span>
                  <select
                    value={scores[dimension.key]}
                    onChange={(event) => setScores((current) => ({ ...current, [dimension.key]: Number(event.target.value) }))}
                  >
                    {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 分</option>)}
                  </select>
                  {dimension.description && <small>{dimension.description}</small>}
                </label>
              ))}
            </div>
            <div className="studio-review-decision-row">
              <span>本条结论</span>
              <div>
                {(['approve', 'changes_requested', 'comment'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`studio-review-decision ${decision === value ? 'active' : ''} ${value}`}
                    onClick={() => setDecision(value)}
                  >
                    {value === 'approve' ? <CheckCircle2 size={14} /> : value === 'changes_requested' ? <RotateCcw size={14} /> : <Database size={14} />}
                    {decisionText(value)}
                  </button>
                ))}
              </div>
            </div>
            <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="写出可被其他评审人复核的具体证据，例如：新版保留了玩家选择，但世界观中的时间线被提前了一步。" />
            <div className="studio-review-save-row">
              <span>服务端会重新计算本条总分并保存完整修订历史。</span>
              <button type="button" className="studio-button primary small" disabled={saving} onClick={() => void save()}><Save size={14} />{saving ? '保存中...' : '保存本条复核'}</button>
            </div>
          </>
        ) : (
          <div className="studio-review-readonly"><UserRound size={16} />当前账号不是指定评审人，只能查看逐案例证据。</div>
        )}
        {reviewers.length > 0 && (
          <div className="studio-review-assessment-history">
            <span>最近提交</span>
            {reviewers.map((item) => <div key={item.reviewerId}><b>{item.reviewerName}</b><em>{decisionText(item.decision)} · {item.overallScore.toFixed(1)} 分 · 第 {item.revision} 次</em><p>{item.comment}</p></div>)}
          </div>
        )}
      </section>
    </article>
  );
}
