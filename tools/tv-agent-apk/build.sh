#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

export JAVA_HOME="/home/duty/.local/jdk17"
export PATH="$JAVA_HOME/bin:$PATH"

ANDROID_JAR="/home/duty/Android/Sdk/platforms/android-34/android.jar"
BUILD_TOOLS="/home/duty/Android/Sdk/build-tools/36.0.0"

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
