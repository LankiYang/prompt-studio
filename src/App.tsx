import { useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import JoinPage from "@/pages/JoinPage";
import RoomPage from "@/pages/RoomPage";
import ConfigPage from "@/pages/ConfigPage";
import MemoryEvalPage from "@/pages/MemoryEvalPage";
import StudioPage from "@/pages/StudioPage";

const workspaceTitles: Record<string, string> = {
  overview: "项目概览",
  debugger: "Prompt 调试器",
  prompts: "Prompt 版本",
  assets: "共享资源",
  evaluations: "评测与结果",
  reviews: "版本评审",
  team: "团队与权限",
  recycle: "回收站",
};

function PageTitle() {
  const location = useLocation();
  useEffect(() => {
    const routeTitle = location.pathname === "/join" ? "进入多人聊天"
      : location.pathname === "/room" ? "多人聊天房"
        : location.pathname === "/config" ? "角色与世界观配置"
          : location.pathname === "/memory" ? "记忆系统评测"
            : workspaceTitles[new URLSearchParams(location.search).get("view") ?? "overview"] ?? "项目概览";
    document.title = `${routeTitle} · Prompt Studio`;
  }, [location.pathname, location.search]);
  return null;
}

export default function App() {
  return (
    <Router>
      <PageTitle />
      <Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/room" element={<RoomPage />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/memory" element={<MemoryEvalPage />} />
        <Route path="/workspace" element={<StudioPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}
