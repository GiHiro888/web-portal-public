        let db = { expenses: [], settlements: [], savedShops: [], savedKeywords: [] };
        let editingId = null; // 編集モード中の未精算明細ID（nullなら通常モード）

        const MAX_AMOUNT = 100000000; // 1億円
        const MAX_SHOP_LENGTH = 100;
        const MAX_MEMO_LENGTH = 200;
        const MAX_ITEM_LENGTH = 100;
        const MAX_ITEMS = 20;
        const MAX_SETTLEMENT_NAME_LENGTH = 30; // 精算名（ベース名）の入力上限。連番付与後は「ベース名-NNN」となる
        const PAYMENT_METHODS = ['現金', 'クレジットカード', 'PayPay', '楽天ペイ', 'd払い', 'au PAY', '交通系IC', 'その他Pay', 'オンライン決済'];
        const TAX_RATES = ['10', '8']; // 税率（%）。空文字="未分類"。税額計算は未実装（端数仕様は別途決定）
        const ID_PATTERN = /^[A-Za-z0-9_-]+$/; // 精算ID用（HTML属性へ安全に埋め込める文字のみ許可）
        const FEEDBACK_FORM_URL = 'https://forms.gle/ktzf3B3xfEjy1ToK6';
        const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/; // 日付形式（YYYY-MM-DD）
        const BACKUP_PREFIX = 'expense_db_backup_';
        const CORRUPTED_PREFIX = 'expense_db_corrupted_';
        const PINNED_PREFIX = 'expense_db_pinned_';  // 固定バックアップ（pruneOldBackupsの対象外）
        const MAX_BACKUPS = 5; // 自動バックアップの保持上限（種類ごと）
        const MAX_PINNED = 3;  // 固定バックアップの上限
        const MAX_LABEL_LENGTH = 30; // 保存ファイル名の補足ラベル上限

        // 文章中の金額表示（例：￥1,000-）。表内の金額は単位なし＋見出しに「単位：円」を記載
        function formatYen(n) {
            return '￥' + n.toLocaleString() + '-';
        }

        // 一意なID生成。crypto.randomUUIDはセキュアコンテキスト（https/file/localhost）でのみ利用可のため、
        // 非対応環境（例：plain http://）向けにフォールバックを用意（ID_PATTERN準拠）
        function generateId() {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
            return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        }

        // 税込金額から税抜・税額を逆算（端数切り捨て・参考値）。税率未分類はnull
        // 浮動小数点誤差対策：amount*100/(100+rate) で計算し、極小値を加算してから切り捨て
        function calcTax(amount, taxRate) {
            if (taxRate !== '10' && taxRate !== '8') return null;
            const ratePercent = Number(taxRate);
            const excluded = Math.floor((amount * 100 / (100 + ratePercent)) + 1e-9);
            return { excluded: excluded, tax: amount - excluded };
        }

        // 印刷帳票の並び順設定値（'date-desc' 既定）を取得
        function getPrintSortOrder() {
            return localStorage.getItem('print_sort_order') || 'date-desc';
        }

        // 印刷帳票向け比較関数。dateKey/nameKeyで対象の日付・名称プロパティ名を指定する
        // （未精算明細・精算明細＝date/shop、精算履歴＝date/name）
        function getSortComparator(dateKey, nameKey) {
            const order = getPrintSortOrder();
            return (a, b) => {
                const an = a[nameKey] || '', bn = b[nameKey] || '';
                switch (order) {
                    case 'date-asc':
                        return a[dateKey].localeCompare(b[dateKey]);
                    case 'shop-asc':
                        return an.localeCompare(bn);
                    case 'date-shop-asc':
                        return a[dateKey].localeCompare(b[dateKey]) || an.localeCompare(bn);
                    case 'date-desc':
                    default:
                        return b[dateKey].localeCompare(a[dateKey]);
                }
            };
        }

        // 税率別パートを正規化して返す。分割(taxParts)優先、なければ単一taxRateを1パートに変換、
        // 未分類は空配列（残り＝e.amount全額が未分類として扱われる）
        function getTaxParts(e) {
            if (Array.isArray(e.taxParts) && e.taxParts.length) return e.taxParts;
            if (e.taxRate === '10' || e.taxRate === '8') return [{ rate: e.taxRate, amount: e.amount }];
            return [];
        }

        // 精算書の「税率区分」列：複数税率が混在する場合は「10%/8%」のように列記、未分類は「対象外」
        function taxCategoryLabel(e) {
            const parts = getTaxParts(e);
            if (parts.length === 0) return '対象外';
            return [...new Set(parts.map(p => p.rate))].map(r => `${r}%`).join('/');
        }

        // 未精算一覧の「税率」列セル：分割時は「複数税率」として各税率の対象額・税額を列記、単一時は従来表示
        function buildTaxCell(item) {
            if (Array.isArray(item.taxParts) && item.taxParts.length > 0) {
                const lines = item.taxParts.map(p => {
                    const tax = calcTax(p.amount, p.rate);
                    return `${p.rate}%対象 ${p.amount.toLocaleString()}${tax ? `（税${tax.tax.toLocaleString()}）` : ''}`;
                });
                return `複数税率<br><span style="font-size:14px; color:#999;">${lines.join('<br>')}</span>`;
            }
            const tax = calcTax(item.amount, item.taxRate);
            return item.taxRate
                ? `${escapeHtml(item.taxRate)}%${tax ? `<br><span style="font-size:14px; color:#999;">税抜${tax.excluded.toLocaleString()} / 税${tax.tax.toLocaleString()}</span>` : ''}`
                : '';
        }

        window.onload = () => {
            document.getElementById('date').value = new Date().toISOString().split('T')[0];
            document.getElementById('print-date').value = new Date().toISOString().split('T')[0];
            setupEventListeners();
            loadFromStorage();
            render();
            renderSavedShops();
            renderSavedKeywords();
            updateShopSuggestions();

            // 印刷ヘッダ欄の初期表示（ブラウザの印刷ショートカット等、printTarget経由以外の直接印刷向けフォールバック）
            applyPrintInfo();

            initAutoSaveOnLoad();
        };

        // 常用店舗: datalist候補を更新（savedShops優先 + 過去入力）
        function updateShopSuggestions() {
            const dl = document.getElementById('shop-suggest');
            if (!dl) return;
            const saved = db.savedShops || [];
            const history = [...new Set(db.expenses.map(e => e.shop).filter(Boolean))];
            const combined = [...new Set([...saved, ...history.filter(h => !saved.includes(h))])];
            dl.innerHTML = combined.map(s => `<option value="${s.replace(/"/g, '&quot;')}"></option>`).join('');
        }

        // 常用店舗: chip 描画
        function renderSavedShops() {
            const container = document.getElementById('saved-shops-chips');
            if (!container) return;
            const saved = db.savedShops || [];
            if (saved.length === 0) { container.innerHTML = ''; return; }
            container.innerHTML = saved.map((s, i) =>
                `<span class="chip" data-shop-idx="${i}">${escHtml(s)}<span class="chip-del" data-shop-idx="${i}" title="削除">×</span></span>`
            ).join('');
        }

        // XSS対策用エスケープ（chip内テキスト等）
        function escHtml(s) {
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // 常用ワード: chip 描画（未精算・精算履歴 両方に同じ db.savedKeywords を表示）
        function renderSavedKeywords() {
            const saved = db.savedKeywords || [];
            ['unpaid-kw-chips', 'history-kw-chips'].forEach(containerId => {
                const container = document.getElementById(containerId);
                if (!container) return;
                if (saved.length === 0) { container.innerHTML = ''; return; }
                container.innerHTML = saved.map((kw, i) =>
                    `<span class="chip kw-chip" data-kw-idx="${i}" data-container="${containerId}">${escHtml(kw)}<span class="chip-del kw-chip-del" data-kw-idx="${i}" title="削除">×</span></span>`
                ).join('');
            });
        }

        // CSP対応：inline onclickを廃止し、addEventListenerで一括登録
        function setupEventListeners() {
            document.getElementById('add-entry-btn').addEventListener('click', addEntry);
            document.getElementById('settle-all-btn').addEventListener('click', () => doSettlement(false));
            document.getElementById('settle-selected-btn').addEventListener('click', () => doSettlement(true));
            document.getElementById('settle-name-toggle').addEventListener('change', (e) => {
                document.getElementById('settle-name').style.display = e.target.checked ? '' : 'none';
            });
            document.getElementById('print-date-manual').addEventListener('change', (e) => {
                document.getElementById('print-date').style.display = e.target.checked ? '' : 'none';
            });
            document.getElementById('print-empid-toggle').addEventListener('change', (e) => {
                document.getElementById('print-empid').style.display = e.target.checked ? '' : 'none';
            });
            document.getElementById('print-name-toggle').addEventListener('change', (e) => {
                document.getElementById('print-name').style.display = e.target.checked ? '' : 'none';
            });
            const sortOrderSelect = document.getElementById('print-sort-order');
            const savedSortOrder = localStorage.getItem('print_sort_order');
            if (savedSortOrder) sortOrderSelect.value = savedSortOrder;
            sortOrderSelect.addEventListener('change', (e) => {
                localStorage.setItem('print_sort_order', e.target.value);
            });
            document.getElementById('delete-selected-btn').addEventListener('click', deleteSelected);
            document.getElementById('select-all').addEventListener('click', (e) => toggleAll(e.target));

            document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
            document.getElementById('import-csv-btn').addEventListener('click', importCSV);
            document.getElementById('export-data-btn').addEventListener('click', openSaveDialog);
            document.getElementById('import-data-btn').addEventListener('click', importData);
            document.getElementById('merge-data-btn').addEventListener('click', importMergeData);
            document.getElementById('backup-manage-btn').addEventListener('click', showBackupManager);
            document.getElementById('review-files-btn').addEventListener('click', openFileReview);

            document.getElementById('autosave-setup-btn').addEventListener('click', setupAutoSaveFolder);
            document.getElementById('autosave-resume-btn').addEventListener('click', resumeAutoSave);
            document.getElementById('autosave-disable-btn').addEventListener('click', disableAutoSaveFolder);
            const intervalSelect = document.getElementById('autosave-interval-select');
            const savedInterval = localStorage.getItem(AUTOSAVE_INTERVAL_KEY);
            if (savedInterval) intervalSelect.value = savedInterval;
            intervalSelect.addEventListener('change', (e) => {
                localStorage.setItem(AUTOSAVE_INTERVAL_KEY, e.target.value);
            });
            const keepSelect = document.getElementById('autosave-keep-select');
            const savedKeep = localStorage.getItem(AUTOSAVE_KEEP_KEY);
            if (savedKeep) keepSelect.value = savedKeep;
            keepSelect.addEventListener('change', (e) => {
                localStorage.setItem(AUTOSAVE_KEEP_KEY, e.target.value);
            });
            document.getElementById('feedback-link').addEventListener('click', function (e) {
                e.preventDefault();
                openFeedbackForm();
            });
            document.getElementById('clear-all-btn').addEventListener('click', clearAll);

            // 未精算一覧・精算履歴の控え印刷ボタン
            document.querySelectorAll('.print-section-btn').forEach(btn => {
                btn.addEventListener('click', () => printTarget(btn.dataset.target));
            });

            // 未精算一覧・精算履歴のExcel出力ボタン（精算内訳モーダル内の分は動的生成のためmodal-body委譲側で処理）
            document.querySelectorAll('.excel-export-btn').forEach(btn => {
                btn.addEventListener('click', () => exportExcel(btn.dataset.kind));
            });

            // 印刷後、印刷用クラスを解除して画面表示を元に戻す
            window.addEventListener('afterprint', () => {
                document.body.classList.remove('printing', 'print-settlement', 'print-unpaid', 'print-history',
                    'print-show-approver', 'print-show-confirm', 'print-show-approve', 'print-show-accounting');
            });

            // オーバーレイ自身のクリックでのみ閉じる。modal-content内のクリックは
            // バブリングを止めず、help-close等のbody委譲リスナーへ届くようにする
            // （旧 .modal-content の stopPropagation はモーダル内のcloseクリックを遮断していた）
            document.getElementById('modal').addEventListener('click', (e) => {
                if (e.target === e.currentTarget) closeModal();
            });
            document.querySelector('.close-btn').addEventListener('click', closeModal);

            document.getElementById('cancel-edit-btn').addEventListener('click', cancelEdit);

            // 未精算明細：行は動的生成のためイベント委譲
            document.getElementById('unpaid-list').addEventListener('click', (e) => {
                if (e.target.classList.contains('row-checkbox')) {
                    updateRowStyle(e.target);
                    updateSelectionBar();
                }
                if (e.target.classList.contains('edit-btn')) startEdit(e.target.dataset.id);
            });

            // 精算履歴：精算IDリンクは動的生成のためイベント委譲
            document.getElementById('history-list').addEventListener('click', (e) => {
                const link = e.target.closest('.settle-id-link');
                if (link) showDetail(link.dataset.id);
            });

            // 精算内訳モーダル：未精算へ戻すボタン・バックアップ操作ボタンは動的生成のためイベント委譲
            document.getElementById('modal-body').addEventListener('click', (e) => {
                const revertBtn = e.target.closest('.revert-btn');
                if (revertBtn) revertToUnpaid(revertBtn.dataset.id, revertBtn.dataset.settlement);

                const restoreBtn = e.target.closest('.backup-restore-btn');
                if (restoreBtn) restoreBackup(restoreBtn.dataset.key);

                const deleteBtn = e.target.closest('.backup-delete-btn');
                if (deleteBtn) deleteBackup(deleteBtn.dataset.key);

                const pinBtn = e.target.closest('.backup-pin-btn');
                if (pinBtn) pinBackup(pinBtn.dataset.key);

                const unpinBtn = e.target.closest('.backup-unpin-btn');
                if (unpinBtn) unpinBackup(unpinBtn.dataset.key);

                // 保存ファイル確認・整理モーダル：明細・精算履歴の編集/消去、書き出し/統合読込
                const frEditBtn = e.target.closest('.fr-edit-btn');
                if (frEditBtn) frStartEdit(frEditBtn.dataset.id);

                const frEditSave = e.target.closest('.fr-edit-save');
                if (frEditSave) frSaveEdit(frEditSave.dataset.id);

                const frEditCancel = e.target.closest('.fr-edit-cancel');
                if (frEditCancel) { frEditingId = null; renderFileReview(); }

                const frDelBtn = e.target.closest('.fr-del-btn');
                if (frDelBtn) frDeleteExpense(frDelBtn.dataset.id);

                const frSettleDelBtn = e.target.closest('.fr-settle-del-btn');
                if (frSettleDelBtn) frDeleteSettlement(frSettleDelBtn.dataset.id);

                const frSettleIdLink = e.target.closest('.fr-settle-id-link');
                if (frSettleIdLink) frShowSettlementDetail(frSettleIdLink.dataset.id);

                const frBackBtn = e.target.closest('.fr-back-btn');
                if (frBackBtn) renderFileReview();

                const frExportBtn = e.target.closest('.fr-export-btn');
                if (frExportBtn) frExportConsolidated();

                const frMergeBtn = e.target.closest('.fr-merge-btn');
                if (frMergeBtn) frMergeIntoCurrent();

                // 精算内訳モーダル：印刷/PDF保存ボタン
                const printSettlementBtn = e.target.closest('.print-settlement-btn');
                if (printSettlementBtn) {
                    printTarget('settlement', {
                        showApprover: document.getElementById('print-show-approver').checked,
                        showConfirm: document.getElementById('print-show-confirm').checked,
                        showApprove: document.getElementById('print-show-approve').checked,
                        showAccounting: document.getElementById('print-show-accounting').checked
                    });
                }

                // 精算内訳モーダル：Excel出力ボタン
                const excelSettlementBtn = e.target.closest('.excel-export-btn[data-kind="settlement"]');
                if (excelSettlementBtn) {
                    exportExcel('settlement', excelSettlementBtn.dataset.settlementId);
                }

                // データ保存（バックアップ）ダイアログ：「この名前で保存」ボタン
                const saveExecBtn = e.target.closest('.save-exec-btn');
                if (saveExecBtn) {
                    const label = sanitizeLabel(document.getElementById('save-label-input').value);
                    localStorage.setItem('save_label', label);
                    exportData(label);
                    closeModal();
                    returnFocus();
                }
            });

            // 孤児明細：未精算に戻す・削除ボタンは動的生成のためイベント委譲
            document.getElementById('orphan-list').addEventListener('click', (e) => {
                const revertBtn = e.target.closest('.orphan-revert-btn');
                if (revertBtn) revertOrphanToUnpaid(revertBtn.dataset.id);

                const deleteBtn = e.target.closest('.orphan-delete-btn');
                if (deleteBtn) deleteOrphan(deleteBtn.dataset.id);
            });

            // 金額入力欄：入力中も3桁カンマ区切りで表示
            document.getElementById('amount').addEventListener('input', (e) => {
                formatAmountInput(e.target);
            });

            // 税率分割入力：チェックで分割パネルを開閉し、金額欄/税率欄を切り替え
            document.getElementById('split-toggle').addEventListener('change', (e) => {
                setSplitMode(e.target.checked);
            });

            // 税率分割入力：各欄の入力中も3桁カンマ区切りで表示し、金額欄へ自動合計を反映
            ['split-10', 'split-8', 'split-none'].forEach(id => {
                document.getElementById(id).addEventListener('input', (e) => {
                    formatAmountInput(e.target);
                    updateSplitTotal();
                });
            });

            // 必須項目チェック：入力・選択し直したフィールドのエラー表示をその場でクリア
            ['date', 'shop', 'payment', 'amount', 'invoice'].forEach(id => {
                const el = document.getElementById(id);
                const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
                el.addEventListener(evt, () => {
                    el.classList.remove('input-error');
                    document.getElementById(`err-${id}`).textContent = '';
                });
            });
            ['split-10', 'split-8', 'split-none'].forEach(id => {
                document.getElementById(id).addEventListener('input', () => {
                    document.getElementById('amount').classList.remove('input-error');
                    document.getElementById('err-amount').textContent = '';
                });
            });

            // ?アイコンの説明ポップアップ：close クリックで閉じる
            document.body.addEventListener('click', (e) => {
                if (e.target.classList.contains('help-close')) {
                    e.target.closest('details.help-details').removeAttribute('open');
                }
            });

            // ?アイコンの説明ポップアップ：開閉に応じて位置決め／非表示を切替。
            // .help-content は既定で visibility:hidden。開いた時に positionHelpPopup() が
            // 位置を確定してから visible にするため、中央(top:50%)での一瞬の表示（揺れ）が起きない。
            document.addEventListener('toggle', (e) => {
                const details = e.target;
                if (!(details.matches && details.matches('details.help-details'))) return;
                if (details.open) {
                    positionHelpPopup(details);
                } else {
                    const content = details.querySelector('.help-content');
                    if (content) content.style.visibility = 'hidden';
                }
            }, true);

            // 絞り込みバー：リアルタイムフィルタ
            ['unpaid-filter-kw', 'unpaid-filter-from', 'unpaid-filter-to',
             'history-filter-kw', 'history-filter-from', 'history-filter-to'
            ].forEach(id => {
                document.getElementById(id).addEventListener('input', render);
            });
            document.getElementById('unpaid-filter-clear').addEventListener('click', () => {
                ['unpaid-filter-kw', 'unpaid-filter-from', 'unpaid-filter-to'].forEach(id => {
                    document.getElementById(id).value = '';
                });
                render();
            });
            document.getElementById('history-filter-clear').addEventListener('click', () => {
                ['history-filter-kw', 'history-filter-from', 'history-filter-to'].forEach(id => {
                    document.getElementById(id).value = '';
                });
                render();
            });

            // 常用店舗登録ボタン
            document.getElementById('save-shop-btn').addEventListener('click', () => {
                const val = document.getElementById('shop').value.trim().slice(0, 100);
                if (!val) { alert('利用先を入力してから「★ 常用登録」してください。'); return; }
                if (!db.savedShops) db.savedShops = [];
                if (db.savedShops.includes(val)) { alert('すでに常用店舗に登録されています。'); return; }
                db.savedShops.push(val);
                saveToStorage();
                renderSavedShops();
                updateShopSuggestions();
            });

            // 常用店舗 chip クリック（入力適用）と × クリック（削除）：delegated
            document.getElementById('saved-shops-chips').addEventListener('click', e => {
                const del = e.target.closest('.chip-del');
                if (del) {
                    const idx = parseInt(del.dataset.shopIdx, 10);
                    if (!isNaN(idx)) {
                        db.savedShops.splice(idx, 1);
                        saveToStorage();
                        renderSavedShops();
                        updateShopSuggestions();
                    }
                    return;
                }
                const chip = e.target.closest('.chip');
                if (chip) {
                    document.getElementById('shop').value = chip.dataset.shopIdx !== undefined
                        ? (db.savedShops[parseInt(chip.dataset.shopIdx, 10)] || '') : '';
                }
            });

            // 常用ワード登録ボタン（未精算・履歴で同一の db.savedKeywords を共有）
            document.querySelectorAll('.btn-save-kw').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetId = btn.dataset.target;
                    const val = (document.getElementById(targetId).value || '').trim().slice(0, 50);
                    if (!val) { alert('キーワードを入力してから「★ 登録」してください。'); return; }
                    if (!db.savedKeywords) db.savedKeywords = [];
                    if (db.savedKeywords.includes(val)) { alert('すでに常用ワードに登録されています。'); return; }
                    db.savedKeywords.push(val);
                    saveToStorage();
                    renderSavedKeywords();
                });
            });

            // 常用ワード chip クリック（検索適用）と × 削除：delegated
            ['unpaid-kw-chips', 'history-kw-chips'].forEach(containerId => {
                document.getElementById(containerId).addEventListener('click', e => {
                    const del = e.target.closest('.kw-chip-del');
                    if (del) {
                        const idx = parseInt(del.dataset.kwIdx, 10);
                        if (!isNaN(idx)) {
                            db.savedKeywords.splice(idx, 1);
                            saveToStorage();
                            renderSavedKeywords();
                        }
                        return;
                    }
                    const chip = e.target.closest('.kw-chip');
                    if (chip) {
                        const kw = db.savedKeywords[parseInt(chip.dataset.kwIdx, 10)] || '';
                        // どちらのカードのchipでも、両方のフィルタ入力欄に適用してrender
                        const targetInput = containerId === 'unpaid-kw-chips' ? 'unpaid-filter-kw' : 'history-filter-kw';
                        document.getElementById(targetInput).value = kw;
                        render();
                    }
                });
            });
        }

        // ?アイコンの説明ポップアップの位置調整：横は画面中央寄せ、縦はアイコン付近（画面外に出ないよう調整）
        function positionHelpPopup(details) {
            const content = details.querySelector('.help-content');
            if (!content) return;
            const margin = 12;
            const rect = details.getBoundingClientRect();
            const ch = content.offsetHeight;
            let top = rect.top + rect.height / 2;
            top = Math.max(margin + ch / 2, Math.min(top, window.innerHeight - margin - ch / 2));
            content.style.top = `${top}px`;
            content.style.left = '50%';
            content.style.transform = 'translate(-50%, -50%)';
            content.style.visibility = 'visible';
        }

        // 金額入力欄の表示を「1,000」形式に整形（カーソル位置も維持）
        function formatAmountInput(el) {
            const cursorFromEnd = el.value.length - el.selectionStart;
            const digits = el.value.replace(/[^\d]/g, '');
            el.value = digits ? Number(digits).toLocaleString('en-US') : '';
            const pos = Math.max(0, el.value.length - cursorFromEnd);
            el.setSelectionRange(pos, pos);
        }

        // 税率分割欄の値（カンマ除去・数値化、空欄/不正値は0）を取得
        function splitFieldValue(id) {
            const digits = document.getElementById(id).value.replace(/[^\d]/g, '');
            return digits ? Number(digits) : 0;
        }

        // 税率分割欄3つの合計を金額欄へ反映し、合計表示を更新
        function updateSplitTotal() {
            const total = splitFieldValue('split-10') + splitFieldValue('split-8') + splitFieldValue('split-none');
            document.getElementById('amount').value = total ? total.toLocaleString('en-US') : '';
            document.getElementById('split-total').textContent = formatYen(total);
        }

        // 税率分割入力モードの切替：分割パネルの表示と金額欄/税率欄の有効・無効を切替
        function setSplitMode(enabled) {
            document.getElementById('split-toggle').checked = enabled;
            document.getElementById('split-toggle-bar').classList.toggle('active', enabled);
            document.getElementById('split-toggle-state').textContent = enabled ? 'ON' : 'OFF';
            document.getElementById('split-panel').style.display = enabled ? 'flex' : 'none';
            document.getElementById('amount').disabled = enabled;
            document.getElementById('tax-rate').disabled = enabled;
            if (enabled) {
                document.getElementById('tax-rate').value = '';
                updateSplitTotal();
            } else {
                document.getElementById('split-10').value = '';
                document.getElementById('split-8').value = '';
                document.getElementById('split-none').value = '';
                document.getElementById('split-total').textContent = formatYen(0);
            }
        }

        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // インボイス登録番号：先頭のT（全角・半角／大小）と前後の空白を除去
        function sanitizeInvoice(str) {
            return String(str || '').trim().replace(/^[TtＴｔ]/, '').trim();
        }

        // 登録時の必須項目チェック：日付／利用先／支払方法／金額／インボイス登録番号（任意・形式のみ）
        // 不備があれば該当欄を赤枠＋赤字で指摘し、登録を保留する（true=不備なし）
        function validateForm() {
            const fieldIds = ['date', 'shop', 'payment', 'amount', 'invoice'];
            fieldIds.forEach(id => {
                document.getElementById(id).classList.remove('input-error');
                document.getElementById(`err-${id}`).textContent = '';
            });

            let firstInvalid = null;
            const setError = (id, message) => {
                const el = document.getElementById(id);
                el.classList.add('input-error');
                document.getElementById(`err-${id}`).textContent = message;
                if (!firstInvalid) firstInvalid = el;
            };

            const date = document.getElementById('date').value;
            if (!date) {
                setError('date', '日付を入力してください');
            } else if (!DATE_PATTERN.test(date)) {
                setError('date', '日付の形式が正しくありません');
            }

            if (!document.getElementById('shop').value.trim()) {
                setError('shop', '利用先を入力してください');
            }

            if (!document.getElementById('payment').value) {
                setError('payment', '支払方法を選択してください');
            }

            const splitMode = document.getElementById('split-toggle').checked;
            if (splitMode) {
                const total = splitFieldValue('split-10') + splitFieldValue('split-8') + splitFieldValue('split-none');
                if (total <= 0) {
                    setError('amount', '税率分割欄（10%・8%・非課税のいずれか）に金額を入力してください');
                }
            } else {
                const amountStr = document.getElementById('amount').value.replace(/,/g, '');
                const amount = Number(amountStr);
                if (amountStr === "" || !Number.isInteger(amount) || amount <= 0) {
                    setError('amount', '金額を入力してください');
                }
            }

            const invoice = sanitizeInvoice(document.getElementById('invoice').value);
            if (invoice !== '' && /^[0-9]+$/.test(invoice) && invoice.length !== 13) {
                setError('invoice', 'インボイス登録番号は数字13桁（先頭のTは除く）で入力してください');
            }

            if (firstInvalid) {
                firstInvalid.focus();
                return false;
            }
            return true;
        }

        // 日付を「YYYY年M月D日」形式（日本の商習慣で一般的な書式）に変換
        function formatDateJP(dateStr) {
            const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr || '');
            if (!m) return escapeHtml(dateStr || '');
            return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
        }

        // 印刷用情報（社員ID・氏名・申請日/作成日）を全帳票のヘッダ欄へ反映する。
        // 値はDOM入力欄のみで保持し、db・localStorageには保存しない（情報漏洩防止）。
        function applyPrintInfo() {
            const empidOn = document.getElementById('print-empid-toggle').checked;
            const nameOn = document.getElementById('print-name-toggle').checked;
            const empid = empidOn ? document.getElementById('print-empid').value.trim() : '';
            const name = nameOn ? document.getElementById('print-name').value.trim() : '';
            const manual = document.getElementById('print-date-manual').checked;
            const manualDate = document.getElementById('print-date').value;
            const dateStr = (manual && manualDate) ? manualDate : new Date().toISOString().split('T')[0];

            document.querySelectorAll('.print-field-empid').forEach(el => el.style.display = empidOn ? '' : 'none');
            document.querySelectorAll('.print-field-name').forEach(el => el.style.display = nameOn ? '' : 'none');
            setPrintField('.print-empid-val', empid);
            setPrintField('.print-name-val', name);
            const dateJP = formatDateJP(dateStr);
            document.querySelectorAll('.print-doc-date').forEach(el => el.textContent = dateJP);
        }

        // 印刷ヘッダの値スパンへ値を設定。空欄時は手書き用の下線ブランクにする
        function setPrintField(selector, value) {
            document.querySelectorAll(selector).forEach(el => {
                if (value) {
                    el.textContent = value;
                    el.classList.remove('print-blank');
                } else {
                    el.textContent = '';
                    el.classList.add('print-blank');
                }
            });
        }

        // 経費1件分の構造検証
        function isValidExpense(e) {
            if (!e || typeof e !== 'object') return false;
            if (typeof e.id !== 'string' && typeof e.id !== 'number') return false;
            if (typeof e.date !== 'string' || !DATE_PATTERN.test(e.date)) return false;
            if (typeof e.shop !== 'string' || e.shop.length > MAX_SHOP_LENGTH) return false;
            if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) return false;
            if (e.status !== '未' && e.status !== '済') return false;
            if (e.settlement_id !== undefined && e.settlement_id !== null) {
                if (typeof e.settlement_id !== 'string' || !ID_PATTERN.test(e.settlement_id)) return false;
            }
            if (e.memo !== undefined) {
                if (typeof e.memo !== 'string' || e.memo.length > MAX_MEMO_LENGTH) return false;
            }
            if (e.payment !== undefined) {
                if (typeof e.payment !== 'string' || (e.payment !== '' && !PAYMENT_METHODS.includes(e.payment))) return false;
            }
            if (e.taxRate !== undefined) {
                if (typeof e.taxRate !== 'string' || (e.taxRate !== '' && !TAX_RATES.includes(e.taxRate))) return false;
            }
            if (e.invoice !== undefined) {
                if (typeof e.invoice !== 'string' || e.invoice.length > 20) return false;
            }
            if (e.items !== undefined) {
                if (!Array.isArray(e.items) || e.items.length > MAX_ITEMS) return false;
                if (!e.items.every(it => typeof it === 'string' && it.length > 0 && it.length <= MAX_ITEM_LENGTH)) return false;
            }
            if (e.taxParts !== undefined) {
                if (!Array.isArray(e.taxParts) || e.taxParts.length === 0 || e.taxParts.length > 2) return false;
                let partsSum = 0;
                const seenRates = new Set();
                for (const p of e.taxParts) {
                    if (!p || typeof p !== 'object') return false;
                    if (p.rate !== '10' && p.rate !== '8') return false;
                    if (seenRates.has(p.rate)) return false;
                    seenRates.add(p.rate);
                    if (typeof p.amount !== 'number' || !Number.isInteger(p.amount) || p.amount <= 0) return false;
                    partsSum += p.amount;
                }
                if (partsSum > e.amount) return false;
            }
            return true;
        }

        // 精算1件分の構造検証
        function isValidSettlement(s) {
            if (!s || typeof s !== 'object') return false;
            if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return false;
            if (typeof s.date !== 'string' || !DATE_PATTERN.test(s.date)) return false;
            if (typeof s.total !== 'number' || !Number.isFinite(s.total)) return false;
            if (s.name !== undefined) {
                if (typeof s.name !== 'string' || s.name.length > MAX_SETTLEMENT_NAME_LENGTH + 4) return false;
            }
            return true;
        }

        // DB全体の構造検証（読込・インポート共通）
        function isValidDb(obj) {
            if (!obj || typeof obj !== 'object') return false;
            if (!Array.isArray(obj.expenses) || !Array.isArray(obj.settlements)) return false;
            return obj.expenses.every(isValidExpense) && obj.settlements.every(isValidSettlement);
        }

        // JSONバックアップ統合：baseに対しincomingを追加（重複IDはスキップ、idはString比較）
        // 呼び出し前にincomingはisValidDbで検証済みであること
        function mergeDb(base, incoming) {
            const existingExpenseIds = new Set(base.expenses.map(e => String(e.id)));
            const existingSettlementIds = new Set(base.settlements.map(s => String(s.id)));

            const addedExpenses = [];
            const skippedExpenseIds = [];
            incoming.expenses.forEach(e => {
                if (existingExpenseIds.has(String(e.id))) {
                    skippedExpenseIds.push(String(e.id));
                } else {
                    addedExpenses.push(e);
                    existingExpenseIds.add(String(e.id));
                }
            });

            const addedSettlements = [];
            const skippedSettlementIds = [];
            incoming.settlements.forEach(s => {
                if (existingSettlementIds.has(String(s.id))) {
                    skippedSettlementIds.push(String(s.id));
                } else {
                    addedSettlements.push(s);
                    existingSettlementIds.add(String(s.id));
                }
            });

            const merged = {
                expenses: [...base.expenses, ...addedExpenses],
                settlements: [...base.settlements, ...addedSettlements],
                savedShops: [...new Set([...(base.savedShops || []), ...(incoming.savedShops || [])])],
                savedKeywords: [...new Set([...(base.savedKeywords || []), ...(incoming.savedKeywords || [])])]
            };

            // 精算済だが対応する精算履歴がない明細（孤児参照）を検出
            const allSettlementIds = new Set(merged.settlements.map(s => String(s.id)));
            const orphanExpenseIds = merged.expenses
                .filter(e => e.settlement_id !== undefined && e.settlement_id !== null && !allSettlementIds.has(String(e.settlement_id)))
                .map(e => String(e.id));

            return {
                merged,
                addedExpenseCount: addedExpenses.length,
                skippedExpenseIds,
                addedSettlementCount: addedSettlements.length,
                skippedSettlementIds,
                orphanExpenseIds
            };
        }

        function loadFromStorage() {
            const data = localStorage.getItem('expense_db');
            if (!data) return;
            try {
                const parsed = JSON.parse(data);
                if (!isValidDb(parsed)) throw new Error('invalid schema');
                db = parsed;
            } catch (e) {
                const backupKey = `${CORRUPTED_PREFIX}${Date.now()}`;
                try {
                    localStorage.setItem(backupKey, data);
                    pruneOldBackups(CORRUPTED_PREFIX);
                } catch (_) { /* 退避も失敗した場合は諦める */ }
                alert(`保存データの読み込みに失敗したため、初期状態で開始します。\n破損していたデータは "${backupKey}" として保存されています（「自動保存管理」から確認できます）。`);
                db = { expenses: [], settlements: [] };
            }
        }

        function saveToStorage() {
            try {
                localStorage.setItem('expense_db', JSON.stringify(db));
                markAutoSaveDirty();
            } catch (e) {
                alert("データの保存に失敗しました（ブラウザのストレージ容量不足の可能性があります）。\n「データ保存（バックアップ）」での出力を推奨します。");
            }
        }

        // 自動バックアップの保持上限を超えた古いものを削除（種類ごとにタイムスタンプ昇順で先頭から削除）
        function pruneOldBackups(prefix) {
            const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix)).sort();
            while (keys.length > MAX_BACKUPS) {
                localStorage.removeItem(keys.shift());
            }
        }

        // 現在のdbを自動バックアップとして保存（保持上限を超えた古いものは自動削除）
        function createBackup() {
            const key = `${BACKUP_PREFIX}${Date.now()}`;
            try {
                localStorage.setItem(key, JSON.stringify(db));
                pruneOldBackups(BACKUP_PREFIX);
            } catch (_) { /* 退避失敗時も処理は継続 */ }
            return key;
        }

        // ===== 自動保存（フォルダへの定期保存） =====
        // 「自動」の意味：初回フォルダ選択後はそのアクセス（タブを開いている間）は無通知で保存を続ける、という意味。
        // ブラウザのFile System Access APIの仕様上、アクセスごとに1回のユーザー操作による許可が必須のため、
        // 「いかなる操作もなしに常時バックグラウンド保存」は技術的に不可能（次回アクセス時は再度「保存を再開」操作が必要）。
        const AUTOSAVE_ENABLED_KEY = 'autosave_enabled';
        const AUTOSAVE_INTERVAL_KEY = 'autosave_interval_ms';
        const AUTOSAVE_KEEP_KEY = 'autosave_keep_count';
        const AUTOSAVE_LAST_SAVED_KEY = 'autosave_last_saved_at';
        const AUTOSAVE_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
        const AUTOSAVE_DEFAULT_KEEP_COUNT = 10;
        const AUTOSAVE_POLL_MS = 30 * 1000; // dirty状態を確認する内部ポーリング間隔（実際の保存判定はintervalMs基準）
        // ※保存先フォルダ案内モーダル（#autosave-folder-guide）の推奨フォルダ名と一致させる
        const AUTOSAVE_DEFAULT_FOLDER_NAME = '経費管理_保存用';
        const AUTOSAVE_PARENT_NAME_KEY = 'autosave_parent_name';

        let autoSaveDirHandle = null;
        let autoSaveDirty = false;
        let autoSaveLastSavedAt = (() => {
            const v = Number(localStorage.getItem(AUTOSAVE_LAST_SAVED_KEY));
            return Number.isFinite(v) && v > 0 ? v : null;
        })();
        let autoSaveTimerId = null;
        let autoSaveSaving = false; // 多重書込防止

        function autoSaveSupported() {
            return typeof window.showDirectoryPicker === 'function';
        }

        function autoSaveEnabled() {
            return localStorage.getItem(AUTOSAVE_ENABLED_KEY) === '1';
        }

        function autoSaveIntervalMs() {
            const v = Number(localStorage.getItem(AUTOSAVE_INTERVAL_KEY));
            return Number.isFinite(v) && v > 0 ? v : AUTOSAVE_DEFAULT_INTERVAL_MS;
        }

        function autoSaveKeepCount() {
            const v = Number(localStorage.getItem(AUTOSAVE_KEEP_KEY));
            return Number.isFinite(v) && v > 0 ? v : AUTOSAVE_DEFAULT_KEEP_COUNT;
        }

        // FileSystemDirectoryHandleは構造化複製可能のため、IndexedDBへそのまま保存できる
        function idbOpenAutosave() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open('expense-autosave', 1);
                req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        async function idbSetDirHandle(handle) {
            const idb = await idbOpenAutosave();
            await new Promise((resolve, reject) => {
                const tx = idb.transaction('handles', 'readwrite');
                tx.objectStore('handles').put(handle, 'dirHandle');
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            idb.close();
        }

        async function idbGetDirHandle() {
            const idb = await idbOpenAutosave();
            const handle = await new Promise((resolve, reject) => {
                const tx = idb.transaction('handles', 'readonly');
                const req = tx.objectStore('handles').get('dirHandle');
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
            idb.close();
            return handle;
        }

        async function idbClearDirHandle() {
            const idb = await idbOpenAutosave();
            await new Promise((resolve, reject) => {
                const tx = idb.transaction('handles', 'readwrite');
                tx.objectStore('handles').delete('dirHandle');
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            idb.close();
        }

        // データ変更を「フォルダへ未保存」として記録。localStorageへの保存自体はsaveToStorage()が都度行う
        function markAutoSaveDirty() {
            autoSaveDirty = true;
        }

        function updateAutoSaveStatus() {
            const bar = document.getElementById('autosave-status-bar');
            const text = document.getElementById('autosave-status-text');
            const setupBtn = document.getElementById('autosave-setup-btn');
            const resumeBtn = document.getElementById('autosave-resume-btn');
            const disableBtn = document.getElementById('autosave-disable-btn');
            const settingsDetails = document.getElementById('autosave-settings-details');
            if (!bar) return;

            bar.classList.remove('is-active', 'is-attention', 'is-error');

            if (!autoSaveSupported()) {
                text.textContent = 'フォルダへの自動保存：このブラウザでは未対応です（Chrome・Edge等のブラウザでご利用いただけます）';
                setupBtn.style.display = 'none';
                resumeBtn.style.display = 'none';
                disableBtn.style.display = 'none';
                settingsDetails.style.display = 'none';
                return;
            }

            if (!autoSaveEnabled()) {
                text.textContent = 'フォルダへの自動保存：未設定（ブラウザ内保存のみ）';
                setupBtn.style.display = '';
                resumeBtn.style.display = 'none';
                disableBtn.style.display = 'none';
                settingsDetails.style.display = 'none';
                return;
            }

            settingsDetails.style.display = '';
            disableBtn.style.display = '';
            setupBtn.style.display = 'none';

            if (autoSaveDirHandle) {
                bar.classList.add('is-active');
                const lastStr = autoSaveLastSavedAt ? new Date(autoSaveLastSavedAt).toLocaleString('ja-JP') : '未保存';
                const parentName = localStorage.getItem(AUTOSAVE_PARENT_NAME_KEY);
                const location = parentName ? `「${parentName}」内「${autoSaveDirHandle.name}」` : `「${autoSaveDirHandle.name}」`;
                text.textContent = `フォルダへの自動保存：有効（保存先 ${location}／最終保存 ${lastStr}）`;
                resumeBtn.style.display = 'none';
            } else {
                bar.classList.add('is-attention');
                text.textContent = 'フォルダへの自動保存：このアクセスではまだ許可されていません';
                resumeBtn.style.display = '';
            }
        }

        function startAutoSaveTimer() {
            if (autoSaveTimerId) clearInterval(autoSaveTimerId);
            autoSaveTimerId = setInterval(() => {
                if (shouldAutoSave({ dirty: autoSaveDirty, lastSaveAt: autoSaveLastSavedAt, now: Date.now(), intervalMs: autoSaveIntervalMs() })) {
                    performAutoSave();
                }
            }, AUTOSAVE_POLL_MS);
        }

        function stopAutoSaveTimer() {
            if (autoSaveTimerId) {
                clearInterval(autoSaveTimerId);
                autoSaveTimerId = null;
            }
        }

        async function performAutoSave() {
            if (!autoSaveDirHandle || autoSaveSaving) return;
            autoSaveSaving = true;
            try {
                const fileHandle = await autoSaveDirHandle.getFileHandle(autoSaveFilename(new Date()), { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(JSON.stringify(db));
                await writable.close();
                autoSaveDirty = false;
                autoSaveLastSavedAt = Date.now();
                localStorage.setItem(AUTOSAVE_LAST_SAVED_KEY, String(autoSaveLastSavedAt));
                await pruneAutoSaveFolder();
            } catch (e) {
                const bar = document.getElementById('autosave-status-bar');
                const text = document.getElementById('autosave-status-text');
                if (bar && text) {
                    bar.classList.remove('is-active', 'is-attention');
                    bar.classList.add('is-error');
                    text.textContent = `フォルダへの自動保存：保存に失敗しました（${e.name === 'NotAllowedError' ? '権限が取り消されました。再度「保存を再開」を行ってください' : 'エラーが発生しました'}）`;
                }
                if (e.name === 'NotAllowedError') {
                    autoSaveDirHandle = null;
                    stopAutoSaveTimer();
                }
            } finally {
                autoSaveSaving = false;
                updateAutoSaveStatus();
            }
        }

        // 保持上限を超えた古い世代ファイルのみ削除。命名パターン非一致のファイル（共有フォルダの他ファイル等）には一切触れない
        async function pruneAutoSaveFolder() {
            if (!autoSaveDirHandle) return;
            const names = [];
            for await (const entry of autoSaveDirHandle.values()) {
                if (entry.kind === 'file') names.push(entry.name);
            }
            const targets = selectPruneTargets(names, autoSaveKeepCount());
            for (const name of targets) {
                try { await autoSaveDirHandle.removeEntry(name); } catch (_) { /* 個別の削除失敗は無視し継続 */ }
            }
        }

        // 保存先フォルダ案内（ブロッキング型）：両チェックON＋「フォルダ選択へ進む」クリックでのみ true を返す。
        // キャンセル・外側クリック・ESCでは閉じない（外側クリック/ESC用のリスナー自体を設けていない）。
        function showFolderGuideModal() {
            return new Promise((resolve) => {
                const overlay = document.getElementById('autosave-folder-guide');
                const checkCreated = document.getElementById('autosave-guide-check-created');
                const checkConfirmed = document.getElementById('autosave-guide-check-confirmed');
                const cancelBtn = document.getElementById('autosave-guide-cancel-btn');
                const proceedBtn = document.getElementById('autosave-guide-proceed-btn');

                checkCreated.checked = false;
                checkConfirmed.checked = false;
                proceedBtn.disabled = true;

                function updateProceedState() {
                    proceedBtn.disabled = !canProceedFolderGuide(checkCreated.checked, checkConfirmed.checked);
                }
                function cleanup() {
                    checkCreated.removeEventListener('change', updateProceedState);
                    checkConfirmed.removeEventListener('change', updateProceedState);
                    cancelBtn.removeEventListener('click', onCancel);
                    proceedBtn.removeEventListener('click', onProceed);
                    overlay.style.display = 'none';
                }
                function onCancel() { cleanup(); resolve(false); }
                function onProceed() { cleanup(); resolve(true); }

                checkCreated.addEventListener('change', updateProceedState);
                checkConfirmed.addEventListener('change', updateProceedState);
                cancelBtn.addEventListener('click', onCancel);
                proceedBtn.addEventListener('click', onProceed);

                overlay.style.display = 'flex';
            });
        }

        // 「フォルダへの自動保存を設定」：保存先フォルダ案内モーダルでの確認を経た上で、
        // ユーザー操作（クリック）を起点に親フォルダを選び、専用サブフォルダを自動作成する
        async function setupAutoSaveFolder() {
            if (!autoSaveSupported()) return;
            const proceed = await showFolderGuideModal();
            if (!proceed) { returnFocus(); return; }
            try {
                const parent = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents', id: 'expense-backup' });
                const folderName = AUTOSAVE_DEFAULT_FOLDER_NAME;

                const handle = backupTargetIsParent(parent.name, folderName)
                    ? parent
                    : await parent.getDirectoryHandle(folderName, { create: true });

                autoSaveDirHandle = handle;
                await idbSetDirHandle(handle);
                localStorage.setItem(AUTOSAVE_ENABLED_KEY, '1');
                localStorage.setItem(AUTOSAVE_PARENT_NAME_KEY, parent.name);
                autoSaveDirty = true; // 設定直後に初回保存を行う
                startAutoSaveTimer();
                updateAutoSaveStatus();
                await performAutoSave();
                alert(`「${parent.name}」内に「${handle.name}」を用意しました。エクスプローラーで「${parent.name}」を開くと確認できます。`);
            } catch (e) {
                if (e.name !== 'AbortError') {
                    alert('フォルダの選択に失敗しました。もう一度お試しください。');
                }
                returnFocus();
            }
        }

        // 「保存を再開（許可）」：再アクセス時、保存済みのフォルダハンドルへの書込許可をユーザー操作で再取得
        async function resumeAutoSave() {
            try {
                const handle = await idbGetDirHandle();
                if (!handle) { updateAutoSaveStatus(); return; }
                const permission = await handle.requestPermission({ mode: 'readwrite' });
                if (permission === 'granted') {
                    autoSaveDirHandle = handle;
                    startAutoSaveTimer();
                } else {
                    alert('フォルダへの書込許可が得られませんでした。');
                }
            } catch (e) {
                alert('保存の再開に失敗しました。');
            } finally {
                updateAutoSaveStatus();
                returnFocus();
            }
        }

        function disableAutoSaveFolder() {
            if (!confirm('フォルダへの自動保存を解除します。これまで保存されたファイル自体は削除されません。よろしいですか？')) {
                returnFocus();
                return;
            }
            localStorage.removeItem(AUTOSAVE_ENABLED_KEY);
            localStorage.removeItem(AUTOSAVE_LAST_SAVED_KEY);
            localStorage.removeItem(AUTOSAVE_PARENT_NAME_KEY);
            autoSaveDirHandle = null;
            autoSaveDirty = false;
            autoSaveLastSavedAt = null;
            stopAutoSaveTimer();
            idbClearDirHandle();
            updateAutoSaveStatus();
            returnFocus();
        }

        // ページ読込時：設定済みなら権限状態を確認（queryPermissionはユーザー操作不要で確認可能）
        async function initAutoSaveOnLoad() {
            if (!autoSaveSupported() || !autoSaveEnabled()) {
                updateAutoSaveStatus();
                return;
            }
            try {
                const handle = await idbGetDirHandle();
                if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
                    autoSaveDirHandle = handle;
                    startAutoSaveTimer();
                }
            } catch (_) { /* 取得失敗時は未許可状態として扱う */ }
            updateAutoSaveStatus();
        }

        // 入力フォームを初期状態に戻す共通処理
        function resetForm() {
            document.getElementById('shop').value = "";
            document.getElementById('amount').value = "";
            document.getElementById('memo').value = "";
            document.getElementById('payment').value = "";
            document.getElementById('tax-rate').value = "";
            document.getElementById('invoice').value = "";
            document.getElementById('items').value = "";
            setSplitMode(false);
            clearValidationErrors();
        }

        // 必須項目チェックのエラー表示（赤枠・赤字）をクリア
        function clearValidationErrors() {
            ['date', 'shop', 'payment', 'amount', 'invoice'].forEach(id => {
                document.getElementById(id).classList.remove('input-error');
                document.getElementById(`err-${id}`).textContent = '';
            });
        }

        // 編集モードを終了し、登録ボタン・編集中表示を通常状態に戻す共通処理（フォーム初期化・再描画は呼び出し側で行う）
        function exitEditMode() {
            editingId = null;
            document.getElementById('add-entry-btn').textContent = '支出登録';
            document.getElementById('edit-mode-indicator').style.display = 'none';
        }

        // カーソルを日付に戻す共通処理
        function returnFocus() {
            setTimeout(() => {
                const dateEl = document.getElementById('date');
                dateEl.focus();
                dateEl.select(); // 入力しやすいように選択状態にする
            }, 50);
        }

        function addEntry() {
            const date = document.getElementById('date').value;
            const shop = document.getElementById('shop').value.trim();
            const memo = document.getElementById('memo').value.trim();
            const items = document.getElementById('items').value.split('\n').map(s => s.trim()).filter(s => s.length > 0);

            // 税率分割入力モード：10%/8%/非課税の3欄から金額を自動合計し、taxPartsを組み立てる
            const splitMode = document.getElementById('split-toggle').checked;
            const split10 = splitFieldValue('split-10');
            const split8 = splitFieldValue('split-8');
            const splitNone = splitFieldValue('split-none');
            const taxParts = [];
            if (splitMode) {
                if (split10 > 0) taxParts.push({ rate: '10', amount: split10 });
                if (split8 > 0) taxParts.push({ rate: '8', amount: split8 });
            }

            const amountStr = document.getElementById('amount').value.replace(/,/g, '');
            const amount = splitMode ? (split10 + split8 + splitNone) : Number(amountStr);
            const payment = document.getElementById('payment').value;
            const taxRate = splitMode ? '' : document.getElementById('tax-rate').value;
            const invoice = sanitizeInvoice(document.getElementById('invoice').value);

            if (!validateForm()) {
                return;
            }
            if (shop.length > MAX_SHOP_LENGTH) {
                alert(`利用先は${MAX_SHOP_LENGTH}文字以内で入力してください。`);
                returnFocus();
                return;
            }
            if (amount > MAX_AMOUNT) {
                alert(`金額は${MAX_AMOUNT.toLocaleString()}以下の整数で入力してください。`);
                returnFocus();
                return;
            }
            if (memo.length > MAX_MEMO_LENGTH) {
                alert(`摘要は${MAX_MEMO_LENGTH}文字以内で入力してください。`);
                returnFocus();
                return;
            }
            if (items.length > MAX_ITEMS) {
                alert(`内訳は${MAX_ITEMS}件以内で入力してください。`);
                returnFocus();
                return;
            }
            if (items.some(it => it.length > MAX_ITEM_LENGTH)) {
                alert(`内訳の各項目は${MAX_ITEM_LENGTH}文字以内で入力してください。`);
                returnFocus();
                return;
            }

            if (editingId) {
                const expense = db.expenses.find(e => String(e.id) === editingId);
                if (!expense || expense.status !== "未") {
                    alert("編集対象のデータが見つかりませんでした（他の操作で変更された可能性があります）。編集モードを解除します。");
                    cancelEdit();
                    return;
                }
                expense.date = date;
                expense.shop = shop;
                expense.amount = amount;
                expense.memo = memo;
                expense.payment = payment;
                expense.taxRate = taxRate;
                expense.invoice = invoice;
                expense.items = items;
                if (taxParts.length > 0) {
                    expense.taxParts = taxParts;
                } else {
                    delete expense.taxParts;
                }
                saveToStorage();
                exitEditMode();
                render();
                resetForm();
                alert("更新しました。");
                returnFocus();
                return;
            }

            const newExpense = { id: generateId(), date: date, shop: shop, amount: amount, status: "未", memo: memo, payment: payment, taxRate: taxRate, invoice: invoice, items: items };
            if (taxParts.length > 0) newExpense.taxParts = taxParts;
            db.expenses.push(newExpense);
            saveToStorage();
            render();
            resetForm();
            alert("登録しました。");
            returnFocus();
        }

        // 未精算明細の編集モード開始：フォームへ既存値を読込み、登録ボタンを「更新」に変更
        function startEdit(id) {
            const expense = db.expenses.find(e => String(e.id) === id);
            if (!expense) return;

            editingId = id;
            document.getElementById('date').value = expense.date;
            document.getElementById('shop').value = expense.shop;
            document.getElementById('memo').value = expense.memo || '';
            document.getElementById('payment').value = expense.payment || '';
            document.getElementById('invoice').value = expense.invoice || '';
            document.getElementById('items').value = (expense.items || []).join('\n');

            if (Array.isArray(expense.taxParts) && expense.taxParts.length > 0) {
                const t10 = expense.taxParts.find(p => p.rate === '10');
                const t8 = expense.taxParts.find(p => p.rate === '8');
                const partsSum = (t10 ? t10.amount : 0) + (t8 ? t8.amount : 0);
                document.getElementById('split-10').value = t10 ? t10.amount.toLocaleString('en-US') : '';
                document.getElementById('split-8').value = t8 ? t8.amount.toLocaleString('en-US') : '';
                const noneAmount = expense.amount - partsSum;
                document.getElementById('split-none').value = noneAmount > 0 ? noneAmount.toLocaleString('en-US') : '';
                setSplitMode(true);
            } else {
                document.getElementById('amount').value = expense.amount.toLocaleString('en-US');
                document.getElementById('tax-rate').value = expense.taxRate || '';
                setSplitMode(false);
            }

            document.getElementById('add-entry-btn').textContent = '更新';
            document.getElementById('edit-mode-target').textContent = `${expense.date} ${expense.shop}（${formatYen(expense.amount)}）`;
            document.getElementById('edit-mode-indicator').style.display = 'flex';
            render();
            document.getElementById('shop').focus();
        }

        // 編集モードを終了し、フォームを初期化（元データは無変更）
        function cancelEdit() {
            exitEditMode();
            resetForm();
            render();
            returnFocus();
        }

        // 精算名（ベース名）に対する次の連番を算出（既存の「ベース名-NNN」を走査し最大値+1）
        function nextSettlementSeq(base) {
            const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
            let max = 0;
            db.settlements.forEach(s => {
                if (typeof s.name === 'string') {
                    const m = s.name.match(re);
                    if (m) max = Math.max(max, parseInt(m[1], 10));
                }
            });
            return max + 1;
        }

        function doSettlement(onlySelected = false) {
            let targetExpenses = [];
            if (onlySelected) {
                const selectedIds = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
                targetExpenses = db.expenses.filter(e => e.status === "未" && selectedIds.includes(String(e.id)));
            } else {
                targetExpenses = db.expenses.filter(e => e.status === "未");
            }

            if (targetExpenses.length === 0) {
                alert("精算対象がありません。");
                returnFocus();
                return;
            }

            // 精算名（任意）：チェックON＋ベース名入力ありなら「ベース名-連番」を自動付与
            let settlementName = null;
            if (document.getElementById('settle-name-toggle').checked) {
                const base = document.getElementById('settle-name').value.trim();
                if (base) {
                    if (base.length > MAX_SETTLEMENT_NAME_LENGTH) {
                        alert(`精算名は${MAX_SETTLEMENT_NAME_LENGTH}文字以内で入力してください。`);
                        returnFocus();
                        return;
                    }
                    const seq = nextSettlementSeq(base);
                    settlementName = `${base}-${String(seq).padStart(3, '0')}`;
                }
            }

            const total = targetExpenses.reduce((sum, e) => sum + e.amount, 0);
            const nameLabel = settlementName ? `「${settlementName}」として` : '';
            if (!confirm(`${targetExpenses.length}件、合計 ${formatYen(total)} を${nameLabel}精算しますか？`)) {
                returnFocus();
                return;
            }

            const sId = "SET-" + Date.now();
            targetExpenses.forEach(e => {
                e.status = "済";
                e.settlement_id = sId;
            });

            const settlement = { id: sId, date: new Date().toISOString().split('T')[0], total: total };
            if (settlementName) settlement.name = settlementName;
            db.settlements.push(settlement);
            saveToStorage();
            render();
            alert("精算が完了しました。");
            returnFocus();
        }

        function deleteSelected() {
            const selectedIds = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.value);
            if (selectedIds.length === 0) {
                alert("消去する項目を選択してください。");
                returnFocus();
                return;
            }
            if (!confirm(`${selectedIds.length}件のデータを完全に消去します。この操作は取り消せません。\n本当に消去しますか？`)) {
                returnFocus();
                return;
            }

            db.expenses = db.expenses.filter(e => !selectedIds.includes(String(e.id)));
            saveToStorage();
            render();
            alert("消去しました。");
            returnFocus();
        }

        function toggleAll(master) {
            const checkboxes = document.querySelectorAll('.row-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = master.checked;
                updateRowStyle(cb);
            });
            updateSelectionBar();
        }

        function updateRowStyle(cb) {
            const row = cb.parentNode.parentNode;
            if (cb.checked) row.classList.add('selected');
            else row.classList.remove('selected');
        }

        function updateSelectionBar() {
            const selected = Array.from(document.querySelectorAll('.row-checkbox:checked'));
            const bar = document.getElementById('selection-bar');
            if (selected.length > 0) {
                bar.style.display = 'flex';
                document.getElementById('selected-count').innerText = selected.length;
                const sum = selected.reduce((s, cb) => s + parseFloat(cb.getAttribute('data-amount')), 0);
                document.getElementById('selected-sum-display').innerText = formatYen(sum);
            } else {
                bar.style.display = 'none';
                document.getElementById('select-all').checked = false;
            }
        }

        function getUnpaidFilter() {
            return {
                kw: (document.getElementById('unpaid-filter-kw').value || '').trim().toLowerCase(),
                from: document.getElementById('unpaid-filter-from').value || '',
                to: document.getElementById('unpaid-filter-to').value || ''
            };
        }
        function getHistoryFilter() {
            return {
                kw: (document.getElementById('history-filter-kw').value || '').trim().toLowerCase(),
                from: document.getElementById('history-filter-from').value || '',
                to: document.getElementById('history-filter-to').value || ''
            };
        }
        function matchUnpaidFilter(item) {
            const f = getUnpaidFilter();
            if (f.kw) {
                const targets = [item.shop, item.memo, ...(item.items || [])].map(x => String(x || '').toLowerCase());
                if (!targets.some(t => t.includes(f.kw))) return false;
            }
            if (f.from && item.date < f.from) return false;
            if (f.to && item.date > f.to) return false;
            return true;
        }
        function matchHistoryFilter(s) {
            const f = getHistoryFilter();
            if (f.kw) {
                const targets = [s.name, s.id].map(x => String(x || '').toLowerCase());
                if (!targets.some(t => t.includes(f.kw))) return false;
            }
            if (f.from && s.date < f.from) return false;
            if (f.to && s.date > f.to) return false;
            return true;
        }
        function isUnpaidFilterActive() {
            const f = getUnpaidFilter();
            return !!(f.kw || f.from || f.to);
        }
        function isHistoryFilterActive() {
            const f = getHistoryFilter();
            return !!(f.kw || f.from || f.to);
        }

        function render() {
            const unpaidBody = document.getElementById('unpaid-list');
            const unpaidAll = db.expenses.filter(e => e.status === "未").sort((a, b) => b.date.localeCompare(a.date));
            const unpaidData = isUnpaidFilterActive() ? unpaidAll.filter(matchUnpaidFilter) : unpaidAll;
            const unpaidTotal = unpaidData.reduce((sum, e) => sum + e.amount, 0);
            
            const unpaidFiltered = isUnpaidFilterActive();
            document.getElementById('unpaid-count-display').innerText = unpaidFiltered
                ? `全${unpaidAll.length}件中${unpaidData.length}件`
                : unpaidData.length;
            document.getElementById('unpaid-sum-display').innerText = formatYen(unpaidTotal);
            document.getElementById('appbar-unpaid-sum').innerText = formatYen(
                db.expenses.filter(e => e.status === "未").reduce((s, e) => s + e.amount, 0)
            );
            document.getElementById('unpaid-filter-count').style.display = unpaidFiltered ? 'block' : 'none';
            document.getElementById('unpaid-filter-count').innerText = `全${unpaidAll.length}件中 ${unpaidData.length}件 を表示`;
            document.getElementById('unpaid-settle-note').style.display = unpaidFiltered ? 'block' : 'none';

            // 税率別集計：分割(taxParts)・単一(taxRate)を統一的にパート単位で合算
            let tax10Sum = 0, tax8Sum = 0, taxNoneSum = 0, tax10TaxSum = 0, tax8TaxSum = 0;
            unpaidData.forEach(e => {
                let partsSum = 0;
                getTaxParts(e).forEach(p => {
                    partsSum += p.amount;
                    if (p.rate === '10') { tax10Sum += p.amount; tax10TaxSum += calcTax(p.amount, '10').tax; }
                    else if (p.rate === '8') { tax8Sum += p.amount; tax8TaxSum += calcTax(p.amount, '8').tax; }
                });
                taxNoneSum += (e.amount - partsSum);
            });
            document.getElementById('tax10-sum-display').innerText = formatYen(tax10Sum);
            document.getElementById('tax8-sum-display').innerText = formatYen(tax8Sum);
            document.getElementById('tax-none-sum-display').innerText = formatYen(taxNoneSum);
            document.getElementById('tax10-tax-display').innerText = formatYen(tax10TaxSum);
            document.getElementById('tax8-tax-display').innerText = formatYen(tax8TaxSum);

            unpaidBody.innerHTML = unpaidData.length ? "" : '<tr><td colspan="8" class="empty-msg">未精算のデータはありません</td></tr>';
            unpaidData.forEach(item => {
                const row = unpaidBody.insertRow();
                if (editingId && String(item.id) === editingId) row.classList.add('editing-row');
                const taxCell = buildTaxCell(item);
                row.innerHTML = `
                    <td style="text-align:center;"><input type="checkbox" class="row-checkbox" value="${escapeHtml(item.id)}" data-amount="${item.amount}"></td>
                    <td class="nowrap-cell">${escapeHtml(item.date)}</td>
                    <td>${escapeHtml(item.shop)}</td>
                    <td class="amount nowrap-cell">${item.amount.toLocaleString()}</td>
                    <td>${escapeHtml(item.memo || '')}${(item.items && item.items.length > 0) ? ` <details class="help-details"><summary class="items-badge">内訳${item.items.length}件</summary><div class="help-content"><ul class="items-list">${item.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</ul><div class="help-close">close</div></div></details>` : ''}</td>
                    <td class="nowrap-cell">${escapeHtml(item.payment || '')}</td>
                    <td class="nowrap-cell">${taxCell}</td>
                    <td style="text-align:center;"><button class="btn-sub edit-btn" data-id="${escapeHtml(String(item.id))}">編集</button></td>
                `;
            });

            const historyBody = document.getElementById('history-list');
            const historyAll = [...db.settlements].reverse();
            const historyFiltered = isHistoryFilterActive();
            const historyData = historyFiltered
                ? historyAll.filter(matchHistoryFilter)
                : historyAll.slice(0, 10);
            const settledItems = db.expenses.filter(e => e.status === "済");

            document.getElementById('history-count-display').innerText = db.settlements.length;
            document.getElementById('settled-item-count-display').innerText = settledItems.length;
            document.getElementById('history-limit-note').style.display =
                (!historyFiltered && db.settlements.length > 10) ? 'block' : 'none';
            document.getElementById('history-filter-count').style.display = historyFiltered ? 'block' : 'none';
            document.getElementById('history-filter-count').innerText = `全${db.settlements.length}件中 ${historyData.length}件 を表示`;

            historyBody.innerHTML = historyData.length ? "" : '<tr><td colspan="3" class="empty-msg">履歴はありません</td></tr>';
            historyData.forEach(s => {
                const row = historyBody.insertRow();
                row.innerHTML = `<td class="nowrap-cell">${escapeHtml(s.date)}</td><td><span class="settle-id-link" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</span></td><td class="amount nowrap-cell" style="color:var(--sub-color);">${s.total.toLocaleString()}</td>`;
            });

            // 孤児明細：精算済だが対応する精算履歴が見つからない明細（主にデータ統合時に発生）
            const orphanData = getOrphanExpenses();
            const orphanSection = document.getElementById('orphan-section');
            const orphanNote = document.getElementById('orphan-note');
            const orphanScrollHint = document.getElementById('orphan-scroll-hint');
            const orphanTable = document.getElementById('orphan-table');
            const orphanBody = document.getElementById('orphan-list');
            const showOrphan = orphanData.length > 0;
            document.getElementById('orphan-card').style.display = showOrphan ? 'block' : 'none';
            orphanSection.style.display = showOrphan ? 'flex' : 'none';
            orphanNote.style.display = showOrphan ? 'block' : 'none';
            orphanScrollHint.style.display = showOrphan ? '' : 'none';
            orphanTable.style.display = showOrphan ? 'table' : 'none';
            document.getElementById('orphan-count-display').innerText = orphanData.length;
            orphanBody.innerHTML = '';
            orphanData.forEach(item => {
                const row = orphanBody.insertRow();
                row.innerHTML = `
                    <td>${escapeHtml(item.date)}</td>
                    <td>${escapeHtml(item.shop)}</td>
                    <td class="amount">${item.amount.toLocaleString()}</td>
                    <td>${escapeHtml(item.memo || '')}</td>
                    <td>${escapeHtml(String(item.settlement_id))}</td>
                    <td style="text-align:center;">
                        <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
                            <button class="btn-sub orphan-revert-btn" data-id="${escapeHtml(String(item.id))}">未精算に戻す</button>
                            <button class="btn-del orphan-delete-btn" data-id="${escapeHtml(String(item.id))}">削除</button>
                        </div>
                    </td>
                `;
            });

            updateSelectionBar();
            updateShopSuggestions();
        }

        // 精算済だが対応する精算履歴が見つからない明細（孤児明細）を抽出
        function getOrphanExpenses() {
            const settlementIds = new Set(db.settlements.map(s => String(s.id)));
            return db.expenses.filter(e =>
                e.status === '済' &&
                e.settlement_id !== undefined && e.settlement_id !== null &&
                !settlementIds.has(String(e.settlement_id))
            );
        }

        // 孤児明細を未精算に戻す（対応する精算履歴がないため、精算合計の調整は不要）
        function revertOrphanToUnpaid(id) {
            const expense = db.expenses.find(e => String(e.id) === id);
            if (!expense) return;
            if (!confirm(`この明細（${formatYen(expense.amount)}）を未精算に戻しますか？`)) return;

            expense.status = "未";
            delete expense.settlement_id;
            saveToStorage();
            render();
            alert("未精算に戻しました。");
        }

        // 孤児明細を完全に削除
        function deleteOrphan(id) {
            const expense = db.expenses.find(e => String(e.id) === id);
            if (!expense) return;
            if (!confirm(`この明細（${formatYen(expense.amount)}）を完全に削除します。この操作は取り消せません。\n本当に削除しますか？`)) return;

            db.expenses = db.expenses.filter(e => String(e.id) !== id);
            saveToStorage();
            render();
            alert("削除しました。");
        }

        function showDetail(sId) {
            const details = db.expenses.filter(e => e.settlement_id === sId);
            const settlement = db.settlements.find(s => s.id === sId);

            // 画面操作（印刷時は非表示）：印刷レイアウト設定（個別表示選択）＋印刷/PDF保存ボタン
            let html = `<div class="no-print" style="display:flex; flex-direction:column; gap:10px; margin-bottom:15px; padding:12px; background:#f5f5f5; border-radius:8px;">`;
            html += `<div class="print-layout-settings" style="display:flex; flex-direction:column; gap:6px;">
                <span style="font-weight:bold; font-size:13px;">印刷レイアウト設定</span>
                <div style="display:flex; flex-wrap:wrap; align-items:center; gap:10px; font-size:14px;">
                    <label style="display:flex; align-items:center; gap:4px; font-weight:normal; margin:0; white-space:nowrap;"><input type="checkbox" id="print-show-approver" style="transform:scale(1.2); margin:0;"> 承認者欄</label>
                    <label style="display:flex; align-items:center; gap:4px; font-weight:normal; margin:0; white-space:nowrap;"><input type="checkbox" id="print-show-confirm" style="transform:scale(1.2); margin:0;"> 確認印</label>
                    <label style="display:flex; align-items:center; gap:4px; font-weight:normal; margin:0; white-space:nowrap;"><input type="checkbox" id="print-show-approve" style="transform:scale(1.2); margin:0;"> 承認印</label>
                    <label style="display:flex; align-items:center; gap:4px; font-weight:normal; margin:0; white-space:nowrap;"><input type="checkbox" id="print-show-accounting" style="transform:scale(1.2); margin:0;"> 経理処理印</label>
                </div>
            </div>`;
            html += `<div class="modal-action-row">`;
            html += `<span class="h2-btn-row">`;
            html += `<button class="btn-sub print-settlement-btn">精算書印刷</button>`;
            html += `<details class="help-details">
                <summary class="help-icon" aria-label="印刷時のヘッダー・フッターについて">！</summary>
                <div class="help-content">
                    <ul class="help-list">
                        <li>・印刷日時やURLが上下に表示される場合あり</li>
                        <li>・印刷ダイアログの「詳細設定」を開く</li>
                        <li>・「ヘッダーとフッター」のチェックを外すと非表示</li>
                    </ul>
                    <div class="help-close">close</div>
                </div>
            </details>`;
            html += `</span>`;
            html += `<span class="h2-btn-row">`;
            html += `<button class="btn-sub excel-export-btn" data-kind="settlement" data-settlement-id="${escapeHtml(sId)}" style="background-color:#217346;">Excel出力</button>`;
            html += `</span>`;
            html += `</div>`;
            html += `</div>`;

            html += `<div class="no-print" style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; gap: 6px;">`;
            html += `<h3 style="margin:0; white-space:nowrap;">精算日: ${escapeHtml(settlement.date)}</h3>`;
            html += `<div style="font-size: 18px; color: #666; white-space:nowrap;">明細件数: ${details.length} 件</div>`;
            html += `</div>`;
            let totalTax = 0;
            let printRows = '';
            details.forEach(d => {
                const itemsHtml = (d.items && d.items.length > 0)
                    ? `<ul class="items-list">${d.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</ul>`
                    : '';
                let taxText = '';
                const parts = getTaxParts(d);
                if (parts.length > 1 || (Array.isArray(d.taxParts) && d.taxParts.length > 0)) {
                    taxText = parts.map(p => {
                        const tax = calcTax(p.amount, p.rate);
                        totalTax += tax.tax;
                        return `${p.rate}%対象${tax.excluded.toLocaleString()}（税${tax.tax.toLocaleString()}）`;
                    }).join(' / ');
                } else if (d.taxRate) {
                    const tax = calcTax(d.amount, d.taxRate);
                    if (tax) totalTax += tax.tax;
                    taxText = `税率${escapeHtml(d.taxRate)}%${tax ? `（税抜${tax.excluded.toLocaleString()} / 税${tax.tax.toLocaleString()}）` : ''}`;
                }
                html += `<div class="detail-card">`;
                html += `<div class="detail-row-main"><span>${escapeHtml(d.date)} ${escapeHtml(d.shop)}</span><span class="detail-amount">${d.amount.toLocaleString()}</span></div>`;
                html += `<div class="detail-row-sub">`;
                html += `<span>${escapeHtml(d.memo || '（摘要なし）')}${itemsHtml}</span>`;
                if (d.payment) html += `<span>${escapeHtml(d.payment)}</span>`;
                if (taxText) html += `<span>${taxText}</span>`;
                html += `</div>`;
                html += `<div class="detail-row-action"><button class="btn-sub revert-btn" data-id="${escapeHtml(String(d.id))}" data-settlement="${escapeHtml(sId)}">未精算に戻す</button></div>`;
                html += `</div>`;
            });

            // 印刷用：書類形式の行（操作列なし、日付は「年月日」表記、税率は区分のみ・インボイスは登録番号、領収書番号/備考は手書き欄）
            // 画面の明細カード（上記）は登録順のまま、印刷帳票のみ並び順設定を適用する
            [...details].sort(getSortComparator('date', 'shop')).forEach(d => {
                const itemsHtml = (d.items && d.items.length > 0)
                    ? `<ul class="items-list">${d.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</ul>`
                    : '';
                printRows += `<tr>
                    <td class="col-narrow">${formatDateJP(d.date)}</td>
                    <td>${escapeHtml(d.shop)}</td>
                    <td>${escapeHtml(d.memo || '')}${itemsHtml}</td>
                    <td class="num col-narrow">${d.amount.toLocaleString()}</td>
                    <td class="col-narrow">${escapeHtml(d.payment || '')}</td>
                    <td class="col-narrow">${taxCategoryLabel(d)}</td>
                    <td class="col-invoice">${d.invoice ? escapeHtml(d.invoice) : '-'}</td>
                    <td class="rcpt-cell"><div class="rcpt-no">　</div><div class="rcpt-memo">　</div></td>
                </tr>`;
            });
            html += `<div class="detail-summary"><span>合計</span><span>${settlement.total.toLocaleString()}</span></div>`;
            html += `<div class="detail-summary sub"><span>うち消費税額（10%/8%対象・切り捨て参考値）</span><span>${totalTax.toLocaleString()}</span></div>`;

            // 対象期間：明細の利用日の最小〜最大から自動算出
            let periodText = '-';
            if (details.length) {
                const dates = details.map(d => d.date).sort();
                const from = formatDateJP(dates[0]);
                const to = formatDateJP(dates[dates.length - 1]);
                periodText = from === to ? from : `${from}　〜　${to}`;
            }

            // 印刷専用の書類本体（画面では非表示）：画面の明細カードとは別に、帳票形式の表として組み立てる
            html += `<div class="print-only print-document">
                <div class="print-doc-header"><h1>経費精算書</h1></div>
                <div class="print-summary-row">
                    <span class="print-field-empid">社員ID：<span class="print-empid-val print-blank"></span></span>
                    <span class="print-field-name">氏名：<span class="print-name-val print-blank"></span></span>
                    <span>申請日：<span class="print-doc-date"></span></span>
                    <span class="item-approver">承認者：　　　　　</span>
                </div>
                <table class="print-meta-table compact-row">
                    <tr>
                        <th>対象期間</th><td>${periodText}</td>
                        <th>提出区分</th><td>□月次　□未提出分　□急ぎ</td>
                        <th>精算ID</th><td>${escapeHtml(settlement.name || sId)}</td>
                    </tr>
                </table>
                <div class="print-table-note">※ 金額は税込</div>
                <table class="print-table settlement">
                    <thead>
                        <tr>
                            <th class="col-narrow">利用日</th><th>支払先</th><th>内容</th><th class="num col-narrow">金額</th><th class="col-narrow">支払</th><th class="col-narrow">税率</th><th class="col-invoice">インボイス<br>登録番号</th>
                            <th class="col-rcpt">領収書番号<br>備考</th>
                        </tr>
                    </thead>
                    <tbody>${printRows}</tbody>
                    <tfoot>
                        <tr><td colspan="3">合計</td><td class="num">${settlement.total.toLocaleString()}</td><td colspan="4"></td></tr>
                        <tr class="sub"><td colspan="3">うち消費税額（10%/8%対象・切り捨て参考値）</td><td class="num">${totalTax.toLocaleString()}</td><td colspan="4"></td></tr>
                    </tfoot>
                </table>
                <div class="print-approval">
                    <div class="approval-box confirm"><div class="label">確認印</div></div>
                    <div class="approval-box approve"><div class="label">承認印</div></div>
                    <div class="approval-box accounting"><div class="label">経理<br>処理印</div></div>
                </div>
            </div>`;

            document.getElementById('modal-title').style.paddingRight = '';
            document.getElementById('modal-title').innerHTML = `精算内訳 (<span style="white-space:nowrap;">${escapeHtml(settlement.name || sId)}</span>)<br><span style="font-size: 16px; color: #999; font-weight: normal;">（表内の金額の単位：円）</span>`;
            document.getElementById('modal-body').innerHTML = html;
            document.getElementById('modal').style.display = 'flex';
        }

        // 精算済の明細を1件単位で未精算に戻す（精算取消・修正が必要な場合は未精算の編集仕様に従う）
        function revertToUnpaid(id, sId) {
            const expense = db.expenses.find(e => String(e.id) === id);
            const settlement = db.settlements.find(s => s.id === sId);
            if (!expense || !settlement) return;

            if (!confirm(`この明細（${formatYen(expense.amount)}）を未精算に戻しますか？`)) return;

            expense.status = "未";
            delete expense.settlement_id;
            settlement.total -= expense.amount;

            const remaining = db.expenses.some(e => e.settlement_id === sId);
            if (!remaining) {
                db.settlements = db.settlements.filter(s => s.id !== sId);
            }

            saveToStorage();
            render();

            if (remaining) {
                showDetail(sId);
                alert("未精算に戻しました。");
            } else {
                closeModal();
                alert("未精算に戻しました。この精算の明細はすべて未精算に戻ったため、精算履歴を削除しました。");
            }
        }

        function showManual() {
            document.getElementById('modal-title').style.paddingRight = '';
            document.getElementById('modal-title').innerHTML = '使い方';
            document.getElementById('modal-body').innerHTML = `
<div class="manual">

<p class="manual-warn">⚠ 登録したデータはこのブラウザ内（localStorage）にのみ保存され、システム側で永続的に管理されるものではありません。ブラウザのデータ消去や端末変更で失われるため、「データ保存（バックアップ）」から定期的にバックアップを保存するか、対応ブラウザでは「フォルダへの自動保存」の設定を推奨します。</p>

<details open>
<summary>画面の構成</summary>
<div class="manual-section-body">
<img class="manual-fig" src="assets/img/manual-screen-059.png" alt="メイン画面の構成">
<ul class="manual-legend">
  <li>① ヘッダー：未精算合計／使い方</li>
  <li>② 支出登録：入力＋印刷用情報（社員ID・氏名・申請日）</li>
  <li>③ 未精算明細：一覧・個別/一括精算・明細印刷（帳票A）</li>
  <li>④ 精算履歴：精算IDタップで内訳モーダル・履歴印刷（帳票C）</li>
  <li>⑤ フッター：CSV／自動保存管理</li>
</ul>
</div>
</details>

<details>
<summary>クイックスタート</summary>
<div class="manual-section-body">
<h4>1. 支出を登録（②）</h4>
<p>日付・利用先・金額・支払方法を入力し「支出登録」→③に追加</p>
<h4>2. 精算する（③）</h4>
<p>「一括精算」または選択して「選択項目を精算」→④に移動</p>
<h4>3. 帳票を出力する（④）</h4>
<img class="manual-fig" src="assets/img/manual-settlement-059.png" alt="精算内訳モーダル">
<p>精算IDタップ→内訳モーダル。「精算書印刷」で印刷帳票と同じ書式のPDF、「Excel出力」で同じ書式の編集可能な.xlsxを出力</p>
<h4>4. バックアップする（⑤）</h4>
<p>「データ保存（バックアップ）」でJSON保存。復元は「データ読込」</p>
<h4>5. フォルダへ自動保存する（対応ブラウザ・任意）</h4>
<img class="manual-fig" src="assets/img/manual-autosave-062.png" alt="フォルダへの自動保存">
<p>Chrome・Edge等では「データ保存」カード上部の「フォルダへの自動保存を設定」をクリック→案内画面の指示に従い「ドキュメント」内に「経費管理_保存用」フォルダを新規作成→2つの確認チェックをONにすると「フォルダ選択へ進む」が押せるようになる→クリックして保存先ダイアログで作成したフォルダを選択。<strong>ここでブラウザ自身が「このフォルダ内のファイルの表示と編集を許可しますか」等の許可確認を表示する場合があるため、「許可」または「編集を許可」を選択する</strong>。既存の業務フォルダ等を選んだ場合も、アプリが内部に専用サブフォルダを自動作成して隔離するが、誤操作防止のため案内どおり専用フォルダを用意することを推奨。以降の変更は一定間隔でそのフォルダへ保存。<strong>この自動保存はアプリ（タブ）を開いている間のみ動作し、閉じると停止する（バックグラウンドでは継続しない）</strong>。次回アクセス時は1回「保存を再開（許可）」が必要</p>
</div>
</details>

<details>
<summary>機能リファレンス</summary>
<div class="manual-section-body">
<h4>②支出登録</h4>
<dl>
  <dt>必須項目</dt><dd>日付・利用先・金額・支払方法</dd>
  <dt>税率</dt><dd>8%／10%／対象外。分割トグルで混在入力も可</dd>
  <dt>インボイス番号</dt><dd>13桁の数字（先頭Tは不要）</dd>
  <dt>印刷用情報</dt><dd>社員ID・氏名・申請日。<strong>保存されずリロードで消去</strong>（プライバシー保護）</dd>
  <dt>帳票の並び順</dt><dd>「印刷用情報」を開くと選択可：日付（降順・新しい順／既定）／日付（昇順・古い順）／利用先名（アスキーコード順）／日付→利用先名（アスキーコード順）。<strong>画面の明細一覧は登録順のまま変わらず、印刷帳票（A・B・C）の並びだけに反映</strong>。設定は次回も保持。精算履歴（帳票C）は利用先名の列が無いため、利用先名指定時は精算名で代わりに並べ替え</dd>
</dl>
<img class="manual-fig" src="assets/img/manual-print-info-060.png" alt="印刷用情報と帳票の並び順">
<h4>③未精算明細</h4>
<dl>
  <dt>一括精算／選択精算</dt><dd>全件または選択分のみ精算し④へ移動</dd>
  <dt>精算名</dt><dd>同名は「-001」のように自動連番</dd>
  <dt>明細印刷</dt><dd>帳票A（経費精算明細書）を出力</dd>
</dl>
<h4>④精算履歴</h4>
<dl>
  <dt>精算内訳モーダル</dt><dd>帳票B（経費精算書）の印刷・Excel出力。確認印／承認印欄の表示切替可</dd>
  <dt>履歴印刷</dt><dd>帳票C（精算履歴一覧）を出力</dd>
  <dt>孤児明細</dt><dd>対応する履歴が見つからない精算済明細。未精算に戻すか削除を選択</dd>
</dl>
<h4>帳票A/B/C共通：出力形式</h4>
<dl>
  <dt>印刷／PDF保存</dt><dd>ブラウザの印刷機能でPDF化。複数ページ時は「n / N」を自動付与</dd>
  <dt>Excel出力</dt><dd>印刷帳票と同じレイアウト（タイトル・罫線・合計・承認欄）の.xlsxを出力。数値は再集計可能</dd>
</dl>
<h4>⑤フッター：データ管理</h4>
<dl>
  <dt>CSV出力／読込</dt><dd>全明細のエクスポート／追加インポート（読込分は全て未精算）</dd>
  <dt>データ保存／読込</dt><dd>全データをJSONで保存／復元</dd>
  <dt>バックアップ統合／自動保存管理</dt><dd>複数JSONの統合、世代管理（重要な世代は固定可）。これはブラウザ内（localStorage）の世代管理で、PC内のフォルダへの保存ではありません</dd>
</dl>
<h4>データ保存カード上部：フォルダへの自動保存</h4>
<dl>
  <dt>対応環境</dt><dd>Chrome・Edge等の対応ブラウザのみ（Webの仕様上、Safari・Firefoxでは利用不可）</dd>
  <dt>初回設定</dt><dd>「フォルダへの自動保存を設定」でPC内の保存先（例：Documents）を選択し、フォルダ名（既定「経費バックアップ」・編集可）を確認。<strong>選択した場所の中に、その名前の専用フォルダがアプリによって自動作成</strong>され、他のファイルと混在しません</dd>
  <dt>フォルダ選択時の許可確認</dt><dd>設定操作は次の順で進む：①アプリの案内モーダルで注意文を確認し2つのチェックをON→「フォルダ選択へ進む」②OS標準のフォルダ選択ダイアログでフォルダを指定③（ブラウザによっては）続けて「このフォルダ内のファイルの表示と編集を許可しますか」という<strong>ブラウザ自身の許可確認</strong>が表示されるため「許可」を選択。③が出ない場合は②の選択完了で許可済みとなる</dd>
  <dt>保存方式</dt><dd>設定後はそのアクセス中、データ変更があれば一定間隔（設定可）で自動的にフォルダへ保存。ファイルは日時付きで世代別に保存され、保持件数（設定可）を超えた古いものから自動削除。<strong>この自動保存はアプリ（タブ）を開いている間のみ動作し、閉じると即停止する（バックグラウンドでは継続しない）</strong></dd>
  <dt>次回アクセス時の操作</dt><dd>ブラウザの仕様上、アクセスごとに1回「保存を再開（許可）」のクリックが必要（完全な無操作では保存を開始できません）。<strong>この許可確認は毎回のアクセスで必要（許可状態はブラウザを閉じると引き継がれない）</strong></dd>
  <dt>状態の確認</dt><dd>「データ保存」カード上部の表示で、保存先フォルダ名・最終保存時刻・許可状態を常時確認可能</dd>
</dl>
</div>
</details>

<details>
<summary>検索・絞り込みと常用登録</summary>
<div class="manual-section-body">
<h4>🔍 絞り込み（③④共通）</h4>
<p>キーワード（利用先・摘要・精算名等）と期間で絞り込み。「クリア」で全件表示に戻る</p>
<p style="font-size:13px; color:#b45309; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:6px 10px;">⚠ 絞り込みは画面表示のみに影響。一括精算・帳票出力は常に全データが対象</p>
<h4>★ 常用登録</h4>
<p>利用先・検索ワードを「★登録」でchip保存。クリックで即入力。バックアップJSONにも含まれます</p>
</div>
</details>

<details>
<summary>よくある質問</summary>
<div class="manual-section-body">
<p class="manual-q">Q. データはどこに保存されますか？</p>
<p class="manual-a">A. このブラウザのlocalStorageのみ。他端末への移行は「データ保存」→「データ読込」で。対応ブラウザでは「フォルダへの自動保存」でPC内の指定フォルダへも保存できます。</p>
<p class="manual-q">Q. 「フォルダへの自動保存」を設定したのに、次回開いたら止まっています。</p>
<p class="manual-a">A. ブラウザの仕様で、アクセスごとに1回の許可操作が必要です。「データ保存」カード上部の「保存を再開（許可）」をクリックしてください。</p>
<p class="manual-q">Q. アプリを閉じても自動保存は続きますか？</p>
<p class="manual-a">A. 続きません。自動保存はアプリ（タブ）を開いている間のみ動作する仕組みで、閉じると即停止します。閉じる前に「データ保存（バックアップ）」でJSONを保存しておくと安心です。</p>
<p class="manual-q">Q. フォルダ作成時にブラウザから許可を求める表示が出ました。何を選べばいいですか？</p>
<p class="manual-a">A. アプリの案内モーダルでの確認（チェック2件）の後、OSのフォルダ選択画面でフォルダを選ぶと、ブラウザによっては続けて「このフォルダ内のファイルの表示と編集を許可しますか」という確認が出ます。アプリが指定フォルダへ保存するために必要な許可なので「許可」を選択してください。</p>
<p class="manual-q">Q. 印刷にブラウザのヘッダー・フッターが出ます。</p>
<p class="manual-a">A. 印刷ダイアログの「詳細設定」で「ヘッダーとフッター」をオフにしてください。</p>
<p class="manual-q">Q. インボイス番号の入力方法は？</p>
<p class="manual-a">A. 先頭の「T」は不要。13桁の数字のみ入力してください。</p>
<p class="manual-q">Q. 「1 / 2」という表示は何ですか？</p>
<p class="manual-a">A. 印刷ページ番号です。正しく表示するには印刷ダイアログの拡大/縮小を100%にしてください。</p>
</div>
</details>

</div>`;
            document.getElementById('modal').style.display = 'flex';
        }

        function closeModal() { document.getElementById('modal').style.display = 'none'; }

        // 未精算一覧・精算履歴の印刷用テーブル（画面の操作列を含まない、正式な書式の控え）を組み立てる
        function buildPrintTables() {
            const unpaidData = db.expenses.filter(e => e.status === "未").sort(getSortComparator('date', 'shop'));
            document.getElementById('unpaid-print-count').textContent = unpaidData.length;
            let unpaidTotal = 0;
            document.getElementById('unpaid-print-list').innerHTML = unpaidData.length ? unpaidData.map(item => {
                unpaidTotal += item.amount;
                return `<tr>
                    <td>${formatDateJP(item.date)}</td>
                    <td>${escapeHtml(item.shop)}</td>
                    <td>${escapeHtml(item.memo || '')}</td>
                    <td>${escapeHtml(item.payment || '')}</td>
                    <td>${buildTaxCell(item)}</td>
                    <td class="num">${item.amount.toLocaleString()}</td>
                </tr>`;
            }).join('') : '<tr><td colspan="6">未精算のデータはありません</td></tr>';
            document.getElementById('unpaid-print-total').textContent = unpaidTotal.toLocaleString();

            // 精算履歴：利用先名の列を持たないため「利用先名」並び順は精算名（s.name）で代替
            const historyData = [...db.settlements].sort(getSortComparator('date', 'name'));
            document.getElementById('history-print-count').textContent = historyData.length;
            document.getElementById('history-print-list').innerHTML = historyData.length ? historyData.map(s => {
                const count = db.expenses.filter(e => e.settlement_id === s.id).length;
                return `<tr>
                    <td>${formatDateJP(s.date)}</td>
                    <td>${escapeHtml(s.name || s.id)}</td>
                    <td class="num">${count}</td>
                    <td class="num">${s.total.toLocaleString()}</td>
                </tr>`;
            }).join('') : '<tr><td colspan="4">履歴はありません</td></tr>';
        }

        // mm（物理単位）をpxへ変換。ブラウザのmm定義は96dpi基準で固定（96/25.4 px/mm）
        function mmToPx(mm) {
            return mm * 96 / 25.4;
        }

        // 印刷帳票の自前ページ割り：1枚のtableをA4印字可能領域に収まる複数ページへ分割し、
        // 各ページ末尾に "n / N" のフッタを付与する（ブラウザの@pageページカウンタ非対応を自前で補う）。
        // docEl: .print-document要素 / tableSelector: 帳票本体tableのセレクタ（'.print-table'等）
        // 戻り値：呼び出し前のinnerHTML（印刷後に復元するため）。対象テーブルが見つからない場合はnull
        function paginatePrintDocument(docEl, tableSelector) {
            const tableEl = docEl.querySelector(tableSelector);
            if (!tableEl) return null;
            const originalHTML = docEl.innerHTML;

            // テーブルの前後にある要素（見出し・注記・承認欄など）を分離
            const allChildren = Array.from(docEl.children);
            const tableIndex = allChildren.indexOf(tableEl);
            const preHtml = allChildren.slice(0, tableIndex).map(el => el.outerHTML).join('');
            const postExtraHtml = allChildren.slice(tableIndex + 1).map(el => el.outerHTML).join('');

            const theadEl = tableEl.querySelector('thead');
            const tfootEl = tableEl.querySelector('tfoot');
            const tbodyEl = tableEl.querySelector('tbody');
            const theadHtml = theadEl ? theadEl.outerHTML : '';
            const tfootHtml = tfootEl ? tfootEl.outerHTML : '';
            const rowEls = tbodyEl ? Array.from(tbodyEl.children) : [];
            const tableClass = tableEl.className;

            // ---- 計測：オフスクリーン領域に実物と同じ幅・同じCSSで丸ごと描画し、各要素の実高さを取得 ----
            const measure = document.getElementById('print-measure');
            const rowsHtmlTagged = rowEls.map((tr, i) => {
                const clone = tr.cloneNode(true);
                clone.setAttribute('data-pgidx', String(i));
                return clone.outerHTML;
            }).join('');
            measure.innerHTML =
                `<div class="print-document"><div data-measure="pre">${preHtml}</div>` +
                `<table class="${tableClass}">${theadHtml}<tbody>${rowsHtmlTagged}</tbody>${tfootHtml}</table>` +
                `<div data-measure="post">${postExtraHtml}</div>` +
                `<div class="print-page-footer" data-measure="footer">1 / 1</div></div>`;

            const preHeaderHeight = measure.querySelector('[data-measure="pre"]').offsetHeight;
            const postExtraHeight = measure.querySelector('[data-measure="post"]').offsetHeight;
            const footerHeight = measure.querySelector('[data-measure="footer"]').offsetHeight;
            const measuredThead = measure.querySelector('table thead');
            const measuredTfoot = measure.querySelector('table tfoot');
            const theadHeight = measuredThead ? measuredThead.offsetHeight : 0;
            const tfootHeight = measuredTfoot ? measuredTfoot.offsetHeight : 0;
            const rowHeights = rowEls.map((_, i) => measure.querySelector(`tr[data-pgidx="${i}"]`).offsetHeight);
            measure.innerHTML = ''; // 計測終了・クリア

            // A4縦：297mm - 上下マージン14mm*2（@page margin: 14mm; と一致させる）
            // SAFETY_MARGIN_MM：画面表示（計測時）と実際の印刷レンダリングのフォント・行間の微差を吸収する安全余白。
            // 計測は通常表示中のオフスクリーン領域で行うため、印刷時のレンダリングと完全には一致しない場合がある。
            // 安全側（1行早めに改ページ）に倒すことで「n / N」表記が実際のページ数とズレるのを防ぐ。
            const SAFETY_MARGIN_MM = 10;
            const PAGE_CONTENT_HEIGHT_PX = mmToPx(297 - 14 * 2 - SAFETY_MARGIN_MM);
            const regularBudget = PAGE_CONTENT_HEIGHT_PX - preHeaderHeight - theadHeight - footerHeight;

            // ---- 行を貪欲法でページに詰める（各ページ：見出し＋行＋フッタが収まる範囲まで） ----
            const pages = [];
            let current = [];
            let currentHeight = 0;
            rowHeights.forEach((h, i) => {
                if (current.length > 0 && currentHeight + h > regularBudget) {
                    pages.push(current);
                    current = [];
                    currentHeight = 0;
                }
                current.push(i);
                currentHeight += h;
            });
            pages.push(current); // データなし(0行)でも1ページ生成

            // 最終ページに合計欄・承認欄等(tfoot+付帯要素)が収まるか確認。収まらなければ専用ページを追加
            const lastPageHeight = pages[pages.length - 1].reduce((sum, i) => sum + rowHeights[i], 0);
            if (lastPageHeight + tfootHeight + postExtraHeight > regularBudget) {
                pages.push([]);
            }

            // ---- ページDOM構築：各ページに見出しを再掲し、末尾に "n / N" フッタを付与 ----
            const totalPages = pages.length;
            let html = '';
            pages.forEach((rowIdxs, pageIdx) => {
                const isLast = pageIdx === totalPages - 1;
                const bodyHtml = rowIdxs.map(i => rowEls[i].outerHTML).join('');
                html += `<div class="print-page">`;
                html += preHtml;
                html += `<table class="${tableClass}">${theadHtml}<tbody>${bodyHtml}</tbody>${isLast ? tfootHtml : ''}</table>`;
                if (isLast) html += postExtraHtml;
                html += `<div class="print-page-footer">${pageIdx + 1} / ${totalPages}</div>`;
                html += `</div>`;
            });

            docEl.innerHTML = html;
            return originalHTML;
        }

        // 印刷／PDF保存：bodyに対象クラスを付与してブラウザの印刷機能を呼び出す
        // mode: 'settlement'（精算内訳モーダル） / 'unpaid'（未精算一覧） / 'history'（精算履歴）
        // options: 精算書の「印刷レイアウト設定」（承認者欄・確認印・承認印・経理処理印）の表示有無
        function printTarget(mode, options = {}) {
            if (mode === 'unpaid' || mode === 'history') buildPrintTables();
            applyPrintInfo();
            document.body.classList.add('printing', 'print-' + mode);
            document.body.classList.toggle('print-show-approver', !!options.showApprover);
            document.body.classList.toggle('print-show-confirm', !!options.showConfirm);
            document.body.classList.toggle('print-show-approve', !!options.showApprove);
            document.body.classList.toggle('print-show-accounting', !!options.showAccounting);

            // 自前ページ割り：対象帳票のtableを計測し、複数ページ＋"n / N"フッタへ分割する
            let docEl = null, tableSelector = '';
            if (mode === 'unpaid') { docEl = document.querySelector('#unpaid-card > .print-document'); tableSelector = '.print-table'; }
            else if (mode === 'history') { docEl = document.querySelector('#history-card > .print-document'); tableSelector = '.print-table'; }
            else if (mode === 'settlement') { docEl = document.querySelector('#modal .print-document'); tableSelector = '.print-table.settlement'; }

            let restoreHTML = null;
            if (docEl) restoreHTML = paginatePrintDocument(docEl, tableSelector);

            window.onafterprint = () => {
                if (docEl && restoreHTML !== null) docEl.innerHTML = restoreHTML;
                window.onafterprint = null;
            };

            window.print();
        }

        // ===== 保存ファイル（JSON）の内容確認・整理 =====
        // ご意見・ご要望フォームを別タブで開く（未設定時はその旨を通知）
        function openFeedbackForm() {
            if (!FEEDBACK_FORM_URL || FEEDBACK_FORM_URL.includes('PLACEHOLDER')) {
                alert("ご意見フォームは準備中です。");
                returnFocus();
                return;
            }
            window.open(FEEDBACK_FORM_URL, '_blank', 'noopener');
        }

        // 複数の保存JSONを読み込み、重複ID除外で1つの作業データ（fileReviewState）にまとめ、
        // モーダル上で消去・主要項目編集を行い、書き出し or 現データへの統合読込ができる。
        // 実データ(db)は「統合読込」を確定するまで一切変更しない。
        let fileReviewState = null; // { expenses: [...], settlements: [...] }
        let frEditingId = null;     // 編集中の経費明細ID（fileReviewState内）

        function openFileReview() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.multiple = true;
            input.onchange = e => {
                const files = Array.from(e.target.files || []);
                if (files.length === 0) return;

                const readers = files.map(file => new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload = ev => {
                        try {
                            const parsed = JSON.parse(ev.target.result);
                            if (isValidDb(parsed)) {
                                resolve({ name: file.name, ok: true, data: parsed });
                            } else {
                                resolve({ name: file.name, ok: false });
                            }
                        } catch (err) {
                            resolve({ name: file.name, ok: false });
                        }
                    };
                    reader.onerror = () => resolve({ name: file.name, ok: false });
                    reader.readAsText(file);
                }));

                Promise.all(readers).then(results => {
                    const validResults = results.filter(r => r.ok);
                    const invalidNames = results.filter(r => !r.ok).map(r => r.name);

                    if (validResults.length === 0) {
                        alert("有効なバックアップファイルが見つかりませんでした（JSON解析エラーまたは構造不正）。");
                        returnFocus();
                        return;
                    }

                    let consolidated = { expenses: [], settlements: [] };
                    validResults.forEach(r => {
                        consolidated = mergeDb(consolidated, r.data).merged;
                    });

                    fileReviewState = consolidated;
                    frEditingId = null;
                    frFileSummary = {
                        total: results.length,
                        valid: validResults.length,
                        invalidNames: invalidNames
                    };
                    renderFileReview();
                });
            };
            input.click();
        }

        let frFileSummary = null; // { total, valid, invalidNames }

        // 保存ファイル確認・整理モーダルの再描画
        function renderFileReview() {
            const settlementIds = new Set(fileReviewState.settlements.map(s => String(s.id)));
            const settlementsById = new Map(fileReviewState.settlements.map(s => [String(s.id), s]));
            const expenses = [...fileReviewState.expenses].sort((a, b) => b.date.localeCompare(a.date));

            let html = '';

            html += `<div style="margin-bottom: 15px; font-size: 16px; color: #666;">`;
            html += `読込ファイル：${frFileSummary.total} 件中 ${frFileSummary.valid} 件が有効`;
            if (frFileSummary.invalidNames.length > 0) {
                html += `（除外：${frFileSummary.invalidNames.map(n => escapeHtml(n)).join(', ')}）`;
            }
            html += `<br>統合後の内容（仮）：経費明細 ${fileReviewState.expenses.length} 件 / 精算履歴 ${fileReviewState.settlements.length} 件`;
            html += `</div>`;

            html += `<h3 style="margin: 20px 0 10px;">経費明細</h3>`;
            if (expenses.length === 0) {
                html += `<p class="empty-msg">経費明細はありません</p>`;
            }
            expenses.forEach(item => {
                const id = String(item.id);
                const isOrphan = item.settlement_id !== undefined && item.settlement_id !== null && !settlementIds.has(String(item.settlement_id));

                if (frEditingId === id) {
                    const paymentOptions = ['<option value="">（未選択）</option>']
                        .concat(PAYMENT_METHODS.map(p => `<option value="${escapeHtml(p)}" ${item.payment === p ? 'selected' : ''}>${escapeHtml(p)}</option>`))
                        .join('');
                    const taxRateOptions = ['<option value="">（未分類）</option>']
                        .concat(TAX_RATES.map(r => `<option value="${escapeHtml(r)}" ${item.taxRate === r ? 'selected' : ''}>${escapeHtml(r)}%</option>`))
                        .join('');
                    const hasParts = Array.isArray(item.taxParts) && item.taxParts.length > 0;
                    const amountAttrs = hasParts ? 'disabled' : '';
                    const taxRateAttrs = hasParts ? 'disabled' : '';

                    html += `<div class="detail-card">`;
                    html += `<div class="form-row" style="margin-bottom: 12px;">`;
                    html += `<div class="form-group"><label>日付</label><input type="date" id="fr-edit-date-${escapeHtml(id)}" value="${escapeHtml(item.date)}"></div>`;
                    html += `<div class="form-group"><label>利用先</label><input type="text" id="fr-edit-shop-${escapeHtml(id)}" value="${escapeHtml(item.shop)}" maxlength="${MAX_SHOP_LENGTH}"></div>`;
                    html += `<div class="form-group"><label>金額</label><input type="text" inputmode="numeric" id="fr-edit-amount-${escapeHtml(id)}" value="${item.amount.toLocaleString()}" ${amountAttrs}></div>`;
                    html += `</div>`;
                    html += `<div class="form-row" style="margin-bottom: 12px;">`;
                    html += `<div class="form-group"><label>摘要</label><input type="text" id="fr-edit-memo-${escapeHtml(id)}" value="${escapeHtml(item.memo || '')}" maxlength="${MAX_MEMO_LENGTH}"></div>`;
                    html += `<div class="form-group"><label>支払方法</label><select id="fr-edit-payment-${escapeHtml(id)}">${paymentOptions}</select></div>`;
                    html += `<div class="form-group"><label>税率</label><select id="fr-edit-taxrate-${escapeHtml(id)}" ${taxRateAttrs}>${taxRateOptions}</select></div>`;
                    html += `</div>`;
                    if (hasParts) {
                        const partsText = item.taxParts.map(p => `${escapeHtml(p.rate)}%：${p.amount.toLocaleString()}円`).join(' / ');
                        html += `<div style="font-size: 14px; color: #999; margin-bottom: 12px;">※分割税率（読み取り専用・編集不可）：${partsText}</div>`;
                    }
                    html += `<div class="detail-row-action">`;
                    html += `<button class="btn-reg fr-edit-save" data-id="${escapeHtml(id)}" style="padding: 10px 25px; font-size: 18px;">保存</button> `;
                    html += `<button class="btn-sub fr-edit-cancel">キャンセル</button>`;
                    html += `</div>`;
                    html += `</div>`;
                } else {
                    let taxText = '';
                    const parts = getTaxParts(item);
                    if (parts.length > 1 || (Array.isArray(item.taxParts) && item.taxParts.length > 0)) {
                        taxText = parts.map(p => `${p.rate}%対象${p.amount.toLocaleString()}`).join(' / ');
                    } else if (item.taxRate) {
                        taxText = `税率${escapeHtml(item.taxRate)}%`;
                    }
                    html += `<div class="detail-card">`;
                    html += `<div class="detail-row-main"><span>${escapeHtml(item.date)} ${escapeHtml(item.shop)}${isOrphan ? ' <span style="color:var(--del-color); font-size:14px; font-weight:normal;">⚠孤児（参照する精算履歴なし）</span>' : ''}</span><span class="detail-amount">${item.amount.toLocaleString()}</span></div>`;
                    html += `<div class="detail-row-sub">`;
                    html += `<span>${escapeHtml(item.memo || '（摘要なし）')}</span>`;
                    if (item.payment) html += `<span>${escapeHtml(item.payment)}</span>`;
                    if (taxText) html += `<span>${taxText}</span>`;
                    const isSettled = item.settlement_id !== undefined && item.settlement_id !== null;
                    if (isSettled) {
                        const relSettlement = settlementsById.get(String(item.settlement_id));
                        html += `<span>精算ID: ${escapeHtml((relSettlement && relSettlement.name) || String(item.settlement_id))}</span>`;
                    }
                    html += `</div>`;
                    html += `<div class="detail-row-action">`;
                    if (!isSettled) html += `<button class="btn-sub fr-edit-btn" data-id="${escapeHtml(id)}">編集</button> `;
                    html += `<button class="btn-del fr-del-btn" data-id="${escapeHtml(id)}">消去</button>`;
                    html += `</div>`;
                    html += `</div>`;
                }
            });

            html += `<h3 style="margin: 24px 0 10px;">精算履歴</h3>`;
            if (fileReviewState.settlements.length === 0) {
                html += `<p class="empty-msg">精算履歴はありません</p>`;
            } else {
                html += '<table><thead><tr><th>精算日</th><th>精算ID</th><th style="width:150px;">合計金額</th><th style="width:100px;">操作</th></tr></thead><tbody>';
                [...fileReviewState.settlements].sort((a, b) => b.date.localeCompare(a.date)).forEach(s => {
                    html += `<tr><td>${escapeHtml(s.date)}</td><td><span class="settle-id-link fr-settle-id-link" data-id="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</span></td><td class="amount">${s.total.toLocaleString()}</td><td style="text-align:center;"><button class="btn-del fr-settle-del-btn" data-id="${escapeHtml(s.id)}">消去</button></td></tr>`;
                });
                html += '</tbody></table>';
            }

            html += `<div style="margin-top: 24px; display: flex; gap: 15px; flex-wrap: wrap; justify-content: flex-end;">`;
            html += `<button class="btn-sub fr-export-btn">JSON書き出し</button>`;
            html += `<button class="btn-settle fr-merge-btn">統合読込</button>`;
            html += `</div>`;

            const frTitleEl = document.getElementById('modal-title');
            frTitleEl.innerText = '保存ファイル整理';
            frTitleEl.style.paddingRight = '70px';
            document.getElementById('modal-body').innerHTML = html;
            document.getElementById('modal').style.display = 'flex';
        }

        // working copy内の精算履歴1件の内訳を表示専用で表示（精算ID詳細と同構造、編集・消去は不可）
        function frShowSettlementDetail(sId) {
            const settlement = fileReviewState.settlements.find(s => String(s.id) === String(sId));
            const details = fileReviewState.expenses.filter(e => String(e.settlement_id) === String(sId));

            let html = `<div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; gap: 6px;">`;
            html += `<h3 style="margin:0; white-space:nowrap;">精算日: ${escapeHtml(settlement.date)}</h3>`;
            html += `<div style="font-size: 18px; color: #666; white-space:nowrap;">明細件数: ${details.length} 件</div>`;
            html += `</div>`;

            details.forEach(d => {
                const itemsHtml = (d.items && d.items.length > 0)
                    ? `<ul class="items-list">${d.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}</ul>`
                    : '';
                let taxText = '';
                const parts = getTaxParts(d);
                if (parts.length > 1 || (Array.isArray(d.taxParts) && d.taxParts.length > 0)) {
                    taxText = parts.map(p => `${p.rate}%対象${p.amount.toLocaleString()}`).join(' / ');
                } else if (d.taxRate) {
                    taxText = `税率${escapeHtml(d.taxRate)}%`;
                }
                html += `<div class="detail-card">`;
                html += `<div class="detail-row-main"><span>${escapeHtml(d.date)} ${escapeHtml(d.shop)}</span><span class="detail-amount">${d.amount.toLocaleString()}</span></div>`;
                html += `<div class="detail-row-sub">`;
                html += `<span>${escapeHtml(d.memo || '（摘要なし）')}${itemsHtml}</span>`;
                if (d.payment) html += `<span>${escapeHtml(d.payment)}</span>`;
                if (taxText) html += `<span>${taxText}</span>`;
                html += `</div>`;
                html += `</div>`;
            });

            html += `<div class="detail-summary"><span>合計</span><span>${settlement.total.toLocaleString()}</span></div>`;
            html += `<div style="margin-top: 20px;"><button class="btn-sub fr-back-btn">一覧へ戻る</button></div>`;

            const frTitleEl = document.getElementById('modal-title');
            frTitleEl.style.paddingRight = '70px';
            frTitleEl.innerHTML = `精算内訳 (<span style="white-space:nowrap;">${escapeHtml(sId)}</span>)<br><span style="font-size: 16px; color: #999; font-weight: normal;">（表内の金額の単位：円・表示のみ）</span>`;
            document.getElementById('modal-body').innerHTML = html;
        }

        // 編集モード開始（working copy内の対象明細を編集フォームに切替えて再描画）
        function frStartEdit(id) {
            frEditingId = id;
            renderFileReview();
        }

        // 編集内容を検証し、working copyへ反映
        function frSaveEdit(id) {
            const expense = fileReviewState.expenses.find(e => String(e.id) === id);
            if (!expense) return;

            const date = document.getElementById(`fr-edit-date-${id}`).value;
            const shop = document.getElementById(`fr-edit-shop-${id}`).value.trim();
            const memo = document.getElementById(`fr-edit-memo-${id}`).value.trim();
            const payment = document.getElementById(`fr-edit-payment-${id}`).value;
            const hasParts = Array.isArray(expense.taxParts) && expense.taxParts.length > 0;
            const taxRate = hasParts ? expense.taxRate : document.getElementById(`fr-edit-taxrate-${id}`).value;
            const amount = hasParts ? expense.amount : Number(document.getElementById(`fr-edit-amount-${id}`).value.replace(/[^\d]/g, ''));

            if (!date || !DATE_PATTERN.test(date)) {
                alert("日付はYYYY-MM-DD形式で入力してください。");
                return;
            }
            if (!shop) {
                alert("利用先を入力してください。");
                return;
            }
            if (!hasParts && (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT)) {
                alert(`金額は1以上${MAX_AMOUNT.toLocaleString()}以下の整数で入力してください。`);
                return;
            }

            const candidate = { ...expense, date, shop, amount, memo, payment, taxRate };
            if (!isValidExpense(candidate)) {
                alert("入力内容が正しくありません。日付・利用先・金額などを確認してください。");
                return;
            }

            Object.assign(expense, candidate);
            frEditingId = null;
            renderFileReview();
        }

        // working copyから経費明細を1件削除
        function frDeleteExpense(id) {
            if (!confirm("この明細を整理対象から消去します。よろしいですか？\n（書き出し・統合読込の対象から除外されます。元のファイルは変更されません）")) return;
            fileReviewState.expenses = fileReviewState.expenses.filter(e => String(e.id) !== id);
            if (frEditingId === id) frEditingId = null;
            renderFileReview();
        }

        // working copyから精算履歴を1件削除
        function frDeleteSettlement(id) {
            if (!confirm("この精算履歴を整理対象から消去します。よろしいですか？\n（参照する経費明細は「孤児」として表示されます）")) return;
            fileReviewState.settlements = fileReviewState.settlements.filter(s => String(s.id) !== id);
            renderFileReview();
        }

        // 整理済みデータを1つのJSONファイルとして書き出し
        function frExportConsolidated() {
            const blob = new Blob([JSON.stringify(fileReviewState, null, 2)], { type: 'application/json' });
            downloadBlob(blob, `expense_consolidated_${new Date().toISOString().split('T')[0]}.json`);
        }

        // 整理済みデータを現データへ統合（既存の「バックアップ統合」と同じ処理を再利用）
        function frMergeIntoCurrent() {
            const result = mergeDb(db, fileReviewState);

            let msg = "【統合プレビュー】\n";
            msg += `追加される経費明細：${result.addedExpenseCount} 件\n`;
            msg += `追加される精算履歴：${result.addedSettlementCount} 件\n`;
            if (result.skippedExpenseIds.length > 0) msg += `重複のためスキップされる経費明細：${result.skippedExpenseIds.length} 件\n`;
            if (result.skippedSettlementIds.length > 0) msg += `重複のためスキップされる精算履歴：${result.skippedSettlementIds.length} 件\n`;
            if (result.orphanExpenseIds.length > 0) msg += `\n※統合後、対応する精算履歴が見つからない「精算済」明細：${result.orphanExpenseIds.length} 件\n（統合後に内容を確認し、必要に応じて消去または編集調整をご検討ください）\n`;
            msg += "\nこの内容で統合しますか？\n（統合前に現在のデータは自動でバックアップとして保存されます）";

            if (!confirm(msg)) return;

            createBackup();
            db = result.merged;
            exitEditMode();
            resetForm();
            saveToStorage();
            render();

            if (result.orphanExpenseIds.length > 0) {
                const orphanList = db.expenses
                    .filter(ex => result.orphanExpenseIds.includes(String(ex.id)))
                    .map(ex => `・${ex.date} ${ex.shop} (${formatYen(ex.amount)})`)
                    .join('\n');
                alert(`統合が完了しました。\n\n以下の${result.orphanExpenseIds.length}件は「精算済」ですが、対応する精算履歴が見つかりません。\n内容を確認し、必要に応じて消去または編集調整をご検討ください。\n\n${orphanList}`);
            } else {
                alert("統合が完了しました。");
            }

            fileReviewState = null;
            frFileSummary = null;
            frEditingId = null;
            closeModal();
            returnFocus();
        }

        // localStorageに保存された自動バックアップ・破損データ退避の一覧をモーダル表示
        function showBackupManager() {
            const pinnedKeys = Object.keys(localStorage).filter(k => k.startsWith(PINNED_PREFIX)).sort().reverse();
            const normalKeys = Object.keys(localStorage)
                .filter(k => k.startsWith(BACKUP_PREFIX) || k.startsWith(CORRUPTED_PREFIX))
                .sort().reverse();

            let html = '';
            const totalCount = pinnedKeys.length + normalKeys.length;
            if (totalCount === 0) {
                html = '<p class="empty-msg">バックアップはありません</p>';
            } else {
                html += '<table><thead><tr><th>種類</th><th>作成日時</th><th style="width:260px;">操作</th></tr></thead><tbody>';
                // 固定バックアップを先に表示
                pinnedKeys.forEach(key => {
                    const ts = Number(key.slice(PINNED_PREFIX.length));
                    const dateStr = Number.isFinite(ts) ? new Date(ts).toLocaleString('ja-JP') : '-';
                    html += `<tr style="background:#fffbeb;">
                        <td>📌 固定バックアップ</td><td>${escapeHtml(dateStr)}</td><td class="backup-actions">
                        <button class="btn-sub backup-restore-btn" data-key="${escapeHtml(key)}">復元</button>
                        <button class="btn-sub backup-unpin-btn" data-key="${escapeHtml(key)}" style="background:#e0e7ff; color:#4338ca; border-color:#c7d2fe;">固定解除</button>
                        <button class="btn-del backup-delete-btn" data-key="${escapeHtml(key)}">削除</button>
                    </td></tr>`;
                });
                // 自動バックアップ・破損データ退避
                normalKeys.forEach(key => {
                    const isCorrupted = key.startsWith(CORRUPTED_PREFIX);
                    const ts = Number(key.slice(isCorrupted ? CORRUPTED_PREFIX.length : BACKUP_PREFIX.length));
                    const dateStr = Number.isFinite(ts) ? new Date(ts).toLocaleString('ja-JP') : '-';
                    const type = isCorrupted ? '破損データ退避' : '自動バックアップ';
                    html += `<tr><td>${escapeHtml(type)}</td><td>${escapeHtml(dateStr)}</td><td class="backup-actions">
                        <button class="btn-sub backup-restore-btn" data-key="${escapeHtml(key)}">復元</button>
                        ${isCorrupted ? '' : `<button class="btn-sub backup-pin-btn" data-key="${escapeHtml(key)}" style="background:#f59e0b; color:#fff; border-color:#f59e0b;">📌 固定</button>`}
                        <button class="btn-del backup-delete-btn" data-key="${escapeHtml(key)}">削除</button>
                    </td></tr>`;
                });
                html += '</tbody></table>';
            }
            html += `<p style="font-size:14px; color:#999; margin-top:15px;">※ 固定したバックアップは自動削除されません（最大${MAX_PINNED}件）。自動バックアップ・破損データ退避は種類ごとに最新${MAX_BACKUPS}件を保持します。</p>`;

            document.getElementById('modal-title').style.paddingRight = '';
            document.getElementById('modal-title').innerText = '自動保存管理';
            document.getElementById('modal-body').innerHTML = html;
            document.getElementById('modal').style.display = 'flex';
        }

        // 選択したバックアップで現在のデータを置き換える（実行前に現在のデータを自動バックアップ）
        function restoreBackup(key) {
            const data = localStorage.getItem(key);
            if (!data) {
                alert("バックアップが見つかりませんでした。");
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch (e) {
                alert("バックアップデータの形式が正しくありません（JSON解析エラー）。");
                return;
            }
            if (!isValidDb(parsed)) {
                alert("バックアップデータの構造が不正です。");
                return;
            }
            if (!confirm("現在のデータを、このバックアップで完全に置き換えます。\n（現在のデータは置き換え前に自動でバックアップとして保存されます）\n\nよろしいですか？")) return;

            createBackup();
            db = parsed;
            exitEditMode();
            resetForm();
            saveToStorage();
            render();
            closeModal();
            alert("バックアップから復元しました。");
        }

        // 選択したバックアップをlocalStorageから削除
        function deleteBackup(key) {
            if (!confirm("このバックアップを削除します。この操作は取り消せません。\n本当に削除しますか？")) return;
            localStorage.removeItem(key);
            showBackupManager();
        }

        // バックアップを固定（PINNED_PREFIXへ移動、pruneOldBackupsの対象外になる）
        function pinBackup(key) {
            const pinnedCount = Object.keys(localStorage).filter(k => k.startsWith(PINNED_PREFIX)).length;
            if (pinnedCount >= MAX_PINNED) {
                alert(`固定できるバックアップは最大${MAX_PINNED}件です。\n既存の固定を解除してから固定してください。`);
                return;
            }
            const data = localStorage.getItem(key);
            if (!data) { alert('バックアップが見つかりませんでした。'); return; }
            const ts = key.startsWith(BACKUP_PREFIX) ? key.slice(BACKUP_PREFIX.length) : key.slice(CORRUPTED_PREFIX.length);
            const pinnedKey = PINNED_PREFIX + ts;
            try {
                localStorage.setItem(pinnedKey, data);
                localStorage.removeItem(key);
                showBackupManager();
            } catch (_) {
                alert('ストレージ容量が不足しているため固定できませんでした。');
            }
        }

        // 固定バックアップを解除（BACKUP_PREFIXへ移動して自動バックアッププールに戻す）
        function unpinBackup(key) {
            const data = localStorage.getItem(key);
            if (!data) { alert('固定バックアップが見つかりませんでした。'); return; }
            const ts = key.slice(PINNED_PREFIX.length);
            const backupKey = BACKUP_PREFIX + ts;
            localStorage.setItem(backupKey, data);
            localStorage.removeItem(key);
            pruneOldBackups(BACKUP_PREFIX); // 戻した後で上限を超えた分を剪定
            showBackupManager();
        }

        // CSVインジェクション対策：数式と解釈される先頭文字をエスケープ
        function csvSafe(value) {
            const s = String(value);
            return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
        }

        function downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        function exportCSV() {
            if (db.expenses.length === 0) { alert("出力するデータがありません。"); return; }
            const settlementsById = new Map(db.settlements.map(s => [String(s.id), s]));
            let csvContent = "\ufeff日付,利用先,金額,10%対象額,8%対象額,摘要,支払方法,税率,精算状態,精算ID\n";
            [...db.expenses].sort((a, b) => b.date.localeCompare(a.date)).forEach(item => {
                let tax10Amount = 0, tax8Amount = 0;
                getTaxParts(item).forEach(p => {
                    if (p.rate === '10') tax10Amount = p.amount;
                    else if (p.rate === '8') tax8Amount = p.amount;
                });
                const taxRateLabel = Array.isArray(item.taxParts) && item.taxParts.length > 0
                    ? "複数税率"
                    : (item.taxRate ? item.taxRate + "%" : "");
                const row = [
                    csvSafe(item.date),
                    `"${csvSafe(item.shop).replace(/"/g, '""')}"`,
                    item.amount,
                    tax10Amount,
                    tax8Amount,
                    `"${csvSafe(item.memo || '').replace(/"/g, '""')}"`,
                    csvSafe(item.payment || ""),
                    csvSafe(taxRateLabel),
                    csvSafe(item.status),
                    csvSafe((settlementsById.get(String(item.settlement_id)) || {}).name || item.settlement_id || "")
                ];
                csvContent += row.join(",") + "\n";
            });
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            downloadBlob(blob, `経費明細_${new Date().toISOString().split('T')[0]}.csv`);
        }

        // csvSafe()の数式エスケープ（先頭に'を付与）を読込時に元へ戻す
        function csvUnescape(value) {
            return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
        }

        // RFC4180準拠の簡易CSVパーサ："..."で囲まれたフィールド内のカンマ・改行・""エスケープに対応
        function parseCSV(text) {
            const rows = [];
            let row = [];
            let field = '';
            let inQuotes = false;
            let i = 0;
            const len = text.length;
            while (i < len) {
                const c = text[i];
                if (inQuotes) {
                    if (c === '"') {
                        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                        inQuotes = false; i++; continue;
                    }
                    field += c; i++; continue;
                }
                if (c === '"') { inQuotes = true; i++; continue; }
                if (c === ',') { row.push(field); field = ''; i++; continue; }
                if (c === '\r') { i++; continue; }
                if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
                field += c; i++;
            }
            if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
            return rows.filter(r => !(r.length === 1 && r[0] === ''));
        }

        // CSVの1データ行（フィールド配列）からexpenseオブジェクトを再構築
        // 列：日付,利用先,金額,10%対象額,8%対象額,摘要,支払方法,税率,精算状態,精算ID（exportCSVの出力形式と対応）
        // 精算状態・精算IDはCSVに精算記録(settlements)が含まれないため復元せず、常に「未精算」として取り込む
        function csvRowToExpense(fields) {
            if (fields.length < 7) return null;
            const date = csvUnescape((fields[0] || '').trim());
            const shop = csvUnescape((fields[1] || '').trim());
            const amount = parseInt((fields[2] || '').trim(), 10);
            const tax10 = parseInt((fields[3] || '0').trim(), 10) || 0;
            const tax8 = parseInt((fields[4] || '0').trim(), 10) || 0;
            const memo = csvUnescape((fields[5] || '').trim());
            const payment = csvUnescape((fields[6] || '').trim());

            const expense = {
                id: generateId(),
                date: date,
                shop: shop,
                amount: amount,
                status: '未',
                memo: memo,
                payment: payment
            };
            if (tax10 > 0 && tax8 > 0) {
                expense.taxParts = [{ rate: '10', amount: tax10 }, { rate: '8', amount: tax8 }];
            } else if (tax10 > 0) {
                expense.taxRate = '10';
            } else if (tax8 > 0) {
                expense.taxRate = '8';
            }
            return expense;
        }

        // CSV読込：明細を新規IDで現在のデータへ追加（マージ）。精算記録は対象外のため全件「未精算」として追加
        // 取込前に自動バックアップを作成し、構造検証(isValidExpense)を通過した行のみ追加する
        function importCSV() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv,text/csv';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = event => {
                    let text = event.target.result;
                    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM除去
                    const rows = parseCSV(text);
                    if (rows.length === 0) {
                        alert("ファイルにデータがありません。読み込みを中止しました。");
                        returnFocus();
                        return;
                    }
                    const dataRows = rows.slice(1); // 先頭行はヘッダーとして除外
                    const addList = [];
                    let invalidCount = 0;
                    dataRows.forEach(fields => {
                        const expense = csvRowToExpense(fields);
                        if (expense && isValidExpense(expense)) {
                            addList.push(expense);
                        } else {
                            invalidCount++;
                        }
                    });
                    if (addList.length === 0) {
                        alert("取込可能な明細がありませんでした（形式が正しいCSVファイルかご確認ください）。読み込みを中止しました。");
                        returnFocus();
                        return;
                    }
                    const confirmMsg = invalidCount > 0
                        ? `${addList.length}件の明細を「未精算」として追加します（${invalidCount}件は形式が不正なためスキップされます）。\n（現在のデータは追加前に自動でバックアップとして保存されます）\n\nよろしいですか？`
                        : `${addList.length}件の明細を「未精算」として追加します。\n（現在のデータは追加前に自動でバックアップとして保存されます）\n\nよろしいですか？`;
                    if (!confirm(confirmMsg)) {
                        returnFocus();
                        return;
                    }
                    createBackup();
                    db.expenses.push(...addList);
                    saveToStorage();
                    render();
                    alert(`${addList.length}件の明細を追加しました。${invalidCount > 0 ? `（${invalidCount}件スキップ）` : ''}`);
                    returnFocus();
                };
                reader.readAsText(file);
            };
            input.click();
        }

        // xlsx-js-style（SheetJS+セル装飾）の遅延読込。初回呼び出し時のみ<script>注入、以降は同じPromiseを再利用
        let xlsxLoadPromise = null;
        function ensureXLSX() {
            if (typeof window.XLSX !== 'undefined') return Promise.resolve();
            if (xlsxLoadPromise) return xlsxLoadPromise;
            xlsxLoadPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'assets/vendor/xlsx-js-style.min.js';
                script.onload = () => resolve();
                script.onerror = () => { xlsxLoadPromise = null; reject(new Error('xlsx load failed')); };
                document.head.appendChild(script);
            });
            return xlsxLoadPromise;
        }

        // CSV出力と同じ税率テキスト化（複数税率は「複数税率」、単一は「N%」、無しは空文字）
        function taxRateText(item) {
            return Array.isArray(item.taxParts) && item.taxParts.length > 0
                ? '複数税率'
                : (item.taxRate ? item.taxRate + '%' : '');
        }

        // 印刷帳票の罫線方針（外枠太め#333・見出し網掛け#eee）に合わせたExcel書類用の共通セルスタイル
        const XLS_THIN = { style: 'thin', color: { rgb: '999999' } };
        const XLS_THICK = { style: 'medium', color: { rgb: '333333' } };
        const xlsStyle = {
            title: { font: { bold: true, sz: 14 }, alignment: { horizontal: 'center', vertical: 'center' } },
            meta: { font: { sz: 10 }, alignment: { horizontal: 'left', vertical: 'center' } },
            header: {
                font: { bold: true, sz: 10 },
                fill: { fgColor: { rgb: 'EEEEEE' }, patternType: 'solid' },
                alignment: { horizontal: 'center', vertical: 'center' },
                border: { top: XLS_THICK, bottom: XLS_THICK, left: XLS_THIN, right: XLS_THIN }
            },
            body: {
                font: { sz: 10 },
                alignment: { horizontal: 'left', vertical: 'center' },
                border: { top: XLS_THIN, bottom: XLS_THIN, left: XLS_THIN, right: XLS_THIN }
            },
            bodyNum: {
                font: { sz: 10 }, numFmt: '#,##0',
                alignment: { horizontal: 'right', vertical: 'center' },
                border: { top: XLS_THIN, bottom: XLS_THIN, left: XLS_THIN, right: XLS_THIN }
            },
            bodyCenterNum: {
                font: { sz: 10 },
                alignment: { horizontal: 'center', vertical: 'center' },
                border: { top: XLS_THIN, bottom: XLS_THIN, left: XLS_THIN, right: XLS_THIN }
            },
            bodyWrap: {
                font: { sz: 10 },
                alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
                border: { top: XLS_THIN, bottom: XLS_THIN, left: XLS_THIN, right: XLS_THIN }
            },
            total: { font: { bold: true, sz: 10 }, alignment: { horizontal: 'left', vertical: 'center' }, border: { top: XLS_THICK } },
            totalNum: { font: { bold: true, sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' }, border: { top: XLS_THICK } },
            approvalBox: {
                font: { sz: 10 },
                alignment: { horizontal: 'center', vertical: 'center' },
                border: { top: XLS_THICK, bottom: XLS_THIN, left: XLS_THIN, right: XLS_THIN }
            }
        };

        // 行r・列c0〜c1の各セルへ同一スタイルを適用するスタイル指定配列を生成（書類のヘッダー行・データ行で使用）
        function styleRow(r, c0, c1, style) {
            const out = [];
            for (let c = c0; c <= c1; c++) out.push({ r, c, style });
            return out;
        }

        // セル内容の表示幅（全角=2・半角=1）。数値は#,##0書式相当の桁区切り込みで近似
        function xlsCellWidth(v) {
            if (v == null || v === '') return 0;
            const s = (typeof v === 'number') ? v.toLocaleString('en-US') : String(v);
            let w = 0;
            for (const ch of s) w += /[^\x00-\xff]/.test(ch) ? 2 : 1;
            return w;
        }

        // 見出し行・データ行（widthRows）から列幅を自動算出（合計行・タイトル等の結合長文セルは含めない＝reference同様の列幅に近づける）
        function autoColWidths(widthRows, opts) {
            opts = opts || {};
            const min = opts.min != null ? opts.min : 8;
            const max = opts.max != null ? opts.max : 40;
            const pad = opts.pad != null ? opts.pad : 2;
            const cols = Math.max(...widthRows.map(r => r.length));
            const widths = new Array(cols).fill(0);
            widthRows.forEach(row => {
                row.forEach((cell, c) => {
                    const w = xlsCellWidth(cell);
                    if (w > widths[c]) widths[c] = w;
                });
            });
            return widths.map(w => ({ wch: Math.min(max, Math.max(min, w + pad)) }));
        }

        // ---- 最小限のZIPユーティリティ（vendorのxlsx-js-styleが!pageSetup/!printOptionsを書き出さないため、生成済みxlsxへ直接XML注入する） ----
        function xlsCrc32(bytes) {
            if (!xlsCrc32.table) {
                const t = new Uint32Array(256);
                for (let n = 0; n < 256; n++) {
                    let c = n;
                    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                    t[n] = c;
                }
                xlsCrc32.table = t;
            }
            let crc = 0 ^ -1;
            for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ xlsCrc32.table[(crc ^ bytes[i]) & 0xFF];
            return (crc ^ -1) >>> 0;
        }

        // ZIP中央ディレクトリを走査し、各エントリの圧縮済み生バイトをそのまま取り出す（再圧縮せず差し替え対象以外は無変更で再利用）
        function readZipEntries(buf) {
            const u8 = new Uint8Array(buf);
            const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            let eocd = -1;
            for (let i = u8.length - 22; i >= 0; i--) {
                if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
            }
            if (eocd < 0) throw new Error('ZIP EOCD not found');
            const entryCount = dv.getUint16(eocd + 10, true);
            let cdOffset = dv.getUint32(eocd + 16, true);
            const entries = [];
            for (let i = 0; i < entryCount; i++) {
                if (dv.getUint32(cdOffset, true) !== 0x02014b50) throw new Error('ZIP central directory signature mismatch');
                const method = dv.getUint16(cdOffset + 10, true);
                const modTime = dv.getUint16(cdOffset + 12, true);
                const modDate = dv.getUint16(cdOffset + 14, true);
                const crc = dv.getUint32(cdOffset + 16, true);
                const compSize = dv.getUint32(cdOffset + 20, true);
                const uncompSize = dv.getUint32(cdOffset + 24, true);
                const nameLen = dv.getUint16(cdOffset + 28, true);
                const extraLen = dv.getUint16(cdOffset + 30, true);
                const commentLen = dv.getUint16(cdOffset + 32, true);
                const localOffset = dv.getUint32(cdOffset + 42, true);
                const name = new TextDecoder().decode(u8.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
                const lfNameLen = dv.getUint16(localOffset + 26, true);
                const lfExtraLen = dv.getUint16(localOffset + 28, true);
                const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
                const data = u8.slice(dataStart, dataStart + compSize);
                entries.push({ name, method, modTime, modDate, crc, data, uncompSize });
                cdOffset += 46 + nameLen + extraLen + commentLen;
            }
            return entries;
        }

        // ZIPの生deflate展開（ZIP仕様のdeflateはraw＝zlibヘッダ無し）。ブラウザ標準APIのみ使用（外部ライブラリ不要）
        async function inflateRawZip(bytes) {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        }

        // entries配列から新規ZIPを再構築（差し替え対象は無圧縮store、他は元の圧縮バイトをそのまま再利用）
        function buildZip(entries) {
            const enc = new TextEncoder();
            const localParts = [];
            const centralParts = [];
            let offset = 0;
            entries.forEach(e => {
                const nameBytes = enc.encode(e.name);
                const lf = new Uint8Array(30 + nameBytes.length);
                const lv = new DataView(lf.buffer);
                lv.setUint32(0, 0x04034b50, true);
                lv.setUint16(4, 20, true);
                lv.setUint16(6, 0, true);
                lv.setUint16(8, e.method, true);
                lv.setUint16(10, e.modTime, true);
                lv.setUint16(12, e.modDate, true);
                lv.setUint32(14, e.crc, true);
                lv.setUint32(18, e.data.length, true);
                lv.setUint32(22, e.uncompSize, true);
                lv.setUint16(26, nameBytes.length, true);
                lv.setUint16(28, 0, true);
                lf.set(nameBytes, 30);
                localParts.push(lf, e.data);

                const cd = new Uint8Array(46 + nameBytes.length);
                const cv = new DataView(cd.buffer);
                cv.setUint32(0, 0x02014b50, true);
                cv.setUint16(4, 20, true);
                cv.setUint16(6, 20, true);
                cv.setUint16(8, 0, true);
                cv.setUint16(10, e.method, true);
                cv.setUint16(12, e.modTime, true);
                cv.setUint16(14, e.modDate, true);
                cv.setUint32(16, e.crc, true);
                cv.setUint32(20, e.data.length, true);
                cv.setUint32(24, e.uncompSize, true);
                cv.setUint16(28, nameBytes.length, true);
                cv.setUint16(30, 0, true);
                cv.setUint16(32, 0, true);
                cv.setUint16(34, 0, true);
                cv.setUint16(36, 0, true);
                cv.setUint32(38, 0, true);
                cv.setUint32(42, offset, true);
                cd.set(nameBytes, 46);
                centralParts.push(cd);

                offset += lf.length + e.data.length;
            });
            const centralStart = offset;
            const centralSize = centralParts.reduce((s, c) => s + c.length, 0);
            const eocd = new Uint8Array(22);
            const ev = new DataView(eocd.buffer);
            ev.setUint32(0, 0x06054b50, true);
            ev.setUint16(8, entries.length, true);
            ev.setUint16(10, entries.length, true);
            ev.setUint32(12, centralSize, true);
            ev.setUint32(16, centralStart, true);
            const all = [...localParts, ...centralParts, eocd];
            const total = all.reduce((s, p) => s + p.length, 0);
            const out = new Uint8Array(total);
            let pos = 0;
            all.forEach(p => { out.set(p, pos); pos += p.length; });
            return out;
        }

        // 完成済みxlsx（ZIP）のxl/worksheets/sheet1.xmlへ<pageSetup>・<printOptions>を直接注入する
        // （vendorのxlsx-js-styleはws['!pageSetup']/ws['!printOptions']を実測で無視するための回避策。OOXMLスキーマ順：printOptions→pageMargins→pageSetup）
        async function injectPageSetup(zipArrayBuffer, scale, centered) {
            const entries = readZipEntries(zipArrayBuffer);
            const sheetEntry = entries.find(e => e.name === 'xl/worksheets/sheet1.xml');
            const xmlBytes = sheetEntry.method === 8 ? await inflateRawZip(sheetEntry.data) : sheetEntry.data;
            let xml = new TextDecoder().decode(xmlBytes);
            const pageSetupTag = `<pageSetup paperSize="9" orientation="portrait"${scale && scale !== 100 ? ` scale="${scale}"` : ''}/>`;
            const printOptionsTag = centered ? '<printOptions horizontalCentered="1"/>' : '';
            xml = xml.replace(/<pageMargins[^/]*\/>/, (m) => `${printOptionsTag}${m}${pageSetupTag}`);
            const newBytes = new TextEncoder().encode(xml);
            sheetEntry.data = newBytes;
            sheetEntry.method = 0;
            sheetEntry.uncompSize = newBytes.length;
            sheetEntry.crc = xlsCrc32(newBytes);
            return buildZip(entries);
        }

        // 印刷用情報（社員ID・氏名・申請日）。DOM入力欄の現在値をそのまま使用（db・localStorageには保存されない）
        function getPrintInfoForExcel() {
            const empidOn = document.getElementById('print-empid-toggle').checked;
            const nameOn = document.getElementById('print-name-toggle').checked;
            const empid = empidOn ? document.getElementById('print-empid').value.trim() : '';
            const name = nameOn ? document.getElementById('print-name').value.trim() : '';
            const manual = document.getElementById('print-date-manual').checked;
            const manualDate = document.getElementById('print-date').value;
            const dateStr = (manual && manualDate) ? manualDate : new Date().toISOString().split('T')[0];
            return { empid, name, dateJP: formatDateJP(dateStr) };
        }

        // 帳票A（未精算明細）のExcel書類データを組み立て。データ源・並び順はbuildPrintTables()と同一
        function buildExcelAoaUnpaid() {
            const data = db.expenses.filter(e => e.status === "未").sort(getSortComparator('date', 'shop'));
            const info = getPrintInfoForExcel();
            const cols = 6;
            const aoa = [];
            const merges = [];
            const styles = [];

            aoa.push(['経費精算明細書', '', '', '', '', '']);
            merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: cols - 1 } });
            styles.push({ r: 0, c: 0, style: xlsStyle.title });

            aoa.push([`社員ID：${info.empid}　氏名：${info.name}`, '', '', '', '', '']);
            merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: cols - 1 } });
            styles.push({ r: 1, c: 0, style: xlsStyle.meta });

            aoa.push([`申請日：${info.dateJP}　対象件数：${data.length}件`, '', '', '', '', '']);
            merges.push({ s: { r: 2, c: 0 }, e: { r: 2, c: cols - 1 } });
            styles.push({ r: 2, c: 0, style: xlsStyle.meta });

            const headerRow = 3;
            const headerVals = ['日付', '利用先', '摘要', '支払方法', '税率', '金額（円）'];
            aoa.push(headerVals);
            styles.push(...styleRow(headerRow, 0, cols - 1, xlsStyle.header));
            const widthRows = [headerVals];

            let total = 0;
            data.forEach((item, i) => {
                const r = headerRow + 1 + i;
                total += item.amount;
                const rowVals = [formatDateJP(item.date), item.shop, item.memo || '', item.payment || '', taxRateText(item), item.amount];
                aoa.push(rowVals);
                widthRows.push(rowVals);
                styles.push(...styleRow(r, 0, cols - 2, xlsStyle.body));
                styles.push({ r, c: cols - 1, style: xlsStyle.bodyNum });
            });

            const totalRow = headerRow + 1 + data.length;
            aoa.push(['合計', '', '', '', '', total]);
            merges.push({ s: { r: totalRow, c: 0 }, e: { r: totalRow, c: cols - 2 } });
            styles.push(...styleRow(totalRow, 0, cols - 2, xlsStyle.total));
            styles.push({ r: totalRow, c: cols - 1, style: xlsStyle.totalNum });

            const colWidths = autoColWidths(widthRows);
            const margins = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
            return { aoa, merges, styles, cols: colWidths, margins, pageSetup: { scale: 100, centered: false } };
        }

        // 帳票C（精算履歴一覧）のExcel書類データ。データ源・並び順はbuildPrintTables()と同一
        function buildExcelAoaHistory() {
            const data = [...db.settlements].sort(getSortComparator('date', 'name'));
            const info = getPrintInfoForExcel();
            const cols = 4;
            const aoa = [];
            const merges = [];
            const styles = [];

            aoa.push(['精算履歴一覧', '', '', '']);
            merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: cols - 1 } });
            styles.push({ r: 0, c: 0, style: xlsStyle.title });

            aoa.push([`社員ID：${info.empid}　氏名：${info.name}`, '', '', '']);
            merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: cols - 1 } });
            styles.push({ r: 1, c: 0, style: xlsStyle.meta });

            aoa.push([`作成日：${info.dateJP}　件数：${data.length}回`, '', '', '']);
            merges.push({ s: { r: 2, c: 0 }, e: { r: 2, c: cols - 1 } });
            styles.push({ r: 2, c: 0, style: xlsStyle.meta });

            const headerRow = 3;
            const headerVals = ['精算日', '精算ID', '明細件数', '合計金額（円）'];
            aoa.push(headerVals);
            styles.push(...styleRow(headerRow, 0, cols - 1, xlsStyle.header));
            const widthRows = [headerVals];

            data.forEach((s, i) => {
                const r = headerRow + 1 + i;
                const count = db.expenses.filter(e => e.settlement_id === s.id).length;
                const rowVals = [formatDateJP(s.date), s.name || s.id, count, s.total];
                aoa.push(rowVals);
                widthRows.push(rowVals);
                styles.push({ r, c: 0, style: xlsStyle.body });
                styles.push({ r, c: 1, style: xlsStyle.body });
                styles.push({ r, c: 2, style: xlsStyle.bodyCenterNum });
                styles.push({ r, c: 3, style: xlsStyle.bodyNum });
            });

            const colWidths = autoColWidths(widthRows);
            const margins = { left: 0.70866141732283472, right: 0.70866141732283472, top: 0.74803149606299213, bottom: 0.74803149606299213, header: 0.31496062992125984, footer: 0.31496062992125984 };
            return { aoa, merges, styles, cols: colWidths, margins, pageSetup: { scale: 135, centered: true } };
        }

        // 帳票B（経費精算書・精算単位）のExcel書類データ。データ源・並び順・列順はshowDetail()の印刷帳票と同一
        function buildExcelAoaSettlement(sId) {
            const details = db.expenses.filter(e => e.settlement_id === sId);
            const settlement = db.settlements.find(s => s.id === sId);
            const info = getPrintInfoForExcel();
            const showApprover = document.getElementById('print-show-approver').checked;
            const showConfirm = document.getElementById('print-show-confirm').checked;
            const showApprove = document.getElementById('print-show-approve').checked;
            const showAccounting = document.getElementById('print-show-accounting').checked;
            const cols = 8;
            const aoa = [];
            const merges = [];
            const styles = [];

            aoa.push(['経費精算書', '', '', '', '', '', '', '']);
            merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: cols - 1 } });
            styles.push({ r: 0, c: 0, style: xlsStyle.title });

            let metaText = `社員ID：${info.empid}　氏名：${info.name}　申請日：${info.dateJP}`;
            if (showApprover) metaText += '　承認者：　　　　　';
            aoa.push([metaText, '', '', '', '', '', '', '']);
            merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: cols - 1 } });
            styles.push({ r: 1, c: 0, style: xlsStyle.meta });

            // 対象期間／提出区分／精算ID（印刷帳票のprint-meta-tableに対応するラベル・値の3対）
            let periodText = '-';
            if (details.length) {
                const dates = details.map(d => d.date).sort();
                const from = formatDateJP(dates[0]);
                const to = formatDateJP(dates[dates.length - 1]);
                periodText = from === to ? from : `${from} 〜 ${to}`;
            }
            const metaRow = 2;
            aoa.push(['対象期間', periodText, '', '提出区分', '□月次／□未提出分／□急ぎ', '', '精算ID', settlement.name || sId]);
            merges.push({ s: { r: metaRow, c: 1 }, e: { r: metaRow, c: 2 } });
            merges.push({ s: { r: metaRow, c: 4 }, e: { r: metaRow, c: 5 } });
            [0, 3, 6].forEach(c => styles.push({ r: metaRow, c, style: xlsStyle.header }));
            [1, 7].forEach(c => styles.push({ r: metaRow, c, style: xlsStyle.body }));
            styles.push({ r: metaRow, c: 4, style: xlsStyle.bodyWrap });

            const headerRow = 3;
            const headerVals = ['利用日', '支払先', '内容', '金額', '支払', '税率', 'インボイス登録番号', '領収書番号・備考'];
            aoa.push(headerVals);
            styles.push(...styleRow(headerRow, 0, cols - 1, xlsStyle.header));
            const widthRows = [headerVals];

            let total = 0, totalTax = 0;
            const sorted = [...details].sort(getSortComparator('date', 'shop'));
            sorted.forEach((d, i) => {
                const r = headerRow + 1 + i;
                total += d.amount;
                getTaxParts(d).forEach(p => {
                    const tax = calcTax(p.amount, p.rate);
                    if (tax) totalTax += tax.tax;
                });
                const rowVals = [formatDateJP(d.date), d.shop, d.memo || '', d.amount, d.payment || '', taxCategoryLabel(d), d.invoice || '', ''];
                aoa.push(rowVals);
                widthRows.push(rowVals);
                [0, 1, 2, 4, 5, 6, 7].forEach(c => styles.push({ r, c, style: xlsStyle.body }));
                styles.push({ r, c: 3, style: xlsStyle.bodyNum });
            });

            const totalRow = headerRow + 1 + sorted.length;
            aoa.push(['合計', '', '', total, '', '', '', '']);
            merges.push({ s: { r: totalRow, c: 0 }, e: { r: totalRow, c: 2 } });
            merges.push({ s: { r: totalRow, c: 4 }, e: { r: totalRow, c: 7 } });
            styles.push(...styleRow(totalRow, 0, 2, xlsStyle.total));
            styles.push({ r: totalRow, c: 3, style: xlsStyle.totalNum });
            styles.push(...styleRow(totalRow, 4, 7, xlsStyle.total));

            const taxRow = totalRow + 1;
            aoa.push(['うち消費税額（10%/8%対象・切り捨て参考値）', '', '', totalTax, '', '', '', '']);
            merges.push({ s: { r: taxRow, c: 0 }, e: { r: taxRow, c: 2 } });
            merges.push({ s: { r: taxRow, c: 4 }, e: { r: taxRow, c: 7 } });
            styles.push(...styleRow(taxRow, 0, 2, xlsStyle.body));
            styles.push({ r: taxRow, c: 3, style: xlsStyle.bodyNum });
            styles.push(...styleRow(taxRow, 4, 7, xlsStyle.body));

            // 承認欄（確認印／承認印／経理処理印）。表示選択されたものだけを等分割で配置
            const approvalLabels = [];
            if (showConfirm) approvalLabels.push('確認印');
            if (showApprove) approvalLabels.push('承認印');
            if (showAccounting) approvalLabels.push('経理処理印');
            if (approvalLabels.length) {
                const approvalRow = taxRow + 1;
                const seg = Math.floor(cols / approvalLabels.length);
                const rowVals = new Array(cols).fill('');
                approvalLabels.forEach((label, i) => {
                    const c0 = i * seg;
                    const c1 = (i === approvalLabels.length - 1) ? cols - 1 : c0 + seg - 1;
                    rowVals[c0] = label;
                    if (c1 > c0) merges.push({ s: { r: approvalRow, c: c0 }, e: { r: approvalRow, c: c1 } });
                    styles.push(...styleRow(approvalRow, c0, c1, xlsStyle.approvalBox));
                });
                aoa.push(rowVals);
            }

            const colWidths = autoColWidths(widthRows);
            const margins = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
            return { aoa, merges, styles, cols: colWidths, margins, pageSetup: { scale: 75, centered: false } };
        }

        // doc.pageSetupがある場合のみZIP直接注入（!pageSetup/!printOptionsをvendorが無視するための回避策）を経由する。無圧縮の.xlsxはExcel/LibreOffice双方で問題なく開ける
        async function downloadExcelAoa(doc, filename, sheetName) {
            const ws = XLSX.utils.aoa_to_sheet(doc.aoa);
            ws['!cols'] = doc.cols;
            ws['!merges'] = doc.merges;
            if (doc.margins) ws['!margins'] = doc.margins;
            doc.styles.forEach(({ r, c, style }) => {
                const addr = XLSX.utils.encode_cell({ r, c });
                if (!ws[addr]) ws[addr] = { t: 's', v: '' };
                ws[addr].s = style;
            });
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
            let out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
            if (doc.pageSetup) {
                out = await injectPageSetup(out, doc.pageSetup.scale, doc.pageSetup.centered);
            }
            downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
        }

        // Excel出力は印刷時の微調整（用紙・余白の最終確認）をExcel側で行う前提のため、セッション内最初の出力時のみ案内する
        let excelTipShown = false;
        function showExcelTipOnce() {
            if (excelTipShown) return;
            excelTipShown = true;
            alert('Excelファイルを出力しました。\n印刷時の微調整は直接Excelで行ってください。');
        }

        // 帳票A/B/CのExcel書類出力。kind: 'unpaid' | 'history' | 'settlement'（settlementはsId必須）
        function exportExcel(kind, sId) {
            let doc, filename, sheetName;
            if (kind === 'unpaid') {
                if (db.expenses.filter(e => e.status === "未").length === 0) { alert("出力する未精算データがありません。"); return; }
                doc = buildExcelAoaUnpaid();
                filename = `経費精算明細書_${new Date().toISOString().split('T')[0]}.xlsx`;
                sheetName = '経費精算明細書';
            } else if (kind === 'history') {
                if (db.settlements.length === 0) { alert("出力する精算履歴がありません。"); return; }
                doc = buildExcelAoaHistory();
                filename = `精算履歴一覧_${new Date().toISOString().split('T')[0]}.xlsx`;
                sheetName = '精算履歴一覧';
            } else if (kind === 'settlement') {
                doc = buildExcelAoaSettlement(sId);
                const settlement = db.settlements.find(s => s.id === sId);
                filename = `経費精算書_${(settlement && (settlement.name || sId)) || sId}.xlsx`;
                sheetName = '経費精算書';
            } else {
                return;
            }
            ensureXLSX().then(() => downloadExcelAoa(doc, filename, sheetName))
                .then(() => showExcelTipOnce())
                .catch(() => alert('Excel機能の読込に失敗しました。通信環境をご確認のうえ再度お試しください。'));
        }

        function exportData(label) {
            const blob = new Blob([JSON.stringify(db, null, 2)], {type: 'application/json'});
            downloadBlob(blob, backupFilename(label));
        }

        // 補足ラベルからファイル名禁則文字・制御文字を除去し、前後空白除去・文字数上限で切り詰め
        function sanitizeLabel(label) {
            return String(label || '')
                .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
                .trim()
                .slice(0, MAX_LABEL_LENGTH);
        }

        // 保存ファイル名（日付＋補足ラベル）を組み立て
        function backupFilename(label) {
            const safeLabel = sanitizeLabel(label);
            return `expense_backup_${new Date().toISOString().split('T')[0]}${safeLabel ? '_' + safeLabel : ''}.json`;
        }

        // 「データ保存（バックアップ）」：補足ラベル入力・ファイル名プレビュー・保存先設定ガイドを表示
        function openSaveDialog() {
            const savedLabel = sanitizeLabel(localStorage.getItem('save_label') || '');

            let html = '';
            html += `<div class="form-group">
                <label for="save-label-input">補足ラベル（任意・PC名など。例：自宅PC）</label>
                <input type="text" id="save-label-input" maxlength="${MAX_LABEL_LENGTH}" value="${escapeHtml(savedLabel)}" placeholder="例：自宅PC">
            </div>`;
            html += `<p>保存ファイル名：<strong id="save-filename-preview">${escapeHtml(backupFilename(savedLabel))}</strong></p>`;
            html += `<div style="background:#f5f5f5; border-radius:8px; padding:12px; font-size:14px;">
                <strong>保存先の確認・設定方法</strong>
                <ul style="margin:8px 0 0; padding-left:20px;">
                    <li>毎回保存先を選びたい場合：ブラウザ設定「ダウンロード時に保存先を確認する」をON</li>
                    <li>いつも同じ場所に保存したい場合：ブラウザの既定のダウンロード先を変更（例：ネットワークドライブ）</li>
                    <li style="color:#999;">※ 保存先の指定・確認は本機能では不可（ブラウザ側設定のご案内）</li>
                    ${autoSaveSupported() ? '<li>毎回の手動保存を省略したい場合：「データ保存」上部の「フォルダへの自動保存を設定」もご利用いただけます</li>' : ''}
                </ul>
            </div>`;
            html += `<div style="margin-top:15px; text-align:right;"><button class="btn-reg save-exec-btn">この名前で保存</button></div>`;

            document.getElementById('modal-title').style.paddingRight = '';
            document.getElementById('modal-title').innerText = 'データ保存（バックアップ）';
            document.getElementById('modal-body').innerHTML = html;
            document.getElementById('modal').style.display = 'flex';

            const labelInput = document.getElementById('save-label-input');
            const preview = document.getElementById('save-filename-preview');
            labelInput.addEventListener('input', () => {
                preview.textContent = backupFilename(labelInput.value);
            });
            labelInput.focus();
        }

        function importData() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = event => {
                    let parsed;
                    try {
                        parsed = JSON.parse(event.target.result);
                    } catch (err) {
                        alert("ファイルの形式が正しくありません（JSON解析エラー）。読み込みを中止しました。");
                        returnFocus();
                        return;
                    }
                    if (!isValidDb(parsed)) {
                        alert("ファイルのデータ構造が不正です。読み込みを中止しました。");
                        returnFocus();
                        return;
                    }
                    if (!confirm("現在のデータを、読み込んだデータで完全に置き換えます。\n（現在のデータは置き換え前に自動でバックアップとして保存されます）\n\nよろしいですか？")) {
                        returnFocus();
                        return;
                    }
                    createBackup();
                    db = parsed;
                    exitEditMode();
                    resetForm();
                    saveToStorage();
                    render();
                    alert("データを読み込みました。");
                    returnFocus();
                };
                reader.readAsText(file);
            };
            input.click();
        }

        // 他のバックアップJSONを現在のデータへ統合（重複IDはスキップ、置き換えではなく追加）
        function importMergeData() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = event => {
                    let parsed;
                    try {
                        parsed = JSON.parse(event.target.result);
                    } catch (err) {
                        alert("ファイルの形式が正しくありません（JSON解析エラー）。読み込みを中止しました。");
                        returnFocus();
                        return;
                    }
                    if (!isValidDb(parsed)) {
                        alert("ファイルのデータ構造が不正です。読み込みを中止しました。");
                        returnFocus();
                        return;
                    }

                    const result = mergeDb(db, parsed);

                    let msg = "【統合プレビュー】\n";
                    msg += `追加される経費明細：${result.addedExpenseCount} 件\n`;
                    msg += `追加される精算履歴：${result.addedSettlementCount} 件\n`;
                    if (result.skippedExpenseIds.length > 0) msg += `重複のためスキップされる経費明細：${result.skippedExpenseIds.length} 件\n`;
                    if (result.skippedSettlementIds.length > 0) msg += `重複のためスキップされる精算履歴：${result.skippedSettlementIds.length} 件\n`;
                    if (result.orphanExpenseIds.length > 0) msg += `\n※統合後、対応する精算履歴が見つからない「精算済」明細：${result.orphanExpenseIds.length} 件\n（統合後に内容を確認し、必要に応じて消去または編集調整をご検討ください）\n`;
                    msg += "\nこの内容で統合しますか？\n（統合前に現在のデータは自動でバックアップとして保存されます）";

                    if (!confirm(msg)) {
                        returnFocus();
                        return;
                    }

                    createBackup();

                    db = result.merged;
                    exitEditMode();
                    resetForm();
                    saveToStorage();
                    render();

                    if (result.orphanExpenseIds.length > 0) {
                        const orphanList = db.expenses
                            .filter(ex => result.orphanExpenseIds.includes(String(ex.id)))
                            .map(ex => `・${ex.date} ${ex.shop} (${formatYen(ex.amount)})`)
                            .join('\n');
                        alert(`統合が完了しました。\n\n以下の${result.orphanExpenseIds.length}件は「精算済」ですが、対応する精算履歴が見つかりません。\n内容を確認し、必要に応じて消去または編集調整をご検討ください。\n\n${orphanList}`);
                    } else {
                        alert("統合が完了しました。");
                    }
                    returnFocus();
                };
                reader.readAsText(file);
            };
            input.click();
        }

        function clearAll() {
            if (!confirm("【警告】すべてのデータを完全に消去します。よろしいですか？")) {
                returnFocus();
                return;
            }
            if (confirm("消去前に現在のデータをバックアップ（JSONファイル）として保存しますか？")) {
                exportData();
            }
            if (!confirm("最終確認：すべてのデータを消去します。この操作は取り消せません。\n本当に実行しますか？")) {
                returnFocus();
                return;
            }
            db = { expenses: [], settlements: [] };
            exitEditMode();
            resetForm();
            saveToStorage();
            render();
            returnFocus();
        }
