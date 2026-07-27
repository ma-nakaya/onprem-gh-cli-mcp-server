# ChatGPT connectivity check with Secure MCP Tunnel

This runbook connects the locally built stdio MCP server to ChatGPT without publishing the npm package first. It uses an isolated process for each GitHub account:

```text
1 account = 1 GH_CONFIG_DIR = 1 MCP process = 1 tunnel profile
```

The examples run `ma-nakaya` and `masa-nakaya` at the same time. The same procedure works for one account by configuring and starting only one side.

Official references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [GitHub CLI: using multiple accounts](https://docs.github.com/en/github-cli/github-cli/using-multiple-accounts)
- [GitHub CLI environment variables](https://cli.github.com/manual/gh_help_environment)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)

## 1. Prerequisites

- ChatGPT Developer mode access for the target workspace.
- Two Secure MCP Tunnel endpoints associated with both the Platform organization and target ChatGPT workspace.
- `Tunnels Read + Use` permission for the operator.
- A runtime API key authorized to run both tunnel endpoints.
- Outbound HTTPS access to `api.openai.com:443` (`/v1/tunnel/*`).
- Node.js 20 or later.
- GitHub CLI 2.40.0 or later.
- `tunnel-client.exe` obtained from Platform tunnel settings or the latest official release.

Never save the runtime API key, GitHub token, or other credentials in this repository, wrapper arguments, scheduled task arguments, command-history files, screenshots, or Notion. A Tunnel ID is an identifier rather than a credential and must appear in the `tunnel-client init` command, but do not commit it or share it beyond the intended tunnel operators.

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

## 3. Authenticate each account in its own GH_CONFIG_DIR

Create new GitHub CLI configuration directories outside the repository. Do not reuse the default GitHub CLI directory or any directory containing `hosts.yml`. The helper below creates a missing directory but refuses an existing non-empty directory:

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

Authenticate only `ma-nakaya` in its directory. In the browser account picker, confirm the login before authorizing GitHub CLI:

```powershell
$env:GH_CONFIG_DIR = $maGhConfig
gh auth login --hostname github.com --web
gh auth status --hostname github.com
gh api user --hostname github.com --jq .login
```

The final command must return:

```text
ma-nakaya
```

Authenticate only `masa-nakaya` in the other directory:

```powershell
$env:GH_CONFIG_DIR = $masaGhConfig
gh auth login --hostname github.com --web
gh auth status --hostname github.com
gh api user --hostname github.com --jq .login
```

The final command must return:

```text
masa-nakaya
```

For each directory, `gh auth status` must list only its intended account and mark that login active. Do not run another `gh auth login` to add a second account to either directory. Use the following `gh api user` output as the authoritative identity check performed by this server.

Clear the temporary setting after both logins:

```powershell
Remove-Item Env:GH_CONFIG_DIR
```

The login directories may contain sensitive credential metadata and, when the OS credential store is unavailable, credentials. Keep them outside the repository and protect them with the current user's filesystem permissions.

> [!CAUTION]
> Never run `gh auth switch`, `gh auth login`, or `gh auth logout` against a `GH_CONFIG_DIR` while its MCP server or tunnel is running. Stop the corresponding manual process and scheduled task first, verify the active login after the change, and only then restart it. Changing the active account during an MCP request can execute an operation as the wrong account.

## 4. Create the two stdio tunnel profiles

Use a different Tunnel ID, profile name, and health port for each account. Replace the repository path and both Tunnel IDs with local values:

```powershell
tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli-ma-nakaya `
  --tunnel-id <ma-nakaya-tunnel-id> `
  --health-listen-addr "127.0.0.1:8081" `
  --mcp-command "node C:/Workspace/onprem-gh-cli-mcp-server/dist/cli.js"

tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli-masa-nakaya `
  --tunnel-id <masa-nakaya-tunnel-id> `
  --health-listen-addr "127.0.0.1:8082" `
  --mcp-command "node C:/Workspace/onprem-gh-cli-mcp-server/dist/cli.js"

tunnel-client.exe doctor --profile gh-cli-ma-nakaya --explain
tunnel-client.exe doctor --profile gh-cli-masa-nakaya --explain
```

The Tunnel profile stores the stdio command and Tunnel ID. GitHub account settings are deliberately not stored in it; the account-specific wrapper supplies them to the process at run time.

## 5. Run both profiles manually

Create the audit directory:

```powershell
$auditDir = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit"
New-Item -ItemType Directory -Force $auditDir | Out-Null
```

Open one PowerShell session for `ma-nakaya`, set all account-specific values, verify the login, and start its profile:

```powershell
$env:GH_CONFIG_DIR = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\gh\ma-nakaya"
$env:GH_HOST = "github.com"
$env:GH_MCP_ACCOUNT_HOST = "github.com"
$env:GH_MCP_EXPECTED_LOGIN = "ma-nakaya"
$env:GH_MCP_ALLOWED_HOSTS = "github.com"
$env:GH_MCP_ALLOWED_OWNERS = "ma-nakaya"
$env:GH_MCP_ALLOWED_REPOSITORIES = ""
$env:GH_MCP_AUDIT_LOG_PATH = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit\audit-ma-nakaya.jsonl"
$env:GH_MCP_GH_PATH = (Get-Command gh.exe).Source
$secureKey = Read-Host "Runtime API Key" -AsSecureString
$env:CONTROL_PLANE_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password

gh api user --hostname github.com --jq .login
tunnel-client.exe run `
  --profile gh-cli-ma-nakaya `
  --log.file="C:\Apps\TunnelClient\gh-cli-ma-nakaya.log"
```

Open a second PowerShell session for `masa-nakaya`:

```powershell
$env:GH_CONFIG_DIR = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\gh\masa-nakaya"
$env:GH_HOST = "github.com"
$env:GH_MCP_ACCOUNT_HOST = "github.com"
$env:GH_MCP_EXPECTED_LOGIN = "masa-nakaya"
$env:GH_MCP_ALLOWED_HOSTS = "github.com"
$env:GH_MCP_ALLOWED_OWNERS = "masa-nakaya"
$env:GH_MCP_ALLOWED_REPOSITORIES = ""
$env:GH_MCP_AUDIT_LOG_PATH = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit\audit-masa-nakaya.jsonl"
$env:GH_MCP_GH_PATH = (Get-Command gh.exe).Source
$secureKey = Read-Host "Runtime API Key" -AsSecureString
$env:CONTROL_PLANE_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password

gh api user --hostname github.com --jq .login
tunnel-client.exe run `
  --profile gh-cli-masa-nakaya `
  --log.file="C:\Apps\TunnelClient\gh-cli-masa-nakaya.log"
```

The identity command in each session must match `GH_MCP_EXPECTED_LOGIN`. The MCP server also verifies this expectation and refuses to run with an unrestricted Owner/Repository scope.

Keep both `tunnel-client run` processes healthy during tool discovery and ChatGPT tests. Their local admin UIs and readiness endpoints are:

- `ma-nakaya`: `http://127.0.0.1:8081/ui` and `http://127.0.0.1:8081/readyz`
- `masa-nakaya`: `http://127.0.0.1:8082/ui` and `http://127.0.0.1:8082/readyz`

## 6. Create two draft apps in ChatGPT

Create a separate draft app for each tunnel so the selected execution identity is visible:

1. Enable Developer mode for the target ChatGPT account.
2. Open **Settings → Plugins** (or `chatgpt.com/plugins`).
3. Select the plus button and choose **Tunnel** as the connection type.
4. Select the `gh-cli-ma-nakaya` tunnel, run **Scan Tools**, and name the draft app `GitHub CLI (ma-nakaya)`.
5. Repeat for `gh-cli-masa-nakaya` and name it `GitHub CLI (masa-nakaya)`.
6. Do not publish either app during initial connectivity testing.

If a tunnel is missing, verify its ChatGPT workspace association and the operator's `Tunnels Read + Use` permission.

## 7. Connectivity tests in a new chat

Select exactly one account-specific draft app and start with read-only prompts:

```text
GitHub CLI (ma-nakaya) の get_auth_status ツールを使って、期待loginとactive loginが ma-nakaya で一致することを、トークンを表示せず確認してください。
```

```text
GitHub CLI (masa-nakaya) の get_auth_status ツールを使って、期待loginとactive loginが masa-nakaya で一致することを、トークンを表示せず確認してください。
```

Complete both checks end to end through their respective ChatGPT apps and confirm that each invocation used `get_auth_status`. Do not invoke any write tool until both account-specific checks have succeeded. Then test the account's allowed owner:

```text
GitHub CLI (ma-nakaya) を使って、ma-nakaya/onprem-gh-cli-mcp-server の最新Issueを3件、本文なしで取得してください。
```

Confirm that:

- The intended account-specific draft app is selected.
- Each app invoked its own `get_auth_status` tool end to end.
- The expected and active login match.
- An Owner or Repository outside that profile's allowlist is rejected.
- No GitHub token or secret appears in the response or logs.
- The matching tunnel admin UI shows the request.
- Only the matching account-specific audit log changes after a test write.

Only after read-only checks pass, test a write action against a disposable repository allowed by that profile. Review the confirmation modal, selected app, account login, and exact target before approving it.

## 8. Later switch to pinned npx startup

After the npm package is published, both profiles can run the same reviewed, pinned package version:

```powershell
npx.cmd --yes --prefer-offline @ma-nakaya/onprem-gh-cli-mcp@0.1.0
```

The npm package scope does not select the GitHub authentication account. Account selection still comes from the isolated process environment and `GH_CONFIG_DIR`.

Do not use `@latest` for either tunnel profile. Re-run `doctor`, **Scan Tools**, the identity check, and the read-only tests after changing the command or tool definitions.

## 9. Run both profiles without visible console windows

The generic Windows Script Host wrapper in `scripts/windows/run-gh-cli-mcp-tunnel.vbs` receives only non-secret account settings from a scheduled task. It sets them in its process environment, starts the selected Tunnel profile with window style `0`, waits for the process, and returns its exit code.

The wrapper never accepts a runtime API key or GitHub token. It inherits `CONTROL_PLANE_API_KEY` from the task process. The non-secret Tunnel ID remains in the existing Tunnel profile and is not duplicated in the wrapper or scheduled task arguments.

### Remove the legacy single-profile launcher first

Perform this migration before copying the new generic wrapper. Stop and unregister only the legacy task with its exact old name:

```powershell
$legacyTaskName = "OpenAI Secure MCP Tunnel - GH CLI"
$legacyTask = Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
if ($null -ne $legacyTask) {
  if ($legacyTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $legacyTaskName
  }
  Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
}
```

Next, inspect the full command line of every remaining Tunnel Client process:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" |
  Select-Object ProcessId, CommandLine |
  Format-List
```

If and only if a displayed command line contains the exact legacy invocation `run --profile gh-cli`, note that row's PID and stop that PID explicitly:

```powershell
[int]$confirmedLegacyPid = Read-Host "Enter the PID whose command line is exactly the legacy gh-cli profile"
$confirmedLegacyProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $confirmedLegacyPid"
if (
  $null -eq $confirmedLegacyProcess -or
  $confirmedLegacyProcess.CommandLine -notmatch '(?i)(?:^|\s)run\s+--profile\s+(?:"gh-cli"|gh-cli)(?:\s|$)'
) {
  throw "PID no longer identifies the exact legacy run --profile gh-cli process."
}
Stop-Process -Id $confirmedLegacyPid
```

Do not use `Stop-Process -Name tunnel-client` or stop every returned PID. Account-specific processes such as `run --profile gh-cli-ma-nakaya` and `run --profile gh-cli-masa-nakaya` must not be terminated by this migration.

### Copy and register the v2 wrapper

Copy the generic wrapper to the Tunnel Client directory:

```powershell
Copy-Item `
  "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\run-gh-cli-mcp-tunnel.vbs" `
  "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs" `
  -Force
```

Confirm that the persistent user or machine environment contains the runtime key without printing it:

```powershell
if (
  [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "User") -or
  [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY", "Machine")
) { "Persistent key is set" } else { "Persistent key is not set" }
```

If it is not set, enter the runtime key without placing it in PowerShell history. Windows stores a user environment variable in that user's registry profile; use an organization-approved secret store instead when policy requires stronger protection.

```powershell
$secureKey = Read-Host "Runtime API Key" -AsSecureString
[Environment]::SetEnvironmentVariable(
  "CONTROL_PLANE_API_KEY",
  [System.Net.NetworkCredential]::new("", $secureKey).Password,
  "User"
)
```

Sign out and back in before relying on the scheduled task's inherited environment, or restart the Task Scheduler service according to local operations policy. Do not paste the runtime key into the VBS file, task arguments, repository, logs, or ChatGPT.

Prepare the non-secret paths:

```powershell
$installer = "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\install-gh-cli-tunnel-task.ps1"
$wrapper = "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs"
$ghPath = (Get-Command gh.exe).Source
$ghConfigRoot = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\gh"
$auditDir = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit"
New-Item -ItemType Directory -Force $auditDir | Out-Null
```

Register the `ma-nakaya` task:

```powershell
& $installer `
  -Account "ma-nakaya" `
  -ProfileName "gh-cli-ma-nakaya" `
  -GhConfigDir (Join-Path $ghConfigRoot "ma-nakaya") `
  -AllowedOwners "ma-nakaya" `
  -AllowedRepositories "" `
  -AuditLogPath (Join-Path $auditDir "audit-ma-nakaya.jsonl") `
  -LogPath "C:\Apps\TunnelClient\gh-cli-ma-nakaya.log" `
  -Hostname "github.com" `
  -GhPath $ghPath `
  -WrapperPath $wrapper `
  -TaskName "OpenAI Secure MCP Tunnel - GH CLI - ma-nakaya"
```

Register the `masa-nakaya` task:

```powershell
& $installer `
  -Account "masa-nakaya" `
  -ProfileName "gh-cli-masa-nakaya" `
  -GhConfigDir (Join-Path $ghConfigRoot "masa-nakaya") `
  -AllowedOwners "masa-nakaya" `
  -AllowedRepositories "" `
  -AuditLogPath (Join-Path $auditDir "audit-masa-nakaya.jsonl") `
  -LogPath "C:\Apps\TunnelClient\gh-cli-masa-nakaya.log" `
  -Hostname "github.com" `
  -GhPath $ghPath `
  -WrapperPath $wrapper `
  -TaskName "OpenAI Secure MCP Tunnel - GH CLI - masa-nakaya"
```

Before registering a task, the installer runs `cscript.exe <wrapper> --version` and requires the exact marker `onprem-gh-cli-mcp-wrapper-v2`. It also validates identifiers, CSV allowlists, absolute paths, and persistent runtime-key presence. The normalized `ProfileName` must exactly equal `gh-cli-<normalized Account>`, so one profile cannot satisfy both accounts. At least one of `AllowedOwners` or `AllowedRepositories` is required.

The installer supports only the current interactive user, `$env:USERDOMAIN\$env:USERNAME`, and rejects a different `UserId`. It puts no secret in the scheduled task action.

Stop any manually running account-specific tunnels before starting the tasks:

```powershell
Start-ScheduledTask -TaskName "OpenAI Secure MCP Tunnel - GH CLI - ma-nakaya"
Start-ScheduledTask -TaskName "OpenAI Secure MCP Tunnel - GH CLI - masa-nakaya"
```

Inspect both tasks and readiness endpoints:

```powershell
Get-ScheduledTask `
  -TaskName "OpenAI Secure MCP Tunnel - GH CLI - ma-nakaya",
            "OpenAI Secure MCP Tunnel - GH CLI - masa-nakaya" |
  Select-Object TaskName, State

Invoke-WebRequest "http://127.0.0.1:8081/readyz" -UseBasicParsing |
  Select-Object StatusCode, Content
Invoke-WebRequest "http://127.0.0.1:8082/readyz" -UseBasicParsing |
  Select-Object StatusCode, Content
```

Each task rejects a second instance of itself, but the two differently named tasks can run at the same time. They share one generic VBS file while receiving different account, profile, configuration, allowlist, and log arguments.

After both scheduled tasks are running and both readiness checks pass, repeat the two account-specific ChatGPT prompts from section 7. Invoke `get_auth_status` through `GitHub CLI (ma-nakaya)` and then through `GitHub CLI (masa-nakaya)`, and confirm each expected login matches its active login. Scheduled-task readiness alone is not an identity check. Do not approve a write until both post-start end-to-end checks succeed.

For a single-account installation, run the installer once with the same explicit parameters, for example `Account=ma-nakaya`, `ProfileName=gh-cli-ma-nakaya`, one dedicated `GH_CONFIG_DIR`, one allowlist, and one audit/tunnel log. Do not fall back to ambient GitHub CLI authentication or unrestricted defaults.
