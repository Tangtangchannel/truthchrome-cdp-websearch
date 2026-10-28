import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from './harness.mjs'
import { DEFAULTS, normalizeSettings, resolveChrome, chromeCandidates, missingBrowserHint, PROVIDER_ID } from '../lib/config.js'
import { unwrapRedirect, normalizeResults, engineUrl, ENGINE_NAMES } from '../lib/search.js'
import { normalizeNotes, searchUrl, renderNotes } from '../lib/xiaohongshu.js'
import { looksLikeChallenge } from '../lib/fetch.js'
import { shouldDisableSandbox } from '../lib/chrome.js'
import { normalizeUrl, createProviders } from '../lib/providers.js'
import { assertFetchableUrl, isPrivateHost } from '../lib/net-guard.js'
import { createJournal, hash } from '../lib/journal.js'
import { collapse, truncate, sleep } from '../lib/util.js'
import { WebBrowserError, CODE } from '../lib/errors.js'

const bingWrap = (url) => `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(url, 'utf8').toString('base64url')}&ntb=1`

test('provider id is the documented browser id', () => {
  assert.equal(PROVIDER_ID, 'browser')
})

test('duckduckgo redirect wrapper is unwrapped', () => {
  const target = 'https://example.com/article?a=1&b=2'
  const wrapped = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=xyz`
  assert.equal(unwrapRedirect(wrapped), target)
})

test('bing ck/a wrapper is unwrapped', () => {
  const target = 'https://example.org/deep/path?x=1'
  assert.equal(unwrapRedirect(bingWrap(target)), target)
})

test('google url wrapper is unwrapped', () => {
  assert.equal(unwrapRedirect('https://www.google.com/url?q=https%3A%2F%2Fexample.net%2Fp&sa=U'), 'https://example.net/p')
})

test('protocol-relative href becomes https', () => {
  assert.equal(unwrapRedirect('//example.com/path'), 'https://example.com/path')
})

test('non-http schemes and relative hrefs are rejected', () => {
  assert.equal(unwrapRedirect('javascript:alert(1)'), undefined)
  assert.equal(unwrapRedirect('data:text/html,hi'), undefined)
  assert.equal(unwrapRedirect('/search?q=x'), undefined)
  assert.equal(unwrapRedirect(''), undefined)
  assert.equal(unwrapRedirect(undefined), undefined)
})

test('results are deduplicated and validated', () => {
  const results = normalizeResults(
    [
      { title: '  First  result ', href: 'https://example.com/a', snippet: 'line one\nline two' },
      { title: 'duplicate', href: 'https://example.com/a', snippet: 'dup' },
      { title: 'bad', href: 'javascript:alert(1)' },
      { title: '', href: 'https://fallback.example/b', snippet: '' },
      { title: 'third', href: 'https://example.com/c' },
    ],
    8,
  )
  assert.equal(results.length, 3)
  assert.deepEqual(results[0], { title: 'First result', url: 'https://example.com/a', snippet: 'line one line two' })
  assert.equal(results[1].title, 'fallback.example')
  assert.equal(results[2].snippet, undefined)
})

test('result count is capped and text is clipped', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    title: `t${index}`,
    href: `https://example.com/${index}`,
    snippet: 'x'.repeat(1000),
  }))
  const results = normalizeResults(candidates, 5)
  assert.equal(results.length, 5)
  assert.ok(results[0].snippet.length <= 400)
  assert.ok(results[0].snippet.endsWith('…'))
})

test('engine urls are absolute and encode the query', () => {
  const settings = normalizeSettings({})
  for (const name of ENGINE_NAMES) {
    const url = engineUrl(name, '爱斯妥 凝胶', settings)
    assert.match(url, /^https:\/\//u)
    assert.ok(!url.includes(' '), `${name} url must be encoded`)
  }
  assert.throws(() => engineUrl('nope', 'x', settings), /unknown search engine/u)
})

test('settings fall back to defaults and ignore unknown keys', () => {
  const settings = normalizeSettings({ somethingNew: true, port: '99999', bodyFormat: 'HTML' })
  assert.equal(settings.port, 65535)
  assert.equal(settings.bodyFormat, 'html')
  assert.deepEqual(settings.engines, ['bing', 'duckduckgo', 'baidu'])
  assert.equal(settings.headless, false)
})

test('settings reject unknown engines and body formats', () => {
  assert.throws(() => normalizeSettings({ engines: ['altavista'] }), /no supported engine/u)
  assert.throws(() => normalizeSettings({ bodyFormat: 'markdown' }), /bodyFormat/u)
  assert.throws(() => normalizeSettings({ port: 'abc' }), /finite number/u)
})

test('duplicate engines collapse in order', () => {
  assert.deepEqual(normalizeSettings({ engines: ['duckduckgo', 'bing', 'duckduckgo'] }).engines, ['duckduckgo', 'bing'])
})

test('chrome path can come from the environment', () => {
  const previous = process.env.DSH_BROWSER_CHROME
  process.env.DSH_BROWSER_CHROME = '/tmp/fake-chrome'
  try {
    assert.equal(normalizeSettings({}).chromePath, '/tmp/fake-chrome')
    assert.equal(normalizeSettings({ chromePath: '/opt/chrome' }).chromePath, '/opt/chrome')
  } finally {
    if (previous === undefined) delete process.env.DSH_BROWSER_CHROME
    else process.env.DSH_BROWSER_CHROME = previous
  }
})

test('missing chrome is reported with actionable guidance', () => {
  const settings = normalizeSettings({ chromePath: '/definitely/not/here/chrome' })
  assert.equal(resolveChrome(settings), undefined)
  const hint = missingBrowserHint(settings)
  assert.match(hint, /chromePath/u)
  assert.match(hint, /DSH_BROWSER_CHROME/u)
  assert.ok(hint.includes('/definitely/not/here/chrome'))
  assert.equal(missingBrowserHint(normalizeSettings({})).includes('Tried:') || chromeCandidates().length === 0, true)
})

test('challenge detection distinguishes walls from real pages', () => {
  assert.equal(looksLikeChallenge('Just a moment...'), true)
  assert.equal(looksLikeChallenge('Checking your browser before accessing'), true)
  assert.equal(looksLikeChallenge('请稍候，正在验证'), true)
  assert.equal(looksLikeChallenge('This article explains how to detect a challenge page in a browser.'), false)
})

test('url normalization accepts only absolute http(s)', () => {
  assert.equal(normalizeUrl('https://example.com/a#b'), 'https://example.com/a#b')
  assert.equal(normalizeUrl('  http://example.com  '), 'http://example.com/')
  assert.equal(normalizeUrl('file:///etc/hosts'), undefined)
  assert.equal(normalizeUrl('example.com'), undefined)
  assert.equal(normalizeUrl(42), undefined)
})

test('collapse and truncate keep output tidy', () => {
  assert.equal(collapse('  a \n\t b  '), 'a b')
  assert.equal(truncate('abcdef', 10), 'abcdef')
  assert.equal(truncate('abcdef', 3), 'ab…')
  assert.equal(truncate('😀😀😀', 2), '😀…')
  assert.equal(truncate('😀', 1), '😀')
})

test('journal records a query hash but never the query text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-web-browser-'))
  try {
    const journal = createJournal({ journal: true, journalPath: join(directory, 'events.jsonl') })
    journal.record({ op: 'search', ok: true, count: 3, durationMs: 12, query: 'secret query' })
    journal.record({ op: 'fetch', ok: false, durationMs: 3, host: 'example.com', code: 'CDP_TIMEOUT' })
    const lines = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(!lines[0].includes('secret query'))
    assert.equal(JSON.parse(lines[0]).queryHash, hash('secret query'))
    assert.equal(JSON.parse(lines[1]).host, 'example.com')
    assert.equal(JSON.parse(lines[1]).ok, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('journal is silent when disabled', () => {
  const journal = createJournal({ journal: false, journalPath: '/nonexistent/never' })
  journal.record({ op: 'search', ok: true, durationMs: 1, query: 'x' })
  assert.equal(journal.path, undefined)
})

test('disabled journal on a read-only path never throws', () => {
  const journal = createJournal({ journal: true, journalPath: '/proc/definitely/not/writable/events.jsonl' })
  assert.doesNotThrow(() => journal.record({ op: 'search', ok: true, durationMs: 1, query: 'x' }))
})

test('abort signalling surfaces a stable code', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(sleep(5000, controller.signal), (error) => error instanceof WebBrowserError && error.code === CODE.ABORTED)
})

test('errors carry a routable code and a cause chain', () => {
  const cause = new Error('inner')
  const error = new WebBrowserError('outer', CODE.CDP_ERROR, { cause })
  assert.equal(error.name, 'WebBrowserError')
  assert.equal(error.code, CODE.CDP_ERROR)
  assert.equal(error.cause, cause)
  assert.ok(error instanceof Error)
})

test('fetch targets on loopback and private ranges are refused', () => {
  const refused = [
    'http://127.0.0.1:8080/',
    'http://localhost/',
    'http://app.localhost/',
    'http://10.0.0.99/',
    'http://172.16.4.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:192.168.0.9]/',
  ]
  for (const url of refused) {
    assert.throws(
      () => assertFetchableUrl(url, { allowPrivateHosts: false }),
      (error) => error instanceof WebBrowserError
        && error.code === CODE.PROVIDER_ERROR
        && /private or loopback address/u.test(error.message)
        && /allowPrivateHosts/u.test(error.message),
      url,
    )
  }
})

test('public addresses pass the fetch guard', () => {
  for (const url of ['https://example.com/', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'http://172.32.0.1/']) {
    assert.doesNotThrow(() => assertFetchableUrl(url, { allowPrivateHosts: false }), url)
  }
})

test('allowPrivateHosts opens private ranges, or only the hosts it lists', () => {
  assert.doesNotThrow(() => assertFetchableUrl('http://192.168.1.1/', { allowPrivateHosts: true }))
  assert.doesNotThrow(() => assertFetchableUrl('http://nas.lan/', { allowPrivateHosts: ['nas.lan'] }))
  assert.throws(
    () => assertFetchableUrl('http://192.168.1.1/', { allowPrivateHosts: ['nas.lan'] }),
    (error) => error instanceof WebBrowserError && error.code === CODE.PROVIDER_ERROR,
  )
})

test('isPrivateHost classifies hosts without a URL', () => {
  assert.equal(isPrivateHost('localhost'), true)
  assert.equal(isPrivateHost('LOCALHOST.'), true)
  assert.equal(isPrivateHost('[::1]'), true)
  assert.equal(isPrivateHost('192.168.0.1'), true)
  assert.equal(isPrivateHost('example.com'), false)
  assert.equal(isPrivateHost('1.1.1.1'), false)
})

test('allowPrivateHosts defaults to off and rejects malformed values', () => {
  assert.equal(normalizeSettings({}).allowPrivateHosts, false)
  assert.throws(() => normalizeSettings({ allowPrivateHosts: 'yes' }), /allowPrivateHosts/u)
  assert.deepEqual(normalizeSettings({ allowPrivateHosts: ['nas.lan', 'NAS.lan'] }).allowPrivateHosts, ['nas.lan'])
  assert.throws(() => normalizeSettings({ allowPrivateHosts: [] }), /allowPrivateHosts/u)
  assert.throws(() => normalizeSettings({ allowPrivateHosts: ['  '] }), /allowPrivateHosts/u)
})

test('fetch provider refuses a private URL before the browser is touched', async () => {
  const records = []
  const host = { ensureBrowser: () => assert.fail('the browser must not start for a refused URL') }
  const providers = createProviders(host, normalizeSettings({}), { record: (entry) => records.push(entry) })
  await assert.rejects(
    () => providers.fetch.fetch({ url: 'http://192.168.1.1/admin' }),
    (error) => error instanceof WebBrowserError && error.code === CODE.PROVIDER_ERROR,
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].op, 'fetch')
  assert.equal(records[0].ok, false)
  assert.equal(records[0].code, CODE.PROVIDER_ERROR)
  assert.equal(records[0].host, '192.168.1.1')
})

test('the sandbox is only disabled where the launch cannot work otherwise', () => {
  // Container and root are the two cases where Chrome cannot start with the
  // sandbox on: no user namespace, or privileges it drops itself.
  assert.equal(shouldDisableSandbox({ platform: 'linux', uid: 0, isContainer: false }), true)
  assert.equal(shouldDisableSandbox({ platform: 'linux', uid: 1000, isContainer: true }), true)
  assert.equal(shouldDisableSandbox({ platform: 'linux', uid: 0, isContainer: true }), true)
  // A normal Linux user keeps the sandbox.
  assert.equal(shouldDisableSandbox({ platform: 'linux', uid: 1000, isContainer: false }), false)
  // macOS and Windows have no equivalent container story and never need the flag.
  assert.equal(shouldDisableSandbox({ platform: 'darwin', uid: 0, isContainer: false }), false)
  assert.equal(shouldDisableSandbox({ platform: 'win32', uid: 0, isContainer: true }), false)
  // A platform without getuid (Windows) must not accidentally match root.
  assert.equal(shouldDisableSandbox({ platform: 'linux', uid: undefined, isContainer: false }), false)
})

test('a search needs three results before it answers with them', () => {
  // One or two hits from an engine that half-blocked the query read as an
  // answer; asking for more makes the fallback actually run.
  assert.equal(DEFAULTS.minResults, 3)
  assert.equal(normalizeSettings({}).minResults, 3)
  // Still overridable, and still clamped to the documented range.
  assert.equal(normalizeSettings({ minResults: 5 }).minResults, 5)
  assert.equal(normalizeSettings({ minResults: 0 }).minResults, 1)
})

test('the trace records the engine and hashes the query', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-browser-journal-'))
  const journalPath = join(root, 'events.jsonl')
  try {
    const journal = createJournal(normalizeSettings({ journal: true, journalPath }))
    journal.record({ op: 'search', ok: true, engine: 'duckduckgo', count: 4, durationMs: 1234, query: 'secret phrase' })
    journal.record({ op: 'fetch', ok: false, durationMs: 12, host: 'example.com', code: 'WEB_PROVIDER_ERROR' })
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const [search, fetch] = lines
    assert.equal(search.engine, 'duckduckgo')
    assert.equal(search.count, 4)
    assert.equal(search.queryHash, hash('secret phrase'))
    assert.equal(search.queryHash.length, 16)
    assert.equal(fetch.engine, undefined, 'a fetch has no engine field')
    assert.equal(fetch.host, 'example.com')
    assert.ok(!readFileSync(journalPath, 'utf8').includes('secret phrase'), 'the query text is never written')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('xiaohongshu settings are opt-in and clamped', () => {
  assert.equal(normalizeSettings({}).xiaohongshu.enabled, false, 'the tool is off unless asked for')
  assert.equal(normalizeSettings({}).xiaohongshu.maxResults, 10)
  const on = normalizeSettings({ xiaohongshu: { enabled: true, maxResults: 999 } })
  assert.equal(on.xiaohongshu.enabled, true)
  assert.equal(on.xiaohongshu.maxResults, 20)
  const low = normalizeSettings({ xiaohongshu: { maxResults: 0 } })
  assert.equal(low.xiaohongshu.maxResults, 1)
})

test('xiaohongshu search url encodes the keyword', () => {
  const url = new URL(searchUrl('咖啡 探店'))
  assert.equal(url.origin, 'https://www.xiaohongshu.com')
  assert.equal(url.pathname, '/search_result')
  assert.equal(url.searchParams.get('keyword'), '咖啡 探店')
  assert.equal(url.searchParams.get('source'), 'web_explore_feed')
})

test('xiaohongshu cards become absolute, deduplicated notes', () => {
  const suffix = '?xsec_token=ABC&xsec_source=pc_search'
  const notes = normalizeNotes(
    [
      { noteId: 'a1', href: `/search_result/a1${suffix}`, title: '  巴黎  \n 时装周 ', author: '某人', time: '10-28', likes: '1.2万' },
      { noteId: 'a1', href: `/search_result/a1${suffix}`, title: '重复', author: '某人' },
      { noteId: 'b2', href: 'https://www.xiaohongshu.com/explore/b2', title: '', author: '阿兰', time: '编辑于 10-20' },
      { noteId: '', href: '/user/profile/xyz', title: '不是笔记' },
      { noteId: '', href: 'https://evil.example/search_result/c3', title: '外部' },
      { noteId: '', href: '/search_result/c4', title: '第三条' },
    ],
    10,
  )
  assert.equal(notes.length, 3)
  assert.equal(notes[0].title, '巴黎 时装周')
  assert.equal(notes[0].snippet, '作者 某人 · 点赞 1.2万 · 发布 10-28')
  assert.equal(notes[0].url, `https://www.xiaohongshu.com/search_result/a1${suffix}`)
  assert.equal(notes[1].title, '阿兰的笔记', 'a card without a title falls back to its author')
  assert.equal(notes[2].url, 'https://www.xiaohongshu.com/search_result/c4', 'a note without an id is deduplicated by url')
})

test('xiaohongshu results respect the requested cap', () => {
  const cards = Array.from({ length: 12 }, (_, index) => ({ noteId: `n${index}`, href: `/search_result/n${index}`, title: `笔记 ${index}` }))
  assert.equal(normalizeNotes(cards, 3).length, 3)
  const rendered = renderNotes({ query: '咖啡', url: searchUrl('咖啡'), notes: normalizeNotes(cards, 1), durationMs: 42 })
  assert.match(rendered, /"咖啡" · 1 note\(s\) · 42 ms/u)
  assert.match(rendered, /1\. 笔记 0/u)
  assert.match(rendered, /https:\/\/www\.xiaohongshu\.com\/search_result\/n0/u)
})

test('apply registers xhs_search only when enabled', async () => {
  const { apply } = await import('../index.js')
  const run = (config) => {
    const names = []
    const ctx = {
      web: { registerSearchProvider: () => () => {}, registerFetchProvider: () => () => {} },
      tools: { register: (tool) => { names.push(tool.name); return () => {} } },
      effect: (body) => { body() },
    }
    apply(ctx, config)
    return names
  }
  assert.deepEqual(run({ mode: 'anonymous', journal: false }), ['web_download'])
  const enabled = run({ mode: 'anonymous', journal: false, xiaohongshu: { enabled: true } })
  assert.deepEqual(enabled, ['web_download', 'xhs_search'])
})
