#!/usr/bin/env node
// browse.mjs — quiet CDP browser engine for Codex and DSH.
//
// Design goals, in order:
//   1. Never appear on screen while working (offscreen window, background tabs).
//   2. Never let one stuck page stall the rest (persistent daemon + target pool).
//   3. When a human is genuinely needed (CAPTCHA / sign-in), say so loudly through
//      a small floating HUD instead of yanking a browser window over the desktop.
//
// Layout: CLI on top, daemon underneath. The CLI is a thin client; the daemon owns
// the browser, the target pool and the HUD bridge. Every CLI call reuses the same
// daemon, so no call ever pays a cold start or races another one for the profile.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Defaults; every field is overridable through an environment variable. */
export const DEFAULTS = Object.freeze({
  profile: join(homedir(), 'Documents/deepseek-harness/default-workspace/.browse-profile'),
  stateDir: join(homedir(), '.dsh', 'browse-state'),
  port: 9333,
  hudPort: 9336,
  bin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Two screens to the left and up: macOS happily keeps a window there, and a
  // window that is never on screen cannot interrupt anything.
  position: '-4000,-4000',
  size: '1440,960',
  concurrency: 4,
  idleExitMs: 30 * 60 * 1000,
  hud: true,
  headless: false,
  gpu: true,
  mockKeychain: false,
  noSandbox: false,
})

/** Chrome launch flags that keep background pages alive and out of sight. */
const QUIET_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter',
  '--disable-crashpad',
  '--disable-breakpad',
  '--disable-hang-monitor',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-component-update',
]

/** Page states reported to callers and to the HUD. */
export const STATUS = Object.freeze({
  OK: 'OK',
  CAPTCHA: 'CAPTCHA',
  LOGIN: 'LOGIN',
  BLOCKED: 'BLOCKED',
  STUCK: 'STUCK',
  ERROR: 'ERROR',
})

/**
 * Read the effective configuration.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {typeof DEFAULTS} resolved configuration.
 */
export function readConfig(env = process.env, fileConfig = readStateConfig(env)) {
  const pick = (name, fallback) => {
    const raw = env[name]
    return raw === undefined || raw === '' ? fallback : raw
  }
  const num = (name, fallback) => {
    const value = Number(pick(name, fallback))
    return Number.isFinite(value) ? value : fallback
  }
  const flag = (name, fallback) => {
    const raw = pick(name, undefined)
    if (raw === undefined) return fallback
    return !/^(?:0|false|no|off)$/iu.test(String(raw))
  }
  // A per-machine preference file wins over the built-in defaults but never
  // over an explicit environment variable: the file exists so a setting such as
  // "this machine has accepted the mock keychain" does not have to be exported
  // into every shell, launchd job and agent run.
  const fromFile = (name, fallback) => (fileConfig[name] === undefined ? fallback : fileConfig[name])
  return {
    profile: pick('BROWSE_PROFILE', fromFile('profile', DEFAULTS.profile)),
    stateDir: pick('BROWSE_STATE', DEFAULTS.stateDir),
    port: num('BROWSE_PORT', fromFile('port', DEFAULTS.port)),
    hudPort: num('BROWSE_HUD_PORT', fromFile('hudPort', DEFAULTS.hudPort)),
    bin: pick('BROWSE_BIN', fromFile('bin', DEFAULTS.bin)),
    position: pick('BROWSE_POS', fromFile('position', DEFAULTS.position)),
    size: pick('BROWSE_SIZE', fromFile('size', DEFAULTS.size)),
    concurrency: num('BROWSE_CONCURRENCY', fromFile('concurrency', DEFAULTS.concurrency)),
    idleExitMs: num('BROWSE_IDLE_MS', fromFile('idleExitMs', DEFAULTS.idleExitMs)),
    hud: flag('BROWSE_HUD', fromFile('hud', DEFAULTS.hud)),
    headless: flag('BROWSE_HEADLESS', fromFile('headless', DEFAULTS.headless)),
    gpu: flag('BROWSE_GPU', fromFile('gpu', DEFAULTS.gpu)),
    mockKeychain: flag('BROWSE_MOCK_KEYCHAIN', fromFile('mockKeychain', DEFAULTS.mockKeychain)),
    noSandbox: flag('BROWSE_NOSANDBOX', fromFile('noSandbox', DEFAULTS.noSandbox)),
  }
}

/**
 * Read this machine's preference file, if it exists.
 *
 * Unknown keys are ignored and a broken file is treated as absent: a typo in a
 * config file must not stop the browser from starting.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment, for the state directory.
 * @returns {Record<string, unknown>} parsed preferences.
 */
export function readStateConfig(env = process.env) {
  const dir = env.BROWSE_STATE || DEFAULTS.stateDir
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Minimal CDP client over a WebSocket, with flattened target sessions. */
export class CDP {
  #socket
  #next = 0
  #pending = new Map()
  #listeners = new Map()
  #closed = false

  /** @param {WebSocket} socket - connected socket. */
  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => this.#dispatch(String(event.data)))
    socket.addEventListener('close', () => {
      this.#closed = true
      for (const { reject } of this.#pending.values()) reject(new Error('CDP socket closed'))
      this.#pending.clear()
    })
  }

  /**
   * Connect to a DevTools WebSocket URL.
   *
   * @param {string} url - `ws://...` endpoint.
   * @param {number} [timeoutMs] - connect budget.
   * @returns {Promise<CDP>} the client.
   */
  static async connect(url, timeoutMs = 8000) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${url}`)), timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${url}`)) }, { once: true })
    })
    return new CDP(socket)
  }

  #dispatch(raw) {
    let message
    try { message = JSON.parse(raw) } catch { return }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message ?? 'CDP error'}`))
      else entry.resolve(message.result ?? {})
      return
    }
    if (typeof message.method !== 'string') return
    const handlers = this.#listeners.get(message.method)
    if (handlers === undefined) return
    for (const handler of handlers) {
      try { handler(message.params ?? {}, message.sessionId) } catch { /* a listener must not break routing */ }
    }
  }

  /**
   * Send one CDP command.
   *
   * @param {string} method - CDP method name.
   * @param {object} [params] - parameters.
   * @param {string} [sessionId] - flattened target session.
   * @returns {Promise<any>} the command result.
   */
  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('CDP socket closed'))
    const id = ++this.#next
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 30000)
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.#socket.send(JSON.stringify(payload))
    })
  }

  /**
   * Subscribe to a CDP event.
   *
   * @param {string} method - event name.
   * @param {(params: object, sessionId?: string) => void} handler - listener.
   * @returns {() => void} unsubscribe.
   */
  on(method, handler) {
    const list = this.#listeners.get(method) ?? []
    list.push(handler)
    this.#listeners.set(method, list)
    return () => {
      const current = this.#listeners.get(method) ?? []
      this.#listeners.set(method, current.filter((entry) => entry !== handler))
    }
  }

  /** Close the socket. */
  close() {
    try { this.#socket.close() } catch { /* already gone */ }
  }
}

/**
 * Probe a DevTools HTTP endpoint.
 *
 * @param {number} port - debugging port.
 * @returns {Promise<{ endpoint: string, browser: string } | undefined>} identity when alive.
 */
export async function probe(port) {
  const endpoint = `http://127.0.0.1:${port}`
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1200) })
    if (!response.ok) return undefined
    const body = await response.json()
    const socket = body?.webSocketDebuggerUrl
    if (typeof socket !== 'string') return undefined
    const match = /\/devtools\/browser\/([0-9a-f-]+)/iu.exec(socket)
    return { endpoint, browser: match?.[1] ?? socket }
  } catch {
    return undefined
  }
}

/**
 * Every `http(s)` URL inside a chunk of text, de-duplicated.
 *
 * @param {string[]} values - arguments as typed.
 * @returns {string[]} absolute URLs.
 */
export function collectUrls(values) {
  const found = []
  for (const value of values) {
    // `file:` is accepted so a local fixture can be driven through the same
    // path as a remote page (used by the acceptance checks).
    for (const match of String(value).matchAll(/(?:https?|file):\/\/[^\s"'<>]+/giu)) found.push(match[0])
  }
  return [...new Set(found)]
}

/** The in-page probe: everything the classifier needs, in one round trip. */
export const PROBE_SCRIPT = `(() => {
  const seen = (selector) => { try { return document.querySelector(selector) !== null } catch { return false } };
  const visible = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const box = node.getBoundingClientRect();
    return box.width > 4 && box.height > 4;
  };
  const body = document.body;
  const text = (body ? body.innerText : '') || '';
  const passwordFields = [...document.querySelectorAll('input[type="password"]')].filter(visible).length;
  const loginInputs = [...document.querySelectorAll('input[type="email"],input[name*="user" i],input[name*="login" i],input[id*="login" i],input[name*="email" i]')].filter(visible).length;
  return {
    url: location.href,
    title: document.title || '',
    ready: document.readyState,
    text: text.slice(0, 3000),
    textLength: text.length,
    passwordFields,
    loginInputs,
    marks: {
      turnstile: seen('iframe[src*="challenges.cloudflare.com"]'),
      cloudflare: seen('#challenge-form') || seen('#cf-challenge-running') || seen('#challenge-running'),
      recaptcha: seen('iframe[src*="recaptcha"]') || seen('.g-recaptcha'),
      hcaptcha: seen('iframe[src*="hcaptcha.com"]') || seen('.h-captcha'),
      datadome: seen('iframe[src*="captcha-delivery.com"]') || seen('#datadome-captcha'),
      awswaf: seen('#captcha-container') || seen('awswaf-captcha'),
      arkose: seen('iframe[src*="arkoselabs"]') || seen('#funcaptcha'),
      slider: seen('.slider-container') || seen('[class*="slide-verify" i]') || seen('[class*="slider" i]'),
    },
  };
})()`

const CAPTCHA_TITLE = /just a moment|attention required|checking your browser|security check|ddos-guard|access denied/iu
const CAPTCHA_TEXT = /verify(?:ing)? (?:that )?you are (?:a )?human|checking your browser|please wait while we|enable javascript and cookies|安全验证|人机验证|滑动验证|请完成验证|确认您是真人|访问验证/iu
const LOGIN_TEXT = /sign in|log in|login|登录|登入|账号|密\s*码/iu

/**
 * Turn one probe result into a status.
 *
 * Pure so the mapping can be tested without a browser.
 *
 * @param {{ title?: string, url?: string, text?: string, ready?: string, passwordFields?: number, marks?: Record<string, boolean> }} probe - in-page facts.
 * @returns {{ status: string, reason: string }} classification.
 */
export function classify(probe) {
  const title = String(probe.title ?? '')
  const url = String(probe.url ?? '')
  const text = String(probe.text ?? '')
  const marks = probe.marks ?? {}
  const blocking = ['turnstile', 'cloudflare', 'recaptcha', 'hcaptcha', 'datadome', 'awswaf', 'arkose']
  const hit = blocking.find((name) => marks[name] === true)
  if (hit !== undefined) return { status: STATUS.CAPTCHA, reason: hit }
  if (marks.slider === true) return { status: STATUS.CAPTCHA, reason: 'slider' }
  if (CAPTCHA_TITLE.test(title) || CAPTCHA_TEXT.test(text)) return { status: STATUS.CAPTCHA, reason: 'text' }
  const wantsLogin = /login|signin|sign-in|auth|sso|passport|account/i.test(url) || /sign in|log in|登录|登入/iu.test(title)
  if (Number(probe.passwordFields) > 0 && (wantsLogin || LOGIN_TEXT.test(text))) return { status: STATUS.LOGIN, reason: 'password-field' }
  if (/^(?:403|429|503)$/u.test(String(probe.statusLine ?? ''))) return { status: STATUS.BLOCKED, reason: 'status' }
  if (text.trim().length < 40 && probe.ready !== 'complete') return { status: STATUS.STUCK, reason: 'loading' }
  if (text.trim().length === 0) return { status: STATUS.STUCK, reason: 'empty' }
  return { status: STATUS.OK, reason: 'content' }
}

/**
 * Read a JPEG's pixel size out of its SOF segment.
 *
 * @param {Buffer} buffer - JPEG bytes.
 * @returns {{ width: number, height: number } | undefined} size when found.
 */
export function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) return undefined
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xFF) { offset += 1; continue }
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

/** Owns the browser process, the target pool and the HUD bridge. */
export class Engine {
  #cdp
  #childPid
  #hudPid
  #idleTimer
  #watchers = new Map()

  /**
   * @param {typeof DEFAULTS} cfg - resolved configuration.
   * @param {(line: string) => void} [log] - sink for diagnostics.
   */
  constructor(cfg, log = () => {}) {
    this.cfg = cfg
    this.log = log
    /** @type {Map<string, { id: string, sessionId: string, url: string, title: string, status: string, reason: string, updatedAt: number, handled: boolean }>} */
    this.tabs = new Map()
    this.hudTarget = undefined
    this.hudSeen = 0
  }

  /** Debugging port actually in use. */
  get port() { return this.cfg.port }

  /**
   * Marker file describing the browser this profile owns.
   *
   * @returns {string} path.
   */
  markerPath() { return join(this.cfg.stateDir, 'browser.json') }

  /**
   * Start (or adopt) the browser and connect the DevTools socket.
   *
   * @returns {Promise<void>} resolves once commands can be issued.
   */
  async start() {
    if (this.#cdp !== undefined) return
    mkdirSync(this.cfg.stateDir, { recursive: true })
    const marker = join(this.cfg.profile, 'Default', 'Preferences')
    const legacy = join(this.cfg.profile, 'Local State')
    if (!existsSync(this.cfg.profile) || (!existsSync(marker) && !existsSync(legacy))) {
      throw new Error(
        `the pinned profile does not exist: ${this.cfg.profile}\n` +
        'Refusing to create a fresh one: an empty profile silently loses every login state.\n' +
        'Point BROWSE_PROFILE at a profile you have already signed into.',
      )
    }
    const adopted = await this.#adopt()
    if (adopted !== undefined) {
      this.#cdp = adopted
      // An adopted browser may have been left on screen by an earlier run.
      await this.park()
      this.conceal()
      return
    }
    await this.#launch()
    const info = await this.#waitEndpoint()
    this.#cdp = await CDP.connect(info.socket)
    writeFileSync(this.markerPath(), `${JSON.stringify({ endpoint: info.endpoint, browser: info.browser, pid: this.#childPid ?? null, profile: this.cfg.profile })}\n`)
    await this.park()
    this.conceal()
    this.log(`browser ready on ${info.endpoint}`)
  }

  /**
   * Reuse a browser this profile already published, when the identity matches.
   *
   * @returns {Promise<CDP | undefined>} a connected client, or undefined.
   */
  async #adopt() {
    if (!existsSync(this.markerPath())) return undefined
    let marker
    try { marker = JSON.parse(readFileSync(this.markerPath(), 'utf8')) } catch { return undefined }
    const live = await probe(this.cfg.port)
    if (live === undefined || live.browser !== marker.browser) return undefined
    try {
      return await CDP.connect(`ws://127.0.0.1:${this.cfg.port}/devtools/browser/${live.browser}`)
    } catch {
      return undefined
    }
  }

  /** Launch Chrome with the quiet flag set. */
  async #launch() {
    if (!existsSync(this.cfg.bin)) {
      throw new Error(`browser binary not found: ${this.cfg.bin}\nSet BROWSE_BIN to a Chrome/Chromium executable.`)
    }
    const args = [
      `--remote-debugging-port=${this.cfg.port}`,
      `--user-data-dir=${this.cfg.profile}`,
      ...QUIET_FLAGS,
      `--window-position=${this.cfg.position}`,
      `--window-size=${this.cfg.size}`,
    ]
    if (this.cfg.headless) args.push('--headless=new')
    if (!this.cfg.gpu) args.push('--disable-gpu')
    if (this.cfg.noSandbox) args.push('--no-sandbox')
    if (this.cfg.mockKeychain) args.push('--use-mock-keychain')
    args.push('about:blank')
    const child = spawn(this.cfg.bin, args, { detached: true, stdio: 'ignore' })
    child.unref()
    this.#childPid = child.pid
    child.on('error', (error) => this.log(`launch error: ${error.message}`))
  }

  /**
   * Wait for the DevTools endpoint this launch publishes.
   *
   * @returns {Promise<{ endpoint: string, socket: string, browser: string }>} endpoint facts.
   */
  async #waitEndpoint() {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      await sleep(200)
      const live = await probe(this.cfg.port)
      if (live === undefined) continue
      const response = await fetch(`${live.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })
      const body = await response.json()
      return { endpoint: live.endpoint, socket: body.webSocketDebuggerUrl, browser: live.browser }
    }
    throw new Error(`the browser did not publish DevTools on port ${this.cfg.port} within 25s (profile: ${this.cfg.profile})`)
  }

  /**
   * Move every open window off screen.
   *
   * Chrome restores a profile's saved window frame on launch and ignores
   * `--window-position` when that frame exists, so the flag alone is not enough:
   * the window has to be parked again after the browser is up.
   *
   * @returns {Promise<void>} resolves once every window is moved.
   */
  async park() {
    if (this.cfg.headless) return
    const [left, top] = this.cfg.position.split(',').map((value) => Number(value.trim()))
    if (!Number.isFinite(left) || !Number.isFinite(top)) return
    let targets = []
    try { targets = (await this.#cdp.send('Target.getTargets')).targetInfos ?? [] } catch { return }
    const seen = new Set()
    for (const target of targets) {
      if (target.type !== 'page') continue
      try {
        const { windowId } = await this.#cdp.send('Browser.getWindowForTarget', { targetId: target.targetId })
        if (seen.has(windowId)) continue
        seen.add(windowId)
        await this.#cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top, windowState: 'normal' } })
      } catch { /* a window that refuses to move is not fatal */ }
    }
  }

  /** Pid of the browser process, launched here or recorded in the marker. */
  browserPid() {
    if (this.#childPid !== undefined) return this.#childPid
    try {
      const pid = Number(JSON.parse(readFileSync(this.markerPath(), 'utf8')).pid)
      return Number.isFinite(pid) && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Get the browser off the desktop.
   *
   * Moving the window does not work: Chrome clamps a window frame to the visible
   * screen, so `-4000,-4000` lands at `0,30`. Hiding the application is the only
   * thing macOS honours, and a hidden Chrome still composites, which keeps
   * `Page.captureScreenshot` and page timers alive.
   *
   * @returns {void}
   */
  conceal() {
    if (this.cfg.headless) return
    const pid = this.browserPid()
    if (pid === undefined) return
    const helper = join(HERE, 'hud', 'browse-ax')
    if (!existsSync(helper)) { this.log('browse-ax missing: the window stays visible'); return }
    const result = spawnSync(helper, ['hide', String(pid)], { timeout: 5000 })
    if (result.status !== 0) this.log(`conceal failed for pid ${pid}`)
  }

  /** Bring the application back so a human can look at it. */
  unconceal() {
    const pid = this.browserPid()
    if (pid === undefined) return
    const helper = join(HERE, 'hud', 'browse-ax')
    if (existsSync(helper)) spawnSync(helper, ['show', String(pid)], { timeout: 5000 })
  }

  /**
   * Open a tab without stealing the foreground.
   *
   * @param {string} [url] - initial URL.
   * @param {{ background?: boolean }} [options] - activation policy.
   * @returns {Promise<{ id: string, sessionId: string }>} the new tab.
   */
  async createTarget(url = 'about:blank', { background = true } = {}) {
    const { targetId } = await this.#cdp.send('Target.createTarget', { url: 'about:blank', background, newWindow: false })
    const { sessionId } = await this.#cdp.send('Target.attachToTarget', { targetId, flatten: true })
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) {
      await this.#cdp.send(method, {}, sessionId).catch(() => {})
    }
    // A page that believes it is focused keeps running animations, timers and
    // visibility-dependent scripts; without this an offscreen tab looks idle.
    await this.#cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {})
    this.tabs.set(targetId, {
      id: targetId,
      sessionId,
      url: 'about:blank',
      title: '',
      status: STATUS.STUCK,
      reason: 'new',
      updatedAt: Date.now(),
      handled: false,
    })
    if (url !== 'about:blank') await this.navigate(targetId, url)
    return { id: targetId, sessionId }
  }

  /**
   * Navigate a tab and wait for its document to settle.
   *
   * @param {string} id - target id.
   * @param {string} url - destination.
   * @param {{ timeoutMs?: number }} [options] - navigation budget.
   * @returns {Promise<{ status: string, reason: string }>} classification.
   */
  async navigate(id, url, { timeoutMs = 30000 } = {}) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    const loaded = new Promise((resolve) => {
      const off = this.#cdp.on('Page.loadEventFired', (_params, sessionId) => {
        if (sessionId === tab.sessionId) { off(); resolve('load') }
      })
      setTimeout(() => { off(); resolve('timeout') }, timeoutMs)
    })
    await this.#cdp.send('Page.navigate', { url }, tab.sessionId).catch(() => {})
    await loaded
    tab.url = url
    return this.probe(id)
  }

  /**
   * Read the page's state and classify it.
   *
   * @param {string} id - target id.
   * @param {{ settleMs?: number }} [options] - extra settle time.
   * @returns {Promise<{ status: string, reason: string, title: string, url: string }>} classification.
   */
  async probe(id, { settleMs = 350 } = {}) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    await sleep(settleMs)
    let answer
    try {
      answer = await this.#cdp.send('Runtime.evaluate', {
        expression: PROBE_SCRIPT,
        returnByValue: true,
        awaitPromise: false,
      }, tab.sessionId)
    } catch (error) {
      tab.status = STATUS.ERROR
      tab.reason = String(error.message ?? error)
      tab.updatedAt = Date.now()
      throw error
    }
    const probeValue = answer?.result?.value ?? {}
    const verdict = classify(probeValue)
    // A page that is still loading is worth one more look before calling it stuck.
    if (verdict.status === STATUS.STUCK) {
      await sleep(1200)
      try {
        const retry = await this.#cdp.send('Runtime.evaluate', { expression: PROBE_SCRIPT, returnByValue: true }, tab.sessionId)
        const again = classify(retry?.result?.value ?? {})
        if (again.status !== STATUS.STUCK) Object.assign(verdict, again)
      } catch { /* keep the first verdict */ }
    }
    tab.url = String(probeValue.url ?? tab.url)
    tab.title = String(probeValue.title ?? '')
    tab.status = verdict.status
    tab.reason = verdict.reason
    tab.updatedAt = Date.now()
    if (verdict.status === STATUS.CAPTCHA || verdict.status === STATUS.LOGIN) this.#nudge(id)
    return { status: verdict.status, reason: verdict.reason, title: tab.title, url: tab.url }
  }

  /**
   * Evaluate an expression in a tab.
   *
   * @param {string} id - target id.
   * @param {string} expression - JavaScript source.
   * @param {{ awaitPromise?: boolean, timeoutMs?: number }} [options] - evaluation options.
   * @returns {Promise<any>} the by-value result.
   */
  async evaluate(id, expression, { awaitPromise = true } = {}) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    const answer = await this.#cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, tab.sessionId)
    if (answer?.exceptionDetails !== undefined) {
      throw new Error(answer.exceptionDetails.text ?? 'evaluation failed')
    }
    return answer?.result?.value
  }

  /**
   * One JPEG frame of a tab, for the HUD.
   *
   * @param {string} id - target id.
   * @returns {Promise<Buffer | undefined>} JPEG bytes.
   */
  async frame(id) {
    const tab = this.tabs.get(id)
    if (tab === undefined) return undefined
    const shot = await this.#cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 62, captureBeyondViewport: false }, tab.sessionId)
    if (typeof shot?.data !== 'string') return undefined
    return Buffer.from(shot.data, 'base64')
  }

  /**
   * CSS viewport of a tab plus its scroll offset.
   *
   * @param {string} id - target id.
   * @returns {Promise<{ width: number, height: number, scrollX: number, scrollY: number }>} metrics.
   */
  async viewport(id) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    const metrics = await this.#cdp.send('Page.getLayoutMetrics', {}, tab.sessionId)
    const view = metrics?.cssVisualViewport ?? metrics?.visualViewport ?? {}
    const content = metrics?.cssContentSize ?? {}
    return {
      width: Number(view.clientWidth ?? content.width ?? 1280),
      height: Number(view.clientHeight ?? content.height ?? 800),
      scrollX: Number(view.pageX ?? 0),
      scrollY: Number(view.pageY ?? 0),
    }
  }

  /**
   * Replay a pointer gesture with human-ish motion, then the click.
   *
   * @param {string} id - target id.
   * @param {{ x: number, y: number }} point - CSS pixels.
   * @returns {Promise<void>} resolves once both events are dispatched.
   */
  async click(id, { x, y }) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    const steps = 6
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      const ease = t * t * (3 - 2 * t)
      await this.#cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x * (0.6 + 0.4 * ease)),
        y: Math.round(y * (0.6 + 0.4 * ease)),
      }, tab.sessionId)
      await sleep(35)
    }
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 }
    await this.#cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, tab.sessionId)
    await sleep(60)
    await this.#cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, tab.sessionId)
  }

  /**
   * Type text into whatever the page has focused.
   *
   * @param {string} id - target id.
   * @param {string} text - literal text.
   * @returns {Promise<void>} resolves once inserted.
   */
  async type(id, text) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    await this.#cdp.send('Input.insertText', { text }, tab.sessionId)
  }

  /**
   * Move the real window back on screen, only when a human asked for it.
   *
   * @param {string} id - target id.
   * @returns {Promise<void>} resolves once the window is visible and fronted.
   */
  async reveal(id) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    this.unconceal()
    const { windowId } = await this.#cdp.send('Browser.getWindowForTarget', { targetId: id })
    await this.#cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 160, top: 120, width: 1280, height: 900, windowState: 'normal' },
    }).catch(() => {})
    await this.#cdp.send('Target.activateTarget', { targetId: id }).catch(() => {})
  }

  /**
   * Cookies for a URL, straight from the browser's own jar.
   *
   * @param {string} id - target id.
   * @param {string} url - page URL.
   * @returns {Promise<Array<{ name: string, value: string }>>} cookies.
   */
  async cookies(id, url) {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error(`unknown tab: ${id}`)
    const result = await this.#cdp.send('Network.getCookies', { urls: [url] }, tab.sessionId)
    return (result?.cookies ?? []).map((cookie) => ({ name: cookie.name, value: cookie.value }))
  }

  /**
   * User agent of the running browser.
   *
   * @param {string} id - target id.
   * @returns {Promise<string>} the UA string.
   */
  async userAgent(id) {
    return String(await this.evaluate(id, 'navigator.userAgent'))
  }

  /** Close one tab and forget it. */
  async closeTab(id) {
    try { await this.#cdp.send('Target.closeTarget', { targetId: id }) } catch { /* already gone */ }
    this.tabs.delete(id)
    if (this.hudTarget === id) this.hudTarget = undefined
  }

  /**
   * Show the floating HUD for a tab that needs a human.
   *
   * @param {string} id - target id.
   * @returns {Promise<void>} resolves once the panel process is running.
   */
  async #nudge(id) {
    if (!this.cfg.hud) return
    this.hudTarget = id
    this.watch(id)
    const binary = join(HERE, 'hud', 'browse-hud')
    if (!existsSync(binary)) return
    if (this.#hudPid !== undefined) {
      try { process.kill(this.#hudPid, 0); return } catch { this.#hudPid = undefined }
    }
    const child = spawn(binary, [`--port=${this.cfg.hudPort}`], { detached: true, stdio: 'ignore' })
    child.unref()
    this.#hudPid = child.pid
    this.log(`hud started (pid ${child.pid}) for ${id}`)
  }

  /**
   * Re-check a tab that is waiting for a human, and close the HUD when it clears.
   *
   * Without this the panel would stay up after a hand-solved CAPTCHA, which is
   * exactly the kind of stale UI that makes a tool annoying.
   *
   * @param {string} id - target id.
   * @returns {void}
   */
  watch(id) {
    if (this.#watchers.has(id)) return
    const timer = setInterval(async () => {
      const tab = this.tabs.get(id)
      if (tab === undefined || tab.handled === true) { this.unwatch(id); return }
      try { await this.probe(id, { settleMs: 0 }) } catch { this.unwatch(id); return }
      if (tab.status === STATUS.OK) {
        this.unwatch(id)
        if (this.hudTarget === id) this.hudTarget = undefined
        this.log(`human step cleared for ${id}`)
      }
    }, 1500)
    timer.unref?.()
    this.#watchers.set(id, timer)
  }

  /**
   * Stop watching a tab.
   *
   * @param {string} id - target id.
   * @returns {void}
   */
  unwatch(id) {
    const timer = this.#watchers.get(id)
    if (timer !== undefined) clearInterval(timer)
    this.#watchers.delete(id)
  }

  /** Stop the browser this engine launched, and the HUD. */
  async shutdown() {
    for (const id of [...this.#watchers.keys()]) this.unwatch(id)
    try { if (this.#hudPid !== undefined) process.kill(this.#hudPid, 'SIGTERM') } catch { /* gone */ }
    for (const id of [...this.tabs.keys()]) await this.closeTab(id)
    // Ask Chrome to shut itself down before signalling it: it batches cookie
    // writes (about every 30s), so a SIGTERM right after a sign-in can throw the
    // fresh session away. Browser.close lets it flush on the way out.
    try { await this.#cdp?.send('Browser.close') } catch { /* older builds */ }
    for (let waited = 0; waited < 3000; waited += 200) {
      if ((await probe(this.cfg.port)) === undefined) break
      await sleep(200)
    }
    this.#cdp?.close()
    this.#cdp = undefined
    // The browser may have been adopted rather than launched by this process, so
    // the pid is read back from the marker when the in-memory copy is missing.
    let pid = this.#childPid
    if (pid === undefined && existsSync(this.markerPath())) {
      try { pid = Number(JSON.parse(readFileSync(this.markerPath(), 'utf8')).pid) || undefined } catch { pid = undefined }
    }
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      this.#childPid = undefined
    }
    try { rmSync(this.markerPath(), { force: true }) } catch { /* no marker */ }
  }

  /**
   * Run tasks with a fixed concurrency budget.
   *
   * @template T
   * @param {Array<() => Promise<T>>} tasks - thunks to run.
   * @param {number} limit - maximum in flight.
   * @returns {Promise<Array<{ ok: boolean, value?: T, error?: string }>>} settled results.
   */
  async pool(tasks, limit = this.cfg.concurrency) {
    const results = new Array(tasks.length)
    let next = 0
    const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
      for (;;) {
        const index = next++
        if (index >= tasks.length) return
        try { results[index] = { ok: true, value: await tasks[index]() } }
        catch (error) { results[index] = { ok: false, error: String(error?.message ?? error) } }
      }
    })
    await Promise.all(workers)
    return results
  }
}

/** HTML-comment-free JSON reply helper for the HUD endpoints. */
function json(response, body, code = 200) {
  const payload = JSON.stringify(body)
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

/**
 * Start the localhost HTTP bridge the floating HUD polls.
 *
 * A polled HTTP surface is deliberately dumber than a WebSocket: the panel is a
 * native view, and a few tiny requests per second beat keeping a socket alive in
 * two languages.
 *
 * @param {Engine} engine - running engine.
 * @param {(line: string) => void} log - diagnostics sink.
 * @returns {Promise<import('node:http').Server>} the listening server.
 */
export async function startHudServer(engine, log = () => {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${engine.cfg.hudPort}`)
    const target = url.searchParams.get('t') ?? engine.hudTarget
    try {
      if (url.pathname === '/hud/meta') {
        const tab = target === undefined ? undefined : engine.tabs.get(target)
        if (tab === undefined) return json(response, { active: false, status: 'GONE' })
        return json(response, {
          active: true,
          target: tab.id,
          status: tab.status,
          reason: tab.reason,
          title: tab.title,
          url: tab.url,
        })
      }
      if (url.pathname === '/hud/frame') {
        if (target === undefined) { response.writeHead(204).end(); return }
        const frame = await engine.frame(target)
        if (frame === undefined) { response.writeHead(204).end(); return }
        response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': frame.length })
        response.end(frame)
        return
      }
      if (request.method === 'POST') {
        const body = await new Promise((resolve) => {
          let raw = ''
          request.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) request.destroy() })
          request.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
        })
        const id = body.t ?? target
        if (id === undefined) return json(response, { ok: false, error: 'no target' }, 400)
        if (url.pathname === '/hud/click') {
          const view = await engine.viewport(id)
          await engine.click(id, { x: Number(body.x) * view.width + view.scrollX, y: Number(body.y) * view.height + view.scrollY })
          return json(response, { ok: true })
        }
        if (url.pathname === '/hud/type') {
          await engine.type(id, String(body.text ?? ''))
          return json(response, { ok: true })
        }
        if (url.pathname === '/hud/reveal') {
          await engine.reveal(id)
          return json(response, { ok: true })
        }
        if (url.pathname === '/hud/retry') {
          const tab = engine.tabs.get(id)
          if (tab !== undefined) await engine.probe(id)
          return json(response, { ok: true })
        }
        if (url.pathname === '/hud/dismiss') {
          const tab = engine.tabs.get(id)
          if (tab !== undefined) tab.handled = true
          if (engine.hudTarget === id) engine.hudTarget = undefined
          return json(response, { ok: true })
        }
        return json(response, { ok: false, error: 'unknown endpoint' }, 404)
      }
      return json(response, { ok: false, error: 'not found' }, 404)
    } catch (error) {
      log(`hud error: ${error?.message ?? error}`)
      return json(response, { ok: false, error: String(error?.message ?? error) }, 500)
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(engine.cfg.hudPort, '127.0.0.1', () => resolve())
  })
  return server
}

/** Unix socket the CLI talks to. */
function socketPath(cfg) {
  return join(cfg.stateDir, 'engine.sock')
}

/**
 * Dispatch one daemon command.
 *
 * @param {Engine} engine - running engine.
 * @param {any} op - command payload.
 * @returns {Promise<any>} the reply.
 */
async function runOperation(engine, op) {
  switch (op.op) {
    case 'status': {
      await engine.start()
      return {
        ok: true,
        endpoint: `http://127.0.0.1:${engine.cfg.port}`,
        profile: engine.cfg.profile,
        tabs: [...engine.tabs.values()].map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, status: tab.status })),
      }
    }
    case 'open': {
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      const verdict = await engine.navigate(id, op.url)
      const tab = engine.tabs.get(id)
      return { ok: true, id, url: tab.url, title: tab.title, status: verdict.status, reason: verdict.reason }
    }
    case 'show': {
      // The window is hidden while the engine works, which also means a human
      // cannot sign in. `show` is the explicit "let me look at it" door: open a
      // tab, bring the application back, front the window.
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      const verdict = await engine.navigate(id, op.url)
      await engine.reveal(id)
      const tab = engine.tabs.get(id)
      return { ok: true, id, url: tab?.url ?? op.url, title: tab?.title ?? '', status: verdict.status, reason: verdict.reason, visible: true }
    }
    case 'visit': {
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      const verdict = await engine.navigate(id, op.url)
      if (verdict.status === STATUS.CAPTCHA || verdict.status === STATUS.LOGIN) {
        return { ok: false, status: verdict.status, reason: verdict.reason, id, url: op.url, title: engine.tabs.get(id)?.title ?? '' }
      }
      const extract = await engine.evaluate(id, `(() => ({
        text: document.body ? document.body.innerText : '',
        html: document.documentElement ? document.documentElement.outerHTML : '',
        title: document.title || '',
        url: location.href,
      }))()`)
      await engine.closeTab(id)
      const content = op.kind === 'html' ? String(extract?.html ?? '') : String(extract?.text ?? '')
      return { ok: true, status: STATUS.OK, url: extract?.url ?? op.url, title: extract?.title ?? '', content: content.slice(0, op.limit ?? 400000) }
    }
    case 'eval': {
      await engine.start()
      // With an explicit target the expression runs in a tab that is already
      // open (used to inspect a page waiting for a human); otherwise a throwaway
      // tab is used so one-shot evaluations never leak tabs.
      if (typeof op.id === 'string' && op.id.length > 0) {
        return { ok: true, value: await engine.evaluate(op.id, String(op.js)) }
      }
      const { id } = await engine.createTarget('about:blank')
      try {
        if (typeof op.url === 'string' && op.url.length > 0) await engine.navigate(id, op.url)
        const value = await engine.evaluate(id, String(op.js))
        return { ok: true, value }
      } finally {
        await engine.closeTab(id)
      }
    }
    case 'shot': {
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      try {
        if (typeof op.url === 'string' && op.url.length > 0) await engine.navigate(id, op.url)
        const view = await engine.viewport(id)
        const shot = await engine.frame(id)
        if (shot === undefined) return { ok: false, error: 'no frame' }
        const { writeFileSync: write } = await import('node:fs')
        write(op.out, shot)
        return { ok: true, path: op.out, bytes: shot.length, viewport: view }
      } finally {
        await engine.closeTab(id)
      }
    }
    case 'cookies': {
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      try {
        if (typeof op.url === 'string') await engine.navigate(id, op.url)
        return { ok: true, cookies: await engine.cookies(id, op.url) }
      } finally {
        await engine.closeTab(id)
      }
    }
    case 'ua': {
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      try { return { ok: true, userAgent: await engine.userAgent(id) } }
      finally { await engine.closeTab(id) }
    }
    case 'download': {
      await engine.start()
      const { id } = await engine.createTarget('about:blank')
      try {
        await engine.navigate(id, op.url)
        const [cookies, agent] = await Promise.all([engine.cookies(id, op.url), engine.userAgent(id)])
        const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ')
        const response = await fetch(op.url, {
          headers: { 'user-agent': agent, referer: op.url, cookie },
          signal: AbortSignal.timeout(op.timeoutMs ?? 120000),
        })
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const bytes = Buffer.from(await response.arrayBuffer())
        const { writeFileSync: write } = await import('node:fs')
        write(op.dest, bytes)
        return { ok: true, path: op.dest, bytes: bytes.length, contentType: response.headers.get('content-type') }
      } finally {
        await engine.closeTab(id)
      }
    }
    case 'batch': {
      await engine.start()
      const tasks = (op.urls ?? []).map((url) => async () => {
        const { id } = await engine.createTarget('about:blank')
        try {
          const verdict = await engine.navigate(id, url, { timeoutMs: op.timeoutMs ?? 30000 })
          const tab = engine.tabs.get(id)
          let content = ''
          if (verdict.status === STATUS.OK) {
            const extract = await engine.evaluate(id, '(() => (document.body ? document.body.innerText : "") )()')
            content = String(extract ?? '').slice(0, op.limit ?? 20000)
          }
          return { url, status: verdict.status, reason: verdict.reason, title: tab?.title ?? '', content }
        } finally {
          const tab = engine.tabs.get(id)
          if (tab !== undefined && (tab.status === STATUS.CAPTCHA || tab.status === STATUS.LOGIN)) {
            tab.handled = false
          } else {
            await engine.closeTab(id)
          }
        }
      })
      const results = await engine.pool(tasks, op.concurrency ?? engine.cfg.concurrency)
      return { ok: true, results: results.map((entry) => (entry.ok ? entry.value : { url: '?', status: STATUS.ERROR, reason: entry.error })) }
    }
    case 'hud': {
      await engine.start()
      const id = op.id ?? engine.hudTarget
      if (id === undefined) return { ok: false, error: 'no target waiting for a human' }
      engine.hudTarget = id
      await engine.probe(id)
      const binary = join(HERE, 'hud', 'browse-hud')
      if (!existsSync(binary)) return { ok: false, error: `hud binary missing: ${binary}` }
      const child = spawn(binary, [`--port=${engine.cfg.hudPort}`], { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, id, hudPid: child.pid }
    }
    case 'shutdown': {
      await engine.shutdown()
      return { ok: true }
    }
    default:
      return { ok: false, error: `unknown op: ${op.op}` }
  }
}

/**
 * Run the daemon: unix socket in, JSON out, idle self-exit.
 *
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<void>} never resolves while the daemon is healthy.
 */
export async function runDaemon(cfg) {
  mkdirSync(cfg.stateDir, { recursive: true })
  const path = socketPath(cfg)
  try { rmSync(path, { force: true }) } catch { /* stale socket */ }
  const log = (line) => {
    try { writeFileSync(join(cfg.stateDir, 'engine.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' }) } catch { /* disk full */ }
  }
  const engine = new Engine(cfg, log)
  const hud = await startHudServer(engine, log).catch(() => undefined)
  const server = createNetServer((connection) => {
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('data', async (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const raw = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let op
      try { op = JSON.parse(raw) } catch { connection.end(`${JSON.stringify({ ok: false, error: 'bad json' })}\n`); return }
      let reply
      try { reply = await runOperation(engine, op) }
      catch (error) { reply = { ok: false, error: String(error?.message ?? error) } }
      connection.end(`${JSON.stringify(reply)}\n`)
      // `close` means "nothing of mine is left running". Keeping the daemon alive
      // would also keep the old configuration in memory, so a changed default
      // (mock keychain, window policy) would silently not apply until reboot.
      if (op.op === 'shutdown') setTimeout(() => process.exit(0), 100)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  writeFileSync(join(cfg.stateDir, 'engine.pid'), `${process.pid}\n`)
  log(`daemon ready (pid ${process.pid})`)
  const stop = async () => {
    try { server.close() } catch { /* closed */ }
    try { hud?.close() } catch { /* closed */ }
    try { rmSync(path, { force: true }) } catch { /* gone */ }
    try { rmSync(join(cfg.stateDir, 'engine.pid'), { force: true }) } catch { /* gone */ }
    process.exit(0)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop() })
  // The socket and the HTTP bridge hold the event loop open; this await makes
  // the contract explicit so a caller cannot exit while the daemon is healthy.
  await new Promise(() => {})
}

/**
 * Talk to the daemon, starting one when it is not running yet.
 *
 * @param {typeof DEFAULTS} cfg - configuration.
 * @param {any} op - command payload.
 * @returns {Promise<any>} the reply.
 */
export async function callDaemon(cfg, op) {
  const path = socketPath(cfg)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await new Promise((resolve) => {
      const socket = createConnection(path)
      let raw = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${JSON.stringify(op)}\n`))
      socket.on('data', (chunk) => { raw += chunk })
      socket.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve(undefined) } })
      socket.on('error', () => resolve(undefined))
    })
    if (reply !== undefined) return reply
    if (attempt === 0) await startDaemon(cfg)
  }
  throw new Error('the browser daemon did not answer')
}

/**
 * Spawn the daemon detached and wait for its socket to accept connections.
 *
 * @param {typeof DEFAULTS} cfg - configuration.
 * @returns {Promise<void>} resolves once the socket exists.
 */
export async function startDaemon(cfg) {
  mkdirSync(cfg.stateDir, { recursive: true })
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BROWSE_STATE: cfg.stateDir },
  })
  child.unref()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await sleep(120)
    if (existsSync(socketPath(cfg))) return
  }
  throw new Error(`the daemon did not start (state dir: ${cfg.stateDir})`)
}

/** Exit codes double as the machine-readable verdict for a stuck page. */
const EXIT = { ok: 0, captcha: 10, login: 11, blocked: 12, stuck: 13, error: 14 }

/**
 * Map a daemon status onto a process exit code.
 *
 * @param {string} status - classification.
 * @returns {number} exit code.
 */
export function exitCodeFor(status) {
  switch (status) {
    case STATUS.OK: return EXIT.ok
    case STATUS.CAPTCHA: return EXIT.captcha
    case STATUS.LOGIN: return EXIT.login
    case STATUS.BLOCKED: return EXIT.blocked
    case STATUS.STUCK: return EXIT.stuck
    default: return EXIT.error
  }
}

const HELP = `browse.mjs — quiet CDP browser for Codex / DSH

  open <url>                 open a background tab and report its state
  show <url>                 open a tab AND bring the window back (signing in)
  text <url>                 print the page's visible text
  html <url>                 print the page's HTML
  goto <url>                 alias for text
  eval <js>                  evaluate JS (BROWSE_URL=<url> to navigate first)
  shot <url> <out.jpg>       save one JPEG frame
  cookies <url>              dump cookies as JSON
  dl <url> <path>            download with the browser's cookies and UA
  ua                         print the browser user agent
  batch <url...>             visit several URLs concurrently
  status                     daemon, browser and tab state
  hud [target-id]            force the floating HUD open
  close                      stop the browser and the daemon
  help                       this text

Environment:
  BROWSE_PROFILE       pinned Chrome profile (refuses to create a new one)
  BROWSE_PORT          DevTools port (default 9333)
  BROWSE_HUD_PORT      HUD bridge port (default 9336)
  BROWSE_BIN           browser executable (default: /Applications/Google Chrome.app)
  BROWSE_POS           window position (default -4000,-4000, i.e. offscreen)
  BROWSE_SIZE          window size (default 1440,960)
  BROWSE_HEADLESS=1    run --headless=new instead of an offscreen window
  BROWSE_GPU=0         add --disable-gpu (fallback for a crashing GPU process)
  BROWSE_MOCK_KEYCHAIN=1  add --use-mock-keychain (kills keychain prompts,
                          but cookies stored under the real keychain stop decrypting)
  BROWSE_HUD=0         never show the floating panel
  BROWSE_CONCURRENCY   parallel tabs for batch (default 4)

Exit codes: 0 ok, 10 captcha, 11 login, 12 blocked, 13 stuck, 14 error.
`

/**
 * Print a daemon reply and return its exit code.
 *
 * @param {any} reply - daemon reply.
 * @param {{ raw?: boolean }} [options] - when true, content is printed verbatim.
 * @returns {number} exit code.
 */
function emit(reply, { raw = false } = {}) {
  if (reply === undefined) { process.stderr.write('no reply from the daemon\n'); return EXIT.error }
  if (reply.ok === false) {
    const status = typeof reply.status === 'string' ? reply.status : STATUS.ERROR
    const detail = reply.reason ?? reply.error ?? 'failed'
    process.stderr.write(`${status}: ${detail}\n`)
    if (typeof reply.id === 'string') process.stderr.write(`tab: ${reply.id}\n`)
    return exitCodeFor(status)
  }
  if (raw && typeof reply.content === 'string') {
    process.stdout.write(reply.content.endsWith('\n') ? reply.content : `${reply.content}\n`)
    return EXIT.ok
  }
  process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`)
  // A successful reply can still carry a wall: `open` answers ok:true with
  // status CAPTCHA, and the exit code has to say so or a script would treat the
  // tab as readable content.
  if (typeof reply.status === 'string') return exitCodeFor(reply.status)
  if (Array.isArray(reply.results)) {
    const blocked = reply.results.find((entry) => entry?.status !== undefined && entry.status !== STATUS.OK)
    return blocked === undefined ? EXIT.ok : exitCodeFor(blocked.status)
  }
  return EXIT.ok
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Promise<number>} exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const cfg = readConfig()
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return EXIT.ok
  }
  if (command === '__daemon') {
    await runDaemon(cfg)
    return EXIT.ok
  }
  switch (command) {
    case 'status':
      return emit(await callDaemon(cfg, { op: 'status' }))
    case 'open': {
      const url = rest[0]
      if (url === undefined) { process.stderr.write('open needs a URL\n'); return EXIT.error }
      return emit(await callDaemon(cfg, { op: 'open', url }))
    }
    case 'show': {
      const url = rest[0]
      if (url === undefined) { process.stderr.write('show needs a URL\n'); return EXIT.error }
      return emit(await callDaemon(cfg, { op: 'show', url }))
    }
    case 'goto':
    case 'text':
      return emit(await callDaemon(cfg, { op: 'visit', url: String(rest[0] ?? ''), kind: 'text' }), { raw: true })
    case 'html':
      return emit(await callDaemon(cfg, { op: 'visit', url: String(rest[0] ?? ''), kind: 'html' }), { raw: true })
    case 'eval':
      return emit(await callDaemon(cfg, { op: 'eval', js: rest.join(' '), url: process.env.BROWSE_URL, id: process.env.BROWSE_TARGET }))
    case 'shot': {
      const [url, out] = rest
      if (url === undefined || out === undefined) { process.stderr.write('shot needs <url> <out.jpg>\n'); return EXIT.error }
      return emit(await callDaemon(cfg, { op: 'shot', url, out }))
    }
    case 'cookies':
      return emit(await callDaemon(cfg, { op: 'cookies', url: rest[0] }))
    case 'dl':
      return emit(await callDaemon(cfg, { op: 'download', url: String(rest[0] ?? ''), dest: String(rest[1] ?? '') }))
    case 'ua':
      return emit(await callDaemon(cfg, { op: 'ua' }))
    case 'batch': {
      const urls = collectUrls(rest)
      if (urls.length === 0) { process.stderr.write('batch needs at least one URL\n'); return EXIT.error }
      return emit(await callDaemon(cfg, { op: 'batch', urls, concurrency: cfg.concurrency }))
    }
    case 'hud':
      return emit(await callDaemon(cfg, { op: 'hud', id: rest[0] }))
    case 'close': {
      const reply = await callDaemon(cfg, { op: 'shutdown' }).catch(() => ({ ok: true }))
      process.stdout.write(`${JSON.stringify(reply)}\n`)
      return EXIT.ok
    }
    default:
      process.stderr.write(`unknown command: ${command}\n${HELP}`)
      return EXIT.error
  }
}

// Only run when invoked directly, so tests can import the pure helpers.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`)
    process.exit(EXIT.error)
  })
}
