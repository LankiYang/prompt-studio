import type { PromptBuilderItem, PromptQualityDimensions, PromptTestSuite } from '../../shared/types.js';
import type { StudioModelComparison, StudioModelComparisonSideResult } from '../../shared/studio-types.js';
import { runPromptQualityEvaluation } from './prompt-evaluation.js';
import { getStudioRepository } from './studio-repository.js';

const dimensionKeys: Array<keyof PromptQualityDimensions> = [
  'instruction', 'relevance', 'agency', 'logic', 'interest',
  'persona', 'tone', 'world', 'group', 'style',
];

function averageValidDimensions(cases: Awaited<ReturnType<typeof runPromptQualityEvaluation>>['cases']): PromptQualityDimensions | null {
  const valid = cases.filter((item) => item.dimensions && item.total !== null
    && !item.defects.includes('模型服务不可用')
    && !item.defects.includes('评审模型不可用')
    && !item.defects.includes('空回复'));
  if (!valid.length) return null;
  const result = Object.fromEntries(dimensionKeys.map((key) => [key, 0])) as unknown as PromptQualityDimensions;
  for (const key of dimensionKeys) {
    result[key] = Math.round(valid.reduce((sum, item) => sum + item.dimensions![key], 0) / valid.length * 10) / 10;
  }
  return result;
}

function totalOf(dimensions: PromptQualityDimensions) {
  return Math.round(Object.values(dimensions).reduce((sum, value) => sum + value, 0) * 10) / 10;
}

async function runModelSide(
  comparison: StudioModelComparison,
  model: StudioModelComparison['sharedConfig']['targetModels'][number],
): Promise<StudioModelComparisonSideResult> {
  const shared = comparison.sharedConfig;
  const repository = getStudioRepository();
  const version = repository.getPromptVersion(comparison.versionId);
  const suite: PromptTestSuite = {
    id: shared.suiteResourceId,
    name: shared.suiteName,
    description: '模型横评创建时冻结的测试集快照。',
    cases: shared.cases,
    updatedAt: comparison.createdAt,
  };
  const snapshot: PromptBuilderItem = {
    ...structuredClone(version.snapshot),
    id: 'studio-model-comparison',
    label: `模型横评：${model.name}`,
    characters: shared.characters,
    worldSetting: shared.worldSetting,
    maxSpeakers: shared.schedulerPolicy.maxSpeakers,
  };
  try {
    const quality = await runPromptQualityEvaluation(snapshot, suite, {
      characters: shared.characters,
      worldSetting: shared.worldSetting,
      modelConfig: repository.getModelConfigForUse(model.resourceId, comparison.projectId, model.config),
      judgeModelConfig: repository.getModelConfigForUse(
        shared.judgeModelConfigResourceId,
        comparison.projectId,
        shared.judgeModelConfig,
      ),
      scorecard: shared.scorecard,
    });
    const dimensions = averageValidDimensions(quality.cases);
    return {
      modelResourceId: model.resourceId,
      modelName: model.name,
      versionId: version.id,
      versionNumber: version.number,
      versionTitle: version.title,
      totalScore: dimensions ? totalOf(dimensions) : null,
      dimensions,
      responseValidity: quality.responseValidity,
      averageLength: quality.averageLength,
      notes: quality.notes,
      cases: quality.cases,
    };
  } catch (error) {
    return {
      modelResourceId: model.resourceId,
      modelName: model.name,
      versionId: version.id,
      versionNumber: version.number,
      versionTitle: version.title,
      totalScore: null,
      dimensions: null,
      responseValidity: null,
      averageLength: null,
      notes: ['该模型调用失败，未使用 0 分替代缺失结果。'],
      cases: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runStudioModelComparison(comparisonId: string) {
  const repository = getStudioRepository();
  const comparison = repository.getModelComparison(comparisonId);
  if (comparison.status === 'running') throw new Error('该模型横评正在运行');
  if (comparison.status === 'archived') throw new Error('归档横评不能直接重跑，请复制后创建新横评');
  repository.updateModelComparisonState(comparison.id, 'running', null, null);
  const models = await Promise.all(comparison.sharedConfig.targetModels.map((model) => runModelSide(comparison, model)));
  const ranking = models.filter((item) => item.totalScore !== null)
    .sort((left, right) => right.totalScore! - left.totalScore!)
    .map((item) => item.modelResourceId);
  const errors = models.filter((item) => item.error).map((item) => `${item.modelName}：${item.error}`);
  return repository.updateModelComparisonState(comparison.id, errors.length ? 'failed' : 'completed', {
    models,
    ranking,
    totalCaseCount: comparison.sharedConfig.cases.length,
    completedAt: Date.now(),
  }, errors.length ? errors.join('；') : null);
}
