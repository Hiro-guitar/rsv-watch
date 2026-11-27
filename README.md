# rsv-watch

LINE予約ページ（Liny予約）の空き枠を5分おきに確認し、変化があったときだけLINEに通知する。予約の送信はしない（読むだけ）。

通知するとき
- 新しい月の枠が公開されたとき（一斉公開）
- 対象メニューに空きが出たとき（キャンセル）
- ログインが切れたとき／エラーが30分続いたとき

## セットアップ

### 1. 通知用のLINE公式アカウント（自分専用・無料）
1. LINE公式アカウントを新しく1つ作る（無料プラン）。仕事用とは分ける
2. 管理画面の「設定」→「Messaging API」で利用をオンにする
3. LINE Developers でそのチャネルを開き、
   - 「チャネル基本設定」の「あなたのユーザーID」（U から始まる）を控える
   - 「Messaging API設定」でチャネルアクセストークン（長期）を発行して控える
4. 自分のLINEで、そのアカウントを友だち追加する（QRコード）
5. 応答メッセージ・あいさつメッセージはオフにしておく

### 2. LINEのアクセストークンを取る（PCのChrome）
1. 開発者ツール（`Cmd+Option+I`）でスマホ表示にして予約ページを開き、LINEでログインする
2. 開発者ツールの「アプリケーション」→「ローカルストレージ」→ `https://rsv.e-ticket.link`
3. `LIFF_STORE:<数字>:accessToken` の値をコピーする（引用符つきのままでOK）

※ 有効期限は最長30日。切れたら通知が来るので、同じ手順で取り直して入れ替える。

### 3. GitHubの設定
リポジトリの Settings → Secrets and variables → Actions → New repository secret

| 名前 | 中身 |
|---|---|
| `LIFF_ACCESS_TOKEN` | 手順2でコピーした値 |
| `GROUP_ID` | 予約ページURLの `group_id=` の数字 |
| `LINE_CHANNEL_TOKEN` | 手順1のチャネルアクセストークン（長期） |
| `LINE_USER_ID` | 手順1のユーザーID（任意。省略すると友だち全員に一斉送信するので、友だちが自分だけのアカウントで使う） |
| `BOOK_URL` | 通知をタップしたときに開く予約ページのURL（任意） |

Actions タブ → watch → Run workflow で手動実行し、「予約監視を始めました」が届けば完了。

## 手元でのテスト

```sh
GROUP_ID=x DRY_RUN=1 FIXTURE=slots.json STATE_PATH=/tmp/state.json python3 watch.py
```

## 注意
- GitHubの定期実行は混雑時に数分〜十数分遅れることがある
- 公開リポジトリは、60日間コミットがないと定期実行が自動で止まる（Actions タブから再開できる）
