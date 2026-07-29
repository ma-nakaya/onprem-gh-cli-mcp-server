[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$AccountsFile,

    [ValidatePattern("^[A-Za-z0-9_.-]+$")]
    [string]$ProfileName = "gh-cli",

    [Parameter(Mandatory)]
    [string]$AuditLogPath,

    [Parameter(Mandatory)]
    [string]$LogPath,

    [Parameter(Mandatory)]
    [string]$GhPath,

    [AllowEmptyString()]
    [string]$AllowedHosts = "github.com",

    [string]$TaskName = "OpenAI Secure MCP Tunnel - GH CLI",
    [string]$WrapperPath = "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs",
    [string]$UserId = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
)

$ErrorActionPreference = "Stop"
$expectedWrapperVersion = "onprem-gh-cli-mcp-wrapper-v3"

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
    if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetFileName($fullPath))) {
        throw "$Label must name a file: $Path"
    }
    if (Test-Path -LiteralPath $fullPath) {
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "$Label must not be an existing directory or non-file path: $fullPath"
        }
        return (Resolve-Path -LiteralPath $fullPath).Path
    }
    $parent = Split-Path -Parent $fullPath
    if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "$Label parent directory was not found: $parent"
    }
    $resolvedParent = (Resolve-Path -LiteralPath $parent).Path
    return (Join-Path $resolvedParent ([System.IO.Path]::GetFileName($fullPath)))
}

function ConvertTo-PathForComparison {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path).Replace(
        [System.IO.Path]::AltDirectorySeparatorChar,
        [System.IO.Path]::DirectorySeparatorChar
    )
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::Equals(
        $fullPath,
        $root,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return $root
    }
    return $fullPath.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-PathIsEqual {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    return [string]::Equals(
        (ConvertTo-PathForComparison -Path $Left),
        (ConvertTo-PathForComparison -Path $Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-PathIsEqualToOrInsideDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Directory
    )

    $normalizedPath = ConvertTo-PathForComparison -Path $Path
    $normalizedDirectory = ConvertTo-PathForComparison -Path $Directory
    if ([string]::Equals(
        $normalizedPath,
        $normalizedDirectory,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return $true
    }
    if (-not $normalizedDirectory.EndsWith(
        [System.IO.Path]::DirectorySeparatorChar
    )) {
        $normalizedDirectory += [System.IO.Path]::DirectorySeparatorChar
    }
    return $normalizedPath.StartsWith(
        $normalizedDirectory,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-OutputPathSeparation {
    param(
        [Parameter(Mandatory)][string]$AuditPath,
        [Parameter(Mandatory)][string]$TunnelLogPath,
        [Parameter(Mandatory)][string[]]$ProtectedFiles,
        [Parameter(Mandatory)][string[]]$ConfigDirectories
    )

    if (Test-PathIsEqual -Left $AuditPath -Right $TunnelLogPath) {
        throw "AuditLogPath and LogPath must be distinct files."
    }
    foreach ($output in @(
        [pscustomobject]@{ Label = "AuditLogPath"; Path = $AuditPath },
        [pscustomobject]@{ Label = "LogPath"; Path = $TunnelLogPath }
    )) {
        foreach ($protectedFile in $ProtectedFiles) {
            if (Test-PathIsEqual -Left $output.Path -Right $protectedFile) {
                throw "$($output.Label) must not overwrite a manifest, wrapper, or executable: $($output.Path)"
            }
        }
        foreach ($configDirectory in $ConfigDirectories) {
            if (Test-PathIsEqualToOrInsideDirectory `
                -Path $output.Path `
                -Directory $configDirectory) {
                throw "$($output.Label) must not be equal to or inside a GH_CONFIG_DIR: $($output.Path)"
            }
        }
    }
}

function ConvertTo-QuotedTaskArgument {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value.IndexOfAny([char[]]@('"', "`r", "`n", "`0")) -ge 0) {
        throw "A scheduled task argument contains an unsafe character."
    }
    if ($Value.EndsWith("\")) {
        throw "A scheduled task argument must not end with a path separator: $Value"
    }
    return '"{0}"' -f $Value
}

function ConvertTo-NormalizedHostnameCsv {
    param(
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory)][string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Label must contain at least one hostname."
    }

    $normalized = @()
    foreach ($rawHostname in $Value.Split(",")) {
        $hostname = $rawHostname.Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($hostname)) {
            throw "$Label contains an empty hostname."
        }
        if ($hostname.Length -gt 253) {
            throw "$Label contains an invalid hostname: $hostname"
        }

        $labels = @($hostname.Split("."))
        if ($labels.Count -lt 2) {
            throw "$Label contains an invalid hostname: $hostname"
        }
        foreach ($hostnameLabel in $labels) {
            if (
                $hostnameLabel.Length -lt 1 -or
                $hostnameLabel.Length -gt 63 -or
                $hostnameLabel -notmatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$"
            ) {
                throw "$Label contains an invalid hostname: $hostname"
            }
        }

        if ($normalized -notcontains $hostname) {
            $normalized += $hostname
        }
    }
    return ($normalized -join ",")
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Expected,
        [Parameter(Mandatory)][string]$Label
    )

    if ($null -eq $Value -or $Value -isnot [psobject]) {
        throw "$Label must be a JSON object."
    }
    $actual = @($Value.PSObject.Properties.Name)
    $missing = @()
    foreach ($expectedProperty in $Expected) {
        $found = $false
        foreach ($actualProperty in $actual) {
            if ([string]::Equals(
                $expectedProperty,
                $actualProperty,
                [System.StringComparison]::Ordinal
            )) {
                $found = $true
                break
            }
        }
        if (-not $found) {
            $missing += $expectedProperty
        }
    }

    $unexpected = @()
    foreach ($actualProperty in $actual) {
        $found = $false
        foreach ($expectedProperty in $Expected) {
            if ([string]::Equals(
                $actualProperty,
                $expectedProperty,
                [System.StringComparison]::Ordinal
            )) {
                $found = $true
                break
            }
        }
        if (-not $found) {
            $unexpected += $actualProperty
        }
    }
    if ($missing.Count -gt 0) {
        throw "$Label is missing required properties: $($missing -join ', ')."
    }
    if ($unexpected.Count -gt 0) {
        throw "$Label contains unsupported properties: $($unexpected -join ', '). The accounts manifest must not contain credentials or tokens."
    }
}

function Get-ExactRootScheduledTask {
    param([Parameter(Mandatory)][string]$Name)

    try {
        $rootTasks = @(Get-ScheduledTask -TaskPath "\" -ErrorAction Stop)
    } catch {
        throw "Could not inspect root Scheduled Tasks before registration: $($_.Exception.Message)"
    }

    $nameMatches = @(
        $rootTasks | Where-Object {
            $_.TaskPath -ceq "\" -and
            [string]::Equals(
                [string]$_.TaskName,
                $Name,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
    )
    if ($nameMatches.Count -gt 1) {
        throw "Scheduled Task lookup is ambiguous for root task '$Name'."
    }
    if ($nameMatches.Count -eq 0) {
        return $null
    }
    if (-not [string]::Equals(
        [string]$nameMatches[0].TaskName,
        $Name,
        [System.StringComparison]::Ordinal
    )) {
        throw "A root Scheduled Task already exists with different name casing: $($nameMatches[0].TaskName)"
    }

    try {
        $exactMatches = @(
            Get-ScheduledTask -TaskPath "\" -TaskName $Name -ErrorAction Stop |
                Where-Object {
                    $_.TaskPath -ceq "\" -and
                    [string]::Equals(
                        [string]$_.TaskName,
                        $Name,
                        [System.StringComparison]::Ordinal
                    )
                }
        )
    } catch {
        throw "Could not re-read root Scheduled Task '$Name': $($_.Exception.Message)"
    }
    if ($exactMatches.Count -ne 1) {
        throw "Expected one exact root Scheduled Task named '$Name', found $($exactMatches.Count)."
    }
    return $exactMatches[0]
}

function Resolve-PrincipalSecurityIdentifier {
    param(
        [Parameter(Mandatory)][string]$PrincipalName,
        [Parameter(Mandatory)][string]$Label
    )

    try {
        if ($PrincipalName -match "^S-[0-9]+-[0-9]+(?:-[0-9]+)+$") {
            $securityIdentifier = New-Object `
                System.Security.Principal.SecurityIdentifier `
                -ArgumentList $PrincipalName
            return $securityIdentifier.Value
        }
        $account = New-Object System.Security.Principal.NTAccount -ArgumentList $PrincipalName
        return $account.Translate(
            [System.Security.Principal.SecurityIdentifier]
        ).Value
    } catch {
        throw "Could not resolve $Label principal '$PrincipalName' to a Windows security identifier."
    }
}

function Assert-ExistingTaskCanBeReplaced {
    param(
        [Parameter(Mandatory)]$ExistingTask,
        [Parameter(Mandatory)][string]$ExpectedUserId,
        [Parameter(Mandatory)][string]$ExpectedWscriptPath,
        [Parameter(Mandatory)][string]$ExpectedWrapperPath,
        [Parameter(Mandatory)][string]$ExpectedWorkingDirectory
    )

    if (-not [string]::Equals(
        [string]$ExistingTask.State,
        "Ready",
        [System.StringComparison]::Ordinal
    )) {
        throw "Scheduled Task '$($ExistingTask.TaskName)' must be exactly Ready before reinstalling; found '$($ExistingTask.State)'."
    }

    $expectedPrincipalSid = Resolve-PrincipalSecurityIdentifier `
        -PrincipalName $ExpectedUserId `
        -Label "expected"
    $existingPrincipalSid = Resolve-PrincipalSecurityIdentifier `
        -PrincipalName ([string]$ExistingTask.Principal.UserId) `
        -Label "existing task"
    if (
        $existingPrincipalSid -cne $expectedPrincipalSid -or
        -not [string]::Equals(
            [string]$ExistingTask.Principal.LogonType,
            "Interactive",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "Refusing to replace Scheduled Task '$($ExistingTask.TaskName)': it is not owned by the current interactive user."
    }

    $actions = @($ExistingTask.Actions)
    if ($actions.Count -ne 1) {
        throw "Refusing to replace Scheduled Task '$($ExistingTask.TaskName)': expected exactly one action."
    }
    $existingAction = $actions[0]
    if ($existingAction.CimClass.CimClassName -cne "MSFT_TaskExecAction") {
        throw "Refusing to replace Scheduled Task '$($ExistingTask.TaskName)': its only action is not an Exec action."
    }
    if (-not [string]::Equals(
        [string]$existingAction.Execute,
        $ExpectedWscriptPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to replace Scheduled Task '$($ExistingTask.TaskName)': its executable is not the resolved wscript.exe."
    }
    if (-not [string]::Equals(
        [string]$existingAction.WorkingDirectory,
        $ExpectedWorkingDirectory,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to replace Scheduled Task '$($ExistingTask.TaskName)': its working directory does not match the wrapper directory."
    }

    $firstArgument = [regex]::Match(
        [string]$existingAction.Arguments,
        '^"([^"\r\n]*)"(?=\s|$)',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if (
        -not $firstArgument.Success -or
        -not [string]::Equals(
            $firstArgument.Groups[1].Value,
            $ExpectedWrapperPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "Refusing to replace Scheduled Task '$($ExistingTask.TaskName)': its first quoted argument is not the resolved wrapper path."
    }
}

function Assert-StringProperty {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Pattern,
        [Parameter(Mandatory)][string]$Label
    )

    if ($Value -isnot [string] -or $Value -notmatch $Pattern) {
        throw "$Label is invalid."
    }
    return $Value.ToLowerInvariant()
}

function Normalize-JsonStringArray {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()]$Value,
        [Parameter(Mandatory)][string]$Pattern,
        [Parameter(Mandatory)][string]$Label
    )

    if ($Value -isnot [System.Array]) {
        throw "$Label must be a JSON array."
    }
    $normalized = @()
    foreach ($item in $Value) {
        if ($item -isnot [string] -or $item -notmatch $Pattern) {
            throw "$Label contains an invalid value."
        }
        $normalized += $item.ToLowerInvariant()
    }
    return @($normalized | Select-Object -Unique)
}

function Assert-GitHubCliCapabilities {
    param(
        [Parameter(Mandatory)][string]$GitHubCliPath,
        [Parameter(Mandatory)][string]$ConfigDirectory,
        [Parameter(Mandatory)][string]$Hostname
    )

    $environmentNames = @(
        "GH_CONFIG_DIR",
        "GH_HOST",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GH_REPO",
        "GH_HTTP_UNIX_SOCKET",
        "GITHUB_API_URL",
        "GITHUB_SERVER_URL",
        "GITHUB_GRAPHQL_URL",
        "GH_MCP_EXPECTED_LOGIN",
        "GH_MCP_ACCOUNT_HOST",
        "GH_MCP_ALLOWED_OWNERS",
        "GH_MCP_ALLOWED_REPOSITORIES",
        "GH_PROMPT_DISABLED",
        "NO_COLOR"
    )
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    try {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
        [Environment]::SetEnvironmentVariable("GH_CONFIG_DIR", $ConfigDirectory, "Process")
        [Environment]::SetEnvironmentVariable("GH_HOST", $Hostname, "Process")
        [Environment]::SetEnvironmentVariable("GH_PROMPT_DISABLED", "1", "Process")
        [Environment]::SetEnvironmentVariable("NO_COLOR", "1", "Process")

        $minimumVersion = [System.Version]"2.81.0"
        $versionLines = @(& $GitHubCliPath --version 2>$null)
        $versionExitCode = $LASTEXITCODE
        if ($versionExitCode -ne 0 -or $versionLines.Count -lt 1) {
            throw "Could not determine the GitHub CLI version."
        }

        $versionMatch = [regex]::Match(
            [string]$versionLines[0],
            '^gh version ([0-9]+)\.([0-9]+)\.([0-9]+)(?:\s|$)',
            [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
        if (-not $versionMatch.Success) {
            throw "GitHub CLI returned an unrecognized version string: $($versionLines[0])"
        }
        $detectedVersion = [System.Version](
            "$($versionMatch.Groups[1].Value).$($versionMatch.Groups[2].Value).$($versionMatch.Groups[3].Value)"
        )
        if ($detectedVersion -lt $minimumVersion) {
            throw "GitHub CLI $minimumVersion or later is required for 'gh auth status --json hosts'; found $detectedVersion."
        }

        $authStatusHelp = (& $GitHubCliPath auth status --help 2>&1 | Out-String)
        $helpExitCode = $LASTEXITCODE
        if (
            $helpExitCode -ne 0 -or
            $authStatusHelp -notmatch "(?m)(?:^|\s)--json(?:[=\s]|$)"
        ) {
            throw "This GitHub CLI does not advertise the required 'gh auth status --json' capability."
        }
    } finally {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
        }
    }
}

function Test-AccountAuthentication {
    param(
        [Parameter(Mandatory)][string]$GitHubCliPath,
        [Parameter(Mandatory)][string]$ConfigDirectory,
        [Parameter(Mandatory)][string]$Hostname,
        [Parameter(Mandatory)][string]$ExpectedLogin,
        [Parameter(Mandatory)][string]$AccountId
    )

    $environmentNames = @(
        "GH_CONFIG_DIR",
        "GH_HOST",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GH_REPO",
        "GH_HTTP_UNIX_SOCKET",
        "GITHUB_API_URL",
        "GITHUB_SERVER_URL",
        "GITHUB_GRAPHQL_URL",
        "GH_MCP_EXPECTED_LOGIN",
        "GH_MCP_ACCOUNT_HOST",
        "GH_MCP_ALLOWED_OWNERS",
        "GH_MCP_ALLOWED_REPOSITORIES",
        "GH_PROMPT_DISABLED",
        "NO_COLOR"
    )
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    try {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
        [Environment]::SetEnvironmentVariable("GH_CONFIG_DIR", $ConfigDirectory, "Process")
        [Environment]::SetEnvironmentVariable("GH_HOST", $Hostname, "Process")
        [Environment]::SetEnvironmentVariable("GH_PROMPT_DISABLED", "1", "Process")
        [Environment]::SetEnvironmentVariable("NO_COLOR", "1", "Process")

        $statusJson = (& $GitHubCliPath auth status --json hosts 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($statusJson)) {
            throw "GitHub CLI authentication check failed for account '$AccountId'."
        }
        try {
            $status = $statusJson | ConvertFrom-Json
        } catch {
            throw "GitHub CLI returned invalid authentication status JSON for account '$AccountId'."
        }

        $hostProperties = @($status.hosts.PSObject.Properties)
        if ($hostProperties.Count -ne 1) {
            throw "Account '$AccountId' must use a GH_CONFIG_DIR containing exactly one GitHub hostname."
        }
        $hostProperty = $hostProperties[0]
        if ($hostProperty.Name -cne $Hostname) {
            throw "Account '$AccountId' has unexpected GitHub hostname '$($hostProperty.Name)'; expected '$Hostname'."
        }
        $entries = @($hostProperty.Value)
        if ($entries.Count -ne 1) {
            throw "Account '$AccountId' must use a GH_CONFIG_DIR containing exactly one GitHub account."
        }
        $entry = $entries[0]
        if (
            $entry.state -cne "success" -or
            $entry.active -ne $true -or
            -not [string]::Equals([string]$entry.login, $ExpectedLogin, [System.StringComparison]::OrdinalIgnoreCase)
        ) {
            throw "Account '$AccountId' is not active and healthy as expected login '$ExpectedLogin'."
        }

        $actualLogin = (& $GitHubCliPath api user --hostname $Hostname --jq .login 2>$null | Out-String).Trim()
        if (
            $LASTEXITCODE -ne 0 -or
            -not [string]::Equals($actualLogin, $ExpectedLogin, [System.StringComparison]::OrdinalIgnoreCase)
        ) {
            throw "Account '$AccountId' failed the authenticated user check for expected login '$ExpectedLogin'."
        }
    } finally {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
        }
    }
}

$normalizedAllowedHosts = ConvertTo-NormalizedHostnameCsv `
    -Value $AllowedHosts `
    -Label "AllowedHosts"
$allowedHostLookup = @{}
foreach ($allowedHostname in $normalizedAllowedHosts.Split(",")) {
    $allowedHostLookup[$allowedHostname] = $true
}

$resolvedWrapperPath = Resolve-ExistingFile -Path $WrapperPath -Label "VBS wrapper"
$resolvedWrapperDirectory = Resolve-ExistingDirectory `
    -Path (Split-Path -Parent $resolvedWrapperPath) `
    -Label "VBS wrapper directory"
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

$resolvedAccountsFile = Resolve-ExistingFile -Path $AccountsFile -Label "Accounts manifest"
$resolvedGhPath = Resolve-ExistingFile -Path $GhPath -Label "GitHub CLI"
$resolvedAuditLogPath = Resolve-OutputFile -Path $AuditLogPath -Label "Audit log path"
$resolvedLogPath = Resolve-OutputFile -Path $LogPath -Label "Tunnel log path"

try {
    $manifest = Get-Content -LiteralPath $resolvedAccountsFile -Raw | ConvertFrom-Json
} catch {
    throw "Accounts manifest is not valid JSON: $resolvedAccountsFile"
}
Assert-ExactProperties -Value $manifest -Expected @("version", "accounts") -Label "Accounts manifest"
if ($manifest.version -isnot [int] -or $manifest.version -ne 1) {
    throw "Accounts manifest version must be 1."
}
if ($manifest.accounts -isnot [System.Array] -or $manifest.accounts.Count -lt 1) {
    throw "Accounts manifest must contain a non-empty accounts array."
}

$seenIds = @{}
$seenLogins = @{}
$seenConfigDirectories = @{}
$validatedAccounts = @()
foreach ($account in $manifest.accounts) {
    Assert-ExactProperties `
        -Value $account `
        -Expected @("id", "expectedLogin", "hostname", "configDir", "allowedOwners", "allowedRepositories") `
        -Label "Account entry"

    $id = Assert-StringProperty -Value $account.id -Pattern "^[A-Za-z0-9_.-]+$" -Label "Account id"
    $expectedLogin = Assert-StringProperty -Value $account.expectedLogin -Pattern "^[A-Za-z0-9_.-]+$" -Label "Expected login for '$id'"
    if ($id.Length -gt 100 -or $expectedLogin.Length -gt 100) {
        throw "Account id and expectedLogin must not exceed 100 characters."
    }
    $hostname = Assert-StringProperty -Value $account.hostname -Pattern "^[A-Za-z0-9.-]+$" -Label "Hostname for '$id'"
    if (-not $allowedHostLookup.ContainsKey($hostname)) {
        throw "Hostname '$hostname' for account '$id' is not in the independent AllowedHosts boundary."
    }
    if ($account.configDir -isnot [string]) {
        throw "configDir for '$id' must be a string."
    }
    $configDirectory = Resolve-ExistingDirectory -Path $account.configDir -Label "configDir for '$id'"
    $owners = @(Normalize-JsonStringArray -Value $account.allowedOwners -Pattern "^[A-Za-z0-9_.-]+$" -Label "allowedOwners for '$id'")
    $repositories = @(Normalize-JsonStringArray -Value $account.allowedRepositories -Pattern "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" -Label "allowedRepositories for '$id'")

    if ($owners.Count -eq 0 -and $repositories.Count -eq 0) {
        throw "Account '$id' must allow at least one owner or repository."
    }
    if ($seenIds.ContainsKey($id)) {
        throw "Accounts manifest contains duplicate id '$id'."
    }
    if ($seenLogins.ContainsKey("$hostname/$expectedLogin")) {
        throw "Accounts manifest contains duplicate login '$expectedLogin' for '$hostname'."
    }
    if ($seenConfigDirectories.ContainsKey($configDirectory)) {
        throw "Each account must use a separate GH_CONFIG_DIR. Duplicate: $configDirectory"
    }

    $seenIds[$id] = $true
    $seenLogins["$hostname/$expectedLogin"] = $true
    $seenConfigDirectories[$configDirectory] = $true
    $validatedAccounts += [pscustomobject]@{
        Id = $id
        ExpectedLogin = $expectedLogin
        Hostname = $hostname
        ConfigDirectory = $configDirectory
    }
}

Assert-OutputPathSeparation `
    -AuditPath $resolvedAuditLogPath `
    -TunnelLogPath $resolvedLogPath `
    -ProtectedFiles @($resolvedAccountsFile, $resolvedWrapperPath, $resolvedGhPath) `
    -ConfigDirectories @($validatedAccounts.ConfigDirectory)

Assert-GitHubCliCapabilities `
    -GitHubCliPath $resolvedGhPath `
    -ConfigDirectory $validatedAccounts[0].ConfigDirectory `
    -Hostname $validatedAccounts[0].Hostname

foreach ($account in $validatedAccounts) {
    Test-AccountAuthentication `
        -GitHubCliPath $resolvedGhPath `
        -ConfigDirectory $account.ConfigDirectory `
        -Hostname $account.Hostname `
        -ExpectedLogin $account.ExpectedLogin `
        -AccountId $account.Id
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if (
    $null -eq $currentIdentity -or
    $null -eq $currentIdentity.User -or
    [string]::IsNullOrWhiteSpace($currentIdentity.Name)
) {
    throw "Could not resolve the current Windows process-token identity."
}
$currentUserId = $currentIdentity.Name
$currentUserSid = $currentIdentity.User.Value
$requestedUserSid = Resolve-PrincipalSecurityIdentifier `
    -PrincipalName $UserId `
    -Label "requested"
if ($requestedUserSid -cne $currentUserSid) {
    throw "UserId must resolve to the current Windows process-token identity: $currentUserId"
}
$UserId = $currentUserId

if ([string]::IsNullOrWhiteSpace($TaskName)) {
    throw "TaskName must not be empty."
}
if ($TaskName.IndexOfAny([char[]]@("`r", "`n", "`0")) -ge 0) {
    throw "TaskName contains an unsafe character."
}

$resolvedWscriptPath = Resolve-ExistingFile `
    -Path (Join-Path $env:SystemRoot "System32\wscript.exe") `
    -Label "wscript.exe"

$userRuntimeKey = [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User")
if (-not $userRuntimeKey) {
    throw "CONTROL_PLANE_API_KEY is not set in the current User's persistent environment. Machine-level persistence is not accepted. Do not store the key in this script or in scheduled task arguments."
}

$wrapperArguments = @(
    $resolvedWrapperPath,
    $ProfileName,
    $resolvedAccountsFile,
    $normalizedAllowedHosts,
    $resolvedAuditLogPath,
    $resolvedLogPath,
    $resolvedGhPath
)
$actionArguments = ($wrapperArguments | ForEach-Object { ConvertTo-QuotedTaskArgument $_ }) -join " "

$action = New-ScheduledTaskAction `
    -Execute $resolvedWscriptPath `
    -Argument $actionArguments `
    -WorkingDirectory $resolvedWrapperDirectory

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

$registrationParameters = @{
    TaskPath = "\"
    TaskName = $TaskName
    Action = $action
    Trigger = $trigger
    Settings = $settings
    Principal = $principal
    Description = "Runs one GitHub CLI MCP process for all accounts in the validated non-secret manifest with tunnel profile '$ProfileName'."
}
$existingTask = Get-ExactRootScheduledTask -Name $TaskName
if ($null -eq $existingTask) {
    Register-ScheduledTask @registrationParameters | Out-Null
} else {
    Assert-ExistingTaskCanBeReplaced `
        -ExistingTask $existingTask `
        -ExpectedUserId $UserId `
        -ExpectedWscriptPath $resolvedWscriptPath `
        -ExpectedWrapperPath $resolvedWrapperPath `
        -ExpectedWorkingDirectory $resolvedWrapperDirectory
    Register-ScheduledTask @registrationParameters -Force | Out-Null
}

Write-Output "Registered scheduled task: $TaskName"
Write-Output "Tunnel profile: $ProfileName"
Write-Output "Allowed hosts: $normalizedAllowedHosts"
Write-Output "Accounts manifest: $resolvedAccountsFile"
Write-Output "Validated accounts: $(($validatedAccounts.Id) -join ', ')"
Write-Output "Run it with: Start-ScheduledTask -TaskName '$TaskName'"
