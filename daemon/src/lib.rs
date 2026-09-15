//! Shared between the two daemon binaries: `termhostd` (the
//! WS/HTTP server and all business logic — restarted often during dev/updates)
//! and `pty-host` (owns the actual PTY processes — should almost never need
//! restarting, so terminals survive a daemon update instead of dying with it).

pub mod error;
pub mod screen;
pub mod buffer;

#[cfg(target_os = "windows")]
pub mod pty_client;
#[cfg(target_os = "windows")]
pub mod pty_ipc;
#[cfg(target_os = "windows")]
pub mod pty_manager;
