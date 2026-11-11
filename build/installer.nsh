; ShipIt 安装器定制脚本（electron-builder `nsis.include`）
;
; 目的：安装开始时若 ShipIt 正在运行，主动询问用户「自动关闭 / 退出安装」，
; 而不是等到写文件阶段才报「无法关闭，请手动关闭」——那时用户已经走完向导，
; 体验差且容易误以为安装失败。
;
; electron-builder 的 CHECK_APP_RUNNING 会优先使用本宏（见模板
; allowOnlyOneInstallerInstance.nsh：`!ifmacrodef customCheckAppRunning`）。
;
; 判定方式：`tasklist ... | find` 的**退出码**（0=存在，1=不存在），
; 不解析中文/英文输出，避免系统语言差异。

; 编译期回显：日志里能看到这行，证明此文件确实被 electron-builder include 了
!echo "[ShipIt] installer.nsh loaded (customCheckAppRunning)"

!macro customCheckAppRunning
  StrCpy $R1 0 ; 重试计数

  shipit_appcheck:
    ; 用退出码判断进程是否存在（不依赖输出文本，兼容中英文系统）
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | find /I "${APP_EXECUTABLE_FILENAME}"'
    Pop $R0
    Pop $R2

    ${If} $R0 != 0
      ; 没在运行，直接继续
      Goto shipit_appcheck_done
    ${EndIf}

    ${If} $R1 == 0
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "ShipIt 正在运行，安装前需要先关闭它。$\r$\n$\r$\n选择「是」：自动关闭 ShipIt 并继续安装$\r$\n选择「否」：退出安装（稍后手动关闭后再装）" \
        /SD IDYES IDYES shipit_appkill IDNO shipit_appabort

      shipit_appabort:
        Quit

      shipit_appkill:
    ${EndIf}

    DetailPrint "正在关闭 ShipIt..."
    ; /T 连子进程一起关：ShipIt 有 main / renderer / GPU / shipit-server 多个进程，
    ; 只杀主进程会留下持有文件的子进程，导致后面仍然写不进去。
    nsExec::ExecToStack 'cmd /c taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R0
    Pop $R2
    Sleep 1200

    IntOp $R1 $R1 + 1
    ${If} $R1 >= 5
      MessageBox MB_OK|MB_ICONSTOP "无法自动关闭 ShipIt（可能有提权进程）。请手动退出后重新运行安装程序。" /SD IDOK
      Quit
    ${EndIf}
    Goto shipit_appcheck

  shipit_appcheck_done:
!macroend
