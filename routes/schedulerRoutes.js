/**
 * Scheduler API Routes
 * ────────────────────
 * Endpoints for viewing scheduler status, triggering manual runs,
 * and viewing run history.
 */

const express = require('express');
const router = express.Router();
const { getSchedulerState, runScheduledDeployment, getDeployableJobs, watchManualDeployment } = require('../services/schedulerService');
const { fetchReleaseStatus } = require('../services/jenkinsService');

// GET /api/scheduler/status — Current scheduler state + config
router.get('/status', (req, res) => {
    res.json(getSchedulerState());
});

// GET /api/scheduler/jobs — List jobs that the scheduler will deploy
router.get('/jobs', (req, res) => {
    const jobs = getDeployableJobs();
    res.json({ count: jobs.length, jobs });
});

// POST /api/scheduler/trigger — Manually trigger a scheduled run
router.post('/trigger', async (req, res) => {
    const state = getSchedulerState();
    if (state.currentRun) {
        return res.status(409).json({ error: 'A scheduled deployment is already running' });
    }

    const { branch, env, jobs } = req.body || {};

    // Fire and forget — respond immediately, run in background
    res.json({
        success: true,
        message: 'Scheduled deployment triggered',
        env: env || state.config.env,
        branch: branch || state.config.branch,
        jobs: jobs || 'all',
    });

    runScheduledDeployment({
        branch,
        env,
        jobs,
        triggeredBy: 'manual',
    }).catch(err => {
        console.error(`[Scheduler] Manual trigger error: ${err.message}`);
    });
});

// GET /api/scheduler/history — Last 10 run results
router.get('/history', (req, res) => {
    const state = getSchedulerState();
    res.json({ history: state.history });
});

// POST /api/scheduler/renotify — Watch the current/latest Jenkins build and send Gchat notification when done
// Use this when the dashboard timed out but the pipeline is still running on Jenkins.
router.post('/renotify', async (req, res) => {
    let currentBuild;
    try {
        currentBuild = await fetchReleaseStatus();
    } catch (err) {
        return res.status(502).json({ error: `Could not fetch Jenkins build status: ${err.message}` });
    }

    if (!currentBuild || !currentBuild.buildNumber) {
        return res.status(404).json({ error: 'No active build found on Jenkins' });
    }

    const { branch, env } = req.body || {};
    const config = getSchedulerState().config;

    res.json({
        success: true,
        message: `Watching build #${currentBuild.buildNumber} — Gchat notification will be sent when it finishes`,
        buildNumber: currentBuild.buildNumber,
        status: currentBuild.status,
    });

    // Watch from the previous build number so it picks up the current one
    watchManualDeployment({
        branch: branch || config.branch,
        env: env || config.env,
        previousBuildNumber: currentBuild.buildNumber - 1,
        startedAt: new Date().toISOString(),
        triggeredBy: 'renotify',
    }).catch(err => {
        console.error(`[Renotify] Error: ${err.message}`);
    });
});

module.exports = router;
