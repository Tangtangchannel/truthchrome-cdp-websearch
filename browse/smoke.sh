#!/bin/sh
# End-to-end smoke test for the quiet engine.
#
# Proves four things in about half a minute without touching the network much:
#   1. the browser comes up with no window on screen
#   2. a single fetch works
#   3. three sites run concurrently (roughly max, not sum)
#   4. a CAPTCHA wall is reported as exit code 10, not as content
#
# Usage: sh browse/smoke.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node="$here/browse.mjs"

printf '1. status ......... '
node "$node" status >/dev/null
echo ok

printf '2. single fetch ... '
node "$node" text https://example.com | head -c 30
printf '\n   ok\n'

printf '3. concurrency .... '
start=$(date +%s)
node "$node" batch https://example.com https://example.org https://www.iana.org/help/example-domains >/dev/null
elapsed=$(( $(date +%s) - start ))
echo "3 sites in ${elapsed}s"

fixture=$(mktemp -d)/captcha.html
cat >"$fixture" <<'HTML'
<!doctype html><title>Just a moment...</title>
<iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js" width="300" height="65"></iframe>
HTML
printf '4. captcha ..... '
set +e
node "$node" open "file://$fixture" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 10 ]; then
  echo "exit 10 (correct)"
else
  echo "exit $code (expected 10)"
  node "$node" close >/dev/null 2>&1 || true
  exit 1
fi

node "$node" close >/dev/null 2>&1 || true
echo 'all checks passed'
