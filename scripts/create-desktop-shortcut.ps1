[CmdletBinding()]
param(
  [string]$ShortcutPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$entryPath = Join-Path $projectRoot "dist\main.js"

if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  throw "Electron is not installed. Run pnpm install first."
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "The desktop build is missing. Run pnpm run build first."
}

if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
  $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "LocalForge.lnk"
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
  $shortcut.IconLocation = "$electronPath,0"
  $shortcut.Description = "Launch the LocalForge desktop agent"
  $shortcut.Save()
} finally {
  if ($null -ne $shortcut) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

Write-Output "Created LocalForge shortcut: $ShortcutPath"
Write-Output "The shortcut launches the existing dist build directly without pnpm start."
