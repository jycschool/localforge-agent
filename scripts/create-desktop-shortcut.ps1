[CmdletBinding()]
param(
  [string]$ShortcutPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$entryPath = Join-Path $projectRoot "dist\main.js"
$iconPath = Join-Path $projectRoot "media\repoforge-icon.ico"

if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw "Electron is not installed. Run pnpm install first."
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "The desktop build is missing. Run pnpm run build first."
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "The RepoForge application icon is missing."
}

if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
  $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "RepoForge 代码锻造.lnk"
}
$ShortcutPath = [IO.Path]::GetFullPath($ShortcutPath)
if ([IO.Path]::GetExtension($ShortcutPath) -ne ".lnk") {
  throw "ShortcutPath must end with .lnk."
}
$shortcutDirectory = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
  throw "Shortcut directory does not exist: $shortcutDirectory"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $electronPath
  $shortcut.Arguments = '"' + $projectRoot + '"'
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = "启动 RepoForge 代码锻造智能体"
  $shortcut.Save()
} finally {
  if ($null -ne $shortcut) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

Write-Output "Created RepoForge shortcut: $ShortcutPath"
Write-Output "The shortcut launches the existing dist build directly without pnpm start."
