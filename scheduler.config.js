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
};
