//! pty-host — owns the actual PTY processes.
//!
//! Runs as a standalone process so terminals survive `termhostd` restarts.
//! Speaks the framed-JSON protocol in `pty_ipc` over
//! `\\.\pipe\termhost-pty-host-v1`.

use std::collections::HashMap;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use termhostd::buffer::BufferManager;
use termhostd::pty_ipc::PTY_HOST_MUTEX_NAME;
use termhostd::pty_ipc::PtyHostEvent;
use termhostd::pty_ipc::PtyHostRequest;
use termhostd::pty_ipc::PtyHostTerminalInfo;
use termhostd::pty_manager::create_pty;
use termhostd::pty_manager::PtyManager;
use termhostd::screen::ScreenManager;
use tokio::sync::mpsc::UnboundedSender;

/// 输出画到的范围是否超出了手机锁定的尺寸。
///
/// `locked` 是 `(cols, rows)` —— 与协议一致（`pty_ipc.rs`）。
/// `scan` 是 `ScreenManager::scan_max_pos` 的原生返回值 `(max_row, max_col)` ——
/// 原样透传，调用点因此没有任何转换可写错。
///
/// 两者都是**1 基的占用计数**（不是 0 基下标）：等于锁定值即恰好放得下。
fn exceeds_lock(locked: (u16, u16), scan: (usize, usize)) -> bool {
    let (cols, rows) = locked;
    let (max_row, max_col) = scan;

    max_col > cols as usize || max_row > rows as usize
}

/// 把 `ScreenManager::snapshot_with_size` 的 `(data, rows, cols)`
/// 转成协议要求的 `ScreenResult { data, cols, rows }`。
fn to_screen_result(seq: u64, snap: (String, u16, u16)) -> PtyHostEvent {
    let (data, rows, cols) = snap;
    PtyHostEvent::ScreenResult { seq, data: Some(data), cols, rows }
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *mut u8, initial_owner: i32, name: *const u16) -> *mut u8;
    fn GetLastError() -> u32;
}

const ERROR_ALREADY_EXISTS: u32 = 183;

/// 抢全局互斥体。已有实例在跑时返回 `false`。
fn acquire_single_instance() -> bool {
    let name: Vec<u16> = PTY_HOST_MUTEX_NAME.encode_utf16().collect();
    unsafe {
        let h = CreateMutexW(ptr::null_mut(), 0, name.as_ptr());
        if h.is_null() {
            // 创建不了互斥体就不阻止启动 —— 若环境缺少创建 `Global\` 内核对象的
            // 权限，这里会一直失败，拒绝启动等于 pty-host 永远起不来。
            // 但这条绕行必须可见：两个 host 同时存活会瓜分 PTY 所有权。
            let err = GetLastError();
            eprintln!(
                "pty-host: CreateMutexW failed (error {err}: {}); single-instance guard disabled",
                std::io::Error::from_raw_os_error(err as i32)
            );
            // 真正的单实例把关在 Task 5：serve() 的首个实例会以
            // first_pipe_instance(true) 创建管道，若已有实例在监听同名管道，
            // 该调用会失败。所以这里的 fail-open 不是唯一防线。
            return true;
        }
        GetLastError() != ERROR_ALREADY_EXISTS
    }
}

fn main() {
    if !acquire_single_instance() {
        // 已有实例在跑 —— 静默退出，客户端会连上那个实例
        return;
    }
    println!("pty-host up");
    // 骨架阶段：保持存活以持有互斥体（T5 会用 tokio runtime 替换这里的 main）
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

/// 客户端连接的写端。承载**已序列化的整帧**（4 字节 LE 长度 + JSON），
/// 这样一份输出可以零拷贝地发给所有连接。
type ClientTx = UnboundedSender<Vec<u8>>;

pub struct Shared {
    pub pty: Mutex<PtyManager>,
    pub screen: Mutex<ScreenManager>,
    pub buffers: Mutex<BufferManager>,
    /// 手机主张的尺寸，`(cols, rows)`
    pub locks: Mutex<HashMap<String, (u16, u16)>>,
    /// 上次掰回尺寸的时间，用于 500ms 限流
    pub last_revert: Mutex<HashMap<String, Instant>>,
    pub clients: Mutex<Vec<ClientTx>>,
    /// PTY 回调线程 → 分发任务。放在这里，避免在函数间传递。
    pub out: UnboundedSender<Out>,
    /// spawn 时记下的元数据。`cwd`/`command` 供 `List` 回放 —— daemon 重启后
    /// 靠它恢复终端标签；`generation` 用于识别陈旧的退出事件。
    pub meta: Mutex<HashMap<String, TerminalMeta>>,
    pub next_generation: AtomicU64,
    /// 串行化 spawn 与 kill。子进程可能在 `create_pty` 返回**之前**就退出，它的
    /// `Out::Exit` 会与登记过程赛跑：若退出先被分发任务处理，登记随后才完成，
    /// 就会留下一个已死却被登记着的终端。持这把锁可保证"登记"与"拆除"不交错。
    pub lifecycle: Mutex<()>,
}

/// 终端实例的元数据。含 generation 是因为：一个 id 可能被杀死后重生，
/// 而旧实例的退出事件可能在新实例登记之后才被排空。
#[derive(Clone)]
pub struct TerminalMeta {
    pub cwd: String,
    pub command: String,
    pub generation: u64,
}

impl Shared {
    /// 返回共享状态与输出通道的接收端 —— 接收端由 `serve()` 拿去启动分发任务。
    pub fn new() -> (Arc<Self>, tokio::sync::mpsc::UnboundedReceiver<Out>) {
        let (out, rx) = tokio::sync::mpsc::unbounded_channel::<Out>();
        let sh = Arc::new(Self {
            pty: Mutex::new(PtyManager::new()),
            screen: Mutex::new(ScreenManager::new()),
            buffers: Mutex::new(BufferManager::new()),
            locks: Mutex::new(HashMap::new()),
            last_revert: Mutex::new(HashMap::new()),
            clients: Mutex::new(Vec::new()),
            out,
            meta: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
            lifecycle: Mutex::new(()),
        });
        (sh, rx)
    }

    /// 该 id 当前登记的 generation 是否就是 `generation`。
    /// 分发任务用它丢弃陈旧退出 —— 否则旧实例的退出会杀掉同 id 的新实例。
    pub fn is_current(&self, id: &str, generation: u64) -> bool {
        self.meta
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|m| m.generation == generation)
    }
}

/// 从 PTY 回调线程送往分发任务的事件。
pub enum Out {
    Data(String, String), // (id, utf8 chunk)
    Exit(String, u64),    // (id, generation)
}

fn spawn_terminal(
    sh: &Arc<Shared>,
    id: &str,
    cwd: &str,
    command: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // 全程持 lifecycle：从幂等检查一路到 meta 落库，中间不允许任何拆除动作插进来。
    // 否则一个瞬间退出的子进程，其 Out::Exit 会在 meta 写入前被处理，
    // is_current 把这次合法退出误判为陈旧事件丢弃，留下已死却仍被登记的终端。
    let _life = sh.lifecycle.lock().unwrap();

    // 幂等：同 id 已存在就直接成功（daemon 重连后会重新 Spawn 自己的终端）
    if sh.pty.lock().unwrap().has(id) {
        return Ok(());
    }

    // 同 id 的并发 Spawn 已被上面的 lifecycle 锁串行化 —— 第二个进来时 has(id) 已为真，
    // 直接走幂等分支返回。此处不再依赖"daemon 不会并发发起"这类外部假设。
    let generation = sh.next_generation.fetch_add(1, Ordering::Relaxed);

    let id_data = id.to_string();
    let out_data = sh.out.clone();
    let id_exit = id.to_string();
    let out_exit = sh.out.clone();

    let inst = create_pty(
        cwd,
        command,
        cols,
        rows,
        move |data| {
            let _ = out_data.send(Out::Data(id_data.clone(), data));
        },
        move || {
            let _ = out_exit.send(Out::Exit(id_exit.clone(), generation));
        },
    )
    .map_err(|e| e.to_string())?;

    sh.pty.lock().unwrap().register(id.to_string(), inst);
    // ScreenManager 的 create 签名是 (id, rows, cols) —— 注意顺序
    sh.screen.lock().unwrap().create(id, rows, cols);
    sh.buffers.lock().unwrap().create(id);
    // 记下 cwd/command：List 要把它们回放给 daemon，否则 daemon 重启后
    // 重连的终端会丢失标签与工作目录（daemon 那边只有本进程收到过这两个值）
    sh.meta.lock().unwrap().insert(
        id.to_string(),
        TerminalMeta { cwd: cwd.to_string(), command: command.unwrap_or("").to_string(), generation },
    );
    Ok(())
}

/// 真正的拆除动作。**调用方必须已持有 `lifecycle`。**
fn kill_locked(sh: &Arc<Shared>, id: &str) {
    sh.pty.lock().unwrap().kill(id); // drop master 即关闭 ConPTY，子进程随之结束
    sh.screen.lock().unwrap().remove(id);
    sh.buffers.lock().unwrap().remove(id);
    sh.locks.lock().unwrap().remove(id);
    sh.last_revert.lock().unwrap().remove(id);
    sh.meta.lock().unwrap().remove(id);
}

/// 显式 `Kill` 请求用：无条件拆除。对未知 id 是幂等空操作。
fn kill_terminal(sh: &Arc<Shared>, id: &str) {
    let _life = sh.lifecycle.lock().unwrap();
    kill_locked(sh, id);
}

/// 分发任务用：**仅当登记代际未变时**才拆除。
/// 校验与拆除在同一把 lifecycle 锁内完成 —— 否则两者之间可能插进一次
/// 同 id 的 spawn，让陈旧退出杀掉新实例。返回是否真的拆除了。
fn kill_if_current(sh: &Arc<Shared>, id: &str, generation: u64) -> bool {
    let _life = sh.lifecycle.lock().unwrap();
    if !sh.is_current(id, generation) {
        return false;
    }
    kill_locked(sh, id);
    true
}

fn list_terminals(sh: &Arc<Shared>) -> Vec<PtyHostTerminalInfo> {
    // 先把 id 取出来就释放 pty 锁 —— 绝不在持有 pty 锁时再去拿 screen 锁，
    // 否则与其它路径构成相反的加锁顺序就会死锁。
    let ids = sh.pty.lock().unwrap().list_ids();
    let locks = sh.locks.lock().unwrap().clone();
    let meta = sh.meta.lock().unwrap().clone();
    ids.into_iter()
        .map(|id| {
            // 记录尺寸优先取锁定值；没有锁定时回退到屏幕解析器的尺寸
            let (cols, rows) = locks
                .get(&id)
                .copied()
                .or_else(|| sh.screen.lock().unwrap().size_of(&id).map(|(r, c)| (c, r)))
                .unwrap_or((80, 24));
            // cwd/command 必须回放：daemon 重启后靠它们恢复终端标签与工作目录
            let (cwd, command) = meta
                .get(&id)
                .map(|m| (m.cwd.clone(), m.command.clone()))
                .unwrap_or_default();
            PtyHostTerminalInfo { id: id.clone(), cwd, command, cols, rows }
        })
        .collect()
}

async fn handle_request(sh: &Arc<Shared>, req: PtyHostRequest) -> Option<PtyHostEvent> {
    match req {
        PtyHostRequest::Spawn { seq, id, cwd, command, cols, rows } => {
            match spawn_terminal(sh, &id, &cwd, command.as_deref(), cols, rows) {
                Ok(()) => Some(PtyHostEvent::SpawnResult { seq, id }),
                Err(e) => Some(PtyHostEvent::Error { seq, message: e }),
            }
        }
        PtyHostRequest::Kill { seq, id } => {
            kill_terminal(sh, &id);
            Some(PtyHostEvent::Ok { seq })
        }
        PtyHostRequest::List { seq } => {
            Some(PtyHostEvent::ListResult { seq, terminals: list_terminals(sh) })
        }
        // 单向：客户端不登记 seq，不回执
        PtyHostRequest::Write { id, data } => {
            if let Ok(w) = sh.pty.lock().unwrap().get_writer(&id) {
                use std::io::Write as _;
                if let Ok(mut w) = w.lock() {
                    let _ = w.write_all(data.as_bytes());
                    let _ = w.flush();
                }
            }
            None
        }
        PtyHostRequest::Resize { seq, id, cols, rows } => {
            match sh.pty.lock().unwrap().get_master(&id) {
                Ok(m) => {
                    let r = m.lock().unwrap().resize(portable_pty::PtySize {
                        rows, cols, pixel_width: 0, pixel_height: 0,
                    });
                    match r {
                        Ok(()) => {
                            sh.screen.lock().unwrap().resize(&id, rows, cols);
                            Some(PtyHostEvent::Ok { seq })
                        }
                        Err(e) => Some(PtyHostEvent::Error { seq, message: e.to_string() }),
                    }
                }
                Err(e) => Some(PtyHostEvent::Error { seq, message: e }),
            }
        }
        PtyHostRequest::LockSize { seq, id, cols, rows } => {
            sh.locks.lock().unwrap().insert(id.clone(), (cols, rows));
            // 立刻把 PTY 也对齐到锁定尺寸
            if let Ok(m) = sh.pty.lock().unwrap().get_master(&id) {
                let _ = m.lock().unwrap().resize(portable_pty::PtySize {
                    rows, cols, pixel_width: 0, pixel_height: 0,
                });
                sh.screen.lock().unwrap().resize(&id, rows, cols);
            }
            Some(PtyHostEvent::Ok { seq })
        }
        PtyHostRequest::Screen { seq, id } => {
            // 手机尚未认领时没有锁定尺寸 —— 回退到解析器自己的尺寸，不报错
            let (cols, rows) = match sh.locks.lock().unwrap().get(&id).copied() {
                Some(l) => l,
                None => match sh.screen.lock().unwrap().size_of(&id) {
                    Some((r, c)) => (c, r),
                    None => {
                        return Some(PtyHostEvent::Error {
                            seq,
                            message: format!("no screen for PTY {id}"),
                        })
                    }
                },
            };
            // 解析器尺寸与记录不符时才重建 —— 复刻 b3ebd5a 移出的语义
            let needs_rebuild = sh.screen.lock().unwrap().size_of(&id) != Some((rows, cols));
            if needs_rebuild {
                if let Some(raw) = sh.buffers.lock().unwrap().get_bytes(&id) {
                    sh.screen.lock().unwrap().rebuild(&id, rows, cols, &raw);
                }
            }
            match sh.screen.lock().unwrap().snapshot_with_size(&id) {
                Some(snap) => Some(to_screen_result(seq, snap)),
                None => Some(PtyHostEvent::Error {
                    seq,
                    message: format!("no screen for PTY {id}"),
                }),
            }
        }
        other => Some(PtyHostEvent::Error {
            seq: request_seq(&other),
            message: "not implemented yet".into(),
        }),
    }
}

/// 取出请求里的 seq，用于错误回执。
fn request_seq(req: &PtyHostRequest) -> u64 {
    match req {
        PtyHostRequest::Spawn { seq, .. }
        | PtyHostRequest::Resize { seq, .. }
        | PtyHostRequest::Kill { seq, .. }
        | PtyHostRequest::Screen { seq, .. }
        | PtyHostRequest::LockSize { seq, .. }
        | PtyHostRequest::List { seq } => *seq,
        PtyHostRequest::Write { .. } => 0, // 单向，不会被回执
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termhostd::pty_ipc::PtyHostEvent;

    #[test]
    fn exceeds_lock_is_false_when_output_fits() {
        // locked = (cols=80, rows=24)；scan = scan_max_pos 的 (max_row, max_col)
        assert!(!exceeds_lock((80, 24), (24, 80)));
    }

    #[test]
    fn exceeds_lock_is_true_when_wider_than_lock() {
        assert!(exceeds_lock((80, 24), (24, 81)));
    }

    #[test]
    fn exceeds_lock_is_true_when_taller_than_lock() {
        assert!(exceeds_lock((80, 24), (25, 80)));
    }

    /// 协议要 (cols, rows)，vt100 给 (rows, cols)。这个测试就是防它搞反。
    #[test]
    fn screen_result_uses_cols_rows_order() {
        // 来自 ScreenManager 的形状：(data, rows, cols) —— 这里 rows=24, cols=80
        let ev = to_screen_result(7, ("SCREEN".to_string(), 24, 80));
        match ev {
            PtyHostEvent::ScreenResult { seq, data, cols, rows } => {
                assert_eq!(seq, 7);
                assert_eq!(data.as_deref(), Some("SCREEN"));
                assert_eq!(cols, 80, "cols 必须是 80，不是 24");
                assert_eq!(rows, 24, "rows 必须是 24，不是 80");
            }
            other => panic!("expected ScreenResult, got {other:?}"),
        }
    }
}
