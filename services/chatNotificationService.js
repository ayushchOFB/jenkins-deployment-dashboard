/**
 * Google Chat Notification Service
 * ─────────────────────────────────
 * Sends deployment summaries to Google Chat via Incoming Webhook.
 * Supports retry on failure and structured card formatting.
 */

const fetch = require('node-fetch');
const schedulerConfig = require('../scheduler.config');

/**
 * Send a deployment summary to Google Chat.
 * @param {Object} summary - { env, branch, startedAt, finishedAt, results: [{ job, status, url }] }
 */
const sendDeploymentNotification = async (summary) => {
    const webhookUrl = schedulerConfig.GCHAT_WEBHOOK_URL;
    if (!webhookUrl) {
        console.warn('[Chat] GCHAT_WEBHOOK_URL not set — skipping notification');
        return { sent: false, reason: 'no_webhook_url' };
    }

    const payload = buildChatPayload(summary);

    let lastError = null;
    for (let attempt = 1; attempt <= schedulerConfig.WEBHOOK_MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(payload),
                timeout: 10000,
            });

            if (res.ok) {
                console.log(`[Chat] Notification sent successfully (attempt ${attempt})`);
                return { sent: true };
            }

            lastError = `HTTP ${res.status}: ${await res.text()}`;
            console.error(`[Chat] Attempt ${attempt} failed: ${lastError}`);
        } catch (err) {
            lastError = err.message;
            console.error(`[Chat] Attempt ${attempt} error: ${lastError}`);
        }

        if (attempt < schedulerConfig.WEBHOOK_MAX_RETRIES) {
            await sleep(schedulerConfig.WEBHOOK_RETRY_DELAY_MS);
        }
    }

    console.error(`[Chat] All ${schedulerConfig.WEBHOOK_MAX_RETRIES} attempts failed. Last error: ${lastError}`);
    return { sent: false, reason: lastError };
};

/**
 * Build Google Chat message payload with structured card.
 */
const buildChatPayload = (summary) => {
    const { env, branch, startedAt, finishedAt, results } = summary;

    const successCount = results.filter(r => r.status === 'SUCCESS').length;
    const failedCount = results.filter(r => r.status !== 'SUCCESS').length;
    const totalCount = results.length;

    const duration = finishedAt && startedAt
        ? formatDuration(new Date(finishedAt) - new Date(startedAt))
        : 'N/A';

    const statusIcon = failedCount === 0 ? '✅' : '⚠️';
    const headerText = `${statusIcon} Deployment Summary — ${env.toUpperCase()} (${formatTime(startedAt)})`;

    // Build per-job lines
    const jobLines = results.map(r => {
        const icon = r.status === 'SUCCESS' ? '✔️' : '✖️';
        const link = r.url ? `<${r.url}|View Build>` : 'No link';
        return `${icon}  *${r.job}* — ${r.status} — ${link}`;
    }).join('\n');

    const statsLine = `*${successCount}/${totalCount} succeeded* | ${failedCount} failed | Branch: \`${branch}\` | Duration: ${duration}`;

    // Google Chat simple text message (works with all webhook types)
    return {
        text: [
            `*${headerText}*`,
            '─'.repeat(40),
            jobLines,
            '─'.repeat(40),
            statsLine,
        ].join('\n'),
    };
};

const formatTime = (isoStr) => {
    if (!isoStr) return 'N/A';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
};

const formatDuration = (ms) => {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    sendDeploymentNotification,
    buildChatPayload,
};
