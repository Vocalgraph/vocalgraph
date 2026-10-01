# Builds the Vocalgraph Helper: the exe with PyInstaller, then (when Inno
# Setup is installed) the installer, with a SHA-256 file beside it.
# Run from anywhere; used as-is by .github/workflows/helper.yml.
#
#   powershell -ExecutionPolicy Bypass -File helper\build.ps1 [-RequireInstaller]
#
# uv comes from $env:UV or PATH. PyInstaller is the "helper" dependency group
# (pinned in uv.lock), added to the environment without removing anything.
# Inno Setup's version is pinned in helper\innosetup.version (the workflow
# installs that one); ISCC.exe comes from $env:ISCC, PATH or where Inno
# Setup installs itself.
param([switch]$RequireInstaller)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = Split-Path -Parent $Here
$Uv = if ($env:UV) { $env:UV } else { 'uv' }

Push-Location $Root
try {
    & $Uv sync --locked --inexact --only-group helper
    if ($LASTEXITCODE) { throw "uv sync failed ($LASTEXITCODE)" }
    & $Uv run --locked --no-sync pyinstaller --noconfirm --distpath "$Here\dist" --workpath "$Here\build" "$Here\vocalgraph-helper.spec"
    if ($LASTEXITCODE) { throw "PyInstaller failed ($LASTEXITCODE)" }
    $Exe = Join-Path $Here 'dist\Vocalgraph Helper\Vocalgraph Helper.exe'
    Write-Host ("Built {0} ({1:N1} MB folder)" -f $Exe,
        ((Get-ChildItem (Split-Path $Exe) -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))

    $Iscc = $env:ISCC
    if (-not $Iscc) { $c = Get-Command ISCC.exe -ErrorAction SilentlyContinue; if ($c) { $Iscc = $c.Source } }
    if (-not $Iscc) {
        $Iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
                  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $Iscc) {
        if ($RequireInstaller) { throw 'Inno Setup (ISCC.exe) not found' }
        Write-Warning "Inno Setup isn't installed: skipped the installer (version $((Get-Content "$Here\innosetup.version").Trim()) is the tested one)."
        return
    }
    if (Test-Path "$Here\Output") { Remove-Item -Recurse -Force "$Here\Output" }
    & $Iscc /Q "$Here\installer.iss"
    if ($LASTEXITCODE) { throw "Inno Setup failed ($LASTEXITCODE)" }
    foreach ($Setup in Get-ChildItem "$Here\Output\*.exe") {
        $Hash = (Get-FileHash -Algorithm SHA256 $Setup.FullName).Hash.ToLower()
        # sha256sum's format, so `sha256sum -c` checks it.
        [IO.File]::WriteAllText("$($Setup.FullName).sha256", "$Hash *$($Setup.Name)`n")
        Write-Host "Built $($Setup.FullName)`n  SHA-256 $Hash"
    }
} finally {
    Pop-Location
}
