param(
    # 同时在「启动」文件夹放一份，实现开机自启
    [switch]$Startup
)

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$programs = [Environment]::GetFolderPath('Programs')
$link     = Join-Path $programs 'Quota Sidebar.lnk'

# 这个脚本要在两种布局下都能用：
#   打包版 —— 解压出来的目录里直接躺着 QuotaSidebar.exe，图标已经编进 exe 了；
#   源码版 —— 得借 node_modules 里的 electron 去加载当前目录（末尾那个 . 就是这个意思），
#             图标只能另外指 icon.ico。
# 认哪个不靠参数，靠同目录下有没有 QuotaSidebar.exe，用户不用记自己装的是哪种。
$packaged = Join-Path $root 'QuotaSidebar.exe'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'

if (Test-Path $packaged) {
    $target  = $packaged
    $argLine = '--no-sandbox'
    $icon    = "$packaged,0"
} elseif (Test-Path $electron) {
    $iconFile = Join-Path $root 'icon.ico'
    if (-not (Test-Path $iconFile)) { throw "icon.ico not found: $iconFile" }
    $target  = $electron
    $argLine = '--no-sandbox .'
    $icon    = "$iconFile,0"
} else {
    throw "这个目录里既没有 QuotaSidebar.exe，也没有 node_modules\electron。请把脚本放在解压出来的目录、或者项目根目录里再运行。当前目录：$root"
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = $target
$sc.Arguments        = $argLine
$sc.WorkingDirectory = $root
$sc.IconLocation     = $icon
$sc.Description      = 'Quota Sidebar - Claude 用量侧边栏'
$sc.WindowStyle      = 1
$sc.Save()

Write-Output "Created: $link"

if ($Startup) {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $startupLink = Join-Path $startupDir 'Quota Sidebar.lnk'
    Copy-Item -LiteralPath $link -Destination $startupLink -Force
    Write-Output "Created: $startupLink"
}
