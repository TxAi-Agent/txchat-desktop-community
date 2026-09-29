$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Project = Join-Path $ProjectRoot 'native\windows\TxChat.NativeHost.csproj'
$Output = Join-Path $ProjectRoot '.build\native\win-x64'
$BuildArtifacts = Join-Path $ProjectRoot '.build\native\dotnet-artifacts'

# Keep the complete self-contained output directory together with its runtime.
& dotnet publish $Project --configuration Release --runtime win-x64 `
    --self-contained true --output $Output --artifacts-path $BuildArtifacts --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "Native helper compiled: $Output"
