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
use std::time::Duration;

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

    // 读掉一帧再关：否则我们这边先关，daemon 那边的写入会撞上 ERROR_NO_DATA，
    // 白白让它的一条连接任务报错退出。读到的可能是回执，也可能是推流 —— 都无所谓。
    let mut len = [0u8; 4];
    if pipe.read_exact(&mut len).is_ok() {
        let n = u32::from_le_bytes(len) as usize;
        let mut discard = vec![0u8; n.min(1 << 20)];
        let _ = pipe.read_exact(&mut discard);
    }
    Ok(())
}

/// 轮询窗口尺寸，变了就重新主张一次。
///
/// 故意不去解析 INPUT_RECORD 的窗口事件：那要求把 `ENABLE_WINDOW_INPUT` 打开、
/// 再把非按键记录从字节流里挑出去，而尺寸声明根本不是热路径 —— 几百毫秒的
/// 延迟换掉一整类"把窗口事件当按键发给 PTY"的 bug，很划算。
fn poll_size(id: String, mut last: Option<(u16, u16)>) {
    let mut warned = false;
    loop {
        std::thread::sleep(SIZE_POLL_INTERVAL);
        let Some(size) = console_size() else { continue };
        if last == Some(size) {
            continue;
        }
        match claim_size(&id, size.0, size.1) {
            Ok(()) => {
                last = Some(size);
                warned = false;
            }
            Err(e) => {
                // 只报一次：daemon 没在跑的时候别每 400ms 刷一行
                if !warned {
                    eprintln!("termhost-bridge: could not claim {size:?} for {id}: {e}");
                    warned = true;
                }
            }
        }
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

/// 唯一碰管道句柄的线程：既发键盘输入，也收终端输出。
fn pump(mut pipe: std::fs::File, rx: Receiver<Vec<u8>>) -> std::io::Result<()> {
    let handle = pipe.as_raw_handle() as HANDLE;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut buf = vec![0u8; 8192];
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
            let n = pipe.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            out.write_all(&buf[..n])?;
            // Rust 的 stdout 是行缓冲：不含换行的输出（提示符、进度条、TUI）
            // 必须显式 flush，否则要等到下一个换行才看得见。
            out.flush()?;
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

    // 先按当前窗口尺寸主张一次，让 PTY 在首屏画出来之前就对齐。
    let initial_size = console_size();
    if let Some((cols, rows)) = initial_size {
        if let Err(e) = claim_size(&id, cols, rows) {
            eprintln!(
                "termhost-bridge: could not claim {cols}x{rows} for {id} (I/O still works): {e}"
            );
        }
    }

    {
        let id = id.clone();
        std::thread::spawn(move || poll_size(id, initial_size));
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

    /// 控制台的默认输入模式（行输入 + 回显 + Ctrl+C 转信号 + 鼠标 + 快速编辑）
    const TYPICAL_INPUT_MODE: u32 = ENABLE_PROCESSED_INPUT
        | ENABLE_LINE_INPUT
        | ENABLE_ECHO_INPUT
        | ENABLE_MOUSE_INPUT
        | ENABLE_WINDOW_INPUT
        | ENABLE_QUICK_EDIT_MODE
        | 0x0010_0000; // 无关的位，必须原样留着

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
