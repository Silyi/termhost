import type { PaneConfig } from "../types";

export interface WsTemplate {
  name: string;
  panes: PaneConfig[];
  builtin?: boolean;
}

const CLAUDE_CMD = "claude --dangerously-skip-permissions";
const CODEX_CMD = "codex --yolo";

export const BUILTIN_TEMPLATES: WsTemplate[] = [
  {
    name: "Claude + 终端",
    builtin: true,
    panes: [
      { cwd: "", command: CLAUDE_CMD },
      { cwd: "", command: "" },
    ],
  },
  {
    name: "Claude ×2",
    builtin: true,
    panes: [
      { cwd: "", command: CLAUDE_CMD },
      { cwd: "", command: CLAUDE_CMD },
    ],
  },
  {
    name: "Claude ×4",
    builtin: true,
    panes: [
      { cwd: "", command: CLAUDE_CMD },
      { cwd: "", command: CLAUDE_CMD },
      { cwd: "", command: CLAUDE_CMD },
      { cwd: "", command: CLAUDE_CMD },
    ],
  },
  {
    name: "Codex + 终端",
    builtin: true,
    panes: [
      { cwd: "", command: CODEX_CMD },
      { cwd: "", command: "" },
    ],
  },
  {
    name: "智能体 + 服务器 + 终端",
    builtin: true,
    panes: [
      { cwd: "", command: CLAUDE_CMD },
      { cwd: "", command: "" },
      { cwd: "", command: "" },
    ],
  },
];

const TEMPLATES_KEY = "agentworkspace-ws-templates";

export function loadCustomTemplates(): WsTemplate[] {
  try {
    const arr = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((t) => t && t.name && Array.isArray(t.panes)) : [];
  } catch {
    return [];
  }
}

export function saveCustomTemplate(template: WsTemplate) {
  const list = loadCustomTemplates().filter((t) => t.name !== template.name);
  list.push({ name: template.name, panes: template.panes });
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
}

export function deleteCustomTemplate(name: string) {
  const list = loadCustomTemplates().filter((t) => t.name !== name);
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
}
