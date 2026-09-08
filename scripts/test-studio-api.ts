import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type {
  StudioBootstrap,
  StudioEvaluation,
  StudioManualAssessment,
  StudioModelComparison,
  StudioMember,
  StudioProject,
  StudioPromptVersion,
  StudioReviewRequest,
  StudioResource,
  StudioEvaluationResult,
  StudioDebugChatResult,
} from '../shared/studio-types.js';
import type { PromptEvaluationCaseResult } from '../shared/types.js';

const testDir = path.resolve('data', 'test-results');
const databaseFile = path.join(testDir, 'studio-api-test.db');
if (!databaseFile.startsWith(testDir + path.sep)) {
  throw new Error('测试数据库路径越界');
}
fs.mkdirSync(testDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(databaseFile + suffix, { force: true });
}
process.env.PROMPT_STUDIO_DB_FILE = databaseFile;
const runAi = process.argv.includes('--ai');

const { default: app } = await import('../api/app.js');
const { closeStudioRepositoryForTests, getStudioRepository } = await import('../api/services/studio-repository.js');
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}/api/studio`;
const authUrl = `http://127.0.0.1:${port}/api/auth`;
let currentToken = '';
let modelServer: ReturnType<typeof createServer> | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function request<T>(url: string, method = 'GET', body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ?? currentToken ? { Authorization: `Bearer ${token ?? currentToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

async function authRequest<T>(url: string, method = 'GET', body?: unknown, token = currentToken): Promise<T> {
  const response = await fetch(`${authUrl}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

try {
  const setupResponse = await fetch(`${authUrl}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '自动测试负责人', username: 'own', password: 'pwd' }),
  });
  const setup = await setupResponse.json() as { token: string };
  assert(setupResponse.status === 201 && setup.token, '首次初始化应创建负责人登录会话');
  const ownerToken = setup.token;
  currentToken = ownerToken;
  const restoredOwner = await authRequest<{ member: StudioMember }>('/me');
  assert(restoredOwner.member.username === 'own', '浏览器缓存令牌后应可恢复负责人会话');
  const unauthenticated = await fetch(`${baseUrl}/bootstrap`);
  assert(unauthenticated.status === 401, 'Studio API 不应接受未登录请求');
  const bootstrap = await request<StudioBootstrap>('/bootstrap', 'GET', undefined, ownerToken);
  assert(bootstrap.resources.some((item) => item.kind === 'prompt'), '迁移后应存在 Prompt');
  assert(bootstrap.promptVersions.length >= 2, '迁移后应存在旧版与新版');
  assert(
    bootstrap.promptVersions.every((item) => !/builder\s*[abc]/i.test(`${item.title} ${item.snapshot.label}`)),
    '新平台不应暴露 Builder A/B/C',
  );
  assert(bootstrap.organization.name, '迁移后应存在默认组织');
  assert(bootstrap.currentMember.role === 'owner', '默认成员应是项目负责人');

  const reviewer = await authRequest<StudioMember>('/accounts', 'POST', {
    name: '评审自测成员',
    username: 'rev',
    password: 'pwd',
    role: 'reviewer',
    projectId: bootstrap.project.id,
    projectRole: 'reviewer',
  }, ownerToken);
  const reviewerLogin = await authRequest<{ token: string }>('/login', 'POST', {
    username: 'rev',
    password: 'pwd',
  });
  const reviewerToken = reviewerLogin.token;
  const restoredReviewer = await authRequest<{ member: StudioMember }>('/me', 'GET', undefined, reviewerToken);
  assert(restoredReviewer.member.id === reviewer.id, '成员登录后应恢复自身身份而非负责人身份');

  const forbidden = await fetch(`${baseUrl}/resources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reviewerToken}` },
    body: JSON.stringify({ kind: 'world', name: '不应创建的资源' }),
  });
  assert(forbidden.status === 403, '评审者不应拥有资源编辑权限');

  const collaborationProject = await request<StudioProject>('/projects', 'POST', {
    name: '协作隔离自测项目',
    description: '验证项目级资源隔离。',
  });
  const projectBootstrap = await request<StudioBootstrap>(`/bootstrap?projectId=${collaborationProject.id}`);
  assert(projectBootstrap.project.id === collaborationProject.id, '应可切换到新建项目');
  assert(projectBootstrap.resources.length === 0, '新项目不应自动读取默认项目资产');

  const character = await request<StudioResource>('/resources', 'POST', {
    kind: 'character',
    name: 'API 自测角色',
    description: '验证资源 CRUD',
    owner: '自动测试',
    tags: ['test'],
    data: { name: 'API 自测角色', persona: '只用于自动测试。' },
  });
  const updated = await request<StudioResource>(`/resources/${character.id}`, 'PATCH', {
    name: 'API 自测角色（已更新）',
    data: { name: 'API 自测角色', persona: '已通过更新接口。' },
  });
  assert(updated.name.includes('已更新'), '资源更新应生效');
  await request<void>(`/resources/${character.id}`, 'DELETE');
  const recycled = await request<StudioBootstrap>('/bootstrap');
  assert(recycled.resources.find((item) => item.id === character.id)?.deletedAt, '资源应软删除');
  const restored = await request<StudioResource>(`/resources/${character.id}/restore`, 'POST');
  assert(restored.deletedAt === null, '资源应可恢复');
  await request<void>(`/resources/${character.id}`, 'DELETE');
  await request<void>(`/resources/${character.id}/permanent`, 'DELETE');
  const afterPermanentDelete = await request<StudioBootstrap>('/bootstrap');
  assert(!afterPermanentDelete.resources.some((item) => item.id === character.id), '未引用资源应可永久删除');

  const prompt = await request<StudioResource>('/resources', 'POST', {
    kind: 'prompt',
    name: 'API 自测 Prompt',
    description: '验证不可变版本',
    owner: '自动测试',
    data: {},
  });
  let promptVersions = (await request<StudioBootstrap>('/bootstrap')).promptVersions
    .filter((item) => item.promptId === prompt.id);
  assert(promptVersions.length === 1, '新建 Prompt 应自动创建初始版本');
  const version = await request<StudioPromptVersion>(`/prompts/${prompt.id}/versions`, 'POST', {
    title: '候选版本',
    summary: 'API 自动测试',
    snapshot: {
      id: 'studio-evaluation',
      label: 'API 自测 Prompt',
      template: '你是{{roleName}}。\n人设：{{rolePersona}}\n背景：{{storyBackground}}\n消息：{{latestMessage}}\n只输出一句简短回应。',
    },
  });
  promptVersions = await request<StudioPromptVersion[]>(`/prompts/${prompt.id}/versions/${version.id}/publish`, 'POST');
  assert(promptVersions.find((item) => item.id === version.id)?.status === 'published', '版本应可发布');

  const suite = await request<StudioResource>('/resources', 'POST', {
    kind: 'test-suite',
    name: 'API 单案例测试集',
    description: '用于端到端 API 测试',
    owner: '自动测试',
    data: {
      cases: [{
        id: 'api-case-1',
        title: '直接回应',
        category: '指令遵循',
        input: '告诉我现在在哪里。',
        expected: '根据世界观直接回答，不替玩家行动。',
        labels: ['test'],
      }],
    },
  });
  const baseline = promptVersions.find((item) => item.number === 1)!;
  const evaluation = await request<StudioEvaluation>('/evaluations', 'POST', {
    name: 'API 旧版 / 新版自测',
    promptId: prompt.id,
    baselineVersionId: baseline.id,
    candidateVersionId: version.id,
    suiteId: suite.id,
    createdBy: '自动测试',
  });
  assert(evaluation.sharedConfig.cases.length === 1, '评测应冻结测试案例');
  assert(evaluation.baselineVersionId !== evaluation.candidateVersionId, '新旧版本必须不同');

  let completedEvaluation: StudioEvaluation;
  if (runAi) {
    completedEvaluation = await request<StudioEvaluation>(`/evaluations/${evaluation.id}/run`, 'POST');
    assert(completedEvaluation.status === 'completed', `AI 评测应完成，当前状态 ${completedEvaluation.status}: ${completedEvaluation.error ?? ''}`);
    assert(completedEvaluation.result?.baseline.cases[0]?.rawData, '旧版应保留原始模型数据');
    assert(completedEvaluation.result?.candidate.cases[0]?.rawData, '新版应保留原始模型数据');
    assert(completedEvaluation.result.pairedCaseCount >= 0 && completedEvaluation.result.pairedCaseCount <= 1, '成对案例数应有效');
    assert(
      completedEvaluation.result.pairedCaseCount === 0
        ? completedEvaluation.result.totalDelta === null
        : completedEvaluation.result.totalDelta !== null,
      '分差必须与成对案例状态一致',
    );
  } else {
    const dimensions = {
      instruction: 3.5,
      relevance: 3.5,
      agency: 4,
      logic: 3.5,
      interest: 3.5,
      persona: 4,
      tone: 3.5,
      world: 4,
      group: 3.5,
      style: 4,
    };
    const rawData = {
      generationRequest: {
        template: 'API synthetic template',
        roleName: '测试角色',
        rolePersona: '只用于 API 自测。',
        otherCharacters: '',
        worldSetting: '测试世界。',
        taskDescription: '直接回应玩家。',
        outputFormat: '一句话。',
        dialogueRules: '不替玩家行动。',
        recentMessages: [],
        latestMessage: '告诉我现在在哪里。',
        mentionedNames: [],
      },
      generationResponse: '测试角色说：这里是测试地点。',
    };
    const makeCase = (response: string, total: number): PromptEvaluationCaseResult => ({
      caseId: 'api-case-1',
      title: '直接回应',
      input: '告诉我现在在哪里。',
      response,
      total,
      dimensions,
      defects: [],
      rationale: '合成证据用于验证评审快照，不代表模型质量。',
      rawData: { ...rawData, generationResponse: response },
    });
    const result: StudioEvaluationResult = {
      baseline: {
        versionId: evaluation.baselineVersionId,
        versionNumber: 1,
        versionTitle: '初始草稿',
        totalScore: 70,
        dimensions,
        responseValidity: 100,
        averageLength: 16,
        notes: [],
        cases: [makeCase('测试角色回答旧版。', 70)],
      },
      candidate: {
        versionId: evaluation.candidateVersionId,
        versionNumber: 2,
        versionTitle: '候选版本',
        totalScore: 80,
        dimensions: { ...dimensions, agency: 4.5 },
        responseValidity: 100,
        averageLength: 17,
        notes: [],
        cases: [makeCase('测试角色回答新版。', 80)],
      },
      totalDelta: 10,
      dimensionDeltas: { agency: 0.5 },
      winner: 'candidate',
      pairedCaseCount: 1,
      totalCaseCount: 1,
      completedAt: Date.now(),
    };
    completedEvaluation = getStudioRepository().updateEvaluationState(evaluation.id, 'completed', result, null);
  }

  const review = await request<StudioReviewRequest>('/reviews', 'POST', {
    promptId: prompt.id,
    versionId: version.id,
    evaluationId: completedEvaluation.id,
    title: 'API 协作评审',
    description: '验证冻结版本与逐案例评审证据。',
    reviewerIds: [reviewer.id],
  });
  assert(review.caseItems.length === 1, '已完成评测应冻结一条逐案例评审证据');
  assert(review.caseItems[0].baseline?.rawData && review.caseItems[0].candidate?.rawData, '评审快照应保留两侧原始生成数据');
  const reviewedComment = await request<StudioReviewRequest>(`/reviews/${review.id}/comments`, 'POST', {
    content: '先补充一条整单协作意见，最终结论由案例复核汇总。',
    decision: 'comment',
  }, reviewerToken);
  assert(reviewedComment.status === 'open', '绑定案例证据的普通评论不应提前改变整单状态');
  const reviewScores = {
    instruction: 4,
    relevance: 4,
    agency: 5,
    logic: 4,
    interest: 4,
    persona: 4,
    tone: 4,
    world: 4,
    group: 5,
    style: 4,
  };
  const firstCaseReview = await request<StudioReviewRequest>(`/reviews/${review.id}/cases/${review.caseItems[0].caseId}/assessments`, 'POST', {
    scores: reviewScores,
    decision: 'approve',
    comment: '新版保留了玩家的查询方向，没有替玩家做下一步决定。',
  }, reviewerToken);
  assert(firstCaseReview.status === 'approved', '所有评审人完成所有案例并通过后，整单应通过');
  assert(firstCaseReview.caseItems[0].assessments.length === 1 && firstCaseReview.caseItems[0].assessments[0].revision === 1, '案例复核应保存第 1 次修订');
  const changedCaseReview = await request<StudioReviewRequest>(`/reviews/${review.id}/cases/${review.caseItems[0].caseId}/assessments`, 'POST', {
    scores: { ...reviewScores, agency: 2 },
    decision: 'changes_requested',
    comment: '复核后发现行动权证据仍需进一步确认。',
  }, reviewerToken);
  assert(changedCaseReview.status === 'changes_requested', '案例要求修改后整单应变为需要修改');
  const approvedAgain = await request<StudioReviewRequest>(`/reviews/${review.id}/cases/${review.caseItems[0].caseId}/assessments`, 'POST', {
    scores: reviewScores,
    decision: 'approve',
    comment: '修订后再次核对，证据满足发布要求。',
  }, reviewerToken);
  assert(approvedAgain.status === 'approved', '最新案例修订通过后整单应恢复通过');
  assert(approvedAgain.caseItems[0].assessments.length === 3, '案例复核应保留全部修订历史');

  const manualScores = {
    instruction: 4,
    relevance: 4,
    agency: 5,
    logic: 4,
    interest: 4,
    persona: 4,
    tone: 4,
    world: 4,
    group: 5,
    style: 4,
  };
  const manualFirst = await request<StudioManualAssessment>('/manual-assessments', 'POST', {
    promptId: prompt.id,
    versionId: version.id,
    scores: manualScores,
    scenario: '20 轮多人房间体验',
    turns: 20,
    comment: '玩家可以持续插入行动，角色回复较克制。',
  }, reviewerToken);
  const manualSecond = await request<StudioManualAssessment>('/manual-assessments', 'POST', {
    promptId: prompt.id,
    versionId: version.id,
    scores: { ...manualScores, interest: 4.5 },
    scenario: '20 轮多人房间复测',
    turns: 20,
    comment: '复测后确认人设稳定，但剧情钩子仍可增强。',
  }, reviewerToken);
  assert(manualFirst.revision === 1 && manualSecond.revision === 2, '同一成员的人工评测应保留修订历史');
  const assessmentsBootstrap = await request<StudioBootstrap>('/bootstrap');
  assert(assessmentsBootstrap.manualAssessments.filter((item) => item.versionId === version.id && item.memberId === reviewer.id).length === 2, '人工评测原文和历史修订应保留在项目中');

  const modelResources = assessmentsBootstrap.resources.filter((item) => item.kind === 'model-config' && !item.deletedAt && item.status === 'active');
  assert(modelResources.length > 0, '迁移后应存在默认模型配置');
  modelServer = createServer((req, res) => {
    const isCloudsway = req.url === '/cloudsway/v1/chat/completions';
    const isOpenRouter = req.url === '/openrouter/v1/chat/completions';
    if (req.url !== '/v1/chat/completions' && !isCloudsway && !isOpenRouter) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
      const authorization = req.headers.authorization;
      const expectedAuthorization = isOpenRouter ? 'Bearer openrouter-secret' : 'Bearer debug-secret';
      if (authorization !== expectedAuthorization) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid mock key' } }));
        return;
      }
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
        presence_penalty?: number;
        frequency_penalty?: number;
        stream_options?: { include_usage?: boolean };
      };
      const userMessage = parsed.messages?.find((item) => item.role === 'user');
      if (isCloudsway) {
        assert(
          Array.isArray(userMessage?.content)
            && userMessage.content.some((item) => item.type === 'text' && item.text === 'Cloudsway 调试消息'),
          'Cloudsway 适配器应把所有消息转换为文本块数组',
        );
        assert(parsed.stream_options?.include_usage === true, 'Cloudsway 适配器应强制请求用量统计');
        assert(req.headers.authorization === 'Bearer debug-secret', 'Cloudsway 应使用 Bearer API Key');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'Cloudsway 专用回复。' }] } }], usage: { total_tokens: 9 } }));
        return;
      }
      if (isOpenRouter) {
        assert(req.headers['http-referer'] === 'https://prompt.test', 'OpenRouter 应发送 HTTP-Referer 扩展头');
        assert(req.headers['x-title'] === 'Prompt Studio Test', 'OpenRouter 应发送 X-Title 扩展头');
        assert(req.headers.cookie === undefined && req.headers['x-api-key'] === undefined, 'OpenRouter 不应发送模型卡中的敏感扩展头');
        assert(req.headers['content-type'] === 'application/json', 'OpenRouter 不应允许模型卡覆盖 Content-Type');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OpenRouter 回复。' } }], usage: { total_tokens: 8 } }));
        return;
      }
      assert(
        Array.isArray(userMessage?.content)
          && userMessage.content.some((item) => item.type === 'text' && item.text === '第一条调试消息'),
        '文本块数组模型应把用户消息发送给模型',
      );
      assert(parsed.presence_penalty === undefined, '模型卡关闭后不应发送 presence_penalty');
      assert(parsed.frequency_penalty === undefined, '模型卡关闭后不应发送 frequency_penalty');
      assert(parsed.stream_options?.include_usage === true, '供应商扩展参数应原样发送');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '本地模型的调试回复。' } }], usage: { total_tokens: 7 } }));
    });
  });
  await new Promise<void>((resolve) => modelServer!.listen(0, '127.0.0.1', resolve));
  const modelServerPort = (modelServer.address() as AddressInfo).port;
  const storedModel = await request<StudioResource>('/resources', 'POST', {
    kind: 'model-config',
    name: 'API 调试模型卡',
    description: '验证服务端密钥与调试调用。',
    owner: '自动测试',
    data: {
      provider: '本地假模型',
      protocol: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${modelServerPort}/v1`,
      credentialSource: 'stored',
      apiKey: 'debug-secret',
      messageContentFormat: 'text-parts',
      disabledParameters: ['presence_penalty', 'frequency_penalty'],
      model: 'mock-chat',
      temperature: 0.7,
      topP: 1,
      presencePenalty: 0.25,
      frequencyPenalty: 0,
      maxTokens: 128,
      timeoutMs: 5000,
      extraParameters: { stream_options: { include_usage: true } },
    },
  });
  assert(!JSON.stringify(storedModel.data).includes('debug-secret'), '模型卡 API 响应不能回传原始密钥');
  assert(!('apiKey' in storedModel.data) && !('apiKeyEncrypted' in storedModel.data), '模型卡响应不能包含明文或加密密钥字段');
  assert(storedModel.data.apiKeyConfigured === true, '模型卡应返回已配置状态');
  const verificationDb = new DatabaseSync(databaseFile, { readOnly: true });
  const storedRow = verificationDb.prepare('SELECT data_json FROM resources WHERE id = ?').get(storedModel.id) as { data_json: string };
  verificationDb.close();
  assert(!storedRow.data_json.includes('debug-secret'), '数据库不能保存模型卡明文密钥');
  assert(storedRow.data_json.includes('"apiKeyEncrypted":"v1:'), '数据库应保存 AES-GCM v1 密文');
  const retainedModel = await request<StudioResource>(`/resources/${storedModel.id}`, 'PATCH', {
    data: { credentialSource: 'stored', temperature: 0.8 },
  });
  assert(retainedModel.data.apiKeyConfigured === true, '更新模型卡参数时应保留原加密密钥');
  const debugResult = await request<StudioDebugChatResult>('/debug/chat', 'POST', {
    modelConfigResourceId: storedModel.id,
    systemPrompt: '你是一个简短的调试助手。',
    messages: [{ role: 'user', content: '第一条调试消息' }],
    overrides: { temperature: 0.8, presencePenalty: 0.3 },
  });
  assert(debugResult.text === '本地模型的调试回复。', 'Prompt 调试器应返回模型回复');
  assert(debugResult.omittedParameters.some((item) => item.key === 'presence_penalty'), 'Prompt 调试器应返回被模型卡关闭的参数');
  assert(!JSON.stringify(debugResult).includes('debug-secret'), '调试响应不能回传模型卡密钥');
  process.env.STUDIO_TEST_FALLBACK_KEY = 'environment-key-must-not-be-used';
  const clearedModel = await request<StudioResource>(`/resources/${storedModel.id}`, 'PATCH', {
    data: { credentialSource: 'stored', apiKeyEnv: 'STUDIO_TEST_FALLBACK_KEY', clearApiKey: true },
  });
  assert(clearedModel.data.credentialSource === 'stored', '清除密钥后应保留用户选择的卡片密钥来源');
  assert(clearedModel.data.apiKeyConfigured === false, '清除模型卡密钥后应返回未配置状态');
  let missingStoredKeyError = '';
  try {
    await request<StudioDebugChatResult>('/debug/chat', 'POST', {
      modelConfigResourceId: storedModel.id,
      systemPrompt: '不应发送到模型服务。',
      messages: [{ role: 'user', content: '验证卡片密钥不会回退到环境变量' }],
    });
  } catch (caught) {
    missingStoredKeyError = caught instanceof Error ? caught.message : String(caught);
  }
  delete process.env.STUDIO_TEST_FALLBACK_KEY;
  assert(missingStoredKeyError.includes('未配置卡片加密密钥'), '卡片密钥缺失时不能回退使用环境变量');
  const cloudswayModel = await request<StudioResource>('/resources', 'POST', {
    kind: 'model-config',
    name: 'Cloudsway 专用协议模型卡',
    description: '验证 Cloudsway 文本块数组与用量参数。',
    owner: '自动测试',
    data: {
      provider: 'Cloudsway',
      protocol: 'cloudsway-chat-completions',
      baseUrl: `http://127.0.0.1:${modelServerPort}/cloudsway/v1`,
      credentialSource: 'stored',
      apiKey: 'debug-secret',
      model: 'MaaS_Cl_sonnet_4.5_20250929',
      messageContentFormat: 'text',
      disabledParameters: ['presence_penalty', 'frequency_penalty'],
      temperature: 0.7,
      topP: 1,
      presencePenalty: 0.25,
      frequencyPenalty: 0,
      maxTokens: 128,
      timeoutMs: 5000,
    },
  });
  const cloudswayResult = await request<StudioDebugChatResult>('/debug/chat', 'POST', {
    modelConfigResourceId: cloudswayModel.id,
    systemPrompt: '你是一个简短的调试助手。',
    messages: [{ role: 'user', content: 'Cloudsway 调试消息' }],
  });
  assert(cloudswayResult.text === 'Cloudsway 专用回复。', 'Cloudsway 专用适配器应解析回复和用量');
  assert(cloudswayResult.totalTokens === 9, 'Cloudsway 专用适配器应解析 total_tokens');
  assert((cloudswayResult.appliedParameters.stream_options as { include_usage?: boolean })?.include_usage === true, 'Cloudsway 调试结果应记录强制用量参数');
  const openRouterModel = await request<StudioResource>('/resources', 'POST', {
    kind: 'model-config',
    name: 'OpenRouter 模型卡',
    description: '验证 OpenRouter 兼容协议扩展头。',
    owner: '自动测试',
    data: {
      provider: 'OpenRouter',
      protocol: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${modelServerPort}/openrouter/v1`,
      credentialSource: 'stored',
      apiKey: 'openrouter-secret',
      model: 'openai/gpt-oss-120b',
      temperature: 0.7,
      topP: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
      maxTokens: 128,
      timeoutMs: 5000,
      extraHeaders: {
        'HTTP-Referer': 'https://prompt.test',
        'X-Title': 'Prompt Studio Test',
        Authorization: 'Bearer should-not-be-sent',
        Cookie: 'session=should-not-be-sent',
        'Content-Type': 'text/plain',
        'X-API-Key': 'should-not-be-sent',
      },
    },
  });
  const openRouterResult = await request<StudioDebugChatResult>('/debug/chat', 'POST', {
    modelConfigResourceId: openRouterModel.id,
    systemPrompt: '你是一个简短的调试助手。',
    messages: [{ role: 'user', content: 'OpenRouter 调试消息' }],
  });
  assert(openRouterResult.text === 'OpenRouter 回复。', 'OpenRouter 兼容适配应返回模型回复');
  const alternateModel = await request<StudioResource>('/resources', 'POST', {
    kind: 'model-config',
    name: 'API 横评备用模型',
    description: '验证多模型横评的独立目标快照。',
    owner: '自动测试',
    data: { ...modelResources[0].data, model: String(modelResources[0].data.model) },
  });
  const modelComparison = await request<StudioModelComparison>('/model-comparisons', 'POST', {
    name: 'API 模型横评自测',
    promptId: prompt.id,
    versionId: version.id,
    suiteId: suite.id,
    targetModelConfigResourceIds: [modelResources[0].id, alternateModel.id],
    judgeModelConfigResourceId: modelResources[0].id,
  });
  assert(modelComparison.sharedConfig.targetModels.length === 2, '模型横评应冻结两个被测模型');
  assert(modelComparison.sharedConfig.judgeModelConfigResourceId === modelResources[0].id, '模型横评应冻结裁判模型');
  const comparisonsBootstrap = await request<StudioBootstrap>('/bootstrap');
  assert(comparisonsBootstrap.modelComparisons.some((item) => item.id === modelComparison.id), '模型横评应出现在项目引导数据中');

  if (runAi) {
    const completedComparison = await request<StudioModelComparison>(`/model-comparisons/${modelComparison.id}/run`, 'POST');
    assert(completedComparison.status === 'completed', `模型横评应完成，当前状态 ${completedComparison.status}: ${completedComparison.error ?? ''}`);
    assert(completedComparison.result?.models.length === 2, '模型横评应保留每个模型的结果');
    assert(completedComparison.result?.models.every((item) => item.cases[0]?.rawData), '模型横评应保留各模型原始数据');
  }

  const archived = await request<StudioEvaluation>(`/evaluations/${evaluation.id}/archive`, 'POST');
  assert(archived.status === 'archived', '评测应可归档但不能改写证据');
  console.log(`Studio API 自测通过${runAi ? '（包含真实 AI 生成与评分）' : ''}`);
} finally {
  if (modelServer) {
    await new Promise<void>((resolve, reject) => modelServer!.close((error) => error ? reject(error) : resolve()));
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeStudioRepositoryForTests();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(databaseFile + suffix, { force: true });
  }
}
