# ChatGPT connectivity check with Secure MCP Tunnel

This runbook connects one locally built stdio MCP server to ChatGPT without publishing the npm package first. One MCP process, one Tunnel profile, one Scheduled Task, and one ChatGPT app serve every configured GitHub account.

GitHub CLI credentials remain isolated. Each account has its own `GH_CONFIG_DIR`, while the MCP server selects the corresponding directory for each request from a non-secret manifest. It never runs `gh auth switch` and never changes GitHub CLI's active account.

Official references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [GitHub CLI: using multiple accounts](https://docs.github.com/en/github-cli/github-cli/using-multiple-accounts)
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)

## 1. Prerequisites

- ChatGPT Developer mode access for the target workspace.
- One Secure MCP Tunnel endpoint associated with both the Platform organization and target ChatGPT workspace.
- `Tunnels Read + Use` permission for the operator.
- A runtime API key authorized to run that tunnel endpoint.
- Outbound HTTPS access to `api.openai.com:443` (`/v1/tunnel/*`).
- Node.js 20 or later.
- GitHub CLI 2.81.0 or later. The installer requires `gh auth status --json hosts`.
- `tunnel-client.exe` obtained from Platform tunnel settings or the latest official release.

Scheduled Task operation intentionally persists the runtime API key in the current User's environment. Machine-level persistence is not accepted, and the VBS copies only the User value into the child process. Never put that key in this repository, the account manifest, wrapper arguments, Scheduled Task arguments, logs, command-history files, screenshots, or Notion; protect the User environment according to your OS security policy. If stronger protection is required, replace this persistent-environment launcher with an approved and reviewed secret-broker launcher. GitHub CLI credentials belong only in the OS credential store and the dedicated per-account `GH_CONFIG_DIR`, never in the manifest or task arguments. A Tunnel ID is an identifier rather than a credential and must appear in the `tunnel-client init` command, but do not commit it or share it beyond the intended tunnel operators.

## 2. Build and verify stdio locally

Run from the repository root in PowerShell:

```powershell
npm ci
npm run check
npm test
npm run build
npm run smoke:stdio
```

The smoke test should report that tool discovery passed. Directly running `node dist/cli.js` normally prints nothing and waits for MCP input. That is expected for a stdio MCP server.

## 3. Authenticate each account in a separate GH_CONFIG_DIR

Create one new GitHub CLI configuration directory per credential, outside the repository. The helper refuses an existing non-empty directory so an ambient or previously shared `hosts.yml` is not accepted accidentally:

```powershell
function New-EmptyGhConfigDirectory {
  param([Parameter(Mandatory)][string]$Path)

  if (Test-Path -LiteralPath $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
      throw "GH_CONFIG_DIR is not a directory: $Path"
    }
    $existingEntry = Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1
    if ($null -ne $existingEntry) {
      throw "GH_CONFIG_DIR must be new or empty: $Path"
    }
    return
  }
  [System.IO.Directory]::CreateDirectory($Path) | Out-Null
}

$ghConfigRoot = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\gh"
$maGhConfig = Join-Path $ghConfigRoot "ma-nakaya"
$masaGhConfig = Join-Path $ghConfigRoot "masa-nakaya"
New-EmptyGhConfigDirectory $maGhConfig
New-EmptyGhConfigDirectory $masaGhConfig
```

Authenticate only `ma-nakaya` in the first directory. Confirm the login in the browser account picker before authorizing GitHub CLI:

```powershell
$env:GH_CONFIG_DIR = $maGhConfig
gh auth login --hostname github.com --web
gh auth status --hostname github.com
gh api user --hostname github.com --jq .login
# Expected: ma-nakaya
```

Authenticate only `masa-nakaya` in the second directory:

```powershell
$env:GH_CONFIG_DIR = $masaGhConfig
gh auth login --hostname github.com --web
gh auth status --hostname github.com
gh api user --hostname github.com --jq .login
# Expected: masa-nakaya

Remove-Item Env:GH_CONFIG_DIR
```

Each directory must contain exactly one healthy, active account and `gh api user` must return its expected login. Do not add both accounts to one directory. The directories may contain sensitive credential metadata and, when the OS credential store is unavailable, credentials. Protect them with the current user's filesystem permissions.

The running MCP server does not use `gh auth switch`. Do not run `gh auth login`, `gh auth logout`, or `gh auth switch` against either dedicated directory while the server is running. Stop the single Tunnel task first, make the credential change, re-run the installer validation, and restart the task.

## 4. Create the non-secret account manifest

`GH_MCP_ACCOUNTS_FILE` points to an absolute JSON path. Version 1 has this exact shape:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "ma-nakaya",
      "expectedLogin": "ma-nakaya",
      "hostname": "github.com",
      "configDir": "C:\\Users\\USER\\AppData\\Local\\onprem-gh-cli-mcp\\gh\\ma-nakaya",
      "allowedOwners": ["ma-nakaya"],
      "allowedRepositories": []
    },
    {
      "id": "masa-nakaya",
      "expectedLogin": "masa-nakaya",
      "hostname": "github.com",
      "configDir": "C:\\Users\\USER\\AppData\\Local\\onprem-gh-cli-mcp\\gh\\masa-nakaya",
      "allowedOwners": ["masa-nakaya"],
      "allowedRepositories": []
    }
  ]
}
```

Create it without a UTF-8 byte-order mark:

```powershell
$manifestPath = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\accounts.json"
$manifest = [ordered]@{
  version = 1
  accounts = @(
    [ordered]@{
      id = "ma-nakaya"
      expectedLogin = "ma-nakaya"
      hostname = "github.com"
      configDir = $maGhConfig
      allowedOwners = @("ma-nakaya")
      allowedRepositories = @()
    },
    [ordered]@{
      id = "masa-nakaya"
      expectedLogin = "masa-nakaya"
      hostname = "github.com"
      configDir = $masaGhConfig
      allowedOwners = @("masa-nakaya")
      allowedRepositories = @()
    }
  )
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $manifestPath)) | Out-Null
[System.IO.File]::WriteAllText(
  $manifestPath,
  $manifestJson,
  [System.Text.UTF8Encoding]::new($false)
)
```

The manifest contains identifiers, allowlists, and paths only. Never add a token, password, runtime API key, SSH private key, or other credential. Account IDs must be unique, every `configDir` must be an absolute and distinct directory, and each account must have at least one allowed owner or repository.

When more than one account is configured, every account-aware MCP tool call must specify `account`. `hostname`, when supplied, must match the selected account profile. The Owner and Repository allowlists authorize resources; they do not choose an account.

## 5. Create one stdio Tunnel profile

Replace the repository path and Tunnel ID with local values:

```powershell
tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli `
  --tunnel-id <tunnel-id> `
  --health-listen-addr "127.0.0.1:8081" `
  --mcp-command "node C:/Workspace/onprem-gh-cli-mcp-server/dist/cli.js"

tunnel-client.exe doctor --profile gh-cli --explain
```

The profile stores the stdio command and Tunnel ID. It does not store GitHub credentials or account-specific settings.

## 6. Run the single profile manually

Create one audit directory and set the process-scoped configuration:

```powershell
$auditDir = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit"
New-Item -ItemType Directory -Force $auditDir | Out-Null

$env:GH_MCP_ACCOUNTS_FILE = $manifestPath
$env:GH_MCP_ALLOWED_HOSTS = "github.com"
$env:GH_MCP_AUDIT_LOG_PATH = Join-Path $auditDir "audit.jsonl"
$env:GH_MCP_GH_PATH = (Get-Command gh.exe).Source
foreach ($ambientName in @(
  "GH_MCP_EXPECTED_LOGIN",
  "GH_MCP_ACCOUNT_HOST",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_MCP_ALLOWED_OWNERS",
  "GH_MCP_ALLOWED_REPOSITORIES"
)) {
  Remove-Item "Env:$ambientName" -ErrorAction SilentlyContinue
}

$secureKey = Read-Host "Runtime API Key" -AsSecureString
$env:CONTROL_PLANE_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password

tunnel-client.exe run `
  --profile gh-cli `
  --log.file="C:\Apps\TunnelClient\gh-cli-tunnel-client.log"
```

Keep this one `tunnel-client run` process healthy during discovery and testing. Its local admin UI and readiness endpoint are `http://127.0.0.1:8081/ui` and `http://127.0.0.1:8081/readyz`.

Do not combine `GH_MCP_ACCOUNTS_FILE` with the legacy `GH_MCP_EXPECTED_LOGIN`, `GH_MCP_ACCOUNT_HOST`, `GH_CONFIG_DIR`, `GH_MCP_ALLOWED_OWNERS`, or `GH_MCP_ALLOWED_REPOSITORIES` variables. The server rejects that ambiguous configuration.

## 7. Create one draft app in ChatGPT

1. Enable Developer mode for the target ChatGPT account.
2. Open **Settings → Plugins** (or `chatgpt.com/plugins`).
3. Select the plus button and choose **Tunnel** as the connection type.
4. Select the `gh-cli` tunnel and run **Scan Tools**.
5. Name the draft app `GitHub CLI`.
6. Do not publish it during initial connectivity testing.

If the tunnel is missing, verify its ChatGPT workspace association and the operator's `Tunnels Read + Use` permission.

## 8. Connectivity and identity tests

Use the same app for both accounts, but pass an account ID on every call:

```text
GitHub CLI の list_accounts を実行し、ma-nakaya と masa-nakaya が選択可能であることを、credentialや設定パスを表示せず確認してください。
```

```text
GitHub CLI の get_auth_status を account=ma-nakaya で実行し、期待loginと実loginが ma-nakaya で一致することを、トークンを表示せず確認してください。
```

```text
GitHub CLI の get_auth_status を account=masa-nakaya で実行し、期待loginと実loginが masa-nakaya で一致することを、トークンを表示せず確認してください。
```

Then test permitted reads through the same app:

```text
account=ma-nakaya を使って、ma-nakaya/onprem-gh-cli-mcp-server の最新Issueを3件、本文なしで取得してください。
```

If that account cannot read a target and another configured account may have access, repeat the read with the other `account` value. This is a new MCP invocation using another isolated `GH_CONFIG_DIR`; it is not `gh auth switch`. Do not retry a write under another account, because that would change its GitHub attribution.

Confirm that:

- Only one draft app and one Tunnel profile are selected.
- `list_accounts` returns both configured account IDs without credential paths.
- Both account-specific `get_auth_status` calls succeed through that app.
- Omitting `account` is rejected while more than one account is configured.
- An Owner or Repository outside the selected account's allowlist is rejected.
- The returned and audited account matches the requested account.
- No GitHub token or secret appears in responses, process arguments, or logs.
- One tunnel admin UI shows requests for both accounts.
- One audit log records the selected account for each operation.

Only after read-only checks pass, test a write against a disposable repository allowed by the selected account. Review the confirmation modal, account ID, expected login, and exact target before approving it. Never fall back to another account for a write.

## 9. Later switch to pinned npx startup

After the npm package is published, the same single profile can run a reviewed, pinned version:

```powershell
npx.cmd --yes --prefer-offline @ma-nakaya/onprem-gh-cli-mcp@0.1.0
```

The npm package scope does not select the GitHub authentication account. Selection comes from the tool's `account` input and the manifest. Do not use `@latest`. Re-run `doctor`, **Scan Tools**, both identity checks, and the read-only tests after changing the command or tool definitions.

## 10. Run without a visible console window

The v3 Windows Script Host wrapper in `scripts/windows/run-gh-cli-mcp-tunnel.vbs` starts one Tunnel profile with window style `0`, waits for it, and returns its exit code. It passes only the manifest path and other non-secret settings. It removes ambient GitHub token and active-account variables before starting the Tunnel process.

### Remove account-specific v2 launchers

Do not unregister a task merely because its name matches an old launcher. The following migration block resolves root tasks with exact names and validates the current interactive principal, one `wscript.exe` Exec action, the wrapper working directory, and the complete quoted v2 argument shape. It stops and unregisters only tasks that pass those checks; any mismatch aborts without unregistering that task.

```powershell
$oldWrapperPath = (Resolve-Path -LiteralPath `
  "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs").Path
$oldWrapperDirectory = Split-Path -Parent $oldWrapperPath
$resolvedWscriptPath = (Resolve-Path -LiteralPath `
  (Join-Path $env:SystemRoot "System32\wscript.exe")).Path
$oldGhConfigRoot = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\gh"
$oldAuditDirectory = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit"
$oldGhPath = (Get-Command gh.exe -ErrorAction Stop).Source
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$currentUserId = $currentIdentity.Name
$currentUserSid = $currentIdentity.User.Value
$oldTaskSpecs = @(
  [pscustomobject]@{
    TaskName = "OpenAI Secure MCP Tunnel - GH CLI - ma-nakaya"
    Account = "ma-nakaya"
    Profile = "gh-cli-ma-nakaya"
    GhConfigDir = Join-Path $oldGhConfigRoot "ma-nakaya"
    AllowedOwners = "ma-nakaya"
    AllowedRepositories = ""
    AuditLogPath = Join-Path $oldAuditDirectory "audit-ma-nakaya.jsonl"
    LogPath = "C:\Apps\TunnelClient\gh-cli-ma-nakaya.log"
    Hostname = "github.com"
    GhPath = $oldGhPath
  },
  [pscustomobject]@{
    TaskName = "OpenAI Secure MCP Tunnel - GH CLI - masa-nakaya"
    Account = "masa-nakaya"
    Profile = "gh-cli-masa-nakaya"
    GhConfigDir = Join-Path $oldGhConfigRoot "masa-nakaya"
    AllowedOwners = "masa-nakaya"
    AllowedRepositories = ""
    AuditLogPath = Join-Path $oldAuditDirectory "audit-masa-nakaya.jsonl"
    LogPath = "C:\Apps\TunnelClient\gh-cli-masa-nakaya.log"
    Hostname = "github.com"
    GhPath = $oldGhPath
  }
)

function Get-ExactOldRootTask {
  param([Parameter(Mandatory)][string]$TaskName)

  $matches = @(
    Get-ScheduledTask -TaskPath "\" -ErrorAction Stop |
      Where-Object {
        $_.TaskPath -ceq "\" -and
        [string]::Equals(
          [string]$_.TaskName,
          $TaskName,
          [System.StringComparison]::Ordinal
        )
      }
  )
  if ($matches.Count -gt 1) {
    throw "Ambiguous root task: $TaskName"
  }
  if ($matches.Count -eq 0) {
    return $null
  }
  return $matches[0]
}

function Resolve-PrincipalSid {
  param([Parameter(Mandatory)][string]$PrincipalName)

  if ($PrincipalName -match "^S-[0-9]+-[0-9]+(?:-[0-9]+)+$") {
    $securityIdentifier = New-Object `
      System.Security.Principal.SecurityIdentifier `
      -ArgumentList $PrincipalName
    return $securityIdentifier.Value
  }
  $account = New-Object System.Security.Principal.NTAccount `
    -ArgumentList $PrincipalName
  return $account.Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
}

function Assert-ExpectedV2Task {
  param(
    [Parameter(Mandatory)]$Task,
    [Parameter(Mandatory)]$Spec
  )

  $taskPrincipalSid = Resolve-PrincipalSid `
    -PrincipalName ([string]$Task.Principal.UserId)
  if (
    $taskPrincipalSid -cne $currentUserSid -or
    -not [string]::Equals(
      [string]$Task.Principal.LogonType,
      "Interactive",
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Unexpected principal for '$($Spec.TaskName)'."
  }

  $actions = @($Task.Actions)
  if (
    $actions.Count -ne 1 -or
    $actions[0].CimClass.CimClassName -cne "MSFT_TaskExecAction"
  ) {
    throw "Expected exactly one Exec action for '$($Spec.TaskName)'."
  }
  $action = $actions[0]
  if (
    -not [string]::Equals(
      [string]$action.Execute,
      $resolvedWscriptPath,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    -not [string]::Equals(
      [string]$action.WorkingDirectory,
      $oldWrapperDirectory,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Unexpected executable or working directory for '$($Spec.TaskName)'."
  }

  $matches = [regex]::Matches(
    [string]$action.Arguments,
    '(?:^|\s)"([^"\r\n]*)"(?=\s|$)',
    [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  $arguments = @($matches | ForEach-Object { $_.Groups[1].Value })
  $canonicalArguments = (
    $arguments | ForEach-Object { '"{0}"' -f $_ }
  ) -join " "
  $expectedArguments = @(
    $oldWrapperPath,
    $Spec.Account,
    $Spec.Profile,
    $Spec.GhConfigDir,
    $Spec.AllowedOwners,
    $Spec.AllowedRepositories,
    $Spec.AuditLogPath,
    $Spec.LogPath,
    $Spec.Hostname,
    $Spec.GhPath
  )
  if (
    $arguments.Count -ne 10 -or
    -not [string]::Equals(
      $canonicalArguments,
      [string]$action.Arguments,
      [System.StringComparison]::Ordinal
    )
  ) {
    throw "Unexpected v2 arguments for '$($Spec.TaskName)'."
  }
  $pathArgumentIndexes = @(0, 3, 6, 7, 9)
  for ($index = 0; $index -lt $expectedArguments.Count; $index++) {
    $comparison = [System.StringComparison]::Ordinal
    if ($pathArgumentIndexes -contains $index) {
      $comparison = [System.StringComparison]::OrdinalIgnoreCase
    }
    if (-not [string]::Equals(
      [string]$arguments[$index],
      [string]$expectedArguments[$index],
      $comparison
    )) {
      throw "Unexpected v2 argument $index for '$($Spec.TaskName)'."
    }
  }
}

$validatedOldTasks = @()
foreach ($spec in $oldTaskSpecs) {
  $task = Get-ExactOldRootTask -TaskName $spec.TaskName
  if ($null -ne $task) {
    Assert-ExpectedV2Task -Task $task -Spec $spec
    $validatedOldTasks += [pscustomobject]@{ Spec = $spec; Task = $task }
  }
}

$validatedOldTasks |
  ForEach-Object { $_.Task } |
  Select-Object TaskName, TaskPath, State,
    @{Name = "Principal"; Expression = { $_.Principal.UserId }},
    @{Name = "Execute"; Expression = { $_.Actions[0].Execute }} |
  Format-Table -AutoSize

foreach ($entry in $validatedOldTasks) {
  if ([string]::Equals(
    [string]$entry.Task.State,
    "Running",
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    Stop-ScheduledTask -InputObject $entry.Task
  }
}

foreach ($entry in $validatedOldTasks) {
  $task = Get-ExactOldRootTask -TaskName $entry.Spec.TaskName
  if ($null -ne $task) {
    Assert-ExpectedV2Task -Task $task -Spec $entry.Spec
    if (-not [string]::Equals(
      [string]$task.State,
      "Ready",
      [System.StringComparison]::Ordinal
    )) {
      throw "Task is not exactly Ready; refusing to unregister '$($entry.Spec.TaskName)'."
    }
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
  }
}
```

If this validation refuses a task, inspect it manually and determine its owner and complete action before taking any action. Do not weaken the checks or unregister by name alone.

Inspect remaining Tunnel Client command lines:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" |
  Select-Object ProcessId, CommandLine |
  Format-List
```

If an old `run --profile gh-cli-ma-nakaya` or `run --profile gh-cli-masa-nakaya` process remains, re-query its exact PID and command line before stopping only that PID. Never use `Stop-Process -Name tunnel-client` and never stop unrelated Tunnel processes.

If the single task `OpenAI Secure MCP Tunnel - GH CLI` already exists, stop it before reinstalling. The installer replaces it only after an exact root lookup proves that its state is exactly `Ready`, it belongs to the current interactive user, and it has one `wscript.exe` Exec action whose first quoted argument and working directory point to the resolved v3 wrapper. It refuses `Running`, `Queued`, `Unknown`, `Disabled`, or mismatched tasks.

### Copy and register the v3 wrapper

Copy the wrapper:

```powershell
Copy-Item `
  "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\run-gh-cli-mcp-tunnel.vbs" `
  "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs" `
  -Force
```

Confirm that the current User's persistent environment contains the runtime key without printing it. A Machine-level value does not satisfy the installer:

```powershell
if ([Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User")) {
  "Persistent User key is set"
} else {
  "Persistent User key is not set"
}
```

If it is absent, enter it without placing the value in PowerShell history:

```powershell
$secureKey = Read-Host "Runtime API Key" -AsSecureString
[Environment]::SetEnvironmentVariable(
  "CONTROL_PLANE_API_KEY",
  [System.Net.NetworkCredential]::new("", $secureKey).Password,
  "User"
)
```

Sign out and back in before relying on the Scheduled Task's inherited environment, or restart the Task Scheduler service according to local operations policy. Do not paste the runtime key into the VBS file, task arguments, manifest, repository, logs, or ChatGPT.

Prepare the non-secret paths and register one task:

```powershell
$installer = "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\install-gh-cli-tunnel-task.ps1"
$wrapper = "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs"
$ghPath = (Get-Command gh.exe).Source
$auditDir = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit"
New-Item -ItemType Directory -Force $auditDir | Out-Null

& $installer `
  -AccountsFile $manifestPath `
  -ProfileName "gh-cli" `
  -AuditLogPath (Join-Path $auditDir "audit.jsonl") `
  -LogPath "C:\Apps\TunnelClient\gh-cli-tunnel-client.log" `
  -GhPath $ghPath `
  -AllowedHosts "github.com" `
  -WrapperPath $wrapper `
  -TaskName "OpenAI Secure MCP Tunnel - GH CLI"
```

Before registration, the installer:

- requires the exact `onprem-gh-cli-mcp-wrapper-v3` handshake;
- requires GitHub CLI 2.81.0 or later and verifies that `gh auth status --json` is advertised;
- rejects unknown or incorrectly cased manifest properties so credentials cannot be added as extra fields;
- validates version 1, identifiers, hosts, allowlists, absolute paths, and unique account/configuration entries;
- normalizes `-AllowedHosts` (default `github.com`) as an independent boundary, rejects every manifest hostname outside it, and passes the fixed CSV to the wrapper;
- requires distinct audit and Tunnel log files, rejects directory outputs, and prevents either output from overwriting the manifest, wrapper, `gh.exe`, or anything in a `GH_CONFIG_DIR`;
- requires each `GH_CONFIG_DIR` to contain exactly its one expected, active, healthy login;
- confirms `gh api user` for every account without printing a token;
- requires at least one allowed Owner or Repository per account; and
- verifies that the intentionally persistent runtime key exists without copying it to the repository, manifest, wrapper, task arguments, or logs.

Start and inspect the one task and one readiness endpoint:

```powershell
Start-ScheduledTask -TaskName "OpenAI Secure MCP Tunnel - GH CLI"

Get-ScheduledTask -TaskName "OpenAI Secure MCP Tunnel - GH CLI" |
  Select-Object TaskName, State

Invoke-WebRequest "http://127.0.0.1:8081/readyz" -UseBasicParsing |
  Select-Object StatusCode, Content
```

The task uses `wscript.exe`, retries three times at one-minute intervals after failure, and rejects a second instance of itself. After it starts, repeat both `get_auth_status` calls and both read tests through the single ChatGPT app. Scheduled Task readiness alone is not an identity check.

After changing the manifest, stop the task, re-run the installer so every account is validated again, and restart the task.
