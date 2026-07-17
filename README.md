# onprem-gh-cli-mcp-server

オンプレPCにインストールされたGitHub CLI (`gh`)を、MCPクライアントから安全に利用するためのstdio MCPサーバーです。APIの認証情報をMCPクライアントへ渡さず、ローカルの`gh auth`認証を利用します。

> [!IMPORTANT]
> 現在はPhase 1です。読み取り操作だけを提供します。Repository削除、PRマージ、Secret変更などの書き込み・破壊操作は未実装です。

## 提供ツール

- `get_auth_status`: トークンを表示せず認証状態を確認
- `list_organizations`: 認証ユーザーから見える所属Organization一覧
- `list_repositories`: Repository一覧
- `list_issues`: Issue一覧
- `list_pull_requests`: Pull Request一覧
- `list_workflow_runs`: GitHub Actions実行一覧
- `run_gh`: 許可された読み取り専用`gh`コマンド

## 必要環境

- Node.js 20以上
- GitHub CLI
- 事前に`gh auth login`が完了していること

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

本番利用では`GH_MCP_ALLOWED_OWNERS`または`GH_MCP_ALLOWED_REPOSITORIES`を必ず設定してください。

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
- 書き込み系サブコマンドを拒否
- 子プロセスへ渡す環境変数を限定
- GitHub Tokenらしい出力をマスク
- 実行時間と出力量を制限
- Repository/Owner/Hostの許可リストに対応

## 開発

```powershell
npm install
npm run check
npm test
npm run build
```

## License

MIT
