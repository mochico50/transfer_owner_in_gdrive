# transfer_owner_in_gdrive

Google ドライブ上の特定フォルダ配下にあるファイル／フォルダの **オーナー権限をバッチで譲渡する** Google Apps Script（GAS）のサンプルです。

GAS の実行時間制限（約 6 分）を考慮し、

- ① 「対象ファイル・フォルダのリストアップ」
- ② 「オーナー譲渡」

を分離しつつ、**スプレッドシートを「台帳兼キュー」**として利用することで、タイムアウトが発生しても再実行しやすい構成にしています。

> 典型的なユースケース：
> - 退職者のマイドライブ配下の特定フォルダだけ、後任メンバーにオーナーを引き継ぎたい
> - Drive 管理コンソールの「ユーザーデータ移行」だと「マイドライブ全体しか移せない」ケースをなんとかしたい

---

## 構成

GAS プロジェクトはざっくり次のファイルで構成されています。

- `common.gs`  
  - 定数・ユーティリティ（Script Properties、Slack 通知など）
  - タイムスタンプ生成、シート作成ヘルパー など
- `listup.gs`  
  - 対象フォルダ配下のフォルダ／ファイルを再帰的にリストアップ
  - 結果をスプレッドシートの `folders` / `files` シートに書き込む
- `transfer.gs`  
  - `folders` / `files` シートを読み、`transferStatus = "NOT_STARTED"` の行を順次処理
  - Drive 上のオーナーを変更し、結果をシートに書き戻す
- `testdata.gs`（任意）  
  - テスト用のフォルダツリー（多段フォルダ＋ファイル）を自動生成するためのスクリプト

スプレッドシート側には、最低限次の 2 シートを使います。

- `folders`
  - `folderId`, `path`, `crawlStatus`, `scannedAt`, `owner`, `transferStatus`, `transferredAt`
- `files`
  - `fileId`, `name`, `path`, `owner`, `transferStatus`, `transferredAt`

`crawlStatus` はリストアップ用（`QUEUED` / `DONE`）、  
`transferStatus` は譲渡用（`NOT_STARTED` / `DONE` / `SKIP_NOT_OWNER` / `ERROR`）として使います。

---

## 前提・想定環境

- Google Workspace もしくは個人 Google アカウント
- 対象フォルダのオーナー権限、またはオーナー譲渡が可能な適切な権限を持っていること
- Google スプレッドシートに紐づくコンテナバインドの GAS プロジェクトとして利用する想定です

---

## Script Properties の設定

以下の Script Properties を利用します（プロジェクトの「設定」＞「スクリプト プロパティ」から登録）。

| キー名             | 説明                                                                 |
|--------------------|----------------------------------------------------------------------|
| `ROOT_FOLDER_ID`   | リストアップ＆オーナー譲渡の対象となるルートフォルダの ID           |
| `NEW_OWNER_EMAIL`  | 譲渡先のユーザーのメールアドレス                                   |
| `SLACK_WEBHOOK_URL`（任意） | 通知先 Slack Incoming Webhook URL（設定しない場合は通知なし） |

※ 実装に合わせて、他にもプロパティがあれば README に追記してください。

---

## 使い方

### 1. スプレッドシート／GAS プロジェクトの準備

1. Google スプレッドシートを新規作成します。
2. スプレッドシート側から「拡張機能」＞「Apps Script」を開きます。
3. このリポジトリ内の `.gs` ファイルをプロジェクトにコピーします。
4. Script Properties に `ROOT_FOLDER_ID`, `NEW_OWNER_EMAIL` などを設定します。
5. （任意）`testdata.gs` を使う場合は、テスト用フォルダのルート ID も Script Properties に設定します。

### 2. リストアップフェーズ（listup）

1. `scanFoldersJobController` を**手動実行**します。
2. 初回実行時に、`folders` / `files` シートが自動作成され、`folders` シートにルートフォルダが `crawlStatus = "QUEUED"` で 1 行だけ登録されます。
3. コントローラは、内部で最大 N 件のフォルダをスキャンする `scanFoldersJobOnce_` を呼び出し、
   - 直下のファイルを `files` シートに追加
   - サブフォルダを `folders` シートに `crawlStatus = "QUEUED"` で追加
   - 処理済みフォルダは `crawlStatus = "DONE"` ＋ `scannedAt` 更新
4. まだ `crawlStatus = "QUEUED"` が残っていれば、`ScriptApp.newTrigger()` で **次回の時間トリガー** を登録します。
5. すべてのフォルダが `DONE` になったタイミングで、Slack へ完了通知（任意）を送信し、トリガーを削除します。

> GAS の実行時間制限にかからないよう、1 回あたりの処理件数は  
> `MAX_FOLDERS_PER_RUN` などの定数で制御しています。

### 3. オーナー譲渡フェーズ（transfer）

1. リストアップが完了したら、`transferOwnershipJobController` を**手動実行**します。
2. コントローラは、`folders` / `files` シートから `transferStatus = "NOT_STARTED"` の行を対象に、合計 N 件まで処理する `transferOwnershipJobOnce_` を呼び出します。
3. 各行で行うこと：
   - Drive から対象フォルダ／ファイルを取得
   - **現在のオーナーが実行ユーザーと一致する場合のみ** `setOwner(NEW_OWNER_EMAIL)` を実行
   - 結果に応じて `transferStatus` を `DONE` / `SKIP_NOT_OWNER` / `ERROR` などに更新
   - `owner` / `transferredAt` を更新
4. バッチ内で `ERROR` が発生した場合は、その件数を Slack に :warning: 通知します。
5. まだ `NOT_STARTED` の行が残っていれば、次回の時間トリガーを登録します。
6. すべて処理し終えたタイミングで、Slack に完了通知を送り、トリガーを削除します。

---

## 注意事項・制限事項

- **オーナー譲渡には権限が必要です**
  - 実行ユーザーがオーナーでないファイル／フォルダは `SKIP_NOT_OWNER` となり、譲渡されません。
- **共有ドライブには対応していません**
  - 本スクリプトは「マイドライブ配下のフォルダ」を前提としています。
- **GAS の制限**
  - 実行時間、トリガー数、Spreadsheet の行数など、GAS／スプレッドシートの制限に影響を受けます。
  - 対象件数や階層構造によっては、`MAX_FOLDERS_PER_RUN` / `MAX_TRANSFERS_PER_RUN` やトリガー間隔を調整する必要があります。
- **本番利用前にテスト推奨**
  - いきなり本番データ数万件ではなく、まずは小さいフォルダ構造で動作確認してください。

---

## カスタマイズのヒント

- **台帳の列を増やす**  
  - 例えば MIME タイプやサイズ、最終更新日などを `files` シートに持たせることで、  
    「特定の種類のファイルだけ譲渡する」といったフィルタリングも可能です。
- **Slack 通知の粒度調整**
  - すべてのエラーを通知するのではなく、一定件数を超えたときだけ通知する、などのカスタマイズが可能です。
- **他のバッチ処理への転用**
  - LockService＋台帳シート＋トリガーのパターンは、  
    アカウント棚卸しやグループメンバー整理など、他の情シス系バッチにもそのまま応用できます。

---

## ライセンス

ライセンスについては、このリポジトリ内の `LICENSE` ファイルをご確認ください。
