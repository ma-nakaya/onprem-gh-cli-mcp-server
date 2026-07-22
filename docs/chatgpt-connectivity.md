# ChatGPT connectivity check with Secure MCP Tunnel

This runbook connects the locally built stdio MCP server to ChatGPT without publishing the npm package first.

Official references:

- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)

## 1. Prerequisites

- ChatGPT Developer mode access for the target workspace.
- A Secure MCP Tunnel associated with both the Platform organization and target ChatGPT workspace.
- `Tunnels Read + Use` permission for the operator.
- A runtime API key for `tunnel-client`.
- Outbound HTTPS access to `api.openai.com:443` (`/v1/tunnel/*`).
- Node.js 20 or later, GitHub CLI, and completed `gh auth login` on the on-premises Windows PC.
- `tunnel-client.exe` obtained from Platform tunnel settings or the latest official release.

Do not save the runtime API key, tunnel ID, GitHub token, or other secrets in this repository, command-history files, screenshots, or Notion.

## 2. Build and verify stdio locally

Run from the repository root in PowerShell:

```powershell
npm ci
npm run check
npm test
npm run build
npm run smoke:stdio
```

Expected result:

```text
stdio MCP smoke test passed: 23 tools discovered.
```

Directly running `node dist/cli.js` normally prints nothing and waits for MCP input. That is expected for a stdio MCP server.

## 3. Set process-scoped configuration

Use explicit allowlists before starting `tunnel-client`:

```powershell
$env:GH_MCP_ALLOWED_HOSTS = "github.com"
$env:GH_MCP_ALLOWED_OWNERS = "ma-nakaya"
$env:GH_MCP_ALLOWED_REPOSITORIES = "ma-nakaya/onprem-gh-cli-mcp-server"
$env:GH_MCP_GH_PATH = (Get-Command gh.exe).Source
$env:CONTROL_PLANE_API_KEY = "<runtime-api-key>"
```

Set `CONTROL_PLANE_API_KEY` only in the process environment used to run the tunnel. Never commit it or paste it into ChatGPT.

## 4. Create and validate the stdio tunnel profile

Replace the repository path and tunnel ID with local values:

```powershell
tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli `
  --tunnel-id <tunnel-id> `
  --health-listen-addr "127.0.0.1:8081" `
  --mcp-command "node C:/Workspace/onprem-gh-cli-mcp-server/dist/cli.js"

tunnel-client.exe doctor --profile gh-cli --explain
tunnel-client.exe run --profile gh-cli
```

Keep `tunnel-client run` healthy during tool discovery and ChatGPT tests. Use its local `/ui` admin page to confirm that the client is healthy, ready, and connected.

## 5. Create the draft app in ChatGPT

1. Enable Developer mode for the target ChatGPT account.
2. Open **Settings → Plugins** (or `chatgpt.com/plugins`).
3. Select the plus button to create a developer-mode app.
4. Choose **Tunnel** as the connection type.
5. Select the associated tunnel or enter its `tunnel_id`.
6. Run **Scan Tools** and verify that the expected tools are found.
7. Create the app as a draft. Do not publish it during initial connectivity testing.

If the tunnel is missing, verify its ChatGPT workspace association and the operator's `Tunnels Read + Use` permission.

## 6. Connectivity tests in a new chat

Start with read-only prompts:

```text
GH CLI MCPを使って、GitHub CLIの認証状態をトークンを表示せず確認してください。
```

```text
GH CLI MCPを使って、所属Organization一覧を確認してください。
```

```text
ma-nakaya/onprem-gh-cli-mcp-server の最新Issueを3件、本文なしで取得してください。
```

Confirm that:

- The draft app is selected.
- ChatGPT discovers and invokes the intended read-only tool.
- No GitHub token or secret appears in the response or logs.
- The tunnel admin UI shows successful requests.

Only after read-only checks pass, test a write action against a disposable test repository. Review the confirmation modal and exact target before approving it.

## 7. Later switch to pinned npx startup

After the npm package is published, replace the local build command with a reviewed, pinned version:

```powershell
npx.cmd --yes --prefer-offline @ma-nakaya/onprem-gh-cli-mcp@0.1.0
```

Do not use `@latest` for the tunnel profile. Re-run `doctor`, **Scan Tools**, and the read-only tests after changing the command or tool definitions.

## 8. Run without a visible console window

After the manual ChatGPT connectivity test succeeds, use the Windows Script Host wrapper in `scripts/windows/run-gh-cli-mcp-tunnel.vbs`. It starts `tunnel-client.exe` with window style `0`, waits for the process, and returns its exit code to Task Scheduler.

The wrapper intentionally contains no runtime API key, GitHub token, or tunnel ID. It expects the existing `gh-cli` profile and the persistent user-level `CONTROL_PLANE_API_KEY` environment variable.

Copy the wrapper to the Tunnel Client directory:

```powershell
Copy-Item "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\run-gh-cli-mcp-tunnel.vbs" "C:\Apps\TunnelClient\run-gh-cli-mcp-tunnel.vbs" -Force
```

Before registering the task, confirm that the persistent user environment contains the key without printing its value:

```powershell
if ([Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY","User") -or [Environment]::GetEnvironmentVariable("CONTROL_PLANE_API_KEY","Machine")) { "Persistent key is set" } else { "Persistent key is not set" }
```

If it is not set, enter the runtime key without placing it in PowerShell history and save it for the current Windows user. Windows stores a user environment variable in that user's registry profile; use an organization-approved secret store instead when policy requires stronger protection.

```powershell
$secureKey=Read-Host "Runtime API Key" -AsSecureString; [Environment]::SetEnvironmentVariable("CONTROL_PLANE_API_KEY",[System.Net.NetworkCredential]::new("",$secureKey).Password,"User")
```

Sign out and back in before relying on the scheduled task's inherited environment, or restart the Task Scheduler service according to local operations policy. Do not paste the runtime key into the VBS file, task arguments, repository, logs, or ChatGPT.

Register the at-logon task for the current Windows user:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\install-gh-cli-tunnel-task.ps1"
```

Stop any manually running `gh-cli` tunnel before starting the task, then run and inspect it:

```powershell
Start-ScheduledTask -TaskName "OpenAI Secure MCP Tunnel - GH CLI"
```

```powershell
Get-ScheduledTask -TaskName "OpenAI Secure MCP Tunnel - GH CLI" | Select-Object TaskName,State
```

```powershell
Invoke-WebRequest "http://127.0.0.1:8081/readyz" -UseBasicParsing | Select-Object StatusCode,Content
```

The task uses `wscript.exe`, so no console window is shown. It runs at user logon, retries three times at one-minute intervals after a failure, and rejects a second concurrent task instance. The tunnel log is written to `C:\Apps\TunnelClient\gh-cli-tunnel-client.log`.
