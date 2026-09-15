import { useState, useCallback } from "react";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { usePanelStore } from "../../store/panelStore";
import { WS_COLORS } from "../../constants/themes";
import { BUILTIN_TEMPLATES, loadCustomTemplates, saveCustomTemplate, deleteCustomTemplate, type WsTemplate } from "../../constants/wsTemplates";
import type { PaneConfig } from "../../types";
import s from "./Pages.module.css";

interface Props {
  editIdx: number | null;
  onSave: (wasEdit?: boolean) => void;
}

const PANE_COUNTS = [1, 2, 3, 4, 6, 8];

const MODES = [
  { key: "shell", label: "终端", cmd: "" },
  { key: "claude", label: "Claude Code", cmd: "claude --dangerously-skip-permissions" },
  { key: "codex", label: "Codex", cmd: "codex --yolo" },
] as const;

type Mode = typeof MODES[number]["key"];

function detectMode(panes: PaneConfig[]): Mode {
  if (panes.length === 0) return "shell";
  const cmd = panes[0].command;
  if (cmd.startsWith("claude")) return "claude";
  if (cmd.startsWith("codex")) return "codex";
  return "shell";
}

export default function WorkspaceEditor({ editIdx, onSave }: Props) {
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const homeDir = useWorkspaceStore((st) => st.homeDir);
  const addWorkspace = useWorkspaceStore((st) => st.addWorkspace);
  const updateWorkspace = useWorkspaceStore((st) => st.updateWorkspace);
  const showTerminals = usePanelStore((st) => st.showTerminals);

  const isEdit = editIdx !== null;
  const existingWs = isEdit ? workspaces[editIdx] : null;

  const initialPanes = existingWs && existingWs.panes.length > 0
    ? existingWs.panes
    : [{ cwd: homeDir, command: "" }];

  const [name, setName] = useState(existingWs?.name || "");
  const [projectFolder, setProjectFolder] = useState("");
  const [panes, setPanes] = useState<PaneConfig[]>(initialPanes);
  const [mode, setMode] = useState<Mode>(detectMode(initialPanes));
  const [customTemplates, setCustomTemplates] = useState<WsTemplate[]>(loadCustomTemplates);
  const [templateSaved, setTemplateSaved] = useState(false);

  const applyTemplate = useCallback((t: WsTemplate) => {
    const folder = projectFolder.trim();
    setPanes(t.panes.map((p) => ({ cwd: p.cwd || folder || homeDir, command: p.command })));
    setMode(detectMode(t.panes));
    if (!name.trim() && !t.builtin) setName(t.name);
  }, [projectFolder, homeDir, name]);

  const handleSaveTemplate = useCallback(() => {
    const tplName = name.trim() || `模板（${panes.length} 个窗格）`;
    saveCustomTemplate({ name: tplName, panes });
    setCustomTemplates(loadCustomTemplates());
    setTemplateSaved(true);
    setTimeout(() => setTemplateSaved(false), 1500);
  }, [name, panes]);

  const applyMode = useCallback((m: Mode) => {
    setMode(m);
    const modeCmd = MODES.find((x) => x.key === m)!.cmd;
    setPanes((prev) => prev.map((p) => ({ ...p, command: modeCmd })));
  }, []);

  const applyProjectFolder = useCallback((folder: string) => {
    setProjectFolder(folder);
    if (folder.trim()) {
      setPanes((prev) => prev.map((p) => ({ ...p, cwd: folder.trim() })));
    }
  }, []);

  const setPaneCount = useCallback((count: number) => {
    const modeCmd = MODES.find((x) => x.key === mode)!.cmd;
    setPanes((prev) => {
      if (count === prev.length) return prev;
      if (count < prev.length) return prev.slice(0, count);
      const extra = Array.from({ length: count - prev.length }, () => ({ cwd: homeDir, command: modeCmd }));
      return [...prev, ...extra];
    });
  }, [homeDir, mode]);

  const removePaneRow = useCallback(
    (idx: number) => {
      if (panes.length <= 1) return;
      setPanes(panes.filter((_, i) => i !== idx));
    },
    [panes]
  );

  const updatePane = useCallback(
    (idx: number, field: "cwd" | "command", value: string) => {
      const updated = [...panes];
      updated[idx] = { ...updated[idx], [field]: value };
      setPanes(updated);
    },
    [panes]
  );

  const handleSave = useCallback(() => {
    const wsName = name.trim() || "工作区";

    if (isEdit && editIdx !== null) {
      updateWorkspace(editIdx, { name: wsName });
      onSave(true);
    } else {
      const finalPanes = panes.map((p) => ({
        cwd: p.cwd.trim() || homeDir,
        command: p.command.trim(),
      }));
      const activeIdx = useWorkspaceStore.getState().activeWorkspaceIdx;
      const existing = useWorkspaceStore.getState().workspaces[activeIdx];
      if (existing && !existing.splitTree) {
        updateWorkspace(activeIdx, { name: wsName, panes: finalPanes });
        onSave();
      } else {
        const colorIdx = workspaces.length % WS_COLORS.length;
        addWorkspace({ name: wsName, color: colorIdx, panes: finalPanes });
        onSave();
      }
    }
  }, [name, panes, isEdit, editIdx, homeDir, workspaces.length, updateWorkspace, addWorkspace, onSave]);

  const handleCancel = useCallback(() => {
    showTerminals();
  }, [showTerminals]);

  return (
    <div className={s.page}>
      <div className={s.editor}>
        <div className={s.editorTitle}>
          <h2>{isEdit ? "编辑" : "新建"}工作区</h2>
          <span className={s.editorSubtitle}>
            {isEdit ? "重命名你的工作区" : "配置终端布局"}
          </span>
        </div>

        {!isEdit && (
          <section className={s.section}>
            <label className={s.fieldLabel}>模板</label>
            <div className={s.modePicker} style={{ flexWrap: "wrap" }}>
              {BUILTIN_TEMPLATES.map((t) => (
                <button key={t.name} className={s.modeBtn} onClick={() => applyTemplate(t)} title={t.panes.map((p) => p.command || "shell").join(" · ")}>
                  {t.name}
                </button>
              ))}
              {customTemplates.map((t) => (
                <span key={t.name} style={{ display: "inline-flex", alignItems: "center" }}>
                  <button className={s.modeBtn} onClick={() => applyTemplate(t)} title={t.panes.map((p) => p.command || "shell").join(" · ")}>
                    ★ {t.name}
                  </button>
                  <button
                    className={s.modeBtn}
                    style={{ padding: "0 6px", marginLeft: -4 }}
                    title="删除模板"
                    onClick={() => { deleteCustomTemplate(t.name); setCustomTemplates(loadCustomTemplates()); }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </section>
        )}

        {!isEdit && (
          <section className={s.section}>
            <label className={s.fieldLabel}>类型</label>
            <div className={s.modePicker}>
              {MODES.map((m) => (
                <button
                  key={m.key}
                  className={`${s.modeBtn} ${mode === m.key ? s.modeBtnActive : ""}`}
                  onClick={() => applyMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className={s.section}>
          <label className={s.fieldLabel}>名称</label>
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的工作区"
            autoFocus
          />
        </section>

        {!isEdit && (
          <>
            <section className={s.section}>
              <label className={s.fieldLabel}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                项目文件夹
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className={s.input}
                  value={projectFolder}
                  onChange={(e) => setProjectFolder(e.target.value)}
                  placeholder="例如 C:\Users\me\projects\myapp"
                  style={{ fontFamily: "monospace", fontSize: 12 }}
                />
                <button className={s.btn} onClick={() => applyProjectFolder(projectFolder)} style={{ whiteSpace: "nowrap" }}>
                  应用到全部
                </button>
              </div>
              <span style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, display: "block" }}>
                将此文件夹设为所有窗格的工作目录
              </span>
            </section>

            <section className={s.section}>
              <div className={s.panesHeader}>
                <label className={s.fieldLabel} style={{ margin: 0 }}>窗格</label>
                <div className={s.paneCountPicker}>
                  {PANE_COUNTS.map((n) => (
                    <button
                      key={n}
                      className={`${s.paneCountBtn} ${panes.length === n ? s.paneCountActive : ""}`}
                      onClick={() => setPaneCount(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div className={s.paneList}>
                {panes.map((p, i) => (
                  <div key={i} className={s.paneRow}>
                    <span className={s.paneRowNum}>{i + 1}</span>
                    <div className={s.paneInputs}>
                      <input
                        className={s.paneCwd}
                        value={p.cwd}
                        onChange={(e) => updatePane(i, "cwd", e.target.value)}
                        placeholder="工作目录"
                      />
                      <input
                        className={s.paneCmd}
                        value={p.command}
                        onChange={(e) => updatePane(i, "command", e.target.value)}
                        placeholder="命令（可选）"
                      />
                    </div>
                    {panes.length > 1 && (
                      <button className={s.removePaneBtn} onClick={() => removePaneRow(i)} title="移除">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l6 6M9 3l-6 6"/></svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        <div className={s.actions}>
          {!isEdit && (
            <button className={s.btn} onClick={handleSaveTemplate} title="将当前窗格配置保存为可复用模板">
              {templateSaved ? "已保存 ✓" : "保存为模板"}
            </button>
          )}
          {isEdit && <button className={s.btn} onClick={handleCancel}>取消</button>}
          <button className={s.btnAccent} onClick={handleSave}>
            {isEdit ? "保存更改" : "创建工作区"}
          </button>
        </div>
      </div>
    </div>
  );
}
