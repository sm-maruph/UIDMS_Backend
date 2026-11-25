#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$DnsName = 'uidms.combankbd.com',
    [string]$ExportDirectory = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'CBC-UIDMS-Certificates')
)
$ErrorActionPreference = 'Stop'
# Run on the IIS hosting PC, not a development workstation.
# Creates only a UIDMS certificate; does not change IIS bindings or other sites.
$certificate = New-SelfSignedCertificate -DnsName $DnsName `
    -Type SSLServerAuthentication -CertStoreLocation 'Cert:\LocalMachine\My' `
    -FriendlyName "CBC UIDMS HTTPS ($DnsName)" `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1)
New-Item -ItemType Directory -Path $ExportDirectory -Force | Out-Null
$publicCertificatePath = Join-Path $ExportDirectory "$DnsName-$($certificate.Thumbprint).cer"
Export-Certificate -Cert $certificate -FilePath $publicCertificatePath | Out-Null
[pscustomobject]@{
    Hostname = $DnsName
    FriendlyName = $certificate.FriendlyName
    Thumbprint = $certificate.Thumbprint
    Store = 'Local Computer / Personal (Cert:\LocalMachine\My)'
    PublicCertificate = $publicCertificatePath
    Expires = $certificate.NotAfter
}
