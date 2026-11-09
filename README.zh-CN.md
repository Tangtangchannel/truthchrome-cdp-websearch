# dsh-chromium-websearch

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-base) 用的、真正开浏览器去搜、去抓的 `web_search` / `web_fetch` 后端。

[English](README.md) · 中文

装完就能用：本机没有 Chromium 时它会自己下一次 Chrome for Testing，之后一直复用。不需要装依赖，不会跑 postinstall，也不需要你手动装浏览器。

## 它解决什么

Harness 自带的搜索走 HTTP API，自带的抓取就是个 HTTP 客户端。两者会被同样的东西拦住：机器人校验、纯 JS 渲染的页面、登录拦页。这个插件改成驱动一个真实的有头 Chromium（CDP 协议），模型看到的就是人打开页面看到的内容。

它不改 host 的 `web_search` / `web_fetch` 工具和提示词，只注册两个 `ctx.web` provider 把 `web` 服务指过去；另有一个默认关闭的可选工具 `xhs_search`。

- `web_search` → 在真实标签页里打开 Bing / DuckDuckGo / 百度，从 DOM 里取结果链接，还原跳转地址，返回 `{ sources: [{ title, url, snippet }] }`。
- `web_download` → 用浏览器的 cookie、UA 和你给的 `Referer` 把文件（图片、视频、音频、PDF、zip）存到磁盘；字节不进入对话，返回路径、大小和 sha256。这是「按 tag 找图并留下原图」能成立的原因——`i.pximg.net` 没有 pixiv 的 Referer 会直接 403。
- `web_fetch` → 在真实标签页里打开目标页，等掉常见的机器人拦截页，去掉 script/style/svg/iframe，返回干净的 HTML 或纯文本。
- `xhs_search` → 在小红书的搜索页里读 DOM，返回笔记标题、链接（带 `xsec_token`，否则笔记打不开）、作者、点赞数和发布时间。它是独立工具而不是 `web_search` 的参数：`web_search` 的参数由 host 定义（只有 `queries`），插件加不了 `source`。默认关闭，在已登录的 profile 上打开 `xiaohongshu.enabled` 才有意义；未登录时工具会明确报登录墙。

## 安静版引擎（`browse/`）

插件的浏览器对模型不可见，但对桌面可见——它是一个真实的有头 Chromium。`browse/`
把同一套思路做成命令行工具，并且把窗口彻底从屏幕上拿掉：

- 常驻守护进程持有浏览器，第二次调用不再冷启动
- 标签页后台创建（`Target.createTarget` + `background: true`），各自独立 CDP session，
  一个站被拦住不会拖累其他站
- 每页判定 `OK` / `CAPTCHA` / `LOGIN` / `BLOCKED` / `STUCK`，同时就是退出码（0/10/11/12/13）
- 启动后用 **Accessibility 隐藏整个应用**：Chrome 会把 `--window-position` 夹回屏幕内，
  隐藏才是 macOS 真正认的做法，而隐藏状态下照样渲染，截图不受影响
- 真需要人时，弹一个不抢焦点的浮动面板：投递那一页的实时画面，把点击和输入转发进真标签，
  墙一消失自己退出
- 显式配置的 profile 不存在就报错——空 profile 会静默丢掉所有登录态；没有配置时首次运行会建一个默认 profile

```bash
sh browse/install.sh          # 编译两个 Swift 工具，装到 ~/.local/share/truthchrome
browse status
node browse/browse.mjs text https://example.com
node browse/browse.mjs batch https://a.test https://b.test https://c.test
node browse/browse.mjs close
```

命令表、环境变量、钥匙串说明和已知边界见 [browse/README.md](browse/README.md)。

## 安装

作为 profile bundle 安装：

```
plugin_manager install_bundle  target: dsh-chromium-websearch
```

本地开发时指向检出目录：

```
plugin_manager install_bundle  target: /absolute/path/to/dsh-chromium-websearch
```

需要 **Node 22 或更新**：DevTools 通道用的是全局 `WebSocket`，它在 Node 21 才默认可用。

不安装任何依赖：只 import `node:` 内置模块和自己的文件。

### 浏览器从哪来

优先**用**已有的浏览器，顺序是：`chromePath` → `DSH_BROWSER_CHROME` / `CHROME_PATH` → Playwright 的构建缓存 → 常见安装位置里的 Chrome for Testing / Chrome / Chromium / Edge / Brave。

都找不到时，自动下载 stable 版 Chrome for Testing 到 `~/.dsh/browser-web/chromium`，写一个 `current.json` 标记，之后直接用。首次需要联网，占约 200 MB 磁盘。想彻底离线，把 `autoProvision` 设为 `false`，自己准备浏览器。

## 三种模式

| 模式 | 干什么用 |
| --- | --- |
| `anonymous`（默认） | 一次性 profile，用完即弃。普通搜索/抓取用这个。 |
| `signed-in` | 常驻 profile，第一次会开登录窗口让你自己登；会话 cookie 会恢复。 |
| `personal` | 直接用一个已存在的 Chrome profile 目录（`personalProfileDir`），插件不写任何标记进去。 |

## 主要配置

全部可选，默认值够用。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `anonymous` | 见上表。 |
| `chromePath` | 自动探测 | 也读 `DSH_BROWSER_CHROME` / `CHROME_PATH`。 |
| `autoProvision` | `true` | 找不到浏览器时自动下载。 |
| `allowPrivateHosts` | `false` | `web_fetch` 默认拒绝回环与内网地址；`true` 全放开，写成 `['nas.lan']` 这样的列表则只放行列出的主机。 |
| `downloadDir` | `~/.dsh/browser-web/downloads` | `web_download` 的根目录，单次默认落在 `<YYYYMMDD>` 子目录。 |
| `downloadMaxBytes` | `52428800` | 单文件上限，流式写入时中途就会拒绝。 |
| `downloadMaxFiles` | `20` | 单次调用允许的 URL 数上限。 |
| `downloadTimeoutMs` | `60000` | 单个文件的超时。 |
| `downloadMinIntervalMs` | `1000` | 同一批文件之间的间隔。 |
| `xiaohongshu.enabled` | `false` | 注册 `xhs_search` 工具；只在已登录的 profile 上有意义。 |
| `xiaohongshu.maxResults` | `10` | 单次默认返回的笔记数（1-20）。 |
| `xiaohongshu.timeoutMs` | `30000` | 搜索预算，包含等卡片渲染的时间。 |
| `provisionDir` | `~/.dsh/browser-web/chromium` | 下载的浏览器放哪。 |
| `indexUrl` | 官方索引 | 换镜像或离线副本时用。 |
| `headless` | `false` | 无窗口运行；有些拦截页只有有头模式能过。 |
| `engines` | `bing`、`duckduckgo`、`baidu` | 优先顺序。 |
| `minResults` | `3` | 低于这个数就换下一个引擎，而不是拿现有结果直接回答。 |
| `maxResults` | `8` | 单次搜索上限。 |
| `fetchTimeoutMs` | `45000` | 抓取总预算。 |
| `bodyFormat` | `html` | `html` / `text` / `auto`。 |
| `journal` | `true` | 追加 JSONL 轨迹（不含查询词、URL、cookies）。 |

完整字段见[英文 README](README.md#configuration)。

## 排错

- `web_fetch` 拒绝了一个内网地址——目标解析到回环、内网或链路本地地址，而
  `allowPrivateHosts` 处于关闭状态。设为 `true` 全放开，或写成 `['nas.lan']`
  只放行你要的那几台。`signed-in` / `personal` 模式下要注意：这个请求带的是你的登录态。
- `BROWSER_NOT_FOUND`——本机没有浏览器，且自动下载失败（离线、代理、home 只读）。
  装一个 Chrome，或设 `chromePath`，或把 `provisionDir` 指到可写目录再试。

## 测试

```
npm test                     # 离线：单元 + 自动下载相关用例，不需要浏览器和网络
node scripts/accept.mjs      # 全量：静态检查 + 单元 + 引擎夹具 + 真实搜索抓取
```

`npm test` 是克隆下来直接能跑的命令，也是发布前的门禁。

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。

```
Copyright (C) 2026 大肥鱼 (DeepSeek), amecandy
```

## 作者

- 大肥鱼（DeepSeek）
- amecandy
