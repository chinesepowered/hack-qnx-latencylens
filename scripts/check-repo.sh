#!/usr/bin/env bash
# check-repo.sh: guard rails run before every push.
#   1. no em dashes in any tracked file (house style)
#   2. no secret from .env in the working tree or anywhere in the git history
#   3. nothing from the QNX SDP is committed (headers, libraries, binaries, license keys)
# Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1. Em dashes (U+2014), literally or as HTML/JS escapes. LICENSE is the verbatim AGPL text.
mapfile -t files < <(git ls-files --cached --others --exclude-standard | grep -vE '\.(kev|gz|png|jpg|mp4|mp3|wav|webm|ico)$')
dash_hits=$(printf '%s\0' "${files[@]}" | xargs -0 grep -nP '\x{2014}|&mdash;|\\u2014' 2>/dev/null || true)
if [[ -n "$dash_hits" ]]; then echo "em dash found:"; echo "$dash_hits" | head -20; fail=1; fi

# 2. Secrets. Values come from .env (never printed); also generic key shapes.
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    [[ -z "${k// }" || "$k" == \#* || -z "$v" ]] && continue
    case "$k" in *KEY*|*PASSWORD*|*TOKEN*|*SECRET*|MYQNX_USER) ;; *) continue ;; esac
    if printf '%s\0' "${files[@]}" | xargs -0 grep -lF -- "$v" 2>/dev/null | grep -q .; then
      echo "secret $k appears in the working tree"; fail=1
    fi
    if git log --all -p --no-color 2>/dev/null | grep -qF -- "$v"; then
      echo "secret $k appears in git history"; fail=1
    fi
  done < .env
fi
generic=$(printf '%s\0' "${files[@]}" | xargs -0 grep -nE 'wandb_v1_[A-Za-z0-9_]{20,}|sk_[a-f0-9]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null || true)
if [[ -n "$generic" ]]; then echo "key-shaped string found:"; echo "$generic" | cut -c1-120; fail=1; fi
if git ls-files --error-unmatch .env >/dev/null 2>&1; then echo ".env is tracked"; fail=1; fi

# 3. SDP material: QNX license headers, ELF binaries, license files.
# (the patterns are assembled from pieces so this file does not match itself)
lic_a='\$QNX''LicenseC'; lic_b='QNX Software Systems\. All ''Rights Reserved'
sdp=$(printf '%s\0' "${files[@]}" | xargs -0 grep -lE "$lic_a|$lic_b" 2>/dev/null || true)
if [[ -n "$sdp" ]]; then echo "QNX SDP licensed content found:"; echo "$sdp"; fail=1; fi
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  if head -c 4 "$f" 2>/dev/null | grep -q $'\x7fELF'; then echo "ELF binary tracked: $f"; fail=1; fi
done
if git ls-files | grep -qiE '(^|/)(qnx800|qnxinstall)/|\.qlic$|license\.key$'; then echo "SDP path tracked"; fail=1; fi

if [[ $fail -eq 0 ]]; then echo "check-repo: ok"; fi
exit $fail
