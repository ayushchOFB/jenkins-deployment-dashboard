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
    const { env, branch, startedAt, finishedAt, results, overallStatus } = summary;

    const successCount = results.filter(r => r.status === 'SUCCESS').length;
    const failedCount = results.filter(r => r.status === 'FAILED').length;
    const abortedCount = results.filter(r => r.status === 'ABORTED').length;
    const totalCount = results.length;

    const duration = finishedAt && startedAt
        ? formatDuration(new Date(finishedAt) - new Date(startedAt))
        : 'N/A';

    // Header icon based on overall pipeline status
    let statusIcon = '✅';
    if (overallStatus === 'ABORTED') statusIcon = '🚫';
    else if (overallStatus === 'FAILED' || overallStatus === 'ERROR') statusIcon = '❌';
    else if (failedCount > 0 || abortedCount > 0) statusIcon = '⚠️';

    const headerText = `${statusIcon} Deployment Summary — ${env.toUpperCase()} (${formatTime(startedAt)}) — ${overallStatus || 'UNKNOWN'}`;

    // Build per-job lines with distinct icons per status
    const jobLines = results.map(r => {
        let icon = '✔️';
        if (r.status === 'FAILED') icon = '✖️';
        else if (r.status === 'ABORTED') icon = '🚫';
        else if (r.status === 'SKIPPED' || r.status === 'NOT_EXECUTED') icon = '⏭️';
        else if (r.status !== 'SUCCESS') icon = '❓';
        const link = r.url ? `<${r.url}|View Build>` : 'No link';
        return `${icon}  *${r.job}* — ${r.status} — ${link}`;
    }).join('\n');

    let statsLine = `*${successCount}/${totalCount} succeeded*`;
    if (failedCount > 0) statsLine += ` | ${failedCount} failed`;
    if (abortedCount > 0) statsLine += ` | ${abortedCount} aborted`;
    statsLine += ` | Branch: \`${branch}\` | Duration: ${duration}`;

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
