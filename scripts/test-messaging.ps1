$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'build-env.ps1')
& node (Join-Path $PSScriptRoot 'test-messaging.mjs')
exit $LASTEXITCODE
