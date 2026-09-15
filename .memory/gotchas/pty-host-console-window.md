---
updated: 2026-09-15
tags: [gotcha, windows, daemon, pty-host, spawn, process]
related: [[daemon-architecture], [tauri-ipc]]
---
# 关掉 pty-host 的控制台窗口 = 杀掉所有终端

## 症状

「新建终端」点击后**完全没反应**：无窗格、列表也不变、没有任何错误提示。
daemon 与 app 看起来都还活着。

## 根因

pty-host 是 Rust **控制台**程序，而拉起它的父进程（daemon 由 GUI app 拉起、
pty-host 由 daemon 拉起）**自己都没有控制台**。此时若 `Command::spawn()` 不带
creation flags，Windows 会给子进程**分配一个可见的控制台窗口**。

用户看到那个多出来的黑窗口，随手关掉 —— 于是：

1. `pty-host.exe` 被杀 → **它名下的所有 PTY 一起消失**（它是所有终端的主人）
2. daemon **不会退出**：`exit(1)` 只在启动时连不上 pty-host 才触发
3. 此后每一次 `Spawn` 都失败，但失败被前端空 `catch {}` 吞掉 → 表现为「没反应」

关键点：**这不是用户误操作**，是本可以避免的进程启动缺陷。

## 修复

两处都要带 `CREATE_NO_WINDOW` (0x0800_0000)：

- `daemon/src/pty_client.rs` — `spawn()` 拉起 pty-host 时
- `src-tauri/crates/app/src/lib.rs` `launch_daemon_exe()` — `FLAGS_BREAKAWAY` 里

**不要用 `DETACHED_PROCESS` (0x8) 代替** —— 那会破坏托盘图标依赖的 Win32
消息循环（原注释已经警告过）。`CREATE_NO_WINDOW` 只是不给窗口，消息循环不受影响。

## 验证方法（可复现）

```powershell
# 这三个进程里，只有 termhost.exe 应当有可见窗口
Get-Process | ? { $_.ProcessName -match 'termhost|pty-host' } |
  Select-Object Id, ProcessName, MainWindowHandle
# pty-host 与 termhostd 的 MainWindowHandle 必须是 0
```

`MainWindowHandle` 对控制台窗口不算铁证，严格做法是 `EnumWindows` +
`IsWindowVisible` 枚举可见顶层窗口，按 PID 过滤。

## 附带教训：诊断通道不能是空的

同一现象之所以极难定位，是因为失败路径全是静默的：

- `AllTerminals.tsx` `handleNewTerminal` 的空 `catch {}`
- `AllTerminals.tsx` `refresh()` 的空 `catch {}`
- `TerminalInstance.tsx` `setup()` 末尾的空 `catch {}`（spawn 失败只留一个白窗格）

**排查此类问题的顺序**：
1. 先看 `pty-host.exe` 在不在（`Get-Process pty-host`）—— 它不在就一切免谈
2. 再看 `daemon.pid` 里的 PID 是否还活着
3. daemon 已无文件日志（`tracing` 原本只写进那个可见控制台窗口）→ 见下方待办

## 待办（本次未做）

- ~~daemon 加**文件日志**：控制台隐藏后 `tracing` 输出彻底无处可看~~
  → **2026-09-16 已做**（`daemon/src/panic_log.rs`）
- ~~pty-host 死后 daemon 应**自愈**~~ → **2026-09-16 已做**，但**不是**「退出让 app 拉起」：
  那样会破坏手机远程访问（app 没开时没人拉它）。改为 daemon 就地重连。
  见 [[pty-host-panics-and-recovery]]
