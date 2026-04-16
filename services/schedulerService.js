/**
 * Scheduled Deployment Pipeline Service
 * ──────────────────────────────────────
 * Runs a daily cron that triggers the QA-Release-Deployment pipeline
 * for all services on uat1/master, polls for completion, then sends
 * a Google Chat notification with results.
 *
 * Reuses the existing Jenkinsfile pipeline — no custom sequencing needed.
 */

const cron = require('node-cron');
const fs = require('fs');
const yaml = require('js-yaml');
const { triggerJob, fetchReleaseStatus, fetchBuild } = require('./jenkinsService');
const { sendDeploymentNotification } = require('./chatNotificationService');
const schedulerConfig = require('../scheduler.config');
const config = require('../jobs.config');

// In-memory state for status API
let schedulerState = {
    enabled: schedulerConfig.ENABLED,
    lastRun: null,
    nextRun: null,
    currentRun: null,
    history: [],      // last 10 runs
};

const MAX_HISTORY = 10;
const PIPELINE_JOB = 'QA-Release-Deployment';

// ── Core Pipeline ────────────────────────────────────────────────────────────

/**
 * Main entry point — called by cron or manual trigger.
 * Triggers the Jenkins pipeline with all jobs, polls for completion,
 * then sends notification.
 */
const runScheduledDeployment = async ({ branch, env, triggeredBy } = {}) => {
    const effectiveBranch = branch || schedulerConfig.DEFAULT_BRANCH;
    const effectiveEnv = env || schedulerConfig.TARGET_ENV;
    const startedAt = new Date().toISOString();

    const runRecord = {
        startedAt,
        finishedAt: null,
        branch: effectiveBranch,
        env: effectiveEnv,
        triggeredBy: triggeredBy || 'scheduler',
        status: 'RUNNING',
        results: [],
        notification: null,
    };

    schedulerState.currentRun = runRecord;
    console.log(`[Scheduler] Starting scheduled deployment: env=${effectiveEnv}, branch=${effectiveBranch}`);

    try {
        // Step 1: Fetch all deployable jobs (excluding Deploy-Libs and other excluded jobs)
        const jobsToRelease = getDeployableJobs();
        if (jobsToRelease.length === 0) {
            throw new Error('No deployable jobs found in jobs.yaml');
        }
        console.log(`[Scheduler] Deploying ${jobsToRelease.length} jobs: ${jobsToRelease.join(', ')}`);

        // Step 2: Trigger the pipeline
        await triggerJob(PIPELINE_JOB, {
            RELEASE_BRANCH: effectiveBranch,
            STG_ENV: effectiveEnv,
            JOBS_TO_RELEASE: jobsToRelease.join(','),
            LIBS_TO_DEPLOY: '',
            DRY_RUN: 'false',
        });
        console.log('[Scheduler] Pipeline triggered, waiting for build to start...');

        // Step 3: Wait for build to appear and complete
        await sleep(5000); // brief wait for Jenkins to queue the build
        const pipelineResult = await pollPipelineCompletion();

        // Step 4: Aggregate results
        runRecord.results = pipelineResult.stages;
        runRecord.status = pipelineResult.overallStatus;
        runRecord.finishedAt = new Date().toISOString();
        runRecord.buildUrl = pipelineResult.buildUrl;

        console.log(`[Scheduler] Pipeline finished: ${runRecord.status} (${runRecord.results.length} stages)`);

    } catch (err) {
        console.error(`[Scheduler] Pipeline execution error: ${err.message}`);
        runRecord.status = 'ERROR';
        runRecord.error = err.message;
        runRecord.finishedAt = new Date().toISOString();
    }

    // Step 5: Send notification (even on error)
    try {
        const notifResult = await sendDeploymentNotification({
            env: effectiveEnv,
            branch: effectiveBranch,
            startedAt: runRecord.startedAt,
            finishedAt: runRecord.finishedAt,
            results: runRecord.results.length > 0
                ? runRecord.results
                : [{ job: 'Pipeline', status: runRecord.status, url: runRecord.buildUrl || '' }],
        });
        runRecord.notification = notifResult;
    } catch (err) {
        console.error(`[Scheduler] Notification error: ${err.message}`);
        runRecord.notification = { sent: false, reason: err.message };
    }

    // Update state
    schedulerState.currentRun = null;
    schedulerState.lastRun = runRecord;
    schedulerState.history.unshift(runRecord);
    if (schedulerState.history.length > MAX_HISTORY) {
        schedulerState.history = schedulerState.history.slice(0, MAX_HISTORY);
    }

    return runRecord;
};

// ── Job Discovery ────────────────────────────────────────────────────────────

/**
 * Read jobs.yaml and return all job names excluding EXCLUDED_JOBS.
 */
const getDeployableJobs = () => {
    try {
        const fileContents = fs.readFileSync('./jobs.yaml', 'utf8');
        const data = yaml.load(fileContents);
        const allJobs = (data.jobs || []).map(j => j.name);
        const excluded = new Set(schedulerConfig.EXCLUDED_JOBS.map(j => j.toLowerCase()));
        return allJobs.filter(j => !excluded.has(j.toLowerCase()));
    } catch (err) {
        console.error(`[Scheduler] Failed to read jobs.yaml: ${err.message}`);
        return [];
    }
};

// ── Pipeline Polling ─────────────────────────────────────────────────────────

/**
 * Poll Jenkins until the QA-Release-Deployment build completes.
 * Returns { overallStatus, stages: [{ job, status, url }], buildUrl }
 */
const pollPipelineCompletion = async () => {
    const startTime = Date.now();
    const timeoutMs = schedulerConfig.POLL_TIMEOUT_MS;
    const pollMs = schedulerConfig.POLL_INTERVAL_MS;

    while (Date.now() - startTime < timeoutMs) {
        try {
            const releaseStatus = await fetchReleaseStatus();

            if (!releaseStatus || !releaseStatus.buildNumber) {
                console.log('[Scheduler] Waiting for build to appear...');
                await sleep(pollMs);
                continue;
            }

            const buildUrl = releaseStatus.url || `${config.JENKINS_BASE_URL}/job/${PIPELINE_JOB}/`;

            // Check if build is still running
            if (releaseStatus.status === 'RUNNING') {
                const stageCount = (releaseStatus.stages || []).length;
                const completed = (releaseStatus.stages || []).filter(s => s.status !== 'IN_PROGRESS').length;
                console.log(`[Scheduler] Pipeline running... (${completed}/${stageCount} stages done)`);
                await sleep(pollMs);
                continue;
            }

            // Build finished — extract stage results
            const stages = (releaseStatus.stages || []).map(s => ({
                job: s.name || 'Unknown',
                status: normaliseStageStatus(s.status),
                url: buildUrl,
                durationMs: s.durationMillis || 0,
            }));

            return {
                overallStatus: releaseStatus.status,
                stages,
                buildUrl,
            };

        } catch (err) {
            console.error(`[Scheduler] Poll error: ${err.message}`);
            await sleep(pollMs);
        }
    }

    throw new Error(`Pipeline did not complete within ${timeoutMs / 60000} minutes`);
};

const normaliseStageStatus = (status) => {
    if (!status) return 'UNKNOWN';
    const s = status.toUpperCase();
    if (s === 'SUCCESS') return 'SUCCESS';
    if (s === 'FAILED' || s === 'FAILURE') return 'FAILED';
    if (s === 'ABORTED') return 'ABORTED';
    if (s === 'IN_PROGRESS' || s === 'RUNNING') return 'RUNNING';
    if (s === 'NOT_EXECUTED') return 'SKIPPED';
    return s;
};

// ── Cron Setup ───────────────────────────────────────────────────────────────

let cronTask = null;

const initScheduler = () => {
    if (!schedulerConfig.ENABLED) {
        console.log('[Scheduler] Disabled via SCHEDULER_ENABLED=false');
        return;
    }

    if (!cron.validate(schedulerConfig.CRON_SCHEDULE)) {
        console.error(`[Scheduler] Invalid cron expression: ${schedulerConfig.CRON_SCHEDULE}`);
        return;
    }

    cronTask = cron.schedule(schedulerConfig.CRON_SCHEDULE, () => {
        console.log(`[Scheduler] Cron fired at ${new Date().toISOString()}`);
        runScheduledDeployment().catch(err => {
            console.error(`[Scheduler] Unhandled error in scheduled run: ${err.message}`);
        });
    }, {
        timezone: 'Asia/Kolkata',
    });

    // Calculate next run for status display
    schedulerState.nextRun = getNextCronRun();

    console.log(`[Scheduler] Initialized — schedule: "${schedulerConfig.CRON_SCHEDULE}" (IST)`);
    console.log(`[Scheduler] Target: env=${schedulerConfig.TARGET_ENV}, branch=${schedulerConfig.DEFAULT_BRANCH}`);
    console.log(`[Scheduler] Excluded jobs: ${schedulerConfig.EXCLUDED_JOBS.join(', ')}`);
    console.log(`[Scheduler] Google Chat: ${schedulerConfig.GCHAT_WEBHOOK_URL ? 'configured' : 'NOT configured (set GCHAT_WEBHOOK_URL)'}`);
};

const stopScheduler = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        console.log('[Scheduler] Stopped');
    }
};

const getSchedulerState = () => {
    return {
        ...schedulerState,
        config: {
            schedule: schedulerConfig.CRON_SCHEDULE,
            env: schedulerConfig.TARGET_ENV,
            branch: schedulerConfig.DEFAULT_BRANCH,
            excludedJobs: schedulerConfig.EXCLUDED_JOBS,
            webhookConfigured: !!schedulerConfig.GCHAT_WEBHOOK_URL,
        },
    };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Rough estimate of next cron run (for display purposes).
 */
const getNextCronRun = () => {
    const now = new Date();
    const next = new Date(now);
    // Parse "0 8 * * *" — runs at 08:00 IST daily
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
};

module.exports = {
    initScheduler,
    stopScheduler,
    runScheduledDeployment,
    getSchedulerState,
    getDeployableJobs,
};
