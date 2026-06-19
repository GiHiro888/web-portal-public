const test = require('node:test');
const assert = require('node:assert/strict');
const {
    autoSaveFilename,
    isAutoSaveFilename,
    selectPruneTargets,
    shouldAutoSave,
    sanitizeFolderName,
    backupTargetIsParent,
    canProceedFolderGuide
} = require('./autosave-utils.js');

test('autoSaveFilename: ゼロ埋めされた日付・時刻でファイル名を生成', () => {
    const d = new Date(2026, 5, 19, 9, 5); // 2026-06-19 09:05（月は0始まり）
    assert.equal(autoSaveFilename(d), 'expense_2026-06-19_0905.json');
});

test('isAutoSaveFilename: 正しい命名パターンのみ一致', () => {
    assert.equal(isAutoSaveFilename('expense_2026-06-19_0905.json'), true);
});

test('isAutoSaveFilename: 無関係なファイル名は一致しない', () => {
    assert.equal(isAutoSaveFilename('memo.txt'), false);
    assert.equal(isAutoSaveFilename('expense_backup_2026-06-19.json'), false);
    assert.equal(isAutoSaveFilename('expense_2026-06-19_0905.json.bak'), false);
});

test('selectPruneTargets: 上限を超えた古い世代のみ削除対象にする', () => {
    const names = [
        'expense_2026-06-17_0900.json',
        'expense_2026-06-18_0900.json',
        'expense_2026-06-19_0900.json'
    ];
    assert.deepEqual(selectPruneTargets(names, 2), ['expense_2026-06-17_0900.json']);
});

test('selectPruneTargets: 上限以下なら削除対象なし', () => {
    const names = ['expense_2026-06-19_0900.json'];
    assert.deepEqual(selectPruneTargets(names, 10), []);
});

test('selectPruneTargets: 命名パターン非一致のファイルは対象に含めない（誤削除防止）', () => {
    const names = [
        'expense_2026-06-17_0900.json',
        'expense_2026-06-18_0900.json',
        '重要な別ファイル.docx',
        'expense_backup_2026-06-19.json'
    ];
    assert.deepEqual(selectPruneTargets(names, 1), ['expense_2026-06-17_0900.json']);
});

test('shouldAutoSave: 未保存の変更がなければ保存不要', () => {
    const result = shouldAutoSave({ dirty: false, lastSaveAt: null, now: 1000, intervalMs: 500 });
    assert.equal(result, false);
});

test('shouldAutoSave: 一度も保存しておらず変更ありなら即時保存対象', () => {
    const result = shouldAutoSave({ dirty: true, lastSaveAt: null, now: 1000, intervalMs: 500 });
    assert.equal(result, true);
});

test('shouldAutoSave: 変更ありでも間隔未経過なら保存しない', () => {
    const result = shouldAutoSave({ dirty: true, lastSaveAt: 1000, now: 1300, intervalMs: 500 });
    assert.equal(result, false);
});

test('shouldAutoSave: 変更ありで間隔経過済みなら保存対象', () => {
    const result = shouldAutoSave({ dirty: true, lastSaveAt: 1000, now: 1500, intervalMs: 500 });
    assert.equal(result, true);
});

test('sanitizeFolderName: 通常の文字列はそのまま返す', () => {
    assert.equal(sanitizeFolderName('経費バックアップ', '既定名'), '経費バックアップ');
});

test('sanitizeFolderName: 空文字・空白のみは既定名にフォールバック', () => {
    assert.equal(sanitizeFolderName('', '既定名'), '既定名');
    assert.equal(sanitizeFolderName('   ', '既定名'), '既定名');
});

test('sanitizeFolderName: null/undefinedは既定名にフォールバック', () => {
    assert.equal(sanitizeFolderName(null, '既定名'), '既定名');
    assert.equal(sanitizeFolderName(undefined, '既定名'), '既定名');
});

test('sanitizeFolderName: OS禁止文字を除去する', () => {
    assert.equal(sanitizeFolderName('経費\\/:*?"<>|バックアップ', '既定名'), '経費バックアップ');
});

test('sanitizeFolderName: 前後の空白・ドットを除去する', () => {
    assert.equal(sanitizeFolderName('  経費バックアップ..  ', '既定名'), '経費バックアップ');
});

test('sanitizeFolderName: 除去後に空ならフォールバック', () => {
    assert.equal(sanitizeFolderName('***', '既定名'), '既定名');
});

test('sanitizeFolderName: 50字を超える場合は先頭50字に切り詰める', () => {
    const long = 'あ'.repeat(60);
    const result = sanitizeFolderName(long, '既定名');
    assert.equal(result.length, 50);
    assert.equal(result, 'あ'.repeat(50));
});

test('backupTargetIsParent: 親フォルダ名と一致すれば true（ネスト防止）', () => {
    assert.equal(backupTargetIsParent('経費バックアップ', '経費バックアップ'), true);
});

test('backupTargetIsParent: 親フォルダ名と不一致なら false', () => {
    assert.equal(backupTargetIsParent('Documents', '経費バックアップ'), false);
});

test('canProceedFolderGuide: 両チェックONなら true', () => {
    assert.equal(canProceedFolderGuide(true, true), true);
});

test('canProceedFolderGuide: いずれか未チェックなら false', () => {
    assert.equal(canProceedFolderGuide(false, true), false);
    assert.equal(canProceedFolderGuide(true, false), false);
    assert.equal(canProceedFolderGuide(false, false), false);
});
