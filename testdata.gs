/****************************************************
 * testdata.gs  テスト用フォルダ・ファイル生成（ジョブキュー版）
 *
 * 前提：
 *  - common.gs に SCRIPT_PROP / NEXT_RUN_DELAY_MINUTES / getRootFolderId_() がある
 *  - Script Properties:
 *      ROOT_FOLDER_ID     … テストデータを作るルートフォルダ（listup/transfer と共通）
 *      CREATED_OBJECTS    … 作成済みオブジェクト数（このファイルでのみ更新）
 ****************************************************/

// 総オブジェクト数（ファイル＋サブフォルダの合計）
const TEST_TOTAL_OBJECTS = 5000;

// 1回の実行で新規作成する最大オブジェクト数
const MAX_NEW_OBJECTS_PER_RUN = 500;

// ツリー構造のパラメータ
const TEST_MAX_DEPTH = 8;             // ルートが depth=0、直下が 1
const TEST_FILES_PER_FOLDER = 20;      // 各フォルダに作るファイル数
const TEST_SUBFOLDERS_PER_FOLDER = 5; // 各フォルダに作るサブフォルダ数

// ジョブキュー管理用シート名
const TEST_QUEUE_SHEET_NAME = 'test_queue';


/****************************************************
 * Script Properties ラッパー
 ****************************************************/

/**
 * これまでに作成したオブジェクト数（files + subfolders）を取得。
 * なければ、実際のツリーから1回だけカウントして初期化する。
 *
 * Script Properties:
 *   - CREATED_OBJECTS
 */
function getCreatedObjects_() {
  const v = SCRIPT_PROP.getProperty('CREATED_OBJECTS');
  if (v) {
    return parseInt(v, 10);
  }

  // 初期化：既存ツリーを1回だけ走査して現在のオブジェクト数をカウント
  const root = getTestRootFolder_();
  const count = countExistingObjectsUnderRoot_(root);
  SCRIPT_PROP.setProperty('CREATED_OBJECTS', String(count));
  return count;
}

/**
 * 作成済みオブジェクト数を更新
 */
function setCreatedObjects_(n) {
  SCRIPT_PROP.setProperty('CREATED_OBJECTS', String(n));
}


/****************************************************
 * フォルダ取得 / カウント
 ****************************************************/

/**
 * テストデータを作るルートフォルダを取得。
 * ROOT_FOLDER_ID は common.gs の getRootFolderId_() が読む Script Property を利用。
 */
function getTestRootFolder_() {
  const rootId = getRootFolderId_(); // common.gs 側で ROOT_FOLDER_ID を読む
  try {
    return DriveApp.getFolderById(rootId);
  } catch (e) {
    throw new Error(
      'ROOT_FOLDER_ID=' + rootId + ' のフォルダが取得できませんでした。\n' +
      'ID が正しいか、権限があるかを確認してください。\n' + e
    );
  }
}

/**
 * root 配下の「ファイル + サブフォルダ」の数をざっくりカウント。
 * root 自身は含めず、「子フォルダ＋その配下全部」の合計。
 */
function countExistingObjectsUnderRoot_(root) {
  let count = 0;
  const stack = [root];

  while (stack.length > 0) {
    const folder = stack.pop();

    const files = folder.getFiles();
    while (files.hasNext()) {
      files.next();
      count++;
    }

    const subs = folder.getFolders();
    while (subs.hasNext()) {
      const sub = subs.next();
      stack.push(sub);
      count++; // サブフォルダ自体も1オブジェクトとしてカウント
    }
  }

  return count;
}


/****************************************************
 * ジョブキュー（test_queue シート）管理
 ****************************************************/

/**
 * test_queue シートを取得 or 作成。
 *
 * カラム:
 *  - folderId
 *  - depth
 *  - status: 'PENDING' | 'DONE'
 */
function getOrCreateTestQueueSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TEST_QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TEST_QUEUE_SHEET_NAME);
    sheet.appendRow(['folderId', 'depth', 'status']);
  }
  return sheet;
}

/**
 * キューの初期化。
 *  - test_queue にデータがなければ、ROOT_FOLDER_ID を depth=0, status='PENDING' で追加する。
 */
function initTestQueue_() {
  const sheet = getOrCreateTestQueueSheet_();
  if (sheet.getLastRow() === 1) {
    const root = getTestRootFolder_();
    sheet.appendRow([root.getId(), 0, 'PENDING']);
  }
}

/**
 * test_queue から PENDING の行を全部取得する。
 * @return {Array<{rowIndex:number, folderId:string, depth:number}>}
 */
function getPendingQueueEntries_() {
  const sheet = getOrCreateTestQueueSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0];
  const idxFolderId = header.indexOf('folderId');
  const idxDepth    = header.indexOf('depth');
  const idxStatus   = header.indexOf('status');

  const pending = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][idxStatus] === 'PENDING') {
      pending.push({
        rowIndex: i + 1, // 1-based
        folderId: values[i][idxFolderId],
        depth:    values[i][idxDepth],
      });
    }
  }
  return pending;
}


/****************************************************
 * 1回分のツリー作成（ジョブキュー駆動）
 ****************************************************/

/**
 * 1回の実行で、最大 MAX_NEW_OBJECTS_PER_RUN までフォルダ・ファイルを作成する。
 *
 * @return {number} この実行で新規作成したオブジェクト数
 */
function createTestTreeJobOnce_() {
  const total = TEST_TOTAL_OBJECTS;
  const alreadyCreated = getCreatedObjects_();

  let createdThisRun = 0;

  const sheet = getOrCreateTestQueueSheet_();
  const pending = getPendingQueueEntries_();

  if (pending.length === 0) {
    Logger.log('test_queue に PENDING のフォルダはありません。');
    return 0;
  }

  for (let i = 0; i < pending.length; i++) {
    if (alreadyCreated + createdThisRun >= total) break;
    if (createdThisRun >= MAX_NEW_OBJECTS_PER_RUN) break;

    const entry = pending[i];
    const folderId = entry.folderId;
    const depth = entry.depth;

    try {
      const folder = DriveApp.getFolderById(folderId);
      const result = expandOneFolder_(folder, depth, {
        total: total,
        baseCreated: alreadyCreated,
        createdThisRun: createdThisRun,
        maxNew: MAX_NEW_OBJECTS_PER_RUN
      });

      createdThisRun = result.createdThisRun;

      // このフォルダで「必要なファイル/サブフォルダを作り切った」 or
      // 深さ制限に到達している場合は DONE にする
      if (result.doneForThisFolder) {
        sheet.getRange(entry.rowIndex, 3).setValue('DONE'); // status 列
      }

      // まだ余力があるなら次の PENDING に進む
    } catch (e) {
      Logger.log('フォルダ展開中にエラーが発生しました folderId=' + folderId + ' : ' + e);
      // エラーが出た場合は、とりあえず DONE にしておく（ループで詰まらないように）
      sheet.getRange(entry.rowIndex, 3).setValue('DONE');
    }
  }

  Logger.log('createTestTreeJobOnce_: createdThisRun=' + createdThisRun);
  return createdThisRun;
}

/**
 * 1フォルダ分を展開する。
 *
 * - 既存の files / folders を見て、足りない分だけ作成
 * - 作成したサブフォルダは test_queue に PENDING で追加
 *
 * @param {Folder} folder
 * @param {number} depth
 * @param {Object} state  { total, baseCreated, createdThisRun, maxNew }
 * @return {{createdThisRun:number, doneForThisFolder:boolean}}
 */
function expandOneFolder_(folder, depth, state) {
  let createdThisRun = state.createdThisRun;

  // 終了条件
  if (state.baseCreated + createdThisRun >= state.total ||
      createdThisRun >= state.maxNew) {
    return { createdThisRun: createdThisRun, doneForThisFolder: false };
  }

  // 既存のファイル・サブフォルダを確認
  let fileCount = 0;
  const existingFileNames = new Set();
  const fileIter = folder.getFiles();
  while (fileIter.hasNext()) {
    const f = fileIter.next();
    existingFileNames.add(f.getName());
    fileCount++;
  }

  let subfolderCount = 0;
  const existingFolderNames = new Set();
  const existingSubfolders = [];
  const folderIter = folder.getFolders();
  while (folderIter.hasNext()) {
    const sub = folderIter.next();
    existingFolderNames.add(sub.getName());
    existingSubfolders.push(sub);
    subfolderCount++;
  }

  // 1. ファイルを作成（各フォルダに file1.txt 〜 fileN.txt）
  for (let i = 1; i <= TEST_FILES_PER_FOLDER; i++) {
    if (state.baseCreated + createdThisRun >= state.total) break;
    if (createdThisRun >= state.maxNew) break;

    const fileName = Utilities.formatString('file%d.txt', i);
    if (existingFileNames.has(fileName)) {
      continue;
    }

    folder.createFile(fileName, 'dummy content depth=' + depth + ', idx=' + i);
    existingFileNames.add(fileName);
    fileCount++;
    createdThisRun++;
  }

  // 2. サブフォルダを作成（d<depth+1>-<index>）
  const newSubfolders = [];
  if (depth < TEST_MAX_DEPTH - 1) { // これ以上深くしない場合は作らない
    for (let i = 1; i <= TEST_SUBFOLDERS_PER_FOLDER; i++) {
      if (state.baseCreated + createdThisRun >= state.total) break;
      if (createdThisRun >= state.maxNew) break;

      const folderName = Utilities.formatString('d%d-%d', depth + 1, i);
      if (existingFolderNames.has(folderName)) {
        continue;
      }

      const sub = folder.createFolder(folderName);
      existingFolderNames.add(folderName);
      existingSubfolders.push(sub);
      newSubfolders.push(sub);
      subfolderCount++;
      createdThisRun++;
    }
  }

  // 3. 新規サブフォルダを test_queue に PENDING で追加
  if (newSubfolders.length > 0) {
    const sheet = getOrCreateTestQueueSheet_();
    const rows = newSubfolders.map(sub => [sub.getId(), depth + 1, 'PENDING']);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  // 4. このフォルダで必要な分を作り切ったかどうか
  const needFilesDone = (fileCount >= TEST_FILES_PER_FOLDER);
  const needFoldersDone = (depth >= TEST_MAX_DEPTH - 1) || (subfolderCount >= TEST_SUBFOLDERS_PER_FOLDER);
  const doneForThisFolder = needFilesDone && needFoldersDone;

  return { createdThisRun: createdThisRun, doneForThisFolder: doneForThisFolder };
}


/****************************************************
 * トリガー制御
 ****************************************************/

/**
 * このテストデータ作成用コントローラのトリガーを全削除
 */
function cleanupCreateTestTreeTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(tr => {
    if (tr.getHandlerFunction() === 'createTestTreeController') {
      ScriptApp.deleteTrigger(tr);
    }
  });
}

/**
 * ★ テストデータ作成のエントリポイント
 *
 * - ROOT_FOLDER_ID 配下に TEST_TOTAL_OBJECTS までツリーを作る
 * - 1回の実行で MAX_NEW_OBJECTS_PER_RUN 個まで新規作成
 * - TEST_TOTAL_OBJECTS に達したらトリガーを張らずに終了
 *
 * Script Properties:
 *   - ROOT_FOLDER_ID   … common.gs 側
 *   - CREATED_OBJECTS  … ここでのみ更新
 */
function createTestTreeController() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('前回のテストデータ作成がまだ実行中のため、今回の処理はスキップします。');
    return;
  }

  try {
    initTestQueue_(); // 最初の1回だけ root のキューを積む

    const total = TEST_TOTAL_OBJECTS;
    const createdBefore = getCreatedObjects_();

    Logger.log('createTestTreeController: total=' + total + ', createdBefore=' + createdBefore);

    if (createdBefore >= total) {
      Logger.log('すでに TEST_TOTAL_OBJECTS に達しているため、新規作成は行いません。');
      cleanupCreateTestTreeTriggers_();
      return;
    }

    const createdThisRun = createTestTreeJobOnce_();
    const createdAfter = createdBefore + createdThisRun;

    setCreatedObjects_(createdAfter);
    Logger.log('今回作成: ' + createdThisRun + ', 累計: ' + createdAfter);

    cleanupCreateTestTreeTriggers_();

    if (createdAfter < total) {
      // まだ total_objects に届いていないので次回トリガーをセット
      ScriptApp.newTrigger('createTestTreeController')
        .timeBased()
        .after(NEXT_RUN_DELAY_MINUTES * 60 * 1000)
        .create();

      Logger.log(
        'total_objects に未達のため、' +
        NEXT_RUN_DELAY_MINUTES + ' 分後に次回のテストデータ作成を予約しました。'
      );
    } else {
      Logger.log('テストデータの作成が完了しました。');
    }
  } finally {
    lock.releaseLock();
  }
}
