// poll() 的调度逻辑测试：手动强刷 / 后台轮询 / 连点合并的相互作用。
// 从 main.js 里抠出 poll 的源码原文注入沙箱，pollOnce 换成可控的假实现 ——
// 测的是文件里真正跑的那段代码，不是这里另抄的一份。
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const from = src.indexOf('// force = 手动点了刷新')
const to = src.indexOf('// 渲染进程算好内容高度回传')
if (from < 0 || to < 0) throw new Error('抠不出 poll 那段，main.js 结构变了')
const body = src.slice(from, to)

// 每个场景一份全新的闭包，pollInFlight/forcedInFlight 不互相污染
function mk() {
  const calls = []          // 每次真正调用 pollOnce 时记下它的 force 参数
  let pending = []          // 未结算的 pollOnce
  const pollOnce = (force) => new Promise((res) => {
    calls.push(force)
    pending.push(() => res({ force }))
  })
  const poll = new Function('pollOnce', `
    let pollInFlight = null
    let forcedInFlight = null
    ${body}
    return poll
  `)(pollOnce)
  // 结算当前所有挂起的 pollOnce，然后把微任务队列跑干净
  const settle = async () => {
    const r = pending; pending = []
    r.forEach((f) => f())
    for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res))
  }
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res)) }
  return { poll, calls, settle, tick }
}

let bad = 0
function eq(title, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? '通过' : '失败'}  ${title}`)
  if (!ok) console.log(`        期望 pollOnce 调用序列 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
}

;(async () => {
  // 1. 后台轮询本身要去重：60 秒一轮，重入不该变成两次请求。
  {
    const t = mk()
    t.poll(); t.poll(); t.poll()
    await t.tick()
    eq('后台轮询重入时去重', t.calls, [false])
  }

  // 2. 这次修的核心：手动强刷撞上正在跑的后台轮询时，不能复用它的结果。
  //    后台那轮走的是 Claude 的 5 分钟缓存，直接还回去用户就会看到「点了没反应」。
  {
    const t = mk()
    t.poll()                    // 后台轮询开跑
    await t.tick()
    t.poll(true)                // 用户这时点了刷新
    await t.tick()
    eq('强刷排队期间不抢跑', t.calls, [false])
    await t.settle()            // 后台那轮结束
    eq('后台轮询结束后，强刷真的去问了一次', t.calls, [false, true])
  }

  // 3. 连点几下只打一次上游 —— usage 接口打太勤会吃 429。
  {
    const t = mk()
    t.poll(true); t.poll(true); t.poll(true)
    await t.tick()
    eq('连点刷新合并成一次', t.calls, [true])
  }

  // 4. 上一轮强刷结束后，再点还要能真刷（别把 forcedInFlight 泄漏成永久占用）。
  {
    const t = mk()
    t.poll(true)
    await t.tick()
    await t.settle()
    t.poll(true)
    await t.tick()
    eq('强刷结束后仍可再次强刷', t.calls, [true, true])
  }

  // 5. 强刷正在跑的时候来了后台轮询：复用强刷那轮就行，它拿到的数据更新。
  {
    const t = mk()
    t.poll(true)
    await t.tick()
    t.poll()
    await t.tick()
    eq('后台轮询复用正在跑的强刷', t.calls, [true])
  }

  // 6. 返回值要是能 await 的 promise，且强刷那次拿到的确实是 force=true 那一轮的结果。
  {
    const t = mk()
    const p = t.poll(true)
    await t.tick()
    await t.settle()
    const got = await p
    const ok = got && got.force === true
    if (!ok) bad++
    console.log(`${ok ? '通过' : '失败'}  强刷的返回值是强刷那轮的结果`)
    if (!ok) console.log(`        实得 ${JSON.stringify(got)}`)
  }

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
  process.exit(bad ? 1 : 0)
})()
