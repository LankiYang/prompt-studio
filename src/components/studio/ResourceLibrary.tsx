import { Archive, Bot, Boxes, Brain, Database, Edit3, Gauge, Plus, Search, Trash2, UsersRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StudioBootstrap, StudioCreateResourceInput, StudioResource, StudioResourceKind } from '../../../shared/studio-types';
import { studioApi } from '../../studio/api';
import ResourceEditor from './ResourceEditor';
import StudioModal from './StudioModal';

const groups: Array<{ kind: StudioResourceKind; label: string; icon: typeof Bot }> = [
  { kind: 'character', label: '角色', icon: UsersRound },
  { kind: 'world', label: '世界观', icon: Boxes },
  { kind: 'test-suite', label: '测试集', icon: Database },
  { kind: 'scorecard', label: '评分卡', icon: Gauge },
  { kind: 'model-config', label: '模型卡', icon: Bot },
  { kind: 'scheduler-policy', label: '调度策略', icon: Archive },
  { kind: 'memory-policy', label: '记忆策略', icon: Brain },
];

const groupDescriptions: Record<StudioResourceKind, string> = {
  prompt: 'Prompt 正文请在 Prompt 版本中维护。',
  character: '定义参与群聊的角色身份、人设和行为边界。',
  world: '固定故事背景、地点和不可违背的世界规则。',
  'test-suite': '保存可重复运行的玩家输入、上下文和预期行为。',
  scorecard: '统一自动评分和人工复核使用的维度与权重。',
  'model-config': '集中管理供应商、协议、模型参数和加密密钥。',
  'scheduler-policy': '控制历史窗口、回复人数以及串行或并行方式。',
  'memory-policy': '定义有无记忆、检索数量和记忆更新策略。',
};

function dataSummary(resource: StudioResource) {
  if (resource.kind === 'character') return String(resource.data.persona || '未填写角色人设');
  if (resource.kind === 'world') return String(resource.data.content || '未填写世界观');
  if (resource.kind === 'test-suite') return `${Array.isArray(resource.data.cases) ? resource.data.cases.length : 0} 条测试案例`;
  if (resource.kind === 'scorecard') return `${Array.isArray(resource.data.dimensions) ? resource.data.dimensions.length : 0} 个评分维度 · 通过分 ${resource.data.passScore ?? '-'}`;
  if (resource.kind === 'model-config') {
    const credential = resource.data.credentialSource === 'stored'
      ? resource.data.apiKeyConfigured ? '加密密钥已配置' : '加密密钥未配置'
      : resource.data.apiKeyConfigured ? '环境变量已配置' : '环境变量未配置';
    return `${resource.data.provider ?? ''} · ${resource.data.model ?? ''} · ${credential} · temperature ${resource.data.temperature ?? '-'}`;
  }
  if (resource.kind === 'scheduler-policy') return `最近 ${resource.data.historyRounds ?? '-'} 轮 · 最多 ${resource.data.maxSpeakers ?? '-'} 个角色 · ${resource.data.executionMode === 'serial' ? '串行' : '并行'}`;
  return `${resource.data.enabled ? '已启用记忆' : '无记忆基线'} · Top ${resource.data.retrievalLimit ?? '-'}`;
}

function ConfigSnapshot({ resource }: { resource: StudioResource }) {
  if (resource.kind === 'character') {
    return <div className="studio-readable-text"><h3>{String(resource.data.name || resource.name)}</h3><p>{String(resource.data.persona || '未填写')}</p></div>;
  }
  if (resource.kind === 'world') {
    return <div className="studio-readable-text"><p>{String(resource.data.content || '未填写')}</p></div>;
  }
  if (resource.kind === 'test-suite' && Array.isArray(resource.data.cases)) {
    return <div className="studio-snapshot-list">{resource.data.cases.map((item, index) => {
      const itemData = item as Record<string, unknown>;
      return <div key={String(itemData.id ?? index)}><strong>{index + 1}. {String(itemData.title ?? '未命名案例')}</strong><p>{String(itemData.input ?? '')}</p><small>期望：{String(itemData.expected ?? '')}</small></div>;
    })}</div>;
  }
  if (resource.kind === 'scorecard' && Array.isArray(resource.data.dimensions)) {
    return <div className="studio-snapshot-list two-columns">{resource.data.dimensions.map((item, index) => {
      const itemData = item as Record<string, unknown>;
      return <div key={String(itemData.key ?? index)}><strong>{String(itemData.label ?? itemData.key)} <em>{String(itemData.weight)} 分</em></strong><p>{String(itemData.description ?? '未填写评分锚点')}</p></div>;
    })}</div>;
  }
  return <pre className="studio-config-json">{JSON.stringify(resource.data, null, 2)}</pre>;
}

export default function ResourceLibrary({
  data,
  reload,
  notify,
}: {
  data: StudioBootstrap;
  reload: () => Promise<void>;
  notify: (message: string, type?: 'success' | 'error') => void;
}) {
  const [kind, setKind] = useState<StudioResourceKind>('character');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const currentRole = data.projectMembers.find((membership) => membership.memberId === data.currentMember.id)?.role ?? 'viewer';
  const canEdit = currentRole === 'owner' || currentRole === 'editor';
  const requiredKinds: StudioResourceKind[] = ['character', 'world', 'test-suite', 'scorecard', 'model-config', 'scheduler-policy', 'memory-policy'];
  const readyCount = requiredKinds.filter((requiredKind) => data.resources.some((item) => item.kind === requiredKind && !item.deletedAt && item.status === 'active')).length;
  const resources = useMemo(() => data.resources.filter((item) =>
    item.kind === kind
    && !item.deletedAt
    && `${item.name} ${item.description} ${item.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()),
  ), [data.resources, kind, search]);
  const selected = resources.find((item) => item.id === selectedId) ?? resources[0];

  useEffect(() => {
    setSelectedId('');
  }, [kind]);

  const group = groups.find((item) => item.kind === kind)!;
  const Icon = group.icon;

  return (
    <div className="studio-assets-page">
      <header className="studio-assets-intro">
        <div><div className="studio-eyebrow">SHARED CONDITIONS</div><h2>共享资源</h2><p>正式评测会冻结这里选中的配置，后续修改不会改写历史证据。</p></div>
        <div className={readyCount === requiredKinds.length ? 'ready' : ''}><strong>{readyCount}/{requiredKinds.length}</strong><span>类必需条件已就绪</span></div>
      </header>
      <nav className="studio-resource-tabs">
        {groups.map((item) => {
          const TabIcon = item.icon;
          const count = data.resources.filter((resource) => resource.kind === item.kind && !resource.deletedAt).length;
          return <button key={item.kind} className={kind === item.kind ? 'active' : ''} onClick={() => setKind(item.kind)}><TabIcon size={15} />{item.label}<span>{count}</span></button>;
        })}
      </nav>
      <div className="studio-library-layout">
        <aside className="studio-library-list">
          <div className="studio-list-toolbar">
            <div className="studio-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`搜索${group.label}`} /></div>
            {canEdit && <button className="studio-icon-button primary" aria-label={`新建${group.label}`} title={`新建${group.label}`} onClick={() => setEditor('create')}><Plus size={17} /></button>}
          </div>
          <div className="studio-list-items">
            {resources.map((resource) => (
              <button key={resource.id} className={selected?.id === resource.id ? 'active' : ''} onClick={() => setSelectedId(resource.id)}>
                <span className={`studio-resource-icon ${kind}`}><Icon size={16} /></span>
                <span><strong>{resource.name}</strong><small>{resource.owner} · {resource.status === 'archived' ? '已归档' : '使用中'}</small></span>
              </button>
            ))}
            {!resources.length && <div className="studio-empty compact">暂无{group.label}</div>}
          </div>
        </aside>
        <main className="studio-library-detail">
          {selected ? (
            <>
              <header className="studio-detail-header">
                <div>
                  <div className="studio-eyebrow">{kind === 'model-config' ? 'MODEL CARD' : kind.toUpperCase()}</div>
                  <h2>{selected.name}</h2>
                  <p>{selected.description || dataSummary(selected)}</p>
                  <small className="studio-resource-purpose">{groupDescriptions[kind]}</small>
                  <div className="studio-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                </div>
                {canEdit && <div className="studio-header-actions">
                  <button className="studio-button secondary" onClick={() => setEditor('edit')}><Edit3 size={15} />编辑</button>
                  <button
                    className="studio-button secondary"
                    onClick={async () => {
                      await studioApi.updateResource(selected.id, { status: selected.status === 'active' ? 'archived' : 'active' });
                      notify(selected.status === 'active' ? '资源已归档' : '资源已恢复使用');
                      await reload();
                    }}
                  ><Archive size={15} />{selected.status === 'active' ? '归档' : '恢复使用'}</button>
                  <button
                    className="studio-icon-button danger"
                    aria-label="移入回收站"
                    title="移入回收站"
                    onClick={async () => {
                      if (!window.confirm(`将“${selected.name}”移入回收站？已完成评测仍保留冻结快照。`)) return;
                      await studioApi.deleteResource(selected.id);
                      setSelectedId('');
                      notify('资源已移入回收站');
                      await reload();
                    }}
                  ><Trash2 size={16} /></button>
                </div>}
              </header>
              <section className="studio-section-block">
                <header><div><h3>当前配置</h3><p>{dataSummary(selected)}</p></div><span className={`studio-status ${selected.status === 'active' ? 'published' : 'archived'}`}>{selected.status === 'active' ? '使用中' : '已归档'}</span></header>
                <ConfigSnapshot resource={selected} />
              </section>
            </>
          ) : (
            <div className="studio-empty"><Icon size={22} /><strong>还没有{group.label}</strong><span>{canEdit ? groupDescriptions[kind] : '当前账号拥有只读权限。'}</span>{canEdit && <button className="studio-button primary" onClick={() => setEditor('create')}><Plus size={15} />新建{group.label}</button>}</div>
          )}
        </main>
      </div>
      {editor && canEdit && (
        <StudioModal
          title={editor === 'create' ? `新建${group.label}` : `编辑${group.label}`}
          subtitle="资源修改只影响后续新建评测，历史运行继续使用冻结快照。"
          wide={kind === 'test-suite' || kind === 'scorecard'}
          onClose={() => setEditor(null)}
        >
          <ResourceEditor
            initial={editor === 'edit' ? selected : undefined}
            initialKind={kind}
            onCancel={() => setEditor(null)}
            onSave={async (input) => {
              if (editor === 'edit' && selected) {
                await studioApi.updateResource(selected.id, input as Partial<StudioResource>);
                notify('资源已更新');
              } else {
                const created = await studioApi.createResource(input as StudioCreateResourceInput);
                setSelectedId(created.id);
                notify('资源已创建');
              }
              setEditor(null);
              await reload();
            }}
          />
        </StudioModal>
      )}
    </div>
  );
}
