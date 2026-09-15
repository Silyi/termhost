---
updated: 2026-09-15
tags: [gotcha, terminal, workspace, layout, lifecycle]
related: [[workspace-model], [state-management], [tauri-ipc], [popout-raw-pipe]]
---
# 游离终端会永久累积（每轮启动 +1）

## 症状

用户报告：「每次启动 termhost、点新建终端，都会得到在上一轮终端数上 +1 的终端数量」。
终端列表越攒越长，旧终端永不消失。

## 根因：`新建终端` 只 spawn，不挂载

`AllTerminals.tsx` 的 `handleNewTerminal` 原本只做：

```tsx
const id = makeId();
await spawnTerminal(id, "", "", 80, 24);
// 注释写着 "Broadcast will trigger refresh" —— 只刷新列表，不碰布局
```

于是那个终端成为**游离终端**：

- **不在任何工作区的布局里** → 存档 `splitTree` 不会引用它 → **没有任何回收路径**
- 而 **pty-host 不随 app 退出而结束**（这是刻意的，手机远程访问靠它）
- ⇒ 每建一个就永久多一个

## 为什么旧终端会「原样复活」

存档 `splitTree` 里存着**每个窗格的终端 id**，`instantiateTree` 用
`config.id || makeTermId()` **原样复用**。所以布局里的窗格每次启动都按同一批 id
重新拉起 —— 这部分是**正确的自愈**，不是重复创建。

判据：**id 里编码了创建时间**（`term-<millis>-<n>`）。跨重启出现同一个 id = 按存档
恢复；出现新时间戳 = 真的新建了一个。

## 修复

`handleNewTerminal` 里 spawn 成功后立刻 `openExistingTerminal(id)` 把它接进布局。
两个注意点：

1. 附着路径（`hasTerminal` 为真 → 画快照）**刻意不 re-fit**（`TerminalInstance.tsx`
   393-398 的注释解释了这是为了消除鬼影），所以新终端会停在 spawn 时的 80×24。
   要补一次实测尺寸：轮询等 `terminalRefs.get(id)` 出现 → `fit()` → `resizeTerminal`。
2. **不要**改成「先建窗格、让 TerminalInstance 去 spawn」那种更漂亮的写法来图省事 ——
   它要自己处理「没有 workspace」等一堆边界，而 `openExistingTerminal` 已经全都处理了。

## 相关：终端为什么能活过 app 关闭

`src-tauri/crates/app/src/lib.rs` 的 `CloseRequested`：有终端时 `api.prevent_close()`
并发 `daemon-close-prompt` → 前端 `CloseDialog`。里面 **「隐藏到托盘」只 hide 窗口，
终端全部继续运行**（daemon/pty-host 是独立进程）；**「全部终止并退出」**才是清理路径。

排查此类问题时，这个对话框就是「用户以为关了、其实没关」的答案。
