use serde::{Deserialize, Serialize};

/// Bump on every breaking change to DaemonRequest/DaemonResponse.
/// The app compares the daemon's version (returned in Pong) against its own
/// and surfaces a mismatch so the user can restart the outdated daemon.
pub const PROTOCOL_VERSION: u32 = 1;

// --- Shared types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub command: String,
    pub title: String,
    pub workspace: String,
    #[serde(default, rename = "allowRemote")]
    pub allow_remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub color: u8,
    #[serde(rename = "terminalCount")]
    pub terminal_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceData {
    pub name: String,
    pub color: u8,
    pub terminal_ids: Vec<String>,
}

// --- IPC Protocol ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonRequest {
    Spawn {
        seq: u32,
        id: String,
        cwd: String,
        command: Option<String>,
        cols: u16,
        rows: u16,
    },
    Write {
        id: String,
        data: String,
    },
    Resize {
        seq: u32,
        id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        seq: u32,
        id: String,
    },
    HasTerminal {
        seq: u32,
        id: String,
    },
    GetBuffer {
        seq: u32,
        id: String,
    },
    GetScreen {
        seq: u32,
        id: String,
    },
    ListTerminals {
        seq: u32,
    },
    SubscribeAll,
    StartWsServer {
        seq: u32,
        port: u16,
    },
    StopWsServer {
        seq: u32,
    },
    WsServerStatus {
        seq: u32,
    },
    SyncWorkspaces {
        seq: u32,
        workspaces: Vec<WorkspaceData>,
        active_idx: usize,
    },
    Ping {
        seq: u32,
    },
    PendingPairs {
        seq: u32,
    },
    PairApprove {
        seq: u32,
        device_id: String,
        label: String,
    },
    PairReject {
        seq: u32,
        device_id: String,
    },
    ListDevices {
        seq: u32,
    },
    RevokeDevice {
        seq: u32,
        token: String,
    },
    RenameDevice {
        seq: u32,
        token: String,
        label: String,
    },
    UpdateDeviceNote {
        seq: u32,
        token: String,
        note: String,
    },
    SetAutoApprove {
        seq: u32,
        enabled: bool,
    },
    GetAutoApprove {
        seq: u32,
    },
    SetSleepConfig {
        seq: u32,
        never: bool,
        timeout_minutes: u32,
    },
    GetSleepConfig {
        seq: u32,
    },
    SetTerminalRemote {
        seq: u32,
        id: String,
        allowed: bool,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPairInfo {
    pub device_id: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovedDeviceInfo {
    pub token: String,
    pub label: String,
    pub approved_at: i64,
    #[serde(default)]
    pub last_seen: Option<i64>,
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonResponse {
    Ok { seq: u32 },
    Error { seq: u32, message: String },
    SpawnResult { seq: u32, id: String },
    HasResult { seq: u32, exists: bool },
    BufferData { seq: u32, id: String, data: String },
    /// Current-screen vt100 snapshot (see `GetScreen`). `data: None` means there
    /// is no screen for this id — the cols/rows then carry no meaning.
    ScreenData { seq: u32, id: String, data: Option<String>, cols: u16, rows: u16 },
    TerminalList { seq: u32, terminals: Vec<TerminalInfo> },
    Output { id: String, data: String },
    /// Unsolicited: the shared PTY was resized by another client (e.g. a phone in
    /// Control mode). Lets the desktop follow the size cleanly instead of garbling.
    TerminalResized { id: String, cols: u16, rows: u16 },
    TerminalExited { id: String, code: Option<i32> },
    /// Sent when terminals are created or killed from another client (e.g. phone).
    /// Desktop should refresh its terminal list.
    TerminalsChanged,
    WsStatus { seq: u32, running: bool, ip: String, #[serde(default)] port: u16, #[serde(default)] ips: Vec<String>, #[serde(default)] token: String, #[serde(default)] cf_url: Option<String> },
    // version defaults to 0 for daemons built before versioning existed
    Pong {
        seq: u32,
        #[serde(default)]
        version: u32,
    },
    ShowWindow,
    PendingPairsResult {
        seq: u32,
        pairs: Vec<PendingPairInfo>,
    },
    ListDevicesResult {
        seq: u32,
        devices: Vec<ApprovedDeviceInfo>,
    },
    AutoApproveStatus {
        seq: u32,
        enabled: bool,
    },
    SleepConfigStatus {
        seq: u32,
        never: bool,
        timeout_minutes: u32,
    },
}

// --- Frame encoding/decoding ---

pub fn encode_frame(msg: &[u8]) -> Vec<u8> {
    let len = msg.len() as u32;
    let mut frame = Vec::with_capacity(4 + msg.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(msg);
    frame
}

pub fn encode_message<T: Serialize>(msg: &T) -> Result<Vec<u8>, serde_json::Error> {
    let json = serde_json::to_vec(msg)?;
    Ok(encode_frame(&json))
}
