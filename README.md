# QuotaSidebar

![QuotaSidebar — 一个面板，掌握所有 AI 额度](banner.png)

贴在屏幕边缘的一枚书签，鼠标划过就展开，用来盯 AI 编程订阅的额度还剩多少。

四个源在同一块面板里：**Claude**、**Codex**、**Cline**（支持多号，每个号一行）、**Opencode**。
每个源显示各自的窗口用量（5 小时 / 周 / 月）和下次重置时间。

## 它解决什么

同时挂着好几家订阅的时候，"现在该用哪个号"这件事只能靠挨个打开网页查。
QuotaSidebar 把这些数字集中到一处。

对挂在 New API 下的 Claude 多号，它还会按剩余配速自动排优先级并写回渠道表 ——
落后进度的排前面，超速的压到后面，这样几个号能大致同步烧完，
而不是一个见底、另几个还剩大半。满额的渠道自动禁用，窗口重置后自动启用。

## 依赖

额度数据不是从网页抓的，而是从你本机已有的服务里读：

| 源 | 数据来自 | 是否必需 |
|---|---|---|
| Cline、Opencode | [New API](https://github.com/QuantumNous/new-api) 的 SQLite 库 | **必需** |
| Claude | gproxy 的 SQLite 库 | 可选 |
| Codex | codex2api 的 SQLite 库 | 可选 |

Cline 和 Opencode 的渠道在 New API 里直接指向上游（`api.cline.bot` / `opencode.ai`），
所以那张表里存的就是上游真 key，拿着它能直接问到真实额度。

Claude 和 Codex 不行 —— 它们的渠道指向本机代理，New API 里只有代理的门票，
问不到上游的额度接口，真凭证在代理自己的库里。所以这两个各要多填一处，
不填就是少两张卡片，其余照常工作。

> 只读。程序不会改动这三个库里的凭证。唯一的写入是你手动点"禁用渠道"时，
> 对 New API 的 `channels` / `abilities` 两张表做窄 UPDATE。

## 安装

### 方式一：下载打包好的版本

到 [Releases](https://github.com/fatassasin/quota-sidebar/releases) 下载
`QuotaSidebar-win32-x64.zip`，解压到任意目录，双击里面的 `QuotaSidebar.exe`。
不需要装 Node.js。

想让它开机自启、或者在开始菜单里有个图标 —— 在**解压出来的那个目录里**打开
PowerShell（在地址栏敲 `powershell` 回车即可），执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File create-shortcut.ps1 -Startup
```

去掉 `-Startup` 就只建开始菜单快捷方式，不自启。这个脚本从源码目录里跑也可以，
它会自己认出是哪种装法。

### 方式二：从源码运行

需要 [Node.js](https://nodejs.org/) 18 以上和 Git。Windows 上在
PowerShell 或 Git Bash 里依次执行：

```bash
git clone https://github.com/fatassasin/quota-sidebar.git
cd quota-sidebar
npm install
npm start
```

`better-sqlite3` 是原生模块，得按 Electron 的 ABI 编译，`npm install` 一般会自动做。
启动时如果报 `NODE_MODULE_VERSION` 不匹配之类的 ABI 错误，手动重建一次：

```bash
npx electron-rebuild -f -w better-sqlite3
```

平时后台启动（不留控制台窗口）可以用仓库里的 `start.bat`：

```bash
./start.bat
```

自己打一份 zip：

```bash
npm run package
```

产物在 `dist/QuotaSidebar-win32-x64/`。

## 配置

启动后把鼠标移到书签上展开面板，点设置图标，拉到抽屉最底部的**配置渠道**，
填数据库文件的完整路径：

- **New API 数据库**（必填）—— 通常是 New API 目录下的 `one-api.db`
- **Claude — gproxy 数据库**（可选）—— gproxy 目录下的 `data/gproxy.db`
- **Codex — codex2api 数据库**（可选）—— codex2api 目录下的 `codex2api.db`

填完立刻会刷新一次。没填的源会在自己的卡片上直接写明缺哪一项。

> **不知道自己的路径在哪、或者你的部署方式跟这里对不上？**
> 把这个仓库丢给 Claude Code / Cursor 之类的 AI，让它读一遍 `sources.js`，
> 照着你的实际情况改查询或者帮你找出这几个 `.db` 文件的位置。
> 那个文件里每个源怎么取数都有中文注释，AI 照着改比你自己猜要快。

自检可以用：

```bash
npm run check
```

## 其它功能

- **书签**：可拖到任意屏幕的任意一条边，大小、高度、圆角都能调，也能整个藏起来
- **渠道开关**：面板里直接启用/禁用 New API 的渠道，满额的会自动禁用
- **定时热身**：到点发一条消息把 5 小时窗口提前点着；额度已经在动就跳过
- **仅在这些程序处于前台时显示**：默认关闭，书签一直在。想让它只在写代码的时候露头，
  去设置里打开，进程名单预填了 `claude` 和 `codex`，也可以自己加
- **面板高度自适应**：按当前有几张卡片自动收放

## 开发

```bash
node _ranktest.js     # 配速排序规则
node _polltest.js     # 轮询与强制刷新的合流
node _logtest.js      # 日志退路与轮转
node _memtest.js      # 内存播报
node _crashtest.js    # 崩溃自救
```

这几个测试不 `require('./sources')` —— `better-sqlite3` 按 Electron ABI 编译，普通 node 加载不了。
它们改成从 `main.js` / `sources.js` 里按字符串标记定位、把源码原文抠出来注入沙箱，
测的是真正在跑的那段代码。改代码时别破坏各测试文件里 `indexOf(...)` 用到的那几个标记。

## License

MIT
