[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern("^[A-Za-z0-9_.-]+$")]
    [string]$Account,

    [Parameter(Mandatory)]
    [ValidatePattern("^[A-Za-z0-9_.-]+$")]
    [string]$ProfileName,

    [Parameter(Mandatory)]
    [string]$GhConfigDir,

    [AllowEmptyString()]
    [string]$AllowedOwners = "",

    [AllowEmptyString()]
    [string]$AllowedRepositories = "",

    [Parameter(Mandatory)]
    [string]$AuditLogPath,

    [Parameter(Mandatory)]
    [string]$LogPath,

    [Parameter(Mandatory)]
    [ValidatePattern("^[A-Za-z0-9.-]+$")]
    [string]$Hostname,

    [Parameter(Mandatory)]
    [string]$GhPath,

    [string]$TaskName,
    [string]$WrapperPath = "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs",
    [string]$UserId = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = "Stop"
$expectedWrapperVersion = "onprem-gh-cli-mcp-wrapper-v2"

function Resolve-ExistingFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    if ($Path -notmatch "^[A-Za-z]:[\\/]") {
        throw "$Label must be an absolute path: $Path"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-ExistingDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    if ($Path -notmatch "^[A-Za-z]:[\\/]") {
        throw "$Label must be an absolute path: $Path"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label was not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\", "/")
}

function Resolve-OutputFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    if ($Path -notmatch "^[A-Za-z]:[\\/]") {
        throw "$Label must be an absolute path: $Path"
    }
    if ($Path.IndexOfAny([char[]]@('"', "`r", "`n", "`0")) -ge 0) {
        throw "$Label contains an unsafe character."
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "$Label parent directory was not found: $parent"
    }
    return $fullPath
}

function Normalize-Csv {
    param(
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory)][string]$ItemPattern,
        [Parameter(Mandatory)][string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $items = @($Value.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($item in $items) {
        if ($item -notmatch $ItemPattern) {
            throw "$Label contains an invalid value: $item"
        }
    }
    return (($items | Select-Object -Unique) -join ",").ToLowerInvariant()
}

function ConvertTo-QuotedTaskArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value.IndexOfAny([char[]]@('"', "`r", "`n", "`0")) -ge 0) {
        throw "A scheduled task argument contains an unsafe character."
    }
    if ($Value.EndsWith("\")) {
        throw "A scheduled task argument must not end with a path separator: $Value"
    }
    return '"{0}"' -f $Value
}

$resolvedWrapperPath = Resolve-ExistingFile -Path $WrapperPath -Label "VBS wrapper"
$cscriptPath = Join-Path $env:SystemRoot "System32\cscript.exe"
if (-not (Test-Path -LiteralPath $cscriptPath -PathType Leaf)) {
    throw "cscript.exe was not found: $cscriptPath"
}
$wrapperVersionOutput = @(& $cscriptPath //nologo $resolvedWrapperPath --version)
$wrapperVersionExitCode = $LASTEXITCODE
if (
    $wrapperVersionExitCode -ne 0 -or
    $wrapperVersionOutput.Count -ne 1 -or
    $wrapperVersionOutput[0] -cne $expectedWrapperVersion
) {
    throw "VBS wrapper handshake failed. Expected exact marker '$expectedWrapperVersion'. Copy the matching wrapper before registering the task."
}

$resolvedGhPath = Resolve-ExistingFile -Path $GhPath -Label "GitHub CLI"
$resolvedGhConfigDir = Resolve-ExistingDirectory -Path $GhConfigDir -Label "GH_CONFIG_DIR"
$resolvedAuditLogPath = Resolve-OutputFile -Path $AuditLogPath -Label "Audit log path"
$resolvedLogPath = Resolve-OutputFile -Path $LogPath -Label "Tunnel log path"
$normalizedOwners = Normalize-Csv -Value $AllowedOwners -ItemPattern "^[A-Za-z0-9_.-]+$" -Label "AllowedOwners"
$normalizedRepositories = Normalize-Csv -Value $AllowedRepositories -ItemPattern "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" -Label "AllowedRepositories"
$normalizedAccount = $Account.ToLowerInvariant()
$normalizedProfileName = $ProfileName.ToLowerInvariant()
$expectedProfileName = "gh-cli-$normalizedAccount"
$normalizedHostname = $Hostname.ToLowerInvariant()

if (-not $normalizedOwners -and -not $normalizedRepositories) {
    throw "Set at least one of AllowedOwners or AllowedRepositories."
}
if ($normalizedProfileName -cne $expectedProfileName) {
    throw "ProfileName must exactly match '$expectedProfileName' after case normalization."
}

$currentUserId = "$env:USERDOMAIN\$env:USERNAME"
if (
    [string]::IsNullOrWhiteSpace($env:USERDOMAIN) -or
    [string]::IsNullOrWhiteSpace($env:USERNAME) -or
    -not [string]::Equals($UserId, $currentUserId, [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw "UserId must be the current interactive user: $currentUserId"
}
$UserId = $currentUserId

if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = "OpenAI Secure MCP Tunnel - GH CLI - $Account"
}
if ($TaskName.IndexOfAny([char[]]@("`r", "`n", "`0")) -ge 0) {
    throw "TaskName contains an unsafe character."
}

$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "wscript.exe was not found: $wscriptPath"
}

$userRuntimeKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User")
$machineRuntimeKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Machine")
if (-not $userRuntimeKey -and -not $machineRuntimeKey) {
    throw "CONTROL_PLANE_API_KEY is not set in a persistent User or Machine environment. Do not store the key in this script or in scheduled task arguments."
}

$wrapperArguments = @(
    $resolvedWrapperPath,
    $normalizedAccount,
    $ProfileName,
    $resolvedGhConfigDir,
    $normalizedOwners,
    $normalizedRepositories,
    $resolvedAuditLogPath,
    $resolvedLogPath,
    $normalizedHostname,
    $resolvedGhPath
)
$actionArguments = ($wrapperArguments | ForEach-Object { ConvertTo-QuotedTaskArgument $_ }) -join " "

$action = New-ScheduledTaskAction `
    -Execute $wscriptPath `
    -Argument $actionArguments `
    -WorkingDirectory (Split-Path -Parent $resolvedWrapperPath)

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
    -Description "Runs GitHub CLI MCP for '$Account' with tunnel profile '$ProfileName' and an isolated GH_CONFIG_DIR." `
    -Force | Out-Null

Write-Output "Registered scheduled task: $TaskName"
Write-Output "Account: $Account"
Write-Output "Tunnel profile: $ProfileName"
Write-Output "GH_CONFIG_DIR: $resolvedGhConfigDir"
Write-Output "Run it with: Start-ScheduledTask -TaskName '$TaskName'"
