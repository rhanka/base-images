#!/usr/bin/env bash
# Verify that the sha256 values pinned in melange/nodejs-26.yaml are the ones the Node.js
# release team signed for that version.
#
#   scripts/verify-node-release.sh melange/nodejs-26.yaml
#
# 1. download SHASUMS256.txt and SHASUMS256.txt.sig for the recipe version from nodejs.org;
# 2. gpg --verify against the committed keyring keys/nodejs/pubring.kbx (isolated GNUPGHOME);
# 3. require a VALIDSIG status line whose primary fingerprint is in keys/nodejs/fingerprints.txt,
#    and no EXPKEYSIG / REVKEYSIG / BADSIG / ERRSIG line (gpg exits 0 on an expired or revoked key);
# 4. require that the recipe's expected-sha256 for x64 and arm64 equal the signed values.
set -euo pipefail

recipe="${1:?usage: verify-node-release.sh <melange recipe>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(awk '/^package:/{p=1} p && $1=="version:"{print $2; exit}' "$recipe")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "cannot read package.version from $recipe" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export GNUPGHOME="$work/gnupg"
mkdir -m700 "$GNUPGHOME"

base="https://nodejs.org/dist/v${version}"
curl -sSfL --retry 3 -o "$work/SHASUMS256.txt" "$base/SHASUMS256.txt"
curl -sSfL --retry 3 -o "$work/SHASUMS256.txt.sig" "$base/SHASUMS256.txt.sig"

status="$work/status"
gpg --batch --no-default-keyring --keyring "$root/keys/nodejs/pubring.kbx" \
  --status-fd 3 --verify "$work/SHASUMS256.txt.sig" "$work/SHASUMS256.txt" 3>"$status" 2>"$work/gpg.log" || {
  cat "$work/gpg.log" >&2; echo "gpg verification failed" >&2; exit 1; }

if grep -qE '^\[GNUPG:\] (EXPKEYSIG|REVKEYSIG|BADSIG|ERRSIG|EXPSIG)' "$status"; then
  cat "$status" >&2; echo "signature made by an expired/revoked key, or bad" >&2; exit 1
fi
# VALIDSIG <sig-fpr> <date> <ts> <expire> <ver> <rsvd> <pkalgo> <hashalgo> <class> <primary-fpr>
primary="$(awk '$2=="VALIDSIG"{print $NF}' "$status")"
[[ -n "$primary" ]] || { echo "no VALIDSIG line" >&2; exit 1; }
grep -qx "$primary" <(grep -v '^#' "$root/keys/nodejs/fingerprints.txt") || {
  echo "signing key $primary is not in keys/nodejs/fingerprints.txt" >&2; exit 1; }
signer="$(awk '$2=="GOODSIG"{$1=$2=$3=""; sub(/^ +/,""); print}' "$status")"
echo "OK  SHASUMS256.txt v${version}: VALIDSIG primary ${primary} (${signer})"

rc=0
for arch in x64 arm64; do
  file="node-v${version}-linux-${arch}.tar.xz"
  signed="$(awk -v f="$file" '$2==f{print $1}' "$work/SHASUMS256.txt")"
  pinned="$(grep -A0 -m1 "expected-sha256: .*# ${arch}\$" "$recipe" | awk '{print $2}')"
  if [[ -n "$signed" && "$signed" == "$pinned" ]]; then
    echo "OK  ${file} ${signed}"
  else
    echo "MISMATCH ${file}: signed=${signed:-none} recipe=${pinned:-none}" >&2; rc=1
  fi
done
exit $rc
