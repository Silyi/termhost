import { useWorkspaceStore } from "./workspaceStore";
import { usePanelStore } from "./panelStore";
import { useTerminalStore, workspaceTrees, terminalRefs } from "./terminalStore";
import { instantiateTree, attachPaneToTree, getTerminalOrderFromTree } from "../hooks/useSplitTree";

/** 把一个已存在的终端接进当前 workspace 的布局并切到终端视图。
 *  终端由 daemon 持有，这里只负责"给它一个可见的窗格" ——
 *  TerminalInstance 会因 hasTerminal(id) 为真而走重连路径回放缓冲。 */
export function openExistingTerminal(termId: string): void {
  const wsStore = useWorkspaceStore.getState();

  // 1) 一个 workspace 都没有 → 建一个，splitTree 直接设成这个终端。
  const created = wsStore.workspaces.length === 0;
  if (created) {
    wsStore.addWorkspace({
      name: "终端",
      color: 0,
      panes: [],
      splitTree: { type: "leaf", id: termId, cwd: "", command: "" },
    });
  }

  const idx = useWorkspaceStore.getState().activeWorkspaceIdx;

  // 2) 拿到当前树；没有就**按 App.tsx 的物化规则现算一棵**（:43-47）：
  //    有保存过的 splitTree 就实例化它，否则直接以这个终端为叶节点。
  //    刻意**不**走 panesToTree —— 那会造出一个 id 全新的占位叶节点，
  //    TerminalInstance 见它是未知 id 就去 spawn，用户凭空多出一个空终端。
  let tree = workspaceTrees.get(idx);
  if (!tree) {
    const ws = useWorkspaceStore.getState().workspaces[idx];
    tree = ws?.splitTree ? instantiateTree(ws.splitTree) : { type: "leaf", id: termId };
  }

  // 3) 不在布局里才插入；已在则原样保留（两个窗格接同一个 PTY 会互相抢尺寸）。
  const order = getTerminalOrderFromTree(tree);
  if (!order.includes(termId)) {
    const anchor = order[0];
    const attached = anchor ? attachPaneToTree(tree, anchor, termId, "horizontal") : null;
    tree = attached ?? { type: "leaf", id: termId };
  }

  // 4) 单一出口：写 Map、触发重绘、持久化、聚焦、切视图。
  //    与 App.tsx 里其它树改动一致（:49-52）。
  const terminalStore = useTerminalStore.getState();
  workspaceTrees.set(idx, tree);
  terminalStore.bumpWsTreeVersion();
  wsStore.saveCurrentSplitTree(tree, [], terminalRefs, idx);
  terminalStore.setFocusedTerminalId(termId);
  usePanelStore.getState().setActiveView("terminals");
}
