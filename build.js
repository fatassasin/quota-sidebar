// 打包: npm run package
// 产物是 dist/QuotaSidebar-win32-x64/，整个目录压成 zip 就是 release 里挂的那个下载。
//
// 写成脚本而不是 package.json 里的一行命令，是因为下面的排除规则需要解释 ——
// 尤其是 better-sqlite3 那几条，删错了程序起不来，光看正则看不出为什么能删。
const path = require('path')
const fs = require('fs')
const { packager } = require('@electron/packager')

// 每条规则都会拿去 test() 应用目录里的相对路径（带开头的斜杠，如 /node_modules/xxx）。
const IGNORE = [
  // 产物自己。不排掉的话第二次打包会把上一次的 400M 塞进这一次。
  /^\/dist$/,
  /^\/\.git/,

  // 只在开发时用的东西。测试文件靠字符串标记从 main.js / sources.js 里抠源码，
  // 用户手上没有它们也照样能跑。
  /^\/_.*test\.js$/,
  /^\/probe5\.js$/,
  /^\/preview/,
  /^\/build\.js$/,
  /^\/run\.log$/,

  // 给 README 和 release 页看的图，1.5M。程序自己不加载它，打进去只是死重量。
  // 代价是 resources/app 里那份 README 的图链会断 —— 那个位置本来也没人翻。
  /^\/shot\.png$/,
  /^\/banner\.png$/,

  // 这两个启动脚本只在源码目录里成立 —— 它们要么找同级的 QuotaSidebar.exe，要么找
  // node_modules\electron，而 resources/app 里两样都没有。留在里面的唯一后果是有人
  // 翻到它、在那儿运行、然后拿到一句报错。create-shortcut.ps1 会在打包结束后
  // 单独复制到产物根目录，在那儿它能正确认出打包版布局。
  /^\/create-shortcut\.ps1$/,
  /^\/start\.bat$/,

  // better-sqlite3 编译完会在 build/ 里留下 49M 的中间产物：链接器的 .iobj/.ipdb、
  // 调试符号 .pdb、静态库 .lib、还有 obj/ 下的一堆 .obj。运行时只 require
  // build/Release/better_sqlite3.node 这一个 1.9M 的文件，其余全是死重量。
  // deps/ 和 src/ 是 sqlite3 的 C 源码，同理 —— 已经编进 .node 里了。
  /^\/node_modules\/better-sqlite3\/(deps|src)($|\/)/,
  /^\/node_modules\/better-sqlite3\/build\/Release\/obj($|\/)/,
  /^\/node_modules\/better-sqlite3\/build\/.*\.(iobj|ipdb|pdb|lib|exp|vcxproj|filters|sln)$/,
]

packager({
  dir: __dirname,
  name: 'QuotaSidebar',
  platform: 'win32',
  arch: 'x64',
  out: path.join(__dirname, 'dist'),
  overwrite: true,
  icon: path.join(__dirname, 'icon.ico'),
  ignore: IGNORE,
}).then((paths) => {
  // 快捷方式脚本放产物根目录（跟 QuotaSidebar.exe 平级）。它靠"同目录有没有 exe"
  // 判断布局，只有放在这里才认得出自己是打包版。
  for (const out of paths) {
    fs.copyFileSync(
      path.join(__dirname, 'create-shortcut.ps1'),
      path.join(out, 'create-shortcut.ps1'))
  }
  console.log('打包完成：', paths.join('\n'))
}).catch((err) => {
  console.error('打包失败：', err)
  process.exit(1)
})
