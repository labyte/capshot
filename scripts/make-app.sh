#!/bin/sh
# 组装 capshot.app（无 tauri-cli 依赖）：capshot 二进制 + Info.plist + 图标 + ad-hoc 签名
set -e
BIN=${1:-target/release/capshot}
OUT=${2:-dist/capshot.app}
CONF=apps/desktop/tauri.conf.json

# 版本跟 tauri.conf.json 走，别再硬写（以前固定在 0.1.0，「关于」和 Finder 简介都是错的）
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONF" | head -1)
[ -n "$VERSION" ] || VERSION=0.1.0

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/capshot"

# 图标：macOS 认的是 .icns + Info.plist 的 CFBundleIconFile，
# 光扔一个 icon.png 进 Resources 是不显示的（Finder/Dock 给通用图标）。
# 注意 set -e 下别写 `[ -f x ] && cp`：文件不存在时整条返回 1，脚本会直接退出。
if [ -f apps/desktop/icons/icon.icns ]; then
  cp apps/desktop/icons/icon.icns "$OUT/Contents/Resources/icon.icns"
else
  echo "warn: apps/desktop/icons/icon.icns 缺失，.app 将没有图标" >&2
fi
if [ -f apps/desktop/icons/icon.png ]; then
  cp apps/desktop/icons/icon.png "$OUT/Contents/Resources/icon.png"
fi

cat > "$OUT/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>capshot</string>
  <key>CFBundleIdentifier</key><string>app.capshot.desktop</string>
  <key>CFBundleName</key><string>capshot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PL
codesign --force --deep -s - "$OUT" 2>/dev/null || echo "codesign skipped"
echo "built: $OUT (version $VERSION)"
