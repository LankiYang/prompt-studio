import { Archive, Check, Code2, Edit3, FilePlus2, GitBranch, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StudioBootstrap, StudioPromptVersion, StudioResource } from '../../../shared/studio-types';
import type { BuilderVariableConfig, PromptBuilderItem } from '../../../shared/types';
import { studioApi } from '../../studio/api';
import ManualAssessmentPanel from './ManualAssessmentPanel';
import StudioModal from './StudioModal';

const emptyVariables: BuilderVariableConfig = {
  taskDescriptions: {
    chat: '扮演{{roleName}}，基于当前上下文生成一条回复。',
    mention: '回应明确提到{{roleName}}的消息。',
    proactive: '',
  },
  outputFormat: '只输出一条角色回复。',
  dialogueRules: '保持角色一致，不代替玩家或其他角色发言。',
};

function date(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function PromptMetaForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: StudioResource;
  onSave: (value: { name: string; description: string; owner: string; tags: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [owner, setOwner] = useState(initial?.owner ?? 'Prompt 团队');
  const [tags, setTags] = useState(initial?.tags.join('，') ?? '多人对话');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="studio-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return setError('请填写 Prompt 名称');
        setSaving(true);
        try {
          await onSave({
            name: name.trim(),
            description,
            owner,
            tags: tags.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setSaving(false);
        }
      }}
    >
      <label className="studio-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="studio-field"><span>说明</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="studio-form-grid">
        <label className="studio-field"><span>负责人</span><input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
        <label className="studio-field"><span>标签</span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      </div>
      {error && <div className="studio-error">{error}</div>}
      <div className="studio-form-actions">
        <button type="button" className="studio-button secondary" onClick={onCancel}>取消</button>
        <button className="studio-button primary" disabled={saving}>{saving ? '保存中...' : initial ? '保存信息' : '创建 Prompt'}</button>
      </div>
    </form>
  );
}

function VersionEditor({
  prompt,
  base,
  onSave,
  onCancel,
}: {
  prompt: StudioResource;
  base?: StudioPromptVersion;
  onSave: (value: { title: string; summary: string; snapshot: PromptBuilderItem }) => Promise<void>;
  onCancel: () => void;
}) {
  const source = base?.snapshot;
  const [title, setTitle] = useState(base ? `基于 v${base.number} 的优化` : '初始版本');
  const [summary, setSummary] = useState('');
  const [template, setTemplate] = useState(source?.template ?? '');
  const [variables, setVariables] = useState<BuilderVariableConfig>(
    source?.variableConfig ?? emptyVariables,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const variableNames = useMemo(
    () => [...template.matchAll(/{{\s*([^}]+)\s*}}/g)].map((match) => match[1].trim()),
    [template],
  );
  return (
    <form
      className="studio-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!template.trim()) return setError('Prompt 模板不能为空');
        setSaving(true);
        try {
          await onSave({
            title,
            summary,
            snapshot: {
              ...(source ?? { id: 'studio-evaluation', label: prompt.name }),
              id: 'studio-evaluation',
              label: prompt.name,
              template,
              variableConfig: variables,
            },
          });
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setSaving(false);
        }
      }}
    >
      <div className="studio-form-grid">
        <label className="studio-field"><span>版本标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="studio-field"><span>基线</span><input value={base ? `v${base.number} · ${base.title}` : '空白版本'} disabled /></label>
      </div>
      <label className="studio-field"><span>改动说明与假设</span><textarea rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="改了什么，预计改善哪个指标，有什么风险。" /></label>
      <label className="studio-field">
        <span>Prompt 模板</span>
        <textarea className="studio-code-editor" rows={18} value={template} onChange={(event) => setTemplate(event.target.value)} spellCheck={false} />
        <small>检测到 {variableNames.length} 个变量：{variableNames.join('、') || '无'}</small>
      </label>
      <div className="studio-editor-columns">
        <label className="studio-field"><span>普通消息任务</span><textarea rows={5} value={variables.taskDescriptions.chat} onChange={(event) => setVariables((current) => ({ ...current, taskDescriptions: { ...current.taskDescriptions, chat: event.target.value } }))} /></label>
        <label className="studio-field"><span>@ 唤起任务</span><textarea rows={5} value={variables.taskDescriptions.mention} onChange={(event) => setVariables((current) => ({ ...current, taskDescriptions: { ...current.taskDescriptions, mention: event.target.value } }))} /></label>
        <label className="studio-field"><span>输出格式</span><textarea rows={5} value={variables.outputFormat} onChange={(event) => setVariables((current) => ({ ...current, outputFormat: event.target.value }))} /></label>
      </div>
      <label className="studio-field"><span>对话规则</span><textarea rows={7} value={variables.dialogueRules} onChange={(event) => setVariables((current) => ({ ...current, dialogueRules: event.target.value }))} /></label>
      {error && <div className="studio-error">{error}</div>}
      <div className="studio-form-actions sticky">
        <button type="button" className="studio-button secondary" onClick={onCancel}>取消</button>
        <button className="studio-button primary" disabled={saving}><FilePlus2 size={15} />{saving ? '保存中...' : '保存为不可变版本'}</button>
      </div>
    </form>
  );
}

export default function PromptLibrary({
  data,
  reload,
  notify,
}: {
  data: StudioBootstrap;
  reload: () => Promise<void>;
  notify: (message: string, type?: 'success' | 'error') => void;
}) {
  const prompts = data.resources.filter((item) => item.kind === 'prompt' && !item.deletedAt);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(prompts[0]?.id ?? '');
  const [versionId, setVersionId] = useState('');
  const [modal, setModal] = useState<'create' | 'edit' | 'version' | null>(null);
  const currentRole = data.projectMembers.find((membership) => membership.memberId === data.currentMember.id)?.role ?? 'viewer';
  const canEdit = currentRole === 'owner' || currentRole === 'editor';
  const canPublish = currentRole === 'owner';
  const selected = prompts.find((item) => item.id === selectedId) ?? prompts[0];
  const versions = data.promptVersions
    .filter((item) => item.promptId === selected?.id)
    .sort((left, right) => right.number - left.number);
  const activeVersion = versions.find((item) => item.id === versionId) ?? versions[0];
  const visible = prompts.filter((item) =>
    `${item.name} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()),
  );

  useEffect(() => {
    if (!selectedId && prompts[0]) setSelectedId(prompts[0].id);
  }, [prompts, selectedId]);

  return (
    <div className="studio-library-layout">
      <aside className="studio-library-list">
        <div className="studio-list-toolbar">
          <div className="studio-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Prompt" /></div>
          {canEdit && <button className="studio-icon-button primary" aria-label="新建 Prompt" title="新建 Prompt" onClick={() => setModal('create')}><Plus size={17} /></button>}
        </div>
        <div className="studio-list-items">
          {visible.map((prompt) => {
            const promptVersions = data.promptVersions.filter((item) => item.promptId === prompt.id);
            return (
              <button key={prompt.id} className={selected?.id === prompt.id ? 'active' : ''} onClick={() => { setSelectedId(prompt.id); setVersionId(''); }}>
                <span className="studio-resource-icon prompt"><Code2 size={16} /></span>
                <span><strong>{prompt.name}</strong><small>{promptVersions.length} 个版本 · {prompt.owner}</small></span>
              </button>
            );
          })}
          {!visible.length && <div className="studio-empty compact">没有匹配的 Prompt</div>}
        </div>
      </aside>

      <main className="studio-library-detail">
        {selected ? (
          <>
            <header className="studio-detail-header">
              <div>
                <div className="studio-eyebrow">PROMPT ASSET</div>
                <h2>{selected.name}</h2>
                <p>{selected.description || '暂无说明'}</p>
                <div className="studio-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              </div>
              {canEdit && <div className="studio-header-actions">
                <button className="studio-button secondary" onClick={() => setModal('edit')}><Edit3 size={15} />编辑信息</button>
                <button className="studio-button primary" onClick={() => setModal('version')}><GitBranch size={15} />新建版本</button>
                <button
                  className="studio-icon-button danger"
                  aria-label="移入回收站"
                  title="移入回收站"
                  onClick={async () => {
                    if (!window.confirm(`将“${selected.name}”移入回收站？历史版本和评测证据会保留。`)) return;
                    await studioApi.deleteResource(selected.id);
                    notify('Prompt 已移入回收站');
                    setSelectedId('');
                    await reload();
                  }}
                ><Trash2 size={16} /></button>
              </div>}
            </header>

            <div className="studio-version-layout">
              <section className="studio-version-timeline">
                <header><h3>版本历史</h3><span>{versions.length}</span></header>
                {versions.map((version) => (
                  <button key={version.id} className={activeVersion?.id === version.id ? 'active' : ''} onClick={() => setVersionId(version.id)}>
                    <span className={`studio-version-dot ${version.status}`} />
                    <span>
                      <strong>v{version.number} · {version.title}</strong>
                      <small>{date(version.createdAt)} · {version.createdBy}</small>
                    </span>
                    <em>{version.status === 'published' ? '已发布' : version.status === 'draft' ? '草稿' : '已归档'}</em>
                  </button>
                ))}
              </section>

              {activeVersion && (
                <section className="studio-version-inspector">
                  <header>
                    <div>
                      <span className={`studio-status ${activeVersion.status}`}>{activeVersion.status === 'published' ? '当前发布' : activeVersion.status === 'draft' ? '草稿版本' : '历史版本'}</span>
                      <h3>v{activeVersion.number} · {activeVersion.title}</h3>
                      <p>{activeVersion.summary}</p>
                    </div>
                    {canPublish && activeVersion.status !== 'published' && (
                      <button
                        className="studio-button secondary"
                        onClick={async () => {
                          await studioApi.publishPromptVersion(selected.id, activeVersion.id);
                          notify(`v${activeVersion.number} 已发布，可随时切回旧版`);
                          await reload();
                        }}
                      ><Check size={15} />发布此版本</button>
                    )}
                  </header>
                  <div className="studio-code-meta">
                    <span><Code2 size={14} />{activeVersion.snapshot.template.length} 字符</span>
                    <span><Archive size={14} />快照不可修改</span>
                  </div>
                  <pre className="studio-prompt-preview">{activeVersion.snapshot.template || '（空模板）'}</pre>
                  <ManualAssessmentPanel data={data} prompt={selected} version={activeVersion} reload={reload} notify={notify} />
                </section>
              )}
            </div>
          </>
        ) : (
          <div className="studio-empty"><Code2 size={22} /><strong>还没有 Prompt</strong>{canEdit && <button className="studio-button primary" onClick={() => setModal('create')}>新建 Prompt</button>}</div>
        )}
      </main>

      {modal === 'create' && (
        <StudioModal title="新建 Prompt" subtitle="创建资产后会自动产生一个初始草稿版本。" onClose={() => setModal(null)}>
          <PromptMetaForm
            onCancel={() => setModal(null)}
            onSave={async (value) => {
              const created = await studioApi.createResource({ kind: 'prompt', ...value, data: {} });
              setModal(null);
              setSelectedId(created.id);
              notify('Prompt 已创建');
              await reload();
            }}
          />
        </StudioModal>
      )}
      {modal === 'edit' && selected && (
        <StudioModal title="编辑 Prompt 信息" subtitle="这里不会修改任何版本正文。" onClose={() => setModal(null)}>
          <PromptMetaForm
            initial={selected}
            onCancel={() => setModal(null)}
            onSave={async (value) => {
              await studioApi.updateResource(selected.id, value as Partial<StudioResource>);
              setModal(null);
              notify('Prompt 信息已更新');
              await reload();
            }}
          />
        </StudioModal>
      )}
      {modal === 'version' && selected && (
        <StudioModal title="新建 Prompt 版本" subtitle="保存后正文成为不可变快照，后续修改请继续创建新版本。" wide onClose={() => setModal(null)}>
          <VersionEditor
            prompt={selected}
            base={activeVersion}
            onCancel={() => setModal(null)}
            onSave={async (value) => {
              const created = await studioApi.createPromptVersion(selected.id, value);
              setModal(null);
              setVersionId(created.id);
              notify(`v${created.number} 已创建`);
              await reload();
            }}
          />
        </StudioModal>
      )}
    </div>
  );
}
