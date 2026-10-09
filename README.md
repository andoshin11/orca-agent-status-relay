# orca-agent-status-relay

[Orca](https://github.com/stablyai/orca) のエージェントの状態変化（ターン終了・入力待ち・権限確認待ち）を、指定した URL に転送する Orca plugin です。送信には [Standard Webhooks](https://www.standardwebhooks.com/) 形式の署名を付けます。

```text
Orca ── agent.status.changed ──▶ この plugin（worker） ── 署名付き POST ──▶ 設定した URL
```

> [!WARNING]
> Orca の plugin 機能は experimental です（pluginApi v1、互換性の保証なし）。この plugin は **Orca 1.4.223 で動作を確認**しています。

## できること

- `agent.status.changed` を購読し、状態が変わったときだけ送ります。Orca は同じ状態を数回続けて届けるため、重複は plugin 側で除きます（worker が再起動すると、直前と同じ状態をもう一度送ることがあります）。
- 既定で送る状態は `done`（ターン終了）・`waiting`（入力待ち）・`blocked`（権限確認待ち）です。設定で変えられます。
- 送信先の terminal を特定できるよう、`paneKey` を `tabId` と `leafId` に分けて送ります（後述）。

## 必要なもの

- Orca 1.4.223 以上
- macOS または Linux（Windows には未対応です。設定ファイルの権限確認が POSIX の権限に依存するためです）
- Settings → Plugins で plugin 機能を有効にしていること（既定では無効）

## インストール

Orca の **Settings → Plugins** で、Git URL を指定してインストールします。

1. plugin 機能のトグルを ON にします。
2. **プラグインをインストール** を押し、**Git URL** を選んで次の URL を入力します。

   ```text
   https://github.com/andoshin11/orca-agent-status-relay#v0.1.0
   ```

   `#` の後ろは使うバージョンのタグです。[Releases / Tags](https://github.com/andoshin11/orca-agent-status-relay/tags) から選んでください。タグを指定すると、そのコミットに固定してインストールされます。
3. 一覧の「Agent Status Relay」で **Review** を押し、権限 `events:subscribe` を確認して承認します。
4. 下の「設定」に従って設定ファイルを作ります。

Orca はリポジトリの中身をそのままコピーし、ビルドや `npm install` は行いません。この plugin には実行時の依存パッケージがないので、そのまま動きます（`devDependencies` は manifest の検証用です）。

### 更新

Git URL でインストールした plugin には、Orca から更新の通知は届きません。新しいタグを指定して、もう一度インストールしてください。

### 開発中のコードを試す

clone したフォルダを **ローカルフォルダー** として読み込むと、手元の変更をそのまま試せます。

## 設定

設定は `~/.config/orca-agent-status-relay/config.json` から読みます。Orca には plugin 用の設定画面がまだないためです。

署名用の鍵を作り、設定ファイルを所有者だけが読める権限で作成します。

```sh
mkdir -p ~/.config/orca-agent-status-relay
node -e "console.log('whsec_' + require('node:crypto').randomBytes(32).toString('base64'))"
```

```sh
( umask 077 && cat > ~/.config/orca-agent-status-relay/config.json <<'EOF'
{
  "url": "https://example.com/orca-events",
  "secret": "whsec_ここに上で作った鍵",
  "states": ["done", "waiting", "blocked"]
}
EOF
)
```

| キー | 必須 | 内容 |
| --- | --- | --- |
| `url` | ○ | 送信先。`https` のみ。`http` は loopback（`127.0.0.1`・`localhost`・`[::1]`）だけ許可。URL に認証情報は含められません。`localhost` は OS の名前解決に依存するので、確実に手元に送りたいなら `127.0.0.1` を使ってください |
| `secret` | ○ | Standard Webhooks の鍵（`whsec_` + base64、24〜64 バイト） |
| `states` | | 送る状態。`working`・`blocked`・`waiting`・`done` から選ぶ。省略時は `["done", "waiting", "blocked"]` |

- 設定ファイルは**イベントのたびに読み直す**ので、編集は plugin を再読み込みしなくても反映されます。
- ファイルがない・JSON が壊れている・値が不正・自分以外の所有になっている・グループや他人が読める権限になっている、のいずれかの場合は**何も送らず**、理由を plugin のログに出します。既定値で代わりに送ることはしません。
- ログは Settings → Plugins の plugin の行から見られます。ログに URL や鍵は出しません。

### 送信テスト

コマンド **「Agent Status Relay: Send test event」** を実行すると、`{"type":"relay.test","sentAt":...}` を 1 回送ります。設定と受信側の確認に使えます。

同梱のサンプル受信サーバーで、署名検証まで含めて手元で確かめられます。

```sh
RELAY_SECRET='whsec_...' node examples/receiver.mjs 47821
# config.json の url を http://127.0.0.1:47821/ にしておく
```

## 送信内容

```http
POST <url>
content-type: application/json
webhook-id: msg_<uuid>
webhook-timestamp: <秒>
webhook-signature: v1,<base64(HMAC-SHA256(secret, "<id>.<timestamp>.<body>"))>
```

```json
{
  "type": "agent.status.changed",
  "kind": "done",
  "worktreeId": "<repoId>::/path/to/worktree",
  "paneKey": "<tabId>:<leafId>",
  "tabId": "<tabId>",
  "leafId": "<leafId>",
  "state": "working",
  "mainAgent": { "state": "done", "stateStartedAt": 1791556062713 },
  "receivedAt": 1791556062714
}
```

- **`kind` を見てください。** `mainAgent.state` があればその値、なければ `state` です。全体の `state` は、バックグラウンドタスクやサブエージェントが動いている間はターンが終わっても `working` のままになります（上の例がそのケースです）。
- 受信側では [`examples/receiver.mjs`](examples/receiver.mjs) の `verifyStandardWebhook` と同じ手順で署名と時刻（±5 分）を検証してください。サンプルは再送攻撃（replay）を防ぎません。必要なら、受け取った `webhook-id` を許容時間のあいだ記録して、同じ ID を拒否してください。
- **`worktreeId` には worktree の絶対パスが含まれます**（ユーザー名やディレクトリ名も含みます）。外部のサービスに送る場合は、この点を踏まえて送信先を選んでください。

### terminal handle の特定

`tabId` と `leafId` は `orca terminal list --json` の各 terminal の `tabId`・`leafId` と一致します。受信側でこの 2 つを照合すれば、`orca terminal send --terminal <handle>` に使う handle が分かります（Orca 1.4.223 で 1 件に特定できることを確認済み）。

## 送信の方針

- **送信は 1 回だけで、再送しません。** タイムアウトした要求も受信側に届いている可能性があるためです。失敗は理由（`timeout`・`network`・`http_status`・`redirect`）をログに残します。
- **リダイレクトには従いません。** 署名付きの内容を、設定していない送信先に送らないためです。
- タイムアウトは 5 秒です。送信は 1 件ずつ順番に行うので、届くものは Orca が出した順に届きます。ただし失敗したものは抜け落ちます。
- **イベントの受け取りは送信を待たずにすぐ終えます。** Orca は、受け取りが終わらないイベントが 64 件に達するか、1 件が 5 分を超えると worker を強制終了するためです。
- **送信待ちは 20 件までです。** 送信先が応答しないなどで溜まった場合は古いものから捨て、`dropped` とログに出します（最悪でも 20 件 × 5 秒 = 100 秒で解消し、Orca が 5 分間やり取りのない worker を止める前に終わります）。
- 重複の判定は送信の成否に関係なく行います。設定の不備や送信失敗で送れなかった状態を、Orca が同じ内容で再び届けても、もう一度は送りません。
- worker の起動に失敗した場合、そのイベントは Orca 側で捨てられます（Orca のログに `event ... dropped` と出ます）。

## 権限について

Orca の権限確認ダイアログに表示されるのは `events:subscribe` だけです。ただしこの plugin の worker は、Orca の権限の仕組み（v0）の外で次のことも行います。

- `~/.config/orca-agent-status-relay/config.json` の読み込み
- 設定した URL への HTTP 通信

Orca v0 の plugin worker は普通の Node.js プロセスとして動き、ファイルやネットワークへのアクセスは権限で制限されません。インストール前にコード（`main.mjs` と `src/`）を確認してください。

## わかっている制約

- **セッションやターンの ID は送れません。** Orca のイベントに含まれていないためです（[stablyai/orca#15680](https://github.com/stablyai/orca/pull/15680)・[#15640](https://github.com/stablyai/orca/pull/15640) が open）。
- **`mainAgent.outcome`（正常終了か中断か）は、確認した範囲では一度も入っていませんでした。**
- `blocked` は実機では未確認です。`done` と `waiting` は Orca 1.4.223 + Claude Code で確認しています。
- Orca の marketplace（`orca-marketplace.json`）には登録していません。インストールは Git URL の指定で行います。

## 開発

```sh
npm ci --ignore-scripts
npm test

# Orca 本体の parser で orca-plugin.json を検証する（stablyai/orca の checkout が必要）
ORCA_SOURCE_DIR=/path/to/orca npm run check:manifest
```

CI では `engines.orca` と同じ Orca のタグ（v1.4.223）を取得して、manifest を検証します。

## ライセンス

[MIT](LICENSE)
