/**
 * Jenkins API Service — Environment-aware fetching
 * ─────────────────────────────────────────────────
 * For each job, scans the last N builds to find the latest deployment
 * per staging environment (stg1, stg2, stg3 ...).
 * No data stored locally — every call is a live Jenkins API fetch.
 */

const fetch = require('node-fetch');
const config = require('../jobs.config');

const getAuthHeader = () => {
    if (!config.JENKINS_USER || !config.JENKINS_TOKEN) return {};
    const creds = Buffer.from(`${config.JENKINS_USER}:${config.JENKINS_TOKEN}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
};

// Minimal tree to pull — keeps each request fast
const BUILD_TREE = [
    'number',
    'result',
    'timestamp',
    'inProgress',
    'url',
    'actions[causes[userId,userName,shortDescription],parameters[name,value],buildsByBranchName,lastBuiltRevision[branch[name,SHA1]]]',
].join(',');

// ── Action Parsers ─────────────────────────────────────────────────────────

const parseActions = (actions = []) => {
    let branch = '';
    let commit = '';
    let deployedBy = '';
    let environment = '';
    const params = {};

    for (const action of actions) {
        const cls = action._class || '';

        // Who triggered the build
        if (cls.includes('CauseAction') || action.causes) {
            const cause = (action.causes || [])[0] || {};
            deployedBy = cause.userId || cause.userName || '';
            if (!deployedBy && cause.shortDescription) {
                // "Started by user John" → "John"
                deployedBy = cause.shortDescription.replace(/^Started by (user )?/, '');
            }
        }

        // Build parameters (ENV, BRANCH, etc.)
        if (cls.includes('ParametersAction') || action.parameters) {
            (action.parameters || []).forEach(p => { params[p.name] = p.value; });
        }

        // SCM / Git data
        if (action.lastBuiltRevision || action.buildsByBranchName) {
            const rev = action.lastBuiltRevision;
            if (rev && Array.isArray(rev.branch) && rev.branch[0]) {
                const b = rev.branch[0];
                branch = (b.name || '').replace(/^refs\/(remotes\/[^/]+|heads)\//, '');
                commit = (b.SHA1 || '').substring(0, 7);
            }
            if (!branch && action.buildsByBranchName) {
                const k = Object.keys(action.buildsByBranchName)[0] || '';
                branch = k.replace(/^refs\/(remotes\/[^/]+|heads)\//, '');
            }
        }
    }

    // Branch from params if SCM didn't show it
    if (!branch) {
        for (const name of config.BRANCH_PARAM_NAMES) {
            if (params[name]) { branch = params[name]; break; }
        }
    }

    // Environment from params — try all known param names
    for (const name of config.ENV_PARAM_NAMES) {
        if (params[name]) {
            environment = normaliseEnv(params[name]);
            break;
        }
    }

    return { branch, commit, deployedBy, environment };
};

/**
 * Normalise messy env strings → clean stg labels.
 * "ofb_stg3" → "stg3"   "STG-5" → "stg5"   "3" → "stg3"   "uat1" → "uat1"
 */
const normaliseEnv = (raw = '') => {
    const s = String(raw).toLowerCase().trim();
    // patterns: ofb_stg3, stg3, stg-3, staging3, env3, uat1, uat-2
    const m = s.match(/(?:ofb_?|staging?[-_]?)?(?:stg|env|uat)[-_]?(\d+)/);
    if (m) {
        if (s.includes('uat')) return `uat${m[1]}`;
        return `stg${m[1]}`;
    }
    // bare number e.g. "3"
    if (/^\d+$/.test(s)) return `stg${s}`;

    // catch explicit "uat" without number
    if (s.includes('uat')) return 'uat';

    return s; // keep whatever it is
};

/**
 * Normalise statuses across Jenkins naming
 */
const normaliseStatus = (build) => {
    if (build.inProgress) return 'RUNNING';
    const r = (build.result || '').toUpperCase();
    if (r === 'SUCCESS') return 'SUCCESS';
    if (r === 'FAILURE') return 'FAILED';
    if (r === 'ABORTED') return 'ABORTED';
    if (r === 'UNSTABLE') return 'UNSTABLE';
    return 'UNKNOWN';
};

/**
 * Convert a raw Jenkins build object + job name into our normalised shape.
 */
const normaliseBuild = (jobName, build) => {
    const { branch, commit, deployedBy, environment } = parseActions(build.actions || []);
    return {
        job: jobName,
        buildNumber: build.number,
        branch: branch || '—',
        commit: commit || '—',
        status: normaliseStatus(build),
        deployedBy: deployedBy || '—',
        environment: environment || '—',
        timestamp: build.timestamp ? new Date(build.timestamp).toISOString() : null,
        url: build.url || `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/`,
    };
};

// ── Fetch helpers ──────────────────────────────────────────────────────────

const jenkinsGet = async (url) => {
    const res = await fetch(url, {
        headers: { Accept: 'application/json', ...getAuthHeader() },
        timeout: 14000,
    });
    if (res.status === 404) return null;  // job exists but no builds, or wrong name
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
};

const jenkinsGetText = async (url) => {
    const res = await fetch(url, {
        headers: { ...getAuthHeader() },
        timeout: 14000,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.text();
};

/**
 * For a single job: fetch the last SCAN_DEPTH builds and return the
 * most-recent build per environment.
 * Also returns a `_lastBuild` key = the absolute latest build (for jobs
 * that don't use env params — so they still show up in "all" view).
 */
const SCAN_DEPTH = 60;

const fetchJobEnvMap = async (jobName) => {
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/api/json` +
        `?tree=builds[${encodeURIComponent(BUILD_TREE)}]{0,${SCAN_DEPTH}}`;
    try {
        const data = await jenkinsGet(url);
        if (!data) return { jobName, envMap: {}, lastBuild: null, error: 'not_found' };
        if (!data.builds?.length) return { jobName, envMap: {}, lastBuild: null, error: 'no_builds' };

        const envMap = {};   // stg1 → normalised build object
        let lastBuild = null; // the single latest build regardless of env

        for (const build of data.builds) {
            const nb = normaliseBuild(jobName, build);
            if (!lastBuild) lastBuild = nb;          // first = latest

            const key = nb.environment;
            if (key && key !== '—' && !envMap[key]) {
                envMap[key] = nb;                    // first seen = most recent for this env
            }
        }

        return { jobName, envMap, lastBuild, error: null };
    } catch (err) {
        console.error(`[Jenkins] ${jobName}: ${err.message}`);
        return {
            jobName, envMap: {}, error: err.message,
            lastBuild: {
                job: jobName, buildNumber: null, branch: '—', commit: '—',
                status: 'ERROR', deployedBy: '—', environment: '—',
                timestamp: null, url: `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/`,
                error: err.message,
            },
        };
    }
};

/**
 * Fetch all configured jobs in parallel.
 * Returns a flat array of deployments — one record per (job × environment).
 * If a job has no env params at all, one record is emitted for its latest build.
 * For deploy-only jobs, the branch is fetched from the build's console log if missing.
 */
const fetchAllDeployments = async () => {
    const results = await Promise.all(config.JOBS.map(fetchJobEnvMap));

    const flat = [];
    for (const { envMap, lastBuild } of results) {
        const envKeys = Object.keys(envMap);
        if (envKeys.length > 0) {
            envKeys.forEach(k => flat.push(envMap[k]));
        } else if (lastBuild) {
            flat.push(lastBuild);
        }
    }

    // Concurrently fetch console logs to extract branch names for deploy jobs
    const logBranchJobs = new Set(config.LOG_BRANCH_JOBS || []);
    const logFetchPromises = flat.map(async (entry) => {
        const isMissingOrHash = !entry.branch || entry.branch === '—' || /^[0-9a-f]{40}$/i.test(entry.branch);
        
        if (logBranchJobs.has(entry.job) && isMissingOrHash) {
            try {
                const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(entry.job)}/${entry.buildNumber}/consoleText`;
                const text = await jenkinsGetText(url);
                if (text) {
                    const match1 = text.match(/branchName=(?:origin\/)?(\S+)/);
                    const match2 = text.match(/git\.branch with value (?:origin\/)?(\S+)/);
                    const match3 = text.match(/\bbranch=(?:origin\/)?(\S+)/);
                    
                    if (match1 && !match1[1].startsWith('$')) {
                        entry.branch = match1[1];
                    } else if (match2 && !match2[1].startsWith('$')) {
                        entry.branch = match2[1];
                    } else if (match3 && !match3[1].startsWith('$')) {
                        entry.branch = match3[1];
                    }
                }
            } catch (err) {
                console.error(`[Jenkins] Failed to fetch log for branch on ${entry.job}#${entry.buildNumber}: ${err.message}`);
            }
        }
    });

    await Promise.all(logFetchPromises);

    return flat;
};

/**
 * Return last HISTORY_DEPTH builds for a single job (history modal).
 */
const fetchBuildHistory = async (jobName) => {
    const depth = config.HISTORY_DEPTH;
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/api/json` +
        `?tree=builds[${encodeURIComponent(BUILD_TREE)}]{0,${depth}}`;
    try {
        const data = await jenkinsGet(url);
        if (!data?.builds) return [];
        return data.builds.map(b => normaliseBuild(jobName, b));
    } catch (err) {
        console.error(`[Jenkins] history ${jobName}: ${err.message}`);
        return [];
    }
};

/**
 * Trigger a parameterized build in Jenkins
 */
const triggerJob = async (jobName, params = {}) => {
    // Build query string for the URL - this is the standard way for buildWithParameters
    const query = Object.keys(params)
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/buildWithParameters?${query}`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: getAuthHeader(),
            body: '', // Keep body empty to avoid 500 errors with query-based builds
            timeout: 10000,
        });

        if (!res.ok && res.status !== 201) {
            throw new Error(`Jenkins trigger failed: ${res.status} ${res.statusText}`);
        }

        return { success: true, job: jobName };
    } catch (err) {
        console.error(`[Jenkins] Trigger ${jobName} error:`, err.message);
        throw err;
    }
};

/**
 * Fetch status of the latest build for the master release job
 */
/**
 * Fetch a specific build by number
 */
const fetchBuild = async (jobName, buildNumber) => {
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/${buildNumber}/api/json?tree=${encodeURIComponent(BUILD_TREE)}`;
    try {
        const data = await jenkinsGet(url);
        if (!data) return null;
        return normaliseBuild(jobName, data);
    } catch (err) {
        console.error(`[Jenkins] build ${jobName} #${buildNumber}: ${err.message}`);
        return null;
    }
};

const fetchReleaseStatus = async () => {
    const jobName = 'QA-Release-Deployment';
    const status = await fetchJobEnvMap(jobName);
    const lastBuild = status.lastBuild;

    if (lastBuild && lastBuild.buildNumber) {
        try {
            const stages = await fetchPipelineStages(jobName, lastBuild.buildNumber);
            lastBuild.stages = stages;
        } catch (e) {
            console.error('[Jenkins] Stages fetch failed:', e.message);
        }
    }

    return lastBuild;
};

/**
 * Fetch detailed pipeline stages for a build using wfapi
 */
const fetchPipelineStages = async (jobName, buildNumber) => {
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/${buildNumber}/wfapi/describe`;
    try {
        const data = await jenkinsGet(url);
        return data?.stages || [];
    } catch (err) {
        console.error(`[Jenkins] Workflow API error: ${err.message}`);
        return [];
    }
};

/**
 * Fetch console logs for a job (latest or specific build number)
 */
const fetchJobLogs = async (jobName, start = 0, buildNumber = null) => {
    const buildPath = buildNumber ? buildNumber : 'lastBuild';
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/${buildPath}/logText/progressiveText?start=${start}`;
    try {
        const res = await fetch(url, {
            headers: getAuthHeader(),
            timeout: 30000,
        });
        
        const more = res.headers.get('x-more-data') === 'true';
        const nextStart = res.headers.get('x-text-size');
        const text = await res.text();
        
        return { text, nextStart, more };
    } catch (err) {
        console.error(`[Jenkins] Fetch logs ${jobName} error:`, err.message);
        throw err;
    }
};

/**
 * Stop/Abort a running build
 */
const abortJob = async (jobName) => {
    // We target the current/last build
    const url = `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jobName)}/lastBuild/stop`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: getAuthHeader(),
            timeout: 10000,
        });
        return { success: res.ok || res.status === 302 };
    } catch (err) {
        console.error(`[Jenkins] Abort ${jobName} error:`, err.message);
        throw err;
    }
};

module.exports = {
    fetchAllDeployments,
    fetchBuildHistory,
    fetchJobEnvMap,
    triggerJob,
    fetchReleaseStatus,
    fetchJobLogs,
    fetchBuild,
    abortJob,
};
