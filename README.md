# onprem-gh-cli-mcp-server

オンプレPCにインストールされたGitHub CLI (`gh`)を、MCPクライアントから安全に利用するためのstdio MCPサーバーです。APIの認証情報をMCPクライアントへ渡さず、ローカルの`gh auth`認証を利用します。

> [!IMPORTANT]
> 現在はPhase 3aです。読み取り操作と型付き書き込みに加え、GitHub CLIアカウント固定と複数アカウントの分離運用を提供します。Repository削除、PRマージ、公開状態変更、Secret変更などの高影響な管理操作は未実装です。

## 提供ツール

### 読み取り

- `get_auth_status`: トークンを表示せず、active loginと期待loginの一致を確認
- `list_organizations`: 認証ユーザーから見える、許可Ownerに限定した所属Organization一覧
- `list_repositories`: Repository一覧（許可リスト設定時はOwner指定必須）
- `list_issues`: Issue一覧
- `list_pull_requests`: Pull Request一覧
- `list_workflow_runs`: GitHub Actions実行一覧
- `run_gh`: 許可された読み取り専用`gh`コマンド（Owner/Repository許可リスト設定時は`auth status`のみ）

### Issue書き込み

- `create_issue`: Issueを作成
- `update_issue`: Issueのタイトル、本文、open/closed状態を更新
- `comment_issue`: Issueへコメントを追加

Issue本文とコメントはコマンドライン引数へ載せず、`gh api --input -`の標準入力としてJSONで渡します。書き込み操作は型付きツールだけに限定し、`run_gh`は読み取り専用のままです。

### Pull Request書き込み

- `create_pull_request`: Pull Requestを作成（既定はDraft）
- `update_pull_request`: タイトル、本文、open/closed状態を更新
- `comment_pull_request`: Conversationへコメントを追加
- `review_pull_request`: Approve、Request changes、Commentレビューを送信

Pull Requestのタイトル、本文、コメント、レビュー本文も標準入力で渡し、監査ログへ保存しません。これらのツールはPull Requestをマージできません。

### Draft Release書き込み

- `create_release`: Releaseを常にDraftとして作成
- `update_release`: 既存のDraft Releaseだけを更新

Release本文は標準入力で渡し、監査ログへ保存しません。公開済みReleaseの変更、Draftの公開、削除、Asset操作は提供しません。

### Workflow Dispatch

- `dispatch_workflow`: activeなGitHub Actions Workflowをrefと任意inputsで起動

対象Workflowの存在とactive状態を事前確認します。inputsは標準入力で渡し、MCPレスポンスや監査ログへ保存しません。Workflowの処理内容によって高影響になり得るため、ツールの`destructiveHint`は`true`です。再実行、キャンセル、Run削除は提供しません。

### Label / Milestone書き込み

- `create_label` / `update_label`: Labelの作成、名前・色・説明の更新
- `create_milestone` / `update_milestone`: Milestoneの作成、タイトル・説明・状態・期日の更新

説明などの入力は標準入力で渡し、監査ログへ保存しません。更新前に対象の存在を確認します。Label色は6桁16進数、Milestone期日はUTC ISO 8601に限定します。削除操作は提供しません。

### GitHub Projects v2

- `create_project`: 許可されたUser / Organization配下へprivate Projectを作成
- `update_project`: タイトル、短い説明、README、open/closed状態を更新
- `list_project_items`: Project内のIssue / Pull Requestメタデータを取得（本文とfield valueは返さない）
- `list_project_fields`: Fieldメタデータ、single-select option、iteration情報を取得
- `add_project_item`: 既存Issue / Pull RequestをProjectへ追加
- `set_project_item_field` / `clear_project_item_field`: text、number、date、single-select、iterationの値を設定・消去
- `set_project_item_archived`: Project Itemをarchiveまたはrestore

Owner Node IDはREST APIから解決し、Project操作はGitHub GraphQL APIへqueryとvariablesを標準入力で渡します。Project ID、Item IDはそれぞれ`PVT_`、`PVTI_`形式に限定し、操作前にProjectV2とOwnerの一致を確認します。タイトル、説明、README、field valueは監査ログへ保存しません。Projectの公開状態変更・削除、Item削除、Field定義の作成・更新・削除、Draft Item作成は提供しません。

> [!IMPORTANT]
> `create_project`、`update_project`、Project/Field一覧、Item/Field操作などのOwner-wide Project操作には、対象Ownerを`GH_MCP_ALLOWED_OWNERS`へ明示する必要があります。`GH_MCP_ALLOWED_REPOSITORIES`に同じOwnerのRepositoryを設定しただけではOwner-wide操作は許可されません。`add_project_item`はこれに加えて対象Repositoryの許可も必要です。

## 必要環境

- Node.js 20以上
- GitHub CLI 2.40.0以上
- 事前に`gh auth login`が完了していること

各書き込み操作には、対象RepositoryとActionsへの必要権限を持つGitHub CLI認証が必要です。

## 起動

公開後は、レビュー済みバージョンを固定して起動します。

```powershell
npx.cmd --yes --prefer-offline @ma-nakaya/onprem-gh-cli-mcp@0.1.0
```

ローカル開発時:

```powershell
npm install
npm run build
node dist/cli.js
```

## 設定

| 変数 | 既定値 | 説明 |
|---|---|---|
| `GH_MCP_GH_PATH` | Windows: `gh.exe` | GitHub CLIの固定パス |
| `GH_MCP_EXPECTED_LOGIN` | 未設定 | 使用を期待するGitHub login。設定時はactive accountが一致しなければ処理を拒否 |
| `GH_MCP_ACCOUNT_HOST` | `GH_HOST`、未設定時は`github.com` | `GH_MCP_EXPECTED_LOGIN`を検証するGitHubホスト |
| `GH_MCP_ALLOWED_HOSTS` | `github.com` | 許可ホスト（カンマ区切り） |
| `GH_MCP_ALLOWED_OWNERS` | 制限なし | 許可Owner/Organization |
| `GH_MCP_ALLOWED_REPOSITORIES` | 制限なし | 許可Repository (`owner/name`) |
| `GH_MCP_TIMEOUT_MS` | `30000` | コマンドのタイムアウト |
| `GH_MCP_MAX_OUTPUT_BYTES` | `1000000` | 最大出力サイズ |
| `GH_MCP_AUDIT_LOG_PATH` | OS別のユーザー領域 | JSONL監査ログの固定パス |
| `GH_CONFIG_DIR` | GitHub CLIのOS別既定値 | GitHub CLI認証設定ディレクトリ。アカウントごとに分離 |

監査ログの既定パス:

- Windows: `%LOCALAPPDATA%\onprem-gh-cli-mcp\audit.jsonl`
- Linux/macOS: `$XDG_STATE_HOME/onprem-gh-cli-mcp/audit.jsonl`、未設定時は`~/.local/state/onprem-gh-cli-mcp/audit.jsonl`

本番利用では`GH_MCP_ALLOWED_OWNERS`または`GH_MCP_ALLOWED_REPOSITORIES`を必ず設定してください。`GH_MCP_EXPECTED_LOGIN`を設定した場合、どちらも未設定の構成は拒否されます。監査ログパスはMCPツール入力から変更できず、環境変数または既定値で固定されます。

## 複数GitHubアカウント

同じ`github.com`上の`ma-nakaya`と`masa-nakaya`を同時利用する場合は、次の単位を必ず分離します。

```text
1 account = 1 GH_CONFIG_DIR = 1 MCP process = 1 tunnel profile
```

`GH_MCP_ALLOWED_OWNERS`は操作対象の許可リストであり、認証アカウントの選択ではありません。また、ツール入力の`hostname`も同じホスト上のアカウントを選択しません。

### アカウント別に認証する

GitHub CLIの認証設定はリポジトリ外の新しいディレクトリに作成します。既存の`hosts.yml`を引き継がないよう、次の例は既存ディレクトリが空でなければ停止します。各ディレクトリには指定した1アカウントだけを認証し、2つ目のアカウントを追加しないでください。ブラウザのアカウント選択画面でも、表示中のloginを必ず確認します。

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

$env:GH_CONFIG_DIR = $maGhConfig
gh auth login --hostname github.com --web
gh auth status --hostname github.com
gh api user --hostname github.com --jq .login
# Expected: ma-nakaya

$env:GH_CONFIG_DIR = $masaGhConfig
gh auth login --hostname github.com --web
gh auth status --hostname github.com
gh api user --hostname github.com --jq .login
# Expected: masa-nakaya

Remove-Item Env:GH_CONFIG_DIR
```

各`GH_CONFIG_DIR`の`gh auth status`には対応する1アカウントだけが表示され、そのloginがactiveであることを目視します。続く`gh api user`の出力を最終確認に使用します。

### プロセス設定を分離する

各Tunnel Clientは別PowerShellセッションまたはアカウント別Scheduled Taskから起動し、次のようにプロセス環境を分けます。

| 設定 | `ma-nakaya` | `masa-nakaya` |
|---|---|---|
| `GH_CONFIG_DIR` | `%LOCALAPPDATA%\onprem-gh-cli-mcp\gh\ma-nakaya` | `%LOCALAPPDATA%\onprem-gh-cli-mcp\gh\masa-nakaya` |
| `GH_MCP_EXPECTED_LOGIN` | `ma-nakaya` | `masa-nakaya` |
| `GH_MCP_ACCOUNT_HOST` / `GH_HOST` | `github.com` | `github.com` |
| `GH_MCP_ALLOWED_OWNERS` | `ma-nakaya` | `masa-nakaya` |
| Tunnel profile | `gh-cli-ma-nakaya` | `gh-cli-masa-nakaya` |
| health port | `8081` | `8082` |
| tunnel log | `gh-cli-ma-nakaya.log` | `gh-cli-masa-nakaya.log` |
| audit log | `audit-ma-nakaya.jsonl` | `audit-masa-nakaya.jsonl` |
| Scheduled Task | `OpenAI Secure MCP Tunnel - GH CLI - ma-nakaya` | `OpenAI Secure MCP Tunnel - GH CLI - masa-nakaya` |

> [!CAUTION]
> MCPサーバーまたはTunnelが稼働中の`GH_CONFIG_DIR`に対して`gh auth switch`、`gh auth login`、`gh auth logout`を実行しないでください。active accountの変更とMCPリクエストが競合し、意図しないアカウントで操作される可能性があります。認証を変更する場合は、該当するTunnelとScheduled Taskを停止し、変更後にlogin確認を行ってから再起動してください。

同時利用が不要な単一アカウント構成でも、`GH_CONFIG_DIR`、`GH_MCP_EXPECTED_LOGIN`、Owner/Repository許可リストを明示して1プロセスを起動します。npm packageのscopeは実行時のGitHub認証アカウントを選択しないため、両アカウントで同じ固定バージョンを利用できます。

## 監査ログ

Issue・Pull Request・Draft Release・Workflow Dispatch・Label・Milestone操作の開始と完了をJSON Lines形式で記録します。

記録対象:

- timestamp
- tool
- hostname
- account（`GH_MCP_EXPECTED_LOGIN`設定時）
- repository
- issueNumber（対象が存在する場合）
- pullRequestNumber（対象が存在する場合）
- releaseId（対象が存在する場合）
- workflow（Workflow Dispatchの場合）
- label（Label操作の場合）
- milestoneNumber（Milestone操作の場合）
- owner / projectId（GitHub Projects v2操作の場合）
- outcome (`started` / `succeeded` / `failed`)
- durationMs

次の情報は記録しません。

- Issueタイトル
- Issue本文
- コメント本文
- Pull Requestタイトル・本文
- Pull Requestコメント・レビュー本文
- Release名・本文・タグ名
- Workflow inputs
- Label / Milestoneの説明
- Projectのタイトル、説明、README
- Token、Secret
- GitHub CLIの標準出力・標準エラー全文

開始レコードを書けない場合、書き込み操作は実行しません。完了レコードの書き込みに失敗した場合は、MCPレスポンスの`audit.completed`が`false`になります。

## Secure MCP Tunnel設定例

npm公開前はローカルビルドをSecure MCP Tunnelからstdio起動してChatGPTとの疎通を確認できます。Runtime API KeyやGitHub tokenなどの認証情報は保存しません。Tunnel IDは認証情報ではなく`init`に必要な識別子ですが、リポジトリへcommitしたり意図したTunnel運用者以外へ共有したりしないでください。2アカウントを同時に公開する場合は、別々のTunnel ID、profile、health portを使用します。

```powershell
npm run build
npm run smoke:stdio

tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli-ma-nakaya `
  --tunnel-id <ma-nakaya-tunnel-id> `
  --health-listen-addr "127.0.0.1:8081" `
  --mcp-command "node C:\src\onprem-gh-cli-mcp-server\dist\cli.js"

tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli-masa-nakaya `
  --tunnel-id <masa-nakaya-tunnel-id> `
  --health-listen-addr "127.0.0.1:8082" `
  --mcp-command "node C:\src\onprem-gh-cli-mcp-server\dist\cli.js"

tunnel-client.exe doctor --profile gh-cli-ma-nakaya --explain
tunnel-client.exe doctor --profile gh-cli-masa-nakaya --explain
```

書き込みツールを使う前に、ChatGPTで各アカウント専用アプリを個別に選択し、それぞれの`get_auth_status`をend-to-endで実行して期待loginとactive loginの一致を確認してください。両方の確認が成功するまでは書き込みを行いません。

ChatGPT Developer modeでのTunnel選択、Scan Tools、読み取り疎通確認を含む手順は[ChatGPT connectivity runbook](docs/chatgpt-connectivity.md)を参照してください。

手動疎通確認後は、`scripts/windows/run-gh-cli-mcp-tunnel.vbs`と`install-gh-cli-tunnel-task.ps1`を使用して、アカウント別のTunnel Clientをコンソール非表示でログオン時に起動できます。汎用VBS wrapperはScheduled Taskから受け取った非秘密設定をprocess environmentへ設定します。Installerはwrapperのv2 handshakeを検証し、profile名が正規化後に`gh-cli-<account>`と完全一致することを必須にします。Taskは現在の対話ユーザーだけに登録できます。Runtime API KeyとGitHub tokenはVBSやScheduled Task引数へ保存しません。Tunnel IDは既存のTunnel profileに保持し、wrapperやTask引数には渡しません。

単一アカウントでも全引数を明示します。2アカウントの場合は、`Account`、profile、`GH_CONFIG_DIR`、ログ、Task名を変えてこの登録を2回行います。

```powershell
$installer = "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\install-gh-cli-tunnel-task.ps1"
$ghPath = (Get-Command gh.exe).Source
$auditDir = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\audit"
New-Item -ItemType Directory -Force $auditDir | Out-Null

& $installer `
  -Account "ma-nakaya" `
  -ProfileName "gh-cli-ma-nakaya" `
  -GhConfigDir (Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\gh\ma-nakaya") `
  -AllowedOwners "ma-nakaya" `
  -AllowedRepositories "" `
  -AuditLogPath (Join-Path $auditDir "audit-ma-nakaya.jsonl") `
  -LogPath "C:\Apps\TunnelClient\gh-cli-ma-nakaya.log" `
  -Hostname "github.com" `
  -GhPath $ghPath `
  -TaskName "OpenAI Secure MCP Tunnel - GH CLI - ma-nakaya"
```

完全な2系統の登録・起動例はrunbookを参照してください。

## セキュリティ

- `shell: false`で`gh.exe`を直接起動
- `gh auth token`と`--show-token`を拒否
- `run_gh`では書き込み系サブコマンドを拒否し、リソース許可リスト設定時は`auth status`以外も拒否
- 書き込み操作は入力スキーマを持つ専用ツールだけに限定
- Issue本文とコメントは標準入力で渡し、プロセス引数へ載せない
- Pull Requestのタイトル、本文、コメント、レビュー本文も標準入力で渡す
- Release名、本文、タグ名も標準入力で渡す
- Workflow Dispatchのrefとinputsも標準入力で渡す
- Label / Milestoneの名前、説明、状態、期日も標準入力で渡す
- GitHub Projects v2のGraphQL queryとvariablesも標準入力で渡す
- 子プロセスへ渡す環境変数を限定
- `GH_MCP_EXPECTED_LOGIN`設定時は起動前と書き込み前にactive loginを検証
- アカウント別`GH_CONFIG_DIR`、許可リスト、監査ログ、Tunnel profileの分離に対応
- GitHub Tokenらしい出力をマスク
- 実行時間と出力量を制限
- Repository/Owner/Hostの許可リストに対応
- 監査ログへIssue・Pull Request・Releaseの本文やコメント、Workflow inputs、Label / Milestoneの説明、Projectのタイトル・説明・README、Token、Secretを保存しない
- Pull Requestマージ機能を提供しない
- Release公開・削除・Asset操作を提供しない
- Workflow再実行・キャンセル・Run削除を提供しない
- Label / Milestone削除を提供しない
- Project公開状態変更・削除、Item削除、Field定義変更、Draft Item作成を提供しない

## 現在の実装範囲

- Phase 1: 基盤、読み取り、Organization一覧、許可リスト、CI、実機確認
- Phase 2a: Issue作成・更新・コメント、JSONL監査ログ
- Phase 2b: Pull Request作成・更新・会話コメント・レビュー
- Phase 2c: Draft Release作成・更新
- Phase 2d: Workflow Dispatch
- Phase 2e: Label・Milestone作成・更新
- Phase 2f: GitHub Projects v2作成・更新、Item/Field一覧、既存Issue/PR追加、Field値設定・消去、Item archive/restore
- Phase 3a: GitHub CLIアカウント固定、監査account、複数アカウント分離運用
- Phase 4a: ChatGPT / Secure MCP Tunnel疎通手順とstdioスモークテスト
- 未実装: Release公開、Project/Item削除、Project Field定義変更、Draft Item、PRマージ、Secret、二段階承認

## 開発

```powershell
npm install
npm run check
npm test
npm run build
npm run smoke:stdio
```

## License

MIT
