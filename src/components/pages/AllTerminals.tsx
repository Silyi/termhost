import { useState, useEffect, useCallback, useRef } from "react";
import { usePanelStore } from "../../store/panelStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { listTerminals, killTerminal, spawnTerminal, popoutTerminal, resizeTerminal } from "../../hooks/useTauriIpc";
import { openExistingTerminal, detachTerminalFromLayout } from "../../store/openTerminal";
import { terminalRefs } from "../../store/terminalStore";
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
  // 两个错误分开放：refresh 每 3 秒成功一次，若共用一个槽位，它会把
  // 「新建终端失败」的提示顺手清掉 —— 提示只闪一下，等于没说。
  const [listError, setListError] = useState<string | null>(null);
  // 用户主动操作的失败（新建 / 弹出）走这个槽位
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listTerminals();
      setTerms(list);
      setListError(null);
    } catch (e) {
      // 不能静默：列表读不出来时界面会一直显示旧数据，看起来像「没反应」。
      setListError(`读取终端列表失败：${String(e)}`);
    }
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
    setActionError(null);
    try {
      // Use home dir, default shell
      const id = makeId();
      await spawnTerminal(id, "", "", 80, 24);

      // 必须把它接进布局。只 spawn 不挂载会留下一个**游离终端**：它不在任何
      // 工作区里，既不会被存档引用、也没有任何回收路径，而 pty-host 不随 app
      // 退出而结束 —— 于是每建一个就永久多攒一个，用户看到的就是
      // 「每轮启动比上轮多 1 个」。
      openExistingTerminal(id);

      // 接进来走的是「附着」路径（hasTerminal 为真 → 画快照），那条路刻意
      // 不 re-fit（见 TerminalInstance 里 393-398 的说明）。这里补一次实测
      // 尺寸，免得新终端停在 spawn 时的 80×24。窗格挂载是异步的
      // （setup 里还有 await），所以轮询几拍等 ref 出现。
      let tries = 0;
      const syncSize = () => {
        const ref = terminalRefs.get(id);
        if (!ref) {
          if (tries++ < 20) window.setTimeout(syncSize, 100);
          return;
        }
        ref.fitAddon.fit();
        if (ref.term.cols > 0 && ref.term.rows > 0) {
          resizeTerminal(id, ref.term.cols, ref.term.rows).catch(() => {});
        }
      };
      window.setTimeout(syncSize, 100);
    } catch (e) {
      // 这里曾经是个空 catch。代价很大：pty-host 被关掉后 spawn 必然失败，
      // 而界面不给任何信号，于是「点击无反应」既看不出原因也查不到线索。
      setActionError(`新建终端失败：${String(e)}`);
      console.error("[新建终端] spawn failed:", e);
    }
    setSpawning(false);
  };

  const handleNewWorkspace = () => {
    const ws = useWorkspaceStore.getState();
    const colorIdx = ws.workspaces.length % 8;
    ws.addWorkspace({
      name: "工作区",
      color: colorIdx,
      panes: [{ cwd: "", command: "" }],
    });
    setActiveView("workspace-editor");
  };

  return (
    <div className={s.page} style={{ justifyContent: "flex-start", padding: "24px 32px" }}>
      <div style={{ width: "100%", maxWidth: 800 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>所有终端</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleNewTerminal} disabled={spawning}
              style={{ background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.25)", borderRadius: 6, padding: "6px 14px", color: "#4ade80", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
              {spawning ? "..." : "+ 新建终端"}
            </button>
            <button onClick={handleNewWorkspace}
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 14px", color: "#fff", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
              + 新建工作区
            </button>
            <button onClick={showTerminals}
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 14px", color: "#fff", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
              拆分视图
            </button>
          </div>
        </div>

        {actionError && (
          <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 6, background: "rgba(224,80,80,0.1)", border: "1px solid rgba(224,80,80,0.25)", color: "#e05050", fontSize: 12, lineHeight: 1.5 }}>
            {actionError}
          </div>
        )}

        {listError && (
          <div style={{ marginBottom: 16, padding: "10px 12px", borderRadius: 6, background: "rgba(224,80,80,0.1)", border: "1px solid rgba(224,80,80,0.25)", color: "#e05050", fontSize: 12, lineHeight: 1.5 }}>
            {listError}
          </div>
        )}

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
                <button onClick={async (e) => {
                  e.stopPropagation();
                  setActionError(null);
                  try {
                    await popoutTerminal(t.id);
                    // 成功才移出窗格（终端本身继续跑，只是不在布局里了）。
                    // 这一行同时会清掉存档里的窗格 id —— 否则下次启动会把它拉回来。
                    detachTerminalFromLayout(t.id);
                  } catch (err) {
                    setActionError(`弹出终端失败：${String(err)}`);
                  }
                }}
                  title="在一个独立的控制台窗口里打开这个终端（会把它从布局里移出，终端继续运行）"
                  style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, padding: "3px 10px", color: "#fff", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                  弹出
                </button>
                <button onClick={async (e) => {
                  e.stopPropagation();
                  setActionError(null);
                  try {
                    await killTerminal(t.id);
                    // 光杀 daemon 里的终端不够：布局里若还有它的窗格，窗格一重新
                    // 挂载就会按同一个 id 再 spawn 一个 —— 看起来就是「终止没用，
                    // 刷新一下又回来了」。
                    detachTerminalFromLayout(t.id);
                    refresh();
                  } catch (err) {
                    setActionError(`终止终端失败：${String(err)}`);
                  }
                }}
                  style={{ background: "rgba(224,80,80,0.1)", border: "1px solid rgba(224,80,80,0.2)", borderRadius: 4, padding: "3px 10px", color: "#e05050", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                  终止
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
