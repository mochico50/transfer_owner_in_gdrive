/****************************************************
 * common.gs  共通設定・ユーティリティ
 ****************************************************/

const SCRIPT_PROP = PropertiesService.getScriptProperties();

// リストアップ時：1回の実行で処理するフォルダ数
const MAX_FOLDERS_PER_RUN = 50;

// 譲渡時：1回の実行で処理するファイル/フォルダ数（合計）
const MAX_TRANSFERS_PER_RUN = 100;

// 次回の実行を何分後に予約するか（最短は1分）
const NEXT_RUN_DELAY_MINUTES = 1;

// Slack 通知用 Webhook URL（Script Properties 側に設定しておくとよい）
const SLACK_WEBHOOK_URL = SCRIPT_PROP.getProperty('SLACK_WEBHOOK_URL') || '';


/**
 * ROOT_FOLDER_ID（リストアップ対象ルートフォルダ）を取得
 */
function getRootFolderId_() {
  const id = SCRIPT_PROP.getProperty('ROOT_FOLDER_ID');
  if (!id) {
    throw new Error(
      'Script Properties に ROOT_FOLDER_ID が設定されていません。\n' +
      '「ファイル」→「プロジェクトのプロパティ」→「スクリプトのプロパティ」で設定してください。'
    );
  }
  return id;
}

/**
 * NEW_OWNER_EMAIL（譲渡先オーナー）を取得
 */
function getNewOwnerEmail_() {
  const email = SCRIPT_PROP.getProperty('NEW_OWNER_EMAIL');
  if (!email) {
    throw new Error(
      'Script Properties に NEW_OWNER_EMAIL が設定されていません。\n' +
      '譲渡先ユーザーのメールアドレスを設定してください。'
    );
  }
  return email;
}

/**
 * 実行ユーザーのメールアドレス
 */
function getCurrentUserEmail_() {
  return Session.getActiveUser().getEmail();
}

/**
 * 現在時刻のタイムスタンプ文字列を返す。
 * 例: 2025-12-04T17:30:00
 */
function nowTimestamp_() {
  return Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyy-MM-dd'T'HH:mm:ss"
  );
}


/**
 * folders シートの存在確認・初期化。
 *
 * カラム:
 * - folderId
 * - path
 * - crawlStatus: QUEUED / DONE
 * - scannedAt: クロール完了タイムスタンプ
 * - owner
 * - transferStatus: NOT_STARTED / DONE / SKIP_NOT_OWNER / ERROR など
 * - transferredAt: 譲渡処理を試したタイムスタンプ
 */
function initFolders_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName('folders');
  if (!sheet) {
    sheet = ss.insertSheet('folders');
    sheet.appendRow([
      'folderId',
      'path',
      'crawlStatus',
      'scannedAt',
      'owner',
      'transferStatus',
      'transferredAt',
    ]);
  }

  // まだデータがなければ、ルートフォルダをキューに積む
  if (sheet.getLastRow() === 1) {
    const rootId = getRootFolderId_();
    const root = DriveApp.getFolderById(rootId);
    sheet.appendRow([
      rootId,
      '/' + root.getName(),
      'QUEUED',
      '',
      root.getOwner().getEmail(),
      'NOT_STARTED',
      '',
    ]);
  }
}

/**
 * files シートの存在確認・初期化。
 *
 * カラム:
 * - fileId
 * - name
 * - path
 * - owner
 * - transferStatus: NOT_STARTED / DONE / SKIP_NOT_OWNER / ERROR など
 * - transferredAt: 譲渡処理を試したタイムスタンプ
 */
function initFiles_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName('files');
  if (!sheet) {
    sheet = ss.insertSheet('files');
    sheet.appendRow([
      'fileId',
      'name',
      'path',
      'owner',
      'transferStatus',
      'transferredAt',
    ]);
  }
}


/**
 * Slack にシンプルなテキスト通知を送る。
 * SLACK_WEBHOOK_URL が空の場合は何もしない。
 */
function sendSlackNotification_(text) {
  if (!SLACK_WEBHOOK_URL) {
    Logger.log('SLACK_WEBHOOK_URL が設定されていないため、Slack 通知はスキップしました。');
    return;
  }

  const payload = { text: text };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const resp = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, options);
  Logger.log('Slack response: ' + resp.getResponseCode());
}
