---
updated: 2026-09-15
tags: [architecture, popout, bridge, raw-pipe, windows-terminal]
related: [[daemon-architecture], [pty-host-console-window], [tauri-ipc], [mobile-remote-access]]
---
# 弹出为独立窗口（bridge + raw pipe）

把一个终端搬进**真正的控制台窗口**，看起来就是正常的 cmd / Windows Terminal。

## 组成

| 部件 | 位置 | 职责 |
|---|---|---|
| `termhost-bridge.exe` | `daemon/src/bridge.rs`（独立 `[[bin]]`） | 连上该终端的 raw pipe，把字节转发给一个真实控制台 |
| raw pipe | `\\.\pipe\termhost-raw-<terminal-id>` | **纯字节流，无分帧**。由 daemon 在 `Spawn` 时经 `raw_pipe::start_raw_pipe` 创建 |
| 控制面 | 仍是主 IPC 管道 `termhost-pty-v1` | bridge 只发 `Resize` 去**主张尺寸** |
| 宿主 | `wt.exe -w new new-tab -- <bridge> <id>` | 没有 wt.exe 就退回直接跑 bridge，让系统分配普通控制台 |

## UI 入口（2026-09-15 新增）

- Tauri 命令 `popout_terminal(id)`（`src-tauri/crates/app/src/lib.rs`）
- 两处按钮：终端窗格标题栏（`PaneHeader.tsx`）、「所有终端」列表行（`AllTerminals.tsx`）
- 在此之前只有命令行脚本 `termhost-popout.cmd`，**前端零引用** —— 用户在界面里找不到任何入口

## 必须知道的约束

1. **一个 raw pipe 同一时刻只服务一个客户端**。对已弹出的终端再点「弹出」会失败：
   `cannot open ... : 所有的管道范例都在使用中 (os error 231)`，bridge 退出码 3。
   注意这条消息是 **bridge 自己打印在那个新窗口里**的，不是 app 弹的 —— 所以
   界面上的错误处理管不到它。
2. **bridge 必须和 `termhost.exe` 同目录**：`popout_terminal` 从
   `current_exe().parent()` 找它。部署时四个 exe 齐全：
   `termhost.exe` / `termhostd.exe` / `pty-host.exe` / `termhost-bridge.exe`。
3. **弹出会抢走尺寸所有权**：走 `Resize` 分支 → `active_clients[id]="desktop"`、
   pty-host 里 `lock_size` 钉死、广播 `TerminalControlLost` → **手机降为 passive**。
   设计如此（last interaction owns the size），但要意识到副作用。
4. **弹出成功后会把窗格从布局里移出**（`detachTerminalFromLayout`，**不杀终端**）。
   两件事都不能省：
   - 不能直接删窗格 —— `App.tsx` 的 `handleClose` 会 `killTerminal`，那会**连带杀掉
     刚弹出的独立窗口**。真正会杀终端的只有那一条路径；`TerminalInstance` 的卸载
     清理只销毁本地 xterm。
   - 必须**持久化**：存档 `splitTree` 里若还留着该窗格 id，下次启动会按 id 把它
     拉回来（见 [[workspace-model]] 的 id 复用规则），刚弹出的终端就会再多一个。
   - **弹出的是最后一个窗格时**要清空该工作区的布局（`splitTree: null`、`panes: []`），
     **不能**学 `handleClose` 用 `panesToTree` 补占位叶节点 —— 那会带新 id 去 spawn
     一个全新终端。配套地，`App.tsx` 的 `ensureWorkspaceTree` 已改为在「无存档且
     `panes` 为空」时**直接返回**（不再凭空造窗格），否则下次启动又会冒出一个空终端。
     注意这与 `handleClose`（关最后一个窗格 → 补一个新的）行为**故意不同**：关是
     「我要一个终端」，弹出是「这个终端搬走了」。
5. **daemon 重启后 reattach 的终端没有 raw pipe** —— `main.rs` 的重连循环只重建
   infos/sizes/buffer/screen，不调 `start_raw_pipe`，且 `Spawn` 的 `already_known`
   守卫会让后续同 id 的 Spawn 跳过建管道。这类终端**弹不出来**。
6. `wt.exe` 自身是控制台程序：spawn 它必须带 `CREATE_NO_WINDOW`，否则又会多出一个
   能被用户误关的黑窗口（见 [[pty-host-console-window]]）。**但退回路径里直接跑
   bridge 时不能带** —— bridge 需要在真实控制台里跑才看得见。
