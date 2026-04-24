/**
 * OASYS Jenkins Dashboard Configuration
 * ─────────────────────────────────────
 * Edit this file to add/remove Jenkins jobs from the dashboard.
 */

module.exports = {
    // Jenkins base URL (no trailing slash)
    JENKINS_BASE_URL: 'https://stg-jenkins.ofbusiness.co.in',

    // Jenkins credentials — set via environment variables for security.
    // Generate a token: Jenkins → User → Configure → API Token → Add new token
    // Then run: JENKINS_USER=myuser JENKINS_TOKEN=mytoken node index.js
    JENKINS_USER: process.env.JENKINS_USER || '',
    JENKINS_TOKEN: process.env.JENKINS_TOKEN || '',

    // Number of past builds to fetch for history view
    HISTORY_DEPTH: 20,

    // Jobs to track — add or remove job names here freely
    JOBS: [
        'STG-Clone-Prod-Data',
        'Bheem-Compile-Deploy',
        'OFB-Compile-Deploy',
        'OASYS-FE',
        'OASYS-TS',
        'OFB-ADMIN',
        'MERGE-FE',
        'Informer-Compile',
        'Informer-Deploy',
        'OFB-Scheduler-Compile',
        'OFB-Scheduler-Deploy',
        'Notification-Compile',
        'Notification-Deploy',
        'Orion-Compile-Deploy',
        'Orion-FS-Compile',
        'Orion-FS-Deploy',
        'Orion-Scheduler-Compile',
        'Orion-Scheduler-Deploy',
        'Orion-Admin',
        'Orion-FE',
        'OFB-FS-Compile',
        'OFB-FS-Deploy',
        'Supplier-FE',
        'BUYER-FE',
    ],

    // Build parameter names your Jenkins jobs use to pass the target environment.
    // The service will try each name and use the first match found.
    // Real parameter found in OASYS Jenkins: 'Env' with values like 'ofb_stg6'
    ENV_PARAM_NAMES: ['Env', 'ENV', 'ENVIRONMENT', 'env', 'environment', 'STG_ENV', 'staging_env', 'TARGET_ENV'],

    // Build parameter names used for branch (in parameterised builds)
    // Real parameter found in OASYS Jenkins: 'branchName'
    BRANCH_PARAM_NAMES: ['branchName', 'BRANCH', 'branch', 'BRANCH_NAME', 'GIT_BRANCH', 'git_branch'],

    // Server monitoring configuration (environment-aware)
    ORION_HOST_TEMPLATE: '{env}-orion-api.ofbusiness.co.in',
    ORION_FS_HOST_TEMPLATE: '{env}-fs-orion.ofbusiness.co.in',

    // Environment-specific IP mapping for services like Informer
    ENV_IPS: {
        'stg1': '10.22.0.111',
        'stg2': '10.22.0.112',
        'stg3': '10.22.0.113',
        'stg4': '10.22.0.114',
        'stg5': '10.22.0.115',
        'stg6': '10.22.0.116',
        'stg7': '10.22.0.117',
        'stg8': '10.22.0.118',
        'stg9': '10.22.0.119',
        'stg10': '10.22.0.120',
        'uat1': '10.22.0.131',
        'uat2': '10.22.0.132',
    },

    SERVICES_CONFIG: [
        { name: 'OFB', path: '/status/active', template: 'https://{env}-api.ofbusiness.co.in{path}', type: 'template' },
        { name: 'Scheduler', path: '/status', template: 'https://{env}-sapi.ofbusiness.co.in{path}', type: 'template' },
        { name: 'File Server', path: '/status', template: 'https://{env}-fs.ofbusiness.co.in{path}', type: 'template' },
        { name: 'Informer', path: '/status', port: 7300, type: 'ip_based' },
        { name: 'Orion API', path: '/status', type: 'orion' },
        { name: 'Orion File Server', path: '/status', type: 'orion_fs' }
    ]

};
