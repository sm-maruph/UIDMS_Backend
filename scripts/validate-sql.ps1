param(
  [string]$ScriptDomPath = 'C:\Program Files\Microsoft SQL Server Management Studio 22\Release\Common7\IDE\Extensions\Application\Microsoft.SqlServer.TransactSql.ScriptDom.dll'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ScriptDomPath)) { throw 'Supply -ScriptDomPath for the Microsoft SQL Server ScriptDom assembly installed with SSMS.' }
Add-Type -Path $ScriptDomPath
$taskParser = New-Object Microsoft.SqlServer.TransactSql.ScriptDom.TSql160Parser($true)
$taskSqlRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\sql'))
$taskFailed = $false
foreach ($taskFile in Get-ChildItem -LiteralPath $taskSqlRoot -Filter '*.sql') {
  $taskReader = New-Object System.IO.StringReader([System.IO.File]::ReadAllText($taskFile.FullName))
  $taskErrors = $null
  $null = $taskParser.Parse($taskReader, [ref]$taskErrors)
  $taskReader.Dispose()
  if ($taskErrors.Count -gt 0) {
    $taskFailed = $true
    foreach ($taskError in $taskErrors) { Write-Output ($taskFile.Name + ':' + $taskError.Line + ': ' + $taskError.Message) }
  } else { Write-Output ($taskFile.Name + ': SQL Server syntax passed') }
}
if ($taskFailed) { exit 1 }
# Syntax validation only. This script never connects to or modifies a SQL Server.
