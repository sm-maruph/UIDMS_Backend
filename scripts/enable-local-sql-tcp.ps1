# Local development repair only. Requires an elevated Windows PowerShell session.
# Does not change database contents, logins, passwords, or firewall rules.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$taskInstanceId=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').MSSQLSERVER
if(-not $taskInstanceId){throw 'Default MSSQLSERVER instance not found.'}
$taskTcpPath='HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\'+$taskInstanceId+'\MSSQLServer\SuperSocketNetLib\Tcp'
$taskTcp=Get-ItemProperty -LiteralPath $taskTcpPath
$taskAddresses=@(Get-ChildItem -LiteralPath $taskTcpPath | ForEach-Object {
 $taskValue=Get-ItemProperty -LiteralPath $_.PSPath
 if($_.PSChildName -ne 'IPAll'){
  [PSCustomObject]@{Key=$_.PSChildName;Address=$taskValue.IpAddress;Enabled=$taskValue.Enabled;TcpPort=$taskValue.TcpPort;TcpDynamicPorts=$taskValue.TcpDynamicPorts}
 }
})
$taskLoopbacks=@($taskAddresses | Where-Object {$_.Address -in @('127.0.0.1','::1')})
if(-not $taskLoopbacks.Count){throw 'No existing SQL loopback address configuration found.'}
if($taskTcp.Enabled -ne 0){throw 'TCP/IP is already enabled. Refusing to replace an existing network configuration; diagnose its listener instead.'}
if(@($taskAddresses | Where-Object {$_.Enabled -eq 1}).Count){throw 'Existing enabled address settings require manual review before this local-only repair.'}
Write-Output ('Instance: MSSQLSERVER ('+$taskInstanceId+')')
Write-Output 'Planned repair: enable TCP/IP on loopback addresses only, port 1433, and restart MSSQLSERVER.'
if(-not $Apply){Write-Output 'Preview only. Run with -Apply as administrator to perform the repair.';exit 0}
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$taskPrincipal=New-Object Security.Principal.WindowsPrincipal($taskIdentity)
if(-not $taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run Windows PowerShell as Administrator.'}
$taskListener=Get-NetTCPConnection -State Listen -LocalPort 1433 -ErrorAction SilentlyContinue
if($taskListener){throw 'Port 1433 is already in use. No settings changed.'}
$taskBackupDirectory=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tmp'))
$null=New-Item -ItemType Directory -Path $taskBackupDirectory -Force
$taskBackupPath=Join-Path $taskBackupDirectory ('sql-tcp-before-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'.json')
@{InstanceId=$taskInstanceId;Enabled=$taskTcp.Enabled;ListenOnAllIPs=$taskTcp.ListenOnAllIPs;Addresses=$taskAddresses} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskBackupPath -Encoding UTF8
$taskDependents=@((Get-Service -Name MSSQLSERVER).DependentServices | Where-Object {$_.Status -eq 'Running'} | Select-Object -ExpandProperty Name)
Set-ItemProperty -LiteralPath $taskTcpPath -Name ListenOnAllIPs -Value 0
foreach($taskAddress in $taskLoopbacks){
 $taskAddressPath=$taskTcpPath+'\'+$taskAddress.Key
 Set-ItemProperty -LiteralPath $taskAddressPath -Name TcpPort -Value '1433'
 Set-ItemProperty -LiteralPath $taskAddressPath -Name TcpDynamicPorts -Value ''
 Set-ItemProperty -LiteralPath $taskAddressPath -Name Enabled -Value 1
}
Set-ItemProperty -LiteralPath $taskTcpPath -Name Enabled -Value 1
Restart-Service -Name MSSQLSERVER -Force
(Get-Service -Name MSSQLSERVER).WaitForStatus('Running',[TimeSpan]::FromSeconds(45))
foreach($taskService in $taskDependents){Start-Service -Name $taskService}
$taskReady=$false
for($taskAttempt=0;$taskAttempt -lt 15;$taskAttempt++){
 $taskClient=New-Object Net.Sockets.TcpClient
 try{$taskClient.Connect('127.0.0.1',1433);$taskReady=$true;break}catch{Start-Sleep -Milliseconds 500}finally{$taskClient.Dispose()}
}
if(-not $taskReady){throw ('SQL restarted but port 1433 is not listening. Inspect SQL Server ERRORLOG. Original settings saved in '+$taskBackupPath)}
Write-Output 'Verified: SQL Server accepts local TCP connections on 127.0.0.1:1433.'
Write-Output ('Original settings saved in '+$taskBackupPath)
