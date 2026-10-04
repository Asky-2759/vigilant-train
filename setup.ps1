<#
  One-time setup for the pronunciation trainer.

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

# Python 3.x minor versions every dependency ships prebuilt Windows wheels for, in
# order of preference. 3.13+ is excluded: panphon (used by comparison.py) needs
# editdistance, which has no 3.13 Windows wheel and so tries to compile from C
# source -- failing on any machine without the MSVC build tools.
$SupportedMinors = @(12, 11, 10)
$PythonFix = 'winget install --id Python.Python.3.12 --exact'

# Returns "major minor platform" for an interpreter, or $null if it cannot run.
function Get-PythonInfo ($exe) {
    try {
        $probe = & $exe -c "import sys,sysconfig;print(sys.version_info[0],sys.version_info[1],sysconfig.get_platform())"
    } catch { return $null }
    if (-not $probe) { return $null }
    $parts = $probe.Trim().Split(' ')
    return [pscustomobject]@{ Major = [int]$parts[0]; Minor = [int]$parts[1]; Platform = $parts[2] }
}

function Test-SupportedPython ($info) {
    return $info -and $info.Major -eq 3 -and $SupportedMinors -contains $info.Minor -and
        $info.Platform -notlike '*mingw*' -and $info.Platform -notlike '*msys*'
}

function Find-Python {
    $usable = @()
    $rejected = @()
    foreach ($candidate in Get-PythonCandidates) {
        if (-not (Test-Path $candidate.Exe)) { continue }
        $info = Get-PythonInfo $candidate.Exe
        if (-not $info) { continue }
        if (Test-SupportedPython $info) {
            $usable += [pscustomobject]@{
                Rank = [array]::IndexOf($SupportedMinors, $info.Minor)
                Version = "$($info.Major).$($info.Minor)"; Path = $candidate.Exe
            }
        } else {
            $rejected += "$($info.Major).$($info.Minor) ($($info.Platform))"
        }
    }
    return [pscustomobject]@{
        Best = ($usable | Sort-Object Rank | Select-Object -First 1)
        Rejected = ($rejected | Select-Object -Unique)
    }
}

$found = Find-Python
$python = $found.Best
if (-not $python) {
    $seen = 'none'
    if ($found.Rejected) { $seen = $found.Rejected -join ', ' }
    throw ("No supported Python found (need 3.12, 3.11 or 3.10; found: $seen). " +
        "Python 3.13+ cannot install panphon's editdistance dependency on Windows. " +
        "Install 3.12 with:  $PythonFix  -- then open a new terminal and re-run .\setup.ps1")
}
Write-Ok "Python $($python.Version) at $($python.Path)"

# ── Virtual environment ──────────────────────────────────────────────────────

Write-Step 'Virtual environment'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'

# A .venv left over from an earlier run may be on an unsupported Python (e.g.
# 3.13, before it was ruled out). Reusing it would just fail again later in pip,
# so rebuild it with the interpreter chosen above.
if (Test-Path $venvPython) {
    $venvInfo = Get-PythonInfo $venvPython
    if (Test-SupportedPython $venvInfo) {
        Write-Ok ".venv already exists (Python $($venvInfo.Major).$($venvInfo.Minor))"
    } else {
        $venvVersion = 'unknown'
        if ($venvInfo) { $venvVersion = "$($venvInfo.Major).$($venvInfo.Minor)" }
        Write-Warn2 ".venv uses Python $venvVersion, which is not supported - rebuilding it with $($python.Version)"
        Remove-Item -Recurse -Force (Join-Path $root '.venv')
    }
}
if (-not (Test-Path $venvPython)) {
    & $python.Path -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'could not create .venv' }
    Write-Ok "created .venv (Python $($python.Version))"
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
    & $venvPython -c @'
from backend import scoring, settings
scoring.init(settings.load())
scoring.warm("en")
print("models ready")
'@
    if ($LASTEXITCODE -ne 0) { throw 'model download failed' }
    Write-Ok 'models cached'
} else {
    Write-Warn2 'Skipped the model download - the first recording will wait for it'
}

Write-Host "`nSetup complete. Start it with:" -ForegroundColor Green
Write-Host '  .\run.ps1' -ForegroundColor White
