import type { TreeNode, TreeConfig, PaneConfig } from "../types";

let termCounter = 0;

export function makeTermId(): string {
  return `term-${Date.now()}-${termCounter++}`;
}

export function panesToTree(panes: PaneConfig[], depth = 0): TreeNode {
  if (panes.length === 1) {
    return { type: "leaf", id: makeTermId(), _cwd: panes[0].cwd, _command: panes[0].command };
  }
  const mid = Math.ceil(panes.length / 2);
  const direction = depth % 2 === 0 ? "horizontal" : "vertical";
  return {
    type: "split",
    direction: direction as "horizontal" | "vertical",
    ratio: 0.5,
    first: panesToTree(panes.slice(0, mid), depth + 1),
    second: panesToTree(panes.slice(mid), depth + 1),
  };
}

export function instantiateTree(config: TreeConfig): TreeNode {
  if (config.type === "leaf") {
    return { type: "leaf", id: config.id || makeTermId(), _cwd: config.cwd, _command: config.command };
  }
  return {
    type: "split",
    direction: config.direction,
    ratio: config.ratio,
    first: instantiateTree(config.first),
    second: instantiateTree(config.second),
  };
}

export function getTerminalOrderFromTree(node: TreeNode | null): string[] {
  if (!node) return [];
  if (node.type === "leaf") return [node.id];
  return [
    ...getTerminalOrderFromTree(node.first),
    ...getTerminalOrderFromTree(node.second),
  ];
}


export function splitPaneInTree(
  root: TreeNode,
  targetId: string,
  direction: "horizontal" | "vertical"
): { newRoot: TreeNode; newLeafId: string } | null {
  const newLeafId = makeTermId();

  function insertSplit(node: TreeNode): TreeNode | null {
    if (node.type === "leaf") {
      if (node.id === targetId) {
        return {
          type: "split",
          direction,
          ratio: 0.5,
          first: node,
          second: { type: "leaf", id: newLeafId, _cwd: node._cwd },
        };
      }
      return null;
    }
    const newFirst = insertSplit(node.first);
    if (newFirst) return { ...node, first: newFirst };
    const newSecond = insertSplit(node.second);
    if (newSecond) return { ...node, second: newSecond };
    return null;
  }

  const newRoot = insertSplit(root);
  if (!newRoot) return null;
  return { newRoot, newLeafId };
}

export function removePaneFromTree(
  root: TreeNode,
  targetId: string
): TreeNode | null {
  if (root.type === "leaf") {
    return root.id === targetId ? null : root;
  }

  if (root.first.type === "leaf" && root.first.id === targetId) {
    return root.second;
  }
  if (root.second.type === "leaf" && root.second.id === targetId) {
    return root.first;
  }

  const newFirst = removePaneFromTree(root.first, targetId);
  if (newFirst !== root.first) {
    return { ...root, first: newFirst! };
  }
  const newSecond = removePaneFromTree(root.second, targetId);
  if (newSecond !== root.second) {
    return { ...root, second: newSecond! };
  }
  return root;
}

/** 把一个**已存在**的终端接进布局树。
 *  与 splitPaneInTree 同形，区别是新叶节点的 id 由调用方给出 —— 用于接入
 *  一个已经在 daemon 里跑着的终端（手机建的、或断线重连的），而不是新建一个。 */
export function attachPaneToTree(
  root: TreeNode,
  targetId: string,
  newPaneId: string,
  direction: "horizontal" | "vertical"
): TreeNode | null {
  function insertSplit(node: TreeNode): TreeNode | null {
    if (node.type === "leaf") {
      if (node.id === targetId) {
        return {
          type: "split",
          direction,
          ratio: 0.5,
          first: node,
          second: { type: "leaf", id: newPaneId },
        };
      }
      return null;
    }
    const newFirst = insertSplit(node.first);
    if (newFirst) return { ...node, first: newFirst };
    const newSecond = insertSplit(node.second);
    if (newSecond) return { ...node, second: newSecond };
    return null;
  }
  return insertSplit(root);
}
