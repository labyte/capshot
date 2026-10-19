#!/bin/sh
# 组装 capshot.app（无 tauri-cli 依赖）：capshot 二进制 + Info.plist + ad-hoc 签名
set -e
BIN=${1:-target/release/capshot}
OUT=${2:-dist/capshot.app}
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/capshot"
[ -f apps/desktop/icons/icon.png ] && cp apps/desktop/icons/icon.png "$OUT/Contents/Resources/icon.png"
cat > "$OUT/Contents/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>capshot</string>
  <key>CFBundleIdentifier</key><string>app.capshot.desktop</string>
  <key>CFBundleName</key><string>capshot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PL
codesign --force --deep -s - "$OUT" 2>/dev/null || echo "codesign skipped"
echo "built: $OUT"
