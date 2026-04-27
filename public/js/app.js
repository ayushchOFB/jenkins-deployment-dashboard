/**
 * OASYS Jenkins Dashboard — STG Tab View
 * ──────────────────────────────────────
 * Fetches live data from /api/deployments, extracts environments,
 * renders clickable STG tabs, and shows jobs per environment in a table.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const REFRESH_SEC = 30;
const MONITOR_POLL_MS = 3000;
const LOG_POLL_MS = 2000;
const TAB_COLORS = [
    '#4a7cf7', '#f59e0b', '#22c55e', '#ef4444',
    '#a78bfa', '#06b6d4', '#f97316', '#ec4899',
    '#10b981', '#8b5cf6',
];

// Job avatar colour pairs (gradient)
const JOB_COLORS = [
    ['#4a7cf7', '#7c3aed'], ['#f59e0b', '#ef4444'], ['#22c55e', '#06b6d4'],
    ['#ec4899', '#a78bfa'], ['#f97316', '#f59e0b'], ['#10b981', '#22c55e'],
    ['#8b5cf6', '#4a7cf7'], ['#6366f1', '#a78bfa'],
];

// ── State ──────────────────────────────────────────────────────────────────
let allDeployments = [];   // flat array from /api/deployments
let activeEnv = 'all';
let countdown = REFRESH_SEC;
let countdownTimer = null;
let configuredJobs = [];   // from /api/jobs (includes libraries)
let serverStatus = [];     // from /api/server-status

// Phase 2 state
let selectedLibs = new Set();
let logPolling = false;
let logStart = 0;
let monitorPolling = false;
let scrollLock = true;
let isFetchingData = false;

// ── Utility ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const esc = str => String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const relTime = iso => {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min${m > 1 ? 's' : ''} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
};

const fmtFull = iso => iso
    ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

const statusLabel = s => ({
    SUCCESS: 'Success', FAILED: 'Failed', RUNNING: 'Running',
    ABORTED: 'Aborted', UNSTABLE: 'Unstable', NO_BUILDS: 'No Builds',
    ERROR: 'Error', UNKNOWN: 'Unknown'
})[s] || s;

/** Consistent colour index from string seed */
const hashIdx = (str, len) => {
    let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
    return Math.abs(h) % len;
};

const jobColors = name => JOB_COLORS[hashIdx(name, JOB_COLORS.length)];

/** Returns first 2 uppercase chars as avatar initials */
const initials = name => {
    const parts = name.replace(/[-_]/g, ' ').split(' ').filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (name.substring(0, 2)).toUpperCase();
};

// ── Derived Data ──────────────────────────────────────────────────────────
const getEnvs = () => {
    const defaultEnvs = ['stg1', 'stg2', 'stg3', 'stg4', 'stg5', 'stg6', 'stg7', 'stg8', 'stg9', 'stg10', 'uat1', 'uat2'];
    const envSet = new Set(defaultEnvs);
    allDeployments.forEach(d => { if (d.environment && d.environment !== '—') envSet.add(d.environment); });
    return ['all', ...Array.from(envSet).sort((a, b) => {
        // Sort: stg1 < stg2 < stg10 < otherstuff
        const an = parseInt(a.replace(/\D/g, ''), 10);
        const bn = parseInt(b.replace(/\D/g, ''), 10);
        if (!isNaN(an) && !isNaN(bn)) return an - bn;
        return a.localeCompare(b);
    })];
};

const applyFilters = (data) => {
    const q = $('searchInput').value.trim().toLowerCase();
    const job = $('filterJob').value;
    return data.filter(d => {
        if (job && d.job !== job) return false;
        if (q) {
            const hay = `${d.job} ${d.branch} ${d.deployedBy} ${d.commit}`.toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
};

const getVisibleDeployments = () => {
    let data = allDeployments;
    if (activeEnv !== 'all') {
        // Include jobs matching the selected env AND jobs with no env param
        // (compile-only jobs like Informer-Compile, OFB-Scheduler-Compile, etc.)
        data = data.filter(d => d.environment === activeEnv || d.environment === '—');
    }
    return applyFilters(data);
};

// ── Render Functions ───────────────────────────────────────────────────────
const renderTabs = () => {
    const envs = getEnvs();
    const tabs = $('envTabs');
    tabs.innerHTML = envs.map((env, idx) => {
        const isAll = env === 'all';
        const color = isAll ? '#8b93b0' : TAB_COLORS[hashIdx(env, TAB_COLORS.length)];
        const jobs = isAll ? allDeployments : allDeployments.filter(d => d.environment === env);
        const count = jobs.length;
        const hasErr = jobs.some(d => d.status === 'FAILED' || d.status === 'ERROR');
        const hasRun = jobs.some(d => d.status === 'RUNNING');
        const label = isAll ? 'All' : env.toUpperCase();
        const active = activeEnv === env ? 'active' : '';
        const errClass = hasErr ? 'has-error' : (hasRun ? 'has-running' : '');

        return `<button
            class="env-tab ${isAll ? 'tab-all' : ''} ${active} ${errClass}"
            data-env="${esc(env)}"
            style="--tab-color:${color}"
            onclick="selectEnv('${esc(env)}')"
        >
            <div class="tab-status-dot"></div>
            <span class="env-tab-name">${esc(label)}</span>
            <span class="env-tab-count">${count} Job${count !== 1 ? 's' : ''}</span>
        </button>`;
    }).join('');
};

/** Render a standard table row */
const renderRow = (d) => {
    const [ca, cb] = jobColors(d.job);
    const ini = initials(d.job);
    const userIni = initials(d.deployedBy !== '—' ? d.deployedBy : '??');
    const jenUrl = esc(d.url || '#');
    const userDisplay = d.deployedBy !== '—' ? d.deployedBy.split('@')[0] : '—';

    return `<tr>
        <td>
            <div class="job-cell">
                <div class="job-avatar" style="--job-c-a:${ca};--job-c-b:${cb}">${ini}</div>
                <div>
                    <a href="${jenUrl}" target="_blank" class="job-name-link">${esc(d.job)}</a>
                    ${d.environment !== '—' ? `<div class="job-sub">${esc(d.environment.toUpperCase())}</div>` : ''}
                </div>
            </div>
        </td>
        <td>
            ${d.branch !== '—'
            ? `<span class="branch-tag"><span class="branch-icon">⎇</span>${esc(d.branch)}</span>`
            : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td class="build-num">${d.buildNumber !== null ? `#${esc(String(d.buildNumber))}` : '—'}</td>
        <td>
            <div class="sp sp-${esc(d.status)}">
                <div class="dot"></div>${esc(statusLabel(d.status))}
            </div>
        </td>
        <td>
            ${userDisplay !== '—'
            ? `<div class="user-cell">
                     <div class="user-avatar">${userIni}</div>
                     <span class="user-name" title="${esc(d.deployedBy)}">${esc(userDisplay)}</span>
                   </div>`
            : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td class="time-cell" title="${esc(fmtFull(d.timestamp))}">${relTime(d.timestamp)}</td>
        <td><button class="btn-hist" onclick="openHistory('${esc(d.job)}')">History</button></td>
    </tr>`;
};

const renderTable = () => {
    const data = getVisibleDeployments();
    const wrap = $('tableWrap');
    const empty = $('emptyState');
    const noEnv = $('noEnvJobs');

    $('loadingState').classList.add('hidden');
    noEnv.classList.add('hidden');
    empty.classList.add('hidden');
    wrap.classList.add('hidden');

    if (allDeployments.length === 0) {
        empty.classList.remove('hidden');
        return;
    }

    if (data.length === 0) {
        noEnv.classList.remove('hidden');
        return;
    }

    wrap.classList.remove('hidden');

    $('tableBody').innerHTML = data.map(d => renderRow(d)).join('');

    $('lastUpdateText').textContent = 'Just now';
};

// ── Environment Selection ──────────────────────────────────────────────────
window.selectEnv = (env) => {
    activeEnv = env;
    serverStatus = []; // Clear old env data so skeleton shows immediately
    renderTabs();
    renderTable();
    fetchServerStatus(true, true); // quiet = true, isTabSwitch = true

    // Kick off a background Jenkins refresh when switching tabs
    // so any new deployments are pulled automatically for this fresh view.
    if (!isFetchingData) {
        fetchData(true, true); // skipServerStatus — selectEnv already handles it
        startCountdown();
    }
};

// ── Filter Population ──────────────────────────────────────────────────────
const populateJobFilter = () => {
    const sel = $('filterJob');
    const current = sel.value;
    const jobs = [...new Set(allDeployments.map(d => d.job))].sort();
    sel.innerHTML = `<option value="">Filter: All Jobs</option>` +
        jobs.map(j => `<option value="${esc(j)}"${j === current ? ' selected' : ''}>${esc(j)}</option>`).join('');
};

// ── Fetch & Refresh ────────────────────────────────────────────────────────
const fetchData = async (quiet = false, skipServerStatus = false) => {
    if (isFetchingData) return;
    isFetchingData = true;

    if (!quiet) {
        $('loadingState').classList.remove('hidden');
        $('tableWrap').classList.add('hidden');
        $('emptyState').classList.add('hidden');
    }
    $('refreshBtn').classList.add('spinning');
    $('refreshText').textContent = '…';
    document.querySelector('.rdot').classList.add('loading');

    try {
        const MAX_RETRIES = 2;
        let success = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                const res = await fetch('/api/deployments', { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!res.ok) throw new Error(`Server: ${res.status}`);
                allDeployments = await res.json();

                $('loadingState').classList.add('hidden');
                $('emptyState').classList.add('hidden');
                $('tableWrap').classList.remove('hidden');
                renderTabs();
                populateJobFilter();
                renderTable();

                if (!quiet) showToast(`✅ Loaded ${allDeployments.length} deployments`);
                success = true;
                break;
            } catch (err) {
                console.error(`Fetch error (attempt ${attempt}/${MAX_RETRIES}):`, err);
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
        if (!success) {
            $('loadingState').classList.add('hidden');
            // Only show empty state if we have no existing data
            if (!allDeployments.length) {
                $('emptyState').classList.remove('hidden');
            }
            if (!quiet) showToast('⚠️ Failed to load Jenkins data', 'err');
        }
    } finally {
        $('refreshBtn').classList.remove('spinning');
        $('refreshText').textContent = 'Live';
        document.querySelector('.rdot').classList.remove('loading');
        isFetchingData = false;
    }

    // Also fetch server status (skip if tab switch already triggered it)
    if (!skipServerStatus) await fetchServerStatus(quiet);
};

const fetchServerStatus = async (quiet = false, isTabSwitch = false) => {
    if (activeEnv === 'all') {
        serverStatus = [];
        renderServerStatus();
        return;
    }

    const section = $('serverStatusSection');
    const grid = $('serverGrid');
    const summary = $('statusSummary');
    section.classList.remove('hidden');

    // Show skeleton cards while loading (always on first load or tab switch, not on quiet refresh if we have data)
    if (!serverStatus.length || isTabSwitch) {
        summary.textContent = 'Checking services...';
        grid.innerHTML = Array.from({ length: 6 }, () => `
            <div class="server-card skeleton-card">
                <div class="skeleton-line" style="width:60%;height:14px;margin-bottom:8px"></div>
                <div class="skeleton-line" style="width:40%;height:12px;margin-bottom:16px"></div>
                <div class="skeleton-line" style="width:30%;height:12px;margin-bottom:12px"></div>
                <div class="skeleton-line" style="width:50%;height:10px"></div>
            </div>
        `).join('');
    }

    try {
        const res = await fetch(`/api/server-status?env=${encodeURIComponent(activeEnv)}`);
        if (!res.ok) throw new Error(`Server: ${res.status}`);
        serverStatus = await res.json();
        renderServerStatus();
    } catch (err) {
        console.error('Fetch server status error:', err);
        if (!quiet) showToast(`⚠️ Failed to load Server status for ${activeEnv}`, 'err');
        
        if (isTabSwitch || !serverStatus.length) {
            const grid = $('serverGrid');
            const summary = $('statusSummary');
            grid.innerHTML = '<div style="grid-column: 1/-1; padding: 20px; text-align: center; color: #ef4444;">Failed to load server status.</div>';
            summary.textContent = 'Status unknown';
        }
    }
};

const renderServerStatus = () => {
    const section = $('serverStatusSection');
    const grid = $('serverGrid');
    const summary = $('statusSummary');

    if (activeEnv === 'all') {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    if (!serverStatus.length) {
        grid.innerHTML = '<div style="grid-column: 1/-1; padding: 20px; text-align: center; color: var(--text-muted);">No services configured for monitoring.</div>';
        summary.textContent = 'No services';
        return;
    }

    const upCount = serverStatus.filter(s => s.status === 'UP' || s.status === 'UP_SLOW').length;
    summary.textContent = `${upCount} / ${serverStatus.length} services online`;

    grid.innerHTML = serverStatus.map(s => {
        let statusClass = 'status-down';
        let statusIcon = '🔴';
        let statusText = 'DOWN';

        if (s.status === 'UP') {
            statusClass = 'status-up';
            statusIcon = '🟢';
            statusText = 'UP';
        } else if (s.status === 'UP_SLOW') {
            statusClass = 'status-slow';
            statusIcon = '🟡';
            statusText = 'SLOW';
        }

        return `
            <div class="server-card">
                <div class="server-card-top">
                    <div class="server-name-wrap">
                        <span class="server-name">${esc(s.service)}</span>
                        <span class="server-env">${esc(s.environment)}</span>
                    </div>
                    <div class="server-status-badge ${statusClass}">
                        <div class="status-dot"></div>
                        <span>${statusText}</span>
                    </div>
                </div>
                <div class="server-card-details">
                    <span class="server-response-time">⏱️ ${esc(s.responseTime)}</span>
                    ${s.branch ? `<span class="server-branch" title="${esc(s.branch)}">🌿 ${esc(s.branch)}</span>` : ''}
                </div>
                <div class="server-card-footer">
                    <span>Last checked: ${relTime(s.lastChecked)}</span>
                </div>
            </div>
        `;
    }).join('');
};

const startCountdown = () => {
    countdown = REFRESH_SEC;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        countdown--;
        $('refreshText').textContent = countdown > 5 ? 'Live' : `${countdown}s`;
        if (countdown <= 0) { countdown = REFRESH_SEC; fetchData(true); }
    }, 1000);
};

// ── History Modal ──────────────────────────────────────────────────────────
window.openHistory = async (job) => {
    const modal = $('historyModal');
    modal.classList.remove('hidden');
    $('modalTitle').textContent = job;
    $('modalSubtitle').textContent = 'Last 20 builds from Jenkins';
    $('modalBody').innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;

    try {
        const res = await fetch(`/api/history/${encodeURIComponent(job)}`);
        const data = await res.json();
        const hist = data.history || [];

        if (!hist.length) {
            $('modalBody').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><h3>No history</h3><p>No past builds found for this job.</p></div>`;
            return;
        }

        $('modalBody').innerHTML = `<div>` + hist.map(h => `
        <div class="hist-item">
            <span class="hist-num">#${h.buildNumber ?? '?'}</span>
            <div class="hist-body">
                <div class="hist-top">
                    <span class="hist-branch">${esc(h.branch)}</span>
                    <span class="hist-commit">${esc(h.commit)}</span>
                    <div class="sp sp-${esc(h.status)}"><div class="dot"></div>${esc(statusLabel(h.status))}</div>
                    ${h.environment !== '—' ? `<span style="font-size:11px;color:var(--text-muted)">${esc(h.environment.toUpperCase())}</span>` : ''}
                </div>
                <div class="hist-meta">
                    <span>👤 ${esc((h.deployedBy || '—').split('@')[0])}</span>
                    <span>🕐 ${esc(fmtFull(h.timestamp))}</span>
                    <span>${relTime(h.timestamp)}</span>
                </div>
            </div>
            <a class="hist-link" href="${esc(h.url || '#')}" target="_blank">↗</a>
        </div>`).join('') + `</div>`;
    } catch (err) {
        $('modalBody').innerHTML = `<div class="empty-state"><h3>Error</h3><p>${esc(err.message)}</p></div>`;
    }
};

const closeModal = () => $('historyModal').classList.add('hidden');

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
const showToast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
};

// ── Events ─────────────────────────────────────────────────────────────────
$('refreshBtn').addEventListener('click', () => { fetchData(); startCountdown(); });
$('modalClose').addEventListener('click', closeModal);
$('historyModal').addEventListener('click', e => { if (e.target === $('historyModal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

$('searchInput').addEventListener('input', () => { renderTabs(); renderTable(); });
$('filterJob').addEventListener('change', () => { renderTabs(); renderTable(); });

// ── Theme Management ──────────────────────────────────────────────────────
const initTheme = () => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
        updateThemeIcon(savedTheme);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
        updateThemeIcon('dark');
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
        updateThemeIcon('light');
    }
};

const toggleTheme = () => {
    const current = document.documentElement.getAttribute('data-theme');
    const target = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', target);
    localStorage.setItem('theme', target);
    updateThemeIcon(target);
    showToast(`🌙 Switched to ${target} mode`);
};

const updateThemeIcon = (theme) => {
    const icon = $('themeIcon');
    if (theme === 'dark') {
        icon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
    } else {
        icon.innerHTML = `<circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`;
    }
};

// ── Release Manager Logic ────────────────────────────────────────────────
const RM_MANIFEST = [
    {
        category: 'Backend Services',
        jobs: ['Bheem-Compile-Deploy', 'Bheem-Redis-Clone', 'Deploy-Libs', 'Informer-Compile', 'Informer-Deploy', 'Notification-Compile', 'Notification-Deploy', 'OFB-Compile', 'OFB-Compile-Deploy', 'OFB-Deploy', 'OFB-FS-Compile', 'OFB-FS-Deploy', 'OFB-Scheduler-Compile', 'OFB-Scheduler-Deploy']
    },
    {
        category: 'Frontend Apps',
        jobs: ['BUYER-FE', 'Merge-FE', 'OASYS-FE', 'OASYS-TS', 'OFB-Admin', 'Orion-Admin', 'Orion-FE', 'Supplier-FE']
    },
    {
        category: 'Orion Services',
        jobs: ['Orion-Compile', 'Orion-Compile-Deploy', 'Orion-Deploy', 'Orion-FS-Compile', 'Orion-FS-Deploy', 'Orion-Scheduler-Compile', 'Orion-Scheduler-Deploy']
    }
];

const renderRMJobs = () => {
    const grid = $('rmJobGrid');
    
    // If we have full job objects from YAML, group them by type
    if (configuredJobs.length > 0 && configuredJobs[0].type) {
        const groups = {
            'backend': 'Backend Services',
            'frontend': 'Frontend Apps',
            'orion': 'Orion Services'
        };
        
        const manifest = Object.entries(groups).map(([type, label]) => ({
            category: label,
            jobs: configuredJobs.filter(j => j.type === type).map(j => j.name)
        }));

        grid.innerHTML = manifest.map(cat => `
            <div class="rm-cat-header">${cat.category}</div>
            ${cat.jobs.map(job => `
                <div class="rm-job-item" onclick="toggleRMJob(this)">
                    <input type="checkbox" data-job="${job}" />
                    <span>${job}</span>
                </div>
            `).join('')}
        `).join('');
    } else {
        // Fallback to static manifest
        grid.innerHTML = RM_MANIFEST.map(cat => `
            <div class="rm-cat-header">${cat.category}</div>
            ${cat.jobs.map(job => `
                <div class="rm-job-item" onclick="toggleRMJob(this)">
                    <input type="checkbox" data-job="${job}" />
                    <span>${job}</span>
                </div>
            `).join('')}
        `).join('');
    }
    
    renderLibs();
};

const renderLibs = () => {
    const libGrid = $('libGrid');
    if (!libGrid) return;
    
    // Extract libraries from configuredJobs (Deploy-Libs entry)
    const deployLibsJob = configuredJobs.find(j => j.name === 'Deploy-Libs');
    const libs = deployLibsJob ? deployLibsJob.libraries : [];
    
    if (!libs.length) {
        libGrid.innerHTML = '<div style="grid-column:1/-1;font-size:11px;color:#64748b;padding:10px">No libraries found.</div>';
        return;
    }

    libGrid.innerHTML = libs.map(lib => `
        <div class="lib-item ${selectedLibs.has(lib) ? 'selected' : ''}" onclick="toggleLib('${esc(lib)}', this)">
            <span>${esc(lib)}</span>
        </div>
    `).join('');
};

window.toggleLib = (lib, el) => {
    if (selectedLibs.has(lib)) {
        selectedLibs.delete(lib);
        el.classList.remove('selected');
    } else {
        selectedLibs.add(lib);
        el.classList.add('selected');
    }
};

const filterLibs = (q) => {
    const items = document.querySelectorAll('.lib-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(q.toLowerCase()) ? 'flex' : 'none';
    });
};

window.toggleRMJob = (el) => {
    const cb = el.querySelector('input');
    cb.checked = !cb.checked;
    el.classList.toggle('selected', cb.checked);
};

const toggleReleaseManager = async () => {
    const sec = $('releaseManagerSection');
    const main = $('dashboardContainer');
    const isVisible = !sec.classList.contains('hidden');
    
    if (!isVisible) {
        sec.classList.remove('hidden');
        if (main) main.classList.add('hidden'); 
        
        // Reset navigation to Configuration tab
        document.querySelectorAll('.rm-nav-btn').forEach(b => b.classList.remove('active'));
        const configBtn = document.querySelector('[data-view="rmManagerView"]');
        if (configBtn) configBtn.classList.add('active');

        // check if a release is already in progress
        try {
            const res = await fetch('/api/release-status');
            const data = await res.json();
            if (data && (data.building || data.result === 'RUNNING')) {
                // hide nav in monitor mode to keep it focused
                const nav = document.querySelector('.rm-nav');
                if (nav) nav.style.display = 'none';
                switchRMView('monitor');
                startProgressPolling();
            } else {
                const nav = document.querySelector('.rm-nav');
                if (nav) nav.style.display = 'flex';
                switchRMView('manager');
                renderRMJobs();
                if (data && data.number) updateLastReleaseStatus(data);
            }
        } catch (e) {
            renderRMJobs();
        }
    } else {
        sec.classList.add('hidden');
        if (main) main.classList.remove('hidden');
        // If release NOT active, stop polling. If active, keep polling in background 
        stopLogPolling();
        clearInterval(progressInterval);
    }
};

const updateLastReleaseStatus = (data) => {
    const card = $('lastReleaseCard');
    const container = $('rmLastStatus');
    if (!card || !container) return;

    const res = (data.result || 'UNKNOWN').toLowerCase();
    const time = data.timestamp ? relTime(data.timestamp) : 'unknown time';
    
    container.classList.remove('hidden');
    card.innerHTML = `
        <div class="lrc-header">
            <span class="lrc-info">Build #${data.buildNumber || data.number}</span>
            <span class="lrc-result ${res}">${res}</span>
        </div>
        <div class="lrc-info">Completed ${time}</div>
    `;
};

const loadRMHistory = async () => {
    const list = $('rmHistoryList');
    list.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Fetching history...</span></div>`;
    
    try {
        const res = await fetch('/api/history/QA-Release-Deployment');
        const data = await res.json();
        renderRMHistory(data.history || []);
    } catch (e) {
        list.innerHTML = `<div class="error-state">Failed to load history</div>`;
    }
};

const renderRMHistory = (history) => {
    const list = $('rmHistoryList');
    if (!history.length) {
        list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">No build history found.</div>`;
        return;
    }

    // Group by day
    const groups = {};
    history.forEach(b => {
        const d = new Date(b.timestamp);
        const day = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
        const today = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
        const label = day === today ? 'Today' : day;
        if (!groups[label]) groups[label] = [];
        groups[label].push(b);
    });

    list.innerHTML = Object.entries(groups).map(([label, builds]) => `
        <div class="rm-history-group">
            <div class="rm-history-group-label">${label}</div>
            ${builds.map(b => {
                const res = (b.status || 'unknown').toLowerCase();
                const icon = res === 'success' ? '✓' : res === 'running' ? '●' : '✕';
                const time = new Date(b.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
                return `
                    <a href="${b.url}" target="_blank" class="rm-history-item-link">
                        <div class="rm-history-item">
                            <div class="hi-status-icon ${res}">${icon}</div>
                            <div class="hi-number">#${b.buildNumber}</div>
                            <div class="hi-time">${time}</div>
                            <div class="hi-actions">${res.toUpperCase()} ↗</div>
                        </div>
                    </a>
                `;
            }).join('')}
        </div>
    `).join('');
};

const triggerRelease = async () => {
    const branch = $('rmBranchInput').value.trim();
    const env = $('rmEnvSelect').value;
    const dryRun = $('rmDryRun').checked;
    const selectedJobs = Array.from(document.querySelectorAll('#rmJobGrid input:checked')).map(cb => cb.dataset.job);
    const libsToDeploy = Array.from(selectedLibs);

    if (!selectedJobs.length && !libsToDeploy.length) 
        return showToast('⚠️ Please select at least one job or library', 'err');
    
    if (!branch) return showToast('⚠️ Please enter a release branch', 'err');

    const btn = $('btnTriggerRelease');
    btn.disabled = true;
    btn.textContent = '⚡ Triggering...';

    try {
        const res = await fetch('/api/trigger-release', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch, env, jobsToRelease: selectedJobs, libsToDeploy, dryRun })
        });
        const data = await res.json();
        
        if (data.success) {
            showToast(`🚀 Release triggered!`);
            // Reset log pointer for new build
            logStart = 0; 
            $('consoleOutput').textContent = 'Initialising...';
            switchRMView('monitor');
            startProgressPolling();
        } else {
            throw new Error(data.error || 'Trigger failed');
        }
    } catch (err) {
        showToast(`❌ Error: ${err.message}`, 'err');
        btn.disabled = false;
        btn.textContent = '🚀 Launch Release Pipeline';
    }
};

const startProgressPolling = () => {
    const bar = $('monitorBar');
    const status = $('monitorStatus');
    const percent = $('monitorPercent');
    const jobList = $('monitorJobList');
    
    // reset bar for new build
    if (!bar.style.width || bar.style.width === '0%' || bar.style.width === '100%') {
        bar.style.width = '2%';
        percent.textContent = '2%';
    }

    clearInterval(progressInterval);
    progressInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/release-status');
            const data = await res.json();
            if (!data) return;

            // Jenkins build status
            const buildStatus = data.result || (data.building ? 'RUNNING' : 'QUEUED');
            status.textContent = buildStatus === 'SUCCESS' ? 'Release Complete' : 
                               buildStatus === 'RUNNING' ? 'Deploying Services...' : 
                               buildStatus === 'QUEUED' ? 'Waiting in Queue...' : 'Processing...';
            
            // Render sub-job stages if present
            if (data.stages && data.stages.length > 0) {
                renderMonitorStages(data.stages);
                
                // Calculate real progress based on stages if building
                if (data.building) {
                    const completed = data.stages.filter(s => s.status === 'SUCCESS').length;
                    const total = data.stages.length;
                    const calculatedPercent = Math.max(2, Math.round((completed / total) * 100));
                    bar.style.width = calculatedPercent + '%';
                    percent.textContent = calculatedPercent + '%';
                }
            } else {
                // FALLBACK increment for UI feel if no stages yet
                const currentWidth = parseFloat(bar.style.width) || 0;
                if (currentWidth < 90) {
                    const inc = buildStatus === 'RUNNING' ? 1 : 0.1;
                    bar.style.width = (currentWidth + inc) + '%';
                    percent.textContent = Math.round(parseFloat(bar.style.width)) + '%';
                }
            }

            if (buildStatus === 'SUCCESS') {
                bar.style.width = '100%';
                percent.textContent = '100%';
                clearInterval(progressInterval);
                stopLogPolling();
            } else if (buildStatus === 'FAILURE' || buildStatus === 'ABORTED') {
                status.textContent = `Release ${statusLabel(buildStatus)}`;
                clearInterval(progressInterval);
                stopLogPolling();
            }
        } catch (e) {
            console.error('Polling error:', e);
        }
    }, MONITOR_POLL_MS);
};

const renderMonitorStages = (stages) => {
    const list = $('monitorJobList');
    if (!list) return;

    // Filter out internal stages like "Initialize" and "Final Reporting" if you want
    const serviceStages = stages.filter(s => s.name.startsWith('Deploy:'));
    
    if (serviceStages.length === 0) {
        list.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center;">Initialising stages...</div>`;
        return;
    }

    list.innerHTML = serviceStages.map(s => {
        const name = s.name.replace('Deploy:', '').trim();
        const stat = s.status || 'PENDING';
        return `
            <div class="m-job-row">
                <div class="m-job-name">${esc(name)}</div>
                <div class="progress-track" style="height:4px;margin:0 10px;">
                    <div class="progress-fill" style="width:${stat === 'SUCCESS' ? '100%' : stat === 'IN_PROGRESS' ? '50%' : '0%'}"></div>
                </div>
                <div class="m-job-status sp-${esc(stat.toLowerCase())}">${esc(stat)}</div>
            </div>
        `;
    }).join('');
};

const switchRMView = (view) => {
    if (view === 'monitor') {
        $('rmManagerView').classList.add('hidden');
        $('rmMonitorView').classList.remove('hidden');
        startLogPolling();
        monitorPolling = true;
    } else {
        $('rmManagerView').classList.remove('hidden');
        $('rmMonitorView').classList.add('hidden');
        stopLogPolling();
        monitorPolling = false;
    }
};

const startLogPolling = () => {
    logPolling = true;
    logStart = 0;
    $('consoleOutput').textContent = 'Connecting to Jenkins stream...';
    pollLogs();
};

const stopLogPolling = () => {
    logPolling = false;
};

const pollLogs = async () => {
    if (!logPolling) return;
    try {
        const res = await fetch(`/api/release-logs?start=${logStart}`);
        const data = await res.json();
        
        if (data.text) {
            const out = $('consoleOutput');
            // Clean ANSI escape sequences and weird Jenkins hidden links
            const cleanText = data.text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-nqrstuvwyzaceghjkml]/g, '')
                                     .replace(/\[8mha:.*?\[0m/g, ''); // Strip Jenkins hidden links
            out.textContent += cleanText;
            logStart = data.nextStart || logStart;
            if (scrollLock) out.scrollTop = out.scrollHeight;
        }
        
        if (logPolling) setTimeout(pollLogs, LOG_POLL_MS);
    } catch (e) {
        if (logPolling) setTimeout(pollLogs, 5000);
    }
};

const abortRelease = async () => {
    if (!confirm('Are you sure you want to stop the current release?')) return;
    try {
        const res = await fetch('/api/abort-release', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('🛑 Release Aborted');
            switchRMView('manager');
        }
    } catch (e) {
        showToast('❌ Failed to abort', 'err');
    }
};

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
    initTheme();
    
    // Fetch jobs config first
    try {
        const res = await fetch('/api/jobs');
        const data = await res.json();
        configuredJobs = data.jobs || [];
    } catch (e) {}

    $('themeToggle').addEventListener('click', toggleTheme);
    $('btnLaunchRelease').addEventListener('click', toggleReleaseManager);
    $('btnCloseRM').addEventListener('click', toggleReleaseManager);
    
    // Tab Switching
    document.querySelectorAll('.m-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.m-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.m-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            $(`mTab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`).classList.add('active');
        });
    });

    $('libSearchInput').addEventListener('input', (e) => filterLibs(e.target.value));
    $('btnReturnToManager').addEventListener('click', () => switchRMView('manager'));
    $('btnAbortRelease').addEventListener('click', abortRelease);
    $('btnScrollLock').addEventListener('click', () => {
        scrollLock = !scrollLock;
        $('btnScrollLock').textContent = `Auto-scroll: ${scrollLock ? 'ON' : 'OFF'}`;
    });

    $('rmSelectAll').addEventListener('click', () => {
        document.querySelectorAll('#rmJobGrid .rm-job-item').forEach(el => {
            el.querySelector('input').checked = true;
            el.classList.add('selected');
        });
    });
    $('rmSelectNone').addEventListener('click', () => {
        document.querySelectorAll('#rmJobGrid .rm-job-item').forEach(el => {
            el.querySelector('input').checked = false;
            el.classList.remove('selected');
        });
        selectedLibs.clear();
        renderLibs();
    });
    $('btnTriggerRelease').addEventListener('click', triggerRelease);
    
    // RM Navigation
    document.querySelectorAll('.rm-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            document.querySelectorAll('.rm-nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.rm-view').forEach(v => v.classList.add('hidden'));
            
            btn.classList.add('active');
            $(view).classList.remove('hidden');
            
            if (view === 'rmHistoryView') loadRMHistory();
            if (view === 'rmManagerView') renderRMJobs();
        });
    });

    await fetchData();
    startCountdown();
})();
