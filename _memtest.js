// 心跳里那行内存文字的测试。跟另外几个测试同一套路：把 main.js 里的源码原文抠出来
// 注入沙箱，测的是文件里真正在跑的那段。
//
// 为什么值得单独测：2026-09-02 查「三个应用同时无反应」时，物理内存明明还剩 15GB，
// 真正见底的是提交内存（83.5/88.9GB）。这行字要是把两者算混了，下次复发照样看不出来 ——
// 我第一版就把 swapTotal 当成页面文件跟物理内存相加，算出个 152GB 的上限，全错。
const realFs = require('fs')
const path = require('path')

const src = realFs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const from = src.indexOf('const GB = (kb)')
const to = src.indexOf('function logAlive()')
if (from < 0 || to < 0) throw new Error('抠不出 memText，main.js 结构变了')
const body = src.slice(from, to)

// info = getSystemMemoryInfo 返回什么；throws = 这个接口直接抛（老版本 Electron / 非常规平台）
function mk({ info, throws = false } = {}) {
  const proc = { getSystemMemoryInfo: () => { if (throws) throw new Error('没这接口'); return info } }
  // os 给的是固定值，兜底那行才有确定的期望输出：32GB 总量、8GB 可用
  const os = { freemem: () => 8 * 1073741824, totalmem: () => 32 * 1073741824 }
  return new Function('process', 'os', `${body}\nreturn memText`)(proc, os)
}

let bad = 0
function ok(title, cond, extra) {
  if (!cond) { bad++; console.log(`失败  ${title}`); if (extra) console.log(`        ${extra}`) }
  else console.log(`通过  ${title}`)
}

// 1. 真实现场的数字。这四个值是 2026-09-02 从这台机器上原样抄下来的，同一时刻
//    Get-Counter 报 committed 83.45GB / limit 88.94GB / available 14.85GB。
//    换算对不上就是算错了。
{
  const t = mk({ info: { total: 66872772, free: 15557632, swapTotal: 93255480, swapFree: 5741392 } })
  const s = t()
  ok('提交上限算成 88.9GB（不是 152.7GB）', s.includes('/88.9GB'), s)
  ok('提交已用算成 83.5GB', s.includes('提交 83.5/'), s)
  ok('提交剩余算成 5.5GB', s.includes('(余 5.5)'), s)
  ok('物理余额单独列出 14.8/63.8GB', s.includes('物理余 14.8/63.8GB'), s)
}

// 2. 见底的时候这行字必须一眼看得出来 —— 这正是那次故障的样子：
//    物理内存看着很宽裕，提交内存已经贴着墙了。
{
  const t = mk({ info: { total: 66872772, free: 20971520, swapTotal: 93255480, swapFree: 209715 } })
  const s = t()
  ok('提交见底时余额显示 0.2GB', s.includes('(余 0.2)'), s)
  ok('同一行里物理内存仍显示 20.0GB（两者不能混为一谈）', s.includes('物理余 20.0/'), s)
}

// 3. 拿不到提交量时退回只报物理内存，不能瞎编一个提交数出来。
{
  const t = mk({ info: { total: 66872772, free: 15557632, swapTotal: 0, swapFree: 0 } })
  const s = t()
  ok('没有提交量时不打印「提交」二字', !s.includes('提交'), s)
  ok('没有提交量时仍报物理内存', s.includes('物理余 14.8/63.8GB'), s)
}

// 4. 接口本身抛了也得出一行字。心跳是「进程还活着」的唯一证据，
//    绝不能因为取不到内存数就把整条心跳带没了。
{
  const t = mk({ throws: true })
  let threw = null, s = null
  try { s = t() } catch (e) { threw = e }
  ok('接口抛异常时 memText 不抛', threw === null, String(threw))
  ok('抛异常时退回 os 的物理内存', s === '物理余 8.0/32.0GB', s)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
