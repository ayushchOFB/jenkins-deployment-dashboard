require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

// Body parsers
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// New dashboard — served from /public (root redirects here too)
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.use('/', express.static(path.join(__dirname, 'public')));

// ── API routes (Jenkins proxy, no DB) ──────────────────────────────────────
const deploymentRoutes = require('./routes/deploymentRoutes');
const schedulerRoutes = require('./routes/schedulerRoutes');
app.use('/api', deploymentRoutes);
app.use('/api/scheduler', schedulerRoutes);

// ── Scheduled Deployment Pipeline ─────────────────────────────────────────
const { initScheduler } = require('./services/schedulerService');

// Start
const PORT = process.env.PORT || 5001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅  Server started at http://localhost:${PORT}`);
    console.log(`📊  Dashboard at    http://localhost:${PORT}`);
    console.log('🔗  API base at     http://localhost:5001/api');
    console.log('');
    console.log('⚠️   Jenkins auth: set JENKINS_USER and JENKINS_TOKEN env vars');
    console.log('     e.g.  JENKINS_USER=admin JENKINS_TOKEN=xxx node index.js');
    console.log('');

    // Initialize scheduler after server is up
    initScheduler();
});
