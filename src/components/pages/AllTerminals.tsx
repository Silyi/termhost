import { useState, useEffect, useCallback, useRef } from "react";
import { usePanelStore } from "../../store/panelStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { listTerminals, killTerminal, spawnTerminal } from "../../hooks/useTauriIpc";
import { openExistingTerminal } from "../../store/openTerminal";
import s from "./Pages.module.css";

interface TermInfo {
  id: string;
  label: string;
  cwd: string;
  command: string;
  title: string;
  workspace: string;
  allowRemote: boolean;
}

function makeId(): string {
  return `term-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export default function AllTerminals() {
  const showTerminals = usePanelStore((st) => st.showTerminals);
  const setActiveView = usePanelStore((st) => st.setActiveView);
  const ensureWorkspaceTree = useRef<((idx: number) => void) | null>(null);
  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [spawning, setSpawning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listTerminals();
      setTerms(list);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("terminals-changed", () => refresh());
    })();
    return () => { unlisten?.(); };
  }, [refresh]);

  const handleNewTerminal = async () => {
    setSpawning(true);
    try {
      // Use home dir, default shell
      const id = makeId();
      await spawnTerminal(id, "", "", 80, 24);
      // Broadcast will trigger refresh
    } catch {}
    setSpawning(false);
  };

  const handleNewWorkspace = () => {
    const ws = useWorkspaceStore.getState();
    const colorIdx = ws.workspaces.length % 8;
    ws.addWorkspace({
      name: "Workspace",
      color: colorIdx,
      panes: [{ cwd: "", command: "" }],
    });
    setActiveView("workspace-editor");
  };

  return (
    <div className={s.page} style={{ justifyContent: "flex-start", padding: "24px 32px" }}>
      <div style={{ width: "100%", maxWidth: 800 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>All Terminals</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleNewTerminal} disabled={spawning}
              style={{ background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.25)", borderRadius: 6, padding: "6px 14px", color: "#4ade80", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
              {spawning ? "..." : "+ Terminal"}
            </button>
            <button onClick={handleNewWorkspace}
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 14px", color: "#fff", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
              + Workspace
            </button>
            <button onClick={showTerminals}
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 14px", color: "#fff", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
              Split View
            </button>
          </div>
        </div>

        {terms.length === 0 ? (
          <div style={{ fontSize: 13, opacity: 0.4, textAlign: "center", marginTop: 60 }}>
            没有正在运行的终端。用 <strong>+ 新建终端</strong> 建一个，或在手机上建。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {terms.map((t) => (
              <div key={t.id}
                onClick={() => openExistingTerminal(t.id)}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                title="点击在布局中打开这个终端"
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", cursor: "pointer" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{t.cwd}</div>
                </div>
                <div style={{ fontSize: 10, opacity: 0.25, fontFamily: "monospace" }}>{t.command || "powershell"}</div>
                <button onClick={async (e) => { e.stopPropagation(); await killTerminal(t.id); refresh(); }}
                  style={{ background: "rgba(224,80,80,0.1)", border: "1px solid rgba(224,80,80,0.2)", borderRadius: 4, padding: "3px 10px", color: "#e05050", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                  Kill
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
