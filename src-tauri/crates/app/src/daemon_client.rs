use termhost_shared::protocol::*;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::{mpsc, oneshot, Mutex};
use std::collections::HashMap;

const PIPE_NAME: &str = r"\\.\pipe\termhost-pty-v1";

pub struct DaemonClient {
    writer: Arc<Mutex<tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>>>,
    pending: Arc<std::sync::Mutex<HashMap<u32, oneshot::Sender<DaemonResponse>>>>,
    seq: AtomicU32,
    push_tx: mpsc::UnboundedSender<DaemonResponse>,
}

impl DaemonClient {
    pub async fn connect() -> Result<(Arc<Self>, mpsc::UnboundedReceiver<DaemonResponse>), String> {
        let client = ClientOptions::new()
            .open(PIPE_NAME)
            .map_err(|e| format!("Failed to connect to daemon pipe: {}", e))?;

        let (reader, writer) = tokio::io::split(client);
        let pending: Arc<std::sync::Mutex<HashMap<u32, oneshot::Sender<DaemonResponse>>>> =
            Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (push_tx, push_rx) = mpsc::unbounded_channel();

        Self::spawn_reader(reader, pending.clone(), push_tx.clone());

        let dc = Arc::new(DaemonClient {
            writer: Arc::new(Mutex::new(writer)),
            pending,
            seq: AtomicU32::new(1),
            push_tx,
        });

        Ok((dc, push_rx))
    }

    /// Re-open the pipe after the daemon died/restarted. Reuses the existing
    /// push channel so already-registered Tauri event forwarding keeps working.
    pub async fn reconnect(&self) -> Result<(), String> {
        let client = ClientOptions::new()
            .open(PIPE_NAME)
            .map_err(|e| format!("Failed to connect to daemon pipe: {}", e))?;

        let (reader, writer) = tokio::io::split(client);
        // Drop waiters from the dead connection so they don't hang forever
        self.pending.lock().unwrap().clear();
        *self.writer.lock().await = writer;
        Self::spawn_reader(reader, self.pending.clone(), self.push_tx.clone());
        Ok(())
    }

    fn spawn_reader(
        reader: tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>,
        pending: Arc<std::sync::Mutex<HashMap<u32, oneshot::Sender<DaemonResponse>>>>,
        push_tx: mpsc::UnboundedSender<DaemonResponse>,
    ) {
        tokio::spawn(async move {
            let mut reader = reader;
            loop {
                let frame = match read_frame(&mut reader).await {
                    Ok(Some(f)) => f,
                    _ => break,
                };
                let resp: DaemonResponse = match serde_json::from_slice(&frame) {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                let seq = response_seq(&resp);
                if let Some(seq_val) = seq {
                    let sender = pending.lock().unwrap().remove(&seq_val);
                    if let Some(tx) = sender {
                        let _ = tx.send(resp);
                        continue;
                    }
                }
                // Unsolicited push (Output, TerminalExited)
                let _ = push_tx.send(resp);
            }
        });
    }

    pub fn next_seq(&self) -> u32 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn request(&self, req: &DaemonRequest) -> Result<DaemonResponse, String> {
        let seq = request_seq(req);
        let (tx, rx) = oneshot::channel();

        if let Some(s) = seq {
            self.pending.lock().unwrap().insert(s, tx);
        }

        let frame = encode_message(req).map_err(|e| e.to_string())?;
        {
            let mut w = self.writer.lock().await;
            w.write_all(&frame).await.map_err(|e| e.to_string())?;
            w.flush().await.map_err(|e| e.to_string())?;
        }

        if seq.is_none() {
            // Fire-and-forget (Write, SubscribeAll)
            return Ok(DaemonResponse::Ok { seq: 0 });
        }

        rx.await.map_err(|_| "Daemon disconnected".to_string())
    }

    pub async fn fire_and_forget(&self, req: &DaemonRequest) -> Result<(), String> {
        let frame = encode_message(req).map_err(|e| e.to_string())?;
        let mut w = self.writer.lock().await;
        w.write_all(&frame).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn request_seq(req: &DaemonRequest) -> Option<u32> {
    match req {
        DaemonRequest::Spawn { seq, .. } => Some(*seq),
        DaemonRequest::Resize { seq, .. } => Some(*seq),
        DaemonRequest::Kill { seq, .. } => Some(*seq),
        DaemonRequest::HasTerminal { seq, .. } => Some(*seq),
        DaemonRequest::GetBuffer { seq, .. } => Some(*seq),
        DaemonRequest::GetScreen { seq, .. } => Some(*seq),
        DaemonRequest::ListTerminals { seq } => Some(*seq),
        DaemonRequest::StartWsServer { seq, .. } => Some(*seq),
        DaemonRequest::StopWsServer { seq } => Some(*seq),
        DaemonRequest::WsServerStatus { seq } => Some(*seq),
        DaemonRequest::SyncWorkspaces { seq, .. } => Some(*seq),
        DaemonRequest::Ping { seq } => Some(*seq),
        DaemonRequest::PendingPairs { seq } => Some(*seq),
        DaemonRequest::PairApprove { seq, .. } => Some(*seq),
        DaemonRequest::PairReject { seq, .. } => Some(*seq),
        DaemonRequest::ListDevices { seq } => Some(*seq),
        DaemonRequest::RevokeDevice { seq, .. } => Some(*seq),
        DaemonRequest::RenameDevice { seq, .. } => Some(*seq),
        DaemonRequest::UpdateDeviceNote { seq, .. } => Some(*seq),
        DaemonRequest::SetAutoApprove { seq, .. } => Some(*seq),
        DaemonRequest::GetAutoApprove { seq } => Some(*seq),
        DaemonRequest::SetSleepConfig { seq, .. } => Some(*seq),
        DaemonRequest::GetSleepConfig { seq } => Some(*seq),
        DaemonRequest::SetTerminalRemote { seq, .. } => Some(*seq),
        DaemonRequest::Write { .. } | DaemonRequest::SubscribeAll | DaemonRequest::Shutdown => None,
    }
}

fn response_seq(resp: &DaemonResponse) -> Option<u32> {
    match resp {
        DaemonResponse::Ok { seq } => Some(*seq),
        DaemonResponse::Error { seq, .. } => Some(*seq),
        DaemonResponse::SpawnResult { seq, .. } => Some(*seq),
        DaemonResponse::HasResult { seq, .. } => Some(*seq),
        DaemonResponse::BufferData { seq, .. } => Some(*seq),
        DaemonResponse::ScreenData { seq, .. } => Some(*seq),
        DaemonResponse::TerminalList { seq, .. } => Some(*seq),
        DaemonResponse::WsStatus { seq, .. } => Some(*seq),
        DaemonResponse::Pong { seq, .. } => Some(*seq),
        DaemonResponse::PendingPairsResult { seq, .. } => Some(*seq),
        DaemonResponse::ListDevicesResult { seq, .. } => Some(*seq),
        DaemonResponse::AutoApproveStatus { seq, .. } => Some(*seq),
        DaemonResponse::SleepConfigStatus { seq, .. } => Some(*seq),
        DaemonResponse::Output { .. } | DaemonResponse::TerminalExited { .. } | DaemonResponse::TerminalResized { .. } | DaemonResponse::ShowWindow | DaemonResponse::TerminalsChanged => None,
    }
}

async fn read_frame(
    reader: &mut tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>,
) -> Result<Option<Vec<u8>>, std::io::Error> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 16 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(Some(buf))
}
