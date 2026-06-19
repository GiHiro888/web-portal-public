        // 自動保存（フォルダ世代別保存）の純粋関数群。DOM/File System Access APIに依存しないためNode単体テスト可能。
        const AUTO_SAVE_FILENAME_PATTERN = /^expense_\d{4}-\d{2}-\d{2}_\d{4}\.json$/;

        function pad2(n) {
            return String(n).padStart(2, '0');
        }

        function autoSaveFilename(date) {
            const y = date.getFullYear();
            const m = pad2(date.getMonth() + 1);
            const d = pad2(date.getDate());
            const hh = pad2(date.getHours());
            const mm = pad2(date.getMinutes());
            return `expense_${y}-${m}-${d}_${hh}${mm}.json`;
        }

        function isAutoSaveFilename(name) {
            return AUTO_SAVE_FILENAME_PATTERN.test(name);
        }

        // ファイル名（昇順=時系列順にソート可能な命名）から上限超過分（古い順）のみを削除対象として返す。
        // パターン非一致のファイルは収集対象にすら含めない（共有フォルダの誤削除防止）。
        function selectPruneTargets(names, limit) {
            const matched = names.filter(isAutoSaveFilename).sort();
            const excess = matched.length - limit;
            return excess > 0 ? matched.slice(0, excess) : [];
        }

        function shouldAutoSave({ dirty, lastSaveAt, now, intervalMs }) {
            if (!dirty) return false;
            if (lastSaveAt == null) return true;
            return (now - lastSaveAt) >= intervalMs;
        }

        const FOLDER_NAME_MAX_LENGTH = 50;
        const FOLDER_NAME_FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

        // OSのフォルダ名禁止文字・制御文字・前後の空白/ドットを除去し、上限文字数に切り詰める。
        // 除去後に空文字になった場合はfallback（既定名）を返す。
        function sanitizeFolderName(input, fallback) {
            if (input == null) return fallback;
            const stripped = String(input)
                .replace(FOLDER_NAME_FORBIDDEN_CHARS, '')
                .trim()
                .replace(/^\.+|\.+$/g, '')
                .trim();
            if (!stripped) return fallback;
            return stripped.slice(0, FOLDER_NAME_MAX_LENGTH);
        }

        // 利用者が選択した親フォルダ自体が、これから作成しようとしているバックアップフォルダ名と
        // 同名かどうかを判定する（同名ならネスト作成せず親をそのまま使う）。
        function backupTargetIsParent(parentName, targetName) {
            return parentName === targetName;
        }

        // フォルダ選択ガイドモーダルの確認チェック（専用フォルダ作成済・既存業務フォルダ非選択）が
        // 両方ONの場合のみ、フォルダ選択ダイアログへ進める。
        function canProceedFolderGuide(created, confirmed) {
            return created && confirmed;
        }

        if (typeof module !== 'undefined' && module.exports) {
            module.exports = {
                autoSaveFilename,
                isAutoSaveFilename,
                selectPruneTargets,
                shouldAutoSave,
                sanitizeFolderName,
                backupTargetIsParent,
                canProceedFolderGuide
            };
        }
