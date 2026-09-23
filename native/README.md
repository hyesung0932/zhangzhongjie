# 掌中界 Windows 原生宿主

这一目录承载 Windows 专用桌面外壳：

- WebView2 运行现有 React 无限画布；
- Windows `IExplorerBrowser` 提供真实 Shell 文件视图和原生文件操作；
- React 与原生层通过 WebView2 消息通信；
- 不替换 `explorer.exe`，不安装驱动、服务或 Explorer 扩展。

构建：

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build.ps1
```

运行：

```powershell
& '.\native\bin\x64\Release\掌中界.exe'
```

WebView2 SDK 只下载到项目内 `.packages`；系统运行时使用 Windows 已安装的 Evergreen WebView2。
