param([ValidateSet('dev', 'build', 'check', 'release')][string]$Action = 'dev')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
. (Join-Path $PSScriptRoot 'build-env.ps1')
if ($Action -eq 'check') {
    & npm.cmd --prefix apps/client run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo check --workspace --locked
} elseif ($Action -in @('build', 'release')) {
    $matrixProfile = 'debug'
    if ($Action -eq 'release') {
        $matrixProfile = 'release'
        New-Item -ItemType Directory -Path .tools, distribution -Force | Out-Null
        $matrixMetadata = & cargo metadata --locked --format-version 1
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        [System.IO.File]::WriteAllText((Join-Path $projectRoot '.tools/dependency-metadata.json'), ($matrixMetadata -join [Environment]::NewLine))
        & node scripts/third-party-notices.mjs distribution
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Copy-Item -LiteralPath LICENSE, COPYRIGHT.md -Destination distribution -Force
        & npm.cmd --prefix apps/client run tauri -- build --config src-tauri/tauri.release.conf.json --bundles nsis -- --locked
    } else {
        & npm.cmd --prefix apps/client run tauri -- build --debug --no-bundle -- --locked
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $matrixVersion = (Get-Content apps/client/package.json -Raw | ConvertFrom-Json).version
    $matrixPortable = Join-Path $projectRoot "artifacts\Matrix Client $matrixVersion"
    New-Item -ItemType Directory -Path $matrixPortable -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "$matrixProfile\matrix-client.exe") -Destination (Join-Path $matrixPortable 'MatrixClient.exe') -Force
    Copy-Item -LiteralPath docs/RELEASE_REVIEW.md -Destination (Join-Path $matrixPortable 'README.md') -Force
    Copy-Item -LiteralPath docs/VALIDATION.md -Destination (Join-Path $matrixPortable 'VALIDATION.md') -Force
    if ($Action -eq 'release') {
        $matrixInstallers = @(Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter "*$matrixVersion*-setup.exe")
        if ($matrixInstallers.Count -ne 1) { throw 'Expected one matching installer.' }
        Copy-Item -LiteralPath $matrixInstallers[0].FullName -Destination $matrixPortable -Force
        Copy-Item -Path distribution/* -Destination $matrixPortable -Recurse -Force
        & python scripts/package-release.py
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    Write-Host "Built: $matrixPortable\MatrixClient.exe"
} else {
    & npm.cmd --prefix apps/client run tauri -- dev
}
exit $LASTEXITCODE
