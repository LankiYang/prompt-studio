import type {
  PromptBuilderItem,
  PromptQualityDimensions,
  PromptTestSuite,
} from '../../shared/types.js';
import type {
  StudioEvaluation,
  StudioEvaluationResult,
  StudioEvaluationSideResult,
  StudioPromptVersion,
} from '../../shared/studio-types.js';
import { runPromptQualityEvaluation } from './prompt-evaluation.js';
import { getStudioRepository } from './studio-repository.js';

const dimensionKeys: Array<keyof PromptQualityDimensions> = [
  'instruction',
  'relevance',
  'agency',
  'logic',
  'interest',
  'persona',
  'tone',
  'world',
  'group',
  'style',
];

function totalOf(dimensions: PromptQualityDimensions) {
  return Object.values(dimensions).reduce((sum, value) => sum + value, 0);
}

function averageValidDimensions(
  cases: Awaited<ReturnType<typeof runPromptQualityEvaluation>>['cases'],
): PromptQualityDimensions | null {
  const validCases = cases.filter((item) =>
    item.dimensions !== null
    && item.total !== null
    && !item.defects.includes('评审模型不可用')
    && !item.defects.includes('模型服务不可用')
    && !item.defects.includes('空回复'),
  );
  if (!validCases.length) return null;
  const result = Object.fromEntries(dimensionKeys.map((key) => [key, 0])) as unknown as PromptQualityDimensions;
  for (const key of dimensionKeys) {
    result[key] = Math.round(
      validCases.reduce((sum, item) => sum + item.dimensions![key], 0) / validCases.length * 10,
    ) / 10;
  }
  return result;
}

async function runSide(
  version: StudioPromptVersion,
  evaluation: StudioEvaluation,
): Promise<StudioEvaluationSideResult> {
  const shared = evaluation.sharedConfig;
  const repository = getStudioRepository();
  const suite: PromptTestSuite = {
    id: shared.suiteResourceId,
    name: shared.suiteName,
    description: '评测创建时冻结的测试集快照。',
    cases: shared.cases,
    updatedAt: evaluation.createdAt,
  };
  const snapshot: PromptBuilderItem = {
    ...structuredClone(version.snapshot),
    id: 'studio-evaluation',
    label: '受控版本评测',
    characters: shared.characters,
    worldSetting: shared.worldSetting,
    maxSpeakers: shared.schedulerPolicy.maxSpeakers,
  };
  try {
    const quality = await runPromptQualityEvaluation(snapshot, suite, {
      characters: shared.characters,
      worldSetting: shared.worldSetting,
      modelConfig: repository.getModelConfigForUse(
        shared.modelConfigResourceId,
        evaluation.projectId,
        shared.modelConfig,
      ),
      scorecard: shared.scorecard,
    });
    const dimensions = averageValidDimensions(quality.cases);
    return {
      versionId: version.id,
      versionNumber: version.number,
      versionTitle: version.title,
      totalScore: dimensions ? Math.round(totalOf(dimensions) * 10) / 10 : null,
      dimensions,
      responseValidity: quality.responseValidity,
      averageLength: quality.averageLength,
      notes: quality.notes,
      cases: quality.cases,
    };
  } catch (error) {
    return {
      versionId: version.id,
      versionNumber: version.number,
      versionTitle: version.title,
      totalScore: null,
      dimensions: null,
      responseValidity: null,
      averageLength: null,
      notes: ['该侧评测失败，未使用 0 分替代缺失分数。'],
      cases: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runStudioEvaluation(evaluationId: string) {
  const repository = getStudioRepository();
  const evaluation = repository.getEvaluation(evaluationId);
  if (evaluation.status === 'running') throw new Error('该评测正在运行');
  if (evaluation.status === 'archived') throw new Error('归档评测不能直接重跑，请复制后创建新评测');

  const baselineVersion = repository.getPromptVersion(evaluation.baselineVersionId);
  const candidateVersion = repository.getPromptVersion(evaluation.candidateVersionId);
  repository.updateEvaluationState(evaluation.id, 'running', null, null);

  const [baseline, candidate] = await Promise.all([
    runSide(baselineVersion, evaluation),
    runSide(candidateVersion, evaluation),
  ]);
  const pairedCaseIds = new Set(
    baseline.cases
      .filter((item) => item.total !== null && item.dimensions !== null && Boolean(item.rationale.trim()))
      .map((item) => item.caseId)
      .filter((caseId) => {
        const matching = candidate.cases.find((item) => item.caseId === caseId);
        return matching?.total !== null
          && matching?.dimensions !== null
          && Boolean(matching.rationale.trim());
      }),
  );
  baseline.dimensions = averageValidDimensions(
    baseline.cases.filter((item) => pairedCaseIds.has(item.caseId)),
  );
  candidate.dimensions = averageValidDimensions(
    candidate.cases.filter((item) => pairedCaseIds.has(item.caseId)),
  );
  baseline.totalScore = baseline.dimensions
    ? Math.round(totalOf(baseline.dimensions) * 10) / 10
    : null;
  candidate.totalScore = candidate.dimensions
    ? Math.round(totalOf(candidate.dimensions) * 10) / 10
    : null;
  baseline.notes.push(`成对可比案例 ${pairedCaseIds.size}/${evaluation.sharedConfig.cases.length}。`);
  candidate.notes.push(`成对可比案例 ${pairedCaseIds.size}/${evaluation.sharedConfig.cases.length}。`);
  const comparable = baseline.totalScore != null && candidate.totalScore != null;
  const totalDelta = comparable
    ? Math.round((candidate.totalScore! - baseline.totalScore!) * 10) / 10
    : null;
  const dimensionDeltas: StudioEvaluationResult['dimensionDeltas'] = {};
  if (baseline.dimensions && candidate.dimensions) {
    for (const key of dimensionKeys) {
      dimensionDeltas[key] = Math.round(
        (candidate.dimensions[key] - baseline.dimensions[key]) * 10,
      ) / 10;
    }
  }
  const winner: StudioEvaluationResult['winner'] = !comparable
    ? 'unavailable'
    : totalDelta === 0
      ? 'tie'
      : totalDelta! > 0
        ? 'candidate'
        : 'baseline';
  const result: StudioEvaluationResult = {
    baseline,
    candidate,
    totalDelta,
    dimensionDeltas,
    winner,
    pairedCaseCount: pairedCaseIds.size,
    totalCaseCount: evaluation.sharedConfig.cases.length,
    completedAt: Date.now(),
  };
  const errors = [baseline.error, candidate.error].filter(Boolean);
  return repository.updateEvaluationState(
    evaluation.id,
    errors.length ? 'failed' : 'completed',
    result,
    errors.length ? errors.join('；') : null,
  );
}
