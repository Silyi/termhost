import { useCallback, useRef, useState, useEffect } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import PaneHeader from "./PaneHeader";
import TerminalInstance from "./TerminalInstance";
import SearchBar from "./SearchBar";
import s from "./Terminal.module.css";

type DropZone = "left" | "right" | "top" | "bottom" | "center" | null;

interface Props {
  id: string;
  cwd?: string;
  command?: string;
  isSinglePane: boolean;
  leafCount: number;
  paneIndex: number;
  onSplit: (id: string, direction: "horizontal" | "vertical") => void;
  onClose: (id: string) => void;
  onRotate: (id: string) => void;
  onSwapWithDirection: (sourceId: string, targetId: string, zone: "left" | "right" | "top" | "bottom" | "center") => void;
}

function getDropZone(e: React.DragEvent, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const edgeThreshold = 0.3;

  if (x < edgeThreshold) return "left";
  if (x > 1 - edgeThreshold) return "right";
  if (y < edgeThreshold) return "top";
  if (y > 1 - edgeThreshold) return "bottom";
  return "center";
}

export default function TerminalPane({ id, cwd, command, isSinglePane, leafCount, paneIndex, onSplit, onClose, onRotate, onSwapWithDirection }: Props) {
  const isFocused = useTerminalStore((st) => st.focusedTerminalId === id);
  const isZoomed = useTerminalStore((st) => st.zoomedTerminalId === id);
  const rearrangeMode = useTerminalStore((st) => st.rearrangeMode);
  const toggleZoom = useTerminalStore((st) => st.toggleZoom);
  const setFocused = useTerminalStore((st) => st.setFocusedTerminalId);
  const paneRef = useRef<HTMLDivElement>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone>(null);

  const handleFocus = useCallback(() => {
    setFocused(id);
    paneRef.current?.classList.remove("has-activity");
  }, [id, setFocused]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === id) setShowSearch(true);
    };
    window.addEventListener("agentworkspace:terminal-search", handler);
    return () => window.removeEventListener("agentworkspace:terminal-search", handler);
  }, [id]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-pane-id", id);
  }, [id]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!rearrangeMode) return;
    if (!e.dataTransfer.types.includes("application/x-pane-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (paneRef.current) {
      setDropZone(getDropZone(e, paneRef.current));
    }
  }, [rearrangeMode]);

  const handleDragLeave = useCallback(() => {
    setDropZone(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const zone = paneRef.current ? getDropZone(e, paneRef.current) : "center";
    setDropZone(null);
    const sourceId = e.dataTransfer.getData("application/x-pane-id");
    if (sourceId && sourceId !== id) {
      onSwapWithDirection(sourceId, id, zone as "left" | "right" | "top" | "bottom" | "center");
    }
  }, [id, onSwapWithDirection]);

  const zoneClass = dropZone ? s[`dropZone_${dropZone}`] : "";

  return (
    <div
      ref={paneRef}
      className={`${s.pane} ${isFocused ? s.focused : ""} ${isSinglePane ? s.singlePane : ""}`}
      data-pane-id={id}
      data-pane-focused={isFocused ? "true" : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PaneHeader
        id={id}
        cwd={cwd}
        isZoomed={isZoomed}
        isSinglePane={isSinglePane}
        leafCount={leafCount}
        onSplitH={() => onSplit(id, "horizontal")}
        onSplitV={() => onSplit(id, "vertical")}
        onRotate={() => onRotate(id)}
        onZoom={() => toggleZoom(id)}
        onClose={() => onClose(id)}
      />
      {showSearch && (
        <SearchBar terminalId={id} onClose={() => setShowSearch(false)} />
      )}
      {rearrangeMode && (
        <div
          className={`${s.rearrangeOverlay} ${zoneClass}`}
          draggable
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dropZone && dropZone !== "center" ? (
            <>
              <div className={s.splitPreview} style={
                dropZone === "left" ? { inset: "6px auto 6px 6px", width: "calc(50% - 9px)" } :
                dropZone === "right" ? { inset: "6px 6px 6px auto", width: "calc(50% - 9px)" } :
                dropZone === "top" ? { inset: "6px 6px auto 6px", height: "calc(50% - 9px)" } :
                { inset: "auto 6px 6px 6px", height: "calc(50% - 9px)" }
              }>
                <span className={s.splitPreviewLabel}>放这里</span>
              </div>
              <div className={s.splitPreview} style={{
                ...(dropZone === "left" ? { inset: "6px 6px 6px auto", width: "calc(50% - 9px)" } :
                  dropZone === "right" ? { inset: "6px auto 6px 6px", width: "calc(50% - 9px)" } :
                  dropZone === "top" ? { inset: "auto 6px 6px 6px", height: "calc(50% - 9px)" } :
                  { inset: "6px 6px auto 6px", height: "calc(50% - 9px)" }),
                background: "rgba(255, 255, 255, 0.04)",
                border: "2px dashed rgba(255, 255, 255, 0.15)",
              }}>
                <span className={s.rearrangeIndex} style={{ fontSize: 24, width: 44, height: 44 }}>{paneIndex}</span>
              </div>
            </>
          ) : dropZone === "center" ? (
            <>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(100,200,255,0.8)" strokeWidth="2" strokeLinecap="round">
                <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              <span className={s.rearrangeHint} style={{ color: "rgba(100,200,255,0.7)" }}>交换</span>
            </>
          ) : (
            <>
              <span className={s.rearrangeIndex}>{paneIndex}</span>
              <span className={s.rearrangeHint}>拖拽重新排列</span>
            </>
          )}
        </div>
      )}
      <TerminalInstance
        id={id}
        cwd={cwd}
        command={command}
        onFocus={handleFocus}
      />
    </div>
  );
}
