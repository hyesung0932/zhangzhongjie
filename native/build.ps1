param(
  [ValidateSet('Debug','Release')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$repoRoot = Split-Path $nativeRoot -Parent
$packageVersion = '1.0.4191.47'
$packageRoot = Join-Path $repoRoot ".packages\Microsoft.Web.WebView2.$packageVersion"

if (-not (Test-Path (Join-Path $packageRoot 'build\native\include\WebView2.h'))) {
  $packagesFolder = Join-Path $repoRoot '.packages'
  New-Item -ItemType Directory -Force $packagesFolder | Out-Null
  $archive = Join-Path $packagesFolder "Microsoft.Web.WebView2.$packageVersion.zip"
  Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$packageVersion/microsoft.web.webview2.$packageVersion.nupkg" -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $packageRoot -Force
  Remove-Item -LiteralPath $archive
}

Push-Location $repoRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Visual Studio Build Tools not found.' }
$vsRoot = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
$msbuild = Join-Path $vsRoot 'MSBuild\Current\Bin\amd64\MSBuild.exe'
if (-not (Test-Path $msbuild)) { throw 'MSBuild x64 not found.' }

& $msbuild (Join-Path $nativeRoot 'ZhangZhongJie.Native.vcxproj') /m /restore /p:Configuration=$Configuration /p:Platform=x64
if ($LASTEXITCODE -ne 0) { throw "Native build failed with exit code $LASTEXITCODE." }

$output = Join-Path $nativeRoot "bin\x64\$Configuration"
$webOutput = Join-Path $output 'web'
if (Test-Path $webOutput) { Remove-Item -LiteralPath $webOutput -Recurse -Force }
Copy-Item -Path (Join-Path $repoRoot 'dist') -Destination $webOutput -Recurse
Write-Host "Built: $(Join-Path $output '掌中界.exe')"
