import { useCallback, useRef, type ReactNode } from "react";
import { usePanelStore, type ExplorerTab } from "../../store/panelStore";
import { useFileViewerStore } from "../../store/fileViewerStore";
import FilesContent from "./FilesContent";
import SettingsPanel from "./SettingsPanel";
import GitPanel from "./GitPanel";
import PairingPanel from "./PairingPanel";
import FileViewer from "../fileviewer/FileViewer";
import s from "./Panels.module.css";

function renderTabContent(tab: ExplorerTab): ReactNode {
  switch (tab) {
    case "files": return <FilesContent />;
    case "preview": return <FileViewer />;
    case "git": return <GitPanel embedded />;
    case "pairing": return <PairingPanel embedded />;
    case "settings": return <SettingsPanel embedded />;
  }
}

const TABS: { key: ExplorerTab; label: string; icon: string }[] = [
  {
    key: "files",
    label: "文件",
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  },
  {
    key: "preview",
    label: "预览",
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  },
  {
    key: "git",
    label: "Git",
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 7l7.5 4M8 17l7.5-4"/></svg>',
  },
  {
    key: "pairing",
    label: "配对",
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
  },
  {
    key: "settings",
    label: "设置",
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  },
];

export default function ExplorerPanel() {
  const explorerTab = usePanelStore((st) => st.explorerTab);
  const secondaryTab = usePanelStore((st) => st.secondaryTab);
  const splitRatio = usePanelStore((st) => st.splitRatio);
  const explorerWidth = usePanelStore((st) => st.explorerWidth);
  const setExplorerWidth = usePanelStore((st) => st.setExplorerWidth);
  const openExplorer = usePanelStore((st) => st.openExplorer);
  const openSecondary = usePanelStore((st) => st.openSecondary);
  const closeSecondary = usePanelStore((st) => st.closeSecondary);
  const setSplitRatio = usePanelStore((st) => st.setSplitRatio);
  const fileTabs = useFileViewerStore((st) => st.fileTabs);
  const dragRef = useRef(false);
  const splitDragRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = true;
    const startX = e.clientX;
    const startW = usePanelStore.getState().explorerWidth;

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = startX - ev.clientX;
      const newW = Math.max(200, Math.min(800, startW + delta));
      setExplorerWidth(newW);
    };
    const onUp = () => {
      dragRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [setExplorerWidth]);

  const handleSplitDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDragRef.current = true;
    const container = contentRef.current;
    if (!container) return;

    const onMove = (ev: MouseEvent) => {
      if (!splitDragRef.current || !container) return;
      const rect = container.getBoundingClientRect();
      const ratio = Math.max(0.15, Math.min(0.85, (ev.clientX - rect.left) / rect.width));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      splitDragRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [setSplitRatio]);

  const handleTabClick = useCallback((key: ExplorerTab, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (key === explorerTab) return;
      if (secondaryTab === key) {
        closeSecondary();
      } else {
        openSecondary(key);
      }
    } else {
      openExplorer(key);
    }
  }, [explorerTab, secondaryTab, openExplorer, openSecondary, closeSecondary]);

  const isSplit = secondaryTab !== null;

  return (
    <div className={s.explorerPanel} style={{ width: explorerWidth }}>
      <div className={s.explorerResize} onMouseDown={handleResizeStart} />
      <div className={s.explorerTabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${s.explorerTab} ${explorerTab === t.key || secondaryTab === t.key ? s.explorerTabActive : ""}`}
            onClick={(e) => handleTabClick(t.key, e)}
            title={`${t.label} (Ctrl+点击可拆分)`}
          >
            <span dangerouslySetInnerHTML={{ __html: t.icon }} />
            <span className={s.explorerTabLabel}>{t.label}</span>
            {t.key === "preview" && fileTabs.length > 0 && (
              <span className={s.explorerBadge}>{fileTabs.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className={s.explorerContent} ref={contentRef} style={isSplit ? { flexDirection: "row" } : undefined}>
        {isSplit ? (
          <>
            <div className={s.explorerSplitPane} style={{ width: `calc(${splitRatio * 100}% - 2px)` }}>
              {renderTabContent(explorerTab)}
            </div>
            <div className={s.explorerSplitDivider} onMouseDown={handleSplitDragStart} />
            <div className={s.explorerSplitPane} style={{ width: `calc(${(1 - splitRatio) * 100}% - 2px)` }}>
              {renderTabContent(secondaryTab)}
            </div>
          </>
        ) : (
          renderTabContent(explorerTab)
        )}
      </div>
    </div>
  );
}
