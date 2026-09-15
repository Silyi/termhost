import { useState, useRef, useEffect, useCallback } from "react";
import { terminalRefs } from "../../store/terminalStore";
import s from "./Terminal.module.css";

interface Props {
  terminalId: string;
  onClose: () => void;
}

export default function SearchBar({ terminalId, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const disposeRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();

    const addon = terminalRefs.get(terminalId)?.searchAddon;
    if (addon && "onDidChangeResults" in addon) {
      disposeRef.current = (addon as any).onDidChangeResults(
        (e: { resultIndex: number; resultCount: number }) => {
          setResultIndex(e.resultIndex);
          setResultCount(e.resultCount);
        }
      );
    }

    return () => {
      disposeRef.current?.dispose();
      addon?.clearDecorations();
    };
  }, [terminalId]);

  const getAddon = useCallback(() => {
    return terminalRefs.get(terminalId)?.searchAddon;
  }, [terminalId]);

  const searchOpts = {
    regex: false,
    caseSensitive: false,
    decorations: {
      matchOverviewRuler: "#888",
      activeMatchColorOverviewRuler: "#e94560",
      activeMatchBackground: "#e9456044",
      matchBackground: "#ffffff22",
    },
  };

  const findNext = useCallback(() => {
    const addon = getAddon();
    if (!addon || !query) return;
    addon.findNext(query, searchOpts);
  }, [query, getAddon]);

  const findPrev = useCallback(() => {
    const addon = getAddon();
    if (!addon || !query) return;
    addon.findPrevious(query, searchOpts);
  }, [query, getAddon]);

  const handleClose = useCallback(() => {
    getAddon()?.clearDecorations();
    onClose();
    terminalRefs.get(terminalId)?.term.focus();
  }, [getAddon, terminalId, onClose]);

  useEffect(() => {
    const addon = getAddon();
    if (query) {
      addon?.findNext(query, { ...searchOpts, incremental: true });
    } else {
      addon?.clearDecorations();
      setResultIndex(-1);
      setResultCount(0);
    }
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) findPrev();
        else findNext();
      }
    },
    [handleClose, findNext, findPrev]
  );

  const matchLabel =
    query && resultCount > 0
      ? `${resultIndex + 1}/${resultCount}`
      : query
        ? "0/0"
        : "";

  return (
    <div className={s.searchBar}>
      <svg
        className={s.searchIcon}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        className={s.searchInput}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="搜索…"
        spellCheck={false}
      />
      {matchLabel && <span className={s.searchCount}>{matchLabel}</span>}
      <button
        className={s.searchBtn}
        onClick={findPrev}
        title="上一个 (Shift+Enter)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        className={s.searchBtn}
        onClick={findNext}
        title="下一个 (Enter)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button
        className={s.searchBtn}
        onClick={handleClose}
        title="关闭 (Escape)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
