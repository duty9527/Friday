#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

if [ -z "${JAVA_HOME:-}" ]; then
  if command -v javac >/dev/null 2>&1; then
    JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
  else
    for candidate in "$HOME"/.local/jdk* /usr/lib/jvm/java-17-* /usr/lib/jvm/java-*-openjdk* /usr/lib/jvm/default; do
      if [ -x "$candidate/bin/javac" ]; then
        JAVA_HOME="$candidate"
        break
      fi
    done
  fi
fi

if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if ! command -v javac >/dev/null 2>&1; then
  echo "ERROR: javac not found. Set JAVA_HOME or install JDK 17+." >&2
  exit 1
fi

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK_ROOT" ]; then
  for candidate in "$HOME/Android/Sdk" "$HOME/android-sdk" /opt/android-sdk /usr/lib/android-sdk; do
    if [ -d "$candidate/platforms" ]; then
      SDK_ROOT="$candidate"
      break
    fi
  done
fi

if [ -z "$SDK_ROOT" ] || [ ! -d "$SDK_ROOT/platforms" ]; then
  echo "ERROR: Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME." >&2
  exit 1
fi

ANDROID_JAR=""
if [ -d "$SDK_ROOT/platforms" ]; then
  LATEST_PLATFORM="$(find "$SDK_ROOT/platforms" -mindepth 1 -maxdepth 1 -type d -name 'android-*' | sort -V | tail -n 1)"
  if [ -n "$LATEST_PLATFORM" ] && [ -f "$LATEST_PLATFORM/android.jar" ]; then
    ANDROID_JAR="$LATEST_PLATFORM/android.jar"
  fi
fi

BUILD_TOOLS=""
if [ -d "$SDK_ROOT/build-tools" ]; then
  BUILD_TOOLS="$(find "$SDK_ROOT/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
fi

if [ -z "$ANDROID_JAR" ] || [ -z "$BUILD_TOOLS" ] || [ ! -x "$BUILD_TOOLS/d8" ]; then
  echo "ERROR: Missing android.jar or build-tools (d8/zipalign/apksigner) under SDK_ROOT=$SDK_ROOT." >&2
  exit 1
fi

rm -rf "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex" \
       "$BUILD_DIR/res.zip" "$BUILD_DIR/unsigned.apk" "$BUILD_DIR/aligned.apk" \
       "$BUILD_DIR/friday-tv-agent.apk" "$BUILD_DIR/friday-tv-agent.apk.idsig"
mkdir -p "$BUILD_DIR/gen" "$BUILD_DIR/classes" "$BUILD_DIR/dex"

echo "[1/6] Compiling resources with aapt2..."
"$BUILD_TOOLS/aapt2" compile \
  --dir "$SCRIPT_DIR/res" \
  -o "$BUILD_DIR/res.zip"

echo "[2/6] Linking manifest and resources with aapt2..."
"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD_DIR/unsigned.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$SCRIPT_DIR/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  "$BUILD_DIR/res.zip"

echo "[3/6] Compiling Java sources with javac..."
mapfile -t JAVA_FILES < <(find "$SCRIPT_DIR/src" "$BUILD_DIR/gen" -name "*.java" | sort)
"$JAVA_HOME/bin/javac" \
  --release 11 \
  -encoding UTF-8 \
  -classpath "$ANDROID_JAR" \
  -d "$BUILD_DIR/classes" \
  "${JAVA_FILES[@]}"

echo "[4/6] Converting bytecode to DEX with d8..."
mapfile -t CLASS_FILES < <(find "$BUILD_DIR/classes" -name "*.class" | sort)
"$BUILD_TOOLS/d8" \
  --lib "$ANDROID_JAR" \
  --min-api 30 \
  --output "$BUILD_DIR/dex" \
  "${CLASS_FILES[@]}"

(
  cd "$BUILD_DIR/dex"
  "$JAVA_HOME/bin/jar" -uf "$BUILD_DIR/unsigned.apk" classes.dex
)

echo "[5/6] Aligning APK with zipalign..."
"$BUILD_TOOLS/zipalign" -f -p 4 \
  "$BUILD_DIR/unsigned.apk" \
  "$BUILD_DIR/aligned.apk"

KEYSTORE="$BUILD_DIR/debug.keystore"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "Generating debug keystore..."
  "$JAVA_HOME/bin/keytool" -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

echo "[6/6] Signing APK with apksigner..."
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias androiddebugkey \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$BUILD_DIR/friday-tv-agent.apk" \
  "$BUILD_DIR/aligned.apk"

"$BUILD_TOOLS/apksigner" verify "$BUILD_DIR/friday-tv-agent.apk"
ls -lh "$BUILD_DIR/friday-tv-agent.apk"
echo "Build complete: $BUILD_DIR/friday-tv-agent.apk"
