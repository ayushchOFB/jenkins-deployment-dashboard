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

// ── Helpers ──────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const truncate = (s, n) => (!s ? '' : (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s));

const getStatusEmoji = (status) => {
    if (status === 'FAILED' || status === 'ERROR') return '🔴';
    if (status === 'ABORTED') return '🟠';
    if (status === 'SKIPPED' || status === 'NOT_EXECUTED') return '⚪';
    if (status === 'SUCCESS') return '🟢';
    return '⚪';
};

const headerEmoji = (overallStatus, hasFails) => {
    if (overallStatus === 'ABORTED') return '🚫';
    if (overallStatus === 'FAILED' || overallStatus === 'ERROR') return '❌';
    if (hasFails) return '⚠️';
    return '✅';
};

const jobRow = (r) => {
    const widget = {
        decoratedText: {
            startIcon: { knownIcon: 'NONE' },
            text: `${getStatusEmoji(r.status)} <b>${esc(r.job)}</b>`,
            bottomLabel: r.status,
            wrapText: true,
        },
    };
    if (r.url) {
        widget.decoratedText.button = {
            text: 'View Build',
            onClick: { openLink: { url: r.url } },
        };
    }
    return widget;
};

/**
 * Build Google Chat Card V2 payload for a deployment run.
 */
const buildChatPayload = (summary) => {
    const { env, branch, startedAt, finishedAt, results, overallStatus } = summary;

    // Split deploy jobs vs post-clone steps
    const isPostClone = (r) => (r.group === 'postClone') || (r.job || '').startsWith('Post Clone:');
    const deployResults = results.filter(r => !isPostClone(r));
    const postCloneResults = results.filter(isPostClone);

    const failedJobs   = deployResults.filter(r => r.status === 'FAILED' || r.status === 'ERROR');
    const abortedJobs  = deployResults.filter(r => r.status === 'ABORTED');
    const passedJobs   = deployResults.filter(r => r.status === 'SUCCESS');
    const otherJobs    = deployResults.filter(r => !['SUCCESS','FAILED','ERROR','ABORTED'].includes(r.status));

    const successCount = passedJobs.length;
    const failedCount  = failedJobs.length;
    const abortedCount = abortedJobs.length;
    const totalCount   = deployResults.length;

    const pcPassed = postCloneResults.filter(r => r.status === 'SUCCESS').length;
    const pcFailed = postCloneResults.filter(r => r.status !== 'SUCCESS');

    const duration = finishedAt && startedAt
        ? formatDuration(new Date(finishedAt) - new Date(startedAt))
        : 'N/A';

    const icon = headerEmoji(overallStatus, failedCount > 0 || abortedCount > 0);
    const sections = [];

    // ── Section 1: Overview ──
    let resultText = `<b>${successCount}/${totalCount}</b> succeeded`;
    if (failedCount > 0)  resultText += ` · <font color="#cc0000">${failedCount} failed</font>`;
    if (abortedCount > 0) resultText += ` · ${abortedCount} aborted`;

    sections.push({
        widgets: [
            {
                decoratedText: {
                    topLabel: 'Environment',
                    text: `<b>${esc((env || '').toUpperCase())}</b>`,
                    bottomLabel: overallStatus || 'UNKNOWN',
                },
            },
            {
                decoratedText: {
                    topLabel: 'Branch',
                    text: `<b>${esc(branch)}</b>`,
                    bottomLabel: `Duration: ${duration}`,
                },
            },
            {
                decoratedText: {
                    topLabel: 'Result',
                    text: resultText,
                    bottomLabel: postCloneResults.length > 0
                        ? `Post-clone: ${pcPassed}/${postCloneResults.length}`
                        : 'No post-clone',
                },
            },
        ],
    });

    // ── Section 2: Failed Jobs ──
    if (failedJobs.length > 0) {
        sections.push({
            header: `🚨 <b>Failed Jobs (${failedJobs.length})</b>`,
            widgets: failedJobs.map(jobRow),
        });
    }

    // ── Section 3: Aborted Jobs ──
    if (abortedJobs.length > 0) {
        sections.push({
            header: `🚫 <b>Aborted Jobs (${abortedJobs.length})</b>`,
            widgets: abortedJobs.map(jobRow),
        });
    }

    // ── Section 4: Other (non-standard status) ──
    if (otherJobs.length > 0) {
        sections.push({
            header: `⏭️ <b>Other (${otherJobs.length})</b>`,
            widgets: otherJobs.map(jobRow),
        });
    }

    // ── Section 5: Passed Jobs (collapsible to keep card compact) ──
    if (passedJobs.length > 0) {
        sections.push({
            header: `✅ <b>Passed Jobs (${passedJobs.length})</b>`,
            collapsible: true,
            uncollapsibleWidgetsCount: 0,
            widgets: passedJobs.map(jobRow),
        });
    }

    // ── Section 6: Post Clone ──
    if (postCloneResults.length > 0) {
        const postCloneWidgets = [];

        if (pcFailed.length === 0) {
            postCloneWidgets.push({
                decoratedText: {
                    text: `🟢 <b>All ${postCloneResults.length} steps passed</b>`,
                    wrapText: true,
                },
            });
        } else {
            pcFailed.forEach(s => {
                const stepName = (s.job || '').replace(/^Post Clone:\s*/, '');
                const w = {
                    decoratedText: {
                        text: `${getStatusEmoji(s.status)} <b>${esc(stepName)}</b>`,
                        bottomLabel: s.status,
                        wrapText: true,
                    },
                };
                if (s.error) {
                    w.decoratedText.text += `<br><font color="#666666">${esc(truncate(s.error, 200))}</font>`;
                }
                postCloneWidgets.push(w);
            });
            if (pcPassed > 0) {
                postCloneWidgets.push({
                    textParagraph: {
                        text: `<i>+ ${pcPassed} other step${pcPassed === 1 ? '' : 's'} passed</i>`,
                    },
                });
            }
        }

        sections.push({
            header: `🧹 <b>Post Clone (${pcPassed}/${postCloneResults.length})</b>`,
            widgets: postCloneWidgets,
        });
    }

    // ── Section 7: Footer ──
    sections.push({
        widgets: [
            {
                textParagraph: {
                    text: `<font color="#888888">Started ${formatTime(startedAt)} IST · finished ${formatTime(finishedAt)} IST</font>`,
                },
            },
        ],
    });

    return {
        cardsV2: [
            {
                cardId: `deployment-${Date.now()}`,
                card: {
                    header: {
                        title: `${icon} Deployment Summary`,
                        subtitle: `${esc((env || '').toUpperCase())} · ${overallStatus || 'UNKNOWN'} · ${duration}`,
                        imageType: 'CIRCLE',
                    },
                    sections,
                },
            },
        ],
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
