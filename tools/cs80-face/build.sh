#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$DIR/bin"
mkdir -p "$BIN_DIR"

OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  CC_QDC1="${CC:-clang}"
  "$CC_QDC1" -O2 -o "$BIN_DIR/qdc1" "$DIR/qdc1.c" "$DIR/lz4.c" -framework IOKit -framework CoreFoundation
  "$CC_QDC1" -O3 -shared -fPIC -Wall -Wextra -o "$BIN_DIR/fast565.so" "$DIR/fast565.c"
else
  CC_BIN="${CC:-gcc}"
  "$CC_BIN" -O2 -o "$BIN_DIR/qdc1" "$DIR/qdc1.c" "$DIR/lz4.c"
  "$CC_BIN" -O3 -shared -fPIC -Wall -Wextra -o "$BIN_DIR/fast565.so" "$DIR/fast565.c"
fi

chmod +x "$BIN_DIR/qdc1"
echo "Built $BIN_DIR/qdc1 and $BIN_DIR/fast565.so"
