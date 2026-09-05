// 自检: npm run check
// better-sqlite3 已针对 Electron ABI 重建，所以必须用 electron 而不是 node 跑。
const path = require('path')
const { app } = require('electron')
const { configure, fetchAll } = require('./sources')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // 数据源位置在 config.json 里（设置 → 最底部「配置渠道」填的那三行）。
  // 不灌进来的话下面四个源会齐刷刷报「还没填…」，看着像全挂了，其实只是没读配置。
  try {
    const cfg = JSON.parse(require('fs').readFileSync(
      path.join(app.getPath('userData'), 'config.json'), 'utf8'))
    configure(cfg.sources || {})
  } catch (e) {
    console.error('读不到 config.json，先启动一次程序并在设置里填好数据库位置：', e.message)
    app.exit(1)
    return
  }

  const all = await fetchAll()
  for (const a of all) {
    const w = a.windows.map((x) => `${x.label} ${Math.round(x.percent)}%`).join('  ') || '—'
    console.log(`${a.error ? 'x' : 'v'} ${a.name.padEnd(38)} ${(a.plan || '').padEnd(10)} ${w} ${a.extra || ''}` +
      `${a.error ? '  ERR: ' + a.error : ''}${a.stale ? '  ' + a.stale : ''}${a.health ? '  ' + a.health : ''}`)
  }
  const ok = all.filter((a) => !a.error && a.windows.length).length
  console.log(`\n${ok}/${all.length} 个源返回了额度窗口`)
  if (ok < 3) { console.error('FAIL: 期望至少 3 个源有额度数据'); app.exit(1) }
  app.exit(0)
})
