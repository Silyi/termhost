import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
import { usePanelStore } from "../../store/panelStore";
import {
  getPendingPairs, pairApprove, pairReject,
  wsServerStatus, stopWsServer,
  listDevices, revokeDevice, renameDevice, updateDeviceNote,
  setAutoApprove, getAutoApprove,
  setSleepConfig, getSleepConfig,
  listTerminals, setTerminalRemote,
} from "../../hooks/useTauriIpc";
import type { DeviceInfo } from "../../hooks/useTauriIpc";
import s from "./Pages.module.css";

const SLEEP_TIMEOUTS: { label: string; never: boolean; minutes: number }[] = [
  { label: "永不关闭", never: true, minutes: 0 },
  { label: "闲置 30 分钟后关闭", never: false, minutes: 30 },
  { label: "闲置 1 小时后关闭", never: false, minutes: 60 },
  { label: "闲置 2 小时后关闭", never: false, minutes: 120 },
  { label: "闲置 4 小时后关闭", never: false, minutes: 240 },
  { label: "闲置 24 小时后关闭", never: false, minutes: 1440 },
];

function DeviceRow({ device, onUpdate }: { device: DeviceInfo; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(device.label);
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(device.note);

  const save = async () => {
    if (label.trim() && label !== device.label) {
      await renameDevice(device.token, label.trim()).catch(() => {});
      onUpdate();
    }
    setEditing(false);
  };

  const saveNote = async () => {
    if (note !== device.note) {
      await updateDeviceNote(device.token, note).catch(() => {});
      onUpdate();
    }
    setEditingNote(false);
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return null;
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const days = Math.floor(hr / 24);
    return `${days} 天前`;
  };

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <div style={{ width: 10, height: 10, borderRadius: "50%", marginTop: 3, flexShrink: 0, background: device.online ? "#4ade80" : "#444" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setLabel(device.label); setEditing(false); } }}
            autoFocus style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, padding: "2px 6px", fontSize: 13, color: "#fff", outline: "none", width: "100%", boxSizing: "border-box" }} />
        ) : (
          <div style={{ opacity: 0.9, cursor: "pointer", fontWeight: 500, fontSize: 13 }} onClick={() => { setLabel(device.label); setEditing(true); }} title="点击重命名">
            {device.label}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, opacity: 0.4, fontSize: 11, marginTop: 2, flexWrap: "wrap" }}>
          {device.deviceType && <span>{device.deviceType}</span>}
          {device.online ? <span style={{ color: "#4ade80", opacity: 1 }}>在线</span> : formatTime(device.lastSeen) && <span>离线 · 最后在线 {formatTime(device.lastSeen)}</span>}
          <span>{new Date(device.approvedAt).toLocaleDateString()}</span>
        </div>
        {editingNote ? (
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              onBlur={saveNote} onKeyDown={(e) => { if (e.key === "Enter") saveNote(); if (e.key === "Escape") { setNote(device.note); setEditingNote(false); } }}
              autoFocus placeholder="添加备注…"
              style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "#ccc", outline: "none" }} />
          </div>
        ) : note ? (
          <div style={{ opacity: 0.5, fontSize: 11, marginTop: 3, cursor: "pointer" }} onClick={() => { setNote(note); setEditingNote(true); }}>{note}</div>
        ) : (
          <div style={{ opacity: 0.25, fontSize: 11, marginTop: 3, cursor: "pointer", fontStyle: "italic" }} onClick={() => { setNote(""); setEditingNote(true); }}>添加备注…</div>
        )}
      </div>
      <button onClick={async () => { await revokeDevice(device.token); onUpdate(); }}
        style={{ background: "none", border: "none", color: "#e05050", cursor: "pointer", fontSize: 12, opacity: 0.6, padding: "2px 8px", flexShrink: 0 }}>
        撤销
      </button>
    </div>
  );
}

export default function PairingPage() {
  const showTerminals = usePanelStore((st) => st.showTerminals);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [pendingPairs, setPendingPairs] = useState<{ deviceId: string; code: string }[]>([]);
  const [terminals, setTerminals] = useState<any[]>([]);
  const [wsIps, setWsIps] = useState<string[]>([]);
  const [wsPort, setWsPort] = useState(0);
  const [wsRunning, setWsRunning] = useState(false);
  const [autoApprove, setAutoApproveState] = useState(false);
  const [sleepNever, setSleepNever] = useState(true);
  const [sleepTimeout, setSleepTimeout] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<number>(0);

  useEffect(() => {
    poll();
    timerRef.current = window.setInterval(poll, 3000);
    return () => window.clearInterval(timerRef.current);
  }, []);

  const poll = async () => {
    try {
      const [pairs, devs, terms, aa, sleepCfg] = await Promise.all([
        getPendingPairs().catch(() => []),
        listDevices().catch(() => [] as DeviceInfo[]),
        listTerminals().catch(() => []),
        getAutoApprove().catch(() => false),
        getSleepConfig().catch(() => ({ never: true, timeoutMinutes: 0 })),
      ]);
      setPendingPairs(pairs);
      setDevices(devs);
      setTerminals(terms);
      setAutoApproveState(aa);
      setSleepNever(sleepCfg.never);
      setSleepTimeout(sleepCfg.timeoutMinutes);
    } catch {}
    try {
      const status = await wsServerStatus();
      setWsIps(status.ips || []);
      setWsPort(status.port);
      setWsRunning(status.running);
    } catch {}
  };

  useEffect(() => {
    if (!canvasRef.current || wsIps.length === 0) return;
    const url = `http://${wsIps[0]}:${wsPort}/`;
    QRCode.toCanvas(canvasRef.current, url, { width: 160, margin: 2 }, () => {});
  }, [wsIps, wsPort]);

  const toggleAutoApprove = async () => {
    const next = !autoApprove;
    setAutoApproveState(next);
    await setAutoApprove(next).catch(() => poll());
  };

  const handleStopTunnel = async () => {
    await stopWsServer().catch(() => {});
    poll();
  };

  const toggleTerminalRemote = async (id: string, allowed: boolean) => {
    await setTerminalRemote(id, allowed).catch(() => {});
    poll();
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.8px", opacity: 0.5, marginBottom: 10,
  };

  return (
    <div className={s.page} style={{ justifyContent: "flex-start", padding: "24px 32px" }}>
      <div style={{ width: "100%", maxWidth: 800 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>配对与远程访问</h2>
          <button onClick={showTerminals}
            style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 14px", color: "#fff", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
            返回终端
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
          {/* QR + URL */}
          <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 16 }}>
            <div style={sectionTitle}>扫描二维码或打开链接</div>
            {wsIps.length > 0 && wsPort > 0 ? (
              <>
                <canvas ref={canvasRef} style={{ borderRadius: 8, display: "block" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, opacity: 0.6, fontFamily: "monospace" }}>
                  <span>http://{wsIps[0]}:{wsPort}/</span>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.4 }}>正在启动服务器…</div>
            )}
          </div>

          {/* One-Time Code */}
          <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 16 }}>
            <div style={sectionTitle}>一次性验证码</div>
            {pendingPairs.length > 0 ? pendingPairs.map((p) => (
              <div key={p.deviceId} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", letterSpacing: 6, marginBottom: 8 }}>{p.code}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input id={`label-${p.deviceId}`} defaultValue="手机" placeholder="设备名称"
                    style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "4px 8px", fontSize: 12, color: "#fff", outline: "none" }} />
                  <button onClick={() => { const inp = document.getElementById(`label-${p.deviceId}`) as HTMLInputElement; pairApprove(p.deviceId, inp?.value || "手机").then(poll); }}
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, padding: "4px 12px", color: "#fff", cursor: "pointer", fontSize: 12 }}>允许</button>
                  <button onClick={() => pairReject(p.deviceId).then(poll)}
                    style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "4px 12px", color: "#e05050", cursor: "pointer", fontSize: 12 }}>拒绝</button>
                </div>
              </div>
            )) : (
              <div style={{ fontSize: 12, opacity: 0.4 }}>没有待处理的请求</div>
            )}
          </div>
        </div>

        {/* Settings row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
          {/* Auto-approve */}
          <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 16 }}>
            <div style={sectionTitle}>自动允许</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, opacity: 0.6 }}>自动允许新设备</span>
              <div onClick={toggleAutoApprove} style={{ width: 36, height: 20, borderRadius: 10, cursor: "pointer", position: "relative", background: autoApprove ? "#4ade80" : "rgba(255,255,255,0.15)", transition: "background 0.2s" }}>
                <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: autoApprove ? 18 : 2, transition: "left 0.2s" }} />
              </div>
            </div>
            <div style={{ fontSize: 11, opacity: 0.35, marginTop: 4 }}>
              {autoApprove ? "新设备无需手动允许即可连接" : "新设备需要手动允许"}
            </div>
            {wsRunning && (
              <button onClick={handleStopTunnel} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", marginTop: 12, background: "rgba(224,80,80,0.1)", border: "1px solid rgba(224,80,80,0.25)", borderRadius: 6, color: "#e05050", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                停止隧道
              </button>
            )}
          </div>

          {/* Prevent Sleep */}
          <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 16 }}>
            <div style={sectionTitle}>防止休眠</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {SLEEP_TIMEOUTS.map((opt) => {
                const active = opt.never ? sleepNever : (!sleepNever && sleepTimeout === opt.minutes);
                return (
                  <div key={opt.label} onClick={() => { setSleepNever(opt.never); setSleepTimeout(opt.minutes); setSleepConfig(opt.never, opt.minutes).catch(() => poll()); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 4, cursor: "pointer", fontSize: 12, background: active ? "rgba(255,255,255,0.06)" : "transparent", color: active ? "#fff" : "rgba(255,255,255,0.5)" }}>
                    <div style={{ width: 14, height: 14, borderRadius: "50%", flexShrink: 0, border: active ? "4px solid #4ade80" : "2px solid rgba(255,255,255,0.2)", transition: "all 0.15s" }} />
                    {opt.label}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Terminal selection */}
        <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 16, marginBottom: 24 }}>
          <div style={{ ...sectionTitle, marginBottom: 6 }}>共享终端</div>
          <div style={{ fontSize: 11, opacity: 0.35, marginBottom: 12 }}>
            选择哪些终端对远程（移动端）客户端可见
          </div>
          {terminals.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.4 }}>没有正在运行的终端</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {terminals.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: 4, cursor: "pointer" }}
                  onClick={() => toggleTerminalRemote(t.id, !t.allowRemote)}>
                  <div style={{ width: 20, height: 20, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", background: t.allowRemote ? "#4ade80" : "rgba(255,255,255,0.1)", color: t.allowRemote ? "#000" : "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: 700, flexShrink: 0, transition: "background 0.15s" }}>
                    {t.allowRemote ? "✓" : ""}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</div>
                    <div style={{ fontSize: 10, opacity: 0.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.cwd}</div>
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.3, fontFamily: "monospace" }}>{t.id.slice(0, 12)}…</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Clients */}
        <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 16 }}>
          <div style={{ ...sectionTitle, marginBottom: 6 }}>客户端（{devices.length}）</div>
          {devices.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.4 }}>尚未配对任何设备</div>
          ) : (
            <div>{devices.map((d) => <DeviceRow key={d.token} device={d} onUpdate={poll} />)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
