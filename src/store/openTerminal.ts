import { useWorkspaceStore } from "./workspaceStore";
import { usePanelStore } from "./panelStore";
import { useTerminalStore, workspaceTrees, terminalRefs, getTerminalIdsForWorkspace } from "./terminalStore";
import { instantiateTree, attachPaneToTree, removePaneFromTree, getTerminalOrderFromTree } from "../hooks/useSplitTree";

/** 把一个终端从布局里**移出**，但**不杀**它。
 *
 *  用于「弹出为独立窗口」：终端搬到独立窗口后，界面里再留一个窗格既冗余，
 *  又埋一个陷阱 —— 关掉那个窗格会连带杀掉独立窗口（`handleClose` 会 kill）。
 *  TerminalInstance 的卸载清理只销毁本地 xterm，不碰 PTY，所以移出是安全的。
 *
 *  必须持久化：存档 `splitTree` 里若还留着这个窗格 id，下次启动会按 id 把它
 *  原样拉回来，于是刚弹出的终端又会凭空多出一个。 */
export function detachTerminalFromLayout(termId: string): void {
  const wsStore = useWorkspaceStore.getState();
  const terminalStore = useTerminalStore.getState();

  for (const [wsIdx, tree] of workspaceTrees) {
    if (!getTerminalOrderFromTree(tree).includes(termId)) continue;

    const newRoot = removePaneFromTree(tree, termId);
    if (newRoot) {
      workspaceTrees.set(wsIdx, newRoot);
      terminalStore.bumpWsTreeVersion();
      wsStore.saveCurrentSplitTree(newRoot, [], terminalRefs, wsIdx);
      const ids = getTerminalIdsForWorkspace(wsIdx);
      if (ids.length > 0) terminalStore.setFocusedTerminalId(ids[0]);
    } else {
      // 它是这个工作区的最后一个窗格。**不要**学 handleClose 用 panesToTree 补一个
      // 占位叶节点 —— 那会带着新生成的 id 去 spawn 一个全新终端，等于用户一弹出
      // 就凭空多出一个空终端。改为把这个工作区的布局清空。
      workspaceTrees.delete(wsIdx);
      terminalStore.bumpWsTreeVersion();
      wsStore.saveCurrentSplitTree(null, [], terminalRefs, wsIdx);
    }
    return;
  }
}

/** 把一个已存在的终端接进当前 workspace 的布局并切到终端视图。
 *  终端由 daemon 持有，这里只负责"给它一个可见的窗格" ——
 *  TerminalInstance 会因 hasTerminal(id) 为真而走重连路径回放缓冲。 */
export function openExistingTerminal(termId: string): void {
  const wsStore = useWorkspaceStore.getState();

  // 1) 一个 workspace 都没有 → 建一个，splitTree 直接设成这个终端。
  const created = wsStore.workspaces.length === 0;
  if (created) {
    wsStore.addWorkspace({
      name: "工作区",
      color: wsStore.workspaces.length % 8,
      panes: [],
      splitTree: { type: "leaf", id: termId, cwd: "", command: "" },
    });
  }

  const idx = useWorkspaceStore.getState().activeWorkspaceIdx;

  // 2) 拿到当前树；没有就按 App.tsx 的物化规则现算一棵（:43-47）：
  //    有保存过的 splitTree 就实例化它，否则直接以这个终端为叶节点。
  //    刻意不走 panesToTree —— 那会造出一个 id 全新的占位叶节点，
  //    TerminalInstance 见它是未知 id 就去 spawn，用户凭空多出一个空终端。
  let tree = workspaceTrees.get(idx);
  if (!tree) {
    const ws = useWorkspaceStore.getState().workspaces[idx];
    tree = ws?.splitTree ? instantiateTree(ws.splitTree) : { type: "leaf", id: termId };
  }

  // 3) 已挂在**任意**工作区的布局里 → 切过去并聚焦，绝不重复插入。
  //    只查当前工作区是不够的：App.tsx 为每个工作区都渲染 SplitContainer
  //    （未激活的只是 display:none、仍然挂载），同一 id 出现两次就会有两个
  //    TerminalInstance 抢同一个 PTY，且以 id 为键的 terminalRefs Map 会被覆盖。
  for (const [otherIdx, otherTree] of workspaceTrees) {
    if (getTerminalOrderFromTree(otherTree).includes(termId)) {
      wsStore.setActiveWorkspaceIdx(otherIdx);
      useTerminalStore.getState().setFocusedTerminalId(termId);
      usePanelStore.getState().setActiveView("terminals");
      return;
    }
  }

  // 4) 不在任何布局里 → 接进当前布局：挂在第一个已存在的窗格旁边；树为空则自己当根。
  const order = getTerminalOrderFromTree(tree);
  if (!order.includes(termId)) {
    const anchor = order[0];
    const attached = anchor ? attachPaneToTree(tree, anchor, termId, "horizontal") : null;
    tree = attached ?? { type: "leaf", id: termId };
  }

  // 5) 单一出口：写 Map、触发重绘、持久化、聚焦、切视图。
  //    与 App.tsx 里其它树改动一致（:49-52）。
  const terminalStore = useTerminalStore.getState();
  workspaceTrees.set(idx, tree);
  terminalStore.bumpWsTreeVersion();
  wsStore.saveCurrentSplitTree(tree, [], terminalRefs, idx);
  terminalStore.setFocusedTerminalId(termId);
  usePanelStore.getState().setActiveView("terminals");
}
