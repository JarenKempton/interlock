#!/bin/sh
set -eu

REPOSITORY="${INTERLOCK_REPOSITORY:-JarenKempton/interlock}"
VERSION="${INTERLOCK_VERSION:-}"
INSTALL_DIR="${INTERLOCK_INSTALL_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
OS="${INTERLOCK_OS:-$(uname -s)}"
ARCH="${INTERLOCK_ARCH:-$(uname -m)}"

case "$OS" in
  Darwin|darwin) platform=darwin ;;
  Linux|linux) platform=linux ;;
  *) echo "interlock: unsupported operating system: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64|x64) machine=x64 ;;
  arm64|aarch64) machine=arm64 ;;
  *) echo "interlock: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

command -v curl >/dev/null 2>&1 || {
  echo "interlock: curl is required" >&2
  exit 1
}

release_tag() {
  awk -v prerelease="$1" '
    function fail() { invalid = 1; exit 1 }
    function token(    c) {
      sub(/^[ \t\r\n]+/, "", json)
      c = substr(json, 1, 1)
      if (c == "") { token_value = ""; return }
      if (c == "\"") {
        if (!match(json, /^"([^"\\\001-\037]|\\(["\\\/bfnrt]|u[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]))*"/)) fail()
      } else if (c ~ /[{}\[\],:]/ && c != "") {
        token_value = c; json = substr(json, 2); return
      } else if (!match(json, /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)/)) fail()
      token_value = substr(json, 1, RLENGTH)
      json = substr(json, RLENGTH + 1)
    }
    function value(    opening, key, field, tag, draft, pre, seen) {
      opening = token_value
      if (opening == "{") {
        token()
        if (token_value != "}") {
          while (1) {
            key = token_value
            if (substr(key, 1, 1) != "\"") fail()
            token(); if (token_value != ":") fail()
            token(); field = token_value
            depth++; value(); depth--
            if (depth == release_depth) {
              if (key == "\"tag_name\"") { if (seen ~ /t/) fail(); seen = seen "t"; tag = field }
              if (key == "\"draft\"") { if (seen ~ /d/) fail(); seen = seen "d"; draft = field }
              if (key == "\"prerelease\"") { if (seen ~ /p/) fail(); seen = seen "p"; pre = field }
            }
            if (token_value == "}") break
            if (token_value != ",") fail()
            token()
          }
        }
        if (depth == release_depth && draft == "false" && pre == prerelease && selected == "") {
          if (tag !~ /^"v?[0-9][A-Za-z0-9.+-]*"$/ && !(pre == "true" && tag == "\"nightly\"")) fail()
          selected = substr(tag, 2, length(tag) - 2)
        }
        token()
      } else if (opening == "[") {
        token()
        if (token_value != "]") {
          while (1) {
            depth++; value(); depth--
            if (token_value == "]") break
            if (token_value != ",") fail()
            token()
          }
        }
        token()
      } else {
        if (opening == "" || opening ~ /^[}\],:]$/) fail()
        token()
      }
    }
    { json = json $0 "\n" }
    END {
      if (invalid) exit 1
      token()
      if (prerelease == "true") { if (token_value != "[") fail(); release_depth = 1 }
      else { if (token_value != "{") fail(); release_depth = 0 }
      value()
      if (token_value != "" || selected == "") exit 1
      print selected
    }
  '
}

asset="interlock-$platform-$machine"
if [ -n "${INTERLOCK_BASE_URL:-}" ]; then
  base=${INTERLOCK_BASE_URL%/}
else
  if [ -z "$VERSION" ]; then
    api_response=$(mktemp "${TMPDIR:-/tmp}/interlock-release.XXXXXX")
    trap 'rm -f "$api_response"' EXIT HUP INT TERM
    api="https://api.github.com/repos/$REPOSITORY/releases"
    if ! status=$(curl --location --silent --show-error --write-out '%{http_code}' "$api/latest" --output "$api_response"); then
      echo "interlock: GitHub releases API request failed" >&2; exit 1
    fi
    prerelease=false
    case "$status" in
      200) ;;
      404)
        prerelease=true
        if ! status=$(curl --location --silent --show-error --write-out '%{http_code}' "$api?per_page=1" --output "$api_response"); then
          echo "interlock: GitHub releases API request failed" >&2; exit 1
        fi
        ;;
      *) echo "interlock: GitHub releases API returned HTTP $status" >&2; exit 1 ;;
    esac
    if [ "$status" != 200 ]; then
      echo "interlock: GitHub releases API returned HTTP $status" >&2; exit 1
    fi
    if ! VERSION=$(release_tag "$prerelease" < "$api_response"); then
      echo "interlock: GitHub releases API returned no valid installable release" >&2; exit 1
    fi
    rm -f "$api_response"
    trap - EXIT HUP INT TERM
    if [ "$prerelease" = true ]; then
      printf 'Installing Interlock %s (pre-release)\n' "$VERSION" >&2
    fi
    tag=$VERSION
  elif [ "$VERSION" = nightly ]; then
    tag=nightly
    printf 'Installing Interlock nightly (pre-release)\n' >&2
  elif [ "$VERSION" = latest ]; then
    echo "interlock: INTERLOCK_VERSION is required for prerelease installation" >&2
    exit 1
  else
    case "$VERSION" in v*) tag=$VERSION ;; *) tag="v$VERSION" ;; esac
  fi
  base="https://github.com/$REPOSITORY/releases/download/$tag"
fi

mkdir -p "$INSTALL_DIR"
tmp_binary=$(mktemp "$INSTALL_DIR/.interlock.XXXXXX")
tmp_checksums=$(mktemp "${TMPDIR:-/tmp}/interlock-checksums.XXXXXX")
cleanup() { rm -f "$tmp_binary" "$tmp_checksums"; }
trap cleanup EXIT HUP INT TERM

curl --fail --location --silent --show-error "$base/$asset" --output "$tmp_binary"
curl --fail --location --silent --show-error "$base/checksums.txt" --output "$tmp_checksums"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp_checksums")
if [ -z "$expected" ]; then
  echo "interlock: checksums.txt has no entry for $asset" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_binary" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp_binary" | awk '{print $1}')
else
  echo "interlock: sha256sum or shasum is required" >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "interlock: checksum verification failed for $asset" >&2
  exit 1
fi

chmod 755 "$tmp_binary"
mv -f "$tmp_binary" "$INSTALL_DIR/interlock"
trap - EXIT HUP INT TERM
rm -f "$tmp_checksums"

echo "Installed interlock to $INSTALL_DIR/interlock"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "$INSTALL_DIR is not on PATH. Add it to your shell profile:" >&2
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" >&2
    ;;
esac
