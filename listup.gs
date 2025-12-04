/****************************************************
 * listup.gs  リストアップ処理
 ****************************************************/

/**
 * folders.crawlStatus = 'QUEUED' のフォルダ数
 */
function countQueuedFolders_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('folders');
  if (!sheet) return 0;

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return 0;

  const header = values[0];
  const idxCrawlStatus = header.indexOf('crawlStatus');

  let queued = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i][idxCrawlStatus] === 'QUEUED') {
      queued++;
    }
  }
  return queued;
}

function logQueuedFolders() {
  Logger.log('QUEUED フォルダ数: ' + countQueuedFolders_());
}


/**
 * crawlStatus = 'QUEUED' なフォルダを最大 MAX_FOLDERS_PER_RUN 件処理し、
 * - files にファイルを追加（transferStatus = 'NOT_STARTED'）
 * - folders にサブフォルダを追加（crawlStatus = 'QUEUED', transferStatus = 'NOT_STARTED'）
 * - 処理済みフォルダは crawlStatus = 'DONE', scannedAt 更新
 */
function scanFoldersJobOnce_() {
  const ss = SpreadsheetApp.getActive();
  const folderSheet = ss.getSheetByName('folders');
  const fileSheet = ss.getSheetByName('files');

  const folderValues = folderSheet.getDataRange().getValues();
  const header = folderValues[0];
  const idx = {
    folderId:       header.indexOf('folderId'),
    path:           header.indexOf('path'),
    crawlStatus:    header.indexOf('crawlStatus'),
    scannedAt:      header.indexOf('scannedAt'),
    owner:          header.indexOf('owner'),
    transferStatus: header.indexOf('transferStatus'),
    transferredAt:  header.indexOf('transferredAt'),
  };

  let processed = 0;

  for (let i = 1; i < folderValues.length; i++) {
    if (processed >= MAX_FOLDERS_PER_RUN) break;
    if (folderValues[i][idx.crawlStatus] !== 'QUEUED') continue;

    const folderId = folderValues[i][idx.folderId];
    const basePath = folderValues[i][idx.path];
    const folder = DriveApp.getFolderById(folderId);

    // 1. このフォルダ直下のファイル
    const files = folder.getFiles();
    const fileRows = [];
    while (files.hasNext()) {
      const f = files.next();
      const owner = f.getOwner().getEmail();
      fileRows.push([
        f.getId(),
        f.getName(),
        basePath,
        owner,
        'NOT_STARTED',
        '',
      ]);
    }
    if (fileRows.length > 0) {
      fileSheet
        .getRange(fileSheet.getLastRow() + 1, 1, fileRows.length, fileRows[0].length)
        .setValues(fileRows);
    }

    // 2. サブフォルダ
    const subs = folder.getFolders();
    const folderRows = [];
    while (subs.hasNext()) {
      const sub = subs.next();
      folderRows.push([
        sub.getId(),
        basePath + '/' + sub.getName(),
        'QUEUED',
        '',
        sub.getOwner().getEmail(),
        'NOT_STARTED',
        '',
      ]);
    }
    if (folderRows.length > 0) {
      folderSheet
        .getRange(folderSheet.getLastRow() + 1, 1, folderRows.length, folderRows[0].length)
        .setValues(folderRows);
    }

    // 3. このフォルダはスキャン済み
    folderSheet.getRange(i + 1, idx.crawlStatus + 1).setValue('DONE');
    folderSheet.getRange(i + 1, idx.scannedAt + 1).setValue(nowTimestamp_());

    processed++;
  }

  Logger.log('scanFoldersJobOnce_: processed folders = ' + processed);
  return processed;
}


/**
 * scanFoldersJobController 用のトリガーを全削除
 */
function cleanupScanFoldersTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(tr => {
    if (tr.getHandlerFunction() === 'scanFoldersJobController') {
      ScriptApp.deleteTrigger(tr);
    }
  });
}


/**
 * ★ listup フェーズで手動実行するエントリポイント
 *
 * Slack通知：
 *  - エラー時は今のところログのみ（必要ならここにも追ってもOK）
 *  - すべてのフォルダのリストアップ完了時に 1 回だけ通知
 */
function scanFoldersJobController() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(0);

  if (!locked) {
    Logger.log('前回のリストアップ処理がまだ実行中のため、今回の処理はスキップします。');
    return;
  }

  try {
    initFolders_();
    initFiles_();

    const queuedBefore = countQueuedFolders_();

    if (queuedBefore === 0) {
      Logger.log('crawlStatus = QUEUED のフォルダが存在しないため、リストアップ処理は完了しています。処理は行いません。');
      cleanupScanFoldersTriggers_();
      return;
    }

    const processed = scanFoldersJobOnce_();
    const queuedAfter = countQueuedFolders_();

    Logger.log(
      'scanFoldersJobController: processed=' + processed +
      ', queuedBefore=' + queuedBefore +
      ', queuedAfter=' + queuedAfter
    );

    cleanupScanFoldersTriggers_();

    if (queuedAfter > 0) {
      ScriptApp.newTrigger('scanFoldersJobController')
        .timeBased()
        .after(NEXT_RUN_DELAY_MINUTES * 60 * 1000)
        .create();

      Logger.log(
        'まだ QUEUED フォルダが ' + queuedAfter +
        ' 件残っているため、' + NEXT_RUN_DELAY_MINUTES +
        ' 分後に次回のリストアップ処理を予約しました。'
      );
    } else {
      // ★ 全部おわった時だけ Slack 通知
      Logger.log('すべてのフォルダのリストアップが完了しました。Slack に通知します。');
      sendSlackNotification_(':white_check_mark: Drive オーナー譲渡用のリストアップが完了しました。');
    }
  } finally {
    lock.releaseLock();
  }
}
