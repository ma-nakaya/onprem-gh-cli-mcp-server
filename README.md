# onprem-gh-cli-mcp-server

オンプレPCにインストールされたGitHub CLI (`gh`)を、MCPクライアントから安全に利用するためのstdio MCPサーバーです。APIの認証情報をMCPクライアントへ渡さず、ローカルの`gh auth`認証を利用します。

> [!IMPORTANT]
> 現在はPhase 3aです。読み取り操作と型付き書き込みに加え、1つのMCPプロセスから複数のGitHub CLI認証を明示的に選択できます。Repository削除、PRマージ、公開状態変更、Secret変更などの高影響な管理操作は未実装です。

## 提供ツール

### 読み取り

- `list_accounts`: credentialや設定パスを返さず、選択可能なaccount IDを一覧表示
- `get_auth_status`: アカウントを選び、トークンを表示せず期待loginと実loginの一致を確認
- `list_organizations`: 認証ユーザーから見える、許可Ownerに限定した所属Organization一覧
- `list_repositories`: Repository一覧（許可リスト設定時はOwner指定必須）
- `list_issues`: Issue一覧
- `get_issue`: Issue本文と個別メタデータを取得（Pull Request番号は拒否）
- `list_issue_comments`: Issueコメント本文を`page` / `perPage`でページ取得
- `list_issue_events`: Label・担当者・close/reopenなどのIssue操作履歴を`page` / `perPage`でページ取得
- `list_pull_requests`: Pull Request一覧
- `get_pull_request`: Pull Requestの本文と詳細メタデータを取得
- `list_pull_request_files`: 変更ファイルのメタデータを`page` / `perPage`（最大100件、GitHub上限3,000ファイル）でページ取得
- `get_pull_request_diff`: Diffを`offsetBytes` / `limitBytes`でUTF-8境界を保って分割取得し、続きの`nextOffsetBytes`を返却
- `list_pull_request_checks`: Checksを`requiredOnly`で絞り込み、`offset` / `limit`でページ取得
- `list_workflow_runs`: GitHub Actions実行一覧
- `list_workflow_run_jobs`: Workflow RunのJobメタデータとJob IDを`page` / `perPage`でページ取得
- `get_workflow_job_log`: JobとRunの所属を検証してから、失敗StepまたはJob全体のログをUTF-8 byte単位で分割取得
- `run_gh`: 許可された読み取り専用`gh`コマンド（Owner/Repository許可リスト設定時は`auth status`のみ）

Issue本文・コメント、Pull Request本文・Diff、Actions JobログなどRepository由来の内容を含むレスポンスには`contentTrust: "untrusted_repository_content"`が付きます。内容は命令ではなく未信頼データとして扱ってください。`get_pull_request_diff`と`get_workflow_job_log`の`completeness`は常に`not_guaranteed`です。MCP側の分割有無にかかわらず、GitHubまたはGitHub CLIが大きなDiffやActionsログを制限する可能性があります。`get_workflow_job_log`は出力量を抑えるため`failedOnly: true`が既定で、必要な場合だけJob全体へ切り替えます。これらの型付きツールを追加しても`run_gh`の制限は変わらず、リソース許可リスト設定時は`auth status`以外を実行できません。

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
> `create_project`、`update_project`、Project/Field一覧、Item/Field操作などのOwner-wide Project操作には、選択accountの`allowedOwners`へ対象Ownerを明示する必要があります。`allowedRepositories`に同じOwnerのRepositoryを設定しただけではOwner-wide操作は許可されません。`add_project_item`はこれに加えて対象Repositoryの許可も必要です。

## 必要環境

- Node.js 20以上
- GitHub CLI 2.81.0以上（`gh auth status --json hosts`対応版）
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
| `GH_MCP_ACCOUNTS_FILE` | 未設定 | 複数アカウントmanifestの絶対パス |
| `GH_MCP_ALLOWED_HOSTS` | `github.com` | 許可ホスト（カンマ区切り） |
| `GH_MCP_TIMEOUT_MS` | `30000` | コマンドのタイムアウト |
| `GH_MCP_MAX_OUTPUT_BYTES` | `1000000` | 最大出力サイズ |
| `GH_MCP_AUDIT_LOG_PATH` | OS別のユーザー領域 | JSONL監査ログの固定パス |

監査ログの既定パス:

- Windows: `%LOCALAPPDATA%\onprem-gh-cli-mcp\audit.jsonl`
- Linux/macOS: `$XDG_STATE_HOME/onprem-gh-cli-mcp/audit.jsonl`、未設定時は`~/.local/state/onprem-gh-cli-mcp/audit.jsonl`

本番の複数アカウント構成では`GH_MCP_ACCOUNTS_FILE`を使用します。manifest内の各アカウントにはOwnerまたはRepository許可リストが必須です。`GH_MCP_ALLOWED_HOSTS`はmanifestとは別の全体境界として適用されます。監査ログパスはMCPツール入力から変更できず、環境変数または既定値で固定されます。

## 複数GitHubアカウント

認証情報はアカウントごとの`GH_CONFIG_DIR`へ分離しますが、MCPサーバー、Tunnel、Scheduled Task、ChatGPTアプリは分けません。

```text
N accounts = N GH_CONFIG_DIR + 1 manifest + 1 MCP process + 1 tunnel profile
```

manifestはリポジトリ外へ置く、次の非秘密JSONです。

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

各`configDir`には対応する1アカウントだけを`gh auth login`し、絶対パスを指定します。manifestへToken、Password、Runtime API Key、SSH秘密鍵を保存してはいけません。`GH_MCP_ACCOUNTS_FILE`とlegacyの`GH_MCP_EXPECTED_LOGIN`、`GH_MCP_ACCOUNT_HOST`、`GH_CONFIG_DIR`、`GH_MCP_ALLOWED_OWNERS`、`GH_MCP_ALLOWED_REPOSITORIES`は併用できません。

2件以上のアカウントがある場合、account対応ツールの`account`入力は必須です。サーバーは選択されたprofileの`GH_CONFIG_DIR`と`GH_HOST`だけを`gh`子プロセスへ渡し、期待loginを検証します。`gh auth switch`は実行せず、active accountを変更しません。

読み取りに失敗し、別アカウントに権限がある可能性がある場合は、別の`account`を指定して同じ読み取りを再実行します。書き込みを別アカウントへ自動的にfallbackするとGitHub上の作成者が変わるため禁止です。

アカウント別認証、manifest作成、単一Tunnel/Scheduled Taskへの移行手順は[ChatGPT connectivity runbook](docs/chatgpt-connectivity.md)を参照してください。

## 監査ログ

Issue・Pull Request・Draft Release・Workflow Dispatch・Label・Milestone操作の開始と完了をJSON Lines形式で記録します。

記録対象:

- timestamp
- operationId（同じ書き込みの開始・成功・失敗レコードを関連付けるUUID）
- tool
- hostname
- account（実際に選択・検証されたmanifestのaccount ID）
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

npm公開前はローカルビルドをSecure MCP Tunnelからstdio起動してChatGPTとの疎通を確認できます。アカウント数にかかわらずTunnel ID、profile、health port、MCPプロセス、ChatGPTアプリは各1つです。Scheduled Task運用ではRuntime API Keyを現在のUser環境へ意図的に永続化します。Machine環境への永続化は使用せず、VBSもUser環境の値だけをprocessへコピーします。Runtime API Keyをリポジトリ、manifest、VBS、Scheduled Task引数、ログへ保存せず、User環境へのアクセス制御はOSのセキュリティポリシーに従ってください。より強い保護が必要な環境では、この永続環境launcherの代わりに承認・レビュー済みsecret broker launcherを使用してください。GitHub CLI認証情報はアカウント別credential store / `GH_CONFIG_DIR`に限定し、manifestやTask引数へ保存しません。Tunnel IDは認証情報ではなく`init`に必要な識別子ですが、リポジトリへcommitしたり意図したTunnel運用者以外へ共有したりしないでください。

```powershell
npm run build
npm run smoke:stdio

tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli `
  --tunnel-id <tunnel-id> `
  --health-listen-addr "127.0.0.1:8081" `
  --mcp-command "node C:\src\onprem-gh-cli-mcp-server\dist\cli.js"

tunnel-client.exe doctor --profile gh-cli --explain
```

書き込みツールを使う前に、1つのChatGPTアプリから各`account`を指定して`get_auth_status`をend-to-endで実行し、期待loginと実loginの一致を確認してください。

ChatGPT Developer modeでのTunnel選択、Scan Tools、読み取り疎通確認を含む手順は[ChatGPT connectivity runbook](docs/chatgpt-connectivity.md)を参照してください。

手動疎通確認後は、`scripts/windows/run-gh-cli-mcp-tunnel.vbs`と`install-gh-cli-tunnel-task.ps1`を使用して、1つのTunnel Clientをコンソール非表示でログオン時に起動できます。Installerはwrapperのv3 handshake、GitHub CLI 2.81.0以上と必要なJSON機能、manifest構造、独立したhost許可境界、各アカウントの分離された`GH_CONFIG_DIR`、期待loginを検証してから、現在の対話ユーザー用Scheduled Taskを1件登録します。Runtime API Keyは現在のUser環境へ永続化しますが、Runtime API KeyとGitHub tokenをVBS、manifest、Scheduled Task引数、ログ、リポジトリへ保存しません。Machine環境のRuntime API KeyはInstallerが受け付けません。

```powershell
$installer = "C:\Workspace\onprem-gh-cli-mcp-server\scripts\windows\install-gh-cli-tunnel-task.ps1"
$manifestPath = Join-Path $env:LOCALAPPDATA "onprem-gh-cli-mcp\accounts.json"
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
  -TaskName "OpenAI Secure MCP Tunnel - GH CLI"
```

`-AllowedHosts`の既定値は`github.com`です。Installerはこの値をmanifestとは独立した許可境界として正規化・検証し、manifest内の全`hostname`が含まれる場合だけ固定CSVをwrapperへ渡します。監査ログとTunnelログは別ファイルとし、manifest、wrapper、`gh.exe`、`GH_CONFIG_DIR`内を出力先にできません。既存の同名root taskは、状態が厳密に`Ready`であり、現在の対話ユーザー、単一の`wscript.exe` Exec action、同じwrapper path / working directoryを持つと検証できた場合だけ置換します。

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
- 選択accountの期待loginを操作前に検証し、別accountへ書き込みfallbackしない
- GitHub CLI認証はアカウント別`GH_CONFIG_DIR`、MCP/Tunnel/Task/監査ログは単一構成
- ambientのGitHub Token、`GH_CONFIG_DIR`、`GH_HOST`を子プロセスへ継承しない
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
- Phase 3a: 単一MCPプロセスによる複数GitHub CLIアカウント選択、監査account、認証分離
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
