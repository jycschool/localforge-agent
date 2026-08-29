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
$chineseProductName = -join ([char[]](0x4EE3, 0x7801, 0x953B, 0x9020))
$shortcutDescription = (-join ([char[]](0x542F, 0x52A8))) + " RepoForge " + $chineseProductName + (-join ([char[]](0x667A, 0x80FD, 0x4F53)))

if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw "Electron is not installed. Run pnpm install first."
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "The desktop build is missing. Run pnpm run build first."
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "The RepoForge application icon is missing."
}

$usingDefaultShortcutPath = [string]::IsNullOrWhiteSpace($ShortcutPath)
$legacyShortcutPath = $null
if ($usingDefaultShortcutPath) {
  $desktopPath = [Environment]::GetFolderPath("Desktop")
  $ShortcutPath = Join-Path $desktopPath ("RepoForge {0}.lnk" -f $chineseProductName)
  $legacyShortcutPath = Join-Path $desktopPath "LocalForge.lnk"
}
$ShortcutPath = [IO.Path]::GetFullPath($ShortcutPath)
if ([IO.Path]::GetExtension($ShortcutPath) -ne ".lnk") {
  throw "ShortcutPath must end with .lnk."
}
$shortcutDirectory = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
  throw "Shortcut directory does not exist: $shortcutDirectory"
}

if (
  $usingDefaultShortcutPath -and
  (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf) -and
  -not (Test-Path -LiteralPath $ShortcutPath)
) {
  Move-Item -LiteralPath $legacyShortcutPath -Destination $ShortcutPath
  Write-Output "Migrated legacy shortcut: $legacyShortcutPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $electronPath
  $shortcut.Arguments = '"' + $projectRoot + '"'
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = $shortcutDescription
  $shortcut.Save()
} finally {
  if ($null -ne $shortcut) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

Write-Output "Created RepoForge shortcut: $ShortcutPath"
Write-Output "The shortcut launches the existing dist build directly without pnpm start."
