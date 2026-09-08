import { Router, type Request, type Response, type NextFunction } from 'express';
import type {
  StudioCreateMemberInput,
  StudioCreateManualAssessmentInput,
  StudioCreateEvaluationInput,
  StudioCreateModelComparisonInput,
  StudioCreateProjectInput,
  StudioCreateResourceInput,
  StudioCreateReviewInput,
  StudioCreateReviewCaseAssessmentInput,
  StudioDebugChatInput,
  StudioMemberRole,
  StudioResourceKind,
} from '../../shared/studio-types.js';
import { runStudioEvaluation } from '../services/studio-evaluation.js';
import { runStudioModelComparison } from '../services/studio-model-comparison.js';
import { getStudioRepository, sanitizeResourceForClient } from '../services/studio-repository.js';
import { requestModelCompletion, type ModelMessage } from '../services/model-provider.js';

const router = Router();
const repository = () => getStudioRepository();
type AuthenticatedStudioRequest = Request & { studioMemberId?: string };

function accessToken(req: Request) {
  const value = req.header('authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : undefined;
}

router.use((req, res, next) => {
  const session = repository().authenticate(accessToken(req));
  if (!session) {
    res.status(401).json({ success: false, error: '请先登录后访问团队工作区' });
    return;
  }
  (req as AuthenticatedStudioRequest).studioMemberId = session.member.id;
  next();
});

function projectId(req: Request, fallback?: string) {
  const value = req.body?.projectId ?? req.query.projectId ?? fallback;
  return typeof value === 'string' && value.trim() ? value.trim() : repository().getProject().id;
}

function memberId(req: Request) {
  return (req as AuthenticatedStudioRequest).studioMemberId;
}

function allow(req: Request, targetProjectId: string, roles: StudioMemberRole[]) {
  return repository().assertProjectPermission(targetProjectId, memberId(req), roles);
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

router.get('/bootstrap', (req, res) => {
  const selectedProjectId = projectId(req);
  const current = allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().getBootstrap(selectedProjectId, current.id));
});

router.get('/resources', (req, res) => {
  const selectedProjectId = projectId(req);
  allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listResources({
    projectId: selectedProjectId,
    kind: typeof req.query.kind === 'string' ? req.query.kind as StudioResourceKind : undefined,
    includeDeleted: req.query.includeDeleted === 'true',
  }).map(sanitizeResourceForClient));
});

router.post('/resources', (req, res) => {
  const selectedProjectId = projectId(req);
  const current = allow(req, selectedProjectId, ['owner', 'editor']);
  res.status(201).json(sanitizeResourceForClient(repository().createResource({ ...req.body, projectId: selectedProjectId } as StudioCreateResourceInput, current.name)));
});

router.patch('/resources/:resourceId', (req, res) => {
  const resource = repository().getResource(req.params.resourceId, true);
  const current = allow(req, resource.projectId, ['owner', 'editor']);
  res.json(sanitizeResourceForClient(repository().updateResource(req.params.resourceId, req.body ?? {}, current.name)));
});

router.delete('/resources/:resourceId', (req, res) => {
  const resource = repository().getResource(req.params.resourceId, true);
  const current = allow(req, resource.projectId, ['owner', 'editor']);
  repository().deleteResource(req.params.resourceId, current.name);
  res.status(204).end();
});

router.post('/resources/:resourceId/restore', (req, res) => {
  const resource = repository().getResource(req.params.resourceId, true);
  const current = allow(req, resource.projectId, ['owner', 'editor']);
  res.json(sanitizeResourceForClient(repository().restoreResource(req.params.resourceId, current.name)));
});

router.delete('/resources/:resourceId/permanent', (req, res) => {
  const resource = repository().getResource(req.params.resourceId, true);
  const current = allow(req, resource.projectId, ['owner']);
  repository().permanentlyDeleteResource(req.params.resourceId, current.name);
  res.status(204).end();
});

router.get('/prompts/:promptId/versions', (req, res) => {
  const prompt = repository().getResource(req.params.promptId);
  allow(req, prompt.projectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listPromptVersions(req.params.promptId));
});

router.post('/prompts/:promptId/versions', (req, res) => {
  const prompt = repository().getResource(req.params.promptId);
  const current = allow(req, prompt.projectId, ['owner', 'editor']);
  res.status(201).json(repository().createPromptVersion(req.params.promptId, {
    title: req.body?.title,
    summary: req.body?.summary,
    snapshot: req.body?.snapshot,
    createdBy: current.name,
  }));
});

router.post('/prompts/:promptId/versions/:versionId/publish', (req, res) => {
  const prompt = repository().getResource(req.params.promptId);
  const current = allow(req, prompt.projectId, ['owner']);
  res.json(repository().publishPromptVersion(
    req.params.promptId,
    req.params.versionId,
    current.name,
  ));
});

router.get('/evaluations', (req, res) => {
  const selectedProjectId = projectId(req);
  allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listEvaluations(req.query.includeDeleted === 'true', selectedProjectId));
});

router.post('/evaluations', (req, res) => {
  const selectedProjectId = projectId(req);
  const current = allow(req, selectedProjectId, ['owner', 'editor']);
  res.status(201).json(repository().createEvaluation({
    ...req.body,
    projectId: selectedProjectId,
    createdBy: current.name,
  } as StudioCreateEvaluationInput));
});

router.get('/evaluations/:evaluationId', (req, res) => {
  const evaluation = repository().getEvaluation(req.params.evaluationId);
  allow(req, evaluation.projectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(evaluation);
});

router.post('/evaluations/:evaluationId/run', asyncRoute(async (req, res) => {
  const evaluation = repository().getEvaluation(req.params.evaluationId);
  allow(req, evaluation.projectId, ['owner', 'editor']);
  res.json(await runStudioEvaluation(req.params.evaluationId));
}));

router.post('/evaluations/:evaluationId/archive', (req, res) => {
  const evaluation = repository().getEvaluation(req.params.evaluationId);
  const current = allow(req, evaluation.projectId, ['owner', 'editor']);
  res.json(repository().archiveEvaluation(req.params.evaluationId, current.name));
});

router.get('/model-comparisons', (req, res) => {
  const selectedProjectId = projectId(req);
  allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listModelComparisons(selectedProjectId));
});

router.post('/model-comparisons', (req, res) => {
  const selectedProjectId = projectId(req);
  const current = allow(req, selectedProjectId, ['owner', 'editor']);
  res.status(201).json(repository().createModelComparison({
    ...req.body,
    projectId: selectedProjectId,
    createdBy: current.name,
  } as StudioCreateModelComparisonInput));
});

router.post('/model-comparisons/:comparisonId/run', asyncRoute(async (req, res) => {
  const comparison = repository().getModelComparison(req.params.comparisonId);
  allow(req, comparison.projectId, ['owner', 'editor']);
  res.json(await runStudioModelComparison(comparison.id));
}));

router.post('/model-comparisons/:comparisonId/archive', (req, res) => {
  const comparison = repository().getModelComparison(req.params.comparisonId);
  const current = allow(req, comparison.projectId, ['owner', 'editor']);
  res.json(repository().archiveModelComparison(comparison.id, current.name));
});

router.post('/debug/chat', asyncRoute(async (req, res) => {
  const input = req.body as StudioDebugChatInput;
  if (!input || typeof input.modelConfigResourceId !== 'string' || !input.modelConfigResourceId.trim()) {
    throw new Error('请选择模型卡');
  }
  const selectedProjectId = projectId(req, input?.projectId);
  allow(req, selectedProjectId, ['owner', 'editor', 'reviewer']);
  const resource = repository().getResource(input?.modelConfigResourceId, true);
  if (resource.projectId !== selectedProjectId || resource.kind !== 'model-config') {
    throw new Error('请选择当前项目中的模型卡');
  }
  const systemPrompt = typeof input?.systemPrompt === 'string' ? input.systemPrompt.trim() : '';
  if (!systemPrompt) throw new Error('System Prompt 不能为空');
  const messages: ModelMessage[] = Array.isArray(input?.messages)
    ? input.messages
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
      .slice(-80)
      .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 20000) }))
      .filter((item) => item.content)
    : [];
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new Error('调试请求必须以一条用户消息结束');
  }
  const startedAt = Date.now();
  const completion = await requestModelCompletion(
    repository().getModelConfigForUse(resource.id, selectedProjectId),
    [{ role: 'system', content: systemPrompt }, ...messages],
    input?.overrides ?? {},
  );
  res.json({
    text: completion.text,
    totalTokens: completion.totalTokens,
    latencyMs: Date.now() - startedAt,
    provider: resource.data.provider ?? '未命名供应商',
    model: resource.data.model ?? '未命名模型',
    appliedParameters: completion.appliedParameters,
    omittedParameters: completion.omittedParameters,
  });
}));

router.get('/projects', (req, res) => {
  allow(req, repository().getProject().id, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listProjects(true));
});

router.post('/projects', (req, res) => {
  const current = allow(req, repository().getProject().id, ['owner']);
  res.status(201).json(repository().createProject(req.body as StudioCreateProjectInput, current));
});

router.patch('/projects/:projectId', (req, res) => {
  const current = allow(req, req.params.projectId, ['owner']);
  res.json(repository().updateProject(req.params.projectId, req.body ?? {}, current));
});

router.post('/projects/:projectId/members/:memberId', (req, res) => {
  const current = allow(req, req.params.projectId, ['owner']);
  res.json(repository().setProjectMember(req.params.projectId, req.params.memberId, req.body?.role, current));
});

router.delete('/projects/:projectId/members/:memberId', (req, res) => {
  const current = allow(req, req.params.projectId, ['owner']);
  res.json(repository().removeProjectMember(req.params.projectId, req.params.memberId, current));
});

router.get('/members', (req, res) => {
  allow(req, repository().getProject().id, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listMembers());
});

router.post('/members', (req, res) => {
  const current = allow(req, repository().getProject().id, ['owner']);
  res.status(201).json(repository().createMember(req.body as StudioCreateMemberInput, current));
});

router.patch('/members/:memberId', (req, res) => {
  const current = allow(req, repository().getProject().id, ['owner']);
  res.json(repository().updateMember(req.params.memberId, req.body ?? {}, current));
});

router.get('/reviews', (req, res) => {
  const selectedProjectId = projectId(req);
  allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.json(repository().listReviews(selectedProjectId));
});

router.post('/reviews', (req, res) => {
  const selectedProjectId = projectId(req);
  const current = allow(req, selectedProjectId, ['owner', 'editor']);
  res.status(201).json(repository().createReview({ ...req.body, projectId: selectedProjectId } as StudioCreateReviewInput, current));
});

router.post('/reviews/:reviewId/comments', (req, res) => {
  const review = repository().listReviews(projectId(req)).find((item) => item.id === req.params.reviewId);
  if (!review) throw new Error('评审不存在或不属于当前项目');
  const current = allow(req, review.projectId, ['owner', 'editor', 'reviewer']);
  res.json(repository().addReviewComment(req.params.reviewId, req.body?.content, req.body?.decision, current));
});

router.post('/reviews/:reviewId/cases/:caseId/assessments', (req, res) => {
  const review = repository().listReviews(projectId(req)).find((item) => item.id === req.params.reviewId);
  if (!review) throw new Error('评审不存在或不属于当前项目');
  const current = allow(req, review.projectId, ['owner', 'editor', 'reviewer']);
  res.json(repository().addReviewCaseAssessment(
    req.params.reviewId,
    req.params.caseId,
    req.body as StudioCreateReviewCaseAssessmentInput,
    current,
  ));
});

router.get('/manual-assessments', (req, res) => {
  const selectedProjectId = projectId(req);
  allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined;
  res.json(repository().listManualAssessments(selectedProjectId, versionId));
});

router.post('/manual-assessments', (req, res) => {
  const selectedProjectId = projectId(req);
  const current = allow(req, selectedProjectId, ['owner', 'editor', 'reviewer', 'viewer']);
  res.status(201).json(repository().createManualAssessment({
    ...req.body,
    projectId: selectedProjectId,
  } as StudioCreateManualAssessmentInput, current));
});

export default router;
