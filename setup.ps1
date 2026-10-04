<#
  One-time setup for the Speech Clarity app.

    .\setup.ps1              full setup
    .\setup.ps1 -SkipModels  skip the 2.4 GB model pre-download (first recording pays it instead)

  Installs:
    * espeak-ng         (winget) - phonemizer loads its DLL to turn text into IPA
    * ffmpeg            (winget) - decodes the browser's webm/opus recordings
    * a .venv with torch (CPU wheels), openpronounce and the web server
#>
[CmdletBinding()]
param(
    [switch]$SkipModels,
    [switch]$Gpu
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Write-Step  ($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Write-Ok    ($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Warn2 ($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }

# ── System dependencies ──────────────────────────────────────────────────────

function Install-WithWinget ($command, $id, $label) {
    if (Get-Command $command -ErrorAction SilentlyContinue) {
        Write-Ok "$label already installed"
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$label is missing and winget is unavailable. Install $label manually, then re-run."
    }
    Write-Host "  installing $label via winget..."
    winget install --id $id --exact --accept-package-agreements --accept-source-agreements --disable-interactivity
    Write-Ok "$label installed"
}

Write-Step 'System dependencies'
Install-WithWinget 'ffmpeg' 'Gyan.FFmpeg' 'ffmpeg'

# espeak-ng ships no PATH entry, so probe for the DLL the installer drops.
$espeakDll = @(
    'C:\Program Files\eSpeak NG\libespeak-ng.dll',
    'C:\Program Files (x86)\eSpeak NG\libespeak-ng.dll'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($espeakDll) {
    Write-Ok "espeak-ng found at $espeakDll"
} else {
    Write-Host '  installing espeak-ng via winget...'
    winget install --id eSpeak-NG.eSpeak-NG --exact --accept-package-agreements --accept-source-agreements --disable-interactivity
    $espeakDll = @(
        'C:\Program Files\eSpeak NG\libespeak-ng.dll',
        'C:\Program Files (x86)\eSpeak NG\libespeak-ng.dll'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $espeakDll) { throw 'espeak-ng installed but libespeak-ng.dll was not found. Install it manually from https://github.com/espeak-ng/espeak-ng/releases' }
    Write-Ok "espeak-ng installed at $espeakDll"
}

# ── Python ───────────────────────────────────────────────────────────────────

Write-Step 'Python interpreter'

# A MinGW/MSYS2 python is often first on PATH on Windows dev boxes and PyPI has no
# torch wheels for it, so candidates are enumerated and then checked rather than
# trusting whatever `python` resolves to.
function Get-PythonCandidates {
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($line in (& py -0p)) {
            if ($line -match '-V:(\d+)\.(\d+).*?\s(\S:\\\S.*)$') {
                $candidates += [pscustomobject]@{
                    Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Exe = $Matches[3].Trim()
                }
            }
        }
    }
    foreach ($name in @('python', 'python3')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { $candidates += [pscustomobject]@{ Major = 0; Minor = 0; Exe = $command.Source } }
    }
    return $candidates
}

function Find-Python {
    $usable = @()
    foreach ($candidate in Get-PythonCandidates) {
        if (-not (Test-Path $candidate.Exe)) { continue }
        try {
            $probe = & $candidate.Exe -c "import sys,sysconfig;print(sys.version_info[0],sys.version_info[1],sysconfig.get_platform())"
        } catch { continue }
        if (-not $probe) { continue }
        $parts = $probe.Trim().Split(' ')
        $major = [int]$parts[0]; $minor = [int]$parts[1]
        if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) { continue }
        if ($parts[2] -like '*mingw*' -or $parts[2] -like '*msys*') { continue }
        # Prefer versions that have had torch wheels longest.
        $rank = 99
        if ($minor -eq 12) { $rank = 0 } elseif ($minor -eq 13) { $rank = 1 } elseif ($minor -eq 11) { $rank = 2 } elseif ($minor -eq 10) { $rank = 3 }
        $usable += [pscustomobject]@{ Rank = $rank; Version = "$major.$minor"; Path = $candidate.Exe }
    }
    return ($usable | Sort-Object Rank | Select-Object -First 1)
}

$python = Find-Python
if (-not $python) {
    throw 'No CPython 3.10+ found. Install Python from https://www.python.org/downloads/ (an MSYS2/MinGW python cannot install torch).'
}
Write-Ok "Python $($python.Version) at $($python.Path)"

# ── Virtual environment ──────────────────────────────────────────────────────

Write-Step 'Virtual environment'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    & $python.Path -m venv .venv
    Write-Ok 'created .venv'
} else {
    Write-Ok '.venv already exists'
}

& $venvPython -m pip install --upgrade pip --quiet
Write-Ok 'pip up to date'

Write-Step 'PyTorch'
$torchIndex = 'https://download.pytorch.org/whl/cpu'
if ($Gpu) { $torchIndex = 'https://download.pytorch.org/whl/cu124' }
& $venvPython -m pip install torch --index-url $torchIndex
if ($LASTEXITCODE -ne 0) { throw 'torch install failed' }
Write-Ok 'torch installed'

Write-Step 'OpenPronounce and the web server'
& $venvPython -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'dependency install failed' }
Write-Ok 'dependencies installed'

# ── Configuration ────────────────────────────────────────────────────────────

Write-Step 'Configuration'
if (-not (Test-Path (Join-Path $root '.env'))) {
    Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env')
    Write-Ok 'created .env from .env.example'
    Write-Warn2 'Add your ELEVENLABS_API_KEY to .env (without it, the built-in gTTS voice is used)'
} else {
    Write-Ok '.env already exists'
}

# ── Models ───────────────────────────────────────────────────────────────────

if (-not $SkipModels) {
    Write-Step 'Speech models (~2.4 GB, downloaded once from Hugging Face)'
    # Run from a file, not `python -c`: Windows PowerShell 5.1 strips the double
    # quotes out of arguments it hands to native programs, mangling inline code.
    $warmScript = Join-Path $env:TEMP 'pronounce-warm-models.py'
    Set-Content -Path $warmScript -Encoding ASCII -Value @(
        'import os, sys'
        'sys.path.insert(0, os.getcwd())'
        'from backend import scoring, settings'
        'scoring.init(settings.load())'
        'scoring.warm()'
        "print('models ready')"
    )
    & $venvPython $warmScript
    $warmExit = $LASTEXITCODE
    Remove-Item $warmScript -ErrorAction SilentlyContinue
    if ($warmExit -ne 0) { throw 'model download failed' }
    Write-Ok 'models cached'
} else {
    Write-Warn2 'Skipped the model download - the first recording will wait for it'
}

Write-Host "`nSetup complete. Start it with:" -ForegroundColor Green
Write-Host '  .\run.ps1' -ForegroundColor White
