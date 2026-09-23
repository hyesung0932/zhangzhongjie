param(
  [ValidateSet('Release')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$installerRoot = $PSScriptRoot
$repoRoot = Split-Path $installerRoot -Parent
$bootstrapper = Join-Path $installerRoot 'prerequisites\MicrosoftEdgeWebview2Setup.exe'
$bootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

& (Join-Path $repoRoot 'native\build.ps1') -Configuration $Configuration
if ($LASTEXITCODE -ne 0) { throw "Release build failed with exit code $LASTEXITCODE." }

if (-not (Test-Path -LiteralPath $bootstrapper)) {
  New-Item -ItemType Directory -Force (Split-Path $bootstrapper -Parent) | Out-Null
  Invoke-WebRequest -Uri $bootstrapperUrl -OutFile $bootstrapper
}
if ((Get-Item -LiteralPath $bootstrapper).Length -lt 500000) {
  throw 'Downloaded WebView2 bootstrapper is unexpectedly small.'
}
$bootstrapperSignature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
$bootstrapperSigner = $bootstrapperSignature.SignerCertificate.Subject
if ($bootstrapperSignature.Status -ne 'Valid' -or
    $bootstrapperSigner -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
  throw "WebView2 bootstrapper signature is not a valid Microsoft signature (status: $($bootstrapperSignature.Status), signer: $bootstrapperSigner)."
}

$compilerCandidates = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) {
  throw 'Inno Setup 6 was not found. Install JRSoftware.InnoSetup with winget.'
}

$installerDefinition = Join-Path $installerRoot 'ZhangZhongJie.iss'
$versionMatch = [regex]::Match(
  (Get-Content -LiteralPath $installerDefinition -Raw),
  '(?m)^#define\s+MyAppVersion\s+"([^"]+)"'
)
if (-not $versionMatch.Success) { throw 'MyAppVersion was not found in ZhangZhongJie.iss.' }
$appVersion = $versionMatch.Groups[1].Value

& $compiler $installerDefinition
if ($LASTEXITCODE -ne 0) { throw "Installer build failed with exit code $LASTEXITCODE." }

$output = Join-Path $installerRoot "output\ZhangZhongJie-Setup-$appVersion-x64.exe"
if (-not (Test-Path -LiteralPath $output)) { throw 'Installer output was not created.' }
Write-Host "Built installer: $output"
