<#
  Start the Speech Clarity app.

    .\run.ps1              serve on the host/port from .env (default 127.0.0.1:8077)
    .\run.ps1 -Reload      auto-reload on source changes
    .\run.ps1 -NoBrowser   do not open a browser window
#>
[CmdletBinding()]
param(
    [switch]$Reload,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    throw 'No .venv found. Run .\setup.ps1 first.'
}

# .env is the single source of truth for the address; read the two keys we need
# here so the banner and the browser agree with the server.
$serverHost = '127.0.0.1'
$port = '8077'
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*PRONOUNCE_HOST\s*=\s*(.+?)\s*$') { $serverHost = $Matches[1].Trim('"').Trim("'") }
        if ($line -match '^\s*PRONOUNCE_PORT\s*=\s*(.+?)\s*$') { $port = $Matches[1].Trim('"').Trim("'") }
    }
}

$browseHost = $serverHost
if ($serverHost -eq '0.0.0.0') { $browseHost = '127.0.0.1' }
$url = "http://${browseHost}:${port}/"

Write-Host "Speech Clarity -> $url" -ForegroundColor Cyan
Write-Host 'The speech models load in the background; the page says when it is ready.' -ForegroundColor DarkGray

if (-not $NoBrowser) {
    # The server needs a moment to bind before the browser knocks.
    Start-Job -ScriptBlock { Start-Sleep -Seconds 2; Start-Process $using:url } | Out-Null
}

$arguments = @('-m', 'uvicorn', 'backend.app:app', '--host', $serverHost, '--port', $port)
if ($Reload) { $arguments += '--reload' }

& $venvPython @arguments
