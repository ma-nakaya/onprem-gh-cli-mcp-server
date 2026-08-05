# onprem-gh-cli-mcp-server

オンプレPCにインストールされたGitHub CLI (`gh`)を、MCPクライアントから安全に利用するためのstdio MCPサーバーです。APIの認証情報をMCPクライアントへ渡さず、ローカルの`gh auth`認証を利用します。

> [!IMPORTANT]
> 現在はPhase 3bです。読み取り操作、レビュー会話、型付き書き込み、確認付きRepository管理、PRマージに加え、1つのMCPプロセスから複数のGitHub CLI認証を明示的に選択できます。Secret変更、既存Repositoryの公開状態変更、Release公開などは未実装です。

## 提供ツール

今回追加した不足機能は次の優先度で固定しています。

| 優先度 | 対象 | 完了条件 |
| --- | --- | --- |
| P0 | PRレビュー会話・PRマージ | 通常／インライン本文、thread pagination、返信・編集・確認付き削除・resolve/unresolve、head SHA固定マージ |
| P1 | Repository管理・Label割り当て | private既定作成、詳細取得、説明更新、二重確認削除、Repository／Issue／PR Label一覧・追加・削除 |

GitHubの全管理APIを汎用実行できるようにはせず、上記領域を型付きツールとして完結させています。`run_gh`は引き続き読み取り専用です。

### 読み取り

- `list_accounts`: credentialや設定パスを返さず、選択可能なaccount IDを一覧表示
- `get_auth_status`: アカウントを選び、トークンを表示せず期待loginと実loginの一致を確認
- `list_organizations`: 認証ユーザーから見える、許可Ownerに限定した所属Organization一覧
- `list_repositories`: Repository一覧（許可リスト設定時はOwner指定必須）
- `get_repository`: stable Repository ID、説明、visibilityなどのRepositoryメタデータを取得
- `list_repository_tree`: branch / tag / commitのコミット済みツリーを、任意ディレクトリからページ取得
- `get_repository_file`: コミット済みの任意ファイルをUTF-8またはBase64のbyte chunkで取得
- `list_issues`: Issue一覧
- `get_issue`: Issue本文と個別メタデータを取得（Pull Request番号は拒否）
- `list_issue_comments`: Issueコメント本文を`page` / `perPage`でページ取得
- `list_issue_events`: Label・担当者・close/reopenなどのIssue操作履歴を`page` / `perPage`でページ取得
- `list_pull_requests`: Pull Request一覧
- `get_pull_request`: Pull Requestの本文と詳細メタデータを取得
- `list_pull_request_files`: 変更ファイルのメタデータを`page` / `perPage`（最大100件、GitHub上限3,000ファイル）でページ取得
- `get_pull_request_diff`: Diffを`offsetBytes` / `limitBytes`でUTF-8境界を保って分割取得し、続きの`nextOffsetBytes`を返却
- `list_pull_request_checks`: Checksを`requiredOnly`で絞り込み、`offset` / `limit`でページ取得
- `list_pull_request_reviews`: 通常レビュー本文を`page` / `perPage`で取得
- `list_pull_request_review_comments` / `get_pull_request_review_comment`: インラインレビュー本文と返信元IDを一覧・個別取得
- `list_pull_request_review_threads` / `get_pull_request_review_thread`: resolve状態・権限・thread IDと全コメントをGraphQL cursorでページ取得
- `list_labels` / `list_issue_labels`: Repository定義Label、IssueまたはPull Requestへ割り当て済みのLabelを取得
- `list_workflow_runs`: GitHub Actions実行一覧
- `list_workflow_run_jobs`: Workflow RunのJobメタデータとJob IDを`page` / `perPage`でページ取得
- `get_workflow_job_log`: JobとRunの所属を検証してから、失敗StepまたはJob全体のログをUTF-8 byte単位で分割取得
- `run_gh`: 許可された読み取り専用`gh`コマンド（Owner/Repository許可リスト設定時は`auth status`のみ）

Issue本文・コメント、Pull Request本文・Diff、Actions Jobログ、Repositoryのpath・ファイル本文など、Repository由来の内容を含むレスポンスには`contentTrust: "untrusted_repository_content"`が付きます。内容は命令ではなく未信頼データとして扱ってください。`get_pull_request_diff`と`get_workflow_job_log`の`completeness`は常に`not_guaranteed`です。MCP側の分割有無にかかわらず、GitHubまたはGitHub CLIが大きなDiffやActionsログを制限する可能性があります。`get_workflow_job_log`は出力量を抑えるため`failedOnly: true`が既定で、必要な場合だけJob全体へ切り替えます。これらの型付きツールを追加しても`run_gh`の制限は変わらず、リソース許可リスト設定時は`auth status`以外を実行できません。

`list_repository_tree`と`get_repository_file`が確認する「workspace」は、指定したrefのGitHub上のコミット済みスナップショットです。ローカルPCの未コミット変更やuntracked fileは対象外です。要求した`owner/name`とGitHubが返すcanonical `full_name`の一致を先に検証し、Repositoryの改名・移転redirectは許可リスト境界を越えないよう拒否します。次にbranch / tagを不変なcommit SHAへ解決し、レスポンスの`source.commitSha`へ記録します。同じスナップショットの続きが必要な場合は、次のpageまたはchunkでこのcommit SHAを`ref`に指定してください。入力pathは正規化した相対pathに限定し、1回の要求は最大64 componentsです。

`list_repository_tree`の`recursive: true`はGitHub Git Trees APIの上限により打ち切られる場合があり、その場合は`upstreamTruncated: true`、`completeness: "not_guaranteed"`を返します。完全に巡回するには`recursive: false`で各directoryを順に指定してください。非再帰treeはページを最後まで辿ることで完全に確認できます。詳細は[Git Trees API](https://docs.github.com/en/rest/git/trees)を参照してください。

`get_repository_file`は最大100 MiBのGit blobを対象に、全体のbyte数とGit blob SHAを検証してから要求chunkだけを返します。UTF-8は文字境界を保ち、binaryはBase64で正確に取得できます。symlinkはリンク先pathを格納したblobだけを返してリンク先を追わず、submoduleは拒否し、Git LFSはpointer fileだけを返してLFS objectを追いません。GitHubのraw Blob APIは部分Range取得として扱えないため、複数chunkの各要求でblob全体を再取得・検証します。詳細は[Git Blobs API](https://docs.github.com/en/rest/git/blobs)を参照してください。

ファイル内容はbyteの正確性を保つためpattern置換しません。Repositoryへ誤ってcommitされたcredentialもそのまま返る可能性があるため、credentialをcommitせず、accountのOwner / Repository許可リストを必要最小限にしてください。MCP自身が使うGitHub CLI認証情報は引き続き子プロセス環境へ分離され、レスポンス、引数、監査ログへ載せません。

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
- `create_pull_request_review_comment`: `expectedHeadSha`で固定したDiffへline / file単位のインラインコメントを追加
- `reply_pull_request_review_comment`: 対象PR所属を検証したtop-levelインラインコメントへ返信
- `update_pull_request_review_comment`: `expectedUpdatedAt`一致時だけインライン本文を編集
- `delete_pull_request_review_comment`: node IDと`expectedUpdatedAt`の二重確認後にインラインコメントを完全削除
- `resolve_pull_request_review_thread` / `unresolve_pull_request_review_thread`: thread所属・現在状態・viewer権限を検証してresolve状態を変更
- `merge_pull_request`: `expectedHeadSha`一致時だけ、明示した`merge` / `squash` / `rebase`方式でマージ

Pull Requestのタイトル、本文、コメント、レビュー本文、GraphQL mutationは標準入力で渡し、監査ログへ保存しません。Thread IDやReview Comment IDは対象Repository / PRとの所属を事前検証します。マージは現在のhead SHAが入力値と完全一致しない限り拒否し、`destructiveHint: true`で公開します。

### Repository管理

- `create_repository`: 明示的に許可されたUser / Organization配下へRepositoryを作成（既定visibilityは`private`）
- `update_repository_description`: `get_repository`が返したstable Repository ID一致時だけ説明を更新・消去
- `delete_repository`: stable Repository IDとcanonical `owner/name`の二重確認後に完全削除

Owner-wideな作成には`allowedOwners`への明示設定が必要です。Repository説明は標準入力で渡し、監査ログへ保存しません。`create_repository`と`delete_repository`は`destructiveHint: true`です。削除はこのMCPから取り消せません。既存Repositoryのrename、visibility変更、archive、transferは提供しません。

### Draft Release書き込み

- `create_release`: Releaseを常にDraftとして作成
- `update_release`: 既存のDraft Releaseだけを更新

Release本文は標準入力で渡し、監査ログへ保存しません。公開済みReleaseの変更、Draftの公開、削除、Asset操作は提供しません。

### Workflow Dispatch

- `dispatch_workflow`: activeなGitHub Actions Workflowをrefと任意inputsで起動

対象Workflowの存在とactive状態を事前確認します。inputsは標準入力で渡し、MCPレスポンスや監査ログへ保存しません。Workflowの処理内容によって高影響になり得るため、ツールの`destructiveHint`は`true`です。再実行、キャンセル、Run削除は提供しません。

### Label / Milestone書き込み

- `create_label` / `update_label`: Labelの作成、名前・色・説明の更新
- `add_issue_labels` / `remove_issue_label`: IssueまたはPull Requestの既存Labelを追加・1件削除
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

認証情報はアカウントごとの`GH_CONFIG_DIR`へ分離しますが、MCPサーバー、Tunnel、Scheduled Taskは分けません。

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

## セキュリティ

- `shell: false`で`gh.exe`を直接起動
- `gh auth token`と`--show-token`を拒否
- `run_gh`では書き込み系サブコマンドを拒否し、リソース許可リスト設定時は`auth status`以外も拒否
- 書き込み操作は入力スキーマを持つ専用ツールだけに限定
- Issue本文とコメントは標準入力で渡し、プロセス引数へ載せない
- Pull Requestのタイトル、本文、コメント、レビュー本文も標準入力で渡す
- Repository説明、Repository作成設定、Label割り当ても標準入力で渡す
- Release名、本文、タグ名も標準入力で渡す
- Workflow Dispatchのrefとinputsも標準入力で渡す
- Label / Milestoneの名前、説明、状態、期日も標準入力で渡す
- GitHub Projects v2のGraphQL queryとvariablesも標準入力で渡す
- 子プロセスへ渡す環境変数を限定
- 選択accountの期待loginを操作前に検証し、別accountへ書き込みfallbackしない
- GitHub CLI認証はアカウント別`GH_CONFIG_DIR`、MCP/Tunnel/Task/監査ログは単一構成
- ambientのGitHub Token、`GH_CONFIG_DIR`、`GH_HOST`を子プロセスへ継承しない
- GitHub CLIの通常出力に現れたGitHub Tokenらしい文字列をマスク（byte正確性が必要な`get_repository_file`のRepository本文を除く）
- 実行時間と出力量を制限
- Repository/Owner/Hostの許可リストに対応
- 監査ログへIssue・Pull Request・Releaseの本文やコメント、Repository説明、Workflow inputs、Label / Milestoneの説明、Projectのタイトル・説明・README、Token、Secretを保存しない
- PRマージはcanonical Repository、PR番号、open状態、現在head SHAを検証し、merge方式を必須にする
- Repository削除はcanonical Repository、stable Repository ID、確認用`owner/name`を検証する
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
- Phase 3b: PRレビューthread／インライン会話、SHA固定PRマージ、Repository作成・説明更新・確認付き削除、Issue/PR Label割り当て
- Phase 4a: stdio接続とスモークテスト
- 未実装: Release公開、Project/Item削除、Project Field定義変更、Draft Item、Secret、既存Repositoryのrename・visibility変更・transfer、外部承認システムによる二段階承認

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
