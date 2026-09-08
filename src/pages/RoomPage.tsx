import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { io, Socket } from "socket.io-client";
import { Bot, BookOpen, Loader2, LogOut, Plus, Save, Send, Trash2, User, Users } from "lucide-react";

type ConfigTab = "none" | "builder";

interface Message {
  id: string;
  sessionId?: string;
  senderNickname: string;
  isAI: boolean;
  builderId?: string;
  characterId?: string;
  content: string;
  timestamp: number;
}

interface UserInfo {
  id: string;
  nickname: string;
}

interface PromptConfig {
  id: string;
  label: string;
  template: string;
  variableConfig?: BuilderVariableConfig;
  worldSetting?: string;
  characters?: CharacterConfig[];
}

interface CharacterConfig {
  id: string;
  name: string;
  persona: string;
}

interface WorldConfig {
  worldSetting: string;
  characters: CharacterConfig[];
}

interface BuilderVariableConfig {
  taskDescriptions: {
    chat: string;
    mention: string;
    proactive: string;
  };
  outputFormat: string;
  dialogueRules: string;
}

const PROMPT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  "prompt-a": { bg: "rgba(0, 240, 255, 0.12)", border: "rgba(0, 240, 255, 0.35)", text: "var(--neon-cyan)" },
  "prompt-b": { bg: "rgba(255, 45, 120, 0.12)", border: "rgba(255, 45, 120, 0.35)", text: "var(--neon-magenta)" },
};

function normalizeBuilderLabel(config: PromptConfig): PromptConfig {
  if (config.id === "prompt-a") return { ...config, label: "Builder A" };
  if (config.id === "prompt-b") return { ...config, label: "Builder B" };
  return config;
}

export default function RoomPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const nickname = (location.state as { nickname?: string } | null)?.nickname
    || sessionStorage.getItem("nickname")
    || "评测用户";

  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [input, setInput] = useState("");
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [saved, setSaved] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");
  const [configTab, setConfigTab] = useState<ConfigTab>("none");
  const [showSidebar, setShowSidebar] = useState(false);
  const leftMessagesRef = useRef<HTMLDivElement>(null);
  const rightMessagesRef = useRef<HTMLDivElement>(null);
  const shouldFollowScrollRef = useRef({ left: true, right: true });
  const activeEvaluationCountRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    sessionStorage.setItem("nickname", nickname);

    const s = io(window.location.origin, {
      transports: ["websocket", "polling"],
    });

    s.on("connect", () => {
      setConnected(true);
      s.emit("join-room", { nickname });
      s.emit("get-prompt-config");
          });

    s.on("disconnect", () => {
      setConnected(false);
      activeEvaluationCountRef.current = 0;
      setEvaluating(false);
    });

    s.on("room-history", (data: { messages: Message[]; users: UserInfo[]; sessionId?: string }) => {
      setMessages(data.messages);
      setUsers(data.users);
    });

    s.on("prompt-config-updated", (data: PromptConfig[]) => {
      if (Array.isArray(data) && data.length === 2) {
        setPrompts(data.map((p) => ({
          ...normalizeBuilderLabel(p),
          variableConfig: p.variableConfig,
        })));
      }
    });

    s.on("config-updated", (_data: WorldConfig) => {
      // 不再使用共享的 worldSetting 和 characters，每个 builder 自带
    });

    s.on("new-message", (message: Message) => {
      setMessages((prev) => [...prev, message]);
    });

    s.on("user-joined", (data: { nickname: string }) => {
      setUsers((prev) => {
        if (prev.some((user) => user.nickname === data.nickname)) return prev;
        return [...prev, { id: data.nickname, nickname: data.nickname }];
      });
    });

    s.on("user-left", (data: { nickname: string }) => {
      setUsers((prev) => prev.filter((user) => user.nickname !== data.nickname));
    });

    s.on("prompt-evaluation-started", () => {
      activeEvaluationCountRef.current += 1;
      setEvaluating(true);
    });
    s.on("prompt-evaluation-result", () => {
      activeEvaluationCountRef.current = Math.max(0, activeEvaluationCountRef.current - 1);
      setEvaluating(activeEvaluationCountRef.current > 0);
    });

    s.on("room-history-cleared", () => {
      setMessages([]);
      activeEvaluationCountRef.current = 0;
      setEvaluating(false);
      setSessionNotice("会话已重启，旧上下文已丢弃");
      window.setTimeout(() => setSessionNotice(""), 2200);
    });

    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [nickname]);

  useEffect(() => {
    const scrollIfNeeded = (element: HTMLDivElement | null, side: "left" | "right") => {
      if (!element || !shouldFollowScrollRef.current[side]) return;
      element.scrollTop = element.scrollHeight;
    };
    scrollIfNeeded(leftMessagesRef.current, "left");
    scrollIfNeeded(rightMessagesRef.current, "right");
  }, [messages, evaluating]);

  const handleRoomScroll = (side: "left" | "right", element: HTMLDivElement) => {
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldFollowScrollRef.current[side] = distanceToBottom < 80;
  };

  const updatePrompt = (id: string, value: string) => {
    setPrompts((prev) => prev.map((item) => item.id === id ? { ...item, template: value } : item));
    setSaved(false);
  };

  const updateBuilderVariableConfig = (
    builderId: string,
    field: "chat" | "mention" | "proactive" | "outputFormat" | "dialogueRules",
    value: string,
  ) => {
    setPrompts((prev) => prev.map((p) => {
      if (p.id !== builderId) return p;
      const vc = p.variableConfig ?? { taskDescriptions: { chat: "", mention: "", proactive: "" }, outputFormat: "", dialogueRules: "" };
      if (field === "chat" || field === "mention" || field === "proactive") {
        return { ...p, variableConfig: { ...vc, taskDescriptions: { ...vc.taskDescriptions, [field]: value } } };
      }
      return { ...p, variableConfig: { ...vc, [field]: value } };
    }));
    setSaved(false);
  };

  const updateBuilderCharacter = (builderId: string, charId: string, field: "name" | "persona", value: string) => {
    setPrompts((prev) => prev.map((p) => {
      if (p.id !== builderId) return p;
      const chars = (p.characters ?? []).map((c) => c.id === charId ? { ...c, [field]: value } : c);
      return { ...p, characters: chars };
    }));
    setSaved(false);
  };

  const addBuilderCharacter = (builderId: string) => {
    setPrompts((prev) => prev.map((p) => {
      if (p.id !== builderId) return p;
      const chars = [...(p.characters ?? []), { id: `char-${Date.now()}`, name: "新角色", persona: "" }];
      return { ...p, characters: chars };
    }));
    setSaved(false);
  };

  const removeBuilderCharacter = (builderId: string, charId: string) => {
    setPrompts((prev) => prev.map((p) => {
      if (p.id !== builderId) return p;
      return { ...p, characters: (p.characters ?? []).filter((c) => c.id !== charId) };
    }));
    setSaved(false);
  };

  const updateBuilderWorldSetting = (builderId: string, value: string) => {
    setPrompts((prev) => prev.map((p) => p.id === builderId ? { ...p, worldSetting: value } : p));
    setSaved(false);
  };

  const savePrompts = () => {
    if (!socket) return;
    socket.emit("save-prompt-config", prompts);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const sendMessage = () => {
    const trimmed = input.trim();
    if (!socket || !connected || evaluating || !trimmed) return;
    socket.emit("send-message", { content: trimmed });
    setInput("");
    inputRef.current?.focus();
  };

  const clearHistory = () => {
    socket?.emit("clear-room-history");
  };

  const leaveRoom = () => {
    sessionStorage.removeItem("nickname");
    socket?.disconnect();
    navigate("/", { replace: true });
  };



  return (
    <div className="room-page min-h-screen flex flex-col" style={{ background: "var(--bg-primary)" }}>
      <header
        className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b"
        style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
      >
        <div className="flex items-center gap-3">
          <Bot size={18} style={{ color: "var(--neon-magenta)" }} />
          <h1 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Prompt Studio
          </h1>
          <div
            className="flex items-center gap-1.5 text-xs px-2 py-1 rounded"
            style={{
              background: connected ? "rgba(0, 240, 255, 0.1)" : "rgba(255, 45, 120, 0.1)",
              color: connected ? "var(--neon-cyan)" : "var(--neon-magenta)",
            }}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${connected ? "animate-glow" : ""}`}
              style={{ background: connected ? "var(--neon-cyan)" : "var(--neon-magenta)" }}
            />
            {connected ? "已连接" : "断开"}
          </div>
          {sessionNotice && (
            <span className="text-xs" style={{ color: "#22c55e" }}>
              {sessionNotice}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setConfigTab((t) => t === "builder" ? "none" : "builder")}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-200 hover:opacity-80"
            style={{
              background: configTab === "builder" ? "rgba(0, 240, 255, 0.12)" : "rgba(255, 255, 255, 0.05)",
              color: configTab === "builder" ? "var(--neon-cyan)" : "var(--text-secondary)",
              border: configTab === "builder" ? "1px solid rgba(0, 240, 255, 0.25)" : "1px solid var(--border-color)",
            }}
          >
            <BookOpen size={14} />
            Builder配置
          </button>
          <button
            onClick={savePrompts}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-200 hover:opacity-80"
            style={{
              background: saved ? "rgba(34, 197, 94, 0.16)" : "rgba(0, 240, 255, 0.1)",
              color: saved ? "#22c55e" : "var(--neon-cyan)",
              border: saved ? "1px solid rgba(34, 197, 94, 0.25)" : "1px solid rgba(0, 240, 255, 0.2)",
            }}
          >
            <Save size={14} />
            {saved ? "已同步" : "同步配置"}
          </button>
          <button
            onClick={clearHistory}
            disabled={messages.length === 0}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-200 hover:opacity-80 disabled:opacity-40"
            style={{
              background: "rgba(250, 204, 21, 0.1)",
              color: "#facc15",
              border: "1px solid rgba(250, 204, 21, 0.2)",
            }}
          >
            <Trash2 size={14} />
            清空记录
          </button>
          <button
            onClick={() => setShowSidebar((v) => !v)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-200 hover:opacity-80"
            style={{
              background: showSidebar ? "rgba(0, 240, 255, 0.12)" : "rgba(255, 255, 255, 0.05)",
              color: showSidebar ? "var(--neon-cyan)" : "var(--text-secondary)",
              border: showSidebar ? "1px solid rgba(0, 240, 255, 0.25)" : "1px solid var(--border-color)",
            }}
          >
            <Users size={14} />
            侧边栏
          </button>
          <button
            onClick={leaveRoom}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all duration-200 hover:opacity-80"
            style={{
              background: "rgba(255, 45, 120, 0.1)",
              color: "var(--neon-magenta)",
              border: "1px solid rgba(255, 45, 120, 0.2)",
            }}
          >
            <LogOut size={14} />
            退出
          </button>
        </div>
      </header>

      <div
        className="flex overflow-hidden"
        style={{ height: "calc(100vh - 57px)", minHeight: 0 }}
      >
        <main
          className="flex-1 flex flex-col min-w-0 overflow-y-auto"
          style={{ minHeight: 0 }}
        >
          {configTab === "builder" && (
            <section
              className="flex-shrink-0 p-4 border-b"
              style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
            >
              <div className="mb-3">
                <h2 className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
                  Builder 配置
                </h2>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  每个 Builder 独立配置全部变量，对比时观察不同组合的效果
                </p>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                  gap: "16px",
                }}
              >
                {prompts.map((prompt) => (
                  <BuilderFullEditor
                    key={prompt.id}
                    config={prompt}
                    onUpdateTemplate={(value) => updatePrompt(prompt.id, value)}
                    onUpdateVariable={(field, value) => updateBuilderVariableConfig(prompt.id, field, value)}
                    onUpdateWorldSetting={(value) => updateBuilderWorldSetting(prompt.id, value)}
                    onAddCharacter={() => addBuilderCharacter(prompt.id)}
                    onUpdateCharacter={(charId, field, value) => updateBuilderCharacter(prompt.id, charId, field, value)}
                    onRemoveCharacter={(charId) => removeBuilderCharacter(prompt.id, charId)}
                  />
                ))}
              </div>
              <VariableHelp />
            </section>
          )}

          <section
            className="flex-1 min-h-0 p-4 overflow-hidden"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: "16px",
              minHeight: configTab !== "none" ? "560px" : 0,
            }}
          >
            {prompts.map((prompt, index) => {
              const color = PROMPT_COLORS[prompt.id] ?? PROMPT_COLORS["prompt-a"];
              const visibleMessages = messages.filter((message) => (
                !message.isAI || message.builderId === prompt.id
              ));
              const side = index === 0 ? "left" : "right";
              const scrollRef = index === 0 ? leftMessagesRef : rightMessagesRef;

              return (
                <div
                  key={prompt.id}
                  className="min-h-0 rounded-lg border flex flex-col overflow-hidden"
                  style={{ background: "var(--bg-secondary)", borderColor: color.border }}
                >
                  <div className="flex-shrink-0 px-3 py-2 border-b" style={{ borderColor: color.border }}>
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-xs font-semibold" style={{ color: color.text }}>
                        {prompt.label} 房间
                      </h2>
                      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                        {visibleMessages.length} 条
                      </span>
                    </div>
                  </div>

                  <div
                    ref={scrollRef}
                    onScroll={(event) => handleRoomScroll(side, event.currentTarget)}
                    className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3"
                  >
                    {visibleMessages.length === 0 && !evaluating && (
                      <div className="h-full flex items-center justify-center text-sm text-center px-4" style={{ color: "var(--text-secondary)" }}>
                        发一条测试消息，这里会显示用户消息和 {prompt.label} 渲染后的角色回复。
                      </div>
                    )}

                    {visibleMessages.map((message) => (
                      <MessageBubble key={message.id} message={message} />
                    ))}

                    {evaluating && (
                      <div
                        className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg"
                        style={{ background: "rgba(255,255,255,0.04)", color: "var(--text-secondary)" }}
                      >
                        <Loader2 size={16} className="animate-spin" style={{ color: color.text }} />
                        {prompt.label} 正在回复...
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <section
            className="flex-shrink-0 px-4 py-3 border-t"
            style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
          >
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }}
                rows={1}
                placeholder="输入测试消息，Enter 发送给两个 Prompt..."
                className="flex-1 resize-none rounded-xl px-4 py-2.5 text-sm leading-5"
                style={{
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-color)",
                  color: "var(--text-primary)",
                  maxHeight: "120px",
                }}
              />
              <button
                onClick={sendMessage}
                disabled={!connected || evaluating || !input.trim()}
                className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-xl transition-all duration-200 disabled:opacity-40"
                style={{
                  background: input.trim() && connected && !evaluating
                    ? "linear-gradient(135deg, var(--neon-cyan), #00b8c4)"
                    : "var(--border-color)",
                  color: input.trim() && connected && !evaluating ? "#0a0a0f" : "var(--text-secondary)",
                }}
              >
                <Send size={18} />
              </button>
            </div>
          </section>
        </main>

        {showSidebar && (
          <aside
            className="flex-shrink-0 w-64 border-l flex flex-col"
            style={{ background: "var(--bg-secondary)", borderColor: "var(--border-color)" }}
          >
            <div className="px-4 py-3 border-b" style={{ borderColor: "var(--border-color)" }}>
              <h2 className="text-xs font-semibold flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
                <Users size={14} />
                在线用户 ({users.length})
              </h2>
            </div>
            <div className="p-3 space-y-1.5">
              {users.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg"
                  style={{ background: "rgba(255, 255, 255, 0.03)" }}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: "#22c55e", boxShadow: "0 0 6px rgba(34, 197, 94, 0.5)" }}
                  />
                  <div className="flex items-center gap-1.5 text-sm truncate" style={{ color: "var(--text-primary)" }}>
                    <User size={13} style={{ color: "var(--text-secondary)" }} />
                    <span className="truncate">{user.nickname}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t border-b" style={{ borderColor: "var(--border-color)" }}>
              <h2 className="text-xs font-semibold flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
                <Bot size={14} />
                AI 角色 ({prompts[0]?.characters?.length ?? 0})
              </h2>
            </div>
            <div className="p-3 space-y-2 overflow-y-auto">
              {(!prompts[0]?.characters || prompts[0].characters.length === 0) ? (
                <div className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  还没有角色。在 Builder 配置中添加。
                </div>
              ) : prompts[0].characters.map((character) => (
                <div
                  key={character.id}
                  className="rounded-lg p-3"
                  style={{ background: "rgba(255, 255, 255, 0.03)", border: "1px solid var(--border-color)" }}
                >
                  <div className="text-xs font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
                    {character.name}
                  </div>
                  <div className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    {character.persona.slice(0, 72)}{character.persona.length > 72 ? "..." : ""}
                  </div>
                </div>
              ))}
            </div>
            <div className="px-4 py-3 border-t" style={{ borderColor: "var(--border-color)" }}>
              <h2 className="text-xs font-semibold flex items-center gap-2 mb-2" style={{ color: "var(--text-secondary)" }}>
                <BookOpen size={14} />
                故事背景
              </h2>
              <p
                className="text-xs leading-relaxed"
                style={{
                  color: "var(--text-secondary)",
                  display: "-webkit-box",
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {prompts[0]?.worldSetting || "在 Builder 配置中填写。"}
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function TaskTextarea({
  label,
  value,
  rows = 3,
  onChange,
}: {
  label: string;
  value: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  return (
    <label className="block mb-2 last:mb-0">
      <span className="block text-xs mb-1" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="w-full resize-none rounded-lg px-3 py-2 text-sm leading-relaxed overflow-hidden"
        style={{
          background: "rgba(255, 255, 255, 0.03)",
          border: "1px solid var(--border-color)",
          color: "var(--text-primary)",
        }}
      />
    </label>
  );
}

function BuilderFullEditor({
  config,
  onUpdateTemplate,
  onUpdateVariable,
  onUpdateWorldSetting,
  onAddCharacter,
  onUpdateCharacter,
  onRemoveCharacter,
}: {
  config: PromptConfig;
  onUpdateTemplate: (value: string) => void;
  onUpdateVariable: (field: "chat" | "mention" | "proactive" | "outputFormat" | "dialogueRules", value: string) => void;
  onUpdateWorldSetting: (value: string) => void;
  onAddCharacter: () => void;
  onUpdateCharacter: (charId: string, field: "name" | "persona", value: string) => void;
  onRemoveCharacter: (charId: string) => void;
}) {
  const color = PROMPT_COLORS[config.id] ?? PROMPT_COLORS["prompt-a"];
  const vc = config.variableConfig ?? { taskDescriptions: { chat: "", mention: "", proactive: "" }, outputFormat: "", dialogueRules: "" };
  const chars = config.characters ?? [];

  return (
    <div
      className="rounded-lg border p-4 flex flex-col gap-4"
      style={{ background: "var(--bg-primary)", borderColor: color.border }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: color.text }}>
          {config.label}
        </h2>
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
          {config.template.length} 字
        </span>
      </div>

      {/* 故事背景 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
            故事背景 · {"{{storyBackground}}"}
          </h3>
          <span className="text-xs" style={{ color: (config.worldSetting ?? "").length > 5000 ? "var(--neon-magenta)" : "var(--text-secondary)" }}>
            {(config.worldSetting ?? "").length}/5000
          </span>
        </div>
        <textarea
          value={config.worldSetting ?? ""}
          onChange={(event) => onUpdateWorldSetting(event.target.value.slice(0, 5000))}
          rows={5}
          maxLength={5000}
          placeholder="描述你的世界观设定..."
          className="w-full resize-none rounded-lg px-3 py-2 text-sm leading-relaxed"
          style={{
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid var(--border-color)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {/* 角色列表 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
            角色列表 · {"{{roleName}} {{rolePersona}} {{otherCharacters}}"}
          </h3>
          <button
            onClick={onAddCharacter}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-all hover:opacity-80"
            style={{
              background: "rgba(0, 240, 255, 0.1)",
              color: "var(--neon-cyan)",
              border: "1px solid rgba(0, 240, 255, 0.2)",
            }}
          >
            <Plus size={12} />
            添加
          </button>
        </div>
        {chars.length === 0 ? (
          <div className="text-xs rounded-lg px-3 py-3 text-center" style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-secondary)" }}>
            还没有角色
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1">
            {chars.map((c) => (
              <div
                key={c.id}
                className="rounded-lg border p-1.5"
                style={{ background: "rgba(255, 255, 255, 0.02)", borderColor: "var(--border-color)" }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <input
                    value={c.name}
                    onChange={(event) => onUpdateCharacter(c.id, "name", event.target.value)}
                    placeholder="角色名"
                    className="flex-1 min-w-0 rounded-md px-2 py-1 text-sm font-medium"
                    style={{
                      background: "var(--bg-primary)",
                      border: "1px solid var(--border-color)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <button
                    onClick={() => onRemoveCharacter(c.id)}
                    className="flex items-center justify-center w-5 h-5 rounded-md transition-all hover:opacity-80"
                    style={{ background: "rgba(255, 45, 120, 0.08)", color: "var(--neon-magenta)" }}
                    title="删除"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
                <textarea
                  value={c.persona}
                  onChange={(event) => onUpdateCharacter(c.id, "persona", event.target.value)}
                  rows={2}
                  placeholder="人设描述..."
                  className="w-full resize-none rounded-md px-2 py-1 text-xs leading-relaxed"
                  style={{
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-color)",
                    color: "var(--text-primary)",
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 模板编辑 */}
      <div>
        <h3 className="text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>
          模板
        </h3>
        <textarea
          value={config.template}
          onChange={(event) => onUpdateTemplate(event.target.value)}
          rows={8}
          className="w-full resize-none rounded-lg px-3 py-2 text-sm leading-relaxed"
          style={{
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid var(--border-color)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {/* 变量配置 */}
      <div>
        <h3 className="text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>
          变量配置
        </h3>
        <div className="space-y-1.5">
          <TaskTextarea
            label="任务描述 · chat"
            value={vc.taskDescriptions.chat}
            rows={3}
            onChange={(v) => onUpdateVariable("chat", v)}
          />
          <TaskTextarea
            label="任务描述 · mention"
            value={vc.taskDescriptions.mention}
            rows={3}
            onChange={(v) => onUpdateVariable("mention", v)}
          />
          <TaskTextarea
            label="任务描述 · proactive"
            value={vc.taskDescriptions.proactive}
            rows={3}
            onChange={(v) => onUpdateVariable("proactive", v)}
          />
          <TaskTextarea
            label="输出格式 · {{outputFormat}}"
            value={vc.outputFormat}
            rows={3}
            onChange={(v) => onUpdateVariable("outputFormat", v)}
          />
          <TaskTextarea
            label="对话规则 · {{dialogueRules}}"
            value={vc.dialogueRules}
            rows={3}
            onChange={(v) => onUpdateVariable("dialogueRules", v)}
          />
        </div>
      </div>
    </div>
  );
}

function VariableHelp() {
  const variables = [
    "{{roleName}}",
    "{{rolePersona}}",
    "{{otherCharacters}}",
    "{{storyBackground}}",
    "{{taskDescription}}",
    "{{outputFormat}}",
    "{{dialogueRules}}",
    "{{recentMessages}}",
    "{{latestMessage}}",
    "{{trigger}}",
    "{{mentionedCharacters}}",
  ];

  return (
    <div
      className="mt-3 rounded-lg border px-3 py-2"
      style={{ background: "rgba(255, 255, 255, 0.03)", borderColor: "var(--border-color)" }}
    >
      <div className="text-xs font-semibold mb-2" style={{ color: "var(--text-secondary)" }}>
        Builder 可用变量
      </div>
      <div className="flex flex-wrap gap-1.5">
        {variables.map((item) => (
          <code
            key={item}
            className="text-xs px-2 py-1 rounded"
            style={{ background: "var(--bg-primary)", color: "var(--neon-cyan)", border: "1px solid var(--border-color)" }}
          >
            {item}
          </code>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isSystem = message.senderNickname === "系统";
  const color = message.builderId ? PROMPT_COLORS[message.builderId] : null;
  const time = new Date(message.timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="text-xs px-3 py-1.5 rounded-full"
          style={{ background: "rgba(255, 255, 255, 0.03)", color: "var(--text-secondary)" }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <div
        className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold"
        style={{
          background: color?.bg ?? "rgba(0, 240, 255, 0.12)",
          color: color?.text ?? "var(--neon-cyan)",
          border: `1px solid ${color?.border ?? "rgba(0, 240, 255, 0.3)"}`,
        }}
      >
        {message.isAI ? "P" : message.senderNickname.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium" style={{ color: color?.text ?? "var(--text-primary)" }}>
            {message.senderNickname}
          </span>
          <span className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
            {time}
          </span>
        </div>
        <div
          className="inline-block max-w-[92%] rounded-xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words"
          style={{
            background: color?.bg ?? "rgba(255, 255, 255, 0.04)",
            borderLeft: `2px solid ${color?.text ?? "var(--neon-cyan)"}`,
            color: "var(--text-primary)",
          }}
        >
          {message.content}
        </div>
      </div>
    </div>
  );
}
