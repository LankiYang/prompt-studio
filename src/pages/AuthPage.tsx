import { KeyRound, LogIn, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import BrandMark from '../components/BrandMark';
import { authApi, setStudioSession } from '../studio/api';

export default function AuthPage({ setupRequired, onAuthenticated }: { setupRequired: boolean; onAuthenticated: () => void }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const session = setupRequired
        ? await authApi.setup({ name, username, password })
        : await authApi.login({ username, password });
      setStudioSession({ token: session.token });
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  }

  return <main className="studio-auth-page">
    <section className="studio-auth-panel">
      <div className="studio-auth-brand"><BrandMark size={38} /><div><strong>Prompt Studio</strong><small>Team workspace</small></div></div>
      <div className="studio-auth-heading">
        <div className="studio-auth-icon">{setupRequired ? <UserPlus size={22} /> : <KeyRound size={22} />}</div>
        <div className="studio-auth-heading-copy">
          <h1>{setupRequired ? '初始化团队工作区' : '登录工作区'}</h1>
          <p>{setupRequired ? '创建首位负责人账号后，即可管理团队、项目与评测资产。' : '登录后将自动恢复本次浏览器中的会话。'}</p>
        </div>
      </div>
      <form className="studio-form" onSubmit={(event) => void submit(event)}>
        {setupRequired && <label className="studio-field"><span>姓名</span><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" placeholder="例如：张三" required /></label>}
        <label className="studio-field"><span>账号</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="3 至 40 位字母或数字" minLength={3} maxLength={40} pattern="[A-Za-z0-9]+" required /></label>
        <label className="studio-field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} placeholder="至少 3 个字符" minLength={3} maxLength={256} required /></label>
        {error && <div className="studio-error">{error}</div>}
        <button type="submit" className="studio-button primary studio-auth-submit" disabled={submitting}>{setupRequired ? <UserPlus size={16} /> : <LogIn size={16} />}{submitting ? '处理中...' : setupRequired ? '创建负责人账号' : '登录'}</button>
      </form>
    </section>
  </main>;
}
