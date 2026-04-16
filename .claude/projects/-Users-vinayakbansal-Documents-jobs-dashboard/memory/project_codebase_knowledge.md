---
name: codebase_knowledge
description: Complete architecture and code knowledge for the Jenkins Deployment Dashboard — file structure, APIs, services, scheduler, and key patterns
type: project
---

# Jenkins Deployment Dashboard — Codebase Knowledge

## Tech Stack
- **Backend:** Node.js + Express (port 5001)
- **Frontend:** Vanilla JS + HTML/CSS (no framework)
- **Process Manager:** PM2
- **Config:** YAML (jobs.yaml) + JS (jobs.config.js, scheduler.config.js)
- **Dependencies:** node-fetch, js-yaml, node-cron, dotenv, body-parser

## Server: 10.22.0.132 (ofb-uat2)
- Deploy path: `/root/jenkins-dashboard`
- PM2 app name: `jenkins-dashboard`
- Jenkins: `https://stg-jenkins.ofbusiness.co.in`

---

## File Structure

```
├── index.js                          # Express server entry (port 5001), loads dotenv, inits scheduler
├── jobs.yaml                         # Job manifest — 37 jobs in 3 groups, deployed in listed order
├── jobs.config.js                    # Jenkins URL, credentials, JOBS list, ENV/BRANCH param names, service monitoring config
├── scheduler.config.js               # Scheduler settings: cron, env, branch, excluded jobs, webhook, polling
├── .env                              # JENKINS_USER, JENKINS_TOKEN, GCHAT_WEBHOOK_URL (gitignored)
├── Jenkinsfile                       # QA-Release-Deployment pipeline — sequential job execution
├── ecosystem.config.js               # PM2 config
├── deploy.sh                         # Server deploy script (git pull, npm install, pm2 restart)
├── routes/
│   ├── deploymentRoutes.js           # Main API routes (deployments, history, trigger, logs, abort, status)
│   └── schedulerRoutes.js            # Scheduler API routes (status, trigger, history, jobs)
├── services/
│   ├── jenkinsService.js             # Jenkins API: fetch builds, trigger jobs, pipeline stages, logs
│   ├── serverStatusService.js        # Health checks for OFB/Orion services per environment
│   ├── schedulerService.js           # Daily cron scheduler: trigger → poll → verify → notify
│   └── chatNotificationService.js    # Google Chat webhook with retry
└── public/
    ├── index.html                    # Dashboard UI
    ├── js/app.js                     # Frontend logic (~2000 lines)
    └── css/dashboard.css             # Styling
```

---

## jobs.yaml — Job Manifest

3 groups, deployed in this exact order:
1. **Backend:** STG-Clone-Prod-Data, Bheem-Compile-Deploy, Deploy-Libs, Informer-*, Notification-*, OFB-*, OFB-FS-*, OFB-Scheduler-*
2. **Frontend:** BUYER-FE, Merge-FE, OASYS-FE, OASYS-TS, OFB-Admin, Orion-Admin, Orion-FE, Supplier-FE
3. **Orion:** Orion-Compile*, Orion-Deploy, Orion-FS-*, Orion-Scheduler-*

### Key job metadata fields:
- `jenkins_job` — actual Jenkins job name (may differ from display name, e.g., OFB-Admin → OfB-Admin)
- `fe_type`: `none` (single stage), `standard` (Website + MSite), `special` (Merge-FE: 4 runs)
- `env_prefix`: `"ofb_"` — prepended to env value (used by: OASYS-TS, Notification-Deploy, OFB-Compile-Deploy)
- `extra_params`: additional params (STG-Clone-Prod-Data has `fullData: true`)
- `has_libs_param`: true for Deploy-Libs only
- `runs`: array for special fe_type (Merge-FE has 4 deploy_type/domain combos)

---

## API Routes

### Main (deploymentRoutes.js)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/deployments` | GET | All jobs' latest builds per environment |
| `/api/history/:job` | GET | Last 20 builds for a job |
| `/api/build/:job/:number` | GET | Specific build details |
| `/api/server-status?env=` | GET | Health check for services |
| `/api/jobs` | GET | Full manifest from jobs.yaml |
| `/api/trigger-release` | POST | Trigger QA-Release-Deployment pipeline |
| `/api/release-logs` | GET | Stream console logs (progressive) |
| `/api/abort-release` | POST | Stop running release build |
| `/api/release-status` | GET | Current release build + pipeline stages |
| `/api/config` | GET | Dashboard config (auth status, jobs) |

### Scheduler (schedulerRoutes.js)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/scheduler/status` | GET | Config, last run, next run, current run |
| `/api/scheduler/jobs` | GET | Jobs that scheduler will deploy |
| `/api/scheduler/trigger` | POST | Manual trigger (accepts `{branch, env, jobs}`) |
| `/api/scheduler/history` | GET | Last 10 run results |

---

## Jenkins Service (jenkinsService.js)

### Key Functions
- `fetchAllDeployments()` — parallel fetch of all jobs, returns flat array (job × env)
- `fetchJobEnvMap(jobName)` — scans last 60 builds, returns envMap + lastBuild
- `fetchBuildHistory(jobName)` — last 20 builds for history modal
- `fetchBuild(jobName, buildNumber)` — specific build
- `triggerJob(jobName, params)` — POST to buildWithParameters
- `fetchReleaseStatus()` — latest QA-Release-Deployment build + pipeline stages
- `fetchPipelineStages(jobName, buildNumber)` — wfapi/describe
- `fetchJobLogs(jobName, start, buildNumber)` — progressive console output
- `abortJob(jobName)` — stop lastBuild

### Key Patterns
- Auth: Basic Auth from `JENKINS_USER` + `JENKINS_TOKEN` env vars
- `normaliseBuild()` returns `buildNumber` (NOT `number`) — important for references
- `normaliseEnv()` handles messy formats: "ofb_stg3" → "stg3", "STG-5" → "stg5"
- ENV param names tried in order: Env, ENV, ENVIRONMENT, env, etc.
- BRANCH param names: branchName, BRANCH, branch, etc.

---

## Jenkinsfile (QA-Release-Deployment)

### Parameters
- `RELEASE_BRANCH` (default: main), `STG_ENV` (choice), `JOBS_TO_RELEASE` (comma-separated), `LIBS_TO_DEPLOY`, `DRY_RUN`, `GCHAT_WEBHOOK_URL`, `NOTIFY_EMAIL`

### Execution Flow
1. **Initialize:** Read jobs.yaml, parse JOBS_TO_RELEASE
2. **Phase 1:** Deploy-Libs (if selected)
3. **Phase 2:** Deploy services in jobs.yaml order:
   - `fe_type: none` → single stage
   - `fe_type: standard` → Website + MSite stages
   - `fe_type: special` → runs array (Merge-FE: 4 stages)
4. **Final Reporting:** Email + GChat card

### executeJob() Logic
- Uses `propagate: false` + `catchError(buildResult: 'SUCCESS', stageResult: 'FAILURE')` — **parent pipeline always shows SUCCESS even if downstream fails**
- This means wfapi stage statuses are unreliable — scheduler must check downstream jobs directly
- `env_prefix` from job metadata prepended to env value
- `extra_params` from job metadata passed as additional build parameters
- Branch param name: `branchName` for most, `branch_to_deploy` for Deploy-Libs

---

## Scheduler System

### Config (scheduler.config.js)
- Cron: `0 8 * * *` (08:00 AM IST daily)
- Target: `uat1`, Branch: `master`
- Excluded: `Deploy-Libs`
- Polling: 15s interval, 2hr timeout
- Webhook: 3 retries, 5s delay

### Flow (schedulerService.js)
1. Cron fires → `runScheduledDeployment()`
2. Read all jobs from jobs.yaml (exclude Deploy-Libs)
3. Note current latest build number
4. `triggerJob('QA-Release-Deployment', {RELEASE_BRANCH: master, STG_ENV: uat1, ...})`
5. Poll `fetchReleaseStatus()` every 15s, waiting for build > previous number
6. On completion: for each deploy stage, call `fetchJobEnvMap(downstreamJob)` to get **actual** status
7. Send Google Chat notification via webhook
8. Store result in memory (last 10 runs)

### Manual Trigger
```bash
# All jobs
curl -s -X POST http://localhost:5001/api/scheduler/trigger

# Specific jobs
curl -s -X POST http://localhost:5001/api/scheduler/trigger \
  -H "Content-Type: application/json" \
  -d '{"jobs": ["STG-Clone-Prod-Data", "OFB-Compile-Deploy"]}'
```

### Google Chat Notification Format
- Header: status icon + env + time + overall status
- Per-job: icon + job name + status + link to downstream Jenkins job
- Footer: success/fail counts + branch + duration
- Icons: ✅ SUCCESS pipeline, ❌ FAILED, 🚫 ABORTED, ⚠️ partial failures

---

## Known Gotchas

1. **propagate: false** — Jenkins wfapi always shows stages as SUCCESS. Scheduler works around this by checking downstream jobs directly.
2. **buildNumber vs number** — `normaliseBuild()` returns `buildNumber`. Use this, not `number`.
3. **env_prefix** — Some jobs need `ofb_` prefix: OASYS-TS, Notification-Deploy, OFB-Compile-Deploy. Set in jobs.yaml.
4. **PM2 restart kills polling** — If server restarts mid-pipeline, the notification won't be sent.
5. **Frontend jobs have multiple stages** — BUYER-FE runs as Website + MSite. Downstream status check returns latest build status for both stages (may not distinguish between the two).
6. **Manual flow uses `main` branch, scheduler uses `master`** — these are intentionally different.
7. **STG-Clone-Prod-Data** needs `fullData: true` param — handled via `extra_params` in jobs.yaml.

---

## Deploy Commands

```bash
# On server (10.22.0.132)
cd /root/jenkins-dashboard
git pull && npm install && pm2 restart jenkins-dashboard --update-env

# Or use deploy.sh (requires JENKINS_USER + JENKINS_TOKEN)
JENKINS_USER=xxx JENKINS_TOKEN=xxx ./deploy.sh

# Check logs
pm2 logs jenkins-dashboard
pm2 logs jenkins-dashboard | grep Scheduler

# Abort running pipeline
curl -s -X POST http://localhost:5001/api/abort-release
```
