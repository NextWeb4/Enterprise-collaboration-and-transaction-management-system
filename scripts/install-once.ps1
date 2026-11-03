$ErrorActionPreference = 'Stop'

$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
if ($package.packageManager -ne 'pnpm@11.18.0') {
  throw "Expected pnpm@11.18.0, found '$($package.packageManager)'"
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm install failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
