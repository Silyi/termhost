@echo off
REM termhost-popout.cmd - 把一个 termhost 终端弹到一个新的控制台窗口
REM 用法: termhost-popout.cmd <terminal-id>
REM 不带 id 时: 打印当前可弹出的终端列表并非零退出
REM
REM 与 termhost-wt.bat 的区别: 那个依赖一个名为 termhost-bridge 的 Windows
REM Terminal 配置文件（本机没有），这个不依赖任何配置文件 —— 直接 wt new-tab
REM 起 termhost-bridge.exe，WT 不在就退回普通控制台窗口。
REM
REM 全篇用 goto 而不是 if(...) 括号块: 括号块里的 %ERRORLEVEL% 在块被解析时
REM （也就是命令跑之前）就展开了，退出码会永远是 0。

setlocal

REM 环境变量优先于 argv 是 bridge 的既定顺序（作者的 termhost-bridge-wrapper.cmd
REM 就是这么把 id 传进去的），所以这里必须**无条件**清掉它: 否则调用者的 shell
REM 里若已经有 TERMHOST_TERM_ID，`termhost-popout.cmd <另一个 id>` 会静默弹出
REM 环境变量里那个终端。本脚本一律只通过参数传 id。
set "TERMHOST_TERM_ID="

REM 取脚本自身目录，所以整个仓库挪到哪儿都还能用
set "BRIDGE=%~dp0daemon\target\release\termhost-bridge.exe"

if not exist "%BRIDGE%" (
    echo termhost-popout: bridge not built: "%BRIDGE%"
    echo build it with, from the repo's daemon directory:
    echo   cargo build --release --bin termhost-bridge
    exit /b 2
)

if "%~1"=="" goto noargs

REM 优先 Windows Terminal: -- 之后的内容全部原样传给 exe
where wt.exe >nul 2>nul
if errorlevel 1 goto fallback

wt.exe new-tab -- "%BRIDGE%" "%~1"
if errorlevel 1 goto fallback
exit /b 0

:noargs
REM 不带 id: 让桥接程序自己去列终端
"%BRIDGE%"
exit /b %ERRORLEVEL%

:fallback
REM 没有 wt.exe（或者它起不来）: 直接跑，系统会给它分配一个普通控制台窗口
"%BRIDGE%" "%~1"
exit /b %ERRORLEVEL%
