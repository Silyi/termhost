import { useWorkspaceStore } from "./workspaceStore";
import { usePanelStore } from "./panelStore";
import { useTerminalStore, workspaceTrees } from "./terminalStore";
import { panesToTree, attachPaneToTree, getTerminalOrderFromTree } from "../hooks/useSplitTree";

/** 把一个已存在的终端接进当前 workspace 的布局并切到终端视图。
 *  终端由 daemon 持有，这里只负责"给它一个可见的窗格" ——
 *  TerminalInstance 会因 hasTerminal(id) 为真而走重连路径回放缓冲。 */
export function openExistingTerminal(termId: string): void {
  const wsStore = useWorkspaceStore.getState();

  // 1) 一个 workspace 都没有 → 建一个
  if (wsStore.workspaces.length === 0) {
    wsStore.addWorkspace({ name: "终端", color: 0, panes: [{ cwd: "", command: "" }] });
  }

  const idx = useWorkspaceStore.getState().activeWorkspaceIdx;
  const panes = useWorkspaceStore.getState().workspaces[idx]?.panes ?? [{ cwd: "", command: "" }];

  // 2) 该 workspace 还没有树 → 按它的 panes 建一棵
  let tree = workspaceTrees.get(idx) ?? panesToTree(panes);

  // 3) 已经在这个布局里 → 只聚焦，不重复插入
  //    （两个窗格接同一个 PTY 会互相抢尺寸）
  if (getTerminalOrderFromTree(tree).includes(termId)) {
    useTerminalStore.getState().setFocusedTerminalId(termId);
    usePanelStore.getState().setActiveView("terminals");
    return;
  }

  // 4) 接进布局：挂在第一个已存在的窗格旁边；树为空则自己当根
  const anchor = getTerminalOrderFromTree(tree)[0];
  const attached = anchor ? attachPaneToTree(tree, anchor, termId, "horizontal") : null;
  workspaceTrees.set(idx, attached ?? { type: "leaf", id: termId });

  usePanelStore.getState().setActiveView("terminals");
}
