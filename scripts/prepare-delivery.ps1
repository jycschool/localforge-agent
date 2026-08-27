[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$StudentName,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VideoPath,
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$readmePath = Join-Path $workspaceRoot "README.txt"
$resolvedVideo = (Resolve-Path -LiteralPath $VideoPath).Path
$studentNameTrimmed = $StudentName.Trim()

if (-not $studentNameTrimmed) {
  throw "StudentName cannot be empty."
}
if ($studentNameTrimmed.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
  throw "StudentName contains characters that cannot be used in a zip filename."
}
if ([System.IO.Path]::GetExtension($resolvedVideo) -ine ".mp4") {
  throw "The demonstration video must use the .mp4 extension."
}

$videoInfo = Get-Item -LiteralPath $resolvedVideo
if (-not $videoInfo.PSIsContainer -and $videoInfo.Length -gt 0) {
  $videoSizeLimit = 200MB
  if ($videoInfo.Length -gt $videoSizeLimit) {
    throw "The demonstration video exceeds 200 MB."
  }
} else {
  throw "The demonstration video is empty or is not a file."
}

$signature = [byte[]]::new(12)
$stream = [System.IO.File]::OpenRead($resolvedVideo)
try {
  if ($stream.Read($signature, 0, $signature.Length) -lt $signature.Length) {
    throw "The demonstration video is too small to be a valid MP4 file."
  }
} finally {
  $stream.Dispose()
}
$fileTypeMarker = [System.Text.Encoding]::ASCII.GetString($signature, 4, 4)
if ($fileTypeMarker -ne "ftyp") {
  throw "The demonstration video does not have an MP4 file signature."
}

$readmeText = [System.IO.File]::ReadAllText($readmePath, [System.Text.Encoding]::UTF8)
$readmeCharacterCount = ($readmeText -replace "`r`n?", "`n").Length
if ($readmeCharacterCount -gt 1000) {
  throw "README.txt exceeds 1000 normalized characters (current: $readmeCharacterCount)."
}

$ffprobe = Get-Command "ffprobe" -ErrorAction SilentlyContinue
if ($null -ne $ffprobe) {
  $durationText = & $ffprobe.Source `
    -v error `
    -show_entries format=duration `
    -of default=noprint_wrappers=1:nokey=1 `
    $resolvedVideo
  if ($LASTEXITCODE -ne 0) {
    throw "ffprobe could not read the demonstration video."
  }
  $duration = 0.0
  if (-not [double]::TryParse(
    ($durationText | Select-Object -First 1),
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [ref]$duration
  )) {
    throw "Could not determine the demonstration video duration."
  }
  if ($duration -gt 120.0) {
    throw "The demonstration video exceeds 120 seconds (current: $([math]::Round($duration, 2)))."
  }
  Write-Host "[PASS] Video duration is $([math]::Round($duration, 2)) seconds" -ForegroundColor Green
} else {
  Write-Warning "ffprobe is unavailable; verify manually that the video is no longer than 120 seconds."
}

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $workspaceRoot "tmp\delivery"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Path $resolvedOutput -Force)
$zipPath = Join-Path $resolvedOutput "$studentNameTrimmed.zip"
if (Test-Path -LiteralPath $zipPath) {
  throw "The output zip already exists: $zipPath"
}

$stagingPath = Join-Path $resolvedOutput ("stage-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $stagingPath)
try {
  $stagedReadme = Join-Path $stagingPath "README.txt"
  $stagedVideo = Join-Path $stagingPath "demo.mp4"
  Copy-Item -LiteralPath $readmePath -Destination $stagedReadme
  Copy-Item -LiteralPath $resolvedVideo -Destination $stagedVideo
  Compress-Archive -LiteralPath @($stagedReadme, $stagedVideo) -DestinationPath $zipPath

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
  } finally {
    $archive.Dispose()
  }
  if ($entryNames.Count -ne 2 -or "README.txt" -notin $entryNames -or "demo.mp4" -notin $entryNames) {
    throw "The generated zip does not contain exactly README.txt and demo.mp4."
  }
} finally {
  if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
  }
}

Write-Host "[PASS] README.txt has $readmeCharacterCount normalized characters" -ForegroundColor Green
Write-Host "[PASS] Video size is $([math]::Round($videoInfo.Length / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "[PASS] Zip contains only README.txt and demo.mp4" -ForegroundColor Green
Write-Host "Delivery package: $zipPath" -ForegroundColor Cyan
