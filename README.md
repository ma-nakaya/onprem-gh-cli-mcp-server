# onprem-gh-cli-mcp-server

オンプレミスのPCにインストールされた GitHub CLI（`gh`）を、MCP クライアントから安全に利用するための stdio MCP サーバーです。GitHub の認証情報を MCP クライアントへ渡さず、ローカルの `gh auth` 認証をそのまま使います。読み取り、Issue／Pull Request の型付き書き込み、レビュー会話、確認付きの Repository 管理、Pull Request のマージ、GitHub Projects v2 操作、Release の公開・削除と Asset 操作、Repository の公開状態変更・rename・archive・transfer、ブランチ削除、Workflow Run のキャンセル・再実行・削除、Label／Milestone の削除、Project の削除・Field 定義変更・Draft Item 作成、Organization／Environment を含む Secret の管理までを、96 個の型付きツールとして提供します。

## 特徴

- **汎用実行にしない**: GitHub API を自由に実行させるのではなく、操作ごとに型付きツールを用意します。`run_gh` は読み取り専用コマンドだけに限定します。
- **認証情報を渡さない**: 子プロセスへ渡す環境変数を限定し、`gh` の認証はアカウント別の `GH_CONFIG_DIR` に分離します。トークンはレスポンス・引数・監査ログへ載せません。
- **書き込みは監査対象**: 書き込み操作は開始・完了を JSONL 監査ログへ記録します。本文やコメントなどの内容は記録しません。
- **破壊的操作には二重確認**: Pull Request のマージは head SHA の一致、Repository の削除は stable ID と `owner/name` の一致を必須とします。
- **許可リストで境界を固定**: Host／Owner／Repository の許可リストで、アクセス範囲を必要最小限にできます。

## 動作要件

- Node.js 20 以上
- GitHub CLI 2.81.0 以上（`gh auth status --json hosts` 対応版）
- `gh auth login` が完了していること

書き込み操作には、対象 Repository と GitHub Actions への必要権限を持つ GitHub CLI 認証が別途必要です。

## セットアップと起動

公開版を使う場合は、レビュー済みバージョンを固定して起動します。

```powershell
npx.cmd --yes --prefer-offline @ma-nakaya/onprem-gh-cli-mcp@0.1.0
```

MCP クライアントの設定例:

```json
{
  "mcpServers": {
    "onprem-gh-cli": {
      "command": "npx",
      "args": ["--yes", "@ma-nakaya/onprem-gh-cli-mcp@0.1.0"]
    }
  }
}
```

ローカル開発時はビルドしてから起動します。

```powershell
npm install
npm run build
node dist/cli.js
```

リポジトリ同梱のプラグインとして使う場合の設定は `mcp.json` を参照してください。

## ツール一覧

### 読み取り

- `list_accounts`: 認証情報や設定パスを返さず、選択可能な account ID を一覧表示
- `get_auth_status`: 選択したアカウントについて、トークンを表示せず期待 login と実際の login の一致を確認
- `list_organizations`: 認証ユーザーから見える所属 Organization を、許可 Owner に限定して一覧表示
- `list_repositories`: Repository 一覧（許可リスト設定時は Owner 指定が必須）
- `get_repository`: stable Repository ID、説明、visibility などのメタデータを取得
- `list_repository_tree`: branch／tag／commit のコミット済みツリーを、任意ディレクトリからページ取得
- `get_repository_file`: コミット済みの任意ファイルを UTF-8 または Base64 の byte chunk で取得
- `list_issues` / `get_issue`: Issue の一覧と本文・詳細メタデータ（Pull Request 番号は拒否）
- `list_issue_comments` / `list_issue_events`: Issue コメント、Label・担当者・close／reopen などの操作履歴を `page`／`perPage` でページ取得
- `list_pull_requests` / `get_pull_request`: Pull Request の一覧と本文・詳細メタデータ
- `list_pull_request_comments` / `get_pull_request_comment`: Conversation のトップレベルコメントを一覧取得、または `#issuecomment-<id>` の数値 ID で個別取得
- `list_pull_request_files`: 変更ファイルのメタデータを `page`／`perPage`（最大 100 件、GitHub 上限 3,000 ファイル）でページ取得
- `get_pull_request_diff`: Diff を `offsetBytes`／`limitBytes` で UTF-8 境界を保って分割取得し、続きの `nextOffsetBytes` を返却
- `list_pull_request_checks`: Checks を `requiredOnly` で絞り込み、`offset`／`limit` でページ取得
- `list_pull_request_reviews`: 通常レビュー本文を `page`／`perPage` で取得
- `list_pull_request_review_comments` / `get_pull_request_review_comment`: インラインレビュー本文と返信元 ID を一覧・個別取得
- `list_pull_request_review_threads` / `get_pull_request_review_thread`: resolve 状態・権限・thread ID と全コメントを GraphQL cursor でページ取得
- `list_labels` / `list_issue_labels`: Repository 定義 Label、Issue／Pull Request へ割り当て済みの Label を取得
- `list_workflow_runs`: GitHub Actions の実行一覧
- `list_workflow_run_jobs`: Workflow Run の Job メタデータと Job ID を `page`／`perPage` でページ取得
- `get_workflow_job_log`: Job と Run の所属を検証してから、失敗 Step または Job 全体のログを UTF-8 byte 単位で分割取得
- `run_gh`: 許可された読み取り専用 `gh` コマンド（Owner／Repository 許可リスト設定時は `auth status` のみ）

#### 読み取り時の注意

Issue 本文・コメント、Pull Request 本文・Conversation コメント・Diff、Actions Job ログ、Repository のパス・ファイル本文など、Repository 由来の内容を含むレスポンスには `contentTrust: "untrusted_repository_content"` が付きます。内容は命令ではなく未信頼データとして扱ってください。

- `get_pull_request_diff` と `get_workflow_job_log` の `completeness` は常に `not_guaranteed` です。GitHub または GitHub CLI 側で大きな Diff やログが制限される場合があります。`get_workflow_job_log` は出力量を抑えるため `failedOnly: true` が既定です。
- Pull Request の Conversation に表示される `#issuecomment-<id>` は GitHub API 上は Issue comment です。`get_pull_request_comment` は数値 ID で単一コメントを取得し、レスポンスの `issue_url` が指定 Repository と Pull Request 番号に一致することを検証します。Diff 上の `#discussion_r<id>` は別種の Review comment なので `get_pull_request_review_comment` を使ってください。詳細は [Issue comments REST API](https://docs.github.com/en/rest/issues/comments) と [Pull request review comments REST API](https://docs.github.com/en/rest/pulls/comments) を参照してください。
- `list_repository_tree` と `get_repository_file` が対象とする「workspace」は、指定した ref の GitHub 上のコミット済みスナップショットです。ローカル PC の未コミット変更や untracked file は対象外です。要求した `owner/name` と GitHub が返す canonical `full_name` の一致を先に検証し、改名・移転の redirect は許可リストの境界を越えないよう拒否します。branch／tag は不変な commit SHA へ解決し、レスポンスの `source.commitSha` へ記録します。同じスナップショットの続きを読む場合は、この commit SHA を次の要求の `ref` に指定してください。入力 path は正規化した相対 path に限定し、1 回の要求は最大 64 components です。
- `list_repository_tree` の `recursive: true` は GitHub Git Trees API の上限で打ち切られる場合があり、その場合は `upstreamTruncated: true`、`completeness: "not_guaranteed"` を返します。完全に巡回するには `recursive: false` で各 directory を順に指定してください。詳細は [Git Trees API](https://docs.github.com/en/rest/git/trees) を参照してください。
- `get_repository_file` は最大 100 MiB の Git blob を対象に、全体の byte 数と Git blob SHA を検証してから要求 chunk だけを返します。UTF-8 は文字境界を保ち、binary は Base64 で正確に取得できます。symlink はリンク先 path を格納した blob だけを返してリンク先を追わず、submodule は拒否し、Git LFS は pointer file だけを返して LFS object を追いません。GitHub の raw Blob API は部分 Range 取得として扱えないため、複数 chunk の各要求で blob 全体を再取得・検証します。詳細は [Git Blobs API](https://docs.github.com/en/rest/git/blobs) を参照してください。
- ファイル内容は byte の正確性を保つため pattern 置換しません。Repository へ誤って commit された認証情報もそのまま返る可能性があるため、認証情報を commit せず、アカウントの Owner／Repository 許可リストを必要最小限にしてください。MCP 自身が使う GitHub CLI 認証情報は子プロセス環境へ分離され、レスポンス・引数・監査ログへ載せません。

### Issue 書き込み

- `create_issue`: Issue を作成
- `update_issue`: Issue のタイトル、本文、open／closed 状態を更新
- `comment_issue`: Issue へコメントを追加

Issue 本文とコメントはコマンドライン引数へ載せず、`gh api --input -` の標準入力として JSON で渡します。

### Pull Request 書き込み

- `create_pull_request`: Pull Request を作成（既定は Draft）
- `update_pull_request`: タイトル、本文、open／closed 状態を更新
- `comment_pull_request`: Conversation へコメントを追加
- `review_pull_request`: Approve、Request changes、Comment レビューを送信
- `create_pull_request_review_comment`: `expectedHeadSha` で固定した Diff へ line／file 単位のインラインコメントを追加
- `reply_pull_request_review_comment`: 対象 PR への所属を検証した top-level インラインコメントへ返信
- `update_pull_request_review_comment`: `expectedUpdatedAt` 一致時だけインライン本文を編集
- `delete_pull_request_review_comment`: node ID と `expectedUpdatedAt` の二重確認後にインラインコメントを完全削除
- `resolve_pull_request_review_thread` / `unresolve_pull_request_review_thread`: thread の所属・現在状態・viewer 権限を検証して resolve 状態を変更
- `merge_pull_request`: `expectedHeadSha` 一致時だけ、明示した `merge`／`squash`／`rebase` 方式でマージ

タイトル、本文、コメント、レビュー本文、GraphQL mutation は標準入力で渡し、監査ログへ保存しません。Thread ID や Review Comment ID は対象 Repository／PR との所属を事前検証します。マージは現在の head SHA が入力値と完全一致しない限り拒否し、`destructiveHint: true` で公開します。

### Repository 管理

- `create_repository`: 明示的に許可された User／Organization 配下へ Repository を作成（既定の visibility は `private`）
- `update_repository_description`: `get_repository` が返した stable Repository ID 一致時だけ説明を更新・消去
- `delete_repository`: stable Repository ID と canonical `owner/name` の二重確認後に完全削除
- `update_repository_visibility`: 削除と同じ二重確認のうえで visibility（`public`／`private`／`internal`）を変更。現在の visibility と同じ値への変更は拒否
- `rename_repository`: 削除と同じ二重確認のうえで Repository 名を変更
- `set_repository_archived`: 数値 ID を確認のうえで archive／unarchive を切り替え
- `transfer_repository`: 削除と同じ二重確認のうえで別 User／Organization へ移管
- `delete_branch`: head SHA の一致を確認してブランチを削除（デフォルトブランチは削除不可）

Owner-wide な作成には `allowedOwners` への明示設定が必要です。説明は標準入力で渡し、監査ログへ保存しません。`create_repository`、`delete_repository`、`update_repository_visibility`、`rename_repository`、`set_repository_archived`、`transfer_repository`、`delete_branch` は `destructiveHint: true` です。削除はこの MCP から取り消せません。

### Release 書き込み

- `create_release`: Release を常に Draft として作成
- `update_release`: 既存の Draft Release だけを更新
- `publish_release`: 既存の Draft Release だけを公開（任意で `prerelease` を同時指定）
- `delete_release`: Draft／公開済みを問わず Release を削除（タグ自体は消えません）
- `list_release_assets` / `upload_release_asset` / `delete_release_asset`: Asset の一覧、ローカルファイルからのアップロード、削除

Release 本文は標準入力で渡し、監査ログへ保存しません。公開済み Release の変更は提供しません。公開と削除はこの MCP から取り消せません。アップロードするファイルの内容は応答・監査へ含めません。

### Repository Secret

- `list_repository_secrets`: Actions Secret の名前と作成／更新日時を一覧（値は API からも返りません）
- `set_repository_secret`: Secret を作成・更新。値は標準入力でのみ `gh` へ渡し、プロセス引数・監査ログ・レスポンスのいずれにも含めません（監査には名前だけを記録）
- `delete_repository_secret`: Secret を削除

名前は GitHub の規則（英字／アンダースコアで開始し英数字とアンダースコアのみ、`GITHUB_` 接頭辞は禁止）で検証します。Organization の Secret（`list_organization_secrets` / `set_organization_secret` / `delete_organization_secret`、visibility は `all`／`private`／`selected`）と Environment の Secret（`list_environment_secrets` / `set_environment_secret` / `delete_environment_secret`）も同じ作法で提供します。

### Workflow Dispatch

- `dispatch_workflow`: active な GitHub Actions Workflow を ref と任意の inputs で起動
- `cancel_workflow_run`: 未完了の Run をキャンセル
- `rerun_workflow_run`: 完了済み Run を再実行（`failedJobsOnly` で失敗ジョブのみも可）
- `delete_workflow_run`: 完了済み Run とそのログを削除

対象 Workflow の存在と active 状態を事前確認します。inputs は標準入力で渡し、MCP レスポンスや監査ログへ保存しません。Workflow の処理内容によって影響が大きくなり得るため、`destructiveHint` は `true` です。Run 操作はいずれも現在の状態を事前に読み、cancel は未完了のみ、rerun／delete は完了済みのみに限定します。

### Label / Milestone 書き込み

- `create_label` / `update_label`: Label の作成、名前・色・説明の更新
- `add_issue_labels` / `remove_issue_label`: Issue または Pull Request へ既存 Label を追加・1 件削除
- `create_milestone` / `update_milestone`: Milestone の作成、タイトル・説明・状態・期日の更新
- `delete_label` / `delete_milestone`: 対象を事前に読んでから削除

入力は標準入力で渡し、監査ログへ保存しません。更新前に対象の存在を確認します。Label の色は 6 桁 16 進数、Milestone の期日は UTC ISO 8601 に限定します。

### GitHub Projects v2

- `create_project`: 許可された User／Organization 配下へ private Project を作成
- `update_project`: タイトル、短い説明、README、open／closed 状態、公開状態（`public`）を更新
- `delete_project`: 現在のタイトル完全一致の確認のうえで Project を削除
- `create_project_draft_item`: Draft Item を作成
- `delete_project_item`: Item を Project から削除（元 Issue／Pull Request は消えません）
- `create_project_field` / `update_project_field` / `delete_project_field`: Field 定義の作成（TEXT／NUMBER／DATE／SINGLE_SELECT／ITERATION）・名前と選択肢の更新・削除
- `list_project_items`: Project 内の Issue／Pull Request のメタデータを取得（本文と field value は返さない）
- `list_project_fields`: Field メタデータ、single-select option、iteration 情報を取得
- `add_project_item`: 既存の Issue／Pull Request を Project へ追加
- `set_project_item_field` / `clear_project_item_field`: text、number、date、single-select、iteration の値を設定・消去
- `set_project_item_archived`: Project Item を archive または restore

Owner Node ID は REST API から解決し、Project 操作は GitHub GraphQL API へ query と variables を標準入力で渡します。Project ID、Item ID はそれぞれ `PVT_`、`PVTI_` 形式に限定し、操作前に ProjectV2 と Owner の一致を確認します。タイトル、説明、README、field value は監査ログへ保存しません。

> [!IMPORTANT]
> `create_project`、`update_project`、Project／Field 一覧、Item／Field 操作などの Owner-wide な Project 操作には、選択した account の `allowedOwners` へ対象 Owner を明示する必要があります。`allowedRepositories` に同じ Owner の Repository を設定しただけでは許可されません。`add_project_item` はこれに加えて対象 Repository の許可も必要です。

## 設定

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GH_MCP_GH_PATH` | Windows: `gh.exe`／その他: `gh` | GitHub CLI の固定パス |
| `GH_MCP_ACCOUNTS_FILE` | 未設定 | 複数アカウント manifest の絶対パス |
| `GH_MCP_ALLOWED_HOSTS` | `github.com` | 許可ホスト（カンマ区切り） |
| `GH_MCP_TIMEOUT_MS` | `30000` | コマンドのタイムアウト |
| `GH_MCP_MAX_OUTPUT_BYTES` | `1000000` | 最大出力サイズ |
| `GH_MCP_AUDIT_LOG_PATH` | OS 別のユーザー領域 | JSONL 監査ログの固定パス |

監査ログの既定パス:

- Windows: `%LOCALAPPDATA%\onprem-gh-cli-mcp\audit.jsonl`
- Linux／macOS: `$XDG_STATE_HOME/onprem-gh-cli-mcp/audit.jsonl`、未設定時は `~/.local/state/onprem-gh-cli-mcp/audit.jsonl`

本番の複数アカウント構成では `GH_MCP_ACCOUNTS_FILE` を使います。manifest 内の各アカウントには Owner または Repository の許可リストが必須です。`GH_MCP_ALLOWED_HOSTS` は manifest とは別の全体境界として適用されます。監査ログのパスは MCP ツール入力から変更できず、環境変数または既定値で固定されます。

## 複数 GitHub アカウント

認証情報はアカウントごとの `GH_CONFIG_DIR` へ分離しますが、MCP サーバー、Tunnel、Scheduled Task は分けません。

```text
N accounts = N GH_CONFIG_DIR + 1 manifest + 1 MCP process + 1 tunnel profile
```

manifest はリポジトリ外へ置く、次のような非秘密 JSON です。

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

各 `configDir` には対応する 1 アカウントだけを `gh auth login` し、絶対パスを指定します。manifest へ Token、Password、Runtime API Key、SSH 秘密鍵を保存してはいけません。`GH_MCP_ACCOUNTS_FILE` と legacy な `GH_MCP_EXPECTED_LOGIN`、`GH_MCP_ACCOUNT_HOST`、`GH_CONFIG_DIR`、`GH_MCP_ALLOWED_OWNERS`、`GH_MCP_ALLOWED_REPOSITORIES` は併用できません。

2 件以上のアカウントがある場合、account 対応ツールの `account` 入力は必須です。サーバーは選択された profile の `GH_CONFIG_DIR` と `GH_HOST` だけを `gh` 子プロセスへ渡し、期待 login を検証します。`gh auth switch` は実行せず、active account を変更しません。

読み取りに失敗し、別アカウントに権限がある可能性がある場合は、別の `account` を指定して同じ読み取りを再実行します。書き込みを別アカウントへ自動的に fallback すると GitHub 上の作成者が変わるため、行いません。

## 監査ログ

書き込み操作（Issue、Pull Request、Draft Release、Workflow Dispatch、Label、Milestone、Projects v2 など）の開始と完了を JSON Lines 形式で記録します。

記録する項目: timestamp、operationId（同じ書き込みの開始・成功・失敗レコードを関連付ける UUID）、tool、hostname、account（実際に選択・検証された manifest の account ID）、repository、issueNumber、pullRequestNumber、releaseId、workflow、label、milestoneNumber、owner／projectId（対象が存在する場合）、outcome（`started`／`succeeded`／`failed`）、durationMs。

記録しない情報: Issue／Pull Request のタイトル・本文、コメント・レビュー本文、Release 名・本文・タグ名、Workflow inputs、Label／Milestone の説明、Project のタイトル・説明・README、Token、Secret、GitHub CLI の標準出力・標準エラー全文。

開始レコードを書けない場合、書き込み操作は実行しません。完了レコードの書き込みに失敗した場合は、MCP レスポンスの `audit.completed` が `false` になります。

## セキュリティと制約

- `shell: false` で `gh` を直接起動し、`gh auth token` と `--show-token` を拒否します
- `run_gh` では書き込み系サブコマンドを拒否し、リソース許可リスト設定時は `auth status` 以外も拒否します
- 書き込み操作は入力スキーマを持つ専用ツールだけに限定します
- 本文・コメント・説明・GraphQL query・Secret の値など、内容を含む入力は標準入力で渡し、プロセス引数と監査ログへ載せません
- 実行時間と出力量を制限し、GitHub CLI の通常出力に現れた Token らしい文字列をマスクします（byte 正確性が必要な `get_repository_file` の Repository 本文を除く）
- 周囲の環境にある GitHub Token、`GH_CONFIG_DIR`、`GH_HOST` を子プロセスへ継承しません
- 選択した account の期待 login を操作前に検証し、別 account へ書き込みを fallback しません

提供しない操作: 認証情報そのものの表示・変更（token の表示など）、force push、`run_gh` での任意書き込み、外部承認システムによる二段階承認。これらは機能の未実装ではなく、このサーバーの設計上の境界として意図的に残しています。

## 実装範囲

Phase 1（基盤・読み取り・許可リスト）から Phase 2a〜2f（Issue、Pull Request、Draft Release、Workflow Dispatch、Label／Milestone、Projects v2 の書き込み）、Phase 3a（複数アカウント選択）、Phase 3b（レビュー会話・SHA 固定マージ・Repository 管理・Label 割り当て）、Phase 4a（stdio 接続とスモークテスト）、Phase 4b（Release 公開・Repository 公開状態変更・Repository Secret の一覧／設定／削除）、Phase 5（最終：Repository の rename・archive・transfer、ブランチ削除、Release の削除と Asset 操作、Workflow Run のキャンセル・再実行・削除、Label／Milestone の削除、Project の削除・Item 削除・Draft Item 作成・Field 定義 CRUD・Iteration Field 作成、Organization／Environment Secret）までを実装済みです。Phase 4b／5 の機能は当初セキュリティ方針として意図的に未実装としていましたが、2026年11月2日に本人の指示で解禁しました。各機能とも既存の歯止め（許可リスト、監査、強い確認、値の非記録）をそのまま適用しています。

## 開発

```powershell
npm install
npm run check
npm test
npm run build
npm run smoke:stdio
```

## ライセンス

MIT License（`LICENSE` を参照）
