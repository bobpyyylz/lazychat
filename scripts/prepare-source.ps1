$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
. (Join-Path $PSScriptRoot 'build-env.ps1')
New-Item -ItemType Directory -Path .tools/frontend-sources -Force | Out-Null
& cargo vendor --locked vendor
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$matrixReactVersion = (Get-Content apps/client/node_modules/react/package.json -Raw | ConvertFrom-Json).version
$matrixApiVersion = (Get-Content apps/client/node_modules/@tauri-apps/api/package.json -Raw | ConvertFrom-Json).version
$matrixSources = @{
    'react.tar.gz' = "https://codeload.github.com/facebook/react/tar.gz/refs/tags/v$matrixReactVersion"
    'tauri.tar.gz' = "https://codeload.github.com/tauri-apps/tauri/tar.gz/refs/tags/tauri-v$matrixApiVersion"
}
foreach ($matrixName in $matrixSources.Keys) {
    Invoke-WebRequest $matrixSources[$matrixName] -OutFile (Join-Path .tools/frontend-sources $matrixName)
}
$matrixSources | ConvertTo-Json | Set-Content .tools/frontend-sources/ORIGINS.json
