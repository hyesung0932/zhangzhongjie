#define MyAppName "掌中界"
#define MyAppVersion "1.0.94"
#define MyAppExeName "掌中界.exe"

[Setup]
AppId={{B07A552B-BAA7-4D69-92D2-C1B8FDDA90EE}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppName}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=ZhangZhongJie-Setup-{#MyAppVersion}-x64
SetupIconFile=..\native\resources\app-icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} 安装程序

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式（推荐）"; GroupDescription: "附加快捷方式："; Flags: checkedonce

[Files]
Source: "..\native\bin\x64\Release\掌中界.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\tools\ScreenCapture.exe"; DestDir: "{app}"; Flags: ignoreversion
; ScreenCapture 的 OCR 插件（它找 OCR 时只在自己目录里找 ImageReader.exe；没有就跳浏览器让人去下载）
Source: "..\tools\ImageReader.exe"; DestDir: "{app}"; Flags: ignoreversion
; 随包离线 OCR 引擎（RapidOCR-json / ONNX，约 50MB）：中文、英文比系统自带引擎强，韩文仍走系统 ko
Source: "..\tools\ocr\RapidOCR-json\*"; DestDir: "{app}\ocr\RapidOCR-json"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\native\bin\x64\Release\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "使用手册.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "prerequisites\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\使用手册"; Filename: "{app}\使用手册.html"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\.zzjx"; ValueType: string; ValueData: "ZhangZhongJie.Archive"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Archive"; ValueType: string; ValueData: "掌中界导出项目"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Archive\DefaultIcon"; ValueType: string; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Archive\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\.zzj"; ValueType: string; ValueData: "ZhangZhongJie.Project"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Project"; ValueType: string; ValueData: "掌中界项目文件夹"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Project"; ValueType: string; ValueName: "CanUseForDirectory"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Project\DefaultIcon"; ValueType: string; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Project\shell"; ValueType: string; ValueData: "open"
Root: HKCU; Subkey: "Software\Classes\ZhangZhongJie.Project\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\Directory\shell\OpenInZhangZhongJie"; Flags: uninsdeletekey dontcreatekey
Root: HKCU; Subkey: "Software\Classes\Directory\shell\ZhangZhongJie.Open"; Flags: uninsdeletekey dontcreatekey

[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "正在准备 Microsoft Edge WebView2 Runtime…"; Flags: runhidden waituntilterminated; Check: not IsWebView2Installed
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasRuntimeAt(RootKey: Integer; const BaseKey: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey,
    BaseKey + '\Microsoft\EdgeUpdate\Clients\' + WebView2ClientId,
    'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function IsWebView2Installed: Boolean;
begin
  Result := HasRuntimeAt(HKLM32, 'Software') or
    HasRuntimeAt(HKLM64, 'Software') or
    HasRuntimeAt(HKCU, 'Software');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Association, Command: String;
  OwnExe: String;
begin
  if CurUninstallStep <> usUninstall then exit;
  OwnExe := LowerCase(ExpandConstant('{app}\{#MyAppExeName}'));
  // 只删「这份安装自己注册的」关联：同一台机器上还可能有别的副本（便携版/开发版 run\），
  // 它们随时会再注册回来。以前无条件删 .zzj，会让别的副本的图标凭空消失（2026-09-14 踩过）。
  if RegQueryStringValue(HKCU, 'Software\Classes\.zzj', '', Association) and
     (CompareText(Association, 'ZhangZhongJie.Project') = 0) then
  begin
    Command := '';
    RegQueryStringValue(HKCU, 'Software\Classes\ZhangZhongJie.Project\shell\open\command', '', Command);
    if (Command <> '') and (Pos(OwnExe, LowerCase(Command)) > 0) then
    begin
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\ZhangZhongJie.Project');
      RegDeleteValue(HKCU, 'Software\Classes\.zzj', '');
      RegDeleteKeyIfEmpty(HKCU, 'Software\Classes\.zzj');
    end;
  end;
  if RegQueryStringValue(HKCU, 'Software\Classes\.zzjx', '', Association) and
     (CompareText(Association, 'ZhangZhongJie.Archive') = 0) then
  begin
    Command := '';
    RegQueryStringValue(HKCU, 'Software\Classes\ZhangZhongJie.Archive\shell\open\command', '', Command);
    if (Command <> '') and (Pos(OwnExe, LowerCase(Command)) > 0) then
    begin
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\ZhangZhongJie.Archive');
      RegDeleteValue(HKCU, 'Software\Classes\.zzjx', '');
      RegDeleteKeyIfEmpty(HKCU, 'Software\Classes\.zzjx');
    end;
  end;
end;
