import { useState, useRef, useEffect, useCallback } from "react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { usePanelStore } from "../../store/panelStore";
import VoiceInput from "./VoiceInput";
import s from "./Titlebar.module.css";

interface Props {
  onSwitchWorkspace: (idx: number) => void;
  onNewWorkspace: () => void;
  onDeleteWorkspace: (idx: number) => void;
}

export default function Titlebar({ onSwitchWorkspace, onNewWorkspace, onDeleteWorkspace }: Props) {
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const activeIdx = useWorkspaceStore((st) => st.activeWorkspaceIdx);
  const updateWorkspace = useWorkspaceStore((st) => st.updateWorkspace);
  const explorerOpen = usePanelStore((st) => st.explorerOpen);
  const toggleExplorer = usePanelStore((st) => st.toggleExplorer);
  const setActiveView = usePanelStore((st) => st.setActiveView);
  const activeView = usePanelStore((st) => st.activeView);

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingIdx !== null && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingIdx]);

  const startEditing = useCallback((idx: number, name: string) => {
    setEditingIdx(idx);
    setEditValue(name);
  }, []);

  const saveEditing = useCallback(() => {
    if (editingIdx !== null) {
      const name = editValue.trim() || "工作区";
      if (name !== workspaces[editingIdx]?.name) {
        updateWorkspace(editingIdx, { name });
      }
      setEditingIdx(null);
    }
  }, [editingIdx, editValue, workspaces, updateWorkspace]);

  const cancelEditing = useCallback(() => {
    setEditingIdx(null);
  }, []);

  useEffect(() => {
    const handler = () => {
      const idx = useWorkspaceStore.getState().activeWorkspaceIdx;
      const ws = useWorkspaceStore.getState().workspaces[idx];
      if (ws) startEditing(idx, ws.name);
    };
    window.addEventListener("agentworkspace:edit-workspace", handler);
    return () => window.removeEventListener("agentworkspace:edit-workspace", handler);
  }, [startEditing]);

  return (
    <div className={s.titlebar}>
      <button
        className={`${s.homeBtn} ${activeView === "dashboard" ? s.homeBtnActive : ""}`}
        onClick={() => setActiveView("dashboard")}
        title="主页"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
        </svg>
        <span>主页</span>
      </button>
      <div className={s.tabs}>
        {workspaces.map((ws, idx) => {
          const isActive = idx === activeIdx;
          const isEditing = editingIdx === idx;
          return (
            <div
              key={idx}
              className={`${s.tab} ${isActive ? s.tabActive : ""} ${isEditing ? s.tabEditing : ""}`}
              onClick={() => { if (!isEditing) onSwitchWorkspace(idx); }}
            >
              {isEditing ? (
                <input
                  ref={inputRef}
                  className={s.tabInput}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEditing();
                    if (e.key === "Escape") cancelEditing();
                  }}
                  onBlur={saveEditing}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className={s.tabName}
                  onDoubleClick={() => startEditing(idx, ws.name)}
                >
                  {ws.name}
                </span>
              )}
              {!isEditing && (
                <button
                  className={s.tabClose}
                  title="关闭工作区"
                  onClick={(e) => { e.stopPropagation(); onDeleteWorkspace(idx); }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        <button className={s.newTab} onClick={onNewWorkspace} title="新建工作区 (Ctrl+Shift+T)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 2v8M2 6h8" />
          </svg>
          <span>新建</span>
        </button>
      </div>
      <div className={s.drag} data-tauri-drag-region />
      <div className={s.right}>
        <button
          className={`${s.btn} ${activeView === "all-terminals" ? s.btnActive : ""}`}
          onClick={() => setActiveView("all-terminals")}
          title="所有终端"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span>终端</span>
        </button>
        <VoiceInput />
        <button
          className={`${s.btn} ${explorerOpen ? s.btnActive : ""}`}
          title="侧边面板 (Ctrl+B)"
          onClick={() => toggleExplorer(usePanelStore.getState().explorerTab)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          <span>面板</span>
        </button>
      </div>
    </div>
  );
}
