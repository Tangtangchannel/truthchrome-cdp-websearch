#!/bin/sh
# Install the quiet engine for both consumers: the DSH workspace and Codex.
#
# The engine lives in this repository and is copied out; nothing here edits the
# plugin's own files under lib/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
workspace=${DSH_WORKSPACE:-$HOME/Documents/deepseek-harness/default-workspace}
codex_home=${BROWSE_CODEX_HOME:-$HOME/.codex/tools/truthchrome}

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

install_into "$workspace/bin"
install_into "$codex_home"

echo
echo "next:"
echo "  $workspace/bin/browse.mjs status"
echo "  $codex_home/browse.mjs status"
