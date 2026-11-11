param([string]$StorageRoot = "storage")
$ErrorActionPreference = "Stop"
$resolved = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $StorageRoot))
New-Item -ItemType Directory -Force -Path $resolved | Out-Null
& icacls.exe $resolved /inheritance:r | Out-Null
& icacls.exe $resolved /grant:r "${env:USERNAME}:(OI)(CI)M" "SYSTEM:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
Write-Host "Storage ACL configured for the current service user and SYSTEM: $resolved"
