//! termhost-bridge —— 把 termhost 的某个终端"弹出"到一个真实控制台窗口
//! （Windows Terminal 标签页，或一个普通 cmd 窗口）。
//!
//! 数据面：`\\.\pipe\termhost-raw-<id>`（服务端见 `daemon/src/raw_pipe.rs`）。
//! 纯字节流、没有分帧：连上后先收到该终端的存量缓冲（所以窗口里看到的是当前
//! 屏幕而不是一片空白），此后**我们写进去的字节 → PTY 的 stdin，PTY 的输出 →
//! 我们读到的字节**。同一个终端同一时刻只接受一个连接。
//!
//! 控制面：`\\.\pipe\termhost-pty-v1`（daemon 常规的 JSON 分帧协议）。raw 管道
//! 没有尺寸通道，所以"这个窗口有多大"只能通过这里用 `DaemonRequest::Resize`
//! 声明 —— 否则 PTY 会一直按它原来的尺寸换行，弹出窗口里就是一团乱码。
//!
//! 终端 id 的来源：环境变量 `TERMHOST_TERM_ID` 优先（`termhost-bridge-wrapper.cmd`
//! 就是这么把它从 WT 的 %1 传进来的），其次是 `argv[1]`。两者都没有时列出
//! 当前可弹出的终端并非零退出。

use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::ptr;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use termhost_shared::protocol::{encode_message, DaemonRequest};

// --------------------------------------------------------------- Win32 绑定
//
// 这个 crate 没有 windows-sys 依赖，也不打算为一个控制台模式再引一个。按
// `daemon/src/pty_host.rs` 里 CreateMutexW 的做法手写 extern 块，只声明真正
// 用到的函数。

#[allow(non_camel_case_types)]
type HANDLE = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(n_std_handle: u32) -> HANDLE;
    fn GetConsoleMode(h: HANDLE, mode: *mut u32) -> i32;
    fn SetConsoleMode(h: HANDLE, mode: u32) -> i32;
    fn GetConsoleScreenBufferInfo(h: HANDLE, info: *mut ConsoleScreenBufferInfo) -> i32;
    fn GetConsoleCP() -> u32;
    fn SetConsoleCP(code_page: u32) -> i32;
    fn GetConsoleOutputCP() -> u32;
    fn SetConsoleOutputCP(code_page: u32) -> i32;
    fn SetConsoleCtrlHandler(handler: Option<HandlerRoutine>, add: i32) -> i32;
    fn PeekNamedPipe(
        h: HANDLE,
        buf: *mut c_void,
        buf_size: u32,
        read: *mut u32,
        avail: *mut u32,
        left: *mut u32,
    ) -> i32;
    fn GetLastError() -> u32;
}

/// `(DWORD)-10` / `(DWORD)-11`
const STD_INPUT_HANDLE: u32 = -10i32 as u32;
const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;

/// `PHANDLER_ROUTINE`
type HandlerRoutine = unsafe extern "system" fn(ctrl_type: u32) -> i32;

// --- 控制台控制事件（HandlerRoutine 的 dwCtrlType）---
const CTRL_C_EVENT: u32 = 0;
const CTRL_BREAK_EVENT: u32 = 1;
const CTRL_CLOSE_EVENT: u32 = 2;
const CTRL_LOGOFF_EVENT: u32 = 5;
const CTRL_SHUTDOWN_EVENT: u32 = 6;

// --- 输入模式位（GetConsoleMode 的输入句柄那一套）---
const ENABLE_PROCESSED_INPUT: u32 = 0x0001; // Ctrl+C 交给我们当字节，不要转成信号
const ENABLE_LINE_INPUT: u32 = 0x0002; // 不要按行缓冲，按键要立刻到
const ENABLE_ECHO_INPUT: u32 = 0x0004; // 不要回显：回显由对面 PTY 里的程序负责
const ENABLE_WINDOW_INPUT: u32 = 0x0008; // 尺寸靠轮询，不走输入事件
const ENABLE_MOUSE_INPUT: u32 = 0x0010; // 鼠标交给对面程序（它自己发 VT 鼠标序列）
const ENABLE_QUICK_EDIT_MODE: u32 = 0x0040; // 否则点一下窗口就把输出冻住
const ENABLE_EXTENDED_FLAGS: u32 = 0x0080; // 上面那一位要被承认必须先置这一位
const ENABLE_VIRTUAL_TERMINAL_INPUT: u32 = 0x0200; // 按键 → VT 字节序列

// --- 输出模式位 ---
const ENABLE_PROCESSED_OUTPUT: u32 = 0x0001; // VT 处理依赖它，必须保留
const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004; // 让控制台自己解释 escape

const UTF8_CODE_PAGE: u32 = 65001;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Coord {
    x: i16,
    y: i16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SmallRect {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
}

/// `CONSOLE_SCREEN_BUFFER_INFO`
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ConsoleScreenBufferInfo {
    size: Coord,
    cursor_position: Coord,
    attributes: u16,
    window: SmallRect,
    maximum_window_size: Coord,
}

fn invalid_handle() -> HANDLE {
    -1isize as HANDLE
}

fn valid(h: HANDLE) -> bool {
    !h.is_null() && h != invalid_handle()
}

// ------------------------------------------------------------------ 模式还原
//
// 这是整个程序最不能出错的地方：把用户的控制台留在"无回显、无行输入"的原始
// 模式里，等于把人家手边的终端弄坏，而且很难自己救回来。所以：
//
//   1. 改动**之前**先把原值存进全局 `SAVED`；
//   2. `restore_console()` 幂等（take 走 Option，第二次调用什么也不做）；
//   3. 所有正常/异常退出路径都显式调用 `exit_clean()`；
//   4. `ConsoleGuard::drop` 兜住 main 提前 return；
//   5. panic hook 兜住 panic —— release profile 是 `panic = "abort"`，析构函数
//      不会跑，但 panic hook 会在 abort 之前跑，所以这一层是必要的。

/// 句柄存成 `isize` 而不是 `*mut c_void` —— 裸指针不是 `Send`，放不进 `static`。
#[derive(Default)]
struct SavedModes {
    input: Option<(isize, u32)>,
    output: Option<(isize, u32)>,
    in_code_page: Option<u32>,
    out_code_page: Option<u32>,
}

static SAVED: Mutex<Option<SavedModes>> = Mutex::new(None);

fn restore_console() {
    let saved = {
        let mut slot = SAVED.lock().unwrap_or_else(|e| e.into_inner());
        slot.take()
    };
    let Some(saved) = saved else { return };
    unsafe {
        if let Some((h, mode)) = saved.input {
            SetConsoleMode(h as HANDLE, mode);
        }
        if let Some((h, mode)) = saved.output {
            SetConsoleMode(h as HANDLE, mode);
        }
        if let Some(cp) = saved.in_code_page {
            SetConsoleCP(cp);
        }
        if let Some(cp) = saved.out_code_page {
            SetConsoleOutputCP(cp);
        }
    }
}

struct ConsoleGuard;

impl Drop for ConsoleGuard {
    fn drop(&mut self) {
        restore_console();
    }
}

/// 控制台控制事件（Ctrl+Break、关窗口、注销、关机）的处理程序。
///
/// 这几条是**唯一**绕过 `exit_clean()` 的退出路径，而且全都真实存在：
/// `ENABLE_PROCESSED_INPUT` 被清掉之后 Ctrl+C 不再产生 CTRL_C_EVENT（它要当
/// 0x03 转发给 PTY），真实控制台句柄的 `stdin.read()` 也几乎不会返回 `Ok(0)`，
/// 所以 `pump` 里那条 `!stdin_open` 分支实际到不了 —— 用户剩下的退出手段就是
/// Ctrl+Break / 关窗口 / 任务管理器。
///
/// 在 WT 标签页里这无害（控制台跟着一起死），但在 `termhost-popout.cmd` 的
/// 普通控制台回退分支里，bridge 跑的是**调用者自己的控制台** —— 不还原就等于
/// 把用户的 shell 留成无回显、无行输入。所以这里无条件先还原。
///
/// 返回 FALSE（0）= 不吞掉事件，还原之后让默认处理继续，该终止就终止
/// （绝不能返回 TRUE，那会让关窗口/关机被无限期拖住）。
unsafe extern "system" fn console_ctrl_handler(ctrl_type: u32) -> i32 {
    match ctrl_type {
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT
        | CTRL_SHUTDOWN_EVENT => restore_console(),
        _ => {}
    }
    0
}

/// 先还原控制台，再退出。所有离开 main 的路径都走这里 ——
/// `std::process::exit` 不跑析构函数，光靠 `ConsoleGuard` 不够。
fn exit_clean(code: i32) -> ! {
    restore_console();
    std::process::exit(code);
}

fn last_error() -> std::io::Error {
    std::io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

/// 输入句柄要切成的模式：清掉"控制台替我们加工输入"的那几位，只留 VT 输入。
/// 按键（含方向键、Ctrl 组合）于是原样变成字节，我们直接转发给 PTY。
fn raw_input_mode(mode: u32) -> u32 {
    (mode
        & !(ENABLE_ECHO_INPUT
            | ENABLE_LINE_INPUT
            | ENABLE_PROCESSED_INPUT
            | ENABLE_MOUSE_INPUT
            | ENABLE_WINDOW_INPUT
            | ENABLE_QUICK_EDIT_MODE))
        | ENABLE_EXTENDED_FLAGS
        | ENABLE_VIRTUAL_TERMINAL_INPUT
}

/// 输出句柄要切成的模式：加上 VT 处理，其余位一律保留
/// （尤其是 ENABLE_PROCESSED_OUTPUT —— VT 处理离开它不生效）。
fn vt_output_mode(mode: u32) -> u32 {
    mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING
}

/// 把控制台切到原始 VT 模式。返回的 guard 是兜底，不是主路径。
fn install_console() -> ConsoleGuard {
    unsafe {
        let hin = GetStdHandle(STD_INPUT_HANDLE);
        let hout = GetStdHandle(STD_OUTPUT_HANDLE);

        // 先读原值并落盘，再去改 —— 中间任何一步失败都还能原样还原。
        let mut saved = SavedModes::default();
        if valid(hin) {
            let mut m = 0u32;
            if GetConsoleMode(hin, &mut m) != 0 {
                saved.input = Some((hin as isize, m));
            }
        }
        if valid(hout) {
            let mut m = 0u32;
            if GetConsoleMode(hout, &mut m) != 0 {
                saved.output = Some((hout as isize, m));
            }
        }

        let on_console = saved.input.is_some() || saved.output.is_some();
        if on_console {
            // 对面 ConPTY 吐出来的是 UTF-8（raw_pipe 里就是按 UTF-8 处理的），
            // 而控制台默认用系统 ANSI 代码页（本机 zh-CN 是 936）解码 —— 不对齐
            // 就会把中文和框线全解成乱码。VT 转义序列本身是 ASCII，所以这个
            // 只在有非 ASCII 输出时才看得出问题。
            let cp_in = GetConsoleCP();
            if cp_in != 0 {
                saved.in_code_page = Some(cp_in);
            }
            let cp_out = GetConsoleOutputCP();
            if cp_out != 0 {
                saved.out_code_page = Some(cp_out);
            }
        }

        if !on_console {
            print_no_console();
            return ConsoleGuard;
        }

        // 落盘要在改之前，但读完之后 saved 就被移走了 —— 先把后面还要用的
        // "有哪些代码页要改"两个布尔量取出来。
        let has_in_cp = saved.in_code_page.is_some();
        let has_out_cp = saved.out_code_page.is_some();
        let apply = (saved.input, saved.output);
        {
            let mut slot = SAVED.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(saved);
        }

        // 原值已经落盘，立刻装上控制事件处理程序：Ctrl+Break / 关窗口这些路径
        // 不走 exit_clean，也不跑析构，只能靠它还原。
        if SetConsoleCtrlHandler(Some(console_ctrl_handler), 1) == 0 {
            eprintln!(
                "termhost-bridge: SetConsoleCtrlHandler failed: {} — \
                 Ctrl+Break or closing the window may leave the console in raw mode",
                last_error()
            );
        }

        if let Some((h, mode)) = apply.0 {
            if SetConsoleMode(h as HANDLE, raw_input_mode(mode)) == 0 {
                eprintln!("termhost-bridge: SetConsoleMode(stdin) failed: {}", last_error());
            }
        }

        if let Some((h, mode)) = apply.1 {
            // ENABLE_PROCESSED_OUTPUT 关掉时 VT 处理不生效，PTY 的 escape 会当普通
            // 字符原样打出来。原样保留意味着正常情况不会走到这里，但值得喊一声。
            if mode & ENABLE_PROCESSED_OUTPUT == 0 {
                eprintln!(
                    "termhost-bridge: ENABLE_PROCESSED_OUTPUT is off — \
                     escape sequences may be printed literally"
                );
            }
            if SetConsoleMode(h as HANDLE, vt_output_mode(mode)) == 0 {
                eprintln!("termhost-bridge: SetConsoleMode(stdout) failed: {}", last_error());
            }
        }

        if has_in_cp && SetConsoleCP(UTF8_CODE_PAGE) == 0 {
            eprintln!("termhost-bridge: SetConsoleCP(65001) failed: {}", last_error());
        }
        if has_out_cp && SetConsoleOutputCP(UTF8_CODE_PAGE) == 0 {
            eprintln!("termhost-bridge: SetConsoleOutputCP(65001) failed: {}", last_error());
        }
    }

    ConsoleGuard
}

fn print_no_console() {
    eprintln!(
        "termhost-bridge: no console attached to stdin/stdout — \
         the terminal is relayed as raw bytes, escape sequences will NOT be interpreted"
    );
}

// ------------------------------------------------------------------ 终端 id

const RAW_PIPE_PREFIX: &str = "termhost-raw-";

/// 枚举 `\\.\pipe\termhost-raw-*`，返回其后的终端 id（已排序）。
fn list_terminals() -> Vec<String> {
    let mut ids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(id) = name.to_string_lossy().strip_prefix(RAW_PIPE_PREFIX) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids
}

fn raw_pipe_path(id: &str) -> String {
    format!(r"\\.\pipe\{RAW_PIPE_PREFIX}{id}")
}

/// `TERMHOST_TERM_ID` → `argv[1]` → 列出可用终端并非零退出。
fn resolve_term_id() -> Option<String> {
    if let Ok(v) = std::env::var("TERMHOST_TERM_ID") {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    if let Some(a) = std::env::args().nth(1) {
        let a = a.trim();
        if !a.is_empty() && !a.starts_with('-') {
            return Some(a.to_string());
        }
    }

    let ids = list_terminals();
    if ids.is_empty() {
        eprintln!("termhost-bridge: no terminal id given, and no terminal is currently running.");
    } else {
        eprintln!("termhost-bridge: no terminal id given. Terminals you can pop out:");
        for id in &ids {
            eprintln!("  {id}");
        }
    }
    eprintln!();
    eprintln!("usage: termhost-bridge <terminal-id>");
    eprintln!("   or: set TERMHOST_TERM_ID=<terminal-id> and run it without arguments");
    None
}

// ------------------------------------------------------------------ 尺寸主张

/// daemon 的常规 IPC 管道 —— 只有它能把尺寸告诉 PTY。
const DAEMON_PIPE: &str = r"\\.\pipe\termhost-pty-v1";

const SIZE_POLL_INTERVAL: Duration = Duration::from_millis(400);

/// 等 daemon 回执的上限。回执只是礼数（见 `claim_size`），等不到就放手。
const CLAIM_ACK_TIMEOUT: Duration = Duration::from_millis(1000);
const CLAIM_ACK_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// 当前可见窗口的 `(cols, rows)`；不在控制台上时返回 `None`。
fn console_size() -> Option<(u16, u16)> {
    unsafe {
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        if !valid(h) {
            return None;
        }
        let mut info = ConsoleScreenBufferInfo::default();
        if GetConsoleScreenBufferInfo(h, &mut info) == 0 {
            return None;
        }
        // 用可见窗口（srWindow）而不是缓冲区（dwSize）：开了回滚的 conhost 里
        // 缓冲区会比窗口高得多，拿它当 rows 会把 PTY 的行数撑爆。
        let mut cols = info.window.right as i32 - info.window.left as i32 + 1;
        let mut rows = info.window.bottom as i32 - info.window.top as i32 + 1;
        if cols <= 0 || rows <= 0 {
            cols = info.size.x as i32;
            rows = info.size.y as i32;
        }
        if cols <= 0 || rows <= 0 {
            return None;
        }
        Some((cols as u16, rows as u16))
    }
}

/// 经 daemon 的 pty-v1 管道声明一次尺寸。
///
/// 每次开一条新连接、发一帧、读完回执就关：这条管道给**每个**连接都无条件
/// 推送所有终端的输出，长连就等于白白抄一份全量输出；而尺寸声明是稀疏事件
/// （只在窗口被拖动时发生），重连的开销可以忽略。连接关闭不会让 daemon 丢掉
/// 我们的主张 —— Resize 分支内部已经 resize + 记录 + lock_size 了。
fn claim_size(id: &str, cols: u16, rows: u16) -> std::io::Result<()> {
    let req = DaemonRequest::Resize { seq: 1, id: id.to_string(), cols, rows };
    let frame = encode_message(&req)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(DAEMON_PIPE)?;
    pipe.write_all(&frame)?;
    pipe.flush()?;

    // 帧发出去了就算主张成功：daemon 的 Resize 分支是**先 resize 再回执**的
    // （main.rs 的 Resize arm），所以回执只是给它一个"写成功"的机会，我们并不看
    // 内容；我们这边先关连接会让它的写入撞上 ERROR_NO_DATA，平白让一条连接任务
    // 报错退出，所以才顺手读一下。
    //
    // 读必须是**有上限**的：Resize 会 await `PtyHostClient::request`，而那里的
    // `rx.await` 没有超时（pty_client.rs:101），pty-host 卡住时 daemon 就一直不回。
    // 无超时的 read_exact 会把调用方（尺寸轮询线程）永远钉死，于是这个窗口的尺寸
    // 主张从此再也不会更新 —— 正是本功能要消灭的那种静默挂死。用 PeekNamedPipe
    // 问一声再读，超时就放弃这一轮（下个 tick 会重来）。
    let handle = pipe.as_raw_handle() as HANDLE;
    let deadline = Instant::now() + CLAIM_ACK_TIMEOUT;
    let mut discard = [0u8; 256];
    loop {
        let mut avail: u32 = 0;
        if unsafe {
            PeekNamedPipe(handle, ptr::null_mut(), 0, ptr::null_mut(), &mut avail, ptr::null_mut())
        } == 0
        {
            break; // 连接断了，无所谓 —— 请求已经发出去了
        }
        if avail > 0 {
            let _ = pipe.read(&mut discard);
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(CLAIM_ACK_POLL_INTERVAL);
    }
    Ok(())
}

/// 轮询窗口尺寸，变了就重新主张一次。
///
/// 故意不去解析 INPUT_RECORD 的窗口事件：那要求把 `ENABLE_WINDOW_INPUT` 打开、
/// 再把非按键记录从字节流里挑出去，而尺寸声明根本不是热路径 —— 几百毫秒的
/// 延迟换掉一整类"把窗口事件当按键发给 PTY"的 bug，很划算。
///
/// **这个线程是尺寸主张的唯一入口**（包括第一次）：它绝不跑在 `pump` 之前的
/// 关键路径上，所以 claim 里的任何阻塞都换不来一个"窗口全黑"的弹出窗。
/// `last` 记的是**上一次真正主张成功的尺寸**，不是测量到的尺寸 —— 主张失败时
/// 必须保持 `None`，否则第一次失败之后这个线程会认为"已经主张过了"而永远跳过，
/// PTY 就整场停在旧尺寸上按错误宽度折行，只能靠用户手动拖一下窗口来救。
fn poll_size(id: String) {
    let mut last: Option<(u16, u16)> = None;
    let mut warned = false;
    loop {
        // 先主张再睡：线程一起来就按当前尺寸对齐，PTY 不必等一个轮询周期
        if let Some(size) = console_size() {
            if last != Some(size) {
                match claim_size(&id, size.0, size.1) {
                    Ok(()) => {
                        last = Some(size);
                        warned = false;
                    }
                    Err(e) => {
                        // 只报一次：daemon 没在跑的时候别每 400ms 刷一行。
                        // last 保持 None，下一个 tick 会重试。
                        if !warned {
                            eprintln!("termhost-bridge: could not claim {size:?} for {id}: {e}");
                            warned = true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(SIZE_POLL_INTERVAL);
    }
}

// ------------------------------------------------------------------ 中继
//
// 键盘和终端输出**不能**各用一个线程去碰同一个管道句柄。Windows 的同步管道句柄
// 是把 I/O 串行化的：一个线程阻塞在 ReadFile 上时，另一个线程对同一个管道
// （哪怕是 DuplicateHandle 出来的另一个句柄 —— 同一个 file object）的写入会一直
// 排队，直到那个读完成。实测就是这样：stdin 明明读到了 23 字节，write 却永远
// 挂在那里（见 .superpowers/b2-report.md 的验证记录）。
//
// 所以管道只由 pump 一个线程碰：先用 PeekNamedPipe 问"有数据吗"，有才读 —— 读
// 因此永不阻塞，也就永远挡不住写。stdin 那一侧是另一个句柄（控制台输入缓冲），
// 不受这条约束，照旧用阻塞读，读到的块通过 channel 交给 pump 发出去。

const PIPE_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// 键盘线程：阻塞读 stdin，把读到的块丢给 pump。
/// 返回（stdin 结束）时 sender 被 drop，pump 收到 Disconnected 后收工。
fn read_stdin(tx: std::sync::mpsc::Sender<Vec<u8>>) {
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 1024];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// `buf[..n]` 里可以安全交给控制台的长度。
///
/// 控制台是**按每次 WriteFile 独立解码**的（代码页 65001）：一次写到一半的
/// UTF-8 序列没有合法表示，conhost 会把它渲染成 U+FFFD，而且那半个序列已经
/// 被吃掉了，下一次写过来的后续字节同样解不出来 —— 一个汉字变成两个乱码方块。
/// 而 `raw_pipe.rs` 连上来第一件事就是把整个存量缓冲（上限 8 MB）一次性写出来，
/// 所以首屏**必然**要跨过大量 8192 字节边界。
///
/// 返回值和 `n` 之间那段（长度 ≤ 3）是残缺的尾序列，交给调用方留到下一次写。
fn complete_utf8_prefix(buf: &[u8], n: usize) -> usize {
    // UTF-8 序列最长 4 字节，所以只看最后 3 个字节就够了
    let floor = n.saturating_sub(3);
    let mut i = n;
    while i > floor {
        i -= 1;
        let b = buf[i];
        if b & 0xC0 != 0x80 {
            // 不是续字节 —— 这里是某个序列的首字节（或 ASCII）
            let len = match b {
                0x00..=0x7F => 1,
                0xC0..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF7 => 4,
                // 非法首字节（0x80..=0xBF 已在上面排除，这里是 0xF8..=0xFF）：
                // 不猜，原样交出去
                _ => return n,
            };
            return if i + len <= n { n } else { i };
        }
    }
    // 连续 4 个以上续字节：不是合法 UTF-8，原样交出去，别在这里卡住
    n
}

/// 唯一碰管道句柄的线程：既发键盘输入，也收终端输出。
fn pump(mut pipe: std::fs::File, rx: Receiver<Vec<u8>>) -> std::io::Result<()> {
    let handle = pipe.as_raw_handle() as HANDLE;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut buf = vec![0u8; 8192];
    // 上一轮扣下的、跨在缓冲区边界上的半个 UTF-8 序列：就住在 `buf[0..pending]`，
    // 下一轮读进来的字节接在它后面。**必须留在 buf 里**（当初写成独立的 Vec，
    // 读的时候忘了把字节搬回 buf 头部，于是 buf[0] 是上一轮的陈旧字节 —— 被
    // 当作 carry 写了出去，真正的半个字符反而丢了；跨边界单测抓到了这个）。
    let mut pending = 0usize;
    let mut stdin_open = true;

    loop {
        // 1) 先把攒下的键盘输入发出去（此刻管道上没有挂着的读）
        if stdin_open {
            loop {
                match rx.try_recv() {
                    Ok(chunk) => {
                        pipe.write_all(&chunk)?;
                        pipe.flush()?;
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        stdin_open = false;
                        break;
                    }
                }
            }
        }

        // 2) 再看管道有没有输出。PeekNamedPipe 说没有就不读 —— 这是整个设计的关键：
        //    只要不发起会阻塞的读，写就不会被它挡住。
        let mut avail: u32 = 0;
        let ok = unsafe {
            PeekNamedPipe(handle, ptr::null_mut(), 0, ptr::null_mut(), &mut avail, ptr::null_mut())
        };
        if ok == 0 {
            // 服务端关了这条连接（daemon 重启/终端被杀）：诚实报错退出，
            // 而不是留一个不动的窗口在那儿。
            return Err(last_error());
        }
        if avail > 0 {
            // buf[0..pending] 是上一轮留着的前缀，新数据接在它后面
            let n = pipe.read(&mut buf[pending..])?;
            if n == 0 {
                return Ok(());
            }
            let total = pending + n;
            // 残缺的尾序列扣住不写：控制台按每次写独立解码 UTF-8，切开就是乱码
            let safe = complete_utf8_prefix(&buf[..total], total);
            out.write_all(&buf[..safe])?;
            // Rust 的 stdout 是行缓冲：不含换行的输出（提示符、进度条、TUI）
            // 必须显式 flush，否则要等到下一个换行才看得见。
            out.flush()?;
            // 把没写出去的半截挪到缓冲最前面（copy_within 是 memmove，重叠安全）
            buf.copy_within(safe..total, 0);
            pending = total - safe;
            continue; // 立刻回头再查一次，把积压的输出读干净
        }

        // stdin 已经结束：把管道里的余量排完之后收工
        if !stdin_open {
            let _ = out.flush();
            return Ok(());
        }

        std::thread::sleep(PIPE_POLL_INTERVAL);
    }
}

fn main() {
    let Some(id) = resolve_term_id() else {
        std::process::exit(2);
    };

    let _guard = install_console();
    std::panic::set_hook(Box::new(|info| {
        // panic = "abort" 下析构不会跑，但 hook 会 —— 还原只能挂在这里
        restore_console();
        eprintln!("termhost-bridge: internal error: {info}");
    }));

    // 先连接再声明尺寸：连不上说明 id 是错的（或者已经有另一个窗口占着这个终端，
    // raw_pipe 一次只服务一个连接），这时报错比默默调整尺寸有用得多。
    let pipe = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(raw_pipe_path(&id))
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("termhost-bridge: cannot open {}: {e}", raw_pipe_path(&id));
            // 运行时的用户可见信息一律用 ASCII：控制台可能还是系统 ANSI 代码页，
            // 中文会变成乱码（与 pty_host.rs 的约定一致：注释中文、消息英文）。
            eprintln!("(no such terminal, or another window already holds it - the raw pipe serves one client at a time)");
            let ids = list_terminals();
            if ids.is_empty() {
                eprintln!("currently no terminal is running");
            } else {
                eprintln!("available terminals:");
                for t in ids {
                    eprintln!("  {t}");
                }
            }
            exit_clean(3);
        }
    };

    // 尺寸主张全部交给轮询线程（含第一次），而且**必须**在 pump 之前只花一次
    // spawn 的时间：claim 要经 daemon 转 pty-host，链路上任何一环卡住都能把它
    // 拖上很久，同步跑在这里就等于让窗口一直什么都不显示 —— 比报错更糟。
    // 轮询线程一起来就先主张一次，所以 PTY 仍然在首屏之前对齐。
    {
        let id = id.clone();
        std::thread::spawn(move || poll_size(id));
    }

    // 键盘走独立线程（stdin 是另一个句柄），管道句柄只交给 pump 一个线程
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || read_stdin(tx));

    match pump(pipe, rx) {
        Ok(()) => exit_clean(0),
        Err(e) => {
            eprintln!("termhost-bridge: raw pipe ended: {e}");
            exit_clean(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_pipe_path_matches_the_server() {
        // 服务端 raw_pipe.rs 里是 format!(r"\\.\pipe\termhost-raw-{}", term_id)
        assert_eq!(raw_pipe_path("term-42"), r"\\.\pipe\termhost-raw-term-42");
    }

    #[test]
    fn list_terminals_strips_the_prefix() {
        // 只验证前缀剥离逻辑本身；命名空间里有什么取决于机器状态
        const NAME: &str = "termhost-raw-term-7";
        assert_eq!(NAME.strip_prefix(RAW_PIPE_PREFIX), Some("term-7"));
    }

    #[test]
    fn list_terminals_ignores_foreign_pipes() {
        const NAME: &str = "termhost-pty-v1";
        assert_eq!(NAME.strip_prefix(RAW_PIPE_PREFIX), None);
    }

    #[test]
    fn invalid_handle_is_recognised() {
        assert!(!valid(invalid_handle()));
        assert!(!valid(std::ptr::null_mut()));
    }

    /// 位运算测试是**自指**的：`TYPICAL_INPUT_MODE` 用同一批常量拼出来，
    /// 所以它能证明"清位/置位的逻辑对"，但**证明不了常量本身是对的值**。
    /// 常量的值由下面 `mode_constants_match_wincon_h` 逐个对着 wincon.h 钉住。
    const TYPICAL_INPUT_MODE: u32 = ENABLE_PROCESSED_INPUT
        | ENABLE_LINE_INPUT
        | ENABLE_ECHO_INPUT
        | ENABLE_MOUSE_INPUT
        | ENABLE_WINDOW_INPUT
        | ENABLE_QUICK_EDIT_MODE
        | 0x0010_0000; // 无关的位，必须原样留着

    /// 常量值直接照 wincon.h 抄成字面量：任何一处被改错都会在这里断掉。
    /// （改 bridge.rs 里的定义时，这个测试必须**一起**改 —— 这正是它的用途。）
    #[test]
    fn mode_constants_match_wincon_h() {
        // 输入
        assert_eq!(ENABLE_PROCESSED_INPUT, 0x0001);
        assert_eq!(ENABLE_LINE_INPUT, 0x0002);
        assert_eq!(ENABLE_ECHO_INPUT, 0x0004);
        assert_eq!(ENABLE_WINDOW_INPUT, 0x0008);
        assert_eq!(ENABLE_MOUSE_INPUT, 0x0010);
        assert_eq!(ENABLE_QUICK_EDIT_MODE, 0x0040);
        assert_eq!(ENABLE_EXTENDED_FLAGS, 0x0080);
        assert_eq!(ENABLE_VIRTUAL_TERMINAL_INPUT, 0x0200);
        // 输出
        assert_eq!(ENABLE_PROCESSED_OUTPUT, 0x0001);
        assert_eq!(ENABLE_VIRTUAL_TERMINAL_PROCESSING, 0x0004);
        // 控制事件
        assert_eq!(CTRL_C_EVENT, 0);
        assert_eq!(CTRL_BREAK_EVENT, 1);
        assert_eq!(CTRL_CLOSE_EVENT, 2);
        assert_eq!(CTRL_LOGOFF_EVENT, 5);
        assert_eq!(CTRL_SHUTDOWN_EVENT, 6);
        // 其它
        assert_eq!(STD_INPUT_HANDLE, (-10i32) as u32);
        assert_eq!(STD_OUTPUT_HANDLE, (-11i32) as u32);
        assert_eq!(UTF8_CODE_PAGE, 65001);
    }

    /// 结构体按 wincon.h 手抄，布局错了 GetConsoleScreenBufferInfo 会往错误的
    /// 偏移写。22 = 4(COORD) + 4(COORD) + 2(WORD) + 8(SMALL_RECT) + 4(COORD)。
    #[test]
    fn screen_buffer_info_layout_matches_wincon_h() {
        assert_eq!(std::mem::size_of::<Coord>(), 4);
        assert_eq!(std::mem::size_of::<SmallRect>(), 8);
        assert_eq!(std::mem::size_of::<ConsoleScreenBufferInfo>(), 22);
        assert_eq!(std::mem::align_of::<ConsoleScreenBufferInfo>(), 2);
    }

    #[test]
    fn utf8_prefix_keeps_ascii_whole() {
        let buf = b"hello";
        assert_eq!(complete_utf8_prefix(buf, buf.len()), 5);
    }

    /// 4 个汉字的 UTF-8 是 12 字节；在第 10 个字节处切断会落在一个字中间
    /// （"中" = E4 B8 AD，"文" = E6 96 87）
    #[test]
    fn utf8_prefix_holds_back_a_split_character() {
        let s = "中文中文".as_bytes();
        assert_eq!(s.len(), 12);
        for cut in 1..s.len() {
            let safe = complete_utf8_prefix(s, cut);
            assert!(safe <= cut);
            assert!(
                std::str::from_utf8(&s[..safe]).is_ok(),
                "cut={cut} safe={safe} 不是合法的 UTF-8 前缀"
            );
            // 扣住的部分不许超过一个序列
            assert!(cut - safe <= 3, "cut={cut} safe={safe} 扣得太多了");
        }
    }

    #[test]
    fn utf8_prefix_holds_back_a_split_four_byte_character() {
        let s = "😀".as_bytes(); // F0 9F 98 80
        assert_eq!(s.len(), 4);
        assert_eq!(complete_utf8_prefix(s, 1), 0);
        assert_eq!(complete_utf8_prefix(s, 2), 0);
        assert_eq!(complete_utf8_prefix(s, 3), 0);
        assert_eq!(complete_utf8_prefix(s, 4), 4);
    }

    #[test]
    fn utf8_prefix_does_not_stall_on_invalid_bytes() {
        // 4 个以上续字节不是合法 UTF-8：原样交出去，不许扣住
        let buf = [0x80u8, 0x80, 0x80, 0x80, 0x80];
        assert_eq!(complete_utf8_prefix(&buf, buf.len()), 5);
        // 非法首字节同理
        let buf = [b'a', 0xFF];
        assert_eq!(complete_utf8_prefix(&buf, buf.len()), 2);
    }

    #[test]
    fn raw_input_mode_clears_the_processing_bits() {
        let raw = raw_input_mode(TYPICAL_INPUT_MODE);
        for bit in [
            ENABLE_ECHO_INPUT,
            ENABLE_LINE_INPUT,
            ENABLE_PROCESSED_INPUT,
            ENABLE_MOUSE_INPUT,
            ENABLE_WINDOW_INPUT,
            ENABLE_QUICK_EDIT_MODE,
        ] {
            assert_eq!(raw & bit, 0, "bit {bit:#x} should have been cleared");
        }
    }

    #[test]
    fn raw_input_mode_enables_vt_input() {
        let raw = raw_input_mode(TYPICAL_INPUT_MODE);
        assert_ne!(raw & ENABLE_VIRTUAL_TERMINAL_INPUT, 0);
        // 清 QUICK_EDIT 必须先置 EXTENDED_FLAGS，否则那位会被忽略
        assert_ne!(raw & ENABLE_EXTENDED_FLAGS, 0);
        // 不相关的位不许被顺手改掉
        assert_ne!(raw & 0x0010_0000, 0);
    }

    #[test]
    fn vt_output_mode_keeps_processed_output() {
        const ENABLE_WRAP_AT_EOL_OUTPUT: u32 = 0x0002;
        let mode = ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT;
        let out = vt_output_mode(mode);
        assert_ne!(out & ENABLE_VIRTUAL_TERMINAL_PROCESSING, 0);
        assert_ne!(out & ENABLE_PROCESSED_OUTPUT, 0, "VT 处理依赖这一位");
        assert_ne!(out & ENABLE_WRAP_AT_EOL_OUTPUT, 0);
    }
}
