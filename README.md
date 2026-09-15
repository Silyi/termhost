# termhost

**Your Windows terminals, in your pocket.** A terminal workspace for your PC and a remote control for it on your phone — one app.

termhost is a Windows terminal multiplexer (think tmux, but with a GUI) whose terminals live in background processes of their own — not in the window, not even in the daemon — and are reachable from any device: work in split panes on your laptop, then pick up your phone and keep driving the very same terminals from the couch, the street, or another machine. No SSH app, no account, no cloud — your PC serves everything itself.

Built for the age of AI coding agents: the most common use case is **controlling Claude Code, Codex, or opencode running on your PC from your phone** — watching the agent work, answering its prompts, sending it a photo — while your laptop stays on the desk.

> ⚠️ Early development. Windows-first (PowerShell + ConPTY); the mobile client works in any modern browser.

---

> ### 🔱 This is a fork
>
> Upstream: **[rviach/termhost](https://github.com/rviach/termhost)** (formerly `viachq/termhost`), by **viachq** — MIT licensed.
> The project, its design, and most of the codebase are their work. This fork builds on top of it;
> [what changed here](#fork-changes) is listed below. The README above is upstream's, with the
> architecture and roadmap updated where this fork moved them.

---

## What you get

### 🖥️ A real terminal workspace on the desktop

- **Split panes** — binary-tree layout with keyboard-driven splits, focus navigation, resize, and per-pane zoom/maximize
- **Workspaces** — named sets of terminals with their own working directories and startup commands, restored on launch
- **Side panels** — file explorer with Monaco editor and Markdown preview, embedded browser, git panel, SSH panel, MCP panel
- **GPU-rendered terminals** — xterm.js with the WebGL addon, image support, clickable links, search
- **Native, not Electron** — Tauri 2 + Rust, small footprint, instant startup

### 🔌 Terminals that survive

All PTYs are owned by a separate, small Rust process (`pty-host`), not by the app window and not even by the daemon. Close the app, restart it during development, crash the UI, **or restart and upgrade the daemon** — your shells and running agents keep going. Reopen the window and reattach. The daemon sits in the tray and can keep the machine awake while remote access is on.

### 📱 Your terminals on your phone

The daemon serves a **PWA** straight from your PC — open one URL on your phone, install it to the home screen, and you have every terminal from your desktop:

- **Faithful rendering of TUIs** — the daemon keeps a server-side vt100 screen for each terminal, so Claude Code's interactive UI, menus and colors render correctly the moment you connect (no garbled replay)
- **Two clients, one terminal, no fighting** — "active client wins" size negotiation: tap the phone and the PTY reflows to phone width; click the desktop pane and it snaps back
- **A keyboard that understands agents** — Esc, Ctrl+C, arrows, Tab, ⇧Tab (Claude Code mode cycle), Enter, plus a collapsible strip of extras
- **Send a photo into your workflow** — attach an image from the phone; it lands on the PC clipboard ready to paste into Claude Code
- **Spawn new terminals from the phone**, switch between them, send clipboard text straight into any PTY
- **Survives mobile networks** — exponential-backoff reconnect on tower handoffs and screen locks, full screen repaint on reconnect
- **Zero-typing auth** — a per-daemon token is injected into the served page automatically; the WebSocket and file endpoints reject anything without it

### 🌐 Connect from anywhere

Your PC is the server. On your LAN, open `http://<pc-ip>:9090` — done. Away from home, bring your own tunnel:

- **Tailscale** — the daemon detects and prints your tailnet URL alongside the LAN one
- **Cloudflare Tunnel** — nothing to install on the phone, zero phone battery cost

No relay servers, no telemetry, no account. Self-hosted in the most literal sense: it's your laptop.

---

## How it works

```
┌──────────────── your PC ─────────────────┐
│                                          │
│  termhost.exe (Tauri 2 + React)          │
│  desktop workspace UI                    │
│         │ named pipe IPC                 │
│  termhostd.exe                           │
│  Rust daemon in the tray                 │
│  • vt100 screen per terminal             │
│  • token auth                            │
│  • warp WS/HTTP server :9090             │
│         │ named pipe IPC                 │
│  pty-host.exe                            │
│  • owns every PTY (ConPTY)               │
│  • survives daemon restarts              │
└────────────────────┬─────────────────────┘
                     │ WebSocket
      LAN · Tailscale · Cloudflare Tunnel
                     │
     ┌───────────────┴───────────────┐
     │ phone / tablet / any PC       │
     │ PWA (React + xterm.js)        │
     └───────────────────────────────┘
```

The desktop UI is just another client of the daemon — which is why terminals outlive it, and why your phone sees exactly the same sessions.

---

## Fork changes

What this fork adds on top of [upstream](https://github.com/rviach/termhost). Everything here is the
fork's work; the rest of the project — including its design and the daemon/PWA architecture — is
viachq's.

### Architecture

- **PTY ownership moved out of the daemon into its own process** (`pty-host.exe`) — the session-host
  process the upstream roadmap called for. Terminals now survive a *daemon* restart or upgrade, not
  just an app restart: the daemon reconnects to an already-running pty-host and reattaches the
  terminals it finds there.

### Features

- **Pop a terminal out into a real console window** (`termhost-bridge.exe` over a raw byte pipe) — one
  click in the pane header or in the terminal list puts that terminal into its own Windows Terminal
  window, or a plain console window if WT isn't installed. Popping out detaches the pane from the
  layout while the terminal itself keeps running.
- **Open an already-running terminal from the "All Terminals" list** — including terminals created on
  the phone. The pane attaches to the live PTY and repaints from the daemon's vt100 screen.
- **Chinese localization** across the desktop UI (~21 files), plus visible labels on the previously
  icon-only title-bar buttons.

### Fixes

- The daemon and pty-host are console binaries spawned by parents that have no console, so Windows
  handed each of them a **visible** console window. Closing that window killed pty-host — the owner
  of every PTY — and every terminal died with it; from then on every spawn failed, and the failure
  was invisible. Both spawns now pass `CREATE_NO_WINDOW`.
- **Failed spawns are no longer swallowed** by empty `catch` blocks: the error is shown in the
  terminal list and written into the terminal pane.
- **New terminals are attached to the workspace layout.** One used to be spawned but never referenced
  by any layout, so nothing ever reclaimed it — and because pty-host outlives the app, exactly one
  leaked per session.

---

## Getting started

Prerequisites: Windows 10/11, [Node.js](https://nodejs.org) ≥ 20, [Rust](https://rustup.rs) stable.

```powershell
git clone https://github.com/Silyi/termhost   # ← this fork; upstream is rviach/termhost
cd termhost
npm install
npm run dev          # dev build: Tauri window + vite dev server
```

Production build:

```powershell
npm run build        # builds the mobile PWA bundle, then the Tauri app
```

Phone access: launch the app → Settings → Remote Access → open the printed URL on your phone (LAN and Tailscale URLs are both shown), then "Add to Home Screen".

---

## termhost vs. the alternatives

| | termhost | ttyd / wetty | VibeTunnel / 9remote / ccpocket | claudecodeui | tmux + SSH app | cmux / wmux |
|---|---|---|---|---|---|---|
| Full desktop workspace (panes, files, git) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Terminals survive UI restarts | ✅ daemon | ❌ | varies | ❌ | ✅ | wmux only |
| Phone client tuned for TUIs/agents | ✅ | ❌ raw | ✅ | ✅ | ⚠️ SSH app needed | ❌ |
| Agent-agnostic (any CLI, not a wrapper) | ✅ any PTY | ✅ | varies | ❌ Claude-centric | ✅ | ✅ |
| Correct TUI render on connect (server-side screen) | ✅ vt100 | ❌ | varies | n/a | ✅ | n/a |
| Windows-native, no WSL | ✅ | ⚠️ | varies | ⚠️ | ❌ | wmux only |
| Self-hosted, no account | ✅ | ✅ | varies | ✅ | ✅ | ✅ |

The gap termhost fills: projects in this space are either *a workspace* (cmux, wmux) or *a remote channel* (ttyd, VibeTunnel, ccpocket) — termhost is the place your terminals live **and** every way you reach them.

---

## Tech stack

- **Desktop:** Tauri 2, React 19, TypeScript, Zustand, CSS Modules, xterm.js (WebGL), Monaco
- **Daemon:** Rust — portable-pty (ConPTY), warp (HTTP/WS), vt100, tray-icon, arboard
- **Mobile:** React + xterm.js compiled to a single self-contained `mobile.html`, served by the daemon; PWA manifest
- **IPC:** named pipes (app ↔ daemon), WebSocket (clients ↔ daemon), token-authenticated

## Roadmap

- [ ] Attach files/photos directly into the agent's prompt (path injection, not clipboard)
- [ ] Service worker → full offline-capable PWA install
- [ ] Screen view — see the desktop, not just terminals
- [ ] Connect to remote servers' daemons, not only the local PC
- [x] Terminals that survive daemon updates (session host process) — **done in this fork** as `pty-host.exe`
- [ ] Linux/macOS desktop build (Tauri is already cross-platform)

## Status

Actively developed and used daily by its author to drive Claude Code from a phone. Expect rough edges and breaking changes; issues and ideas are welcome.

## License

[MIT](LICENSE)

---

*Keywords: remote terminal, Windows terminal multiplexer, control Claude Code from phone, mobile terminal, tmux alternative for Windows, PWA terminal, self-hosted remote access, AI coding agent remote control, xterm.js, Tauri, Rust, ConPTY.*
