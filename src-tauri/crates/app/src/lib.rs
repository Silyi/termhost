mod daemon_client;

use daemon_client::DaemonClient;
use termhost_shared::protocol::*;
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

struct AppState {
    daemon: Arc<DaemonClient>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SpawnRequest {
    id: String,
    cwd: Option<String>,
    command: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[tauri::command]
async fn spawn_terminal(state: State<'_, AppState>, req: SpawnRequest) -> Result<String, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::Spawn {
        seq,
        id: req.id.clone(),
        cwd: req.cwd.unwrap_or_default(),
        command: req.command,
        cols: req.cols.unwrap_or(80),
        rows: req.rows.unwrap_or(24),
    }).await?;

    match resp {
        DaemonResponse::SpawnResult { id, .. } => Ok(id),
        DaemonResponse::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".into()),
    }
}

#[tauri::command]
async fn write_terminal(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    state.daemon.fire_and_forget(&DaemonRequest::Write { id, data }).await
}

#[tauri::command]
async fn resize_terminal(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::Resize { seq, id, cols, rows }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        DaemonResponse::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".into()),
    }
}

#[tauri::command]
async fn kill_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::Kill { seq, id }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        DaemonResponse::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".into()),
    }
}

#[tauri::command]
async fn has_terminal(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::HasTerminal { seq, id }).await?;
    match resp {
        DaemonResponse::HasResult { exists, .. } => Ok(exists),
        _ => Ok(false),
    }
}

#[tauri::command]
async fn get_terminal_buffer(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::GetBuffer { seq, id }).await?;
    match resp {
        DaemonResponse::BufferData { data, .. } => Ok(data),
        DaemonResponse::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".into()),
    }
}

/// Current-screen snapshot for a terminal, taken from the same vt100 parser the
/// mobile client paints from. `data` is the formatted current screen; `cols`
/// /`rows` are the grid it was rendered for — the client must resize to that
/// native size before writing it, or the paint leaves ghost cells.
#[derive(Serialize)]
struct ScreenPayload {
    data: String,
    cols: u16,
    rows: u16,
}

#[tauri::command]
async fn get_terminal_screen(state: State<'_, AppState>, id: String) -> Result<Option<ScreenPayload>, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::GetScreen { seq, id }).await?;
    match resp {
        DaemonResponse::ScreenData { data, cols, rows, .. } => {
            // None = the terminal exists but has no screen (e.g. pty-host has no
            // parser for it) — the caller falls back to the raw buffer.
            Ok(data.map(|data| ScreenPayload { data, cols, rows }))
        }
        DaemonResponse::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".into()),
    }
}

#[tauri::command]
async fn start_ws_server(state: State<'_, AppState>, port: u16) -> Result<String, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::StartWsServer { seq, port }).await?;
    match resp {
        DaemonResponse::WsStatus { ip, .. } => Ok(ip),
        DaemonResponse::Error { message, .. } => Err(message),
        _ => Err("Unexpected response".into()),
    }
}

#[tauri::command]
async fn stop_ws_server(state: State<'_, AppState>) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let _ = state.daemon.request(&DaemonRequest::StopWsServer { seq }).await;
    Ok(())
}

#[tauri::command]
async fn ws_server_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::WsServerStatus { seq }).await?;
    match resp {
        DaemonResponse::WsStatus { running, ip, port, ips, token, .. } => {
            Ok(serde_json::json!({ "running": running, "ip": ip, "port": port, "ips": ips, "token": token }))
        }
        _ => Ok(serde_json::json!({ "running": false, "ip": "127.0.0.1", "ips": [], "token": "" })),
    }
}

#[tauri::command]
async fn sync_workspaces(
    state: State<'_, AppState>,
    workspaces: Vec<WorkspaceData>,
    active_idx: usize,
) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let _ = state.daemon.request(&DaemonRequest::SyncWorkspaces { seq, workspaces, active_idx }).await;
    Ok(())
}

#[tauri::command]
async fn list_terminals(state: State<'_, AppState>) -> Result<Vec<TerminalInfo>, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::ListTerminals { seq }).await?;
    match resp {
        DaemonResponse::TerminalList { terminals, .. } => Ok(terminals),
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn shutdown_daemon(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.daemon.fire_and_forget(&DaemonRequest::Shutdown).await;
    Ok(())
}

#[tauri::command]
async fn daemon_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let seq = state.daemon.next_seq();
    match state.daemon.request(&DaemonRequest::Ping { seq }).await {
        Ok(DaemonResponse::Pong { version, .. }) => {
            let seq2 = state.daemon.next_seq();
            let terminal_count = match state.daemon.request(&DaemonRequest::ListTerminals { seq: seq2 }).await {
                Ok(DaemonResponse::TerminalList { terminals, .. }) => terminals.len(),
                _ => 0,
            };
            Ok(serde_json::json!({
                "connected": true,
                "terminalCount": terminal_count,
                "protocolMismatch": version != PROTOCOL_VERSION,
            }))
        }
        _ => Ok(serde_json::json!({
            "connected": false,
            "terminalCount": 0
        })),
    }
}

#[tauri::command]
async fn get_pending_pairs(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::PendingPairs { seq }).await?;
    match resp {
        DaemonResponse::PendingPairsResult { pairs, .. } => {
            Ok(pairs.into_iter().map(|p| serde_json::json!({"deviceId": p.device_id, "code": p.code})).collect())
        }
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn pair_approve(state: State<'_, AppState>, device_id: String, label: String) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::PairApprove { seq, device_id, label }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("approve failed".into()),
    }
}

#[tauri::command]
async fn pair_reject(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::PairReject { seq, device_id }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("reject failed".into()),
    }
}

#[tauri::command]
async fn list_devices(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::ListDevices { seq }).await?;
    match resp {
        DaemonResponse::ListDevicesResult { devices, .. } => {
            Ok(devices.into_iter().map(|d| serde_json::json!({
                "token": d.token,
                "label": d.label,
                "approvedAt": d.approved_at,
                "lastSeen": d.last_seen,
                "deviceType": d.device_type,
                "note": d.note,
                "online": d.online,
            })).collect())
        }
        _ => Ok(vec![]),
    }
}

#[tauri::command]
async fn update_device_note(state: State<'_, AppState>, token: String, note: String) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::UpdateDeviceNote { seq, token, note }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("update note failed".into()),
    }
}

#[tauri::command]
async fn rename_device(state: State<'_, AppState>, token: String, label: String) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::RenameDevice { seq, token, label }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("rename failed".into()),
    }
}

#[tauri::command]
async fn revoke_device(state: State<'_, AppState>, token: String) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::RevokeDevice { seq, token }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("revoke failed".into()),
    }
}

#[tauri::command]
async fn set_auto_approve(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::SetAutoApprove { seq, enabled }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("set auto-approve failed".into()),
    }
}

#[tauri::command]
async fn get_auto_approve(state: State<'_, AppState>) -> Result<bool, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::GetAutoApprove { seq }).await?;
    match resp {
        DaemonResponse::AutoApproveStatus { enabled, .. } => Ok(enabled),
        _ => Ok(false),
    }
}

#[tauri::command]
async fn set_sleep_config(state: State<'_, AppState>, never: bool, timeout_minutes: u32) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::SetSleepConfig { seq, never, timeout_minutes }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("set sleep config failed".into()),
    }
}

#[tauri::command]
async fn set_terminal_remote(state: State<'_, AppState>, id: String, allowed: bool) -> Result<(), String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::SetTerminalRemote { seq, id, allowed }).await?;
    match resp {
        DaemonResponse::Ok { .. } => Ok(()),
        _ => Err("set terminal remote failed".into()),
    }
}

#[tauri::command]
async fn get_sleep_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let seq = state.daemon.next_seq();
    let resp = state.daemon.request(&DaemonRequest::GetSleepConfig { seq }).await?;
    match resp {
        DaemonResponse::SleepConfigStatus { never, timeout_minutes, .. } => {
            Ok(serde_json::json!({ "never": never, "timeoutMinutes": timeout_minutes }))
        }
        _ => Ok(serde_json::json!({ "never": true, "timeoutMinutes": 0 })),
    }
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result: Vec<FileEntry> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path().to_string_lossy().to_string();
            let meta = e.metadata().ok()?;
            let is_dir = meta.is_dir();
            let size = meta.len();
            let modified = meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some(FileEntry { name, path, is_dir, size, modified })
        })
        .collect();
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(result)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_git(cwd: String, args: Vec<String>) -> Result<String, String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    // Whitelist read-only git subcommands — this is a viewer, not a shell
    const ALLOWED: &[&str] = &["status", "log", "diff", "rev-parse", "branch", "show", "stash"];
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");
    if !ALLOWED.contains(&sub) {
        return Err(format!("git subcommand not allowed: {}", sub));
    }
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| get_home_dir())
}

#[tauri::command]
fn get_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "C:\\".to_string())
}

#[tauri::command]
async fn browser_open(app: tauri::AppHandle, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    if let Some(existing) = app.get_webview("browser-panel") {
        existing.navigate(parsed_url).map_err(|e: tauri::Error| e.to_string())?;
        existing.set_position(LogicalPosition::new(x, y)).map_err(|e: tauri::Error| e.to_string())?;
        existing.set_size(LogicalSize::new(width, height)).map_err(|e: tauri::Error| e.to_string())?;
        return Ok(());
    }
    let window = app.get_webview_window("main").ok_or("No main window")?;
    let raw_window = window.as_ref().window();
    let webview = tauri::WebviewBuilder::new("browser-panel", tauri_utils::config::WebviewUrl::External(parsed_url));
    raw_window.add_child(webview, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|e: tauri::Error| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let webview = app.get_webview("browser-panel").ok_or("Browser not open")?;
    webview.navigate(url.parse().map_err(|e: url::ParseError| e.to_string())?).map_err(|e: tauri::Error| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn browser_resize(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    let webview = app.get_webview("browser-panel").ok_or("Browser not open")?;
    webview.set_position(LogicalPosition::new(x, y)).map_err(|e: tauri::Error| e.to_string())?;
    webview.set_size(LogicalSize::new(width, height)).map_err(|e: tauri::Error| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn browser_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview("browser-panel") {
        webview.close().map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview("browser-panel") {
        use tauri::LogicalPosition;
        webview.set_position(LogicalPosition::new(-9999.0_f64, -9999.0_f64))
            .map_err(|e: tauri::Error| e.to_string())?;
    }
    Ok(())
}

/// Launch a process via WMI (Win32_Process.Create). WMI-created processes are
/// children of the WMI service, NOT of this app — so they live outside any job
/// object tauri dev / cargo wraps us in, and survive dev rebuilds.
fn launch_via_wmi(exe: &std::path::Path) -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let cmdline = format!("\"{}\"", exe.display()).replace('\'', "''");
    let ps = format!(
        "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{ CommandLine = '{}' }}",
        cmdline
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to launch daemon via WMI: {}", e))?;
    Ok(())
}

fn launch_daemon_exe() -> Result<(), String> {
    let daemon_exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("No parent dir")?
        .join("termhostd.exe");

    if daemon_exe.exists() {
        // Production: no job object around us — direct spawn.
        // CREATE_NEW_PROCESS_GROUP (0x200) — daemon gets its own process group
        // CREATE_BREAKAWAY_FROM_JOB (0x01000000) — escape a job if there is one
        // We avoid DETACHED_PROCESS (0x8) because it breaks the Win32 message loop needed for tray icon.
        const FLAGS_BREAKAWAY: u32 = 0x00000200 | 0x01000000;
        match std::process::Command::new(&daemon_exe).creation_flags(FLAGS_BREAKAWAY).spawn() {
            Ok(_) => Ok(()),
            // Job denies breakaway — go through WMI so the daemon ends up outside the job
            Err(e) if e.raw_os_error() == Some(5) => launch_via_wmi(&daemon_exe),
            Err(e) => Err(format!("Failed to launch daemon: {}", e)),
        }
    } else {
        // Dev mode: tauri dev wraps us in a job object that kills children on rebuild.
        // CREATE_BREAKAWAY_FROM_JOB only escapes jobs that allow it (nested jobs may not),
        // so always launch through WMI here — it's the only reliable way to keep the
        // daemon (and all PTYs) alive across dev rebuilds.
        let project_root = std::env::current_exe().map_err(|e| e.to_string())?
            .parent().and_then(|p| p.parent()).and_then(|p| p.parent()).and_then(|p| p.parent())
            .ok_or("Cannot resolve project root")?
            .to_path_buf();
        let dev_daemon = project_root.join("daemon").join("target").join("debug").join("termhostd.exe");
        if !dev_daemon.exists() {
            return Err("Daemon not found. Build it first: cargo build --manifest-path daemon/Cargo.toml".into());
        }
        launch_via_wmi(&dev_daemon)
    }
}

async fn connect_to_daemon() -> Result<(Arc<DaemonClient>, tokio::sync::mpsc::UnboundedReceiver<DaemonResponse>), String> {
    // Try connecting to existing daemon
    for _ in 0..3 {
        if let Ok(result) = DaemonClient::connect().await {
            return Ok(result);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    launch_daemon_exe()?;

    // Wait for daemon to start (in dev mode, cargo needs to compile first — can take 60s+)
    for i in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(if i < 5 { 300 } else { 1000 })).await;
        if let Ok(result) = DaemonClient::connect().await {
            return Ok(result);
        }
    }

    Err("Failed to connect to daemon after launch".into())
}

#[tauri::command]
async fn restart_daemon(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let daemon = state.daemon.clone();

    // Already alive? Nothing to do — avoids opening a duplicate connection.
    let seq = daemon.next_seq();
    if let Ok(DaemonResponse::Pong { .. }) = daemon.request(&DaemonRequest::Ping { seq }).await {
        return Ok(());
    }

    if daemon.reconnect().await.is_err() {
        launch_daemon_exe()?;
        let mut connected = false;
        for i in 0..60 {
            tokio::time::sleep(std::time::Duration::from_millis(if i < 5 { 300 } else { 1000 })).await;
            if daemon.reconnect().await.is_ok() {
                connected = true;
                break;
            }
        }
        if !connected {
            return Err("Failed to connect to daemon after launch".into());
        }
    }

    let _ = daemon.fire_and_forget(&DaemonRequest::SubscribeAll).await;
    let _ = app.emit("daemon-reconnected", ());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--enable-gpu-rasterization --enable-zero-copy --disable-pinch --disable-features=BackForwardCache,TranslateUI --enable-features=CanvasOopRasterization",
    );

    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");

    let (daemon, mut push_rx) = rt.block_on(async {
        connect_to_daemon().await.expect("Failed to connect to PTY daemon")
    });

    // Send SubscribeAll
    let daemon_sub = daemon.clone();
    rt.spawn(async move {
        let _ = daemon_sub.fire_and_forget(&DaemonRequest::SubscribeAll).await;
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState { daemon: daemon.clone() })
        .setup(move |app| {
            // Disable WebView2 built-in browser accelerators (Ctrl+F find bar, Ctrl+R reload,
            // Ctrl+P print, Ctrl+J downloads, Ctrl+U view-source, F12 devtools, etc.).
            // These are handled at a lower level than JS — preventDefault() in JS is too late.
            // SetAreBrowserAcceleratorKeysEnabled(false) stops WebView2 from consuming them,
            // so the keydown event reaches JS normally and our handlers can act on it.
            // NOTE: does NOT affect editing shortcuts (Ctrl+C/V/X/Z/A).
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.with_webview(|wv| {
                    unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows_core::Interface;
                        if let Ok(core) = wv.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                                }
                            }
                        }
                    }
                });
            }

            let handle = app.handle().clone();

            // Spawn push receiver that emits Tauri events
            tauri::async_runtime::spawn(async move {
                while let Some(resp) = push_rx.recv().await {
                    match resp {
                        DaemonResponse::Output { id, data } => {
                            let _ = handle.emit(&format!("pty-data-{}", id), &data);
                        }
                        DaemonResponse::TerminalExited { id, .. } => {
                            let _ = handle.emit(&format!("pty-exit-{}", id), ());
                        }
                        DaemonResponse::TerminalResized { id, cols, rows } => {
                            let _ = handle.emit(
                                &format!("pty-resize-{}", id),
                                serde_json::json!({ "cols": cols, "rows": rows }),
                            );
                        }
                        DaemonResponse::ShowWindow => {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        DaemonResponse::TerminalsChanged => {
                            // Terminal list changed (spawn/kill from phone).
                            // Frontend can listen for this to refresh.
                            let _ = handle.emit("terminals-changed", ());
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let handle = window.app_handle();
                let daemon = handle.state::<AppState>().daemon.clone();
                let has_terminals = tauri::async_runtime::block_on(async {
                    let seq = daemon.next_seq();
                    match daemon.request(&DaemonRequest::ListTerminals { seq }).await {
                        Ok(DaemonResponse::TerminalList { terminals, .. }) => !terminals.is_empty(),
                        _ => false,
                    }
                });
                if has_terminals {
                    api.prevent_close();
                    let _ = window.emit("daemon-close-prompt", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            spawn_terminal,
            write_terminal,
            resize_terminal,
            kill_terminal,
            has_terminal,
            get_terminal_buffer,
            get_terminal_screen,
            list_terminals,
            shutdown_daemon,
            restart_daemon,
            daemon_status,
            list_dir,
            read_file,
            read_file_bytes,
            write_file,
            create_dir,
            rename_path,
            delete_path,
            run_git,
            get_home_dir,
            get_cwd,
            open_folder,
            start_ws_server,
            stop_ws_server,
            ws_server_status,

            sync_workspaces,
            get_pending_pairs,
            pair_approve,
            pair_reject,
            list_devices,
            revoke_device,
            rename_device,
            update_device_note,
            set_auto_approve,
            get_auto_approve,
            set_sleep_config,
            get_sleep_config,
            set_terminal_remote,
            browser_open,
            browser_navigate,
            browser_resize,
            browser_close,
            browser_hide,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
