import { useState, useRef, useEffect, useCallback } from "react";
import { useTerminalStore, terminalRefs, workspaceTrees } from "../../store/terminalStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import type { TreeNode, LeafNode } from "../../types";
import s from "./PaneManager.module.css";

interface Props {
  onClose: () => void;
  onSwap: (id1: string, id2: string) => void;
}

function getPreviewLines(id: string, maxLines = 16): string[] {
  const ref = terminalRefs.get(id);
  if (!ref) return [];
  const buf = ref.term.buffer.active;
  const lines: string[] = [];
  const start = Math.max(0, buf.cursorY - maxLines);
  for (let i = start; i <= buf.cursorY; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  if (lines.length === 0) {
    for (let i = Math.max(0, buf.length - maxLines); i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
  }
  return lines;
}

function getTitle(id: string): string {
  const ref = terminalRefs.get(id);
  const title = useTerminalStore.getState().titles[id] || "";
  const dir = ref?.lastDir || ref?.cwd || "";
  if (title && !/\.exe/i.test(title)) {
    const match = title.match(/([A-Z]:\\[^\r\n]*)/i) || title.match(/(\/[^\r\n]*)/);
    if (match) {
      let p = match[1].trim();
      p = p.replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
      return p;
    }
  }
  if (dir) return dir.replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
  return "~";
}

function countLeafIndex(node: TreeNode, targetId: string, counter = { i: 0 }): number {
  if (node.type === "leaf") {
    counter.i++;
    return node.id === targetId ? counter.i : -1;
  }
  const left = countLeafIndex(node.first, targetId, counter);
  if (left > 0) return left;
  return countLeafIndex(node.second, targetId, counter);
}

function MiniTree({ node, root, focusedId, dragId, dropTarget, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, onClick }: {
  node: TreeNode;
  root: TreeNode;
  focusedId: string | null;
  dragId: string | null;
  dropTarget: string | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
  onClick: (id: string) => void;
}) {
  if (node.type === "leaf") {
    const preview = getPreviewLines(node.id);
    const title = getTitle(node.id);
    const isFocused = node.id === focusedId;
    const isDragging = node.id === dragId;
    const isDropTarget = node.id === dropTarget;
    const idx = countLeafIndex(root, node.id);

    return (
      <div
        className={`${s.card} ${isFocused ? s.cardFocused : ""} ${isDragging ? s.cardDragging : ""} ${isDropTarget ? s.cardDropTarget : ""}`}
        draggable
        onClick={() => onClick(node.id)}
        onDragStart={(e) => onDragStart(e, node.id)}
        onDragOver={(e) => onDragOver(e, node.id)}
        onDragLeave={onDragLeave}
        onDrop={(e) => onDrop(e, node.id)}
        onDragEnd={onDragEnd}
      >
        <div className={s.cardHeader}>
          <span className={s.cardIndex}>{idx}</span>
          <span className={s.cardTitle} title={title}>{title}</span>
        </div>
        <div className={s.preview}>
          {preview.map((line, j) => (
            <div key={j} className={s.previewLine}>{line || " "}</div>
          ))}
        </div>
      </div>
    );
  }

  const isH = node.direction === "horizontal";
  const pct1 = `${node.ratio * 100}%`;
  const pct2 = `${(1 - node.ratio) * 100}%`;

  return (
    <div className={s.splitContainer} style={{ flexDirection: isH ? "row" : "column" }}>
      <div style={{ flexBasis: pct1, flexGrow: 0, flexShrink: 0, display: "flex", minWidth: 0, minHeight: 0 }}>
        <MiniTree node={node.first} root={root} focusedId={focusedId} dragId={dragId} dropTarget={dropTarget}
          onDragStart={onDragStart} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onDragEnd={onDragEnd} onClick={onClick} />
      </div>
      <div className={isH ? s.splitGapH : s.splitGapV} />
      <div style={{ flexBasis: pct2, flexGrow: 0, flexShrink: 0, display: "flex", minWidth: 0, minHeight: 0 }}>
        <MiniTree node={node.second} root={root} focusedId={focusedId} dragId={dragId} dropTarget={dropTarget}
          onDragStart={onDragStart} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onDragEnd={onDragEnd} onClick={onClick} />
      </div>
    </div>
  );
}

export default function PaneManager({ onClose, onSwap }: Props) {
  const focusedId = useTerminalStore((st) => st.focusedTerminalId);
  const wsIdx = useWorkspaceStore((st) => st.activeWorkspaceIdx);
  const tree = workspaceTrees.get(wsIdx);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleClick = useCallback((id: string) => {
    useTerminalStore.getState().setFocusedTerminalId(id);
    terminalRefs.get(id)?.term.focus();
    onClose();
  }, [onClose]);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragId && id !== dragId) setDropTarget(id);
  }, [dragId]);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain");
    if (sourceId && sourceId !== targetId) {
      onSwap(sourceId, targetId);
    }
    setDragId(null);
    setDropTarget(null);
  }, [onSwap]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  if (!tree) return null;

  return (
    <div className={s.overlay} ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div className={s.container}>
        <div className={s.header}>
          <span className={s.title}>终端</span>
          <span className={s.hint}>拖拽交换</span>
          <button className={s.closeBtn} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
        <div className={s.treeWrapper}>
          <MiniTree
            node={tree}
            root={tree}
            focusedId={focusedId}
            dragId={dragId}
            dropTarget={dropTarget}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            onClick={handleClick}
          />
        </div>
      </div>
    </div>
  );
}
