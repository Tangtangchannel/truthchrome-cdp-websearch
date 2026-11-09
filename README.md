# truthchrome-cdp-websearch

English · [中文](README.zh-CN.md)

Browser-backed `web_search` and `web_fetch` for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-base).
Install it and it works: if the machine has no Chromium build, the browser is
downloaded once and reused, with no postinstall script and no manual step.

The stock search provider calls an HTTP API and the stock fetch provider is a
plain HTTP client. Both get blocked by the same things a `curl` gets blocked by:
bot walls, JS-only pages, and login interstitials. This bundle instead drives a
real headful Chromium over the DevTools protocol, so the model sees what a
person browsing the page would see.

It changes no tool, no prompt, and no model-facing text. It only registers two
`ctx.web` providers and points the `web` service at them.

## What it does

- `web_search` → loads Bing, DuckDuckGo, or Baidu in a real tab, extracts result
  links from the DOM, unwraps redirect URLs, and returns
  `{ sources: [{ title, url, snippet }] }`.
- `web_download` → saves a file (image, video, audio, PDF, zip) to disk using the
  browser's cookies, user agent, and a `Referer` you pass in. The bytes never
  enter the conversation: you get back a path, its size, and a sha256. This is
  what makes "find pictures of tag X and keep the originals" work on hosts that
  refuse bare requests (`i.pximg.net` answers 403 without a pixiv Referer).
- `web_fetch` → loads the URL in a real tab, waits out common bot
  interstitials, strips scripts/styles/svg/iframes, and returns the cleaned HTML
  (or visible text) plus the status code and final URL.
- `xhs_search` → searches xiaohongshu.com (小红书) through the DOM and returns
  note titles, links (with the `xsec_token` that makes a note readable), authors,
  likes, and publish times. It is a separate tool on purpose: the `web_search`
  tool's arguments belong to the host (`queries` only), so a `source` parameter
  cannot be added from a plugin. Off by default; enable `xiaohongshu.enabled` on a
  signed-in profile, otherwise the page answers with a login wall and the tool
  reports exactly that.
- Engines are tried in order until one yields enough results, each with its own
  slice of the time budget, so one blocked engine cannot consume the request.
- The browser is reused between calls. Which profile it runs against depends on
  the [mode](#modes); `personal` is opt-in, so the default never touches the
  user's everyday browser profile.
- Reuse is identity-checked: the host records its browser's DevTools GUID in a
  marker under `markerDir` and only attaches to a browser whose GUID still
  matches, so an unrelated browser sitting on the same port is never adopted.
- A browser that died between calls is replaced on the next call: the host
  re-reads the marker, launches a replacement when nothing live is left, and
  retries tab creation while a fresh browser is still bringing its target list
  up. A failed launch is not memoised, so one bad start does not wedge every
  later request.

## Modes

The `mode` field decides which profile the browser is driven against, whether a
sign-in window is allowed, and whether Chrome restores the previous session (the
only way session-only cookies survive a restart). It accepts the id or the A/B/C
shorthand.

| Mode | Alias | Profile | Sign-in window | Session restored |
| --- | --- | --- | --- | --- |
| `anonymous` | A (default) | `~/.dsh/browser-web/profile` | no | no |
| `signed-in` | B | `~/.dsh/browser-web/signed-in` | yes | yes |
| `personal` | C | `personalProfileDir` | yes | yes |

Anonymous is the default because it is the mode whose output stays reproducible:
no account, no personalisation, nothing a site remembers about a person. Switch
to `signed-in` when a page needs an account; it has its own profile, so a session
started there never leaks into anonymous searches. `personal` drives a profile
that already exists on the machine: the bundle never creates it, refuses to start
while another Chrome instance holds it, and stores its own state outside it.

To switch mode without editing the bundle, override the entry in
`~/.dsh/cordis.patch.yml`. A `config` override replaces the whole object, which is
why the bundled patch pins only `mode`:

```yaml
- id: web-browser
  name: 'dsh-chromium-websearch'
  config:
    mode: signed-in
```

## Composition

`cordis.patch.yml` does two things:

1. inserts this plugin so its `apply()` registers the `browser` search and fetch
   providers;
2. overrides the `web` service config to `searchProvider: browser`,
   `fetchProvider: browser`.

Because the bundle patch is applied last, that override wins over the base
composition. Removing the bundle restores the stock providers. The plugin entry
itself pins only `mode`, so user-level overrides stay short.

## The quiet engine (`browse/`)

The plugin's browser is invisible to the model but visible on the desktop: it is a
real headful Chromium window. `browse/` is the same idea packaged for shell and
agent use, with the window taken out of the picture:

- A persistent daemon owns the browser, so a second call never pays a cold start.
- Tabs open in the background (`Target.createTarget` with `background: true`), each
  with its own CDP session, so one blocked site cannot stall the rest.
- Every page is classified as `OK`, `CAPTCHA`, `LOGIN`, `BLOCKED` or `STUCK`, and
  that verdict is also the process exit code (0/10/11/12/13).
- The application is **hidden** through Accessibility after launch. Chrome clamps
  `--window-position` back onto the display, so hiding is the only thing macOS
  actually honours; a hidden Chrome still renders, so screenshots keep working.
- When a page really needs a person, a non-activating floating panel appears with
  a live view of that one page, forwards your clicks and typing into the real tab,
  and disappears when the wall clears.
- The profile is pinned and never created on demand: an empty profile silently
  loses every login.

```bash
node browse/browse.mjs status
node browse/browse.mjs text https://example.com
node browse/browse.mjs batch https://a.test https://b.test https://c.test
node browse/browse.mjs close
```

See [browse/README.md](browse/README.md) for the full command table, the
environment variables, the keychain notes and the known limits.
`sh browse/smoke.sh` checks the whole chain end to end: hidden browser, one fetch,
three concurrent sites, and a CAPTCHA wall reported as exit code 10.

## Install

Install it as a profile bundle:

```
plugin_manager install_bundle  target: dsh-chromium-websearch
```

For local development, point the same call at the checkout instead:

```
plugin_manager install_bundle  target: /absolute/path/to/dsh-chromium-websearch
```

Requires **Node 22 or newer**: the DevTools transport uses the global
`WebSocket`, which only became available without a flag in Node 21.

No dependencies are installed: the bundle imports only `node:` builtins and its
own files, and it runs no install script (package managers block those by
default anyway).

### Browser requirement

A Chromium-based browser is *used* when one exists: an explicit `chromePath`,
then `DSH_BROWSER_CHROME` / `CHROME_PATH`, then a Playwright build cache, then
Chrome for Testing / Chrome / Chromium / Edge / Brave in the usual install
locations.

When none is found, the stable Chrome for Testing build is downloaded once into
`~/.dsh/browser-web/chromium` and the marker in `current.json` is reused from
then on. This needs network access on first run and roughly 150 MB of disk. Set
`autoProvision: false` to keep the plugin offline and resolve the browser
yourself.

## Signing in

```bash
# B mode: dedicated profile, kept across restarts
node ./scripts/login.mjs --mode signed-in

# C mode: an existing profile directory (quoted: the path has spaces)
node ./scripts/login.mjs --profile "$HOME/Library/Application Support/Google/Chrome"
```

`login.mjs` opens a headful window (default `https://www.bing.com/`, override with
`--url`), prints the profile and endpoint, and exits while the browser keeps
running. Sign in by hand; the next `web_search` / `web_fetch` reuses that browser
through its ownership marker. `--list` prints the modes.

Sign-in is refused in anonymous mode on purpose: keeping A signed out is what it
is for.

`node ./scripts/logout.mjs --yes` deletes the profile of a mode (anonymous by
default) so the next launch starts signed out. It refuses while the browser is
running, and never deletes a personal profile.

What signing in costs: every page that browser can read is a page the model can
read, that content lands in the session transcript, and results stop being
reproducible. Keep email, banking, payment, cloud consoles and write-scoped
accounts out of that window.

## Configuration

All fields are optional; the defaults work on any machine, with or without a
browser installed.

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `anonymous` | `anonymous` (A), `signed-in` (B), or `personal` (C). See [Modes](#modes). |
| `personalProfileDir` | unset | Existing Chrome profile for `personal` mode; required there. |
| `userDataDir` | the mode's profile | Explicit profile override. In `personal` mode set `personalProfileDir` instead. |
| `markerDir` | sibling of the profile | Where ownership markers live. Never inside a personal profile. |
| `chromePath` | auto-detect | Browser binary. Also read from `DSH_BROWSER_CHROME` or `CHROME_PATH`. |
| `autoProvision` | `true` | Download Chrome for Testing when no browser exists. |
| `allowPrivateHosts` | `false` | `web_fetch` refuses loopback and private addresses. `true` opens all of them; a list such as `['nas.lan']` opens only those hosts. |
| `provisionDir` | `~/.dsh/browser-web/chromium` | Where the downloaded build lives. |
| `indexUrl` | the Chrome for Testing index | Override for a mirror or an offline copy of the same JSON document. |
| `port` | `9334` | Preferred DevTools port. If it is taken, the host scans upward (at most 10 ports) and records the port it actually got. |
| `headless` | `false` | Run without a window. Some walls only clear headful. |
| `engines` | `bing`, `duckduckgo`, `baidu` | Preference order. |
| `minResults` | `3` | Below this count, the search falls through to the next engine instead of answering with what it got. |
| `maxResults` | `8` | Hard cap per search. |
| `searchTimeoutMs` | `45000` | Total search budget. |
| `fetchTimeoutMs` | `45000` | Total fetch budget. |
| `navigateTimeoutMs` | `20000` | Per-navigation budget. |
| `challengeTimeoutMs` | `20000` | How long to wait for a bot wall to clear. |
| `settleMs` | `700` | Extra wait after load, for late-rendered content. |
| `maxBodyChars` | `400000` | Body cap before the tool layer truncates further. |
| `bodyFormat` | `html` | `html`, `text`, or `auto` (by MIME type). |
| `journal` | `true` | Append JSONL trace lines. |
| `journalPath` | `~/.dsh/browser-web/events.jsonl` | Trace file. |
| `closeBrowserOnDispose` | `false` | Kill the browser this plugin started when it unloads. |
| `downloadDir` | `~/.dsh/browser-web/downloads` | Root for `web_download`; each call defaults to a `<YYYYMMDD>` subdirectory. |
| `downloadMaxBytes` | `52428800` | Refuse a single file larger than this (streamed, so the limit is enforced mid-flight). |
| `downloadMaxFiles` | `20` | Refuse a `web_download` call asking for more URLs than this. |
| `downloadTimeoutMs` | `60000` | Per-file deadline. |
| `downloadMinIntervalMs` | `1000` | Pause between files in one call. |
| `xiaohongshu.enabled` | `false` | Register the `xhs_search` tool. It is only useful with a signed-in profile. |
| `xiaohongshu.maxResults` | `10` | Default note count for one `xhs_search` call (1-20). |
| `xiaohongshu.timeoutMs` | `30000` | Search budget, including the wait for cards to render. |

## Reloading

The host caches loaded plugin modules. After editing files in this bundle, either
restart the app or toggle the plugin off and on in the plugin manager
(`set_plugin` with the entry id from `list_plugins`); a file save alone does not
reach the running process.

## Trace

With `journal: true` each search, fetch, download, and xiaohongshu search
appends one JSONL line to `journalPath`: timestamp, operation, engine, result
count, duration, HTTP host (for fetches), and a 16-hex SHA-256 prefix of the
query. The query text, page content, URLs, and cookies are never written.

## Acceptance

```
npm test                               # offline: unit + provisioning cases
node ./scripts/accept.mjs              # static + unit + fixtures + live
node ./scripts/accept.mjs --skip-live  # static + unit + fixtures, no network
```

`npm test` is the command a fresh clone can run: no browser, no network, no
setup. It exits non-zero when a case throws, so it is also the publish gate.

Sections:

- **static** — no API keys, no personal absolute paths, no references to harness
  memory or credential files, no `@deepseek-ai/*` imports, manifest/icon valid.
- **unit** — redirect unwrapping, result normalization, config validation,
  challenge detection, journal redaction, abort semantics, mode/profile
  resolution (aliases, personal-mode guards, Chrome lock detection), and the
  sign-in helper refusing anonymous mode.
- **fixtures** — each engine extractor runs against a local HTML fixture in a
  real browser, so selector drift fails loudly instead of silently returning
  nothing.
- **live** — a real search and a real fetch through the exact provider objects
  registered with `ctx.web`, plus a check that the trace file contains the
  result count but not the query; and these lifecycle/isolation cases: a stale
  ownership marker is not followed to a dead port, a foreign browser on the
  configured port is not adopted, a browser already published by this profile is
  reused, a browser killed between requests is replaced, signed-in mode launches
  with session restore, and personal mode drives an existing profile without
  writing a marker into it. Each case runs against its own temporary profile and
  removes it afterwards.

The acceptance run reports `ACCEPTED: 4/4 sections, 53 cases` when everything
passes, and `npm test` reports `PASSED 44 case(s)` for the offline subset.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for the full text.

```
Copyright (C) 2026 大肥鱼 (DeepSeek), amecandy

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.
```

Using the plugin inside a harness is not distribution: the GPL applies when you
pass the plugin on, publish a modified version, or ship it inside a product.

## Authors

- 大肥鱼（DeepSeek）
- amecandy

## Troubleshooting

- `BROWSER_NOT_FOUND` — no browser was found *and* the automatic download
  failed (offline, proxy, or a read-only home directory). Install Chrome, or set
  `chromePath`, or point `provisionDir` somewhere writable and retry.
- `BROWSER_START_FAILED` — another browser already holds the profile; close it,
  change `userDataDir`, or change `port`.
- "that profile is in use by a running Chrome" — the profile lock is live. Quit
  that Chrome, or copy the profile elsewhere for `personal` mode.
- "the personal profile directory does not exist" — `personal` mode never
  creates a profile; point `personalProfileDir` at one that exists.
- Search returns nothing — the engine markup changed; update the extractor in
  `lib/search.js` and its fixture in `test/fixtures/`.
- A page stalls on a wall — headful mode clears most; a CAPTCHA needs a human in
  the window.
- `web_fetch` refused a private address — the target resolved to loopback, a LAN
  address, or a link-local range, and `allowPrivateHosts` is off. Set it to
  `true` for everything, or to `['nas.lan']` for just the hosts you mean. In
  `signed-in` / `personal` mode remember the request carries your cookies.
