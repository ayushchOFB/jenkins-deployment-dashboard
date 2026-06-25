/**
 * Scheduled Deployment Pipeline — Configuration
 * ───────────────────────────────────────────────
 * All scheduler settings live here. Change cron, env, branch,
 * webhook URL, or excluded jobs without touching service code.
 */

module.exports = {
    // Cron expression: 08:00 AM every day
    CRON_SCHEDULE: '0 8 * * *',

    // Target environment for scheduled deployments
    TARGET_ENV: 'uat1',

    // Default branch (NOT main — scheduler uses master)
    DEFAULT_BRANCH: 'master',

    // Jobs to EXCLUDE from scheduled pipeline
    EXCLUDED_JOBS: ['Deploy-Libs'],

    // Google Chat Incoming Webhook URL (set via .env or environment variable)
    GCHAT_WEBHOOK_URL: process.env.GCHAT_WEBHOOK_URL || '',

    // Polling interval (ms) while waiting for pipeline to finish
    POLL_INTERVAL_MS: 15000,

    // Max time to wait for pipeline completion (ms) — 2 hours
    POLL_TIMEOUT_MS: 2 * 60 * 60 * 1000,

    // Webhook retry settings
    WEBHOOK_MAX_RETRIES: 3,
    WEBHOOK_RETRY_DELAY_MS: 5000,

    // Enable/disable scheduler (set SCHEDULER_ENABLED=false to disable)
    ENABLED: process.env.SCHEDULER_ENABLED !== 'false',

    // ── Post-deploy Sanity Suite (DevTest) ───────────────────────────────────
    // Triggered 30 min after the 8 AM pipeline finishes, regardless of
    // pipeline status — sanity should run even when some deploys failed.
    SANITY: {
        ENABLED: process.env.SANITY_ENABLED !== 'false',
        JOB: 'Sanity-Suite-OFB',
        DELAY_MS: 30 * 60 * 1000,
        PARAMS: {
            branchName: 'master',
            env_platform: 'STAGING',
            env: 'ofb_uat1',
            test_type: 'CUSTOM_OASYS',
            tests: 'DevTest',
            eInvoiceEnable: 'false',
            pmWorkspace: 'prod',
            EvnVariables: '{}',
        },
    },

    // ── Post-deploy Automation-Agent Sanity (extension flows) ────────────────
    // Runs `node scripts/run-flow-bot.js --sanity` from the automation-agent
    // repo after the same cool-down as the Jenkins sanity above. Reads
    // sanityRunItems + auth from token.json in the automation-agent directory.
    AGENT_SANITY: {
        ENABLED: process.env.AGENT_SANITY_ENABLED !== 'false',
        // Absolute path to automation-agent repo root. Override via env var on server.
        AGENT_PATH: process.env.AUTOMATION_AGENT_PATH || require('path').resolve(__dirname, '../automation-agent'),
        DELAY_MS: 30 * 60 * 1000,
        // Max time to wait for the sanity batch to complete (ms) — 1 hour
        TIMEOUT_MS: 60 * 60 * 1000,
    },
};
