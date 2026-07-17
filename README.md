# onprem-gh-cli-mcp-server

オンプレPCにインストールされたGitHub CLI (`gh`)を、MCPクライアントから安全に利用するためのstdio MCPサーバーです。APIの認証情報をMCPクライアントへ渡さず、ローカルの`gh auth`認証を利用します。

> [!IMPORTANT]
> 現在はPhase 2aです。読み取り操作に加え、型付きツールによるIssueの作成・更新・コメントを提供します。Repository削除、PRマージ、Secret変更などの破壊・管理操作は未実装です。

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

## 必要環境

- Node.js 20以上
- GitHub CLI
- 事前に`gh auth login`が完了していること

Issue書き込みには、対象RepositoryへのIssue書き込み権限を持つGitHub CLI認証が必要です。

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

Issue書き込みの開始と完了をJSON Lines形式で記録します。

記録対象:

- timestamp
- tool
- hostname
- repository
- issueNumber（対象が存在する場合）
- outcome (`started` / `succeeded` / `failed`)
- durationMs

次の情報は記録しません。

- Issueタイトル
- Issue本文
- コメント本文
- Token、Secret
- GitHub CLIの標準出力・標準エラー全文

開始レコードを書けない場合、書き込み操作は実行しません。完了レコードの書き込みに失敗した場合は、MCPレスポンスの`audit.completed`が`false`になります。

## Secure MCP Tunnel設定例

```yaml
mcp:
  transport: stdio
  command: npx.cmd
  args:
    - --yes
    - --prefer-offline
    - "@ma-nakaya/onprem-gh-cli-mcp@0.1.0"
```

## セキュリティ

- `shell: false`で`gh.exe`を直接起動
- `gh auth token`と`--show-token`を拒否
- `run_gh`では書き込み系サブコマンドを拒否
- 書き込み操作は入力スキーマを持つ専用ツールだけに限定
- Issue本文とコメントは標準入力で渡し、プロセス引数へ載せない
- 子プロセスへ渡す環境変数を限定
- GitHub Tokenらしい出力をマスク
- 実行時間と出力量を制限
- Repository/Owner/Hostの許可リストに対応
- 監査ログへIssue本文、コメント本文、Token、Secretを保存しない

## 現在の実装範囲

- Phase 1: 基盤、読み取り、Organization一覧、許可リスト、CI、実機確認
- Phase 2a: Issue作成・更新・コメント、JSONL監査ログ
- 未実装: PR・Release作成、Workflow Dispatch、Project、削除、PRマージ、Secret、二段階承認

## 開発

```powershell
npm install
npm run check
npm test
npm run build
```

## License

MIT
