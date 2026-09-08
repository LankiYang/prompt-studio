import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { ArrowLeft, BookOpen, Bot, Plus, Save, Trash2 } from "lucide-react";
import type { CharacterConfig } from "../../shared/types";
import BrandMark from "../components/BrandMark";

interface WorldConfig {
  worldSetting: string;
  characters: CharacterConfig[];
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function ConfigPage() {
  const navigate = useNavigate();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [worldSetting, setWorldSetting] = useState("");
  const [characters, setCharacters] = useState<CharacterConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [connected, setConnected] = useState(false);
  const savePendingRef = useRef(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    const connection = io(window.location.origin, { transports: ["websocket", "polling"] });
    connection.on("connect", () => {
      setConnected(true);
      connection.emit("get-config");
    });
    connection.on("disconnect", () => {
      setConnected(false);
      savePendingRef.current = false;
      setSaving(false);
    });
    connection.on("config-updated", (data: WorldConfig) => {
      if (dirtyRef.current && !savePendingRef.current) return;
      setWorldSetting(data.worldSetting ?? "");
      setCharacters(data.characters ?? []);
      dirtyRef.current = false;
      setDirty(false);
      if (savePendingRef.current) {
        savePendingRef.current = false;
        setSaving(false);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1800);
      }
    });
    setSocket(connection);
    return () => {
      connection.disconnect();
    };
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const addCharacter = () => {
    setCharacters((current) => [...current, { id: generateId(), name: "", persona: "" }]);
    dirtyRef.current = true;
    setDirty(true);
    setSaved(false);
  };
  const removeCharacter = (id: string) => {
    const character = characters.find((item) => item.id === id);
    if (character?.name && !window.confirm(`删除角色“${character.name}”？保存后该角色将从房间配置中移除。`)) return;
    setCharacters((current) => current.filter((item) => item.id !== id));
    dirtyRef.current = true;
    setDirty(true);
    setSaved(false);
  };
  const updateCharacter = (id: string, field: "name" | "persona", value: string) => {
    setCharacters((current) => current.map((character) => character.id === id ? { ...character, [field]: value } : character));
    dirtyRef.current = true;
    setDirty(true);
    setSaved(false);
  };

  const handleSave = () => {
    if (!socket || !connected || !dirty) return;
    setSaving(true);
    savePendingRef.current = true;
    socket.emit("save-config", { worldSetting, characters: characters.filter((character) => character.name.trim()) });
  };

  const leaveConfig = () => {
    if (dirty && !window.confirm("当前配置尚未保存，仍要离开吗？")) return;
    navigate("/room");
  };

  const configuredCount = characters.filter((character) => character.name.trim()).length;

  return (
    <div className="config-page min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <header className="workspace-header sticky top-0 z-10 border-b" style={{ background: "#fff", borderColor: "var(--border-color)" }}>
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={leaveConfig}
              className="w-8 h-8 flex items-center justify-center rounded-md transition-colors hover:bg-slate-50"
              style={{ color: "#475467", border: "1px solid var(--border-color)" }}
              title="返回多人聊天室"
              aria-label="返回多人聊天室"
            >
              <ArrowLeft size={16} />
            </button>
            <BrandMark size={30} />
            <div className="min-w-0">
              <h1 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>角色与世界观配置</h1>
              <p className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>所有 Builder 共用的评测基础数据</p>
            </div>
          </div>
          <div className="config-save-actions">
            <span className={`config-save-status ${dirty ? "dirty" : ""}`}>{!connected ? "正在连接" : dirty ? "有未保存更改" : "配置已同步"}</span>
          <button
            onClick={handleSave}
            disabled={saving || !dirty || !connected}
            className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-md transition-colors disabled:opacity-60"
            style={{ background: saved ? "#ecfdf3" : "var(--accent-primary)", color: saved ? "#15803d" : "#fff", border: saved ? "1px solid #bbf7d0" : "1px solid var(--accent-primary)" }}
          >
            <Save size={14} />
            {saved ? "已保存" : saving ? "保存中" : "保存更改"}
          </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 grid gap-5 lg:grid-cols-12">
        <section className="app-panel p-5 lg:col-span-5 lg:self-start">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: "var(--accent-primary-soft)", color: "var(--accent-primary)" }}><BookOpen size={15} /></span>
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>世界观</h2>
              <p className="text-xs" style={{ color: "var(--text-secondary)" }}>角色行为和记忆判断的共同背景</p>
            </div>
          </div>
          <textarea
            value={worldSetting}
            onChange={(event) => { setWorldSetting(event.target.value); dirtyRef.current = true; setDirty(true); setSaved(false); }}
            placeholder="描述故事背景、时代、地点和已知规则..."
            rows={16}
            className="w-full rounded-md px-3 py-3 text-sm leading-6 resize-y transition-colors"
            style={{ background: "#fbfcfe", border: "1px solid var(--border-color)", color: "var(--text-primary)", minHeight: "300px" }}
          />
        </section>

        <section className="lg:col-span-7">
          <div className="flex items-center justify-between mb-3 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: "#f0fdfa", color: "#0f766e" }}><Bot size={15} /></span>
              <div>
                <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>角色名册</h2>
                <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{configuredCount} 个已配置角色</p>
              </div>
            </div>
            <button
              onClick={addCharacter}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-colors hover:opacity-80"
              style={{ background: "var(--accent-primary-soft)", color: "var(--accent-primary)", border: "1px solid #b9dcd4" }}
            >
              <Plus size={14} />
              添加角色
            </button>
          </div>

          <div className="space-y-3">
            {characters.length === 0 && (
              <div className="app-panel py-12 text-center">
                <Bot size={28} className="mx-auto mb-3" style={{ color: "#98a2b3" }} />
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>还没有角色</p>
              </div>
            )}

            {characters.map((character, index) => (
              <article key={character.id} className="app-panel p-4 animate-fade-in">
                <div className="flex items-center gap-3 mb-3">
                  <span className="w-6 h-6 flex-shrink-0 rounded-md flex items-center justify-center text-xs font-semibold" style={{ background: "#f2f4f7", color: "#475467" }}>{index + 1}</span>
                  <input
                    type="text"
                    value={character.name}
                    onChange={(event) => updateCharacter(character.id, "name", event.target.value)}
                    placeholder="角色名称"
                    maxLength={20}
                    className="min-w-0 flex-1 bg-transparent text-sm font-semibold"
                    style={{ color: "var(--text-primary)" }}
                  />
                  <button
                    onClick={() => removeCharacter(character.id)}
                    className="w-8 h-8 flex-shrink-0 rounded-md flex items-center justify-center transition-colors hover:bg-rose-50"
                    style={{ color: "var(--danger)" }}
                    title="删除角色"
                    aria-label={`删除角色${character.name ? ` ${character.name}` : ''}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <textarea
                  value={character.persona}
                  onChange={(event) => updateCharacter(character.id, "persona", event.target.value)}
                  placeholder={`描述${character.name || "角色"}的背景、立场、语言习惯和能力边界...`}
                  rows={4}
                  className="w-full rounded-md px-3 py-2.5 text-sm leading-6 resize-y transition-colors"
                  style={{ background: "#fbfcfe", border: "1px solid var(--border-color)", color: "var(--text-primary)" }}
                />
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
