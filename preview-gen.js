// 生成 preview.html 供浏览器核对视觉: electron --no-sandbox preview-gen.js
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { fetchAll } = require('./sources')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const data = { at: Date.now(), accounts: await fetchAll() }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('<script>', `<script>window.api={onData:c=>c(${JSON.stringify(data)}),onExpanded:c=>c(true),hover:()=>{},refresh:()=>{}};`)
    .replace('</style>', 'body{background:#1b1b20;justify-content:center}#edge{display:none}#panel{width:354px;height:100vh}</style>')
  fs.writeFileSync(path.join(__dirname, 'preview.html'), html)
  console.log('preview.html 已生成')
  app.exit(0)
})
