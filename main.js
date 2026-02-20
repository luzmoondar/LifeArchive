document.addEventListener('DOMContentLoaded', async () => {
    // 1. Supabase Configuration
    const SUPABASE_URL = 'https://ljaemqxownqhnrwuhljr.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqYWVtcXhvd25xaG5yd3VobGpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0OTk3NDMsImV4cCI6MjA4NzA3NTc0M30.1HET03hneFsQ-FryAhdUpsOLYy5hvx1CF44_wluD8us';

    // Supabase 클라이언트 초기화
    const { createClient } = supabase;
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

    let currentUser = null;
    const authOverlay = document.getElementById('auth-overlay');
    const authMsg = document.getElementById('auth-msg');

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
        detailData: {
            personal: [],
            shared: [],
            budgets: {
                personal: 0,
                shared: 0
            }
        }
    };

    // 로컬 데이터 먼저 불러오기
    const localData = localStorage.getItem('life-state');
    if (localData) {
        const parsed = JSON.parse(localData);
        state = {
            ...state,
            ...parsed,
            detailData: {
                ...state.detailData,
                ...(parsed.detailData || {})
            }
        };
        // 앱 실행 시 항상 현재 날짜로 초기화하여 가계부/먼슬리가 이번 달을 보여주게 함
        state.viewDates = {
            account: new Date().toISOString().slice(0, 7),
            life: new Date().toISOString().slice(0, 7)
        };
    }

    // Supabase에서 데이터 불러오기
    async function loadFromCloud() {
        if (!currentUser) return;
        try {
            // 현재 로그인한 사용자의 데이터 중 가장 최근 것을 가져옵니다.
            const { data, error } = await supabaseClient
                .from('life')
                .select('content')
                .eq('user_id', currentUser.id)
                .order('id', { ascending: false })
                .limit(1);

            if (error) throw error;

            if (data && data.length > 0) {
                const cloudData = JSON.parse(data[0].content);
                // 기존 데이터와 합칠 때 detailData 구조가 빠지지 않도록 보장
                state = {
                    ...state,
                    ...cloudData,
                    detailData: {
                        ...state.detailData,
                        ...(cloudData.detailData || {})
                    }
                };
                saveToLocal();
                refreshAllUI();
                console.log("Supabase 데이터와 동기화되었습니다.");
            }
        } catch (e) {
            console.error("Supabase 데이터를 불러오는데 실패했습니다:", e);
        }
    }

    function saveToLocal() {
        localStorage.setItem('life-state', JSON.stringify(state));
    }

    async function saveState() {
        saveToLocal();
        updateStats();

        // Supabase에 데이터 저장
        if (!currentUser) return;
        try {
            const { error } = await supabaseClient
                .from('life')
                .insert([{
                    content: JSON.stringify(state),
                    user_id: currentUser.id
                }]);

            if (error) throw error;
        } catch (e) {
            console.error("Supabase 저장 실패:", e);
        }
    }

    function refreshAllUI() {
        refreshCalendars();
        renderCategoryGrids();
        renderIssues();
        renderStockList();
        renderDetailTables();
        updateStats();
    }

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

        // 상세가계부 합계 계산
        const detailPersonalTotal = state.detailData.personal.reduce((sum, item) => sum + (item.amount || 0), 0);
        const detailSharedTotal = state.detailData.shared.reduce((sum, item) => sum + (item.amount || 0), 0);
        const totalDetailExpense = detailPersonalTotal + detailSharedTotal;

        // 전체 통계용 (All Time)
        const totalIncome = state.transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
        const totalBaseExpense = state.transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
        const totalExpense = totalBaseExpense + totalDetailExpense; // 상세지출 포함
        const totalSavings = state.transactions.filter(t => t.type === 'savings').reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('total-income').textContent = `${totalIncome.toLocaleString()}원`;
        document.getElementById('total-expense').textContent = `${totalExpense.toLocaleString()}원`;
        document.getElementById('total-savings').textContent = `${totalSavings.toLocaleString()}원`;

        // 총 보유자산 (수입/지출 합산 없이, '자산' 항목에 입력된 금액만 합산)
        // 사용자가 "총보유자산이 왜 늘어났지? 내가 적어넣은것만 기재해줘"라고 요청함.
        const totalAsset = state.transactions.filter(t => t.type === 'asset').reduce((sum, t) => sum + t.amount, 0);

        const totalAssetStatsEl = document.getElementById('total-asset-stats');
        if (totalAssetStatsEl) totalAssetStatsEl.textContent = `${totalAsset.toLocaleString()}원`;

        // 이번 달 통계용
        const monthlyIncome = state.transactions.filter(t => t.type === 'income' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);
        const monthlyBaseExpense = state.transactions.filter(t => t.type === 'expense' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);
        // 상세가계부는 '현재 선택된 달'의 데이터라고 가정 (별도 날짜 필드가 없으므로)
        const monthlyExpense = monthlyBaseExpense + totalDetailExpense;
        const monthlySavings = state.transactions.filter(t => t.type === 'savings' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('acc-monthly-income').textContent = `${monthlyIncome.toLocaleString()}원`;
        document.getElementById('acc-monthly-expense').textContent = `${monthlyExpense.toLocaleString()}원`;
        document.getElementById('acc-monthly-savings').textContent = `${monthlySavings.toLocaleString()}원`;

        const monthlyBalance = monthlyIncome - monthlyExpense - monthlySavings;
        const balanceEl = document.getElementById('acc-monthly-balance');
        const assetEl = document.getElementById('acc-total-asset');
        if (balanceEl) balanceEl.textContent = `${monthlyBalance.toLocaleString()}원`;
        if (assetEl) assetEl.textContent = `${totalAsset.toLocaleString()}원`;

        updateCharts(totalExpense, totalSavings);
    }

    function updateCharts(totalExpense, totalSavings) {
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

        // 상세가계부 데이터 추가
        const detailPersonal = state.detailData.personal.reduce((sum, item) => sum + (item.amount || 0), 0);
        const detailShared = state.detailData.shared.reduce((sum, item) => sum + (item.amount || 0), 0);

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
            <div class="nav-controls"><button class="nav-btn prev-btn">&lt;</button><button class="nav-btn next-btn">&gt;</button></div>
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
        if (d && n && a > 0) { state.transactions.push({ id: Date.now(), date: d, name: n, cat: currentModalTarget.category, amount: a, type: currentModalTarget.type }); saveState(); renderModalHistory(); refreshCalendars(); renderCategoryGrids(); document.getElementById('modal-name').value = ''; document.getElementById('modal-amount').value = ''; }
    };

    document.getElementById('btn-rename-cat').onclick = () => {
        const oldName = currentModalTarget.category;
        const type = currentModalTarget.type;
        const newName = prompt('새 카테고리 이름을 입력하세요:', oldName);

        if (newName && newName !== oldName) {
            if (state.categories[type].includes(newName)) {
                alert('이미 존재하는 카테고리 이름입니다.');
                return;
            }

            // 1. 카테고리 목록 업데이트
            const idx = state.categories[type].indexOf(oldName);
            if (idx !== -1) {
                state.categories[type][idx] = newName;
            }

            // 2. 관련 내역들의 카테고리명 일괄 변경
            state.transactions.forEach(t => {
                if (t.type === type && t.cat === oldName) {
                    t.cat = newName;
                }
            });

            // 3. 상태 업데이트 및 UI 갱신
            currentModalTarget.category = newName;
            document.getElementById('modal-title').textContent = `${newName} - 내역 추가`;
            saveState();
            refreshAllUI();
            alert('카테고리 이름이 변경되었습니다.');
        }
    };

    function renderModalHistory() {
        const list = document.getElementById('modal-entry-list');
        list.innerHTML = '';
        const entries = state.transactions.filter(t => {
            const isMatchCat = (t.cat === currentModalTarget.category);
            const isMatchIncome = (currentModalTarget.type === 'income' && t.type === 'income');
            const isMatchAsset = (currentModalTarget.type === 'asset' && t.type === 'asset');
            const isMonthMatch = t.date.startsWith(state.viewDates.account);

            // 자산(asset)인 경우 월 필터를 적용하지 않고 전체 내역을 보여줌
            if (currentModalTarget.type === 'asset') {
                return (isMatchCat || isMatchAsset) && t.type === currentModalTarget.type;
            }

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
            loadFromCloud();
        } else {
            currentUser = null;
            authOverlay.classList.add('active');
            document.getElementById('btn-logout').style.display = 'none';
            // 로그아웃 시 상태 초기화 (원하는 경우)
            resetState();
            refreshAllUI();
        }
    });

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
                life: new Date().toISOString().slice(0, 7)
            }
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
            navigator.serviceWorker.register('/sw.js')
                .then(reg => console.log('Service Worker registered!'))
                .catch(err => console.log('Service Worker failed:', err));
        });
    }

    // --- Detailed Account Tab Logic ---
    function renderDetailTables() {
        renderDetailTable('personal', 'personal-table-body');
        renderDetailTable('shared', 'shared-table-body');
        syncBudgetInputs();
    }

    function syncBudgetInputs() {
        const pBudgetInput = document.getElementById('personal-budget');
        const sBudgetInput = document.getElementById('shared-budget');
        if (pBudgetInput) {
            pBudgetInput.value = state.detailData.budgets.personal || '';
            pBudgetInput.oninput = (e) => {
                state.detailData.budgets.personal = parseInt(e.target.value) || 0;
                updateDetailTotals('personal'); // 예산 변동 시 남은 금액 갱신
                saveToLocal();
            };
        }
        if (sBudgetInput) {
            sBudgetInput.value = state.detailData.budgets.shared || '';
            sBudgetInput.oninput = (e) => {
                state.detailData.budgets.shared = parseInt(e.target.value) || 0;
                updateDetailTotals('shared'); // 예산 변동 시 남은 금액 갱신
                saveToLocal();
            };
        }
    }

    function renderDetailTable(type, bodyId) {
        const body = document.getElementById(bodyId);
        if (!body) return;
        body.innerHTML = '';

        if (!state.detailData) state.detailData = { personal: [], shared: [], budgets: { personal: 0, shared: 0 } };
        if (!state.detailData[type]) state.detailData[type] = [];
        const data = state.detailData[type];

        let stateChanged = false;
        // 데이터가 20개 미만이면 20개가 될 때까지 빈 칸 추가 (아이디 겹치지 않게 유의)
        while (data.length < 20) {
            data.push({ id: 'row-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9), title: '', amount: 0 });
            stateChanged = true;
        }
        if (stateChanged) saveToLocal();

        data.forEach((item, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="text-align: center; color: #64748b; font-size: 0.8rem;">${index + 1}</td>
                <td><input type="text" class="detail-title" value="${item.title || ''}" placeholder="내용 입력"></td>
                <td><input type="number" class="detail-amount" value="${item.amount || ''}" placeholder="금액"></td>
                <td><button class="remove-row-btn" title="삭제">&times;</button></td>
            `;

            const titleInput = tr.querySelector('.detail-title');
            const amountInput = tr.querySelector('.detail-amount');
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

            removeBtn.onclick = () => {
                state.detailData[type].splice(index, 1);
                saveState();
                renderDetailTables();
            };

            body.appendChild(tr);
        });

        updateDetailTotals(type);
    }

    function updateDetailTotals(type) {
        const total = state.detailData[type].reduce((sum, item) => sum + (item.amount || 0), 0);
        const totalEl = document.getElementById(`${type}-total`);
        if (totalEl) totalEl.textContent = `${total.toLocaleString()}원`;

        // 남은 금액 계산 (예산 - 합계)
        const budget = state.detailData.budgets[type] || 0;
        const remaining = budget - total;
        const remainingEl = document.getElementById(`${type}-remaining`);
        if (remainingEl) {
            remainingEl.textContent = `${remaining.toLocaleString()}원`;
            // 남은 금액이 음수(예산 초과)면 빨간색으로 표시
            remainingEl.style.color = remaining < 0 ? '#ef4444' : '#2b8a3e';
        }
    }



    document.getElementById('add-personal-row').onclick = () => {
        state.detailData.personal.push({ id: crypto.randomUUID(), title: '', amount: 0 });
        saveState();
        renderDetailTables();
    };

    document.getElementById('add-shared-row').onclick = () => {
        state.detailData.shared.push({ id: crypto.randomUUID(), title: '', amount: 0 });
        saveState();
        renderDetailTables();
    };

    // Initial Render
    refreshAllUI();
});
