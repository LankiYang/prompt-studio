import {
  Activity,
  ArchiveRestore,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Code2,
  FlaskConical,
  GitCompareArrows,
  Home,
  LogOut,
  Menu,
  MessageSquareText,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  UsersRound,
  ClipboardCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { StudioBootstrap, StudioResourceKind } from '../../shared/studio-types';
import BrandMark from '../components/BrandMark';
import EvaluationWorkspace from '../components/studio/EvaluationWorkspace';
import PromptLibrary from '../components/studio/PromptLibrary';
import PromptDebugger from '../components/studio/PromptDebugger';
import ResourceLibrary from '../components/studio/ResourceLibrary';
import ReviewWorkspace from '../components/studio/ReviewWorkspace';
import TeamWorkspace from '../components/studio/TeamWorkspace';
import AuthPage from './AuthPage';
import { authApi, clearStudioSession, setStudioSession, studioApi } from '../studio/api';
import '../studio/studio.css';

type View = 'overview' | 'debugger' | 'prompts' | 'assets' | 'evaluations' | 'reviews' | 'team' | 'recycle';

const navGroups: Array<{ label: string; items: Array<{ id: View; label: string; icon: typeof Home }> }> = [
  { label: '开始', items: [{ id: 'overview', label: '项目概览', icon: Home }] },
  { label: '设计与调试', items: [
    { id: 'debugger', label: 'Prompt 调试器', icon: SlidersHorizontal },
    { id: 'prompts', label: 'Prompt 版本', icon: Code2 },
    { id: 'assets', label: '共享资源', icon: Boxes },
  ] },
  { label: '验证与协作', items: [
    { id: 'evaluations', label: '评测与结果', icon: FlaskConical },
    { id: 'reviews', label: '版本评审', icon: ClipboardCheck },
  ] },
  { label: '项目管理', items: [
    { id: 'team', label: '团队与权限', icon: UsersRound },
    { id: 'recycle', label: '回收站', icon: Trash2 },
  ] },
];

const nav = navGroups.flatMap((group) => group.items);

const roleNames = {
  owner: '负责人',
  editor: '编辑者',
  reviewer: '评审者',
  viewer: '观察者',
} as const;

function when(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function Overview({ data, open }: { data: StudioBootstrap; open: (view: View) => void }) {
  const recentRuns = data.evaluations.filter((item) => !item.deletedAt).slice(0, 5);
  const promptCount = data.resources.filter((item) => item.kind === 'prompt' && !item.deletedAt).length;
  const assetCount = data.resources.filter((item) => item.kind !== 'prompt' && !item.deletedAt).length;
  const activeKinds = new Set(data.resources.filter((item) => item.kind !== 'prompt' && !item.deletedAt && item.status === 'active').map((item) => item.kind));
  const requiredKinds: StudioResourceKind[] = ['character', 'world', 'test-suite', 'scorecard', 'model-config', 'scheduler-policy', 'memory-policy'];
  const readyConditionCount = requiredKinds.filter((kind) => activeKinds.has(kind)).length;
  const conditionsReady = readyConditionCount === requiredKinds.length;
  const versionReady = data.promptVersions.length >= 2;
  const evaluationReady = data.counts.completedEvaluations > 0;
  const reviewReady = data.reviews.length > 0;
  const publishedVersion = data.promptVersions.find((item) => item.status === 'published');
  const workflow = [
    {
      number: '01',
      title: '调试候选 Prompt',
      detail: '用同一条输入比较参考配置与候选配置，先确认改动方向。',
      action: '进入调试',
      view: 'debugger' as View,
      icon: SlidersHorizontal,
      done: versionReady,
    },
    {
      number: '02',
      title: '保存为新版本',
      detail: versionReady ? `已有 ${data.promptVersions.length} 个不可变版本，可进行新旧对比。` : '至少保留两个版本，避免覆盖当前基线。',
      action: '管理版本',
      view: 'prompts' as View,
      icon: Code2,
      done: versionReady,
    },
    {
      number: '03',
      title: '准备共享条件',
      detail: conditionsReady ? '正式评测需要的 7 类条件均已就绪。' : `已准备 ${readyConditionCount}/7 类条件，继续补齐角色、测试集与运行配置。`,
      action: '检查条件',
      view: 'assets' as View,
      icon: Boxes,
      done: conditionsReady,
    },
    {
      number: '04',
      title: '运行新旧版本对比',
      detail: evaluationReady ? `${data.counts.completedEvaluations} 次评测已留下可复核证据。` : '固定其他条件后运行评测，保存每条原始回复和评分。',
      action: '发起评测',
      view: 'evaluations' as View,
      icon: FlaskConical,
      done: evaluationReady,
    },
    {
      number: '05',
      title: '逐案例人工复核',
      detail: reviewReady ? `${data.reviews.length} 个评审任务已建立。` : '逐条比较旧版与新版回复，再形成团队结论。',
      action: '进入评审',
      view: 'reviews' as View,
      icon: ClipboardCheck,
      done: reviewReady,
    },
  ];
  const suggested = !promptCount
    ? { label: '先创建 Prompt', view: 'prompts' as View }
    : !versionReady
      ? { label: '继续调试候选版本', view: 'debugger' as View }
      : !conditionsReady
        ? { label: '补齐共享条件', view: 'assets' as View }
        : !evaluationReady
          ? { label: '运行首次评测', view: 'evaluations' as View }
          : !reviewReady
            ? { label: '发起人工评审', view: 'reviews' as View }
            : { label: '开始下一轮优化', view: 'debugger' as View };
  return (
    <div className="studio-overview">
      <section className="studio-overview-start">
        <header className="studio-page-heading">
          <div>
            <div className="studio-eyebrow">PROJECT WORKSPACE</div>
            <h2>{data.project.name}</h2>
            <p>{data.project.description || '在这里维护 Prompt 版本，使用固定测试条件验证每一次改动。'}</p>
          </div>
          <button className="studio-button primary" onClick={() => open(suggested.view)}><ChevronRight size={16} />{suggested.label}</button>
        </header>
        <div className="studio-overview-status" aria-label="项目状态">
          <span><Code2 size={14} /><strong>{data.counts.promptVersions}</strong> 个版本</span>
          <span><Boxes size={14} /><strong>{assetCount}</strong> 项共享条件</span>
          <span><FlaskConical size={14} /><strong>{data.counts.completedEvaluations}</strong> 次完成评测</span>
        </div>
        <div className="studio-start-steps">
          {workflow.map((step) => {
            const Icon = step.icon;
            return <button key={step.number} className={step.done ? 'done' : ''} onClick={() => open(step.view)}>
              <span className="studio-start-number">{step.done ? <CheckCircle2 size={16} /> : step.number}</span>
              <span className="studio-start-icon"><Icon size={18} /></span>
              <span className="studio-start-copy"><strong>{step.title}</strong><small>{step.detail}</small></span>
              <span className="studio-start-action">{step.action}<ChevronRight size={15} /></span>
            </button>;
          })}
        </div>
      </section>

      <div className="studio-overview-columns studio-overview-evidence">
        <section className="studio-section-block">
          <header><div><h3>最近评测</h3><p>新版相对旧版的真实结果。</p></div><Activity size={18} /></header>
          <div className="studio-recent-runs">
            {recentRuns.map((run) => (
              <button key={run.id} onClick={() => open('evaluations')}>
                <span className={`studio-run-status ${run.status}`}><FlaskConical size={15} /></span>
                <span><strong>{run.name}</strong><small>{when(run.createdAt)} · {run.sharedConfig.cases.length} 轮</small></span>
                <em className={run.result?.totalDelta != null && run.result.totalDelta >= 0 ? 'positive' : 'negative'}>
                  {run.result?.totalDelta == null ? '-' : `${run.result.totalDelta > 0 ? '+' : ''}${run.result.totalDelta}`}
                </em>
              </button>
            ))}
            {!recentRuns.length && <div className="studio-empty compact"><FlaskConical size={18} />暂无评测记录</div>}
          </div>
        </section>
        <section className="studio-section-block studio-project-summary">
          <header><div><h3>当前基线</h3><p>用于下一次受控对比的工作区状态。</p></div><ShieldCheck size={18} /></header>
          <dl>
            <div><dt>已发布版本</dt><dd>{publishedVersion ? `v${publishedVersion.number} · ${publishedVersion.title}` : '尚未发布'}</dd></div>
            <div><dt>测试与条件</dt><dd>{assetCount ? `${assetCount} 项已维护` : '尚未配置'}</dd></div>
            <div><dt>版本证据</dt><dd>{data.counts.completedEvaluations ? `${data.counts.completedEvaluations} 次可复核结果` : '尚未运行评测'}</dd></div>
          </dl>
          <button className="studio-button secondary small" onClick={() => open('reviews')}><ClipboardCheck size={14} />查看评审结论</button>
        </section>
      </div>
    </div>
  );
}

function RecycleBin({
  data,
  reload,
  notify,
}: {
  data: StudioBootstrap;
  reload: () => Promise<void>;
  notify: (message: string, type?: 'success' | 'error') => void;
}) {
  const recycled = data.resources.filter((item) => Boolean(item.deletedAt));
  return (
    <div className="studio-recycle">
      <header className="studio-page-heading">
        <div><div className="studio-eyebrow">RECYCLE BIN</div><h2>回收站</h2><p>资源删除不会破坏历史 Prompt 版本、评测快照或原始模型证据。</p></div>
      </header>
      <section className="studio-section-block">
        <header><div><h3>已删除资源</h3><p>恢复后会回到原类型资源库。</p></div><span className="studio-count">{recycled.length}</span></header>
        <div className="studio-recycle-list">
          {recycled.map((resource) => (
            <div key={resource.id}>
              <span className="studio-resource-icon"><Trash2 size={15} /></span>
              <span><strong>{resource.name}</strong><small>{resource.kind} · 删除于 {when(resource.deletedAt!)}</small></span>
              <span className="studio-recycle-actions">
                <button
                  className="studio-button secondary small"
                  onClick={async () => {
                    await studioApi.restoreResource(resource.id);
                    notify(`已恢复“${resource.name}”`);
                    await reload();
                  }}
                ><ArchiveRestore size={14} />恢复</button>
                <button
                  className="studio-icon-button danger"
                  aria-label="永久删除"
                  title="永久删除"
                  onClick={async () => {
                    if (!window.confirm(`永久删除“${resource.name}”？被版本或评测引用时系统会拒绝。`)) return;
                    try {
                      await studioApi.permanentlyDeleteResource(resource.id);
                      notify(`已永久删除“${resource.name}”`);
                      await reload();
                    } catch (error) {
                      notify(error instanceof Error ? error.message : String(error), 'error');
                    }
                  }}
                ><Trash2 size={14} /></button>
              </span>
            </div>
          ))}
          {!recycled.length && <div className="studio-empty"><ArchiveRestore size={21} /><strong>回收站是空的</strong><span>删除的业务资源会出现在这里。</span></div>}
        </div>
      </section>
    </div>
  );
}

export default function StudioPage() {
  const [data, setData] = useState<StudioBootstrap | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [authState, setAuthState] = useState<'checking' | 'anonymous' | 'authenticated'>('checking');
  const [setupRequired, setSetupRequired] = useState(false);
  const requestedView = searchParams.get('view');
  const view: View = nav.some((item) => item.id === requestedView) ? requestedView as View : 'overview';

  const reload = useCallback(async () => {
    try {
      const next = await studioApi.bootstrap();
      setStudioSession({ projectId: next.project.id });
      setData(next);
      setLoadError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401') || message.includes('登录')) {
        clearStudioSession();
        setData(null);
        setAuthState('anonymous');
        return;
      }
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const bootstrap = await authApi.bootstrap();
        setSetupRequired(bootstrap.setupRequired);
        if (!bootstrap.setupRequired) await authApi.me();
        setAuthState(bootstrap.setupRequired ? 'anonymous' : 'authenticated');
      } catch {
        clearStudioSession();
        setAuthState('anonymous');
      }
    })();
  }, []);

  useEffect(() => {
    if (authState === 'authenticated') void reload();
  }, [authState, reload]);

  function notify(message: string, type: 'success' | 'error' = 'success') {
    setNotice({ message, type });
    window.setTimeout(() => setNotice((current) => current?.message === message ? null : current), 3200);
  }

  function open(next: View) {
    setSearchParams(next === 'overview' ? {} : { view: next });
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function changeProject(projectId: string) {
    if (projectId === data?.project.id) return;
    setStudioSession({ projectId });
    setLoading(true);
    await reload();
  }

  async function logout() {
    await authApi.logout().catch(() => undefined);
    clearStudioSession();
    setData(null);
    setAuthState('anonymous');
    setSetupRequired(false);
  }

  if (authState === 'checking') {
    return <div className="studio-loading"><RefreshCw className="spin" size={24} /><strong>正在恢复登录会话</strong><span>验证团队工作区访问权限...</span></div>;
  }

  if (authState === 'anonymous') {
    return <AuthPage setupRequired={setupRequired} onAuthenticated={() => { setSetupRequired(false); setLoading(true); setAuthState('authenticated'); }} />;
  }

  if (loading) {
    return <div className="studio-loading"><RefreshCw className="spin" size={24} /><strong>正在加载 Prompt Studio</strong><span>初始化资源与版本数据...</span></div>;
  }
  if (!data || loadError) {
    return <div className="studio-loading error"><CircleHelp size={24} /><strong>Studio 暂时不可用</strong><span>{loadError || '无法读取项目数据'}</span><button className="studio-button primary" onClick={() => { setLoading(true); void reload(); }}>重试</button></div>;
  }

  const currentRole = data.projectMembers.find((item) => item.memberId === data.currentMember.id)?.role ?? 'viewer';

  return (
    <div className="studio-app">
      <aside className={`studio-sidebar ${sidebarOpen ? 'open' : ''}`}>
        <header>
          <BrandMark className="studio-logo" size={32} />
          <div><strong>Prompt Studio</strong><small>Team workspace</small></div>
          <button className="studio-icon-button mobile-only" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}><X size={17} /></button>
        </header>
        <div className="studio-project-switcher">
          <span><UsersRound size={15} /></span>
          <div><strong>{data.project.name}</strong><small>{data.projectMembers.length} 位项目成员</small></div>
          <button className="studio-icon-button" aria-label="打开团队与项目" title="团队与项目" onClick={() => open('team')}><ChevronRight size={14} /></button>
        </div>
        <nav>
          {navGroups.map((group) => <div className="studio-nav-group" key={group.label}>
            <small>{group.label}</small>
            {group.items.map((item) => {
              const Icon = item.icon;
              return <button key={item.id} aria-current={view === item.id ? 'page' : undefined} className={view === item.id ? 'active' : ''} onClick={() => open(item.id)}><Icon size={17} /><span>{item.label}</span>{item.id === 'recycle' && data.counts.recycledResources > 0 && <em>{data.counts.recycledResources}</em>}</button>;
            })}
          </div>)}
          <div className="studio-nav-group">
            <small>体验实验</small>
          <Link to="/join"><MessageSquareText size={17} /><span>多人聊天房</span></Link>
          <Link to="/memory"><GitCompareArrows size={17} /><span>记忆实验室</span></Link>
          <Link to="/config"><Settings size={17} /><span>房间配置</span></Link>
          </div>
        </nav>
        <footer>
          <span className="studio-avatar">{data.currentMember.name.slice(0, 1)}</span>
          <div><strong>{data.currentMember.name}</strong><small>{roleNames[currentRole]} · {data.currentMember.username}</small></div>
        </footer>
      </aside>
      {sidebarOpen && <button className="studio-sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" />}

      <div className="studio-main">
        <header className="studio-topbar">
          <button className="studio-icon-button mobile-only" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button>
          <div className="studio-breadcrumb"><span>{data.project.name}</span><ChevronRight size={13} /><strong>{nav.find((item) => item.id === view)?.label}</strong></div>
          <div className="studio-topbar-actions">
            <button className="studio-icon-button" aria-label="刷新数据" title="刷新数据" onClick={() => void reload()}><RefreshCw size={16} /></button>
            <span className="studio-avatar" title={`${data.currentMember.name} · ${data.currentMember.username}`}>{data.currentMember.name.slice(0, 1)}</span>
            <button className="studio-icon-button" aria-label="退出登录" title="退出登录" onClick={() => void logout()}><LogOut size={16} /></button>
          </div>
        </header>
        <div className={`studio-content view-${view}`}>
          {view === 'overview' && <Overview data={data} open={open} />}
          {view === 'debugger' && <PromptDebugger data={data} notify={notify} onOpenAssets={() => open('assets')} onOpenPrompts={() => open('prompts')} />}
          {view === 'prompts' && <PromptLibrary data={data} reload={reload} notify={notify} />}
          {view === 'assets' && <ResourceLibrary data={data} reload={reload} notify={notify} />}
          {view === 'evaluations' && <EvaluationWorkspace data={data} reload={reload} notify={notify} onOpenAssets={() => open('assets')} onOpenPrompts={() => open('prompts')} />}
          {view === 'reviews' && <ReviewWorkspace data={data} reload={reload} notify={notify} onOpenEvaluations={() => open('evaluations')} />}
          {view === 'team' && <TeamWorkspace data={data} reload={reload} notify={notify} onProjectChange={changeProject} />}
          {view === 'recycle' && <RecycleBin data={data} reload={reload} notify={notify} />}
        </div>
      </div>
      {notice && <div className={`studio-toast ${notice.type}`}>{notice.type === 'success' ? <ShieldCheck size={16} /> : <CircleHelp size={16} />}{notice.message}</div>}
    </div>
  );
}
