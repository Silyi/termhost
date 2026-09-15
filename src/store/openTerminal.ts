import { useWorkspaceStore } from "./workspaceStore";
import { usePanelStore } from "./panelStore";
import { useTerminalStore, workspaceTrees, terminalRefs } from "./terminalStore";
import { panesToTree, attachPaneToTree, getTerminalOrderFromTree } from "../hooks/useSplitTree";

/** 把一个已存在的终端接进当前 workspace 的布局并切到终端视图。
 *  终端由 daemon 持有，这里只负责"给它一个可见的窗格" ——
 *  TerminalInstance 会因 hasTerminal(id) 为真而走重连路径回放缓冲。 */
export function openExistingTerminal(termId: string): void {
  const wsStore = useWorkspaceStore.getState();

  // 1) 一个 workspace 都没有 → 建一个，splitTree 直接设成这个终端。
  //    刻意不用 panes 建树：占位叶节点会被 TerminalInstance 当成未知 id 去 spawn，
  //    用户会凭空多出一个空终端。
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

  // 2) 拿到当前树；没有就建一棵。**此处立即落进 Map** —— 后面所有分支共用这个起点。
  let tree = workspaceTrees.get(idx);
  if (!tree) {
    if (created) {
      tree = { type: "leaf", id: termId };
    } else {
      const panes = useWorkspaceStore.getState().workspaces[idx]?.panes ?? [{ cwd: "", command: "" }];
      tree = panesToTree(panes);
    }
    workspaceTrees.set(idx, tree);
  }

  // 3) 不在布局里才插入。已在布局里则原样保留（两个窗格接同一个 PTY 会互相抢尺寸）。
  const order = getTerminalOrderFromTree(tree);
  if (!order.includes(termId)) {
    const anchor = order[0];
    const attached = anchor ? attachPaneToTree(tree, anchor, termId, "horizontal") : null;
    tree = attached ?? { type: "leaf", id: termId };
  }

  // 4) 单一出口：写 Map、触发重绘、持久化、聚焦、切视图。
  //    与 App.tsx 里其它树改动一致（:49-52）—— 少了 save，新窗格重启就没了。
  const terminalStore = useTerminalStore.getState();
  workspaceTrees.set(idx, tree);
  terminalStore.bumpWsTreeVersion();
  wsStore.saveCurrentSplitTree(tree, getTerminalOrderFromTree(tree), terminalRefs, idx);
  terminalStore.setFocusedTerminalId(termId);
  usePanelStore.getState().setActiveView("terminals");
}
