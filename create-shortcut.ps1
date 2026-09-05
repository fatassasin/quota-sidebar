param(
    # 同时在「启动」文件夹放一份，实现开机自启
    [switch]$Startup
)

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$target   = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon     = Join-Path $root 'icon.ico'
$programs = [Environment]::GetFolderPath('Programs')
$link     = Join-Path $programs 'Quota Sidebar.lnk'

if (-not (Test-Path $target)) { throw "electron.exe not found: $target" }
if (-not (Test-Path $icon))   { throw "icon.ico not found: $icon" }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath       = $target
$sc.Arguments        = '--no-sandbox .'
$sc.WorkingDirectory = $root
$sc.IconLocation     = "$icon,0"
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
