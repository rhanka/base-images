#!/usr/bin/env bash
# Fail if a tracked file (or the staged diff, with --staged) looks like it carries a secret.
# Public repository: run before every push. Patterns: private keys, GitHub/cloud tokens, credentials in
# URLs, high-entropy assignments to secret-like names.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--staged" ]]; then
  content() { git diff --cached -U0 --no-color | grep -E '^\+' | grep -vE '^\+\+\+' || true; }
else
  content() { git ls-files -z | xargs -0 grep -nIH -e '' -- 2>/dev/null || true; }
fi
patterns=(
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  'gh[pousr]_[A-Za-z0-9]{36,}'
  'github_pat_[A-Za-z0-9_]{40,}'
  'AKIA[0-9A-Z]{16}'
  'xox[abpr]-[A-Za-z0-9-]{10,}'
  '[a-z]+://[^/ :@]+:[^/ @]{6,}@'
  '(password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*["'"'"' ]*[:=] *["'"'"'][A-Za-z0-9+/=_-]{16,}'
)
found=0
for p in "${patterns[@]}"; do
  if content | grep -nE -i -- "$p" | grep -v 'scripts/secret-scan.sh'; then found=1; fi
done
# internal hostnames must not appear in this public repository
if content | grep -nE -i '\.(internal|local|lan|corp)\b|cloud\.ovh\.net|scw\.cloud|\.svc\.cluster' | grep -v 'scripts/secret-scan.sh'; then found=1; fi
if [[ $found -ne 0 ]]; then echo "secret-scan: possible secret or internal hostname above" >&2; exit 1; fi
echo "secret-scan: clean"
