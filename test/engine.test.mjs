import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from './harness.mjs'
import { classifyChallenge, looksLikeChallenge } from '../lib/fetch.js'
import { hideWindow, shouldDisableSandbox } from '../lib/chrome.js'
import { normalizeSettings } from '../lib/config.js'
import { classify, collectUrls, exitCodeFor, jpegSize, readConfig, STATUS } from '../browse/browse.mjs'

// ── challenge classification (plugin) ────────────────────────────────────────

test('a cloudflare interstitial is reported as a challenge', () => {
  assert.equal(looksLikeChallenge('Just a moment... Checking your browser before accessing'), true)
  assert.equal(classifyChallenge('Just a moment... Checking your browser before accessing'), 'challenge')
})

test('a captcha wall is distinguished from a login wall', () => {
  assert.equal(classifyChallenge('Please verify you are human. 请完成人机验证'), 'captcha')
  assert.equal(classifyChallenge('Sign in to continue. 登录后查看'), 'login')
})

test('ordinary prose is not a challenge', () => {
  assert.equal(classifyChallenge('A long article about browsers and how they render pages.'), undefined)
})

// ── launch decisions (plugin) ────────────────────────────────────────────────

test('dedicated profiles use a mock keychain, the personal profile does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browse-keychain-'))
  mkdirSync(join(dir, 'Default'))
  try {
    assert.equal(normalizeSettings({ mode: 'anonymous' }).useMockKeychain, true)
    assert.equal(normalizeSettings({ mode: 'signed-in' }).useMockKeychain, true)
    assert.equal(normalizeSettings({ mode: 'personal', personalProfileDir: dir }).useMockKeychain, false)
    assert.equal(normalizeSettings({ mode: 'personal', personalProfileDir: dir, useMockKeychain: true }).useMockKeychain, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hiding is skipped when configured off or when running headless', () => {
  assert.equal(hideWindow({ hideWindow: false, headless: false, axPath: '/bin/false' }, 42), false)
  assert.equal(hideWindow({ hideWindow: true, headless: true, axPath: '/bin/true' }, 42), false)
  assert.equal(hideWindow({ hideWindow: true, headless: false, axPath: '/usr/bin/true' }, 42), true)
})

test('the sandbox stays on outside linux containers', () => {
  assert.equal(shouldDisableSandbox({ platform: 'darwin', uid: 501, isContainer: false }), false)
  assert.equal(shouldDisableSandbox({ platform: 'linux', uid: 0, isContainer: true }), true)
})

// ── page classification (browse.mjs) ─────────────────────────────────────────

test('turnstile marks the page as a captcha', () => {
  const verdict = classify({ title: 'Example', url: 'https://x.test/', text: 'content here that is long enough', ready: 'complete', marks: { turnstile: true } })
  assert.equal(verdict.status, STATUS.CAPTCHA)
  assert.equal(verdict.reason, 'turnstile')
})

test('a password field on a sign-in path is a login wall', () => {
  const verdict = classify({ title: 'Sign in', url: 'https://x.test/login', text: 'Sign in to continue', ready: 'complete', passwordFields: 1 })
  assert.equal(verdict.status, STATUS.LOGIN)
})

test('a normal page is ok', () => {
  const verdict = classify({ title: 'Doc', url: 'https://x.test/a', text: 'x'.repeat(200), ready: 'complete', passwordFields: 0 })
  assert.equal(verdict.status, STATUS.OK)
})

test('an incomplete empty document is stuck, not ok', () => {
  const verdict = classify({ title: '', url: 'https://x.test/', text: '', ready: 'loading' })
  assert.equal(verdict.status, STATUS.STUCK)
})

test('status maps onto a stable exit code', () => {
  assert.equal(exitCodeFor(STATUS.OK), 0)
  assert.equal(exitCodeFor(STATUS.CAPTCHA), 10)
  assert.equal(exitCodeFor(STATUS.LOGIN), 11)
  assert.equal(exitCodeFor(STATUS.STUCK), 13)
  assert.equal(exitCodeFor('nonsense'), 14)
})

test('urls are collected and de-duplicated from free text', () => {
  const urls = collectUrls(['see https://a.test/x and https://b.test/y', 'https://a.test/x'])
  assert.deepEqual(urls, ['https://a.test/x', 'https://b.test/y'])
})

test('configuration defaults are quiet and pinned', () => {
  const cfg = readConfig({})
  assert.equal(cfg.position, '-4000,-4000')
  assert.equal(cfg.hud, true)
  assert.equal(cfg.headless, false)
  assert.equal(cfg.noSandbox, false)
  assert.match(cfg.profile, /\.browse-profile$/u)
})

test('environment overrides are honoured', () => {
  const cfg = readConfig({ BROWSE_PROFILE: '/tmp/p', BROWSE_HEADLESS: '1', BROWSE_HUD: '0', BROWSE_CONCURRENCY: '9' })
  assert.equal(cfg.profile, '/tmp/p')
  assert.equal(cfg.headless, true)
  assert.equal(cfg.hud, false)
  assert.equal(cfg.concurrency, 9)
})

test('jpeg dimensions are read from the SOF segment', () => {
  // Minimal JPEG header: SOI, DQT-free APP0, SOF0 (0x11 x 0x22), then padding.
  const header = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x22, 0x00, 0x11, 0x03,
  ])
  assert.deepEqual(jpegSize(header), { height: 0x22, width: 0x11 })
  assert.equal(jpegSize(Buffer.from([1, 2, 3])), undefined)
})
