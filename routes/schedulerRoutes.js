/**
 * Scheduler API Routes
 * ────────────────────
 * Endpoints for viewing scheduler status, triggering manual runs,
 * and viewing run history.
 */

const express = require('express');
const router = express.Router();
const { getSchedulerState, runScheduledDeployment, getDeployableJobs } = require('../services/schedulerService');

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

module.exports = router;
