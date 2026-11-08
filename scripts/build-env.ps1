$ErrorActionPreference = 'Stop'
$matrixProjectRoot = Split-Path $PSScriptRoot -Parent
if (!$env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $matrixProjectRoot 'target\room-fix' }
if ($env:MATRIX_BUILD_ENV_READY -eq $matrixProjectRoot) { return }
if (Test-Path -LiteralPath (Join-Path $matrixProjectRoot '.tools\cargo\bin\cargo.exe')) {
    $env:CARGO_HOME = Join-Path $matrixProjectRoot '.tools\cargo'
    $env:RUSTUP_HOME = Join-Path $matrixProjectRoot '.tools\rustup'
    $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
$matrixVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $matrixVsWhere) {
    $matrixVs = & $matrixVsWhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($matrixVs) {
        Import-Module (Join-Path $matrixVs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
        Enter-VsDevShell -VsInstallPath $matrixVs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64 -winsdk=10.0.22621.0' | Out-Null
        $env:CMAKE_GENERATOR = 'Ninja'
        $env:CMAKE_SYSTEM_VERSION = '10.0.22621.0'
        $matrixCmake = Join-Path $matrixVs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
        if (Test-Path -LiteralPath $matrixCmake) { $env:PATH = $matrixCmake + ';' + $env:PATH }
        $matrixNinja = Join-Path $matrixVs 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
        if (Test-Path -LiteralPath $matrixNinja) { $env:PATH = $matrixNinja + ';' + $env:PATH }
        $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $env:VCToolsInstallDir 'bin\Hostx64\x64\link.exe'
        # This machine's v143 installation lacks the legacy stdio shim. MSVC's
        # v14 toolsets are binary-compatible; use the installed v141 shim only.
        $matrixLegacyLib = Join-Path $matrixVs 'VC\Tools\MSVC\14.16.27023\lib\x64'
        if (!(Test-Path (Join-Path $env:VCToolsInstallDir 'lib\x64\legacy_stdio_definitions.lib')) -and (Test-Path (Join-Path $matrixLegacyLib 'legacy_stdio_definitions.lib'))) {
            $env:LIB = $env:LIB + ';' + $matrixLegacyLib
        }
    }
}
$env:npm_config_cache = Join-Path $matrixProjectRoot '.tools\npm-cache'
$env:PATH = (($env:PATH -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';')
$env:MATRIX_BUILD_ENV_READY = $matrixProjectRoot
