const express = require('express');
const router = express.Router();
const fs = require('fs');
const yaml = require('js-yaml');
const { fetchAllDeployments, fetchBuildHistory, triggerJob, fetchReleaseStatus, fetchJobLogs, fetchBuild, abortJob } = require('../services/jenkinsService');
const { checkServerStatus } = require('../services/serverStatusService');
const { watchManualDeployment } = require('../services/schedulerService');
const config = require('../jobs.config');

// GET /api/deployments
// Returns flat array — one record per (job × environment).
router.get('/deployments', async (req, res) => {
  try {
    const data = await fetchAllDeployments();
    res.json(data);
  } catch (err) {
    console.error('GET /api/deployments error:', err);
    res.status(500).json({ error: 'Failed to fetch from Jenkins' });
  }
});

// GET /api/history/:job
router.get('/history/:job', async (req, res) => {
  try {
    const history = await fetchBuildHistory(req.params.job);
    res.json({ job: req.params.job, history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/build/:job/:number
router.get('/build/:job/:number', async (req, res) => {
  try {
    const { job, number } = req.params;
    const build = await fetchBuild(job, number);
    if (!build) return res.status(404).json({ error: 'Build not found' });
    res.json(build);
  } catch (err) {
    console.error(`GET /api/build/${req.params.job}/${req.params.number} error:`, err);
    res.status(500).json({ error: 'Failed to fetch build details' });
  }
});

// GET /api/server-status
router.get('/server-status', async (req, res) => {
  try {
    const { env } = req.query;
    const status = await checkServerStatus(env);
    res.json(status);
  } catch (err) {
    console.error('GET /api/server-status error:', err);
    res.status(500).json({ error: 'Failed to fetch server status' });
  }
});

// GET /api/jobs — Full manifest from YAML
router.get('/jobs', (req, res) => {
  try {
    const fileContents = fs.readFileSync('./jobs.yaml', 'utf8');
    const data = yaml.load(fileContents);
    res.json({ jobs: data.jobs || [] });
  } catch (e) {
    console.error('Error reading jobs.yaml:', e);
    res.json({ jobs: config.JOBS.map(j => ({ name: j })) });
  }
});

// POST /api/trigger-release
router.post('/trigger-release', async (req, res) => {
  try {
    const { branch, env, jobsToRelease, libsToDeploy, dryRun } = req.body;

    if (!branch || !env) {
      return res.status(400).json({ error: 'Branch and Environment are required' });
    }

    // Snapshot current build number BEFORE triggering so the background
    // watcher can wait for a strictly newer build. Skip for dry runs — no
    // notification will be sent.
    let previousBuildNumber = 0;
    if (!dryRun) {
      try {
        const cur = await fetchReleaseStatus();
        if (cur && cur.buildNumber) previousBuildNumber = cur.buildNumber;
      } catch (_) { /* first-ever build / Jenkins flaky — fall back to 0 */ }
    }

    const params = {
      RELEASE_BRANCH: branch,
      STG_ENV: env,
      JOBS_TO_RELEASE: (jobsToRelease || []).join(','),
      LIBS_TO_DEPLOY: (libsToDeploy || []).join(','),
      DRY_RUN: String(!!dryRun)
    };

    const startedAt = new Date().toISOString();
    const result = await triggerJob('QA-Release-Deployment', params);

    // Fire-and-forget Gchat watcher for real (non-dry-run) deploys.
    if (!dryRun) {
      watchManualDeployment({
        branch,
        env,
        previousBuildNumber,
        startedAt,
        triggeredBy: 'release-manager',
      }).catch(err => {
        console.error('[Manual] Watcher unhandled error:', err.message);
      });
    }

    res.json({ success: true, message: 'Release triggered successfully', ...result });
  } catch (err) {
    console.error('POST /api/trigger-release error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/release-logs?number=123&start=0
router.get('/release-logs', async (req, res) => {
  try {
    const start = req.query.start || 0;
    const number = req.query.number || null;
    const logs = await fetchJobLogs('QA-Release-Deployment', start, number);
    res.json(logs);
  } catch (err) {
    console.error('GET /api/release-logs error:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// POST /api/abort-release
router.post('/abort-release', async (req, res) => {
  try {
    const result = await abortJob('QA-Release-Deployment');
    res.json(result);
  } catch (err) {
    console.error('POST /api/abort-release error:', err);
    res.status(500).json({ error: 'Failed to abort release' });
  }
});

// GET /api/release-status
router.get('/release-status', async (req, res) => {
  try {
    const status = await fetchReleaseStatus();
    res.json(status);
  } catch (err) {
    console.error('GET /api/release-status error:', err);
    res.status(500).json({ error: 'Failed to fetch release status' });
  }
});

// GET /api/config
router.get('/config', (req, res) => res.json({
  jenkinsBaseUrl: config.JENKINS_BASE_URL,
  jobs: config.JOBS,
  authConfigured: !!(config.JENKINS_USER && config.JENKINS_TOKEN),
}));

module.exports = router;
