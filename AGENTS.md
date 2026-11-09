# AGENTS.md —— 给接手这个仓库的 agent

## 这个仓库有两个交付物

| 目录 | 是什么 | 谁在用 |
|---|---|---|
| `lib/`, `index.js` | DSH 插件 `truthchrome-cdp-websearch`：注册 `web_search` / `web_fetch` / `web_download` / `xhs_search` | DeepSeek Harness 运行时 |
| `browse/` | 独立命令行引擎：常驻守护进程 + 并发标签池 + 页面状态判定 + 人机验证浮层 | Codex / 命令行 / 任何 shell 脚本 |

两者共享同一套 CDP 思路，但**不共享代码**。改 `lib/` 不会影响 `browse/`，反之亦然；
别为了"统一"去重构其中一边，插件那边的错误码、mode 语义和 trace 格式是对外契约。

## 硬性规则

1. **绝不自动创建 profile。** 插件与 `browse/` 都只接受已存在的 Chrome profile 目录；
   空 profile 会静默丢登录态，比报错更糟。
2. **绝不改动用户的 profile 内容**（cookies / Login Data / Preferences）。
3. **不引入运行时依赖。** 全部只用 Node 内置模块 + 全局 `WebSocket`。插件要能装进
   DSH 运行时，`browse/` 要能单文件拷走。
4. **不动浏览器安全边界**：`--no-sandbox` 只在 Linux 容器 / root 下加（`shouldDisableSandbox`）；
   `personal` 模式保持真钥匙串，别给它开 `--use-mock-keychain`。
5. **文档要跟着行为改**：改命令、环境变量、退出码，同步 `browse/README.md`、`README.md`、
   `README.zh-CN.md`、`CHANGELOG.md`。

## 修改前先看现状

```bash
npm test                      # 89 个离线用例，不需要浏览器和网络
node browse/browse.mjs status # 守护进程 / 浏览器 / 标签页
```

改了 `browse/hud/*.swift` 必须重新编译：

```bash
sh browse/hud/build.sh        # 产出 browse-ax 与 browse-hud
sh browse/install.sh          # 编译并同步到 DSH 工作区 + Codex
```

守护进程会把旧代码留在内存里，改完 `browse.mjs` 要 `node browse/browse.mjs close` 再继续。

## 关键实现事实（踩过的坑，别再试一遍）

- `--window-position=-4000,-4000` **不管用**：Chrome 会把窗口夹回可见区（实测落在 `0,30`）。
  真正有效的是 Accessibility 隐藏应用（`browse-ax hide <pid>`）；`NSRunningApplication.hide()`
  对别人的应用返回 `false`。
- 隐藏状态下 Chrome 照样合成画面，`Page.captureScreenshot` 正常；但必须同时带
  `--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`、
  `--disable-background-timer-throttling`，否则页面定时器被降频。
- 前台创建标签（`PUT /json/new`）会把正在跑的页面打成后台页；要并行就用浏览器级 socket 的
  `Target.createTarget { background: true }`。
- 密钥环弹窗来自 `Chrome Safe Storage` 的 ACL 绑定二进制签名：换二进制、反复重启都会弹，
  所以一个 profile 只能有一个守护进程持有（单实例），别并发 spawn。本机改用
  `mockKeychain: true`（`~/.dsh/browse-state/config.json`），代价只是旧 cookie 要重登一次。
- Chrome 的 cookie 大约 30 秒才落盘，直接 SIGTERM 会丢掉刚登录的会话。`close` 必须先发
  `Browser.close` 再等端口消失，最后才用信号。
- CDP 派发的 `Input.dispatchMouseEvent` 是 `isTrusted: true`，Turnstile 认；但坐标要换算成
  CSS 像素并叠加滚动偏移，且最好带几帧鼠标轨迹。

## 提交前自检

- `npm test` 全绿
- `node browse/browse.mjs status` 能起来，桌面上没有 Chrome 窗口，前台应用没被抢
- 改到状态判定时，至少跑一次 `open` + `batch`，确认退出码和状态一致
