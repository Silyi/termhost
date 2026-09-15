//! pty-host — owns the actual PTY processes.
//!
//! Runs as a standalone process so terminals survive `termhostd` restarts.
//! Speaks the framed-JSON protocol in `pty_ipc` over
//! `\\.\pipe\termhost-pty-host-v1`.

use std::ptr;

use termhostd::pty_ipc::PTY_HOST_MUTEX_NAME;
use termhostd::pty_ipc::PtyHostEvent;

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
