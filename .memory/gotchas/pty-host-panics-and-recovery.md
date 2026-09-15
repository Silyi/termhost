---
updated: 2026-09-16
tags: [gotcha, pty-host, panic, crash, recovery, logging]
related: [[daemon-architecture], [pty-host-console-window], [popout-raw-pipe]]
---
# pty-host 会 panic，而 daemon 现在会自己恢复

## 现象

用户点「新建终端」得到：

```
新建终端失败：管道正在被关闭。 (os error 232)
```

`os error 232` = `ERROR_NO_DATA`。这是**转述**来的错误：app→daemon 的管道是好的，
是 daemon 去写 pty-host 的管道时对面已关，于是 daemon 把它当失败回传给 app。

## 根因：pty-host panic 后 abort

WER 里的证据：

```
Faulting application: pty-host.exe
Exception code: 0xc0000409        ← STATUS_STACK_BUFFER_OVERRUN 家族
异常数据 (Exception data): 7      ← FAST_FAIL_FATAL_APP_EXIT = abort()
Fault offset: 0x62fb5
```

`panic = "abort"` 下，**任何一次 Rust panic 都会立刻 abort 整个进程**。所以这就是
一次 panic —— 而且是**确定性**的：两次崩溃（09-14 23:51、09-15 14:05，两个不同的
构建时间戳）**故障偏移完全相同**。所以不是内存不稳之类的随机损坏。

**panic 的具体位置仍未查明。** 加日志之前根本无法查：pty-host 的 stderr 指向一个
被 `CREATE_NO_WINDOW` 隐藏的控制台，panic 信息直接丢失，只剩下 WER 的异常码。

### 待查清：疑似与「0 尺寸 resize」有关（未证实）

一个符合「确定性 + 固定位置」的候选：`portable-pty` 的 `PtySize{cols:0, rows:0}`。
手机端的 cols/rows 是按视口算的，**容器尺寸为 0 时（隐藏的标签页等）就可能算出 0**，
经 WS `resize` 送进 pty-host 的 `Resize`/`LockSize` → 传进 ConPTY。

**未证实，不要当结论。** 验证方式：在 pty_host 的尺寸入口**钳到最小 1 并在钳位时记日志**
—— 若 panic 消失且日志出现钳位记录，假设成立；若 panic 继续，新日志会直接指出真凶。

## 修复（2026-09-16）

**① panic 日志**（`daemon/src/panic_log.rs`）—— 两个二进制都装：

- 写入 `%LOCALAPPDATA%\TermHost\<name>.log`，含时间戳、线程名、`文件:行号`、panic 消息
- hook 在 abort **之前**运行，所以 `panic = "abort"` 下这是唯一的机会
- 无新增依赖，时间戳自己格式化（UTC，已单测）
- 日志内容**保持纯 ASCII**：破折号也用 `-`，否则 PowerShell 5.1 / findstr 读起来是乱码
  （文件本身是合法 UTF-8，是读取端的问题——但没必要给人添麻烦）

**② daemon 自愈**（`main.rs` 的 `supervise_pty_host`）：

- reader 任务在管道断开时：**清空 pending**（让在途请求立刻失败，而不是永远挂着——
  请求至今没有超时）、记日志、`notify_one` 唤醒 supervisor
- supervisor：清掉所有死终端的状态（infos/buffers/screens/sizes/remote_allowed、
  以及原先漏掉的 active_clients）→ 广播 `TerminalsChanged` → 重连（`connect_pipe`
  本来就会在 pty-host 不在时拉起它）→ 退避重试（pty-host 可能崩溃循环，别转圈）
- **复用同一个 `PtyHostClient` 对象**而不是新建：`DaemonState.pty_client` 是 `OnceCell`，
  换不了。所以 `writer` 改成了 `Option`，可以就地替换
- 回调由 `pty_host_callbacks()` 工厂重建（`connect`/`reconnect` 每次都要传）

### 为什么不能让 daemon 直接 exit

「检测到 pty-host 死了就退出、让 app 拉起」听起来更简单，但**会破坏手机远程访问**：
app 没开、只有手机在用的时候，daemon 一退就没人拉它起来了。重连才能保住 daemon。

## 实测验证（杀掉 pty-host）

```
[2026-09-15T16:39:37Z] pty-host connection lost - every terminal it owned is gone
[2026-09-15T16:39:37Z] pty-host died - resetting terminal state and reconnecting
[2026-09-15T16:39:38Z] pty-host reconnected
```

新 pty-host 约 1 秒内出现，**daemon 存活**、:9090 继续服务（手机不受影响）。
最后那行「reconnected」本身就证明对新 pty-host 完成了一次请求-应答往返
（重连后会 List 一次）。

## 关键教训

**没有日志的后台进程，崩溃就是不可查的。** 这条原本列在
[[pty-host-console-window]] 的待办里，2026-09-16 落地。以后任何后台进程的
stderr 被隐藏时，第一件事就是给它一个文件日志。
