#!/bin/bash
# 掌中界 · 统一打包脚本（版本号定点替换，产物一律进 D:\掌中界\，不再堆 D 盘根目录）
#
# 用法：
#   bash installer/pack.sh <新版本> <旧版本> <使用说明片段.md> [--publish-only]
# 例：
#   bash installer/pack.sh 1.0.94 1.0.93 /c/Users/MSI/AppData/Local/Temp/zzj-qa/note-1.0.94.md
#   bash installer/pack.sh 1.0.94 1.0.93 /dev/null --publish-only   # 只重发产物、不编译
#
# 产物布局（用户 2026-09-18 要求：D 盘根目录不再堆文件）：
#   D:\掌中界\安装包\             ← 当前版本：ZhangZhongJie-Setup-<ver>-x64.exe + 使用说明.md
#   D:\掌中界\历史安装包\<ver>\   ← 上一版自动挪进来（exe + 它的使用说明.md）
#   D:\掌中界\回滚版\             ← 1.0.59-功能齐全版.exe + <ver>-最新回滚点.exe（旧的回滚点自动删）
#   D:\掌中界\组合包\掌中界+Hermes装机包-2026.09.12\第二步-安装掌中界\
#   D:\掌中界\发同事测试\         ← 给同事的 zip（由 installer/make-test-package.sh 生成）
set -e

# 原生程序（python/powershell）不认 MSYS 路径 /d/xxx —— 传参前先转成 D:/xxx
winpath() { printf '%s' "$1" | sed -E 's|^/([a-zA-Z])/|\1:/|'; }

VER="$1"; OLD="$2"; NOTE="$3"; MODE="${4:-}"

REPO=/d/Users/Documents/zzj-review
ROOT=/d/掌中界
PKG="$ROOT/安装包"
HIST="$ROOT/历史安装包"
RB="$ROOT/回滚版"
COMBO="$ROOT/组合包/掌中界+Hermes装机包-2026.09.12/第二步-安装掌中界"
ISS="$REPO/installer/ZhangZhongJie.iss"
OUT="$REPO/installer/output/ZhangZhongJie-Setup-$VER-x64.exe"

[ -n "$VER" ] && [ -n "$OLD" ] || { echo "用法: pack.sh <新版本> <旧版本> <说明片段.md> [--publish-only]"; exit 1; }

if [ "$MODE" != "--publish-only" ]; then
  echo "── 1/4 版本号定点替换（只动 MyAppVersion 那一行）"
  python - "$(winpath "$ISS")" "$VER" <<'PY'
import re, sys
p, ver = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8', errors='replace').read()
s2, n = re.subn(r'#define MyAppVersion "[^"]+"', f'#define MyAppVersion "{ver}"', s)
assert n == 1, '没找到 MyAppVersion'
if s2 != s:
    open(p, 'w', encoding='utf-8', errors='replace').write(s2)
    print('  iss ->', ver)
else:
    print('  iss 已经是', ver)
PY

  echo "── 2/4 编译（前端 + 原生 + 安装器）"
  cd "$REPO"
  npx tsc -b --force --pretty false
  npm run build
  powershell -ExecutionPolicy Bypass -File ./native/build.ps1 2>&1 | grep -iE "个错误|error C" || true
  powershell -ExecutionPolicy Bypass -File ./installer/build-installer.ps1 2>&1 | tail -1

  echo "── 3/4 等安装器写完（尺寸稳定）"
  for i in $(seq 1 40); do
    SZ=$(stat -c%s "$OUT" 2>/dev/null || echo 0); sleep 3
    SZ2=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
    [ "$SZ" = "$SZ2" ] && [ "$SZ" -gt 40000000 ] && { echo "  稳定 $SZ B"; break; }
  done
fi

echo "── 4/4 发布到 D:\\掌中界\\"
[ -f "$OUT" ] || { echo "缺安装器：$OUT"; exit 1; }
mkdir -p "$PKG" "$HIST" "$RB" "$COMBO"

# 上一版挪进 历史安装包\<旧版>（如果还在 安装包\ 里）
if ls "$PKG"/ZhangZhongJie-Setup-$OLD-x64.exe >/dev/null 2>&1; then
  mkdir -p "$HIST/$OLD"
  cp -a "$PKG"/. "$HIST/$OLD/" && rm -f "$PKG"/ZhangZhongJie-Setup-$OLD-x64.exe "$PKG"/使用说明.md
  echo "  旧版 $OLD → 历史安装包\\$OLD\\"
fi

cp "$OUT" "$PKG/ZhangZhongJie-Setup-$VER-x64.exe"

# 使用说明：把这一版的片段插到最前面（片段文件为空/不存在就跳过）
if [ -f "$NOTE" ] && [ -s "$NOTE" ]; then
  python - "$(winpath "$PKG/使用说明.md")" "$(winpath "$NOTE")" "$VER" "$OLD" <<'PY'
import sys, os, re
dst, note, ver, old = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
body = open(note, encoding='utf-8').read().rstrip() + '\n\n'
if os.path.exists(dst):
    s = open(dst, encoding='utf-8', newline='').read()
    # 标题行 / 安装文件名 / 双击说明 三处定点替换
    s = s.replace(f'# 掌中界 {old} 安装说明', f'# 掌中界 {ver} 安装说明', 1)
    s = s.replace(f'ZhangZhongJie-Setup-{old}-x64.exe', f'ZhangZhongJie-Setup-{ver}-x64.exe')
    # 新片段插到第一个 '## ' 之前（版本历史从上往下、新的在前）
    m = re.search(r'^## 1\.0\.\d', s, re.M) or re.search(r'^## ', s, re.M)
    s = (s[:m.start()] + body + s[m.start():]) if m else (s.rstrip() + '\n\n' + body)
else:
    s = f'# 掌中界 {ver} 安装说明\n\n{body}'
open(dst, 'w', encoding='utf-8', newline='').write(s)
print('  使用说明已更新（新版本段插到最前）')
PY
fi

# 使用手册：放一份到根目录（方便直接发人；安装包内部也带）
cp "$(dirname "$0")/使用手册.html" "$ROOT/使用手册.html"

# 回滚点：刷新成最新，删掉上一个
cp "$PKG/ZhangZhongJie-Setup-$VER-x64.exe" "$RB/$VER-最新回滚点.exe"
rm -f "$RB/$OLD-最新回滚点.exe"

# 组合包第二步
if [ -d "$(dirname "$COMBO")" ]; then
  mkdir -p "$COMBO"
  rm -f "$COMBO"/ZhangZhongJie-Setup-*.exe
  cp "$PKG/ZhangZhongJie-Setup-$VER-x64.exe" "$COMBO/"
  cp "$PKG/使用说明.md" "$COMBO/" 2>/dev/null || true
  echo "  组合包已同步"
fi

echo "── 产物"
ls -l "$PKG"
sha256sum "$PKG/ZhangZhongJie-Setup-$VER-x64.exe" "$RB/$VER-最新回滚点.exe"
echo "PACKAGE-DONE $VER"
