$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectPath
function Invoke-Checked {
  param([string]$Program, [string[]]$Arguments)
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed. The app was not launched." }
}
try {
  $pending = & git status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the project.' }
  if ($pending) { throw 'There are unsaved code changes. Finish or save that work before launching the latest main version.' }
  Write-Host 'Getting the latest combined version...'
  Invoke-Checked 'git' @('fetch', 'origin')
  Invoke-Checked 'git' @('switch', 'main')
  Invoke-Checked 'git' @('pull', '--ff-only', 'origin', 'main')
  $dependencyHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
  $dependencyStamp = 'node_modules/.splitterator-launch-lock.sha256'
  if (!(Test-Path -LiteralPath $dependencyStamp) -or (Get-Content -LiteralPath $dependencyStamp -Raw).Trim() -ne $dependencyHash) {
    Invoke-Checked 'npm.cmd' @('ci')
    Set-Content -LiteralPath $dependencyStamp -Value $dependencyHash
  }
  Write-Host 'Building the current app...'
  Invoke-Checked 'npm.cmd' @('run', 'build')
  Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
  Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Invoke-Checked '.\node_modules\.bin\electron.cmd' @('.')
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
