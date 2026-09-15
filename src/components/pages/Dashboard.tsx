import { useState, useEffect, useRef, type ReactNode } from "react";
import { usePanelStore } from "../../store/panelStore";
import { wsServerStatus, listDevices } from "../../hooks/useTauriIpc";
import FilesContent from "../panels/FilesContent";
import FileViewer from "../fileviewer/FileViewer";
import GitPanel from "../panels/GitPanel";
import SettingsPanel from "../panels/SettingsPanel";
import PairingFull from "./PairingPage";

interface TabDef {
  key: string;
  label: string;
  desc: string;
  icon: ReactNode;
  render: () => ReactNode;
}

const S16M = ({ children }: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

const TABS: TabDef[] = [
  { key: "files", label: "文件", desc: "文件浏览与预览", icon: <S16M><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></S16M>, render: () => (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      <div style={{ width: "45%", minWidth: 260, borderRight: "1px solid rgba(255,255,255,0.06)", overflow: "auto" }}>
        <FilesContent />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <FileViewer />
      </div>
    </div>
  ) },
  { key: "git", label: "Git", desc: "Git 状态与差异", icon: <S16M><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 7l7.5 4M8 17l7.5-4"/></S16M>, render: () => <GitPanel embedded /> },
];

// Pairing and Settings are rendered by renderTab(), not listed in TABS, so the
// status bar needs their labels here instead of falling back to the raw key.
const TAB_LABELS: Record<string, string> = { pairing: "配对", settings: "设置" };

function renderTab(key: string): ReactNode {
  if (key === "pairing") return <PairingFull />;
  if (key === "settings") return <SettingsPanel embedded />;
  const tab = TABS.find((t) => t.key === key);
  return tab?.render() ?? <FilesContent />;
}

function Hamburger() {
  return <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="5" x2="15" y2="5"/><line x1="3" y1="9" x2="15" y2="9"/><line x1="3" y1="13" x2="15" y2="13"/></svg>;
}
function LeftArrow() {
  return <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="12 4 6 9 12 14"/></svg>;
}
function RightArrow() {
  return <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 4 12 9 6 14"/></svg>;
}

export default function Dashboard() {
  const showTerminals = usePanelStore((st) => st.showTerminals);
  const [activeTab, setActiveTab] = useState("files");
  const [sidebarMode, setSidebarMode] = useState(0); // 0=hidden, 1=icon-only(44px), 2=expanded(~140px)

  const [deviceCount, setDeviceCount] = useState(0);
  const [onlineCount, setOnlineCount] = useState(0);
  const [wsIps, setWsIps] = useState<string[]>([]);
  const [wsPort, setWsPort] = useState(0);
  const [wsRunning, setWsRunning] = useState(false);

  useEffect(() => {
    const poll = async () => {
      try {
        const [devs, status] = await Promise.all([
          listDevices().catch(() => []),
          wsServerStatus().catch(() => ({ running: false, ip: "", port: 0, ips: [] })),
        ]);
        setDeviceCount(devs.length);
        setOnlineCount(devs.filter((d: any) => d.online).length);
        setWsIps(status.ips || []);
        setWsPort(status.port);
        setWsRunning(status.running);
      } catch {}
    };
    poll();
    const t = window.setInterval(poll, 5000);
    return () => window.clearInterval(t);
  }, []);

  const SIDEBAR_W = [0, 44, 140][sidebarMode];
  const showLabel = sidebarMode >= 2;

  const cycleMode = () => setSidebarMode((sidebarMode + 1) % 3);

  const navBtn = (active: boolean): React.CSSProperties => ({
    width: "100%", minHeight: 40, display: "flex", alignItems: "center", gap: 8,
    padding: showLabel ? "0 10px" : "0", justifyContent: showLabel ? "flex-start" : "center",
    background: active ? (sidebarMode === 1 ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.06)") : "transparent",
    border: "none", color: active ? "#fff" : "rgba(255,255,255,0.35)", cursor: "pointer",
    fontSize: 12, fontFamily: "inherit", textAlign: "left" as const, whiteSpace: "nowrap",
    borderLeft: active ? "2px solid #e94560" : "2px solid transparent",
    transition: "background 0.1s",
  });

  const toggleIcon = sidebarMode === 0 ? <Hamburger /> : sidebarMode === 1 ? <LeftArrow /> : <RightArrow />;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
      {/* Left sidebar */}
      {sidebarMode > 0 && (
        <div style={{ width: SIDEBAR_W, display: "flex", flexDirection: "column", flexShrink: 0, borderRight: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)", overflow: "hidden", transition: "width 0.15s" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, padding: "4px 0", overflowY: "auto" }}>
            {TABS.map((t) => (
              <button key={t.key} style={navBtn(activeTab === t.key)} onClick={() => setActiveTab(t.key)} title={t.label}>
                <span style={{ flexShrink: 0 }}>{t.icon}</span>
                {showLabel && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</span>}
              </button>
            ))}
            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 8px" }} />
            <button style={navBtn(activeTab === "settings")} onClick={() => setActiveTab("settings")} title="设置">
              <S16M><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></S16M>
              {showLabel && <span>设置</span>}
            </button>
            <button style={navBtn(activeTab === "pairing")} onClick={() => setActiveTab("pairing")} title="配对">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              {showLabel && <span>配对</span>}
            </button>
          </div>
          <button onClick={showTerminals} title="终端"
            style={{ ...navBtn(false), borderTop: "1px solid rgba(255,255,255,0.06)", minHeight: 36, justifyContent: showLabel ? "flex-start" : "center", padding: showLabel ? "0 10px" : "0" }}>
            <S16M><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></S16M>
            {showLabel && <span>终端</span>}
          </button>
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Status bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 36, flexShrink: 0, padding: "0 10px", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 11 }}>
          <button onClick={cycleMode}
            style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", flexShrink: 0 }}>
            {toggleIcon}
          </button>
          <span style={{ fontWeight: 600, opacity: 0.85, flexShrink: 0 }}>{TABS.find(t => t.key === activeTab)?.label || TAB_LABELS[activeTab] || activeTab}</span>
          {wsRunning && (
            <>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", flexShrink: 0 }} />
              <span style={{ opacity: 0.45, flexShrink: 0 }}>{wsIps[0]}:{wsPort}</span>
              <span style={{ opacity: 0.3, flexShrink: 0 }}>{onlineCount}/{deviceCount} 在线</span>
            </>
          )}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {renderTab(activeTab)}
        </div>
      </div>
    </div>
  );
}
