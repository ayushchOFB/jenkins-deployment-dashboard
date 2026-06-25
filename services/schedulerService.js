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
const { spawn } = require('child_process');
const { triggerJob, fetchReleaseStatus, fetchBuild, fetchJobEnvMap, fetchBuildArtifact } = require('./jenkinsService');
const { sendDeploymentNotification } = require('./chatNotificationService');
const schedulerConfig = require('../scheduler.config');
const config = require('../jobs.config');

// In-memory state for status API
let schedulerState = {
    enabled: schedulerConfig.ENABLED,
    lastRun: null,
    nextRun: null,
    currentRun: null,
    pendingSanity: null,
    pendingRetry: null,
    history: [],      // last 10 runs
};

const MAX_HISTORY = 10;
const PIPELINE_JOB = 'QA-Release-Deployment';

// Trigger-failure retry: if the POST to Jenkins fails (network/auth/timeout),
// the pipeline never started, so it's safe to retry the whole trigger after a
// cool-down. Only the trigger is retried — pre-trigger errors (empty jobs.yaml)
// and post-trigger errors (poll timeout) bypass this.
const TRIGGER_MAX_RETRIES = 1;
const TRIGGER_RETRY_DELAY_MS = 30 * 60 * 1000;

// ── Core Pipeline ────────────────────────────────────────────────────────────

/**
 * Main entry point — called by cron or manual trigger.
 * Triggers the Jenkins pipeline with all jobs, polls for completion,
 * then sends notification.
 */
const runScheduledDeployment = async ({ branch, env, jobs, triggeredBy, retryAttempt = 0 } = {}) => {
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
        retryAttempt,
    };

    schedulerState.currentRun = runRecord;
    const attemptLabel = retryAttempt > 0 ? ` (retry ${retryAttempt}/${TRIGGER_MAX_RETRIES})` : '';
    console.log(`[Scheduler] Starting scheduled deployment${attemptLabel}: env=${effectiveEnv}, branch=${effectiveBranch}`);

    try {
        // Step 1: Use custom job list if provided, otherwise fetch all deployable jobs
        const jobsToRelease = jobs && jobs.length > 0 ? jobs : getDeployableJobs();
        if (jobsToRelease.length === 0) {
            throw new Error('No deployable jobs found in jobs.yaml');
        }
        console.log(`[Scheduler] Deploying ${jobsToRelease.length} jobs: ${jobsToRelease.join(', ')}`);

        // Step 2: Note current latest build number before triggering
        let previousBuildNumber = 0;
        try {
            const currentStatus = await fetchReleaseStatus();
            if (currentStatus && currentStatus.buildNumber) {
                previousBuildNumber = currentStatus.buildNumber;
            }
        } catch (_) { /* ignore — first ever build */ }
        console.log(`[Scheduler] Current latest build: #${previousBuildNumber}`);

        // Step 3: Trigger the pipeline. If this fails (Jenkins unreachable,
        // network timeout, auth error), the pipeline never started — schedule
        // a retry instead of falling through to the failure-notification path.
        try {
            await triggerJob(PIPELINE_JOB, {
                RELEASE_BRANCH: effectiveBranch,
                STG_ENV: effectiveEnv,
                JOBS_TO_RELEASE: jobsToRelease.join(','),
                LIBS_TO_DEPLOY: '',
                DRY_RUN: 'false',
            });
        } catch (triggerErr) {
            if (retryAttempt < TRIGGER_MAX_RETRIES) {
                console.error(`[Scheduler] Trigger failed (attempt ${retryAttempt + 1}/${TRIGGER_MAX_RETRIES + 1}): ${triggerErr.message}`);
                scheduleTriggerRetry({
                    branch: effectiveBranch,
                    env: effectiveEnv,
                    jobs,
                    triggeredBy: runRecord.triggeredBy,
                    retryAttempt: retryAttempt + 1,
                });
                schedulerState.currentRun = null;
                return { ...runRecord, status: 'RETRY_QUEUED', finishedAt: new Date().toISOString() };
            }
            throw triggerErr; // out of retries — let outer catch notify
        }
        console.log('[Scheduler] Pipeline triggered, waiting for new build to start...');

        // Step 4: Wait for new build to appear and complete
        const pipelineResult = await pollPipelineCompletion(previousBuildNumber);

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
            overallStatus: runRecord.status,
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

    // Step 6: Schedule the Sanity-Suite-OFB (DevTest) run after a cool-down
    // so services settle before tests hit them. Runs regardless of pipeline
    // outcome — sanity should report what's actually broken on uat1.
    scheduleSanityRun(runRecord);

    // Step 7: Also run automation-agent sanity flows (extension sanity tab)
    // after the same cool-down. Reads sanityRunItems + auth from token.json.
    scheduleAgentSanityRun(runRecord);

    return runRecord;
};

// ── Trigger-failure Retry ────────────────────────────────────────────────────

let pendingRetryTimer = null;

const scheduleTriggerRetry = (opts) => {
    if (pendingRetryTimer) clearTimeout(pendingRetryTimer);

    const fireAt = new Date(Date.now() + TRIGGER_RETRY_DELAY_MS).toISOString();
    schedulerState.pendingRetry = { attempt: opts.retryAttempt, fireAt };
    console.log(`[Scheduler] Retry attempt ${opts.retryAttempt}/${TRIGGER_MAX_RETRIES} queued for ${fireAt} (in ${TRIGGER_RETRY_DELAY_MS / 60000} min)`);

    pendingRetryTimer = setTimeout(() => {
        pendingRetryTimer = null;
        schedulerState.pendingRetry = null;
        runScheduledDeployment(opts).catch(err => {
            console.error(`[Scheduler] Retry attempt ${opts.retryAttempt} unhandled error: ${err.message}`);
        });
    }, TRIGGER_RETRY_DELAY_MS);
    if (pendingRetryTimer.unref) pendingRetryTimer.unref();
};

// ── Post-deploy Sanity Trigger ───────────────────────────────────────────────

let pendingSanityTimer = null;

const scheduleSanityRun = (runRecord) => {
    const sanity = schedulerConfig.SANITY;
    if (!sanity || !sanity.ENABLED) {
        console.log('[Scheduler] Sanity trigger disabled — skipping');
        return;
    }
    console.log(`[Scheduler] Pipeline finished (status=${runRecord.status}) — queuing sanity run regardless of outcome`);

    if (pendingSanityTimer) {
        clearTimeout(pendingSanityTimer);
        pendingSanityTimer = null;
    }

    const delayMs = sanity.DELAY_MS;
    const fireAt = new Date(Date.now() + delayMs).toISOString();
    console.log(`[Scheduler] Sanity run (${sanity.JOB}) queued for ${fireAt} (in ${delayMs / 60000} min)`);
    schedulerState.pendingSanity = { job: sanity.JOB, fireAt };

    pendingSanityTimer = setTimeout(async () => {
        pendingSanityTimer = null;
        schedulerState.pendingSanity = null;
        try {
            console.log(`[Scheduler] Triggering ${sanity.JOB} with params:`, sanity.PARAMS);
            await triggerJob(sanity.JOB, sanity.PARAMS);
            console.log(`[Scheduler] ${sanity.JOB} triggered`);
        } catch (err) {
            console.error(`[Scheduler] Failed to trigger ${sanity.JOB}: ${err.message}`);
        }
    }, delayMs);
    // Don't keep the event loop alive just for this timer
    if (pendingSanityTimer.unref) pendingSanityTimer.unref();
};

// ── Post-deploy Agent Sanity Runner ─────────────────────────────────────────

let pendingAgentSanityTimer = null;

const scheduleAgentSanityRun = (runRecord) => {
    const cfg = schedulerConfig.AGENT_SANITY;
    if (!cfg || !cfg.ENABLED) {
        console.log('[Scheduler] Agent sanity trigger disabled — skipping');
        return;
    }

    console.log(`[Scheduler] Pipeline finished (status=${runRecord.status}) — queuing agent sanity run`);

    if (pendingAgentSanityTimer) {
        clearTimeout(pendingAgentSanityTimer);
        pendingAgentSanityTimer = null;
    }

    const delayMs = cfg.DELAY_MS;
    const fireAt = new Date(Date.now() + delayMs).toISOString();
    console.log(`[Scheduler] Agent sanity run queued for ${fireAt} (in ${delayMs / 60000} min)`);

    pendingAgentSanityTimer = setTimeout(() => {
        pendingAgentSanityTimer = null;
        console.log(`[Scheduler] Spawning automation-agent sanity batch (cwd: ${cfg.AGENT_PATH})`);

        const proc = spawn('node', ['scripts/run-flow-bot.js', '--sanity'], {
            cwd: cfg.AGENT_PATH,
            env: { ...process.env },
            stdio: 'pipe',
        });

        proc.stdout.on('data', (data) => {
            data.toString().split('\n').filter(Boolean).forEach(line =>
                console.log(`[AgentSanity] ${line}`)
            );
        });
        proc.stderr.on('data', (data) => {
            data.toString().split('\n').filter(Boolean).forEach(line =>
                console.error(`[AgentSanity] ERR ${line}`)
            );
        });
        proc.on('close', (code) => {
            if (code === 0) {
                console.log('[AgentSanity] Sanity batch completed successfully');
            } else {
                console.error(`[AgentSanity] Sanity batch exited with code ${code}`);
            }
        });
        proc.on('error', (err) => {
            console.error(`[AgentSanity] Failed to spawn process: ${err.message}`);
        });

        // Optional timeout kill
        if (cfg.TIMEOUT_MS) {
            setTimeout(() => {
                if (!proc.killed) {
                    console.error(`[AgentSanity] Timeout (${cfg.TIMEOUT_MS / 60000} min) — killing process`);
                    proc.kill('SIGTERM');
                }
            }, cfg.TIMEOUT_MS);
        }
    }, delayMs);

    if (pendingAgentSanityTimer.unref) pendingAgentSanityTimer.unref();
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
 * Poll Jenkins until a NEW QA-Release-Deployment build completes.
 * @param {number} previousBuildNumber - Build number before we triggered; wait for a higher one.
 * Returns { overallStatus, stages: [{ job, status, url }], buildUrl }
 */
const pollPipelineCompletion = async (previousBuildNumber = 0) => {
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

            // Skip if this is still the old build
            if (releaseStatus.buildNumber <= previousBuildNumber) {
                console.log(`[Scheduler] Waiting for new build (current: #${releaseStatus.buildNumber}, need > #${previousBuildNumber})...`);
                await sleep(pollMs);
                continue;
            }

            const buildUrl = releaseStatus.url || `${config.JENKINS_BASE_URL}/job/${PIPELINE_JOB}/`;

            // Check if build is still running
            if (releaseStatus.status === 'RUNNING') {
                const stageCount = (releaseStatus.stages || []).length;
                const completed = (releaseStatus.stages || []).filter(s => s.status !== 'IN_PROGRESS').length;
                console.log(`[Scheduler] Pipeline #${releaseStatus.buildNumber} running... (${completed}/${stageCount} stages done)`);
                await sleep(pollMs);
                continue;
            }

            // Build finished — extract deploy stages and verify actual downstream status
            const deployStages = (releaseStatus.stages || []).filter(s => (s.name || '').startsWith('Deploy:'));

            const stages = await Promise.all(deployStages.map(async (s) => {
                const stageName = s.name || 'Unknown';
                const { jenkinsJob, jobUrl } = resolveDownstreamJob(stageName);

                // Check actual downstream job status (wfapi lies due to propagate:false)
                let actualStatus = normaliseStageStatus(s.status);
                if (jenkinsJob) {
                    try {
                        const downstream = await fetchJobEnvMap(jenkinsJob);
                        if (downstream.lastBuild) {
                            actualStatus = downstream.lastBuild.status;
                        }
                    } catch (_) { /* fall back to stage status */ }
                }

                return {
                    job: stageName,
                    status: actualStatus,
                    url: jobUrl || buildUrl,
                    durationMs: s.durationMillis || 0,
                };
            }));

            // Merge in per-step post-clone results from the build artifact
            // (postClone-summary.json). Falls back gracefully if artifact
            // missing — e.g. older Jenkinsfile or scp failure.
            const postCloneSteps = await fetchBuildArtifact(
                PIPELINE_JOB,
                releaseStatus.buildNumber,
                'postClone-summary.json',
            );
            if (Array.isArray(postCloneSteps) && postCloneSteps.length > 0) {
                postCloneSteps.forEach(s => {
                    stages.push({
                        job: `Post Clone: ${s.name}`,
                        status: normaliseStageStatus(s.status),
                        url: buildUrl,
                        durationMs: s.durationMs || 0,
                        error: s.error || '',
                        note: s.note || '',
                        group: 'postClone',
                    });
                });
            } else {
                // Artifact missing or empty — fall back to the pipeline stage status from wfapi.
                // This ensures Gchat always shows something when post-clone ran but the summary
                // wasn't captured (e.g. script crashed before write_summary, or scp back failed).
                const pcStage = (releaseStatus.stages || []).find(s =>
                    (s.name || '').toLowerCase().includes('post') &&
                    (s.name || '').toLowerCase().includes('clone')
                );
                if (pcStage) {
                    const stageStatus = normaliseStageStatus(pcStage.status);
                    stages.push({
                        job: 'Post Clone: (no step details captured)',
                        status: stageStatus,
                        url: buildUrl,
                        durationMs: pcStage.durationMillis || 0,
                        error: stageStatus !== 'SUCCESS'
                            ? 'Post-clone script failed or summary file was not written — check if Redis/MySQL/ES/Mongo were down'
                            : '',
                        group: 'postClone',
                    });
                }
            }

            // Recalculate overall status based on actual results
            const hasFailures = stages.some(s => s.status === 'FAILED' || s.status === 'ERROR');
            const hasAborted = stages.some(s => s.status === 'ABORTED');
            let overallStatus = releaseStatus.status;
            if (hasFailures) overallStatus = 'FAILED';
            else if (hasAborted) overallStatus = 'ABORTED';

            return {
                overallStatus,
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

/**
 * Extract Jenkins job name from stage name and resolve URL + job name.
 * Stage names: "Deploy: OFB-Compile-Deploy", "Deploy: BUYER-FE (Website)"
 * Returns { jenkinsJob, jobUrl }
 */
const resolveDownstreamJob = (stageName) => {
    const match = stageName.match(/^Deploy:\s*(.+?)(?:\s*\(.*\))?$/);
    if (!match) return { jenkinsJob: null, jobUrl: null };

    const displayName = match[1].trim();

    try {
        const fileContents = fs.readFileSync('./jobs.yaml', 'utf8');
        const data = yaml.load(fileContents);
        const jobMeta = (data.jobs || []).find(j => j.name === displayName);
        const jenkinsJob = jobMeta ? jobMeta.jenkins_job : displayName;
        return {
            jenkinsJob,
            jobUrl: `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(jenkinsJob)}/`,
        };
    } catch (_) {
        return {
            jenkinsJob: displayName,
            jobUrl: `${config.JENKINS_BASE_URL}/job/${encodeURIComponent(displayName)}/`,
        };
    }
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

// ── Holiday / Off-day Skip Logic ─────────────────────────────────────────────

/**
 * Check if today should be skipped (no deployment).
 * Skips: All Sundays, 2nd Saturday, 4th Saturday of the month.
 */
const shouldSkipToday = () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const dayOfWeek = now.getDay();   // 0 = Sunday, 6 = Saturday
    const dayOfMonth = now.getDate();

    // Skip all Sundays
    if (dayOfWeek === 0) {
        return { skip: true, reason: 'Sunday' };
    }

    // Skip 2nd and 4th Saturdays
    if (dayOfWeek === 6) {
        const nthOccurrence = Math.ceil(dayOfMonth / 7); // 1st, 2nd, 3rd, 4th, 5th
        if (nthOccurrence === 2 || nthOccurrence === 4) {
            return { skip: true, reason: `${nthOccurrence}nd/4th Saturday` };
        }
    }

    return { skip: false };
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

        // Skip Sundays and 2nd/4th Saturdays
        const { skip, reason } = shouldSkipToday();
        if (skip) {
            console.log(`[Scheduler] Skipping today — ${reason} (no deployment)`);
            return;
        }

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
    if (pendingSanityTimer) {
        clearTimeout(pendingSanityTimer);
        pendingSanityTimer = null;
        schedulerState.pendingSanity = null;
        console.log('[Scheduler] Pending sanity timer cleared');
    }
    if (pendingRetryTimer) {
        clearTimeout(pendingRetryTimer);
        pendingRetryTimer = null;
        schedulerState.pendingRetry = null;
        console.log('[Scheduler] Pending retry timer cleared');
    }
    if (pendingAgentSanityTimer) {
        clearTimeout(pendingAgentSanityTimer);
        pendingAgentSanityTimer = null;
        console.log('[Scheduler] Pending agent sanity timer cleared');
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

// ── Manual Deployment Watcher (Release Manager UI) ───────────────────────────

/**
 * Polls a manually-triggered pipeline build and sends the same Gchat card as
 * the cron flow. Runs in the background — the HTTP route should respond to
 * the user immediately and then fire-and-forget this.
 *
 * Differs from runScheduledDeployment: no trigger retry, no sanity queueing.
 * The trigger has already been done by the caller; this only watches.
 */
const watchManualDeployment = async ({ branch, env, previousBuildNumber, startedAt, triggeredBy }) => {
    const runRecord = {
        startedAt,
        finishedAt: null,
        branch,
        env,
        triggeredBy: triggeredBy || 'release-manager',
        status: 'RUNNING',
        results: [],
        notification: null,
    };

    try {
        const pipelineResult = await pollPipelineCompletion(previousBuildNumber);
        runRecord.results = pipelineResult.stages;
        runRecord.status = pipelineResult.overallStatus;
        runRecord.buildUrl = pipelineResult.buildUrl;
    } catch (err) {
        console.error(`[Manual] Watcher poll error: ${err.message}`);
        runRecord.status = 'ERROR';
        runRecord.error = err.message;
    }
    runRecord.finishedAt = new Date().toISOString();

    try {
        const notifResult = await sendDeploymentNotification({
            env,
            branch,
            startedAt: runRecord.startedAt,
            finishedAt: runRecord.finishedAt,
            overallStatus: runRecord.status,
            results: runRecord.results.length > 0
                ? runRecord.results
                : [{ job: 'Pipeline', status: runRecord.status, url: runRecord.buildUrl || '' }],
        });
        runRecord.notification = notifResult;
    } catch (err) {
        console.error(`[Manual] Notification error: ${err.message}`);
        runRecord.notification = { sent: false, reason: err.message };
    }

    // Add to history so manual deploys show up alongside scheduled ones.
    schedulerState.history.unshift(runRecord);
    if (schedulerState.history.length > MAX_HISTORY) {
        schedulerState.history = schedulerState.history.slice(0, MAX_HISTORY);
    }

    return runRecord;
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
    watchManualDeployment,
    getSchedulerState,
    getDeployableJobs,
};
