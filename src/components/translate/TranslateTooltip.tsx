import { useState, useEffect, useCallback, useRef } from "react";
import { translateText, detectLang } from "../../hooks/useTranslate";
import { terminalRefs } from "../../store/terminalStore";
import { useTerminalStore } from "../../store/terminalStore";
import s from "./TranslateTooltip.module.css";

interface MenuPos {
  x: number;
  y: number;
  text: string;
}

let showMenuGlobal: ((pos: MenuPos) => void) | null = null;

export function showTranslateMenu(x: number, y: number, text: string) {
  showMenuGlobal?.({ x, y, text });
}

function getSelectedText(): string {
  const browserSel = window.getSelection()?.toString().trim();
  if (browserSel) return browserSel;

  const focusedId = useTerminalStore.getState().focusedTerminalId;
  if (focusedId) {
    const ref = terminalRefs.get(focusedId);
    if (ref) {
      const termSel = ref.term.getSelection().trim();
      if (termSel) return termSel;
    }
  }
  return "";
}

function clampPos(x: number, y: number, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.min(Math.max(0, x), vw - w - 8),
    y: Math.min(Math.max(0, y), vh - h - 8),
  };
}

export default function TranslateTooltip() {
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const [result, setResult] = useState<{ text: string; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    showMenuGlobal = (pos) => {
      setResult(null);
      setCopied(false);
      setMenu(pos);
    };
    return () => { showMenuGlobal = null; };
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const text = getSelectedText();
      if (!text) return;
      e.preventDefault();
      setResult(null);
      setCopied(false);
      setMenu({ x: e.clientX, y: e.clientY, text });
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  const handleTranslate = useCallback(async () => {
    if (!menu) return;
    const { x, y, text } = menu;
    setMenu(null);
    setLoading(true);
    setResult({ text: "", x, y });

    try {
      const translated = await translateText(text);
      setResult({ text: translated, x, y });
    } catch (err) {
      setResult({ text: `错误：${err}`, x, y });
    } finally {
      setLoading(false);
    }
  }, [menu]);

  const handleCopy = useCallback(() => {
    if (!result?.text) return;
    navigator.clipboard.writeText(result.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [result]);

  const close = useCallback(() => {
    setMenu(null);
    setResult(null);
  }, []);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (!result) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: result.x, origY: result.y };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setResult((prev) => prev ? { ...prev, x: dragRef.current!.origX + dx, y: dragRef.current!.origY + dy } : prev);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [result]);

  useEffect(() => {
    if (!menu && !result) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (tooltipRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [menu, result, close]);

  if (menu) {
    const detected = detectLang(menu.text);
    const from = detected === "uk" ? "UK" : "EN";
    const to = detected === "uk" ? "EN" : "UK";
    const clamped = clampPos(menu.x, menu.y, 200, 40);
    return (
      <div
        ref={menuRef}
        className={s.menu}
        style={{ left: clamped.x, top: clamped.y }}
      >
        <button className={s.menuItem} onClick={handleTranslate}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 8l6 0" />
            <path d="M4 6l6.5 0M7.5 4L7.5 6" />
            <path d="M4.5 12L5 11 7 6l2 5 .5 1" />
            <path d="M20 18l-2-6-2 6" />
            <path d="M17.5 16.5h3" />
            <path d="M11 14l4 6" />
            <path d="M15 14l-4 6" />
          </svg>
          {from} → {to}
        </button>
      </div>
    );
  }

  if (result) {
    return (
      <div
        ref={tooltipRef}
        className={s.tooltip}
        style={{ left: result.x, top: result.y }}
      >
        <div className={s.header} onMouseDown={onDragStart}>
          <svg className={s.dragIcon} width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <circle cx="3" cy="2" r="1" /><circle cx="7" cy="2" r="1" />
            <circle cx="3" cy="5" r="1" /><circle cx="7" cy="5" r="1" />
            <circle cx="3" cy="8" r="1" /><circle cx="7" cy="8" r="1" />
          </svg>
          <div className={s.headerActions}>
            <button
              className={`${s.iconBtn} ${copied ? s.iconBtnOk : ""}`}
              onClick={handleCopy}
              title="复制"
              disabled={loading}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></svg>
              )}
            </button>
            <button className={s.iconBtn} onClick={close} title="关闭">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <div className={s.body}>
          {loading ? (
            <div className={s.loading}>
              <span className={s.spinner} />
            </div>
          ) : (
            <div className={s.resultText}>{result.text}</div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
