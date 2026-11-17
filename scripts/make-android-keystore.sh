#!/usr/bin/env bash
# Creates the permanent Android signing key for the society's app.
# Run ONCE. Keep the output safe forever (two copies, e.g. committee Google Drive + a USB drive):
# losing it means every resident has to uninstall and reinstall to get future versions.
#
# Usage: scripts/make-android-keystore.sh [output-dir]     (needs Java's keytool)
set -euo pipefail
out="${1:-./android-signing}"
mkdir -p "$out"
ks="$out/gatepass-release.keystore"
[ -e "$ks" ] && { echo "Refusing to overwrite existing $ks"; exit 1; }

pass="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
alias=gatepass
keytool -genkeypair -noprompt -storetype PKCS12 -keystore "$ks" -alias "$alias" \
  -keyalg RSA -keysize 4096 -validity 10950 -storepass "$pass" -keypass "$pass" \
  -dname "CN=${SOCIETY_NAME:-Gatepass}, O=${SOCIETY_NAME:-Gatepass} Residents Association, C=IN" >/dev/null 2>&1

base64 -w0 "$ks" > "$out/ANDROID_KEYSTORE_BASE64.txt" 2>/dev/null || base64 -i "$ks" | tr -d '\n' > "$out/ANDROID_KEYSTORE_BASE64.txt"
sha256="$(keytool -list -v -keystore "$ks" -storepass "$pass" -alias "$alias" | awk '/SHA256:/{print $2; exit}')"

cat > "$out/README-SIGNING.txt" <<TXT
Gatepass Android signing key  (created $(date +%F))
=================================================
KEEP THIS FOLDER PRIVATE AND BACKED UP. Anyone with it can publish an app that phones accept as Gatepass.

Keystore file : gatepass-release.keystore
Key alias     : $alias
Password      : $pass      (same for keystore and key)
SHA-256       : $sha256    (Firebase / Play Console may ask for this)
Valid until   : ~30 years

GitHub Actions secrets (repo → Settings → Secrets and variables → Actions → New repository secret):
  ANDROID_KEYSTORE_BASE64   = entire contents of ANDROID_KEYSTORE_BASE64.txt
  ANDROID_KEYSTORE_PASSWORD = $pass
  ANDROID_KEY_ALIAS         = $alias

To build on your own computer, create android/keystore.properties (never commit it):
  storeFile=/full/path/to/gatepass-release.keystore
  storePassword=$pass
  keyAlias=$alias
  keyPassword=$pass
TXT
chmod 600 "$out"/*
echo "Signing key created in $out — read $out/README-SIGNING.txt"
