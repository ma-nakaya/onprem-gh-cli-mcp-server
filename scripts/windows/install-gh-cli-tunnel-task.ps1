[CmdletBinding()]
param(
    [string]$TaskName = "OpenAI Secure MCP Tunnel - GH CLI",
    [string]$WrapperPath = "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs",
    [string]$UserId = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $WrapperPath -PathType Leaf)) {
    throw "VBS wrapper was not found: $WrapperPath"
}

$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "wscript.exe was not found: $wscriptPath"
}

$userRuntimeKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User")
$machineRuntimeKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Machine")
if (-not $userRuntimeKey -and -not $machineRuntimeKey) {
    throw "CONTROL_PLANE_API_KEY is not set in a persistent User or Machine environment. Do not store the key in this script."
}

$action = New-ScheduledTaskAction `
    -Execute $wscriptPath `
    -Argument ('"{0}"' -f $WrapperPath) `
    -WorkingDirectory (Split-Path -Parent $WrapperPath)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Runs the on-prem GitHub CLI MCP Secure MCP Tunnel without a visible console window." `
    -Force | Out-Null

Write-Output "Registered scheduled task: $TaskName"
Write-Output "Run it with: Start-ScheduledTask -TaskName '$TaskName'"
