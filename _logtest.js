// 日志退路的测试。跟另外三个测试同一套路：把 main.js 里那段源码原文抠出来注入沙箱，
// fs / os / app 全换成假的 —— 测的是文件里真正跑的那段代码，不是这里另抄的一份。
//
// 要保的性质就一条：logEvent 永远不能把调用方带崩，但也永远不能一声不吭。
// 「进程活着但不写盘」那个毛病之所以查不动，就是因为它以前是 catch {} 全吞的。
const realFs = require('fs')
const path = require('path')

const src = realFs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const from = src.indexOf('let logLost = 0')
const to = src.indexOf('function rotateLog()')
if (from < 0 || to < 0) throw new Error('抠不出日志那段，main.js 结构变了')
const body = src.slice(from, to)

const USERDATA = 'C:/fake/quota-sidebar'
const MAIN = path.join(USERDATA, 'quota-sidebar.log')
const TMP = path.join('T:/tmp', 'quota-sidebar-fallback.log')
const DIR = path.join('S:/app', 'quota-sidebar-fallback.log')

const err = (code, p) => Object.assign(new Error(`${code}: ${p}`),
  { code, errno: -4048, syscall: 'open', path: p })

// blocked = 这些路径写不进去；badUserData = app.getPath 自己就抛
function mk({ blocked = [], badUserData = false } = {}) {
  const files = Object.create(null)
  const stop = new Set(blocked)
  const fs = {
    appendFileSync: (p, s) => { if (stop.has(p)) throw err('EACCES', p); files[p] = (files[p] || '') + s },
    statSync: (p) => { if (!(p in files)) throw err('ENOENT', p); return { size: files[p].length } },
    renameSync: (a, b) => { if (!(a in files)) throw err('ENOENT', a); files[b] = files[a]; delete files[a] },
    unlinkSync: (p) => { if (!(p in files)) throw err('ENOENT', p); delete files[p] },
    existsSync: (p) => !stop.has(p),
  }
  const os = { tmpdir: () => 'T:/tmp' }
  const app = { getPath: () => { if (badUserData) throw new Error('userData 没了'); return USERDATA } }
  const stderr = []
  const proc = { pid: 4242, stderr: { write: (s) => stderr.push(s) } }
  const api = new Function('fs', 'os', 'path', 'app', 'process', '__dirname', `
    let logPath
    ${body}
    return { logEvent, lost: () => logLost }
  `)(fs, os, path, app, proc, 'S:/app')
  return { ...api, files, stderr, block: (p) => stop.add(p), unblock: (p) => stop.delete(p) }
}

let bad = 0
function ok(title, cond, extra) {
  if (!cond) { bad++; console.log(`失败  ${title}`); if (extra) console.log(`        ${extra}`) }
  else console.log(`通过  ${title}`)
}

// 1. 一切正常时不该在别处留下任何文件 —— 退路是退路，不是副本。
{
  const t = mk()
  t.logEvent('start', 'pid=1')
  ok('正常时只写主日志，退路一个字节都没有',
    t.files[MAIN].includes('[start] pid=1') && !t.files[TMP] && !t.files[DIR],
    JSON.stringify(Object.keys(t.files)))
}

// 2. 主日志写不进去时，正文必须落到退路上 —— 这是整件事的根本目的。
{
  const t = mk({ blocked: [MAIN] })
  t.logEvent('newapi', '[{"id":5}]')
  ok('主日志写不进去时，正文落到退路', !!t.files[TMP] && t.files[TMP].includes('[newapi] [{"id":5}]'))
  ok('主日志真的没被写出来', !t.files[MAIN])
}

// 3. 首次失败要留下完整现场。少任何一项，下次复发还是只能靠猜。
{
  const t = mk({ blocked: [MAIN] })
  t.logEvent('start', 'x')
  const s = t.files[TMP] || ''
  for (const [what, needle] of [
    ['pid', 'pid      = 4242'],
    ['userData', `userData = ${USERDATA}`],
    ['logPath', `logPath  = ${MAIN}`],
    ['错误码', 'EACCES'],
    ['syscall', 'open'],
    ['errno', 'errno=-4048'],
    ['出错路径', `出错路径 = ${MAIN}`],
  ]) ok(`首次失败的现场带上 ${what}`, s.includes(needle), s)
}

// 4. 现场只打一次，正文条条都在 —— 60 秒一轮，现场刷 N 遍就没法看了。
{
  const t = mk({ blocked: [MAIN] })
  for (let i = 0; i < 5; i++) t.logEvent('poll', 'e' + i)
  const s = t.files[TMP]
  const reports = s.split('主日志写入失败').length - 1
  ok('连续失败只打一次现场', reports === 1, `打了 ${reports} 次`)
  ok('五条正文一条不少', [0, 1, 2, 3, 4].every((i) => s.includes(`[poll] e${i}`)))
  ok('掉线计数累加到 5', t.lost() === 5, String(t.lost()))
}

// 5. 主日志恢复后要补一笔。不然看主日志的人会以为中间那段真的什么都没发生 ——
//    这正是 8/28 那 33 小时空白当时给人的错觉。
{
  const t = mk({ blocked: [MAIN] })
  t.logEvent('poll', 'a'); t.logEvent('poll', 'b')
  t.unblock(MAIN)
  t.logEvent('poll', 'c')
  const s = t.files[MAIN]
  ok('恢复后主日志里补记了丢失条数', s.includes('[log:恢复]') && s.includes('有 2 条写不进来'), s)
  ok('恢复后补记里指明了去哪儿捞正文', s.includes(TMP))
  ok('恢复后计数清零', t.lost() === 0, String(t.lost()))
}

// 6. 恢复之后再坏，要重新打一次现场：第二次的原因可能跟第一次完全不同。
{
  const t = mk({ blocked: [MAIN] })
  t.logEvent('poll', 'a')
  t.unblock(MAIN); t.logEvent('poll', 'b')
  t.block(MAIN); t.logEvent('poll', 'c')
  const reports = t.files[TMP].split('主日志写入失败').length - 1
  ok('恢复后再坏会重新打现场', reports === 2, `打了 ${reports} 次`)
}

// 7. 临时目录也写不进去就退到程序目录。这两条故意选在不同的盘上：
//    那个毛病的表现是 userData 整个写不进去，退到同一棵目录树下等于没退。
{
  const t = mk({ blocked: [MAIN, TMP] })
  t.logEvent('poll', 'z')
  ok('临时目录挂了就退到程序目录', !!t.files[DIR] && t.files[DIR].includes('[poll] z'))
}

// 8. 全都写不进去也不能抛。logEvent 遍布各处，它一抛就会把调用方连坐 ——
//    「记录故障」这件事本身绝不能变成新的故障。
{
  const t = mk({ blocked: [MAIN, TMP, DIR] })
  let threw = null
  try { t.logEvent('poll', 'z') } catch (e) { threw = e }
  ok('三条路全挂也不抛', threw === null, String(threw))
  ok('最后还有 stderr 兜着', t.stderr.length === 1 && t.stderr[0].includes('[poll] z'))
}

// 9. userData 本身取不到时也要活着，而且现场要说清楚是它取不到 ——
//    这一条直接区分「路径解析坏了」和「路径没问题但写不进去」。
{
  const t = mk({ badUserData: true })
  let threw = null
  try { t.logEvent('start', 'x') } catch (e) { threw = e }
  ok('userData 取不到时不抛', threw === null, String(threw))
  ok('现场里写明 userData 取不到', (t.files[TMP] || '').includes('userData = 取不到：userData 没了'), t.files[TMP])
}

// 10. 主日志一直坏下去的话退路文件会一直长，得有个上限，别把盘吃了。
{
  const t = mk({ blocked: [MAIN] })
  t.files[TMP] = 'x'.repeat(5 * 1024 * 1024)
  t.logEvent('poll', 'z')
  ok('退路超过 4MB 会轮转', t.files[TMP + '.1'] && t.files[TMP].includes('[poll] z') &&
    t.files[TMP].length < 1000, `新文件 ${(t.files[TMP] || '').length} 字节`)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
