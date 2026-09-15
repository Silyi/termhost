//! pty-host — owns the actual PTY processes.
//!
//! Runs as a standalone process so terminals survive `termhostd` restarts.
//! Speaks the framed-JSON protocol in `pty_ipc` over
//! `\\.\pipe\termhost-pty-host-v1`.

use std::ptr;

use termhostd::pty_ipc::PTY_HOST_MUTEX_NAME;

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
            return true; // 拿不到句柄就不阻止启动，交给管道去失败
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
