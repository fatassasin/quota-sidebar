// 网络服务崩溃自救的测试。跟另外两个测试同一套路：把 main.js 里那段源码原文抠出来
// 注入沙箱，app / logEvent / stopTimers 全换成假的 —— 测的是文件里真正跑的那段代码。
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const from = src.indexOf('// 网络服务（Chromium 用来发所有 fetch 的子进程）')
if (from < 0) throw new Error('抠不出崩溃自救那段，main.js 结构变了')
const body = src.slice(from)

const NET = { type: 'Utility', reason: 'crashed', exitCode: -1073741205, serviceName: 'network.mojom.NetworkService', name: 'Network Service' }
const GPU = { type: 'GPU', reason: 'crashed', exitCode: -1, serviceName: undefined, name: 'GPU' }

// 每个场景一份全新的闭包。now 可控，好把「启动五分钟内」和「隔了一分钟」这两条演出来。
function mk(startNow = 0) {
  const out = { relaunched: 0, exited: 0, log: [] }
  let now = startNow
  let handler = null
  const app = {
    on: (_evt, fn) => { handler = fn },
    relaunch: () => out.relaunched++,
    exit: () => out.exited++,
  }
  const logEvent = (kind, detail) => out.log.push(kind)
  const stopTimers = () => {}
  new Function('app', 'logEvent', 'stopTimers', 'Date', `
    let isQuitting = false
    ${body}
  `)(app, logEvent, stopTimers, { now: () => now })
  return {
    out,
    at: (t) => { now = t },              // 把时钟拨到某一刻（毫秒）
    gone: (d = NET) => handler(null, d), // 来一次子进程死亡
  }
}

const MIN = 60000
let bad = 0
function eq(title, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? '通过' : '失败'}  ${title}`)
  if (!ok) console.log(`        期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
}

// 1. 8/28 那次的原样重放：连崩一片，必须重启自救。
{
  const t = mk(0)
  t.at(60 * MIN)                       // 已经跑了一小时，过了启动保护期
  for (let i = 0; i < 22; i++) t.gone()
  eq('连崩一片时重启自救', [t.out.relaunched, t.out.exited], [1, 1])
}

// 2. 偶尔崩一两次 Chromium 自己能拉回来，不该惊动用户。
{
  const t = mk(0)
  t.at(60 * MIN)
  t.gone(); t.gone()
  eq('只崩两次不重启', [t.out.relaunched, t.out.exited], [0, 0])
}

// 3. 启动头五分钟不自救 —— 否则这机器上要是网络服务一起来就崩，会变成无限重启循环。
{
  const t = mk(0)
  t.at(2 * MIN)
  for (let i = 0; i < 22; i++) t.gone()
  eq('启动保护期内不自救（防重启循环）', [t.out.relaunched, t.out.exited], [0, 0])
}

// 4. 隔得很开的零星崩溃不算同一波，计数要清零。
{
  const t = mk(0)
  t.at(60 * MIN); t.gone()
  t.at(120 * MIN); t.gone()
  t.at(180 * MIN); t.gone()
  eq('隔一小时崩一次不累计成自救', [t.out.relaunched, t.out.exited], [0, 0])
}

// 5. 别的子进程（GPU 之类）死掉不管：那个崩了不影响取数，Chromium 自己会处理。
{
  const t = mk(0)
  t.at(60 * MIN)
  for (let i = 0; i < 22; i++) t.gone(GPU)
  eq('GPU 进程崩溃不触发重启', [t.out.relaunched, t.out.exited], [0, 0])
}

// 6. 自救只做一次：exit 之后还在排队的崩溃事件不该再触发第二轮。
{
  const t = mk(0)
  t.at(60 * MIN)
  for (let i = 0; i < 50; i++) t.gone()
  eq('自救只执行一次', [t.out.relaunched, t.out.exited], [1, 1])
}

// 7. 每次崩溃都要落日志 —— 排查全靠它，别为了自救把记录吞了。
{
  const t = mk(0)
  t.at(60 * MIN)
  t.gone(); t.gone(); t.gone()
  eq('三次崩溃都记了日志，外加一条 relaunch',
    t.out.log, ['child-process-gone', 'child-process-gone', 'child-process-gone', 'relaunch'])
}

// --- 关机守卫 ---------------------------------------------------------------
// 2026-09-02 补的。原来这段自救建立在一个误判上：以为 8/28 那次是网络服务自己崩了，
// 其实是 GameViewer 每天清晨发起的系统关机 —— 关机时 Windows 挨个强杀子进程，
// 网络服务必然连着「崩」好几次。也就是说这段代码本来每天关机都会被触发一次，
// 在关机流程里 relaunch，等于让机器关不干净。
const KILLED = { type: 'Utility', reason: 'killed', exitCode: 0x40010004, serviceName: 'network.mojom.NetworkService', name: 'Network Service' }

// 8. 关机时被强杀，崩多少次都不能自救。这是整个守卫的目的。
{
  const t = mk(0)
  t.at(60 * MIN)
  for (let i = 0; i < 22; i++) t.gone(KILLED)
  eq('关机强杀（0x40010004）不触发重启', [t.out.relaunched, t.out.exited], [0, 0])
}

// 9. 不自救也要留痕，否则日志里只剩一串 child-process-gone，下次又得重新判一遍它是不是关机。
{
  const t = mk(0)
  t.at(60 * MIN)
  t.gone(KILLED)
  eq('识别为关机时记一条「不自救」', t.out.log, ['child-process-gone', '不自救'])
}

// 10. 守卫不能放得太宽：同样的退出码，但 reason 是 crashed 而不是 killed，
//     那就是真的崩了（关机杀进程给的一定是 killed），照旧自救。
{
  const t = mk(0)
  t.at(60 * MIN)
  for (let i = 0; i < 5; i++) t.gone({ ...KILLED, reason: 'crashed' })
  eq('同样退出码但 reason=crashed 仍然自救', [t.out.relaunched, t.out.exited], [1, 1])
}

// 11. 反过来也不能放宽：reason 是 killed 但退出码不是关机那个，说明是别的东西
//     （比如用户手动 taskkill、杀软干预）把它杀了，那仍然要自救。
{
  const t = mk(0)
  t.at(60 * MIN)
  for (let i = 0; i < 5; i++) t.gone({ ...KILLED, exitCode: -1073741205 })
  eq('killed 但退出码不是 0x40010004 仍然自救', [t.out.relaunched, t.out.exited], [1, 1])
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
