import { useState, useEffect, useCallback } from "react";
import { runGit } from "../../hooks/useTauriIpc";
import { terminalRefs, useTerminalStore } from "../../store/terminalStore";
import { useFileBrowserStore } from "../../store/fileBrowserStore";
import s from "./Panels.module.css";

interface StatusEntry {
  xy: string;
  path: string;
}

function statusLabel(xy: string): { label: string; color: string } {
  const c = xy.trim()[0] || "?";
  switch (c) {
    case "M": return { label: "M", color: "#e5a50a" };
    case "A": return { label: "A", color: "#2ecc71" };
    case "D": return { label: "D", color: "#e94560" };
    case "R": return { label: "R", color: "#3498db" };
    case "?": return { label: "U", color: "#9b59b6" };
    default: return { label: c, color: "var(--text-dim)" };
  }
}

function guessCwd(): string {
  const id = useTerminalStore.getState().focusedTerminalId;
  if (id) {
    const ref = terminalRefs.get(id);
    const dir = ref?.lastDir || ref?.cwd;
    if (dir) return dir;
  }
  return useFileBrowserStore.getState().currentBrowsePath || "";
}

export default function GitPanel({ embedded: _embedded }: { embedded?: boolean } = {}) {
  const [cwd, setCwd] = useState("");
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState<StatusEntry[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (dir?: string) => {
    const target = (dir ?? guessCwd()).trim();
    if (!target) return;
    setCwd(target);
    setLoading(true);
    setError("");
    try {
      const br = await runGit(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
      setBranch(br.trim());
      const st = await runGit(target, ["status", "--porcelain"]);
      setStatus(
        st.split("\n").filter(Boolean).map((line) => ({
          xy: line.slice(0, 2),
          path: line.slice(3).trim(),
        }))
      );
      const lg = await runGit(target, ["log", "--oneline", "-25"]);
      setLog(lg.split("\n").filter(Boolean));
    } catch (e) {
      setBranch("");
      setStatus([]);
      setLog([]);
      setError(String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const showDiff = useCallback(async (entry: StatusEntry) => {
    if (diffFile === entry.path) {
      setDiff(null);
      setDiffFile(null);
      return;
    }
    try {
      let d: string;
      if (entry.xy.startsWith("??")) {
        d = "（未跟踪的文件）";
      } else if (entry.xy[0] !== " " && entry.xy[1] === " ") {
        d = await runGit(cwd, ["diff", "--cached", "--", entry.path]);
      } else {
        d = await runGit(cwd, ["diff", "--", entry.path]);
      }
      setDiff(d || "（无更改）");
      setDiffFile(entry.path);
    } catch (e) {
      setDiff(String(e));
      setDiffFile(entry.path);
    }
  }, [cwd, diffFile]);

  const diffLineColor = (line: string): string => {
    if (line.startsWith("+") && !line.startsWith("+++")) return "#2ecc71";
    if (line.startsWith("-") && !line.startsWith("---")) return "#e94560";
    if (line.startsWith("@@")) return "#3498db";
    if (line.startsWith("diff ") || line.startsWith("index ")) return "var(--text-dim)";
    return "var(--text)";
  };

  return (
    <div className={s.settingsWrap}>
      <div className={s.settingsScroll}>
        <div className={s.mcpToolbar}>
          <span className={s.mcpToolbarTitle}>
            Git{branch ? ` · ${branch}` : ""}
          </span>
          <button className={s.mcpRefreshBtn} onClick={() => refresh()} disabled={loading} title="刷新（使用当前窗格的目录）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? s.mcpSpin : ""}>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
        </div>

        <div style={{ padding: "0 10px 6px", display: "flex", gap: 6 }}>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") refresh(cwd); }}
            placeholder="仓库路径…"
            spellCheck={false}
            style={{
              flex: 1, padding: "4px 8px", fontSize: 11, fontFamily: "monospace",
              background: "#0f0f0f", border: "1px solid #333", borderRadius: 4, color: "var(--text)",
            }}
          />
        </div>

        {error && (
          <div style={{ padding: "4px 10px", fontSize: 11, color: "#e94560", whiteSpace: "pre-wrap" }}>
            {error.includes("not a git repository") ? "不是 Git 仓库" : error}
          </div>
        )}

        {!error && (
          <>
            <div style={{ padding: "2px 10px", fontSize: 11, color: "var(--text-dim)" }}>
              更改 {status.length > 0 ? `(${status.length})` : ""}
            </div>
            {status.length === 0 && !loading && (
              <div style={{ padding: "2px 10px 8px", fontSize: 11, color: "var(--text-dim)", opacity: 0.6 }}>
                工作树干净
              </div>
            )}
            {status.map((entry) => {
              const st = statusLabel(entry.xy);
              const active = diffFile === entry.path;
              return (
                <div key={entry.path}>
                  <div
                    onClick={() => showDiff(entry)}
                    title="点击切换差异"
                    style={{
                      display: "flex", gap: 8, alignItems: "center", padding: "3px 10px",
                      cursor: "pointer", fontSize: 12, fontFamily: "monospace",
                      background: active ? "rgba(255,255,255,0.05)" : "transparent",
                    }}
                  >
                    <span style={{ color: st.color, width: 12, fontWeight: 700 }}>{st.label}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.path}</span>
                  </div>
                  {active && diff && (
                    <pre
                      style={{
                        margin: "2px 10px 8px", padding: 8, fontSize: 11, lineHeight: 1.45,
                        background: "#0f0f0f", border: "1px solid #222", borderRadius: 4,
                        overflowX: "auto", maxHeight: 320, overflowY: "auto",
                      }}
                    >
                      {diff.split("\n").map((line, i) => (
                        <div key={i} style={{ color: diffLineColor(line) }}>{line || " "}</div>
                      ))}
                    </pre>
                  )}
                </div>
              );
            })}

            <div style={{ padding: "10px 10px 2px", fontSize: 11, color: "var(--text-dim)" }}>
              最近提交
            </div>
            {log.map((line) => {
              const [hash, ...rest] = line.split(" ");
              return (
                <div
                  key={hash}
                  style={{
                    display: "flex", gap: 8, padding: "2px 10px", fontSize: 11,
                    fontFamily: "monospace", alignItems: "baseline",
                  }}
                >
                  <span style={{ color: "#e5a50a", flexShrink: 0 }}>{hash}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                    {rest.join(" ")}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
