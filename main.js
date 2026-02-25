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

    // --- 날짜 범위 집계 헬퍼 ---
    function formatLocalDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function getDateRangeForMonth(monthKey, salaryDay) {
        const [y, m] = monthKey.split('-').map(Number);
        salaryDay = Number(salaryDay) || 1;

        if (salaryDay === 1) {
            // 1일 시작인 경우: 해당 월의 1일 ~ 말일
            const start = `${y}-${String(m).padStart(2, '0')}-01`;
            const end = `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`;
            return { start, end };
        } else {
            // 전달 salaryDay ~ 당월 salaryDay - 1
            // 예: 3월 달력에서 25일 설정 → 2/25 ~ 3/24
            const startDate = new Date(y, m - 2, salaryDay);
            const endDate = new Date(y, m - 1, salaryDay - 1);
            return {
                start: formatLocalDate(startDate),
                end: formatLocalDate(endDate)
            };
        }
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
            life: new Date().toISOString().slice(0, 7)
        },
        weddingCosts: [
            { id: 'group1', title: '', items: [] },
            { id: 'group2', title: '', items: [] },
            { id: 'group3', title: '', items: [] }
        ],
        weddingGifts: [],
        salaryDay: 1, // 한 달 시작일 설정 (기본 1일)
        categoryBudgets: {} // { '식비': 500000, ... }
    };

    // --- 이번 달로 날짜 초기화 헬퍼 ---
    function resetViewDatesToToday() {
        const today = new Date().toISOString().slice(0, 7);
        state.viewDates = {
            account: today,
            life: today
        };
    }

    // 로컬 데이터 먼저 불러오기
    const localData = localStorage.getItem('life-state');
    if (localData) {
        const parsed = JSON.parse(localData);
        state = { ...state, ...parsed };

        // Wedding 데이터 이관 지원
        state.weddingGifts = parsed.weddingGifts || parsed.weddingData || [];
        state.savingsItems = parsed.savingsItems || [];
        state.categoryBudgets = parsed.categoryBudgets || {};

        // 접속 시에는 무조건 "이번 달"로 고정
        resetViewDatesToToday();
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
                // Supabase SDK가 jsonb 컬럼을 자동으로 파싱(객체화)해주므로 JSON.parse 불필요
                const cloudExpense = data.expense || {};

                state = {
                    ...state,
                    ...cloudExpense,
                    detailData: { ...state.detailData, ...(cloudExpense.detailData || {}) },
                    savingsItems: cloudExpense.savingsItems || state.savingsItems || []
                };

                // 클라우드 데이터를 불러오더라도 "현재 보고 있는 날짜"는 오늘로 유지
                resetViewDatesToToday();

                saveToLocal();
                refreshAllUI();
                setSyncStatus('online', '클라우드 연동 완료');
            } else {
                setSyncStatus('online', '새 데이터 (클라우드 비어있음)');
                // 만약 기존 로컬 데이터가 있다면, 클라우드에 최초 1회 업로드 진행
                if (state.transactions.length > 0 || state.issues.length > 0 || state.logs.length > 0) {
                    isInitialLoading = false;
                    saveState(); // 빈 클라우드에 현재 상태 저장
                }
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
                        expense: state, // JSON.stringify 없이 객체 그대로 전달
                        income: state.transactions?.filter(t => t.type === 'income') || [],
                        savings: state.transactions?.filter(t => t.type === 'savings') || []
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
        renderSavingsItems(); // 새로 추가한 자산/적금 렌더링
        updateStats();

        // 총 보유자산 클릭 이벤트 추가
        const totalAssetBadge = document.querySelector('.total-asset-badge');
        if (totalAssetBadge) {
            totalAssetBadge.style.cursor = 'pointer';
            totalAssetBadge.onclick = openTotalAssetModal;
        }
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
        const salaryDay = state.salaryDay || 1;
        const range = getDateRangeForMonth(currentMonth, salaryDay);

        const currentMonthDetailExpense = 0;

        // 전체 통계용 (All Time)
        const totalIncome = state.transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
        const totalBaseExpense = state.transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
        const totalExpense = totalBaseExpense; // 상세가계부 합계는 별도 (연동 안 함)
        const totalSavings = state.transactions.filter(t => t.type === 'savings').reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('total-income').textContent = `${totalIncome.toLocaleString()}원`;
        document.getElementById('total-expense').textContent = `${totalExpense.toLocaleString()}원`;
        document.getElementById('total-savings').textContent = `${totalSavings.toLocaleString()}원`;

        // 총 보유자산 (적금/예금 합산 산출액)
        const totalAsset = getCalculatedTotalAsset();
        const totalAssetStatsNewEl = document.getElementById('total-asset-stats-new');
        if (totalAssetStatsNewEl) totalAssetStatsNewEl.textContent = `${totalAsset.toLocaleString()}원`;

        // --- 이번 달 통계용 (커스텀 날짜 범위 적용) ---
        const rangeTrans = state.transactions.filter(t => t.date >= range.start && t.date <= range.end);

        const monthlyIncome = rangeTrans.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
        const monthlyBaseExpense = rangeTrans.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
        const monthlyExpense = monthlyBaseExpense; // 상세가계부 합계는 별도 (연동 안 함)
        const monthlySavings = rangeTrans.filter(t => t.type === 'savings').reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('acc-monthly-income').textContent = `${monthlyIncome.toLocaleString()}원`;
        document.getElementById('acc-monthly-expense').textContent = `${monthlyExpense.toLocaleString()}원`;
        document.getElementById('acc-monthly-savings').textContent = `${monthlySavings.toLocaleString()}원`;

        const monthlyBalance = monthlyIncome - monthlyExpense - monthlySavings;
        const balanceEl = document.getElementById('acc-monthly-balance');
        const assetEl = document.getElementById('acc-total-asset');
        if (balanceEl) balanceEl.textContent = `${monthlyBalance.toLocaleString()}원`;
        if (assetEl) assetEl.textContent = `${totalAsset.toLocaleString()}원`;

        // 집계 기간 표시 (툴팁 + 하단 텍스트)
        const calendarTitle = document.querySelector('#account-calendar .calendar-header h3');
        if (calendarTitle) calendarTitle.title = `집계 기간: ${range.start} ~ ${range.end}`;

        const rangeInfoEl = document.getElementById('salary-range-info');
        if (rangeInfoEl) {
            if (salaryDay === 1) {
                rangeInfoEl.style.display = 'none';
            } else {
                rangeInfoEl.style.display = 'block';
                rangeInfoEl.textContent = `📊 집계 기간: ${range.start} ~ ${range.end}`;
            }
        }

        updateCharts(monthlyExpense, monthlySavings, currentDetailPersonal, currentDetailShared);
    }

    function updateCharts(totalExpense, totalSavings, detailPersonal, detailShared) {
        const currentMonth = state.viewDates.account;
        const salaryDay = state.salaryDay || 1;
        const range = getDateRangeForMonth(currentMonth, salaryDay);
        const rangeTrans = state.transactions.filter(t => t.date >= range.start && t.date <= range.end);

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

        // 이번 달 기준 데이터 취합 (All-time이 아닌 현재 범위 기준)
        const expenseData = state.categories.expense.map(cat => ({
            name: cat,
            value: rangeTrans.filter(t => t.type === 'expense' && t.cat === cat).reduce((sum, t) => sum + t.amount, 0)
        }));

        if (detailPersonal > 0) expenseData.push({ name: '상세(개인)', value: detailPersonal });
        if (detailShared > 0) expenseData.push({ name: '상세(공용)', value: detailShared });

        const savingsData = state.categories.savings.map(cat => ({
            name: cat,
            value: rangeTrans.filter(t => t.type === 'savings' && t.cat === cat).reduce((sum, t) => sum + t.amount, 0)
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

        const salaryDay = (type === 'account') ? (state.salaryDay || 1) : 1;
        const monthKey = state.viewDates[type];
        const [year, month] = monthKey.split('-').map(Number);
        const range = getDateRangeForMonth(monthKey, salaryDay);

        const startDate = new Date(range.start);
        const endDate = new Date(range.end);
        const todayStr = formatLocalDate(new Date());

        const header = document.createElement('div');
        header.className = 'calendar-header';

        // 타이틀 표시: 집계 기준일이 1일이 아니면 기간을 함께 표시하거나 "X월분"으로 표시
        let titleHtml = `${year}년 ${month}월`;
        if (type === 'account' && salaryDay !== 1) {
            titleHtml = `${month}월분 지불 회차`;
        }

        header.innerHTML = `
            <h3>${titleHtml} <button class="date-picker-btn">📅</button><input type="month" class="hidden-date-input" value="${monthKey}"></h3>
            <div class="nav-controls"><button class="nav-btn prev-btn">&#8249;</button><button class="nav-btn next-btn">&#8250;</button></div>
        `;
        header.querySelector('.prev-btn').onclick = () => changeMonth(type, -1);
        header.querySelector('.next-btn').onclick = () => changeMonth(type, 1);
        const dateInput = header.querySelector('.hidden-date-input');
        header.querySelector('.date-picker-btn').onclick = () => dateInput.showPicker();
        dateInput.onchange = (e) => { state.viewDates[type] = e.target.value; saveState(); refreshCalendars(); renderCategoryGrids(); };
        container.appendChild(header);

        const grid = document.createElement('div'); grid.className = 'calendar-grid';
        ['일', '월', '화', '수', '목', '금', '토'].forEach(d => {
            const h = document.createElement('div');
            h.className = 'calendar-day-head';
            h.textContent = d;
            grid.appendChild(h);
        });

        // 시작 요일에 맞춰 빈 칸 삽입
        const firstDayOfWeek = startDate.getDay();
        for (let i = 0; i < firstDayOfWeek; i++) grid.appendChild(document.createElement('div'));

        // 기간 내의 모든 날짜 렌더링
        let currentIter = new Date(startDate);
        while (currentIter <= endDate) {
            const dayEl = document.createElement('div');
            dayEl.className = 'calendar-day';
            const fullDate = formatLocalDate(currentIter);
            const d = currentIter.getDate();
            const m = currentIter.getMonth() + 1; // 달이 바뀌는 경우 가독성을 위해 월 표시 가능

            // 다른 달의 날짜인 경우 살짝 다른 스타일이나 월 표시 추가 (선택사항)
            const isDifferentMonth = (m !== month);
            const dateLabel = isDifferentMonth ? `<span style="font-size:0.7em; opacity:0.7;">${m}/</span>${d}` : d;

            dayEl.innerHTML = `<span>${dateLabel}</span><div class="day-content"></div>`;
            const contentDiv = dayEl.querySelector('.day-content');

            if (type === 'account') {
                const dayTrans = state.transactions.filter(t => t.date === fullDate);
                const inc = dayTrans.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
                const exp = dayTrans.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
                const sav = dayTrans.filter(t => t.type === 'savings').reduce((s, t) => s + t.amount, 0);
                if (inc > 0) contentDiv.innerHTML += `<div class="day-label label-income">+${inc.toLocaleString()}</div>`;
                if (exp > 0) contentDiv.innerHTML += `<div class="day-label label-expense">-${exp.toLocaleString()}</div>`;
                if (sav > 0) contentDiv.innerHTML += `<div class="day-label label-savings">S:${sav.toLocaleString()}</div>`;

                if (dayTrans.length > 0) {
                    dayEl.classList.add('clickable-day');
                    dayEl.onclick = () => openAccountDayModal(fullDate);
                }
            } else {
                const dayIssues = state.issues.filter(i => i.date === fullDate);
                dayIssues.forEach(issue => {
                    contentDiv.innerHTML += `<div class="day-label label-issue ${issue.checked ? 'checked' : ''}">${issue.text}</div>`;
                });
                const dayLogs = state.logs.filter(l => l.date === fullDate);
                dayLogs.forEach(log => {
                    contentDiv.innerHTML += `<div class="day-label label-life">${log.item}(${log.qty})</div>`;
                });
                if (dayIssues.length > 0 || dayLogs.length > 0) {
                    dayEl.classList.add('clickable-day');
                    dayEl.onclick = () => openLifeDayModal(fullDate);
                }
            }

            if (fullDate === todayStr) dayEl.classList.add('today');
            grid.appendChild(dayEl);

            // 다음 날로 이동
            currentIter.setDate(currentIter.getDate() + 1);
        }
        container.appendChild(grid);
    }

    function changeMonth(type, delta) {
        let [y, m] = state.viewDates[type].split('-').map(Number);
        m += delta;
        if (m > 12) { y++; m = 1; }
        if (m < 1) { y--; m = 12; }
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
        const currentMonth = state.viewDates.account;
        const salaryDay = state.salaryDay || 1;
        const range = getDateRangeForMonth(currentMonth, salaryDay);

        const renderGrid = (type, id) => {
            const grid = document.getElementById(id); if (!grid) return; grid.innerHTML = '';
            state.categories[type].forEach((cat, index) => {
                // 집계 기간(range) 내의 내역들만 합산
                const amount = state.transactions.filter(t =>
                    t.type === type &&
                    t.cat === cat &&
                    t.date >= range.start &&
                    t.date <= range.end
                ).reduce((s, t) => s + t.amount, 0);

                const budget = state.categoryBudgets[cat] || 0;
                let budgetHtml = '';
                let gaugeHtml = '';

                if (type === 'expense') {
                    const pct = budget > 0 ? Math.min(100, (amount / budget) * 100) : 0;
                    const statusClass = pct >= 100 ? 'danger' : (pct >= 80 ? 'warning' : '');
                    budgetHtml = `<div class="budget-info">예산: ${budget.toLocaleString()}원</div>`;
                    gaugeHtml = `
                        <div class="cat-gauge">
                            <div class="cat-gauge-fill ${statusClass}" style="width: ${pct}%"></div>
                        </div>
                    `;
                }

                const card = document.createElement('div'); card.className = 'category-card'; card.draggable = true; card.dataset.index = index; card.dataset.type = type;
                card.innerHTML = `
                    <button class="card-delete-btn" title="삭제">&times;</button>
                    <span class="cat-name">${cat}</span>
                    <span class="cat-amount">${amount.toLocaleString()}원</span>
                    ${budgetHtml}
                    ${gaugeHtml}
                `;
                card.ondragstart = (e) => { draggedItem = index; draggedType = type; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
                card.ondragend = () => { card.classList.remove('dragging'); document.querySelectorAll('.category-grid').forEach(g => g.classList.remove('drag-over')); };
                card.ondragover = (e) => { e.preventDefault(); if (draggedType === type) grid.classList.add('drag-over'); };
                card.ondrop = (e) => { e.preventDefault(); if (draggedType === type && draggedItem !== null) { const [moved] = state.categories[type].splice(draggedItem, 1); state.categories[type].splice(index, 0, moved); saveState(); renderCategoryGrids(); } draggedItem = null; draggedType = null; };
                card.onclick = (e) => {
                    if (e.target.classList.contains('card-delete-btn')) {
                        if (confirm(`'${cat}' 카테고리를 삭제하시겠습니까?`)) {
                            state.categories[type] = state.categories[type].filter(c => c !== cat);
                            state.transactions = state.transactions.filter(t => !(t.type === type && t.cat === cat));
                            saveState(); renderCategoryGrids(); refreshCalendars();
                        }
                    } else if (type === 'expense') {
                        openCategoryDetailModal(cat);
                    } else {
                        openModal(cat, type);
                    }
                };
                grid.appendChild(card);
            });
        };
        renderGrid('expense', 'expense-category-grid'); renderGrid('savings', 'savings-category-grid');
    }

    document.getElementById('add-expense-cat').onclick = () => { const n = prompt('새 소비 카테고리 이름:'); if (n && !state.categories.expense.includes(n)) { state.categories.expense.push(n); saveState(); renderCategoryGrids(); } };
    document.getElementById('add-savings-cat').onclick = () => { const n = prompt('새 저축 카테고리 이름:'); if (n && !state.categories.savings.includes(n)) { state.categories.savings.push(n); saveState(); renderCategoryGrids(); } };

    // --- Modal Logic ---
    const modal = document.getElementById('entry-modal');
    const closeBtn = document.querySelector('#entry-modal .close-modal');
    const saveBtn = document.getElementById('save-entry');

    const accIncomeCard = document.getElementById('acc-income-card');
    if (accIncomeCard) accIncomeCard.onclick = () => openModal('수입', 'income');
    const accAssetCard = document.getElementById('acc-asset-card');
    if (accAssetCard) accAssetCard.onclick = () => openModal('자산', 'asset');

    function openModal(category, type, date = null) {
        currentModalTarget = { category, type };
        document.getElementById('modal-title').textContent = `${category} - 내역 추가`;
        document.getElementById('modal-date').value = date || `${state.viewDates.account}-01`;
        document.getElementById('modal-name').value = '';
        document.getElementById('modal-amount').value = '';

        // 태그 칩 초기화 (기본 '기타' 선택)
        const chips = document.querySelectorAll('.tag-chip');
        chips.forEach(c => {
            if (c.dataset.value === '기타') c.classList.add('active');
            else c.classList.remove('active');
        });

        // 소비/저축 카테고리인 경우만 이름 변경 버튼 표시
        const renameBtn = document.getElementById('btn-rename-cat');
        if (type === 'expense' || type === 'savings') {
            renameBtn.style.display = 'block';
        } else {
            renameBtn.style.display = 'none';
        }

        modal.classList.add('active');
        document.body.classList.add('modal-open');
        // 모달창 상단으로 스크롤 초기화
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) modalContent.scrollTop = 0;
    }

    // 태그 칩 클릭 이벤트
    document.getElementById('modal-tag-chips').onclick = (e) => {
        const chip = e.target.closest('.tag-chip');
        if (chip) {
            document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        }
    };

    function closeModal() {
        modal.classList.remove('active');
        // 만약 상세 모달 등 다른 모달이 열려있지 않다면 스크롤 락 해제
        const otherModalActive = !!document.querySelector('.modal-backdrop.active:not(#entry-modal)');
        if (!otherModalActive) {
            document.body.classList.remove('modal-open');
        }
    }
    closeBtn.onclick = closeModal;

    // 모달 외부 클릭 시 닫기 제한 (배경 클릭으로 꺼지지 않게 설정)
    // 단, .close-modal 버튼이나 특정 닫기 버튼은 작동해야 함
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-backdrop')) {
            // 배경 클릭 시 닫기 기능 제거 또는 선택적 적용
            // 사용자가 불편하다고 했으므로 여기서 아무것도 하지 않음 (또는 alert 표시 가능)
            console.log("배경 클릭으로 닫기가 제한되었습니다.");
        }
    });

    // 상세 모달 닫기 버튼들
    const catDetailModal = document.getElementById('category-detail-modal');
    document.getElementById('close-cat-detail').onclick = () => {
        catDetailModal.classList.remove('active');
        document.body.classList.remove('modal-open');
    };

    document.getElementById('close-acc-day-modal').onclick = () => {
        document.getElementById('acc-day-modal').classList.remove('active');
        document.body.classList.remove('modal-open');
    };

    saveBtn.onclick = () => {
        const d = document.getElementById('modal-date').value,
            n = document.getElementById('modal-name').value,
            a = parseInt(document.getElementById('modal-amount').value) || 0;

        const activeChip = document.querySelector('.tag-chip.active');
        const t = activeChip ? activeChip.dataset.value : '기타';

        if (d && n && a > 0) {
            if (currentModalTarget.type === 'wedding') {
                const group = state.weddingCosts.find(g => g.id === currentModalTarget.category);
                if (group) {
                    group.items.push({ id: crypto.randomUUID(), detail: n, amount: a, memo: '' });
                }
            } else {
                state.transactions.push({
                    id: Date.now(),
                    date: d,
                    name: n,
                    cat: currentModalTarget.category,
                    amount: a,
                    type: currentModalTarget.type,
                    tag: t
                });
            }
            saveState();
            refreshCalendars();
            renderCategoryGrids();
            renderWeddingCosts();
            updateWeddingSummary();

            // 상세 모달이 열려있다면 새로고침
            if (catDetailModal.classList.contains('active')) renderCategoryDetail(currentModalTarget.category);

            document.getElementById('modal-name').value = '';
            document.getElementById('modal-amount').value = '';
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



    // --- Account Day Modal ---
    const accDayModal = document.getElementById('acc-day-modal');
    const accDayCloseBtn = document.querySelector('#acc-day-modal .close-modal');
    if (accDayCloseBtn) {
        accDayCloseBtn.onclick = () => accDayModal.classList.remove('active');
    }

    function openAccountDayModal(date) {
        document.getElementById('acc-day-title').textContent = `${date} 상세 내역`;
        renderAccountDayContent(date);
        accDayModal.classList.add('active');
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
    const lifeDayModal = document.getElementById('life-day-modal');
    const lifeDayCloseBtn = document.querySelector('#life-day-modal .close-modal');
    if (lifeDayCloseBtn) {
        lifeDayCloseBtn.onclick = () => lifeDayModal.classList.remove('active');
    }

    function openLifeDayModal(date) {
        document.getElementById('life-day-title').textContent = `${date} 상세 내역`;
        renderLifeDayContent(date);
        lifeDayModal.classList.add('active');
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
                <td style="display: flex; gap: 4px; justify-content: center;">
                    <button class="edit-stock-btn">수정</button>
                    <button class="delete-stock-btn">삭제</button>
                </td>
            `;

            tr.querySelector('.edit-stock-btn').onclick = () => {
                const newItem = prompt('내용 수정:', item.item);
                const newQty = prompt('수량 수정:', item.qty);
                const newAmount = prompt('금액 수정:', item.amount || 0);

                if (newItem !== null && newQty !== null && newAmount !== null) {
                    const target = state.logs.find(l => l.id === item.id);
                    if (target) {
                        target.item = newItem;
                        target.qty = newQty;
                        target.amount = newAmount;
                        saveState();
                        renderStockList();
                        refreshCalendars(); // 달력 내용도 변경될 수 있으므로 갱신
                    }
                }
            };

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
            document.getElementById('btn-delete-account').style.display = 'block';
            // 최초 로그인/세션 복원 시에만 클라우드 데이터 불러오기
            // TOKEN_REFRESHED 시에는 달력이 이번 달로 튀지 않도록 스킵
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                loadFromCloud();
            }
        } else {
            currentUser = null;
            authOverlay.classList.add('active');
            document.getElementById('btn-logout').style.display = 'none';
            document.getElementById('btn-reset-all').style.display = 'none';
            document.getElementById('btn-delete-account').style.display = 'none';
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

    document.getElementById('btn-delete-account').onclick = async () => {
        if (confirm('정말 탈퇴하시겠습니까?\n데이터베이스에 저장된 모든 기록이 즉시 삭제되며 복구할 수 없습니다.')) {
            try {
                // 1. 데이터베이스에서 내용 삭제
                const { error: deleteError } = await supabaseClient
                    .from('user_categories')
                    .delete()
                    .eq('user_id', currentUser.id);

                if (deleteError) throw deleteError;

                // 2. 로그아웃 (이후 로그인/회원가입 창으로 이동됨)
                await supabaseClient.auth.signOut();

                // 3. 로컬 데이터 초기화 및 새로고침
                localStorage.removeItem('life-state');
                alert('회원탈퇴 및 데이터 삭제 처리가 완료되었습니다.');
                location.reload();
            } catch (e) {
                console.error("데이터 삭제 실패:", e);
                alert("삭제 처리 중 에러가 발생했습니다.");
            }
        }
    };

    function resetState() {
        state = {
            transactions: [],
            categories: {
                expense: ['생활비', '집', '개인생활비'],
                savings: ['적금', '주식', '청약']
            },
            logs: [],
            issues: [],
            viewDates: {
                account: new Date().toISOString().slice(0, 7),
                life: new Date().toISOString().slice(0, 7),
                detail: new Date().toISOString().slice(0, 7)
            },
            detailData: {},
            pinnedItems: { personal: [], shared: [] },
            weddingCosts: [
                { id: 'group1', title: '', items: [] },
                { id: 'group2', title: '', items: [] },
                { id: 'group3', title: '', items: [] }
            ],
            weddingGifts: [],
            salaryDay: 1,
            savingsItems: [], // 자산 및 만기 현황 아이템
            categoryBudgets: {}
        };
        localStorage.removeItem('life-state');
    }

    // --- Category Detail Modal Implementation ---
    let currentDetailCat = '';
    let detailSortOrder = 'newest'; // 'newest' or 'oldest'

    function openCategoryDetailModal(catName) {
        currentDetailCat = catName;
        const modal = document.getElementById('category-detail-modal');
        document.getElementById('cat-detail-title').textContent = `'${catName}' 상세 내역`;
        document.getElementById('cat-budget-input').value = state.categoryBudgets[catName] || '';
        document.getElementById('cat-search-input').value = '';

        // 정렬 상태 초기화
        detailSortOrder = 'newest';
        const sortBtn = document.getElementById('btn-sort-newest');
        if (sortBtn) {
            sortBtn.innerHTML = '최신순 ⬇️';
            sortBtn.style.display = 'inline-block';
        }

        renderCategoryDetail(catName);
        modal.classList.add('active');
        document.body.classList.add('modal-open');
        // 모달창 상단으로 스크롤 초기화
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) modalContent.scrollTop = 0;
    }

    // 예산 저장
    document.getElementById('save-cat-budget').onclick = () => {
        const b = parseInt(document.getElementById('cat-budget-input').value) || 0;
        state.categoryBudgets[currentDetailCat] = b;
        saveState();
        renderCategoryGrids();
        alert('예산이 저장되었습니다.');
    };

    // 검색 및 정렬 이벤트
    document.getElementById('cat-search-input').oninput = () => renderCategoryDetail(currentDetailCat);
    document.getElementById('btn-sort-newest').onclick = () => {
        if (detailSortOrder === 'newest') {
            detailSortOrder = 'oldest';
            document.getElementById('btn-sort-newest').innerHTML = '오래된순 ⬆️';
        } else {
            detailSortOrder = 'newest';
            document.getElementById('btn-sort-newest').innerHTML = '최신순 ⬇️';
        }
        renderCategoryDetail(currentDetailCat);
    };

    // 선택 삭제
    document.getElementById('btn-delete-selected').onclick = () => {
        const checked = Array.from(document.querySelectorAll('.trans-checkbox:checked')).map(cb => Number(cb.value));
        if (checked.length === 0) return alert('삭제할 항목을 선택해주세요.');

        if (confirm(`${checked.length}개의 내역을 삭제하시겠습니까?`)) {
            state.transactions = state.transactions.filter(t => !checked.includes(t.id));
            saveState();
            refreshCalendars();
            renderCategoryGrids();
            renderCategoryDetail(currentDetailCat);
        }
    };

    // 전체 선택
    document.getElementById('check-all-trans').onclick = (e) => {
        document.querySelectorAll('.trans-checkbox').forEach(cb => cb.checked = e.target.checked);
    };

    // 내역 추가 버튼 (상세 모달 내)
    document.getElementById('btn-add-detail-entry').onclick = () => {
        openModal(currentDetailCat, 'expense');
    };

    function renderCategoryDetail(catName) {
        const listBody = document.getElementById('cat-trans-list');
        const search = document.getElementById('cat-search-input').value.toLowerCase();
        const currentMonth = state.viewDates.account;
        const salaryDay = state.salaryDay || 1;
        const range = getDateRangeForMonth(currentMonth, salaryDay);

        let filtered = state.transactions.filter(t =>
            t.type === 'expense' &&
            t.cat === catName &&
            t.date >= range.start &&
            t.date <= range.end &&
            (t.name.toLowerCase().includes(search) || (t.tag && t.tag.toLowerCase().includes(search)))
        );

        // 정렬
        filtered.sort((a, b) => {
            return detailSortOrder === 'newest'
                ? b.date.localeCompare(a.date) || b.id - a.id
                : a.date.localeCompare(b.date) || a.id - b.id;
        });

        listBody.innerHTML = filtered.map(t => `
        <tr>
            <td><input type="checkbox" class="trans-checkbox" value="${t.id}"></td>
            <td>${t.date.slice(5)}</td>
            <td>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="trans-tag" style="margin: 0; white-space: nowrap;">${safeHTML(t.tag || '기타')}</span>
                    <span style="font-weight:600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeHTML(t.name)}</span>
                </div>
            </td>
            <td style="text-align: right; font-weight:700;">${t.amount.toLocaleString()}원</td>
        </tr>
    `).join('') || '<tr><td colspan="4" style="text-align:center; padding:2rem; color:#94a3b8;">내역이 없습니다.</td></tr>';

        document.getElementById('check-all-trans').checked = false;
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
        if (password.length < 6) {
            authMsg.textContent = "비밀번호는 최소 6자 이상 입력해주세요.";
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
    // 시작일(급여일) 설정 이벤트
    function updateSalaryRangeInfo() {
        const infoEl = document.getElementById('salary-range-info');
        if (!infoEl) return;
        const day = state.salaryDay || 1;
        if (day === 1) {
            infoEl.style.display = 'none';
            infoEl.textContent = '';
        } else {
            const range = getDateRangeForMonth(state.viewDates.account, day);
            infoEl.style.display = 'block';
            infoEl.textContent = `📊 집계 기간: ${range.start} ~ ${range.end}`;
        }
    }

    const salaryDayInput = document.getElementById('setting-salary-day');
    if (salaryDayInput) {
        salaryDayInput.value = state.salaryDay || 1; // 초기값 설정
        updateSalaryRangeInfo(); // 초기 표시
        salaryDayInput.onchange = (e) => {
            let val = Number(e.target.value);
            if (val < 1) val = 1;
            if (val > 28) val = 28;
            e.target.value = val;
            state.salaryDay = val;
            saveState();
            updateStats();
            updateSalaryRangeInfo();
        };
    }

    // --- 자산 및 만기 현황 (Savings Items) ---
    const savingsModal = document.getElementById('savings-modal');
    const closeSavingsModalBtn = document.getElementById('close-savings-modal');
    const saveSavingsBtn = document.getElementById('save-savings-item');
    const addSavingsBtn = document.getElementById('btn-add-savings');

    let currentEditingSavingsId = null;

    const savingsTypeSelect = document.getElementById('savings-type');
    if (savingsTypeSelect) {
        savingsTypeSelect.addEventListener('change', (e) => {
            const isInstallment = e.target.value === '적금';
            const targetGroup = document.getElementById('savings-target-group');
            const targetLabel = document.getElementById('savings-target-label');

            if (isInstallment) {
                targetGroup.style.display = 'none';
            } else {
                targetGroup.style.display = 'flex';
                targetLabel.textContent = '예치 금액';
            }

            document.getElementById('savings-monthly-group').style.display = isInstallment ? 'flex' : 'none';
            document.getElementById('savings-interest-group').style.display = 'flex'; // 예금, 적금 모두 이자율 표시
        });
    }

    if (addSavingsBtn) {
        addSavingsBtn.onclick = () => {
            currentEditingSavingsId = null;
            document.getElementById('savings-type').value = '적금';
            if (savingsTypeSelect) savingsTypeSelect.dispatchEvent(new Event('change'));
            document.getElementById('savings-name').value = '';
            document.getElementById('savings-target-amount').value = '';
            document.getElementById('savings-monthly-amount').value = '';
            document.getElementById('savings-interest').value = '';
            document.getElementById('savings-start-date').value = formatLocalDate(new Date());
            document.getElementById('savings-end-date').value = '';
            savingsModal.classList.add('active');
        };
    }
    if (closeSavingsModalBtn) closeSavingsModalBtn.onclick = () => savingsModal.classList.remove('active');



    if (saveSavingsBtn) {
        saveSavingsBtn.onclick = async () => {
            const type = document.getElementById('savings-type').value;
            const name = document.getElementById('savings-name').value.trim();
            const monthlyAmount = parseInt(document.getElementById('savings-monthly-amount').value) || 0;
            const interestRate = parseFloat(document.getElementById('savings-interest').value) || 0;
            const startDate = document.getElementById('savings-start-date').value;
            const endDate = document.getElementById('savings-end-date').value;

            let targetAmount = 0;
            if (type === '적금') {
                const start = new Date(startDate);
                const end = new Date(endDate);
                if (start && end) {
                    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
                    targetAmount = monthlyAmount * Math.max(0, months);
                }
            } else {
                targetAmount = parseInt(document.getElementById('savings-target-amount').value) || 0;
            }

            if (!name || !startDate || !endDate) return alert('모든 항목을 입력해주세요.');
            if (new Date(startDate) >= new Date(endDate)) return alert('만기일은 시작일보다 늦어야 합니다.');

            state.savingsItems = state.savingsItems || [];

            if (currentEditingSavingsId) {
                const item = state.savingsItems.find(i => i.id === currentEditingSavingsId);
                if (item) {
                    item.type = type;
                    item.name = name;
                    item.targetAmount = targetAmount;
                    item.monthlyAmount = monthlyAmount;
                    item.interestRate = interestRate;
                    item.startDate = startDate;
                    item.endDate = endDate;
                }
            } else {
                state.savingsItems.push({
                    id: crypto.randomUUID(),
                    type,
                    name,
                    targetAmount,
                    monthlyAmount,
                    interestRate,
                    startDate,
                    endDate,
                    createdAt: Date.now()
                });
            }

            savingsModal.classList.remove('active');
            await saveState();
            renderSavingsItems();
        };
    }

    window.editSavingsItem = (id) => {
        const item = state.savingsItems.find(i => i.id === id);
        if (!item) return;

        currentEditingSavingsId = id;
        document.getElementById('savings-type').value = item.type || '적금';
        if (savingsTypeSelect) savingsTypeSelect.dispatchEvent(new Event('change'));
        document.getElementById('savings-name').value = item.name;
        document.getElementById('savings-target-amount').value = item.targetAmount || 0;
        document.getElementById('savings-monthly-amount').value = item.monthlyAmount || '';
        document.getElementById('savings-interest').value = item.interestRate || '';
        document.getElementById('savings-start-date').value = item.startDate;
        document.getElementById('savings-end-date').value = item.endDate;

        const modal = document.getElementById('savings-modal');
        if (modal) modal.classList.add('active');
    };

    window.deleteSavingsItem = async (id) => {
        if (!confirm('이 기록을 삭제하시겠습니까?')) return;
        state.savingsItems = state.savingsItems.filter(i => i.id !== id);
        await saveState();
        renderSavingsItems();
    };

    function renderSavingsItems() {
        const listEl = document.getElementById('savings-list');
        if (!listEl) return;

        // 버튼 클릭 이벤트 위임 (한 번만 설정)
        if (!listEl.dataset.listener) {
            listEl.addEventListener('click', (e) => {
                const editBtn = e.target.closest('.btn-edit-savings');
                const deleteBtn = e.target.closest('.btn-delete-savings');

                if (editBtn) {
                    const id = editBtn.dataset.id;
                    window.editSavingsItem(id);
                } else if (deleteBtn) {
                    const id = deleteBtn.dataset.id;
                    window.deleteSavingsItem(id);
                }
            });
            listEl.dataset.listener = 'true';
        }

        state.savingsItems = state.savingsItems || [];

        if (state.savingsItems.length === 0) {
            listEl.innerHTML = `<div class="savings-empty-state">우측 상단의 + 버튼을 눌러 적금/예금을 추가해보세요.</div>`;
            return;
        }

        const today = new Date();
        // 시간은 0시0분0초로 통일하여 날짜만 비교
        today.setHours(0, 0, 0, 0);

        listEl.innerHTML = state.savingsItems.map(item => {
            const start = new Date(item.startDate);
            const end = new Date(item.endDate);

            // 날짜 계산
            const totalDays = Math.max(1, Math.floor((end - start) / (1000 * 60 * 60 * 24)));
            let passedDays = Math.floor((today - start) / (1000 * 60 * 60 * 24));
            passedDays = Math.max(0, Math.min(passedDays, totalDays)); // 0과 totalDays 사이

            const remainingDays = totalDays - passedDays;
            const progressPct = Math.min(100, Math.max(0, (passedDays / totalDays) * 100));

            const isDone = remainingDays <= 0;

            const typeLabel = item.type || '적금';
            let extraInfo = '';

            // 추가 정보 구성 (이자율은 공통, 월 납입액은 적금만)
            const interestInfo = item.interestRate ? ` · 이율 ${item.interestRate}%` : '';
            const monthlyInfo = (typeLabel === '적금' && item.monthlyAmount) ? `월 ${item.monthlyAmount.toLocaleString()}원 납입` : '';

            if (monthlyInfo || interestInfo) {
                extraInfo = `
                    <div style="font-size: 0.8rem; color: var(--text-light); margin-top: 4px;">
                        ${monthlyInfo}${interestInfo}
                    </div>
                `;
            }

            return `
                <div class="savings-item-card">
                    <div class="savings-card-header">
                        <div class="savings-card-title">
                            <h5><span style="color: var(--primary); font-size: 0.85em;">[${typeLabel}]</span> ${safeHTML(item.name)}</h5>
                            <div class="savings-card-amount">${typeLabel === '적금' ? '목표' : '예치'}: ${item.targetAmount ? item.targetAmount.toLocaleString() + '원' : '미정'}</div>
                            ${extraInfo}
                        </div>
                        <div class="savings-card-actions">
                            <button class="btn-edit-savings" data-id="${item.id}" title="수정">✏️</button>
                            <button class="btn-delete-savings" data-id="${item.id}" title="삭제">❌</button>
                        </div>
                    </div>
                    
                    <div class="savings-date-info">
                        <span>${item.startDate} ~ ${item.endDate}</span>
                    </div>

                    <div class="gauge-container">
                        <div class="gauge-meta mb-1">
                            <span>진행률: ${progressPct.toFixed(1)}%</span>
                            <span class="days-left ${isDone ? 'done' : ''}">
                                ${isDone ? '🎉 만기 달성!' : 'D-' + remainingDays}
                            </span>
                        </div>
                        <div class="gauge-bar">
                            <div class="gauge-fill ${isDone ? 'completed' : ''}" style="width: ${progressPct}%"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    const totalAssetModal = document.getElementById('total-asset-modal');
    const closeTotalAssetModalBtn = document.getElementById('close-total-asset-modal');
    if (closeTotalAssetModalBtn) closeTotalAssetModalBtn.onclick = () => totalAssetModal.classList.remove('active');



    function getCalculatedTotalAsset() {
        let totalSum = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const items = state.savingsItems || [];

        items.forEach(item => {
            const start = new Date(item.startDate);
            const type = item.type || '적금';

            if (type === '적금') {
                const monthsPassed = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());
                let currentValue = (Math.max(0, monthsPassed) + 1) * (item.monthlyAmount || 0);

                const endD = new Date(item.endDate);
                const totalMonths = (endD.getFullYear() - start.getFullYear()) * 12 + (endD.getMonth() - start.getMonth());
                const maxVal = totalMonths * (item.monthlyAmount || 0);
                if (currentValue > maxVal) currentValue = maxVal;
                totalSum += currentValue;
            } else {
                totalSum += (item.targetAmount || 0);
            }
        });
        return totalSum;
    }

    window.openTotalAssetModal = () => {
        const body = document.getElementById('total-asset-detail-body');
        const sumEl = document.getElementById('total-asset-sum-modal');
        if (!body || !sumEl) return;

        body.innerHTML = '';
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        state.savingsItems = state.savingsItems || [];

        state.savingsItems.forEach(item => {
            let currentValue = 0;
            const start = new Date(item.startDate);
            const type = item.type || '적금';

            if (type === '적금') {
                // 적금: (시작부터 오늘까지 경과된 개월 수 + 1) * 월 납입액
                const monthsPassed = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());
                currentValue = (Math.max(0, monthsPassed) + 1) * (item.monthlyAmount || 0);

                // 만기 금액(자동계산된 목표액)을 초과하지 않도록 제한
                const startD = new Date(item.startDate);
                const endD = new Date(item.endDate);
                const totalMonths = (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth());
                const maxVal = totalMonths * (item.monthlyAmount || 0);
                if (currentValue > maxVal) currentValue = maxVal;
            } else {
                // 예금: 예치 금액 그대로
                currentValue = item.targetAmount || 0;
            }

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><span class="day-label ${type === '적금' ? 'label-savings' : 'label-income'}" style="width: auto; display: inline-block; padding: 2px 8px;">${type}</span></td>
                <td style="font-weight: 500;">${safeHTML(item.name)}</td>
                <td style="text-align: right; font-weight: 700;">${currentValue.toLocaleString()}원</td>
            `;
            body.appendChild(row);
        });

        const totalSum = getCalculatedTotalAsset();
        sumEl.textContent = `${totalSum.toLocaleString()}원`;
        totalAssetModal.classList.add('active');
    }

    refreshAllUI();
});
