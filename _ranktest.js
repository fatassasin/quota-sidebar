// 排序规则的状态机测试。不 require('./sources')：那会拉起 better-sqlite3（按 Electron ABI
// 编译，普通 node 加载不了）。改成把 claudeRank 那段源码原文抠出来注入沙箱 ——
// 测的是文件里真正跑的那段代码，不是这里另抄的一份。
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, 'sources.js'), 'utf8')
const from = src.indexOf('const FULL = 100')
const to = src.indexOf('// 满额自动禁用')
if (from < 0 || to < 0) throw new Error('抠不出 claudeRank 那段，sources.js 结构变了')
const claudeRank = new Function(src.slice(from, to) + '\nreturn claudeRank')()

const NOW = Date.parse('2026-09-01T02:14:00+08:00')
Date.now = () => NOW
const at = (m) => new Date(NOW + m * 60000).toISOString()
const hour = (n) => n * 60
const day = (n) => n * 1440

const acc = (name, w5, wk) => ({
  id: 'claude:' + name, name, $channelId: name,
  windows: [
    w5 && { label: '5小时', percent: w5[0], resetsAt: w5[1] },
    wk && { label: '周', percent: wk[0], resetsAt: wk[1] },
  ].filter(Boolean),
})
const COLD = [0, null] // 窗口没在计时，面板上显示 0%

let bad = 0
function check(title, accounts, expect) {
  const r = claudeRank(accounts)
  const got = r.map((x) => x.a.name)
  const ok = JSON.stringify(got) === JSON.stringify(expect)
  if (!ok) bad++
  console.log(`${ok ? '通过' : '失败'}  ${title}`)
  for (const x of r) {
    const d = x.due === Infinity ? '无截止' : (x.due / 3600000).toFixed(1) + 'h 后重置'
    const l = x.lead === Infinity ? '无配速' : (x.lead >= 0 ? '+' : '') + x.lead.toFixed(1)
    console.log(`        ${x.a.name.padEnd(14)} 档${x.tier}  配速档 ${String(x.band).padStart(3)}` +
      `  超前 ${l.padStart(6)}  ${d}`)
  }
  if (!ok) console.log(`        期望 ${expect.join(' > ')}，实得 ${got.join(' > ')}`)
  console.log()
  return r
}

// 1. 用户报的这一例，数字取自 2026-09-01 02:14 的实测。
//    纯 EDF 会把 Claude1 排第一（它 77.8 小时后就重置，是三个里最近的）—— 正是这一点
//    把它从 5% 一路喂到了 88%，而另外两个躺在 11% 和 32%。配速分档必须把它压到最后。
check('真实故障场景：超速最多的要垫底，落后最多的要第一', [
  acc('Claude1', [60, at(hour(3))], [88, at(hour(77.8))]),   // 超前 +34.3 → 档 +3
  acc('Claude2', COLD, [11, at(hour(131.8))]),               // 落后 -10.6 → 档 -2
  acc('Claude3', COLD, [32, at(hour(101.8))]),               // 落后  -7.4 → 档 -1
], ['Claude2', 'Claude3', 'Claude1'])

// 2. 上一轮那个 bug 的数据回测：换成配速分档后，当时要的结果依然成立。
//    B 号落后进度进了 -1 档拿第一；另外两个同在 0 档，档内按 EDF 分先后。
check('回测上一轮的故障数据', [
  acc('A', [43, at(16)], [65, at(3586)]),
  acc('B', COLD, [93, at(346)]),
  acc('C', [37, at(116)], [84, at(1786)]),
], ['B', 'C', 'A'])

// 3. 这次改动的核心承诺之一：同档内不因为烧额度而换人，换人只发生在跨档的那一刻。
//    带宽 10 个点 = 恰好一个 5 小时窗口，所以领先者至少能服务一个窗口再交班。
{
  const mk = (pa) => [
    acc('A-先重置', [30, at(150)], [pa, at(day(3))]),   // 基准线 57.1%
    acc('B-后重置', [30, at(150)], [43, at(day(4))]),   // 基准线 42.9%，超前 +0.1 → 档 0
  ]
  check('轮换 1/3：同档内按 EDF，A 拿第一', mk(58), ['A-先重置', 'B-后重置'])       // +0.9 → 档 0
  check('轮换 2/3：A 连烧 9 个点仍不换人', mk(67), ['A-先重置', 'B-后重置'])        // +9.9 → 档 0
  check('轮换 3/3：A 跨进下一档，交班给 B', mk(68), ['B-后重置', 'A-先重置'])       // +10.9 → 档 1
}

// 4. 另一个核心承诺：需求超过供给、三个号全部越过基准线时，退化成纯 EDF ——
//    那时候「谁的额度会作废」才重新变成真问题，正是 EDF 该管的事。
check('全员超速时退化成纯 EDF', [
  acc('远期', [30, at(150)], [35, at(hour(120))]),  // 基准线 28.6%，超前 +6.4 → 档 0
  acc('近期', [30, at(150)], [90, at(hour(24))]),   // 基准线 85.7%，超前 +4.3 → 档 0
  acc('中期', [30, at(150)], [62, at(hour(72))]),   // 基准线 57.1%，超前 +4.9 → 档 0
], ['近期', '中期', '远期'])

// 5. 冷号不因为「5 小时显示 0%」被降档 —— 那是窗口没在计时，不是没额度了。
check('冷号按满血算，照样能当第一', [
  acc('冷号落后多', COLD, [50, at(hour(6))]),      // 基准线 96.4%，落后 -46.4 → 档 -5
  acc('活跃落后少', [40, at(120)], [50, at(day(3))]), // 基准线 57.1%，落后 -7.1 → 档 -1
], ['冷号落后多', '活跃落后少'])

// 6. 5 小时快见底时要降档：配速档再靠前也没用，这一轮它确实供不动。
//    档位压在配速之上，这条边界不能被新规则冲掉。
check('5 小时快见底的降档压过配速', [
  acc('五时见底', [97, at(200)], [10, at(hour(2))]),  // 落后 -88 → 档 -9，但 5 小时只剩 3%
  acc('正常', [40, at(120)], [50, at(day(5))]),
], ['正常', '五时见底'])

// 7. 任一窗口烧满就垫底，周窗口烧满也算。
check('烧满的垫底', [
  acc('周烧满', [10, at(200)], [100, at(day(2))]),
  acc('五时烧满', [100, at(60)], [10, at(hour(3))]),
  acc('正常', [50, at(100)], [50, at(day(6))]),
], ['正常', '五时烧满', '周烧满'])

// 8. 没有周额度数据的排最后：算不出配速，就没有理由说它该多用。
//    两个都没有时也不能崩 —— band 和 due 都是 Infinity，相减会得 NaN，
//    所以比较函数里这两级用的是 cmp 不是减法。
check('缺周数据排最后，且两个都缺时不崩', [
  acc('无周数据A', [30, at(150)], null),
  acc('无周数据B', [30, at(150)], null),
  acc('有周数据', [30, at(150)], [50, at(day(6))]),
], ['有周数据', '无周数据A', '无周数据B'])

// 9. 同档、同重置时刻，最后一级才轮到余额：待浪费的更多的先用。
check('同档同重置时，余额多的先用', [
  acc('余额少', [30, at(150)], [79, at(day(2))]),  // 基准线 71.4%，超前 +7.6 → 档 0
  acc('余额多', [30, at(150)], [75, at(day(2))]),  // 基准线 71.4%，超前 +3.6 → 档 0
], ['余额多', '余额少'])

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
