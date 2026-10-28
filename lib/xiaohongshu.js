import { WebBrowserError, CODE } from './errors.js'
import { PageSession } from './page.js'
import { collapse, sleep, throwIfAborted, truncate } from './util.js'

/** Origin every note link is resolved against. */
export const XHS_ORIGIN = 'https://www.xiaohongshu.com'

/** Paths a result card may link to: search hits, notes, and video notes. */
const NOTE_PATH = /^\/(?:search_result|explore|discovery\/item)\//u

const TITLE_LIMIT = 100
const AUTHOR_LIMIT = 40
const POLL_INTERVAL_MS = 500
const STABLE_POLLS = 2

/**
 * Runs inside the page. Returns the raw card text and the two walls that make a
 * search useless: a login prompt (the profile is not signed in) and a slider
 * captcha (the site decided this session looks automated).
 */
const EXTRACT = `(() => {
  const notes = []
  for (const card of document.querySelectorAll('section.note-item')) {
    const cover = card.querySelector('a.cover[href]')
    const titleNode = card.querySelector('a.title span')
    const authorNode = card.querySelector('a.author .name')
    const timeNode = card.querySelector('.time')
    const likeNode = card.querySelector('.like-wrapper .count')
    notes.push({
      noteId: card.getAttribute('data-note-id') || '',
      href: cover === null ? '' : cover.getAttribute('href') || '',
      title: titleNode === null ? '' : titleNode.textContent || '',
      author: authorNode === null ? '' : authorNode.textContent || '',
      time: timeNode === null ? '' : timeNode.textContent || '',
      likes: likeNode === null ? '' : likeNode.textContent || '',
    })
  }
  const text = document.body === null ? '' : document.body.innerText
  return {
    notes,
    loginWall: /登录后查看|请先登录|扫码登录/u.test(text),
    captcha: /安全验证|滑动验证/u.test(text),
  }
})()`

/**
 * Build the search-page URL for one keyword.
 *
 * @param {string} query - keyword text.
 * @returns {string} an absolute URL.
 */
export function searchUrl(query) {
  return `${XHS_ORIGIN}/search_result?keyword=${encodeURIComponent(query)}&source=web_explore_feed`
}

/**
 * Turn raw cards into the result shape the tool prints.
 *
 * Cards without a title still appear (some layouts omit it); they are labelled
 * by author so the list never shows a bare link. Duplicates are dropped by note
 * id, then by URL, and non-note links are refused.
 *
 * @param {Array<{ noteId?: string, href?: string, title?: string, author?: string, time?: string, likes?: string }>} cards - raw cards.
 * @param {number} maxResults - hard cap.
 * @returns {Array<{ title: string, url: string, author: string, likes: string, publishedAt: string, snippet: string }>} normalized notes.
 */
export function normalizeNotes(cards, maxResults) {
  const limit = Math.min(20, Math.max(1, Math.round(Number(maxResults) || 10)))
  const seen = new Set()
  const notes = []
  for (const card of Array.isArray(cards) ? cards : []) {
    const href = typeof card?.href === 'string' ? card.href : ''
    let url
    try {
      const parsed = new URL(href.startsWith('/') ? `${XHS_ORIGIN}${href}` : href)
      if (parsed.hostname !== 'www.xiaohongshu.com') continue
      if (!NOTE_PATH.test(parsed.pathname)) continue
      url = parsed.toString()
    } catch {
      continue
    }
    const noteId = typeof card?.noteId === 'string' ? card.noteId : ''
    const key = noteId !== '' ? noteId : url
    if (seen.has(key)) continue
    seen.add(key)

    const author = truncate(collapse(card?.author), AUTHOR_LIMIT)
    const likes = collapse(card?.likes)
    const publishedAt = collapse(card?.time)
    const title = truncate(collapse(card?.title) || `${author !== '' ? author : '小红书'}的笔记`, TITLE_LIMIT)
    const snippet = [
      author !== '' ? `作者 ${author}` : '',
      likes !== '' ? `点赞 ${likes}` : '',
      publishedAt !== '' ? `发布 ${publishedAt}` : '',
    ]
      .filter((part) => part !== '')
      .join(' · ')

    notes.push({ title, url, author, likes, publishedAt, snippet })
    if (notes.length >= limit) break
  }
  return notes
}

/**
 * Search xiaohongshu.com in a borrowed tab and read the result cards.
 *
 * The page renders its cards after the shell, so the extractor is polled until
 * the count stops growing. A login prompt or a captcha wall is reported as
 * itself instead of as "zero results".
 *
 * @param {{ openTab: (signal?: AbortSignal) => Promise<{ id: string, socketUrl: string }>, closeTab: (id: string) => Promise<void> }} host - browser host.
 * @param {{ navigateTimeoutMs: number, settleMs: number, xiaohongshu: { maxResults: number, timeoutMs: number } }} settings - normalized settings.
 * @param {string} query - keyword text.
 * @param {{ signal?: AbortSignal, maxResults?: number }} [options] - overrides.
 * @returns {Promise<{ query: string, url: string, notes: ReturnType<typeof normalizeNotes>, durationMs: number }>} hits.
 */
export async function searchNotes(host, settings, query, options = {}) {
  const text = typeof query === 'string' ? query.trim() : ''
  if (text === '') throw new WebBrowserError('xhs_search needs a non-empty query', CODE.PROVIDER_ERROR)
  const limit = Math.min(20, Math.max(1, Math.round(Number(options.maxResults ?? settings.xiaohongshu.maxResults) || 10)))
  const budgetMs = Math.max(5000, settings.xiaohongshu.timeoutMs)
  const started = Date.now()
  const signal = options.signal
  const url = searchUrl(text)

  const session = await PageSession.open(host, signal)
  try {
    throwIfAborted(signal)
    const nav = await session.navigate(url, { timeoutMs: Math.min(settings.navigateTimeoutMs, budgetMs) })
    if (Number.isFinite(nav?.status) && nav.status >= 400) {
      throw new WebBrowserError(`xiaohongshu answered HTTP ${nav.status}`, CODE.PROVIDER_ERROR)
    }
    await sleep(settings.settleMs, signal)

    const deadline = started + budgetMs
    let notes = []
    let previous = -1
    let stable = 0
    let wall = null
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const state = await session.evaluate(EXTRACT)
      if (state?.captcha === true) {
        throw new WebBrowserError(
          'xiaohongshu is showing a verification slider; open the browser window and clear it, then retry',
          CODE.PROVIDER_ERROR,
        )
      }
      wall = state?.loginWall === true ? 'login' : wall
      notes = normalizeNotes(state?.notes, limit)
      if (notes.length !== previous) {
        previous = notes.length
        stable = 0
      } else {
        stable += 1
      }
      if (notes.length >= limit) break
      if (notes.length > 0 && stable >= STABLE_POLLS) break
      await sleep(POLL_INTERVAL_MS, signal)
    }

    if (notes.length === 0) {
      if (wall === 'login') {
        throw new WebBrowserError(
          'xiaohongshu asks for a login: sign in once in the plugin window (mode signed-in), then retry',
          CODE.PROVIDER_ERROR,
        )
      }
      throw new WebBrowserError(
        `xiaohongshu returned no notes for "${truncate(text, 40)}"`,
        CODE.PROVIDER_ERROR,
      )
    }
    return { query: text, url, notes, durationMs: Date.now() - started }
  } finally {
    await session.close()
  }
}

/**
 * Render a search result as the text the tool returns.
 *
 * @param {{ query: string, url: string, notes: Array<{ title: string, url: string, snippet: string }>, durationMs: number }} result - search outcome.
 * @returns {string} one numbered block per note.
 */
export function renderNotes(result) {
  const lines = [`Xiaohongshu · "${result.query}" · ${result.notes.length} note(s) · ${result.durationMs} ms`, '']
  result.notes.forEach((note, index) => {
    lines.push(`${index + 1}. ${note.title}`)
    lines.push(`   ${note.url}`)
    if (note.snippet !== '') lines.push(`   ${note.snippet}`)
  })
  return lines.join('\n')
}

/**
 * Build the `xhs_search` tool.
 *
 * @param {{
 *   host: { openTab: (signal?: AbortSignal) => Promise<{ id: string, socketUrl: string }>, closeTab: (id: string) => Promise<void> },
 *   settings: any,
 *   journal: { record: (entry: any) => void },
 * }} deps - host, settings, and trace sink.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
export function createXiaohongshuTool(deps) {
  const { host, settings, journal } = deps
  return {
    name: 'xhs_search',
    description:
      'Search Xiaohongshu (小红书) notes by keyword in the plugin\'s own browser window and return each note\'s title, link, author, likes, and publish time. Use it when the answer depends on content that mainstream engines do not index: reviews, travel notes, recipes, and product write-ups that live only on xiaohongshu.com. It reads the signed-in profile, so a personal feed and full search results are available; it never uses an API key.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keyword or phrase to search on xiaohongshu.com' },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: `how many notes to return; defaults to ${settings.xiaohongshu.maxResults}`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
    },
    /**
     * @param {{ query?: string, maxResults?: number }} raw - tool arguments.
     * @param {{ signal?: AbortSignal }} [exec] - execution context.
     * @returns {Promise<string>} rendered hits.
     */
    execute: async (raw, exec = {}) => {
      const query = typeof raw?.query === 'string' ? raw.query.trim() : ''
      if (query === '') throw new WebBrowserError('xhs_search needs a query string', CODE.PROVIDER_ERROR)
      const started = Date.now()
      try {
        const result = await searchNotes(host, settings, query, {
          signal: exec.signal,
          maxResults: raw?.maxResults,
        })
        journal.record({ op: 'xhs', ok: true, count: result.notes.length, durationMs: result.durationMs, query })
        return renderNotes(result)
      } catch (error) {
        journal.record({
          op: 'xhs',
          ok: false,
          durationMs: Date.now() - started,
          query,
          code: error instanceof WebBrowserError ? error.code : 'XHS_ERROR',
        })
        throw error
      }
    },
  }
}
