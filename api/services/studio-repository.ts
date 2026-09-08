import fs from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  PromptBuilderItem,
  WorldConfig,
} from '../../shared/types.js';
import type {
  StudioAuditLog,
  StudioAuthBootstrap,
  StudioAuthSession,
  StudioBootstrap,
  StudioCreateAccountInput,
  StudioCreateMemberInput,
  StudioCreateEvaluationInput,
  StudioCreateModelComparisonInput,
  StudioCreateManualAssessmentInput,
  StudioCreateProjectInput,
  StudioCreateResourceInput,
  StudioCreateReviewInput,
  StudioCreateReviewCaseAssessmentInput,
  StudioEvaluation,
  StudioEvaluationResult,
  StudioMember,
  StudioMemberRole,
  StudioOrganization,
  StudioMemoryPolicyData,
  StudioManualAssessment,
  StudioManualScores,
  StudioModelComparison,
  StudioModelComparisonResult,
  StudioModelComparisonSharedConfig,
  StudioModelConfigData,
  StudioProject,
  StudioProjectMember,
  StudioPromptVersion,
  StudioReviewComment,
  StudioReviewCase,
  StudioReviewCaseAssessment,
  StudioReviewRequest,
  StudioResource,
  StudioResourceKind,
  StudioSchedulerPolicyData,
  StudioScorecardData,
  StudioSharedConfigSnapshot,
  StudioTestSuiteData,
} from '../../shared/studio-types.js';
import { SHORT_PUBLIC_DIALOGUE_STANDARD } from '../../shared/prompt-standards.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATABASE_FILE = process.env.PROMPT_STUDIO_DB_FILE
  ? path.resolve(process.env.PROMPT_STUDIO_DB_FILE)
  : path.join(DATA_DIR, 'prompt-studio.db');
const LEGACY_CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_PROJECT_ID = 'project-prompt-evaluation';
const DEFAULT_ORGANIZATION_ID = 'org-promptops';
const DEFAULT_MEMBER_ID = 'member-promptops-owner';
const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

type Row = Record<string, unknown>;

function now() {
  return Date.now();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    console.error(`[Studio] 无法读取迁移源 ${file}:`, error);
    return null;
  }
}

export function closeStudioRepositoryForTests() {
  singleton?.close();
  singleton = null;
}

function cleanText(value: unknown, fallback: string, max = 200) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
}

function cleanTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];
}

function cleanUsername(value: unknown) {
  const username = cleanText(value, '', 40).toLowerCase();
  return /^[a-z0-9]{3,40}$/.test(username) ? username : '';
}

function validatePassword(value: unknown) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 256) {
    throw new Error('密码长度需为 3 至 256 个字符');
  }
  return value;
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const derived = scryptSync(password, salt, 64).toString('hex');
  const left = Buffer.from(derived, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashAccessToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function modelCardEncryptionKey() {
  const configuredKey = process.env.PROMPT_STUDIO_ENCRYPTION_KEY?.trim();
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 PROMPT_STUDIO_ENCRYPTION_KEY 才能保存或读取模型卡密钥');
  }
  return createHash('sha256')
    .update(configuredKey || `local-model-card:${DATABASE_FILE}`)
    .digest();
}

function encryptModelCardSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', modelCardEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptModelCardSecret(value: string) {
  try {
    const [version, ivText, tagText, encryptedText] = value.split(':');
    if (version !== 'v1' || !ivText || !tagText || !encryptedText) return '';
    const decipher = createDecipheriv('aes-256-gcm', modelCardEncryptionKey(), Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

function hydrateModelCardData(kind: StudioResourceKind, input: Record<string, unknown>) {
  if (kind !== 'model-config') return input;
  const data = { ...input };
  if (typeof data.apiKeyEncrypted === 'string' && data.apiKeyEncrypted) {
    const apiKey = decryptModelCardSecret(data.apiKeyEncrypted);
    if (apiKey) data.apiKey = apiKey;
  }
  return data;
}

function prepareModelCardData(kind: StudioResourceKind, input: Record<string, unknown>) {
  if (kind !== 'model-config') return input;
  const data = { ...input };
  if (data.clearApiKey === true) {
    delete data.apiKey;
    delete data.apiKeyEncrypted;
  } else if (typeof data.apiKey === 'string' && data.apiKey.trim()) {
    data.apiKeyEncrypted = encryptModelCardSecret(data.apiKey.trim());
  }
  delete data.apiKey;
  delete data.apiKeyPreview;
  delete data.apiKeyConfigured;
  delete data.clearApiKey;
  return data;
}

function modelConfigSnapshot(input: StudioModelConfigData) {
  const snapshot = { ...input };
  delete snapshot.apiKey;
  delete snapshot.apiKeyEncrypted;
  delete snapshot.apiKeyConfigured;
  delete snapshot.credentialSource;
  return snapshot;
}

export function sanitizeModelConfigForClient(input: StudioModelConfigData): StudioModelConfigData {
  const rest = { ...input };
  const storedApiKey = typeof rest.apiKey === 'string' ? rest.apiKey : '';
  delete rest.apiKey;
  delete rest.apiKeyEncrypted;
  delete rest.apiKeyConfigured;
  const envConfigured = Boolean(rest.apiKeyEnv && process.env[rest.apiKeyEnv]);
  const storedConfigured = Boolean(storedApiKey.trim());
  const credentialSource = rest.credentialSource === 'stored'
    ? 'stored'
    : rest.credentialSource === 'environment'
      ? 'environment'
      : storedConfigured
        ? 'stored'
        : envConfigured
          ? 'environment'
          : 'missing';
  return {
    ...rest,
    apiKeyConfigured: credentialSource === 'stored'
      ? storedConfigured
      : credentialSource === 'environment'
        ? envConfigured
        : false,
    credentialSource,
  };
}

export function sanitizeResourceForClient(resource: StudioResource): StudioResource {
  if (resource.kind !== 'model-config') return resource;
  return {
    ...resource,
    data: sanitizeModelConfigForClient(resource.data as unknown as StudioModelConfigData) as unknown as Record<string, unknown>,
  };
}

function isMemberRole(value: unknown): value is StudioMemberRole {
  return value === 'owner' || value === 'editor' || value === 'reviewer' || value === 'viewer';
}

function defaultScorecard(): StudioScorecardData {
  return {
    passScore: 75,
    blockingDefects: ['冒充玩家', '替玩家做关键决定', '替其他角色确认意愿', '明显违背世界规则'],
    dimensions: [
      { key: 'instruction', label: '玩家指令遵循', weight: 15, description: '先响应玩家明确要求，不回避或曲解。' },
      { key: 'relevance', label: '相关性与连续性', weight: 10, description: '紧接最新消息与已有事实。' },
      { key: 'agency', label: '玩家行动权', weight: 15, description: '不替玩家决定、行动或宣告结果。' },
      { key: 'logic', label: '剧情合理性', weight: 15, description: '时间、空间、因果和信息来源自洽。' },
      { key: 'interest', label: '剧情有趣性', weight: 10, description: '提供一个可接续变化，不抢走主导权。' },
      { key: 'persona', label: '人设与角色边界', weight: 15, description: '符合自身人设，不代演其他角色。' },
      { key: 'tone', label: '语气风格差异', weight: 5, description: '语言能辨认出角色个性。' },
      { key: 'world', label: '世界观遵循', weight: 5, description: '不违反规则，不凭空扩张关键设定。' },
      { key: 'group', label: '群像协作', weight: 5, description: '不组织 NPC 自转或淹没真人。' },
      { key: 'style', label: '表达与节奏', weight: 5, description: '短、自然、可继续互动。' },
    ],
  };
}

function normalizeManualScores(input: StudioManualScores | undefined) {
  const dimensions = defaultScorecard().dimensions;
  const scores = {} as StudioManualScores;
  for (const dimension of dimensions) {
    const value = Number(input?.[dimension.key]);
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      throw new Error(`请为“${dimension.label}”评分 1 到 5 分`);
    }
    scores[dimension.key] = Math.round(value * 10) / 10;
  }
  const scoreTotal = dimensions.reduce((total, dimension) => total + scores[dimension.key] / 5 * dimension.weight, 0);
  return {
    scores,
    overallScore: Math.round(scoreTotal * 10) / 10,
  };
}

function defaultModelConfig(): StudioModelConfigData {
  return {
    provider: 'DeepSeek Compatible API',
    protocol: 'openai-compatible',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    temperature: Number(process.env.DEEPSEEK_TEMPERATURE) || 0.95,
    presencePenalty: Number(process.env.DEEPSEEK_PRESENCE_PENALTY) || 0.25,
    maxTokens: 240,
    timeoutMs: 30000,
  };
}

function defaultSchedulerPolicy(): StudioSchedulerPolicyData {
  return {
    historyRounds: 5,
    maxSpeakers: 3,
    executionMode: 'parallel',
    bundleWindowMs: 3000,
    mentionEnabled: true,
    proactiveEnabled: true,
    proactiveIntervalsSeconds: [15, 30],
  };
}

function defaultMemoryPolicy(): StudioMemoryPolicyData {
  return {
    enabled: false,
    updateEveryTurns: 10,
    retrievalLimit: 5,
    injectManualMemory: true,
    injectAutoMemory: true,
  };
}

class StudioRepository {
  private readonly db: DatabaseSync;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(DATABASE_FILE);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.createSchema();
    this.migrateAccountUsernames();
    this.seedFromLegacy();
    this.migrateCollaboration();
    this.migrateEffectivePromptSnapshot();
  }

  close() {
    this.db.close();
  }

  private createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT 'org-promptops',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'invited',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(organization_id, email),
        FOREIGN KEY(organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(member_id) REFERENCES members(id)
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id)
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        role TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, member_id),
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(member_id) REFERENCES members(id)
      );
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS resources_project_kind_idx
        ON resources(project_id, kind, deleted_at);
      CREATE TABLE IF NOT EXISTS prompt_versions (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        snapshot_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE(prompt_id, version_number),
        FOREIGN KEY(prompt_id) REFERENCES resources(id)
      );
      CREATE INDEX IF NOT EXISTS prompt_versions_prompt_idx
        ON prompt_versions(prompt_id, version_number DESC);
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        baseline_version_id TEXT NOT NULL,
        candidate_version_id TEXT NOT NULL,
        suite_id TEXT NOT NULL,
        status TEXT NOT NULL,
        shared_config_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        deleted_at INTEGER,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(prompt_id) REFERENCES resources(id)
      );
      CREATE INDEX IF NOT EXISTS evaluations_project_idx
        ON evaluations(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS model_comparisons (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        suite_id TEXT NOT NULL,
        status TEXT NOT NULL,
        shared_config_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(prompt_id) REFERENCES resources(id)
      );
      CREATE INDEX IF NOT EXISTS model_comparisons_project_idx
        ON model_comparisons(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_logs_project_idx
        ON audit_logs(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS review_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        evaluation_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        requested_by_id TEXT NOT NULL,
        requested_by_name TEXT NOT NULL,
        reviewer_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS review_requests_project_idx
        ON review_requests(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'comment',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(review_id) REFERENCES review_requests(id)
      );
      CREATE TABLE IF NOT EXISTS review_cases (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        case_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        input TEXT NOT NULL,
        expected TEXT NOT NULL,
        baseline_json TEXT,
        candidate_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(review_id, case_id),
        FOREIGN KEY(review_id) REFERENCES review_requests(id)
      );
      CREATE INDEX IF NOT EXISTS review_cases_review_idx
        ON review_cases(review_id, case_index ASC);
      CREATE TABLE IF NOT EXISTS review_case_assessments (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        reviewer_name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        scores_json TEXT NOT NULL,
        overall_score REAL NOT NULL,
        decision TEXT NOT NULL DEFAULT 'comment',
        comment TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(review_id, case_id, reviewer_id, revision),
        FOREIGN KEY(review_id) REFERENCES review_requests(id),
        FOREIGN KEY(reviewer_id) REFERENCES members(id)
      );
      CREATE INDEX IF NOT EXISTS review_case_assessments_review_idx
        ON review_case_assessments(review_id, case_id, reviewer_id, revision DESC);
      CREATE TABLE IF NOT EXISTS manual_assessments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        member_name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        scores_json TEXT NOT NULL,
        overall_score REAL NOT NULL,
        scenario TEXT NOT NULL DEFAULT '',
        turns INTEGER NOT NULL DEFAULT 0,
        comment TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(version_id, member_id, revision),
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(member_id) REFERENCES members(id)
      );
      CREATE INDEX IF NOT EXISTS manual_assessments_project_version_idx
        ON manual_assessments(project_id, version_id, created_at DESC);
    `);
    this.ensureColumn('projects', 'organization_id', "TEXT NOT NULL DEFAULT 'org-promptops'");
    this.ensureColumn('projects', 'status', "TEXT NOT NULL DEFAULT 'active'");
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private seedFromLegacy() {
    const seeded = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('legacy_seed_v1') as Row | undefined;
    if (seeded) return;

    const config = readJson<WorldConfig>(LEGACY_CONFIG_FILE);
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO projects (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        DEFAULT_PROJECT_ID,
        '多人角色 Prompt 评测',
        '统一管理 Prompt 版本、受控对比实验和发布证据。',
        timestamp,
        timestamp,
      );

      const promptId = 'resource-prompt-multiplayer';
      this.insertResource({
        id: promptId,
        kind: 'prompt',
        name: '多人角色对话 Prompt',
        description: '多人群聊角色回复的主 Prompt，使用旧版与新版做固定条件对比。',
        owner: 'Prompt 团队',
        tags: ['多人对话', '主评测'],
        data: {},
        timestamp,
      });

      const builders = config?.builderPrompts ?? [];
      const baselineBuilder = builders.find((item) => item.id === 'prompt-a') ?? builders[0];
      const candidateBuilder = builders.find((item) => item.id === 'prompt-b') ?? builders[builders.length - 1];
      const fallbackBuilder: PromptBuilderItem = {
        id: 'studio-prompt',
        label: '多人角色对话 Prompt',
        template: '',
      };
      const snapshots = [baselineBuilder ?? fallbackBuilder, candidateBuilder ?? baselineBuilder ?? fallbackBuilder];
      snapshots.forEach((source, index) => {
        const snapshot = structuredClone(source);
        snapshot.id = 'studio-evaluation';
        snapshot.label = '多人角色对话 Prompt';
        this.db.prepare(`
          INSERT INTO prompt_versions
            (id, prompt_id, version_number, title, summary, status, snapshot_json, created_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `prompt-version-${index + 1}`,
          promptId,
          index + 1,
          index === 0 ? '历史基线' : '当前优化版',
          index === 0 ? '从旧配置迁移的基线版本。' : '从当前线上配置迁移的候选版本。',
          index === snapshots.length - 1 ? 'published' : 'archived',
          JSON.stringify(snapshot),
          timestamp + index,
          '系统迁移',
        );
      });

      for (const character of config?.characters ?? []) {
        this.insertResource({
          id: `resource-character-${character.id}`,
          kind: 'character',
          name: character.name,
          description: '从多人房间角色配置迁移。',
          owner: '内容团队',
          tags: ['角色'],
          data: { name: character.name, persona: character.persona },
          timestamp,
        });
      }

      this.insertResource({
        id: 'resource-world-default',
        kind: 'world',
        name: '当前故事世界',
        description: '从多人房间当前世界观迁移。',
        owner: '内容团队',
        tags: ['世界观'],
        data: { content: config?.worldSetting ?? '' },
        timestamp,
      });

      const suiteData: StudioTestSuiteData = {
        cases: [
          {
            id: 'case-direct',
            title: '直接回应',
            category: '指令遵循',
            input: '把刚才发现的路线告诉我。',
            expected: '先回应路线，不转移话题。',
            labels: ['核心'],
          },
        ],
      };
      this.insertResource({
        id: 'resource-suite-core',
        kind: 'test-suite',
        name: '多人群聊核心回归',
        description: '核心质量回归用例。',
        owner: '评测团队',
        tags: ['回归', '核心'],
        data: suiteData,
        timestamp,
      });

      this.insertResource({
        id: 'resource-scorecard-default',
        kind: 'scorecard',
        name: '多人群聊十维评分标准',
        description: '团队统一的 100 分质量评分卡。',
        owner: '评测团队',
        tags: ['十维评分'],
        data: defaultScorecard(),
        timestamp,
      });
      this.insertResource({
        id: 'resource-model-default',
        kind: 'model-config',
        name: '默认生成模型',
        description: '两侧评测锁定使用同一模型与采样参数。',
        owner: '平台团队',
        tags: ['模型'],
        data: defaultModelConfig(),
        timestamp,
      });
      this.insertResource({
        id: 'resource-scheduler-default',
        kind: 'scheduler-policy',
        name: '多人群聊默认调度',
        description: '随机 1..N 个角色、@ 唤起和两轮主动发言。',
        owner: '产品团队',
        tags: ['调度'],
        data: defaultSchedulerPolicy(),
        timestamp,
      });
      this.insertResource({
        id: 'resource-memory-default',
        kind: 'memory-policy',
        name: '无记忆基线',
        description: '默认关闭记忆，用于纯 Prompt 版本控制变量对比。',
        owner: '算法团队',
        tags: ['记忆', '基线'],
        data: defaultMemoryPolicy(),
        timestamp,
      });

      this.addAudit(DEFAULT_PROJECT_ID, 'migration', 'legacy-v1', 'import', '系统迁移', '已导入旧 Prompt、角色、世界观与测试集。');
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('legacy_seed_v1', String(timestamp));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateCollaboration() {
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO organizations (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        DEFAULT_ORGANIZATION_ID,
        'PromptOps 团队',
        '用于管理 Prompt、受控评测证据与发布决策的协作空间。',
        timestamp,
        timestamp,
      );
      this.db.prepare(`
        UPDATE projects SET organization_id = COALESCE(NULLIF(organization_id, ''), ?), status = COALESCE(NULLIF(status, ''), 'active')
      `).run(DEFAULT_ORGANIZATION_ID);
      this.db.prepare(`
        INSERT OR IGNORE INTO members
          (id, organization_id, name, username, email, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'owner', 'active', ?, ?)
      `).run(DEFAULT_MEMBER_ID, DEFAULT_ORGANIZATION_ID, '团队管理员', 'owner', 'owner@promptops.local', timestamp, timestamp);
      const projects = this.db.prepare('SELECT id FROM projects').all() as Row[];
      for (const project of projects) {
        this.db.prepare(`
          INSERT OR IGNORE INTO project_members (project_id, member_id, role, added_at)
          VALUES (?, ?, 'owner', ?)
        `).run(String(project.id), DEFAULT_MEMBER_ID, timestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateEffectivePromptSnapshot() {
    const migrated = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get('effective_prompt_snapshot_v2') as Row | undefined;
    if (migrated) return;
    const config = readJson<WorldConfig>(LEGACY_CONFIG_FILE);
    const currentBuilder = config?.builderPrompts?.find((item) => item.id === 'prompt-b');
    if (!currentBuilder) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('effective_prompt_snapshot_v2', String(now()));
      return;
    }
    const prompt = this.getResource('resource-prompt-multiplayer');
    const existing = this.listPromptVersions(prompt.id);
    if (existing.some((item) => item.snapshot.template.includes('## 短篇公屏演绎规范'))) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('effective_prompt_snapshot_v2', String(now()));
      return;
    }
    const snapshot = structuredClone(currentBuilder);
    snapshot.id = 'studio-evaluation';
    snapshot.label = prompt.name;
    snapshot.template = `${snapshot.template.trim()}\n\n${SHORT_PUBLIC_DIALOGUE_STANDARD.trim()}`;
    const version = this.createPromptVersion(prompt.id, {
      title: '当前有效版本',
      summary: '将旧房间运行时附加的短篇演绎规范并入 Prompt，使评测快照与实际生效内容一致。',
      snapshot,
      createdBy: '系统迁移',
    });
    this.publishPromptVersion(prompt.id, version.id, '系统迁移');
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('effective_prompt_snapshot_v2', String(now()));
  }

  private insertResource(input: {
    id: string;
    kind: StudioResourceKind;
    name: string;
    description: string;
    owner: string;
    tags: string[];
    data: unknown;
    timestamp: number;
  }) {
    this.db.prepare(`
      INSERT OR IGNORE INTO resources
        (id, project_id, kind, name, description, owner, tags_json, status, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      input.id,
      DEFAULT_PROJECT_ID,
      input.kind,
      input.name,
      input.description,
      input.owner,
      JSON.stringify(input.tags),
      JSON.stringify(input.data),
      input.timestamp,
      input.timestamp,
    );
  }

  private migrateAccountUsernames() {
    const columns = this.db.prepare('PRAGMA table_info(members)').all() as Row[];
    if (!columns.some((column) => column.name === 'username')) {
      this.db.exec('ALTER TABLE members ADD COLUMN username TEXT');
    }

    const members = this.db.prepare('SELECT id, email, username FROM members').all() as Row[];
    const used = new Set<string>();
    for (const member of members) {
      const existing = cleanUsername(member.username);
      if (existing && !used.has(existing)) {
        used.add(existing);
        continue;
      }
      const rawSeed = cleanText(member.email, 'member', 120).split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const base = (rawSeed.length >= 3 ? rawSeed : `user${rawSeed || 'member'}`).slice(0, 36);
      let username = base;
      let suffix = 1;
      while (used.has(username)) username = `${base.slice(0, 36)}${suffix++}`;
      used.add(username);
      this.db.prepare('UPDATE members SET username = ? WHERE id = ?').run(username, String(member.id));
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_org_username_idx ON members(organization_id, username)');
  }

  private rowToProject(row: Row): StudioProject {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id ?? DEFAULT_ORGANIZATION_ID),
      name: String(row.name),
      description: String(row.description ?? ''),
      status: row.status === 'archived' ? 'archived' : 'active',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToOrganization(row: Row): StudioOrganization {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToMember(row: Row): StudioMember {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      name: String(row.name),
      username: cleanUsername(row.username) || 'unknown',
      role: isMemberRole(row.role) ? row.role : 'viewer',
      status: row.status === 'active' || row.status === 'disabled' ? row.status : 'invited',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToProjectMember(row: Row): StudioProjectMember {
    const member = row.member_id ? this.rowToMember(row) : undefined;
    return {
      projectId: String(row.project_id),
      memberId: String(row.member_id),
      role: isMemberRole(row.project_role ?? row.role) ? (row.project_role ?? row.role) as StudioMemberRole : 'viewer',
      addedAt: Number(row.added_at),
      member,
    };
  }

  private rowToResource(row: Row): StudioResource {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      kind: row.kind as StudioResourceKind,
      name: String(row.name),
      description: String(row.description ?? ''),
      owner: String(row.owner ?? ''),
      tags: parseJson<string[]>(row.tags_json, []),
      status: row.status === 'archived' ? 'archived' : 'active',
      data: hydrateModelCardData(
        row.kind as StudioResourceKind,
        parseJson<Record<string, unknown>>(row.data_json, {}),
      ),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    };
  }

  private rowToVersion(row: Row): StudioPromptVersion {
    return {
      id: String(row.id),
      promptId: String(row.prompt_id),
      number: Number(row.version_number),
      title: String(row.title),
      summary: String(row.summary ?? ''),
      status: row.status as StudioPromptVersion['status'],
      snapshot: parseJson<PromptBuilderItem>(row.snapshot_json, {
        id: 'studio-evaluation',
        label: 'Prompt',
        template: '',
      }),
      createdAt: Number(row.created_at),
      createdBy: String(row.created_by),
    };
  }

  private rowToEvaluation(row: Row): StudioEvaluation {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      name: String(row.name),
      promptId: String(row.prompt_id),
      baselineVersionId: String(row.baseline_version_id),
      candidateVersionId: String(row.candidate_version_id),
      suiteId: String(row.suite_id),
      status: row.status as StudioEvaluation['status'],
      sharedConfig: parseJson<StudioSharedConfigSnapshot>(row.shared_config_json, {} as StudioSharedConfigSnapshot),
      result: parseJson<StudioEvaluationResult | null>(row.result_json, null),
      error: row.error == null ? null : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      createdBy: String(row.created_by),
      deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
    };
  }

  private rowToModelComparison(row: Row): StudioModelComparison {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      name: String(row.name),
      promptId: String(row.prompt_id),
      versionId: String(row.version_id),
      suiteId: String(row.suite_id),
      status: row.status as StudioModelComparison['status'],
      sharedConfig: parseJson<StudioModelComparisonSharedConfig>(row.shared_config_json, {} as StudioModelComparisonSharedConfig),
      result: parseJson<StudioModelComparisonResult | null>(row.result_json, null),
      error: row.error == null ? null : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      createdBy: String(row.created_by),
    };
  }

  private rowToAudit(row: Row): StudioAuditLog {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      action: String(row.action),
      actor: String(row.actor),
      summary: String(row.summary),
      createdAt: Number(row.created_at),
    };
  }

  private rowToReviewComment(row: Row): StudioReviewComment {
    return {
      id: String(row.id),
      reviewId: String(row.review_id),
      authorId: String(row.author_id),
      authorName: String(row.author_name),
      content: String(row.content),
      decision: row.decision === 'approve' || row.decision === 'changes_requested' ? row.decision : 'comment',
      createdAt: Number(row.created_at),
    };
  }

  private rowToReviewCaseAssessment(row: Row): StudioReviewCaseAssessment {
    return {
      id: String(row.id),
      reviewId: String(row.review_id),
      caseId: String(row.case_id),
      reviewerId: String(row.reviewer_id),
      reviewerName: String(row.reviewer_name),
      revision: Number(row.revision),
      scores: parseJson<StudioManualScores>(row.scores_json, {} as StudioManualScores),
      overallScore: Number(row.overall_score),
      decision: row.decision === 'approve' || row.decision === 'changes_requested' ? row.decision : 'comment',
      comment: String(row.comment ?? ''),
      createdAt: Number(row.created_at),
    };
  }

  private rowToReviewCase(row: Row, assessments: StudioReviewCaseAssessment[] = []): StudioReviewCase {
    return {
      id: String(row.id),
      reviewId: String(row.review_id),
      caseId: String(row.case_id),
      caseIndex: Number(row.case_index),
      title: String(row.title),
      category: String(row.category),
      input: String(row.input),
      expected: String(row.expected),
      baseline: parseJson(row.baseline_json, null),
      candidate: parseJson(row.candidate_json, null),
      assessments,
    };
  }

  private rowToReview(
    row: Row,
    comments: StudioReviewComment[] = [],
    caseItems: StudioReviewCase[] = [],
  ): StudioReviewRequest {
    const status = row.status === 'approved' || row.status === 'changes_requested' || row.status === 'closed' ? row.status : 'open';
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      promptId: String(row.prompt_id),
      versionId: String(row.version_id),
      evaluationId: row.evaluation_id == null ? null : String(row.evaluation_id),
      title: String(row.title),
      description: String(row.description ?? ''),
      status,
      requestedById: String(row.requested_by_id),
      requestedByName: String(row.requested_by_name),
      reviewerIds: parseJson<string[]>(row.reviewer_ids_json, []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      comments,
      caseItems,
    };
  }

  private rowToManualAssessment(row: Row): StudioManualAssessment {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      promptId: String(row.prompt_id),
      versionId: String(row.version_id),
      memberId: String(row.member_id),
      memberName: String(row.member_name),
      revision: Number(row.revision),
      scores: parseJson<StudioManualScores>(row.scores_json, {} as StudioManualScores),
      overallScore: Number(row.overall_score),
      scenario: String(row.scenario ?? ''),
      turns: Number(row.turns ?? 0),
      comment: String(row.comment),
      createdAt: Number(row.created_at),
    };
  }

  private addAudit(projectId: string, entityType: string, entityId: string, action: string, actor: string, summary: string) {
    this.db.prepare(`
      INSERT INTO audit_logs
        (id, project_id, entity_type, entity_id, action, actor, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), projectId, entityType, entityId, action, actor, summary, now());
  }

  getProject(projectId = DEFAULT_PROJECT_ID) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    if (!row) throw new Error('项目不存在');
    return this.rowToProject(row);
  }

  listProjects(includeArchived = false) {
    const rows = this.db.prepare(`
      SELECT * FROM projects
      WHERE organization_id = ? ${includeArchived ? '' : "AND status = 'active'"}
      ORDER BY updated_at DESC, name ASC
    `).all(DEFAULT_ORGANIZATION_ID) as Row[];
    return rows.map((row) => this.rowToProject(row));
  }

  getOrganization() {
    const row = this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(DEFAULT_ORGANIZATION_ID) as Row | undefined;
    if (!row) throw new Error('组织不存在');
    return this.rowToOrganization(row);
  }

  getAuthBootstrap(): StudioAuthBootstrap {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as Row;
    return { setupRequired: Number(row.count) === 0 };
  }

  setupInitialOwner(input: Pick<StudioCreateAccountInput, 'name' | 'username' | 'password'>): StudioAuthSession {
    if (!this.getAuthBootstrap().setupRequired) throw new Error('工作区已初始化，请使用账号登录');
    const username = cleanUsername(input.username);
    if (!username) throw new Error('账号仅支持 3 至 40 位字母或数字');
    const password = validatePassword(input.password);
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        UPDATE members SET name = ?, username = ?, email = ?, status = 'active', updated_at = ? WHERE id = ?
      `).run(cleanText(input.name, '团队管理员', 40), username, `${username}@local.promptstudio`, timestamp, DEFAULT_MEMBER_ID);
      this.db.prepare(`
        INSERT INTO project_members (project_id, member_id, role, added_at)
        VALUES (?, ?, 'owner', ?)
        ON CONFLICT(project_id, member_id) DO UPDATE SET role = excluded.role
      `).run(DEFAULT_PROJECT_ID, DEFAULT_MEMBER_ID, timestamp);
      this.db.prepare(`
        INSERT INTO accounts (id, member_id, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), DEFAULT_MEMBER_ID, hashPassword(password), timestamp, timestamp);
      const member = this.getMember(DEFAULT_MEMBER_ID);
      this.addAudit(DEFAULT_PROJECT_ID, 'account', DEFAULT_MEMBER_ID, 'setup', member.name, '初始化工作区负责人账号');
      this.db.exec('COMMIT');
      return this.createAuthSession(member.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  login(usernameInput: string, passwordInput: string): StudioAuthSession {
    const username = cleanUsername(usernameInput);
    const password = validatePassword(passwordInput);
    if (!username) throw new Error('账号或密码不正确');
    const row = this.db.prepare(`
      SELECT a.id AS account_id, a.password_hash, m.*
      FROM accounts a JOIN members m ON m.id = a.member_id
      WHERE m.organization_id = ? AND m.username = ?
    `).get(DEFAULT_ORGANIZATION_ID, username) as Row | undefined;
    if (!row || typeof row.password_hash !== 'string' || !verifyPassword(password, row.password_hash)) {
      throw new Error('账号或密码不正确');
    }
    const member = this.rowToMember(row);
    if (member.status !== 'active') throw new Error('账号尚未激活或已被停用');
    return this.createAuthSession(member.id, String(row.account_id));
  }

  authenticate(token: string | undefined): StudioAuthSession | null {
    if (!token) return null;
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now());
    const row = this.db.prepare(`
      SELECT s.account_id, s.expires_at, m.*
      FROM auth_sessions s
      JOIN accounts a ON a.id = s.account_id
      JOIN members m ON m.id = a.member_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashAccessToken(token), now()) as Row | undefined;
    if (!row) return null;
    const member = this.rowToMember(row);
    if (member.status !== 'active') return null;
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), hashAccessToken(token));
    return { token, expiresAt: Number(row.expires_at), member };
  }

  logout(token: string | undefined) {
    if (!token) return;
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashAccessToken(token));
  }

  createAccount(input: StudioCreateAccountInput, actor: StudioMember): StudioMember {
    const username = cleanUsername(input.username);
    if (!username) throw new Error('账号仅支持 3 至 40 位字母或数字');
    const password = validatePassword(input.password);
    const organizationRole = isMemberRole(input.role) ? input.role : 'viewer';
    const projectRole = isMemberRole(input.projectRole) ? input.projectRole : organizationRole;
    const projectId = input.projectId || DEFAULT_PROJECT_ID;
    this.getProject(projectId);
    const timestamp = now();
    const member: StudioMember = {
      id: `member-${randomUUID()}`,
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: cleanText(input.name, '未命名成员', 40),
      username,
      role: organizationRole,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO members (id, organization_id, name, username, email, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(member.id, member.organizationId, member.name, member.username, `${member.username}@local.promptstudio`, member.role, member.status, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO accounts (id, member_id, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), member.id, hashPassword(password), timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO project_members (project_id, member_id, role, added_at)
        VALUES (?, ?, ?, ?)
      `).run(projectId, member.id, projectRole, timestamp);
      this.addAudit(projectId, 'account', member.id, 'create', actor.name, `创建账号：${member.name}`);
      this.db.exec('COMMIT');
      return member;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private createAuthSession(memberId: string, accountId?: string): StudioAuthSession {
    const resolvedAccountId = accountId ?? String((this.db.prepare('SELECT id FROM accounts WHERE member_id = ?').get(memberId) as Row).id);
    const token = randomBytes(32).toString('base64url');
    const timestamp = now();
    const expiresAt = timestamp + AUTH_SESSION_TTL_MS;
    this.db.prepare(`
      INSERT INTO auth_sessions (id, account_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), resolvedAccountId, hashAccessToken(token), expiresAt, timestamp, timestamp);
    return { token, expiresAt, member: this.getMember(memberId) };
  }

  listMembers() {
    const rows = this.db.prepare(`
      SELECT * FROM members WHERE organization_id = ? ORDER BY status ASC, created_at ASC
    `).all(DEFAULT_ORGANIZATION_ID) as Row[];
    return rows.map((row) => this.rowToMember(row));
  }

  getMember(memberId = DEFAULT_MEMBER_ID) {
    const row = this.db.prepare('SELECT * FROM members WHERE id = ? AND organization_id = ?').get(memberId, DEFAULT_ORGANIZATION_ID) as Row | undefined;
    if (!row) throw new Error('成员不存在');
    return this.rowToMember(row);
  }

  listProjectMembers(projectId = DEFAULT_PROJECT_ID) {
    const rows = this.db.prepare(`
      SELECT pm.project_id, pm.member_id, pm.role AS project_role, pm.added_at,
        m.id, m.organization_id, m.name, m.username, m.email, m.role, m.status, m.created_at, m.updated_at
      FROM project_members pm
      JOIN members m ON m.id = pm.member_id
      WHERE pm.project_id = ?
      ORDER BY pm.added_at ASC
    `).all(projectId) as Row[];
    return rows.map((row) => this.rowToProjectMember(row));
  }

  getProjectRole(projectId: string, memberId = DEFAULT_MEMBER_ID): StudioMemberRole {
    const member = this.getMember(memberId);
    if (member.status !== 'active') throw new Error('当前成员未激活，不能执行项目操作');
    const row = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND member_id = ?').get(projectId, memberId) as Row | undefined;
    if (!row || !isMemberRole(row.role)) throw new Error('当前成员没有该项目的访问权限');
    return row.role;
  }

  assertProjectPermission(projectId: string, memberId: string | undefined, allowed: StudioMemberRole[]) {
    if (!memberId) throw new Error('请先登录');
    const role = this.getProjectRole(projectId, memberId);
    if (!allowed.includes(role)) throw new Error('当前项目角色没有此操作权限');
    return this.getMember(memberId);
  }

  createProject(input: StudioCreateProjectInput, actor: StudioMember) {
    const timestamp = now();
    const project: StudioProject = {
      id: `project-${randomUUID()}`,
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: cleanText(input.name, '未命名项目', 80),
      description: cleanText(input.description, '', 500),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO projects (id, organization_id, name, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(project.id, project.organizationId, project.name, project.description, project.status, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO project_members (project_id, member_id, role, added_at)
        VALUES (?, ?, 'owner', ?)
      `).run(project.id, actor.id, timestamp);
      this.addAudit(project.id, 'project', project.id, 'create', actor.name, `创建项目：${project.name}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return project;
  }

  updateProject(projectId: string, input: Partial<StudioCreateProjectInput & { status: StudioProject['status'] }>, actor: StudioMember) {
    const current = this.getProject(projectId);
    const next = {
      name: cleanText(input.name, current.name, 80),
      description: typeof input.description === 'string' ? input.description.slice(0, 500) : current.description,
      status: input.status === 'archived' ? 'archived' : 'active',
      updatedAt: now(),
    };
    this.db.prepare(`
      UPDATE projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(next.name, next.description, next.status, next.updatedAt, projectId);
    this.addAudit(projectId, 'project', projectId, 'update', actor.name, `更新项目：${next.name}`);
    return this.getProject(projectId);
  }

  createMember(input: StudioCreateMemberInput, actor: StudioMember) {
    const timestamp = now();
    const username = cleanUsername(input.username);
    if (!username) throw new Error('账号仅支持 3 至 40 位字母或数字');
    const member: StudioMember = {
      id: `member-${randomUUID()}`,
      organizationId: DEFAULT_ORGANIZATION_ID,
      name: cleanText(input.name, '未命名成员', 40),
      username,
      role: isMemberRole(input.role) ? input.role : 'viewer',
      status: 'invited',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.prepare(`
      INSERT INTO members (id, organization_id, name, username, email, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(member.id, member.organizationId, member.name, member.username, `${member.username}@local.promptstudio`, member.role, member.status, timestamp, timestamp);
    this.addAudit(DEFAULT_PROJECT_ID, 'member', member.id, 'invite', actor.name, `邀请成员：${member.name}`);
    return member;
  }

  updateMember(memberId: string, input: Partial<StudioCreateMemberInput & { status: StudioMember['status'] }>, actor: StudioMember) {
    const current = this.getMember(memberId);
    const username = input.username == null ? current.username : cleanUsername(input.username);
    if (!username) throw new Error('账号仅支持 3 至 40 位字母或数字');
    const role = isMemberRole(input.role) ? input.role : current.role;
    const status = input.status === 'active' || input.status === 'disabled' || input.status === 'invited' ? input.status : current.status;
    this.db.prepare(`
      UPDATE members SET name = ?, username = ?, email = ?, role = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(cleanText(input.name, current.name, 40), username, `${username}@local.promptstudio`, role, status, now(), memberId);
    this.addAudit(DEFAULT_PROJECT_ID, 'member', memberId, 'update', actor.name, `更新成员：${current.name}`);
    return this.getMember(memberId);
  }

  setProjectMember(projectId: string, memberId: string, role: StudioMemberRole, actor: StudioMember) {
    this.getProject(projectId);
    this.getMember(memberId);
    if (!isMemberRole(role)) throw new Error('项目角色无效');
    this.db.prepare(`
      INSERT INTO project_members (project_id, member_id, role, added_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, member_id) DO UPDATE SET role = excluded.role
    `).run(projectId, memberId, role, now());
    this.addAudit(projectId, 'project_member', memberId, 'upsert', actor.name, `设置项目成员角色：${role}`);
    return this.listProjectMembers(projectId);
  }

  removeProjectMember(projectId: string, memberId: string, actor: StudioMember) {
    if (memberId === DEFAULT_MEMBER_ID) throw new Error('默认项目负责人不能移除');
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND member_id = ?').run(projectId, memberId);
    this.addAudit(projectId, 'project_member', memberId, 'remove', actor.name, '移除项目成员');
    return this.listProjectMembers(projectId);
  }

  listResources(options: { projectId?: string; kind?: StudioResourceKind; includeDeleted?: boolean } = {}) {
    const where = ['project_id = ?'];
    const params: Array<string | number> = [options.projectId ?? DEFAULT_PROJECT_ID];
    if (options.kind) {
      where.push('kind = ?');
      params.push(options.kind);
    }
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    const rows = this.db.prepare(`
      SELECT * FROM resources
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, name ASC
    `).all(...params) as Row[];
    return rows.map((row) => this.rowToResource(row));
  }

  getResource(id: string, includeDeleted = false) {
    const row = this.db.prepare(`
      SELECT * FROM resources WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(id) as Row | undefined;
    if (!row) throw new Error('资源不存在或已在回收站');
    return this.rowToResource(row);
  }

  private getProjectResource(id: string, projectId: string) {
    const resource = this.getResource(id);
    if (resource.projectId !== projectId) throw new Error('资源不属于当前项目');
    return resource;
  }

  getModelConfigForUse(id: string, projectId: string, fallback?: StudioModelConfigData) {
    try {
      const resource = this.getResource(id, true);
      if (resource.projectId === projectId && resource.kind === 'model-config') {
        return resource.data as unknown as StudioModelConfigData;
      }
    } catch {
      // Older snapshots may refer to a removed resource; use their non-secret config below.
    }
    if (fallback) return fallback;
    throw new Error('模型卡不存在或不属于当前项目');
  }

  createResource(input: StudioCreateResourceInput, actor = '团队成员') {
    const timestamp = now();
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    this.getProject(projectId);
    const inputData = (input.data ?? {}) as Record<string, unknown>;
    const storedData = prepareModelCardData(input.kind, inputData);
    const resource: StudioResource = {
      id: `resource-${randomUUID()}`,
      projectId,
      kind: input.kind,
      name: cleanText(input.name, '未命名资源', 80),
      description: cleanText(input.description, '', 500),
      owner: cleanText(input.owner, actor, 40),
      tags: cleanTags(input.tags),
      status: 'active',
      data: hydrateModelCardData(input.kind, storedData),
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    this.db.prepare(`
      INSERT INTO resources
        (id, project_id, kind, name, description, owner, tags_json, status, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resource.id,
      resource.projectId,
      resource.kind,
      resource.name,
      resource.description,
      resource.owner,
      JSON.stringify(resource.tags),
      resource.status,
      JSON.stringify(storedData),
      timestamp,
      timestamp,
    );
    this.addAudit(resource.projectId, 'resource', resource.id, 'create', actor, `创建${resource.kind}：${resource.name}`);
    if (resource.kind === 'prompt') {
      const snapshot: PromptBuilderItem = {
        id: 'studio-evaluation',
        label: resource.name,
        template: typeof input.data?.template === 'string' ? input.data.template : '',
      };
      this.createPromptVersion(resource.id, {
        title: '初始草稿',
        summary: '创建 Prompt 时生成。',
        snapshot,
        createdBy: actor,
      });
    }
    return resource;
  }

  updateResource(
    id: string,
    input: Partial<Pick<StudioResource, 'name' | 'description' | 'owner' | 'tags' | 'status' | 'data'>>,
    actor = '团队成员',
  ) {
    const current = this.getResource(id);
    const nextData = input.data && current.kind !== 'prompt'
      ? this.mergeResourceData(current.kind, current.data, input.data)
      : current.data;
    const storedData = prepareModelCardData(current.kind, nextData);
    const next = {
      name: cleanText(input.name, current.name, 80),
      description: typeof input.description === 'string' ? input.description.slice(0, 500) : current.description,
      owner: cleanText(input.owner, current.owner, 40),
      tags: input.tags ? cleanTags(input.tags) : current.tags,
      status: input.status === 'archived' ? 'archived' : input.status === 'active' ? 'active' : current.status,
      data: hydrateModelCardData(current.kind, storedData),
      updatedAt: now(),
    };
    this.db.prepare(`
      UPDATE resources
      SET name = ?, description = ?, owner = ?, tags_json = ?, status = ?, data_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.description,
      next.owner,
      JSON.stringify(next.tags),
      next.status,
      JSON.stringify(storedData),
      next.updatedAt,
      id,
    );
    this.addAudit(current.projectId, 'resource', id, 'update', actor, `更新资源：${next.name}`);
    return this.getResource(id);
  }

  private mergeResourceData(
    kind: StudioResourceKind,
    current: Record<string, unknown>,
    input: Record<string, unknown>,
  ) {
    if (kind !== 'model-config') return input;
    const next = { ...current, ...input };
    const currentApiKey = typeof current.apiKey === 'string' ? current.apiKey : '';
    const incomingApiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (input.clearApiKey === true) {
      delete next.apiKey;
    } else if (!incomingApiKey && currentApiKey) {
      next.apiKey = currentApiKey;
    } else if (incomingApiKey) {
      next.apiKey = incomingApiKey;
    }
    return next;
  }

  deleteResource(id: string, actor = '团队成员') {
    const resource = this.getResource(id);
    const deletedAt = now();
    this.db.prepare('UPDATE resources SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(deletedAt, deletedAt, id);
    this.addAudit(resource.projectId, 'resource', id, 'soft_delete', actor, `移入回收站：${resource.name}`);
  }

  restoreResource(id: string, actor = '团队成员') {
    const resource = this.getResource(id, true);
    if (!resource.deletedAt) return resource;
    this.db.prepare('UPDATE resources SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    this.addAudit(resource.projectId, 'resource', id, 'restore', actor, `恢复资源：${resource.name}`);
    return this.getResource(id);
  }

  permanentlyDeleteResource(id: string, actor = '团队成员') {
    const resource = this.getResource(id, true);
    if (!resource.deletedAt) throw new Error('资源必须先移入回收站');
    const promptVersionCount = resource.kind === 'prompt'
      ? Number((this.db.prepare('SELECT COUNT(*) AS count FROM prompt_versions WHERE prompt_id = ?').get(id) as Row).count)
      : 0;
    const evaluationReferenceCount = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM evaluations
      WHERE prompt_id = ? OR suite_id = ? OR shared_config_json LIKE ?
    `).get(id, id, `%${id}%`) as Row).count);
    if (promptVersionCount > 0 || evaluationReferenceCount > 0) {
      throw new Error('该资源被不可变版本或评测证据引用，不能永久删除');
    }
    this.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    this.addAudit(resource.projectId, 'resource', id, 'permanent_delete', actor, `永久删除未引用资源：${resource.name}`);
  }

  listPromptVersions(promptId?: string, projectId?: string) {
    const rows = promptId
      ? this.db.prepare('SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version_number DESC').all(promptId) as Row[]
      : this.db.prepare(`
        SELECT pv.* FROM prompt_versions pv
        JOIN resources r ON r.id = pv.prompt_id
        WHERE r.project_id = ?
        ORDER BY pv.created_at DESC
      `).all(projectId ?? DEFAULT_PROJECT_ID) as Row[];
    return rows.map((row) => this.rowToVersion(row));
  }

  getPromptVersion(id: string) {
    const row = this.db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('Prompt 版本不存在');
    return this.rowToVersion(row);
  }

  createPromptVersion(
    promptId: string,
    input: {
      title?: string;
      summary?: string;
      snapshot: PromptBuilderItem;
      createdBy?: string;
    },
  ) {
    const prompt = this.getResource(promptId);
    if (prompt.kind !== 'prompt') throw new Error('该资源不是 Prompt');
    const numberRow = this.db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_number
      FROM prompt_versions WHERE prompt_id = ?
    `).get(promptId) as Row;
    const number = Number(numberRow.next_number);
    const version: StudioPromptVersion = {
      id: `prompt-version-${randomUUID()}`,
      promptId,
      number,
      title: cleanText(input.title, `版本 ${number}`, 80),
      summary: cleanText(input.summary, '未填写变更说明。', 500),
      status: 'draft',
      snapshot: {
        ...structuredClone(input.snapshot),
        id: 'studio-evaluation',
        label: prompt.name,
      },
      createdAt: now(),
      createdBy: cleanText(input.createdBy, '团队成员', 40),
    };
    this.db.prepare(`
      INSERT INTO prompt_versions
        (id, prompt_id, version_number, title, summary, status, snapshot_json, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.id,
      version.promptId,
      version.number,
      version.title,
      version.summary,
      version.status,
      JSON.stringify(version.snapshot),
      version.createdAt,
      version.createdBy,
    );
    this.db.prepare('UPDATE resources SET updated_at = ? WHERE id = ?').run(version.createdAt, promptId);
    this.addAudit(prompt.projectId, 'prompt_version', version.id, 'create', version.createdBy, `保存 v${version.number}：${version.title}`);
    return version;
  }

  publishPromptVersion(promptId: string, versionId: string, actor = '团队成员') {
    const version = this.getPromptVersion(versionId);
    if (version.promptId !== promptId) throw new Error('版本不属于该 Prompt');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        UPDATE prompt_versions SET status = 'archived'
        WHERE prompt_id = ? AND status = 'published'
      `).run(promptId);
      this.db.prepare(`UPDATE prompt_versions SET status = 'published' WHERE id = ?`).run(versionId);
      this.db.prepare('UPDATE resources SET updated_at = ? WHERE id = ?').run(now(), promptId);
      this.addAudit(this.getResource(promptId).projectId, 'prompt_version', versionId, 'publish', actor, `发布 v${version.number}：${version.title}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listPromptVersions(promptId);
  }

  private defaultResource(kind: StudioResourceKind, projectId: string) {
    const resource = this.listResources({ projectId, kind }).find((item) => item.status === 'active');
    if (!resource) throw new Error(`缺少可用资源：${kind}`);
    return resource;
  }

  buildSharedConfig(input: StudioCreateEvaluationInput, projectId: string): StudioSharedConfigSnapshot {
    const characters = (
      input.characterResourceIds?.length
        ? input.characterResourceIds.map((id) => this.getProjectResource(id, projectId))
        : this.listResources({ projectId, kind: 'character' })
    ).filter((item) => item.kind === 'character');
    if (!characters.length) throw new Error('评测至少需要一个角色');

    const world = input.worldResourceId
      ? this.getProjectResource(input.worldResourceId, projectId)
      : this.defaultResource('world', projectId);
    const model = input.modelConfigResourceId
      ? this.getProjectResource(input.modelConfigResourceId, projectId)
      : this.defaultResource('model-config', projectId);
    const scheduler = input.schedulerPolicyResourceId
      ? this.getProjectResource(input.schedulerPolicyResourceId, projectId)
      : this.defaultResource('scheduler-policy', projectId);
    const memory = input.memoryPolicyResourceId
      ? this.getProjectResource(input.memoryPolicyResourceId, projectId)
      : this.defaultResource('memory-policy', projectId);
    const scorecard = input.scorecardResourceId
      ? this.getProjectResource(input.scorecardResourceId, projectId)
      : this.defaultResource('scorecard', projectId);
    const suite = this.getProjectResource(input.suiteId, projectId);
    if (suite.kind !== 'test-suite') throw new Error('选择的资源不是测试集');

    return {
      characterResourceIds: characters.map((item) => item.id),
      characters: characters.map((item) => ({
        id: item.id,
        name: cleanText(item.data.name, item.name, 80),
        persona: cleanText(item.data.persona, '', 4000),
      })),
      worldResourceId: world.id,
      worldSetting: cleanText(world.data.content, '', 20000),
      modelConfigResourceId: model.id,
      modelConfig: modelConfigSnapshot(model.data as unknown as StudioModelConfigData),
      schedulerPolicyResourceId: scheduler.id,
      schedulerPolicy: scheduler.data as unknown as StudioSchedulerPolicyData,
      memoryPolicyResourceId: memory.id,
      memoryPolicy: memory.data as unknown as StudioMemoryPolicyData,
      scorecardResourceId: scorecard.id,
      scorecard: scorecard.data as unknown as StudioScorecardData,
      suiteResourceId: suite.id,
      suiteName: suite.name,
      cases: (suite.data as unknown as StudioTestSuiteData).cases ?? [],
    };
  }

  createEvaluation(input: StudioCreateEvaluationInput) {
    const prompt = this.getResource(input.promptId);
    const projectId = input.projectId ?? prompt.projectId;
    if (projectId !== prompt.projectId) throw new Error('Prompt 不属于当前项目');
    if (prompt.kind !== 'prompt') throw new Error('选择的资源不是 Prompt');
    const baseline = this.getPromptVersion(input.baselineVersionId);
    const candidate = this.getPromptVersion(input.candidateVersionId);
    if (baseline.promptId !== prompt.id || candidate.promptId !== prompt.id) {
      throw new Error('旧版和新版必须属于同一个 Prompt');
    }
    if (baseline.id === candidate.id) throw new Error('旧版和新版不能是同一个版本');

    const sharedConfig = this.buildSharedConfig(input, projectId);
    if (!sharedConfig.cases.length) throw new Error('测试集没有案例');
    const timestamp = now();
    const evaluation: StudioEvaluation = {
      id: `evaluation-${randomUUID()}`,
      projectId,
      name: cleanText(input.name, `${prompt.name} v${baseline.number} vs v${candidate.number}`, 120),
      promptId: prompt.id,
      baselineVersionId: baseline.id,
      candidateVersionId: candidate.id,
      suiteId: input.suiteId,
      status: 'draft',
      sharedConfig,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: cleanText(input.createdBy, '团队成员', 40),
      deletedAt: null,
    };
    this.db.prepare(`
      INSERT INTO evaluations
        (id, project_id, name, prompt_id, baseline_version_id, candidate_version_id,
         suite_id, status, shared_config_json, result_json, error, created_at, updated_at,
         created_by, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)
    `).run(
      evaluation.id,
      evaluation.projectId,
      evaluation.name,
      evaluation.promptId,
      evaluation.baselineVersionId,
      evaluation.candidateVersionId,
      evaluation.suiteId,
      evaluation.status,
      JSON.stringify(evaluation.sharedConfig),
      timestamp,
      timestamp,
      evaluation.createdBy,
    );
    this.addAudit(evaluation.projectId, 'evaluation', evaluation.id, 'create', evaluation.createdBy, `创建对比评测：${evaluation.name}`);
    return evaluation;
  }

  listEvaluations(includeDeleted = false, projectId = DEFAULT_PROJECT_ID) {
    const rows = this.db.prepare(`
      SELECT * FROM evaluations
      WHERE project_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY created_at DESC
    `).all(projectId) as Row[];
    return rows.map((row) => this.rowToEvaluation(row));
  }

  getEvaluation(id: string, includeDeleted = false) {
    const row = this.db.prepare(`
      SELECT * FROM evaluations WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(id) as Row | undefined;
    if (!row) throw new Error('评测不存在');
    return this.rowToEvaluation(row);
  }

  updateEvaluationState(
    id: string,
    status: StudioEvaluation['status'],
    result: StudioEvaluationResult | null,
    error: string | null,
  ) {
    this.db.prepare(`
      UPDATE evaluations SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(status, result ? JSON.stringify(result) : null, error, now(), id);
    return this.getEvaluation(id);
  }

  archiveEvaluation(id: string, actor = '团队成员') {
    const evaluation = this.getEvaluation(id);
    if (evaluation.status === 'running') throw new Error('运行中的评测不能归档');
    this.db.prepare(`UPDATE evaluations SET status = 'archived', updated_at = ? WHERE id = ?`).run(now(), id);
    this.addAudit(evaluation.projectId, 'evaluation', id, 'archive', actor, `归档评测：${evaluation.name}`);
    return this.getEvaluation(id);
  }

  createModelComparison(input: StudioCreateModelComparisonInput) {
    const prompt = this.getResource(input.promptId);
    const projectId = input.projectId ?? prompt.projectId;
    if (projectId !== prompt.projectId || prompt.kind !== 'prompt') throw new Error('请选择当前项目的 Prompt');
    const version = this.getPromptVersion(input.versionId);
    if (version.promptId !== prompt.id) throw new Error('被测版本不属于所选 Prompt');
    const targetIds = [...new Set(input.targetModelConfigResourceIds)].filter(Boolean);
    if (targetIds.length < 2) throw new Error('模型横评至少选择两个被测模型');
    if (targetIds.length > 8) throw new Error('单次模型横评最多选择八个模型');
    const judge = this.getProjectResource(input.judgeModelConfigResourceId, projectId);
    if (judge.kind !== 'model-config') throw new Error('裁判模型必须是模型配置资源');
    const targets = targetIds.map((id) => this.getProjectResource(id, projectId));
    if (targets.some((item) => item.kind !== 'model-config' || item.status !== 'active')) {
      throw new Error('被测模型必须是可用的模型配置资源');
    }
    const sharedBase = this.buildSharedConfig({
      projectId,
      promptId: prompt.id,
      baselineVersionId: version.id,
      candidateVersionId: version.id,
      suiteId: input.suiteId,
      characterResourceIds: input.characterResourceIds,
      worldResourceId: input.worldResourceId,
      modelConfigResourceId: judge.id,
      schedulerPolicyResourceId: input.schedulerPolicyResourceId,
      memoryPolicyResourceId: input.memoryPolicyResourceId,
      scorecardResourceId: input.scorecardResourceId,
    }, projectId);
    if (!sharedBase.cases.length) throw new Error('测试集没有案例');
    const sharedConfig: StudioModelComparisonSharedConfig = {
      ...sharedBase,
      judgeModelConfigResourceId: judge.id,
      judgeModelConfig: modelConfigSnapshot(judge.data as unknown as StudioModelConfigData),
      targetModels: targets.map((item) => ({
        resourceId: item.id,
        name: item.name,
        config: modelConfigSnapshot(item.data as unknown as StudioModelConfigData),
      })),
    };
    const timestamp = now();
    const comparison: StudioModelComparison = {
      id: `model-comparison-${randomUUID()}`,
      projectId,
      name: cleanText(input.name, `${prompt.name} v${version.number} 模型横评`, 120),
      promptId: prompt.id,
      versionId: version.id,
      suiteId: input.suiteId,
      status: 'draft',
      sharedConfig,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: cleanText(input.createdBy, '团队成员', 40),
    };
    this.db.prepare(`
      INSERT INTO model_comparisons
        (id, project_id, name, prompt_id, version_id, suite_id, status, shared_config_json,
         result_json, error, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      comparison.id, comparison.projectId, comparison.name, comparison.promptId,
      comparison.versionId, comparison.suiteId, comparison.status, JSON.stringify(comparison.sharedConfig),
      timestamp, timestamp, comparison.createdBy,
    );
    this.addAudit(projectId, 'model_comparison', comparison.id, 'create', comparison.createdBy, `创建模型横评：${comparison.name}`);
    return comparison;
  }

  listModelComparisons(projectId = DEFAULT_PROJECT_ID) {
    const rows = this.db.prepare(`SELECT * FROM model_comparisons WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as Row[];
    return rows.map((row) => this.rowToModelComparison(row));
  }

  getModelComparison(id: string) {
    const row = this.db.prepare('SELECT * FROM model_comparisons WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('模型横评不存在');
    return this.rowToModelComparison(row);
  }

  updateModelComparisonState(
    id: string,
    status: StudioModelComparison['status'],
    result: StudioModelComparisonResult | null,
    error: string | null,
  ) {
    this.db.prepare(`UPDATE model_comparisons SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(status, result ? JSON.stringify(result) : null, error, now(), id);
    return this.getModelComparison(id);
  }

  archiveModelComparison(id: string, actor = '团队成员') {
    const comparison = this.getModelComparison(id);
    if (comparison.status === 'running') throw new Error('运行中的模型横评不能归档');
    this.db.prepare(`UPDATE model_comparisons SET status = 'archived', updated_at = ? WHERE id = ?`).run(now(), id);
    this.addAudit(comparison.projectId, 'model_comparison', id, 'archive', actor, `归档模型横评：${comparison.name}`);
    return this.getModelComparison(id);
  }

  listReviews(projectId = DEFAULT_PROJECT_ID) {
    const rows = this.db.prepare(`
      SELECT * FROM review_requests WHERE project_id = ? ORDER BY updated_at DESC
    `).all(projectId) as Row[];
    if (!rows.length) return [];
    const reviewIds = rows.map((row) => String(row.id));
    const placeholders = reviewIds.map(() => '?').join(', ');
    const comments = this.db.prepare(`
      SELECT * FROM review_comments WHERE review_id IN (${placeholders}) ORDER BY created_at ASC
    `).all(...reviewIds) as Row[];
    const cases = this.db.prepare(`
      SELECT * FROM review_cases WHERE review_id IN (${placeholders}) ORDER BY case_index ASC
    `).all(...reviewIds) as Row[];
    const assessments = this.db.prepare(`
      SELECT * FROM review_case_assessments WHERE review_id IN (${placeholders}) ORDER BY created_at ASC
    `).all(...reviewIds) as Row[];
    const byReview = new Map<string, StudioReviewComment[]>();
    for (const comment of comments) {
      const value = this.rowToReviewComment(comment);
      const collection = byReview.get(value.reviewId) ?? [];
      collection.push(value);
      byReview.set(value.reviewId, collection);
    }
    const assessmentsByCase = new Map<string, StudioReviewCaseAssessment[]>();
    for (const assessment of assessments) {
      const value = this.rowToReviewCaseAssessment(assessment);
      const collection = assessmentsByCase.get(`${value.reviewId}:${value.caseId}`) ?? [];
      collection.push(value);
      assessmentsByCase.set(`${value.reviewId}:${value.caseId}`, collection);
    }
    const casesByReview = new Map<string, StudioReviewCase[]>();
    for (const reviewCase of cases) {
      const value = this.rowToReviewCase(reviewCase, assessmentsByCase.get(`${reviewCase.review_id}:${reviewCase.case_id}`) ?? []);
      const collection = casesByReview.get(value.reviewId) ?? [];
      collection.push(value);
      casesByReview.set(value.reviewId, collection);
    }
    return rows.map((row) => this.rowToReview(
      row,
      byReview.get(String(row.id)) ?? [],
      casesByReview.get(String(row.id)) ?? [],
    ));
  }

  createReview(input: StudioCreateReviewInput, actor: StudioMember) {
    const evaluationId = typeof input.evaluationId === 'string' && input.evaluationId.trim()
      ? input.evaluationId.trim()
      : null;
    const evaluation = evaluationId ? this.getEvaluation(evaluationId) : null;
    if (evaluation && evaluation.projectId !== input.projectId) throw new Error('评测证据不属于当前项目');
    if (evaluation && (evaluation.status !== 'completed' || !evaluation.result)) {
      throw new Error('只有已完成且保留结果的评测才能发起证据评审');
    }
    const promptId = evaluation?.promptId ?? input.promptId;
    const versionId = evaluation?.candidateVersionId ?? input.versionId;
    if (!promptId || !versionId) throw new Error('发起评审需要选择已完成评测，或提供 Prompt 与版本');
    if (evaluation && input.promptId && input.promptId !== evaluation.promptId) {
      throw new Error('评审 Prompt 必须与评测证据一致');
    }
    if (evaluation && input.versionId && input.versionId !== evaluation.candidateVersionId) {
      throw new Error('评审版本必须与评测证据中的新版一致');
    }
    const prompt = this.getResource(promptId);
    const version = this.getPromptVersion(versionId);
    if (prompt.projectId !== input.projectId || version.promptId !== prompt.id) throw new Error('评审的 Prompt 版本与项目不匹配');
    const reviewerIds = Array.isArray(input.reviewerIds)
      ? [...new Set(input.reviewerIds.filter((id): id is string => typeof id === 'string'))].filter((id) => id !== actor.id)
      : [];
    if (!reviewerIds.length) throw new Error('请至少指定一位评审人');
    for (const reviewerId of reviewerIds) this.getProjectRole(input.projectId, reviewerId);
    const timestamp = now();
    const reviewId = `review-${randomUUID()}`;
    const caseItems: StudioReviewCase[] = evaluation
      ? evaluation.sharedConfig.cases.map((testCase, caseIndex) => {
        const baseline = evaluation.result?.baseline.cases.find((item) => item.caseId === testCase.id) ?? null;
        const candidate = evaluation.result?.candidate.cases.find((item) => item.caseId === testCase.id) ?? null;
        return {
          id: `review-case-${randomUUID()}`,
          reviewId,
          caseId: testCase.id,
          caseIndex,
          title: testCase.title,
          category: testCase.category,
          input: testCase.input,
          expected: testCase.expected,
          baseline,
          candidate,
          assessments: [],
        };
      })
      : [];
    const review: StudioReviewRequest = {
      id: reviewId,
      projectId: input.projectId,
      promptId: prompt.id,
      versionId: version.id,
      evaluationId,
      title: cleanText(input.title, `评审 v${version.number}：${version.title}`, 120),
      description: cleanText(input.description, '', 1000),
      status: 'open',
      requestedById: actor.id,
      requestedByName: actor.name,
      reviewerIds,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
      caseItems,
    };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO review_requests
          (id, project_id, prompt_id, version_id, evaluation_id, title, description, status,
           requested_by_id, requested_by_name, reviewer_ids_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        review.id, review.projectId, review.promptId, review.versionId, review.evaluationId,
        review.title, review.description, review.status, review.requestedById, review.requestedByName,
        JSON.stringify(review.reviewerIds), timestamp, timestamp,
      );
      for (const item of caseItems) {
        this.db.prepare(`
          INSERT INTO review_cases
            (id, review_id, case_id, case_index, title, category, input, expected, baseline_json, candidate_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, item.reviewId, item.caseId, item.caseIndex, item.title, item.category,
          item.input, item.expected, item.baseline ? JSON.stringify(item.baseline) : null,
          item.candidate ? JSON.stringify(item.candidate) : null, timestamp,
        );
      }
      this.addAudit(review.projectId, 'review', review.id, 'create', actor.name, evaluation
        ? `发起逐案例证据评审：${review.title}`
        : `发起版本评审：${review.title}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return review;
  }

  addReviewComment(reviewId: string, content: string, decision: StudioReviewComment['decision'], actor: StudioMember) {
    const review = this.db.prepare('SELECT * FROM review_requests WHERE id = ?').get(reviewId) as Row | undefined;
    if (!review) throw new Error('评审不存在');
    const request = this.rowToReview(review);
    if (request.status === 'closed') throw new Error('已关闭的评审不能继续评论');
    const caseCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM review_cases WHERE review_id = ?').get(reviewId) as Row).count);
    if (caseCount > 0 && decision !== 'comment') {
      throw new Error('该评审已绑定逐案例证据，请在每条案例中提交评分和结论');
    }
    const text = cleanText(content, '', 2000);
    if (!text) throw new Error('请填写评审意见');
    if (decision !== 'comment' && !request.reviewerIds.includes(actor.id)) throw new Error('只有指定评审人可以提交结论');
    const comment: StudioReviewComment = {
      id: `review-comment-${randomUUID()}`,
      reviewId,
      authorId: actor.id,
      authorName: actor.name,
      content: text,
      decision,
      createdAt: now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO review_comments (id, review_id, author_id, author_name, content, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(comment.id, comment.reviewId, comment.authorId, comment.authorName, comment.content, comment.decision, comment.createdAt);
      const status = decision === 'approve' ? 'approved' : decision === 'changes_requested' ? 'changes_requested' : request.status;
      this.db.prepare('UPDATE review_requests SET status = ?, updated_at = ? WHERE id = ?').run(status, comment.createdAt, reviewId);
      this.addAudit(request.projectId, 'review', reviewId, decision, actor.name, `提交评审意见：${decision}`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listReviews(request.projectId).find((item) => item.id === reviewId)!;
  }

  private calculateReviewStatus(reviewId: string, reviewerIds: string[], caseCount: number): StudioReviewRequest['status'] {
    if (!caseCount || !reviewerIds.length) return 'open';
    const latest = this.db.prepare(`
      SELECT a.*
      FROM review_case_assessments a
      JOIN (
        SELECT case_id, reviewer_id, MAX(revision) AS revision
        FROM review_case_assessments
        WHERE review_id = ?
        GROUP BY case_id, reviewer_id
      ) current
        ON current.case_id = a.case_id
       AND current.reviewer_id = a.reviewer_id
       AND current.revision = a.revision
      WHERE a.review_id = ?
    `).all(reviewId, reviewId) as Row[];
    if (latest.some((row) => row.decision === 'changes_requested')) return 'changes_requested';
    const expectedCount = caseCount * reviewerIds.length;
    if (latest.length === expectedCount && latest.every((row) => row.decision === 'approve')) return 'approved';
    return 'open';
  }

  addReviewCaseAssessment(
    reviewId: string,
    caseId: string,
    input: StudioCreateReviewCaseAssessmentInput,
    actor: StudioMember,
  ) {
    const reviewRow = this.db.prepare('SELECT * FROM review_requests WHERE id = ?').get(reviewId) as Row | undefined;
    if (!reviewRow) throw new Error('评审不存在');
    const review = this.rowToReview(reviewRow);
    if (review.status === 'closed') throw new Error('已关闭的评审不能继续复核');
    if (!review.reviewerIds.includes(actor.id)) throw new Error('只有指定评审人可以提交案例复核');
    const reviewCase = this.db.prepare('SELECT * FROM review_cases WHERE review_id = ? AND case_id = ?').get(reviewId, caseId) as Row | undefined;
    if (!reviewCase) throw new Error('评审案例不存在');
    const decision = input?.decision;
    if (decision !== 'comment' && decision !== 'approve' && decision !== 'changes_requested') {
      throw new Error('案例评审结论无效');
    }
    const { scores, overallScore } = normalizeManualScores(input?.scores);
    const comment = cleanText(input?.comment, '', 3000);
    if (!comment) throw new Error('请填写本条案例的评审依据');
    const revisionRow = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
      FROM review_case_assessments
      WHERE review_id = ? AND case_id = ? AND reviewer_id = ?
    `).get(reviewId, caseId, actor.id) as Row;
    const assessment: StudioReviewCaseAssessment = {
      id: `review-case-assessment-${randomUUID()}`,
      reviewId,
      caseId,
      reviewerId: actor.id,
      reviewerName: actor.name,
      revision: Number(revisionRow.next_revision),
      scores,
      overallScore,
      decision,
      comment,
      createdAt: now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO review_case_assessments
          (id, review_id, case_id, reviewer_id, reviewer_name, revision, scores_json,
           overall_score, decision, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assessment.id, assessment.reviewId, assessment.caseId, assessment.reviewerId,
        assessment.reviewerName, assessment.revision, JSON.stringify(assessment.scores),
        assessment.overallScore, assessment.decision, assessment.comment, assessment.createdAt,
      );
      const caseCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM review_cases WHERE review_id = ?').get(reviewId) as Row).count);
      const nextStatus = this.calculateReviewStatus(reviewId, review.reviewerIds, caseCount);
      this.db.prepare('UPDATE review_requests SET status = ?, updated_at = ? WHERE id = ?')
        .run(nextStatus, assessment.createdAt, reviewId);
      this.addAudit(review.projectId, 'review_case', `${reviewId}:${caseId}`, 'assess', actor.name,
        `提交案例复核：${assessment.decision}（${assessment.overallScore}分）`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listReviews(review.projectId).find((item) => item.id === reviewId)!;
  }

  listManualAssessments(projectId = DEFAULT_PROJECT_ID, versionId?: string) {
    const rows = this.db.prepare(`
      SELECT * FROM manual_assessments
      WHERE project_id = ? ${versionId ? 'AND version_id = ?' : ''}
      ORDER BY created_at DESC
      LIMIT 500
    `).all(...(versionId ? [projectId, versionId] : [projectId])) as Row[];
    return rows.map((row) => this.rowToManualAssessment(row));
  }

  createManualAssessment(input: StudioCreateManualAssessmentInput, actor: StudioMember) {
    const prompt = this.getResource(input.promptId);
    const version = this.getPromptVersion(input.versionId);
    if (prompt.projectId !== input.projectId || version.promptId !== prompt.id) {
      throw new Error('人工评测的 Prompt 版本与当前项目不匹配');
    }
    const dimensions = defaultScorecard().dimensions;
    const scores = {} as StudioManualScores;
    for (const dimension of dimensions) {
      const value = Number(input.scores?.[dimension.key]);
      if (!Number.isFinite(value) || value < 1 || value > 5) {
        throw new Error(`请为“${dimension.label}”评分 1 到 5 分`);
      }
      scores[dimension.key] = Math.round(value * 10) / 10;
    }
    const comment = cleanText(input.comment, '', 3000);
    if (!comment) throw new Error('请填写人工评测结论与依据');
    const scoreTotal = dimensions.reduce((total, dimension) => total + scores[dimension.key] / 5 * dimension.weight, 0);
    const revisionRow = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
      FROM manual_assessments WHERE version_id = ? AND member_id = ?
    `).get(version.id, actor.id) as Row;
    const assessment: StudioManualAssessment = {
      id: `manual-assessment-${randomUUID()}`,
      projectId: input.projectId,
      promptId: prompt.id,
      versionId: version.id,
      memberId: actor.id,
      memberName: actor.name,
      revision: Number(revisionRow.next_revision),
      scores,
      overallScore: Math.round(scoreTotal * 10) / 10,
      scenario: cleanText(input.scenario, '', 500),
      turns: Math.max(0, Math.min(9999, Math.floor(Number(input.turns) || 0))),
      comment,
      createdAt: now(),
    };
    this.db.prepare(`
      INSERT INTO manual_assessments
        (id, project_id, prompt_id, version_id, member_id, member_name, revision, scores_json,
         overall_score, scenario, turns, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assessment.id, assessment.projectId, assessment.promptId, assessment.versionId,
      assessment.memberId, assessment.memberName, assessment.revision, JSON.stringify(assessment.scores),
      assessment.overallScore, assessment.scenario, assessment.turns, assessment.comment, assessment.createdAt,
    );
    this.addAudit(assessment.projectId, 'manual_assessment', assessment.id, 'submit', actor.name, `提交 v${version.number} 人工评测（第 ${assessment.revision} 次）`);
    return assessment;
  }

  getBootstrap(projectId = DEFAULT_PROJECT_ID, memberId = DEFAULT_MEMBER_ID): StudioBootstrap {
    const project = this.getProject(projectId);
    const currentMember = this.getMember(memberId);
    this.getProjectRole(projectId, currentMember.id);
    const resources = this.listResources({ projectId, includeDeleted: true }).map(sanitizeResourceForClient);
    const promptVersions = this.listPromptVersions(undefined, projectId);
    const evaluations = this.listEvaluations(true, projectId);
    const modelComparisons = this.listModelComparisons(projectId);
    const auditRows = this.db.prepare(`
      SELECT * FROM audit_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 80
    `).all(projectId) as Row[];
    return {
      organization: this.getOrganization(),
      projects: this.listProjects(),
      project,
      currentMember,
      projectMembers: this.listProjectMembers(projectId),
      organizationMembers: this.listMembers(),
      resources,
      promptVersions,
      evaluations,
      modelComparisons,
      reviews: this.listReviews(projectId),
      manualAssessments: this.listManualAssessments(projectId),
      auditLogs: auditRows.map((row) => this.rowToAudit(row)),
      counts: {
        activeResources: resources.filter((item) => !item.deletedAt).length,
        promptVersions: promptVersions.length,
        completedEvaluations: evaluations.filter((item) => item.status === 'completed' && !item.deletedAt).length,
        recycledResources: resources.filter((item) => Boolean(item.deletedAt)).length,
      },
    };
  }
}

let singleton: StudioRepository | null = null;

export function getStudioRepository() {
  if (!singleton) singleton = new StudioRepository();
  return singleton;
}

export function resetStudioRepositoryForTests() {
  singleton = null;
}
