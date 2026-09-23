#include <windows.h>
#include <windowsx.h>
#include <dcomp.h>
#include <dwmapi.h>
#include <wincodec.h>
#include <shlobj.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <propkey.h>
#include <shlwapi.h>
#include <uxtheme.h>
#include <wrl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <cstdlib>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <exception>
#include <limits>
#include <memory>
#include <mutex>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"
#include "resource.h"

#include <psapi.h>
#pragma comment(lib, "psapi.lib")

// 离线 OCR：Windows 自带引擎（Windows.Media.Ocr）。零体积、免联网、系统已装语言包即可用。
// 注意：C++/WinRT 头必须放在 windows.h 之后，且需要 NOMINMAX（本文件没用 min/max 宏）。
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>
#pragma comment(lib, "windowsapp.lib")

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {
constexpr wchar_t kMainWindowClass[] = L"ZhangZhongJie.Native.Main";
constexpr wchar_t kSurfaceHostClass[] = L"ZhangZhongJie.Native.SurfaceHost";
constexpr wchar_t kCompositionHostClass[] = L"ZhangZhongJie.Native.CompositionHost";
constexpr UINT_PTR kSurfaceSweepTimer = 1;
constexpr UINT_PTR kExplorerStateTimer = 2;
constexpr UINT_PTR kCloseRequestTimer = 3;
constexpr UINT_PTR kNativeDragTimer = 4;
constexpr UINT kCloseRequestTimeoutMs = 3000;
constexpr UINT kSavePayloadTimeoutMs = 30000;
// 大文件缩略图护栏：超过 128MB 的文件/包内条目跳过真实缩略图抽取（要整读或解压源文件，
// 几十秒起步还会把磁盘和内存拖爆），直接用廉价图标兜底。
constexpr ULONGLONG kMaxThumbnailSourceBytes = 128ull * 1024ull * 1024ull;
// 包内条目物化（解压到临时文件）上限：巨人条目（如 3GB 安装包）不再整水解压，
// 这类条目在预览里直接显示图标。
constexpr ULONGLONG kMaxShellPreviewMaterializeBytes = 128ull * 1024ull * 1024ull;
constexpr uint32_t kMaxProjectJsonBytes = 64u * 1024u * 1024u;
constexpr ULONGLONG kSurfaceGraceMs = 600;
constexpr UINT kShellChangeMessage = WM_APP + 41;
constexpr UINT kBeginNativeDragMessage = WM_APP + 42;
constexpr UINT kBeginWindowDragMessage = WM_APP + 43;
constexpr UINT kWindowMinimizeMessage = WM_APP + 44;
constexpr UINT kWindowToggleMaximizeMessage = WM_APP + 45;
constexpr UINT kWindowCloseMessage = WM_APP + 46;
constexpr UINT kApplyWindowAppearanceMessage = WM_APP + 47;
constexpr UINT kPostCanvasMessage = WM_APP + 48;
constexpr UINT kRestoreAfterMinimizeMessage = WM_APP + 49;
constexpr UINT_PTR kSplitWatchTimer = 5;   // 分屏看守：搭档被搬走/关掉就收手
constexpr UINT_PTR kHeartbeatTimer = 6;     // 心跳：内存/句柄变化记进 lifecycle.log（排查“悄无声息就退出”）
constexpr UINT kWindowSnapLeftMessage = WM_APP + 50;
constexpr UINT kOpenExternalProjectMessage = WM_APP + 51;
constexpr UINT kWindowSnapRightMessage = WM_APP + 52;
constexpr UINT kWindowSnapLayoutMessage = WM_APP + 53;
constexpr UINT kApplyWindowMaterialMessage = WM_APP + 54;
constexpr UINT kArchiveMirrorReadyMessage = WM_APP + 55;
constexpr UINT kPipExitRequestMessage = WM_APP + 56;  // 画中画窗口被双击 → 请页面退出画中画（钩子里不直接调 COM，转回窗口过程）
constexpr UINT_PTR kPipWatchTimer = 7;           // 认「系统画中画窗口」（Chromium 稍后才建出来）
constexpr UINT_PTR kPipCenterTimer = 8;          // 画中画窗口建出来后再居中一次（Chromium 会晚一步自己摆位置）
constexpr ULONG_PTR kProjectOpenCopyData = 0x5a5a4a5a;

HWND g_mainWindow = nullptr;
HWND g_compositionHost = nullptr;
ComPtr<IDCompositionDevice> g_compositionDevice;
ComPtr<IDCompositionTarget> g_compositionTarget;
ComPtr<IDCompositionVisual> g_compositionRoot;
ComPtr<ICoreWebView2Environment> g_environment;
ComPtr<ICoreWebView2Environment> g_browserEnvironment;
ComPtr<ICoreWebView2Controller> g_appController;
ComPtr<ICoreWebView2> g_appWebView;
std::wstring g_appFolder;
std::wstring g_dataFolder;
std::atomic<int> g_copyWatchers{0};
std::atomic<bool> g_tileApplyBusy{false};  // 分屏应用期间拒绝重复请求（要抢前台+等窗口响应）
// 最近一次分屏的搭档：拖动分屏把手时，掌中界与它一起改大小。
struct SplitPartnerState {
  HWND window = nullptr;
  RECT work{};
  RECT selfBefore{};       // 分屏前掌中界自己的位置：退出分屏就还原回去
  bool hasSelfBefore = false;
  double ratio = 0.5;
  bool selfFirst = true;   // true = 掌中界在左/上，搭档在右/下
  bool vertical = false;   // true = 左右分（边界是竖线）
  bool active = false;
  ULONGLONG watchArmedAt = 0;  // 宽限期：这之前不看漂移（摆放还没落稳）
  int partnerDriftTicks = 0;   // 搭档连续偏离几次才算“被搬走”
};

SplitPartnerState g_splitPartner;
void PostToCanvasAsync(std::wstring json);  // 定义在下方，这里前向声明（退出分屏要从窗口过程里回报）
HWINEVENTHOOK g_splitPartnerHook = nullptr;      // 监听搭档窗口被关/最小化
HWINEVENTHOOK g_splitPartnerMoveHook = nullptr;  // 监听搭档被拖动/改大小（实时跟随）
void AdjustSplitBoundary(double ratio);      // 定义在下方（拖边界/拖搭档时两边一起摆）
void FollowPartnerLive();                    // 搭档被拖动时的实时跟随（事件驱动）

// 记下分屏前的窗口位置（系统贴靠会先把自己挪走，所以要在贴靠之前记）。
void RememberSelfBeforeSplit() {
  if (g_splitPartner.active || !g_mainWindow) return;
  RECT current{};
  if (GetWindowRect(g_mainWindow, &current)) {
    g_splitPartner.selfBefore = current;
    g_splitPartner.hasSelfBefore = true;
  }
}

// 退出分屏：旁边没有贴靠的搭档了，画布直接最大化（用户定的规则，简单可预期）。
void ReleaseSplit(bool notify, bool restoreSelf = true) {
  (void)restoreSelf;
  if (!g_splitPartner.active) return;
  g_splitPartner.active = false;
  g_splitPartner.window = nullptr;
  if (g_splitPartnerHook) { UnhookWinEvent(g_splitPartnerHook); g_splitPartnerHook = nullptr; }
  if (g_splitPartnerMoveHook) { UnhookWinEvent(g_splitPartnerMoveHook); g_splitPartnerMoveHook = nullptr; }
  if (g_mainWindow) {
    KillTimer(g_mainWindow, kSplitWatchTimer);
    if (IsIconic(g_mainWindow)) ShowWindow(g_mainWindow, SW_RESTORE);
    ShowWindow(g_mainWindow, SW_MAXIMIZE);
  }
  g_splitPartner.hasSelfBefore = false;
  if (notify) PostToCanvasAsync(L"{\"type\":\"native-split-released\"}");
}

// 搭档窗口被关掉/最小化 → 立刻退出分屏（事件驱动，不靠计时器）。
void CALLBACK SplitPartnerEventProc(HWINEVENTHOOK, DWORD event, HWND window, LONG, LONG, DWORD, DWORD) {
  if (!g_splitPartner.active || !window || window != g_splitPartner.window) return;
  if (event == EVENT_OBJECT_LOCATIONCHANGE) {
    FollowPartnerLive();
    return;
  }
  if (event == EVENT_OBJECT_DESTROY || event == EVENT_OBJECT_HIDE || event == EVENT_SYSTEM_MINIMIZESTART) {
    ReleaseSplit(true);
  }
}

void WatchSplitPartner(HWND partner) {
  if (g_splitPartnerHook) { UnhookWinEvent(g_splitPartnerHook); g_splitPartnerHook = nullptr; }
  if (g_splitPartnerMoveHook) { UnhookWinEvent(g_splitPartnerMoveHook); g_splitPartnerMoveHook = nullptr; }
  if (!partner) return;
  g_splitPartnerHook = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_OBJECT_HIDE, nullptr,
    SplitPartnerEventProc, 0, 0, WINEVENT_OUTOFCONTEXT);
  // 单独挂一个“位置变化”的钩子（事件范围窄，开销小）：用户拖搭档时画布能实时跟着动。
  g_splitPartnerMoveHook = SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, nullptr,
    SplitPartnerEventProc, 0, 0, WINEVENT_OUTOFCONTEXT);
}

// 期望的分屏几何：按当前比例算出掌中界与搭档各自该占的矩形。
RECT ExpectedSplitRect(bool self) {
  const RECT work = g_splitPartner.work;
  RECT result = work;
  const int width = work.right - work.left;
  const int height = work.bottom - work.top;
  const int boundary = g_splitPartner.vertical
    ? work.left + static_cast<int>(width * g_splitPartner.ratio + 0.5)
    : work.top + static_cast<int>(height * g_splitPartner.ratio + 0.5);
  const bool selfOnFirstSide = g_splitPartner.selfFirst;
  if (g_splitPartner.vertical) {
    if (self) { if (selfOnFirstSide) result.right = boundary; else result.left = boundary; }
    else { if (selfOnFirstSide) result.left = boundary; else result.right = boundary; }
  } else {
    if (self) { if (selfOnFirstSide) result.bottom = boundary; else result.top = boundary; }
    else { if (selfOnFirstSide) result.top = boundary; else result.bottom = boundary; }
  }
  return result;
}

int RectDrift(const RECT& a, const RECT& b) {
  return std::max(std::max(std::abs(a.left - b.left), std::abs(a.top - b.top)),
    std::max(std::abs((a.right - a.left) - (b.right - b.left)), std::abs((a.bottom - a.top) - (b.bottom - b.top))));
}

// 分屏看守（500ms 定时器 + WinEvent 钩子）：
//  ①搭档被关掉/最小化 → 退出分屏并还原画布；
//  ②搭档被拖走/改大小 → 退出分屏并还原画布；
//  ③掌中界自己被用户拖走/改大小 → 只结束分屏，不抢他刚放好的位置。
// 搭档是不是还占着“它那一半”：竖直分屏看纵向是否仍铺满工作区，水平分屏看横向。
// 占着 → 用户只是在拉边界（把网页拉窄/拉宽），掌中界就跟着一起变；
// 不占着（被拖成一块小窗飘在别处 / 拖到别的屏幕）→ 才算“分屏结束”。
bool PartnerStillInItsSlot(const RECT& partner) {
  const RECT work = g_splitPartner.work;
  const int spanTolerance = 90;
  if (g_splitPartner.vertical) {
    return std::abs(partner.top - work.top) <= spanTolerance && std::abs(partner.bottom - work.bottom) <= spanTolerance;
  }
  return std::abs(partner.left - work.left) <= spanTolerance && std::abs(partner.right - work.right) <= spanTolerance;
}

// 搭档被拖动/改大小的瞬间就被调用（WinEvent 位置事件）：按它的共享边实时把掌中界跟过去。
// 这样拖网页那条边的时候，画布是连续跟着变的，不是等 0.5 秒跳一下。
void FollowPartnerLive() {
  if (!g_splitPartner.active || !g_splitPartner.window || !g_mainWindow) return;
  const ULONGLONG now = GetTickCount64();
  if (g_splitPartner.watchArmedAt && now < g_splitPartner.watchArmedAt) return;
  RECT partnerNow{};
  if (!GetWindowRect(g_splitPartner.window, &partnerNow)) return;
  if (!PartnerStillInItsSlot(partnerNow)) return;   // 飘走的情况交给看守定时器收尾
  const RECT work = g_splitPartner.work;
  const int width = work.right - work.left;
  const int height = work.bottom - work.top;
  if (width <= 0 || height <= 0) return;
  double ratio = g_splitPartner.ratio;
  if (g_splitPartner.vertical) {
    const int boundary = g_splitPartner.selfFirst ? partnerNow.left : partnerNow.right;
    ratio = static_cast<double>(boundary - work.left) / width;
  } else {
    const int boundary = g_splitPartner.selfFirst ? partnerNow.top : partnerNow.bottom;
    ratio = static_cast<double>(boundary - work.top) / height;
  }
  // 变化太小就别折腾（避免自己移动自己造成的回声事件）。
  if (std::abs(ratio - g_splitPartner.ratio) < 0.0015) return;
  g_splitPartner.partnerDriftTicks = 0;
  AdjustSplitBoundary(ratio);
}

void TickSplitPartner() {
  if (!g_splitPartner.active) return;
  if (!g_mainWindow) { ReleaseSplit(false); return; }
  const ULONGLONG now = GetTickCount64();
  // 宽限期：刚摆完的那一两秒窗口还在动画/重绘，别急着判定“被搬走”。
  if (g_splitPartner.watchArmedAt && now < g_splitPartner.watchArmedAt) return;
  const HWND partner = g_splitPartner.window;
  if (!partner || !IsWindow(partner) || IsIconic(partner) || !IsWindowVisible(partner)) { ReleaseSplit(true); return; }
  RECT selfNow{}, partnerNow{};
  if (!GetWindowRect(g_mainWindow, &selfNow) || !GetWindowRect(partner, &partnerNow)) { ReleaseSplit(true); return; }

  const int tolerance = 40;
  const bool partnerMoved = RectDrift(partnerNow, ExpectedSplitRect(false)) > tolerance;
  const bool selfMoved = RectDrift(selfNow, ExpectedSplitRect(true)) > tolerance;
  if (!partnerMoved && !selfMoved) { g_splitPartner.partnerDriftTicks = 0; return; }
  // 掌中界自己被动过、搭档没动 → 用户就是想把它放那儿，不抢。
  if (selfMoved && !partnerMoved) return;

  // 搭档还占着它那一半 → 当成“拉边界调比例”：按它现在的共享边重算比例，掌中界跟着变。
  if (!PartnerStillInItsSlot(partnerNow)) {
    if (++g_splitPartner.partnerDriftTicks >= 3) ReleaseSplit(true);
    return;
  }
  const RECT work = g_splitPartner.work;
  const int width = work.right - work.left;
  const int height = work.bottom - work.top;
  if (width <= 0 || height <= 0) return;
  double ratio = g_splitPartner.ratio;
  if (g_splitPartner.vertical) {
    const int boundary = g_splitPartner.selfFirst ? partnerNow.left : partnerNow.right;
    ratio = static_cast<double>(boundary - work.left) / width;
  } else {
    const int boundary = g_splitPartner.selfFirst ? partnerNow.top : partnerNow.bottom;
    ratio = static_cast<double>(boundary - work.top) / height;
  }
  g_splitPartner.partnerDriftTicks = 0;
  AdjustSplitBoundary(ratio);
}
bool CopyInProgress();  // 定义在剪贴板/拷贝观察那一节：拷贝进行中就暂停后台重 IO
std::wstring g_currentProjectPath;
std::wstring g_currentPackageRoot;
HANDLE g_currentPackageLock = INVALID_HANDLE_VALUE;
HANDLE g_singleInstanceMutex = nullptr;
std::wstring g_pendingRestoreProjectPath;
std::wstring g_pendingRestorePackageRoot;
std::wstring g_startupProjectPath;
std::wstring g_pendingIncomingPathAfterRestoreDecision;
std::vector<std::wstring> g_forwardedProjectPaths;
std::wstring g_lastSessionJson;
std::vector<std::wstring> g_recentProjects;
bool g_canvasReady = false;
bool g_initialStateSent = false;
bool g_restoreDecisionPending = false;
bool g_documentDirty = false;
bool g_closeAfterSave = false;
bool g_closePromptOpen = false;
bool g_overwritePromptOpen = false;
bool g_legacyMigrationPromptOpen = false;
bool g_projectSaveInProgress = false;
bool g_forceClose = false;
int g_closeWatchdogRetries = 0;  // 关闭看门狗已重试次数：给忙碌的渲染进程第二次机会。
bool g_nativeDialogOpen = false;
std::wstring g_pendingOverwriteSaveMessage;
std::wstring g_pendingOverwriteDestination;
std::wstring g_confirmedSaveDestination;
std::wstring g_pendingLegacyMigrationSaveMessage;
bool g_confirmLegacyMigration = false;
bool g_forceLegacySaveAs = false;
std::wstring g_cachedDragImageItemId;
std::wstring g_cachedDragImageToken;
std::wstring g_cachedDragImageDataUrl;
// 掌中界要在原生内容之上画东西时（模态对话框、浮层）必须整体藏起原生子窗口。
// 它们是 HWND，永远浮在 WebView2 之上，只做 EnableWindow(FALSE) 挡不住遮挡，
// 用户会看到对话框按钮被网页盖住、点不到（§25）。
bool g_overlayActive = false;
bool g_compositionInputDisabled = false;
bool g_toolbarHotZoneActive = false;
std::wstring g_webThemeMode = L"dark";
std::wstring g_browserUserAgentMode = L"default";  // ⑤ 网页 UA：default = WebView2 原生，chrome = 伪装成 Chrome
std::wstring g_windowAppearance = L"borderless";
// 导出位置（用户自定义过一次就记住；空 = 默认「图片\掌中界导出」）
std::wstring g_exportFolder;
std::wstring g_windowMaterial = L"mica";
bool g_dwmBackdropSupported = false;
bool g_dwmBackdropChecked = false;
std::wstring g_toolbarVisibility = L"auto";
std::wstring g_cardTitlebarVisibility = L"hover";
std::wstring g_appThemeMode = L"system";
int g_settingsVersion = 2;
bool g_fileTreeCollapsed = false;
std::wstring g_fileViewMode = L"details";
std::wstring g_fileIconMode = L"system";
std::vector<std::wstring> g_fileColumns{L"name", L"modified", L"type", L"size"};
std::vector<std::wstring> g_globalQuickActions{L"computer", L"web", L"note"};
struct GlobalFavoriteSetting {
  std::wstring id;
  std::wstring label;
  std::wstring source;
  std::wstring sourceKind;
  std::wstring image;
};
std::vector<GlobalFavoriteSetting> g_globalFavorites;
std::vector<std::wstring> g_globalFixedOrder{L"quick-computer", L"quick-web", L"quick-shelf"};
struct WebBookmarkSetting {
  std::wstring id;
  std::wstring name;
  std::wstring url;
};
std::vector<WebBookmarkSetting> g_webBookmarks;
std::unordered_map<std::wstring, std::unordered_map<std::wstring, int>> g_fileColumnWidths;
std::unordered_map<std::wstring, int> g_fileTreeWidths;
std::unordered_map<std::wstring, int> g_fileTreeColumnWidths;
int g_previewNameColumnWidth = 210;
bool g_mediaMuted = true;
double g_mediaPlaybackRate = 1.0;
bool g_everythingPromptDismissed = false;
bool g_explorerContextMenuEnabled = true;
int g_settingsWidth = 620;
int g_settingsHeight = 720;
std::unordered_map<std::wstring, std::wstring> g_shortcutBindings;
struct TileWindowCandidate {
  HWND window = nullptr;
  std::wstring title;
};
struct TiledWindowPlacement {
  HWND window = nullptr;
  RECT bounds{};
};
std::vector<TileWindowCandidate> g_tileWindowCandidates;
std::vector<TiledWindowPlacement> g_lastTiledWindowPlacements;

// ---- 自动剪贴历史（Win+V 式）：复制/截图自动进列表；内容只存路径引用，工程不膨胀 ----
struct ClipboardHistoryItem {
  std::wstring id;
  std::wstring kind;   // image | files | text
  std::wstring text;   // 展示用标签/正文
  std::wstring path;   // image：落盘截图路径
  std::vector<std::wstring> paths;  // files：只存路径引用
  unsigned long long width = 0;
  unsigned long long height = 0;
  unsigned long long at = 0;
  unsigned long long digest = 0;  // 图片内容摘要（FNV-1a）：两次 WM_CLIPBOARDUPDATE 不重复记录
};
std::vector<ClipboardHistoryItem> g_clipboardHistory;
bool g_clipboardHistoryAuto = true;
ULONGLONG g_clipboardSelfWriteAt = 0;
unsigned int g_clipboardHistorySerial = 0;
bool g_captureToCanvas = true;  // 截图后直接贴到画布

bool g_settingsNoticePending = false;
bool g_explorerContextMenuNoticePending = false;
bool g_appThemeDark = true;
// 材质层 v1（定义在 ApplyDwmWindowFrame 之前；这里先声明，供更早的调用点使用）
void ApplyWebViewBackground();
void SendWindowMaterialState();
bool g_browserEnvironmentStarting = false;
bool g_browserEnvironmentHasForceDark = false;
bool g_browserEnvironmentFallbackPending = false;
bool g_browserEnvironmentDegraded = false;
bool g_browserFallbackNoticePending = false;
bool g_browserProfileMigrationChecked = false;
bool g_browserProfileMigrationNoticePending = false;
std::wstring g_audibleSurfaceId;
// 当前处于系统画中画的那张卡（由注入脚本回报 enter/exit 设置）。
// 这里提前声明，是因为静音判定（SyncSurfaceGeometry / SyncWindowedSurfaceGeometry）要先问它：
// 画中画期间卡片会被主动隐藏（show=false），若按老逻辑就会把画中画的声音静掉。
std::wstring g_pipSurfaceId;
static bool IsPipSurface(const std::wstring& id) { return !id.empty() && id == g_pipSurfaceId; }
static ULONGLONG g_lastPipAudioLogAt = 0;
std::wstring g_hoveredSurfaceId;
std::unordered_map<std::wstring, std::filesystem::path> g_mediaFolders;
std::mutex g_mediaFoldersMutex;
struct ThumbnailCacheFile {
  std::filesystem::path path;
  uintmax_t bytes = 0;
  std::filesystem::file_time_type accessed{};
};
std::mutex g_thumbnailCacheMutex;
bool g_thumbnailCacheIndexed = false;
uintmax_t g_thumbnailCacheBytes = 0;
std::unordered_map<std::wstring, ThumbnailCacheFile> g_thumbnailCacheFiles;
struct ThumbnailMemoryCacheEntry {
  std::shared_ptr<const std::vector<unsigned char>> bytes;
  uint64_t lastUsed = 0;
};
constexpr size_t kThumbnailMemoryCacheMaximumEntries = 256;
constexpr size_t kThumbnailMemoryCacheMaximumBytes = 32 * 1024 * 1024;
std::mutex g_thumbnailMemoryCacheMutex;
size_t g_thumbnailMemoryCacheBytes = 0;
uint64_t g_thumbnailMemoryCacheClock = 0;
std::unordered_map<std::wstring, ThumbnailMemoryCacheEntry> g_thumbnailMemoryCache;
std::atomic<unsigned long> g_thumbnailPreheatGeneration{0};
constexpr size_t kThumbnailBreadcrumbCharacters = 32768;
HANDLE g_thumbnailBreadcrumbFile = INVALID_HANDLE_VALUE;
HANDLE g_thumbnailBreadcrumbMapping = nullptr;
wchar_t* g_thumbnailBreadcrumbView = nullptr;
std::mutex g_shellImageExtractionMutex;

// ── 桌宠画布桥：文件队列 + 结果表 ──
std::mutex g_canvasBridgeMutex;
std::unordered_map<std::wstring, std::wstring> g_canvasBridgeResults;
std::once_flag g_canvasBridgeOnce;
struct ThumbnailRouteResource {
  std::filesystem::path path;
  std::wstring cacheKey;
};
struct ThumbnailRoute {
  std::wstring surfaceId;
  std::unordered_set<std::wstring> displayedPaths;
  std::unordered_map<std::wstring, ThumbnailRouteResource> resources;
};
std::mutex g_thumbnailRoutesMutex;
std::unordered_map<std::wstring, ThumbnailRoute> g_thumbnailRoutes;
std::wstring g_shellPreviewMediaHost;
std::filesystem::path g_shellPreviewTempFolder;
ULONG g_shellNotifyId = 0;
IDropTarget* g_canvasDropTarget = nullptr;
HWND g_canvasDropWindow = nullptr;
HWND g_canvasPanCaptureWindow = nullptr;
std::wstring g_canvasPanSurfaceId;

std::atomic<int> g_filePreviewWorkers{0};
std::mutex g_filePreviewMutex;
std::unordered_map<std::wstring, unsigned long> g_filePreviewGenerations;

SRWLOCK g_lastWebViewMessageLock = SRWLOCK_INIT;
wchar_t g_lastWebViewMessage[8192]{};

void RecordLastWebViewMessage(const std::wstring& message) {
  AcquireSRWLockExclusive(&g_lastWebViewMessageLock);
  wcsncpy_s(g_lastWebViewMessage, message.c_str(), _TRUNCATE);
  ReleaseSRWLockExclusive(&g_lastWebViewMessageLock);
}

void WriteCrashLogLine(HANDLE file, const wchar_t* text) {
  if (file == INVALID_HANDLE_VALUE || !text) return;
  DWORD written = 0;
  WriteFile(file, text, static_cast<DWORD>(wcslen(text) * sizeof(wchar_t)), &written, nullptr);
}

void WriteCrashLog(const wchar_t* reason, EXCEPTION_POINTERS* exception = nullptr,
                   const wchar_t* detail = nullptr) {
  wchar_t localAppData[32768]{};
  if (!GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, static_cast<DWORD>(std::size(localAppData)))) {
    GetTempPathW(static_cast<DWORD>(std::size(localAppData)), localAppData);
  }
  wchar_t folder[32768]{};
  swprintf_s(folder, L"%s\\掌中界", localAppData);
  CreateDirectoryW(folder, nullptr);

  SYSTEMTIME now{};
  GetLocalTime(&now);
  wchar_t path[32768]{};
  swprintf_s(path, L"%s\\crash-%04u%02u%02u-%02u%02u%02u-%lu-%llu.log", folder,
    now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond,
    GetCurrentProcessId(), static_cast<unsigned long long>(GetTickCount64()));
  HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;

  const WORD bom = 0xfeff;
  DWORD written = 0;
  WriteFile(file, &bom, sizeof(bom), &written, nullptr);
  wchar_t line[1024]{};
  swprintf_s(line, L"掌中界 native crash report\r\ntime=%04u-%02u-%02u %02u:%02u:%02u\r\n"
                   L"pid=%lu tid=%lu\r\nreason=%s\r\n",
    now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond,
    GetCurrentProcessId(), GetCurrentThreadId(), reason ? reason : L"unknown");
  WriteCrashLogLine(file, line);
  if (detail && *detail) {
    WriteCrashLogLine(file, L"detail=");
    WriteCrashLogLine(file, detail);
    WriteCrashLogLine(file, L"\r\n");
  }
  if (exception && exception->ExceptionRecord) {
    swprintf_s(line, L"exception_code=0x%08lx\r\nexception_address=%p\r\n",
      exception->ExceptionRecord->ExceptionCode, exception->ExceptionRecord->ExceptionAddress);
    WriteCrashLogLine(file, line);
  }

  void* frames[48]{};
  const USHORT frameCount = CaptureStackBackTrace(0, static_cast<DWORD>(std::size(frames)), frames, nullptr);
  WriteCrashLogLine(file, L"stack:\r\n");
  for (USHORT index = 0; index < frameCount; ++index) {
    // 记模块名 + RVA（地址带 ASLR 无法直接对 PDB；RVA 可以事后解析）。
    HMODULE frameModule = nullptr;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(frames[index]), &frameModule) && frameModule) {
      wchar_t frameModulePath[MAX_PATH]{};
      GetModuleFileNameW(frameModule, frameModulePath, MAX_PATH);
      const wchar_t* frameModuleName = wcsrchr(frameModulePath, L'\\');
      frameModuleName = frameModuleName ? frameModuleName + 1 : frameModulePath;
      const unsigned long long frameRva = reinterpret_cast<unsigned long long>(frames[index]) - reinterpret_cast<unsigned long long>(frameModule);
      swprintf_s(line, L"  #%02u %p  %s+0x%llX\r\n", index, frames[index], frameModuleName, frameRva);
    } else {
      swprintf_s(line, L"  #%02u %p  (unknown module)\r\n", index, frames[index]);
    }
    WriteCrashLogLine(file, line);
  }

  wchar_t lastMessage[std::size(g_lastWebViewMessage)]{};
  if (TryAcquireSRWLockShared(&g_lastWebViewMessageLock)) {
    wcsncpy_s(lastMessage, g_lastWebViewMessage, _TRUNCATE);
    ReleaseSRWLockShared(&g_lastWebViewMessageLock);
  } else {
    wcsncpy_s(lastMessage, L"<unavailable: message lock held>", _TRUNCATE);
  }
  WriteCrashLogLine(file, L"last_webview_message:\r\n");
  WriteCrashLogLine(file, lastMessage[0] ? lastMessage : L"<none>");
  WriteCrashLogLine(file, L"\r\n");
  FlushFileBuffers(file);
  CloseHandle(file);
}

// 轻量生命周期日志：关闭流程、强制退出、Web 层 JS 错误都记到这里。
// 崩溃日志只覆盖原生异常；这条通道专门补上「应用为什么安静地退出/卡死」的黑盒缺口。
void WriteLifecycleLog(const wchar_t* text);  // 定义在下方

// 心跳：每分钟看一眼内存与句柄数量，只有明显变化才记一行（正常游玩时日志几乎不涨）。
unsigned long long g_lastHeartbeatBytes = 0;
unsigned long g_lastHeartbeatHandles = 0;

void HeartbeatTick() {
  if (!g_mainWindow) return;
  PROCESS_MEMORY_COUNTERS counters{};
  unsigned long long bytes = 0;
  unsigned long handles = 0;
  if (GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters))) {
    bytes = static_cast<unsigned long long>(counters.WorkingSetSize);
  }
  DWORD handleCount = 0;
  if (GetProcessHandleCount(GetCurrentProcess(), &handleCount)) handles = handleCount;
  const bool bigMemoryJump = g_lastHeartbeatBytes == 0 ||
    (bytes > g_lastHeartbeatBytes ? bytes - g_lastHeartbeatBytes > g_lastHeartbeatBytes / 8 : g_lastHeartbeatBytes - bytes > g_lastHeartbeatBytes / 4);
  const bool manyHandleJump = g_lastHeartbeatHandles == 0 ||
    (handles > g_lastHeartbeatHandles ? handles - g_lastHeartbeatHandles > 400 : false);
  if (!bigMemoryJump && !manyHandleJump) return;
  g_lastHeartbeatBytes = bytes;
  g_lastHeartbeatHandles = handles;
  wchar_t line[256]{};
  swprintf_s(line, L"hb: mem=%.1fMB handles=%lu", static_cast<double>(bytes) / (1024.0 * 1024.0), handles);
  WriteLifecycleLog(line);
}

void WriteLifecycleLog(const wchar_t* text) {
  if (!text || !*text) return;
  wchar_t localAppData[32768]{};
  if (!GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, static_cast<DWORD>(std::size(localAppData)))) return;
  wchar_t folder[32768]{};
  swprintf_s(folder, L"%s\\掌中界", localAppData);
  CreateDirectoryW(folder, nullptr);
  wchar_t path[32768]{};
  swprintf_s(path, L"%s\\lifecycle.log", folder);
  HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;
  LARGE_INTEGER size{};
  GetFileSizeEx(file, &size);
  DWORD written = 0;
  if (size.QuadPart == 0) {
    const WORD bom = 0xfeff;
    WriteFile(file, &bom, sizeof(bom), &written, nullptr);
  }
  SYSTEMTIME now{};
  GetLocalTime(&now);
  wchar_t head[160]{};
  swprintf_s(head, L"[%04u-%02u-%02u %02u:%02u:%02u] ", now.wYear, now.wMonth, now.wDay,
    now.wHour, now.wMinute, now.wSecond);
  WriteFile(file, head, static_cast<DWORD>(wcslen(head) * sizeof(wchar_t)), &written, nullptr);
  WriteFile(file, text, static_cast<DWORD>(wcslen(text) * sizeof(wchar_t)), &written, nullptr);
  WriteFile(file, L"\r\n", 4, &written, nullptr);
  FlushFileBuffers(file);
  CloseHandle(file);
}

LONG WINAPI CaptureUnhandledException(EXCEPTION_POINTERS* exception) {
  WriteCrashLog(L"unhandled native exception", exception);
  return EXCEPTION_EXECUTE_HANDLER;
}

void CapturePureCall() {
  WriteCrashLog(L"pure virtual function call");
  TerminateProcess(GetCurrentProcess(), 3);
}

void CaptureTerminate() {
  WriteCrashLog(L"std::terminate");
  TerminateProcess(GetCurrentProcess(), 3);
}

void InstallCrashCapture() {
  SetUnhandledExceptionFilter(CaptureUnhandledException);
  _set_purecall_handler(CapturePureCall);
  std::set_terminate(CaptureTerminate);
}

void ClearThumbnailBreadcrumbLocked() {
  if (!g_thumbnailBreadcrumbView) return;
  g_thumbnailBreadcrumbView[0] = L'\0';
}

void InitializeThumbnailBreadcrumb() {
  const std::filesystem::path path = std::filesystem::path(g_dataFolder) / L"thumb-breadcrumb.txt";
  g_thumbnailBreadcrumbFile = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (g_thumbnailBreadcrumbFile == INVALID_HANDLE_VALUE) return;
  LARGE_INTEGER length{};
  length.QuadPart = static_cast<LONGLONG>(kThumbnailBreadcrumbCharacters * sizeof(wchar_t));
  if (!SetFilePointerEx(g_thumbnailBreadcrumbFile, length, nullptr, FILE_BEGIN) ||
      !SetEndOfFile(g_thumbnailBreadcrumbFile)) return;
  g_thumbnailBreadcrumbMapping = CreateFileMappingW(g_thumbnailBreadcrumbFile, nullptr, PAGE_READWRITE,
    0, static_cast<DWORD>(length.QuadPart), nullptr);
  if (!g_thumbnailBreadcrumbMapping) return;
  g_thumbnailBreadcrumbView = static_cast<wchar_t*>(MapViewOfFile(g_thumbnailBreadcrumbMapping,
    FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, static_cast<SIZE_T>(length.QuadPart)));
  if (!g_thumbnailBreadcrumbView) return;
  g_thumbnailBreadcrumbView[kThumbnailBreadcrumbCharacters - 1] = L'\0';
  const std::wstring interruptedPath(g_thumbnailBreadcrumbView);
  if (!interruptedPath.empty()) {
    WriteCrashLog(L"thumbnail extraction interrupted", nullptr, interruptedPath.c_str());
  }
  ClearThumbnailBreadcrumbLocked();
}

void SetThumbnailBreadcrumb(const std::wstring& path) {
  if (path.empty()) return;
  if (!g_thumbnailBreadcrumbView) return;
  wcsncpy_s(g_thumbnailBreadcrumbView, kThumbnailBreadcrumbCharacters, path.c_str(), _TRUNCATE);
}

void ClearThumbnailBreadcrumb(const std::wstring& path) {
  if (path.empty()) return;
  if (g_thumbnailBreadcrumbView && path == g_thumbnailBreadcrumbView) ClearThumbnailBreadcrumbLocked();
}

HRESULT ExtractShellItemImage(IShellItemImageFactory* factory, const std::wstring& breadcrumbPath,
                              const SIZE& size, SIIGBF flags, HBITMAP* bitmap) {
  if (!factory || !bitmap) return E_INVALIDARG;
  std::lock_guard<std::mutex> lock(g_shellImageExtractionMutex);
  SetThumbnailBreadcrumb(breadcrumbPath);
  struct BreadcrumbScope {
    const std::wstring& path;
    ~BreadcrumbScope() { ClearThumbnailBreadcrumb(path); }
  } breadcrumbScope{breadcrumbPath};
  // 第三方 Shell 图标/缩略图处理器可能直接抛 C++ 异常。本机实测：目录树的图标请求
  // → GetImage → handler 抛 0xe06d7363 → 异常穿过我们所有栈帧 → 整树消失（crash-*.log
  // 里 ShellItemImageDataUrl → MakeShellTreeNode → SendExplorerTree 那条链）。
  // 这里必须兜住：宁可这次没有图标，也不能让应用崩掉。
  HRESULT result = E_FAIL;
  try {
    result = factory->GetImage(size, flags, bitmap);
  } catch (...) {
    WriteLifecycleLog(L"shell item image: handler threw, swallowed");
    if (bitmap && *bitmap) {
      DeleteObject(*bitmap);
      *bitmap = nullptr;
    }
    return E_FAIL;
  }
  return result;
}

int VerifyCrashCapture() {
  __try {
    RaiseException(0xe0005a5a, 0, 0, nullptr);
  } __except (CaptureUnhandledException(GetExceptionInformation())) {
    return 197;
  }
  return 0;
}

void AttachProcessFailedCapture(ICoreWebView2* webView, std::wstring scope) {
  if (!webView) return;
  EventRegistrationToken token{};
  webView->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
    [scope = std::move(scope)](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
      COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
      if (args) args->get_ProcessFailedKind(&kind);
      wchar_t detail[512]{};
      swprintf_s(detail, L"scope=%s; kind=%d", scope.c_str(), static_cast<int>(kind));
      WriteCrashLog(L"WebView2 ProcessFailed", nullptr, detail);
      return S_OK;
    }).Get(), &token);
}

void ApplyWindowAppearance();
void SendWindowState(bool force = false);
void UpdateToolbarHotZone(POINT screenPoint, bool forceLeave = false);
std::wstring MediaHostForSurface(const std::wstring& surfaceId);
std::wstring UrlEncode(const std::wstring& value);
HRESULT HandleMediaWebResourceRequest(ICoreWebView2WebResourceRequestedEventArgs* args,
                                       ICoreWebView2Environment* environment);
HRESULT HandleThumbnailWebResourceRequest(ICoreWebView2WebResourceRequestedEventArgs* args,
                                           ICoreWebView2Environment* environment);
std::wstring ThumbnailHostForSurface(const std::wstring& surfaceId);

struct PendingNativeDrag {
  bool armed = false;
  bool image = false;
  bool imageRequested = false;
  POINT start{};
  std::vector<std::wstring> paths;
  std::wstring itemId;
  std::wstring imageToken;
  std::wstring dataUrl;
};
PendingNativeDrag g_pendingNativeDrag;

struct BrowserBookmark {
  std::wstring name;
  std::wstring url;
  std::wstring folder;  // 所在文件夹的完整路径，顶层为空
};

struct ShellEntry {
  std::wstring name;
  std::wstring parsingName;
  std::wstring typeText;
  std::wstring modifiedText;
  ULONGLONG modifiedStamp = 0;
  std::wstring image;
  bool imageIsThumbnail = false;
  ULONGLONG size = 0;
  bool folder = false;
  bool hidden = false;
  bool shortcut = false;
  std::wstring parentPath;
};

// Shell containers answer the navigation question.  They include physical
// directories and namespace folders such as ZIP archives.
bool IsShellContainer(IShellItem* item) {
  if (!item) return false;
  SFGAOF attributes = SFGAO_FOLDER;
  return SUCCEEDED(item->GetAttributes(attributes, &attributes)) &&
    (attributes & SFGAO_FOLDER) != 0;
}

// File-system directories answer the storage question.  A ZIP is a regular
// file here even though Shell exposes it as a navigable container.
bool IsFileSystemDirectory(DWORD attributes) {
  return attributes != INVALID_FILE_ATTRIBUTES &&
    (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool IsFileSystemDirectory(const std::filesystem::path& path) {
  return IsFileSystemDirectory(GetFileAttributesW(path.c_str()));
}

bool HasZipExtension(const std::wstring& parsingName) {
  return _wcsicmp(std::filesystem::path(parsingName).extension().c_str(), L".zip") == 0;
}

// ZIP is the only archive namespace that Windows Explorer exposes reliably on
// every supported system.  Keep rar/7z as ordinary files even when a third
// party shell extension happens to advertise them as folders.
bool IsSupportedZipContainer(const std::filesystem::path& path) {
  if (IsFileSystemDirectory(path) || _wcsicmp(path.extension().c_str(), L".zip") != 0) return false;
  ComPtr<IShellItem> item;
  return SUCCEEDED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item))) &&
    item && IsShellContainer(item.Get());
}

// ---------- 压缩包「卡内浏览」：7-Zip 解压镜像（rar / 7z / tar / gz …） ----------
// Shell 只把 zip 当成可浏览的命名空间文件夹；rar、7z 之类必须先解压。做法是把包
// 解开到数据目录下的「只读镜像」，再让同一张文件卡浏览真实文件——缩略图、预览、
// 双击打开、排序全部沿用既有外壳管线，写操作由 RejectArchiveWrite 统一拦截。
constexpr wchar_t kArchiveMirrorFolderName[] = L"包内浏览";
constexpr wchar_t kArchiveMirrorMarkerName[] = L".zzj-extracted";
constexpr ULONGLONG kArchiveMirrorMaximumAge100ns = 7ULL * 24 * 60 * 60 * 10000000ULL;
constexpr ULONGLONG kArchiveMirrorConfirmBytes = 1500ULL * 1024ULL * 1024ULL;

const wchar_t* const kSevenZipArchiveExtensions[] = {
  L".rar", L".7z", L".tar", L".gz", L".tgz", L".bz2", L".tbz", L".xz", L".txz",
  L".zst", L".cab", L".iso", L".lzh", L".arj", L".z", L".lzma"
};

std::filesystem::path ArchiveMirrorRoot() {
  if (g_dataFolder.empty()) return {};
  return std::filesystem::path(g_dataFolder) / kArchiveMirrorFolderName;
}

std::filesystem::path SevenZipExecutable() {
  const wchar_t* candidates[] = {
    L"C:\\Program Files\\7-Zip\\7z.exe",
    L"C:\\Program Files (x86)\\7-Zip\\7z.exe",
  };
  for (const wchar_t* candidate : candidates) {
    if (GetFileAttributesW(candidate) != INVALID_FILE_ATTRIBUTES) return std::filesystem::path(candidate);
  }
  return {};
}

// Shell 能自己当文件夹逛的（zip / 目录）不走镜像；其余压缩包交给 7-Zip。
bool IsSevenZipArchive(const std::filesystem::path& path) {
  if (path.empty() || IsFileSystemDirectory(path) || IsSupportedZipContainer(path)) return false;
  const std::wstring extension = path.extension().wstring();
  if (extension.empty()) return false;
  for (const wchar_t* candidate : kSevenZipArchiveExtensions) {
    if (_wcsicmp(extension.c_str(), candidate) == 0) return true;
  }
  return false;
}

// 镜像目录名带「路径+大小+修改时间」指纹：包被换掉时自动用新目录，不会串味。
std::wstring ArchiveMirrorKey(const std::filesystem::path& archive) {
  std::wstring seed = archive.wstring();
  std::transform(seed.begin(), seed.end(), seed.begin(), ::towlower);
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (GetFileAttributesExW(archive.c_str(), GetFileExInfoStandard, &attributes)) {
    ULARGE_INTEGER size{};
    ULARGE_INTEGER stamp{};
    size.LowPart = attributes.nFileSizeLow;
    size.HighPart = attributes.nFileSizeHigh;
    stamp.LowPart = attributes.ftLastWriteTime.dwLowDateTime;
    stamp.HighPart = attributes.ftLastWriteTime.dwHighDateTime;
    seed += L'|' + std::to_wstring(size.QuadPart) + L'|' + std::to_wstring(stamp.QuadPart);
  }
  uint64_t hash = 1469598103934665603ULL;
  for (const wchar_t ch : seed) {
    hash ^= static_cast<uint16_t>(ch);
    hash *= 1099511628211ULL;
  }
  wchar_t encoded[17]{};
  swprintf_s(encoded, L"%08llx", static_cast<unsigned long long>(hash & 0xFFFFFFFFULL));
  return encoded;
}

std::wstring ArchiveMirrorFolderLabel(const std::filesystem::path& archive) {
  std::wstring label = archive.stem().wstring();
  for (wchar_t& ch : label) {
    if (ch == L'<' || ch == L'>' || ch == L':' || ch == L'"' || ch == L'/' || ch == L'\\' ||
        ch == L'|' || ch == L'?' || ch == L'*' || ch < 32) ch = L'_';
  }
  if (label.empty()) label = L"archive";
  if (label.size() > 48) label.resize(48);
  return label;
}

std::filesystem::path ArchiveMirrorContentFolder(const std::filesystem::path& archive) {
  const std::filesystem::path root = ArchiveMirrorRoot();
  if (root.empty() || archive.empty()) return {};
  return root / (ArchiveMirrorFolderLabel(archive) + L"-" + ArchiveMirrorKey(archive));
}

std::filesystem::path ArchiveMirrorMarkerPath(const std::filesystem::path& folder) {
  return folder / kArchiveMirrorMarkerName;
}

bool ArchiveMirrorReady(const std::filesystem::path& folder) {
  return !folder.empty() &&
    GetFileAttributesW(ArchiveMirrorMarkerPath(folder).c_str()) != INVALID_FILE_ATTRIBUTES;
}

bool PathStartsWithFolder(const std::wstring& candidate, const std::wstring& folder) {
  if (candidate.empty() || folder.empty()) return false;
  std::wstring left = candidate;
  std::wstring right = folder;
  for (std::wstring* value : { &left, &right }) {
    std::replace(value->begin(), value->end(), L'/', L'\\');
    while (value->size() > 1 && value->back() == L'\\') value->pop_back();
    std::transform(value->begin(), value->end(), value->begin(), ::towlower);
  }
  if (left.size() < right.size()) return false;
  if (left.compare(0, right.size(), right) != 0) return false;
  return left.size() == right.size() || left[right.size()] == L'\\';
}

std::wstring FormatArchiveMirrorSize(ULONGLONG bytes) {
  wchar_t buffer[64]{};
  if (bytes >= 1024ULL * 1024ULL * 1024ULL) {
    swprintf_s(buffer, L"%.1f GB", static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0));
  } else if (bytes >= 1024ULL * 1024ULL) {
    swprintf_s(buffer, L"%.0f MB", static_cast<double>(bytes) / (1024.0 * 1024.0));
  } else {
    swprintf_s(buffer, L"%.0f KB", static_cast<double>(bytes) / 1024.0);
  }
  return buffer;
}

// 只清「老镜像」：marker 时间超过 7 天。镜像本身是缓存，删掉下次再解一次即可。
void CleanupArchiveMirrorCache() {
  const std::filesystem::path root = ArchiveMirrorRoot();
  if (root.empty()) return;
  std::error_code error;
  std::filesystem::create_directories(root, error);
  error.clear();
  FILETIME nowFileTime{};
  GetSystemTimeAsFileTime(&nowFileTime);
  ULARGE_INTEGER now{};
  now.LowPart = nowFileTime.dwLowDateTime;
  now.HighPart = nowFileTime.dwHighDateTime;
  size_t removed = 0;
  for (std::filesystem::directory_iterator iterator(root, error), end; !error && iterator != end; iterator.increment(error)) {
    if (!iterator->is_directory(error)) { error.clear(); continue; }
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (!GetFileAttributesExW(ArchiveMirrorMarkerPath(iterator->path()).c_str(), GetFileExInfoStandard, &attributes)) continue;
    ULARGE_INTEGER stamp{};
    stamp.LowPart = attributes.ftLastWriteTime.dwLowDateTime;
    stamp.HighPart = attributes.ftLastWriteTime.dwHighDateTime;
    const ULONGLONG age = now.QuadPart > stamp.QuadPart ? now.QuadPart - stamp.QuadPart : 0;
    if (age < kArchiveMirrorMaximumAge100ns) continue;
    std::error_code removeError;
    std::filesystem::remove_all(iterator->path(), removeError);
    if (!removeError) ++removed;
  }
  if (removed) {
    wchar_t line[128]{};
    swprintf_s(line, L"archive mirror cleanup: removed %llu stale folders",
      static_cast<unsigned long long>(removed));
    WriteLifecycleLog(line);
  }
}

enum class CanvasProjectKind { None, Directory, Archive };

struct CanvasPathClassification {
  std::filesystem::path originalPath;
  std::filesystem::path projectPath;
  CanvasProjectKind projectKind = CanvasProjectKind::None;
  bool folder = false;
};

bool IsProjectManifest(const std::filesystem::path& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
    (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 &&
    _wcsicmp(path.filename().c_str(), L"project.json") == 0;
}

bool IsProjectDirectory(const std::filesystem::path& path) {
  return IsFileSystemDirectory(path) &&
    _wcsicmp(path.extension().c_str(), L".zzj") == 0 &&
    IsProjectManifest(path / L"project.json");
}

CanvasPathClassification ClassifyCanvasPath(const std::filesystem::path& path) {
  CanvasPathClassification result;
  result.originalPath = path;
  result.folder = IsFileSystemDirectory(path) || IsSupportedZipContainer(path);
  if (IsProjectDirectory(path)) {
    result.projectKind = CanvasProjectKind::Directory;
    result.projectPath = path;
    return result;
  }
  if (IsProjectManifest(path) && IsProjectDirectory(path.parent_path())) {
    result.projectKind = CanvasProjectKind::Directory;
    result.projectPath = path.parent_path();
    return result;
  }
  if (!IsFileSystemDirectory(path) &&
      (_wcsicmp(path.extension().c_str(), L".zzj") == 0 ||
       _wcsicmp(path.extension().c_str(), L".zzjx") == 0)) {
    result.projectKind = CanvasProjectKind::Archive;
    result.projectPath = path;
  }
  return result;
}

struct NativeSurface {
  std::wstring id;
  std::wstring leaseId;
  std::wstring kind;
  std::wstring source;
  RECT bounds{};
  RECT clip{};
  int order = 0;
  bool snapshotMode = false;
  bool appliedMuted = false;
  double volume = -1.0;   // 网页卡音量（0~1）；-1 = 未设置过（不动站点自己的默认音量）
  ULONGLONG snapshotAt = 0;
  unsigned long long snapshotRevision = 0;
  ULONGLONG closingAt = 0;
  int selectionCount = -1;
  std::wstring location;
  std::wstring enumeratedLocation;
  unsigned long explorerGeneration = 0;
  std::atomic<unsigned long> explorerMetadataGeneration{0};
  std::atomic<int> explorerMetadataWorkers{0};
  std::atomic<unsigned long> explorerFolderSizeGeneration{0};
  std::atomic<unsigned long> explorerSearchGeneration{0};
  bool explorerContentDirty = true;
  // 上次真正重枚举列表的时间（拷贝期间用它做节流：枚举要读盘，别和系统拷贝抢 IO）
  ULONGLONG explorerRefreshAt = 0;
  std::wstring mirrorArchive;
  std::wstring mirrorRoot;
  std::wstring pendingMirrorTarget;
  ULONGLONG mirrorRefreshAt = 0;
  bool copyWatchActive = false;
  ULONGLONG copyWatchDeadline = 0;
  size_t copyWatchSignature = 0;
  int copyWatchStableTicks = 0;
  ULONGLONG browseRetryAt = 0;
  int browseRetryAttempt = 0;
  bool semanticOnly = false;
  bool mediaBacked = false;
  int viewMode = 0;
  bool sortDescending = false;
  bool hasClip = false;
  double scale = 1.0;
  double appliedZoom = 0.0;
  bool visible = false;
  bool creating = false;
  HWND host = nullptr;
  ComPtr<IExplorerBrowser> explorer;
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2CompositionController> compositionController;
  ComPtr<IDCompositionVisual> compositionVisual;
  ComPtr<IDCompositionRectangleClip> compositionClip;
  ComPtr<ICoreWebView2> webView;
};

bool ReadUtf8File(const std::filesystem::path& path, std::wstring& value);

// 解压镜像位置同步：目标不在镜像里就立刻解除「包内只读副本」标记（含后退到别的
// 目录），在镜像里则记住本次镜像的根——写操作拦截和卡片标注都依赖它。
void SyncArchiveMirrorLocation(const std::shared_ptr<NativeSurface>& surface, const std::wstring& location) {
  if (!surface) return;
  const std::filesystem::path root = ArchiveMirrorRoot();
  if (root.empty() || !PathStartsWithFolder(location, root.wstring())) {
    surface->mirrorRoot.clear();
    surface->mirrorArchive.clear();
    return;
  }
  const std::wstring rootText = root.wstring();
  std::wstring tail = location;
  std::replace(tail.begin(), tail.end(), L'/', L'\\');
  size_t cursor = rootText.size();
  while (cursor < tail.size() && tail[cursor] == L'\\') ++cursor;
  const size_t separator = tail.find(L'\\', cursor);
  const std::wstring segment = tail.substr(cursor, separator == std::wstring::npos ? std::wstring::npos : separator - cursor);
  surface->mirrorRoot = segment.empty() ? rootText : (rootText + L"\\" + segment);
  if (surface->mirrorArchive.empty() && !segment.empty()) {
    // 重启后丢失的标注从 marker 恢复（marker 里记着原始压缩包路径）。
    std::wstring recorded;
    if (ReadUtf8File(ArchiveMirrorMarkerPath(std::filesystem::path(surface->mirrorRoot)), recorded)) {
      while (!recorded.empty() && (recorded.back() == static_cast<wchar_t>(13) || recorded.back() == static_cast<wchar_t>(10))) recorded.pop_back();
      if (!recorded.empty()) surface->mirrorArchive = recorded;
    }
  }
}

bool IsArchiveMirrorLocation(const std::shared_ptr<NativeSurface>& surface) {
  return surface && !surface->mirrorRoot.empty() &&
    PathStartsWithFolder(surface->source, surface->mirrorRoot);
}

#pragma pack(push, 1)
struct EverythingIpcQueryW {
  DWORD replyHwnd;
  DWORD replyCopyDataMessage;
  DWORD searchFlags;
  DWORD offset;
  DWORD maxResults;
  WCHAR searchString[1];
};
struct EverythingIpcItemW {
  DWORD flags;
  DWORD filenameOffset;
  DWORD pathOffset;
};
struct EverythingIpcListW {
  DWORD totalFolders;
  DWORD totalFiles;
  DWORD totalItems;
  DWORD numberOfFolders;
  DWORD numberOfFiles;
  DWORD numberOfItems;
  DWORD offset;
  EverythingIpcItemW items[1];
};
#pragma pack(pop)

constexpr wchar_t kEverythingWindowClass[] = L"EVERYTHING_TASKBAR_NOTIFICATION";
constexpr wchar_t kEverythingReplyClass[] = L"ZhangZhongJie.EverythingReply";
constexpr ULONG_PTR kEverythingCopyDataQueryW = 2;
constexpr ULONG_PTR kEverythingReplyMessage = 0x5a5a1021;
constexpr DWORD kEverythingItemFolder = 0x00000001;

struct EverythingReplyState {
  bool received = false;
  std::vector<unsigned char> bytes;
};

void ReportExplorerState(const std::shared_ptr<NativeSurface>& surface, bool force);
std::wstring PromptProjectOpenPath(bool archive, bool legacyDirectory = false);
std::wstring SafeProjectName(std::wstring name);
struct ProjectSavePathResult {
  std::wstring path;
  bool cancelled = false;
  std::wstring error;
};
ProjectSavePathResult PromptProjectSavePath(const std::wstring& title, bool archive);
void HandleProjectSave(const std::wstring& message);
void SendTemplateList();
void HandleTemplateSave(const std::wstring& message);
void HandleTemplateApply(const std::wstring& message);
void HandleTemplateDelete(const std::wstring& message);
void HandleTemplateSetDefault(const std::wstring& message);
void HandleTemplateSetAuto(const std::wstring& message);
void HandleTemplateRename(const std::wstring& message);
void HandleProjectOpen(const std::wstring& path, bool archive);
bool SamePath(const std::filesystem::path& left, const std::filesystem::path& right);
bool ExtractProjectArchive(const std::filesystem::path& archive, std::filesystem::path& projectRoot,
                           std::wstring& errorText);
void SendProjectOperationResult(const wchar_t* type, bool success, bool cancelled,
                                const std::wstring& mode, const std::wstring& path,
                                const std::wstring& error = {}, const std::wstring& requestId = {},
                                const std::wstring& packageRoot = {},
                                const std::wstring& migratedFrom = {});

std::vector<std::shared_ptr<NativeSurface>> g_surfaces;
unsigned long long g_surfaceTopologyRevision = 0;

struct FolderSizeCacheEntry {
  ULONGLONG modifiedStamp = 0;
  ULONGLONG size = 0;
};
std::mutex g_folderSizeCacheMutex;
std::unordered_map<std::wstring, FolderSizeCacheEntry> g_folderSizeCache;
std::atomic<unsigned long> g_shellPreviewGeneration{0};
std::atomic<unsigned long> g_shellPreviewThumbnailGeneration{0};
std::atomic<unsigned long> g_shellPreviewLocationGeneration{0};

struct HoverOwnerCache {
  HWND messageWindow = nullptr;
  unsigned long long topologyRevision = 0;
  std::shared_ptr<NativeSurface> owner;
  bool insideCompositionHost = false;
  bool valid = false;
};
HoverOwnerCache g_hoverOwnerCache;

struct TopEdgeMetrics {
  RECT windowBounds{};
  int top = 0;
  int resizeBottom = 0;
  int toolbarBottom = 0;
  int frameX = 0;
  int frameY = 0;
  int cornerSize = 0;
  bool borderless = false;
  bool maximized = false;
  bool valid = false;
};
TopEdgeMetrics g_topEdgeMetrics;
LRESULT g_windowResizeHint = HTCLIENT;
bool g_windowStateSent = false;
bool g_lastWindowStateMaximized = false;
bool g_mainWindowMinimized = false;
bool g_dwmFrameApplied = false;
bool g_lastDwmFrameBorderless = false;
bool g_lastDwmFrameMaximized = false;

// DevTools-controlled performance probe. These counters only observe the
// existing geometry path; they do not alter scheduling or rendering behavior.
struct SurfacePerfCounters {
  ULONGLONG startedAt = 0;
  unsigned long long upserts = 0;
  unsigned long long setWindowPosCalls = 0;
  unsigned long long compositionRegionUpdates = 0;
};
SurfacePerfCounters g_surfacePerfCounters;

enum class PreferredAppMode { Default, AllowDark, ForceDark, ForceLight, Max };
using SetPreferredAppModeFn = PreferredAppMode(WINAPI*)(PreferredAppMode);
using AllowDarkModeForWindowFn = BOOL(WINAPI*)(HWND, BOOL);
using FlushMenuThemesFn = void(WINAPI*)();
SetPreferredAppModeFn g_setPreferredAppMode = nullptr;
AllowDarkModeForWindowFn g_allowDarkModeForWindow = nullptr;
FlushMenuThemesFn g_flushMenuThemes = nullptr;

bool SystemUsesDarkMode() {
  DWORD lightTheme = 1;
  DWORD size = sizeof(lightTheme);
  RegGetValueW(HKEY_CURRENT_USER,
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
    L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &lightTheme, &size);
  return lightTheme == 0;
}

void ApplyMenuTheme();

void EnableProcessThemeSupport() {
  HMODULE theme = LoadLibraryW(L"uxtheme.dll");
  if (!theme) return;
  g_setPreferredAppMode = reinterpret_cast<SetPreferredAppModeFn>(GetProcAddress(theme, MAKEINTRESOURCEA(135)));
  g_allowDarkModeForWindow = reinterpret_cast<AllowDarkModeForWindowFn>(GetProcAddress(theme, MAKEINTRESOURCEA(133)));
  g_flushMenuThemes = reinterpret_cast<FlushMenuThemesFn>(GetProcAddress(theme, MAKEINTRESOURCEA(136)));
  ApplyMenuTheme();
}

// Shell 的右键菜单是经典 Win32 弹出菜单，默认跟系统菜单配色走，在深色宿主里
// 就是一片白。AllowDark 只对主动 opt-in 的窗口生效，弹出菜单要 ForceDark 才
// 会变深，改完还得 FlushMenuThemes 让已缓存的菜单主题失效。系统是浅色时回到
// Default，保持「内容区跟随 Windows 主题」的规则不被破坏。
void ApplyMenuTheme() {
  if (g_setPreferredAppMode) g_setPreferredAppMode(SystemUsesDarkMode() ? PreferredAppMode::ForceDark : PreferredAppMode::Default);
  if (g_flushMenuThemes) g_flushMenuThemes();
}

std::wstring ModuleFolder() {
  wchar_t path[MAX_PATH]{};
  GetModuleFileNameW(nullptr, path, static_cast<DWORD>(std::size(path)));
  return std::filesystem::path(path).parent_path().wstring();
}

std::wstring ModulePath() {
  std::wstring path(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!length || length >= path.size()) return {};
  path.resize(length);
  return path;
}

bool WriteRegistryString(const wchar_t* keyPath, const wchar_t* valueName, const std::wstring& value) {
  HKEY key = nullptr;
  const LONG opened = RegCreateKeyExW(HKEY_CURRENT_USER, keyPath, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr);
  if (opened != ERROR_SUCCESS || !key) return false;
  const LONG written = RegSetValueExW(key, valueName, 0, REG_SZ,
    reinterpret_cast<const BYTE*>(value.c_str()), static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  return written == ERROR_SUCCESS;
}

bool ReadRegistryString(const wchar_t* keyPath, const wchar_t* valueName, std::wstring& value) {
  value.clear();
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, keyPath, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS || !key) return false;
  DWORD type = 0;
  DWORD bytes = 0;
  LONG result = RegQueryValueExW(key, valueName, nullptr, &type, nullptr, &bytes);
  if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ) || bytes < sizeof(wchar_t)) {
    RegCloseKey(key);
    return false;
  }
  value.resize(bytes / sizeof(wchar_t));
  result = RegQueryValueExW(key, valueName, nullptr, &type, reinterpret_cast<BYTE*>(value.data()), &bytes);
  RegCloseKey(key);
  if (result != ERROR_SUCCESS) { value.clear(); return false; }
  while (!value.empty() && value.back() == L'\0') value.pop_back();
  return true;
}

bool WriteRegistryDword(const wchar_t* keyPath, const wchar_t* valueName, DWORD value) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, keyPath, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS || !key) return false;
  const LONG result = RegSetValueExW(key, valueName, 0, REG_DWORD,
    reinterpret_cast<const BYTE*>(&value), sizeof(value));
  RegCloseKey(key);
  return result == ERROR_SUCCESS;
}

bool ReadRegistryDword(const wchar_t* keyPath, const wchar_t* valueName, DWORD& value) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, keyPath, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS || !key) return false;
  DWORD type = 0;
  DWORD bytes = sizeof(value);
  const LONG result = RegQueryValueExW(key, valueName, nullptr, &type,
    reinterpret_cast<BYTE*>(&value), &bytes);
  RegCloseKey(key);
  return result == ERROR_SUCCESS && type == REG_DWORD && bytes == sizeof(value);
}

bool DeleteRegistryValue(const wchar_t* keyPath, const wchar_t* valueName) {
  HKEY key = nullptr;
  const LONG opened = RegOpenKeyExW(HKEY_CURRENT_USER, keyPath, 0, KEY_SET_VALUE, &key);
  if (opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND) return true;
  if (opened != ERROR_SUCCESS || !key) return false;
  const LONG removed = RegDeleteValueW(key, valueName);
  RegCloseKey(key);
  return removed == ERROR_SUCCESS || removed == ERROR_FILE_NOT_FOUND;
}

bool ApplyExplorerContextMenuRegistration(bool enabled) {
  constexpr wchar_t menuKey[] = L"Software\\Classes\\Directory\\shell\\OpenInZhangZhongJie";
  constexpr wchar_t commandKey[] = L"Software\\Classes\\Directory\\shell\\OpenInZhangZhongJie\\command";
  constexpr wchar_t legacyMenuKey[] = L"Software\\Classes\\Directory\\shell\\ZhangZhongJie.Open";
  constexpr wchar_t extensionKey[] = L"Software\\Classes\\.zzj";
  constexpr wchar_t projectTypeKey[] = L"Software\\Classes\\ZhangZhongJie.Project";
  constexpr wchar_t projectIconKey[] = L"Software\\Classes\\ZhangZhongJie.Project\\DefaultIcon";
  constexpr wchar_t projectCommandKey[] = L"Software\\Classes\\ZhangZhongJie.Project\\shell\\open\\command";
  constexpr wchar_t appRegistrationKey[] = L"Software\\ZhangZhongJie";
  constexpr wchar_t previousProgIdValue[] = L"PreviousZzjProgId";
  constexpr wchar_t previousCapturedValue[] = L"PreviousZzjProgIdCaptured";
  const auto removeKey = [](const wchar_t* keyPath) {
    const LONG removed = RegDeleteTreeW(HKEY_CURRENT_USER, keyPath);
    return removed == ERROR_SUCCESS || removed == ERROR_FILE_NOT_FOUND || removed == ERROR_PATH_NOT_FOUND;
  };
  const std::wstring executable = ModulePath();
  if (executable.empty()) return false;
  // 「.zzj 的图标 + 双击打开」= 文件类型注册，跟「资源管理器右键菜单」是两件事，必须分开：
  // 以前关掉右键菜单会顺手把整个 ProgID 删掉，于是保存出来的 .zzj 就没图标了（用户 2026-09-14 报）。
  // 现在文件类型始终注册；开关只管右键菜单那一项。
  bool success = WriteRegistryString(extensionKey, nullptr, L"ZhangZhongJie.Project") &&
    WriteRegistryString(projectTypeKey, nullptr, L"掌中界项目") &&
    WriteRegistryString(projectIconKey, nullptr, L"\"" + executable + L"\",0") &&
    WriteRegistryString(projectCommandKey, nullptr, L"\"" + executable + L"\" \"%1\"");
  if (enabled) {
    success = success &&
      WriteRegistryString(menuKey, nullptr, L"用掌中界打开") &&
      WriteRegistryString(menuKey, L"Icon", executable + L",0") &&
      WriteRegistryString(commandKey, nullptr, L"\"" + executable + L"\" \"%1\"");
  } else {
    success = success && removeKey(menuKey);
  }
  // 旧版留下的「还原上一个 ProgID」记录不再需要，顺手清掉不留垃圾。
  DeleteRegistryValue(appRegistrationKey, previousProgIdValue);
  DeleteRegistryValue(appRegistrationKey, previousCapturedValue);
  success = success && removeKey(legacyMenuKey);
  if (success) SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
  return success;
}
void PostToCanvas(const std::wstring& json) {
  if (g_appWebView) g_appWebView->PostWebMessageAsJson(json.c_str());
}

void PostToCanvasAsync(std::wstring json) {
  if (!g_mainWindow) return;
  auto* payload = new std::wstring(std::move(json));
  if (!PostMessageW(g_mainWindow, kPostCanvasMessage, 0, reinterpret_cast<LPARAM>(payload))) {
    delete payload;
  }
}

void ResetSurfacePerfCounters() {
  g_surfacePerfCounters = {};
  g_surfacePerfCounters.startedAt = GetTickCount64();
}

void SendSurfacePerfCounters() {
  const ULONGLONG now = GetTickCount64();
  const ULONGLONG elapsed = g_surfacePerfCounters.startedAt
    ? now - g_surfacePerfCounters.startedAt
    : 0;
  std::wostringstream json;
  json << L"{\"type\":\"native-perf-stats\",\"elapsedMs\":" << elapsed
       << L",\"surfaceUpserts\":" << g_surfacePerfCounters.upserts
       << L",\"setWindowPosCalls\":" << g_surfacePerfCounters.setWindowPosCalls
       << L",\"compositionRegionUpdates\":" << g_surfacePerfCounters.compositionRegionUpdates
       << L"}";
  PostToCanvas(json.str());
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}

std::wstring JsonEscape(const std::wstring& value) {
  std::wstring result;
  result.reserve(value.size() + 8);
  for (const wchar_t ch : value) {
    if (ch == L'\\' || ch == L'"') { result.push_back(L'\\'); result.push_back(ch); }
    else if (ch == L'\n') result += L"\\n";
    else if (ch == L'\r') result += L"\\r";
    else if (ch == L'\t') result += L"\\t";
    else result.push_back(ch);
  }
  return result;
}

std::wstring JsonStringValue(const std::wstring& json, const std::wstring& key) {
  const std::wstring marker = L"\"" + key + L"\":";
  const size_t markerStart = json.find(marker);
  if (markerStart == std::wstring::npos) return {};
  size_t start = markerStart + marker.size();
  while (start < json.size() && iswspace(json[start])) ++start;
  if (start >= json.size() || json[start] != L'"') return {};
  ++start;
  std::wstring result;
  bool escaped = false;
  for (size_t index = start; index < json.size(); ++index) {
    const wchar_t ch = json[index];
    if (escaped) {
      if (ch == L'n') result.push_back(L'\n');
      else if (ch == L'r') result.push_back(L'\r');
      else if (ch == L't') result.push_back(L'\t');
      else result.push_back(ch);
      escaped = false;
    } else if (ch == L'\\') {
      escaped = true;
    } else if (ch == L'"') {
      break;
    } else {
      result.push_back(ch);
    }
  }
  return result;
}

int JsonIntValue(const std::wstring& json, const std::wstring& key, int fallback = 0) {
  const std::wstring marker = L"\"" + key + L"\":";
  const size_t markerStart = json.find(marker);
  if (markerStart == std::wstring::npos) return fallback;
  size_t start = markerStart + marker.size();
  while (start < json.size() && iswspace(json[start])) ++start;
  try { return std::stoi(json.substr(start)); } catch (...) { return fallback; }
}

double JsonDoubleValue(const std::wstring& json, const std::wstring& key, double fallback = 1.0) {
  const std::wstring marker = L"\"" + key + L"\":";
  const size_t markerStart = json.find(marker);
  if (markerStart == std::wstring::npos) return fallback;
  const wchar_t* begin = json.c_str() + markerStart + marker.size();
  wchar_t* end = nullptr;
  const double value = wcstod(begin, &end);
  if (end == begin) return fallback;
  return value;
}

bool JsonBoolValue(const std::wstring& json, const std::wstring& key, bool fallback = false) {
  const std::wstring marker = L"\"" + key + L"\":";
  const size_t markerStart = json.find(marker);
  if (markerStart == std::wstring::npos) return fallback;
  size_t start = markerStart + marker.size();
  while (start < json.size() && iswspace(json[start])) ++start;
  if (json.compare(start, 4, L"true") == 0) return true;
  if (json.compare(start, 5, L"false") == 0) return false;
  return fallback;
}

std::wstring ReadRegistryString(HKEY root, const wchar_t* path, const wchar_t* valueName) {
  DWORD size = 0;
  if (RegGetValueW(root, path, valueName, RRF_RT_REG_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS || size < sizeof(wchar_t)) return {};
  std::wstring value(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(root, path, valueName, RRF_RT_REG_SZ, nullptr, value.data(), &size) != ERROR_SUCCESS) return {};
  while (!value.empty() && value.back() == L'\0') value.pop_back();
  return value;
}

std::pair<std::wstring, std::filesystem::path> DefaultBrowserProfile() {
  std::wstring progId = ReadRegistryString(HKEY_CURRENT_USER,
    L"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", L"ProgId");
  std::wstring lowered = progId;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), ::towlower);
  wchar_t localAppData[MAX_PATH]{};
  GetEnvironmentVariableW(L"LOCALAPPDATA", localAppData, static_cast<DWORD>(std::size(localAppData)));
  const std::filesystem::path base(localAppData);
  if (lowered.find(L"chrome") != std::wstring::npos) return {L"Chrome", base / L"Google" / L"Chrome" / L"User Data" / L"Default" / L"Bookmarks"};
  if (lowered.find(L"edge") != std::wstring::npos || lowered.find(L"microsoft") != std::wstring::npos) return {L"Edge", base / L"Microsoft" / L"Edge" / L"User Data" / L"Default" / L"Bookmarks"};
  if (lowered.find(L"quark") != std::wstring::npos) return {L"夸克", base / L"Quark" / L"User Data" / L"Default" / L"Bookmarks"};
  return {progId.empty() ? L"系统默认浏览器" : progId, {}};
}

// 交接文档 §4.1 要求保留收藏夹的文件夹层级和顺序。之前是拿正则在整个文件上
// 扁平抓 name/type/url，层级、顺序和转义全丢，还硬性截断在 48 条。这里换成一个
// 够用的递归下降解析器：只认对象、数组、字符串，其余值跳过，足以走完 Chrome /
// Edge 的 Bookmarks 结构，并且能正确处理 \" 与 \uXXXX。
struct JsonValue {
  enum class Kind { Other, String, Bool, Object, Array } kind = Kind::Other;
  std::wstring text;
  std::vector<std::pair<std::wstring, JsonValue>> members;
  std::vector<JsonValue> items;
  const JsonValue* Member(const wchar_t* key) const {
    for (const auto& entry : members) if (entry.first == key) return &entry.second;
    return nullptr;
  }
};

void SkipJsonSpace(const std::wstring& text, size_t& at) {
  while (at < text.size() && iswspace(text[at])) ++at;
}

std::wstring ParseJsonString(const std::wstring& text, size_t& at) {
  std::wstring value;
  if (at >= text.size() || text[at] != L'"') return value;
  ++at;
  while (at < text.size()) {
    const wchar_t ch = text[at++];
    if (ch == L'"') break;
    // 92 是反斜杠的字符码，写成字面量容易被各层转义吃掉
    if (ch != static_cast<wchar_t>(92)) { value.push_back(ch); continue; }
    if (at >= text.size()) break;
    const wchar_t escape = text[at++];
    if (escape == L'n') value.push_back(L'\n');
    else if (escape == L'r') value.push_back(L'\r');
    else if (escape == L't') value.push_back(L'\t');
    else if (escape == L'b') value.push_back(L'\b');
    else if (escape == L'f') value.push_back(L'\f');
    else if (escape == L'u') {
      if (at + 4 <= text.size()) {
        value.push_back(static_cast<wchar_t>(wcstoul(text.substr(at, 4).c_str(), nullptr, 16)));
        at += 4;
      }
    } else value.push_back(escape);
  }
  return value;
}

JsonValue ParseJsonValue(const std::wstring& text, size_t& at, int depth = 0) {
  JsonValue value;
  SkipJsonSpace(text, at);
  if (at >= text.size() || depth > 64) return value;
  if (text[at] == L'"') {
    value.kind = JsonValue::Kind::String;
    value.text = ParseJsonString(text, at);
    return value;
  }
  if (text[at] == L'{') {
    value.kind = JsonValue::Kind::Object;
    ++at;
    while (at < text.size()) {
      SkipJsonSpace(text, at);
      if (at < text.size() && text[at] == L'}') { ++at; break; }
      const std::wstring key = ParseJsonString(text, at);
      SkipJsonSpace(text, at);
      if (at < text.size() && text[at] == L':') ++at;
      value.members.emplace_back(key, ParseJsonValue(text, at, depth + 1));
      SkipJsonSpace(text, at);
      if (at < text.size() && text[at] == L',') ++at;
    }
    return value;
  }
  if (text[at] == L'[') {
    value.kind = JsonValue::Kind::Array;
    ++at;
    while (at < text.size()) {
      SkipJsonSpace(text, at);
      if (at < text.size() && text[at] == L']') { ++at; break; }
      value.items.push_back(ParseJsonValue(text, at, depth + 1));
      SkipJsonSpace(text, at);
      if (at < text.size() && text[at] == L',') ++at;
    }
    return value;
  }
  if (text.compare(at, 4, L"true") == 0) {
    value.kind = JsonValue::Kind::Bool;
    value.text = L"true";
    at += 4;
    return value;
  }
  if (text.compare(at, 5, L"false") == 0) {
    value.kind = JsonValue::Kind::Bool;
    value.text = L"false";
    at += 5;
    return value;
  }
  const size_t start = at;
  while (at < text.size() && text[at] != L',' && text[at] != L'}' && text[at] != L']') ++at;
  size_t end = at;
  while (end > start && iswspace(text[end - 1])) --end;
  value.text = text.substr(start, end - start);
  return value;
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

std::wstring ShellNormalDisplayName(const std::wstring& parsingName) {
  if (parsingName.empty()) return {};
  ComPtr<IShellItem> item;
  const HRESULT result = parsingName == L"shell:MyComputerFolder"
    ? SHGetKnownFolderItem(FOLDERID_ComputerFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&item))
    : SHCreateItemFromParsingName(parsingName.c_str(), nullptr, IID_PPV_ARGS(&item));
  if (FAILED(result) || !item) return {};
  LPWSTR value = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &value)) || !value) return {};
  std::wstring displayName(value);
  CoTaskMemFree(value);
  return displayName;
}

std::wstring CanvasPathJson(const std::filesystem::path& path) {
  const auto classified = ClassifyCanvasPath(path);
  const std::wstring displayName = ShellNormalDisplayName(path.wstring());
  std::wstring json = L"{\"path\":\"" + JsonEscape(path.wstring()) +
    L"\",\"folder\":" + (classified.folder ? std::wstring(L"true") : std::wstring(L"false"));
  if (!displayName.empty()) json += L",\"displayName\":\"" + JsonEscape(displayName) + L"\"";
  if (classified.projectKind != CanvasProjectKind::None) {
    json += L",\"projectKind\":\"";
    json += classified.projectKind == CanvasProjectKind::Archive ? L"archive" : L"directory";
    json += L"\",\"projectPath\":\"" + JsonEscape(classified.projectPath.wstring()) + L"\"";
  }
  return json + L"}";
}

bool ReadUtf8File(const std::filesystem::path& path, std::wstring& value) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) return false;
  const std::string bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
  value = Utf8ToWide(bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF &&
    static_cast<unsigned char>(bytes[1]) == 0xBB && static_cast<unsigned char>(bytes[2]) == 0xBF
    ? bytes.substr(3) : bytes);
  return true;
}

bool WriteUtf8FileAtomic(const std::filesystem::path& path, const std::wstring& value) {
  std::error_code error;
  std::filesystem::create_directories(path.parent_path(), error);
  if (error) return false;
  const auto temporary = path.wstring() + L".tmp";
  {
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) return false;
    const std::string bytes = WideToUtf8(value);
    stream.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!stream) return false;
  }
  if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temporary.c_str());
    return false;
  }
  return true;
}

std::filesystem::path WebThemeSettingPath() {
  return std::filesystem::path(g_dataFolder) / L"web-force-dark.txt";
}

std::filesystem::path SettingsPath() {
  return std::filesystem::path(g_dataFolder) / L"settings.json";
}

std::filesystem::path BrowserProfileMigrationNoticePath() {
  return std::filesystem::path(g_dataFolder) / L"browser-profile-migration-notice-v1.txt";
}

void LoadWebThemeSetting() {
  std::wstring value;
  if (!ReadUtf8File(WebThemeSettingPath(), value)) return;
  if (value == L"dark" || value == L"1") g_webThemeMode = L"dark";
  else if (value == L"original") g_webThemeMode = L"original";
  else if (value == L"follow" || value == L"0") g_webThemeMode = L"follow";
  else g_webThemeMode = L"dark";
}

bool IsOneOf(const std::wstring& value, std::initializer_list<const wchar_t*> choices) {
  return std::any_of(choices.begin(), choices.end(), [&value](const wchar_t* choice) { return value == choice; });
}

std::wstring JsonStringArray(const std::vector<std::wstring>& values) {
  std::wstring json = L"[";
  for (size_t index = 0; index < values.size(); ++index) {
    if (index) json += L",";
    json += L"\"" + JsonEscape(values[index]) + L"\"";
  }
  return json + L"]";
}

std::wstring JsonWebBookmarks() {
  std::wstring json = L"[";
  for (size_t index = 0; index < g_webBookmarks.size(); ++index) {
    if (index) json += L",";
    const auto& bookmark = g_webBookmarks[index];
    json += L"{\"id\":\"" + JsonEscape(bookmark.id) + L"\",\"name\":\"" +
      JsonEscape(bookmark.name) + L"\",\"url\":\"" + JsonEscape(bookmark.url) + L"\"}";
  }
  return json + L"]";
}

std::wstring JsonGlobalFavorites() {
  std::wstring json = L"[";
  for (size_t index = 0; index < g_globalFavorites.size(); ++index) {
    if (index) json += L",";
    const auto& favorite = g_globalFavorites[index];
    json += L"{\"id\":\"" + JsonEscape(favorite.id) + L"\",\"label\":\"" +
      JsonEscape(favorite.label) + L"\",\"source\":\"" + JsonEscape(favorite.source) +
      L"\",\"sourceKind\":\"" + JsonEscape(favorite.sourceKind) + L"\"";
    if (!favorite.image.empty()) json += L",\"image\":\"" + JsonEscape(favorite.image) + L"\"";
    json += L"}";
  }
  return json + L"]";
}

void LoadWebBookmarks(const JsonValue* value) {
  g_webBookmarks.clear();
  if (!value || value->kind != JsonValue::Kind::Array) return;
  for (const auto& candidate : value->items) {
    if (candidate.kind != JsonValue::Kind::Object || g_webBookmarks.size() >= 400) continue;
    const auto* id = candidate.Member(L"id");
    const auto* name = candidate.Member(L"name");
    const auto* url = candidate.Member(L"url");
    if (!id || !name || !url || id->kind != JsonValue::Kind::String ||
        name->kind != JsonValue::Kind::String || url->kind != JsonValue::Kind::String ||
        id->text.empty() || name->text.empty() ||
        // 只拦「根本不是网址」的垃圾。file:// 必须放行：本地 HTML（D 盘上的看板/报表）
        // 在掌中界里就是个正经网页，以前这里只认 http/https，收藏本地页面会被
        // 静默丢掉 → 用户看到「点了收藏没反应 / 重启后没了」。（2026-09-14）
        !(url->text.rfind(L"http://", 0) == 0 || url->text.rfind(L"https://", 0) == 0 ||
          url->text.rfind(L"file://", 0) == 0)) continue;
    g_webBookmarks.push_back({id->text.substr(0, 120), name->text.substr(0, 120), url->text.substr(0, 4096)});
  }
}

void LoadGlobalFavorites(const JsonValue* value) {
  g_globalFavorites.clear();
  if (!value || value->kind != JsonValue::Kind::Array) return;
  std::unordered_set<std::wstring> seenSources;
  for (const auto& candidate : value->items) {
    if (candidate.kind != JsonValue::Kind::Object || g_globalFavorites.size() >= 200) continue;
    const auto* id = candidate.Member(L"id");
    const auto* label = candidate.Member(L"label");
    const auto* source = candidate.Member(L"source");
    const auto* sourceKind = candidate.Member(L"sourceKind");
    const auto* image = candidate.Member(L"image");
    if (!id || !label || !source || !sourceKind || id->kind != JsonValue::Kind::String ||
        label->kind != JsonValue::Kind::String || source->kind != JsonValue::Kind::String ||
        sourceKind->kind != JsonValue::Kind::String || id->text.empty() || label->text.empty() ||
        source->text.empty() ||
        (sourceKind->text != L"file" && sourceKind->text != L"folder" && sourceKind->text != L"app")) continue;
    if (_wcsicmp(source->text.c_str(), L"shell:MyComputerFolder") == 0) continue;
    std::wstring sourceKey = sourceKind->text + L":" + source->text;
    std::transform(sourceKey.begin(), sourceKey.end(), sourceKey.begin(), ::towlower);
    if (!seenSources.insert(sourceKey).second) continue;
    std::wstring imageValue;
    if (image && image->kind == JsonValue::Kind::String && image->text.rfind(L"data:image/", 0) == 0 && image->text.size() <= 524288) {
      imageValue = image->text;
    }
    g_globalFavorites.push_back({
      id->text.substr(0, 160), label->text.substr(0, 120), source->text.substr(0, 32767),
      sourceKind->text, std::move(imageValue),
    });
  }
}

std::vector<std::wstring> JsonStringArrayValue(const std::wstring& json, const wchar_t* key);

std::vector<std::wstring> NormalizeFileColumns(const std::vector<std::wstring>& values) {
  const std::vector<std::wstring> allowed{L"name", L"type", L"dimensions", L"duration", L"modified", L"size"};
  std::vector<std::wstring> result;
  for (const auto& column : allowed) {
    if (column == L"name" || std::find(values.begin(), values.end(), column) != values.end()) {
      result.push_back(column);
    }
  }
  return result;
}

std::vector<std::wstring> NormalizeGlobalQuickActions(const std::vector<std::wstring>& values) {
  const std::vector<std::wstring> allowed{L"computer", L"web", L"shelf"};
  std::vector<std::wstring> result;
  for (const auto& value : values) {
    if (std::find(allowed.begin(), allowed.end(), value) != allowed.end() &&
        std::find(result.begin(), result.end(), value) == result.end()) result.push_back(value);
  }
  return result.empty() || std::find(values.begin(), values.end(), L"folder") != values.end() ? allowed : result;
}

std::vector<std::wstring> NormalizeGlobalFixedOrder(const std::vector<std::wstring>& values) {
  std::vector<std::wstring> available;
  available.reserve(g_globalQuickActions.size() + g_globalFavorites.size());
  for (const auto& action : g_globalQuickActions) available.push_back(L"quick-" + action);
  for (const auto& favorite : g_globalFavorites) available.push_back(favorite.id);
  std::vector<std::wstring> result;
  const bool hasRetiredQuickAction = std::find(values.begin(), values.end(), L"quick-folder") != values.end();
  if (hasRetiredQuickAction) {
    for (const auto& action : g_globalQuickActions) result.push_back(L"quick-" + action);
  }
  for (const auto& value : values) {
    if (hasRetiredQuickAction && value.rfind(L"quick-", 0) == 0) continue;
    if (std::find(available.begin(), available.end(), value) != available.end() &&
        std::find(result.begin(), result.end(), value) == result.end()) result.push_back(value);
  }
  for (const auto& value : available) {
    if (std::find(result.begin(), result.end(), value) == result.end()) result.push_back(value);
  }
  return result;
}

bool IsFileColumn(const std::wstring& column) {
  return IsOneOf(column, {L"name", L"type", L"dimensions", L"duration", L"modified", L"size"});
}

int ParseColumnWidth(const JsonValue& value, const std::wstring& column) {
  if (value.kind != JsonValue::Kind::Other || value.text.empty()) return 0;
  wchar_t* end = nullptr;
  const long parsed = wcstol(value.text.c_str(), &end, 10);
  if (!end || *end != L'\0') return 0;
  const int minimum = column == L"name" ? 140 : 70;
  return static_cast<int>(std::clamp<long>(parsed, minimum, 1200));
}

void LoadFileColumnWidths(const JsonValue* value) {
  g_fileColumnWidths.clear();
  if (!value || value->kind != JsonValue::Kind::Object) return;
  for (const auto& card : value->members) {
    if (card.first.empty() || card.second.kind != JsonValue::Kind::Object) continue;
    auto& widths = g_fileColumnWidths[card.first];
    for (const auto& entry : card.second.members) {
      if (!IsFileColumn(entry.first)) continue;
      const int width = ParseColumnWidth(entry.second, entry.first);
      if (width > 0) widths[entry.first] = width;
    }
    if (widths.empty()) g_fileColumnWidths.erase(card.first);
  }
}

std::wstring JsonFileColumnWidths() {
  std::wstring json = L"{";
  bool firstCard = true;
  for (const auto& card : g_fileColumnWidths) {
    if (!firstCard) json += L",";
    firstCard = false;
    json += L"\"" + JsonEscape(card.first) + L"\":{";
    bool firstColumn = true;
    for (const auto& column : card.second) {
      if (!firstColumn) json += L",";
      firstColumn = false;
      json += L"\"" + JsonEscape(column.first) + L"\":" + std::to_wstring(column.second);
    }
    json += L"}";
  }
  return json + L"}";
}

int ParseWidthValue(const JsonValue& value, int minimum, int maximum) {
  if (value.kind != JsonValue::Kind::Other || value.text.empty()) return 0;
  wchar_t* end = nullptr;
  const long parsed = wcstol(value.text.c_str(), &end, 10);
  if (!end || *end != L'\0') return 0;
  return static_cast<int>(std::clamp<long>(parsed, minimum, maximum));
}

void LoadWidthMap(const JsonValue* value, std::unordered_map<std::wstring, int>& destination,
                  int minimum, int maximum) {
  destination.clear();
  if (!value || value->kind != JsonValue::Kind::Object) return;
  for (const auto& entry : value->members) {
    if (entry.first.empty()) continue;
    const int width = ParseWidthValue(entry.second, minimum, maximum);
    if (width > 0) destination[entry.first] = width;
  }
}

std::wstring JsonWidthMap(const std::unordered_map<std::wstring, int>& widths) {
  std::wstring json = L"{";
  bool first = true;
  for (const auto& entry : widths) {
    if (!first) json += L",";
    first = false;
    json += L"\"" + JsonEscape(entry.first) + L"\":" + std::to_wstring(entry.second);
  }
  return json + L"}";
}

std::wstring JsonShortcutBindings() {
  std::wstring json = L"{";
  bool first = true;
  for (const auto& entry : g_shortcutBindings) {
    if (!first) json += L",";
    first = false;
    json += L"\"" + JsonEscape(entry.first) + L"\":\"" + JsonEscape(entry.second) + L"\"";
  }
  return json + L"}";
}

void LoadShortcutBindings(const JsonValue* value) {
  g_shortcutBindings.clear();
  if (!value || value->kind != JsonValue::Kind::Object) return;
  for (const auto& entry : value->members) {
    if (entry.first.empty() || entry.first.size() > 100 || entry.second.kind != JsonValue::Kind::String) continue;
    g_shortcutBindings[entry.first] = entry.second.text.substr(0, 80);
  }
}

std::wstring SettingsDocument() {
  return L"{\n"
    L"  \"version\": " + std::to_wstring(g_settingsVersion) + L",\n"
    L"  \"windowAppearance\": \"" + JsonEscape(g_windowAppearance) + L"\",\n"
    L"  \"windowMaterial\": \"" + JsonEscape(g_windowMaterial) + L"\",\n"
    L"  \"toolbarVisibility\": \"" + JsonEscape(g_toolbarVisibility) + L"\",\n"
    L"  \"cardTitlebarVisibility\": \"" + JsonEscape(g_cardTitlebarVisibility) + L"\",\n"
    L"  \"appTheme\": \"" + JsonEscape(g_appThemeMode) + L"\",\n"
    L"  \"webThemeMode\": \"" + JsonEscape(g_webThemeMode) + L"\",\n"
    L"  \"fileTreeCollapsed\": " + std::wstring(g_fileTreeCollapsed ? L"true" : L"false") + L",\n"
    L"  \"fileViewMode\": \"" + JsonEscape(g_fileViewMode) + L"\",\n"
    L"  \"fileIconMode\": \"" + JsonEscape(g_fileIconMode) + L"\",\n"
    L"  \"fileColumns\": " + JsonStringArray(g_fileColumns) + L",\n"
    L"  \"globalQuickActions\": " + JsonStringArray(g_globalQuickActions) + L",\n"
    L"  \"globalFavorites\": " + JsonGlobalFavorites() + L",\n"
    L"  \"globalFixedOrder\": " + JsonStringArray(g_globalFixedOrder) + L",\n"
    L"  \"webBookmarks\": " + JsonWebBookmarks() + L",\n"
    L"  \"fileColumnWidths\": " + JsonFileColumnWidths() + L",\n"
    L"  \"fileTreeWidths\": " + JsonWidthMap(g_fileTreeWidths) + L",\n"
    L"  \"fileTreeColumnWidths\": " + JsonWidthMap(g_fileTreeColumnWidths) + L",\n"
    L"  \"previewNameColumnWidth\": " + std::to_wstring(g_previewNameColumnWidth) + L",\n"
    L"  \"mediaMuted\": " + std::wstring(g_mediaMuted ? L"true" : L"false") + L",\n"
    L"  \"mediaPlaybackRate\": " + std::to_wstring(g_mediaPlaybackRate) + L",\n"
    L"  \"exportFolder\": \"" + JsonEscape(g_exportFolder) + L"\",\n"
    L"  \"everythingPromptDismissed\": " + std::wstring(g_everythingPromptDismissed ? L"true" : L"false") + L",\n"
    L"  \"explorerContextMenuEnabled\": " + std::wstring(g_explorerContextMenuEnabled ? L"true" : L"false") + L",\n"
    L"  \"settingsWidth\": " + std::to_wstring(g_settingsWidth) + L",\n"
    L"  \"settingsHeight\": " + std::to_wstring(g_settingsHeight) + L",\n"
    L"  \"shortcutBindings\": " + JsonShortcutBindings() + L"\n"
    L"}\n";
}

bool SaveSettings() {
  return WriteUtf8FileAtomic(SettingsPath(), SettingsDocument());
}

bool IsSettingsDocumentValid(const std::wstring& json) {
  size_t first = 0;
  while (first < json.size() && iswspace(json[first])) ++first;
  size_t last = json.size();
  while (last > first && iswspace(json[last - 1])) --last;
  if (last <= first || json[first] != L'{' || json[last - 1] != L'}') return false;
  size_t at = 0;
  const JsonValue root = ParseJsonValue(json, at);
  SkipJsonSpace(json, at);
  if (root.kind != JsonValue::Kind::Object || at != json.size()) return false;
  for (const wchar_t* key : {L"windowAppearance", L"windowMaterial", L"toolbarVisibility", L"cardTitlebarVisibility", L"appTheme", L"webThemeMode", L"fileViewMode", L"fileIconMode"}) {
    const JsonValue* member = root.Member(key);
    if (member && member->kind != JsonValue::Kind::String) return false;
  }
  const JsonValue* fileTreeCollapsed = root.Member(L"fileTreeCollapsed");
  if (fileTreeCollapsed && fileTreeCollapsed->kind != JsonValue::Kind::Bool) return false;
  const JsonValue* fileColumns = root.Member(L"fileColumns");
  if (fileColumns) {
    if (fileColumns->kind != JsonValue::Kind::Array) return false;
    for (const auto& value : fileColumns->items) if (value.kind != JsonValue::Kind::String) return false;
  }
  const JsonValue* globalQuickActions = root.Member(L"globalQuickActions");
  if (globalQuickActions) {
    if (globalQuickActions->kind != JsonValue::Kind::Array) return false;
    for (const auto& value : globalQuickActions->items) if (value.kind != JsonValue::Kind::String) return false;
  }
  const JsonValue* globalFavorites = root.Member(L"globalFavorites");
  if (globalFavorites) {
    if (globalFavorites->kind != JsonValue::Kind::Array) return false;
    for (const auto& favorite : globalFavorites->items) {
      if (favorite.kind != JsonValue::Kind::Object) return false;
      for (const wchar_t* key : {L"id", L"label", L"source", L"sourceKind"}) {
        const JsonValue* member = favorite.Member(key);
        if (!member || member->kind != JsonValue::Kind::String) return false;
      }
      const JsonValue* image = favorite.Member(L"image");
      if (image && image->kind != JsonValue::Kind::String) return false;
    }
  }
  const JsonValue* globalFixedOrder = root.Member(L"globalFixedOrder");
  if (globalFixedOrder) {
    if (globalFixedOrder->kind != JsonValue::Kind::Array) return false;
    for (const auto& value : globalFixedOrder->items) if (value.kind != JsonValue::Kind::String) return false;
  }
  const JsonValue* fileColumnWidths = root.Member(L"fileColumnWidths");
  if (fileColumnWidths) {
    if (fileColumnWidths->kind != JsonValue::Kind::Object) return false;
    for (const auto& card : fileColumnWidths->members) {
      if (card.second.kind != JsonValue::Kind::Object) return false;
      for (const auto& column : card.second.members) {
        if (!IsFileColumn(column.first) || ParseColumnWidth(column.second, column.first) <= 0) return false;
      }
    }
  }
  for (const auto& widthMap : {
    std::pair<const wchar_t*, std::pair<int, int>>{L"fileTreeWidths", {200, 2000}},
    std::pair<const wchar_t*, std::pair<int, int>>{L"fileTreeColumnWidths", {80, 1200}},
  }) {
    const JsonValue* value = root.Member(widthMap.first);
    if (!value) continue;
    if (value->kind != JsonValue::Kind::Object) return false;
    for (const auto& entry : value->members) {
      if (entry.first.empty() || ParseWidthValue(entry.second, widthMap.second.first, widthMap.second.second) <= 0) return false;
    }
  }
  const JsonValue* previewNameColumnWidth = root.Member(L"previewNameColumnWidth");
  if (previewNameColumnWidth && ParseWidthValue(*previewNameColumnWidth, 100, 410) <= 0) return false;
  const JsonValue* webBookmarks = root.Member(L"webBookmarks");
  if (webBookmarks) {
    if (webBookmarks->kind != JsonValue::Kind::Array) return false;
    for (const auto& bookmark : webBookmarks->items) {
      if (bookmark.kind != JsonValue::Kind::Object) return false;
      for (const wchar_t* key : {L"id", L"name", L"url"}) {
        const JsonValue* member = bookmark.Member(key);
        if (!member || member->kind != JsonValue::Kind::String) return false;
      }
    }
  }
  const JsonValue* mediaMuted = root.Member(L"mediaMuted");
  if (mediaMuted && mediaMuted->kind != JsonValue::Kind::Bool) return false;
  const JsonValue* everythingPromptDismissed = root.Member(L"everythingPromptDismissed");
  if (everythingPromptDismissed && everythingPromptDismissed->kind != JsonValue::Kind::Bool) return false;
  const JsonValue* explorerContextMenuEnabled = root.Member(L"explorerContextMenuEnabled");
  if (explorerContextMenuEnabled && explorerContextMenuEnabled->kind != JsonValue::Kind::Bool) return false;
  const JsonValue* shortcutBindings = root.Member(L"shortcutBindings");
  if (shortcutBindings) {
    if (shortcutBindings->kind != JsonValue::Kind::Object) return false;
    for (const auto& entry : shortcutBindings->members) {
      if (entry.first.empty() || entry.first.size() > 100 || entry.second.kind != JsonValue::Kind::String || entry.second.text.size() > 80) return false;
    }
  }
  return true;
}

void ResetSettingsDefaults() {
  g_settingsVersion = 2;
  g_windowAppearance = L"borderless";
  g_toolbarVisibility = L"auto";
  g_cardTitlebarVisibility = L"hover";
  g_appThemeMode = L"system";
  g_webThemeMode = L"dark";
  g_fileTreeCollapsed = false;
  g_fileViewMode = L"details";
  g_fileIconMode = L"system";
  g_fileColumns = {L"name", L"modified", L"type", L"size"};
  g_globalQuickActions = {L"computer", L"web", L"note"};
  g_globalFavorites.clear();
  g_globalFixedOrder = {L"quick-computer", L"quick-web", L"quick-shelf"};
  g_webBookmarks.clear();
  g_fileColumnWidths.clear();
  g_fileTreeWidths.clear();
  g_fileTreeColumnWidths.clear();
  g_previewNameColumnWidth = 210;
  g_mediaMuted = true;
  g_mediaPlaybackRate = 1.0;
  g_everythingPromptDismissed = false;
  g_explorerContextMenuEnabled = true;
  g_settingsWidth = 620;
  g_settingsHeight = 720;
  g_shortcutBindings.clear();
}

void LoadSettings() {
  ResetSettingsDefaults();
  std::wstring json;
  const auto path = SettingsPath();
  if (!ReadUtf8File(path, json)) {
    // The legacy file remains the migration source until settings.json has
    // actually landed. A failed atomic write therefore remains retryable.
    LoadWebThemeSetting();
    SaveSettings();
    return;
  }
  if (!IsSettingsDocumentValid(json)) {
    const auto preserved = path.wstring() + L".damaged-" + std::to_wstring(GetTickCount64());
    CopyFileW(path.c_str(), preserved.c_str(), TRUE);
    g_settingsNoticePending = true;
    SaveSettings();
    return;
  }
  g_settingsVersion = JsonIntValue(json, L"version", 1) >= 2 ? 2 : 1;
  const auto safe = [](const std::wstring& value, std::initializer_list<const wchar_t*> allowed, const wchar_t* fallback) {
    return IsOneOf(value, allowed) ? value : std::wstring(fallback);
  };
  g_windowAppearance = safe(JsonStringValue(json, L"windowAppearance"), {L"system", L"borderless"}, L"borderless");
  g_exportFolder = JsonStringValue(json, L"exportFolder");
  g_windowMaterial = safe(JsonStringValue(json, L"windowMaterial"), {L"mica", L"solid"}, L"mica");
  g_toolbarVisibility = safe(JsonStringValue(json, L"toolbarVisibility"), {L"always", L"auto"}, L"auto");
  g_cardTitlebarVisibility = safe(JsonStringValue(json, L"cardTitlebarVisibility"), {L"always", L"hover"}, L"hover");
  g_appThemeMode = safe(JsonStringValue(json, L"appTheme"), {L"system", L"light", L"dark"}, L"system");
  g_webThemeMode = safe(JsonStringValue(json, L"webThemeMode"), {L"follow", L"dark", L"original"}, L"dark");
  g_fileTreeCollapsed = JsonBoolValue(json, L"fileTreeCollapsed", false);
  g_fileViewMode = safe(JsonStringValue(json, L"fileViewMode"), {L"details", L"large-icons", L"media-grid", L"compact"}, L"details");
  g_fileIconMode = safe(JsonStringValue(json, L"fileIconMode"), {L"system", L"vector"}, L"system");
  const auto fileColumns = JsonStringArrayValue(json, L"fileColumns");
  if (!fileColumns.empty()) g_fileColumns = NormalizeFileColumns(fileColumns);
  const auto globalQuickActions = JsonStringArrayValue(json, L"globalQuickActions");
  if (!globalQuickActions.empty()) g_globalQuickActions = NormalizeGlobalQuickActions(globalQuickActions);
  size_t settingsAt = 0;
  const JsonValue settingsRoot = ParseJsonValue(json, settingsAt);
  LoadGlobalFavorites(settingsRoot.Member(L"globalFavorites"));
  g_globalFixedOrder = NormalizeGlobalFixedOrder(JsonStringArrayValue(json, L"globalFixedOrder"));
  LoadFileColumnWidths(settingsRoot.Member(L"fileColumnWidths"));
  LoadWidthMap(settingsRoot.Member(L"fileTreeWidths"), g_fileTreeWidths, 200, 2000);
  LoadWidthMap(settingsRoot.Member(L"fileTreeColumnWidths"), g_fileTreeColumnWidths, 80, 1200);
  g_previewNameColumnWidth = std::clamp(JsonIntValue(json, L"previewNameColumnWidth", 210), 100, 410);
  LoadWebBookmarks(settingsRoot.Member(L"webBookmarks"));
  g_mediaMuted = JsonBoolValue(json, L"mediaMuted", true);
  g_everythingPromptDismissed = JsonBoolValue(json, L"everythingPromptDismissed", false);
  g_explorerContextMenuEnabled = JsonBoolValue(json, L"explorerContextMenuEnabled", true);
  g_settingsWidth = std::clamp(JsonIntValue(json, L"settingsWidth", 620), 560, 2400);
  g_settingsHeight = std::clamp(JsonIntValue(json, L"settingsHeight", 720), 420, 1600);
  LoadShortcutBindings(settingsRoot.Member(L"shortcutBindings"));
  const double mediaPlaybackRate = JsonDoubleValue(json, L"mediaPlaybackRate", 1.0);
  if (mediaPlaybackRate == 0.5 || mediaPlaybackRate == 1.0 || mediaPlaybackRate == 1.5 || mediaPlaybackRate == 2.0) {
    g_mediaPlaybackRate = mediaPlaybackRate;
  }
  // Rewriting a valid legacy document removes retired provider fields and
  // encrypted secrets while preserving every setting this version understands.
  SaveSettings();
}

std::vector<std::wstring> JsonStringArrayValue(const std::wstring& json, const wchar_t* key) {
  size_t at = 0;
  const JsonValue root = ParseJsonValue(json, at);
  const JsonValue* array = root.Member(key);
  std::vector<std::wstring> values;
  if (!array || array->kind != JsonValue::Kind::Array) return values;
  values.reserve(array->items.size());
  for (const auto& item : array->items) {
    if (item.kind == JsonValue::Kind::String) values.push_back(item.text);
  }
  return values;
}

void CollectBookmarks(const JsonValue& node, const std::wstring& folder, std::vector<BrowserBookmark>& out, bool& truncated) {
  const auto* children = node.Member(L"children");
  if (!children || children->kind != JsonValue::Kind::Array) return;
  for (const auto& child : children->items) {
    if (out.size() >= 400) { truncated = true; return; }
    const auto* type = child.Member(L"type");
    const auto* name = child.Member(L"name");
    if (!type) continue;
    if (type->text == L"url") {
      const auto* url = child.Member(L"url");
      if (url) out.push_back({name ? name->text : url->text, url->text, folder});
    } else if (type->text == L"folder") {
      const std::wstring label = name ? name->text : L"";
      CollectBookmarks(child, folder.empty() ? label : folder + L"/" + label, out, truncated);
    }
  }
}

std::vector<BrowserBookmark> ReadBrowserBookmarks(const std::filesystem::path& path, bool& truncated) {
  truncated = false;
  std::vector<BrowserBookmark> bookmarks;
  if (path.empty() || !std::filesystem::exists(path)) return bookmarks;
  std::ifstream file(path, std::ios::binary);
  if (!file) return bookmarks;
  const std::string raw((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  const std::wstring json = Utf8ToWide(raw);
  size_t at = 0;
  const JsonValue document = ParseJsonValue(json, at);
  const auto* roots = document.Member(L"roots");
  if (!roots) return bookmarks;
  // 顺序按 Chrome 自己的排法：书签栏、其他书签、移动书签。
  for (const wchar_t* key : {L"bookmark_bar", L"other", L"synced"}) {
    const auto* root = roots->Member(key);
    if (root) CollectBookmarks(*root, {}, bookmarks, truncated);
  }
  return bookmarks;
}

void SendBrowserProfile() {
  const auto [browser, path] = DefaultBrowserProfile();
  bool truncated = false;
  const auto bookmarks = ReadBrowserBookmarks(path, truncated);
  std::wostringstream json;
  json << L"{\"type\":\"browser-profile\",\"defaultBrowser\":\"" << JsonEscape(browser)
       << L"\",\"bookmarksTruncated\":" << (truncated ? L"true" : L"false") << L",\"bookmarks\":[";
  for (size_t index = 0; index < bookmarks.size(); ++index) {
    if (index) json << L',';
    json << L"{\"name\":\"" << JsonEscape(bookmarks[index].name)
         << L"\",\"url\":\"" << JsonEscape(bookmarks[index].url)
         << L"\",\"folder\":\"" << JsonEscape(bookmarks[index].folder) << L"\"}";
  }
  json << L"]}";
  PostToCanvas(json.str());
}

std::shared_ptr<NativeSurface> FindSurface(const std::wstring& id) {
  const auto iterator = std::find_if(g_surfaces.begin(), g_surfaces.end(), [&](const auto& surface) { return surface->id == id; });
  return iterator == g_surfaces.end() ? nullptr : *iterator;
}

const HoverOwnerCache& ResolveHoverOwner(HWND messageWindow) {
  if (g_hoverOwnerCache.valid &&
      g_hoverOwnerCache.messageWindow == messageWindow &&
      g_hoverOwnerCache.topologyRevision == g_surfaceTopologyRevision) {
    return g_hoverOwnerCache;
  }

  HoverOwnerCache resolved;
  resolved.messageWindow = messageWindow;
  resolved.topologyRevision = g_surfaceTopologyRevision;
  resolved.valid = true;
  for (HWND probe = messageWindow; probe && !resolved.owner; probe = GetParent(probe)) {
    for (const auto& surface : g_surfaces) {
      if (surface->host == probe) {
        resolved.owner = surface;
        break;
      }
    }
  }
  resolved.insideCompositionHost = g_compositionHost &&
    (messageWindow == g_compositionHost || IsChild(g_compositionHost, messageWindow));
  g_hoverOwnerCache = std::move(resolved);
  return g_hoverOwnerCache;
}

void PostSurfaceFocus(const std::wstring& id, bool select = false) {
  PostToCanvas(L"{\"type\":\"native-surface-focused\",\"surfaceId\":\"" + JsonEscape(id) +
    L"\",\"select\":" + (select ? std::wstring(L"true") : std::wstring(L"false")) + L"}");
}

POINT AppClientCssFromScreen(POINT screenPoint) {
  POINT physicalClient = screenPoint;
  if (g_mainWindow) ScreenToClient(g_mainWindow, &physicalClient);
  const UINT dpi = g_mainWindow ? std::max<UINT>(96, GetDpiForWindow(g_mainWindow)) : 96;
  return {MulDiv(physicalClient.x, 96, static_cast<int>(dpi)),
          MulDiv(physicalClient.y, 96, static_cast<int>(dpi))};
}

void PostCanvasZoom(const std::wstring& surfaceId, POINT screenPoint, int delta) {
  const POINT client = AppClientCssFromScreen(screenPoint);
  std::wostringstream payload;
  payload << L"{\"type\":\"canvas-zoom\",\"surfaceId\":\"" << JsonEscape(surfaceId)
          << L"\",\"screenX\":" << screenPoint.x << L",\"screenY\":" << screenPoint.y
          << L",\"clientX\":" << client.x << L",\"clientY\":" << client.y
          << L",\"delta\":" << delta << L"}";
  PostToCanvas(payload.str());
}

void PostCanvasPan(const wchar_t* phase, const std::wstring& surfaceId, POINT screenPoint) {
  const POINT client = AppClientCssFromScreen(screenPoint);
  std::wostringstream payload;
  payload << L"{\"type\":\"canvas-pan\",\"phase\":\"" << phase
          << L"\",\"surfaceId\":\"" << JsonEscape(surfaceId)
          << L"\",\"screenX\":" << screenPoint.x << L",\"screenY\":" << screenPoint.y
          << L",\"clientX\":" << client.x << L",\"clientY\":" << client.y << L"}";
  PostToCanvas(payload.str());
}

void PostQuickAdd(const wchar_t* kind) {
  POINT screenPoint{};
  if (!GetCursorPos(&screenPoint)) return;
  const POINT client = AppClientCssFromScreen(screenPoint);
  std::wostringstream payload;
  payload << L"{\"type\":\"native-quick-add\",\"kind\":\"" << kind
          << L"\",\"clientX\":" << client.x << L",\"clientY\":" << client.y << L"}";
  PostToCanvas(payload.str());
}

bool IsNativeEditableControl(HWND window);

std::wstring ShortcutBindingFromMessage(const MSG& message) {
  std::wstring key;
  if (message.wParam >= 'A' && message.wParam <= 'Z') key.assign(1, static_cast<wchar_t>(message.wParam));
  else if (message.wParam >= '0' && message.wParam <= '9') key.assign(1, static_cast<wchar_t>(message.wParam));
  else if (message.wParam >= VK_F1 && message.wParam <= VK_F12) key = L"F" + std::to_wstring(message.wParam - VK_F1 + 1);
  else if (message.wParam == VK_SPACE) key = L"Space";
  else if (message.wParam == VK_ESCAPE) key = L"Esc";
  else if (message.wParam == VK_DELETE) key = L"Delete";
  else if (message.wParam == VK_BACK) key = L"Backspace";
  else if (message.wParam == VK_RETURN) key = L"Enter";
  else if (message.wParam == VK_TAB) key = L"Tab";
  else if (message.wParam == VK_INSERT) key = L"Insert";
  else if (message.wParam == VK_PAUSE) key = L"Pause";
  else if (message.wParam == VK_SNAPSHOT) key = L"PrintScreen";
  else if (message.wParam == VK_LEFT) key = L"Left";
  else if (message.wParam == VK_RIGHT) key = L"Right";
  else if (message.wParam == VK_UP) key = L"Up";
  else if (message.wParam == VK_DOWN) key = L"Down";
  else if (message.wParam == VK_HOME) key = L"Home";
  else if (message.wParam == VK_END) key = L"End";
  else if (message.wParam == VK_PRIOR) key = L"PageUp";
  else if (message.wParam == VK_NEXT) key = L"PageDown";
  else if (message.wParam >= VK_NUMPAD0 && message.wParam <= VK_NUMPAD9) key = L"Numpad" + std::to_wstring(message.wParam - VK_NUMPAD0);
  else if (message.wParam == VK_ADD) key = L"NumpadAdd";
  else if (message.wParam == VK_SUBTRACT) key = L"NumpadSubtract";
  else if (message.wParam == VK_MULTIPLY) key = L"NumpadMultiply";
  else if (message.wParam == VK_DIVIDE) key = L"NumpadDivide";
  else if (message.wParam == VK_DECIMAL) key = L"NumpadDecimal";
  else if (message.wParam == VK_OEM_COMMA) key = L",";
  else if (message.wParam == VK_OEM_PERIOD) key = L".";
  else if (message.wParam == VK_OEM_2) key = L"/";
  else if (message.wParam == VK_OEM_1) key = L";";
  else if (message.wParam == VK_OEM_7) key = L"'";
  else if (message.wParam == VK_OEM_4) key = L"[";
  else if (message.wParam == VK_OEM_6) key = L"]";
  else if (message.wParam == VK_OEM_5) key = L"\\";
  else if (message.wParam == VK_OEM_MINUS) key = L"-";
  else if (message.wParam == VK_OEM_PLUS) key = L"=";
  else return {};
  std::wstring result;
  if (GetKeyState(VK_CONTROL) & 0x8000) result += L"Ctrl+";
  if (GetKeyState(VK_MENU) & 0x8000) result += L"Alt+";
  if (GetKeyState(VK_SHIFT) & 0x8000) result += L"Shift+";
  return result + key;
}

bool ShortcutFitsSurface(const std::wstring& id, const std::shared_ptr<NativeSurface>& owner) {
  if (id.rfind(L"file.", 0) == 0) return owner && owner->kind == L"explorer";
  if (id.rfind(L"browser.", 0) == 0) return owner && owner->kind == L"browser";
  // Clipboard editing belongs to the focused native child. In particular, do not
  // steal Ctrl+C / Ctrl+V from an HTML input inside a browser surface. The canvas
  // variants are handled by the app WebView when canvas DOM owns focus.
  if (id == L"canvas.copy" || id == L"canvas.paste") return !owner;
  return true;
}

bool IsAppGlobalShortcut(const MSG& message) {
  const std::wstring binding = ShortcutBindingFromMessage(message);
  if (binding.empty()) return false;
  constexpr std::array<const wchar_t*, 9> ids{
    L"app.settings", L"app.search", L"history.undo", L"project.save", L"project.saveAs",
    L"window.snapLeft", L"window.snapRight", L"window.snapLayout", L"window.tile"
  };
  return std::any_of(ids.begin(), ids.end(), [&](const wchar_t* id) {
    const auto entry = g_shortcutBindings.find(id);
    return entry != g_shortcutBindings.end() && entry->second == binding;
  });
}

bool ForwardConfiguredShortcut(const MSG& message, const std::shared_ptr<NativeSurface>& owner) {
  if ((message.message != WM_KEYDOWN && message.message != WM_SYSKEYDOWN) ||
      (message.lParam & (1LL << 30)) || IsNativeEditableControl(message.hwnd)) return false;
  const std::wstring binding = ShortcutBindingFromMessage(message);
  if (binding.empty()) return false;
  // A few defaults intentionally share a binding across contexts (for example
  // canvas/file Copy and canvas/file Delete). unordered_map iteration order must
  // never decide which command wins. Prefer the focused surface's own command,
  // then fall back to a global/canvas command.
  const auto tryForward = [&](bool surfaceSpecific) {
    for (const auto& entry : g_shortcutBindings) {
      const bool isSurfaceSpecific = owner &&
        ((owner->kind == L"explorer" && entry.first.rfind(L"file.", 0) == 0) ||
         (owner->kind == L"browser" && entry.first.rfind(L"browser.", 0) == 0));
      if (isSurfaceSpecific != surfaceSpecific || entry.second != binding || !ShortcutFitsSurface(entry.first, owner)) continue;
      std::wstring payload = L"{\"type\":\"native-shortcut\",\"shortcutId\":\"" + JsonEscape(entry.first) + L"\"";
      if (owner) payload += L",\"surfaceId\":\"" + JsonEscape(owner->id) + L"\"";
      PostToCanvas(payload + L"}");
      return true;
    }
    return false;
  };
  if (tryForward(true) || tryForward(false)) return true;
  return false;
}

bool IsNativeEditableControl(HWND window) {
  wchar_t className[128]{};
  for (HWND probe = window; probe; probe = GetParent(probe)) {
    if (GetClassNameW(probe, className, static_cast<int>(std::size(className))) > 0) {
      const std::wstring name(className);
      if (_wcsicmp(name.c_str(), L"Edit") == 0 || name.rfind(L"RichEdit", 0) == 0 || name.rfind(L"RICHEDIT", 0) == 0) return true;
    }
    for (const auto& surface : g_surfaces) if (surface->host == probe) return false;
  }
  return false;
}

void EndCanvasPanCapture() {
  if (!g_canvasPanCaptureWindow) return;
  POINT screenPoint{};
  GetCursorPos(&screenPoint);
  const HWND captureWindow = g_canvasPanCaptureWindow;
  const std::wstring surfaceId = std::move(g_canvasPanSurfaceId);
  g_canvasPanCaptureWindow = nullptr;
  g_canvasPanSurfaceId.clear();
  PostCanvasPan(L"end", surfaceId, screenPoint);
  if (GetCapture() == captureWindow) ReleaseCapture();
}

void UpdateSurfaceHover(const std::wstring& id) {
  if (g_hoveredSurfaceId == id) return;
  g_hoveredSurfaceId = id;
  PostToCanvas(L"{\"type\":\"native-surface-hovered\",\"surfaceId\":\"" + JsonEscape(id) + L"\"}");
}

void ApplyDarkExplorerTheme(HWND window) {
  if (!window) return;
  const BOOL enabled = SystemUsesDarkMode() ? TRUE : FALSE;
  if (g_allowDarkModeForWindow) g_allowDarkModeForWindow(window, enabled);
  DwmSetWindowAttribute(window, 20, &enabled, sizeof(enabled));
  SetWindowTheme(window, enabled ? L"DarkMode_Explorer" : L"Explorer", nullptr);
  EnumChildWindows(window, [](HWND child, LPARAM) -> BOOL {
    const BOOL enabled = SystemUsesDarkMode() ? TRUE : FALSE;
    if (g_allowDarkModeForWindow) g_allowDarkModeForWindow(child, enabled);
    SetWindowTheme(child, enabled ? L"DarkMode_Explorer" : L"Explorer", nullptr);
    return TRUE;
  }, 0);
  RedrawWindow(window, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_FRAME);
}

void ApplyExplorerVisualProperties(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || !surface->explorer) return;
  ComPtr<IVisualProperties> visuals;
  if (FAILED(surface->explorer->GetCurrentView(IID_PPV_ARGS(&visuals))) || !visuals) return;

  // 交接文档 5.0 / 22 P1-UI-2：文件视图内容区跟随 Windows 当前主题，
  // 由 Shell 自己决定配色。掌中界只切换主题名，绝不用自己的调色板
  // SetColor 覆盖，否则就成了「掌中界伪造/强制配色」。
  visuals->SetTheme(SystemUsesDarkMode() ? L"DarkMode_Explorer" : L"Explorer", nullptr);
}

void RefreshSurfaceThemes() {
  ApplyMenuTheme();
  if (g_mainWindow) {
    if (g_allowDarkModeForWindow) g_allowDarkModeForWindow(g_mainWindow, SystemUsesDarkMode() ? TRUE : FALSE);
    const BOOL dark = SystemUsesDarkMode() ? TRUE : FALSE;
    DwmSetWindowAttribute(g_mainWindow, 20, &dark, sizeof(dark));
  }
  for (const auto& surface : g_surfaces) {
    if (surface->kind != L"explorer" || !surface->host) continue;
    ApplyDarkExplorerTheme(surface->host);
    ApplyExplorerVisualProperties(surface);
  }
}

HRESULT BrowseExplorer(const std::shared_ptr<NativeSurface>& surface, const std::wstring& location) {
  if (!surface || !surface->explorer) return E_UNEXPECTED;
  // 不在解压镜像里就解除只读副本标记，避免普通目录被误拦写操作。
  SyncArchiveMirrorLocation(surface, location);
  ComPtr<IShellItem> target;
  HRESULT result = E_FAIL;
  if (location.empty() || location == L"shell:MyComputerFolder") {
    result = SHGetKnownFolderItem(FOLDERID_ComputerFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&target));
  } else {
    result = SHCreateItemFromParsingName(location.c_str(), nullptr, IID_PPV_ARGS(&target));
  }
  if (FAILED(result)) return result;
  return surface->explorer->BrowseToObject(target.Get(), SBSP_ABSOLUTE);
}

// 浏览器和文件视图都挂在自己的宿主子窗口里。有了这个宿主，才能用
// SetWindowRgn 把超出画布可视区的部分裁掉（交接文档 25）——否则原生
// 窗口只有「整个显示 / 整个隐藏」，滚出边界时会压在顶部工具栏上。
bool EnsureSurfaceHost(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface) return false;
  if (surface->host) return true;
  surface->host = CreateWindowExW(WS_EX_CONTROLPARENT, kSurfaceHostClass, L"",
    WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    surface->bounds.left, surface->bounds.top,
    std::max(1L, surface->bounds.right - surface->bounds.left),
    std::max(1L, surface->bounds.bottom - surface->bounds.top),
    g_mainWindow, nullptr, GetModuleHandleW(nullptr), surface.get());
  return surface->host != nullptr;
}

// 把画布可视区的裁剪矩形换算成宿主窗口的客户区坐标，交给 SetWindowRgn。
void ApplySurfaceClip(const std::shared_ptr<NativeSurface>& surface, int width, int height) {
  if (!surface || !surface->host) return;
  if (!surface->hasClip) { SetWindowRgn(surface->host, nullptr, TRUE); return; }
  RECT visible{};
  const RECT self{surface->bounds.left, surface->bounds.top, surface->bounds.right, surface->bounds.bottom};
  if (!IntersectRect(&visible, &self, &surface->clip)) {
    SetWindowRgn(surface->host, CreateRectRgn(0, 0, 0, 0), TRUE);
    return;
  }
  const int left = visible.left - surface->bounds.left;
  const int top = visible.top - surface->bounds.top;
  const int right = std::min<int>(width, visible.right - surface->bounds.left);
  const int bottom = std::min<int>(height, visible.bottom - surface->bounds.top);
  if (left <= 0 && top <= 0 && right >= width && bottom >= height) {
    SetWindowRgn(surface->host, nullptr, TRUE);
    return;
  }
  SetWindowRgn(surface->host, CreateRectRgn(std::max(0, left), std::max(0, top), right, bottom), TRUE);
}

bool UpdateCompositionHostRegion() {
  if (!g_compositionHost) return false;
  ++g_surfacePerfCounters.compositionRegionUpdates;
  RECT client{};
  GetClientRect(g_compositionHost, &client);
  HRGN aggregate = CreateRectRgn(0, 0, 0, 0);
  bool hasVisibleRegion = false;
  // Canvas pan/resize must disable pointer input without hiding the composed
  // browser pixels.  Keep the visible region while interaction is active and
  // let CompositionHostProc answer HTTRANSPARENT while inert; overlays still
  // remove the region entirely so app-owned menus/modals win hit testing.
  if (!g_overlayActive) {
    for (const auto& surface : g_surfaces) {
      if (!surface || !surface->compositionController || !surface->visible || surface->snapshotMode) continue;
      RECT visible = surface->bounds;
      if (surface->hasClip) {
        RECT clipped{};
        if (!IntersectRect(&clipped, &visible, &surface->clip)) continue;
        visible = clipped;
      }
      RECT inside{};
      if (!IntersectRect(&inside, &visible, &client)) continue;
      HRGN piece = CreateRectRgn(inside.left, inside.top, inside.right, inside.bottom);
      CombineRgn(aggregate, aggregate, piece, RGN_OR);
      DeleteObject(piece);
      hasVisibleRegion = true;
    }
  }
  // SetWindowRgn takes ownership only on success.
  if (!SetWindowRgn(g_compositionHost, aggregate, TRUE)) DeleteObject(aggregate);
  return hasVisibleRegion;
}

void SyncSurfaceGeometry(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface) return;
  // 全自绘文件列表启用后，IExplorerBrowser 只是一台隐藏的 Shell 语义机：
  // 它继续提供历史、系统选择、IContextMenu 与 IFileOperation，但永远不参与视觉合成。
  if (surface->kind == L"explorer" && surface->semanticOnly) {
    if (surface->host) {
      ++g_surfacePerfCounters.setWindowPosCalls;
      SetWindowPos(surface->host, nullptr, -32000, -32000, 2, 2,
        SWP_NOACTIVATE | SWP_NOZORDER | SWP_HIDEWINDOW);
      if (surface->explorer) {
        RECT hiddenView{0, 0, 2, 2};
        surface->explorer->SetRect(nullptr, hiddenView);
      }
    }
    return;
  }
  const int width = std::max(1L, surface->bounds.right - surface->bounds.left);
  const int height = std::max(1L, surface->bounds.bottom - surface->bounds.top);
  const bool show = !g_overlayActive && !surface->snapshotMode && surface->visible && width >= 80 && height >= 60;
  if (surface->kind == L"browser" && surface->compositionController && surface->compositionVisual) {
    RECT bounds{0, 0, width, height};
    if (surface->controller) {
      surface->controller->put_Bounds(bounds);
      surface->controller->put_IsVisible(show ? TRUE : FALSE);
      const double zoom = std::clamp(surface->scale, 0.25, 4.0);
      if (std::abs(zoom - surface->appliedZoom) > 0.005) {
        surface->controller->put_ZoomFactor(zoom);
        surface->appliedZoom = zoom;
      }
    }
    surface->compositionVisual->SetOffsetX(static_cast<float>(surface->bounds.left));
    surface->compositionVisual->SetOffsetY(static_cast<float>(surface->bounds.top));
    if (surface->hasClip && g_compositionDevice) {
      if (!surface->compositionClip) g_compositionDevice->CreateRectangleClip(&surface->compositionClip);
      if (surface->compositionClip) {
        surface->compositionClip->SetLeft(static_cast<float>(std::max(0L, surface->clip.left - surface->bounds.left)));
        surface->compositionClip->SetTop(static_cast<float>(std::max(0L, surface->clip.top - surface->bounds.top)));
        surface->compositionClip->SetRight(static_cast<float>(std::min<long>(width, surface->clip.right - surface->bounds.left)));
        surface->compositionClip->SetBottom(static_cast<float>(std::min<long>(height, surface->clip.bottom - surface->bounds.top)));
        surface->compositionVisual->SetClip(surface->compositionClip.Get());
      }
    } else {
      surface->compositionVisual->SetClip(nullptr);
    }
    ComPtr<ICoreWebView2_8> webView8;
    if (SUCCEEDED(surface->webView.As(&webView8))) {
      // 画中画期间不算「不可见」：卡片是用户主动让位的，声音必须继续。
      const bool pip = IsPipSurface(surface->id);
      const bool muted = !pip && (!show || surface->id != g_audibleSurfaceId);
      webView8->put_IsMuted(muted ? TRUE : FALSE);
      const ULONGLONG nowTick = GetTickCount64();
      if (surface->appliedMuted != muted) {
        surface->appliedMuted = muted;
        WriteLifecycleLog((L"audio: " + surface->id + (muted ? L" muted=1" : L" muted=0") +
          (pip ? L" (pip)" : L"")).c_str());
        if (pip) g_lastPipAudioLogAt = nowTick;
      } else if (pip && nowTick - g_lastPipAudioLogAt > 3000) {
        // 画中画期间周期报一次「这张卡没被静音」，便于验证/排查（hidden 但必须继续出声）。
        g_lastPipAudioLogAt = nowTick;
        WriteLifecycleLog((L"audio: " + surface->id + L" muted=0 (pip, hidden but audible)").c_str());
      }
    }
    if (g_compositionDevice) g_compositionDevice->Commit();
    const bool hasCompositionRegion = UpdateCompositionHostRegion();
    // 短暂的画布拖动/缩放可以让 CompositionHostProc 返回 HTTRANSPARENT：
    // 此时指针状态由掌中界主 WebView 持有，越界松手与 Alt+Tab 都有全局兜底。
    // 模态浮层不同，它必须长期、无条件接管命中；跨线程把子 HWND 命中转给
    // WebView2 渲染器并不可靠，所以 overlay 仍要隐藏 composition host。
    if (g_compositionHost) {
      ++g_surfacePerfCounters.setWindowPosCalls;
      SetWindowPos(g_compositionHost, HWND_TOP, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE |
        ((!g_overlayActive && hasCompositionRegion) ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    }
    return;
  }
  if (!surface->host) return;
  // 这里只管位置和显隐，不碰 z-order：谁在上谁在下由 RestackSurfaces 按画布的
  // 叠放顺序统一决定。以前每次几何同步都传 HWND_TOP，等于谁最后同步谁跑到最
  // 上面，于是元素会莫名其妙压到别的窗口上方（交接文档 §25、§31.2）。
  ++g_surfacePerfCounters.setWindowPosCalls;
  SetWindowPos(surface->host, nullptr, surface->bounds.left, surface->bounds.top, width, height,
    SWP_NOACTIVATE | SWP_NOZORDER | (show ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
  ApplySurfaceClip(surface, width, height);
  if (surface->kind == L"explorer") {
    if (surface->explorer) {
      RECT view{0, 0, width, height};
      surface->explorer->SetRect(nullptr, view);
      // 主题只在创建时和收到 WM_THEMECHANGED / WM_SETTINGCHANGE 时应用。
      // 放在这里会导致拖动窗口的每一帧都对整棵 Shell 子树重设主题并全量
      // 重绘（EnumChildWindows + RDW_ALLCHILDREN），肉眼可见的卡顿与闪烁。
    }
  } else if (surface->kind == L"shellview" && surface->explorer) {
    RECT view{0, 0, width, height};
    surface->explorer->SetRect(nullptr, view);
  } else if (surface->controller) {
    RECT bounds{0, 0, width, height};
    surface->controller->put_Bounds(bounds);
    surface->controller->put_IsVisible(show ? TRUE : FALSE);
    // 交接文档 25：网页用 ZoomFactor 跟随画布缩放，否则画布缩小后窗口变小
    // 但网页仍按 100% 渲染，用户看到的是网页的一小块而不是缩小的网页。
    const double zoom = std::clamp(surface->scale, 0.25, 4.0);
    if (std::abs(zoom - surface->appliedZoom) > 0.005) {
      surface->controller->put_ZoomFactor(zoom);
      surface->appliedZoom = zoom;
    }
    ComPtr<ICoreWebView2_8> webView8;
    if (SUCCEEDED(surface->webView.As(&webView8))) {
      // 画中画期间不算「不可见」：卡片是用户主动让位的，声音必须继续。
      const bool pip = IsPipSurface(surface->id);
      const bool muted = !pip && (!show || surface->id != g_audibleSurfaceId);
      webView8->put_IsMuted(muted ? TRUE : FALSE);
      const ULONGLONG nowTick = GetTickCount64();
      if (surface->appliedMuted != muted) {
        surface->appliedMuted = muted;
        WriteLifecycleLog((L"audio: " + surface->id + (muted ? L" muted=1" : L" muted=0") +
          (pip ? L" (pip)" : L"")).c_str());
        if (pip) g_lastPipAudioLogAt = nowTick;
      } else if (pip && nowTick - g_lastPipAudioLogAt > 3000) {
        // 画中画期间周期报一次「这张卡没被静音」，便于验证/排查（hidden 但必须继续出声）。
        g_lastPipAudioLogAt = nowTick;
        WriteLifecycleLog((L"audio: " + surface->id + L" muted=0 (pip, hidden but audible)").c_str());
      }
    }
  }
}

// 原生子窗口整体浮在承载掌中界 UI 的 app WebView2 之上（否则只会看到卡片里的
// 「正在连接…」占位文字），它们彼此之间则严格按画布叠放顺序排列：order 小的在
// 下，大的在上。order 由 Web 层按 DOM 绘制顺序给出，置顶层天然排在后面。
// 交接文档 §25 的快照策略：画布缩得比较小的时候，Shell 文件视图没有任何缩放
// API，内容会一直按系统 DPI 渲染，于是框变小了字还是原来那么大。这时候把窗口
// 换成一张位图，交给 Web 层当普通图片等比缩放，观感才对得上。
std::string Base64Encode(const unsigned char* data, size_t size) {
  static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  for (size_t index = 0; index < size; index += 3) {
    const unsigned int chunk = (data[index] << 16)
      | ((index + 1 < size ? data[index + 1] : 0) << 8)
      | (index + 2 < size ? data[index + 2] : 0);
    out.push_back(table[(chunk >> 18) & 63]);
    out.push_back(table[(chunk >> 12) & 63]);
    out.push_back(index + 1 < size ? table[(chunk >> 6) & 63] : '=');
    out.push_back(index + 2 < size ? table[chunk & 63] : '=');
  }
  return out;
}

std::vector<unsigned char> EncodePng(IWICImagingFactory* factory, IWICBitmapSource* source,
                                     UINT width, UINT height) {
  if (!factory || !source || !width || !height) return {};
  ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) || !stream) return {};
  ComPtr<IWICBitmapEncoder> encoder;
  if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder)) || !encoder ||
      FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return {};
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  if (FAILED(encoder->CreateNewFrame(&frame, &properties)) || !frame ||
      FAILED(frame->Initialize(properties.Get())) || FAILED(frame->SetSize(width, height))) return {};
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  if (FAILED(frame->SetPixelFormat(&format)) || FAILED(frame->WriteSource(source, nullptr)) ||
      FAILED(frame->Commit()) || FAILED(encoder->Commit())) return {};
  STATSTG stat{};
  if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) || stat.cbSize.QuadPart == 0 ||
      stat.cbSize.QuadPart > static_cast<ULONGLONG>(std::numeric_limits<size_t>::max())) return {};
  HGLOBAL memory = nullptr;
  if (FAILED(GetHGlobalFromStream(stream.Get(), &memory)) || !memory) return {};
  const auto* bytes = static_cast<const unsigned char*>(GlobalLock(memory));
  if (!bytes) return {};
  std::vector<unsigned char> result(bytes, bytes + static_cast<size_t>(stat.cbSize.QuadPart));
  GlobalUnlock(memory);
  return result;
}

// Shell decides which icon/thumbnail represents a file. The self-drawn UI only
// converts that HBITMAP into a browser-safe PNG. BI_RGB BMP leaves its fourth byte
// undefined, which Chromium treats as opaque and turns transparent pixels black.
std::wstring BitmapPngDataUrl(HBITMAP bitmap, bool downscaleLarge = true, bool repairOpaqueBlackBackdrop = false) {
  if (!bitmap) return {};
  BITMAP object{};
  if (!GetObjectW(bitmap, sizeof(object), &object) || object.bmWidth <= 0 || object.bmHeight == 0) return {};
  const int width = object.bmWidth;
  const int height = std::abs(object.bmHeight);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  const size_t pixelBytes = static_cast<size_t>(width) * height * 4;
  std::vector<unsigned char> pixels(pixelBytes);
  HDC dc = GetDC(nullptr);
  const int rows = GetDIBits(dc, bitmap, 0, height, pixels.data(), &info, DIB_RGB_COLORS);
  ReleaseDC(nullptr, dc);
  if (rows != height) return {};

  for (size_t index = 0; index < pixelBytes; index += 4) {
    unsigned char& blue = pixels[index];
    unsigned char& green = pixels[index + 1];
    unsigned char& red = pixels[index + 2];
    unsigned char& alpha = pixels[index + 3];
    if (alpha == 0) {
      // Shell/GDI sometimes leaves alpha padding at zero for otherwise valid
      // opaque pixels. Repair only those pixels; true transparent black stays
      // transparent instead of turning the whole icon into a black rectangle.
      if (blue != 0 || green != 0 || red != 0) alpha = 255;
      continue;
    }
    if (alpha == 255 || blue > alpha || green > alpha || red > alpha) continue;
    // This pixel is consistent with premultiplied alpha. Convert it to straight
    // alpha locally; a neighboring straight-alpha pixel no longer decides the
    // format for the entire bitmap and cannot create a dark block elsewhere.
    blue = static_cast<unsigned char>(std::min(255u, (static_cast<unsigned int>(blue) * 255u + alpha / 2u) / alpha));
    green = static_cast<unsigned char>(std::min(255u, (static_cast<unsigned int>(green) * 255u + alpha / 2u) / alpha));
    red = static_cast<unsigned char>(std::min(255u, (static_cast<unsigned int>(red) * 255u + alpha / 2u) / alpha));
  }

  // —— 不透明黑底复原（Shell 缩略图的已知坏形态）——
  // 症状：Shell 对「没有内容预览的文件夹」返回缩略图时，会把图形渲染到不透明
  // 纯黑的背景上（alpha 全 255），前端显示为黑块；同一批里「有预览」的文件夹
  // 完全正常（黑背景 alpha=0）。按「四角为不透明纯黑 + 纯黑占比 ≥ 30%」识别这类
  // 图，并按加法模型把黑色成分解码回透明度：显示色 RGB = 前景 F × 覆盖度 α，
  // 还原 α = max(R,G,B)，F = RGB / α（纯黑 → 透明；边缘抗锯齿也随之复原）。
  // 阈值取 ≤6 的精确黑：limited-range 视频帧的黑是 (16,16,16) 级，不会误伤。
  if (repairOpaqueBlackBackdrop) {
    const auto isOpaqueBlack = [&](size_t index) {
      return pixels[index + 3] >= 250 && pixels[index] <= 6 && pixels[index + 1] <= 6 && pixels[index + 2] <= 6;
    };
    const auto cornerBlack = [&](int x, int y) { return isOpaqueBlack((static_cast<size_t>(y) * width + x) * 4); };
    const bool cornersBlack = cornerBlack(1, 1) && cornerBlack(width - 2, 1) &&
      cornerBlack(1, height - 2) && cornerBlack(width - 2, height - 2);
    if (cornersBlack) {
      size_t blackOpaque = 0;
      for (size_t index = 0; index < pixelBytes; index += 4) {
        if (isOpaqueBlack(index)) ++blackOpaque;
      }
      if (blackOpaque * 10 >= static_cast<size_t>(width) * height * 3) {  // 纯黑占比 ≥ 30%
        for (size_t index = 0; index < pixelBytes; index += 4) {
          unsigned char& blue = pixels[index];
          unsigned char& green = pixels[index + 1];
          unsigned char& red = pixels[index + 2];
          unsigned char& alpha = pixels[index + 3];
          if (alpha < 250) continue;
          const unsigned char strongest = std::max({red, green, blue});
          if (strongest <= 6) { alpha = 0; continue; }
          if (strongest >= 250) continue;
          alpha = strongest;
          red = static_cast<unsigned char>(std::min(255u, (static_cast<unsigned int>(red) * 255u + strongest / 2u) / strongest));
          green = static_cast<unsigned char>(std::min(255u, (static_cast<unsigned int>(green) * 255u + strongest / 2u) / strongest));
          blue = static_cast<unsigned char>(std::min(255u, (static_cast<unsigned int>(blue) * 255u + strongest / 2u) / strongest));
        }
      }
    }
  }

  ComPtr<IWICImagingFactory> factory;
  HRESULT result = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER,
                                    IID_PPV_ARGS(&factory));
  if (FAILED(result)) result = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                                IID_PPV_ARGS(&factory));
  if (FAILED(result) || !factory) return {};
  ComPtr<IWICBitmap> source;
  const WICPixelFormatGUID& sourceFormat = GUID_WICPixelFormat32bppBGRA;
  const UINT stride = static_cast<UINT>(width * 4);
  if (FAILED(factory->CreateBitmapFromMemory(static_cast<UINT>(width), static_cast<UINT>(height),
      sourceFormat, stride, static_cast<UINT>(pixelBytes), pixels.data(), &source)) || !source) return {};

  std::vector<unsigned char> png = EncodePng(factory.Get(), source.Get(), static_cast<UINT>(width), static_cast<UINT>(height));
  std::string encoded = png.empty() ? std::string{} : Base64Encode(png.data(), png.size());
  if (downscaleLarge && encoded.size() > 200 * 1024 && width > 16 && height > 16) {
    OutputDebugStringW((L"掌中界: PNG data URL exceeds 200KB; downscaling one tier (" +
      std::to_wstring(width) + L"x" + std::to_wstring(height) + L").\n").c_str());
    ComPtr<IWICBitmapScaler> scaler;
    const UINT smallerWidth = std::max<UINT>(16, static_cast<UINT>(width * 3 / 4));
    const UINT smallerHeight = std::max<UINT>(16, static_cast<UINT>(height * 3 / 4));
    if (SUCCEEDED(factory->CreateBitmapScaler(&scaler)) && scaler &&
        SUCCEEDED(scaler->Initialize(source.Get(), smallerWidth, smallerHeight, WICBitmapInterpolationModeFant))) {
      png = EncodePng(factory.Get(), scaler.Get(), smallerWidth, smallerHeight);
      encoded = png.empty() ? std::string{} : Base64Encode(png.data(), png.size());
    }
  }
  return encoded.empty() ? std::wstring{} : L"data:image/png;base64," + std::wstring(encoded.begin(), encoded.end());
}

std::vector<unsigned char> Base64Decode(const std::wstring& encoded) {
  static const std::wstring alphabet = L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<unsigned char> output;
  int value = 0;
  int bits = -8;
  for (const wchar_t ch : encoded) {
    if (iswspace(ch)) continue;
    if (ch == L'=') break;
    const size_t index = alphabet.find(ch);
    if (index == std::wstring::npos) continue;
    value = (value << 6) | static_cast<int>(index);
    bits += 6;
    if (bits >= 0) {
      output.push_back(static_cast<unsigned char>((value >> bits) & 0xFF));
      bits -= 8;
    }
  }
  return output;
}

std::wstring DataUrlMimeForPath(const std::filesystem::path& path) {
  std::wstring extension = path.extension().wstring();
  std::transform(extension.begin(), extension.end(), extension.begin(), ::towlower);
  if (extension == L".jpg" || extension == L".jpeg") return L"image/jpeg";
  if (extension == L".gif") return L"image/gif";
  if (extension == L".webp") return L"image/webp";
  if (extension == L".bmp") return L"image/bmp";
  if (extension == L".svg") return L"image/svg+xml";
  return L"image/png";
}

bool SafeProjectChild(const std::filesystem::path& root, const std::wstring& relative,
                      std::filesystem::path& output, std::wstring* failureReason = nullptr) {
  if (failureReason) failureReason->clear();
  if (relative.empty()) return false;
  const std::filesystem::path rel(relative);
  if (rel.is_absolute()) return false;
  const auto normalizedRoot = std::filesystem::absolute(root).lexically_normal();
  const auto candidate = (normalizedRoot / rel).lexically_normal();
  auto rootIt = normalizedRoot.begin();
  auto candidateIt = candidate.begin();
  for (; rootIt != normalizedRoot.end(); ++rootIt, ++candidateIt) {
    if (candidateIt == candidate.end() || _wcsicmp(rootIt->c_str(), candidateIt->c_str()) != 0) return false;
  }

  // 词法前缀只能挡住 .. / 盘符相对路径。共享 .zzj 里还可能把 assets
  // 换成 junction / symlink，让看似位于项目内的路径实际读写到项目外。
  // 逐级拒绝项目根目录之下的 reparse point，再用 weakly_canonical 对已经
  // 存在的祖先做一次最终路径边界检查；根目录本身可以位于用户选择的 junction 中。
  std::filesystem::path walked = normalizedRoot;
  for (const auto& part : rel.lexically_normal()) {
    if (part == L".") continue;
    walked /= part;
    const DWORD attributes = GetFileAttributesW(walked.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  }
  std::error_code rootError, candidateError;
  const auto canonicalRoot = std::filesystem::weakly_canonical(normalizedRoot, rootError);
  const auto canonicalCandidate = std::filesystem::weakly_canonical(candidate, candidateError);
  if (rootError || candidateError) {
    if (failureReason) {
      *failureReason = L"项目路径当前无法解析（网络位置可能离线或驱动器未就绪），请恢复连接后重试";
    }
    return false;
  }
  rootIt = canonicalRoot.begin();
  candidateIt = canonicalCandidate.begin();
  for (; rootIt != canonicalRoot.end(); ++rootIt, ++candidateIt) {
    if (candidateIt == canonicalCandidate.end() || _wcsicmp(rootIt->c_str(), candidateIt->c_str()) != 0) return false;
  }
  output = candidate;
  return true;
}

void CollectJsonMemberStrings(const JsonValue& value, const wchar_t* key, std::vector<std::wstring>& output) {
  if (value.kind == JsonValue::Kind::Object) {
    for (const auto& member : value.members) {
      if (member.first == key && member.second.kind == JsonValue::Kind::String) output.push_back(member.second.text);
      CollectJsonMemberStrings(member.second, key, output);
    }
  } else if (value.kind == JsonValue::Kind::Array) {
    for (const auto& item : value.items) CollectJsonMemberStrings(item, key, output);
  }
}

bool BuildProjectAssetsJson(const std::filesystem::path& projectRoot, const std::wstring& projectJson,
                            std::wstring& assetsJson, std::wstring* errorText = nullptr) {
  size_t at = 0;
  const JsonValue parsed = ParseJsonValue(projectJson, at);
  std::vector<std::wstring> paths;
  CollectJsonMemberStrings(parsed, L"assetPath", paths);
  std::unordered_set<std::wstring> seen;
  std::wstring json = L"[";
  bool first = true;
  for (const auto& relative : paths) {
    std::wstring key = relative;
    std::transform(key.begin(), key.end(), key.begin(), ::towlower);
    if (!seen.insert(key).second) continue;
    std::filesystem::path assetPath;
    // assetPath 是项目文件提供的不可信输入。发现越界或 reparse point 时拒绝
    // 整个项目，不能静默跳过后再让用户误以为项目完整打开。
    std::wstring pathFailure;
    if (!SafeProjectChild(projectRoot, relative, assetPath, &pathFailure)) {
      if (errorText) *errorText = pathFailure.empty() ? L"项目素材路径越界或包含不安全的重解析点" : pathFailure;
      return false;
    }
    std::ifstream stream(assetPath, std::ios::binary);
    if (!stream) continue;
    const std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    const std::string encoded = Base64Encode(bytes.data(), bytes.size());
    if (!first) json += L",";
    first = false;
    json += L"{\"path\":\"" + JsonEscape(relative) + L"\",\"dataUrl\":\"data:" +
      DataUrlMimeForPath(assetPath) + L";base64," + std::wstring(encoded.begin(), encoded.end()) + L"\"}";
  }
  assetsJson = json + L"]";
  return true;
}

void SaveRecentProjects() {
  std::wstring text;
  for (const auto& path : g_recentProjects) text += path + L"\n";
  WriteUtf8FileAtomic(std::filesystem::path(g_dataFolder) / L"recent-projects.txt", text);
}

void RememberRecentProject(const std::wstring& path) {
  if (path.empty()) return;
  g_recentProjects.erase(std::remove_if(g_recentProjects.begin(), g_recentProjects.end(), [&](const std::wstring& current) {
    return _wcsicmp(current.c_str(), path.c_str()) == 0;
  }), g_recentProjects.end());
  g_recentProjects.insert(g_recentProjects.begin(), path);
  if (g_recentProjects.size() > 12) g_recentProjects.resize(12);
  SaveRecentProjects();
}

void LoadRecentProjects() {
  g_recentProjects.clear();
  std::wstring text;
  if (!ReadUtf8File(std::filesystem::path(g_dataFolder) / L"recent-projects.txt", text)) return;
  std::wstringstream lines(text);
  std::wstring line;
  while (std::getline(lines, line) && g_recentProjects.size() < 12) {
    while (!line.empty() && (line.back() == L'\r' || line.back() == L'\n')) line.pop_back();
    if (!line.empty() && std::filesystem::exists(line)) g_recentProjects.push_back(line);
  }
}

void RemoveTreeBestEffort(const std::filesystem::path& root) {
  std::error_code error;
  if (!std::filesystem::exists(root, error)) return;
  for (std::filesystem::recursive_directory_iterator iterator(root,
         std::filesystem::directory_options::skip_permission_denied, error), end;
       !error && iterator != end; iterator.increment(error)) {
    SetFileAttributesW(iterator->path().c_str(), FILE_ATTRIBUTE_NORMAL);
  }
  error.clear();
  SetFileAttributesW(root.c_str(), FILE_ATTRIBUTE_NORMAL);
  std::filesystem::remove_all(root, error);
}

std::filesystem::path ImportedProjectsRoot() {
  return std::filesystem::path(g_dataFolder) / L"Imported";
}

bool IsImportedProjectRoot(const std::filesystem::path& root) {
  return !root.empty() && SamePath(root.parent_path(), ImportedProjectsRoot());
}

void ReleaseCurrentPackageLock() {
  if (g_currentPackageLock != INVALID_HANDLE_VALUE) {
    CloseHandle(g_currentPackageLock);
    g_currentPackageLock = INVALID_HANDLE_VALUE;
  }
}

void SetCurrentPackageRoot(const std::wstring& root) {
  if (_wcsicmp(g_currentPackageRoot.c_str(), root.c_str()) == 0 &&
      (root.empty() || g_currentPackageLock != INVALID_HANDLE_VALUE ||
       !IsImportedProjectRoot(std::filesystem::path(root)))) return;
  ReleaseCurrentPackageLock();
  g_currentPackageRoot = root;
  if (root.empty() || !IsImportedProjectRoot(std::filesystem::path(root))) return;
  const auto lockPath = std::filesystem::path(root) / L".zzj.lock";
  g_currentPackageLock = CreateFileW(lockPath.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE,
    FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
    FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
}

bool ImportedProjectIsLocked(const std::filesystem::path& root) {
  if (!g_currentPackageRoot.empty() && SamePath(root, g_currentPackageRoot)) return true;
  const auto lockPath = root / L".zzj.lock";
  std::error_code error;
  if (!std::filesystem::exists(lockPath, error)) return false;
  HANDLE probe = CreateFileW(lockPath.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL, nullptr);
  if (probe == INVALID_HANDLE_VALUE) return true;
  CloseHandle(probe);
  std::filesystem::remove(lockPath, error);
  return false;
}

void CleanupImportedProjects() {
  const std::filesystem::path imported = ImportedProjectsRoot();
  std::error_code error;
  if (!std::filesystem::is_directory(imported, error)) return;
  std::vector<std::filesystem::directory_entry> projects;
  for (std::filesystem::directory_iterator iterator(imported, error), end; !error && iterator != end; iterator.increment(error)) {
    if (iterator->is_directory(error) && !error) projects.push_back(*iterator);
    else error.clear();
  }
  std::sort(projects.begin(), projects.end(), [](const auto& left, const auto& right) {
    std::error_code leftError, rightError;
    return left.last_write_time(leftError) > right.last_write_time(rightError);
  });
  const auto cutoff = std::filesystem::file_time_type::clock::now() - std::chrono::hours(24 * 30);
  for (size_t index = 0; index < projects.size(); ++index) {
    std::error_code timeError;
    const auto modified = projects[index].last_write_time(timeError);
    if ((index >= 12 || (!timeError && modified < cutoff)) &&
        !ImportedProjectIsLocked(projects[index].path())) {
      RemoveTreeBestEffort(projects[index].path());
    }
  }
}

void SendRecentProjects() {
  std::wstring json = L"{\"type\":\"native-project-recents\",\"recents\":[";
  for (size_t index = 0; index < g_recentProjects.size(); ++index) {
    if (index) json += L",";
    json += L"\"" + JsonEscape(g_recentProjects[index]) + L"\"";
  }
  PostToCanvas(json + L"]}");
}

std::filesystem::path SnapshotPath() {
  return std::filesystem::path(g_dataFolder) / L"Session" / L"snapshot.json";
}

std::filesystem::path RecoveryProjectRoot() {
  return std::filesystem::path(g_dataFolder) / L"Session" / L"Recovery.zzj";
}

void CleanupUnreferencedAssets(const std::filesystem::path& projectRoot,
                               const std::unordered_set<std::wstring>& expectedAssets);

bool WriteRecoveryAsset(const std::wstring& relative, const std::wstring& dataUrl) {
  const size_t comma = dataUrl.find(L',');
  if (comma == std::wstring::npos) return false;
  std::filesystem::path destination;
  const auto root = RecoveryProjectRoot();
  if (!SafeProjectChild(root, relative, destination)) return false;
  std::error_code error;
  std::filesystem::create_directories(destination.parent_path(), error);
  if (error) return false;
  const auto bytes = Base64Decode(dataUrl.substr(comma + 1));
  std::ofstream stream(destination, std::ios::binary | std::ios::trunc);
  if (!stream) return false;
  stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  return static_cast<bool>(stream);
}

void WriteSessionSnapshot(const std::wstring& sessionJson, bool dirty) {
  if (sessionJson.empty()) return;
  const std::wstring envelope = L"{\"version\":1,\"abandoned\":false,\"dirty\":" +
    std::wstring(dirty ? L"true" : L"false") + L",\"projectPath\":\"" +
    JsonEscape(g_currentProjectPath) + L"\",\"packageRoot\":\"" + JsonEscape(g_currentPackageRoot) +
    L"\",\"sessionJson\":\"" + JsonEscape(sessionJson) + L"\"}";
  if (!WriteUtf8FileAtomic(SnapshotPath(), envelope)) return;
  std::vector<std::wstring> paths;
  size_t at = 0;
  CollectJsonMemberStrings(ParseJsonValue(sessionJson, at), L"assetPath", paths);
  std::unordered_set<std::wstring> expected;
  for (auto& path : paths) {
    path = std::filesystem::path(path).lexically_normal().generic_wstring();
    std::transform(path.begin(), path.end(), path.begin(), ::towlower);
    expected.insert(path);
  }
  CleanupUnreferencedAssets(RecoveryProjectRoot(), expected);
}

void AbandonSessionSnapshot() {
  WriteUtf8FileAtomic(SnapshotPath(), L"{\"version\":1,\"abandoned\":true}");
  RemoveTreeBestEffort(RecoveryProjectRoot());
}

bool SendSessionSnapshotIfAvailable() {
  std::wstring envelope;
  if (!ReadUtf8File(SnapshotPath(), envelope) || JsonBoolValue(envelope, L"abandoned", true)) return false;
  const std::wstring sessionJson = JsonStringValue(envelope, L"sessionJson");
  if (sessionJson.empty()) return false;
  const std::wstring projectPath = JsonStringValue(envelope, L"projectPath");
  const std::wstring previousPackageRoot = JsonStringValue(envelope, L"packageRoot");
  std::wstring restoredPackageRoot = previousPackageRoot;
  const std::filesystem::path projectFile(projectPath);
  std::error_code projectError;
  if (!projectPath.empty() &&
      _wcsicmp(projectFile.extension().c_str(), L".zzj") == 0 &&
      std::filesystem::is_regular_file(projectFile, projectError) && !projectError) {
    std::filesystem::path extractedRoot;
    std::wstring extractionError;
    if (ExtractProjectArchive(projectFile, extractedRoot, extractionError)) {
      restoredPackageRoot = extractedRoot.wstring();
    }
  }
  std::wstring assetsJson;
  std::wstring assetError;
  if (!BuildProjectAssetsJson(RecoveryProjectRoot(), sessionJson, assetsJson, &assetError)) {
    if (assetError.empty()) assetError = L"检测到恢复数据，但其中的素材路径无效或暂时不可读取；原快照仍保留，可稍后重试";
    PostToCanvas(L"{\"type\":\"native-session-error\",\"error\":\"" + JsonEscape(assetError) + L"\"}");
    return false;
  }
  g_pendingRestoreProjectPath = projectPath;
  g_pendingRestorePackageRoot = restoredPackageRoot;
  g_restoreDecisionPending = true;
  PostToCanvas(L"{\"type\":\"native-session-available\",\"dirty\":" +
    std::wstring(JsonBoolValue(envelope, L"dirty", true) ? L"true" : L"false") +
    L",\"projectPath\":\"" + JsonEscape(projectPath) +
    L"\",\"packageRoot\":\"" + JsonEscape(restoredPackageRoot) +
    L"\",\"previousPackageRoot\":\"" + JsonEscape(previousPackageRoot) +
    L"\",\"projectJson\":\"" + JsonEscape(sessionJson) + L"\",\"assets\":" + assetsJson + L"}");
  return true;
}

void DecorateProjectDirectory(const std::filesystem::path& projectRoot) {
  // .zzj 是目录工程包，Windows 不会把普通扩展名关联当作文件夹的默认动词。
  // 用 Shell 官方支持的 DirectoryClass 标记，让安装器注册的 ProgID 接管双击；
  // 标记失败不影响项目数据本身的保存或读取。
  const std::filesystem::path desktopIni = projectRoot / L"desktop.ini";
  const DWORD oldIniAttributes = GetFileAttributesW(desktopIni.c_str());
  if (oldIniAttributes != INVALID_FILE_ATTRIBUTES) {
    SetFileAttributesW(desktopIni.c_str(), oldIniAttributes & ~(FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM));
  }
  if (!WriteUtf8FileAtomic(desktopIni,
      L"[.ShellClassInfo]\r\nDirectoryClass=ZhangZhongJie.Project\r\n")) return;
  SetFileAttributesW(desktopIni.c_str(), FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_ARCHIVE);
  const DWORD folderAttributes = GetFileAttributesW(projectRoot.c_str());
  if (folderAttributes != INVALID_FILE_ATTRIBUTES) {
    // DirectoryClass 只需要 SYSTEM 或 READONLY 之一。SYSTEM 不会让普通工具把整个
    // 项目误判成只读；顺便清掉旧版本留下的 READONLY，已再次保存的历史项目也能修复。
    SetFileAttributesW(projectRoot.c_str(),
      (folderAttributes & ~FILE_ATTRIBUTE_READONLY) | FILE_ATTRIBUTE_SYSTEM);
  }
}

bool SamePath(const std::filesystem::path& left, const std::filesystem::path& right) {
  if (left.empty() || right.empty()) return false;
  std::error_code leftError, rightError;
  auto normalizedLeft = std::filesystem::weakly_canonical(left, leftError);
  auto normalizedRight = std::filesystem::weakly_canonical(right, rightError);
  if (leftError) normalizedLeft = std::filesystem::absolute(left).lexically_normal();
  if (rightError) normalizedRight = std::filesystem::absolute(right).lexically_normal();
  return _wcsicmp(normalizedLeft.c_str(), normalizedRight.c_str()) == 0;
}

void CleanupUnreferencedAssets(const std::filesystem::path& projectRoot,
                               const std::unordered_set<std::wstring>& expectedAssets) {
  const std::filesystem::path assetsRoot = projectRoot / L"assets";
  std::error_code error;
  if (!std::filesystem::is_directory(assetsRoot, error)) return;
  std::vector<std::filesystem::path> directories;
  const auto options = std::filesystem::directory_options::skip_permission_denied;
  for (std::filesystem::recursive_directory_iterator iterator(assetsRoot, options, error), end;
       !error && iterator != end; iterator.increment(error)) {
    if (iterator->is_directory(error)) { directories.push_back(iterator->path()); continue; }
    if (error) break;
    const auto relative = std::filesystem::relative(iterator->path(), projectRoot, error).generic_wstring();
    if (error) break;
    std::wstring key = relative;
    std::transform(key.begin(), key.end(), key.begin(), ::towlower);
    if (!expectedAssets.contains(key)) std::filesystem::remove(iterator->path(), error);
    if (error) break;
  }
  std::sort(directories.begin(), directories.end(), [](const auto& left, const auto& right) {
    return std::distance(left.begin(), left.end()) > std::distance(right.begin(), right.end());
  });
  for (const auto& directory : directories) { error.clear(); std::filesystem::remove(directory, error); }
}

struct ZipEntrySource {
  std::string name;
  std::filesystem::path diskPath;
  std::vector<unsigned char> memory;
  bool directory = false;
  uint32_t crc = 0;
  uint32_t size = 0;
  uint32_t localOffset = 0;
  uint16_t modifiedTime = 0;
  uint16_t modifiedDate = 0;
};

void WriteZip16(std::ostream& stream, uint16_t value) {
  const std::array<unsigned char, 2> bytes{
    static_cast<unsigned char>(value & 0xff), static_cast<unsigned char>((value >> 8) & 0xff)};
  stream.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

void WriteZip32(std::ostream& stream, uint32_t value) {
  const std::array<unsigned char, 4> bytes{
    static_cast<unsigned char>(value & 0xff), static_cast<unsigned char>((value >> 8) & 0xff),
    static_cast<unsigned char>((value >> 16) & 0xff), static_cast<unsigned char>((value >> 24) & 0xff)};
  stream.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

bool ReadZip16(std::istream& stream, uint16_t& value) {
  std::array<unsigned char, 2> bytes{};
  if (!stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) return false;
  value = static_cast<uint16_t>(bytes[0] | (bytes[1] << 8));
  return true;
}

bool ReadZip32(std::istream& stream, uint32_t& value) {
  std::array<unsigned char, 4> bytes{};
  if (!stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size())) return false;
  value = static_cast<uint32_t>(bytes[0]) | (static_cast<uint32_t>(bytes[1]) << 8) |
    (static_cast<uint32_t>(bytes[2]) << 16) | (static_cast<uint32_t>(bytes[3]) << 24);
  return true;
}

uint16_t Zip16At(const unsigned char* bytes) {
  return static_cast<uint16_t>(bytes[0] | (static_cast<uint16_t>(bytes[1]) << 8));
}

uint32_t Zip32At(const unsigned char* bytes) {
  return static_cast<uint32_t>(bytes[0]) | (static_cast<uint32_t>(bytes[1]) << 8) |
    (static_cast<uint32_t>(bytes[2]) << 16) | (static_cast<uint32_t>(bytes[3]) << 24);
}

uint32_t UpdateCrc32(uint32_t crc, const unsigned char* data, size_t size) {
  static const auto table = [] {
    std::array<uint32_t, 256> values{};
    for (uint32_t index = 0; index < values.size(); ++index) {
      uint32_t value = index;
      for (int bit = 0; bit < 8; ++bit) value = (value & 1) ? (value >> 1) ^ 0xedb88320u : value >> 1;
      values[index] = value;
    }
    return values;
  }();
  for (size_t index = 0; index < size; ++index) crc = table[(crc ^ data[index]) & 0xff] ^ (crc >> 8);
  return crc;
}

std::string NormalizeZipName(const std::wstring& value, bool directory) {
  std::wstring normalized = value;
  std::replace(normalized.begin(), normalized.end(), L'\\', L'/');
  while (!normalized.empty() && normalized.front() == L'/') normalized.erase(normalized.begin());
  while (normalized.find(L"//") != std::wstring::npos) normalized.replace(normalized.find(L"//"), 2, L"/");
  if (directory && !normalized.empty() && normalized.back() != L'/') normalized.push_back(L'/');
  return WideToUtf8(normalized);
}

bool PrepareZipEntry(ZipEntrySource& entry, std::wstring& errorText) {
  FILETIME utcTime{}, localTime{};
  bool hasTime = false;
  if (!entry.diskPath.empty()) {
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (GetFileAttributesExW(entry.diskPath.c_str(), GetFileExInfoStandard, &attributes)) {
      utcTime = attributes.ftLastWriteTime;
      hasTime = FileTimeToLocalFileTime(&utcTime, &localTime) != FALSE;
    }
  }
  if (!hasTime) {
    GetSystemTimeAsFileTime(&utcTime);
    hasTime = FileTimeToLocalFileTime(&utcTime, &localTime) != FALSE;
  }
  if (!hasTime || !FileTimeToDosDateTime(&localTime, &entry.modifiedDate, &entry.modifiedTime)) {
    // DOS ZIP timestamps cannot represent dates before 1980. Use the earliest valid date.
    entry.modifiedDate = static_cast<uint16_t>((1u << 5) | 1u);
    entry.modifiedTime = 0;
  }
  if (entry.directory) return true;
  uint64_t size = entry.memory.size();
  if (!entry.diskPath.empty()) {
    std::error_code error;
    size = std::filesystem::file_size(entry.diskPath, error);
    if (error) { errorText = L"无法读取打包文件大小：" + entry.diskPath.wstring(); return false; }
  }
  if (size > UINT32_MAX) { errorText = L"单个打包文件超过 4 GB，当前项目包格式暂不支持：" + entry.diskPath.wstring(); return false; }
  entry.size = static_cast<uint32_t>(size);
  uint32_t crc = 0xffffffffu;
  if (!entry.diskPath.empty()) {
    std::ifstream stream(entry.diskPath, std::ios::binary);
    if (!stream) { errorText = L"无法读取打包文件：" + entry.diskPath.wstring(); return false; }
    std::vector<unsigned char> buffer(1024 * 1024);
    while (stream) {
      stream.read(reinterpret_cast<char*>(buffer.data()), buffer.size());
      const auto count = stream.gcount();
      if (count > 0) crc = UpdateCrc32(crc, buffer.data(), static_cast<size_t>(count));
    }
    if (!stream.eof()) { errorText = L"打包文件读取不完整：" + entry.diskPath.wstring(); return false; }
  } else if (!entry.memory.empty()) {
    crc = UpdateCrc32(crc, entry.memory.data(), entry.memory.size());
  }
  entry.crc = crc ^ 0xffffffffu;
  return true;
}

bool AddZipEntry(std::vector<ZipEntrySource>& entries, std::unordered_set<std::string>& names,
                 ZipEntrySource entry, std::wstring& errorText) {
  if (entry.name.empty() || entry.name.size() > UINT16_MAX || entry.name.front() == '/' ||
      entry.name.find("../") != std::string::npos || entry.name.find(':') != std::string::npos) {
    errorText = L"项目包中存在无效路径";
    return false;
  }
  std::string key = entry.name;
  std::transform(key.begin(), key.end(), key.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (!names.insert(key).second) {
    const auto existing = std::find_if(entries.begin(), entries.end(), [&](const ZipEntrySource& candidate) {
      std::string candidateKey = candidate.name;
      std::transform(candidateKey.begin(), candidateKey.end(), candidateKey.begin(),
        [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
      return candidateKey == key;
    });
    // 同一个外部源被多个画布元素引用时只打包一次；不同源碰巧映射到同一归档名
    // 仍必须拒绝，否则解包后无法判断哪个才是用户选择的文件。
    if (existing != entries.end() && entry.directory == existing->directory &&
        !entry.diskPath.empty() && !existing->diskPath.empty() &&
        SamePath(entry.diskPath, existing->diskPath)) return true;
    errorText = L"项目包包含重复路径：" + Utf8ToWide(entry.name);
    return false;
  }
  if (!PrepareZipEntry(entry, errorText)) return false;
  entries.push_back(std::move(entry));
  return true;
}

bool CollectExternalZipEntries(const JsonValue* externals, std::vector<ZipEntrySource>& entries,
                               std::unordered_set<std::string>& names, std::wstring& errorText) {
  if (!externals || externals->kind != JsonValue::Kind::Array) return true;
  for (const auto& external : externals->items) {
    const auto* pathValue = external.Member(L"path");
    const auto* archiveValue = external.Member(L"archivePath");
    if (!pathValue || !archiveValue || pathValue->kind != JsonValue::Kind::String || archiveValue->kind != JsonValue::Kind::String) continue;
    const std::filesystem::path source(pathValue->text);
    std::error_code error;
    if (!std::filesystem::exists(source, error) || error) { errorText = L"外部引用不存在：" + source.wstring(); return false; }
    const std::string rootName = NormalizeZipName(archiveValue->text, std::filesystem::is_directory(source, error));
    if (error) { errorText = L"无法读取外部引用：" + source.wstring(); return false; }
    if (std::filesystem::is_regular_file(source, error)) {
      if (!AddZipEntry(entries, names, ZipEntrySource{rootName, source}, errorText)) return false;
      continue;
    }
    if (!std::filesystem::is_directory(source, error)) { errorText = L"不支持打包此类外部引用：" + source.wstring(); return false; }
    if (!AddZipEntry(entries, names, ZipEntrySource{rootName, source, {}, true}, errorText)) return false;
    const auto options = std::filesystem::directory_options::skip_permission_denied;
    for (std::filesystem::recursive_directory_iterator iterator(source, options, error), end; iterator != end; iterator.increment(error)) {
      if (error) { errorText = L"无法遍历外部文件夹：" + source.wstring(); return false; }
      const auto& item = *iterator;
      if (item.is_symlink(error)) { iterator.disable_recursion_pending(); error.clear(); continue; }
      if (error) { errorText = L"无法读取外部文件夹项目"; return false; }
      const auto relative = std::filesystem::relative(item.path(), source, error);
      if (error) { errorText = L"无法计算外部文件相对路径"; return false; }
      const bool directory = item.is_directory(error);
      if (error) { errorText = L"无法读取外部文件类型"; return false; }
      if (!directory && !item.is_regular_file(error)) { error.clear(); continue; }
      std::wstring combined = Utf8ToWide(rootName);
      if (!combined.empty() && combined.back() != L'/') combined.push_back(L'/');
      combined += relative.generic_wstring();
      ZipEntrySource entry{NormalizeZipName(combined, directory), item.path(), {}, directory};
      if (!AddZipEntry(entries, names, std::move(entry), errorText)) return false;
    }
  }
  return true;
}

bool IsProjectArchiveTempName(const std::wstring& candidate, const std::wstring& destinationName) {
  const std::wstring prefix = destinationName + L".tmp-";
  if (candidate.size() <= prefix.size() || candidate.compare(0, prefix.size(), prefix) != 0) return false;
  const std::wstring suffix = candidate.substr(prefix.size());
  const size_t separator = suffix.find(L'-');
  if (separator == std::wstring::npos || separator == 0 || separator + 1 >= suffix.size() ||
      suffix.find(L'-', separator + 1) != std::wstring::npos) return false;
  return std::all_of(suffix.begin(), suffix.begin() + separator, ::iswdigit) &&
    std::all_of(suffix.begin() + separator + 1, suffix.end(), ::iswdigit);
}

void CleanupStaleProjectArchiveTemps(const std::filesystem::path& destination) {
  const auto parent = destination.parent_path();
  if (parent.empty()) return;
  const auto cutoff = std::filesystem::file_time_type::clock::now() - std::chrono::hours(1);
  std::error_code error;
  for (std::filesystem::directory_iterator iterator(parent, error), end;
       !error && iterator != end; iterator.increment(error)) {
    std::error_code itemError;
    if (!iterator->is_regular_file(itemError) || itemError || iterator->is_symlink(itemError) || itemError) continue;
    if (!IsProjectArchiveTempName(iterator->path().filename().wstring(), destination.filename().wstring())) continue;
    const auto modified = iterator->last_write_time(itemError);
    if (itemError || modified >= cutoff) continue;
    std::filesystem::remove(iterator->path(), itemError);
  }
}

bool WriteProjectArchiveTemporary(const std::filesystem::path& destination, const std::wstring& projectJson,
                                  const JsonValue* assets, const JsonValue* externals,
                                  std::filesystem::path& temporary, std::wstring& errorText) {
  std::vector<ZipEntrySource> entries;
  std::unordered_set<std::string> names;
  const std::string projectBytes = WideToUtf8(projectJson);
  if (!AddZipEntry(entries, names, ZipEntrySource{"project.json", {},
      std::vector<unsigned char>(projectBytes.begin(), projectBytes.end())}, errorText)) return false;
  if (assets && assets->kind == JsonValue::Kind::Array) {
    for (const auto& asset : assets->items) {
      const auto* pathValue = asset.Member(L"path");
      const auto* dataValue = asset.Member(L"dataUrl");
      if (!pathValue || !dataValue || pathValue->kind != JsonValue::Kind::String || dataValue->kind != JsonValue::Kind::String) continue;
      const size_t comma = dataValue->text.find(L',');
      if (comma == std::wstring::npos) { errorText = L"项目素材数据无效"; return false; }
      ZipEntrySource entry;
      entry.name = NormalizeZipName(pathValue->text, false);
      entry.memory = Base64Decode(dataValue->text.substr(comma + 1));
      if (!AddZipEntry(entries, names, std::move(entry), errorText)) return false;
    }
  }
  if (!CollectExternalZipEntries(externals, entries, names, errorText)) return false;
  if (entries.size() > UINT16_MAX) { errorText = L"项目包文件数量超过 65535"; return false; }

  std::error_code directoryError;
  std::filesystem::create_directories(destination.parent_path(), directoryError);
  if (directoryError) { errorText = L"无法创建导出目录"; return false; }
  CleanupStaleProjectArchiveTemps(destination);
  temporary = std::filesystem::path(destination.wstring() + L".tmp-" +
    std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
  std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
  if (!stream) { errorText = L"无法创建项目包"; return false; }
  constexpr uint16_t flags = 0x0800;  // UTF-8 names, no data descriptor.
  for (auto& entry : entries) {
    const auto offset = static_cast<uint64_t>(stream.tellp());
    if (offset > UINT32_MAX) { errorText = L"项目包超过 4 GB，当前格式暂不支持"; stream.close(); DeleteFileW(temporary.c_str()); return false; }
    entry.localOffset = static_cast<uint32_t>(offset);
    WriteZip32(stream, 0x04034b50u); WriteZip16(stream, 20); WriteZip16(stream, flags); WriteZip16(stream, 0);
    WriteZip16(stream, entry.modifiedTime); WriteZip16(stream, entry.modifiedDate); WriteZip32(stream, entry.crc); WriteZip32(stream, entry.size); WriteZip32(stream, entry.size);
    WriteZip16(stream, static_cast<uint16_t>(entry.name.size())); WriteZip16(stream, 0); stream.write(entry.name.data(), entry.name.size());
    if (!entry.directory) {
      if (!entry.diskPath.empty()) {
        std::ifstream input(entry.diskPath, std::ios::binary);
        if (!input) { errorText = L"无法再次读取外部文件"; stream.close(); DeleteFileW(temporary.c_str()); return false; }
        std::vector<char> buffer(1024 * 1024);
        uint32_t remaining = entry.size;
        uint32_t actualCrc = 0xffffffffu;
        while (remaining) {
          const auto requested = static_cast<std::streamsize>((std::min)(static_cast<size_t>(remaining), buffer.size()));
          input.read(buffer.data(), requested);
          const auto count = input.gcount();
          if (count <= 0) { errorText = L"外部文件在导出期间被缩短"; stream.close(); DeleteFileW(temporary.c_str()); return false; }
          stream.write(buffer.data(), count);
          actualCrc = UpdateCrc32(actualCrc, reinterpret_cast<const unsigned char*>(buffer.data()), static_cast<size_t>(count));
          remaining -= static_cast<uint32_t>(count);
        }
        if ((actualCrc ^ 0xffffffffu) != entry.crc) {
          errorText = L"外部文件在导出期间发生变化";
          stream.close(); DeleteFileW(temporary.c_str()); return false;
        }
      } else if (!entry.memory.empty()) stream.write(reinterpret_cast<const char*>(entry.memory.data()), entry.memory.size());
    }
    if (!stream) { errorText = L"项目包写入失败"; stream.close(); DeleteFileW(temporary.c_str()); return false; }
  }
  const auto centralOffset64 = static_cast<uint64_t>(stream.tellp());
  if (centralOffset64 > UINT32_MAX) { errorText = L"项目包超过 4 GB，当前格式暂不支持"; stream.close(); DeleteFileW(temporary.c_str()); return false; }
  for (const auto& entry : entries) {
    WriteZip32(stream, 0x02014b50u); WriteZip16(stream, 20); WriteZip16(stream, 20); WriteZip16(stream, flags); WriteZip16(stream, 0);
    WriteZip16(stream, entry.modifiedTime); WriteZip16(stream, entry.modifiedDate); WriteZip32(stream, entry.crc); WriteZip32(stream, entry.size); WriteZip32(stream, entry.size);
    WriteZip16(stream, static_cast<uint16_t>(entry.name.size())); WriteZip16(stream, 0); WriteZip16(stream, 0); WriteZip16(stream, 0); WriteZip16(stream, 0);
    WriteZip32(stream, entry.directory ? 0x10u : 0u); WriteZip32(stream, entry.localOffset); stream.write(entry.name.data(), entry.name.size());
  }
  const auto centralEnd64 = static_cast<uint64_t>(stream.tellp());
  if (centralEnd64 > UINT32_MAX || centralEnd64 - centralOffset64 > UINT32_MAX) {
    errorText = L"项目包超过 4 GB，当前格式暂不支持"; stream.close(); DeleteFileW(temporary.c_str()); return false;
  }
  WriteZip32(stream, 0x06054b50u); WriteZip16(stream, 0); WriteZip16(stream, 0);
  WriteZip16(stream, static_cast<uint16_t>(entries.size())); WriteZip16(stream, static_cast<uint16_t>(entries.size()));
  WriteZip32(stream, static_cast<uint32_t>(centralEnd64 - centralOffset64)); WriteZip32(stream, static_cast<uint32_t>(centralOffset64)); WriteZip16(stream, 0);
  stream.close();
  if (!stream) { errorText = L"项目包写入不完整"; DeleteFileW(temporary.c_str()); return false; }
  return true;
}

bool IsSafeZipEntryName(const std::string& entryName) {
  if (entryName.empty() || entryName.front() == '/' || entryName.find('\\') != std::string::npos || entryName.find(':') != std::string::npos) return false;
  const std::wstring wideName = Utf8ToWide(entryName);
  if (wideName.empty()) return false;
  std::wstringstream parts(wideName);
  std::wstring part;
  while (std::getline(parts, part, L'/')) if (part == L"..") return false;
  return true;
}

bool SafeZipDestination(const std::filesystem::path& root, const std::string& entryName,
                         std::filesystem::path& destination) {
  if (!IsSafeZipEntryName(entryName)) return false;
  const std::wstring wideName = Utf8ToWide(entryName);
  return SafeProjectChild(root, wideName, destination);
}

struct ExtractedZipEntry {
  std::string name;
  uint32_t localOffset = 0;
  uint16_t flags = 0;
  uint16_t method = 0;
  uint32_t crc = 0;
  uint32_t compressedSize = 0;
  uint32_t uncompressedSize = 0;
};

bool ValidateZipCentralDirectory(const std::filesystem::path& archive,
                                 const std::vector<ExtractedZipEntry>& extractedEntries,
                                 std::wstring& errorText) {
  std::ifstream stream(archive, std::ios::binary | std::ios::ate);
  if (!stream) { errorText = L"无法复核项目包中央目录"; return false; }
  const auto endPosition = stream.tellg();
  if (endPosition < static_cast<std::streamoff>(22)) { errorText = L"项目包缺少中央目录"; return false; }
  const uint64_t archiveSize = static_cast<uint64_t>(endPosition);
  const size_t tailSize = static_cast<size_t>((std::min<uint64_t>)(archiveSize, 22u + UINT16_MAX));
  std::vector<unsigned char> tail(tailSize);
  stream.seekg(static_cast<std::streamoff>(archiveSize - tailSize), std::ios::beg);
  if (!stream || !stream.read(reinterpret_cast<char*>(tail.data()), tail.size())) {
    errorText = L"项目包中央目录读取不完整";
    return false;
  }

  size_t eocdIndex = std::string::npos;
  for (size_t index = tail.size() - 22;; --index) {
    if (Zip32At(tail.data() + index) == 0x06054b50u &&
        index + 22u + Zip16At(tail.data() + index + 20) == tail.size()) {
      eocdIndex = index;
      break;
    }
    if (index == 0) break;
  }
  if (eocdIndex == std::string::npos) { errorText = L"项目包缺少中央目录"; return false; }
  const unsigned char* eocd = tail.data() + eocdIndex;
  const uint16_t disk = Zip16At(eocd + 4);
  const uint16_t centralDisk = Zip16At(eocd + 6);
  const uint16_t entriesOnDisk = Zip16At(eocd + 8);
  const uint16_t totalEntries = Zip16At(eocd + 10);
  const uint32_t centralSize = Zip32At(eocd + 12);
  const uint32_t centralOffset = Zip32At(eocd + 16);
  const uint16_t commentLength = Zip16At(eocd + 20);
  const uint64_t eocdOffset = archiveSize - tailSize + eocdIndex;
  if (disk != 0 || centralDisk != 0 || entriesOnDisk != totalEntries ||
      totalEntries != extractedEntries.size() || eocdOffset + 22u + commentLength != archiveSize ||
      static_cast<uint64_t>(centralOffset) + centralSize != eocdOffset) {
    errorText = L"项目包中央目录与文件条目不一致";
    return false;
  }

  stream.clear();
  stream.seekg(centralOffset, std::ios::beg);
  std::unordered_map<uint32_t, const ExtractedZipEntry*> localEntries;
  for (const auto& entry : extractedEntries) {
    if (!localEntries.emplace(entry.localOffset, &entry).second) {
      errorText = L"项目包本地文件头偏移重复";
      return false;
    }
  }
  std::unordered_set<uint32_t> referencedOffsets;
  for (uint16_t index = 0; index < totalEntries; ++index) {
    uint32_t signature = 0;
    if (!ReadZip32(stream, signature) || signature != 0x02014b50u) {
      errorText = L"项目包中央目录条目无效";
      return false;
    }
    std::array<unsigned char, 42> fixed{};
    if (!stream.read(reinterpret_cast<char*>(fixed.data()), fixed.size())) {
      errorText = L"项目包中央目录条目不完整";
      return false;
    }
    const uint16_t nameLength = Zip16At(fixed.data() + 24);
    const uint16_t extraLength = Zip16At(fixed.data() + 26);
    const uint16_t entryCommentLength = Zip16At(fixed.data() + 28);
    const uint16_t entryDisk = Zip16At(fixed.data() + 30);
    const uint32_t localOffset = Zip32At(fixed.data() + 38);
    if (entryDisk != 0) { errorText = L"项目包不支持分卷"; return false; }
    std::string centralName(nameLength, '\0');
    if (!stream.read(centralName.data(), centralName.size())) {
      errorText = L"项目包中央目录文件名不完整";
      return false;
    }
    const auto local = localEntries.find(localOffset);
    const auto* localEntry = local == localEntries.end() ? nullptr : local->second;
    if (!localEntry || localEntry->name != centralName ||
        localEntry->flags != Zip16At(fixed.data() + 4) ||
        localEntry->method != Zip16At(fixed.data() + 6) ||
        localEntry->crc != Zip32At(fixed.data() + 12) ||
        localEntry->compressedSize != Zip32At(fixed.data() + 16) ||
        localEntry->uncompressedSize != Zip32At(fixed.data() + 20) ||
        !referencedOffsets.insert(localOffset).second) {
      errorText = L"项目包中央目录与本地文件头不一致";
      return false;
    }
    stream.seekg(static_cast<std::streamoff>(extraLength) + entryCommentLength, std::ios::cur);
    if (!stream) { errorText = L"项目包中央目录条目不完整"; return false; }
  }
  const auto centralEnd = stream.tellg();
  if (centralEnd < 0 || static_cast<uint64_t>(centralEnd) !=
      static_cast<uint64_t>(centralOffset) + centralSize) {
    errorText = L"项目包中央目录长度无效";
    return false;
  }
  return true;
}

bool ExtractProjectArchive(const std::filesystem::path& archive, std::filesystem::path& projectRoot,
                            std::wstring& errorText) {
  std::ifstream stream(archive, std::ios::binary);
  if (!stream) { errorText = L"无法打开项目包"; return false; }
  projectRoot = std::filesystem::path(g_dataFolder) / L"Imported" /
    (SafeProjectName(archive.stem().wstring()) + L"-" + std::to_wstring(GetTickCount64()) + L".zzj");
  std::error_code error;
  std::filesystem::create_directories(projectRoot, error);
  if (error) { errorText = L"无法创建项目包解压目录"; return false; }
  struct ExtractionCleanup {
    std::filesystem::path root;
    bool active = true;
    ~ExtractionCleanup() { if (active) RemoveTreeBestEffort(root); }
    void Release() { active = false; }
  } cleanup{projectRoot};
  std::vector<ExtractedZipEntry> extractedEntries;
  bool foundProject = false;
  bool reachedCentralDirectory = false;
  while (stream) {
    const auto localOffsetPosition = stream.tellg();
    if (localOffsetPosition < 0 || static_cast<uint64_t>(localOffsetPosition) > UINT32_MAX) {
      errorText = L"项目包本地文件头偏移超出支持范围";
      return false;
    }
    const uint32_t localOffset = static_cast<uint32_t>(localOffsetPosition);
    uint32_t signature = 0;
    if (!ReadZip32(stream, signature)) { errorText = L"项目包在中央目录前意外结束"; return false; }
    if (signature == 0x02014b50u) { reachedCentralDirectory = true; break; }
    if (signature == 0x06054b50u) { errorText = L"项目包缺少中央目录条目"; return false; }
    if (signature != 0x04034b50u) { errorText = L"项目包结构无效"; return false; }
    if (extractedEntries.size() >= UINT16_MAX) { errorText = L"项目包文件条目过多"; return false; }
    uint16_t version = 0, flags = 0, method = 0, modifiedTime = 0, modifiedDate = 0;
    uint16_t nameLength = 0, extraLength = 0;
    uint32_t crc = 0, compressedSize = 0, uncompressedSize = 0;
    if (!ReadZip16(stream, version) || !ReadZip16(stream, flags) || !ReadZip16(stream, method) ||
        !ReadZip16(stream, modifiedTime) || !ReadZip16(stream, modifiedDate) || !ReadZip32(stream, crc) ||
        !ReadZip32(stream, compressedSize) || !ReadZip32(stream, uncompressedSize) ||
        !ReadZip16(stream, nameLength) || !ReadZip16(stream, extraLength)) { errorText = L"项目包条目不完整"; return false; }
    if ((flags & 1) || (flags & 8) || method != 0 || compressedSize != uncompressedSize) {
      errorText = L"项目包使用了当前不支持的压缩或加密方式"; return false;
    }
    std::string name(nameLength, '\0');
    if (!stream.read(name.data(), name.size())) { errorText = L"项目包文件名不完整"; return false; }
    stream.seekg(extraLength, std::ios::cur);
    if (!stream) { errorText = L"项目包扩展字段不完整"; return false; }
    std::filesystem::path destination;
    if (!SafeZipDestination(projectRoot, name, destination)) { errorText = L"项目包包含不安全路径"; return false; }
    const bool directory = !name.empty() && name.back() == '/';
    if (directory) {
      std::filesystem::create_directories(destination, error);
      if (error) { errorText = L"无法创建项目包目录"; return false; }
      extractedEntries.push_back({name, localOffset, flags, method, crc, compressedSize, uncompressedSize});
      continue;
    }
    std::filesystem::create_directories(destination.parent_path(), error);
    if (error) { errorText = L"无法创建项目包文件目录"; return false; }
    std::ofstream output(destination, std::ios::binary | std::ios::trunc);
    if (!output) { errorText = L"无法写入项目包文件"; return false; }
    uint32_t remaining = compressedSize;
    uint32_t actualCrc = 0xffffffffu;
    std::vector<unsigned char> buffer(1024 * 1024);
    while (remaining) {
      const size_t chunk = (std::min)(static_cast<size_t>(remaining), buffer.size());
      if (!stream.read(reinterpret_cast<char*>(buffer.data()), chunk)) { errorText = L"项目包文件数据不完整"; return false; }
      output.write(reinterpret_cast<const char*>(buffer.data()), chunk);
      actualCrc = UpdateCrc32(actualCrc, buffer.data(), chunk);
      remaining -= static_cast<uint32_t>(chunk);
    }
    output.close();
    if (!output || (actualCrc ^ 0xffffffffu) != crc) { errorText = L"项目包文件校验失败"; return false; }
    if (_stricmp(name.c_str(), "project.json") == 0) foundProject = true;
    extractedEntries.push_back({name, localOffset, flags, method, crc, compressedSize, uncompressedSize});
  }
  if (!reachedCentralDirectory || !ValidateZipCentralDirectory(archive, extractedEntries, errorText)) return false;
  if (!foundProject || !std::filesystem::is_regular_file(projectRoot / L"project.json")) {
    errorText = L"项目包缺少 project.json"; return false;
  }
  DecorateProjectDirectory(projectRoot);
  cleanup.Release();
  return true;
}

bool ValidateProjectArchiveReadOnly(const std::filesystem::path& archive,
                                    std::vector<unsigned char>& projectJsonBytes,
                                    std::wstring& errorText) {
  std::ifstream stream(archive, std::ios::binary);
  if (!stream) { errorText = L"无法重新读取项目临时文件"; return false; }
  std::vector<ExtractedZipEntry> entries;
  std::unordered_set<std::string> names;
  bool firstEntry = true;
  bool foundProject = false;
  bool reachedCentralDirectory = false;
  std::vector<unsigned char> buffer(1024 * 1024);
  while (stream) {
    const auto localOffsetPosition = stream.tellg();
    if (localOffsetPosition < 0 || static_cast<uint64_t>(localOffsetPosition) > UINT32_MAX) {
      errorText = L"项目临时文件的条目偏移超出支持范围";
      return false;
    }
    const uint32_t localOffset = static_cast<uint32_t>(localOffsetPosition);
    uint32_t signature = 0;
    if (!ReadZip32(stream, signature)) { errorText = L"项目临时文件在中央目录前意外结束"; return false; }
    if (signature == 0x02014b50u) { reachedCentralDirectory = true; break; }
    if (signature != 0x04034b50u || entries.size() >= UINT16_MAX) {
      errorText = L"项目临时文件的 ZIP 结构无效";
      return false;
    }
    uint16_t version = 0, flags = 0, method = 0, modifiedTime = 0, modifiedDate = 0;
    uint16_t nameLength = 0, extraLength = 0;
    uint32_t crc = 0, compressedSize = 0, uncompressedSize = 0;
    if (!ReadZip16(stream, version) || !ReadZip16(stream, flags) || !ReadZip16(stream, method) ||
        !ReadZip16(stream, modifiedTime) || !ReadZip16(stream, modifiedDate) || !ReadZip32(stream, crc) ||
        !ReadZip32(stream, compressedSize) || !ReadZip32(stream, uncompressedSize) ||
        !ReadZip16(stream, nameLength) || !ReadZip16(stream, extraLength)) {
      errorText = L"项目临时文件的条目头不完整";
      return false;
    }
    if ((flags & 1) || (flags & 8) || method != 0 || compressedSize != uncompressedSize) {
      errorText = L"项目临时文件使用了不支持的压缩或加密方式";
      return false;
    }
    std::string name(nameLength, '\0');
    if (!stream.read(name.data(), name.size()) || !IsSafeZipEntryName(name)) {
      errorText = L"项目临时文件包含无效路径";
      return false;
    }
    std::string normalizedName = name;
    std::transform(normalizedName.begin(), normalizedName.end(), normalizedName.begin(),
      [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    if (!names.insert(normalizedName).second) {
      errorText = L"项目临时文件包含重复路径";
      return false;
    }
    if (firstEntry && _stricmp(name.c_str(), "project.json") != 0) {
      errorText = L"项目临时文件的第一项不是 project.json";
      return false;
    }
    firstEntry = false;
    stream.seekg(extraLength, std::ios::cur);
    if (!stream) { errorText = L"项目临时文件的扩展字段不完整"; return false; }

    const bool isProjectJson = _stricmp(name.c_str(), "project.json") == 0;
    if (isProjectJson) {
      if (uncompressedSize > kMaxProjectJsonBytes) {
        errorText = L"项目临时文件的 project.json 超出 64 MiB 上限";
        return false;
      }
      projectJsonBytes.clear();
      projectJsonBytes.reserve(uncompressedSize);
    }
    uint32_t remaining = compressedSize;
    uint32_t actualCrc = 0xffffffffu;
    while (remaining) {
      const size_t chunk = (std::min)(static_cast<size_t>(remaining), buffer.size());
      if (!stream.read(reinterpret_cast<char*>(buffer.data()), chunk)) {
        errorText = L"项目临时文件的条目数据不完整";
        return false;
      }
      actualCrc = UpdateCrc32(actualCrc, buffer.data(), chunk);
      if (isProjectJson) projectJsonBytes.insert(projectJsonBytes.end(), buffer.begin(), buffer.begin() + chunk);
      remaining -= static_cast<uint32_t>(chunk);
    }
    if ((actualCrc ^ 0xffffffffu) != crc) {
      errorText = L"项目临时文件的 CRC 校验失败";
      return false;
    }
    if (isProjectJson) foundProject = true;
    entries.push_back({name, localOffset, flags, method, crc, compressedSize, uncompressedSize});
  }
  if (!reachedCentralDirectory || !ValidateZipCentralDirectory(archive, entries, errorText)) return false;
  if (!foundProject) { errorText = L"项目临时文件缺少 project.json"; return false; }
  return true;
}

bool ValidateWrittenProjectArchive(const std::filesystem::path& archive, const std::wstring& expectedProjectJson,
                                   std::wstring& errorText) {
  std::vector<unsigned char> validatedProjectJson;
  if (!ValidateProjectArchiveReadOnly(archive, validatedProjectJson, errorText)) return false;
  const std::string expectedBytes = WideToUtf8(expectedProjectJson);
  if (validatedProjectJson.size() != expectedBytes.size() ||
      !std::equal(validatedProjectJson.begin(), validatedProjectJson.end(), expectedBytes.begin(),
        [](unsigned char actual, char expected) {
          return actual == static_cast<unsigned char>(expected);
        })) {
    errorText = L"项目临时文件回读校验失败，原项目未被替换";
    return false;
  }
  return true;
}

bool CommitProjectArchive(const std::filesystem::path& temporary, const std::filesystem::path& destination,
                          std::wstring& errorText) {
  const DWORD attributes = GetFileAttributesW(destination.c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
    errorText = L"目标路径仍是旧目录项目，必须先完成格式迁移";
    return false;
  }
  if (attributes != INVALID_FILE_ATTRIBUTES) {
    if (ReplaceFileW(destination.c_str(), temporary.c_str(), nullptr, REPLACEFILE_WRITE_THROUGH, nullptr, nullptr)) {
      return true;
    }
    // Some file systems do not implement ReplaceFileW. MoveFileExW with
    // WRITE_THROUGH remains an atomic same-volume replacement on Windows.
    if (MoveFileExW(temporary.c_str(), destination.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
  } else if (MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) {
    return true;
  }
  errorText = L"无法原子替换目标项目文件，原文件保持不变";
  return false;
}

std::filesystem::path AvailableLegacyBackupPath(const std::filesystem::path& projectDirectory) {
  std::filesystem::path candidate(projectDirectory.wstring() + L".old");
  std::error_code error;
  for (unsigned index = 2; std::filesystem::exists(candidate, error) && !error; ++index) {
    candidate = std::filesystem::path(projectDirectory.wstring() + L".old-" + std::to_wstring(index));
  }
  return error ? std::filesystem::path{} : candidate;
}

bool WriteProjectArchive(const std::filesystem::path& destination, const std::wstring& projectJson,
                         const JsonValue* assets, const JsonValue* externals, std::wstring& errorText) {
  std::filesystem::path temporary;
  if (!WriteProjectArchiveTemporary(destination, projectJson, assets, externals, temporary, errorText)) return false;
  if (!ValidateWrittenProjectArchive(temporary, projectJson, errorText) ||
      !CommitProjectArchive(temporary, destination, errorText)) {
    DeleteFileW(temporary.c_str());
    return false;
  }
  return true;
}

bool SendOpenedProject(const std::filesystem::path& projectRoot, std::wstring* errorText = nullptr) {
  std::wstring projectJson;
  if (!ReadUtf8File(projectRoot / L"project.json", projectJson)) {
    if (errorText) *errorText = L"无法读取项目文件 project.json";
    return false;
  }
  std::wstring assetsJson;
  if (!BuildProjectAssetsJson(projectRoot, projectJson, assetsJson, errorText)) return false;
  g_currentProjectPath = projectRoot.wstring();
  SetCurrentPackageRoot(projectRoot.wstring());
  RememberRecentProject(g_currentProjectPath);
  PostToCanvas(L"{\"type\":\"native-project-opened\",\"legacyDirectory\":true,\"projectPath\":\"" + JsonEscape(g_currentProjectPath) +
    L"\",\"packageRoot\":\"" + JsonEscape(g_currentPackageRoot) +
    L"\",\"projectTitle\":\"" + JsonEscape(projectRoot.stem().wstring()) + L"\",\"projectJson\":\"" +
    JsonEscape(projectJson) + L"\",\"assets\":" + assetsJson + L"}");
  SendRecentProjects();
  return true;
}

bool SendOpenedProjectPackage(const std::filesystem::path& projectRoot, const std::filesystem::path& archivePath,
                              bool editableProject, std::wstring* errorText = nullptr) {
  std::wstring projectJson;
  if (!ReadUtf8File(projectRoot / L"project.json", projectJson)) {
    if (errorText) *errorText = L"无法读取项目包内的 project.json";
    return false;
  }
  std::wstring assetsJson;
  if (!BuildProjectAssetsJson(projectRoot, projectJson, assetsJson, errorText)) return false;
  g_currentProjectPath = editableProject ? archivePath.wstring() : std::wstring{};
  SetCurrentPackageRoot(projectRoot.wstring());
  RememberRecentProject(archivePath.wstring());
  PostToCanvas(L"{\"type\":\"native-project-opened\",\"projectPath\":\"" + JsonEscape(g_currentProjectPath) +
    L"\",\"projectTitle\":\"" + JsonEscape(archivePath.stem().wstring()) +
    L"\",\"packageRoot\":\"" + JsonEscape(projectRoot.wstring()) +
    L"\",\"projectJson\":\"" + JsonEscape(projectJson) + L"\",\"assets\":" + assetsJson + L"}");
  SendRecentProjects();
  return true;
}

class ShellDropSource final : public IDropSource {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDropSource) *object = static_cast<IDropSource*>(this);
    if (!*object) return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references_); }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = InterlockedDecrement(&references_);
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escapePressed, DWORD) override {
    if (escapePressed) return DRAGDROP_S_CANCEL;
    // 拖拽由 WebView2 的 pointermove 触发时，OLE 回调里的 grfKeyState 偶尔会漏掉
    // MK_LBUTTON，造成刚超过 6px 就在源窗口原地 Drop。全局异步键态才是此处的
    // 真实物理左键状态，松开后再让 Shell 目标完成复制。
    return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) ? S_OK : DRAGDROP_S_DROP;
  }
  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD) override { return DRAGDROP_S_USEDEFAULTCURSORS; }

 private:
  ~ShellDropSource() = default;
  LONG references_ = 1;
};

std::vector<std::wstring> ExtractHDropPaths(IDataObject* dataObject) {
  std::vector<std::wstring> paths;
  if (!dataObject) return paths;
  FORMATETC format{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  STGMEDIUM medium{};
  if (FAILED(dataObject->GetData(&format, &medium))) return paths;
  const HDROP drop = reinterpret_cast<HDROP>(medium.hGlobal);
  if (drop) {
    const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
    paths.reserve(count);
    for (UINT index = 0; index < count; ++index) {
      const UINT length = DragQueryFileW(drop, index, nullptr, 0);
      std::wstring path(length + 1, L'\0');
      DragQueryFileW(drop, index, path.data(), static_cast<UINT>(path.size()));
      path.resize(length);
      paths.push_back(std::move(path));
    }
  }
  ReleaseStgMedium(&medium);
  return paths;
}

class ShellCanvasDropTarget final : public IDropTarget {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDropTarget) *object = static_cast<IDropTarget*>(this);
    if (!*object) return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references_); }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = InterlockedDecrement(&references_);
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* dataObject, DWORD, POINTL, DWORD* effect) override {
    FORMATETC format{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    acceptsFiles_ = dataObject && SUCCEEDED(dataObject->QueryGetData(&format));
    if (effect) *effect = acceptsFiles_ ? (*effect & DROPEFFECT_COPY) : DROPEFFECT_NONE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE DragOver(DWORD, POINTL, DWORD* effect) override {
    if (effect) *effect = acceptsFiles_ ? (*effect & DROPEFFECT_COPY) : DROPEFFECT_NONE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE DragLeave() override { acceptsFiles_ = false; return S_OK; }
  HRESULT STDMETHODCALLTYPE Drop(IDataObject* dataObject, DWORD, POINTL point, DWORD* effect) override {
    const auto paths = ExtractHDropPaths(dataObject);
    POINT client{point.x, point.y};
    ScreenToClient(g_mainWindow, &client);
    // OLE supplies physical screen coordinates in this Per-Monitor-V2 process, while
    // elementFromPoint in the app WebView consumes CSS pixels. Convert at the host DPI
    // so a drop on 125%/150%/200% displays lands on the visible self-drawn file view.
    const UINT dpi = std::max<UINT>(96, GetDpiForWindow(g_mainWindow));
    client.x = MulDiv(client.x, 96, static_cast<int>(dpi));
    client.y = MulDiv(client.y, 96, static_cast<int>(dpi));
    if (!paths.empty()) {
      std::wostringstream json;
      json << L"{\"type\":\"native-drop-files\",\"clientX\":" << client.x
        << L",\"clientY\":" << client.y << L",\"paths\":[";
      for (size_t index = 0; index < paths.size(); ++index) {
        if (index) json << L',';
        // Project packages are recognized before generic folders. The Web layer
        // owns the unsaved-document confirmation and therefore receives the
        // normalized project target instead of a pre-opened project.
        json << CanvasPathJson(paths[index]);
      }
      json << L"]}";
      PostToCanvas(json.str());
    }
    acceptsFiles_ = false;
    if (effect) *effect = paths.empty() ? DROPEFFECT_NONE : DROPEFFECT_COPY;
    return S_OK;
  }

 private:
  ~ShellCanvasDropTarget() = default;
  LONG references_ = 1;
  bool acceptsFiles_ = false;
};

HWND FindCanvasRendererWindow() {
  struct Candidate { HWND window = nullptr; LONG64 area = 0; } candidate;
  EnumChildWindows(g_mainWindow, [](HWND window, LPARAM value) -> BOOL {
    wchar_t className[96]{};
    GetClassNameW(window, className, static_cast<int>(std::size(className)));
    if (wcscmp(className, L"Chrome_RenderWidgetHostHWND") != 0 || !IsWindowVisible(window)) return TRUE;
    RECT bounds{};
    if (!GetWindowRect(window, &bounds)) return TRUE;
    const LONG64 area = static_cast<LONG64>(bounds.right - bounds.left) * (bounds.bottom - bounds.top);
    auto* candidate = reinterpret_cast<Candidate*>(value);
    if (area > candidate->area) { candidate->window = window; candidate->area = area; }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&candidate));
  return candidate.window;
}

bool RegisterCanvasDropTarget(HWND window) {
  if (!window) return false;
  if (g_canvasDropTarget && g_canvasDropWindow == window) return true;
  if (g_canvasDropTarget && g_canvasDropWindow) {
    RevokeDragDrop(g_canvasDropWindow);
    g_canvasDropTarget->Release();
    g_canvasDropTarget = nullptr;
    g_canvasDropWindow = nullptr;
  }
  auto* dropTarget = new ShellCanvasDropTarget();
  HRESULT result = RegisterDragDrop(window, dropTarget);
  if (result == DRAGDROP_E_ALREADYREGISTERED) {
    // WebView2 may leave its HWND registered even after AllowExternalDrop is disabled.
    // We deliberately own external Shell drops on this renderer, so replace that stale target.
    RevokeDragDrop(window);
    result = RegisterDragDrop(window, dropTarget);
  }
  if (FAILED(result)) { dropTarget->Release(); return false; }
  g_canvasDropTarget = dropTarget;
  g_canvasDropWindow = window;
  return true;
}

ComPtr<IDataObject> CreateShellDataObject(const std::vector<std::wstring>& paths) {
  std::vector<PIDLIST_ABSOLUTE> pidls;
  pidls.reserve(paths.size());
  for (const auto& path : paths) {
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (SUCCEEDED(SHParseDisplayName(path.c_str(), nullptr, &pidl, 0, nullptr)) && pidl) pidls.push_back(pidl);
  }
  if (pidls.empty()) return {};
  ComPtr<IDataObject> dataObject;

  PIDLIST_ABSOLUTE parent = ILCloneFull(pidls.front());
  bool sameParent = parent && ILRemoveLastID(parent);
  if (sameParent) {
    for (size_t index = 1; index < pidls.size(); ++index) {
      PIDLIST_ABSOLUTE candidateParent = ILCloneFull(pidls[index]);
      if (!candidateParent || !ILRemoveLastID(candidateParent) || !ILIsEqual(parent, candidateParent)) sameParent = false;
      if (candidateParent) CoTaskMemFree(candidateParent);
      if (!sameParent) break;
    }
  }
  if (sameParent) {
    std::vector<PCUITEMID_CHILD> children;
    children.reserve(pidls.size());
    for (const auto pidl : pidls) children.push_back(ILFindLastID(pidl));
    SHCreateDataObject(parent, static_cast<UINT>(children.size()), children.data(), nullptr,
      IID_PPV_ARGS(&dataObject));
  }
  if (parent) CoTaskMemFree(parent);

  if (!dataObject) {
    std::vector<PCIDLIST_ABSOLUTE> absoluteItems;
    absoluteItems.reserve(pidls.size());
    for (const auto pidl : pidls) absoluteItems.push_back(pidl);
    ComPtr<IShellItemArray> shellItems;
    if (SUCCEEDED(SHCreateShellItemArrayFromIDLists(
          static_cast<UINT>(absoluteItems.size()), absoluteItems.data(), &shellItems)) && shellItems) {
      shellItems->BindToHandler(nullptr, BHID_DataObject, IID_PPV_ARGS(&dataObject));
    }
  }
  for (const auto pidl : pidls) CoTaskMemFree(pidl);
  return dataObject;
}

bool BeginShellFileDrag(const std::vector<std::wstring>& paths) {
  const ComPtr<IDataObject> dataObject = CreateShellDataObject(paths);
  if (!dataObject) return false;
  bool completed = false;
  ShellDropSource* source = new ShellDropSource();
  DWORD effect = DROPEFFECT_NONE;
  const HRESULT result = DoDragDrop(dataObject.Get(), source, DROPEFFECT_COPY, &effect);
  source->Release();
  completed = result == DRAGDROP_S_DROP && (effect & DROPEFFECT_COPY);
  return completed;
}

// 网页下载默认落到「下载\掌中界」（按需创建），避免和系统浏览器的下载混在一起。
std::wstring BrowserDownloadFolder() {
  wchar_t buffer[MAX_PATH]{};
  std::wstring base;
  if (GetEnvironmentVariableW(L"USERPROFILE", buffer, static_cast<DWORD>(std::size(buffer))) > 0) base = buffer;
  const std::filesystem::path folder = std::filesystem::path(base.empty() ? g_dataFolder : base) / L"Downloads" / L"掌中界";
  std::error_code ignored;
  std::filesystem::create_directories(folder, ignored);
  return folder.wstring();
}

// 「导出参考板 / 批量导出图片」用：固定导出目录 = 图片\掌中界导出（按需创建）。
std::wstring ExportFolder() {
  wchar_t buffer[MAX_PATH]{};
  std::wstring base;
  if (GetEnvironmentVariableW(L"USERPROFILE", buffer, static_cast<DWORD>(std::size(buffer))) > 0) base = buffer;
  if (base.empty()) base = g_dataFolder;
  const std::filesystem::path folder = std::filesystem::path(base) / L"Pictures" / L"掌中界导出";
  std::error_code ignored;
  std::filesystem::create_directories(folder, ignored);
  return folder.wstring();
}

// 把 base64 data URL 写进指定路径（自动建父目录），写完回报路径与结果。
void HandleWriteFile(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring target = JsonStringValue(message, L"path");
  const std::wstring dataUrl = JsonStringValue(message, L"dataUrl");
  bool ok = false;
  unsigned long long bytesWritten = 0;
  if (!target.empty() && !dataUrl.empty()) {
    const size_t comma = dataUrl.find(L',');
    const std::vector<unsigned char> bytes = comma == std::wstring::npos ? std::vector<unsigned char>{} : Base64Decode(dataUrl.substr(comma + 1));
    if (!bytes.empty()) {
      std::error_code ignored;
      const std::filesystem::path destination(target);
      if (destination.has_parent_path()) std::filesystem::create_directories(destination.parent_path(), ignored);
      std::ofstream stream(destination, std::ios::binary | std::ios::trunc);
      if (stream) {
        stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        ok = stream.good();
        if (ok) bytesWritten = static_cast<unsigned long long>(bytes.size());
      }
    }
  }
  PostToCanvasAsync(L"{\"type\":\"native-write-file-result\",\"requestId\":\"" + JsonEscape(requestId) +
    L"\",\"ok\":" + std::wstring(ok ? L"true" : L"false") +
    L",\"bytes\":" + std::to_wstring(bytesWritten) +
    L",\"path\":\"" + JsonEscape(target) + L"\"}");
}

// ── 随包离线 OCR 引擎（RapidOCR-json / ONNX，约 50MB）────────────────────────────
// 实测（2026-09-13）：中文它比 Windows 自带引擎强（真实中文网页 78.8~80.8% vs 73.5%），
// 且英文数字精确；但**韩文仍以系统 ko 引擎更准**，所以韩语不走它。
struct RapidOcrOutcome {
  bool ok = false;
  std::wstring text;      // 逐行回车换行连接
  std::wstring error;
  long long elapsedMs = 0;
  std::wstring engine = L"RapidOCR";
};

std::filesystem::path BundledRapidOcrFolder() {
  wchar_t module[MAX_PATH]{};
  if (!GetModuleFileNameW(nullptr, module, MAX_PATH)) return {};
  const std::filesystem::path dir = std::filesystem::path(module).parent_path();
  const wchar_t* candidates[] = { L"ocr\\RapidOCR-json", L"RapidOCR-json", L"tools\\ocr\\RapidOCR-json" };
  for (const wchar_t* candidate : candidates) {
    std::error_code error;
    const std::filesystem::path path = dir / candidate;
    if (std::filesystem::exists(path / L"RapidOCR-json.exe", error)) return path;
  }
  return {};
}

// 从 RapidOCR-json 的输出里抠出所有 "text":"..." 的值（它已经按阅读顺序排好）。
std::vector<std::wstring> ExtractOcrTextValues(const std::string& payload) {
  std::vector<std::wstring> lines;
  const std::string needle = "\"text\":\"";
  size_t cursor = 0;
  while ((cursor = payload.find(needle, cursor)) != std::string::npos) {
    size_t index = cursor + needle.size();
    std::string value;
    while (index < payload.size()) {
      const char character = payload[index];
      if (character == '\\' && index + 1 < payload.size()) {
        const char next = payload[index + 1];
        if (next == 'n') value += '\n';
        else if (next == 'r') value += '\r';
        else if (next == 't') value += '\t';
        else value += next;
        index += 2;
        continue;
      }
      if (character == '"') break;
      value += character;
      ++index;
    }
    cursor = index + 1;
    if (!value.empty()) lines.push_back(Utf8ToWide(value));
  }
  return lines;
}

RapidOcrOutcome RunBundledRapidOcr(const std::wstring& imagePath, const std::wstring& language) {
  RapidOcrOutcome outcome;
  const ULONGLONG started = GetTickCount64();
  const std::filesystem::path folder = BundledRapidOcrFolder();
  if (folder.empty()) {
    outcome.error = L"没有找到随包的 OCR 引擎（ocr\\RapidOCR-json）";
    outcome.elapsedMs = static_cast<long long>(GetTickCount64() - started);
    return outcome;
  }
  wchar_t tempBuffer[32768]{};
  if (!GetTempPathW(static_cast<DWORD>(std::size(tempBuffer)), tempBuffer)) {
    outcome.error = L"无法访问临时目录";
    outcome.elapsedMs = static_cast<long long>(GetTickCount64() - started);
    return outcome;
  }
  const auto root = std::filesystem::path(tempBuffer) / L"ZhangZhongJieOcr";
  std::error_code error;
  std::filesystem::create_directories(root, error);
  const std::wstring stamp = std::to_wstring(GetTickCount64());
  const auto outputFile = root / (L"ocr-" + stamp + L".txt");
  const auto batchFile = root / (L"run-ocr-" + stamp + L".cmd");
  const bool englishModel = language == L"en-US";
  {
    std::ofstream batch(batchFile, std::ios::binary | std::ios::trunc);
    batch << "@echo off\r\n";
    batch << "cd /d \"" << WideToUtf8(folder.wstring()) << "\"\r\n";
    batch << "\"RapidOCR-json.exe\" --models=models";
    batch << " --det=ch_PP-OCRv4_det_infer.onnx";
    batch << " --cls=ch_ppocr_mobile_v2.0_cls_infer.onnx";
    batch << " --rec=" << (englishModel ? "rec_en_PP-OCRv3_infer.onnx" : "rec_ch_PP-OCRv4_infer.onnx");
    batch << " --keys=" << (englishModel ? "dict_en.txt" : "ppocr_keys_v1.txt");
    batch << " --image_path=\"" << WideToUtf8(imagePath) << "\"";
    batch << " --ensureAscii=0 --ensureLogger=0";
    batch << " > \"" << WideToUtf8(outputFile.wstring()) << "\" 2>&1\r\n";
    batch << "exit /b %ERRORLEVEL%\r\n";
  }
  const std::wstring command = L"cmd /c \"" + batchFile.wstring() + L"\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    outcome.error = L"无法启动随包 OCR 引擎";
    std::filesystem::remove(batchFile, error);
    outcome.elapsedMs = static_cast<long long>(GetTickCount64() - started);
    return outcome;
  }
  const DWORD waited = WaitForSingleObject(process.hProcess, 60000);
  if (waited == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  std::string raw;
  {
    std::ifstream in(outputFile, std::ios::binary);
    if (in) {
      in.seekg(0, std::ios::end);
      const auto size = in.tellg();
      in.seekg(0, std::ios::beg);
      if (size > 0) {
        raw.resize(static_cast<size_t>(size));
        in.read(&raw[0], static_cast<std::streamsize>(raw.size()));
      }
    }
  }
  const std::vector<std::wstring> lines = ExtractOcrTextValues(raw);
  if (!lines.empty()) {
    std::wstring text;
    for (const auto& line : lines) {
      if (!text.empty()) text += L"\r\n";
      text += line;
    }
    outcome.text = text;
    outcome.ok = true;
  } else {
    outcome.error = L"OCR 引擎没有返回文字（可能这张图没有文字）";
  }
  std::filesystem::remove(outputFile, error);
  std::filesystem::remove(batchFile, error);
  outcome.elapsedMs = static_cast<long long>(GetTickCount64() - started);
  return outcome;
}

struct WindowsOcrOutcome {
  bool ok = false;
  std::wstring language;
  std::wstring text;      // 逐行用回车换行连接
  long long elapsedMs = 0;
  std::wstring error;
};

// 实测（2026-09-13）：韩文必须用 ko 引擎、中文必须用 zh-Hans 引擎；语言选错结果直接变垃圾。
WindowsOcrOutcome RunWindowsOcr(const std::wstring& imagePath, const std::wstring& languageTag) {
  WindowsOcrOutcome outcome;
  const std::wstring wanted = languageTag.empty() ? L"zh-Hans-CN" : languageTag;
  const ULONGLONG started = GetTickCount64();
  try {
    try { winrt::init_apartment(winrt::apartment_type::multi_threaded); } catch (...) {}
    winrt::Windows::Globalization::Language language{ wanted };
    const auto engine = winrt::Windows::Media::Ocr::OcrEngine::TryCreateFromLanguage(language);
    if (!engine) {
      outcome.error = L"系统里没有「" + wanted + L"」的 OCR 语言包（可在 Windows 设置里补装该语言）";
      outcome.elapsedMs = static_cast<long long>(GetTickCount64() - started);
      return outcome;
    }
    outcome.language = std::wstring(engine.RecognizerLanguage().LanguageTag());
    // WinRT 的 StorageFile 只认反斜杠：正斜杠会报「路径包含无效字符」。
    std::wstring nativePath = imagePath;
    for (auto& character : nativePath) {
      if (character == L'/') character = L'\\';
    }
    const auto file = winrt::Windows::Storage::StorageFile::GetFileFromPathAsync(nativePath).get();
    const auto stream = file.OpenReadAsync().get();
    const auto decoder = winrt::Windows::Graphics::Imaging::BitmapDecoder::CreateAsync(stream).get();
    const auto bitmap = decoder.GetSoftwareBitmapAsync().get();
    const auto result = engine.RecognizeAsync(bitmap).get();
    std::wstring text;
    for (const auto& line : result.Lines()) {
      if (!text.empty()) text += L"\r\n";
      text += std::wstring(line.Text());
    }
    outcome.text = text;
    outcome.ok = true;
  } catch (const winrt::hresult_error& error) {
    outcome.error = L"OCR 失败：" + std::wstring(error.message());
  } catch (...) {
    outcome.error = L"OCR 失败：未知错误";
  }
  outcome.elapsedMs = static_cast<long long>(GetTickCount64() - started);
  return outcome;
}

std::filesystem::path CreateDragImageFile(const std::wstring& dataUrl) {
  const size_t comma = dataUrl.find(L',');
  if (comma == std::wstring::npos) return {};
  const std::vector<unsigned char> bytes = Base64Decode(dataUrl.substr(comma + 1));
  if (bytes.empty()) return {};
  wchar_t tempPath[MAX_PATH]{};
  if (!GetTempPathW(static_cast<DWORD>(std::size(tempPath)), tempPath)) return {};
  const std::filesystem::path folder = std::filesystem::path(tempPath) / L"ZhangZhongJieDrag";
  std::error_code error;
  std::filesystem::create_directories(folder, error);
  SYSTEMTIME now{};
  GetLocalTime(&now);
  wchar_t stem[96]{};
  swprintf_s(stem, L"掌中界图片_%04u%02u%02u_%02u%02u%02u", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
  const wchar_t* extension = dataUrl.rfind(L"data:image/png", 0) == 0 ? L".png"
    : dataUrl.rfind(L"data:image/jpeg", 0) == 0 ? L".jpg"
    : dataUrl.rfind(L"data:image/webp", 0) == 0 ? L".webp" : L".png";
  std::filesystem::path output = folder / (std::wstring(stem) + extension);
  for (int suffix = 2; std::filesystem::exists(output, error) && suffix < 1000; ++suffix) {
    output = folder / (std::wstring(stem) + L"_" + std::to_wstring(suffix) + extension);
  }
  std::ofstream stream(output, std::ios::binary);
  if (!stream) return {};
  stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  return stream.good() ? output : std::filesystem::path{};
}

std::wstring ShellItemImageDataUrl(IShellItem* item, int pixels = 32, bool* imageIsThumbnail = nullptr,
    ULONG* imageWidth = nullptr, ULONG* imageHeight = nullptr, bool cacheOnly = false,
    const std::wstring& knownPath = {}) {
  if (imageIsThumbnail) *imageIsThumbnail = false;
  if (imageWidth) *imageWidth = 0;
  if (imageHeight) *imageHeight = 0;
  if (!item) return {};
  ComPtr<IShellItemImageFactory> factory;
  if (FAILED(item->QueryInterface(IID_PPV_ARGS(&factory))) || !factory) return {};
  std::wstring breadcrumbPath = knownPath;
  if (breadcrumbPath.empty()) {
    PWSTR rawBreadcrumbPath = nullptr;
    if (SUCCEEDED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &rawBreadcrumbPath)) && rawBreadcrumbPath) {
      breadcrumbPath = rawBreadcrumbPath;
      CoTaskMemFree(rawBreadcrumbPath);
    }
  }
  HBITMAP bitmap = nullptr;
  const SIZE size{pixels, pixels};
  // 缩略图优先；没有缩略图时必须退回 Shell 自己的图标，绝不按后缀伪造。
  const auto thumbnailFlags = static_cast<SIIGBF>(SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK |
    (cacheOnly ? SIIGBF_INCACHEONLY : 0));
  HRESULT result = ExtractShellItemImage(factory.Get(), breadcrumbPath, size, thumbnailFlags, &bitmap);
  if (SUCCEEDED(result) && bitmap) {
    if (imageIsThumbnail) *imageIsThumbnail = true;
  } else {
    if (bitmap) DeleteObject(std::exchange(bitmap, nullptr));
    if (cacheOnly) return {};
    // Shell icons are commonly only 32/48 px. Never ask Shell to upscale one
    // to a media tile; Web centers it or replaces it with a vector glyph.
    const SIZE iconSize{std::min(pixels, 64), std::min(pixels, 64)};
    result = ExtractShellItemImage(factory.Get(), breadcrumbPath, iconSize, SIIGBF_ICONONLY, &bitmap);
  }
  if (FAILED(result) || !bitmap) {
    if (bitmap) DeleteObject(bitmap);
    return {};
  }
  BITMAP object{};
  if (GetObjectW(bitmap, sizeof(object), &object)) {
    if (imageWidth) *imageWidth = static_cast<ULONG>(std::max<LONG>(0, object.bmWidth));
    if (imageHeight) *imageHeight = static_cast<ULONG>(std::abs(object.bmHeight));
  }
  const std::wstring url = BitmapPngDataUrl(bitmap, true, true);
  DeleteObject(bitmap);
  return url;
}

constexpr size_t kThumbnailCacheMaximumFiles = 20000;
constexpr uintmax_t kThumbnailCacheMaximumBytes = 500ULL * 1024ULL * 1024ULL;

std::filesystem::path ThumbnailCacheFolder() {
  return std::filesystem::path(g_dataFolder) / L"thumbs";
}

bool ThumbnailSourceStamp(const std::wstring& path, ULONGLONG& stamp) {
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes)) return false;
  ULARGE_INTEGER value{};
  value.LowPart = attributes.ftLastWriteTime.dwLowDateTime;
  value.HighPart = attributes.ftLastWriteTime.dwHighDateTime;
  stamp = value.QuadPart;
  return true;
}

std::wstring NormalizedThumbnailSource(const std::wstring& path) {
  std::wstring normalized(path);
  std::replace(normalized.begin(), normalized.end(), L'/', L'\\');
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), ::towlower);
  return normalized;
}

std::wstring ThumbnailCacheKey(const std::wstring& path, ULONGLONG stamp, int pixels) {
  std::wstring normalized = NormalizedThumbnailSource(path);
  // 版本串：缩略图生成逻辑变化时递增，让旧产物（磁盘 / 内存 / WebView2 三层缓存）
  // 全部自然失效，重新生成修复后的图。
  normalized += L'|' + std::to_wstring(stamp) + L'|' + std::to_wstring(pixels) + L"|v2-blackfix";
  uint64_t hash = 1469598103934665603ULL;
  for (const wchar_t ch : normalized) {
    hash ^= static_cast<uint16_t>(ch);
    hash *= 1099511628211ULL;
  }
  wchar_t encoded[17]{};
  swprintf_s(encoded, L"%016llx", static_cast<unsigned long long>(hash));
  return encoded;
}

void EnsureThumbnailCacheIndexLocked() {
  if (g_thumbnailCacheIndexed) return;
  g_thumbnailCacheIndexed = true;
  const auto folder = ThumbnailCacheFolder();
  std::error_code error;
  std::filesystem::create_directories(folder, error);
  error.clear();
  for (std::filesystem::directory_iterator iterator(folder, error), end; !error && iterator != end; iterator.increment(error)) {
    if (!iterator->is_regular_file(error) || error) { error.clear(); continue; }
    const auto extension = iterator->path().extension().wstring();
    if (_wcsicmp(extension.c_str(), L".png") != 0) continue;
    ThumbnailCacheFile entry;
    entry.path = iterator->path();
    entry.bytes = iterator->file_size(error);
    if (error) { error.clear(); continue; }
    entry.accessed = iterator->last_write_time(error);
    if (error) { error.clear(); continue; }
    g_thumbnailCacheBytes += entry.bytes;
    g_thumbnailCacheFiles[entry.path.filename().wstring()] = std::move(entry);
  }
}

void EvictThumbnailCacheLocked() {
  while (g_thumbnailCacheFiles.size() > kThumbnailCacheMaximumFiles ||
         g_thumbnailCacheBytes > kThumbnailCacheMaximumBytes) {
    auto oldest = g_thumbnailCacheFiles.end();
    for (auto iterator = g_thumbnailCacheFiles.begin(); iterator != g_thumbnailCacheFiles.end(); ++iterator) {
      if (oldest == g_thumbnailCacheFiles.end() || iterator->second.accessed < oldest->second.accessed) oldest = iterator;
    }
    if (oldest == g_thumbnailCacheFiles.end()) break;
    std::error_code error;
    const bool removed = std::filesystem::remove(oldest->second.path, error);
    if (error || (!removed && std::filesystem::exists(oldest->second.path, error))) break;
    g_thumbnailCacheBytes -= std::min(g_thumbnailCacheBytes, oldest->second.bytes);
    g_thumbnailCacheFiles.erase(oldest);
  }
}

struct ThumbnailDiskResult {
  std::wstring dataUrl;
  std::filesystem::path path;
  bool thumbnail = false;
};

ThumbnailDiskResult ReadThumbnailDiskCache(const std::wstring& source, int pixels, bool includeData = true) {
  ULONGLONG stamp = 0;
  if (!ThumbnailSourceStamp(source, stamp)) return {};
  const std::wstring key = ThumbnailCacheKey(source, stamp, pixels);
  for (const auto& kind : {std::pair<const wchar_t*, bool>{L".thumb.png", true}, {L".icon.png", false}}) {
    const std::wstring name = key + kind.first;
    std::filesystem::path cachePath;
    uintmax_t cacheBytes = 0;
    {
      std::lock_guard<std::mutex> lock(g_thumbnailCacheMutex);
      EnsureThumbnailCacheIndexLocked();
      const auto found = g_thumbnailCacheFiles.find(name);
      if (found == g_thumbnailCacheFiles.end()) continue;
      cachePath = found->second.path;
      cacheBytes = found->second.bytes;
    }
    std::ifstream stream(cachePath, std::ios::binary);
    if (!stream) {
      std::lock_guard<std::mutex> lock(g_thumbnailCacheMutex);
      const auto found = g_thumbnailCacheFiles.find(name);
      if (found != g_thumbnailCacheFiles.end() && found->second.path == cachePath) {
        g_thumbnailCacheBytes -= std::min(g_thumbnailCacheBytes, cacheBytes);
        g_thumbnailCacheFiles.erase(found);
      }
      continue;
    }
    std::vector<unsigned char> bytes;
    if (includeData) {
      stream.seekg(0, std::ios::end);
      const auto size = stream.tellg();
      if (size <= 0 || static_cast<uintmax_t>(size) > kThumbnailCacheMaximumBytes) continue;
      bytes.resize(static_cast<size_t>(size));
      stream.seekg(0, std::ios::beg);
      stream.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
      if (!stream) continue;
    } else {
      std::array<char, 64 * 1024> warm{};
      while (stream.read(warm.data(), static_cast<std::streamsize>(warm.size())) || stream.gcount() > 0) {}
    }
    const auto now = std::filesystem::file_time_type::clock::now();
    std::error_code touchError;
    std::filesystem::last_write_time(cachePath, now, touchError);
    {
      std::lock_guard<std::mutex> lock(g_thumbnailCacheMutex);
      const auto found = g_thumbnailCacheFiles.find(name);
      if (found != g_thumbnailCacheFiles.end() && found->second.path == cachePath) found->second.accessed = now;
    }
    ThumbnailDiskResult result;
    result.path = cachePath;
    result.thumbnail = kind.second;
    if (includeData) {
      const std::string encoded = Base64Encode(bytes.data(), bytes.size());
      result.dataUrl.assign(L"data:image/png;base64,");
      result.dataUrl.append(encoded.begin(), encoded.end());
    }
    return result;
  }
  return {};
}

std::filesystem::path WriteThumbnailDiskCache(const std::wstring& source, int pixels,
                                               const std::wstring& dataUrl, bool thumbnail) {
  const size_t comma = dataUrl.find(L',');
  ULONGLONG stamp = 0;
  if (comma == std::wstring::npos || !ThumbnailSourceStamp(source, stamp)) return {};
  const auto bytes = Base64Decode(dataUrl.substr(comma + 1));
  if (bytes.empty()) return {};
  const std::wstring key = ThumbnailCacheKey(source, stamp, pixels);
  const std::wstring name = key + (thumbnail ? L".thumb.png" : L".icon.png");
  const std::wstring alternate = key + (thumbnail ? L".icon.png" : L".thumb.png");
  std::lock_guard<std::mutex> lock(g_thumbnailCacheMutex);
  EnsureThumbnailCacheIndexLocked();
  const auto destination = ThumbnailCacheFolder() / name;
  const auto temporary = ThumbnailCacheFolder() / (name + L".tmp");
  {
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    if (!stream) return {};
    stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!stream) { std::error_code ignored; std::filesystem::remove(temporary, ignored); return {}; }
  }
  std::error_code error;
  std::filesystem::rename(temporary, destination, error);
  if (error) {
    error.clear();
    std::filesystem::remove(destination, error);
    error.clear();
    std::filesystem::rename(temporary, destination, error);
  }
  if (error) { error.clear(); std::filesystem::remove(temporary, error); return {}; }
  if (const auto old = g_thumbnailCacheFiles.find(name); old != g_thumbnailCacheFiles.end()) {
    g_thumbnailCacheBytes -= std::min(g_thumbnailCacheBytes, old->second.bytes);
  }
  const auto now = std::filesystem::file_time_type::clock::now();
  std::filesystem::last_write_time(destination, now, error);
  g_thumbnailCacheFiles[name] = {destination, bytes.size(), now};
  g_thumbnailCacheBytes += bytes.size();
  if (const auto old = g_thumbnailCacheFiles.find(alternate); old != g_thumbnailCacheFiles.end()) {
    if (std::filesystem::remove(old->second.path, error) || (!error && !std::filesystem::exists(old->second.path, error))) {
      g_thumbnailCacheBytes -= std::min(g_thumbnailCacheBytes, old->second.bytes);
      g_thumbnailCacheFiles.erase(old);
    }
  }
  EvictThumbnailCacheLocked();
  return destination;
}

std::wstring ThumbnailHostForSurface(const std::wstring& surfaceId) {
  std::wostringstream host;
  host << L"thumb-" << std::hex << std::hash<std::wstring>{}(surfaceId)
       << L".zhangzhongjie.local";
  return host.str();
}

void ResetThumbnailRoute(const std::wstring& surfaceId, const std::vector<ShellEntry>& entries) {
  ThumbnailRoute route;
  route.surfaceId = surfaceId;
  for (const auto& entry : entries) {
    if (!entry.parsingName.empty()) route.displayedPaths.insert(NormalizedThumbnailSource(entry.parsingName));
  }
  std::lock_guard<std::mutex> lock(g_thumbnailRoutesMutex);
  g_thumbnailRoutes[ThumbnailHostForSurface(surfaceId)] = std::move(route);
}

std::wstring RegisterThumbnailResource(const std::wstring& surfaceId, const std::wstring& source,
                                       const std::filesystem::path& cachePath) {
  if (cachePath.empty()) return {};
  std::wstring cacheKey = cachePath.filename().wstring();
  const size_t suffixAt = cacheKey.find(L'.');
  if (suffixAt == std::wstring::npos || suffixAt == 0) return {};
  cacheKey.resize(suffixAt);
  const std::wstring host = ThumbnailHostForSurface(surfaceId);
  const std::wstring normalized = NormalizedThumbnailSource(source);
  std::lock_guard<std::mutex> lock(g_thumbnailRoutesMutex);
  const auto found = g_thumbnailRoutes.find(host);
  if (found == g_thumbnailRoutes.end() || found->second.surfaceId != surfaceId ||
      !found->second.displayedPaths.contains(normalized)) return {};
  found->second.resources[normalized] = {cachePath, cacheKey};
  return L"https://" + host + L"/" + UrlEncode(source) + L"?v=" + cacheKey;
}

std::wstring ShellItemIconDataUrl(IShellItem* item, int pixels = 32, const std::wstring& knownPath = {}) {
  if (!item) return {};
  ComPtr<IShellItemImageFactory> factory;
  if (FAILED(item->QueryInterface(IID_PPV_ARGS(&factory))) || !factory) return {};
  std::wstring breadcrumbPath = knownPath;
  if (breadcrumbPath.empty()) {
    PWSTR rawBreadcrumbPath = nullptr;
    if (SUCCEEDED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &rawBreadcrumbPath)) && rawBreadcrumbPath) {
      breadcrumbPath = rawBreadcrumbPath;
      CoTaskMemFree(rawBreadcrumbPath);
    }
  }
  HBITMAP bitmap = nullptr;
  const SIZE size{std::min(pixels, 64), std::min(pixels, 64)};
  if (FAILED(ExtractShellItemImage(factory.Get(), breadcrumbPath, size, SIIGBF_ICONONLY, &bitmap)) || !bitmap) return {};
  std::wstring url;
  try {
    url = BitmapPngDataUrl(bitmap);
  } catch (const std::bad_alloc&) {
    OutputDebugStringW(L"[ZhangZhongJie] Shell image allocation failed.\n");
  } catch (...) {
    OutputDebugStringW(L"[ZhangZhongJie] Shell image conversion failed.\n");
  }
  DeleteObject(bitmap);
  return url;
}

void SendShellIcon(const std::wstring& requestId, const std::wstring& parsingName, int pixels) {
  if (requestId.empty() || parsingName.empty()) return;
  ComPtr<IShellItem> item;
  HRESULT result = parsingName == L"shell:MyComputerFolder"
    ? SHGetKnownFolderItem(FOLDERID_ComputerFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&item))
    : SHCreateItemFromParsingName(parsingName.c_str(), nullptr, IID_PPV_ARGS(&item));
  std::wstring image;
  if (SUCCEEDED(result) && item) image = ShellItemImageDataUrl(
    item.Get(), std::clamp(pixels, 16, 64), nullptr, nullptr, nullptr, false, parsingName);
  PostToCanvas(L"{\"type\":\"native-shell-icon\",\"requestId\":\"" + JsonEscape(requestId) +
    L"\",\"path\":\"" + JsonEscape(parsingName) + L"\",\"image\":\"" + JsonEscape(image) + L"\"}");
}

void CaptureSurfaceSnapshot(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface) return;
  // CompositionController content is not represented by a child HWND. Capturing
  // its shared composition host would produce the whole application, so use
  // WebView2's own asynchronous preview pipeline for browser surfaces.
  if (surface->webView) {
    ComPtr<IStream> stream;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) || !stream) return;
    const std::wstring surfaceId = surface->id;
    const unsigned long long revision = ++surface->snapshotRevision;
    const HRESULT started = surface->webView->CapturePreview(
      COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
      stream.Get(),
      Callback<ICoreWebView2CapturePreviewCompletedHandler>(
        [stream, surface, surfaceId, revision](HRESULT result) -> HRESULT {
          if (FAILED(result) || surface->snapshotRevision != revision) return S_OK;
          HGLOBAL memory = nullptr;
          if (FAILED(GetHGlobalFromStream(stream.Get(), &memory)) || !memory) return S_OK;
          const SIZE_T size = GlobalSize(memory);
          const auto* bytes = static_cast<const unsigned char*>(GlobalLock(memory));
          if (!bytes || !size) {
            if (bytes) GlobalUnlock(memory);
            return S_OK;
          }
          const std::string encoded = Base64Encode(bytes, static_cast<size_t>(size));
          GlobalUnlock(memory);
          std::wstring wide(encoded.begin(), encoded.end());
          PostToCanvas(L"{\"type\":\"native-surface-snapshot\",\"surfaceId\":\"" +
            JsonEscape(surfaceId) + L"\",\"image\":\"data:image/png;base64," + wide + L"\"}");
          return S_OK;
        }).Get());
    if (SUCCEEDED(started)) return;
  }
  if (!surface->host) return;
  RECT client{};
  GetClientRect(surface->host, &client);
  const int sourceWidth = client.right - client.left;
  const int sourceHeight = client.bottom - client.top;
  if (sourceWidth < 8 || sourceHeight < 8) return;

  // 快照按 720 宽封顶，base64 体积才不会失控。
  const double shrink = std::min(1.0, 720.0 / sourceWidth);
  const int width = std::max(8, static_cast<int>(sourceWidth * shrink));
  const int height = std::max(8, static_cast<int>(sourceHeight * shrink));

  HDC screen = GetDC(nullptr);
  HDC full = CreateCompatibleDC(screen);
  HDC scaled = CreateCompatibleDC(screen);
  BITMAPINFO fullInfo{};
  fullInfo.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  fullInfo.bmiHeader.biWidth = sourceWidth;
  fullInfo.bmiHeader.biHeight = -sourceHeight;
  fullInfo.bmiHeader.biPlanes = 1;
  fullInfo.bmiHeader.biBitCount = 24;
  fullInfo.bmiHeader.biCompression = BI_RGB;
  void* fullBits = nullptr;
  HBITMAP fullBitmap = CreateDIBSection(screen, &fullInfo, DIB_RGB_COLORS, &fullBits, nullptr, 0);

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 24;
  info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);

  if (fullBitmap && bitmap && fullBits && bits) {
    HGDIOBJ oldFull = SelectObject(full, fullBitmap);
    // PrintWindow 对 Shell 视图和 WebView2 这类硬件合成内容返回全黑，无论带不带
    // PW_RENDERFULLCONTENT。改成直接从屏幕 DC 抓：窗口此刻还显示着，抓到的就是
    // 用户看到的画面。代价是万一有别的窗口压在上面会一起抓进来。
    POINT origin{0, 0};
    ClientToScreen(surface->host, &origin);
    BitBlt(full, 0, 0, sourceWidth, sourceHeight, screen, origin.x, origin.y, SRCCOPY);
    HGDIOBJ oldScaled = SelectObject(scaled, bitmap);
    SetStretchBltMode(scaled, HALFTONE);
    StretchBlt(scaled, 0, 0, width, height, full, 0, 0, sourceWidth, sourceHeight, SRCCOPY);
    SelectObject(scaled, oldScaled);
    SelectObject(full, oldFull);

    const std::wstring image = BitmapPngDataUrl(bitmap);
    if (!image.empty()) {
      PostToCanvas(L"{\"type\":\"native-surface-snapshot\",\"surfaceId\":\"" + JsonEscape(surface->id) +
        L"\",\"image\":\"" + image + L"\"}");
    }
  }

  if (fullBitmap) DeleteObject(fullBitmap);
  if (bitmap) DeleteObject(bitmap);
  DeleteDC(full);
  DeleteDC(scaled);
  ReleaseDC(nullptr, screen);
}

void RestackSurfaces() {
  std::vector<std::shared_ptr<NativeSurface>> ordered;
  ordered.reserve(g_surfaces.size());
  // Semantic-only Explorer hosts are permanently hidden Shell engines. They do not
  // participate in painting, clipping or z-order; only namespace fallbacks do.
  for (const auto& surface : g_surfaces) {
    if (surface->host && !surface->semanticOnly) ordered.push_back(surface);
  }
  std::stable_sort(ordered.begin(), ordered.end(),
    [](const auto& a, const auto& b) { return a->order < b->order; });
  HWND previous = HWND_TOP;
  for (const auto& surface : ordered) {
    SetWindowPos(surface->host, previous, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    previous = surface->host;
  }
  if (g_compositionRoot) {
    std::vector<std::shared_ptr<NativeSurface>> visuals;
    for (const auto& surface : g_surfaces) if (surface->compositionVisual) visuals.push_back(surface);
    std::stable_sort(visuals.begin(), visuals.end(),
      [](const auto& a, const auto& b) { return a->order < b->order; });
    for (const auto& surface : visuals) g_compositionRoot->RemoveVisual(surface->compositionVisual.Get());
    for (const auto& surface : visuals) g_compositionRoot->AddVisual(surface->compositionVisual.Get(), TRUE, nullptr);
    if (g_compositionDevice) g_compositionDevice->Commit();
    if (g_compositionHost) SetWindowPos(g_compositionHost, HWND_TOP, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}

void CreateExplorerSurface(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || surface->explorer) return;
  if (!EnsureSurfaceHost(surface)) return;
  if (FAILED(CoCreateInstance(CLSID_ExplorerBrowser, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&surface->explorer)))) return;
  // EBO_SHOWFRAMES 确实带来了导航窗格，但它同时带回了 Explorer 的经典命令栏
  // （组织 / 系统属性 / 映射网络驱动器）。那条命令栏是不支持深色模式的旧式
  // 控件，在深色宿主里是一条白底白字、完全读不出来的横条，正是交接文档
  // 22 P1-UI-3 要求移除的东西。这里退回 EBO_NONE；导航树改由掌中界自己按
  // 深色主题绘制，路径与命令走顶部工具栏。
  surface->explorer->SetOptions(EBO_NONE);
  FOLDERSETTINGS settings{FVM_DETAILS, FWF_AUTOARRANGE | FWF_SHOWSELALWAYS};
  RECT client{};
  GetClientRect(surface->host, &client);
  if (FAILED(surface->explorer->Initialize(surface->host, &client, &settings))) {
    surface->explorer.Reset();
    return;
  }
  const bool missingZip = HasZipExtension(surface->source) &&
    GetFileAttributesW(surface->source.c_str()) == INVALID_FILE_ATTRIBUTES;
  const HRESULT browseResult = missingZip ? HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
                                          : BrowseExplorer(surface, surface->source);
  if (FAILED(browseResult)) {
    PostToCanvas(L"{\"type\":\"native-explorer-error\",\"surfaceId\":\"" + JsonEscape(surface->id) +
      L"\",\"message\":\"" + std::wstring(missingZip
        ? L"找不到压缩包，文件可能已被移动或删除"
        : L"无法打开此位置，请确认路径仍然存在") + L"\"}");
    // 冷盘/外壳瞬态失败会让导航失败并让卡片永久卡死（此前无任何重试）。
    // 现在登记自动重试；成功后状态计时器会重新枚举、卡片自动恢复。
    if (!missingZip) {
      surface->browseRetryAttempt = 0;
      surface->browseRetryAt = GetTickCount64() + 600;
    }
    wchar_t browseFailureLine[512]{};
    swprintf_s(browseFailureLine, L"explorer browse failed hr=0x%08lX retry=%s path=%s",
      static_cast<unsigned long>(browseResult), missingZip ? L"no" : L"yes", surface->source.c_str());
    WriteLifecycleLog(browseFailureLine);
  }
  SetTimer(g_mainWindow, kExplorerStateTimer, 350, nullptr);
  SetTimer(g_mainWindow, kHeartbeatTimer, 60000, nullptr);
  ApplyDarkExplorerTheme(surface->host);
  ApplyExplorerVisualProperties(surface);
  SetTimer(surface->host, 1, 900, nullptr);
  SyncSurfaceGeometry(surface);
}

void CreateShellViewSurface(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || surface->explorer) return;
  if (!EnsureSurfaceHost(surface)) return;
  if (FAILED(CoCreateInstance(CLSID_ExplorerBrowser, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&surface->explorer)))) return;
  surface->explorer->SetOptions(EBO_NONE);
  FOLDERSETTINGS settings{FVM_THUMBNAIL, FWF_AUTOARRANGE | FWF_SHOWSELALWAYS};
  RECT client{};
  GetClientRect(surface->host, &client);
  if (FAILED(surface->explorer->Initialize(surface->host, &client, &settings))) {
    surface->explorer.Reset();
    return;
  }
  BrowseExplorer(surface, surface->source);
  SyncSurfaceGeometry(surface);
}

void SendBrowserNavigation(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || !surface->webView) return;
  LPWSTR source = nullptr;
  LPWSTR title = nullptr;
  surface->webView->get_Source(&source);
  surface->webView->get_DocumentTitle(&title);
  const std::wstring sourceValue = source ? source : L"";
  const std::wstring titleValue = title ? title : L"";
  if (source) CoTaskMemFree(source);
  if (title) CoTaskMemFree(title);
  PostToCanvas(L"{\"type\":\"native-surface-navigation\",\"surfaceId\":\"" + JsonEscape(surface->id) +
    L"\",\"source\":\"" + JsonEscape(sourceValue) + L"\",\"title\":\"" + JsonEscape(titleValue) + L"\"}");
}

void ApplyBrowserColorScheme(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || !surface->webView) return;
  ComPtr<ICoreWebView2_13> webView13;
  if (FAILED(surface->webView.As(&webView13)) || !webView13) return;
  ComPtr<ICoreWebView2Profile> profile;
  if (FAILED(webView13->get_Profile(&profile)) || !profile) return;
  const COREWEBVIEW2_PREFERRED_COLOR_SCHEME scheme = g_webThemeMode == L"dark"
    ? COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK
    : g_webThemeMode == L"original"
      ? COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT
      : (g_appThemeDark ? COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK
                        : COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT);
  profile->put_PreferredColorScheme(scheme);
}

void ApplyBrowserColorSchemeToAll() {
  for (const auto& surface : g_surfaces) {
    if (surface && surface->kind == L"browser") ApplyBrowserColorScheme(surface);
  }
}

// 视频「右键 → 画中画」注入脚本（2026-09-13 用户要求）：不依赖各站播放器结构（bilibili / huya / kanju
// 每家 DOM 都不一样、同一个站不同视频也不一样），所以一律按「几何位置命中最大的 <video>」来认播放器：
// 捕获阶段拦下视频上的右键 → 画自己的小菜单（画中画 / 退出画中画），点菜单项就在用户真实手势里调原生画中画 API。
// 脚本幂等（window.__zzjPipMenu 标记），每次导航完注入一次即可。
static const wchar_t* kPipRightClickHook = LR"ZZJ((function(){if(window.__zzjPipMenu)return '{"ok":true,"already":1}';var T={};window.__zzjPipMenu=true;window.__zzjPipHookToken=T;var ID='zzj-pip-menu';function close(){var m=document.getElementById(ID);if(!m)return;try{m.remove();}catch(e){try{if(m.parentNode)m.parentNode.removeChild(m);}catch(e2){}}}function report(s){try{if(window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage)window.chrome.webview.postMessage({type:'zzj-pip-state',state:s});}catch(e){}}window.__zzjPipExit=function(){try{document.exitPictureInPicture();}catch(e){}try{if(window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage)window.chrome.webview.postMessage({type:'native-log-pip-hook',note:'exit-fn called'});}catch(e){}};document.addEventListener('enterpictureinpicture',function(){if(window.__zzjPipHookToken!==T)return;report('enter');},true);document.addEventListener('leavepictureinpicture',function(){if(window.__zzjPipHookToken!==T)return;report('exit');},true);function big(){var l=document.querySelectorAll('video'),b=null,a=0;for(var i=0;i<l.length;i++){var v=l[i],r=v.getBoundingClientRect();if(r.width<80||r.height<60)continue;var ar=(v.videoWidth||r.width)*(v.videoHeight||r.height);if(ar>a){a=ar;b=v;}}return b;}function at(x,y){var l=document.querySelectorAll('video');for(var i=l.length-1;i>=0;i--){var r=l[i].getBoundingClientRect();if(r.width<80||r.height<60)continue;if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return l[i];}return null;}function style(){if(document.getElementById(ID+'-css'))return;var s=document.createElement('style');s.id=ID+'-css';s.textContent='#'+ID+'{position:fixed;z-index:2147483647;min-width:190px;padding:6px 0;border-radius:10px;background:rgba(28,28,30,.97);box-shadow:0 10px 28px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);font:12px/1.4 \"Microsoft YaHei\",system-ui,sans-serif;color:#eaeaea;user-select:none}#'+ID+' button{display:flex;width:100%;align-items:center;gap:8px;height:30px;padding:0 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:4px}#'+ID+' button:hover{background:rgba(255,255,255,.10)}#'+ID+' button[disabled]{opacity:.45;cursor:default}#'+ID+' i{width:14px;text-align:center;font-style:normal;opacity:.85}';(document.head||document.documentElement).appendChild(s);}function show(x,y){style();close();var alive=document.pictureInPictureEnabled===true;var on=!!document.pictureInPictureElement;var m=document.createElement('div');m.id=ID;var h='';if(on){h+='<button data-a="exit"><i>\u25f1</i>退出画中画</button>';}else{h+='<button data-a="enter"'+(alive?'':' disabled')+'><i>\u25f1</i>画中画（浮在最上层）</button>';}if(!alive)h+='<button disabled><i>!</i>此网页不支持画中画</button>';h+='<button data-a="close"><i>\u2715</i>关闭</button>';m.innerHTML=h;document.documentElement.appendChild(m);var r=m.getBoundingClientRect();m.style.left=Math.max(4,Math.min(x,window.innerWidth-r.width-6))+'px';m.style.top=Math.max(4,Math.min(y,window.innerHeight-r.height-6))+'px';m.addEventListener('click',function(ev){var b=ev.target&&ev.target.closest?ev.target.closest('button'):null;if(!b)return;ev.preventDefault();ev.stopPropagation();var a=b.getAttribute('data-a');var v=window.__zzjPipTarget;try{if(a==='enter'&&v){var q=v.requestPictureInPicture();if(q&&q.catch)q.catch(function(){});}else if(a==='exit'){document.exitPictureInPicture();}}catch(e){}try{if(a!=='close'&&window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage)window.chrome.webview.postMessage({type:'native-log-pip-hook',note:'menu '+a+' '+(location.host||'')});}catch(e){}close();},true);}document.addEventListener('contextmenu',function(e){if(window.__zzjPipHookToken!==T)return;if(document.getElementById(ID)){close();return;}var v=null,t=e.target;if(t&&t.closest)v=t.closest('video');if(!v)v=at(e.clientX,e.clientY);if(!v){var b=big();if(b){var r=b.getBoundingClientRect();if(e.clientX>=r.left-40&&e.clientX<=r.right+40&&e.clientY>=r.top-40&&e.clientY<=r.bottom+40)v=b;}}if(!v)return;window.__zzjPipTarget=v;e.preventDefault();e.stopPropagation();show(e.clientX,e.clientY);},true);document.addEventListener('pointerdown',function(e){if(window.__zzjPipHookToken!==T)return;var m=document.getElementById(ID);if(m&&!m.contains(e.target))close();},true);document.addEventListener('keydown',function(e){if(window.__zzjPipHookToken!==T)return;if(e.key==='Escape')close();},true);window.addEventListener('blur',function(){if(window.__zzjPipHookToken!==T)return;close();},true);try{if(window.chrome&&window.chrome.webview&&window.chrome.webview.postMessage)window.chrome.webview.postMessage({type:'native-log-pip-hook',note:'installed pipEnabled='+(document.pictureInPictureEnabled===true)+' '+(location.host||'')});}catch(e){}return '{"ok":true,"installed":1,"pipEnabled":'+(document.pictureInPictureEnabled===true)+'}';})())ZZJ";

// ===== 系统画中画（PiP）：进画中画时把原网页让出来，双击画中画窗口 = 退出并恢复 =====
// 用户要求（2026-09-13）：「打开画中画 原来的网页自动隐藏，画中画 双击退出 变回原来网页」。
// 难点：系统画中画窗口是 msedgewebview2 进程的独立顶层窗口，网页侧收不到它的输入，Chromium 自己也不响应双击。
// 做法：进画中画时快照一次顶层窗口，再定时去认「新出现的那个」＝画中画窗口；只在画中画期间挂 WH_MOUSE_LL 认双击，退出即摘。
// 钩子只做判断、不干重活：认出双击就 PostMessage 回窗口过程，由那里去 ExecuteScript 让页面 exitPictureInPicture。
HWND g_pipWindow = nullptr;
// 画中画窗口默认被 Chromium 丢在屏幕右下角；用户要求「直接出现在屏幕中间」。

// 只挪位置不缩放；居中在「掌中界窗口所在的那块显示器」的工作区里（多屏时不会跑到另一块屏）。

static void CenterPipWindow(HWND pip) {

  if (!pip || !IsWindow(pip)) return;

  RECT rect{};

  if (!GetWindowRect(pip, &rect)) return;

  const int width = rect.right - rect.left;

  const int height = rect.bottom - rect.top;

  if (width <= 0 || height <= 0) return;

  HMONITOR monitor = MonitorFromWindow(g_mainWindow ? g_mainWindow : pip, MONITOR_DEFAULTTONEAREST);

  MONITORINFO info{};

  info.cbSize = sizeof(info);

  if (!GetMonitorInfoW(monitor, &info)) return;

  const int x = info.rcWork.left + ((info.rcWork.right - info.rcWork.left) - width) / 2;

  const int y = info.rcWork.top + ((info.rcWork.bottom - info.rcWork.top) - height) / 2;

  SetWindowPos(pip, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);

  WriteLifecycleLog((L"pip: centered at " + std::to_wstring(x) + L"," + std::to_wstring(y)).c_str());

}

std::vector<HWND> g_pipBaselineWindows;
HHOOK g_pipMouseHook = nullptr;
DWORD g_pipLastDownTick = 0;
POINT g_pipLastDownPoint{};
int g_pipWatchTries = 0;

static DWORD WebViewBrowserProcessId(ICoreWebView2* view) {
  UINT32 pid = 0;
  if (view && SUCCEEDED(view->get_BrowserProcessId(&pid))) return static_cast<DWORD>(pid);
  return 0;
}

static bool IsWebViewBrowserProcessWindow(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (!pid) return false;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return false;
  wchar_t buffer[1024]{};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  bool matched = false;
  if (QueryFullProcessImageNameW(process, 0, buffer, &size)) {
    std::wstring name(buffer, size);
    for (auto& ch : name) ch = static_cast<wchar_t>(towlower(ch));
    matched = name.find(L"msedgewebview2.exe") != std::wstring::npos;
  }
  CloseHandle(process);
  return matched;
}

static BOOL CALLBACK CollectTopLevelWebViewWindowsProc(HWND hwnd, LPARAM param) {
  auto* list = reinterpret_cast<std::vector<HWND>*>(param);
  if (IsWindowVisible(hwnd) && IsWebViewBrowserProcessWindow(hwnd)) list->push_back(hwnd);
  return TRUE;
}

static std::vector<HWND> CollectTopLevelWebViewWindows() {
  std::vector<HWND> list;
  EnumWindows(CollectTopLevelWebViewWindowsProc, reinterpret_cast<LPARAM>(&list));
  return list;
}

void UninstallPipMouseHook() {
  if (g_pipMouseHook) { UnhookWindowsHookEx(g_pipMouseHook); g_pipMouseHook = nullptr; }
  g_pipWindow = nullptr;
  g_pipLastDownTick = 0;
  g_pipWatchTries = 0;
  if (g_mainWindow) KillTimer(g_mainWindow, kPipWatchTimer);
}

static LRESULT CALLBACK PipMouseHookProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION && wParam == WM_LBUTTONDOWN && g_pipWindow && IsWindow(g_pipWindow) && IsWindowVisible(g_pipWindow)) {
    const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
    RECT rect{};
    if (info && GetWindowRect(g_pipWindow, &rect)) {

      const POINT point = info->pt;
      if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
        const DWORD now = GetTickCount();
        const bool sameSpot = std::abs(point.x - g_pipLastDownPoint.x) <= 8 && std::abs(point.y - g_pipLastDownPoint.y) <= 8;
        if (g_pipLastDownTick && now - g_pipLastDownTick <= GetDoubleClickTime() && sameSpot) {
          g_pipLastDownTick = 0;
          if (g_mainWindow) PostMessageW(g_mainWindow, kPipExitRequestMessage, 0, 0);
        } else {
          g_pipLastDownTick = now;
          g_pipLastDownPoint = point;
        }
      }
    }
  }
  return CallNextHookEx(g_pipMouseHook, code, wParam, lParam);
}

void InstallPipMouseHook() {
  if (g_pipMouseHook) return;
  g_pipMouseHook = SetWindowsHookExW(WH_MOUSE_LL, PipMouseHookProc, GetModuleHandleW(nullptr), 0);
  WriteLifecycleLog(g_pipMouseHook ? L"pip: mouse hook installed (double-click PiP window = exit)"
                                   : L"pip: mouse hook FAILED to install");
}

void RequestPipExitFromPage() {
  const auto surface = FindSurface(g_pipSurfaceId);
  if (!surface || !surface->webView) {
    // 兜底：画中画不是卡片里那个视频（或卡片已经不在）时，直接让持有画中画的那个页面自己退出。
    if (g_appWebView) g_appWebView->ExecuteScript(L"(function(){try{document.exitPictureInPicture()}catch(e){}})()", nullptr);
    WriteLifecycleLog(L"pip: exit requested but surface is gone -> asked the app page to exit instead");
    return;
  }
  // 让页面自己退出（页面里的 leavepictureinpicture → 回报 → Web 层恢复卡片），原生不直接改 UI 状态。
  surface->webView->ExecuteScript(L"(function(){try{if(window.__zzjPipExit)window.__zzjPipExit();else document.exitPictureInPicture();}catch(e){}})()", nullptr);
  WriteLifecycleLog(L"pip: double-click detected on PiP window -> asked the page to exit");
}

void HandlePipStateFromCard(const std::wstring& surfaceId, const std::wstring& state) {
  WriteLifecycleLog((L"pip: state from page = " + (state.empty() ? L"(空)" : state) + L" surface=" + (surfaceId.empty() ? L"(空)" : surfaceId)).c_str());
  if (state == L"enter") {
    g_pipSurfaceId = surfaceId;
    UninstallPipMouseHook();
    g_pipBaselineWindows = CollectTopLevelWebViewWindows();
    g_pipWatchTries = 0;
    if (g_mainWindow) SetTimer(g_mainWindow, kPipWatchTimer, 200, nullptr);
  } else {
    UninstallPipMouseHook();
  }
  PostToCanvasAsync(L"{\"type\":\"native-pip-state\",\"surfaceId\":\"" + JsonEscape(surfaceId) +
    L"\",\"state\":\"" + JsonEscape(state) + L"\"}");
}
// 音量：把网页里所有 <video>/<audio> 的音量设成指定值（宿主只有整条 WebView 的静音开关，没有音量，
// 所以音量只能下发到页面里的媒体元素）。用户 2026-09-13 要求加「调节拉杆」。
static std::wstring BuildVolumeScript(double volume) {
  wchar_t buffer[320]{};
  swprintf_s(buffer, L"(function(){var v=%.4f;var l=document.querySelectorAll('video,audio');for(var i=0;i<l.length;i++){try{l[i].volume=v;}catch(e){}}return '{\"ok\":true,\"count\":'+l.length+'}';})()", volume);
  return buffer;
}

static void ApplySurfaceVolume(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || !surface->webView || surface->volume < 0.0) return;
  surface->webView->ExecuteScript(BuildVolumeScript(surface->volume).c_str(), nullptr);
}
void ConfigureBrowserSurface(const std::shared_ptr<NativeSurface>& surface, ICoreWebView2Controller* controller) {
  if (!surface || !controller || !FindSurface(surface->id)) return;
  surface->controller = controller;
  controller->get_CoreWebView2(&surface->webView);
  AttachProcessFailedCapture(surface->webView.Get(), L"surface:" + surface->id);
  ApplyBrowserColorScheme(surface);
  ComPtr<ICoreWebView2Settings> settings;
  if (SUCCEEDED(surface->webView->get_Settings(&settings))) {
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(TRUE);
    settings->put_AreDevToolsEnabled(TRUE);
    // ⑤ 伪装成 Chrome：个别素材站/网盘按 UA 拒绝 WebView2。
    if (g_browserUserAgentMode == L"chrome") {
      ComPtr<ICoreWebView2Settings2> settings2;
      if (SUCCEEDED(settings.As(&settings2)) && settings2) {
        settings2->put_UserAgent(L"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
      }
    }
  }
  // ④ 下载拦截：统一落到「下载\掌中界」，并把落点告诉画布。
  {
    ComPtr<ICoreWebView2_4> webView4;
    if (SUCCEEDED(surface->webView.As(&webView4)) && webView4) {
      EventRegistrationToken downloadToken{};
      webView4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>(
        [surface](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT {
          if (!args) return S_OK;
          std::wstring fileName = L"下载文件";
          ComPtr<ICoreWebView2DownloadOperation> operation;
          if (SUCCEEDED(args->get_DownloadOperation(&operation)) && operation) {
            LPWSTR resultPath = nullptr;
            if (SUCCEEDED(operation->get_ResultFilePath(&resultPath)) && resultPath) {
              const std::filesystem::path suggested(resultPath);
              if (suggested.has_filename()) fileName = suggested.filename().wstring();
              CoTaskMemFree(resultPath);
            }
          }
          std::filesystem::path target = std::filesystem::path(BrowserDownloadFolder()) / fileName;
          std::error_code ignored;
          for (int suffix = 2; std::filesystem::exists(target, ignored) && suffix < 1000; ++suffix) {
            const std::filesystem::path baseName = std::filesystem::path(fileName).stem();
            const std::filesystem::path extension = std::filesystem::path(fileName).extension();
            target = std::filesystem::path(BrowserDownloadFolder()) / (baseName.wstring() + L"_" + std::to_wstring(suffix) + extension.wstring());
          }
          args->put_ResultFilePath(target.c_str());
          PostToCanvas(L"{\"type\":\"native-browser-download\",\"path\":\"" + JsonEscape(target.wstring()) +
            L"\",\"surfaceId\":\"" + JsonEscape(surface->id) + L"\"}");
          return S_OK;
        }).Get(), &downloadToken);
    }
  }
  // D-7 established a read-only, Range-capable local media endpoint. Register
  // the same endpoint on card WebViews so PDF uses Chromium's built-in reader
  // without file:// access or a second local-file transport.
  surface->webView->AddWebResourceRequestedFilter(
    L"https://media-*.zhangzhongjie.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  EventRegistrationToken mediaResourceToken{};
  ComPtr<ICoreWebView2Environment> responseEnvironment = g_browserEnvironment;
  surface->webView->add_WebResourceRequested(
    Callback<ICoreWebView2WebResourceRequestedEventHandler>(
      [responseEnvironment](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
        return HandleMediaWebResourceRequest(args, responseEnvironment.Get());
      }).Get(), &mediaResourceToken);
  ComPtr<ICoreWebView2_11> webView11;
  if (SUCCEEDED(surface->webView.As(&webView11)) && webView11) {
    EventRegistrationToken contextMenuToken{};
    webView11->add_ContextMenuRequested(Callback<ICoreWebView2ContextMenuRequestedEventHandler>(
      [surface](ICoreWebView2*, ICoreWebView2ContextMenuRequestedEventArgs* args) -> HRESULT {
        if (!args || !g_mainWindow || !FindSurface(surface->id)) return S_OK;
        POINT local{};
        if (FAILED(args->get_Location(&local))) return S_OK;

        // ContextMenuRequested.Location is relative to the WebView bounds. The
        // surface bounds are physical pixels in the main client area; React's
        // fixed-position menu expects CSS pixels. Keep the conversion explicit
        // so restored windows, negative-coordinate monitors and mixed DPI all
        // use the same coordinate system.
        const POINT physicalClient{
          surface->bounds.left + local.x,
          surface->bounds.top + local.y,
        };
        const UINT dpi = std::max<UINT>(96, GetDpiForWindow(g_mainWindow));
        const int clientX = MulDiv(physicalClient.x, 96, static_cast<int>(dpi));
        const int clientY = MulDiv(physicalClient.y, 96, static_cast<int>(dpi));
        RECT windowRect{};
        GetWindowRect(g_mainWindow, &windowRect);
        POINT screenPoint = physicalClient;
        ClientToScreen(g_mainWindow, &screenPoint);
        std::wostringstream payload;
        payload << L"{\"type\":\"native-browser-context-menu\",\"surfaceId\":\""
                << JsonEscape(surface->id)
                << L"\",\"rawX\":" << local.x << L",\"rawY\":" << local.y
                << L",\"clientX\":" << clientX << L",\"clientY\":" << clientY
                << L",\"screenX\":" << screenPoint.x
                << L",\"screenY\":" << screenPoint.y
                << L",\"windowLeft\":" << windowRect.left << L",\"windowTop\":" << windowRect.top
                << L",\"dpi\":" << dpi
                << L",\"maximized\":" << (IsZoomed(g_mainWindow) ? L"true" : L"false") << L"}";
        PostToCanvas(payload.str());
        args->put_Handled(TRUE);
        return S_OK;
      }).Get(), &contextMenuToken);
  }
  EventRegistrationToken focusToken{};
  controller->add_GotFocus(Callback<ICoreWebView2FocusChangedEventHandler>(
    [surface](ICoreWebView2Controller*, IUnknown*) -> HRESULT {
      g_audibleSurfaceId = surface->id;
      for (const auto& candidate : g_surfaces) SyncSurfaceGeometry(candidate);
      PostSurfaceFocus(surface->id);
      return S_OK;
    }).Get(), &focusToken);
  EventRegistrationToken newWindowToken{};
  surface->webView->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
      [surface](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
        LPWSTR uri = nullptr;
        BOOL userInitiated = FALSE;
        args->get_IsUserInitiated(&userInitiated);
        if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
          if (userInitiated && surface->webView) {
            // 用户在页面上点的链接（target=_blank 之类）→ 在**同一张卡**里打开，不再另开一张卡
            // （2026-09-13 用户要求：点进下一层/下一个页面不该单独跳出新网页）。
            surface->webView->Navigate(uri);
          } else {
            // 脚本弹窗（扫码登录、OAuth 授权、window.open）仍新开一张卡：登录流程要在独立窗口里走完，
            // 而且是同一个浏览器 profile，登录完原卡刷新即可。
            PostToCanvas(L"{\"type\":\"native-new-window\",\"uri\":\"" + JsonEscape(uri) +
              L"\",\"surfaceId\":\"" + JsonEscape(surface->id) + L"\"}");
          }
          CoTaskMemFree(uri);
        }
        args->put_Handled(TRUE);
        return S_OK;
      }).Get(), &newWindowToken);
  EventRegistrationToken navigationToken{};
  EventRegistrationToken sourceToken{};
  surface->webView->add_SourceChanged(Callback<ICoreWebView2SourceChangedEventHandler>(
    [surface](ICoreWebView2*, ICoreWebView2SourceChangedEventArgs*) -> HRESULT {
      // SourceChanged also covers redirects, history traversal and link navigation
      // before the document title is ready. Keep the card's editable address field
      // synchronized with the real WebView rather than only with typed navigation.
      SendBrowserNavigation(surface);
      return S_OK;
    }).Get(), &sourceToken);
  // 卡片页面的注入脚本要能往回打点（目前只有视频「右键 → 画中画」钩子用），所以给浏览器卡也挂 WebMessageReceived；
  // 只认 native-log-pip-hook 这一个类型、其它一律忽略，免得卡片页面误触宿主功能。
  EventRegistrationToken cardMessageToken{};
  surface->webView->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
    [surface](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
      LPWSTR raw = nullptr;
      // 注入脚本发的是 JSON 对象 → 必须用 get_WebMessageAsJson（TryGetWebMessageAsString 对对象会失败）。
      if (!args || FAILED(args->get_WebMessageAsJson(&raw)) || !raw) return S_OK;
      const std::wstring cardMessage(raw);
      CoTaskMemFree(raw);
      const std::wstring cardType = JsonStringValue(cardMessage, L"type");
      if (cardType == L"native-log-pip-hook") {
        WriteLifecycleLog((L"pip-hook: " + JsonStringValue(cardMessage, L"note")).c_str());
      } else if (cardType == L"zzj-pip-state") {
        // 页面里进了/出了画中画（注入脚本报的）：进 → 让 Web 层隐藏原网页、原生开始认画中画窗口的双击；出 → 恢复。
        HandlePipStateFromCard(surface->id, JsonStringValue(cardMessage, L"state"));
      }
      return S_OK;
    }).Get(), &cardMessageToken);
  // 视频「右键 → 画中画」钩子：用 AddScriptToExecuteOnDocumentCreated，而不是每次导航后 ExecuteScript——
  // 它对**每一个新建文档、所有帧**都生效（iframe 里的播放器也算），脚本自身幂等。
  surface->webView->AddScriptToExecuteOnDocumentCreated(kPipRightClickHook,
    Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
      [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; }).Get());
  surface->webView->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
    [surface](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
      SendBrowserNavigation(surface);
      ApplySurfaceVolume(surface);   // 导航会重建页面：设置过的音量要重新下发到新的媒体元素
      // Prime the DOM-side interaction snapshot while the live surface remains
      // visible. Drag/pan can then switch visual carriers without a blank frame.
      CaptureSurfaceSnapshot(surface);
      return S_OK;
    }).Get(), &navigationToken);
  SyncSurfaceGeometry(surface);
  surface->webView->Navigate(surface->source.empty() ? L"https://www.google.com" : surface->source.c_str());
}

void CreateWindowedBrowserSurface(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || surface->controller || surface->creating || !g_browserEnvironment) return;
  if (!EnsureSurfaceHost(surface)) return;
  ShowWindow(surface->host, SW_SHOW);
  surface->creating = true;
  g_browserEnvironment->CreateCoreWebView2Controller(surface->host,
    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
      [surface](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
        surface->creating = false;
        if (FAILED(result) || !controller || !FindSurface(surface->id)) return result;
        ConfigureBrowserSurface(surface, controller);
        return S_OK;
      }).Get());
}

void CreateBrowserSurface(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || surface->controller || surface->creating || !g_browserEnvironment) return;
  ComPtr<ICoreWebView2Environment3> environment3;
  if (!g_compositionHost || !g_compositionRoot || !g_compositionDevice ||
      FAILED(g_browserEnvironment.As(&environment3)) || !environment3) {
    CreateWindowedBrowserSurface(surface);
    return;
  }
  if (FAILED(g_compositionDevice->CreateVisual(&surface->compositionVisual)) || !surface->compositionVisual) {
    CreateWindowedBrowserSurface(surface);
    return;
  }
  g_compositionRoot->AddVisual(surface->compositionVisual.Get(), TRUE, nullptr);
  g_compositionDevice->Commit();
  surface->creating = true;
  environment3->CreateCoreWebView2CompositionController(g_compositionHost,
    Callback<ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>(
      [surface](HRESULT result, ICoreWebView2CompositionController* composition) -> HRESULT {
        surface->creating = false;
        if (FAILED(result) || !composition || !FindSurface(surface->id)) {
          if (g_compositionRoot && surface->compositionVisual) g_compositionRoot->RemoveVisual(surface->compositionVisual.Get());
          surface->compositionVisual.Reset();
          if (g_compositionDevice) g_compositionDevice->Commit();
          CreateWindowedBrowserSurface(surface);
          return result;
        }
        surface->compositionController = composition;
        composition->put_RootVisualTarget(surface->compositionVisual.Get());
        ComPtr<ICoreWebView2Controller> controller;
        if (FAILED(composition->QueryInterface(IID_PPV_ARGS(&controller))) || !controller) {
          surface->compositionController.Reset();
          CreateWindowedBrowserSurface(surface);
          return E_NOINTERFACE;
        }
        ConfigureBrowserSurface(surface, controller.Get());
        RestackSurfaces();
        return S_OK;
      }).Get());
}

void DestroySurface(const std::wstring& id) {
  const auto surface = FindSurface(id);
  if (!surface) return;
  ++surface->explorerFolderSizeGeneration;
  ++surface->explorerSearchGeneration;
  if (g_hoveredSurfaceId == id) UpdateSurfaceHover({});
  if (surface->explorer) surface->explorer->Destroy();
  surface->explorer.Reset();
  if (g_compositionRoot && surface->compositionVisual) g_compositionRoot->RemoveVisual(surface->compositionVisual.Get());
  surface->compositionClip.Reset();
  surface->compositionVisual.Reset();
  surface->compositionController.Reset();
  if (surface->host) DestroyWindow(surface->host);
  surface->host = nullptr;
  surface->webView.Reset();
  if (surface->controller) surface->controller->Close();
  surface->controller.Reset();
  if (g_compositionDevice) g_compositionDevice->Commit();
  // PDF cards deliberately retire their WebView2 while off-screen, but their
  // read-only Range binding must remain until the owning file card unmounts.
  if (!surface->mediaBacked) {
    std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
    g_mediaFolders.erase(MediaHostForSurface(id));
  }
  {
    std::lock_guard<std::mutex> lock(g_thumbnailRoutesMutex);
    g_thumbnailRoutes.erase(ThumbnailHostForSurface(id));
  }
  g_surfaces.erase(std::remove_if(g_surfaces.begin(), g_surfaces.end(), [&](const auto& candidate) { return candidate->id == id; }), g_surfaces.end());
  ++g_surfaceTopologyRevision;
  g_hoverOwnerCache = {};
  UpdateCompositionHostRegion();
  RestackSurfaces();
}


// 收到销毁请求先把窗口藏起来并记时，600ms 内同 id 再次上线就直接复活，
// 只有真的没人要了才拆。这样最大化 ↔ 还原之间 Explorer 实例始终活着，
// 切回来是瞬时的，不会再退回「正在连接 Windows 文件管理器…」。
void RetireSurface(const std::wstring& id, const std::wstring& leaseId = {}) {
  const auto surface = FindSurface(id);
  if (!surface) return;
  // 最大化/还原会把同一 surfaceId 从一个 React 实例交接给另一个。旧实例的
  // cleanup 可能晚于新实例 upsert；只有当前租约才有权销毁，避免把新视图误退役。
  if (!leaseId.empty() && !surface->leaseId.empty() && leaseId != surface->leaseId) return;
  surface->closingAt = GetTickCount64();
  surface->visible = false;
  SyncSurfaceGeometry(surface);
  if (g_mainWindow) SetTimer(g_mainWindow, kSurfaceSweepTimer, 200, nullptr);
}

void SweepRetiredSurfaces() {
  const ULONGLONG now = GetTickCount64();
  std::vector<std::wstring> expired;
  bool pending = false;
  for (const auto& surface : g_surfaces) {
    if (!surface->closingAt) continue;
    if (now - surface->closingAt >= kSurfaceGraceMs) expired.push_back(surface->id);
    else pending = true;
  }
  for (const auto& id : expired) DestroySurface(id);
  if (!pending && g_mainWindow) KillTimer(g_mainWindow, kSurfaceSweepTimer);
}

void UpsertSurface(const std::wstring& message) {
  ++g_surfacePerfCounters.upserts;
  const std::wstring id = JsonStringValue(message, L"surfaceId");
  const std::wstring kind = JsonStringValue(message, L"kind");
  if (id.empty() || (kind != L"browser" && kind != L"explorer" && kind != L"shellview")) return;
  auto surface = FindSurface(id);
  const bool created = !surface;
  if (!surface) {
    surface = std::make_shared<NativeSurface>();
    surface->id = id;
    surface->kind = kind;
    g_surfaces.push_back(surface);
    ++g_surfaceTopologyRevision;
    g_hoverOwnerCache = {};
  }
  if (surface->kind != kind) {
    DestroySurface(id);
    UpsertSurface(message);
    return;
  }
  const std::wstring requestedSource = JsonStringValue(message, L"source");
  const bool explicitNavigation = JsonStringValue(message, L"sourceIntent") == L"navigate";
  const std::wstring leaseId = JsonStringValue(message, L"leaseId");
  const bool leaseChanged = !leaseId.empty() && leaseId != surface->leaseId;
  // A new lease with the same surface id is a visual hand-off (normal card <->
  // maximized/split carrier), not a navigation request.  Keep the live Shell or
  // WebView session at its current location instead of resetting to the item's
  // original source during the remount.
  const bool preserveLiveSource = !created && leaseChanged && !explicitNavigation && !surface->source.empty();
  const std::wstring source = preserveLiveSource ? surface->source : requestedSource;
  if (!leaseId.empty()) surface->leaseId = leaseId;
  const bool sourceChanged = !source.empty() && source != surface->source;
  surface->source = source.empty() ? (kind == L"explorer" ? L"shell:MyComputerFolder" : L"https://www.google.com") : source;
  if (kind == L"shellview" && source.empty()) surface->source = L"shell:MyComputerFolder";
  const int x = JsonIntValue(message, L"x");
  const int y = JsonIntValue(message, L"y");
  const int width = std::max(1, JsonIntValue(message, L"width", 1));
  const int height = std::max(1, JsonIntValue(message, L"height", 1));
  surface->bounds = RECT{x, y, x + width, y + height};
  surface->closingAt = 0;
  surface->scale = JsonDoubleValue(message, L"scale", 1.0);
  surface->semanticOnly = JsonBoolValue(message, L"semanticOnly", false);
  surface->mediaBacked = JsonBoolValue(message, L"mediaBacked", false);
  const bool wantsSnapshot = JsonBoolValue(message, L"snapshot", false);
  const bool snapshotChanged = wantsSnapshot != surface->snapshotMode;
  surface->snapshotMode = wantsSnapshot;
  const int order = JsonIntValue(message, L"order", 0);
  const bool orderChanged = order != surface->order;
  surface->order = order;
  const int clipW = JsonIntValue(message, L"clipWidth", 0);
  const int clipH = JsonIntValue(message, L"clipHeight", 0);
  surface->hasClip = clipW > 0 && clipH > 0;
  if (surface->hasClip) {
    const int clipX = JsonIntValue(message, L"clipX", 0);
    const int clipY = JsonIntValue(message, L"clipY", 0);
    surface->clip = RECT{clipX, clipY, clipX + clipW, clipY + clipH};
  }
  surface->visible = JsonBoolValue(message, L"visible", true);
  if (kind == L"explorer") {
    CreateExplorerSurface(surface);
    if (sourceChanged) {
      surface->explorerContentDirty = true;
      BrowseExplorer(surface, surface->source);
      SetTimer(surface->host, 1, 250, nullptr);
    } else if (leaseChanged) {
      // Maximizing/restoring mounts a fresh React file-view subscriber while the
      // Shell browser itself deliberately survives.  Replay the current listing
      // to that new lease; otherwise its local list starts empty until the next
      // unrelated Shell change.
      surface->explorerContentDirty = true;
    }
  } else if (kind == L"shellview") {
    CreateShellViewSurface(surface);
    if (sourceChanged && surface->explorer) BrowseExplorer(surface, surface->source);
  } else {
    CreateBrowserSurface(surface);
    if (sourceChanged && surface->webView) {
      // Any asynchronous preview from the previous page is now stale.
      ++surface->snapshotRevision;
      surface->webView->Navigate(surface->source.c_str());
    }
  }
  // 切进快照模式之前先抓一张：窗口一旦隐藏就抓不到内容了。
  if (snapshotChanged && wantsSnapshot) {
    surface->snapshotMode = false;
    SyncSurfaceGeometry(surface);
    CaptureSurfaceSnapshot(surface);
    surface->snapshotMode = true;
  }
  SyncSurfaceGeometry(surface);
  if (created || orderChanged) RestackSurfaces();
}

// 拖动 / 缩放期间必须让原生表面不接收鼠标。传统 HWND 用
// EnableWindow(FALSE)；Composition host 则由 CompositionHostProc 返回
// HTTRANSPARENT。后者不能隐藏或禁用，否则 DComp 网页会在拖动中变白。
void SetSurfacesInert(bool inert) {
  g_compositionInputDisabled = inert;
  // CompositionHostProc returns HTTRANSPARENT while this flag is set.  Do not
  // disable or hide that HWND: DirectComposition is targeted at it, and doing
  // so blanks every browser visual until the interaction has ended.
  for (const auto& surface : g_surfaces) {
    if (surface->host && !surface->semanticOnly) EnableWindow(surface->host, inert ? FALSE : TRUE);
  }
  for (const auto& surface : g_surfaces) SyncSurfaceGeometry(surface);
}

// 交接文档 §10：已复制的文件、压缩包、视频和文件夹只保存路径引用，不复制进工程。
// Web 剪贴板 API 只给 File 对象、拿不到磁盘路径，必须在宿主侧读 CF_HDROP。
// CF_HDROP 文件列表读取：SendClipboardFiles 与剪贴暂存共用。
// 剪贴板是全局互斥资源，别的进程正在读写时 OpenClipboard 会直接失败。
// 资源管理器复制完往往还占着一会儿，必须重试，不能一次不成就当作空。
void ReadClipboardDropPaths(std::vector<std::wstring>& paths, bool& opened, bool& hasDrop) {
  opened = false;
  hasDrop = false;
  for (int attempt = 0; attempt < 12 && !opened; ++attempt) {
    opened = OpenClipboard(g_mainWindow) != FALSE;
    if (!opened) Sleep(25);
  }
  if (!opened) return;
  if (HANDLE handle = GetClipboardData(CF_HDROP)) {
    hasDrop = true;
    const HDROP drop = static_cast<HDROP>(handle);
    const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
    for (UINT index = 0; index < count && paths.size() < 64; ++index) {
      const UINT length = DragQueryFileW(drop, index, nullptr, 0);
      if (!length) continue;
      std::wstring path(length + 1, L'\0');
      if (DragQueryFileW(drop, index, path.data(), length + 1)) {
        path.resize(length);
        paths.push_back(path);
      }
    }
  }
  CloseClipboard();
}

void SendClipboardFiles(const std::wstring& requestId = {}) {
  std::vector<std::wstring> paths;
  bool opened = false;
  bool hasDrop = false;
  ReadClipboardDropPaths(paths, opened, hasDrop);
  std::wostringstream json;
  json << L"{\"type\":\"native-clipboard-files\",\"opened\":" << (opened ? L"true" : L"false")
       << L",\"hasDrop\":" << (hasDrop ? L"true" : L"false");
  if (!requestId.empty()) json << L",\"requestId\":\"" << JsonEscape(requestId) << L"\"";
  json << L",\"paths\":[";
  for (size_t index = 0; index < paths.size(); ++index) {
    if (index) json << L',';
    json << CanvasPathJson(paths[index]);
  }
  json << L"]}";
  PostToCanvas(json.str());
}

void OpenShellPath(const std::wstring& path) {
  if (path.empty()) return;
  ShellExecuteW(g_mainWindow, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

void SetAudibleSurface(const std::wstring& id) {
  g_audibleSurfaceId = id;
  for (const auto& surface : g_surfaces) SyncSurfaceGeometry(surface);
}

// 命令全部走 Shell 自己的上下文菜单：选中项用 SVGIO_SELECTION，空白处用
// SVGIO_BACKGROUND。这和用户右键点出来的是同一条路径，所以行为、确认对话框、
// 回收站、同名冲突窗口天然与系统一致，不需要我们再实现一遍（§30.3）。
ComPtr<IShellView> CurrentShellView(const std::shared_ptr<NativeSurface>& surface) {
  ComPtr<IShellView> view;
  if (surface && surface->explorer) surface->explorer->GetCurrentView(IID_PPV_ARGS(&view));
  return view;
}

bool TranslateFocusedShellViewAccelerator(MSG& message) {
  const HWND focused = GetFocus();
  if (!focused) return false;
  for (const auto& surface : g_surfaces) {
    if (!surface || surface->kind != L"shellview" || !surface->host || !surface->explorer) continue;
    if (focused != surface->host && !IsChild(surface->host, focused)) continue;

    ComPtr<IInputObject> input;
    surface->explorer.As(&input);
    if (input && input->TranslateAcceleratorIO(&message) == S_OK) return true;

    input.Reset();
    const auto view = CurrentShellView(surface);
    if (view) view.As(&input);
    if (input && input->TranslateAcceleratorIO(&message) == S_OK) return true;

    // ExplorerBrowser and its current Shell view both leave Alt+Left/Right
    // untranslated on some Windows builds. Keep navigation native and scoped to
    // this focused shell-view host instead of letting a canvas shortcut consume it.
    if ((message.message == WM_KEYDOWN || message.message == WM_SYSKEYDOWN) &&
        (GetKeyState(VK_MENU) & 0x8000) &&
        (message.wParam == VK_LEFT || message.wParam == VK_RIGHT)) {
      surface->explorer->BrowseToIDList(nullptr,
        message.wParam == VK_LEFT ? SBSP_NAVIGATEBACK : SBSP_NAVIGATEFORWARD);
      return true;
    }
    return false;
  }
  return false;
}

ComPtr<IFolderView2> CurrentFolderView(const std::shared_ptr<NativeSurface>& surface) {
  ComPtr<IFolderView2> view;
  if (surface && surface->explorer) surface->explorer->GetCurrentView(IID_PPV_ARGS(&view));
  return view;
}

std::wstring ArchiveRootParsingName(const std::shared_ptr<NativeSurface>& surface) {
  const auto view = CurrentFolderView(surface);
  if (!view) return {};
  ComPtr<IShellItem> cursor;
  if (FAILED(view->GetFolder(IID_PPV_ARGS(&cursor))) || !cursor) return {};
  for (size_t depth = 0; cursor && depth < 24; ++depth) {
    LPWSTR parsingName = nullptr;
    if (SUCCEEDED(cursor->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &parsingName)) && parsingName) {
      const std::filesystem::path path(parsingName);
      const bool zipContainer = IsShellContainer(cursor.Get()) &&
        !IsFileSystemDirectory(path) && _wcsicmp(path.extension().c_str(), L".zip") == 0;
      const std::wstring result = zipContainer ? std::wstring(parsingName) : std::wstring();
      CoTaskMemFree(parsingName);
      if (zipContainer) return result;
    }
    ComPtr<IShellItem> parent;
    if (FAILED(cursor->GetParent(&parent)) || !parent) break;
    cursor = std::move(parent);
  }
  return {};
}

bool IsArchiveShellLocation(const std::shared_ptr<NativeSurface>& surface) {
  return !ArchiveRootParsingName(surface).empty();
}

bool RejectArchiveWrite(const std::shared_ptr<NativeSurface>& surface) {
  if (IsArchiveMirrorLocation(surface)) {
    PostToCanvas(L"{\"type\":\"native-explorer-operation-blocked\",\"surfaceId\":\"" +
      JsonEscape(surface->id) +
      L"\",\"message\":\"包内是只读解压副本：改动不会写回压缩包，先把文件复制到磁盘目录再编辑\"}");
    return true;
  }
  if (!IsArchiveShellLocation(surface)) return false;
  PostToCanvas(L"{\"type\":\"native-explorer-operation-blocked\",\"surfaceId\":\"" +
    JsonEscape(surface->id) + L"\",\"message\":\"压缩包内暂不支持此操作\"}");
  return true;
}

int CurrentSelectionCount(const std::shared_ptr<NativeSurface>& surface) {
  const auto view = CurrentFolderView(surface);
  if (!view) return 0;
  int count = 0;
  return SUCCEEDED(view->ItemCount(SVGIO_SELECTION, &count)) ? count : 0;
}

bool InvokeShellVerb(const std::shared_ptr<NativeSurface>& surface, UINT scope, const char* verb) {
  const auto view = CurrentShellView(surface);
  if (!view) return false;
  ComPtr<IContextMenu> menu;
  if (FAILED(view->GetItemObject(scope, IID_PPV_ARGS(&menu))) || !menu) return false;
  HMENU popup = CreatePopupMenu();
  bool ok = false;
  if (popup && SUCCEEDED(menu->QueryContextMenu(popup, 0, 1, 0x7FFF, CMF_NORMAL))) {
    CMINVOKECOMMANDINFO info{};
    info.cbSize = sizeof(info);
    info.hwnd = surface->host;
    info.lpVerb = verb;
    info.nShow = SW_SHOWNORMAL;
    ok = SUCCEEDED(menu->InvokeCommand(&info));
  }
  if (popup) DestroyMenu(popup);
  return ok;
}

// 「更多」直接把 Shell 的原生右键菜单弹出来，不自己复刻。
void ShowShellContextMenu(const std::shared_ptr<NativeSurface>& surface, int screenX = -1, int screenY = -1) {
  const auto view = CurrentShellView(surface);
  if (!view) return;
  const UINT scope = CurrentSelectionCount(surface) > 0 ? SVGIO_SELECTION : SVGIO_BACKGROUND;
  ComPtr<IContextMenu> menu;
  if (FAILED(view->GetItemObject(scope, IID_PPV_ARGS(&menu))) || !menu) return;
  // 深色菜单必须在建菜单之前就位：ForceDark 要先设，缓存的菜单主题要先冲掉，
  // 拥有者窗口也要允许深色，否则弹出来还是系统默认的白底。
  ApplyMenuTheme();
  if (g_allowDarkModeForWindow) g_allowDarkModeForWindow(surface->host, SystemUsesDarkMode() ? TRUE : FALSE);
  HMENU popup = CreatePopupMenu();
  if (!popup) return;
  if (SUCCEEDED(menu->QueryContextMenu(popup, 0, 1, 0x7FFF, CMF_NORMAL))) {
    POINT point{screenX, screenY};
    if (screenX < 0 || screenY < 0) GetCursorPos(&point);
    SetForegroundWindow(g_mainWindow);
    const int chosen = TrackPopupMenuEx(popup, TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN,
      point.x, point.y, g_mainWindow, nullptr);
    if (chosen > 0) {
      CMINVOKECOMMANDINFO info{};
      info.cbSize = sizeof(info);
      info.hwnd = g_mainWindow;
      info.lpVerb = MAKEINTRESOURCEA(chosen - 1);
      info.nShow = SW_SHOWNORMAL;
      menu->InvokeCommand(&info);
    }
  }
  DestroyMenu(popup);
}

void ShowShellContextMenuForPaths(const std::vector<std::wstring>& paths, int screenX, int screenY) {
  if (paths.empty()) return;
  std::vector<PIDLIST_ABSOLUTE> pidls;
  pidls.reserve(paths.size());
  for (const auto& path : paths) {
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (SUCCEEDED(SHParseDisplayName(path.c_str(), nullptr, &pidl, 0, nullptr)) && pidl) pidls.push_back(pidl);
  }
  ComPtr<IShellItemArray> items;
  if (!pidls.empty()) SHCreateShellItemArrayFromIDLists(
    static_cast<UINT>(pidls.size()),
    const_cast<PCIDLIST_ABSOLUTE*>(reinterpret_cast<const PCIDLIST_ABSOLUTE*>(pidls.data())),
    &items);
  for (auto pidl : pidls) CoTaskMemFree(pidl);
  if (!items) return;

  ComPtr<IContextMenu> menu;
  if (FAILED(items->BindToHandler(nullptr, BHID_SFUIObject, IID_PPV_ARGS(&menu))) || !menu) return;
  ApplyMenuTheme();
  HMENU popup = CreatePopupMenu();
  if (!popup) return;
  if (SUCCEEDED(menu->QueryContextMenu(popup, 0, 1, 0x7FFF, CMF_NORMAL))) {
    POINT point{screenX, screenY};
    if (screenX < 0 || screenY < 0) GetCursorPos(&point);
    SetForegroundWindow(g_mainWindow);
    const int chosen = TrackPopupMenuEx(popup, TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN,
      point.x, point.y, g_mainWindow, nullptr);
    if (chosen > 0) {
      CMINVOKECOMMANDINFO info{};
      info.cbSize = sizeof(info);
      info.hwnd = g_mainWindow;
      info.lpVerb = MAKEINTRESOURCEA(chosen - 1);
      info.nShow = SW_SHOWNORMAL;
      menu->InvokeCommand(&info);
    }
  }
  DestroyMenu(popup);
}

void CreateNewFolder(const std::shared_ptr<NativeSurface>& surface) {
  if (RejectArchiveWrite(surface)) return;
  const auto view = CurrentFolderView(surface);
  if (!view) return;
  ComPtr<IShellItem> folder;
  if (FAILED(view->GetFolder(IID_PPV_ARGS(&folder))) || !folder) return;
  ComPtr<IFileOperation> operation;
  if (FAILED(CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&operation)))) return;
  operation->SetOperationFlags(FOF_ALLOWUNDO | FOFX_SHOWELEVATIONPROMPT);
  operation->SetOwnerWindow(surface->host);
  operation->NewItem(folder.Get(), FILE_ATTRIBUTE_DIRECTORY, L"新建文件夹", nullptr, nullptr);
  operation->PerformOperations();
}

void CreateNewFile(const std::shared_ptr<NativeSurface>& surface, const std::wstring& name) {
  if (RejectArchiveWrite(surface) || name.empty()) return;
  const auto view = CurrentFolderView(surface);
  if (!view) return;
  ComPtr<IShellItem> folder;
  if (FAILED(view->GetFolder(IID_PPV_ARGS(&folder))) || !folder) return;
  ComPtr<IFileOperation> operation;
  if (FAILED(CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&operation)))) return;
  operation->SetOperationFlags(FOF_ALLOWUNDO | FOF_RENAMEONCOLLISION | FOFX_SHOWELEVATIONPROMPT);
  operation->SetOwnerWindow(surface->host);
  operation->NewItem(folder.Get(), FILE_ATTRIBUTE_NORMAL, name.c_str(), nullptr, nullptr);
  operation->PerformOperations();
}

void RenameExplorerEntry(const std::shared_ptr<NativeSurface>& surface,
                         const std::wstring& path,
                         const std::wstring& newName) {
  if (!surface || path.empty() || newName.empty()) return;
  if (RejectArchiveWrite(surface)) return;
  ComPtr<IShellItem> item;
  if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) return;
  ComPtr<IFileOperation> operation;
  if (FAILED(CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(&operation))) || !operation) return;
  operation->SetOwnerWindow(g_mainWindow);
  operation->SetOperationFlags(FOF_ALLOWUNDO | FOFX_SHOWELEVATIONPROMPT);
  const auto postRenameNotice = [&](const wchar_t* reason) {
    PostToCanvas(L"{\"type\":\"native-explorer-notice\",\"surfaceId\":\"" + JsonEscape(surface->id) +
      L"\",\"text\":\"" + JsonEscape(std::wstring(L"重命名失败：") + reason) + L"\"}");
  };
  if (FAILED(operation->RenameItem(item.Get(), newName.c_str(), nullptr))) { postRenameNotice(L"名称无效或已被占用"); return; }
  if (FAILED(operation->PerformOperations())) { postRenameNotice(L"文件被占用或被系统拒绝"); return; }
  BOOL aborted = FALSE;
  operation->GetAnyOperationsAborted(&aborted);
  if (aborted) { postRenameNotice(L"操作已取消"); return; }
  surface->explorerContentDirty = true;
  ReportExplorerState(surface, true);
}

std::wstring ShellPropertyString(IShellItem2* item, REFPROPERTYKEY key);
std::wstring FormatShellFileTime(const FILETIME& utc);

std::wstring UrlEncode(const std::wstring& value) {
  if (value.empty()) return {};
  // 整串一次性转 UTF-8 再逐字节编码。逐 wchar_t 调用会把代理对（emoji 等
  // 非 BMP 字符）拆成两个 U+FFFD 替换符，缩略图/预览 URL 永远对不上文件。
  const int byteCount = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (byteCount <= 0) return {};
  std::string bytes(static_cast<size_t>(byteCount), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), bytes.data(), byteCount, nullptr, nullptr);
  std::wstring out;
  out.reserve(bytes.size() * 3 + 8);
  for (const unsigned char byte : bytes) {
    const bool unreserved = (byte >= '0' && byte <= '9') || (byte >= 'A' && byte <= 'Z') ||
      (byte >= 'a' && byte <= 'z') || byte == '-' || byte == '_' || byte == '.' || byte == '~';
    if (unreserved) out.push_back(static_cast<wchar_t>(byte));
    else {
      wchar_t buffer[4]{};
      swprintf_s(buffer, L"%%%02X", byte);
      out += buffer;
    }
  }
  return out;
}

std::wstring ReadTextPreview(const std::filesystem::path& path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) return {};
  constexpr size_t kMaximumPreviewBytes = 512 * 1024;
  std::string bytes(kMaximumPreviewBytes, '\0');
  stream.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  bytes.resize(static_cast<size_t>(stream.gcount()));
  if (bytes.empty()) return {};
  if (bytes.size() >= 2 && static_cast<unsigned char>(bytes[0]) == 0xFF && static_cast<unsigned char>(bytes[1]) == 0xFE) {
    const wchar_t* begin = reinterpret_cast<const wchar_t*>(bytes.data() + 2);
    return std::wstring(begin, begin + (bytes.size() - 2) / sizeof(wchar_t));
  }
  size_t offset = bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF &&
    static_cast<unsigned char>(bytes[1]) == 0xBB && static_cast<unsigned char>(bytes[2]) == 0xBF ? 3 : 0;
  const char* source = bytes.data() + offset;
  const int sourceSize = static_cast<int>(bytes.size() - offset);
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source, sourceSize, nullptr, 0);
  UINT codePage = CP_UTF8;
  if (!length) { codePage = CP_ACP; length = MultiByteToWideChar(codePage, 0, source, sourceSize, nullptr, 0); }
  if (!length) return {};
  std::wstring text(length, L'\0');
  MultiByteToWideChar(codePage, codePage == CP_UTF8 ? MB_ERR_INVALID_CHARS : 0, source, sourceSize, text.data(), length);
  return text;
}

std::wstring LowerExtension(const std::filesystem::path& path) {
  std::wstring extension = path.extension().wstring();
  std::transform(extension.begin(), extension.end(), extension.begin(), ::towlower);
  return extension;
}

std::filesystem::path ShellPreviewTempRoot() {
  wchar_t temporary[MAX_PATH]{};
  if (!GetTempPathW(static_cast<DWORD>(std::size(temporary)), temporary)) return {};
  return std::filesystem::path(temporary) / L"ZhangZhongJiePreview";
}

void CleanupStaleShellPreviewTemps() {
  const auto root = ShellPreviewTempRoot();
  if (root.empty()) return;
  std::error_code error;
  const auto now = std::filesystem::file_time_type::clock::now();
  for (std::filesystem::directory_iterator iterator(root, std::filesystem::directory_options::skip_permission_denied, error), end;
       !error && iterator != end; iterator.increment(error)) {
    if (!iterator->is_directory(error) || iterator->path().filename().wstring().rfind(L"preview-", 0) != 0) continue;
    const auto written = iterator->last_write_time(error);
    if (!error && now - written > std::chrono::hours(24)) RemoveTreeBestEffort(iterator->path());
    error.clear();
  }
}

void ClearShellPreviewResources() {
  std::filesystem::path temporary;
  {
    std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
    if (!g_shellPreviewMediaHost.empty()) g_mediaFolders.erase(g_shellPreviewMediaHost);
    g_shellPreviewMediaHost.clear();
    temporary = std::move(g_shellPreviewTempFolder);
    g_shellPreviewTempFolder.clear();
  }
  if (!temporary.empty()) RemoveTreeBestEffort(temporary);
}

bool MaterializeShellPreviewItem(IShellItem* item, const std::wstring& name,
                                 unsigned long generation, std::filesystem::path& output) {
  if (!item) return false;
  ComPtr<IStream> source;
  if (FAILED(item->BindToHandler(nullptr, BHID_Stream, IID_PPV_ARGS(&source))) || !source) return false;
  const auto root = ShellPreviewTempRoot();
  if (root.empty()) return false;
  const auto folder = root / (L"preview-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(generation));
  std::error_code error;
  std::filesystem::create_directories(folder, error);
  if (error) return false;
  output = folder / SafeProjectName(name);
  std::ofstream stream(output, std::ios::binary | std::ios::trunc);
  if (!stream) { RemoveTreeBestEffort(folder); return false; }
  // 1MB 的栈上缓冲放在 1MB 默认栈的线程里必然栈溢出；栈溢出时连崩溃处理器都跑不起来，
  // 表现就是"无日志、无转储、进程瞬间消失"。缓冲必须放堆上。
  std::vector<unsigned char> buffer(1024 * 1024);
  for (;;) {
    // 拷贝中途也要响应取消（此前 3GB 条目一旦开始就不能停）。
    if (g_shellPreviewGeneration.load() != generation) {
      stream.close();
      RemoveTreeBestEffort(folder);
      return false;
    }
    ULONG read = 0;
    const HRESULT result = source->Read(buffer.data(), static_cast<ULONG>(buffer.size()), &read);
    if (FAILED(result)) { stream.close(); RemoveTreeBestEffort(folder); return false; }
    if (read) stream.write(reinterpret_cast<const char*>(buffer.data()), read);
    if (!stream || result == S_FALSE || read == 0) break;
  }
  stream.close();
  if (!stream || g_shellPreviewGeneration.load() != generation) {
    RemoveTreeBestEffort(folder);
    return false;
  }
  return true;
}

bool IsDirectImageExtension(const std::wstring& extension) {
  return IsOneOf(extension, {L".png", L".jpg", L".jpeg", L".gif", L".webp", L".bmp", L".tif", L".tiff", L".svg"});
}

void SendShellPreview(const std::wstring& surfaceId, const std::wstring& parsingName) {
  if (parsingName.empty()) return;
  const unsigned long previewGeneration = ++g_shellPreviewGeneration;
  ++g_shellPreviewThumbnailGeneration;
  ClearShellPreviewResources();
  CleanupStaleShellPreviewTemps();
  std::thread([surfaceId, parsingName, previewGeneration]() {
    WriteLifecycleLog((L"sp: start " + parsingName.substr(0, 120)).c_str());
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    ComPtr<IShellItem2> item;
    if (FAILED(SHCreateItemFromParsingName(parsingName.c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) {
      if (SUCCEEDED(initialized)) CoUninitialize();
      return;
    }
    const std::wstring name = ShellPropertyString(item.Get(), PKEY_ItemNameDisplay);
    const std::wstring type = ShellPropertyString(item.Get(), PKEY_ItemTypeText);
    ULONGLONG size = 0;
    item->GetUInt64(PKEY_Size, &size);
    FILETIME modified{};
    item->GetFileTime(PKEY_DateModified, &modified);
    const std::wstring modifiedText = FormatShellFileTime(modified);
    FILETIME created{};
    item->GetFileTime(PKEY_DateCreated, &created);
    const std::wstring createdText = FormatShellFileTime(created);
    if (g_shellPreviewGeneration.load() != previewGeneration) {
      if (SUCCEEDED(initialized)) CoUninitialize();
      return;
    }
    WriteLifecycleLog(L"sp: preview-image begin");
    std::wstring image = ShellItemImageDataUrl(
      item.Get(), 1024, nullptr, nullptr, nullptr, false, parsingName);
    WriteLifecycleLog(L"sp: preview-image done");
    if (g_shellPreviewGeneration.load() != previewGeneration) {
      if (SUCCEEDED(initialized)) CoUninitialize();
      return;
    }
    const DWORD fileAttributes = GetFileAttributesW(parsingName.c_str());
    const bool isDirectory = fileAttributes != INVALID_FILE_ATTRIBUTES && (fileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const bool isRegularFile = fileAttributes != INVALID_FILE_ATTRIBUTES && !isDirectory;
    const bool readOnly = fileAttributes != INVALID_FILE_ATTRIBUTES && (fileAttributes & FILE_ATTRIBUTE_READONLY) != 0;
    const bool hidden = fileAttributes != INVALID_FILE_ATTRIBUTES && (fileAttributes & FILE_ATTRIBUTE_HIDDEN) != 0;
    ULONG width = 0, height = 0, pageCount = 0, colorSpace = 0;
    ULONGLONG mediaDuration = 0;
    item->GetUInt32(PKEY_Image_HorizontalSize, &width);
    item->GetUInt32(PKEY_Image_VerticalSize, &height);
    if (!width) item->GetUInt32(PKEY_Video_FrameWidth, &width);
    if (!height) item->GetUInt32(PKEY_Video_FrameHeight, &height);
    item->GetUInt32(PKEY_Document_PageCount, &pageCount);
    item->GetUInt32(PKEY_Image_ColorSpace, &colorSpace);
    item->GetUInt64(PKEY_Media_Duration, &mediaDuration);
    const std::wstring codec = ShellPropertyString(item.Get(), PKEY_Video_Compression);
    const std::wstring colorMode = colorSpace == 1 ? L"sRGB" : colorSpace == 2 ? L"Adobe RGB" : L"";
    std::wstring previewKind = L"thumbnail";
    std::wstring resource;
    std::wstring text;
    std::wostringstream childJson;
    childJson << L'[';
    const std::filesystem::path filePath(parsingName);
    const std::wstring extension = LowerExtension(filePath);
    std::error_code error;

    if (isDirectory) {
      previewKind = L"folder";
      size_t childCount = 0;
      std::filesystem::directory_iterator iterator(filePath, std::filesystem::directory_options::skip_permission_denied, error);
      for (const auto& child : iterator) {
        if (error || childCount >= 16 || g_shellPreviewGeneration.load() != previewGeneration) break;
        const DWORD childAttributes = GetFileAttributesW(child.path().c_str());
        if (childAttributes == INVALID_FILE_ATTRIBUTES) continue;
        const bool childFolder = (childAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        ULONGLONG childSize = 0;
        if (!childFolder) {
          const auto value = child.file_size(error);
          if (!error) childSize = static_cast<ULONGLONG>(value);
          error.clear();
        }
        ComPtr<IShellItem2> childItem;
        std::wstring childType, childImage;
        if (SUCCEEDED(SHCreateItemFromParsingName(child.path().c_str(), nullptr, IID_PPV_ARGS(&childItem))) && childItem) {
          childType = ShellPropertyString(childItem.Get(), PKEY_ItemTypeText);
          childImage = ShellItemImageDataUrl(
            childItem.Get(), 96, nullptr, nullptr, nullptr, false, child.path().wstring());
        }
        if (g_shellPreviewGeneration.load() != previewGeneration) break;
        if (childCount++) childJson << L',';
        childJson << L"{\"name\":\"" << JsonEscape(child.path().filename().wstring())
          << L"\",\"path\":\"" << JsonEscape(child.path().wstring())
          << L"\",\"typeText\":\"" << JsonEscape(childType)
          << L"\",\"size\":" << childSize << L",\"folder\":" << (childFolder ? L"true" : L"false")
          << L",\"image\":\"" << JsonEscape(childImage) << L"\"}";
      }
    } else if (extension == L".zip" && IsSupportedZipContainer(filePath)) {
      previewKind = L"archive";
      WriteLifecycleLog(L"sp: archive bind begin");
      ComPtr<IShellFolder> archiveFolder;
      PIDLIST_ABSOLUTE archivePidl = nullptr;
      if (SUCCEEDED(item->BindToHandler(nullptr, BHID_SFObject, IID_PPV_ARGS(&archiveFolder))) && archiveFolder &&
          SUCCEEDED(SHGetIDListFromObject(item.Get(), &archivePidl)) && archivePidl) {
        ComPtr<IEnumIDList> enumerator;
        WriteLifecycleLog(L"sp: archive enum begin");
        if (SUCCEEDED(archiveFolder->EnumObjects(g_mainWindow, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS, &enumerator)) && enumerator) {
          PITEMID_CHILD child = nullptr;
          ULONG fetched = 0;
          size_t childCount = 0;
          while (enumerator->Next(1, &child, &fetched) == S_OK && child) {
            ComPtr<IShellItem2> childItem;
            if (SUCCEEDED(SHCreateItemWithParent(archivePidl, archiveFolder.Get(), child, IID_PPV_ARGS(&childItem))) && childItem) {
              LPWSTR childParsingName = nullptr;
              childItem->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &childParsingName);
              const std::wstring childPath = childParsingName ? childParsingName : L"";
              if (childParsingName) CoTaskMemFree(childParsingName);
              const std::wstring childName = ShellPropertyString(childItem.Get(), PKEY_ItemNameDisplay);
              WriteLifecycleLog((L"sp: archive child " + childName.substr(0, 60)).c_str());
              const std::wstring childType = ShellPropertyString(childItem.Get(), PKEY_ItemTypeText);
              ULONGLONG childSize = 0;
              childItem->GetUInt64(PKEY_Size, &childSize);
              const bool childFolder = IsShellContainer(childItem.Get()) && !HasZipExtension(childPath);
              const std::wstring childImage = ShellItemIconDataUrl(childItem.Get(), 32, childPath);
              if (childCount++) childJson << L',';
              childJson << L"{\"name\":\"" << JsonEscape(childName) << L"\",\"path\":\"" << JsonEscape(childPath)
                << L"\",\"typeText\":\"" << JsonEscape(childType) << L"\",\"size\":" << childSize
                << L",\"folder\":" << (childFolder ? L"true" : L"false") << L",\"image\":\"" << JsonEscape(childImage) << L"\"}";
            }
            CoTaskMemFree(child);
            child = nullptr;
          }
        }
        WriteLifecycleLog(L"sp: archive enum done");
        CoTaskMemFree(archivePidl);
      }
    } else {
      const std::vector<std::wstring> textTypes = {
        L".txt", L".md", L".markdown", L".log", L".json", L".jsonc", L".xml", L".yaml", L".yml", L".ini",
        L".toml", L".csv", L".tsv", L".env", L".gitignore", L".editorconfig", L".conf", L".cfg",
        L".properties", L".lock", L".cpp", L".cc", L".h", L".hpp", L".c", L".cs", L".js", L".mjs",
        L".cjs", L".jsx", L".ts", L".tsx", L".css", L".scss", L".less", L".html", L".htm", L".vue",
        L".svelte", L".py", L".go", L".rs", L".java", L".kt", L".swift", L".rb", L".php", L".lua",
        L".sql", L".sh", L".bash", L".zsh", L".bat", L".cmd", L".ps1"
      };
      // 无扩展名的常见文本文件（Makefile / Dockerfile / LICENSE…）按文件名识别。
      std::wstring lowerName = name;
      std::transform(lowerName.begin(), lowerName.end(), lowerName.begin(), ::towlower);
      const bool namedTextFile = lowerName == L"makefile" || lowerName == L"dockerfile" ||
        lowerName == L"license" || lowerName == L"readme" || lowerName == L"changelog";
      if (isRegularFile && (std::find(textTypes.begin(), textTypes.end(), extension) != textTypes.end() || namedTextFile)) {
        previewKind = L"text";
        text = ReadTextPreview(filePath);
      } else if (extension == L".mp4" || extension == L".webm" || extension == L".mov" || extension == L".m4v") previewKind = L"video";
      else if (extension == L".mp3" || extension == L".wav" || extension == L".m4a" || extension == L".ogg" || extension == L".flac") previewKind = L"audio";
      else if (extension == L".pdf") previewKind = L"pdf";
      else if (IsDirectImageExtension(extension)) previewKind = L"image";

      std::filesystem::path resourceFile = filePath;
      if (!isRegularFile && previewKind == L"image") {
        if (MaterializeShellPreviewItem(item.Get(), name, previewGeneration, resourceFile)) {
          ComPtr<IShellItem2> extracted;
          if (SUCCEEDED(SHCreateItemFromParsingName(resourceFile.c_str(), nullptr, IID_PPV_ARGS(&extracted))) && extracted) {
            extracted->GetUInt32(PKEY_Image_HorizontalSize, &width);
            extracted->GetUInt32(PKEY_Image_VerticalSize, &height);
            if (g_shellPreviewGeneration.load() == previewGeneration) {
              image = ShellItemImageDataUrl(
                extracted.Get(), 1024, nullptr, nullptr, nullptr, false, resourceFile.wstring());
            }
          }
          if (g_shellPreviewGeneration.load() == previewGeneration) {
            std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
            g_shellPreviewTempFolder = resourceFile.parent_path();
          } else {
            RemoveTreeBestEffort(resourceFile.parent_path());
          }
        }
      }
      if ((previewKind == L"image" || previewKind == L"video" || previewKind == L"audio" || previewKind == L"pdf") &&
          std::filesystem::is_regular_file(resourceFile, error) && !error) {
        const std::wstring host = MediaHostForSurface(L"preview:" + surfaceId + L":" + parsingName);
        if (g_shellPreviewGeneration.load() == previewGeneration) {
          std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
          g_shellPreviewMediaHost = host;
          g_mediaFolders[host] = resourceFile.parent_path();
          resource = L"https://" + host + L"/" + UrlEncode(resourceFile.filename().wstring());
        }
      }
    }
    childJson << L']';
    if (g_shellPreviewGeneration.load() != previewGeneration) {
      if (SUCCEEDED(initialized)) CoUninitialize();
      return;
    }
    const std::wstring parent = filePath.has_parent_path() ? filePath.parent_path().wstring() : L"";
    PostToCanvasAsync(L"{\"type\":\"native-shell-preview\",\"surfaceId\":\"" + JsonEscape(surfaceId) +
      L"\",\"path\":\"" + JsonEscape(parsingName) + L"\",\"parentPath\":\"" + JsonEscape(parent) +
      L"\",\"name\":\"" + JsonEscape(name) + L"\",\"typeText\":\"" + JsonEscape(type) +
      L"\",\"modified\":\"" + JsonEscape(modifiedText) + L"\",\"created\":\"" + JsonEscape(createdText) +
      L"\",\"size\":" + std::to_wstring(size) + L",\"readOnly\":" + std::wstring(readOnly ? L"true" : L"false") +
      L",\"hidden\":" + std::wstring(hidden ? L"true" : L"false") + L",\"width\":" + std::to_wstring(width) +
      L",\"height\":" + std::to_wstring(height) + L",\"durationMs\":" + std::to_wstring(mediaDuration / 10000ULL) +
      L",\"codec\":\"" + JsonEscape(codec) + L"\",\"colorMode\":\"" + JsonEscape(colorMode) +
      L"\",\"pageCount\":" + std::to_wstring(pageCount) + L",\"previewKind\":\"" + JsonEscape(previewKind) +
      L"\",\"resource\":\"" + JsonEscape(resource) + L"\",\"image\":\"" + JsonEscape(image) +
      L"\",\"text\":\"" + JsonEscape(text) + L"\",\"children\":" + childJson.str() + L"}");

    if (isDirectory) {
      ULONGLONG totalSize = 0, fileCount = 0, folderCount = 0;
      std::error_code walkError;
      std::filesystem::recursive_directory_iterator iterator(parsingName, std::filesystem::directory_options::skip_permission_denied, walkError), end;
      while (!walkError && iterator != end && g_shellPreviewGeneration.load() == previewGeneration) {
        const DWORD attributes = GetFileAttributesW(iterator->path().c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) { iterator.increment(walkError); continue; }
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) && (attributes & FILE_ATTRIBUTE_DIRECTORY)) iterator.disable_recursion_pending();
        if (attributes & FILE_ATTRIBUTE_DIRECTORY) ++folderCount;
        else {
          ++fileCount;
          const auto bytes = iterator->file_size(walkError);
          if (!walkError) totalSize += static_cast<ULONGLONG>(bytes); else walkError.clear();
        }
        iterator.increment(walkError);
      }
      if (g_shellPreviewGeneration.load() == previewGeneration) {
        PostToCanvasAsync(L"{\"type\":\"native-shell-preview-stats\",\"surfaceId\":\"" + JsonEscape(surfaceId) +
          L"\",\"path\":\"" + JsonEscape(parsingName) + L"\",\"folderFileCount\":" + std::to_wstring(fileCount) +
          L",\"folderFolderCount\":" + std::to_wstring(folderCount) + L",\"folderTotalSize\":" + std::to_wstring(totalSize) + L"}");
      }
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

void HandleShellPreviewThumbnailsRequest(const std::wstring& message) {
  const std::wstring surfaceId = JsonStringValue(message, L"surfaceId");
  const auto paths = JsonStringArrayValue(message, L"paths");
  const unsigned long previewGeneration = g_shellPreviewGeneration.load();
  const unsigned long thumbnailGeneration = ++g_shellPreviewThumbnailGeneration;
  if (paths.empty()) return;
  // A single cancellable worker deliberately stays below the four-decoder cap.
  // Shell archive thumbnail handlers may extract to a temporary directory; a
  // new viewport request invalidates this batch before it starts more work.
  std::thread([surfaceId, paths, previewGeneration, thumbnailGeneration]() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    for (const auto& path : paths) {
      if (g_shellPreviewGeneration.load() != previewGeneration ||
          g_shellPreviewThumbnailGeneration.load() != thumbnailGeneration) break;
      WriteLifecycleLog((L"pthumb: begin " + path.substr(0, 120)).c_str());
      ComPtr<IShellItem2> item;
      if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) continue;
      ComPtr<IShellItem2> thumbnailItem = item;
      std::wstring thumbnailPath = path;
      const DWORD attributes = GetFileAttributesW(path.c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES) {
        std::filesystem::path temporary;
        const std::wstring itemName = ShellPropertyString(item.Get(), PKEY_ItemNameDisplay);
        ULONGLONG nestedBytes = 0;
        item->GetUInt64(PKEY_Size, &nestedBytes);
        if (nestedBytes > kMaxShellPreviewMaterializeBytes) {
          WriteLifecycleLog((L"pthumb: skip big " + itemName.substr(0, 80) + L" " +
            std::to_wstring(nestedBytes)).c_str());
          continue;
        }
        WriteLifecycleLog((L"pthumb: materialize begin " + itemName.substr(0, 80)).c_str());
        if (!MaterializeShellPreviewItem(item.Get(), itemName, previewGeneration, temporary)) continue;
        WriteLifecycleLog(L"pthumb: materialize done");
        ComPtr<IShellItem2> extracted;
        if (FAILED(SHCreateItemFromParsingName(temporary.c_str(), nullptr, IID_PPV_ARGS(&extracted))) || !extracted) continue;
        thumbnailItem = extracted;
        thumbnailPath = temporary.wstring();
        if (g_shellPreviewGeneration.load() == previewGeneration) {
          std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
          g_shellPreviewTempFolder = temporary.parent_path();
        } else {
          RemoveTreeBestEffort(temporary.parent_path());
          break;
        }
      }
      bool isThumbnail = false;
      WriteLifecycleLog(L"pthumb: extract begin");
      const std::wstring image = ShellItemImageDataUrl(
        thumbnailItem.Get(), 320, &isThumbnail, nullptr, nullptr, false, thumbnailPath);
      WriteLifecycleLog(L"pthumb: extract done");
      if (g_shellPreviewGeneration.load() != previewGeneration ||
          g_shellPreviewThumbnailGeneration.load() != thumbnailGeneration) break;
      if (!isThumbnail || image.empty()) continue;
      PostToCanvasAsync(L"{\"type\":\"native-shell-preview-thumbnail\",\"surfaceId\":\"" +
        JsonEscape(surfaceId) + L"\",\"path\":\"" + JsonEscape(path) +
        L"\",\"image\":\"" + JsonEscape(image) + L"\"}");
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

std::wstring CurrentFolderPath(const std::shared_ptr<NativeSurface>& surface) {
  const auto view = CurrentFolderView(surface);
  if (!view) return {};
  ComPtr<IShellItem> folder;
  if (FAILED(view->GetFolder(IID_PPV_ARGS(&folder))) || !folder) return {};
  LPWSTR path = nullptr;
  if (FAILED(folder->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &path)) || !path) return {};
  std::wstring result(path);
  CoTaskMemFree(path);
  return result;
}

// WebView2's virtual-folder mapping does not reliably serve media range requests
// when mappings are added after the app document has loaded.  HTMLMediaElement
// needs byte ranges for progressive playback, so expose only the current folder's
// direct children through a narrow, read-only WebResourceRequested endpoint.
class FileRangeStream final
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IStream> {
 public:
  FileRangeStream(std::filesystem::path path, ULONGLONG start, ULONGLONG length)
      : path_(std::move(path)), start_(start), length_(length) {
    handle_ = CreateFileW(path_.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr);
  }

  ~FileRangeStream() override {
    if (handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
  }

  bool valid() const { return handle_ != INVALID_HANDLE_VALUE; }

  HRESULT STDMETHODCALLTYPE Read(void* buffer, ULONG requested, ULONG* read) override {
    if (read) *read = 0;
    if (!buffer) return STG_E_INVALIDPOINTER;
    if (!valid()) return STG_E_READFAULT;
    if (position_ >= length_ || requested == 0) return S_FALSE;
    const ULONG remaining = static_cast<ULONG>(std::min<ULONGLONG>(
      length_ - position_, (std::numeric_limits<ULONG>::max)()));
    const DWORD amount = std::min(requested, remaining);
    LARGE_INTEGER offset{};
    offset.QuadPart = static_cast<LONGLONG>(start_ + position_);
    if (!SetFilePointerEx(handle_, offset, nullptr, FILE_BEGIN)) return STG_E_SEEKERROR;
    DWORD actual = 0;
    if (!ReadFile(handle_, buffer, amount, &actual, nullptr)) return STG_E_READFAULT;
    position_ += actual;
    if (read) *read = actual;
    return actual == requested ? S_OK : S_FALSE;
  }

  HRESULT STDMETHODCALLTYPE Write(const void*, ULONG, ULONG*) override { return STG_E_ACCESSDENIED; }

  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER* newPosition) override {
    LONGLONG base = 0;
    if (origin == STREAM_SEEK_CUR) base = static_cast<LONGLONG>(position_);
    else if (origin == STREAM_SEEK_END) base = static_cast<LONGLONG>(length_);
    else if (origin != STREAM_SEEK_SET) return STG_E_INVALIDFUNCTION;
    if ((move.QuadPart < 0 && base < -move.QuadPart) ||
        (move.QuadPart > 0 && static_cast<ULONGLONG>(move.QuadPart) > length_ - std::min<ULONGLONG>(length_, base))) {
      return STG_E_INVALIDFUNCTION;
    }
    const LONGLONG next = base + move.QuadPart;
    if (next < 0 || static_cast<ULONGLONG>(next) > length_) return STG_E_INVALIDFUNCTION;
    position_ = static_cast<ULONGLONG>(next);
    if (newPosition) newPosition->QuadPart = position_;
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return STG_E_ACCESSDENIED; }

  HRESULT STDMETHODCALLTYPE CopyTo(IStream* target, ULARGE_INTEGER amount,
      ULARGE_INTEGER* readTotal, ULARGE_INTEGER* writtenTotal) override {
    if (!target) return STG_E_INVALIDPOINTER;
    if (readTotal) readTotal->QuadPart = 0;
    if (writtenTotal) writtenTotal->QuadPart = 0;
    std::array<unsigned char, 64 * 1024> buffer{};
    ULONGLONG remaining = std::min<ULONGLONG>(amount.QuadPart, length_ - position_);
    while (remaining) {
      const ULONG wanted = static_cast<ULONG>(std::min<ULONGLONG>(remaining, buffer.size()));
      ULONG actual = 0;
      const HRESULT result = Read(buffer.data(), wanted, &actual);
      if (FAILED(result) || !actual) return FAILED(result) ? result : S_FALSE;
      ULONG written = 0;
      const HRESULT writeResult = target->Write(buffer.data(), actual, &written);
      if (readTotal) readTotal->QuadPart += actual;
      if (writtenTotal) writtenTotal->QuadPart += written;
      if (FAILED(writeResult) || written != actual) return FAILED(writeResult) ? writeResult : STG_E_MEDIUMFULL;
      remaining -= actual;
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Revert() override { return STG_E_REVERTED; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }

  HRESULT STDMETHODCALLTYPE Stat(STATSTG* stat, DWORD flags) override {
    if (!stat) return STG_E_INVALIDPOINTER;
    ZeroMemory(stat, sizeof(*stat));
    stat->type = STGTY_STREAM;
    stat->cbSize.QuadPart = length_;
    stat->grfMode = STGM_READ;
    if (!(flags & STATFLAG_NONAME)) {
      const std::wstring fileName = path_.filename().wstring();
      stat->pwcsName = static_cast<LPWSTR>(CoTaskMemAlloc((fileName.size() + 1) * sizeof(wchar_t)));
      if (!stat->pwcsName) return E_OUTOFMEMORY;
      memcpy(stat->pwcsName, fileName.c_str(), (fileName.size() + 1) * sizeof(wchar_t));
    }
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE Clone(IStream** clone) override {
    if (!clone) return STG_E_INVALIDPOINTER;
    *clone = nullptr;
    auto copy = Microsoft::WRL::Make<FileRangeStream>(path_, start_, length_);
    if (!copy || !copy->valid()) return STG_E_READFAULT;
    copy->position_ = position_;
    return copy.CopyTo(clone);
  }

 private:
  std::filesystem::path path_;
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  ULONGLONG start_ = 0;
  ULONGLONG length_ = 0;
  ULONGLONG position_ = 0;
};

std::wstring DecodeUrlValue(const std::wstring& encoded) {
  std::string bytes;
  bytes.reserve(encoded.size());
  auto hex = [](wchar_t value) -> int {
    if (value >= L'0' && value <= L'9') return value - L'0';
    if (value >= L'a' && value <= L'f') return value - L'a' + 10;
    if (value >= L'A' && value <= L'F') return value - L'A' + 10;
    return -1;
  };
  for (size_t index = 0; index < encoded.size(); ++index) {
    if (encoded[index] == L'%' && index + 2 < encoded.size()) {
      const int high = hex(encoded[index + 1]);
      const int low = hex(encoded[index + 2]);
      if (high < 0 || low < 0) return {};
      bytes.push_back(static_cast<char>((high << 4) | low));
      index += 2;
    } else if (encoded[index] <= 0x7f) {
      bytes.push_back(static_cast<char>(encoded[index]));
    } else {
      return {};
    }
  }
  if (bytes.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
    static_cast<int>(bytes.size()), nullptr, 0);
  if (!length) return {};
  std::wstring value(length, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(),
    static_cast<int>(bytes.size()), value.data(), length);
  return value;
}

void SendWindowSnapInput(HWND window, WORD arrowKey) {
  if (!window || GetForegroundWindow() != window) return;
  if ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0) return;
  INPUT inputs[4]{};
  for (auto& input : inputs) input.type = INPUT_KEYBOARD;
  inputs[0].ki.wVk = VK_LWIN;
  inputs[1].ki.wVk = arrowKey;
  inputs[2].ki.wVk = arrowKey;
  inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
  inputs[3].ki.wVk = VK_LWIN;
  inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
  SendInput(static_cast<UINT>(std::size(inputs)), inputs, sizeof(INPUT));
}

void QueueWindowSnapInput(HWND window, WORD arrowKey) {
  if (!window || GetForegroundWindow() != window) return;
  std::thread([window, arrowKey]() {
    for (int attempt = 0; attempt < 100; ++attempt) {
      if (!IsWindow(window) || GetForegroundWindow() != window) return;
      const bool shortcutKeysDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 ||
        (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 ||
        (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0 ||
        (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 ||
        (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0 ||
        (GetAsyncKeyState(arrowKey) & 0x8000) != 0;
      if (!shortcutKeysDown) {
        SendWindowSnapInput(window, arrowKey);
        return;
      }
      Sleep(10);
    }
  }).detach();
}

std::wstring TileWindowHandleToken(HWND window) {
  std::wostringstream token;
  token << std::hex << std::uppercase << reinterpret_cast<uintptr_t>(window);
  return token.str();
}

bool IsTileWindowCandidate(HWND window, std::wstring* title = nullptr) {
  if (!window || window == g_mainWindow || window == GetShellWindow() || !IsWindow(window) || !IsWindowVisible(window)) return false;
  const LONG_PTR extendedStyle = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if ((extendedStyle & WS_EX_TOOLWINDOW) != 0) return false;
  if (GetWindow(window, GW_OWNER) && (extendedStyle & WS_EX_APPWINDOW) == 0) return false;
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0) return false;
  const int titleLength = GetWindowTextLengthW(window);
  if (titleLength <= 0) return false;
  std::wstring windowTitle(static_cast<size_t>(titleLength) + 1, L'\0');
  const int copied = GetWindowTextW(window, windowTitle.data(), static_cast<int>(windowTitle.size()));
  if (copied <= 0) return false;
  windowTitle.resize(static_cast<size_t>(copied));
  if (std::all_of(windowTitle.begin(), windowTitle.end(), [](wchar_t value) { return iswspace(value) != 0; })) return false;
  if (title) *title = std::move(windowTitle);
  return true;
}

BOOL CALLBACK CollectTileWindow(HWND window, LPARAM value) {
  auto* candidates = reinterpret_cast<std::vector<TileWindowCandidate>*>(value);
  if (!candidates) return FALSE;
  std::wstring title;
  if (IsTileWindowCandidate(window, &title)) candidates->push_back({window, std::move(title)});
  return TRUE;
}

// 候选窗口的进程名（用于把常用程序记住、下次自动勾上）。
std::wstring WindowProcessName(HWND window) {
  DWORD processId = 0;
  GetWindowThreadProcessId(window, &processId);
  if (!processId) return {};
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (!process) return {};
  wchar_t buffer[MAX_PATH * 2]{};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  std::wstring name;
  if (QueryFullProcessImageNameW(process, 0, buffer, &size)) {
    name = std::filesystem::path(buffer).stem().wstring();
  }
  CloseHandle(process);
  return name;
}

void SendTileWindowCandidates() {
  g_tileWindowCandidates.clear();
  EnumWindows(CollectTileWindow, reinterpret_cast<LPARAM>(&g_tileWindowCandidates));
  std::wstring json = L"{\"type\":\"native-window-tile-candidates\",\"windows\":[";
  for (size_t index = 0; index < g_tileWindowCandidates.size(); ++index) {
    if (index) json += L",";
    const auto& candidate = g_tileWindowCandidates[index];
    json += L"{\"handle\":\"" + TileWindowHandleToken(candidate.window) +
      L"\",\"title\":\"" + JsonEscape(candidate.title) +
      L"\",\"process\":\"" + JsonEscape(WindowProcessName(candidate.window)) + L"\"}";
  }
  PostToCanvas(json + L"]}");
}

void SendTileWindowResult(bool success, size_t count, const std::wstring& error = {}) {
  PostToCanvas(L"{\"type\":\"native-window-tile-result\",\"success\":" +
    std::wstring(success ? L"true" : L"false") + L",\"count\":" + std::to_wstring(count) +
    (error.empty() ? L"" : L",\"error\":\"" + JsonEscape(error) + L"\"") + L"}");
}

// 分屏模板：x/y/w/h 是当前屏幕工作区的比例；槽位顺序 = 窗口填充顺序（第一个槽默认给掌中界）。
struct TileSlotRect { double x; double y; double w; double h; };
struct TileSlotTemplate { const wchar_t* id; size_t slots; TileSlotRect rects[4]; };

const TileSlotTemplate kTileSlotTemplates[] = {
  { L"cols2",      2, { {0.0, 0.0, 0.5, 1.0}, {0.5, 0.0, 0.5, 1.0} } },
  { L"rows2",      2, { {0.0, 0.0, 1.0, 0.5}, {0.0, 0.5, 1.0, 0.5} } },
  { L"cols3",      3, { {0.0, 0.0, 1.0 / 3.0, 1.0}, {1.0 / 3.0, 0.0, 1.0 / 3.0, 1.0}, {2.0 / 3.0, 0.0, 1.0 / 3.0, 1.0} } },
  { L"cols4",      4, { {0.0, 0.0, 0.25, 1.0}, {0.25, 0.0, 0.25, 1.0}, {0.5, 0.0, 0.25, 1.0}, {0.75, 0.0, 0.25, 1.0} } },
  { L"grid2x2",    4, { {0.0, 0.0, 0.5, 0.5}, {0.5, 0.0, 0.5, 0.5}, {0.0, 0.5, 0.5, 0.5}, {0.5, 0.5, 0.5, 0.5} } },
  { L"mainLeft2",  3, { {0.0, 0.0, 2.0 / 3.0, 1.0}, {2.0 / 3.0, 0.0, 1.0 / 3.0, 0.5}, {2.0 / 3.0, 0.5, 1.0 / 3.0, 0.5} } },
  { L"mainRight2", 3, { {0.0, 0.0, 1.0 / 3.0, 0.5}, {0.0, 0.5, 1.0 / 3.0, 0.5}, {1.0 / 3.0, 0.0, 2.0 / 3.0, 1.0} } },
  { L"mainTop2",   3, { {0.0, 0.0, 1.0, 2.0 / 3.0}, {0.0, 2.0 / 3.0, 0.5, 1.0 / 3.0}, {0.5, 2.0 / 3.0, 0.5, 1.0 / 3.0} } },
};

const TileSlotTemplate* FindTileSlotTemplate(const std::wstring& id) {
  for (const auto& entry : kTileSlotTemplates) {
    if (id == entry.id) return &entry;
  }
  return nullptr;
}

// 用系统贴靠（Win+方向键）摆放外部窗口：贴靠后的窗口会和掌中界构成一对，
// 中间的边界可以像 Windows 原生一样拖动（两边一起变），而不是死板的固定位置。
bool SnapWindowWithSystem(HWND window, WORD arrowKey) {
  if (!window || !IsWindow(window)) return false;
  if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
  SetForegroundWindow(window);
  for (int attempt = 0; attempt < 60; ++attempt) {
    if (GetForegroundWindow() == window) break;
    Sleep(15);
  }
  Sleep(50);
  SendWindowSnapInput(window, arrowKey);
  return true;
}

// 目标窗口是否已经落在期望的位置上（容忍系统边框/不可见边框的误差）。
bool WindowCoversRect(HWND window, const RECT& bounds) {
  RECT current{};
  if (!GetWindowRect(window, &current)) return false;
  const int tolerance = 24;
  return std::abs(current.left - bounds.left) <= tolerance &&
    std::abs(current.top - bounds.top) <= tolerance &&
    std::abs((current.right - current.left) - (bounds.right - bounds.left)) <= tolerance * 2 &&
    std::abs((current.bottom - current.top) - (bounds.bottom - bounds.top)) <= tolerance * 2;
}

// 哪些槽位能用系统贴靠表达（两分屏）。返回箭头键，0 表示这个槽位只能用 SetWindowPos。
WORD TileSlotSnapArrow(const std::wstring& layoutId, size_t selfSlot, size_t slot) {
  if (layoutId == L"cols2") return slot == 0 ? VK_LEFT : VK_RIGHT;
  if (layoutId == L"rows2") return slot == 0 ? VK_UP : VK_DOWN;
  (void)selfSlot;
  return 0;
}

// 拖动分屏边界：掌中界与搭档窗口一起改大小（ratio = 掌中界占的比例）。
void AdjustSplitBoundary(double ratio) {
  if (!g_splitPartner.active || !g_splitPartner.window || !IsWindow(g_splitPartner.window) || !g_mainWindow) return;
  const double clamped = std::min(0.85, std::max(0.15, ratio));
  const RECT work = g_splitPartner.work;
  const int width = work.right - work.left;
  const int height = work.bottom - work.top;
  if (width <= 0 || height <= 0) return;
  RECT self = work;
  RECT partner = work;
  if (g_splitPartner.vertical) {
    const int boundary = work.left + static_cast<int>(width * clamped + 0.5);
    if (g_splitPartner.selfFirst) { self.right = boundary; partner.left = boundary; }
    else { partner.right = boundary; self.left = boundary; }
  } else {
    const int boundary = work.top + static_cast<int>(height * clamped + 0.5);
    if (g_splitPartner.selfFirst) { self.bottom = boundary; partner.top = boundary; }
    else { partner.bottom = boundary; self.top = boundary; }
  }
  g_splitPartner.ratio = clamped;
  SetWindowPos(g_mainWindow, HWND_TOP, self.left, self.top, self.right - self.left, self.bottom - self.top,
    SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  SetWindowPos(g_splitPartner.window, HWND_TOP, partner.left, partner.top, partner.right - partner.left, partner.bottom - partner.top,
    SWP_NOACTIVATE | SWP_NOOWNERZORDER);
}

// 前端只能给出自己在窗口内的位移（不知道屏幕坐标），这里换算成边界比例。
void HandleSplitDrag(const std::wstring& message) {
  if (!g_splitPartner.active || !g_splitPartner.window || !IsWindow(g_splitPartner.window)) return;
  const double delta = JsonDoubleValue(message, L"delta");
  const int width = g_splitPartner.work.right - g_splitPartner.work.left;
  const int height = g_splitPartner.work.bottom - g_splitPartner.work.top;
  if (width <= 0 || height <= 0) return;
  const double span = g_splitPartner.vertical ? static_cast<double>(width) : static_cast<double>(height);
  if (span <= 0) return;
  // 掌中界在左/上时，边界右移=自己变大；在右/下时相反。
  const double direction = g_splitPartner.selfFirst ? 1.0 : -1.0;
  AdjustSplitBoundary(g_splitPartner.ratio + direction * delta / span);
}

void TileSelectedWindows(const std::wstring& message) {
  if (!g_mainWindow) return;
  const auto tokens = JsonStringArrayValue(message, L"handles");
  if (tokens.empty()) {
    SendTileWindowResult(false, 0, L"请至少选择一个窗口");
    return;
  }
  std::vector<HWND> selected;
  std::unordered_set<HWND> seen;
  selected.reserve(tokens.size());
  for (const auto& token : tokens) {
    const auto candidate = std::find_if(g_tileWindowCandidates.begin(), g_tileWindowCandidates.end(),
      [&token](const TileWindowCandidate& entry) { return TileWindowHandleToken(entry.window) == token; });
    if (candidate == g_tileWindowCandidates.end() || seen.count(candidate->window) ||
        !IsTileWindowCandidate(candidate->window)) {
      SendTileWindowResult(false, 0, L"窗口列表已经变化，请重新选择");
      return;
    }
    seen.insert(candidate->window);
    selected.push_back(candidate->window);
  }

  const std::wstring layoutId = JsonStringValue(message, L"layout");
  const TileSlotTemplate* layout = FindTileSlotTemplate(layoutId);
  if (layout && selected.size() + 1 > layout->slots) {
    SendTileWindowResult(false, 0, L"这个布局只有 " + std::to_wstring(layout->slots) + L" 格，请少选几个程序或换更大的布局");
    return;
  }
  size_t selfSlot = 0;
  if (layout) {
    const int requested = JsonIntValue(message, L"selfSlot");
    if (requested > 0) selfSlot = static_cast<size_t>(requested);
    if (selfSlot >= layout->slots) selfSlot = 0;
  }

  MONITORINFO monitorInfo{sizeof(monitorInfo)};
  const HMONITOR monitor = MonitorFromWindow(g_mainWindow, MONITOR_DEFAULTTONEAREST);
  if (!monitor || !GetMonitorInfoW(monitor, &monitorInfo)) {
    SendTileWindowResult(false, 0, L"无法读取掌中界所在屏幕的工作区");
    return;
  }
  std::vector<HWND> windows;
  windows.reserve(selected.size() + 1);
  windows.push_back(g_mainWindow);
  windows.insert(windows.end(), selected.begin(), selected.end());
  for (const HWND window : windows) {
    if (IsIconic(window) || IsZoomed(window)) ShowWindow(window, SW_RESTORE);
  }

  const RECT work = monitorInfo.rcWork;
  const int workWidth = work.right - work.left;
  const int workHeight = work.bottom - work.top;
  if (workWidth <= 0 || workHeight <= 0) {
    SendTileWindowResult(false, 0, L"无法读取掌中界所在屏幕的工作区");
    return;
  }

  std::vector<std::pair<HWND, RECT>> plan;
  plan.reserve(windows.size());
  if (layout) {
    // 掌中界放用户指定的格子，其余窗口按选择顺序填剩下的格子。
    std::vector<size_t> slotOrder;
    slotOrder.reserve(layout->slots);
    slotOrder.push_back(selfSlot);
    for (size_t index = 0; index < layout->slots; ++index) {
      if (index != selfSlot) slotOrder.push_back(index);
    }
    for (size_t order = 0; order < windows.size() && order < slotOrder.size(); ++order) {
      const auto& slot = layout->rects[slotOrder[order]];
      const RECT bounds{
        work.left + static_cast<LONG>(workWidth * slot.x + 0.5),
        work.top + static_cast<LONG>(workHeight * slot.y + 0.5),
        work.left + static_cast<LONG>(workWidth * (slot.x + slot.w) + 0.5),
        work.top + static_cast<LONG>(workHeight * (slot.y + slot.h) + 0.5)};
      plan.push_back({windows[order], bounds});
    }
  } else {
    // 没有布局 id 的旧调用：沿用等分列。
    for (size_t index = 0; index < windows.size(); ++index) {
      const int left = work.left + static_cast<int>((static_cast<long long>(workWidth) * index) / windows.size());
      const int right = work.left + static_cast<int>((static_cast<long long>(workWidth) * (index + 1)) / windows.size());
      plan.push_back({windows[index], RECT{left, work.top, right, work.bottom}});
    }
  }

  RememberSelfBeforeSplit();
  if (g_tileApplyBusy.exchange(true)) {
    SendTileWindowResult(false, 0, L"上一次分屏还在进行中，请稍等一下");
    return;
  }

  // 应用阶段丢到工作线程：系统贴靠要抢前台、还要等窗口响应，放 UI 线程会把界面卡住。
  std::vector<size_t> slotOrder;
  if (layout) {
    slotOrder.push_back(selfSlot);
    for (size_t index = 0; index < layout->slots; ++index) {
      if (index != selfSlot) slotOrder.push_back(index);
    }
  }
  const std::wstring snapLayoutId = layoutId;
  const bool hasLayout = layout != nullptr;
  std::vector<std::pair<HWND, RECT>> applyPlan = std::move(plan);
  // 两分屏时记住「搭档」，之后拖动分屏把手就能两边一起改大小。
  SplitPartnerState partnerPlan;
  if (layout && applyPlan.size() >= 2) {
    partnerPlan.window = applyPlan[1].first;
    partnerPlan.work = work;
    partnerPlan.selfFirst = selfSlot == 0;
    partnerPlan.vertical = layoutId == L"cols2";
    partnerPlan.active = applyPlan.size() == 2;
    partnerPlan.ratio = 0.5;
  }
  WatchSplitPartner(partnerPlan.active ? partnerPlan.window : nullptr);
  if (partnerPlan.active && g_mainWindow) SetTimer(g_mainWindow, kSplitWatchTimer, 500, nullptr);
  std::thread([applyPlan, slotOrder, snapLayoutId, hasLayout, partnerPlan]() {
    // 直接用 SetWindowPos 精确摆放，不走系统贴靠：
    // 系统贴靠会弹出「贴靠助手」并在旁边留一个空框，用户明确不要那个框；
    // 分屏比例改用掌中界自己的边界把手调（已经实测能两边一起变）。
    const bool usedSystemSnap = false;
    bool success = !applyPlan.empty();
    for (const auto& entry : applyPlan) {
      if (!IsWindow(entry.first)) { success = false; break; }
      if (IsIconic(entry.first) || IsZoomed(entry.first)) ShowWindow(entry.first, SW_RESTORE);
    }
    auto placeAll = [&applyPlan]() {
      bool ok = true;
      for (const auto& entry : applyPlan) {
        const RECT bounds = entry.second;
        if (!SetWindowPos(entry.first, HWND_TOP, bounds.left, bounds.top,
              bounds.right - bounds.left, bounds.bottom - bounds.top,
              SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOOWNERZORDER)) ok = false;
      }
      return ok;
    };
    success = success && placeAll();
    // 有些程序（尤其刚从最大化恢复的）第一次 SetWindowPos 会被自己拉回去，再补一次。
    Sleep(220);
    placeAll();
    g_tileApplyBusy = false;
    if (!success) {
      PostToCanvasAsync(L"{\"type\":\"native-window-tile-result\",\"success\":false,\"count\":0,\"error\":\"至少一个窗口无法调整大小或位置\"}");
      return;
    }
    // 别把贴靠前记下的位置冲掉（partnerPlan 是新构造的，没带这份信息）。
    const RECT savedSelfBefore = g_splitPartner.selfBefore;
    const bool hadSelfBefore = g_splitPartner.hasSelfBefore;
    g_splitPartner = partnerPlan;
    g_splitPartner.selfBefore = savedSelfBefore;
    g_splitPartner.hasSelfBefore = hadSelfBefore;
    // 从这一刻起给 2.5 秒宽限期：摆放动画期间不判定“搭档被搬走”。
    g_splitPartner.watchArmedAt = GetTickCount64() + 2500;
    g_splitPartner.partnerDriftTicks = 0;
    if (g_mainWindow) SetForegroundWindow(g_mainWindow);
    PostToCanvasAsync(L"{\"type\":\"native-window-tile-result\",\"success\":true,\"count\":" +
      std::to_wstring(applyPlan.size()) + (usedSystemSnap ? L",\"systemSnap\":true" : L",\"systemSnap\":false") +
      (partnerPlan.active ? L",\"partner\":true}" : L",\"partner\":false}"));
  }).detach();
}

std::wstring DecodeMediaFileName(const std::wstring& encoded) {
  const std::wstring value = DecodeUrlValue(encoded);
  if (value == L"." || value == L".." || value.find_first_of(L"/\\") != std::wstring::npos) return {};
  return value;
}

std::wstring MediaContentType(const std::filesystem::path& path) {
  const std::wstring extension = LowerExtension(path);
  if (extension == L".jpg" || extension == L".jpeg") return L"image/jpeg";
  if (extension == L".png") return L"image/png";
  if (extension == L".gif") return L"image/gif";
  if (extension == L".bmp") return L"image/bmp";
  if (extension == L".webp") return L"image/webp";
  if (extension == L".svg") return L"image/svg+xml";
  if (extension == L".tif" || extension == L".tiff") return L"image/tiff";
  if (extension == L".pdf") return L"application/pdf";
  if (extension == L".mp4" || extension == L".m4v" || extension == L".mov") return L"video/mp4";
  if (extension == L".webm") return L"video/webm";
  if (extension == L".mp3") return L"audio/mpeg";
  if (extension == L".m4a") return L"audio/mp4";
  if (extension == L".ogg") return L"audio/ogg";
  if (extension == L".wav") return L"audio/wav";
  return L"application/octet-stream";
}

bool TryParseByteRange(const std::wstring& value, ULONGLONG total,
    ULONGLONG& start, ULONGLONG& end) {
  if (value.rfind(L"bytes=", 0) != 0 || value.find(L',') != std::wstring::npos || !total) return false;
  const std::wstring range = value.substr(6);
  const size_t dash = range.find(L'-');
  if (dash == std::wstring::npos) return false;
  try {
    if (dash == 0) {
      const ULONGLONG suffix = std::stoull(range.substr(1));
      if (!suffix) return false;
      start = suffix >= total ? 0 : total - suffix;
      end = total - 1;
    } else {
      start = std::stoull(range.substr(0, dash));
      end = dash + 1 < range.size() ? std::stoull(range.substr(dash + 1)) : total - 1;
      if (start >= total) return false;
      end = std::min(end, total - 1);
      if (end < start) return false;
    }
  } catch (...) {
    return false;
  }
  return true;
}

HRESULT HandleMediaWebResourceRequest(ICoreWebView2WebResourceRequestedEventArgs* args,
    ICoreWebView2Environment* environment) {
  if (!args || !environment) return S_OK;
  ComPtr<ICoreWebView2WebResourceRequest> request;
  if (FAILED(args->get_Request(&request)) || !request) return S_OK;
  LPWSTR rawUri = nullptr;
  if (FAILED(request->get_Uri(&rawUri)) || !rawUri) return S_OK;
  const std::wstring uri(rawUri);
  CoTaskMemFree(rawUri);
  constexpr wchar_t prefix[] = L"https://";
  if (uri.rfind(prefix, 0) != 0) return S_OK;
  const size_t pathAt = uri.find(L'/', std::size(prefix) - 1);
  if (pathAt == std::wstring::npos) return S_OK;
  const std::wstring host = uri.substr(std::size(prefix) - 1, pathAt - (std::size(prefix) - 1));
  std::filesystem::path mediaFolder;
  {
    std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
    const auto folder = g_mediaFolders.find(host);
    if (folder == g_mediaFolders.end()) return S_OK;
    mediaFolder = folder->second;
  }
  const size_t queryAt = uri.find_first_of(L"?#", pathAt + 1);
  const std::wstring name = DecodeMediaFileName(uri.substr(pathAt + 1,
    queryAt == std::wstring::npos ? std::wstring::npos : queryAt - pathAt - 1));
  if (name.empty()) return S_OK;
  const std::filesystem::path path = mediaFolder / name;
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes) ||
      IsFileSystemDirectory(attributes.dwFileAttributes)) return S_OK;
  const ULONGLONG total = (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32) |
    attributes.nFileSizeLow;
  if (!total) return S_OK;

  std::wstring range;
  ComPtr<ICoreWebView2HttpRequestHeaders> requestHeaders;
  if (SUCCEEDED(request->get_Headers(&requestHeaders)) && requestHeaders) {
    LPWSTR value = nullptr;
    if (SUCCEEDED(requestHeaders->GetHeader(L"Range", &value)) && value) {
      range = value;
      CoTaskMemFree(value);
    }
  }
  ULONGLONG start = 0;
  ULONGLONG end = total - 1;
  const bool partial = !range.empty() && TryParseByteRange(range, total, start, end);
  const ULONGLONG length = end - start + 1;
  auto stream = Microsoft::WRL::Make<FileRangeStream>(path, start, length);
  if (!stream || !stream->valid()) return S_OK;

  std::wostringstream headers;
  headers << L"Content-Type: " << MediaContentType(path) << L"\r\n"
          << L"Content-Length: " << length << L"\r\n"
          << L"Accept-Ranges: bytes\r\n"
          << L"Access-Control-Allow-Origin: *\r\n"
          << L"Cache-Control: no-store\r\n";
  if (partial) headers << L"Content-Range: bytes " << start << L'-' << end << L'/' << total << L"\r\n";
  ComPtr<ICoreWebView2WebResourceResponse> response;
  const HRESULT created = environment->CreateWebResourceResponse(stream.Get(), partial ? 206 : 200,
    partial ? L"Partial Content" : L"OK", headers.str().c_str(), &response);
  if (SUCCEEDED(created) && response) return args->put_Response(response.Get());
  return S_OK;
}

HRESULT HandleThumbnailWebResourceRequest(ICoreWebView2WebResourceRequestedEventArgs* args,
    ICoreWebView2Environment* environment) {
  if (!args || !environment) return S_OK;
  // 未命中一律立刻回应，不再留空响应——留空会被 WebView2 漏给真实网络栈，
  // 请求要等到网络超时（~30 秒）才失败，缩略图会一直转圈。
  // 响应头必须以 CRLF 结尾；这里用 wchar_t 码点拼接以避免转义序列。
  const std::wstring corsHeaders = std::wstring(L"Access-Control-Allow-Origin: *") + static_cast<wchar_t>(13) + static_cast<wchar_t>(10);
  const auto respond = [&](int status, const wchar_t* reason) -> HRESULT {
    ComPtr<ICoreWebView2WebResourceResponse> response;
    const HRESULT created = environment->CreateWebResourceResponse(nullptr, status, reason, corsHeaders.c_str(), &response);
    if (SUCCEEDED(created) && response) return args->put_Response(response.Get());
    return S_OK;
  };
  ComPtr<ICoreWebView2WebResourceRequest> request;
  if (FAILED(args->get_Request(&request)) || !request) return S_OK;
  LPWSTR rawMethod = nullptr;
  if (FAILED(request->get_Method(&rawMethod)) || !rawMethod) return S_OK;
  const bool readable = _wcsicmp(rawMethod, L"GET") == 0;
  CoTaskMemFree(rawMethod);
  if (!readable) return S_OK;
  LPWSTR rawUri = nullptr;
  if (FAILED(request->get_Uri(&rawUri)) || !rawUri) return S_OK;
  const std::wstring uri(rawUri);
  CoTaskMemFree(rawUri);
  constexpr wchar_t prefix[] = L"https://";
  if (uri.rfind(prefix, 0) != 0) return S_OK;
  const size_t pathAt = uri.find(L'/', std::size(prefix) - 1);
  if (pathAt == std::wstring::npos) return S_OK;
  const std::wstring host = uri.substr(std::size(prefix) - 1, pathAt - (std::size(prefix) - 1));
  constexpr wchar_t suffix[] = L".zhangzhongjie.local";
  const size_t suffixLength = std::size(suffix) - 1;
  if (host.rfind(L"thumb-", 0) != 0 || host.size() <= 6 + suffixLength ||
      host.rfind(suffix) != host.size() - suffixLength) return S_OK;
  const size_t queryAt = uri.find_first_of(L"?#", pathAt + 1);
  const std::wstring source = DecodeUrlValue(uri.substr(pathAt + 1,
    queryAt == std::wstring::npos ? std::wstring::npos : queryAt - pathAt - 1));
  if (source.empty()) return respond(400, L"Bad Request");
  const std::wstring normalized = NormalizedThumbnailSource(source);
  std::filesystem::path cachePath;
  std::wstring cacheKey;
  {
    std::lock_guard<std::mutex> lock(g_thumbnailRoutesMutex);
    const auto route = g_thumbnailRoutes.find(host);
    if (route == g_thumbnailRoutes.end() || !route->second.displayedPaths.contains(normalized)) return respond(404, L"Not Found");
    const auto resource = route->second.resources.find(normalized);
    if (resource == route->second.resources.end()) return respond(404, L"Not Found");
    cachePath = resource->second.path;
    cacheKey = resource->second.cacheKey;
  }
  if (queryAt == std::wstring::npos || uri.substr(queryAt) != L"?v=" + cacheKey) return respond(404, L"Not Found");
  const std::wstring etag = L"\"" + cacheKey + L"\"";
  ComPtr<ICoreWebView2HttpRequestHeaders> requestHeaders;
  LPWSTR rawIfNoneMatch = nullptr;
  const bool notModified = SUCCEEDED(request->get_Headers(&requestHeaders)) && requestHeaders &&
    SUCCEEDED(requestHeaders->GetHeader(L"If-None-Match", &rawIfNoneMatch)) && rawIfNoneMatch &&
    etag == rawIfNoneMatch;
  if (rawIfNoneMatch) CoTaskMemFree(rawIfNoneMatch);
  if (notModified) {
    const std::wstring headers = L"Access-Control-Allow-Origin: *\r\nCache-Control: private, max-age=300\r\nETag: " +
      etag + L"\r\n";
    ComPtr<ICoreWebView2WebResourceResponse> response;
    const HRESULT created = environment->CreateWebResourceResponse(
      nullptr, 304, L"Not Modified", headers.c_str(), &response);
    if (SUCCEEDED(created) && response) return args->put_Response(response.Get());
    return S_OK;
  }

  std::shared_ptr<const std::vector<unsigned char>> bytes;
  {
    std::lock_guard<std::mutex> lock(g_thumbnailMemoryCacheMutex);
    const auto cached = g_thumbnailMemoryCache.find(cacheKey);
    if (cached != g_thumbnailMemoryCache.end()) {
      cached->second.lastUsed = ++g_thumbnailMemoryCacheClock;
      bytes = cached->second.bytes;
    }
  }

  if (!bytes) {
    std::error_code error;
    const auto cacheRoot = std::filesystem::weakly_canonical(ThumbnailCacheFolder(), error);
    if (error) return respond(500, L"Server Error");
    const auto canonical = std::filesystem::weakly_canonical(cachePath, error);
    if (error || canonical.parent_path() != cacheRoot ||
        !std::filesystem::is_regular_file(canonical, error) || error) return respond(404, L"Not Found");
    const auto total = std::filesystem::file_size(canonical, error);
    if (error || !total || total > (std::numeric_limits<UINT>::max)() ||
        total > static_cast<uintmax_t>((std::numeric_limits<std::streamsize>::max)())) return respond(404, L"Not Found");

    auto loaded = std::make_shared<std::vector<unsigned char>>(static_cast<size_t>(total));
    std::ifstream file(canonical, std::ios::binary);
    if (!file || !file.read(reinterpret_cast<char*>(loaded->data()), static_cast<std::streamsize>(total))) return respond(500, L"Server Error");
    bytes = loaded;

    if (loaded->size() <= kThumbnailMemoryCacheMaximumBytes) {
      std::lock_guard<std::mutex> lock(g_thumbnailMemoryCacheMutex);
      if (const auto existing = g_thumbnailMemoryCache.find(cacheKey);
          existing != g_thumbnailMemoryCache.end()) {
        g_thumbnailMemoryCacheBytes -= std::min(g_thumbnailMemoryCacheBytes, existing->second.bytes->size());
        g_thumbnailMemoryCache.erase(existing);
      }
      g_thumbnailMemoryCache[cacheKey] = {loaded, ++g_thumbnailMemoryCacheClock};
      g_thumbnailMemoryCacheBytes += loaded->size();
      while (g_thumbnailMemoryCache.size() > kThumbnailMemoryCacheMaximumEntries ||
             g_thumbnailMemoryCacheBytes > kThumbnailMemoryCacheMaximumBytes) {
        auto oldest = g_thumbnailMemoryCache.end();
        for (auto entry = g_thumbnailMemoryCache.begin(); entry != g_thumbnailMemoryCache.end(); ++entry) {
          if (oldest == g_thumbnailMemoryCache.end() || entry->second.lastUsed < oldest->second.lastUsed) oldest = entry;
        }
        if (oldest == g_thumbnailMemoryCache.end()) break;
        g_thumbnailMemoryCacheBytes -= std::min(g_thumbnailMemoryCacheBytes, oldest->second.bytes->size());
        g_thumbnailMemoryCache.erase(oldest);
      }
    }
  }

  ComPtr<IStream> stream;
  stream.Attach(SHCreateMemStream(bytes->data(), static_cast<UINT>(bytes->size())));
  if (!stream) return S_OK;
  const auto total = bytes->size();
  const std::wstring headers = L"Content-Type: image/png\r\nContent-Length: " + std::to_wstring(total) +
    L"\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: private, max-age=300\r\nETag: \"" +
    cacheKey + L"\"\r\n";
  ComPtr<ICoreWebView2WebResourceResponse> response;
  const HRESULT created = environment->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &response);
  if (SUCCEEDED(created) && response) return args->put_Response(response.Get());
  return S_OK;
}

std::wstring MediaHostForSurface(const std::wstring& surfaceId) {
  std::wostringstream host;
  host << L"media-" << std::hex << std::hash<std::wstring>{}(surfaceId)
       << L".zhangzhongjie.local";
  return host.str();
}

void HandleExplorerMediaRootRequest(const std::wstring& message) {
  const std::wstring surfaceId = JsonStringValue(message, L"surfaceId");
  const auto surface = FindSurface(surfaceId);
  if (!surface || surface->kind != L"explorer") return;
  const unsigned long generation = static_cast<unsigned long>(JsonIntValue(message, L"generation"));

  std::wstring resource;
  const std::filesystem::path folderPath(CurrentFolderPath(surface));
  const std::filesystem::path requestedPath(JsonStringValue(message, L"path"));
  std::error_code error;
  // A Shell change notification may advance explorerGeneration between the
  // items-end message and this request.  Bind the endpoint to the actual folder
  // shown by that list instead of rejecting a harmless generation skew.
  const bool sameFolder = !folderPath.empty() && !requestedPath.empty() &&
    std::filesystem::equivalent(folderPath, requestedPath, error);
  if (sameFolder && !error && std::filesystem::is_directory(folderPath, error)) {
    const std::wstring host = MediaHostForSurface(surfaceId);
    {
      std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
      g_mediaFolders[host] = folderPath;
    }
    resource = L"https://" + host + L"/";
  }
  PostToCanvas(L"{\"type\":\"native-explorer-media-root\",\"surfaceId\":\"" + JsonEscape(surfaceId) +
    L"\",\"generation\":" + std::to_wstring(generation) +
    L",\"resource\":\"" + JsonEscape(resource) + L"\"}");
}

bool FilePreviewRequestCurrent(const std::wstring& requestId, unsigned long generation) {
  std::lock_guard<std::mutex> lock(g_filePreviewMutex);
  const auto found = g_filePreviewGenerations.find(requestId);
  return found != g_filePreviewGenerations.end() && found->second == generation;
}

// —— 应用卡片：固定常用软件到画布，双击启动。 ——
// 启动走系统 shell（.exe/.lnk/.bat/.cmd 都通）；工作目录取程序所在目录——
// 设计软件（3ds Max/CAD 类）不设工作目录会丢配置或启动失败。
// 列出桌面（含公共桌面）的快捷方式：全局常用栏的「添加应用」数据源。
// 搜索栏 Hermes：把问题交给本机 hermes CLI（--query-file 读文件零转义、-Q 安静输出），
// 拿回纯文本答案给搜索栏面板。这是「在掌中界里直接问 Hermes」的桥。
std::wstring CanvasBridgeRoot() {
  wchar_t tempBuffer[32768]{};
  if (!GetTempPathW(static_cast<DWORD>(std::size(tempBuffer)), tempBuffer)) return {};
  return (std::filesystem::path(tempBuffer) / L"ZhangZhongJiePetBridge").wstring();
}

std::wstring BuildCanvasBridgeInstructions() {
  return L"【掌中界画布操作接口（你可以真的动手操作画布）】\n"
    L"通过文件与掌中界画布交互：先写请求文件，再读结果文件。\n"
    L"目录：" + CanvasBridgeRoot() + L"\n"
    L"步骤：\n"
    L"1) 在该目录创建 req-<英文数字名>.json（UTF-8、无 BOM），内容是一个 JSON 对象，支持以下操作：\n"
    L"   {\"op\":\"list\"} 列出画布元素（返回 id/类型/标题/路径）；\n"
    L"   {\"op\":\"add_note\",\"title\":\"标题\",\"text\":\"内容\"} 在画布上加一张便签卡；\n"
    L"   {\"op\":\"add_web\",\"url\":\"https://…或file:///地址\",\"title\":\"可选标题\"} 加网页卡；\n"
    L"   {\"op\":\"add_folder\",\"path\":\"D:\\\\目录\"} 加文件夹卡；\n"
    L"   {\"op\":\"add_image\",\"path\":\"E:\\\\图片.png\"} 加图片卡（只引用磁盘文件，不复制、不移动）；\n"
    L"   {\"op\":\"remove\",\"match\":\"关键词或卡片id\"} 删除标题/路径匹配的卡片；\n"
    L"   {\"op\":\"select\",\"match\":\"关键词或卡片id\"} 选中匹配的卡片。\n"
    L"2) 等待同目录出现 res-<同名>.json（通常 1 秒内，最多 10 秒），内容形如 {\"ok\":true,…} 或 {\"ok\":false,\"error\":\"原因\"}。\n"
    L"3) 完成后向用户报告你实际做了什么（加了什么卡、删了什么卡）。\n"
    L"注意：删除只影响画布上的卡片，不会删除磁盘文件；JSON 里的路径反斜杠要转义或直接用正斜杠。";
}

void StartCanvasBridgeOnce() {
  std::call_once(g_canvasBridgeOnce, []() {
    const std::filesystem::path root(CanvasBridgeRoot());
    std::error_code error;
    std::filesystem::create_directories(root, error);
    WriteLifecycleLog((L"canvas-bridge root " + root.wstring()).c_str());
    std::thread([root]() {
      unsigned long long counter = 0;
      for (;;) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        std::error_code scanError;
        std::vector<std::filesystem::path> requests;
        for (auto& entry : std::filesystem::directory_iterator(root, scanError)) {
          const auto name = entry.path().filename().wstring();
          if (name.rfind(L"req-", 0) == 0 && entry.path().extension() == L".json") requests.push_back(entry.path());
        }
        for (const auto& requestPath : requests) {
          std::ifstream input(requestPath, std::ios::binary);
          std::string raw;
          if (input) {
            input.seekg(0, std::ios::end);
            raw.resize(static_cast<size_t>(input.tellg()));
            input.seekg(0, std::ios::beg);
            if (!raw.empty()) input.read(&raw[0], static_cast<std::streamsize>(raw.size()));
          }
          input.close();
          std::filesystem::remove(requestPath, scanError);
          if (raw.empty() || raw.front() != '{') continue;
          const std::wstring opId = L"op-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(counter++);
          PostToCanvasAsync(L"{\"type\":\"zzj-canvas-op\",\"opId\":\"" + opId + L"\",\"payload\":" + Utf8ToWide(raw) + L"}");
          std::wstring result;
          for (int wait = 0; wait < 200; ++wait) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            std::lock_guard<std::mutex> guard(g_canvasBridgeMutex);
            const auto found = g_canvasBridgeResults.find(opId);
            if (found != g_canvasBridgeResults.end()) {
              result = found->second;
              g_canvasBridgeResults.erase(found);
              break;
            }
          }
          if (result.empty()) result = L"{\"ok\":false,\"error\":\"画布端没有响应（超时）\"}";
          const std::wstring fileName = requestPath.filename().wstring();
          const std::wstring suffix = fileName.size() > 4 ? fileName.substr(4) : (L"op-" + std::to_wstring(counter) + L".json");
          const auto resultPath = root / (L"res-" + suffix);
          std::ofstream output(resultPath, std::ios::binary | std::ios::trunc);
          const std::string utf8 = WideToUtf8(result);
          output.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
          WriteLifecycleLog((L"canvas-bridge served " + suffix).c_str());
        }
      }
    }).detach();
  });
}

void HandleHermesAsk(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring prompt = JsonStringValue(message, L"prompt");
  const std::wstring mode = JsonStringValue(message, L"mode");
  const std::wstring image = JsonStringValue(message, L"image");
  const std::wstring model = JsonStringValue(message, L"model");
  if (requestId.empty() || prompt.empty()) return;
  std::thread([requestId, prompt, mode, image, model]() {
    if (mode == L"pet") StartCanvasBridgeOnce();
    wchar_t tempBuffer[32768]{};
    if (!GetTempPathW(static_cast<DWORD>(std::size(tempBuffer)), tempBuffer)) {
      PostToCanvasAsync(L"{\"type\":\"native-hermes-answer\",\"requestId\":\"" + JsonEscape(requestId) +
        L"\",\"ok\":false,\"error\":\"无法访问临时目录\"}");
      return;
    }
    const auto root = std::filesystem::path(tempBuffer) / L"ZhangZhongJieHermes";
    std::error_code error;
    std::filesystem::create_directories(root, error);
    const std::wstring stamp = std::to_wstring(GetTickCount64());
    const auto promptFile = root / (L"ask-" + stamp + L".txt");
    const auto answerFile = root / (L"answer-" + stamp + L".txt");
    {
      std::wstring promptText = prompt;
      if (mode == L"pet") promptText = BuildCanvasBridgeInstructions() + L"\n\n" + prompt;
      std::ofstream out(promptFile, std::ios::binary | std::ios::trunc);
      const std::string utf8 = WideToUtf8(promptText);
      out.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
    }
    // 走批处理文件而不是长命令行：同时解决「重定向下 Python 输出编码崩溃」的问题——
    // hermes 的提示行带 ⚠️ 表情，GBK 控制台会直接 UnicodeEncodeError 退出。
    const auto batchFile = root / (L"run-" + stamp + L".cmd");
    {
      std::ofstream batch(batchFile, std::ios::binary | std::ios::trunc);
      batch << "@echo off\r\n";
      batch << "chcp 65001 >nul\r\n";
      batch << "set PYTHONUTF8=1\r\n";
      batch << "set PYTHONIOENCODING=utf-8\r\n";
      batch << "hermes chat";
      if (mode == L"pet") batch << " --continue zhangzhongjie-pet --create-if-missing";
      batch << " --query-file \"" << WideToUtf8(promptFile.wstring()) << "\" -Q";
      if (!image.empty()) batch << " --image \"" << WideToUtf8(image) << "\"";
      if (!model.empty()) batch << " -m \"" << WideToUtf8(model) << "\"";
      batch << " > \"" << WideToUtf8(answerFile.wstring()) << "\" 2>&1\r\n";
      batch << "exit /b %ERRORLEVEL%\r\n";
    }
    const std::wstring command = L"cmd /c \"" + batchFile.wstring() + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process{};
    std::vector<wchar_t> commandLine(command.begin(), command.end());
    commandLine.push_back(L'\0');
    if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                        nullptr, nullptr, &startup, &process)) {
      WriteLifecycleLog(L"hermes-ask: CreateProcess failed");
      PostToCanvasAsync(L"{\"type\":\"native-hermes-answer\",\"requestId\":\"" + JsonEscape(requestId) +
        L"\",\"ok\":false,\"error\":\"无法启动命令处理器\"}");
      std::filesystem::remove(batchFile, error);
      return;
    }
    const DWORD waited = WaitForSingleObject(process.hProcess, mode == L"pet" ? 1200000 : 300000);
    if (waited == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1);
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    std::string raw;
    {
      std::ifstream in(answerFile, std::ios::binary);
      if (in) {
        in.seekg(0, std::ios::end);
        const auto size = in.tellg();
        in.seekg(0, std::ios::beg);
        if (size > 0) {
          raw.resize(static_cast<size_t>(size));
          in.read(&raw[0], static_cast<std::streamsize>(raw.size()));
        }
      }
    }
    WriteLifecycleLog((L"hermes-" + (mode.empty() ? std::wstring(L"ask") : mode) + L" done: exit=" + std::to_wstring(exitCode) + L" raw=" + std::to_wstring(raw.size())).c_str());
    if (exitCode != 0 && raw.size() > 0) {
      WriteLifecycleLog((L"hermes-ask raw: " + Utf8ToWide(raw).substr(0, 400)).c_str());
    }
    const bool keepScene = exitCode != 0 || raw.empty();
    if (!keepScene) {
      std::filesystem::remove(promptFile, error);
      std::filesystem::remove(answerFile, error);
      std::filesystem::remove(batchFile, error);
    } else {
      WriteLifecycleLog((L"hermes-ask scene kept at " + root.wstring()).c_str());
    }
    if (raw.size() >= 3 && static_cast<unsigned char>(raw[0]) == 0xEF &&
        static_cast<unsigned char>(raw[1]) == 0xBB && static_cast<unsigned char>(raw[2]) == 0xBF) {
      raw.erase(0, 3);
    }
    std::wstring text = Utf8ToWide(raw);
    // 提取答案：逐行过滤，不依赖行序（实测 session_id 元信息行有时在答案前、有时在后）。
    //   1) 去掉 ANSI 转义；2) 剥掉行首尾的框线字符；3) 丢掉元信息/警告行；4) 余下拼回。
    std::wstring stripped;
    stripped.reserve(text.size());
    for (size_t index = 0; index < text.size(); ++index) {
      if (text[index] == 0x1b) {
        while (index < text.size() && text[index] != L'm') ++index;
        continue;
      }
      stripped.push_back(text[index]);
    }
    const std::wstring boxChars = L"\u2500\u2501\u254C\u256D\u256E\u2570\u256F\u2502\u2503\u258F\u2595\u2554\u2557\u255A\u255D\u2551\u2550 ";
    const auto dropCore = [](const std::wstring& core) {
      static const wchar_t* prefixes[] = {L"session_id:", L"Session:", L"Title:", L"Duration:",
        L"Messages:", L"Resume this session", L"hermes ", L"Initializing agent", L"Query:"};
      for (const wchar_t* prefix : prefixes) {
        if (core.rfind(prefix, 0) == 0) return true;
      }
      // 警告行与续接提示行：用子串匹配，不依赖行首符号
      if (core.find(L"Normalized model") != std::wstring::npos) return true;
      if (core.find(L"Resumed session") != std::wstring::npos) return true;
      if (core.rfind(L"[tool]", 0) == 0) return true;
      if (core.rfind(L"[skills]", 0) == 0) return true;
      return false;
    };
    std::wstring answer;
    size_t lineStart = 0;
    while (lineStart <= stripped.size()) {
      size_t lineEnd = stripped.find(L'\n', lineStart);
      const bool lastLine = lineEnd == std::wstring::npos;
      std::wstring line = stripped.substr(lineStart, (lastLine ? stripped.size() : lineEnd) - lineStart);
      if (!line.empty() && line.back() == L'\r') line.pop_back();
      size_t begin = 0;
      size_t end = line.size();
      while (begin < end && boxChars.find(line[begin]) != std::wstring::npos) ++begin;
      while (end > begin && boxChars.find(line[end - 1]) != std::wstring::npos) --end;
      const std::wstring core = line.substr(begin, end - begin);
      if (!core.empty() && !dropCore(core)) {
        if (!answer.empty()) answer += L"\n";
        answer += core;
      }
      if (lastLine) break;
      lineStart = lineEnd + 1;
    }
    WriteLifecycleLog((L"hermes-ask parse: exit=" + std::to_wstring(exitCode) + L" rawBytes=" +
      std::to_wstring(raw.size()) + L" answerChars=" + std::to_wstring(answer.size())).c_str());
    const bool ok = exitCode == 0 && !answer.empty();
    const std::wstring errorText = ok ? std::wstring()
      : (exitCode == 9009 ? L"系统里找不到 hermes 命令（确认已安装并加入 PATH）" : L"Hermes 执行失败或超时");
    PostToCanvasAsync(L"{\"type\":\"native-hermes-answer\",\"requestId\":\"" + JsonEscape(requestId) +
      L"\",\"ok\":" + std::wstring(ok ? L"true" : L"false") + L",\"answer\":\"" + JsonEscape(answer) +
      L"\",\"error\":\"" + JsonEscape(errorText) + L"\"}");
  }).detach();
}

void HandleListDesktopShortcuts(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  std::thread([requestId]() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    std::wostringstream json;
    json << L"{\"type\":\"native-desktop-shortcuts\",\"requestId\":\"" << JsonEscape(requestId) << L"\",\"items\":[";
    size_t count = 0;
    const KNOWNFOLDERID* folders[] = {&FOLDERID_Desktop, &FOLDERID_PublicDesktop};
    for (const KNOWNFOLDERID* folderId : folders) {
      if (count >= 80) break;
      PWSTR folderPath = nullptr;
      if (FAILED(SHGetKnownFolderPath(*folderId, KF_FLAG_DONT_VERIFY, nullptr, &folderPath)) || !folderPath) continue;
      std::error_code error;
      for (std::filesystem::directory_iterator iterator(std::filesystem::path(folderPath),
             std::filesystem::directory_options::skip_permission_denied, error), end;
           !error && iterator != end && count < 80; iterator.increment(error)) {
        const std::wstring extension = iterator->path().extension().wstring();
        if (_wcsicmp(extension.c_str(), L".lnk") != 0 && _wcsicmp(extension.c_str(), L".url") != 0 &&
            _wcsicmp(extension.c_str(), L".exe") != 0) continue;
        ComPtr<IShellItem2> item;
        if (FAILED(SHCreateItemFromParsingName(iterator->path().c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) continue;
        std::wstring name = ShellPropertyString(item.Get(), PKEY_ItemNameDisplay);
        if (name.empty()) name = iterator->path().stem().wstring();
        std::wstring image = ShellItemIconDataUrl(item.Get(), 32, iterator->path().wstring());
        if (count++) json << L',';
        json << L"{\"name\":\"" << JsonEscape(name) << L"\",\"path\":\"" << JsonEscape(iterator->path().wstring())
          << L"\",\"image\":\"" << JsonEscape(image) << L"\"}";
      }
      CoTaskMemFree(folderPath);
    }
    json << L"]}";
    PostToCanvasAsync(json.str());
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

void HandleLaunchApp(const std::wstring& message) {

  const std::wstring args = JsonStringValue(message, L"args");  const std::wstring path = JsonStringValue(message, L"path");
  if (path.empty()) return;
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_FLAG_NO_UI;
  info.lpVerb = L"open";
  info.lpFile = path.c_str();
  std::wstring launchArgs = args;
  if (!launchArgs.empty()) info.lpParameters = launchArgs.c_str();
  std::wstring directory = std::filesystem::path(path).parent_path().wstring();
  if (!directory.empty()) info.lpDirectory = directory.c_str();
  info.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&info)) {
    const DWORD lastError = GetLastError();
    wchar_t detail[512]{};
    swprintf_s(detail, L"launch-app failed (winerr=%lu): ", static_cast<unsigned long>(lastError));
    WriteLifecycleLog((std::wstring(detail) + path).c_str());
    PostToCanvasAsync(L"{\"type\":\"native-toast\",\"text\":\"启动失败：系统拒绝运行这个程序（可能路径已失效）\"}");
  }
}

// 选择程序对话框：只列可执行入口。
void HandleAppPickExecutable(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  std::wstring selected;
  ComPtr<IFileOpenDialog> dialog;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) && dialog) {
    FILEOPENDIALOGOPTIONS options{};
    if (SUCCEEDED(dialog->GetOptions(&options))) {
      const COMDLG_FILTERSPEC filters[] = {
        {L"程序 (*.exe;*.lnk;*.bat;*.cmd)", L"*.exe;*.lnk;*.bat;*.cmd"},
        {L"所有文件 (*.*)", L"*.*"},
      };
      dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
      dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST);
      dialog->SetTitle(L"选择要固定到画布的应用");
      g_nativeDialogOpen = true;
      const HRESULT result = dialog->Show(g_mainWindow);
      g_nativeDialogOpen = false;
      if (SUCCEEDED(result)) {
        ComPtr<IShellItem> item;
        if (SUCCEEDED(dialog->GetResult(&item)) && item) {
          PWSTR picked = nullptr;
          if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &picked)) && picked) {
            selected.assign(picked);
            CoTaskMemFree(picked);
          }
        }
      }
    }
  }
  PostToCanvasAsync(L"{\"type\":\"native-pick-executable-result\",\"requestId\":\"" + JsonEscape(requestId) +
    L"\",\"path\":\"" + JsonEscape(selected) + L"\"}");
}

// 解析图标与显示名（.lnk 取快捷方式自己的图标，与资源管理器一致）。
void HandleAppResolve(const std::wstring& message) {
  const std::wstring path = JsonStringValue(message, L"path");
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  if (path.empty()) return;
  std::thread([path, requestId]() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    std::wstring name;
    std::wstring image;
    ComPtr<IShellItem2> item;
    const HRESULT parsed = SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item));
    if (SUCCEEDED(parsed) && item) {
      name = ShellPropertyString(item.Get(), PKEY_ItemNameDisplay);
      image = ShellItemIconDataUrl(item.Get(), 128, path);
      wchar_t detail[256]{};
      swprintf_s(detail, L"app-resolve ok: name=%s imageLen=%u ", name.c_str(), static_cast<unsigned>(image.size()));
      WriteLifecycleLog((std::wstring(detail) + path).c_str());
    } else {
      wchar_t detail[256]{};
      swprintf_s(detail, L"app-resolve parse failed hr=0x%08lx ", static_cast<unsigned long>(parsed));
      WriteLifecycleLog((std::wstring(detail) + path).c_str());
    }
    PostToCanvasAsync(L"{\"type\":\"native-app-resolve\",\"requestId\":\"" + JsonEscape(requestId) +
      L"\",\"path\":\"" + JsonEscape(path) + L"\",\"name\":\"" + JsonEscape(name) +
      L"\",\"image\":\"" + JsonEscape(image) + L"\"}");
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

void HandleFilePreviewRequest(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring itemId = JsonStringValue(message, L"itemId");
  const std::wstring parsingName = JsonStringValue(message, L"path");
  const int pixels = std::clamp(JsonIntValue(message, L"pixels", 380), 64, 2048);
  if (requestId.empty() || itemId.empty() || parsingName.empty()) return;

  unsigned long generation = 0;
  {
    std::lock_guard<std::mutex> lock(g_filePreviewMutex);
    generation = ++g_filePreviewGenerations[requestId];
  }

  const std::filesystem::path filePath(parsingName);
  const std::wstring extension = LowerExtension(filePath);
  std::wstring resource;
  if (extension == L".pdf" || extension == L".mp4" || extension == L".m4v" ||
      extension == L".mov" || extension == L".webm") {
    std::error_code error;
    const auto parent = filePath.parent_path();
    if (!parent.empty() && std::filesystem::is_directory(parent, error) && !error) {
      const std::wstring host = MediaHostForSurface(itemId);
      {
        std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
        g_mediaFolders[host] = parent;
      }
      resource = L"https://" + host + L"/" + UrlEncode(filePath.filename().wstring());
    }
  }

  std::thread([requestId, itemId, parsingName, extension, resource, pixels, generation]() {
    bool workerSlot = false;
    while (FilePreviewRequestCurrent(requestId, generation)) {
      int workers = g_filePreviewWorkers.load();
      if (workers < 4 && g_filePreviewWorkers.compare_exchange_weak(workers, workers + 1)) {
        workerSlot = true;
        break;
      }
      Sleep(8);
    }
    if (!workerSlot) return;
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    const bool exists = GetFileAttributesExW(parsingName.c_str(), GetFileExInfoStandard, &attributes) &&
      !IsFileSystemDirectory(attributes.dwFileAttributes);
    const ULONGLONG size = exists
      ? (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32) | attributes.nFileSizeLow
      : 0;
    bool imageIsThumbnail = false;
    ULONG width = 0;
    ULONG height = 0;
    std::wstring image;
    if (exists && FilePreviewRequestCurrent(requestId, generation)) {
      ComPtr<IShellItem2> item;
      if (SUCCEEDED(SHCreateItemFromParsingName(parsingName.c_str(), nullptr, IID_PPV_ARGS(&item))) && item) {
        item->GetUInt32(PKEY_Image_HorizontalSize, &width);
        item->GetUInt32(PKEY_Image_VerticalSize, &height);
        if (!width) item->GetUInt32(PKEY_Video_FrameWidth, &width);
        if (!height) item->GetUInt32(PKEY_Video_FrameHeight, &height);
        ULONG bitmapWidth = 0;
        ULONG bitmapHeight = 0;
        if (size > kMaxThumbnailSourceBytes) {
          // 超大文件（安装包/大 DWG/PSD 等）不整读渲染预览图，图标兜底，避免数秒到数十秒卡顿。
          image = ShellItemIconDataUrl(item.Get(), 64, parsingName);
        } else {
          image = ShellItemImageDataUrl(
            item.Get(), pixels, &imageIsThumbnail, &bitmapWidth, &bitmapHeight, false, parsingName);
        }
        if (imageIsThumbnail && (!width || !height)) {
          width = bitmapWidth;
          height = bitmapHeight;
        }
        if (image.empty()) image = ShellItemIconDataUrl(item.Get(), 64, parsingName);
      }
    }
    if (FilePreviewRequestCurrent(requestId, generation)) {
      std::wstring previewKind = extension == L".pdf" ? L"pdf"
        : (extension == L".mp4" || extension == L".m4v" || extension == L".mov" || extension == L".webm") ? L"video"
        : L"thumbnail";
      PostToCanvasAsync(L"{\"type\":\"native-file-preview\",\"requestId\":\"" + JsonEscape(requestId) +
        L"\",\"itemId\":\"" + JsonEscape(itemId) + L"\",\"path\":\"" + JsonEscape(parsingName) +
        L"\",\"opened\":" + std::wstring(exists ? L"true" : L"false") +
        L",\"size\":" + std::to_wstring(size) + L",\"image\":\"" + JsonEscape(image) +
        L"\",\"thumbKind\":\"" + (imageIsThumbnail ? L"thumbnail" : L"icon") +
        L"\",\"previewKind\":\"" + previewKind + L"\",\"resource\":\"" + JsonEscape(resource) +
        L"\",\"width\":" + std::to_wstring(width) + L",\"height\":" + std::to_wstring(height) + L"}");
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
    --g_filePreviewWorkers;
  }).detach();
}

void HandleFilePreviewCancel(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring itemId = JsonStringValue(message, L"itemId");
  if (!requestId.empty()) {
    std::lock_guard<std::mutex> lock(g_filePreviewMutex);
    ++g_filePreviewGenerations[requestId];
  }
  if (!itemId.empty()) {
    std::lock_guard<std::mutex> lock(g_mediaFoldersMutex);
    g_mediaFolders.erase(MediaHostForSurface(itemId));
  }
}

std::wstring ShellPropertyString(IShellItem2* item, REFPROPERTYKEY key) {
  if (!item) return {};
  LPWSTR value = nullptr;
  if (FAILED(item->GetString(key, &value)) || !value) return {};
  std::wstring result(value);
  CoTaskMemFree(value);
  return result;
}

std::wstring FormatShellFileTime(const FILETIME& utc) {
  if (!utc.dwLowDateTime && !utc.dwHighDateTime) return {};
  FILETIME local{};
  SYSTEMTIME time{};
  if (!FileTimeToLocalFileTime(&utc, &local) || !FileTimeToSystemTime(&local, &time)) return {};
  wchar_t dateText[80]{};
  wchar_t timeText[80]{};
  GetDateFormatEx(LOCALE_NAME_USER_DEFAULT, DATE_SHORTDATE, &time, nullptr, dateText,
    static_cast<int>(std::size(dateText)), nullptr);
  GetTimeFormatEx(LOCALE_NAME_USER_DEFAULT, TIME_NOSECONDS, &time, nullptr, timeText,
    static_cast<int>(std::size(timeText)));
  return std::wstring(dateText) + (dateText[0] && timeText[0] ? L" " : L"") + timeText;
}

// 排序用真实时间戳；显示文案受系统区域格式影响，跨月/跨年时字符串排序会错序。
ULONGLONG FileTimeStampValue(const FILETIME& time) {
  return (static_cast<ULONGLONG>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}

std::vector<ShellEntry> EnumerateCurrentFolder(const std::shared_ptr<NativeSurface>& surface, bool& needsFallback) {
  std::vector<ShellEntry> entries;
  needsFallback = false;
  const auto view = CurrentFolderView(surface);
  if (!view) { needsFallback = true; return entries; }
  ComPtr<IShellItem> folderItem;
  if (FAILED(view->GetFolder(IID_PPV_ARGS(&folderItem))) || !folderItem) {
    needsFallback = true;
    return entries;
  }
  ComPtr<IShellFolder> folder;
  if (FAILED(folderItem->BindToHandler(nullptr, BHID_SFObject, IID_PPV_ARGS(&folder))) || !folder) {
    needsFallback = true;
    return entries;
  }
  PIDLIST_ABSOLUTE parentPidl = nullptr;
  if (FAILED(SHGetIDListFromObject(folderItem.Get(), &parentPidl)) || !parentPidl) {
    needsFallback = true;
    return entries;
  }

  const bool archiveLocation = IsArchiveShellLocation(surface);
  ComPtr<IEnumIDList> enumerator;
  const HRESULT enumResult = folder->EnumObjects(surface->host,
    SHCONTF_FOLDERS | SHCONTF_NONFOLDERS, &enumerator);
  if (SUCCEEDED(enumResult) && enumerator) {
    PITEMID_CHILD child = nullptr;
    ULONG fetched = 0;
    while (enumerator->Next(1, &child, &fetched) == S_OK && child) {
      ComPtr<IShellItem2> item;
      if (SUCCEEDED(SHCreateItemWithParent(parentPidl, folder.Get(), child, IID_PPV_ARGS(&item))) && item) {
        ShellEntry entry;
        entry.name = ShellPropertyString(item.Get(), PKEY_ItemNameDisplay);
        if (entry.name.empty()) {
          LPWSTR displayName = nullptr;
          if (SUCCEEDED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &displayName)) && displayName) {
            entry.name = displayName;
            CoTaskMemFree(displayName);
          }
        }
        LPWSTR parsingName = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &parsingName)) && parsingName) {
          entry.parsingName = parsingName;
          CoTaskMemFree(parsingName);
        }
        entry.typeText = ShellPropertyString(item.Get(), PKEY_ItemTypeText);
        FILETIME modified{};
        if (SUCCEEDED(item->GetFileTime(PKEY_DateModified, &modified))) {
          entry.modifiedText = FormatShellFileTime(modified);
          entry.modifiedStamp = FileTimeStampValue(modified);
        }
        item->GetUInt64(PKEY_Size, &entry.size);
        entry.folder = IsShellContainer(item.Get());
        // Windows cannot enter a ZIP nested inside another ZIP without first
        // materialising it. Present it as a file and fail explicitly on open.
        if (archiveLocation && HasZipExtension(entry.parsingName)) entry.folder = false;
        SFGAOF attributes = SFGAO_HIDDEN | SFGAO_LINK;
        if (SUCCEEDED(item->GetAttributes(attributes, &attributes))) {
          entry.hidden = (attributes & SFGAO_HIDDEN) != 0;
          entry.shortcut = (attributes & SFGAO_LINK) != 0;
        }
        // Enumeration runs on the Explorer/UI thread. Never ask Shell to render
        // an icon or thumbnail here; visible tiles request those on workers.
        entry.image.clear();
        entry.imageIsThumbnail = false;
        entries.push_back(std::move(entry));
      }
      CoTaskMemFree(child);
      child = nullptr;
    }
  }
  if (FAILED(enumResult)) needsFallback = true;
  if (entries.empty() && SUCCEEDED(enumResult)) {
    SFGAOF attributes = SFGAO_FILESYSTEM | SFGAO_BROWSABLE;
    if (SUCCEEDED(folderItem->GetAttributes(attributes, &attributes)) &&
        !(attributes & SFGAO_FILESYSTEM) && (attributes & SFGAO_BROWSABLE)) {
      needsFallback = true;
    }
  }
  CoTaskMemFree(parentPidl);

  std::stable_sort(entries.begin(), entries.end(), [surface](const ShellEntry& left, const ShellEntry& right) {
    if (left.folder != right.folder) return left.folder;
    const int order = StrCmpLogicalW(left.name.c_str(), right.name.c_str());
    return surface->sortDescending ? order > 0 : order < 0;
  });
  return entries;
}

void SendExplorerItems(const std::shared_ptr<NativeSurface>& surface, const std::wstring& location) {
  if (!surface) return;
  // Any metadata worker for the previous directory must stop before its late
  // results can be associated with the new listing.
  ++surface->explorerMetadataGeneration;
  ++surface->explorerFolderSizeGeneration;
  const unsigned long generation = ++surface->explorerGeneration;
  const std::wstring archiveRoot = ArchiveRootParsingName(surface);
  const bool archiveLocation = !archiveRoot.empty();
  PostToCanvas(L"{\"type\":\"native-explorer-items-start\",\"surfaceId\":\"" + JsonEscape(surface->id) +
    L"\",\"generation\":" + std::to_wstring(generation) +
    L",\"source\":\"" + JsonEscape(location) +
    L"\",\"archive\":" + std::wstring(archiveLocation ? L"true" : L"false") +
    L",\"archiveRoot\":\"" + JsonEscape(archiveRoot) +
    L"\",\"mirrorArchive\":\"" + JsonEscape(surface->mirrorArchive) +
    L"\",\"mirrorRoot\":\"" + JsonEscape(surface->mirrorRoot) + L"\"}");

  bool needsFallback = false;
  const std::vector<ShellEntry> entries = EnumerateCurrentFolder(surface, needsFallback);
  ResetThumbnailRoute(surface->id, entries);
  constexpr size_t kChunkSize = 48;
  for (size_t start = 0; start < entries.size(); start += kChunkSize) {
    std::wostringstream json;
    json << L"{\"type\":\"native-explorer-items-chunk\",\"surfaceId\":\"" << JsonEscape(surface->id)
      << L"\",\"generation\":" << generation << L",\"entries\":[";
    const size_t end = std::min(entries.size(), start + kChunkSize);
    for (size_t index = start; index < end; ++index) {
      if (index > start) json << L',';
      const auto& entry = entries[index];
      json << L"{\"name\":\"" << JsonEscape(entry.name)
        << L"\",\"path\":\"" << JsonEscape(entry.parsingName)
        << L"\",\"typeText\":\"" << JsonEscape(entry.typeText)
        << L"\",\"modified\":\"" << JsonEscape(entry.modifiedText)
        << L"\",\"modifiedStamp\":" << entry.modifiedStamp
        << L",\"image\":\"" << JsonEscape(entry.image)
        << L"\",\"thumbKind\":\"" << (entry.imageIsThumbnail ? L"thumbnail" : L"icon")
        << L"\",\"size\":" << entry.size
        << L",\"folder\":" << (entry.folder ? L"true" : L"false")
        << L",\"hidden\":" << (entry.hidden ? L"true" : L"false")
        << L",\"shortcut\":" << (entry.shortcut ? L"true" : L"false") << L'}';
    }
    json << L"]}";
    PostToCanvas(json.str());
  }
  PostToCanvas(L"{\"type\":\"native-explorer-items-end\",\"surfaceId\":\"" + JsonEscape(surface->id) +
    L"\",\"generation\":" + std::to_wstring(generation) +
    L",\"count\":" + std::to_wstring(entries.size()) +
    L",\"fallback\":" + std::wstring(needsFallback ? L"true" : L"false") + L"}");
  surface->enumeratedLocation = location;
  surface->explorerContentDirty = false;
}

struct ExplorerMetadataEntry {
  std::wstring path;
  std::wstring image;
  bool includeImage = false;
  bool includeDimensions = false;
  bool includeDuration = false;
  bool imageIsThumbnail = false;
  ULONG width = 0;
  ULONG height = 0;
  ULONGLONG durationMilliseconds = 0;
};

void HandleGlobalFavoriteIconRequest(const std::wstring& message) {
  const auto paths = JsonStringArrayValue(message, L"paths");
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const int thumbnailPixels = std::clamp(JsonIntValue(message, L"thumbnailPixels"), 16, 512);
  if (paths.empty()) return;
  std::thread([paths, requestId, thumbnailPixels]() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    std::vector<ExplorerMetadataEntry> batch;
    batch.reserve(paths.size());
    for (const auto& path : paths) {
      ComPtr<IShellItem> item;
      const HRESULT result = path == L"shell:MyComputerFolder"
        ? SHGetKnownFolderItem(FOLDERID_ComputerFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&item))
        : SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item));
      if (FAILED(result) || !item) continue;
      ExplorerMetadataEntry metadata;
      metadata.path = path;
      metadata.image = ShellItemImageDataUrl(
        item.Get(), thumbnailPixels, &metadata.imageIsThumbnail, nullptr, nullptr, false, path);
      if (metadata.image.empty()) continue;
      metadata.includeImage = true;
      batch.push_back(std::move(metadata));
    }
    if (!batch.empty()) {
      std::wostringstream json;
      json << L"{\"type\":\"native-explorer-metadata-chunk\",\"purpose\":\"global-favorite-icon\",\"requestId\":\""
        << JsonEscape(requestId) << L"\",\"entries\":[";
      for (size_t index = 0; index < batch.size(); ++index) {
        if (index) json << L',';
        const auto& entry = batch[index];
        json << L"{\"path\":\"" << JsonEscape(entry.path)
          << L"\",\"image\":\"" << JsonEscape(entry.image)
          << L"\",\"thumbKind\":\"" << (entry.imageIsThumbnail ? L"thumbnail" : L"icon") << L"\"}";
      }
      json << L"]}";
      PostToCanvasAsync(json.str());
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

void HandleExplorerMetadataRequest(const std::wstring& message) {
  if (JsonStringValue(message, L"purpose") == L"global-favorite-icon") {
    HandleGlobalFavoriteIconRequest(message);
    return;
  }
  const std::wstring surfaceId = JsonStringValue(message, L"surfaceId");
  const auto surface = FindSurface(surfaceId);
  if (!surface || surface->kind != L"explorer") return;
  // 拷贝进行中先不抽元数据/缩略图：拷完会重扫一次，卡片自己会补上。
  if (CopyInProgress()) return;

  const unsigned long listGeneration = static_cast<unsigned long>(JsonIntValue(message, L"generation"));
  const bool readDimensions = JsonBoolValue(message, L"dimensions");
  const bool readDuration = JsonBoolValue(message, L"duration");
  const int thumbnailPixels = std::clamp(JsonIntValue(message, L"thumbnailPixels"), 0, 1024);
  const bool readThumbnail = thumbnailPixels > 0;
  const auto paths = JsonStringArrayValue(message, L"paths");
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  ++g_thumbnailPreheatGeneration;
  const unsigned long metadataGeneration = ++surface->explorerMetadataGeneration;
  if ((!readDimensions && !readDuration && !readThumbnail) || paths.empty()) return;

  // Ask the Windows thumbnail cache for the whole visible set first, then let at
  // most four workers extract the misses. The generation token makes every
  // phase stop promptly after a directory change or column toggle.
  std::thread([surface, surfaceId, listGeneration, metadataGeneration, requestId, paths,
               readDimensions, readDuration, readThumbnail, thumbnailPixels]() {
    const auto flush = [&](std::vector<ExplorerMetadataEntry>& batch) {
      if (batch.empty() || surface->explorerMetadataGeneration.load() != metadataGeneration) {
        batch.clear();
        return;
      }
      std::wostringstream json;
      json << L"{\"type\":\"native-explorer-metadata-chunk\",\"surfaceId\":\""
        << JsonEscape(surfaceId) << L"\",\"generation\":" << listGeneration << L",\"entries\":[";
      for (size_t index = 0; index < batch.size(); ++index) {
        if (index) json << L',';
        const auto& entry = batch[index];
        json << L"{\"path\":\"" << JsonEscape(entry.path) << L'"';
        if (entry.includeDimensions) {
          json << L",\"width\":" << entry.width
            << L",\"height\":" << entry.height;
        }
        if (entry.includeDuration) {
          json << L",\"durationMs\":" << entry.durationMilliseconds;
        }
        if (entry.includeImage) {
          json << L",\"image\":\"" << JsonEscape(entry.image)
            << L"\",\"thumbKind\":\"" << (entry.imageIsThumbnail ? L"thumbnail" : L"icon") << L'"';
        }
        json << L'}';
      }
      json << L"]}";
      PostToCanvasAsync(json.str());
      batch.clear();
    };

    std::vector<std::pair<std::wstring, bool>> slowPaths;
    slowPaths.reserve(paths.size());
    if (readThumbnail) {
      const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      std::vector<ExplorerMetadataEntry> cachedBatch;
      cachedBatch.reserve(16);
      auto lastFlush = std::chrono::steady_clock::now();
      for (const auto& path : paths) {
        if (surface->explorerMetadataGeneration.load() != metadataGeneration) break;
        const ThumbnailDiskResult disk = ReadThumbnailDiskCache(path, thumbnailPixels, false);
        if (!disk.path.empty()) {
          ExplorerMetadataEntry metadata;
          metadata.path = path;
          metadata.image = RegisterThumbnailResource(surfaceId, path, disk.path);
          metadata.imageIsThumbnail = disk.thumbnail;
          metadata.includeImage = true;
          cachedBatch.push_back(std::move(metadata));
          if (readDimensions || readDuration) slowPaths.emplace_back(path, false);
          const auto now = std::chrono::steady_clock::now();
          if (cachedBatch.size() >= 16 || now - lastFlush >= std::chrono::milliseconds(100)) {
            flush(cachedBatch);
            lastFlush = now;
          }
          continue;
        }
        ComPtr<IShellItem2> item;
        if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) {
          slowPaths.emplace_back(path, true);
          continue;
        }
        ExplorerMetadataEntry metadata;
        metadata.path = path;
        metadata.image = ShellItemImageDataUrl(item.Get(), thumbnailPixels,
          &metadata.imageIsThumbnail, nullptr, nullptr, true, path);
        if (metadata.image.empty()) {
          // A cache miss is only work for the slow pass. It is deliberately not
          // sent to the frontend, so it cannot consume a thumbnail retry.
          slowPaths.emplace_back(path, true);
          continue;
        }
        const auto cachePath = WriteThumbnailDiskCache(path, thumbnailPixels, metadata.image, metadata.imageIsThumbnail);
        metadata.image = RegisterThumbnailResource(surfaceId, path, cachePath);
        metadata.includeImage = true;
        cachedBatch.push_back(std::move(metadata));
        if (readDimensions || readDuration) slowPaths.emplace_back(path, false);
        const auto now = std::chrono::steady_clock::now();
        if (cachedBatch.size() >= 16 || now - lastFlush >= std::chrono::milliseconds(100)) {
          flush(cachedBatch);
          lastFlush = now;
        }
      }
      flush(cachedBatch);
      if (SUCCEEDED(initialized)) CoUninitialize();
    } else {
      for (const auto& path : paths) slowPaths.emplace_back(path, false);
    }

    std::atomic_size_t nextPath{0};
    const int metadataWorkerLimit = readThumbnail ? 1 : 4;
    const size_t workerCount = std::min<size_t>(metadataWorkerLimit, slowPaths.size());
    std::vector<std::thread> workers;
    workers.reserve(workerCount);
    for (size_t workerIndex = 0; workerIndex < workerCount; ++workerIndex) {
      workers.emplace_back([&]() {
        bool workerSlot = false;
        while (surface->explorerMetadataGeneration.load() == metadataGeneration) {
          int activeWorkers = surface->explorerMetadataWorkers.load();
          if (activeWorkers < 1 && surface->explorerMetadataWorkers.compare_exchange_weak(activeWorkers, activeWorkers + 1)) {
            workerSlot = true;
            break;
          }
          Sleep(8);
        }
        if (!workerSlot) return;
        const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        std::vector<ExplorerMetadataEntry> batch;
        batch.reserve(16);
        auto lastFlush = std::chrono::steady_clock::now();
        while (surface->explorerMetadataGeneration.load() == metadataGeneration) {
          const size_t pathIndex = nextPath.fetch_add(1);
          if (pathIndex >= slowPaths.size()) break;
          const auto& [path, needsThumbnail] = slowPaths[pathIndex];
          ComPtr<IShellItem2> item;
          if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) continue;

          ExplorerMetadataEntry metadata;
          metadata.path = path;
          if (readDimensions) {
            metadata.includeDimensions = true;
            item->GetUInt32(PKEY_Image_HorizontalSize, &metadata.width);
            item->GetUInt32(PKEY_Image_VerticalSize, &metadata.height);
          }
          if (readDuration) {
            metadata.includeDuration = true;
            ULONGLONG duration = 0;
            if (SUCCEEDED(item->GetUInt64(PKEY_Media_Duration, &duration))) {
              metadata.durationMilliseconds = duration / 10000ULL;
            }
          }
          if (needsThumbnail) {
            ULONGLONG payloadBytes = 0;
            WIN32_FILE_ATTRIBUTE_DATA payloadFacts{};
            if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &payloadFacts)) {
              payloadBytes = (static_cast<ULONGLONG>(payloadFacts.nFileSizeHigh) << 32) | payloadFacts.nFileSizeLow;
            }
            if (payloadBytes > kMaxThumbnailSourceBytes) {
              // 大文件走图标：真实缩略图要整读源文件，是「打开大目录就卡」的主要来源。
              metadata.image = ShellItemIconDataUrl(item.Get(), 64, path);
              metadata.imageIsThumbnail = false;
            } else {
              metadata.image = ShellItemImageDataUrl(
                item.Get(), thumbnailPixels, &metadata.imageIsThumbnail, nullptr, nullptr, false, path);
            }
            metadata.includeImage = true;
            if (!metadata.image.empty()) {
              const auto cachePath = WriteThumbnailDiskCache(path, thumbnailPixels, metadata.image, metadata.imageIsThumbnail);
              metadata.image = RegisterThumbnailResource(surfaceId, path, cachePath);
            }
          }
          if (surface->explorerMetadataGeneration.load() != metadataGeneration) break;
          batch.push_back(std::move(metadata));
          const auto now = std::chrono::steady_clock::now();
          if (batch.size() >= 16 || now - lastFlush >= std::chrono::milliseconds(100)) {
            flush(batch);
            lastFlush = now;
          }
        }
        flush(batch);
        if (SUCCEEDED(initialized)) CoUninitialize();
        --surface->explorerMetadataWorkers;
      });
    }
    for (auto& worker : workers) {
      if (worker.joinable()) worker.join();
    }
    if (!requestId.empty() && surface->explorerMetadataGeneration.load() == metadataGeneration) {
      PostToCanvasAsync(L"{\"type\":\"native-explorer-metadata-end\",\"surfaceId\":\"" +
        JsonEscape(surfaceId) + L"\",\"generation\":" + std::to_wstring(listGeneration) +
        L",\"requestId\":\"" + JsonEscape(requestId) + L"\"}");
    }
  }).detach();
}

void HandleExplorerMetadataCancel(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (surface && surface->kind == L"explorer") ++surface->explorerMetadataGeneration;
  ++g_thumbnailPreheatGeneration;
}

void HandleThumbnailPreheat(const std::wstring& message) {
  const auto folders = JsonStringArrayValue(message, L"paths");
  const int pixels = std::clamp(JsonIntValue(message, L"thumbnailPixels"), 64, 1024);
  const unsigned long generation = ++g_thumbnailPreheatGeneration;
  if (folders.empty()) return;
  if (CopyInProgress()) return;  // 系统正在拷贝：预热先让路，别抢磁盘
  std::thread([folders, pixels, generation]() {
    size_t folderCount = 0;
    for (const auto& folder : folders) {
      if (folderCount++ >= 5 || g_thumbnailPreheatGeneration.load() != generation) break;
      std::error_code error;
      if (!std::filesystem::is_directory(folder, error) || error) continue;
      size_t fileCount = 0;
      for (std::filesystem::directory_iterator iterator(folder, error), end;
           !error && iterator != end; iterator.increment(error)) {
        if (g_thumbnailPreheatGeneration.load() != generation) break;
        if (!iterator->is_regular_file(error) || error) { error.clear(); continue; }
        if (fileCount++ >= 200) break;
        ReadThumbnailDiskCache(iterator->path().wstring(), pixels, false);
        if (fileCount % 32 == 0) Sleep(15);
      }
    }
  }).detach();
}

ULONGLONG FileTimeStamp(const FILETIME& value) {
  ULARGE_INTEGER stamp{};
  stamp.LowPart = value.dwLowDateTime;
  stamp.HighPart = value.dwHighDateTime;
  return stamp.QuadPart;
}

bool DirectoryModifiedStamp(const std::filesystem::path& path, ULONGLONG& stamp) {
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes) ||
      !IsFileSystemDirectory(attributes.dwFileAttributes) ||
      (attributes.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
  stamp = FileTimeStamp(attributes.ftLastWriteTime);
  return true;
}

std::wstring FolderSizeCacheKey(const std::filesystem::path& path) {
  std::error_code error;
  std::wstring key = std::filesystem::absolute(path, error).lexically_normal().wstring();
  if (error) key = path.lexically_normal().wstring();
  std::transform(key.begin(), key.end(), key.begin(), [](wchar_t value) { return static_cast<wchar_t>(towlower(value)); });
  return key;
}

bool CalculateFolderSize(const std::filesystem::path& root,
                         const std::shared_ptr<NativeSurface>& surface,
                         unsigned long folderSizeGeneration,
                         ULONGLONG& size) {
  std::error_code error;
  std::filesystem::recursive_directory_iterator iterator(
    root, std::filesystem::directory_options::skip_permission_denied, error);
  const std::filesystem::recursive_directory_iterator end;
  if (error) return false;
  size = 0;
  while (iterator != end) {
    if (surface->explorerFolderSizeGeneration.load() != folderSizeGeneration) return false;
    const auto& entry = *iterator;
    const DWORD attributes = GetFileAttributesW(entry.path().c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
      return false;
    }
    if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      if (IsFileSystemDirectory(attributes)) iterator.disable_recursion_pending();
    } else if (!IsFileSystemDirectory(attributes)) {
      const auto bytes = entry.file_size(error);
      if (error) return false;
      const ULONGLONG value = static_cast<ULONGLONG>(bytes);
      size = value > std::numeric_limits<ULONGLONG>::max() - size
        ? std::numeric_limits<ULONGLONG>::max() : size + value;
    }
    iterator.increment(error);
    if (error) return false;
  }
  return surface->explorerFolderSizeGeneration.load() == folderSizeGeneration;
}

void HandleExplorerFolderSizesRequest(const std::wstring& message) {
  const std::wstring surfaceId = JsonStringValue(message, L"surfaceId");
  const auto surface = FindSurface(surfaceId);
  if (!surface || surface->kind != L"explorer") return;
  const unsigned long listGeneration = static_cast<unsigned long>(JsonIntValue(message, L"generation"));
  const auto paths = JsonStringArrayValue(message, L"paths");
  const unsigned long folderSizeGeneration = ++surface->explorerFolderSizeGeneration;
  if (paths.empty() || listGeneration != surface->explorerGeneration) return;
  if (CopyInProgress()) return;  // 拷贝进行中不做体积遍历（机械盘上这一步最拖后腿）

  // Folder size is deliberately a sequential background task. Parallel walks
  // make mechanical disks thrash and steal bandwidth from the foreground UI.
  std::thread([surface, surfaceId, listGeneration, folderSizeGeneration, paths]() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    for (const auto& rawPath : paths) {
      if (surface->explorerFolderSizeGeneration.load() != folderSizeGeneration) break;
      const std::filesystem::path path(rawPath);
      ULONGLONG modifiedStamp = 0;
      if (!DirectoryModifiedStamp(path, modifiedStamp)) continue;
      const std::wstring cacheKey = FolderSizeCacheKey(path);
      ULONGLONG size = 0;
      bool cached = false;
      {
        std::lock_guard<std::mutex> lock(g_folderSizeCacheMutex);
        const auto found = g_folderSizeCache.find(cacheKey);
        if (found != g_folderSizeCache.end() && found->second.modifiedStamp == modifiedStamp) {
          size = found->second.size;
          cached = true;
        }
      }
      if (!cached && !CalculateFolderSize(path, surface, folderSizeGeneration, size)) continue;
      if (surface->explorerFolderSizeGeneration.load() != folderSizeGeneration) break;
      if (!cached) {
        std::lock_guard<std::mutex> lock(g_folderSizeCacheMutex);
        g_folderSizeCache[cacheKey] = {modifiedStamp, size};
      }
      PostToCanvasAsync(L"{\"type\":\"native-explorer-folder-size\",\"surfaceId\":\"" +
        JsonEscape(surfaceId) + L"\",\"generation\":" + std::to_wstring(listGeneration) +
        L",\"path\":\"" + JsonEscape(rawPath) + L"\",\"size\":" + std::to_wstring(size) + L"}");
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

struct ShellTreeNode {
  std::wstring name;
  std::wstring path;
  std::wstring image;
  std::wstring modifiedText;
  ULONGLONG totalBytes = 0;
  ULONGLONG freeBytes = 0;
  ULONGLONG size = 0;
  bool expandable = false;
  bool folder = true;
};

ShellTreeNode MakeShellTreeNode(IShellItem* item, bool includeFilePreview = false, bool archiveLocation = false,
                                bool includeImage = true) {
  ShellTreeNode node;
  if (!item) return node;
  LPWSTR value = nullptr;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &value)) && value) {
    node.name = value;
    CoTaskMemFree(value);
  }
  value = nullptr;
  if (SUCCEEDED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &value)) && value) {
    node.path = value;
    CoTaskMemFree(value);
  }
  node.folder = IsShellContainer(item);
  if (archiveLocation && HasZipExtension(node.path)) node.folder = false;
  SFGAOF attributes = SFGAO_HASSUBFOLDER;
  if (node.folder && SUCCEEDED(item->GetAttributes(attributes, &attributes))) node.expandable = (attributes & SFGAO_HASSUBFOLDER) != 0;
  bool imageIsThumbnail = false;
  if (includeImage) {
    node.image = includeFilePreview && !node.folder
      ? ShellItemImageDataUrl(item, 64, &imageIsThumbnail, nullptr, nullptr, false, node.path)
      : ShellItemImageDataUrl(item, 32, nullptr, nullptr, nullptr, false, node.path);
  }
  ComPtr<IShellItem2> item2;
  if (SUCCEEDED(item->QueryInterface(IID_PPV_ARGS(&item2))) && item2) {
    node.modifiedText = ShellPropertyString(item2.Get(), PKEY_DateModified);
    item2->GetUInt64(PKEY_Size, &node.size);
  }
  return node;
}

void AppendKnownFolderNode(REFKNOWNFOLDERID id, std::vector<ShellTreeNode>& nodes) {
  ComPtr<IShellItem> item;
  if (SUCCEEDED(SHGetKnownFolderItem(id, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&item))) && item) {
    nodes.push_back(MakeShellTreeNode(item.Get()));
  }
}

std::vector<ShellTreeNode> EnumerateTreeChildren(const std::wstring& parentPath, bool includeFiles = false,
                                                 bool includeImages = true) {
  std::vector<ShellTreeNode> nodes;
  if (parentPath.empty()) {
    ComPtr<IShellItem> computer;
    if (SUCCEEDED(SHGetKnownFolderItem(FOLDERID_ComputerFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&computer))) && computer) {
      ComPtr<IShellFolder> folder;
      PIDLIST_ABSOLUTE parentPidl = nullptr;
      if (SUCCEEDED(computer->BindToHandler(nullptr, BHID_SFObject, IID_PPV_ARGS(&folder))) && folder &&
          SUCCEEDED(SHGetIDListFromObject(computer.Get(), &parentPidl)) && parentPidl) {
        ComPtr<IEnumIDList> enumerator;
        if (SUCCEEDED(folder->EnumObjects(g_mainWindow, SHCONTF_FOLDERS, &enumerator)) && enumerator) {
          PITEMID_CHILD child = nullptr;
          ULONG fetched = 0;
          while (enumerator->Next(1, &child, &fetched) == S_OK && child) {
            ComPtr<IShellItem> item;
            if (SUCCEEDED(SHCreateItemWithParent(parentPidl, folder.Get(), child, IID_PPV_ARGS(&item))) && item) {
              ShellTreeNode node = MakeShellTreeNode(item.Get(), false, false, includeImages);
              const bool drivePath = node.path.size() >= 3 && iswalpha(node.path[0]) && node.path[1] == L':' &&
                (node.path[2] == L'\\' || node.path[2] == L'/');
              if (drivePath && GetDriveTypeW(node.path.c_str()) != DRIVE_NO_ROOT_DIR) {
                ULARGE_INTEGER freeAvailable{}, total{}, free{};
                if (GetDiskFreeSpaceExW(node.path.c_str(), &freeAvailable, &total, &free)) {
                  node.totalBytes = total.QuadPart;
                  node.freeBytes = free.QuadPart;
                }
                nodes.push_back(std::move(node));
              }
            }
            CoTaskMemFree(child);
            child = nullptr;
          }
        }
        CoTaskMemFree(parentPidl);
      }
    }
    std::stable_sort(nodes.begin(), nodes.end(), [](const ShellTreeNode& left, const ShellTreeNode& right) {
      return StrCmpLogicalW(left.name.c_str(), right.name.c_str()) < 0;
    });
    return nodes;
  }

  ComPtr<IShellItem> parent;
  HRESULT result = parentPath == L"shell:MyComputerFolder"
    ? SHGetKnownFolderItem(FOLDERID_ComputerFolder, KF_FLAG_DEFAULT, nullptr, IID_PPV_ARGS(&parent))
    : SHCreateItemFromParsingName(parentPath.c_str(), nullptr, IID_PPV_ARGS(&parent));
  if (FAILED(result) || !parent) return nodes;
  ComPtr<IShellFolder> folder;
  PIDLIST_ABSOLUTE parentPidl = nullptr;
  if (FAILED(parent->BindToHandler(nullptr, BHID_SFObject, IID_PPV_ARGS(&folder))) || !folder ||
      FAILED(SHGetIDListFromObject(parent.Get(), &parentPidl)) || !parentPidl) return nodes;
  ComPtr<IEnumIDList> enumerator;
  const SHCONTF flags = includeFiles
    ? static_cast<SHCONTF>(SHCONTF_FOLDERS | SHCONTF_NONFOLDERS)
    : SHCONTF_FOLDERS;
  if (SUCCEEDED(folder->EnumObjects(g_mainWindow, flags, &enumerator)) && enumerator) {
    PITEMID_CHILD child = nullptr;
    ULONG fetched = 0;
    while (enumerator->Next(1, &child, &fetched) == S_OK && child) {
      ComPtr<IShellItem> item;
      if (SUCCEEDED(SHCreateItemWithParent(parentPidl, folder.Get(), child, IID_PPV_ARGS(&item))) && item) {
        nodes.push_back(MakeShellTreeNode(item.Get(), includeFiles, includeFiles, includeImages));
      }
      CoTaskMemFree(child);
      child = nullptr;
    }
  }
  CoTaskMemFree(parentPidl);
  std::stable_sort(nodes.begin(), nodes.end(), [](const ShellTreeNode& left, const ShellTreeNode& right) {
    return StrCmpLogicalW(left.name.c_str(), right.name.c_str()) < 0;
  });
  return nodes;
}

void SendExplorerTree(const std::shared_ptr<NativeSurface>& surface, const std::wstring& parentPath, bool includeFiles = false, const std::wstring& purpose = L"") {
  if (!surface) return;
  const auto nodes = EnumerateTreeChildren(parentPath, includeFiles);
  std::wostringstream json;
  json << L"{\"type\":\"native-explorer-tree\",\"surfaceId\":\"" << JsonEscape(surface->id)
    << L"\",\"parent\":\"" << JsonEscape(parentPath)
    << L"\",\"purpose\":\"" << JsonEscape(purpose) << L"\",\"nodes\":[";
  for (size_t index = 0; index < nodes.size(); ++index) {
    if (index) json << L',';
    const auto& node = nodes[index];
    json << L"{\"name\":\"" << JsonEscape(node.name)
      << L"\",\"path\":\"" << JsonEscape(node.path)
      << L"\",\"image\":\"" << JsonEscape(node.image)
      << L"\",\"modifiedText\":\"" << JsonEscape(node.modifiedText)
      << L"\",\"totalBytes\":" << node.totalBytes
      << L",\"freeBytes\":" << node.freeBytes
      << L",\"size\":" << node.size
      << L",\"folder\":" << (node.folder ? L"true" : L"false")
      << L",\"expandable\":" << (node.expandable ? L"true" : L"false") << L'}';
  }
  json << L"]}";
  PostToCanvas(json.str());
}

void HandleShellPreviewLocationRequest(const std::wstring& message) {
  const std::wstring surfaceId = JsonStringValue(message, L"surfaceId");
  const std::wstring parentPath = JsonStringValue(message, L"path");
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  if (surfaceId.empty() || parentPath.empty() || requestId.empty()) return;
  const unsigned long generation = ++g_shellPreviewLocationGeneration;
  std::thread([surfaceId, parentPath, requestId, generation]() {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const auto nodes = EnumerateTreeChildren(parentPath, true, false);
    if (g_shellPreviewLocationGeneration.load() == generation) {
      std::wostringstream json;
      json << L"{\"type\":\"native-shell-preview-location\",\"surfaceId\":\"" << JsonEscape(surfaceId)
        << L"\",\"requestId\":\"" << JsonEscape(requestId) << L"\",\"path\":\"" << JsonEscape(parentPath)
        << L"\",\"entries\":[";
      for (size_t index = 0; index < nodes.size(); ++index) {
        if (index) json << L',';
        const auto& node = nodes[index];
        json << L"{\"name\":\"" << JsonEscape(node.name) << L"\",\"path\":\"" << JsonEscape(node.path)
          << L"\",\"typeText\":\"\",\"modified\":\"\",\"size\":" << node.size
          << L",\"folder\":" << (node.folder ? L"true" : L"false")
          << L",\"hidden\":false,\"shortcut\":false}";
      }
      json << L"]}";
      PostToCanvasAsync(json.str());
    }
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

void SyncExplorerSelection(const std::shared_ptr<NativeSurface>& surface, const std::vector<std::wstring>& paths) {
  const auto view = CurrentFolderView(surface);
  if (!view) return;
  if (paths.empty()) {
    view->SelectItem(-1, SVSI_DESELECTOTHERS);
    surface->selectionCount = 0;
    return;
  }
  int count = 0;
  if (FAILED(view->ItemCount(SVGIO_ALLVIEW, &count))) return;
  bool first = true;
  int selected = 0;
  for (int index = 0; index < count; ++index) {
    PITEMID_CHILD child = nullptr;
    if (FAILED(view->Item(index, &child)) || !child) continue;
    ComPtr<IShellItem> shellItem;
    ComPtr<IShellItem> folderItem;
    LPWSTR parsingName = nullptr;
    if (SUCCEEDED(view->GetFolder(IID_PPV_ARGS(&folderItem))) && folderItem) {
      ComPtr<IShellFolder> folder;
      PIDLIST_ABSOLUTE parent = nullptr;
      if (SUCCEEDED(folderItem->BindToHandler(nullptr, BHID_SFObject, IID_PPV_ARGS(&folder))) && folder &&
          SUCCEEDED(SHGetIDListFromObject(folderItem.Get(), &parent)) && parent) {
        SHCreateItemWithParent(parent, folder.Get(), child, IID_PPV_ARGS(&shellItem));
        CoTaskMemFree(parent);
      }
    }
    bool wanted = false;
    if (shellItem && SUCCEEDED(shellItem->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &parsingName)) && parsingName) {
      wanted = std::find(paths.begin(), paths.end(), parsingName) != paths.end();
      CoTaskMemFree(parsingName);
    }
    if (wanted) {
      view->SelectItem(index, SVSI_SELECT | SVSI_ENSUREVISIBLE | (first ? SVSI_DESELECTOTHERS : 0));
      first = false;
      ++selected;
    }
    CoTaskMemFree(child);
  }
  if (first) view->SelectItem(-1, SVSI_DESELECTOTHERS);
  surface->selectionCount = selected;
}

// ---------- 卡内浏览：解压镜像的启动、进度与收尾 ----------
struct ArchiveMirrorJob {
  std::wstring surfaceId;
  std::wstring archive;
  std::wstring target;
};

void PostArchiveMirrorToast(const std::wstring& text) {
  PostToCanvasAsync(L"{\"type\":\"native-toast\",\"text\":\"" + JsonEscape(text) + L"\"}");
}

void FinishArchiveMirror(const std::wstring& payload) {
  // payload = surfaceId \n 1|0 \n target \n archive
  const size_t firstSep = payload.find(L'\n');
  const size_t secondSep = firstSep == std::wstring::npos ? std::wstring::npos : payload.find(L'\n', firstSep + 1);
  const size_t thirdSep = secondSep == std::wstring::npos ? std::wstring::npos : payload.find(L'\n', secondSep + 1);
  if (firstSep == std::wstring::npos || secondSep == std::wstring::npos || thirdSep == std::wstring::npos) return;
  const std::wstring surfaceId = payload.substr(0, firstSep);
  const bool ok = payload.substr(firstSep + 1, secondSep - firstSep - 1) == L"1";
  const std::wstring target = payload.substr(secondSep + 1, thirdSep - secondSep - 1);
  const std::wstring archive = payload.substr(thirdSep + 1);
  const auto surface = FindSurface(surfaceId);
  if (!surface || _wcsicmp(surface->pendingMirrorTarget.c_str(), target.c_str()) != 0) return;
  surface->pendingMirrorTarget.clear();
  surface->mirrorRefreshAt = 0;
  const std::wstring archiveName = std::filesystem::path(archive).filename().wstring();
  if (!ok) {
    PostToCanvas(L"{\"type\":\"native-explorer-error\",\"surfaceId\":\"" + JsonEscape(surfaceId) +
      L"\",\"message\":\"解压失败：压缩包可能加密、损坏，或 7-Zip 被安全软件拦截\"}");
    PostArchiveMirrorToast(archiveName + L"：解压失败，无法在卡片内浏览");
    // 停在空镜像目录没意义，回到压缩包所在目录。
    const std::filesystem::path parent = std::filesystem::path(archive).parent_path();
    if (!parent.empty()) {
      SyncArchiveMirrorLocation(surface, parent.wstring());
      surface->source = parent.wstring();
      BrowseExplorer(surface, parent.wstring());
      surface->explorerContentDirty = true;
    }
    return;
  }
  SyncArchiveMirrorLocation(surface, target);
  surface->mirrorRoot = target;
  surface->mirrorArchive = archive;
  if (PathStartsWithFolder(surface->source, target)) {
    // 用户还停在镜像里：重扫一次，让刚解出来的文件全部出现。
    BrowseExplorer(surface, surface->source);
    surface->explorerContentDirty = true;
  }
  PostArchiveMirrorToast(archiveName + L"：包内只读副本已就绪（改动不会写回压缩包）");
}

void RunArchiveMirrorExtraction(std::unique_ptr<ArchiveMirrorJob> job) {
  if (!job) return;
  std::error_code error;
  std::filesystem::create_directories(job->target, error);
  const std::filesystem::path sevenZip = SevenZipExecutable();
  bool ok = false;
  if (sevenZip.empty() || error) {
    WriteLifecycleLog(L"archive mirror: 7-Zip missing or mirror folder not creatable");
  } else {
    const std::filesystem::path logFile = std::filesystem::path(job->target) / L"7z.log";
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE logHandle = CreateFileW(logFile.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &security, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN, nullptr);
    if (logHandle != INVALID_HANDLE_VALUE) SetFileAttributesW(logFile.c_str(), FILE_ATTRIBUTE_HIDDEN);
    std::wstring command = L"\"" + sevenZip.wstring() + L"\" x -y -bd -sccUTF-8 -o\"" + job->target +
      L"\" -- \"" + job->archive + L"\"";
    std::vector<wchar_t> commandLine(command.begin(), command.end());
    commandLine.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdOutput = logHandle;
    startup.hStdError = logHandle;
    PROCESS_INFORMATION process{};
    WriteLifecycleLog((L"archive mirror: extract begin " + job->archive.substr(0, 120)).c_str());
    if (CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                       nullptr, job->target.c_str(), &startup, &process)) {
      const DWORD waited = WaitForSingleObject(process.hProcess, 30u * 60u * 1000u);
      if (waited == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1);
      DWORD exitCode = 1;
      GetExitCodeProcess(process.hProcess, &exitCode);
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
      ok = exitCode == 0 || exitCode == 1;  // 1 = 有警告（个别条目跳过），内容仍可用
      wchar_t line[192]{};
      swprintf_s(line, L"archive mirror: extract done exit=%lu ok=%s",
        static_cast<unsigned long>(exitCode), ok ? L"yes" : L"no");
      WriteLifecycleLog(line);
    } else {
      WriteLifecycleLog(L"archive mirror: CreateProcess failed");
    }
    if (logHandle != INVALID_HANDLE_VALUE) CloseHandle(logHandle);
  }
  if (ok) {
    const std::filesystem::path marker = ArchiveMirrorMarkerPath(job->target);
    HANDLE handle = CreateFileW(marker.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
      CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN, nullptr);
    if (handle != INVALID_HANDLE_VALUE) {
      const std::string text = WideToUtf8(job->archive);
      DWORD written = 0;
      WriteFile(handle, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
      CloseHandle(handle);
      SetFileAttributesW(marker.c_str(), FILE_ATTRIBUTE_HIDDEN);
    }
  }
  const std::wstring payload = job->surfaceId + L"\n" + (ok ? L"1" : L"0") + L"\n" + job->target + L"\n" + job->archive;
  if (g_mainWindow) {
    auto* result = new std::wstring(payload);
    if (!PostMessageW(g_mainWindow, kArchiveMirrorReadyMessage, 0, reinterpret_cast<LPARAM>(result))) delete result;
  }
}

void StartArchiveMirrorExtraction(const std::shared_ptr<NativeSurface>& surface,
                                  const std::filesystem::path& archive,
                                  const std::filesystem::path& target) {
  if (!surface || archive.empty() || target.empty()) return;
  auto job = std::make_unique<ArchiveMirrorJob>();
  job->surfaceId = surface->id;
  job->archive = archive.wstring();
  job->target = target.wstring();
  std::thread([job = std::move(job)]() mutable { RunArchiveMirrorExtraction(std::move(job)); }).detach();
}

void EnterArchiveMirror(const std::shared_ptr<NativeSurface>& surface, const std::wstring& archivePath) {
  if (!surface || archivePath.empty()) return;
  const std::filesystem::path archive(archivePath);
  const std::filesystem::path target = ArchiveMirrorContentFolder(archive);
  if (SevenZipExecutable().empty() || target.empty()) {
    PostToCanvas(L"{\"type\":\"native-explorer-error\",\"surfaceId\":\"" + JsonEscape(surface->id) +
      L"\",\"message\":\"未找到 7-Zip（C:\\Program Files\\7-Zip\\7z.exe），无法在卡片内浏览这个压缩包\"}");
    return;
  }
  const bool ready = ArchiveMirrorReady(target);
  if (!ready) {
    // 大包先问一句：解压副本会吃掉磁盘空间。
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (GetFileAttributesExW(archive.c_str(), GetFileExInfoStandard, &attributes)) {
      ULARGE_INTEGER size{};
      size.LowPart = attributes.nFileSizeLow;
      size.HighPart = attributes.nFileSizeHigh;
      if (size.QuadPart >= kArchiveMirrorConfirmBytes) {
        const std::wstring prompt = L"「" + archive.filename().wstring() + L"」约 " +
          FormatArchiveMirrorSize(size.QuadPart) +
          L"，需要在临时目录解压一份只读副本才能在卡片内浏览。\n\n继续吗？（副本放在数据目录的「包内浏览」，7 天后自动清理，不会改动原压缩包）";
        g_nativeDialogOpen = true;
        const int answer = MessageBoxW(g_mainWindow, prompt.c_str(), L"掌中界 · 包内浏览",
                                      MB_OKCANCEL | MB_ICONINFORMATION);
        g_nativeDialogOpen = false;
        if (answer != IDOK) return;
      }
    }
  }
  std::error_code error;
  std::filesystem::create_directories(target, error);
  if (error) {
    PostToCanvas(L"{\"type\":\"native-explorer-error\",\"surfaceId\":\"" + JsonEscape(surface->id) +
      L"\",\"message\":\"无法创建解压副本目录，请检查磁盘空间\"}");
    return;
  }
  surface->mirrorArchive = archivePath;
  SyncArchiveMirrorLocation(surface, target.wstring());
  surface->source = target.wstring();
  surface->explorerContentDirty = true;
  BrowseExplorer(surface, target.wstring());
  const std::wstring archiveName = archive.filename().wstring();
  if (ready) {
    PostArchiveMirrorToast(archiveName + L"：包内只读副本（改动不会写回压缩包）");
    return;
  }
  surface->pendingMirrorTarget = target.wstring();
  surface->mirrorRefreshAt = GetTickCount64() + 1200;
  PostArchiveMirrorToast(archiveName + L"：正在解压到只读副本…");
  StartArchiveMirrorExtraction(surface, archive, target);
}

void OpenExplorerEntry(const std::shared_ptr<NativeSurface>& surface, const std::wstring& path) {
  if (!surface || path.empty()) return;
  ComPtr<IShellItem> item;
  if (FAILED(SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) return;
  // Shell 不认识的压缩包（rar / 7z / tar …）：交给 7-Zip 解压成只读镜像后在卡内浏览。
  if (!IsArchiveShellLocation(surface) && IsSevenZipArchive(std::filesystem::path(path))) {
    EnterArchiveMirror(surface, path);
    return;
  }
  if (IsArchiveShellLocation(surface) && HasZipExtension(path)) {
    PostToCanvas(L"{\"type\":\"native-explorer-operation-blocked\",\"surfaceId\":\"" +
      JsonEscape(surface->id) +
      L"\",\"message\":\"压缩包内的压缩包需要先解压才能打开\"}");
    return;
  }
  // Opening an entry is a Shell navigation decision: ZIP containers stay in
  // this file card instead of being launched in a separate application.
  if (IsShellContainer(item.Get())) {
    surface->source = path;
    surface->explorerContentDirty = true;
    BrowseExplorer(surface, path);
    return;
  }
  PIDLIST_ABSOLUTE pidl = nullptr;
  if (FAILED(SHGetIDListFromObject(item.Get(), &pidl)) || !pidl) return;
  SHELLEXECUTEINFOW info{sizeof(info)};
  info.fMask = SEE_MASK_IDLIST | SEE_MASK_FLAG_LOG_USAGE;
  info.hwnd = g_mainWindow;
  info.nShow = SW_SHOWNORMAL;
  info.lpIDList = pidl;
  ShellExecuteExW(&info);
  CoTaskMemFree(pidl);
}

LRESULT CALLBACK EverythingReplyProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_NCCREATE) {
    auto create = reinterpret_cast<CREATESTRUCTW*>(lParam);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  } else if (message == WM_COPYDATA) {
    auto state = reinterpret_cast<EverythingReplyState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    auto copy = reinterpret_cast<COPYDATASTRUCT*>(lParam);
    if (state && copy && copy->dwData == kEverythingReplyMessage && copy->lpData && copy->cbData) {
      const auto begin = static_cast<const unsigned char*>(copy->lpData);
      state->bytes.assign(begin, begin + copy->cbData);
      state->received = true;
      return TRUE;
    }
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

bool EnsureEverythingReplyClass() {
  static std::once_flag once;
  static bool available = false;
  std::call_once(once, [] {
    WNDCLASSW definition{};
    definition.lpfnWndProc = EverythingReplyProc;
    definition.hInstance = GetModuleHandleW(nullptr);
    definition.lpszClassName = kEverythingReplyClass;
    available = RegisterClassW(&definition) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
  });
  return available;
}

BOOL CALLBACK FindEverythingWindowCallback(HWND window, LPARAM context) {
  wchar_t className[128]{};
  if (!GetClassNameW(window, className, static_cast<int>(std::size(className)))) return TRUE;
  constexpr wchar_t prefix[] = L"EVERYTHING_TASKBAR_NOTIFICATION_(";
  if (wcsncmp(className, prefix, std::size(prefix) - 1) != 0) return TRUE;
  *reinterpret_cast<HWND*>(context) = window;
  return FALSE;
}

HWND FindEverythingWindow() {
  if (const HWND classic = FindWindowW(kEverythingWindowClass, nullptr)) return classic;
  // Named instances (including the current Everything 1.5 alpha channel) append
  // their instance name to the public IPC class, for example "_(1.5a)".
  HWND namedInstance = nullptr;
  EnumWindows(FindEverythingWindowCallback, reinterpret_cast<LPARAM>(&namedInstance));
  return namedInstance;
}

bool EverythingLooksInstalled() {
  constexpr const wchar_t* keys[] = {
    L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe",
    L"SOFTWARE\\voidtools\\Everything",
  };
  for (HKEY root : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
    for (const auto key : keys) {
      DWORD bytes = 0;
      if (RegGetValueW(root, key, nullptr, RRF_RT_REG_SZ, nullptr, nullptr, &bytes) == ERROR_SUCCESS) return true;
    }
  }
  for (const wchar_t* variable : {L"ProgramFiles", L"ProgramW6432", L"LOCALAPPDATA"}) {
    wchar_t base[MAX_PATH]{};
    if (GetEnvironmentVariableW(variable, base, MAX_PATH) &&
        GetFileAttributesW((std::filesystem::path(base) / L"Everything" / L"Everything.exe").c_str()) != INVALID_FILE_ATTRIBUTES) return true;
  }
  return false;
}

std::wstring Lowercase(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) { return static_cast<wchar_t>(towlower(character)); });
  return value;
}

ShellEntry SearchEntryFromPath(const std::filesystem::path& path, bool folderHint = false) {
  ShellEntry entry;
  entry.parsingName = path.wstring();
  entry.name = path.filename().wstring();
  if (entry.name.empty()) entry.name = path.root_name().wstring();
  entry.parentPath = path.parent_path().wstring();
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes)) {
    // Search results describe physical paths, not Shell navigation capability.
    entry.folder = IsFileSystemDirectory(attributes.dwFileAttributes);
    entry.hidden = (attributes.dwFileAttributes & FILE_ATTRIBUTE_HIDDEN) != 0;
    entry.shortcut = !entry.folder && path.extension() == L".lnk";
    entry.size = entry.folder ? 0 : (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32) | attributes.nFileSizeLow;
    entry.modifiedText = FormatShellFileTime(attributes.ftLastWriteTime);
    entry.modifiedStamp = FileTimeStampValue(attributes.ftLastWriteTime);
  } else entry.folder = folderHint;
  return entry;
}

void PostFileSearchStatus(const std::wstring& surfaceId, const wchar_t* status, const wchar_t* backend = L"fallback") {
  PostToCanvasAsync(L"{\"type\":\"native-file-search-status\",\"surfaceId\":\"" + JsonEscape(surfaceId) +
    L"\",\"status\":\"" + status + L"\",\"backend\":\"" + backend + L"\"}");
}

void PostFileSearchChunk(const std::wstring& surfaceId, unsigned long generation, const std::vector<ShellEntry>& entries) {
  if (entries.empty()) return;
  std::wostringstream json;
  json << L"{\"type\":\"native-file-search-chunk\",\"surfaceId\":\"" << JsonEscape(surfaceId)
    << L"\",\"generation\":" << generation << L",\"entries\":[";
  for (size_t index = 0; index < entries.size(); ++index) {
    if (index) json << L',';
    const auto& entry = entries[index];
    json << L"{\"name\":\"" << JsonEscape(entry.name)
      << L"\",\"path\":\"" << JsonEscape(entry.parsingName)
      << L"\",\"parentPath\":\"" << JsonEscape(entry.parentPath)
      << L"\",\"typeText\":\"\",\"modified\":\"" << JsonEscape(entry.modifiedText)
      << L"\",\"modifiedStamp\":" << entry.modifiedStamp
      << L",\"size\":" << entry.size
      << L",\"folder\":" << (entry.folder ? L"true" : L"false")
      << L",\"hidden\":" << (entry.hidden ? L"true" : L"false")
      << L",\"shortcut\":" << (entry.shortcut ? L"true" : L"false") << L'}';
  }
  json << L"]}";
  PostToCanvasAsync(json.str());
}

const wchar_t* WideStringAt(const std::vector<unsigned char>& bytes, DWORD offset) {
  if (offset >= bytes.size() || offset + sizeof(wchar_t) > bytes.size()) return nullptr;
  const auto value = reinterpret_cast<const wchar_t*>(bytes.data() + offset);
  const size_t remaining = (bytes.size() - offset) / sizeof(wchar_t);
  return std::find(value, value + remaining, L'\0') == value + remaining ? nullptr : value;
}

bool QueryEverything(const std::shared_ptr<NativeSurface>& surface, const std::wstring& query,
                     const std::wstring& root, unsigned long generation) {
  HWND everything = FindEverythingWindow();
  if (!everything || !EnsureEverythingReplyClass()) return false;
  EverythingReplyState reply;
  HWND receiver = CreateWindowExW(0, kEverythingReplyClass, L"", 0, 0, 0, 0, 0,
    HWND_MESSAGE, nullptr, GetModuleHandleW(nullptr), &reply);
  if (!receiver) return false;
  std::wstring expression = query;
  if (!root.empty() && root.rfind(L"shell:", 0) != 0) expression = L"path:\"" + root + L"\" " + query;
  const size_t requestBytes = offsetof(EverythingIpcQueryW, searchString) + (expression.size() + 1) * sizeof(wchar_t);
  std::vector<unsigned char> storage(requestBytes);
  auto request = reinterpret_cast<EverythingIpcQueryW*>(storage.data());
  request->replyHwnd = static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(receiver));
  request->replyCopyDataMessage = static_cast<DWORD>(kEverythingReplyMessage);
  request->searchFlags = 0;
  request->offset = 0;
  request->maxResults = 0xFFFFFFFF;
  memcpy(request->searchString, expression.c_str(), (expression.size() + 1) * sizeof(wchar_t));
  COPYDATASTRUCT copy{ kEverythingCopyDataQueryW, static_cast<DWORD>(storage.size()), storage.data() };
  DWORD_PTR delivered = 0;
  const LRESULT sent = SendMessageTimeoutW(everything, WM_COPYDATA, reinterpret_cast<WPARAM>(receiver),
    reinterpret_cast<LPARAM>(&copy), SMTO_ABORTIFHUNG, 1500, &delivered);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1500);
  MSG message{};
  while (sent && !reply.received && surface->explorerSearchGeneration.load() == generation &&
         std::chrono::steady_clock::now() < deadline) {
    while (PeekMessageW(&message, receiver, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
    if (!reply.received) MsgWaitForMultipleObjects(0, nullptr, FALSE, 20, QS_ALLINPUT);
  }
  DestroyWindow(receiver);
  if (!reply.received || reply.bytes.size() < offsetof(EverythingIpcListW, items)) return false;
  const auto list = reinterpret_cast<const EverythingIpcListW*>(reply.bytes.data());
  const size_t itemsEnd = offsetof(EverythingIpcListW, items) + static_cast<size_t>(list->numberOfItems) * sizeof(EverythingIpcItemW);
  if (itemsEnd > reply.bytes.size()) return false;
  std::vector<ShellEntry> batch;
  batch.reserve(200);
  std::wstring normalizedRoot;
  if (!root.empty() && root.rfind(L"shell:", 0) != 0) {
    normalizedRoot = std::filesystem::path(root).lexically_normal().make_preferred().wstring();
    while (normalizedRoot.size() > 3 && (normalizedRoot.back() == L'\\' || normalizedRoot.back() == L'/')) {
      normalizedRoot.pop_back();
    }
  }
  for (DWORD index = 0; index < list->numberOfItems; ++index) {
    if (surface->explorerSearchGeneration.load() != generation) return true;
    const auto filename = WideStringAt(reply.bytes, list->items[index].filenameOffset);
    const auto path = WideStringAt(reply.bytes, list->items[index].pathOffset);
    if (!filename || !path) continue;
    std::filesystem::path full(path);
    full /= filename;
    if (!normalizedRoot.empty()) {
      const std::wstring normalizedFull = full.lexically_normal().make_preferred().wstring();
      if (normalizedFull.size() < normalizedRoot.size() ||
          _wcsnicmp(normalizedFull.c_str(), normalizedRoot.c_str(), normalizedRoot.size()) != 0 ||
          (normalizedFull.size() > normalizedRoot.size() &&
           normalizedFull[normalizedRoot.size()] != L'\\' && normalizedFull[normalizedRoot.size()] != L'/')) {
        continue;
      }
    }
    batch.push_back(SearchEntryFromPath(full, (list->items[index].flags & kEverythingItemFolder) != 0));
    if (batch.size() == 200) { PostFileSearchChunk(surface->id, generation, batch); batch.clear(); }
  }
  PostFileSearchChunk(surface->id, generation, batch);
  return true;
}

void SearchFilesystem(const std::shared_ptr<NativeSurface>& surface, const std::wstring& query,
                      const std::wstring& root, unsigned long generation) {
  std::vector<std::filesystem::path> roots;
  if (!root.empty() && root.rfind(L"shell:", 0) != 0) roots.emplace_back(root);
  else {
    wchar_t drives[512]{};
    const DWORD length = GetLogicalDriveStringsW(static_cast<DWORD>(std::size(drives)), drives);
    for (const wchar_t* drive = drives; length && *drive; drive += wcslen(drive) + 1) {
      const UINT type = GetDriveTypeW(drive);
      if (type == DRIVE_FIXED || type == DRIVE_REMOVABLE) roots.emplace_back(drive);
    }
  }
  const std::wstring needle = Lowercase(query);
  std::vector<ShellEntry> batch;
  batch.reserve(200);
  auto lastFlush = std::chrono::steady_clock::now();
  const auto flush = [&] {
    if (!batch.empty()) { PostFileSearchChunk(surface->id, generation, batch); batch.clear(); }
    lastFlush = std::chrono::steady_clock::now();
  };
  for (const auto& searchRoot : roots) {
    std::error_code error;
    std::filesystem::recursive_directory_iterator iterator(searchRoot,
      std::filesystem::directory_options::skip_permission_denied, error), end;
    while (iterator != end && surface->explorerSearchGeneration.load() == generation) {
      const auto path = iterator->path();
      const DWORD attributes = GetFileAttributesW(path.c_str());
      if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) iterator.disable_recursion_pending();
      if (Lowercase(path.filename().wstring()).find(needle) != std::wstring::npos) batch.push_back(SearchEntryFromPath(path));
      if (batch.size() >= 200 || std::chrono::steady_clock::now() - lastFlush >= std::chrono::milliseconds(100)) flush();
      iterator.increment(error);
      if (error) error.clear();
    }
    if (surface->explorerSearchGeneration.load() != generation) return;
  }
  flush();
}

void HandleFileSearch(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface) return;
  const std::wstring query = JsonStringValue(message, L"query");
  const std::wstring root = JsonStringValue(message, L"root");
  const unsigned long generation = ++surface->explorerSearchGeneration;
  PostToCanvas(L"{\"type\":\"native-file-search-start\",\"surfaceId\":\"" + JsonEscape(surface->id) +
    L"\",\"generation\":" + std::to_wstring(generation) + L"}");
  std::thread([surface, query, root, generation] {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FindEverythingWindow()) {
      PostFileSearchStatus(surface->id, L"running", L"everything");
      if (QueryEverything(surface, query, root, generation)) {
        if (surface->explorerSearchGeneration.load() == generation) PostToCanvasAsync(
          L"{\"type\":\"native-file-search-end\",\"surfaceId\":\"" + JsonEscape(surface->id) +
          L"\",\"generation\":" + std::to_wstring(generation) + L",\"backend\":\"everything\"}");
        if (SUCCEEDED(initialized)) CoUninitialize();
        return;
      }
      PostFileSearchStatus(surface->id, L"unavailable");
    } else PostFileSearchStatus(surface->id, EverythingLooksInstalled() ? L"installed-not-running" : L"not-installed");
    SearchFilesystem(surface, query, root, generation);
    if (surface->explorerSearchGeneration.load() == generation) PostToCanvasAsync(
      L"{\"type\":\"native-file-search-end\",\"surfaceId\":\"" + JsonEscape(surface->id) +
      L"\",\"generation\":" + std::to_wstring(generation) + L",\"backend\":\"fallback\"}");
    if (SUCCEEDED(initialized)) CoUninitialize();
  }).detach();
}

void SetViewMode(const std::shared_ptr<NativeSurface>& surface, FOLDERVIEWMODE mode) {
  const auto view = CurrentFolderView(surface);
  if (view) view->SetCurrentViewMode(mode);
}

void CycleViewMode(const std::shared_ptr<NativeSurface>& surface) {
  const auto view = CurrentFolderView(surface);
  if (!view) return;
  static const FOLDERVIEWMODE modes[] = {FVM_DETAILS, FVM_LIST, FVM_TILE, FVM_ICON};
  surface->viewMode = (surface->viewMode + 1) % 4;
  view->SetCurrentViewMode(modes[surface->viewMode]);
}

void CycleSort(const std::shared_ptr<NativeSurface>& surface) {
  const auto view = CurrentFolderView(surface);
  if (!view) return;
  surface->sortDescending = !surface->sortDescending;
  SORTCOLUMN column{PKEY_ItemNameDisplay, surface->sortDescending ? SORT_DESCENDING : SORT_ASCENDING};
  view->SetSortColumns(&column, 1);
}

// 面包屑要的是显示名，不是我们拿来解析的 shell: 原始路径（§30.4、§31.3）。
std::wstring CurrentLocationTrail(const std::shared_ptr<NativeSurface>& surface) {
  const auto view = CurrentFolderView(surface);
  if (!view) return {};
  ComPtr<IShellItem> item;
  if (FAILED(view->GetFolder(IID_PPV_ARGS(&item))) || !item) return {};
  std::vector<std::wstring> parts;
  for (ComPtr<IShellItem> cursor = item; cursor && parts.size() < 24;) {
    LPWSTR name = nullptr;
    if (SUCCEEDED(cursor->GetDisplayName(SIGDN_NORMALDISPLAY, &name)) && name) {
      parts.push_back(name);
      CoTaskMemFree(name);
    }
    ComPtr<IShellItem> parent;
    if (FAILED(cursor->GetParent(&parent)) || !parent) break;
    cursor = parent;
  }
  // 走到顶会拿到 Shell 命名空间的根「桌面」，面包屑不需要它，从「此电脑」起。
  if (parts.size() > 1) parts.pop_back();
  std::wstring trail;
  for (auto it = parts.rbegin(); it != parts.rend(); ++it) {
    if (!trail.empty()) trail += L"	";  // 制表符分段，JsonEscape 转成 \t，JSON 安全
    trail += *it;
  }
  return trail;
}

void ReportExplorerState(const std::shared_ptr<NativeSurface>& surface, bool force) {
  if (!surface || surface->kind != L"explorer" || !surface->explorer) return;
  const int count = CurrentSelectionCount(surface);
  const std::wstring trail = CurrentLocationTrail(surface);
  const std::wstring parsingName = CurrentFolderPath(surface);
  const size_t leafSeparator = trail.rfind(L'\t');
  const std::wstring displayName = leafSeparator == std::wstring::npos ? trail : trail.substr(leafSeparator + 1);
  if (force || count != surface->selectionCount || trail != surface->location) {
    surface->selectionCount = count;
    surface->location = trail;
    PostToCanvas(L"{\"type\":\"native-explorer-state\",\"surfaceId\":\"" + JsonEscape(surface->id) +
      L"\",\"selection\":" + std::to_wstring(count) +
      L",\"trail\":\"" + JsonEscape(trail) +
      L"\",\"displayName\":\"" + JsonEscape(displayName) + L"\"}");
  }
  if (!parsingName.empty() &&
      (surface->explorerContentDirty || parsingName != surface->enumeratedLocation)) {
    // 系统正在拷贝时，把「重枚举目录」节流到 2 秒一次：枚举本身就要读盘，会和拷贝抢 IO，
    // 机械盘上这一步最拖后腿（拷贝结束的 TickCopyWatches 会置脏，那时立刻补一次全刷）。
    // 用户 2026-09-14：拷贝提速可以，但别给硬盘添负担 —— 这里只减不增。
    const ULONGLONG now = GetTickCount64();
    if (CopyInProgress() && now - surface->explorerRefreshAt < 2000) return;
    surface->explorerRefreshAt = now;
    SendExplorerItems(surface, parsingName);
  }
}

// 剪贴板读写（供“剪贴暂存”卡片使用）。剪贴板可能被其他进程短暂占用，重试几次。
std::wstring ReadClipboardText() {
  for (int attempt = 0; attempt < 5; ++attempt) {
    if (!OpenClipboard(nullptr)) { Sleep(15); continue; }
    std::wstring text;
    if (HANDLE handle = GetClipboardData(CF_UNICODETEXT)) {
      if (const wchar_t* data = static_cast<const wchar_t*>(GlobalLock(handle))) {
        text.assign(data);
        GlobalUnlock(handle);
      }
    }
    CloseClipboard();
    return text;
  }
  return {};
}

bool WriteClipboardText(const std::wstring& text) {
  for (int attempt = 0; attempt < 5; ++attempt) {
    if (!OpenClipboard(nullptr)) { Sleep(15); continue; }
    g_clipboardSelfWriteAt = GetTickCount64();  // 自己写回的剪贴板不进入剪贴历史
    bool written = false;
    if (EmptyClipboard()) {
      const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
      if (HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes)) {
        if (void* target = GlobalLock(memory)) {
          memcpy(target, text.c_str(), bytes);
          GlobalUnlock(memory);
          written = SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
        }
        if (!written) GlobalFree(memory);
      }
    }
    CloseClipboard();
    return written;
  }
  return false;
}

// ---- 剪贴暂存：位图落盘为 PNG，只保存路径引用（不把图片嵌进工程，避免保存包巨大）----

std::wstring ClipboardStagingFolder() {
  std::filesystem::path folder(g_dataFolder);
  folder /= L"剪贴暂存";
  std::error_code error;
  std::filesystem::create_directories(folder, error);
  return folder.wstring();
}

// 剪贴板位图（截图/聊天软件复制的图片）→ 保存为磁盘 PNG，返回文件路径。
std::wstring SaveClipboardImageToFile(UINT& outWidth, UINT& outHeight, unsigned long long* outDigest = nullptr) {
  bool opened = false;
  for (int attempt = 0; attempt < 12 && !opened; ++attempt) {
    opened = OpenClipboard(g_mainWindow) != FALSE;
    if (!opened) Sleep(25);
  }
  if (!opened) return {};
  std::vector<unsigned char> blob;
  if (HANDLE handle = GetClipboardData(CF_DIB)) {
    const SIZE_T size = GlobalSize(handle);
    if (const void* data = GlobalLock(handle)) {
      if (size > sizeof(BITMAPINFOHEADER)) blob.assign(static_cast<const unsigned char*>(data), static_cast<const unsigned char*>(data) + size);
      GlobalUnlock(handle);
    }
  }
  CloseClipboard();
  if (blob.size() <= sizeof(BITMAPINFOHEADER)) return {};
  const auto* header = reinterpret_cast<const BITMAPINFOHEADER*>(blob.data());
  if (header->biSize < sizeof(BITMAPINFOHEADER) || header->biWidth <= 0 || header->biHeight == 0) return {};
  const int width = header->biWidth;
  const int height = std::abs(header->biHeight);
  const int bitCount = header->biBitCount;
  if ((bitCount != 24 && bitCount != 32) || (header->biCompression != BI_RGB && header->biCompression != BI_BITFIELDS)) return {};
  size_t pixelOffset = header->biSize;
  if (header->biCompression == BI_BITFIELDS && header->biSize == sizeof(BITMAPINFOHEADER)) pixelOffset += 12;
  const size_t stride = ((static_cast<size_t>(width) * bitCount / 8) + 3) & ~size_t(3);
  if (pixelOffset + stride * height > blob.size()) return {};
  const bool bottomUp = header->biHeight > 0;
  const size_t pixelBytes = static_cast<size_t>(width) * height * 4;
  std::vector<unsigned char> pixels(pixelBytes, 0);
  bool anyAlpha = false;
  for (int y = 0; y < height; ++y) {
    const unsigned char* sourceRow = blob.data() + pixelOffset + stride * static_cast<size_t>(bottomUp ? (height - 1 - y) : y);
    unsigned char* targetRow = pixels.data() + static_cast<size_t>(y) * width * 4;
    for (int x = 0; x < width; ++x) {
      targetRow[x * 4] = sourceRow[x * (bitCount / 8)];
      targetRow[x * 4 + 1] = sourceRow[x * (bitCount / 8) + 1];
      targetRow[x * 4 + 2] = sourceRow[x * (bitCount / 8) + 2];
      targetRow[x * 4 + 3] = bitCount == 32 ? sourceRow[x * 4 + 3] : 255;
      if (targetRow[x * 4 + 3] != 0) anyAlpha = true;
    }
  }
  if (!anyAlpha) {
    for (size_t index = 3; index < pixelBytes; index += 4) pixels[index] = 255;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT created = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created)) created = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created) || !factory) return {};
  ComPtr<IWICBitmap> source;
  if (FAILED(factory->CreateBitmapFromMemory(static_cast<UINT>(width), static_cast<UINT>(height),
      GUID_WICPixelFormat32bppBGRA, static_cast<UINT>(width * 4),
      static_cast<UINT>(pixelBytes), pixels.data(), &source)) || !source) return {};
  const std::vector<unsigned char> png = EncodePng(factory.Get(), source.Get(), static_cast<UINT>(width), static_cast<UINT>(height));
  if (png.empty()) return {};
  unsigned long long digest = 1469598103934665603ULL;  // FNV-1a
  for (const unsigned char byte : png) { digest ^= byte; digest *= 1099511628211ULL; }
  if (outDigest) *outDigest = digest;
  SYSTEMTIME now{};
  GetLocalTime(&now);
  wchar_t name[96]{};
  swprintf_s(name, L"shot-%04d%02d%02d-%02d%02d%02d-%03u.png", now.wYear, now.wMonth, now.wDay,
    now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
  std::filesystem::path target = std::filesystem::path(ClipboardStagingFolder()) / name;
  std::ofstream stream(target, std::ios::binary | std::ios::trunc);
  if (!stream) return {};
  stream.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
  if (!stream) return {};
  stream.close();
  outWidth = static_cast<UINT>(width);
  outHeight = static_cast<UINT>(height);
  return target.wstring();
}

// 把磁盘上的图片文件（PNG）写回剪贴板（CF_DIB），供贴回 Photoshop / 微信等。
bool CopyImageFileToClipboard(const std::wstring& path) {
  if (path.empty()) return false;
  ComPtr<IWICImagingFactory> factory;
  HRESULT created = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created)) created = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created) || !factory) return false;
  ComPtr<IWICBitmapDecoder> decoder;
  if (FAILED(factory->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder)) || !decoder) return false;
  ComPtr<IWICBitmapFrameDecode> frame;
  if (FAILED(decoder->GetFrame(0, &frame)) || !frame) return false;
  ComPtr<IWICFormatConverter> converter;
  if (FAILED(factory->CreateFormatConverter(&converter)) || !converter ||
      FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
  UINT width = 0;
  UINT height = 0;
  if (FAILED(converter->GetSize(&width, &height)) || !width || !height) return false;
  const size_t pixelBytes = static_cast<size_t>(width) * height * 4;
  std::vector<unsigned char> pixels(pixelBytes);
  if (FAILED(converter->CopyPixels(nullptr, width * 4, static_cast<UINT>(pixelBytes), pixels.data()))) return false;
  const size_t dibBytes = sizeof(BITMAPINFOHEADER) + pixelBytes;
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, dibBytes);
  if (!memory) return false;
  auto* dib = static_cast<unsigned char*>(GlobalLock(memory));
  if (!dib) { GlobalFree(memory); return false; }
  auto* header = reinterpret_cast<BITMAPINFOHEADER*>(dib);
  memset(header, 0, sizeof(BITMAPINFOHEADER));
  header->biSize = sizeof(BITMAPINFOHEADER);
  header->biWidth = static_cast<LONG>(width);
  header->biHeight = static_cast<LONG>(height);  // bottom-up
  header->biPlanes = 1;
  header->biBitCount = 32;
  header->biCompression = BI_RGB;
  header->biSizeImage = static_cast<DWORD>(pixelBytes);
  for (UINT y = 0; y < height; ++y) {
    memcpy(dib + sizeof(BITMAPINFOHEADER) + static_cast<size_t>(y) * width * 4,
      pixels.data() + static_cast<size_t>(height - 1 - y) * width * 4, static_cast<size_t>(width) * 4);
  }
  GlobalUnlock(memory);
  for (int attempt = 0; attempt < 5; ++attempt) {
    if (!OpenClipboard(g_mainWindow)) { Sleep(15); continue; }
    g_clipboardSelfWriteAt = GetTickCount64();  // 自己写回的剪贴板不进入剪贴历史
    bool written = false;
    if (EmptyClipboard()) written = SetClipboardData(CF_DIB, memory) != nullptr;
    CloseClipboard();
    if (!written) GlobalFree(memory);
    return written;
  }
  GlobalFree(memory);
  return false;
}

// ---- 自动剪贴历史：存储与读写（UTF-8 行式格式，字段以 TAB 分隔，杜绝 JSON 嵌套解析）----

std::filesystem::path ClipboardHistoryPath() {
  return std::filesystem::path(g_dataFolder) / L"剪贴历史.txt";
}

std::wstring EscapeHistoryField(const std::wstring& value) {
  std::wstring out;
  out.reserve(value.size());
  for (const wchar_t ch : value) {
    if (ch == L'\\') out += L"\\\\";
    else if (ch == L'\t') out += L"\\t";
    else if (ch == L'\n') out += L"\\n";
    else if (ch == static_cast<wchar_t>(13)) out += L"\r";
    else out.push_back(ch);
  }
  return out;
}

std::wstring UnescapeHistoryField(const std::wstring& value) {
  std::wstring out;
  out.reserve(value.size());
  for (size_t index = 0; index < value.size(); ++index) {
    if (value[index] != L'\\' || index + 1 >= value.size()) { out.push_back(value[index]); continue; }
    const wchar_t next = value[++index];
    if (next == L't') out.push_back(L'\t');
    else if (next == L'n') out.push_back(L'\n');
    else if (next == L'r') out.push_back(static_cast<wchar_t>(13));
    else out.push_back(next);
  }
  return out;
}

void PersistClipboardHistory() {
  std::wostringstream out;
  out << (g_clipboardHistoryAuto ? L"AUTO 1" : L"AUTO 0") << (g_captureToCanvas ? L"\nCANVAS 1" : L"\nCANVAS 0") << L"\nSERIAL " << g_clipboardHistorySerial << L"\n";
  for (const auto& item : g_clipboardHistory) {
    std::wstring pathsJoined;
    for (size_t index = 0; index < item.paths.size(); ++index) {
      if (index) pathsJoined += L'|';  // '|' 是 Windows 文件名非法字符，可安全当分隔符
      pathsJoined += item.paths[index];
    }
    out << EscapeHistoryField(item.id) << L'\t' << item.kind << L'\t' << item.at << L'\t'
      << item.width << L'\t' << item.height << L'\t' << EscapeHistoryField(item.path) << L'\t'
      << EscapeHistoryField(item.text) << L'\t' << EscapeHistoryField(pathsJoined) << L'\t' << item.digest << L'\n';
  }
  WriteUtf8FileAtomic(ClipboardHistoryPath(), out.str());
}

unsigned long long ClipboardHistoryWallClock() {
  FILETIME now{};
  GetSystemTimePreciseAsFileTime(&now);
  return ((static_cast<unsigned long long>(now.dwHighDateTime) << 32) | now.dwLowDateTime) / 10000ULL;
}

void LoadClipboardHistory() {
  std::wstring content;
  if (!ReadUtf8File(ClipboardHistoryPath(), content)) return;
  std::wistringstream stream(content);
  std::wstring line;
  while (std::getline(stream, line)) {
    if (!line.empty() && (line.back() == static_cast<wchar_t>(13) || line.back() == static_cast<wchar_t>(10))) line.pop_back();
    if (line.empty()) continue;
    if (line.rfind(L"AUTO ", 0) == 0) { g_clipboardHistoryAuto = line.substr(5) != L"0"; continue; }
    if (line.rfind(L"CANVAS ", 0) == 0) { g_captureToCanvas = line.substr(7) != L"0"; continue; }
    if (line.rfind(L"SERIAL ", 0) == 0) {
      try { g_clipboardHistorySerial = static_cast<unsigned int>(std::stoul(line.substr(7))); } catch (...) {}
      continue;
    }
    std::vector<std::wstring> fields;
    size_t start = 0;
    while (start <= line.size()) {
      const size_t at = line.find(L'\t', start);
      if (at == std::wstring::npos) { fields.push_back(line.substr(start)); break; }
      fields.push_back(line.substr(start, at - start));
      start = at + 1;
    }
    if (fields.size() < 8) continue;
    ClipboardHistoryItem item;
    item.id = UnescapeHistoryField(fields[0]);
    item.kind = fields[1];
    try { item.at = std::stoull(fields[2]); } catch (...) { item.at = 0; }
    try { item.width = std::stoull(fields[3]); } catch (...) {}
    try { item.height = std::stoull(fields[4]); } catch (...) {}
    item.path = UnescapeHistoryField(fields[5]);
    item.text = UnescapeHistoryField(fields[6]);
    if (fields.size() > 8) { try { item.digest = std::stoull(fields[8]); } catch (...) {} }
    const std::wstring joined = UnescapeHistoryField(fields[7]);
    size_t pathStart = 0;
    while (pathStart < joined.size()) {
      const size_t sep = joined.find(L'|', pathStart);
      const std::wstring part = sep == std::wstring::npos ? joined.substr(pathStart) : joined.substr(pathStart, sep - pathStart);
      if (!part.empty()) item.paths.push_back(part);
      if (sep == std::wstring::npos) break;
      pathStart = sep + 1;
    }
    if (!item.id.empty()) g_clipboardHistory.push_back(std::move(item));
  }
}

std::wstring ClipboardHistoryItemJson(const ClipboardHistoryItem& item) {
  std::wostringstream json;
  json << L"{\"id\":\"" << JsonEscape(item.id) << L"\",\"kind\":\"" << item.kind
    << L"\",\"text\":\"" << JsonEscape(item.text) << L"\",\"at\":" << item.at;
  if (!item.path.empty()) json << L",\"path\":\"" << JsonEscape(item.path) << L"\"";
  if (!item.paths.empty()) {
    json << L",\"paths\":[";
    for (size_t index = 0; index < item.paths.size(); ++index) {
      if (index) json << L',';
      json << L'\"' << JsonEscape(item.paths[index]) << L'\"';
    }
    json << L"]";
  }
  if (item.width) json << L",\"width\":" << item.width;
  if (item.height) json << L",\"height\":" << item.height;
  json << L"}";
  return json.str();
}

void PostClipboardHistory(const std::wstring& requestId) {
  std::wostringstream json;
  json << L"{\"type\":\"native-clipboard-history\",\"auto\":" << (g_clipboardHistoryAuto ? L"true" : L"false")
    << L",\"canvasMode\":" << (g_captureToCanvas ? L"true" : L"false");
  if (!requestId.empty()) json << L",\"requestId\":\"" << JsonEscape(requestId) << L"\"";
  json << L",\"items\":[";
  for (size_t index = 0; index < g_clipboardHistory.size(); ++index) {
    if (index) json << L',';
    json << ClipboardHistoryItemJson(g_clipboardHistory[index]);
  }
  json << L"]}";
  PostToCanvas(json.str());
}

void PostClipboardHistoryItem(const ClipboardHistoryItem& item) {
  PostToCanvas(L"{\"type\":\"native-clipboard-history-item\",\"item\":" + ClipboardHistoryItemJson(item) + L"}");
}

std::wstring JsonSubObject(const std::wstring& message, const wchar_t* key) {
  const std::wstring needle = L"\"" + std::wstring(key) + L"\":{";
  const size_t at = message.find(needle);
  if (at == std::wstring::npos) return {};
  const size_t start = at + needle.size() - 1;  // 指向 '{'
  int depth = 0;
  for (size_t index = start; index < message.size(); ++index) {
    if (message[index] == L'{') depth += 1;
    else if (message[index] == L'}') {
      depth -= 1;
      if (depth == 0) return message.substr(start, index - start + 1);
    }
  }
  return {};
}

ClipboardHistoryItem ParseClipboardHistoryItem(const std::wstring& objectJson) {
  ClipboardHistoryItem item;
  item.id = JsonStringValue(objectJson, L"id");
  item.kind = JsonStringValue(objectJson, L"kind");
  if (item.kind.empty()) item.kind = L"text";
  item.text = JsonStringValue(objectJson, L"text");
  item.path = JsonStringValue(objectJson, L"path");
  item.paths = JsonStringArrayValue(objectJson, L"paths");
  item.width = static_cast<unsigned long long>(std::max(0, JsonIntValue(objectJson, L"width")));
  item.height = static_cast<unsigned long long>(std::max(0, JsonIntValue(objectJson, L"height")));
  item.at = ClipboardHistoryWallClock();
  if (item.id.empty()) item.id = L"cb-seed-" + std::to_wstring(GetTickCount64());
  return item;
}

bool ClipboardHistoryTopMatches(const ClipboardHistoryItem& candidate) {
  if (g_clipboardHistory.empty()) return false;
  const auto& top = g_clipboardHistory.back();
  if (top.kind != candidate.kind) return false;
  if (candidate.kind == L"text") return top.text == candidate.text;
  if (candidate.kind == L"files") return top.paths == candidate.paths;
  if (candidate.kind == L"image") return top.digest != 0 && top.digest == candidate.digest;
  return false;
}

// 捕获当前剪贴板进历史。顺序：文件 → 图片 → 文本；返回是否新增了一条。
bool CaptureClipboardIntoHistory(bool force) {
  if (!force && !g_clipboardHistoryAuto) return false;
  if (GetTickCount64() - g_clipboardSelfWriteAt < 800) return false;  // 自己写回的剪贴板不回环记录
  static const UINT excludeFormat = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
  if (excludeFormat && IsClipboardFormatAvailable(excludeFormat)) return false;  // 密码管理器等声明排除
  ClipboardHistoryItem item;
  std::vector<std::wstring> paths;
  bool opened = false;
  bool hasDrop = false;
  ReadClipboardDropPaths(paths, opened, hasDrop);
  if (!paths.empty()) {
    item.kind = L"files";
    item.paths = paths;
    const size_t slash = paths[0].find_last_of(L"\\/");
    const std::wstring firstName = slash == std::wstring::npos ? paths[0] : paths[0].substr(slash + 1);
    item.text = paths.size() > 1 ? firstName + L" 等 " + std::to_wstring(paths.size()) + L" 个文件" : firstName;
  } else {
    UINT width = 0;
    UINT height = 0;
    unsigned long long imageDigest = 0;
    const std::wstring imagePath = SaveClipboardImageToFile(width, height, &imageDigest);
    if (!imagePath.empty()) {
      item.kind = L"image";
      item.path = imagePath;
      item.width = width;
      item.height = height;
      item.digest = imageDigest;
      item.text = L"截图/图片 " + std::to_wstring(width) + L"×" + std::to_wstring(height);
    } else {
      std::wstring text = ReadClipboardText();
      if (text.size() > 20000) text.resize(20000);
      if (text.empty()) return false;
      item.kind = L"text";
      item.text = text;
    }
  }
  if (ClipboardHistoryTopMatches(item)) {
    if (item.kind == L"image" && !item.path.empty()) {
      std::error_code removeError;
      std::filesystem::remove(item.path, removeError);  // 重复通知：清掉落盘的多余文件
    }
    return false;
  }
  g_clipboardHistorySerial += 1;
  item.id = L"cb-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(g_clipboardHistorySerial);
  if (g_clipboardHistory.size() >= 200) g_clipboardHistory.erase(g_clipboardHistory.begin());
  g_clipboardHistory.push_back(item);
  PersistClipboardHistory();
  PostClipboardHistoryItem(g_clipboardHistory.back());
  return true;
}


// ---------- 剪贴板：把画布选中项写成「系统剪贴板」内容（可直接粘进 PS / AI / 资源管理器） ----------
void PostClipboardWriteResult(bool ok, size_t count, const std::wstring& error) {
  std::wstring json = L"{\"type\":\"native-clipboard-write-result\",\"ok\":" + std::wstring(ok ? L"true" : L"false") +
    L",\"count\":" + std::to_wstring(count);
  if (!error.empty()) json += L",\"error\":\"" + JsonEscape(error) + L"\"";
  json += L"}";
  PostToCanvas(json);
}

// 文件/文件夹 → CF_HDROP（资源管理器、PS、AI 都能当文件粘）。
void HandleClipboardWriteFiles(const std::wstring& message) {
  const auto paths = JsonStringArrayValue(message, L"paths");
  if (paths.empty()) {
    PostClipboardWriteResult(false, 0, L"没有可复制的文件");
    return;
  }
  const auto dataObject = CreateShellDataObject(paths);
  if (!dataObject) {
    PostClipboardWriteResult(false, 0, L"无法准备文件列表");
    return;
  }
  if (FAILED(OleSetClipboard(dataObject.Get()))) {
    PostClipboardWriteResult(false, 0, L"系统拒绝了这次剪贴板写入");
    return;
  }
  OleFlushClipboard();
  PostClipboardWriteResult(true, paths.size(), {});
}

// 粘贴后登记观察：目标目录的条目数/最近写入时间还在变 → 系统还在拷。
void WatchSurfaceCopy(const std::shared_ptr<NativeSurface>& surface);
size_t CopyWatchSignature(const std::shared_ptr<NativeSurface>& surface);

// 拷贝期间暂停后台的重 IO（缩略图预热、元数据抽取、文件夹体积统计），
// 让系统拷贝独占磁盘——机械盘上这是唯一能实测到的“提速”。
bool CopyInProgress() {
  return g_copyWatchers.load() > 0;
}

size_t CopyWatchSignature(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || surface->source.empty() || surface->source.rfind(L"shell:", 0) == 0) return 0;
  std::error_code error;
  size_t count = 0;
  ULONGLONG newest = 0;
  for (std::filesystem::directory_iterator iterator(surface->source, error), end; !error && iterator != end; iterator.increment(error)) {
    ++count;
    const auto stamp = iterator->last_write_time(error);
    if (error) { error.clear(); continue; }
    const auto ticks = static_cast<ULONGLONG>(stamp.time_since_epoch().count());
    if (ticks > newest) newest = ticks;
  }
  uint64_t hash = 1469598103934665603ULL;
  hash ^= static_cast<uint64_t>(count);
  hash *= 1099511628211ULL;
  hash ^= static_cast<uint64_t>(newest);
  return static_cast<size_t>(hash);
}

void WatchSurfaceCopy(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || surface->copyWatchActive) return;
  surface->copyWatchActive = true;
  surface->copyWatchStableTicks = 0;
  surface->copyWatchSignature = CopyWatchSignature(surface);
  surface->copyWatchDeadline = GetTickCount64() + 700;
  ++g_copyWatchers;
  PostToCanvasAsync(L"{\"type\":\"native-copy-watch\",\"surfaceId\":\"" + JsonEscape(surface->id) +
    L"\",\"done\":false,\"items\":0}");
}

void StopSurfaceCopyWatch(const std::shared_ptr<NativeSurface>& surface) {
  if (!surface || !surface->copyWatchActive) return;
  surface->copyWatchActive = false;
  surface->copyWatchStableTicks = 0;
  if (g_copyWatchers.load() > 0) --g_copyWatchers;
  PostToCanvasAsync(L"{\"type\":\"native-copy-watch\",\"surfaceId\":\"" + JsonEscape(surface->id) +
    L"\",\"done\":true,\"items\":0}");
}

// 350ms 的状态计时器里轮询：目录内容 3 次没变化（≈2 秒）就算拷完。
void TickCopyWatches(ULONGLONG now) {
  for (const auto& surface : g_surfaces) {
    if (!surface || !surface->copyWatchActive) continue;
    if (surface->copyWatchDeadline && now < surface->copyWatchDeadline) continue;
    const size_t signature = CopyWatchSignature(surface);
    if (signature != surface->copyWatchSignature) {
      surface->copyWatchSignature = signature;
      surface->copyWatchStableTicks = 0;
      surface->copyWatchDeadline = now + 700;
      continue;
    }
    surface->copyWatchDeadline = now + 700;
    if (++surface->copyWatchStableTicks < 3) continue;
    surface->explorerContentDirty = true;
    StopSurfaceCopyWatch(surface);
  }
}

void HandleClipboardHistoryAppend(const std::wstring& message) {
  const std::wstring objectJson = JsonSubObject(message, L"item");
  if (!objectJson.empty()) {
    ClipboardHistoryItem item = ParseClipboardHistoryItem(objectJson);
    if (!ClipboardHistoryTopMatches(item)) {
      if (g_clipboardHistory.size() >= 200) g_clipboardHistory.erase(g_clipboardHistory.begin());
      g_clipboardHistory.push_back(item);
      PersistClipboardHistory();
    }
  }
  PostClipboardHistory(JsonStringValue(message, L"requestId"));
}

void RevealInExplorer(const std::wstring& path) {
  if (path.empty()) return;
  PIDLIST_ABSOLUTE pidl = nullptr;
  if (FAILED(SHParseDisplayName(path.c_str(), nullptr, &pidl, 0, nullptr)) || !pidl) return;
  SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
  CoTaskMemFree(pidl);
}

// 剪贴暂存“从剪贴板添加”：手动立即捕获一次（自动记录暂停时也能用）。
void HandleShelfCapture(const std::wstring& message) {
  if (!CaptureClipboardIntoHistory(true)) {
    const std::wstring requestId = JsonStringValue(message, L"requestId");
    if (!requestId.empty()) {
      PostToCanvas(L"{\"type\":\"native-shelf-capture-result\",\"requestId\":\"" + JsonEscape(requestId) +
        L"\",\"kind\":\"empty\"}");
    }
  }
}

// ---- 掌中界自带截图：区域框选 / 全屏，全局热键可自定义（设置-快捷键里改）----

constexpr int kCaptureRegionHotkeyId = 0x5a01;
constexpr int kCaptureFullHotkeyId = 0x5a02;
constexpr int kCaptureToolHotkeyId = 0x5a03;

// 随包携带的「微信式截图工具」（ScreenCapture，xland/ScreenCapture，MIT，单文件免安装）：
// 路径固定相对主程序目录解析，不依赖用户配置；找不到就提示。
std::wstring BundledScreenCapturePath() {
  wchar_t module[MAX_PATH]{};
  if (!GetModuleFileNameW(nullptr, module, MAX_PATH)) return {};
  const std::filesystem::path dir = std::filesystem::path(module).parent_path();
  const std::filesystem::path candidates[] = { dir / L"ScreenCapture.exe", dir / L"tools" / L"ScreenCapture.exe" };
  for (const auto& candidate : candidates) {
    std::error_code code;
    if (std::filesystem::exists(candidate, code) && !code) return candidate.wstring();
  }
  return {};
}

// 拉起来就完事：--auto-quit=true = 用完即走（框选→标注→复制/保存→退出），
// 不常驻托盘；想常驻就自己再启动一次不带参数的那个。
void LaunchScreenCaptureTool() {
  const std::wstring path = BundledScreenCapturePath();
  if (path.empty()) {
    PostToCanvasAsync(L"{\"type\":\"native-toast\",\"text\":\"没找到 ScreenCapture.exe（应和掌中界放在同一目录）\"}");
    return;
  }
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_FLAG_NO_UI;
  info.lpVerb = L"open";
  info.lpFile = path.c_str();
  info.lpParameters = L"--auto-quit=true";
  const std::wstring directory = std::filesystem::path(path).parent_path().wstring();
  if (!directory.empty()) info.lpDirectory = directory.c_str();
  info.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&info)) {
    const DWORD lastError = GetLastError();
    wchar_t detail[512]{};
    swprintf_s(detail, L"launch ScreenCapture failed (winerr=%lu): ", static_cast<unsigned long>(lastError));
    WriteLifecycleLog((std::wstring(detail) + path).c_str());
    PostToCanvasAsync(L"{\"type\":\"native-toast\",\"text\":\"截图工具启动失败（被系统拦下了）\"}");
  } else {
    WriteLifecycleLog(L"screencapture launched");
  }
}

bool ParseHotkeyBinding(const std::wstring& binding, UINT& modifiers, UINT& virtualKey) {
  modifiers = 0;
  virtualKey = 0;
  if (binding.empty()) return false;
  std::vector<std::wstring> parts;
  size_t start = 0;
  while (start <= binding.size()) {
    const size_t at = binding.find(L'+', start);
    if (at == std::wstring::npos) { parts.push_back(binding.substr(start)); break; }
    parts.push_back(binding.substr(start, at - start));
    start = at + 1;
  }
  if (parts.size() < 2) return false;  // 全局热键必须带修饰键
  for (size_t index = 0; index + 1 < parts.size(); ++index) {
    if (_wcsicmp(parts[index].c_str(), L"Ctrl") == 0) modifiers |= MOD_CONTROL;
    else if (_wcsicmp(parts[index].c_str(), L"Alt") == 0) modifiers |= MOD_ALT;
    else if (_wcsicmp(parts[index].c_str(), L"Shift") == 0) modifiers |= MOD_SHIFT;
    else return false;
  }
  if (!modifiers) return false;
  const std::wstring key = parts.back();
  if (key.size() == 1) {
    const wchar_t ch = towupper(key[0]);
    if ((ch >= L'A' && ch <= L'Z') || (ch >= L'0' && ch <= L'9')) virtualKey = static_cast<UINT>(ch);
    else return false;
  } else if (key.size() >= 2 && (key[0] == L'F' || key[0] == L'f')) {
    const int number = _wtoi(key.c_str() + 1);
    if (number < 1 || number > 24) return false;
    virtualKey = VK_F1 + static_cast<UINT>(number - 1);
  } else if (_wcsicmp(key.c_str(), L"PrintScreen") == 0) {
    virtualKey = VK_SNAPSHOT;
  } else {
    return false;
  }
  return true;
}

std::wstring CaptureBindingFor(const wchar_t* id, const wchar_t* fallback) {
  const auto found = g_shortcutBindings.find(id);
  return found != g_shortcutBindings.end() && !found->second.empty() ? found->second : std::wstring(fallback);
}

bool g_captureRegionHotkey = false;
bool g_captureFullHotkey = false;

void RegisterCaptureHotkeys() {
  if (!g_mainWindow) return;
  UnregisterHotKey(g_mainWindow, kCaptureRegionHotkeyId);
  UnregisterHotKey(g_mainWindow, kCaptureFullHotkeyId);
  g_captureRegionHotkey = false;
  g_captureFullHotkey = false;
  UINT modifiers = 0;
  UINT virtualKey = 0;
  const std::wstring regionBinding = CaptureBindingFor(L"capture.region", L"Ctrl+Alt+S");
  g_captureRegionHotkey = ParseHotkeyBinding(regionBinding, modifiers, virtualKey) &&
    RegisterHotKey(g_mainWindow, kCaptureRegionHotkeyId, modifiers | MOD_NOREPEAT, virtualKey) != FALSE;
  const std::wstring fullBinding = CaptureBindingFor(L"capture.fullscreen", L"Ctrl+Shift+F");
  g_captureFullHotkey = ParseHotkeyBinding(fullBinding, modifiers, virtualKey) &&
    RegisterHotKey(g_mainWindow, kCaptureFullHotkeyId, modifiers | MOD_NOREPEAT, virtualKey) != FALSE;
  UnregisterHotKey(g_mainWindow, kCaptureToolHotkeyId);
  const std::wstring toolBinding = CaptureBindingFor(L"capture.wechatTool", L"Alt+A");
  if (ParseHotkeyBinding(toolBinding, modifiers, virtualKey)) {
    if (!RegisterHotKey(g_mainWindow, kCaptureToolHotkeyId, modifiers | MOD_NOREPEAT, virtualKey)) {
      PostToCanvas(L"{\"type\":\"native-toast\",\"text\":\"" + JsonEscape(
        L"截图工具快捷键 " + toolBinding + L" 注册失败（可能被占用），可在 设置→快捷键 里更换") + L"\"}");
    }
  }
  if (!g_captureRegionHotkey) {
    PostToCanvas(L"{\"type\":\"native-toast\",\"text\":\"" + JsonEscape(
      L"截图快捷键 " + regionBinding + L" 注册失败（可能被其他软件占用），可在 设置→快捷键 里更换") + L"\"}");
  }
}

HBITMAP g_captureSource = nullptr;
HBITMAP g_captureDim = nullptr;
int g_captureOriginX = 0;
int g_captureOriginY = 0;
int g_captureWidth = 0;
int g_captureHeight = 0;
bool g_captureDragging = false;
POINT g_captureStartPoint{};
RECT g_captureSelection{};
HWND g_captureWindow = nullptr;
HWND g_captureHoverWindow = nullptr;
RECT g_captureHoverRect{};
bool g_captureHoverValid = false;
bool g_captureMoved = false;             // 按下后是否移动超过阈值（区分"单击整选"与"拖框"）
bool g_capturePressHoverValid = false;   // 按下瞬间的巡边目标
RECT g_capturePressHoverRect{};
HBITMAP g_captureBase = nullptr;         // 预合成底板：原图 + 变暗（拖动时每帧只做一次轻量 BitBlt）
HDC g_captureBaseDC = nullptr;
HGDIOBJ g_captureBasePrevious = nullptr;
// 离屏合成帧：拖动时多步 GDI 结果先在内存里画完，最后只做一次 BitBlt 贴到窗口 ——
// 杜绝"每步都直落窗口 DC"造成的拖动闪烁（用户反馈的"框一闪一闪"）。
HDC g_captureFrameDC = nullptr;
HBITMAP g_captureFrame = nullptr;
HGDIOBJ g_captureFramePrevious = nullptr;
unsigned int g_capturePaintCount = 0;    // 绘制计时（写入 capture-paint.log，用于验证流畅度）
unsigned long long g_capturePaintTotalMs = 0;

std::wstring NextShotName(const wchar_t* prefix) {
  SYSTEMTIME now{};
  GetLocalTime(&now);
  wchar_t name[96]{};
  swprintf_s(name, L"%s-%04d%02d%02d-%02d%02d%02d-%03u.png", prefix, now.wYear, now.wMonth, now.wDay,
    now.wHour, now.wMinute, now.wSecond, now.wMilliseconds);
  return (std::filesystem::path(ClipboardStagingFolder()) / name).wstring();
}

// HBITMAP → 落盘 PNG（含 FNV-1a 摘要），返回文件路径
std::wstring SaveHBitmapToStaging(HBITMAP bitmap, UINT& outWidth, UINT& outHeight, unsigned long long* outDigest) {
  if (!bitmap) return {};
  BITMAP object{};
  if (!GetObjectW(bitmap, sizeof(object), &object) || object.bmWidth <= 0 || object.bmHeight == 0) return {};
  const int width = object.bmWidth;
  const int height = std::abs(object.bmHeight);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  const size_t pixelBytes = static_cast<size_t>(width) * height * 4;
  std::vector<unsigned char> pixels(pixelBytes);
  HDC dc = GetDC(nullptr);
  const int rows = GetDIBits(dc, bitmap, 0, height, pixels.data(), &info, DIB_RGB_COLORS);
  ReleaseDC(nullptr, dc);
  if (rows != height) return {};
  bool anyAlpha = false;
  for (size_t index = 3; index < pixelBytes; index += 4) { if (pixels[index] != 0) { anyAlpha = true; break; } }
  if (!anyAlpha) {
    for (size_t index = 3; index < pixelBytes; index += 4) pixels[index] = 255;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT created = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created)) created = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created) || !factory) return {};
  ComPtr<IWICBitmap> source;
  if (FAILED(factory->CreateBitmapFromMemory(static_cast<UINT>(width), static_cast<UINT>(height),
      GUID_WICPixelFormat32bppBGRA, static_cast<UINT>(width * 4),
      static_cast<UINT>(pixelBytes), pixels.data(), &source)) || !source) return {};
  const std::vector<unsigned char> png = EncodePng(factory.Get(), source.Get(), static_cast<UINT>(width), static_cast<UINT>(height));
  if (png.empty()) return {};
  unsigned long long digest = 1469598103934665603ULL;
  for (const unsigned char byte : png) { digest ^= byte; digest *= 1099511628211ULL; }
  if (outDigest) *outDigest = digest;
  const std::wstring target = NextShotName(L"shot");
  std::ofstream stream(target, std::ios::binary | std::ios::trunc);
  if (!stream) return {};
  stream.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
  if (!stream) return {};
  stream.close();
  outWidth = static_cast<UINT>(width);
  outHeight = static_cast<UINT>(height);
  return target;
}

// ── 模板封面（用户 2026-09-16：模板缩略图要「真实渲染」）────────────────────────────
// HBITMAP → PNG 文件。SaveHBitmapToStaging 那套的「写到指定路径」版（那个只会往截图暂存区写）。
bool WriteHBitmapPng(HBITMAP bitmap, const std::wstring& target) {
  if (!bitmap || target.empty()) return false;
  BITMAP object{};
  if (!GetObjectW(bitmap, sizeof(object), &object) || object.bmWidth <= 0 || object.bmHeight == 0) return false;
  const int width = object.bmWidth;
  const int height = std::abs(object.bmHeight);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  const size_t pixelBytes = static_cast<size_t>(width) * height * 4;
  std::vector<unsigned char> pixels(pixelBytes);
  HDC dc = GetDC(nullptr);
  const int rows = GetDIBits(dc, bitmap, 0, height, pixels.data(), &info, DIB_RGB_COLORS);
  ReleaseDC(nullptr, dc);
  if (rows != height) return false;
  bool anyAlpha = false;
  for (size_t index = 3; index < pixelBytes; index += 4) { if (pixels[index] != 0) { anyAlpha = true; break; } }
  if (!anyAlpha) {
    for (size_t index = 3; index < pixelBytes; index += 4) pixels[index] = 255;
  }
  ComPtr<IWICImagingFactory> factory;
  HRESULT created = CoCreateInstance(CLSID_WICImagingFactory2, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created)) created = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (FAILED(created) || !factory) return false;
  ComPtr<IWICBitmap> source;
  if (FAILED(factory->CreateBitmapFromMemory(static_cast<UINT>(width), static_cast<UINT>(height),
      GUID_WICPixelFormat32bppBGRA, static_cast<UINT>(width * 4),
      static_cast<UINT>(pixelBytes), pixels.data(), &source)) || !source) return false;
  const std::vector<unsigned char> png = EncodePng(factory.Get(), source.Get(), static_cast<UINT>(width), static_cast<UINT>(height));
  if (png.empty()) return false;
  std::ofstream stream(target, std::ios::binary | std::ios::trunc);
  if (!stream) return false;
  stream.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
  if (!stream) return false;
  stream.close();
  return true;
}

// 模板封面：把主窗口客户区（整块画布）从屏幕 DC 抓下来，缩到 ≤720 宽，写成 PNG 文件。
// 为什么从屏幕 DC 抓：WebView2 是硬件合成，PrintWindow / WM_PRINT 拿到的是全黑（见 CaptureSurfaceSnapshot 的注释）。
// 为什么这一刻画面是干净的：前端在发保存请求前会先撤掉「保存画布为模板」那个小面板，并等两帧重绘。
bool WriteTemplateThumbnailPng(const std::wstring& target) {
  if (target.empty() || !g_mainWindow) return false;
  if (!IsWindowVisible(g_mainWindow) || IsIconic(g_mainWindow)) return false;
  RECT client{};
  if (!GetClientRect(g_mainWindow, &client)) return false;
  const int sourceWidth = client.right - client.left;
  const int sourceHeight = client.bottom - client.top;
  if (sourceWidth < 64 || sourceHeight < 64) return false;
  const double shrink = std::min(1.0, 720.0 / sourceWidth);
  const int width = std::max(16, static_cast<int>(sourceWidth * shrink + 0.5));
  const int height = std::max(16, static_cast<int>(sourceHeight * shrink + 0.5));

  HDC screen = GetDC(nullptr);
  if (!screen) return false;
  HDC full = CreateCompatibleDC(screen);
  HDC scaled = CreateCompatibleDC(screen);
  BITMAPINFO fullInfo{};
  fullInfo.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  fullInfo.bmiHeader.biWidth = sourceWidth;
  fullInfo.bmiHeader.biHeight = -sourceHeight;
  fullInfo.bmiHeader.biPlanes = 1;
  fullInfo.bmiHeader.biBitCount = 24;
  fullInfo.bmiHeader.biCompression = BI_RGB;
  void* fullBits = nullptr;
  HBITMAP fullBitmap = CreateDIBSection(screen, &fullInfo, DIB_RGB_COLORS, &fullBits, nullptr, 0);

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 24;
  info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);

  bool ok = false;
  if (fullBitmap && bitmap && fullBits && bits) {
    HGDIOBJ oldFull = SelectObject(full, fullBitmap);
    POINT origin{0, 0};
    ClientToScreen(g_mainWindow, &origin);
    BitBlt(full, 0, 0, sourceWidth, sourceHeight, screen, origin.x, origin.y, SRCCOPY);
    HGDIOBJ oldScaled = SelectObject(scaled, bitmap);
    SetStretchBltMode(scaled, HALFTONE);
    StretchBlt(scaled, 0, 0, width, height, full, 0, 0, sourceWidth, sourceHeight, SRCCOPY);
    SelectObject(scaled, oldScaled);
    SelectObject(full, oldFull);
    ok = WriteHBitmapPng(bitmap, target);
  }
  if (fullBitmap) DeleteObject(fullBitmap);
  if (bitmap) DeleteObject(bitmap);
  DeleteDC(full);
  DeleteDC(scaled);
  ReleaseDC(nullptr, screen);
  return ok;
}

HBITMAP CaptureVirtualScreen(int& originX, int& originY, int& width, int& height) {
  originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
  originY = GetSystemMetrics(SM_YVIRTUALSCREEN);
  width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (width <= 0 || height <= 0) return nullptr;
  HDC screen = CreateDCW(L"DISPLAY", nullptr, nullptr, nullptr);
  if (!screen) return nullptr;
  HDC memory = CreateCompatibleDC(screen);
  HBITMAP bitmap = CreateCompatibleBitmap(screen, width, height);
  if (memory && bitmap) {
    HGDIOBJ previous = SelectObject(memory, bitmap);
    // 注意：不要加 CAPTUREBLT —— 它会让系统对分层窗口做一次肉眼可见的闪烁。
    const BOOL copied = BitBlt(memory, 0, 0, width, height, screen, originX, originY, SRCCOPY);
    SelectObject(memory, previous);
    if (!copied) { DeleteObject(bitmap); bitmap = nullptr; }
  } else if (bitmap) {
    DeleteObject(bitmap);
    bitmap = nullptr;
  }
  if (memory) DeleteDC(memory);
  DeleteDC(screen);
  return bitmap;
}

void AppendClipboardHistoryImage(const std::wstring& path, UINT width, UINT height, unsigned long long digest) {
  if (path.empty()) return;
  ClipboardHistoryItem item;
  item.kind = L"image";
  item.path = path;
  item.width = width;
  item.height = height;
  item.digest = digest;
  item.text = L"截图/图片 " + std::to_wstring(width) + L"×" + std::to_wstring(height);
  g_clipboardHistorySerial += 1;
  item.id = L"cb-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(g_clipboardHistorySerial);
  item.at = ClipboardHistoryWallClock();
  if (g_clipboardHistory.size() >= 200) g_clipboardHistory.erase(g_clipboardHistory.begin());
  g_clipboardHistory.push_back(item);
  PersistClipboardHistory();
  PostClipboardHistoryItem(g_clipboardHistory.back());
}

std::wstring ReadFileAsImageDataUrl(const std::wstring& path) {
  if (path.empty()) return {};
  std::error_code error;
  const auto size = std::filesystem::file_size(path, error);
  if (error || size == 0 || size > 40ULL * 1024 * 1024) return {};
  std::ifstream stream(std::filesystem::path(path), std::ios::binary);
  if (!stream) return {};
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  stream.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(size));
  if (!stream) return {};
  std::wstring lower = path;
  std::transform(lower.begin(), lower.end(), lower.begin(), ::towlower);
  const auto endsWith = [&lower](const wchar_t* suffix) {
    const size_t length = wcslen(suffix);
    return lower.size() >= length && lower.compare(lower.size() - length, length, suffix) == 0;
  };
  const wchar_t* mime = L"image/png";
  if (endsWith(L".jpg") || endsWith(L".jpeg")) mime = L"image/jpeg";
  else if (endsWith(L".gif")) mime = L"image/gif";
  else if (endsWith(L".bmp")) mime = L"image/bmp";
  else if (endsWith(L".webp")) mime = L"image/webp";
  const std::string encoded = Base64Encode(bytes.data(), bytes.size());
  return L"data:" + std::wstring(mime) + L";base64," + std::wstring(encoded.begin(), encoded.end());
}

void FinishScreenCapture(HBITMAP bitmap, UINT width, UINT height, const wchar_t* label) {
  if (!bitmap || !width || !height) { if (bitmap) DeleteObject(bitmap); return; }
  UINT capturedWidth = 0;
  UINT capturedHeight = 0;
  unsigned long long digest = 0;
  const std::wstring path = SaveHBitmapToStaging(bitmap, capturedWidth, capturedHeight, &digest);
  DeleteObject(bitmap);
  if (path.empty()) {
    PostToCanvas(L"{\"type\":\"native-toast\",\"text\":\"截图保存失败\"}");
    return;
  }
  AppendClipboardHistoryImage(path, capturedWidth, capturedHeight, digest);
  CopyImageFileToClipboard(path);  // 同步进系统剪贴板，可直接 Ctrl+V 到其他软件
  if (g_captureToCanvas) {
    const std::wstring dataUrl = ReadFileAsImageDataUrl(path);
    if (!dataUrl.empty()) {
      PostToCanvas(L"{\"type\":\"native-capture-image\",\"width\":" + std::to_wstring(capturedWidth) +
        L",\"height\":" + std::to_wstring(capturedHeight) + L",\"dataUrl\":\"" + JsonEscape(dataUrl) + L"\"}");
    }
  }
  PostToCanvas(L"{\"type\":\"native-toast\",\"text\":\"" + JsonEscape(
    std::wstring(L"已") + label + L" " + std::to_wstring(capturedWidth) + L"×" + std::to_wstring(capturedHeight) +
    L"，已放入剪贴暂存（可直接在其他软件 Ctrl+V）") + L"\"}");
}

void CaptureFullScreenToHistory() {
  int originX = 0;
  int originY = 0;
  int width = 0;
  int height = 0;
  HBITMAP bitmap = CaptureVirtualScreen(originX, originY, width, height);
  FinishScreenCapture(bitmap, static_cast<UINT>(width), static_cast<UINT>(height), L"全屏截图");
}

// 后备：底板不可用时的原始画法（现场合成）
void BlitCaptureLayersLegacy(HDC dc) {
  if (!g_captureSource) return;
  HDC memory = CreateCompatibleDC(dc);
  if (!memory) return;
  HGDIOBJ previousSource = SelectObject(memory, g_captureSource);
  BitBlt(dc, 0, 0, g_captureWidth, g_captureHeight, memory, 0, 0, SRCCOPY);
  HDC dim = CreateCompatibleDC(dc);
  if (dim && g_captureDim) {
    HGDIOBJ previousDim = SelectObject(dim, g_captureDim);
    const BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    AlphaBlend(dc, 0, 0, g_captureWidth, g_captureHeight, dim, 0, 0, g_captureWidth, g_captureHeight, blend);
    SelectObject(dim, previousDim);
  }
  if (dim) DeleteDC(dim);
  SelectObject(memory, previousSource);
  DeleteDC(memory);
}

void CleanupCaptureOverlay() {
  if (g_captureSource) { DeleteObject(g_captureSource); g_captureSource = nullptr; }
  if (g_captureDim) { DeleteObject(g_captureDim); g_captureDim = nullptr; }
  if (g_captureBaseDC) {
    if (g_captureBasePrevious) { SelectObject(g_captureBaseDC, g_captureBasePrevious); g_captureBasePrevious = nullptr; }
    DeleteDC(g_captureBaseDC);
    g_captureBaseDC = nullptr;
  }
  if (g_captureBase) { DeleteObject(g_captureBase); g_captureBase = nullptr; }
  if (g_captureFrameDC) {
    if (g_captureFramePrevious) { SelectObject(g_captureFrameDC, g_captureFramePrevious); g_captureFramePrevious = nullptr; }
    DeleteDC(g_captureFrameDC);
    g_captureFrameDC = nullptr;
  }
  if (g_captureFrame) { DeleteObject(g_captureFrame); g_captureFrame = nullptr; }
  g_captureWindow = nullptr;
  g_captureDragging = false;
  g_captureMoved = false;
  g_capturePressHoverValid = false;
  g_captureHoverWindow = nullptr;
  g_captureHoverValid = false;
}

HBITMAP MakeCaptureDimLayer(int width, int height) {
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, screen);
  if (!bitmap || !bits) { if (bitmap) DeleteObject(bitmap); return nullptr; }
  auto* pixels = static_cast<unsigned char*>(bits);  // 预乘黑色，约 40% 压暗
  for (size_t index = 0; index < static_cast<size_t>(width) * height; ++index) {
    pixels[index * 4] = 0;
    pixels[index * 4 + 1] = 0;
    pixels[index * 4 + 2] = 0;
    pixels[index * 4 + 3] = 0x66;
  }
  return bitmap;
}

void DrawCaptureSizeLabel(HDC dc, const RECT& rect, int width, int height) {
  if (width <= 0 || height <= 0 || rect.bottom - rect.top < 36) return;
  wchar_t text[48]{};
  swprintf_s(text, L"%d × %d", width, height);
  HGDIOBJ font = SelectObject(dc, GetStockObject(DEFAULT_GUI_FONT));
  SIZE extent{};
  GetTextExtentPoint32W(dc, text, static_cast<int>(wcslen(text)), &extent);
  RECT box{rect.left + 8, rect.top + 8, rect.left + 8 + extent.cx + 14, rect.top + 8 + extent.cy + 6};
  HBRUSH background = CreateSolidBrush(RGB(15, 19, 26));
  FillRect(dc, &box, background);
  DeleteObject(background);
  const int mode = SetBkMode(dc, TRANSPARENT);
  const COLORREF previous = SetTextColor(dc, RGB(240, 244, 250));
  DrawTextW(dc, text, -1, &box, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  SetTextColor(dc, previous);
  SetBkMode(dc, mode);
  SelectObject(dc, font);
}

void BlitCaptureLayersLegacy(HDC dc);  // 后备画法（底板不可用时）

void BlitCaptureLayers(HDC dc) {
  if (!g_captureBaseDC) {
    if (g_captureSource) BlitCaptureLayersLegacy(dc);
    return;
  }
  // 1) 底板（原图+变暗已预合成）：BeginPaint 的 DC 自带脏区裁剪，这里是轻量搬运
  BitBlt(dc, 0, 0, g_captureWidth, g_captureHeight, g_captureBaseDC, 0, 0, SRCCOPY);
  HDC memory = CreateCompatibleDC(dc);
  if (!memory || !g_captureSource) {
    if (memory) DeleteDC(memory);
    return;
  }
  HGDIOBJ previousSource = SelectObject(memory, g_captureSource);
  // 3) 选区提亮 + 描边（拖动=蓝色；巡边悬停=绿色）
  const int selectionWidth = g_captureSelection.right - g_captureSelection.left;
  const int selectionHeight = g_captureSelection.bottom - g_captureSelection.top;
  if (g_captureDragging && selectionWidth > 0 && selectionHeight > 0) {
    BitBlt(dc, g_captureSelection.left, g_captureSelection.top, selectionWidth, selectionHeight,
      memory, g_captureSelection.left, g_captureSelection.top, SRCCOPY);
    HBRUSH border = CreateSolidBrush(RGB(52, 127, 245));
    FrameRect(dc, &g_captureSelection, border);
    DeleteObject(border);
    DrawCaptureSizeLabel(dc, g_captureSelection, selectionWidth, selectionHeight);
  } else if (g_captureHoverValid) {
    const int hoverWidth = g_captureHoverRect.right - g_captureHoverRect.left;
    const int hoverHeight = g_captureHoverRect.bottom - g_captureHoverRect.top;
    if (hoverWidth > 0 && hoverHeight > 0) {
      BitBlt(dc, g_captureHoverRect.left, g_captureHoverRect.top, hoverWidth, hoverHeight,
        memory, g_captureHoverRect.left, g_captureHoverRect.top, SRCCOPY);
      HBRUSH border = CreateSolidBrush(RGB(34, 197, 94));
      FrameRect(dc, &g_captureHoverRect, border);
      DeleteObject(border);
      DrawCaptureSizeLabel(dc, g_captureHoverRect, hoverWidth, hoverHeight);
    }
  }
  SelectObject(memory, previousSource);
  DeleteDC(memory);
}

bool IsCaptureProbeWindow(HWND window) {
  if (!window || !IsWindowVisible(window) || IsIconic(window)) return false;
  // 桌面、任务栏等壳层窗口不能作为巡边目标：它们的矩形是整个屏幕，
  // 命中后高亮就是"全屏"，单击会直接截下整屏（用户反馈的"没巡边就最大化"）。
  if (window == GetShellWindow()) return false;
  wchar_t probeClass[64]{};
  if (GetClassNameW(window, probeClass, 64)) {
    if (wcscmp(probeClass, L"Progman") == 0 || wcscmp(probeClass, L"WorkerW") == 0 ||
        wcscmp(probeClass, L"Shell_TrayWnd") == 0 || wcscmp(probeClass, L"Shell_SecondaryTrayWnd") == 0 ||
        wcscmp(probeClass, L"ForegroundStaging") == 0) return false;
  }
  const LONG_PTR style = GetWindowLongPtrW(window, GWL_STYLE);
  if ((style & WS_CHILD) != 0) return false;
  const LONG_PTR extended = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if ((extended & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)) != 0) return false;
  DWORD cloaked = 0;
  if (SUCCEEDED(DwmGetWindowAttribute(window, 14 /* DWMWA_CLOAKED */, &cloaked, sizeof(cloaked))) && cloaked != 0) return false;
  RECT rect{};
  return GetWindowRect(window, &rect) != FALSE && rect.right > rect.left && rect.bottom > rect.top;
}

// 返回鼠标下窗口/控件在覆盖层客户区坐标里的矩形（已限制在虚拟屏内）。
// 用 GetTopWindow + GW_HWNDNEXT 做可靠的 Z 序遍历（EnumWindows 的顺序不保证）。
bool ProbeCaptureRegionAtPoint(POINT screenPoint, RECT& outRegion) {
  for (HWND window = GetTopWindow(nullptr); window; window = GetWindow(window, GW_HWNDNEXT)) {
    if (window == g_captureWindow) continue;
    if (!IsCaptureProbeWindow(window)) continue;
    RECT rect{};
    if (!GetWindowRect(window, &rect)) continue;
    if (screenPoint.x < rect.left || screenPoint.x >= rect.right ||
        screenPoint.y < rect.top || screenPoint.y >= rect.bottom) continue;
    // 钻进最深的子控件：点聊天窗口时能直接选中输入框这类元素
    HWND deepest = window;
    for (int depth = 0; depth < 12; ++depth) {
      POINT local = screenPoint;
      if (!ScreenToClient(deepest, &local)) break;
      HWND child = ChildWindowFromPointEx(deepest, local, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT | CWP_SKIPDISABLED);
      if (!child || child == deepest) break;
      RECT childRect{};
      if (!GetWindowRect(child, &childRect) || !PtInRect(&childRect, screenPoint)) break;
      deepest = child;
    }
    RECT finalRect{};
    if (GetAncestor(deepest, GA_ROOT) == deepest &&
        SUCCEEDED(DwmGetWindowAttribute(deepest, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, &finalRect, sizeof(finalRect)))) {
      // 顶层窗口用 DWM 可见边框，避开阴影留白
    } else if (!GetWindowRect(deepest, &finalRect)) {
      continue;
    }
    RECT bounds{g_captureOriginX, g_captureOriginY, g_captureOriginX + g_captureWidth, g_captureOriginY + g_captureHeight};
    if (!IntersectRect(&finalRect, &finalRect, &bounds)) continue;
    // 防御：矩形等于整个虚拟屏的"假目标"（壳层窗口）直接判无效
    if (finalRect.right - finalRect.left >= g_captureWidth && finalRect.bottom - finalRect.top >= g_captureHeight) continue;
    outRegion = {finalRect.left - g_captureOriginX, finalRect.top - g_captureOriginY, finalRect.right - g_captureOriginX, finalRect.bottom - g_captureOriginY};
    return outRegion.right > outRegion.left && outRegion.bottom > outRegion.top;
  }
  return false;
}

void CompleteRegionCapture(RECT region) {
  const int left = std::max<int>(region.left, 0);
  const int top = std::max<int>(region.top, 0);
  const int right = std::min<int>(region.right, g_captureWidth);
  const int bottom = std::min<int>(region.bottom, g_captureHeight);
  const int width = right - left;
  const int height = bottom - top;
  if (width < 4 || height < 4) { if (g_captureWindow) DestroyWindow(g_captureWindow); return; }
  HDC screen = GetDC(nullptr);
  HDC sourceDc = CreateCompatibleDC(screen);
  HDC targetDc = CreateCompatibleDC(screen);
  HBITMAP cropped = CreateCompatibleBitmap(screen, width, height);
  if (sourceDc && targetDc && cropped && g_captureSource) {
    HGDIOBJ previousSource = SelectObject(sourceDc, g_captureSource);
    HGDIOBJ previousTarget = SelectObject(targetDc, cropped);
    BitBlt(targetDc, 0, 0, width, height, sourceDc, left, top, SRCCOPY);
    SelectObject(targetDc, previousTarget);
    SelectObject(sourceDc, previousSource);
  }
  if (sourceDc) DeleteDC(sourceDc);
  if (targetDc) DeleteDC(targetDc);
  ReleaseDC(nullptr, screen);
  if (g_captureWindow) DestroyWindow(g_captureWindow);
  {
    std::wofstream log(std::filesystem::path(g_dataFolder) / L"capture-paint.log", std::ios::app);
    if (log) log << L"paints=" << g_capturePaintCount << L" totalMs=" << g_capturePaintTotalMs
                 << L" region=" << width << L"x" << height << L"\n";
  }
  FinishScreenCapture(cropped, static_cast<UINT>(width), static_cast<UINT>(height), L"区域截图");
}

LRESULT CALLBACK CaptureOverlayProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_ERASEBKGND:
      return 1;  // 自绘窗口：抑制默认擦除，避免闪一帧底色
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      HDC dc = BeginPaint(window, &paint);
      const ULONGLONG paintStarted = GetTickCount64();
      if (g_captureFrameDC) {
        // 先全部画进离屏帧，再一次性贴到窗口：窗口 DC 上只有一次 BitBlt，不会有中间态。
        BlitCaptureLayers(g_captureFrameDC);
        BitBlt(dc, paint.rcPaint.left, paint.rcPaint.top,
          paint.rcPaint.right - paint.rcPaint.left, paint.rcPaint.bottom - paint.rcPaint.top,
          g_captureFrameDC, paint.rcPaint.left, paint.rcPaint.top, SRCCOPY);
      } else {
        const int saved = SaveDC(dc);
        HRGN clip = CreateRectRgn(paint.rcPaint.left, paint.rcPaint.top, paint.rcPaint.right, paint.rcPaint.bottom);
        if (clip) { SelectClipRgn(dc, clip); DeleteObject(clip); }
        BlitCaptureLayers(dc);
        RestoreDC(dc, saved);
      }
      EndPaint(window, &paint);
      g_capturePaintCount += 1;
      g_capturePaintTotalMs += GetTickCount64() - paintStarted;
      return 0;
    }
    case WM_SETCURSOR:
      SetCursor(LoadCursorW(nullptr, IDC_CROSS));
      return TRUE;
    case WM_LBUTTONDOWN: {
      // 按下先不截：在原地松开（单击）才选整个巡边目标；移动超过阈值进入自由框选。
      // 之前"按下即整选"导致完全无法拖动框选（用户反馈"一按就截图、拖不了"）。
      g_captureStartPoint = {static_cast<int>(static_cast<short>(LOWORD(lParam))), static_cast<int>(static_cast<short>(HIWORD(lParam)))};
      g_captureDragging = true;
      g_captureMoved = false;
      g_capturePressHoverValid = g_captureHoverValid;
      g_capturePressHoverRect = g_captureHoverRect;
      g_captureSelection = {g_captureStartPoint.x, g_captureStartPoint.y, g_captureStartPoint.x, g_captureStartPoint.y};
      SetCapture(window);
      // 不重绘：保持绿色悬停高亮，让用户看得见"单击会选中谁"
      return 0;
    }
    case WM_MOUSEMOVE: {
      const int x = static_cast<int>(static_cast<short>(LOWORD(lParam)));
      const int y = static_cast<int>(static_cast<short>(HIWORD(lParam)));
      if (g_captureDragging) {
        const int startX = static_cast<int>(g_captureStartPoint.x);
        const int startY = static_cast<int>(g_captureStartPoint.y);
        const bool wasPending = !g_captureMoved;
        if (wasPending && std::abs(x - startX) < 5 && std::abs(y - startY) < 5) return 0;  // 尚未判定：保持绿框
        g_captureMoved = true;
        RECT previous = g_captureSelection;
        g_captureSelection.left = std::min(startX, x);
        g_captureSelection.top = std::min(startY, y);
        g_captureSelection.right = std::max(startX, x);
        g_captureSelection.bottom = std::max(startY, y);
        RECT dirty = g_captureSelection;
        UnionRect(&dirty, &dirty, &previous);
        if (wasPending && g_capturePressHoverValid) {
          // 从"单击整选"切换到拖框：擦掉绿色高亮
          UnionRect(&dirty, &dirty, &g_capturePressHoverRect);
          g_captureHoverValid = false;
        }
        InflateRect(&dirty, 4, 4);
        InvalidateRect(window, &dirty, FALSE);
        return 0;
      }
      // 自动巡边：悬停时高亮鼠标下的整个窗口/控件，单击可直接整选
      RECT hover{};
      const bool valid = ProbeCaptureRegionAtPoint({x + g_captureOriginX, y + g_captureOriginY}, hover);
      const bool changed = valid != g_captureHoverValid || (valid && !EqualRect(&hover, &g_captureHoverRect));
      if (changed) {
        RECT dirty{};
        bool hasDirty = false;
        if (g_captureHoverValid) { dirty = g_captureHoverRect; hasDirty = true; }
        if (valid) {
          if (hasDirty) UnionRect(&dirty, &dirty, &hover);
          else { dirty = hover; hasDirty = true; }
        }
        g_captureHoverRect = hover;
        g_captureHoverValid = valid;
        if (hasDirty) {
          InflateRect(&dirty, 3, 3);
          InvalidateRect(window, &dirty, FALSE);
        }
      }
      return 0;
    }
    case WM_LBUTTONUP: {
      if (!g_captureDragging) return 0;
      g_captureDragging = false;
      ReleaseCapture();
      if (!g_captureMoved) {
        // 原地松开 = 单击：选中按下时高亮的整个窗口/控件
        if (g_capturePressHoverValid) {
          const RECT region = g_capturePressHoverRect;
          g_captureHoverValid = false;
          CompleteRegionCapture(region);
        } else {
          DestroyWindow(window);  // 桌面空单击：取消
        }
        return 0;
      }
      const RECT region = g_captureSelection;
      g_captureHoverValid = false;
      CompleteRegionCapture(region);
      return 0;
    }
    case WM_RBUTTONDOWN:
    case WM_MBUTTONDOWN:
      DestroyWindow(window);
      return 0;
    case WM_KEYDOWN:
      if (wParam == VK_ESCAPE) DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      CleanupCaptureOverlay();
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

void StartRegionCapture() {
  if (g_captureWindow) return;
  int originX = 0;
  int originY = 0;
  int width = 0;
  int height = 0;
  g_captureSource = CaptureVirtualScreen(originX, originY, width, height);
  if (!g_captureSource) {
    PostToCanvas(L"{\"type\":\"native-toast\",\"text\":\"截图失败：无法读取屏幕\"}");
    return;
  }
  g_captureOriginX = originX;
  g_captureOriginY = originY;
  g_captureWidth = width;
  g_captureHeight = height;
  g_captureDim = MakeCaptureDimLayer(width, height);
  // 预合成底板：把"原图 + 变暗"一次算好。拖动/悬停每帧只需要从底板做一次便宜
  // 的位块传输，不再现场 AlphaBlend 全屏 —— 这是拖动时"一闪一闪"的根治点。
  if (g_captureDim) {
    g_captureBaseDC = CreateCompatibleDC(nullptr);
    HDC screenForFrame = GetDC(nullptr);
    if (g_captureBaseDC) g_captureBase = CreateCompatibleBitmap(screenForFrame, width, height);
    // 同一尺寸再来一份离屏帧缓冲（用于每帧原子提交）
    g_captureFrameDC = CreateCompatibleDC(nullptr);
    if (g_captureFrameDC) g_captureFrame = CreateCompatibleBitmap(screenForFrame, width, height);
    ReleaseDC(nullptr, screenForFrame);
    if (g_captureFrameDC && g_captureFrame) {
      g_captureFramePrevious = SelectObject(g_captureFrameDC, g_captureFrame);
    } else {
      if (g_captureFrameDC) { DeleteDC(g_captureFrameDC); g_captureFrameDC = nullptr; }
      if (g_captureFrame) { DeleteObject(g_captureFrame); g_captureFrame = nullptr; }
    }
    if (g_captureBaseDC && g_captureBase) {
      g_captureBasePrevious = SelectObject(g_captureBaseDC, g_captureBase);
      HDC sourceTemp = CreateCompatibleDC(nullptr);
      if (sourceTemp) {
        HGDIOBJ previousSource = SelectObject(sourceTemp, g_captureSource);
        BitBlt(g_captureBaseDC, 0, 0, width, height, sourceTemp, 0, 0, SRCCOPY);
        SelectObject(sourceTemp, previousSource);
        DeleteDC(sourceTemp);
      }
      HDC dimTemp = CreateCompatibleDC(nullptr);
      if (dimTemp) {
        HGDIOBJ previousDim = SelectObject(dimTemp, g_captureDim);
        const BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
        AlphaBlend(g_captureBaseDC, 0, 0, width, height, dimTemp, 0, 0, width, height, blend);
        SelectObject(dimTemp, previousDim);
        DeleteDC(dimTemp);
      }
    }
    DeleteObject(g_captureDim);
    g_captureDim = nullptr;
  }
  g_capturePaintCount = 0;
  g_capturePaintTotalMs = 0;
  static bool overlayClassRegistered = false;
  if (!overlayClassRegistered) {
    WNDCLASSEXW cls{};
    cls.cbSize = sizeof(cls);
    cls.lpfnWndProc = CaptureOverlayProc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.hCursor = LoadCursorW(nullptr, IDC_CROSS);
    cls.lpszClassName = L"ZhangZhongJieCaptureOverlay";
    RegisterClassExW(&cls);
    overlayClassRegistered = true;
  }
  g_captureDragging = false;
  g_captureSelection = {};
  // WS_EX_LAYERED + alpha 0：先把窗口建出来、完整绘制一帧，再整体亮出；
  // 期间屏幕上不会出现"未绘制的空窗口"，从根上避免闪屏。
  g_captureWindow = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED, L"ZhangZhongJieCaptureOverlay", L"截图",
    WS_POPUP, originX, originY, width, height, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!g_captureWindow) {
    CleanupCaptureOverlay();
    PostToCanvas(L"{\"type\":\"native-toast\",\"text\":\"截图失败：无法创建选择窗口\"}");
    return;
  }
  constexpr DWORD kDwmTransitionsForcedDisabled = 3;
  const BOOL transitionsOff = TRUE;
  DwmSetWindowAttribute(g_captureWindow, kDwmTransitionsForcedDisabled, &transitionsOff, sizeof(transitionsOff));
  SetLayeredWindowAttributes(g_captureWindow, 0, 0, LWA_ALPHA);
  ShowWindow(g_captureWindow, SW_SHOW);
  UpdateWindow(g_captureWindow);
  SetLayeredWindowAttributes(g_captureWindow, 0, 255, LWA_ALPHA);
  SetForegroundWindow(g_captureWindow);
  SetFocus(g_captureWindow);
}

void HandleExplorerCommand(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->explorer) return;
  const std::wstring command = JsonStringValue(message, L"command");
  if (command == L"back") surface->explorer->BrowseToIDList(nullptr, SBSP_NAVIGATEBACK);
  else if (command == L"forward") surface->explorer->BrowseToIDList(nullptr, SBSP_NAVIGATEFORWARD);
  else if (command == L"up") surface->explorer->BrowseToIDList(nullptr, SBSP_PARENT);
  else if (command == L"home") BrowseExplorer(surface, L"shell:MyComputerFolder");
  else if (command == L"reload") {
    const auto view = CurrentShellView(surface);
    if (view) view->Refresh();
    surface->explorerContentDirty = true;
  }
  else if (command == L"cut") InvokeShellVerb(surface, SVGIO_SELECTION, "cut");
  else if (command == L"copy") InvokeShellVerb(surface, SVGIO_SELECTION, "copy");
  else if (command == L"paste") {
    if (!RejectArchiveWrite(surface)) {
      InvokeShellVerb(surface, SVGIO_BACKGROUND, "paste");
      surface->explorerContentDirty = true;
      // 系统粘贴是异步的：登记观察，期间暂停自家缩略图/体积统计，别再抢磁盘。
      WatchSurfaceCopy(surface);
    }
  }
  else if (command == L"rename") {
    if (!RejectArchiveWrite(surface)) { InvokeShellVerb(surface, SVGIO_SELECTION, "rename"); surface->explorerContentDirty = true; }
  }
  else if (command == L"delete") {
    if (!RejectArchiveWrite(surface)) { InvokeShellVerb(surface, SVGIO_SELECTION, "delete"); surface->explorerContentDirty = true; }
  }
  else if (command == L"new") {
    if (!RejectArchiveWrite(surface)) { CreateNewFolder(surface); surface->explorerContentDirty = true; }
  }
  else if (command == L"new-txt") {
    if (!RejectArchiveWrite(surface)) { CreateNewFile(surface, L"新建文本文档.txt"); surface->explorerContentDirty = true; }
  }
  else if (command == L"new-md") {
    if (!RejectArchiveWrite(surface)) { CreateNewFile(surface, L"新建 Markdown 文档.md"); surface->explorerContentDirty = true; }
  }
  else if (command == L"new-html") {
    if (!RejectArchiveWrite(surface)) { CreateNewFile(surface, L"新建 HTML 网页.html"); surface->explorerContentDirty = true; }
  }
  else if (command == L"view") CycleViewMode(surface);
  else if (command == L"sort") { CycleSort(surface); surface->explorerContentDirty = true; }
  else if (command == L"more") ShowShellContextMenu(surface,
    JsonIntValue(message, L"screenX", -1), JsonIntValue(message, L"screenY", -1));
  else if (command == L"view-details") SetViewMode(surface, FVM_DETAILS);
  else if (command == L"view-tiles") SetViewMode(surface, FVM_TILE);
  ReportExplorerState(surface, true);
}

void HandleExplorerSelection(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->explorer) return;
  SyncExplorerSelection(surface, JsonStringArrayValue(message, L"paths"));
  ReportExplorerState(surface, true);
}

void HandleExplorerOpen(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->explorer) return;
  OpenExplorerEntry(surface, JsonStringValue(message, L"path"));
  ReportExplorerState(surface, true);
}

void HandleExplorerRename(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  RenameExplorerEntry(surface, JsonStringValue(message, L"path"), JsonStringValue(message, L"name"));
}

void HandleExplorerContextMenu(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->explorer) return;
  SyncExplorerSelection(surface, JsonStringArrayValue(message, L"paths"));
  ShowShellContextMenu(surface, JsonIntValue(message, L"screenX", -1), JsonIntValue(message, L"screenY", -1));
  surface->explorerContentDirty = true;
  ReportExplorerState(surface, true);
}

void HandleShellContextMenu(const std::wstring& message) {
  ShowShellContextMenuForPaths(JsonStringArrayValue(message, L"paths"),
    JsonIntValue(message, L"screenX", -1), JsonIntValue(message, L"screenY", -1));
}

void HandleExplorerTreeRequest(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->explorer) return;
  SendExplorerTree(surface, JsonStringValue(message, L"parent"), JsonBoolValue(message, L"includeFiles", false), JsonStringValue(message, L"purpose"));
}

void HandleDragFiles(const std::wstring& message) {
  const bool completed = BeginShellFileDrag(JsonStringArrayValue(message, L"paths"));
  PostToCanvas(L"{\"type\":\"native-drag-result\",\"kind\":\"files\",\"completed\":" +
    std::wstring(completed ? L"true" : L"false") + L"}");
}

void HandleDragImage(const std::wstring& message) {
  const std::filesystem::path temporary = CreateDragImageFile(JsonStringValue(message, L"dataUrl"));
  if (temporary.empty()) {
    PostToCanvas(L"{\"type\":\"native-drag-result\",\"kind\":\"image\",\"completed\":false}");
    return;
  }
  const bool completed = BeginShellFileDrag({temporary.wstring()});
  PostToCanvas(L"{\"type\":\"native-drag-result\",\"kind\":\"image\",\"completed\":" +
    std::wstring(completed ? L"true" : L"false") + L"}");
  // DoDragDrop 返回时目标已经完成复制；临时源文件不应长期占用磁盘。
  std::error_code error;
  std::filesystem::remove(temporary, error);
}

void ArmNativeDrag(const std::wstring& message, bool image) {
  g_pendingNativeDrag = {};
  g_pendingNativeDrag.armed = true;
  g_pendingNativeDrag.image = image;
  GetCursorPos(&g_pendingNativeDrag.start);
  if (image) {
    g_pendingNativeDrag.itemId = JsonStringValue(message, L"itemId");
    g_pendingNativeDrag.imageToken = JsonStringValue(message, L"imageToken");
    if (g_pendingNativeDrag.itemId == g_cachedDragImageItemId &&
        g_pendingNativeDrag.imageToken == g_cachedDragImageToken) {
      g_pendingNativeDrag.dataUrl = g_cachedDragImageDataUrl;
    }
  }
  else g_pendingNativeDrag.paths = JsonStringArrayValue(message, L"paths");
  if ((image && g_pendingNativeDrag.itemId.empty()) || (!image && g_pendingNativeDrag.paths.empty())) {
    g_pendingNativeDrag = {};
    return;
  }
  if (g_mainWindow) SetTimer(g_mainWindow, kNativeDragTimer, 15, nullptr);
}

void DisarmNativeDrag() {
  g_pendingNativeDrag = {};
  if (g_mainWindow) KillTimer(g_mainWindow, kNativeDragTimer);
}

void PollNativeDrag(HWND window);

void HandleDragImageData(const std::wstring& message) {
  if (!g_pendingNativeDrag.armed || !g_pendingNativeDrag.image) return;
  const std::wstring itemId = JsonStringValue(message, L"itemId");
  if (itemId != g_pendingNativeDrag.itemId) return;
  if (itemId == g_cachedDragImageItemId &&
      g_pendingNativeDrag.imageToken == g_cachedDragImageToken &&
      !g_cachedDragImageDataUrl.empty()) {
    g_pendingNativeDrag.dataUrl = g_cachedDragImageDataUrl;
  } else {
    g_pendingNativeDrag.dataUrl = JsonStringValue(message, L"dataUrl");
    if (!g_pendingNativeDrag.dataUrl.empty()) {
      g_cachedDragImageItemId = itemId;
      g_cachedDragImageToken = g_pendingNativeDrag.imageToken;
      g_cachedDragImageDataUrl = g_pendingNativeDrag.dataUrl;
    }
  }
  if (g_pendingNativeDrag.dataUrl.empty()) DisarmNativeDrag();
  // DoDragDrop 会进入嵌套消息循环，不能在 WebView2 的消息回调栈里同步进入。
  else if (g_mainWindow) PostMessageW(g_mainWindow, kBeginNativeDragMessage, 0, 0);
}

void PollNativeDrag(HWND window) {
  if (!g_pendingNativeDrag.armed) { KillTimer(window, kNativeDragTimer); return; }
  if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) {
    g_pendingNativeDrag = {};
    KillTimer(window, kNativeDragTimer);
    return;
  }
  POINT cursor{};
  GetCursorPos(&cursor);
  const int threshold = std::max(6, MulDiv(6, static_cast<int>(GetDpiForWindow(window)), 96));
  if (std::abs(cursor.x - g_pendingNativeDrag.start.x) < threshold &&
      std::abs(cursor.y - g_pendingNativeDrag.start.y) < threshold) return;

  // 新版 Web 会在 pointerdown 后立即异步预取 data URL；保留这里的请求分支，
  // 用于兼容旧页面或预取消息暂未到达的情况。
  if (g_pendingNativeDrag.image && g_pendingNativeDrag.dataUrl.empty()) {
    if (!g_pendingNativeDrag.imageRequested) {
      g_pendingNativeDrag.imageRequested = true;
      PostToCanvas(L"{\"type\":\"native-drag-image-request\",\"itemId\":\"" +
        JsonEscape(g_pendingNativeDrag.itemId) + L"\"}");
    }
    return;
  }

  PendingNativeDrag pending = std::move(g_pendingNativeDrag);
  g_pendingNativeDrag = {};
  KillTimer(window, kNativeDragTimer);
  const ULONGLONG startedAt = GetTickCount64();
  if (pending.image) {
    const std::filesystem::path temporary = CreateDragImageFile(pending.dataUrl);
    const bool completed = !temporary.empty() && BeginShellFileDrag({temporary.wstring()});
    POINT endedAt{};
    GetCursorPos(&endedAt);
    PostToCanvas(L"{\"type\":\"native-drag-result\",\"kind\":\"image\",\"completed\":" +
      std::wstring(completed ? L"true" : L"false") + L",\"durationMs\":" +
      std::to_wstring(GetTickCount64() - startedAt) + L",\"screenX\":" + std::to_wstring(endedAt.x) +
      L",\"screenY\":" + std::to_wstring(endedAt.y) + L"}");
    if (!temporary.empty()) {
      std::error_code error;
      std::filesystem::remove(temporary, error);
    }
  } else {
    const bool completed = BeginShellFileDrag(pending.paths);
    POINT endedAt{};
    GetCursorPos(&endedAt);
    PostToCanvas(L"{\"type\":\"native-drag-result\",\"kind\":\"files\",\"completed\":" +
      std::wstring(completed ? L"true" : L"false") + L",\"durationMs\":" +
      std::to_wstring(GetTickCount64() - startedAt) + L",\"screenX\":" + std::to_wstring(endedAt.x) +
      L",\"screenY\":" + std::to_wstring(endedAt.y) + L"}");
  }
}

void HandleExplorerDrop(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->explorer) return;
  // Dragging into an archive is a mutation even though the destination is a
  // Shell container; keep this release read-only inside ZIP namespaces.
  if (RejectArchiveWrite(surface)) return;
  const auto paths = JsonStringArrayValue(message, L"paths");
  const auto dataObject = CreateShellDataObject(paths);
  const auto view = CurrentFolderView(surface);
  ComPtr<IShellItem> destination;
  if (!dataObject || !view || FAILED(view->GetFolder(IID_PPV_ARGS(&destination))) || !destination) return;
  ComPtr<IFileOperation> operation;
  if (FAILED(CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_INPROC_SERVER,
      IID_PPV_ARGS(&operation))) || !operation) return;
  operation->SetOwnerWindow(g_mainWindow);
  // 同名冲突、权限提升、云端占位文件等细节全部交给 Shell 自己处理。
  operation->SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR);
  if (SUCCEEDED(operation->CopyItems(dataObject.Get(), destination.Get())) &&
      SUCCEEDED(operation->PerformOperations())) {
    surface->explorerContentDirty = true;
    ReportExplorerState(surface, true);
  }
}


// ---------- 画布「打包到目录」：把选中卡片引用的真实文件收进指定目录 ----------
std::wstring CollectDestinationRecordPath() {
  return (std::filesystem::path(g_dataFolder) / L"打包目录.txt").wstring();
}

// 记住上次用过的目录：反复打包时不用每次从头找。
std::wstring PromptCollectDestination() {
  ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) || !dialog) return {};
  FILEOPENDIALOGOPTIONS options{};
  if (FAILED(dialog->GetOptions(&options))) return {};
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  dialog->SetTitle(L"选择打包目录");
  std::wstring remembered;
  if (!g_dataFolder.empty() && ReadUtf8File(CollectDestinationRecordPath(), remembered)) {
    while (!remembered.empty() &&
           (remembered.back() == static_cast<wchar_t>(13) || remembered.back() == static_cast<wchar_t>(10))) {
      remembered.pop_back();
    }
    if (!remembered.empty() && IsFileSystemDirectory(remembered)) {
      ComPtr<IShellItem> folder;
      if (SUCCEEDED(SHCreateItemFromParsingName(remembered.c_str(), nullptr, IID_PPV_ARGS(&folder))) && folder) {
        dialog->SetFolder(folder.Get());
      }
    }
  }
  g_nativeDialogOpen = true;
  const HRESULT result = dialog->Show(g_mainWindow);
  g_nativeDialogOpen = false;
  if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED) || FAILED(result)) return {};
  ComPtr<IShellItem> item;
  if (FAILED(dialog->GetResult(&item)) || !item) return {};
  PWSTR selectedPath = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &selectedPath)) || !selectedPath) return {};
  std::wstring selected(selectedPath);
  CoTaskMemFree(selectedPath);
  WriteUtf8FileAtomic(CollectDestinationRecordPath(), selected);
  return selected;
}

// 通用「选文件夹」对话框（导出目录 / 其它需要自定义位置的地方复用）。
// 和 PromptCollectDestination 的区别：标题与起始目录由调用方给，不写记忆文件。
std::wstring PromptFolderDialog(const std::wstring& title, const std::wstring& initial) {
  ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) || !dialog) return {};
  FILEOPENDIALOGOPTIONS options{};
  if (FAILED(dialog->GetOptions(&options))) return {};
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  dialog->SetTitle(title.c_str());
  if (!initial.empty() && IsFileSystemDirectory(initial)) {
    ComPtr<IShellItem> folder;
    if (SUCCEEDED(SHCreateItemFromParsingName(initial.c_str(), nullptr, IID_PPV_ARGS(&folder))) && folder) {
      dialog->SetFolder(folder.Get());
    }
  }
  g_nativeDialogOpen = true;
  const HRESULT result = dialog->Show(g_mainWindow);
  g_nativeDialogOpen = false;
  if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED) || FAILED(result)) return {};
  ComPtr<IShellItem> item;
  if (FAILED(dialog->GetResult(&item)) || !item) return {};
  PWSTR selectedPath = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &selectedPath)) || !selectedPath) return {};
  std::wstring selected(selectedPath);
  CoTaskMemFree(selectedPath);
  return selected;
}

void PostCollectResult(bool ok, bool cancelled, const std::wstring& destination, size_t copied, size_t missing,
                       const std::wstring& error) {
  // 注意 JSON 拼接必须严格闭合：漏一个引号会让 PostWebMessageAsJson 静默失败
  // （消息发不出去，页面上看不到任何结果提示）。
  std::wstring json = L"{\"type\":\"native-collect-result\",\"ok\":" + std::wstring(ok ? L"true" : L"false") +
    L",\"cancelled\":" + std::wstring(cancelled ? L"true" : L"false") +
    L",\"destination\":\"" + JsonEscape(destination) +
    L"\",\"copied\":" + std::to_wstring(copied) + L",\"missing\":" + std::to_wstring(missing);
  if (!error.empty()) json += L",\"error\":\"" + JsonEscape(error) + L"\"";
  json += L"}";
  PostToCanvas(json);
}

void HandleCollectItems(const std::wstring& message) {
  // paths = 真实磁盘路径；images/names = 没有磁盘路径的图片（剪贴板粘贴、截图），
  // 先物化成临时 PNG 再一起拷走，保证「打包出来的都是真实文件」。
  std::vector<std::wstring> sources = JsonStringArrayValue(message, L"paths");
  const auto images = JsonStringArrayValue(message, L"images");
  const auto names = JsonStringArrayValue(message, L"names");
  std::vector<std::filesystem::path> temporaryImages;
  std::vector<std::wstring> wantedNames(sources.size(), std::wstring());
  for (size_t index = 0; index < images.size(); ++index) {
    const std::filesystem::path temporary = CreateDragImageFile(images[index]);
    if (temporary.empty()) continue;
    temporaryImages.push_back(temporary);
    std::wstring wanted = index < names.size() ? names[index] : std::wstring();
    if (!wanted.empty() && _wcsicmp(temporary.extension().c_str(), L".png") == 0 && wanted.find(L'.') == std::wstring::npos) {
      wanted += L".png";
    }
    if (!wanted.empty() && wanted.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos) wanted.clear();
    sources.push_back(temporary.wstring());
    wantedNames.push_back(std::move(wanted));
  }
  const auto cleanupTemporaries = [&temporaryImages]() {
    for (const auto& path : temporaryImages) {
      std::error_code ignored;
      std::filesystem::remove(path, ignored);
    }
  };
  if (sources.empty()) {
    cleanupTemporaries();
    PostCollectResult(false, false, {}, 0, 0, L"所选项目里没有可以打包的真实文件");
    return;
  }
  std::wstring destination = JsonStringValue(message, L"destination");
  if (destination.empty()) destination = PromptCollectDestination();
  if (destination.empty()) {
    cleanupTemporaries();
    PostCollectResult(false, true, {}, 0, 0, {});
    return;
  }
  // 目标目录不能落在被打包的文件夹里，否则是自我复制的无底洞。
  for (const auto& source : sources) {
    if (IsFileSystemDirectory(std::filesystem::path(source)) && PathStartsWithFolder(destination, source)) {
      cleanupTemporaries();
      PostCollectResult(false, false, {}, 0, 0, L"目标目录在被打包的文件夹里面，请换一个目录");
      return;
    }
  }
  std::error_code error;
  std::filesystem::create_directories(destination, error);
  if (error) {
    cleanupTemporaries();
    PostCollectResult(false, false, {}, 0, 0, L"无法创建目标目录，请检查磁盘空间与权限");
    return;
  }
  const bool hasFolder = std::any_of(sources.begin(), sources.end(), [](const std::wstring& value) {
    return IsFileSystemDirectory(std::filesystem::path(value));
  });
  if (hasFolder) {
    const std::wstring prompt = L"选中的项目里有文件夹，会连同子目录一起复制。\n\n目标目录：\n" + destination;
    g_nativeDialogOpen = true;
    const int answer = MessageBoxW(g_mainWindow, prompt.c_str(), L"掌中界 · 打包到目录", MB_OKCANCEL | MB_ICONINFORMATION);
    g_nativeDialogOpen = false;
    if (answer != IDOK) {
      cleanupTemporaries();
      PostCollectResult(false, true, {}, 0, 0, {});
      return;
    }
  }
  ComPtr<IShellItem> destinationItem;
  if (FAILED(SHCreateItemFromParsingName(destination.c_str(), nullptr, IID_PPV_ARGS(&destinationItem))) || !destinationItem) {
    cleanupTemporaries();
    PostCollectResult(false, false, {}, 0, 0, L"目标目录不可用");
    return;
  }
  ComPtr<IFileOperation> operation;
  if (FAILED(CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&operation))) || !operation) {
    cleanupTemporaries();
    PostCollectResult(false, false, {}, 0, 0, L"无法启动系统复制");
    return;
  }
  operation->SetOwnerWindow(g_mainWindow);
  // 同名冲突自动改名、不弹覆盖确认；回收站可撤销；权限提升交给系统。
  operation->SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR | FOF_RENAMEONCOLLISION | FOFX_SHOWELEVATIONPROMPT);
  size_t queued = 0;
  size_t missing = 0;
  for (size_t index = 0; index < sources.size(); ++index) {
    if (GetFileAttributesW(sources[index].c_str()) == INVALID_FILE_ATTRIBUTES) {
      ++missing;
      continue;
    }
    ComPtr<IShellItem> item;
    if (FAILED(SHCreateItemFromParsingName(sources[index].c_str(), nullptr, IID_PPV_ARGS(&item))) || !item) {
      ++missing;
      continue;
    }
    const std::wstring& wanted = index < wantedNames.size() ? wantedNames[index] : std::wstring();
    if (SUCCEEDED(operation->CopyItem(item.Get(), destinationItem.Get(), wanted.empty() ? nullptr : wanted.c_str(), nullptr))) {
      ++queued;
    } else {
      ++missing;
    }
  }
  bool ok = queued > 0 && SUCCEEDED(operation->PerformOperations());
  if (ok) {
    BOOL aborted = FALSE;
    operation->GetAnyOperationsAborted(&aborted);
    if (aborted) ok = false;
  }
  cleanupTemporaries();
  if (!ok && queued == 0) {
    PostCollectResult(false, false, destination, 0, missing, L"没有文件被复制，可能源文件已被移动");
    return;
  }
  PostCollectResult(ok, false, destination, queued, missing, {});
}

void HandleBrowserCommand(const std::wstring& message) {
  const auto surface = FindSurface(JsonStringValue(message, L"surfaceId"));
  if (!surface || !surface->webView) return;
  const std::wstring command = JsonStringValue(message, L"command");
  if (command == L"back") {
    BOOL canGoBack = FALSE;
    if (SUCCEEDED(surface->webView->get_CanGoBack(&canGoBack)) && canGoBack) surface->webView->GoBack();
  } else if (command == L"forward") {
    BOOL canGoForward = FALSE;
    if (SUCCEEDED(surface->webView->get_CanGoForward(&canGoForward)) && canGoForward) surface->webView->GoForward();
  } else if (command == L"reload") {
    surface->webView->Reload();
  }
}

bool IsWebThemeEffective() {
  if (!g_browserEnvironment) return false;
  return g_browserEnvironmentHasForceDark == (g_webThemeMode == L"dark");
}

void SendWebThemeSetting(bool restartRequired, bool success = true) {
  PostToCanvas(L"{\"type\":\"native-web-theme-setting\",\"webThemeMode\":\"" +
    JsonEscape(g_webThemeMode) + L"\",\"restartRequired\":" +
    std::wstring(restartRequired ? L"true" : L"false") + L",\"success\":" +
    std::wstring(success ? L"true" : L"false") + L",\"effective\":" +
    std::wstring(IsWebThemeEffective() ? L"true" : L"false") + L",\"degraded\":" +
    std::wstring(g_browserEnvironmentDegraded ? L"true" : L"false") + L"}");
}

void SendSettings(bool success = true, const std::wstring& error = {}, bool consumeNotice = false) {
  std::wstring message = L"{\"type\":\"native-settings\",\"settings\":{"
    L"\"version\":" + std::to_wstring(g_settingsVersion) + L",\"windowAppearance\":\"" + JsonEscape(g_windowAppearance) +
    L"\",\"windowMaterial\":\"" + JsonEscape(g_windowMaterial) +
    L"\",\"toolbarVisibility\":\"" + JsonEscape(g_toolbarVisibility) +
    L"\",\"cardTitlebarVisibility\":\"" + JsonEscape(g_cardTitlebarVisibility) +
    L"\",\"appTheme\":\"" + JsonEscape(g_appThemeMode) +
    L"\",\"webThemeMode\":\"" + JsonEscape(g_webThemeMode) +
    L"\",\"fileTreeCollapsed\":" + std::wstring(g_fileTreeCollapsed ? L"true" : L"false") +
    L",\"fileViewMode\":\"" + JsonEscape(g_fileViewMode) +
    L"\",\"fileIconMode\":\"" + JsonEscape(g_fileIconMode) +
    L"\",\"fileColumns\":" + JsonStringArray(g_fileColumns) +
    L",\"globalQuickActions\":" + JsonStringArray(g_globalQuickActions) +
    L",\"globalFavorites\":" + JsonGlobalFavorites() +
    L",\"globalFixedOrder\":" + JsonStringArray(g_globalFixedOrder) +
    L",\"webBookmarks\":" + JsonWebBookmarks() +
    L",\"fileColumnWidths\":" + JsonFileColumnWidths() +
    L",\"fileTreeWidths\":" + JsonWidthMap(g_fileTreeWidths) +
    L",\"fileTreeColumnWidths\":" + JsonWidthMap(g_fileTreeColumnWidths) +
    L",\"previewNameColumnWidth\":" + std::to_wstring(g_previewNameColumnWidth) +
    L",\"mediaMuted\":" + std::wstring(g_mediaMuted ? L"true" : L"false") +
    L",\"mediaPlaybackRate\":" + std::to_wstring(g_mediaPlaybackRate) +
    L",\"exportFolder\":\"" + JsonEscape(g_exportFolder) +
    L",\"everythingPromptDismissed\":" + std::wstring(g_everythingPromptDismissed ? L"true" : L"false") +
    L",\"explorerContextMenuEnabled\":" + std::wstring(g_explorerContextMenuEnabled ? L"true" : L"false") +
    L",\"settingsWidth\":" + std::to_wstring(g_settingsWidth) +
    L",\"settingsHeight\":" + std::to_wstring(g_settingsHeight) +
    L",\"shortcutBindings\":" + JsonShortcutBindings() + L"},"
    L"\"webThemeMode\":\"" + JsonEscape(g_webThemeMode) + L"\",\"success\":" +
    std::wstring(success ? L"true" : L"false") + L",\"effective\":" +
    std::wstring(IsWebThemeEffective() ? L"true" : L"false") + L",\"degraded\":" +
    std::wstring(g_browserEnvironmentDegraded ? L"true" : L"false");
  if (!error.empty()) message += L",\"error\":\"" + JsonEscape(error) + L"\"";
  if (g_settingsNoticePending) {
    message += L",\"settingsNotice\":\"设置文件已损坏，原文件已保留；本次已使用安全默认设置启动。\"";
    if (consumeNotice) g_settingsNoticePending = false;
  } else if (g_explorerContextMenuNoticePending) {
    message += L",\"settingsNotice\":\"资源管理器右键菜单未能更新，请检查当前用户的注册表权限。\"";
    if (consumeNotice) g_explorerContextMenuNoticePending = false;
  }
  message += L"}";
  PostToCanvas(message);
}

void SendPendingBrowserNotices() {
  if (!g_appWebView || !g_canvasReady) return;
  if (g_browserProfileMigrationNoticePending) {
    PostToCanvas(L"{\"type\":\"native-browser-profile-migration\"}");
    if (WriteUtf8FileAtomic(BrowserProfileMigrationNoticePath(), L"shown")) {
      g_browserProfileMigrationNoticePending = false;
    }
  }
  if (g_browserFallbackNoticePending) {
    PostToCanvas(L"{\"type\":\"native-browser-environment-fallback\","
                 L"\"degraded\":" + std::wstring(g_browserEnvironmentDegraded ? L"true" : L"false") +
                 L",\"error\":\"网页专用渲染环境启动失败，已改用兼容运行；网页仍可使用，但本次会话的网页登录状态不会保留到下次启动。\"}");
    g_browserFallbackNoticePending = false;
  }
}

void ActivateBrowserEnvironmentFallback() {
  if (!g_browserEnvironmentFallbackPending || g_browserEnvironment || !g_environment) return;
  g_browserEnvironment = g_environment;
  g_browserEnvironmentFallbackPending = false;
  g_browserEnvironmentHasForceDark = false;
  g_browserEnvironmentDegraded = g_webThemeMode == L"dark";
  g_browserFallbackNoticePending = true;
  for (const auto& surface : g_surfaces) {
    if (surface && surface->kind == L"browser") CreateBrowserSurface(surface);
  }
  SendWebThemeSetting(false);
  SendPendingBrowserNotices();
}

void HandleAppTheme(const std::wstring& message) {
  g_appThemeDark = JsonBoolValue(message, L"dark", true);
  ApplyBrowserColorSchemeToAll();
  ApplyWebViewBackground();
}

void HandleWebThemeSetting(const std::wstring& message) {
  const std::wstring requested = JsonStringValue(message, L"webThemeMode");
  g_webThemeMode = requested == L"dark" || requested == L"original" ? requested : L"follow";
  const bool saved = SaveSettings();
  // PreferredColorScheme 可以即时刷新支持 prefers-color-scheme 的网页；Chromium
  // 强制深色参数属于环境级选项，只能在下次启动时真正启用或停用。
  ApplyBrowserColorSchemeToAll();
  SendWebThemeSetting(!IsWebThemeEffective(), saved);
  SendSettings(saved, saved ? L"" : L"无法写入 settings.json");
}

void DispatchIncomingPath(const std::wstring& path) {
  if (path.empty()) return;
  const auto classified = ClassifyCanvasPath(path);
  if (classified.projectKind != CanvasProjectKind::None) {
    HandleProjectOpen(classified.projectPath.wstring(), classified.projectKind == CanvasProjectKind::Archive);
    return;
  }
  PostToCanvas(L"{\"type\":\"native-drop-files\",\"paths\":[{\"path\":\"" +
    JsonEscape(path) + L"\",\"folder\":" +
    std::wstring(classified.folder ? L"true" : L"false") + L"}]}");
}

void HandleSettingsUpdate(const std::wstring& message) {
  const auto validated = [&message](const wchar_t* key, std::initializer_list<const wchar_t*> allowed, const wchar_t* fallback) {
    const std::wstring value = JsonStringValue(message, key);
    return IsOneOf(value, allowed) ? value : std::wstring(fallback);
  };
  const std::wstring previousWebTheme = g_webThemeMode;
  const std::wstring previousWindowAppearance = g_windowAppearance;
  const std::wstring previousWindowMaterial = g_windowMaterial;
  const std::wstring previousToolbarVisibility = g_toolbarVisibility;
  const bool previousExplorerContextMenuEnabled = g_explorerContextMenuEnabled;
  g_settingsVersion = 2;
  g_windowAppearance = validated(L"windowAppearance", {L"system", L"borderless"}, L"borderless");
  g_windowMaterial = validated(L"windowMaterial", {L"mica", L"solid"}, L"mica");
  g_toolbarVisibility = validated(L"toolbarVisibility", {L"always", L"auto"}, L"auto");
  g_cardTitlebarVisibility = validated(L"cardTitlebarVisibility", {L"always", L"hover"}, L"hover");
  g_exportFolder = JsonStringValue(message, L"exportFolder");
  g_appThemeMode = validated(L"appTheme", {L"system", L"light", L"dark"}, L"system");
  g_webThemeMode = validated(L"webThemeMode", {L"follow", L"dark", L"original"}, L"dark");
  g_fileTreeCollapsed = JsonBoolValue(message, L"fileTreeCollapsed", false);
  g_fileViewMode = validated(L"fileViewMode", {L"details", L"large-icons", L"media-grid", L"compact"}, L"details");
  g_fileIconMode = validated(L"fileIconMode", {L"system", L"vector"}, L"system");
  size_t settingsAt = 0;
  const JsonValue settingsRoot = ParseJsonValue(message, settingsAt);
  const JsonValue* settingsObject = settingsRoot.Member(L"settings");
  const JsonValue* fileColumnsValue = settingsObject ? settingsObject->Member(L"fileColumns") : nullptr;
  if (fileColumnsValue && fileColumnsValue->kind == JsonValue::Kind::Array) {
    std::vector<std::wstring> fileColumns;
    fileColumns.reserve(fileColumnsValue->items.size());
    for (const auto& value : fileColumnsValue->items) {
      if (value.kind == JsonValue::Kind::String) fileColumns.push_back(value.text);
    }
    g_fileColumns = NormalizeFileColumns(fileColumns);
  }
  const JsonValue* globalQuickActionsValue = settingsObject ? settingsObject->Member(L"globalQuickActions") : nullptr;
  if (globalQuickActionsValue && globalQuickActionsValue->kind == JsonValue::Kind::Array) {
    std::vector<std::wstring> globalQuickActions;
    globalQuickActions.reserve(globalQuickActionsValue->items.size());
    for (const auto& value : globalQuickActionsValue->items) {
      if (value.kind == JsonValue::Kind::String) globalQuickActions.push_back(value.text);
    }
    g_globalQuickActions = NormalizeGlobalQuickActions(globalQuickActions);
  }
  LoadGlobalFavorites(settingsObject ? settingsObject->Member(L"globalFavorites") : nullptr);
  std::vector<std::wstring> globalFixedOrder;
  const JsonValue* globalFixedOrderValue = settingsObject ? settingsObject->Member(L"globalFixedOrder") : nullptr;
  if (globalFixedOrderValue && globalFixedOrderValue->kind == JsonValue::Kind::Array) {
    globalFixedOrder.reserve(globalFixedOrderValue->items.size());
    for (const auto& value : globalFixedOrderValue->items) {
      if (value.kind == JsonValue::Kind::String) globalFixedOrder.push_back(value.text);
    }
  }
  g_globalFixedOrder = NormalizeGlobalFixedOrder(globalFixedOrder);
  LoadWebBookmarks(settingsObject ? settingsObject->Member(L"webBookmarks") : nullptr);
  LoadFileColumnWidths(settingsObject ? settingsObject->Member(L"fileColumnWidths") : nullptr);
  LoadWidthMap(settingsObject ? settingsObject->Member(L"fileTreeWidths") : nullptr, g_fileTreeWidths, 200, 2000);
  LoadWidthMap(settingsObject ? settingsObject->Member(L"fileTreeColumnWidths") : nullptr, g_fileTreeColumnWidths, 80, 1200);
  g_previewNameColumnWidth = std::clamp(JsonIntValue(message, L"previewNameColumnWidth", 210), 100, 410);
  g_mediaMuted = JsonBoolValue(message, L"mediaMuted", true);
  g_everythingPromptDismissed = JsonBoolValue(message, L"everythingPromptDismissed", false);
  g_explorerContextMenuEnabled = JsonBoolValue(message, L"explorerContextMenuEnabled", true);
  g_settingsWidth = std::clamp(JsonIntValue(message, L"settingsWidth", 620), 560, 2400);
  g_settingsHeight = std::clamp(JsonIntValue(message, L"settingsHeight", 720), 420, 1600);
  LoadShortcutBindings(settingsObject ? settingsObject->Member(L"shortcutBindings") : nullptr);
  const double mediaPlaybackRate = JsonDoubleValue(message, L"mediaPlaybackRate", 1.0);
  g_mediaPlaybackRate = mediaPlaybackRate == 0.5 || mediaPlaybackRate == 1.0 || mediaPlaybackRate == 1.5 || mediaPlaybackRate == 2.0
    ? mediaPlaybackRate : 1.0;
  const bool saved = SaveSettings();
  const bool contextMenuApplied = previousExplorerContextMenuEnabled == g_explorerContextMenuEnabled ||
    ApplyExplorerContextMenuRegistration(g_explorerContextMenuEnabled);
  if (g_webThemeMode != previousWebTheme) ApplyBrowserColorSchemeToAll();
  if (g_windowAppearance != previousWindowAppearance && g_mainWindow) {
    PostMessageW(g_mainWindow, kApplyWindowAppearanceMessage, 0, 0);
  }
  if (g_windowMaterial != previousWindowMaterial && g_mainWindow) {
    PostMessageW(g_mainWindow, kApplyWindowMaterialMessage, 0, 0);
  }
  if (g_toolbarVisibility != previousToolbarVisibility && g_toolbarVisibility != L"auto") {
    UpdateToolbarHotZone({}, true);
  }
  RegisterCaptureHotkeys();  // 快捷键可能改了，重挂全局截图热键
  SendSettings(saved && contextMenuApplied, !saved ? L"无法写入 settings.json" :
    contextMenuApplied ? L"" : L"无法更新资源管理器右键菜单，请检查当前用户的注册表权限");
  SendWebThemeSetting(!IsWebThemeEffective(), saved);
}

void HandleWebMessage(ICoreWebView2WebMessageReceivedEventArgs* args) {
  LPWSTR raw = nullptr;
  if (FAILED(args->get_WebMessageAsJson(&raw)) || !raw) return;
  const std::wstring message(raw);
  CoTaskMemFree(raw);
  RecordLastWebViewMessage(message);
  const std::wstring type = JsonStringValue(message, L"type");
  if (type == L"native-surface-upsert") UpsertSurface(message);
  else if (type == L"native-surface-destroy") RetireSurface(
    JsonStringValue(message, L"surfaceId"), JsonStringValue(message, L"leaseId"));
  else if (type == L"native-surface-snapshot-request") {
    const std::wstring surfaceId = JsonStringValue(message, L"surfaceId");
    const auto found = std::find_if(g_surfaces.begin(), g_surfaces.end(),
      [&surfaceId](const auto& surface) { return surface && surface->id == surfaceId; });
    if (found != g_surfaces.end()) CaptureSurfaceSnapshot(*found);
  }
  else if (type == L"native-surface-audio") SetAudibleSurface(JsonStringValue(message, L"surfaceId"));
  else if (type == L"native-browser-command") HandleBrowserCommand(message);
  else if (type == L"native-browser-video-mode") {
    // 纯视频窗口（2026-09-13 用户要求）：把网页里的 <video> 拉满整张卡片，并把视频原始尺寸回给 Web 层，
    // 好让卡片按同一比例变成小窗口。页面重排会冲掉注入，所以 Web 层每 4 秒补一次（脚本本身幂等）。
    const auto target = FindSurface(JsonStringValue(message, L"surfaceId"));
    const std::wstring videoMode = JsonStringValue(message, L"mode");
    if (target && target->webView) {
      static const wchar_t* kVideoOnlyOn = LR"ZZJ((function(){var s=document.getElementById('zzj-video-only');var list=document.querySelectorAll('video');var best=null,area=0;for(var i=0;i<list.length;i++){var v=list[i];var a=(v.videoWidth||v.clientWidth||0)*(v.videoHeight||v.clientHeight||0);if(a>=area){area=a;best=v;}}if(!best)return '{"ok":false}';var size=window.__zzjVideoSize;if(!size){var w=best.videoWidth||best.clientWidth||0,h=best.videoHeight||best.clientHeight||0;if(w>0&&h>0){size={w:w,h:h};window.__zzjVideoSize=size;}}if(!s){s=document.createElement('style');s.id='zzj-video-only';(document.head||document.documentElement).appendChild(s);}s.textContent='html,body{overflow:hidden!important;background:#000!important}video{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;object-fit:contain!important;background:#000!important;z-index:2147483647!important}';if(!size)return '{"ok":true,"w":0,"h":0}';return '{"ok":true,"w":'+size.w+',"h":'+size.h+'}';})())ZZJ";
      static const wchar_t* kVideoOnlyOff = LR"ZZJ((function(){var s=document.getElementById('zzj-video-only');if(s)s.remove();window.__zzjVideoSize=null;window.__zzjPipHook=false;return '{"ok":true}';})())ZZJ";
      static const wchar_t* kPipHook = LR"ZZJ((function(){if(window.__zzjPipHook)return '{"ok":true,"already":1,"pipEnabled":'+(document.pictureInPictureEnabled===true)+'}';window.__zzjPipHook=true;document.addEventListener('dblclick',function(e){if(!window.__zzjPipHook)return;var v=null,t=e.target;if(t&&t.closest)v=t.closest('video');var all=document.querySelectorAll('video');if(!v){for(var i=0;i<all.length;i++){var r=all[i].getBoundingClientRect();if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom){v=all[i];break;}}}if(!v&&all.length)v=all[all.length-1];if(!v)return;e.preventDefault();e.stopPropagation();try{if(document.pictureInPictureElement){document.exitPictureInPicture();}else{var p=v.requestPictureInPicture();if(p&&p.catch)p.catch(function(){});}}catch(err){}},true);return '{"ok":true,"pipEnabled":'+(document.pictureInPictureEnabled===true)+'}';})())ZZJ";
      const std::wstring videoSurfaceId = target->id;
      target->webView->ExecuteScript(videoMode == L"off" ? kVideoOnlyOff : (videoMode == L"pip" ? kPipHook : kVideoOnlyOn),
        Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
          [videoSurfaceId, videoMode](HRESULT error, LPCWSTR result) -> HRESULT {
            PostToCanvasAsync(L"{\"type\":\"native-browser-video-mode-result\",\"surfaceId\":\"" + JsonEscape(videoSurfaceId) +
              L"\",\"mode\":\"" + JsonEscape(videoMode) +
              L"\",\"ok\":" + std::wstring(SUCCEEDED(error) ? L"true" : L"false") +
              L",\"result\":\"" + JsonEscape(result ? result : L"") + L"\"}");
            return S_OK;
          }).Get());
    }
  }
  else if (type == L"native-browser-volume") {
    const auto target = FindSurface(JsonStringValue(message, L"surfaceId"));
    const double volume = std::max(0.0, std::min(1.0, JsonDoubleValue(message, L"volume", 1.0)));
    if (target) {
      target->volume = volume;
      ApplySurfaceVolume(target);
      WriteLifecycleLog((L"audio: " + target->id + L" volume=" + std::to_wstring(static_cast<int>(volume * 100 + 0.5))).c_str());
    }
  }
  else if (type == L"native-browser-zoom") {
    const auto target = FindSurface(JsonStringValue(message, L"surfaceId"));
    const double factor = JsonDoubleValue(message, L"factor", 1.0);
    if (target && target->controller) target->controller->put_ZoomFactor(std::max(0.25, std::min(3.0, factor)));
  }
  else if (type == L"native-browser-devtools") {
    const auto target = FindSurface(JsonStringValue(message, L"surfaceId"));
    if (target && target->webView) target->webView->OpenDevToolsWindow();
  }
  else if (type == L"native-browser-useragent") {
    g_browserUserAgentMode = JsonStringValue(message, L"mode") == L"chrome" ? L"chrome" : L"default";
    for (const auto& surface : g_surfaces) {
      if (!surface || surface->kind != L"browser" || !surface->webView) continue;
      ComPtr<ICoreWebView2Settings> settings;
      if (FAILED(surface->webView->get_Settings(&settings)) || !settings) continue;
      ComPtr<ICoreWebView2Settings2> settings2;
      if (FAILED(settings.As(&settings2)) || !settings2) continue;
      if (g_browserUserAgentMode == L"chrome") settings2->put_UserAgent(L"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
      else settings2->put_UserAgent(L"");
    }
  }
  else if (type == L"native-app-theme") HandleAppTheme(message);
  else if (type == L"native-web-theme-setting") HandleWebThemeSetting(message);
  else if (type == L"native-web-theme-query") SendWebThemeSetting(false);
  else if (type == L"native-settings-update") HandleSettingsUpdate(message);
  else if (type == L"native-settings-query") SendSettings(true, {}, true);
  else if (type == L"native-window-drag" && g_mainWindow) PostMessageW(g_mainWindow, kBeginWindowDragMessage, 0, 0);
  else if (type == L"native-window-minimize" && g_mainWindow) PostMessageW(g_mainWindow, kWindowMinimizeMessage, 0, 0);
  else if (type == L"native-window-toggle-maximize" && g_mainWindow) PostMessageW(g_mainWindow, kWindowToggleMaximizeMessage, 0, 0);
  else if (type == L"native-window-toggle-maximize" && g_mainWindow) PostMessageW(g_mainWindow, kWindowToggleMaximizeMessage, 0, 0);
  else if (type == L"native-window-snap-left" && g_mainWindow) PostMessageW(g_mainWindow, kWindowSnapLeftMessage, 0, 0);
  else if (type == L"native-window-snap-right" && g_mainWindow) PostMessageW(g_mainWindow, kWindowSnapRightMessage, 0, 0);
  else if (type == L"native-window-snap-layout" && g_mainWindow) PostMessageW(g_mainWindow, kWindowSnapLayoutMessage, 0, 0);
  else if (type == L"native-window-tile-query") SendTileWindowCandidates();
  else if (type == L"native-window-tile-apply") TileSelectedWindows(message);
  else if (type == L"native-split-drag") HandleSplitDrag(message);
  else if (type == L"native-split-release") ReleaseSplit(true);
  else if (type == L"native-window-close" && g_mainWindow) PostMessageW(g_mainWindow, kWindowCloseMessage, 0, 0);
  else if (type == L"native-window-state-query") { SendWindowState(true); SendWindowMaterialState(); }
  else if (type == L"native-clipboard-read") {
    const std::wstring requestId = JsonStringValue(message, L"requestId");
    std::wstring text = ReadClipboardText();
    if (text.size() > 40000) text.resize(40000);
    PostToCanvasAsync(L"{\"type\":\"native-clipboard-text\",\"requestId\":\"" + JsonEscape(requestId) +
      L"\",\"text\":\"" + JsonEscape(text) + L"\"}");
  }
  else if (type == L"native-clipboard-write") WriteClipboardText(JsonStringValue(message, L"text"));
  else if (type == L"native-clipboard-write-files") HandleClipboardWriteFiles(message);
  else if (type == L"native-clipboard-write-image") {
    // path 与 dataUrl 二选一：画布上的粘贴图片只有 dataUrl，先物化成临时 PNG 再进剪贴板。
    const std::wstring clipboardImagePath = JsonStringValue(message, L"path");
    const std::wstring clipboardImageData = JsonStringValue(message, L"dataUrl");
    if (!clipboardImagePath.empty()) {
      CopyImageFileToClipboard(clipboardImagePath);
    } else if (!clipboardImageData.empty()) {
      const std::filesystem::path temporary = CreateDragImageFile(clipboardImageData);
      if (!temporary.empty()) {
        CopyImageFileToClipboard(temporary.wstring());
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
      }
    }
  }
  else if (type == L"native-clipboard-history-request") PostClipboardHistory(JsonStringValue(message, L"requestId"));
  else if (type == L"native-clipboard-history-remove") {
    const auto ids = JsonStringArrayValue(message, L"ids");
    for (const auto& id : ids) {
      g_clipboardHistory.erase(std::remove_if(g_clipboardHistory.begin(), g_clipboardHistory.end(),
        [&](const ClipboardHistoryItem& item) { return item.id == id; }), g_clipboardHistory.end());
    }
    PersistClipboardHistory();
    PostClipboardHistory(JsonStringValue(message, L"requestId"));
  }
  else if (type == L"native-clipboard-history-clear") {
    g_clipboardHistory.clear();
    PersistClipboardHistory();
    PostClipboardHistory(JsonStringValue(message, L"requestId"));
  }
  else if (type == L"native-clipboard-history-auto") {
    g_clipboardHistoryAuto = JsonBoolValue(message, L"enabled", true);
    PersistClipboardHistory();
    PostClipboardHistory(JsonStringValue(message, L"requestId"));
  }
  else if (type == L"native-clipboard-history-append") HandleClipboardHistoryAppend(message);
  else if (type == L"native-reveal-path") RevealInExplorer(JsonStringValue(message, L"path"));
  else if (type == L"native-write-file") HandleWriteFile(message);
  else if (type == L"native-pick-folder-request") {
    // 让用户自己挑导出位置（面板上「更换…」）。取消时回空串，页面保持原样。
    const std::wstring requestId = JsonStringValue(message, L"requestId");
    const std::wstring title = JsonStringValue(message, L"title");
    const std::wstring start = JsonStringValue(message, L"start");
    const std::wstring picked = PromptFolderDialog(title.empty() ? L"选择文件夹" : title, start);
    PostToCanvasAsync(L"{\"type\":\"native-pick-folder-result\",\"requestId\":\"" + JsonEscape(requestId) + L"\",\"path\":\"" + JsonEscape(picked) + L"\"}");
  }
  else if (type == L"native-export-folder-query") {
    const std::wstring requestId = JsonStringValue(message, L"requestId");
    PostToCanvasAsync(L"{\"type\":\"native-export-folder\",\"requestId\":\"" + JsonEscape(requestId) + L"\",\"path\":\"" + JsonEscape(ExportFolder()) + L"\"}");
  }
  else if (type == L"native-capture-region") StartRegionCapture();
  else if (type == L"native-capture-fullscreen") CaptureFullScreenToHistory();
  else if (type == L"native-ocr-image") {
    // 离线 OCR：Windows 自带引擎。放工作线程跑（阻塞式 .get() 不能压在 UI 线程上）。
    const std::wstring ocrRequestId = JsonStringValue(message, L"requestId");
    const std::wstring ocrPath = JsonStringValue(message, L"path");
    const std::wstring ocrLanguage = JsonStringValue(message, L"language");
    std::error_code ocrStatError;
    if (ocrPath.empty() || !std::filesystem::exists(ocrPath, ocrStatError)) {
      PostToCanvasAsync(L"{\"type\":\"native-ocr-result\",\"requestId\":\"" + JsonEscape(ocrRequestId) +
        L"\",\"ok\":false,\"error\":\"图片文件不存在\"}");
    } else {
      std::thread([ocrRequestId, ocrPath, ocrLanguage]() {
        // 语言 → 引擎：朝鲜语走系统自带 ko（实测更准），中文/英文优先走随包的 RapidOCR。
        const bool useBundledEngine = ocrLanguage != L"ko" && !BundledRapidOcrFolder().empty();
        bool ocrOk = false;
        std::wstring ocrText;
        std::wstring ocrError;
        std::wstring ocrEngine = L"系统 OCR";
        std::wstring ocrDetectedLanguage = ocrLanguage;
        long long ocrElapsedMs = 0;
        if (useBundledEngine) {
          const RapidOcrOutcome rapid = RunBundledRapidOcr(ocrPath, ocrLanguage);
          ocrOk = rapid.ok;
          ocrText = rapid.text;
          ocrError = rapid.error;
          ocrEngine = rapid.engine;
          ocrElapsedMs = rapid.elapsedMs;
        } else {
          const WindowsOcrOutcome windows = RunWindowsOcr(ocrPath, ocrLanguage);
          ocrOk = windows.ok;
          ocrText = windows.text;
          ocrError = windows.error;
          ocrElapsedMs = windows.elapsedMs;
          if (!windows.language.empty()) ocrDetectedLanguage = windows.language;
        }
        // 主引擎没拿到字 → 自动换另一个引擎再试一次（RapidOCR 对某些图会认不出，系统 OCR 兜底）
        if ((!ocrOk || ocrText.empty()) && useBundledEngine) {
          const WindowsOcrOutcome backup = RunWindowsOcr(ocrPath, ocrLanguage);
          if (backup.ok && !backup.text.empty()) {
            ocrOk = true;
            ocrText = backup.text;
            ocrElapsedMs = backup.elapsedMs;
            ocrEngine = L"系统 OCR（RapidOCR 没认出来，已自动切换）";
            if (!backup.language.empty()) ocrDetectedLanguage = backup.language;
          }
        } else if ((!ocrOk || ocrText.empty()) && !useBundledEngine && !BundledRapidOcrFolder().empty()) {
          const RapidOcrOutcome backup = RunBundledRapidOcr(ocrPath, ocrLanguage);
          if (backup.ok && !backup.text.empty()) {
            ocrOk = true;
            ocrText = backup.text;
            ocrElapsedMs = backup.elapsedMs;
            ocrEngine = L"RapidOCR（系统 OCR 没认出来，已自动切换）";
          }
        }
        std::wstring lines;
        std::wstringstream raw(ocrText);
        std::wstring one;
        bool first = true;
        while (std::getline(raw, one)) {
          if (!one.empty() && one.back() == L'\r') one.pop_back();
          if (!first) lines += L",";
          lines += L"\"" + JsonEscape(one) + L"\"";
          first = false;
        }
        PostToCanvasAsync(L"{\"type\":\"native-ocr-result\",\"requestId\":\"" + JsonEscape(ocrRequestId) +
          L"\",\"ok\":" + std::wstring(ocrOk ? L"true" : L"false") +
          L",\"language\":\"" + JsonEscape(ocrDetectedLanguage) +
          L"\",\"engine\":\"" + JsonEscape(ocrEngine) +
          L"\",\"elapsedMs\":" + std::to_wstring(ocrElapsedMs) +
          L",\"text\":\"" + JsonEscape(ocrText) + L"\"" +
          L",\"lines\":[" + lines + L"]" +
          L",\"error\":\"" + JsonEscape(ocrError) + L"\"}");
      }).detach();
    }
  }
  else if (type == L"native-write-image-file") {
    // 把画布上的图片（data URL）落成磁盘里的真实 PNG，供外部程序使用（例如让 Hermes 读图）。
    // 与剪贴板写入不同：这里故意不删临时文件——Hermes 是异步读，删早了就没得读。
    const std::wstring writtenRequestId = JsonStringValue(message, L"requestId");
    const std::wstring writtenDataUrl = JsonStringValue(message, L"dataUrl");
    std::thread([writtenRequestId, writtenDataUrl]() {
      const std::filesystem::path written = CreateDragImageFile(writtenDataUrl);
      PostToCanvasAsync(L"{\"type\":\"native-image-file-written\",\"requestId\":\"" + JsonEscape(writtenRequestId) +
        L"\",\"ok\":" + std::wstring(written.empty() ? L"false" : L"true") +
        L",\"path\":\"" + JsonEscape(written.wstring()) + L"\"}");
    }).detach();
  }
  else if (type == L"native-read-image-dataurl") {
    const std::wstring requestId = JsonStringValue(message, L"requestId");
    const std::wstring dataUrl = ReadFileAsImageDataUrl(JsonStringValue(message, L"path"));
    PostToCanvasAsync(L"{\"type\":\"native-image-dataurl\",\"requestId\":\"" + JsonEscape(requestId) +
      L"\",\"dataUrl\":\"" + JsonEscape(dataUrl) + L"\"}");
  }
  else if (type == L"native-capture-canvas-mode") {
    g_captureToCanvas = JsonBoolValue(message, L"enabled", true);
    PersistClipboardHistory();
    PostClipboardHistory(JsonStringValue(message, L"requestId"));
  }
  else if (type == L"native-shelf-capture") HandleShelfCapture(message);
  else if (type == L"native-explorer-command") HandleExplorerCommand(message);
  else if (type == L"native-explorer-selection") HandleExplorerSelection(message);
  else if (type == L"native-explorer-open") HandleExplorerOpen(message);
  else if (type == L"native-explorer-rename") HandleExplorerRename(message);
  else if (type == L"native-explorer-context-menu") HandleExplorerContextMenu(message);
  else if (type == L"native-shell-context-menu") HandleShellContextMenu(message);
  else if (type == L"native-file-search") HandleFileSearch(message);
  else if (type == L"native-explorer-tree-request") HandleExplorerTreeRequest(message);
  else if (type == L"native-log-error") {
    WriteLifecycleLog((L"web: " + JsonStringValue(message, L"message")).c_str());
  }
  else if (type == L"native-log-pip-hook") {
    // 视频「右键 → 画中画」注入脚本的打点：每张网页卡每导航一次一行，
    // 用来确认脚本真的注进了那张卡（卡片内部是嵌套 WebView，外部读不到 DOM）。
    WriteLifecycleLog((L"pip-hook: " + JsonStringValue(message, L"note")).c_str());
  }
  else if (type == L"zzj-pip-state") {
    // app 页也能走同一套（转发带 surfaceId）；卡片页那条路不用带，宿主自己知道是谁报的。
    HandlePipStateFromCard(JsonStringValue(message, L"surfaceId"), JsonStringValue(message, L"state"));
  }
  else if (type == L"native-hermes-ask") HandleHermesAsk(message);
  else if (type == L"native-list-desktop-shortcuts") HandleListDesktopShortcuts(message);
  else if (type == L"native-launch-app") HandleLaunchApp(message);
  else if (type == L"native-run-tool") {
    const std::wstring tool = JsonStringValue(message, L"tool");
    if (tool.empty() || tool == L"screencapture") LaunchScreenCaptureTool();
  }
  else if (type == L"native-pick-executable-request") HandleAppPickExecutable(message);
  else if (type == L"native-app-resolve-request") HandleAppResolve(message);
  else if (type == L"native-explorer-metadata-request") HandleExplorerMetadataRequest(message);
  else if (type == L"native-explorer-metadata-cancel") HandleExplorerMetadataCancel(message);
  else if (type == L"native-thumbnail-preheat") HandleThumbnailPreheat(message);
  else if (type == L"native-thumbnail-preheat-cancel") ++g_thumbnailPreheatGeneration;
  else if (type == L"native-explorer-folder-sizes-request") HandleExplorerFolderSizesRequest(message);
  else if (type == L"native-explorer-media-root-request") HandleExplorerMediaRootRequest(message);
  else if (type == L"native-file-preview-request") HandleFilePreviewRequest(message);
  else if (type == L"native-file-preview-cancel") HandleFilePreviewCancel(message);
  else if (type == L"native-shell-preview-request") SendShellPreview(
    JsonStringValue(message, L"surfaceId"), JsonStringValue(message, L"path"));
  else if (type == L"native-shell-preview-location-request") HandleShellPreviewLocationRequest(message);
  else if (type == L"native-shell-preview-thumbnails-request") HandleShellPreviewThumbnailsRequest(message);
  else if (type == L"native-shell-preview-cancel") {
    ++g_shellPreviewGeneration;
    ++g_shellPreviewThumbnailGeneration;
    ++g_shellPreviewLocationGeneration;
    ClearShellPreviewResources();
  }
  else if (type == L"native-shell-icon-request") SendShellIcon(
    JsonStringValue(message, L"requestId"), JsonStringValue(message, L"path"),
    static_cast<int>(JsonDoubleValue(message, L"pixels", 48)));
  else if (type == L"native-drag-files") HandleDragFiles(message);
  else if (type == L"native-drag-image") HandleDragImage(message);
  else if (type == L"native-drag-arm-files") ArmNativeDrag(message, false);
  else if (type == L"native-drag-arm-image") ArmNativeDrag(message, true);
  else if (type == L"native-drag-image-data") HandleDragImageData(message);
  else if (type == L"native-drag-disarm") DisarmNativeDrag();
  else if (type == L"native-explorer-drop") HandleExplorerDrop(message);
  else if (type == L"native-collect-items") HandleCollectItems(message);
  else if (type == L"native-clipboard-request") SendClipboardFiles(JsonStringValue(message, L"requestId"));
  else if (type == L"native-open-path") OpenShellPath(JsonStringValue(message, L"path"));
  else if (type == L"native-ui-zoom") {
    // 界面字号：前端在设置里选了档位就发过来，整站等比缩放（含画布与面板）
    const double factor = JsonDoubleValue(message, L"factor", 1.0);
    if (g_appController) g_appController->put_ZoomFactor(std::max(0.8, std::min(1.6, factor)));
  }
  else if (type == L"native-open-manual") {
    // 打开安装目录里的使用手册（装机时随包安装）
    wchar_t exePath[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exePath, MAX_PATH);
    std::wstring dir(exePath);
    const size_t slash = dir.find_last_of(L"\\/");
    if (slash != std::wstring::npos) dir.resize(slash + 1);
    OpenShellPath(dir + L"使用手册.html");
  }
  else if (type == L"native-open-everything-download") ShellExecuteW(
    g_mainWindow, L"open", L"https://www.voidtools.com/downloads/", nullptr, nullptr, SW_SHOWNORMAL);
  else if (type == L"native-perf-reset") ResetSurfacePerfCounters();
  else if (type == L"native-perf-snapshot") SendSurfacePerfCounters();
  else if (type == L"native-interaction") SetSurfacesInert(JsonBoolValue(message, L"active"));
  else if (type == L"native-session-asset") {
    WriteRecoveryAsset(JsonStringValue(message, L"path"), JsonStringValue(message, L"dataUrl"));
  }
  else if (type == L"native-session-snapshot") {
    g_lastSessionJson = JsonStringValue(message, L"sessionJson");
    WriteSessionSnapshot(g_lastSessionJson, JsonBoolValue(message, L"dirty", true));
  }
  else if (type == L"native-session-discard") {
    g_restoreDecisionPending = false;
    const std::filesystem::path discardedRoot(g_pendingRestorePackageRoot);
    g_pendingRestoreProjectPath.clear();
    g_pendingRestorePackageRoot.clear();
    g_currentProjectPath.clear();
    SetCurrentPackageRoot({});
    if (IsImportedProjectRoot(discardedRoot)) RemoveTreeBestEffort(discardedRoot);
    AbandonSessionSnapshot();
    PostToCanvas(L"{\"type\":\"native-session-discarded\"}");
    if (!g_pendingIncomingPathAfterRestoreDecision.empty()) {
      const std::wstring pendingPath = std::move(g_pendingIncomingPathAfterRestoreDecision);
      g_pendingIncomingPathAfterRestoreDecision.clear();
      DispatchIncomingPath(pendingPath);
    }
  }
  else if (type == L"native-session-restore-request") {
    g_restoreDecisionPending = false;
    g_currentProjectPath = g_pendingRestoreProjectPath;
    SetCurrentPackageRoot(g_pendingRestorePackageRoot);
    g_pendingRestoreProjectPath.clear();
    g_pendingRestorePackageRoot.clear();
    PostToCanvas(L"{\"type\":\"native-session-restore-confirmed\",\"projectPath\":\"" +
      JsonEscape(g_currentProjectPath) + L"\",\"packageRoot\":\"" +
      JsonEscape(g_currentPackageRoot) + L"\"}");
    if (!g_pendingIncomingPathAfterRestoreDecision.empty()) {
      const std::wstring pendingPath = std::move(g_pendingIncomingPathAfterRestoreDecision);
      g_pendingIncomingPathAfterRestoreDecision.clear();
      DispatchIncomingPath(pendingPath);
    }
  }
  else if (type == L"native-template-list-request") SendTemplateList();
  else if (type == L"native-template-save") HandleTemplateSave(message);
  else if (type == L"native-template-apply") HandleTemplateApply(message);
  else if (type == L"native-template-delete") HandleTemplateDelete(message);
  else if (type == L"native-template-set-default") HandleTemplateSetDefault(message);
  else if (type == L"native-template-set-auto") HandleTemplateSetAuto(message);
  else if (type == L"native-template-rename") HandleTemplateRename(message);
  else if (type == L"native-project-save") HandleProjectSave(message);
  else if (type == L"native-project-overwrite-response") {
    const bool overwrite = JsonBoolValue(message, L"overwrite");
    const std::wstring pendingMessage = std::move(g_pendingOverwriteSaveMessage);
    const std::wstring pendingDestination = std::move(g_pendingOverwriteDestination);
    g_pendingOverwriteSaveMessage.clear();
    g_pendingOverwriteDestination.clear();
    g_overwritePromptOpen = false;
    g_projectSaveInProgress = false;
    if (overwrite && !pendingMessage.empty() && !pendingDestination.empty()) {
      g_confirmedSaveDestination = pendingDestination;
      HandleProjectSave(pendingMessage);
    } else if (!pendingMessage.empty()) {
      const std::wstring mode = JsonStringValue(pendingMessage, L"mode").empty() ? L"save" : JsonStringValue(pendingMessage, L"mode");
      const std::wstring requestId = JsonStringValue(pendingMessage, L"requestId");
      SendProjectOperationResult(L"native-project-save-result", false, true, mode, pendingDestination, {}, requestId);
      if (g_closeAfterSave && g_mainWindow) {
        g_closePromptOpen = true;
        SetTimer(g_mainWindow, kCloseRequestTimer, kCloseRequestTimeoutMs, nullptr);
      }
    }
  }
  else if (type == L"native-project-legacy-migration-response") {
    const std::wstring action = JsonStringValue(message, L"action");
    const std::wstring pendingMessage = std::move(g_pendingLegacyMigrationSaveMessage);
    g_pendingLegacyMigrationSaveMessage.clear();
    g_legacyMigrationPromptOpen = false;
    g_projectSaveInProgress = false;
    if ((action == L"convert" || action == L"saveAs") && !pendingMessage.empty()) {
      g_confirmLegacyMigration = action == L"convert";
      g_forceLegacySaveAs = action == L"saveAs";
      HandleProjectSave(pendingMessage);
    } else if (!pendingMessage.empty()) {
      const std::wstring mode = JsonStringValue(pendingMessage, L"mode").empty() ? L"save" : JsonStringValue(pendingMessage, L"mode");
      const std::wstring requestId = JsonStringValue(pendingMessage, L"requestId");
      SendProjectOperationResult(L"native-project-save-result", false, true, mode, g_currentProjectPath, {}, requestId);
      if (g_closeAfterSave && g_mainWindow) {
        g_closePromptOpen = true;
        SetTimer(g_mainWindow, kCloseRequestTimer, kCloseRequestTimeoutMs, nullptr);
      }
    }
  }
  else if (type == L"native-project-open") HandleProjectOpen(JsonStringValue(message, L"path"), false);
  else if (type == L"native-project-open-dialog") {
    const bool archive = JsonBoolValue(message, L"archive", false);
    const bool legacyDirectory = JsonBoolValue(message, L"legacyDirectory", false);
    HandleProjectOpen(PromptProjectOpenPath(archive, legacyDirectory), archive);
  }
  else if (type == L"canvas-ready") {
    g_canvasReady = true;
    PostToCanvas(L"{\"type\":\"native-ready\",\"capabilities\":[\"native-surfaces\",\"explorer-shell\",\"webview2-browser\"]}");
    SendPendingBrowserNotices();
    SendBrowserProfile();
    SendRecentProjects();
    // React 的开发/严格挂载以及 WebView 导航都可能重复发送 ready。启动参数和
    // 崩溃恢复快照只能投递一次，否则用户随后打开的第二个项目会被启动项目
    // 悄悄覆盖，保存时也会写回错误目录。
    if (!g_initialStateSent) {
      g_initialStateSent = true;
      const bool hasRecoverySnapshot = SendSessionSnapshotIfAvailable();
      std::wstring incomingPath = !g_pendingIncomingPathAfterRestoreDecision.empty()
        ? std::move(g_pendingIncomingPathAfterRestoreDecision)
        : std::move(g_startupProjectPath);
      g_pendingIncomingPathAfterRestoreDecision.clear();
      g_startupProjectPath.clear();
      if (hasRecoverySnapshot) g_pendingIncomingPathAfterRestoreDecision = std::move(incomingPath);
      else if (!incomingPath.empty()) DispatchIncomingPath(incomingPath);
    }
  }
  else if (type == L"native-overlay") {
    g_overlayActive = JsonBoolValue(message, L"active");
    if (g_overlayActive) UpdateSurfaceHover({});
    for (const auto& surface : g_surfaces) SyncSurfaceGeometry(surface);
  }
  else if (type == L"document-dirty") g_documentDirty = JsonBoolValue(message, L"dirty");
  else if (type == L"zzj-canvas-op-result") {
    const std::wstring opId = JsonStringValue(message, L"opId");
    if (!opId.empty()) {
      std::lock_guard<std::mutex> guard(g_canvasBridgeMutex);
      g_canvasBridgeResults[opId] = message;
    }
  }
  else if (type == L"native-close-response") {
    g_closePromptOpen = false;
    if (g_mainWindow) KillTimer(g_mainWindow, kCloseRequestTimer);
    const std::wstring action = JsonStringValue(message, L"action");
    WriteLifecycleLog((L"close action=" + action).c_str());
    if (action == L"prompting") {
      // 对话框已经显示出来了，接下来等用户决定，不再计时。
      if (g_mainWindow) KillTimer(g_mainWindow, kCloseRequestTimer);
      g_closePromptOpen = true;
      return;
    }
    if (action == L"save-unavailable") {
      // Another Web-side save already owns the request slot. Stop the watchdog
      // and return to the close confirmation instead of eventually treating the
      // failed save attempt as "don't save".
      g_closeAfterSave = false;
      g_closePromptOpen = true;
      return;
    }
    if (action == L"close") {
      AbandonSessionSnapshot();
      g_documentDirty = false;
      g_forceClose = true;
      if (g_mainWindow) PostMessageW(g_mainWindow, WM_CLOSE, 0, 0);
    } else if (action == L"save") {
      g_closeAfterSave = true;
      PostToCanvas(L"{\"type\":\"native-save-request\"}");
      if (g_mainWindow) SetTimer(g_mainWindow, kCloseRequestTimer, kCloseRequestTimeoutMs, nullptr);
      g_closePromptOpen = true;
    }
  }
  else if (type == L"native-save-started") {
    // Web 已收到保存请求；给大型图片编码和项目序列化留出独立时间窗口。
    // 真正的保存消息到达后 HandleProjectSave 会在打开原生对话框前停掉此计时器。
    if (g_closeAfterSave && g_mainWindow) {
      KillTimer(g_mainWindow, kCloseRequestTimer);
      SetTimer(g_mainWindow, kCloseRequestTimer, kSavePayloadTimeoutMs, nullptr);
    }
  }
}

void ResizeChildren() {
  if (!g_mainWindow) return;
  RECT client{};
  GetClientRect(g_mainWindow, &client);
  // A minimized top-level window reports an empty client area.  Sending that
  // transient 0x0 size into WebView2/DComp can leave their visuals black after
  // restore, so keep the last valid geometry until the window is visible again.
  if (IsIconic(g_mainWindow) || client.right <= client.left || client.bottom <= client.top) return;
  if (g_appController) g_appController->put_Bounds(client);
  if (g_compositionHost) SetWindowPos(g_compositionHost, HWND_TOP, 0, 0,
    client.right - client.left, client.bottom - client.top,
    SWP_NOACTIVATE |
    (!g_overlayActive ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
  for (const auto& surface : g_surfaces) SyncSurfaceGeometry(surface);
  UpdateCompositionHostRegion();
}

bool UsesBorderlessWindow() {
  return g_windowAppearance == L"borderless";
}

enum class TopEdgeZone { None, Resize, Toolbar, Corner };

void RefreshTopEdgeMetrics() {
  TopEdgeMetrics metrics;
  if (!g_mainWindow || !GetWindowRect(g_mainWindow, &metrics.windowBounds)) {
    g_topEdgeMetrics = metrics;
    return;
  }

  POINT clientOrigin{};
  if (!ClientToScreen(g_mainWindow, &clientOrigin)) {
    g_topEdgeMetrics = metrics;
    return;
  }
  const UINT dpi = std::max<UINT>(USER_DEFAULT_SCREEN_DPI, GetDpiForWindow(g_mainWindow));
  const int paddedBorder = GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
  // A frameless window has no visible system frame to aim at. Use a deliberate
  // touch target instead of SM_CXSIZEFRAME/SM_CYSIZEFRAME, while preserving the
  // DPI-aware padded-border allowance Windows adds around resize hit targets.
  metrics.frameX = MulDiv(14, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI) + paddedBorder;
  metrics.frameY = MulDiv(14, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI) + paddedBorder;
  metrics.cornerSize = MulDiv(20, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
  metrics.borderless = UsesBorderlessWindow();
  metrics.maximized = IsZoomed(g_mainWindow) != FALSE;
  metrics.top = metrics.borderless ? metrics.windowBounds.top : clientOrigin.y;
  metrics.resizeBottom = metrics.top +
    (metrics.borderless && !metrics.maximized ? MulDiv(4, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI) : 0);
  metrics.toolbarBottom = metrics.top + MulDiv(12, static_cast<int>(dpi), USER_DEFAULT_SCREEN_DPI);
  metrics.valid = true;
  g_topEdgeMetrics = metrics;
}

TopEdgeZone ClassifyTopEdgeZone(POINT screenPoint) {
  if (!g_mainWindow) return TopEdgeZone::None;
  if (!g_topEdgeMetrics.valid) RefreshTopEdgeMetrics();
  const auto& metrics = g_topEdgeMetrics;
  if (!metrics.valid || screenPoint.y < metrics.top || screenPoint.y >= metrics.toolbarBottom) {
    return TopEdgeZone::None;
  }

  if (metrics.borderless && !metrics.maximized) {
    if (screenPoint.x < metrics.windowBounds.left + metrics.cornerSize ||
        screenPoint.x >= metrics.windowBounds.right - metrics.cornerSize) {
      return TopEdgeZone::Corner;
    }
    if (screenPoint.y < metrics.resizeBottom) return TopEdgeZone::Resize;
  }
  return TopEdgeZone::Toolbar;
}

void UpdateToolbarHotZone(POINT screenPoint, bool forceLeave) {
  const bool active = !forceLeave && g_toolbarVisibility == L"auto" &&
    ClassifyTopEdgeZone(screenPoint) == TopEdgeZone::Toolbar;
  if (active == g_toolbarHotZoneActive) return;
  g_toolbarHotZoneActive = active;
  PostToCanvas(L"{\"type\":\"native-toolbar-hotzone\",\"inside\":" +
    std::wstring(active ? L"true" : L"false") + L"}");
}

void SendWindowState(bool force) {
  if (!g_mainWindow || !g_appWebView) return;
  const bool maximized = IsZoomed(g_mainWindow) != FALSE;
  if (!force && g_windowStateSent && maximized == g_lastWindowStateMaximized) return;
  g_windowStateSent = true;
  g_lastWindowStateMaximized = maximized;
  PostToCanvas(L"{\"type\":\"native-window-state\",\"maximized\":" +
    std::wstring(maximized ? L"true" : L"false") + L"}");
}

// ---- 材质层 v1：窗口云母（Mica / 亚克力）--------------------------------
// 用户可选「云母（半透明）」或「实色」。原生侧负责三件事：
//   1. 探测 DWM SYSTEMBACKDROP_TYPE（Win11 22621+）是否真的可用——写入后
//      读回验证，探测失败一律回退实色；
//   2. 按设置给主窗口开/关 Mica backdrop；
//   3. WebView2 默认背景：云母生效时透明，回退时用主题实色。
// 网页 CSS 只让「窗口底 / 画布面」半透明；卡片、菜单保持实底，层级不变。
struct ZzjOsVersionInfo {
  ULONG size;
  ULONG major;
  ULONG minor;
  ULONG build;
  ULONG platform;
  WCHAR csd[128];
};

DWORD WindowsBuildNumber() {
  static const DWORD cached = []() -> DWORD {
    using RtlGetVersionFn = LONG(WINAPI*)(ZzjOsVersionInfo*);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto rtlGetVersion = ntdll ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion")) : nullptr;
    if (!rtlGetVersion) return 0;
    ZzjOsVersionInfo info{};
    info.size = sizeof(info);
    if (rtlGetVersion(&info) != 0) return 0;
    return info.build;
  }();
  return cached;
}

bool WindowMaterialActive() {
  return g_windowMaterial == L"mica" && g_dwmBackdropSupported;
}

void SendWindowMaterialState() {
  PostToCanvas(L"{\"type\":\"native-window-material\",\"material\":\"" + JsonEscape(g_windowMaterial) +
    L"\",\"supported\":" + std::wstring(g_dwmBackdropSupported ? L"true" : L"false") + L"}");
}

void ApplyWebViewBackground() {
  if (!g_appController) return;
  ComPtr<ICoreWebView2Controller2> controller2;
  if (FAILED(g_appController.As(&controller2)) || !controller2) return;
  COREWEBVIEW2_COLOR color{0, 0, 0, 0};
  if (!WindowMaterialActive()) {
    // COREWEBVIEW2_COLOR = {A, R, G, B}；回退时用主题实色，避免窗口全透明。
    if (g_appThemeDark) color = {255, 9, 11, 14};
    else color = {255, 237, 240, 244};
  }
  controller2->put_DefaultBackgroundColor(color);
}

bool ProbeDwmBackdropSupport(HWND window) {
  if (g_dwmBackdropChecked) return g_dwmBackdropSupported;
  g_dwmBackdropChecked = true;
  if (!window) return false;
  if (WindowsBuildNumber() < 22621) return false;
  const int backdrop = 2;  // DWMSBT_MAINWINDOW（Mica）
  if (FAILED(DwmSetWindowAttribute(window, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, &backdrop, sizeof(backdrop)))) return false;
  int readback = -1;
  if (SUCCEEDED(DwmGetWindowAttribute(window, 38, &readback, sizeof(readback)))) {
    g_dwmBackdropSupported = readback == 2;
  } else {
    // 读回不被支持的老 DWM 直接用写入结果兜底。
    g_dwmBackdropSupported = true;
  }
  return g_dwmBackdropSupported;
}

void ApplyWindowMaterial(HWND window) {
  if (!window) return;
  const int backdrop = WindowMaterialActive() ? 2 : 1;  // 1 = DWMSBT_NONE
  DwmSetWindowAttribute(window, 38, &backdrop, sizeof(backdrop));
  ApplyWebViewBackground();
  SendWindowMaterialState();
  WriteLifecycleLog((L"material: request=" + g_windowMaterial + L" supported=" + (g_dwmBackdropSupported ? L"1" : L"0") +
    L" active=" + (WindowMaterialActive() ? L"1" : L"0")).c_str());
}
void ApplyDwmWindowFrame(HWND window, bool force = false) {
  if (!window) return;
  const bool borderless = UsesBorderlessWindow();
  const bool maximized = IsZoomed(window) != FALSE;
  if (!force && g_dwmFrameApplied &&
      borderless == g_lastDwmFrameBorderless &&
      maximized == g_lastDwmFrameMaximized) {
    return;
  }
  g_dwmFrameApplied = true;
  g_lastDwmFrameBorderless = borderless;
  g_lastDwmFrameMaximized = maximized;
  MARGINS margins{};
  if (borderless && !maximized) margins = {1, 1, 1, 1};
  DwmExtendFrameIntoClientArea(window, &margins);
  // DWMWA_WINDOW_CORNER_PREFERENCE (33) is ignored by older Windows builds.
  // Use numeric values so the binary still builds with older SDKs: 0=default,
  // 1=do not round, 2=round.
  const DWORD cornerPreference = borderless ? (maximized ? 1u : 2u) : 0u;
  DwmSetWindowAttribute(window, 33, &cornerPreference, sizeof(cornerPreference));
}

void ApplyWindowAppearance() {
  if (!g_mainWindow) return;
  SetWindowPos(g_mainWindow, nullptr, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  RefreshTopEdgeMetrics();
  ApplyDwmWindowFrame(g_mainWindow);
  ResizeChildren();
  SendWindowState();
}

LRESULT ClassifyBorderlessResizePoint(HWND window, POINT point) {
  if (!UsesBorderlessWindow() || IsZoomed(window)) return HTCLIENT;
  if (!g_topEdgeMetrics.valid) RefreshTopEdgeMetrics();
  const auto& metrics = g_topEdgeMetrics;
  if (!metrics.valid) return HTCLIENT;
  const RECT& bounds = metrics.windowBounds;
  const bool left = point.x < bounds.left + metrics.frameX;
  const bool right = point.x >= bounds.right - metrics.frameX;
  const bool cornerLeft = point.x < bounds.left + metrics.cornerSize;
  const bool cornerRight = point.x >= bounds.right - metrics.cornerSize;
  const bool topCorner = point.y < bounds.top + metrics.cornerSize;
  const bool bottomCorner = point.y >= bounds.bottom - metrics.cornerSize;
  const bool topResizeOnly = ClassifyTopEdgeZone(point) == TopEdgeZone::Resize;
  const bool bottom = point.y >= bounds.bottom - metrics.frameY;
  if (cornerLeft && topCorner) return HTTOPLEFT;
  if (cornerRight && topCorner) return HTTOPRIGHT;
  if (cornerLeft && bottomCorner) return HTBOTTOMLEFT;
  if (cornerRight && bottomCorner) return HTBOTTOMRIGHT;
  if (topResizeOnly) return HTTOP;
  if (bottom) return HTBOTTOM;
  if (left) return HTLEFT;
  if (right) return HTRIGHT;
  return HTCLIENT;
}

LRESULT HitTestBorderlessFrame(HWND window, LPARAM lParam) {
  return ClassifyBorderlessResizePoint(window,
    POINT{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)});
}

const wchar_t* WindowResizeHintName(LRESULT hit) {
  switch (hit) {
    case HTLEFT: return L"left";
    case HTRIGHT: return L"right";
    case HTTOP: return L"top";
    case HTBOTTOM: return L"bottom";
    case HTTOPLEFT: return L"top-left";
    case HTTOPRIGHT: return L"top-right";
    case HTBOTTOMLEFT: return L"bottom-left";
    case HTBOTTOMRIGHT: return L"bottom-right";
    default: return L"";
  }
}

void UpdateWindowResizeHint(POINT screenPoint, bool forceLeave = false) {
  const LRESULT hit = forceLeave ? HTCLIENT : ClassifyBorderlessResizePoint(g_mainWindow, screenPoint);
  if (hit == g_windowResizeHint) return;
  g_windowResizeHint = hit;
  PostToCanvas(L"{\"type\":\"native-window-resize-hint\",\"edge\":\"" +
    std::wstring(WindowResizeHintName(hit)) + L"\"}");
}

void InitializeBrowserWebViewEnvironment(bool withForceDarkArguments) {
  if (g_browserEnvironment || g_browserEnvironmentStarting) return;
  g_browserEnvironmentStarting = true;
  const std::wstring browserData = (std::filesystem::path(g_dataFolder) / L"BrowserWebView2").wstring();
  if (!g_browserProfileMigrationChecked) {
    g_browserProfileMigrationChecked = true;
    const std::filesystem::path oldProfile = std::filesystem::path(g_dataFolder) / L"WebView2";
    std::error_code profileError;
    const bool browserProfileExists = std::filesystem::exists(browserData, profileError);
    profileError.clear();
    const bool oldProfileExists = std::filesystem::exists(oldProfile, profileError);
    profileError.clear();
    const bool noticeWasShown = std::filesystem::exists(BrowserProfileMigrationNoticePath(), profileError);
    g_browserProfileMigrationNoticePending = !browserProfileExists && oldProfileExists && !noticeWasShown;
  }
  std::error_code folderError;
  std::filesystem::create_directories(browserData, folderError);
  ComPtr<CoreWebView2EnvironmentOptions> options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
  if (options) {
    std::wstring browserArguments;
    if (withForceDarkArguments) {
      browserArguments =
        L"--enable-features=WebContentsForceDark:inversion_method/cielab_based/"
        L"image_behavior/selective/foreground_lightness_threshold/150/"
        L"background_lightness_threshold/205";
    } else {
      // The distinct user-data folder separates this environment from the app WebView.
      // Explicitly disabling ForceDark only guarantees the requested non-forced behavior.
      browserArguments = L"--disable-features=WebContentsForceDark";
    }
    options->put_AdditionalBrowserArguments(browserArguments.c_str());
  }
  const auto completed = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
    [withForceDarkArguments](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
      g_browserEnvironmentStarting = false;
      if (FAILED(result) || !environment) {
        if (withForceDarkArguments) {
          InitializeBrowserWebViewEnvironment(false);
        } else {
          g_browserEnvironmentFallbackPending = true;
          ActivateBrowserEnvironmentFallback();
        }
        return result;
      }
      g_browserEnvironment = environment;
      g_browserEnvironmentHasForceDark = withForceDarkArguments;
      g_browserEnvironmentDegraded = g_webThemeMode == L"dark" && !withForceDarkArguments;
      for (const auto& surface : g_surfaces) {
        if (surface && surface->kind == L"browser") CreateBrowserSurface(surface);
      }
      SendWebThemeSetting(false);
      SendPendingBrowserNotices();
      return S_OK;
    });
  const HRESULT startResult = CreateCoreWebView2EnvironmentWithOptions(
    nullptr, browserData.c_str(), options.Get(), completed.Get());
  if (FAILED(startResult)) {
    g_browserEnvironmentStarting = false;
    if (withForceDarkArguments) {
      InitializeBrowserWebViewEnvironment(false);
    } else {
      g_browserEnvironmentFallbackPending = true;
      ActivateBrowserEnvironmentFallback();
    }
  }
}

void InitializeWebView() {
  std::wstring userData = g_dataFolder.empty() ? g_appFolder + L"\\UserData" : (std::filesystem::path(g_dataFolder) / L"WebView2").wstring();
  std::error_code folderError;
  std::filesystem::create_directories(userData, folderError);
  // Start both independent environments before either creates a controller.
  // Current WebView2 runtimes can leave a second environment request pending if
  // it is first issued after the application controller already exists.
  InitializeBrowserWebViewEnvironment(g_webThemeMode == L"dark");
  CreateCoreWebView2EnvironmentWithOptions(nullptr, userData.c_str(), nullptr,
    Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
      [](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
        if (FAILED(result) || !environment) {
          MessageBoxW(g_mainWindow, L"WebView2 Runtime 不可用。", L"掌中界", MB_OK | MB_ICONERROR);
          return result;
        }
        g_environment = environment;
        ActivateBrowserEnvironmentFallback();
        return environment->CreateCoreWebView2Controller(g_mainWindow,
          Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [](HRESULT controllerResult, ICoreWebView2Controller* controller) -> HRESULT {
              if (FAILED(controllerResult) || !controller) return controllerResult;
              g_appController = controller;
              ApplyWebViewBackground();
              // The application WebView covers the host client area. If Chromium keeps its own
              // external-drop target enabled, it consumes the Shell IDataObject before the host's
              // ShellCanvasDropTarget can read CF_HDROP. Route external drops to the native host.
              ComPtr<ICoreWebView2Controller4> controller4;
              if (SUCCEEDED(g_appController.As(&controller4)) && controller4) {
                controller4->put_AllowExternalDrop(FALSE);
              }
              controller->get_CoreWebView2(&g_appWebView);
              AttachProcessFailedCapture(g_appWebView.Get(), L"app");
              ComPtr<ICoreWebView2Settings> settings;
              if (SUCCEEDED(g_appWebView->get_Settings(&settings))) {
                settings->put_IsStatusBarEnabled(FALSE);
                settings->put_AreDefaultContextMenusEnabled(FALSE);
                settings->put_AreDevToolsEnabled(TRUE);
              }
              ComPtr<ICoreWebView2_3> webView3;
              if (SUCCEEDED(g_appWebView.As(&webView3))) {
                const std::wstring webFolder = g_appFolder + L"\\web";
                webView3->SetVirtualHostNameToFolderMapping(L"app.zhangzhongjie.local", webFolder.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
              }
              g_appWebView->AddWebResourceRequestedFilter(
                L"https://media-*.zhangzhongjie.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
              EventRegistrationToken mediaResourceToken{};
              g_appWebView->add_WebResourceRequested(
                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                  [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    return HandleMediaWebResourceRequest(args, g_environment.Get());
                  }).Get(), &mediaResourceToken);
              g_appWebView->AddWebResourceRequestedFilter(
                L"https://thumb-*.zhangzhongjie.local/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
              EventRegistrationToken thumbnailResourceToken{};
              g_appWebView->add_WebResourceRequested(
                Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                  [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    return HandleThumbnailWebResourceRequest(args, g_environment.Get());
                  }).Get(), &thumbnailResourceToken);
              EventRegistrationToken messageToken{};
              g_appWebView->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                  HandleWebMessage(args);
                  return S_OK;
                }).Get(), &messageToken);
              EventRegistrationToken navigationToken{};
              g_appWebView->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
                  // Windowed WebView2 owns the HWND under the pointer. Register the Shell drop
                  // target on that renderer HWND after navigation, not only on its parent host.
                  RegisterCanvasDropTarget(FindCanvasRendererWindow());
                  SendWebThemeSetting(false);
                  return S_OK;
                }).Get(), &navigationToken);
              ResizeChildren();
              g_appWebView->Navigate(L"https://app.zhangzhongjie.local/index.html");
              return S_OK;
            }).Get());
      }).Get());
}

LRESULT CALLBACK SurfaceHostProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  auto* surface = reinterpret_cast<NativeSurface*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
    surface = reinterpret_cast<NativeSurface*>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(surface));
  }
  switch (message) {
    case WM_CAPTURECHANGED:
      if (g_canvasPanCaptureWindow == window) EndCanvasPanCapture();
      break;
    case WM_MOUSEMOVE: {
      if (surface) UpdateSurfaceHover(surface->id);
      TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, window, 0};
      TrackMouseEvent(&track);
      break;
    }
    case WM_MOUSELEAVE:
      UpdateToolbarHotZone({}, true);
      UpdateWindowResizeHint({}, true);
      break;
    case WM_SIZE:
      // A child host can also receive an empty WM_SIZE while its top-level
      // owner is minimized.  Do not collapse the Explorer semantic/view state
      // to an empty rectangle; the main window restore path reapplies geometry.
      if (wParam == SIZE_MINIMIZED) return 0;
      if (surface && surface->explorer) {
        RECT client{};
        GetClientRect(window, &client);
        if (client.right <= client.left || client.bottom <= client.top) return 0;
        surface->explorer->SetRect(nullptr, client);
        ApplyDarkExplorerTheme(window);
      }
      return 0;
    case WM_SETFOCUS:
      if (surface) PostSurfaceFocus(surface->id);
      return 0;
    case WM_TIMER:
      KillTimer(window, 1);
      ApplyDarkExplorerTheme(window);
      if (surface) ApplyExplorerVisualProperties(FindSurface(surface->id));
      return 0;
    case WM_ERASEBKGND:
      return 1;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

std::shared_ptr<NativeSurface> HitTestCompositionSurface(POINT point) {
  // React overlays (modal dialogs, context menus and ratio pickers) belong to the
  // app WebView.  A hidden composition visual must never remain an input target:
  // otherwise the transparent host eats the click and forwards it to the page
  // behind the dialog.  Keep visual visibility and input hit-testing governed by
  // the same switch.
  if (g_overlayActive || g_compositionInputDisabled) return nullptr;
  std::shared_ptr<NativeSurface> result;
  for (const auto& surface : g_surfaces) {
    if (!surface || !surface->compositionController || !surface->visible || surface->snapshotMode) continue;
    if (!PtInRect(&surface->bounds, point)) continue;
    if (surface->hasClip && !PtInRect(&surface->clip, point)) continue;
    if (!result || surface->order >= result->order) result = surface;
  }
  return result;
}

COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS CompositionMouseKeys(WPARAM wParam) {
  UINT keys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE;
  if (wParam & MK_LBUTTON) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON;
  if (wParam & MK_RBUTTON) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON;
  if (wParam & MK_SHIFT) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT;
  if (wParam & MK_CONTROL) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL;
  if (wParam & MK_MBUTTON) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON;
  if (wParam & MK_XBUTTON1) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON1;
  if (wParam & MK_XBUTTON2) keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON2;
  return static_cast<COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS>(keys);
}

bool CompositionMouseKind(UINT message, COREWEBVIEW2_MOUSE_EVENT_KIND& kind) {
  switch (message) {
    case WM_MOUSEMOVE: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE; return true;
    case WM_LBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN; return true;
    case WM_LBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP; return true;
    case WM_LBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK; return true;
    case WM_RBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN; return true;
    case WM_RBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP; return true;
    case WM_RBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK; return true;
    case WM_MBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN; return true;
    case WM_MBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP; return true;
    case WM_MBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK; return true;
    case WM_XBUTTONDOWN: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN; return true;
    case WM_XBUTTONUP: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP; return true;
    case WM_XBUTTONDBLCLK: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOUBLE_CLICK; return true;
    case WM_MOUSEWHEEL: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL; return true;
    case WM_MOUSEHWHEEL: kind = COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL; return true;
    default: return false;
  }
}

std::wstring SafeProjectName(std::wstring name) {
  if (name.empty()) name = L"未命名项目";
  for (auto& ch : name) if (ch < 32 || wcschr(L"<>:\"/\\|?*", ch)) ch = L'_';
  while (!name.empty() && (name.back() == L'.' || name.back() == L' ')) name.pop_back();
  if (name.empty()) name = L"未命名项目";

  // Windows reserves device names even when they have an extension (for example
  // CON.zzj). The Shell save dialog used to enforce this for us; the project name
  // edit box is now custom, so keep the same filesystem safety here.
  std::wstring stem = name.substr(0, name.find(L'.'));
  while (!stem.empty() && (stem.back() == L'.' || stem.back() == L' ')) stem.pop_back();
  std::transform(stem.begin(), stem.end(), stem.begin(), [](wchar_t ch) { return static_cast<wchar_t>(towupper(ch)); });
  const bool numberedDevice = stem.size() == 4 &&
    ((stem.rfind(L"COM", 0) == 0) || (stem.rfind(L"LPT", 0) == 0)) &&
    stem[3] >= L'1' && stem[3] <= L'9';
  if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" ||
      stem == L"CONIN$" || stem == L"CONOUT$" || numberedDevice) {
    name.insert(name.begin(), L'_');
  }

  // Leave room for the .zzj suffix and temporary names while keeping the visible
  // project name useful. Avoid cutting a UTF-16 surrogate pair in half.
  constexpr size_t kMaxProjectNameLength = 80;
  if (name.size() > kMaxProjectNameLength) {
    name.resize(kMaxProjectNameLength);
    if (!name.empty() && name.back() >= 0xD800 && name.back() <= 0xDBFF) name.pop_back();
    while (!name.empty() && (name.back() == L'.' || name.back() == L' ')) name.pop_back();
  }
  return name.empty() ? L"未命名项目" : name;
}

ProjectSavePathResult PromptProjectSavePath(const std::wstring& title, bool archive) {
  // The Shell save dialog collects both the project name and the final single-file destination.
  if (!archive) {
    ComPtr<IFileSaveDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&dialog))) || !dialog) {
      return {{}, false, L"无法打开项目保存对话框"};
    }
    const COMDLG_FILTERSPEC filters[] = {
      {L"掌中界项目 (*.zzj)", L"*.zzj"},
      {L"所有文件 (*.*)", L"*.*"},
    };
    if (FAILED(dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters)) ||
        FAILED(dialog->SetDefaultExtension(L"zzj")) ||
        FAILED(dialog->SetTitle(L"保存掌中界项目"))) {
      return {{}, false, L"无法设置项目保存对话框"};
    }
    const std::wstring defaultName = SafeProjectName(title) + L".zzj";
    if (FAILED(dialog->SetFileName(defaultName.c_str()))) return {{}, false, L"无法设置默认项目名称"};
    FILEOPENDIALOGOPTIONS options{};
    if (FAILED(dialog->GetOptions(&options))) return {{}, false, L"无法读取项目保存对话框设置"};
    if (FAILED(dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOVALIDATE))) {
      return {{}, false, L"无法设置项目保存对话框"};
    }

    g_nativeDialogOpen = true;
    const HRESULT result = dialog->Show(g_mainWindow);
    g_nativeDialogOpen = false;
    if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {{}, true, {}};
    if (FAILED(result)) return {{}, false, L"项目保存对话框未能完成"};

    ComPtr<IShellItem> item;
    if (FAILED(dialog->GetResult(&item)) || !item) return {{}, false, L"无法读取项目保存位置"};
    PWSTR path = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) || !path) return {{}, false, L"所选位置不是可用的文件系统路径"};
    std::filesystem::path destination(path);
    CoTaskMemFree(path);
    if (_wcsicmp(destination.extension().c_str(), L".zzj") != 0) destination += L".zzj";

    const std::wstring projectName = destination.stem().wstring();
    if (projectName.empty()) return {{}, false, L"请输入项目名称"};
    if (projectName.size() > 80) return {{}, false, L"项目名称不能超过 80 个字符，请缩短后重试"};
    if (SafeProjectName(projectName) != projectName) {
      return {{}, false, L"项目名称包含 Windows 不允许的字符、保留名称或尾部空格，请修改后重试"};
    }

    const std::filesystem::path parent = destination.parent_path();
    std::error_code projectMarkerError;
    const bool parentIsProject = std::filesystem::exists(parent / L"project.json", projectMarkerError);
    if (projectMarkerError) return {{}, false, L"无法检查所选文件夹是否为已有掌中界项目"};
    if (parentIsProject) return {{}, false, L"不能把已有掌中界项目作为父文件夹，请选择它的上一级目录"};

    // Although newer Windows versions can opt into long paths, the project also
    // creates nested assets and temporary files. Reject an unsafe root early with
    // an actionable message instead of failing halfway through a save.
    if (destination.wstring().size() >= 240) {
      return {{}, false, L"保存路径过长，请选择更靠近磁盘根目录的文件夹或缩短项目名称"};
    }
    return {destination.wstring(), false, {}};
  }

  ComPtr<IFileSaveDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) || !dialog) {
    return {{}, false, L"无法打开项目包导出对话框"};
  }
  const COMDLG_FILTERSPEC filters[] = {
    {L"掌中界导出包 (*.zzjx)", L"*.zzjx"},
    {L"所有文件 (*.*)", L"*.*"},
  };
  dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
  dialog->SetDefaultExtension(L"zzjx");
  dialog->SetTitle(L"导出掌中界项目包");
  const std::wstring filename = SafeProjectName(title) + L".zzjx";
  dialog->SetFileName(filename.c_str());
  FILEOPENDIALOGOPTIONS options{};
  if (SUCCEEDED(dialog->GetOptions(&options))) dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOVALIDATE);
  g_nativeDialogOpen = true;
  const HRESULT result = dialog->Show(g_mainWindow);
  g_nativeDialogOpen = false;
  if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {{}, true, {}};
  if (FAILED(result)) return {{}, false, L"项目包导出对话框未能完成"};
  ComPtr<IShellItem> item;
  if (FAILED(dialog->GetResult(&item)) || !item) return {{}, false, L"无法读取项目包导出位置"};
  PWSTR path = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) || !path) return {{}, false, L"所选位置不是可用的文件系统路径"};
  std::wstring selected(path);
  CoTaskMemFree(path);
  if (_wcsicmp(std::filesystem::path(selected).extension().c_str(), L".zzjx") != 0) selected += L".zzjx";
  return {selected, false, {}};
}

std::wstring PromptProjectOpenPath(bool archive, bool legacyDirectory) {
  ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))) || !dialog) return {};
  FILEOPENDIALOGOPTIONS options{};
  if (FAILED(dialog->GetOptions(&options))) return {};
  if (legacyDirectory) {
    dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"选择旧版 .zzj 项目文件夹");
  } else if (archive) {
    const COMDLG_FILTERSPEC filters[] = {{L"掌中界导出包 (*.zzjx)", L"*.zzjx"}, {L"所有文件 (*.*)", L"*.*"}};
    dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
    dialog->SetDefaultExtension(L"zzjx");
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"导入掌中界项目包");
  } else {
    const COMDLG_FILTERSPEC filters[] = {{L"掌中界项目 (*.zzj)", L"*.zzj"}, {L"所有文件 (*.*)", L"*.*"}};
    dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
    dialog->SetDefaultExtension(L"zzj");
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST);
    dialog->SetTitle(L"打开掌中界项目");
  }
  g_nativeDialogOpen = true;
  const HRESULT result = dialog->Show(g_mainWindow);
  g_nativeDialogOpen = false;
  if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED) || FAILED(result)) return {};
  ComPtr<IShellItem> item;
  if (FAILED(dialog->GetResult(&item)) || !item) return {};
  PWSTR path = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) || !path) return {};
  std::wstring selected(path);
  CoTaskMemFree(path);
  return selected;
}

void SendProjectOperationResult(const wchar_t* type, bool success, bool cancelled,
                                const std::wstring& mode, const std::wstring& path,
                                const std::wstring& error, const std::wstring& requestId,
                                const std::wstring& packageRoot,
                                const std::wstring& migratedFrom) {
  PostToCanvas(L"{\"type\":\"" + std::wstring(type) + L"\",\"success\":" +
    std::wstring(success ? L"true" : L"false") + L",\"cancelled\":" +
    std::wstring(cancelled ? L"true" : L"false") + L",\"mode\":\"" + JsonEscape(mode) +
    L"\",\"projectPath\":\"" + JsonEscape(path) + L"\",\"error\":\"" + JsonEscape(error) +
    L"\",\"requestId\":\"" + JsonEscape(requestId) + L"\",\"packageRoot\":\"" +
    JsonEscape(packageRoot) + L"\",\"migratedFrom\":\"" + JsonEscape(migratedFrom) + L"\"}");
}

void FinishSuccessfulProjectSave(const std::wstring& mode, const std::wstring& path,
                                 const std::wstring& requestId,
                                 const std::wstring& packageRoot = {},
                                 const std::wstring& migratedFrom = {}) {
  g_projectSaveInProgress = false;
  if (mode != L"export") {
    g_currentProjectPath = path;
    g_documentDirty = false;
    RememberRecentProject(path);
    if (!g_lastSessionJson.empty()) WriteSessionSnapshot(g_lastSessionJson, false);
  }
  SendProjectOperationResult(L"native-project-save-result", true, false, mode, path, {}, requestId,
    packageRoot, migratedFrom);
  SendRecentProjects();
  if (g_closeAfterSave && mode != L"export") {
    g_closeAfterSave = false;
    g_closePromptOpen = false;
    if (g_mainWindow) KillTimer(g_mainWindow, kCloseRequestTimer);
    g_forceClose = true;
    if (g_mainWindow) PostMessageW(g_mainWindow, WM_CLOSE, 0, 0);
  }
}


// ---------- 画布模板：Templates 文件夹里的 .zzj（用户 2026-09-14 的新方向） ----------
// 模板 = 一个普通项目包；「套用」时按“未命名文档”打开（SendOpenedProjectPackage 的 editableProject=false），
// 这样用户套完模板按 Ctrl+S 会走「另存为」，不会把模板本身覆盖掉。
std::wstring TemplatesFolder() {
  return (std::filesystem::path(g_dataFolder) / L"Templates").wstring();
}

std::wstring TemplateDefaultRecordPath() {
  return (std::filesystem::path(TemplatesFolder()) / L".default.txt").wstring();
}

// 开机是否自动套用默认模板（存在这个文件就是开）
std::wstring TemplateAutoApplyRecordPath() {
  return (std::filesystem::path(TemplatesFolder()) / L".autoapply.txt").wstring();
}

// 模板名要当文件名用：去掉路径分隔符和 Windows 非法字符，限 40 字。
std::wstring SafeTemplateName(const std::wstring& raw) {
  std::wstring name;
  for (const wchar_t ch : raw) {
    if (ch == L'\\' || ch == L'/' || ch == L':' || ch == L'*' || ch == L'?' || ch == L'"' ||
        ch == L'<' || ch == L'>' || ch == L'|' || ch < 0x20) continue;
    name.push_back(ch);
  }
  while (!name.empty() && (name.front() == L' ' || name.front() == L'.')) name.erase(name.begin());
  while (!name.empty() && (name.back() == L' ' || name.back() == L'.')) name.pop_back();
  if (name.size() > 40) name.resize(40);
  if (name.empty()) name = L"未命名模板";
  return name;
}

bool IsInsideTemplates(const std::filesystem::path& path) {
  if (path.extension() != L".zzj") return false;
  std::error_code ignored;
  const auto folder = std::filesystem::weakly_canonical(std::filesystem::path(TemplatesFolder()), ignored);
  const auto target = std::filesystem::weakly_canonical(path, ignored);
  if (folder.empty() || target.empty()) return false;
  const std::wstring f = folder.wstring();
  const std::wstring t = target.wstring();
  return t.size() > f.size() + 1 && _wcsnicmp(t.c_str(), f.c_str(), f.size()) == 0;
}

std::wstring ReadTemplateDefault() {
  std::wstring value;
  if (!ReadUtf8File(TemplateDefaultRecordPath(), value)) return {};
  while (!value.empty() && (value.back() == L'\r' || value.back() == L'\n' || value.back() == L' ')) value.pop_back();
  return value;
}

// 模板缩略图的「骨架」：从 .zzj 里只读 project.json（不解整包、不写临时目录），
// 取出每张卡片的位置/尺寸/类型，让模板库能画出一张小地图（用户 2026-09-14 要的「真实缩略图」）。
std::wstring BuildTemplateLayoutJson(const std::filesystem::path& archive, size_t& cardCount) {
  cardCount = 0;
  std::vector<unsigned char> bytes;
  std::wstring error;
  if (!ValidateProjectArchiveReadOnly(archive, bytes, error) || bytes.empty()) return L"[]";
  const std::wstring json = Utf8ToWide(std::string(bytes.begin(), bytes.end()));
  size_t at = 0;
  const JsonValue root = ParseJsonValue(json, at);
  const JsonValue* session = root.Member(L"session");
  const JsonValue* items = session ? session->Member(L"items") : nullptr;
  if (!items || items->kind != JsonValue::Kind::Array) return L"[]";
  const auto number = [](const JsonValue* value) {
    return std::to_wstring(static_cast<long long>(_wtof(value ? value->text.c_str() : L"0")));
  };
  std::wstring layout;
  size_t emitted = 0;
  for (const auto& item : items->items) {
    if (item.kind != JsonValue::Kind::Object) continue;
    const JsonValue* kind = item.Member(L"kind");
    const JsonValue* x = item.Member(L"x");
    const JsonValue* y = item.Member(L"y");
    const JsonValue* w = item.Member(L"w");
    const JsonValue* h = item.Member(L"h");
    if (!kind || !x || !y || !w || !h) continue;
    // 子画布和裸图标不进缩略图（它们要么被裁掉、要么太小看不出东西）
    if (kind->text == L"workspace" || kind->text == L"icon") continue;
    ++cardCount;
    if (emitted >= 40) continue;  // 缩略图只画前 40 张，够看出布局了
    if (emitted) layout += L",";
    layout += L"{\"k\":\"" + JsonEscape(kind->text) + L"\",\"x\":" + number(x) +
      L",\"y\":" + number(y) + L",\"w\":" + number(w) + L",\"h\":" + number(h) + L"}";
    ++emitted;
  }
  return layout;
}

void SendTemplateList() {
  std::error_code ignored;
  const std::filesystem::path folder = TemplatesFolder();
  std::filesystem::create_directories(folder, ignored);
  std::wstring items;
  size_t count = 0;
  std::vector<std::filesystem::directory_entry> entries;
  for (const auto& entry : std::filesystem::directory_iterator(folder, ignored)) {
    if (entry.is_regular_file(ignored) && _wcsicmp(entry.path().extension().c_str(), L".zzj") == 0) entries.push_back(entry);
  }
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    std::error_code e1, e2;
    return std::filesystem::last_write_time(left, e1) > std::filesystem::last_write_time(right, e2);
  });
  for (const auto& entry : entries) {
    if (count) items += L",";
    std::error_code sizeError;
    const auto bytes = std::filesystem::file_size(entry.path(), sizeError);
    const std::wstring name = entry.path().stem().wstring();
    size_t cardCount = 0;
    const std::wstring layout = BuildTemplateLayoutJson(entry.path(), cardCount);
    // 封面 = 模板包旁边那张同名 .png；有就把绝对路径回给前端（前端自己转 data URL 当 <img src>）
    const std::filesystem::path coverFile = std::filesystem::path(folder) / (name + L".png");
    std::error_code coverError;
    const bool hasCover = std::filesystem::exists(coverFile, coverError) && !coverError;
    items += L"{\"name\":\"" + JsonEscape(name) + L"\",\"path\":\"" + JsonEscape(entry.path().wstring()) +
      L"\",\"size\":" + std::to_wstring(sizeError ? 0 : bytes) +
      L",\"cards\":" + std::to_wstring(cardCount) + L",\"layout\":[" + layout + L"]" +
      L",\"thumb\":\"" + JsonEscape(hasCover ? coverFile.wstring() : std::wstring()) + L"\"}";
    count += 1;
  }
  const bool autoApply = std::filesystem::exists(TemplateAutoApplyRecordPath());
  PostToCanvas(L"{\"type\":\"native-template-list\",\"folder\":\"" + JsonEscape(TemplatesFolder()) +
    L"\",\"default\":\"" + JsonEscape(ReadTemplateDefault()) + L"\",\"autoApply\":" +
    std::wstring(autoApply ? L"true" : L"false") + L",\"items\":[" + items + L"]}");
}

void HandleTemplateSave(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring name = SafeTemplateName(JsonStringValue(message, L"name"));
  const std::wstring projectJson = JsonStringValue(message, L"projectJson");
  const auto fail = [&](const std::wstring& error) {
    PostToCanvas(L"{\"type\":\"native-template-save-result\",\"success\":false,\"requestId\":\"" + JsonEscape(requestId) +
      L"\",\"error\":\"" + JsonEscape(error) + L"\"}");
  };
  if (projectJson.empty()) { fail(L"当前画布状态为空"); return; }
  std::error_code ignored;
  std::filesystem::create_directories(TemplatesFolder(), ignored);
  const std::filesystem::path destination = std::filesystem::path(TemplatesFolder()) / (name + L".zzj");
  size_t at = 0;
  const JsonValue root = ParseJsonValue(message, at);
  std::wstring error;
  if (!WriteProjectArchive(destination, projectJson, root.Member(L"assets"), root.Member(L"externals"), error)) {
    fail(error.empty() ? L"写入模板失败" : error);
    return;
  }
  // 封面：抓一张画布图放在模板包旁边（Templates\<名字>.png）。故意不写进 zip ——
  // SendTemplateList 只遍历 *.zzj，旁边放个同名 .png 不会污染列表，前端也不用解包。
  // 旧封面先扔掉：这次抓不到就别拿旧图冒充新封面（前端会回退到迷你示意图）。
  const std::filesystem::path coverPath = std::filesystem::path(TemplatesFolder()) / (name + L".png");
  std::filesystem::remove(coverPath, ignored);
  if (JsonBoolValue(message, L"thumbnail", true)) WriteTemplateThumbnailPng(coverPath.wstring());
  PostToCanvas(L"{\"type\":\"native-template-save-result\",\"success\":true,\"requestId\":\"" + JsonEscape(requestId) +
    L"\",\"name\":\"" + JsonEscape(name) + L"\",\"path\":\"" + JsonEscape(destination.wstring()) + L"\"}");
  SendTemplateList();
}

void HandleTemplateApply(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring path = JsonStringValue(message, L"path");
  const auto fail = [&](const std::wstring& error) {
    PostToCanvas(L"{\"type\":\"native-template-apply-result\",\"success\":false,\"requestId\":\"" + JsonEscape(requestId) +
      L"\",\"error\":\"" + JsonEscape(error) + L"\"}");
  };
  if (!IsInsideTemplates(path)) { fail(L"模板路径不在模板文件夹里"); return; }
  std::filesystem::path projectRoot;
  std::wstring error;
  if (!ExtractProjectArchive(path, projectRoot, error)) { fail(error.empty() ? L"解不开这个模板" : error); return; }
  // editableProject = false：套用后是「未命名文档」，Ctrl+S 会问另存为，不会覆盖模板
  if (!SendOpenedProjectPackage(projectRoot, path, false, &error)) { fail(error.empty() ? L"读取模板内容失败" : error); return; }
  g_documentDirty = true;
  PostToCanvas(L"{\"type\":\"native-template-apply-result\",\"success\":true,\"requestId\":\"" + JsonEscape(requestId) +
    L"\",\"path\":\"" + JsonEscape(path) + L"\"}");
  SendTemplateList();
}

void HandleTemplateDelete(const std::wstring& message) {
  const std::wstring path = JsonStringValue(message, L"path");
  std::error_code ignored;
  bool ok = false;
  if (IsInsideTemplates(path)) {
    std::filesystem::remove(path, ignored);
    ok = !ignored;
    // 封面（同名 .png）跟着一起删，别留孤儿图
    std::error_code coverError;
    std::filesystem::path cover(path);
    cover.replace_extension(L".png");
    std::filesystem::remove(cover, coverError);
    if (ok && ReadTemplateDefault() == std::filesystem::path(path).stem().wstring()) {
      std::filesystem::remove(TemplateDefaultRecordPath(), ignored);
    }
  }
  PostToCanvas(L"{\"type\":\"native-template-delete-result\",\"success\":" + std::wstring(ok ? L"true" : L"false") + L"}");
  SendTemplateList();
}

void HandleTemplateSetDefault(const std::wstring& message) {
  const std::wstring name = JsonStringValue(message, L"name");
  std::error_code ignored;
  std::filesystem::create_directories(TemplatesFolder(), ignored);
  if (name.empty()) {
    std::filesystem::remove(TemplateDefaultRecordPath(), ignored);
  } else {
    WriteUtf8FileAtomic(TemplateDefaultRecordPath(), name);
  }
  SendTemplateList();
  PostToCanvas(L"{\"type\":\"native-template-default-set\",\"name\":\"" + JsonEscape(name) + L"\"}");
}

void HandleTemplateSetAuto(const std::wstring& message) {
  const bool on = JsonBoolValue(message, L"on", false);
  std::error_code ignored;
  std::filesystem::create_directories(TemplatesFolder(), ignored);
  if (on) {
    WriteUtf8FileAtomic(TemplateAutoApplyRecordPath(), std::wstring(L"1"));
  } else {
    std::filesystem::remove(TemplateAutoApplyRecordPath(), ignored);
  }
  SendTemplateList();
  PostToCanvas(L"{\"type\":\"native-template-auto-set\",\"on\":" + std::wstring(on ? L"true" : L"false") + L"}");
}

void HandleTemplateRename(const std::wstring& message) {
  const std::wstring path = JsonStringValue(message, L"path");
  const std::wstring rawName = JsonStringValue(message, L"name");
  const auto fail = [&](const std::wstring& error) {
    PostToCanvas(L"{\"type\":\"native-template-rename-result\",\"success\":false,\"error\":\"" + JsonEscape(error) + L"\"}");
  };
  if (!IsInsideTemplates(path)) { fail(L"模板路径不在模板文件夹里"); return; }
  const std::wstring name = SafeTemplateName(rawName);
  const std::filesystem::path oldPath(path);
  const std::filesystem::path newPath = std::filesystem::path(TemplatesFolder()) / (name + L".zzj");
  if (oldPath == newPath) { SendTemplateList(); PostToCanvas(L"{\"type\":\"native-template-rename-result\",\"success\":true}"); return; }
  std::error_code existsError;
  if (std::filesystem::exists(newPath, existsError)) { fail(L"已经有同名模板了"); return; }
  std::error_code renameError;
  std::filesystem::rename(oldPath, newPath, renameError);
  if (renameError) { fail(L"重命名失败（可能模板正被占用）"); return; }
  if (ReadTemplateDefault() == oldPath.stem().wstring()) WriteUtf8FileAtomic(TemplateDefaultRecordPath(), name);
  // 封面跟着改名，别留孤儿图
  std::error_code coverError;
  std::filesystem::path oldCover(oldPath);
  oldCover.replace_extension(L".png");
  if (std::filesystem::exists(oldCover, coverError)) {
    std::error_code moveError;
    std::filesystem::rename(oldCover, std::filesystem::path(TemplatesFolder()) / (name + L".png"), moveError);
  }
  SendTemplateList();
  PostToCanvas(L"{\"type\":\"native-template-rename-result\",\"success\":true,\"name\":\"" + JsonEscape(name) + L"\"}");
}

void HandleProjectSave(const std::wstring& message) {
  const std::wstring requestId = JsonStringValue(message, L"requestId");
  const std::wstring mode = JsonStringValue(message, L"mode").empty() ? L"save" : JsonStringValue(message, L"mode");
  if (g_projectSaveInProgress) {
    SendProjectOperationResult(L"native-project-save-result", false, false, mode, {},
      L"已有保存或导出操作正在进行，请完成后再试", requestId);
    return;
  }
  g_projectSaveInProgress = true;
  const std::wstring title = JsonStringValue(message, L"title");
  const std::wstring requestedProjectName = JsonStringValue(message, L"projectName");
  const std::wstring projectJson = JsonStringValue(message, L"projectJson");
  // Web 已经把保存数据交给宿主；从这里起可能进入原生“另存为”对话框，
  // 用户挑选路径的时间不能算作 Web 无响应。只保留“保存成功后关闭”的意图。
  const bool closingAfterSave = g_closeAfterSave;
  if (closingAfterSave && g_mainWindow) KillTimer(g_mainWindow, kCloseRequestTimer);
  if (closingAfterSave) g_closePromptOpen = false;
  const auto fail = [&](bool cancelled, const std::wstring& path, const std::wstring& error = {}) {
    g_projectSaveInProgress = false;
    SendProjectOperationResult(L"native-project-save-result", false, cancelled, mode, path, error, requestId);
    // Keep the close intent until the Web layer either retries from its name dialog
    // or explicitly returns to the close confirmation. The short watchdog only
    // covers a broken message bridge; a visible Web prompt immediately pauses it.
    if (closingAfterSave && g_mainWindow) {
      g_closePromptOpen = true;
      SetTimer(g_mainWindow, kCloseRequestTimer, kCloseRequestTimeoutMs, nullptr);
    }
  };
  if (projectJson.empty()) {
    fail(false, {}, L"项目状态为空");
    return;
  }
  const bool legacyMigrationConfirmed = std::exchange(g_confirmLegacyMigration, false);
  const bool forceLegacySaveAs = std::exchange(g_forceLegacySaveAs, false);
  if (mode == L"save" && IsProjectDirectory(g_currentProjectPath) &&
      !legacyMigrationConfirmed && !forceLegacySaveAs) {
    g_pendingLegacyMigrationSaveMessage = message;
    g_legacyMigrationPromptOpen = true;
    PostToCanvas(L"{\"type\":\"native-project-legacy-migration-request\",\"projectPath\":\"" +
      JsonEscape(g_currentProjectPath) + L"\"}");
    return;
  }
  if (mode == L"export") {
    const ProjectSavePathResult prompt = PromptProjectSavePath(title, true);
    if (prompt.path.empty()) { fail(prompt.cancelled, {}, prompt.error); return; }
    size_t at = 0;
    const JsonValue root = ParseJsonValue(message, at);
    const JsonValue* archiveAssets = root.Member(L"assets");
    const JsonValue* archiveExternals = root.Member(L"externals");
    std::wstring error;
    if (!WriteProjectArchive(prompt.path, projectJson, archiveAssets, archiveExternals, error)) {
      fail(false, prompt.path, error);
      return;
    }
    FinishSuccessfulProjectSave(mode, prompt.path, requestId);
    return;
  }
  const bool overwriteConfirmed = !g_confirmedSaveDestination.empty();
  std::wstring destination = overwriteConfirmed ? std::move(g_confirmedSaveDestination) :
    (mode == L"save" && !forceLegacySaveAs ? g_currentProjectPath : L"");
  g_confirmedSaveDestination.clear();
  if (destination.empty()) {
    const ProjectSavePathResult prompt = PromptProjectSavePath(
      requestedProjectName.empty() ? title : requestedProjectName, false);
    if (prompt.path.empty()) {
      fail(prompt.cancelled, {}, prompt.error);
      return;
    }
    destination = prompt.path;
  }
  if (destination.empty()) {
    fail(false, {}, L"项目保存路径为空");
    return;
  }
  std::error_code destinationError;
  if (!overwriteConfirmed && std::filesystem::exists(destination, destinationError) && !SamePath(destination, g_currentProjectPath)) {
    const std::filesystem::path destinationPath(destination);
    const bool validSingleFile = !destinationError && std::filesystem::is_regular_file(destinationPath, destinationError) &&
      _wcsicmp(destinationPath.extension().c_str(), L".zzj") == 0;
    if (destinationError || !validSingleFile) {
      fail(false, destination, L"目标已存在且不是可覆盖的掌中界单文件项目，请选择其他位置");
      return;
    }
    g_pendingOverwriteSaveMessage = message;
    g_pendingOverwriteDestination = destination;
    g_overwritePromptOpen = true;
    PostToCanvas(L"{\"type\":\"native-project-overwrite-request\",\"projectPath\":\"" +
      JsonEscape(destination) + L"\"}");
    return;
  }
  size_t at = 0;
  const JsonValue root = ParseJsonValue(message, at);
  std::wstring error;
  if (legacyMigrationConfirmed) {
    const std::filesystem::path legacyDirectory(destination);
    std::filesystem::path temporary;
    if (!WriteProjectArchiveTemporary(legacyDirectory, projectJson, root.Member(L"assets"),
        root.Member(L"externals"), temporary, error)) {
      fail(false, destination, error);
      return;
    }
    if (!ValidateWrittenProjectArchive(temporary, projectJson, error)) {
      DeleteFileW(temporary.c_str());
      fail(false, destination, error);
      return;
    }
    const std::filesystem::path backup = AvailableLegacyBackupPath(legacyDirectory);
    if (backup.empty() || !MoveFileExW(legacyDirectory.c_str(), backup.c_str(), MOVEFILE_WRITE_THROUGH)) {
      DeleteFileW(temporary.c_str());
      fail(false, destination, L"无法把旧目录项目改名为 .old；旧项目保持不变");
      return;
    }
    if (!CommitProjectArchive(temporary, legacyDirectory, error)) {
      const bool restored = MoveFileExW(backup.c_str(), legacyDirectory.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE;
      DeleteFileW(temporary.c_str());
      if (!restored) error += L"；旧目录位于：" + backup.wstring();
      fail(false, destination, error);
      return;
    }
    std::filesystem::path migratedPackageRoot;
    std::wstring extractionError;
    if (!ExtractProjectArchive(legacyDirectory, migratedPackageRoot, extractionError)) {
      // The archive already passed the same full validation before replacement.
      // Keep the renamed directory as a live source root for this session if the
      // cache extraction itself is unavailable.
      migratedPackageRoot = backup;
    }
    SetCurrentPackageRoot(migratedPackageRoot.wstring());
    FinishSuccessfulProjectSave(mode, destination, requestId, g_currentPackageRoot,
      legacyDirectory.wstring());
    return;
  }
  if (!WriteProjectArchive(destination, projectJson, root.Member(L"assets"), root.Member(L"externals"), error)) {
    fail(false, destination, error);
    return;
  }
  FinishSuccessfulProjectSave(mode, destination, requestId);
}

void HandleProjectOpen(const std::wstring& path, bool archive) {
  if (path.empty()) {
    SendProjectOperationResult(L"native-project-open-result", false, true, L"open", {});
    return;
  }
  const std::filesystem::path requestedPath(path);
  const bool exportedArchive = _wcsicmp(requestedPath.extension().c_str(), L".zzjx") == 0;
  const bool singleFileProject = !IsFileSystemDirectory(requestedPath) &&
    _wcsicmp(requestedPath.extension().c_str(), L".zzj") == 0;
  if (archive || exportedArchive || singleFileProject) {
    std::filesystem::path projectRoot;
    std::wstring error;
    if (!ExtractProjectArchive(path, projectRoot, error) ||
        !SendOpenedProjectPackage(projectRoot, path, singleFileProject, &error)) {
      if (!projectRoot.empty()) RemoveTreeBestEffort(projectRoot);
      if (error.empty()) error = L"项目包内的项目文件无法读取";
      SendProjectOperationResult(L"native-project-open-result", false, false, L"open", path, error);
    }
    return;
  }
  const std::filesystem::path root(path);
  std::wstring error;
  if (!std::filesystem::is_directory(root) || !SendOpenedProject(root, &error)) {
    if (error.empty()) error = L"所选目录不是有效的 .zzj 项目";
    SendProjectOperationResult(L"native-project-open-result", false, false, L"open", path, error);
  }
}

LRESULT CALLBACK CompositionHostProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  static std::wstring capturedSurfaceId;
  static std::wstring forwardedHoverSurfaceId;
  static bool canvasPanActive = false;
  if (g_overlayActive || g_compositionInputDisabled) {
    if (canvasPanActive) {
      POINT screenPoint{};
      GetCursorPos(&screenPoint);
      PostCanvasPan(L"end", capturedSurfaceId, screenPoint);
      canvasPanActive = false;
    }
    if (GetCapture() == window) ReleaseCapture();
    capturedSurfaceId.clear();
    forwardedHoverSurfaceId.clear();
    UpdateSurfaceHover({});
  }
  if (message == WM_NCHITTEST) {
    if (g_overlayActive || g_compositionInputDisabled) return HTTRANSPARENT;
    POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    ScreenToClient(window, &point);
    return HitTestCompositionSurface(point) ? HTCLIENT : HTTRANSPARENT;
  }
  if (message == WM_MOUSELEAVE) {
    UpdateToolbarHotZone({}, true);
    const auto surface = FindSurface(forwardedHoverSurfaceId);
    if (surface && surface->compositionController) {
      surface->compositionController->SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE, 0, POINT{});
    }
    UpdateSurfaceHover({});
    forwardedHoverSurfaceId.clear();
    return 0;
  }
  if (message == WM_MOUSEWHEEL && (GET_KEYSTATE_WPARAM(wParam) & MK_CONTROL)) {
    POINT screenPoint{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    POINT clientPoint = screenPoint;
    ScreenToClient(window, &clientPoint);
    const auto surface = HitTestCompositionSurface(clientPoint);
    if (surface) {
      PostSurfaceFocus(surface->id);
      // DOM WheelEvent deltaY is positive downward; WM_MOUSEWHEEL is positive
      // upward. Normalize here so both input routes share the same zoom math.
      PostCanvasZoom(surface->id, screenPoint, -GET_WHEEL_DELTA_WPARAM(wParam));
    }
    return 0;
  }
  if (message == WM_MBUTTONDOWN) {
    POINT clientPoint{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    const auto surface = HitTestCompositionSurface(clientPoint);
    if (!surface) return 0;
    POINT screenPoint = clientPoint;
    ClientToScreen(window, &screenPoint);
    capturedSurfaceId = surface->id;
    canvasPanActive = true;
    SetCapture(window);
    SetFocus(window);
    PostSurfaceFocus(surface->id);
    PostCanvasPan(L"begin", surface->id, screenPoint);
    return 0;
  }
  if (canvasPanActive && message == WM_MOUSEMOVE) {
    POINT screenPoint{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    ClientToScreen(window, &screenPoint);
    PostCanvasPan(L"move", capturedSurfaceId, screenPoint);
    return 0;
  }
  if (canvasPanActive && (message == WM_MBUTTONUP || message == WM_CAPTURECHANGED)) {
    POINT screenPoint{};
    if (message == WM_MBUTTONUP) {
      screenPoint = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
      ClientToScreen(window, &screenPoint);
    } else GetCursorPos(&screenPoint);
    PostCanvasPan(L"end", capturedSurfaceId, screenPoint);
    canvasPanActive = false;
    capturedSurfaceId.clear();
    if (GetCapture() == window) ReleaseCapture();
    return 0;
  }
  COREWEBVIEW2_MOUSE_EVENT_KIND kind{};
  if (CompositionMouseKind(message, kind)) {
    POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
    if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) ScreenToClient(window, &point);
    auto surface = capturedSurfaceId.empty() ? HitTestCompositionSurface(point) : FindSurface(capturedSurfaceId);
    if (!surface || !surface->compositionController) {
      if (message == WM_MOUSEMOVE) UpdateSurfaceHover({});
      return 0;
    }
    POINT local{point.x - surface->bounds.left, point.y - surface->bounds.top};
    UINT32 mouseData = 0;
    if (message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL)
      mouseData = static_cast<UINT32>(static_cast<INT32>(GET_WHEEL_DELTA_WPARAM(wParam)));
    else if (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP || message == WM_XBUTTONDBLCLK)
      mouseData = GET_XBUTTON_WPARAM(wParam);
    surface->compositionController->SendMouseInput(kind, CompositionMouseKeys(wParam), mouseData, local);
    if (message == WM_MOUSEMOVE) {
      if (!forwardedHoverSurfaceId.empty() && forwardedHoverSurfaceId != surface->id) {
        const auto previous = FindSurface(forwardedHoverSurfaceId);
        if (previous && previous->compositionController) {
          previous->compositionController->SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
            COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE, 0, POINT{});
        }
      }
      forwardedHoverSurfaceId = surface->id;
      UpdateSurfaceHover(surface->id);
      TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, window, 0};
      TrackMouseEvent(&track);
      HCURSOR cursor = nullptr;
      if (SUCCEEDED(surface->compositionController->get_Cursor(&cursor)) && cursor) SetCursor(cursor);
    }
    if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN) {
      capturedSurfaceId = surface->id;
      SetCapture(window);
      SetFocus(window);
      if (surface->controller) surface->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      PostSurfaceFocus(surface->id, message == WM_LBUTTONDOWN);
    }
    if (message == WM_LBUTTONUP || message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP) {
      capturedSurfaceId.clear();
      if (GetCapture() == window) ReleaseCapture();
    }
    return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

bool InitializeCompositionHost(HWND parent) {
  RECT client{};
  GetClientRect(parent, &client);
  g_compositionHost = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_TRANSPARENT, kCompositionHostClass, L"",
    WS_CHILD | WS_VISIBLE, 0, 0, client.right, client.bottom,
    parent, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!g_compositionHost) return false;
  if (FAILED(DCompositionCreateDevice(nullptr, IID_PPV_ARGS(&g_compositionDevice))) || !g_compositionDevice ||
      FAILED(g_compositionDevice->CreateTargetForHwnd(g_compositionHost, TRUE, &g_compositionTarget)) || !g_compositionTarget ||
      FAILED(g_compositionDevice->CreateVisual(&g_compositionRoot)) || !g_compositionRoot ||
      FAILED(g_compositionTarget->SetRoot(g_compositionRoot.Get()))) {
    DestroyWindow(g_compositionHost);
    g_compositionHost = nullptr;
    g_compositionRoot.Reset();
    g_compositionTarget.Reset();
    g_compositionDevice.Reset();
    return false;
  }
  g_compositionDevice->Commit();
  return true;
}

LRESULT CALLBACK MainWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_COPYDATA: {
      const auto* copy = reinterpret_cast<const COPYDATASTRUCT*>(lParam);
      if (!copy || copy->dwData != kProjectOpenCopyData || !copy->lpData || copy->cbData < sizeof(wchar_t)) return FALSE;
      std::wstring path(reinterpret_cast<const wchar_t*>(copy->lpData), copy->cbData / sizeof(wchar_t));
      while (!path.empty() && path.back() == L'\0') path.pop_back();
      g_forwardedProjectPaths.push_back(std::move(path));
      if (!PostMessageW(window, kOpenExternalProjectMessage, 0, 0)) {
        g_forwardedProjectPaths.pop_back();
        return FALSE;
      }
      return TRUE;
    }
    case WM_CAPTURECHANGED:
      if (g_canvasPanCaptureWindow == window) EndCanvasPanCapture();
      break;
    case WM_CANCELMODE:
      EndCanvasPanCapture();
      break;
    case WM_ACTIVATEAPP:
      if (!wParam) EndCanvasPanCapture();
      break;
    case WM_MOUSEMOVE: {
      TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE, window, 0};
      TrackMouseEvent(&track);
      break;
    }
    case WM_NCMOUSEMOVE: {
      TRACKMOUSEEVENT track{sizeof(track), TME_LEAVE | TME_NONCLIENT, window, 0};
      TrackMouseEvent(&track);
      break;
    }
    case WM_MOUSELEAVE:
    case WM_NCMOUSELEAVE:
      UpdateToolbarHotZone({}, true);
      UpdateWindowResizeHint({}, true);
      break;
    case WM_NCCALCSIZE:
      if (UsesBorderlessWindow()) {
        if (wParam && IsZoomed(window)) {
          auto* parameters = reinterpret_cast<NCCALCSIZE_PARAMS*>(lParam);
          MONITORINFO monitorInfo{sizeof(monitorInfo)};
          if (GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitorInfo)) {
            parameters->rgrc[0] = monitorInfo.rcWork;
          } else {
            RECT fallbackWorkArea{};
            if (SystemParametersInfoW(SPI_GETWORKAREA, 0, &fallbackWorkArea, 0)) {
              parameters->rgrc[0] = fallbackWorkArea;
              OutputDebugStringW(L"[掌中界] GetMonitorInfo failed during maximize; using the primary work area.\n");
            } else {
              OutputDebugStringW(L"[掌中界] GetMonitorInfo and SPI_GETWORKAREA both failed during maximize.\n");
            }
          }
        }
        return 0;
      }
      break;
    case WM_NCHITTEST:
      if (UsesBorderlessWindow()) return HitTestBorderlessFrame(window, lParam);
      break;
    case WM_GETMINMAXINFO:
      if (UsesBorderlessWindow()) {
        MONITORINFO monitorInfo{sizeof(monitorInfo)};
        if (GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitorInfo)) {
          auto* limits = reinterpret_cast<MINMAXINFO*>(lParam);
          limits->ptMaxPosition.x = monitorInfo.rcWork.left - monitorInfo.rcMonitor.left;
          limits->ptMaxPosition.y = monitorInfo.rcWork.top - monitorInfo.rcMonitor.top;
          limits->ptMaxSize.x = monitorInfo.rcWork.right - monitorInfo.rcWork.left;
          limits->ptMaxSize.y = monitorInfo.rcWork.bottom - monitorInfo.rcWork.top;
        }
        return 0;
      }
      break;
    case WM_CREATE: {
      g_mainWindow = window;
      // 弹出菜单的边框跟着拥有者窗口的框架走。主窗口一直没被打上深色标记，
      // 所以第一个 Shell 右键菜单会带一圈白边，之后系统缓存了才变深。
      // 在这里就把主窗口标成深色，第一次弹出也是干净的。
      ApplyMenuTheme();
      if (g_allowDarkModeForWindow) g_allowDarkModeForWindow(window, SystemUsesDarkMode() ? TRUE : FALSE);
      const BOOL dark = SystemUsesDarkMode() ? TRUE : FALSE;
      DwmSetWindowAttribute(window, 20, &dark, sizeof(dark));
      RefreshTopEdgeMetrics();
      ApplyDwmWindowFrame(window);
      ProbeDwmBackdropSupport(window);
      ApplyWindowMaterial(window);
      InitializeCompositionHost(window);
      PIDLIST_ABSOLUTE desktop = nullptr;
      PIDLIST_ABSOLUTE computer = nullptr;
      SHChangeNotifyEntry entries[2]{};
      int entryCount = 0;
      if (SUCCEEDED(SHGetKnownFolderIDList(FOLDERID_Desktop, 0, nullptr, &desktop)) && desktop) {
        entries[entryCount++] = {desktop, TRUE};
      }
      if (SUCCEEDED(SHGetKnownFolderIDList(FOLDERID_ComputerFolder, 0, nullptr, &computer)) && computer) {
        entries[entryCount++] = {computer, TRUE};
      }
      if (entryCount > 0) {
        g_shellNotifyId = SHChangeNotifyRegister(window,
          SHCNRF_ShellLevel | SHCNRF_InterruptLevel | SHCNRF_NewDelivery,
          SHCNE_ALLEVENTS, kShellChangeMessage, entryCount, entries);
      }
      CoTaskMemFree(desktop);
      CoTaskMemFree(computer);
      AddClipboardFormatListener(window);  // 自动剪贴历史（Win+V 式）
      g_mainWindow = window;
      RegisterCaptureHotkeys();  // 全局截图热键（可在设置里自定义）
      RegisterCanvasDropTarget(window);
      InitializeWebView();
      return 0;
    }
    case WM_CLIPBOARDUPDATE:
      CaptureClipboardIntoHistory(false);
      return 0;
    case WM_HOTKEY:
      if (wParam == kCaptureRegionHotkeyId) StartRegionCapture();
      else if (wParam == kCaptureFullHotkeyId) CaptureFullScreenToHistory();
      else if (wParam == kCaptureToolHotkeyId) LaunchScreenCaptureTool();
      return 0;
    case kShellChangeMessage: {
      PIDLIST_ABSOLUTE* changed = nullptr;
      LONG event = 0;
      HANDLE lock = SHChangeNotification_Lock(
        reinterpret_cast<HANDLE>(wParam), static_cast<DWORD>(lParam), &changed, &event);
      if (lock) SHChangeNotification_Unlock(lock);
      {
        // A descendant change does not reliably update every ancestor's last
        // write time. Shell notifications therefore invalidate the shared
        // cache; the per-folder timestamp still makes ordinary revisits free.
        std::lock_guard<std::mutex> cacheLock(g_folderSizeCacheMutex);
        g_folderSizeCache.clear();
      }
      const bool driveListChanged = (event & (SHCNE_DRIVEADD | SHCNE_DRIVEREMOVED |
        SHCNE_MEDIAINSERTED | SHCNE_MEDIAREMOVED)) != 0;
      for (const auto& surface : g_surfaces) {
        if (surface && surface->kind == L"explorer") {
          surface->explorerContentDirty = true;
          if (driveListChanged) SendExplorerTree(surface, L"");
        }
      }
      return 0;
    }
    case WM_MOVE:
      RefreshTopEdgeMetrics();
      UpdateWindowResizeHint({}, true);
      break;
    case WM_SIZE: {
      if (wParam == SIZE_MINIMIZED) {
        g_mainWindowMinimized = true;
        // WebView2 otherwise keeps an internally-visible controller under an
        // iconic parent.  Restoring to the exact same bounds can then leave
        // its swap chain black until some later resize happens.
        if (g_appController) g_appController->put_IsVisible(FALSE);
        SendWindowState();
        return 0;
      }
      const bool restoredFromMinimized = g_mainWindowMinimized;
      g_mainWindowMinimized = false;
      RefreshTopEdgeMetrics();
      UpdateWindowResizeHint({}, true);
      ApplyDwmWindowFrame(window);
      // ResizeChildren synchronously replays the last known geometry for every
      // native surface after restoring the app WebView and composition host.
      // This does not depend on the Web-side rAF loop, which sleeps when idle.
      ResizeChildren();
      if (restoredFromMinimized) {
        PostMessageW(window, kRestoreAfterMinimizeMessage, 0, 0);
      }
      SendWindowState();
      return 0;
    }
    // 交接文档 22 P1-UI-2 点名要求：系统主题变化后文件视图必须同步刷新。
    case WM_TIMER:
      if (wParam == kSurfaceSweepTimer) { SweepRetiredSurfaces(); return 0; }
      if (wParam == kNativeDragTimer) { PollNativeDrag(window); return 0; }
    if (wParam == kSplitWatchTimer) { TickSplitPartner(); return 0; }
    if (wParam == kHeartbeatTimer) { HeartbeatTick(); return 0; }
    if (wParam == kPipCenterTimer) { KillTimer(window, kPipCenterTimer); CenterPipWindow(g_pipWindow); return 0; }
    // 画中画窗口是 Chromium 建完页面之后才建的独立顶层窗口：进画中画后 200ms 一次去认，最多 16 次（约 3 秒）。
    if (wParam == kPipWatchTimer) {
      ++g_pipWatchTries;
      g_pipWindow = nullptr;
      // 画中画窗口 = 「我们这个 WebView2 浏览器进程」的可见顶层窗口：
      // 本应用其余界面都是子窗口 / 视觉合成，不会出现在顶层；其它软件的 WebView2 进程号不同，也不会误认。
      // 优先挑「进画中画那一刻新出现的」，抓不到再兜底用本进程的可见顶层窗口（画中画窗口可能早就建好了）。
      // 本应用有两个 WebView2 环境（app 页一个、浏览器卡一个）→ 两个浏览器进程，都要认。
      std::vector<DWORD> ourBrowserPids;
      const auto notePid = [&ourBrowserPids](DWORD pid) {
        if (pid && std::find(ourBrowserPids.begin(), ourBrowserPids.end(), pid) == ourBrowserPids.end()) ourBrowserPids.push_back(pid);
      };
      notePid(WebViewBrowserProcessId(g_appWebView.Get()));
      for (const auto& surface : g_surfaces) {
        if (surface && surface->webView) notePid(WebViewBrowserProcessId(surface->webView.Get()));
      }
      HWND fallback = nullptr;
      for (HWND candidate : CollectTopLevelWebViewWindows()) {
        if (!ourBrowserPids.empty()) {
          DWORD candidatePid = 0;
          GetWindowThreadProcessId(candidate, &candidatePid);
          if (std::find(ourBrowserPids.begin(), ourBrowserPids.end(), candidatePid) == ourBrowserPids.end()) continue;
        }
        if (GetWindow(candidate, GW_OWNER) != nullptr) continue;
        if (std::find(g_pipBaselineWindows.begin(), g_pipBaselineWindows.end(), candidate) == g_pipBaselineWindows.end()) {
          g_pipWindow = candidate;
          break;
        }
        if (!fallback) fallback = candidate;
      }
      if (!g_pipWindow) g_pipWindow = fallback;
      if (g_pipWindow) {
        KillTimer(window, kPipWatchTimer);
        CenterPipWindow(g_pipWindow);
        SetTimer(window, kPipCenterTimer, 450, nullptr);
        InstallPipMouseHook();
        WriteLifecycleLog(L"pip: window found (double-click it to exit)");
      } else if (g_pipWatchTries > 16) {
        KillTimer(window, kPipWatchTimer);
        WriteLifecycleLog(L"pip: window not found; double-click exit unavailable");
      }
      return 0;
    }
      // Shell 视图不对外广播选择变化，要拿到「有没有选中项」只能轮询。
      // 350ms 够跟手，代价也小；只有内容真的变了才推给 Web 层。
      if (wParam == kCloseRequestTimer) {
        KillTimer(window, kCloseRequestTimer);
        if (g_closePromptOpen) {
          if (g_closeWatchdogRetries < 1 && g_appWebView) {
            // 渲染进程可能只是忙（缩略图风暴/大目录渲染）而没能及时回话。
            // 先重新询问一次，避免「Web 正忙时点关闭 → 无提示直接消失」。
            ++g_closeWatchdogRetries;
            WriteLifecycleLog(L"close-watchdog retry: web busy, re-sent close-request");
            PostToCanvas(L"{\"type\":\"native-close-request\"}");
            SetTimer(window, kCloseRequestTimer, kCloseRequestTimeoutMs, nullptr);
            return 0;
          }
          // Web 白屏、脚本卡死或 WebView2 进程退出时，不能再依赖任何 Web UI。
          // 把宿主最后收到的状态明确标成崩溃恢复快照，然后走唯一的原生退出路径。
          WriteLifecycleLog(L"close-watchdog force-exit: saving snapshot");
          if (!g_lastSessionJson.empty()) WriteSessionSnapshot(g_lastSessionJson, true);
          g_closePromptOpen = false;
          g_closeAfterSave = false;
          g_forceClose = true;
          PostMessageW(window, WM_CLOSE, 0, 0);
        }
        return 0;
      }
      if (wParam == kExplorerStateTimer) {
        const ULONGLONG explorerNow = GetTickCount64();
        TickCopyWatches(explorerNow);
        TickSplitPartner();
        // 解压镜像还在写入时定期重扫外壳视图：包内条目边解压边出现，而不是
        // 干等整包解完（大包要好几十秒）。
        for (const auto& surface : g_surfaces) {
          if (!surface || surface->pendingMirrorTarget.empty() || !surface->explorer) continue;
          if (surface->mirrorRefreshAt && explorerNow < surface->mirrorRefreshAt) continue;
          surface->mirrorRefreshAt = explorerNow + 1200;
          const auto mirrorView = CurrentShellView(surface);
          if (mirrorView) mirrorView->Refresh();
          surface->explorerContentDirty = true;
        }
        for (const auto& surface : g_surfaces) {
          if (surface->browseRetryAt && explorerNow >= surface->browseRetryAt && surface->explorer) {
            const HRESULT retryResult = BrowseExplorer(surface, surface->source);
            if (SUCCEEDED(retryResult)) {
              surface->browseRetryAt = 0;
              surface->browseRetryAttempt = 0;
              surface->location.clear();
              surface->selectionCount = -1;
              surface->explorerContentDirty = true;
              WriteLifecycleLog(L"explorer browse retry succeeded");
            } else if (surface->browseRetryAttempt >= 14) {
              surface->browseRetryAt = 0;
              wchar_t giveUpLine[512]{};
              swprintf_s(giveUpLine, L"explorer browse retry gave up hr=0x%08lX path=%s",
                static_cast<unsigned long>(retryResult), surface->source.c_str());
              WriteLifecycleLog(giveUpLine);
            } else {
              ++surface->browseRetryAttempt;
              static const ULONGLONG browseBackoff[] = {600, 1200, 2500, 5000, 10000, 20000, 30000};
              const size_t backoffIndex = std::min<size_t>(static_cast<size_t>(surface->browseRetryAttempt), std::size(browseBackoff) - 1);
              surface->browseRetryAt = explorerNow + browseBackoff[backoffIndex];
            }
          }
          ReportExplorerState(surface, false);
        }
        return 0;
      }
      break;
    case WM_THEMECHANGED:
      RefreshSurfaceThemes();
      return 0;
    case WM_SETTINGCHANGE:
      if (lParam && _wcsicmp(reinterpret_cast<const wchar_t*>(lParam), L"ImmersiveColorSet") == 0) {
        if (g_setPreferredAppMode) g_setPreferredAppMode(PreferredAppMode::AllowDark);
        RefreshSurfaceThemes();
        PostToCanvas(L"{\"type\":\"system-theme-changed\",\"dark\":" + std::wstring(SystemUsesDarkMode() ? L"true" : L"false") + L"}");
      }
      return 0;
    case WM_DPICHANGED: {
      const RECT* suggested = reinterpret_cast<RECT*>(lParam);
      SetWindowPos(window, nullptr, suggested->left, suggested->top,
        suggested->right - suggested->left, suggested->bottom - suggested->top,
        SWP_NOZORDER | SWP_NOACTIVATE);
      ResizeChildren();
      RefreshTopEdgeMetrics();
      UpdateWindowResizeHint({}, true);
      ApplyDwmWindowFrame(window, true);
      return 0;
    }
    case kBeginNativeDragMessage:
      PollNativeDrag(window);
      return 0;
    case kBeginWindowDragMessage: {
      POINT cursor{};
      GetCursorPos(&cursor);
      ReleaseCapture();
      SendMessageW(window, WM_NCLBUTTONDOWN, HTCAPTION, MAKELPARAM(cursor.x, cursor.y));
      return 0;
    }
    case kWindowMinimizeMessage:
      ShowWindow(window, SW_MINIMIZE);
      return 0;
    case kWindowToggleMaximizeMessage:
      ShowWindow(window, IsZoomed(window) ? SW_RESTORE : SW_MAXIMIZE);
      return 0;
    case kWindowSnapLeftMessage:
      RememberSelfBeforeSplit();
      QueueWindowSnapInput(window, VK_LEFT);
      return 0;
    case kWindowSnapRightMessage:
      RememberSelfBeforeSplit();
      QueueWindowSnapInput(window, VK_RIGHT);
      return 0;
    case kWindowSnapLayoutMessage:
      QueueWindowSnapInput(window, 'Z');
      return 0;
    case kWindowCloseMessage:
      PostMessageW(window, WM_CLOSE, 0, 0);
      return 0;
    case kRestoreAfterMinimizeMessage: {
      // Run after WM_SIZE has returned. WebView2 and DWM both do work while the
      // top-level restore is still being dispatched; rebuilding inside WM_SIZE
      // can be overwritten later in that same system transition.
      if (IsIconic(window)) return 0;
      RECT windowBounds{};
      if (GetWindowRect(window, &windowBounds)) {
        const int width = windowBounds.right - windowBounds.left;
        const int height = windowBounds.bottom - windowBounds.top;
        if (width > 1 && height > 0) {
          // A maximized window can return from the iconic state at precisely
          // the old size while DWM/WebView2 still retain discarded presentation
          // surfaces. A real one-pixel top-level size transition recreates that
          // chain; same-value controller bounds and RedrawWindow do not. Restore
          // the exact dimensions immediately, preserving the zoomed state.
          constexpr UINT pulseFlags = SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE;
          SetWindowPos(window, nullptr, 0, 0, width - 1, height, pulseFlags);
          SetWindowPos(window, nullptr, 0, 0, width, height, pulseFlags);
        }
      }
      ResizeChildren();
      if (g_appController) {
        RECT client{};
        GetClientRect(window, &client);
        g_appController->put_Bounds(client);
        g_appController->NotifyParentWindowPositionChanged();
        g_appController->put_IsVisible(TRUE);
      }
      for (const auto& surface : g_surfaces) {
        if (surface && surface->controller) surface->controller->NotifyParentWindowPositionChanged();
      }
      if (g_compositionDevice) g_compositionDevice->Commit();
      RedrawWindow(window, nullptr, nullptr,
        RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW);
      // Each NativeSurfaceSlot publishes one fresh DOM measurement after the
      // host has synchronously replayed its cached native geometry.
      PostToCanvas(L"{\"type\":\"native-window-restored\"}");
      return 0;
    }
    case kPostCanvasMessage: {
      std::unique_ptr<std::wstring> json(reinterpret_cast<std::wstring*>(lParam));
      if (json) PostToCanvas(*json);
      return 0;
    }
    case kOpenExternalProjectMessage: {
      if (g_forwardedProjectPaths.empty()) return 0;
      std::wstring path = std::move(g_forwardedProjectPaths.front());
      g_forwardedProjectPaths.erase(g_forwardedProjectPaths.begin());
      if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
      SetForegroundWindow(window);
      if (!path.empty()) {
        if (!g_canvasReady || g_restoreDecisionPending) g_pendingIncomingPathAfterRestoreDecision = path;
        else DispatchIncomingPath(path);
      }
      return 0;
    }
    case kApplyWindowAppearanceMessage:
      ApplyWindowAppearance();
      return 0;
    case kApplyWindowMaterialMessage:
      ApplyWindowMaterial(window);
      return 0;
    case kPipExitRequestMessage:
      RequestPipExitFromPage();
      return 0;
    case kArchiveMirrorReadyMessage: {
      std::unique_ptr<std::wstring> payload(reinterpret_cast<std::wstring*>(lParam));
      if (payload) FinishArchiveMirror(*payload);
      return 0;
    }
    case WM_CLOSE:
      if (g_nativeDialogOpen) return 0;
      if (g_legacyMigrationPromptOpen) {
        const std::wstring pendingMessage = std::move(g_pendingLegacyMigrationSaveMessage);
        g_pendingLegacyMigrationSaveMessage.clear();
        g_legacyMigrationPromptOpen = false;
        g_closeAfterSave = false;
        g_projectSaveInProgress = false;
        PostToCanvas(L"{\"type\":\"native-project-legacy-migration-dismissed\"}");
        if (!pendingMessage.empty()) {
          const std::wstring mode = JsonStringValue(pendingMessage, L"mode").empty() ? L"save" : JsonStringValue(pendingMessage, L"mode");
          const std::wstring requestId = JsonStringValue(pendingMessage, L"requestId");
          SendProjectOperationResult(L"native-project-save-result", false, true, mode, g_currentProjectPath, {}, requestId);
        }
      }
      if (g_overwritePromptOpen) {
        const std::wstring pendingMessage = std::move(g_pendingOverwriteSaveMessage);
        const std::wstring pendingDestination = std::move(g_pendingOverwriteDestination);
        g_pendingOverwriteSaveMessage.clear();
        g_pendingOverwriteDestination.clear();
        g_overwritePromptOpen = false;
        g_closeAfterSave = false;
        g_projectSaveInProgress = false;
        PostToCanvas(L"{\"type\":\"native-project-overwrite-dismissed\"}");
        if (!pendingMessage.empty()) {
          const std::wstring mode = JsonStringValue(pendingMessage, L"mode").empty() ? L"save" : JsonStringValue(pendingMessage, L"mode");
          const std::wstring requestId = JsonStringValue(pendingMessage, L"requestId");
          SendProjectOperationResult(L"native-project-save-result", false, true, mode, pendingDestination, {}, requestId);
        }
      }
      if (g_documentDirty && !g_forceClose) {
        if (g_closePromptOpen) return 0;
        if (g_appWebView) {
          // 让掌中界自己画那个「保存 / 不保存 / 取消」，颜色跟应用主题一致。
          // 3 秒内 Web 层没有回话就保留崩溃恢复快照并由宿主强制退出。
          g_closePromptOpen = true;
          g_closeWatchdogRetries = 0;
          WriteLifecycleLog(L"WM_CLOSE (dirty): close-request posted");
          PostToCanvas(L"{\"type\":\"native-close-request\"}");
          SetTimer(window, kCloseRequestTimer, kCloseRequestTimeoutMs, nullptr);
          return 0;
        }
        // WebView 已不存在时没有可交互的保存界面；宿主快照是最后一道保护。
        if (!g_lastSessionJson.empty()) WriteSessionSnapshot(g_lastSessionJson, true);
        g_forceClose = true;
      }
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      WriteLifecycleLog(L"exit: WM_DESTROY -> 正常销毁窗口，进程即将退出");
      if (g_canvasDropTarget) {
        if (g_canvasDropWindow) RevokeDragDrop(g_canvasDropWindow);
        g_canvasDropTarget->Release();
        g_canvasDropTarget = nullptr;
        g_canvasDropWindow = nullptr;
      }
      RemoveClipboardFormatListener(window);
      if (g_shellNotifyId) {
        SHChangeNotifyDeregister(g_shellNotifyId);
        g_shellNotifyId = 0;
      }
      while (!g_surfaces.empty()) DestroySurface(g_surfaces.back()->id);
      g_appWebView.Reset();
      if (g_appController) g_appController->Close();
      g_appController.Reset();
      g_browserEnvironment.Reset();
      g_environment.Reset();
      g_compositionRoot.Reset();
      g_compositionTarget.Reset();
      g_compositionDevice.Reset();
      g_compositionHost = nullptr;
      const std::filesystem::path abandonedRestoreRoot(g_pendingRestorePackageRoot);
      g_pendingRestoreProjectPath.clear();
      g_pendingRestorePackageRoot.clear();
      if (IsImportedProjectRoot(abandonedRestoreRoot)) RemoveTreeBestEffort(abandonedRestoreRoot);
      ReleaseCurrentPackageLock();
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}
}  // namespace

bool ForwardToExistingInstance(const std::wstring& path) {
  HWND existing = nullptr;
  for (int attempt = 0; attempt < 250 && !existing; ++attempt) {
    existing = FindWindowW(kMainWindowClass, nullptr);
    if (!existing) Sleep(20);
  }
  if (!existing) return false;
  COPYDATASTRUCT copy{};
  copy.dwData = kProjectOpenCopyData;
  copy.cbData = static_cast<DWORD>((path.size() + 1) * sizeof(wchar_t));
  copy.lpData = const_cast<wchar_t*>(path.c_str());
  DWORD_PTR ignored = 0;
  return SendMessageTimeoutW(existing, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&copy),
    SMTO_ABORTIFHUNG | SMTO_BLOCK, 3000, &ignored) != 0;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
  InstallCrashCapture();
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (FAILED(OleInitialize(nullptr))) return 1;
  EnableProcessThemeSupport();
  g_appFolder = ModuleFolder();
  PWSTR localAppData = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &localAppData)) && localAppData) {
    g_dataFolder = (std::filesystem::path(localAppData) / L"掌中界").wstring();
    CoTaskMemFree(localAppData);
  } else {
    g_dataFolder = g_appFolder + L"\\UserData";
  }
  std::error_code dataError;
  std::filesystem::create_directories(g_dataFolder, dataError);
  CleanupArchiveMirrorCache();
  InitializeThumbnailBreadcrumb();
  LoadClipboardHistory();
  if (wcsstr(GetCommandLineW(), L"--verify-crash-log")) {
    RecordLastWebViewMessage(L"{\"type\":\"manual-crash-log-verification\"}");
    const int result = VerifyCrashCapture();
    OleUninitialize();
    return result;
  }
  int argumentCount = 0;
  PWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (arguments && argumentCount > 1) {
    const std::wstring argument = arguments[1] ? arguments[1] : L"";
    if (!argument.empty() && argument.front() != L'-' && argument.front() != L'/') {
      g_startupProjectPath = argument;
    }
  }
  if (arguments) LocalFree(arguments);

  g_singleInstanceMutex = CreateMutexW(nullptr, FALSE, L"Local\\ZhangZhongJie.SingleInstance");
  if (g_singleInstanceMutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    if (ForwardToExistingInstance(g_startupProjectPath)) {
      CloseHandle(g_singleInstanceMutex);
      g_singleInstanceMutex = nullptr;
      OleUninitialize();
      return 0;
    }
    // The owner can be exiting or temporarily hung while opening a large
    // project. Fall back to an independent window instead of losing the click.
    CloseHandle(g_singleInstanceMutex);
    g_singleInstanceMutex = nullptr;
  }
  LoadSettings();
  if (!ApplyExplorerContextMenuRegistration(g_explorerContextMenuEnabled)) {
    g_explorerContextMenuNoticePending = true;
  }
  CleanupImportedProjects();
  LoadRecentProjects();
  WNDCLASSEXW surfaceClass{sizeof(surfaceClass)};
  surfaceClass.hInstance = instance;
  surfaceClass.lpfnWndProc = SurfaceHostProc;
  surfaceClass.lpszClassName = kSurfaceHostClass;
  surfaceClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  surfaceClass.hbrBackground = CreateSolidBrush(RGB(18, 22, 28));
  RegisterClassExW(&surfaceClass);

  WNDCLASSEXW compositionClass{sizeof(compositionClass)};
  compositionClass.hInstance = instance;
  compositionClass.lpfnWndProc = CompositionHostProc;
  compositionClass.lpszClassName = kCompositionHostClass;
  compositionClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  compositionClass.style = CS_DBLCLKS;
  RegisterClassExW(&compositionClass);

  WNDCLASSEXW mainClass{sizeof(mainClass)};
  mainClass.hInstance = instance;
  mainClass.lpfnWndProc = MainWindowProc;
  mainClass.lpszClassName = kMainWindowClass;
  mainClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  mainClass.hIcon = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON, 0, 0, LR_DEFAULTSIZE));
  mainClass.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON,
    GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
  RegisterClassExW(&mainClass);

  // 材质层：WS_EX_NOREDIRECTIONBITMAP 去掉窗口的 redirection bitmap。
  // 普通 GDI 窗口的 redirection bitmap 是不透明像素（alpha 被忽略），
  // 会把 DWM backdrop（云母）完全盖住——实测：普通窗口 Mica 不可见，
  // 无重定向位图的窗口 Mica 正常透出（WebView2 / 原生子窗口照常渲染）。
  HWND window = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP, kMainWindowClass, L"掌中界",
    WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
    CW_USEDEFAULT, CW_USEDEFAULT, 1600, 940,
    nullptr, nullptr, instance, nullptr);
  if (!window) {
    if (g_singleInstanceMutex) CloseHandle(g_singleInstanceMutex);
    OleUninitialize();
    return 2;
  }
  ShowWindow(window, showCommand);
  UpdateWindow(window);

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    // Windowed WebView2 and IExplorerBrowser deliver input to renderer/Shell
    // descendants rather than SurfaceHostProc. Intercept their canvas gestures
    // before dispatch; ordinary wheel input is intentionally left untouched.
    if (g_canvasPanCaptureWindow &&
        (message.message == WM_MOUSEMOVE || message.message == WM_MBUTTONUP)) {
      POINT screenPoint{GET_X_LPARAM(message.lParam), GET_Y_LPARAM(message.lParam)};
      ClientToScreen(message.hwnd, &screenPoint);
      if (message.message == WM_MOUSEMOVE && (message.wParam & MK_MBUTTON)) {
        PostCanvasPan(L"move", g_canvasPanSurfaceId, screenPoint);
      } else {
        const HWND captureWindow = g_canvasPanCaptureWindow;
        const std::wstring surfaceId = std::move(g_canvasPanSurfaceId);
        g_canvasPanCaptureWindow = nullptr;
        g_canvasPanSurfaceId.clear();
        PostCanvasPan(L"end", surfaceId, screenPoint);
        if (GetCapture() == captureWindow) ReleaseCapture();
      }
      continue;
    }
    if (message.message == WM_MOUSEWHEEL && (GET_KEYSTATE_WPARAM(message.wParam) & MK_CONTROL)) {
      // WM_MOUSEWHEEL is delivered to the focused window, which may belong to
      // a different canvas than the surface currently under the pointer.
      if (!g_hoveredSurfaceId.empty()) {
        const POINT screenPoint{GET_X_LPARAM(message.lParam), GET_Y_LPARAM(message.lParam)};
        PostSurfaceFocus(g_hoveredSurfaceId);
        PostCanvasZoom(g_hoveredSurfaceId, screenPoint, -GET_WHEEL_DELTA_WPARAM(message.wParam));
        continue;
      }
    }
    if ((message.message == WM_KEYDOWN || message.message == WM_SYSKEYDOWN) && IsAppGlobalShortcut(message)) {
      const auto& owner = ResolveHoverOwner(message.hwnd);
      if ((owner.owner || owner.insideCompositionHost) && ForwardConfiguredShortcut(message, owner.owner)) continue;
    }
    if (TranslateFocusedShellViewAccelerator(message)) continue;
    if (message.message == WM_KEYDOWN || message.message == WM_SYSKEYDOWN) {
      const auto& owner = ResolveHoverOwner(message.hwnd);
      if ((owner.owner || owner.insideCompositionHost) && ForwardConfiguredShortcut(message, owner.owner)) continue;
    }
    if (message.message == WM_MBUTTONDOWN) {
      const auto& owner = ResolveHoverOwner(message.hwnd);
      if (owner.owner) {
        POINT screenPoint{GET_X_LPARAM(message.lParam), GET_Y_LPARAM(message.lParam)};
        ClientToScreen(message.hwnd, &screenPoint);
        SetCapture(message.hwnd);
        HWND captureWindow = GetCapture() == message.hwnd ? message.hwnd : nullptr;
        if (!captureWindow && g_mainWindow) {
          SetCapture(g_mainWindow);
          if (GetCapture() == g_mainWindow) captureWindow = g_mainWindow;
        }
        if (captureWindow) {
          g_canvasPanCaptureWindow = captureWindow;
          g_canvasPanSurfaceId = owner.owner->id;
          PostSurfaceFocus(owner.owner->id);
          PostCanvasPan(L"begin", owner.owner->id, screenPoint);
          continue;
        }
        OutputDebugStringW(L"[ZhangZhongJie] Canvas pan could not capture the pointer.\n");
      }
    }
    if (message.message == WM_LBUTTONDOWN) {
      const auto& owner = ResolveHoverOwner(message.hwnd);
      if (owner.owner && owner.owner->kind == L"explorer") PostSurfaceFocus(owner.owner->id, true);
      if (owner.owner && owner.owner->kind == L"shellview") PostSurfaceFocus(owner.owner->id, true);
    }
    // Shell descendants and composition input hosts may own the mouse message.
    // Observe it before dispatch and publish only edge-state changes, never one
    // Web message per WM_MOUSEMOVE.
    if (message.message == WM_MOUSEMOVE || message.message == WM_NCMOUSEMOVE) {
      POINT cursor{};
      if (GetCursorPos(&cursor)) {
        UpdateToolbarHotZone(cursor);
        UpdateWindowResizeHint(cursor);
      }
      const auto& hover = ResolveHoverOwner(message.hwnd);
      if (hover.owner) UpdateSurfaceHover(hover.owner->id);
      else if (!hover.insideCompositionHost) {
        UpdateSurfaceHover({});
      }
    }
    if (message.message == WM_MOUSELEAVE || message.message == WM_NCMOUSELEAVE) {
      UpdateWindowResizeHint({}, true);
      const auto& hover = ResolveHoverOwner(message.hwnd);
      if (hover.owner && hover.owner->id == g_hoveredSurfaceId) UpdateSurfaceHover({});
    }
    // 焦点落在 Shell 文件视图里时，键盘和鼠标侧键消息直接进那个子窗口，
    // 我们的窗口过程根本收不到。所以在派发之前先截一道：退格 = 后退，
    // 鼠标 4/5 = 后退/前进，和系统资源管理器的习惯一致。
    if (message.message == WM_XBUTTONUP) {
      std::shared_ptr<NativeSurface> owner;
      for (HWND probe = message.hwnd; probe && !owner; probe = GetParent(probe)) {
        for (const auto& surface : g_surfaces) if (surface->host == probe) { owner = surface; break; }
      }
      if (owner && owner->kind == L"explorer") {
        const bool back = GET_XBUTTON_WPARAM(message.wParam) == XBUTTON1;
        const bool forward = GET_XBUTTON_WPARAM(message.wParam) == XBUTTON2;
        if (back || forward) {
          owner->explorer->BrowseToIDList(nullptr, back ? SBSP_NAVIGATEBACK : SBSP_NAVIGATEFORWARD);
          continue;
        }
      }
    }
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  if (g_singleInstanceMutex) {
    CloseHandle(g_singleInstanceMutex);
    g_singleInstanceMutex = nullptr;
  }
  OleUninitialize();
  return static_cast<int>(message.wParam);
}
