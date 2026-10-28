import { normalizeSettings } from './lib/config.js'
import { BrowserHost } from './lib/chrome.js'
import { createDownloadTool } from './lib/download.js'
import { createJournal } from './lib/journal.js'
import { PageSession } from './lib/page.js'
import { createProviders } from './lib/providers.js'
import { createXiaohongshuTool } from './lib/xiaohongshu.js'

/** Cordis plugin name, shown in composition listings. */
export const name = 'web-browser'

/**
 * The `web` service must exist before `apply` runs, otherwise there is nothing
 * to register a provider with.
 */
export const inject = ['web', 'tools']

/**
 * Register a headful-browser search provider and fetch provider with `ctx.web`,
 * then pin them as the configured providers for this profile.
 *
 * Registration is effect-scoped: when this plugin's fiber is disposed (plugin
 * disabled or removed), both providers disappear and `ctx.web` falls back to
 * whatever the base composition provides.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} config - entry config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const journal = createJournal(settings)
  const host = new BrowserHost(settings)
  const providers = createProviders(host, settings, journal)
  const downloadTool = createDownloadTool({
    settings,
    journal,
    openSession: () => PageSession.open(host),
  })
  const xiaohongshuTool = settings.xiaohongshu.enabled
    ? createXiaohongshuTool({ host, settings, journal })
    : undefined

  ctx.effect(() => {
    const disposers = [
      ctx.web.registerSearchProvider(providers.search),
      ctx.web.registerFetchProvider(providers.fetch),
    ]
    if (typeof ctx.tools?.register === 'function') {
      for (const tool of [downloadTool, xiaohongshuTool]) {
        if (tool === undefined) continue
        const disposeTool = ctx.tools.register(tool)
        if (typeof disposeTool === 'function') disposers.push(disposeTool)
      }
    }
    return async () => {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          // The fiber may already have unregistered the provider.
        }
      }
      await host.dispose()
      journal.close()
    }
  })
}
