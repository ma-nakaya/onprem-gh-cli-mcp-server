# onprem-gh-cli-mcp-server

オンプレPCにインストールされたGitHub CLI (`gh`)を、MCPクライアントから安全に利用するためのstdio MCPサーバーです。APIの認証情報をMCPクライアントへ渡さず、ローカルの`gh auth`認証を利用します。

> [!IMPORTANT]
> 現在はPhase 2fです。読み取り操作に加え、型付きツールによるIssue、Pull Request、Draft Release、Workflow Dispatch、Label、Milestone、GitHub Projects v2の書き込みを提供します。Repository削除、PRマージ、公開状態変更、Secret変更などの高影響な管理操作は未実装です。

## 提供ツール

### 読み取り

- `get_auth_status`: トークンを表示せず認証状態を確認
- `list_organizations`: 認証ユーザーから見える所属Organization一覧
- `list_repositories`: Repository一覧
- `list_issues`: Issue一覧
- `list_pull_requests`: Pull Request一覧
- `list_workflow_runs`: GitHub Actions実行一覧
- `run_gh`: 許可された読み取り専用`gh`コマンド

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

### GitHub Projects v2書き込み

- `create_project`: 許可されたUser / Organization配下へProjectを作成
- `update_project`: タイトル、短い説明、README、open/closed状態を更新

Owner Node IDはREST APIから解決し、Project操作はGitHub GraphQL APIへqueryとvariablesを標準入力で渡します。Project IDは`PVT_`形式に限定し、更新前にProjectV2であることを確認します。タイトル、説明、READMEは監査ログへ保存しません。公開状態変更、削除、Item、Field操作は提供しません。

## 必要環境

- Node.js 20以上
- GitHub CLI
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
| `GH_MCP_ALLOWED_HOSTS` | `github.com` | 許可ホスト（カンマ区切り） |
| `GH_MCP_ALLOWED_OWNERS` | 制限なし | 許可Owner/Organization |
| `GH_MCP_ALLOWED_REPOSITORIES` | 制限なし | 許可Repository (`owner/name`) |
| `GH_MCP_TIMEOUT_MS` | `30000` | コマンドのタイムアウト |
| `GH_MCP_MAX_OUTPUT_BYTES` | `1000000` | 最大出力サイズ |
| `GH_MCP_AUDIT_LOG_PATH` | OS別のユーザー領域 | JSONL監査ログの固定パス |

監査ログの既定パス:

- Windows: `%LOCALAPPDATA%\onprem-gh-cli-mcp\audit.jsonl`
- Linux/macOS: `$XDG_STATE_HOME/onprem-gh-cli-mcp/audit.jsonl`、未設定時は`~/.local/state/onprem-gh-cli-mcp/audit.jsonl`

本番利用では`GH_MCP_ALLOWED_OWNERS`または`GH_MCP_ALLOWED_REPOSITORIES`を必ず設定してください。監査ログパスはMCPツール入力から変更できず、環境変数または既定値で固定されます。

## 監査ログ

Issue・Pull Request・Draft Release・Workflow Dispatch・Label・Milestone操作の開始と完了をJSON Lines形式で記録します。

記録対象:

- timestamp
- tool
- hostname
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

npm公開前はローカルビルドをSecure MCP Tunnelからstdio起動してChatGPTとの疎通を確認できます。APIキーや`tunnel_id`はリポジトリへ保存しません。

```powershell
npm run build
npm run smoke:stdio

tunnel-client.exe init `
  --sample sample_mcp_stdio_local `
  --profile gh-cli `
  --tunnel-id <tunnel-id> `
  --mcp-command "node C:\src\onprem-gh-cli-mcp-server\dist\cli.js"

tunnel-client.exe doctor --profile gh-cli --explain
tunnel-client.exe run --profile gh-cli
```

ChatGPT Developer modeでのTunnel選択、Scan Tools、読み取り疎通確認を含む手順は[ChatGPT connectivity runbook](docs/chatgpt-connectivity.md)を参照してください。

## セキュリティ

- `shell: false`で`gh.exe`を直接起動
- `gh auth token`と`--show-token`を拒否
- `run_gh`では書き込み系サブコマンドを拒否
- 書き込み操作は入力スキーマを持つ専用ツールだけに限定
- Issue本文とコメントは標準入力で渡し、プロセス引数へ載せない
- Pull Requestのタイトル、本文、コメント、レビュー本文も標準入力で渡す
- Release名、本文、タグ名も標準入力で渡す
- Workflow Dispatchのrefとinputsも標準入力で渡す
- Label / Milestoneの名前、説明、状態、期日も標準入力で渡す
- GitHub Projects v2のGraphQL queryとvariablesも標準入力で渡す
- 子プロセスへ渡す環境変数を限定
- GitHub Tokenらしい出力をマスク
- 実行時間と出力量を制限
- Repository/Owner/Hostの許可リストに対応
- 監査ログへIssue・Pull Request・Releaseの本文やコメント、Workflow inputs、Label / Milestoneの説明、Projectのタイトル・説明・README、Token、Secretを保存しない
- Pull Requestマージ機能を提供しない
- Release公開・削除・Asset操作を提供しない
- Workflow再実行・キャンセル・Run削除を提供しない
- Label / Milestone削除を提供しない
- Project公開状態変更・削除・Item・Field操作を提供しない

## 現在の実装範囲

- Phase 1: 基盤、読み取り、Organization一覧、許可リスト、CI、実機確認
- Phase 2a: Issue作成・更新・コメント、JSONL監査ログ
- Phase 2b: Pull Request作成・更新・会話コメント・レビュー
- Phase 2c: Draft Release作成・更新
- Phase 2d: Workflow Dispatch
- Phase 2e: Label・Milestone作成・更新
- Phase 2f: GitHub Projects v2作成・更新
- Phase 4a: ChatGPT / Secure MCP Tunnel疎通手順とstdioスモークテスト
- 未実装: Release公開、Project Item・Field、削除、PRマージ、Secret、二段階承認

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
