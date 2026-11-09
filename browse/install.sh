#!/bin/sh
# Install the quiet engine: build the native helpers, then copy the runtime into
# the places that consume it.
#
#   BROWSE_PREFIX   where the engine lives (default: ~/.local/share/truthchrome)
#   DSH_WORKSPACE   optional DSH workspace; when set, also installs to $DSH_WORKSPACE/bin
#   BROWSE_CODEX_HOME  optional Codex tool directory; default ~/.codex/tools/truthchrome
#                      when ~/.codex exists
#
# Nothing here edits the plugin's own files under lib/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
prefix=${BROWSE_PREFIX:-$HOME/.local/share/truthchrome}

sh "$here/hud/build.sh"

install_into() {
  target=$1
  mkdir -p "$target/hud"
  cp "$here/browse.mjs" "$target/browse.mjs"
  cp "$here/hud/browse-ax" "$target/hud/browse-ax"
  cp "$here/hud/browse-hud" "$target/hud/browse-hud"
  chmod +x "$target/browse.mjs" "$target/hud/browse-ax" "$target/hud/browse-hud"
  echo "installed: $target"
}

install_into "$prefix"

if [ -n "${DSH_WORKSPACE:-}" ]; then
  install_into "$DSH_WORKSPACE/bin"
else
  echo "skipped DSH workspace (set DSH_WORKSPACE to install into <workspace>/bin)"
fi

if [ -d "$HOME/.codex" ]; then
  install_into "${BROWSE_CODEX_HOME:-$HOME/.codex/tools/truthchrome}"
fi

echo
echo "next:"
echo "  $prefix/browse.mjs status"
