/****************************************************
 * transfer.gs  オーナー譲渡処理
 ****************************************************/

/**
 * folders / files の transferStatus = 'NOT_STARTED' が残っているか
 */
function hasPendingTransfers_() {
  const ss = SpreadsheetApp.getActive();

  const folderSheet = ss.getSheetByName('folders');
  if (folderSheet) {
    const values = folderSheet.getDataRange().getValues();
    if (values.length > 1) {
      const header = values[0];
      const idxStatus = header.indexOf('transferStatus');
      for (let i = 1; i < values.length; i++) {
        if (values[i][idxStatus] === 'NOT_STARTED') {
          return true;
        }
      }
    }
  }

  const fileSheet = ss.getSheetByName('files');
  if (fileSheet) {
    const values = fileSheet.getDataRange().getValues();
    if (values.length > 1) {
      const header = values[0];
      const idxStatus = header.indexOf('transferStatus');
      for (let i = 1; i < values.length; i++) {
        if (values[i][idxStatus] === 'NOT_STARTED') {
          return true;
        }
      }
    }
  }

  return false;
}


/**
 * folders / files の transferStatus = 'NOT_STARTED' を
 * 合計 MAX_TRANSFERS_PER_RUN 件まで処理する。
 *
 * - 実行ユーザーがオーナーでなければ SKIP_NOT_OWNER
 * - setOwner 成功で DONE
 * - エラーで ERROR
 *
 * @return {{processed:number, errorCount:number}}
 */
function transferOwnershipJobOnce_() {
  const ss = SpreadsheetApp.getActive();
  const newOwner = getNewOwnerEmail_();
  const currentUser = getCurrentUserEmail_();

  let processed = 0;
  let errorCount = 0;

  /***** まず folders から *****/
  const folderSheet = ss.getSheetByName('folders');
  if (folderSheet) {
    const values = folderSheet.getDataRange().getValues();
    if (values.length > 1) {
      const header = values[0];
      const idx = {
        folderId:       header.indexOf('folderId'),
        owner:          header.indexOf('owner'),
        transferStatus: header.indexOf('transferStatus'),
        transferredAt:  header.indexOf('transferredAt'),
      };

      for (let i = 1; i < values.length && processed < MAX_TRANSFERS_PER_RUN; i++) {
        const status = values[i][idx.transferStatus];
        if (status && status !== 'NOT_STARTED') continue;

        const folderId = values[i][idx.folderId];
        let resultStatus = '';
        let ownerNow = values[i][idx.owner];

        try {
          const folder = DriveApp.getFolderById(folderId);
          ownerNow = folder.getOwner().getEmail();

          if (ownerNow !== currentUser) {
            resultStatus = 'SKIP_NOT_OWNER';
          } else {
            folder.setOwner(newOwner);
            ownerNow = newOwner;
            resultStatus = 'DONE';
          }
        } catch (e) {
          resultStatus = 'ERROR';
          errorCount++;
          Logger.log('Folder transfer error for ' + folderId + ': ' + e);
        }

        const row = i + 1;
        folderSheet.getRange(row, idx.owner + 1).setValue(ownerNow);
        folderSheet.getRange(row, idx.transferStatus + 1).setValue(resultStatus);
        folderSheet.getRange(row, idx.transferredAt + 1).setValue(nowTimestamp_());

        processed++;
      }
    }
  }

  /***** 次に files *****/
  if (processed < MAX_TRANSFERS_PER_RUN) {
    const fileSheet = ss.getSheetByName('files');
    if (fileSheet) {
      const values = fileSheet.getDataRange().getValues();
      if (values.length > 1) {
        const header = values[0];
        const idx = {
          fileId:         header.indexOf('fileId'),
          owner:          header.indexOf('owner'),
          transferStatus: header.indexOf('transferStatus'),
          transferredAt:  header.indexOf('transferredAt'),
        };

        for (let i = 1; i < values.length && processed < MAX_TRANSFERS_PER_RUN; i++) {
          const status = values[i][idx.transferStatus];
          if (status && status !== 'NOT_STARTED') continue;

          const fileId = values[i][idx.fileId];
          let resultStatus = '';
          let ownerNow = values[i][idx.owner];

          try {
            const file = DriveApp.getFileById(fileId);
            ownerNow = file.getOwner().getEmail();

            if (ownerNow !== currentUser) {
              resultStatus = 'SKIP_NOT_OWNER';
            } else {
              file.setOwner(newOwner);
              ownerNow = newOwner;
              resultStatus = 'DONE';
            }
          } catch (e) {
            resultStatus = 'ERROR';
            errorCount++;
            Logger.log('File transfer error for ' + fileId + ': ' + e);
          }

          const row = i + 1;
          fileSheet.getRange(row, idx.owner + 1).setValue(ownerNow);
          fileSheet.getRange(row, idx.transferStatus + 1).setValue(resultStatus);
          fileSheet.getRange(row, idx.transferredAt + 1).setValue(nowTimestamp_());

          processed++;
        }
      }
    }
  }

  Logger.log('transferOwnershipJobOnce_: processed=' + processed + ', errorCount=' + errorCount);
  return { processed: processed, errorCount: errorCount };
}


/**
 * transferOwnershipJobController 用トリガーを全削除
 */
function cleanupTransferTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(tr => {
    if (tr.getHandlerFunction() === 'transferOwnershipJobController') {
      ScriptApp.deleteTrigger(tr);
    }
  });
}


/**
 * ★ 譲渡フェーズで手動実行するエントリポイント
 *
 * Slack通知：
 *  - 1バッチ内で ERROR が1件以上出たら、そのたびに :warning: 通知
 *  - すべての transferStatus が NOT_STARTED 以外になったタイミングで
 *    「完了」通知（次トリガーをセットしないブランチ）
 */
function transferOwnershipJobController() {
  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(0);

  if (!locked) {
    Logger.log('前回のオーナー譲渡処理がまだ実行中のため、今回の処理はスキップします。');
    return;
  }

  try {
    // ▼ ここで folders / files シートの存在とヘッダを保証
    ensureTransferSheets_();

    if (!hasPendingTransfers_()) {
      Logger.log('transferStatus = NOT_STARTED のファイル/フォルダが存在しないため、譲渡処理は行いません。');
      cleanupTransferTriggers_();
      return;
    }

    const result = transferOwnershipJobOnce_();
    const hasPending = hasPendingTransfers_();

    Logger.log(
      'transferOwnershipJobController: processed=' + result.processed +
      ', errorCount=' + result.errorCount +
      ', hasPendingTransfers=' + hasPending
    );

    // ★ このバッチで ERROR が出たら Slack 通知
    if (result.errorCount > 0) {
      sendSlackNotification_(
        ':warning: Drive オーナー譲渡中に ' +
        result.errorCount +
        ' 件のエラーが発生しました。詳細はスプレッドシートとログを確認してください。'
      );
    }

    cleanupTransferTriggers_();

    if (hasPending) {
      // まだ NOT_STARTED が残っているので次のトリガーをセット
      ScriptApp.newTrigger('transferOwnershipJobController')
        .timeBased()
        .after(NEXT_RUN_DELAY_MINUTES * 60 * 1000)
        .create();

      Logger.log(
        'まだ transferStatus = NOT_STARTED の行が残っているため、' +
        NEXT_RUN_DELAY_MINUTES + ' 分後に次回の譲渡処理を予約しました。'
      );
    } else {
      // ★ ここが「全部のステータスが終わった時（次トリガーなし）」→ 完了通知
      Logger.log('すべてのファイル/フォルダのオーナー譲渡処理が完了しました。Slack に通知します。');
      sendSlackNotification_(':white_check_mark: Drive オーナー譲渡処理が完了しました。');
    }
  } finally {
    lock.releaseLock();
  }
}

/****************************************************
 *  folders / files シートの存在を保証するヘルパー
 ****************************************************/

/**
 * folders / files シートが存在しなければ作成し、
 * ヘッダ行だけは最低限整えておく。
 * （listup で使っている構造と合わせる）
 */
function ensureTransferSheets_() {
  const ss = SpreadsheetApp.getActive();

  ensureSheetIfNeeded_(
    ss,
    'folders',
    ['folderId', 'path', 'crawlStatus', 'scannedAt', 'owner', 'transferStatus', 'transferredAt']
  );

  ensureSheetIfNeeded_(
    ss,
    'files',
    ['fileId', 'name', 'path', 'owner', 'transferStatus', 'transferredAt']
  );
}

/**
 * 指定シートが無ければ作成し、データ行が無い場合はヘッダ行をセットする。
 *
 * @param {SpreadsheetApp.Spreadsheet} ss
 * @param {string} name シート名
 * @param {string[]} headers ヘッダ行
 */
function ensureSheetIfNeeded_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
}
