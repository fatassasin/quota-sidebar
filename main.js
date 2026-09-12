const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage, powerMonitor } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { configure, fetchAll, toggleChannel, syncNewApi, warmup } = require('./sources')

let isQuitting = false
let sessionEnding = false // 系统关机/注销：两个窗口都会收到 session-end，只记一次
let logPath
// 出过「进程活着、窗口都在、CPU 也在转，但日志和 config 一个字节都不写」的毛病，
// 2026-09-01 那次持续了 52 分钟。当时 logEvent 是 catch {} 全吞的，事后从外部
// 什么都查不到（磁盘没满、文件可写、路径没跑偏，全排除了还是不知道原因）。
// 所以现在写失败必须留下现场 —— 而且不能留在写不进去的那个文件里。
let logLost = 0        // 掉了多少条
let logReported = false // 现场只打一次，后面的失败只补正文

function rotate(p, cap) {
  try {
    if (fs.statSync(p).size <= cap) return
    try { fs.unlinkSync(p + '.1') } catch {}
    fs.renameSync(p, p + '.1')
  } catch {}
}

// 主日志的退路。先临时目录、再程序目录：那个毛病的表现是 userData 整个写不进去，
// 退到同一棵目录树下等于没退，而程序目录在另一个盘上。
const FALLBACK_LOGS = [
  path.join(os.tmpdir(), 'quota-sidebar-fallback.log'),
  path.join(__dirname, 'quota-sidebar-fallback.log'),
]
function writeFallback(text) {
  for (const p of FALLBACK_LOGS) {
    try { rotate(p, 4 * 1024 * 1024); fs.appendFileSync(p, text); return p } catch {}
  }
  return null
}

// 第一次失败时的现场。关键是 errno/code/syscall 和真实解析出来的 userData ——
// 下次复发直接看这几行就知道是权限、路径跑偏，还是别的什么。
function logFailureReport(error) {
  let userData
  try { userData = app.getPath('userData') } catch (e) { userData = '取不到：' + e.message }
  let dirState
  try { dirState = fs.existsSync(path.dirname(logPath || '.')) ? '存在' : '不存在' } catch (e) { dirState = '查不了：' + e.message }
  return [
    '', '='.repeat(72),
    `${new Date().toISOString()} 主日志写入失败 —— 「进程活着但不写盘」的现场`,
    `  pid      = ${process.pid}`,
    `  userData = ${userData}`,
    `  logPath  = ${logPath}`,
    `  日志目录 = ${dirState}`,
    `  错误     = ${error?.code || '?'} ${error?.syscall || ''} errno=${error?.errno} ${error?.message || error}`,
    `  出错路径 = ${error?.path || '(错误对象里没带)'}`,
    '='.repeat(72), '',
  ].join('\n')
}

function logEvent(kind, detail = '') {
  const line = `${new Date().toISOString()} [${kind}] ${String(detail)}\n`
  try {
    if (!logPath) logPath = path.join(app.getPath('userData'), 'quota-sidebar.log')
    fs.appendFileSync(logPath, line)
    // 之前掉过线就补一笔，别让看主日志的人以为中间那段真的什么都没发生。
    if (logLost) {
      const n = logLost
      logLost = 0
      logReported = false
      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} [log:恢复] ` +
          `中间有 ${n} 条写不进来，正文在 ${FALLBACK_LOGS[0]}\n`)
      } catch {}
    }
  } catch (error) {
    logLost++
    if (!logReported) { logReported = true; writeFallback(logFailureReport(error)) }
    writeFallback(line)
    // 从终端起的话这句能直接看见；Start-Process 起的没有 stderr，靠上面那个文件。
    try { process.stderr.write(`[主日志写不进去] ${line}`) } catch {}
  }
}

function rotateLog() {
  // getPath 也放进 try：它要是抛了，logPath 保持 undefined，logEvent 下次会自己重试。
  try {
    logPath = path.join(app.getPath('userData'), 'quota-sidebar.log')
    rotate(logPath, 1024 * 1024)
  } catch {}
}

function errorText(error) {
  return error?.stack || error?.message || String(error)
}

function fatal(error) {
  logEvent('fatal', errorText(error))
  isQuitting = true
  app.exit(1)
}

process.on('uncaughtException', fatal)
process.on('unhandledRejection', (error) => logEvent('unhandledRejection', errorText(error)))

// 启动就记一行，主日志和退路日志各写一份。
//
// 这行是 2026-09-02 为了追查「开机自启的实例跑了 9.6 小时一个字节都没写」加的，
// 结果 9/3 一上线就把案子破了 —— 而且结论是：那个毛病根本不存在，是查的人瞎了。
// 退路日志（临时目录）里躺着四条启动记录，主日志里一条都没有，却又一次写入失败都没报。
// 原因是查这个问题的 Claude 跑在 MSIX 容器里，容器把 AppData\Roaming 的读写重定向进了
// 自己的 LocalCache，于是它看到的 quota-sidebar.log 是一份被固化在 9/2 23:57 的旧副本，
// 而临时目录是穿透的、能看见真货。应用一直写得好好的。
// 所以这行留着不是为了那个不存在的 bug，而是因为「同一次启动在两个不同根的位置各留一笔」
// 这件事本身，正是它戳破观测假象的原因。以后再遇到「日志里什么都没有」，先比这两处。
//
// 顺带这三种组合仍然有用：
//   主日志有 boot、没有 start        → whenReady 没走到（锁没拿到，或者启动中途就退了）
//   主日志空白、退路日志里有 boot     → 要么 userData 解析到别处（boot 行里写着解析到哪），
//                                      要么读日志的人隔着一层重定向 —— 先排除后者
//   两处都空白                       → main.js 根本没在这个位置被加载起来
rotateLog() // 提前到这儿，否则下面这行可能刚写完就被 whenReady 里的轮转搬进 .1
function logBoot() {
  let userData
  try { userData = app.getPath('userData') } catch (e) { userData = '取不到：' + e.message }
  const text = `pid=${process.pid} ppid=${process.ppid} userData=${userData} cwd=${process.cwd()}`
  logEvent('boot', text)
  // 退路那份是重点：主日志要是写到了别的目录、或者读的人看到的是别的副本，只有它对得上账。
  writeFallback(`${new Date().toISOString()} [boot] ${text}\n`)
}
logBoot()

// 单实例锁：重复启动只退出新实例，已有实例负责展开面板。
if (!app.requestSingleInstanceLock()) {
  logEvent('boot:锁没拿到', '已有实例在跑，本进程立刻结束')
  // 这里必须是 exit 不能是 quit。quit 只是排个队，whenReady 照样会跑完 —— 2026-09-02
  // 实测落败实例会一路建出两个窗口和托盘图标，跟主实例抢磁盘缓存（那几条
  // 「Unable to move the cache 拒绝访问」就是它闹的），然后才被拆掉。更糟的是它的
  // isQuitting 始终是假，而下面 close 处理器在非退出时会 preventDefault，
  // 等于这个多余实例有机会把自己的退出挡回去，从此赖着不走。
  // 通知已有实例这件事在 requestSingleInstanceLock 内部就做完了，这儿直接走人不影响。
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) setExpanded(true)
  })
}

const PANEL_W = 360
const EDGE_W = 6
// 兜底尺寸：只有 config 里 size/height 是 0 或 null 时才轮到它们。
// 跟 DEFAULTS.bookmark 保持一致，否则同一个「默认大小」在代码里有两个值。
const TAB_W = 15
const TAB_H = 60
const DEFAULTS = {
  intervalSec: 30,
  hideEmail: false,
  visible: { claude: true, codex: true, cline: true, opencode: true },
  names: { claude: 'Claude', codex: 'Codex', opencode: 'Opencode' },
  bookmark: { edge: 'right', offset: 0.5, hidden: false, displayId: null, size: 15, height: 60, rounded: 8 },
  panelHeight: 560,
  panelAuto: true,
  panelAutoHeight: null,
  autoShowAfterReset: true,
  // 开机自启，默认开。这东西的价值全在「一直都在那儿」——
  // 装完还得自己再去设一次，等于大半时间它根本没在盯额度。
  // 只对打包版生效，原因见 applyAutoLaunch。
  autoLaunch: true,
  // 默认关。开着的话新装的人打开程序、没同时开 claude/codex，就什么都看不见 ——
  // 分不清是没装好还是没配好，第一次用就先卡在这儿。想要这个行为的人自己去
  // 设置里打开（「仅在这些程序处于前台时显示」），下面那张进程名单已经填好备着了。
  onlyWhenRunning: false,
  processes: ['claude', 'codex'],
  hiddenUntil: {},
  claudeUsageSnapshots: {},
  newapiPriority: true,
  // 手动锁定为第 1 名的账号 id，null = 不锁、全交给配速自动排。
  // 在面板里点卡片上那个 1/2/3 徽章设置，同时只能锁一个。
  // 它只压排序，不压「满额自动禁用」—— 锁定的号烧穿了照样被禁用，重置后自己回到第一。
  pinnedRank: null,
  schedules: [],
  // 三个数据源的数据库位置，用户在设置抽屉最底部的「配置渠道」里填。默认必须全空 ——
  // 这份默认值会随程序发出去，写死任何人的实际路径都是错的。
  // 只有 newapi 必填；另外两个空着就少两张卡片，其余照常。详见 sources.js 顶部。
  sources: { newapi: '', gproxy: '', codex: '' },
}

let win, tabWin, tray, hideTimer, pollTimer, cursorTimer, schedTimer
let expanded = false
// 这次展开是从托盘点出来的。托盘是书签消失之后唯一的入口，所以由它打开的面板
// 得比平时结实：不受前台规则约束、鼠标不在面板里也不自动收、设置里改东西也踢不掉。
// 面板一收起就清零，下一次正常展开照旧走原来那套规则。
let trayPinned = false
let drawerOpen = false
let config
let dragState = null
let pollInFlight = null
// 手动强刷那一轮单独记一份，用来把连点合并成一次
let forcedInFlight = null
let tabStyleReady = false
let panelStyleReady = false

function live(w) { return !!w && !w.isDestroyed() }
function send(w, channel, payload) {
  if (live(w) && !w.webContents.isDestroyed()) w.webContents.send(channel, payload)
}
function runAsync(fn, label) {
  void fn().catch((error) => logEvent(label, errorText(error)))
}
function stopTimers() {
  clearTimeout(hideTimer)
  clearInterval(pollTimer)
  clearInterval(cursorTimer)
  clearInterval(procTimer)
  clearInterval(schedTimer)
  clearInterval(aliveTimer)
}
function quitApp() {
  if (isQuitting) return
  isQuitting = true
  stopTimers()
  logEvent('quit', 'explicit')
  app.quit()
}

// 轮询全局光标：setIgnoreMouseEvents 的窗口收不到 mouseleave，
// 只能靠这个判断鼠标是否真的离开了面板/标签区域。
function cursorInPanel() {
  if (!expanded) return false
  const p = screen.getCursorScreenPoint()
  // 面板和标签块都算“在面板上”，标签块和面板之间隔着一个 EDGE_W 条带
  return [win, tabWin].some((w) => {
    if (!w || w.isDestroyed()) return false
    const b = w.getBounds()
    return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  })
}

function startCursorWatch() {
  clearInterval(cursorTimer)
  let outside = null
  cursorTimer = setInterval(() => {
    // trayPinned 跟 drawerOpen 同待遇：从托盘点开时鼠标正在托盘区、根本不在面板里，
    // 不豁免的话面板会在 400ms 后自己关掉，看着就是「点了没反应」。
    if (!expanded || dragState || drawerOpen || trayPinned) { outside = null; return }
    if (cursorInPanel()) {
      // 鼠标回到面板内：取消已经挂起的隐藏，避免“鼠标还在面板里却被藏掉”
      clearTimeout(hideTimer)
      if (outside) outside = null
      return
    }
    if (outside) return // 仍在面板外，隐藏已就绪，别重复挂
    outside = true
    hideTimer = setTimeout(() => setExpanded(false), 400)
  }, 150)
}

function configPath() { return path.join(app.getPath('userData'), 'config.json') }

function loadConfig() {
  try {
    const raw = require('fs').readFileSync(configPath(), 'utf8')
    const p = JSON.parse(raw)
    return {
      ...DEFAULTS, ...p,
      visible: { ...DEFAULTS.visible, ...p.visible },
      names: { ...DEFAULTS.names, ...p.names },
      bookmark: { ...DEFAULTS.bookmark, ...p.bookmark },
      hiddenUntil: { ...DEFAULTS.hiddenUntil, ...p.hiddenUntil },
      sources: { ...DEFAULTS.sources, ...p.sources },
      processes: Array.isArray(p.processes) ? p.processes : DEFAULTS.processes,
      schedules: Array.isArray(p.schedules) ? p.schedules : [],
    }
  } catch (e) {
    // 文件存在但解析失败 = 配置损坏，先备份再回落默认，别把书签位置直接吞掉
    if (e.code !== 'ENOENT') {
      // 同样从 console.error 改走日志：这条要是丢了，用户只会看到「书签位置又乱了」，
      // 却没有任何线索指向配置损坏。
      logEvent('config:损坏', `${e.code || '?'} ${e.message}，已备份为 config.bad.json`)
      try { require('fs').copyFileSync(configPath(), configPath().replace('.json', '.bad.json')) } catch {}
    }
    return JSON.parse(JSON.stringify(DEFAULTS))
  }
}

let configFailed = false
function saveConfig() {
  // 原子写：拖拽时每帧都存，直接 writeFileSync 被中断会留下截断的 JSON，
  // 下次启动解析失败就整份回落 DEFAULTS（书签位置、名称、开关全丢）。
  const fs = require('fs')
  const p = configPath()
  try {
    fs.writeFileSync(p + '.tmp', JSON.stringify(config, null, 2))
    fs.renameSync(p + '.tmp', p)
    if (configFailed) { configFailed = false; logEvent('config:恢复', '又能存盘了') }
  } catch (e) {
    // 以前这里只 console.error，而 Start-Process 起的进程没有控制台、stderr 无处可去，
    // 等于存不了盘这件事彻底沉默。config 和日志同在 userData 底下，那个毛病发作时
    // 两边会一起停更 —— 这条记录正是用来确认「是不是整个 userData 写不进去」的。
    if (!configFailed) {
      configFailed = true
      logEvent('config:存盘失败', `${e.code || '?'} ${e.syscall || ''} ${e.message} path=${e.path || p}`)
    }
  }
}

function currentDisplay() {
  const d = screen.getAllDisplays()
  if (!config.bookmark.displayId) return d[0]
  return d.find((x) => x.id === config.bookmark.displayId) || d[0]
}

function tabBounds() {
  const d = currentDisplay()
  const b = d.bounds
  const bm = config.bookmark
  const off = Math.max(0, Math.min(1, bm.offset))
  // size/height 就是书签窗口在屏幕上的实际宽/高，也同时是悬浮响应区。
  const thickness = Math.max(1, Math.round(Number(bm.size) || TAB_W))
  const length = Math.max(1, Math.round(Number(bm.height) || TAB_H))
  const horizontal = bm.edge === 'top' || bm.edge === 'bottom'
  const w = horizontal ? length : thickness
  const h = horizontal ? thickness : length
  if (bm.edge === 'left') return { x: b.x, y: b.y + (b.height - h) * off, width: w, height: h }
  if (bm.edge === 'right') return { x: b.x + b.width - w, y: b.y + (b.height - h) * off, width: w, height: h }
  if (bm.edge === 'top') return { x: b.x + (b.width - w) * off, y: b.y, width: w, height: h }
  return { x: b.x + (b.width - w) * off, y: b.y + b.height - h, width: w, height: h }
}

// 面板高度：开了自适应就跟着额度卡片走（上限只剩屏幕），关掉才用手设的展开高度
// ponytail: 设置开着时冻结在打开那一刻的高度，否则开关渠道会让窗口变矮、按钮跟着跳位
let lastContentH = null
let frozenPanelH = null
function clampPanelHeight() {
  const b = currentDisplay().bounds
  const max = b.height - 40
  if (frozenPanelH) return Math.max(200, Math.min(max, frozenPanelH))
  if (config.panelAuto && lastContentH) return Math.max(200, Math.min(max, lastContentH))
  return Math.max(200, Math.min(max, config.panelHeight || 560))
}

function panelBounds(open) {
  const d = currentDisplay()
  const b = d.bounds
  const bm = config.bookmark
  const off = Math.max(0, Math.min(1, bm.offset))
  const h = open ? clampPanelHeight() : 0
  const w = open ? PANEL_W : 0
  switch (bm.edge) {
    case 'left': return { x: b.x + EDGE_W, y: b.y + (b.height - h) * off, width: w, height: h }
    case 'top': return { x: b.x + (b.width - w) * off, y: b.y + EDGE_W, width: w, height: h }
    case 'bottom': return { x: b.x + (b.width - w) * off, y: b.y + b.height - EDGE_W - h, width: w, height: h }
    default: return { x: b.x + b.width - EDGE_W - w, y: b.y + (b.height - h) * off, width: w, height: h }
  }
}

function setExpanded(open, force = false, fromTray = false) {
  if (!live(win) || (open && !panelStyleReady)) return
  if (!open && drawerOpen && !force) return
  // 前台规则和「把书签整个藏起来」都只该管书签自己，不该连托盘这条路一起堵死 ——
  // 书签一不见，设置就只能从托盘进，这儿再拦一道等于把人锁在门外。
  if (open && !fromTray && (!processActive || config.bookmark.hidden)) return
  if (open === expanded) return
  expanded = open
  trayPinned = open && fromTray
  clearTimeout(hideTimer)
  if (!open) frozenPanelH = null // 收起即解冻，下次展开重新按内容算
  const b = panelBounds(open)
  if (open) win.showInactive()
  win.setBounds(open ? b : { ...b, width: 0, height: 0 }, true)
  win.setIgnoreMouseEvents(!open, { forward: true })
  send(win, 'expanded', open)
  send(tabWin, 'expanded', open)
  if (open) startCursorWatch(); else { clearInterval(cursorTimer); win.hide() }
}

// 轮询的健康计数，只服务于心跳那一行。
let pollCount = 0
let pollOk = 0
let pollOkAt = 0
let pollErr = '' // 上一次的错误原文，用来判断该不该再记一条

// 最近一份成功的数据。留着它是为了「手动锁定第一名」能立刻见效：名次只跟已有的数字有关，
// 换个第一名没有任何理由再去问一遍上游 usage 接口（那个会吃 429，连点几下就更糟）。
let lastPayload = null

// 排名 + 渠道开关落库。抽出来是因为它有两个调用方：正常轮询，和面板里点锁之后的就地重排。
function applyRanking(accounts) {
  const touched = syncNewApi(accounts, {
    priority: config.newapiPriority !== false,
    pinned: config.pinnedRank || null,
  })
  if (touched.length) logEvent('newapi', JSON.stringify(touched))
}

async function pollOnce(force = false) {
  pollCount++
  try {
    const accounts = await fetchAll({ claudeUsageSnapshots: config.claudeUsageSnapshots, force })
    const snaps = accounts.filter((a) => a.$snapshot)
    if (snaps.length) {
      config.claudeUsageSnapshots = { ...config.claudeUsageSnapshots }
      for (const a of snaps) {
        config.claudeUsageSnapshots[a.id] = a.$snapshot
        delete a.$snapshot
      }
      saveConfig()
    }
    // 限额满了自动禁用渠道、重置后自动启用，并按周额度的配速（落后匀速进度的先用）给渠道排优先级。
    // 两张表一起写，漏一张就会留下「后台显示启用、实际收不到流量」的哑渠道。
    applyRanking(accounts)
    pollOk++
    pollOkAt = Date.now()
    if (pollErr) { logEvent('poll:恢复', `之前一直卡在「${pollErr}」`); pollErr = '' }
    const payload = { at: Date.now(), accounts }
    lastPayload = payload
    send(win, 'data', payload)
    return payload
  } catch (e) {
    // 取数失败以前只塞进 payload 给渲染进程看，一个字都不落盘 —— 8/28 网络服务死掉之后
    // 那 33 小时里日志一片空白，正是因为这里。同一个错误不重复刷（60 秒一轮会刷爆日志），
    // 但错误变了、或刚从正常掉下来，一定要记。
    const msg = String(e.message || e)
    if (msg !== pollErr) { pollErr = msg; logEvent('poll:失败', msg) }
    const payload = { at: Date.now(), accounts: [], error: msg }
    send(win, 'data', payload)
    return payload
  }
}

// force = 手动点了刷新。这时不能复用正在跑的那一轮：后台轮询走的是 Claude 那份 5 分钟缓存，
// 直接把它的结果还回去，用户看到的就是「点了没反应」—— 轮询 60 秒一轮、缓存 5 分钟，
// 五次里有四次都会这样。所以强刷排在正在跑的那轮后面，再真去问一次上游。
function poll(force = false) {
  if (force) {
    // 已经有一轮强刷在跑就复用它：连点几下不该变成连打几次 usage 接口（那个会吃 429）。
    if (forcedInFlight) return forcedInFlight
    const p = (pollInFlight ? pollInFlight.catch(() => {}) : Promise.resolve())
      .then(() => pollOnce(true))
    forcedInFlight = pollInFlight = p
    p.finally(() => {
      if (forcedInFlight === p) forcedInFlight = null
      if (pollInFlight === p) pollInFlight = null
    })
    return p
  }
  if (pollInFlight) return pollInFlight
  const p = pollOnce(false)
  pollInFlight = p
  p.finally(() => { if (pollInFlight === p) pollInFlight = null })
  return p
}

// 渲染进程算好内容高度回传，用于自适应收窄
ipcMain.on('content:height', (_e, h) => {
  const next = Math.max(1, Math.round(Number(h) || 0))
  lastContentH = next
  if (config.panelAutoHeight !== next) {
    config.panelAutoHeight = next
    saveConfig()
  }
  if (expanded && config.panelAuto && live(win)) {
    const b = panelBounds(true)
    win.setBounds(b, true)
  }
})

function startPoll() {
  clearInterval(pollTimer)
  pollTimer = setInterval(() => runAsync(poll, 'poll'), config.intervalSec * 1000)
}

// 心跳。作用不是记录什么新东西，而是让「日志里什么都没有」这件事本身能被解读 ——
// 那个毛病发作时进程活着、窗口在、CPU 在转，可日志一片空白，事后完全分不清是哪一环坏了。
// 有了这条定时输出，三种故障就能当场分开：
//   主日志有 alive、没有 newapi        → 取数坏了（poll:失败 那几条会说明是什么错）
//   主日志空白、退路日志里有 alive     → userData 写不进去（现场在退路日志开头）
//   两个日志都空白                     → 主进程事件循环卡死，连定时器都不跑了
//   alive 还在、但带着「心跳晚了」和很低的提交余量 → 是整机内存见底，不是我们的问题
// 十分钟一条，一天 144 行，对 1MB 的轮转上限来说可以忽略。
const ALIVE_MS = 10 * 60 * 1000
let aliveTimer
let aliveAt = 0 // 上一条心跳的时刻，用来量事件循环被拖了多久

const GB = (kb) => (kb / 1048576).toFixed(1)

// 2026-09-02 查出来的：那次「三个应用同时无反应」不是谁的 bug，是整机提交内存
// （commit charge）被 ComfyUI 顶到了上限 —— 83.3/88.9 GB，只剩 5.7 GB。
// 提交内存见底时 Windows 拒绝一切新分配，所有进程一起中招，跟谁写得好不好无关。
// 物理内存当时还剩 15 GB，所以光看「可用内存」什么都看不出来，必须看提交量。
function memText() {
  try {
    // 单位 KB。Windows 上这四项取自 GlobalMemoryStatusEx：
    //   total/free         = 物理内存总量 / 可用
    //   swapTotal/swapFree = ullTotalPageFile / ullAvailPageFile，也就是提交上限 / 提交剩余
    // 名字叫 swap 容易误会成「页面文件大小」，它其实已经是提交量本身，别再跟物理内存相加。
    // 2026-09-02 拿 Get-Counter 对过账：swapTotal 88.93GB = commit limit 88.94GB，
    // swapFree 5.43GB = 88.94-83.50 commit 剩余，分毫不差。
    const m = process.getSystemMemoryInfo()
    const t = `物理余 ${GB(m.free)}/${GB(m.total)}GB`
    if (!m.swapTotal) return t
    return `提交 ${GB(m.swapTotal - m.swapFree)}/${GB(m.swapTotal)}GB(余 ${GB(m.swapFree)})　${t}`
  } catch {
    // 用文件顶上那个 os，不在这儿现 require —— 这条路径本来就是出事时才走的，
    // 别再给它添一次可能失败的模块加载。
    return `物理余 ${(os.freemem() / 1073741824).toFixed(1)}/${(os.totalmem() / 1073741824).toFixed(1)}GB`
  }
}

function logAlive() {
  const now = Date.now()
  const up = (now - startedAt) / 3600000
  const ago = pollOkAt ? `${Math.round((now - pollOkAt) / 1000)}s 前` : '一次都没成功过'
  // 定时器晚了多少。心跳该十分钟一条，晚出一大截就说明事件循环被什么东西按住了 ——
  // 这是「进程活着但不干活」唯一能自证的证据，从外面拿 Responding 是看不出来的。
  const late = aliveAt ? now - aliveAt - ALIVE_MS : 0
  aliveAt = now
  logEvent('alive', `已运行 ${up.toFixed(1)}h　轮询 ${pollCount} 次、成功 ${pollOk} 次、上次成功 ${ago}` +
    `　${memText()}　自身 ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB` +
    (late > 30000 ? `　⚠ 心跳晚了 ${Math.round(late / 1000)}s` : '') +
    (pollErr ? `　当前故障「${pollErr}」` : ''))
}

// --- 定时热身任务 -----------------------------------------------------------
// 5 小时窗口从窗口内第一次请求起算。开工前几小时先发一条消息把窗口点着，
// 开工时就能连着用完当前窗口和紧接着的下一个。
const SCHEDULE_TICK = 30 * 1000
// 到点时电脑没开机就补跑；超过这个时长算错过，静默跳过（补太晚只会把窗口推后，没意义）。
// 这同时也是「窗口还在计时」时反复重试的上限。
const SCHEDULE_CATCHUP = 2 * 60 * 60 * 1000
// 因为窗口还在计时而跳过之后，隔多久再看一眼。usage 接口不禁得住 30 秒一次的轮询。
const SCHEDULE_RECHECK = 10 * 60 * 1000
// 勾了「等重置后补发」时的作废上限：从挂起那一刻起算。5 小时窗口最多等 5 小时，
// 留 24 小时是给关机的情况兜底，超了说明早过了这次热身的意义。
const SCHEDULE_RESUME_MAX = 24 * 60 * 60 * 1000
let scheduleBusy = false

function fireAt(time, base) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim())
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return null
  const d = new Date(base)
  d.setHours(h, min, 0, 0)
  return d.getTime()
}

// 这条任务当前该补跑的那个时刻，没有就 null。也看昨天那一次，跨零点的任务才不会漏。
function dueAt(s, now) {
  // 挂起等窗口重置：只认那个重置时刻。这里必须绕开下面的 CATCHUP 两小时上限，
  // 否则窗口还剩三四个小时的时候，补发永远等不到就被判成错过了。
  if (s.resumeAt) return now >= Number(s.resumeAt) ? Number(s.resumeAt) : null
  // 上一次是因为「窗口还在计时」跳过的：等够 RECHECK 再看，别每 30 秒问一次用量
  if (s.lastSkipAt && now - s.lastSkipAt < SCHEDULE_RECHECK) return null
  for (const offset of [0, -86400000]) {
    const fire = fireAt(s.time, now + offset)
    if (fire == null) return null // 时间串本身无效，看昨天也没用
    if (fire > now || now - fire > SCHEDULE_CATCHUP) continue
    const days = Array.isArray(s.days) && s.days.length ? s.days : null
    if (days && !days.includes(new Date(fire).getDay())) continue
    if (Number(s.lastRunAt) >= fire) continue
    return fire
  }
  return null
}

async function runSchedule(id, auto, only) {
  const s = (config.schedules || []).find((x) => x.id === id)
  if (!s) throw new Error('任务不存在')
  const all = Array.isArray(s.targets) ? s.targets : []
  // 补发那一轮只打上次被挡下的那几个。已经发成功的现在窗口正亮着，再打一次只会被
  // 同一个判断挡回来，然后把补发时刻又往后推 —— 两个账号能这么无限互相推迟下去。
  const targets = Array.isArray(only) ? all.filter((t) => only.includes(t)) : all
  const detail = targets.length
    ? await warmup(targets, s.message || 'hi', s.model)
    : [{ id: '—', ok: false, error: '没有选择目标账号' }]

  const at = Date.now()
  // 有目标是因为「窗口还在计时」被跳过的：这次不算跑完。
  const skipped = detail.filter((d) => d.skipped)
  const pending = skipped.length > 0
  // 勾了「等重置后补发」就精确等到窗口重置那一刻，否则退回原来的隔 RECHECK 盲目重试。
  // 取最晚的那个重置时刻：等到它，被挡下的目标才都腾出了窗口。
  const resets = skipped.map((d) => Number(d.resetsAt)).filter((t) => Number.isFinite(t) && t > at)
  const resumeAt = s.waitReset !== false && resets.length ? Math.max(...resets) : null

  // 就地改 config 上那一条：config:set 会保住这几个字段，不会被渲染进程覆盖掉
  const cur = (config.schedules || []).find((x) => x.id === id)
  if (cur) {
    cur.lastResult = { at, auto: !!auto, detail, resumeAt }
    if (pending && resumeAt) {
      cur.resumeAt = resumeAt
      cur.resumePending = skipped.map((d) => d.id)
      cur.resumeFire = cur.resumeFire || at // 从第一次挂起起算，用来判作废
      cur.lastSkipAt = null
    } else if (pending) {
      cur.lastSkipAt = at
      cur.resumeAt = cur.resumePending = cur.resumeFire = null
    } else {
      cur.lastRunAt = at
      cur.lastSkipAt = null
      cur.resumeAt = cur.resumePending = cur.resumeFire = null
    }
  }
  saveConfig()
  logEvent('schedule', `${id} ${auto ? 'auto' : 'manual'} ` +
    detail.map((d) => `${d.id}=${d.ok ? (d.skipped ? 'skip' : 'ok') : d.error}`).join(' | '))
  send(win, 'schedules', config.schedules)

  // 旧的那次轮询拿的是发送之前的数据，等它收工再重拉，卡片上才看得到新窗口
  if (pollInFlight) { try { await pollInFlight } catch {} }
  await poll()
  return detail
}

async function tickSchedules() {
  if (scheduleBusy) return
  const now = Date.now()
  // 挂起太久的先清掉，否则 resumeAt 会一直挡在 dueAt 最前面，正常的到点判断再也轮不到
  let stale = false
  for (const s of config.schedules || []) {
    if (s.resumeAt && now - Number(s.resumeFire || s.resumeAt) > SCHEDULE_RESUME_MAX) {
      s.resumeAt = s.resumePending = s.resumeFire = null
      stale = true
      logEvent('schedule', `${s.id} 挂起超过 24 小时，放弃补发`)
    }
  }
  if (stale) { saveConfig(); send(win, 'schedules', config.schedules) }

  const due = (config.schedules || []).filter((s) => s.enabled !== false && dueAt(s, now) != null)
  if (!due.length) return
  scheduleBusy = true
  try {
    for (const s of due) {
      // 挂起中的只补发上次被挡下的那几个目标
      const only = s.resumeAt ? s.resumePending : null
      try { await runSchedule(s.id, true, only) } catch (e) { logEvent('schedule', errorText(e)) }
    }
  } finally { scheduleBusy = false }
}

function startSchedules() {
  clearInterval(schedTimer)
  schedTimer = setInterval(() => runAsync(tickSchedules, 'schedule'), SCHEDULE_TICK)
  runAsync(tickSchedules, 'schedule') // 启动即补跑一次错过的
}

// lastRunAt / lastSkipAt / lastResult / resume* 归主进程所有。渲染进程回传的是整份 config，
// 如果让它把这几个字段带回来（它没有），同一个时刻会被反复触发。
function mergeSchedules(prev, next) {
  if (!Array.isArray(next)) return prev || []
  const old = new Map((prev || []).map((s) => [s.id, s]))
  return next.map((s) => ({
    ...s,
    lastRunAt: old.get(s.id)?.lastRunAt ?? null,
    lastSkipAt: old.get(s.id)?.lastSkipAt ?? null,
    lastResult: old.get(s.id)?.lastResult ?? null,
    resumeAt: old.get(s.id)?.resumeAt ?? null,
    resumePending: old.get(s.id)?.resumePending ?? null,
    resumeFire: old.get(s.id)?.resumeFire ?? null,
  }))
}

function syncBookmark() {
  const bm = config.bookmark
  if (bm.hidden || !processActive) {
    if (live(tabWin)) tabWin.hide()
    // 书签该藏还是藏，但托盘点开的面板不能连坐 —— 设置里改任何一项都会走到这儿
    // （config:set 里跟着调 syncBookmark），不豁免的话你刚从托盘打开、一动设置就被踢出去。
    if (!trayPinned) setExpanded(false, true)
    return
  }
  if (live(tabWin) && tabStyleReady) {
    tabWin.setBounds(tabBounds(), true)
    tabWin.show()
  }
}

// --- 只在指定程序位于前台时显示 -------------------------------------------
// 进程“仍在后台运行”不等于用户正在使用它；这里看 Windows 前台窗口所属进程。
let processActive = true
let procTimer
let processCheckInFlight = false
const FOREGROUND_PS = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ForegroundProcess {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$pid_ = 0
[ForegroundProcess]::GetWindowThreadProcessId([ForegroundProcess]::GetForegroundWindow(), [ref]$pid_) | Out-Null
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$ids = @([uint32]$pid_)
for ($i = 0; $i -lt $ids.Count; $i++) {
  $parent = $ids[$i]
  $ids += @($all | Where-Object { $_.ParentProcessId -eq $parent } | ForEach-Object { [uint32]$_.ProcessId })
}
$names = @($all | Where-Object { $ids -contains [uint32]$_.ProcessId } | ForEach-Object { $_.Name.ToLower().Replace('.exe', '') } | Select-Object -Unique)
[pscustomobject]@{ pid = [uint32]$pid_; names = $names } | ConvertTo-Json -Compress
`

function foregroundApp() {
  return new Promise((resolve) => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_PS],
      { windowsHide: true, timeout: 3000 }, (err, out) => {
        if (err) return resolve(null)
        try { resolve(JSON.parse(String(out))) } catch { resolve(null) }
      })
  })
}

// 设置页仍需要完整进程表作为添加候选。
function runningNames() {
  return new Promise((resolve) => {
    require('child_process').execFile('tasklist', ['/fo', 'csv', '/nh'],
      { windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => {
        if (err) return resolve(null) // 查不到就别误杀，保持当前状态
        const set = new Set()
        for (const line of out.split('\n')) {
          const m = /^"([^"]+)"/.exec(line)
          if (m) set.add(m[1].toLowerCase().replace(/\.exe$/, ''))
        }
        resolve(set)
      })
  })
}

async function checkProcessesOnce() {
  if (!config.onlyWhenRunning) {
    if (!processActive) { processActive = true; syncBookmark() }
    return
  }
  const names = config.processes || []
  if (!names.length) return // 列表空 = 没有可匹配项，别把书签永久藏死
  const app = await foregroundApp()
  if (!app) return
  // 自己的设置/面板获得焦点时保持原状态；Codex 商店版的前台壳是 ChatGPT (Beta)，
  // 真正的 codex.exe 是它的子进程，所以匹配整棵前台应用进程树。
  const ownPids = [
    process.pid,
    live(win) ? win.webContents.getOSProcessId() : null,
    live(tabWin) ? tabWin.webContents.getOSProcessId() : null,
  ]
  if (ownPids.includes(app.pid)) return
  const foreground = new Set(Array.isArray(app.names) ? app.names : [app.names])
  const active = names.some((n) => foreground.has(String(n).toLowerCase().replace(/\.exe$/, '')))
  if (active === processActive) return
  processActive = active
  syncBookmark()
}

async function checkProcesses() {
  if (processCheckInFlight) return
  processCheckInFlight = true
  try { await checkProcessesOnce() } finally { processCheckInFlight = false }
}

function startProcWatch() {
  clearInterval(procTimer)
  procTimer = setInterval(() => runAsync(checkProcesses, 'process-watch'), 1200)
  runAsync(checkProcesses, 'process-watch')
}

// 开机自启。把当前 exe 登记进注册表的 Run 键，由 Electron 代劳。
//
// 只在打包版做。源码版跑的是 node_modules 里的 electron.exe，把它连同项目路径写进
// 注册表，日后一挪目录就变成一条指向空处的启动项 —— 而且不会报错，只是某天起
// 开机后它就不在了，没人查得出为什么。源码版要自启请用 create-shortcut.ps1 -Startup。
//
// 比对只看 openAtLogin（注册表里那条在不在），不看 executableWillLaunchAtLogin。
// 差别在于：任务管理器「启动」页禁用一项时，不删注册表，只另外记一个禁用标记 ——
// 于是 openAtLogin 仍是 true，我们这儿就不会去重写它。用户在任务管理器里关掉的，
// 我们不偷偷再打开；只有设置里那个开关才是我们该管的。
function applyAutoLaunch() {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const want = config.autoLaunch !== false
  try {
    if (app.getLoginItemSettings({ path: process.execPath }).openAtLogin === want) return
    app.setLoginItemSettings({ openAtLogin: want, path: process.execPath, args: ['--no-sandbox'] })
    logEvent('自启', want ? '已登记开机启动' : '已取消开机启动')
  } catch (e) {
    // 失败不该拦住启动：注册表被组策略锁死的机器上写不进去很正常，
    // 但除此之外程序完全能用，没必要为这个不让人开门。
    logEvent('自启:失败', String((e && e.message) || e))
  }
}

function applyToolWindow(w, label) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !live(w)) return resolve(false)
    const handle = w.getNativeWindowHandle().readBigUInt64LE().toString()
    const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ToolWindowStyle {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$h = [IntPtr]::new([Int64]${handle})
$style = [ToolWindowStyle]::GetWindowLongPtr($h, -20).ToInt64()
$style = ($style -bor 0x80) -band (-bnot 0x40000)
[ToolWindowStyle]::SetWindowLongPtr($h, -20, [IntPtr]::new($style)) | Out-Null
[ToolWindowStyle]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x27) | Out-Null
`
  require('child_process').execFile(
    'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 3000 },
    (error) => {
      if (error) logEvent(`${label}:tool-window`, errorText(error))
      resolve(!error)
    },
  )
  })
}

function watchWindow(label, w) {
  w.on('close', (event) => {
    logEvent(`${label}:close`, isQuitting ? 'quit' : 'prevented')
    if (isQuitting) return
    event.preventDefault()
    if (label === 'panel') setExpanded(false, true)
    else w.hide()
  })
  w.on('closed', () => logEvent(`${label}:closed`))
  w.on('unresponsive', () => logEvent(`${label}:unresponsive`))
  w.on('responsive', () => logEvent(`${label}:responsive`))
  // Windows 上关机 / 注销 / 重启的唯一通知点（@platform win32，electron.d.ts 里写着
  // 「Once this event fires, there is no way to prevent the session from ending」）。
  // 两件事都要在这儿做完：
  //   1. 立起 isQuitting。上面那个 close 处理器在非退出时会 preventDefault —— 关机时要是
  //      还拦着，等于我们在拖住整台机器关机。
  //   2. 记一行。这样日志里接下来那段空白就有了出处，不用再翻一遍系统事件日志。
  w.on('session-end', (event) => {
    if (sessionEnding) return // 两个窗口都会收到，只记一次
    sessionEnding = true
    isQuitting = true
    stopTimers()
    logEvent('power', `会话结束（${(event?.reasons || []).join(',') || '未说明原因'}）—— 后面的空白是机器关着`)
  })
  // 渲染进程没了，窗口就剩一块空白，而且再也不会自己回来。主进程还活着，所以没人发现。
  // reload() 会重新拉起一个。
  //
  // 但 2026-09-02 复查发现这段自救建立在一个误判上：当初以为 8/28 那次是渲染进程崩了，
  // 其实那是 GameViewer 每天清晨发起的系统关机 —— 关机时 Windows 会挨个强杀子进程，
  // 于是「渲染进程没了」在每一次关机时都必然出现，我们却在那一刻去 reload。
  // 事件日志里 8/25–9/1 每天都有一条 1074，跟日志里的 render-process-gone 一一对得上。
  let reloads = 0
  w.webContents.on('render-process-gone', (_event, details) => {
    logEvent(`${label}:render-process-gone`, JSON.stringify(details))
    if (isQuitting || w.isDestroyed() || ++reloads > 3) return
    // 关机的招牌：被外部强杀。0x40010004 = DBG_TERMINATE_PROCESS，正是 Windows 关机时
    // 收拾子进程留下的码。这时候补拉只会跟关机流程抢资源，而且必定白干。
    if (details.reason === 'killed' && details.exitCode === 0x40010004) {
      logEvent(`${label}:不补拉`, '被外部强杀（0x40010004），按系统关机处理')
      return
    }
    logEvent(`${label}:reload`, `第 ${reloads} 次补拉渲染进程`)
    setTimeout(() => { if (!isQuitting && !w.isDestroyed()) w.reload() }, 1000)
  })
  w.webContents.on('did-fail-load', (_event, code, description) => {
    logEvent(`${label}:did-fail-load`, `${code} ${description}`)
  })
}

function createWindows() {
  const bm = config.bookmark

  // bookmark tab window
  tabWin = new BrowserWindow({
    ...tabBounds(),
    show: false,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  // 构造函数给的 bounds 不作数：多显示器/缩放下会落在主屏、高度还会被四舍五入涨 1px。
  // 建完立刻 setBounds 一次，这才是“重启后记住宽高位置”的那一下。
  tabWin.setBounds(tabBounds(), false)
  tabWin.setAlwaysOnTop(true, 'screen-saver')
  tabWin.setVisibleOnAllWorkspaces(true)
  tabWin.setIgnoreMouseEvents(false)
  watchWindow('tab', tabWin)
  tabWin.once('ready-to-show', async () => {
    await applyToolWindow(tabWin, 'tab')
    tabStyleReady = true
    syncBookmark()
  })
  tabWin.loadFile(path.join(__dirname, 'tab.html'))

  // main panel window
  win = new BrowserWindow({
    ...panelBounds(false),
    show: false,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  win.setIgnoreMouseEvents(true, { forward: true })
  // 设置抽屉开着的时候点到别处去，等同于关掉设置：面板收起，下次打开回额度列表。
  // 只有抽屉开着才会走到这里 —— 平时面板是 focusable:false，压根拿不到焦点，也就没有 blur。
  // 走 force 是必须的：setExpanded 平时会拒绝在抽屉开着时收起（见那边的注释），
  // 而这里正是那条规则唯一的例外 —— 用户已经明确把注意力挪走了。
  win.on('blur', () => {
    if (!drawerOpen) return
    setExpanded(false, true)
  })
  watchWindow('panel', win)
  win.once('ready-to-show', async () => {
    await applyToolWindow(win, 'panel')
    panelStyleReady = true
  })
  win.loadFile(path.join(__dirname, 'index.html'))

  // --- tab events ---
  ipcMain.on('tab:hover', (_e, over) => {
    if (config.bookmark.hidden) return
    clearTimeout(hideTimer)
    if (over) setExpanded(true)
    else hideTimer = setTimeout(() => setExpanded(false), 400)
  })

  ipcMain.on('tab:drag:start', (_e, { x, y }) => {
    const tb = tabWin.getBounds()
    dragState = { startX: x, startY: y, bounds: tb }
  })

  ipcMain.on('tab:drag:move', (_e, { x, y }) => {
    if (!dragState) return
    const d = currentDisplay().bounds
    const dx = x - dragState.startX
    const dy = y - dragState.startY
    const b = dragState.bounds
    const cx = b.x + dx + b.width / 2
    const cy = b.y + dy + b.height / 2

    // snap to nearest edge
    const dist = {
      left: cx - d.x,
      right: d.x + d.width - cx,
      top: cy - d.y,
      bottom: d.y + d.height - cy,
    }
    const edge = Object.entries(dist).sort((a, b) => a[1] - b[1])[0][0]
    const edgeChanged = config.bookmark.edge !== edge
    config.bookmark.edge = edge

    // compute offset along that edge
    let off
    if (edge === 'left' || edge === 'right') {
      off = (cy - d.y - b.height / 2) / (d.height - b.height)
    } else {
      off = (cx - d.x - b.width / 2) / (d.width - b.width)
    }
    config.bookmark.offset = Math.max(0, Math.min(1, off))
    tabWin.setBounds(tabBounds(), true)
    if (edgeChanged) {
      tabWin.webContents.send('config', config.bookmark)
      if (expanded) win.setBounds(panelBounds(true), true)
    }
    // ponytail: 拖拽中不落盘，drag:end 存一次就够
  })

  ipcMain.on('tab:drag:end', () => { dragState = null; saveConfig() })

  // --- panel events ---
  ipcMain.on('hover', (_e, over) => {
    clearTimeout(hideTimer)
    if (over) setExpanded(true)
    else hideTimer = setTimeout(() => setExpanded(false), 400)
  })
  // 必须写成显式箭头函数：IPC 回调的第一个参数是 event 对象，直接把 poll 传进去，
  // 那个对象就会落进 force 参数（真值），连「打开面板取一次数据」都变成强刷。
  ipcMain.on('refresh', () => poll(true))        // 面板上的 ↻：用户明确要最新的
  ipcMain.handle('data:get', () => poll(false))  // 面板打开时被动取一次，用缓存就够
  ipcMain.on('panel:close', () => setExpanded(false, true))
  // 设置抽屉打开时面板必须可聚焦，否则 input 收不到键盘（focusable:false 会挡住所有输入）
  ipcMain.on('drawer:open', (_e, open) => {
    drawerOpen = open
    clearTimeout(hideTimer)
    // 先冻结当前高度再展开，设置期间开关渠道不会让窗口变矮、按钮跳位；关掉解冻回自适应
    frozenPanelH = open ? clampPanelHeight() : null
    if (open) setExpanded(true)
    if (expanded && live(win)) win.setBounds(panelBounds(true), true)
    win.setFocusable(open)
    if (open) { win.focus() } else { win.blur() }
  })
  ipcMain.handle('channel:toggle', async (_e, chId) => {
    const next = toggleChannel(chId)
    await poll() // 立即重拉，反映新禁用状态
    return next
  })

  ipcMain.handle('config:get', () => config)
  ipcMain.handle('config:set', (_e, cfg) => {
    const previousIntervalSec = config.intervalSec
    const previousPinned = config.pinnedRank || null
    // 渲染进程每次改设置都把整份 config 发回来，所以不能拿「带没带 sources」当判据 ——
    // 那样点一下任何开关都会触发一次强刷。比内容。
    const previousSources = JSON.stringify(config.sources || {})
    config = {
      ...config, ...cfg,
      visible: { ...config.visible, ...cfg.visible },
      names: { ...config.names, ...cfg.names },
      bookmark: { ...config.bookmark, ...cfg.bookmark },
      hiddenUntil: cfg.hiddenUntil == null ? config.hiddenUntil : { ...cfg.hiddenUntil },
      sources: { ...config.sources, ...cfg.sources },
      processes: Array.isArray(cfg.processes) ? cfg.processes : config.processes,
      schedules: mergeSchedules(config.schedules, cfg.schedules),
    }
    saveConfig()
    // 路径变了要立刻灌给 sources，否则下一轮轮询还在用旧路径。
    // 顺手强刷一次：刚填完地址就看到卡片出来，比等一个轮询间隔踏实得多。
    if (JSON.stringify(config.sources) !== previousSources) {
      configure(config.sources)
      runAsync(() => poll(true), 'poll:配置渠道改动')
    }
    if (config.intervalSec !== previousIntervalSec) startPoll()
    // 锁定的号变了：拿最近一份数据就地重排、重写渠道优先级，不去问上游。
    // 还没跑出过任何一轮数据（刚起来就点）才退回去走一次正常轮询。
    if ((config.pinnedRank || null) !== previousPinned) {
      if (lastPayload) {
        applyRanking(lastPayload.accounts)
        send(win, 'data', lastPayload)
      } else {
        runAsync(() => poll(false), 'poll:锁定名次改动')
      }
    }
    applyAutoLaunch()
    runAsync(checkProcesses, 'process-watch')
    syncBookmark()
    if (expanded && live(win)) win.setBounds(panelBounds(true), true)
    send(tabWin, 'config', config.bookmark)
    return config
  })

  // 设置页「立即发送」：跑一次不改动它的定时槽位（lastRunAt 仍会前移，避免紧接着又自动跑一次）
  ipcMain.handle('schedule:run', async (_e, id) => {
    if (scheduleBusy) throw new Error('已有任务正在发送')
    scheduleBusy = true
    try { return await runSchedule(id, false) } finally { scheduleBusy = false }
  })

  ipcMain.handle('displays:list', () => screen.getAllDisplays().map((d) => ({
    id: d.id, label: d.label || `Display ${d.id}`, bounds: d.bounds, primary: d.primary,
  })))

  // 设置页用：当前在跑的进程名，供勾选添加
  ipcMain.handle('procs:list', async () => {
    const set = await runningNames()
    return set ? [...set].sort() : []
  })

  ipcMain.on('bookmark:toggleHidden', (_e, hidden) => {
    config.bookmark.hidden = hidden
    saveConfig()
    syncBookmark()
  })

  ipcMain.on('bookmark:setStyle', (_e, { size, height, rounded }) => {
    if (size != null) config.bookmark.size = size
    if (height != null) config.bookmark.height = height
    if (rounded != null) config.bookmark.rounded = rounded
    saveConfig()
    syncBookmark()
    send(tabWin, 'config', config.bookmark)
  })

  runAsync(poll, 'poll')
  startPoll()
  startProcWatch()
  startSchedules()
  // 第一条心跳等 30 秒再打：立刻打的话首轮轮询还没回来，那行会写着「成功 0 次」，
  // 看上去正好像是取数坏了 —— 一条每次重启都出现的假故障，比没有还糟。
  // setTimeout 的返回值交给同一个变量，stopTimers 里的 clearInterval 一样收得掉。
  aliveTimer = setTimeout(() => {
    logAlive()
    aliveTimer = setInterval(logAlive, ALIVE_MS)
  }, 30000)
}

app.whenReady().then(() => {
  rotateLog()
  // userData 路径写进日志：那个毛病的候选解释之一是路径跑偏（写到别处去了，
  // 所以「日志目录」看着是空的）。记下来就能一眼排除，不用再全盘搜一遍。
  logEvent('start', `pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node} ` +
    `chrome=${process.versions.chrome} userData=${logPath ? path.dirname(logPath) : '取不到'}`)
  config = loadConfig()
  applyAutoLaunch()
  // 数据源位置来自配置，不再写死。没填过的话这里灌的是三个空串，四张卡片会各自报
  // 「还没配置…」，正是要让人看到的提示。
  configure(config.sources)
  lastContentH = config.panelAutoHeight || null
  createWindows()

  // 睡眠 / 唤醒记一笔。这几行不为排查什么故障，纯粹是为了让日志里的长段空白能自证 ——
  // 2026-09-02 这次查了大半天「05:03 到 17:29 一片空白」，最后发现机器就是关着的
  // （GameViewer 每天清晨发起关机，事件日志里 8/25 起天天都有）。当时要是日志自己写着
  // 「系统关机」，这半天根本不用花。空白后面紧跟 resume 或 start，就说明是关机/睡眠，
  // 不是挂死；空白前后什么都没有，才轮到怀疑我们自己。
  //
  // 关机不在这儿收：powerMonitor 的 shutdown 事件只在 linux 和 darwin 上有
  // （electron.d.ts 里写着 @platform linux,darwin），Windows 上挂了也永远不响。
  // 真正的关机通知在 BrowserWindow 的 session-end 上，见 createWindows 里那段。
  for (const [ev, text] of [['suspend', '系统进入睡眠'], ['resume', '系统从睡眠醒来']]) {
    powerMonitor.on(ev, () => logEvent('power', text))
  }

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')))
  tray.setToolTip('额度侧板')
  tray.setContextMenu(Menu.buildFromTemplate([
    // 第三个参数是「这是从托盘点的」。托盘是书签藏起来之后唯一还能进面板的地方，
    // 所以它不受前台规则管 —— 否则前台规则一开、手边又没在跑 claude，这一项就是死的。
    { label: '展开/收起', click: () => setExpanded(!expanded, false, true) },
    { label: '立即刷新', click: () => runAsync(() => poll(true), 'poll') },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]))
  tray.on('click', () => setExpanded(!expanded, false, true))
}).catch(fatal)

app.on('before-quit', () => {
  isQuitting = true
  stopTimers()
  logEvent('before-quit')
})
app.on('will-quit', () => logEvent('will-quit'))
app.on('window-all-closed', () => logEvent('window-all-closed', isQuitting ? 'quitting' : 'kept alive'))
// 网络服务（Chromium 用来发所有 fetch 的子进程）死掉之后，主进程还活着、窗口还在，
// 但每一次取数都会失败 —— 界面看着一切正常，点刷新只是静默地什么都拿不到。
// Chromium 本来会自己重拉，可它要是一拉起来就再崩（8/28 22:01 连崩 22 回，
// exitCode -1073741205 = STATUS_STOWED_EXCEPTION），就会彻底放弃，这个进程从此上不了网。
// 这种状态没法就地恢复，只能整体重启，所以这里替用户重启一次。
const startedAt = Date.now()
let netGone = 0      // 一波连崩的次数
let netGoneAt = 0    // 上一次崩的时刻，隔久了就不算同一波
let recovering = false
app.on('child-process-gone', (_event, details) => {
  logEvent('child-process-gone', JSON.stringify(details))
  if (details.serviceName !== 'network.mojom.NetworkService' || recovering) return
  // 关机时 Windows 挨个强杀子进程，网络服务同样会连着「崩」好几次 —— 那不是故障，
  // 而这里的后果比补拉渲染进程严重得多：在关机流程里 relaunch，等于让机器关不干净。
  if (details.reason === 'killed' && details.exitCode === 0x40010004) {
    logEvent('不自救', '网络服务被外部强杀（0x40010004），按系统关机处理')
    return
  }
  // 启动头五分钟不自救：万一这台机器上网络服务一起来就崩，自动重启会变成无限重启循环。
  if (Date.now() - startedAt < 5 * 60 * 1000) return
  const now = Date.now()
  if (now - netGoneAt > 60000) netGone = 0
  netGoneAt = now
  // 偶尔崩一次 Chromium 自己能拉回来，不用惊动用户；连崩三次才是真的救不回来了。
  if (++netGone < 3) return
  recovering = true
  logEvent('relaunch', `网络服务连崩 ${netGone} 次，重启自救`)
  isQuitting = true
  stopTimers()
  app.relaunch()
  app.exit(0)
})
