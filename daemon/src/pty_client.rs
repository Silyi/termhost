//! Daemon-side client for `pty-host`. The daemon no longer owns PTYs directly —
//! it asks pty-host to spawn/write/resize/kill them over a named pipe, and
//! receives Output/Exited events pushed back. This is the piece that makes
//! restarting/updating the daemon NOT kill anyone's running terminals: PTYs
//! live in pty-host, a separate, effectively-never-restarted process.

use crate::pty_ipc::{read_frame, write_frame, PtyHostEvent, PtyHostRequest, PtyHostTerminalInfo, PTY_HOST_PIPE_NAME};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::{oneshot, Mutex as TokioMutex, Notify};

/// 不给子进程分配控制台窗口。
///
/// 缺了它，pty-host（Rust 控制台程序）在 daemon 这个无控制台的父进程下会被
/// Windows **分配一个独立的可见窗口**。用户看到那个窗口、随手关掉它，就等于
/// 杀掉 pty-host —— 而 pty-host 是**所有终端的主人**，它一死，名下的终端全部
/// 消失，此后每一次 spawn 都会失败。用户于是看到「新建终端点了没反应」。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<PtyHostEvent>>>>;

/// Pump one connection: route `Output`/`Exited` to the callbacks and answer
/// requests by seq, until the pipe closes.
///
/// On close (= pty-host died) three things must happen, in this order:
/// fail every in-flight request, record it, and wake the daemon's supervisor.
fn spawn_reader<R, F, E>(reader: R, pending: PendingMap, on_output: F, on_exit: E, dead: Arc<Notify>)
where
    R: tokio::io::AsyncRead + Send + Unpin + 'static,
    F: Fn(String, String) + Send + Sync + 'static,
    E: Fn(String) + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let mut reader = reader;
        loop {
            let frame = match read_frame(&mut reader).await {
                Ok(Some(f)) => f,
                _ => break,
            };
            let ev: PtyHostEvent = match serde_json::from_slice(&frame) {
                Ok(e) => e,
                Err(_) => continue,
            };
            match ev {
                PtyHostEvent::Output { id, data } => on_output(id, data),
                PtyHostEvent::Exited { id } => on_exit(id),
                other => {
                    let seq = match &other {
                        PtyHostEvent::SpawnResult { seq, .. }
                        | PtyHostEvent::Ok { seq }
                        | PtyHostEvent::Error { seq, .. }
                        | PtyHostEvent::ListResult { seq, .. }
                        | PtyHostEvent::ScreenResult { seq, .. } => *seq,
                        _ => continue,
                    };
                    if let Some(tx) = pending.lock().unwrap().remove(&seq) {
                        let _ = tx.send(other);
                    }
                }
            }
        }

        // Dropping the senders makes every waiting `rx.await` return at once with
        // "pty-host connection lost". Without this the caller hangs forever: the
        // requests have no timeout.
        pending.lock().unwrap().clear();
        crate::panic_log::log_line(
            "termhostd",
            "pty-host connection lost - every terminal it owned is gone",
        );
        tracing::error!("pty-host connection lost");
        dead.notify_one();
    });
}

pub struct PtyHostClient {
    /// `None` while pty-host is gone. Swappable so the same client object can be
    /// reconnected in place — `DaemonState.pty_client` is a `OnceCell`, so
    /// replacing the whole client isn't an option.
    writer: Arc<TokioMutex<Option<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>>,
    pending: PendingMap,
    next_seq: AtomicU64,
    /// Signalled when the reader task sees the pipe close, i.e. pty-host died.
    /// The daemon's supervisor awaits this and rebuilds the connection — without
    /// it, a dead pty-host left the daemon answering every spawn with "pipe is
    /// being closed" for as long as it stayed up (it stayed up 10 hours once).
    dead: Arc<Notify>,
}

impl PtyHostClient {
    /// Connects to pty-host, spawning it first if it isn't already running.
    /// `on_output`/`on_exit` are invoked for events pushed outside any request
    /// (a PTY produced data, or its process ended) — wire these to the same
    /// buffer/screen/broadcast plumbing the old in-process PTY callback used.
    pub async fn connect<F, E>(pty_host_exe: &std::path::Path, on_output: F, on_exit: E) -> std::io::Result<Self>
    where
        F: Fn(String, String) + Send + Sync + 'static,
        E: Fn(String) + Send + Sync + 'static,
    {
        let client = Self {
            writer: Arc::new(TokioMutex::new(None)),
            pending: Arc::new(StdMutex::new(HashMap::new())),
            next_seq: AtomicU64::new(1),
            dead: Arc::new(Notify::new()),
        };
        client.attach(pty_host_exe, on_output, on_exit).await?;
        Ok(client)
    }

    /// Connect (spawning pty-host if it isn't running), point the writer at the
    /// new pipe, and start a reader for it. Shared by `connect` and `reconnect`.
    async fn attach<F, E>(&self, pty_host_exe: &std::path::Path, on_output: F, on_exit: E) -> std::io::Result<()>
    where
        F: Fn(String, String) + Send + Sync + 'static,
        E: Fn(String) + Send + Sync + 'static,
    {
        let pipe = Self::connect_pipe(pty_host_exe).await?;
        let (reader, writer) = tokio::io::split(pipe);
        *self.writer.lock().await = Some(Box::new(writer));
        spawn_reader(reader, self.pending.clone(), on_output, on_exit, self.dead.clone());
        Ok(())
    }

    /// Rebuild the connection after pty-host died. Reuses this object on purpose:
    /// `DaemonState.pty_client` is a `OnceCell`, so a fresh client couldn't be
    /// installed. The caller re-supplies the callbacks, which is also what keeps
    /// them wired to `DaemonState`.
    pub async fn reconnect<F, E>(&self, pty_host_exe: &std::path::Path, on_output: F, on_exit: E) -> std::io::Result<()>
    where
        F: Fn(String, String) + Send + Sync + 'static,
        E: Fn(String) + Send + Sync + 'static,
    {
        self.attach(pty_host_exe, on_output, on_exit).await
    }

    /// Resolves once pty-host's connection drops. Safe to call after the fact:
    /// `notify_one` leaves a permit behind when nobody is waiting yet.
    pub async fn died(&self) {
        self.dead.notified().await;
    }

    async fn connect_pipe(pty_host_exe: &std::path::Path) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
        // pty-host may not be running yet (fresh machine / first daemon launch
        // since the last reboot) — try to connect, and if that fails, spawn it
        // and retry for a few seconds while it comes up.
        for attempt in 0..30 {
            match ClientOptions::new().open(PTY_HOST_PIPE_NAME) {
                Ok(client) => return Ok(client),
                Err(e) if e.raw_os_error() == Some(2) /* ERROR_FILE_NOT_FOUND */ => {
                    if attempt == 0 {
                        tracing::info!("pty-host not running, starting it: {:?}", pty_host_exe);
                        // CREATE_NO_WINDOW 不可省 —— 见该常量的说明：pty-host 若带出
                        // 可见控制台窗口，用户关掉它就会连同所有终端一起杀掉。
                        let _ = std::process::Command::new(pty_host_exe)
                            .creation_flags(CREATE_NO_WINDOW)
                            .spawn();
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "pty-host did not come up"))
    }

    async fn request(&self, seq: u64, req: PtyHostRequest) -> std::io::Result<PtyHostEvent> {
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.writer.lock().await;
            // Say something specific rather than blocking: with no writer there is
            // no pty-host, and the caller's error surfaces in the UI.
            let Some(w) = guard.as_mut() else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "pty-host is not connected",
                ));
            };
            self.pending.lock().unwrap().insert(seq, tx);
            write_frame(w, &req).await?;
        }
        rx.await.map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "pty-host connection lost"))
    }

    fn seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn spawn(&self, id: &str, cwd: &str, command: Option<&str>, cols: u16, rows: u16) -> Result<(), String> {
        let seq = self.seq();
        let req = PtyHostRequest::Spawn {
            seq, id: id.to_string(), cwd: cwd.to_string(), command: command.map(|s| s.to_string()), cols, rows,
        };
        match self.request(seq, req).await {
            Ok(PtyHostEvent::SpawnResult { .. }) => Ok(()),
            Ok(PtyHostEvent::Error { message, .. }) => Err(message),
            Ok(_) => Err("unexpected response".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Fire-and-forget — matches the old direct `writer.write_all` semantics
    /// (input is not expected to fail visibly to the caller).
    pub fn write(&self, id: &str, data: &str) {
        let req = PtyHostRequest::Write { id: id.to_string(), data: data.to_string() };
        let writer = self.writer.clone();
        tokio::spawn(async move {
            let mut guard = writer.lock().await;
            if let Some(w) = guard.as_mut() {
                let _ = write_frame(w, &req).await;
            }
        });
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let seq = self.seq();
        let req = PtyHostRequest::Resize { seq, id: id.to_string(), cols, rows };
        match self.request(seq, req).await {
            Ok(PtyHostEvent::Ok { .. }) => Ok(()),
            Ok(PtyHostEvent::Error { message, .. }) => Err(message),
            Ok(_) => Err("unexpected response".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let seq = self.seq();
        let req = PtyHostRequest::Kill { seq, id: id.to_string() };
        match self.request(seq, req).await {
            Ok(PtyHostEvent::Ok { .. }) => Ok(()),
            Ok(PtyHostEvent::Error { message, .. }) => Err(message),
            Ok(_) => Err("unexpected response".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Current screen snapshot from pty-host's vt100 parser: formatted
    /// contents + the parser's grid size. `None` data = no screen for the id.
    pub async fn screen(&self, id: &str) -> Option<(String, u16, u16)> {
        let seq = self.seq();
        let req = PtyHostRequest::Screen { seq, id: id.to_string() };
        match self.request(seq, req).await {
            Ok(PtyHostEvent::ScreenResult { data, cols, rows, .. }) => data.map(|d| (d, cols, rows)),
            _ => None,
        }
    }

    /// Pin the PTY to (cols, rows) — pty-host reverts any external resize.
    pub async fn lock_size(&self, id: &str, cols: u16, rows: u16) -> bool {
        let seq = self.seq();
        let req = PtyHostRequest::LockSize { seq, id: id.to_string(), cols, rows };
        matches!(self.request(seq, req).await, Ok(PtyHostEvent::Ok { .. }))
    }

    pub async fn list(&self) -> Vec<PtyHostTerminalInfo> {
        let seq = self.seq();
        match self.request(seq, PtyHostRequest::List { seq }).await {
            Ok(PtyHostEvent::ListResult { terminals, .. }) => terminals,
            _ => Vec::new(),
        }
    }
}
