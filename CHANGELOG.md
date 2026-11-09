# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the usual `0.x`
allowance: minor releases may break compatibility.

## [0.6.1] - 2026-11-10

### Changed

- The standalone engine no longer ships machine-specific defaults. Its state root
  is `${XDG_STATE_HOME:-~/.local/state}/truthchrome`, its profile is
  `<state>/profile`, and the browser binary is discovered per platform (Chrome,
  Chromium, Edge, Brave on macOS; `google-chrome`/`chromium` on Linux;
  `chrome.exe` on Windows). A machine that wants different values writes them to
  `<state>/config.json` instead of patching the source.
- A missing *default* profile is created on first run; a missing *explicitly
  configured* profile is still an error, so a pinned path can never be replaced
  by an empty one behind the user's back.
- `browse/install.sh` no longer assumes a DSH workspace: it installs to
  `BROWSE_PREFIX` (default `~/.local/share/truthchrome`), adds the Codex copy only
  when `~/.codex` exists, and touches a DSH workspace only when `DSH_WORKSPACE` is
  set.
- `package.json` describes the package as a Chromium-backed search/fetch tool for
  DeepSeek Harness and Codex, and exposes the engine as a `browse` executable.

## [0.6.0] - 2026-11-10

### Added

- `browse/`: a standalone quiet engine for Codex and shell use. Same CDP approach,
  but with a persistent daemon, a target pool (`Target.createTarget` with
  `background: true`), per-page classification (`OK` / `CAPTCHA` / `LOGIN` /
  `BLOCKED` / `STUCK`, also exposed as exit codes 0/10/11/12/13), and a floating
  HUD that shows a live view of a page waiting for a human and forwards clicks
  and typing back into the real tab. The browser window never appears on screen:
  the app is hidden through Accessibility (`browse-ax`), which is the only way
  macOS honours after Chrome clamps `--window-position` back onto the display.
- `classifyChallenge()` distinguishes a CAPTCHA wall from a login wall, and the
  `web_fetch` error says which one it hit instead of blaming both.

### Fixed

- On macOS the browser candidates now start with `/Applications/Google Chrome.app`
  instead of the build this bundle downloaded. A downloaded build carries its own
  code signature (so the login keychain asks again whenever it is replaced) and
  fails to start where crashpad or the GPU helper is blocked — a silent SIGTRAP
  that looked like "the browser did not answer the new-tab request".

### Fixed

- `close` asks Chrome to shut down (`Browser.close`) before signalling it. Chrome
  batches cookie writes about every 30 seconds, so a SIGTERM right after a
  sign-in silently threw the new session away; verified by setting a cookie and
  closing immediately, then restarting.

### Changed

- The browser now opens tabs in the background (`Target.createTarget` through the
  browser socket, with `PUT /json/new` as the fallback), so parallel requests no
  longer steal the window from each other and throttle whatever was loading.
- Dedicated profiles launch with `--use-mock-keychain` by default: no login
  keychain access, therefore no recurring "Chrome wants to use your confidential
  information" prompts. The `personal` mode keeps the real keychain, because its
  cookies were encrypted with the key stored there.
- Machine preferences moved into `<stateDir>/config.json`, so a decision such as
  "this machine accepts the mock keychain" applies to every shell, launchd job
  and agent run without exporting anything. Precedence: environment variable,
  then `config.json`, then the built-in default.
- New settings: `windowPosition` (default `-4000,-4000`), `hideWindow` (default
  `true`), `axPath` (default `browse-ax` on `PATH`, or `$DSH_BROWSER_AX`), and
  `useMockKeychain` (default: every mode except `personal`).

## [0.5.0] - 2026-10-29

### Added

- `xhs_search` (opt-in): searches xiaohongshu.com in the plugin's tab and
  returns titles, links with their `xsec_token`, authors, likes, and publish
  times. `web_search` cannot carry a `source` parameter because its schema comes
  from the host, so notes that engines never index get a tool of their own.
  Config: `xiaohongshu.enabled` (default `false`), `xiaohongshu.maxResults`
  (10), `xiaohongshu.timeoutMs` (30000). A login wall and a slider captcha are
  reported as themselves instead of as "no results".
- The trace records `xhs` operations like searches and fetches (hashed query,
  count, duration; never the query text or note URLs).

## [0.4.0] - 2026-10-29

### Added

- `web_download`: saves images, video, audio, PDF, and zip files to disk using
  the browser session's cookies and user agent, plus a caller-supplied
  `Referer`. Bytes never enter the conversation; the tool returns the path,
  size, and sha256. This is what makes "collect the originals for tag X" work
  on hotlink-protected hosts such as `i.pximg.net`.
- Limits and guards: private-address refusal (same check as `web_fetch`),
  media-only content types, a streamed size cap, `wx` file creation with
  de-duplicated names, a per-file timeout, and a pause between files.

## [0.3.0] - 2026-10-28

### Changed

- Default `minResults` is now 3. A single hit from an engine that half-blocked
  the query used to count as an answer; now the search falls through to the next
  engine instead.
- `engines.node` is `>=22`. The DevTools transport uses the global `WebSocket`,
  which Node 20 does not have, so the previous `>=20` declaration was wrong. CI
  now runs Node 22 and 24 instead of 20 and 22.

### Added

- `web_fetch` refuses loopback, LAN, link-local, and carrier-grade NAT targets
  (`lib/net-guard.js`) before navigation, so a page the model asks for cannot
  reach a router admin page or a port on the machine itself. `allowPrivateHosts`
  opens everything (`true`) or only the listed hosts (`['nas.lan']`).
- The JSONL trace records which engine produced a result.
- A CDP smoke test with a hand-rolled WebSocket server, so the Node 22
  requirement is enforced by a test rather than assumed.

### Fixed

- The Chromium sandbox stays enabled except on Linux where the launch cannot
  work with it on (running as root or inside a container). It used to be
  disabled unconditionally.
- ZIP inflation is capped at `max(compressedSize * 20, 64 MB)` per entry, so a
  hostile archive cannot expand past memory while still being structurally
  valid.
- `SECURITY.md` states the two remaining gaps in one place: DNS rebinding is not
  defended against, and the downloaded browser archive is not signature-checked.

## [0.2.1] - 2026-10-28

### Fixed

- Publish pipeline: the first release was blocked by npm's staged-publishing
  placeholder, so 0.2.1 re-releases the same tree with a fresh version.

## [0.2.0] - 2026-10-28

First public release, as `dsh-chromium-websearch`.

### Added

- `web_search` provider driving a real headful Chromium over CDP (Bing,
  DuckDuckGo, Baidu) with redirect unwrapping and bot-wall settling.
- `web_fetch` provider that strips scripts/styles/svg/iframes and returns clean
  HTML or text, with `bodyFormat` selection.
- Three modes: `anonymous` (disposable profile), `signed-in` (kept profile,
  login window), `personal` (an existing Chrome profile directory).
- Automatic browser provisioning: when no Chromium build is installed, the
  stable Chrome for Testing build is downloaded once into
  `~/.dsh/browser-web/chromium` and reused. No postinstall script, no user step.
- Dependency-free ZIP reader for the provisioning path.
- Optional JSONL trace of navigations (`journal`), disabled with `journal: false`.

### Changed

- Package published as `dsh-chromium-websearch` (formerly the local
  `@local/dsh-web-browser`); the composition patch and install docs follow the
  new name. On-disk state file names are unchanged.
- GPL-3.0-or-later license.

## [0.1.3] - 2026-10-27

- Internal iteration: CDP client, search extractors, mode handling.
