import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Brain, Settings, Sparkles, Users } from "lucide-react";
import BrandMark from "../components/BrandMark";

export default function JoinPage() {
  const [nickname, setNickname] = useState(() => sessionStorage.getItem("nickname") ?? "");
  const navigate = useNavigate();

  const handleJoin = () => {
    const trimmed = nickname.trim();
    if (!trimmed) return;
    sessionStorage.setItem("nickname", trimmed);
    navigate("/room", { state: { nickname: trimmed } });
  };

  return (
    <div className="join-page min-h-screen px-4 py-5 flex flex-col" style={{ background: "var(--bg-primary)" }}>
      <header className="app-public-header mx-auto w-full max-w-5xl flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <BrandMark size={34} />
          <div>
            <h1 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Prompt Studio</h1>
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>多人角色对比工作台</p>
          </div>
        </div>
        <div className="app-public-nav">
          <button onClick={() => navigate("/workspace")} className="app-nav-button"><Sparkles size={14} />工作区</button>
          <button className="app-nav-button is-active"><Users size={14} />多人聊天</button>
          <button onClick={() => navigate("/memory")} className="app-nav-button"><Brain size={14} />记忆评测</button>
          <button onClick={() => navigate("/config")} className="app-nav-button"><Settings size={14} />角色配置</button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center">
        <section className="join-panel w-full max-w-md app-panel p-7 sm:p-8">
          <div className="flex items-start justify-between gap-4 mb-7">
            <div>
              <p className="text-xs font-medium mb-2" style={{ color: "var(--neon-cyan)" }}>多人对比房间</p>
              <h2 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>选择测试身份</h2>
            </div>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "#f0fdfa", color: "var(--neon-magenta)" }}>
              <Users size={18} />
            </div>
          </div>

          <label className="block text-xs font-medium mb-2" style={{ color: "#475467" }} htmlFor="nickname">
            测试昵称
          </label>
          <input
            id="nickname"
            type="text"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleJoin()}
            placeholder="输入用于测试的昵称"
            maxLength={12}
            className="w-full px-3.5 py-2.5 rounded-md text-sm transition-colors"
            style={{ background: "#fff", border: "1px solid var(--border-color)", color: "var(--text-primary)" }}
            autoFocus
          />

          <button
            onClick={handleJoin}
            disabled={!nickname.trim()}
            className="app-primary-action mt-4 w-full py-2.5 text-sm disabled:opacity-45"
          >
            进入多人聊天
            <ArrowRight size={16} />
          </button>
        </section>
      </main>
    </div>
  );
}
