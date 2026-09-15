import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ImageAddon } from "@xterm/addon-image";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../store/settingsStore";
import { useTerminalStore, terminalRefs } from "../../store/terminalStore";
import { useFileViewerStore } from "../../store/fileViewerStore";
import { spawnTerminal, writeTerminal, resizeTerminal, hasTerminal, getTerminalBuffer, getTerminalScreen } from "../../hooks/useTauriIpc";
import s from "./Terminal.module.css";

// Matches: C:\path\file.ts:42, .\rel\file.rs, src/App.tsx:10:5, file.ts:3
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?[\w.@+~#$-]+(?:[\\/][\w.@+~#$-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}(?::(\d+)(?::\d+)?)?/g;

interface Props {
  id: string;
  cwd?: string;
  command?: string;
  onFocus: () => void;
}

export default function TerminalInstance({ id, cwd, command, onFocus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let killed = false;
    let webglAddon: WebglAddon | null = null;
    let unlistenFn: (() => void) | null = null;
    let resizeUnlisten: (() => void) | null = null;
    let resizeTimeout: number;
    let webglRetries = 0;

    // --- attach-vs-spawn bookkeeping (see the attach branch in setup()) ---
    // True once this mount attached to an already-running terminal and painted
    // its vt100 snapshot at the PTY's NATIVE grid. While it is set the mount
    // path must not re-fit: a fit/resize landing after the paint re-grids the
    // xterm under a snapshot rendered for a different grid, which is exactly
    // the ghost-cell mismatch the snapshot exists to avoid. Size ownership
    // moves on user interaction (focus, a real layout resize, a font change),
    // never on mount.
    let paintedSnapshot = false;
    // setup() has finished deciding attach-vs-spawn.
    let mountSettled = false;
    // The ResizeObserver's first callback is the mount observation (the layout
    // settling), not the user resizing anything — see the observer below.
    let firstResizeObs = true;
    // Most recent size another client pushed at us over `pty-resize-<id>`. The
    // follow listener is registered before the attach paint's round trips, so a
    // resize can land mid-paint and be undone by the paint's own `term.resize`;
    // remembering it lets the paint re-apply it (see the attach branch).
    let followedSize: { cols: number; rows: number } | null = null;

    const settings = useSettingsStore.getState();
    const term = new Terminal({
      fontFamily: settings.termFontFamily,
      fontSize: settings.termFontSize,
      theme: settings.getXtermTheme(),
      cursorStyle: settings.termCursorStyle,
      cursorBlink: false,
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
      scrollback: 50000,
      fastScrollModifier: "shift",
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((_, uri) => {
      window.dispatchEvent(new CustomEvent("agentworkspace:open-url", { detail: uri }));
    }));
    term.loadAddon(searchAddon);
    const unicodeAddon = new Unicode11Addon();
    term.loadAddon(unicodeAddon);
    term.unicode.activeVersion = "11";

    const imageAddon = new ImageAddon({ enableSizeReports: true });
    term.loadAddon(imageAddon);

    term.open(el);

    const paneEl = el.closest("[data-pane-id]") as HTMLElement | null;
    const themeBg = settings.getXtermTheme().background;
    if (themeBg) {
      el.style.background = themeBg;
      if (paneEl) paneEl.style.background = themeBg;
    }

    function tryLoadWebgl() {
      if (killed || webglAddon || webglRetries >= 3) return;
      webglRetries++;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          try { addon.dispose(); } catch {}
          webglAddon = null;
          if (!killed) setTimeout(tryLoadWebgl, 500);
        });
        term.loadAddon(addon);
        webglAddon = addon;
      } catch {
        webglAddon = null;
      }
    }

    tryLoadWebgl();

    // --- Copy mode: keyboard-driven scrollback navigation (tmux-style) ---
    // Ctrl+Shift+[ enter · arrows/PgUp/PgDn/g/G move · Space anchor · Enter/y copy · Esc/q exit
    let copyMode = false;
    let copyCursor = 0;
    let copyAnchor: number | null = null;
    let copyBadge: HTMLDivElement | null = null;

    const exitCopyMode = () => {
      copyMode = false;
      copyAnchor = null;
      term.clearSelection();
      term.scrollToBottom();
      copyBadge?.remove();
      copyBadge = null;
    };

    const enterCopyMode = () => {
      copyMode = true;
      const buf = term.buffer.active;
      copyCursor = buf.baseY + buf.cursorY;
      copyAnchor = null;
      term.selectLines(copyCursor, copyCursor);
      if (!copyBadge) {
        copyBadge = document.createElement("div");
        copyBadge.textContent = "复制模式 · Space=选择 · Enter=复制 · q=退出";
        copyBadge.style.cssText =
          "position:absolute;top:4px;right:12px;z-index:10;padding:2px 8px;font-size:10px;" +
          "border-radius:4px;background:#1a1a1a;color:#e5a50a;border:1px solid #333;pointer-events:none;";
        if (getComputedStyle(el).position === "static") el.style.position = "relative";
        el.appendChild(copyBadge);
      }
    };

    const updateCopyView = () => {
      const buf = term.buffer.active;
      const maxLine = buf.baseY + term.rows - 1;
      copyCursor = Math.max(0, Math.min(copyCursor, maxLine));
      if (copyAnchor !== null) {
        term.selectLines(Math.min(copyAnchor, copyCursor), Math.max(copyAnchor, copyCursor));
      } else {
        term.selectLines(copyCursor, copyCursor);
      }
      const viewTop = buf.viewportY;
      if (copyCursor < viewTop) term.scrollToLine(copyCursor);
      else if (copyCursor >= viewTop + term.rows) term.scrollToLine(copyCursor - term.rows + 1);
    };

    const handleCopyModeKey = (ev: KeyboardEvent): boolean | null => {
      if (!copyMode) {
        if (ev.ctrlKey && ev.shiftKey && ev.code === "BracketLeft") {
          if (ev.type === "keydown") enterCopyMode();
          return false;
        }
        return null;
      }
      if (ev.type !== "keydown") return false;
      switch (ev.code) {
        case "Escape": case "KeyQ":
          exitCopyMode(); break;
        case "ArrowUp": case "KeyK":
          copyCursor--; updateCopyView(); break;
        case "ArrowDown": case "KeyJ":
          copyCursor++; updateCopyView(); break;
        case "PageUp":
          copyCursor -= term.rows; updateCopyView(); break;
        case "PageDown":
          copyCursor += term.rows; updateCopyView(); break;
        case "KeyG":
          copyCursor = ev.shiftKey ? term.buffer.active.baseY + term.rows - 1 : 0;
          updateCopyView(); break;
        case "Space": case "KeyV":
          copyAnchor = copyAnchor === null ? copyCursor : null;
          updateCopyView(); break;
        case "Enter": case "KeyY": case "KeyC": {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel);
          exitCopyMode();
          break;
        }
      }
      return false;
    };

    term.attachCustomKeyEventHandler((ev) => {
      const cm = handleCopyModeKey(ev);
      if (cm !== null) return cm;
      if (ev.ctrlKey && ev.code === "KeyC" && term.hasSelection()) {
        if (ev.type === "keydown") {
          const sel = term.getSelection();
          navigator.clipboard.writeText(sel);
          window.dispatchEvent(new CustomEvent("agentworkspace:terminal-copy", { detail: sel }));
          term.clearSelection();
        }
        return false;
      }
      if (ev.ctrlKey && ev.code === "KeyV") {
        if (ev.type === "keydown") {
          ev.preventDefault();
          navigator.clipboard.read().then((items) => {
            for (const item of items) {
              const imageType = item.types.find((t) => t.startsWith("image/"));
              if (imageType) {
                item.getType(imageType).then((blob) => {
                  const reader = new FileReader();
                  reader.onload = () => {
                    const base64 = (reader.result as string).split(",")[1];
                    const format = imageType.split("/")[1] || "png";
                    const name = btoa("paste." + format);
                    const iip = `\x1b]1337;File=name=${name};size=${blob.size};inline=1;preserveAspectRatio=1:${base64}\x07`;
                    term.write(iip);
                  };
                  reader.readAsDataURL(blob);
                });
                return;
              }
            }
            navigator.clipboard.readText().then((text) => {
              if (!text) return;
              const normalized = text
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n")
                .replace(/\n/g, "\r");
              term.paste(normalized);
            });
          });
        }
        return false;
      }
      if (ev.ctrlKey && !ev.shiftKey && ev.code === "KeyF") {
        if (ev.type === "keydown") {
          window.dispatchEvent(
            new CustomEvent("agentworkspace:terminal-search", { detail: id })
          );
        }
        return false;
      }
      if (ev.ctrlKey && ev.altKey && ev.key.startsWith("Arrow")) return false;
      return true;
    });

    term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString();
        const links: any[] = [];
        FILE_PATH_RE.lastIndex = 0;
        let match;
        while ((match = FILE_PATH_RE.exec(text)) !== null) {
          const fullMatch = match[0];
          const lineNum = match[1] ? parseInt(match[1], 10) : undefined;
          // Require a path separator or a :line suffix to avoid matching
          // bare words like "example.com"; skip URL tails (preceded by "/").
          const hasSep = /[\\/]/.test(fullMatch);
          const prevChar = match.index > 0 ? text[match.index - 1] : "";
          if ((!hasSep && !lineNum) || prevChar === "/" || prevChar === "\\") continue;
          const startCol = match.index + 1;
          const endCol = match.index + fullMatch.length;
          links.push({
            range: {
              start: { x: startCol, y: lineNumber },
              end: { x: endCol, y: lineNumber },
            },
            text: fullMatch,
            activate() {
              const filePath = fullMatch.replace(/(?::\d+)+$/, "");
              const ref = terminalRefs.get(id);
              const cwd = ref?.lastDir || ref?.cwd || "";
              const isAbsolute = /^[A-Z]:[/\\]/i.test(filePath) || filePath.startsWith("/");
              const absPath = isAbsolute
                ? filePath
                : cwd
                  ? `${cwd.replace(/[/\\]$/, "")}${cwd.includes("\\") ? "\\" : "/"}${filePath}`
                  : filePath;
              const normalized = absPath.replace(/\//g, "\\");
              useFileViewerStore.getState().openFile(normalized, lineNum);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    const setup = async () => {
      try {
        unlistenFn = await listen<string>(`pty-data-${id}`, (event) => {
          if (killed) return;
          term.write(event.payload);
        });

        if (killed) {
          unlistenFn();
          return;
        }

        // Follow PTY resizes from another client (e.g. a phone in Control mode):
        // render clean-but-small instead of garbled. We re-assert our own size when
        // this pane regains focus (see the focus effect below) — tmux active-client-wins.
        resizeUnlisten = await listen<{ cols: number; rows: number }>(`pty-resize-${id}`, (event) => {
          if (killed) return;
          const { cols, rows } = event.payload;
          if (cols > 0 && rows > 0) {
            // Record it even when the attach paint later overwrites the resize —
            // the paint re-applies it once it has finished.
            followedSize = { cols, rows };
            if (term.cols !== cols || term.rows !== rows) {
              try { term.resize(cols, rows); } catch {}
            }
          }
        });

        // Fit before spawn so PTY gets the correct initial size
        try { fitAddon.fit(); } catch {}
        const cols = term.cols > 0 ? term.cols : 80;
        const rows = term.rows > 0 ? term.rows : 24;

        const exists = await hasTerminal(id);
        if (exists) {
          // Attach to a terminal that is already running: paint its current
          // screen from pty-host's vt100 parser instead of replaying the raw
          // byte history — the replay re-runs every escape sequence and leaves
          // ghost cells. Same sequence as the mobile client (App.tsx "screen").
          let painted = false;
          try {
            const screen = await getTerminalScreen(id);
            // `screen !== null` is the test, NOT `screen.data` — an empty
            // string is a legitimate snapshot (a blank screen) and painting it
            // on the native grid is the correct blank repaint. Treating it as
            // "no screen" would fall into the raw-replay fallback, whose
            // history-replay-at-container-size combination is exactly what
            // produces the ghost cells.
            if (screen) {
              el.style.visibility = "hidden";
              try {
                // Paint at the snapshot's NATIVE size — a mismatch (snapshot
                // taken before/after a resize) leaves ghost cells from the
                // previous frame.
                if (screen.cols > 0 && screen.rows > 0) {
                  term.resize(screen.cols, screen.rows);
                }
                term.reset();
                await new Promise<void>((resolve) => {
                  term.write(screen.data, resolve);
                });
                // A `pty-resize-<id>` that arrived during these round trips (the
                // follow listener is registered before them) was overwritten by
                // the resize above, which leaves xterm on the snapshot grid while
                // the PTY is already resized and locked to a different one — and
                // nothing corrects that until an unrelated layout/focus/settings
                // event. Re-apply the last size we were told to follow.
                if (followedSize && (followedSize.cols !== term.cols || followedSize.rows !== term.rows)) {
                  try { term.resize(followedSize.cols, followedSize.rows); } catch {}
                }
              } finally {
                el.style.visibility = "";
              }
              painted = true;
            }
          } catch {}
          if (!painted) {
            // No screen for this id (pty-host has no parser for it) — fall back
            // to the raw history replay, i.e. the previous behaviour.
            try {
              const buffer = await getTerminalBuffer(id);
              if (buffer) {
                el.style.visibility = "hidden";
                await new Promise<void>((resolve) => {
                  term.write(buffer, resolve);
                });
                el.style.visibility = "";
              }
            } catch {}
            // Only meaningful for the replay fallback: the PTY is re-asserted
            // to this pane's size because the replayed bytes carry no grid.
            resizeTerminal(id, cols, rows).catch(() => {});
          }
          // NOTE: after a clean snapshot paint we deliberately do NOT call
          // resizeTerminal. The snapshot's grid IS the PTY's current size, so
          // pushing the container's size would put the PTY and the painted grid
          // out of step. The desktop takes the size on interaction (focus / a
          // real layout resize), not on mount.
          paintedSnapshot = painted;
        } else {
          await spawnTerminal(id, cwd, command, cols, rows);
        }
        mountSettled = true;

        // Second fit after DOM settles to catch any WebGL/layout discrepancy.
        // Spawn only: on the attach path this fit would re-grid the xterm under
        // the snapshot we just painted (and, now that the daemon honours desktop
        // resizes, hand the PTY a size the paint never matched) — the ghosting
        // we just removed.
        if (paintedSnapshot) return;
        setTimeout(() => {
          if (killed) return;
          try {
            fitAddon.fit();
            if (term.cols > 0 && term.rows > 0 && (term.cols !== cols || term.rows !== rows)) {
              resizeTerminal(id, term.cols, term.rows).catch(() => {});
            }
          } catch {}
        }, 100);
      } catch (e) {
        // 这里曾经是空的 —— spawn 失败（典型情形：pty-host 已被杀掉）只留下一个
        // 全白的窗格，用户完全看不出发生了什么。
        try {
          term.write(`\r\n\x1b[31m终端启动失败：${String(e)}\x1b[0m\r\n`);
        } catch {}
        console.error(`[终端 ${id}] 初始化失败:`, e);
      }
    };

    setup();

    term.onData((data) => {
      if (!killed) writeTerminal(id, data);
    });

    term.onTitleChange((title) => {
      if (killed) return;
      const ref = terminalRefs.get(id);
      if (ref) {
        ref.title = title;
        if (/^[A-Z]:\\/i.test(title) || title.startsWith("/")) {
          ref.lastDir = title;
        }
      }
      useTerminalStore.getState().setTitle(id, title);
    });

    const resizeObs = new ResizeObserver((entries) => {
      if (killed) return;
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      // The observer's first callback is the mount observation (layout
      // settling), not the user resizing anything. Drop it when we attached
      // and painted a snapshot — fitting there would re-grid the xterm under
      // the paint and bring the ghost cells straight back. Also drop it while
      // setup() is still deciding: the spawn path already fitted before
      // spawning and gets its correcting fit when setup() finishes. Every
      // later callback is a real layout change and behaves as before.
      const isMountObservation = firstResizeObs;
      firstResizeObs = false;
      if (isMountObservation && (paintedSnapshot || !mountSettled)) return;
      clearTimeout(resizeTimeout);
      resizeTimeout = window.setTimeout(() => {
        if (killed) return;
        try {
          fitAddon.fit();
          if (term.cols > 0 && term.rows > 0) {
            resizeTerminal(id, term.cols, term.rows).catch(() => {});
          }
        } catch {}
      }, 100);
    });
    resizeObs.observe(el);

    const handleWheel = (e: WheelEvent) => {
      if (term.buffer.active.type === "alternate") {
        e.preventDefault();
        e.stopPropagation();
        const lines = Math.ceil(Math.abs(e.deltaY) / 30);
        term.scrollLines(e.deltaY > 0 ? lines : -lines);
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false, capture: true });

    // OSC 7 — current working directory (emitted by shell prompt hook)
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        let path = decodeURIComponent(url.pathname);
        // Windows: /C:/Users/... → C:\Users\...
        if (/^\/[A-Za-z]:\//.test(path)) {
          path = path.slice(1).replace(/\//g, "\\");
        }
        const ref = terminalRefs.get(id);
        if (ref) { ref.lastDir = path; ref.cwd = path; }
        useTerminalStore.getState().setTitle(id, path.split("\\").pop() || path);
      } catch {}
      return true;
    });

    // OSC 133 A — prompt start (mark command zone)
    term.parser.registerOscHandler(133, (data) => {
      if (data === "A") {
        const ref = terminalRefs.get(id);
        if (ref) {
          const line = term.buffer.active.baseY + term.buffer.active.cursorY;
          ref.commandMarks.push(line);
          // Keep only last 500 marks to avoid unbounded growth
          if (ref.commandMarks.length > 500) ref.commandMarks.shift();
        }
      }
      return true;
    });

    terminalRefs.set(id, {
      term,
      fitAddon,
      searchAddon,
      unlisten: () => { unlistenFn?.(); resizeUnlisten?.(); },
      resizeObserver: resizeObs,
      command: command || "",
      cwd: cwd || "",
      title: "",
      lastDir: cwd || "",
      lastActiveAt: Date.now(),
      bufferTrimmed: false,
      commandMarks: [],
    });

    // Trim inactive scrollback — after 5min of inactivity clear buffer to free memory
    const trimInterval = window.setInterval(() => {
      if (killed) return;
      const ref = terminalRefs.get(id);
      if (!ref) return;
      const isActive = useTerminalStore.getState().focusedTerminalId === id;
      if (isActive) return;
      const inactive = Date.now() - ref.lastActiveAt;
      if (inactive > 5 * 60 * 1000 && !ref.bufferTrimmed) {
        ref.bufferTrimmed = true;
        try { term.clear(); } catch {}
      }
    }, 60 * 1000);

    return () => {
      killed = true;
      clearTimeout(resizeTimeout);
      clearInterval(trimInterval);
      resizeObs.disconnect();
      el.removeEventListener("wheel", handleWheel, { capture: true } as EventListenerOptions);
      unlistenFn?.();
      resizeUnlisten?.();
      terminalRefs.delete(id);
      try { webglAddon?.dispose(); } catch {}
      webglAddon = null;
      requestAnimationFrame(() => {
        try { term.dispose(); } catch {}
      });
    };
  }, [id]);

  useEffect(() => {
    let prevFocused = useTerminalStore.getState().focusedTerminalId;
    return useTerminalStore.subscribe((state) => {
      if (state.focusedTerminalId !== prevFocused) {
        prevFocused = state.focusedTerminalId;
        if (state.focusedTerminalId === id) {
          const ref = terminalRefs.get(id);
          if (!ref) return;
          ref.term.focus();
          ref.lastActiveAt = Date.now();
          // Re-assert this desktop pane's canonical size on focus: a phone may have
          // shrunk the shared PTY in Control mode while we were away (tmux "active
          // client wins" — whoever interacts last owns the size).
          requestAnimationFrame(() => {
            try {
              ref.fitAddon.fit();
              if (ref.term.cols > 0 && ref.term.rows > 0) {
                resizeTerminal(id, ref.term.cols, ref.term.rows).catch(() => {});
              }
            } catch {}
          });
          // Restore buffer if it was trimmed
          if (ref.bufferTrimmed) {
            ref.bufferTrimmed = false;
            getTerminalBuffer(id).then((buffer) => {
              if (buffer) {
                ref.term.write(buffer);
              }
            }).catch(() => {});
          }
        }
      }
    });
  }, [id]);

  useEffect(() => {
    const el = containerRef.current;
    return useSettingsStore.subscribe((state) => {
      const ref = terminalRefs.get(id);
      if (!ref) return;
      const theme = state.getXtermTheme();
      ref.term.options.theme = theme;
      ref.term.options.fontSize = state.termFontSize;
      ref.term.options.fontFamily = state.termFontFamily;
      ref.term.options.cursorStyle = state.termCursorStyle;
      if (theme.background) {
        if (el) el.style.background = theme.background;
        const paneEl = el?.closest("[data-pane-id]") as HTMLElement | null;
        if (paneEl) paneEl.style.background = theme.background;
      }
      requestAnimationFrame(() => {
        try {
          ref.fitAddon.fit();
          resizeTerminal(id, ref.term.cols, ref.term.rows).catch(() => {});
        } catch {}
      });
    });
  }, [id]);

  return (
    <div
      ref={containerRef}
      className={s.xtermContainer}
      onClick={onFocus}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const text = e.dataTransfer.getData("text/plain");
        if (!text) return;
        const paths = text
          .split("\n")
          .filter(Boolean)
          .map((p) => (/\s/.test(p) ? `"${p}"` : p))
          .join(" ");
        writeTerminal(id, paths);
        onFocus();
      }}
    />
  );
}
