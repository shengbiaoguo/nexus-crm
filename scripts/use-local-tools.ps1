# Dot-source from the repository root: . ./scripts/use-local-tools.ps1
$nexusRoot = Split-Path -Parent $PSScriptRoot
$nexusNodeBin = Join-Path $nexusRoot '.tools/node_modules/node/bin'
$nexusPnpmBin = Join-Path $nexusRoot '.tools/node_modules/.bin'
if (-not (Test-Path -LiteralPath (Join-Path $nexusNodeBin 'node.exe'))) {
  throw 'Local tools are unavailable. Install Node 24.22.2 and pnpm 10.34.9 or follow README.md.'
}
$env:PATH = $nexusNodeBin + ';' + $nexusPnpmBin + ';' + $env:PATH
node --version
pnpm --version
