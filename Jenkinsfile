pipeline {
    agent any

    options {
        timeout(time: 4, unit: 'HOURS')
        disableConcurrentBuilds()
        ansiColor('xterm')
    }

    parameters {
        string(name: 'RELEASE_BRANCH', defaultValue: 'main', description: 'Branch for selected jobs')
        choice(name: 'STG_ENV', choices: ['stg1', 'stg2', 'stg3', 'stg4', 'stg5', 'stg6', 'stg7', 'stg8', 'stg9', 'stg10', 'uat1', 'uat2'], description: 'Deploy target')
        text(name: 'JOBS_TO_RELEASE', defaultValue: '', description: 'Selected jobs (comma or newline separated)')
        text(name: 'LIBS_TO_DEPLOY', defaultValue: '', description: 'Optional libs to deploy')
        string(name: 'NOTIFY_EMAIL', defaultValue: 'vinayak.bansal@ofbusiness.in', description: 'Reporting emails')
        string(name: 'GCHAT_WEBHOOK_URL', defaultValue: '', description: 'GChat Hook')
        booleanParam(name: 'DR_RUN', defaultValue: false, description: 'Dry Run mode') // Match dashboard key if needed
        booleanParam(name: 'DRY_RUN', defaultValue: false, description: 'Dry Run mode')
    }

    environment {
        DEPLOY_RESULTS = "" 
    }

    stages {
        stage('Initialize & Debug') {
            steps {
                script {
                    echo "--- Initializing QA Release Pipeline ---"
                    
                    // Robust parameter resolution: Check env first (passed by API), then params (defined in UI), then default
                    def targetEnv = env.STG_ENV ?: params.STG_ENV ?: "stg1"
                    def branchToUse = env.RELEASE_BRANCH ?: params.RELEASE_BRANCH ?: "main"
                    def rawJobs = env.JOBS_TO_RELEASE ?: params.JOBS_TO_RELEASE ?: ""
                    
                    echo "DEBUG: env.STG_ENV = ${env.STG_ENV}"
                    echo "DEBUG: params.STG_ENV = ${params.STG_ENV}"
                    echo "DEBUG: env.JOBS_TO_RELEASE = ${env.JOBS_TO_RELEASE}"
                    echo "DEBUG: params.JOBS_TO_RELEASE = ${params.JOBS_TO_RELEASE}"
                    
                    echo "FINAL Target Environment: ${targetEnv}"
                    echo "FINAL Release Branch: ${branchToUse}"
                    
                    // Load jobs from YAML
                    def manifest = readYaml file: 'jobs.yaml'
                    dest_jobs = manifest.jobs
                    
                    // Parse jobs supports comma or newline
                    release_jobs_list = rawJobs.split(/[,\n]/).collect { it.trim() }.findAll { it }
                    echo "FINAL Jobs selected for release: ${release_jobs_list}"
                    
                    results = []
                    postCloneStatus = 'NOT_RUN'
                }
            }
        }

        stage('Execute Deployments') {
            steps {
                script {
                    def branchToUse = env.RELEASE_BRANCH ?: params.RELEASE_BRANCH ?: "main"
                    def libsToDeploy = env.LIBS_TO_DEPLOY ?: params.LIBS_TO_DEPLOY ?: ""
                    
                    // --- STEP 1: Deploy Libraries First ---
                    def libJobMeta = dest_jobs.find { it.name == 'Deploy-Libs' }
                    if (libJobMeta && (release_jobs_list.contains('Deploy-Libs') || libsToDeploy)) {
                        echo "--- Phase 1: Deploying Libraries ---"
                        executeJob(libJobMeta.name, libJobMeta.jenkins_job, branchToUse, null, null, libJobMeta)
                    }

                    // --- STEP 2: Deploy Remaining Services ---
                    echo "--- Phase 2: Deploying Services ---"
                    dest_jobs.each { jobMeta ->
                        def jobDisplayName = jobMeta.name
                        def jenkinsJobName = jobMeta.jenkins_job
                        
                        // Skip if already deployed in Step 1 or not selected
                        if (jobDisplayName == 'Deploy-Libs') return
                        
                        if (!release_jobs_list.contains(jobDisplayName)) {
                            echo "Skipping ${jobDisplayName} (not selected)"
                            results.add([
                                name: jobDisplayName,
                                branch: "-",
                                type: "-",
                                domain: "-",
                                status: "SKIPPED",
                                duration: "0s"
                            ])
                            return
                        }
                        
                        echo "Processing Job: ${jobDisplayName} (Branch: ${branchToUse})"

                        if (jobMeta.fe_type == 'standard') {
                            stage("Deploy: ${jobDisplayName} (Website)") {
                                executeJob(jobDisplayName, jenkinsJobName, branchToUse, 'WEB_SITE', null, jobMeta)
                            }
                            stage("Deploy: ${jobDisplayName} (MSite)") {
                                executeJob(jobDisplayName, jenkinsJobName, branchToUse, 'M_SITE', null, jobMeta)
                            }
                        } else if (jobMeta.fe_type == 'special') {
                            jobMeta.runs.each { run ->
                                stage("Deploy: ${jobDisplayName} (${run.deploy_type} - ${run.domain})") {
                                    executeJob(jobDisplayName, jenkinsJobName, branchToUse, run.deploy_type, run.domain, jobMeta)
                                }
                            }
                        } else {
                            stage("Deploy: ${jobDisplayName}") {
                                executeJob(jobDisplayName, jenkinsJobName, branchToUse, null, null, jobMeta)
                            }
                        }
                    }
                }
            }
        }

        stage('Post Execution / Post Clone') {
            steps {
                script {
                    def uat1Host = '10.22.0.131'
                    def sshUser = 'root'
                    def startTime = System.currentTimeMillis()

                    echo "--- Running Post Clone Script on ${uat1Host} ---"
                    try {
                        sh """
                            scp -o StrictHostKeyChecking=no postClone.sh ${sshUser}@${uat1Host}:/tmp/postClone.sh
                            ssh -o StrictHostKeyChecking=no ${sshUser}@${uat1Host} 'chmod +x /tmp/postClone.sh && /tmp/postClone.sh'
                        """
                        postCloneStatus = 'SUCCESS'
                    } catch (Exception e) {
                        echo "Post Clone failed: ${e.message}"
                        postCloneStatus = 'FAILED'
                    }

                    def durationStr = formatDuration(System.currentTimeMillis() - startTime)
                    results.add([
                        name: 'Post Clone (uat1)',
                        branch: '-',
                        type: '-',
                        domain: '-',
                        status: postCloneStatus,
                        duration: durationStr
                    ])
                }
            }
        }

        stage('Final Reporting') {
            steps {
                script {
                    generateAndSendReports()
                }
            }
        }
    }
}

/**
 * Executes a Jenkins job with parameters and tracks results.
 */
def executeJob(displayName, jobName, branch, deployType, domain, meta) {
    def startTime = System.currentTimeMillis()
    def status = "SUCCESS"
    def targetEnv = params.STG_ENV ?: "stg1"
    def dryExecution = (params.DRY_RUN == true || params.DR_RUN == true)
    
    def branchParamName = meta.branch_param ?: (jobName == 'Deploy-Libs') ? 'branch_to_deploy' : 
                         (jobName == 'Merge-FE') ? 'branchName' : 'branchName'
    
    def deployTypeParamName = (meta.type == 'frontend' || jobName == 'Merge-FE') ? 'Platform' : 'DEPLOY_TYPE'
    def domainParamName     = (jobName == 'Merge-FE') ? 'Domain' : 'DOMAIN'
    
    def finalEnvValue = "ofb_" + targetEnv
    if (meta.env_prefix) {
        finalEnvValue = meta.env_prefix + targetEnv
    }
    
    def targetBranch = meta.branch ?: branch
    def jobParams = [
        string(name: branchParamName, value: targetBranch)
    ]
    
    if (deployType) jobParams.add(string(name: deployTypeParamName, value: deployType))
    if (domain) jobParams.add(string(name: domainParamName, value: domain))
    jobParams.add(string(name: 'Env', value: finalEnvValue))
    
    if (jobName == 'Merge-FE') {
        jobParams.add(string(name: 'SubDomain', value: 'OFB'))
    }
    
    if (meta.has_libs_param) {
        def libsToDeploy = env.LIBS_TO_DEPLOY ?: params.LIBS_TO_DEPLOY ?: ""
        if (libsToDeploy) {
            jobParams.add(text(name: 'library_to_deploy', value: libsToDeploy))
        }
    }

    // Pass any extra_params defined in jobs.yaml
    if (meta.extra_params) {
        meta.extra_params.each { key, value ->
            if (value instanceof Boolean) {
                jobParams.add(booleanParam(name: key, value: value))
            } else {
                jobParams.add(string(name: key, value: String.valueOf(value)))
            }
        }
    }

    echo ">>> Triggering ${jobName} | Branch: ${targetBranch} | Env: ${targetEnv} | Type: ${deployType ?: 'N/A'} | Domain: ${domain ?: 'N/A'}"
    
    try {
        if (dryExecution) {
            echo "[DRY RUN] Would trigger ${jobName} with params ${jobParams}"
            sleep 1
        } else {
            catchError(buildResult: 'SUCCESS', stageResult: 'FAILURE') {
                def jobBuild = build job: jobName, parameters: jobParams, wait: true, propagate: false
                status = jobBuild.result
            }
        }
    } catch (Exception e) {
        echo "Error triggering job ${jobName}: ${e.message}"
        status = "FAILED"
    }

    def endTime = System.currentTimeMillis()
    def durationStr = formatDuration(endTime - startTime)
    
    results.add([
        name: displayName,
        branch: targetBranch,
        type: deployType ?: "-",
        domain: domain ?: "-",
        status: status,
        duration: durationStr
    ])
}

def formatDuration(ms) {
    def seconds = (ms / 1000) as Integer
    if (seconds < 60) return "${seconds}s"
    def minutes = (seconds / 60) as Integer
    def remSeconds = seconds % 60
    return "${minutes}m ${remSeconds}s"
}

def generateAndSendReports() {
    def successCount = results.count { it.status == 'SUCCESS' }
    def failCount = results.size() - successCount
    def summary = "${successCount} / ${results.size()} runs succeeded | ${failCount} failed"
    def releaseBranch = params.RELEASE_BRANCH ?: "main"
    def title = "QA Release Deploy — ${releaseBranch}"

    if (params.GCHAT_WEBHOOK_URL) {
        def cardJson = [
            cards: [[
                header: [ title: title, subtitle: summary ],
                sections: [[
                    widgets: results.collect { r ->
                        [ textParagraph: [ text: "<b>${r.name}</b> (${r.branch})<br>Type: ${r.type} | Status: <font color=\"${r.status == 'SUCCESS' ? '#2ecc71' : '#e74c3c'}\">${r.status}</font>" ] ]
                    }
                ]]
            ]]
        ]
        try {
            httpRequest url: env.GCHAT_WEBHOOK_URL,
                        httpMode: 'POST',
                        contentType: 'APPLICATION_JSON',
                        requestBody: groovy.json.JsonOutput.toJson(cardJson)
        } catch (e) {
            echo "Failed to send GChat notification: ${e.message}"
        }
    }

    if (params.NOTIFY_EMAIL) {
        echo "DEBUG: Attempting to send email to ${params.NOTIFY_EMAIL}"
        echo "DEBUG: Subject: [QA Deploy] ${releaseBranch} — ${summary}"
        
        def htmlBody = """
        <html>
        <body>
            <div style="font-size: 18px;"><b>${title}</b></div>
            <div>${summary}</div>
            <br>
            <table border="1" cellpadding="8" style="border-collapse: collapse; width: 100%;">
                <tr style="background: #f2f2f2;">
                    <th>Job Name</th><th>Branch</th><th>Type</th><th>Status</th><th>Duration</th>
                </tr>
                ${results.collect { r ->
                    """
                    <tr>
                        <td>${r.name}</td><td>${r.branch}</td><td>${r.type}</td>
                        <td style="color: ${r.status == 'SUCCESS' ? 'green' : 'red'}; font-weight: bold;">${r.status}</td>
                        <td>${r.duration}</td>
                    </tr>
                    """
                }.join('')}
            </table>
        </body>
        </html>
        """
        emailext body: htmlBody,
                 subject: "[QA Deploy] ${releaseBranch} — ${summary}",
                 to: params.NOTIFY_EMAIL,
                 mimeType: 'text/html'
    }
}
