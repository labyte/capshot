#!/usr/bin/env bash
# 「一眼判别法」：确认 release 二进制真的内嵌了前端（custom-protocol 开着）。
# 没内嵌的壳在没有 vite 的机器上开出来就是一张错误网页，别把它发出去。
#
#   用法：bash scripts/verify-embed.sh [二进制路径] [前端产物目录]
#   例：  bash scripts/verify-embed.sh target/release/capshot.exe
#
# CI（ci.yml 两个平台）与 release.yml（build-windows / build-macos）三个调用点共用这一份。
#
# 探针名一律**取自前端产物目录里真实存在的 chunk 名**（带 hash），逐个按字节在二进制里找。
# 两条本机实测依据：custom-protocol 版命中全部 chunk 名，dev 版（不带该 feature）一个都不命中。
#
# 两个别再踩的坑：
#   1. 不要在 workflow 里写死某个 chunk 名（原来写的是 'TextInput-*.js'）。chunk 名随入口/
#      分包变化 —— 移除 editor 页之后 TextInput 不再是独立 chunk，那条正则就成了永远匹配
#      不上的**假失败**，mac 与 win 两个 job 一起红（v0.4.0 首次发布就是这样挂的）。
#   2. 不要改用 *.html 名当探针。dev 版二进制里同样有 index.html / settings.html 这些串
#      （实测 target/debug/capshot.exe 全命中），判不出内嵌与否。
set -u

BIN="${1:-target/release/capshot}"
ASSETS="${2:-ui/dist/assets}"

if [ ! -f "$BIN" ]; then
  echo "::error::$BIN 不存在（tauri build 没产出二进制？）"
  exit 1
fi
if [ ! -d "$ASSETS" ]; then
  echo "::error::$ASSETS 不存在（前端没构建？先跑 cd ui && npm run build）"
  exit 1
fi

missing=""
total=0
for f in "$ASSETS"/*; do
  [ -e "$f" ] || continue
  total=$((total + 1))
  n=$(basename "$f")
  # LC_ALL=C 是必须的：macOS 的 BSD grep 在 UTF-8 locale 下啃 20MB 无换行的 Mach-O 会
  # **静默失配**（实测同一份产物 GNU grep 命中、runner 上的 BSD grep 不命中）。
  # C locale 按单字节处理，GNU/BSD 行为一致，顺带更快。
  if ! LC_ALL=C grep -a -q -F "$n" "$BIN"; then
    missing="$missing $n"
  fi
done

size=$(stat -c%s "$BIN" 2>/dev/null || stat -f%z "$BIN" 2>/dev/null || echo "?")

if [ -z "$missing" ]; then
  echo "自检通过：$BIN 已内嵌 $total 个前端 chunk（$size bytes）"
  exit 0
fi

echo "::error::$BIN 未内嵌前端（custom-protocol 没开？漏：$missing）"
echo "--- 二进制里命中的 assets/* ---"
LC_ALL=C grep -a -o -E 'assets/[A-Za-z0-9_.-]+\.(js|css)' "$BIN" | sort -u | head -20 || true
exit 1
