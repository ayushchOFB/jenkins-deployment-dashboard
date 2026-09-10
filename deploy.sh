#!/bin/bash

# Configuration
REPO_URL="git@github.com:ayushchOFB/jenkins-deployment-dashboard.git"
TARGET_DIR="/root/jenkins-dashboard"
APP_NAME="jenkins-dashboard"

echo "--- Starting Deployment to UAT2 ---"

# Ensure we are in the right directory or clone if missing
if [ ! -d "$TARGET_DIR" ]; then
    echo "🚀 Cloning repository into $TARGET_DIR..."
    git clone "$REPO_URL" "$TARGET_DIR"
    cd "$TARGET_DIR" || exit 1
else
    echo "📥 Updating repository in $TARGET_DIR..."
    cd "$TARGET_DIR" || exit 1
    # Reset any local changes and pull
    git fetch --all
    git reset --hard origin/main
    git pull
fi

# Install dependencies
echo "📦 Installing npm dependencies..."
npm install

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "⚠️ PM2 not found. Installing globally..."
    npm install -g pm2
fi

# Verify Environment Variables
if [ -z "$JENKINS_USER" ] || [ -z "$JENKINS_TOKEN" ]; then
    echo "❌ Error: JENKINS_USER and JENKINS_TOKEN must be set."
    echo "Usage: JENKINS_USER=your_user JENKINS_TOKEN=your_token ./deploy.sh"
    exit 1
fi

# Stop existing process if running
echo "🔄 Restarting application with PM2..."
pm2 stop "$APP_NAME" 2>/dev/null || true
pm2 delete "$APP_NAME" 2>/dev/null || true

# Start the application
JENKINS_USER="$JENKINS_USER" JENKINS_TOKEN="$JENKINS_TOKEN" pm2 start index.js --name "$APP_NAME"

echo "✅ Deployment complete!"
pm2 status "$APP_NAME"
echo "🌐 Access your dashboard at http://10.22.0.132:5001"
