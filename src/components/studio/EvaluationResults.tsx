import { AlertTriangle, CheckCircle2, ChevronDown, Database, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { StudioEvaluation } from '../../../shared/studio-types';
import type { PromptQualityDimensions } from '../../../shared/types';

const labels: Array<[keyof PromptQualityDimensions, string]> = [
  ['instruction', '玩家指令遵循'],
  ['relevance', '相关性与连续性'],
  ['agency', '玩家行动权'],
  ['logic', '剧情合理性'],
  ['interest', '剧情有趣性'],
  ['persona', '人设与角色边界'],
  ['tone', '语气风格差异'],
  ['world', '世界观遵循'],
  ['group', '群像协作'],
  ['style', '表达与节奏'],
];

function score(value: number | null) {
  return value == null ? '不可用' : value.toFixed(1);
}

function caseScore(item?: { total: number | null; defects: string[]; rationale?: string }) {
  if (!item || item.total == null) return null;
  if (item.defects.includes('评审模型不可用') || item.defects.includes('模型服务不可用')) return null;
  if (!item.rationale?.trim()) return null;
  return item.total;
}

function Delta({ value }: { value?: number }) {
  if (value == null) return <span className="studio-delta neutral">-</span>;
  if (value > 0) return <span className="studio-delta positive"><TrendingUp size={13} />+{value}</span>;
  if (value < 0) return <span className="studio-delta negative"><TrendingDown size={13} />{value}</span>;
  return <span className="studio-delta neutral"><Minus size={13} />0</span>;
}

export default function EvaluationResults({ evaluation }: { evaluation: StudioEvaluation }) {
  const result = evaluation.result;
  if (!result) {
    return (
      <div className="studio-empty">
        <Database size={20} />
        <strong>还没有运行证据</strong>
        <span>创建评测后点击“开始 AI 评测”，两侧会使用同一份冻结条件。</span>
      </div>
    );
  }
  const baselineCases = result.baseline.cases;
  const candidateCases = result.candidate.cases;
  const pairedCaseCount = result.pairedCaseCount
    ?? evaluation.sharedConfig.cases.filter((testCase) => {
      const baseline = baselineCases.find((item) => item.caseId === testCase.id);
      const candidate = candidateCases.find((item) => item.caseId === testCase.id);
      return caseScore(baseline) !== null && caseScore(candidate) !== null;
    }).length;
  const totalCaseCount = result.totalCaseCount ?? evaluation.sharedConfig.cases.length;
  const winnerText = result.winner === 'candidate'
    ? '新版领先'
    : result.winner === 'baseline'
      ? '旧版领先'
      : result.winner === 'tie'
        ? '两版持平'
        : '暂不可比较';

  return (
    <div className="studio-results">
      {(result.baseline.error || result.candidate.error) && (
        <div className="studio-error">
          <AlertTriangle size={16} />
          有一侧服务失败，缺失分数保留为空，不按 0 分计算。
        </div>
      )}
      {pairedCaseCount < totalCaseCount && (
        <div className="studio-warning">
          <AlertTriangle size={16} />
          本次只有 {pairedCaseCount}/{totalCaseCount} 条案例可成对比较；缺失案例显示为“待复核”，不会参与后续运行的总分。
        </div>
      )}

      <section className="studio-result-summary">
        <div>
          <span>旧版 v{result.baseline.versionNumber}</span>
          <strong>{score(result.baseline.totalScore)}</strong>
          <small>{result.baseline.versionTitle}</small>
          <em>成对案例 {pairedCaseCount}/{totalCaseCount}</em>
        </div>
        <div className="studio-result-winner">
          <span>新版相对变化</span>
          <strong className={result.totalDelta != null && result.totalDelta >= 0 ? 'positive' : 'negative'}>
            {result.totalDelta == null ? '-' : `${result.totalDelta > 0 ? '+' : ''}${result.totalDelta}`}
          </strong>
          <small>{winnerText}</small>
        </div>
        <div>
          <span>新版 v{result.candidate.versionNumber}</span>
          <strong>{score(result.candidate.totalScore)}</strong>
          <small>{result.candidate.versionTitle}</small>
          <em>成对案例 {pairedCaseCount}/{totalCaseCount}</em>
        </div>
      </section>

      <section className="studio-section-block">
        <header>
          <div>
            <h3>十维评分差异</h3>
            <p>正数表示新版提升；评分缺失时不生成差值。</p>
          </div>
        </header>
        <div className="studio-score-table">
          <div className="studio-score-head">
            <span>维度</span><span>旧版</span><span>新版</span><span>变化</span>
          </div>
          {labels.map(([key, label]) => (
            <div className="studio-score-row" key={key}>
              <span>{label}</span>
              <span>{result.baseline.dimensions?.[key] ?? '-'}</span>
              <span>{result.candidate.dimensions?.[key] ?? '-'}</span>
              <Delta value={result.dimensionDeltas[key]} />
            </div>
          ))}
        </div>
      </section>

      <section className="studio-section-block">
        <header>
          <div>
            <h3>逐案例原始对比</h3>
            <p>每条输入完全相同，回复、缺陷、评分依据和模型原文均保留。</p>
          </div>
          <span className="studio-count">{Math.max(baselineCases.length, candidateCases.length)} 条</span>
        </header>
        <div className="studio-case-results">
          {evaluation.sharedConfig.cases.map((testCase, index) => {
            const baseline = baselineCases.find((item) => item.caseId === testCase.id);
            const candidate = candidateCases.find((item) => item.caseId === testCase.id);
            return (
              <article className="studio-case-result" key={testCase.id}>
                <div className="studio-case-context">
                  <span>案例 {index + 1} · {testCase.category}</span>
                  <h4>{testCase.title}</h4>
                  <p>{testCase.input}</p>
                  <small>期望：{testCase.expected}</small>
                </div>
                <div className="studio-comparison-grid">
                  <div>
                    <header>
                      <span>旧版</span>
                      <strong>{caseScore(baseline) ?? '待复核'}</strong>
                    </header>
                    <p className="studio-reply">{baseline?.response || '没有可用回复'}</p>
                    {baseline?.defects.length ? (
                      <div className="studio-defects">{baseline.defects.join(' · ')}</div>
                    ) : baseline ? (
                      <div className="studio-no-defect"><CheckCircle2 size={13} />未标记缺陷</div>
                    ) : null}
                    {baseline?.rationale && <small>{baseline.rationale}</small>}
                  </div>
                  <div>
                    <header>
                      <span>新版</span>
                      <strong>{caseScore(candidate) ?? '待复核'}</strong>
                    </header>
                    <p className="studio-reply">{candidate?.response || '没有可用回复'}</p>
                    {candidate?.defects.length ? (
                      <div className="studio-defects">{candidate.defects.join(' · ')}</div>
                    ) : candidate ? (
                      <div className="studio-no-defect"><CheckCircle2 size={13} />未标记缺陷</div>
                    ) : null}
                    {candidate?.rationale && <small>{candidate.rationale}</small>}
                  </div>
                </div>
                <details className="studio-raw-details">
                  <summary><ChevronDown size={14} />查看原始请求与评分响应</summary>
                  <div className="studio-comparison-grid">
                    <pre>{JSON.stringify(baseline?.rawData ?? null, null, 2)}</pre>
                    <pre>{JSON.stringify(candidate?.rawData ?? null, null, 2)}</pre>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
