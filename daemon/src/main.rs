#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cloudflare_tunnel;
mod raw_pipe;
mod buffer;
mod hid;
mod screen;
mod screen_capture;
mod sleep_blocker;
mod tg_auth;
mod webrtc_stream;
mod ws_server;

mod tray;

use buffer::BufferManager;
use screen::ScreenManager;
use termhostd::pty_client::PtyHostClient;
use termhost_shared::protocol::*;

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ServerOptions, PipeMode};
use tokio::sync::{broadcast, Mutex as TokioMutex, Notify, OnceCell};

const PIPE_NAME: &str = r"\\.\pipe\termhost-pty-v1";
const IDLE_TIMEOUT_SECS: u64 = 86400; // 24h — don't auto-shutdown, user connects from phone

#[derive(Clone, Debug)]
pub(crate) enum BroadcastMsg {
    TerminalOutput { id: String, data: String },
    TerminalResized { id: String, cols: u16, rows: u16 },
    /// Desktop (IPC) took control of a terminal away from a WS (phone) client —
    /// WS clients must drop to passive mode or they keep rendering at phone
    /// width while the PTY is desktop-width (truncated output, ghost cells).
    TerminalControlLost { id: String },
    ShowWindow,
    TerminalsChanged,
}

pub(crate) struct DaemonState {
    /// Connects to the separate `pty-host` process, which actually owns the
    /// PTYs — set once, right at daemon_main startup, before anything else
    /// runs. See pty_client.rs for why: this daemon can be freely restarted
    /// without killing anyone's terminal.
    pub pty_client: OnceCell<PtyHostClient>,
    /// Handle to the tokio runtime, so the (synchronous) tray message loop can
    /// spawn async pty-host calls (e.g. "Kill all terminals").
    pub rt_handle: std::sync::OnceLock<tokio::runtime::Handle>,
    pub auto_approve: std::sync::Mutex<bool>,
    pub sleep_never: std::sync::Mutex<bool>,
    pub sleep_timeout: std::sync::Mutex<u32>,
    /// Terminal ids visible to remote (mobile) clients
    pub remote_allowed: std::sync::Mutex<std::collections::HashSet<String>>,
    pub buffer_manager: std::sync::Mutex<BufferManager>,
    /// Server-side vt100 screen per terminal — yields a clean current-screen
    /// snapshot for freshly-attached mobile clients (see screen.rs).
    pub screen_manager: std::sync::Mutex<ScreenManager>,
    pub terminal_infos: std::sync::Mutex<Vec<TerminalInfo>>,
    /// Current PTY grid size per terminal id, used by WS (mobile) clients to render
    /// at the canonical size the desktop spawned/resized to.
    pub terminal_sizes: std::sync::Mutex<std::collections::HashMap<String, (u16, u16)>>,
    pub workspace_data: std::sync::Mutex<Vec<WorkspaceData>>,
    pub broadcast_tx: broadcast::Sender<BroadcastMsg>,
    pub client_count: std::sync::atomic::AtomicU32,
    pub activity: Notify,
    pub ws_handle: std::sync::Mutex<Option<ws_server::WsServerHandle>>,
    pub ws_port: std::sync::Mutex<Option<u16>>,
    /// Per-process random token; mobile clients must present it on /ws and /api/*.
    pub ws_token: String,
    /// Telegram auth (Mini App / Login Widget). Enabled when bot_token is configured.
    pub tg: crate::tg_auth::TgAuth,
    /// Per-terminal active client: "desktop" or "ws".
    /// Only the active client's resize is applied (size-gate).
    pub active_clients: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Devices that scanned the QR / hit /api/pair/request and are waiting on
    /// a human to approve them from the (already-trusted) desktop app.
    pub pending_pairs: std::sync::Mutex<std::collections::HashMap<String, PendingPair>>,
    /// Devices a human has approved — each gets its own permanent token, so
    /// access can be told apart and revoked per-device instead of only ever
    /// sharing the one static ws_token.
    pub approved_devices: std::sync::Mutex<Vec<ApprovedDevice>>,
    /// Tokens that currently have an active WebSocket connection.
    pub connected_devices: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Cloudflare Tunnel manager (optional, started on demand).
    pub cloudflare: crate::cloudflare_tunnel::CloudflareTunnelRef,
}

#[derive(Clone)]
pub(crate) struct PendingPair {
    pub code: String,
    pub requested_at: std::time::Instant,
    pub approved_token: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct ApprovedDevice {
    pub token: String,
    pub label: String,
    pub approved_at: i64,
    #[serde(default)]
    pub last_seen: Option<i64>,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub note: String,
}

pub(crate) const PAIR_EXPIRY_SECS: u64 = 300;

impl DaemonState {
    /// Panics if called before daemon_main's startup connect — that connect is
    /// the very first thing daemon_main does, before any request can arrive.
    pub fn pty(&self) -> &PtyHostClient {
        self.pty_client.get().expect("pty-host client not connected yet")
    }

    /// True for the one legacy static token OR any approved per-device token.
    pub fn is_valid_token(&self, token: Option<&str>) -> bool {
        let Some(t) = token else { return false };
        if t == self.ws_token {
            return true;
        }
        self.approved_devices.lock().unwrap().iter().any(|d| d.token == t)
    }
}

fn devices_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("AgentWorkspace").join("devices.json"))
}

fn load_approved_devices() -> Vec<ApprovedDevice> {
    let Some(path) = devices_path() else { return Vec::new() };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn save_approved_devices(devices: &[ApprovedDevice]) {
    let Some(path) = devices_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(devices) {
        let _ = std::fs::write(&path, json);
    }
}

fn pty_host_exe_path() -> std::path::PathBuf {
    let daemon_exe = std::env::current_exe().unwrap_or_default();
    let dir = daemon_exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    dir.join("pty-host.exe")
}

/// 16 random bytes hex-encoded — a basic gate for the WS server on LAN/Tailscale.
fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Persist the WS token across daemon restarts so a phone's open page keeps working
/// (a fresh token every launch invalidates the phone's injected token → /ws 404).
fn load_or_create_token() -> String {
    let Some(dir) = dirs::data_local_dir() else { return generate_token() };
    let path = dir.join("TermHost").join("ws_token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() == 32 && t.bytes().all(|b| b.is_ascii_hexdigit()) {
            return t;
        }
    }
    let token = generate_token();
    let _ = std::fs::create_dir_all(dir.join("TermHost"));
    let _ = std::fs::write(&path, &token);
    token
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::builder()
                .with_default_directive(tracing::Level::INFO.into())
                .from_env_lossy()
        )
        .init();

    // Single-instance guard via Windows named mutex.
    // The mutex lives for the entire process lifetime.
    let _mutex_guard = unsafe {
        let name: Vec<u16> = "Global\\TermHostDaemon\0".encode_utf16().collect();
        let h = winapi::um::synchapi::CreateMutexW(
            std::ptr::null_mut(),
            1, // bInitialOwner = TRUE
            name.as_ptr(),
        );
        if h.is_null() || winapi::um::errhandlingapi::GetLastError() == 183 /* ERROR_ALREADY_EXISTS */ {
            if !h.is_null() {
                winapi::um::handleapi::CloseHandle(h);
            }
            tracing::error!("Daemon already running, exiting");
            return;
        }
        h // kept alive until process exits
    };

    // Write PID file
    if let Some(dir) = dirs::data_local_dir() {
        let pid_dir = dir.join("TermHost");
        let _ = std::fs::create_dir_all(&pid_dir);
        let _ = std::fs::write(pid_dir.join("daemon.pid"), std::process::id().to_string());
    }

    let (broadcast_tx, _) = broadcast::channel::<BroadcastMsg>(2048);

    let state = Arc::new(DaemonState {
        pty_client: OnceCell::new(),
        rt_handle: std::sync::OnceLock::new(),
        buffer_manager: std::sync::Mutex::new(BufferManager::new()),
        screen_manager: std::sync::Mutex::new(ScreenManager::new()),
        terminal_infos: std::sync::Mutex::new(Vec::new()),
        terminal_sizes: std::sync::Mutex::new(std::collections::HashMap::new()),
        workspace_data: std::sync::Mutex::new(Vec::new()),
        broadcast_tx,
        client_count: std::sync::atomic::AtomicU32::new(0),
        activity: Notify::new(),
        ws_handle: std::sync::Mutex::new(None),
        ws_port: std::sync::Mutex::new(None),
        ws_token: load_or_create_token(),
        tg: crate::tg_auth::TgAuth::load(),
        active_clients: std::sync::Mutex::new(std::collections::HashMap::new()),
        pending_pairs: std::sync::Mutex::new(std::collections::HashMap::new()),
        approved_devices: std::sync::Mutex::new(load_approved_devices()),
        connected_devices: std::sync::Mutex::new(std::collections::HashSet::new()),
        cloudflare: cloudflare_tunnel::CloudflareTunnel::new(),
        auto_approve: std::sync::Mutex::new(false),
        sleep_never: std::sync::Mutex::new(true),
        sleep_timeout: std::sync::Mutex::new(0),
        remote_allowed: std::sync::Mutex::new(std::collections::HashSet::new()),
    });

    tracing::info!("termhostd started on {}", PIPE_NAME);

    // Start tokio runtime on a background thread
    let state_clone = state.clone();
    let state_for_handle = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        let _ = state_for_handle.rt_handle.set(rt.handle().clone());
        rt.block_on(daemon_main(state_clone));
    });

    // Main thread: tray icon + Win32 message loop
    tray::run_tray(state);
}

async fn daemon_main(state: Arc<DaemonState>) {
    // Connect to pty-host FIRST — spawns it if it isn't already running, and
    // reattaches any terminals it already owns (e.g. this daemon restarted
    // while pty-host kept running from before). Everything below assumes
    // state.pty() works, so this must complete before anything else starts.
    let pty_host_exe = pty_host_exe_path();
    let state_out = state.clone();
    let state_exit = state.clone();
    match PtyHostClient::connect(
        &pty_host_exe,
        move |id, data| {
            // Sizes are owned by the phone (pty-host locks them) — the live
            // width-detection hack is gone: it grew terminal_sizes from
            // whatever the frames happened to draw (garbage like 480x12),
            // poisoning every client's scale. The recorded size is now
            // whatever the phone claimed; pty-host enforces it.
            state_out.buffer_manager.lock().unwrap().append_by_id(&id, data.as_bytes());
            state_out.screen_manager.lock().unwrap().feed_by_id(&id, data.as_bytes());
            let _ = state_out.broadcast_tx.send(BroadcastMsg::TerminalOutput { id, data });
        },
        move |id| {
            state_exit.buffer_manager.lock().unwrap().remove(&id);
            state_exit.screen_manager.lock().unwrap().remove(&id);
            state_exit.terminal_infos.lock().unwrap().retain(|t| t.id != id);
            let _ = state_exit.broadcast_tx.send(BroadcastMsg::TerminalsChanged);
            state_exit.terminal_sizes.lock().unwrap().remove(&id);
            state_exit.remote_allowed.lock().unwrap().remove(&id);
            state_exit.activity.notify_one();
        },
    )
    .await
    {
        Ok(client) => {
            let _ = state.pty_client.set(client);
        }
        Err(e) => {
            tracing::error!("FATAL: could not connect to pty-host ({}): {e}", pty_host_exe.display());
            std::process::exit(1);
        }
    }

    let existing = state.pty().list().await;
    if !existing.is_empty() {
        tracing::info!("Reattaching {} terminal(s) already running in pty-host", existing.len());
    }
    for t in existing {
        let label = if t.command.is_empty() {
            format!("PS: {}", t.cwd.rsplit(['\\', '/']).find(|s| !s.is_empty()).unwrap_or("shell"))
        } else if t.command.len() > 30 {
            format!("{}...", &t.command[..30])
        } else {
            t.command.clone()
        };
        state.terminal_infos.lock().unwrap().push(TerminalInfo {
            id: t.id.clone(),
            label,
            cwd: t.cwd.clone(),
            command: t.command.clone(),
            title: String::new(),
            workspace: String::new(),
            allow_remote: false,
        });
        let _ = state.broadcast_tx.send(BroadcastMsg::TerminalsChanged);
        state.terminal_sizes.lock().unwrap().insert(t.id.clone(), (t.cols, t.rows));
        state.remote_allowed.lock().unwrap().insert(t.id.clone());
        state.buffer_manager.lock().unwrap().create(&t.id);
        state.screen_manager.lock().unwrap().create(&t.id, t.rows, t.cols);
    }

    let state_idle = state.clone();
    tokio::spawn(async move {
        idle_watcher(state_idle).await;
    });

    // Auto-start the WS (mobile) server on boot so the phone can connect without
    // toggling Settings → Remote Access every launch. Disable with
    // TERMHOST_WS_AUTOSTART=0; override the port with TERMHOST_WS_PORT (default 9090).
    let autostart = std::env::var("TERMHOST_WS_AUTOSTART")
        .map(|v| v != "0" && v.to_lowercase() != "false")
        .unwrap_or(true);
    if autostart {
        let port = std::env::var("TERMHOST_WS_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(9090);
        let already = state.ws_handle.lock().unwrap().is_some();
        if !already {
            let (h, addr) = ws_server::start(port, state.clone());
            *state.ws_handle.lock().unwrap() = Some(h);
            *state.ws_port.lock().unwrap() = Some(port);
            sleep_blocker::prevent_system_sleep(true);
            tracing::info!("WS server auto-started on {}", addr);
        }
    }

    loop {
        let server = match ServerOptions::new()
            .first_pipe_instance(false)
            .pipe_mode(PipeMode::Byte)
            .create(PIPE_NAME)
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Failed to create pipe: {}, retrying in 1s", e);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };

        if server.connect().await.is_err() {
            continue;
        }

        let state = state.clone();
        state.client_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        state.activity.notify_one();

        tokio::spawn(async move {
            handle_client(server, state.clone()).await;
            state.client_count.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            state.activity.notify_one();
        });
    }
}

async fn idle_watcher(state: Arc<DaemonState>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        let clients = state.client_count.load(std::sync::atomic::Ordering::Relaxed);
        let has_terminals = !state.terminal_infos.lock().unwrap().is_empty();

        if clients == 0 && !has_terminals {
            tracing::info!("No clients and no terminals, starting idle countdown...");
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(IDLE_TIMEOUT_SECS)) => {
                    let clients = state.client_count.load(std::sync::atomic::Ordering::Relaxed);
                    let has_terminals = !state.terminal_infos.lock().unwrap().is_empty();
                    if clients == 0 && !has_terminals {
                        tracing::info!("Idle timeout reached, shutting down");
                        std::process::exit(0);
                    }
                }
                _ = state.activity.notified() => {
                    tracing::info!("Activity detected, cancelling idle shutdown");
                }
            }
        }
    }
}

async fn handle_client(pipe: tokio::net::windows::named_pipe::NamedPipeServer, state: Arc<DaemonState>) {
    let (reader, writer) = tokio::io::split(pipe);
    let reader = Arc::new(TokioMutex::new(reader));
    let writer = Arc::new(TokioMutex::new(writer));

    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let writer_push = writer.clone();

    let push_task = tokio::spawn(async move {
        loop {
            match broadcast_rx.recv().await {
                Ok(msg) => {
                    let resp = match msg {
                        BroadcastMsg::TerminalOutput { id, data } => DaemonResponse::Output { id, data },
                        // Forward resizes so the desktop can follow when a phone (Control
                        // mode) shrinks the shared PTY — renders clean-but-small vs garbled.
                        BroadcastMsg::TerminalResized { id, cols, rows } => DaemonResponse::TerminalResized { id, cols, rows },
                        BroadcastMsg::ShowWindow => DaemonResponse::ShowWindow,
                        // Notify desktop that terminal list changed (spawn/kill from phone),
                        // so it can refresh and show any new terminals.
                        BroadcastMsg::TerminalsChanged => DaemonResponse::TerminalsChanged,
                        // Desktop-originated ownership handover — the desktop is the one
                        // taking control, nothing to tell itself.
                        BroadcastMsg::TerminalControlLost { .. } => continue,
                    };
                    if send_response(&writer_push, &resp).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });

    // Read requests
    loop {
        let frame = match read_frame(&reader).await {
            Ok(Some(f)) => f,
            Ok(None) | Err(_) => break,
        };

        let request: DaemonRequest = match serde_json::from_slice(&frame) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Invalid request: {}", e);
                continue;
            }
        };

        let response = handle_request(&state, request).await;
        if let Some(resp) = response {
            if send_response(&writer, &resp).await.is_err() {
                break;
            }
        }
    }

    push_task.abort();
}

async fn read_frame(
    reader: &Arc<TokioMutex<tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeServer>>>,
) -> Result<Option<Vec<u8>>, std::io::Error> {
    let mut r = reader.lock().await;
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

async fn send_response(
    writer: &Arc<TokioMutex<tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeServer>>>,
    resp: &DaemonResponse,
) -> Result<(), std::io::Error> {
    let frame = encode_message(resp).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let mut w = writer.lock().await;
    w.write_all(&frame).await?;
    w.flush().await?;
    Ok(())
}

async fn handle_request(state: &Arc<DaemonState>, req: DaemonRequest) -> Option<DaemonResponse> {
    match req {
        DaemonRequest::Ping { seq } => Some(DaemonResponse::Pong { seq, version: PROTOCOL_VERSION }),

        DaemonRequest::Shutdown => {
            tracing::info!("Shutdown requested");
            tokio::spawn(async { tokio::time::sleep(std::time::Duration::from_millis(100)).await; std::process::exit(0); });
            Some(DaemonResponse::Ok { seq: 0 })
        }

        DaemonRequest::Spawn { seq, id, cwd, command, cols, rows } => {
            let resolved_cwd = if cwd.is_empty() {
                dirs::home_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "C:\\".to_string())
            } else {
                cwd
            };

            let cmd_str = command.as_deref().unwrap_or("").to_string();
            let label = if cmd_str.is_empty() {
                format!("PS: {}", resolved_cwd.split('\\').last().unwrap_or("shell"))
            } else if cmd_str.len() > 30 {
                format!("{}...", &cmd_str[..30])
            } else {
                cmd_str.clone()
            };

            match state.pty().spawn(&id, &resolved_cwd, command.as_deref(), cols, rows).await {
                Ok(()) => {
                    // pty-host itself is idempotent on a duplicate id (a retry)
                    // — only add bookkeeping the first time we see this id.
                    let already_known = state.terminal_infos.lock().unwrap().iter().any(|t| t.id == id);
                    if !already_known {
                        state.remote_allowed.lock().unwrap().insert(id.clone());
                        state.terminal_infos.lock().unwrap().push(TerminalInfo {
                            id: id.clone(),
                            label,
                            cwd: resolved_cwd,
                            command: cmd_str,
                            title: String::new(),
                            workspace: String::new(),
                            allow_remote: false,
                        });
                        let _ = state.broadcast_tx.send(BroadcastMsg::TerminalsChanged);
                        state.terminal_sizes.lock().unwrap().insert(id.clone(), (cols, rows));
                        state.buffer_manager.lock().unwrap().create(&id);
                        state.screen_manager.lock().unwrap().create(&id, rows, cols);
                        // Start raw pipe server for WT bridge
                        let state_for_pipe = state.clone();
                        let id_for_pipe = id.clone();
                        tokio::spawn(async move {
                            crate::raw_pipe::start_raw_pipe(state_for_pipe, id_for_pipe).await;
                        });
                    }
                    state.activity.notify_one();
                    Some(DaemonResponse::SpawnResult { seq, id })
                }
                Err(e) => Some(DaemonResponse::Error { seq, message: e }),
            }
        }

        DaemonRequest::Write { id, data } => {
            // PC is for running terminals, the phone is the only display/input
            // client — typing on the desktop must NOT steal size ownership.
            state.pty().write(&id, &data);
            None
        }

        DaemonRequest::Resize { seq, id, .. } => {
            // Sizes belong to the phone entirely. Desktop resize requests are
            // ignored — the PTY only follows WS (phone) resizes. (The desktop
            // app may still run for file/workspace features, but it never
            // controls terminal size.)
            let _ = id;
            Some(DaemonResponse::Ok { seq })
        }

        DaemonRequest::Kill { seq, id } => {
            let _ = state.pty().kill(&id).await;
            state.buffer_manager.lock().unwrap().remove(&id);
            state.screen_manager.lock().unwrap().remove(&id);
            {
                let mut infos = state.terminal_infos.lock().unwrap();
                infos.retain(|t| t.id != id);
            }
            if let Ok(mut sizes) = state.terminal_sizes.lock() {
                sizes.remove(&id);
            }
            state.remote_allowed.lock().unwrap().remove(&id);
            for w in state.workspace_data.lock().unwrap().iter_mut() {
                w.terminal_ids.retain(|tid| tid != &id);
            }
            state.active_clients.lock().unwrap().remove(&id);
            state.activity.notify_one();
            Some(DaemonResponse::Ok { seq })
        }

        DaemonRequest::HasTerminal { seq, id } => {
            let exists = state.terminal_infos.lock().unwrap().iter().any(|t| t.id == id);
            Some(DaemonResponse::HasResult { seq, exists })
        }

        DaemonRequest::GetBuffer { seq, id } => {
            let data = state.buffer_manager.lock().unwrap().get_data(&id).unwrap_or_default();
            Some(DaemonResponse::BufferData { seq, id, data })
        }

        DaemonRequest::GetScreen { seq, id } => {
            // The screen lives in pty-host (fed from the live stream, and it
            // survives daemon restarts) — same source the mobile client paints
            // from. None = no screen for this id; cols/rows are then meaningless.
            match state.pty().screen(&id).await {
                Some((data, cols, rows)) => Some(DaemonResponse::ScreenData { seq, id, data: Some(data), cols, rows }),
                None => Some(DaemonResponse::ScreenData { seq, id, data: None, cols: 0, rows: 0 }),
            }
        }

        DaemonRequest::ListTerminals { seq } => {
            let mut terminals = state.terminal_infos.lock().unwrap().clone();
            let ws_data = state.workspace_data.lock().unwrap();
            let allowed = state.remote_allowed.lock().unwrap();
            for t in &mut terminals {
                for ws in ws_data.iter() {
                    if ws.terminal_ids.contains(&t.id) {
                        t.workspace = ws.name.clone();
                        break;
                    }
                }
                t.allow_remote = allowed.contains(&t.id);
            }
            Some(DaemonResponse::TerminalList { seq, terminals })
        }

        DaemonRequest::SubscribeAll => {
            None
        }

        DaemonRequest::StartWsServer { seq, port } => {
            let cf_url = state.cloudflare.url().await;
            let result = {
                let mut handle = state.ws_handle.lock().unwrap();
                if handle.is_some() {
                    let ip = ws_server::get_local_ip_pub();
                    *state.ws_port.lock().unwrap() = Some(port);
                    let resp = DaemonResponse::WsStatus { seq, running: true, ip: format!("{}:{}", ip, port), port, ips: ws_server::get_local_ips(), token: state.ws_token.clone(), cf_url };
                    (Some(resp), None)
                } else {
                    let (h, addr) = ws_server::start(port, state.clone());
                    *handle = Some(h);
                    *state.ws_port.lock().unwrap() = Some(port);
                    sleep_blocker::prevent_system_sleep(true);
                    (None, Some(addr))
                }
            };
            if let (Some(resp), _) = result {
                return Some(resp);
            }
            if let (_, Some(addr)) = &result {
                let cf_url2 = state.cloudflare.url().await;
                return Some(DaemonResponse::WsStatus { seq, running: true, ip: addr.clone(), port, ips: ws_server::get_local_ips(), token: state.ws_token.clone(), cf_url: cf_url2 });
            }
            unreachable!()
        }
        DaemonRequest::StopWsServer { seq } => {
            let mut handle = state.ws_handle.lock().unwrap();
            if let Some(h) = handle.take() {
                h.shutdown();
                sleep_blocker::prevent_system_sleep(false);
            }
            *state.ws_port.lock().unwrap() = None;
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::WsServerStatus { seq } => {
            let cf_url = state.cloudflare.url().await;
            let handle = state.ws_handle.lock().unwrap();
            let running = handle.is_some();
            let ip = ws_server::get_local_ip_pub();
            let port = state.ws_port.lock().unwrap().unwrap_or(0);
            Some(DaemonResponse::WsStatus { seq, running, ip, port, ips: ws_server::get_local_ips(), token: state.ws_token.clone(), cf_url })
        }
        DaemonRequest::SyncWorkspaces { seq, workspaces, .. } => {
            *state.workspace_data.lock().unwrap() = workspaces;
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::PendingPairs { seq } => {
            let pending = state.pending_pairs.lock().unwrap();
            let pairs: Vec<PendingPairInfo> = pending.iter()
                .filter(|(_, p)| p.approved_token.is_none())
                .map(|(id, p)| PendingPairInfo {
                    device_id: id.clone(),
                    code: p.code.clone(),
                })
                .collect();
            Some(DaemonResponse::PendingPairsResult { seq, pairs })
        }
        DaemonRequest::PairApprove { seq, device_id, label } => {
            let token = ws_server::generate_device_token();
            let device_type = state.pending_pairs.lock().unwrap().get(&device_id)
                .and_then(|p| p.user_agent.clone())
                .map(|ua| {
                    let short = if ua.contains("Android") { "Android" }
                        else if ua.contains("iPhone") || ua.contains("iPad") { "iOS" }
                        else if ua.contains("CrOS") { "ChromeOS" }
                        else if ua.contains("Linux") { "Linux" }
                        else if ua.contains("Windows") { "Windows" }
                        else if ua.contains("Mac OS") { "macOS" }
                        else { "Unknown" };
                    let browser = if ua.contains("Chrome") { "Chrome" }
                        else if ua.contains("Firefox") { "Firefox" }
                        else if ua.contains("Safari") { "Safari" }
                        else if ua.contains("Edge") { "Edge" }
                        else { "Browser" };
                    format!("{browser} · {short}")
                });
            {
                let mut pending = state.pending_pairs.lock().unwrap();
                match pending.get_mut(&device_id) {
                    Some(p) => p.approved_token = Some(token.clone()),
                    None => return Some(DaemonResponse::Error { seq, message: "not found or expired".into() }),
                }
            }
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            let mut devices = state.approved_devices.lock().unwrap();
            devices.push(ApprovedDevice { token, label, approved_at: now_ms, last_seen: None, device_type, note: String::new() });
            save_approved_devices(&devices);
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::PairReject { seq, device_id } => {
            state.pending_pairs.lock().unwrap().remove(&device_id);
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::ListDevices { seq } => {
            let devices = state.approved_devices.lock().unwrap();
            let connected = state.connected_devices.lock().unwrap();
            let list: Vec<ApprovedDeviceInfo> = devices.iter().map(|d| ApprovedDeviceInfo {
                token: d.token.clone(),
                label: d.label.clone(),
                approved_at: d.approved_at,
                last_seen: d.last_seen,
                device_type: d.device_type.clone(),
                note: d.note.clone(),
                online: connected.contains(&d.token),
            }).collect();
            Some(DaemonResponse::ListDevicesResult { seq, devices: list })
        }
        DaemonRequest::RevokeDevice { seq, token } => {
            let mut devices = state.approved_devices.lock().unwrap();
            devices.retain(|d| d.token != token);
            save_approved_devices(&devices);
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::RenameDevice { seq, token, label } => {
            let mut devices = state.approved_devices.lock().unwrap();
            if let Some(d) = devices.iter_mut().find(|d| d.token == token) {
                d.label = label;
                save_approved_devices(&devices);
                Some(DaemonResponse::Ok { seq })
            } else {
                Some(DaemonResponse::Error { seq, message: "device not found".into() })
            }
        }
        DaemonRequest::UpdateDeviceNote { seq, token, note } => {
            let mut devices = state.approved_devices.lock().unwrap();
            if let Some(d) = devices.iter_mut().find(|d| d.token == token) {
                d.note = note;
                save_approved_devices(&devices);
                Some(DaemonResponse::Ok { seq })
            } else {
                Some(DaemonResponse::Error { seq, message: "device not found".into() })
            }
        }
        DaemonRequest::SetAutoApprove { seq, enabled } => {
            *state.auto_approve.lock().unwrap() = enabled;
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::GetAutoApprove { seq } => {
            let enabled = *state.auto_approve.lock().unwrap();
            Some(DaemonResponse::AutoApproveStatus { seq, enabled })
        }
        DaemonRequest::SetSleepConfig { seq, never, timeout_minutes } => {
            *state.sleep_never.lock().unwrap() = never;
            *state.sleep_timeout.lock().unwrap() = timeout_minutes;
            sleep_blocker::set_config(never, timeout_minutes);
            Some(DaemonResponse::Ok { seq })
        }
        DaemonRequest::GetSleepConfig { seq } => {
            let never = *state.sleep_never.lock().unwrap();
            let timeout_minutes = *state.sleep_timeout.lock().unwrap();
            Some(DaemonResponse::SleepConfigStatus { seq, never, timeout_minutes })
        }
        DaemonRequest::SetTerminalRemote { seq, id, allowed } => {
            let mut allowed_set = state.remote_allowed.lock().unwrap();
            if allowed {
                allowed_set.insert(id);
            } else {
                allowed_set.remove(&id);
            }
            Some(DaemonResponse::Ok { seq })
        }
    }
}
