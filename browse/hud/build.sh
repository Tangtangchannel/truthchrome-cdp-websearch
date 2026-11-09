#!/bin/sh
# Build the two native helpers that make the engine quiet.
#
#   browse-ax   hides the browser application (the only way macOS lets a process
#               take another app off screen without closing it)
#   browse-hud  the floating panel that asks a human for one thing
#
# Both are plain swiftc builds with no package manager involved.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
xcrun swiftc -O browse-ax.swift -o browse-ax
xcrun swiftc -O browse-hud.swift -o browse-hud
echo "built: $here/browse-ax $here/browse-hud"
