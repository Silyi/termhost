import { useState, useEffect, useCallback, useRef } from "react";
import { useSettingsStore } from "../../store/settingsStore";
import { usePanelStore } from "../../store/panelStore";
import { THEMES, FONT_OPTIONS } from "../../constants/themes";
import { startWsServer, stopWsServer, wsServerStatus, writeFile, readFile, getHomeDir, daemonStatus, shutdownDaemon, restartDaemon, listTerminals, killTerminal } from "../../hooks/useTauriIpc";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useFileViewerStore } from "../../store/fileViewerStore";
import type { CursorStyle, UiTheme, Workspace } from "../../types";
import s from "./Panels.module.css";

interface TerminalEntry {
  id: string;
  label: string;
  cwd: string;
  command: string;
  title: string;
  workspace: string;
}

type DaemonMode = "daemon" | "direct" | "unknown";

export default function SettingsPanel({ embedded }: { embedded?: boolean } = {}) {
  const uiTheme = useSettingsStore((st) => st.uiTheme);
  const activeThemeKey = useSettingsStore((st) => st.activeThemeKey);
  const termFontSize = useSettingsStore((st) => st.termFontSize);
  const termFontFamily = useSettingsStore((st) => st.termFontFamily);
  const termCursorStyle = useSettingsStore((st) => st.termCursorStyle);
  const uiScale = useSettingsStore((st) => st.uiScale);

  const setUiTheme = useSettingsStore((st) => st.setUiTheme);
  const setActiveThemeKey = useSettingsStore((st) => st.setActiveThemeKey);
  const setTermFontSize = useSettingsStore((st) => st.setTermFontSize);
  const setTermFontFamily = useSettingsStore((st) => st.setTermFontFamily);
  const setTermCursorStyle = useSettingsStore((st) => st.setTermCursorStyle);
  const setUiScale = useSettingsStore((st) => st.setUiScale);
  const splitResizeEnabled = useSettingsStore((st) => st.splitResizeEnabled);
  const setSplitResizeEnabled = useSettingsStore((st) => st.setSplitResizeEnabled);
  const toggleSettings = usePanelStore((st) => st.toggleSettings);

  const [daemonMode, setDaemonMode] = useState<DaemonMode>("unknown");
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [daemonTerminalCount, setDaemonTerminalCount] = useState(0);
  const [daemonTerminals, setDaemonTerminals] = useState<TerminalEntry[]>([]);
  const [confirmKillAll, setConfirmKillAll] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [protocolMismatch, setProtocolMismatch] = useState(false);
  const timerRef = useRef<number>(0);

  const pollDaemon = useCallback(async () => {
    try {
      const st = await daemonStatus();
      setDaemonMode("daemon");
      setDaemonConnected(st.connected);
      setDaemonTerminalCount(st.terminalCount);
      setProtocolMismatch(!!st.protocolMismatch);
    } catch {
      setDaemonMode("direct");
      setDaemonConnected(false);
      setDaemonTerminalCount(0);
    }
  }, []);

  useEffect(() => {
    pollDaemon();
    timerRef.current = window.setInterval(pollDaemon, 5000);
    return () => clearInterval(timerRef.current);
  }, [pollDaemon]);

  const handleDaemonRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await restartDaemon();
      await pollDaemon();
    } catch { /* stays disconnected */ }
    setRestarting(false);
  }, [pollDaemon]);

  const handleDaemonShutdown = useCallback(async () => {
    await shutdownDaemon().catch(() => {});
    setDaemonConnected(false);
    setDaemonTerminalCount(0);
    setDaemonTerminals([]);
  }, []);

  const openDaemonMenu = useCallback(async () => {
    listTerminals()
      .then(setDaemonTerminals)
      .catch(() => setDaemonTerminals([]));
  }, []);

  const handleKillTerminal = useCallback(async (id: string) => {
    await killTerminal(id).catch(() => {});
    setDaemonTerminals((prev) => prev.filter((t) => t.id !== id));
    setDaemonTerminalCount((prev) => Math.max(0, prev - 1));
  }, []);

  const handleKillAll = useCallback(async () => {
    if (!confirmKillAll) {
      setConfirmKillAll(true);
      return;
    }
    for (const t of daemonTerminals) {
      await killTerminal(t.id).catch(() => {});
    }
    setDaemonTerminals([]);
    setDaemonTerminalCount(0);
    setConfirmKillAll(false);
  }, [confirmKillAll, daemonTerminals]);

  function terminalDisplayName(t: TerminalEntry): { name: string; detail: string } {
    const detail = t.cwd ? t.cwd.replace(/\\/g, "/") : "";
    if (t.command) {
      const cmd = t.command.split(/\s+/)[0];
      const base = cmd.includes("/") || cmd.includes("\\")
        ? cmd.split(/[/\\]/).pop()!
        : cmd;
      return { name: base, detail };
    }
    return { name: "PowerShell", detail };
  }

  const grouped = new Map<string, TerminalEntry[]>();
  for (const t of daemonTerminals) {
    const ws = t.workspace || "无工作区";
    if (!grouped.has(ws)) grouped.set(ws, []);
    grouped.get(ws)!.push(t);
  }

  const dotColor = daemonMode === "direct" ? "#f39c12" : daemonConnected ? "#2ecc71" : "#e74c3c";

  const [wsRunning, setWsRunning] = useState(false);
  const [wsIps, setWsIps] = useState<string[]>([]);

  const refreshWsStatus = useCallback(async () => {
    try {
      const status = await wsServerStatus();
      setWsRunning(status.running);
      const ips = status.ips && status.ips.length ? status.ips : status.ip ? [status.ip] : [];
      setWsIps(ips);
    } catch {
      setWsRunning(false);
    }
  }, []);

  useEffect(() => {
    refreshWsStatus();
  }, [refreshWsStatus]);

  const toggleWsServer = useCallback(async () => {
    try {
      if (wsRunning) {
        await stopWsServer();
      } else {
        await startWsServer(9090);
      }
    } catch (e) {
      console.error("WS toggle error:", e);
    }
    refreshWsStatus();
  }, [wsRunning, refreshWsStatus]);

  const [wsExportMsg, setWsExportMsg] = useState("");

  const exportWorkspaces = useCallback(async () => {
    try {
      const home = await getHomeDir();
      const path = `${home}\\agentworkspace-workspaces.json`;
      const data = JSON.stringify(useWorkspaceStore.getState().workspaces, null, 2);
      await writeFile(path, data);
      setWsExportMsg(`已导出到 ${path}`);
      useFileViewerStore.getState().openFile(path);
    } catch (e) {
      setWsExportMsg(`导出失败：${e}`);
    }
  }, []);

  const importWorkspaces = useCallback(async () => {
    try {
      const home = await getHomeDir();
      const path = `${home}\\agentworkspace-workspaces.json`;
      const raw = await readFile(path);
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error("格式无效");
      const valid: Workspace[] = arr.filter((w) => w && typeof w.name === "string" && Array.isArray(w.panes));
      if (valid.length === 0) throw new Error("文件中没有有效的工作区");
      const st = useWorkspaceStore.getState();
      useWorkspaceStore.setState({ workspaces: [...st.workspaces, ...valid] });
      useWorkspaceStore.getState().saveWorkspaces();
      setWsExportMsg(`已从 ${path} 导入 ${valid.length} 个工作区`);
    } catch (e) {
      setWsExportMsg(`导入失败：${e}`);
    }
  }, []);

  const body = (
    <>
      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>主题</p>
        <div className={s.settingsThemes}>
          {Object.entries(THEMES).map(([key, theme]) => (
            <div
              key={key}
              className={key === activeThemeKey ? s.settingsThemeCardActive : s.settingsThemeCard}
              onClick={() => setActiveThemeKey(key)}
            >
              <div
                className={s.settingsThemePreview}
                style={{ background: theme.background, color: theme.foreground }}
              >
                <span style={{ color: theme.green as string }}>$</span> ls{" "}
                <span style={{ color: theme.cyan as string }}>src/</span>
              </div>
              <div className={s.settingsThemeName}>{theme.name}</div>
            </div>
          ))}
        </div>
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>字体</p>
        <div className={s.settingsRow}>
          <label>字体系列</label>
          <select value={termFontFamily} onChange={(e) => setTermFontFamily(e.target.value)}>
            {FONT_OPTIONS.map((f) => (
              <option key={f} value={f}>{f.split("'")[1] || f}</option>
            ))}
          </select>
        </div>
        <div className={s.settingsRow}>
          <label>字号</label>
          <input type="range" min={8} max={24} value={termFontSize} onChange={(e) => setTermFontSize(parseInt(e.target.value))} />
          <span className={s.settingsVal}>{termFontSize}px</span>
        </div>
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>光标</p>
        <div className={s.settingsRow}>
          <label>形状</label>
          <select value={termCursorStyle} onChange={(e) => setTermCursorStyle(e.target.value as CursorStyle)}>
            <option value="block">块状</option>
            <option value="bar">竖线</option>
            <option value="underline">下划线</option>
          </select>
        </div>
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>界面</p>
        <div className={s.settingsRow}>
          <label>界面缩放</label>
          <input type="range" min={80} max={150} step={5} value={uiScale} onChange={(e) => setUiScale(parseInt(e.target.value))} />
          <span className={s.settingsVal}>{uiScale}%</span>
        </div>
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>布局</p>
        <div className={s.settingsRow}>
          <label>窗格缩放</label>
          <button
            className={splitResizeEnabled ? s.settingsBtnActive : s.settingsBtn}
            onClick={() => setSplitResizeEnabled(!splitResizeEnabled)}
          >
            {splitResizeEnabled ? "已启用" : "已禁用"}
          </button>
        </div>
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>守护进程</p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--text-main)" }}>
            {daemonMode === "direct" ? "直连模式" : daemonConnected ? `已连接（${daemonTerminalCount} 个终端）` : "未连接"}
          </span>
        </div>

        {protocolMismatch && daemonConnected && (
          <div style={{ fontSize: 11, color: "#e5a50a", marginBottom: 8, lineHeight: 1.4 }}>
            守护进程版本过旧（协议不匹配）。请先关闭守护进程，再重新启动以更新。
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          {!daemonConnected && daemonMode !== "direct" && (
            <button className={s.settingsBtn} onClick={handleDaemonRestart} disabled={restarting}>
              {restarting ? "重启中…" : "重启"}
            </button>
          )}
          {daemonConnected && (
            <button className={s.settingsBtn} onClick={handleDaemonShutdown}>关闭</button>
          )}
          {daemonTerminals.length > 0 && (
            <button
              className={s.settingsBtn}
              style={confirmKillAll ? { borderColor: "#e74c3c", color: "#e74c3c" } : undefined}
              onClick={handleKillAll}
            >
              {confirmKillAll ? "确认全部终止？" : "全部终止"}
            </button>
          )}
        </div>

        {daemonConnected && (
          <button className={s.settingsBtn} onClick={openDaemonMenu} style={{ marginBottom: 8 }}>
            列出终端
          </button>
        )}

        {daemonTerminals.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            {[...grouped.entries()].map(([wsName, items], gi) => (
              <div key={wsName}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", color: "var(--text-dim)", fontSize: 11, fontWeight: 600, borderTop: gi > 0 ? "1px solid var(--border)" : "none", marginTop: gi > 0 ? 8 : 0, paddingTop: gi > 0 ? 8 : 0 }}>
                  <span>{wsName}</span>
                  <span style={{ fontSize: 10, opacity: 0.6 }}>{items.length}</span>
                </div>
                {items.map((t) => {
                  const { name, detail } = terminalDisplayName(t);
                  return (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0 3px 8px" }}>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-main)" }}>{name}</span>
                      {detail && <span style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{detail}</span>}
                      <button
                        style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: "2px 4px", borderRadius: 3, fontSize: 11, flexShrink: 0 }}
                        onClick={() => handleKillTerminal(t.id)}
                        title="终止终端"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>远程访问</p>
        <div className={s.settingsRow}>
          <label>移动端</label>
          <button
            className={wsRunning ? s.settingsBtnActive : s.settingsBtn}
            onClick={toggleWsServer}
          >
            {wsRunning ? "停止" : "启动"}
          </button>
          <span
            className={s.settingsVal}
            style={{ color: wsRunning ? "#2ecc71" : "var(--text-dim)" }}
          >
            {wsRunning ? "开" : "关"}
          </span>
        </div>
        {wsRunning && wsIps.length > 0 && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
            在手机上打开：
            {wsIps.map((ip) => {
              const isTs = ip.startsWith("100.");
              const url = `http://${ip}:9090`;
              return (
                <div key={ip} style={{ marginTop: 2 }}>
                  <span style={{ opacity: 0.7 }}>{isTs ? "🌐 Tailscale" : "🏠 家庭网络（局域网）"}</span>
                  <div className={s.settingsWsUrl}>{url}</div>
                  {isTs && (
                    <button
                      className={s.settingsBtn}
                      style={{ fontSize: 10, padding: "2px 8px", marginTop: 2 }}
                      onClick={() => navigator.clipboard.writeText(url)}
                    >
                      复制链接
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={s.settingsSection}>
        <p className={s.settingsLabel}>工作区</p>
        <div className={s.settingsRow}>
          <label>备份</label>
          <button className={s.settingsBtn} onClick={exportWorkspaces}>导出</button>
          <button className={s.settingsBtn} onClick={importWorkspaces}>导入</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
          {wsExportMsg || "JSON 文件存放在主目录中（agentworkspace-workspaces.json）"}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return <div className={s.settingsBody}>{body}</div>;
  }

  return (
    <div className={s.settingsPanel}>
      <div className={s.settingsHeader}>
        <span className={s.settingsTitle}>设置</span>
        <button className={s.headerBtn} onClick={toggleSettings}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </div>
      <div className={s.settingsBody}>{body}</div>
    </div>
  );
}
