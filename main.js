document.addEventListener('DOMContentLoaded', async () => {
    // 1. Supabase Configuration
    const SUPABASE_URL = 'https://rqdwpnddynwjgekopiea.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxZHdwbmRkeW53amdla29waWVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4MzQ3MzcsImV4cCI6MjA4NjQxMDczN30.i431TCpDpYQ6wObMnr62iRiqF6tyDj5hRGk73ZPFe4Y';

    // Supabase 클라이언트 초기화
    const { createClient } = supabase;
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

    let currentUser = null;
    let isInitialLoading = false;
    const authOverlay = document.getElementById('auth-overlay');
    const authMsg = document.getElementById('auth-msg');

    // 동기화 상태 표시 헬퍼
    function setSyncStatus(status, message) {
        const indicator = document.getElementById('sync-status-indicator');
        if (!indicator) return;
        indicator.className = 'sync-status ' + status;
        indicator.innerHTML = `<span></span> ${message}`;
        console.log(`[Sync Status] ${status.toUpperCase()}: ${message}`);
    }

    // State Management
    let state = {
        transactions: [],
        categories: {
            expense: ['식비', '생활', '교통', '여가'],
            savings: ['적금', '투자', '비상금']
        },
        logs: [],
        issues: [],
        viewDates: {
            account: new Date().toISOString().slice(0, 7),
            life: new Date().toISOString().slice(0, 7),
            detail: new Date().toISOString().slice(0, 7)
        },
        detailData: {}, // { 'YYYY-MM': { personal: [], shared: [], budgets: { personal: 0, shared: 0 } } }
        pinnedItems: { personal: [], shared: [] }, // 모든 달에 상단 고정되는 항목
        weddingCosts: [
            { id: 'group1', title: '', items: [] },
            { id: 'group2', title: '', items: [] },
            { id: 'group3', title: '', items: [] }
        ],
        weddingGifts: [] // [{ id, name, received, isPartner, hasMeal }]
    };

    // 로컬 데이터 먼저 불러오기
    const localData = localStorage.getItem('life-state');
    if (localData) {
        const parsed = JSON.parse(localData);
        // 구버전 detailData (personal:[], shared:[]) 형식을 새 형식으로 마이그레이션
        let migratedDetail = parsed.detailData || {};
        if (Array.isArray(migratedDetail.personal)) {
            const today = new Date().toISOString().slice(0, 7);
            migratedDetail = {
                [today]: {
                    personal: migratedDetail.personal,
                    shared: migratedDetail.shared || [],
                    budgets: migratedDetail.budgets || { personal: 0, shared: 0 }
                }
            };
        }
        state = { ...state, ...parsed, detailData: migratedDetail };
        state.pinnedItems = {
            personal: parsed.pinnedItems?.personal || [],
            shared: parsed.pinnedItems?.shared || []
        };
        // Wedding data migration/init
        state.weddingCosts = parsed.weddingCosts || [
            { id: 'group1', title: '', items: [] },
            { id: 'group2', title: '', items: [] },
            { id: 'group3', title: '', items: [] }
        ];
        state.weddingGifts = parsed.weddingGifts || parsed.weddingData || [];
        state.viewDates = {
            account: new Date().toISOString().slice(0, 7),
            life: new Date().toISOString().slice(0, 7),
            detail: new Date().toISOString().slice(0, 7)
        };
    }

    // Supabase에서 데이터 불러오기
    async function loadFromCloud() {
        if (!currentUser) {
            setSyncStatus('offline', '로그인 필요');
            return;
        }
        isInitialLoading = true;
        setSyncStatus('loading', '데이터 불러오는 중...');

        try {
            // 여러 컬럼을 한 번에 조회
            const { data, error } = await supabaseClient
                .from('user_categories')
                .select('expense, income, savings')
                .eq('user_id', currentUser.id)
                .maybeSingle();

            if (error) {
                if (error.code === 'PGRST204') {
                    setSyncStatus('error', '서버 점검 중 (SQL 실행 필요)');
                } else {
                    setSyncStatus('error', '연동 실패');
                }
                throw error;
            }

            if (data) {
                // 각 컬럼에서 데이터를 파싱하여 state에 반영
                const cloudExpense = data.expense ? JSON.parse(data.expense) : {};
                // income, savings 컬럼은 현재 구조상 expense JSON 내부에 포함되어 있을 수 있으므로
                // 전체를 병합하는 방식으로 처리합니다.
                state = {
                    ...state,
                    ...cloudExpense,
                    detailData: { ...state.detailData, ...(cloudExpense.detailData || {}) }
                };

                saveToLocal();
                refreshAllUI();
                setSyncStatus('online', '클라우드 연동 완료');
            } else {
                setSyncStatus('online', '새 데이터 (클라우드 비어있음)');
            }
        } catch (e) {
            console.error("❌ 데이터 불러오기 실패:", e);
        } finally {
            isInitialLoading = false;
        }
    }

    function saveToLocal() {
        localStorage.setItem('life-state', JSON.stringify(state));
    }

    async function saveState() {
        saveToLocal();
        updateStats();

        if (!currentUser) return;
        if (isInitialLoading) return;

        setSyncStatus('loading', '백업 중...');
        try {
            // 현재 테이블 구조에 맞춰 expense, income, savings 컬럼에 각각 데이터 분산 저장
            // (기존의 전체 state를 expense에 넣되, 구조 상 가시성을 위해 나중에 분리 가능)
            const { error } = await supabaseClient
                .from('user_categories')
                .upsert(
                    {
                        user_id: currentUser.id,
                        expense: JSON.stringify(state),
                        income: JSON.stringify(state.transactions?.filter(t => t.type === 'income') || []),
                        savings: JSON.stringify(state.transactions?.filter(t => t.type === 'savings') || [])
                    },
                    { onConflict: 'user_id' }
                );

            if (error) throw error;
            setSyncStatus('online', '저장 완료');
        } catch (e) {
            setSyncStatus('error', '백업 실패');
            console.error("❌ 저장 실패:", e);
        }
    }

    window.manualSync = () => loadFromCloud();

    function refreshAllUI() {
        refreshCalendars();
        renderCategoryGrids();
        renderIssues();
        renderStockList();
        renderWeddingCosts();
        renderWeddingGifts();
        renderDetailTables(); // 상세가계부 렌더링 추가
        updateStats();
    }

    // 보안을 위한 문자열 이스케이프 함수 (XSS 방어)
    function safeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.addWeddingGiftRow = () => {
        state.weddingGifts.push({ id: crypto.randomUUID(), name: '', received: 0, isPartner: false, hasMeal: false });
        saveState();
        renderWeddingGifts();
    };

    // Tab Navigation
    const tabs = document.querySelectorAll('.tab-btn');
    const navItems = []; // Mobile bottom nav removed
    const contents = document.querySelectorAll('.tab-content');

    window.switchTab = (tabId) => {
        // 모든 활성 상태 초기화
        tabs.forEach(t => t.classList.remove('active'));
        navItems.forEach(n => n.classList.remove('active'));
        contents.forEach(c => c.classList.remove('active'));

        // 해당 탭 활성화
        const targetContent = document.getElementById(tabId);
        if (targetContent) targetContent.classList.add('active');

        // 상세가계부 탭 클릭 시 즉시 렌더링
        if (tabId === 'detail') renderDetailTables();
        if (tabId === 'wedding') { renderWeddingCosts(); renderWeddingGifts(); }

        // 상단 버튼 동기화
        tabs.forEach(t => {
            if (t.dataset.tab === tabId || t.getAttribute('onclick')?.includes(tabId)) {
                t.classList.add('active');
            }
        });
    };

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.dataset.tab;
            switchTab(tabId);
        });
    });

    // --- Statistics & Charts ---
    let expenseChart, savingsChart;

    function updateStats() {
        const currentMonth = state.viewDates.account;

        // 상세가계부 합계 계산 (모든 달 합산 - 전체통계용)
        let totalDetailPersonal = 0;
        let totalDetailShared = 0;

        // 고정 항목(pinnedItems)은 모든 달에 공통으로 적용되므로, 데이터가 있는 각 달마다 합산해줍니다.
        const pinnedPersonalTotal = (state.pinnedItems?.personal || []).reduce((sum, item) => sum + (item.amount || 0), 0);
        const pinnedSharedTotal = (state.pinnedItems?.shared || []).reduce((sum, item) => sum + (item.amount || 0), 0);
        const pinnedTotal = pinnedPersonalTotal + pinnedSharedTotal;

        const detailMonths = Object.keys(state.detailData || {});
        detailMonths.forEach(monthKey => {
            const mData = state.detailData[monthKey];
            totalDetailPersonal += (mData.personal || []).reduce((sum, item) => sum + (item.amount || 0), 0);
            totalDetailShared += (mData.shared || []).reduce((sum, item) => sum + (item.amount || 0), 0);
            // 해당 달에 고정 항목만큼의 지출이 발생한 것으로 간주
            totalDetailPersonal += pinnedPersonalTotal;
            totalDetailShared += pinnedSharedTotal;
        });

        // 이번 달 상세가계부 합계 (가계부 탭용)
        const currentDetailData = state.detailData[currentMonth] || { personal: [], shared: [] };
        const currentDetailPersonal = (currentDetailData.personal || []).reduce((sum, item) => sum + (item.amount || 0), 0) + pinnedPersonalTotal;
        const currentDetailShared = (currentDetailData.shared || []).reduce((sum, item) => sum + (item.amount || 0), 0) + pinnedSharedTotal;
        const currentMonthDetailExpense = currentDetailPersonal + currentDetailShared;

        // 전체 통계용 (All Time)
        const totalIncome = state.transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
        const totalBaseExpense = state.transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
        const totalExpense = totalBaseExpense + totalDetailPersonal + totalDetailShared;
        const totalSavings = state.transactions.filter(t => t.type === 'savings').reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('total-income').textContent = `${totalIncome.toLocaleString()}원`;
        document.getElementById('total-expense').textContent = `${totalExpense.toLocaleString()}원`;
        document.getElementById('total-savings').textContent = `${totalSavings.toLocaleString()}원`;

        // 총 보유자산
        const totalAsset = state.transactions.filter(t => t.type === 'asset').reduce((sum, t) => sum + t.amount, 0);
        const totalAssetStatsEl = document.getElementById('total-asset-stats');
        if (totalAssetStatsEl) totalAssetStatsEl.textContent = `${totalAsset.toLocaleString()}원`;

        // 이번 달 통계용 (가계부 탭)
        const monthlyIncome = state.transactions.filter(t => t.type === 'income' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);
        const monthlyBaseExpense = state.transactions.filter(t => t.type === 'expense' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);
        const monthlyExpense = monthlyBaseExpense + currentMonthDetailExpense;
        const monthlySavings = state.transactions.filter(t => t.type === 'savings' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('acc-monthly-income').textContent = `${monthlyIncome.toLocaleString()}원`;
        document.getElementById('acc-monthly-expense').textContent = `${monthlyExpense.toLocaleString()}원`;
        document.getElementById('acc-monthly-savings').textContent = `${monthlySavings.toLocaleString()}원`;

        const monthlyBalance = monthlyIncome - monthlyExpense - monthlySavings;
        const balanceEl = document.getElementById('acc-monthly-balance');
        const assetEl = document.getElementById('acc-total-asset');
        if (balanceEl) balanceEl.textContent = `${monthlyBalance.toLocaleString()}원`;
        if (assetEl) assetEl.textContent = `${totalAsset.toLocaleString()}원`;

        updateCharts(totalExpense, totalSavings, totalDetailPersonal, totalDetailShared);
    }

    function updateCharts(totalExpense, totalSavings, detailPersonal, detailShared) {
        const getCtx = (id) => {
            const el = document.getElementById(id);
            return el ? el.getContext('2d') : null;
        };

        const formatLabels = (data, total) => {
            return data.map(d => {
                const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
                return `${d.name} (${pct}%)`;
            });
        };

        // 소비 데이터 취합 (카테고리별 + 상세가계부 합산)
        const expenseData = state.categories.expense.map(cat => ({
            name: cat,
            value: state.transactions.filter(t => t.type === 'expense' && t.cat === cat).reduce((sum, t) => sum + t.amount, 0)
        }));

        if (detailPersonal > 0) expenseData.push({ name: '상세(개인)', value: detailPersonal });
        if (detailShared > 0) expenseData.push({ name: '상세(공용)', value: detailShared });

        const savingsData = state.categories.savings.map(cat => ({
            name: cat,
            value: state.transactions.filter(t => t.type === 'savings' && t.cat === cat).reduce((sum, t) => sum + t.amount, 0)
        }));

        const medianCutColors = [
            '#644ca2', // Purple
            '#3e77e9', // Blue
            '#ff5952', // Red/Coral
            '#4fc775', // Green
            '#ffd656', // Yellow
            '#8b5cf6', // Extended: Light Purple
            '#3b82f6', // Extended: Light Blue
            '#ef4444'  // Extended: Light Red
        ];

        const chartConfig = (labels, dataValues) => ({
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: dataValues,
                    backgroundColor: medianCutColors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                let label = context.label || '';
                                if (label) label += ': ';
                                if (context.parsed !== undefined) {
                                    label += context.parsed.toLocaleString() + '%';
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });

        const exCtx = getCtx('expense-chart');
        if (exCtx) {
            if (expenseChart) expenseChart.destroy();
            const labels = formatLabels(expenseData, totalExpense);
            const values = expenseData.map(d => totalExpense > 0 ? Math.round((d.value / totalExpense) * 100) : 0);
            expenseChart = new Chart(exCtx, chartConfig(labels, values));
        }

        const svCtx = getCtx('savings-chart');
        if (svCtx) {
            if (savingsChart) savingsChart.destroy();
            const labels = formatLabels(savingsData, totalSavings);
            const values = savingsData.map(d => totalSavings > 0 ? Math.round((d.value / totalSavings) * 100) : 0);
            savingsChart = new Chart(svCtx, chartConfig(labels, values));
        }
    }

    // --- Calendar Implementation ---
    function renderCalendar(containerId, type) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const [year, month] = state.viewDates[type].split('-').map(Number);

        const header = document.createElement('div');
        header.className = 'calendar-header';
        header.innerHTML = `
            <h3>${year}년 ${month}월 <button class="date-picker-btn">📅</button><input type="month" class="hidden-date-input" value="${state.viewDates[type]}"></h3>
            <div class="nav-controls"><button class="nav-btn prev-btn">&#8249;</button><button class="nav-btn next-btn">&#8250;</button></div>
        `;
        header.querySelector('.prev-btn').onclick = () => changeMonth(type, -1);
        header.querySelector('.next-btn').onclick = () => changeMonth(type, 1);
        const dateInput = header.querySelector('.hidden-date-input');
        header.querySelector('.date-picker-btn').onclick = () => dateInput.showPicker();
        dateInput.onchange = (e) => { state.viewDates[type] = e.target.value; saveState(); refreshCalendars(); renderCategoryGrids(); };
        container.appendChild(header);

        const grid = document.createElement('div'); grid.className = 'calendar-grid';
        ['일', '월', '화', '수', '목', '금', '토'].forEach(d => { const h = document.createElement('div'); h.className = 'calendar-day-head'; h.textContent = d; grid.appendChild(h); });

        const first = new Date(year, month - 1, 1).getDay();
        const days = new Date(year, month, 0).getDate();
        for (let i = 0; i < first; i++) grid.appendChild(document.createElement('div'));

        const now = new Date();
        for (let d = 1; d <= days; d++) {
            const dayEl = document.createElement('div');
            dayEl.className = 'calendar-day';
            const fullDate = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            dayEl.innerHTML = `<span>${d}</span><div class="day-content"></div>`;
            const contentDiv = dayEl.querySelector('.day-content');

            if (type === 'account') {
                const dayTrans = state.transactions.filter(t => t.date === fullDate);
                const inc = dayTrans.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
                const exp = dayTrans.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
                const sav = dayTrans.filter(t => t.type === 'savings').reduce((s, t) => s + t.amount, 0);
                if (inc > 0) contentDiv.innerHTML += `<div class="day-label label-income">+${inc.toLocaleString()}</div>`;
                if (exp > 0) contentDiv.innerHTML += `<div class="day-label label-expense">-${exp.toLocaleString()}</div>`;
                if (sav > 0) contentDiv.innerHTML += `<div class="day-label label-savings">S:${sav.toLocaleString()}</div>`;

                // 가계부 내역이 있으면 클릭 가능하게 설정
                if (dayTrans.length > 0) {
                    dayEl.classList.add('clickable-day');
                    dayEl.onclick = () => openAccountDayModal(fullDate);
                }
            } else {
                // Issues Rendering
                const dayIssues = state.issues.filter(i => i.date === fullDate);
                dayIssues.forEach(issue => {
                    contentDiv.innerHTML += `<div class="day-label label-issue ${issue.checked ? 'checked' : ''}">${issue.text}</div>`;
                });

                // Life Logs Rendering
                const dayLogs = state.logs.filter(l => l.date === fullDate);
                dayLogs.forEach(log => {
                    contentDiv.innerHTML += `<div class="day-label label-life">${log.item}(${log.qty})</div>`;
                });

                // Make day clickable if there's any content
                if (dayIssues.length > 0 || dayLogs.length > 0) {
                    dayEl.classList.add('clickable-day');
                    dayEl.onclick = () => openLifeDayModal(fullDate);
                }
            }
            if (year === now.getFullYear() && month === (now.getMonth() + 1) && d === now.getDate()) dayEl.classList.add('today');
            grid.appendChild(dayEl);
        }
        container.appendChild(grid);
    }

    function changeMonth(type, delta) {
        let [y, m] = state.viewDates[type].split('-').map(Number);
        m += delta; i = 0; if (m > 12) { y++; m = 1; } if (m < 1) { y--; m = 12; }
        state.viewDates[type] = `${y}-${String(m).padStart(2, '0')}`;
        saveState(); refreshCalendars(); renderCategoryGrids();
    }

    function refreshCalendars() {
        renderCalendar('account-calendar', 'account');
        renderCalendar('life-calendar', 'life');
        updateDayInputMax();
        renderIssues();
    }

    function updateDayInputMax() {
        if (!state.viewDates.life) return;
        const [year, month] = state.viewDates.life.split('-').map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const issueDayInput = document.getElementById('new-issue-day');
        const lifeDayInput = document.getElementById('life-day');
        if (issueDayInput) issueDayInput.max = daysInMonth;
        if (lifeDayInput) lifeDayInput.max = daysInMonth;
    }

    // --- Category Card System ---
    let draggedItem = null; let draggedType = null;
    function renderCategoryGrids() {
        const renderGrid = (type, id) => {
            const grid = document.getElementById(id); if (!grid) return; grid.innerHTML = '';
            state.categories[type].forEach((cat, index) => {
                const amount = state.transactions.filter(t => t.type === type && t.cat === cat && t.date.startsWith(state.viewDates.account)).reduce((s, t) => s + t.amount, 0);
                const card = document.createElement('div'); card.className = 'category-card'; card.draggable = true; card.dataset.index = index; card.dataset.type = type;
                card.innerHTML = `<button class="card-delete-btn" title="삭제">&times;</button><span class="cat-name">${cat}</span><span class="cat-amount">${amount.toLocaleString()}원</span>`;
                card.ondragstart = (e) => { draggedItem = index; draggedType = type; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
                card.ondragend = () => { card.classList.remove('dragging'); document.querySelectorAll('.category-grid').forEach(g => g.classList.remove('drag-over')); };
                card.ondragover = (e) => { e.preventDefault(); if (draggedType === type) grid.classList.add('drag-over'); };
                card.ondrop = (e) => { e.preventDefault(); if (draggedType === type && draggedItem !== null) { const [moved] = state.categories[type].splice(draggedItem, 1); state.categories[type].splice(index, 0, moved); saveState(); renderCategoryGrids(); } draggedItem = null; draggedType = null; };
                card.onclick = (e) => { if (e.target.classList.contains('card-delete-btn')) { if (confirm(`'${cat}' 카테고리를 삭제하시겠습니까?`)) { state.categories[type] = state.categories[type].filter(c => c !== cat); state.transactions = state.transactions.filter(t => !(t.type === type && t.cat === cat)); saveState(); renderCategoryGrids(); refreshCalendars(); } } else { openModal(cat, type); } };
                grid.appendChild(card);
            });
        };
        renderGrid('expense', 'expense-category-grid'); renderGrid('savings', 'savings-category-grid');
    }

    document.getElementById('add-expense-cat').onclick = () => { const n = prompt('새 소비 카테고리 이름:'); if (n && !state.categories.expense.includes(n)) { state.categories.expense.push(n); saveState(); renderCategoryGrids(); } };
    document.getElementById('add-savings-cat').onclick = () => { const n = prompt('새 저축 카테고리 이름:'); if (n && !state.categories.savings.includes(n)) { state.categories.savings.push(n); saveState(); renderCategoryGrids(); } };

    // --- Modal Logic ---
    const modal = document.getElementById('entry-modal');
    const closeBtn = document.querySelector('.close-modal');
    const saveBtn = document.getElementById('save-entry');

    document.getElementById('acc-income-card').onclick = () => openModal('수입', 'income');
    document.getElementById('acc-asset-card').onclick = () => openModal('자산', 'asset');

    function openModal(category, type) {
        currentModalTarget = { category, type };
        document.getElementById('modal-title').textContent = `${category} - 내역 추가`;
        document.getElementById('modal-date').value = `${state.viewDates.account}-01`;
        document.getElementById('modal-name').value = '';
        document.getElementById('modal-amount').value = '';

        // 소비/저축 카테고리인 경우만 이름 변경 버튼 표시
        const renameBtn = document.getElementById('btn-rename-cat');
        if (type === 'expense' || type === 'savings') {
            renameBtn.style.display = 'block';
        } else {
            renameBtn.style.display = 'none';
        }

        modal.classList.add('active');
        renderModalHistory();
    }

    function closeModal() { modal.classList.remove('active'); }
    closeBtn.onclick = closeModal;
    window.onclick = (e) => { if (e.target === modal) closeModal(); if (e.target === document.getElementById('life-day-modal')) document.getElementById('life-day-modal').classList.remove('active'); };

    saveBtn.onclick = () => {
        const d = document.getElementById('modal-date').value, n = document.getElementById('modal-name').value, a = parseInt(document.getElementById('modal-amount').value) || 0;
        if (d && n && a > 0) {
            if (currentModalTarget.type === 'wedding') {
                const group = state.weddingCosts.find(g => g.id === currentModalTarget.category);
                if (group) {
                    group.items.push({ id: crypto.randomUUID(), detail: n, amount: a, memo: '' });
                }
            } else {
                state.transactions.push({ id: Date.now(), date: d, name: n, cat: currentModalTarget.category, amount: a, type: currentModalTarget.type });
            }
            saveState(); renderModalHistory(); refreshCalendars(); renderCategoryGrids(); renderWeddingCosts(); updateWeddingSummary(); document.getElementById('modal-name').value = ''; document.getElementById('modal-amount').value = '';
        }
    };

    document.getElementById('btn-rename-cat').onclick = () => {
        const oldId = currentModalTarget.category;
        const type = currentModalTarget.type;

        if (type === 'wedding') {
            const group = state.weddingCosts.find(g => g.id === oldId);
            const newName = prompt('항목 이름을 입력하세요:', group.title);
            if (newName && newName !== group.title) {
                group.title = newName;
                document.getElementById('modal-title').textContent = `${newName} - 내역 추가`;
                saveState(); renderWeddingCosts();
            }
            return;
        }

        const oldName = oldId;
        const newName = prompt('새 카테고리 이름을 입력하세요:', oldName);
        if (newName && newName !== oldName) {
            if (state.categories[type].includes(newName)) {
                alert('이미 존재하는 카테고리 이름입니다.');
                return;
            }
            const idx = state.categories[type].indexOf(oldName);
            if (idx !== -1) state.categories[type][idx] = newName;
            state.transactions.forEach(t => { if (t.type === type && t.cat === oldName) t.cat = newName; });
            currentModalTarget.category = newName;
            document.getElementById('modal-title').textContent = `${newName} - 내역 추가`;
            saveState(); refreshAllUI();
        }
    };

    function renderModalHistory() {
        const list = document.getElementById('modal-entry-list');
        list.innerHTML = '';

        if (currentModalTarget.type === 'wedding') {
            const group = state.weddingCosts.find(g => g.id === currentModalTarget.category);
            if (!group) return;
            group.items.forEach((entry, idx) => {
                const item = document.createElement('div'); item.className = 'mini-entry';
                item.innerHTML = `
                    <div class="entry-info">
                        <strong>${entry.detail || '제목 없음'}</strong>
                        <span class="entry-date">${entry.memo || ''}</span>
                    </div>
                    <div class="entry-actions">
                        <span class="amount-text">${(entry.amount || 0).toLocaleString()}원</span>
                        <button class="delete-btn" title="삭제">&times;</button>
                    </div>
                `;
                item.querySelector('.delete-btn').onclick = () => {
                    if (confirm('이 내역을 삭제하시겠습니까?')) {
                        group.items.splice(idx, 1);
                        saveState(); renderModalHistory(); renderWeddingCosts(); updateWeddingSummary();
                    }
                };
                list.appendChild(item);
            });
            return;
        }

        const entries = state.transactions.filter(t => {
            const isMatchCat = (t.cat === currentModalTarget.category);
            const isMatchIncome = (currentModalTarget.type === 'income' && t.type === 'income');
            const isMatchAsset = (currentModalTarget.type === 'asset' && t.type === 'asset');
            const isMonthMatch = t.date.startsWith(state.viewDates.account);
            if (currentModalTarget.type === 'asset') return (isMatchCat || isMatchAsset) && t.type === currentModalTarget.type;
            return (isMatchCat || isMatchIncome || isMatchAsset) && t.type === currentModalTarget.type && isMonthMatch;
        });
        entries.sort((a, b) => b.id - a.id).forEach(entry => {
            const item = document.createElement('div'); item.className = 'mini-entry';
            item.innerHTML = `
                <div class="entry-info">
                    <strong>${entry.name}</strong>
                    <span class="entry-date">${entry.date}</span>
                </div>
                <div class="entry-actions">
                    <span class="amount-text">${entry.amount.toLocaleString()}원</span>
                    <button class="delete-btn" title="삭제">&times;</button>
                </div>
            `;
            item.querySelector('.delete-btn').onclick = () => { if (confirm('이 내역을 삭제하시겠습니까?')) { state.transactions = state.transactions.filter(t => t.id !== entry.id); saveState(); renderModalHistory(); refreshCalendars(); renderCategoryGrids(); } };
            list.appendChild(item);
        });
    }

    // --- Account Day Modal ---
    function openAccountDayModal(date) {
        const modal = document.getElementById('acc-day-modal');
        document.getElementById('acc-day-title').textContent = `${date} 상세 내역`;
        renderAccountDayContent(date);
        modal.classList.add('active');
    }

    function renderAccountDayContent(date) {
        const list = document.getElementById('acc-day-list');
        list.innerHTML = '';
        const dayTrans = state.transactions.filter(t => t.date === date);

        if (dayTrans.length === 0) {
            list.innerHTML = '<p style="color:var(--text-light); font-size:0.9rem;">기록된 내역이 없습니다.</p>';
        } else {
            dayTrans.forEach(t => {
                const item = document.createElement('div');
                item.className = 'detailed-log-item';
                // 타입별 색상 클래스 결정
                let typeColorClass = '';
                if (t.type === 'income') typeColorClass = 'income-text';
                else if (t.type === 'expense') typeColorClass = 'expense-text';
                else if (t.type === 'savings') typeColorClass = 'savings-text';

                item.innerHTML = `
                    <div class="log-main">
                        <div class="log-header">
                            <strong>[${t.cat}] ${t.name}</strong>
                        </div>
                        <div class="log-amount ${typeColorClass}">${t.type === 'income' ? '+' : '-'}${t.amount.toLocaleString()}원</div>
                    </div>
                    <div class="log-actions">
                        <button class="action-icon-btn delete" title="삭제">❌</button>
                    </div>
                `;
                item.querySelector('.delete').onclick = () => {
                    if (confirm('이 내역을 삭제하시겠습니까?')) {
                        state.transactions = state.transactions.filter(tr => tr.id !== t.id);
                        saveState();
                        renderAccountDayContent(date);
                        refreshCalendars();
                        updateStats();
                        renderCategoryGrids();
                    }
                };
                list.appendChild(item);
            });
        }
    }

    // --- Life Day Modal ---
    function openLifeDayModal(date) {
        const modal = document.getElementById('life-day-modal');
        document.getElementById('life-day-title').textContent = `${date} 상세 내역`;
        renderLifeDayContent(date);
        modal.classList.add('active');
    }

    function renderLifeDayContent(date) {
        const logList = document.getElementById('life-day-log-list');
        const issueList = document.getElementById('life-day-issue-list');
        logList.innerHTML = '';
        issueList.innerHTML = '';

        const dayIssues = state.issues.filter(i => i.date === date);
        const dayLogs = state.logs.filter(l => l.date === date);

        if (dayIssues.length === 0 && dayLogs.length === 0) {
            document.getElementById('life-day-modal').classList.remove('active');
            refreshCalendars();
            return;
        }

        // Render Issues
        if (dayIssues.length === 0) {
            issueList.innerHTML = '<p style="color:var(--text-light); font-size:0.9rem;">등록된 이슈가 없습니다.</p>';
        } else {
            dayIssues.forEach(issue => {
                const item = document.createElement('div');
                item.className = `detailed-issue-item ${issue.checked ? 'checked' : ''}`;
                item.innerHTML = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <input type="checkbox" ${issue.checked ? 'checked' : ''}>
                        <span class="text-content">${issue.text}</span>
                    </div>
                    <div class="log-actions">
                        <button class="action-icon-btn edit" title="수정">✏️</button>
                        <button class="action-icon-btn delete" title="삭제">❌</button>
                    </div>
                `;
                item.querySelector('input').onchange = () => {
                    issue.checked = !issue.checked;
                    saveState();
                    renderLifeDayContent(date);
                    refreshCalendars();
                    renderIssues();
                };
                item.querySelector('.edit').onclick = () => {
                    const t = prompt('이슈 수정:', issue.text);
                    if (t) {
                        issue.text = t;
                        saveState();
                        renderLifeDayContent(date);
                        refreshCalendars();
                        renderIssues();
                    }
                };
                item.querySelector('.delete').onclick = () => {
                    if (confirm('이 이슈를 삭제하시겠습니까?')) {
                        state.issues = state.issues.filter(i => i.id !== issue.id);
                        saveState();
                        renderLifeDayContent(date);
                        refreshCalendars();
                        renderIssues();
                    }
                };
                issueList.appendChild(item);
            });
        }

        // Render Logs
        if (dayLogs.length === 0) {
            logList.innerHTML = '<p style="color:var(--text-light); font-size:0.9rem;">등록된 기록이 없습니다.</p>';
        } else {
            dayLogs.forEach(log => {
                const item = document.createElement('div');
                item.className = 'detailed-log-item';
                item.innerHTML = `
                    <div class="log-main">
                        <div class="log-header"><strong>${log.item}</strong> <span>수량: ${log.qty}</span></div>
                        <div class="log-amount">금액: ${parseInt(log.amount || 0).toLocaleString()}원</div>
                    </div>
                    <div class="log-actions">
                        <button class="action-icon-btn edit" title="수정">✏️</button>
                        <button class="action-icon-btn delete" title="삭제">❌</button>
                    </div>
                `;
                item.querySelector('.edit').onclick = () => {
                    const newItem = prompt('내용 수정:', log.item);
                    const newQty = prompt('수량 수정:', log.qty);
                    const newAmount = prompt('금액 수정:', log.amount || 0);
                    if (newItem !== null && newQty !== null) {
                        log.item = newItem; log.qty = newQty; log.amount = newAmount;
                        saveState(); renderLifeDayContent(date); refreshCalendars();
                    }
                };
                item.querySelector('.delete').onclick = () => {
                    if (confirm('이 기록을 삭제하시겠습니까?')) {
                        state.logs = state.logs.filter(l => l.id !== log.id);
                        saveState(); renderLifeDayContent(date); refreshCalendars();
                    }
                };
                logList.appendChild(item);
            });
        }
    }

    // --- Life Monthly & Issues ---
    function renderIssues() {
        const list = document.getElementById('issue-list'); if (!list) return; list.innerHTML = '';
        const currentMonth = state.viewDates.life;
        state.issues
            .filter(issue => !issue.date || issue.date.startsWith(currentMonth))
            .forEach(issue => {
                const li = document.createElement('li'); li.className = `todo-item ${issue.checked ? 'checked' : ''}`;
                li.innerHTML = `
                <input type="checkbox" ${issue.checked ? 'checked' : ''}> 
                <span>${issue.date ? `<small style="color:var(--text-light); margin-right:5px;">${issue.date.slice(5)}</small>` : ''} <span class="text-content">${issue.text}</span></span>
                <div class="todo-actions">
                    <button class="action-icon-btn edit" title="수정">
                        ✏️
                    </button>
                    <button class="action-icon-btn delete" title="삭제">
                        ❌
                    </button>
                </div>
            `;
                li.querySelector('input').onchange = () => { issue.checked = !issue.checked; saveState(); renderIssues(); };
                li.querySelector('.edit').onclick = () => { const t = prompt('이슈 수정:', issue.text); if (t) { issue.text = t; saveState(); renderIssues(); } };
                li.querySelector('.delete').onclick = () => { if (confirm('이 이슈를 삭제하시겠습니까?')) { state.issues = state.issues.filter(i => i.id !== issue.id); saveState(); renderIssues(); refreshCalendars(); } };
                list.appendChild(li);
            });
    }

    function renderStockList() {
        const listBody = document.getElementById('stock-list-body');
        if (!listBody) return;
        listBody.innerHTML = '';

        // inStock이 true인 항목들만 필터링 (날짜순 정렬)
        const stockItems = state.logs
            .filter(log => log.inStock)
            .sort((a, b) => b.date.localeCompare(a.date));

        if (stockItems.length === 0) {
            listBody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-light); padding:2rem;">보유중인 품목이 없습니다.</td></tr>';
            return;
        }

        stockItems.forEach(item => {
            const tr = document.createElement('tr');
            // 날짜 포맷 (MM-DD)
            const dateStr = item.date.slice(5);
            tr.innerHTML = `
                <td>${dateStr}</td>
                <td style="font-weight:600;">${item.item}</td>
                <td>${item.qty}</td>
                <td>${parseInt(item.amount || 0).toLocaleString()}원</td>
                <td><button class="delete-stock-btn">삭제</button></td>
            `;

            tr.querySelector('.delete-stock-btn').onclick = () => {
                if (confirm('보유목록에서 이 항목을 삭제하시겠습니까?\n(달력 기록은 유지됩니다.)')) {
                    const target = state.logs.find(l => l.id === item.id);
                    if (target) {
                        target.inStock = false;
                        saveState();
                        renderStockList();
                    }
                }
            };
            listBody.appendChild(tr);
        });
    }

    document.getElementById('add-issue').onclick = () => {
        const text = document.getElementById('new-issue').value;
        const day = document.getElementById('new-issue-day').value;
        if (text && day) {
            const date = `${state.viewDates.life}-${String(day).padStart(2, '0')}`;
            state.issues.push({ id: Date.now(), text, date, checked: false });
            document.getElementById('new-issue').value = '';
            document.getElementById('new-issue-day').value = '';
            saveState(); renderIssues(); refreshCalendars();
        } else if (!day) {
            alert('날짜(일)를 입력해주세요.');
        }
    };

    document.getElementById('add-life-log').onclick = () => {
        const day = document.getElementById('life-day').value;
        const i = document.getElementById('life-item').value;
        const q = document.getElementById('life-qty').value;
        const a = document.getElementById('life-amount').value;

        if (day && i && q) {
            const date = `${state.viewDates.life}-${String(day).padStart(2, '0')}`;
            state.logs.push({ id: Date.now(), date: date, item: i, qty: q, amount: a || 0, inStock: true });
            document.getElementById('life-day').value = '';
            document.getElementById('life-item').value = '';
            document.getElementById('life-qty').value = '';
            document.getElementById('life-amount').value = '';
            saveState(); refreshCalendars(); renderStockList(); alert('기록되었습니다!');
        } else if (!day) {
            alert('날짜(일)를 입력해주세요.');
        }
    };

    // --- Auth Logic ---
    supabaseClient.auth.onAuthStateChange((event, session) => {
        if (session) {
            currentUser = session.user;
            authOverlay.classList.remove('active');
            document.getElementById('btn-logout').style.display = 'block';
            document.getElementById('btn-reset-all').style.display = 'block';
            loadFromCloud();
        } else {
            currentUser = null;
            authOverlay.classList.add('active');
            document.getElementById('btn-logout').style.display = 'none';
            document.getElementById('btn-reset-all').style.display = 'none';
            // 로그아웃 시 상태 초기화 (원하는 경우)
            resetState();
            refreshAllUI();
        }
    });

    document.getElementById('btn-logout').onclick = async () => {
        if (confirm('로그아웃 하시겠습니까?')) {
            const { error } = await supabaseClient.auth.signOut();
            if (error) console.error("로그아웃 실패:", error);
            else {
                console.log("👋 로그아웃 되었습니다.");
                location.reload(); // 로그아웃 후 페이지 새로고침으로 깔끔하게 초기화
            }
        }
    };

    function resetState() {
        state = {
            transactions: [],
            categories: {
                expense: ['식비', '생활', '교통', '여가'],
                savings: ['적금', '투자', '비상금']
            },
            logs: [],
            issues: [],
            viewDates: {
                account: new Date().toISOString().slice(0, 7),
                life: new Date().toISOString().slice(0, 7),
                detail: new Date().toISOString().slice(0, 7)
            },
            weddingData: []
        };
        localStorage.removeItem('life-state');
    }

    document.getElementById('btn-login').onclick = async () => {
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        if (!email || !password) {
            authMsg.textContent = "이메일과 비밀번호를 입력해주세요.";
            return;
        }
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) authMsg.textContent = "로그인 실패: " + error.message;
    };

    document.getElementById('btn-signup').onclick = async () => {
        const email = document.getElementById('auth-email').value;
        const password = document.getElementById('auth-password').value;
        if (!email || !password) {
            authMsg.textContent = "이메일과 비밀번호를 입력해주세요.";
            return;
        }
        const { error } = await supabaseClient.auth.signUp({ email, password });
        if (error) authMsg.textContent = "회원가입 실패: " + error.message;
        else authMsg.textContent = "가입 확인 이메일을 확인해주세요! (이메일 인증 후 로그인 가능)";
    };

    // --- Service Worker Registration ---
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            // 절대 경로 /sw.js 대신 상대 경로 sw.js 사용 (GitHub Pages 대응)
            navigator.serviceWorker.register('sw.js')
                .then(reg => console.log('✅ Service Worker 등록 완료!'))
                .catch(err => console.log('❌ Service Worker 등록 실패:', err));
        });
    }

    // --- Detailed Account Tab Logic ---

    // 현재 선택된 달의 detailData 가져오기 (없으면 초기화)
    function getDetailMonth() {
        const key = state.viewDates.detail;
        if (!state.detailData[key]) {
            state.detailData[key] = {
                personal: [],
                shared: [],
                budgets: { personal: 0, shared: 0 }
            };
        }
        // 하위 속성이 없을 경우 보완
        const d = state.detailData[key];
        if (!d.personal) d.personal = [];
        if (!d.shared) d.shared = [];
        if (!d.budgets) d.budgets = { personal: 0, shared: 0 };
        return d;
    }

    function renderDetailMonthNav() {
        const key = state.viewDates.detail; // 'YYYY-MM'
        const [y, m] = key.split('-').map(Number);
        const label = document.getElementById('detail-month-label');
        if (label) label.textContent = `${y}년 ${String(m).padStart(2, '0')}월`;
    }

    function renderDetailTables() {
        renderDetailMonthNav();
        renderDetailTable('personal', 'personal-table-body');
        renderDetailTable('shared', 'shared-table-body');
        syncBudgetInputs();
    }

    function syncBudgetInputs() {
        const monthData = getDetailMonth();
        const pBudgetInput = document.getElementById('personal-budget');
        const sBudgetInput = document.getElementById('shared-budget');
        if (pBudgetInput) {
            pBudgetInput.value = monthData.budgets.personal || '';
            pBudgetInput.oninput = (e) => {
                getDetailMonth().budgets.personal = parseInt(e.target.value) || 0;
                updateDetailTotals('personal');
                saveToLocal();
            };
        }
        if (sBudgetInput) {
            sBudgetInput.value = monthData.budgets.shared || '';
            sBudgetInput.oninput = (e) => {
                getDetailMonth().budgets.shared = parseInt(e.target.value) || 0;
                updateDetailTotals('shared');
                saveToLocal();
            };
        }
    }

    function renderDetailTable(type, bodyId) {
        const body = document.getElementById(bodyId);
        if (!body) return;
        body.innerHTML = '';

        if (!state.pinnedItems) state.pinnedItems = { personal: [], shared: [] };
        if (!state.pinnedItems[type]) state.pinnedItems[type] = [];
        const pinned = state.pinnedItems[type];

        const monthData = getDetailMonth();
        if (!monthData[type]) monthData[type] = [];
        const data = monthData[type];

        // 최소 20행 보장 로직 개선
        if (data.length < 20) {
            for (let i = data.length; i < 20; i++) {
                data.push({ id: 'row-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9), title: '', amount: 0 });
            }
            saveToLocal(); // 한 번만 저장
        }

        // 헬퍼: 행 DOM 생성
        function makeRow(item, index, isPinned) {
            const tr = document.createElement('tr');
            if (isPinned) tr.classList.add('pinned-row');

            tr.innerHTML = `
                <td style="text-align: center; color: #64748b; font-size: 0.8rem;">${isPinned ? '📌' : index + 1}</td>
                <td><input type="text" class="detail-title" value="${item.title || ''}" placeholder="내용 입력"${isPinned ? '' : ''}></td>
                <td><input type="number" class="detail-amount" value="${item.amount || ''}" placeholder="금액"></td>
                <td class="row-action-cell">
                    <button class="pin-row-btn ${isPinned ? 'pinned' : ''}" title="${isPinned ? '고정 해제' : '고정'}">${isPinned ? '📌' : '📌'}</button>
                    <button class="remove-row-btn" title="삭제">✕</button>
                </td>
            `;

            const titleInput = tr.querySelector('.detail-title');
            const amountInput = tr.querySelector('.detail-amount');
            const pinBtn = tr.querySelector('.pin-row-btn');
            const removeBtn = tr.querySelector('.remove-row-btn');

            titleInput.oninput = (e) => {
                item.title = e.target.value;
                saveToLocal();
            };

            amountInput.oninput = (e) => {
                item.amount = parseInt(e.target.value) || 0;
                updateDetailTotals(type);
                saveToLocal();
            };

            pinBtn.onclick = () => {
                if (isPinned) {
                    // 고정 해제: pinnedItems에서 제거
                    state.pinnedItems[type] = state.pinnedItems[type].filter(p => p.id !== item.id);
                } else {
                    // 고정: pinnedItems에 추가 후 일반 목록에서 제거
                    state.pinnedItems[type].push({ ...item });
                    getDetailMonth()[type] = getDetailMonth()[type].filter(r => r.id !== item.id);
                }
                saveState();
                renderDetailTables();
            };

            removeBtn.onclick = () => {
                if (isPinned) {
                    state.pinnedItems[type] = state.pinnedItems[type].filter(p => p.id !== item.id);
                } else {
                    getDetailMonth()[type] = getDetailMonth()[type].filter(r => r.id !== item.id);
                }
                saveState();
                renderDetailTables();
            };

            return tr;
        }

        // 1. 고정 항목 먼저 렌더링
        pinned.forEach((item) => {
            body.appendChild(makeRow(item, 0, true));
        });

        // 구분선 (고정 항목이 있을 때만)
        if (pinned.length > 0) {
            const sep = document.createElement('tr');
            sep.innerHTML = `<td colspan="4" class="pinned-separator"></td>`;
            body.appendChild(sep);
        }

        // 2. 일반 항목 렌더링
        data.forEach((item, index) => {
            body.appendChild(makeRow(item, index, false));
        });

        updateDetailTotals(type);
    }

    function updateDetailTotals(type) {
        if (!state.pinnedItems) state.pinnedItems = { personal: [], shared: [] };
        const monthData = getDetailMonth();
        const pinnedTotal = (state.pinnedItems[type] || []).reduce((sum, item) => sum + (item.amount || 0), 0);
        const regularTotal = monthData[type].reduce((sum, item) => sum + (item.amount || 0), 0);
        const total = pinnedTotal + regularTotal;
        const totalEl = document.getElementById(`${type}-total`);
        if (totalEl) totalEl.textContent = `${total.toLocaleString()}원`;

        // 상세 금액이 바뀌었으므로 전체 통계도 갱신
        updateStats();

        const budget = monthData.budgets[type] || 0;
        const remaining = budget - total;
        const remainingEl = document.getElementById(`${type}-remaining`);
        if (remainingEl) {
            remainingEl.textContent = `${remaining.toLocaleString()}원`;
            remainingEl.style.color = remaining < 0 ? '#ef4444' : '#2b8a3e';
        }
    }



    document.getElementById('add-personal-row').onclick = () => {
        getDetailMonth().personal.push({ id: crypto.randomUUID(), title: '', amount: 0 });
        saveState();
        renderDetailTables();
    };

    document.getElementById('add-shared-row').onclick = () => {
        getDetailMonth().shared.push({ id: crypto.randomUUID(), title: '', amount: 0 });
        saveState();
        renderDetailTables();
    };

    // 연월 이전/다음 버튼
    document.getElementById('detail-prev-month').onclick = () => {
        const [y, m] = state.viewDates.detail.split('-').map(Number);
        const d = new Date(y, m - 2); // m-1 is current month (0-indexed), m-2 is prev
        state.viewDates.detail = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        saveToLocal();
        renderDetailTables();
    };

    document.getElementById('detail-next-month').onclick = () => {
        const [y, m] = state.viewDates.detail.split('-').map(Number);
        const d = new Date(y, m); // m is next month (0-indexed)
        state.viewDates.detail = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        saveToLocal();
        renderDetailTables();
    };

    // --- Wedding Tab Logic ---

    // 1. 결혼식 비용 (지출) 렌더링
    function renderWeddingCosts() {
        const container = document.getElementById('wedding-costs-wrapper');
        if (!container) return;
        container.innerHTML = '';

        state.weddingCosts.forEach((group, groupIdx) => {
            const subsection = document.createElement('div');
            subsection.className = 'wedding-cost-subsection';

            // Ensure some empty items
            if (group.items.length === 0) {
                for (let i = 0; i < 5; i++) group.items.push({ id: crypto.randomUUID(), detail: '', amount: 0, memo: '' });
            }

            const headerHtml = `
                <div class="subsection-header" style="background: #ffffff; padding: 0.6rem 1rem 0 1rem; border-radius: 8px; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between;">
                    <input type="text" class="group-title-edit" value="${safeHTML(group.title) || ''}" placeholder="카테고리명 입력" 
                        style="font-weight:700; color:#1e293b; border:none; background:transparent; font-size:0.95rem; padding:0; width: auto; flex-grow:1;">
                    <button class="delete-group-btn" title="카테고리 삭제" style="background:none; border:none; cursor:pointer; color:#fca5a5; font-size: 0.85rem;">삭제</button>
                </div>
            `;

            const tableHtml = `
                <div class="table-responsive">
                    <table class="detail-table wedding-expense-table" style="border:none; border-radius:0; box-shadow:none;">
                        <thead>
                            <tr>
                                <th>내용</th>
                                <th style="width: 100px;">금액</th>
                                <th style="width: 130px;">비고</th>
                                <th style="width: 35px;"></th>
                            </tr>
                        </thead>
                        <tbody class="group-body"></tbody>
                        <tfoot style="background: #fdfdfd; border-top: 1px solid #eef2f6;">
                            <tr>
                                <td class="total-label" style="background:#f8fafc; border:none;">합계</td>
                                <td class="total-amount group-total" style="text-align:left; padding-left:0.6rem; background:#f8fafc; border:none;">0원</td>
                                <td colspan="2" style="background:#f8fafc; border:none;"></td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
                <div style="padding: 0.5rem 0 1rem 0; border-bottom: 1px dashed #eef2f6; margin-bottom: 1.5rem;">
                    <button class="add-row-mini-btn add-expense-row-btn" style="width: 100%; font-size: 0.85rem; background:none; border:none; color:var(--primary); font-weight:700; cursor:pointer;">+ 항목 추가</button>
                </div>
            `;

            subsection.innerHTML = headerHtml + tableHtml;
            const body = subsection.querySelector('.group-body');
            const groupTotalEl = subsection.querySelector('.group-total');
            const titleInput = subsection.querySelector('.group-title-edit');
            const addRowBtn = subsection.querySelector('.add-expense-row-btn');
            const deleteGroupBtn = subsection.querySelector('.delete-group-btn');

            titleInput.oninput = (e) => { group.title = e.target.value; saveToLocal(); };

            addRowBtn.onclick = () => {
                group.items.push({ id: crypto.randomUUID(), detail: '', amount: 0, memo: '' });
                saveState();
                renderWeddingCosts();
            };

            deleteGroupBtn.onclick = () => {
                if (confirm(`'${group.title || '이 카테고리'}' 항목 전체를 삭제하시겠습니까?`)) {
                    state.weddingCosts.splice(groupIdx, 1);
                    saveState();
                    renderWeddingCosts();
                    updateWeddingSummary();
                }
            };

            group.items.forEach((item, idx) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><input type="text" class="item-detail" value="${safeHTML(item.detail) || ''}" placeholder="내용 입력"></td>
                    <td><input type="number" class="item-amount" value="${item.amount || ''}" placeholder="금액"></td>
                    <td><input type="text" class="item-memo" value="${safeHTML(item.memo) || ''}" placeholder="비고"></td>
                    <td class="row-action-cell"><button class="remove-row-btn">✕</button></td>
                `;

                tr.querySelector('.item-detail').oninput = (e) => { item.detail = e.target.value; saveToLocal(); };
                tr.querySelector('.item-amount').oninput = (e) => {
                    item.amount = parseInt(e.target.value) || 0;
                    saveToLocal();
                    updateWeddingSummary();
                    calculateGroupTotal(group, groupTotalEl);
                };
                tr.querySelector('.item-memo').oninput = (e) => { item.memo = e.target.value; saveToLocal(); };
                tr.querySelector('.remove-row-btn').onclick = () => {
                    group.items.splice(idx, 1);
                    saveState();
                    renderWeddingCosts();
                };

                body.appendChild(tr);
            });

            calculateGroupTotal(group, groupTotalEl);
            container.appendChild(subsection);
        });
    }

    function calculateGroupTotal(group, el) {
        const total = group.items.reduce((sum, item) => sum + (item.amount || 0), 0);
        if (el) el.textContent = `${total.toLocaleString()}원`;
    }

    window.addWeddingCostGroup = () => {
        state.weddingCosts.push({ id: crypto.randomUUID(), title: '새 카테고리', items: [] });
        saveState();
        renderWeddingCosts();
    };

    function renderWeddingGifts() {
        const body = document.getElementById('wedding-gift-table-body');
        if (!body) return;
        body.innerHTML = '';

        while (state.weddingGifts.length < 20) {
            state.weddingGifts.push({ id: crypto.randomUUID(), name: '', received: 0, paid: 0, attended: false });
        }

        state.weddingGifts.forEach((item, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="text-align:center; font-size:0.8rem; color:#64748b;">${idx + 1}</td>
                <td><input type="text" class="gift-name" value="${safeHTML(item.name) || ''}" placeholder="이름"></td>
                <td><input type="number" class="gift-received" value="${item.received || ''}" placeholder="0"></td>
                <td><input type="number" class="gift-paid" value="${item.paid || ''}" placeholder="0"></td>
                <td>
                    <div class="wedding-attended-cell">
                        <input type="checkbox" class="is-attended" ${item.attended ? 'checked' : ''}>
                    </div>
                </td>
                <td class="row-action-cell"><button class="remove-row-btn">✕</button></td>
            `;

            tr.querySelector('.gift-name').oninput = (e) => { item.name = e.target.value; saveToLocal(); };
            tr.querySelector('.gift-received').oninput = (e) => {
                item.received = parseInt(e.target.value) || 0;
                saveToLocal();
                updateWeddingSummary();
            };
            tr.querySelector('.gift-paid').oninput = (e) => {
                item.paid = parseInt(e.target.value) || 0;
                saveToLocal();
                updateWeddingSummary();
            };
            tr.querySelector('.is-attended').onchange = (e) => { item.attended = e.target.checked; saveToLocal(); };
            tr.querySelector('.remove-row-btn').onclick = () => {
                state.weddingGifts.splice(idx, 1);
                saveState();
                renderWeddingGifts();
            };

            body.appendChild(tr);
        });
        updateWeddingSummary();
    }

    function updateWeddingSummary() {
        const totalExp = state.weddingCosts.reduce((sum, g) => sum + g.items.reduce((s, i) => s + (i.amount || 0), 0), 0);
        const totalRec = state.weddingGifts.reduce((sum, i) => sum + (i.received || 0), 0);
        const totalPaid = state.weddingGifts.reduce((sum, i) => sum + (i.paid || 0), 0);

        const expTop = document.getElementById('wedding-expense-total-top');
        const recTop = document.getElementById('wedding-received-total');
        if (expTop) expTop.textContent = `${totalExp.toLocaleString()}원`;
        if (recTop) recTop.textContent = `${totalRec.toLocaleString()}원`;

        const receivedFooter = document.getElementById('wedding-gifts-received-footer');
        const paidFooter = document.getElementById('wedding-gifts-paid-footer');
        if (receivedFooter) receivedFooter.textContent = `${totalRec.toLocaleString()}원`;
        if (paidFooter) paidFooter.textContent = `${totalPaid.toLocaleString()}원`;
    }

    // Event listeners for wedding are now handled by window functions or inline onclicks in HTML


    // 전체 데이터 초기화 기능
    document.getElementById('btn-reset-all').onclick = async () => {
        if (confirm('⚠️ 모든 데이터(가계부, 기록, 카테고리 등)를 정말 초기화하시겠습니까? \n이 작업은 되돌릴 수 없으며 클라우드 데이터도 모두 삭제됩니다.')) {
            resetState(); // 로컬 및 state 초기화
            await saveState(); // 빈 상태를 서버에 저장 (실제로는 새로운 빈 로그를 insert)
            refreshAllUI();
            alert('모든 데이터가 초기화되었습니다.');
        }
    };

    // Initial Render
    refreshAllUI();
});
