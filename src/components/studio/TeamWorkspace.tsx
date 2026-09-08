import { Activity, Check, FolderKanban, Plus, Shield, UserCog, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { StudioBootstrap, StudioMember, StudioMemberRole, StudioProject } from '../../../shared/studio-types';
import { authApi, studioApi } from '../../studio/api';
import StudioModal from './StudioModal';

const roleNames: Record<StudioMemberRole, string> = {
  owner: '负责人',
  editor: '编辑者',
  reviewer: '评审者',
  viewer: '观察者',
};

const roleHints: Record<StudioMemberRole, string> = {
  owner: '管理项目、成员、发布与全部资产',
  editor: '编辑资产、创建版本和运行评测',
  reviewer: '查看证据、提交评审结论和意见',
  viewer: '只读查看项目、版本和评测证据',
};

function RoleSelect({ value, onChange }: { value: StudioMemberRole; onChange: (role: StudioMemberRole) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value as StudioMemberRole)}>{Object.entries(roleNames).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select>;
}

function ProjectForm({ initial, onSave, onCancel }: { initial?: StudioProject; onSave: (data: { name: string; description: string }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return <form className="studio-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!name.trim()) return setError('请填写项目名称');
    setSaving(true);
    try { await onSave({ name: name.trim(), description }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false); }
  }}>
    <label className="studio-field"><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：多人群聊体验优化" /></label>
    <label className="studio-field"><span>项目说明</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述评测对象、业务目标和协作边界。" /></label>
    {error && <div className="studio-error">{error}</div>}
    <div className="studio-form-actions"><button type="button" className="studio-button secondary" onClick={onCancel}>取消</button><button className="studio-button primary" disabled={saving}>{saving ? '保存中...' : initial ? '保存项目' : '创建项目'}</button></div>
  </form>;
}

function MemberForm({ initial, onSave, onCancel }: { initial?: StudioMember; onSave: (data: { name: string; username: string; password?: string; role: StudioMemberRole; status?: StudioMember['status'] }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [role, setRole] = useState<StudioMemberRole>(initial?.role ?? 'reviewer');
  const [status, setStatus] = useState<StudioMember['status']>(initial?.status ?? 'invited');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return <form className="studio-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!name.trim() || !username.trim()) return setError('请填写姓名和账号');
    if (!/^[a-zA-Z0-9]{3,40}$/.test(username)) return setError('账号仅支持 3 至 40 位字母或数字');
    if (!initial && password.length < 3) return setError('初始密码至少需要 3 个字符');
    setSaving(true);
    try { await onSave({ name: name.trim(), username: username.trim(), role, ...(initial ? { status } : { password }) }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setSaving(false); }
  }}>
    <label className="studio-field"><span>姓名</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="studio-field"><span>账号</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="3 至 40 位字母或数字" minLength={3} maxLength={40} pattern="[A-Za-z0-9]+" /></label>
    {!initial && <label className="studio-field"><span>初始密码</span><input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 3 个字符" minLength={3} /></label>}
    <label className="studio-field"><span>组织默认角色</span><RoleSelect value={role} onChange={setRole} /><small>{roleHints[role]}</small></label>
    {initial && <label className="studio-field"><span>成员状态</span><select value={status} onChange={(event) => setStatus(event.target.value as StudioMember['status'])}><option value="invited">待激活</option><option value="active">已激活</option><option value="disabled">已停用</option></select></label>}
    {error && <div className="studio-error">{error}</div>}
    <div className="studio-form-actions"><button type="button" className="studio-button secondary" onClick={onCancel}>取消</button><button className="studio-button primary" disabled={saving}>{saving ? '保存中...' : initial ? '保存成员' : '创建账号'}</button></div>
  </form>;
}

export default function TeamWorkspace({ data, reload, notify, onProjectChange }: {
  data: StudioBootstrap;
  reload: () => Promise<void>;
  notify: (message: string, type?: 'success' | 'error') => void;
  onProjectChange: (projectId: string) => Promise<void>;
}) {
  const [modal, setModal] = useState<'project-create' | 'project-edit' | 'member-create' | 'member-edit' | 'member-add' | null>(null);
  const [editingMemberId, setEditingMemberId] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [memberRole, setMemberRole] = useState<StudioMemberRole>('reviewer');
  const currentRole = data.projectMembers.find((item) => item.memberId === data.currentMember.id)?.role ?? 'viewer';
  const canManage = currentRole === 'owner';
  const availableMembers = data.organizationMembers.filter((member) => (
    member.status === 'active' && !data.projectMembers.some((item) => item.memberId === member.id)
  ));
  const editingMember = data.organizationMembers.find((member) => member.id === editingMemberId);

  return <div className="studio-team-page">
    <header className="studio-page-heading">
      <div><div className="studio-eyebrow">ORGANIZATION & ACCESS</div><h2>{data.organization.name}</h2><p>{data.organization.description}</p></div>
      {canManage && <div className="studio-header-actions"><button className="studio-button secondary" onClick={() => setModal('member-create')}><UserPlus size={15} />创建账号</button><button className="studio-button primary" onClick={() => setModal('project-create')}><Plus size={15} />新建项目</button></div>}
    </header>

    <div className="studio-team-primary-grid">
      <section className="studio-section-block studio-project-space">
        <header><div><h3>项目空间</h3><p>资产、版本、评测与审计都按项目隔离；切换项目不会影响其他项目数据。</p></div><div className="studio-section-header-actions"><span className="studio-count">{data.projects.length}</span>{canManage && <button className="studio-button secondary small" onClick={() => setModal('project-edit')}><FolderKanban size={14} />编辑项目</button>}</div></header>
        <div className="studio-project-grid">{data.projects.map((project) => <button key={project.id} className={project.id === data.project.id ? 'active' : ''} onClick={() => void onProjectChange(project.id)}><span className="studio-resource-icon world"><FolderKanban size={17} /></span><span><strong>{project.name}</strong><small>{project.description || '暂无项目说明'}</small><em>{project.id === data.project.id ? '当前项目' : '切换项目'}</em></span></button>)}</div>
      </section>

      <section className="studio-section-block studio-identity-bar studio-identity-card">
        <div><span className="studio-avatar large">{data.currentMember.name.slice(0, 1)}</span><div><strong>当前身份：{data.currentMember.name}</strong><small>{roleNames[currentRole]} · {data.currentMember.username}</small></div></div>
        <small>权限由当前登录账号实时校验</small>
      </section>
    </div>

    <div className="studio-team-columns">
      <section className="studio-section-block">
        <header><div><h3>当前项目成员</h3><p>只有拥有账号、已激活并加入项目的成员可以访问项目和留下审计记录。</p></div>{canManage && <button className="studio-button secondary small" onClick={() => setModal('member-add')}><Plus size={14} />添加成员</button>}</header>
        <div className="studio-member-list">{data.projectMembers.map((membership) => <div key={membership.memberId}><span className="studio-avatar">{membership.member?.name.slice(0, 1) ?? '?'}</span><span><strong>{membership.member?.name ?? '未知成员'}</strong><small>{membership.member?.username} · {membership.member?.status === 'active' ? '已激活' : '待激活'}</small></span><span className="studio-member-role"><Shield size={13} />{roleNames[membership.role]}</span>{canManage && membership.memberId !== data.currentMember.id && <button className="studio-icon-button danger" title="移出当前项目" onClick={async () => { if (!window.confirm(`将 ${membership.member?.name} 移出当前项目？`)) return; try { await studioApi.removeProjectMember(data.project.id, membership.memberId); notify('已移出项目'); await reload(); } catch (cause) { notify(cause instanceof Error ? cause.message : String(cause), 'error'); } }}><UserMinus size={15} /></button>}</div>)}</div>
      </section>
      <section className="studio-section-block">
        <header><div><h3>组织成员</h3><p>成员可受邀、激活、停用；项目角色可单独调整。</p></div><span className="studio-count">{data.organizationMembers.length}</span></header>
        <div className="studio-member-list">{data.organizationMembers.map((member) => <div key={member.id}><span className="studio-avatar">{member.name.slice(0, 1)}</span><span><strong>{member.name}</strong><small>{member.username} · {member.status === 'active' ? '已激活' : member.status === 'invited' ? '待激活' : '已停用'}</small></span><span className="studio-member-role">{roleNames[member.role]}</span>{canManage && <button className="studio-icon-button" title="编辑成员" onClick={() => { setEditingMemberId(member.id); setModal('member-edit'); }}><UserCog size={15} /></button>}</div>)}</div>
      </section>
    </div>

    <section className="studio-section-block studio-team-audit">
      <header><div><h3>项目审计活动</h3><p>创建、编辑、运行、成员权限和评审结论都会追加记录，历史证据不被覆盖。</p></div><Activity size={18} /></header>
      <div className="studio-audit-list">{data.auditLogs.slice(0, 12).map((item) => <div key={item.id}><span><Activity size={14} /></span><div><strong>{item.summary}</strong><small>{item.actor} · {new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(item.createdAt)}</small></div><em>{item.action}</em></div>)}{!data.auditLogs.length && <div className="studio-empty compact">当前项目还没有审计活动</div>}</div>
    </section>

    {modal === 'project-create' && <StudioModal title="新建项目" subtitle="新项目从空白资产库开始，避免意外复用其他项目配置。" onClose={() => setModal(null)}><ProjectForm onCancel={() => setModal(null)} onSave={async (value) => { const project = await studioApi.createProject(value); setModal(null); notify('项目已创建'); await onProjectChange(project.id); }} /></StudioModal>}
    {modal === 'project-edit' && <StudioModal title="编辑当前项目" subtitle="不会改写已有版本、评测和审计证据。" onClose={() => setModal(null)}><ProjectForm initial={data.project} onCancel={() => setModal(null)} onSave={async (value) => { await studioApi.updateProject(data.project.id, value); setModal(null); notify('项目已更新'); await reload(); }} /></StudioModal>}
    {modal === 'member-create' && <StudioModal title="创建团队账号" subtitle="账号会立即加入当前项目；请通过安全渠道把初始密码交给成员。" onClose={() => setModal(null)}><MemberForm onCancel={() => setModal(null)} onSave={async (value) => { await authApi.createAccount({ name: value.name, username: value.username, password: value.password!, role: value.role, projectId: data.project.id, projectRole: value.role }); setModal(null); notify('团队账号已创建并加入当前项目'); await reload(); }} /></StudioModal>}
    {modal === 'member-edit' && editingMember && <StudioModal title="编辑组织成员" subtitle="停用成员会立即失去项目操作权限，但保留历史审计记录。" onClose={() => setModal(null)}><MemberForm initial={editingMember} onCancel={() => setModal(null)} onSave={async (value) => { await studioApi.updateMember(editingMember.id, value); setModal(null); notify('成员信息已更新'); await reload(); }} /></StudioModal>}
    {modal === 'member-add' && <StudioModal title="添加项目成员" subtitle="成员必须先在组织内激活，才可获得当前项目权限。" onClose={() => setModal(null)}><form className="studio-form" onSubmit={async (event) => { event.preventDefault(); if (!selectedMemberId) return; await studioApi.setProjectMember(data.project.id, selectedMemberId, memberRole); setModal(null); notify('成员已加入项目'); await reload(); }}><label className="studio-field"><span>成员</span><select value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}><option value="">请选择成员</option>{availableMembers.map((member) => <option value={member.id} key={member.id}>{member.name} · {member.username}</option>)}</select></label><label className="studio-field"><span>项目角色</span><RoleSelect value={memberRole} onChange={setMemberRole} /><small>{roleHints[memberRole]}</small></label>{!availableMembers.length && <div className="studio-empty compact">没有可加入的已激活成员</div>}<div className="studio-form-actions"><button type="button" className="studio-button secondary" onClick={() => setModal(null)}>取消</button><button className="studio-button primary" disabled={!selectedMemberId}><Check size={15} />确认加入</button></div></form></StudioModal>}
  </div>;
}
