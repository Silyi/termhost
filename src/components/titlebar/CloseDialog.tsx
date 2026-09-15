import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { shutdownDaemon, daemonStatus } from "../../hooks/useTauriIpc";
import s from "./CloseDialog.module.css";

export default function CloseDialog() {
  const [visible, setVisible] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const unlisten = listen("daemon-close-prompt", () => {
      setVisible(true);
      // 把「还有几个终端」写成具体数字。用户看不懂这个对话框，一半是因为
      // 不知道后台到底留着什么 —— 「后台终端正在运行」是抽象的，数字不是。
      daemonStatus()
        .then((st) => setCount(st.terminalCount))
        .catch(() => setCount(null));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  if (!visible) return null;

  // 注意：「隐藏到托盘」和「关闭窗口」在这里本来就是同一件事 —— daemon 与
  // pty-host 是独立进程，窗口 hide 之后终端照常运行。原代码里那个
  // handleCloseOnly 就是这条重复路径留下的死代码，已删除。
  const handleKeepAlive = () => {
    getCurrentWindow().hide();
  };

  const handleKillAll = async () => {
    await shutdownDaemon().catch(() => {});
    getCurrentWindow().destroy();
  };

  const handleCancel = () => {
    setVisible(false);
  };

  const title = count === null ? "后台还有终端在运行" : `后台还有 ${count} 个终端在运行`;

  return (
    <div className={s.overlay}>
      <div className={s.dialog}>
        <div className={s.title}>{title}</div>
        <div className={s.body}>
          终端不归这个窗口管 —— 它们在一个独立的守护进程里，所以关掉窗口并不会
          结束它们。请选择怎么处理：
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
          <strong>隐藏到托盘</strong>：窗口收起，这些终端继续运行，手机也还能连上来；
          双击托盘图标即可恢复
        </div>
        <div className={s.hint}>
          <strong>全部终止并退出</strong>：把上面这些终端全部杀掉再退出 —— 手机将连不上，
          下次启动是干净的
        </div>
      </div>
    </div>
  );
}
