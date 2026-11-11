param([string]$Certificate = "certs\dev-ca.pem")
$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $Certificate).Path
Import-Certificate -FilePath $resolved -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
Write-Host "Trusted development CA for the current Windows user: $resolved"
