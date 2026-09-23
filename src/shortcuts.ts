export type ShortcutGroup = '全局' | '全局常用' | '画布菜单' | '元素菜单' | '文件列表' | '网页卡片' | '超级预览' | '截图'

export const SHORTCUT_DEFINITIONS = [
  { id: 'app.settings', label: '打开设置', group: '全局', defaultBinding: 'Ctrl+,' },
  { id: 'app.search', label: '聚焦顶栏搜索', group: '全局', defaultBinding: 'Ctrl+K' },
  { id: 'history.undo', label: '撤销', group: '全局', defaultBinding: 'Ctrl+Z' },
  { id: 'history.redo', label: '重做', group: '全局', defaultBinding: 'Ctrl+Y' },
  { id: 'project.save', label: '保存', group: '全局', defaultBinding: 'Ctrl+S' },
  { id: 'project.saveAs', label: '另存为', group: '全局', defaultBinding: 'Ctrl+Alt+S' },
  { id: 'window.snapLeft', label: '挑程序分屏（程序在左，掌中界在右）', group: '全局', defaultBinding: 'Ctrl+Shift+Left' },
  { id: 'window.snapRight', label: '挑程序分屏（程序在右，掌中界在左）', group: '全局', defaultBinding: 'Ctrl+Shift+Right' },
  { id: 'window.snapLayout', label: '打开贴靠布局面板', group: '全局', defaultBinding: 'Ctrl+Shift+Z' },
  { id: 'window.tile', label: '平铺多个窗口（带布局模板的旧面板）', group: '全局', defaultBinding: 'Ctrl+Shift+T' },
  { id: 'window.maximize', label: '最大化 / 还原窗口', group: '全局', defaultBinding: 'Alt+Enter' },
  { id: 'canvas.addWeb', label: '添加网页', group: '画布菜单', defaultBinding: 'Ctrl+Shift+W' },
  { id: 'canvas.export', label: '导出（参考板 / 批量图片）', group: '画布菜单', defaultBinding: 'Ctrl+Shift+P' },
  { id: 'canvas.addComputer', label: '打开此电脑', group: '画布菜单', defaultBinding: 'Ctrl+Shift+E' },
  { id: 'canvas.copy', label: '复制画布元素', group: '画布菜单', defaultBinding: 'Ctrl+C' },
  { id: 'canvas.paste', label: '粘贴到此处', group: '画布菜单', defaultBinding: 'Ctrl+V' },
  { id: 'canvas.organize', label: '按类型整理', group: '画布菜单', defaultBinding: 'Ctrl+Shift+A' },
  { id: 'canvas.toggleNavigator', label: '显示 / 隐藏空间导航器', group: '画布菜单', defaultBinding: 'Ctrl+Shift+L' },
  { id: 'window.splitUp', label: '与外部程序分屏（上下两分，掌中界在上）', group: '全局', defaultBinding: 'Ctrl+Up' },
  { id: 'window.splitDown', label: '与外部程序分屏（上下两分，掌中界在下）', group: '全局', defaultBinding: 'Ctrl+Down' },
  { id: 'canvas.spawn', label: '在此生成', group: '画布菜单', defaultBinding: '' },
  { id: 'selection.layout', label: '分屏布局', group: '画布菜单', defaultBinding: '' },
  { id: 'selection.ratio', label: '统一比例', group: '画布菜单', defaultBinding: '' },
  { id: 'project.export', label: '导出项目包', group: '画布菜单', defaultBinding: '' },
  { id: 'selection.duplicate', label: '复制一份', group: '元素菜单', defaultBinding: '' },
  { id: 'selection.collect', label: '打包到目录', group: '元素菜单', defaultBinding: '' },
  { id: 'selection.pin', label: '置顶 / 取消置顶', group: '元素菜单', defaultBinding: '' },
  { id: 'selection.group', label: '成组 / 解组', group: '元素菜单', defaultBinding: 'Ctrl+G' },
  { id: 'selection.delete', label: '删除选中', group: '元素菜单', defaultBinding: 'Delete' },
  { id: 'file.new', label: '新建', group: '文件列表', defaultBinding: 'Ctrl+Shift+N' },
  { id: 'file.cut', label: '剪切', group: '文件列表', defaultBinding: 'Ctrl+X' },
  { id: 'file.copy', label: '复制', group: '文件列表', defaultBinding: 'Ctrl+C' },
  { id: 'file.paste', label: '粘贴', group: '文件列表', defaultBinding: 'Ctrl+V' },
  { id: 'file.rename', label: '重命名', group: '文件列表', defaultBinding: 'F2' },
  { id: 'file.delete', label: '删除', group: '文件列表', defaultBinding: 'Delete' },
  { id: 'file.back', label: '返回上一级', group: '文件列表', defaultBinding: 'Backspace' },
  { id: 'file.refresh', label: '刷新', group: '文件列表', defaultBinding: 'F5' },
  { id: 'file.address', label: '编辑路径（地址栏）', group: '文件列表', defaultBinding: 'Ctrl+L' },
  { id: 'file.undo', label: '撤销文件操作', group: '文件列表', defaultBinding: 'Ctrl+Z' },
  { id: 'shelf.capture', label: '剪贴暂存：从剪贴板捕获', group: '文件列表', defaultBinding: '' },
  { id: 'file.open', label: '打开', group: '文件列表', defaultBinding: 'Enter' },
  { id: 'file.selectAll', label: '全选', group: '文件列表', defaultBinding: 'Ctrl+A' },
  { id: 'file.favorite', label: '收藏', group: '文件列表', defaultBinding: '' },
  { id: 'file.openLocation', label: '打开位置', group: '文件列表', defaultBinding: '' },
  { id: 'media.playExternal', label: '用本地播放器打开', group: '文件列表', defaultBinding: '' },
  { id: 'archive.openSevenZip', label: '用 7-Zip 打开压缩包', group: '文件列表', defaultBinding: '' },
  { id: 'browser.back', label: '后退', group: '网页卡片', defaultBinding: 'Alt+Left' },
  { id: 'browser.forward', label: '前进', group: '网页卡片', defaultBinding: 'Alt+Right' },
  { id: 'browser.reload', label: '刷新', group: '网页卡片', defaultBinding: 'Ctrl+R' },
  { id: 'browser.bookmark', label: '收藏当前网页', group: '网页卡片', defaultBinding: '' },
  { id: 'preview.toggle', label: '打开 / 关闭超级预览', group: '超级预览', defaultBinding: 'Space' },
  { id: 'overlay.close', label: '关闭预览 / 退出全屏', group: '超级预览', defaultBinding: 'Esc' },
  { id: 'preview.previous', label: '上一个文件', group: '超级预览', defaultBinding: 'Left' },
  { id: 'preview.next', label: '下一个文件', group: '超级预览', defaultBinding: 'Right' },
  { id: 'capture.region', label: '区域截图（存入剪贴暂存，全局生效）', group: '截图', defaultBinding: 'Ctrl+Alt+S' },
  { id: 'capture.fullscreen', label: '全屏截图（存入剪贴暂存，全局生效）', group: '截图', defaultBinding: 'Ctrl+Shift+F' },
  { id: 'capture.wechatTool', label: '截图工具（微信式：标注 / 长截图 / 取色，全局生效）', group: '截图', defaultBinding: 'Alt+A' },
  { id: 'quick.slot1', label: '启动全局常用 第 1 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+1' },
  { id: 'quick.slot2', label: '启动全局常用 第 2 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+2' },
  { id: 'quick.slot3', label: '启动全局常用 第 3 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+3' },
  { id: 'quick.slot4', label: '启动全局常用 第 4 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+4' },
  { id: 'quick.slot5', label: '启动全局常用 第 5 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+5' },
  { id: 'quick.slot6', label: '启动全局常用 第 6 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+6' },
  { id: 'quick.slot7', label: '启动全局常用 第 7 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+7' },
  { id: 'quick.slot8', label: '启动全局常用 第 8 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+8' },
  { id: 'quick.slot9', label: '启动全局常用 第 9 位（当前排）', group: '全局常用', defaultBinding: 'Ctrl+Alt+9' },
] as const satisfies readonly { id: string; label: string; group: ShortcutGroup; defaultBinding: string }[]

export type ShortcutId = typeof SHORTCUT_DEFINITIONS[number]['id']
export type ShortcutBindings = Record<ShortcutId, string>

export const DEFAULT_SHORTCUT_BINDINGS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((entry) => [entry.id, entry.defaultBinding]),
) as ShortcutBindings

export function normalizeShortcutBindings(value: unknown): ShortcutBindings {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map((entry) => {
    const current = candidate[entry.id]
    return [entry.id, typeof current === 'string' ? current.slice(0, 80) : entry.defaultBinding]
  })) as ShortcutBindings
}

export function shortcutDisplay(bindings: ShortcutBindings, id: ShortcutId) {
  return bindings[id] || '未设置'
}

function normalizedKey(key: string, code?: string) {
  const codeKeys: Record<string, string> = {
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
  }
  if (code && codeKeys[code]) return codeKeys[code]
  if (code === 'Space' || key === ' ') return 'Space'
  if (key === 'Escape') return 'Esc'
  if (key === 'Delete') return 'Delete'
  if (key === 'Backspace') return 'Backspace'
  if (key === 'Enter') return 'Enter'
  if (key === 'Tab') return 'Tab'
  if (key === 'Insert') return 'Insert'
  if (key === 'Pause') return 'Pause'
  if (key === 'PrintScreen') return 'PrintScreen'
  if (key === 'ArrowLeft') return 'Left'
  if (key === 'ArrowRight') return 'Right'
  if (key === 'ArrowUp') return 'Up'
  if (key === 'ArrowDown') return 'Down'
  if (key === 'Home') return 'Home'
  if (key === 'End') return 'End'
  if (key === 'PageUp') return 'PageUp'
  if (key === 'PageDown') return 'PageDown'
  if (/^Numpad\d$/.test(code ?? '')) return code!
  if (code === 'NumpadAdd') return 'NumpadAdd'
  if (code === 'NumpadSubtract') return 'NumpadSubtract'
  if (code === 'NumpadMultiply') return 'NumpadMultiply'
  if (code === 'NumpadDivide') return 'NumpadDivide'
  if (code === 'NumpadDecimal') return 'NumpadDecimal'
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase()
  return key.length === 1 ? key.toUpperCase() : key
}

export function bindingFromKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return ''
  const key = normalizedKey(event.key, event.code)
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Win')
  parts.push(key)
  return parts.join('+')
}

export function shortcutIdForEvent(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, bindings: ShortcutBindings, allowed?: readonly ShortcutId[]) {
  const binding = bindingFromKeyboardEvent(event)
  if (!binding) return undefined
  const allowedSet = allowed ? new Set<ShortcutId>(allowed) : undefined
  return SHORTCUT_DEFINITIONS.find((entry) => (!allowedSet || allowedSet.has(entry.id)) && bindings[entry.id] === binding)?.id
}

export function shortcutBindingProblem(binding: string) {
  if (!binding) return ''
  if (binding.includes('Win+')) return 'Win 系列组合键由 Windows 保留，不能绑定。'
  if (binding === 'Alt+F4') return 'Alt+F4 是系统关闭窗口快捷键，不能绑定。'
  if (['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A'].includes(binding)) return '这个组合键在输入框里有标准编辑含义，不能重新绑定。'
  if (/^[A-Z0-9]$/.test(binding)) return '不能绑定单独的字母或数字键，以免与输入冲突。'
  return ''
}
