[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$failures = [System.Collections.Generic.List[string]]::new()

function Add-CheckResult {
  param(
    [Parameter(Mandatory = $true)][bool]$Passed,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if ($Passed) {
    Write-Host "[PASS] $Message" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    $failures.Add($Message)
  }
}

Push-Location $workspaceRoot
try {
  $readmeText = [System.IO.File]::ReadAllText(
    (Join-Path $workspaceRoot "README.txt"),
    [System.Text.Encoding]::UTF8
  )
  $readmeCharacterCount = ($readmeText -replace "`r`n?", "`n").Length
  Add-CheckResult ($readmeCharacterCount -le 1000) "README.txt is at most 1000 normalized characters (current: $readmeCharacterCount)"

  $forbiddenTracked = @(git ls-files | Where-Object {
    $_ -match '(^|/)(\.env($|\.)|dist/|release/|tmp/)' -or
    $_ -match '\.(mp4|zip|pdf)$'
  })
  Add-CheckResult ($forbiddenTracked.Count -eq 0) "Git does not track env files, builds, PDFs, videos, or delivery zips"
  if ($forbiddenTracked.Count -gt 0) {
    $forbiddenTracked | ForEach-Object { Write-Host "       $_" }
  }

  $credentialPattern = 'sk-[A-Za-z0-9_-]{16,}|ms-[A-Za-z0-9_-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|(apiKey|api_key)[[:space:]]*[:=][[:space:]]*[''"][A-Za-z0-9._-]{16,}'
  $allowedFixturePaths = @("tests/configStore.test.ts")
  $credentialFiles = [System.Collections.Generic.HashSet[string]]::new()
  git rev-list --all | ForEach-Object {
    git grep -l -I -E $credentialPattern $_ -- . 2>$null | ForEach-Object {
      $separator = $_.IndexOf(":")
      $file = if ($separator -ge 0) { $_.Substring($separator + 1) } else { $_ }
      if ($file -notin $allowedFixturePaths) {
        [void]$credentialFiles.Add($file)
      }
    }
  }
  Add-CheckResult ($credentialFiles.Count -eq 0) "Git history has no unapproved credential-shaped values"
  if ($credentialFiles.Count -gt 0) {
    $credentialFiles | Sort-Object | ForEach-Object { Write-Host "       $_" }
  }

  $brokenLinks = [System.Collections.Generic.List[string]]::new()
  Get-ChildItem -LiteralPath "docs" -Filter "*.md" -Recurse | ForEach-Object {
    $source = $_
    $markdown = Get-Content -LiteralPath $source.FullName -Raw -Encoding UTF8
    [regex]::Matches($markdown, '\]\(([^)]+)\)') | ForEach-Object {
      $target = $_.Groups[1].Value.Split("#")[0]
      if ($target -and $target -notmatch '^(https?:|mailto:)') {
        $resolved = Join-Path -Path $source.DirectoryName -ChildPath $target
        if (-not (Test-Path -LiteralPath $resolved)) {
          $brokenLinks.Add("$($source.FullName) -> $target")
        }
      }
    }
  }
  Add-CheckResult ($brokenLinks.Count -eq 0) "Local Markdown links under docs resolve"
  if ($brokenLinks.Count -gt 0) {
    $brokenLinks | ForEach-Object { Write-Host "       $_" }
  }

  $previousNativePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $demoOutput = @(& node --test "demo/order-pricing/test/verify.mjs" 2>&1)
    $demoExitCode = $LASTEXITCODE
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
  }
  $passLine = $demoOutput | Where-Object { $_ -match '^# pass 2$' }
  $failLine = $demoOutput | Where-Object { $_ -match '^# fail 4$' }
  Add-CheckResult (
    $demoExitCode -eq 1 -and $null -ne $passLine -and $null -ne $failLine
  ) "Demo fixture remains at the reproducible 2-pass, 4-fail baseline"

  if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "Delivery verification failed with $($failures.Count) issue(s)." -ForegroundColor Red
    exit 1
  }
  Write-Host ""
  Write-Host "All delivery checks passed." -ForegroundColor Green
} finally {
  Pop-Location
}
