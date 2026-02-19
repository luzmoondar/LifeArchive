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
        }
    };

    // 로컬 데이터 먼저 불러오기
    const localData = localStorage.getItem('life-state');
    if (localData) {
        state = JSON.parse(localData);
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
                state = { ...state, ...cloudData };
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
        updateStats();
    }

    // Tab Navigation
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const targetContent = document.getElementById(tab.dataset.tab);
            if (targetContent) targetContent.classList.add('active');
        });
    });

    // --- Statistics & Charts ---
    let expenseChart, savingsChart;

    function updateStats() {
        const currentMonth = state.viewDates.account;
        const totalIncome = state.transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
        const totalExpense = state.transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
        const totalSavings = state.transactions.filter(t => t.type === 'savings').reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('total-income').textContent = `${totalIncome.toLocaleString()}원`;
        document.getElementById('total-expense').textContent = `${totalExpense.toLocaleString()}원`;
        document.getElementById('total-savings').textContent = `${totalSavings.toLocaleString()}원`;

        const monthlyIncome = state.transactions.filter(t => t.type === 'income' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);
        const monthlyExpense = state.transactions.filter(t => t.type === 'expense' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);
        const monthlySavings = state.transactions.filter(t => t.type === 'savings' && t.date.startsWith(currentMonth)).reduce((sum, t) => sum + t.amount, 0);

        document.getElementById('acc-monthly-income').textContent = `${monthlyIncome.toLocaleString()}원`;
        document.getElementById('acc-monthly-expense').textContent = `${monthlyExpense.toLocaleString()}원`;
        document.getElementById('acc-monthly-savings').textContent = `${monthlySavings.toLocaleString()}원`;

        updateCharts(totalExpense, totalSavings);
    }

    function updateCharts(totalExpense, totalSavings) {
        const getCtx = (id) => {
            const el = document.getElementById(id);
            return el ? el.getContext('2d') : null;
        };
        const expenseData = state.categories.expense.map(cat => ({ name: cat, value: state.transactions.filter(t => t.type === 'expense' && t.cat === cat).reduce((sum, t) => sum + t.amount, 0) }));
        const savingsData = state.categories.savings.map(cat => ({ name: cat, value: state.transactions.filter(t => t.type === 'savings' && t.cat === cat).reduce((sum, t) => sum + t.amount, 0) }));
        const chartConfig = (labels, data) => ({
            type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: ['#6366f1', '#10b981', '#ef4444', '#f59e0b', '#ec4899', '#8b5cf6'], borderWidth: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
        const exCtx = getCtx('expense-chart');
        if (exCtx) { if (expenseChart) expenseChart.destroy(); expenseChart = new Chart(exCtx, chartConfig(expenseData.map(d => d.name), expenseData.map(d => totalExpense > 0 ? (d.value / totalExpense) * 100 : 0))); }
        const svCtx = getCtx('savings-chart');
        if (svCtx) { if (savingsChart) savingsChart.destroy(); savingsChart = new Chart(svCtx, chartConfig(savingsData.map(d => d.name), savingsData.map(d => totalSavings > 0 ? (d.value / totalSavings) * 100 : 0))); }
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
            } else {
                // Issues Rendering
                const dayIssues = state.issues.filter(i => i.date === fullDate);
                dayIssues.forEach(issue => {
                    contentDiv.innerHTML += `<div class="day-label label-issue">${issue.checked ? '✓' : ''} ${issue.text}</div>`;
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

    function openModal(category, type) {
        currentModalTarget = { category, type };
        document.getElementById('modal-title').textContent = `${category} - 내역 추가`;
        document.getElementById('modal-date').value = `${state.viewDates.account}-01`;
        document.getElementById('modal-name').value = '';
        document.getElementById('modal-amount').value = '';
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

    function renderModalHistory() {
        const list = document.getElementById('modal-entry-list');
        list.innerHTML = '';
        const entries = state.transactions.filter(t => (t.cat === currentModalTarget.category || (currentModalTarget.type === 'income' && t.type === 'income')) && t.type === currentModalTarget.type && t.date.startsWith(state.viewDates.account));
        entries.sort((a, b) => b.id - a.id).forEach(entry => {
            const item = document.createElement('div'); item.className = 'mini-entry';
            item.innerHTML = `<div class="entry-info"><strong>${entry.name}</strong><span class="entry-date">${entry.date}</span></div><span>${entry.amount.toLocaleString()}원 <button class="delete-btn" style="padding:0; margin-left:5px;">&times;</button></span>`;
            item.querySelector('.delete-btn').onclick = () => { if (confirm('이 내역을 삭제하시겠습니까?')) { state.transactions = state.transactions.filter(t => t.id !== entry.id); saveState(); renderModalHistory(); refreshCalendars(); renderCategoryGrids(); } };
            list.appendChild(item);
        });
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
                        <span>${issue.text}</span>
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
                    <div class="log-header"><strong>${log.item}</strong> <span>수량: ${log.qty}</span></div>
                    <div class="log-amount">금액: ${parseInt(log.amount || 0).toLocaleString()}원</div>
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
                <span>${issue.date ? `<small style="color:var(--text-light); margin-right:5px;">${issue.date.slice(5)}</small>` : ''} ${issue.text}</span>
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
            state.logs.push({ id: Date.now(), date: date, item: i, qty: q, amount: a || 0 });
            document.getElementById('life-day').value = '';
            document.getElementById('life-item').value = '';
            document.getElementById('life-qty').value = '';
            document.getElementById('life-amount').value = '';
            saveState(); refreshCalendars(); alert('기록되었습니다!');
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

    // Initial Render
    refreshAllUI();
});
