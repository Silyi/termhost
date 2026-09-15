import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types";

export async function spawnTerminal(
  id: string,
  cwd?: string,
  command?: string,
  cols?: number,
  rows?: number
): Promise<string> {
  return invoke("spawn_terminal", {
    req: { id, cwd: cwd || null, command: command || null, cols: cols || null, rows: rows || null },
  });
}

export async function writeTerminal(id: string, data: string): Promise<void> {
  return invoke("write_terminal", { id, data });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { id, cols, rows });
}

export async function killTerminal(id: string): Promise<void> {
  return invoke("kill_terminal", { id });
}

export async function hasTerminal(id: string): Promise<boolean> {
  return invoke("has_terminal", { id });
}

export async function getTerminalBuffer(id: string): Promise<string> {
  return invoke("get_terminal_buffer", { id });
}

export async function listDir(path: string): Promise<FileEntry[]> {
  return invoke("list_dir", { path });
}

export async function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

export async function readFileBytes(path: string): Promise<number[]> {
  return invoke("read_file_bytes", { path });
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return invoke("write_file", { path, contents });
}

export async function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path });
}

export async function renamePath(from: string, to: string): Promise<void> {
  return invoke("rename_path", { from, to });
}

export async function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  return invoke("run_git", { cwd, args });
}

export async function getHomeDir(): Promise<string> {
  return invoke("get_home_dir");
}

export async function getCwd(): Promise<string> {
  return invoke("get_cwd");
}

export async function openFolder(path: string): Promise<void> {
  return invoke("open_folder", { path });
}

export async function browserOpen(
  url: string, x: number, y: number, width: number, height: number
): Promise<void> {
  return invoke("browser_open", { url, x, y, width, height });
}

export async function browserNavigate(url: string): Promise<void> {
  return invoke("browser_navigate", { url });
}

export async function browserResize(
  x: number, y: number, width: number, height: number
): Promise<void> {
  return invoke("browser_resize", { x, y, width, height });
}

export async function browserClose(): Promise<void> {
  return invoke("browser_close");
}

export async function browserHide(): Promise<void> {
  return invoke("browser_hide");
}

export async function startWsServer(port: number): Promise<string> {
  return invoke("start_ws_server", { port });
}

export async function stopWsServer(): Promise<void> {
  return invoke("stop_ws_server");
}

export async function wsServerStatus(): Promise<{ running: boolean; ip: string; port: number; ips?: string[]; token: string }> {
  return invoke("ws_server_status");
}

export async function listTerminals(): Promise<{ id: string; label: string; cwd: string; command: string; title: string; workspace: string; allowRemote: boolean }[]> {
  return invoke("list_terminals");
}

export async function shutdownDaemon(): Promise<void> {
  return invoke("shutdown_daemon");
}

export async function restartDaemon(): Promise<void> {
  return invoke("restart_daemon");
}

export async function daemonStatus(): Promise<{ connected: boolean; terminalCount: number; protocolMismatch?: boolean }> {
  return invoke("daemon_status");
}

export async function getPendingPairs(): Promise<{ deviceId: string; code: string }[]> {
  return invoke("get_pending_pairs");
}

export async function pairApprove(deviceId: string, label: string = "手机"): Promise<void> {
  return invoke("pair_approve", { deviceId, label });
}

export async function pairReject(deviceId: string): Promise<void> {
  return invoke("pair_reject", { deviceId });
}

export interface DeviceInfo {
  token: string;
  label: string;
  approvedAt: number;
  online: boolean;
  lastSeen: number | null;
  deviceType: string | null;
  note: string;
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return invoke("list_devices");
}

export async function revokeDevice(token: string): Promise<void> {
  return invoke("revoke_device", { token });
}

export async function renameDevice(token: string, label: string): Promise<void> {
  return invoke("rename_device", { token, label });
}

export async function updateDeviceNote(token: string, note: string): Promise<void> {
  return invoke("update_device_note", { token, note });
}

export async function setAutoApprove(enabled: boolean): Promise<void> {
  return invoke("set_auto_approve", { enabled });
}

export async function getAutoApprove(): Promise<boolean> {
  return invoke("get_auto_approve");
}

export async function setSleepConfig(never: boolean, timeoutMinutes: number): Promise<void> {
  return invoke("set_sleep_config", { never, timeoutMinutes });
}

export async function setTerminalRemote(id: string, allowed: boolean): Promise<void> {
  return invoke("set_terminal_remote", { id, allowed });
}

export async function getSleepConfig(): Promise<{ never: boolean; timeoutMinutes: number }> {
  return invoke("get_sleep_config");
}

export async function syncWorkspaces(
  workspaces: { name: string; color: number; terminal_ids: string[] }[],
  activeIdx: number
): Promise<void> {
  return invoke("sync_workspaces", { workspaces, activeIdx });
}
