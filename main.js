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
        categoryBudgets: {}, // { '식비': 500000, ... }
        monthlyMemos: {} // 이번 달 장기 이슈 및 텍스트 메모
    };

    // --- 이번 달로 날짜 초기화 헬퍼 ---
    function resetViewDatesToToday() {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth() + 1;
        const d = now.getDate();
        const salaryDay = state.salaryDay || 1;

        let accountMonth = `${y}-${String(m).padStart(2, '0')}`;

        if (salaryDay > 1) {
            const range = getDateRangeForMonth(accountMonth, salaryDay);
            const todayStr = formatLocalDate(now);

            if (todayStr > range.end) {
                let nextM = m + 1;
                let nextY = y;
                if (nextM > 12) { nextM = 1; nextY++; }
                accountMonth = `${nextY}-${String(nextM).padStart(2, '0')}`;
            } else if (todayStr < range.start) {
                let prevM = m - 1;
                let prevY = y;
                if (prevM < 1) { prevM = 12; prevY--; }
                accountMonth = `${prevY}-${String(prevM).padStart(2, '0')}`;
            }
        }

        state.viewDates = {
            account: accountMonth,
            life: `${y}-${String(m).padStart(2, '0')}`
        };
    }

    // 로컬 데이터 먼저 불러오기
    const localData = localStorage.getItem('life-state');
    if (localData) {
        const parsed = JSON.parse(localData);
        state = { ...state, ...parsed };

        // Wedding 데이터 이관 지원 및 보호
        state.weddingGifts = Array.isArray(parsed.weddingGifts) ? parsed.weddingGifts : (Array.isArray(parsed.weddingData) ? parsed.weddingData : []);
        state.weddingCosts = Array.isArray(parsed.weddingCosts) ? parsed.weddingCosts : state.weddingCosts;
        state.savingsItems = Array.isArray(parsed.savingsItems) ? parsed.savingsItems : [];
        state.categoryBudgets = parsed.categoryBudgets || {};
        state.monthlyMemos = parsed.monthlyMemos || {};

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
                    ...cloudExpense
                };

                // 데이터 정합성 강제 (배열이 아닐 경우 초기화)
                if (!Array.isArray(state.weddingGifts)) state.weddingGifts = [];
                if (!Array.isArray(state.weddingCosts)) state.weddingCosts = [];
                if (!Array.isArray(state.savingsItems)) state.savingsItems = [];

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

    // --- 금액 포맷팅 (천 단위 콤마) 헬퍼 ---
    function formatAmount(val) {
        if (val === undefined || val === null || val === '') return '';
        const num = String(val).replace(/[^0-9]/g, '');
        if (!num) return '';
        return Number(num).toLocaleString();
    }

    function parseAmount(val) {
        if (!val) return 0;
        return parseInt(String(val).replace(/[^0-9]/g, '')) || 0;
    }

    // 입력창에 실시간 콤마 적용
    function setAmountInput(inputEl) {
        if (!inputEl) return;
        inputEl.addEventListener('input', (e) => {
            const rawValue = e.target.value;
            const numericValue = parseAmount(rawValue);
            e.target.value = formatAmount(numericValue);
        });
    }

    // --- 디바운스된 저장을 위한 변수 ---
    let saveTimeout = null;
    function debouncedSaveState() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveState();
        }, 500); // 0.5초 후 저장
    }

    const btnAddWeddingGiftRow = document.getElementById('btn-add-wedding-gift-row');
    if (btnAddWeddingGiftRow) {
        btnAddWeddingGiftRow.onclick = () => {
            if (!Array.isArray(state.weddingGifts)) state.weddingGifts = [];
            const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substring(2);
            state.weddingGifts.push({ id: newId, name: '', received: 0, paid: 0, attended: false });
            saveState();
            renderWeddingGifts();

            // 새로 추가된 행으로 스크롤 및 포커스
            setTimeout(() => {
                const rows = document.querySelectorAll('#wedding-gift-table-body tr');
                if (rows.length > 0) {
                    const lastRow = rows[rows.length - 1];
                    lastRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const firstInput = lastRow.querySelector('input');
                    if (firstInput) firstInput.focus();
                }
            }, 100);
        };
    }

    const btnAddWeddingCostGroup = document.getElementById('btn-add-wedding-cost-group');
    if (btnAddWeddingCostGroup) {
        btnAddWeddingCostGroup.onclick = () => {
            if (!Array.isArray(state.weddingCosts)) state.weddingCosts = [];
            const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substring(2);
            state.weddingCosts.push({ id: newId, title: '새 카테고리', items: [] });
            saveState();
            renderWeddingCosts();

            // 새로 추가된 그룹으로 스크롤
            setTimeout(() => {
                const groups = document.querySelectorAll('.wedding-cost-subsection');
                if (groups.length > 0) {
                    const lastGroup = groups[groups.length - 1];
                    lastGroup.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    const titleInput = lastGroup.querySelector('.group-title-edit');
                    if (titleInput) {
                        titleInput.focus();
                        titleInput.select();
                    }
                }
            }, 100);
        };
    }
    window.addWeddingGiftRow = () => btnAddWeddingGiftRow?.onclick?.();

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
    let expenseChart, savingsChart, monthlyTrendChart;

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
            rangeInfoEl.style.display = 'block';
            rangeInfoEl.textContent = `📊 집계기간 : ${range.start} ~ ${range.end}`;
        }

        updateCharts(monthlyExpense, monthlySavings);
        renderSavingsItems(); // 자산 현황 카드 동시 업데이트
    }

    function updateCharts(totalExpense, totalSavings) {
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

        const trCtx = getCtx('monthly-trend-chart');
        if (trCtx) {
            if (monthlyTrendChart) monthlyTrendChart.destroy();

            const currentYear = Number(currentMonth.split('-')[0]);
            const trendLabels = [];
            const trendData = [];

            for (let m = 1; m <= 12; m++) {
                trendLabels.push(`${m}월`);
                const mKey = `${currentYear}-${String(m).padStart(2, '0')}`;
                const mRange = getDateRangeForMonth(mKey, salaryDay);
                const mTrans = state.transactions.filter(t => t.date >= mRange.start && t.date <= mRange.end && t.type === 'expense');
                const mTotal = mTrans.reduce((sum, t) => sum + t.amount, 0);
                trendData.push(mTotal);
            }

            monthlyTrendChart = new Chart(trCtx, {
                type: 'bar',
                data: {
                    labels: trendLabels,
                    datasets: [{
                        label: '월별 소비액',
                        data: trendData,
                        backgroundColor: '#6366f1',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    return context.parsed.y.toLocaleString() + '원';
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                callback: function (value) {
                                    return value.toLocaleString();
                                }
                            }
                        }
                    }
                }
            });
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
            titleHtml = `${year}년 ${month}월`;
        }

        header.innerHTML = `
            <h3><button class="date-picker-btn">📅</button> ${titleHtml} <input type="month" class="hidden-date-input" value="${monthKey}"></h3>
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

        // Life 달력을 위한 다중일 포함 슬롯 계산 (수직 위치 정렬용)
        let lifeSlots = {};
        if (type === 'life') {
            const startDateStr = formatLocalDate(startDate);
            const endDateStr = formatLocalDate(endDate);

            const rangeIssues = state.issues.filter(i => {
                const start = i.date;
                const end = i.endDate || i.date;
                return (start <= endDateStr && end >= startDateStr);
            });

            // 날짜순 정렬 후, 긴 일정 먼저 배치
            rangeIssues.sort((a, b) => {
                let startDiff = a.date.localeCompare(b.date);
                if (startDiff !== 0) return startDiff;
                const durA = a.endDate ? new Date(a.endDate).getTime() - new Date(a.date).getTime() : 0;
                const durB = b.endDate ? new Date(b.endDate).getTime() - new Date(b.date).getTime() : 0;
                return durB - durA; // 긴 일정 우선
            });

            rangeIssues.forEach(issue => {
                const issueStart = new Date(issue.date);
                const issueEnd = new Date(issue.endDate || issue.date);
                const drawStart = new Date(Math.max(issueStart.getTime(), startDate.getTime()));
                const drawEnd = new Date(Math.min(issueEnd.getTime(), endDate.getTime()));

                let slot = 0;
                while (true) {
                    let free = true;
                    for (let d = new Date(drawStart); d <= drawEnd; d.setDate(d.getDate() + 1)) {
                        let f = formatLocalDate(d);
                        if (lifeSlots[f] && lifeSlots[f][slot]) { free = false; break; }
                    }
                    if (free) break;
                    slot++;
                }

                for (let d = new Date(drawStart); d <= drawEnd; d.setDate(d.getDate() + 1)) {
                    let f = formatLocalDate(d);
                    if (!lifeSlots[f]) lifeSlots[f] = [];
                    lifeSlots[f][slot] = {
                        type: 'issue',
                        data: issue,
                        isStart: f === issue.date,
                        isEnd: f === (issue.endDate || issue.date)
                    };
                }
            });

            const rangeLogs = state.logs.filter(l => l.date >= startDateStr && l.date <= endDateStr);
            rangeLogs.forEach(log => {
                let f = log.date;
                if (!lifeSlots[f]) lifeSlots[f] = [];
                let slot = 0;
                while (lifeSlots[f][slot]) slot++;
                lifeSlots[f][slot] = { type: 'log', data: log };
            });
        }

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
                if (inc > 0) contentDiv.innerHTML += `<div class="day-label label-income">+ ${inc.toLocaleString()}</div>`;
                if (exp > 0) contentDiv.innerHTML += `<div class="day-label label-expense">- ${exp.toLocaleString()}</div>`;
                if (sav > 0) contentDiv.innerHTML += `<div class="day-label label-savings">★ ${sav.toLocaleString()}</div>`;

                if (dayTrans.length > 0) {
                    dayEl.classList.add('clickable-day');
                    dayEl.onclick = () => openAccountDayModal(fullDate);
                }
            } else {
                const dayItems = lifeSlots[fullDate] || [];
                let hasItem = false;

                let maxSlot = -1;
                for (let i = dayItems.length - 1; i >= 0; i--) {
                    if (dayItems[i]) { maxSlot = i; break; }
                }

                for (let i = 0; i <= maxSlot; i++) {
                    const item = dayItems[i];
                    if (!item) {
                        contentDiv.innerHTML += `<div class="day-label" style="visibility:hidden; height:18px; margin:0; padding:0;"></div>`;
                    } else if (item.type === 'issue') {
                        hasItem = true;
                        const issue = item.data;
                        let classes = 'label-issue';
                        if (issue.checked) classes += ' checked';

                        const isMulti = issue.endDate && issue.endDate !== issue.date;
                        if (isMulti) {
                            classes += ' continuous-issue';
                            if (item.isStart) classes += ' is-start';
                            if (item.isEnd) classes += ' is-end';
                        }

                        // 일정 텍스트는 첫날이나 주의 시작(일요일)에만 표시하고 나머지는 자리만 차지하도록
                        let showText = item.isStart || currentIter.getDay() === 0;
                        if (!isMulti) showText = true;

                        const textHtml = showText ? safeHTML(issue.text) : `<span style="opacity:0">${safeHTML(issue.text)}</span>`;
                        contentDiv.innerHTML += `<div class="day-label ${classes}">${textHtml}</div>`;
                    } else if (item.type === 'log') {
                        hasItem = true;
                        contentDiv.innerHTML += `<div class="day-label label-life">${safeHTML(item.data.item)}(${item.data.qty})</div>`;
                    }
                }

                if (hasItem) {
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

        const memoEl = document.getElementById('monthly-memo');
        if (memoEl && state.viewDates && state.viewDates.life) {
            if (!state.monthlyMemos) state.monthlyMemos = {};
            memoEl.value = state.monthlyMemos[state.viewDates.life] || '';
        }
    }

    function updateDayInputMax() {
        if (!state.viewDates.life) return;
        const [year, month] = state.viewDates.life.split('-').map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const issueDayInput = document.getElementById('new-issue-day');
        const issueEndDayInput = document.getElementById('new-issue-end-day');
        const lifeDayInput = document.getElementById('life-day');
        if (issueDayInput) issueDayInput.max = daysInMonth;
        if (issueEndDayInput) issueEndDayInput.max = daysInMonth;
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
            const items = state.categories[type];

            items.forEach((cat, index) => {
                const amount = state.transactions.filter(t =>
                    t.type === type &&
                    t.cat === cat &&
                    t.date >= range.start &&
                    t.date <= range.end
                ).reduce((s, t) => s + t.amount, 0);

                const budget = state.categoryBudgets[cat] || 0;
                let budgetHtml = '';

                if (type === 'expense') {
                    // 예산이 없어도 0원으로 표시
                    budgetHtml = `<div class="budget-info">예산 : ${budget.toLocaleString()}원</div>`;
                } else {
                    // 저축 카테고리 기호 등 추가 가능 (필요시)
                    budgetHtml = '';
                }

                const card = document.createElement('div');
                card.className = 'category-card';
                card.draggable = true;
                card.dataset.index = index;
                card.dataset.type = type;
                card.innerHTML = `
                    <button class="card-delete-btn" title="삭제">&times;</button>
                    <span class="cat-name">${cat}</span>
                    <span class="cat-amount">${amount.toLocaleString()}원</span>
                    ${budgetHtml}
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
                    } else {
                        openCategoryDetailModal(cat, type);
                    }
                };
                grid.appendChild(card);
            });

            // 항목이 홀수개일 때 빈 칸을 추가하여 2배열 그리드 유지
            if (items.length % 2 !== 0) {
                const emptyCard = document.createElement('div');
                emptyCard.className = 'category-card empty-filler';
                emptyCard.innerHTML = '&nbsp;';
                grid.appendChild(emptyCard);
            }
        };
        renderGrid('expense', 'expense-category-grid'); renderGrid('savings', 'savings-category-grid');
    }

    document.getElementById('add-expense-cat').onclick = () => { const n = prompt('새 소비 카테고리 이름:'); if (n && !state.categories.expense.includes(n)) { state.categories.expense.push(n); saveState(); renderCategoryGrids(); } };
    document.getElementById('add-savings-cat').onclick = () => { const n = prompt('새 저축 카테고리 이름:'); if (n && !state.categories.savings.includes(n)) { state.categories.savings.push(n); saveState(); renderCategoryGrids(); } };

    let currentModalTarget = null;
    // --- Modal Logic ---
    const modal = document.getElementById('entry-modal');
    const catDetailModal = document.getElementById('category-detail-modal');
    const accDayModal = document.getElementById('acc-day-modal');
    const totalAssetModal = document.getElementById('total-asset-modal');
    const closeBtn = document.querySelector('#entry-modal .close-modal');
    const saveBtn = document.getElementById('save-entry');

    window.openModal = openModal;

    const accIncomeCard = document.getElementById('acc-income-card');
    if (accIncomeCard) accIncomeCard.onclick = () => openCategoryDetailModal('수입', 'income');
    const accAssetCard = document.getElementById('acc-asset-card');
    if (accAssetCard) accAssetCard.onclick = () => openModal('자산', 'asset');

    function openModal(category, type, date = null) {
        currentModalTarget = { category, type };

        // 아이콘 포함 타이틀 설정
        const titleSuffix = (type === 'income' || type === 'expense') ? ' - 내역추가' : ' - 내역 추가';
        document.getElementById('modal-title').textContent = `${category}${titleSuffix}`;

        document.getElementById('modal-date').value = date || `${state.viewDates.account}-01`;
        document.getElementById('modal-name').value = '';
        document.getElementById('modal-amount').value = '';

        // 수입/저축일 경우 태그 선택창 숨김
        const tagGroup = document.getElementById('modal-tag-group');
        if (tagGroup) {
            tagGroup.style.display = (type === 'income' || type === 'savings') ? 'none' : 'block';
        }

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
    document.getElementById('close-cat-detail').onclick = () => {
        catDetailModal.classList.remove('active');
        document.body.classList.remove('modal-open');
        renderCategoryGrids(); // 닫을 때 카드 선 복원
    };

    function openCategoryDetailModal(cat, type, showAll = false) {
        currentModalTarget = { category: cat, type, showAll };
        const modal = document.getElementById('category-detail-modal');

        let titleText = '';
        if (cat === '수입') titleText = '이번 달 모든 수입';
        else if (cat === '자산') titleText = '이번 달 모든 자산';
        else titleText = showAll ? `'${cat}' 전체 내역` : `'${cat}' 상세 내역`;

        document.getElementById('cat-detail-title').textContent = titleText;

        // 저축/수입 타입이면 빠른 추가창 표시, 예산창 숨김
        const quickEntrySection = document.getElementById('detail-quick-entry-section');
        const budgetSection = document.getElementById('detail-budget-section');
        const btnAddDetailEntry = document.getElementById('btn-add-detail-entry');

        if (type === 'savings' || type === 'income') {
            if (quickEntrySection) quickEntrySection.style.display = 'block';
            if (budgetSection) budgetSection.style.display = 'none';

            // 빠른 추가 필드 초기화
            document.getElementById('quick-add-date').value = formatLocalDate(new Date());
            document.getElementById('quick-add-name').value = '';
            document.getElementById('quick-add-amount').value = '';
        } else {
            if (quickEntrySection) quickEntrySection.style.display = 'none';
            if (budgetSection) budgetSection.style.display = 'block';
        }

        // 저축 카테고리일 경우 하단 '내역 추가하기' 버튼 숨김 (이미 상단에 빠른 추가창이 있음)
        if (btnAddDetailEntry) {
            btnAddDetailEntry.style.display = (type === 'savings') ? 'none' : 'block';
        }

        document.getElementById('cat-budget-input').value = state.categoryBudgets[cat] || '';
        if (document.getElementById('cat-search-input')) document.getElementById('cat-search-input').value = '';

        // 정렬 상태 초기화
        detailSortOrder = 'newest';
        const sortBtn = document.getElementById('btn-sort-newest');
        if (sortBtn) {
            sortBtn.innerHTML = '최신순 ⬇️';
            sortBtn.style.display = 'inline-block';
        }

        renderCategoryDetail(cat, type);
        modal.classList.add('active');
        document.body.classList.add('modal-open');

        // 모달창 상단으로 스크롤 초기화
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) modalContent.scrollTop = 0;
    }

    // 빠른 내역 추가 저장 버튼
    const btnQuickAddSave = document.getElementById('btn-quick-add-save');
    if (btnQuickAddSave) {
        btnQuickAddSave.onclick = () => {
            const date = document.getElementById('quick-add-date').value;
            const name = document.getElementById('quick-add-name').value.trim();
            const amount = parseAmount(document.getElementById('quick-add-amount').value);

            if (!date || !name || amount <= 0) {
                alert('날짜, 내용, 금액을 모두 입력해주세요.');
                return;
            }

            state.transactions.push({
                id: Date.now(),
                date: date,
                name: name,
                cat: currentModalTarget.category,
                amount: amount,
                type: currentModalTarget.type,
                tag: '기타'
            });

            saveState();
            refreshCalendars();
            renderCategoryGrids();
            updateStats();
            renderCategoryDetail(currentModalTarget.category, currentModalTarget.type);
            renderSavingsItems();

            // 입력 필드 초기화
            document.getElementById('quick-add-name').value = '';
            document.getElementById('quick-add-amount').value = '';
        };
    }
    setAmountInput(document.getElementById('quick-add-amount'));

    function renderCategoryDetail(cat, type) {
        const tbody = document.getElementById('cat-trans-list');
        if (!tbody) return;
        tbody.innerHTML = '';

        const currentMonth = state.viewDates.account;
        const salaryDay = state.salaryDay || 1;
        const range = getDateRangeForMonth(currentMonth, salaryDay);
        const typeToUse = type || currentModalTarget.type;

        const trans = (state.transactions || [])
            .filter(t => {
                const isMatchCat = (cat === '수입' || cat === '자산') ? true : (t.cat === cat);
                const isDateInRange = currentModalTarget.showAll ? true : (t.date >= range.start && t.date <= range.end);
                return isMatchCat && t.type === typeToUse && isDateInRange;
            })
            .sort((a, b) => {
                if (detailSortOrder === 'newest') return b.date.localeCompare(a.date);
                return a.date.localeCompare(b.date);
            });

        if (trans.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-light); padding: 1.5rem;">이번 달 내역이 없습니다.</td></tr>`;
        } else {
            trans.forEach(t => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><input type="checkbox" class="trans-check" data-id="${t.id}"></td>
                    <td style="color:var(--text-light); font-size:0.85rem;">${t.date.slice(5)}</td>
                    <td>
                        <div style="font-weight:600; font-size:0.9rem;">${safeHTML(t.name)}</div>
                        ${t.tag ? `<div style="font-size:0.75rem; color:#94a3b8;">${safeHTML(t.tag)}</div>` : ''}
                    </td>
                    <td style="text-align:right;">
                        <div style="font-weight:700; color:${typeToUse === 'income' ? 'var(--primary)' : typeToUse === 'savings' ? 'var(--success)' : 'var(--danger)'}; white-space:nowrap;">${t.amount.toLocaleString()}원</div>
                    </td>
                    <td style="text-align:center;">
                        <div style="display:flex; gap:4px; justify-content:center;">
                            <button class="edit-trans-btn edit-stock-btn" data-id="${t.id}">수정</button>
                            <button class="delete-trans-btn delete-stock-btn" data-id="${t.id}">삭제</button>
                        </div>
                    </td>
                `;
                tr.querySelector('.edit-trans-btn').onclick = () => {
                    const newName = prompt('내용 수정:', t.name);
                    if (newName === null) return;
                    const newAmt = parseInt(prompt('금액 수정:', t.amount));
                    if (isNaN(newAmt) || newAmt <= 0) return;
                    const newDate = prompt('날짜 수정 (YYYY-MM-DD):', t.date);
                    if (newDate === null) return;
                    t.name = newName;
                    t.amount = newAmt;
                    t.date = newDate;
                    saveState();
                    renderCategoryDetail(cat, typeToUse);
                    refreshCalendars();
                    renderCategoryGrids();
                };
                tr.querySelector('.delete-trans-btn').onclick = () => {
                    if (confirm('이 내역을 삭제하시겠습니까?')) {
                        state.transactions = state.transactions.filter(tr => tr.id !== t.id);
                        saveState();
                        renderCategoryDetail(cat, typeToUse);
                        refreshCalendars();
                        renderCategoryGrids();
                    }
                };
                tbody.appendChild(tr);
            });
        }
    }

    document.getElementById('btn-add-detail-entry').onclick = () => {
        openModal(currentModalTarget.category, currentModalTarget.type);
    };

    document.getElementById('btn-rename-detail-cat').onclick = () => {
        const cat = currentModalTarget.category;
        const type = currentModalTarget.type;
        const newName = prompt('새 카테고리 이름:', cat);
        if (!newName || newName === cat) return;
        if (state.categories[type].includes(newName)) { alert('이미 존재하는 이름입니다.'); return; }
        const idx = state.categories[type].indexOf(cat);
        if (idx !== -1) state.categories[type][idx] = newName;
        state.transactions.forEach(t => { if (t.type === type && t.cat === cat) t.cat = newName; });
        currentModalTarget.category = newName;
        document.getElementById('cat-detail-title').textContent = newName;
        if (state.categoryBudgets[cat]) {
            state.categoryBudgets[newName] = state.categoryBudgets[cat];
            delete state.categoryBudgets[cat];
        }
        saveState(); renderCategoryGrids(); renderCategoryDetail(newName, type);
    };

    document.getElementById('save-cat-budget').onclick = () => {
        const val = parseInt(document.getElementById('cat-budget-input').value) || 0;
        state.categoryBudgets[currentModalTarget.category] = val;
        saveState(); renderCategoryGrids();
    };

    document.getElementById('btn-delete-selected').onclick = () => {
        const selected = [...document.querySelectorAll('.trans-check:checked')].map(el => parseInt(el.dataset.id));
        if (!selected.length) { alert('선택된 항목이 없습니다.'); return; }
        if (!confirm(`${selected.length}개 내역을 삭제하시겠습니까?`)) return;
        state.transactions = state.transactions.filter(t => !selected.includes(t.id));
        saveState();
        renderCategoryDetail(currentModalTarget.category, currentModalTarget.type);
        refreshCalendars(); renderCategoryGrids();
    };

    document.getElementById('close-acc-day-modal').onclick = () => {
        document.getElementById('acc-day-modal').classList.remove('active');
        document.body.classList.remove('modal-open');
    };

    saveBtn.onclick = () => {
        const d = document.getElementById('modal-date').value,
            n = document.getElementById('modal-name').value,
            a = parseAmount(document.getElementById('modal-amount').value);

        const activeChip = document.querySelector('.tag-chip.active');
        const t = activeChip ? activeChip.dataset.value : '기타';

        if (d && n && a > 0) {
            if (currentModalTarget.type === 'wedding') {
                const group = state.weddingCosts.find(g => g.id === currentModalTarget.category);
                if (group) {
                    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substring(2);
                    group.items.push({ id: newId, detail: n, amount: a, memo: '' });
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

            // 상세 모달이 열려있다면 내역 목록 새로고침
            if (catDetailModal.classList.contains('active')) {
                renderCategoryDetail(currentModalTarget.category, currentModalTarget.type);
            }

            document.getElementById('modal-name').value = '';
            document.getElementById('modal-amount').value = '';
        }
    };
    setAmountInput(document.getElementById('modal-amount'));

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
                        <button class="edit-stock-btn">수정</button>
                        <button class="delete-stock-btn">삭제</button>
                    </div>
                `;
                item.querySelector('.edit-stock-btn').onclick = () => {
                    const newName = prompt('내용 수정:', t.name);
                    if (newName === null) return;
                    const newAmt = parseInt(prompt('금액 수정:', t.amount));
                    if (isNaN(newAmt) || newAmt <= 0) return;
                    const newDate = prompt('날짜 수정 (YYYY-MM-DD):', t.date);
                    if (newDate === null) return;

                    t.name = newName;
                    t.amount = newAmt;
                    t.date = newDate;
                    saveState();
                    renderAccountDayContent(date);
                    refreshCalendars();
                    updateStats();
                    renderCategoryGrids();
                };
                item.querySelector('.delete-stock-btn').onclick = () => {
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

        const dayIssues = state.issues.filter(i => {
            if (i.endDate) {
                return date >= i.date && date <= i.endDate;
            }
            return i.date === date;
        });
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
                        <button class="edit-stock-btn">수정</button>
                        <button class="delete-stock-btn">삭제</button>
                    </div>
                `;
                item.querySelector('input').onchange = () => {
                    issue.checked = !issue.checked;
                    saveState();
                    renderLifeDayContent(date);
                    refreshCalendars();
                    renderIssues();
                };
                item.querySelector('.edit-stock-btn').onclick = () => {
                    let currentStartDay = issue.date ? issue.date.split('-')[2] : '';
                    let currentEndDay = issue.endDate ? issue.endDate.split('-')[2] : '';
                    const newStartDay = prompt('시작일 수정 (일):', currentStartDay);
                    if (newStartDay === null) return;
                    const newEndDay = prompt('종료일 수정 (빈칸이면 단일일정):', currentEndDay);
                    if (newEndDay === null) return;
                    const newText = prompt('일정 수정:', issue.text);
                    if (newText === null) return;

                    if (newStartDay) {
                        const [y, m] = state.viewDates.life.split('-');
                        issue.date = `${y}-${m}-${String(newStartDay).padStart(2, '0')}`;
                        if (newEndDay && Number(newEndDay) >= Number(newStartDay)) {
                            issue.endDate = `${y}-${m}-${String(newEndDay).padStart(2, '0')}`;
                        } else {
                            issue.endDate = null;
                        }
                    }
                    issue.text = newText;
                    saveState();
                    renderLifeDayContent(date);
                    refreshCalendars();
                    renderIssues();
                };
                item.querySelector('.delete-stock-btn').onclick = () => {
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
                        <button class="edit-stock-btn">수정</button>
                        <button class="delete-stock-btn">삭제</button>
                    </div>
                `;
                item.querySelector('.edit-stock-btn').onclick = () => {
                    const currentDay = log.date.split('-')[2];
                    const newDay = prompt('날짜 수정 (일):', currentDay);
                    if (newDay === null) return;

                    const newItem = prompt('내용 수정:', log.item);
                    if (newItem === null) return;
                    const newQty = prompt('수량 수정:', log.qty);
                    if (newQty === null) return;
                    const newAmount = prompt('금액 수정:', log.amount || 0);
                    if (newAmount === null) return;

                    if (newDay) {
                        const [y, m] = log.date.split('-');
                        log.date = `${y}-${m}-${String(newDay).padStart(2, '0')}`;
                    }
                    log.item = newItem; log.qty = newQty; log.amount = newAmount;
                    saveState();
                    renderLifeDayContent(date);
                    refreshCalendars();
                    renderStockList();
                };
                item.querySelector('.delete-stock-btn').onclick = () => {
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
            .filter(issue => !issue.date || issue.date.startsWith(currentMonth) || (issue.endDate && issue.endDate.startsWith(currentMonth)))
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
            .forEach(issue => {
                const li = document.createElement('li'); li.className = `todo-item ${issue.checked ? 'checked' : ''}`;
                let dateDisplay = '';
                if (issue.date) {
                    if (issue.endDate && issue.endDate !== issue.date) {
                        dateDisplay = `${issue.date.slice(5)}~${issue.endDate.slice(5)}`;
                    } else {
                        dateDisplay = `${issue.date.slice(5)}`;
                    }
                }
                li.innerHTML = `
                <input type="checkbox" ${issue.checked ? 'checked' : ''}> 
                <span><small style="color:var(--text-light); margin-right:5px; white-space:nowrap;">${dateDisplay}</small> <span class="text-content">${issue.text}</span></span>
                <div class="todo-actions">
                    <button class="edit-stock-btn">수정</button>
                    <button class="delete-stock-btn">삭제</button>
                </div>
            `;
                li.querySelector('input').onchange = () => { issue.checked = !issue.checked; saveState(); renderIssues(); };
                li.querySelector('.edit-stock-btn').onclick = () => {
                    let currentStartDay = issue.date ? issue.date.split('-')[2] : '';
                    let currentEndDay = issue.endDate ? issue.endDate.split('-')[2] : '';
                    const newStartDay = prompt('시작일 수정 (일):', currentStartDay);
                    if (newStartDay === null) return;
                    const newEndDay = prompt('종료일 수정 (빈칸이면 단일일정):', currentEndDay);
                    if (newEndDay === null) return;
                    const newText = prompt('일정 수정:', issue.text);
                    if (newText === null) return;

                    if (newStartDay) {
                        const [y, m] = state.viewDates.life.split('-');
                        issue.date = `${y}-${m}-${String(newStartDay).padStart(2, '0')}`;
                        if (newEndDay && Number(newEndDay) >= Number(newStartDay)) {
                            issue.endDate = `${y}-${m}-${String(newEndDay).padStart(2, '0')}`;
                        } else {
                            issue.endDate = null;
                        }
                    }
                    issue.text = newText;
                    saveState();
                    renderIssues();
                    refreshCalendars();
                };
                li.querySelector('.delete-stock-btn').onclick = () => { if (confirm('이 이슈를 삭제하시겠습니까?')) { state.issues = state.issues.filter(i => i.id !== issue.id); saveState(); renderIssues(); refreshCalendars(); } };
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
                const currentDay = item.date.split('-')[2];
                const newDay = prompt('날짜 수정 (일):', currentDay);
                if (newDay === null) return;

                const newItem = prompt('내용 수정:', item.item);
                if (newItem === null) return;
                const newQty = prompt('수량 수정:', item.qty);
                if (newQty === null) return;
                const newAmount = prompt('금액 수정:', item.amount || 0);
                if (newAmount === null) return;

                const target = state.logs.find(l => l.id === item.id);
                if (target) {
                    if (newDay) {
                        const [y, m] = item.date.split('-');
                        target.date = `${y}-${m}-${String(newDay).padStart(2, '0')}`;
                    }
                    target.item = newItem;
                    target.qty = newQty;
                    target.amount = newAmount;
                    saveState();
                    renderStockList();
                    refreshCalendars();
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
        const startDay = document.getElementById('new-issue-day').value;
        const endDay = document.getElementById('new-issue-end-day').value;
        if (text && startDay) {
            const date = `${state.viewDates.life}-${String(startDay).padStart(2, '0')}`;
            let endDate = null;
            if (endDay) {
                if (Number(endDay) >= Number(startDay)) {
                    endDate = `${state.viewDates.life}-${String(endDay).padStart(2, '0')}`;
                } else {
                    alert('종료일은 시작일보다 크거나 같아야 합니다.');
                    return;
                }
            }
            state.issues.push({ id: Date.now(), text, date, endDate, checked: false });
            document.getElementById('new-issue').value = '';
            document.getElementById('new-issue-day').value = '';
            document.getElementById('new-issue-end-day').value = '';
            saveState(); renderIssues(); refreshCalendars();
        } else if (!startDay) {
            alert('시작일(일)을 입력해주세요.');
        }
    };

    document.getElementById('add-life-log').onclick = () => {
        const day = document.getElementById('life-day').value;
        const i = document.getElementById('life-item').value;
        const q = document.getElementById('life-qty').value;
        const a = document.getElementById('life-amount').value;

        if (day && i && q) {
            const date = `${state.viewDates.life}-${String(day).padStart(2, '0')}`;
            state.logs.push({ id: Date.now(), date: date, item: i, qty: q, amount: parseAmount(a) || 0, inStock: true });
            document.getElementById('life-day').value = '';
            document.getElementById('life-item').value = '';
            document.getElementById('life-qty').value = '';
            document.getElementById('life-amount').value = '';
            saveState(); refreshCalendars(); renderStockList(); alert('기록되었습니다!');
        }
    };
    setAmountInput(document.getElementById('life-amount'));

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
            categoryBudgets: {},
            monthlyMemos: {}
        };
        localStorage.removeItem('life-state');
    }

    // --- Category Detail Modal Event Listeners ---
    document.getElementById('save-cat-budget').onclick = () => {
        const cat = currentModalTarget.category;
        const b = parseAmount(document.getElementById('cat-budget-input').value);
        state.categoryBudgets[cat] = b;
        saveState();
        renderCategoryGrids();
        updateStats();
        alert('예산이 저장되었습니다.');
    };
    setAmountInput(document.getElementById('cat-budget-input'));

    if (document.getElementById('cat-search-input')) {
        document.getElementById('cat-search-input').oninput = () => {
            renderCategoryDetail(currentModalTarget.category, currentModalTarget.type);
        };
    }

    document.getElementById('btn-sort-newest').onclick = () => {
        detailSortOrder = (detailSortOrder === 'newest') ? 'oldest' : 'newest';
        document.getElementById('btn-sort-newest').innerHTML = (detailSortOrder === 'newest') ? '최신순 ⬇️' : '오래된순 ⬆️';
        renderCategoryDetail(currentModalTarget.category, currentModalTarget.type);
    };

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
                for (let i = 0; i < 5; i++) {
                    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substring(2);
                    group.items.push({ id: newId, detail: '', amount: 0, memo: '' });
                }
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
                                <th style="width: 110px;">내용</th>
                                <th style="width: 100px;">금액</th>
                                <th>비고</th>
                                <th style="width: 35px;"></th>
                            </tr>
                        </thead>
                        <tbody class="group-body"></tbody>
                        <tfoot style="background: #fdfdfd; border-top: 1px solid #eef2f6;">
                            <tr>
                                <td class="total-label" style="background:#f8fafc; border:none; font-size: 0.8rem; text-align: right; padding-right: 1rem;">합계</td>
                                <td class="total-amount group-total" style="text-align:right; padding-right:0.6rem; background:#f8fafc; border:none; white-space: nowrap; font-size: 0.8rem;">0원</td>
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

            titleInput.oninput = (e) => { group.title = e.target.value; debouncedSaveState(); };

            addRowBtn.onclick = () => {
                const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substring(2);
                group.items.push({ id: newId, detail: '', amount: 0, memo: '' });
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
                    <td><input type="text" class="item-amount" value="${formatAmount(item.amount)}" placeholder="금액" style="text-align: right;"></td>
                    <td><input type="text" class="item-memo" value="${safeHTML(item.memo) || ''}" placeholder="비고"></td>
                    <td class="row-action-cell"><button class="remove-row-btn">✕</button></td>
                `;

                tr.querySelector('.item-detail').oninput = (e) => { item.detail = e.target.value; debouncedSaveState(); };
                const amountInput = tr.querySelector('.item-amount');
                setAmountInput(amountInput);
                amountInput.addEventListener('input', (e) => {
                    item.amount = parseAmount(e.target.value);
                    debouncedSaveState();
                    updateWeddingSummary();
                    calculateGroupTotal(group, groupTotalEl);
                });
                tr.querySelector('.item-memo').oninput = (e) => { item.memo = e.target.value; debouncedSaveState(); };
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



    function renderWeddingGifts() {
        const body = document.getElementById('wedding-gift-table-body');
        if (!body) return;
        body.innerHTML = '';

        // 기본적으로 최소 10개의 빈 행을 유지 (기존 20개에서 조정하여 가시성 개선)
        while (state.weddingGifts.length < 10) {
            const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).substring(2);
            state.weddingGifts.push({ id: newId, name: '', received: 0, paid: 0, attended: false });
        }

        state.weddingGifts.forEach((item, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="text-align:center; font-size:0.8rem; color:#64748b;">${idx + 1}</td>
                <td><input type="text" class="gift-name" value="${safeHTML(item.name) || ''}" placeholder="이름"></td>
                <td><input type="text" class="gift-received" value="${formatAmount(item.received)}" placeholder="0" style="text-align: right;"></td>
                <td><input type="text" class="gift-paid" value="${formatAmount(item.paid)}" placeholder="0" style="text-align: right;"></td>
                <td>
                    <div class="wedding-attended-cell">
                        <input type="checkbox" class="is-attended" ${item.attended ? 'checked' : ''}>
                    </div>
                </td>
                <td class="row-action-cell"><button class="remove-row-btn">✕</button></td>
            `;

            tr.querySelector('.gift-name').oninput = (e) => { item.name = e.target.value; debouncedSaveState(); };

            const recInput = tr.querySelector('.gift-received');
            setAmountInput(recInput);
            recInput.addEventListener('input', (e) => {
                item.received = parseAmount(e.target.value);
                debouncedSaveState();
                updateWeddingSummary();
            });

            const paidInput = tr.querySelector('.gift-paid');
            setAmountInput(paidInput);
            paidInput.addEventListener('input', (e) => {
                item.paid = parseAmount(e.target.value);
                debouncedSaveState();
                updateWeddingSummary();
            });
            tr.querySelector('.is-attended').onchange = (e) => { item.attended = e.target.checked; debouncedSaveState(); };
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

            // 기준일이 바뀌면 오늘이 포함된 회차로 자동 이동
            resetViewDatesToToday();

            saveState();
            refreshAllUI();
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
            const monthlyAmount = parseAmount(document.getElementById('savings-monthly-amount').value);
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
                targetAmount = parseAmount(document.getElementById('savings-target-amount').value);
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
        setAmountInput(document.getElementById('savings-target-amount'));
        setAmountInput(document.getElementById('savings-monthly-amount'));
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
                } else {
                    const card = e.target.closest('.savings-item-card');
                    if (card && card.dataset.cat) {
                        openCategoryDetailModal(card.dataset.cat, 'savings', true);
                    }
                }
            });
            listEl.dataset.listener = 'true';
        }

        state.savingsItems = state.savingsItems || [];
        const savingsCats = state.categories.savings || [];

        if (savingsCats.length === 0 && state.savingsItems.length === 0) {
            listEl.innerHTML = `<div class="savings-empty-state">가계부의 '저축' 카테고리에 항목을 추가하거나 우측 상단의 + 버튼을 눌러 적금/예금을 등록해보세요.</div>`;
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // 1. 모든 저축 카테고리 기준 데이터 구성
        const allItems = savingsCats.map(cat => {
            const item = state.savingsItems.find(i => i.name === cat);
            const accumulatedValue = (state.transactions || [])
                .filter(t => t.type === 'savings' && t.cat === cat)
                .reduce((sum, t) => sum + t.amount, 0);

            return { cat, item, accumulatedValue };
        });

        // 2. 카테고리에는 없지만 savingsItems에만 있는 항목 추가 (데이터 정합성 대비)
        state.savingsItems.forEach(si => {
            if (!savingsCats.includes(si.name)) {
                allItems.push({ cat: si.name, item: si, accumulatedValue: 0 }); // 혹은 트랜잭션 찾기
            }
        });

        listEl.innerHTML = allItems.map(({ cat, item, accumulatedValue }) => {
            if (item) {
                // 상세 정보가 있는 경우 (기존 게이지 바 카드)
                const start = new Date(item.startDate);
                const end = new Date(item.endDate);
                const totalDays = Math.max(1, Math.floor((end - start) / (1000 * 60 * 60 * 24)));
                let passedDays = Math.floor((today - start) / (1000 * 60 * 60 * 24));
                passedDays = Math.max(0, Math.min(passedDays, totalDays));
                const remainingDays = totalDays - passedDays;
                const progressPct = Math.min(100, Math.max(0, (passedDays / totalDays) * 100));
                const isDone = remainingDays <= 0;
                const typeLabel = item.type || '적금';
                const interestInfo = item.interestRate ? ` · 이율 ${item.interestRate}%` : '';
                const monthlyInfo = (typeLabel === '적금' && item.monthlyAmount) ? `월 ${item.monthlyAmount.toLocaleString()}원 납입` : '';

                return `
                    <div class="savings-item-card clickable-card" data-cat="${cat}">
                        <div class="savings-card-header">
                            <div class="savings-card-title">
                                <h5><span style="color: var(--primary); font-size: 0.85em;">[${typeLabel}]</span> ${safeHTML(cat)}</h5>
                                <div class="savings-card-amount">누적 금액: ${accumulatedValue.toLocaleString()}원</div>
                                <div style="font-size: 0.8rem; color: var(--text-light); margin-top: 4px;">
                                    ${monthlyInfo}${interestInfo}
                                </div>
                            </div>
                            <div class="savings-card-actions">
                                <button class="btn-edit-savings edit-stock-btn" data-id="${item.id}" title="수정">수정</button>
                                <button class="btn-delete-savings delete-stock-btn" data-id="${item.id}" title="삭제">삭제</button>
                            </div>
                        </div>
                        <div class="savings-date-info">
                            <span>${item.startDate} ~ ${item.endDate}</span>
                        </div>
                        <div class="gauge-container">
                            <div class="gauge-meta mb-1">
                                <span>진행률: ${progressPct.toFixed(1)}%</span>
                                <span class="days-left ${isDone ? 'done' : ''}">${isDone ? '🎉 만기 달성!' : 'D-' + remainingDays}</span>
                            </div>
                            <div class="gauge-bar">
                                <div class="gauge-fill ${isDone ? 'completed' : ''}" style="width: ${progressPct}%"></div>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                // 상세 정보가 없는 경우 (심플 카드)
                return `
                    <div class="savings-item-card clickable-card" data-cat="${cat}" style="border-left: 4px solid #cbd5e1; background: #fdfdfd;">
                        <div class="savings-card-header">
                            <div class="savings-card-title">
                                <h5><span style="color: #64748b; font-size: 0.85em;">[미지정]</span> ${safeHTML(cat)}</h5>
                                <div class="savings-card-amount">누적 금액: ${accumulatedValue.toLocaleString()}원</div>
                                <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 4px;">
                                    상세 정보(이율, 만기일 등)가 없습니다.
                                </div>
                            </div>
                            <div class="savings-card-actions">
                                <button class="edit-stock-btn" onclick="openAssetEditByName('${cat}')" style="font-size: 0.75rem; padding: 4px 10px;">관리</button>
                            </div>
                        </div>
                        <div style="margin-top: 15px; padding: 10px; background: #f1f5f9; border-radius: 6px; font-size: 0.8rem; color: #64748b; text-align: center;">
                            가계부 기록을 통해 금액이 자동으로 누적됩니다.
                        </div>
                    </div>
                `;
            }
        }).join('');
    }


    const closeTotalAssetModalBtn = document.getElementById('close-total-asset-modal');
    if (closeTotalAssetModalBtn) closeTotalAssetModalBtn.onclick = () => totalAssetModal.classList.remove('active');



    function getCalculatedTotalAsset() {
        // 실제 기록된 모든 저축 내역의 합계를 산출
        return (state.transactions || [])
            .filter(t => t.type === 'savings')
            .reduce((sum, t) => sum + t.amount, 0);
    }

    window.openTotalAssetModal = () => {
        const body = document.getElementById('total-asset-detail-body');
        const sumEl = document.getElementById('total-asset-sum-modal');
        if (!body || !sumEl) return;

        body.innerHTML = '';
        state.savingsItems = state.savingsItems || [];

        // 1. 모든 저축 카테고리 추출
        const savingsCats = state.categories.savings || [];

        // 2. 각 카테고리별 누적 금액 및 정보 매칭
        savingsCats.forEach(cat => {
            const accumulatedValue = state.transactions
                .filter(t => t.type === 'savings' && t.cat === cat)
                .reduce((sum, t) => sum + t.amount, 0);

            // 해당 카테고리와 이름이 같은 저축 정보 찾기
            let item = state.savingsItems.find(i => i.name === cat);
            const type = item ? item.type : '적금';
            const interestInfo = (item && item.interestRate) ? `<br><small style="color:var(--text-light); font-weight:normal;">이율: ${item.interestRate}%</small>` : '';
            const periodInfo = (item && item.startDate && item.endDate) ? `<br><small style="color:var(--text-light); font-weight:normal;">${item.startDate.slice(2)}~${item.endDate.slice(2)}</small>` : '';

            const row = document.createElement('tr');
            row.innerHTML = `
                <td style="vertical-align: middle;"><span class="day-label ${type === '적금' ? 'label-savings' : 'label-income'}" style="width: auto; display: inline-block; padding: 2px 8px;">${type}</span></td>
                <td>
                    <div style="font-weight: 600;">${safeHTML(cat)}</div>
                    ${interestInfo}${periodInfo}
                </td>
                <td style="text-align: right; font-weight: 700; vertical-align: middle;">${accumulatedValue.toLocaleString()}원</td>
                <td style="text-align: center; vertical-align: middle;">
                    <button class="edit-stock-btn" onclick="openAssetEditByName('${cat}')" style="padding: 4px 8px; font-size: 0.75rem;">관리</button>
                </td>
            `;
            body.appendChild(row);
        });

        const totalSum = getCalculatedTotalAsset();
        sumEl.textContent = `${totalSum.toLocaleString()}원`;
        totalAssetModal.classList.add('active');
    };

    // 자산 상세에서 이름으로 편집 창 열기
    window.openAssetEditByName = (name) => {
        let item = state.savingsItems.find(i => i.name === name);
        if (!item) {
            // 정보가 없으면 새로 생성 유도
            if (confirm(`'${name}' 상품의 상세 정보(이율, 만기일 등)가 없습니다. 새로 등록하시겠습니까?`)) {
                currentEditingSavingsId = null;
                document.getElementById('savings-name').value = name;
                document.getElementById('savings-type').value = '적금';
                if (savingsTypeSelect) savingsTypeSelect.dispatchEvent(new Event('change'));
                document.getElementById('savings-start-date').value = formatLocalDate(new Date());
                document.getElementById('savings-end-date').value = '';
                document.getElementById('savings-monthly-amount').value = '';
                document.getElementById('savings-interest').value = '';
                savingsModal.classList.add('active');
            }
        } else {
            window.editSavingsItem(item.id);
        }
    };

    const monthlyMemoEl = document.getElementById('monthly-memo');
    if (monthlyMemoEl) {
        monthlyMemoEl.addEventListener('input', (e) => {
            if (!state.monthlyMemos) state.monthlyMemos = {};
            state.monthlyMemos[state.viewDates.life] = e.target.value;
            saveToLocal();
        });
        monthlyMemoEl.addEventListener('change', () => {
            saveState(); // 포커스가 빠질 때 클라우드 동기화
        });
    }

    refreshAllUI();
});
