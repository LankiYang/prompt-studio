import type {
  StudioBootstrap,
  StudioAuthBootstrap,
  StudioAuthSession,
  StudioCreateAccountInput,
  StudioCreateMemberInput,
  StudioCreateManualAssessmentInput,
  StudioCreateModelComparisonInput,
  StudioCreateEvaluationInput,
  StudioCreateProjectInput,
  StudioCreateResourceInput,
  StudioCreateReviewInput,
  StudioCreateReviewCaseAssessmentInput,
  StudioDebugChatInput,
  StudioDebugChatResult,
  StudioEvaluation,
  StudioMember,
  StudioMemberRole,
  StudioManualAssessment,
  StudioModelComparison,
  StudioProject,
  StudioProjectMember,
  StudioPromptVersion,
  StudioReviewComment,
  StudioReviewRequest,
  StudioResource,
} from '../../shared/studio-types';
import type { PromptBuilderItem } from '../../shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
      ...(studioSession.token ? { Authorization: `Bearer ${studioSession.token}` } : {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `请求失败 (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const studioSession = {
  projectId: window.localStorage.getItem('studio-project-id') ?? '',
  token: window.localStorage.getItem('studio-access-token') ?? '',
};

function withProject(url: string, projectId = studioSession.projectId) {
  if (!projectId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`;
}

export function setStudioSession(next: { projectId?: string; token?: string }) {
  if (next.projectId !== undefined) {
    studioSession.projectId = next.projectId;
    window.localStorage.setItem('studio-project-id', next.projectId);
  }
  if (next.token !== undefined) {
    studioSession.token = next.token;
    if (next.token) window.localStorage.setItem('studio-access-token', next.token);
    else window.localStorage.removeItem('studio-access-token');
  }
}

export function clearStudioSession() {
  studioSession.token = '';
  studioSession.projectId = '';
  window.localStorage.removeItem('studio-access-token');
  window.localStorage.removeItem('studio-project-id');
}

export const authApi = {
  bootstrap: () => request<StudioAuthBootstrap>('/api/auth/bootstrap'),
  setup: (input: { name: string; username: string; password: string }) => request<StudioAuthSession>('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) }),
  login: (input: { username: string; password: string }) => request<StudioAuthSession>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  me: () => request<{ expiresAt: number; member: StudioMember }>('/api/auth/me'),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  createAccount: (input: StudioCreateAccountInput) => request<StudioMember>('/api/auth/accounts', { method: 'POST', body: JSON.stringify(input) }),
};

export const studioApi = {
  bootstrap: () => request<StudioBootstrap>(withProject('/api/studio/bootstrap')),
  createProject: (input: StudioCreateProjectInput) => request<StudioProject>('/api/studio/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, input: Partial<StudioCreateProjectInput & { status: StudioProject['status'] }>) => request<StudioProject>(`/api/studio/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createMember: (input: StudioCreateMemberInput) => request<StudioMember>('/api/studio/members', { method: 'POST', body: JSON.stringify(input) }),
  updateMember: (id: string, input: Partial<StudioCreateMemberInput & { status: StudioMember['status'] }>) => request<StudioMember>(`/api/studio/members/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  setProjectMember: (projectId: string, memberId: string, role: StudioMemberRole) => request<StudioProjectMember[]>(`/api/studio/projects/${projectId}/members/${memberId}`, { method: 'POST', body: JSON.stringify({ role }) }),
  removeProjectMember: (projectId: string, memberId: string) => request<StudioProjectMember[]>(`/api/studio/projects/${projectId}/members/${memberId}`, { method: 'DELETE' }),
  createResource: (input: StudioCreateResourceInput) =>
    request<StudioResource>('/api/studio/resources', {
      method: 'POST',
      body: JSON.stringify({ ...input, projectId: input.projectId ?? studioSession.projectId }),
    }),
  updateResource: (id: string, input: Partial<StudioResource>) =>
    request<StudioResource>(`/api/studio/resources/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteResource: (id: string) =>
    request<void>(`/api/studio/resources/${id}`, { method: 'DELETE' }),
  restoreResource: (id: string) =>
    request<StudioResource>(`/api/studio/resources/${id}/restore`, { method: 'POST' }),
  permanentlyDeleteResource: (id: string) =>
    request<void>(`/api/studio/resources/${id}/permanent`, { method: 'DELETE' }),
  createPromptVersion: (
    promptId: string,
    input: { projectId?: string; title: string; summary: string; snapshot: PromptBuilderItem },
  ) =>
    request<StudioPromptVersion>(`/api/studio/prompts/${promptId}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  publishPromptVersion: (promptId: string, versionId: string) =>
    request<StudioPromptVersion[]>(
      `/api/studio/prompts/${promptId}/versions/${versionId}/publish`,
      { method: 'POST' },
    ),
  createEvaluation: (input: StudioCreateEvaluationInput) =>
    request<StudioEvaluation>('/api/studio/evaluations', {
      method: 'POST',
      body: JSON.stringify({ ...input, projectId: input.projectId ?? studioSession.projectId }),
    }),
  runEvaluation: (id: string) =>
    request<StudioEvaluation>(`/api/studio/evaluations/${id}/run`, { method: 'POST' }),
  archiveEvaluation: (id: string) =>
    request<StudioEvaluation>(`/api/studio/evaluations/${id}/archive`, { method: 'POST' }),
  createModelComparison: (input: StudioCreateModelComparisonInput) =>
    request<StudioModelComparison>('/api/studio/model-comparisons', {
      method: 'POST',
      body: JSON.stringify({ ...input, projectId: input.projectId ?? studioSession.projectId }),
    }),
  runModelComparison: (id: string) =>
    request<StudioModelComparison>(`/api/studio/model-comparisons/${id}/run`, { method: 'POST' }),
  archiveModelComparison: (id: string) =>
    request<StudioModelComparison>(`/api/studio/model-comparisons/${id}/archive`, { method: 'POST' }),
  debugChat: (input: StudioDebugChatInput) =>
    request<StudioDebugChatResult>('/api/studio/debug/chat', {
      method: 'POST',
      body: JSON.stringify({ ...input, projectId: input.projectId ?? studioSession.projectId }),
    }),
  createReview: (input: StudioCreateReviewInput) => request<StudioReviewRequest>(withProject('/api/studio/reviews'), { method: 'POST', body: JSON.stringify(input) }),
  addReviewComment: (id: string, input: { content: string; decision: StudioReviewComment['decision'] }) => request<StudioReviewRequest>(withProject(`/api/studio/reviews/${id}/comments`), { method: 'POST', body: JSON.stringify(input) }),
  addReviewCaseAssessment: (reviewId: string, caseId: string, input: StudioCreateReviewCaseAssessmentInput) => request<StudioReviewRequest>(withProject(`/api/studio/reviews/${reviewId}/cases/${encodeURIComponent(caseId)}/assessments`), { method: 'POST', body: JSON.stringify(input) }),
  createManualAssessment: (input: StudioCreateManualAssessmentInput) => request<StudioManualAssessment>(withProject('/api/studio/manual-assessments'), { method: 'POST', body: JSON.stringify(input) }),
};
