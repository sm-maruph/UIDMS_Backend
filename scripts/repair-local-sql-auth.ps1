# Local setup: creates only a MISSING uidms_api login, maps its restored DB user,
# enables SQL authentication and saves the generated password without printing it.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskEnvPath=Join-Path $taskRoot '.env'
if(-not(Test-Path -LiteralPath $taskEnvPath)){throw 'Create backend/.env before applying this repair.'}
$taskEnv=[IO.File]::ReadAllText($taskEnvPath)
if($taskEnv -notmatch '(?m)^DB_NAME=CBC_UIDMS\r?$' -or $taskEnv -notmatch '(?m)^DB_USER=uidms_api\r?$' -or $taskEnv -notmatch '(?m)^DB_SERVER=(localhost|127\.0\.0\.1)\r?$'){throw 'Repair only supports the local CBC_UIDMS database and uidms_api login.'}
Write-Output 'Plan: create missing uidms_api, apply runtime permissions/remap restored user, enable Mixed Mode, update .env privately and restart MSSQLSERVER.'
if(-not $Apply){Write-Output 'Preview only. Use -Apply as administrator to run.';exit 0}
$taskConnection=New-Object System.Data.SqlClient.SqlConnection('Server=lpc:.;Database=master;Integrated Security=True;Encrypt=True;TrustServerCertificate=True;Connect Timeout=10')
$taskModePath='HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\'+(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').MSSQLSERVER+'\MSSQLServer'
$taskDependents=@((Get-Service -Name MSSQLSERVER).DependentServices | Where-Object {$_.Status -eq 'Running'} | Select-Object -ExpandProperty Name)
try{
 $taskConnection.Open()
 $taskCheck=$taskConnection.CreateCommand()
 $taskCheck.CommandText="SELECT COUNT(*) FROM sys.server_principals WHERE name=N'uidms_api'"
 if([int]$taskCheck.ExecuteScalar() -ne 0){throw 'Login already exists. Refusing to reset a configured login password.'}
 $taskRandom=New-Object byte[] 32
 $taskGenerator=[Security.Cryptography.RandomNumberGenerator]::Create()
 try{$taskGenerator.GetBytes($taskRandom)}finally{$taskGenerator.Dispose()}
 $taskPassword=[Convert]::ToBase64String($taskRandom)+'Aa1!'
 $taskSql=[IO.File]::ReadAllText((Join-Path $taskRoot 'sql\004-runtime-permissions.sql'))
 $taskPattern="(?m)^DECLARE @Password nvarchar\(128\)=N'[^\r\n]*';\r?$"
 if(-not[regex]::IsMatch($taskSql,$taskPattern)){throw 'Unrecognized permissions-script password declaration.'}
 $taskSql=[regex]::Replace($taskSql,$taskPattern,('DECLARE @Password nvarchar(128)=N'''+$taskPassword+''';'))
 foreach($taskBatch in [regex]::Split($taskSql,'(?im)^GO\s*$')){
  if($taskBatch.Trim()){
   $taskCommand=$taskConnection.CreateCommand();$taskCommand.CommandText=$taskBatch;$taskCommand.CommandTimeout=30
   try{$null=$taskCommand.ExecuteNonQuery()}catch{throw 'Runtime login/permission setup failed. No password is printed; inspect the database schema and DBA privileges.'}finally{$taskCommand.Dispose()}
  }
 }
 $taskUpdated=[regex]::Replace($taskEnv,'(?m)^DB_PASSWORD=.*$',('DB_PASSWORD='+$taskPassword))
 [IO.File]::WriteAllText($taskEnvPath,$taskUpdated,(New-Object Text.UTF8Encoding($false)))
 Set-ItemProperty -LiteralPath $taskModePath -Name LoginMode -Value 2
 Write-Output 'Runtime login created, restored user mapped, password saved privately in .env, Mixed Mode enabled.'
}finally{$taskConnection.Dispose()}
Restart-Service -Name MSSQLSERVER -Force
(Get-Service -Name MSSQLSERVER).WaitForStatus('Running',[TimeSpan]::FromSeconds(45))
foreach($taskService in $taskDependents){Start-Service -Name $taskService}
Write-Output 'SQL Server restarted. Run npm run db:check to verify application permissions.'
