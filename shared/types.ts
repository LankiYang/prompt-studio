export interface Message {
  id: string;
  senderNickname: string;
  isAI: boolean;
  builderId?: string;
  characterId?: string;
  content: string;
  timestamp: number;
  mentions?: string[];
}

export type PromptVersionStatus = 'draft' | 'published' | 'archived';

export interface PromptWorkspaceVersion {
  id: string;
  number: number;
  status: PromptVersionStatus;
  title: string;
  summary: string;
  snapshot: PromptBuilderItem;
  createdAt: number;
  createdBy: string;
  metrics?: {
    templateHealth: number;
    variableCoverage: number;
    responseValidity: number;
    averageLength: number;
  };
}

export interface PromptWorkspaceItem {
  id: string;
  name: string;
  description: string;
  owner: string;
  tags: string[];
  publishedVersionId: string;
  createdAt: number;
  updatedAt: number;
  versions: PromptWorkspaceVersion[];
}

export interface PromptTestCase {
  id: string;
  title: string;
  category: string;
  input: string;
  expected: string;
  labels: string[];
}

export interface PromptTestSuite {
  id: string;
  name: string;
  description: string;
  cases: PromptTestCase[];
  updatedAt: number;
}

export interface PromptEvaluationRun {
  id: string;
  promptId: string;
  versionId: string;
  suiteId: string;
  status: 'completed' | 'needs_review';
  createdAt: number;
  createdBy: string;
  result: {
    templateHealth: number;
    variableCoverage: number;
    responseValidity: number;
    averageLength: number;
    notes: string[];
    dimensions?: PromptQualityDimensions;
    cases?: PromptEvaluationCaseResult[];
    mode?: 'structural' | 'ai_quality';
  };
}

export interface PromptQualityDimensions {
  instruction: number;
  relevance: number;
  agency: number;
  logic: number;
  interest: number;
  persona: number;
  tone: number;
  world: number;
  group: number;
  style: number;
}

export interface PromptEvaluationCaseResult {
  caseId: string;
  title: string;
  input: string;
  response: string;
  /** Null means that scoring evidence is unavailable; it must never be presented as zero. */
  total: number | null;
  dimensions: PromptQualityDimensions | null;
  defects: string[];
  rationale: string;
  rawData?: PromptEvaluationRawData;
}

export interface PromptEvaluationRawData {
  generationRequest: {
    template: string;
    roleName: string;
    rolePersona: string;
    otherCharacters: string;
    worldSetting: string;
    taskDescription: string;
    outputFormat: string;
    dialogueRules: string;
    recentMessages: string[];
    latestMessage: string;
    mentionedNames: string[];
  };
  generationResponse: string;
  generationError?: string;
  judgeRequest?: {
    worldSetting: string;
    input: string;
    expected: string;
    response: string;
  };
  judgeResponse?: string;
}

export interface PromptReview {
  id: string;
  promptId: string;
  versionId: string;
  author: string;
  decision: 'approved' | 'changes_requested' | 'comment';
  content: string;
  createdAt: number;
}

export interface PromptWorkspaceData {
  updatedAt: number;
  prompts: PromptWorkspaceItem[];
  suites: PromptTestSuite[];
  runs: PromptEvaluationRun[];
  reviews: PromptReview[];
}

export interface MemoryEvent {
  id: string;
  summary: string;
  /** The character or player that stated the fact. Empty values are legacy snapshots. */
  source?: string;
  /** Player and manual facts take precedence over AI-authored facts. */
  authority?: 'player' | 'ai' | 'manual';
  /** Reserved for per-character memory without breaking public-memory snapshots. */
  visibility?: 'public' | 'private';
  turn: number;
}

export interface MemoryItem {
  id: string;
  name: string;
  source: string;
  status: string;
  lastSeenTurn: number;
}

export interface CustomMemory {
  id: string;
  title: string;
  content: string;
  type: "manual" | "auto";
  keyword?: string;
  enabled: boolean;
  updatedAt: number;
}

export interface SessionMemoryState {
  characterState: {
    goal: string;
    location: string;
    appearance: string;
    health: string;
    attitude: string;
  };
  worldState: {
    setting: string;
    time: string;
    weather: string;
    location: string;
  };
  events: MemoryEvent[];
  items: MemoryItem[];
  manualMemories: CustomMemory[];
  autoMemories: CustomMemory[];
  turnCount: number;
  lastUpdatedTurn: number;
  autoUpdateEnabled: boolean;
  updating: boolean;
  lastChangedFields: string[];
}

export interface MemoryEvaluationConfig {
  builderId: string;
  updateEveryTurns: number;
  baselineHistoryMessages: number;
  retrievalLimit: number;
  temperature?: number;
  presencePenalty?: number;
  fixedCharacterIds?: string[];
}

export interface UserInfo {
  id: string;
  nickname: string;
}

export interface CharacterConfig {
  id: string;
  name: string;
  persona: string;
}

export interface BuilderVariableConfig {
  taskDescriptions: {
    chat: string;
    mention: string;
    proactive: string;
  };
  outputFormat: string;
  dialogueRules: string;
}

export interface PromptBuilderItem {
  id: string;
  label: string;
  template: string;
  maxSpeakers?: number;
  variableConfig?: BuilderVariableConfig;
  worldSetting?: string;
  characters?: CharacterConfig[];
}

export interface WorldConfig {
  worldSetting: string;
  characters: CharacterConfig[];
  builderPrompts?: PromptBuilderItem[];
}
