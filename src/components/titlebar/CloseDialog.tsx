import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { shutdownDaemon } from "../../hooks/useTauriIpc";
import s from "./CloseDialog.module.css";

export default function CloseDialog() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unlisten = listen("daemon-close-prompt", () => setVisible(true));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  if (!visible) return null;

  const handleKeepAlive = () => {
    getCurrentWindow().hide();
  };

  const handleKillAll = async () => {
    await shutdownDaemon().catch(() => {});
    getCurrentWindow().destroy();
  };

  const handleCloseOnly = () => {
    getCurrentWindow().hide();
  };

  const handleCancel = () => {
    setVisible(false);
  };

  return (
    <div className={s.overlay}>
      <div className={s.dialog}>
        <div className={s.title}>后台终端正在运行</div>
        <div className={s.body}>
          PTY 守护进程还有活动终端。关闭窗口时要如何处理？
        </div>
        <div className={s.actions}>
          <button className={s.btnSecondary} onClick={handleCancel}>取消</button>
          <button className={s.btnPrimary} onClick={handleKeepAlive}>
            隐藏到托盘
          </button>
          <button className={s.btnDanger} onClick={handleKillAll}>
            全部终止并退出
          </button>
        </div>
        <div className={s.hint}>
          「隐藏到托盘」—— 窗口会隐藏，终端继续运行，双击托盘图标即可恢复
        </div>
      </div>
    </div>
  );
}
