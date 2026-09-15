# Memory Index

> Auto-maintained catalog. Update after any changes to notes.

## architecture/

- [overview.md](architecture/overview.md) — TermHost: Tauri 2 + React terminal multiplexer with sidecar daemon
- [daemon-architecture.md](architecture/daemon-architecture.md) — sidecar PTY daemon, named pipe IPC, reconnect flow, Cargo workspace
- [tech-stack.md](architecture/tech-stack.md) — Tauri 2 + React + TypeScript + Zustand + CSS Modules
- [split-tree-layout.md](architecture/split-tree-layout.md) — binary tree pane layout, zoom/maximize, focus nav, resize
- [android-app.md](architecture/android-app.md) — native Android app with Foreground Service + WebView
- [popout-raw-pipe.md](architecture/popout-raw-pipe.md) — 弹出为独立控制台窗口：bridge 二进制、raw pipe、UI 入口与约束

## decisions/

- [vanilla-js.md](decisions/vanilla-js.md) — vanilla JS → React migration (completed June 2026)
- [dual-codebase.md](decisions/dual-codebase.md) — WPF legacy vs Tauri [?]

## patterns/

- [state-management.md](patterns/state-management.md) — Zustand stores, localStorage keys, daemon state
- [tauri-ipc.md](patterns/tauri-ipc.md) — invoke/emit pattern, daemon proxy, DaemonIndicator, CloseDialog

## gotchas/

- [platform-assumptions.md](gotchas/platform-assumptions.md) — hardcoded powershell, Windows paths [?]
- [frontend-monolith.md](gotchas/frontend-monolith.md) — RESOLVED: migrated to React components
- [xterm-css-pitfalls.md](gotchas/xterm-css-pitfalls.md) — global CSS reset breaks cursor coords, scrollbar 15px fallback, zoom issues
- [xterm-scrollbar-strategy.md](gotchas/xterm-scrollbar-strategy.md) — 1px invisible scrollbar trick, focused-pane scrollbar, bg matching
- [pty-host-console-window.md](gotchas/pty-host-console-window.md) — 关掉 pty-host 的控制台窗口会杀掉所有终端；spawn 必须带 CREATE_NO_WINDOW
- [orphan-terminals-accumulate.md](gotchas/orphan-terminals-accumulate.md) — 「新建终端」只 spawn 不挂载 → 游离终端永久累积；id 含创建时间是判据
- [pty-host-panics-and-recovery.md](gotchas/pty-host-panics-and-recovery.md) — pty-host panic 后 abort（os error 232）；panic 日志 + daemon 自动重连

## domain/

- [workspace-model.md](domain/workspace-model.md) — workspace, pane, split, theme concepts
- [mobile-remote-access.md](domain/mobile-remote-access.md) — mobile web client, WS server, rendering fix plan, Tailscale setup
- [similar-projects.md](domain/similar-projects.md) — tmux, cmux, wmux, BridgeSpace context [?]

## references/

- [adb-wireless-debugging.md](../adb-wireless-debugging.md) — ADB wireless timeout fix (root project)
- [youtube-transcript](../.config/opencode/skills/youtube-transcript/) — YouTube transcript skill with summarize.py
