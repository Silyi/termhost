import { useEffect, useCallback, useMemo, useRef } from "react";
import Titlebar from "./components/titlebar/Titlebar";
import SplitContainer from "./components/splitpane/SplitContainer";
import SearchBar from "./components/search/SearchBar";
import ExplorerPanel from "./components/panels/ExplorerPanel";
import TranslateTooltip from "./components/translate/TranslateTooltip";
import CloseDialog from "./components/titlebar/CloseDialog";
import WorkspaceEditor from "./components/pages/WorkspaceEditor";
import PairingPage from "./components/pages/PairingPage";
import Dashboard from "./components/pages/Dashboard";
import AllTerminals from "./components/pages/AllTerminals";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePinchZoom } from "./hooks/usePinchZoom";
import { useSettingsStore } from "./store/settingsStore";
import { useWorkspaceStore } from "./store/workspaceStore";
import { useTerminalStore, terminalRefs, workspaceTrees, getTerminalIdsForWorkspace } from "./store/terminalStore";
import { usePanelStore } from "./store/panelStore";
import { detachTerminalFromLayout } from "./store/openTerminal";
import { getHomeDir, killTerminal, resizeTerminal } from "./hooks/useTauriIpc";
import { panesToTree, instantiateTree, splitPaneInTree, removePaneFromTree } from "./hooks/useSplitTree";

export default function App() {
  const loadSettings = useSettingsStore((st) => st.loadSettings);
  const loadWorkspaces = useWorkspaceStore((st) => st.loadWorkspaces);
  const setHomeDir = useWorkspaceStore((st) => st.setHomeDir);
  const activeView = usePanelStore((st) => st.activeView);
  const setActiveView = usePanelStore((st) => st.setActiveView);
  const setFocusedTerminalId = useTerminalStore((st) => st.setFocusedTerminalId);
  const bumpWsTreeVersion = useTerminalStore((st) => st.bumpWsTreeVersion);
  const wsTreeVersion = useTerminalStore((st) => st.wsTreeVersion);
  const activeWsIdx = useWorkspaceStore((st) => st.activeWorkspaceIdx);
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const switchTimerRef = useRef<number>(0);
  const explorerOpen = usePanelStore((st) => st.explorerOpen);
  const fullscreen = usePanelStore((st) => st.fullscreen);
  const searchVisible = usePanelStore((st) => st.searchVisible);
  const toggleSearch = usePanelStore((st) => st.toggleSearch);

  const ensureWorkspaceTree = useCallback((wsIdx: number) => {
    if (workspaceTrees.has(wsIdx)) return;
    const ws = useWorkspaceStore.getState().workspaces[wsIdx];
    if (!ws) return;
    let tree;
    if (ws.splitTree) {
      tree = instantiateTree(ws.splitTree);
    } else if (ws.panes.length > 0) {
      tree = panesToTree(ws.panes);
    } else {
      // 既没有存档也没有窗格 —— **不要**凭空造一个。panesToTree 会生成全新的 id，
      // 于是挂载时 TerminalInstance 见 id 未知就去 spawn，用户凭空多出一个空终端。
      // 保持「没有树」这个状态，界面会落到空态；这样「把所有终端都弹出去了」
      // 之后工作区能真正空着，而不是下次启动又冒出一个。
      return;
    }
    workspaceTrees.set(wsIdx, tree);
    bumpWsTreeVersion();
    // Persist immediately so freshly generated pane IDs survive a hard kill
    useWorkspaceStore.getState().saveCurrentSplitTree(tree, [], terminalRefs, wsIdx);
  }, [bumpWsTreeVersion]);

  useEffect(() => {
    loadSettings();
    loadWorkspaces();
    getHomeDir().then(setHomeDir);
  }, []);

  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((state) => {
      if (state.workspaces.length > 0 && !workspaceTrees.has(state.activeWorkspaceIdx)) {
        ensureWorkspaceTree(state.activeWorkspaceIdx);
        unsub();
      }
    });
    const st = useWorkspaceStore.getState();
    if (st.workspaces.length > 0) {
      ensureWorkspaceTree(st.activeWorkspaceIdx);
      unsub();
    }
    return unsub;
  }, []);

  const saveTree = useCallback((wsIdx?: number) => {
    const idx = wsIdx ?? useWorkspaceStore.getState().activeWorkspaceIdx;
    const tree = workspaceTrees.get(idx);
    if (!tree) return;
    const order = getTerminalIdsForWorkspace(idx);
    useWorkspaceStore.getState().saveCurrentSplitTree(tree, order, terminalRefs, idx);
  }, []);

  useEffect(() => {
    const saveAll = () => {
      for (const [wsIdx] of workspaceTrees) {
        saveTree(wsIdx);
      }
    };
    // Periodic save: dev rebuilds kill the process hard and beforeunload never
    // fires — without this, pane IDs are lost and daemon terminals get orphaned.
    const interval = window.setInterval(saveAll, 15000);
    window.addEventListener("beforeunload", saveAll);
    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", saveAll);
    };
  }, [saveTree]);

  const killWorkspaceTerminals = useCallback((wsIdx: number) => {
    const ids = getTerminalIdsForWorkspace(wsIdx);
    ids.forEach((id) => killTerminal(id).catch(() => {}));
    workspaceTrees.delete(wsIdx);
    bumpWsTreeVersion();
  }, [bumpWsTreeVersion]);

  const handleDeleteWorkspace = useCallback((idx: number) => {
    const ids = getTerminalIdsForWorkspace(idx);
    ids.forEach((id) => killTerminal(id).catch(() => {}));
    workspaceTrees.delete(idx);
    const newMap = new Map<number, import("./types").TreeNode>();
    for (const [key, val] of workspaceTrees) {
      newMap.set(key > idx ? key - 1 : key, val);
    }
    workspaceTrees.clear();
    for (const [key, val] of newMap) {
      workspaceTrees.set(key, val);
    }
    useWorkspaceStore.getState().deleteWorkspace(idx);
    bumpWsTreeVersion();
    const remaining = useWorkspaceStore.getState().workspaces;
    if (remaining.length > 0) {
      const newActiveIdx = useWorkspaceStore.getState().activeWorkspaceIdx;
      ensureWorkspaceTree(newActiveIdx);
      const newIds = getTerminalIdsForWorkspace(newActiveIdx);
      if (newIds.length > 0) setFocusedTerminalId(newIds[0]);
    } else {
      setFocusedTerminalId(null);
    }
  }, [bumpWsTreeVersion, ensureWorkspaceTree, setFocusedTerminalId]);

  const handleSwitchWorkspace = useCallback((idx: number) => {
    const current = useWorkspaceStore.getState().activeWorkspaceIdx;
    if (idx === current) return;
    if (useTerminalStore.getState().zoomedTerminalId) {
      useTerminalStore.setState({ zoomedTerminalId: null });
    }
    saveTree(current);
    clearTimeout(switchTimerRef.current);
    useWorkspaceStore.getState().setActiveWorkspaceIdx(idx);
    const ws = useWorkspaceStore.getState().workspaces[idx];
    if (ws && !ws.splitTree) {
      setActiveView("workspace-editor");
      return;
    }
    ensureWorkspaceTree(idx);
    setActiveView("terminals");
    const ids = getTerminalIdsForWorkspace(idx);
    if (ids.length > 0) setFocusedTerminalId(ids[0]);
    ids.forEach((id) => {
      const pane = document.querySelector(`[data-pane-id="${id}"]`) as HTMLElement | null;
      if (pane) pane.style.visibility = "hidden";
    });
    switchTimerRef.current = window.setTimeout(() => {
      ids.forEach((id) => {
        const ref = terminalRefs.get(id);
        if (ref) {
          ref.fitAddon.fit();
          resizeTerminal(id, ref.term.cols, ref.term.rows).catch(() => {});
        }
      });
      requestAnimationFrame(() => {
        ids.forEach((id) => {
          const pane = document.querySelector(`[data-pane-id="${id}"]`) as HTMLElement | null;
          if (pane) pane.style.visibility = "";
        });
      });
    }, 50);
  }, [saveTree, ensureWorkspaceTree, setActiveView, setFocusedTerminalId]);

  const handleRotate = useCallback((id: string) => {
    const wsIdx = useWorkspaceStore.getState().activeWorkspaceIdx;
    const root = workspaceTrees.get(wsIdx);
    if (!root) return;
    function findParentSplit(node: import("./types").TreeNode, targetId: string): import("./types").SplitNode | null {
      if (node.type === "leaf") return null;
      const hasTarget = (n: import("./types").TreeNode): boolean =>
        n.type === "leaf" ? n.id === targetId : hasTarget(n.first) || hasTarget(n.second);
      if (hasTarget(node.first) || hasTarget(node.second)) {
        const inFirst = findParentSplit(node.first, targetId);
        if (inFirst) return inFirst;
        const inSecond = findParentSplit(node.second, targetId);
        if (inSecond) return inSecond;
        return node;
      }
      return null;
    }
    const parent = findParentSplit(root, id);
    if (parent) {
      parent.direction = parent.direction === "horizontal" ? "vertical" : "horizontal";
      bumpWsTreeVersion();
      requestAnimationFrame(() => saveTree(wsIdx));
    }
  }, [bumpWsTreeVersion, saveTree]);

  const handleSwapWithDirection = useCallback((sourceId: string, targetId: string, zone: "left" | "right" | "top" | "bottom" | "center") => {
    const wsIdx = useWorkspaceStore.getState().activeWorkspaceIdx;
    let root = workspaceTrees.get(wsIdx);
    if (!root) return;

    type TN = import("./types").TreeNode;
    type SN = import("./types").SplitNode;
    type LN = import("./types").LeafNode;

    function findLeaf(node: TN, id: string): LN | null {
      if (node.type === "leaf") return node.id === id ? node : null;
      return findLeaf(node.first, id) || findLeaf(node.second, id);
    }

    if (zone === "center") {
      // Swap by exchanging nodes in their parent splits
      function findParentAndSide(node: TN, id: string): { parent: SN; side: "first" | "second" } | null {
        if (node.type === "leaf") return null;
        const sp = node as SN;
        if (sp.first.type === "leaf" && sp.first.id === id) return { parent: sp, side: "first" };
        if (sp.second.type === "leaf" && sp.second.id === id) return { parent: sp, side: "second" };
        return findParentAndSide(sp.first, id) || findParentAndSide(sp.second, id);
      }
      const pa = findParentAndSide(root, sourceId);
      const pb = findParentAndSide(root, targetId);
      if (pa && pb) {
        const tmp = pa.parent[pa.side];
        pa.parent[pa.side] = pb.parent[pb.side];
        pb.parent[pb.side] = tmp;
      }
    } else {
      const splitDir = (zone === "left" || zone === "right") ? "horizontal" : "vertical";
      const isBeforeTarget = zone === "left" || zone === "top";

      // Check if source and target are siblings in the same split
      function findParentSplit(node: TN, id: string): SN | null {
        if (node.type === "leaf") return null;
        const sp = node as SN;
        const containsId = (n: TN): boolean =>
          n.type === "leaf" ? n.id === id : containsId(n.first) || containsId(n.second);
        if (containsId(sp.first) || containsId(sp.second)) {
          return findParentSplit(sp.first, id) || findParentSplit(sp.second, id) || sp;
        }
        return null;
      }

      const sourceParent = findParentSplit(root, sourceId);
      const targetParent = findParentSplit(root, targetId);

      // If siblings — just change direction and reorder
      if (sourceParent && sourceParent === targetParent) {
        sourceParent.direction = splitDir;
        const sourceIsFirst = (sourceParent.first.type === "leaf" && sourceParent.first.id === sourceId) ||
          (sourceParent.first.type !== "leaf" && findLeaf(sourceParent.first, sourceId));
        if (isBeforeTarget && !sourceIsFirst) {
          const tmp = sourceParent.first;
          sourceParent.first = sourceParent.second;
          sourceParent.second = tmp;
        } else if (!isBeforeTarget && sourceIsFirst) {
          const tmp = sourceParent.first;
          sourceParent.first = sourceParent.second;
          sourceParent.second = tmp;
        }
      } else {
        // Different parents — restructure tree
        const sourceLeaf = findLeaf(root, sourceId);
        if (!sourceLeaf) return;
        const sourceCopy: LN = { type: "leaf", id: sourceLeaf.id, _cwd: sourceLeaf._cwd, _command: sourceLeaf._command };

        function removeLeaf(node: TN, id: string): TN | null {
          if (node.type === "leaf") return null;
          const sp = node as SN;
          if (sp.first.type === "leaf" && sp.first.id === id) return sp.second;
          if (sp.second.type === "leaf" && sp.second.id === id) return sp.first;
          const nf = removeLeaf(sp.first, id);
          if (nf) { sp.first = nf; return node; }
          const ns = removeLeaf(sp.second, id);
          if (ns) { sp.second = ns; return node; }
          return null;
        }

        if (root.type === "leaf" && root.id === sourceId) return;

        const newRoot = removeLeaf(root, sourceId);
        if (!newRoot) return;
        root = newRoot;
        workspaceTrees.set(wsIdx, root);

        function insertAtTarget(node: TN): boolean {
          if (node.type === "leaf") return false;
          const sp = node as SN;
          for (const side of ["first", "second"] as const) {
            if (sp[side].type === "leaf" && sp[side].id === targetId) {
              const targetCopy: LN = { ...(sp[side] as LN) };
              sp[side] = {
                type: "split", direction: splitDir, ratio: 0.5,
                first: isBeforeTarget ? sourceCopy : targetCopy,
                second: isBeforeTarget ? targetCopy : sourceCopy,
              };
              return true;
            }
          }
          return insertAtTarget(sp.first) || insertAtTarget(sp.second);
        }

        if (root.type === "leaf" && root.id === targetId) {
          const targetCopy: LN = { ...root };
          workspaceTrees.set(wsIdx, {
            type: "split", direction: splitDir, ratio: 0.5,
            first: isBeforeTarget ? sourceCopy : targetCopy,
            second: isBeforeTarget ? targetCopy : sourceCopy,
          });
        } else {
          insertAtTarget(root);
        }
      }
    }

    bumpWsTreeVersion();
    requestAnimationFrame(() => {
      getTerminalIdsForWorkspace(wsIdx).forEach((tid) => {
        const ref = terminalRefs.get(tid);
        if (ref) {
          ref.fitAddon.fit();
          resizeTerminal(tid, ref.term.cols, ref.term.rows).catch(() => {});
        }
      });
      saveTree(wsIdx);
    });
  }, [bumpWsTreeVersion, saveTree]);

  const handleSplit = useCallback((id: string, direction: "horizontal" | "vertical") => {
    const wsIdx = useWorkspaceStore.getState().activeWorkspaceIdx;
    const root = workspaceTrees.get(wsIdx);
    if (!root) return;
    const ref = terminalRefs.get(id);
    const currentCwd = ref?.lastDir || ref?.cwd;
    if (currentCwd) {
      function setCwd(node: import("./types").TreeNode): void {
        if (node.type === "leaf" && node.id === id) node._cwd = currentCwd;
        else if (node.type === "split") { setCwd(node.first); setCwd(node.second); }
      }
      setCwd(root);
    }
    const result = splitPaneInTree(root, id, direction);
    if (result) {
      workspaceTrees.set(wsIdx, result.newRoot);
      bumpWsTreeVersion();
      setFocusedTerminalId(result.newLeafId);
      requestAnimationFrame(() => saveTree(wsIdx));
    }
  }, [bumpWsTreeVersion, setFocusedTerminalId, saveTree]);

  const handleClose = useCallback((id: string) => {
    if (useTerminalStore.getState().zoomedTerminalId === id) {
      useTerminalStore.getState().toggleZoom(id);
    }
    killTerminal(id).catch((e) => {
      // 不能静默：杀失败时终端仍活在 daemon 里，之后又会在「所有终端」里冒出来。
      console.error(`[关闭窗格] 杀掉终端 ${id} 失败:`, e);
    });
    // 只解除布局对这个终端的引用，别再自己维护树。
    //
    // 以前这里在「关掉最后一个窗格」时会用 panesToTree 造一个**新**窗格 —— 那个
    // 新叶节点带着新 id 去 spawn 一个新终端，而标签是按目录算的（PS: <文件夹>），
    // 新旧长得一模一样，于是看起来就像「× 没用，终端又回来了」。
    // 现在最后一个窗格关掉就是关掉，工作区真的空下来（见 ensureWorkspaceTree）。
    detachTerminalFromLayout(id);
  }, []);

  // Listen for close-pane events from keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail;
      if (id) handleClose(id);
    };
    window.addEventListener("agentworkspace:close-pane", handler);
    return () => window.removeEventListener("agentworkspace:close-pane", handler);
  }, [handleClose]);

  const handleTreeUpdate = useCallback(() => {
    terminalRefs.forEach((ref) => {
      ref.fitAddon.fit();
    });
    saveTree(useWorkspaceStore.getState().activeWorkspaceIdx);
  }, [saveTree]);

  const handleNewWorkspace = useCallback(() => {
    const current = useWorkspaceStore.getState().activeWorkspaceIdx;
    saveTree(current);
    const colorIdx = useWorkspaceStore.getState().workspaces.length % 8;
    useWorkspaceStore.getState().addWorkspace({
      name: "工作区",
      color: colorIdx,
      panes: [{ cwd: "", command: "" }],
    });
    setActiveView("workspace-editor");
  }, [saveTree, setActiveView]);

  const handleWorkspaceSaved = useCallback(() => {
    const wsIdx = useWorkspaceStore.getState().activeWorkspaceIdx;
    killWorkspaceTerminals(wsIdx);
    ensureWorkspaceTree(wsIdx);
    setActiveView("terminals");
    const ids = getTerminalIdsForWorkspace(wsIdx);
    if (ids.length > 0) setFocusedTerminalId(ids[0]);
  }, [killWorkspaceTerminals, ensureWorkspaceTree, setActiveView, setFocusedTerminalId]);

  const shortcutActions = useMemo(() => ({
    onSplitH: () => {
      const id = useTerminalStore.getState().focusedTerminalId;
      if (id) handleSplit(id, "horizontal");
    },
    onSplitV: () => {
      const id = useTerminalStore.getState().focusedTerminalId;
      if (id) handleSplit(id, "vertical");
    },
    onEditWorkspace: () => {
      window.dispatchEvent(new CustomEvent("agentworkspace:edit-workspace"));
    },
    onNewWorkspace: handleNewWorkspace,
  }), [handleSplit, handleNewWorkspace]);

  const zoomedTerminalId = useTerminalStore((st) => st.zoomedTerminalId);
  useEffect(() => {
    requestAnimationFrame(() => {
      if (zoomedTerminalId) {
        const ref = terminalRefs.get(zoomedTerminalId);
        if (ref) {
          ref.fitAddon.fit();
          resizeTerminal(zoomedTerminalId, ref.term.cols, ref.term.rows).catch(() => {});
        }
      } else {
        terminalRefs.forEach((ref, id) => {
          ref.fitAddon.fit();
          resizeTerminal(id, ref.term.cols, ref.term.rows).catch(() => {});
        });
      }
    });
  }, [zoomedTerminalId]);

  useKeyboardShortcuts(shortcutActions);
  usePinchZoom();

  return (
    <div id="app" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {!fullscreen && <Titlebar
        onSwitchWorkspace={handleSwitchWorkspace}
        onNewWorkspace={handleNewWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
      />}
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ flex: 1, display: "flex", position: "relative", overflow: "hidden" }}>
            {activeView === "dashboard" && <Dashboard />}
            {activeView === "terminals" && workspaces.map((_, wsIdx) => {
              const tree = workspaceTrees.get(wsIdx);
              if (!tree) return null;
              const isActive = wsIdx === activeWsIdx;
              return (
                <div
                  key={wsIdx}
                  style={{
                    display: isActive ? "flex" : "none",
                    flex: 1,
                    width: "100%",
                    height: "100%",
                    position: isActive ? "relative" : "absolute",
                  }}
                >
                  <SplitContainer
                    node={tree}
                    onSplit={handleSplit}
                    onClose={handleClose}
                    onRotate={handleRotate}
                    onSwapWithDirection={handleSwapWithDirection}
                    onTreeUpdate={handleTreeUpdate}
                  />
                </div>
              );
            })}
            {activeView === "terminals" && (workspaces.length === 0 || !workspaceTrees.has(activeWsIdx)) && (
              <WorkspaceEditor editIdx={null} onSave={handleWorkspaceSaved} />
            )}
            {activeView === "workspace-editor" && (
              <WorkspaceEditor editIdx={null} onSave={handleWorkspaceSaved} />
            )}
            {activeView === "pairing" && (
              <PairingPage />
            )}
            {activeView === "all-terminals" && (
              <AllTerminals />
            )}
            {searchVisible && <SearchBar onClose={toggleSearch} />}
          </div>
        </div>
        {explorerOpen && <ExplorerPanel />}
      </div>
      <TranslateTooltip />
      <CloseDialog />
    </div>
  );
}
