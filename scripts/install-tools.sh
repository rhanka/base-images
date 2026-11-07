#!/usr/bin/env bash
# Install the pinned build tools into ./.bin (or $BIN_DIR).
# Every download is checked against a sha256 committed here. Go and native binaries only.
set -euo pipefail

BIN_DIR="${BIN_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.bin}"
mkdir -p "$BIN_DIR"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

APKO_VERSION=1.4.17
MELANGE_VERSION=0.64.0
COSIGN_VERSION=3.1.4
GRYPE_VERSION=0.121.2
CRANE_VERSION=0.22.1

declare -A SHA=(
  [apko_amd64]=cb5f43875c93664297d4d0196081c7149c46315d7ea6eb6acb5b1ebb0511d1cc
  [apko_arm64]=c6b5ca4b02f2914e0f2079e50c4c7ece1b17b6677dfdb798fac51dc65f39875d
  [melange_amd64]=d8ae32eea4e0dc390e4a1e7d7a7740cf10f4a84675b792a2ff5417097e4ce317
  [melange_arm64]=7d546463e1b4113284d34acaaca1d6208ff4be9770683882398b030ae7c091ba
  [cosign_amd64]=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
  [cosign_arm64]=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2
  [grype_amd64]=9c8965ced9df657e5e851c14021bae838802f711edd7a48f9bc3c923a8d28f12
  [grype_arm64]=d7d2e160255b0f087280feabf6f213cf4c45d475690f3f1fe5dc336eb1037bf0
  [crane_amd64]=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0
  [crane_arm64]=898c0cff975f898a33e8c4580bdafb0e7c02c7faa33374e946762f97c4ab7110
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { # name url
  local name="$1" url="$2" out="$tmp/$1.dl"
  curl -sSfL --retry 3 -o "$out" "$url"
  echo "${SHA[${name}_${ARCH}]}  $out" | sha256sum -c --quiet -
  echo "$out"
}

want() { # binary version-probe expected
  [[ -x "$BIN_DIR/$1" ]] && "$BIN_DIR/$1" $2 2>/dev/null | grep -q -- "$3"
}

if ! want apko version "$APKO_VERSION"; then
  f="$(fetch apko "https://github.com/chainguard-dev/apko/releases/download/v${APKO_VERSION}/apko_${APKO_VERSION}_linux_${ARCH}.tar.gz")"
  tar -xzf "$f" -C "$tmp" && install -m755 "$tmp/apko_${APKO_VERSION}_linux_${ARCH}/apko" "$BIN_DIR/apko"
fi
if ! want melange version "$MELANGE_VERSION"; then
  f="$(fetch melange "https://github.com/chainguard-dev/melange/releases/download/v${MELANGE_VERSION}/melange_${MELANGE_VERSION}_linux_${ARCH}.tar.gz")"
  tar -xzf "$f" -C "$tmp" && install -m755 "$tmp/melange_${MELANGE_VERSION}_linux_${ARCH}/melange" "$BIN_DIR/melange"
fi
if ! want cosign version "$COSIGN_VERSION"; then
  f="$(fetch cosign "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${ARCH}")"
  install -m755 "$f" "$BIN_DIR/cosign"
fi
if ! want grype version "$GRYPE_VERSION"; then
  f="$(fetch grype "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_linux_${ARCH}.tar.gz")"
  tar -xzf "$f" -C "$tmp" grype && install -m755 "$tmp/grype" "$BIN_DIR/grype"
fi
if ! want crane version "$CRANE_VERSION"; then
  carch=$([[ $ARCH == amd64 ]] && echo x86_64 || echo arm64)
  f="$(fetch crane "https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_${carch}.tar.gz")"
  tar -xzf "$f" -C "$tmp" crane && install -m755 "$tmp/crane" "$BIN_DIR/crane"
fi

for b in apko melange cosign grype crane; do printf '%-8s %s\n' "$b" "$("$BIN_DIR/$b" version 2>/dev/null | grep -m1 -iE 'gitversion|version' | tr -s ' ')"; done
