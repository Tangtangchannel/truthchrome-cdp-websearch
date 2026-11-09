# browse —— 安静的后台浏览器引擎

给 Codex / DSH 用的 CDP 驱动。只解决三个具体问题：

1. **不弹窗**：浏览器窗口全程不出现在屏幕上，也不抢焦点。
2. **不卡死**：多个站点并行抓取，一个站被验证码拦住不影响其他站。
3. **该叫人时立刻叫人**：碰到人机验证 / 登录墙，弹一个浮动小面板，把页面投过去，你点完它自己消失。

---

## 快速开始

```bash
node browse.mjs status                 # 守护进程 / 浏览器 / 标签页状态
node browse.mjs text https://a.test    # 抓正文
node browse.mjs html https://a.test    # 抓 HTML
node browse.mjs open https://a.test    # 开一个后台标签，返回 id + 状态（不关）
node browse.mjs show https://a.test    # 同上，但把真窗口放出来（登录用）
node browse.mjs batch url1 url2 url3   # 并发抓多个站
node browse.mjs eval 'document.title'  # 一次性求值（BROWSE_URL 可先导航）
node browse.mjs shot https://a.test out.jpg
node browse.mjs cookies https://a.test
node browse.mjs dl https://a.test/a.png ./a.png   # 带 cookie / UA / Referer 下载
node browse.mjs close                  # 关浏览器和守护进程
```

所有命令背后是一个常驻守护进程（unix socket），第二次调用不会再冷启动。

## 状态与退出码

`open` / `batch` 会返回页面状态，同时**退出码就是结论**，脚本里不用解析 JSON：

| 状态 | 退出码 | 含义 |
|---|---|---|
| `OK` | 0 | 正常内容 |
| `CAPTCHA` | 10 | 人机验证（Turnstile / reCAPTCHA / hCaptcha / DataDome / AWS WAF / 滑块） |
| `LOGIN` | 11 | 登录墙（可见密码框 + 登录语义） |
| `BLOCKED` | 12 | 403 / 429 一类直接拒绝 |
| `STUCK` | 13 | 页面停在加载中或空白 |
| `ERROR` | 14 | 传输 / 协议错误 |

判定分两层：脚本内置确定性规则（选择器 + 标题 + 可见密码框 + 页面稳定性），**不烧 token**；只有规则说不清时才由模型看一张截图。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BROWSE_PROFILE` | `~/.local/state/truthchrome/profile` | Chrome profile。显式指定的目录不存在就报错，绝不新建；首次使用默认目录时会自动建一个空的 |
| `BROWSE_BIN` | 自动探测（macOS 的 Google Chrome / Chromium / Edge / Brave，Linux 的 google-chrome / chromium，Windows 的 chrome.exe） | 浏览器二进制 |
| `BROWSE_PORT` | `9333` | DevTools 端口 |
| `BROWSE_HUD_PORT` | `9336` | 浮层桥接端口 |
| `BROWSE_POS` | `-4000,-4000` | 窗口坐标（只是提示，见下文） |
| `BROWSE_SIZE` | `1440,960` | 窗口尺寸 |
| `BROWSE_HEADLESS` | `0` | `1` 用 `--headless=new`，彻底无窗口但指纹变弱 |
| `BROWSE_GPU` | `1` | `0` 加 `--disable-gpu`（GPU 进程崩了时的兜底） |
| `BROWSE_MOCK_KEYCHAIN` | 读 `config.json` | `1` 加 `--use-mock-keychain`，零钥匙串弹窗。实测：新的 cookie 跨重启保留，但用真钥匙串加密的旧 cookie 解不开，需要重登一次 |
| `BROWSE_HUD` | `1` | `0` 永不弹浮层，只返回状态码 |
| `BROWSE_CONCURRENCY` | `4` | `batch` 的并行标签数 |
| `BROWSE_STATE` | `~/.local/state/truthchrome`（尊重 `XDG_STATE_HOME`） | socket / pid / 日志 / `config.json` |

## 登录一次

引擎默认把窗口藏起来，所以「自己登录一次」需要显式放出来：

```bash
node bin/browse.mjs show https://pixiv.net
# 窗口出现在前台，正常登录；登录完
node bin/browse.mjs close      # 会先让 Chrome flush，cookie 不会丢
```

下次 `text` / `batch` 直接带这份登录态，窗口还是藏着的。

## 安装

```bash
git clone https://github.com/Tangtangchannel/truthchrome-cdp-websearch.git
cd truthchrome-cdp-websearch
sh browse/install.sh                 # 编译 Swift 工具 + 安装到 ~/.local/share/truthchrome
# 可选：
#   DSH_WORKSPACE=/path/to/workspace  同时装进 <workspace>/bin
#   BROWSE_PREFIX=/usr/local/opt/truthchrome
```

只依赖系统自带的 `node`（≥22，需要全局 `WebSocket`）和 `xcrun swiftc`。没有 npm 依赖。

首次运行会在默认目录建一个空 profile；要带登录态就在 `config.json` 里指定一个已登录的 profile 目录。

## 本机配置 `config.json`

`~/.local/state/truthchrome/config.json` 存这台机器的偏好，优先级 **环境变量 > config.json > 内置默认**：

```json
{
  "mockKeychain": true,
  "concurrency": 4,
  "position": "-4000,-4000"
}
```

之所以有这个文件：像「这台机器接受 mock keychain」这种决定，不该靠每次 export 到 shell、launchd 任务和每个 agent 会话里。

## 为什么是「隐藏」而不是「挪到屏幕外」

`--window-position=-4000,-4000` 会被 Chrome 夹回可见区（实测落在 `0,30`），
因为 Chrome 自己会把保存的窗口位置夹进屏幕范围。真正有效的是让 macOS **隐藏整个应用**：

- 走 Accessibility 的 `kAXHiddenAttribute`（`hud/browse-ax hide <pid>`）
- 隐藏后 Chrome 仍然合成画面，`Page.captureScreenshot` 正常出图、页面定时器不被冻结
- 配合 `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、
  `--disable-features=CalculateNativeWinOcclusion`，后台标签页不会被降频

`NSRunningApplication.hide()` 对别的应用返回 `false`，所以只能走 AX。

## 关闭时先让 Chrome 自己退

Chrome 把 cookie 攒在内存里，大约 30 秒才落盘一次。直接 SIGTERM 会把刚登录的会话丢掉，
所以 `close` 先发 CDP 的 `Browser.close`（让 Chrome 自己 flush），最多等 3 秒才升级到信号。
实测：设置 cookie 后立刻 `close`，重启后 cookie 仍在。

## 并发模型

- 每个站点一个**独立 target**，`Target.createTarget { background: true }` 创建，**不激活**
- 每个 target 一条独立 CDP session，互不干扰
- 并发上限默认 4（Intel 16" 上 3–5 比较稳，单个标签 200–400 MB）
- `batch` 里某个站撞上验证码时，**那个标签留着**等人处理，其他标签继续跑

## HUD（人机验证面板）

`hud/browse-hud` 是一个 `NSPanel`：`.nonactivatingPanel` + `.floating` + `.canJoinAllSpaces`，
所以在当前桌面角落出现、**不切你的 Space、不抢键盘焦点**。

- 4 fps 轮询 `/hud/frame` 把页面投上去（JPEG，本地）
- 你在面板里点一下 → `Input.dispatchMouseEvent`（CDP 派发的事件 `isTrusted: true`），
  并带 6 步缓动鼠标轨迹，避免「瞬移点击」这种机器人特征
- 可以在面板里输入文本（验证码 / 账号），走 `Input.insertText`
- 「我自己点」才把真窗口放出来（`browse-ax show` + `Browser.setWindowBounds` + 激活）
- 验证通过后引擎每 1.5s 复查一次，状态变 `OK` 就撤掉面板

## 密钥环弹窗

Chrome 把 cookie 的加密密钥存在登录钥匙串的 `Chrome Safe Storage` 里，ACL 绑定二进制签名：

- 换二进制（Chrome for Testing ↔ 正式版）→ 每次都问
- `ensure()` 反复重启 → 每次重启都问，于是「疯狂弹窗」

对策按顺序：

1. **单实例**：一个 profile 只允许一个守护进程持有，绝不并发 spawn（这一条就砍掉绝大部分弹窗）
2. **固定二进制路径**：默认用 `/Applications/Google Chrome.app`，签名稳定，第一次点「始终允许」之后不再问
3. 需要绝对干净时用 `mockKeychain: true`（本机已开）。实测结论：
   - 新的 cookie **跨重启保留**（Chrome 的 mock key 存在 profile 的 `Local State` 里，不是每次随机）
   - 用真钥匙串加密的旧 cookie 解不开 → **需要重登一次**
   - 之后再也不会有钥匙串弹窗

## 目录

```
browse/
  browse.mjs          CLI + 守护进程 + CDP + 引擎 + HUD 桥（单文件，方便分发）
  hud/browse-ax.swift 隐藏 / 显示浏览器应用
  hud/browse-hud.swift 浮动面板
  hud/build.sh        重新编译两个 Swift 工具
  install.sh          编译并同步到 DSH 工作区和 Codex
```

## 自检

```bash
sh browse/smoke.sh      # 隐藏浏览器 + 单站抓取 + 三站并发 + 验证码退出码
npm test                # 89 个离线用例（含状态判定与配置解析）
```

## 已知边界

- 自动过验证码**不做**。能做的是把画面递到你面前，让你点一下，然后自动继续。
- 隐藏窗口时页面仍在渲染，但如果站点依赖 `document.visibilityState === 'visible'`，
  引擎已用 `Emulation.setFocusEmulationEnabled` 让它以为自己是前台。
- `--headless=new` 下 WebGL 走软件渲染，指纹和真机不同，硬反爬站会更容易拦。
