import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { WebBrowserConfigError } from './errors.js'
import { MODES, directory, normalizeMode, resolveProfile } from './modes.js'
import { DEFAULT_PROVISION_DIR, VERSION_ENDPOINT, provisionedBinary } from './provision.js'

export { WebBrowserConfigError }

/** Provider ids registered with `ctx.web`; the patch pins both to `browser`. */
export const PROVIDER_ID = 'browser'

/** Engines this bundle knows how to drive, in the order a profile may list them. */
export const KNOWN_ENGINES = Object.freeze(['bing', 'duckduckgo', 'baidu'])

const HOME = homedir()

/** Defaults applied to every field the caller does not set. */
export const DEFAULTS = Object.freeze({
  chromePath: undefined,
  mode: 'anonymous',
  personalProfileDir: undefined,
  port: 9334,
  userDataDir: MODES.anonymous.profileDir,
  headless: false,
  engines: ['bing', 'duckduckgo', 'baidu'],
  minResults: 3,
  maxResults: 8,
  searchTimeoutMs: 45000,
  fetchTimeoutMs: 45000,
  navigateTimeoutMs: 20000,
  launchTimeoutMs: 20000,
  challengeTimeoutMs: 20000,
  settleMs: 700,
  maxBodyChars: 400000,
  bodyFormat: 'html',
  journal: true,
  journalPath: join(HOME, '.dsh', 'browser-web', 'events.jsonl'),
  autoProvision: true,
  allowPrivateHosts: false,
  provisionDir: DEFAULT_PROVISION_DIR,
  indexUrl: VERSION_ENDPOINT,
  closeBrowserOnDispose: false,
  downloadDir: join(HOME, '.dsh', 'browser-web', 'downloads'),
  downloadMaxBytes: 50 * 1024 * 1024,
  downloadMaxFiles: 20,
  downloadTimeoutMs: 60000,
  downloadMinIntervalMs: 1000,
  xiaohongshu: Object.freeze({
    /** Off by default: the tool is only useful with a signed-in profile. */
    enabled: false,
    maxResults: 10,
    timeoutMs: 30000,
  }),
})

const BODY_FORMATS = new Set(['html', 'text', 'auto'])

/**
 * Read one numeric setting, clamped to a sane range.
 *
 * @param {unknown} value - raw value from the patch.
 * @param {number} fallback - default.
 * @param {{ min: number, max: number }} range - inclusive bounds.
 * @param {string} label - field name used in the error message.
 * @returns {number} the clamped integer.
 */
function intSetting(value, fallback, range, label) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new WebBrowserConfigError(`"${label}" must be a finite number`)
  return Math.min(range.max, Math.max(range.min, Math.round(number)))
}

/**
 * Normalize the raw `cordis.patch.yml` config object into a settings record.
 * Unknown keys are ignored so a newer patch never breaks an older bundle.
 *
 * @param {unknown} input - entry config from the loader.
 * @returns {ReturnType<typeof DEFAULTS> & { chromePath: string | undefined, markerDir: string, loginWindow: boolean, restoreSession: boolean, externalProfile: boolean }} normalized settings.
 */
export function normalizeSettings(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const mode = normalizeMode(raw.mode)
  const profile = resolveProfile({
    mode,
    userDataDir: raw.userDataDir,
    personalProfileDir: raw.personalProfileDir,
  })
  const engines = Array.isArray(raw.engines) && raw.engines.length > 0
    ? [...new Set(raw.engines.filter((name) => KNOWN_ENGINES.includes(name)))]
    : [...DEFAULTS.engines]
  if (engines.length === 0) {
    throw new WebBrowserConfigError(`"engines" lists no supported engine; supported values are ${KNOWN_ENGINES.join(', ')}`)
  }
  const bodyFormat = (text(raw.bodyFormat) || DEFAULTS.bodyFormat).toLowerCase()
  if (!BODY_FORMATS.has(bodyFormat)) {
    throw new WebBrowserConfigError(`"bodyFormat" must be one of ${[...BODY_FORMATS].join(', ')}`)
  }
  const chromePath = text(raw.chromePath) || text(process.env.DSH_BROWSER_CHROME) || text(process.env.CHROME_PATH) || undefined
  const journalPath = text(raw.journalPath) || DEFAULTS.journalPath
  const provisionDir = text(raw.provisionDir) || DEFAULTS.provisionDir
  const indexUrl = text(raw.indexUrl) || DEFAULTS.indexUrl
  const info = MODES[mode]
  return {
    chromePath,
    mode,
    personalProfileDir: profile.external ? profile.profileDir : undefined,
    markerDir: directory(raw.markerDir, 'markerDir') ?? profile.markerDir,
    loginWindow: info.loginWindow,
    restoreSession: info.restoreSession,
    externalProfile: profile.external,
    port: intSetting(raw.port, DEFAULTS.port, { min: 1024, max: 65535 }, 'port'),
    userDataDir: profile.profileDir,
    headless: raw.headless === true,
    engines,
    minResults: intSetting(raw.minResults, DEFAULTS.minResults, { min: 1, max: 8 }, 'minResults'),
    maxResults: intSetting(raw.maxResults, DEFAULTS.maxResults, { min: 1, max: 20 }, 'maxResults'),
    searchTimeoutMs: intSetting(raw.searchTimeoutMs, DEFAULTS.searchTimeoutMs, { min: 5000, max: 180000 }, 'searchTimeoutMs'),
    fetchTimeoutMs: intSetting(raw.fetchTimeoutMs, DEFAULTS.fetchTimeoutMs, { min: 5000, max: 180000 }, 'fetchTimeoutMs'),
    navigateTimeoutMs: intSetting(raw.navigateTimeoutMs, DEFAULTS.navigateTimeoutMs, { min: 3000, max: 120000 }, 'navigateTimeoutMs'),
    launchTimeoutMs: intSetting(raw.launchTimeoutMs, DEFAULTS.launchTimeoutMs, { min: 3000, max: 120000 }, 'launchTimeoutMs'),
    challengeTimeoutMs: intSetting(raw.challengeTimeoutMs, DEFAULTS.challengeTimeoutMs, { min: 0, max: 120000 }, 'challengeTimeoutMs'),
    settleMs: intSetting(raw.settleMs, DEFAULTS.settleMs, { min: 0, max: 10000 }, 'settleMs'),
    maxBodyChars: intSetting(raw.maxBodyChars, DEFAULTS.maxBodyChars, { min: 2000, max: 4000000 }, 'maxBodyChars'),
    bodyFormat,
    journal: raw.journal !== false,
    journalPath,
    autoProvision: raw.autoProvision !== false,
    allowPrivateHosts: parseAllowPrivateHosts(raw.allowPrivateHosts),
    provisionDir,
    indexUrl,
    closeBrowserOnDispose: raw.closeBrowserOnDispose === true,
    downloadDir: directory(raw.downloadDir, 'downloadDir') ?? DEFAULTS.downloadDir,
    downloadMaxBytes: intSetting(raw.downloadMaxBytes, DEFAULTS.downloadMaxBytes, { min: 1024, max: 512 * 1024 * 1024 }, 'downloadMaxBytes'),
    downloadMaxFiles: intSetting(raw.downloadMaxFiles, DEFAULTS.downloadMaxFiles, { min: 1, max: 50 }, 'downloadMaxFiles'),
    downloadTimeoutMs: intSetting(raw.downloadTimeoutMs, DEFAULTS.downloadTimeoutMs, { min: 5000, max: 600000 }, 'downloadTimeoutMs'),
    downloadMinIntervalMs: intSetting(raw.downloadMinIntervalMs, DEFAULTS.downloadMinIntervalMs, { min: 0, max: 60000 }, 'downloadMinIntervalMs'),
    xiaohongshu: normalizeXiaohongshu(raw.xiaohongshu),
  }
}

/**
 * Normalize the optional `xiaohongshu` block: the `xhs_search` tool is opt-in
 * because it only makes sense on a signed-in profile.
 *
 * @param {unknown} value - raw `xiaohongshu` object from the patch.
 * @returns {{ enabled: boolean, maxResults: number, timeoutMs: number }} normalized settings.
 */
function normalizeXiaohongshu(value) {
  const raw = value !== null && typeof value === 'object' ? value : {}
  const defaults = DEFAULTS.xiaohongshu
  return {
    enabled: raw.enabled === true,
    maxResults: intSetting(raw.maxResults, defaults.maxResults, { min: 1, max: 20 }, 'xiaohongshu.maxResults'),
    timeoutMs: intSetting(raw.timeoutMs, defaults.timeoutMs, { min: 5000, max: 120000 }, 'xiaohongshu.timeoutMs'),
  }
}

/**
 * Parse the `allowPrivateHosts` policy: `true` opens every private range, an array opens
 * only the hosts it lists, and anything else keeps the default refusal.
 *
 * A list is accepted because a user who needs one LAN appliance (a NAS, a home
 * router dashboard) should not have to open 10/8, 192.168/16 and loopback at
 * once. Invalid entries are rejected rather than ignored so a typo cannot
 * silently widen access.
 *
 * @param {unknown} value - raw value from the patch.
 * @returns {boolean | string[]} the parsed policy.
 */
function parseAllowPrivateHosts(value) {
  if (value === true) return true
  if (value === undefined || value === null || value === false) return false
  if (!Array.isArray(value)) throw new WebBrowserConfigError('"allowPrivateHosts" must be a boolean or a list of hostnames')
  const hosts = value
    .filter((entry) => entry !== undefined && entry !== null)
    .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
  if (hosts.length === 0 || hosts.some((host) => host.length === 0)) {
    throw new WebBrowserConfigError('"allowPrivateHosts" list must contain at least one non-empty hostname')
  }
  return [...new Set(hosts)]
}

/** Trim a string setting, treating blanks as absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Candidate browser binaries, most specific first. Playwright's build cache is
 * scanned from `$HOME` rather than a hard-coded user path so this bundle holds
 * no machine-specific strings.
 *
 * @returns {string[]} existing executable paths, best candidate first.
 */
export function chromeCandidates(settings = {}) {
  const found = []
  const add = (candidate) => {
    if (candidate && existsSync(candidate) && !found.includes(candidate)) found.push(candidate)
  }
  // A build downloaded by this bundle is the most predictable choice: it exists
  // on machines with no Chrome, and its version is the one that was tested.
  add(provisionedBinary(settings.provisionDir ?? DEFAULT_PROVISION_DIR))
  const platform = process.platform

  if (platform === 'darwin') {
    for (const root of [join(HOME, 'Library', 'Caches', 'ms-playwright'), '/Applications']) {
      for (const build of playwrightBuilds(root)) {
        for (const inner of ['chrome-mac-arm64', 'chrome-mac-x64']) {
          add(join(root, build, inner, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'))
        }
      }
    }
    add('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    add(join(HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
    add('/Applications/Chromium.app/Contents/MacOS/Chromium')
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    add('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
  } else if (platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]
    for (const root of roots) {
      if (!root) continue
      add(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      add(join(root, 'Chromium', 'Application', 'chrome.exe'))
      add(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else {
    for (const root of [join(HOME, '.cache', 'ms-playwright')]) {
      for (const build of playwrightBuilds(root)) {
        add(join(root, build, 'chrome-linux64', 'chrome'))
        add(join(root, build, 'chrome-linux', 'chrome'))
      }
    }
    for (const path of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge']) {
      add(path)
    }
  }
  return found
}

/**
 * List Playwright chromium build directories, newest first.
 *
 * @param {string} root - a Playwright cache root.
 * @returns {string[]} directory names such as `chromium-1248`.
 */
function playwrightBuilds(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(right.slice('chromium-'.length)) - Number(left.slice('chromium-'.length)))
}

/**
 * Resolve the browser binary to drive.
 *
 * @param {{ chromePath?: string }} settings - normalized settings.
 * @returns {{ path: string, source: 'config' | 'auto' } | undefined} the binary, when one exists.
 */
export function resolveChrome(settings) {
  if (settings.chromePath) {
    return existsSync(settings.chromePath) ? { path: settings.chromePath, source: 'config' } : undefined
  }
  const [candidate] = chromeCandidates(settings)
  return candidate === undefined ? undefined : { path: candidate, source: 'auto' }
}

/**
 * Human-readable search path used in the failure message when no browser exists,
 * so the model can tell the user exactly what to install or configure.
 *
 * Paths under the home directory are shown with `~` so a failure message does
 * not carry the user's account name into a transcript.
 *
 * @param {{ chromePath?: string }} settings - normalized settings.
 * @returns {string} one-line guidance.
 */
export function missingBrowserHint(settings) {
  const parts = ['no Chromium-based browser was found.']
  if (settings.chromePath) {
    parts.push(`The configured chromePath does not exist: ${settings.chromePath}.`)
  }
  parts.push(
    'Install Google Chrome, or point this plugin at a browser with the chromePath config field',
    '(or the DSH_BROWSER_CHROME / CHROME_PATH environment variable).',
  )
  const candidates = chromeCandidates().map((candidate) => candidate.replace(HOME, '~'))
  if (candidates.length > 0) parts.push(`Tried: ${candidates.join(', ')}`)
  return parts.join(' ')
}

/**
 * Whether a path is a file (used by the acceptance script to assert a candidate
 * before spawning it).
 *
 * @param {string} path - filesystem path.
 * @returns {boolean} true for a regular file.
 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
