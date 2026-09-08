import { AlertTriangle, CheckCircle2, ChevronDown, Database } from 'lucide-react';
import type { StudioModelComparison } from '../../../shared/studio-types';

function score(value: number | null) {
  return value == null ? '待复核' : value.toFixed(1);
}

export default function ModelComparisonResults({ comparison }: { comparison: StudioModelComparison }) {
  const result = comparison.result;
  if (!result) return <div className="studio-empty"><Database size={20} /><strong>还没有运行证据</strong><span>每个被测模型会使用同一份冻结 Prompt、测试集与裁判模型。</span></div>;
  const ordered = [...result.models].sort((left, right) => {
    const leftRank = result.ranking.indexOf(left.modelResourceId);
    const rightRank = result.ranking.indexOf(right.modelResourceId);
    return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank) - (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank);
  });
  return <div className="studio-results">
    {comparison.error && <div className="studio-error"><AlertTriangle size={16} />部分模型服务失败，缺失结果不按 0 分参与排名。</div>}
    <section className="studio-section-block">
      <header><div><h3>模型排名</h3><p>固定 Prompt、案例、角色、世界观与裁判模型；总分仅用于排序，需结合案例复核。</p></div><span className="studio-count">{ordered.length} 个模型</span></header>
      <div className="studio-model-ranking">
        {ordered.map((item, index) => <article key={item.modelResourceId} className={index === 0 && item.totalScore !== null ? 'leader' : ''}>
          <span>#{item.totalScore === null ? '-' : index + 1}</span><div><strong>{item.modelName}</strong><small>{item.responseValidity ?? 0}% 有效回复 · 平均 {item.averageLength ?? '-'} 字</small></div><b>{score(item.totalScore)}</b>
        </article>)}
      </div>
    </section>
    <section className="studio-section-block">
      <header><div><h3>逐案例横向对比</h3><p>每一列保留该模型的回复、缺陷、评分依据及原始请求。</p></div></header>
      <div className="studio-case-results">
        {comparison.sharedConfig.cases.map((testCase, index) => <article className="studio-case-result" key={testCase.id}>
          <div className="studio-case-context"><span>案例 {index + 1} · {testCase.category}</span><h4>{testCase.title}</h4><p>{testCase.input}</p><small>期望：{testCase.expected}</small></div>
          <div className="studio-model-case-grid">
            {ordered.map((model) => {
              const item = model.cases.find((entry) => entry.caseId === testCase.id);
              return <div key={model.modelResourceId}><header><span>{model.modelName}</span><strong>{score(item?.total ?? null)}</strong></header><p className="studio-reply">{item?.response || '没有可用回复'}</p>{item?.defects.length ? <div className="studio-defects">{item.defects.join(' · ')}</div> : item ? <div className="studio-no-defect"><CheckCircle2 size={13} />未标记缺陷</div> : null}{item?.rationale && <small>{item.rationale}</small>}<details className="studio-raw-details"><summary><ChevronDown size={14} />原始数据</summary><pre>{JSON.stringify(item?.rawData ?? null, null, 2)}</pre></details></div>;
            })}
          </div>
        </article>)}
      </div>
    </section>
  </div>;
}
