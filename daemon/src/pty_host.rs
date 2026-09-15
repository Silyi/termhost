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
