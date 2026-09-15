import { useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../../store/settingsStore";
import { usePanelStore } from "../../store/panelStore";
import { THEMES, FONT_OPTIONS } from "../../constants/themes";
import { startWsServer, stopWsServer, wsServerStatus } from "../../hooks/useTauriIpc";
import type { CursorStyle, UiTheme } from "../../types";
import s from "./Pages.module.css";

export default function SettingsPage() {
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
  const showTerminals = usePanelStore((st) => st.showTerminals);

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

  return (
    <div className={s.page}>
      <div className={s.editor}>
        <h2>设置</h2>

        <label className={s.fieldLabel}>主题</label>
        <div className={s.themeCards}>
          {Object.entries(THEMES).map(([key, theme]) => (
            <div
              key={key}
              className={key === activeThemeKey ? s.themeCardActive : s.themeCard}
              onClick={() => setActiveThemeKey(key)}
            >
              <div
                className={s.themePreview}
                style={{ background: theme.background, color: theme.foreground }}
              >
                <span>
                  <span style={{ color: theme.green as string }}>$</span> ls{" "}
                  <span style={{ color: theme.cyan as string }}>src/</span>
                </span>
              </div>
              <div className={s.themeCardName}>{theme.name}</div>
            </div>
          ))}
        </div>

        <label className={s.fieldLabel}>字体</label>
        <div className={s.settingRow}>
          <label>字体系列</label>
          <select
            value={termFontFamily}
            onChange={(e) => setTermFontFamily(e.target.value)}
          >
            {FONT_OPTIONS.map((f) => {
              const name = f.split("'")[1] || f;
              return (
                <option key={f} value={f}>
                  {name}
                </option>
              );
            })}
          </select>
        </div>
        <div className={s.settingRow}>
          <label>字号</label>
          <input
            type="range"
            min={8}
            max={24}
            value={termFontSize}
            onChange={(e) => setTermFontSize(parseInt(e.target.value))}
          />
          <span className={s.val}>{termFontSize}px</span>
        </div>

        <label className={s.fieldLabel}>光标</label>
        <div className={s.settingRow}>
          <label>形状</label>
          <select
            value={termCursorStyle}
            onChange={(e) => setTermCursorStyle(e.target.value as CursorStyle)}
          >
            <option value="block">█ 块状</option>
            <option value="bar">▏ 竖线</option>
            <option value="underline">▁ 下划线</option>
          </select>
        </div>

        <label className={s.fieldLabel}>界面</label>
        <div className={s.settingRow}>
          <label>界面缩放</label>
          <input
            type="range"
            min={80}
            max={150}
            step={5}
            value={uiScale}
            onChange={(e) => setUiScale(parseInt(e.target.value))}
          />
          <span className={s.val}>{uiScale}%</span>
        </div>

        <label className={s.fieldLabel}>布局</label>
        <div className={s.settingRow}>
          <label>窗格缩放</label>
          <button
            className={splitResizeEnabled ? s.btnAccent : s.btn}
            onClick={() => setSplitResizeEnabled(!splitResizeEnabled)}
          >
            {splitResizeEnabled ? "已启用" : "已禁用"}
          </button>
        </div>

        <label className={s.fieldLabel}>远程访问</label>
        <div className={s.settingRow}>
          <label>移动端</label>
          <button
            className={wsRunning ? s.btnAccent : s.btn}
            onClick={toggleWsServer}
          >
            {wsRunning ? "停止服务器" : "启动服务器"}
          </button>
          <span
            className={s.val}
            style={{ minWidth: "auto", fontSize: 11, color: wsRunning ? "#2ecc71" : "var(--text-dim)" }}
          >
            {wsRunning ? "运行中" : "已停止"}
          </span>
        </div>
        {wsRunning && wsIps.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)" }}>
            在手机上打开此链接：
            {wsIps.map((ip) => {
              const isTs = ip.startsWith("100.");
              return (
                <div key={ip} style={{ marginTop: 4 }}>
                  <span style={{ opacity: 0.7 }}>{isTs ? "🌐 Tailscale（任意位置）" : "🏠 家庭网络（同一 Wi-Fi）"}</span>
                  <div className={s.wsUrlBox}>{`http://${ip}:9090`}</div>
                </div>
              );
            })}
          </div>
        )}

        <div className={s.actions}>
          <button className={s.btn} onClick={showTerminals}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
