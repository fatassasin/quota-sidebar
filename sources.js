// 四个额度源。每个函数自己 try/catch，返回统一形状，一家挂了不影响其余。
// 形状: {id, name, plan, windows:[{label, percent, resetsAt}], extra?, stale?, error?}
const Database = require('better-sqlite3')

// 三个数据源的位置，由用户在设置抽屉最底部的「配置渠道」里填，主进程启动时和每次改配置后
// 调 configure() 灌进来。默认全空 —— 这里不能写死任何人的实际路径。
//
// 只有 newapi 是必填，因为四个源里有两个光靠它就够了：Cline 和 Opencode 的渠道 base_url
// 直接指向上游（api.cline.bot / opencode.ai），New API 的渠道表里存的就是上游真 key，
// 拿着它能直接问上游要真实额度。
// Claude 和 Codex 不行：它们的 base_url 指向本机代理（gproxy:8787 / codex2api:9000），
// New API 里存的只是代理的门票，打不了 api.anthropic.com 的额度接口 —— 真凭证在代理
// 自己的库里。所以这两个各要多填一项，不填就只是少两张卡片，其余照常工作。
const DB = { newapi: '', gproxy: '', codex: '' }

// 报错要说人话：这行字会原样显示在卡片上，得让人知道缺的是哪一项、该去哪儿填。
// 整句都放进来，别在下面拼 —— 三家的说法不一样，拼出来的中文会磕磕绊绊。
const NEED = {
  newapi: '还没填 New API 的数据库位置',
  gproxy: 'Claude 还没填 gproxy 的数据库位置',
  codex: 'Codex 还没填 codex2api 的数据库位置',
}

function configure(paths = {}) {
  for (const k of Object.keys(DB)) {
    if (typeof paths[k] === 'string') DB[k] = paths[k].trim()
  }
  return { ...DB }
}

// 没配就别去开一个空路径 —— better-sqlite3 对空字符串给的是 'unable to open database file'，
// 看到那句话没人猜得到是漏填了配置。
function dbPath(key) {
  if (!DB[key]) throw new Error(`${NEED[key]}（设置 → 最底部「配置渠道」）`)
  return DB[key]
}

// ponytail: 每次开关 DB，避免跨进程 WAL。写路径（切渠道禁用）也用同一套。
function readDb(key, fn) {
  const db = new Database(dbPath(key), { readonly: true, fileMustExist: true })
  try { return fn(db) } finally { db.close() }
}
function writeDb(key, fn) {
  const db = new Database(dbPath(key), { fileMustExist: true })
  try { return fn(db) } finally { db.close() }
}

// 翻转 NewAPI 渠道禁用状态（1=启用，2=禁用）。同步回 NewAPI 渠道管理。
// abilities 必须跟着写，否则点了按钮只是把后台那个开关拨了一下，流量照旧 —— 详见下面 syncNewApi 的注释。
function toggleChannel(id) {
  return writeDb('newapi', (db) => {
    const cur = db.prepare('select status from channels where id=?').get(id)
    if (!cur) throw new Error('找不到渠道 ' + id)
    const next = cur.status === 1 ? 2 : 1
    db.prepare('update channels set status=? where id=?').run(next, id)
    db.prepare('update abilities set enabled=? where channel_id=?').run(next === 1 ? 1 : 0, id)
    return next
  })
}

// --- NewAPI 渠道联动 --------------------------------------------------------
// 选路读的是 abilities 表（group × model × channel 的展开副本，自带 enabled/priority），
// 不是 channels 表。只写 channels，后台 UI 会显示新值而流量分毫不动 —— 后台自己的接口
// 是两张一起写的，所以这里也必须两张一起写。
// 这不是假设：channel 5 就是这么黑掉的。有人在后台点了禁用（两张表一起关），随后旧版
// autoManage 判断它没满额、执行“恢复启用”，只把 channels.status 写回 1，abilities 全留在 0。
// 后台显示已启用，路由层却再也不给它一条请求，而且永远自己好不了。
const FULL = 100
// 5 小时余量低于这个数，就认为这一轮供不了多少，降一档。冷号不受影响（它是满血的）。
const LOW_ROOM = 5
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// 配速带宽。周额度正好是 5 小时限额的十倍，所以 10 个百分点 = 恰好一个 5 小时窗口。
// 两个号的配速差不到一个窗口的量就算打平，先后交给 EDF —— 这个数就是均衡和抖动的分界线：
// 调小了换号更勤（prompt cache 全失效，反而更费额度），调大了均衡得更慢。
const BAND = 10

const isClaude = (a) => /^claude:/.test(String(a.id))
const fiveHour = (a) => (a.windows || []).find((w) => /5\s*小时/.test(w.label))
const weekly = (a) => (a.windows || []).find((w) => /^周/.test(w.label))

const pct = (n) => Math.round(n)
const human = (ms) => {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m} 分钟`
  if (m < 1440) return `${(m / 60).toFixed(1)} 小时`
  return `${(m / 1440).toFixed(1)} 天`
}
// Infinity - Infinity 是 NaN，会让比较函数失去传递性、排出自相矛盾的结果，所以不能写成减法。
const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

// 排序规则：谁落后匀速进度最多，谁先用（配速分档），同档之间谁先重置谁先用（EDF）。
//
// 配速怎么算：周额度按 100%/7 天匀速烧，此刻「本该」用到 14.3 × 已过天数。
//   超前 = 实际已用% − 该用%。负数 = 烧得慢、还有富余，该多分点流量；正数 = 烧太快，该缓一缓。
//
// 为什么不是纯 EDF：EDF（只按重置先后排）的正确性前提是「需求 > 供给」—— 那时候「谁的额度
// 会过期作废」才是真问题。但三个号一周供 300 点、实际远用不完，供大于求，总浪费量只由需求
// 决定、跟先烧谁无关，EDF 那个目标是空转的。而它的副作用是实打实的亏：周窗口开得最早的号
// 重置时刻永远最近，会被死死锁在第一名一路喂到 100%。实测就是这么坏的 —— Claude1 的窗口
// 8/28 开始、比另外两个都早，被连喂三天到 88%，另外两个躺在 11% 和 32% 没动。一个号躺平在
// 满额的时候，它那份 5 小时窗口的吞吐就白白蒸发了，而 5 小时才是真正的限速器。
//
// 为什么要分档、而不是直接按超前值排：直接排就是上一版的「宽裕度」，会抖。
//   超前 = 已用% − 100×(一周−剩余)/一周 = −(周余量% − 剩余时间占比%) = −宽裕度，
// 两者顺序完全一样。它抖是因为分数随烧额度连续漂移，两个号一交叉就换第一名；而 percent 是
// 整数，一个点 ≈ 半小时重度使用，分数拉平之后会变成每半小时换一次号。当时拿 HOLD = 2 的
// 死区去压，那是在连续分数上挖坑打补丁。分档是让分数本身在物理上有意义的粒度上离散化：
// 轮换周期变成「烧掉一个 5 小时窗口才换一次」，正好是一个号服务一个窗口然后交班。
//
// 而且它在 EDF 真正管用的时候会自己退化成 EDF：需求一旦超过供给，三个号会全部越过基准线、
// 挤进同一个高档，档内排序接管，行为就是纯 EDF —— 只有「谁的额度会作废」变成真问题的时候，
// EDF 才回来当家。
//
// 5 小时窗口仍然只当限速器，不参与排序：五个小时不碰某个号，它的周计数器纹丝不动，
// 什么都没少。它只用来判「现在还供不供得动」，也就是档位。
function claudeRank(accounts) {
  const now = Date.now()
  const burnt = (w) => w && w.percent >= FULL &&
    (!w.resetsAt || new Date(w.resetsAt).getTime() > now)
  return accounts.filter((a) => isClaude(a) && a.$channelId != null && !a.error).map((a) => {
    const w5 = fiveHour(a), wk = weekly(a)
    // 冷号按满血算：用它就是新点着一个满额窗口，供给能力反而是最强的。
    // 5 小时显示 0% 正是「窗口没在计时」的表现，不该因此降档。
    const live5 = !!w5 && !!w5.resetsAt && new Date(w5.resetsAt).getTime() > now
    const room5 = live5 ? Math.max(0, FULL - w5.percent) : FULL
    // 0 供得动　1 5 小时快见底，这一轮供不了多少　2 任一窗口烧满（同时会被下面的硬开关禁用）
    const tier = burnt(w5) || burnt(wk) ? 2 : room5 < LOW_ROOM ? 1 : 0
    // 距周重置还有多久。没有重置时间就当无限远排最后 —— 不知道截止时间，就没有理由说它紧迫。
    const left = wk && wk.resetsAt ? new Date(wk.resetsAt).getTime() - now : NaN
    const due = left > 0 ? left : Infinity
    const room = wk ? Math.max(0, FULL - wk.percent) : 0
    // 已过时间夹在 [0, 一周] 内：上游偶尔会给出超过一周的重置时间，不夹的话基准线会算成负的。
    const elapsed = Math.min(WEEK_MS, Math.max(0, WEEK_MS - due))
    const budget = (elapsed / WEEK_MS) * FULL
    // 没有周数据的一律当 Infinity 排最后：不知道配速，也就没有理由说它该多用。
    const lead = due === Infinity ? Infinity : wk.percent - budget
    const band = lead === Infinity ? Infinity : Math.floor(lead / BAND)
    const pace = lead === Infinity ? '没有周额度数据'
      : `${lead >= 0 ? '超前' : '落后'}进度 ${pct(Math.abs(lead))} 点（该用 ${pct(budget)}%，实用 ${wk.percent}%）`
    const why = tier === 2 ? `${burnt(w5) ? '5 小时' : '周'}额度已烧满，等重置`
      : tier === 1 ? `5 小时只剩 ${pct(room5)}% 余量，这一轮供不了多少`
        : pace + (due === Infinity ? '' : ` · 周额度 ${human(due)}后重置，还剩 ${pct(room)}% 没花`) +
          ` · 5小时余 ${pct(room5)}%${live5 ? '' : '（冷号，满血）'}`
    return { a, tier, why, due, room, room5, lead, band }
    // 档位优先（供不动的排后面），再按配速档从落后到超前，同档按重置时间从近到远，
    // 同样近的先给余额多的 —— 它待浪费的更多。band/due 都可能是 Infinity，
    // 相减会得 NaN、让比较函数失去传递性，所以这两级必须用三路比较而不是减法。
  }).sort((x, y) => x.tier - y.tier || cmp(x.band, y.band) || cmp(x.due, y.due) || y.room - x.room)
}

// 满额自动禁用、重置后自动启用，外加按配速给渠道排优先级。
// 会就地给 account 挂上 $rank/$rankWhy，面板靠它显示名次。
function syncNewApi(accounts, { priority = true } = {}) {
  const managed = accounts.filter((a) => a.$channelId != null && !a.error)
  if (!managed.length) return []

  // 想要的启用状态：任一窗口满额且还没到重置时间 → 关，否则开。
  const want = new Map()
  for (const a of managed) {
    const blocking = (a.windows || []).filter((w) => w.percent >= FULL)
      .filter((w) => !w.resetsAt || new Date(w.resetsAt).getTime() > Date.now())
    want.set(a.$channelId, blocking.length ? 2 : 1)
  }

  const ranked = claudeRank(accounts)
  ranked.forEach((r, i) => { r.a.$rank = i + 1; r.a.$rankWhy = r.why })
  // 三个号同时烧穿时别把最后一个也关掉：留一个开着让请求撞 429，也好过 New API 报
  // “没有可用渠道” —— 后者看着像配置坏了，而且窗口一重置这个号就能自己恢复。
  if (ranked.length && ranked.every((r) => want.get(r.a.$channelId) === 2)) {
    want.set(ranked[0].a.$channelId, 1)
  }
  // 名次转优先级。选路先取 MAX(priority) 再在并列最高里加权随机，所以只比大小、
  // 不看差值 —— 给整十的档位就够，差 1 和差 100 效果一样。第二三名只在 RetryTimes>0
  // 时作为故障回退档生效（这台机器上是 3，生效）。
  const wantPrio = new Map(ranked.map((r, i) => [r.a.$channelId, (ranked.length - i) * 10]))

  const touched = []
  writeDb('newapi', (db) => {
    const chan = db.prepare('select status, priority from channels where id=?')
    const offCount = db.prepare('select count(*) n from abilities where channel_id=? and enabled=0')
    const prioOff = db.prepare('select count(*) n from abilities where channel_id=? and priority<>?')
    const setStatus = db.prepare('update channels set status=? where id=?')
    const setEnabled = db.prepare('update abilities set enabled=? where channel_id=?')
    const setChanPrio = db.prepare('update channels set priority=? where id=?')
    const setAbilPrio = db.prepare('update abilities set priority=? where channel_id=?')

    for (const [id, status] of want) {
      const cur = chan.get(id)
      if (!cur) continue
      const on = status === 1
      // 两张表分开判：channels 对得上不代表流量通了，abilities 才是路由看的那张。
      const abilitiesOn = offCount.get(id).n === 0
      if (cur.status === status && abilitiesOn === on) continue
      if (cur.status !== status) setStatus.run(status, id)
      setEnabled.run(on ? 1 : 0, id)
      touched.push({ id, to: status, repaired: cur.status === status })
    }

    if (!priority) return
    for (const [id, p] of wantPrio) {
      const cur = chan.get(id)
      if (!cur) continue
      if (cur.priority === p && prioOff.get(id, p).n === 0) continue
      setChanPrio.run(p, id)
      setAbilPrio.run(p, id)
      touched.push({ id, priority: p })
    }
  })
  return touched
}

const j = (s) => { try { return JSON.parse(s) } catch { return null } }

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`)
  return r.json()
}

// --- Claude: gproxy 持有 OAuth token (scopes 含 user:profile)，拿它问 Anthropic 要真实额度 ---
// ponytail: usage 接口不是给 60s 轮询用的，打太勤会吃 429。5 分钟内直接复用上次成功结果。
// 但手动点刷新必须绕开它（force）：轮询 60 秒一轮、缓存 5 分钟，等于五次里有四次点了没反应。
const CLAUDE_TTL = 5 * 60 * 1000
const claudeCache = {} // id -> 上次成功的额度
// 刚发过热身消息的账号：下一轮必须真去问一次，否则新点着的窗口要等缓存过期才看得见
const claudeForce = new Set()
async function claudeOne(row, snapshot = null, force = false) {
  const id = `claude:${row.id}`
  const out = { id, $channelId: row.channel_id, name: row.name || 'Claude Code', plan: 'pro', windows: [], disabled: row.channel_status != null && row.channel_status !== 1 }
  // delete 要无条件先跑掉，否则热身标记会留到下一轮；|| 的短路顺序保证了这点。
  const forced = claudeForce.delete(id) || force
  const fresh = claudeCache[id] || snapshot
  if (!forced && fresh?.windows?.length && Date.now() - (fresh.savedAt || 0) < CLAUDE_TTL) {
    return { ...out, name: fresh.name || out.name, windows: fresh.windows.map((w) => ({ ...w })), extra: fresh.extra }
  }
  try {
    const cred = j(row.secret_json)
    if (!cred?.access_token) throw new Error('凭证里没有 access_token')
    out.name = cred.user_email || row.name || out.name
    if (row.health_kind && row.health_kind !== 'healthy') out.health = row.health_kind

    // User-Agent 必须伪装成 claude-code，否则落进严格限流桶吃 429
    const u = await getJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${cred.access_token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.197',
    })
    // utilization 是 0-100，不是 0-1
    for (const [key, label] of [['five_hour', '5小时'], ['seven_day', '周']]) {
      if (u[key]) out.windows.push({ label, percent: u[key].utilization, resetsAt: u[key].resets_at })
    }
    if (u.extra_usage?.is_enabled) out.extra = `额外用量 ${u.extra_usage.utilization ?? 0}%`
    claudeCache[id] = { ...out, windows: out.windows.map((w) => ({ ...w })), savedAt: Date.now() }
    out.$snapshot = { windows: out.windows.map((w) => ({ ...w })), extra: out.extra, name: out.name, savedAt: claudeCache[id].savedAt }
  } catch (e) {
    // 429 是临时限流：沿用最后一次成功额度，不清空卡片。
    const message = String(e.message || e)
    if (/429|rate\s*limit/i.test(message)) {
      const cached = claudeCache[id] || snapshot
      if (cached?.windows?.length) {
        return {
          ...out,
          windows: cached.windows.map((w) => ({ ...w })),
          extra: cached.extra,
          stale: `上游限流，显示 ${cached.savedAt ? new Date(cached.savedAt).toLocaleString('zh-CN') : '上次'} 的额度`,
        }
      }
      out.error = 'Anthropic 上游限流，暂无可用额度缓存'
    } else out.error = message
  }
  return out
}

async function claude(snapshots = {}, force = false) {
  let rows
  try {
    // credential_statuses 是一对多（gproxy 每次健康检查可能追加一行），直接 join 会把
    // 一个凭证扇出成多张卡片。改成相关子查询只取最新一条状态，保证一凭证一行。
    rows = readDb('gproxy', (db) => db.prepare(`
      select c.id, c.secret_json, c.name, c.provider_id,
             (select s.health_kind from credential_statuses s
               where s.credential_id = c.id
               order by s.updated_at desc, s.id desc
               limit 1) as health_kind
      from credentials c
      where c.provider_id in (select id from providers where channel='claudecode')
        and c.enabled = 1
      order by c.id`).all())
    // provider_id → NewAPI 渠道。以前是手写的 {1:'Claude-A', 7:'Claude-B'}，
    // 加第三个号的时候没人记得改它，Claude-C 就一直没被关联上（禁用/排优先级全都管不到）。
    // 真正的绑定关系写在渠道的 base_url 里：http://127.0.0.1:8787/<provider 名>，
    // 照它来认，以后加号自动生效。
    const providers = readDb('gproxy', (db) => db.prepare(
      "select id, name from providers where channel='claudecode'").all())
    const channels = readDb('newapi', (db) => db.prepare(
      'select id, name, status, base_url from channels').all())
    const tail = (u) => String(u || '').replace(/\/+$/, '').split('/').pop()
    const byProvider = new Map()
    for (const p of providers) {
      const ch = channels.find((x) => tail(x.base_url) === p.name) || channels.find((x) => x.name === p.name)
      if (ch) byProvider.set(p.id, ch)
    }
    for (const row of rows) {
      const ch = byProvider.get(row.provider_id)
      if (ch) { row.channel_id = ch.id; row.channel_status = ch.status }
    }
  } catch (e) {
    return [{ id: 'claude', name: 'Claude Code', windows: [], error: String(e.message || e) }]
  }
  if (!rows.length) return [{ id: 'claude', name: 'Claude Code', windows: [], error: 'gproxy 里没有启用的 claudecode 凭证' }]
  return Promise.all(rows.map((r) => claudeOne(r, snapshots[`claude:${r.id}`], force)))
}

// --- Codex: codex2api 每次转发都会写回服务端返回的额度，直接读，别自己调 OpenAI ---
async function codex() {
  const out = { id: 'codex', name: 'Codex', plan: '', windows: [] }
  try {
    const rows = readDb('codex', (db) => db.prepare(`
      select name, credentials from accounts
      where platform='openai' and status='active' and enabled=1`).all())
    const acc = rows.map((r) => ({ name: r.name, c: j(r.credentials) }))
      .filter((a) => a.c?.codex_usage_updated_at)
      // 多账号时取额度信息最新的那个
      .sort((a, b) => (a.c.codex_usage_updated_at < b.c.codex_usage_updated_at ? 1 : -1))[0]
    if (!acc) throw new Error('codex2api 里没有带额度信息的活跃账号')

    out.name = acc.name || out.name
    out.plan = acc.c.plan_type || ''
    // 5h 限额取消过一段时间，2026-08 又回来了。顺序跟 Claude 卡片一致：5 小时在前，周在后。
    // 窗口没在计时的时候 codex2api 把 reset_at 写成「现在」、percent 写成 0，读出来就是个
    // 刚过期的时间戳（库里那两个已删账号还留着这种取消期间的僵尸值）。这种按冷号处理，
    // resetsAt 给 null —— 跟 Claude 冷号同一个形状，UI 的 until() 见到 null 就不显示倒计时，
    // 不会渲染出一个早就过去的重置时间。
    if (acc.c.codex_5h_used_percent != null) {
      const live = Date.parse(acc.c.codex_5h_reset_at) > Date.now()
      out.windows.push({
        label: '5小时',
        percent: acc.c.codex_5h_used_percent,
        resetsAt: live ? acc.c.codex_5h_reset_at : null,
      })
    }
    if (acc.c.codex_7d_used_percent != null) out.windows.push({
      label: '周', percent: acc.c.codex_7d_used_percent, resetsAt: acc.c.codex_7d_reset_at,
    })
    const age = Date.now() - new Date(acc.c.codex_usage_updated_at).getTime()
    if (age > 30 * 60 * 1000) out.stale = `数据 ${Math.round(age / 60000)} 分钟未更新`
  } catch (e) { out.error = String(e.message || e) }
  return out
}

// --- Opencode Go: 官方没有 usage 接口(issue #31084 已关闭未实现)。
// 唯一的真实信号：限流校验发生在参数校验之前，所以发一个空 messages 请求，
// 满额时会返回 429 GoUsageLimitError，带真实窗口名和重置时间；未满额时被参数校验挡下，不产生用量。
// 其余时间只能用 NewAPI 本地日志估算，label 标注“估算”，不冒充官方数据。
const GO_LIMIT = { '5 hour': '滚动5小时', weekly: '周', monthly: '月' }
async function opencodeProbe(key) {
  try {
    const r = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [], max_tokens: 1 }),
      signal: AbortSignal.timeout(20000),
    })
    if (r.status !== 429) return null
    const b = await r.json()
    const name = b?.metadata?.limitName
    const secs = Number(r.headers.get('retry-after'))
    return {
      label: GO_LIMIT[name] || name || '限额',
      resetsAt: isFinite(secs) && secs > 0 ? new Date(Date.now() + secs * 1000).toISOString() : null,
      message: b?.error?.message || '',
    }
  } catch { return null }
}

async function opencode() {
  const out = { id: 'opencode', name: 'Opencode', plan: 'go', windows: [] }
  try {
    const ch = readDb('newapi', (db) => db.prepare(
      "select id, key, used_quota, status from channels where name='Opencode' order by id limit 1").get())
    if (!ch) throw new Error('NewAPI 里没有 Opencode 渠道')
    out.$channelId = ch.id
    out.disabled = ch.status !== 1
    // 三个窗口都是滚动的：从窗口内第一次请求起算。分母是根据 Go 套餐标定的估计值。
    const WIN = [
      { key: '滚动5小时', secs: 5 * 3600, limit: 450e6 },
      { key: '周', secs: 7 * 86400, limit: 625e6 },
      { key: '月', secs: 30 * 86400, limit: 1250e6 },
    ]
    const now = Math.floor(Date.now() / 1000)
    const usage = readDb('newapi', (db) => {
      const q = db.prepare(
        'select coalesce(sum(quota),0) t, min(created_at) first from logs where channel_id=? and type=2 and created_at>=?')
      return WIN.map((w) => q.get(ch.id, now - w.secs))
    })
    out.windows = WIN.map((w, i) => ({
      label: `${w.key}(估算)`,
      percent: Math.min(100, Math.floor(usage[i].t / w.limit * 100)),
      resetsAt: new Date(((usage[i].first || now) + w.secs) * 1000).toISOString(),
    }))
    // 满额时用上游真实数据覆盖对应窗口，这是唯一能拿到的官方值
    const hit = ch.key ? await opencodeProbe(ch.key) : null
    if (hit) {
      const w = out.windows.find((x) => x.label.startsWith(hit.label))
      if (w) { w.label = hit.label; w.percent = 100; if (hit.resetsAt) w.resetsAt = hit.resetsAt }
      else out.windows.unshift({ label: hit.label, percent: 100, resetsAt: hit.resetsAt })
      out.stale = `上游已限额：${hit.label}`
    }
  } catch (e) { out.error = String(e.message || e) }
  return out
}

// --- Cline: NewAPI 渠道表里存着每个号的个人 API key，直接调 cline.bot ---
async function clineOne({ name, key, id, status }) {
  const out = { id: `cline:${name}`, $channelId: id, name, plan: 'ClinePass', windows: [], disabled: status !== 1 }
  try {
    const h = { Authorization: `Bearer ${key}` }
    const me = (await getJson('https://api.cline.bot/api/v1/users/me', h)).data
    if (!me?.id) throw new Error('users/me 没返回 id')
    out.name = `${name} · ${me.email || me.displayName || ''}`.trim()

    const [limits, bal] = await Promise.all([
      // ponytail: /plan/usage-limits 是仪表盘的非公开接口，可能变
      getJson('https://api.cline.bot/api/v1/users/me/plan/usage-limits', h),
      getJson(`https://api.cline.bot/api/v1/users/${me.id}/balance`, h),
    ])
    const LABEL = { five_hour: '5小时', weekly: '周', monthly: '月' }
    // limits 是数组不是对象；data:null + success:true = 该号没有 ClinePass，不是错误
    for (const l of limits.data?.limits || []) {
      out.windows.push({ label: LABEL[l.type] || l.type, percent: l.percentUsed, resetsAt: l.resetsAt })
    }
    if (!out.windows.length) out.plan = '无 ClinePass'
    if (bal.data?.balance != null) out.extra = `$${(bal.data.balance / 1e6).toFixed(2)}` // 微美元
  } catch (e) { out.error = String(e.message || e) }
  return out
}

async function cline() {
  let chans
  try {
    chans = readDb('newapi', (db) => db.prepare(
      `select id, name, key, status from channels where name like 'Cline%' order by id`).all())
  } catch (e) {
    return [{ id: 'cline', name: 'Cline', windows: [], error: String(e.message || e) }]
  }
  // status=2 是 NewAPI 侧禁用路由，账号本身仍可查额度，灰显但照拉
  return Promise.all(chans.map((c) => clineOne({ id: c.id, name: c.name, key: c.key, status: c.status })))
}

// options.force：手动点刷新时为 true，绕开 Claude 那份 5 分钟缓存去问真实用量。
// 其余几个源本来就是每次现读（codex/cline 读库、opencode 探活），不受缓存影响。
async function fetchAll(options = {}) {
  const [c, x, op, cl] = await Promise.all([
    claude(options.claudeUsageSnapshots, options.force), codex(), opencode(), cline(),
  ])
  return [...c, x, op, ...cl]
}

// --- 定时热身 --------------------------------------------------------------
// 5 小时窗口从窗口内第一次请求起算。提前发一条最小的消息把窗口点着，开工时就能
// 连着用完当前窗口和紧接着的下一个。
// 只有 Claude 走得通：gproxy 存的是完整 OAuth token，能直接打 Anthropic 的
// messages 接口。Codex/Opencode/Cline 要么没有可写的凭证，要么窗口不是首请求起算。
const WARMUP_MODEL = 'claude-haiku-4-5-20251001'
// OAuth token 只认 Claude Code 身份：system 第一段不是这句会被判成越权用途。
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

const warmupSupports = (id) => /^claude:\d+$/.test(String(id))

// 窗口已经在计时的时候发这条消息毫无意义：既点不着新窗口，又白吃一次额度。
// 所以发之前先问一次真实用量 —— 不能用 claudeCache，那份最久可以是 5 分钟前的。
async function claudeFiveHourIdle(cred) {
  const u = await getJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${cred.access_token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-code/2.1.197',
  })
  const w = u?.five_hour
  if (!w) return { idle: true } // 没有这个窗口就没什么可等的
  const used = Math.round(Number(w.utilization) || 0)
  const resets = w.resets_at ? new Date(w.resets_at).getTime() : 0
  if (Number.isFinite(resets) && resets > Date.now()) {
    const mins = Math.ceil((resets - Date.now()) / 60000)
    const left = mins < 60 ? `${mins}分钟` : `${Math.floor(mins / 60)}小时${mins % 60}分`
    // resetsAt 要带出去：调度那边靠它决定等到几点补发，不然只能盲目定时重试
    return { idle: false, why: `窗口计时中，已用 ${used}%，${left}后重置`, resetsAt: resets }
  }
  if (used > 0) return { idle: false, why: `5 小时额度已用掉 ${used}%` }
  return { idle: true }
}

async function warmupClaude(id, message, model) {
  const credId = Number(String(id).split(':')[1])
  const row = readDb('gproxy', (db) => db.prepare(
    'select id, name, secret_json from credentials where id = ? and enabled = 1').get(credId))
  if (!row) throw new Error(`gproxy 里没有启用的凭证 ${credId}`)
  const cred = j(row.secret_json)
  if (!cred?.access_token) throw new Error('凭证里没有 access_token')

  // 只在「额度是满的、倒计时还没起来」时才发，其余情况跳过等下一轮
  const state = await claudeFiveHourIdle(cred)
  if (!state.idle) return { skipped: true, info: `已跳过 · ${state.why}`, resetsAt: state.resetsAt || null }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.access_token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-code/2.1.197',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || WARMUP_MODEL,
      max_tokens: 1, // 只要这次请求被计入窗口，回答本身没用
      system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM }],
      messages: [{ role: 'user', content: String(message || 'hi') }],
    }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`)

  // 让下一轮轮询绕过 5 分钟额度缓存，新窗口才会立刻显示出来
  delete claudeCache[id]
  claudeForce.add(id)
  const u = j(text)?.usage
  return { info: u ? `已发送 · ${(u.input_tokens ?? 0) + (u.output_tokens ?? 0)} tokens` : '已发送' }
}

// 串行发：同一个 Anthropic 账号短时间连打容易吃 429，目标本来也只有几个。
async function warmup(ids, message, model) {
  const out = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!warmupSupports(id)) { out.push({ id, ok: false, error: '该来源不支持定时发送' }); continue }
    try {
      const r = await warmupClaude(id, message, model)
      out.push({ id, ok: true, skipped: !!r.skipped, info: r.info, resetsAt: r.resetsAt || null })
    } catch (e) { out.push({ id, ok: false, error: String(e.message || e) }) }
  }
  return out
}

module.exports = { configure, fetchAll, toggleChannel, syncNewApi, claudeRank, warmup, warmupSupports }
