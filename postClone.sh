#!/bin/bash
#postClone

# -------------------------
# Display summary of emails and mobiles
# -------------------------

# Define common variables
EMAILS=("priyanshugoel@gmail.com" "priyanshu.goel@ofbusiness.in" "ayush.chaudhary@ofbusiness.in"
        "ankit.gupta@ofbusiness.in" "rankit.dalal@ofbusiness.in"
        "tushar.garg@ofbusiness.in" "shantanu.singh@ofbusiness.in")
MOBILE_NUMBERS=("9818434239" "9005444066" "7906775150" "9044518006" "8929383776" "9557342354")

echo -e "\nFollowing script will whitelist the following email IDs and mobile numbers:"
echo "Emails: ${EMAILS[*]}"
echo "Mobiles: ${MOBILE_NUMBERS[*]}"

# -------------------------
# 0. Set Redis Key (DEVELOPER_KEY_VALUE)
# -------------------------
echo "Setting Redis key: DEVELOPER_KEY_VALUE=1"
redis-cli set DEVELOPER_KEY_VALUE 1
if [ $? -eq 0 ]; then
    echo "Success: Redis key set"
else
    echo "Error: Failed to set Redis key"
    exit 1
fi

# -------------------------
# 0.5 Set VERIFY_LINK_MAX_RETRY_COUNT Redis Key
# -------------------------
echo "This is also setting VERIFY_LINK_MAX_RETRY_COUNT in Redis"
redis-cli set VERIFY_LINK_MAX_RETRY_COUNT "3"
if [ $? -eq 0 ]; then
    echo "Success: Redis key VERIFY_LINK_MAX_RETRY_COUNT set to 3"
else
    echo "Error: Failed to set VERIFY_LINK_MAX_RETRY_COUNT"
    exit 1
fi

# -------------------------
# 1. Machine Name Logic
# -------------------------
HOSTNAME=$(cat /etc/hostname)
machineName="${HOSTNAME#*-}"
HARDCODED_TOKEN="1141828336121551101"

echo -e "\nMaking testLogin request to https://${machineName}-api.ofbusiness.co.in..."
curl --location --globoff --request POST \
    "https://${machineName}-api.ofbusiness.co.in/api/v1/internal/testLogin/${HARDCODED_TOKEN}?key=1"
if [ $? -eq 0 ]; then
    echo "Success: testLogin POST request for machine ${machineName}"
else
    echo "Error: Failed testLogin POST request for machine ${machineName}"
    exit 1
fi

# -------------------------
# 2. Whitelist Logic
# -------------------------
BASE_URL="http://localhost:8191/api/v1/whitelist"
TOKEN="${HARDCODED_TOKEN}"

check_status() {
    if [ $? -eq 0 ]; then
        echo "Success: $1"
    else
        echo "Error: Failed to execute $1"
        exit 1
    fi
}

for EMAIL in "${EMAILS[@]}"; do
    echo -e "\nProcessing email: $EMAIL"
    curl -X PUT "${BASE_URL}?channels=EMAIL&email=${EMAIL}&status=true" \
         -H "X-OFB-TOKEN:${TOKEN}"
    check_status "EMAIL whitelist update for $EMAIL"
done

for MOBILE in "${MOBILE_NUMBERS[@]}"; do
    echo -e "\nProcessing mobile number: $MOBILE"

    echo "Updating SMS whitelist..."
    curl -X PUT "${BASE_URL}?channels=SMS&mobile=${MOBILE}&status=true" \
         -H "X-OFB-TOKEN:${TOKEN}"
    check_status "SMS whitelist update for $MOBILE"

    echo "Updating WHATSAPP whitelist..."
    curl -X PUT "${BASE_URL}?channels=WHATSAPP&mobile=${MOBILE}&status=true" \
         -H "X-OFB-TOKEN:${TOKEN}"
    check_status "WHATSAPP whitelist update for $MOBILE"

    echo "Updating ANDROID whitelist..."
    curl -X PUT "${BASE_URL}?channels=ANDROID&mobile=${MOBILE}&status=true" \
         -H "X-OFB-TOKEN:${TOKEN}"
    check_status "ANDROID whitelist update for $MOBILE"
done

echo "All whitelist updates completed."

# -------------------------
# 3. Fetch Branch Deployed Info from http://localhost:7000/status/active
# -------------------------
echo -e "\nFetching the branch deployed information from OFB..."
branch_deployed_ofb=$(curl -s -X GET 'http://localhost:7000/status/active' | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
if [ -n "$branch_deployed_ofb" ]; then
    echo "Branch Deployed on OFB is: $branch_deployed_ofb"
else
    echo "Error: Failed to fetch 'branch deployed' info from OFB"
    exit 1
fi

# -------------------------
# 4. Fetch Branch Deployed Info from http://localhost:8191/status/detailed
# -------------------------
echo -e "\nFetching the branch deployed information from Notification..."
branch_deployed_notification=$(curl -s -X GET 'http://localhost:8191/status/detailed' \
     -H "X-OFB-TOKEN: ${TOKEN}" | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
if [ -n "$branch_deployed_notification" ]; then
    echo "Branch Deployed on Notification is: $branch_deployed_notification"
else
    echo "Error: Failed to fetch 'branch deployed' info from Notification"
    exit 1
fi


# -------------------------
# 5. Fetch Branch Deployed Info from http://localhost:8080/status (File Server)
# -------------------------
echo -e "\nFetching the branch deployed information from File Server..."
branch_deployed_fileserver=$(curl -X GET 'http://localhost:8080/status' | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
if [ -n "$branch_deployed_fileserver" ]; then
    echo "Branch Deployed for File Server is: $branch_deployed_fileserver"
else
    echo "Error: Failed to fetch 'branch deployed' info from File Server"
    exit 1
fi

# -------------------------
# 6. Set Redis Values for Duplicate PO Issue
# -------------------------
echo -e "\nRunning command for Duplicate PO Issue..."
redis-cli HKEYS poSupplierCounter | xargs -I {} redis-cli HSET poSupplierCounter {} 1000
if [ $? -eq 0 ]; then
    echo "Success: Redis keys for poSupplierCounter set to 1000"
else
    echo "Error: Failed to set Redis keys for poSupplierCounter"
    exit 1
fi

# -------------------------
# 7. Delete Redis Key (BKALERT)
# -------------------------
echo -e "\nDeleting key for Receipt Error..."
redis-cli del BKALERT 7166
if [ $? -eq 0 ]; then
    echo "Success: Redis key BKALERT 7166 deleted"
else
    echo "Error: Failed to delete Redis key BKALERT 7166"
    exit 1
fi

# -------------------------
# 8. MongoDB Insert (consumerAccessKey into 'informer' DB)
# -------------------------
echo -e "\nThis is also setting access key as well"
echo -e "\nInserting accessKey into MongoDB (DB: informer)..."
mongosh --eval 'use informer; db.consumerAccessKey.remove({}); db.consumerAccessKey.insertOne({ host: "OFB", accessKey: "990783347078729731", active: true });'
if [ $? -eq 0 ]; then
    echo "Success: MongoDB insert completed"
else
    echo "Error: MongoDB insert failed"
    exit 1
fi

# -------------------------
# 9. Update User Roles for Account
# -------------------------
echo -e "\nUpdating user roles for the accounts..."

ACCOUNT_IDS=(
    "6238589171162681781"
    "1141828336121551101"
    "978054312255034071"
    "978054650731173476"
    "1183885017202301687"
    "975504741243032517",
    "1137827966831565841"
)

ROLE_IDS='["753448627875093653","715296915872291137","6097201248748967261","1073151533970889804"]'
UPDATE_ROLES_URL="https://${machineName}-api.ofbusiness.co.in/api/v1/internal/updateroles?key=1"

for ACCOUNT_ID in "${ACCOUNT_IDS[@]}"; do
    echo "Processing Account ID: ${ACCOUNT_ID}..."
    curl --silent --location --request POST "${UPDATE_ROLES_URL}" \
         --header "X-OFB-TOKEN: ${HARDCODED_TOKEN}" \
         --header "Content-Type: application/json" \
         --data "{\"accountId\":\"${ACCOUNT_ID}\",\"roleIds\":${ROLE_IDS}}"
    
    if [ $? -eq 0 ]; then
        echo -e "\nSuccess: Roles updated for account ${ACCOUNT_ID}"
    else
        echo -e "\nError: Failed to update roles for account ${ACCOUNT_ID}"
        exit 1
    fi
done

# -------------------------
# 10. Fetch Branch Deployed Info from http://localhost:8090/status (Scheduler)
# -------------------------
echo -e "\nFetching the branch deployed information from Scheduler..."
branch_deployed_scheduler=$(curl -X GET 'http://localhost:8090/status' | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
if [ -n "$branch_deployed_scheduler" ]; then
    echo "Branch Deployed for Scheduler is: $branch_deployed_scheduler"
else
    echo "Error: Failed to fetch 'branch deployed' info from Scheduler"
    exit 1
fi
