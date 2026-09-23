# 掌中界安装包

运行 `build-installer.ps1` 会先构建 Release，再按微软官方链接下载 WebView2 Evergreen Bootstrapper，并用 Inno Setup 6 生成安装包。

安装范围默认为当前用户，安装目录为 `%LOCALAPPDATA%\Programs\掌中界`。安装器会检测 WebView2 Runtime；只有缺失时才运行微软 Bootstrapper。

`.zzjx` 注册为可双击打开的掌中界导出项目。`.zzj` 是目录工程包，保存时宿主会按 Windows Shell 的 `desktop.ini / DirectoryClass` 机制标记项目目录，安装器注册对应目录类、图标和默认打开命令，因此也能双击进入掌中界。
