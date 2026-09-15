import { useState, useRef, useEffect } from "react";
import { useTerminalStore, terminalRefs } from "../../store/terminalStore";
import { useFileViewerStore } from "../../store/fileViewerStore";
import { getHomeDir, writeFile } from "../../hooks/useTauriIpc";
import s from "./Terminal.module.css";

interface Props {
  id: string;
  cwd?: string;
  isZoomed: boolean;
  isSinglePane: boolean;
  leafCount: number;
  onSplitH: () => void;
  onSplitV: () => void;
  onRotate: (id: string) => void;
  onZoom: () => void;
  onClose: () => void;
}

function getDir(title: string, fallbackCwd?: string) {
  const shorten = (p: string) => {
    let r = p.replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
    const sep = r.includes("/") ? "/" : "\\";
    const parts = r.split(sep).filter(Boolean);
    if (parts.length > 3) {
      r = "…" + sep + parts.slice(-2).join(sep);
    }
    return r;
  };
  if (title) {
    if (/\.exe/i.test(title)) {
      // exe path — ignore, use fallback
    } else {
      const match = title.match(/([A-Z]:\\[^\r\n]*)/i) || title.match(/(\/[^\r\n]*)/);
      if (match) return shorten(match[1].trim());
    }
  }
  if (fallbackCwd) return shorten(fallbackCwd);
  return "~";
}

function btn(handler: () => void) {
  return {
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); handler(); },
    onMouseDown: (e: React.MouseEvent) => { e.stopPropagation(); },
  };
}

function Dropdown({ items, onClose }: { items: { label: string; icon: React.ReactNode; action: () => void }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return (
    <div ref={ref} className={s.dropdown}>
      {items.map((item, i) => (
        <button key={i} className={s.dropdownItem} onClick={(e) => { e.stopPropagation(); item.action(); onClose(); }} onMouseDown={(e) => e.stopPropagation()}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

const ICON_TWO_COLS = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="6" height="14" rx="1.5" />
    <rect x="9" y="1" width="6" height="14" rx="1.5" />
  </svg>
);
const ICON_TWO_ROWS = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="14" height="6" rx="1.5" />
    <rect x="1" y="9" width="14" height="6" rx="1.5" />
  </svg>
);

export default function PaneHeader({ id, cwd, isZoomed, isSinglePane, leafCount, onSplitH, onSplitV, onZoom, onClose }: Props) {
  const title = useTerminalStore((st) => st.titles[id] || "");
  const rearrangeMode = useTerminalStore((st) => st.rearrangeMode);
  const toggleRearrange = useTerminalStore((st) => st.toggleRearrangeMode);
  const lastDir = terminalRefs.get(id)?.lastDir;
  const fullPath = title || lastDir || cwd || "";
  const dir = getDir(title, lastDir || cwd);
  const [showAdd, setShowAdd] = useState(false);

  const exportLog = async () => {
    const ref = terminalRefs.get(id);
    if (!ref) return;
    const buf = ref.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      // Join wrapped lines back into one logical line
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += line.translateToString(true);
      } else {
        lines.push(line.translateToString(true));
      }
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const home = await getHomeDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = `${home}\\terminal-log-${stamp}.txt`;
    await writeFile(path, lines.join("\n"));
    useFileViewerStore.getState().openFile(path);
  };

  return (
    <div className={s.header} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <span className={s.paneLabel} title={fullPath}>{dir}</span>
      <div className={s.actions}>
        {/* Add terminal */}
        {!isZoomed && (
          <div style={{ position: "relative" }}>
            <button className={s.action} title="新建终端" onClick={(e) => { e.stopPropagation(); setShowAdd(!showAdd); }} onMouseDown={(e) => e.stopPropagation()}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
            {showAdd && (
              <Dropdown
                onClose={() => setShowAdd(false)}
                items={[
                  { label: "向右拆分", icon: ICON_TWO_COLS, action: onSplitH },
                  { label: "向下拆分", icon: ICON_TWO_ROWS, action: onSplitV },
                ]}
              />
            )}
          </div>
        )}

        {/* Rearrange mode toggle */}
        {!isSinglePane && !isZoomed && (
          <button
            className={`${s.action} ${rearrangeMode ? s.actionActive : ""}`}
            title="重新排列 (Ctrl+Shift+R)"
            {...btn(toggleRearrange)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="1" width="14" height="14" rx="1.5" />
              <line x1="8" y1="1" x2="8" y2="15" />
              <line x1="1" y1="8" x2="8" y2="8" />
            </svg>
          </button>
        )}

        {/* Expand / Collapse */}
        {!isSinglePane && (
          <button className={s.action} title={isZoomed ? "折叠 (Ctrl+Shift+M)" : "展开 (Ctrl+Shift+M)"} {...btn(onZoom)}>
            {isZoomed ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 6 10 6 10 1" />
                <line x1="15" y1="1" x2="9" y2="7" />
                <polyline points="1 10 6 10 6 15" />
                <line x1="1" y1="15" x2="7" y2="9" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="10 1 15 1 15 6" />
                <line x1="15" y1="1" x2="9" y2="7" />
                <polyline points="6 15 1 15 1 10" />
                <line x1="1" y1="15" x2="7" y2="9" />
              </svg>
            )}
          </button>
        )}

        {/* Export session log */}
        <button className={s.action} title="导出会话日志" {...btn(() => { exportLog().catch(() => {}); })}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v8M5 7l3 3 3-3" />
            <path d="M2 12v2h12v-2" />
          </svg>
        </button>

        {/* Close */}
        <button className={`${s.action} ${s.actionClose}`} title="关闭 (Ctrl+W)" {...btn(onClose)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
