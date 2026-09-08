import type {
  PromptBuilderItem,
  PromptEvaluationCaseResult,
  PromptQualityDimensions,
  PromptTestCase,
} from './types';

export type StudioResourceKind =
  | 'prompt'
  | 'character'
  | 'world'
  | 'test-suite'
  | 'scorecard'
  | 'model-config'
  | 'scheduler-policy'
  | 'memory-policy';

export type StudioResourceStatus = 'active' | 'archived';

export type StudioMemberRole = 'owner' | 'editor' | 'reviewer' | 'viewer';
export type StudioMemberStatus = 'active' | 'invited' | 'disabled';
export type StudioReviewStatus = 'open' | 'approved' | 'changes_requested' | 'closed';

export interface StudioOrganization {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface StudioMember {
  id: string;
  organizationId: string;
  name: string;
  username: string;
  role: StudioMemberRole;
  status: StudioMemberStatus;
  createdAt: number;
  updatedAt: number;
}

export interface StudioAuthSession {
  token: string;
  expiresAt: number;
  member: StudioMember;
}

export interface StudioAuthBootstrap {
  setupRequired: boolean;
}

export interface StudioCreateAccountInput {
  name: string;
  username: string;
  password: string;
  role: StudioMemberRole;
  projectId?: string;
  projectRole?: StudioMemberRole;
}

export interface StudioProjectMember {
  projectId: string;
  memberId: string;
  role: StudioMemberRole;
  addedAt: number;
  member?: StudioMember;
}

export interface StudioProject {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

export interface StudioResource<T = Record<string, unknown>> {
  id: string;
  projectId: string;
  kind: StudioResourceKind;
  name: string;
  description: string;
  owner: string;
  tags: string[];
  status: StudioResourceStatus;
  data: T;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface StudioPromptVersion {
  id: string;
  promptId: string;
  number: number;
  title: string;
  summary: string;
  status: 'draft' | 'published' | 'archived';
  snapshot: PromptBuilderItem;
  createdAt: number;
  createdBy: string;
}

export interface StudioCharacterData {
  name: string;
  persona: string;
  gender?: string;
}

export interface StudioWorldData {
  content: string;
}

export interface StudioTestSuiteData {
  cases: PromptTestCase[];
}

export interface StudioScoreDimension {
  key: keyof PromptQualityDimensions;
  label: string;
  weight: number;
  description: string;
}

export interface StudioScorecardData {
  dimensions: StudioScoreDimension[];
  passScore: number;
  blockingDefects: string[];
}

export type StudioModelParameterName =
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'presence_penalty'
  | 'frequency_penalty'
  | 'max_tokens'
  | 'stop';

export type StudioModelProtocol =
  | 'openai-compatible'
  | 'anthropic-messages'
  | 'cloudsway-chat-completions';

export interface StudioModelConfigData {
  provider: string;
  protocol?: StudioModelProtocol;
  messageContentFormat?: 'text' | 'text-parts';
  disabledParameters?: StudioModelParameterName[];
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Server-only write-only credential. Never return this field to a browser. */
  apiKey?: string;
  /** Server-only encrypted storage value. Never return this field to a browser. */
  apiKeyEncrypted?: string;
  /** Public metadata returned for model cards. */
  apiKeyConfigured?: boolean;
  credentialSource?: 'environment' | 'stored' | 'missing';
  model: string;
  temperature: number;
  topP?: number;
  topK?: number;
  presencePenalty: number;
  frequencyPenalty?: number;
  maxTokens: number;
  timeoutMs: number;
  stopSequences?: string[];
  extraParameters?: Record<string, unknown>;
  /** Non-sensitive provider headers. Reserved and credential headers are filtered server-side. */
  extraHeaders?: Record<string, string>;
}

export type StudioDebugMessageRole = 'user' | 'assistant';

export interface StudioDebugMessage {
  role: StudioDebugMessageRole;
  content: string;
}

export interface StudioDebugSamplingOverrides {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxTokens?: number;
  stopSequences?: string[];
  extraParameters?: Record<string, unknown>;
}

export interface StudioDebugChatInput {
  projectId?: string;
  modelConfigResourceId: string;
  systemPrompt: string;
  messages: StudioDebugMessage[];
  overrides?: StudioDebugSamplingOverrides;
}

export interface StudioDebugOmittedParameter {
  key: string;
  reason: string;
}

export interface StudioDebugChatResult {
  text: string;
  totalTokens: number;
  latencyMs: number;
  provider: string;
  model: string;
  appliedParameters: Record<string, unknown>;
  omittedParameters: StudioDebugOmittedParameter[];
}

export interface StudioSchedulerPolicyData {
  historyRounds: number;
  maxSpeakers: number;
  executionMode: 'parallel' | 'serial';
  bundleWindowMs: number;
  mentionEnabled: boolean;
  proactiveEnabled: boolean;
  proactiveIntervalsSeconds: number[];
}

export interface StudioMemoryPolicyData {
  enabled: boolean;
  updateEveryTurns: number;
  retrievalLimit: number;
  injectManualMemory: boolean;
  injectAutoMemory: boolean;
}

export interface StudioSharedConfigSnapshot {
  characterResourceIds: string[];
  characters: Array<{ id: string; name: string; persona: string }>;
  worldResourceId: string;
  worldSetting: string;
  modelConfigResourceId: string;
  modelConfig: StudioModelConfigData;
  schedulerPolicyResourceId: string;
  schedulerPolicy: StudioSchedulerPolicyData;
  memoryPolicyResourceId: string;
  memoryPolicy: StudioMemoryPolicyData;
  scorecardResourceId: string;
  scorecard: StudioScorecardData;
  suiteResourceId: string;
  suiteName: string;
  cases: PromptTestCase[];
}

export interface StudioEvaluationSideResult {
  versionId: string;
  versionNumber: number;
  versionTitle: string;
  totalScore: number | null;
  dimensions: PromptQualityDimensions | null;
  responseValidity: number | null;
  averageLength: number | null;
  notes: string[];
  cases: PromptEvaluationCaseResult[];
  error?: string;
}

export interface StudioEvaluationResult {
  baseline: StudioEvaluationSideResult;
  candidate: StudioEvaluationSideResult;
  totalDelta: number | null;
  dimensionDeltas: Partial<Record<keyof PromptQualityDimensions, number>>;
  winner: 'baseline' | 'candidate' | 'tie' | 'unavailable';
  pairedCaseCount: number;
  totalCaseCount: number;
  completedAt: number;
}

export interface StudioEvaluation {
  id: string;
  projectId: string;
  name: string;
  promptId: string;
  baselineVersionId: string;
  candidateVersionId: string;
  suiteId: string;
  status: 'draft' | 'running' | 'completed' | 'failed' | 'archived';
  sharedConfig: StudioSharedConfigSnapshot;
  result: StudioEvaluationResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  deletedAt: number | null;
}

export interface StudioComparisonModelSnapshot {
  resourceId: string;
  name: string;
  config: StudioModelConfigData;
}

export interface StudioModelComparisonSharedConfig extends Omit<StudioSharedConfigSnapshot, 'modelConfigResourceId' | 'modelConfig'> {
  judgeModelConfigResourceId: string;
  judgeModelConfig: StudioModelConfigData;
  targetModels: StudioComparisonModelSnapshot[];
}

export interface StudioModelComparisonSideResult extends StudioEvaluationSideResult {
  modelResourceId: string;
  modelName: string;
}

export interface StudioModelComparisonResult {
  models: StudioModelComparisonSideResult[];
  ranking: string[];
  totalCaseCount: number;
  completedAt: number;
}

export interface StudioModelComparison {
  id: string;
  projectId: string;
  name: string;
  promptId: string;
  versionId: string;
  suiteId: string;
  status: 'draft' | 'running' | 'completed' | 'failed' | 'archived';
  sharedConfig: StudioModelComparisonSharedConfig;
  result: StudioModelComparisonResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface StudioAuditLog {
  id: string;
  projectId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  summary: string;
  createdAt: number;
}

export interface StudioReviewComment {
  id: string;
  reviewId: string;
  authorId: string;
  authorName: string;
  content: string;
  decision: 'comment' | 'approve' | 'changes_requested';
  createdAt: number;
}

export interface StudioReviewCaseAssessment {
  id: string;
  reviewId: string;
  caseId: string;
  reviewerId: string;
  reviewerName: string;
  revision: number;
  scores: StudioManualScores;
  overallScore: number;
  decision: 'comment' | 'approve' | 'changes_requested';
  comment: string;
  createdAt: number;
}

export interface StudioReviewCase {
  id: string;
  reviewId: string;
  caseId: string;
  caseIndex: number;
  title: string;
  category: string;
  input: string;
  expected: string;
  baseline: PromptEvaluationCaseResult | null;
  candidate: PromptEvaluationCaseResult | null;
  assessments: StudioReviewCaseAssessment[];
}

export interface StudioReviewRequest {
  id: string;
  projectId: string;
  promptId: string;
  versionId: string;
  evaluationId: string | null;
  title: string;
  description: string;
  status: StudioReviewStatus;
  requestedById: string;
  requestedByName: string;
  reviewerIds: string[];
  createdAt: number;
  updatedAt: number;
  comments: StudioReviewComment[];
  caseItems: StudioReviewCase[];
}

export type StudioManualScores = Record<keyof PromptQualityDimensions, number>;

export interface StudioManualAssessment {
  id: string;
  projectId: string;
  promptId: string;
  versionId: string;
  memberId: string;
  memberName: string;
  revision: number;
  scores: StudioManualScores;
  overallScore: number;
  scenario: string;
  turns: number;
  comment: string;
  createdAt: number;
}

export interface StudioBootstrap {
  organization: StudioOrganization;
  projects: StudioProject[];
  project: StudioProject;
  currentMember: StudioMember;
  projectMembers: StudioProjectMember[];
  organizationMembers: StudioMember[];
  resources: StudioResource[];
  promptVersions: StudioPromptVersion[];
  evaluations: StudioEvaluation[];
  modelComparisons: StudioModelComparison[];
  reviews: StudioReviewRequest[];
  manualAssessments: StudioManualAssessment[];
  auditLogs: StudioAuditLog[];
  counts: {
    activeResources: number;
    promptVersions: number;
    completedEvaluations: number;
    recycledResources: number;
  };
}

export interface StudioCreateResourceInput {
  projectId?: string;
  kind: StudioResourceKind;
  name: string;
  description?: string;
  owner?: string;
  tags?: string[];
  data?: Record<string, unknown>;
}

export interface StudioCreateEvaluationInput {
  projectId?: string;
  name?: string;
  promptId: string;
  baselineVersionId: string;
  candidateVersionId: string;
  suiteId: string;
  characterResourceIds?: string[];
  worldResourceId?: string;
  modelConfigResourceId?: string;
  schedulerPolicyResourceId?: string;
  memoryPolicyResourceId?: string;
  scorecardResourceId?: string;
  createdBy?: string;
}

export interface StudioCreateModelComparisonInput {
  projectId?: string;
  name?: string;
  promptId: string;
  versionId: string;
  suiteId: string;
  targetModelConfigResourceIds: string[];
  judgeModelConfigResourceId: string;
  characterResourceIds?: string[];
  worldResourceId?: string;
  schedulerPolicyResourceId?: string;
  memoryPolicyResourceId?: string;
  scorecardResourceId?: string;
  createdBy?: string;
}

export interface StudioCreateProjectInput {
  name: string;
  description?: string;
}

export interface StudioCreateMemberInput {
  name: string;
  username: string;
  role: StudioMemberRole;
}

export interface StudioCreateReviewInput {
  projectId: string;
  promptId?: string;
  versionId?: string;
  evaluationId?: string | null;
  title?: string;
  description?: string;
  reviewerIds: string[];
}

export interface StudioCreateReviewCaseAssessmentInput {
  scores: StudioManualScores;
  decision: 'comment' | 'approve' | 'changes_requested';
  comment: string;
}

export interface StudioCreateManualAssessmentInput {
  projectId: string;
  promptId: string;
  versionId: string;
  scores: StudioManualScores;
  scenario?: string;
  turns?: number;
  comment: string;
}
