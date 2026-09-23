import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, MutableRefObject, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { DEFAULT_SHORTCUT_BINDINGS, SHORTCUT_DEFINITIONS, bindingFromKeyboardEvent, normalizeShortcutBindings, shortcutBindingProblem, shortcutDisplay, shortcutIdForEvent } from './shortcuts'
import type { ShortcutBindings, ShortcutId } from './shortcuts'

const stopWheelPropagation = (event: ReactWheelEvent<HTMLElement>) => event.stopPropagation()

type Theme = 'dark' | 'light' | 'system'
type WebThemeMode = 'follow' | 'dark' | 'original'
type WindowAppearance = 'system' | 'borderless'
type WindowMaterial = 'mica' | 'solid'
type ToolbarVisibility = 'always' | 'auto'
type CardTitlebarVisibility = 'always' | 'hover'
type FileViewMode = 'details' | 'large-icons' | 'media-grid' | 'compact'
type FileIconMode = 'system' | 'vector'
type FileSortKey = 'name' | 'modified' | 'type' | 'size'
type FileColumnKey = 'name' | 'type' | 'dimensions' | 'duration' | 'modified' | 'size'
type WebBookmark = { id: string; name: string; url: string; group?: string }
type GlobalQuickAction = 'computer' | 'web' | 'shelf' | 'navigator' | 'todo'
type GlobalFavorite = { id: string; label: string; source: string; sourceKind: 'file' | 'folder' | 'app'; image?: string }
type AppSettings = {
  version: 2
  windowAppearance: WindowAppearance
  windowMaterial: WindowMaterial
  toolbarVisibility: ToolbarVisibility
  cardTitlebarVisibility: CardTitlebarVisibility
  appTheme: Theme
  webThemeMode: WebThemeMode
  fileTreeCollapsed: boolean
  fileViewMode: FileViewMode
  fileTreeIconSize: 'small' | 'large'
  fileIconMode: FileIconMode
  fileGroupByName: boolean
  fileColumns: FileColumnKey[]
  fileColumnWidths: Record<string, Partial<Record<FileColumnKey, number>>>
  fileTreeWidths: Record<string, number>
  fileTreeColumnWidths: Record<string, number>
  previewNameColumnWidth: number
  mediaMuted: boolean
  mediaPlaybackRate: number
  everythingPromptDismissed: boolean
  /** 导出位置（自定义过一次就记住；空 = 默认「图片\掌中界导出」） */
  exportFolder?: string
  explorerContextMenuEnabled: boolean
  webBookmarks: WebBookmark[]
  globalQuickActions: GlobalQuickAction[]
  globalFavorites: GlobalFavorite[]
  globalFixedOrder: string[]
  browserZoom: Record<string, number>
  browserHistory: string[]
  browserUserAgent: 'default' | 'chrome'
  browserGroupOrder: string[]
  shortcutBindings: ShortcutBindings
  petModel: string
  ocrLanguage: string
  uiMotion: 'off' | 'light' | 'full'
  /** 画布风格：default = 深色玻璃；board = 白板风（浅色纸感）；board-dark = 白板风（深色纸感）
   *  后两者都会「推开」挡路的卡（白板风专属交互）。 */
  canvasSkin: 'default' | 'board' | 'board-dark'
  /** 界面字号：整站等比缩放（0.9 小 / 1 标准 / 1.15 大 / 1.3 特大）——发给宿主设 WebView2 ZoomFactor */
  uiScale: number
  settingsWidth: number
  settingsHeight: number
}
type ItemKind = 'workspace' | 'video' | 'portal' | 'web' | 'folder' | 'shellview' | 'note' | 'shelf' | 'reference' | 'image' | 'app' | 'desktop' | 'icon'
// 分屏模板（必须与原生 kTileSlotTemplates 的 id 保持一致）：比例坐标，槽位顺序=填充顺序。
type TileSlot = { x: number; y: number; w: number; h: number }
const TILE_LAYOUTS: { id: string; label: string; hint: string; slots: TileSlot[] }[] = [
  { id: 'cols2', label: '左右两分', hint: '两等分：适合 掌中界 + 一个设计软件', slots: [{ x: 0, y: 0, w: .5, h: 1 }, { x: .5, y: 0, w: .5, h: 1 }] },
  { id: 'rows2', label: '上下两分', hint: '两等分：适合 掌中界 + 参考图/视频', slots: [{ x: 0, y: 0, w: 1, h: .5 }, { x: 0, y: .5, w: 1, h: .5 }] },
  { id: 'cols3', label: '三列', hint: '三等分：掌中界 + 两个程序', slots: [{ x: 0, y: 0, w: 1 / 3, h: 1 }, { x: 1 / 3, y: 0, w: 1 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: 1 }] },
  { id: 'cols4', label: '四列', hint: '四等分：掌中界 + 三个程序', slots: [{ x: 0, y: 0, w: .25, h: 1 }, { x: .25, y: 0, w: .25, h: 1 }, { x: .5, y: 0, w: .25, h: 1 }, { x: .75, y: 0, w: .25, h: 1 }] },
  { id: 'grid2x2', label: '四宫格', hint: '2×2：掌中界 + 三个程序', slots: [{ x: 0, y: 0, w: .5, h: .5 }, { x: .5, y: 0, w: .5, h: .5 }, { x: 0, y: .5, w: .5, h: .5 }, { x: .5, y: .5, w: .5, h: .5 }] },
  { id: 'mainLeft2', label: '左大右二', hint: '左边大格给主体，右边上下放两个', slots: [{ x: 0, y: 0, w: 2 / 3, h: 1 }, { x: 2 / 3, y: 0, w: 1 / 3, h: .5 }, { x: 2 / 3, y: .5, w: 1 / 3, h: .5 }] },
  { id: 'mainRight2', label: '右大左二', hint: '右边大格，左边上下放两个', slots: [{ x: 0, y: 0, w: 1 / 3, h: .5 }, { x: 0, y: .5, w: 1 / 3, h: .5 }, { x: 1 / 3, y: 0, w: 2 / 3, h: 1 }] },
  { id: 'mainTop2', label: '上大下二', hint: '上面大格，下面并排两个', slots: [{ x: 0, y: 0, w: 1, h: 2 / 3 }, { x: 0, y: 2 / 3, w: .5, h: 1 / 3 }, { x: .5, y: 2 / 3, w: .5, h: 1 / 3 }] },
]

// 分屏 / 布局时按元素自己的长宽比等比放进槽位（槽位只定位置和外框，尺寸在内侧居中缩放）。
// 用户 2026-09-14：「点了分屏布局 图片的比例全都乱了」「要统一比例 不能动之前分屏后的比例」。
const RATIO_KEEPING_KINDS = new Set<string>(['image', 'reference', 'portal', 'video'])
// 文件 / 快捷方式图标是「固定尺寸」的：它们本来就没有放大缩小这回事，分屏时只挪位置、不改尺寸。
// 用户 2026-09-14：「文件类的不能放大缩小；图片、网页、文件管理器这样的都有放大缩小」——布局要以能缩放的为主。
const FIXED_SIZE_KINDS = new Set<string>(['icon'])
const fitInSlot = (item: { kind: string; w: number; h: number }, slot: { x: number; y: number; w: number; h: number }) => {
  if (FIXED_SIZE_KINDS.has(item.kind)) {
    return {
      x: slot.x + Math.max(0, (slot.w - item.w) / 2),
      y: slot.y + Math.max(0, (slot.h - item.h) / 2),
      w: item.w,
      h: item.h,
    }
  }
  if (!RATIO_KEEPING_KINDS.has(item.kind) || item.w <= 0 || item.h <= 0) return { ...slot }
  const ratio = item.w / item.h
  let w = slot.w
  let h = w / ratio
  if (h > slot.h) { h = slot.h; w = h * ratio }
  return { x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h }
}

const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  workspace: '画布',
  video: '网页 / 视频',
  portal: '参考图板',
  web: '网页',
  folder: '文件夹',
  shellview: '系统文件视图验证',
  note: '便签',
  shelf: '剪贴暂存',
  reference: '文件引用',
  image: '图片',
  app: '应用',
  desktop: '桌面',
  icon: '快捷方式',
}
type Viewport = { x: number; y: number; scale: number }
type FixedEntry = { icon: string; label: string; target: string; tone: string; source?: string; sourceKind?: 'file' | 'folder' | 'app'; image?: string }
type LayoutKind = 'two' | 'three' | 'grid' | 'custom'
type SplitMode = 'columns-equal' | 'rows-equal' | 'columns-wide' | 'rows-wide'
type WorkspacePaneKind = 'chooser' | 'canvas' | 'web' | 'folder' | 'blank'
// Blender 式递归分屏：叶子视口可以被任意一条边继续切开，切出来的新视口
// 还能接着切。交接文档 22 P1「删除只能分一次的单层 workspaceSplit 限制，
// 改为递归分支节点 + 叶子视口布局树」。
type SplitLeafNode = { type: 'leaf'; id: string; kind: WorkspacePaneKind; source?: string; treeOpen?: boolean }
type SplitBranchNode = { type: 'branch'; id: string; orientation: 'columns' | 'rows'; ratio: number; first: SplitNode; second: SplitNode }
type SplitNode = SplitLeafNode | SplitBranchNode
type WorkspaceSplitLayout = SplitNode
type SplitEdge = 'left' | 'right' | 'top' | 'bottom'

type ShellEntry = {
  name: string
  path: string
  typeText: string
  modified: string
  modifiedStamp?: number
  image?: string
  thumbKind?: 'thumbnail' | 'icon'
  size: number
  width?: number
  height?: number
  durationMs?: number
  folderSize?: number
  folder: boolean
  hidden: boolean
  shortcut: boolean
  parentPath?: string
}

type ShellTreeNode = {
  name: string
  path: string
  image?: string
  expandable: boolean
  modifiedText?: string
  totalBytes?: number
  freeBytes?: number
  size?: number
  folder?: boolean
}
type ShellPreviewTarget = { surfaceId: string; entry: ShellEntry; siblings: ShellEntry[] }
type RecentFolder = { path: string; label: string; visitedAt: number }
type ShellPreviewData = {
  surfaceId: string
  path: string
  parentPath: string
  name: string
  typeText: string
  modified: string
  size: number
  previewKind: 'thumbnail' | 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'folder' | 'archive'
  resource?: string
  image?: string
  text?: string
  created?: string
  readOnly?: boolean
  hidden?: boolean
  width?: number
  height?: number
  durationMs?: number
  codec?: string
  colorMode?: string
  pageCount?: number
  folderFileCount?: number
  folderFolderCount?: number
  folderTotalSize?: number
  children?: { name: string; path: string; typeText: string; size: number; folder: boolean; image?: string }[]
}

type TileWindowOption = { handle: string; title: string; process?: string }

type NativeHostMessage = {
  type: string
  ok?: boolean
  done?: boolean
  systemSnap?: boolean
  partner?: boolean
  destination?: string
  copied?: number
  missing?: number
  shortcutId?: string
  capabilities?: string[]
  defaultBrowser?: string
  bookmarks?: { name: string; url: string; folder?: string }[]
  bookmarksTruncated?: boolean
  surfaceId?: string
  source?: string
  title?: string
  uri?: string
  image?: string
  dataUrl?: string
  clipboardCopied?: boolean
  thumbKind?: 'thumbnail' | 'icon'
  paths?: { path: string; folder: boolean; displayName?: string; projectKind?: 'directory' | 'archive'; projectPath?: string }[]
  opened?: boolean
  hasDrop?: boolean
  dark?: boolean
  material?: string
  supported?: boolean
  selection?: number
  select?: boolean
  trail?: string
  displayName?: string
  generation?: number
  entries?: ShellEntry[]
  count?: number
  fallback?: boolean
  archive?: boolean
  archiveRoot?: string
  mirrorArchive?: string
  mirrorRoot?: string
  purpose?: string
  parent?: string
  nodes?: ShellTreeNode[]
  path?: string
  parentPath?: string
  name?: string
  typeText?: string
  modified?: string
  size?: number
  previewKind?: 'thumbnail' | 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'folder' | 'archive'
  resource?: string
  text?: string
  created?: string
  readOnly?: boolean
  hidden?: boolean
  width?: number
  height?: number
  durationMs?: number
  codec?: string
  colorMode?: string
  pageCount?: number
  folderFileCount?: number
  folderFolderCount?: number
  folderTotalSize?: number
  children?: { name: string; path: string; typeText: string; size: number; folder: boolean; image?: string }[]
  clientX?: number
  clientY?: number
  rawX?: number
  rawY?: number
  screenX?: number
  screenY?: number
  delta?: number
  phase?: 'begin' | 'move' | 'end'
  windowLeft?: number
  windowTop?: number
  dpi?: number
  completed?: boolean
  kind?: 'files' | 'image' | 'web' | 'folder' | 'text' | 'empty'
  filePaths?: string[]
  item?: ClipboardHistoryEntry
  items?: ClipboardHistoryEntry[]
  auto?: boolean
  canvasMode?: boolean
  itemId?: string
  success?: boolean
  cancelled?: boolean
  error?: string
  mode?: 'save' | 'saveAs' | 'export'
  projectJson?: string
  projectPath?: string
  projectTitle?: string
  legacyDirectory?: boolean
  packageRoot?: string
  previousPackageRoot?: string
  migratedFrom?: string
  assets?: ProjectAsset[]
  recents?: string[]
  dirty?: boolean
  requestId?: string
  enabled?: boolean
  webThemeMode?: WebThemeMode
  effective?: boolean
  degraded?: boolean
  restartRequired?: boolean
  maximized?: boolean
  inside?: boolean
  edge?: string
  settings?: Partial<AppSettings>
  settingsNotice?: string
  message?: string
  backend?: 'everything' | 'fallback'
  status?: 'running' | 'installed-not-running' | 'not-installed' | 'unavailable'
  windows?: TileWindowOption[]
}

function CanvasMenu({ x, y, children, onPointerDown }: { x: number; y: number; children: ReactNode; onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void }) {
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const margin = 8
    const left = x + rect.width <= window.innerWidth - margin
      ? x
      : Math.max(margin, x - rect.width)
    const top = y + rect.height <= window.innerHeight - margin
      ? y
      : Math.max(margin, y - rect.height)
    menu.style.left = `${Math.min(left, Math.max(margin, window.innerWidth - rect.width - margin))}px`
    menu.style.top = `${Math.min(top, Math.max(margin, window.innerHeight - rect.height - margin))}px`
  }, [x, y, children])
  return <div ref={menuRef} className="canvas-menu" role="menu" style={{ left: x, top: y }} onPointerDown={onPointerDown}>{children}</div>
}

function ShortcutText({ id }: { id: ShortcutId }) {
  const [bindings, setBindings] = useState(() => readBrowserSettings().shortcutBindings)
  useEffect(() => {
    const receive = (event: Event) => setBindings((event as CustomEvent<AppSettings>).detail.shortcutBindings)
    window.addEventListener(APP_SETTINGS_EVENT, receive)
    return () => window.removeEventListener(APP_SETTINGS_EVENT, receive)
  }, [])
  return <>{shortcutDisplay(bindings, id)}</>
}

type NativeWebViewBridge = {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', listener: (event: MessageEvent<NativeHostMessage>) => void) => void
  removeEventListener: (type: 'message', listener: (event: MessageEvent<NativeHostMessage>) => void) => void
}

type SaveNamePromptState = {
  mode: 'save' | 'saveAs'
  name: string
  requestedByClose: boolean
  saving: boolean
  error: string
}

type ProjectOpenRequest = {
  path?: string
  archive: boolean
  legacyDirectory?: boolean
  label: string
  error?: string
}

declare global {
  interface Window {
    chrome?: { webview?: NativeWebViewBridge }
  }
}

type CachedShellImage = Pick<ShellEntry, 'image' | 'thumbKind' | 'width' | 'height' | 'durationMs'>
const shellImageCache = new Map<string, CachedShellImage>()
type FileManagerSnapshot = {
  entries: ShellEntry[]
  activePath: string
  trail: string[]
  treeChildren: Map<string, ShellTreeNode[]>
  expandedTreePaths: Set<string>
  archiveRoot: string
  treeScrollTop: number
  listScrollTop: number
}
const fileManagerSnapshots = new Map<string, FileManagerSnapshot>()
const rememberFileManagerSnapshot = (itemId: string, snapshot: FileManagerSnapshot) => {
  const previous = fileManagerSnapshots.get(itemId)
  const treeChildren = new Map(snapshot.treeChildren)
  if (previous?.archiveRoot === snapshot.archiveRoot) {
    for (const [path, nodes] of previous.treeChildren) {
      if (!treeChildren.has(path)) treeChildren.set(path, nodes)
    }
  }
  fileManagerSnapshots.delete(itemId)
  if (fileManagerSnapshots.size >= 12) {
    const oldest = fileManagerSnapshots.keys().next().value
    if (oldest) fileManagerSnapshots.delete(oldest)
  }
  fileManagerSnapshots.set(itemId, { ...snapshot, treeChildren })
}
const shellImageCacheKey = (path: string) => path.replace(/\//g, '\\').toLocaleLowerCase()
const cachedShellImage = (path: string) => shellImageCache.get(shellImageCacheKey(path))
const cacheShellImage = (entry: Pick<ShellEntry, 'path'> & Partial<CachedShellImage>) => {
  if (!entry.path) return
  const key = shellImageCacheKey(entry.path)
  const cached = shellImageCache.get(key)
  const cacheableImage = entry.image?.startsWith('data:image/') ? entry.image : undefined
  if (!cacheableImage && !cached?.image) return
  if (!cached && shellImageCache.size >= 512) {
    const oldest = shellImageCache.keys().next().value
    if (oldest) shellImageCache.delete(oldest)
  }
  shellImageCache.set(key, {
    image: cacheableImage || cached?.image,
    thumbKind: entry.thumbKind ?? cached?.thumbKind,
    width: entry.width ?? cached?.width,
    height: entry.height ?? cached?.height,
    durationMs: entry.durationMs ?? cached?.durationMs,
  })
}
const clearShellImageCache = () => shellImageCache.clear()

const postNativeBrowserCommand = (surfaceId: string | undefined, command: 'back' | 'forward' | 'reload') => {
  if (!surfaceId) return
  window.chrome?.webview?.postMessage({ type: 'native-browser-command', surfaceId, command })
}

const postNativeExplorerCommand = (surfaceId: string | undefined, command: 'back' | 'forward' | 'up' | 'home' | 'reload' | 'cut' | 'copy' | 'paste' | 'rename' | 'delete' | 'new' | 'new-txt' | 'new-md' | 'new-html' | 'view' | 'sort' | 'more' | 'view-details' | 'view-tiles') => {
  if (!surfaceId) return
  if (command === 'reload') clearShellImageCache()
  window.chrome?.webview?.postMessage({ type: 'native-explorer-command', surfaceId, command })
}

const postNativeExplorerSelection = (surfaceId: string, paths: string[]) => {
  window.chrome?.webview?.postMessage({ type: 'native-explorer-selection', surfaceId, paths })
}

const postNativeExplorerOpen = (surfaceId: string, path: string) => {
  window.chrome?.webview?.postMessage({ type: 'native-explorer-open', surfaceId, path })
}

const postNativeExplorerRename = (surfaceId: string, path: string, name: string) => {
  window.chrome?.webview?.postMessage({ type: 'native-explorer-rename', surfaceId, path, name })
}

const postNativeExplorerContextMenu = (surfaceId: string, paths: string[], screenX: number, screenY: number) => {
  const nativeScale = window.devicePixelRatio || 1
  window.chrome?.webview?.postMessage({
    type: 'native-explorer-context-menu',
    surfaceId,
    paths,
    screenX: Math.round(screenX * nativeScale),
    screenY: Math.round(screenY * nativeScale),
  })
}

const postNativeShellContextMenu = (paths: string[], screenX: number, screenY: number) => {
  const nativeScale = window.devicePixelRatio || 1
  window.chrome?.webview?.postMessage({
    type: 'native-shell-context-menu',
    paths,
    screenX: Math.round(screenX * nativeScale),
    screenY: Math.round(screenY * nativeScale),
  })
}

const postNativeExplorerTreeRequest = (surfaceId: string, parent = '', includeFiles = false, purpose = '') => {
  window.chrome?.webview?.postMessage({ type: 'native-explorer-tree-request', surfaceId, parent, includeFiles, purpose })
}

type CanvasItem = {
  id: string
  canvasId: string
  kind: ItemKind
  title: string
  x: number
  y: number
  w: number
  h: number
  childCanvasId?: string
  groupId?: string
  /** 画布内的层序（越大越靠上）；没设过就按数组顺序 */
  layer?: number
  pinned?: boolean
  pinX?: number
  pinY?: number
  pinW?: number
  pinH?: number
  accent?: string
  text?: string      // 便签正文
  /** 待办清单：带上这个字段的便签卡就渲染成勾选清单（模板套用时勾选自动清零） */
  todo?: TodoEntry[]
  shelfItems?: { id: string; kind?: 'text' | 'image' | 'files'; text: string; path?: string; paths?: string[]; width?: number; height?: number; at: number }[]  // 剪贴暂存：只存路径/文本引用
  dataUrl?: string   // 嵌入图片，原始分辨率的 data URL
  assetPath?: string // 项目包 assets/ 内的相对路径，只在持久化格式中使用
  subtitle?: string
  source?: string
  workspaceSplit?: WorkspaceSplitLayout
  fileTreeOpen?: boolean
  immersive?: boolean          // 纯画面（桌布）模式：只剩画面，双击/ Esc 退出
  videoOnly?: boolean          // 纯视频窗口：把网页里的播放器抠到整张卡片上（纯画面 + 页面内的 <video> 拉满）
  pipMode?: boolean            // 画中画模式：无边框 + 页面里双击视频就进/出浏览器画中画（用户 2026-09-13 要求）
  pipHidden?: boolean          // 进了系统画中画时把这张卡（连同原生网页窗口）藏起来；退出画中画自动恢复。运行时专用，不写进会话快照
  desktopIcons?: { name: string; path: string; image?: string }[]   // 桌面卡：缓存下来的桌面图标（只存引用，不改真实桌面）
  desktopLayout?: Record<string, { x: number; y: number }>     // 桌面卡：手动摆过位置的图标坐标（没有位置的就自动排网格）
  desktopSort?: 'name' | 'type'                               // 桌面卡：自动排列时的排序依据
  desktopIconSize?: 'large' | 'medium' | 'small'               // 桌面卡：图标大小三档（默认大）
  volume?: number              // 网页卡音量 0~1（地址行那个拉杆）；未设置过就沿用站点自己的默认音量
  cardMinimized?: boolean
  searchQuery?: string
  searchRoot?: string
  initialSelectionPath?: string
}// 右键菜单的一行：带 children 的行会展开成二级选项（层序那组用）
type ContextMenuAction = { label: string; icon: string; shortcutId?: ShortcutId; hint?: string; action?: () => void; children?: ContextMenuAction[] }
type ContextMenuRow = ContextMenuAction | 'sep'



const MAX_CANVAS_LEVEL = 2 as const
// 全局常用收藏组的每排位数：与「全局常用 第 N 位」快捷键一一对应，滚轮切排、快捷键继承当前排。
const GLOBAL_FAVORITE_PAGE_SIZE = 9

type SpaceCanvas = {
  id: string
  title: string
  level: 1 | typeof MAX_CANVAS_LEVEL
  parentCanvasId?: string
  hostItemId?: string
  viewport: Viewport
  fixedEntries: FixedEntry[]
  originTemplate?: { name: string; path?: string }
  generated?: boolean
}

type Session = {
  version: 5
  savedAt: number
  items: CanvasItem[]
  spaces: SpaceCanvas[]
  theme: Theme
  focusedWorkspaceId?: string | null
  activeCanvasId?: string
  recentFolders: RecentFolder[]
}

type ExternalRoot = { id: string; path: string; label: string }
type ProjectAsset = { path: string; dataUrl: string }
type ProjectExternal = { path: string; archivePath: string; folder: boolean }
type PersistedProject = {
  format: 'zhangzhongjie-project'
  version: 1
  savedAt: number
  title: string
  session: Session
  externalRoots: ExternalRoot[]
}

type Snapshot = { items: CanvasItem[]; spaces: SpaceCanvas[] }
type Point = { x: number; y: number }
type ItemPatch = Partial<Pick<CanvasItem, 'x' | 'y' | 'w' | 'h'>>

const STORAGE_KEY = 'zhangzhongjie.prototype.session.v4'
const WEB_FORCE_DARK_KEY = 'zhangzhongjie.web-force-dark'
const BROWSER_SETTINGS_KEY = 'zhangzhongjie.settings.v1'
// 空间导航器开关：只存网页侧，避免和宿主 settings 回声打架（新字段被回声抹掉过一次）。
const SPACE_NAVIGATOR_KEY = 'zhangzhongjie.space-navigator'
// 上次一起分屏的程序（进程名），下次打开面板自动勾上。
const SPLIT_APPS_KEY = 'zhangzhongjie.split-apps'
// 空间导航器被拖走后的位置（窗口坐标）。
const NAVIGATOR_POS_KEY = 'zhangzhongjie.navigator-pos'

// Native surfaces live above the application WebView. A shared occlusion edge
// lets every independently sleeping surface consume the same toolbar clip.
let nativeChromeOcclusionBottom = 0
const SURFACE_OCCLUSION_EVENT = 'zhangzhongjie-surface-occlusion-changed'
const NATIVE_SURFACE_HOVER_EVENT = 'zhangzhongjie-native-surface-hover-changed'
const MEDIA_HOVER_EVENT = 'zhangzhongjie-media-hover-changed'
const FILE_PREVIEW_ASPECT_EVENT = 'zhangzhongjie-file-preview-aspect'
const CANVAS_ZOOM_EVENT = 'zhangzhongjie-canvas-zoom'
const CANVAS_PAN_EVENT = 'zhangzhongjie-canvas-pan'
const CANVAS_SCALE_EVENT = 'zhangzhongjie-canvas-scale-changed'
const RECENT_FOLDERS_EVENT = 'zhangzhongjie-recent-folders-changed'
const SHELL_PREVIEW_OPEN_EVENT = 'zhangzhongjie-shell-preview-open'
const FILE_PANEL_STATE_EVENT = 'zhangzhongjie-file-panel-state'
const FILE_WORKSPACE_SPLIT_EVENT = 'zhangzhongjie-file-workspace-split'
const FILE_ADDRESS_EDIT_EVENT = 'zhangzhongjie-file-address-edit'
// 「打开位置」/ 定位到某个文件夹后，让那张文件卡的目录树把这一路展开并高亮
const FILE_TREE_REVEAL_EVENT = 'zhangzhongjie-file-tree-reveal'
const MEDIA_PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const
let activeMediaHover: { ownerId: string; path: string } | null = null
let sharedRecentFolders: RecentFolder[] = []

function replaceSharedRecentFolders(folders: RecentFolder[]) {
  sharedRecentFolders = folders.slice(0, 15)
  window.dispatchEvent(new CustomEvent<RecentFolder[]>(RECENT_FOLDERS_EVENT, { detail: sharedRecentFolders }))
}

function rememberRecentFolder(path: string, label?: string) {
  const normalized = path.trim()
  if (!normalized) return
  const display = label?.trim() || (normalized === 'shell:MyComputerFolder' ? '此电脑' : normalized.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1)) || normalized
  replaceSharedRecentFolders([
    { path: normalized, label: display, visitedAt: Date.now() },
    ...sharedRecentFolders.filter((entry) => entry.path.toLocaleLowerCase() !== normalized.toLocaleLowerCase()),
  ])
}

function publishMediaHover(ownerId: string, path: string | null) {
  if (!path && activeMediaHover?.ownerId !== ownerId) return
  activeMediaHover = path ? { ownerId, path } : null
  window.dispatchEvent(new CustomEvent(MEDIA_HOVER_EVENT, { detail: activeMediaHover }))
}

function clearMediaHover(ownerId: string, path?: string) {
  if (activeMediaHover?.ownerId !== ownerId || (path && activeMediaHover.path !== path)) return
  activeMediaHover = null
  window.dispatchEvent(new CustomEvent(MEDIA_HOVER_EVENT, { detail: null }))
}
// Card titlebars are DOM overlays above HWND/DComp content. Store their logical
// height by owning card; each NativeSurfaceSlot converts it through the current
// canvas transform before composing it with the global toolbar clip.
const nativeCardOcclusionHeights = new Map<string, number>()
const defaultSettings: AppSettings = {
  version: 2,
  windowAppearance: 'borderless',
  windowMaterial: 'mica',
  toolbarVisibility: 'auto',
  cardTitlebarVisibility: 'hover',
  appTheme: 'system',
  webThemeMode: 'dark',
  fileTreeCollapsed: false,
  fileViewMode: 'details',
  fileTreeIconSize: 'small',
  fileIconMode: 'system',
  fileGroupByName: true,
  fileColumns: ['name', 'modified', 'type', 'size'],
  fileColumnWidths: {},
  fileTreeWidths: {},
  fileTreeColumnWidths: {},
  previewNameColumnWidth: 210,
  mediaMuted: true,
  mediaPlaybackRate: 1,
  everythingPromptDismissed: false,
  exportFolder: '',
  explorerContextMenuEnabled: true,
  webBookmarks: [],
  browserZoom: {},
  browserHistory: [],
  browserUserAgent: 'default',
  browserGroupOrder: [],
  globalQuickActions: ['computer', 'web', 'todo', 'shelf'],
  globalFavorites: [],
  globalFixedOrder: ['quick-computer', 'quick-web', 'quick-todo', 'quick-shelf'],
  shortcutBindings: DEFAULT_SHORTCUT_BINDINGS,
  petModel: '',
  ocrLanguage: 'zh-Hans-CN',
  uiMotion: 'light',
  canvasSkin: 'default',
  uiScale: 1,
  settingsWidth: 620,
  settingsHeight: 720,
}

const previousDefaultFileColumns: FileColumnKey[] = ['name', 'type', 'dimensions', 'duration', 'modified', 'size']
const hasPreviousDefaultFileColumns = (value: unknown) => Array.isArray(value) && value.length === previousDefaultFileColumns.length &&
  previousDefaultFileColumns.every((column, index) => value[index] === column)

function normalizeSettings(value: unknown): AppSettings {
  const candidate = value && typeof value === 'object' ? value as Partial<AppSettings> : {}
  const allowedColumns: FileColumnKey[] = ['name', 'type', 'dimensions', 'duration', 'modified', 'size']
  const requestedColumns = Array.isArray(candidate.fileColumns)
    ? candidate.fileColumns.filter((column): column is FileColumnKey => allowedColumns.includes(column as FileColumnKey))
    : defaultSettings.fileColumns
  const fileColumns = candidate.version !== 2 && hasPreviousDefaultFileColumns(candidate.fileColumns)
    ? [...defaultSettings.fileColumns]
    : allowedColumns.filter((column) => column === 'name' || requestedColumns.includes(column))
  const mediaPlaybackRate = MEDIA_PLAYBACK_RATES.includes(candidate.mediaPlaybackRate as typeof MEDIA_PLAYBACK_RATES[number])
    ? candidate.mediaPlaybackRate as typeof MEDIA_PLAYBACK_RATES[number]
    : 1
  const fileColumnWidths: AppSettings['fileColumnWidths'] = {}
  if (candidate.fileColumnWidths && typeof candidate.fileColumnWidths === 'object') {
    for (const [cardId, widths] of Object.entries(candidate.fileColumnWidths)) {
      if (!cardId || cardId === '__proto__' || cardId === 'constructor' || cardId === 'prototype' || !widths || typeof widths !== 'object') continue
      const sanitized: Partial<Record<FileColumnKey, number>> = {}
      for (const column of allowedColumns) {
        const width = (widths as Partial<Record<FileColumnKey, unknown>>)[column]
        if (typeof width === 'number' && Number.isFinite(width)) sanitized[column] = clamp(Math.round(width), column === 'name' ? 140 : 70, 1200)
      }
      if (Object.keys(sanitized).length) fileColumnWidths[cardId] = sanitized
    }
  }
  const fileTreeWidths: AppSettings['fileTreeWidths'] = {}
  if (candidate.fileTreeWidths && typeof candidate.fileTreeWidths === 'object') {
    for (const [cardId, width] of Object.entries(candidate.fileTreeWidths)) {
      if (!cardId || cardId === '__proto__' || cardId === 'constructor' || cardId === 'prototype') continue
      if (typeof width === 'number' && Number.isFinite(width)) fileTreeWidths[cardId] = clamp(Math.round(width), 200, 2000)
    }
  }
  const fileTreeColumnWidths: AppSettings['fileTreeColumnWidths'] = {}
  if (candidate.fileTreeColumnWidths && typeof candidate.fileTreeColumnWidths === 'object') {
    for (const [cardId, width] of Object.entries(candidate.fileTreeColumnWidths)) {
      if (!cardId || cardId === '__proto__' || cardId === 'constructor' || cardId === 'prototype') continue
      if (typeof width === 'number' && Number.isFinite(width)) fileTreeColumnWidths[cardId] = clamp(Math.round(width), 80, 1200)
    }
  }
  const webBookmarks = Array.isArray(candidate.webBookmarks)
    ? candidate.webBookmarks.flatMap((bookmark, index) => {
      if (!bookmark || typeof bookmark !== 'object') return []
      const entry = bookmark as Partial<WebBookmark>
      const url = typeof entry.url === 'string' ? entry.url.trim().slice(0, 4096) : ''
      // ⚠ 这里只认 http/https 会**静默丢掉本地网页（file://）的收藏**：
      // 前端加进收藏 → 原生回显 → 归一化时被洗掉 → 表现为「点了收藏没反应 / 重启后没了」。（2026-09-14 修）
      if (!/^(https?|file):\/\//i.test(url)) return []
      const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 120) : url
      const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim().slice(0, 120) : `bookmark-${index}-${url}`
      const group = typeof entry.group === 'string' && entry.group.trim() ? entry.group.trim().slice(0, 24) : undefined
      return [{ id, name, url, ...(group ? { group } : {}) }]
    }).slice(0, 400)
    : []
    const browserZoom: Record<string, number> = {}
    if (candidate.browserZoom && typeof candidate.browserZoom === 'object') {
      for (const [host, factor] of Object.entries(candidate.browserZoom)) {
        if (!host || host === '__proto__' || host === 'constructor' || host === 'prototype') continue
        if (typeof factor === 'number' && Number.isFinite(factor)) browserZoom[host.slice(0, 255)] = clamp(Math.round(factor * 100) / 100, 0.25, 3)
      }
    }
    const browserHistory = Array.isArray(candidate.browserHistory)
      ? candidate.browserHistory.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)).map((url) => url.slice(0, 4096)).slice(0, 60)
      : []
    const browserUserAgent: 'default' | 'chrome' = candidate.browserUserAgent === 'chrome' ? 'chrome' : 'default'
    const browserGroupOrder = Array.isArray(candidate.browserGroupOrder)
      ? [...new Set(candidate.browserGroupOrder.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())).map((name) => name.trim().slice(0, 24)))].slice(0, 40)
      : []
  // 2026-09-13 用户要求：「空间导航器 右上角已经有了 就可以把左边框的这个空间导航器删掉了」
  // → 从快捷栏的可选项里去掉 navigator（老设置里存过的也会被下面的过滤丢掉），顶部工具条那个入口保留。
  const allowedQuickActions: GlobalQuickAction[] = ['computer', 'web', 'todo', 'shelf']
  const requestedQuickActions = Array.isArray(candidate.globalQuickActions)
    ? candidate.globalQuickActions.filter((action): action is GlobalQuickAction => allowedQuickActions.includes(action as GlobalQuickAction))
    : []
  const hasRetiredQuickAction = Array.isArray(candidate.globalQuickActions) && (candidate.globalQuickActions as unknown[]).some((action) => action === 'folder' || action === 'note')
  const globalQuickActions = requestedQuickActions.length && !hasRetiredQuickAction
    ? [...new Set(requestedQuickActions)]
    : [...defaultSettings.globalQuickActions]
  const seenFavoriteSources = new Set<string>()
  const globalFavorites = Array.isArray(candidate.globalFavorites)
    ? candidate.globalFavorites.flatMap((favorite, index) => {
      if (!favorite || typeof favorite !== 'object') return []
      const entry = favorite as Partial<GlobalFavorite>
      const source = typeof entry.source === 'string' ? entry.source.trim().slice(0, 32767) : ''
      if (!source || source.toLocaleLowerCase() === 'shell:mycomputerfolder' || (entry.sourceKind !== 'file' && entry.sourceKind !== 'folder' && entry.sourceKind !== 'app')) return []
      const sourceKey = `${entry.sourceKind}:${source.toLocaleLowerCase()}`
      if (seenFavoriteSources.has(sourceKey)) return []
      seenFavoriteSources.add(sourceKey)
      const id = typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim().slice(0, 160)
        : `global-favorite-${index}-${source}`.slice(0, 160)
      const fallbackLabel = source.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || source
      const label = typeof entry.label === 'string' && entry.label.trim()
        ? entry.label.trim().slice(0, 120)
        : fallbackLabel.slice(0, 120)
      const image = typeof entry.image === 'string' && entry.image.startsWith('data:image/') && entry.image.length <= 524288
        ? entry.image
        : undefined
      return [{ id, label, source, sourceKind: entry.sourceKind, image }]
    }).slice(0, 200)
    : []
  const availableGlobalTargets = [
    ...globalQuickActions.map((action) => `quick-${action}`),
    ...globalFavorites.map((favorite) => favorite.id),
  ]
  const availableGlobalTargetSet = new Set(availableGlobalTargets)
  const requestedGlobalOrder = Array.isArray(candidate.globalFixedOrder) && !candidate.globalFixedOrder.includes('quick-folder')
    ? candidate.globalFixedOrder.filter((target): target is string => typeof target === 'string' && availableGlobalTargetSet.has(target))
    : globalQuickActions.map((action) => `quick-${action}`)
  const globalFixedOrder = [...new Set([...requestedGlobalOrder, ...availableGlobalTargets])]
  return {
    version: 2,
    windowAppearance: candidate.windowAppearance === 'system' ? 'system' : 'borderless',
    windowMaterial: candidate.windowMaterial === 'solid' ? 'solid' : 'mica',
    toolbarVisibility: candidate.toolbarVisibility === 'always' ? 'always' : 'auto',
    cardTitlebarVisibility: candidate.cardTitlebarVisibility === 'always' ? 'always' : 'hover',
    appTheme: candidate.appTheme === 'light' || candidate.appTheme === 'dark' ? candidate.appTheme : 'system',
    webThemeMode: candidate.webThemeMode === 'follow' || candidate.webThemeMode === 'original' ? candidate.webThemeMode : 'dark',
    fileTreeCollapsed: candidate.fileTreeCollapsed === true,
    fileViewMode: candidate.fileViewMode === 'large-icons' || candidate.fileViewMode === 'media-grid' || candidate.fileViewMode === 'compact'
      ? candidate.fileViewMode
      : 'details',
    fileTreeIconSize: candidate.fileTreeIconSize === 'large' ? 'large' : 'small',
    fileIconMode: candidate.fileIconMode === 'vector' ? 'vector' : 'system',
    fileGroupByName: candidate.fileGroupByName !== false,
    fileColumns,
    fileColumnWidths,
    fileTreeWidths,
    fileTreeColumnWidths,
    previewNameColumnWidth: typeof candidate.previewNameColumnWidth === 'number' && Number.isFinite(candidate.previewNameColumnWidth)
      ? clamp(Math.round(candidate.previewNameColumnWidth), 100, 410) : defaultSettings.previewNameColumnWidth,
    mediaMuted: candidate.mediaMuted !== false,
    mediaPlaybackRate,
    everythingPromptDismissed: candidate.everythingPromptDismissed === true,
    exportFolder: typeof candidate.exportFolder === 'string' ? candidate.exportFolder : '',
    explorerContextMenuEnabled: candidate.explorerContextMenuEnabled !== false,
    webBookmarks,
    browserGroupOrder,
    browserZoom,
    browserHistory,
    browserUserAgent: candidate.browserUserAgent === 'chrome' ? 'chrome' : 'default',
    globalQuickActions,
    globalFavorites,
    globalFixedOrder,
    shortcutBindings: normalizeShortcutBindings(candidate.shortcutBindings),
    petModel: typeof candidate.petModel === 'string' ? candidate.petModel : '',
    ocrLanguage: typeof candidate.ocrLanguage === 'string' && candidate.ocrLanguage ? candidate.ocrLanguage : 'zh-Hans-CN',
    uiMotion: candidate.uiMotion === 'off' || candidate.uiMotion === 'full' ? candidate.uiMotion : 'light',
  canvasSkin: candidate.canvasSkin === 'board' ? 'board' : candidate.canvasSkin === 'board-dark' ? 'board-dark' : 'default',
  uiScale: typeof candidate.uiScale === 'number' && Number.isFinite(candidate.uiScale)
    ? Math.min(1.45, Math.max(0.85, candidate.uiScale))
    : 1,
    settingsWidth: typeof candidate.settingsWidth === 'number' && Number.isFinite(candidate.settingsWidth)
      ? clamp(Math.round(candidate.settingsWidth), 560, 2400) : defaultSettings.settingsWidth,
    settingsHeight: typeof candidate.settingsHeight === 'number' && Number.isFinite(candidate.settingsHeight)
      ? clamp(Math.round(candidate.settingsHeight), 420, 1600) : defaultSettings.settingsHeight,
  }
}

const APP_SETTINGS_EVENT = 'zhangzhongjie-app-settings-changed'
const APP_SHORTCUT_EVENT = 'zhangzhongjie-shortcut'
const GLOBAL_FAVORITE_REQUEST_EVENT = 'zhangzhongjie-global-favorite-request'
const NOTE_EDIT_START_EVENT = 'zhangzhongjie-note-edit-start'
const NOTE_COMMIT_EVENT = 'zhangzhongjie-note-commit'
const SHELF_COMMIT_EVENT = 'zhangzhongjie-shelf-commit'
const BROWSER_PROFILE_EVENT = 'zhangzhongjie-browser-profile-changed'
const WEB_CARD_NAVIGATE_EVENT = 'zhangzhongjie-web-card-navigate'

// 拿不到网站图标时用这枚灰地球兜底（Chrome 也是这么做的）：否则图标那一列会缺一块、看着像没对齐。
const FALLBACK_FAVICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.1" fill="none" stroke="#8c96a5" stroke-width="1.3"/><ellipse cx="8" cy="8" rx="2.7" ry="6.1" fill="none" stroke="#8c96a5" stroke-width="1.3"/><path d="M2 8h12" stroke="#8c96a5" stroke-width="1.3"/></svg>')
const faviconFallback = (event: React.SyntheticEvent<HTMLImageElement>) => {
  const img = event.currentTarget
  img.onerror = null
  if (img.src !== FALLBACK_FAVICON) img.src = FALLBACK_FAVICON
}
const WEB_CARD_AUDIO_EVENT = 'zhangzhongjie-web-card-audio'
const BROWSER_CARD_MORE_EVENT = 'zhangzhongjie-browser-card-more'
const UNSUPPORTED_ARCHIVE_EVENT = 'zhangzhongjie-unsupported-archive'

// 「让 Hermes 读这张图」：剪贴暂存 / 文件列表 / 超级预览 / 画布图片卡 都用这个事件发起，
// 由 App 统一走已有的「问 Hermes」通道（native-hermes-ask + image，一次一张）。
// 面板沿用底部输入栏那套：能复制、存成便签、还能「换个说法再问一次」。
const ASK_HERMES_IMAGE_EVENT = 'zhangzhongjie-ask-hermes-image'
const requestHermesReadImage = (path: string, anchor?: { x: number; y: number }) => {
  window.dispatchEvent(new CustomEvent(ASK_HERMES_IMAGE_EVENT, { detail: { path, anchor } }))
}
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i

// 「OCR 取字（本地）」：走 Windows 自带 OCR 引擎（离线、零体积、不花额度）。
// 语言在 设置→常规→OCR 取字语言 里选；韩文必须用 ko 模型、中文必须用 zh-Hans 模型。
const OCR_IMAGE_EVENT = 'zhangzhongjie-ocr-image'
const requestOcrImage = (path: string, anchor?: { x: number; y: number }) => {
  window.dispatchEvent(new CustomEvent(OCR_IMAGE_EVENT, { detail: { path, anchor } }))
}
// 统一的「读图 / 取字」入口：这四个位置只留一个按钮/菜单项，点开再选「Hermes 读图」还是「本地 OCR」。
// （用户觉得两个入口并排太啰嗦，2026-09-13）
const IMMERSIVE_TOGGLE_EVENT = 'zhangzhongjie-toggle-immersive'
const IMAGE_ACTION_EVENT = 'zhangzhongjie-image-action-menu'
const CARD_VOLUME_EVENT = 'zhangzhongjie-card-volume'
// 桌面卡：卡片内部要把「读到的新图标 / 手动摆的位置 / 排序」写回 item，统一走这个事件
const DESKTOP_CARD_EVENT = 'zhangzhongjie-desktop-card'
// 桌面卡里把图标拖出卡片 → 在画布上生成一个「裸图标」（App 侧统一建卡）
const DESKTOP_DRAG_OUT_EVENT = 'zhangzhongjie-desktop-drag-out'
// 裸图标吸附的网格（世界坐标）：和 Windows 桌面一样，拖完自动对齐成网格
const ICON_GRID_STEP_X = 128
const ICON_GRID_STEP_Y = 144
// 把画布上的图标拖到「全局常用」那一栏 → App 负责加进收藏（可重命名 / 设快捷键）
const GLOBAL_FAVORITE_EVENT = 'zhangzhongjie-add-global-favorite'
// 把画布上的卡片固定到「当前画布」那一栏（Ctrl+1..9 画布优先用它，没有再落到全局收藏）
const CURRENT_CANVAS_PIN_EVENT = 'zhangzhongjie-pin-current-canvas'
// 卡片右键 → 保存当前画布为模板（真正的保存逻辑在 App 里，卡片只负责发事件）
const SAVE_CANVAS_TEMPLATE_EVENT = 'zhangzhongjie-save-canvas-template'
const TEMPLATE_ORIGIN_KEY = 'zhangzhongjie.templateOrigin.v1'
function fixedEntryForItem(kind: string | undefined, target: string, label: string): FixedEntry {
  return {
    icon: kind === 'folder' ? '▰' : kind === 'portal' ? '◈' : kind === 'reference' ? '▧' : '◎',
    label,
    target,
    tone: kind === 'folder' ? 'folder' : kind === 'portal' ? 'cad' : 'canvas',
  }
}
// 裸图标右键菜单里的动作（自动排列/组合/删除…）→ App 统一执行
const ICON_ACTION_EVENT = 'zhangzhongjie-icon-action'
// 图标网格的两个开关（对应 Windows 桌面右键的「将图标与网格对齐」「自动排列图标」）
const ICON_SNAP_KEY = 'zhangzhongjie.iconSnap'
const ICON_AUTO_KEY = 'zhangzhongjie.iconAutoArrange'
const readIconToggle = (key: string, fallback: boolean) => { try { const value = localStorage.getItem(key); return value === null ? fallback : value === '1' } catch { return fallback } }   // 卡片里的音量拉杆 → App 统一处理（改 item + 下发原生）
const requestImageActionMenu = (path: string, anchor?: { x: number; y: number }) => {
  window.dispatchEvent(new CustomEvent(IMAGE_ACTION_EVENT, { detail: { path, anchor } }))
}
const UNSUPPORTED_ARCHIVE_EXTENSIONS = new Set(['.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'])
const MEDIA_EXTENSION_PATTERN = /\.(mp4|mkv|avi|mov|wmv|flv|rmvb|rm|rmt|webm|m4v|mpg|mpeg|ts|m2ts|mts|vob|3gp|mp3|flac|wav|m4a|aac|ogg|wma|ape|mka)$/i
const SEVENZIP_FM_PATH = 'C:\\Program Files\\7-Zip\\7zFM.exe'
function launchSevenZip(path: string) {
  window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: SEVENZIP_FM_PATH, args: `"${path}"` })
}
const UNSUPPORTED_ARCHIVE_PREVIEW_MESSAGE = '双击这个压缩包即可在卡片内浏览：掌中界用 7-Zip 解压成只读临时副本，不会改动原包'
function unsupportedArchiveExtension(path: string) {
  const extension = path.trim().toLocaleLowerCase().match(/(\.[^.\\/]+)$/)?.[1] ?? ''
  return UNSUPPORTED_ARCHIVE_EXTENSIONS.has(extension) ? extension : ''
}
function unsupportedArchiveBrowseMessage(extension: string) {
  return `正在打开 ${extension} 压缩包：首次会在卡片内解压成只读副本（不会改动原包，7 天后自动清理）`
}
function notifyUnsupportedArchive(path: string) {
  const extension = unsupportedArchiveExtension(path)
  if (extension) window.dispatchEvent(new CustomEvent(UNSUPPORTED_ARCHIVE_EVENT, { detail: extension }))
  return extension
}
type BrowserProfileState = {
  defaultBrowser: string
  bookmarks: { name: string; url: string; folder?: string }[]
  truncated: boolean
}
let sharedBrowserProfile: BrowserProfileState = {
  defaultBrowser: '系统默认浏览器',
  bookmarks: [],
  truncated: false,
}

// 收藏列表的权威来源是本机 localStorage（所有窗口共用同一份）。原生回洗可能是几毫秒~几百毫秒前的
// 旧快照，直接采纳会把用户刚做的「收藏 / 取消收藏」冲掉（用户看到的就是「点了没反应」）。
// 不一致时以本地为准，并把本地这份补发一次，让原生那边收敛；同一份内容不重复补发。
let lastBookmarkRepublishAt = 0
let lastBookmarkRepublishJson = ''
// 刚刚被本地删掉的收藏 URL：回洗若是旧快照会把它们带回来，这里按 URL + 时间窗口滤掉。
// （只滤「本地主动删的」，所以不会误伤别处新增的条目。）
const recentlyRemovedBookmarkUrls = new Map<string, number>()
const BOOKMARK_REMOVE_GRACE_MS = 6000
function noteBookmarkRemoval(urls: string[]) {
  const now = Date.now()
  for (const url of urls) if (url) recentlyRemovedBookmarkUrls.set(url, now)
  for (const [url, at] of recentlyRemovedBookmarkUrls) if (now - at > BOOKMARK_REMOVE_GRACE_MS) recentlyRemovedBookmarkUrls.delete(url)
}

// 快捷栏里拖动图标排序时，给一份「随手拖」的浮动预览（克隆原条目跟着鼠标走）。
// 之前只有原位变淡 + 落点指示线，被拖的那一项不会跟着鼠标 —— 用户 2026-09-14 报「不显示被拖的图标」。
// 快捷栏里拖动图标排序时：把**被拖的那一项本身**浮起来跟着鼠标走（不克隆 → 不受容器/媒体查询影响）。
// 之前只有原位变淡 + 落点指示线，被拖的那一项不会跟着鼠标 —— 用户 2026-09-14 报「不显示被拖的图标」。
function floatFixedEntry(element: HTMLElement | null | undefined) {
  if (!element) return
  element.classList.add('is-drag-floating')
  element.style.transition = 'none'
}
function moveFloatingFixedEntry(element: HTMLElement | null | undefined, dx: number, dy: number) {
  if (!element) return
  element.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`
}
function settleFloatingFixedEntry(element: HTMLElement | null | undefined) {
  if (!element) return
  element.classList.remove('is-drag-floating', 'is-dragging')
  element.style.transform = ''
  window.requestAnimationFrame(() => { element.style.transition = '' })
}
function publishSettingsPatch(patch: Partial<AppSettings>) {
  const next = normalizeSettings({ ...readBrowserSettings(), ...patch, version: 2 })
  localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(next))
  window.chrome?.webview?.postMessage({ type: 'native-settings-update', settings: next })
  window.dispatchEvent(new CustomEvent<AppSettings>(APP_SETTINGS_EVENT, { detail: next }))
}

// 浏览器专属设置（缩放记忆 / 历史 / UA 模式）只写本机：原生的设置白名单里没有它们，
// 一旦跟着 native-settings-update 发过去，原生回洗时会把它们抹掉（这个项目里已有同样的坑）。
function publishBrowserOnlySettings(patch: Partial<AppSettings>) {
  const next = normalizeSettings({ ...readBrowserSettings(), ...patch, version: 2 })
  localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent<AppSettings>(APP_SETTINGS_EVENT, { detail: next }))
}

function readBrowserSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(BROWSER_SETTINGS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      const normalized = normalizeSettings(parsed)
      if (parsed?.version !== 2 && hasPreviousDefaultFileColumns(parsed?.fileColumns)) {
        localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(normalized))
      }
      return normalized
    }
  } catch { /* Browser preview falls back to safe defaults. */ }
  return { ...defaultSettings, webThemeMode: readWebThemeMode() }
}

function readWebThemeMode(): WebThemeMode {
  const stored = localStorage.getItem(WEB_FORCE_DARK_KEY)
  if (stored === 'follow' || stored === 'dark' || stored === 'original') return stored
  // Migrate the previous boolean setting without silently changing an existing choice.
  if (stored === '1') return 'dark'
  if (stored === '0') return 'follow'
  return 'dark'
}
const ROOT_ID = 'canvas-root'

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

const ORGANIZE_GROUPS = [
  { key: 'canvas', label: '画布', kinds: ['workspace', 'portal'] },
  { key: 'files', label: '文件', kinds: ['folder'] },
  { key: 'web', label: '网页', kinds: ['web'] },
  { key: 'images', label: '图片', kinds: ['image', 'reference'] },
  { key: 'video', label: '视频', kinds: ['video'] },
  { key: 'notes', label: '便签', kinds: ['note'] },
] as const satisfies readonly { key: string; label: string; kinds: readonly ItemKind[] }[]

type OrganizedCanvasLayout = {
  positions: Map<string, Point>
  counts: { key: string; label: string; count: number }[]
  bounds: { x: number; y: number; w: number; h: number }
}

function readingOrder(items: CanvasItem[]) {
  const byTop = [...items].sort((first, second) => first.y - second.y || first.x - second.x || first.id.localeCompare(second.id))
  const rows: { anchorY: number; items: CanvasItem[] }[] = []
  for (const item of byTop) {
    const row = rows.at(-1)
    if (!row || item.y - row.anchorY > 40) rows.push({ anchorY: item.y, items: [item] })
    else row.items.push(item)
  }
  return rows.flatMap((row) => row.items.sort((first, second) => first.x - second.x || first.y - second.y || first.id.localeCompare(second.id)))
}

function buildOrganizedCanvasLayout(participants: CanvasItem[]): OrganizedCanvasLayout | null {
  if (participants.length < 2) return null
  const originX = Math.min(...participants.map((item) => item.x))
  const originY = Math.min(...participants.map((item) => item.y))
  const targetWidth = Math.max(1200, Math.ceil(Math.sqrt(participants.reduce((sum, item) => sum + item.w * item.h, 0) * 1.6)))
  const positions = new Map<string, Point>()
  const counts: OrganizedCanvasLayout['counts'] = []
  let groupTop = originY
  let maxRight = originX

  for (const group of ORGANIZE_GROUPS) {
    const members = readingOrder(participants.filter((item) => group.kinds.some((kind) => kind === item.kind)))
    if (!members.length) continue
    counts.push({ key: group.key, label: group.label, count: members.length })
    let x = originX
    let y = groupTop
    let rowHeight = 0
    for (const item of members) {
      if (x > originX && x + item.w > originX + targetWidth) {
        x = originX
        y += rowHeight + 24
        rowHeight = 0
      }
      positions.set(item.id, { x, y })
      maxRight = Math.max(maxRight, x + item.w)
      rowHeight = Math.max(rowHeight, item.h)
      x += item.w + 24
    }
    groupTop = y + rowHeight + 96
  }

  const bottom = groupTop - 96
  return { positions, counts, bounds: { x: originX, y: originY, w: Math.max(1, maxRight - originX), h: Math.max(1, bottom - originY) } }
}

function initialRootViewport(): Viewport {
  const width = typeof window === 'undefined' ? 1600 : window.innerWidth
  return { x: 22, y: 16, scale: Math.min(.74, Math.max(.48, (width - 70) / 2240)) }
}

function createSeedSpaces(): SpaceCanvas[] {
  return [{ id: ROOT_ID, title: '项目一', level: 1, viewport: initialRootViewport(), fixedEntries: [] }]
}

function createSeedItems(): CanvasItem[] {
  return []
}

function normalizeSession(value: unknown): Session | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Session> & { version?: number }
  if (!Array.isArray(candidate.items) || !Array.isArray(candidate.spaces)) return null
  const spaces = candidate.spaces.map((space) => ({
    ...space,
    viewport: space.viewport ?? { x: 0, y: 0, scale: 1 },
    fixedEntries: Array.isArray(space.fixedEntries) ? space.fixedEntries : [],
  })) as SpaceCanvas[]
  const recentFolders = Array.isArray(candidate.recentFolders) ? candidate.recentFolders.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const folder = entry as Partial<RecentFolder>
    if (typeof folder.path !== 'string' || !folder.path.trim()) return []
    return [{
      path: folder.path,
      label: typeof folder.label === 'string' && folder.label.trim() ? folder.label : folder.path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || folder.path,
      visitedAt: typeof folder.visitedAt === 'number' && Number.isFinite(folder.visitedAt) ? folder.visitedAt : 0,
    }]
  }).sort((left, right) => right.visitedAt - left.visitedAt).slice(0, 15) : []
  // Retired card kinds from older project files are ignored during load.
  const items = (candidate.items as unknown[]).filter((item): item is CanvasItem =>
    typeof item === 'object' && item !== null && (item as { kind?: unknown }).kind !== 'ai')
  return {
    version: 5,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : Date.now(),
    items,
    spaces,
    theme: candidate.theme === 'dark' || candidate.theme === 'light' ? candidate.theme : 'system',
    focusedWorkspaceId: candidate.focusedWorkspaceId ?? null,
    activeCanvasId: typeof candidate.activeCanvasId === 'string' ? candidate.activeCanvasId : ROOT_ID,
    recentFolders,
  }
}

function readSavedSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return normalizeSession(JSON.parse(raw))
  } catch {
    return null
  }
}

function sessionFromState(items: CanvasItem[], spaces: SpaceCanvas[], theme: Theme, focusedWorkspaceId: string | null, activeCanvasId: string): Session {
  // pipHidden 是「此刻正在画中画」的运行时状态，绝不能写进快照：否则下次启动那张卡会一直隐藏着。
  const persistableItems = items.map(({ pipHidden: _pipHidden, ...rest }) => rest)
  return { version: 5, savedAt: Date.now(), items: persistableItems, spaces, theme, focusedWorkspaceId, activeCanvasId, recentFolders: sharedRecentFolders }
}

function snapshotImageToken(dataUrl: string | undefined) {
  if (!dataUrl) return ''
  return `${dataUrl.length}:${dataUrl.slice(0, 48)}:${dataUrl.slice(-48)}`
}

function snapshotStructureSignature(items: CanvasItem[], spaces: SpaceCanvas[], theme: Theme,
                                    focusedWorkspaceId: string | null, activeCanvasId: string, recentFolders: RecentFolder[]) {
  return JSON.stringify({
    items: items.map(({ dataUrl, ...item }) => ({ ...item, imageToken: snapshotImageToken(dataUrl) })),
    spaces: spaces.map(({ viewport: _viewport, ...space }) => space),
    theme,
    focusedWorkspaceId,
    activeCanvasId,
    recentFolders,
  })
}

function buildSurfacePaintOrder(items: CanvasItem[]) {
  const result = new Map<string, number>()
  const byCanvas = new Map<string, CanvasItem[]>()
  for (const item of items) {
    const entries = byCanvas.get(item.canvasId) ?? []
    entries.push(item)
    byCanvas.set(item.canvasId, entries)
  }
  let order = 0
  const visit = (canvasId: string) => {
    const entries = byCanvas.get(canvasId) ?? []
    // 画布内层序：layer 小的在下层（PureRef 式的前后关系），没设过的按加入顺序
    for (const item of entries.filter((entry) => !entry.pinned).sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0))) {
      result.set(item.id, order++)
      if (item.childCanvasId) visit(item.childCanvasId)
    }
    for (const item of entries.filter((entry) => entry.pinned)) result.set(item.id, order++)
  }
  visit(ROOT_ID)
  // Corrupt/legacy sessions can contain detached canvas ids. Keep their native
  // surfaces deterministic without making the hot sync path inspect the DOM.
  for (const item of items) if (!result.has(item.id)) result.set(item.id, order++)
  return result
}

function sessionForRecovery(session: Session) {
  const assets: ProjectAsset[] = []
  const items = session.items.map((item) => {
    if (item.kind !== 'image' || !item.dataUrl) return { ...item }
    const assetPath = `assets/${sanitizeAssetName(item.id)}.${imageExtension(item.dataUrl)}`
    assets.push({ path: assetPath, dataUrl: item.dataUrl })
    const next = { ...item, assetPath }
    delete next.dataUrl
    return next
  })
  return { session: { ...session, items }, assets }
}

function isExternalWindowsPath(source: string | undefined) {
  return Boolean(source && (/^[a-z]:[\\/]/i.test(source) || /^\\\\[^\\]+\\[^\\]+/.test(source)))
}

function sanitizeAssetName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || `image-${Date.now()}`
}

function imageExtension(dataUrl: string) {
  const mime = /^data:image\/([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase()
  if (mime === 'jpeg') return 'jpg'
  return mime && /^[a-z0-9.+-]+$/.test(mime) ? mime.replace('svg+xml', 'svg') : 'png'
}

function portableSource(source: string | undefined, folder: boolean, roots: Map<string, ExternalRoot>, externals: ProjectExternal[], exporting: boolean, packageRoots: string[]) {
  if (!source || !isExternalWindowsPath(source)) return source
  const normalizedSource = source.replace(/\//g, '\\')
  const packageRoot = packageRoots
    .map((root) => root.replace(/\//g, '\\').replace(/[\\]+$/, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((root) => normalizedSource.toLowerCase().startsWith(`${root.toLowerCase()}\\`))
  if (packageRoot) {
    const archivePath = normalizedSource.slice(packageRoot.length + 1).replace(/\\/g, '/')
    if (archivePath && !externals.some((entry) => entry.path.toLowerCase() === source.toLowerCase() && entry.archivePath.toLowerCase() === archivePath.toLowerCase())) {
      externals.push({ path: source, archivePath, folder })
    }
    return archivePath ? `package://${archivePath}` : source
  }
  let rootPath = ''
  let relative = ''
  let rootId = ''
  const drive = /^([a-z]):[\\/](.*)$/i.exec(source)
  if (drive) {
    rootId = `drive-${drive[1].toLowerCase()}`
    rootPath = `${drive[1].toUpperCase()}:\\`
    relative = drive[2].replace(/\\/g, '/')
  } else {
    const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(source)
    if (!unc) return source
    rootId = `unc-${unc[1]}-${unc[2]}`.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()
    rootPath = `\\\\${unc[1]}\\${unc[2]}\\`
    relative = (unc[3] || '').replace(/\\/g, '/')
  }
  if (!roots.has(rootId)) roots.set(rootId, { id: rootId, path: rootPath, label: rootPath.replace(/[\\/]+$/, '') })
  if (!exporting) return `root://${rootId}/${relative}`
  const archivePath = `external/${rootId}/${relative}`.replace(/\/+$/, '')
  if (!externals.some((entry) => entry.path.toLowerCase() === source.toLowerCase())) externals.push({ path: source, archivePath, folder })
  return `package://${archivePath}`
}

function mapSplitSources(node: SplitNode | undefined, convert: (source: string | undefined, folder: boolean) => string | undefined): SplitNode | undefined {
  if (!node) return undefined
  if (node.type === 'leaf') return { ...node, source: convert(node.source, node.kind === 'folder') }
  return { ...node, first: mapSplitSources(node.first, convert)!, second: mapSplitSources(node.second, convert)! }
}

function buildProjectPayload(session: Session, title: string, exporting: boolean, packageRoots: string[] = []) {
  const assets: ProjectAsset[] = []
  const roots = new Map<string, ExternalRoot>()
  const externals: ProjectExternal[] = []
  const convert = (source: string | undefined, folder: boolean) => portableSource(source, folder, roots, externals, exporting, packageRoots)
  const items = session.items.map((item) => {
    const next: CanvasItem = {
      ...item,
      source: convert(item.source, item.kind === 'folder'),
      searchRoot: convert(item.searchRoot, true),
      workspaceSplit: mapSplitSources(item.workspaceSplit, convert),
    }
    if (next.kind === 'image' && next.dataUrl) {
      const assetPath = `assets/${sanitizeAssetName(next.id)}.${imageExtension(next.dataUrl)}`
      assets.push({ path: assetPath, dataUrl: next.dataUrl })
      next.assetPath = assetPath
      delete next.dataUrl
    }
    return next
  })
  const spaces = session.spaces.map((space) => ({
    ...space,
    viewport: { ...space.viewport },
    fixedEntries: space.fixedEntries.map((entry) => ({ ...entry, source: convert(entry.source, entry.sourceKind === 'folder') })),
  }))
  const project: PersistedProject = {
    format: 'zhangzhongjie-project',
    version: 1,
    savedAt: Date.now(),
    title,
    session: { ...session, items, spaces, savedAt: Date.now() },
    externalRoots: [...roots.values()],
  }
  return { projectJson: JSON.stringify(project), assets, externals }
}

function resolvePortableSource(source: string | undefined, roots: Map<string, string>, packageRoot: string) {
  if (!source) return source
  if (source.startsWith('root://')) {
    const match = /^root:\/\/([^/]+)\/?(.*)$/.exec(source)
    const root = match ? roots.get(match[1]) : undefined
    return root && match ? `${root.replace(/[\\/]+$/, '')}\\${match[2].replace(/\//g, '\\')}` : source
  }
  if (source.startsWith('package://') && packageRoot) return `${packageRoot.replace(/[\\/]+$/, '')}\\${source.slice(10).replace(/\//g, '\\')}`
  return source
}

function hydrateProject(projectJson: string, assets: ProjectAsset[] = [], packageRoot = ''): Session | null {
  try {
    const parsed = JSON.parse(projectJson) as PersistedProject | Session
    const project = (parsed as PersistedProject).format === 'zhangzhongjie-project' ? parsed as PersistedProject : null
    const session = normalizeSession(project ? project.session : parsed)
    if (!session) return null
    const roots = new Map((project?.externalRoots ?? []).map((root) => [root.id, root.path]))
    const assetMap = new Map(assets.map((asset) => [asset.path.replace(/\\/g, '/'), asset.dataUrl]))
    const resolve = (source: string | undefined) => resolvePortableSource(source, roots, packageRoot)
    session.items = session.items.map((item) => ({
      ...item,
      source: resolve(item.source),
      searchRoot: resolve(item.searchRoot),
      workspaceSplit: mapSplitSources(item.workspaceSplit, (source) => resolve(source)),
      dataUrl: item.assetPath ? assetMap.get(item.assetPath.replace(/\\/g, '/')) ?? item.dataUrl : item.dataUrl,
    }))
    session.spaces = session.spaces.map((space) => ({ ...space, fixedEntries: space.fixedEntries.map((entry) => ({ ...entry, source: resolve(entry.source) })) }))
    return session
  } catch {
    return null
  }
}

function rebaseSessionSourceRoot(session: Session, fromRoot: string, toRoot: string): Session {
  const from = fromRoot.replace(/\//g, '\\').replace(/[\\]+$/, '')
  const to = toRoot.replace(/\//g, '\\').replace(/[\\]+$/, '')
  if (!from || !to) return session
  const rebase = (source: string | undefined) => {
    if (!source) return source
    const normalized = source.replace(/\//g, '\\')
    if (normalized.toLowerCase() === from.toLowerCase()) return to
    return normalized.toLowerCase().startsWith(`${from.toLowerCase()}\\`)
      ? `${to}${normalized.slice(from.length)}`
      : source
  }
  return {
    ...session,
    items: session.items.map((item) => ({
      ...item,
      source: rebase(item.source),
      searchRoot: rebase(item.searchRoot),
      workspaceSplit: mapSplitSources(item.workspaceSplit, (source) => rebase(source)),
    })),
    spaces: session.spaces.map((space) => ({
      ...space,
      fixedEntries: space.fixedEntries.map((entry) => ({ ...entry, source: rebase(entry.source) })),
    })),
  }
}

function uiIcon(name: string, size = 18) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 15.5V19h-3.5M5 8.5V5h3.5M16.8 7.2A7 7 0 0 0 5 12M7.2 16.8A7 7 0 0 0 19 12"/></>,
    pin: <><path d="m14 4 6 6-3 1-4 4-1 5-2-2-4-4-2-2 5-1 4-4 1-3Z"/><path d="m4 20 5-5"/></>,
    close: <><path d="m7 7 10 10M17 7 7 17"/></>,
    folder: <><path d="M3 7h7l2 2h9v10H3V7Z"/><path d="M3 7V5h7l2 2"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    undo: <><path d="m9 7-5 5 5 5"/><path d="M20 17a8 8 0 0 0-8-8H4"/></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    home: <><path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
    volume: <><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/></>,
    mute: <><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 10 5 5m0-5-5 5"/></>,
    fullscreen: <><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></>,
    restore: <><path d="M8 8V5h11v11h-3"/><rect x="5" y="8" width="11" height="11" rx="1"/></>,
    back: <path d="m14 6-6 6 6 6"/>,
    forward: <path d="m10 6 6 6-6 6"/>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></>,
    paste: <><rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2M9 10h6M9 14h6"/></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    split: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/></>,
    save: <><path d="M5 4h12l2 2v14H5V4Z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/></>,
    // 交接文档 §30.7：文件管理器命令栏用的一套，纯线性、只用 currentColor，
    // 颜色只表达可用/次要/禁用三档状态，不表达类别。
    cut: <><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M8.3 16.2 18 3.5M15.7 16.2 6 3.5"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="1.6"/><path d="M16 8V5.6A1.6 1.6 0 0 0 14.4 4H5.6A1.6 1.6 0 0 0 4 5.6v8.8A1.6 1.6 0 0 0 5.6 16H8"/></>,
    rename: <><path d="M3.5 16.8 16.2 4.1a2.4 2.4 0 0 1 3.4 3.4L6.9 20.2l-4.4 1z"/></>,
    trash: <><path d="M3.5 6.3h17M9 6.3V4.4a1.4 1.4 0 0 1 1.4-1.4h3.2a1.4 1.4 0 0 1 1.4 1.4v1.9M18.6 6.3v13.3a1.5 1.5 0 0 1-1.5 1.5H6.9a1.5 1.5 0 0 1-1.5-1.5V6.3"/></>,
    sort: <><path d="M6.6 4.2v15.6M3.2 16.4l3.4 3.4 3.4-3.4M17.4 19.8V4.2M14 7.6l3.4-3.4 3.4 3.4"/></>,
    view: <><path d="M3.6 6.6h16.8M3.6 12h16.8M3.6 17.4h16.8"/></>,
    more: <><circle cx="5.1" cy="12" r="1.35"/><circle cx="12" cy="12" r="1.35"/><circle cx="18.9" cy="12" r="1.35"/></>,
    up: <><path d="M12 19.5V4.8M5.9 10.9 12 4.8l6.1 6.1"/></>,
    drive: <><rect x="2.4" y="6.6" width="19.2" height="10.8" rx="1.8"/><circle cx="17.4" cy="12" r="1.35"/><path d="M6 12h6.3"/></>,
    pc: <><rect x="2.7" y="4.2" width="18.6" height="12.3" rx="1.5"/><path d="M8.1 20.1h7.8M12 16.5v3.6"/></>,
    file: <><path d="M13.8 2.4H6.45A1.5 1.5 0 0 0 4.95 3.9v16.2a1.5 1.5 0 0 0 1.5 1.5h11.1a1.5 1.5 0 0 0 1.5-1.5V7.65z"/><path d="M13.8 2.4v5.25h5.25"/></>,
    image: <><rect x="2.7" y="4.5" width="18.6" height="15" rx="1.5"/><circle cx="8.4" cy="9.6" r="1.65"/><path d="M21.3 15.9 16.05 11.1l-9 8.4"/></>,
    video: <><rect x="3" y="5" width="18" height="14" rx="1.8"/><path d="m10 9 5 3-5 3Z"/></>,
    audio: <><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></>,
    document: <><path d="M13.8 2.4H6.45A1.5 1.5 0 0 0 4.95 3.9v16.2a1.5 1.5 0 0 0 1.5 1.5h11.1a1.5 1.5 0 0 0 1.5-1.5V7.65z"/><path d="M13.8 2.4v5.25h5.25M8 12h8M8 16h6"/></>,
    executable: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M8 12h3M8 16h6"/></>,
    archive: <><rect x="2.7" y="4.5" width="18.6" height="15" rx="1.5"/><path d="M2.7 9.6h18.6M10.95 4.5v5.1M13.05 12.9v2.4"/></>,
    locate: <><circle cx="12" cy="12" r="3.3"/><path d="M12 2.1v3.6M12 18.3v3.6M21.9 12h-3.6M5.7 12H2.1"/></>,
    card: <><rect x="3.3" y="6.9" width="17.4" height="10.2" rx="1.5"/></>,
    canvasNew: <><rect x="2.85" y="3.9" width="18.3" height="16.2" rx="1.65"/><path d="M12 3.9v16.2M2.85 12h18.3"/></>,
    listView: <><path d="M3.9 7.5h16.2M3.9 12h16.2M3.9 16.5h16.2"/></>,
    tiles: <><rect x="3.6" y="3.6" width="6.9" height="6.9" rx="1"/><rect x="13.5" y="3.6" width="6.9" height="6.9" rx="1"/><rect x="3.6" y="13.5" width="6.9" height="6.9" rx="1"/><rect x="13.5" y="13.5" width="6.9" height="6.9" rx="1"/></>,
    largeIcons: <><rect x="3.5" y="4" width="7" height="7" rx="1"/><rect x="13.5" y="4" width="7" height="7" rx="1"/><path d="M4 16h6M14 16h6M4 19h5M14 19h5"/></>,
    mediaGrid: <><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="m4 17 5-5 3.2 3.2 2.4-2.4L20 18"/><circle cx="15.8" cy="8.2" r="1.5"/></>,
    compact: <><path d="M7 6h14M7 12h14M7 18h14"/><circle cx="3.5" cy="6" r=".8"/><circle cx="3.5" cy="12" r=".8"/><circle cx="3.5" cy="18" r=".8"/></>,
    chevronRight: <path d="M9.6 5.4 16.2 12l-6.6 6.6"/>,
    sidebar: <><rect x="2.7" y="4.5" width="18.6" height="15" rx="1.5"/><path d="M9.3 4.5v15"/></>,
  }
  return <svg aria-hidden="true" {...common}>{paths[name]}</svg>
}

function FixedEntryIcon({ entry, item }: { entry: FixedEntry; item?: CanvasItem }) {
  const itemKind = item?.kind
  if (!entry.target.startsWith('quick-') && entry.image) return <img src={entry.image} alt="" width={16} height={16} style={{ objectFit: 'contain' }} draggable={false}/>
  if (entry.target === 'quick-navigator') return uiIcon('sidebar', 16)
  if (entry.target === 'quick-computer' || itemKind === 'folder') return uiIcon('pc', 16)
  if (entry.sourceKind === 'folder') return uiIcon('folder', 16)
  if (itemKind === 'workspace') return uiIcon('grid', 16)
  if (entry.target === 'quick-web') return uiIcon('eye', 16)
  if (entry.target === 'quick-shelf') return uiIcon('paste', 16)
  if (entry.target === 'quick-todo') return uiIcon('document', 16)
  if (itemKind === 'note') return uiIcon('document', 16)
  if (itemKind === 'web' || itemKind === 'video') return uiIcon('eye', 16)
  if (itemKind === 'reference' || itemKind === 'image') return uiIcon('image', 16)
  if (entry.sourceKind === 'file') return uiIcon('file', 16)
  if (entry.sourceKind === 'app') return uiIcon('settings', 16)
  return uiIcon('grid', 16)
}

function FixedSegmentTrack({ indicatedTarget, layoutKey, children }: { indicatedTarget: string | null; layoutKey: string; children: ReactNode }) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const track = trackRef.current
    const indicator = indicatorRef.current
    if (!track || !indicator) return
    const updateIndicator = () => {
      const target = indicatedTarget
        ? track.querySelector<HTMLElement>(`[data-fixed-target="${CSS.escape(indicatedTarget)}"]`)
        : null
      if (!target) {
        indicator.style.opacity = '0'
        indicator.style.transform = 'translateX(0) scaleX(0)'
        return
      }
      const trackRect = track.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const width = Math.max(1, targetRect.width)
      indicator.style.opacity = '1'
      indicator.style.transform = `translateX(${targetRect.left - trackRect.left}px) scaleX(${width / 100})`
    }
    updateIndicator()
    const observer = new ResizeObserver(updateIndicator)
    observer.observe(track)
    for (const element of track.querySelectorAll<HTMLElement>('[data-fixed-target]')) observer.observe(element)
    return () => observer.disconnect()
  }, [indicatedTarget, layoutKey])

  return <div className="fixed-segment-track" ref={trackRef}>
    <span className="fixed-segment-indicator" ref={indicatorRef} aria-hidden="true"/>
    {children}
  </div>
}

const BlankWebBody = memo(function BlankWebBody() {
  return <div className="blank-web-body"><span>{uiIcon('eye', 26)}</span><b>输入网址或搜索内容</b><small>在上方地址栏输入后按回车</small></div>
})

const FolderBody = memo(function FolderBody() {
  return <div className="folder-content native-folder-entry"><div className="native-folder-heading"><span>{uiIcon('folder', 20)}</span><div><b>此电脑</b><small>Windows 原生资源管理器入口</small></div></div><div className="native-drive-list">{[['OS (C:)','62%'],['4T (D:)','59%'],['HDD (E:)','66%']].map(([name,usage]) => <div key={name}><span>▰</span><b>{name}</b><i><em style={{ width: usage }}/></i></div>)}</div><footer>双击标题栏打开真实本地文件 · <ShortcutText id="preview.toggle"/> 进入超级预览</footer></div>
})

const NativeSurfaceSlot = memo(function NativeSurfaceSlot({ item, paintOrder = 0, surfaceRole, surfaceSource, placeholder, overlaySnapshot = false }: {
  item: CanvasItem
  paintOrder?: number
  surfaceRole?: 'pdf'
  surfaceSource?: string
  placeholder?: ReactNode
  // 卡片里的浮层（书签下拉）要压在网页上面时置真：宿主会把原生窗口切成快照位图，
  // 真窗口隐藏，DOM 拿位图继续显示网页，于是浮层看得见也点得中。
  overlaySnapshot?: boolean
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const [leaseId] = useState(() => `${item.id}:${crypto.randomUUID()}`)
  const effectiveSource = surfaceSource ?? item.source
  const isBrowserSurface = item.kind === 'web' || item.kind === 'video' || surfaceRole === 'pdf'
  const isShellViewSurface = item.kind === 'shellview'
  const sourceRef = useRef(effectiveSource)
  sourceRef.current = effectiveSource
  const paintOrderRef = useRef(paintOrder)
  paintOrderRef.current = paintOrder
  const [connected, setConnected] = useState(false)
  // 交接文档 §25：Shell 文件视图没有缩放 API，画布缩小时框变小了字还是原来那么
  // 大。低于阈值就让宿主抓一张位图、隐藏真实窗口，改用 <img> 显示——图片是普通
  // DOM 内容，跟着画布等比缩放，观感才对。
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const hasSnapshotRef = useRef(false)
  const snapshotSourceRef = useRef(effectiveSource)
  const snapshotRef = useRef(false)
  const interactionSnapshotRef = useRef(false)
  const interactionSnapshotSentRef = useRef(false)
  const overlaySnapshotRef = useRef(false)
  overlaySnapshotRef.current = Boolean(overlaySnapshot)
  const SNAPSHOT_BELOW = 0.8

  useEffect(() => {
    if (snapshotSourceRef.current === effectiveSource) return
    snapshotSourceRef.current = effectiveSource
    // Keep the old bitmap mounted under the live surface, but never use it as
    // the drag carrier for a newly navigated page. NavigationCompleted will
    // replace it before the next snapshot switch.
    hasSnapshotRef.current = false
  }, [effectiveSource])

  useEffect(() => {
    const bridge = window.chrome?.webview
    const slot = slotRef.current
    if (!bridge || !slot || (!isBrowserSurface && item.kind !== 'folder' && !isShellViewSurface)) return
    let frame = 0
    let running = false
    let idleFrames = 0
    let lastPayload = ''
    let primeTimer = 0
    let snapshotPrimeRequested = false
    // 空转的 rAF 循环会让每个原生窗口常驻一条 60fps 的布局重算，违反
    // 交接文档 13/18 的「空闲低占用」。改成：有交互才跑，连续 30 帧
    // (~0.5s) 几何没变化就停下，等下一次交互再唤醒。
    const IDLE_FRAMES_BEFORE_STOP = 30
    const sync = () => {
      // During drag/pan the live native surface is hidden behind a cached DOM
      // snapshot. Its HWND/DComp visual no longer needs to chase every pointer
      // move; one upsert enters snapshot mode and one final upsert restores it.
      if (interactionSnapshotRef.current && interactionSnapshotSentRef.current) {
        running = false
        return
      }
      const node = slotRef.current
      if (!node) { running = false; return }
      const rect = node.getBoundingClientRect()
      // 裁剪必须沿着所有会裁内容的祖先逐层求交，而不是只取最外层视口。
      // 只取 .canvas-viewport 的话，嵌在子画布里的原生窗口在外层缩放时，超出
      // 父窗口的那部分不会被裁掉，就会整块飘到画布上（用户实测图 2）。
      let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (!el.matches('.canvas-viewport,.space-surface,.window-body,.split-leaf,.focused-workspace-body')) continue
        const r = el.getBoundingClientRect()
        clip = {
          left: Math.max(clip.left, r.left),
          top: Math.max(clip.top, r.top),
          right: Math.min(clip.right, r.right),
          bottom: Math.min(clip.bottom, r.bottom),
        }
      }
      let overlayClipBottom = 0
      if (nativeChromeOcclusionBottom > 0 && rect.top < nativeChromeOcclusionBottom && rect.bottom > 0) {
        overlayClipBottom = nativeChromeOcclusionBottom
      }
      const owningCard = node.closest<HTMLElement>('.canvas-item[data-item-id]')
      const cardOcclusionHeight = owningCard?.dataset.itemId
        ? nativeCardOcclusionHeights.get(owningCard.dataset.itemId)
        : undefined
      if (owningCard && cardOcclusionHeight) {
        const cardRect = owningCard.getBoundingClientRect()
        const cardScale = cardRect.width / (owningCard.offsetWidth || cardRect.width || 1)
        const cardClipBottom = cardRect.top + cardOcclusionHeight * cardScale
        if (rect.top < cardClipBottom && rect.bottom > cardRect.top) {
          overlayClipBottom = Math.max(overlayClipBottom, cardClipBottom)
        }
      }
      if (overlayClipBottom > 0) clip.top = Math.max(clip.top, overlayClipBottom)
      // getBoundingClientRect 对 visibility:hidden 的元素照样返回真实矩形，
      // 只看矩形的话，窗口在 DOM 里早已不可见，原生子窗口还会继续浮在屏幕上
      // ——切换到别的画布时那块 Shell 视图就叠在新画布上下不去。
      // checkVisibility 只看 display/visibility/opacity，不看遮挡。最大化舞台是
      // 盖在外层画布之上的，外层那些窗口在 CSS 意义上仍然「可见」，它们的原生
      // 窗口就会浮在舞台上面。所以舞台存在时，不在舞台里的一律当作不可见。
      const stage = document.querySelector('.focused-workspace')
      const occludedByStage = stage !== null && !stage.contains(node)
      // 注意三元优先级：写成 `!occluded && hasApi ? a : b` 时，被遮挡会掉进 b
      // 分支返回 true，遮挡判断等于白写。必须先把遮挡短路掉。
      const renderable = occludedByStage
        ? false
        : typeof node.checkVisibility === 'function'
          ? node.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true })
          : node.offsetParent !== null
      const clipValid = clip.right > clip.left && clip.bottom > clip.top
      const visible = renderable && clipValid && rect.width >= 80 && rect.height >= 60
        && rect.right > clip.left && rect.left < clip.right && rect.bottom > clip.top && rect.top < clip.bottom
      // DOM geometry is expressed in CSS pixels while the native child HWND
      // and WebView2 controller use physical pixels in a Per-Monitor-V2 app.
      // Keeping the conversion here makes 100%, 125%, 150% and 200% displays
      // land on exactly the same card bounds.
      const nativeScale = window.devicePixelRatio || 1
      // 累积画布缩放 = 变换后的宽 / 布局宽。宿主拿它去 put_ZoomFactor，
      // 让网页跟着画布一起缩放，而不是缩小窗口后只露出网页的一小块。
      // The App model already owns paint order. Never scan every .canvas-item
      // from every surface on every animation frame just to rediscover it.
      const layoutWidth = node.offsetWidth || rect.width || 1
      const canvasScale = Math.round((rect.width / layoutWidth) * 1000) / 1000
      const requestedSource = sourceRef.current || (isBrowserSurface ? 'about:blank' : 'shell:MyComputerFolder')
      const payload = {
        type: 'native-surface-upsert',
        surfaceId: item.id,
        leaseId,
        kind: isBrowserSurface ? 'browser' : isShellViewSurface ? 'shellview' : 'explorer',
        source: requestedSource,
        // 同一租约内 source 变化就是模型明确要求的新位置；换租约则只是
        // 卡片/最大化载体交接，由宿主保留实时浏览状态，不再靠模块级 Map 猜意图。
        sourceIntent: 'inherit',
        mediaBacked: surfaceRole === 'pdf',
        x: Math.round(rect.left * nativeScale),
        y: Math.round(rect.top * nativeScale),
        width: Math.round(rect.width * nativeScale),
        height: Math.round(rect.height * nativeScale),
        scale: canvasScale > 0 ? canvasScale : 1,
        snapshot: ((interactionSnapshotRef.current || overlaySnapshotRef.current) && hasSnapshotRef.current)
          || (item.kind === 'folder' && canvasScale > 0 && canvasScale < SNAPSHOT_BELOW),
        order: paintOrderRef.current,
        // 画布可视区，宿主用它 SetWindowRgn 裁掉越界部分，避免原生窗口
        // 滚出边界时压在顶部工具栏上（交接文档 25）。
        clipX: Math.round(clip.left * nativeScale),
        clipY: Math.round(clip.top * nativeScale),
        clipWidth: Math.round((clip.right - clip.left) * nativeScale),
        clipHeight: Math.round((clip.bottom - clip.top) * nativeScale),
        visible,
      }
      const serialized = JSON.stringify(payload)
      if (serialized !== lastPayload) {
        lastPayload = serialized
        bridge.postMessage(payload)
        if (payload.visible) setConnected(true)
        // Keep the last bitmap cached under the live native surface. It is not
        // visible while the surface is active, but prevents a blank transition
        // on the next interaction while a fresh CapturePreview is in flight.
        if (!payload.snapshot && snapshotRef.current) snapshotRef.current = false
        if (payload.snapshot) snapshotRef.current = true
        if (interactionSnapshotRef.current && payload.snapshot) interactionSnapshotSentRef.current = true
        if (payload.visible && isBrowserSurface && !snapshotPrimeRequested) {
          snapshotPrimeRequested = true
          const sourceAtPrime = requestedSource
          primeTimer = window.setTimeout(() => {
            if (sourceRef.current === sourceAtPrime) bridge.postMessage({
              type: 'native-surface-snapshot-request', surfaceId: item.id,
            })
          }, 450)
        }
        idleFrames = 0
      } else if (++idleFrames > IDLE_FRAMES_BEFORE_STOP) {
        running = false
        return
      }
      frame = window.requestAnimationFrame(sync)
    }
    const wake = () => {
      if (running) { idleFrames = 0; return }
      running = true
      idleFrames = 0
      frame = window.requestAnimationFrame(sync)
    }
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'resize']
    for (const name of events) window.addEventListener(name, wake, { capture: true, passive: true })
    window.addEventListener('zhangzhongjie-surface-source-changed', wake)
    window.addEventListener(SURFACE_OCCLUSION_EVENT, wake)
    const onInteraction = (event: Event) => {
      const active = Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active)
      interactionSnapshotRef.current = active
      interactionSnapshotSentRef.current = false
      wake()
    }
    window.addEventListener('zhangzhongjie-native-interaction', onInteraction)
    const onMessage = (event: MessageEvent<NativeHostMessage>) => {
      if (event.data?.type === 'native-window-restored') {
        // The normal geometry loop sleeps after 30 idle frames.  A restore is
        // an explicit wake signal so every surface reports its current DOM
        // bounds after the host has already replayed the cached native bounds.
        wake()
        return
      }
      if (event.data?.type === 'native-surface-snapshot' && event.data.surfaceId === item.id && event.data.image) {
        hasSnapshotRef.current = true
        setSnapshot(event.data.image)
        wake()
      }
    }
    bridge.addEventListener('message', onMessage)
    const observer = new ResizeObserver(wake)
    observer.observe(slot)
    wake()
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(primeTimer)
      running = false
      observer.disconnect()
      bridge.removeEventListener('message', onMessage)
      for (const name of events) window.removeEventListener(name, wake, { capture: true })
      window.removeEventListener('zhangzhongjie-surface-source-changed', wake)
      window.removeEventListener(SURFACE_OCCLUSION_EVENT, wake)
      window.removeEventListener('zhangzhongjie-native-interaction', onInteraction)
      bridge.postMessage({ type: 'native-surface-destroy', surfaceId: item.id, leaseId })
    }
  }, [item.id, item.kind, isBrowserSurface, isShellViewSurface, leaseId])

  // source 改变只唤醒现有几何同步循环，不 teardown 原生 surface。这样地址跳转、
  // 书签和项目切换都走轻量 upsert，导航时不会先隐藏一帧再复活。
  useEffect(() => {
    window.dispatchEvent(new Event('zhangzhongjie-surface-source-changed'))
  }, [effectiveSource])

  // 浮层（书签下拉）打开：先把网页位图要到手（真空期里 DOM 得有图可画），
  // 同时唤醒几何同步循环，让它把 snapshot:true 报给宿主、把真窗口让开。
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    if (overlaySnapshot && !hasSnapshotRef.current) bridge.postMessage({ type: 'native-surface-snapshot-request', surfaceId: item.id })
    window.dispatchEvent(new Event('zhangzhongjie-surface-source-changed'))
  }, [overlaySnapshot, item.id])

  if (!window.chrome?.webview) return surfaceRole === 'pdf' ? <>{placeholder}</> : item.kind === 'folder' ? <FolderBody/> : <BlankWebBody/>
  // 接上之后就不再画占位文字：掌中界弹浮层时宿主会把原生窗口整体藏起来，
  // 那句「正在连接…」会跟着露出来，看着像刚刚断线了。
  return <div ref={slotRef} className={`native-surface-slot surface-${surfaceRole ?? item.kind}`} data-surface-id={item.id}>
    {snapshot ? <img className="surface-snapshot" src={snapshot} alt="" draggable={false} aria-hidden="true"/> : null}
    {connected || snapshot ? null : placeholder ?? <span>{isBrowserSurface ? '正在连接真实浏览器…' : '正在连接 Windows 文件管理器…'}</span>}
  </div>
})

function resolveBrowserInput(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  const isLocalhost = /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/.test(trimmed)
  const isDomain = /^(?:www\.)?[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?(?:\.[\p{L}\d](?:[\p{L}\d-]{0,61}[\p{L}\d])?)+(?:[/:?#].*)?$/iu.test(trimmed)
  return isLocalhost || isIpv4 || isDomain
    ? `https://${trimmed}`
    : `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

const BrowserCardBody = memo(function BrowserCardBody({ item, paintOrder = 0, onNavigate }: { item: CanvasItem; paintOrder?: number; onNavigate?: (url: string) => void }) {
  const [address, setAddress] = useState(item.source || '')
  // 地址栏跟着卡片当前网址走：点收藏/别的入口跳转后 item.source 会变，地址栏必须同步，否则会出现「网页已经换了、地址栏还写着旧网址」。
  // 只在 item.source 真的变化时同步，用户正在输入不会被覆盖。
  useEffect(() => { setAddress(item.source || '') }, [item.source])
  // 这张卡记录过音量 → 挂载时下发一次（原生那边每次导航也会重新下发，站点重设音量后仍会回到这个值）。
  useEffect(() => {
    if (item.volume === undefined) return
    window.chrome?.webview?.postMessage({ type: 'native-browser-volume', surfaceId: item.id, volume: item.volume })
  }, [item.id, item.volume])
  const [bookmarks, setBookmarks] = useState<WebBookmark[]>(() => readBrowserSettings().webBookmarks)
  const [profile, setProfile] = useState<BrowserProfileState>(() => sharedBrowserProfile)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [bookmarkQuery, setBookmarkQuery] = useState('')
  const [activeGroup, setActiveGroup] = useState('')
  const [groupDraft, setGroupDraft] = useState('')
  const [systemBookmarksCollapsed, setSystemBookmarksCollapsed] = useState(true)
  const [groupEditorId, setGroupEditorId] = useState<string | null>(null)
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null)
  const [draftGroups, setDraftGroups] = useState<string[]>([])
  const [openGroupMenu, setOpenGroupMenu] = useState<string | null>(null)
  const groupDragRef = useRef<string | null>(null)
  const [groupMenuAnchor, setGroupMenuAnchor] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [overflowIds, setOverflowIds] = useState<string[]>([])
  const [systemOverflowIds, setSystemOverflowIds] = useState<string[]>([])
  const [overflowKind, setOverflowKind] = useState<'personal' | 'system'>('personal')
  const systemRowRef = useRef<HTMLDivElement>(null)
  // 打开下拉时把「那个按钮」本身存下来：卡片最大化时书签行会被搬到 .focused-workspace 里
  // （不在 .canvas-item[data-item-id] 子树内），按卡 id 查会查不到；记住元素最稳。
  const groupChipAnchorRef = useRef<HTMLElement | null>(null)
  const overflowBtnAnchorRef = useRef<HTMLElement | null>(null)
  const [overflowAnchor, setOverflowAnchor] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)

  // 任一书签下拉开着 → 这张卡的网页切快照位图（宿主隐藏真窗口），DOM 才有机会
  // 把下拉画在网页上面；关了立即恢复真窗口。
  const menuOverPage = overflowOpen || openGroupMenu !== null
  const bookmarkRowRef = useRef<HTMLDivElement>(null)
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null)
  const browserHost = (() => {
    try { return new URL(address).host } catch { return '' }
  })()
  const [settingsTick, setSettingsTick] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDetailsElement>(null)
  const dragIdRef = useRef<string | null>(null)
  const [groupNameDraft, setGroupNameDraft] = useState('')
  // 下拉和 Chrome 一样从触发按钮下沿往下弹，会压到网页上面。
  // 原生网页浮在 DOM 之上，所以下拉开着期间这张卡的原生窗口会切成快照位图
  // （见 NativeSurfaceSlot 的 overlaySnapshot）：宿主隐藏真窗口、DOM 用位图接着显示
  // 网页内容，下拉因此既看得见又点得中；关掉下拉立刻恢复真窗口。
  // 下拉 portal 到 .app（脱离画布缩放），所以位置全用视口坐标。
  const menuPlacement = (anchorBottom: number) => {
    const top = Math.round(anchorBottom) + 4
    return { top, maxHeight: Math.max(60, Math.min(560, Math.round(window.innerHeight - top - 12))) }
  }
  // 下拉跟着锚点走：窗口缩放/全屏/画布平移缩放时都重算一次，默认与全屏表现一致。
  // 关键：锚点必须**限定在"这张卡"里面**找。掌中界同时能开着好几张卡，
  // 用 document.querySelector 会顺手抓到别的卡（甚至已经滚到屏幕外那张）的书签行，
  // 每 250ms 把下拉搬到那张卡的位置上去 —— 表现就是"下拉根本看不到 / 跑到别处"。
  const syncMenuAnchors = () => {
    // 优先用「打开时记住的那个按钮」；万一它已被卸载，再按当前布局去找。
    const root = document.querySelector(`.canvas-item[data-item-id="${CSS.escape(item.id)}"]`)
    const findIn = (sel: string) => (root?.querySelector(sel) ?? document.querySelector(sel)) as HTMLElement | null
    if (openGroupMenu) {
      const remembered = groupChipAnchorRef.current
      const chip = remembered?.isConnected ? remembered : findIn(`.bookmark-group-chip[data-group="${CSS.escape(openGroupMenu)}"]`)
      if (chip) {
        const rect = chip.getBoundingClientRect()
        const width = Math.min(330, window.innerWidth - 24)
        const placement = menuPlacement(rect.bottom)
        setGroupMenuAnchor({ left: Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - width - 8)), top: placement.top, maxHeight: placement.maxHeight })
      }
    }
    if (overflowOpen) {
      const remembered = overflowBtnAnchorRef.current
      const more = remembered?.isConnected ? remembered : findIn(overflowKind === 'system' ? '.system-bookmarkbar .bookmark-overflow-more' : '.personal-bookmarkbar .bookmark-overflow-more')
      if (more) {
        const rect = more.getBoundingClientRect()
        const placement = menuPlacement(rect.bottom)
        setOverflowAnchor({ left: Math.max(8, Math.round(rect.right) - 320), top: placement.top, maxHeight: placement.maxHeight })
      }
    }
  }
  useEffect(() => {
    if (!openGroupMenu && !overflowOpen) return
    syncMenuAnchors()
    const timer = window.setInterval(syncMenuAnchors, 250)
    window.addEventListener('resize', syncMenuAnchors)
    return () => { window.clearInterval(timer); window.removeEventListener('resize', syncMenuAnchors) }
  }, [openGroupMenu, overflowOpen, overflowKind])
  useEffect(() => {
    if (!openGroupMenu) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.bookmark-group-chip-wrap')) return
      // 分组下拉是 portal 到 .app 的：它不在 chip-wrap 里，所以必须单独放行，
      // 否则 pointerdown（捕获阶段）先把菜单关掉，click 永远落不到书签按钮上
      // ——表现就是「点下拉里的收藏没反应」。
      if (target?.closest('.bookmark-group-menu')) return
      setOpenGroupMenu(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenGroupMenu(null) }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [openGroupMenu])
  useEffect(() => {
    if (!overflowOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.bookmark-overflow-more') || target?.closest('.bookmark-overflow-menu')) return
      setOverflowOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOverflowOpen(false) }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [overflowOpen])

  // 书签前面的网站小图标：直接读该站点的 /favicon.ico（显示不了就隐藏，不占位）。
  const faviconFor = (url: string) => { try { return `https://${new URL(url).hostname}/favicon.ico` } catch { return '' } }
  const browserSettings = readBrowserSettings()
  const zoomFactor = (browserHost && browserSettings.browserZoom[browserHost]) || 1
  const userAgentMode = browserSettings.browserUserAgent ?? 'default'
  useEffect(() => {
    if (!browserHost) return
    window.chrome?.webview?.postMessage({ type: 'native-browser-zoom', surfaceId: item.id, factor: (readBrowserSettings().browserZoom[browserHost] ?? 1) })
  }, [browserHost, item.id])
  const applyZoom = (next: number) => {
    const factor = clamp(Math.round(next * 100) / 100, 0.25, 3)
    // 先无条件把缩放发到这张卡（否则拿不到域名时点了没反应）；再按域名记住。
    window.chrome?.webview?.postMessage({ type: 'native-browser-zoom', surfaceId: item.id, factor })
    if (!browserHost) return
    publishBrowserOnlySettings({ browserZoom: { ...readBrowserSettings().browserZoom, [browserHost]: factor } })
  }
  const toggleUserAgent = () => {
    const mode: 'default' | 'chrome' = userAgentMode === 'chrome' ? 'default' : 'chrome'
    publishBrowserOnlySettings({ browserUserAgent: mode })
    window.chrome?.webview?.postMessage({ type: 'native-browser-useragent', mode })
  }
  const recentUrls = browserSettings.browserHistory.filter((url) => url !== item.source).slice(0, 6)
  useEffect(() => {
    const onSettings = (event: Event) => {
      setBookmarks((event as CustomEvent<AppSettings>).detail.webBookmarks)
      // ⑤③ 设置变了要重渲染一次：UA 开关标签、缩放百分比都读的是最新设置。
      setSettingsTick((value) => value + 1)
    }
    const onProfile = (event: Event) => setProfile((event as CustomEvent<BrowserProfileState>).detail)
    window.addEventListener(APP_SETTINGS_EVENT, onSettings)
    window.addEventListener(BROWSER_PROFILE_EVENT, onProfile)
    return () => {
      window.removeEventListener(APP_SETTINGS_EVENT, onSettings)
      window.removeEventListener(BROWSER_PROFILE_EVENT, onProfile)
    }
  }, [])

  const updateMoreOpen = useCallback((open: boolean) => {
    setMoreOpen(open)
    window.dispatchEvent(new CustomEvent(BROWSER_CARD_MORE_EVENT, { detail: { itemId: item.id, open } }))
  }, [item.id])
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent(BROWSER_CARD_MORE_EVENT, { detail: { itemId: item.id, open: false } }))
  }, [item.id])
  useEffect(() => {
    if (!moreOpen) return
    const dismiss = (event: PointerEvent) => {
      if (moreRef.current?.contains(event.target as Node)) return
      updateMoreOpen(false)
    }
    const dismissByKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      updateMoreOpen(false)
    }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', dismissByKey, true)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', dismissByKey, true)
    }
  }, [moreOpen, updateMoreOpen])

  const navigate = (url: string, title?: string, createNew = false) => {
    const normalized = resolveBrowserInput(url)
    if (!normalized) return
    // ⑥ 地址栏历史补全的数据源：最近访问过的网址（去重、最多 60 条）。
    publishBrowserOnlySettings({ browserHistory: [normalized, ...readBrowserSettings().browserHistory.filter((entry) => entry !== normalized)].slice(0, 60) })
    if (onNavigate && !createNew) {
      onNavigate(normalized)
      return
    }
    window.dispatchEvent(new CustomEvent(WEB_CARD_NAVIGATE_EVENT, {
      detail: { itemId: item.id, url: normalized, title, createNew },
    }))
  }
  const saveBookmark = () => {
    const url = (item.source || address).trim()
    if (!/^(https?|file):\/\//i.test(url)) return
    if (bookmarks.some((entry) => entry.url === url)) return
    let fallbackName = url
    try { fallbackName = new URL(url).hostname.replace(/^www\./, '') || url } catch { /* validated above */ }
    publishSettingsPatch({ webBookmarks: [...bookmarks, {
      id: crypto.randomUUID(),
      name: item.title?.trim() || fallbackName,
      url,
    }] })
  }
  const renameBookmark = (id: string, name: string) => {
    setEditingId(null)
    const normalized = name.trim().slice(0, 120)
    if (!normalized) return
    publishSettingsPatch({ webBookmarks: bookmarks.map((entry) => entry.id === id ? { ...entry, name: normalized } : entry) })
  }
  const deleteBookmark = (id: string) => {
    const target = bookmarks.find((entry) => entry.id === id)
    if (target?.url) noteBookmarkRemoval([target.url])
    publishSettingsPatch({ webBookmarks: bookmarks.filter((entry) => entry.id !== id) })
  }
  // ② 收藏：分组 / 搜索 / 导入系统书签。分组只存在于有成员的收藏里，拖到分组按钮上即归类。
  const allGroupNames = [...new Set([...draftGroups, ...bookmarks.map((entry) => entry.group).filter((group): group is string => Boolean(group))])]
  // 分组胶囊的顺序：本机记住的排前面，新出现的按名字排在后面（可拖动排序）。
  const savedGroupOrder = readBrowserSettings().browserGroupOrder
  const bookmarkGroups = [
    ...savedGroupOrder.filter((name) => allGroupNames.includes(name)),
    ...allGroupNames.filter((name) => !savedGroupOrder.includes(name)).sort(),
  ]
  const reorderGroups = (dragged: string, target: string) => {
    if (!dragged || !target || dragged === target) return
    const next = bookmarkGroups.filter((name) => name !== dragged)
    const index = next.indexOf(target)
    if (index < 0) return
    next.splice(index, 0, dragged)
    publishBrowserOnlySettings({ browserGroupOrder: next })
  }
  const bookmarkQueryHit = (entry: WebBookmark) => {
    const query = bookmarkQuery.trim().toLowerCase()
    return !query || `${entry.name} ${entry.url}`.toLowerCase().includes(query)
  }
  const ungroupedBookmarks = bookmarks.filter((entry) => !entry.group && bookmarkQueryHit(entry))
  const groupBookmarks = (group: string) => bookmarks.filter((entry) => entry.group === group && bookmarkQueryHit(entry))
  // 一行放不下就收进「▸ N」下拉（Chrome 那套）：这里只做几何判断，不改行高。
  useEffect(() => {
    const measureRow = (row: HTMLDivElement | null, setIds: (action: React.SetStateAction<string[]>) => void) => {
      if (!row) return
      const limit = row.clientWidth - 40
      const hidden: string[] = []
      for (const child of Array.from(row.children) as HTMLElement[]) {
        const id = child.dataset.bookmarkId
        if (!id) continue
        if (child.offsetLeft + child.offsetWidth > limit) hidden.push(id)
      }
      setIds((previous) => (previous.length === hidden.length && previous.every((id, index) => id === hidden[index]) ? previous : hidden))
    }
    const measure = () => {
      measureRow(bookmarkRowRef.current, setOverflowIds)
      measureRow(systemRowRef.current, setSystemOverflowIds)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (bookmarkRowRef.current) observer.observe(bookmarkRowRef.current)
    if (systemRowRef.current) observer.observe(systemRowRef.current)
    return () => observer.disconnect()
  }, [ungroupedBookmarks.length, profile.bookmarks.length, bookmarkQuery, openGroupMenu, item.w])
  // 系统默认浏览器的书签：和「我的收藏」网址重复的不再重复显示（登录谷歌后两行几乎一样就是这么来的）。
  const systemBookmarks = profile.bookmarks.filter((bookmark) => !bookmarks.some((entry) => entry.url === bookmark.url))
  const hiddenSystemBookmarkCount = profile.bookmarks.length - systemBookmarks.length
  const removeDuplicateBookmarks = () => {
    const seen = new Set<string>()
    const next = bookmarks.filter((entry) => {
      if (seen.has(entry.url)) return false
      seen.add(entry.url)
      return true
    })
    if (next.length !== bookmarks.length) publishSettingsPatch({ webBookmarks: next })
  }

  const assignBookmarkGroup = (id: string, group: string) => publishSettingsPatch({
    webBookmarks: bookmarks.map((entry) => entry.id === id ? { ...entry, group: group || undefined } : entry),
  })
  // 书签栏的每一项（我的收藏那一行、以及分组下拉里共用同一段 JSX）。
  const renderBookmarkItem = (bookmark: WebBookmark) => (<span className={`personal-bookmark${dropHint?.id === bookmark.id ? (dropHint.after ? ' drop-after' : ' drop-before') : ''}`} key={bookmark.id} data-bookmark-id={bookmark.id} draggable={editingId !== bookmark.id}


          onDragStart={(event) => { dragIdRef.current = bookmark.id; event.dataTransfer.effectAllowed = 'move' }}


          onDragEnd={() => { dragIdRef.current = null; setDropHint(null) }}


          onDragOver={(event) => {
            if (!dragIdRef.current && !groupDragRef.current) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            const hover = event.currentTarget.getBoundingClientRect()
            const after = event.clientX > hover.left + hover.width / 2
            setDropHint((previous) => (previous?.id === bookmark.id && previous?.after === after ? previous : { id: bookmark.id, after }))
          }}
          onDragLeave={() => setDropHint(null)}
          onDrop={(event) => { const draggedId = dragIdRef.current; if (!draggedId) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); reorderBookmark(draggedId, bookmark.id, event.clientX >= rect.left + rect.width / 2); dragIdRef.current = null }}>


          {groupEditorId === bookmark.id ? <select className="bookmark-group-select" autoFocus defaultValue={bookmark.group ?? ''}


              onChange={(event) => {


                const value = event.target.value


                if (value === '__new__') { setNewGroupFor(bookmark.id); setGroupNameDraft(''); return }


                assignBookmarkGroup(bookmark.id, value)


                setGroupEditorId(null)


              }}


              onBlur={() => setGroupEditorId(null)}>


              <option value="">未分组</option>


              {bookmarkGroups.map((group) => <option key={group} value={group}>{group}</option>)}


              <option value="__new__">＋新建分组…</option>



            </select> : null}



{newGroupFor === bookmark.id ? <input className="bookmark-group-new-inline" autoFocus defaultValue="" placeholder="分组名"


              onKeyDown={(event) => {


                if (event.key !== 'Enter') return


                const name = (event.currentTarget.value || '').trim().slice(0, 24)


                if (!name) return


                assignBookmarkGroup(bookmark.id, name)


                setNewGroupFor(null)


                setGroupEditorId(null)


              }}


              onBlur={(event) => {


                // 失焦也算确认：从输入框里现读值，不依赖 state（避免闭包拿到旧值）


                const name = (event.currentTarget.value || '').trim().slice(0, 24)


                if (name) assignBookmarkGroup(bookmark.id, name)


                setNewGroupFor(null)


              }}/> : null}




            {editingId === bookmark.id ? <input className="bookmark-rename-input" autoFocus defaultValue={bookmark.name} maxLength={120} onFocus={(event) => event.currentTarget.select()} onBlur={(event) => renameBookmark(bookmark.id, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}/> : <button className="bookmark-open" title={bookmark.url} onClick={(event) => navigate(bookmark.url, bookmark.name, event.ctrlKey || event.metaKey)} onAuxClick={(event) => { if (event.button === 1) navigate(bookmark.url, bookmark.name, true) }}><img className="bookmark-favicon" src={faviconFor(bookmark.url) || FALLBACK_FAVICON} alt="" loading="lazy" onError={faviconFallback} /><span>{bookmark.name}</span></button>}

          <button className="bookmark-edit" title={bookmark.group ? `分组：${bookmark.group}` : '设置分组'} onClick={() => { setGroupEditorId(bookmark.id); setGroupNameDraft('') }}>{uiIcon('grid', 11)}</button>


          <button className="bookmark-edit" title="改名" onClick={() => setEditingId(bookmark.id)}>{uiIcon('rename', 11)}</button>


          <button className="bookmark-delete" title="删除" onClick={() => deleteBookmark(bookmark.id)}>{uiIcon('close', 11)}</button>


        </span>)

  const importSystemBookmarks = () => {
    const incoming = profile.bookmarks
      .filter((bookmark) => /^https?:\/\//i.test(bookmark.url))
      .filter((bookmark) => !bookmarks.some((entry) => entry.url === bookmark.url))
      .slice(0, 400)
    if (!incoming.length) return
    publishSettingsPatch({ webBookmarks: [...bookmarks, ...incoming.map((bookmark, index) => ({
      id: `imported-${Date.now()}-${index}`,
      name: (bookmark.name || bookmark.url).trim().slice(0, 120),
      url: bookmark.url.trim().slice(0, 4096),
      group: '系统导入',
    }))] })
  }
  const reorderBookmark = (draggedId: string, targetId: string, after: boolean) => {
    const from = bookmarks.findIndex((entry) => entry.id === draggedId)
    const target = bookmarks.findIndex((entry) => entry.id === targetId)
    if (from < 0 || target < 0 || from === target) return
    const next = [...bookmarks]
    const [dragged] = next.splice(from, 1)
    let insertion = target + (after ? 1 : 0)
    if (from < insertion) insertion -= 1
    next.splice(clamp(insertion, 0, next.length), 0, dragged)
    publishSettingsPatch({ webBookmarks: next })
  }
  const wheelHorizontally = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.currentTarget.scrollLeft += event.deltaY || event.deltaX
  }
  // 卡片上的「有效网址」：优先用卡片自己的 source，没设过就用地址框里显示的地址。
  // 星标是否已收藏要按同一个值比，否则 source 为空的卡片永远显示「未收藏」→
  // 每点一次就重复加一条，且看起来毫无反应。
  const currentUrl = item.source || address
  const saved = Boolean(currentUrl) && bookmarks.some((entry) => entry.url === currentUrl)
  const closeMore = () => updateMoreOpen(false)
  const requestAudio = () => window.dispatchEvent(new CustomEvent(WEB_CARD_AUDIO_EVENT, { detail: { itemId: item.id } }))

  return <div className="browser-card-body">
    {/* 地址行（后退 / 前进 / 刷新 / 网址 / 收藏）：2026-09-13 按用户要求恢复。
        上一版把整行删掉是我理解错了——他要删的是「生成网页后全局常用下方多出来的那个条目」，
        而网页卡自己的这条地址行是**需要**的。 */}
    <div className="browser-card-address" onPointerDown={(event) => event.stopPropagation()}>
      <span className="browser-card-nav">
        <button title="后退" aria-label="后退" onClick={() => postNativeBrowserCommand(item.id, 'back')}>{uiIcon('back', 15)}</button>
        <button title="前进" aria-label="前进" onClick={() => postNativeBrowserCommand(item.id, 'forward')}>{uiIcon('forward', 15)}</button>
        <button title="刷新" aria-label="刷新" onClick={() => postNativeBrowserCommand(item.id, 'reload')}>{uiIcon('refresh', 15)}</button>
      </span>
      <form onSubmit={(event) => { event.preventDefault(); const value = address.trim(); if (!value) return; navigate(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`) }}>
        <input value={address} spellCheck={false} placeholder="输入网址后回车，例如 bilibili.com" onChange={(event) => setAddress(event.target.value)} onPointerDown={(event) => event.stopPropagation()}/>
      </form>
      {/* 星标=收藏开关：以前「已经收藏过」时点了直接 return（一点反馈都没有，用户会以为坏了）。
          现在点已收藏的星＝取消收藏，并且两次都给一句提示。 */}
      <button className={saved ? 'is-saved' : ''} title={saved ? '取消收藏（已在我的收藏里）' : '收藏当前网址到“我的收藏”'} aria-label="收藏" onClick={() => {
        if (saved) {
          const next = bookmarks.filter((entry) => entry.url !== currentUrl)
          noteBookmarkRemoval([currentUrl])
          setBookmarks(next)
          publishSettingsPatch({ webBookmarks: next })
          pushAppToast('已从「我的收藏」移除')
          return
        }
        // 名字：网页标题优先；本地文件（标题常是「新标签页」）退化成文件名，免得收藏栏里一堆同名。
        const rawTitle = (item.title || '').trim()
        const tail = decodeURIComponent(currentUrl.split(/[\\/]/).filter(Boolean).pop() || '')
        const name = rawTitle && rawTitle !== '新标签页' && rawTitle !== 'about:blank' ? rawTitle : (tail || currentUrl)
        const next: WebBookmark[] = [...bookmarks, { id: `bookmark-${Date.now()}`, name, url: currentUrl }]
        setBookmarks(next)
        publishSettingsPatch({ webBookmarks: next })
        pushAppToast('已收藏到「我的收藏」（在顶栏的收藏栏里）')
      }}>{uiIcon('star', 15)}</button>
      <button title="当前发声" aria-label="当前发声" onClick={requestAudio}>{uiIcon('volume', 15)}</button>
      <label className="card-volume" title={"音量 " + Math.round((item.volume ?? 1) * 100) + "%（拖这个拉杆调节；0 = 静音）"}>
        <input type="range" min={0} max={100} step={1} value={Math.round((item.volume ?? 1) * 100)} aria-label="音量"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => window.dispatchEvent(new CustomEvent(CARD_VOLUME_EVENT, { detail: { itemId: item.id, value: Number(event.currentTarget.value) / 100 } }))}/>
        <span>{Math.round((item.volume ?? 1) * 100)}</span>
      </label>
      <details className="browser-card-more" open={moreOpen} onToggle={(event) => updateMoreOpen(event.currentTarget.open)}>
        <summary title="更多">{uiIcon('more', 15)}</summary>
        <div role="menu">
          <button onClick={() => { applyZoom((browserSettings.browserZoom[browserHost] ?? 1) + 0.1); closeMore() }}>{uiIcon('plus', 13)}<span>放大</span></button>
          <button onClick={() => { applyZoom((browserSettings.browserZoom[browserHost] ?? 1) - 0.1); closeMore() }}>{uiIcon('more', 13)}<span>缩小</span></button>
          <button onClick={() => { applyZoom(1); closeMore() }}>{uiIcon('refresh', 13)}<span>重置缩放（100%）</span></button>
          <button onClick={() => { window.chrome?.webview?.postMessage({ type: 'native-browser-devtools', surfaceId: item.id }); closeMore() }}>{uiIcon('more', 13)}<span>开发者工具</span></button>
          <button onClick={() => { toggleUserAgent(); closeMore() }}>{uiIcon('more', 13)}<span>{userAgentMode === 'chrome' ? '恢复默认浏览器标识' : '伪装成 Chrome'}</span></button>
          {recentUrls.length ? <i className="canvas-menu-sep"/> : null}
          {recentUrls.map((url) => <button key={url} title={url} onClick={() => { navigate(url); closeMore() }}>{uiIcon('eye', 13)}<span>{url.replace(/^https?:\/\//, '').slice(0, 34)}</span></button>)}
        </div>
      </details>
    </div>
        <div className="browser-card-bookmarks" onPointerDown={(event) => event.stopPropagation()}>
      <div className="bookmark-tools" onPointerDown={(event) => event.stopPropagation()}>
        <div className="bookmark-groups">
          {bookmarkGroups.map((group) => <span className="bookmark-group-chip-wrap" key={group}>
            <button className={`bookmark-group-chip${openGroupMenu === group ? ' active' : ''}`} data-group={group} draggable
              title="拖动可排序；点开看这一栏的书签；把书签拖到这里即归类"
              onDragStart={(event) => { groupDragRef.current = group; event.dataTransfer.effectAllowed = 'move' }}
              onDragEnd={() => { groupDragRef.current = null }}
              onClick={(event) => {
                if (openGroupMenu === group) { setOpenGroupMenu(null); return }
                const rect = event.currentTarget.getBoundingClientRect()
                groupChipAnchorRef.current = event.currentTarget
                const width = Math.min(330, window.innerWidth - 24)
                const placement = menuPlacement(rect.bottom)
                setGroupMenuAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: placement.top, maxHeight: placement.maxHeight })
                setOpenGroupMenu(group)
              }}
              onDragOver={(event) => { if (dragIdRef.current || groupDragRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
              onDrop={(event) => {
                event.preventDefault()
                if (groupDragRef.current && groupDragRef.current !== group) { reorderGroups(groupDragRef.current, group); groupDragRef.current = null; return }
                const id = dragIdRef.current
                if (id) assignBookmarkGroup(id, group)
              }}>▣ {group}<em>{bookmarks.filter((entry) => entry.group === group).length}</em> ▾</button>
            {openGroupMenu === group ? createPortal(<div className="bookmark-group-menu" onClick={(event) => { if ((event.target as HTMLElement).closest('.bookmark-open')) setOpenGroupMenu(null) }} role="menu" style={{ position: 'fixed', left: groupMenuAnchor?.left ?? 12, top: groupMenuAnchor?.top ?? 120, maxHeight: groupMenuAnchor?.maxHeight ?? 320 }} onPointerDown={(event) => event.stopPropagation()}>
              {groupBookmarks(group).length ? groupBookmarks(group).map(renderBookmarkItem) : <small>这一栏还没有书签：把书签拖到上面的按钮上</small>}
            </div>, previewOverlayRoot()) : null}
          </span>)}
          <input className="bookmark-group-new" value={groupDraft} onChange={(event) => setGroupDraft(event.target.value)} placeholder="+ 分组"
            onKeyDown={(event) => { if (event.key !== 'Enter') return; const name = groupDraft.trim().slice(0, 24); if (!name) return; setGroupDraft(''); setDraftGroups((list) => list.includes(name) ? list : [...list, name]) }}/>
        </div>
        <input className="bookmark-search" value={bookmarkQuery} onChange={(event) => setBookmarkQuery(event.target.value)} placeholder="搜索收藏（名称或网址）" spellCheck={false}/>
        <span className="bookmark-tools-actions">
          <button onClick={removeDuplicateBookmarks} title="删掉网址重复的收藏，每组只留第一条">去重</button>
          <button onClick={importSystemBookmarks} title="把系统默认浏览器的书签复制进我的收藏">导入系统书签</button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('zhangzhongjie-export-bookmarks'))} title="导出为 HTML 书签文件（可导入系统浏览器）">导出 HTML</button>
        </span>
        <span className="bookmark-tools-hint">分组胶囊可拖动排序；点开是竖排列表，把书签拖上去即归类</span>
      </div>
      <div className="bookmarkbar personal-bookmarkbar" aria-label="掌中界我的收藏">
        <span className="browser-source personal" title="未分组的收藏；把别的栏里的书签拖到这里＝移出分组"
          onDragOver={(event) => { if (dragIdRef.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
          onDrop={(event) => { const id = dragIdRef.current; if (!id) return; event.preventDefault(); assignBookmarkGroup(id, '') }}><b>★</b>我的收藏</span>
        <div className={`bookmark-items personal-bookmark-items${overflowOpen ? ' overflow-open' : ''}`} ref={bookmarkRowRef} onWheel={wheelHorizontally}>{ungroupedBookmarks.length ? ungroupedBookmarks.map(renderBookmarkItem) : <small>点地址栏右侧的星标收藏当前网页</small>}</div>
        {overflowIds.length ? <button className="bookmark-overflow-more" title="一行放不下的收藏都在这里"
          onClick={(event) => {
            if (overflowOpen && overflowKind === 'personal') { setOverflowOpen(false); return }
            const rect = event.currentTarget.getBoundingClientRect()
            overflowBtnAnchorRef.current = event.currentTarget
            const placement = menuPlacement(rect.bottom)
            setOverflowKind('personal')
            setOverflowAnchor({ left: Math.max(8, rect.right - 320), top: placement.top, maxHeight: placement.maxHeight })
            setOverflowOpen(true)
          }}>▸ {overflowIds.length}</button> : null}
        <em>{ungroupedBookmarks.length} 项</em>
      </div>
      {overflowOpen && (overflowKind === 'system' ? systemOverflowIds.length : overflowIds.length) ? createPortal(<div className="bookmark-overflow-menu" role="menu" onClick={(event) => { if ((event.target as HTMLElement).closest('.bookmark-open')) setOverflowOpen(false) }} style={{ position: 'fixed', left: overflowAnchor?.left ?? 12, top: overflowAnchor?.top ?? 120, maxHeight: overflowAnchor?.maxHeight ?? 320 }} onPointerDown={(event) => event.stopPropagation()}>
        {overflowKind === 'system'
          ? systemBookmarks.filter((entry) => systemOverflowIds.includes(entry.url)).map((entry) => <button key={entry.url} className="bookmark-overflow-item" title={entry.folder ? `${entry.folder} › ${entry.name}` : entry.url} onClick={(event) => { navigate(entry.url, entry.name, event.ctrlKey || event.metaKey); setOverflowOpen(false) }}><img className="bookmark-favicon" src={faviconFor(entry.url) || FALLBACK_FAVICON} alt="" loading="lazy" onError={faviconFallback}/><span>{entry.name}</span></button>)
          : bookmarks.filter((entry) => overflowIds.includes(entry.id)).map(renderBookmarkItem)}
      </div>, previewOverlayRoot()) : null}
      <div className="bookmarkbar system-bookmarkbar" aria-label="系统默认浏览器收藏夹">
        <div className="bookmark-items system-bookmark-items" ref={systemRowRef} onWheel={wheelHorizontally}>{systemBookmarks.length ? systemBookmarks.map((bookmark, index) => <button key={`${bookmark.url}-${index}`} data-bookmark-id={bookmark.url} title={bookmark.folder ? `${bookmark.folder} › ${bookmark.name}\n${bookmark.url}` : bookmark.url} onClick={(event) => navigate(bookmark.url, bookmark.name, event.ctrlKey || event.metaKey)} onAuxClick={(event) => { if (event.button === 1) navigate(bookmark.url, bookmark.name, true) }}>{bookmark.folder ? uiIcon('folder', 12) : <img className="bookmark-favicon" src={faviconFor(bookmark.url) || FALLBACK_FAVICON} alt="" loading="lazy" onError={faviconFallback} />}<span>{bookmark.name}</span></button>) : <small>没有读到系统浏览器的书签</small>}</div>
        {systemOverflowIds.length ? <button className="bookmark-overflow-more" title="一行放不下的系统书签都在这里"
          onClick={(event) => {
            if (overflowOpen && overflowKind === 'system') { setOverflowOpen(false); return }
            const rect = event.currentTarget.getBoundingClientRect()
            overflowBtnAnchorRef.current = event.currentTarget
            const placement = menuPlacement(rect.bottom)
            setOverflowAnchor({ left: Math.max(8, Math.round(rect.right) - 320), top: placement.top, maxHeight: placement.maxHeight })
            setOverflowKind('system')
            setOverflowOpen(true)
          }}>▸ {systemOverflowIds.length}</button> : null}
      </div>
    </div>
    <NativeSurfaceSlot item={item} paintOrder={paintOrder} overlaySnapshot={menuOverPage}/>
  </div>
})

function PortalBody({ item }: { item: CanvasItem }) {
  const cad = item.title.includes('AutoCAD')
  return <div className="portal-content"><div className="portal-head"><span style={{ background: item.accent }}>{cad ? 'A' : '3'}</span><div><b>{item.title}</b><small>状态 · 已就绪</small></div><i>●</i></div><div className={`portal-preview ${cad ? 'cad-preview' : 'max-preview'}`}>{cad ? <span className="cad-lines">⌜ ─ ┐<br/>│ ╱ │<br/>└ ─ ⌟</span> : <div className="max-room"><i/><i/><i/></div>}</div><div className="portal-meta"><span>{item.subtitle}</span><b>双击切换到应用</b></div></div>
}

type TodoEntry = { id: string; text: string; done: boolean }

// 待办清单卡：本质是「带 todo 字段的便签卡」，套用模板时勾选会被清零（新的一天从没打勾开始）
const TodoBody = memo(function TodoBody({ item }: { item: CanvasItem }) {
  const entries = item.todo ?? []
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const push = (next: TodoEntry[], history: boolean) => window.dispatchEvent(new CustomEvent('zhangzhongjie-todo-update', { detail: { itemId: item.id, todo: next, history } }))
  const add = () => {
    const text = draft.trim()
    if (!text) return
    push([...entries, { id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, done: false }], true)
    setDraft('')
  }
  return <div className="todo-body" onPointerDown={(event) => event.stopPropagation()}>
    <div className="todo-list">
      {entries.length ? entries.map((entry) => <div key={entry.id} className={`todo-row${entry.done ? ' is-done' : ''}`}>
        <button type="button" className="todo-check" role="checkbox" aria-checked={entry.done} aria-label={entry.text} onClick={() => push(entries.map((row) => (row.id === entry.id ? { ...row, done: !row.done } : row)), true)}>{entry.done ? '✓' : ''}</button>
        <span className="todo-text">{entry.text}</span>
        <button type="button" className="todo-remove" title="删除这一条" aria-label={`删除 ${entry.text}`} onClick={() => push(entries.filter((row) => row.id !== entry.id), true)}>{uiIcon('close', 11)}</button>
      </div>) : <p className="todo-empty">还没有待办 —— 点下面的「添加一条」</p>}
      {/* 用户 2026-09-14：待办卡要一行「＋ 添加」——点它就地变输入框，回车/点空白加上，Esc 取消 */}
      {adding
        ? <div className="todo-row is-adding">
            <span className="todo-check todo-check-add" aria-hidden="true">{uiIcon('plus', 11)}</span>
            <input className="todo-inline-input" autoFocus value={draft} maxLength={120} placeholder="回车或点空白处加上 · Esc 取消"
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); add() }
                if (event.key === 'Escape') { event.preventDefault(); setAdding(false) }
              }}
              onBlur={() => { if (draft.trim()) add(); else setAdding(false) }}/>
          </div>
        : <button type="button" className="todo-add-row" onPointerDown={(event) => event.stopPropagation()} onClick={() => setAdding(true)}>{uiIcon('plus', 12)}添加一条</button>}
    </div>
  </div>
})

const NoteBody = memo(function NoteBody({ item }: { item: CanvasItem }) {
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef(item.text ?? '')
  const committedRef = useRef(item.text ?? '')
  const editingRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  const beginEdit = useCallback(() => {
    if (editingRef.current) return
    editingRef.current = true
    window.dispatchEvent(new CustomEvent(NOTE_EDIT_START_EVENT, { detail: { itemId: item.id } }))
  }, [item.id])

  const commit = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    const text = draftRef.current
    if (text === committedRef.current) return
    committedRef.current = text
    const firstLine = text.split(/\r?\n/, 1)[0].trim().slice(0, 80)
    window.dispatchEvent(new CustomEvent(NOTE_COMMIT_EVENT, {
      detail: { itemId: item.id, text, title: firstLine || '新便签' },
    }))
  }, [item.id])

  const scheduleCommit = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(commit, 300)
  }, [commit])

  useLayoutEffect(() => {
    const next = item.text ?? ''
    committedRef.current = next
    const editor = editorRef.current
    if (editor && document.activeElement !== editor && editor.value !== next) {
      editor.value = next
      draftRef.current = next
    }
  }, [item.text])

  useEffect(() => () => commit(), [commit])

  return <div className="note-content note-plain"><textarea
    ref={editorRef}
    defaultValue={item.text ?? ''}
    spellCheck={false}
    aria-label="便签正文"
    placeholder="输入便签内容…"
    onInput={(event) => {
      beginEdit()
      draftRef.current = event.currentTarget.value
      scheduleCommit()
    }}
    onBlur={() => {
      commit()
      editingRef.current = false
    }}
    onPointerDown={(event) => {
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
    }}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return
      event.preventDefault()
      beginEdit()
      const editor = event.currentTarget
      const start = editor.selectionStart
      editor.setRangeText('  ', start, editor.selectionEnd, 'end')
      draftRef.current = editor.value
      scheduleCommit()
    }}
    onWheel={stopWheelPropagation}
  /></div>
})

const SHELF_MAX_ITEMS = 40

type ClipboardHistoryEntry = { id: string; kind: 'text' | 'image' | 'files'; text: string; path?: string; paths?: string[]; width?: number; height?: number; at: number }

// 剪贴暂存 = 自动剪贴历史（Win+V 式）：复制/截图自动进列表；
// 图片落盘只记路径、文件只记引用、文本限长 —— 工程文件保持小体积。
const ShelfBody = memo(function ShelfBody({ item }: { item: CanvasItem }) {
  const [entries, setEntries] = useState<ClipboardHistoryEntry[] | null>(null)
  const [autoCapture, setAutoCapture] = useState(true)
  const [canvasMode, setCanvasMode] = useState(true)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<{ entry: ClipboardHistoryEntry; dataUrl?: string } | null>(null)
  const [filterKind, setFilterKind] = useState<'all' | 'image' | 'files' | 'text'>('all')
  const [filterQuery, setFilterQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const requestSerialRef = useRef(0)
  const thumbRequestedRef = useRef(new Set<string>())
  const lastClickedIndexRef = useRef(-1)
  const seededRef = useRef(false)
  const dataUrlRequestsRef = useRef(new Map<string, (value: string) => void>())

  const call = (payload: Record<string, unknown>) => window.chrome?.webview?.postMessage(payload)

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const onMessage = (event: MessageEvent<NativeHostMessage>) => {
      const message = event.data
      if (message?.type === 'native-clipboard-history' && String(message.requestId ?? '').startsWith('shelf-')) {
        setEntries(Array.isArray(message.items) ? [...message.items].reverse() : [])
        setAutoCapture(message.auto !== false)
        setCanvasMode(message.canvasMode !== false)
        return
      }
      if (message?.type === 'native-clipboard-history-item' && message.item) {
        const entry = message.item
        setEntries((current) => {
          const list = current ?? []
          if (list.some((candidate) => candidate.id === entry.id)) return list
          return [entry, ...list]
        })
        return
      }
      if (message?.type === 'native-image-dataurl') {
        const resolver = dataUrlRequestsRef.current.get(String(message.requestId ?? ''))
        if (resolver) {
          dataUrlRequestsRef.current.delete(String(message.requestId ?? ''))
          resolver(String(message.dataUrl ?? ''))
        }
        return
      }
      if (message?.type === 'native-shelf-capture-result' && String(message.requestId ?? '').startsWith(`shelf-${item.id}-`) && message.kind === 'empty') {
        pushAppToast('剪贴板里没有可暂存的内容')
        return
      }
      if (message?.type === 'native-explorer-metadata-chunk' && message.purpose === 'global-favorite-icon') {
        const requestId = String(message.requestId ?? '')
        if (!requestId.startsWith(`shelf-thumb-${item.id}-`)) return
        const updates: Record<string, string> = {}
        for (const entry of message.entries ?? []) {
          if (entry.path && entry.image?.startsWith('data:image/')) updates[entry.path] = entry.image
        }
        if (Object.keys(updates).length) setThumbs((current) => ({ ...current, ...updates }))
      }
    }
    bridge.addEventListener('message', onMessage)
    // 旧的卡片内数据一次性迁移进历史（去重合并），并请求全量列表
    const legacy = item.shelfItems ?? []
    if (legacy.length && !seededRef.current) {
      seededRef.current = true
      for (const entry of legacy) {
        call({ type: 'native-clipboard-history-append', requestId: `shelf-${item.id}-seed`, item: entry })
      }
      window.dispatchEvent(new CustomEvent(SHELF_COMMIT_EVENT, { detail: { itemId: item.id, shelfItems: [] } }))
    } else {
      requestSerialRef.current += 1
      call({ type: 'native-clipboard-history-request', requestId: `shelf-${item.id}-${requestSerialRef.current}` })
    }
    return () => bridge.removeEventListener('message', onMessage)
  }, [item.id])

  // 图片条目按路径取缩略图（收藏图标通道，宿主按需生成，不占工程体积）
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !entries) return
    const missing = entries.filter((entry) => entry.kind === 'image' && entry.path && !thumbRequestedRef.current.has(entry.path))
    if (!missing.length) return
    for (const entry of missing) thumbRequestedRef.current.add(entry.path!)
    requestSerialRef.current += 1
    bridge.postMessage({
      type: 'native-explorer-metadata-request',
      purpose: 'global-favorite-icon',
      requestId: `shelf-thumb-${item.id}-${requestSerialRef.current}`,
      thumbnailPixels: 256,
      paths: missing.map((entry) => entry.path),
    })
  }, [item.id, entries])

  const visibleEntries = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase()
    return (entries ?? []).filter((entry) => {
      if (filterKind !== 'all' && entry.kind !== filterKind) return false
      if (!query) return true
      if (entry.text.toLocaleLowerCase().includes(query)) return true
      if (entry.path?.toLocaleLowerCase().includes(query)) return true
      return (entry.paths ?? []).some((path) => path.toLocaleLowerCase().includes(query))
    })
  }, [entries, filterKind, filterQuery])
  const kindCounts = useMemo(() => {
    const counts = { all: 0, image: 0, files: 0, text: 0 }
    for (const entry of entries ?? []) {
      counts.all += 1
      counts[entry.kind] += 1
    }
    return counts
  }, [entries])
  useEffect(() => {
    setSelection(new Set())
    lastClickedIndexRef.current = -1
  }, [filterKind, filterQuery])

  const writeClipboardText = (text: string, note: string) => {
    const bridge = window.chrome?.webview
    if (bridge) { bridge.postMessage({ type: 'native-clipboard-write', text }); pushAppToast(note) }
    else if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).then(() => pushAppToast(note)).catch(() => {})
  }
  const requestImageDataUrl = (path: string) => new Promise<string>((resolve) => {
    const bridge = window.chrome?.webview
    if (!bridge || !path) { resolve(''); return }
    requestSerialRef.current += 1
    const requestId = `shelf-dataurl-${item.id}-${requestSerialRef.current}`
    dataUrlRequestsRef.current.set(requestId, resolve)
    bridge.postMessage({ type: 'native-read-image-dataurl', requestId, path })
    window.setTimeout(() => {
      if (dataUrlRequestsRef.current.has(requestId)) {
        dataUrlRequestsRef.current.delete(requestId)
        resolve('')
      }
    }, 12000)
  })

  const focusList = () => listRef.current?.focus()
  const selectEntry = (entry: ClipboardHistoryEntry, index: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    focusList()
    // 锚点必须在事件时刻冻结：setSelection 的 updater 在下一次渲染才执行，
    // 若在 updater 里读 ref，ref 早已被同步更新成当前项，Shift 范围选择会退化成单选。
    const anchor = lastClickedIndexRef.current
    const shift = event.shiftKey
    const toggle = event.ctrlKey || event.metaKey
    setSelection((current) => {
      if (shift && anchor >= 0) {
        const start = Math.min(anchor, index)
        const end = Math.max(anchor, index)
        return new Set(visibleEntries.slice(start, end + 1).map((candidate) => candidate.id))
      }
      const next = new Set(current)
      if (toggle) {
        if (next.has(entry.id)) next.delete(entry.id)
        else next.add(entry.id)
        return next
      }
      return new Set([entry.id])
    })
    lastClickedIndexRef.current = index
  }
  const copyEntry = (entry: ClipboardHistoryEntry) => {
    if (entry.kind === 'image' && entry.path) {
      call({ type: 'native-clipboard-write-image', path: entry.path })
      pushAppToast('已把图片复制到剪贴板，可直接贴回')
    } else if (entry.kind === 'files') {
      writeClipboardText((entry.paths ?? []).join(String.fromCharCode(13, 10)), '已复制文件路径')
    } else {
      writeClipboardText(entry.text, '已复制到剪贴板')
    }
  }
  // 双击 / 预览里的「贴到画布」：截图落成画布图片卡；文件打开所在目录；文本落成便签
  const moveEntryToCanvas = (entry: ClipboardHistoryEntry) => {
    if (entry.kind === 'image' && entry.path) {
      pushAppToast('正在把图片贴到画布…')
      void requestImageDataUrl(entry.path).then((dataUrl) => {
        if (!dataUrl) { pushAppToast('读取图片失败'); return }
        window.dispatchEvent(new CustomEvent('zhangzhongjie-add-image', { detail: { dataUrl, width: entry.width, height: entry.height, title: entry.text } }))
        pushAppToast('已把图片贴到画布')
      })
      return
    }
    if (entry.kind === 'files') {
      const first = entry.paths?.[0]
      const folder = first ? first.replace(/[\\/][^\\/]+$/, '') : ''
      if (folder) {
        window.dispatchEvent(new CustomEvent('zhangzhongjie-add-folder', { detail: folder }))
        pushAppToast('已在画布打开所在文件夹')
      }
      return
    }
    if (entry.kind === 'text' && entry.text.trim()) {
      window.dispatchEvent(new CustomEvent('zhangzhongjie-add-note', { detail: { text: entry.text } }))
      pushAppToast('已把文本贴到画布（便签）')
    }
  }
  const openPreview = (entry: ClipboardHistoryEntry) => {
    if (entry.kind === 'files') {
      const first = entry.paths?.[0]
      if (first) call({ type: 'native-reveal-path', path: first })
      return
    }
    setPreview({ entry })
    if (entry.kind === 'image' && entry.path) {
      void requestImageDataUrl(entry.path).then((dataUrl) => {
        if (dataUrl) setPreview((current) => current && current.entry.id === entry.id ? { entry, dataUrl } : current)
      })
    }
  }
  const selectedEntries = () => (entries ?? []).filter((entry) => selection.has(entry.id))
  const copySelected = () => {
    const items = selectedEntries()
    if (!items.length) return
    if (items.length === 1) { copyEntry(items[0]); return }
    const texts = items.filter((entry) => entry.kind === 'text').map((entry) => entry.text)
    const paths = items.flatMap((entry) => entry.kind === 'files' ? (entry.paths ?? []) : (entry.kind === 'image' && entry.path) ? [entry.path] : [])
    if (texts.length && !paths.length) writeClipboardText(texts.join(String.fromCharCode(13, 10)), `已复制 ${texts.length} 条文本`)
    else if (paths.length) writeClipboardText(paths.join(String.fromCharCode(13, 10)), `已复制 ${paths.length} 个路径`)
    else pushAppToast('所选内容没有可直接复制的文本或路径')
  }
  const revealSelected = () => {
    const entry = selectedEntries().find((candidate) => (candidate.kind === 'image' && candidate.path) || (candidate.kind === 'files' && candidate.paths?.length))
    if (!entry) return
    const path = entry.kind === 'image' ? entry.path : entry.paths?.[0]
    if (path) call({ type: 'native-reveal-path', path })
  }
  const deleteSelected = (ids?: string[]) => {
    const targets = ids ?? [...selection]
    if (!targets.length) return
    setEntries((current) => (current ?? []).filter((entry) => !targets.includes(entry.id)))
    setSelection(new Set())
    if (preview && targets.includes(preview.entry.id)) setPreview(null)
    requestSerialRef.current += 1
    call({ type: 'native-clipboard-history-remove', ids: targets, requestId: `shelf-${item.id}-rm-${requestSerialRef.current}` })
    pushAppToast(`已删除 ${targets.length} 条记录（磁盘截图文件保留，画布里的内容不受影响）`)
  }
  const clearAll = () => {
    setEntries([])
    setSelection(new Set())
    setPreview(null)
    requestSerialRef.current += 1
    call({ type: 'native-clipboard-history-clear', requestId: `shelf-${item.id}-clr-${requestSerialRef.current}` })
    pushAppToast('已清空列表（磁盘截图文件保留）')
  }
  const toggleAuto = () => {
    const next = !autoCapture
    setAutoCapture(next)
    requestSerialRef.current += 1
    call({ type: 'native-clipboard-history-auto', enabled: next, requestId: `shelf-${item.id}-auto-${requestSerialRef.current}` })
    pushAppToast(next ? '已开启自动记录：以后复制的内容会自动出现在这里' : '已暂停自动记录（手动按钮仍可用）')
  }
  const toggleCanvasMode = () => {
    const next = !canvasMode
    setCanvasMode(next)
    requestSerialRef.current += 1
    call({ type: 'native-capture-canvas-mode', enabled: next, requestId: `shelf-${item.id}-canvas-${requestSerialRef.current}` })
    pushAppToast(next ? '截图后会自动贴到画布（同时保留剪贴暂存记录）' : '截图只进剪贴暂存，不再自动贴到画布')
  }

  const list = entries ?? []
  const selectedCount = selection.size
  const canReveal = selectedEntries().some((entry) => (entry.kind === 'image' && entry.path) || (entry.kind === 'files' && entry.paths?.length))
  return <div className="shelf-content" onPointerDown={(event) => event.stopPropagation()} onWheel={stopWheelPropagation}>
    <div className="shelf-toolbar">
      <button type="button" className={`shelf-add ${autoCapture ? 'is-auto' : ''}`} onClick={toggleAuto} title={autoCapture ? '自动记录已开启：复制、截图会自动出现在列表里。点这里暂停' : '自动记录已暂停。点这里重新开启'}>{uiIcon(autoCapture ? 'eye' : 'mute', 13)}<span>{autoCapture ? '自动记录中' : '已暂停'}</span></button>
      <button type="button" onClick={() => { requestSerialRef.current += 1; call({ type: 'native-shelf-capture', requestId: `shelf-${item.id}-${requestSerialRef.current}` }) }} title="手动立即捕获一次剪贴板（暂停时也能用）">{uiIcon('paste', 13)}</button>
      <button type="button" className={canvasMode ? 'is-auto' : ''} onClick={toggleCanvasMode} title={canvasMode ? '截图后自动贴到画布（开）。点击切换为只进剪贴暂存' : '截图只进剪贴暂存（当前）。点击切换为自动贴到画布'}>{uiIcon('image', 13)}<span>{canvasMode ? '自动贴上画布' : '只进暂存'}</span></button>
      <span className="fm-spacer"/>
      <small>{selectedCount ? `已选 ${selectedCount}` : visibleEntries.length !== list.length ? `${visibleEntries.length}/${list.length} 条` : list.length ? `${list.length} 条` : ''}</small>
      <button type="button" disabled={!selectedCount} onClick={copySelected} title="复制所选：单张图片整图复制；多条文本/路径合并复制">{uiIcon('copy', 13)}</button>
      <button type="button" disabled={!canReveal} onClick={revealSelected} title="在资源管理器中定位所选（图片/文件）">{uiIcon('folder', 13)}</button>
      <button type="button" disabled={!selectedCount} onClick={() => deleteSelected()} title="删除所选记录（磁盘上的截图文件会保留）">{uiIcon('trash', 13)}</button>
      {list.length ? <button type="button" onClick={clearAll} title="清空列表（磁盘上的截图文件会保留）">{uiIcon('close', 13)}</button> : null}
    </div>
    <div className="shelf-filter" onPointerDown={(event) => event.stopPropagation()}>
      {([['all', '全部'], ['image', '图片'], ['files', '文件'], ['text', '文本']] as const).map(([kind, label]) => <button key={kind} type="button" className={filterKind === kind ? 'active' : ''} onClick={() => setFilterKind(kind)}>{label}<i>{kindCounts[kind]}</i></button>)}
      <label className="shelf-filter-search">{uiIcon('search', 12)}<input value={filterQuery} placeholder="过滤关键词…" onChange={(event) => setFilterQuery(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setFilterQuery('') } }}/></label>
    </div>
    <div className="shelf-list" ref={listRef} tabIndex={0} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); setSelection(new Set(visibleEntries.map((entry) => entry.id))); return }
      if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); deleteSelected(); return }
      if (event.key === 'Enter' && selectedCount === 1) { event.preventDefault(); event.stopPropagation(); moveEntryToCanvas(selectedEntries()[0]); return }
      if (event.key === 'Escape') { event.stopPropagation(); if (preview) setPreview(null); else setSelection(new Set()) }
    }}>
      {entries === null
        ? <p className="shelf-empty">正在读取剪贴历史…</p>
        : list.length === 0
          ? <p className="shelf-empty">{autoCapture ? '还没有记录。复制任何内容（Ctrl+C、截图、复制文件）都会自动出现在这里；双击条目即可贴到画布。' : '自动记录已暂停。点左上角重新开启，或用手动按钮抓取一次。'}</p>
          : visibleEntries.length === 0
          ? <p className="shelf-empty">没有匹配的记录（筛选：{filterKind === 'all' ? '全部' : filterKind === 'image' ? '图片' : filterKind === 'files' ? '文件' : '文本'}{filterQuery ? ` + 关键词“${filterQuery}”` : ''}）</p>
          : visibleEntries.map((entry, index) => <div
              className={`shelf-item is-${entry.kind} ${selection.has(entry.id) ? 'is-selected' : ''}`}
              key={entry.id}
              onClick={(event) => selectEntry(entry, index, event)}
              onDoubleClick={() => moveEntryToCanvas(entry)}
              title={entry.kind === 'text' ? entry.text : (entry.path ?? (entry.paths ?? []).join(String.fromCharCode(10)))}
            >
              {entry.kind === 'image' && entry.path
                ? (thumbs[entry.path] ? <img className="shelf-thumb" src={thumbs[entry.path]} alt={entry.text} draggable={false}/> : <span className="shelf-thumb is-loading" title="正在生成缩略图…"/>)
                : <span className="shelf-kind-icon">{uiIcon(entry.kind === 'files' ? 'folder' : 'file', 15)}</span>}
              <p>{entry.text}</p>
              <span className="shelf-actions">
                <button type="button" title="复制（图片整图复制，可直接贴回）" onClick={(event) => { event.stopPropagation(); copyEntry(entry) }}>{uiIcon('copy', 12)}</button>
                <button type="button" title={entry.kind === 'files' ? '在资源管理器中定位' : '预览'} onClick={(event) => { event.stopPropagation(); openPreview(entry) }}>{uiIcon('eye', 12)}</button>
                <button type="button" title="删除这条（磁盘截图文件保留）" onClick={(event) => { event.stopPropagation(); deleteSelected([entry.id]) }}>{uiIcon('trash', 12)}</button>
              </span>
            </div>)}
    </div>
    {preview ? <div className="shelf-preview" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {preview.entry.kind === 'text'
        ? <div className="shelf-preview-text">{preview.entry.text}</div>
        : <img src={preview.dataUrl || (preview.entry.path ? thumbs[preview.entry.path] || '' : '')} alt={preview.entry.text} draggable={false}/>}
      <div className="shelf-preview-actions">
        <button type="button" onClick={() => copyEntry(preview.entry)}>{uiIcon('copy', 12)}复制</button>
        <button type="button" onClick={() => { moveEntryToCanvas(preview.entry); setPreview(null) }}>{uiIcon('image', 12)}贴到画布</button>
        {preview.entry.kind === 'image' && preview.entry.path ? <button type="button" title="读图 / 取字：让 Hermes 读（理解·更准）或用本地 OCR 抠字（离线·免费）" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); requestImageActionMenu(String(preview.entry.path), { x: Math.round(box.left), y: Math.round(box.top) - 92 }) }}>{uiIcon('eye', 12)}读图 / 取字</button> : null}
        <button type="button" onClick={() => setPreview(null)}>{uiIcon('close', 12)}关闭</button>
      </div>
    </div> : null}
  </div>
})
const ImageBody = memo(function ImageBody({ item }: { item: CanvasItem }) {
  const prefetchTimerRef = useRef<number | null>(null)
  const cancelPrefetch = useCallback(() => {
    if (prefetchTimerRef.current !== null) window.clearTimeout(prefetchTimerRef.current)
    prefetchTimerRef.current = null
  }, [])
  useEffect(() => cancelPrefetch, [cancelPrefetch])
  return <div className="image-content">{item.dataUrl ? <img
    src={item.dataUrl}
    alt={item.title}
    draggable={false}
    onPointerDown={(event) => {
      if (event.button !== 0) return
      event.stopPropagation()
      const bridge = window.chrome?.webview
      bridge?.postMessage({ type: 'native-drag-arm-image', itemId: item.id, imageToken: snapshotImageToken(item.dataUrl) })
      // 普通单击不应复制整份 base64。只有按住超过短阈值，或宿主确认已形成
      // 拖动后主动请求时，才把图片交给宿主。
      cancelPrefetch()
      prefetchTimerRef.current = window.setTimeout(() => {
        prefetchTimerRef.current = null
        bridge?.postMessage({ type: 'native-drag-image-data', itemId: item.id, dataUrl: item.dataUrl ?? '' })
      }, 80)
    }}
    onPointerUp={() => { cancelPrefetch(); window.chrome?.webview?.postMessage({ type: 'native-drag-disarm' }) }}
    onPointerCancel={() => { cancelPrefetch(); window.chrome?.webview?.postMessage({ type: 'native-drag-disarm' }) }}
  /> : <span>图片数据缺失</span>}</div>
})

// 交接文档 §10：复制进来的文件只存路径引用，不把文件本体搬进工程。
type FilePreviewState = {
  status: 'loading' | 'ready' | 'missing'
  image?: string
  thumbKind: 'thumbnail' | 'icon'
  previewKind: 'thumbnail' | 'video' | 'pdf'
  resource?: string
  width: number
  height: number
}

const PdfCardSurface = memo(function PdfCardSurface({ item, resource, poster, paintOrder }: {
  item: CanvasItem
  resource: string
  poster?: string
  paintOrder: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let retireTimer = 0
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        window.clearTimeout(retireTimer)
        setNearViewport(true)
      } else {
        // A short grace interval prevents a surface rebuild while the user is
        // merely brushing the viewport edge. Sustained off-screen cards unmount
        // NativeSurfaceSlot and therefore retire their WebView2 controller.
        retireTimer = window.setTimeout(() => setNearViewport(false), 600)
      }
    }, { rootMargin: '280px' })
    observer.observe(host)
    return () => {
      window.clearTimeout(retireTimer)
      observer.disconnect()
    }
  }, [])

  const placeholder = poster
    ? <img className="fileref-pdf-poster" src={poster} alt="PDF 首页预览" draggable={false}/>
    : <span className="fileref-loading">{uiIcon('document', 38)}<small>正在唤醒 PDF 阅读器…</small></span>
  return <div ref={hostRef} className="fileref-pdf-surface">
    {nearViewport
      ? <NativeSurfaceSlot item={item} paintOrder={paintOrder} surfaceRole="pdf" surfaceSource={resource} placeholder={placeholder}/>
      : placeholder}
  </div>
})

// 文件仍然只是路径引用；缩略图只活在组件 state 里，永远不会进入 CanvasItem/.zzj。
// 应用卡片：双击直接启动；图标与显示名从系统解析，只记路径、不打包任何内容。
const appResolveCache = new Map<string, { name: string; image: string }>()
// ── 桌面卡（2026-09-13 用户要求：「把我桌面的图标拖进画布，和现在这个桌面一样的操作：可以拖动、自动排列」）──
// 一张卡 = 你的桌面图标网格：拖动摆放、自动排列/排序、双击启动、右键菜单；
// 只读桌面（含公共桌面）的 .lnk/.url/.exe 引用，绝不改动真实桌面。
// 桌面卡图标大小三档（用户 2026-09-14：大/中/小，一屏能多放几个）
const DESKTOP_ICON_SIZES = {
  large: { cellW: 92, cellH: 96, iconW: 84, iconH: 90, imgW: 40, label: '大图标' },
  medium: { cellW: 78, cellH: 82, iconW: 70, iconH: 76, imgW: 32, label: '中图标' },
  small: { cellW: 64, cellH: 68, iconW: 56, iconH: 62, imgW: 26, label: '小图标' },
} as const
type DesktopIconSize = keyof typeof DESKTOP_ICON_SIZES
const DESKTOP_PAD = 10

type DesktopIconEntry = { name: string; path: string; image?: string }

const DesktopCardBody = memo(function DesktopCardBody({ item }: { item: CanvasItem }) {
  const sizeKey: DesktopIconSize = item.desktopIconSize ?? 'large'
  const metrics = DESKTOP_ICON_SIZES[sizeKey]
  const raw = item.desktopIcons ?? []
  const sort = item.desktopSort ?? 'name'
  const icons = useMemo<DesktopIconEntry[]>(() => {
    const list = [...raw]
    if (sort === 'type') {
      list.sort((a, b) => {
        const ea = (a.path.split('.').pop() ?? '').toLowerCase()
        const eb = (b.path.split('.').pop() ?? '').toLowerCase()
        return ea === eb ? a.name.localeCompare(b.name, 'zh-Hans-CN') : ea.localeCompare(eb)
      })
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }
    return list
  }, [raw, sort])
  const layout = item.desktopLayout ?? {}
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; icon?: DesktopIconEntry } | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  // 拖动不经过 React state：直接改被拖那个元素的 transform（和系统桌面一样跟手）。
  // 之前每个 pointermove 都 setLive → 整张卡（几十个图标）重渲染一次，掉帧、而且
  // dx/dy 是屏幕像素、卡片又在画布缩放里 → 图标跑得比鼠标慢（用户报「很慢 不丝滑」）。
  const dragRef = useRef<{
    path: string
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
    element: HTMLElement | null
    scale: number
    gridW: number
    gridH: number
    contentW: number
    contentH: number
    startScrollLeft: number
    startScrollTop: number
    visual: { x: number; y: number } | null
    frame: number | null
    hint: HTMLElement | null
    taken: Set<string>
  } | null>(null)

  const patch = useCallback((next: Partial<CanvasItem>) => {
    window.dispatchEvent(new CustomEvent(DESKTOP_CARD_EVENT, { detail: { itemId: item.id, patch: next } }))
  }, [item.id])

  const refresh = useCallback(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const requestId = `desktop-card:${item.id}:${Date.now()}`
    setLoading(true)
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; items?: DesktopIconEntry[] } | undefined
      if (data?.type !== 'native-desktop-shortcuts' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      const list = Array.isArray(data.items)
        ? data.items.flatMap((entry) => entry?.path ? [{ name: entry.name || entry.path, path: entry.path, image: typeof entry.image === 'string' ? entry.image : undefined }] : [])
        : []
      setLoading(false)
      patch({ desktopIcons: list })
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-list-desktop-shortcuts', requestId })
  }, [item.id, patch])

  // 第一次挂载：只有没缓存过才去读（免得每次开掌中界都重新枚举一遍桌面）
  useEffect(() => { if (!(item.desktopIcons ?? []).length) refresh() }, [])

  const measure = useCallback(() => {
    const width = gridRef.current?.clientWidth ?? 820
    return { width, cols: Math.max(1, Math.floor((width - DESKTOP_PAD * 2) / metrics.cellW)) }
  }, [])

  // 没手动摆过的图标按顺序自动排网格；摆过的用它存下来的坐标
  const spots = useMemo(() => {
    const { cols } = measure()
    const map: Record<string, { x: number; y: number }> = {}
    let auto = 0
    icons.forEach((icon) => {
      const saved = layout[icon.path]
      if (saved) { map[icon.path] = saved; return }
      map[icon.path] = { x: DESKTOP_PAD + (auto % cols) * metrics.cellW, y: DESKTOP_PAD + Math.floor(auto / cols) * metrics.cellH }
      auto += 1
    })
    return map
  }, [icons, layout, measure])

  const launch = useCallback((icon: DesktopIconEntry) => {
    window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: icon.path })
  }, [])
  const reveal = useCallback((icon: DesktopIconEntry) => {
    window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: 'C:\\Windows\\explorer.exe', args: `/select,"${icon.path}"` })
  }, [])

  const onPointerDownIcon = (event: React.PointerEvent<HTMLButtonElement>, icon: DesktopIconEntry, spot: { x: number; y: number }) => {
    if (event.button !== 0) return
    event.stopPropagation()
    setSelected(icon.path)
    setMenu(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    // 卡片在画布里可能被整体缩放（0.4~1 倍都有）：鼠标位移要除以这个比例，
    // 否则图标跟不动光标。用「实际渲染宽度 ÷ 布局宽度」量，和文件视图那套同源。
    const scale = rect.width / Math.max(1, element.offsetWidth) || 1
    const grid = gridRef.current
    // 拖动期间哪些格子已经被别的图标占了（用来把「落点」算成最近的那个空格子）
    const taken = new Set<string>()
    for (const entry of icons) {
      if (entry.path === icon.path) continue
      const other = (layout[entry.path] ?? spots[entry.path])
      if (other) taken.add(`${other.x},${other.y}`)
    }
    // 内容区（可滚动的那块）才是图标能去的地方；可见区小得多，用可见区当边界会把图标“粘”在半路。
    dragRef.current = {
      path: icon.path, startX: event.clientX, startY: event.clientY, originX: spot.x, originY: spot.y, moved: false,
      element, scale, gridW: grid?.clientWidth ?? 0, gridH: grid?.clientHeight ?? 0,
      contentW: grid?.scrollWidth ?? grid?.clientWidth ?? 0, contentH: grid?.scrollHeight ?? grid?.clientHeight ?? 0,
      startScrollLeft: grid?.scrollLeft ?? 0, startScrollTop: grid?.scrollTop ?? 0,
      visual: null, frame: null, hint: null, taken,
    }
  }
  // 落点解析：吸附到最近的格子；被占就找**离它最近**的空格（以前是往右一格一格试，
  // 松手时会“蹦”到很远的一列去）。拖动时的提示线和松手用的是同一个函数，所以看到哪就落到哪。
  const resolveDropSpot = useCallback((visual: { x: number; y: number }, taken: Set<string>) => {
    const snapCell = (value: number, cell: number) => DESKTOP_PAD + Math.round((value - DESKTOP_PAD) / cell) * cell
    const target = {
      x: Math.max(DESKTOP_PAD, snapCell(visual.x, metrics.cellW)),
      y: Math.max(DESKTOP_PAD, snapCell(visual.y, metrics.cellH)),
    }
    if (!taken.has(`${target.x},${target.y}`)) return target
    for (let ring = 1; ring <= 12; ring += 1) {
      const ring2: { x: number; y: number }[] = []
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (let dy = -ring; dy <= ring; dy += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          ring2.push({ x: target.x + dx * metrics.cellW, y: target.y + dy * metrics.cellH })
        }
      }
      ring2.sort((first, second) => ((first.x - target.x) ** 2 + (first.y - target.y) ** 2) - ((second.x - target.x) ** 2 + (second.y - target.y) ** 2))
      const free = ring2.find((candidate) => candidate.x >= DESKTOP_PAD && candidate.y >= DESKTOP_PAD && !taken.has(`${candidate.x},${candidate.y}`))
      if (free) return free
    }
    return target
  }, [])

  // 吸附提示：目标格子 + 两条对齐线（设计师熟悉的那种参考线），拖动时才出现


  const clearSnapHint = useCallback((target?: NonNullable<typeof dragRef.current>) => {
    // 松手时 dragRef 已经置空，所以这里必须能显式传入 drag，否则提示线会留在屏幕上。
    const drag = target ?? dragRef.current
    const hint = drag?.hint
    if (hint?.isConnected) hint.remove()
    if (drag) drag.hint = null
  }, [])

  const onPointerMoveIcon = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    if (!drag.moved) { drag.moved = true; drag.element?.classList.add('is-dragging') }
    event.stopPropagation()
    // 贴着上下边拖就自动滚动（跟资源管理器一样），否则下面的图标根本拖不到
    const grid = gridRef.current
    if (grid) {
      const rect = grid.getBoundingClientRect()
      const edge = 26
      if (event.clientY - rect.top < edge) grid.scrollTop -= 10
      else if (rect.bottom - event.clientY < edge) grid.scrollTop += 10
    }
    // 卡片在画布里被缩小时，屏幕上就那么宽：鼠标稍微往外走就出界。
    // 所以拖动期间临时放开网格裁剪，让它一路跟着鼠标；松手才收回网格内落格。
    if (grid && grid.style.overflow !== 'visible') grid.style.overflow = 'visible'
    // 位移按内容坐标算：加上这段时间自己滚动的量，滚动时图标也不会跟丢
    const scrollDx = grid ? grid.scrollLeft - drag.startScrollLeft : 0
    const scrollDy = grid ? grid.scrollTop - drag.startScrollTop : 0
    const localX = (dx + scrollDx) / drag.scale
    const localY = (dy + scrollDy) / drag.scale
    // 拖动期间只做「软边界」：允许跟到卡片外两格。卡片在画布里被缩到 0.48，
    // 鼠标一甩就出界，钉死在边界上就变成用户说的「慢半拍 + 压着邻居」。
    const slackX = metrics.cellW * 2
    const slackY = metrics.cellH * 2
    drag.visual = {
      x: Math.min(Math.max(drag.originX + localX, -slackX), drag.gridW + slackX),
      y: Math.min(Math.max(drag.originY + localY, -slackY), drag.gridH + slackY),
    }
    if (drag.frame === null) {
      drag.frame = window.requestAnimationFrame(() => {
        if (!drag.element) return
        drag.frame = null
        const visual = drag.visual
        if (!visual) return
        drag.element.style.transform = `translate3d(${Math.round(visual.x - drag.originX)}px, ${Math.round(visual.y - drag.originY)}px, 0)`
        // 提示线跟着「真落点」走，不是 1:1 跟着鼠标 —— 所以看到的就是松手后它会去的格子
      })
    }
  }
  const onPointerUpIcon = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.frame !== null) { window.cancelAnimationFrame(drag.frame); drag.frame = null }
    const landed = drag.visual
    // 落位：只动 transform 的一次性平滑归位（以前 left/top 与 transform 一起动，看着会“蹦”两下）
    const settleTo = (spot: { x: number; y: number }, commit?: () => void) => {
      clearSnapHint(drag)
      const el = drag.element
      if (!el) { commit?.(); return }
      el.classList.remove('is-dragging')
      el.classList.add('is-settling')
      el.style.transform = `translate3d(${Math.round(spot.x - drag.originX)}px, ${Math.round(spot.y - drag.originY)}px, 0)`
      window.setTimeout(() => {
        el.style.transition = 'none'
        el.style.left = `${spot.x}px`
        el.style.top = `${spot.y}px`
        el.style.transform = ''
        el.classList.remove('is-settling')
        commit?.()
        window.requestAnimationFrame(() => { el.style.transition = '' })
      }, 150)
    }
    if (!drag.moved || !landed) { const grid = gridRef.current; if (grid) grid.style.overflow = ''; settleTo({ x: drag.originX, y: drag.originY }); return }
    // 拖到卡片外面松手 = 放到画布上（生成一个裸图标），不算卡片内的摆放
    const gridRect = gridRef.current?.getBoundingClientRect()
    const outside = gridRect ? (event.clientX < gridRect.left - 4 || event.clientX > gridRect.right + 4 || event.clientY < gridRect.top - 4 || event.clientY > gridRect.bottom + 8) : false
    if (outside) {
      const entry = icons.find((candidate) => candidate.path === drag.path)
      // 松手落在底部「全局常用」栏上 → 直接固定进去（不建画布图标）
      const barRect = document.querySelector('.fixed-section.current, .global-fixed-section')?.getBoundingClientRect()
      const overBar = !!barRect && event.clientX >= barRect.left && event.clientX <= barRect.right && event.clientY >= barRect.top && event.clientY <= barRect.bottom
      if (overBar && drag.path) {
        settleTo({ x: drag.originX, y: drag.originY })
        window.dispatchEvent(new CustomEvent(GLOBAL_FAVORITE_EVENT, { detail: { source: drag.path, sourceKind: 'app', label: entry?.name ?? '' } }))
        return
      }
      settleTo({ x: drag.originX, y: drag.originY })
      window.dispatchEvent(new CustomEvent(DESKTOP_DRAG_OUT_EVENT, { detail: { clientX: event.clientX, clientY: event.clientY, path: drag.path, name: (entry?.name ?? '').replace(/\.(lnk|url)$/i, '') } }))
      return
    }
    const grid = gridRef.current
    if (grid) grid.style.overflow = ''
    // 落点必须收在网格内容区内（拖动时可以跟出界，落格不行）
    const inside = {
      x: Math.min(Math.max(landed.x, DESKTOP_PAD), Math.max(DESKTOP_PAD, drag.contentW - metrics.cellW - DESKTOP_PAD)),
      y: Math.min(Math.max(landed.y, DESKTOP_PAD), Math.max(DESKTOP_PAD, drag.contentH - metrics.iconH - DESKTOP_PAD)),
    }
    // Windows 式落位：插到落下的那一格，其余的依次让位（永不重叠、空位自动补齐）
    const { cols } = measure()
    const col = Math.max(0, Math.min(cols - 1, Math.round((inside.x - DESKTOP_PAD) / metrics.cellW)))
    const row = Math.max(0, Math.round((inside.y - DESKTOP_PAD) / metrics.cellH))
    const flow = reflowLayout(drag.path, row * cols + col)
    const spot = flow[drag.path] ?? resolveDropSpot(inside, drag.taken)
    settleTo(spot, () => patch({ desktopLayout: flow }))
    event.stopPropagation()  }

  // Windows 桌面那套：图标是一条"顺序"，拖到第 N 位就插到第 N 位，后面的依次往后挪一格。
  const reflowLayout = (movedPath: string, targetIndex: number) => {
    const all = icons.map((entry) => entry.path)
    const placedOrder = all.filter((entry) => layout[entry]).sort((first, second) => (layout[first].y - layout[second].y) || (layout[first].x - layout[second].x))
    const manual = new Set(placedOrder)
    const flow = [...placedOrder, ...all.filter((entry) => !manual.has(entry))]
    const sequence = flow.filter((entry) => entry !== movedPath)
    const at = Math.max(0, Math.min(sequence.length, targetIndex))
    sequence.splice(at, 0, movedPath)
    const { cols } = measure()
    const next: Record<string, { x: number; y: number }> = {}
    sequence.forEach((entry, index) => {
      next[entry] = { x: DESKTOP_PAD + (index % cols) * metrics.cellW, y: DESKTOP_PAD + Math.floor(index / cols) * metrics.cellH }
    })
    return next
  }
  const run = (action: () => void) => () => { setMenu(null); action() }
  const placed = Object.keys(layout).length
  // 换图标大小：手动摆过的坐标按「第几行第几列」重映射到新格子，不会全乱
  const applyIconSize = (nextKey: DesktopIconSize) => {
    if (nextKey === sizeKey) return
    const next = DESKTOP_ICON_SIZES[nextKey]
    const remapped: Record<string, { x: number; y: number }> = {}
    for (const [iconPath, spot] of Object.entries(layout)) {
      const col = Math.round((spot.x - DESKTOP_PAD) / metrics.cellW)
      const row = Math.round((spot.y - DESKTOP_PAD) / metrics.cellH)
      remapped[iconPath] = { x: DESKTOP_PAD + col * next.cellW, y: DESKTOP_PAD + row * next.cellH }
    }
    patch({ desktopIconSize: nextKey, desktopLayout: remapped })
  }
  const cycleIconSize = () => {
    const order: DesktopIconSize[] = ['large', 'medium', 'small']
    applyIconSize(order[(order.indexOf(sizeKey) + 1) % order.length])
  }
  // 菜单点别处 / Esc / 滚轮就关（同裸图标）
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (event.type === 'pointerdown' && target?.closest('.canvas-menu')) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  return <div className="desktop-card-body" data-icon-size={sizeKey} style={{ '--dicon-w': `${metrics.iconW}px`, '--dicon-h': `${metrics.iconH}px`, '--dicon-img': `${metrics.imgW}px` } as CSSProperties} onPointerDown={(event) => event.stopPropagation()}>
    <div className="desktop-grid" ref={gridRef} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }) }}>
      {icons.map((icon) => {
        const spot = spots[icon.path]
        return <button key={icon.path} className={`desktop-icon ${selected === icon.path ? 'selected' : ''}`}
          style={{ left: spot.x, top: spot.y }} title={`${icon.name}\n${icon.path}\n双击打开 · 拖动摆放`}
          onPointerDown={(event) => onPointerDownIcon(event, icon, spots[icon.path])}
          onPointerMove={onPointerMoveIcon} onPointerUp={onPointerUpIcon}
          onDoubleClick={() => launch(icon)}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setSelected(icon.path); setMenu({ x: event.clientX, y: event.clientY, icon }) }}>
          {icon.image ? <img src={icon.image} alt="" draggable={false}/> : <span className="desktop-icon-fallback">{uiIcon('executable', 30)}</span>}
          <span className="desktop-icon-label">{icon.name}</span>
        </button>
      })}
      {!icons.length && !loading ? <div className="desktop-empty">
        <b>没读到桌面图标</b>
        <small>点左上「刷新」再试。只读取桌面与公共桌面上的 .lnk / .url / .exe，不会改动你的桌面。</small>
      </div> : null}
    </div>
    {menu ? createPortal(<CanvasMenu x={menu.x} y={menu.y} onPointerDown={(event) => event.stopPropagation()}>
      {menu.icon ? <>
        <button role="menuitem" onClick={run(() => launch(menu.icon!))}>{uiIcon('eye', 14)}<span>打开</span></button>
        <button role="menuitem" onClick={run(() => reveal(menu.icon!))}>{uiIcon('folder', 14)}<span>打开所在文件夹</span></button>
        <i className="canvas-menu-sep"/>
      </> : null}
      <button role="menuitem" onClick={run(refresh)}>{uiIcon('refresh', 14)}<span>刷新图标</span></button>
      <button role="menuitem" onClick={run(() => patch({ desktopLayout: {} }))}>{uiIcon('grid', 14)}<span>自动排列</span></button>
      <button role="menuitem" onClick={run(() => patch({ desktopSort: 'name' }))}>{uiIcon('sort', 14)}<span>按名称排序</span>{sort === 'name' ? <kbd>当前</kbd> : null}</button>
      <button role="menuitem" onClick={run(() => patch({ desktopSort: 'type' }))}>{uiIcon('sort', 14)}<span>按类型排序</span>{sort === 'type' ? <kbd>当前</kbd> : null}</button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={run(() => patch({ desktopLayout: {} }))}>{uiIcon('trash', 14)}<span>把图标位置恢复默认</span></button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={run(() => applyIconSize('large'))}>{uiIcon('grid', 14)}<span>大图标</span>{sizeKey === 'large' ? <kbd>当前</kbd> : null}</button>
      <button role="menuitem" onClick={run(() => applyIconSize('medium'))}>{uiIcon('grid', 14)}<span>中图标</span>{sizeKey === 'medium' ? <kbd>当前</kbd> : null}</button>
      <button role="menuitem" onClick={run(() => applyIconSize('small'))}>{uiIcon('grid', 14)}<span>小图标</span>{sizeKey === 'small' ? <kbd>当前</kbd> : null}</button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={run(() => window.dispatchEvent(new CustomEvent(SAVE_CANVAS_TEMPLATE_EVENT)))}>{uiIcon('save', 14)}<span>保存现在的画布为模板</span></button>
    </CanvasMenu>, previewOverlayRoot()) : null}
  </div>
})
// ── 裸图标卡（2026-09-13 用户第二次修正：「一个真正的图标 拖到画布中 就可以双击进入程序 而不是应用卡形式的」）──
// 没有窗口外框、没有标题栏：就是桌面那样一个大图标 + 名字；双击启动，右键出菜单。
const LauncherIconBody = memo(function LauncherIconBody({ item }: { item: CanvasItem }) {
  const path = item.source ?? ''
  const [resolved, setResolved] = useState<{ name: string; image: string } | null>(() => appResolveCache.get(path) ?? null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // 打开菜单那一刻现读：两个开关的当前值 + 现在选了几个图标
  const [flags, setFlags] = useState({ auto: false, snap: true, selected: 1 })
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !path || resolved) return
    const requestId = `launcher-icon:${item.id}:${Date.now()}`
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; name?: string; image?: string } | undefined
      if (data?.type !== 'native-app-resolve' || data.requestId !== requestId || !data.image) return
      const next = { name: data.name || item.title, image: data.image }
      appResolveCache.set(path, next)
      setResolved(next)
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-app-resolve-request', requestId, path })
    return () => bridge.removeEventListener('message', receive)
  }, [path, item.id, item.title, resolved])
  const runIconAction = useCallback((action: string) => {
    window.dispatchEvent(new CustomEvent(ICON_ACTION_EVENT, { detail: { action, itemId: item.id } }))
  }, [item.id])
  const launch = useCallback(() => { if (path) window.chrome?.webview?.postMessage({ type: 'native-launch-app', path }) }, [path])
  const reveal = useCallback(() => {
    if (path) window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: 'C:\\Windows\\explorer.exe', args: `/select,"${path}"` })
  }, [path])
  const pinToBar = useCallback(() => {
    if (!path) return
    window.dispatchEvent(new CustomEvent(GLOBAL_FAVORITE_EVENT, { detail: { source: path, sourceKind: 'app', label: item.title || resolved?.name || '快捷方式', image: resolved?.image } }))
  }, [path, item.title, resolved])
  // 右键菜单点别处 / 按 Esc / 滚轮 → 自动关掉（用户 2026-09-13 报「右键后菜单一直挂着」）
  useEffect(() => {
    if (!menu) return
    const close = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (event.type === 'pointerdown' && target?.closest('.canvas-menu')) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])
  return <div className="launcher-icon"
    title={`${item.title || resolved?.name || '快捷方式'}\n${path}\n双击打开 · 拖到底部「全局常用」可固定（那里能改名和设快捷键）`}
    onDoubleClick={(event) => { event.stopPropagation(); event.preventDefault(); launch() }}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setFlags({ auto: readIconToggle(ICON_AUTO_KEY, false), snap: readIconToggle(ICON_SNAP_KEY, true), selected: document.querySelectorAll('.canvas-item.kind-icon.selected').length || 1 }); setMenu({ x: event.clientX, y: event.clientY }) }}>
    {resolved?.image ? <img src={resolved.image} alt="" draggable={false}/> : <span className="launcher-icon-fallback">{uiIcon('executable', 44)}</span>}
    <span className="launcher-icon-label">{item.title || resolved?.name || '快捷方式'}</span>
    {menu ? createPortal(<CanvasMenu x={menu.x} y={menu.y} onPointerDown={(event) => event.stopPropagation()}>
      <button role="menuitem" onClick={() => { setMenu(null); launch() }}>{uiIcon('eye', 14)}<span>打开</span></button>
      <button role="menuitem" onClick={() => { setMenu(null); reveal() }}>{uiIcon('folder', 14)}<span>打开所在文件夹</span></button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={() => { setMenu(null); pinToBar() }}>{uiIcon('star', 14)}<span>固定到「全局常用」（可改名 / 设快捷键）</span></button>
      <button role="menuitem" onClick={() => { setMenu(null); window.dispatchEvent(new CustomEvent(CURRENT_CANVAS_PIN_EVENT, { detail: { target: item.id, label: item.title || resolved?.name || '快捷方式' } })) }}>{uiIcon('pin', 14)}<span>固定到当前画布（这个画布里 Ctrl+1..9 优先）</span></button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={() => { setMenu(null); runIconAction('tidy') }}>{uiIcon('grid', 14)}<span>自动排列图标（排成网格）</span></button>
      <button role="menuitem" onClick={() => { setMenu(null); runIconAction('toggle-auto') }}>{uiIcon('grid', 14)}<span>自动排列图标</span><kbd>{flags.auto ? '开' : '关'}</kbd></button>
      <button role="menuitem" onClick={() => { setMenu(null); runIconAction('toggle-snap') }}>{uiIcon('grid', 14)}<span>将图标与网格对齐</span><kbd>{flags.snap ? '开' : '关'}</kbd></button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={() => { setMenu(null); runIconAction('group') }}>{uiIcon('grid', 14)}<span>组合（选中的一起移动）</span><kbd>{flags.selected >= 2 ? flags.selected + ' 个' : '先多选'}</kbd></button>
      <button role="menuitem" onClick={() => { setMenu(null); runIconAction('ungroup') }}>{uiIcon('grid', 14)}<span>解组</span></button>
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={() => { setMenu(null); runIconAction('remove') }}>{uiIcon('trash', 14)}<span>从画布移除</span><kbd>Delete</kbd></button>
    </CanvasMenu>, previewOverlayRoot()) : null}
  </div>
})
const AppCardBody = memo(function AppCardBody({ item }: { item: CanvasItem }) {
  const path = item.source ?? ''
  const [resolved, setResolved] = useState<{ name: string; image: string } | null>(() => appResolveCache.get(item.source ?? '') ?? null)
  const [launching, setLaunching] = useState(false)
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !path || resolved) return
    const requestId = `app-resolve:${item.id}:${Date.now()}`
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; name?: string; image?: string } | undefined
      if (data?.type !== 'native-app-resolve' || data.requestId !== requestId || !data.image) return
      const next = { name: data.name || item.title, image: data.image }
      appResolveCache.set(path, next)
      setResolved(next)
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-app-resolve-request', requestId, path })
    return () => bridge.removeEventListener('message', receive)
  }, [path, item.id, item.title, resolved])
  const launch = useCallback(() => {
    if (!path) return
    setLaunching(true)
    window.chrome?.webview?.postMessage({ type: 'native-launch-app', path })
    window.setTimeout(() => setLaunching(false), 1200)
  }, [path])
  if (!path) return <div className="app-card-empty">这张应用卡没有绑定程序路径</div>
  return <div className="app-card" onDoubleClick={launch} title={`双击启动：${path}`}>
    <div className="app-card-icon">{resolved?.image ? <img src={resolved.image} alt="" draggable={false}/> : <span className="app-card-icon-fallback">{uiIcon('settings', 44)}</span>}</div>
    <div className="app-card-name">{resolved?.name || item.title}</div>
    <div className="app-card-path">{path}</div>
    <div className="app-card-actions">
      <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); launch() }}>{uiIcon('forward', 12)}<span>{launching ? '启动中…' : '启动'}</span></button>
      <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); window.chrome?.webview?.postMessage({ type: 'native-reveal-path', path }) }}>{uiIcon('folder', 12)}<span>位置</span></button>
    </div>
  </div>
})

const FileRefBody = memo(function FileRefBody({ item, paintOrder = 0 }: { item: CanvasItem; paintOrder?: number }) {
  const path = item.source ?? ''
  const hostRef = useRef<HTMLDivElement>(null)
  const [requestId] = useState(() => `file-preview:${item.id}:${crypto.randomUUID()}`)
  const [preview, setPreview] = useState<FilePreviewState>({
    status: 'loading', thumbKind: 'icon', previewKind: 'thumbnail', width: 0, height: 0,
  })
  const [playing, setPlaying] = useState(false)
  const [mediaSettings, setMediaSettings] = useState(() => {
    const settings = readBrowserSettings()
    return { muted: settings.mediaMuted, playbackRate: settings.mediaPlaybackRate }
  })
  const requestedPixelsRef = useRef(0)
  const previewRetryCountRef = useRef(0)
  const previewRetryTimerRef = useRef<number | null>(null)
  const aspectSentRef = useRef(false)

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const receive = (event: MessageEvent<NativeHostMessage>) => {
      const data = event.data
      if (data?.type !== 'native-file-preview' || data.requestId !== requestId || data.itemId !== item.id) return
      const next: FilePreviewState = {
        status: data.opened === false ? 'missing' : 'ready',
        image: data.image || undefined,
        thumbKind: data.thumbKind === 'thumbnail' ? 'thumbnail' : 'icon',
        previewKind: data.previewKind === 'video' ? 'video' : data.previewKind === 'pdf' ? 'pdf' : 'thumbnail',
        resource: data.resource || undefined,
        width: data.width ?? 0,
        height: data.height ?? 0,
      }
      setPreview(next)
      if (next.status === 'ready' && next.thumbKind === 'icon' && /\.(png|jpe?g|gif|bmp|webp|svg|tiff?)$/i.test(path) && previewRetryCountRef.current < 3) {
        previewRetryCountRef.current += 1
        if (previewRetryTimerRef.current !== null) window.clearTimeout(previewRetryTimerRef.current)
        previewRetryTimerRef.current = window.setTimeout(() => {
          previewRetryTimerRef.current = null
          bridge.postMessage({ type: 'native-file-preview-request', requestId, itemId: item.id, path, pixels: requestedPixelsRef.current || 380 })
        }, 450)
      } else if (next.thumbKind === 'thumbnail') {
        previewRetryCountRef.current = 0
      }
      // Shell renders page one for PDF thumbnails and reports that bitmap's
      // aspect ratio. Only fall back to A4 when Windows cannot provide it.
      const aspectWidth = next.width || (next.previewKind === 'pdf' ? 210 : 0)
      const aspectHeight = next.height || (next.previewKind === 'pdf' ? 297 : 0)
      if (!aspectSentRef.current && next.status === 'ready' &&
          (next.previewKind === 'pdf' || next.thumbKind === 'thumbnail') && aspectWidth > 0 && aspectHeight > 0) {
        aspectSentRef.current = true
        window.dispatchEvent(new CustomEvent(FILE_PREVIEW_ASPECT_EVENT, {
          detail: { itemId: item.id, width: aspectWidth, height: aspectHeight },
        }))
      }
    }
    bridge.addEventListener('message', receive)
    return () => bridge.removeEventListener('message', receive)
  }, [item.id, path, requestId])

  useLayoutEffect(() => {
    const bridge = window.chrome?.webview
    const host = hostRef.current
    if (!bridge || !host || !path) return
    let timer = 0
    const request = () => {
      const rect = host.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      const pixels = Math.min(2048, Math.max(128, Math.ceil(Math.max(rect.width, rect.height) * scale / 64) * 64))
      if (pixels === requestedPixelsRef.current) return
      requestedPixelsRef.current = pixels
      bridge.postMessage({ type: 'native-file-preview-request', requestId, itemId: item.id, path, pixels })
    }
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(request, 120)
    })
    observer.observe(host)
    request()
    return () => {
      window.clearTimeout(timer)
      if (previewRetryTimerRef.current !== null) window.clearTimeout(previewRetryTimerRef.current)
      previewRetryTimerRef.current = null
      previewRetryCountRef.current = 0
      observer.disconnect()
      bridge.postMessage({ type: 'native-file-preview-cancel', requestId, itemId: item.id })
    }
  }, [item.id, path, requestId])

  useEffect(() => {
    const onMediaHover = (event: Event) => {
      const active = (event as CustomEvent<{ ownerId: string; path: string } | null>).detail
      setPlaying(active?.ownerId === item.id && active.path === path)
    }
    const onSettings = (event: Event) => {
      const settings = (event as CustomEvent<AppSettings>).detail
      setMediaSettings({ muted: settings.mediaMuted, playbackRate: settings.mediaPlaybackRate })
    }
    window.addEventListener(MEDIA_HOVER_EVENT, onMediaHover)
    window.addEventListener(APP_SETTINGS_EVENT, onSettings)
    return () => {
      clearMediaHover(item.id, path)
      window.removeEventListener(MEDIA_HOVER_EVENT, onMediaHover)
      window.removeEventListener(APP_SETTINGS_EVENT, onSettings)
    }
  }, [item.id, path])

  const playable = preview.previewKind === 'video' && Boolean(preview.resource)
  return <div ref={hostRef} className={`fileref-content is-${preview.status} thumb-${preview.thumbKind}`} title={path}
    onPointerEnter={() => { if (playable) publishMediaHover(item.id, path) }}
    onPointerLeave={() => { if (playable) clearMediaHover(item.id, path) }}>
    <div className="fileref-preview">
      {preview.previewKind === 'pdf' && preview.resource
        ? <PdfCardSurface item={item} resource={preview.resource} poster={preview.image} paintOrder={paintOrder}/>
        : playing && preview.resource
        ? <HoverMediaVideo resource={preview.resource} poster={preview.image} muted={mediaSettings.muted} playbackRate={mediaSettings.playbackRate}/>
        : preview.image
          ? <img className="fileref-preview-image" src={preview.image} alt="" draggable={false}/>
          : preview.status === 'missing'
            ? <span className="fileref-missing">{uiIcon('file', 38)}<b>原文件已被删除或移动</b></span>
            : <span className="fileref-loading">{uiIcon('file', 38)}<small>正在读取预览…</small></span>}
    </div>
    <div className="fileref-name"><b>{item.title}</b>{playable ? <small>悬停播放 · 双击用默认程序打开</small> : <small>双击用默认程序打开</small>}</div>
  </div>
})

const ReferenceBody = memo(function ReferenceBody() {
  return <div className="reference-content reference-empty"><span>{uiIcon('image', 28)}</span><b>空白参考图板</b><small>把图片拖进这里开始整理</small></div>
})

// 交接文档 §33：文件管理器的像素全部由掌中界绘制，但文件语义仍由 Shell 决定。
// 宿主返回真实枚举、属性和图标；选择同步回隐藏的 IExplorerBrowser，因此剪切、复制、
// 删除、重命名和右键菜单仍然是 Windows 原生行为。
const FILE_COMMANDS = [
  { name: '撤销上一步文件操作', icon: 'undo', verb: 'file-undo' as const, needsSelection: false },
  { name: '剪切', icon: 'cut', verb: 'cut' as const, needsSelection: true },
  { name: '复制', icon: 'copy', verb: 'copy' as const, needsSelection: true },
  { name: '粘贴', icon: 'paste', verb: 'paste' as const },
  { name: '重命名', icon: 'rename', verb: 'rename' as const, needsSelection: true },
  { name: '删除', icon: 'trash', verb: 'delete' as const, needsSelection: true },
  { name: '排序（切换升降序）', icon: 'sort', verb: 'sort' as const },
  { name: '查看（切换视图）', icon: 'view', verb: 'view' as const },
]

const FILE_NEW_COMMANDS = [
  { name: '新建文件夹', icon: 'folder', verb: 'new' as const },
  { name: 'txt 文档', icon: 'file', verb: 'new-txt' as const },
  { name: 'md 文档', icon: 'file', verb: 'new-md' as const },
  { name: 'html 网页', icon: 'eye', verb: 'new-html' as const },
]

const FILE_ROW_COMMANDS = [
  { name: '新建文件夹', icon: 'plus', verb: 'new' as const },
  { name: '剪切', icon: 'cut', verb: 'cut' as const },
  { name: '复制', icon: 'copy', verb: 'copy' as const },
  { name: '重命名', icon: 'rename', verb: 'rename' as const },
  { name: '删除', icon: 'trash', verb: 'delete' as const },
]

const FileNewMenu = memo(function FileNewMenu({ onCreate }: {
  onCreate: (verb: typeof FILE_NEW_COMMANDS[number]['verb']) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return <span ref={rootRef} className="fm-new-slot">
    <button className={open ? 'active' : ''} title="新建" aria-label="新建" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{uiIcon('plus', 15)}</button>
    {open ? <div className="fm-new-menu" role="menu" aria-label="新建">
      {FILE_NEW_COMMANDS.map((entry) => <button key={entry.verb} role="menuitem" onClick={() => { onCreate(entry.verb); setOpen(false) }}>
        {uiIcon(entry.icon, 15)}<span>{entry.name}</span>
      </button>)}
    </div> : null}
  </span>
})

type FileContextMenuState = {
  x: number
  y: number
  paths: string[]
  entry?: ShellEntry
}

const formatShellSize = (size: number) => {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const formatMediaDuration = (durationMs?: number) => {
  if (!durationMs) return ''
  const seconds = Math.round(durationMs / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`
}

const FILE_COLUMN_LABELS: Record<FileColumnKey, string> = {
  name: '名称', type: '类型', dimensions: '尺寸', duration: '时长', modified: '修改日期', size: '大小',
}

// Intl's pinyin collation keeps this tiny boundary table accurate without
// shipping a transliteration library. We only need the first letter used by
// the visual group rail; filenames and Shell identity remain untouched.
const PINYIN_GROUP_BOUNDARIES = [
  ['A', '阿'], ['B', '八'], ['C', '嚓'], ['D', '搭'], ['E', '蛾'], ['F', '发'],
  ['G', '噶'], ['H', '哈'], ['J', '击'], ['K', '喀'], ['L', '垃'], ['M', '妈'],
  ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '期'], ['R', '然'], ['S', '撒'],
  ['T', '塌'], ['W', '挖'], ['X', '昔'], ['Y', '压'], ['Z', '匝'],
] as const
const pinyinGroupCollator = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base' })

// Explorer puts the "#" bucket (digits and symbols) first and orders letters
// A→Z. The old table reused the pinyin initials, which silently dropped the
// I/U/V groups to the tail after Z.
const GROUP_LETTER_ORDER = ['#', ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']]

// Virtual list geometry. These constants mirror styles.css:
//   details   .fm-file-entry min-height 44 / .fm-group-heading 24 / padding 3+12
//   search    .is-search-results .fm-file-entry min-height 48
//   compact   .is-compact .fm-file-scroll grid-auto-rows 27px / padding 5+12
//   icons     .is-large-icons grid-auto-rows 132px / gap 7 / padding 10
// Keep them in sync when the stylesheet changes.
type FileListItem = { kind: 'heading'; key: string; count: number } | { kind: 'entry'; entry: ShellEntry; index: number }
const FILE_ROW_METRICS = {
  details: { headingHeight: 24, entryHeight: 44, rowGap: 0, columnMin: 0, columnGap: 0, padTop: 3, padBottom: 12, padX: 5 },
  search: { headingHeight: 24, entryHeight: 48, rowGap: 0, columnMin: 0, columnGap: 0, padTop: 3, padBottom: 12, padX: 5 },
  compact: { headingHeight: 27, entryHeight: 27, rowGap: 0, columnMin: 180, columnGap: 8, padTop: 5, padBottom: 12, padX: 7 },
  'large-icons': { headingHeight: 132, entryHeight: 132, rowGap: 7, columnMin: 132, columnGap: 7, padTop: 10, padBottom: 10, padX: 10 },
} as const
const FILE_VIRTUAL_THRESHOLD = 150

function fileNameGroup(name: string) {
  const first = [...name.trim()][0] ?? ''
  const latin = first.normalize('NFD').match(/[A-Za-z]/)?.[0]
  if (latin) return latin.toUpperCase()
  if (!/[\u3400-\u9fff]/u.test(first)) return '#'
  let group = 'A'
  for (const [letter, boundary] of PINYIN_GROUP_BOUNDARIES) {
    if (pinyinGroupCollator.compare(first, boundary) < 0) break
    group = letter
  }
  return group
}

function fileCrumbs(labels: string[], activePath: string) {
  if (!activePath || activePath.startsWith('shell:')) {
    return labels.map((label, index) => ({ label, path: index === 0 || index === labels.length - 1 ? activePath || 'shell:MyComputerFolder' : undefined }))
  }
  const normalized = activePath.replace(/\//g, '\\').replace(/\\+$/, '')
  const targets: string[] = ['shell:MyComputerFolder']
  const drive = normalized.match(/^([A-Za-z]:)(?:\\|$)/)
  if (drive) {
    let cursor = `${drive[1]}\\`
    targets.push(cursor)
    for (const part of normalized.slice(drive[0].length).split('\\').filter(Boolean)) {
      cursor = `${cursor.replace(/\\+$/, '')}\\${part}`
      targets.push(cursor)
    }
  } else if (normalized.startsWith('\\\\')) {
    let cursor = '\\\\'
    for (const part of normalized.slice(2).split('\\').filter(Boolean)) {
      cursor += `${cursor.length > 2 ? '\\' : ''}${part}`
      targets.push(cursor)
    }
  } else targets.push(normalized)
  const offset = Math.max(0, targets.length - labels.length)
  return labels.map((label, index) => ({ label, path: targets[index + offset] ?? (index === labels.length - 1 ? normalized : undefined) }))
}

const FilePathBar = memo(function FilePathBar({ crumbs, activePath, drives, navigationEnabled, addressEditing, onAddressEditingChange, onCommand, onNavigate, searchDefaultValue = '', onSearch, mirrorArchive = '' }: {
  crumbs: string[]
  activePath: string
  drives: ShellTreeNode[]
  navigationEnabled: boolean
  addressEditing: boolean
  onAddressEditingChange: (editing: boolean) => void
  onCommand: (command: 'back' | 'forward' | 'up' | 'reload') => void
  onNavigate: (path: string) => void
  searchDefaultValue?: string
  onSearch: (query: string) => void
  mirrorArchive?: string
}) {
  const [recentFolders, setRecentFolders] = useState(sharedRecentFolders)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const pathCrumbs = useMemo(() => fileCrumbs(crumbs, activePath), [activePath, crumbs])

  useEffect(() => {
    if (!addressEditing) return
    const input = addressInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [addressEditing])
  const visibleDrives = drives.filter((drive) => drive.folder !== false && /^[a-z]:[\\/]/i.test(drive.path))

  useEffect(() => {
    const onRecent = (event: Event) => setRecentFolders((event as CustomEvent<RecentFolder[]>).detail)
    window.addEventListener(RECENT_FOLDERS_EVENT, onRecent)
    return () => window.removeEventListener(RECENT_FOLDERS_EVENT, onRecent)
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // 地址行（后退/前进/向上/刷新/面包屑/最近位置/收藏）已按用户要求删除（2026-09-13）：这条只剩搜索框。
  // 当前路径仍挂在整行的 title 上，鼠标停在搜索框那一行就能看到自己在哪。
  // 手动输路径（2026-09-14）：地址行删掉后想直接跳某个路径没入口 —— 这一行就地变输入框（无弹框），
  // 入口 = 卡片右键「手动输路径…」或 Ctrl+L；回车跳转、Esc / 点空白取消。
  return <div ref={rootRef} className="fm-path" title={pathCrumbs.map((crumb) => crumb.label).join(' > ')}>
    {addressEditing ? <label className="fm-search fm-address-edit" title={`当前：${activePath}`}>{uiIcon('rename', 13)}<input ref={addressInputRef} defaultValue={activePath} spellCheck={false} placeholder="输入路径，回车跳转" onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const target = event.currentTarget.value.trim().replace(/^"|"$/g, ''); onAddressEditingChange(false); if (target && target !== activePath) onNavigate(target) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onAddressEditingChange(false) }
    }} onBlur={() => onAddressEditingChange(false)}/></label>
    : <label className="fm-search">{uiIcon('search', 13)}<input defaultValue={searchDefaultValue} placeholder="在当前文件夹及子目录搜索" onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); const query = event.currentTarget.value.trim(); if (query) onSearch(query) }
      if (event.key === 'Escape') event.currentTarget.value = ''
    }}/></label>}
  </div>
})

// 模板缩略图的小地图：宿主从 .zzj 里读出每张卡片的位置/尺寸/类型，这里按包围盒等比画成小色块。
// 比一个通用图标有用得多 —— 一眼看出那套画布长什么样（用户 2026-09-14 要的「真实缩略图」）。
const TemplateMiniMap = memo(function TemplateMiniMap({ layout }: { layout: { k: string; x: number; y: number; w: number; h: number }[] }) {
  const box = layout.reduce((acc, card) => ({
    minX: Math.min(acc.minX, card.x),
    minY: Math.min(acc.minY, card.y),
    maxX: Math.max(acc.maxX, card.x + Math.max(1, card.w)),
    maxY: Math.max(acc.maxY, card.y + Math.max(1, card.h)),
  }), { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY })
  const widths = { w: Math.max(1, box.maxX - box.minX), h: Math.max(1, box.maxY - box.minY) }
  const pad = 5
  const scale = Math.min((160 - pad * 2) / widths.w, (64 - pad * 2) / widths.h)
  const offsetX = (160 - widths.w * scale) / 2
  const offsetY = (64 - widths.h * scale) / 2
  return <span className="template-thumb is-map" aria-hidden="true">
    <svg viewBox="0 0 160 64" preserveAspectRatio="xMidYMid meet">
      {layout.map((card, index) => <rect key={`${card.k}-${index}`} className={`tmap tmap-${card.k}`}
        x={offsetX + (card.x - box.minX) * scale}
        y={offsetY + (card.y - box.minY) * scale}
        width={Math.max(1.6, card.w * scale)}
        height={Math.max(1.6, card.h * scale)} rx={1.3}/>)}
    </svg>
  </span>
})

const FileTreeVisibilityButton = memo(function FileTreeVisibilityButton({ open, onToggle, className }: {
  open: boolean
  onToggle: () => void
  className: 'fm-tree-toggle'
}) {
  const label = open ? '收起目录栏' : '展开目录栏'
  return <button className={className} title={label} aria-label={label} aria-expanded={open} onClick={onToggle}>{uiIcon('sidebar', 13)}</button>
})

const FileTreeCollapseButton = memo(function FileTreeCollapseButton({ expandedCount, onCollapse }: {
  expandedCount: number
  onCollapse: () => void
}) {
  const label = expandedCount > 0 ? '折叠所有展开的目录' : '没有展开的目录'
  return <button
    type="button"
    className="fm-tree-collapse"
    disabled={expandedCount === 0}
    title={label}
    aria-label={label}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); onCollapse() }}
  >{uiIcon('up', 13)}</button>
})

type ShellTreeSortKey = 'name' | 'size'

function ShellTreeBranch({ nodes, depth, expanded, children, activePath, selectedPath, sortKey, sortDescending, onToggle, onOpen, onSelectFile }: {
  nodes: ShellTreeNode[]
  depth: number
  expanded: Set<string>
  children: Map<string, ShellTreeNode[]>
  activePath: string
  selectedPath?: string
  sortKey: ShellTreeSortKey
  sortDescending: boolean
  onToggle: (node: ShellTreeNode) => void
  onOpen: (node: ShellTreeNode) => void
  onSelectFile: (node: ShellTreeNode) => void
}) {
  const sortedNodes = useMemo(() => [...nodes].sort((left, right) => {
    let result = 0
    if (sortKey === 'size') result = (left.totalBytes ?? left.size ?? 0) - (right.totalBytes ?? right.size ?? 0)
    else result = left.name.localeCompare(right.name, 'zh-CN', { numeric: true })
    return sortDescending ? -result : result
  }), [nodes, sortDescending, sortKey])
  return <>{sortedNodes.map((node) => {
    const total = node.totalBytes ?? 0
    const used = total > 0 ? Math.max(0, total - (node.freeBytes ?? 0)) : 0
    const fill = total > 0 ? Math.min(100, used / total * 100) : 0
    const style = {
      paddingLeft: 8 + depth * 14,
      '--fm-drive-fill': `${fill}%`,
      '--fm-drive-color': fill >= 90 ? 'var(--danger-soft)' : 'var(--blue-soft)',
    } as CSSProperties
    return <div key={node.path || `${depth}-${node.name}`} className={`fm-tree-branch ${total > 0 ? 'is-drive' : ''}`}>
    <button className={activePath === node.path || selectedPath === node.path ? 'active' : ''} style={style} onDoubleClick={() => node.folder === false ? onSelectFile(node) : onOpen(node)} onClick={() => node.folder === false ? onSelectFile(node) : onOpen(node)}>
      <span className={`fm-tree-chevron ${node.folder === false || !node.expandable ? 'is-empty' : ''}`} onClick={(event) => { event.stopPropagation(); if (node.folder !== false) onToggle(node) }}>{node.folder !== false && node.expandable ? (expanded.has(node.path) ? '⌄' : '›') : ''}</span>
      {node.image ? <img src={node.image} alt="" draggable={false}/> : uiIcon(node.name.toLocaleLowerCase().endsWith('.zip') ? 'archive' : node.folder === false ? 'file' : depth === 0 ? 'pc' : 'folder', 14)}
      <span className="fm-tree-name">{node.name}</span>
      <span className="fm-tree-size">{total > 0 ? `${formatShellSize(used)} / ${formatShellSize(total)}` : ''}</span>
    </button>
    {node.folder !== false && expanded.has(node.path) && children.has(node.path) ? <ShellTreeBranch nodes={children.get(node.path) ?? []} depth={depth + 1} expanded={expanded} children={children} activePath={activePath} selectedPath={selectedPath} sortKey={sortKey} sortDescending={sortDescending} onToggle={onToggle} onOpen={onOpen} onSelectFile={onSelectFile}/> : null}
  </div>
  })}</>
}

const shouldRequestShellImage = (entry: { path?: string; folder?: boolean }) => Boolean(entry.path)

// One IntersectionObserver per scroll container keeps a 5000-tile folder from
// creating 5000 observers. Buckets are keyed by the scroll root element and the
// observer disconnects itself once the last tile unmounts.
const sharedThumbObserverBuckets = new Map<Element, { observer: IntersectionObserver; callbacks: Map<Element, (visible: boolean) => void> }>()
function observeThumbVisibility(root: Element | null, target: Element, callback: (visible: boolean) => void) {
  const key: Element = root ?? document.documentElement
  let bucket = sharedThumbObserverBuckets.get(key)
  if (!bucket) {
    bucket = {
      observer: new IntersectionObserver((records) => {
        for (const record of records) bucket?.callbacks.get(record.target)?.(record.isIntersecting)
      }, root ? { root, rootMargin: '240px 0px' } : { rootMargin: '240px 0px' }),
      callbacks: new Map(),
    }
    sharedThumbObserverBuckets.set(key, bucket)
  }
  bucket.callbacks.set(target, callback)
  bucket.observer.observe(target)
  return () => {
    const current = sharedThumbObserverBuckets.get(key)
    if (!current) return
    current.callbacks.delete(target)
    current.observer.unobserve(target)
    if (!current.callbacks.size) {
      current.observer.disconnect()
      sharedThumbObserverBuckets.delete(key)
    }
  }
}

const pushAppToast = (text: string) => {
  if (text) window.dispatchEvent(new CustomEvent('zhangzhongjie-toast', { detail: { text } }))
}

// Explorer's F2 selects the base name without the extension; mirror that so a
// rename cannot clobber ".docx" by accident.
function selectRenameBasename(input: HTMLInputElement) {
  const dot = input.value.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
}

const LazyShellThumbnail = memo(function LazyShellThumbnail({ entry, onNearViewport, useSystemIcon = true }: {
  entry: ShellEntry
  onNearViewport?: (path: string, visible: boolean) => void
  useSystemIcon?: boolean
}) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'failed'>('idle')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const root = host.closest('.fm-file-scroll') as HTMLElement | null
    const applyVisibility = (nextVisible: boolean) => {
      setNearViewport(nextVisible)
      const image = host.querySelector<HTMLImageElement>('img')
      setStatus(nextVisible && useSystemIcon ? image?.complete && image.naturalWidth > 0 ? 'loaded' : 'loading' : 'idle')
      if (useSystemIcon && shouldRequestShellImage(entry)) onNearViewport?.(entry.path, nextVisible)
    }
    const unobserve = observeThumbVisibility(root, host, applyVisibility)
    // 共享观察器对本应用首屏之外的瓦片不可靠（已实测只认前两排），用滚动/间隔驱动的手动几何检测兜底。
    let rafId = 0
    const check = () => {
      rafId = 0
      const node = hostRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const viewport = (root ?? document.documentElement).getBoundingClientRect()
      applyVisibility(rect.bottom > viewport.top - 300 && rect.top < viewport.bottom + 600)
    }
    const schedule = () => { if (!rafId) rafId = window.requestAnimationFrame(check) }
    root?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const initialTimer = window.setTimeout(check, 150)
    const keepalive = window.setInterval(() => {
      if (hostRef.current && !hostRef.current.querySelector('img')) check()
    }, 1200)
    return () => {
      unobserve()
      root?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (rafId) window.cancelAnimationFrame(rafId)
      window.clearTimeout(initialTimer)
      window.clearInterval(keepalive)
      if (useSystemIcon && shouldRequestShellImage(entry)) onNearViewport?.(entry.path, false)
    }
  }, [entry.image, entry.path, entry.thumbKind, onNearViewport, useSystemIcon])

  const extension = entry.name.toLocaleLowerCase().match(/(\.[^.]+)$/)?.[1] ?? ''
  const vectorIcon = entry.folder ? 'folder'
    : /\.(mp4|webm|mov|m4v|mkv|avi|rmvb|wmv|flv)$/.test(extension) ? 'video'
    : /\.(mp3|wav|m4a|ogg|flac|aac|wma)$/.test(extension) ? 'audio'
    : /\.(zip|rar|7z|tar|gz|bz2|xz)$/.test(extension) ? 'archive'
    : /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/.test(extension) ? 'image'
    : /\.(pdf|docx?|xlsx?|pptx?|txt|md|rtf|csv)$/.test(extension) ? 'document'
    : /\.(exe|msi|bat|cmd|com|ps1)$/.test(extension) ? 'executable' : 'file'
  const fallback = <span className="fm-vector-thumb">{uiIcon(vectorIcon, 54)}</span>
  const shellImage = useSystemIcon ? (entry.image || cachedShellImage(entry.path)?.image || '') : ''
  const hasShellImage = useSystemIcon && Boolean(shellImage)
  const showVector = !useSystemIcon || status === 'failed'
  const showImage = useSystemIcon && status !== 'failed' && nearViewport
  // 矢量图标始终垫底：加载期间瓦片不再是全空白，系统缩略图到达后无缝盖上。
  return <span ref={hostRef} className={`fm-lazy-thumb is-${status} ${showVector ? 'is-vector' : 'is-system'}`}>
    {fallback}
    {showImage ? <>
      {hasShellImage ? <img src={shellImage} alt="" draggable={false} onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')}/> : null}
      {status !== 'loaded' ? <i className="fm-thumb-placeholder" aria-hidden="true"/> : null}
    </> : null}
  </span>
})

const PLAYABLE_MEDIA_EXTENSION = /\.(mp4|webm|mov|m4v)$/i

const HoverMediaVideo = memo(function HoverMediaVideo({ resource, poster, muted, playbackRate }: {
  resource: string
  poster?: string
  muted: boolean
  playbackRate: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    void video.play().catch(() => { /* Chromium may defer unmuted autoplay until the next hover. */ })
    return () => {
      video.pause()
      video.currentTime = 0
      video.removeAttribute('src')
      video.load()
    }
  }, [resource])

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate
  }, [playbackRate])

  return <video ref={videoRef} className="fm-hover-video" src={resource} poster={poster} muted={muted} playsInline preload="metadata"/>
})

function HighlightedFileName({ name, query }: { name: string; query: string }) {
  const at = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (at < 0 || !query) return <>{name}</>
  return <>{name.slice(0, at)}<mark>{name.slice(at, at + query.length)}</mark>{name.slice(at + query.length)}</>
}

const FileManagerPane = memo(function FileManagerPane({ item }: { item: CanvasItem }) {
  const isSearchResults = Boolean(item.searchQuery)
  const restoredSnapshot = fileManagerSnapshots.get(item.id)
  const [leaseId] = useState(() => `${item.id}:${crypto.randomUUID()}`)
  const [treeOpen, setTreeOpen] = useState(() => item.fileTreeOpen ?? !readBrowserSettings().fileTreeCollapsed)
  const [treeSortKey, setTreeSortKey] = useState<ShellTreeSortKey>('name')
  const [treeSortDescending, setTreeSortDescending] = useState(false)
  const [thumbnailPixels, setThumbnailPixels] = useState(() => Math.min(768, Math.max(64, Math.round(180 * window.devicePixelRatio))))
  const [trail, setTrail] = useState<string[]>(() => restoredSnapshot?.trail ?? [])
  const [entries, setEntries] = useState<ShellEntry[]>(() => restoredSnapshot?.entries ?? [])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [rowActionsX, setRowActionsX] = useState<number | null>(null)
  const [fileMarquee, setFileMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [loading, setLoading] = useState(Boolean(window.chrome?.webview))
  const [viewMode, setViewMode] = useState<FileViewMode>(() => readBrowserSettings().fileViewMode)
  const [treeIconSize, setTreeIconSize] = useState<'small' | 'large'>(() => readBrowserSettings().fileTreeIconSize === 'large' ? 'large' : 'small')
  const [fileIconMode, setFileIconMode] = useState<FileIconMode>(() => readBrowserSettings().fileIconMode)
  const [fileSortKey, setFileSortKey] = useState<FileSortKey>('name')
  const [fileSortDescending, setFileSortDescending] = useState(false)
  const [showViewMenu, setShowViewMenu] = useState(false)
  const [fileColumns, setFileColumns] = useState<FileColumnKey[]>(() => readBrowserSettings().fileColumns)
  const [columnWidths, setColumnWidths] = useState<Partial<Record<FileColumnKey, number>>>(() => readBrowserSettings().fileColumnWidths[item.id] ?? {})
  const [treeWidth, setTreeWidth] = useState<number | undefined>(() => readBrowserSettings().fileTreeWidths[item.id])
  const [treeColumnWidth, setTreeColumnWidth] = useState<number | undefined>(() => readBrowserSettings().fileTreeColumnWidths[item.id])
  const [mediaMuted, setMediaMuted] = useState(() => readBrowserSettings().mediaMuted)
  const [mediaPlaybackRate, setMediaPlaybackRate] = useState(() => readBrowserSettings().mediaPlaybackRate)
  const [fileShortcutBindings, setFileShortcutBindings] = useState(() => readBrowserSettings().shortcutBindings)
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null)
  const [playingVideoPath, setPlayingVideoPath] = useState<string | null>(null)
  const [mediaBaseUrl, setMediaBaseUrl] = useState('')
  const [showColumnPicker, setShowColumnPicker] = useState(false)
  const [entriesRevision, setEntriesRevision] = useState(0)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [fallback, setFallback] = useState(false)
  const [archiveLocation, setArchiveLocation] = useState(() => Boolean(restoredSnapshot?.archiveRoot))
  const [mirrorArchive, setMirrorArchive] = useState('')
  const [copyWatch, setCopyWatch] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [searchQuery, setSearchQuery] = useState(item.searchQuery ?? '')
  const [searchBackend, setSearchBackend] = useState<'everything' | 'fallback'>('fallback')
  const [searchStatus, setSearchStatus] = useState<NativeHostMessage['status']>()
  const toolbarSplitOrientation = item.workspaceSplit?.type === 'branch' ? item.workspaceSplit.orientation : undefined
  const showsWorkspaceSplitButtons = item.kind === 'folder' && !item.id.startsWith('pane-')
  const [treeChildren, setTreeChildren] = useState<Map<string, ShellTreeNode[]>>(() => new Map(restoredSnapshot?.treeChildren ?? []))
  const treeChildrenRef = useRef(new Map(treeChildren))
  const [expandedTreePaths, setExpandedTreePaths] = useState<Set<string>>(() => new Set(restoredSnapshot?.expandedTreePaths ?? []))
  const [archiveRoot, setArchiveRoot] = useState(() => restoredSnapshot?.archiveRoot ?? '')
  const archiveRootRef = useRef(restoredSnapshot?.archiveRoot ?? '')
  const [selectedTreeFile, setSelectedTreeFile] = useState<ShellTreeNode | null>(null)
  const [activePath, setActivePath] = useState(() => restoredSnapshot?.activePath || item.source || 'shell:MyComputerFolder')
  const shellRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLElement>(null)
  const treeScrollTopRef = useRef(restoredSnapshot?.treeScrollTop ?? 0)
  const treeCollapsePendingRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const listScrollTopRef = useRef(restoredSnapshot?.listScrollTop ?? 0)
  const previousViewModeRef = useRef(viewMode)
  const fileMarqueeRef = useRef<{ pointerId: number; sx: number; sy: number; base: Set<string> } | null>(null)
  const columnResizeRef = useRef<{ pointerId: number; column: FileColumnKey; startX: number; startWidth: number; width: number } | null>(null)
  const treeResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; maxWidth: number; width: number } | null>(null)
  const treeColumnResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null)
  const pendingEntriesRef = useRef<ShellEntry[]>([])
  const visibleThumbnailPathsRef = useRef<Set<string>>(new Set())
  const thumbnailAttemptsRef = useRef<Map<string, number>>(new Map())
  const thumbnailPendingPathsRef = useRef<Set<string>>(new Set())
  const thumbnailReadyPathsRef = useRef<Set<string>>(new Set())
  const thumbnailVisibilityFrameRef = useRef<number | null>(null)
  const thumbnailRetryTimerRef = useRef<number | null>(null)
  const thumbnailBatchTimerRef = useRef<number | null>(null)
  const thumbnailBackgroundQueueRef = useRef<string[]>([])
  const thumbnailActiveRequestRef = useRef<{ id: string; paths: string[]; background: boolean } | null>(null)
  const thumbnailRequestSerialRef = useRef(0)
  const thumbnailCancelSentRef = useRef(true)
  const [thumbnailVisibilityRevision, setThumbnailVisibilityRevision] = useState(0)
  const [thumbnailBatchRevision, setThumbnailBatchRevision] = useState(0)
  const pendingNavigationPathRef = useRef('')
  const lastSuccessfulPathRef = useRef('')
  const latestTrailRef = useRef<string[]>(restoredSnapshot?.trail ?? [])
  const generationRef = useRef(0)
  const anchorIndexRef = useRef(-1)
  const snapshotScrollRestoreFrameRef = useRef<number | null>(null)
  const snapshotStateRef = useRef({ entries, activePath, trail, treeChildren, expandedTreePaths, archiveRoot })
  snapshotStateRef.current = { entries, activePath, trail, treeChildren, expandedTreePaths, archiveRoot }
  const fileScrollRef = useRef<HTMLDivElement>(null)
  const virtualScrollFrameRef = useRef<number | null>(null)
  const metadataFlushFrameRef = useRef<number | null>(null)
  const pendingMetadataUpdatesRef = useRef(new Map<string, ShellEntry>())
  const typeAheadRef = useRef({ buffer: '', at: 0 })
  const renameNewFolderRef = useRef<Set<string> | null>(null)
  const [virtualViewport, setVirtualViewport] = useState({ top: 0, height: 0, width: 0 })
  const [groupByName, setGroupByName] = useState(() => readBrowserSettings().fileGroupByName)
  const [renameError, setRenameError] = useState('')
  const [mediaMountCap, setMediaMountCap] = useState(600)
  const [addressEditing, setAddressEditing] = useState(false)
  const fileUndoStackRef = useRef<Array<{ kind: 'rename'; from: string; to: string; label: string } | { kind: 'new'; path: string; label: string }>>([])
  const [fileUndoDepth, setFileUndoDepth] = useState(0)
  const scheduleVirtualViewport = (element?: HTMLElement | null) => {
    const node = element ?? fileScrollRef.current
    if (!node) return
    if (virtualScrollFrameRef.current !== null) return
    virtualScrollFrameRef.current = window.requestAnimationFrame(() => {
      virtualScrollFrameRef.current = null
      const current = fileScrollRef.current
      if (!current) return
      const next = { top: current.scrollTop, height: current.clientHeight, width: current.clientWidth }
      setVirtualViewport((value) => value.top === next.top && value.height === next.height && value.width === next.width ? value : next)
    })
  }
  const legacySurfaceId = `${item.id}-legacy-fallback`
  const commandSurfaceId = fallback ? legacySurfaceId : item.id
  const cancelThumbnailMetadata = useCallback(() => {
    if (thumbnailCancelSentRef.current) return
    window.chrome?.webview?.postMessage({ type: 'native-explorer-metadata-cancel', surfaceId: item.id })
    thumbnailCancelSentRef.current = true
  }, [item.id])
  const persistFileManagerSnapshot = () => {
    const snapshot = snapshotStateRef.current
    rememberFileManagerSnapshot(item.id, {
      entries: snapshot.entries,
      activePath: snapshot.activePath,
      trail: snapshot.trail,
      treeChildren: new Map(snapshot.treeChildren),
      expandedTreePaths: new Set(snapshot.expandedTreePaths),
      archiveRoot: snapshot.archiveRoot,
      treeScrollTop: treeRef.current?.scrollTop ?? treeScrollTopRef.current,
      listScrollTop: listRef.current?.querySelector<HTMLElement>('.fm-file-scroll')?.scrollTop ?? listScrollTopRef.current,
    })
  }

  useLayoutEffect(() => () => persistFileManagerSnapshot(), [item.id])

  useLayoutEffect(() => {
    const latest = fileManagerSnapshots.get(item.id)
    if (!latest || latest === restoredSnapshot) return
    setEntries(latest.entries)
    setActivePath(latest.activePath)
    setTrail(latest.trail)
    treeChildrenRef.current = new Map(latest.treeChildren)
    setTreeChildren(treeChildrenRef.current)
    setExpandedTreePaths(new Set(latest.expandedTreePaths))
    setArchiveRoot(latest.archiveRoot)
    setArchiveLocation(Boolean(latest.archiveRoot))
    latestTrailRef.current = latest.trail
    archiveRootRef.current = latest.archiveRoot
    treeScrollTopRef.current = latest.treeScrollTop
    listScrollTopRef.current = latest.listScrollTop
    snapshotScrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      if (treeRef.current) treeRef.current.scrollTop = treeScrollTopRef.current
      const scroll = listRef.current?.querySelector<HTMLElement>('.fm-file-scroll')
      if (scroll) scroll.scrollTop = listScrollTopRef.current
      snapshotScrollRestoreFrameRef.current = null
    })
    return () => {
      if (snapshotScrollRestoreFrameRef.current !== null) window.cancelAnimationFrame(snapshotScrollRestoreFrameRef.current)
    }
  }, [item.id])

  useEffect(() => {
    if (typeof item.fileTreeOpen === 'boolean') setTreeOpen(item.fileTreeOpen)
  }, [item.fileTreeOpen])

  useEffect(() => {
    const onSettings = (event: Event) => {
      const settings = (event as CustomEvent<AppSettings>).detail
      const nextColumns = settings.fileColumns
      const nextWidths = settings.fileColumnWidths[item.id] ?? {}
      const nextTreeWidth = settings.fileTreeWidths[item.id]
      const nextTreeColumnWidth = settings.fileTreeColumnWidths[item.id]
      setViewMode((current) => current === settings.fileViewMode ? current : settings.fileViewMode)
      setFileIconMode((current) => current === settings.fileIconMode ? current : settings.fileIconMode)
      setGroupByName((current) => current === settings.fileGroupByName ? current : settings.fileGroupByName)
      setFileColumns((current) => JSON.stringify(current) === JSON.stringify(nextColumns) ? current : nextColumns)
      setColumnWidths((current) => JSON.stringify(current) === JSON.stringify(nextWidths) ? current : nextWidths)
      setTreeWidth((current) => current === nextTreeWidth ? current : nextTreeWidth)
      setTreeColumnWidth((current) => current === nextTreeColumnWidth ? current : nextTreeColumnWidth)
      setMediaMuted((current) => current === settings.mediaMuted ? current : settings.mediaMuted)
      setMediaPlaybackRate((current) => current === settings.mediaPlaybackRate ? current : settings.mediaPlaybackRate)
      setFileShortcutBindings(settings.shortcutBindings)
    }
    window.addEventListener(APP_SETTINGS_EVENT, onSettings)
    return () => window.removeEventListener(APP_SETTINGS_EVENT, onSettings)
  }, [item.id])

  useLayoutEffect(() => {
    const tree = treeRef.current
    if (tree) tree.scrollTop = treeScrollTopRef.current
  }, [treeOpen])

  useLayoutEffect(() => {
    const scroll = listRef.current?.querySelector<HTMLElement>('.fm-file-scroll')
    if (scroll) scroll.scrollTop = listScrollTopRef.current
  }, [item.id])

  useLayoutEffect(() => {
    if (previousViewModeRef.current === viewMode) return
    previousViewModeRef.current = viewMode
    // Explorer keeps your place when the view mode flips. Keep the stored
    // offset and clamp it to the new content height instead of snapping to 0.
    const frame = window.requestAnimationFrame(() => {
      const scroll = fileScrollRef.current
      if (!scroll) return
      scroll.scrollTop = Math.min(listScrollTopRef.current, Math.max(0, scroll.scrollHeight - scroll.clientHeight))
      scheduleVirtualViewport(scroll)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [viewMode])

  useEffect(() => {
    if (!fileContextMenu) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.fm-file-context-menu')) return
      setFileContextMenu(null)
    }
    const dismissByKey = (event: KeyboardEvent) => {
      if (shortcutIdForEvent(event, fileShortcutBindings, ['overlay.close']) === 'overlay.close') setFileContextMenu(null)
    }
    window.chrome?.webview?.postMessage({ type: 'native-overlay', active: true })
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', dismissByKey)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', dismissByKey)
      window.chrome?.webview?.postMessage({ type: 'native-overlay', active: false })
    }
  }, [fileContextMenu, fileShortcutBindings])

  // Apply the reset after React has removed every expanded branch. Doing it in
  // the click handler runs before that commit and Chromium's scroll anchoring can
  // restore the old offset while the rows disappear, which makes the control look
  // as if it did nothing in a long tree.
  useLayoutEffect(() => {
    if (!treeCollapsePendingRef.current || expandedTreePaths.size !== 0) return
    treeCollapsePendingRef.current = false
    treeScrollTopRef.current = 0
    if (treeRef.current) treeRef.current.scrollTop = 0
  }, [expandedTreePaths])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) { setLoading(false); return }
    const onMessage = (event: MessageEvent<NativeHostMessage>) => {
      const message = event.data
      if (message?.surfaceId !== item.id) return
      if (isSearchResults) {
        if (message.type === 'native-file-search-start') {
          generationRef.current = message.generation ?? 0
          setEntries([])
          setSelectedPaths(new Set())
          anchorIndexRef.current = -1
          setLoading(true)
        } else if (message.type === 'native-file-search-chunk' && message.generation === generationRef.current) {
          setEntries((current) => [...current, ...(message.entries ?? [])])
        } else if (message.type === 'native-file-search-end' && message.generation === generationRef.current) {
          setSearchBackend(message.backend === 'everything' ? 'everything' : 'fallback')
          setLoading(false)
        } else if (message.type === 'native-file-search-status') {
          setSearchStatus(message.status)
          setSearchBackend(message.backend === 'everything' ? 'everything' : 'fallback')
        }
        return
      }
      if (message.type === 'native-explorer-state') {
        const nextTrail = (message.trail ?? '').split('\t').filter(Boolean)
        latestTrailRef.current = nextTrail
        setTrail(nextTrail)
        if (message.displayName && message.displayName !== item.title) {
          window.dispatchEvent(new CustomEvent('zhangzhongjie-item-title', { detail: { itemId: item.id, title: message.displayName } }))
        }
      } else if (message.type === 'native-explorer-items-start') {
        clearMediaHover(item.id)
        setMediaBaseUrl('')
        generationRef.current = message.generation ?? 0
        if (message.source) setActivePath(message.source)
        pendingNavigationPathRef.current = message.source ?? ''
        pendingEntriesRef.current = []
        visibleThumbnailPathsRef.current.clear()
        thumbnailAttemptsRef.current.clear()
        thumbnailPendingPathsRef.current.clear()
        thumbnailReadyPathsRef.current.clear()
        thumbnailBackgroundQueueRef.current = []
        thumbnailActiveRequestRef.current = null
        if (thumbnailBatchTimerRef.current !== null) window.clearTimeout(thumbnailBatchTimerRef.current)
        thumbnailBatchTimerRef.current = null
        thumbnailCancelSentRef.current = true
        const nextArchiveRoot = message.archiveRoot ?? ''
        const previousArchiveRoot = archiveRootRef.current
        archiveRootRef.current = nextArchiveRoot
        setArchiveRoot(nextArchiveRoot)
        setArchiveLocation(message.archive === true)
        setMirrorArchive(message.mirrorArchive ?? '')
        setSelectedTreeFile(null)
        if (nextArchiveRoot && nextArchiveRoot.toLocaleLowerCase() !== previousArchiveRoot.toLocaleLowerCase()) {
          const rootName = [...latestTrailRef.current].reverse().find((part) => part.toLocaleLowerCase().endsWith('.zip'))
            ?? nextArchiveRoot.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1)
            ?? nextArchiveRoot
          treeChildrenRef.current = new Map([['', [{ name: rootName, path: nextArchiveRoot, expandable: true, folder: true }]]])
        setTreeChildren(treeChildrenRef.current)
          setExpandedTreePaths(new Set([nextArchiveRoot]))
          treeScrollTopRef.current = 0
          postNativeExplorerTreeRequest(item.id, nextArchiveRoot, true)
        } else if (!nextArchiveRoot && previousArchiveRoot) {
          setTreeChildren(new Map())
          setExpandedTreePaths(new Set())
          treeScrollTopRef.current = 0
          postNativeExplorerTreeRequest(item.id)
        }
        setLoadError('')
        setSelectedPaths(new Set())
        anchorIndexRef.current = -1
        setLoading(true)
      } else if (message.type === 'native-explorer-items-chunk' && message.generation === generationRef.current) {
        pendingEntriesRef.current.push(...(message.entries ?? []))
      } else if (message.type === 'native-explorer-items-end' && message.generation === generationRef.current) {
        const nextEntries = pendingEntriesRef.current.map((entry) => {
          const cached = cachedShellImage(entry.path)
          if (!cached?.image) return entry
          thumbnailReadyPathsRef.current.add(entry.path)
          return { ...entry, ...cached }
        })
        const pendingNewFolder = renameNewFolderRef.current
        if (pendingNewFolder) {
          renameNewFolderRef.current = null
          const freshEntry = nextEntries.find((entry) => !pendingNewFolder.has(entry.path))
          if (freshEntry) {
            pushFileUndo({ kind: 'new', path: freshEntry.path, label: freshEntry.name })
            if (freshEntry.folder) {
              setRenamingPath(freshEntry.path)
              setRenameDraft(freshEntry.name)
              setRenameError('')
            }
          }
        }
        pendingEntriesRef.current = nextEntries
        setEntries(nextEntries)
        if (item.initialSelectionPath) {
          const selected = nextEntries.find((entry) => entry.path.toLocaleLowerCase() === item.initialSelectionPath?.toLocaleLowerCase())
          if (selected) setSelectedPaths(new Set([selected.path]))
        }
        setFallback(Boolean(message.fallback))
        setLoading(false)
        setEntriesRevision(message.generation ?? 0)
        if (pendingNavigationPathRef.current && pendingNavigationPathRef.current.toLocaleLowerCase() !== lastSuccessfulPathRef.current.toLocaleLowerCase()) {
          rememberRecentFolder(pendingNavigationPathRef.current, latestTrailRef.current.at(-1))
          lastSuccessfulPathRef.current = pendingNavigationPathRef.current
        }
        if (pendingNavigationPathRef.current && pendingNavigationPathRef.current.toLocaleLowerCase() !== (item.source ?? '').toLocaleLowerCase()) {
          window.dispatchEvent(new CustomEvent(FILE_PANEL_STATE_EVENT, {
            detail: { itemId: item.id, source: pendingNavigationPathRef.current },
          }))
        }
        pendingNavigationPathRef.current = ''
      } else if (message.type === 'native-copy-watch') {
        setCopyWatch(message.done !== true)
        if (message.done === true) pushAppToast('拷贝结束')
      } else if (message.type === 'native-explorer-notice') {
        pushAppToast(message.text || '文件操作失败')
      } else if (message.type === 'native-explorer-error') {
        setEntries([])
        pendingEntriesRef.current = []
        setFallback(false)
        setLoading(false)
        setLoadError(message.message || '无法打开此位置')
      } else if (message.type === 'native-explorer-metadata-chunk' && message.purpose !== 'global-favorite-icon' && message.generation === generationRef.current) {
        let receivedFailure = false
        const pendingUpdates = pendingMetadataUpdatesRef.current
        for (const entry of message.entries ?? []) {
          if (!entry.path) continue
          thumbnailPendingPathsRef.current.delete(entry.path)
          if (entry.image) {
            thumbnailReadyPathsRef.current.add(entry.path)
          }
          else if (entry.thumbKind) {
            thumbnailAttemptsRef.current.set(entry.path, (thumbnailAttemptsRef.current.get(entry.path) ?? 0) + 1)
            receivedFailure = true
          }
          cacheShellImage(entry)
          pendingUpdates.set(entry.path, entry)
        }
        if (receivedFailure) setThumbnailVisibilityRevision((revision) => revision + 1)
        // Metadata streams in 16-entry batches; merging them into one commit per
        // frame stops a 5000-file folder from re-rendering the whole list dozens
        // of times while icons arrive.
        if (metadataFlushFrameRef.current === null) {
          metadataFlushFrameRef.current = window.requestAnimationFrame(() => {
            metadataFlushFrameRef.current = null
            if (!pendingMetadataUpdatesRef.current.size) return
            const flushUpdates = pendingMetadataUpdatesRef.current
            pendingMetadataUpdatesRef.current = new Map()
            setEntries((current) => current.map((entry) => {
              const update = flushUpdates.get(entry.path)
              return update ? {
                ...entry,
                width: update.width ?? entry.width,
                height: update.height ?? entry.height,
                durationMs: update.durationMs ?? entry.durationMs,
                image: update.image || entry.image,
                thumbKind: update.thumbKind ?? entry.thumbKind,
              } : entry
            }))
          })
        }
      } else if (message.type === 'native-explorer-metadata-end' && message.generation === generationRef.current &&
                 message.requestId === thumbnailActiveRequestRef.current?.id) {
        const completed = thumbnailActiveRequestRef.current
        if (!completed) return
        if (thumbnailBatchTimerRef.current !== null) window.clearTimeout(thumbnailBatchTimerRef.current)
        thumbnailBatchTimerRef.current = null
        thumbnailActiveRequestRef.current = null
        for (const path of completed.paths) thumbnailPendingPathsRef.current.delete(path)
        setThumbnailBatchRevision((revision) => revision + 1)
      } else if (message.type === 'native-explorer-folder-size' && message.generation === generationRef.current && message.path) {
        setEntries((current) => current.map((entry) => entry.path === message.path ? { ...entry, folderSize: message.size } : entry))
      } else if (message.type === 'native-explorer-media-root' && message.generation === generationRef.current) {
        setMediaBaseUrl(message.resource ?? '')
      } else if (message.type === 'native-explorer-tree' && message.purpose !== 'preview') {
        const nextTree = new Map(treeChildrenRef.current)
        nextTree.set(message.parent ?? '', message.nodes ?? [])
        treeChildrenRef.current = nextTree
        setTreeChildren(nextTree)
        // 正在「展开到当前目录」的路上就继续走下一级
        if (treeRevealRef.current) treeRevealAdvanceRef.current(nextTree)
      }
    }
    bridge.addEventListener('message', onMessage)
    bridge.postMessage({
      type: 'native-surface-upsert',
      surfaceId: item.id,
      leaseId,
      kind: 'explorer',
      source: item.source || 'shell:MyComputerFolder',
      sourceIntent: 'inherit',
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      visible: false,
      semanticOnly: true,
    })
    postNativeExplorerTreeRequest(item.id)
    return () => {
      clearMediaHover(item.id)
      if (thumbnailVisibilityFrameRef.current !== null) window.cancelAnimationFrame(thumbnailVisibilityFrameRef.current)
      if (thumbnailRetryTimerRef.current !== null) window.clearTimeout(thumbnailRetryTimerRef.current)
      if (thumbnailBatchTimerRef.current !== null) window.clearTimeout(thumbnailBatchTimerRef.current)
      thumbnailBackgroundQueueRef.current = []
      thumbnailActiveRequestRef.current = null
      cancelThumbnailMetadata()
      if (metadataFlushFrameRef.current !== null) { window.cancelAnimationFrame(metadataFlushFrameRef.current); metadataFlushFrameRef.current = null }
      pendingMetadataUpdatesRef.current = new Map()
      bridge.removeEventListener('message', onMessage)
      bridge.postMessage({ type: 'native-surface-destroy', surfaceId: item.id, leaseId })
    }
  }, [cancelThumbnailMetadata, isSearchResults, item.id, item.source, leaseId])

  const updateThumbnailVisibility = useCallback((path: string, visible: boolean) => {
    const paths = visibleThumbnailPathsRef.current
    if (visible ? paths.has(path) : !paths.has(path)) return
    if (visible) paths.add(path)
    else paths.delete(path)
    if (thumbnailVisibilityFrameRef.current !== null) return
    thumbnailVisibilityFrameRef.current = window.requestAnimationFrame(() => {
      thumbnailVisibilityFrameRef.current = null
      setThumbnailVisibilityRevision((revision) => revision + 1)
    })
  }, [])

  useEffect(() => {
    if (!isSearchResults || !searchQuery.trim()) return
    window.chrome?.webview?.postMessage({
      type: 'native-file-search',
      surfaceId: item.id,
      query: searchQuery.trim(),
      root: item.searchRoot ?? '',
    })
  }, [isSearchResults, item.id, item.searchRoot, searchQuery])

  useEffect(() => {
    const onMediaHover = (event: Event) => {
      const active = (event as CustomEvent<{ ownerId: string; path: string } | null>).detail
      setPlayingVideoPath(active?.ownerId === item.id ? active.path : null)
    }
    window.addEventListener(MEDIA_HOVER_EVENT, onMediaHover)
    return () => window.removeEventListener(MEDIA_HOVER_EVENT, onMediaHover)
  }, [item.id])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !entriesRevision || isSearchResults) return
    const mediaGrid = viewMode === 'media-grid'
    // Details-view icon/metadata requests now live in the window-scoped effect
    // above; this pass only refreshes folder sizes and the media endpoint.
    bridge.postMessage({
      type: 'native-explorer-folder-sizes-request',
      surfaceId: item.id,
      generation: entriesRevision,
      paths: pendingEntriesRef.current.filter((entry) => entry.folder).map((entry) => entry.path),
    })
    if (mediaGrid && !archiveLocation) bridge.postMessage({
      type: 'native-explorer-media-root-request',
      surfaceId: item.id,
      generation: entriesRevision,
      path: activePath,
    })
    else {
      clearMediaHover(item.id)
      setMediaBaseUrl('')
    }
  }, [activePath, archiveLocation, entriesRevision, fileColumns, fileIconMode, isSearchResults, item.id, thumbnailPixels, viewMode])

  useEffect(() => {
    const bridge = window.chrome?.webview
    const thumbnailView = viewMode === 'media-grid' || viewMode === 'large-icons'
    if (!bridge || !entriesRevision || !thumbnailView || fileIconMode !== 'system' || isSearchResults) return
    thumbnailBackgroundQueueRef.current = pendingEntriesRef.current
      .filter((entry) => shouldRequestShellImage(entry) && !cachedShellImage(entry.path)?.image &&
        !thumbnailReadyPathsRef.current.has(entry.path) && (thumbnailAttemptsRef.current.get(entry.path) ?? 0) < 4)
      .map((entry) => entry.path)
    const timer = window.setTimeout(() => setThumbnailBatchRevision((revision) => revision + 1), 0)
    return () => {
      window.clearTimeout(timer)
      if (thumbnailBatchTimerRef.current !== null) window.clearTimeout(thumbnailBatchTimerRef.current)
      thumbnailBatchTimerRef.current = null
      if (thumbnailRetryTimerRef.current !== null) {
        window.clearTimeout(thumbnailRetryTimerRef.current)
        thumbnailRetryTimerRef.current = null
      }
      thumbnailBackgroundQueueRef.current = []
      thumbnailActiveRequestRef.current = null
      cancelThumbnailMetadata()
    }
  }, [cancelThumbnailMetadata, entriesRevision, fileIconMode, isSearchResults, item.id, viewMode])

  useEffect(() => {
    const bridge = window.chrome?.webview
    const thumbnailView = viewMode === 'media-grid' || viewMode === 'large-icons'
    if (!bridge || !entriesRevision || !thumbnailView || fileIconMode !== 'system' || isSearchResults) return
    const eligible = (path: string) => !cachedShellImage(path)?.image &&
      !thumbnailReadyPathsRef.current.has(path) && (thumbnailAttemptsRef.current.get(path) ?? 0) < 4
    const visible = visibleThumbnailPathsRef.current
    const visiblePaths = pendingEntriesRef.current
      .filter((entry) => shouldRequestShellImage(entry) && visible.has(entry.path) && eligible(entry.path))
      .map((entry) => entry.path)
    const active = thumbnailActiveRequestRef.current
    if (active) {
      const needsVisiblePreemption = active.background && visiblePaths.some((path) => !active.paths.includes(path))
      if (!needsVisiblePreemption) return
      const unfinished = active.paths.filter((path) => thumbnailPendingPathsRef.current.has(path) && eligible(path))
      for (const path of unfinished) thumbnailPendingPathsRef.current.delete(path)
      thumbnailBackgroundQueueRef.current.unshift(...unfinished)
      if (thumbnailBatchTimerRef.current !== null) window.clearTimeout(thumbnailBatchTimerRef.current)
      if (thumbnailRetryTimerRef.current !== null) window.clearTimeout(thumbnailRetryTimerRef.current)
      thumbnailBatchTimerRef.current = null
      thumbnailRetryTimerRef.current = null
      thumbnailActiveRequestRef.current = null
      cancelThumbnailMetadata()
    }
    const queued = thumbnailBackgroundQueueRef.current
    const paths = visiblePaths.length
      ? visiblePaths
      : queued.splice(0, 64).filter((path) => eligible(path) && !thumbnailPendingPathsRef.current.has(path))
    if (!paths.length) return
    const selected = new Set(paths)
    thumbnailBackgroundQueueRef.current = queued.filter((path) => !selected.has(path))
    for (const path of paths) thumbnailPendingPathsRef.current.add(path)
    const requestId = `${item.id}:${entriesRevision}:${++thumbnailRequestSerialRef.current}`
    const request = { id: requestId, paths, background: visiblePaths.length === 0 }
    thumbnailActiveRequestRef.current = request
    thumbnailCancelSentRef.current = false
    bridge.postMessage({
      type: 'native-explorer-metadata-request',
      surfaceId: item.id,
      generation: entriesRevision,
      requestId,
      dimensions: true,
      duration: true,
      thumbnailPixels: viewMode === 'media-grid'
        ? thumbnailPixels
        : Math.min(256, Math.max(64, Math.round(50 * window.devicePixelRatio))),
      paths,
    })
    if (!request.background) {
      thumbnailRetryTimerRef.current = window.setTimeout(() => {
        thumbnailRetryTimerRef.current = null
        if (paths.some((path) => visibleThumbnailPathsRef.current.has(path))) {
          setThumbnailVisibilityRevision((revision) => revision + 1)
        }
      }, 450)
    }
    thumbnailBatchTimerRef.current = window.setTimeout(() => {
      if (thumbnailActiveRequestRef.current?.id !== requestId) return
      const unfinished = paths.filter((path) => thumbnailPendingPathsRef.current.has(path) && eligible(path))
      for (const path of unfinished) thumbnailPendingPathsRef.current.delete(path)
      if (request.background) thumbnailBackgroundQueueRef.current.push(...unfinished)
      thumbnailActiveRequestRef.current = null
      thumbnailBatchTimerRef.current = null
      setThumbnailBatchRevision((revision) => revision + 1)
    }, 1500)
  }, [cancelThumbnailMetadata, entriesRevision, fileIconMode, isSearchResults, item.id, thumbnailBatchRevision, thumbnailPixels, thumbnailVisibilityRevision, viewMode])

  useEffect(() => {
    postNativeExplorerSelection(item.id, [...selectedPaths])
    window.dispatchEvent(new CustomEvent('zhangzhongjie-shell-selection', {
      detail: {
        surfaceId: item.id,
        selected: entries.filter((entry) => selectedPaths.has(entry.path)),
        siblings: entries.filter((entry) => !entry.folder),
      },
    }))
  }, [entries, item.id, selectedPaths])

  useEffect(() => {
    const node = shellRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      // Match the media-grid column algorithm and request physical pixels from
      // Shell. Quantization prevents tiny resize changes from restarting work.
      const available = Math.max(168, width - 35)
      const columns = Math.max(1, Math.floor((available + 9) / 177))
      const tileCssPixels = (available - Math.max(0, columns - 1) * 9) / columns
      const physicalPixels = Math.min(768, Math.max(64, Math.ceil(tileCssPixels * window.devicePixelRatio / 32) * 32))
      setThumbnailPixels((current) => current === physicalPixels ? current : physicalPixels)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const node = fileScrollRef.current
    if (!node) return
    const update = () => scheduleVirtualViewport(node)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const crumbs = useMemo(() => {
    if (isSearchResults) return [item.searchRoot ? item.searchRoot : '此电脑', `搜索：${searchQuery}`]
    if (trail.length) return trail
    const raw = item.source ?? 'shell:MyComputerFolder'
    if (raw.startsWith('shell:')) return ['此电脑']
    return ['此电脑', ...raw.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)]
  }, [isSearchResults, item.searchRoot, item.source, searchQuery, trail])

  const sortedEntries = useMemo(() => {
    const compareText = (left: string, right: string) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' })
    const sorted = [...entries].sort((left, right) => {
      if (left.folder !== right.folder) return left.folder ? -1 : 1
      let result = 0
      if (fileSortKey === 'modified') result = left.modifiedStamp !== undefined && right.modifiedStamp !== undefined
        ? left.modifiedStamp - right.modifiedStamp
        : compareText(left.modified, right.modified)
      else if (fileSortKey === 'type') result = compareText(left.typeText, right.typeText)
      else if (fileSortKey === 'size') result = (left.folder ? left.folderSize ?? -1 : left.size) - (right.folder ? right.folderSize ?? -1 : right.size)
      else result = compareText(left.name, right.name)
      if (!result) result = compareText(left.name, right.name)
      return fileSortDescending ? -result : result
    })
    return sorted
  }, [entries, fileSortDescending, fileSortKey])

  const groupedEntries = useMemo(() => {
    if (fileSortKey !== 'name' || !groupByName) return [{ key: '', entries: sortedEntries }]
    const buckets = new Map<string, ShellEntry[]>()
    for (const entry of sortedEntries) {
      const key = fileNameGroup(entry.name)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(entry)
      else buckets.set(key, [entry])
    }
    const order = [...buckets.keys()].sort((left, right) => {
      const leftIndex = GROUP_LETTER_ORDER.indexOf(left)
      const rightIndex = GROUP_LETTER_ORDER.indexOf(right)
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex)
    })
    if (fileSortDescending) order.reverse()
    return order.map((key) => ({ key, entries: buckets.get(key) ?? [] }))
  }, [fileSortKey, fileSortDescending, sortedEntries, groupByName])

  const displayedEntries = useMemo(
    () => groupedEntries.flatMap((group) => group.entries),
    [groupedEntries],
  )

  const displayedEntryIndexes = useMemo(() => {
    const indexes = new Map<string, number>()
    displayedEntries.forEach((entry, index) => indexes.set(entry.path, index))
    return indexes
  }, [displayedEntries])

  const fileListItems = useMemo(() => {
    const items: FileListItem[] = []
    for (const group of groupedEntries) {
      if (group.key) items.push({ kind: 'heading', key: group.key, count: group.entries.length })
      for (const entry of group.entries) items.push({ kind: 'entry', entry, index: displayedEntryIndexes.get(entry.path) ?? 0 })
    }
    return items
  }, [displayedEntryIndexes, groupedEntries])

  const fileListMetrics = FILE_ROW_METRICS[isSearchResults ? 'search' : viewMode === 'media-grid' ? 'details' : viewMode]

  // Virtualisation kicks in only for large folders; small folders keep the
  // legacy render so every interaction stays untouched.
  const virtualEnabled = !fallback && viewMode !== 'media-grid' && fileListItems.length > FILE_VIRTUAL_THRESHOLD

  const fileListLayout = useMemo(() => {
    if (!virtualEnabled) return null
    const metrics = fileListMetrics
    const count = fileListItems.length
    const heights = new Array<number>(count)
    for (let index = 0; index < count; index++) {
      heights[index] = fileListItems[index].kind === 'heading' ? metrics.headingHeight : metrics.entryHeight
    }
    const padTop = metrics.padTop
    const padBottom = metrics.padBottom
    if (metrics.columnMin <= 0) {
      const cum = new Array<number>(count + 1)
      cum[0] = 0
      for (let index = 0; index < count; index++) cum[index + 1] = cum[index] + heights[index]
      return {
        mode: 'block' as const, items: fileListItems, heights, cum,
        columns: 1, rowCount: count, rowStarts: [] as number[], rowOf: [] as number[],
        rowHeight: metrics.entryHeight, rowGap: 0, columnWidth: 0, columnGap: 0,
        padTop, padBottom, padX: metrics.padX, totalHeight: padTop + cum[count] + padBottom,
      }
    }
    // Grid views: a heading spans a full row; entries pack `columns` per row.
    // Every row has the same height, so grid-row spacers can stand in for the
    // skipped rows exactly.
    const width = virtualViewport.width || 520
    const columns = Math.max(1, Math.floor((width - metrics.padX * 2 + metrics.columnGap) / (metrics.columnMin + metrics.columnGap)))
    const rowOf = new Array<number>(count)
    const rowStarts: number[] = []
    let row = 0
    let slot = 0
    for (let index = 0; index < count; index++) {
      if (fileListItems[index].kind === 'heading') {
        if (slot > 0) { row += 1; slot = 0 }
        if (rowStarts[row] === undefined) rowStarts[row] = index
        rowOf[index] = row
        row += 1
      } else {
        if (slot === 0 && rowStarts[row] === undefined) rowStarts[row] = index
        rowOf[index] = row
        slot += 1
        if (slot === columns) { slot = 0; row += 1 }
      }
    }
    const rowCount = row + (slot > 0 ? 1 : 0)
    const stride = metrics.entryHeight + metrics.rowGap
    const columnWidth = Math.max(0, (width - metrics.padX * 2 - Math.max(0, columns - 1) * metrics.columnGap) / columns)
    return {
      mode: 'grid' as const, items: fileListItems, heights, cum: null as number[] | null,
      columns, rowCount, rowStarts, rowOf,
      rowHeight: metrics.entryHeight, rowGap: metrics.rowGap, columnWidth, columnGap: metrics.columnGap,
      padTop, padBottom, padX: metrics.padX, totalHeight: padTop + Math.max(0, rowCount * stride - metrics.rowGap) + padBottom,
    }
  }, [fileListItems, fileListMetrics, virtualEnabled, virtualViewport.width])

  const fileListWindow = useMemo(() => {
    const layout = fileListLayout
    if (!layout) return null
    const count = layout.items.length
    if (!count) return { start: 0, end: 0, topSpacerRows: 0, bottomSpacerRows: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
    const overscan = 1400
    const viewportHeight = virtualViewport.height || 600
    // 视图切换瞬间存储的滚动偏移可能超过新内容高度（图标视图的偏移量套到
    // 更短的详情列表上）。先钳制再算窗口，否则窗口会落到列表尽头之外，
    // 上下两个占位块把总高撑成两倍、中间一行都不渲染 —— 列表变空白。
    const clampedTop = Math.max(0, Math.min(virtualViewport.top, Math.max(0, layout.totalHeight - viewportHeight)))
    const top = Math.max(0, clampedTop - overscan)
    const bottom = clampedTop + viewportHeight + overscan
    if (layout.mode === 'block') {
      const cum = layout.cum ?? []
      let lo = 0
      let hi = count
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid + 1] <= top) lo = mid + 1; else hi = mid }
      const start = Math.min(lo, Math.max(0, count - 1))
      lo = start
      hi = count
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < bottom) lo = mid + 1; else hi = mid }
      const end = Math.max(start + 1, Math.min(count, lo))
      return { start, end, topSpacerRows: 0, bottomSpacerRows: 0, topSpacerHeight: cum[start] ?? 0, bottomSpacerHeight: (cum[count] ?? 0) - (cum[end] ?? 0) }
    }
    const stride = layout.rowHeight + layout.rowGap
    const startRow = Math.max(0, Math.min(layout.rowCount - 1, Math.floor((top - layout.padTop) / stride)))
    const endRow = Math.max(startRow, Math.min(layout.rowCount - 1, Math.floor((bottom - layout.padTop) / stride)))
    const start = layout.rowStarts[startRow] ?? 0
    const end = endRow + 1 < layout.rowCount ? (layout.rowStarts[endRow + 1] ?? count) : count
    return { start, end, topSpacerRows: startRow, bottomSpacerRows: Math.max(0, layout.rowCount - 1 - endRow), topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }, [fileListLayout, virtualViewport.top, virtualViewport.height])

  const entryItemIndexes = useMemo(() => {
    const indexes = new Map<number, number>()
    fileListItems.forEach((item, itemIndex) => { if (item.kind === 'entry') indexes.set(item.index, itemIndex) })
    return indexes
  }, [fileListItems])

  const scrollDisplayedIndexIntoView = (index: number) => {
    const layout = fileListLayout
    const node = fileScrollRef.current
    const itemIndex = entryItemIndexes.get(index)
    if (!layout || !node || itemIndex === undefined) return
    const top = layout.mode === 'block'
      ? layout.padTop + (layout.cum?.[itemIndex] ?? 0)
      : layout.padTop + (layout.rowOf?.[itemIndex] ?? 0) * (layout.rowHeight + layout.rowGap)
    const height = layout.heights[itemIndex]
    const viewTop = node.scrollTop
    const viewBottom = viewTop + node.clientHeight
    if (top < viewTop) node.scrollTop = Math.max(0, top - 8)
    else if (top + height > viewBottom) node.scrollTop = top + height - node.clientHeight + 8
    scheduleVirtualViewport(node)
  }

  // A folder created via 新建文件夹 should land in rename mode like Explorer.
  useEffect(() => {
    if (!renamingPath) return
    if (document.querySelector('.fm-file-entry.is-renaming')) return
    const index = displayedEntryIndexes.get(renamingPath)
    if (index === undefined) return
    const frame = window.requestAnimationFrame(() => scrollDisplayedIndexIntoView(index))
    return () => window.cancelAnimationFrame(frame)
  }, [renamingPath, displayedEntryIndexes])

  const fileListLayoutRef = useRef<typeof fileListLayout>(null)
  fileListLayoutRef.current = fileListLayout
  const detailWindowStart = virtualEnabled && fileListWindow ? fileListWindow.start : -1
  const detailWindowEnd = virtualEnabled && fileListWindow ? fileListWindow.end : -1

  // Details-view Shell icons are requested only for the rendered window instead
  // of the entire folder; scrolling streams the rest in as it approaches.
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !entriesRevision || isSearchResults) return
    if (viewMode === 'media-grid' || viewMode === 'large-icons') return
    const wantsIcons = fileIconMode === 'system'
    const wantsDetails = fileColumns.includes('dimensions') || fileColumns.includes('duration')
    if (!wantsIcons && !wantsDetails) return
    const layout = fileListLayoutRef.current
    const sourceEntries = detailWindowStart >= 0 && layout
      ? layout.items.slice(detailWindowStart, detailWindowEnd).flatMap((item) => item.kind === 'entry' ? [item.entry] : [])
      : pendingEntriesRef.current
    const metadataPaths = sourceEntries.filter((entry) =>
      ((wantsIcons && !cachedShellImage(entry.path)?.image) || (!entry.folder && wantsDetails)) &&
      !thumbnailReadyPathsRef.current.has(entry.path) &&
      !thumbnailPendingPathsRef.current.has(entry.path)
    ).map((entry) => entry.path)
    if (!metadataPaths.length) return
    for (const path of metadataPaths) thumbnailPendingPathsRef.current.add(path)
    thumbnailCancelSentRef.current = false
    bridge.postMessage({
      type: 'native-explorer-metadata-request',
      surfaceId: item.id,
      generation: entriesRevision,
      dimensions: wantsDetails,
      duration: wantsDetails,
      thumbnailPixels: wantsIcons ? 64 : 0,
      paths: metadataPaths,
    })
  }, [detailWindowStart, detailWindowEnd, entriesRevision, fileColumns, fileIconMode, isSearchResults, item.id, viewMode])

  // Large media grids mount progressively so the first paint is instant.
  useEffect(() => {
    setMediaMountCap(fileListItems.length <= 600 ? fileListItems.length : 600)
  }, [item.id, entriesRevision])
  useEffect(() => {
    if (!(viewMode === 'media-grid' && fileListItems.length > mediaMountCap)) return
    const timer = window.setTimeout(() => setMediaMountCap((current) => Math.min(fileListItems.length, current + 600)), 140)
    return () => window.clearTimeout(timer)
  }, [viewMode, mediaMountCap, fileListItems.length])

  const anchoredEntryPath = displayedEntries[anchorIndexRef.current]?.path
  const rowActionsPath = anchoredEntryPath && selectedPaths.has(anchoredEntryPath)
    ? anchoredEntryPath
    : displayedEntries.find((entry) => selectedPaths.has(entry.path))?.path

  const selectEntry = (entry: ShellEntry, index: number, extend: boolean, toggle: boolean) => {
    setSelectedPaths((current) => {
      if (extend && anchorIndexRef.current >= 0) {
        const start = Math.min(anchorIndexRef.current, index)
        const end = Math.max(anchorIndexRef.current, index)
        const range = displayedEntries.slice(start, end + 1).map((candidate) => candidate.path)
        return toggle ? new Set([...current, ...range]) : new Set(range)
      }
      anchorIndexRef.current = index
      if (toggle) {
        const next = new Set(current)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      }
      return new Set([entry.path])
    })
  }

  const handleRowImageError = (path: string) => {
    shellImageCache.delete(shellImageCacheKey(path))
    setEntries((current) => current.map((entry) => entry.path === path && entry.image
      ? { ...entry, image: undefined }
      : entry))
  }

  const invokeContextMenu = (paths: string[], screenX: number, screenY: number) => {
    if (isSearchResults) postNativeShellContextMenu(paths, screenX, screenY)
    else postNativeExplorerContextMenu(item.id, paths, screenX, screenY)
  }

  const toggleTreeIconSize = () => {
    const next = treeIconSize === 'large' ? 'small' : 'large'
    setTreeIconSize(next)
    publishSettingsPatch({ fileTreeIconSize: next })
  }

  const openTreeNode = (node: ShellTreeNode) => {
    setSelectedTreeFile(null)
    setActivePath(node.path)
    postNativeExplorerOpen(item.id, node.path)
  }

  const treeFiles = () => [...treeChildren.values()].flat().filter((node) => node.folder === false)
  const selectTreeFile = (node: ShellTreeNode) => {
    setSelectedTreeFile(node)
    const selected: ShellEntry = {
      name: node.name,
      path: node.path,
      typeText: '',
      modified: node.modifiedText ?? '',
      image: node.image,
      size: node.size ?? 0,
      folder: false,
      hidden: false,
      shortcut: false,
    }
    const siblings = treeFiles().map((entry): ShellEntry => ({
      name: entry.name,
      path: entry.path,
      typeText: '',
      modified: entry.modifiedText ?? '',
      image: entry.image,
      size: entry.size ?? 0,
      folder: false,
      hidden: false,
      shortcut: false,
    }))
    window.dispatchEvent(new CustomEvent('zhangzhongjie-shell-selection', {
      detail: { surfaceId: item.id, selected: [selected], siblings },
    }))
  }

  const beginRename = () => {
    if (selectedPaths.size !== 1) return
    const path = [...selectedPaths][0]
    const entry = entries.find((candidate) => candidate.path === path)
    if (!entry) return
    setRenameError('')
    setRenamingPath(path)
    setRenameDraft(entry.name)
  }

  const previewPaths = (paths: string[]) => {
    const selected = entries.filter((entry) => paths.includes(entry.path))
    if (!selected.length) return
    window.dispatchEvent(new CustomEvent<ShellPreviewTarget>(SHELL_PREVIEW_OPEN_EVENT, {
      detail: { surfaceId: item.id, entry: selected.at(-1)!, siblings: sortedEntries },
    }))
  }

  const favoritePath = (entry: ShellEntry) => {
    const favoriteImage = entry.image?.startsWith('data:image/') ? entry.image : undefined
    window.dispatchEvent(new CustomEvent(GLOBAL_FAVORITE_REQUEST_EVENT, { detail: {
      source: entry.path,
      sourceKind: entry.folder ? 'folder' : 'file',
      label: entry.name,
      image: favoriteImage,
    } }))
  }

  const openEntryLocation = (entry: ShellEntry) => {
    const parent = entry.parentPath || entry.path.replace(/[\\/][^\\/]+$/, '')
    if (parent) window.dispatchEvent(new CustomEvent('zhangzhongjie-add-folder', { detail: parent }))
  }

  const postFileCommand = (verb: Parameters<typeof postNativeExplorerCommand>[1]) => {
    // 新建：先记下创建前的路径集合，列表刷新后自动进入重命名（文件夹）并登记撤销项（对齐资源管理器）。
    if (verb === 'new' || verb === 'new-txt' || verb === 'new-md' || verb === 'new-html') {
      renameNewFolderRef.current = new Set(pendingEntriesRef.current.map((entry) => entry.path))
    }
    postNativeExplorerCommand(commandSurfaceId, verb)
  }

  const pushFileUndo = (operation: { kind: 'rename'; from: string; to: string; label: string } | { kind: 'new'; path: string; label: string }) => {
    fileUndoStackRef.current = [...fileUndoStackRef.current.slice(-19), operation]
    setFileUndoDepth(fileUndoStackRef.current.length)
  }

  // 文件操作撤销：重命名撤销 = 改回原名；新建撤销 = 移入回收站（回收站里还能再恢复）。
  const undoLastFileOperation = () => {
    const operation = fileUndoStackRef.current.at(-1)
    if (!operation) { pushAppToast('没有可撤销的文件操作'); return }
    fileUndoStackRef.current = fileUndoStackRef.current.slice(0, -1)
    setFileUndoDepth(fileUndoStackRef.current.length)
    if (operation.kind === 'rename') {
      const name = operation.from.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      if (!name) return
      postNativeExplorerRename(commandSurfaceId, operation.to, name)
      pushAppToast(`已撤销重命名：${operation.label}`)
    } else {
      postNativeExplorerSelection(commandSurfaceId, [operation.path])
      postNativeExplorerCommand(commandSurfaceId, 'delete')
      pushAppToast(`已撤销新建（已移入回收站）：${operation.label}`)
    }
  }

  const invokeRowCommand = (entry: ShellEntry, verb: typeof FILE_ROW_COMMANDS[number]['verb']) => {
    const paths = selectedPaths.has(entry.path) ? [...selectedPaths] : [entry.path]
    if (!selectedPaths.has(entry.path)) setSelectedPaths(new Set(paths))
    if (verb === 'new') {
      postFileCommand(verb)
      return
    }
    // The hidden Shell view owns the real selection and every file verb. Send its
    // selection immediately before the command so a hover action cannot operate on
    // the row that happened to be selected during the previous React render.
    postNativeExplorerSelection(commandSurfaceId, paths)
    if (verb === 'rename') {
      if (paths.length !== 1) return
      setRenameError('')
      setRenamingPath(entry.path)
      setRenameDraft(entry.name)
      return
    }
    postNativeExplorerCommand(commandSurfaceId, verb)
  }

  const finishRename = (commit: boolean, source: 'enter' | 'blur' = 'blur') => {
    const path = renamingPath
    const nextName = renameDraft.trim()
    if (!commit || !path || !nextName) {
      setRenamingPath(null)
      setRenameError('')
      return
    }
    if (/[\\/:*?"<>|]/.test(nextName)) {
      if (source === 'enter') {
        setRenameError('名称不能包含 \\ / : * ? " < > | 字符')
        window.requestAnimationFrame(() => { const input = document.querySelector<HTMLInputElement>('.fm-rename-input'); input?.focus(); input?.select() })
        return
      }
      setRenamingPath(null)
      setRenameError('')
      pushAppToast('名称包含非法字符，已取消重命名')
      return
    }
    setRenamingPath(null)
    setRenameError('')
    const currentName = entries.find((entry) => entry.path === path)?.name
    if (currentName === nextName) return
    const parent = path.replace(/[\\/][^\\/]+$/, '')
    pushFileUndo({ kind: 'rename', from: path, to: parent && parent !== path ? `${parent}\\${nextName}` : nextName, label: currentName ?? nextName })
    postNativeExplorerRename(commandSurfaceId, path, nextName)
  }

  // 目录树跟随当前目录(用户 2026-09-14)：「打开位置」跳到某个文件夹后，左边树上这一路要自己展开并高亮，
  // 否则只看到三个折叠的盘符，根本看不出这个文件在哪。逐级向宿主请求子节点，拿到一层就展开一层。
  const treeRequestedRef = useRef<Set<string>>(new Set())
  // 新的一次定位（打开位置 / 换目录）要冲掉上次留下的展开项，只留这一路
  const treeRevealFreshRef = useRef(false)
  const pendingSelectRef = useRef<{ file: string; dir: string } | null>(null)
  const treeRevealRef = useRef('')
  const treeRevealAdvanceRef = useRef<(children: Map<string, ShellTreeNode[]>) => void>(() => {})
  treeRevealAdvanceRef.current = (children) => {
    const target = treeRevealRef.current
    if (!target) return
    const normalized = target.replace(/\//g, '\\').replace(/\\+$/, '')
    const parts = normalized.split('\\')
    if (!/^[a-z]:$/i.test(parts[0] ?? '') || parts.length < 2) { treeRevealRef.current = ''; return }
    const chain = [`${parts[0]}\\`]
    let acc = chain[0]
    for (let index = 1; index < parts.length; index += 1) {
      if (!parts[index]) continue
      acc = acc.endsWith('\\') ? acc + parts[index] : `${acc}\\${parts[index]}`
      chain.push(acc)
    }
    if (treeRevealFreshRef.current) {
      treeRevealFreshRef.current = false
      setExpandedTreePaths(new Set(chain.slice(0, -1)))
    }
    const expand = (paths: string[]) => {
      if (!paths.length) return
      setExpandedTreePaths((current) => {
        const next = new Set(current)
        let changed = false
        for (const path of paths) if (!next.has(path)) { next.add(path); changed = true }
        return changed ? next : current
      })
    }
    for (let index = 0; index < chain.length; index += 1) {
      const parentKey = index === 0 ? '' : chain[index - 1]
      if (!children.has(parentKey)) {
        if (!treeRequestedRef.current.has(parentKey)) {
          treeRequestedRef.current.add(parentKey)
          postNativeExplorerTreeRequest(item.id, parentKey)
        }
        expand(chain.slice(0, Math.max(0, index - 1)))
        return
      }
      if (index === chain.length - 1) continue
      expand([chain[index]])
    }
    treeRevealRef.current = ''
    window.requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector<HTMLElement>('.fm-tree-branch button.active')
      row?.scrollIntoView({ block: 'nearest' })
    })
  }
  useEffect(() => {
    if (!treeOpen) return
    if (!/^[a-z]:[\\/]/i.test(activePath)) return
    treeRevealRef.current = activePath
    treeRevealFreshRef.current = true
    treeRevealAdvanceRef.current(new Map(treeChildrenRef.current))
  }, [activePath, treeOpen])
  // 「打开位置」显式要求展开（目标目录和当前目录相同也要展开）
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; path?: string; file?: string }>).detail
      if (!detail?.path) return
      if (detail.itemId && detail.itemId !== item.id) return
      if (!/^[a-z]:[\\/]/i.test(detail.path)) return
      treeRequestedRef.current.delete('')
      treeRevealRef.current = detail.path
      treeRevealFreshRef.current = true
      treeRevealAdvanceRef.current(new Map(treeChildrenRef.current))
      // 「打开位置」还要求把这个文件在右列表里选中（对齐资源管理器），等条目到位再选
      if (detail.file) pendingSelectRef.current = { file: detail.file, dir: detail.path }
    }
    window.addEventListener(FILE_TREE_REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(FILE_TREE_REVEAL_EVENT, onReveal)
  }, [item.id])
  // 「打开位置」跳过去之后，把那个文件在列表里选中（用户 2026-09-14）：等目标目录的条目到位再选，
  // 否则会被这次导航的刷新冲掉。
  useEffect(() => {
    const pending = pendingSelectRef.current
    if (!pending) return
    const same = (left: string, right: string) => left.replace(/[\\/]+$/, '').toLocaleLowerCase() === right.replace(/[\\/]+$/, '').toLocaleLowerCase()
    if (!same(activePath, pending.dir)) return
    const index = displayedEntries.findIndex((entry) => same(entry.path, pending.file))
    if (index < 0) return
    pendingSelectRef.current = null
    anchorIndexRef.current = index
    setSelectedPaths(new Set([pending.file]))
    postNativeExplorerSelection(item.id, [pending.file])
    window.requestAnimationFrame(() => scrollDisplayedIndexIntoView(index))
  }, [activePath, displayedEntries, item.id])

  const toggleTreeNode = (node: ShellTreeNode) => {
    if (!node.expandable) return
    setExpandedTreePaths((current) => {
      const next = new Set(current)
      if (next.has(node.path)) next.delete(node.path)
      else {
        next.add(node.path)
        if (!treeChildren.has(node.path)) postNativeExplorerTreeRequest(item.id, node.path, Boolean(archiveRoot))
      }
      return next
    })
  }

  const toggleTreeVisibility = () => {
    const nextOpen = !treeOpen
    setTreeOpen(nextOpen)
    window.dispatchEvent(new CustomEvent(FILE_PANEL_STATE_EVENT, {
      detail: { itemId: item.id, treeOpen: nextOpen },
    }))
  }

  const collapseTreeBranches = () => {
    if (!expandedTreePaths.size) return
    treeCollapsePendingRef.current = true
    setExpandedTreePaths(new Set())
  }

  const changeTreeSort = (key: ShellTreeSortKey) => {
    if (treeSortKey === key) setTreeSortDescending((value) => !value)
    else { setTreeSortKey(key); setTreeSortDescending(false) }
  }

  const changeFileSort = (key: FileSortKey) => {
    if (fileSortKey === key) setFileSortDescending((value) => !value)
    else { setFileSortKey(key); setFileSortDescending(false) }
  }

  const selectViewMode = (mode: FileViewMode) => {
    setViewMode(mode)
    setShowViewMenu(false)
    publishSettingsPatch({ fileViewMode: mode })
  }

  const toggleFileColumn = (column: FileColumnKey) => {
    if (column === 'name') return
    const selected = new Set(fileColumns)
    if (selected.has(column)) selected.delete(column)
    else selected.add(column)
    const next = (Object.keys(FILE_COLUMN_LABELS) as FileColumnKey[]).filter((candidate) => candidate === 'name' || selected.has(candidate))
    setFileColumns(next)
    publishSettingsPatch({ fileColumns: next })
  }

  const visibleFileColumns = fileColumns
  const columnTrack = (column: FileColumnKey, widths = columnWidths) => widths[column] ? `${widths[column]}px` : ({
    name: 'minmax(220px, 2fr)', modified: 'minmax(126px, .9fr)', type: 'minmax(118px, .8fr)',
    dimensions: 'minmax(92px, .62fr)', duration: 'minmax(72px, .48fr)', size: 'minmax(84px, .45fr)',
  }[column])
  const columnTemplateFor = (widths: Partial<Record<FileColumnKey, number>>) => visibleFileColumns.map((column) => columnTrack(column, widths)).join(' ')
  const columnTemplate = isSearchResults ? 'minmax(260px, 1fr) 92px' : columnTemplateFor(columnWidths)

  const paintColumnWidth = (column: FileColumnKey, width: number) => {
    listRef.current?.style.setProperty('--fm-column-template', columnTemplateFor({ ...columnWidths, [column]: width }))
  }

  const persistColumnWidth = (column: FileColumnKey, width: number) => {
    const nextWidths = { ...columnWidths, [column]: width }
    setColumnWidths(nextWidths)
    const settings = readBrowserSettings()
    publishSettingsPatch({ fileColumnWidths: { ...settings.fileColumnWidths, [item.id]: nextWidths } })
  }

  const persistTreeWidth = (width: number | undefined) => {
    setTreeWidth(width)
    const settings = readBrowserSettings()
    const nextWidths = { ...settings.fileTreeWidths }
    if (width === undefined) delete nextWidths[item.id]
    else nextWidths[item.id] = Math.round(width)
    publishSettingsPatch({ fileTreeWidths: nextWidths })
  }

  const persistTreeColumnWidth = (width: number | undefined) => {
    setTreeColumnWidth(width)
    const settings = readBrowserSettings()
    const nextWidths = { ...settings.fileTreeColumnWidths }
    if (width === undefined) delete nextWidths[item.id]
    else nextWidths[item.id] = Math.round(width)
    publishSettingsPatch({ fileTreeColumnWidths: nextWidths })
  }

  const fitColumnToVisibleContent = (column: FileColumnKey) => {
    const scroll = listRef.current?.querySelector<HTMLElement>('.fm-file-scroll')
    if (!scroll) return
    const scrollRect = scroll.getBoundingClientRect()
    let width = column === 'name' ? 140 : 70
    const heading = listRef.current?.querySelector<HTMLElement>(`.fm-list-head button[data-column="${column}"] .fm-column-label`)
    if (heading) width = Math.max(width, heading.scrollWidth + 18)
    for (const entry of scroll.querySelectorAll<HTMLElement>('.fm-file-entry')) {
      const rect = entry.getBoundingClientRect()
      if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) continue
      const cell = entry.querySelector<HTMLElement>(`[data-column="${column}"]`)
      if (cell) width = Math.max(width, cell.scrollWidth + 18)
    }
    persistColumnWidth(column, clamp(Math.ceil(width), column === 'name' ? 140 : 70, 1200))
  }

  const cycleViewMode = () => {
    const modes: FileViewMode[] = ['details', 'large-icons', 'media-grid', 'compact']
    selectViewMode(modes[(modes.indexOf(viewMode) + 1) % modes.length])
  }

  const cycleMediaPlaybackRate = () => {
    const index = MEDIA_PLAYBACK_RATES.indexOf(mediaPlaybackRate as typeof MEDIA_PLAYBACK_RATES[number])
    const next = MEDIA_PLAYBACK_RATES[(index + 1) % MEDIA_PLAYBACK_RATES.length]
    publishSettingsPatch({ mediaPlaybackRate: next })
  }

  // 卡片右键「手动输路径…」→ 让这张卡的地址行变成输入框（只有这张卡响应）。
  useEffect(() => {
    const onAddressEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string }>).detail
      if (detail?.itemId && detail.itemId !== item.id) return
      setAddressEditing(true)
    }
    window.addEventListener(FILE_ADDRESS_EDIT_EVENT, onAddressEdit)
    return () => window.removeEventListener(FILE_ADDRESS_EDIT_EVENT, onAddressEdit)
  }, [item.id])

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const nativeKey = event.nativeEvent
    const moveToDisplayedIndex = (nextIndex: number, extend: boolean) => {
      if (!displayedEntries.length) return
      const clamped = clamp(nextIndex, 0, displayedEntries.length - 1)
      const entry = displayedEntries[clamped]
      if (!entry) return
      selectEntry(entry, clamped, extend, false)
      scrollDisplayedIndexIntoView(clamped)
    }
    const currentDisplayedIndex = () => {
      if (anchorIndexRef.current >= 0 && anchorIndexRef.current < displayedEntries.length) return anchorIndexRef.current
      return displayedEntries.findIndex((entry) => selectedPaths.has(entry.path))
    }
    const plainKey = !nativeKey.ctrlKey && !nativeKey.altKey && !nativeKey.metaKey && !nativeKey.isComposing
    // Explorer keyboard model: arrows / Home / End / PageUp / PageDown move the
    // selection, typing a character types ahead to the next matching name.
    if (plainKey && (nativeKey.key === 'ArrowDown' || nativeKey.key === 'ArrowUp' || nativeKey.key === 'Home' || nativeKey.key === 'End' || nativeKey.key === 'PageDown' || nativeKey.key === 'PageUp')) {
      event.preventDefault()
      const from = currentDisplayedIndex()
      const pageSize = Math.max(1, Math.floor((fileScrollRef.current?.clientHeight ?? 400) / Math.max(1, fileListMetrics.entryHeight)))
      const target = nativeKey.key === 'ArrowDown' ? (from < 0 ? 0 : from + 1)
        : nativeKey.key === 'ArrowUp' ? (from < 0 ? 0 : from - 1)
        : nativeKey.key === 'Home' ? 0
        : nativeKey.key === 'End' ? displayedEntries.length - 1
        : nativeKey.key === 'PageDown' ? (from < 0 ? pageSize - 1 : from + pageSize)
        : Math.max(0, from < 0 ? 0 : from - pageSize)
      moveToDisplayedIndex(target, nativeKey.shiftKey)
      return
    }
    if (plainKey && nativeKey.key.length === 1 && nativeKey.key !== ' ') {
      const now = performance.now()
      const typeAhead = typeAheadRef.current
      const buffer = (now - typeAhead.at < 900 ? typeAhead.buffer : '') + nativeKey.key.toLocaleLowerCase()
      typeAheadRef.current = { buffer, at: now }
      const from = currentDisplayedIndex()
      const after = displayedEntries.findIndex((entry, index) => index > (from < 0 ? -1 : from) && entry.name.toLocaleLowerCase().startsWith(buffer))
      const match = after >= 0 ? after : displayedEntries.findIndex((entry) => entry.name.toLocaleLowerCase().startsWith(buffer))
      if (match >= 0) {
        event.preventDefault()
        moveToDisplayedIndex(match, false)
      }
      return
    }
    const shortcutId = shortcutIdForEvent(event.nativeEvent, fileShortcutBindings, ['preview.toggle', 'file.selectAll', 'file.open', 'file.copy', 'file.cut', 'file.paste', 'file.delete', 'file.rename', 'file.back', 'file.new', 'file.refresh', 'file.address', 'file.undo', 'file.favorite', 'file.openLocation'])
    if (shortcutId === 'preview.toggle' && selectedPaths.size) {
      event.preventDefault()
      event.stopPropagation()
      const selected = entries.filter((entry) => selectedPaths.has(entry.path))
      if (selected.length) {
        window.dispatchEvent(new CustomEvent<ShellPreviewTarget>(SHELL_PREVIEW_OPEN_EVENT, {
          detail: {
            surfaceId: item.id,
            entry: selected.at(-1)!,
            siblings: entries.filter((entry) => !entry.folder),
          },
        }))
      }
      return
    }
    if (shortcutId === 'file.selectAll') {
      event.preventDefault()
      setSelectedPaths(new Set(entries.map((entry) => entry.path)))
      return
    }
    if (shortcutId === 'file.favorite' && selectedPaths.size === 1) {
      const entry = entries.find((candidate) => selectedPaths.has(candidate.path))
      if (entry) { event.preventDefault(); favoritePath(entry) }
      return
    }
    if (shortcutId === 'file.openLocation' && selectedPaths.size === 1) {
      const entry = entries.find((candidate) => selectedPaths.has(candidate.path))
      if (entry) { event.preventDefault(); openEntryLocation(entry) }
      return
    }
    if (isSearchResults) {
      if (shortcutId === 'file.open' && selectedPaths.size === 1) {
        event.preventDefault()
        window.chrome?.webview?.postMessage({ type: 'native-open-path', path: [...selectedPaths][0] })
      }
      return
    }
    if (shortcutId === 'file.copy' || shortcutId === 'file.cut' || shortcutId === 'file.paste') {
      event.preventDefault()
      postNativeExplorerCommand(commandSurfaceId, shortcutId === 'file.copy' ? 'copy' : shortcutId === 'file.cut' ? 'cut' : 'paste')
      return
    }
    if (shortcutId === 'file.delete') { event.preventDefault(); postNativeExplorerCommand(commandSurfaceId, 'delete'); return }
    if (shortcutId === 'file.rename') { event.preventDefault(); beginRename(); return }
    if (shortcutId === 'file.back') { event.preventDefault(); event.stopPropagation(); postNativeExplorerCommand(commandSurfaceId, 'back'); return }
    if (shortcutId === 'file.refresh') { event.preventDefault(); postNativeExplorerCommand(commandSurfaceId, 'reload'); return }
    if (shortcutId === 'file.address') { event.preventDefault(); setAddressEditing(true); return }
    if (shortcutId === 'file.undo') { event.preventDefault(); undoLastFileOperation(); return }
    if (shortcutId === 'file.new') { event.preventDefault(); postFileCommand('new'); return }
    if (shortcutId === 'file.open' && selectedPaths.size === 1) {
      event.preventDefault()
      postNativeExplorerOpen(item.id, [...selectedPaths][0])
    }
  }

  const invokeFileContextAction = (shortcutId: ShortcutId | 'system-menu') => {
    if (!fileContextMenu) return
    const { paths, entry } = fileContextMenu
    setFileContextMenu(null)
    if (paths.length) postNativeExplorerSelection(commandSurfaceId, paths)
    if (shortcutId === 'file.new') postFileCommand('new')
    else if (shortcutId === 'file.cut') postNativeExplorerCommand(commandSurfaceId, 'cut')
    else if (shortcutId === 'file.copy') postNativeExplorerCommand(commandSurfaceId, 'copy')
    else if (shortcutId === 'file.paste') postNativeExplorerCommand(commandSurfaceId, 'paste')
    else if (shortcutId === 'file.rename') beginRename()
    else if (shortcutId === 'file.delete') postNativeExplorerCommand(commandSurfaceId, 'delete')
    else if (shortcutId === 'preview.toggle') previewPaths(paths)
    else if (shortcutId === 'file.favorite' && entry) favoritePath(entry)
    else if (shortcutId === 'file.openLocation' && entry) openEntryLocation(entry)
    else if (shortcutId === 'media.playExternal' && entry) window.chrome?.webview?.postMessage({ type: 'native-open-path', path: entry.path })
    else if (shortcutId === 'archive.openSevenZip' && entry) launchSevenZip(entry.path)
    else if (shortcutId === 'system-menu') invokeContextMenu(paths, fileContextMenu.x + window.screenX, fileContextMenu.y + window.screenY)
  }

  const fileContextRows = fileContextMenu ? ([
    { id: 'file.new', label: '新建文件夹', icon: 'plus', visible: !isSearchResults },
    { id: 'file.cut', label: '剪切', icon: 'cut', visible: fileContextMenu.paths.length > 0 && !isSearchResults },
    { id: 'file.copy', label: '复制', icon: 'copy', visible: fileContextMenu.paths.length > 0 && !isSearchResults },
    { id: 'file.paste', label: '粘贴', icon: 'paste', visible: !isSearchResults },
    { id: 'file.rename', label: '重命名', icon: 'rename', visible: fileContextMenu.paths.length === 1 && !isSearchResults },
    { id: 'file.delete', label: '删除', icon: 'trash', visible: fileContextMenu.paths.length > 0 && !isSearchResults },
    { id: 'preview.toggle', label: '超级预览', icon: 'eye', visible: fileContextMenu.paths.length > 0 },
    { id: 'file.favorite', label: '收藏', icon: 'star', visible: Boolean(fileContextMenu.entry) },
    { id: 'file.openLocation', label: '打开位置', icon: 'folder', visible: Boolean(fileContextMenu.entry) },
    { id: 'media.playExternal', label: '用本地播放器打开', icon: 'file', visible: Boolean(fileContextMenu.entry && !fileContextMenu.entry.folder && MEDIA_EXTENSION_PATTERN.test(fileContextMenu.entry.name)) },
    { id: 'archive.openSevenZip', label: '用 7-Zip 打开', icon: 'archive', visible: Boolean(fileContextMenu.entry && !fileContextMenu.entry.folder && unsupportedArchiveExtension(fileContextMenu.entry.name)) },
  ] as { id: ShortcutId; label: string; icon: string; visible: boolean }[]).filter((row) => row.visible) : []

  const treeStyle = {
    ...(treeWidth ? { '--fm-tree-width': `${treeWidth}px` } : {}),
    ...(treeColumnWidth ? { '--fm-tree-name-width': `${treeColumnWidth}px` } : {}),
  } as CSSProperties

  return <><div ref={shellRef} className="file-manager" style={treeStyle}>
    {isSearchResults ? <div className="fm-command fm-search-summary" role="status">
      <span>{searchBackend === 'everything' ? 'Everything 全盘秒搜' : '当前范围实时搜索'}</span>
      {searchStatus === 'installed-not-running' ? <small>Everything 已安装但未运行</small> : null}
      {searchStatus === 'unavailable' ? <small>Everything 无法通信，已自动降级</small> : null}
    </div> : <div className="fm-command" role="toolbar" aria-label="文件命令">
      <FileNewMenu onCreate={(verb) => postFileCommand(verb)}/>
      <i className="fm-sep" aria-hidden="true"/>
      {FILE_COMMANDS.map((entry) => <span key={entry.name} className="fm-cmd-slot">
        {entry.verb === 'sort' ? <i className="fm-sep" aria-hidden="true"/> : null}
        <button className={(entry.verb === 'file-undo' ? fileUndoDepth === 0 : entry.needsSelection && selectedPaths.size === 0) ? 'is-disabled' : ''} title={entry.verb === 'file-undo' ? (fileUndoDepth ? `${entry.name}（还剩 ${fileUndoDepth} 步）` : '暂无可撤销的文件操作') : entry.needsSelection && selectedPaths.size === 0 ? `${entry.name}（请先选中文件）` : entry.name} aria-label={entry.name} onClick={() => entry.verb === 'file-undo' ? undoLastFileOperation() : entry.verb === 'rename' ? beginRename() : entry.verb === 'view' ? cycleViewMode() : postNativeExplorerCommand(commandSurfaceId, entry.verb)}>{uiIcon(entry.icon, 15)}</button>
      </span>)}
      {showsWorkspaceSplitButtons ? <>
        <i className="fm-sep" aria-hidden="true"/>
        {(['rows', 'columns'] as const).map((orientation) => {
          const label = orientation === 'rows' ? '上下分屏' : '左右分屏'
          return <button
            key={orientation}
            className={toolbarSplitOrientation === orientation ? 'active' : ''}
            title={`${label}（再次点击退出）`}
            aria-label={label}
            aria-pressed={toolbarSplitOrientation === orientation}
            onClick={(event) => {
              event.stopPropagation()
              window.dispatchEvent(new CustomEvent(FILE_WORKSPACE_SPLIT_EVENT, { detail: { itemId: item.id, orientation } }))
            }}
          ><FileToolbarSplitIcon orientation={orientation}/></button>
        })}
      </> : null}
      <span className="fm-spacer"/>
      <button title="更多 · 打开系统右键菜单" aria-label="更多" onClick={(event) => invokeContextMenu([...selectedPaths], event.screenX, event.screenY)}>{uiIcon('more', 15)}</button>
    </div>}

    <FilePathBar
      crumbs={crumbs}
      activePath={activePath}
      drives={archiveLocation ? [] : (treeChildren.get('') ?? [])}
      navigationEnabled={!isSearchResults}
      addressEditing={addressEditing}
      onAddressEditingChange={setAddressEditing}
      onCommand={(command) => postNativeExplorerCommand(commandSurfaceId, command)}
      onNavigate={(path) => postNativeExplorerOpen(item.id, path)}
      mirrorArchive={mirrorArchive}
      searchDefaultValue={isSearchResults ? searchQuery : ''}
      onSearch={(query) => { if (isSearchResults) setSearchQuery(query); else window.dispatchEvent(new CustomEvent('zhangzhongjie-add-search', { detail: { query, root: activePath } })) }}
    />

    <div className="fm-body">
      {copyWatch ? <div className="fm-copy-strip">{uiIcon('refresh', 13)}正在拷贝：缩略图与文件夹体积统计已暂停让路（暂停/取消用系统的复制进度框）</div> : null}
      {!isSearchResults && treeOpen ? <div className="fm-tree-pane"><nav ref={treeRef} className={'fm-tree' + (treeIconSize === 'large' ? ' is-large-icons' : '')} aria-label="导航树" data-surface-id={item.id} tabIndex={0} onKeyDown={(event) => {
        if (shortcutIdForEvent(event.nativeEvent, fileShortcutBindings, ['preview.toggle']) !== 'preview.toggle' || !selectedTreeFile) return
        event.preventDefault(); event.stopPropagation()
        selectTreeFile(selectedTreeFile)
        const siblings = treeFiles().map((entry): ShellEntry => ({ name: entry.name, path: entry.path, typeText: '', modified: entry.modifiedText ?? '', image: entry.image, size: entry.size ?? 0, folder: false, hidden: false, shortcut: false }))
        window.dispatchEvent(new CustomEvent<ShellPreviewTarget>(SHELL_PREVIEW_OPEN_EVENT, { detail: {
          surfaceId: item.id,
          entry: { name: selectedTreeFile.name, path: selectedTreeFile.path, typeText: '', modified: selectedTreeFile.modifiedText ?? '', image: selectedTreeFile.image, size: selectedTreeFile.size ?? 0, folder: false, hidden: false, shortcut: false },
          siblings,
        } }))
      }} onScroll={(event) => { treeScrollTopRef.current = event.currentTarget.scrollTop }} onWheel={stopWheelPropagation}>
        <div className="fm-tree-head" role="row">
          <FileTreeCollapseButton expandedCount={expandedTreePaths.size} onCollapse={collapseTreeBranches}/>
          <button className="fm-tree-icon-size" title={treeIconSize === 'large' ? '切换为小图标' : '切换为大图标'} aria-label="切换目录树图标大小" aria-pressed={treeIconSize === 'large'} onClick={toggleTreeIconSize}>{uiIcon(treeIconSize === 'large' ? 'compact' : 'largeIcons', 13)}</button>
          <button className={treeSortKey === 'name' ? 'active' : ''} onClick={() => changeTreeSort('name')}><span className="fm-tree-column-label">名称{treeSortKey === 'name' ? (treeSortDescending ? ' ↓' : ' ↑') : ''}</span><i
            className="fm-tree-column-resizer"
            role="separator"
            aria-orientation="vertical"
            title="调整名称列宽；双击恢复默认"
            onPointerDown={(event) => {
              event.stopPropagation()
              const header = event.currentTarget.parentElement
              if (!header) return
              const startWidth = header.getBoundingClientRect().width
              treeColumnResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const resize = treeColumnResizeRef.current
              if (!resize || resize.pointerId !== event.pointerId) return
              resize.width = clamp(resize.startWidth + event.clientX - resize.startX, 80, 1200)
              shellRef.current?.style.setProperty('--fm-tree-name-width', `${resize.width}px`)
            }}
            onPointerUp={(event) => {
              const resize = treeColumnResizeRef.current
              if (!resize || resize.pointerId !== event.pointerId) return
              event.preventDefault(); event.stopPropagation()
              treeColumnResizeRef.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              persistTreeColumnWidth(resize.width)
            }}
            onPointerCancel={(event) => {
              if (treeColumnResizeRef.current?.pointerId !== event.pointerId) return
              treeColumnResizeRef.current = null
              if (treeColumnWidth) shellRef.current?.style.setProperty('--fm-tree-name-width', `${treeColumnWidth}px`)
              else shellRef.current?.style.removeProperty('--fm-tree-name-width')
            }}
            onDoubleClick={(event) => {
              event.preventDefault(); event.stopPropagation()
              shellRef.current?.style.removeProperty('--fm-tree-name-width')
              persistTreeColumnWidth(undefined)
            }}
            onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
          /></button>
          <button className={treeSortKey === 'size' ? 'active' : ''} onClick={() => changeTreeSort('size')}><span className="fm-tree-column-label">大小{treeSortKey === 'size' ? (treeSortDescending ? ' ↓' : ' ↑') : ''}</span></button>
        </div>
        <ShellTreeBranch nodes={treeChildren.get('') ?? []} depth={0} expanded={expandedTreePaths} children={treeChildren} activePath={activePath} selectedPath={selectedTreeFile?.path} sortKey={treeSortKey} sortDescending={treeSortDescending} onToggle={toggleTreeNode} onOpen={openTreeNode} onSelectFile={selectTreeFile}/>
        {!treeChildren.has('') ? <small className="fm-tree-note">正在读取本机盘符…</small> : null}
      </nav><i
        className="fm-tree-resizer"
        role="separator"
        aria-orientation="vertical"
        title="调整目录栏宽度；双击恢复默认"
        onPointerDown={(event) => {
          event.preventDefault(); event.stopPropagation()
          const pane = event.currentTarget.parentElement
          if (!pane) return
          const startWidth = pane.getBoundingClientRect().width
          const maxWidth = Math.max(200, (shellRef.current?.getBoundingClientRect().width ?? 0) * .55)
          treeResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, maxWidth, width: startWidth }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const resize = treeResizeRef.current
          if (!resize || resize.pointerId !== event.pointerId) return
          resize.width = clamp(resize.startWidth + event.clientX - resize.startX, 200, resize.maxWidth)
          shellRef.current?.style.setProperty('--fm-tree-width', `${resize.width}px`)
        }}
        onPointerUp={(event) => {
          const resize = treeResizeRef.current
          if (!resize || resize.pointerId !== event.pointerId) return
          event.preventDefault(); event.stopPropagation()
          treeResizeRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          persistTreeWidth(resize.width)
        }}
        onPointerCancel={(event) => {
          if (treeResizeRef.current?.pointerId !== event.pointerId) return
          treeResizeRef.current = null
          if (treeWidth) shellRef.current?.style.setProperty('--fm-tree-width', `${treeWidth}px`)
          else shellRef.current?.style.removeProperty('--fm-tree-width')
        }}
        onDoubleClick={(event) => {
          event.preventDefault(); event.stopPropagation()
          shellRef.current?.style.removeProperty('--fm-tree-width')
          persistTreeWidth(undefined)
        }}
      /></div> : null}
      <div
        ref={listRef}
        className={`fm-view fm-file-area is-${viewMode} ${isSearchResults ? 'is-search-results' : ''}`}
        style={{ '--fm-column-template': columnTemplate } as CSSProperties}
        role="listbox"
        aria-label="文件列表"
        aria-multiselectable="true"
        data-surface-id={item.id}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement
          if (event.button !== 0 || target.closest('.fm-file-entry,button,input,[contenteditable]') || !target.closest('.fm-file-scroll')) return
          event.preventDefault()
          event.stopPropagation()
          const base = event.shiftKey ? new Set(selectedPaths) : new Set<string>()
          fileMarqueeRef.current = { pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, base }
          event.currentTarget.setPointerCapture(event.pointerId)
          const rect = event.currentTarget.getBoundingClientRect()
          setFileMarquee({ x: event.clientX - rect.left, y: event.clientY - rect.top, w: 0, h: 0 })
          if (!event.shiftKey) setSelectedPaths(new Set())
          anchorIndexRef.current = -1
        }}
        onPointerMove={(event) => {
          const marquee = fileMarqueeRef.current
          if (!marquee || marquee.pointerId !== event.pointerId) return
          event.preventDefault()
          const left = Math.min(marquee.sx, event.clientX)
          const top = Math.min(marquee.sy, event.clientY)
          const right = Math.max(marquee.sx, event.clientX)
          const bottom = Math.max(marquee.sy, event.clientY)
          const hostRect = event.currentTarget.getBoundingClientRect()
          setFileMarquee({ x: left - hostRect.left, y: top - hostRect.top, w: right - left, h: bottom - top })
          const next = new Set(marquee.base)
          const marqueeLayout = virtualEnabled ? fileListLayout : null
          if (marqueeLayout) {
            // Only a window of rows lives in the DOM; hit-test the list geometry
            // so a drag can select rows that were never mounted.
            const scrollNode = fileScrollRef.current
            if (scrollNode) {
              const scrollRect = scrollNode.getBoundingClientRect()
              const contentTop = scrollRect.top - scrollNode.scrollTop + marqueeLayout.padTop
              const contentLeft = scrollRect.left + marqueeLayout.padX
              for (let itemIndex = 0; itemIndex < marqueeLayout.items.length; itemIndex++) {
                const item = marqueeLayout.items[itemIndex]
                if (item.kind !== 'entry') continue
                const rowTop = marqueeLayout.mode === 'block'
                  ? contentTop + (marqueeLayout.cum?.[itemIndex] ?? 0)
                  : contentTop + (marqueeLayout.rowOf?.[itemIndex] ?? 0) * (marqueeLayout.rowHeight + marqueeLayout.rowGap)
                const rowBottom = rowTop + marqueeLayout.heights[itemIndex]
                if (rowBottom < top || rowTop > bottom) continue
                if (marqueeLayout.mode === 'grid') {
                  const rowIndex = marqueeLayout.rowOf?.[itemIndex] ?? 0
                  const column = itemIndex - (marqueeLayout.rowStarts[rowIndex] ?? itemIndex)
                  const cellLeft = contentLeft + column * (marqueeLayout.columnWidth + marqueeLayout.columnGap)
                  const cellRight = cellLeft + marqueeLayout.columnWidth
                  if (cellRight < left || cellLeft > right) continue
                }
                next.add(item.entry.path)
              }
            }
          } else {
            for (const element of event.currentTarget.querySelectorAll<HTMLElement>('.fm-file-entry[data-entry-path]')) {
              const rect = element.getBoundingClientRect()
              if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) {
                const path = element.dataset.entryPath
                if (path) next.add(path)
              }
            }
          }
          setSelectedPaths(next)
        }}
        onPointerUp={(event) => {
          const marquee = fileMarqueeRef.current
          if (!marquee || marquee.pointerId !== event.pointerId) return
          event.preventDefault()
          fileMarqueeRef.current = null
          setFileMarquee(null)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={(event) => {
          const marquee = fileMarqueeRef.current
          if (!marquee || marquee.pointerId !== event.pointerId) return
          fileMarqueeRef.current = null
          setFileMarquee(null)
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('.fm-file-entry')) return
          event.preventDefault()
          event.stopPropagation()
          setSelectedPaths(new Set())
          setFileContextMenu({ x: event.clientX, y: event.clientY, paths: [] })
        }}
        onAuxClick={(event) => {
          if (isSearchResults) return
          if (event.button !== 3 && event.button !== 4) return
          event.preventDefault()
          postNativeExplorerCommand(commandSurfaceId, event.button === 3 ? 'back' : 'forward')
        }}
      >
        {fallback ? <NativeSurfaceSlot item={{ ...item, id: legacySurfaceId, source: activePath }}/>
          : isSearchResults ? <div className="fm-list-head fm-search-head" role="row"><span>名称和所在位置</span><span>大小</span></div>
          : viewMode === 'details' ? <div className="fm-list-head" role="row">
            {visibleFileColumns.map((column, columnIndex) => <button key={column} className={fileSortKey === column ? 'active' : ''} data-column={column} onClick={() => {
              if (column === 'name' || column === 'modified' || column === 'type' || column === 'size') changeFileSort(column)
            }}><span className="fm-column-label">{FILE_COLUMN_LABELS[column]}{fileSortKey === column ? (fileSortDescending ? ' ↓' : ' ↑') : ''}</span>{columnIndex < visibleFileColumns.length - 1 ? <i
              className="fm-column-resizer"
              role="separator"
              aria-orientation="vertical"
              title={`调整${FILE_COLUMN_LABELS[column]}列宽；双击自动适应`}
              onPointerDown={(event) => {
                event.preventDefault(); event.stopPropagation()
                const header = event.currentTarget.parentElement
                if (!header) return
                const startWidth = header.getBoundingClientRect().width
                columnResizeRef.current = { pointerId: event.pointerId, column, startX: event.clientX, startWidth, width: startWidth }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const resize = columnResizeRef.current
                if (!resize || resize.pointerId !== event.pointerId || resize.column !== column) return
                const width = clamp(resize.startWidth + event.clientX - resize.startX, column === 'name' ? 140 : 70, 1200)
                resize.width = width
                paintColumnWidth(column, width)
              }}
              onPointerUp={(event) => {
                const resize = columnResizeRef.current
                if (!resize || resize.pointerId !== event.pointerId || resize.column !== column) return
                event.preventDefault(); event.stopPropagation()
                columnResizeRef.current = null
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                persistColumnWidth(column, Math.round(resize.width))
              }}
              onPointerCancel={(event) => {
                const resize = columnResizeRef.current
                if (!resize || resize.pointerId !== event.pointerId) return
                columnResizeRef.current = null
                listRef.current?.style.setProperty('--fm-column-template', columnTemplate)
              }}
              onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); fitColumnToVisibleContent(column) }}
              onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
            /> : null}</button>)}
            <button className={`fm-column-config-toggle ${showColumnPicker ? 'active' : ''}`} title="选择显示列" aria-label="选择显示列" onClick={() => setShowColumnPicker((value) => !value)}>{uiIcon('tiles', 12)}</button>
            {showColumnPicker ? <div className="fm-column-picker" role="menu">
              {(Object.keys(FILE_COLUMN_LABELS) as FileColumnKey[]).map((column) => <label key={column} className={column === 'name' ? 'is-required' : ''}><input type="checkbox" checked={fileColumns.includes(column)} disabled={column === 'name'} onChange={() => toggleFileColumn(column)}/><span>{FILE_COLUMN_LABELS[column]}</span></label>)}
            </div> : null}
          </div> : null}
        <div className="fm-file-scroll" ref={fileScrollRef} onScroll={(event) => { listScrollTopRef.current = event.currentTarget.scrollTop; scheduleVirtualViewport(event.currentTarget) }} onWheel={stopWheelPropagation}>
          {!fallback ? <>
            {virtualEnabled && fileListWindow && fileListWindow.topSpacerHeight > 0 ? <div style={{ height: fileListWindow.topSpacerHeight }} aria-hidden="true"/> : null}
            {virtualEnabled && fileListWindow && fileListWindow.topSpacerRows > 0 ? <div style={{ gridColumn: '1 / -1', gridRow: `span ${fileListWindow.topSpacerRows}` }} aria-hidden="true"/> : null}
            {(virtualEnabled && fileListWindow
              ? fileListItems.slice(fileListWindow.start, fileListWindow.end)
              : fileListItems.slice(0, viewMode === 'media-grid' ? Math.min(fileListItems.length, mediaMountCap) : fileListItems.length)
            ).map((listItem) => {
              if (listItem.kind === 'heading') return <div className="fm-group-heading" key={`fm-heading-${listItem.key}`}><span>{listItem.key}</span><i>{listItem.count}</i></div>
              const entry = listItem.entry
              const index = listItem.index
              const rowActions = entry.path === rowActionsPath && renamingPath !== entry.path ? <span className="fm-row-actions" aria-label={`${entry.name} 快捷操作`}>
                {isSearchResults ? <button type="button" title="打开所在位置" aria-label={`打开 ${entry.name} 所在位置`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); const parent = entry.parentPath || entry.path.replace(/[\\/][^\\/]+$/, ''); if (parent) window.dispatchEvent(new CustomEvent('zhangzhongjie-add-folder', { detail: parent })) }}>{uiIcon('folder', 12)}</button> : FILE_ROW_COMMANDS.map((action) => <button
                  key={action.verb}
                  type="button"
                  title={action.name}
                  aria-label={`${action.name} ${entry.name}`}
                  disabled={action.verb === 'rename' && selectedPaths.has(entry.path) && selectedPaths.size > 1}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); invokeRowCommand(entry, action.verb) }}
                >{uiIcon(action.icon, 12)}</button>)}
              </span> : null
              const anchoredRowActions = rowActions && !isSearchResults && viewMode === 'large-icons' ? <span className="fm-row-actions-anchor">{rowActions}</span> : null
              return <div
            key={entry.path || `${entry.name}-${index}`}
            className={`fm-file-entry ${selectedPaths.has(entry.path) ? 'is-selected' : ''} ${entry.hidden ? 'is-hidden' : ''} ${renamingPath === entry.path ? 'is-renaming' : ''} ${entry.path === rowActionsPath && index === 0 ? 'is-row-actions-below' : ''}`}
            style={entry.path === rowActionsPath && rowActionsX !== null ? { '--fm-pill-x': `${rowActionsX}px` } as CSSProperties : undefined}
            data-entry-path={entry.path}
            role="option"
            aria-selected={selectedPaths.has(entry.path)}
            title={entry.path}
            draggable={false}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.stopPropagation()
              const paths = selectedPaths.has(entry.path) ? [...selectedPaths] : [entry.path]
              if (!selectedPaths.has(entry.path) && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                setSelectedPaths(new Set([entry.path]))
              }
              window.chrome?.webview?.postMessage({ type: 'native-drag-arm-files', paths })
            }}
            onPointerUp={() => window.chrome?.webview?.postMessage({ type: 'native-drag-disarm' })}
            onPointerCancel={() => window.chrome?.webview?.postMessage({ type: 'native-drag-disarm' })}
            onClick={(event) => {
              event.stopPropagation()
              const rowBounds = event.currentTarget.getBoundingClientRect()
              const rowScale = rowBounds.width / Math.max(event.currentTarget.offsetWidth, 1)
              setRowActionsX(Math.max(0, Math.min(event.currentTarget.offsetWidth, (event.clientX - rowBounds.left) / rowScale)))
              selectEntry(entry, index, event.shiftKey, event.ctrlKey || event.metaKey)
              listRef.current?.focus()
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              const unsupportedArchive = entry.folder ? '' : unsupportedArchiveExtension(entry.path)
              if (unsupportedArchive) {
                // 卡内浏览：rar/7z 等由原生调 7-Zip 解压到只读镜像，再交给同一张卡片。
                notifyUnsupportedArchive(entry.path)
                if (isSearchResults) window.chrome?.webview?.postMessage({ type: 'native-open-path', path: entry.path })
                else postNativeExplorerOpen(item.id, entry.path)
                return
              }
              notifyUnsupportedArchive(entry.path)
              if (isSearchResults && entry.folder) window.dispatchEvent(new CustomEvent('zhangzhongjie-add-folder', { detail: entry.path }))
              else if (isSearchResults) window.chrome?.webview?.postMessage({ type: 'native-open-path', path: entry.path })
              else postNativeExplorerOpen(item.id, entry.path)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const paths = selectedPaths.has(entry.path) ? [...selectedPaths] : [entry.path]
              if (!selectedPaths.has(entry.path)) setSelectedPaths(new Set([entry.path]))
              setFileContextMenu({ x: event.clientX, y: event.clientY, paths, entry })
            }}
          >
            {isSearchResults ? <span className="fm-file-name fm-search-result-name" data-column="name">
              {fileIconMode === 'system' && entry.image ? <img src={entry.image} alt="" draggable={false} onError={() => handleRowImageError(entry.path)}/> : uiIcon(entry.folder ? 'folder' : 'file', 34)}
              <span className="fm-search-result-text"><b><HighlightedFileName name={entry.name} query={searchQuery}/></b><small>{entry.parentPath || entry.path}</small></span>
            </span> : viewMode === 'media-grid' ? <div className="fm-media-card">
              <span
                className="fm-media-frame"
                style={{ aspectRatio: entry.width && entry.height ? `${entry.width} / ${entry.height}` : entry.folder ? '4 / 3' : '3 / 2' }}
                onPointerEnter={() => { if (PLAYABLE_MEDIA_EXTENSION.test(entry.path)) publishMediaHover(item.id, entry.path) }}
                onPointerLeave={() => clearMediaHover(item.id, entry.path)}
              >{playingVideoPath === entry.path && mediaBaseUrl
                  ? <HoverMediaVideo resource={`${mediaBaseUrl}${encodeURIComponent(entry.path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? entry.name)}`} poster={entry.image} muted={mediaMuted} playbackRate={mediaPlaybackRate}/>
                  : <LazyShellThumbnail entry={entry} onNearViewport={updateThumbnailVisibility} useSystemIcon={fileIconMode === 'system'}/>}
                {entry.durationMs ? <i className="fm-media-duration">{formatMediaDuration(entry.durationMs)}</i> : null}
              </span>
              <span className="fm-media-caption">{renamingPath === entry.path
                ? <input className={`fm-rename-input ${renameError ? 'is-error' : ''}`} value={renameDraft} autoFocus onFocus={(event) => selectRenameBasename(event.currentTarget)} onChange={(event) => setRenameDraft(event.target.value)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onBlur={() => finishRename(true, 'blur')} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishRename(true, 'enter') } else if (event.key === 'Escape') { event.preventDefault(); finishRename(false) } }}/>
                : <b>{entry.name}</b>}<small>{entry.folder ? [entry.typeText, entry.folderSize === undefined ? '—' : formatShellSize(entry.folderSize)].join(' | ') : [formatShellSize(entry.size), entry.width && entry.height ? `${entry.width} × ${entry.height}` : '—'].join(' | ')}</small></span>
            </div> : <span className="fm-file-name" data-column="name">{viewMode === 'large-icons'
              ? <LazyShellThumbnail entry={entry} onNearViewport={updateThumbnailVisibility} useSystemIcon={fileIconMode === 'system'}/>
              : fileIconMode === 'system' && entry.image ? <img src={entry.image} alt="" draggable={false} onError={() => handleRowImageError(entry.path)}/> : uiIcon(entry.folder ? 'folder' : 'file', 34)}{renamingPath === entry.path
              ? <input className={`fm-rename-input ${renameError ? 'is-error' : ''}`} value={renameDraft} autoFocus onFocus={(event) => selectRenameBasename(event.currentTarget)} onChange={(event) => setRenameDraft(event.target.value)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onBlur={() => finishRename(true, 'blur')} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishRename(true, 'enter') } else if (event.key === 'Escape') { event.preventDefault(); finishRename(false) } }}/>
              : <b>{entry.name}</b>}{entry.shortcut ? <i className="fm-shortcut">↗</i> : null}{anchoredRowActions}</span>}
            {isSearchResults ? <span data-column="size">{entry.folder ? '—' : formatShellSize(entry.size)}</span>
              : viewMode === 'details' ? <>{visibleFileColumns.slice(1).map((column) => <span key={column} data-column={column}>{column === 'modified' ? entry.modified
              : column === 'type' ? entry.typeText
              : column === 'dimensions' ? (entry.width && entry.height ? `${entry.width} × ${entry.height}` : '—')
              : column === 'duration' ? (formatMediaDuration(entry.durationMs) || '—')
              : entry.folder ? (entry.folderSize === undefined ? '—' : formatShellSize(entry.folderSize)) : formatShellSize(entry.size)}</span>)}</> : null}
            {viewMode !== 'details' && viewMode !== 'media-grid' ? <small className="fm-entry-meta">{entry.folder ? [entry.typeText, entry.folderSize === undefined ? '—' : formatShellSize(entry.folderSize)].join(' · ') : [entry.typeText, formatShellSize(entry.size)].filter(Boolean).join(' · ')}</small> : null}
            {viewMode !== 'media-grid' && (isSearchResults || viewMode !== 'large-icons') ? rowActions : null}
            {viewMode === 'media-grid' ? rowActions : null}
          </div>
            })}
          {virtualEnabled && fileListWindow && fileListWindow.bottomSpacerRows > 0 ? <div style={{ gridColumn: '1 / -1', gridRow: `span ${fileListWindow.bottomSpacerRows}` }} aria-hidden="true"/> : null}
            {virtualEnabled && fileListWindow && fileListWindow.bottomSpacerHeight > 0 ? <div style={{ height: fileListWindow.bottomSpacerHeight }} aria-hidden="true"/> : null}
          </> : null}
          {!fallback && loading && entries.length === 0 ? <div className="fm-empty-state"><i className="fm-loading-dot"/><span>{isSearchResults ? `正在搜索“${searchQuery}”…` : '正在读取 Windows 文件信息…'}</span></div> : null}
          {!fallback && !loading && entries.length === 0 ? <div className="fm-empty-state"><span>{loadError || (isSearchResults ? `没有找到“${searchQuery}”` : window.chrome?.webview ? '此位置没有可显示的项目' : '请在掌中界 Windows 程序中打开文件管理器')}</span></div> : null}
        </div>
        {fileMarquee ? <div className="fm-selection-marquee" style={{ left: fileMarquee.x, top: fileMarquee.y, width: fileMarquee.w, height: fileMarquee.h }}/> : null}
      </div>
    </div>

    <div className="fm-status">
      <FileTreeVisibilityButton open={treeOpen} className="fm-tree-toggle" onToggle={toggleTreeVisibility}/>
      <span>{entries.length} 个项目{selectedPaths.size > 0 ? `　|　选中 ${selectedPaths.size} 项` : ''}{loading && entries.length > 0 ? '　|　正在读取…' : ''}</span>
      <span className="fm-spacer"/>
      {viewMode === 'media-grid' ? <span className="fm-media-controls" role="group" aria-label="媒体预览播放设置">
        <button className={mediaMuted ? 'active' : ''} title={mediaMuted ? '媒体预览已静音' : '媒体预览声音已开启'} aria-label={mediaMuted ? '取消媒体预览静音' : '静音媒体预览'} onClick={() => publishSettingsPatch({ mediaMuted: !mediaMuted })}>{uiIcon(mediaMuted ? 'mute' : 'volume', 13)}</button>
        <button className="fm-playback-rate" title="切换悬停播放倍速" onClick={cycleMediaPlaybackRate}>{mediaPlaybackRate.toFixed(1)}x</button>
      </span> : null}
      {([['details', 'listView', '详细信息'], ['large-icons', 'largeIcons', '大图标'], ['media-grid', 'mediaGrid', '媒体网格'], ['compact', 'compact', '紧凑列表']] as const).map(([mode, icon, label]) => <button key={mode} className={viewMode === mode ? 'active' : ''} title={`${label}视图`} aria-label={`${label}视图`} onClick={() => selectViewMode(mode)}>{uiIcon(icon, 13)}</button>)}
      <span className="fm-view-more">
        <button className={showViewMenu ? 'active' : ''} title="更多视图" aria-label="更多视图" aria-expanded={showViewMenu} onClick={() => setShowViewMenu((value) => !value)}>{uiIcon('view', 13)}</button>
        {showViewMenu ? <div className="fm-view-menu" role="menu">
          {([['details', '详细信息'], ['large-icons', '大图标'], ['media-grid', '媒体网格'], ['compact', '紧凑列表']] as const).map(([mode, label]) => <button key={mode} className={viewMode === mode ? 'active' : ''} role="menuitemradio" aria-checked={viewMode === mode} onClick={() => selectViewMode(mode)}><span>{viewMode === mode ? '✓' : ''}</span>{label}</button>)}
          <i className="canvas-menu-sep"/>
          <button role="menuitemcheckbox" aria-checked={groupByName} className={groupByName ? 'active' : ''} onClick={() => { const next = !groupByName; setGroupByName(next); publishSettingsPatch({ fileGroupByName: next }) }}><span>{groupByName ? '✓' : ''}</span>按名称分组</button>
        </div> : null}
      </span>
    </div>
  </div>{fileContextMenu ? createPortal(<CanvasMenu x={fileContextMenu.x} y={fileContextMenu.y} onPointerDown={(event) => event.stopPropagation()}>
    <div className="fm-file-context-menu">
      <div className="canvas-menu-title">{fileContextMenu.entry?.name || activePath}</div>
      {fileContextRows.map((row) => <button key={row.id} role="menuitem" onClick={() => invokeFileContextAction(row.id)}>{uiIcon(row.icon, 14)}<span>{row.label}</span>{shortcutDisplay(fileShortcutBindings, row.id) !== '未设置' ? <kbd>{shortcutDisplay(fileShortcutBindings, row.id)}</kbd> : null}</button>)}
      <i className="canvas-menu-sep"/>
      <button role="menuitem" onClick={() => invokeFileContextAction('system-menu')}>{uiIcon('more', 14)}<span>更多系统选项</span></button>
      {(() => {
        const imagePath = fileContextMenu.entry && !fileContextMenu.entry.folder && IMAGE_FILE_PATTERN.test(fileContextMenu.entry.name) ? fileContextMenu.entry.path : ''
        return imagePath ? <button role="menuitem" onClick={() => { const at = fileContextMenu; setFileContextMenu(null); requestImageActionMenu(imagePath, { x: at.x, y: at.y }) }}>{uiIcon('eye', 14)}<span>读图 / 取字…</span></button> : null
      })()}
    </div>
  </CanvasMenu>, previewOverlayRoot()) : null}</>
})

function ItemBody({ item, audible, paintOrder = 0 }: { item: CanvasItem; audible: boolean; paintOrder?: number }) {
  if (item.kind === 'web') return <BrowserCardBody item={item} paintOrder={paintOrder}/>
  if (item.kind === 'video') return <BrowserCardBody item={item} paintOrder={paintOrder}/>
  if (item.kind === 'folder') return <FileManagerPane item={item}/>
  if (item.kind === 'shellview') return <NativeSurfaceSlot item={item} paintOrder={paintOrder}/>
  if (item.kind === 'portal') return <PortalBody item={item}/>
  if (item.kind === 'note') return item.todo ? <TodoBody item={item}/> : <NoteBody item={item}/>
  if (item.kind === 'shelf') return <ShelfBody item={item}/>
  if (item.kind === 'image') return <ImageBody item={item}/>
  if (item.kind === 'app') return <AppCardBody item={item}/>
  if (item.kind === 'desktop') return <DesktopCardBody item={item}/>
  if (item.kind === 'icon') return <LauncherIconBody item={item}/>
  if (item.kind === 'reference' && item.source) return <FileRefBody item={item} paintOrder={paintOrder}/>
  return <ReferenceBody/>
}

const CanvasSnapshot = memo(function CanvasSnapshot({ canvas, items }: { canvas: SpaceCanvas; items: CanvasItem[] }) {
  const visibleItems = items.filter((item) => item.canvasId === canvas.id).slice(0, 9)
  return <div className="canvas-snapshot" data-silent-canvas={canvas.id} aria-label={`${canvas.title} 静默缩略图`}>
    <div className="snapshot-glow"/>
    <div className="snapshot-grid">{visibleItems.map((item, index) => <span className={`snapshot-tile tile-${item.kind}`} key={item.id} style={{ '--tile-index': index } as CSSProperties}><i>{item.kind === 'folder' ? '▰' : item.kind === 'video' ? '▶' : item.kind === 'reference' ? '▧' : item.kind === 'note' ? '≡' : item.kind === 'portal' ? '◈' : '◎'}</i><b>{item.title}</b></span>)}</div>
    <span className="snapshot-level">L{canvas.level}</span>
  </div>
})

type WindowProps = {
  item: CanvasItem
  paintOrder?: number
  selected: boolean
  audible: boolean
  snapTarget: boolean
  dragging?: boolean
  fusionSource?: boolean
  silent?: boolean
  hidePin?: boolean
  focusHidden?: boolean
  cardTitlebarVisibility: CardTitlebarVisibility
  children?: ReactNode
  onPointerDown: (event: ReactPointerEvent, item: CanvasItem) => void
  onResizeDown: (event: ReactPointerEvent, item: CanvasItem) => void
  onPin: (item: CanvasItem) => void
  onClose: (item: CanvasItem) => void
  onActivate: (item: CanvasItem) => void
  onDoubleClick: (item: CanvasItem) => void
  onToggleWorkspaceFocus: (item: CanvasItem) => void
  onExitSplit?: (item: CanvasItem) => void
  onWake?: () => void
  onIdle?: () => void
  elementRegistry?: MutableRefObject<Map<string, HTMLElement>>
}

const CanvasWindow = memo(function CanvasWindow({ item, paintOrder = 0, selected, audible, snapTarget, dragging, fusionSource, silent, hidePin, focusHidden, cardTitlebarVisibility, children, onPointerDown, onResizeDown, onPin, onClose, onActivate, onDoubleClick, onToggleWorkspaceFocus, onExitSplit, onWake, onIdle, elementRegistry }: WindowProps) {
  const style: CSSProperties = item.pinned
    ? { left: item.pinX, top: item.pinY, width: item.cardMinimized ? 230 : item.pinW ?? item.w, height: item.cardMinimized ? 42 : item.pinH ?? item.h }
    : { left: item.x, top: item.y, width: item.cardMinimized ? 230 : item.w, height: item.cardMinimized ? 42 : item.h }
  const titlebarRef = useRef<HTMLElement | null>(null)
  const [pointerHovered, setPointerHovered] = useState(false)
  const [nativeHovered, setNativeHovered] = useState(false)
  const initiallyVisible = cardTitlebarVisibility === 'always' || selected || Boolean(dragging)
  const [titleClipActive, setTitleClipActive] = useState(initiallyVisible)
  const [titleVisualVisible, setTitleVisualVisible] = useState(initiallyVisible)
  const hideTimerRef = useRef<number | null>(null)
  const clipReleaseTimerRef = useRef<number | null>(null)
  const revealFrameRef = useRef<number | null>(null)
  const revealSecondFrameRef = useRef<number | null>(null)
  const shouldShowTitlebar = Boolean(item.cardMinimized) || cardTitlebarVisibility === 'always' || selected || Boolean(dragging) || pointerHovered || nativeHovered
  const controlsVisible = selected || Boolean(dragging) || pointerHovered || nativeHovered

  useEffect(() => {
    const onNativeHover = (event: Event) => {
      const hoveredItemId = (event as CustomEvent<{ itemId?: string | null }>).detail?.itemId ?? null
      setNativeHovered((current) => {
        const next = hoveredItemId === item.id
        return current === next ? current : next
      })
    }
    window.addEventListener(NATIVE_SURFACE_HOVER_EVENT, onNativeHover)
    return () => window.removeEventListener(NATIVE_SURFACE_HOVER_EVENT, onNativeHover)
  }, [item.id])

  useEffect(() => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    if (clipReleaseTimerRef.current !== null) window.clearTimeout(clipReleaseTimerRef.current)
    if (revealFrameRef.current !== null) window.cancelAnimationFrame(revealFrameRef.current)
    if (revealSecondFrameRef.current !== null) window.cancelAnimationFrame(revealSecondFrameRef.current)
    hideTimerRef.current = null
    clipReleaseTimerRef.current = null
    revealFrameRef.current = null
    revealSecondFrameRef.current = null
    if (shouldShowTitlebar) {
      // Shrink the owning native surface first. The DOM titlebar appears two
      // compositor frames later, after HWND and DComp clips have caught up.
      setTitleClipActive(true)
      revealFrameRef.current = window.requestAnimationFrame(() => {
        revealSecondFrameRef.current = window.requestAnimationFrame(() => setTitleVisualVisible(true))
      })
    } else {
      hideTimerRef.current = window.setTimeout(() => {
        setTitleVisualVisible(false)
        clipReleaseTimerRef.current = window.setTimeout(() => setTitleClipActive(false), 190)
      }, 480)
    }
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
      if (clipReleaseTimerRef.current !== null) window.clearTimeout(clipReleaseTimerRef.current)
      if (revealFrameRef.current !== null) window.cancelAnimationFrame(revealFrameRef.current)
      if (revealSecondFrameRef.current !== null) window.cancelAnimationFrame(revealSecondFrameRef.current)
    }
  }, [shouldShowTitlebar])

  useLayoutEffect(() => {
    const height = titlebarRef.current?.offsetHeight ?? 0
    const previous = nativeCardOcclusionHeights.get(item.id)
    if (titleClipActive && height > 0) nativeCardOcclusionHeights.set(item.id, height)
    else nativeCardOcclusionHeights.delete(item.id)
    const next = nativeCardOcclusionHeights.get(item.id)
    if (previous !== next) window.dispatchEvent(new Event(SURFACE_OCCLUSION_EVENT))
  }, [item.id, item.kind, item.cardMinimized, titleClipActive])

  useEffect(() => () => {
    if (nativeCardOcclusionHeights.delete(item.id)) window.dispatchEvent(new Event(SURFACE_OCCLUSION_EVENT))
  }, [item.id])

  const registerElement = useCallback((element: HTMLElement | null) => {
    if (!elementRegistry || !element) return
    elementRegistry.current.set(item.id, element)
    return () => {
      if (elementRegistry.current.get(item.id) === element) elementRegistry.current.delete(item.id)
    }
  }, [elementRegistry, item.id])
  return <section ref={registerElement} className={`canvas-item kind-${item.kind} ${selected ? 'selected' : ''} ${item.pinned ? 'is-pinned' : ''} ${item.cardMinimized ? 'card-minimized' : ''} ${snapTarget ? 'snap-target' : ''} ${dragging ? 'is-dragging' : ''} ${fusionSource ? 'fusion-source' : ''} ${silent ? 'silent-workspace' : ''} ${focusHidden ? 'focus-source-hidden' : ''} ${titleVisualVisible ? 'titlebar-visible' : ''} ${controlsVisible ? 'card-controls-visible' : ''} ${item.immersive ? 'is-immersive' : ''} ${item.pipHidden ? 'card-pip-hidden' : ''}`} style={style} data-item-id={item.id} onPointerEnter={() => { setPointerHovered(true); onWake?.() }} onPointerLeave={() => { setPointerHovered(false); onIdle?.() }} onClick={(event) => { if (item.cardMinimized && !(event.target as HTMLElement).closest('button')) window.dispatchEvent(new CustomEvent('zhangzhongjie-toggle-card', { detail: item.id })) }} onPointerDown={(event) => { onWake?.(); onActivate(item); if (!silent) onPointerDown(event, item) }}>
    {silent ? <span className="canvas-wake-zone" aria-hidden="true"/> : null}
    {item.immersive ? <div
      className="immersive-exit-strip"
      title="纯画面（桌布）模式：双击这里退出，按 Esc 也可以"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent('zhangzhongjie-toggle-immersive', { detail: { itemId: item.id, value: false } })) }}
    ><span>双击退出纯画面 · Esc</span></div> : null}
    <header
      ref={titlebarRef}
      className="window-titlebar"
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); window.dispatchEvent(new CustomEvent('zhangzhongjie-titlebar-menu', { detail: { itemId: item.id, clientX: event.clientX, clientY: event.clientY } })) }}
      onPointerEnter={() => setPointerHovered(true)}
      title={item.kind === 'workspace' || item.kind === 'folder' || item.kind === 'web' || item.kind === 'video' ? '拖动标题栏移动，双击最大化并可分屏，Ctrl+拖动复制一份' : 'Shift+拖动标题栏可复制出一个独立副本'}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (item.kind === 'workspace' || item.kind === 'folder' || item.kind === 'web' || item.kind === 'video') onToggleWorkspaceFocus(item)
        else onDoubleClick(item)
      }}
    ><span className="window-kind">{item.kind === 'folder' ? uiIcon('folder', 15) : item.kind === 'workspace' ? '▣' : item.kind === 'portal' ? '◈' : item.kind === 'reference' ? '▧' : '◎'}</span><strong>{item.title}</strong>{item.kind === 'workspace' || item.kind === 'folder' || item.kind === 'web' || item.kind === 'video' ? <span className="canvas-window-tag">双击最大化</span> : null}<span className="window-spacer"/>{item.kind === 'video' || item.kind === 'web' ? <span className="audio-pill">{audible ? '当前发声' : '已静音'}</span> : null}{item.workspaceSplit && onExitSplit ? <button title="退出分屏" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onExitSplit(item) }}>{uiIcon('split', 15)}</button> : null}{hidePin ? null : <button className={item.pinned ? 'active' : ''} title={item.pinned ? '取消置顶' : '弹出并置顶'} onPointerDown={(event) => event.stopPropagation()} onClick={() => onPin(item)}>{uiIcon('pin', 15)}</button>}<button title={item.cardMinimized ? '恢复卡片' : '最小卡片化'} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent('zhangzhongjie-toggle-card', { detail: item.id })) }}>{uiIcon('card', 15)}</button><button title="关闭" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClose(item) }}>{uiIcon('close', 15)}</button></header>
    {/* 最大化时这份窗口只是留个占位，绝不能再挂一个同 surfaceId 的原生 slot，
        否则两份会互相抢几何，还原时还会把对方的实例一起拆掉。 */}
    <div className="window-body">{focusHidden ? null : children ?? <ItemBody item={item} audible={audible} paintOrder={paintOrder}/>}</div>
    {!item.pinned && !item.cardMinimized && item.kind !== 'icon' ? <button className="resize-handle" aria-label="调整大小" onPointerEnter={() => setPointerHovered(true)} onPointerLeave={() => setPointerHovered(false)} onPointerDown={(event) => onResizeDown(event, item)}/> : null}
  </section>
})

function SplitSecondaryPane({ paneId, kind, source, treeOpen, onChoose, onSource }: { paneId: string; kind: WorkspacePaneKind; source?: string; treeOpen?: boolean; onChoose: (kind: WorkspacePaneKind) => void; onSource: (source: string) => void }) {
  const [draft, setDraft] = useState(source ?? '')
  useEffect(() => { setDraft(source ?? '') }, [source])

  // 分屏视口里放的必须是真实窗口：文件夹给真的 Shell 文件视图，网页给真的
  // WebView2。之前这里渲染的是模拟视频卡和模拟文件列表，纯占位。
  if (kind === 'folder' || kind === 'web') {
    // surfaceId 必须每个视口唯一。之前写死成 `pane-<kind>-source`，两个同类型
    // 视口就会撞同一个 id：宿主一个 id 只保留一个窗口，两个 slot 各自按自己的
    // 位置推几何，最后写的赢，于是那个原生窗口会飘到别处去，还跟着画布缩放。
    const surfaceItem = { id: `pane-${paneId}-${kind}`, kind, title: kind === 'web' ? '网页' : '文件夹', source, fileTreeOpen: treeOpen } as unknown as CanvasItem
    const commit = () => {
      const value = draft.trim()
      if (!value) return
      onSource(value)
    }
    if (kind === 'web') return <div className="pane-surface"><BrowserCardBody item={surfaceItem} onNavigate={onSource}/></div>
    return <div className="pane-surface">
      <header className="pane-address">
        <button title="更换内容" onClick={() => onChoose('chooser')}>{uiIcon('folder', 13)}</button>
        <input value={draft} placeholder="输入路径后回车，例如 D:\\项目" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }}/>
      </header>
      <div className="pane-surface-body"><FileManagerPane item={surfaceItem}/></div>
    </div>
  }

  // 交接文档实测反馈：这里只需要「文件夹」和「网页」两个选项。
  return <div className="split-content-chooser"><header><b>选择打开内容</b><small>新区域保持静音，点击内容后再激活</small></header><div>{([['folder', '▰', '文件夹'], ['web', '◎', '网页']] as [WorkspacePaneKind, string, string][]).map(([value, icon, label]) => <button key={value} onClick={() => onChoose(value)}><span>{icon}</span><b>{label}</b></button>)}</div></div>
}

const PRIMARY_LEAF_ID = 'primary'
const SPLIT_SNAP_POINTS = [.25, .5, .75]
const newSplitId = () => `split-${Math.random().toString(36).slice(2, 9)}`
const primaryLeaf = (): SplitLeafNode => ({ type: 'leaf', id: PRIMARY_LEAF_ID, kind: 'canvas' })

// 旧存档里是 { orientation, secondarySide, primaryRatio, secondaryKind } 的单层
// 结构，读到就当作没有分屏，避免打开老项目直接崩在渲染里。
function normalizeSplit(value: SplitNode | undefined): SplitNode {
  if (!value || (value.type !== 'leaf' && value.type !== 'branch')) return primaryLeaf()
  return value
}

function replaceSplitNode(root: SplitNode, id: string, next: SplitNode): SplitNode {
  if (root.id === id) return next
  if (root.type !== 'branch') return root
  return { ...root, first: replaceSplitNode(root.first, id, next), second: replaceSplitNode(root.second, id, next) }
}

function updateSplitFilePanelState(root: SplitNode, paneId: string, patch: { source?: string; treeOpen?: boolean }): SplitNode {
  if (root.type === 'leaf') {
    if (root.id !== paneId || root.kind !== 'folder') return root
    const sourceChanged = typeof patch.source === 'string' && patch.source !== root.source
    const treeChanged = typeof patch.treeOpen === 'boolean' && patch.treeOpen !== root.treeOpen
    if (!sourceChanged && !treeChanged) return root
    return {
      ...root,
      ...(sourceChanged ? { source: patch.source } : {}),
      ...(treeChanged ? { treeOpen: patch.treeOpen } : {}),
    }
  }
  const first = updateSplitFilePanelState(root.first, paneId, patch)
  const second = updateSplitFilePanelState(root.second, paneId, patch)
  return first === root.first && second === root.second ? root : { ...root, first, second }
}

// 关掉一个叶子后父分支自动折叠，剩下的兄弟视口填满原来的空间。
function removeSplitNode(root: SplitNode, id: string): SplitNode {
  if (root.type !== 'branch') return root
  if (root.first.id === id) return root.second
  if (root.second.id === id) return root.first
  return { ...root, first: removeSplitNode(root.first, id), second: removeSplitNode(root.second, id) }
}

function splitLeafByEdge(leaf: SplitNode, edge: SplitEdge, fraction: number): SplitBranchNode {
  const orientation: 'columns' | 'rows' = edge === 'left' || edge === 'right' ? 'columns' : 'rows'
  const fresh: SplitLeafNode = { type: 'leaf', id: newSplitId(), kind: 'chooser' }
  const freshFirst = edge === 'left' || edge === 'top'
  return { type: 'branch', id: newSplitId(), orientation, ratio: freshFirst ? fraction : 1 - fraction, first: freshFirst ? fresh : leaf, second: freshFirst ? leaf : fresh }
}

function countLeaves(node: SplitNode): number {
  return node.type === 'leaf' ? 1 : countLeaves(node.first) + countLeaves(node.second)
}

// interactive 只在「子画布最大化」状态下为 true。交接文档 §7：分屏只存在于
// 最大化状态，未最大化的子画布要保留已经分好的布局，但不得显示分屏入口
// 或边缘热区——否则那些边线手柄会跟着回到画布上，表现为窗口顶部卡着一条
// 蓝色横条。
type SplitViewProps = { node: SplitNode; root: SplitNode; primary: ReactNode; interactive: boolean; resizable: boolean; splitActive: boolean; onChange: (next: SplitNode | undefined) => void; onPushHistory: () => void }

function SplitBranchView({ node, root, primary, interactive, resizable, splitActive, onChange, onPushHistory }: SplitViewProps & { node: SplitBranchNode }) {
  const branchRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const horizontal = node.orientation === 'columns'

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!draggingRef.current) return
      const rect = branchRef.current?.getBoundingClientRect()
      if (!rect) return
      const raw = horizontal ? (event.clientX - rect.left) / Math.max(rect.width, 1) : (event.clientY - rect.top) / Math.max(rect.height, 1)
      // 交接文档 23.4：25% / 50% / 75% 三个磁吸点，离开范围恢复自由拖动。
      const snapped = SPLIT_SNAP_POINTS.find((point) => Math.abs(raw - point) < .025)
      onChange(replaceSplitNode(root, node.id, { ...node, ratio: clamp(snapped ?? raw, .12, .88) }))
    }
    const up = () => { draggingRef.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [horizontal, node, onChange, root])

  return <div ref={branchRef} className={`split-branch ${horizontal ? 'is-columns' : 'is-rows'}`}>
    <div className="split-slot" style={{ flexGrow: node.ratio }}><SplitNodeView node={node.first} root={root} primary={primary} interactive={interactive} resizable={resizable} splitActive={splitActive} onChange={onChange} onPushHistory={onPushHistory}/></div>
    {resizable
      ? <button className={`split-handle ${horizontal ? 'handle-columns' : 'handle-rows'}`} aria-label={horizontal ? '调整左右比例' : '调整上下比例'} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onPushHistory(); draggingRef.current = true }}><i/></button>
      : <div className={`split-seam ${horizontal ? 'handle-columns' : 'handle-rows'}`} aria-hidden="true"/>}
    <div className="split-slot" style={{ flexGrow: 1 - node.ratio }}><SplitNodeView node={node.second} root={root} primary={primary} interactive={interactive} resizable={resizable} splitActive={splitActive} onChange={onChange} onPushHistory={onPushHistory}/></div>
  </div>
}

function SplitLeafView({ node, root, primary, interactive, splitActive, onChange, onPushHistory }: SplitViewProps & { node: SplitLeafNode }) {
  const leafRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ edge: SplitEdge; fraction: number; ready: boolean } | null>(null)
  const [preview, setPreview] = useState<{ edge: SplitEdge; fraction: number; ready: boolean } | null>(null)

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      const rect = leafRef.current?.getBoundingClientRect()
      if (!drag || !rect) return
      const distance = drag.edge === 'left' ? event.clientX - rect.left : drag.edge === 'right' ? rect.right - event.clientX : drag.edge === 'top' ? event.clientY - rect.top : rect.bottom - event.clientY
      const span = drag.edge === 'left' || drag.edge === 'right' ? rect.width : rect.height
      const next = { edge: drag.edge, fraction: clamp(distance / Math.max(span, 1), .12, .78), ready: distance >= 44 }
      dragRef.current = next
      setPreview(next)
    }
    const up = () => {
      const drag = dragRef.current
      dragRef.current = null
      setPreview(null)
      if (!drag?.ready) return
      onPushHistory()
      onChange(replaceSplitNode(root, node.id, splitLeafByEdge(node, drag.edge, drag.fraction)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [node, onChange, onPushHistory, root])

  const previewStyle: CSSProperties | undefined = preview ? preview.edge === 'left'
    ? { left: 0, top: 0, bottom: 0, width: `${preview.fraction * 100}%` }
    : preview.edge === 'right'
      ? { right: 0, top: 0, bottom: 0, width: `${preview.fraction * 100}%` }
      : preview.edge === 'top'
        ? { left: 0, right: 0, top: 0, height: `${preview.fraction * 100}%` }
        : { left: 0, right: 0, bottom: 0, height: `${preview.fraction * 100}%` } : undefined

  return <div ref={leafRef} className={`split-leaf ${node.kind === 'canvas' ? 'is-primary' : ''}`}>
    <div className="split-leaf-body">{node.kind === 'canvas' ? primary : <SplitSecondaryPane paneId={node.id} kind={node.kind} source={node.source} treeOpen={node.treeOpen} onChoose={(kind) => onChange(replaceSplitNode(root, node.id, { ...node, kind, source: kind === 'web' ? 'https://www.google.com' : kind === 'folder' ? 'shell:MyComputerFolder' : undefined }))} onSource={(source) => onChange(replaceSplitNode(root, node.id, { ...node, source }))}/>}</div>
    {interactive ? (['left', 'right', 'top', 'bottom'] as SplitEdge[]).map((edge) => <button key={edge} className={`split-edge-handle edge-${edge}`} aria-label={`从${edge === 'left' ? '左' : edge === 'right' ? '右' : edge === 'top' ? '上' : '下'}边向内拖动继续分屏`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); dragRef.current = { edge, fraction: 0, ready: false }; setPreview({ edge, fraction: 0, ready: false }) }}><i/></button>) : null}
    {interactive && splitActive ? <button className="split-leaf-close" title={countLeaves(root) > 1 ? '关闭这个视口' : '退出分屏'} onPointerDown={(event) => event.stopPropagation()} onClick={() => { onPushHistory(); onChange(countLeaves(root) > 1 ? removeSplitNode(root, node.id) : undefined) }}>{uiIcon('close', 13)}</button> : null}
    {preview && previewStyle ? <div className={`split-edge-preview ${preview.ready ? 'ready' : ''}`} style={previewStyle}><span>{preview.ready ? '松开创建分屏' : '继续向内拖动'}</span></div> : null}
  </div>
}

function SplitNodeView(props: SplitViewProps) {
  return props.node.type === 'branch'
    ? <SplitBranchView {...props} node={props.node}/>
    : <SplitLeafView {...props} node={props.node}/>
}

function SplitTreeView({ layout, primary, interactive, resizable, onChange, onPushHistory }: { layout: SplitNode | undefined; primary: ReactNode; interactive: boolean; resizable?: boolean; onChange: (next: SplitNode | undefined) => void; onPushHistory: () => void }) {
  const root = normalizeSplit(layout)
  return <div className={`split-root ${interactive ? 'is-interactive' : ''}`}><SplitNodeView node={root} root={root} primary={primary} interactive={interactive} resizable={resizable ?? interactive} splitActive={Boolean(layout)} onChange={onChange} onPushHistory={onPushHistory}/></div>
}

type SurfaceDropTarget = { canvasId: string; left: number; top: number; right: number; bottom: number; outerScale: number }

// 白板风「推开草纸」：被碰到的卡让开时，除了不重叠，还多留这么一点空隙（画布单位）
/** 界面字号档位 → 宿主 ZoomFactor（带上下限，避免字被拉到看不清） */
const UI_ZOOM_MIN = 0.9
const UI_ZOOM_MAX = 1.45
function applyUiZoom(scale?: number) {
  const raw = typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1
  const factor = Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, raw))
  window.chrome?.webview?.postMessage({ type: 'native-ui-zoom', factor })
}
const PUSH_RECENT = 6
/** 空画布新手引导看过没有（用户 2026-09-18：上手太难，要手册） */
const EMPTY_GUIDE_KEY = 'zzj-empty-guide-dismissed'
const PAPER_PUSH_GAP = 14

type SurfaceInteraction =
  | { mode: 'pan'; sx: number; sy: number; vx: number; vy: number; outerScale: number; panSamples?: { t: number; x: number; y: number }[] }
  | { mode: 'drag'; sx: number; sy: number; outerScale: number; primaryId: string; origins: Map<string, Point>; movingIds: string[]; movingElements: Map<string, HTMLElement>; surfaceTargets: SurfaceDropTarget[]; transient?: Map<string, Point>; grabX: number; grabY: number; screenW: number; screenH: number; alignTargetId?: string; mergeTargetId?: string; crossTarget?: SurfaceDropTarget; clientX: number; clientY: number; push: boolean; pushed?: Map<string, Point>; pushOrigins?: Map<string, Point>; pushedElements?: Map<string, HTMLElement>; pushedIds?: Set<string>; pushAxis?: 'x' | 'y'; pushDirection?: number; pushLastDx?: number; pushLastDy?: number; pushRecent?: { x: number; y: number }[]; pushedAny?: Set<string>; raisedZ?: Map<string, string>; duplicating: boolean }
  | { mode: 'resize'; sx: number; sy: number; outerScale: number; id: string; w: number; h: number; group?: { box: { x: number; y: number }; members: { id: string; dx: number; dy: number; w: number; h: number }[] } }
  | { mode: 'split-resize'; sx: number; sy: number; outerScale: number; orientation: 'columns' | 'rows'; first: CanvasItem; second: CanvasItem; gap: number }
  | { mode: 'marquee'; sx: number; sy: number; cx: number; cy: number; outerScale: number; additive: boolean }
  | null
type SurfaceInteractionMode = Exclude<SurfaceInteraction, null>['mode']

type CrossCanvasGhost = { clientX: number; clientY: number; screenW: number; screenH: number; grabX: number; grabY: number; title: string; kind: ItemKind; targetCanvasId: string; itemCount: number }

function closestItemInSurface(target: HTMLElement, surface: HTMLElement): HTMLElement | null {
  const item = target.closest<HTMLElement>('.canvas-item')
  return item?.closest<HTMLElement>('.space-surface') === surface ? item : null
}

type CanvasOrganizeRequest = {
  id: number
  canvasId: string
  positions: Map<string, Point>
  counts: OrganizedCanvasLayout['counts']
  fullCanvas: boolean
}

type SpatialSurfaceProps = {
  canvas: SpaceCanvas
  spaces: SpaceCanvas[]
  items: CanvasItem[]
  surfacePaintOrder: ReadonlyMap<string, number>
  selectedIds: string[]
  activeCanvasId: string
  activeSound: string
  highlightedCanvasId: string | null
  cardTitlebarVisibility: CardTitlebarVisibility
  embedded?: boolean
  onViewport: (canvasId: string, viewport: Viewport) => void
  onSelect: (canvasId: string, ids: string[], additive: boolean) => void
  onMove: (updates: Map<string, Point>) => void
  onUpdateItems: (updates: Map<string, ItemPatch>) => void
  onResize: (id: string, w: number, h: number) => void
  onMerge: (canvasId: string, draggedId: string, targetId: string) => void
  onReparent: (sourceCanvasId: string, target: SurfaceDropTarget, primaryId: string, movingIds: string[], clientX: number, clientY: number, grabX: number, grabY: number, screenW: number) => void
  onActivateCanvas: (canvasId: string) => void
  onActivateItem: (item: CanvasItem) => void
  onPin: (canvasId: string, item: CanvasItem) => void
  onDuplicate: (items: CanvasItem[], cloneIds: string[], offset?: Point) => void
  onDoubleClick: (item: CanvasItem) => void
  onToggleWorkspaceFocus: (item: CanvasItem) => void
  onWorkspaceSplit: (itemId: string, layout: WorkspaceSplitLayout | undefined) => void
  onPushHistory: () => void
  onRenameCanvas: (canvasId: string, title: string) => void
  onDissolve: (canvasId: string) => void
  onFixedEntry: (canvasId: string, entry: FixedEntry) => void
  sleepingCanvasIds: Set<string>
  onWakeCanvas: (canvasId: string) => void
  onIdleCanvas: (canvasId: string) => void
  onInteractionState: (canvasId: string, active: boolean, mode?: SurfaceInteractionMode) => void
  organizeRequest: CanvasOrganizeRequest | null
  onOrganizeComplete: (request: CanvasOrganizeRequest, positions: Map<string, Point>, interrupted: boolean) => void
  focusedWorkspaceId?: string | null
  spawnAnchor?: { canvasId: string; x: number; y: number } | null
  onSetAnchor?: (canvasId: string, x: number, y: number) => void
  onContextMenu?: (payload: { canvasId: string; itemId: string | null; clientX: number; clientY: number; worldX: number; worldY: number }) => void
}

function EditableCanvasTitle({ canvas, onRename, onOpen }: { canvas: SpaceCanvas; onRename: (canvasId: string, title: string) => void; onOpen?: () => void }) {
  const titleRef = useRef<HTMLElement>(null)
  const draftRef = useRef(canvas.title)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    draftRef.current = canvas.title
    const element = titleRef.current
    if (element && document.activeElement !== element && element.textContent !== canvas.title) element.textContent = canvas.title
  }, [canvas.title])

  const singleLineTitle = (value: string) => {
    let title = value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
    if (title.length > 80) {
      title = title.slice(0, 80)
      const last = title.charCodeAt(title.length - 1)
      if (last >= 0xD800 && last <= 0xDBFF) title = title.slice(0, -1)
    }
    return title
  }

  const commit = () => {
    const title = singleLineTitle(draftRef.current) || '未命名画布'
    if (titleRef.current && titleRef.current.textContent !== title) titleRef.current.textContent = title
    if (title !== canvas.title) onRename(canvas.id, title)
    setEditing(false)
  }

  useLayoutEffect(() => {
    if (!editing) return
    const element = titleRef.current
    if (!element) return
    element.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [editing])

  return <strong
    ref={titleRef}
    contentEditable={editing}
    suppressContentEditableWarning
    spellCheck={false}
    className={editing ? 'canvas-title editing' : 'canvas-title'}
    title={editing ? '正在重命名' : onOpen ? '双击进入画布 · 右键可改名' : '双击重命名 · 右键可改名'}
    onContextMenu={(event) => {
      // 画布卡标题被卡内 HUD 盖住，标题栏那层收不到右键 —— 这里补上，统一弹元素菜单（含「修改名称…」）
      event.preventDefault()
      event.stopPropagation()
      if (canvas.hostItemId) window.dispatchEvent(new CustomEvent('zhangzhongjie-titlebar-menu', { detail: { itemId: canvas.hostItemId, clientX: event.clientX, clientY: event.clientY } }))
    }}
    onDoubleClick={(event) => {
      event.preventDefault()
      event.stopPropagation()
      if (onOpen) { onOpen(); return }
      draftRef.current = canvas.title
      setEditing(true)
    }}
    onPointerDown={(event) => { if (editing) event.stopPropagation() }}
    onInput={(event) => { draftRef.current = event.currentTarget.textContent ?? '' }}
    onPaste={(event) => {
      event.preventDefault()
      const text = singleLineTitle(event.clipboardData.getData('text/plain'))
      document.execCommand('insertText', false, text)
    }}
    onBlur={() => { if (editing) commit() }}
    onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') {
        event.preventDefault()
        draftRef.current = canvas.title
        event.currentTarget.textContent = canvas.title
        event.currentTarget.blur()
      }
    }}
  >{canvas.title}</strong>
}

const SpatialSurface = memo(function SpatialSurface(props: SpatialSurfaceProps) {
  const { canvas, spaces, items, surfacePaintOrder, selectedIds, activeCanvasId, activeSound, highlightedCanvasId, cardTitlebarVisibility, embedded, onViewport, onSelect, onMove, onUpdateItems, onResize, onMerge, onReparent, onActivateCanvas, onActivateItem, onPin, onDuplicate, onDoubleClick, onToggleWorkspaceFocus, onWorkspaceSplit, onPushHistory, onRenameCanvas, onDissolve, onFixedEntry, sleepingCanvasIds, onWakeCanvas, onIdleCanvas, onInteractionState, organizeRequest, onOrganizeComplete, focusedWorkspaceId, spawnAnchor, onSetAnchor, onContextMenu } = props
  const surfaceRef = useRef<HTMLDivElement>(null)
  const interactionRef = useRef<SurfaceInteraction>(null)
  const panInertiaRef = useRef<number | null>(null)
  const viewportRef = useRef(canvas.viewport)
  viewportRef.current = canvas.viewport
  const guideRefs = useRef<(HTMLDivElement | null)[]>([])
  const bridgeRef = useRef<HTMLDivElement>(null)
  const fusionBadgeRef = useRef<HTMLDivElement>(null)
  const bridgeGeometryRef = useRef<{ a: Point; b: Point } | null>(null)
  const itemElementRefs = useRef<Map<string, HTMLElement>>(new Map())
  const organizeActiveRef = useRef(false)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [snapTargetId, setSnapTargetId] = useState<string | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null)
  // 交接文档 6.1 / 22 P0-7：两段式手势。第一次靠近只贴边对齐，松手结束；
  // 必须再次单独拖起其中一个、进入对方的内部命中区，才创建子画布。
  // 这里记住「已经对齐过」的配对，它要跨手势存活，所以放在 ref 里。
  const alignedPairsRef = useRef<Set<string>>(new Set())
  const pairKey = (a: string, b: string) => [a, b].sort().join('|')
  const ALIGN_GAP = 18
  const SNAP_SCREEN_PX = 7
  // 拖动时把移动中的窗口和邻近窗口的边（左/中/右、上/中/下）逐对比较，取最近的
  // 一条吸上去，并把命中的边返回去画参考线。窗口比目标大也没关系——左对左、
  // 右对右这些组合本来就成立，选中的永远是当前最近的那一条。
  const computeSnap = (box: { x: number; y: number; w: number; h: number }, others: CanvasItem[], tolerance: number) => {
    const mx = { l: box.x, c: box.x + box.w / 2, r: box.x + box.w }
    const my = { t: box.y, c: box.y + box.h / 2, b: box.y + box.h }
    let dx = 0, dy = 0
    let bestX = tolerance, bestY = tolerance
    for (const other of others) {
      const ox = { l: other.x, c: other.x + other.w / 2, r: other.x + other.w }
      const oy = { t: other.y, c: other.y + other.h / 2, b: other.y + other.h }
      for (const a of ['l', 'c', 'r'] as const) for (const b of ['l', 'c', 'r'] as const) {
        const delta = ox[b] - mx[a]
        if (Math.abs(delta) < bestX) { bestX = Math.abs(delta); dx = delta }
      }
      for (const a of ['t', 'c', 'b'] as const) for (const b of ['t', 'c', 'b'] as const) {
        const delta = oy[b] - my[a]
        if (Math.abs(delta) < bestY) { bestY = Math.abs(delta); dy = delta }
      }
    }
    // 吸附之后再回头收集所有严格重合的边，作为参考线画出来
    const snapped = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
    const sx = { l: snapped.x, c: snapped.x + snapped.w / 2, r: snapped.x + snapped.w }
    const sy = { t: snapped.y, c: snapped.y + snapped.h / 2, b: snapped.y + snapped.h }
    const lines: { axis: 'x' | 'y'; at: number; from: number; to: number }[] = []
    for (const other of others) {
      const ox = { l: other.x, c: other.x + other.w / 2, r: other.x + other.w }
      const oy = { t: other.y, c: other.y + other.h / 2, b: other.y + other.h }
      for (const a of ['l', 'c', 'r'] as const) for (const b of ['l', 'c', 'r'] as const) {
        if (Math.abs(ox[b] - sx[a]) < .5) lines.push({ axis: 'x', at: ox[b],
          from: Math.min(snapped.y, other.y), to: Math.max(snapped.y + snapped.h, other.y + other.h) })
      }
      for (const a of ['t', 'c', 'b'] as const) for (const b of ['t', 'c', 'b'] as const) {
        if (Math.abs(oy[b] - sy[a]) < .5) lines.push({ axis: 'y', at: oy[b],
          from: Math.min(snapped.x, other.x), to: Math.max(snapped.x + snapped.w, other.x + other.w) })
      }
    }
    const unique = lines.filter((line, index) => lines.findIndex((entry) => entry.axis === line.axis && Math.abs(entry.at - line.at) < .5) === index)
    return { dx, dy, lines: unique.slice(0, 6) }
  }
  const boxesOverlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  // 贴边对齐要避开已经占位的窗口。只按主轴方向选一侧的话，第三个元素贴过来
  // 就会直接压在上一次已经对齐好的那个上面。这里把四个方向都算出来，按「离
  // 用户实际松手的位置最近」排序（吸附方向才符合直觉），再挑第一个不与任何
  // 窗口重叠的落点；四面都被占就沿最近那一侧继续推开。
  const alignedPosition = (moving: CanvasItem, target: CanvasItem, others: CanvasItem[]) => {
    const candidates = [
      { x: target.x + target.w + ALIGN_GAP, y: target.y },
      { x: target.x - moving.w - ALIGN_GAP, y: target.y },
      { x: target.x, y: target.y + target.h + ALIGN_GAP },
      { x: target.x, y: target.y - moving.h - ALIGN_GAP },
    ]
    candidates.sort((a, b) => Math.hypot(a.x - moving.x, a.y - moving.y) - Math.hypot(b.x - moving.x, b.y - moving.y))
    const free = (spot: { x: number; y: number }) => !others.some((entry) => boxesOverlap({ ...spot, w: moving.w, h: moving.h }, entry))
    const clear = candidates.find(free)
    if (clear) return clear
    const fallback = candidates[0]
    const horizontal = Math.abs(fallback.x - target.x) > Math.abs(fallback.y - target.y)
    const stepX = horizontal ? (fallback.x >= target.x ? moving.w + ALIGN_GAP : -(moving.w + ALIGN_GAP)) : 0
    const stepY = horizontal ? 0 : (fallback.y >= target.y ? moving.h + ALIGN_GAP : -(moving.h + ALIGN_GAP))
    for (let step = 1; step <= 8; step += 1) {
      const spot = { x: fallback.x + stepX * step, y: fallback.y + stepY * step }
      if (free(spot)) return spot
    }
    return fallback
  }
  const closeFromSurface = useCallback((item: CanvasItem) => window.dispatchEvent(new CustomEvent('zhangzhongjie-close-item', { detail: item.id })), [])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [crossGhost, setCrossGhost] = useState<CrossCanvasGhost | null>(null)
  const canvasItems = useMemo(() => items.filter((item) => item.canvasId === canvas.id && !item.pinned).sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0)), [canvas.id, items])
  const pinnedItems = useMemo(() => items.filter((item) => item.canvasId === canvas.id && item.pinned), [canvas.id, items])
  const itemMap = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const latestItemMapRef = useRef(itemMap)
  latestItemMapRef.current = itemMap

  const outerScale = useCallback(() => {
    const element = surfaceRef.current
    if (!element) return 1
    return element.getBoundingClientRect().width / Math.max(1, element.offsetWidth)
  }, [])

  const selectItem = useCallback((item: CanvasItem, additive: boolean) => {
    const ids = item.groupId ? canvasItems.filter((entry) => entry.groupId === item.groupId).map((entry) => entry.id) : [item.id]
    onSelect(canvas.id, ids, additive)
  }, [canvas.id, canvasItems, onSelect])

  useEffect(() => {
    if (!organizeRequest || organizeRequest.canvasId !== canvas.id || organizeActiveRef.current) return
    const duration = 240
    // Freeze the item snapshot for this request. Unrelated item updates during
    // the 240 ms animation must not clean up and replay the same request.
    const requestItemMap = latestItemMapRef.current
    const animated = [...organizeRequest.positions].flatMap(([id, target]) => {
      const item = requestItemMap.get(id)
      const element = itemElementRefs.current.get(id)
      if (!item || !element) return []
      const dx = target.x - item.x
      const dy = target.y - item.y
      element.style.willChange = 'transform'
      const animation = element.animate([
        { transform: 'translate3d(0, 0, 0)' },
        { transform: `translate3d(${dx}px, ${dy}px, 0)` },
      ], { duration, easing: 'ease-out', fill: 'forwards' })
      return [{ id, item, target, element, animation }]
    })
    if (!animated.length) {
      onOrganizeComplete(organizeRequest, organizeRequest.positions, false)
      return
    }

    let finished = false
    organizeActiveRef.current = true
    onInteractionState(canvas.id, true)
    const finish = (interrupted: boolean) => {
      if (finished) return
      finished = true
      const positions = interrupted
        ? new Map(animated.map(({ id, item, target, animation }) => {
          const progress = clamp(Number(animation.currentTime ?? 0) / duration, 0, 1)
          return [id, { x: item.x + (target.x - item.x) * progress, y: item.y + (target.y - item.y) * progress }] as const
        }))
        : organizeRequest.positions
      onOrganizeComplete(organizeRequest, positions, interrupted)
      for (const { element, animation } of animated) {
        animation.cancel()
        element.style.removeProperty('will-change')
      }
      organizeActiveRef.current = false
      onInteractionState(canvas.id, false)
    }
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      finish(true)
    }
    window.addEventListener('keydown', stopOnEscape, true)
    void Promise.all(animated.map(({ animation }) => animation.finished.catch(() => undefined))).then(() => finish(false))
    return () => {
      window.removeEventListener('keydown', stopOnEscape, true)
      if (finished) return
      finished = true
      for (const { element, animation } of animated) {
        animation.cancel()
        element.style.removeProperty('will-change')
      }
      organizeActiveRef.current = false
      onInteractionState(canvas.id, false)
    }
  }, [canvas.id, onInteractionState, onOrganizeComplete, organizeRequest])

  const handleItemDown = useCallback((event: ReactPointerEvent, item: CanvasItem) => {
    if (organizeActiveRef.current) return
    if (event.button !== 0) return
    const target = event.target as HTMLElement
      if (target.closest('button,input,textarea,select,[contenteditable]')) return
    event.stopPropagation()
    onActivateCanvas(canvas.id)
    // 裸图标没有标题栏，整块（图标+名字）都是拖动面；其它卡片沿用「拖标题栏」
    const onTitlebar = Boolean(target.closest('.window-titlebar') || (item.kind === 'icon' && target.closest('.launcher-icon')) || (item.kind === 'workspace' && target.closest('.workspace-drag-handle'))) && !item.pinned
    // Ctrl + 拖标题栏 = 拖出一份独立副本（与 PureRef 一致），原窗口留在原位。
    // 对文件管理器来说复制出来的是另一个独立的 Shell 实例，起始路径相同但可各自导航。
    // Shift 点在窗口内容上仍然是加选，两者互不干扰。
    const duplicating = onTitlebar && (event.ctrlKey || event.metaKey)
    if (!duplicating) selectItem(item, event.shiftKey)
    if (!onTitlebar) return
    const duplicateSources = duplicating && selectedIds.includes(item.id)
      ? canvasItems.filter((entry) => selectedIds.includes(entry.id))
      : [item]
    const duplicateStamp = Date.now()
    const cloneIds = duplicating ? duplicateSources.map((entry, index) => `${entry.kind}-${duplicateStamp}-${index}`) : []
    const primaryCloneId = duplicating ? cloneIds[Math.max(0, duplicateSources.findIndex((entry) => entry.id === item.id))] : ''
    const movingIds = duplicating ? cloneIds : item.groupId ? canvasItems.filter((entry) => entry.groupId === item.groupId).map((entry) => entry.id) : [item.id]
    const origins = new Map<string, Point>()
    if (duplicating) {
      // Mount the clones before caching their DOM nodes so Shift-drag paints the
      // whole duplicated selection immediately instead of only moving on release.
      flushSync(() => onDuplicate(duplicateSources, cloneIds, { x: 0, y: 0 }))
      duplicateSources.forEach((source, index) => origins.set(cloneIds[index], { x: source.x, y: source.y }))
    } else {
      for (const entry of canvasItems) if (movingIds.includes(entry.id)) origins.set(entry.id, { x: entry.x, y: entry.y })
    }
    const itemRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const grabX = clamp((event.clientX - itemRect.left) / Math.max(itemRect.width, 1), 0, 1)
    const grabY = clamp((event.clientY - itemRect.top) / Math.max(itemRect.height, 1), 0, 1)
    if (!duplicating) onPushHistory()
    setDraggingId(duplicating ? primaryCloneId : item.id)
    onInteractionState(canvas.id, true)
    const movingElements = new Map<string, HTMLElement>()
    for (const id of movingIds) {
      const element = itemElementRefs.current.get(id)
      if (element) movingElements.set(id, element)
    }
    // The canvas hierarchy is geometrically stable for the duration of an item
    // drag. Cache every target rect once so both root -> child and child -> root
    // reparenting stay available without elementsFromPoint/layout on each move.
    const workspaceTargets = [...document.querySelectorAll<HTMLElement>('.canvas-item.kind-workspace[data-item-id]')].flatMap((element) => {
      const workspace = itemMap.get(element.dataset.itemId ?? '')
      if (!workspace?.childCanvasId) return []
      if (!sleepingCanvasIds.has(workspace.childCanvasId)) return []
      const body = element.querySelector<HTMLElement>(':scope > .window-body')
      if (!body) return []
      const rect = body.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? [{ canvasId: workspace.childCanvasId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, outerScale: rect.width / Math.max(body.offsetWidth, 1) }] : []
    })
    const liveSurfaceTargets = [...document.querySelectorAll<HTMLElement>('.space-surface[data-canvas-id]')].flatMap((element) => {
      const canvasId = element.dataset.canvasId
      if (!canvasId) return []
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? [{ canvasId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, outerScale: rect.width / Math.max(element.offsetWidth, 1) }] : []
    })
    // Workspace bounds are fallbacks for sleeping canvases whose inner surface is
    // temporarily replaced by CanvasSnapshot. They are nested above their live
    // ancestor surface, so append them as the topmost hit targets.
    const surfaceTargets = [...liveSurfaceTargets, ...workspaceTargets]
    interactionRef.current = { mode: 'drag', sx: event.clientX, sy: event.clientY, outerScale: outerScale(), primaryId: duplicating ? primaryCloneId : item.id, origins, movingIds, movingElements, surfaceTargets, grabX, grabY, screenW: itemRect.width, screenH: itemRect.height, clientX: event.clientX, clientY: event.clientY, push: readBrowserSettings().canvasSkin !== 'default', duplicating }
  }, [canvas.id, canvasItems, itemMap, onActivateCanvas, onDuplicate, onInteractionState, onPushHistory, onSelect, outerScale, selectItem, selectedIds, sleepingCanvasIds])

  const handleResizeDown = useCallback((event: ReactPointerEvent, item: CanvasItem) => {
    if (organizeActiveRef.current) return
    event.preventDefault(); event.stopPropagation(); onPushHistory(); onActivateCanvas(canvas.id)
    onInteractionState(canvas.id, true)
    // 成组的卡片：拖角缩放要**整组等比缩放**（锚点＝整组包围盒左上角），不能只改被拖的那一张。
    // 用户 2026-09-14 报：「成组以后放大缩小只能控制一个，而不是按成组的来控制大小」。
    const members = item.groupId ? canvasItems.filter((entry) => entry.groupId === item.groupId) : []
    const group = members.length >= 2
      ? (() => {
          const box = { x: Math.min(...members.map((entry) => entry.x)), y: Math.min(...members.map((entry) => entry.y)) }
          return { box, members: members.map((entry) => ({ id: entry.id, dx: entry.x - box.x, dy: entry.y - box.y, w: entry.w, h: entry.h })) }
        })()
      : undefined
    interactionRef.current = { mode: 'resize', sx: event.clientX, sy: event.clientY, outerScale: outerScale(), id: item.id, w: item.w, h: item.h, group }
  }, [canvas.id, canvasItems, onActivateCanvas, onInteractionState, onPushHistory, outerScale])

  const splitPairs = useMemo(() => {
    const groups = new Map<string, CanvasItem[]>()
    for (const item of canvasItems) if (item.groupId) groups.set(item.groupId, [...(groups.get(item.groupId) ?? []), item])
    return [...groups.entries()].flatMap(([groupId, members]) => {
      if (members.length !== 2) return []
      const [a, b] = members
      const orientation: 'columns' | 'rows' = Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) >= Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) ? 'columns' : 'rows'
      const ordered = [...members].sort((first, second) => orientation === 'columns' ? first.x - second.x : first.y - second.y)
      return [{ groupId, first: ordered[0], second: ordered[1], orientation }]
    })
  }, [canvasItems])

  const handleSplitDown = useCallback((event: ReactPointerEvent, first: CanvasItem, second: CanvasItem, orientation: 'columns' | 'rows') => {
    if (organizeActiveRef.current) return
    event.preventDefault(); event.stopPropagation(); onPushHistory(); onActivateCanvas(canvas.id)
    onInteractionState(canvas.id, true)
    interactionRef.current = { mode: 'split-resize', sx: event.clientX, sy: event.clientY, outerScale: outerScale(), orientation, first: { ...first }, second: { ...second }, gap: orientation === 'columns' ? second.x - first.x - first.w : second.y - first.y - first.h }
  }, [canvas.id, onActivateCanvas, onInteractionState, onPushHistory, outerScale])

  // —— 平移惯性：松手后沿速度继续滑行，指数衰减；任何新操作立即刹停。——
  const stopPanInertia = useCallback(() => {
    if (panInertiaRef.current !== null) {
      window.cancelAnimationFrame(panInertiaRef.current)
      panInertiaRef.current = null
    }
  }, [])
  const startPanInertia = useCallback((samples?: { t: number; x: number; y: number }[]) => {
    stopPanInertia()
    if (!samples || samples.length < 2) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const last = samples[samples.length - 1]
    const first = samples.find((sample) => last.t - sample.t <= 120) ?? samples[0]
    const elapsed = Math.max(last.t - first.t, 1)
    const scale = outerScale()
    let vx = (last.x - first.x) / elapsed / scale
    let vy = (last.y - first.y) / elapsed / scale
    if (Math.hypot(vx, vy) < 0.02) return
    let current = { ...viewportRef.current }
    let previous = performance.now()
    const step = (now: number) => {
      const stepMs = Math.min(now - previous, 50)
      previous = now
      current = { ...current, x: current.x + vx * stepMs, y: current.y + vy * stepMs }
      onViewport(canvas.id, current)
      const decay = Math.exp(-stepMs / 115)
      vx *= decay
      vy *= decay
      panInertiaRef.current = Math.hypot(vx, vy) > 0.015 ? window.requestAnimationFrame(step) : null
    }
    panInertiaRef.current = window.requestAnimationFrame(step)
  }, [canvas.id, onViewport, outerScale, stopPanInertia])
  useEffect(() => stopPanInertia, [stopPanInertia])

  const handleSurfaceDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    stopPanInertia()
    if (organizeActiveRef.current) { event.preventDefault(); event.stopPropagation(); return }
    const nearest = (event.target as HTMLElement).closest<HTMLElement>('.space-surface')
    if (event.button === 1) {
      // Capture sees the outer surface first. Only the innermost surface may claim
      // this gesture; keeping capture registration still bypasses DOM cards that
      // stop bubbling their own pointer events.
      if (nearest !== event.currentTarget) return
      event.preventDefault(); event.stopPropagation(); onActivateCanvas(canvas.id)
      const scaleOutside = outerScale()
      onInteractionState(canvas.id, true)
      interactionRef.current = { mode: 'pan', sx: event.clientX, sy: event.clientY, vx: canvas.viewport.x, vy: canvas.viewport.y, outerScale: scaleOutside }
      return
    }
    if (nearest !== event.currentTarget) return
    // The second press of a double-click must not start another marquee. In an
    // embedded canvas that state change used to swallow the following dblclick,
    // so neither the host workspace id nor its viewport was ever reached.
    if (embedded && event.button === 0 && event.detail >= 2) {
      event.stopPropagation()
      return
    }
    // The embedded canvas title bar belongs to the outer workspace card. Let
    // this gesture bubble to CanvasWindow's normal drag and history path.
    if (event.button === 0 && (event.target as HTMLElement).closest('.workspace-drag-handle')) return
    event.stopPropagation(); onActivateCanvas(canvas.id)
    const scaleOutside = outerScale()
    if (event.button !== 0 || closestItemInSurface(event.target as HTMLElement, event.currentTarget) || (event.target as HTMLElement).closest('.inner-fixedbar,.space-hud')) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / scaleOutside
    const y = (event.clientY - rect.top) / scaleOutside
    interactionRef.current = { mode: 'marquee', sx: x, sy: y, cx: x, cy: y, outerScale: scaleOutside, additive: event.shiftKey }
    onInteractionState(canvas.id, true, 'marquee')
    if (!event.shiftKey) onSelect(canvas.id, [], false)
    setMarquee({ x, y, w: 0, h: 0 })
  }, [canvas.id, canvas.viewport.x, canvas.viewport.y, embedded, onActivateCanvas, onInteractionState, onSelect, outerScale, stopPanInertia])

  useEffect(() => {
    const paintGuides = (lines: { axis: 'x' | 'y'; at: number; from: number; to: number }[]) => {
      for (let index = 0; index < guideRefs.current.length; index += 1) {
        const element = guideRefs.current[index]
        if (!element) continue
        const line = lines[index]
        if (!line) { element.style.visibility = 'hidden'; continue }
        const className = `align-guide guide-${line.axis}`
        if (element.className !== className) element.className = className
        element.style.visibility = 'visible'
        const x = line.axis === 'x' ? line.at : line.from
        const y = line.axis === 'x' ? line.from : line.at
        const length = Math.max(0, line.to - line.from)
        element.style.transform = line.axis === 'x'
          ? `translate3d(${x}px, ${y}px, 0) scaleY(${length})`
          : `translate3d(${x}px, ${y}px, 0) scaleX(${length})`
      }
    }
    const paintBridge = (geometry: { a: Point; b: Point } | null, fusion = false) => {
      bridgeGeometryRef.current = geometry
      const element = bridgeRef.current
      if (element) {
        if (!geometry) {
          element.style.visibility = 'hidden'
          element.style.animationPlayState = 'paused'
        }
        else {
          const dx = geometry.b.x - geometry.a.x
          const dy = geometry.b.y - geometry.a.y
          const className = `liquid-bridge ${fusion ? 'canvas-bridge' : ''}`
          if (element.className !== className) element.className = className
          element.style.visibility = 'visible'
          element.style.animationPlayState = 'running'
          element.style.transform = `translate3d(${geometry.a.x}px, ${geometry.a.y}px, 0) rotate(${Math.atan2(dy, dx)}rad) scaleX(${Math.hypot(dx, dy)})`
        }
      }
      const badge = fusionBadgeRef.current
      if (badge && geometry) {
        badge.style.setProperty('--fusion-x', `${(geometry.a.x + geometry.b.x) / 2}px`)
        badge.style.setProperty('--fusion-y', `${(geometry.a.y + geometry.b.y) / 2}px`)
      }
    }
    const paintTransientPositions = (interaction: Extract<NonNullable<SurfaceInteraction>, { mode: 'drag' }>, updates: Map<string, Point>) => {
      for (const [id, point] of updates) {
        const origin = interaction.origins.get(id)
        const element = interaction.movingElements.get(id) ?? itemElementRefs.current.get(id)
        if (element && !interaction.movingElements.has(id)) interaction.movingElements.set(id, element)
        if (origin && element) element.style.transform = `translate3d(${point.x - origin.x}px, ${point.y - origin.y}px, 0)`
      }
    }
    const clearTransientPositions = (interaction: Extract<NonNullable<SurfaceInteraction>, { mode: 'drag' }>) => {
      for (const element of interaction.movingElements.values()) element.style.removeProperty('transform')
    }
    // 「推开草纸」的几何：给一组「推手」盒子，算出挡路的卡该让到哪儿。
    // 一张推一张：被推开的卡自己变成推手继续推下去（最多 4 层，防死循环）。
    // 让开方向**逐对按几何判断**：目标在推手的哪一侧，就往哪一侧让。
    // 用户 2026-09-17 报「3 个窗口、控制中间那张：一直往左推没问题，同一次拖动里再往右推就覆盖上去」——
    // 之前方向是整段手势共享的一个值（还带 6 帧窗口延迟），反手推时方向还是旧的「往左」，
    // 结果把右边的卡往左推（推向你的手）→ 怎么推都是盖上去。逐对判断后永远只会把目标推开。
    // `stepSigned` = 这一帧指针沿主轴走了多少（**带符号**，不再预先乘方向）。
    const pushTargetsFor = (pushers: { x: number; y: number; w: number; h: number }[], reserved: Set<string>, axis: 'x' | 'y', stepSigned: number, base: Map<string, Point>) => {
      const targets = new Map<string, Point>()
      let queue = pushers
      for (let pass = 0; pass < 4 && queue.length; pass += 1) {
        const next: { x: number; y: number; w: number; h: number }[] = []
        for (const box of queue) {
          for (const other of canvasItems) {
            if (reserved.has(other.id)) continue
            const at = targets.get(other.id) ?? base.get(other.id) ?? { x: other.x, y: other.y }
            const candidate = { x: at.x, y: at.y, w: other.w, h: other.h }
            if (!boxesOverlap(box, candidate)) continue
            const overlap = axis === 'x'
              ? Math.min(box.x + box.w, candidate.x + candidate.w) - Math.max(box.x, candidate.x)
              : Math.min(box.y + box.h, candidate.y + candidate.h) - Math.max(box.y, candidate.y)
            if (overlap <= 0) continue
            // 第一次接触才多留一点缝；**每帧最多跟指针走同样多**（外加首次那点缝），
            // 否则「把整个重叠量一次性让开」会让新接触的卡瞬移一整张卡的高度 —— 用户 2026-09-17
            // 报「上下推一跳一跳的」就是这么来的。
            const first = !base.has(other.id) && !targets.has(other.id)
            // 目标在推手哪一侧 → 就往哪一侧让（永远「把它推开」，绝不推向推手）
            const pusherCenter = axis === 'x' ? box.x + box.w / 2 : box.y + box.h / 2
            const targetCenter = axis === 'x' ? candidate.x + candidate.w / 2 : candidate.y + candidate.h / 2
            const dir = targetCenter >= pusherCenter ? 1 : -1
            // 手这一帧朝它推进了多少；手在远离它的那几帧一点都不推（纸不会被手拉回来）
            const advance = Math.max(0, stepSigned * dir)
            if (!first && advance <= 0) continue
            // 指针这一帧没动（advance=0）就一点都不推 —— 手停住纸也停住，不会「慢慢飘过去」
            const slack = advance + (first ? PAPER_PUSH_GAP : 0)
            const shift = first ? Math.min(overlap + PAPER_PUSH_GAP, slack) : Math.min(overlap, slack)
            const moved = axis === 'x'
              ? { x: at.x + dir * shift, y: at.y }
              : { x: at.x, y: at.y + dir * shift }
            targets.set(other.id, moved)
            reserved.add(other.id)
            next.push({ x: moved.x, y: moved.y, w: other.w, h: other.h })
          }
        }
        queue = next
      }
      return targets
    }
    const finishInteraction = (commit: boolean) => {
      const interaction = interactionRef.current
      if (interaction?.mode === 'drag') {
        // 被「推开草纸」推开的卡：松手就停在让开后的位置（就是拖动期间看到的那个位置）
        if (commit && interaction.pushed?.size) {
          const merged = interaction.transient ?? new Map<string, Point>()
          for (const [id, point] of interaction.pushed) merged.set(id, point)
          interaction.transient = merged
        }
        if (commit && interaction.crossTarget) {
          // Commit the model and the cross-canvas move before removing the
          // transient transform. This makes the final DOM position observable in
          // the same task and rules out a one-frame return to the drag origin.
          flushSync(() => {
            if (interaction.transient?.size) onMove(interaction.transient)
            onReparent(canvas.id, interaction.crossTarget!, interaction.primaryId, interaction.movingIds, interaction.clientX, interaction.clientY, interaction.grabX, interaction.grabY, interaction.screenW)
          })
        }
        else if (commit && interaction.mergeTargetId) {
          flushSync(() => {
            if (interaction.transient?.size) onMove(interaction.transient)
            alignedPairsRef.current.delete(pairKey(interaction.primaryId, interaction.mergeTargetId!))
            onMerge(canvas.id, interaction.primaryId, interaction.mergeTargetId!)
          })
        } else if (commit) {
          let settled = interaction.transient ?? new Map(interaction.origins)
          if (interaction.alignTargetId) {
            // The model is intentionally unchanged during drag; derive the final
            // aligned box from the transient point before committing once.
            const source = itemMap.get(interaction.primaryId)
            const point = settled.get(interaction.primaryId)
            const target = itemMap.get(interaction.alignTargetId)
            const moving = source && point ? { ...source, ...point } : undefined
            if (moving && target) {
              const others = canvasItems.filter((entry) => !interaction.movingIds.includes(entry.id) && !interaction.pushedAny?.has(entry.id))
              if (others.some((entry) => boxesOverlap(moving, entry))) {
                const snapped = alignedPosition(moving, target, others)
                const shift = { x: snapped.x - moving.x, y: snapped.y - moving.y }
                settled = new Map([...settled].map(([id, current]) => [id, { x: current.x + shift.x, y: current.y + shift.y }]))
              }
              alignedPairsRef.current.add(pairKey(interaction.primaryId, interaction.alignTargetId))
            }
          }
          if (settled.size) flushSync(() => onMove(settled))
        }
        clearTransientPositions(interaction)
        if (interaction.raisedZ) {
          for (const [id, value] of interaction.raisedZ) {
            const element = itemElementRefs.current.get(id)
            if (element) element.style.zIndex = value
          }
          interaction.raisedZ = undefined
        }
        interaction.movingElements.clear()
        interaction.surfaceTargets.length = 0
      }
      if (interaction?.mode === 'pan' && commit) startPanInertia(interaction.panSamples)
      if (interaction) onInteractionState(canvas.id, false, interaction.mode)
      interactionRef.current = null
      setMarquee(null)
      setSnapTargetId(null)
      setMergeTargetId(null)
      paintGuides([])
      setDraggingId(null)
      paintBridge(null)
      setCrossGhost(null)
    }
    const move = (event: PointerEvent) => {
      const interaction = interactionRef.current
      if (!interaction) return
      // 原生子窗口会吞掉鼠标消息，pointerup 偶尔根本送不到页面，交互就一直挂着，
      // 表现为「只点了一下窗口却一直跟着鼠标走」。任何一帧发现主键已经松开就
      // 立刻收尾，不再依赖 pointerup 一定能到。
      if (interaction.mode !== 'pan' && (event.buttons & 1) === 0) {
        finishInteraction(true)
        return
      }
      if (interaction.mode === 'pan') {
        if ((event.buttons & 4) === 0) {
          finishInteraction(true)
          return
        }
        interaction.panSamples = [...(interaction.panSamples ?? []).slice(-5), { t: performance.now(), x: event.clientX, y: event.clientY }]
        onViewport(canvas.id, { ...canvas.viewport, x: interaction.vx + (event.clientX - interaction.sx) / interaction.outerScale, y: interaction.vy + (event.clientY - interaction.sy) / interaction.outerScale })
        return
      }
      if (interaction.mode === 'resize') {
        const scale = interaction.outerScale * canvas.viewport.scale
        const nextW = Math.max(280, interaction.w + (event.clientX - interaction.sx) / scale)
        const nextH = Math.max(190, interaction.h + (event.clientY - interaction.sy) / scale)
        const group = interaction.group
        if (group) {
          // 整组等比：取两轴里动得多的那一轴当比例，保证每张卡自己的长宽比不变（否则网页/视频会被拉扁）。
          const factor = Math.max(0.25, Math.min(8, Math.max(nextW / Math.max(interaction.w, 1), nextH / Math.max(interaction.h, 1))))
          onUpdateItems(new Map(group.members.map((member) => [member.id, {
            x: group.box.x + member.dx * factor,
            y: group.box.y + member.dy * factor,
            w: Math.max(60, member.w * factor),
            h: Math.max(44, member.h * factor),
          }])))
          return
        }
        onResize(interaction.id, nextW, nextH)
        return
      }
      if (interaction.mode === 'split-resize') {
        const scale = interaction.outerScale * canvas.viewport.scale
        const changes = new Map<string, ItemPatch>()
        if (interaction.orientation === 'columns') {
          const total = interaction.first.w + interaction.gap + interaction.second.w
          const firstW = clamp(interaction.first.w + (event.clientX - interaction.sx) / scale, total * .2, total * .8)
          const secondW = total - interaction.gap - firstW
          changes.set(interaction.first.id, { w: firstW })
          changes.set(interaction.second.id, { x: interaction.first.x + firstW + interaction.gap, w: secondW })
        } else {
          const total = interaction.first.h + interaction.gap + interaction.second.h
          const firstH = clamp(interaction.first.h + (event.clientY - interaction.sy) / scale, total * .2, total * .8)
          const secondH = total - interaction.gap - firstH
          changes.set(interaction.first.id, { h: firstH })
          changes.set(interaction.second.id, { y: interaction.first.y + firstH + interaction.gap, h: secondH })
        }
        onUpdateItems(changes)
        return
      }
      if (interaction.mode === 'marquee') {
        const rect = surfaceRef.current?.getBoundingClientRect()
        if (!rect) return
        const cx = (event.clientX - rect.left) / interaction.outerScale
        const cy = (event.clientY - rect.top) / interaction.outerScale
        interaction.cx = cx; interaction.cy = cy
        const x = Math.min(interaction.sx, cx); const y = Math.min(interaction.sy, cy)
        const w = Math.abs(cx - interaction.sx); const h = Math.abs(cy - interaction.sy)
        setMarquee({ x, y, w, h })
        const view = canvas.viewport
        const hits = canvasItems.filter((item) => {
          const ix = view.x + item.x * view.scale; const iy = view.y + item.y * view.scale
          const iw = item.w * view.scale; const ih = item.h * view.scale
          return ix < x + w && ix + iw > x && iy < y + h && iy + ih > y
        }).map((item) => item.id)
        onSelect(canvas.id, hits, interaction.additive)
        return
      }
      const scale = interaction.outerScale * canvas.viewport.scale
      const dx = (event.clientX - interaction.sx) / scale
      const dy = (event.clientY - interaction.sy) / scale
      const primaryOrigin = interaction.origins.get(interaction.primaryId)
      const primaryItem = itemMap.get(interaction.primaryId)
      let snapDx = 0, snapDy = 0
      if (primaryOrigin && primaryItem) {
        const others = canvasItems.filter((entry) => !interaction.movingIds.includes(entry.id) && !interaction.pushedIds?.has(entry.id) && !interaction.pushedAny?.has(entry.id))
        const tolerance = SNAP_SCREEN_PX / Math.max(canvas.viewport.scale, .01)
        const snap = computeSnap({ x: primaryOrigin.x + dx, y: primaryOrigin.y + dy, w: primaryItem.w, h: primaryItem.h }, others, tolerance)
        snapDx = snap.dx; snapDy = snap.dy
        paintGuides(snap.lines)
      }
      const updates = new Map<string, Point>()
      for (const [id, origin] of interaction.origins) updates.set(id, { x: origin.x + dx + snapDx, y: origin.y + dy + snapDy })
      interaction.transient = updates
      paintTransientPositions(interaction, updates)
      // ── 「推开草纸」（白板风）────────────────────────────────────────────────
      // 用户原话：「现实里桌面上摆着一堆的草纸，当我用鼠标拖拽标题栏的时候，接触到的草纸
      // 就像用我自己手推开一样」。
      // 关键：这里只推「瞬时位移」——模型一行不改，松手那一刻才和拖动的那张一起落账，
      // 所以拖动期间没有 React 重渲染，也不会惊动对齐/融合吸附（下面用 pushedIds 排除它们）。
      // Ctrl 拖 = 拖出一份副本（副本一开始就压在原件上），这不是「推开草纸」的场景：
      // 推了会把原件/邻居无缘无故推走（用户 2026-09-17 报「还没拉出复制就直接复制出来了」）。
      // 起手位移太小（<10 画布px）先不推：否则鼠标刚动一点、方向还没定就被推歪。
      if (interaction.push && !interaction.duplicating && interaction.origins.size && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
        // 几何取「已经吸附过的落点」（updates），否则被推的卡会差出吸附那几像素
        const pushing: { x: number; y: number; w: number; h: number }[] = []
        for (const [id, point] of updates) {
          const entry = itemMap.get(id)
          if (entry) pushing.push({ x: point.x, y: point.y, w: entry.w, h: entry.h })
        }
        // 推开方向：**按最近几帧的实时方向**判断，不是按整段拖拽的累计位移。
        // （用户 2026-09-17：先往左拖很远、再一直往上拖时，累计里横向仍占多数 → 判定「还在横着推」
        //   → 每帧沿横轴补那点缝，看起来就是「被推的卡一直在慢慢往左跑」。）
        // 规则：取最近 PUSH_RECENT(6) 帧的位移和当方向；一旦实时方向换了轴、且新轴位移明显反超
        // （1.6 倍），就认作「你真的改了方向」→ 把上一轮判错方向的让位撤回原位，按新轴重推。
        const stepDelta = { x: dx - (interaction.pushLastDx ?? 0), y: dy - (interaction.pushLastDy ?? 0) }
        interaction.pushLastDx = dx
        interaction.pushLastDy = dy
        const recent = interaction.pushRecent ?? (interaction.pushRecent = [])
        recent.push(stepDelta)
        while (recent.length > PUSH_RECENT) recent.shift()
        const winX = recent.reduce((sum, item) => sum + item.x, 0)
        const winY = recent.reduce((sum, item) => sum + item.y, 0)
        const dominant: 'x' | 'y' = Math.abs(winX) >= Math.abs(winY) ? 'x' : 'y'
        const lockedAxis = interaction.pushAxis
        const alongDominant = Math.abs(dominant === 'x' ? winX : winY)
        const alongOther = Math.abs(dominant === 'x' ? winY : winX)
        const switching = Boolean(lockedAxis && lockedAxis !== dominant && alongDominant > alongOther * 2.2)
        if (!lockedAxis || switching) {
          // 换方向**不许把已经让开的卡搬回原位**（用户 2026-09-17 录屏实测：被推的卡先让开 22px、
          // 0.75s 后又弹回原位；还有一帧里上下各跳 86px —— 就是因为这里之前把上一轮的让位「撤回原位」，
          // 方向判定在临界点来回切时，卡片被反复搬运）。
          // 现在的语义：让开就是让开了，换方向只是接下来沿新轴继续推。
          interaction.pushAxis = dominant
          interaction.pushDirection = (dominant === 'x' ? winX : winY) >= 0 ? 1 : -1
          if (switching) {
            // 换方向这一帧的「这一帧走了多少」按整段窗口算，别让上一轮的残量继续喂给新轴
            interaction.pushLastDx = dx
            interaction.pushLastDy = dy
          }
        }
        const axis: 'x' | 'y' = interaction.pushAxis ?? dominant
        const pushed = interaction.pushed ?? (interaction.pushed = new Map<string, Point>())
        const pushOrigins = interaction.pushOrigins ?? (interaction.pushOrigins = new Map<string, Point>())
        const pushedElements = interaction.pushedElements ?? (interaction.pushedElements = new Map<string, HTMLElement>())
        // 已经让开的卡从「它现在待的地方」继续算 —— 推开的纸不会自己滑回原位（用户 2026-09-17：
        // 「我往左推它跟着走，我拉回来它也跟着拉回来，这个不太对」）。
        // 这一帧指针沿主轴走了多少（被推的卡最多跟着走这么多，不瞬移）
        const stepSigned = axis === 'x' ? stepDelta.x : stepDelta.y
        const targets = pushTargetsFor(pushing, new Set(interaction.movingIds), axis, stepSigned, pushed)
        for (const [id, point] of targets) {
          const entry = itemMap.get(id)
          if (!entry) continue
          if (!pushOrigins.has(id)) pushOrigins.set(id, { x: entry.x, y: entry.y })
          pushed.set(id, point)
        }
        for (const [id, point] of pushed) {
          const origin = pushOrigins.get(id)
          if (!origin) continue
          const element = pushedElements.get(id) ?? itemElementRefs.current.get(id)
            ?? document.querySelector<HTMLElement>(`.canvas-item[data-item-id="${CSS.escape(id)}"]`)
          if (!element) continue
          pushedElements.set(id, element)
          // 直接落位（不再做渐变：手推纸是一比一跟手的，留渐变会有「被拽着」的错觉）
          element.style.transform = `translate3d(${point.x - origin.x}px, ${point.y - origin.y}px, 0)`
          // 登记进 movingElements：收尾时统一清 transform（模型位置已经跟上了，不会跳）
          if (!interaction.movingElements.has(id)) interaction.movingElements.set(id, element)
        }
        interaction.pushedIds = pushed.size ? new Set(pushed.keys()) : undefined
        if (pushed.size) {
          // 粘性集合：这一手势里被推过的卡，全程都排除在对齐/融合/吸附之外。
          // 原因：被推的卡只有「瞬时 DOM 位移」，模型坐标还是旧的（在原来那儿），
          // 拿来做吸附基准就会把拖着的卡吸到它**原来的位置**上 —— 用户 2026-09-17 报
          // 「我远离被推的窗的时候，有的时候他还会吸附过来、还一跳一跳的」。
          const pushedAny = interaction.pushedAny ?? (interaction.pushedAny = new Set<string>())
          for (const id of pushed.keys()) pushedAny.add(id)
          // 被推的卡要让在「手里这张」的下面：把拖着的卡抬到最上层（收尾时还原）
          if (!interaction.raisedZ) {
            const raised = new Map<string, string>()
            for (const id of interaction.movingIds) {
              const element = itemElementRefs.current.get(id)
              if (!element) continue
              raised.set(id, element.style.zIndex)
              element.style.zIndex = '9000'
            }
            interaction.raisedZ = raised
          }
        }
      }
      const primary = itemMap.get(interaction.primaryId)
      const nextPrimary = updates.get(interaction.primaryId)
      if (!primary || !nextPrimary) return
      interaction.clientX = event.clientX; interaction.clientY = event.clientY
      if (primary.kind !== 'workspace') {
        let hitTarget: SurfaceDropTarget | undefined
        for (let index = interaction.surfaceTargets.length - 1; index >= 0; index -= 1) {
          const target = interaction.surfaceTargets[index]
          if (event.clientX >= target.left && event.clientX <= target.right && event.clientY >= target.top && event.clientY <= target.bottom) {
            hitTarget = target
            break
          }
        }
        const crossTarget = hitTarget?.canvasId !== canvas.id ? hitTarget : undefined
        if (crossTarget) {
          interaction.crossTarget = crossTarget; interaction.alignTargetId = undefined; interaction.mergeTargetId = undefined
          setSnapTargetId(null); setMergeTargetId(null); paintBridge(null)
          setCrossGhost({ clientX: event.clientX, clientY: event.clientY, screenW: interaction.screenW, screenH: interaction.screenH, grabX: interaction.grabX, grabY: interaction.grabY, title: primary.title, kind: primary.kind, targetCanvasId: crossTarget.canvasId, itemCount: interaction.movingIds.length })
          return
        }
      }
      interaction.crossTarget = undefined; setCrossGhost(null)
      const movingCenter = { x: nextPrimary.x + primary.w / 2, y: nextPrimary.y + primary.h / 2 }
      let closest: CanvasItem | null = null
      let closestDistance = Infinity
      for (const candidate of canvasItems) {
        if (interaction.movingIds.includes(candidate.id)) continue
        if (interaction.pushedIds?.has(candidate.id) || interaction.pushedAny?.has(candidate.id)) continue
        const center = { x: candidate.x + candidate.w / 2, y: candidate.y + candidate.h / 2 }
        const gapX = Math.max(0, Math.abs(center.x - movingCenter.x) - (primary.w + candidate.w) / 2)
        const gapY = Math.max(0, Math.abs(center.y - movingCenter.y) - (primary.h + candidate.h) / 2)
        const distance = Math.hypot(gapX, gapY)
        const bothCanvases = primary.kind === 'workspace' && candidate.kind === 'workspace'
        const reach = bothCanvases ? 240 : 115
        if (distance < reach && distance < closestDistance) { closest = candidate; closestDistance = distance }
      }
      // 融合目标的判定比对齐严格得多。
      // - 两个同层子画布：文档 6.1 允许单手势水滴融合（不增加层级）。
      // - 两个普通元素：必须是上一次手势已经对齐过的配对，且指针真的进入
      //   了对方的内部命中区，才允许升级为子画布。
      // - L3 已是最深层，任何情况都不再创建下一层。
      let mergeTarget: CanvasItem | null = null
      if (closest) {
        const bothCanvases = primary.kind === 'workspace' && closest.kind === 'workspace'
        if (bothCanvases) mergeTarget = closest
        else if (canvas.level < MAX_CANVAS_LEVEL && alignedPairsRef.current.has(pairKey(primary.id, closest.id))) {
          const surfaceRect = surfaceRef.current?.getBoundingClientRect()
          if (surfaceRect) {
            const pointerX = ((event.clientX - surfaceRect.left) / interaction.outerScale - canvas.viewport.x) / canvas.viewport.scale
            const pointerY = ((event.clientY - surfaceRect.top) / interaction.outerScale - canvas.viewport.y) / canvas.viewport.scale
            const insetX = closest.w * .22
            const insetY = closest.h * .22
            if (pointerX > closest.x + insetX && pointerX < closest.x + closest.w - insetX &&
                pointerY > closest.y + insetY && pointerY < closest.y + closest.h - insetY) mergeTarget = closest
          }
        }
      }
      interaction.alignTargetId = closest?.id
      interaction.mergeTargetId = mergeTarget?.id
      setSnapTargetId(closest?.id ?? null)
      setMergeTargetId(mergeTarget?.id ?? null)
      if (closest) {
        const targetCenter = { x: closest.x + closest.w / 2, y: closest.y + closest.h / 2 }
        const dx = targetCenter.x - movingCenter.x; const dy = targetCenter.y - movingCenter.y
        const sourceFactor = 1 / Math.max(Math.abs(dx) / Math.max(primary.w / 2, 1), Math.abs(dy) / Math.max(primary.h / 2, 1), .001)
        const targetFactor = 1 / Math.max(Math.abs(dx) / Math.max(closest.w / 2, 1), Math.abs(dy) / Math.max(closest.h / 2, 1), .001)
        paintBridge({ a: { x: movingCenter.x + dx * sourceFactor, y: movingCenter.y + dy * sourceFactor }, b: { x: targetCenter.x - dx * targetFactor, y: targetCenter.y - dy * targetFactor } }, Boolean(mergeTarget))
      } else paintBridge(null)
    }
    const up = () => finishInteraction(true)
    const cancel = () => finishInteraction(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', cancel)
    }
  }, [canvas.id, canvas.viewport, canvasItems, itemMap, onInteractionState, onMerge, onMove, onReparent, onResize, onSelect, onUpdateItems, onViewport, startPanInertia])

  const zoomAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    // The cross-canvas hit targets are cached when a drag begins. Zooming while
    // that drag is active would invalidate every cached screen-space rectangle
    // and also change the pointer-to-world mapping underneath the moving item.
    if (organizeActiveRef.current || interactionRef.current?.mode === 'drag') return
    stopPanInertia()
    // Zoom is also an activation gesture. Keep this call paired with the
    // onActivateCanvas dependency so wheel-zooming an inactive child restores
    // the behavior that existed before zoomAt was extracted.
    onActivateCanvas(canvas.id)
    const element = surfaceRef.current
    if (!element) return
    const rect = element.getBoundingClientRect(); const outside = outerScale()
    const mouseX = (clientX - rect.left) / outside; const mouseY = (clientY - rect.top) / outside
    const current = viewportRef.current
    const worldX = (mouseX - current.x) / current.scale; const worldY = (mouseY - current.y) / current.scale
    const scale = clamp(current.scale * Math.exp(-deltaY * .0014), .25, 1.8)
    onViewport(canvas.id, { x: mouseX - worldX * scale, y: mouseY - worldY * scale, scale })
  }, [canvas.id, onActivateCanvas, onViewport, outerScale, stopPanInertia])

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.stopPropagation()
    zoomAt(event.clientX, event.clientY, event.deltaY)
  }, [zoomAt])

  useEffect(() => {
    const ownsSurface = (surfaceId?: string) => surfaceId
      ? itemMap.get(surfaceId)?.canvasId === canvas.id
      : activeCanvasId === canvas.id
    const onGlobalWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || activeCanvasId !== canvas.id) return
      event.preventDefault()
      event.stopImmediatePropagation()
      zoomAt(event.clientX, event.clientY, event.deltaY)
    }
    const onNativeZoom = (event: Event) => {
      const detail = (event as CustomEvent<{ surfaceId?: string; clientX: number; clientY: number; delta: number }>).detail
      if (!detail || !ownsSurface(detail.surfaceId)) return
      zoomAt(detail.clientX, detail.clientY, detail.delta)
    }
    const onNativePan = (event: Event) => {
      const detail = (event as CustomEvent<{ surfaceId?: string; clientX: number; clientY: number; phase: 'begin' | 'move' | 'end' }>).detail
      if (!detail) return
      if (detail.phase === 'begin') {
        if (!ownsSurface(detail.surfaceId) || interactionRef.current) return
        onActivateCanvas(canvas.id)
        stopPanInertia()
        onInteractionState(canvas.id, true)
        const viewport = viewportRef.current
        interactionRef.current = { mode: 'pan', sx: detail.clientX, sy: detail.clientY, vx: viewport.x, vy: viewport.y, outerScale: outerScale() }
        return
      }
      const interaction = interactionRef.current
      if (interaction?.mode !== 'pan') return
      if (detail.phase === 'move') {
        interaction.panSamples = [...(interaction.panSamples ?? []).slice(-5), { t: performance.now(), x: detail.clientX, y: detail.clientY }]
        onViewport(canvas.id, {
          ...viewportRef.current,
          x: interaction.vx + (detail.clientX - interaction.sx) / interaction.outerScale,
          y: interaction.vy + (detail.clientY - interaction.sy) / interaction.outerScale,
        })
      } else {
        onInteractionState(canvas.id, false)
        startPanInertia(interaction.panSamples)
        interactionRef.current = null
      }
    }
    window.addEventListener('wheel', onGlobalWheel, { capture: true, passive: false })
    window.addEventListener(CANVAS_ZOOM_EVENT, onNativeZoom)
    window.addEventListener(CANVAS_PAN_EVENT, onNativePan)
    return () => {
      window.removeEventListener('wheel', onGlobalWheel, true)
      window.removeEventListener(CANVAS_ZOOM_EVENT, onNativeZoom)
      window.removeEventListener(CANVAS_PAN_EVENT, onNativePan)
    }
  }, [activeCanvasId, canvas.id, itemMap, onActivateCanvas, onInteractionState, onViewport, outerScale, zoomAt, startPanInertia, stopPanInertia])

  const fusionPreview = Boolean(draggingId && mergeTargetId)
  const fusionIsCanvasMerge = Boolean(fusionPreview && itemMap.get(draggingId ?? '')?.kind === 'workspace' && itemMap.get(mergeTargetId ?? '')?.kind === 'workspace')
  useLayoutEffect(() => {
    const badge = fusionBadgeRef.current
    const geometry = bridgeGeometryRef.current
    if (!badge || !geometry) return
    badge.style.setProperty('--fusion-x', `${(geometry.a.x + geometry.b.x) / 2}px`)
    badge.style.setProperty('--fusion-y', `${(geometry.a.y + geometry.b.y) / 2}px`)
  }, [fusionPreview])

  // 空画布上的新手引导（只在根画布、且用户还没点过「知道了」时显示）
  const [emptyGuideDismissed, setEmptyGuideDismissed] = useState(() => {
    try { return localStorage.getItem(EMPTY_GUIDE_KEY) === '1' } catch { return false }
  })
  const dismissEmptyGuide = useCallback(() => {
    setEmptyGuideDismissed(true)
    try { localStorage.setItem(EMPTY_GUIDE_KEY, '1') } catch { /* 隐私模式忽略 */ }
  }, [])

  return <><div
    className={`space-surface ${embedded ? 'embedded-space' : 'root-space'} ${activeCanvasId === canvas.id ? 'active-space' : ''} ${highlightedCanvasId === canvas.id ? 'highlight-space' : ''} ${marquee ? 'marquee-active' : ''}`}
    data-canvas-id={canvas.id}
    ref={surfaceRef}
    style={{
      '--canvas-dot-size': `${22 * canvas.viewport.scale}px`,
      '--canvas-dot-x': `${canvas.viewport.x}px`,
      '--canvas-dot-y': `${canvas.viewport.y}px`,
    } as CSSProperties}
    onPointerDownCapture={(event) => { if (event.button === 1) handleSurfaceDown(event) }}
    onPointerDown={handleSurfaceDown}
    onWheel={handleWheel}
    onPointerMove={(event) => { const closest = (event.target as HTMLElement).closest<HTMLElement>('.space-surface'); if (closest === event.currentTarget) onActivateCanvas(canvas.id) }}
    onDoubleClick={(event) => {
      if (!embedded || (event.target as HTMLElement).closest<HTMLElement>('.space-surface') !== event.currentTarget) return
      if (closestItemInSurface(event.target as HTMLElement, event.currentTarget) || (event.target as HTMLElement).closest('.inner-fixedbar,.space-hud')) return
      const host = canvas.hostItemId ? itemMap.get(canvas.hostItemId) : undefined
      if (!host) return
      event.preventDefault()
      event.stopPropagation()
      onToggleWorkspaceFocus(host)
    }}
    onAuxClick={(event) => event.preventDefault()}
    onContextMenu={(event) => {
      // 右键统一上报给 App 弹菜单。命中元素就带上元素 id，命中空白就为 null，
      // 顺带把世界坐标算好，「在此生成」这类菜单项要用。
      if ((event.target as HTMLElement).closest<HTMLElement>('.space-surface') !== event.currentTarget) return
      if ((event.target as HTMLElement).closest('.inner-fixedbar,.space-hud')) return
      event.preventDefault()
      event.stopPropagation()
      const hit = closestItemInSurface(event.target as HTMLElement, event.currentTarget)
      const rect = event.currentTarget.getBoundingClientRect()
      const scaleOutside = outerScale()
      const localX = (event.clientX - rect.left) / scaleOutside
      const localY = (event.clientY - rect.top) / scaleOutside
      onActivateCanvas(canvas.id)
      const itemId = hit?.dataset.itemId ?? null
      if (itemId && !selectedIds.includes(itemId)) {
        const entry = itemMap.get(itemId)
        if (entry) selectItem(entry, false)
      }
      onContextMenu?.({
        canvasId: canvas.id,
        itemId,
        clientX: event.clientX,
        clientY: event.clientY,
        worldX: (localX - canvas.viewport.x) / canvas.viewport.scale,
        worldY: (localY - canvas.viewport.y) / canvas.viewport.scale,
      })
    }}
  >
    {embedded ? <div className="inner-fixedbar inner-title-only workspace-drag-handle" onContextMenu={(event) => {
      // 画布卡里「新画布」这行标题就是这里 —— 右键出元素菜单（含「修改名称…」）
      const host = canvas.hostItemId ? itemMap.get(canvas.hostItemId) : undefined
      if (!host) return
      event.preventDefault()
      event.stopPropagation()
      window.dispatchEvent(new CustomEvent('zhangzhongjie-titlebar-menu', { detail: { itemId: host.id, clientX: event.clientX, clientY: event.clientY } }))
    }} onDoubleClick={(event) => {
      if ((event.target as HTMLElement).closest('.canvas-title,button')) return
      const host = canvas.hostItemId ? itemMap.get(canvas.hostItemId) : undefined
      if (!host) return
      event.preventDefault()
      event.stopPropagation()
      onToggleWorkspaceFocus(host)
    }}><span className="inner-level" onPointerDown={(event) => event.stopPropagation()}>L{canvas.level}</span><EditableCanvasTitle canvas={canvas} onRename={onRenameCanvas} onOpen={() => {
      const host = canvas.hostItemId ? itemMap.get(canvas.hostItemId) : undefined
      if (host) onToggleWorkspaceFocus(host)
    }}/><span className="inner-depth" onPointerDown={(event) => event.stopPropagation()}>{`L${canvas.level}`}</span>{canvas.generated ? <button className="dissolve-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => onDissolve(canvas.id)}>拆散</button> : null}</div> : null}
    <div className="space-world" style={{ transform: `translate3d(${canvas.viewport.x}px, ${canvas.viewport.y}px, 0) scale(${canvas.viewport.scale})` }}>
      {spawnAnchor && spawnAnchor.canvasId === canvas.id ? <div className="spawn-anchor" style={{ left: spawnAnchor.x, top: spawnAnchor.y, transform: `translate(-50%, -50%) scale(${1 / Math.max(canvas.viewport.scale, .05)})` }}><i>{uiIcon('pin', 18)}</i><span>生成点</span></div> : null}
      {Array.from({ length: 6 }, (_, index) => <div key={index} ref={(element) => { guideRefs.current[index] = element }} className="align-guide" style={{ visibility: 'hidden' }}/>)}
      <div ref={bridgeRef} className="liquid-bridge" style={{ visibility: 'hidden', animationPlayState: 'paused' }}/>
      {fusionPreview ? <div ref={fusionBadgeRef} className="canvas-fusion-badge"><span>◉</span><b>{fusionIsCanvasMerge ? '松开融合两个画布' : '松开创建子画布'}</b><small>{fusionIsCanvasMerge ? '内容会进入同一个大画布，层级不增加' : '两个元素会进入下一层子画布'}</small></div> : null}
      {!embedded && !canvasItems.length && !emptyGuideDismissed ? createPortal(
        <div className="empty-guide-layer">
        <div className="empty-guide" onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
          <b>空空如也 —— 三下就会用</b>
          <ol>
            <li>在空白处<b>右键</b> → 新建便签 / 网页 / 文件夹</li>
            <li>鼠标移到卡片上 → 上方浮出<b>标题栏</b> → 按住就能拖</li>
            <li>左栏点<b>「模板」</b> 一键开工；想看完整说明 → <b>设置 → 使用手册</b></li>
          </ol>
          <div className="empty-guide-actions">
            <button onClick={dismissEmptyGuide}>知道了</button>
            <button className="primary" onClick={() => window.chrome?.webview?.postMessage({ type: 'native-open-manual' })}>打开使用手册</button>
          </div>
        </div>
        </div>,
        // 必须挂到画布视口层：画布内容在 .space-world 里、带 transform，
        // 放进那儿的话 absolute/fixed 的参照物会变成世界坐标，永远居不了中（实测踩过）
        document.querySelector('.canvas-viewport') ?? document.body,
      ) : null}
      {canvasItems.map((item) => {
        const childCanvas = item.childCanvasId ? spaces.find((entry) => entry.id === item.childCanvasId) : undefined
        const silent = Boolean(childCanvas && sleepingCanvasIds.has(childCanvas.id))
        const focusHidden = focusedWorkspaceId === item.id
        const childSurface = childCanvas && !focusHidden ? <SpatialSurface {...props} canvas={childCanvas} embedded/> : undefined
        // 文件管理器和浏览器窗口最大化后分的屏，还原回画布同样要保留（§7：退出
        // 最大化只恢复外框，最大化期间建立的分屏和内容继续保留）。之前分屏树只在
        // 最大化舞台里画，还原后就退回没分屏的样子了。
        const ownSplit = !childCanvas && item.workspaceSplit && (item.kind === 'folder' || item.kind === 'web')
          ? <SplitTreeView layout={item.workspaceSplit} primary={<ItemBody item={item} audible={activeSound === item.id} paintOrder={surfacePaintOrder.get(item.id) ?? 0}/>} interactive={false} resizable onChange={(layout) => onWorkspaceSplit(item.id, layout)} onPushHistory={onPushHistory}/>
          : undefined
        const childContent = focusHidden ? undefined : childCanvas ? silent ? <CanvasSnapshot canvas={childCanvas} items={items}/> : item.workspaceSplit && childSurface ? <SplitTreeView layout={item.workspaceSplit} primary={childSurface} interactive={false} resizable onChange={(layout) => onWorkspaceSplit(item.id, layout)} onPushHistory={onPushHistory}/> : childSurface : undefined
        return <CanvasWindow key={item.id} item={item} paintOrder={surfacePaintOrder.get(item.id) ?? 0} selected={selectedIds.includes(item.id)} audible={activeSound === item.id} snapTarget={snapTargetId === item.id} dragging={draggingId === item.id} fusionSource={fusionPreview && draggingId === item.id} silent={silent} focusHidden={focusHidden} cardTitlebarVisibility={cardTitlebarVisibility} elementRegistry={itemElementRefs} onPointerDown={handleItemDown} onResizeDown={handleResizeDown} onPin={(entry) => onPin(canvas.id, entry)} onClose={closeFromSurface} onActivate={onActivateItem} onDoubleClick={onDoubleClick} onToggleWorkspaceFocus={onToggleWorkspaceFocus} onExitSplit={(entry) => { onPushHistory(); onWorkspaceSplit(entry.id, undefined) }} onWake={childCanvas ? () => { onWakeCanvas(childCanvas.id); onActivateCanvas(childCanvas.id) } : undefined} onIdle={childCanvas ? () => onIdleCanvas(childCanvas.id) : undefined}>
          {childContent ?? ownSplit}
        </CanvasWindow>
      })}
      {splitPairs.map(({ groupId, first, second, orientation }) => {
        const style: CSSProperties = orientation === 'columns'
          ? { left: first.x + first.w + (second.x - first.x - first.w) / 2, top: Math.min(first.y, second.y), height: Math.max(first.y + first.h, second.y + second.h) - Math.min(first.y, second.y) }
          : { left: Math.min(first.x, second.x), top: first.y + first.h + (second.y - first.y - first.h) / 2, width: Math.max(first.x + first.w, second.x + second.w) - Math.min(first.x, second.x) }
        return <button key={groupId} className={`split-divider divider-${orientation}`} style={style} aria-label={orientation === 'columns' ? '调整左右分屏比例' : '调整上下分屏比例'} onPointerDown={(event) => handleSplitDown(event, first, second, orientation)}><i/><span>{orientation === 'columns' ? '↔' : '↕'}</span></button>
      })}
    </div>
    {pinnedItems.length ? <div className="space-pinned-layer">{pinnedItems.map((item) => <CanvasWindow key={item.id} item={item} paintOrder={surfacePaintOrder.get(item.id) ?? 0} selected={selectedIds.includes(item.id)} audible={activeSound === item.id} snapTarget={false} cardTitlebarVisibility={cardTitlebarVisibility} elementRegistry={itemElementRefs} onPointerDown={handleItemDown} onResizeDown={handleResizeDown} onPin={(entry) => onPin(canvas.id, entry)} onClose={closeFromSurface} onActivate={onActivateItem} onDoubleClick={onDoubleClick} onToggleWorkspaceFocus={onToggleWorkspaceFocus} onExitSplit={(entry) => { onPushHistory(); onWorkspaceSplit(entry.id, undefined) }}/>)}</div> : null}
    {marquee ? <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}/> : null}
    <div className="space-hud"><span className="level-dot">L{canvas.level}</span><b>{canvas.title}</b><span>{Math.round(canvas.viewport.scale * 100)}%</span>{canvas.level === MAX_CANVAS_LEVEL ? <em>已到最深层</em> : null}</div>
  </div>{crossGhost ? createPortal(<div className="cross-canvas-ghost" data-cross-target={crossGhost.targetCanvasId} style={{ left: crossGhost.clientX - crossGhost.screenW * crossGhost.grabX, top: crossGhost.clientY - crossGhost.screenH * crossGhost.grabY, width: crossGhost.screenW, height: crossGhost.screenH }}><span className="ghost-kind">{crossGhost.kind === 'folder' ? '▰' : crossGhost.kind === 'video' ? '▶' : crossGhost.kind === 'reference' ? '▧' : crossGhost.kind === 'note' ? '≡' : '◎'}</span><div><b>{crossGhost.title}</b><small>{crossGhost.itemCount > 1 ? `${crossGhost.itemCount} 个成组元素 · ` : ''}释放到 {spaces.find((entry) => entry.id === crossGhost.targetCanvasId)?.title ?? '外层画布'}</small></div><em>跨层移动</em></div>, document.body) : null}</>
})

function SplitIcon({ kind }: { kind: LayoutKind }) {
  return <span className={`split-icon split-${kind}`}><i/><i/><i/><i/></span>
}

function FileToolbarSplitIcon({ orientation }: { orientation: 'columns' | 'rows' }) {
  return <span className={`fm-split-icon is-${orientation}`} aria-hidden="true"><i/><i/></span>
}

function SuperPreview({ item, canvas, breadcrumb, onClose }: {
  item: CanvasItem
  canvas: SpaceCanvas
  breadcrumb: SpaceCanvas[]
  onClose: () => void
}) {
  const lastMiddleClickRef = useRef(0)
  const canvasTrail = breadcrumb.length ? breadcrumb : [canvas]
  const previewContent = item.kind === 'image' && item.dataUrl
    ? <img className="shell-preview-image" src={item.dataUrl} alt={item.title}/>
    : item.kind === 'note'
      ? <pre className="shell-preview-text">{item.text || ''}</pre>
      : <div className="preview-card"><small>{ITEM_KIND_LABELS[item.kind]}</small><h3>{item.title}</h3>{item.subtitle ? <p>{item.subtitle}</p> : null}{(item.kind === 'web' || item.kind === 'video') && item.source ? <p className="preview-path">{item.source}</p> : null}</div>

  const handleMiddleClick = (event: ReactPointerEvent) => {
    if (event.button !== 1) return
    event.preventDefault()
    const now = performance.now()
    if (now - lastMiddleClickRef.current < 360) {
      lastMiddleClickRef.current = 0
      onClose()
    } else lastMiddleClickRef.current = now
  }

  return createPortal(<div
    className="modal-backdrop preview-backdrop"
    onPointerDown={handleMiddleClick}
    onAuxClick={(event) => event.preventDefault()}
    onDoubleClick={(event) => { if (event.target === event.currentTarget) onClose() }}
  >
    <section className="super-preview" onDoubleClick={(event) => {
      const target = event.target as HTMLElement
      if (target.closest('article,button,.preview-tree-node')) return
      onClose()
    }}>
      <header>
        <div><span>{uiIcon(item.kind === 'note' ? 'document' : item.kind === 'web' || item.kind === 'video' ? 'eye' : item.kind === 'image' ? 'image' : 'grid', 23)}</span><b>{item.title}</b><small>画布位置：{canvasTrail.map((entry) => entry.title).join(' / ')}</small></div>
        <button onClick={onClose}>{uiIcon('close', 18)}</button>
      </header>
      <div className="preview-layout">
        <nav className="preview-tree" aria-label="当前卡片画布位置">
          <strong>画布位置</strong>
          <small>掌中界中的真实层级</small>
          {canvasTrail.map((entry, index) => <button
            key={entry.id}
            disabled
            className={`preview-tree-node ${index === canvasTrail.length - 1 ? 'active' : ''}`}
            style={{ '--tree-depth': index } as CSSProperties}
          ><i>{uiIcon('grid', 13)}</i><span>{entry.title}</span></button>)}
        </nav>
        <article>{previewContent}</article>
        <aside>
          <b>卡片</b><span className="preview-property" data-label="名称">{item.title}</span><span className="preview-property" data-label="类型">{ITEM_KIND_LABELS[item.kind]}</span>
          {(item.kind === 'web' || item.kind === 'video') && item.source ? <span className="preview-property" data-label="网址">{item.source}</span> : null}
          {item.subtitle ? <span className="preview-property" data-label="说明">{item.subtitle}</span> : null}
          <hr/><b>画布位置</b><span className="preview-property" data-label="层级">L{canvas.level}</span><span className="preview-property" data-label="父画布">{breadcrumb.at(-2)?.title ?? '无'}</span>
        </aside>
      </div>
      <footer><ShortcutText id="preview.toggle"/> 关闭预览　·　双击空白或双击鼠标滚轮返回</footer>
    </section>
  </div>, previewOverlayRoot())
}

const ArchivePreviewItem = memo(function ArchivePreviewItem({ child, thumbnail, onVisible, onOpen }: {
  child: NonNullable<ShellPreviewData['children']>[number]
  thumbnail?: string
  onVisible: (path: string, visible: boolean) => void
  onOpen?: (child: NonNullable<ShellPreviewData['children']>[number]) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const canThumbnail = shouldRequestShellImage(child)
  useEffect(() => {
    const row = rowRef.current
    if (!row || !canThumbnail || !child.path) return
    const root = row.closest('.shell-preview-archive-list')
    const observer = new IntersectionObserver(([entry]) => onVisible(child.path, entry.isIntersecting), { root, rootMargin: '220px 0px' })
    observer.observe(row)
    return () => { observer.disconnect(); onVisible(child.path, false) }
  }, [canThumbnail, child.path, onVisible])
  return <div ref={rowRef} className="shell-preview-archive-row" onDoubleClick={(event) => { event.stopPropagation(); if (!child.folder) onOpen?.(child) }}>
    <span>{thumbnail ? <img src={thumbnail} alt=""/> : child.image ? <img src={child.image} alt=""/> : uiIcon(child.folder ? 'folder' : 'file', 22)}</span>
    <b title={child.name}>{child.name}</b><small>{child.folder ? '文件夹' : child.typeText || '文件'}</small><small>{child.folder ? '—' : formatShellSize(child.size)}</small>
  </div>
})

const ShellImagePreview = memo(function ShellImagePreview({ display }: { display: ShellPreviewData }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const extension = display.name.toLocaleLowerCase().match(/(\.[^.]+)$/)?.[1] ?? ''
  const thumbnailOnly = /\.(tif|tiff|raw|cr2|nef|arw)$/.test(extension)
  const large = display.size > 20 * 1024 * 1024 || Math.max(display.width ?? 0, display.height ?? 0) > 8000
  useEffect(() => setStatus('loading'), [display.path, display.resource])
  if (thumbnailOnly) return <div className="shell-preview-image-state">
    {display.image ? <img className="shell-preview-thumbnail" src={display.image} alt={display.name}/> : uiIcon('image', 58)}
    <span>仅缩略图</span>
  </div>
  return <div className={`shell-preview-image-stage is-${status}`}>
    {large && status === 'loading' && display.image ? <img className="shell-preview-image-placeholder" src={display.image} alt=""/> : null}
    {display.resource && status !== 'failed' ? <img className="shell-preview-image" src={display.resource} alt="" onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')}/> : null}
    {status === 'failed' || !display.resource ? <div className="shell-preview-image-state">
      {display.image ? <img className="shell-preview-thumbnail" src={display.image} alt=""/> : uiIcon('image', 58)}
      <b>无法读取原图</b><span>{display.resource ? '文件可能已损坏，或当前格式无法由浏览器解码。' : '没有取得安全的本地资源地址。'}</span>
    </div> : null}
  </div>
})

type PreviewBreadcrumb = { label: string; path?: string; current?: boolean }

function previewBreadcrumbs(path: string): PreviewBreadcrumb[] {
  const nodes: PreviewBreadcrumb[] = [{ label: '此电脑', path: 'shell:MyComputerFolder' }]
  const trimmed = path.trim()
  if (!trimmed || trimmed === 'shell:MyComputerFolder') return nodes
  if (/^[A-Za-z]:[\\/]?/.test(trimmed)) {
    const parts = trimmed.replace(/\//g, '\\').split(/\\+/).filter(Boolean)
    let current = ''
    for (const [index, part] of parts.entries()) {
      current = index === 0 ? `${part}\\` : `${current.replace(/\\$/, '')}\\${part}`
      nodes.push({ label: part, path: current })
    }
  } else {
    nodes.push({ label: trimmed.replace(/^::\{[^}]+\}/, 'Windows Shell'), path: trimmed })
  }
  return nodes
}

// 预览浮层的挂载点：挂到 .app 根节点上。
// ① 不再挂在卡片子树里 → 卡片的毛玻璃（backdrop-filter）不会再"抓住"它造成定位偏移；
// ② 仍然在 .app 作用域内 → --panel/--bg/--line/--text 这些主题变量还在（挂 body 会丢，面板会变透明、栅格会塌）。
function previewOverlayRoot(): Element {
  return document.querySelector('main.app') ?? document.querySelector('.app') ?? document.body
}

function ShellSuperPreview({ target, data, onClose, onOpenContent, onOpenLocation, onPreviewFile, onSiblingsChange, onFavorite }: {
  target: ShellPreviewTarget
  data: ShellPreviewData | null
  onClose: () => void
  onOpenContent: () => void
  onOpenLocation: () => void
  onPreviewFile: (entry: ShellEntry, siblings: ShellEntry[]) => void
  onSiblingsChange: (siblings: ShellEntry[]) => void
  onFavorite: (target: 'file' | 'folder') => void
}) {
  const [previewShortcuts, setPreviewShortcuts] = useState(() => readBrowserSettings().shortcutBindings)
  useEffect(() => {
    const receive = (event: Event) => {
      const settings = (event as CustomEvent<AppSettings>).detail
      setPreviewShortcuts(settings.shortcutBindings)
      setPreviewNameWidth(settings.previewNameColumnWidth)
    }
    window.addEventListener(APP_SETTINGS_EVENT, receive)
    return () => window.removeEventListener(APP_SETTINGS_EVENT, receive)
  }, [])
  // Esc 关闭超级预览（捕获阶段监听，无论焦点在哪都能关掉；与主流预览工具习惯一致）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])
  const [showFavoriteMenu, setShowFavoriteMenu] = useState(false)
  const [locationPath, setLocationPath] = useState('')
  const [locationEntries, setLocationEntries] = useState<ShellEntry[]>([])
  const [locationLoading, setLocationLoading] = useState(false)
  const [showPreviewCrumb, setShowPreviewCrumb] = useState(true)
  const [previewNameWidth, setPreviewNameWidth] = useState(() => readBrowserSettings().previewNameColumnWidth)
  const [archiveThumbnails, setArchiveThumbnails] = useState<Map<string, string>>(new Map())
  const visibleArchivePathsRef = useRef<Set<string>>(new Set())
  const archiveThumbnailFrameRef = useRef<number | null>(null)
  const lastMiddleClickRef = useRef(0)
  const previewRef = useRef<HTMLElement>(null)
  const locationRef = useRef<HTMLElement>(null)
  const locationRequestRef = useRef('')
  const columnResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null)
  const display = data ?? {
    surfaceId: target.surfaceId,
    path: target.entry.path,
    parentPath: '',
    name: target.entry.name,
    typeText: target.entry.typeText,
    modified: target.entry.modified,
    size: target.entry.size,
    previewKind: 'thumbnail' as const,
    image: target.entry.image,
  }
  const unsupportedArchive = unsupportedArchiveExtension(display.path || display.name)
  // 兜底：把预览面板钉在窗口正中。浮层会被祖先容器（卡片、毛玻璃、分屏格子）影响，
  // 所以打开时和窗口尺寸变化时实测一次，偏了就平移回来，保证永远正中。
  useEffect(() => {
    const fix = () => {
      const element = previewRef.current
      if (!element) return
      element.style.transform = ''
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dx = Math.round(window.innerWidth / 2 - (rect.left + rect.width / 2))
      const dy = Math.round(window.innerHeight / 2 - (rect.top + rect.height / 2))
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) element.style.transform = `translate(${dx}px, ${dy}px)`
    }
    fix()
    const timer = window.setTimeout(fix, 320)
    window.addEventListener('resize', fix)
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', fix) }
  }, [display.path])
  const pathNodes = useMemo(() => {
    const nodes = previewBreadcrumbs(locationPath)
    if (showPreviewCrumb && locationPath.toLocaleLowerCase() === display.parentPath.toLocaleLowerCase()) {
      nodes.push({ label: display.name, current: true })
    } else if (nodes.length) nodes[nodes.length - 1] = { ...nodes[nodes.length - 1], current: true }
    return nodes
  }, [display.name, display.parentPath, locationPath, showPreviewCrumb])

  useEffect(() => {
    setLocationPath(display.parentPath || 'shell:MyComputerFolder')
    setShowPreviewCrumb(true)
  }, [display.parentPath, display.path])

  useEffect(() => {
    visibleArchivePathsRef.current.clear()
    setArchiveThumbnails(new Map())
    if (unsupportedArchive) notifyUnsupportedArchive(display.path || display.name)
  }, [display.name, display.path, unsupportedArchive])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const onThumbnail = (event: MessageEvent<NativeHostMessage>) => {
      const message = event.data
      if (message?.type !== 'native-shell-preview-thumbnail' || message.surfaceId !== target.surfaceId || !message.path || !message.image) return
      setArchiveThumbnails((current) => {
        if (current.get(message.path!) === message.image) return current
        const next = new Map(current)
        next.set(message.path!, message.image!)
        return next
      })
    }
    bridge.addEventListener('message', onThumbnail)
    return () => bridge.removeEventListener('message', onThumbnail)
  }, [target.surfaceId])

  const updateArchiveThumbnailVisibility = useCallback((path: string, visible: boolean) => {
    if (visible) visibleArchivePathsRef.current.add(path)
    else visibleArchivePathsRef.current.delete(path)
    if (archiveThumbnailFrameRef.current !== null) return
    archiveThumbnailFrameRef.current = requestAnimationFrame(() => {
      archiveThumbnailFrameRef.current = null
      window.chrome?.webview?.postMessage({
        type: 'native-shell-preview-thumbnails-request',
        surfaceId: target.surfaceId,
        paths: [...visibleArchivePathsRef.current],
      })
    })
  }, [target.surfaceId])

  useEffect(() => () => {
    if (archiveThumbnailFrameRef.current !== null) cancelAnimationFrame(archiveThumbnailFrameRef.current)
    visibleArchivePathsRef.current.clear()
  }, [])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !locationPath) return
    const requestId = `preview-location-${crypto.randomUUID()}`
    locationRequestRef.current = requestId
    setLocationLoading(true)
    const onMessage = (event: MessageEvent<NativeHostMessage>) => {
      const message = event.data
      if (message?.type !== 'native-shell-preview-location' || message.surfaceId !== target.surfaceId ||
          message.requestId !== locationRequestRef.current || message.path !== locationPath) return
      const nextEntries = message.entries ?? []
      setLocationEntries(nextEntries)
      setLocationLoading(false)
      onSiblingsChange(nextEntries.filter((entry) => !entry.folder))
    }
    bridge.addEventListener('message', onMessage)
    bridge.postMessage({ type: 'native-shell-preview-location-request', surfaceId: target.surfaceId, path: locationPath, requestId })
    return () => bridge.removeEventListener('message', onMessage)
  }, [locationPath, onSiblingsChange, target.surfaceId])

  useLayoutEffect(() => {
    const active = locationRef.current?.querySelector<HTMLElement>('.preview-location-row.active')
    active?.scrollIntoView({ block: 'nearest' })
    // 面包屑超宽时默认展示路径尾部（当前目录最重要），可横向滚动查看开头
    const breadcrumb = locationRef.current?.querySelector<HTMLElement>('.preview-location-breadcrumb')
    if (breadcrumb) breadcrumb.scrollLeft = breadcrumb.scrollWidth
  }, [display.path, locationEntries])

  const locationFiles = useMemo(() => locationEntries.filter((entry) => !entry.folder), [locationEntries])
  const browseLocation = (path: string) => { setShowPreviewCrumb(false); setLocationPath(path) }
  const selectLocationEntry = (entry: ShellEntry) => {
    if (entry.folder) { browseLocation(entry.path); return }
    onPreviewFile(entry, locationFiles)
  }
  const openArchiveChild = (child: NonNullable<ShellPreviewData['children']>[number]) => {
    const siblings = (display.children ?? []).filter((entry) => !entry.folder).map((entry): ShellEntry => ({
      ...entry, modified: '', hidden: false, shortcut: false,
    }))
    const entry = siblings.find((candidate) => candidate.path === child.path)
    if (entry) onPreviewFile(entry, siblings)
  }

  const persistPreviewNameWidth = (width: number) => {
    const rounded = Math.round(width)
    setPreviewNameWidth(rounded)
    publishSettingsPatch({ previewNameColumnWidth: rounded })
  }

  // Markdown 文档（.md/.markdown）渲染为排版文档。DOMPurify 过滤文档里的内联
  // HTML/事件属性（文档可能来自网络）；链接一律拦截，只允许系统浏览器打开。
  const markdownHtml = useMemo(() => {
    if (display.previewKind !== 'text' || !display.text) return null
    if (!/\.(md|markdown)$/i.test(display.name || '')) return null
    try {
      const rendered = marked.parse(display.text, { async: false, gfm: true, breaks: true }) as string
      // 宽表格包一层横向滚动容器（GitHub 式），避免列被压窄后中文折行
      const wrapped = rendered.replace(/<table>/g, '<div class="md-table-scroll"><table>').replace(/<\/table>/g, '</table></div>')
      return DOMPurify.sanitize(wrapped, { USE_PROFILES: { html: true } })
    } catch {
      return null
    }
  }, [display.name, display.previewKind, display.text])
  const onMarkdownClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    const href = anchor.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) window.chrome?.webview?.postMessage({ type: 'native-open-path', path: href })
  }
  const previewContent = display.previewKind === 'archive'
    ? <div className="shell-preview-archive">
        <header><span>{uiIcon('archive', 27)}</span><div><b>{display.name}</b><small>{display.children?.length ?? 0} 个项目</small></div></header>
        <div className="shell-preview-archive-head"><b>名称</b><b>类型</b><b>大小</b></div>
        <div className="shell-preview-archive-list" onWheel={stopWheelPropagation}>{display.children?.length
          ? display.children.map((child, index) => <ArchivePreviewItem key={`${child.path}-${index}`} child={child} thumbnail={archiveThumbnails.get(child.path)} onVisible={updateArchiveThumbnailVisibility} onOpen={openArchiveChild}/>)
          : <i>压缩包为空，或 Windows 无法枚举其内容。</i>}</div>
      </div>
    : display.previewKind === 'folder'
    ? <div className="shell-preview-folder" onWheel={stopWheelPropagation}>
        <header><span>{uiIcon('folder', 28)}</span><div><b>{display.name}</b><small>{display.children?.length ? `显示前 ${display.children.length} 项` : '文件夹内容'}</small></div></header>
        <div>{display.children?.length ? display.children.map((child, index) => <span key={`${child.name}-${index}`}>
          {child.image ? <img src={child.image} alt=""/> : uiIcon(child.folder ? 'folder' : 'file', 24)}
          <b>{child.name}</b><small>{child.folder ? (child.typeText || '文件夹') : `${child.typeText || '文件'} · ${formatShellSize(child.size)}`}</small>
        </span>) : <i>此文件夹为空，或暂时无法读取内容。</i>}</div>
      </div>
    : display.previewKind === 'image'
    ? <ShellImagePreview display={display}/>
    : display.previewKind === 'video' && display.resource
      ? <video className="shell-preview-media" src={display.resource} controls autoPlay={false} preload="auto"/>
      : display.previewKind === 'audio' && display.resource
        ? <div className="shell-preview-audio">{display.image ? <img src={display.image} alt=""/> : uiIcon('file', 64)}<audio src={display.resource} controls/></div>
        : display.previewKind === 'pdf' && display.resource
          ? <iframe className="shell-preview-pdf" src={display.resource} title={display.name}/>
          : display.previewKind === 'text'
            ? (markdownHtml !== null
              ? <div className="shell-preview-markdown" onWheel={stopWheelPropagation} onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: markdownHtml }}/>
              : <pre className="shell-preview-text" onWheel={stopWheelPropagation}>{display.text || '此文本为空，或编码暂时无法识别。'}</pre>)
            : unsupportedArchive
              ? <div className="shell-preview-unavailable unsupported-archive-preview">{uiIcon('archive', 58)}<b>{display.typeText || `${unsupportedArchive} 压缩文件`}</b><span>{UNSUPPORTED_ARCHIVE_PREVIEW_MESSAGE}</span></div>
            : display.image
              ? <div className="shell-preview-image-state"><img className="shell-preview-thumbnail" src={display.image} alt={display.name}/>{/\.(tif|tiff|raw|cr2|nef|arw)$/i.test(display.name) ? <span>仅缩略图</span> : null}</div>
              : <div className="shell-preview-unavailable">{uiIcon('file', 58)}<b>暂无可用预览</b><span>双击用系统默认程序打开</span></div>

  const handleMiddleClick = (event: ReactPointerEvent) => {
    if (event.button !== 1) return
    event.preventDefault()
    const now = performance.now()
    if (now - lastMiddleClickRef.current < 360) { lastMiddleClickRef.current = 0; onClose() }
    else lastMiddleClickRef.current = now
  }

  return createPortal(<div className="modal-backdrop preview-backdrop" onPointerDown={handleMiddleClick} onAuxClick={(event) => event.preventDefault()} onDoubleClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={previewRef} className="super-preview shell-super-preview" style={{ '--preview-name-width': `${previewNameWidth}px` } as CSSProperties} onDoubleClick={(event) => {
      const element = event.target as HTMLElement
      if (element.closest('.shell-preview-content,button')) return
      onClose()
    }}>
      <header><div>{display.image ? <img src={display.image} alt=""/> : <span>{uiIcon('file', 23)}</span>}<b>{display.name}</b><small>{display.parentPath || 'Windows Shell 位置'}</small></div><button onClick={onClose}>{uiIcon('close', 18)}</button></header>
      <div className="preview-layout">
        <nav ref={locationRef} className="preview-tree preview-location" aria-label="当前文件所在位置" tabIndex={0} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={stopWheelPropagation}>
          <div className="preview-location-breadcrumb" aria-label="位置路径">{pathNodes.map((node, index) => <span key={`${node.path ?? display.path}-${index}`} className={node.current ? 'current' : ''}>
            {index ? <i aria-hidden="true">›</i> : null}<button disabled={!node.path || node.current} title={node.label} onClick={() => node.path && browseLocation(node.path)}>{node.label}</button>
          </span>)}</div>
          <small className="preview-location-note">浏览所在文件夹；切换位置不会改变当前预览</small>
          <div className="preview-location-head" role="row">
            <button>名称<i
              className="preview-tree-resizer"
              role="separator"
              aria-orientation="vertical"
              title="拖动调整名称列宽；双击恢复默认"
              onPointerDown={(event) => {
                event.stopPropagation()
                const header = event.currentTarget.parentElement
                if (!header) return
                const startWidth = header.getBoundingClientRect().width
                columnResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                const resize = columnResizeRef.current
                if (!resize || resize.pointerId !== event.pointerId) return
                resize.width = clamp(resize.startWidth + event.clientX - resize.startX, 100, 410)
                previewRef.current?.style.setProperty('--preview-name-width', `${resize.width}px`)
              }}
              onPointerUp={(event) => {
                const resize = columnResizeRef.current
                if (!resize || resize.pointerId !== event.pointerId) return
                event.preventDefault(); event.stopPropagation()
                columnResizeRef.current = null
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                persistPreviewNameWidth(resize.width)
              }}
              onPointerCancel={(event) => {
                if (columnResizeRef.current?.pointerId !== event.pointerId) return
                columnResizeRef.current = null
                previewRef.current?.style.setProperty('--preview-name-width', `${previewNameWidth}px`)
              }}
              onDoubleClick={(event) => {
                event.preventDefault(); event.stopPropagation()
                previewRef.current?.style.setProperty('--preview-name-width', '210px')
                persistPreviewNameWidth(210)
              }}
              onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
            /></button>
            <button>大小</button>
          </div>
          <div className="preview-location-list" onWheel={stopWheelPropagation}>
            {locationEntries.map((entry) => <button key={entry.path} data-preview-path={entry.path} className={`preview-location-row ${entry.path === display.path ? 'active' : ''}`} onClick={() => selectLocationEntry(entry)}>
              <span>{uiIcon(entry.folder ? 'folder' : 'file', 14)}<b title={entry.name}>{entry.name}</b></span><small>{entry.folder ? '—' : formatShellSize(entry.size)}</small>
            </button>)}
            {locationLoading ? <i className="preview-location-empty">正在读取当前文件夹…</i> : !locationEntries.length ? <i className="preview-location-empty">此位置没有可显示的条目</i> : null}
          </div>
        </nav>
        <article className="shell-preview-content" onDoubleClick={(event) => { event.stopPropagation(); onOpenContent() }}>{previewContent}</article>
        <aside><div className="preview-actions"><div className="favorite-action"><button onClick={() => setShowFavoriteMenu((value) => !value)}>{uiIcon('star', 15)} 收藏</button>{showFavoriteMenu ? <div className="favorite-menu"><button onClick={() => { onFavorite('file'); setShowFavoriteMenu(false) }}>收藏当前文件</button><button onClick={() => { onFavorite('folder'); setShowFavoriteMenu(false) }}>收藏所在文件夹</button></div> : null}</div><button className="primary" onClick={onOpenLocation}>{uiIcon('folder', 15)} 打开位置</button></div><b>属性</b><span className="preview-property" data-label="文件名">{display.name || '—'}</span><span className="preview-property" data-label="类型">{display.typeText || 'Windows Shell 项目'}</span><span className="preview-property" data-label="创建时间">{display.created || '—'}</span><span className="preview-property" data-label="修改时间">{display.modified || '—'}</span><span className="preview-property" data-label="大小">{display.previewKind === 'folder' ? (display.folderTotalSize === undefined ? '—' : formatShellSize(display.folderTotalSize)) : formatShellSize(display.size)}</span><span className="preview-property" data-label="只读">{display.readOnly === undefined ? '—' : display.readOnly ? '是' : '否'}</span><span className="preview-property" data-label="隐藏">{display.hidden === undefined ? '—' : display.hidden ? '是' : '否'}</span>
          {display.previewKind === 'folder' ? <><hr/><b>文件夹内容</b><span className="preview-property" data-label="文件">{display.folderFileCount ?? '—'}</span><span className="preview-property" data-label="文件夹">{display.folderFolderCount ?? '—'}</span><span className="preview-property" data-label="总大小">{display.folderTotalSize === undefined ? '—' : formatShellSize(display.folderTotalSize)}</span></> : null}
          {display.previewKind === 'image' ? <><hr/><b>图像</b><span className="preview-property" data-label="分辨率">{display.width && display.height ? `${display.width} × ${display.height}` : '—'}</span><span className="preview-property" data-label="色彩模式">{display.colorMode || '—'}</span></> : null}
          {display.previewKind === 'video' ? <><hr/><b>视频</b><span className="preview-property" data-label="时长">{formatMediaDuration(display.durationMs) || '—'}</span><span className="preview-property" data-label="分辨率">{display.width && display.height ? `${display.width} × ${display.height}` : '—'}</span><span className="preview-property" data-label="编码">{display.codec || '—'}</span></> : null}
          {display.pageCount !== undefined && display.pageCount > 0 ? <><hr/><b>文档</b><span className="preview-property" data-label="页数">{display.pageCount}</span></> : null}
          <hr/><b>真实路径</b><span className="preview-path">{display.path}</span></aside>
      </div>
      <footer><button type="button" className="preview-external-open" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpenContent() }}>{uiIcon(display.previewKind === 'video' || display.previewKind === 'audio' ? 'file' : 'folder', 13)}{display.previewKind === 'video' || display.previewKind === 'audio' ? '用本地播放器打开' : '用默认程序打开'}</button>{display.previewKind === 'image' ? <button type="button" className="preview-external-open" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); requestImageActionMenu(display.path, { x: Math.round(box.left), y: Math.round(box.top) - 92 }) }}>{uiIcon('eye', 13)}读图 / 取字</button> : null}<span>{shortcutDisplay(previewShortcuts, 'preview.toggle')} / {shortcutDisplay(previewShortcuts, 'overlay.close')} 关闭　·　{shortcutDisplay(previewShortcuts, 'preview.previous')} {shortcutDisplay(previewShortcuts, 'preview.next')} 切换相邻文件　·　双击内容打开　·　双击空白或双击鼠标滚轮返回</span></footer>
    </section>
  </div>, previewOverlayRoot())
}

function ShortcutSettings({ bindings, onChange }: { bindings: ShortcutBindings; onChange: (bindings: ShortcutBindings) => void }) {
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<{ target: ShortcutId; occupied: ShortcutId; binding: string } | null>(null)
  const groups = [...new Set(SHORTCUT_DEFINITIONS.map((entry) => entry.group))]
  const commit = (target: ShortcutId, binding: string) => {
    const occupied = SHORTCUT_DEFINITIONS.find((entry) => entry.id !== target && bindings[entry.id] === binding)?.id
    if (occupied) { setConflict({ target, occupied, binding }); setRecordingId(null); return }
    onChange({ ...bindings, [target]: binding }); setRecordingId(null); setError('')
  }
  const record = (id: ShortcutId, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { setRecordingId(null); setError(''); return }
    const binding = bindingFromKeyboardEvent(event.nativeEvent)
    if (!binding) return
    const problem = shortcutBindingProblem(binding)
    if (problem) { setError(problem); return }
    commit(id, binding)
  }
  return <div className="shortcut-settings-page">
    <header><div><b>快捷键</b><small>点击一项后直接按下新的组合键；更改会立即生效并保存在本机。</small></div><button onClick={() => onChange({ ...DEFAULT_SHORTCUT_BINDINGS })}>全部恢复默认</button></header>
    {error ? <p className="shortcut-error" role="alert">{error}</p> : null}
    {groups.map((group) => <section key={group}><h3>{group}</h3>{SHORTCUT_DEFINITIONS.filter((entry) => entry.group === group).map((entry) => <div className="shortcut-row" key={entry.id}>
      <span><b>{entry.label}</b><small>{entry.id}</small></span>
      <button className={recordingId === entry.id ? 'recording' : ''} autoFocus={recordingId === entry.id} onClick={() => { setError(''); setRecordingId(entry.id) }} onKeyDown={(event) => recordingId === entry.id && record(entry.id, event)}>{recordingId === entry.id ? '请按新组合键…' : shortcutDisplay(bindings, entry.id)}</button>
      <button disabled={!bindings[entry.id]} onClick={() => onChange({ ...bindings, [entry.id]: '' })}>清空</button>
      <button disabled={bindings[entry.id] === entry.defaultBinding} onClick={() => onChange({ ...bindings, [entry.id]: entry.defaultBinding })}>恢复默认</button>
    </div>)}</section>)}
    {conflict ? <div className="shortcut-conflict" role="alertdialog"><p><b>{conflict.binding}</b> 已分配给“{SHORTCUT_DEFINITIONS.find((entry) => entry.id === conflict.occupied)?.label}”。是否替换？</p><div><button onClick={() => setConflict(null)}>取消</button><button className="primary" onClick={() => { onChange({ ...bindings, [conflict.occupied]: '', [conflict.target]: conflict.binding }); setConflict(null) }}>替换</button></div></div> : null}
  </div>
}

function App() {
  const initialSettingsRef = useRef<AppSettings>(readBrowserSettings())
  const savedSessionRef = useRef<Session | null>(window.chrome?.webview ? null : readSavedSession())
  const savedSessionDirtyRef = useRef(Boolean(savedSessionRef.current))
  const [bootMode, setBootMode] = useState<'ask' | 'ready'>(savedSessionRef.current ? 'ask' : 'ready')
  // —— 画布模板（像草图大师那样「先选个模板再开工」）——
  const [showTemplates, setShowTemplates] = useState(false)
  /** 模板库（底部浮层）里的胶囊搜索词 */
  const [templateQuery, setTemplateQuery] = useState('')
  type TemplateCardLayout = { k: string; x: number; y: number; w: number; h: number }
  const [templateItems, setTemplateItems] = useState<{ name: string; path: string; size: number; cards?: number; layout?: TemplateCardLayout[]; thumb?: string; thumbPath?: string }[]>([])
  const [templateDefault, setTemplateDefault] = useState('')
  const [templateFolder, setTemplateFolder] = useState('')
  const [templateCreating, setTemplateCreating] = useState<string | null>(null)
  // 刚存好的模板名：底部提示 + 卡片高亮，告诉用户下一步是「进入画布」
  const [templateJustSaved, setTemplateJustSaved] = useState('')
  const [templateBusy, setTemplateBusy] = useState(false)
  const [templateAuto, setTemplateAuto] = useState(false)
  const [templateRenaming, setTemplateRenaming] = useState<{ path: string; draft: string } | null>(null)
  const bootModeRef = useRef(bootMode)
  bootModeRef.current = bootMode
  const templateBootCheckedRef = useRef(false)
  const [restorePending, setRestorePending] = useState(false)
  const restorePendingRef = useRef(false)
  const restoreTimeoutRef = useRef<number | null>(null)
  const restoreFallbackAppliedRef = useRef(false)
  const [items, setItems] = useState<CanvasItem[]>(createSeedItems)
  const [spaces, setSpaces] = useState<SpaceCanvas[]>(createSeedSpaces)
  const [theme, setTheme] = useState<Theme>(initialSettingsRef.current.appTheme)
  const [windowAppearance, setWindowAppearance] = useState<WindowAppearance>(initialSettingsRef.current.windowAppearance)
  const [windowMaterial, setWindowMaterial] = useState<WindowMaterial>(initialSettingsRef.current.windowMaterial)
  const [materialSupported, setMaterialSupported] = useState<boolean | null>(null)
  const [toolbarVisibility, setToolbarVisibility] = useState<ToolbarVisibility>(initialSettingsRef.current.toolbarVisibility)
  const [cardTitlebarVisibility, setCardTitlebarVisibility] = useState<CardTitlebarVisibility>(initialSettingsRef.current.cardTitlebarVisibility)
  const [explorerContextMenuEnabled, setExplorerContextMenuEnabled] = useState(initialSettingsRef.current.explorerContextMenuEnabled)
  const [fileIconMode, setFileIconMode] = useState<FileIconMode>(initialSettingsRef.current.fileIconMode)
  const [globalQuickActions, setGlobalQuickActions] = useState<GlobalQuickAction[]>(initialSettingsRef.current.globalQuickActions)
  const [globalFavorites, setGlobalFavorites] = useState<GlobalFavorite[]>(initialSettingsRef.current.globalFavorites)
  const [globalFixedOrder, setGlobalFixedOrder] = useState<string[]>(initialSettingsRef.current.globalFixedOrder)
  const [shortcutBindings, setShortcutBindings] = useState<ShortcutBindings>(initialSettingsRef.current.shortcutBindings)
  const [showSettings, setShowSettings] = useState(false)
  const [tilePickerOpen, setTilePickerOpen] = useState(false)
  const [tileWindowOptions, setTileWindowOptions] = useState<TileWindowOption[]>([])
  const [tileSelectedHandles, setTileSelectedHandles] = useState<string[]>([])
  const [tilePickerLoading, setTilePickerLoading] = useState(false)
  const [tilePickerApplying, setTilePickerApplying] = useState(false)
  const [tilePickerError, setTilePickerError] = useState('')
  const [tileLayoutId, setTileLayoutId] = useState('cols2')
  const [tileSelfSlot, setTileSelfSlot] = useState(0)
  // Ctrl+方向键 的「快挑」：直接在画布边缘列出程序，不弹模态框。
  const [splitQuickSide, setSplitQuickSide] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null)
  const [splitQuickFilter, setSplitQuickFilter] = useState('')
  const [splitQuickIndex, setSplitQuickIndex] = useState(0)
  const [splitEdgeSide, setSplitEdgeSide] = useState<'left' | 'right' | 'top' | 'bottom' | null>(null)
  const splitQuickInputRef = useRef<HTMLInputElement | null>(null)
  const splitQuickSideRef = useRef<'left' | 'right' | 'top' | 'bottom' | null>(null)
  useEffect(() => { splitQuickSideRef.current = splitQuickSide }, [splitQuickSide])
  const splitEdgeSideRef = useRef<'left' | 'right' | 'top' | 'bottom' | null>(null)
  useEffect(() => { splitEdgeSideRef.current = splitEdgeSide }, [splitEdgeSide])
  const splitDragRef = useRef({ active: false, x: 0, y: 0, pending: 0 })
  const tileLayoutRef = useRef('cols2')
  useEffect(() => { tileLayoutRef.current = tileLayoutId }, [tileLayoutId])
  const [navigatorPos, setNavigatorPos] = useState<{ x: number; y: number } | null>(() => {
    try { const raw = localStorage.getItem(NAVIGATOR_POS_KEY); return raw ? JSON.parse(raw) : null } catch { return null }
  })
  const navigatorDragRef = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const beginNavigatorDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const panel = (event.currentTarget as HTMLElement).closest('.space-navigator') as HTMLElement | null
    const rect = panel?.getBoundingClientRect()
    navigatorDragRef.current = {
      active: true,
      sx: event.clientX,
      sy: event.clientY,
      ox: navigatorPos?.x ?? (rect ? Math.round(rect.left) : 0),
      oy: navigatorPos?.y ?? (rect ? Math.round(rect.top) : 0),
    }
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
  }
  const moveNavigatorDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = navigatorDragRef.current
    if (!drag.active) return
    const x = Math.max(8, Math.min(window.innerWidth - 260, drag.ox + (event.clientX - drag.sx)))
    const y = Math.max(56, Math.min(window.innerHeight - 120, drag.oy + (event.clientY - drag.sy)))
    setNavigatorPos({ x, y })
  }
  const endNavigatorDrag = () => {
    const drag = navigatorDragRef.current
    if (!drag.active) return
    drag.active = false
    try {
      const panel = document.querySelector('.space-navigator') as HTMLElement | null
      const rect = panel?.getBoundingClientRect()
      if (rect) localStorage.setItem(NAVIGATOR_POS_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }))
    } catch { /* 忽略 */ }
  }
  const [settingsPage, setSettingsPage] = useState<'general' | 'shortcuts'>('general')
  const [settingsSize, setSettingsSize] = useState(() => ({
    width: initialSettingsRef.current.settingsWidth,
    height: initialSettingsRef.current.settingsHeight,
  }))
  const settingsSizeRef = useRef(settingsSize)
  const settingsResizeRef = useRef<{ pointerId: number; element: HTMLElement; edge: string; startX: number; startY: number; startWidth: number; startHeight: number } | null>(null)
  const [showEverythingInstallPrompt, setShowEverythingInstallPrompt] = useState(false)
  const [openBrowserMoreIds, setOpenBrowserMoreIds] = useState<Set<string>>(() => new Set())
  const everythingWarningShownRef = useRef(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeCanvasId, setActiveCanvasId] = useState(ROOT_ID)
  const [organizeRequest, setOrganizeRequest] = useState<CanvasOrganizeRequest | null>(null)
  const organizeRequestIdRef = useRef(0)
  const organizeByTypeRef = useRef<() => void>(() => undefined)
  const groupToggleRef = useRef<() => void>(() => undefined)
  const contextualShortcutRef = useRef<(id: ShortcutId) => boolean>(() => false)
  const quickAddShortcutRef = useRef<(kind: 'web' | 'folder') => void>(() => undefined)
  const [activeSound, setActiveSound] = useState('')
  const [highlightedCanvasId, setHighlightedCanvasId] = useState<string | null>(null)
  const highlightTimerRef = useRef<number | null>(null)
  const isDirtyRef = useRef(false)
  const selectedIdsRef = useRef<string[]>([])
  const copiedCanvasItemsRef = useRef<CanvasItem[] | null>(null)
  const pendingPreviewAspectIdsRef = useRef(new Set<string>())
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const dropPointRef = useRef<(() => { canvas: SpaceCanvas; x: number; y: number }) | null>(null)
  const clipboardReadFallbackRef = useRef(new Map<string, { run: () => void; timeout: number }>())
  useEffect(() => () => {
    for (const pending of clipboardReadFallbackRef.current.values()) window.clearTimeout(pending.timeout)
    clipboardReadFallbackRef.current.clear()
  }, [])
  const addCanvasItemRef = useRef<(kind: ItemKind, customTitle?: string, source?: string, extra?: Pick<CanvasItem, 'searchQuery' | 'searchRoot' | 'initialSelectionPath'>, placement?: { canvasId: string; x: number; y: number }) => string | undefined>(() => undefined)
  const [spawnAnchor, setSpawnAnchor] = useState<{ canvasId: string; x: number; y: number } | null>(null)
  const spawnAnchorRef = useRef<{ canvasId: string; x: number; y: number } | null>(null)
  const [menuGroup, setMenuGroup] = useState<string | null>(null)   // 右键菜单里展开的那组二级选项
  // 右键「修改名称…」：在卡片标题上就地弹一个输入框（画布卡改的是空间名，其它卡改元素名）
  const [itemRename, setItemRename] = useState<{ itemId: string; spaceId: string | null; draft: string; left: number; top: number; width: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ canvasId: string; itemId: string | null; clientX: number; clientY: number; worldX: number; worldY: number } | null>(null)
  const setAnchor = useCallback((canvasId: string, x: number, y: number) => {
    const next = { canvasId, x, y }
    spawnAnchorRef.current = next
    setSpawnAnchor(next)
    setToast('已放下生成点，新窗口会落在这里')
  }, [])
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  // 三分屏 / 四宫格的方向选择面板（用户：「不知道是上下3个 还是 左右并排3个」）
  const [layoutPickerFor, setLayoutPickerFor] = useState<'three' | 'grid' | null>(null)
  const [closePrompt, setClosePrompt] = useState(false)
  const [overwriteProjectPath, setOverwriteProjectPath] = useState<string | null>(null)
  const [legacyMigrationProjectPath, setLegacyMigrationProjectPath] = useState<string | null>(null)
  const [saveNamePrompt, setSaveNamePrompt] = useState<SaveNamePromptState | null>(null)
  const saveNamePromptRef = useRef<SaveNamePromptState | null>(null)
  const suspendedSaveNamePromptRef = useRef<SaveNamePromptState | null>(null)
  const updateSaveNamePrompt = useCallback((next: SaveNamePromptState | null | ((current: SaveNamePromptState | null) => SaveNamePromptState | null)) => {
    const resolved = typeof next === 'function' ? next(saveNamePromptRef.current) : next
    saveNamePromptRef.current = resolved
    setSaveNamePrompt(resolved)
  }, [])
  const saveNamePromptOpen = saveNamePrompt !== null
  const [projectOpenPrompt, setProjectOpenPrompt] = useState<ProjectOpenRequest | null>(null)
  const projectOpenPromptRef = useRef<ProjectOpenRequest | null>(null)
  const pendingProjectOpenUntilReadyRef = useRef<ProjectOpenRequest | null>(null)
  const pendingProjectOpenAfterSaveRef = useRef<ProjectOpenRequest | null>(null)
  const updateProjectOpenPrompt = useCallback((next: ProjectOpenRequest | null) => {
    projectOpenPromptRef.current = next
    setProjectOpenPrompt(next)
  }, [])
  const [ratioAnchor, setRatioAnchor] = useState<{ left: number; top: number } | null>(null)
  const [exportAnchor, setExportAnchor] = useState<{ left: number; top: number } | null>(null)
  const [exportMode, setExportMode] = useState<'board' | 'batch'>('board')
  const [batchLongEdge, setBatchLongEdge] = useState(2048)
  const [batchFormat, setBatchFormat] = useState<'image/jpeg' | 'image/png'>('image/jpeg')
  const [batchQuality, setBatchQuality] = useState(80)
  const [batchPrefix, setBatchPrefix] = useState('导出')
  const [exportBusy, setExportBusy] = useState(false)
  const exportPanelRef = useRef<HTMLDivElement>(null)
  const nativeFileRequestsRef = useRef(new Map<string, (value: unknown) => void>())
  const exportDataUrlRef = useRef(new Map<string, (value: string) => void>())
  const showRatioPicker = ratioAnchor !== null
  const ratioPickerRef = useRef<HTMLDivElement>(null)
  const ratioToggleRef = useRef<HTMLButtonElement>(null)
  const [focusedWorkspaceId, setFocusedWorkspaceId] = useState<string | null>(null)
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [chromeClipActive, setChromeClipActive] = useState(true)

  useEffect(() => {
    if (!ratioAnchor) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || ratioPickerRef.current?.contains(target) || ratioToggleRef.current?.contains(target)) return
      setRatioAnchor(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setRatioAnchor(null)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true)
      window.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [ratioAnchor])
  useEffect(() => {
    if (!exportAnchor) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || exportPanelRef.current?.contains(target)) return
      setExportAnchor(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation(); setExportAnchor(null)
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer, true)
    window.addEventListener('keydown', closeOnEscape, true)
    return () => { window.removeEventListener('pointerdown', closeOnOutsidePointer, true); window.removeEventListener('keydown', closeOnEscape, true) }
  }, [exportAnchor])
  const [chromePointerInside, setChromePointerInside] = useState(false)
  // 画布上的东西被拖向窗口顶边时，把自动隐藏的顶栏叫出来（拖拽期间热区收不到 pointerenter，
  // 顶栏永远露不出来 → 用户根本没机会把图标放进「全局常用」栏。用户 2026-09-14 报的就是这个）。
  const [canvasDragNearTop, setCanvasDragNearTop] = useState(false)
  const [chromeFocusInside, setChromeFocusInside] = useState(false)
  const [nativeTopHotZone, setNativeTopHotZone] = useState(false)
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [shellPreviewTarget, setShellPreviewTarget] = useState<ShellPreviewTarget | null>(null)
  const [shellPreviewData, setShellPreviewData] = useState<ShellPreviewData | null>(null)
  const [nativeReady, setNativeReady] = useState(false)
  const [sleepingCanvasIds, setSleepingCanvasIds] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState('')
  useEffect(() => {
    const onToastEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string } | string>).detail
      const text = typeof detail === 'string' ? detail : detail?.text
      if (text) setToast(text)
    }
    window.addEventListener('zhangzhongjie-toast', onToastEvent)
    return () => window.removeEventListener('zhangzhongjie-toast', onToastEvent)
  }, [])
  const unsupportedArchiveNoticesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const onUnsupportedArchive = (event: Event) => {
      const extension = (event as CustomEvent<string>).detail
      if (!UNSUPPORTED_ARCHIVE_EXTENSIONS.has(extension) || unsupportedArchiveNoticesRef.current.has(extension)) return
      unsupportedArchiveNoticesRef.current.add(extension)
      setToast(unsupportedArchiveBrowseMessage(extension))
    }
    window.addEventListener(UNSUPPORTED_ARCHIVE_EVENT, onUnsupportedArchive)
    return () => window.removeEventListener(UNSUPPORTED_ARCHIVE_EVENT, onUnsupportedArchive)
  }, [])
  const [isDirty, setIsDirty] = useState(() => !savedSessionRef.current)
  const [searchValue, setSearchValue] = useState('')
  const [webBookmarks, setWebBookmarks] = useState<WebBookmark[]>(initialSettingsRef.current.webBookmarks)
  // 把画布上的东西拖到「全局常用」栏上时，栏里显示一个半透明的落位预览（虚化效果）。
  // 用户 2026-09-14：「快捷栏放上去的时候没有效果，做一个虚化的效果」。
  const [favoriteDropGhost, setFavoriteDropGhost] = useState<{ label: string; kind: ItemKind } | null>(null)
  // 空间导航器改成「随时可开」的全局面板：默认收起，桌宠占住右下角。开关只存网页侧。
  const [spaceNavigatorOpen, setSpaceNavigatorOpen] = useState(() => {
    try { return localStorage.getItem(SPACE_NAVIGATOR_KEY) === '1' } catch { return false }
  })
  const [webThemeMode, setWebThemeModeState] = useState<WebThemeMode>(initialSettingsRef.current.webThemeMode)
  const settingsRef = useRef<AppSettings>(initialSettingsRef.current)
  useEffect(() => {
    try { localStorage.setItem(SPACE_NAVIGATOR_KEY, spaceNavigatorOpen ? '1' : '0') } catch { /* 存储不可用时忽略 */ }
  }, [spaceNavigatorOpen])
  const [webThemeEffective, setWebThemeEffective] = useState(true)
  const [browserEnvironmentDegraded, setBrowserEnvironmentDegraded] = useState(false)
  const [fixedDropHint, setFixedDropHint] = useState<{ section: 'global' | 'current'; group: 'quick' | 'favorite' | 'current'; target: string; after: boolean } | null>(null)
  const fixedPointerDragRef = useRef<{
    section: 'global' | 'current'
    group: 'quick' | 'favorite' | 'current'
    target: string
    pointerId: number
    startX: number
    startY: number
    floating?: boolean
    dragging: boolean
    element: HTMLElement
  } | null>(null)
  const fixedDragClickSuppressedRef = useRef(false)
  const [activeFixedTarget, setActiveFixedTarget] = useState<string | null>(null)
  const [activeGlobalFixedTarget, setActiveGlobalFixedTarget] = useState<string | null>(null)
  const [renamingGlobalFavorite, setRenamingGlobalFavorite] = useState<{ target: string; draft: string } | null>(null)
  const [pendingGlobalFavoriteRemoval, setPendingGlobalFavoriteRemoval] = useState<GlobalFavorite | null>(null)
  const globalFixedClickTimerRef = useRef<number | null>(null)
  const cancelGlobalFavoriteRenameRef = useRef('')
  const requestedGlobalFavoriteIconsRef = useRef(new Set<string>())
  const globalSlotRunRef = useRef<(slot: number) => void>(() => {})
  const desktopPickerRequestRef = useRef('')
  const [globalFavoritesPage, setGlobalFavoritesPage] = useState(0)
  const [desktopShortcutPicker, setDesktopShortcutPicker] = useState<{ items: { name: string; path: string; image?: string }[]; loading: boolean; x: number; y: number } | null>(null)
  const [barQuickMenu, setBarQuickMenu] = useState<{ x: number; y: number } | null>(null)
  const [rebindingSlot, setRebindingSlot] = useState<number | null>(null)
  const [chipQuickMenu, setChipQuickMenu] = useState<{ x: number; y: number; target: string; index: number } | null>(null)
  const [recentProjects, setRecentProjects] = useState<string[]>([])
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(() => {
    const initial = savedSessionRef.current?.recentFolders ?? []
    sharedRecentFolders = initial
    return initial
  })
  const recentFoldersRef = useRef(recentFolders)
  recentFoldersRef.current = recentFolders
  const startupThumbnailPreheatSettledRef = useRef(false)
  const [showRecentProjects, setShowRecentProjects] = useState(false)
  const [navigatorExpandedCanvases, setNavigatorExpandedCanvases] = useState<Set<string>>(() => new Set([ROOT_ID]))
  const [navigatorCollapsedGroups, setNavigatorCollapsedGroups] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const [searchMode, setSearchMode] = useState<'url' | 'disk' | 'hermes'>('url')
  const [hermesPanel, setHermesPanel] = useState<{ status: 'loading' | 'done' | 'error'; question: string; answer?: string; error?: string; x: number; y: number; attachments?: string[]; origin?: 'hermes' | 'ocr' } | null>(null)
  // 「读图 / 取字」二级弹层：{ path } 走磁盘文件；{ item } 是画布图片卡（可能只有 dataUrl）
  const [imageActionMenu, setImageActionMenu] = useState<{ x: number; y: number; path?: string; item?: { source?: string; dataUrl?: string } } | null>(null)
  const [petOpen, setPetOpen] = useState(false)
  const [petBusy, setPetBusy] = useState(false)
  const [petMessages, setPetMessages] = useState<{ role: 'user' | 'pet'; text: string; image?: string }[]>([])
  const [petInput, setPetInput] = useState('')
  const [petAttachments, setPetAttachments] = useState<string[]>([])
  const [petAnchor, setPetAnchor] = useState<{ x: number; y: number } | null>(null)
  const petLogRef = useRef<HTMLDivElement | null>(null)
  const petDragRef = useRef<{ active: boolean; sx: number; sy: number; lx: number; ly: number; left: number; top: number; moved: boolean }>({ active: false, sx: 0, sy: 0, lx: 0, ly: 0, left: 0, top: 0, moved: false })
  const petDragRecentRef = useRef(0)
  const [petMenu, setPetMenu] = useState<{ x: number; y: number } | null>(null)
  const [petModelPanel, setPetModelPanel] = useState(false)
  const [petModel, setPetModel] = useState(() => readBrowserSettings().petModel || '')
  const [petModelDraft, setPetModelDraft] = useState('')
  const hermesAskRequestRef = useRef('')
  const chromeRef = useRef<HTMLElement>(null)
  const chromeShowFrameRef = useRef<number | null>(null)
  const chromeHideTimerRef = useRef<number | null>(null)
  const chromeClipRestoreTimerRef = useRef<number | null>(null)
  const focusStageRef = useRef<HTMLElement>(null)
  const focusBodyRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef(items)
  const spacesRef = useRef(spaces)
  const selectedRef = useRef(selectedIds)
  const activeCanvasRef = useRef(activeCanvasId)
  const themeRef = useRef(theme)
  const focusedWorkspaceRef = useRef(focusedWorkspaceId)
  const packageRootsRef = useRef<string[]>([])
  const recoveryAssetCacheRef = useRef(new Map<string, string>())
  const editRevisionRef = useRef(0)
  const pendingSaveRef = useRef(new Map<string, {
    session: Session
    revision: number
    mode: 'save' | 'saveAs' | 'export'
    requestedByClose: boolean
    hasNamePrompt: boolean
  }>())
  const currentProjectPathRef = useRef('')
  const dirtyTrackingReadyRef = useRef(false)
  const historyRef = useRef<Snapshot[]>([])
  const redoRef = useRef<Snapshot[]>([])
  const sleepTimersRef = useRef(new Map<string, number>())
  const interactingCanvasIdsRef = useRef(new Set<string>())
  const marqueeCanvasIdsRef = useRef(new Set<string>())
  const [interactionEpoch, setInteractionEpoch] = useState(0)
  const initializedSleepCanvasIdsRef = useRef(new Set<string>())
  const shellSelectionsRef = useRef(new Map<string, { selected: ShellEntry[]; siblings: ShellEntry[] }>())
  const windowDragRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !nativeReady || startupThumbnailPreheatSettledRef.current) return
    let started = false
    let cancelled = false
    const stop = () => {
      if (cancelled) return
      cancelled = true
      startupThumbnailPreheatSettledRef.current = true
      window.clearTimeout(timer)
      if (started) bridge.postMessage({ type: 'native-thumbnail-preheat-cancel' })
    }
    const timer = window.setTimeout(() => {
      if (cancelled) return
      const mode = settingsRef.current.fileViewMode
      if (mode !== 'media-grid' && mode !== 'large-icons') {
        startupThumbnailPreheatSettledRef.current = true
        return
      }
      const paths = recentFoldersRef.current.slice(0, 5).map((entry) => entry.path)
      if (!paths.length) {
        startupThumbnailPreheatSettledRef.current = true
        return
      }
      started = true
      bridge.postMessage({
        type: 'native-thumbnail-preheat',
        thumbnailPixels: mode === 'media-grid'
          ? Math.min(768, Math.max(64, Math.round(180 * window.devicePixelRatio)))
          : Math.min(256, Math.max(64, Math.round(50 * window.devicePixelRatio))),
        paths,
      })
    }, 3000)
    window.addEventListener('pointerdown', stop, true)
    window.addEventListener('keydown', stop, true)
    window.addEventListener('wheel', stop, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', stop, true)
      window.removeEventListener('keydown', stop, true)
      window.removeEventListener('wheel', stop, true)
      if (started && !cancelled) bridge.postMessage({ type: 'native-thumbnail-preheat-cancel' })
    }
  }, [nativeReady])

  const applySettings = useCallback((settings: AppSettings) => {
    const previous = readBrowserSettings()
    // 原生只认自己的白名单字段，回洗时会把浏览器专属的缩放/历史/UA 抹掉——这里补回来。
    settings = {
      ...settings,
      browserZoom: settings.browserZoom ?? previous.browserZoom,
      browserHistory: settings.browserHistory ?? previous.browserHistory,
      browserUserAgent: settings.browserUserAgent ?? previous.browserUserAgent,
      browserGroupOrder: settings.browserGroupOrder?.length ? settings.browserGroupOrder : previous.browserGroupOrder,
      // 分组是画布里本机维护的：原生设置里没有这个字段，回洗按 URL 合回来。
      // ⚠ 另外：回洗有可能是旧快照（原生落盘/回声有延迟），直接整段替换会把用户刚收藏的那条
      // 冲掉 —— 表现就是「点了收藏一点反应都没有」。两边都对得上就用回洗的；对不上就以本地为准，
      // 并补发一次让原生收敛。本地为空（首次启动/刚清过）时照样采纳回洗的，免得把原生那份丢掉。
      webBookmarks: (() => {
        const local = previous.webBookmarks
        const incoming = settings.webBookmarks
        const urlOf = (list: WebBookmark[]) => JSON.stringify(list.map((entry) => entry.url))
        const mergeGroup = (entry: WebBookmark) => {
          const localEntry = local.find((item) => item.url === entry.url)
          return localEntry?.group ? { ...entry, group: localEntry.group } : entry
        }
        if (!local.length) return incoming.map(mergeGroup)
        // 并集：以回洗为准，但保留「本地有、回洗里没有」的条目 —— 这样两边谁旧都不会把条目弄丢；
        // 只有「本地刚刚主动删掉」的那些会被滤掉，避免旧快照把删掉的又带回来。
        const incomingUrls = new Set(incoming.map((entry) => entry.url))
        const removed = recentlyRemovedBookmarkUrls
        const kept = local.filter((entry) => !incomingUrls.has(entry.url) && !removed.has(entry.url))
        const merged = [...incoming.filter((entry) => !removed.has(entry.url)), ...kept].map(mergeGroup)
        const json = urlOf(merged)
        const now = Date.now()
        if (urlOf(incoming) !== json && json !== lastBookmarkRepublishJson && now - lastBookmarkRepublishAt > 1500) {
          lastBookmarkRepublishAt = now
          lastBookmarkRepublishJson = json
          window.chrome?.webview?.postMessage({ type: 'native-settings-update', settings: { ...settings, webBookmarks: merged } })
        }
        return merged
      })(),
    }
    const changed = JSON.stringify(previous) !== JSON.stringify(settings)
    settingsRef.current = settings
    setWindowAppearance(settings.windowAppearance)
    setWindowMaterial(settings.windowMaterial)
    setToolbarVisibility(settings.toolbarVisibility)
    setCardTitlebarVisibility(settings.cardTitlebarVisibility)
    setExplorerContextMenuEnabled(settings.explorerContextMenuEnabled)
    setFileIconMode(settings.fileIconMode)
    setGlobalQuickActions(settings.globalQuickActions)
    setGlobalFavorites(settings.globalFavorites)
    setGlobalFixedOrder(settings.globalFixedOrder)
    setShortcutBindings(settings.shortcutBindings)
    if (!settingsResizeRef.current) {
      const nextSize = { width: settings.settingsWidth, height: settings.settingsHeight }
      settingsSizeRef.current = nextSize
      setSettingsSize(nextSize)
    }
    setTheme(settings.appTheme)
    // 动效档位（off / light / full）：CSS 只认 html[data-motion]
    document.documentElement.dataset.motion = settings.uiMotion === 'off' || settings.uiMotion === 'full' ? settings.uiMotion : 'light'
    // 画布风格（default / board）：CSS 只认 html[data-skin]
    document.documentElement.dataset.skin = settings.canvasSkin
    // 界面字号：整站等比缩放（宿主的 WebView2 ZoomFactor；Windows 上比 CSS zoom 稳，坐标换算不受影响）
    applyUiZoom(settings.uiScale)
    setWebThemeModeState(settings.webThemeMode)
    setWebBookmarks(settings.webBookmarks)
    localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(settings))
    localStorage.setItem(WEB_FORCE_DARK_KEY, settings.webThemeMode)
    // A local file-manager change is dispatched immediately by publishSettingsPatch.
    // The host persists it and echoes the same normalized payload. Do not publish
    // that acknowledgement a second time: file-card runtime state (path, expanded
    // branches, selection and scroll) must not be disturbed by a settings receipt.
    if (changed) window.dispatchEvent(new CustomEvent<AppSettings>(APP_SETTINGS_EVENT, { detail: settings }))
  }, [])
  const updateGlobalSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeSettings({ ...settingsRef.current, ...patch, version: 2 })
    applySettings(next)
    window.chrome?.webview?.postMessage({ type: 'native-settings-update', settings: next })
  }, [applySettings])
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !nativeReady) return
    const missing = globalFavorites.filter((favorite) => !favorite.image && !requestedGlobalFavoriteIconsRef.current.has(favorite.id))
    if (!missing.length) return
    for (const favorite of missing) requestedGlobalFavoriteIconsRef.current.add(favorite.id)
    bridge.postMessage({
      type: 'native-explorer-metadata-request',
      purpose: 'global-favorite-icon',
      requestId: `global-favorite-icon:${crypto.randomUUID()}`,
      thumbnailPixels: 32,
      paths: missing.map((favorite) => favorite.source),
    })
  }, [globalFavorites, nativeReady])
  const clampSettingsSize = useCallback((width: number, height: number) => {
    const maximumWidth = Math.max(320, window.innerWidth - 32)
    const maximumHeight = Math.max(280, window.innerHeight - 32)
    return {
      width: clamp(Math.round(width), Math.min(560, maximumWidth), maximumWidth),
      height: clamp(Math.round(height), Math.min(420, maximumHeight), maximumHeight),
    }
  }, [])
  const beginSettingsResize = useCallback((edge: string, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const size = clampSettingsSize(settingsSizeRef.current.width, settingsSizeRef.current.height)
    settingsResizeRef.current = { pointerId: event.pointerId, element: event.currentTarget, edge, startX: event.clientX, startY: event.clientY, startWidth: size.width, startHeight: size.height }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('settings-resizing')
  }, [clampSettingsSize])
  const abortSettingsResize = useCallback(() => {
    const interaction = settingsResizeRef.current
    if (!interaction) return
    settingsResizeRef.current = null
    document.body.classList.remove('settings-resizing')
    if (interaction.element.hasPointerCapture(interaction.pointerId)) interaction.element.releasePointerCapture(interaction.pointerId)
    const size = settingsSizeRef.current
    updateGlobalSettings({ settingsWidth: size.width, settingsHeight: size.height })
  }, [updateGlobalSettings])
  const finishSettingsResize = useCallback((event?: ReactPointerEvent<HTMLElement>) => {
    const interaction = settingsResizeRef.current
    if (!interaction || (event && interaction.pointerId !== event.pointerId)) return
    abortSettingsResize()
  }, [abortSettingsResize])
  const moveSettingsResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const interaction = settingsResizeRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.buttons === 0) { finishSettingsResize(event); return }
    const dx = event.clientX - interaction.startX
    const dy = event.clientY - interaction.startY
    const width = interaction.startWidth + (interaction.edge.includes('e') ? dx : interaction.edge.includes('w') ? -dx : 0)
    const height = interaction.startHeight + (interaction.edge.includes('s') ? dy : interaction.edge.includes('n') ? -dy : 0)
    const next = clampSettingsSize(width, height)
    settingsSizeRef.current = next
    setSettingsSize(next)
  }, [clampSettingsSize, finishSettingsResize])
  useEffect(() => () => document.body.classList.remove('settings-resizing'), [])
  useEffect(() => {
    if (!showSettings) {
      abortSettingsResize()
      return
    }
    const fit = () => {
      const next = clampSettingsSize(settingsSizeRef.current.width, settingsSizeRef.current.height)
      settingsSizeRef.current = next
      setSettingsSize(next)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [abortSettingsResize, clampSettingsSize, showSettings])
  const paintOrderSignature = items.map((item) => `${item.id}:${item.canvasId}:${item.pinned ? 1 : 0}:${item.childCanvasId ?? ''}`).join('|')
  const surfacePaintOrder = useMemo(() => buildSurfacePaintOrder(items), [paintOrderSignature])
  // Recovery serialization is intentionally suspended during pointer interaction.
  // The drag path can mutate positions every frame; only the settled state matters
  // for crash recovery, so interaction end bumps the epoch and records it once.
  const recoverySignature = useMemo(() => interactingCanvasIdsRef.current.size
    ? 'interaction-active'
    : snapshotStructureSignature(items, spaces, theme, focusedWorkspaceId, activeCanvasId, recentFolders),
    [activeCanvasId, focusedWorkspaceId, interactionEpoch, items, recentFolders, spaces, theme])

  const loadSessionState = useCallback((session: Session, dirty: boolean) => {
    // 切换项目或放弃恢复后，宿主的 Recovery.zzj 素材目录会被替换/删除。
    // Web 侧必须同步忘掉“已发送”记录，否则同名图片不会再次写入恢复包。
    recoveryAssetCacheRef.current.clear()
    savedSessionRef.current = session
    savedSessionDirtyRef.current = dirty
    dirtyTrackingReadyRef.current = false
    initializedSleepCanvasIdsRef.current.clear()
    setItems(session.items)
    setSpaces(session.spaces)
    sharedRecentFolders = session.recentFolders
    setRecentFolders(session.recentFolders)
    window.dispatchEvent(new CustomEvent<RecentFolder[]>(RECENT_FOLDERS_EVENT, { detail: session.recentFolders }))
    // Theme is now a global user preference. Keep reading/writing the legacy
    // Session field for .zzj compatibility, but never let a document choose UI color.
    setFocusedWorkspaceId(session.focusedWorkspaceId ?? null)
    setActiveCanvasId(session.activeCanvasId && session.spaces.some((space) => space.id === session.activeCanvasId) ? session.activeCanvasId : ROOT_ID)
    setSelectedIds([])
    setSleepingCanvasIds(new Set())
    setIsDirty(dirty)
    setBootMode('ready')
  }, [])

  const clearRestoreWait = useCallback(() => {
    if (restoreTimeoutRef.current !== null) window.clearTimeout(restoreTimeoutRef.current)
    restoreTimeoutRef.current = null
    restorePendingRef.current = false
    setRestorePending(false)
  }, [])

  useEffect(() => () => {
    if (restoreTimeoutRef.current !== null) window.clearTimeout(restoreTimeoutRef.current)
  }, [])

  const requestProjectSave = useCallback((mode: 'save' | 'saveAs' | 'export', requestedByClose = false, projectName?: string): boolean => {
    if (pendingSaveRef.current.size > 0) {
      setToast('已有保存操作正在进行，请先完成或取消当前操作')
      return false
    }
    const session = sessionFromState(itemsRef.current, spacesRef.current, themeRef.current, focusedWorkspaceRef.current, activeCanvasRef.current)
    const title = spacesRef.current.find((space) => space.id === ROOT_ID)?.title || '未命名项目'
    const bridge = window.chrome?.webview
    if (!bridge) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
      savedSessionRef.current = session
      setIsDirty(false)
      setToast('浏览器预览状态已保存')
      return true
    }
    const payload = buildProjectPayload(session, title, mode === 'export', packageRootsRef.current)
    const requestId = crypto.randomUUID()
    pendingSaveRef.current.set(requestId, {
      session,
      revision: editRevisionRef.current,
      mode,
      requestedByClose,
      hasNamePrompt: projectName !== undefined,
    })
    // The close flow owns a native watchdog. Arm its save phase only after this
    // request has acquired the Web-side save slot, then send the payload in order.
    if (requestedByClose) bridge.postMessage({ type: 'native-save-started' })
    bridge.postMessage({ type: 'native-project-save', requestId, mode, title, projectName, ...payload })
    setToast(mode === 'export' ? '正在导出项目包…' : mode === 'saveAs' ? '请选择项目保存位置' : '正在保存项目…')
    return true
  }, [])

  const openSaveNamePrompt = useCallback((mode: 'save' | 'saveAs', requestedByClose = false): boolean => {
    if (pendingSaveRef.current.size > 0) {
      setToast('已有保存操作正在进行，请先完成或取消当前操作')
      return false
    }
    const name = spacesRef.current.find((space) => space.id === ROOT_ID)?.title.trim() || '未命名项目'
    updateSaveNamePrompt({ mode, name, requestedByClose, saving: false, error: '' })
    if (requestedByClose) window.chrome?.webview?.postMessage({ type: 'native-close-response', action: 'prompting' })
    return true
  }, [updateSaveNamePrompt])

  const dispatchProjectOpen = useCallback((request: ProjectOpenRequest) => {
    const bridge = window.chrome?.webview
    if (!bridge) {
      setToast('打开掌中界项目需要使用 Windows 桌面版')
      return
    }
    bridge.postMessage({
      type: request.path ? 'native-project-open' : 'native-project-open-dialog',
      path: request.path,
      archive: request.archive,
      legacyDirectory: request.legacyDirectory,
    })
  }, [])

  const routeReadyProjectOpen = useCallback((request: ProjectOpenRequest) => {
    if (isDirtyRef.current) {
      updateProjectOpenPrompt(request)
      return
    }
    dispatchProjectOpen(request)
  }, [dispatchProjectOpen, updateProjectOpenPrompt])

  const requestOpenProject = useCallback((path?: string, archive = false, label?: string, legacyDirectory = false) => {
    const request: ProjectOpenRequest = {
      path,
      archive,
      legacyDirectory,
      label: label || (path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path : archive ? '导入项目包' : '打开项目'),
    }
    if (bootMode !== 'ready') {
      pendingProjectOpenUntilReadyRef.current = request
      setToast('已记住待打开项目，选择启动方式后会自动打开')
      return
    }
    routeReadyProjectOpen(request)
  }, [bootMode, routeReadyProjectOpen])

  useEffect(() => {
    if (bootMode !== 'ready') return
    const request = pendingProjectOpenUntilReadyRef.current
    if (!request) return
    pendingProjectOpenUntilReadyRef.current = null
    routeReadyProjectOpen(request)
  }, [bootMode, routeReadyProjectOpen])

  const saveBeforeProjectOpen = useCallback(() => {
    const request = projectOpenPromptRef.current
    if (!request) return
    pendingProjectOpenAfterSaveRef.current = request
    updateProjectOpenPrompt(null)
    const accepted = requestProjectSave('save')
    if (!accepted) {
      pendingProjectOpenAfterSaveRef.current = null
      updateProjectOpenPrompt({ ...request, error: '当前项目暂时无法保存，请完成正在进行的操作后重试' })
    }
  }, [requestProjectSave, updateProjectOpenPrompt])

  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => {
    const applyPreviewAspect = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId: string; width: number; height: number }>).detail
      if (!detail?.itemId || detail.width <= 0 || detail.height <= 0) return
      if (!pendingPreviewAspectIdsRef.current.delete(detail.itemId)) return
      setItems((current) => current.map((item) => {
        if (item.id !== detail.itemId || item.kind !== 'reference') return item
        // The pending set excludes restored cards. The geometry check also
        // protects a newly dropped card if the user resizes it before metadata arrives.
        const untouchedHeight = /\.pdf$/i.test(item.source ?? '') ? 538 : 190
        if (item.w !== 380 || item.h !== untouchedHeight) return item
        const height = Math.max(190, Math.min(760, Math.round(380 * detail.height / detail.width + 42)))
        return height === item.h ? item : { ...item, h: height }
      }))
    }
    window.addEventListener(FILE_PREVIEW_ASPECT_EVENT, applyPreviewAspect)
    return () => window.removeEventListener(FILE_PREVIEW_ASPECT_EVENT, applyPreviewAspect)
  }, [])
  useEffect(() => { spacesRef.current = spaces }, [spaces])

  useEffect(() => { selectedRef.current = selectedIds }, [selectedIds])
  useEffect(() => { activeCanvasRef.current = activeCanvasId }, [activeCanvasId])
  useEffect(() => { themeRef.current = theme }, [theme])
  useEffect(() => { focusedWorkspaceRef.current = focusedWorkspaceId }, [focusedWorkspaceId])
  useEffect(() => {
    const onRecentFolders = (event: Event) => setRecentFolders((event as CustomEvent<RecentFolder[]>).detail)
    window.addEventListener(RECENT_FOLDERS_EVENT, onRecentFolders)
    return () => window.removeEventListener(RECENT_FOLDERS_EVENT, onRecentFolders)
  }, [])
  useEffect(() => { isDirtyRef.current = isDirty }, [isDirty])
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.canvas-menu')) return
      setContextMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (shortcutIdForEvent(event, settingsRef.current.shortcutBindings, ['overlay.close']) !== 'overlay.close') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setContextMenu(null)
    }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('keydown', onKey) }
  }, [contextMenu])
  useEffect(() => {
    const track = (event: PointerEvent) => { pointerRef.current = { x: event.clientX, y: event.clientY } }
    window.addEventListener('pointermove', track, { passive: true })
    return () => window.removeEventListener('pointermove', track)
  }, [])
  useEffect(() => {
    const remember = (event: Event) => {
      const detail = (event as CustomEvent<{ surfaceId: string; selected: ShellEntry[]; siblings: ShellEntry[] }>).detail
      if (!detail?.surfaceId) return
      shellSelectionsRef.current.set(detail.surfaceId, { selected: detail.selected ?? [], siblings: detail.siblings ?? [] })
    }
    window.addEventListener('zhangzhongjie-shell-selection', remember)
    return () => window.removeEventListener('zhangzhongjie-shell-selection', remember)
  }, [])
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<ShellPreviewTarget>).detail
      if (!detail?.surfaceId || !detail.entry) return
      setPreviewId(null)
      setShellPreviewTarget(detail)
    }
    window.addEventListener(SHELL_PREVIEW_OPEN_EVENT, open)
    return () => window.removeEventListener(SHELL_PREVIEW_OPEN_EVENT, open)
  }, [])
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; open?: boolean }>).detail
      const itemId = detail?.itemId
      if (!itemId) return
      setOpenBrowserMoreIds((current) => {
        const next = new Set(current)
        if (detail.open) next.add(itemId)
        else next.delete(itemId)
        if (next.size === current.size && [...next].every((id) => current.has(id))) return current
        return next
      })
    }
    window.addEventListener(BROWSER_CARD_MORE_EVENT, update)
    return () => window.removeEventListener(BROWSER_CARD_MORE_EVENT, update)
  }, [])
  useEffect(() => {
    if (!shellPreviewTarget) { setShellPreviewData(null); return }
    setShellPreviewData(null)
    const bridge = window.chrome?.webview
    bridge?.postMessage({
      type: 'native-shell-preview-request',
      surfaceId: shellPreviewTarget.surfaceId,
      path: shellPreviewTarget.entry.path,
    })
    return () => bridge?.postMessage({ type: 'native-shell-preview-cancel' })
  }, [shellPreviewTarget?.entry.path, shellPreviewTarget?.surfaceId])
  const updateShellPreviewSiblings = useCallback((siblings: ShellEntry[]) => {
    setShellPreviewTarget((current) => {
      if (!current) return current
      if (current.siblings.length === siblings.length && current.siblings.every((entry, index) => entry.path === siblings[index]?.path)) return current
      return { ...current, siblings }
    })
  }, [])
  const openCanvasPreview = useCallback((item: CanvasItem) => {
    if (item.source && (item.kind === 'reference' || item.kind === 'folder' || item.kind === 'image')) {
      const entry: ShellEntry = {
        name: item.title,
        path: item.source,
        typeText: item.subtitle ?? '',
        modified: '',
        size: 0,
        folder: item.kind === 'folder',
        hidden: false,
        shortcut: false,
      }
      setPreviewId(null)
      setShellPreviewTarget({ surfaceId: item.id, entry, siblings: [entry] })
      return
    }
    setShellPreviewTarget(null)
    setPreviewId(item.id)
  }, [])
  const sameCanvasSelectionCount = items.filter((item) => selectedIds.includes(item.id) && item.canvasId === activeCanvasId).length
  // 选中的全是裸图标时，不弹那条「三分屏 / 四宫格 / 成组」的批量栏（2026-09-13 用户要求：图标不需要那个框）
  const selectionAllIcons = sameCanvasSelectionCount >= 2 && items.every((item) => !selectedIds.includes(item.id) || item.canvasId !== activeCanvasId || item.kind === 'icon')

  const [saveMenu, setSaveMenu] = useState<{ left: number; top: number } | null>(null)
  const [saveTemplateName, setSaveTemplateName] = useState('')
  const [saveTemplatePrompt, setSaveTemplatePrompt] = useState<{ name: string; freshName: string } | null>(null)
  // 「覆盖更新」时不要弹模板库，只在中间一句话提示（用户 2026-09-16）
  const overwriteTemplateRef = useRef(false)
  // 「保存画布为模板」时，模板库要等封面抓完（保存结果回来）再开 —— 抓封面用的是屏幕画面，
  // 库先打开就会被一起抓进封面里（用户 2026-09-16：模板卡要真封面）
  const openGalleryAfterSaveRef = useRef(false)
  // 掌中界要盖在原生内容之上时，先让宿主把原生子窗口整体藏起来，
  // 否则网页和文件视图会浮在对话框上面，按钮点不到（§25）。
  // 这份条件同时是当前所有 DOM 浮层的权威清单；新增浮层时必须在这里登记。
  useEffect(() => {
    window.chrome?.webview?.postMessage({ type: 'native-overlay', active: bootMode === 'ask' || closePrompt || overwriteProjectPath !== null || legacyMigrationProjectPath !== null || saveNamePromptOpen || projectOpenPrompt !== null || pendingGlobalFavoriteRemoval !== null || showSettings || showTemplates || saveMenu !== null || saveTemplatePrompt !== null || showEverythingInstallPrompt || tilePickerOpen || showRatioPicker || showRecentProjects || contextMenu !== null || showSplitPicker || showTemplates || shellPreviewTarget !== null || previewId !== null || openBrowserMoreIds.size > 0 })
  }, [showTemplates, saveMenu, saveTemplatePrompt, bootMode, closePrompt, legacyMigrationProjectPath, openBrowserMoreIds, overwriteProjectPath, pendingGlobalFavoriteRemoval, projectOpenPrompt, saveNamePromptOpen, showSettings, showEverythingInstallPrompt, tilePickerOpen, showRatioPicker, showRecentProjects, contextMenu, showSplitPicker, shellPreviewTarget, previewId])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const onMessage = (event: MessageEvent<NativeHostMessage>) => {
      if (event.data?.type === 'native-ready') setNativeReady(true)
      if (event.data?.type === 'native-window-state') setWindowMaximized(event.data.maximized === true)
      if (event.data?.type === 'native-window-material') setMaterialSupported(event.data.supported === true)
      if (event.data?.type === 'native-window-tile-candidates') {
        const options = Array.isArray(event.data.windows)
          ? event.data.windows.filter((entry): entry is TileWindowOption => typeof entry?.handle === 'string' && typeof entry?.title === 'string')
          : []
        setTileWindowOptions(options)
        // 上次一起分屏过的程序自动勾上，剩下的手动补。
        let remembered: string[] = []
        try { remembered = JSON.parse(localStorage.getItem(SPLIT_APPS_KEY) || '[]') } catch { remembered = [] }
        const slotLimit = (TILE_LAYOUTS.find((layout) => layout.id === tileLayoutRef.current)?.slots.length ?? 2) - 1
        if (splitQuickSideRef.current) {
          // 快挑：上次一起分屏的程序默认高亮（回车即用），不预勾选，免得多点一次。
          const rememberedIndex = options.findIndex((entry) => entry.process && remembered.includes(entry.process))
          setSplitQuickIndex(rememberedIndex > 0 ? rememberedIndex : 0)
          setTileSelectedHandles([])
        } else {
          // 不预勾选：用户点几个就是几个，免得“只点了一个，却直接变成两个窗口”。
          setTileSelectedHandles([])
        }
        setTilePickerLoading(false)
        setTilePickerError('')
      }
      if (event.data?.type === 'native-split-released') {
        setSplitEdgeSide(null)
        setToast('已退出分屏，画布恢复原样')
      }
      if (event.data?.type === 'native-window-tile-result') {
        setTilePickerApplying(false)
        if (event.data.success && event.data.partner !== true) setSplitEdgeSide(null)
        if (event.data.success) {
          setTilePickerOpen(false)
          setTileSelectedHandles([])
          setToast(event.data.systemSnap
            ? `已分屏：拖动两个窗口中间的边界可以左右调整`
            : `已分屏（共 ${event.data.count ?? 0} 个窗口）：拖动中间那条把手可以调整比例；按 Esc 或关掉旁边的程序，画布会自动最大化`)
        } else {
          const failure = event.data.error || '窗口平铺失败，请刷新列表后重试'
          setTilePickerError(failure)
          setToast(failure)
        }
      }
      if (event.data?.type === 'native-toolbar-hotzone') setNativeTopHotZone(event.data.inside === true)
      if (event.data?.type === 'native-window-resize-hint') {
        const edge = event.data.edge?.trim()
        if (edge) document.documentElement.dataset.windowResizeEdge = edge
        else delete document.documentElement.dataset.windowResizeEdge
      }
      if (event.data?.type === 'native-explorer-metadata-chunk' && event.data.purpose === 'global-favorite-icon') {
        const images = new Map((event.data.entries ?? []).flatMap((entry) =>
          entry.path && entry.image?.startsWith('data:image/') ? [[entry.path.toLocaleLowerCase(), entry.image] as const] : []))
        if (images.size) {
          let changed = false
          const favorites = settingsRef.current.globalFavorites.map((favorite) => {
            if (favorite.image) return favorite
            const image = images.get(favorite.source.toLocaleLowerCase())
            if (!image) return favorite
            changed = true
            return { ...favorite, image }
          })
          if (changed) updateGlobalSettings({ globalFavorites: favorites })
        }
      }
      if (event.data?.type === 'native-session-available' && event.data.projectJson) {
        let session = hydrateProject(event.data.projectJson, event.data.assets, event.data.packageRoot)
        if (session && event.data.previousPackageRoot && event.data.packageRoot) {
          session = rebaseSessionSourceRoot(session, event.data.previousPackageRoot, event.data.packageRoot)
        }
        if (session) {
          clearRestoreWait()
          restoreFallbackAppliedRef.current = false
          savedSessionRef.current = session
          savedSessionDirtyRef.current = event.data.dirty !== false
          setBootMode('ask')
        }
      }
      if (event.data?.type === 'native-session-restore-confirmed') {
        const fallbackWasApplied = restoreFallbackAppliedRef.current
        clearRestoreWait()
        const saved = savedSessionRef.current
        if (!fallbackWasApplied) {
          currentProjectPathRef.current = event.data.projectPath ?? ''
          packageRootsRef.current = event.data.packageRoot ? [event.data.packageRoot] : []
        }
        if (saved && !fallbackWasApplied) {
          loadSessionState(saved, savedSessionDirtyRef.current)
          setToast('已恢复上次会话；项目文件仍保持原来的保存状态')
        }
        restoreFallbackAppliedRef.current = false
      }
      if (event.data?.type === 'native-project-opened' && event.data.projectJson) {
        currentProjectPathRef.current = event.data.projectPath ?? ''
        let session = hydrateProject(event.data.projectJson, event.data.assets, event.data.packageRoot)
        if (session && templateApplyPendingRef.current) {
          // 套用模板：待办清单的勾选清零（模板里的条目留着，勾去掉）
          templateApplyPendingRef.current = false
          session = { ...session, items: session.items.map((entry) => (entry.todo?.length ? { ...entry, todo: entry.todo.map((row) => ({ ...row, done: false })) } : entry)) }
        }
        if (session) {
          packageRootsRef.current = event.data.packageRoot ? [event.data.packageRoot] : []
          loadSessionState(session, false)
          setShowRecentProjects(false)
          setToast(event.data.legacyDirectory
            ? '这是旧的目录格式项目，保存时会转成单文件'
            : `已打开：${event.data.projectTitle || '掌中界项目'}`)
        } else setToast('项目文件格式无法识别')
      }
      if (event.data?.type === 'native-project-legacy-migration-request' && event.data.projectPath) {
        setLegacyMigrationProjectPath(event.data.projectPath)
      }
      if (event.data?.type === 'native-project-legacy-migration-dismissed') {
        setLegacyMigrationProjectPath(null)
      }
      if (event.data?.type === 'native-project-save-result') {
        const deferredOpen = pendingProjectOpenAfterSaveRef.current
        const requestId = event.data.requestId
        let pending = requestId ? pendingSaveRef.current.get(requestId) : undefined
        if (requestId) pendingSaveRef.current.delete(requestId)
        // 兼容旧宿主：没有 requestId 时只消费同模式的最早请求，避免清空其他保存。
        if (!requestId) {
          const fallback = Array.from(pendingSaveRef.current.entries()).find(([, entry]) => entry.mode === event.data.mode)
          if (fallback) { pending = fallback[1]; pendingSaveRef.current.delete(fallback[0]) }
        }
        if (event.data.success) {
          if (event.data.mode !== 'export') {
            if (requestId && !pending) {
              setToast('保存已完成，但当前画布已切换；未改写当前画布的保存状态')
              return
            }
            let savedSession = pending?.session ?? sessionFromState(itemsRef.current, spacesRef.current, themeRef.current, focusedWorkspaceRef.current, activeCanvasRef.current)
            const changedDuringSave = pending !== undefined && editRevisionRef.current !== pending.revision
            if (event.data.migratedFrom && event.data.packageRoot) {
              const liveSession = sessionFromState(itemsRef.current, spacesRef.current, themeRef.current, focusedWorkspaceRef.current, activeCanvasRef.current)
              savedSession = rebaseSessionSourceRoot(savedSession, event.data.migratedFrom, event.data.packageRoot)
              const rebasedLive = rebaseSessionSourceRoot(liveSession, event.data.migratedFrom, event.data.packageRoot)
              loadSessionState(rebasedLive, changedDuringSave)
              packageRootsRef.current = [event.data.packageRoot]
              setLegacyMigrationProjectPath(null)
            }
            savedSessionRef.current = savedSession
            savedSessionDirtyRef.current = changedDuringSave
            setIsDirty(changedDuringSave)
            currentProjectPathRef.current = event.data.projectPath ?? currentProjectPathRef.current
            suspendedSaveNamePromptRef.current = null
            updateSaveNamePrompt(null)
          }
          setToast(event.data.mode === 'export' ? '项目包已导出' : '项目已保存')
        } else if (event.data.cancelled) {
          const suspended = suspendedSaveNamePromptRef.current
          suspendedSaveNamePromptRef.current = null
          updateSaveNamePrompt(suspended ? { ...suspended, saving: false } : (current) => current ? { ...current, saving: false } : current)
          setToast('已取消保存')
        } else {
          const suspended = suspendedSaveNamePromptRef.current
          suspendedSaveNamePromptRef.current = null
          updateSaveNamePrompt(suspended
            ? { ...suspended, saving: false, error: event.data.error || '保存失败' }
            : (current) => current ? { ...current, saving: false, error: event.data.error || '保存失败' } : current)
          setToast(event.data.error ? `保存失败：${event.data.error}` : '保存失败')
        }
        if (deferredOpen && event.data.mode !== 'export') {
          pendingProjectOpenAfterSaveRef.current = null
          suspendedSaveNamePromptRef.current = null
          updateSaveNamePrompt(null)
          if (event.data.success) {
            updateProjectOpenPrompt(null)
            setToast(`当前项目已保存，正在打开：${deferredOpen.label}`)
            dispatchProjectOpen(deferredOpen)
          } else {
            updateProjectOpenPrompt({
              ...deferredOpen,
              error: event.data.cancelled
                ? '已取消保存，目标项目尚未打开'
                : `保存失败，目标项目尚未打开${event.data.error ? `：${event.data.error}` : ''}`,
            })
          }
        }
        if (!event.data.success && pending?.requestedByClose) {
          if (pending.hasNamePrompt) {
            // The self-drawn name dialog remains open for retry. Tell the host that
            // an interactive prompt is visible so its close watchdog stays paused.
            bridge.postMessage({ type: 'native-close-response', action: 'prompting' })
          } else {
            // A direct save has no retry UI. Return to the close confirmation instead
            // of leaving the host armed for a save payload that will never arrive.
            setClosePrompt(true)
            bridge.postMessage({ type: 'native-close-response', action: 'save-unavailable' })
          }
        }
      }
      if (event.data?.type === 'native-project-open-result' && !event.data.success) {
        if (!event.data.cancelled) setToast(event.data.error ? `打开失败：${event.data.error}` : '打开项目失败')
      }
      if (event.data?.type === 'native-project-overwrite-request' && event.data.projectPath) {
        if (saveNamePromptRef.current) {
          suspendedSaveNamePromptRef.current = saveNamePromptRef.current
          updateSaveNamePrompt(null)
        }
        setOverwriteProjectPath(event.data.projectPath)
      }
      if (event.data?.type === 'native-project-overwrite-dismissed') setOverwriteProjectPath(null)
      if (event.data?.type === 'native-session-discarded') {
        recoveryAssetCacheRef.current.clear()
        currentProjectPathRef.current = ''
      }
      if (event.data?.type === 'native-session-error') {
        setToast(event.data.error || '检测到恢复数据，但恢复素材无法读取；原快照仍保留，可稍后重试')
      }
      if (event.data?.type === 'native-project-recents') setRecentProjects(event.data.recents ?? [])
      if (event.data?.type === 'native-shell-preview' && event.data.surfaceId && event.data.path) {
        setShellPreviewData({
          surfaceId: event.data.surfaceId,
          path: event.data.path,
          parentPath: event.data.parentPath ?? '',
          name: event.data.name ?? event.data.path,
          typeText: event.data.typeText ?? '',
          modified: event.data.modified ?? '',
          size: event.data.size ?? 0,
          previewKind: event.data.previewKind ?? 'thumbnail',
          resource: event.data.resource,
          image: event.data.image,
          text: event.data.text,
          created: event.data.created,
          readOnly: event.data.readOnly,
          hidden: event.data.hidden,
          width: event.data.width,
          height: event.data.height,
          durationMs: event.data.durationMs,
          codec: event.data.codec,
          colorMode: event.data.colorMode,
          pageCount: event.data.pageCount,
          folderFileCount: event.data.folderFileCount,
          folderFolderCount: event.data.folderFolderCount,
          folderTotalSize: event.data.folderTotalSize,
          children: event.data.children,
        })
      }
      if (event.data?.type === 'native-shell-preview-stats' && event.data.path) {
        const { path, folderFileCount, folderFolderCount, folderTotalSize } = event.data
        setShellPreviewData((current) => current?.path === path ? {
          ...current,
          folderFileCount,
          folderFolderCount,
          folderTotalSize,
        } : current)
      }
      if (event.data?.type === 'native-browser-context-menu' && event.data.surfaceId) {
        const item = itemsRef.current.find((entry) => entry.id === event.data.surfaceId)
        const clientX = event.data.clientX ?? 0
        const clientY = event.data.clientY ?? 0
        if (item) {
          // Native WebView/Shell surfaces bypass the DOM context-menu handler.
          // Preserve an existing marquee selection when the user right-clicks
          // one of its members; only an outside target starts a new selection.
          setSelectedIds((current) => current.includes(item.id) ? current : [item.id])
          setActiveCanvasId(item.canvasId)
          setContextMenu({
            canvasId: item.canvasId,
            itemId: item.id,
            clientX,
            clientY,
            worldX: item.x,
            worldY: item.y,
          })
        }
        console.info('[browser-context-menu]', {
          coordinateSystem: 'web-client-css-pixels',
          rawWebViewLocation: [event.data.rawX, event.data.rawY],
          windowScreenOrigin: [event.data.windowLeft, event.data.windowTop],
          requestedScreenPosition: [event.data.screenX, event.data.screenY],
          requestedClientPosition: [clientX, clientY],
          dpi: event.data.dpi,
          maximized: event.data.maximized,
        })
      }
      if (event.data?.type === 'canvas-zoom' && typeof event.data.clientX === 'number' && typeof event.data.clientY === 'number' && typeof event.data.delta === 'number') {
        window.dispatchEvent(new CustomEvent(CANVAS_ZOOM_EVENT, { detail: {
          surfaceId: event.data.surfaceId,
          clientX: event.data.clientX,
          clientY: event.data.clientY,
          delta: event.data.delta,
        } }))
      }
      if (event.data?.type === 'canvas-pan' && typeof event.data.clientX === 'number' && typeof event.data.clientY === 'number' && event.data.phase) {
        window.dispatchEvent(new CustomEvent(CANVAS_PAN_EVENT, { detail: {
          surfaceId: event.data.surfaceId,
          clientX: event.data.clientX,
          clientY: event.data.clientY,
          phase: event.data.phase,
        } }))
      }
      if (event.data?.type === 'native-surface-focused' && event.data.surfaceId) {
        if (marqueeCanvasIdsRef.current.size) return
        const item = itemsRef.current.find((entry) => entry.id === event.data.surfaceId)
        if (item) {
          // GotFocus/WM_SETFOCUS also fire during restore, surface creation and
          // app activation. Only an explicit native left-button notification is
          // a selection gesture; passive focus must not resurrect a stale card.
          if (event.data.select) setSelectedIds((current) => current.includes(item.id) ? current : [item.id])
          setActiveCanvasId(item.canvasId)
          if (item.kind === 'web' || item.kind === 'video') setActiveSound(item.id)
        }
      }
      if (event.data?.type === 'native-surface-hovered') {
        const surfaceId = event.data.surfaceId ?? ''
        const slot = surfaceId
          ? Array.from(document.querySelectorAll<HTMLElement>('.native-surface-slot[data-surface-id]')).find((entry) => entry.dataset.surfaceId === surfaceId)
          : null
        const itemId = slot?.closest<HTMLElement>('.canvas-item[data-item-id]')?.dataset.itemId ?? null
        window.dispatchEvent(new CustomEvent(NATIVE_SURFACE_HOVER_EVENT, { detail: { itemId } }))
      }
      if (event.data?.type === 'native-surface-navigation' && event.data.surfaceId) {
        setItems((current) => current.map((item) => item.id === event.data.surfaceId && item.kind === 'web' ? {
          ...item,
          source: event.data.source || item.source,
          title: event.data.title || item.title,
        } : item))
      }
      if (event.data?.type === 'native-drag-result') {
        setToast(event.data.completed
          ? (event.data.kind === 'image' ? '图片已生成真实文件' : '文件已拖出到目标位置')
          : (event.data.kind === 'image' ? '图片拖出已取消或目标未接收' : '文件拖出已取消或目标未接收'))
      }
      if (event.data?.type === 'native-drag-image-request' && event.data.itemId) {
        const item = itemsRef.current.find((entry) => entry.id === event.data.itemId)
        bridge.postMessage({
          type: 'native-drag-image-data',
          itemId: event.data.itemId,
          dataUrl: item?.kind === 'image' ? item.dataUrl ?? '' : '',
        })
      }
      if (event.data?.type === 'native-favorite-request') setToast('可在超级预览中收藏当前文件或所在文件夹')
      if (event.data?.type === 'native-toast' && typeof event.data.text === 'string') setToast(event.data.text)
      if (event.data?.type === 'native-collect-result') {
        const failure = typeof event.data.error === 'string' ? event.data.error : ''
        if (failure) setToast(`打包失败：${failure}`)
        else if (event.data.cancelled === true) setToast('已取消打包')
        else {
          const copied = Number(event.data.copied) || 0
          const missing = Number(event.data.missing) || 0
          const folder = String(event.data.destination || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()
          setToast(`已打包 ${copied} 项到「${folder || event.data.destination}」${missing ? `，${missing} 项被跳过` : ''}`)
        }
      }
      if (event.data?.type === 'native-capture-image' && typeof event.data.dataUrl === 'string') {
        window.dispatchEvent(new CustomEvent('zhangzhongjie-add-image', { detail: { dataUrl: event.data.dataUrl, width: event.data.width, height: event.data.height, title: '截图' } }))
      }
      if (event.data?.type === 'native-open-location-request') setToast('资源管理器已位于当前真实目录')
      if (event.data?.type === 'native-explorer-operation-blocked') {
        setToast(event.data.message || '压缩包内暂不支持此操作')
      }
      if (event.data?.type === 'native-clipboard-files' || event.data?.type === 'native-drop-files') {
        const fromDrop = event.data.type === 'native-drop-files'
        const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : ''
        const pendingFallback = !fromDrop && requestId
          ? clipboardReadFallbackRef.current.get(requestId)
          : undefined
        // A timed-out response belongs to an earlier paste attempt. Ignoring it avoids
        // duplicating the Web clipboard fallback or reporting an error for a later click.
        if (!fromDrop && requestId && !pendingFallback) return
        if (pendingFallback) {
          window.clearTimeout(pendingFallback.timeout)
          clipboardReadFallbackRef.current.delete(requestId)
        }
        const entries = event.data.paths ?? []
        if (!entries.length) {
          if (pendingFallback) {
            pendingFallback.run()
            return
          }
          // 分清是打不开剪贴板、还是剪贴板里本来就没有文件列表，
          // 否则两种完全不同的原因会显示成同一句话，没法排查。
          setToast(event.data.opened === false
            ? '剪贴板被其他程序占用，稍后再试'
            : event.data.hasDrop === false
              ? '剪贴板里没有文件（复制的可能是压缩包内文件或网页内容，它们没有真实路径）'
              : '剪贴板里的文件列表为空')
          return
        }
        for (const entry of entries) notifyUnsupportedArchive(entry.path)
        const projectEntry = entries.find((entry) => entry.projectKind)
        if (projectEntry?.projectKind) {
          const projectPath = projectEntry.projectPath || projectEntry.path
          requestOpenProject(
            projectPath,
            projectEntry.projectKind === 'archive',
            projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '掌中界项目',
          )
          if (entries.length > 1) setToast('一次只能打开一个项目；已优先处理拖入列表中的第一个掌中界项目')
          return
        }
        if (fromDrop && event.data.clientX !== undefined && event.data.clientY !== undefined) {
          const fileArea = document.elementFromPoint(event.data.clientX, event.data.clientY)?.closest<HTMLElement>('.fm-file-area')
          const surfaceId = fileArea?.dataset.surfaceId
          if (surfaceId) {
            bridge.postMessage({ type: 'native-explorer-drop', surfaceId, paths: entries.map((entry) => entry.path) })
            setToast(entries.length > 1 ? `正在复制 ${entries.length} 项到当前文件夹` : `正在复制：${entries[0].path.split(/[/\\]/).at(-1)}`)
            return
          }
          pointerRef.current = { x: event.data.clientX, y: event.data.clientY }
        }
        const target = dropPointRef.current?.() 
        if (!target) return
        pushHistory()
        const created = entries.slice(0, 24).map((entry, index) => {
          const name = entry.displayName || entry.path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || entry.path
          // 图标按网格铺开（用户：「多个图标一起拖进来…还得一个一个去拖动排放」→ 直接排好）
          const iconColumns = Math.max(1, Math.ceil(Math.sqrt(entries.length)))
          const spot = { x: target.x + 26 * index, y: target.y + 26 * index }
          const iconSpot = {
            x: Math.round((target.x + (index % iconColumns) * ICON_GRID_STEP_X) / ICON_GRID_STEP_X) * ICON_GRID_STEP_X,
            y: Math.round((target.y + Math.floor(index / iconColumns) * ICON_GRID_STEP_Y) / ICON_GRID_STEP_Y) * ICON_GRID_STEP_Y,
          }
          // 2026-09-13 用户要求（第三版）：快捷方式（.lnk/.exe/…）和**普通文件**（Excel/Word/PDF/压缩包…）
          // 都做成桌面那样的裸图标，双击直接用默认程序打开；只有图片/视频/音频保留预览卡（有预览更好用）。
          const appLike = /\.(lnk|exe|url|bat|cmd)$/i.test(entry.path)
          const mediaLike = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|wav|flac|m4a|aac|ogg|ape)$/i.test(entry.path)
          const iconLike = appLike || !mediaLike
          return entry.folder
            ? { id: `folder-${Date.now()}-${index}`, canvasId: target.canvas.id, kind: 'folder' as const, title: name, source: entry.path, x: spot.x, y: spot.y, w: 880, h: 560, accent: '#4f8cff' }
            : iconLike
              ? { id: `icon-${Date.now()}-${index}`, canvasId: target.canvas.id, kind: 'icon' as const, title: appLike ? name.replace(/\.(lnk|exe|url|bat|cmd)$/i, '') : name, source: entry.path, x: iconSpot.x, y: iconSpot.y, w: 112, h: 124, accent: '#4f8cff' }
              : { id: `reference-${Date.now()}-${index}`, canvasId: target.canvas.id, kind: 'reference' as const, title: name, source: entry.path, x: spot.x, y: spot.y, w: 380, h: /\.pdf$/i.test(entry.path) ? 538 : 190, accent: '#4f8cff' }
        })
        for (const entry of created) {
          if (entry.kind === 'reference') pendingPreviewAspectIdsRef.current.add(entry.id)
        }
        setItems((current) => [...current, ...created])
        setActiveCanvasId(target.canvas.id)
        setSelectedIds(created.map((entry) => entry.id))
        const iconCount = created.filter((entry) => entry.kind === 'icon').length
        setToast(created.length > 1
          ? (iconCount === created.length ? `已拖入 ${created.length} 个图标（右键可选「自动排列 / 组合」）` : `${fromDrop ? '已拖入' : '已引用'} ${created.length} 项`) 
          : `${fromDrop ? '已拖入' : '已引用'}：${created[0].title}`)
      }
      if (event.data?.type === 'native-close-request') {
        if (!isDirtyRef.current) bridge.postMessage({ type: 'native-close-response', action: 'close' })
        else {
          // A close request replaces any save-name retry UI. Never stack the close
          // confirmation on top of a restored/suspended name dialog.
          suspendedSaveNamePromptRef.current = null
          pendingProjectOpenAfterSaveRef.current = null
          updateSaveNamePrompt(null)
          updateProjectOpenPrompt(null)
          setOverwriteProjectPath(null)
          setClosePrompt(true)
          // 先应答「对话框已显示」，把宿主的无响应计时停掉——超时是用来兜住
          // Web 层挂掉的，不该因为用户在思考就强行弹系统框。
          bridge.postMessage({ type: 'native-close-response', action: 'prompting' })
        }
      }
      if (event.data?.type === 'native-new-window' && event.data.uri) {
        window.dispatchEvent(new CustomEvent('zhangzhongjie-add-web', { detail: event.data.uri }))
        setToast('网页弹窗已收进当前画布，不再跳出')
      }
      if (event.data?.type === 'browser-profile') {
        const nextProfile = {
          defaultBrowser: event.data.defaultBrowser || '系统默认浏览器',
          bookmarks: Array.isArray(event.data.bookmarks) ? event.data.bookmarks : [],
          truncated: event.data.bookmarksTruncated === true,
        }
        sharedBrowserProfile = nextProfile
        window.dispatchEvent(new CustomEvent<BrowserProfileState>(BROWSER_PROFILE_EVENT, { detail: nextProfile }))
      }
      if (event.data?.type === 'native-settings') {
        const migratePreviousFileColumns = event.data.settings?.version !== 2 && hasPreviousDefaultFileColumns(event.data.settings?.fileColumns)
        // 宿主只认识它自己那份 schema：回声里没有 petModel / ocrLanguage / uiMotion，
        // 必须先合并本地的，否则每次改设置都会把这些“网页侧设置”打回默认值。
        const normalized = normalizeSettings({ ...readBrowserSettings(), ...event.data.settings })
        applySettings(normalized)
        const missingWindowTileBinding = !event.data.settings?.shortcutBindings || !Object.hasOwn(event.data.settings.shortcutBindings, 'window.tile')
        if (migratePreviousFileColumns || missingWindowTileBinding || !Object.keys(event.data.settings?.shortcutBindings ?? {}).length) {
          bridge.postMessage({ type: 'native-settings-update', settings: normalized })
        }
        if (event.data.webThemeMode) {
          setWebThemeEffective(event.data.effective !== false)
          setBrowserEnvironmentDegraded(event.data.degraded === true)
        }
        if (event.data.success === false) setToast(event.data.error || '设置未能写入磁盘，请重试')
        else if (event.data.settingsNotice) setToast(event.data.settingsNotice)
      }
      if (event.data?.type === 'native-web-theme-setting') {
        const mode = event.data.webThemeMode === 'dark' || event.data.webThemeMode === 'original'
          ? event.data.webThemeMode
          : 'follow'
        applySettings({ ...settingsRef.current, webThemeMode: mode })
        setWebThemeEffective(event.data.effective !== false)
        setBrowserEnvironmentDegraded(event.data.degraded === true)
        localStorage.setItem(WEB_FORCE_DARK_KEY, mode)
        if (event.data.restartRequired) {
          setToast(event.data.success === false
            ? '网页颜色设置未能写入磁盘，请重试'
            : event.data.effective === false
              ? `网页颜色已设为${mode === 'dark' ? '强制深色' : mode === 'original' ? '网站原色' : '跟随应用'}，本次启动尚未生效，请重启掌中界`
              : `网页颜色已切换为${mode === 'dark' ? '强制深色' : mode === 'original' ? '网站原色' : '跟随应用'}`)
        }
      }
      if (event.data?.type === 'native-browser-environment-fallback') {
        setBrowserEnvironmentDegraded(event.data.degraded === true)
        setToast(event.data.error || '网页专用渲染环境启动失败，已改用兼容运行；本次会话的网页登录状态不会保留到下次启动')
      }
      if (event.data?.type === 'native-browser-profile-migration') {
        setToast('网页渲染已升级，原有网页登录状态需要重新登录一次')
      }
      if (event.data?.type === 'native-file-search-status') {
        if (event.data.status === 'not-installed' && !settingsRef.current.everythingPromptDismissed) {
          setShowEverythingInstallPrompt(true)
        } else if (event.data.status === 'installed-not-running' && !everythingWarningShownRef.current) {
          everythingWarningShownRef.current = true
          setToast('请启动 Everything；当前使用后台文件遍历搜索')
        } else if (event.data.status === 'unavailable' && !everythingWarningShownRef.current) {
          everythingWarningShownRef.current = true
          setToast('检测到 Everything 但无法通信，可能是以管理员身份运行导致；已自动降级搜索')
        }
      }
      if (event.data?.type === 'native-quick-add' && (event.data.kind === 'web' || event.data.kind === 'folder')) {
        window.dispatchEvent(new CustomEvent('zhangzhongjie-quick-add', { detail: { kind: event.data.kind, clientX: event.data.clientX, clientY: event.data.clientY } }))
      }
      if (event.data?.type === 'native-shortcut' && typeof event.data.shortcutId === 'string') {
        window.dispatchEvent(new CustomEvent(APP_SHORTCUT_EVENT, { detail: { id: event.data.shortcutId, surfaceId: event.data.surfaceId } }))
      }
      if (event.data?.type === 'native-save-request') {
        const accepted = requestProjectSave('save', true)
        if (!accepted) {
          setClosePrompt(true)
          bridge.postMessage({ type: 'native-close-response', action: 'save-unavailable' })
        }
      }
      if (event.data?.type === 'native-export-folder') {
        const resolver = nativeFileRequestsRef.current.get(String(event.data.requestId ?? ''))
        if (resolver) { nativeFileRequestsRef.current.delete(String(event.data.requestId ?? '')); resolver(String(event.data.path ?? '')) }
      }
      if (event.data?.type === 'native-write-file-result') {
        const resolver = nativeFileRequestsRef.current.get(String(event.data.requestId ?? ''))
        if (resolver) { nativeFileRequestsRef.current.delete(String(event.data.requestId ?? '')); resolver(event.data.ok === true) }
      }
      if (event.data?.type === 'native-image-dataurl') {
        const resolver = exportDataUrlRef.current.get(String(event.data.requestId ?? ''))
        if (resolver) { exportDataUrlRef.current.delete(String(event.data.requestId ?? '')); resolver(String(event.data.dataUrl ?? '')) }
      }
      if (event.data?.type === 'native-browser-download' && typeof event.data.path === 'string') {
        setToast(`已下载：${event.data.path}`)
      }
    }
    bridge.addEventListener('message', onMessage)
    bridge.postMessage({ type: 'canvas-ready' })
    // NavigationCompleted can beat React's listener on a fast local load. Query
    // after subscribing so the persisted native setting always wins over stale
    // localStorage from a previous run.
    bridge.postMessage({ type: 'native-web-theme-query' })
    bridge.postMessage({ type: 'native-settings-query' })
    bridge.postMessage({ type: 'native-window-state-query' })
    // ⑤ 网页 UA 模式（伪装 Chrome）在启动时同步一次，之后由切换按钮即时下发。
    bridge.postMessage({ type: 'native-browser-useragent', mode: settingsRef.current.browserUserAgent ?? 'default' })
    return () => bridge.removeEventListener('message', onMessage)
  }, [applySettings, clearRestoreWait, dispatchProjectOpen, loadSessionState, requestOpenProject, requestProjectSave, updateGlobalSettings, updateProjectOpenPrompt, updateSaveNamePrompt])

  const resolvedTheme = useMemo(() => theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme, [theme])
  const rootCanvas = spaces.find((canvas) => canvas.id === ROOT_ID) ?? createSeedSpaces()[0]
  const activeCanvas = spaces.find((canvas) => canvas.id === activeCanvasId) ?? rootCanvas
  const contextItem = selectedIds.length === 1 ? items.find((item) => item.id === selectedIds[0]) : undefined
  const contextKind = contextItem?.kind === 'web' || contextItem?.kind === 'video' ? 'browser' : contextItem?.kind === 'folder' ? 'folder' : 'canvas'

  useEffect(() => {
    window.chrome?.webview?.postMessage({ type: 'native-app-theme', dark: resolvedTheme === 'dark' })
  }, [resolvedTheme])

  const clearChromeTimers = useCallback(() => {
    if (chromeShowFrameRef.current !== null) window.cancelAnimationFrame(chromeShowFrameRef.current)
    if (chromeHideTimerRef.current !== null) window.clearTimeout(chromeHideTimerRef.current)
    if (chromeClipRestoreTimerRef.current !== null) window.clearTimeout(chromeClipRestoreTimerRef.current)
    chromeShowFrameRef.current = null
    chromeHideTimerRef.current = null
    chromeClipRestoreTimerRef.current = null
  }, [])

  const revealChrome = useCallback(() => {
    clearChromeTimers()
    setChromeClipActive(true)
    // First wake native surfaces with the reduced clip; only then move the DOM
    // toolbar into view. This prevents a native child window covering its first frame.
    chromeShowFrameRef.current = window.requestAnimationFrame(() => {
      chromeShowFrameRef.current = window.requestAnimationFrame(() => {
        chromeShowFrameRef.current = null
        setChromeVisible(true)
      })
    })
  }, [clearChromeTimers])

  const chromeInteractionLocked = chromePointerInside || chromeFocusInside || nativeTopHotZone || canvasDragNearTop || focusedWorkspaceId !== null
    || showSettings || showEverythingInstallPrompt || showRecentProjects || contextMenu !== null || showRatioPicker || showSplitPicker

  useEffect(() => {
    clearChromeTimers()
    if (toolbarVisibility === 'always' || chromeInteractionLocked) {
      revealChrome()
      return
    }
    chromeHideTimerRef.current = window.setTimeout(() => {
      chromeHideTimerRef.current = null
      setChromeVisible(false)
      // Restore the native clips only after the transform/opacity transition.
      chromeClipRestoreTimerRef.current = window.setTimeout(() => {
        chromeClipRestoreTimerRef.current = null
        setChromeClipActive(false)
      }, 190)
    }, 500)
    return clearChromeTimers
  }, [chromeInteractionLocked, clearChromeTimers, revealChrome, toolbarVisibility])

  useLayoutEffect(() => {
    const chrome = chromeRef.current
    const publish = () => {
      const chromeBottom = toolbarVisibility === 'auto' && chromeClipActive && chrome
        ? Math.max(0, chrome.getBoundingClientRect().bottom)
        : 0
      const next = chromeBottom
      if (Math.abs(next - nativeChromeOcclusionBottom) < 0.5) return
      nativeChromeOcclusionBottom = next
      window.dispatchEvent(new Event(SURFACE_OCCLUSION_EVENT))
    }
    publish()
    if (!chrome) return
    const observer = new ResizeObserver(publish)
    observer.observe(chrome)
    window.addEventListener('resize', publish)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', publish)
    }
  }, [chromeClipActive, chromeVisible, contextKind, toolbarVisibility])

  useEffect(() => () => {
    clearChromeTimers()
    if (nativeChromeOcclusionBottom !== 0) {
      nativeChromeOcclusionBottom = 0
      window.dispatchEvent(new Event(SURFACE_OCCLUSION_EVENT))
    }
  }, [clearChromeTimers])

  useEffect(() => {
    if (bootMode !== 'ready') { dirtyTrackingReadyRef.current = false; return }
    if (!dirtyTrackingReadyRef.current) { dirtyTrackingReadyRef.current = true; return }
    editRevisionRef.current += 1
    setIsDirty(true)
  }, [bootMode, focusedWorkspaceId, items, spaces])

  useEffect(() => {
    const bridge = window.chrome?.webview
    bridge?.postMessage({ type: 'document-dirty', dirty: isDirty })
    if (!isDirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [isDirty])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || bootMode !== 'ready' || interactingCanvasIdsRef.current.size) return
    const timer = window.setTimeout(() => {
      const session = sessionFromState(itemsRef.current, spacesRef.current, themeRef.current, focusedWorkspaceRef.current, activeCanvasRef.current)
      const recovery = sessionForRecovery(session)
      for (const asset of recovery.assets) {
        const token = snapshotImageToken(asset.dataUrl)
        if (recoveryAssetCacheRef.current.get(asset.path) === token) continue
        recoveryAssetCacheRef.current.set(asset.path, token)
        bridge.postMessage({ type: 'native-session-asset', path: asset.path, dataUrl: asset.dataUrl })
      }
      bridge.postMessage({ type: 'native-session-snapshot', sessionJson: JSON.stringify(recovery.session), dirty: isDirtyRef.current })
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [bootMode, recoverySignature])

  useEffect(() => {
    window.chrome?.webview?.postMessage({ type: 'native-surface-audio', surfaceId: activeSound })
  }, [activeSound])

  useEffect(() => {
    const onAudio = (event: Event) => {
      const itemId = (event as CustomEvent<{ itemId?: string }>).detail?.itemId
      if (itemId) setActiveSound(itemId)
    }
    window.addEventListener(WEB_CARD_AUDIO_EVENT, onAudio)
    return () => {
      window.removeEventListener(WEB_CARD_AUDIO_EVENT, onAudio)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const wakeCanvas = useCallback((canvasId: string) => {
    const timer = sleepTimersRef.current.get(canvasId)
    if (timer) window.clearTimeout(timer)
    sleepTimersRef.current.delete(canvasId)
    setSleepingCanvasIds((current) => current.has(canvasId) ? new Set([...current].filter((id) => id !== canvasId)) : current)
  }, [])

  const idleCanvas = useCallback((canvasId: string) => {
    const previous = sleepTimersRef.current.get(canvasId)
    if (previous) window.clearTimeout(previous)
    const timer = window.setTimeout(() => {
      if (activeCanvasRef.current !== canvasId && !interactingCanvasIdsRef.current.has(canvasId)) setSleepingCanvasIds((current) => new Set(current).add(canvasId))
      sleepTimersRef.current.delete(canvasId)
    }, 10000)
    sleepTimersRef.current.set(canvasId, timer)
  }, [])

  const setCanvasInteractionState = useCallback((canvasId: string, active: boolean, mode?: SurfaceInteractionMode) => {
    // 拖动/缩放期间让原生子窗口不接收鼠标。它们浮在 WebView2 之上，指针划过去
    // 就会把 pointerup 吃掉，交互再也结束不了（缩放窗口时鼠标一直跟着跑）。
    if (active) {
      interactingCanvasIdsRef.current.add(canvasId)
      if (mode === 'marquee') marqueeCanvasIdsRef.current.add(canvasId)
      wakeCanvas(canvasId)
    } else {
      interactingCanvasIdsRef.current.delete(canvasId)
      marqueeCanvasIdsRef.current.delete(canvasId)
      if (canvasId !== ROOT_ID) idleCanvas(canvasId)
      setInteractionEpoch((value) => value + 1)
    }
    const anyActive = interactingCanvasIdsRef.current.size > 0
    window.dispatchEvent(new CustomEvent('zhangzhongjie-native-interaction', { detail: { active: anyActive } }))
    window.chrome?.webview?.postMessage({ type: 'native-interaction', active: anyActive })
  }, [idleCanvas, wakeCanvas])

  useEffect(() => {
    if (bootMode !== 'ready') return
    for (const canvas of spaces) if (canvas.id !== ROOT_ID && !initializedSleepCanvasIdsRef.current.has(canvas.id)) {
      initializedSleepCanvasIdsRef.current.add(canvas.id)
      idleCanvas(canvas.id)
    }
  }, [bootMode, idleCanvas, spaces])

  useEffect(() => () => { for (const timer of sleepTimersRef.current.values()) window.clearTimeout(timer) }, [])

  useEffect(() => {
    const onFullscreenChange = () => setIsNativeFullscreen(document.fullscreenElement === focusStageRef.current)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const pushHistory = useCallback(() => {
    historyRef.current = [...historyRef.current.slice(-24), { items: itemsRef.current.map((item) => ({ ...item })), spaces: spacesRef.current.map((canvas) => ({ ...canvas, viewport: { ...canvas.viewport }, fixedEntries: canvas.fixedEntries.map((entry) => ({ ...entry })) })) }]
    redoRef.current = []
  }, [])

  // 「固定到当前画布」：往当前画布那一栏加/删一条（Ctrl+1..9 画布优先）。
  useEffect(() => {
    const onPin = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string; label?: string; source?: string; sourceKind?: 'file' | 'folder' | 'app'; image?: string }>).detail
      const target = detail?.target
      if (!target) return
      const canvasId = activeCanvasRef.current
      const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
      if (!canvas) return
      const exists = canvas.fixedEntries.some((entry) => entry.target === target)
      const item = itemsRef.current.find((candidate) => candidate.id === target)
      const label = detail?.label || item?.title || '卡片'
      const source = detail?.source
      const sourceKind = detail?.sourceKind
      const image = detail?.image
      pushHistory()
      setSpaces((current) => current.map((entry) => entry.id !== canvasId ? entry : {
        ...entry,
        fixedEntries: exists
          ? entry.fixedEntries.filter((fixed) => fixed.target !== target)
          : [...entry.fixedEntries, { ...fixedEntryForItem(item?.kind, target, label), ...(source ? { source, sourceKind } : {}), ...(image ? { image } : {}) }],
      }))
      setToast(exists
        ? `已从「当前画布」快捷栏移除：${label}`
        : `已固定到当前画布：${label}（这个画布里 Ctrl+1..9 优先用它）`)
    }
    window.addEventListener(CURRENT_CANVAS_PIN_EVENT, onPin)
    return () => window.removeEventListener(CURRENT_CANVAS_PIN_EVENT, onPin)
  }, [pushHistory, setToast])

  useEffect(() => {
    const beginNoteEdit = (event: Event) => {
      const itemId = (event as CustomEvent<{ itemId?: string }>).detail?.itemId
      if (!itemId || !itemsRef.current.some((item) => item.id === itemId && item.kind === 'note')) return
      pushHistory()
    }
    const commitNoteEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; text?: string; title?: string }>).detail
      if (!detail?.itemId || typeof detail.text !== 'string' || typeof detail.title !== 'string') return
      const { itemId, text, title } = detail
      setItems((current) => {
        let changed = false
        const next = current.map((item) => {
          if (item.id !== itemId || item.kind !== 'note' || (item.text === text && item.title === title)) return item
          changed = true
          return { ...item, text, title }
        })
        if (changed) itemsRef.current = next
        return changed ? next : current
      })
    }
    const commitShelfEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; shelfItems?: CanvasItem['shelfItems'] }>).detail
      if (!detail?.itemId || !Array.isArray(detail.shelfItems)) return
      const { itemId, shelfItems } = detail
      setItems((current) => {
        let changed = false
        const next = current.map((candidate) => {
          if (candidate.id !== itemId || candidate.kind !== 'shelf') return candidate
          changed = true
          return { ...candidate, shelfItems }
        })
        if (changed) itemsRef.current = next
        return changed ? next : current
      })
    }
    window.addEventListener(NOTE_EDIT_START_EVENT, beginNoteEdit)
    window.addEventListener(NOTE_COMMIT_EVENT, commitNoteEdit)
    window.addEventListener(SHELF_COMMIT_EVENT, commitShelfEdit)
    return () => {
      window.removeEventListener(NOTE_EDIT_START_EVENT, beginNoteEdit)
      window.removeEventListener(NOTE_COMMIT_EVENT, commitNoteEdit)
      window.removeEventListener(SHELF_COMMIT_EVENT, commitShelfEdit)
    }
  }, [pushHistory])

  const undo = useCallback(() => {
    const previous = historyRef.current.pop()
    if (!previous) { setToast('目前没有可撤销的操作'); return }
    redoRef.current = [...redoRef.current.slice(-24), { items:itemsRef.current.map((item) => ({ ...item })), spaces: spacesRef.current.map((canvas) => ({ ...canvas, viewport: { ...canvas.viewport }, fixedEntries: canvas.fixedEntries.map((entry) => ({ ...entry })) })) }]
    setItems(previous.items); setSpaces(previous.spaces); setSelectedIds([]); setToast('已撤销：再按 Ctrl+Y 可以重做')
  }, [])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) { setToast('没有可重做的操作'); return }
    historyRef.current = [...historyRef.current.slice(-24), { items:itemsRef.current.map((item) => ({ ...item })), spaces: spacesRef.current.map((canvas) => ({ ...canvas, viewport: { ...canvas.viewport }, fixedEntries: canvas.fixedEntries.map((entry) => ({ ...entry })) })) }]
    setItems(next.items); setSpaces(next.spaces); setSelectedIds([]); setToast('已重做')
  }, [])

  const saveDocument = useCallback(() => {
    if (bootMode !== 'ready') { setToast('请先选择还原上次状态或打开默认桌布'); return }
    requestProjectSave('save')
  }, [bootMode, requestProjectSave])

  const saveDocumentAs = useCallback(() => {
    if (bootMode !== 'ready') { setToast('请先选择还原上次状态或打开默认桌布'); return }
    requestProjectSave('saveAs')
  }, [bootMode, requestProjectSave])
  const exportDocument = useCallback(() => {
    if (bootMode !== 'ready') { setToast('请先选择还原上次状态或打开默认桌布'); return }
    requestProjectSave('export')
  }, [bootMode, requestProjectSave])

  // Ctrl+方向键 → 在对应那一侧列出程序：选完直接贴到画布旁边，Esc 取消。
  const openSplitQuick = useCallback((side: 'left' | 'right' | 'top' | 'bottom') => {
    setSplitQuickSide(side)
    setSplitQuickFilter('')
    setSplitQuickIndex(0)
    setTileSelectedHandles([])
    setTilePickerError('')
    setTileWindowOptions([])
    setTilePickerLoading(true)
    const bridge = window.chrome?.webview
    if (bridge) bridge.postMessage({ type: 'native-window-tile-query' })
    else { setTilePickerLoading(false); setTilePickerError('分屏仅在掌中界 Windows 程序中可用') }
    window.requestAnimationFrame(() => splitQuickInputRef.current?.focus())
  }, [])

  const applySplitQuick = useCallback((handles: string[]) => {
    const side = splitQuickSide
    const bridge = window.chrome?.webview
    if (!side || !bridge || !handles.length) return
    const vertical = side === 'left' || side === 'right'
    // 一个程序 → 两分屏（走系统贴靠，边界可拖动调整）；两个以上 → 三列/四宫格。
    const layout = handles.length === 1 ? (vertical ? 'cols2' : 'rows2') : handles.length === 2 ? 'cols3' : 'grid2x2'
    const selfSlot = handles.length === 1
      ? ((side === 'left' || side === 'top') ? 0 : 1)
      : ((side === 'left' || side === 'top') ? 0 : 2)
    setSplitEdgeSide(side)
    setSplitQuickSide(null)
    setTileSelectedHandles([])
    bridge.postMessage({ type: 'native-window-tile-apply', handles, layout, selfSlot })
    const names = handles
      .map((handle) => tileWindowOptions.find((entry) => entry.handle === handle)?.process)
      .filter((value): value is string => Boolean(value))
    try { localStorage.setItem(SPLIT_APPS_KEY, JSON.stringify(names)) } catch { /* 忽略 */ }
  }, [splitQuickSide, tileWindowOptions])

  const requestTileWindowOptions = useCallback((open: boolean) => {
    if (open) setTilePickerOpen(true)
    setTileWindowOptions([])
    setTileSelectedHandles([])
    setTilePickerError('')
    setTilePickerApplying(false)
    setTilePickerLoading(true)
    const bridge = window.chrome?.webview
    if (bridge) bridge.postMessage({ type: 'native-window-tile-query' })
    else {
      setTilePickerLoading(false)
      setTilePickerError('窗口平铺仅在掌中界 Windows 程序中可用')
    }
  }, [])

  useEffect(() => {
    const runShortcut = (shortcutId: ShortcutId | undefined, sourceEvent?: KeyboardEvent, nativeSurfaceId?: string) => {
      if (!shortcutId) return
      const prevent = () => sourceEvent?.preventDefault()
      if (shortcutId === 'app.settings') { prevent(); revealChrome(); setShowSettings(true); return }
      if (shortcutId === 'app.search') {
        prevent()
        revealChrome()
        const alreadyFocused = document.activeElement === searchRef.current
        setSearchMode((current) => alreadyFocused ? (current === 'url' ? 'disk' : 'url') : 'url')
        window.requestAnimationFrame(() => searchRef.current?.focus())
        return
      }
      if (shortcutId === 'history.undo') { prevent(); undo(); return }
      if (shortcutId === 'history.redo') { prevent(); redo(); return }
      if (shortcutId === 'canvas.export') { prevent(); setExportMode('board'); setExportAnchor({ left: Math.round(window.innerWidth / 2 - 170), top: 96 }); return }
      if (shortcutId === 'canvas.organize') { prevent(); organizeByTypeRef.current(); return }
      if (shortcutId === 'canvas.toggleNavigator') {
        prevent()
        setSpaceNavigatorOpen((current) => !current)
        return
      }
      const globalSlotMatch = /^quick\.slot(\d)$/.exec(shortcutId)
      if (globalSlotMatch) { prevent(); globalSlotRunRef.current(Number(globalSlotMatch[1]) - 1); return }
      if (shortcutId === 'canvas.addWeb' || shortcutId === 'canvas.addComputer') { prevent(); quickAddShortcutRef.current(shortcutId === 'canvas.addWeb' ? 'web' : 'folder'); return }
      if (shortcutId === 'selection.group') { prevent(); groupToggleRef.current(); return }
      if (shortcutId === 'file.back' && focusedWorkspaceRef.current) {
        const focused = itemsRef.current.find((item) => item.id === focusedWorkspaceRef.current)
        if (focused?.kind === 'folder') { prevent(); postNativeExplorerCommand(focused.id, 'back'); return }
      }
      if (shortcutId === 'selection.delete' && selectedIdsRef.current.length) { prevent(); deleteSelection(); return }
      if (shortcutId === 'project.save') { prevent(); saveDocument(); return }
      if (shortcutId === 'project.saveAs') { prevent(); saveDocumentAs(); return }
      if (shortcutId === 'project.export') { prevent(); exportDocument(); return }
      if (shortcutId === 'window.splitUp' || shortcutId === 'window.splitDown') {
        prevent()
        if (sourceEvent?.repeat) return
        openSplitQuick(shortcutId === 'window.splitUp' ? 'top' : 'bottom')
        return
      }
      if (shortcutId === 'window.tile') {
        prevent()
        if (sourceEvent?.repeat) return
        requestTileWindowOptions(true)
        return
      }
      if (shortcutId === 'window.snapLeft' || shortcutId === 'window.snapRight') {
        prevent()
        if (sourceEvent?.repeat) return
        // 只弹掌中界自己的挑程序面板：不再让 Windows 去贴靠，
        // 免得系统弹出「贴靠布局 / 贴靠助手」那个带三四列模板的浮层。
        // 掌中界自己的位置由应用时一起摆（和挑中的程序同时落位）。
        openSplitQuick(shortcutId === 'window.snapLeft' ? 'left' : 'right')
        return
      }
      if (shortcutId === 'window.maximize') {
        prevent()
        if (sourceEvent?.repeat) return
        window.chrome?.webview?.postMessage({ type: 'native-window-toggle-maximize' })
        return
      }
      if (shortcutId === 'window.snapLayout') {
        prevent()
        if (sourceEvent?.repeat) return
        window.chrome?.webview?.postMessage({ type: 'native-window-snap-layout' })
        return
      }
      if (shortcutId === 'browser.back' || shortcutId === 'browser.forward' || shortcutId === 'browser.reload') {
        const surfaceId = nativeSurfaceId || selectedIdsRef.current.at(-1)
        if (surfaceId) { prevent(); postNativeBrowserCommand(surfaceId, shortcutId.split('.')[1] as 'back' | 'forward' | 'reload') }
        return
      }
      if (shortcutId === 'overlay.close') {
        prevent()
        if (splitQuickSideRef.current) { setSplitQuickSide(null); setTileSelectedHandles([]); return }
        if (splitEdgeSideRef.current) {
          // 退出分屏：让画布回到分屏前的位置和大小。
          setSplitEdgeSide(null)
          window.chrome?.webview?.postMessage({ type: 'native-split-release' })
          return
        }
        if (tilePickerOpen) { setTilePickerOpen(false); return }
        if (pendingGlobalFavoriteRemoval) { setPendingGlobalFavoriteRemoval(null); return }
        if (projectOpenPromptRef.current) { updateProjectOpenPrompt(null); return }
        if (showEverythingInstallPrompt) { setShowEverythingInstallPrompt(false); updateGlobalSettings({ everythingPromptDismissed: true }); return }
        if (showSettings) { setShowSettings(false); return }
        if (isFallbackFullscreen) { setIsFallbackFullscreen(false); return }
        const immersiveCard = itemsRef.current.find((entry) => entry.immersive)
        if (immersiveCard) { toggleImmersive(immersiveCard.id, false); setToast('已退出纯画面（桌布）模式'); return }
        setPreviewId(null); setShellPreviewTarget(null); setShowSplitPicker(false); setSelectedIds([])
        return
      }
      if ((shortcutId === 'preview.previous' || shortcutId === 'preview.next') && shellPreviewTarget) {
        const index = shellPreviewTarget.siblings.findIndex((entry) => entry.path === shellPreviewTarget.entry.path)
        const next = shellPreviewTarget.siblings[index + (shortcutId === 'preview.previous' ? -1 : 1)]
        if (next) { prevent(); setShellPreviewTarget({ ...shellPreviewTarget, entry: next }) }
        return
      }
      if (shortcutId === 'preview.toggle') {
        prevent()
        if (shellPreviewTarget || previewId) { setShellPreviewTarget(null); setPreviewId(null); return }
        const focusedList = (sourceEvent?.target as HTMLElement | null)?.closest<HTMLElement>('.fm-file-area')
          ?? (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.fm-file-area')
        const surfaceId = nativeSurfaceId || focusedList?.dataset.surfaceId
        const shellSelection = surfaceId ? shellSelectionsRef.current.get(surfaceId) : undefined
        if (surfaceId && shellSelection?.selected.length) {
          setShellPreviewTarget({ surfaceId, entry: shellSelection.selected.at(-1)!, siblings: shellSelection.siblings })
          return
        }
        const id = selectedRef.current.at(-1)
        const item = id ? itemsRef.current.find((entry) => entry.id === id) : undefined
        if (item) openCanvasPreview(item)
        return
      }
      if (contextualShortcutRef.current(shortcutId)) prevent()
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const shortcutId = shortcutIdForEvent(event, settingsRef.current.shortcutBindings)
      const isEditableTarget = Boolean(target?.closest('input,textarea,[contenteditable],.fm-file-area'))
      if (isEditableTarget && shortcutId !== 'app.search' && shortcutId !== 'window.snapLeft' && shortcutId !== 'window.snapRight' && shortcutId !== 'window.snapLayout' && shortcutId !== 'window.tile') return
      runShortcut(shortcutId, event)
    }
    const onNativeShortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: ShortcutId; surfaceId?: string }>).detail
      runShortcut(detail?.id, undefined, detail?.surfaceId)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(APP_SHORTCUT_EVENT, onNativeShortcut)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(APP_SHORTCUT_EVENT, onNativeShortcut) }
  }, [exportDocument, isFallbackFullscreen, openCanvasPreview, pendingGlobalFavoriteRemoval, previewId, requestTileWindowOptions, revealChrome, saveDocument, saveDocumentAs, shellPreviewTarget, showEverythingInstallPrompt, showSettings, tilePickerOpen, undo, updateGlobalSettings, updateProjectOpenPrompt])

  const setCanvasViewport = useCallback((canvasId: string, viewport: Viewport) => {
    const previousScale = spacesRef.current.find((canvas) => canvas.id === canvasId)?.viewport.scale
    setSpaces((current) => current.map((canvas) => canvas.id === canvasId ? { ...canvas, viewport } : canvas))
    if (previousScale !== undefined && Math.abs(previousScale - viewport.scale) > .0001) {
      window.dispatchEvent(new CustomEvent(CANVAS_SCALE_EVENT, { detail: { canvasId, scale: viewport.scale } }))
    }
  }, [])

  const itemRenameRef = useRef(itemRename)
  itemRenameRef.current = itemRename
  const renameCanvasRef = useRef<((canvasId: string, title: string) => void) | null>(null)
  // 标题栏右键：统一走元素右键菜单（画布卡原来在这里什么都弹不出来，「修改名称」也就没入口）
  useEffect(() => {
    const onTitlebarMenu = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId: string; clientX: number; clientY: number }>).detail
      if (!detail?.itemId) return
      const item = itemsRef.current.find((entry) => entry.id === detail.itemId)
      if (!item) return
      setMenuGroup(null)
      setContextMenu({ canvasId: item.canvasId, itemId: item.id, clientX: Math.round(detail.clientX), clientY: Math.round(detail.clientY), worldX: 0, worldY: 0 })
    }
    window.addEventListener('zhangzhongjie-titlebar-menu', onTitlebarMenu)
    return () => window.removeEventListener('zhangzhongjie-titlebar-menu', onTitlebarMenu)
  }, [])

  const startItemRename = useCallback((item: CanvasItem) => {
    const space = item.childCanvasId ? spacesRef.current.find((entry) => entry.id === item.childCanvasId) : undefined
    const element = document.querySelector(`.canvas-item[data-item-id="${item.id}"] .window-titlebar`) as HTMLElement | null
    const rect = element?.getBoundingClientRect()
    setItemRename({
      itemId: item.id,
      spaceId: space?.id ?? null,
      draft: space ? space.title : item.title,
      left: rect ? Math.round(rect.left + 6) : Math.round(window.innerWidth / 2 - 110),
      top: rect ? Math.round(rect.top + 2) : Math.round(window.innerHeight / 2 - 18),
      width: rect ? Math.max(150, Math.round(rect.width - 12)) : 220,
    })
  }, [])

  const startCanvasRename = useCallback((canvasId: string) => {
    const space = spacesRef.current.find((entry) => entry.id === canvasId)
    if (!space) return
    const host = space.hostItemId ? itemsRef.current.find((entry) => entry.id === space.hostItemId) : undefined
    const element = host ? (document.querySelector(`.canvas-item[data-item-id="${host.id}"] .window-titlebar`) as HTMLElement | null) : null
    const rect = element?.getBoundingClientRect()
    setItemRename({
      itemId: host?.id ?? '',
      spaceId: space.id,
      draft: space.title,
      left: rect ? Math.round(rect.left + 6) : Math.round(window.innerWidth / 2 - 110),
      top: rect ? Math.round(rect.top + 2) : Math.round(window.innerHeight / 2 - 18),
      width: rect ? Math.max(150, Math.round(rect.width - 12)) : 220,
    })
  }, [])

  const commitItemRename = useCallback((value?: string) => {
    const pending = itemRenameRef.current
    if (!pending) return
    setItemRename(null)
    const title = String(value ?? pending.draft).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 80)
    if (!title) return
    if (pending.spaceId) {
      renameCanvasRef.current?.(pending.spaceId, title)
      setToast(`画布已改名：${title}`)
      return
    }
    const current = itemsRef.current.find((entry) => entry.id === pending.itemId)
    if (!current || current.title === title) return
    pushHistory()
    setItems((list) => list.map((entry) => (entry.id === pending.itemId ? { ...entry, title } : entry)))
    setToast(`已改名：${title}`)
  }, [pushHistory])

  useEffect(() => {
    const onTodoUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId: string; todo: TodoEntry[]; history?: boolean }>).detail
      if (!detail?.itemId || !Array.isArray(detail.todo)) return
      if (detail.history !== false) pushHistory()
      setItems((current) => current.map((entry) => (entry.id === detail.itemId ? { ...entry, todo: detail.todo } : entry)))
    }
    window.addEventListener('zhangzhongjie-todo-update', onTodoUpdate)
    return () => window.removeEventListener('zhangzhongjie-todo-update', onTodoUpdate)
  }, [pushHistory])

  useEffect(() => {
    // 开机问一次模板列表：万一开了「自动套用默认模板」，这里会顺手把它套上
    if (!window.chrome?.webview) return
    const timer = window.setTimeout(() => window.chrome?.webview?.postMessage({ type: 'native-template-list-request' }), 600)
    return () => window.clearTimeout(timer)
  }, [])

  // Esc 关模板库（和其它浮层一致）
  useEffect(() => {
    if (!showTemplates) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setShowTemplates(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showTemplates])

  const refreshTemplates = useCallback(() => {
    window.chrome?.webview?.postMessage({ type: 'native-template-list-request' })
  }, [])
  const openTemplates = useCallback(() => { setTemplateQuery(''); setShowTemplates(true); setTemplateJustSaved(''); refreshTemplates() }, [refreshTemplates])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const onTemplateMessage = (event: MessageEvent) => {
      const data = event.data
      if (data?.type === 'native-template-list') {
        // 宿主回的 thumb 是「封面图片的文件路径」；前端得先转成 data URL 才能当 <img src>，
        // 所以把它落到 thumbPath，thumb（真正的 data URL）由下面那个 effect 补齐。
        const items = (Array.isArray(data.items) ? data.items : []).map((entry: { thumb?: string }) => ({ ...entry, thumbPath: entry.thumb || '', thumb: '' }))
        setTemplateItems(items)
        setTemplateDefault(String(data.default ?? ''))
        setTemplateFolder(String(data.folder ?? ''))
        setTemplateAuto(data.autoApply === true)
        // 开机自动套用默认模板：只在还没选画布时做一次
        if (data.autoApply === true && !templateBootCheckedRef.current && bootModeRef.current === 'ask') {
          const target = items.find((entry: { name: string }) => entry.name === String(data.default ?? ''))
          if (target) {
            templateBootCheckedRef.current = true
            templateApplyPendingRef.current = true
            setTemplateBusy(true)
            window.chrome?.webview?.postMessage({ type: 'native-template-apply', requestId: crypto.randomUUID(), path: target.path })
          }
        }
        return
      }
      if (data?.type === 'native-template-rename-result') {
        if (data.success) { setTemplateRenaming(null); setToast(`模板已重命名${data.name ? '：' + data.name : ''}`) } else setToast(`重命名失败：${data.error || '未知原因'}`)
        return
      }
      if (data?.type === 'native-template-save-result') {
        setTemplateBusy(false)
        setToast(data.success ? (overwriteTemplateRef.current ? `已覆盖模板「${data.name}」` : `模板已保存：${data.name}`) : `保存模板失败：${data.error || '未知原因'}`)
        overwriteTemplateRef.current = false
        if (data.success) { setTemplateCreating(null); setTemplateJustSaved(String(data.name ?? '')) }
        // 模板库推迟到这里开：抓封面那一刻它不能是打开的（否则会被抓进封面里）
        if (data.success && openGalleryAfterSaveRef.current) { openGalleryAfterSaveRef.current = false; setShowTemplates(true) }
        openGalleryAfterSaveRef.current = false
        refreshTemplates()
        return
      }
      if (data?.type === 'native-template-apply-result') {
        setTemplateBusy(false)
        if (data.success) {
          const origin = templateOriginPendingRef.current
          templateOriginPendingRef.current = null
          if (origin) {
            // 画布名沿用模板名（用户 2026-09-15：从「股市」进画布就该叫「股市」，
            // 否则存回去会变成「项目一 N」，永远更新不回原模板）
            try { localStorage.setItem(TEMPLATE_ORIGIN_KEY, JSON.stringify(origin)) } catch { /* 忽略 */ }
            setSpaces((current) => current.map((entry) => entry.id === ROOT_ID ? { ...entry, title: origin.name, originTemplate: { name: origin.name, path: origin.path } } : entry))
            setToast(`已套用模板「${origin.name}」· 改完右键「保存现在的画布为模板」即可覆盖更新`)
          } else {
            setToast('模板已套用 · 按 Ctrl+S 可另存为项目')
          }
          setShowTemplates(false)
          setBootMode('ready')
        } else setToast(`套用模板失败：${data.error || '未知原因'}`)
      }
    }
    bridge.addEventListener('message', onTemplateMessage)
    return () => bridge.removeEventListener('message', onTemplateMessage)
  }, [refreshTemplates, setToast])

  // 模板封面：宿主回的是「文件路径」，得转成 data URL 才能当 <img src>（用户 2026-09-16：模板卡要真封面）。
  // 拿不到（没封面 / 读失败）就回退到原来的迷你示意图，所以失败也无所谓。
  const templateCoverPendingRef = useRef(new Map<string, string>())
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const onCover = (event: MessageEvent) => {
      const data = event.data
      if (data?.type !== 'native-image-dataurl') return
      const requestId = String(data.requestId ?? '')
      const path = templateCoverPendingRef.current.get(requestId)
      if (path === undefined) return
      templateCoverPendingRef.current.delete(requestId)
      const url = String(data.dataUrl ?? '')
      if (!url) return
      setTemplateItems((current) => current.map((entry) => (entry.thumbPath === path ? { ...entry, thumb: url } : entry)))
    }
    bridge.addEventListener('message', onCover)
    return () => bridge.removeEventListener('message', onCover)
  }, [])

  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const pending = templateCoverPendingRef.current
    for (const entry of templateItems) {
      const path = entry.thumbPath
      if (!path || entry.thumb) continue
      if ([...pending.values()].includes(path)) continue
      const requestId = `tpl-cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      pending.set(requestId, path)
      window.setTimeout(() => pending.delete(requestId), 15000)
      bridge.postMessage({ type: 'native-read-image-dataurl', requestId, path })
    }
  }, [templateItems])

  const saveCurrentAsTemplate = useCallback((rawName: string) => {
    const name = rawName.trim()
    setTemplateCreating(null)
    if (!name) { setToast('先给模板起个名字，比如「工作」'); return }
    const session = sessionFromState(itemsRef.current, spacesRef.current, themeRef.current, focusedWorkspaceRef.current, activeCanvasRef.current)
    const payload = buildProjectPayload(session, name, false, packageRootsRef.current)
    setTemplateBusy(true)
    // 桌面端抓封面用的是「屏幕上这一刻的画面」（模板缩略图要真实渲染，用户 2026-09-16），
    // 所以发请求前先把浮层撤掉、等两帧重绘 —— 否则封面里会带上「保存画布为模板」那个小面板。
    // 模板库也推迟到保存结果回来再开（否则刚打开的浮层会被一起抓进去）。
    const bridge = window.chrome?.webview
    if (!bridge) return
    setSaveTemplatePrompt(null)
    setShowTemplates(false)
    const thumbnail = itemsRef.current.length > 0   // 空画布不抓图（抓出来是一张灰纸，没意义）
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      bridge.postMessage({ type: 'native-template-save', requestId: crypto.randomUUID(), name, ...payload, thumbnail })
    }))
  }, [setToast])

  // 「保存现在的画布为模板」：不起名、不弹框，直接用当前画布的名字存一套（撞名自动加序号），
  // 存完把模板库打开 —— 新模板立刻带缩略图出现在里面（用户 2026-09-14 要的一步到位）。
  const saveCanvasAsTemplateQuick = useCallback(() => {
    const canvas = spacesRef.current.find((entry) => entry.id === activeCanvasRef.current)
    const base = (canvas?.title || '').trim() || '新模板'
    const taken = new Set(templateItems.map((entry) => entry.name))
    let name = base
    for (let index = 2; taken.has(name) && index < 60; index += 1) name = `${base} ${index}`
    // 从模板开出来的画布：先问「覆盖更新 / 另存为新模板」（用户 2026-09-15）
    // 只认「当前这张画布」自己的来源（用户 2026-09-15 报：在默认画布上存模板却问“覆盖更新【某模板】”——
    // 上一版把来源存在全局 localStorage 里，切了画布还在。现在记在画布自己身上，跟 .zzj 一起存。）
    const origin = canvas?.originTemplate ?? null
    const rememberOrigin = (name: string) => setSpaces((current) => current.map((entry) => entry.id === activeCanvasRef.current ? { ...entry, title: name, originTemplate: { name } } : entry))
    // 不管有没有来源，都先让用户看到名字、能改（用户 2026-09-15 反复要求：选了「保存画布为模板」
    // 要能改名字、然后直接存为模板，并把模板库打开）。
    setSaveTemplateName(base)
    setSaveTemplatePrompt({ name: origin?.name ?? '', freshName: name })
  }, [saveCurrentAsTemplate, templateItems])

  // 卡片右键菜单里的「保存现在的画布为模板」→ 走同一套保存（一步到位：自动起名 + 打开模板库）
  useEffect(() => {
    const onSave = () => saveCanvasAsTemplateQuick()
    window.addEventListener(SAVE_CANVAS_TEMPLATE_EVENT, onSave)
    return () => window.removeEventListener(SAVE_CANVAS_TEMPLATE_EVENT, onSave)
  }, [saveCanvasAsTemplateQuick])

  // 一次性迁移：把老的「全局收藏」搬进当前画布的那一栏（用户 2026-09-15：快捷栏要跟画布/模板走）
  useEffect(() => {
    const key = 'zhangzhongjie.canvasPinsMigrated.v1'
    if (localStorage.getItem(key)) return
    const favorites = settingsRef.current.globalFavorites ?? []
    if (!favorites.length) return
    const canvasId = activeCanvasRef.current
    const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
    if (!canvas) return
    localStorage.setItem(key, '1')
    setSpaces((current) => current.map((entry) => {
      if (entry.id !== canvasId) return entry
      const existing = new Set(entry.fixedEntries.map((fixed) => fixed.target))
      const additions = favorites
        .filter((favorite) => !existing.has(`pin:${favorite.source}`) && !existing.has(favorite.id))
        .map((favorite) => ({
          icon: '◎', label: favorite.label, target: `pin:${favorite.source}`, tone: 'canvas',
          source: favorite.source, sourceKind: favorite.sourceKind, image: favorite.image,
        }))
      return additions.length ? { ...entry, fixedEntries: [...entry.fixedEntries, ...additions] } : entry
    }))
    setToast('已把原来的固定项搬进「当前画布」那一栏（以后每个画布/模板各有一套）')
  }, [])

  // 固定栏里"有路径但没图标"的条目 → 找宿主要图标（应用/文件都行），拿到就写回条目。
  // 用户 2026-09-15：「拖进去的出现在这里，但没有图标」——迁移过来的老收藏有图标，
  // 新固定的没带 image，这一条就是给它们补图标的。
  const requestedPinnedIconsRef = useRef(new Set<string>())
  const lastFavoriteDropZoneRef = useRef<'global' | 'current'>('current')
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !nativeReady) return
    const missing = spaces
      .flatMap((canvas) => canvas.fixedEntries)
      .filter((entry) => entry.source && !entry.image && !requestedPinnedIconsRef.current.has(entry.source))
    if (!missing.length) return
    for (const entry of missing) {
      const source = entry.source as string
      const cached = appResolveCache.get(source)
      if (cached?.image) {
        setSpaces((current) => current.map((canvas) => ({
          ...canvas,
          fixedEntries: canvas.fixedEntries.map((fixed) => fixed.source === source && !fixed.image ? { ...fixed, image: cached.image } : fixed),
        })))
        continue
      }
      requestedPinnedIconsRef.current.add(source)
      const requestId = `pinned-icon:${crypto.randomUUID()}`
      const receive = (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: string; name?: string; image?: string } | undefined
        if (data?.type !== 'native-app-resolve' || data.requestId !== requestId || !data.image) return
        bridge.removeEventListener('message', receive)
        appResolveCache.set(source, { name: data.name || entry.label, image: data.image })
        setSpaces((current) => current.map((canvas) => ({
          ...canvas,
          fixedEntries: canvas.fixedEntries.map((fixed) => fixed.source === source && !fixed.image ? { ...fixed, image: data.image } : fixed),
        })))
      }
      bridge.addEventListener('message', receive)
      bridge.postMessage({ type: 'native-app-resolve-request', requestId, path: source })
    }
  }, [spaces, nativeReady])

  const templateApplyPendingRef = useRef(false)
  // 这次套用的是哪个模板（用于：画布改名 + 保存时问「是否覆盖」）
  const templateOriginPendingRef = useRef<{ name: string; path: string } | null>(null)
  // 「保存现在的画布为模板」时的小确认（非模态，就地两个按钮）

  const applyTemplate = useCallback((path: string) => {
    templateApplyPendingRef.current = true
    const picked = templateItems.find((entry) => entry.path === path)
    templateOriginPendingRef.current = picked ? { name: picked.name, path } : null
    setTemplateBusy(true)
    window.chrome?.webview?.postMessage({ type: 'native-template-apply', requestId: crypto.randomUUID(), path })
  }, [templateItems])

  const deleteTemplate = useCallback((entry: { name: string; path: string }) => {
    window.chrome?.webview?.postMessage({ type: 'native-template-delete', path: entry.path })
    setToast(`已删除模板：${entry.name}`)
  }, [setToast])

  const setTemplateAutoApply = useCallback((on: boolean) => {
    setTemplateAuto(on)
    window.chrome?.webview?.postMessage({ type: 'native-template-set-auto', on })
    setToast(on ? '已开启：开机自动套用默认模板' : '已关闭：开机不再自动套用模板')
  }, [setToast])

  const renameTemplate = useCallback((path: string, name: string) => {
    const next = name.trim()
    if (!next) return
    window.chrome?.webview?.postMessage({ type: 'native-template-rename', path, name: next })
  }, [])

  const markDefaultTemplate = useCallback((entry: { name: string; path: string }) => {
    window.chrome?.webview?.postMessage({ type: 'native-template-set-default', name: entry.name })
    setToast(`已设为默认模板：${entry.name}`)
  }, [setToast])

  const renameCanvas = useCallback((canvasId: string, title: string) => {
    const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
    if (!canvas || canvas.title === title) return
    pushHistory()
    setSpaces((current) => current.map((entry) => {
      const renamedCanvas = entry.id === canvasId
      const hasMatchingFixedEntry = Boolean(canvas.hostItemId && entry.fixedEntries.some((fixed) => fixed.target === canvas.hostItemId))
      if (!renamedCanvas && !hasMatchingFixedEntry) return entry
      return {
        ...entry,
        title: renamedCanvas ? title : entry.title,
        fixedEntries: hasMatchingFixedEntry
          ? entry.fixedEntries.map((fixed) => fixed.target === canvas.hostItemId ? { ...fixed, label: title } : fixed)
          : entry.fixedEntries,
      }
    }))
    if (canvas.hostItemId) setItems((current) => current.map((item) => item.id === canvas.hostItemId ? { ...item, title } : item))
    setToast(`画布已重命名为“${title}”`)
  }, [pushHistory])
  // 让 startItemRename/commitItemRename 拿到 renameCanvas（写在函数体会在首次调用时还没赋值 → 假改名）
  useEffect(() => { renameCanvasRef.current = renameCanvas }, [renameCanvas])

  // 最大化与分屏不再是子画布的特权：文件管理器窗口和浏览器窗口同样可以双击
  // 标题栏最大化，最大化后一样能从四周边线拖出递归分屏（用户 2026-09-02 要求）。
  const FOCUSABLE_KINDS: ItemKind[] = ['workspace', 'folder', 'web', 'video']
  const toggleWorkspaceFocus = useCallback((item: CanvasItem) => {
    if (!FOCUSABLE_KINDS.includes(item.kind)) return
    if (item.kind === 'workspace' && !item.childCanvasId) return
    setFocusedWorkspaceId((current) => {
      if (current === item.id) {
        setIsFallbackFullscreen(false)
        setToast('已恢复到最大化前的位置和尺寸，内部分屏保持不变')
        return null
      }
      if (item.childCanvasId) {
        wakeCanvas(item.childCanvasId)
        setActiveCanvasId(item.childCanvasId)
      }
      setSelectedIds([item.id])
      setToast('已最大化；从四周边线向内拖动可创建分屏')
      return item.id
    })
  }, [wakeCanvas])

  const updateWorkspaceSplit = useCallback((itemId: string, layout: WorkspaceSplitLayout | undefined) => {
    setItems((current) => current.map((item) => {
      if (item.id !== itemId) return item
      if (layout) return { ...item, workspaceSplit: layout }
      const { workspaceSplit: _removed, ...withoutSplit } = item
      return withoutSplit
    }))
  }, [])

  const toggleNativeFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (isFallbackFullscreen) setIsFallbackFullscreen(false)
      else if (focusStageRef.current?.requestFullscreen) await focusStageRef.current.requestFullscreen()
      else setIsFallbackFullscreen(true)
    } catch {
      setIsFallbackFullscreen(true)
      setToast(`当前环境使用应用内容全屏；${shortcutDisplay(settingsRef.current.shortcutBindings, 'overlay.close')} 可退出`)
    }
  }, [isFallbackFullscreen])

  const selectItems = useCallback((canvasId: string, ids: string[], additive: boolean) => {
    setActiveCanvasId(canvasId)
    setSelectedIds((current) => additive ? [...new Set([...current, ...ids])] : ids)
  }, [])

  const moveItems = useCallback((updates: Map<string, Point>) => {
    const next = itemsRef.current.map((item) => {
      const point = updates.get(item.id)
      if (!point) return item
      // 裸图标（快捷方式）拖完吸附网格，像 Windows 桌面一样自动对整齐
      if (item.kind === 'icon' && iconSnapRef.current) return { ...item, ...point, x: Math.round(point.x / ICON_GRID_STEP_X) * ICON_GRID_STEP_X, y: Math.round(point.y / ICON_GRID_STEP_Y) * ICON_GRID_STEP_Y }
      return { ...item, ...point }
    })
    // Gesture finish may immediately merge/reparent in the same event. Keep the
    // imperative model ref coherent before React flushes the settled render.
    itemsRef.current = next
    setItems(next)
  }, [])

  const updateItems = useCallback((updates: Map<string, ItemPatch>) => {
    setItems((current) => current.map((item) => { const patch = updates.get(item.id); return patch ? { ...item, ...patch } : item }))
  }, [])

  // 「图标按网格排列」：像 Windows 桌面「自动排列图标」，按现有位置顺序铺成整齐网格。
  const tidyIcons = useCallback(() => {
    const icons = itemsRef.current.filter((item) => item.canvasId === activeCanvasId && item.kind === 'icon')
    if (!icons.length) { setToast('这个画布里还没有图标'); return }
    const sorted = [...icons].sort((a, b) => (Math.abs(a.y - b.y) > ICON_GRID_STEP_Y * 0.6 ? a.y - b.y : a.x - b.x))
    const left = Math.min(...icons.map((item) => item.x))
    const top = Math.min(...icons.map((item) => item.y))
    const perRow = Math.max(1, Math.ceil(Math.sqrt(sorted.length)))
    pushHistory()
    updateItems(new Map(sorted.map((item, index) => [item.id, {
      x: left + (index % perRow) * ICON_GRID_STEP_X,
      y: top + Math.floor(index / perRow) * ICON_GRID_STEP_Y,
    }])))
    setToast(`已把 ${sorted.length} 个图标签成网格`)
  }, [activeCanvasId, pushHistory, updateItems])

  // 图标网格两开关（用户 2026-09-13：「网格吸附 / 网格自动排列 是在画布中可以直接右键执行的」）
  const [iconSnap, setIconSnap] = useState(() => readIconToggle(ICON_SNAP_KEY, true))
  const [iconAutoArrange, setIconAutoArrange] = useState(() => readIconToggle(ICON_AUTO_KEY, false))
  const iconSnapRef = useRef(iconSnap)
  iconSnapRef.current = iconSnap
  const tidyIconsRef = useRef<() => void>(() => {})
  const iconAutoArrangeRef = useRef(false)
  const iconActionRef = useRef<(action: string) => void>(() => {})
  tidyIconsRef.current = tidyIcons
  iconAutoArrangeRef.current = iconAutoArrange
  const toggleIconSnap = useCallback(() => {
    setIconSnap((value) => {
      const next = !value
      try { localStorage.setItem(ICON_SNAP_KEY, next ? '1' : '0') } catch { /* 存不上也不影响用 */ }
      setToast(next ? '图标已开启「对齐到网格」' : '图标已关闭「对齐到网格」（可自由摆放）')
      return next
    })
  }, [])
  const toggleIconAutoArrange = useCallback(() => {
    setIconAutoArrange((value) => {
      const next = !value
      try { localStorage.setItem(ICON_AUTO_KEY, next ? '1' : '0') } catch { /* 同上 */ }
      if (next) { iconSnapRef.current = true; setIconSnap(true); try { localStorage.setItem(ICON_SNAP_KEY, '1') } catch { /* 同上 */ } ; tidyIconsRef.current() }
      setToast(next ? '已开启「自动排列图标」：拖完会自动排成网格' : '已关闭「自动排列图标」')
      return next
    })
  }, [])

  // 「只要是图标格式」都能拖进底部「全局常用」栏固定（快捷方式图标 / 应用卡 / 文件·文件夹·图片引用）——
  // 用户 2026-09-13 原话：「只要是图标格式的 就直接可以拖入到这个快捷键启动的栏中 并且可以做到 重命名 设置快捷键」。
  useEffect(() => {
    const barOf = () => document.querySelector('.fixed-section.current, .global-fixed-section')
    const zoneAt = (clientX: number, clientY: number): 'global' | 'current' | null => {
      const inside = (el: Element | null) => {
        const rect = el?.getBoundingClientRect()
        return !!rect && rect.width > 0 && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      }
      if (inside(document.querySelector('.fixed-section.current'))) return 'current'
      if (inside(document.querySelector('.global-fixed-section'))) return 'global'
      return null
    }
    const overBar = (clientX: number, clientY: number) => {
      const rect = barOf()?.getBoundingClientRect()
      return !!rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    }
    let pending: { id: string; startX: number; startY: number } | null = null
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const host = (event.target as HTMLElement | null)?.closest<HTMLElement>('.canvas-item[data-item-id]')
      pending = host?.dataset.itemId ? { id: host.dataset.itemId, startX: event.clientX, startY: event.clientY } : null
    }
    const onMove = (event: PointerEvent) => {
      if (!pending) return
      const over = overBar(event.clientX, event.clientY)

      const zone = over ? zoneAt(event.clientX, event.clientY) : null

      if (zone) lastFavoriteDropZoneRef.current = zone

      document.querySelector('.fixed-section.current')?.classList.toggle('drop-target', zone === 'current')

      document.querySelector('.global-fixed-section')?.classList.toggle('drop-target', zone === 'global')
      // 拖到窗口顶部附近 → 把顶栏叫出来并保持住，让用户能真的把东西放上去。
      const draggedFar = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) >= 10
      const nearTop = draggedFar && event.clientY <= 150
      setCanvasDragNearTop((current) => (current === nearTop ? current : nearTop))
      // 悬在栏上时给一个「接下来会多出这一项」的半透明预览；离开就撤掉。
      const hovered = over ? itemsRef.current.find((entry) => entry.id === pending?.id) : undefined
      const next = hovered && hovered.source ? { label: hovered.title || hovered.source, kind: hovered.kind } : null
      setFavoriteDropGhost((current) => {
        const same = (!current && !next) || (!!current && !!next && current.label === next.label && current.kind === next.kind)
        return same ? current : next
      })
    }
    const clearDropState = () => {
      pending = null
      barOf()?.classList.remove('drop-target')
      setFavoriteDropGhost(null)
      setCanvasDragNearTop(false)
    }
    const onUp = (event: PointerEvent) => {
      const current = pending
      pending = null
      barOf()?.classList.remove('drop-target')
      setFavoriteDropGhost(null)
      setCanvasDragNearTop(false)
      if (!current) return
      const item = itemsRef.current.find((entry) => entry.id === current.id)
      const dragged = Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 24
      // 延后一拍：画布自己的落位逻辑是在这个 capture 监听之后跑的，立刻 tidy 会被它覆盖。
      if (item?.kind === 'icon' && iconAutoArrangeRef.current && !overBar(event.clientX, event.clientY)) window.setTimeout(() => tidyIconsRef.current(), 40)
      if (!dragged || !overBar(event.clientX, event.clientY) || !item) return
      if (!item.source) { setToast('这一项没有可固定的路径'); return }
      const kind: 'file' | 'folder' | 'app' = item.kind === 'folder' ? 'folder' : (item.kind === 'icon' || item.kind === 'app') ? 'app' : 'file'
      window.dispatchEvent(new CustomEvent(GLOBAL_FAVORITE_EVENT, { detail: { source: item.source, sourceKind: kind, label: item.title, itemId: item.id, restore: { x: item.x, y: item.y } } }))
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', clearDropState, true)
    window.addEventListener('blur', clearDropState)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', clearDropState, true)
      window.removeEventListener('blur', clearDropState)
      barOf()?.classList.remove('drop-target')
    }
  }, [])

  const reparentItems = useCallback((sourceCanvasId: string, targetBounds: SurfaceDropTarget, primaryId: string, movingIds: string[], clientX: number, clientY: number, grabX: number, grabY: number, screenW: number) => {
    const targetCanvasId = targetBounds.canvasId
    if (sourceCanvasId === targetCanvasId) return
    const sourceCanvas = spacesRef.current.find((canvas) => canvas.id === sourceCanvasId)
    const targetCanvas = spacesRef.current.find((canvas) => canvas.id === targetCanvasId)
    const primary = itemsRef.current.find((item) => item.id === primaryId)
    if (!sourceCanvas || !targetCanvas || !primary) return
    const targetOuterScale = targetBounds.outerScale
    const targetScreenScale = targetOuterScale * targetCanvas.viewport.scale
    const sourceScreenScale = screenW / Math.max(primary.w, 1)
    const scaleRatio = sourceScreenScale / Math.max(targetScreenScale, .001)
    const localX = (clientX - targetBounds.left) / Math.max(targetOuterScale, .001)
    const localY = (clientY - targetBounds.top) / Math.max(targetOuterScale, .001)
    const pointerWorldX = (localX - targetCanvas.viewport.x) / targetCanvas.viewport.scale
    const pointerWorldY = (localY - targetCanvas.viewport.y) / targetCanvas.viewport.scale
    const newPrimaryW = primary.w * scaleRatio; const newPrimaryH = primary.h * scaleRatio
    const visibleWorldLeft = (18 - targetCanvas.viewport.x) / targetCanvas.viewport.scale
    const visibleWorldTop = ((targetCanvas.hostItemId ? 46 : 18) - targetCanvas.viewport.y) / targetCanvas.viewport.scale
    const targetLocalWidth = (targetBounds.right - targetBounds.left) / Math.max(targetOuterScale, .001)
    const targetLocalHeight = (targetBounds.bottom - targetBounds.top) / Math.max(targetOuterScale, .001)
    const visibleWorldRight = (targetLocalWidth - 18 - targetCanvas.viewport.x) / targetCanvas.viewport.scale
    const visibleWorldBottom = (targetLocalHeight - 18 - targetCanvas.viewport.y) / targetCanvas.viewport.scale
    const keepVisible = (value: number, low: number, high: number) => high >= low ? clamp(value, low, high) : (low + high) / 2
    // A cross-layer drop owns the destination canvas even if its viewport is
    // nested and scaled. Keep the primary card inside that viewport so a valid
    // reparent can never look like the item vanished beyond the inner canvas.
    const primaryX = keepVisible(pointerWorldX - newPrimaryW * grabX, visibleWorldLeft, visibleWorldRight - newPrimaryW)
    const primaryY = keepVisible(pointerWorldY - newPrimaryH * grabY, visibleWorldTop, visibleWorldBottom - newPrimaryH)
    const movingSet = new Set(movingIds)
    setItems((current) => current.map((item) => movingSet.has(item.id) ? { ...item, canvasId: targetCanvasId, x: primaryX + (item.x - primary.x) * scaleRatio, y: primaryY + (item.y - primary.y) * scaleRatio, w: item.w * scaleRatio, h: item.h * scaleRatio, pinned: false } : item))
    setSpaces((current) => current.map((canvas) => {
      if (canvas.id === sourceCanvasId) return { ...canvas, fixedEntries: canvas.fixedEntries.filter((entry) => !movingSet.has(entry.target)) }
      if (canvas.id === targetCanvasId) {
        const existing = new Set(canvas.fixedEntries.map((entry) => entry.target))
        const additions = itemsRef.current.filter((item) => movingSet.has(item.id) && !existing.has(item.id)).map((item) => ({ icon: item.kind === 'folder' ? '▰' : item.kind === 'portal' ? '◈' : item.kind === 'reference' ? '▧' : '◎', label: item.title, target: item.id, tone: item.kind === 'folder' ? 'folder' : item.kind === 'portal' ? 'cad' : 'canvas' }))
        return { ...canvas, fixedEntries: [...canvas.fixedEntries, ...additions] }
      }
      return canvas
    }))
    setSelectedIds(movingIds); setActiveCanvasId(targetCanvasId); wakeCanvas(targetCanvasId)
    setToast(`已从 ${sourceCanvas.title} 跨层移动到 ${targetCanvas.title}`)
  }, [wakeCanvas])

  const resizeItem = useCallback((id: string, w: number, h: number) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, w, h } : item))
  }, [])

  const closeItem = useCallback((item: CanvasItem) => {
    pushHistory()
    const removedCanvasIds = new Set<string>()
    if (item.childCanvasId) {
      removedCanvasIds.add(item.childCanvasId)
      let changed = true
      while (changed) {
        changed = false
        for (const canvas of spacesRef.current) if (canvas.parentCanvasId && removedCanvasIds.has(canvas.parentCanvasId) && !removedCanvasIds.has(canvas.id)) {
          removedCanvasIds.add(canvas.id)
          changed = true
        }
      }
    }
    setItems((current) => current.filter((entry) => entry.id !== item.id && !removedCanvasIds.has(entry.canvasId)))
    setSpaces((current) => current.filter((canvas) => !removedCanvasIds.has(canvas.id)).map((canvas) => ({ ...canvas, fixedEntries: canvas.fixedEntries.filter((entry) => entry.target !== item.id) })))
    setSelectedIds((current) => current.filter((id) => id !== item.id))
    if (focusedWorkspaceRef.current === item.id) setFocusedWorkspaceId(null)
    setToast(`已关闭：${item.title}`)
  }, [pushHistory])

  // 框选后按 Del 一次删掉全部选中项，只进一条撤销记录。
  const deleteSelection = useCallback(() => {
    const targets = itemsRef.current.filter((entry) => selectedIdsRef.current.includes(entry.id))
    if (!targets.length) return
    pushHistory()
    const removedCanvasIds = new Set<string>()
    for (const target of targets) if (target.childCanvasId) removedCanvasIds.add(target.childCanvasId)
    let changed = true
    while (changed) {
      changed = false
      for (const canvas of spacesRef.current) if (canvas.parentCanvasId && removedCanvasIds.has(canvas.parentCanvasId) && !removedCanvasIds.has(canvas.id)) {
        removedCanvasIds.add(canvas.id)
        changed = true
      }
    }
    const ids = new Set(targets.map((entry) => entry.id))
    setItems((current) => current.filter((entry) => !ids.has(entry.id) && !removedCanvasIds.has(entry.canvasId)))
    setSpaces((current) => current.filter((canvas) => !removedCanvasIds.has(canvas.id))
      .map((canvas) => ({ ...canvas, fixedEntries: canvas.fixedEntries.filter((entry) => !ids.has(entry.target)) })))
    setSelectedIds([])
    if (focusedWorkspaceRef.current && ids.has(focusedWorkspaceRef.current)) setFocusedWorkspaceId(null)
    setToast(targets.length > 1 ? `已删除 ${targets.length} 个元素` : `已删除：${targets[0].title}`)
  }, [pushHistory])

  useEffect(() => {
    const onCloseItem = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      const item = itemsRef.current.find((entry) => entry.id === id)
      if (item) closeItem(item)
    }
    window.addEventListener('zhangzhongjie-close-item', onCloseItem)
    return () => window.removeEventListener('zhangzhongjie-close-item', onCloseItem)
  }, [closeItem])

  useEffect(() => {
    const onItemTitle = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; title?: string }>).detail
      const title = detail?.title?.trim()
      if (!detail?.itemId || !title) return
      setItems((current) => current.map((entry) => entry.id === detail.itemId && entry.title !== title
        ? { ...entry, title }
        : entry))
    }
    window.addEventListener('zhangzhongjie-item-title', onItemTitle)
    return () => window.removeEventListener('zhangzhongjie-item-title', onItemTitle)
  }, [])

  useEffect(() => {
    const onFileWorkspaceSplit = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; orientation?: 'columns' | 'rows' }>).detail
      if (!detail?.itemId || (detail.orientation !== 'columns' && detail.orientation !== 'rows')) return
      const item = itemsRef.current.find((entry) => entry.id === detail.itemId && entry.kind === 'folder')
      if (!item) return
      pushHistory()
      if (item.workspaceSplit?.type === 'branch' && item.workspaceSplit.orientation === detail.orientation) {
        updateWorkspaceSplit(item.id, undefined)
        return
      }
      const edge: SplitEdge = detail.orientation === 'columns' ? 'right' : 'bottom'
      const layout = splitLeafByEdge(primaryLeaf(), edge, .5)
      const sibling = layout.second.type === 'leaf' ? layout.second : null
      updateWorkspaceSplit(item.id, sibling ? {
        ...layout,
        second: { ...sibling, kind: 'folder', source: item.source, treeOpen: item.fileTreeOpen },
      } : layout)
    }
    window.addEventListener(FILE_WORKSPACE_SPLIT_EVENT, onFileWorkspaceSplit)
    return () => window.removeEventListener(FILE_WORKSPACE_SPLIT_EVENT, onFileWorkspaceSplit)
  }, [pushHistory, updateWorkspaceSplit])

  useEffect(() => {
    const onFilePanelState = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; source?: string; treeOpen?: boolean }>).detail
      if (!detail?.itemId) return
      const source = typeof detail.source === 'string' && detail.source.trim() ? detail.source : undefined
      const treeOpen = typeof detail.treeOpen === 'boolean' ? detail.treeOpen : undefined
      if (source === undefined && treeOpen === undefined) return
      const paneMatch = /^pane-(.+)-folder$/.exec(detail.itemId)
      setItems((current) => current.map((entry) => {
        if (entry.id === detail.itemId && entry.kind === 'folder') {
          const sourceChanged = source !== undefined && source !== entry.source
          const treeChanged = treeOpen !== undefined && treeOpen !== entry.fileTreeOpen
          if (!sourceChanged && !treeChanged) return entry
          return {
            ...entry,
            ...(sourceChanged ? { source } : {}),
            ...(treeChanged ? { fileTreeOpen: treeOpen } : {}),
          }
        }
        if (!paneMatch || !entry.workspaceSplit) return entry
        const workspaceSplit = updateSplitFilePanelState(entry.workspaceSplit, paneMatch[1], { source, treeOpen })
        return workspaceSplit === entry.workspaceSplit ? entry : { ...entry, workspaceSplit }
      }))
    }
    window.addEventListener(FILE_PANEL_STATE_EVENT, onFilePanelState)
    return () => window.removeEventListener(FILE_PANEL_STATE_EVENT, onFilePanelState)
  }, [])

  const mergeItems = useCallback((canvasId: string, draggedId: string, targetId: string) => {
    const parent = spacesRef.current.find((canvas) => canvas.id === canvasId)
    const dragged = itemsRef.current.find((item) => item.id === draggedId)
    const target = itemsRef.current.find((item) => item.id === targetId)
    if (!parent || !dragged || !target || dragged.canvasId !== canvasId || target.canvasId !== canvasId) return
    const draggedCanvas = dragged.childCanvasId ? spacesRef.current.find((canvas) => canvas.id === dragged.childCanvasId) : undefined
    const targetCanvas = target.childCanvasId ? spacesRef.current.find((canvas) => canvas.id === target.childCanvasId) : undefined
    if (dragged.kind === 'workspace' && target.kind === 'workspace' && draggedCanvas && targetCanvas && draggedCanvas.level === targetCanvas.level) {
      const left = Math.min(dragged.x, target.x); const top = Math.min(dragged.y, target.y)
      const right = Math.max(dragged.x + dragged.w, target.x + target.w); const bottom = Math.max(dragged.y + dragged.h, target.y + target.h)
      const mergedId = `canvas-fused-${Date.now()}`; const hostId = `host-${mergedId}`
      const mergedTitle = `融合画布 · ${draggedCanvas.title.replace('画布', '')} + ${targetCanvas.title.replace('画布', '')}`
      const sourceIds = new Set([draggedCanvas.id, targetCanvas.id])
      const firstWidth = Math.max(760, ...itemsRef.current.filter((item) => item.canvasId === draggedCanvas.id).map((item) => item.x + item.w + 80))
      const mergedFixed = [...draggedCanvas.fixedEntries, ...targetCanvas.fixedEntries].filter((entry, index, all) => all.findIndex((candidate) => candidate.target === entry.target) === index)
      const mergedCanvas: SpaceCanvas = {
        id: mergedId, title: mergedTitle, level: draggedCanvas.level, parentCanvasId: canvasId, hostItemId: hostId,
        viewport: { x: 46, y: 62, scale: .55 }, fixedEntries: mergedFixed, generated: true,
      }
      const mergedHost: CanvasItem = {
        id: hostId, canvasId, childCanvasId: mergedId, kind: 'workspace', title: mergedTitle,
        x: left - 34, y: top - 46, w: clamp(right - left + 120, 900, 1500), h: clamp(bottom - top + 145, 620, 940),
      }
      setItems((current) => current
        .filter((item) => item.id !== dragged.id && item.id !== target.id)
        .map((item) => {
          if (!sourceIds.has(item.canvasId)) return item
          const fromSecond = item.canvasId === targetCanvas.id
          return { ...item, canvasId: mergedId, x: item.x + (fromSecond ? firstWidth : 0), groupId: undefined, pinned: false }
        })
        .concat(mergedHost))
      setSpaces((current) => current
        .filter((canvas) => !sourceIds.has(canvas.id))
        .map((canvas) => {
          if (canvas.id === canvasId) return { ...canvas, fixedEntries: canvas.fixedEntries.map((entry) => sourceIds.has(itemsRef.current.find((item) => item.id === entry.target)?.childCanvasId ?? '') ? { ...entry, label: mergedTitle, target: hostId } : entry) }
          if (canvas.parentCanvasId && sourceIds.has(canvas.parentCanvasId)) return { ...canvas, parentCanvasId: mergedId }
          return canvas
        })
        .concat(mergedCanvas))
      setSelectedIds([hostId]); setActiveCanvasId(mergedId)
      setToast(`两个画布已融合：内容保留在同一个第 ${mergedCanvas.level} 层大画布中`)
      return
    }
    if (parent.level >= MAX_CANVAS_LEVEL) { setToast('已是最深层子画布，不再继续嵌套'); return }
    const left = Math.min(dragged.x, target.x); const top = Math.min(dragged.y, target.y)
    const right = Math.max(dragged.x + dragged.w, target.x + target.w); const bottom = Math.max(dragged.y + dragged.h, target.y + target.h)
    const childId = `canvas-merged-${Date.now()}`; const hostId = `host-${childId}`
    const level = (parent.level + 1) as 2
    const child: SpaceCanvas = {
      id: childId, title: '组合画布 · 项目整理', level,
      parentCanvasId: canvasId, hostItemId: hostId, viewport: { x: 38, y: 58, scale: .76 }, generated: true,
      fixedEntries: [
        { icon: dragged.kind === 'folder' ? '▰' : '◎', label: dragged.title, target: dragged.id, tone: dragged.kind === 'folder' ? 'folder' : 'web' },
        { icon: target.kind === 'folder' ? '▰' : '▧', label: target.title, target: target.id, tone: target.kind === 'folder' ? 'folder' : 'canvas' },
      ],
    }
    const host: CanvasItem = { id: hostId, canvasId, childCanvasId: childId, kind: 'workspace', title: child.title, x: left - 45, y: top - 65, w: clamp(right - left + 180, 700, 1160), h: clamp(bottom - top + 220, 500, 760) }
    setItems((current) => current.map((item) => {
      if (item.id !== draggedId && item.id !== targetId) return item
      return { ...item, canvasId: childId, x: item.x - left + 80, y: item.y - top + 90, groupId: undefined, pinned: false }
    }).concat(host))
    setSpaces((current) => [...current, child]); setSelectedIds([hostId]); setActiveCanvasId(childId)
    setToast(`水滴吸附完成：已生成第 ${level} 层画布`)
  }, [])

  const dissolveCanvas = useCallback((canvasId: string) => {
    const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
    const host = canvas?.hostItemId ? itemsRef.current.find((item) => item.id === canvas.hostItemId) : undefined
    if (!canvas?.generated || !canvas.parentCanvasId || !host) return
    const hasNestedCanvas = spacesRef.current.some((entry) => entry.parentCanvasId === canvasId)
    if (hasNestedCanvas) {
      setToast('请先拆散最深层画布，再拆散当前画布')
      return
    }
    pushHistory()
    setItems((current) => current.filter((item) => item.id !== host.id).map((item) => item.canvasId === canvasId ? { ...item, canvasId: canvas.parentCanvasId!, x: host.x + 55 + item.x * .68, y: host.y + 70 + item.y * .68 } : item))
    setSpaces((current) => current.filter((entry) => entry.id !== canvasId)); setActiveCanvasId(canvas.parentCanvasId); setSelectedIds([]); setToast('已拆散画布，内容回到上一层并保持相对位置')
  }, [pushHistory])

  const toggleCardMode = useCallback((item: CanvasItem) => {
    pushHistory()
    setItems((current) => current.map((entry) => entry.id === item.id
      ? { ...entry, cardMinimized: !entry.cardMinimized }
      : entry))
    setToast(item.cardMinimized ? `已恢复：${item.title}` : `已最小卡片化：${item.title}`)
  }, [pushHistory])

  useEffect(() => {
    const onToggleCard = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      const item = itemsRef.current.find((entry) => entry.id === id)
      if (item) toggleCardMode(item)
    }
    window.addEventListener('zhangzhongjie-toggle-card', onToggleCard)
    return () => window.removeEventListener('zhangzhongjie-toggle-card', onToggleCard)
  }, [toggleCardMode])

  // 纯画面（桌布）模式：卡片只剩画面，双击卡片顶部细带 / 按 Esc 退回默认状态（用户 2026-09-13 要求）
  const toggleImmersive = useCallback((itemId: string, value?: boolean) => {
    const existing = itemsRef.current.find((entry) => entry.id === itemId)
    const next = value ?? !existing?.immersive
    // 退出纯画面时顺手把纯视频窗口也收掉（页面里注入的样式要清掉）
    if (!next && (existing?.videoOnly || existing?.pipMode)) window.chrome?.webview?.postMessage({ type: 'native-browser-video-mode', surfaceId: itemId, mode: 'off' })
    setItems((current) => current.map((entry) => entry.id === itemId ? { ...entry, immersive: next, videoOnly: next ? entry.videoOnly : false, pipMode: next ? entry.pipMode : false } : entry))
  }, [])
  // 纯视频窗口（用户 2026-09-13 要求：点视频就是纯画面小窗）：让宿主把页面里的 <video> 拉满整张卡
  const requestVideoMode = useCallback((itemId: string, mode: 'on' | 'off') => {
    window.chrome?.webview?.postMessage({ type: 'native-browser-video-mode', surfaceId: itemId, mode })
  }, [])
  const toggleVideoOnly = useCallback((item: CanvasItem) => {
    if (item.videoOnly) {
      requestVideoMode(item.id, 'off')
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, videoOnly: false } : entry))
      setToast('已退出纯视频窗口')
      return
    }
    setToast('正在把播放区抠出来…')
    requestVideoMode(item.id, 'on')
  }, [requestVideoMode])
  // 画中画模式（用户 2026-09-13 要求）：卡片变无边框，往页面里挂一个「双击视频 → 进/出画中画」的钩子
  const togglePipMode = useCallback((item: CanvasItem) => {
    if (item.pipMode) {
      window.chrome?.webview?.postMessage({ type: 'native-browser-video-mode', surfaceId: item.id, mode: 'off' })
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, pipMode: false } : entry))
      setToast('已退出画中画模式')
      return
    }
    setToast('正在准备画中画…')
    window.chrome?.webview?.postMessage({ type: 'native-browser-video-mode', surfaceId: item.id, mode: 'pip' })
  }, [])
  const togglePin = useCallback((canvasId: string, item: CanvasItem) => {
    pushHistory()
    const view = spacesRef.current.find((canvas) => canvas.id === canvasId)?.viewport ?? initialRootViewport()
    const surface = document.querySelector<HTMLElement>(`.space-surface[data-canvas-id="${CSS.escape(canvasId)}"]`)
    const surfaceWidth = surface?.offsetWidth ?? window.innerWidth
    const surfaceHeight = surface?.offsetHeight ?? window.innerHeight - 170
    setItems((current) => current.map((entry) => entry.id === item.id ? entry.pinned
      ? { ...entry, pinned: false, x: ((entry.pinX ?? 20) - view.x) / view.scale, y: ((entry.pinY ?? 20) - view.y) / view.scale }
      : { ...entry, pinned: true, pinX: clamp(view.x + entry.x * view.scale, 15, Math.max(15, surfaceWidth - entry.w * view.scale - 20)), pinY: clamp(view.y + entry.y * view.scale, 15, Math.max(15, surfaceHeight - entry.h * view.scale - 20)), pinW: entry.w * view.scale, pinH: entry.h * view.scale }
      : entry))
    setToast(item.pinned ? '已取消置顶' : '已弹出并置顶，不再随当前画布移动')
  }, [pushHistory])

  // 层序（PureRef 同款）：置于顶层 / 置于底层 / 上移一层 / 下移一层。
  // 只改 layer 字段，画布内所有元素重排一遍（0..n-1），没设过 layer 的按数组顺序。
  const moveLayer = useCallback((ids: string[], mode: 'top' | 'bottom' | 'up' | 'down') => {
    const subjects = itemsRef.current.filter((item) => ids.includes(item.id) && !item.pinned)
    if (!subjects.length) return
    const canvasId = subjects[0].canvasId
    const idSet = new Set(subjects.map((item) => item.id))
    pushHistory()
    setItems((current) => {
      const sorted = current.filter((item) => item.canvasId === canvasId && !item.pinned).sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0))
      if (!sorted.some((item) => idSet.has(item.id))) return current
      const inside = sorted.filter((item) => idSet.has(item.id))
      const outside = sorted.filter((item) => !idSet.has(item.id))
      let next = sorted
      if (mode === 'top') next = [...outside, ...inside]
      else if (mode === 'bottom') next = [...inside, ...outside]
      else if (mode === 'up') {
        next = [...sorted]
        for (let index = next.length - 2; index >= 0; index -= 1) {
          if (!idSet.has(next[index].id) && idSet.has(next[index + 1].id)) { const swap = next[index]; next[index] = next[index + 1]; next[index + 1] = swap }
        }
      } else {
        next = [...sorted]
        for (let index = next.length - 1; index >= 1; index -= 1) {
          if (idSet.has(next[index - 1].id) && !idSet.has(next[index].id)) { const swap = next[index - 1]; next[index - 1] = next[index]; next[index] = swap }
        }
      }
      const layers = new Map(next.map((item, index) => [item.id, index]))
      return current.map((item) => (layers.has(item.id) ? { ...item, layer: layers.get(item.id) } : item))
    })
    setToast(mode === 'top' ? '已置于顶层' : mode === 'bottom' ? '已置于底层' : mode === 'up' ? '上移一层' : '下移一层')
  }, [pushHistory])

  const resolveCreationTarget = useCallback((placement?: { canvasId: string; x: number; y: number }, allowPointer = true) => {
    const marked = spawnAnchorRef.current
    const pointerCandidate = allowPointer ? pointerRef.current : null
    // 只认「指针最上面那一层」落在画布上：以前用 elementsFromPoint 会把顶栏/全局常用栏下面的画布也算进来，
    // 于是从全局常用栏点「待办/网页/剪贴暂存」时，新卡正好生成在指针处 —— 也就是被顶栏盖住的那块（用户 2026-09-14 暴露）。
    // 指针不在画布上（在顶栏/工具栏/HUD 上）就退回画布中心，稳稳落在看得见的地方。
    const pointerTopmost = pointerCandidate ? document.elementFromPoint(pointerCandidate.x, pointerCandidate.y) : null
    const pointerSurface = pointerTopmost?.closest<HTMLElement>('.space-surface[data-canvas-id]') ?? undefined
    const pointerCanvas = pointerSurface ? spacesRef.current.find((entry) => entry.id === pointerSurface.dataset.canvasId) : undefined
    const canvas = (placement ? spacesRef.current.find((entry) => entry.id === placement.canvasId) : undefined)
      ?? (marked ? spacesRef.current.find((entry) => entry.id === marked.canvasId) : undefined)
      ?? pointerCanvas
      ?? spacesRef.current.find((entry) => entry.id === activeCanvasRef.current) ?? spacesRef.current[0]
    const exactPoint = placement ?? (marked && marked.canvasId === canvas.id ? marked : null)
    if (exactPoint) return { canvas, point: { x: exactPoint.x, y: exactPoint.y }, exact: true }
    const visibleSurface = pointerSurface?.dataset.canvasId === canvas.id ? pointerSurface
      : [...document.querySelectorAll<HTMLElement>(`.space-surface[data-canvas-id="${CSS.escape(canvas.id)}"]`)]
        .filter((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        .sort((first, second) => second.offsetWidth * second.offsetHeight - first.offsetWidth * first.offsetHeight)[0]
    const rect = visibleSurface?.getBoundingClientRect()
    const outsideScale = rect && visibleSurface ? rect.width / Math.max(visibleSurface.offsetWidth, 1) : 1
    const screen = pointerSurface && pointerCandidate
      ? pointerCandidate
      : rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth * .5, y: window.innerHeight * .46 }
    const localX = rect ? (screen.x - rect.left) / Math.max(outsideScale, .001) : screen.x
    const localY = rect ? (screen.y - rect.top) / Math.max(outsideScale, .001) : screen.y
    return {
      canvas,
      point: {
        x: (localX - canvas.viewport.x) / canvas.viewport.scale,
        y: (localY - canvas.viewport.y) / canvas.viewport.scale,
      },
      exact: false,
    }
  }, [])

  const duplicateItems = useCallback((sourceItems: CanvasItem[], cloneIds: string[], offset?: Point) => {
    if (!sourceItems.length || sourceItems.length !== cloneIds.length) return
    pushHistory()
    const selectedGroupCounts = new Map<string, number>()
    sourceItems.forEach((item) => { if (item.groupId) selectedGroupCounts.set(item.groupId, (selectedGroupCounts.get(item.groupId) ?? 0) + 1) })
    const clonedGroups = new Map<string, string>()
    const stamp = Date.now()
    const target = offset ? null : resolveCreationTarget(undefined, false)
    const minX = Math.min(...sourceItems.map((item) => item.x))
    const minY = Math.min(...sourceItems.map((item) => item.y))
    const maxX = Math.max(...sourceItems.map((item) => item.x + item.w))
    const maxY = Math.max(...sourceItems.map((item) => item.y + item.h))
    const delta = offset ?? {
      x: target!.point.x - (minX + maxX) / 2,
      y: target!.point.y - (minY + maxY) / 2,
    }
    const clones = sourceItems.map((item, index): CanvasItem => {
      let groupId: string | undefined
      if (item.groupId && (selectedGroupCounts.get(item.groupId) ?? 0) > 1) {
        groupId = clonedGroups.get(item.groupId)
        if (!groupId) {
          groupId = `group-copy-${stamp}-${clonedGroups.size}`
          clonedGroups.set(item.groupId, groupId)
        }
      }
      return { ...item, id: cloneIds[index], canvasId: target?.canvas.id ?? item.canvasId, x: item.x + delta.x, y: item.y + delta.y, groupId, childCanvasId: undefined, pinned: false, pinX: undefined, pinY: undefined, pinW: undefined, pinH: undefined }
    })
    setItems((current) => {
      const next = [...current, ...clones]
      itemsRef.current = next
      return next
    })
    if (target) setActiveCanvasId(target.canvas.id)
    setSelectedIds(cloneIds)
    setToast(sourceItems.length === 1 && sourceItems[0].kind === 'folder' ? '已复制出一个独立的文件管理器窗口' : `已复制 ${sourceItems.length} 个元素`)
  }, [pushHistory, resolveCreationTarget])

  useEffect(() => {
    const clearInternalCopy = () => { copiedCanvasItemsRef.current = null }
    const onCopy = (event: ClipboardEvent) => {
      const editable = Boolean(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable],.fm-file-area'))
      if (editable) clearInternalCopy()
    }
    const onKey = (event: KeyboardEvent) => {
      const editable = Boolean(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable],.fm-file-area'))
      if (editable) return
      const shortcutId = shortcutIdForEvent(event, settingsRef.current.shortcutBindings, ['canvas.copy', 'canvas.paste'])
      if (shortcutId === 'canvas.copy') {
        const selected = new Set(selectedIdsRef.current)
        const copied = itemsRef.current.filter((item) => item.canvasId === activeCanvasRef.current && selected.has(item.id))
        if (!copied.length) return
        event.preventDefault()
        copiedCanvasItemsRef.current = copied.map((item) => ({ ...item }))
        // 同时写系统剪贴板：文件/文件夹→CF_HDROP（PS/AI/资源管理器可当文件粘），
        // 单张图片→位图，便签→文本。这样「画布 Ctrl+C → 切到 PS Ctrl+V」才成立。
        const realPaths = copied
          .map((entry) => (typeof entry.source === 'string' ? entry.source : ''))
          .filter((value) => Boolean(value) && !value.startsWith('http') && !value.startsWith('shell:') && !value.startsWith('::'))
        const singleImage = copied.length === 1 && copied[0].kind === 'image' ? copied[0] : null
        const noteText = copied.filter((entry) => entry.kind === 'note' && entry.text).map((entry) => entry.text).join(String.fromCharCode(10, 10))
        const bridge = window.chrome?.webview
        if (bridge && realPaths.length) {
          bridge.postMessage({ type: 'native-clipboard-write-files', paths: realPaths })
          setToast(`已复制 ${realPaths.length} 个文件到剪贴板（可粘进 PS / AI / 资源管理器）`)
        } else if (bridge && singleImage?.dataUrl) {
          bridge.postMessage({ type: 'native-clipboard-write-image', dataUrl: singleImage.dataUrl })
          setToast('已复制图片到剪贴板（可直接粘进 PS / AI）')
        } else if (bridge && noteText) {
          bridge.postMessage({ type: 'native-clipboard-write', text: noteText })
          setToast('已复制便签文本到剪贴板')
        } else {
          setToast(`已复制 ${copied.length} 个画布元素，按 ${shortcutDisplay(settingsRef.current.shortcutBindings, 'canvas.paste')} 粘贴副本`)
        }
        return
      }
      if (shortcutId !== 'canvas.paste' || !copiedCanvasItemsRef.current?.length) return
      event.preventDefault()
      const stamp = Date.now()
      const sources = copiedCanvasItemsRef.current.map((item) => ({ ...item, canvasId: activeCanvasRef.current }))
      duplicateItems(sources, sources.map((item, index) => `${item.kind}-${stamp}-${index}`))
    }
    window.addEventListener('copy', onCopy)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', clearInternalCopy)
    return () => {
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', clearInternalCopy)
    }
  }, [duplicateItems])

  // 交接文档 §30.8：固定栏的「＋ 新建画布」。在此之前唯一能生成子画布的路径
  // 是两段式融合手势，而那个手势要求先有两个元素——空画布里根本无从下手。
  // 交接文档 §10、§22 P0-6：Ctrl+V 与「从剪贴板添加」把内容放到鼠标当前位置，
  // 鼠标不在画布上时退回活动画布的可见中心，多项自动错开。
  const dropPoint = useCallback(() => {
    const canvas = spacesRef.current.find((entry) => entry.id === activeCanvasId) ?? spacesRef.current[0]
    const screen = pointerRef.current ?? { x: window.innerWidth * .5, y: window.innerHeight * .46 }
    return {
      canvas,
      x: (screen.x - canvas.viewport.x) / canvas.viewport.scale,
      y: (screen.y - canvas.viewport.y) / canvas.viewport.scale,
    }
  }, [activeCanvasId])
  dropPointRef.current = dropPoint

  const embedClipboard = useCallback(async (data: DataTransfer | ClipboardItem[], allowNativeFallback = true) => {
    if (!Array.isArray(data) && allowNativeFallback && window.chrome?.webview &&
        Array.from(data.items).some((entry) => entry.kind === 'file' && !entry.type.startsWith('image/'))) {
      window.chrome.webview.postMessage({ type: 'native-clipboard-request' })
      return
    }
    const target = dropPoint()
    const created: CanvasItem[] = []
    const place = (index: number) => ({ x: target.x + index * 26, y: target.y + index * 26 })

    const addImage = (dataUrl: string, width: number, height: number, index: number) => {
      // 卡片外框限制在 720 宽以内，但 data URL 保留原始分辨率，不做任何压缩
      const scale = Math.min(1, 720 / Math.max(width, 1))
      const spot = place(index)
      created.push({ id: `image-${Date.now()}-${index}`, canvasId: target.canvas.id, kind: 'image',
        title: `剪贴板图片 ${width}×${height}`, dataUrl, x: spot.x, y: spot.y,
        w: Math.max(200, Math.round(width * scale)), h: Math.max(150, Math.round(height * scale)) + 37, accent: '#4f8cff' })
    }

    const readImage = (blob: Blob, index: number) => new Promise<void>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        const probe = new Image()
        probe.onload = () => {
          // 画布内统一保存为无损 PNG。这样拖到资源管理器时生成的扩展名与内容始终一致，
          // 同时仍保留剪贴板图片的原始像素尺寸。
          try {
            const canvas = document.createElement('canvas')
            canvas.width = probe.naturalWidth
            canvas.height = probe.naturalHeight
            canvas.getContext('2d')?.drawImage(probe, 0, 0)
            addImage(canvas.toDataURL('image/png'), probe.naturalWidth, probe.naturalHeight, index)
          } catch {
            addImage(dataUrl, probe.naturalWidth, probe.naturalHeight, index)
          }
          resolve()
        }
        probe.onerror = () => resolve()
        probe.src = dataUrl
      }
      reader.onerror = () => resolve()
      reader.readAsDataURL(blob)
    })

    let text = ''
    if (Array.isArray(data)) {
      let index = 0
      for (const entry of data) {
        const imageType = entry.types.find((type) => type.startsWith('image/'))
        if (imageType) { await readImage(await entry.getType(imageType), index++); continue }
        if (entry.types.includes('text/plain') && !text) text = (await (await entry.getType('text/plain')).text()).trim()
      }
    } else {
      let index = 0
      for (const entry of Array.from(data.items)) {
        if (!entry.type.startsWith('image/')) continue
        const blob = entry.getAsFile()
        if (blob) await readImage(blob, index++)
      }
      if (!created.length) text = data.getData('text/plain').trim()
    }

    if (!created.length && text) {
      const spot = place(0)
      const looksLikeUrl = /^(https?:\/\/)/i.test(text) || /^[\w-]+(?:\.[\w-]+)+(?:[/:?#].*)?$/i.test(text)
      if (looksLikeUrl) {
        const url = /^https?:\/\//i.test(text) ? text : `https://${text}`
        let label = url
        try { label = new URL(url).hostname.replace(/^www\./, '') } catch { label = url }
        created.push({ id: `web-${Date.now()}`, canvasId: target.canvas.id, kind: 'web', title: label, source: url,
          x: spot.x, y: spot.y, w: 760, h: 500, accent: '#4f8cff' })
      } else {
        created.push({ id: `note-${Date.now()}`, canvasId: target.canvas.id, kind: 'note',
          title: text.split(/\r?\n/)[0].slice(0, 24) || '剪贴板文字', text,
          x: spot.x, y: spot.y, w: 340, h: 240, accent: '#4f8cff' })
      }
    }

    if (!created.length) {
      // 图片和文字都没有，可能是从资源管理器复制的文件。Web 剪贴板拿不到磁盘
      // 路径，转交宿主读 CF_HDROP。
      const bridge = window.chrome?.webview
      if (bridge && allowNativeFallback) { bridge.postMessage({ type: 'native-clipboard-request' }); return }
      setToast('剪贴板里没有可嵌入的图片或文字')
      return
    }
    pushHistory()
    setItems((current) => [...current, ...created])
    setActiveCanvasId(target.canvas.id)
    setSelectedIds(created.map((entry) => entry.id))
    setToast(created.length > 1 ? `已嵌入 ${created.length} 项` : `已嵌入：${created[0].title}`)
  }, [dropPoint, pushHistory])

  const pasteFromClipboard = useCallback(async () => {
    const readWebClipboard = async () => {
      try {
        if (!navigator.clipboard?.read) { setToast(`当前环境不支持读取剪贴板，请用 ${shortcutDisplay(settingsRef.current.shortcutBindings, 'canvas.paste')}`); return }
        await embedClipboard(await navigator.clipboard.read(), false)
      } catch { setToast(`读取剪贴板失败，请用 ${shortcutDisplay(settingsRef.current.shortcutBindings, 'canvas.paste')} 粘贴`) }
    }
    const bridge = window.chrome?.webview
    if (bridge) {
      const requestId = `clipboard-${Date.now()}-${crypto.randomUUID()}`
      const run = () => { void readWebClipboard() }
      const timeout = window.setTimeout(() => {
        const pending = clipboardReadFallbackRef.current.get(requestId)
        if (!pending) return
        clipboardReadFallbackRef.current.delete(requestId)
        pending.run()
      }, 1500)
      clipboardReadFallbackRef.current.set(requestId, { run, timeout })
      bridge.postMessage({ type: 'native-clipboard-request', requestId })
      return
    }
    await readWebClipboard()
  }, [embedClipboard])

  // 剪贴暂存「贴到画布」：图片 / 文本 → 落为画布卡片（内容来自磁盘读取，不改工程格式）
  useEffect(() => {
    const createAtDropPoint = (build: (canvasId: string, x: number, y: number) => CanvasItem) => {
      const target = dropPointRef.current?.()
      if (!target) return
      const next = build(target.canvas.id, target.x, target.y)
      pushHistory()
      setItems((current) => [...current, next])
      setActiveCanvasId(target.canvas.id)
      setSelectedIds([next.id])
    }
    const onAddImage = (event: Event) => {
      const detail = (event as CustomEvent<{ dataUrl?: string; width?: number; height?: number; title?: string }>).detail
      if (!detail?.dataUrl) return
      const width = Math.max(1, detail.width ?? 720)
      const height = Math.max(1, detail.height ?? 540)
      const scale = Math.min(1, 720 / width)
      createAtDropPoint((canvasId, x, y) => ({
        id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        canvasId, kind: 'image', title: detail.title || `截图 ${width}×${height}`,
        dataUrl: detail.dataUrl, x, y,
        w: Math.max(200, Math.round(width * scale)), h: Math.max(150, Math.round(height * scale)) + 37, accent: '#4f8cff',
      }))
    }
    const onAddNote = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim()
      if (!text) return
      createAtDropPoint((canvasId, x, y) => ({
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        canvasId, kind: 'note', title: text.split(/[\r\n]/, 1)[0].slice(0, 24) || '剪贴文本', text,
        x, y, w: 340, h: 240, accent: '#4f8cff',
      }))
    }
    window.addEventListener('zhangzhongjie-add-image', onAddImage)
    window.addEventListener('zhangzhongjie-add-note', onAddNote)
    return () => {
      window.removeEventListener('zhangzhongjie-add-image', onAddImage)
      window.removeEventListener('zhangzhongjie-add-note', onAddNote)
    }
  }, [pushHistory])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      // 焦点在输入框或可编辑区域时不抢粘贴（§24.1）
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input,textarea,[contenteditable]')) return
      if (!event.clipboardData) return
      event.preventDefault()
      void embedClipboard(event.clipboardData)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [embedClipboard])

  const createEmptyCanvas = useCallback(() => {
    const parent = spacesRef.current.find((canvas) => canvas.id === activeCanvasId) ?? spacesRef.current[0]
    if (parent.level >= MAX_CANVAS_LEVEL) { setToast('已是最深层子画布，不再继续嵌套'); return }
    pushHistory()
    const childId = `canvas-new-${Date.now()}`
    const hostId = `host-${childId}`
    const width = 640
    const height = 420
    const point = {
      x: (window.innerWidth * .5 - parent.viewport.x) / parent.viewport.scale - width / 2,
      y: (window.innerHeight * .46 - parent.viewport.y) / parent.viewport.scale - height / 2,
    }
    const child: SpaceCanvas = {
      id: childId, title: '新画布', level: (parent.level + 1) as 2,
      parentCanvasId: parent.id, hostItemId: hostId,
      viewport: { x: 38, y: 58, scale: .76 }, generated: true, fixedEntries: [],
    }
    const host: CanvasItem = { id: hostId, canvasId: parent.id, childCanvasId: childId, kind: 'workspace', title: '新画布', x: point.x, y: point.y, w: width, h: height, accent: '#4f8cff' }
    setSpaces((current) => [...current.map((canvas) => canvas.id === parent.id ? {
      ...canvas,
      fixedEntries: [...canvas.fixedEntries, { icon: '▣', label: child.title, target: hostId, tone: 'canvas' }],
    } : canvas), child])
    setItems((current) => [...current, host])
    setActiveCanvasId(child.id)
    setSelectedIds([])
    wakeCanvas(child.id)
    setToast('已新建并切换到「新画布」；入口已加入上一层的当前画布栏')
  }, [activeCanvasId, pushHistory, wakeCanvas])

  const activateItem = useCallback((item: CanvasItem) => {
    if (item.kind === 'video' || item.kind === 'web') setActiveSound(item.id)
  }, [])

  const doubleClickItem = useCallback((item: CanvasItem) => {
    if (item.kind === 'reference' && item.source) {
      notifyUnsupportedArchive(item.source)
      window.chrome?.webview?.postMessage({ type: 'native-open-path', path: item.source })
      setToast(`已用默认程序打开：${item.title}`)
      return
    }
    if (item.kind === 'folder') setToast('Windows 文件管理器已在当前画布窗口中运行')
    if (item.kind === 'portal') setToast(`正在切换到 ${item.title.split(' · ')[0]}（原型演示）`)
  }, [])

  const focusEntry = useCallback((canvasId: string, entry: FixedEntry) => {
    if (entry.target === 'quick-navigator') {
      setSpaceNavigatorOpen((current) => !current)
      return
    }
    const item = itemsRef.current.find((candidate) => candidate.id === entry.target)
    if (!item && entry.source) {
      const selectedFile = entry.sourceKind === 'file' ? entry.source : undefined
      const folderPath = selectedFile ? selectedFile.replace(/[\\/][^\\/]+$/, '') : entry.source
      if (!folderPath) { setToast('收藏文件的所在目录已不可用'); return }
      const normalizePath = (value: string) => value.replace(/[\\/]+$/, '').toLocaleLowerCase()
      const existing = itemsRef.current.find((candidate) => candidate.kind === 'folder' && candidate.source && normalizePath(candidate.source) === normalizePath(folderPath))
      if (existing) {
        wakeCanvas(existing.canvasId)
        setActiveCanvasId(existing.canvasId)
        setSelectedIds([existing.id])
        setHighlightedCanvasId(existing.canvasId)
        window.setTimeout(() => setHighlightedCanvasId(null), 1200)
        if (selectedFile) window.requestAnimationFrame(() => postNativeExplorerSelection(existing.id, [selectedFile]))
        setToast(`已聚焦掌中界文件卡：${entry.label}`)
        return
      }
      const folderName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '此电脑'
      addCanvasItemRef.current('folder', folderName, folderPath, selectedFile ? { initialSelectionPath: selectedFile } : undefined)
      setToast(selectedFile ? `已在掌中界中打开所在目录并选中：${entry.label}` : `已在掌中界中打开收藏位置：${entry.label}`)
      return
    }
    if (!item) { setToast('该固定入口尚未连接内容'); return }
    wakeCanvas(canvasId); setActiveCanvasId(canvasId); setSelectedIds([entry.target]); setHighlightedCanvasId(canvasId)
    window.setTimeout(() => setHighlightedCanvasId(null), 1200)
  }, [wakeCanvas])

  const addGlobalFavorite = useCallback((source: string, sourceKind: 'file' | 'folder' | 'app', label: string, image?: string) => {
    const normalizedSource = source.trim()
    if (!normalizedSource) { setToast('当前内容没有可收藏的真实路径'); return }
    // 落点决定去哪：左边那块＝全局常用（到哪都在）；右边「当前画布」＝只属于这张画布
    if (true) { // 一律进当前画布那一栏（用户 2026-09-15：就一条栏、放左边，不分区）
      window.dispatchEvent(new CustomEvent(CURRENT_CANVAS_PIN_EVENT, { detail: {
        target: `pin:${normalizedSource}`, label, source: normalizedSource, sourceKind, image,
      } }))
      return
    }
  }, [updateGlobalSettings])

  useEffect(() => {
    const add = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; sourceKind?: 'file' | 'folder' | 'app'; label?: string; image?: string }>).detail
      if (!detail?.source || !detail.sourceKind) return
      // 2026-09-15：一律固定到当前画布（每个画布/模板一套），不再写全局收藏
      window.dispatchEvent(new CustomEvent(CURRENT_CANVAS_PIN_EVENT, { detail: {
        target: `pin:${detail.source}`, label: detail.label || detail.source,
        source: detail.source, sourceKind: detail.sourceKind, image: detail.image,
      } }))
    }
    window.addEventListener(GLOBAL_FAVORITE_REQUEST_EVENT, add)
    return () => window.removeEventListener(GLOBAL_FAVORITE_REQUEST_EVENT, add)
  }, [addGlobalFavorite])

  // 「添加应用」：列出桌面（含公共桌面）的快捷方式，点选即固定到全局常用栏。
  const openDesktopAppPicker = useCallback((anchor: { x: number; y: number }) => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const requestId = `desktop-apps:${Date.now()}`
    desktopPickerRequestRef.current = requestId
    setDesktopShortcutPicker({ items: [], loading: true, x: anchor.x, y: anchor.y })
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; items?: { name?: string; path?: string; image?: string }[] } | undefined
      if (data?.type !== 'native-desktop-shortcuts' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      const items = Array.isArray(data.items)
        ? data.items.flatMap((item) => item?.path ? [{ name: item.name || item.path, path: item.path, image: typeof item.image === 'string' ? item.image : undefined }] : [])
        : []
      setDesktopShortcutPicker({ items, loading: false, x: anchor.x, y: anchor.y })
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-list-desktop-shortcuts', requestId })
  }, [])

  const pickAppFromDiskToFavorites = useCallback(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const requestId = `pick-fav:${Date.now()}`
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; path?: string } | undefined
      if (data?.type !== 'native-pick-executable-result' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      if (!data.path) return
      const base = data.path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '新应用'
      addGlobalFavorite(data.path, 'app', base.replace(/\.(exe|lnk|bat|cmd)$/i, ''))
      setDesktopShortcutPicker(null)
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-pick-executable-request', requestId })
  }, [addGlobalFavorite])

  const favoriteShellItem = useCallback((target: 'file' | 'folder') => {
    if (!shellPreviewTarget) return
    const entryPath = shellPreviewTarget.entry.path
    const separator = Math.max(entryPath.lastIndexOf('\\'), entryPath.lastIndexOf('/'))
    const fallbackParent = separator > 2 ? entryPath.slice(0, separator) : entryPath
    const source = target === 'file'
      ? entryPath
      : (shellPreviewData?.parentPath || shellPreviewTarget.entry.parentPath || fallbackParent)
    const trimmed = source.replace(/[\\/]+$/, '')
    const label = target === 'file' ? shellPreviewTarget.entry.name : (trimmed.split(/[\\/]/).at(-1) || trimmed)
    addGlobalFavorite(source, target, label, target === 'file' ? shellPreviewTarget.entry.image : undefined)
  }, [addGlobalFavorite, shellPreviewData?.parentPath, shellPreviewTarget])

  const pulseCanvas = useCallback((canvasId: string) => {
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
    flushSync(() => setHighlightedCanvasId(null))
    window.requestAnimationFrame(() => {
      setHighlightedCanvasId(canvasId)
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedCanvasId((current) => current === canvasId ? null : current)
        highlightTimerRef.current = null
      }, 1250)
    })
  }, [])

  const visibleSurfaceForCanvas = useCallback((canvasId: string) => [...document.querySelectorAll<HTMLElement>(`.space-surface[data-canvas-id="${CSS.escape(canvasId)}"]`)]
    .filter((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
    .sort((first, second) => second.offsetWidth * second.offsetHeight - first.offsetWidth * first.offsetHeight)[0], [])

  const centerItemInCanvas = useCallback((item: CanvasItem, enlarge: boolean) => {
    const canvas = spacesRef.current.find((entry) => entry.id === item.canvasId)
    const surface = visibleSurfaceForCanvas(item.canvasId)
    if (!canvas || !surface || item.pinned) return
    const fitScale = Math.min((surface.offsetWidth - 100) / Math.max(item.w, 1), (surface.offsetHeight - 100) / Math.max(item.h, 1))
    const scale = enlarge ? clamp(Math.max(canvas.viewport.scale, Math.min(1.05, fitScale)), .68, 2.4) : canvas.viewport.scale
    setCanvasViewport(canvas.id, {
      x: surface.offsetWidth / 2 - (item.x + item.w / 2) * scale,
      y: surface.offsetHeight / 2 - (item.y + item.h / 2) * scale,
      scale,
    })
  }, [setCanvasViewport, visibleSurfaceForCanvas])

  const focusCanvas = useCallback((canvasId: string) => {
    wakeCanvas(canvasId); setActiveCanvasId(canvasId)
    const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
    if (canvas?.hostItemId) setSelectedIds([canvas.hostItemId]); else setSelectedIds([])
    setToast(`已定位：${canvas?.title ?? '画布'}`)
  }, [wakeCanvas])

  const emphasizeCanvas = useCallback((canvasId: string) => {
    const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
    if (!canvas) return
    wakeCanvas(canvasId)
    setActiveCanvasId(canvasId)
    if (canvas.hostItemId) {
      const host = itemsRef.current.find((item) => item.id === canvas.hostItemId)
      if (host) { setSelectedIds([host.id]); centerItemInCanvas(host, true) }
    } else {
      setSelectedIds([])
      const surface = visibleSurfaceForCanvas(canvas.id)
      if (surface && canvas.viewport.scale < .85) {
        const oldScale = canvas.viewport.scale
        const scale = .85
        setCanvasViewport(canvas.id, {
          x: surface.offsetWidth / 2 - (surface.offsetWidth / 2 - canvas.viewport.x) / oldScale * scale,
          y: surface.offsetHeight / 2 - (surface.offsetHeight / 2 - canvas.viewport.y) / oldScale * scale,
          scale,
        })
      }
    }
    pulseCanvas(canvasId)
    setToast(`已聚焦：${canvas.title}`)
  }, [centerItemInCanvas, pulseCanvas, setCanvasViewport, visibleSurfaceForCanvas, wakeCanvas])

  const focusNavigatorItem = useCallback((item: CanvasItem) => {
    const canvas = spacesRef.current.find((entry) => entry.id === item.canvasId)
    if (!canvas) return
    wakeCanvas(canvas.id)
    setActiveCanvasId(canvas.id)
    setSelectedIds([item.id])
    centerItemInCanvas(item, false)
    setToast(`已定位：${item.title}`)
  }, [centerItemInCanvas, wakeCanvas])

  const emphasizeNavigatorItem = useCallback((item: CanvasItem) => {
    const canvas = spacesRef.current.find((entry) => entry.id === item.canvasId)
    if (!canvas) return
    wakeCanvas(canvas.id)
    setActiveCanvasId(canvas.id)
    setSelectedIds([item.id])
    centerItemInCanvas(item, true)
    pulseCanvas(canvas.id)
    setToast(`已聚焦：${item.title}`)
  }, [centerItemInCanvas, pulseCanvas, wakeCanvas])

  // 交接文档 23.3：比例预设与显示顺序固定为下表，外加「自由比例」。
  const applyRatio = useCallback((ratio: number | null) => {
    const targets = itemsRef.current.filter((item) => selectedIds.includes(item.id) && item.canvasId === activeCanvasId)
    const list = targets.length ? targets : itemsRef.current.filter((item) => item.id === selectedIds[0])
    if (!list.length) { setRatioAnchor(null); setToast('请先选中一个或多个窗口'); return }
    pushHistory()
    if (ratio === null) { setRatioAnchor(null); setToast('已恢复自由比例'); return }

    // 先把所有对象统一到目标比例，面积尽量保持不变；
    // 文件/快捷方式图标是固定尺寸的（没有放大缩小这回事），跳过它们。
    const resizable = list.filter((item) => !FIXED_SIZE_KINDS.has(item.kind))
    if (!resizable.length) { setRatioAnchor(null); setToast('文件 / 快捷方式图标不支持改比例（它们没有大小这一说）'); return }
    const sized = resizable.map((item) => {
      const area = Math.max(item.w * item.h, 1)
      const h = Math.sqrt(area / ratio)
      return { id: item.id, w: Math.max(240, Math.round(h * ratio)), h: Math.max(170, Math.round(h)) }
    })
    const cell = { w: Math.max(...sized.map((entry) => entry.w)), h: Math.max(...sized.map((entry) => entry.h)) }
    const gap = 26

    // 列数：2-3 个按方向规则（横向比例上下排、竖向比例左右排），
    // 4 个 2x2，5-6 个 3x2，7-9 个 3x3，超过 9 个按 3x3 批次继续。
    const count = list.length
    const columns = count <= 1 ? 1
      : count <= 3 ? (ratio >= 1 ? 1 : count)
      : count === 4 ? 2
      : 3

    // 保持原包围盒中心
    const minX = Math.min(...list.map((item) => item.x))
    const minY = Math.min(...list.map((item) => item.y))
    const maxX = Math.max(...list.map((item) => item.x + item.w))
    const maxY = Math.max(...list.map((item) => item.y + item.h))
    const rows = Math.ceil(count / columns)
    const totalW = columns * cell.w + (columns - 1) * gap
    const totalH = rows * cell.h + (rows - 1) * gap
    const originX = (minX + maxX) / 2 - totalW / 2
    const originY = (minY + maxY) / 2 - totalH / 2

    const patches = new Map<string, ItemPatch>()
    sized.forEach((entry, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      patches.set(entry.id, {
        x: originX + column * (cell.w + gap) + (cell.w - entry.w) / 2,
        y: originY + row * (cell.h + gap) + (cell.h - entry.h) / 2,
        w: entry.w, h: entry.h,
      })
    })
    updateItems(patches)
    setRatioAnchor(null)
    setToast(count > 1 ? `${count} 个窗口已统一比例并整理为 ${columns} 列` : '已应用比例')
  }, [activeCanvasId, pushHistory, selectedIds, updateItems])

  // 「整理」不满意就再按一次：同一批选择连续按键 → 自动 / 2 列 / 3 列 / 4 列 循环。
  // —— 导出：写盘走原生 native-write-file，默认输出到「图片\掌中界导出」——
  // 只认“被选中的元素”：不按 canvasId 过滤（刚启动、活动画布还没就绪时会误判为空），也不排除钉住的。
  const exportTargets = () => itemsRef.current.filter((item) => selectedRef.current.includes(item.id))

  const nativeExportFolder = () => new Promise<string>((resolve) => {
    const bridge = window.chrome?.webview
    if (!bridge) { resolve(''); return }
    const requestId = `export-folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const timer = window.setTimeout(() => { if (nativeFileRequestsRef.current.delete(requestId)) resolve('') }, 8000)
    nativeFileRequestsRef.current.set(requestId, (value) => { window.clearTimeout(timer); resolve(String(value ?? '')) })
    bridge.postMessage({ type: 'native-export-folder-query', requestId })
  })

  const nativePickFolder = (title: string, start: string) => new Promise<string>((resolve) => {
    const bridge = window.chrome?.webview
    if (!bridge) { resolve(''); return }
    const requestId = `pick-folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const timer = window.setTimeout(() => { if (nativeFileRequestsRef.current.delete(requestId)) resolve('') }, 120000)
    nativeFileRequestsRef.current.set(requestId, (value) => { window.clearTimeout(timer); resolve(String(value ?? '')) })
    bridge.postMessage({ type: 'native-pick-folder-request', requestId, title, start })
  })

  const nativeWriteFile = (path: string, dataUrl: string) => new Promise<boolean>((resolve) => {
    const bridge = window.chrome?.webview
    if (!bridge) { resolve(false); return }
    const requestId = `write-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const timer = window.setTimeout(() => { if (nativeFileRequestsRef.current.delete(requestId)) resolve(false) }, 30000)
    nativeFileRequestsRef.current.set(requestId, (value) => { window.clearTimeout(timer); resolve(value === true) })
    bridge.postMessage({ type: 'native-write-file', requestId, path, dataUrl })
  })

  const nativeReadImage = (path: string) => new Promise<string>((resolve) => {
    const bridge = window.chrome?.webview
    if (!bridge || !path) { resolve(''); return }
    const requestId = `export-src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const timer = window.setTimeout(() => { if (exportDataUrlRef.current.delete(requestId)) resolve('') }, 15000)
    exportDataUrlRef.current.set(requestId, (value) => { window.clearTimeout(timer); resolve(value) })
    bridge.postMessage({ type: 'native-read-image-dataurl', requestId, path })
  })

  const loadImageElement = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
    if (!src) { resolve(null); return }
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })

  // 元素的位图来源：嵌入图片直接有 dataUrl；图片文件卡去磁盘取。
  const itemBitmap = async (item: CanvasItem) => {
    if (item.dataUrl) return loadImageElement(item.dataUrl)
    const path = item.source && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(item.source) ? item.source : ''
    if (!path) return null
    return loadImageElement(await nativeReadImage(path))
  }

  // 注意：TS 字符串里的 '\\' 才是一个反斜杠；写成 '\参' 会被当转义吃掉。
  const joinExportPath = (folder: string, name: string) => folder.endsWith('\\') ? folder + name : folder + '\\' + name

  const exportStamp = () => {
    const now = new Date()
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  }

  // ③ 参考板：按画布上的相对位置拼成一张白底 PNG（含文件名），并顺手放进剪贴板。
  const runExportBoard = async (targets: CanvasItem[], folder: string) => {
    const pad = 28, labelGap = 26
    const minX = Math.min(...targets.map((item) => item.x))
    const minY = Math.min(...targets.map((item) => item.y))
    const maxX = Math.max(...targets.map((item) => item.x + item.w))
    const maxY = Math.max(...targets.map((item) => item.y + item.h))
    const spanX = maxX - minX + pad * 2
    const spanY = maxY - minY + pad * 2 + labelGap
    // 2 倍输出更清晰；选区特别大时自动降到长边 4000px 以内，免得 PNG 巨大。
    const scale = Math.max(0.4, Math.min(2, 4000 / Math.max(spanX, spanY, 1)))
    const width = Math.max(200, Math.round(spanX * scale))
    const height = Math.max(200, Math.round(spanY * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) { setToast('导出失败：画布不可用'); return }
    ctx.scale(scale, scale)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width / scale, height / scale)
    for (const item of targets) {
      const left = item.x - minX + pad
      const top = item.y - minY + pad
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') ctx.roundRect(left, top, item.w, item.h, 10)
      else ctx.rect(left, top, item.w, item.h)
      ctx.fillStyle = '#f3f5f8'
      ctx.fill()
      ctx.strokeStyle = '#d9dee6'
      ctx.stroke()
      const image = await itemBitmap(item)
      if (image) {
        const ratio = Math.min((item.w - 12) / image.width, (item.h - 12) / image.height)
        const drawW = image.width * ratio
        const drawH = image.height * ratio
        ctx.drawImage(image, left + (item.w - drawW) / 2, top + (item.h - drawH) / 2, drawW, drawH)
      } else {
        ctx.fillStyle = '#8b93a1'
        ctx.font = '13px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText((item.title || '').slice(0, 20), left + item.w / 2, top + item.h / 2)
      }
      ctx.fillStyle = '#414a58'
      ctx.font = '12px system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText((item.title || '').slice(0, 48), left, top + item.h + 7)
    }
    const dataUrl = canvas.toDataURL('image/png')
    const target = joinExportPath(folder, `参考板-${exportStamp()}.png`)
    const ok = await nativeWriteFile(target, dataUrl)
    if (!ok) { setToast('导出失败：写文件失败，请检查磁盘权限'); return }
    window.chrome?.webview?.postMessage({ type: 'native-clipboard-write-image', dataUrl })
    setToast(`${targets.length} 项已导出参考板（也放进剪贴板了）：${target}`)
  }

  // ④ 批量图片：统一长边 / 转格式 / 压质量 / 重命名，逐张写到导出目录。
  const runBatchExport = async (targets: CanvasItem[], folder: string) => {
    let done = 0, failed = 0
    for (let index = 0; index < targets.length; index += 1) {
      const item = targets[index]
      setToast(`导出图片 ${index + 1}/${targets.length}…`)
      const image = await itemBitmap(item)
      if (!image) { failed += 1; continue }
      const longEdge = batchLongEdge > 0 ? batchLongEdge : Math.max(image.width, image.height)
      const ratio = Math.min(1, longEdge / Math.max(image.width, image.height))
      const drawW = Math.max(1, Math.round(image.width * ratio))
      const drawH = Math.max(1, Math.round(image.height * ratio))
      const canvas = document.createElement('canvas')
      canvas.width = drawW
      canvas.height = drawH
      const ctx = canvas.getContext('2d')
      if (!ctx) { failed += 1; continue }
      if (batchFormat === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, drawW, drawH) }
      ctx.drawImage(image, 0, 0, drawW, drawH)
      const dataUrl = canvas.toDataURL(batchFormat, batchQuality / 100)
      const extension = batchFormat === 'image/png' ? 'png' : 'jpg'
      const name = `${batchPrefix || '导出'}-${String(index + 1).padStart(2, '0')}.${extension}`
      if (await nativeWriteFile(joinExportPath(folder, name), dataUrl)) done += 1
      else failed += 1
    }
    setToast(failed ? `已导出 ${done} 张，${failed} 张跳过（没有位图可用或写盘失败）：${folder}` : `已导出 ${done} 张图片：${folder}`)
  }

  // ② 把「我的收藏」导出成 HTML 书签文件（可再导入系统浏览器，也能当备份带走）。
  const exportBookmarks = useCallback(async () => {
    const list = readBrowserSettings().webBookmarks
    if (!list.length) { setToast('还没有收藏：点网页卡地址栏右侧的星标就能收藏'); return }
    const folder = await nativeExportFolder()
    if (!folder) { setToast('导出失败：拿不到导出目录'); return }
    const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] ?? character))
    const body = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- 由掌中界「我的收藏」导出 -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>掌中界我的收藏</TITLE>',
      '<H1>掌中界我的收藏</H1>',
      '<DL><p>',
      ...list.map((entry) => `    <DT><A HREF="${escapeHtml(entry.url)}">${escapeHtml(entry.name)}</A>${entry.group ? ` <!-- 分组：${escapeHtml(entry.group)} -->` : ''}`),
      '</DL><p>',
      '',
    ].join('\n')
    const dataUrl = `data:text/html;base64,${btoa(unescape(encodeURIComponent(body)))}`
    const target = joinExportPath(folder, `掌中界书签-${exportStamp()}.html`)
    if (!(await nativeWriteFile(target, dataUrl))) { setToast('导出失败：写文件失败'); return }
    setToast(`已导出 ${list.length} 条收藏：${target}`)
  }, [])

  useEffect(() => {
    const run = () => { void exportBookmarks() }
    window.addEventListener('zhangzhongjie-export-bookmarks', run)
    return () => window.removeEventListener('zhangzhongjie-export-bookmarks', run)
  }, [exportBookmarks])

  const runExport = useCallback(async (mode: 'board' | 'batch') => {
    if (exportBusy) return
    const targets = exportTargets()
    if (!targets.length) { setToast('请先框选要导出的元素'); return }
    setExportBusy(true)
    try {
      const folder = settingsRef.current.exportFolder?.trim() || await nativeExportFolder()
      if (!folder) { setToast('导出失败：拿不到导出目录'); return }
      if (mode === 'board') await runExportBoard(targets, folder)
      else await runBatchExport(targets, folder)
    } finally { setExportBusy(false) }
  }, [exportBusy, batchFormat, batchLongEdge, batchPrefix, batchQuality])

  const arrangeCycleRef = useRef<{ key: string; index: number; at: number }>({ key: '', index: 0, at: 0 })

  const arrangeSelection = useCallback((kind: LayoutKind, options?: { cols?: number }) => {
    const selected = itemsRef.current.filter((item) => selectedRef.current.includes(item.id) && item.canvasId === activeCanvasId && !item.pinned)
    if (selected.length < 2) return

    pushHistory()

    const cycleKey = selected.map((item) => item.id).sort().join('|')
    const cycle = arrangeCycleRef.current
    cycle.index = cycle.key === cycleKey && Date.now() - cycle.at < 5000 ? cycle.index + 1 : 0
    cycle.key = cycleKey
    cycle.at = Date.now()

    const minX = Math.min(...selected.map((item) => item.x)); const minY = Math.min(...selected.map((item) => item.y))
    const maxX = Math.max(...selected.map((item) => item.x + item.w)); const maxY = Math.max(...selected.map((item) => item.y + item.h))
    const width = Math.max(maxX - minX, 760); const height = Math.max(maxY - minY, 440); const gap = 18

    // 「整理」自动挑布局：尺寸差得明显就按主次排——最大的当主占左侧，其余竖着
    // 排在右边；尺寸都差不多就并列。判据取最大与次大的面积差。
    const byArea = [...selected].sort((a, b) => b.w * b.h - a.w * a.h)
    const largest = byArea[0].w * byArea[0].h
    const runnerUp = byArea[1].w * byArea[1].h
    const similar = largest <= 0 || (largest - runnerUp) / largest < .25
    const mode = kind === 'custom' ? 'primary' : kind === 'grid' ? (similar ? 'row' : 'primary') : 'row'
    let arrangedColumns = 0

    // 先算槽位，再按元素自己的比例等比放进去（用户要求：不能把图片的比例拉乱）
    const slots = new Map<string, { x: number; y: number; w: number; h: number }>()
    if (mode === 'primary') {
      // 主 62%，次的竖排占 38%
      const primaryW = (width - gap) * .62
      const secondaryW = width - gap - primaryW
      const rest = byArea.slice(1)
      const cellH = (height - gap * (rest.length - 1)) / rest.length
      slots.set(byArea[0].id, { x: minX, y: minY, w: primaryW, h: height })
      rest.forEach((item, index) => slots.set(item.id, {
        x: minX + primaryW + gap, y: minY + index * (cellH + gap), w: secondaryW, h: cellH,
      }))
    } else {
      // 方向可以由用户显式指定（三列/三行、2×2/四列/四行）；不指定就沿用「按一次换一种」的循环
      const autoCols = selected.length <= 4 ? selected.length : Math.ceil(Math.sqrt(selected.length))
      const cycleOptions = [autoCols, 2, 3, 4].filter((value, index, all) => value >= 2 && all.indexOf(value) === index)
      const cols = Math.max(1, options?.cols ?? cycleOptions[cycle.index % cycleOptions.length])
      arrangedColumns = cols
      const rows = Math.ceil(selected.length / cols)
      const cellW = (width - gap * (cols - 1)) / cols
      const cellH = (height - gap * (rows - 1)) / rows
      selected.forEach((item, index) => slots.set(item.id, {
        x: minX + (index % cols) * (cellW + gap),
        y: minY + Math.floor(index / cols) * (cellH + gap),
        w: cellW, h: cellH,
      }))
    }
    const changes = new Map<string, ItemPatch>()
    slots.forEach((slot, id) => {
      const item = selected.find((entry) => entry.id === id)
      if (item) changes.set(id, fitInSlot(item, slot))
    })
    // 整理只摆位置，不顺手成组——成组是独立意图，用 Ctrl+G。
    setItems((current) => current.map((item) => { const change = changes.get(item.id); return change ? { ...item, ...change } : item }))
    setToast(mode === 'primary'
      ? '已按主次布局整理：最大的作主视图'
      : cycle.index ? `已排成 ${arrangedColumns} 列 · 再按一次继续换` : '已并列整理 · 再按一次可改列数')
  }, [activeCanvasId, pushHistory])

  const completeTypeOrganization = useCallback((request: CanvasOrganizeRequest, positions: Map<string, Point>, interrupted: boolean) => {
    const participants = itemsRef.current.filter((item) => positions.has(item.id))
    let nextViewport: Viewport | null = null
    if (request.fullCanvas && !interrupted && participants.length) {
      const placed = participants.map((item) => ({ ...item, ...(positions.get(item.id) ?? {}) }))
      const minX = Math.min(...placed.map((item) => item.x))
      const minY = Math.min(...placed.map((item) => item.y))
      const maxX = Math.max(...placed.map((item) => item.x + item.w))
      const maxY = Math.max(...placed.map((item) => item.y + item.h))
      const surfaces = [...document.querySelectorAll<HTMLElement>(`.space-surface[data-canvas-id="${CSS.escape(request.canvasId)}"]`)]
        .filter((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        .sort((first, second) => second.offsetWidth * second.offsetHeight - first.offsetWidth * first.offsetHeight)
      const surface = surfaces[0]
      if (surface) {
        const contentWidth = Math.max(1, maxX - minX)
        const contentHeight = Math.max(1, maxY - minY)
        const scale = clamp(Math.min(surface.offsetWidth * .9 / contentWidth, surface.offsetHeight * .9 / contentHeight), .25, 1.8)
        nextViewport = {
          x: (surface.offsetWidth - contentWidth * scale) / 2 - minX * scale,
          y: (surface.offsetHeight - contentHeight * scale) / 2 - minY * scale,
          scale,
        }
      }
    }
    flushSync(() => {
      setItems((current) => current.map((item) => {
        const point = positions.get(item.id)
        return point ? { ...item, ...point } : item
      }))
      if (nextViewport) setSpaces((current) => current.map((canvas) => canvas.id === request.canvasId ? { ...canvas, viewport: nextViewport! } : canvas))
      setOrganizeRequest(null)
    })
    const summary = request.counts.map(({ label, count }) => `${count} 个${label}`).join(' · ')
    setToast(interrupted ? `已停止整理并保留当前位置：${summary}` : `已按类型整理：${summary}`)
  }, [])

  const organizeByType = useCallback(() => {
    if (organizeRequest) return
    const selected = new Set(selectedRef.current)
    const selectionOnly = selected.size > 0
    const participants = itemsRef.current.filter((item) => item.canvasId === activeCanvasId && !item.pinned && (!selectionOnly || selected.has(item.id)))
    const layout = buildOrganizedCanvasLayout(participants)
    if (!layout) return
    const moved = participants.some((item) => {
      const point = layout.positions.get(item.id)
      return point && (Math.abs(point.x - item.x) > .01 || Math.abs(point.y - item.y) > .01)
    })
    if (!moved) { setToast('当前范围已经按类型整理整齐'); return }
    pushHistory()
    setOrganizeRequest({
      id: ++organizeRequestIdRef.current,
      canvasId: activeCanvasId,
      positions: layout.positions,
      counts: layout.counts,
      fullCanvas: !selectionOnly,
    })
  }, [activeCanvasId, organizeRequest, pushHistory])
  organizeByTypeRef.current = organizeByType

  const arrangeSplit = useCallback((mode: SplitMode) => {
    const selected = itemsRef.current.filter((item) => selectedRef.current.includes(item.id) && item.canvasId === activeCanvasId && !item.pinned)
    if (selected.length !== 2) return
    pushHistory()
    const minX = Math.min(...selected.map((item) => item.x)); const minY = Math.min(...selected.map((item) => item.y))
    const maxX = Math.max(...selected.map((item) => item.x + item.w)); const maxY = Math.max(...selected.map((item) => item.y + item.h))
    const width = Math.max(maxX - minX, 760); const height = Math.max(maxY - minY, 460); const gap = 18
    const columns = mode.startsWith('columns'); const firstRatio = mode.endsWith('wide') ? 2 / 3 : 1 / 2
    const changes = new Map<string, ItemPatch>()
    if (columns) {
      const firstW = (width - gap) * firstRatio
      changes.set(selected[0].id, fitInSlot(selected[0], { x: minX, y: minY, w: firstW, h: height }))
      changes.set(selected[1].id, fitInSlot(selected[1], { x: minX + firstW + gap, y: minY, w: width - gap - firstW, h: height }))
    } else {
      const firstH = (height - gap) * firstRatio
      changes.set(selected[0].id, fitInSlot(selected[0], { x: minX, y: minY, w: width, h: firstH }))
      changes.set(selected[1].id, fitInSlot(selected[1], { x: minX, y: minY + firstH + gap, w: width, h: height - gap - firstH }))
    }
    // 只把两个窗口并排摆好，不再顺手成组。成组是独立意图，要用 Ctrl+G 显式做。
    setItems((current) => current.map((item) => { const change = changes.get(item.id); return change ? { ...item, ...change } : item }))
    setShowSplitPicker(false)
    setToast(`已并排为${columns ? '左右' : '上下'}布局；需要成组请按 ${shortcutDisplay(settingsRef.current.shortcutBindings, 'selection.group')}`)
  }, [activeCanvasId, pushHistory])

  const groupSelection = useCallback(() => {
    const selected = itemsRef.current.filter((item) => selectedRef.current.includes(item.id) && item.canvasId === activeCanvasId)
    if (selected.length < 2) return
    pushHistory(); const groupId = `group-${Date.now()}`; const ids = new Set(selected.map((item) => item.id))
    setItems((current) => current.map((item) => ids.has(item.id) ? { ...item, groupId } : item)); setToast('已成组，拖动任意成员即可整体移动')
  }, [activeCanvasId, pushHistory])

  const ungroupSelection = useCallback(() => {
    pushHistory(); const ids = new Set(selectedRef.current)
    setItems((current) => current.map((item) => ids.has(item.id) ? { ...item, groupId: undefined } : item)); setToast('已解组')
  }, [pushHistory])
  // 裸图标右键菜单的动作：图标自己的面板里发事件，这里执行（函数都在作用域里了）
  iconActionRef.current = (action: string) => {
    if (action === 'tidy') { tidyIconsRef.current(); return }
    if (action === 'toggle-auto') { toggleIconAutoArrange(); return }
    if (action === 'toggle-snap') { toggleIconSnap(); return }
    if (action === 'group') { groupSelection(); return }
    if (action === 'ungroup') { ungroupSelection(); return }
    if (action === 'remove') { deleteSelection(); return }
  }

  groupToggleRef.current = () => {
    const selected = itemsRef.current.filter((entry) => selectedIdsRef.current.includes(entry.id) && entry.canvasId === activeCanvasRef.current)
    const grouped = selected.length > 1 && selected.every((entry) => entry.groupId && entry.groupId === selected[0].groupId)
    if (grouped) ungroupSelection()
    else groupSelection()
  }

  const addItem = useCallback((kind: ItemKind, customTitle?: string, source?: string, extra?: Pick<CanvasItem, 'searchQuery' | 'searchRoot' | 'initialSelectionPath'>, placement?: { canvasId: string; x: number; y: number }) => {
    if (kind === 'workspace') { setToast('子画布通过水滴吸附生成，请把两个元素拖到一起'); return undefined }
    // 放过生成点就以它所在的画布为准。之前要求锚点画布和当前活动画布一致，
    // 一旦对不上就退回鼠标位置——而点顶部工具栏时鼠标正好在左上角，新窗口就
    // 全跑到左上角去了。
    const target = resolveCreationTarget(placement)
    const canvas = target.canvas
    pushHistory(); const id = `${kind}-${Date.now()}`
    const definitions: Record<Exclude<ItemKind, 'workspace'>, { title: string; w: number; h: number }> = {
      video: { title: '新网页视频', w: 470, h: 330 }, web: { title: '新网页', w: 760, h: 500 }, folder: { title: '常用文件夹', w: 880, h: 560 },
      shellview: { title: '系统文件视图验证', w: 880, h: 560 },
      portal: { title: '新应用 · 应用门户', w: 340, h: 260 }, note: { title: '新便签', w: 320, h: 230 }, shelf: { title: '剪贴暂存', w: 380, h: 430 }, reference: { title: '新参考图板', w: 380, h: 260 },
      image: { title: '新图片', w: 420, h: 320 },
      app: { title: '新应用', w: 360, h: 250 },
      desktop: { title: '桌面', w: 900, h: 620 },
      icon: { title: '快捷方式', w: 112, h: 124 },
    }
    const definition = definitions[kind as Exclude<ItemKind, 'workspace'>]
    const title = customTitle || definition.title
    // 落在鼠标当前位置（窗口中心对准指针），鼠标不在画布上时退回视口中心。
    // 如果那儿已经压着别的窗口，按经典层叠往右下步进避开。
    // 优先用用户点出来的生成锚点；没有锚点就退回鼠标位置，再退回视口中心。
    const pinned = target.exact
    const start = { x: target.point.x - definition.w * .5, y: target.point.y - definition.h * .5 }
    const occupied = itemsRef.current.filter((entry) => entry.canvasId === canvas.id && !entry.pinned)
    const clashes = (spot: { x: number; y: number }) => occupied.some((entry) =>
      spot.x < entry.x + entry.w && spot.x + definition.w > entry.x &&
      spot.y < entry.y + entry.h && spot.y + definition.h > entry.y)
    // 用户手动放下的生成点是明确指令，就落在那里，压着别的窗口也照办。
    // 只有回退到鼠标位置或视口中心时才层叠避让，免得新窗口堆成一摞。
    let point = start
    if (!pinned) {
      for (let step = 1; step <= 40 && clashes(point); step += 1) {
        point = { x: start.x + step * 34, y: start.y + step * 30 }
      }
    }
    // 裸图标落点吸附网格（和 Windows 桌面一样整齐排列）
    if (kind === 'icon') point = { x: Math.round(point.x / ICON_GRID_STEP_X) * ICON_GRID_STEP_X, y: Math.round(point.y / ICON_GRID_STEP_Y) * ICON_GRID_STEP_Y }
    setItems((current) => [...current, { id, canvasId: canvas.id, kind, title, source, x: point.x, y: point.y, w: definition.w, h: definition.h, accent: '#4f8cff', ...extra }])
    setActiveCanvasId(canvas.id)
    setSelectedIds([id])
    // 2026-09-13 用户要求：新建的卡片**不再**自动塞进「当前画布」那一段
    //（原话：「我生成网页 然后 这个画布 全局常用下方 会出现一个 不常用的」）。要放进栏里只能自己拖。
    setSelectedIds([id]); setToast(`已添加到${canvas.title}`)
    return id
  }, [pushHistory, resolveCreationTarget])
  addCanvasItemRef.current = addItem

  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId: string; url: string; title?: string; createNew?: boolean }>).detail
      if (!detail?.url) return
      const current = itemsRef.current.find((entry) => entry.id === detail.itemId)
      if (detail.createNew || !current) {
        addItem('web', detail.title, detail.url)
        return
      }
      setItems((entries) => entries.map((entry) => entry.id === detail.itemId ? {
        ...entry,
        source: detail.url,
        title: detail.title || entry.title,
      } : entry))
      setToast(detail.title ? `当前浏览器已打开：${detail.title}` : '正在打开网页')
    }
    window.addEventListener(WEB_CARD_NAVIGATE_EVENT, onNavigate)
    return () => window.removeEventListener(WEB_CARD_NAVIGATE_EVENT, onNavigate)
  }, [addItem])

  useEffect(() => {
    const pointerPlacement = (position?: { x: number; y: number }) => {
      const pointer = position ?? pointerRef.current
      if (!pointer) return undefined
      const surface = document.elementsFromPoint(pointer.x, pointer.y)
        .map((element) => (element as HTMLElement).closest<HTMLElement>('.space-surface[data-canvas-id]'))
        .find((element): element is HTMLElement => Boolean(element))
      const canvas = surface ? spacesRef.current.find((entry) => entry.id === surface.dataset.canvasId) : undefined
      if (!surface || !canvas) return undefined
      const rect = surface.getBoundingClientRect()
      const outsideScale = rect.width / Math.max(surface.offsetWidth, 1)
      const localX = (pointer.x - rect.left) / outsideScale
      const localY = (pointer.y - rect.top) / outsideScale
      return {
        canvasId: canvas.id,
        x: (localX - canvas.viewport.x) / canvas.viewport.scale,
        y: (localY - canvas.viewport.y) / canvas.viewport.scale,
      }
    }
    const runQuickAdd = (kind: 'web' | 'folder', position?: { x: number; y: number }) => {
      if (position) pointerRef.current = position
      const placement = pointerPlacement(position) ?? spawnAnchorRef.current ?? undefined
      if (kind === 'web') addItem('web', undefined, undefined, undefined, placement)
      else addItem('folder', '此电脑', 'shell:MyComputerFolder', undefined, placement)
    }
    quickAddShortcutRef.current = runQuickAdd
    const onNativeQuickAdd = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: 'web' | 'folder'; clientX?: number; clientY?: number }>).detail
      if (!detail?.kind) return
      const position = Number.isFinite(detail.clientX) && Number.isFinite(detail.clientY) ? { x: detail.clientX!, y: detail.clientY! } : undefined
      runQuickAdd(detail.kind, position)
    }
    window.addEventListener('zhangzhongjie-quick-add', onNativeQuickAdd)
    return () => {
      quickAddShortcutRef.current = () => undefined
      window.removeEventListener('zhangzhongjie-quick-add', onNativeQuickAdd)
    }
  }, [addItem])

  useEffect(() => {
    const onAddFolder = (event: Event) => {
      const path = (event as CustomEvent<string>).detail || 'shell:MyComputerFolder'
      const label = path === 'shell:MyComputerFolder' ? '此电脑' : path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || '本地文件'
      addItem('folder', label, path)
    }
    const onAddWeb = (event: Event) => {
      const uri = (event as CustomEvent<string>).detail
      if (!uri) return
      let label = '新窗口'
      try { label = new URL(uri).hostname.replace(/^www\./, '') || '新窗口' } catch { label = '新窗口' }
      addItem('web', label, uri)
    }
    const onAddSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ query: string; root?: string }>).detail
      const query = detail?.query?.trim()
      if (!query) return
      addItem('folder', query, detail.root || 'shell:MyComputerFolder', {
        searchQuery: query,
        searchRoot: detail.root || '',
      })
    }
    const onAddApp = (event: Event) => {
      const path = (event as CustomEvent<string>).detail
      if (!path) return
      const base = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '新应用'
      addItem('app', base.replace(/\.(exe|lnk|bat|cmd)$/i, ''), path)
    }
    window.addEventListener('zhangzhongjie-add-app', onAddApp)
    window.addEventListener('zhangzhongjie-add-folder', onAddFolder)
    window.addEventListener('zhangzhongjie-add-web', onAddWeb)
    window.addEventListener('zhangzhongjie-add-search', onAddSearch)
    return () => {
      window.removeEventListener('zhangzhongjie-add-app', onAddApp)
      window.removeEventListener('zhangzhongjie-add-folder', onAddFolder)
      window.removeEventListener('zhangzhongjie-add-web', onAddWeb)
      window.removeEventListener('zhangzhongjie-add-search', onAddSearch)
    }
  }, [addItem])

  // 应用卡片：弹出系统"选择程序"对话框，选完在右键位置生成一张应用卡。
  const pickExecutableApp = useCallback(() => {
    const bridge = window.chrome?.webview
    if (!bridge || !contextMenu) return
    const placement = { canvasId: contextMenu.canvasId, x: contextMenu.worldX, y: contextMenu.worldY }
    const requestId = `pick-exe:${Date.now()}`
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; path?: string } | undefined
      if (data?.type !== 'native-pick-executable-result' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      if (!data.path) return
      const base = data.path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '新应用'
      addItem('app', base.replace(/\.(exe|lnk|bat|cmd)$/i, ''), data.path, undefined, placement)
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-pick-executable-request', requestId })
  }, [addItem, contextMenu])

  const baseName = (path: string) => path.split(/[\\/]/).pop() || path
  const attachDroppedFiles = (event: React.DragEvent): string[] => {
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer?.files || [])) {
      const candidate = (file as File & { path?: string }).path
      if (candidate) paths.push(candidate)
    }
    return paths
  }
  const askDirective = '【只回答模式】只用文字直接回答下面的问题：不要执行任何命令、不要读写或修改文件、不要操作电脑。如果这是操作类请求，告诉用户到「桌宠」里说，那里可以动手执行。'
  // 统一入口：把一张图交给 Hermes 读（复用底部输入栏的「问 Hermes」面板：可复制 / 存便签 / 再问一次）。
  const askHermesAboutImage = useCallback((path: string, anchor?: { x: number; y: number }) => {
    const question = '读这张图：把图里能看到的文字尽量原样列出来（不要翻译、不要改写、不要压缩成一句话）；如果是软件界面，说明是什么界面、有哪些关键信息（按钮 / 菜单 / 状态）；如果图里没有文字，就说图里是什么。'
    const requestId = `hermes-img:${Date.now()}`
    hermesAskRequestRef.current = requestId
    setHermesPanel({
      status: 'loading',
      question: `读图：${baseName(path)}`,
      attachments: [path],
      x: Math.round(anchor?.x ?? Math.max(24, window.innerWidth / 2 - 240)),
      y: Math.round(anchor?.y ?? 96),
    })
    const bridge = window.chrome?.webview
    if (!bridge) {
      setHermesPanel((current) => current ? { ...current, status: 'error', error: '仅桌面版掌中界支持 Hermes' } : current)
      return
    }
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; ok?: boolean; answer?: string; error?: string } | undefined
      if (data?.type !== 'native-hermes-answer' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      setHermesPanel((current) => current ? { ...current, status: data.ok ? 'done' : 'error', answer: data.answer || '', error: data.error || 'Hermes 没有返回内容' } : current)
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-hermes-ask', requestId, mode: 'ask', image: path, prompt: `${askDirective}\n\n（参考图片：${path}）\n\n${question}` })
  }, [])
  // 画布上的图片卡只有 dataUrl（没有磁盘路径）：先让宿主落成真实 PNG，再把路径交给 Hermes。
  // 画布图片卡只有 dataUrl：先让宿主落成真实 PNG 再动手（Hermes 读图与本地 OCR 共用）。
  const withItemImagePath = useCallback((item: { source?: string; dataUrl?: string }, onPath: (path: string) => void, onFail: () => void) => {
    const direct = typeof item.source === 'string' && item.source && !/^https?:/i.test(item.source) && !item.source.startsWith('shell:') ? item.source : ''
    if (direct) { onPath(direct); return }
    const bridge = window.chrome?.webview
    if (!bridge || !item.dataUrl) { onFail(); return }
    const requestId = `image-file:${Date.now()}`
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; ok?: boolean; path?: string } | undefined
      if (data?.type !== 'native-image-file-written' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      if (data.ok && data.path) onPath(data.path)
      else onFail()
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-write-image-file', requestId, dataUrl: item.dataUrl })
  }, [])
  // 本地 OCR 取字（Windows 自带引擎），语言取设置里的 ocrLanguage。
  const ocrImage = useCallback((path: string, anchor?: { x: number; y: number }) => {
    const language = readBrowserSettings().ocrLanguage || 'zh-Hans-CN'
    const requestId = `ocr:${Date.now()}`
    setHermesPanel({
      status: 'loading',
      question: `OCR 取字：${baseName(path)}`,
      attachments: [path],
      origin: 'ocr',
      x: Math.round(anchor?.x ?? Math.max(24, window.innerWidth / 2 - 240)),
      y: Math.round(anchor?.y ?? 96),
    })
    const bridge = window.chrome?.webview
    if (!bridge) {
      setHermesPanel((current) => current ? { ...current, status: 'error', error: '仅桌面版掌中界支持本地 OCR' } : current)
      return
    }
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; ok?: boolean; text?: string; error?: string; language?: string; engine?: string; elapsedMs?: number } | undefined
      if (data?.type !== 'native-ocr-result' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      const ocrText = data.ok ? (data.text || '（这张图里没识别到文字）') : ''
      setHermesPanel((current) => current ? {
        ...current,
        status: data.ok ? 'done' : 'error',
        answer: ocrText,
        error: data.error || 'OCR 没有返回内容',
        question: data.ok ? `OCR 取字（${data.engine || '系统 OCR'} · ${data.language || language} · ${data.elapsedMs ?? 0}ms）：${baseName(path)}` : current.question,
      } : current)
      // OCR 取字就是为了「拿了就用」：出结果直接进剪贴板，随手 Ctrl+V 就能贴到 PS / CAD / 微信。
      if (ocrText && !ocrText.startsWith('（这张图')) {
        // 走宿主剪贴板：WebView2 里 navigator.clipboard.writeText 常被拦（之前就是它没生效，
        // 用户按 Ctrl+V 贴出来还是旧内容）。
        if (bridge) bridge.postMessage({ type: 'native-clipboard-write', text: ocrText })
        else navigator.clipboard?.writeText(ocrText).catch(() => {})
        setToast('已识别并复制到剪贴板：直接 Ctrl+V 粘贴（面板里也能再复制或存成便签）')
      }
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-ocr-image', requestId, path, language })
  }, [])
  const ocrItemImage = useCallback((item: { source?: string; dataUrl?: string }, anchor?: { x: number; y: number }) => {
    withItemImagePath(item, (path) => ocrImage(path, anchor), () => setToast('这张图没有磁盘文件，取不了字；先把它拖到桌面存成文件再试'))
  }, [withItemImagePath, ocrImage])
  const askHermesAboutItemImage = useCallback((item: { source?: string; dataUrl?: string }, anchor?: { x: number; y: number }) => {
    withItemImagePath(item, (path) => askHermesAboutImage(path, anchor), () => setToast('这张图没有磁盘文件，读不了；先把它拖到桌面存成文件再读'))
  }, [withItemImagePath, askHermesAboutImage])
  useEffect(() => {
    const onAskImage = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; anchor?: { x: number; y: number } }>).detail
      if (detail?.path) askHermesAboutImage(detail.path, detail.anchor)
    }
    window.addEventListener(ASK_HERMES_IMAGE_EVENT, onAskImage)
    return () => window.removeEventListener(ASK_HERMES_IMAGE_EVENT, onAskImage)
  }, [askHermesAboutImage])
  useEffect(() => {
    // 「OCR 取字」事件：剪贴暂存 / 文件列表 / 超级预览 都用它发起。
    const onOcrImage = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; anchor?: { x: number; y: number } }>).detail
      if (detail?.path) ocrImage(detail.path, detail.anchor)
    }
    window.addEventListener(OCR_IMAGE_EVENT, onOcrImage)
    return () => window.removeEventListener(OCR_IMAGE_EVENT, onOcrImage)
  }, [ocrImage])
  useEffect(() => {
    // 把画布上的图标拖到底部「全局常用」栏 / 或点右键「固定到全局常用」→ 加进收藏（那栏支持改名和快捷键）。
    const onAddFavorite = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; sourceKind?: 'file' | 'folder' | 'app'; label?: string; image?: string; itemId?: string; restore?: { x: number; y: number } }>).detail
      if (!detail?.source) return
      addGlobalFavorite(detail.source, detail.sourceKind ?? 'app', detail.label || detail.source, detail.image)
      if (!detail.itemId) return
      const dropped = itemsRef.current.find((entry) => entry.id === detail.itemId)
      // 裸图标 / 应用卡＝就是个快捷方式：拖进栏里就算「收进去」了，画布上不再留副本。
      // （用户 2026-09-14 报：「拖上去后 画布上又会出现图标残留的」。Ctrl+Z 可撤销。）
      if (dropped && (dropped.kind === 'icon' || dropped.kind === 'app')) {
        setItems((current) => current.filter((entry) => entry.id !== detail.itemId))
        setSelectedIds((current) => current.filter((id) => id !== detail.itemId))
        setToast(`已把「${detail.label || dropped.title}」收进「全局常用」（画布上的图标已移除，Ctrl+Z 可撤销）`)
        return
      }
      // 文件 / 文件夹 / 网页卡带着内容，留在画布上，只把它放回原位。
      // 画布自己的落位逻辑是在这个监听之后跑的，所以要延后一拍再回位，否则会被覆盖掉。
      if (detail.restore) {
        const restore = detail.restore
        const itemId = detail.itemId
        window.setTimeout(() => updateItems(new Map([[itemId, { x: restore.x, y: restore.y }]])), 60)
      }
      setToast(`已固定到「全局常用」：${detail.label || detail.source}（卡片留在画布上）`)
    }
    window.addEventListener(GLOBAL_FAVORITE_EVENT, onAddFavorite)
    return () => window.removeEventListener(GLOBAL_FAVORITE_EVENT, onAddFavorite)
  }, [addGlobalFavorite, updateItems])

  useEffect(() => {
    // 裸图标右键菜单的动作（自动排列 / 开关 / 组合 / 移除）
    const onIconAction = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action
      if (action) iconActionRef.current(action)
    }
    window.addEventListener(ICON_ACTION_EVENT, onIconAction)
    return () => window.removeEventListener(ICON_ACTION_EVENT, onIconAction)
  }, [])

  useEffect(() => {
    // 把桌面卡里的图标拖出卡片（落到画布上）→ 在该处生成一个「裸图标」。
    const onDragOut = (event: Event) => {
      const detail = (event as CustomEvent<{ clientX?: number; clientY?: number; path?: string; name?: string }>).detail
      if (!detail?.path) return
      pointerRef.current = { x: detail.clientX ?? window.innerWidth * 0.5, y: detail.clientY ?? window.innerHeight * 0.5 }
      const target = dropPointRef.current?.()
      if (!target) return
      addItem('icon', detail.name || '', detail.path, undefined, { canvasId: target.canvas.id, x: target.x, y: target.y })
      setToast(`已把「${detail.name || '图标'}」放到画布上（双击打开）`)
    }
    window.addEventListener(DESKTOP_DRAG_OUT_EVENT, onDragOut)
    return () => window.removeEventListener(DESKTOP_DRAG_OUT_EVENT, onDragOut)
  }, [addItem])

  useEffect(() => {
    // 桌面卡内部（读到新图标 / 手动摆了位置 / 换了排序）统一回写到这张卡上。
    const onDesktopCard = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; patch?: Partial<CanvasItem> }>).detail
      if (!detail?.itemId || !detail.patch) return
      setItems((current) => current.map((entry) => entry.id === detail.itemId ? { ...entry, ...detail.patch } : entry))
    }
    window.addEventListener(DESKTOP_CARD_EVENT, onDesktopCard)
    return () => window.removeEventListener(DESKTOP_CARD_EVENT, onDesktopCard)
  }, [])

  useEffect(() => {
    // 卡片地址行的音量拉杆：记到这张卡上，并下发给原生（原生再写进页面里的 <video>/<audio>）。
    const onVolume = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; value?: number }>).detail
      if (!detail?.itemId || typeof detail.value !== 'number') return
      const value = Math.max(0, Math.min(1, detail.value))
      setItems((current) => current.map((entry) => entry.id === detail.itemId ? { ...entry, volume: value } : entry))
      window.chrome?.webview?.postMessage({ type: 'native-browser-volume', surfaceId: detail.itemId, volume: value })
    }
    window.addEventListener(CARD_VOLUME_EVENT, onVolume)
    return () => window.removeEventListener(CARD_VOLUME_EVENT, onVolume)
  }, [])
  useEffect(() => {
    // 页面里进了/出了系统画中画（原生侧转发过来的）：进 → 把这张卡藏起来（网页让位给画中画窗口）；出 → 恢复。
    const onPipState = (event: MessageEvent) => {
      const data = event.data as { type?: string; surfaceId?: string; state?: string } | undefined
      if (data?.type !== 'native-pip-state') return
      // 没带 surfaceId（app 页那条路）时：只处理「退出」——把所有藏起来的卡都恢复，避免有卡永远看不见。
      if (!data.surfaceId) {
        if (data.state === 'exit') {
          setItems((current) => current.some((entry) => entry.pipHidden)
            ? current.map((entry) => entry.pipHidden ? { ...entry, pipHidden: false } : entry)
            : current)
          setToast('已退出画中画：原网页已恢复')
          window.setTimeout(() => window.dispatchEvent(new Event(SURFACE_OCCLUSION_EVENT)), 60)
        }
        return
      }
      const entering = data.state === 'enter'
      if (!itemsRef.current.some((entry) => entry.id === data.surfaceId)) return
      setItems((current) => current.map((entry) => entry.id === data.surfaceId
        ? (Boolean(entry.pipHidden) === entering ? entry : { ...entry, pipHidden: entering })
        : entry))
      if (entering) setSelectedIds((current) => current.filter((id) => id !== data.surfaceId))
      // 卡片藏起来/恢复后要主动唤醒一次几何同步循环：它平时靠指针事件唤醒，
      // 而这次的输入发生在画中画窗口里、掌中界页面收不到事件 → 不唤醒的话原生网页窗口会一直浮着。
      window.setTimeout(() => window.dispatchEvent(new Event(SURFACE_OCCLUSION_EVENT)), 60)
      setToast(entering
        ? '已进入画中画：原网页先藏起来 · 双击画中画窗口（或点它的 ✕）就回来'
        : '已退出画中画：原网页已恢复')
    }
    const bridge = window.chrome?.webview
    bridge?.addEventListener('message', onPipState)
    return () => bridge?.removeEventListener('message', onPipState)
  }, [])
  useEffect(() => {
    // 纯视频窗口：宿主抠完播放区回调，带视频原始尺寸 → 把卡片调成同一个比例（小窗口播放）
    const onVideoMode = (event: MessageEvent) => {
      const data = event.data as { type?: string; surfaceId?: string; mode?: string; ok?: boolean; result?: string } | undefined
      if (data?.type !== 'native-browser-video-mode-result') return
      if (data.mode !== 'on' && data.mode !== 'pip') return
      // WebView2 的 ExecuteScript 回的是「JSON 字符串」：脚本 return 的字符串会被再包一层引号，所以要解两次。
      let payload: { ok?: boolean; w?: number; h?: number; pipEnabled?: boolean } = {}
      try {
        let parsed: unknown = JSON.parse(data.result || '{}')
        if (typeof parsed === 'string') parsed = JSON.parse(parsed)
        payload = (parsed || {}) as { ok?: boolean; w?: number; h?: number; pipEnabled?: boolean }
      } catch { /* 解析不了就当没有尺寸 */ }
      if (payload.ok === false || data.ok === false) {
        setToast('这张卡里没找到播放画面（不是视频页？或者页面还没加载完）')
        return
      }
      if (data.mode === 'pip') {
        if (payload.pipEnabled === false) { setToast('这个浏览器内核不支持画中画'); return }
        const freshPip = !itemsRef.current.some((entry) => entry.id === data.surfaceId && entry.pipMode)
        setItems((current) => current.map((entry) => entry.id === data.surfaceId
          ? (entry.immersive && entry.pipMode ? entry : { ...entry, immersive: true, pipMode: true })
          : entry))
        if (freshPip) setToast('画中画模式：在画面里双击视频进/出画中画；双击卡片顶部细带或 Esc 退出')
        return
      }
      let ratio = 0
      if (payload.w && payload.h) ratio = payload.h / payload.w
      const fresh = !itemsRef.current.some((entry) => entry.id === data.surfaceId && entry.videoOnly)
      setItems((current) => current.map((entry) => {
        if (entry.id !== data.surfaceId) return entry
        const nextH = ratio ? Math.max(150, Math.min(1000, Math.round(entry.w * ratio))) : entry.h
        if (entry.immersive && entry.videoOnly && entry.h === nextH) return entry
        return { ...entry, immersive: true, videoOnly: true, h: nextH }
      }))
      if (fresh) setToast('纯视频窗口已就绪：双击卡片顶部细带 / Esc 退出')
    }
    window.chrome?.webview?.addEventListener('message', onVideoMode)
    return () => window.chrome?.webview?.removeEventListener('message', onVideoMode)
  }, [])
  useEffect(() => {
    // 有些站会重排页面把注入的样式冲掉 → 纯视频期间每 4 秒补一次（结果回调里做了去重，不会反复重排）
    const timer = window.setInterval(() => {
      for (const entry of itemsRef.current) {
        if (entry.videoOnly) window.chrome?.webview?.postMessage({ type: 'native-browser-video-mode', surfaceId: entry.id, mode: 'on' })
        if (entry.pipMode) window.chrome?.webview?.postMessage({ type: 'native-browser-video-mode', surfaceId: entry.id, mode: 'pip' })
      }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    // 纯画面（桌布）模式：按 Esc 退回默认状态。单独挂一个监听，不依赖快捷键系统。
    const onEscapeImmersive = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const card = itemsRef.current.find((entry) => entry.immersive)
      if (!card) return
      toggleImmersive(card.id, false)
      setToast('已退出纯画面（桌布）模式')
    }
    window.addEventListener('keydown', onEscapeImmersive)
    return () => window.removeEventListener('keydown', onEscapeImmersive)
  }, [toggleImmersive])
  useEffect(() => {
    // 卡片里的「双击顶部细带退出纯画面」通过事件回到 App
    const onImmersiveToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ itemId?: string; value?: boolean }>).detail
      if (detail?.itemId) toggleImmersive(detail.itemId, detail.value)
    }
    window.addEventListener(IMMERSIVE_TOGGLE_EVENT, onImmersiveToggle)
    return () => window.removeEventListener(IMMERSIVE_TOGGLE_EVENT, onImmersiveToggle)
  }, [toggleImmersive])
  useEffect(() => {
    const onImageAction = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; anchor?: { x: number; y: number } }>).detail
      if (detail?.path) setImageActionMenu({ x: Math.round(detail.anchor?.x ?? window.innerWidth / 2), y: Math.round(detail.anchor?.y ?? 120), path: detail.path })
    }
    window.addEventListener(IMAGE_ACTION_EVENT, onImageAction)
    return () => window.removeEventListener(IMAGE_ACTION_EVENT, onImageAction)
  }, [])
  const reaskHermesWithImage = (path: string) => {
    const question = hermesPanel?.question
    if (!question) return
    setHermesPanel((current) => current ? { ...current, attachments: [path], status: 'loading', answer: undefined, error: undefined } : current)
    const requestId = `hermes-ask:${Date.now()}`
    const bridge = window.chrome?.webview
    if (!bridge) return
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; ok?: boolean; answer?: string; error?: string } | undefined
      if (data?.type !== 'native-hermes-answer' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      setHermesPanel((current) => current ? { ...current, status: data.ok ? 'done' : 'error', answer: data.answer || '', error: data.error || 'Hermes 没有返回内容' } : current)
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-hermes-ask', requestId, mode: 'ask', image: path, prompt: `${askDirective}\n\n（参考图片：${path}）\n\n${question}` })
  }
  const buildPetContext = () => {
    try {
      const labelOf = (entry: { label?: string; title?: string; kind?: string }) => entry.label || entry.title || '未命名'
      const total = items.length
      const cells = items.slice(0, 40).map((entry) => {
        const source = typeof entry.source === 'string' && entry.source ? ` @ ${entry.source}` : ''
        return `- [${entry.kind}] ${labelOf(entry as { label?: string; title?: string; kind?: string })}${source}`
      })
      const selected = items.filter((entry) => selectedIds.includes(entry.id))
      const lines = [
        '【掌中界画布上下文（系统自动附带，供你参考）】',
        `当前画布：${activeCanvas?.title || '未命名'}，共 ${total} 个元素。`,
        selected.length
          ? `用户此刻选中了 ${selected.length} 个元素：\n${selected.map((entry) => `- [${entry.kind}] ${labelOf(entry as { label?: string; title?: string; kind?: string })}${typeof entry.source === 'string' && entry.source ? ` @ ${entry.source}` : ''}`).join('\n')}`
          : '用户此刻没有选中任何元素。',
        total ? `画布元素清单（最多 40 个）：\n${cells.join('\n')}` : '',
        '说明：磁盘文件你可以直接操作；画布卡片也可以通过本消息开头的「掌中界画布操作接口」增删/选中——请按那里的步骤真的动手，不要说做不到。',
        ''
      ]
      return lines.filter(Boolean).join('\n') + '\n'
    } catch {
      return ''
    }
  }
  const canvasOpRef = useRef<(payload: { [key: string]: unknown }) => { ok: boolean; error?: string; data?: unknown }>(() => ({ ok: false, error: '画布桥未就绪' }))
  canvasOpRef.current = (payload) => {
    const op = String(payload.op || '')
    const all = itemsRef.current
    const titleOf = (entry: { title?: string; label?: string }) => entry.title || entry.label || ''
    const match = String(payload.match || '').trim().toLowerCase()
    const basenameOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
    const findTargets = () => {
      if (!match) return []
      return all.filter((entry) => entry.id.toLowerCase() === match || titleOf(entry).toLowerCase().includes(match) || (typeof entry.source === 'string' && entry.source.toLowerCase().includes(match)))
    }
    const spawnPoint = (() => {
      // 桌宠加卡时落在用户当前视野正中央，而不是默认角落。
      try {
        const surface = document.querySelector('.space-surface') as HTMLElement | null
        if (!surface) return undefined
        const rect = surface.getBoundingClientRect()
        const viewport = activeCanvas.viewport
        return { canvasId: activeCanvas.id, x: (rect.width / 2 - viewport.x) / viewport.scale, y: (rect.height / 2 - viewport.y) / viewport.scale }
      } catch { return undefined }
    })()
    try {
      if (op === 'list') {
        return { ok: true, data: { items: all.map((entry) => ({ id: entry.id, kind: entry.kind, title: titleOf(entry), source: typeof entry.source === 'string' ? entry.source : '', selected: selectedIds.includes(entry.id) })) } }
      }
      if (op === 'add_note') {
        const title = String(payload.title || 'Hermes 便签')
        const text = String(payload.text || '')
        const id = addItem('note', title, undefined, undefined, spawnPoint)
        if (!id) return { ok: false, error: '创建失败' }
        if (text) setItems((current) => current.map((it) => it.id === id ? { ...it, text } : it))
        setSelectedIds([id])
        return { ok: true, data: { id, title } }
      }
      if (op === 'add_web') {
        const url = String(payload.url || '')
        if (!url) return { ok: false, error: '缺少 url' }
        const id = addItem('web', String(payload.title || '网页'), url, undefined, spawnPoint)
        if (!id) return { ok: false, error: '创建失败' }
        setSelectedIds([id])
        return { ok: true, data: { id, url } }
      }
      if (op === 'add_folder' || op === 'add_image' || op === 'add_file') {
        const filePath = String(payload.path || '')
        if (!filePath) return { ok: false, error: '缺少 path' }
        const kind = op === 'add_folder' ? 'folder' : op === 'add_image' ? 'image' : 'file'
        const id = addItem(kind as ItemKind, String(payload.title || basenameOf(filePath)), filePath, undefined, spawnPoint)
        if (!id) return { ok: false, error: '创建失败' }
        setSelectedIds([id])
        return { ok: true, data: { id, path: filePath } }
      }
      if (op === 'remove') {
        const targets = findTargets()
        if (!targets.length) return { ok: false, error: match ? `没找到匹配 "${String(payload.match)}" 的卡片` : '缺少 match' }
        const ids = targets.map((entry) => entry.id)
        pushHistory()
        setItems((current) => current.filter((entry) => !ids.includes(entry.id)))
        setSelectedIds((current) => current.filter((id) => !ids.includes(id)))
        setToast(`桌宠删除了 ${ids.length} 张卡片`)
        return { ok: true, data: { removed: targets.map((entry) => ({ id: entry.id, title: titleOf(entry) })) } }
      }
      if (op === 'select') {
        const targets = findTargets()
        if (!targets.length) return { ok: false, error: '没找到匹配的卡片' }
        setSelectedIds(targets.map((entry) => entry.id))
        return { ok: true, data: { selected: targets.map((entry) => titleOf(entry)) } }
      }
      return { ok: false, error: `不支持的 op：${op}` }
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message || error) }
    }
  }
  useEffect(() => {
    const bridge = window.chrome?.webview
    if (!bridge) return
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; opId?: string; payload?: { [key: string]: unknown } } | undefined
      if (data?.type !== 'zzj-canvas-op' || !data.opId) return
      const result = canvasOpRef.current(data.payload || {})
      bridge.postMessage({ type: 'zzj-canvas-op-result', opId: data.opId, ...result })
    }
    bridge.addEventListener('message', receive)
    return () => bridge.removeEventListener('message', receive)
  }, [])
  const beginPetDrag = (event: React.PointerEvent<HTMLElement>) => {
    const element = event.currentTarget as HTMLElement
    const root = (element.closest('.pet-root') as HTMLElement | null) ?? element
    const rect = root.getBoundingClientRect()
    petDragRef.current = { active: true, sx: event.clientX, sy: event.clientY, lx: 0, ly: 0, left: rect.left, top: rect.top, moved: false }
    try { element.setPointerCapture(event.pointerId) } catch { /* 某些环境不支持捕获，忽略 */ }
  }
  const applyPetModel = (value: string) => {
    setPetModel(value)
    // 直接写浏览器设置：不走 native-settings-update 回传，避免被原生白名单剔除后回洗。
    try {
      const next = normalizeSettings({ ...readBrowserSettings(), petModel: value, version: 2 })
      localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(next))
      window.dispatchEvent(new CustomEvent<AppSettings>(APP_SETTINGS_EVENT, { detail: next }))
    } catch { /* 忽略持久化失败 */ }
    setPetModelPanel(false)
    setToast(value ? `桌宠已切换到 ${value}（下一句开始生效）` : '桌宠已跟回 Hermes 默认模型')
  }
  const sendPetMessage = (text: string) => {
    const question = text.trim()
    if (!question || petBusy) return
    const images = [...petAttachments]
    setPetMessages((list) => [...list, { role: 'user', text: question, image: images[0] }])
    setPetInput('')
    setPetAttachments([])
    setPetBusy(true)
    const requestId = `hermes-pet:${Date.now()}`
    const bridge = window.chrome?.webview
    if (!bridge) {
      setPetBusy(false)
      setPetMessages((list) => [...list, { role: 'pet', text: '仅桌面版掌中界支持桌宠' }])
      return
    }
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: string; requestId?: string; ok?: boolean; answer?: string; error?: string } | undefined
      if (data?.type !== 'native-hermes-answer' || data.requestId !== requestId) return
      bridge.removeEventListener('message', receive)
      setPetBusy(false)
      setPetMessages((list) => [...list, { role: 'pet', text: data.ok ? (data.answer || '（空回复）') : `⚠ ${data.error || '执行失败'}` }])
      if (data.ok && data.answer) setToast('桌宠有新回复')
    }
    bridge.addEventListener('message', receive)
    bridge.postMessage({ type: 'native-hermes-ask', requestId, mode: 'pet', image: images[0], model: petModel || '', prompt: buildPetContext() + question })
  }
  useEffect(() => {
    const log = petLogRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [petMessages, petBusy])

  useEffect(() => {
    // 桌宠拖动：监听常驻，只有按下后 drag.active 为真才生效。
    // 直接写样式（不用 rAF——窗口被遮挡时 rAF 可能整段不触发，会「拖着不动、松手才跳」）。
    const move = (event: PointerEvent) => {
      const drag = petDragRef.current
      if (!drag.active) return
      if (event.buttons === 0) { end(); return }
      const dx = event.clientX - drag.sx
      const dy = event.clientY - drag.sy
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      drag.moved = true
      drag.lx = Math.max(8, Math.min(window.innerWidth - 80, drag.left + dx))
      drag.ly = Math.max(8, Math.min(window.innerHeight - 80, drag.top + dy))
      const root = document.querySelector('.pet-root') as HTMLElement | null
      if (root) {
        root.style.left = `${Math.round(drag.lx)}px`
        root.style.top = `${Math.round(drag.ly)}px`
        root.style.right = 'auto'
        root.style.bottom = 'auto'
      }
    }
    const end = () => {
      const drag = petDragRef.current
      if (!drag.active) return
      drag.active = false
      if (drag.moved) {
        petDragRecentRef.current = Date.now()
        setPetAnchor({ x: Math.round(drag.lx), y: Math.round(drag.ly) })
      }
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('blur', end, true)
    window.addEventListener('mouseup', end, true)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('blur', end, true)
      window.removeEventListener('mouseup', end, true)
    }
  }, [])
  const submitGlobalInput = useCallback(() => {
    const value = searchValue.trim()
    if (!value) return
    const forcedSearch = value.startsWith('/')
    const routedValue = (forcedSearch ? value.slice(1) : value).trim()
    if (!routedValue) return
    if (searchMode === 'hermes') {
      const anchorInput = document.querySelector('.global-search-input')
      const anchorRect = anchorInput?.getBoundingClientRect()
      const requestId = `hermes-ask:${Date.now()}`
      hermesAskRequestRef.current = requestId
      setHermesPanel({
        status: 'loading', question: routedValue,
        x: Math.round(anchorRect?.left ?? 320), y: Math.round((anchorRect?.bottom ?? 60) + 8),
      })
      const bridge = window.chrome?.webview
      if (bridge) {
        const receive = (event: MessageEvent) => {
          const data = event.data as { type?: string; requestId?: string; ok?: boolean; answer?: string; error?: string } | undefined
          if (data?.type !== 'native-hermes-answer' || data.requestId !== requestId) return
          bridge.removeEventListener('message', receive)
          setHermesPanel((current) => current ? {
            ...current,
            status: data.ok ? 'done' : 'error',
            answer: data.answer || '',
            error: data.error || 'Hermes 没有返回内容',
          } : current)
        }
        bridge.addEventListener('message', receive)
        bridge.postMessage({ type: 'native-hermes-ask', requestId, mode: 'ask', prompt: `${askDirective}\n\n${routedValue}` })
      } else {
        setHermesPanel((current) => current ? { ...current, status: 'error', error: '仅桌面版掌中界支持 Hermes' } : current)
      }
      setSearchValue('')
      return
    }
    const isPath = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('shell:')
    if (isPath) {
      const normalized = value.replace(/\//g, '\\')
      const label = normalized.split('\\').filter(Boolean).at(-1) || '此电脑'
      addItem('folder', label, normalized)
      setToast(`已把本地位置加入“${activeCanvas.title}”`)
    } else if (forcedSearch || searchMode === 'disk') {
      addItem('folder', routedValue, 'shell:MyComputerFolder', { searchQuery: routedValue, searchRoot: '' })
      setToast(`正在全盘搜索“${routedValue}”`)
    } else {
      const url = /^https?:\/\//i.test(routedValue) ? routedValue : `https://${routedValue}`
      let label = routedValue
      try { label = new URL(url).hostname.replace(/^www\./, '') } catch { /* 保留输入 */ }
      // 选中了一张网页卡时，网址框直接改那张卡的页面（网页卡自己的地址栏已按用户要求删除）
      const navigable = itemsRef.current.find((entry) => (entry.kind === 'web' || entry.kind === 'video') && selectedIdsRef.current.includes(entry.id))
      if (navigable) {
        window.dispatchEvent(new CustomEvent(WEB_CARD_NAVIGATE_EVENT, { detail: { itemId: navigable.id, url } }))
        setToast(`已让“${navigable.title}”打开 ${label}`)
      } else {
        addItem('web', label, url)
        setToast(`已在“${activeCanvas.title}”创建浏览器窗口`)
      }
    }
    setSearchValue('')
  }, [activeCanvas.title, addItem, searchMode, searchValue])

  const restoreSession = () => {
    const saved = savedSessionRef.current
    if (!saved || restorePendingRef.current) return
    const bridge = window.chrome?.webview
    if (!bridge) {
      loadSessionState(saved, savedSessionDirtyRef.current)
      setToast('已恢复浏览器预览中的上次会话')
      return
    }
    restorePendingRef.current = true
    restoreFallbackAppliedRef.current = false
    setRestorePending(true)
    restoreTimeoutRef.current = window.setTimeout(() => {
      if (!restorePendingRef.current) return
      restorePendingRef.current = false
      restoreTimeoutRef.current = null
      restoreFallbackAppliedRef.current = true
      setRestorePending(false)
      currentProjectPathRef.current = ''
      packageRootsRef.current = []
      const fallback = savedSessionRef.current
      if (fallback) loadSessionState(fallback, savedSessionDirtyRef.current)
      setToast('已恢复画布，但未能确认原保存位置；下次保存时请重新选择位置')
    }, 4000)
    bridge.postMessage({ type: 'native-session-restore-request' })
  }
  const freshSession = () => {
    clearRestoreWait()
    restoreFallbackAppliedRef.current = false
    localStorage.removeItem(STORAGE_KEY)
    recoveryAssetCacheRef.current.clear()
    window.chrome?.webview?.postMessage({ type: 'native-session-discard' })
    savedSessionRef.current = null
    packageRootsRef.current = []
    currentProjectPathRef.current = ''
    loadSessionState(sessionFromState(createSeedItems(), createSeedSpaces(), 'system', null, ROOT_ID), true)
  }

  const splitQuickOptions = splitQuickFilter.trim()
    ? tileWindowOptions.filter((entry) => `${entry.title} ${entry.process ?? ''}`.toLocaleLowerCase().includes(splitQuickFilter.trim().toLocaleLowerCase()))
    : tileWindowOptions
  const previewItem = previewId ? items.find((item) => item.id === previewId) : null
  const previewCanvas = previewItem ? spaces.find((canvas) => canvas.id === previewItem.canvasId) ?? activeCanvas : activeCanvas
  const breadcrumb = useMemo(() => {
    const path: SpaceCanvas[] = []; let current: SpaceCanvas | undefined = previewCanvas
    while (current) { path.unshift(current); current = current.parentCanvasId ? spaces.find((entry) => entry.id === current?.parentCanvasId) : undefined }
    return path
  }, [previewCanvas, spaces])

  // 全局常用栏里的「待办」：在当前画布放一张待办清单卡（勾选式），和右键菜单同一个生成逻辑。
  const addTodoCard = useCallback((placement?: { canvasId: string; x: number; y: number }) => {
    const created = addItem('note', '待办', undefined, undefined, placement)
    if (created) setItems((current) => current.map((entry) => (entry.id === created ? { ...entry, todo: [] } : entry)))
  }, [addItem])
  
  // 1.0.66：把「待办」一次性搬进全局常用栏（用户点名的位置）。用一次性标记 —— 用户以后自己删掉就不再补回。
  useEffect(() => {
    const key = 'zhangzhongjie.migrated.quick-todo.v1'
    if (localStorage.getItem(key)) return
    localStorage.setItem(key, '1')
    const settings = settingsRef.current
    const quickActions: GlobalQuickAction[] = settings.globalQuickActions.includes('todo') ? settings.globalQuickActions : [...settings.globalQuickActions, 'todo']
    const order = settings.globalFixedOrder.includes('quick-todo') ? settings.globalFixedOrder : [...settings.globalFixedOrder.filter((target) => target !== 'quick-todo'), 'quick-todo']
    updateGlobalSettings({ globalQuickActions: quickActions, globalFixedOrder: order })
  }, [])
  
  
  const selectedWorkspaceItems = items.filter((item) => selectedIds.includes(item.id) && item.canvasId === activeCanvasId && item.kind === 'workspace')
  const quickActionDefinitions: Record<GlobalQuickAction, FixedEntry> = {
    computer: { icon: '▣', label: '此电脑', target: 'quick-computer', tone: 'folder' },
    navigator: { icon: '▤', label: '空间导航器', target: 'quick-navigator', tone: 'canvas' },
    web: { icon: 'video', label: '网页', target: 'quick-web', tone: 'canvas' },
    shelf: { icon: '▤', label: '剪贴暂存', target: 'quick-shelf', tone: 'canvas' },
    todo: { icon: '▤', label: '待办', target: 'quick-todo', tone: 'canvas' },
  }
  const globalFavoriteEntries = globalFavorites.map((favorite): FixedEntry => ({
    icon: favorite.sourceKind === 'folder' ? '▰' : '◆',
    label: favorite.label,
    target: favorite.id,
    tone: favorite.sourceKind === 'folder' ? 'folder' : 'canvas',
    source: favorite.source,
    sourceKind: favorite.sourceKind,
    image: favorite.image,
  }))
  const globalEntryByTarget = new Map<string, FixedEntry>([
    ...globalQuickActions.map((action) => [`quick-${action}`, quickActionDefinitions[action]] as const),
    ...globalFavoriteEntries.map((entry) => [entry.target, entry] as const),
  ])
  const globalFixedEntries = globalFixedOrder.flatMap((target) => {
    const entry = globalEntryByTarget.get(target)
    return entry ? [entry] : []
  })
  const globalQuickEntries = globalFixedEntries.filter((entry) => entry.target.startsWith('quick-'))
  // 2026-09-15：顶栏不再显示「全局一份」的收藏 —— 改成每个画布/模板一套（就是下面的「当前画布」栏）
  const globalFavoriteFixedEntries = globalFixedEntries.filter((entry) => !entry.target.startsWith('quick-'))
  const globalFavoritesPageMax = Math.max(0, Math.ceil(globalFavoriteFixedEntries.length / GLOBAL_FAVORITE_PAGE_SIZE) - 1)
  const globalFavoritesPageClamped = Math.min(globalFavoritesPage, globalFavoritesPageMax)
  const globalFavoritePageEntries = globalFavoriteFixedEntries.slice(
    globalFavoritesPageClamped * GLOBAL_FAVORITE_PAGE_SIZE,
    (globalFavoritesPageClamped + 1) * GLOBAL_FAVORITE_PAGE_SIZE)
  // 快捷键定位：Ctrl+1..9 = 当前画布固定栏的第 N 个（画布优先），没有该位再看「我的收藏」当前排第 N 个。
  globalSlotRunRef.current = (slot: number) => {
    const pinned = activeCanvas.fixedEntries[slot]
    if (pinned && itemsRef.current.some((candidate) => candidate.id === pinned.target)) {
      focusEntry(activeCanvas.id, pinned)
      setToast(`当前画布：${pinned.label}`)
      return
    }
    // 固定栏里存的是应用/文件路径（不是画布上的卡片）→ 启动应用 / 打开位置
    if (pinned?.source) {
      if (pinned.sourceKind === 'app') {
        window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: pinned.source })
        setToast(`启动：${pinned.label}`)
        return
      }
      focusEntry(activeCanvas.id, pinned)
      setToast(`当前画布：${pinned.label}`)
      return
    }
    const entry = globalFavoritePageEntries[slot]
    if (!entry) return
    const favorite = globalFavorites.find((candidate) => candidate.id === entry.target)
    if (favorite?.sourceKind === 'app') {
      window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: favorite.source })
      setToast(`启动：${favorite.label}`)
      return
    }
    focusEntry(ROOT_ID, entry)
  }
  const currentFixedEntries = activeCanvas.fixedEntries
  const selectedCurrentFixedTarget = [...selectedIds].reverse().find((id) => currentFixedEntries.some((entry) => entry.target === id)) ?? null
  const indicatedCurrentFixedTarget = currentFixedEntries.some((entry) => entry.target === activeFixedTarget)
    ? activeFixedTarget
    : selectedCurrentFixedTarget
  const indicatedGlobalFixedTarget = globalFixedEntries.some((entry) => entry.target === activeGlobalFixedTarget)
    ? activeGlobalFixedTarget
    : null
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const focusedWorkspace = focusedWorkspaceId ? items.find((item) => item.id === focusedWorkspaceId) : undefined
  const focusedCanvas = focusedWorkspace?.childCanvasId ? spaces.find((canvas) => canvas.id === focusedWorkspace.childCanvasId) : undefined
  const isFullscreen = isNativeFullscreen || isFallbackFullscreen

  const saveCurrentWebBookmark = () => {
    if (!contextItem || (contextItem.kind !== 'web' && contextItem.kind !== 'video')) return
    const url = contextItem.source?.trim() || ''
    if (!/^(https?|file):\/\//i.test(url)) { setToast('当前网页还没有可收藏的网址'); return }
    if (webBookmarks.some((bookmark) => bookmark.url === url)) { setToast('这个网页已经在“我的收藏”里'); return }
    let fallbackName = url
    try { fallbackName = new URL(url).hostname.replace(/^www\./, '') || url } catch { /* URL already validated above. */ }
    const bookmark = { id: crypto.randomUUID(), name: contextItem.title?.trim() || fallbackName, url }
    updateGlobalSettings({ webBookmarks: [...webBookmarks, bookmark] })
    setToast(`已收藏：${bookmark.name}`)
  }

  const setWebThemeMode = (mode: WebThemeMode) => {
    updateGlobalSettings({ webThemeMode: mode })
    if (!window.chrome?.webview) setToast(`网页颜色已切换为${mode === 'dark' ? '强制深色' : mode === 'original' ? '网站原色' : '跟随应用'}；桌面版重启后完全生效`)
  }

  const reorderFixedEntry = useCallback((section: 'global' | 'current', draggedTarget: string, dropIndex: number) => {
    if (section === 'global') {
      const settings = settingsRef.current
      const quickTargets = settings.globalFixedOrder.filter((target) => target.startsWith('quick-'))
      const favoriteTargetSet = new Set(settings.globalFavorites.map((favorite) => favorite.id))
      const favoriteTargets = settings.globalFixedOrder.filter((target) => favoriteTargetSet.has(target))
      const isFavorite = favoriteTargetSet.has(draggedTarget)
      const currentOrder = isFavorite ? favoriteTargets : quickTargets
      const fromIndex = currentOrder.indexOf(draggedTarget)
      if (fromIndex < 0) return
      const nextGroup = [...currentOrder]
      const [dragged] = nextGroup.splice(fromIndex, 1)
      nextGroup.splice(clamp(dropIndex - (fromIndex < dropIndex ? 1 : 0), 0, nextGroup.length), 0, dragged)
      if (nextGroup.every((target, index) => target === currentOrder[index])) return
      const nextQuickTargets = isFavorite ? quickTargets : nextGroup
      const nextFavoriteTargets = isFavorite ? nextGroup : favoriteTargets
      const nextQuickActions = nextQuickTargets
        .filter((target): target is `quick-${GlobalQuickAction}` => target.startsWith('quick-'))
        .map((target) => target.slice('quick-'.length) as GlobalQuickAction)
      updateGlobalSettings({ globalFixedOrder: [...nextQuickTargets, ...nextFavoriteTargets], globalQuickActions: nextQuickActions })
      setToast('全局常用顺序已更新')
      return
    }
    const canvasId = activeCanvasId
    const canvas = spacesRef.current.find((entry) => entry.id === canvasId)
    if (!canvas) return
    const sectionEntries = canvas.fixedEntries
    const fromIndex = sectionEntries.findIndex((entry) => entry.target === draggedTarget)
    if (fromIndex < 0) return
    const nextSection = [...sectionEntries]
    const [dragged] = nextSection.splice(fromIndex, 1)
    const adjustedIndex = clamp(dropIndex - (fromIndex < dropIndex ? 1 : 0), 0, nextSection.length)
    nextSection.splice(adjustedIndex, 0, dragged)
    if (sectionEntries.every((entry, index) => entry.target === nextSection[index]?.target)) return
    pushHistory()
    setSpaces((current) => current.map((entry) => {
      if (entry.id !== canvasId) return entry
      return { ...entry, fixedEntries: nextSection }
    }))
    setToast('固定栏顺序已更新')
  }, [activeCanvasId, pushHistory, updateGlobalSettings])

  const removeCurrentFixedEntry = useCallback((canvasId: string, target: string) => {
    pushHistory()
    setSpaces((current) => current.map((canvas) => canvas.id === canvasId
      ? { ...canvas, fixedEntries: canvas.fixedEntries.filter((entry) => entry.target !== target) }
      : canvas))
    setActiveFixedTarget((current) => current === target ? null : current)
    setToast('已从当前画布常用里移除，画布内容保持不变')
  }, [pushHistory])

  const commitGlobalFavoriteRename = useCallback((target: string, draft: string) => {
    const label = draft.replace(/[\r\n]+/g, ' ').trim().slice(0, 120)
    if (!label) { setToast('显示名不能为空'); return false }
    const settings = settingsRef.current
    const nextFavorites = settings.globalFavorites.map((favorite) => favorite.id === target ? { ...favorite, label } : favorite)
    updateGlobalSettings({ globalFavorites: nextFavorites })
    setRenamingGlobalFavorite(null)
    setToast('已修改收藏显示名；硬盘上的真实文件名没有改变')
    return true
  }, [updateGlobalSettings])

  const removeGlobalFavorite = useCallback((target: string) => {
    const settings = settingsRef.current
    updateGlobalSettings({
      globalFavorites: settings.globalFavorites.filter((favorite) => favorite.id !== target),
      globalFixedOrder: settings.globalFixedOrder.filter((entryTarget) => entryTarget !== target),
    })
    setActiveGlobalFixedTarget((current) => current === target ? null : current)
    setRenamingGlobalFavorite((current) => current?.target === target ? null : current)
    setPendingGlobalFavoriteRemoval(null)
    setToast('已移除收藏入口；硬盘上的文件和文件夹保持不变')
  }, [updateGlobalSettings])

  useEffect(() => () => {
    if (globalFixedClickTimerRef.current !== null) window.clearTimeout(globalFixedClickTimerRef.current)
  }, [])

  // 应用类收藏的显示名自动去掉 .lnk/.exe 尾巴（只影响显示，不动磁盘文件）。
  const cleanAppDisplayLabel = (label: string) => label.replace(/\.lnk$/i, '').replace(/\.exe$/i, '')
  const renderFixedEntry = (entry: FixedEntry, section: 'global' | 'current', index: number, canvasId: string, slotShortcut?: string) => {
    const globalFavorite = section === 'global' ? globalFavorites.find((favorite) => favorite.id === entry.target) : undefined
    const group = section === 'current' ? 'current' : globalFavorite ? 'favorite' : 'quick'
    const hint = fixedDropHint?.section === section && fixedDropHint.group === group && fixedDropHint.target === entry.target ? fixedDropHint : null
    const isRenaming = renamingGlobalFavorite?.target === entry.target
    return <div
      className={`fixed-entry fixed-entry-sortable ${hint ? hint.after ? 'drop-after' : 'drop-before' : ''}`}
      key={`${section}-${entry.target}`}
      data-fixed-target={entry.target}
      data-fixed-section={section}
      data-fixed-group={group}
      data-fixed-index={index}
      title={globalFavorite?.source || entry.label}
      role="button"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || isRenaming || (event.target as HTMLElement).closest('button,input')) return
        event.stopPropagation()
        fixedPointerDragRef.current = {
          section,
          group,
          target: entry.target,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          dragging: false,
          element: event.currentTarget,
        }
        fixedDragClickSuppressedRef.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const dragging = fixedPointerDragRef.current
        if (!dragging || dragging.pointerId !== event.pointerId) return
        if (!dragging.dragging) {
          if (Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 5) return
          dragging.dragging = true
          dragging.element.classList.add('is-dragging')
          floatFixedEntry(dragging.element)
          dragging.floating = true
          fixedDragClickSuppressedRef.current = true
        }
        // 被拖的那一项跟着鼠标走（自身 transform，不用克隆浮层）
        moveFloatingFixedEntry(dragging.element, event.clientX - dragging.startX, event.clientY - dragging.startY)
        event.preventDefault()
        event.stopPropagation()
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.fixed-entry-sortable[data-fixed-section]')
        if (!hit || hit.dataset.fixedSection !== dragging.section || hit.dataset.fixedGroup !== dragging.group || !hit.dataset.fixedTarget) {
          setFixedDropHint(null)
          return
        }
        const rect = hit.getBoundingClientRect()
        setFixedDropHint({ section: dragging.section, group: dragging.group, target: hit.dataset.fixedTarget, after: event.clientX >= rect.left + rect.width / 2 })
      }}
      onPointerUp={(event) => {
        const dragging = fixedPointerDragRef.current
        if (!dragging || dragging.pointerId !== event.pointerId) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        if (dragging.floating) settleFloatingFixedEntry(dragging.element)
        dragging.floating = false
        if (dragging.dragging) {
          event.preventDefault()
          event.stopPropagation()
          const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.fixed-entry-sortable[data-fixed-section]')
          if (hit?.dataset.fixedSection === dragging.section && hit.dataset.fixedGroup === dragging.group) {
            const targetIndex = Number(hit.dataset.fixedIndex)
            if (Number.isFinite(targetIndex)) {
              const rect = hit.getBoundingClientRect()
              reorderFixedEntry(dragging.section, dragging.target, targetIndex + (event.clientX >= rect.left + rect.width / 2 ? 1 : 0))
            }
          } else if (dragging.group === 'quick') {
            const surface = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.space-surface[data-canvas-id]')
            const canvas = surface ? spacesRef.current.find((candidate) => candidate.id === surface.dataset.canvasId) : undefined
            if (surface && canvas) {
              const rect = surface.getBoundingClientRect()
              const outsideScale = rect.width / Math.max(surface.offsetWidth, 1)
              const placement = {
                canvasId: canvas.id,
                x: ((event.clientX - rect.left) / outsideScale - canvas.viewport.x) / canvas.viewport.scale,
                y: ((event.clientY - rect.top) / outsideScale - canvas.viewport.y) / canvas.viewport.scale,
              }
              const action = dragging.target.slice('quick-'.length) as GlobalQuickAction
              if (action === 'computer') addItem('folder', '此电脑', 'shell:MyComputerFolder', undefined, placement)
              else if (action === 'navigator') setSpaceNavigatorOpen(true)
              else if (action === 'todo') addTodoCard(placement)
              else addItem(action === 'web' ? 'video' : action, undefined, undefined, undefined, placement)
            }
          }
        }
        settleFloatingFixedEntry(dragging.element)
        dragging.floating = false
        fixedPointerDragRef.current = null
        setFixedDropHint(null)
        window.setTimeout(() => { fixedDragClickSuppressedRef.current = false }, 0)
      }}
      onPointerCancel={(event) => {
        const dragging = fixedPointerDragRef.current
        if (!dragging || dragging.pointerId !== event.pointerId) return
        settleFloatingFixedEntry(dragging.element)
        dragging.floating = false
        fixedPointerDragRef.current = null
        setFixedDropHint(null)
        window.setTimeout(() => { fixedDragClickSuppressedRef.current = false }, 0)
      }}
      onClick={() => {
        if (fixedDragClickSuppressedRef.current) { fixedDragClickSuppressedRef.current = false; return }
        if (isRenaming) return
        if (section === 'global') {
          setActiveGlobalFixedTarget(entry.target)
          if (globalFavorite?.sourceKind === 'app') {
            window.chrome?.webview?.postMessage({ type: 'native-launch-app', path: globalFavorite.source })
            setToast(`启动：${cleanAppDisplayLabel(globalFavorite.label)}`)
            return
          }
          if (!globalFavorite) {
            const action = entry.target.slice('quick-'.length) as GlobalQuickAction
            if (action === 'computer') addItem('folder', '此电脑', 'shell:MyComputerFolder')
            else if (action === 'navigator') setSpaceNavigatorOpen(true)
            else if (action === 'todo') addTodoCard()
            else addItem(action === 'web' ? 'video' : action)
            return
          }
          focusEntry(ROOT_ID, entry)
          return
        }
        if (section === 'current') setActiveFixedTarget(entry.target)
        focusEntry(canvasId, entry)
      }}
      onDoubleClick={(event) => {
        if (section !== 'current') return
        event.preventDefault()
        event.stopPropagation()
        const item = itemsRef.current.find((candidate) => candidate.id === entry.target)
        if (item?.kind === 'workspace' && item.childCanvasId) emphasizeCanvas(item.childCanvasId)
        else if (item) emphasizeNavigatorItem(item)
      }}
      onContextMenu={(event) => {
        if (section !== 'global' || !globalFavorite) return
        event.preventDefault()
        event.stopPropagation()
        setActiveGlobalFixedTarget(entry.target)
        setChipQuickMenu({ x: event.clientX, y: event.clientY, target: entry.target, index })
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (section === 'global') {
          setActiveGlobalFixedTarget(entry.target)
          if (globalFavorite) focusEntry(ROOT_ID, entry)
          else {
            const action = entry.target.slice('quick-'.length) as GlobalQuickAction
            if (action === 'computer') addItem('folder', '此电脑', 'shell:MyComputerFolder')
            else if (action === 'navigator') setSpaceNavigatorOpen(true)
            else if (action === 'todo') addTodoCard()
            else addItem(action === 'web' ? 'video' : action)
          }
          return
        }
        if (section === 'current') setActiveFixedTarget(entry.target)
        focusEntry(canvasId, entry)
      }}
    ><span className={`entry-icon ${entry.tone}`}><FixedEntryIcon entry={entry} item={itemById.get(entry.target)}/></span>{isRenaming ? <input
      className="fixed-entry-rename"
      autoFocus
      value={renamingGlobalFavorite.draft}
      maxLength={120}
      aria-label={`修改 ${entry.label} 的显示名`}
      title="只修改收藏显示名，不会修改硬盘上的真实文件名"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setRenamingGlobalFavorite({ target: entry.target, draft: event.target.value })}
      onBlur={() => {
        if (cancelGlobalFavoriteRenameRef.current === entry.target) {
          cancelGlobalFavoriteRenameRef.current = ''
          setRenamingGlobalFavorite(null)
          return
        }
        commitGlobalFavoriteRename(entry.target, renamingGlobalFavorite.draft)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') { event.preventDefault(); commitGlobalFavoriteRename(entry.target, renamingGlobalFavorite.draft) }
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelGlobalFavoriteRenameRef.current = entry.target
          setRenamingGlobalFavorite(null)
        }
      }}
    /> : slotShortcut ? <span
      className="entry-label-stack"
      title={`快捷键 ${slotShortcut} · 右键「改快捷键」可修改；Backspace 清空`}
    ><b>{entry.sourceKind === 'app' ? cleanAppDisplayLabel(entry.label) : entry.label}</b>{rebindingSlot === index ? <input
      className="entry-shortcut-edit"
      autoFocus
      readOnly
      value=""
      placeholder="按新键…"
      aria-label="按下新的快捷键"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => setRebindingSlot(null)}
      onKeyDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { setRebindingSlot(null); return }
        const slotId = `quick.slot${index + 1}` as ShortcutId
        const current: ShortcutBindings = { ...DEFAULT_SHORTCUT_BINDINGS, ...(settingsRef.current.shortcutBindings ?? {}) }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          updateGlobalSettings({ shortcutBindings: { ...current, [slotId]: '' } })
          setRebindingSlot(null)
          setToast(`第 ${index + 1} 位的快捷键已清空`)
          return
        }
        const binding = bindingFromKeyboardEvent(event.nativeEvent)
        if (!binding) return
        const problem = shortcutBindingProblem(binding)
        if (problem) { setToast(problem); return }
        const occupant = SHORTCUT_DEFINITIONS.find((candidate) => candidate.id !== slotId && current[candidate.id] === binding)?.id
        const next: ShortcutBindings = { ...current, [slotId]: binding }
        if (occupant) next[occupant] = ''
        updateGlobalSettings({ shortcutBindings: next })
        setRebindingSlot(null)
        setToast(occupant ? `第 ${index + 1} 位已改为 ${binding}，原占用的快捷键已自动清空` : `第 ${index + 1} 位快捷键已设为 ${binding}`)
      }}
    /> : <small className="entry-shortcut">{slotShortcut}</small>}</span> : <b>{entry.sourceKind === 'app' ? cleanAppDisplayLabel(entry.label) : entry.label}</b>}{globalFavorite ? <button
      className="fixed-entry-remove"
      type="button"
      title="移除收藏入口（不会删除硬盘上的文件或文件夹）"
      aria-label={`移除收藏入口 ${entry.label}`}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); setPendingGlobalFavoriteRemoval(globalFavorite) }}
    >{uiIcon('close', 12)}</button> : section === 'current' ? <button
      className="fixed-entry-remove"
      type="button"
      title="从当前画布常用里移除（不会删除画布元素）"
      aria-label={`从当前画布常用里移除 ${entry.label}`}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); removeCurrentFixedEntry(canvasId, entry.target) }}
    >{uiIcon('close', 12)}</button> : null}</div>
  }

  const beginWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (windowAppearance !== 'borderless' || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button,input,[contenteditable],a')) return
    windowDragRef.current = { x: event.clientX, y: event.clientY }
  }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = windowDragRef.current
      if (!start) return
      if (!(event.buttons & 1)) { windowDragRef.current = null; return }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return
      windowDragRef.current = null
      // The host only posts an app message here. The modal system move loop is
      // entered later from MainWindowProc, never inside the WebView2 callback.
      window.chrome?.webview?.postMessage({ type: 'native-window-drag' })
    }
    const end = () => { windowDragRef.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])

  const toggleSystemWindowMaximize = () => window.chrome?.webview?.postMessage({ type: 'native-window-toggle-maximize' })
  const handleWindowDragDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (windowAppearance !== 'borderless') return
    const target = event.target as HTMLElement
    if (target.closest('button,input,[contenteditable],a')) return
    toggleSystemWindowMaximize()
  }

  const beginTopbarWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, label, .brand, .workspace-tab, .window-controls')) return
    beginWindowDrag(event)
  }

  const handleTopbarWindowDragDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, label, .brand, .workspace-tab, .window-controls')) return
    handleWindowDragDoubleClick(event)
  }

  // 画布「打包到目录」：把选中卡片引用的真实文件收进用户指定的目录。
  // 有磁盘路径的直接拷；剪贴板粘贴/截图的图片先交给原生物化成 PNG 再拷，
  // 所以打包结果永远是真实文件（不是引用、不是压缩包）。
  const collectSelection = useCallback((list: CanvasItem[]) => {
    const paths: string[] = []
    const images: string[] = []
    const names: string[] = []
    let skipped = 0
    for (const entry of list) {
      const source = typeof entry.source === 'string' ? entry.source : ''
      const isRealPath = Boolean(source) && !source.startsWith('http') && !source.startsWith('shell:') && !source.startsWith('::')
      if (isRealPath && entry.kind !== 'note') {
        paths.push(source)
        continue
      }
      if (entry.kind === 'image' && entry.dataUrl) {
        images.push(entry.dataUrl)
        names.push(entry.title || '掌中界图片')
        continue
      }
      skipped += 1
    }
    if (!paths.length && !images.length) {
      setToast('所选项目里没有可以打包的真实文件——网页卡、便签、暂存卡暂时不参与打包')
      return
    }
    const bridge = window.chrome?.webview
    if (!bridge) {
      setToast('打包需要桌面端环境')
      return
    }
    bridge.postMessage({ type: 'native-collect-items', paths, images, names, selectedCount: list.length, skipped })
    setToast(skipped
      ? `正在打包 ${paths.length + images.length} 项到指定目录（跳过的 ${skipped} 项没有真实文件）`
      : `正在打包 ${paths.length + images.length} 项到指定目录…`)
  }, [])
  contextualShortcutRef.current = (id) => {
    const selected = itemsRef.current.filter((entry) => selectedIdsRef.current.includes(entry.id) && entry.canvasId === activeCanvasRef.current)
    const primary = selected.at(-1)
    if (id === 'selection.duplicate' && selected.length) {
      const stamp = Date.now()
      duplicateItems(selected, selected.map((entry, index) => `${entry.kind}-${stamp}-${index}`))
      return true
    }
    if (id === 'selection.collect' && selected.length) { collectSelection(selected); return true }
    if (id === 'selection.pin' && primary) { togglePin(primary.canvasId, primary); return true }
    if (id === 'selection.layout' && selected.length >= 2) { arrangeSelection('grid'); return true }
    if (id === 'selection.ratio' && selected.length) { setRatioAnchor({ left: window.innerWidth / 2, top: window.innerHeight / 2 }); return true }
    if (id === 'canvas.spawn') {
      const canvas = spacesRef.current.find((entry) => entry.id === activeCanvasRef.current)
      if (!canvas) return false
      setAnchor(canvas.id, (window.innerWidth / 2 - canvas.viewport.x) / canvas.viewport.scale, (window.innerHeight / 2 - canvas.viewport.y) / canvas.viewport.scale)
      return true
    }
    if (id === 'browser.bookmark' && contextItem && (contextItem.kind === 'web' || contextItem.kind === 'video')) { saveCurrentWebBookmark(); return true }
    return false
  }

  return <main className={`app context-${contextKind}`} data-theme={resolvedTheme} data-window-appearance={windowAppearance} data-window-material={windowMaterial === 'mica' && materialSupported === true ? 'mica' : 'solid'} data-toolbar-visibility={toolbarVisibility}>
    {toolbarVisibility === 'auto' ? <div
      className="chrome-hot-zone"
      style={{ top: windowMaximized ? 0 : 4, height: windowMaximized ? 12 : 8 }}
      onPointerEnter={() => { setChromePointerInside(true); revealChrome() }}
      aria-hidden="true"
    /> : null}
    <header
      ref={chromeRef}
      className={`app-chrome ${toolbarVisibility === 'auto' ? 'is-auto' : ''} ${chromeVisible ? 'is-visible' : 'is-hidden'} ${canvasDragNearTop ? 'is-drop-approach' : ''}`}
      onPointerEnter={() => { setChromePointerInside(true); revealChrome() }}
      onPointerLeave={() => setChromePointerInside(false)}
      onFocusCapture={() => { setChromeFocusInside(true); revealChrome() }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChromeFocusInside(false)
      }}
    >
      <div className="topbar window-drag-region" onPointerDown={beginTopbarWindowDrag} onDoubleClick={handleTopbarWindowDragDoubleClick}>
        <div className="brand window-drag-region" onPointerDown={beginWindowDrag} onDoubleClick={handleWindowDragDoubleClick}><span className="brand-mark">C</span><strong>掌中界</strong></div>
        <div className="workspace-tab window-drag-region" onPointerDown={beginWindowDrag} onDoubleClick={handleWindowDragDoubleClick}><span>▰</span><EditableCanvasTitle canvas={rootCanvas} onRename={renameCanvas}/><em className={isDirty ? 'dirty' : ''}>{isDirty ? '未保存' : '已保存'}</em><button disabled title="多工作区功能开发中">{uiIcon('close', 13)}</button></div>
        <button className="icon-button add-tab" disabled={activeCanvas.level >= MAX_CANVAS_LEVEL} title={activeCanvas.level >= MAX_CANVAS_LEVEL ? '已达最深层，不能再新建子画布' : '在当前项目中新建画布'} onClick={createEmptyCanvas}>{uiIcon('plus', 17)}</button>
        <div className="global-search">
          <div className="global-search-modes" role="tablist" aria-label="搜索模式">
            <button type="button" role="tab" aria-selected={searchMode === 'url'} className={searchMode === 'url' ? 'selected' : ''} onClick={() => { setSearchMode('url'); searchRef.current?.focus() }}>网址</button>
            <button type="button" role="tab" aria-selected={searchMode === 'disk'} className={searchMode === 'disk' ? 'selected' : ''} onClick={() => { setSearchMode('disk'); searchRef.current?.focus() }}>磁盘搜索</button>
            <button type="button" role="tab" aria-selected={searchMode === 'hermes'} className={searchMode === 'hermes' ? 'selected' : ''} onClick={() => { setSearchMode('hermes'); searchRef.current?.focus() }}>问 Hermes</button>
          </div>
          <label className="global-search-input">{uiIcon('search', 16)}<input ref={searchRef} value={searchValue} onChange={(event) => setSearchValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitGlobalInput() }} placeholder={searchMode === 'url' ? '输入网址，例如 bilibili.com' : searchMode === 'disk' ? '输入文件或文件夹关键词' : '问 Hermes 任何问题，回车发送'}/><kbd>{shortcutDisplay(shortcutBindings, 'app.search')}</kbd></label>
        </div>
        <button
          type="button"
          className={'icon-button navigator-toggle' + (spaceNavigatorOpen ? ' is-open' : '')}
          title={`空间导航器：${spaceNavigatorOpen ? '已显示' : '已隐藏'}（${shortcutDisplay(settingsRef.current.shortcutBindings, 'canvas.toggleNavigator')}） · 鼠标当前：${activeCanvas.title} L${activeCanvas.level}/${MAX_CANVAS_LEVEL}`}
          aria-label="显示或隐藏空间导航器"
          aria-pressed={spaceNavigatorOpen}
          onClick={() => setSpaceNavigatorOpen((current) => !current)}
        >{uiIcon('sidebar', 17)}</button>
        {imageActionMenu ? createPortal(<>
      <div className="bar-quick-menu-layer" onClick={() => setImageActionMenu(null)} onContextMenu={(event) => { event.preventDefault(); setImageActionMenu(null) }}/>
      <CanvasMenu x={imageActionMenu.x} y={imageActionMenu.y} onPointerDown={(event) => event.stopPropagation()}>
        <div className="canvas-menu-title">这张图怎么处理</div>
        <button role="menuitem" onClick={() => { const target = imageActionMenu; setImageActionMenu(null); if (target.item) askHermesAboutItemImage(target.item, { x: target.x, y: target.y }); else if (target.path) askHermesAboutImage(target.path, { x: target.x, y: target.y }) }}>{uiIcon('eye', 14)}<span>让 Hermes 读图（理解 · 更准 · 花额度）</span></button>
        <button role="menuitem" onClick={() => { const target = imageActionMenu; setImageActionMenu(null); if (target.item) ocrItemImage(target.item, { x: target.x, y: target.y }); else if (target.path) ocrImage(target.path, { x: target.x, y: target.y }) }}>{uiIcon('document', 14)}<span>OCR 取字（本地 · 离线 · 不花额度）</span></button>
      </CanvasMenu>
    </>, previewOverlayRoot()) : null}
    {hermesPanel ? createPortal(<div className="bar-quick-menu-layer" onClick={() => setHermesPanel(null)}>
          <div className="hermes-panel" role="dialog" aria-label="Hermes 回答" style={{ position: 'fixed', left: Math.min(hermesPanel.x, window.innerWidth - 480), top: Math.min(hermesPanel.y, window.innerHeight - 260) }} onClick={(event) => event.stopPropagation()} onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const paths = attachDroppedFiles(event); if (paths.length) { setHermesPanel((current) => current ? { ...current, attachments: [...new Set([...(current.attachments || []), ...paths])] } : current); setToast('已加入参考图，点「带图再问」重新回答') } }}>
            <header><span><b>{hermesPanel.origin === 'ocr' ? '本地 OCR' : 'Hermes'}</b> · {hermesPanel.question.slice(0, 42)}</span><button type="button" className="pick-close" title="关闭" onClick={() => setHermesPanel(null)}>{uiIcon('close', 12)}</button></header>
            {hermesPanel.attachments?.length ? <div className="hermes-attachments">{hermesPanel.attachments.map((path) => <span key={path} title={path}>{uiIcon('eye', 11)}{baseName(path)}</span>)}</div> : null}
            {hermesPanel.status === 'loading' ? <p className="hermes-status">{hermesPanel.origin === 'ocr' ? '正在用系统 OCR 识别…（离线，通常一秒内）' : 'Hermes 正在思考…（首次启动约 3~5 秒）'}</p> : hermesPanel.status === 'error' ? <p className="hermes-status is-error">{hermesPanel.error}</p> : <pre className="hermes-answer">{hermesPanel.answer}</pre>}
            <footer>
              {hermesPanel.origin !== 'ocr' && hermesPanel.attachments?.length && hermesPanel.status !== 'loading' ? <button type="button" className="hermes-reask" onClick={() => reaskHermesWithImage(hermesPanel.attachments![0])}>带图再问</button> : null}
              {hermesPanel.status === 'done' ? <>
                <button type="button" onClick={() => { navigator.clipboard?.writeText(hermesPanel.answer || '').catch(() => {}); setToast('已复制 Hermes 的回答') }}>{uiIcon('copy', 12)}<span>复制</span></button>
                <button type="button" onClick={() => { const id = addItem('note', 'Hermes 回答'); if (id) setItems((current) => current.map((it) => it.id === id ? { ...it, text: `问：${hermesPanel.question}\n\n${hermesPanel.answer}` } : it)); setHermesPanel(null); setToast('已把回答存为画布便签') }}>{uiIcon('plus', 12)}<span>存为便签</span></button>
              </> : null}
            </footer>
          </div>
        </div>, previewOverlayRoot()) : null}
        {createPortal(<div
          className="pet-root"
          style={petAnchor ? { left: petAnchor.x, top: petAnchor.y, right: 'auto', bottom: 'auto' } : undefined}
          onPointerDown={(event) => {
            event.stopPropagation()
            if (event.button !== 2) return
            if ((event.target as HTMLElement).closest('.pet-avatar')) return
            beginPetDrag(event)
          }}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseMove={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => { event.stopPropagation(); event.preventDefault() }}
          onWheel={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (Date.now() - petDragRecentRef.current < 400) return
            setPetMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          {petOpen ? <section className="pet-panel" role="dialog" aria-label="Hermes 桌宠" onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const paths = attachDroppedFiles(event); if (paths.length) { setPetAttachments((list) => [...new Set([...list, ...paths])]); setToast(`已加入 ${paths.length} 个参考`) } }}>
            <header
              onPointerDown={(event) => {
                if (event.button !== 0) return
                if ((event.target as HTMLElement).closest('button')) return
                event.stopPropagation()
                beginPetDrag(event)
              }}
            >
              <span className="pet-mini"><svg className="pet-face" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="8.5" width="14" height="9.5" rx="3"/><path d="M12 8.5V5.8"/><circle cx="12" cy="4.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.4" cy="13" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.6" cy="13" r="1.05" fill="currentColor" stroke="none"/><path d="M9.6 15.6h4.8"/></svg></span>
              <b>Hermes 桌宠</b>
              <small>{petBusy ? '执行中…' : '在线 · 有记忆'}</small>
              {petMessages.length ? <button type="button" title="清空对话框（对话记忆保留）" onClick={() => { setPetMessages([]); setToast('已清屏；说“忘掉之前的对话”可以让它重置记忆') }}>{uiIcon('trash', 12)}</button> : null}
              <button type="button" title="收起" onClick={() => setPetOpen(false)}>{uiIcon('close', 12)}</button>
            </header>
            <div className="pet-ref">
              <small>它现在能看到：</small>
              {items.filter((entry) => selectedIds.includes(entry.id)).map((entry) => <span key={entry.id} className="pet-ref-chip" title={typeof entry.source === 'string' ? entry.source : ''}>{uiIcon('pin', 10)}{(entry.title || '未命名').slice(0, 14)}{typeof entry.source === 'string' && entry.source ? ` · ${baseName(entry.source).slice(0, 14)}` : ''}</span>)}
              {!selectedIds.length ? <i>在画布上点选卡片，这里就会显示它</i> : null}
            </div>
            <div className="pet-log" ref={petLogRef}>
              {!petMessages.length && !petBusy ? <p className="pet-hello">嗨，我是你的 Hermes。<br/>我不止会聊——<b>整理文件、看截图、开软件、动手做图</b>都行。<br/><b>在画布上点选一张卡片，我就知道你说的是哪个</b>（不用打字描述）；图片直接拖进来也行。</p> : null}
              {petMessages.map((message, index) => <div key={index} className={`pet-msg ${message.role}`}>
                {message.image ? <span className="pet-msg-ref">{uiIcon('eye', 11)}{baseName(message.image)}</span> : null}
                <pre>{message.text}</pre>
                {message.role === 'pet' ? <button type="button" className="pet-copy" title="复制这条回复（也可以直接拖选文字）" onClick={() => { navigator.clipboard?.writeText(message.text).catch(() => {}); setToast('已复制这条回复') }}>{uiIcon('copy', 10)}复制</button> : null}
              </div>)}
              {petBusy ? <div className="pet-msg pet"><pre className="pet-typing">正在执行…（动手可能要 10~60 秒）</pre></div> : null}
            </div>
            {petAttachments.length ? <div className="pet-attachments">{petAttachments.map((path) => <span key={path} title={path}>{uiIcon('eye', 11)}<i>{baseName(path)}</i><button type="button" title="移除" onClick={() => setPetAttachments((list) => list.filter((item) => item !== path))}>{uiIcon('close', 10)}</button></span>)}</div> : null}
            <footer>
              <textarea rows={1} value={petInput} placeholder={petBusy ? '执行中…' : '和桌宠说点什么（Enter 发送）'} onChange={(event) => setPetInput(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPetMessage(petInput) } }} />
              <button type="button" className="primary" disabled={petBusy || !petInput.trim()} onClick={() => sendPetMessage(petInput)}>{uiIcon('plus', 12)}<span>发送</span></button>
            </footer>
          </section> : null}
          {petMenu ? <div className="bar-quick-menu-layer" onClick={() => setPetMenu(null)} onContextMenu={(event) => { event.preventDefault(); setPetMenu(null) }}>
            <div className="bar-quick-menu" style={{ left: Math.min(petMenu.x, window.innerWidth - 290), top: Math.min(petMenu.y, window.innerHeight - 170) }} onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={() => { setPetMenu(null); setPetModelDraft(petModel); setPetModelPanel(true) }}>{uiIcon('settings', 13)}<span>选择模型…（当前 {petModel || '默认'}）</span></button>
              <button type="button" onClick={() => { setPetMenu(null); setPetMessages([]); setToast('对话记录已清屏（记忆保留）') }}>{uiIcon('trash', 13)}<span>清空对话记录</span></button>
              <button type="button" onClick={() => { setPetMenu(null); const root = document.querySelector('.pet-root') as HTMLElement | null; if (root) { root.style.left = ''; root.style.top = ''; root.style.right = ''; root.style.bottom = '' } setPetAnchor(null); setToast('桌宠已回到默认位置') }}>{uiIcon('pin', 13)}<span>回到默认位置</span></button>
            </div>
          </div> : null}
          {petModelPanel ? <div className="bar-quick-menu-layer" onClick={() => setPetModelPanel(false)} onContextMenu={(event) => { event.preventDefault(); setPetModelPanel(false) }}>
            <div className="pet-model-panel" onClick={(event) => event.stopPropagation()}>
              <b>桌宠用哪个模型</b>
              {[{ value: '', label: '默认（跟 Hermes 配置）' }, { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' }, { value: 'deepseek-chat', label: 'deepseek-chat' }, { value: 'deepseek-reasoner', label: 'deepseek-reasoner' }].map((option) => <button type="button" key={option.value || 'default'} className={petModel === option.value ? 'active' : ''} onClick={() => applyPetModel(option.value)}>{petModel === option.value ? '✓ ' : ''}{option.label}</button>)}
              <div className="pet-model-custom">
                <input value={petModelDraft} placeholder="或输入自定义模型名…" onChange={(event) => setPetModelDraft(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') applyPetModel(petModelDraft.trim()) }} />
                <button type="button" onClick={() => applyPetModel(petModelDraft.trim())}>用这个</button>
              </div>
              <small>模型名由你的 Hermes 提供方决定；名字填错会执行失败，可随时切回「默认」。</small>
            </div>
          </div> : null}
          <button
            type="button"
            className={`pet-avatar ${petBusy ? 'is-busy' : ''} ${petOpen ? 'is-open' : ''}`}
            title={selectedIds.length ? `Hermes 桌宠：已能看到你选中的 ${selectedIds.length} 个元素 · 双击开合对话 · 按住拖动 · 右键设置` : 'Hermes 桌宠：双击开合对话 · 按住拖动 · 右键设置（模型等）'}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.stopPropagation()
              beginPetDrag(event)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              if (Date.now() - petDragRecentRef.current < 400) return
              setPetOpen((value) => !value)
            }}
          ><svg className="pet-face" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="8.5" width="14" height="9.5" rx="3"/><path d="M12 8.5V5.8"/><circle cx="12" cy="4.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.4" cy="13" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.6" cy="13" r="1.05" fill="currentColor" stroke="none"/><path d="M9.6 15.6h4.8"/></svg><i className="pet-dot"/></button>
        </div>, document.body)}
        <button className="top-action" onClick={(event) => { const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setSaveMenu(saveMenu ? null : { left: Math.max(12, rect.right - 210), top: rect.bottom + 6 }) }} title="保存：保存当前的画布 / 保存画布为模板">{uiIcon('save', 17)} 保存</button>
        <button className={`top-action ${showTemplates ? 'active-tool' : ''}`} onClick={openTemplates} title="选择模板：工作 / 娱乐 一键开工（原来是右键菜单里那一项）">{uiIcon('grid', 17)} 模板</button>
        <button className={`top-action ${showRecentProjects ? 'active-tool' : ''}`} onClick={() => setShowRecentProjects((value) => !value)}>{uiIcon('clock', 17)} 最近使用</button>
        <button className="top-action" title={`截图工具（微信式：框选后能标注/长截图/取色，用完即走）· ${shortcutDisplay(shortcutBindings, 'capture.wechatTool') || '未设置快捷键'}`} onClick={() => window.chrome?.webview?.postMessage({ type: 'native-run-tool', tool: 'screencapture' })}>{uiIcon('image', 17)} 截图</button>
        <button className="icon-button" title={`设置（${shortcutDisplay(shortcutBindings, 'app.settings')}）`} onClick={() => setShowSettings(true)}>{uiIcon('settings', 18)}</button>
        <div className="window-controls" aria-label="窗口控制"><button title="最小化" onClick={() => window.chrome?.webview?.postMessage({ type: 'native-window-minimize' })}>—</button><button title={windowMaximized ? '还原' : '最大化'} onClick={toggleSystemWindowMaximize}>{uiIcon(windowMaximized ? 'restore' : 'fullscreen', 15)}</button><button className="window-close" title="关闭" onClick={() => window.chrome?.webview?.postMessage({ type: 'native-window-close' })}>{uiIcon('close', 15)}</button></div>
      </div>
      <div className="fixedbar fixedbar-v6">
        <section className="fixed-section global-fixed-section" onContextMenu={(event) => { event.preventDefault(); setBarQuickMenu({ x: event.clientX, y: event.clientY }) }}><span>全局常用</span><div className="fixed-entries global-fixed-groups" onWheel={stopWheelPropagation}>
          <div className="global-fixed-group global-quick-group" aria-label="生成入口"><FixedSegmentTrack indicatedTarget={globalQuickEntries.some((entry) => entry.target === indicatedGlobalFixedTarget) ? indicatedGlobalFixedTarget : null} layoutKey={globalQuickEntries.map((entry) => `${entry.target}:${entry.label}`).join('|')}>{globalQuickEntries.map((entry, index) => renderFixedEntry(entry, 'global', index, ROOT_ID))}</FixedSegmentTrack></div>
          {globalFavoriteFixedEntries.length ? <><i className="global-favorite-divider" aria-hidden="true"/><div className="global-fixed-group global-favorite-group" aria-label="收藏入口" onWheel={(event) => { event.stopPropagation(); const step = (event.deltaY || event.deltaX) > 0 ? 1 : -1; setGlobalFavoritesPage((page) => Math.max(0, Math.min(globalFavoritesPageMax, Math.min(page, globalFavoritesPageMax) + step))) }}><FixedSegmentTrack indicatedTarget={globalFavoriteFixedEntries.some((entry) => entry.target === indicatedGlobalFixedTarget) ? indicatedGlobalFixedTarget : null} layoutKey={globalFavoritePageEntries.map((entry) => `${entry.target}:${entry.label}`).join('|')}>{currentFixedEntries.map((entry, index) => { const slotBinding = shortcutBindings[`quick.slot${index + 1}` as ShortcutId]; return renderFixedEntry(entry, 'current', index, activeCanvas.id, slotBinding || undefined) })}</FixedSegmentTrack>{globalFavoritesPageMax > 0 ? <i className="global-page-indicator">{globalFavoritesPageClamped + 1}/{globalFavoritesPageMax + 1}</i> : null}</div></> : null}
          {favoriteDropGhost ? <span className="fixed-entry fixed-entry-ghost" title="松手就把它收进「全局常用」">
            <FixedEntryIcon entry={{ icon: 'star', label: favoriteDropGhost.label, target: 'drop-ghost', tone: 'blue', sourceKind: favoriteDropGhost.kind === 'folder' ? 'folder' : favoriteDropGhost.kind === 'icon' || favoriteDropGhost.kind === 'app' ? 'app' : 'file' }}/>
            <b>{favoriteDropGhost.label}</b><i>松手加入</i>
          </span> : null}
        </div></section>
        {createPortal(<>
          {saveTemplatePrompt ? <div className="bar-quick-menu-layer" onClick={() => setSaveTemplatePrompt(null)} onContextMenu={(event) => { event.preventDefault(); setSaveTemplatePrompt(null) }}>
            <div className="bar-quick-menu" style={{ left: Math.round(window.innerWidth / 2 - 150), top: 96 }} onClick={(event) => event.stopPropagation()}>
              <b style={{ display: 'block', padding: '4px 10px 2px', fontSize: 12.5 }}>保存画布为模板</b>
              <small style={{ display: 'block', padding: '0 10px 8px', color: 'var(--dim)', fontSize: 11, lineHeight: 1.5 }}>{saveTemplatePrompt.name ? `这张画布是从模板「${saveTemplatePrompt.name}」开的 · 可以改个名字另存` : '给这张画布起个模板名，下次一键开工'}</small>
              <input autoFocus value={saveTemplateName} onChange={(event) => setSaveTemplateName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { const target = (saveTemplateName || saveTemplatePrompt.freshName).trim() || saveTemplatePrompt.freshName; openGalleryAfterSaveRef.current = true; setSaveTemplatePrompt(null); saveCurrentAsTemplate(target) } if (event.key === 'Escape') setSaveTemplatePrompt(null) }} placeholder="模板名字" style={{ margin: '0 10px 8px', width: 'calc(100% - 20px)', padding: '6px 9px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12.5 }} />
              {saveTemplatePrompt.name ? <button onClick={() => { overwriteTemplateRef.current = true; openGalleryAfterSaveRef.current = false; setSaveTemplatePrompt(null); saveCurrentAsTemplate(saveTemplatePrompt.name) }}>{uiIcon('save', 14)}<span>覆盖更新「{saveTemplatePrompt.name}」</span></button> : null}
              <button onClick={() => { const target = (saveTemplateName || saveTemplatePrompt.freshName).trim() || saveTemplatePrompt.freshName; openGalleryAfterSaveRef.current = true; setSaveTemplatePrompt(null); saveCurrentAsTemplate(target) }}>{uiIcon('save', 14)}<span>{saveTemplatePrompt.name ? `另存为新模板「${(saveTemplateName || saveTemplatePrompt.freshName).trim() || saveTemplatePrompt.freshName}」` : `保存为模板「${(saveTemplateName || saveTemplatePrompt.freshName).trim() || saveTemplatePrompt.freshName}」`}</span></button>
              <button onClick={() => setSaveTemplatePrompt(null)}>{uiIcon('close', 14)}<span>取消</span></button>
            </div>
          </div> : null}
          {barQuickMenu ? <div className="bar-quick-menu-layer" onClick={() => setBarQuickMenu(null)} onContextMenu={(event) => { event.preventDefault(); setBarQuickMenu(null) }}>
            <div className="bar-quick-menu" style={{ left: Math.min(barQuickMenu.x, window.innerWidth - 270), top: Math.min(barQuickMenu.y, window.innerHeight - 110) }} onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={() => { const at = barQuickMenu; setBarQuickMenu(null); openDesktopAppPicker({ x: at.x, y: at.y }) }}>{uiIcon('settings', 13)}<span>添加应用（桌面快捷方式）…</span></button>
              <button type="button" onClick={() => { setBarQuickMenu(null); pickAppFromDiskToFavorites() }}>{uiIcon('folder', 13)}<span>从磁盘选择程序…</span></button>
            </div>
          </div> : null}
          {chipQuickMenu ? <div className="bar-quick-menu-layer" onClick={() => setChipQuickMenu(null)} onContextMenu={(event) => { event.preventDefault(); setChipQuickMenu(null) }}>
            <div className="bar-quick-menu" style={{ left: Math.min(chipQuickMenu.x, window.innerWidth - 300), top: Math.min(chipQuickMenu.y, window.innerHeight - 170) }} onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={() => { const fav = globalFavorites.find((favorite) => favorite.id === chipQuickMenu.target); setChipQuickMenu(null); if (!fav) return; setActiveGlobalFixedTarget(fav.id); cancelGlobalFavoriteRenameRef.current = ''; setRenamingGlobalFavorite({ target: fav.id, draft: fav.sourceKind === 'app' ? cleanAppDisplayLabel(fav.label) : fav.label }) }}>{uiIcon('rename', 13)}<span>重命名（只改显示名，不动文件）</span></button>
              <button type="button" onClick={() => { setRebindingSlot(chipQuickMenu.index); setChipQuickMenu(null) }}>{uiIcon('settings', 13)}<span>改快捷键…</span></button>
              <button type="button" onClick={() => { const fav = globalFavorites.find((favorite) => favorite.id === chipQuickMenu.target); setChipQuickMenu(null); if (fav) setPendingGlobalFavoriteRemoval(fav) }}>{uiIcon('close', 13)}<span>从此栏移除</span></button>
            </div>
          </div> : null}
          {desktopShortcutPicker ? <div className="bar-quick-menu-layer" onClick={() => setDesktopShortcutPicker(null)}>
            <div className="desktop-app-picker" role="dialog" aria-label="添加应用" style={{ left: Math.min(desktopShortcutPicker.x, window.innerWidth - 320), top: Math.min(desktopShortcutPicker.y, window.innerHeight - 420) }} onClick={(event) => event.stopPropagation()}>
              <header><span>{desktopShortcutPicker.loading ? '正在列出桌面快捷方式…' : '选择要固定的应用'}</span><button type="button" className="pick-close" title="关闭" onClick={() => setDesktopShortcutPicker(null)}>{uiIcon('close', 12)}</button></header>
              {desktopShortcutPicker.loading ? null : desktopShortcutPicker.items.length ? desktopShortcutPicker.items.map((item) => <button type="button" className="pick-item" key={item.path} title={item.path} onClick={() => { addGlobalFavorite(item.path, 'app', item.name, item.image); setDesktopShortcutPicker(null) }}>{item.image ? <img src={item.image} alt=""/> : <span className="pick-icon-fallback">{uiIcon('settings', 16)}</span>}<span>{item.name}</span></button>) : <p className="pick-empty">桌面（含公共桌面）里没有找到 .lnk / .exe / .url 快捷方式</p>}
              <footer><button type="button" className="pick-browse" onClick={() => pickAppFromDiskToFavorites()}>{uiIcon('folder', 13)}<span>从磁盘选择…</span></button></footer>
            </div>
          </div> : null}
        </>, previewOverlayRoot())}
        
        
        <button className="fixed-entry new-canvas" disabled={activeCanvas.level >= MAX_CANVAS_LEVEL} title={activeCanvas.level >= MAX_CANVAS_LEVEL ? '已达最深层，不能再嵌套' : '在当前画布可见中心新建一个空子画布'} onClick={createEmptyCanvas}><span className="entry-icon canvas-new">{uiIcon('grid', 13)}</span><b>＋ 新建画布</b></button>
        
        <span className={`save-state ${isDirty ? 'dirty' : ''}`} role="button" tabIndex={0} title="点一下选：保存当前的画布 / 保存画布为模板" onClick={(event) => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); setSaveMenu(saveMenu ? null : { left: Math.max(12, rect.right - 210), top: rect.bottom + 6 }) }}><i/>{isDirty ? '未保存' : '已保存'}</span>
        {saveMenu ? <div onClick={() => setSaveMenu(null)} onContextMenu={(event) => { event.preventDefault(); setSaveMenu(null) }} style={{ position: 'fixed', inset: 0, zIndex: 260 }}>
          <div onClick={(event) => event.stopPropagation()} style={{ position: 'absolute', left: saveMenu.left, top: saveMenu.top, minWidth: 210, padding: 4, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--card)', boxShadow: '0 12px 32px rgba(0,0,0,.28)' }}>
            <button type="button" role="menuitem" onClick={() => { setSaveMenu(null); saveDocument() }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, background: 'transparent', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>{uiIcon('save', 14)}<span>保存当前的画布</span><em style={{ marginLeft: 'auto', fontStyle: 'normal', fontSize: 11, opacity: .55 }}>Ctrl+S</em></button>
            <button type="button" role="menuitem" onClick={() => { setSaveMenu(null); saveCanvasAsTemplateQuick() }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', borderRadius: 8, background: 'transparent', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>{uiIcon('copy', 14)}<span>保存画布为模板</span></button>
          </div>
        </div> : null}
      </div>
            {/* 上下文工具条（按用户要求固定）：永远只显示画布工具那一套。
          以前选中网页卡会整条换成「后退/前进/刷新/收藏」，选中文件卡会换成「此电脑 › 路径 / 超级预览」，
          用户明确不要这个「打开一张卡、这条栏就变」的行为（2026-09-13 原话：把这个功能删掉就行 还有网页的）。
          网页卡自己的地址行仍在（后退/前进/刷新/网址/收藏），文件卡的后退/向上等在卡片右键菜单里。 */}
      <div className="global-contextbar mode-canvas">
        <button onClick={() => void pasteFromClipboard()}>{uiIcon('paste', 16)}<span>从剪贴板添加</span></button>
        <button onClick={organizeByType} title={`按类型归堆，只移动位置（${shortcutDisplay(shortcutBindings, 'canvas.organize')}）`}>{uiIcon('grid', 16)}<span>整理</span></button>
        <button onClick={() => sameCanvasSelectionCount >= 2 ? arrangeSelection('grid') : setToast('请先框选两个或更多元素')} title="分屏式布局，会调整选中窗口的尺寸">{uiIcon('split', 16)}<span>布局</span></button>
        <button ref={ratioToggleRef} className={showRatioPicker ? 'active-tool' : ''} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setRatioAnchor(showRatioPicker ? null : { left: rect.left, top: rect.bottom + 8 }) }}>{uiIcon('split', 16)}<span>比例</span></button>
      </div>
    </header>

    {showRecentProjects ? <div className="recent-projects-popover" role="menu" aria-label="最近项目" onWheel={stopWheelPropagation}>
      <header><b>项目</b><button onClick={() => setShowRecentProjects(false)}>{uiIcon('close', 14)}</button></header>
      <button onClick={() => requestOpenProject()}>{uiIcon('file', 15)}<span>打开 .zzj 项目…</span></button>
      <button onClick={() => requestOpenProject(undefined, false, '打开旧版 .zzj 项目文件夹', true)}>{uiIcon('folder', 15)}<span>打开旧版 .zzj 项目文件夹…</span></button>
      <button onClick={() => requestOpenProject(undefined, true)}>{uiIcon('archive', 15)}<span>导入 .zzjx 项目包…</span></button>
      <i/>
      {recentProjects.length ? recentProjects.map((path) => <button key={path} title={path} onClick={() => requestOpenProject(path)}>{uiIcon(path.toLowerCase().endsWith('.zzjx') ? 'archive' : path.toLowerCase().endsWith('.zzj') ? 'file' : 'folder', 15)}<span>{path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)}</span><small>{path}</small></button>) : <p>还没有最近项目</p>}
    </div> : null}

    {itemRename ? createPortal(
      <div className="item-rename-popover" style={{ left: itemRename.left, top: itemRename.top, width: itemRename.width }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={itemRename.draft}
          maxLength={80}
          aria-label="修改名称"
          onChange={(event) => setItemRename((current) => (current ? { ...current, draft: event.target.value } : current))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commitItemRename(event.currentTarget.value) }
            if (event.key === 'Escape') { event.preventDefault(); setItemRename(null) }
          }}
          onBlur={(event) => commitItemRename(event.currentTarget.value)}
        />
        <small>Enter 确认 · Esc 取消</small>
      </div>,
      previewOverlayRoot(),
    ) : null}
    {showTemplates ? createPortal(
      <div className="template-scrim" onPointerDown={() => setShowTemplates(false)}>
        <section className="template-gallery" role="dialog" aria-label="选择模板" onPointerDown={(event) => event.stopPropagation()}>
          <header>
            <div><b>选择模板</b><small>{templateItems.length ? `${templateItems.length} 套模板${templateQuery.trim() ? ` · 筛出 ${templateItems.filter((entry) => entry.name.toLowerCase().includes(templateQuery.trim().toLowerCase())).length} 套` : ''}` : '还没有模板 —— 把常用画布存成模板，以后一键开工'}</small></div>
            <label className="template-search"><span aria-hidden="true">⌕</span>
              <input value={templateQuery} placeholder="搜索模板名…" aria-label="搜索模板"
                onChange={(event) => setTemplateQuery(event.target.value)}
                onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setTemplateQuery('') } }}/>
              {templateQuery ? <button type="button" aria-label="清空搜索" onClick={() => setTemplateQuery('')}>{uiIcon('close', 12)}</button> : null}
            </label>
            <button className="template-close" aria-label="关闭" onClick={() => { setTemplateQuery(''); setShowTemplates(false) }}>{uiIcon('close', 15)}</button>
          </header>
          <div className="template-grid">
            {templateQuery.trim() ? null : <button className="template-card is-current-canvas" title="当前正在用的这张画布" onClick={() => { setShowTemplates(false); freshSession() }}>
              <span className="template-thumb" style={{ color: '#3b82f6' }}>{uiIcon('grid', 28)}</span><b>当前画布</b><small>{activeCanvas.title || '默认画布'}</small>
              <span className="template-card-enter">进入画布</span>
            </button>}
            {templateItems.filter((entry) => !templateQuery.trim() || entry.name.toLowerCase().includes(templateQuery.trim().toLowerCase())).map((entry) => <button key={entry.path} className={`template-card`} disabled={templateBusy} onClick={() => applyTemplate(entry.path)}>
              {(entry as { thumb?: string }).thumb ? <img className="template-thumb-img" src={(entry as { thumb?: string }).thumb} alt="" style={{ width: '100%', height: 118, objectFit: 'cover', borderRadius: 10, display: 'block' }} onError={(event) => { event.currentTarget.style.display = 'none' }} /> : entry.layout && entry.layout.length ? <TemplateMiniMap layout={entry.layout}/> : <span className="template-thumb">{uiIcon('grid', 28)}</span>}
              {templateRenaming?.path === entry.path
                ? <input className="template-name-input" autoFocus value={templateRenaming.draft} maxLength={40} aria-label="模板名"
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setTemplateRenaming((current) => (current ? { ...current, draft: event.target.value } : current))}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') { event.preventDefault(); renameTemplate(entry.path, event.currentTarget.value) }
                      if (event.key === 'Escape') { event.preventDefault(); setTemplateRenaming(null) }
                    }}
                    onBlur={(event) => renameTemplate(entry.path, event.currentTarget.value)}/>
                : <b>{entry.name}</b>}
              <small>{entry.cards ? `${entry.cards} 张卡 · ` : ''}{Math.max(1, Math.round(entry.size / 1024))} KB{templateDefault === entry.name ? ' · 默认' : ''}</small>
              <span className="template-card-enter">进入画布</span>
              <span className="template-card-tools">
                <em title="重命名这个模板" onClick={(event) => { event.stopPropagation(); setTemplateRenaming({ path: entry.path, draft: entry.name }) }}>{uiIcon('rename', 12)}</em>
                <em className={templateDefault === entry.name ? 'active' : ''} title="设为默认模板" onClick={(event) => { event.stopPropagation(); markDefaultTemplate(entry) }}>{uiIcon('star', 12)}</em>
                <em title="删除这个模板" onClick={(event) => { event.stopPropagation(); deleteTemplate(entry) }}>{uiIcon('trash', 12)}</em>
              </span>
            </button>)}
            {/* ＋ 排在已有模板后面：存完一套，新的一套就接着往右排 */}
            <button className={`template-card template-add${templateCreating !== null ? ' is-creating' : ''}`} disabled={templateBusy}
              onClick={() => setTemplateCreating(templateCreating === null ? '' : null)}>
              {templateCreating === null
                ? <><span className="template-thumb">{uiIcon('plus', 28)}</span><b>保存为模板</b><small>把当前这张画布存下来</small></>
                : <><span className="template-thumb">{uiIcon('grid', 28)}</span>
                  <input className="template-name-input" autoFocus value={templateCreating} maxLength={40} placeholder="起个名字"
                    aria-label="新模板名" onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setTemplateCreating(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') { event.preventDefault(); saveCurrentAsTemplate(event.currentTarget.value) }
                      if (event.key === 'Escape') { event.preventDefault(); setTemplateCreating(null) }
                    }}
                    onBlur={(event) => { const value = event.currentTarget.value.trim(); if (value) saveCurrentAsTemplate(value); else setTemplateCreating(null) }}/>
                  <small>回车或点空白处保存 · Esc 取消</small></>}
            </button>
          </div>
          <label className="template-auto"><input type="checkbox" checked={templateAuto} onChange={(event) => setTemplateAutoApply(event.target.checked)}/>开机自动套用默认模板（下次打开掌中界直接进那张画布）</label>
          <footer>
            <button className="ghost" disabled={!templateFolder} onClick={() => window.chrome?.webview?.postMessage({ type: 'native-open-path', path: templateFolder })}>打开模板文件夹</button>
            <span className="template-footer-hint">{templateBusy
              ? '处理中…'
              : templateJustSaved
                ? `已存好「${templateJustSaved}」 —— 点那张卡片上的「进入画布」就用这个名字开工`
                : '点上面的「保存为模板」就能把当前画布存下来'}</span>
          </footer>
        </section>
      </div>, previewOverlayRoot()) : null}
    {contextMenu ? (() => {
      const target = contextMenu.itemId ? items.find((entry) => entry.id === contextMenu.itemId) : undefined
      const chosen = items.filter((entry) => selectedIds.includes(entry.id) && entry.canvasId === contextMenu.canvasId)
      const run = (action: () => void) => () => { setContextMenu(null); action() }
      // 层序作用对象：选中里含目标就整批一起动，否则只动目标
      const layerTargets = () => (target && chosen.some((entry) => entry.id === target.id) ? chosen.map((entry) => entry.id) : target ? [target.id] : [])
      const rows: ContextMenuRow[] = target ? ([
        { label: '修改名称…', icon: 'rename', action: () => startItemRename(target) },
        { label: '置顶 / 置底', icon: 'sort', children: [
          { label: '置于顶层', icon: 'up', action: () => moveLayer(layerTargets(), 'top') },
          { label: '置于底层', icon: 'restore', action: () => moveLayer(layerTargets(), 'bottom') },
          { label: '上移一层', icon: 'up', action: () => moveLayer(layerTargets(), 'up') },
          { label: '下移一层', icon: 'restore', action: () => moveLayer(layerTargets(), 'down') },
        ] },
        { label: target.pinned ? '取消弹出（回到画布）' : '弹出并置顶（钉在屏幕上）', icon: 'pin', shortcutId: 'selection.pin' as ShortcutId, action: () => {
          if (chosen.length > 1) chosen.forEach((entry) => { if (entry.pinned !== !target.pinned) togglePin(contextMenu.canvasId, entry) })
          else togglePin(contextMenu.canvasId, target)
        } },
        { label: chosen.length > 1 ? `复制这 ${chosen.length} 项` : '复制一份', icon: 'copy', shortcutId: 'selection.duplicate', hint: 'Ctrl 拖动', action: () => {
          const sources = chosen.some((entry) => entry.id === target.id) ? chosen : [target]
          const stamp = Date.now()
          duplicateItems(sources, sources.map((entry, index) => `${entry.kind}-${stamp}-${index}`))
        } },
        // 用户 2026-09-14：网页卡右键里这一条不需要（红框）；图片/文件卡还留着。
        ...((target.kind === 'web' || target.kind === 'video') ? [] : [{
          label: chosen.length > 1 ? `打包这 ${chosen.length} 项到目录…` : '打包到目录…', icon: 'folder', shortcutId: 'selection.collect' as ShortcutId,
          action: () => {
            const sources = chosen.some((entry) => entry.id === target.id) ? chosen : [target]
            collectSelection(sources)
          },
        }]),
        ...(() => {
          const refPath = typeof target.source === 'string' && target.source && !/^https?:/i.test(target.source) && !target.source.startsWith('shell:') ? target.source : ''
          const rows: { label: string; icon: string; action: () => void }[] = refPath ? [{ label: '发给桌宠参考', icon: 'eye', action: () => { setPetOpen(true); setPetAttachments((list) => list.includes(refPath) ? list : [...list, refPath]); setToast('已加入桌宠参考') } }] : []
          if (target.kind === 'image' || target.kind === 'reference') {
            rows.push({ label: '读图 / 取字…', icon: 'eye', action: () => setImageActionMenu({ x: contextMenu.clientX, y: contextMenu.clientY, item: target }) })
          }
          return rows
        })(),
        ...((target.kind === 'folder' || target.kind === 'shellview') ? ([
          // 文件卡的地址行（后退/前进/向上/刷新/地址栏）已按用户要求整条删除，导航搬到这里
          { label: '后退', icon: 'back', action: () => postNativeExplorerCommand(target.id, 'back') },
          { label: '前进', icon: 'forward', action: () => postNativeExplorerCommand(target.id, 'forward') },
          { label: '向上（上一级）', icon: 'up', action: () => postNativeExplorerCommand(target.id, 'up') },
          { label: '刷新', icon: 'refresh', action: () => postNativeExplorerCommand(target.id, 'reload') },
          { label: '手动输路径…', icon: 'rename', shortcutId: 'file.address' as ShortcutId, action: () => window.dispatchEvent(new CustomEvent(FILE_ADDRESS_EDIT_EVENT, { detail: { itemId: target.id } })) },
        ] as { label: string; icon: string; shortcutId?: ShortcutId; action: () => void }[]) : []),
        'sep',
        { label: '统一比例', icon: 'split', shortcutId: 'selection.ratio' as ShortcutId, action: () => setRatioAnchor({ left: contextMenu.clientX, top: contextMenu.clientY }) },
        ...(chosen.length >= 2 ? [
          // 用户 2026-09-14：「分屏布局这个不应该在这，因为点了这个图片的比例全都乱了」——
          // 布局搬到下方工具栏（那里能选方向），这里只留整理/成组。
          { label: `按类型整理这 ${chosen.length} 项`, icon: 'grid', shortcutId: 'canvas.organize' as ShortcutId, action: organizeByType },
          { label: '成组', icon: 'grid', shortcutId: 'selection.group' as ShortcutId, action: groupSelection },
          { label: '解组', icon: 'grid', shortcutId: 'selection.group' as ShortcutId, action: ungroupSelection },
        ] : []),
        'sep',
        ...((target.kind === 'web' || target.kind === 'video') ? [] : [{ label: chosen.length > 1 ? `导出参考板（这 ${chosen.length} 项 → 一张 PNG）` : '导出参考板（一张 PNG）', icon: 'grid', action: () => { setExportMode('board'); setExportAnchor({ left: contextMenu.clientX, top: contextMenu.clientY }) } }]),
        { label: chosen.length > 1 ? `删除 ${chosen.length} 项` : '删除', icon: 'trash', shortcutId: 'selection.delete', action: deleteSelection },
      ] satisfies ContextMenuRow[]) : ([
        { label: '修改名称…', icon: 'rename', action: () => startCanvasRename(contextMenu.canvasId) },
        { label: '在此生成', icon: 'plus', shortcutId: 'canvas.spawn', action: () => setAnchor(contextMenu.canvasId, contextMenu.worldX, contextMenu.worldY) },
        { label: '添加网页', icon: 'eye', shortcutId: 'canvas.addWeb', action: () => addItem('web', undefined, undefined, undefined, { canvasId: contextMenu.canvasId, x: contextMenu.worldX, y: contextMenu.worldY }) },
        { label: '此电脑', icon: 'folder', shortcutId: 'canvas.addComputer', action: () => addItem('folder', '此电脑', 'shell:MyComputerFolder', undefined, { canvasId: contextMenu.canvasId, x: contextMenu.worldX, y: contextMenu.worldY }) },
        { label: '剪贴暂存', icon: 'copy', action: () => addItem('shelf', undefined, undefined, undefined, { canvasId: contextMenu.canvasId, x: contextMenu.worldX, y: contextMenu.worldY }) },
        { label: '桌面（图标可拖 / 双击启动）', icon: 'grid', action: () => addItem('desktop', undefined, undefined, undefined, { canvasId: contextMenu.canvasId, x: contextMenu.worldX, y: contextMenu.worldY }) },

        { label: '粘贴到此处', icon: 'paste', shortcutId: 'canvas.paste', action: () => { setAnchor(contextMenu.canvasId, contextMenu.worldX, contextMenu.worldY); void pasteFromClipboard() } },
        'sep',
        { label: selectedIds.length ? '按类型整理选中项' : '按类型整理当前画布', icon: 'grid', shortcutId: 'canvas.organize', action: organizeByType },
        { label: '分屏布局选中项', icon: 'split', shortcutId: 'selection.layout', action: () => sameCanvasSelectionCount >= 2 ? arrangeSelection('grid') : setToast('请先框选两个或更多元素') },
        { label: '统一比例', icon: 'split', shortcutId: 'selection.ratio', action: () => setRatioAnchor({ left: contextMenu.clientX, top: contextMenu.clientY }) },
        'sep',
        { label: '保存', icon: 'save', shortcutId: 'project.save', action: saveDocument },
        { label: '另存为', icon: 'save', shortcutId: 'project.saveAs', action: saveDocumentAs },
        { label: '保存现在的画布为模板', icon: 'grid', action: () => { setContextMenu(null); saveCanvasAsTemplateQuick() } },
        { label: '导出项目包', icon: 'archive', shortcutId: 'project.export', action: exportDocument },
        { label: '导出参考板（一张 PNG）', icon: 'grid', action: () => { setExportMode('board'); setExportAnchor({ left: contextMenu.clientX, top: contextMenu.clientY }) } },
        { label: '批量导出图片…', icon: 'archive', action: () => { setExportMode('batch'); setExportAnchor({ left: contextMenu.clientX, top: contextMenu.clientY }) } },
      ] satisfies ContextMenuRow[])
      return <CanvasMenu x={contextMenu.clientX} y={contextMenu.clientY} onPointerDown={(event) => event.stopPropagation()}>
        {target ? <div className="canvas-menu-title">{target.title}</div> : null}
        {rows.map((row, index) => {
          if (row === 'sep') return <i key={`sep-${index}`} className="canvas-menu-sep"/>
          const item: ContextMenuAction = row
          if (item.children) return <div key={item.label} className={`canvas-menu-group ${menuGroup === item.label ? 'open' : ''}`}>
            <button role="menuitem" aria-expanded={menuGroup === item.label} onClick={(event) => { event.stopPropagation(); setMenuGroup(menuGroup === item.label ? null : item.label) }}>{uiIcon(item.icon, 14)}<span>{item.label}</span><i className="canvas-menu-caret">{uiIcon('chevronRight', 12)}</i></button>
            {menuGroup === item.label ? <div className="canvas-menu-sub">{item.children.map((child) => <button key={child.label} role="menuitem" onClick={run(() => child.action?.())}>{uiIcon(child.icon, 13)}<span>{child.label}</span></button>)}</div> : null}
          </div>
          return <button key={item.label} role="menuitem" onClick={run(() => item.action?.())}>{uiIcon(item.icon, 14)}<span>{item.label}</span>{item.shortcutId && shortcutDisplay(shortcutBindings, item.shortcutId) !== '未设置' ? <kbd>{shortcutDisplay(shortcutBindings, item.shortcutId)}</kbd> : item.hint ? <kbd>{item.hint}</kbd> : null}</button>
        })}
      </CanvasMenu>
    })() : null}
    {splitQuickSide ? <div className={`split-quick is-${splitQuickSide}`} role="dialog" aria-label="选择要和掌中界分屏的程序">
      <header><b>和掌中界分屏</b><small>{splitQuickSide === 'left' ? '它贴左边 · 掌中界留右边' : splitQuickSide === 'right' ? '它贴右边 · 掌中界留左边' : splitQuickSide === 'top' ? '它贴上面 · 掌中界留下面' : '它贴下面 · 掌中界留上面'} · Esc 取消</small></header>
      <input
        ref={splitQuickInputRef}
        className="split-quick-filter"
        placeholder="输入名字过滤…"
        value={splitQuickFilter}
        onChange={(event) => { setSplitQuickFilter(event.target.value); setSplitQuickIndex(0) }}
        onKeyDown={(event) => {
          const list = splitQuickOptions
          if (event.key === 'ArrowDown') { event.preventDefault(); setSplitQuickIndex((current) => Math.min(current + 1, Math.max(0, list.length - 1))) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setSplitQuickIndex((current) => Math.max(current - 1, 0)) }
          else if (event.key === 'Enter') {
            event.preventDefault()
            if (tileSelectedHandles.length) applySplitQuick(tileSelectedHandles)
            else if (list[splitQuickIndex]) applySplitQuick([list[splitQuickIndex].handle])
          }
        }}
      />
      <div className="split-quick-list">
        {tilePickerLoading ? <div className="split-quick-empty">正在读取当前窗口…</div>
          : splitQuickOptions.length ? splitQuickOptions.map((entry, index) => {
            const order = tileSelectedHandles.indexOf(entry.handle)
            return <button
              key={entry.handle}
              type="button"
              className={(index === splitQuickIndex ? 'is-active' : '') + (order >= 0 ? ' is-selected' : '')}
              onMouseEnter={() => setSplitQuickIndex(index)}
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey) {
                  setTileSelectedHandles((current) => current.includes(entry.handle) ? current.filter((handle) => handle !== entry.handle) : [...current, entry.handle])
                  return
                }
                applySplitQuick([entry.handle])
              }}
            ><span className="split-quick-icon">{uiIcon('executable', 15)}</span><span className="split-quick-text"><b title={entry.title}>{entry.title || entry.process || '未命名窗口'}</b><small>{entry.process || ''}{order >= 0 ? ` · 第 ${order + 2} 格` : ''}</small></span></button>
          }) : <div className="split-quick-empty">没有找到其它窗口</div>}
      </div>
      <footer>{tileSelectedHandles.length ? <><span>已选 {tileSelectedHandles.length} 个 → 共 {tileSelectedHandles.length + 1} 个窗口</span><button type="button" className="primary" onClick={() => applySplitQuick(tileSelectedHandles)}>分屏</button></> : <span>点一下即分屏（掌中界 + 它 = 2 个窗口）· 想 3 个窗口就 Ctrl+点击多选</span>}</footer>
    </div> : null}
    {splitEdgeSide ? <div
      className={`split-drag-handle is-${splitEdgeSide}`}
      title="拖动调整分屏大小（Esc 收起把手）"
      onPointerDown={(event) => {
        splitDragRef.current = { active: true, x: event.clientX, y: event.clientY, pending: 0 }
        try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
      }}
      onPointerMove={(event) => {
        const drag = splitDragRef.current
        if (!drag.active) return
        const vertical = splitEdgeSide === 'left' || splitEdgeSide === 'right'
        const delta = vertical ? event.clientX - drag.x : event.clientY - drag.y
        drag.x = event.clientX
        drag.y = event.clientY
        if (!delta) return
        window.chrome?.webview?.postMessage({ type: 'native-split-drag', delta })
      }}
      onPointerUp={() => { splitDragRef.current.active = false }}
      onPointerCancel={() => { splitDragRef.current.active = false }}
    /> : null}
    {tilePickerOpen ? <div className="modal-scrim" role="presentation">
      <section className="modal-card tile-window-card" role="dialog" aria-modal="true" aria-labelledby="tile-window-title">
        <header><div><h2 id="tile-window-title">平铺窗口</h2><p>先选布局，再挑要一起分屏的程序（可多选）；点布局里的格子可以指定掌中界自己占哪一格。</p></div><button className="settings-close" title={`关闭（${shortcutDisplay(shortcutBindings, 'overlay.close')}）`} onClick={() => setTilePickerOpen(false)}>{uiIcon('close', 17)}</button></header>
        <div className="tile-layout-grid">
          {TILE_LAYOUTS.map((layout) => {
            const active = layout.id === tileLayoutId
            const slots = layout.slots
            return <button key={layout.id} type="button" className={'tile-layout' + (active ? ' selected' : '')} title={`${layout.label}：${layout.hint}`} onClick={() => {
                setTileLayoutId(layout.id)
                setTileSelfSlot((current) => Math.min(current, slots.length - 1))
                setTileSelectedHandles((current) => current.slice(0, slots.length - 1))
              }}>
              <span className="tile-layout-preview">{slots.map((slot, index) => (
                <i
                  key={index}
                  className={'tile-slot' + (active && index === tileSelfSlot ? ' is-self' : '')}
                  style={{ left: `${slot.x * 100}%`, top: `${slot.y * 100}%`, width: `${slot.w * 100}%`, height: `${slot.h * 100}%` }}
                  onPointerDown={(event) => { event.stopPropagation(); setTileLayoutId(layout.id); setTileSelfSlot(index) }}
                >{active && index === tileSelfSlot ? <b>界</b> : null}</i>
              ))}</span>
              <em>{layout.label}<small>{slots.length} 格</small></em>
            </button>
          })}
        </div>
        <div className="tile-window-list">
          {tilePickerLoading ? <div className="tile-window-empty">正在读取当前窗口…</div> : tileWindowOptions.length ? tileWindowOptions.map((entry) => {
            const order = tileSelectedHandles.indexOf(entry.handle)
            return <button key={entry.handle} type="button" className={order >= 0 ? 'selected' : ''} aria-pressed={order >= 0} onClick={() => setTileSelectedHandles((current) => current.includes(entry.handle) ? current.filter((handle) => handle !== entry.handle) : [...current, entry.handle])}>
              <span className="tile-window-icon">{uiIcon('executable', 19)}</span><span><b title={entry.title}>{entry.title}</b><small>{order >= 0 ? `第 ${order + 2} 格` : '点击选择'}</small></span>{order >= 0 ? <i>{order + 1}</i> : null}
            </button>
          }) : <div className="tile-window-empty">没有找到其他可平铺窗口</div>}
        </div>
        {tilePickerError ? <small className="tile-window-error" role="alert">{tilePickerError}</small> : null}
        <footer className="modal-actions"><button className="ghost" disabled={tilePickerApplying} onClick={() => requestTileWindowOptions(false)}>刷新列表</button><span>已选 {tileSelectedHandles.length} 个 → 共 {tileSelectedHandles.length + 1} 个窗口{(TILE_LAYOUTS.find((layout) => layout.id === tileLayoutId)?.slots.length ?? 2) > tileSelectedHandles.length + 1 ? `（这个布局还能再放 ${(TILE_LAYOUTS.find((layout) => layout.id === tileLayoutId)?.slots.length ?? 2) - tileSelectedHandles.length - 1} 个）` : ''}</span><button className="ghost" disabled={tilePickerApplying} onClick={() => setTilePickerOpen(false)}>取消</button><button className="primary" disabled={!tileSelectedHandles.length || tilePickerLoading || tilePickerApplying} onClick={() => {
          const bridge = window.chrome?.webview
          if (!bridge) { setTilePickerError('窗口平铺仅在掌中界 Windows 程序中可用'); return }
          setTilePickerError('')
          setTilePickerApplying(true)
          const processNames = tileSelectedHandles
            .map((handle) => tileWindowOptions.find((entry) => entry.handle === handle)?.process)
            .filter((value): value is string => Boolean(value))
          try { localStorage.setItem(SPLIT_APPS_KEY, JSON.stringify(processNames)) } catch { /* 忽略存储失败 */ }
          bridge.postMessage({ type: 'native-window-tile-apply', handles: tileSelectedHandles, layout: tileLayoutId, selfSlot: tileSelfSlot })
        }}>{tilePickerApplying ? '正在平铺…' : '确认平铺'}</button></footer>
      </section>
    </div> : null}
    {pendingGlobalFavoriteRemoval ? <div className="modal-scrim" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="remove-global-favorite-title">
        <h2 id="remove-global-favorite-title">移除收藏入口？</h2>
        <p>将从全局常用栏移除“{pendingGlobalFavoriteRemoval.label}”。只删除这个入口，不会删除或修改硬盘上的文件和文件夹。</p>
        <div className="modal-actions"><button onClick={() => setPendingGlobalFavoriteRemoval(null)}>取消</button><button className="ghost danger" onClick={() => removeGlobalFavorite(pendingGlobalFavoriteRemoval.id)}>仅移除收藏入口</button></div>
      </section>
    </div> : null}
    {showSettings ? <div className="modal-scrim" role="presentation">
      <section className="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title" style={{ width: settingsSize.width, height: settingsSize.height }}>
        <header><div><h2 id="settings-title">掌中界设置</h2><p>这些偏好对所有项目生效，并会在重启后保留。</p></div><button className="settings-close" title={`关闭（${shortcutDisplay(shortcutBindings, 'overlay.close')}）`} onClick={() => setShowSettings(false)}>{uiIcon('close', 17)}</button></header>
        <div className="settings-body"><nav className="settings-tabs"><button className={settingsPage === 'general' ? 'selected' : ''} onClick={() => setSettingsPage('general')}>常规</button><button className={settingsPage === 'shortcuts' ? 'selected' : ''} onClick={() => setSettingsPage('shortcuts')}>快捷键</button></nav>
        {settingsPage === 'general' ? <div className="settings-groups" onWheel={stopWheelPropagation}>
          <fieldset><legend>窗口外观</legend><div className="settings-options"><button className={windowAppearance === 'system' ? 'selected' : ''} onClick={() => updateGlobalSettings({ windowAppearance: 'system' })}>系统边框</button><button className={windowAppearance === 'borderless' ? 'selected' : ''} onClick={() => updateGlobalSettings({ windowAppearance: 'borderless' })}>无边框</button></div></fieldset>
          <fieldset><legend>窗口材质</legend><div className="settings-options"><button className={windowMaterial === 'mica' ? 'selected' : ''} onClick={() => updateGlobalSettings({ windowMaterial: 'mica' })}>云母（半透明）</button><button className={windowMaterial === 'solid' ? 'selected' : ''} onClick={() => updateGlobalSettings({ windowMaterial: 'solid' })}>实色</button></div>{materialSupported === false ? <small>当前系统未提供云母材质，已自动回退实色。</small> : null}</fieldset>
          <fieldset><legend>顶部工具栏</legend><div className="settings-options"><button className={toolbarVisibility === 'always' ? 'selected' : ''} onClick={() => updateGlobalSettings({ toolbarVisibility: 'always' })}>始终显示</button><button className={toolbarVisibility === 'auto' ? 'selected' : ''} onClick={() => updateGlobalSettings({ toolbarVisibility: 'auto' })}>自动隐藏</button></div></fieldset>
          <fieldset><legend>卡片标题栏</legend><div className="settings-options"><button className={cardTitlebarVisibility === 'always' ? 'selected' : ''} onClick={() => updateGlobalSettings({ cardTitlebarVisibility: 'always' })}>始终显示</button><button className={cardTitlebarVisibility === 'hover' ? 'selected' : ''} onClick={() => updateGlobalSettings({ cardTitlebarVisibility: 'hover' })}>悬停显示</button></div></fieldset>
          <fieldset><legend>应用主题</legend><div className="settings-options three"><button className={theme === 'system' ? 'selected' : ''} onClick={() => updateGlobalSettings({ appTheme: 'system' })}>跟随系统</button><button className={theme === 'light' ? 'selected' : ''} onClick={() => updateGlobalSettings({ appTheme: 'light' })}>浅色</button><button className={theme === 'dark' ? 'selected' : ''} onClick={() => updateGlobalSettings({ appTheme: 'dark' })}>深色</button></div></fieldset>
          <fieldset><legend>网页颜色</legend><div className="settings-options three"><button className={webThemeMode === 'follow' ? 'selected' : ''} onClick={() => setWebThemeMode('follow')}>跟随应用</button><button className={webThemeMode === 'dark' ? 'selected' : ''} onClick={() => setWebThemeMode('dark')}>强制深色</button><button className={webThemeMode === 'original' ? 'selected' : ''} onClick={() => setWebThemeMode('original')}>网站原色</button></div>{!webThemeEffective ? <small>网页颜色环境将在下次启动时完全生效。</small> : null}</fieldset>
          <fieldset><legend>界面动效</legend><div className="settings-options three"><button className={readBrowserSettings().uiMotion === 'off' ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiMotion: 'off' })}>关闭</button><button className={readBrowserSettings().uiMotion !== 'off' && readBrowserSettings().uiMotion !== 'full' ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiMotion: 'light' })}>轻（默认）</button><button className={readBrowserSettings().uiMotion === 'full' ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiMotion: 'full' })}>标准</button></div><small>菜单淡入、提示条滑入、等待呼吸这类微动效。选「关闭」则界面完全静态（系统开了"减少动态效果"时也会自动静态）。</small></fieldset>
          <fieldset><legend>界面字号</legend><div className="settings-options"><button className={readBrowserSettings().uiScale === 0.9 ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiScale: 0.9 })}>小</button><button className={readBrowserSettings().uiScale === 1 ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiScale: 1 })}>标准</button><button className={readBrowserSettings().uiScale === 1.15 ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiScale: 1.15 })}>大</button><button className={readBrowserSettings().uiScale === 1.3 ? 'selected' : ''} onClick={() => updateGlobalSettings({ uiScale: 1.3 })}>特大</button></div><small>整站等比放大/缩小（画布、面板、卡片标题都会跟着变）。字看不清就调「大」。</small></fieldset>
          <fieldset><legend>画布风格</legend><div className="settings-options"><button className={readBrowserSettings().canvasSkin === 'board' ? 'selected' : ''} onClick={() => updateGlobalSettings({ canvasSkin: 'board' })}>白板风（浅色纸感）</button><button className={readBrowserSettings().canvasSkin === 'board-dark' ? 'selected' : ''} onClick={() => updateGlobalSettings({ canvasSkin: 'board-dark' })}>白板风（深色）</button><button className={readBrowserSettings().canvasSkin === 'default' ? 'selected' : ''} onClick={() => updateGlobalSettings({ canvasSkin: 'default' })}>默认（深色玻璃）</button></div></fieldset>
          <fieldset><legend>使用手册</legend><div className="settings-options"><button onClick={() => window.chrome?.webview?.postMessage({ type: 'native-open-manual' })}>打开使用手册…</button><button onClick={() => window.chrome?.webview?.postMessage({ type: 'native-open-path', path: 'https://hermes-agent.nousresearch.com/docs' })}>这是什么工具？</button></div><small>手册随安装包一起装在安装目录里（使用手册.html），随时可看。</small></fieldset>
          <fieldset><legend>OCR 取字语言</legend><div className="settings-options three"><button className={readBrowserSettings().ocrLanguage === 'zh-Hans-CN' ? 'selected' : ''} onClick={() => updateGlobalSettings({ ocrLanguage: 'zh-Hans-CN' })}>简体中文</button><button className={readBrowserSettings().ocrLanguage === 'ko' ? 'selected' : ''} onClick={() => updateGlobalSettings({ ocrLanguage: 'ko' })}>朝鲜语</button><button className={readBrowserSettings().ocrLanguage === 'en-US' ? 'selected' : ''} onClick={() => updateGlobalSettings({ ocrLanguage: 'en-US' })}>英语</button></div><small>离线「OCR 取字」用哪个语言模型。识别朝鲜语必须选「朝鲜语」、中文必须选「简体中文」——选错会全变成乱码。</small></fieldset>
          <fieldset><legend>画布模板</legend><div className="settings-options"><button onClick={() => { setShowSettings(false); openTemplates() }}>打开模板库…</button><button className={templateAuto ? 'selected' : ''} onClick={() => setTemplateAutoApply(!templateAuto)}>{templateAuto ? '开机自动套用：开' : '开机自动套用：关'}</button></div><small>模板是整套画布预设（常用网站 / 工具 / 待办，可多套切换）。当前默认模板：{templateDefault || '未设置'}</small></fieldset>
          <fieldset><legend>文件图标</legend><div className="settings-options"><button className={fileIconMode === 'system' ? 'selected' : ''} onClick={() => updateGlobalSettings({ fileIconMode: 'system' })}>跟随系统</button><button className={fileIconMode === 'vector' ? 'selected' : ''} onClick={() => updateGlobalSettings({ fileIconMode: 'vector' })}>简约矢量</button></div></fieldset>
          <fieldset><legend>资源管理器集成</legend><div className="settings-options"><button className={explorerContextMenuEnabled ? 'selected' : ''} onClick={() => updateGlobalSettings({ explorerContextMenuEnabled: true })}>启用</button><button className={!explorerContextMenuEnabled ? 'selected' : ''} onClick={() => updateGlobalSettings({ explorerContextMenuEnabled: false })}>关闭</button></div><small>启用后可双击打开 .zzj 单文件项目，并可从文件夹右键菜单选择“用掌中界打开”。</small></fieldset>
        </div> : <ShortcutSettings
          bindings={shortcutBindings}
          onChange={(next) => updateGlobalSettings({ shortcutBindings: next })}
        />}</div>
        <footer><span>{shortcutDisplay(shortcutBindings, 'app.settings')} 打开　·　{shortcutDisplay(shortcutBindings, 'overlay.close')} 关闭</span><button className="primary" onClick={() => setShowSettings(false)}>完成</button></footer>
        {(['n','ne','e','se','s','sw','w','nw'] as const).map((edge) => <i key={edge} className={`settings-resize-handle edge-${edge}`} aria-hidden="true" onPointerDown={(event) => beginSettingsResize(edge, event)} onPointerMove={moveSettingsResize} onPointerUp={finishSettingsResize} onPointerCancel={finishSettingsResize}/>)}
      </section>
    </div> : null}
    {showEverythingInstallPrompt ? <div className="modal-scrim" role="presentation">
      <section className="modal-card everything-prompt" role="dialog" aria-modal="true" aria-labelledby="everything-prompt-title">
        <span className="everything-prompt-mark">E</span>
        <h2 id="everything-prompt-title">启用全盘秒搜</h2>
        <p>掌中界没有检测到 Everything。当前搜索仍可使用，会在后台遍历当前文件夹；安装 Everything 后可直接进行高速全盘搜索。</p>
        <small>只会打开 voidtools 官方网站，不会自动下载或安装任何程序。</small>
        <div className="modal-actions">
          <button className="ghost" onClick={() => {
            setShowEverythingInstallPrompt(false)
            updateGlobalSettings({ everythingPromptDismissed: true })
          }}>继续使用当前搜索</button>
          <button className="primary" onClick={() => {
            setShowEverythingInstallPrompt(false)
            updateGlobalSettings({ everythingPromptDismissed: true })
            window.chrome?.webview?.postMessage({ type: 'native-open-everything-download' })
          }}>前往 voidtools 官网</button>
        </div>
      </section>
    </div> : null}
    {closePrompt ? <div className="modal-scrim" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="close-prompt-title">
        <h2 id="close-prompt-title">当前画布尚未保存</h2>
        <p>关闭后未保存的摆放、分屏和窗口位置都会丢失。</p>
        <div className="modal-actions">
          <button className="ghost" onClick={() => { setClosePrompt(false); window.chrome?.webview?.postMessage({ type: 'native-close-response', action: 'cancel' }) }}>取消</button>
          <button className="ghost danger" onClick={() => { setClosePrompt(false); window.chrome?.webview?.postMessage({ type: 'native-close-response', action: 'close' }) }}>不保存</button>
          <button className="primary" onClick={() => { setClosePrompt(false); window.chrome?.webview?.postMessage({ type: 'native-close-response', action: 'save' }) }}>保存</button>
        </div>
      </div>
    </div> : null}
    {overwriteProjectPath ? <div className="modal-scrim" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="overwrite-project-title">
        <h2 id="overwrite-project-title">覆盖已有掌中界项目？</h2>
        <p>目标位置已经包含一个掌中界项目。继续会用当前画布替换它的项目内容。</p>
        <small className="preview-path">{overwriteProjectPath}</small>
        <div className="modal-actions">
          <button className="ghost" onClick={() => { setOverwriteProjectPath(null); window.chrome?.webview?.postMessage({ type: 'native-project-overwrite-response', overwrite: false }) }}>取消</button>
          <button className="primary" onClick={() => { setOverwriteProjectPath(null); window.chrome?.webview?.postMessage({ type: 'native-project-overwrite-response', overwrite: true }) }}>覆盖并保存</button>
        </div>
      </div>
    </div> : null}
    {legacyMigrationProjectPath ? <div className="modal-scrim" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="legacy-migration-title">
        <h2 id="legacy-migration-title">把旧项目转换成单文件？</h2>
        <p>这个项目仍是旧的目录格式。转换后会得到可双击打开的单个 .zzj 文件；旧目录会改名为 .zzj.old 保留，不会删除。</p>
        <small className="preview-path">{legacyMigrationProjectPath}</small>
        <div className="modal-actions">
          <button className="ghost" onClick={() => {
            setLegacyMigrationProjectPath(null)
            window.chrome?.webview?.postMessage({ type: 'native-project-legacy-migration-response', action: 'cancel' })
          }}>取消</button>
          <button className="ghost" onClick={() => {
            setLegacyMigrationProjectPath(null)
            window.chrome?.webview?.postMessage({ type: 'native-project-legacy-migration-response', action: 'saveAs' })
          }}>另存为单文件</button>
          <button className="primary" onClick={() => {
            setLegacyMigrationProjectPath(null)
            window.chrome?.webview?.postMessage({ type: 'native-project-legacy-migration-response', action: 'convert' })
          }}>转换并保存</button>
        </div>
      </div>
    </div> : null}
    {projectOpenPrompt ? <div className="modal-scrim" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="project-open-prompt-title">
        <h2 id="project-open-prompt-title">打开另一个项目？</h2>
        <p>当前画布有未保存的改动。请选择保存后打开、不保存直接打开，或取消本次操作。</p>
        <small className="preview-path">目标：{projectOpenPrompt.label}</small>
        {projectOpenPrompt.error ? <small className="save-name-error">{projectOpenPrompt.error}</small> : null}
        <div className="modal-actions">
          <button className="ghost" onClick={() => updateProjectOpenPrompt(null)}>取消</button>
          <button className="ghost danger" onClick={() => { const request = projectOpenPrompt; updateProjectOpenPrompt(null); dispatchProjectOpen(request) }}>不保存直接打开</button>
          <button className="primary" onClick={saveBeforeProjectOpen}>保存并打开</button>
        </div>
      </div>
    </div> : null}
    {saveNamePrompt ? <div className="modal-scrim" role="presentation">
      <form className="modal-card save-name-card" role="dialog" aria-modal="true" aria-labelledby="save-name-title" onSubmit={(event) => {
        event.preventDefault()
        const name = saveNamePrompt.name.trim()
        if (!name) { updateSaveNamePrompt({ ...saveNamePrompt, error: '请输入项目名称' }); return }
        if (!requestProjectSave(saveNamePrompt.mode, saveNamePrompt.requestedByClose, name)) {
          if (saveNamePrompt.requestedByClose) {
            updateSaveNamePrompt(null)
            setClosePrompt(true)
            window.chrome?.webview?.postMessage({ type: 'native-close-response', action: 'save-unavailable' })
          }
          return
        }
        updateSaveNamePrompt({ ...saveNamePrompt, name, saving: true, error: '' })
      }}>
        <h2 id="save-name-title">保存掌中界项目</h2>
        <p>先确认项目名称，再由 Windows 选择保存位置。项目名默认取当前根画布标题。</p>
        <label className="save-name-field"><span>项目名称</span><input autoFocus value={saveNamePrompt.name} onChange={(event) => updateSaveNamePrompt({ ...saveNamePrompt, name: event.target.value, error: '' })} disabled={saveNamePrompt.saving}/></label>
        {saveNamePrompt.error ? <small className="save-name-error">{saveNamePrompt.error}</small> : null}
        <div className="modal-actions">
          <button type="button" className="ghost" disabled={saveNamePrompt.saving} onClick={() => {
            const requestedByClose = saveNamePrompt.requestedByClose
            updateSaveNamePrompt(null)
            const deferredOpen = pendingProjectOpenAfterSaveRef.current
            if (deferredOpen) {
              pendingProjectOpenAfterSaveRef.current = null
              updateProjectOpenPrompt({ ...deferredOpen, error: '已取消保存，目标项目尚未打开' })
              return
            }
            if (requestedByClose) {
              setClosePrompt(true)
              window.chrome?.webview?.postMessage({ type: 'native-close-response', action: 'save-unavailable' })
            }
          }}>取消</button>
          <button type="submit" className="primary" disabled={saveNamePrompt.saving}>{saveNamePrompt.saving ? '请在 Windows 中选择位置…' : '选择位置…'}</button>
        </div>
      </form>
    </div> : null}
    {exportAnchor ? <div ref={exportPanelRef} className="export-panel" role="dialog" aria-label="导出" style={{ left: exportAnchor.left, top: exportAnchor.top }}>
      <header><b>导出</b><small>{exportTargets().length} 项已选中</small></header>
      <div className="export-modes">
        <button type="button" className={exportMode === 'board' ? 'active' : ''} onClick={() => setExportMode('board')}>参考板（一张图）</button>
        <button type="button" className={exportMode === 'batch' ? 'active' : ''} onClick={() => setExportMode('batch')}>批量图片</button>
      </div>
      {exportMode === 'batch' ? <div className="export-options">
        <label>长边<select value={batchLongEdge} onChange={(event) => setBatchLongEdge(Number(event.target.value))}>
          <option value={0}>原尺寸</option><option value={1600}>1600</option><option value={2048}>2048</option><option value={2560}>2560</option>
        </select></label>
        <label>格式<select value={batchFormat} onChange={(event) => setBatchFormat(event.target.value as 'image/jpeg' | 'image/png')}>
          <option value="image/jpeg">JPEG</option><option value="image/png">PNG</option>
        </select></label>
        <label>质量<select value={batchQuality} onChange={(event) => setBatchQuality(Number(event.target.value))} disabled={batchFormat === 'image/png'}>
          <option value={60}>60</option><option value={80}>80</option><option value={92}>92</option>
        </select></label>
        <label>前缀<input value={batchPrefix} onChange={(event) => setBatchPrefix(event.target.value)} maxLength={24}/></label>
      </div> : null}
      <button type="button" className="export-run" disabled={exportBusy} onClick={() => { const mode = exportMode; setExportAnchor(null); void runExport(mode) }}>
        {exportBusy ? '导出中…' : exportMode === 'board' ? '导出参考板' : '批量导出图片'}
      </button>
      <div className="export-folder">
        <span title={settingsRef.current.exportFolder?.trim() || '默认位置：图片\\掌中界导出'}>输出到 {settingsRef.current.exportFolder?.trim() || '图片\\掌中界导出'}</span>
        <button type="button" onClick={async () => {
          const picked = await nativePickFolder('选择导出位置', settingsRef.current.exportFolder?.trim() || '')
          if (!picked) { setToast('已取消，导出位置没变'); return }
          updateGlobalSettings({ exportFolder: picked })
          setToast(`导出位置已改为 ${picked}`)
        }}>更换…</button>
      </div>
    </div> : null}
    {showRatioPicker && ratioAnchor ? <div ref={ratioPickerRef} className="ratio-picker" role="menu" aria-label="选择窗口比例" style={{ left: ratioAnchor.left, top: ratioAnchor.top }}>{([['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9], ['4:5', 4 / 5]] as [string, number][]).map(([label, value]) => <button key={label} role="menuitem" onClick={() => applyRatio(value)}><i style={{ width: value >= 1 ? 26 : 26 * value, height: value >= 1 ? 26 / value : 26 }}/><b>{label}</b></button>)}<button className="ratio-free" role="menuitem" onClick={() => applyRatio(null)}><b>自由比例</b></button></div> : null}
    {sameCanvasSelectionCount >= 2 && !selectionAllIcons ? <aside className="context-layout" aria-label="多选组合工具栏" onWheel={stopWheelPropagation}><div className="context-summary"><span>{sameCanvasSelectionCount}</span><b>个元素已选择</b></div>{selectedWorkspaceItems.length === 2 && sameCanvasSelectionCount === 2 ? <button className="fusion-tool" onClick={() => mergeItems(activeCanvasId, selectedWorkspaceItems[0].id, selectedWorkspaceItems[1].id)}><span className="fusion-tool-icon">◉◉</span><span>融合画布</span></button> : null}{sameCanvasSelectionCount === 2 ? <button className={showSplitPicker ? 'active-tool' : ''} title="二分屏方向：左右 / 上下" onClick={() => { setShowSplitPicker((value) => !value); setLayoutPickerFor(null) }}><SplitIcon kind="two"/><span>二分屏</span><i className="tool-caret">▾</i></button> : null}{(['three','grid','custom'] as LayoutKind[]).map((kind) => <button key={kind} className={layoutPickerFor === kind ? 'active-tool' : ''} title={kind === 'three' ? '三分屏方向：三列 / 三行' : kind === 'grid' ? '四宫格方向：2×2 / 四列 / 四行' : '左边那个做大，其余竖排在右边'} onClick={() => { if (kind === 'custom') { setLayoutPickerFor(null); setShowSplitPicker(false); arrangeSelection(kind); return } setShowSplitPicker(false); setLayoutPickerFor((value) => value === kind ? null : (kind as 'three' | 'grid')) }}><SplitIcon kind={kind}/><span>{kind === 'three' ? '三分屏' : kind === 'grid' ? '四宫格' : '主次布局'}</span>{kind === 'custom' ? null : <i className="tool-caret">▾</i>}</button>)}<span className="toolbar-divider"/><button className="text-tool" onClick={groupSelection}><span className="group-symbol">⌘</span><span>成组</span></button><button className="text-tool" onClick={ungroupSelection}><span className="group-symbol broken">⌘</span><span>解组</span></button><button className="text-tool danger-tool" onClick={deleteSelection}>{uiIcon('trash', 15)}<span>删除</span>{shortcutDisplay(shortcutBindings, 'selection.delete') !== '未设置' ? <kbd>{shortcutDisplay(shortcutBindings, 'selection.delete')}</kbd> : null}</button><button className="tool-close" onClick={() => { setSelectedIds([]); setShowSplitPicker(false) }}>{uiIcon('close', 16)}</button>{layoutPickerFor === 'three' ? <div className="split-picker" role="menu" aria-label="选择三分屏方向">
  <button role="menuitem" onClick={() => { arrangeSelection('three', { cols: 3 }); setLayoutPickerFor(null) }}><span className="split-choice choice-columns"><i/><i/><i/></span><b>三列</b><small>左右并排 1×3</small></button>
  <button role="menuitem" onClick={() => { arrangeSelection('three', { cols: 1 }); setLayoutPickerFor(null) }}><span className="split-choice choice-rows"><i/><i/><i/></span><b>三行</b><small>上下堆叠 3×1</small></button>
</div> : null}
{layoutPickerFor === 'grid' ? <div className="split-picker" role="menu" aria-label="选择四宫格排法">
  <button role="menuitem" onClick={() => { arrangeSelection('grid', { cols: 2 }); setLayoutPickerFor(null) }}><span className="split-choice choice-grid"><i/><i/><i/><i/></span><b>2×2</b><small>四宫格</small></button>
  <button role="menuitem" onClick={() => { arrangeSelection('grid', { cols: 4 }); setLayoutPickerFor(null) }}><span className="split-choice choice-columns"><i/><i/><i/><i/></span><b>四列</b><small>左右并排 1×4</small></button>
  <button role="menuitem" onClick={() => { arrangeSelection('grid', { cols: 1 }); setLayoutPickerFor(null) }}><span className="split-choice choice-rows"><i/><i/><i/><i/></span><b>四行</b><small>上下堆叠 4×1</small></button>
</div> : null}
{showSplitPicker && sameCanvasSelectionCount === 2 ? <div className="split-picker" role="menu" aria-label="选择二分屏方向">{([['columns-equal','左右','1:1'],['rows-equal','上下','1:1'],['columns-wide','左右','2:1'],['rows-wide','上下','2:1']] as [SplitMode,string,string][]).map(([mode,label,ratio]) => <button key={mode} role="menuitem" onClick={() => arrangeSplit(mode)}><span className={`split-choice ${mode.startsWith('columns') ? 'choice-columns' : 'choice-rows'} ${mode.endsWith('wide') ? 'choice-wide' : ''}`}><i/><i/></span><b>{label}</b><small>{ratio}</small></button>)}</div> : null}</aside> : null}

    <div className="canvas-viewport spatial-viewport"><SpatialSurface canvas={rootCanvas} spaces={spaces} items={items} surfacePaintOrder={surfacePaintOrder} selectedIds={selectedIds} activeCanvasId={activeCanvasId} activeSound={activeSound} highlightedCanvasId={highlightedCanvasId} cardTitlebarVisibility={cardTitlebarVisibility} sleepingCanvasIds={sleepingCanvasIds} focusedWorkspaceId={focusedWorkspaceId} spawnAnchor={spawnAnchor} onSetAnchor={setAnchor} onContextMenu={setContextMenu} onViewport={setCanvasViewport} onSelect={selectItems} onMove={moveItems} onUpdateItems={updateItems} onResize={resizeItem} onMerge={mergeItems} onReparent={reparentItems} onActivateCanvas={setActiveCanvasId} onActivateItem={activateItem} onPin={togglePin} onDuplicate={duplicateItems} onDoubleClick={doubleClickItem} onToggleWorkspaceFocus={toggleWorkspaceFocus} onWorkspaceSplit={updateWorkspaceSplit} onPushHistory={pushHistory} onRenameCanvas={renameCanvas} onDissolve={dissolveCanvas} onFixedEntry={focusEntry} onWakeCanvas={wakeCanvas} onIdleCanvas={idleCanvas} onInteractionState={setCanvasInteractionState} organizeRequest={organizeRequest} onOrganizeComplete={completeTypeOrganization}/><div className="canvas-hud global-hud"><button onClick={undo} title="撤销">{uiIcon('undo', 16)}</button><button onClick={() => setCanvasViewport(ROOT_ID, initialRootViewport())} title="回到全景">{uiIcon('eye', 16)}</button><button className="zoom-label" onClick={() => setCanvasViewport(activeCanvas.id, { ...activeCanvas.viewport, scale: 1 })}>{Math.round(activeCanvas.viewport.scale * 100)}%</button><span>元素可跨画布边界移动 · 静默画布靠近唤醒 · 滚轮缩放 · 中键平移</span></div></div>

    {focusedWorkspace && (focusedCanvas || focusedWorkspace.kind !== 'workspace') ? <section ref={focusStageRef} className={`focused-workspace ${isFallbackFullscreen ? 'fallback-fullscreen' : ''} ${focusedWorkspace.pipHidden ? 'card-pip-hidden' : ''}`} data-focused-workspace={focusedWorkspace.id}>
      <header className="focused-titlebar" onPointerDown={(event) => {
        if (event.button !== 0) return
        // 这里绝对不能 preventDefault。按 Pointer Events 规范，pointerdown 上的
        // preventDefault 会连带压掉 mousedown / click / dblclick 这些兼容事件，
        // 下面的 onDoubleClick 就永远收不到，双击还原随之失效——普通窗口标题栏
        // 因为提前 return 没走到这一步，所以表现为「能最大化、不能还原」。
        // 防止双击选中文字由 CSS 的 user-select: none 负责，不需要 preventDefault。
        event.stopPropagation()
      }} onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        toggleWorkspaceFocus(focusedWorkspace)
      }}>
        <span className="focused-kind">{focusedWorkspace.kind === 'folder' ? uiIcon('folder', 15) : focusedWorkspace.kind === 'web' ? uiIcon('eye', 15) : '▣'}</span><strong>{focusedWorkspace.title}</strong><span className="focused-state">已保存原位置 · 再次双击恢复</span><span className="window-spacer"/><small>{isFullscreen ? <><ShortcutText id="overlay.close"/> 退出全屏</> : '应用内最大化'}</small>{focusedWorkspace.workspaceSplit ? <button title="退出分屏" onPointerDown={(event) => event.stopPropagation()} onClick={() => { pushHistory(); updateWorkspaceSplit(focusedWorkspace.id, undefined) }}>{uiIcon('split', 17)}</button> : null}<button title={isFullscreen ? '退出全屏' : '全屏'} onPointerDown={(event) => event.stopPropagation()} onClick={toggleNativeFullscreen}>{uiIcon(isFullscreen ? 'restore' : 'fullscreen', 18)}</button><button title="恢复窗口" onPointerDown={(event) => event.stopPropagation()} onClick={() => toggleWorkspaceFocus(focusedWorkspace)}>{uiIcon('restore', 17)}</button>
      </header>
      <div ref={focusBodyRef} className="focused-workspace-body">
        <SplitTreeView layout={focusedWorkspace.workspaceSplit} primary={focusedCanvas ? <SpatialSurface canvas={focusedCanvas} spaces={spaces} items={items} surfacePaintOrder={surfacePaintOrder} selectedIds={selectedIds} activeCanvasId={activeCanvasId} activeSound={activeSound} highlightedCanvasId={highlightedCanvasId} cardTitlebarVisibility={cardTitlebarVisibility} embedded sleepingCanvasIds={sleepingCanvasIds} focusedWorkspaceId={focusedWorkspaceId} spawnAnchor={spawnAnchor} onSetAnchor={setAnchor} onContextMenu={setContextMenu} onViewport={setCanvasViewport} onSelect={selectItems} onMove={moveItems} onUpdateItems={updateItems} onResize={resizeItem} onMerge={mergeItems} onReparent={reparentItems} onActivateCanvas={setActiveCanvasId} onActivateItem={activateItem} onPin={togglePin} onDuplicate={duplicateItems} onDoubleClick={doubleClickItem} onToggleWorkspaceFocus={toggleWorkspaceFocus} onWorkspaceSplit={updateWorkspaceSplit} onPushHistory={pushHistory} onRenameCanvas={renameCanvas} onDissolve={dissolveCanvas} onFixedEntry={focusEntry} onWakeCanvas={wakeCanvas} onIdleCanvas={idleCanvas} onInteractionState={setCanvasInteractionState} organizeRequest={organizeRequest} onOrganizeComplete={completeTypeOrganization}/> : <div className="focused-window-body"><ItemBody item={focusedWorkspace} audible={activeSound === focusedWorkspace.id} paintOrder={surfacePaintOrder.get(focusedWorkspace.id) ?? 0}/></div>} interactive onChange={(layout) => updateWorkspaceSplit(focusedWorkspace.id, layout)} onPushHistory={pushHistory}/>
        <div className="focus-edge-help">任意视口的四条边都能向内拖出新分屏，分出来的还能继续分</div>
      </div>
    </section> : null}

    {spaceNavigatorOpen ? <aside
      className="space-navigator"
      style={navigatorPos ? { left: navigatorPos.x, top: navigatorPos.y, right: 'auto', bottom: 'auto' } : undefined}
      onPointerMove={moveNavigatorDrag}
      onPointerUp={endNavigatorDrag}
      onPointerCancel={endNavigatorDrag}
    ><header className="navigator-head" onPointerDown={beginNavigatorDrag} title="按住这里可以拖动面板"><div><b>空间导航器</b><small>鼠标当前：{activeCanvas.title}</small></div><span>L{activeCanvas.level}/{MAX_CANVAS_LEVEL}</span><button type="button" className="navigator-close" title="关闭空间导航器（Ctrl+Shift+L 再开）" aria-label="关闭空间导航器" onClick={() => setSpaceNavigatorOpen(false)}>{uiIcon('close', 13)}</button></header><div className="navigator-tree" onWheel={stopWheelPropagation}>{spaces.map((canvas) => {
      const canvasItems = items.filter((item) => item.canvasId === canvas.id)
      const expanded = navigatorExpandedCanvases.has(canvas.id)
      return <section className={`navigator-canvas level-${canvas.level}`} key={canvas.id}>
        <div className={`navigator-canvas-row ${canvas.id === activeCanvasId ? 'active' : ''}`}><button className="navigator-disclosure" title={expanded ? '折叠画布内容' : '展开画布内容'} aria-expanded={expanded} onClick={() => setNavigatorExpandedCanvases((current) => { const next = new Set(current); if (next.has(canvas.id)) next.delete(canvas.id); else next.add(canvas.id); return next })}>{uiIcon(expanded ? 'up' : 'forward', 12)}</button><button className="navigator-canvas-focus" onClick={() => focusCanvas(canvas.id)} onDoubleClick={() => emphasizeCanvas(canvas.id)}><i/><span><b>{canvas.title}</b><small>{canvasItems.length} 个元素 · {Math.round(canvas.viewport.scale * 100)}%</small></span><em>L{canvas.level}</em></button></div>
        {expanded ? <div className="navigator-groups">{ORGANIZE_GROUPS.map((group) => {
          const grouped = canvasItems.filter((item) => (group.kinds as readonly ItemKind[]).includes(item.kind))
          if (!grouped.length) return null
          const groupId = `${canvas.id}:${group.key}`
          const collapsed = navigatorCollapsedGroups.has(groupId)
          return <div className="navigator-group" key={groupId}><button className="navigator-group-head" aria-expanded={!collapsed} onClick={() => setNavigatorCollapsedGroups((current) => { const next = new Set(current); if (next.has(groupId)) next.delete(groupId); else next.add(groupId); return next })}><span>{uiIcon(collapsed ? 'forward' : 'up', 10)}{group.label}</span><em>{grouped.length}</em></button>{!collapsed ? <div className="navigator-items">{grouped.slice(0, 50).map((item) => <button key={item.id} className={selectedIds.includes(item.id) ? 'selected' : ''} title={`${item.title}（双击聚焦）`} onClick={() => focusNavigatorItem(item)} onDoubleClick={() => emphasizeNavigatorItem(item)}><span>{uiIcon(item.kind === 'folder' ? 'folder' : item.kind === 'web' ? 'eye' : item.kind === 'image' || item.kind === 'reference' ? 'image' : item.kind === 'video' ? 'video' : item.kind === 'note' ? 'document' : 'grid', 11)}<b>{item.title}</b></span></button>)}{grouped.length > 50 ? <small className="navigator-more">还有 {grouped.length - 50} 个，先折叠显示</small> : null}</div> : null}</div>
        })}</div> : null}
      </section>
    })}</div><footer><i className="cursor-route"/>点元素即可定位，不改变缩放</footer></aside> : null}

    {bootMode === 'ask' ? <div className="modal-backdrop"><section className="restore-dialog" aria-busy={restorePending}><span className="restore-mark">C</span><h2>继续上次的掌中界？</h2><p>{restorePending ? '正在恢复画布并确认原保存位置…' : '可以完整恢复三层画布关系、每层缩放、固定栏和元素位置。网页声音保持静音，点击后才重新发声。'}</p><div><button onClick={() => openTemplates()} disabled={restorePending}>从模板开始…</button><button className="primary" onClick={restoreSession} disabled={restorePending}>{restorePending ? '正在恢复…' : '还原上次状态'}</button><button onClick={freshSession} disabled={restorePending}>打开默认桌布</button></div></section></div> : null}

    {shellPreviewTarget ? <ShellSuperPreview
      target={shellPreviewTarget}
      data={shellPreviewData?.path === shellPreviewTarget.entry.path ? shellPreviewData : null}
      onClose={() => setShellPreviewTarget(null)}
      onOpenContent={() => window.chrome?.webview?.postMessage({ type: 'native-open-path', path: shellPreviewTarget.entry.path })}
      onOpenLocation={() => {
        const parentPath = shellPreviewData?.parentPath
        if (parentPath) {
          postNativeExplorerOpen(shellPreviewTarget.surfaceId, parentPath)
          // 目标目录可能和当前目录相同（本来就是「打开位置」），所以显式让树展开，不能只靠 activePath 变化
          window.dispatchEvent(new CustomEvent(FILE_TREE_REVEAL_EVENT, { detail: { itemId: shellPreviewTarget.surfaceId, path: parentPath, file: shellPreviewTarget.entry.path } }))
        }
        setShellPreviewTarget(null)
      }}
      onPreviewFile={(entry, siblings) => setShellPreviewTarget({ surfaceId: shellPreviewTarget.surfaceId, entry, siblings })}
      onSiblingsChange={updateShellPreviewSiblings}
      onFavorite={favoriteShellItem}
    /> : previewItem ? <SuperPreview
      item={previewItem}
      canvas={previewCanvas}
      breadcrumb={breadcrumb}
      onClose={() => setPreviewId(null)}
    /> : null}
    {toast ? <div className="toast">{toast}</div> : null}
  </main>
}

export default App
