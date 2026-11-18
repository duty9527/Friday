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

KEYSTORE="$BUILD_DIR/debug.keystore"
PASS_FILE="$BUILD_DIR/keystore.pass"
STAGING_DIR="$BUILD_DIR/.staging"

trap 'rm -rf "$STAGING_DIR"' EXIT
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/gen" "$STAGING_DIR/classes" "$STAGING_DIR/dex"

if [ ! -f "$PASS_FILE" ]; then
  echo "Generating local random keystore password..."
  (
    umask 077
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import secrets; print(secrets.token_hex(24))' > "$PASS_FILE"
    else
      od -An -tx1 -N24 /dev/urandom | tr -d ' \n' > "$PASS_FILE"
      printf '\n' >> "$PASS_FILE"
    fi
  )
  # Rotate any legacy keystore created without PASS_FILE so password matches cleanly.
  rm -f "$KEYSTORE"
fi
chmod 0600 "$PASS_FILE"

echo "[1/6] Compiling resources with aapt2..."
"$BUILD_TOOLS/aapt2" compile \
  --dir "$SCRIPT_DIR/res" \
  -o "$STAGING_DIR/res.zip"

echo "[2/6] Linking manifest and resources with aapt2..."
"$BUILD_TOOLS/aapt2" link \
  -o "$STAGING_DIR/unsigned.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$SCRIPT_DIR/AndroidManifest.xml" \
  --java "$STAGING_DIR/gen" \
  "$STAGING_DIR/res.zip"

echo "[3/6] Compiling Java sources with javac..."
mapfile -t JAVA_FILES < <(find "$SCRIPT_DIR/src" "$STAGING_DIR/gen" -name "*.java" | sort)
"$JAVA_HOME/bin/javac" \
  --release 11 \
  -encoding UTF-8 \
  -classpath "$ANDROID_JAR" \
  -d "$STAGING_DIR/classes" \
  "${JAVA_FILES[@]}"

echo "[4/6] Converting bytecode to DEX with d8..."
mapfile -t CLASS_FILES < <(find "$STAGING_DIR/classes" -name "*.class" | sort)
"$BUILD_TOOLS/d8" \
  --lib "$ANDROID_JAR" \
  --min-api 30 \
  --output "$STAGING_DIR/dex" \
  "${CLASS_FILES[@]}"

(
  cd "$STAGING_DIR/dex"
  "$JAVA_HOME/bin/jar" -uf "$STAGING_DIR/unsigned.apk" classes.dex
)

echo "[5/6] Aligning APK with zipalign..."
"$BUILD_TOOLS/zipalign" -f -p 4 \
  "$STAGING_DIR/unsigned.apk" \
  "$STAGING_DIR/aligned.apk"

if [[ ! -f "$KEYSTORE" ]]; then
  echo "Generating local debug keystore..."
  (
    umask 077
    "$JAVA_HOME/bin/keytool" -genkeypair \
      -keystore "$KEYSTORE" \
      -storepass:file "$PASS_FILE" \
      -keypass:file "$PASS_FILE" \
      -alias androiddebugkey \
      -keyalg RSA \
      -keysize 2048 \
      -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
  )
fi
chmod 0600 "$KEYSTORE"

echo "[6/6] Signing APK with apksigner..."
FRIDAY_KS_PASS="$(tr -d '\r\n' < "$PASS_FILE")"
export FRIDAY_KS_PASS
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias androiddebugkey \
  --ks-pass "env:FRIDAY_KS_PASS" \
  --key-pass "env:FRIDAY_KS_PASS" \
  --out "$STAGING_DIR/friday-tv-agent.apk" \
  "$STAGING_DIR/aligned.apk"
unset FRIDAY_KS_PASS

"$BUILD_TOOLS/apksigner" verify "$STAGING_DIR/friday-tv-agent.apk"

mkdir -p "$BUILD_DIR"
mv -f "$STAGING_DIR/friday-tv-agent.apk" "$BUILD_DIR/friday-tv-agent.apk"
if [ -f "$STAGING_DIR/friday-tv-agent.apk.idsig" ]; then
  mv -f "$STAGING_DIR/friday-tv-agent.apk.idsig" "$BUILD_DIR/friday-tv-agent.apk.idsig"
fi
ls -lh "$BUILD_DIR/friday-tv-agent.apk"
echo "Build complete: $BUILD_DIR/friday-tv-agent.apk"
