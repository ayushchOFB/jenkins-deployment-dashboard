#!/bin/bash
#postClone — runs after a uat1 deployment. Each step's status is recorded
# and emitted to /tmp/postClone-summary.json so the dashboard/Gchat can
# show per-step pass/fail (instead of one big SUCCESS/FAILED for the whole
# script).

SUMMARY_FILE="/tmp/postClone-summary.json"
STEP_NAMES=()
STEP_STATUSES=()
STEP_ERRORS=()
STEP_DURATIONS=()
HAS_FAILURE=0

# Portable millisecond timestamp — GNU date (%N) on Linux, perl fallback
# on BSD/macOS. Returns integer ms since epoch.
now_ms() {
    local v
    v=$(date +%s%3N 2>/dev/null)
    if [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"; return; fi
    perl -MTime::HiRes=time -e 'printf("%d\n", time()*1000)' 2>/dev/null && return
    echo "$(($(date +%s) * 1000))"
}

# Run a step: name, then command. Captures status + duration + error msg.
run_step() {
    local name="$1"; shift
    local start_ms end_ms dur_ms tmp_err status err_msg
    echo ""
    echo "──[ STEP: ${name} ]────────────────────────────"
    start_ms=$(now_ms)
    tmp_err=$(mktemp)
    if "$@" 2> >(tee "$tmp_err" >&2); then
        status="SUCCESS"; err_msg=""
    else
        status="FAILED"; HAS_FAILURE=1
        err_msg=$(tail -c 500 "$tmp_err" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/ /g')
    fi
    rm -f "$tmp_err"
    end_ms=$(now_ms)
    dur_ms=$((end_ms - start_ms))
    STEP_NAMES+=("$name")
    STEP_STATUSES+=("$status")
    STEP_ERRORS+=("$err_msg")
    STEP_DURATIONS+=("$dur_ms")
    echo "──[ ${name}: ${status} (${dur_ms}ms) ]────────"
}

write_summary() {
    local i n=${#STEP_NAMES[@]}
    {
        echo "["
        for ((i = 0; i < n; i++)); do
            local sep=","
            [ $i -eq $((n - 1)) ] && sep=""
            printf '  {"name":"%s","status":"%s","durationMs":%s,"error":"%s"}%s\n' \
                "${STEP_NAMES[$i]}" "${STEP_STATUSES[$i]}" "${STEP_DURATIONS[$i]}" "${STEP_ERRORS[$i]}" "$sep"
        done
        echo "]"
    } > "$SUMMARY_FILE"
    echo "Summary written to ${SUMMARY_FILE}"
}

# -------------------------
# Display summary of emails and mobiles
# -------------------------

EMAILS=("priyanshugoel@gmail.com" "priyanshu.goel@ofbusiness.in" "ayush.chaudhary@ofbusiness.in"
        "ankit.gupta@ofbusiness.in" "rankit.dalal@ofbusiness.in"
        "tushar.garg@ofbusiness.in" "shantanu.singh@ofbusiness.in")
MOBILE_NUMBERS=("9818434239" "9005444066" "7906775150" "9044518006" "8929383776" "9557342354")

echo -e "\nFollowing script will whitelist the following email IDs and mobile numbers:"
echo "Emails: ${EMAILS[*]}"
echo "Mobiles: ${MOBILE_NUMBERS[*]}"

# Hostname / token (used by several steps)
HOSTNAME=$(cat /etc/hostname 2>/dev/null || echo "")
machineName="${HOSTNAME#*-}"
HARDCODED_TOKEN="1141828336121551101"
BASE_URL="http://localhost:8191/api/v1/whitelist"
TOKEN="${HARDCODED_TOKEN}"

# -------------------------
# Step wrappers (one per logical operation)
# -------------------------

step_set_developer_key() {
    redis-cli set DEVELOPER_KEY_VALUE 1
}

step_set_verify_link_retry() {
    redis-cli set VERIFY_LINK_MAX_RETRY_COUNT "3"
}

step_test_login() {
    [ -n "$machineName" ] || { echo "machineName empty"; return 1; }
    curl --fail --location --globoff --request POST \
        "https://${machineName}-api.ofbusiness.co.in/api/v1/internal/testLogin/${HARDCODED_TOKEN}?key=1"
}

step_whitelist_emails() {
    local fail=0
    for EMAIL in "${EMAILS[@]}"; do
        echo "Processing email: $EMAIL"
        curl --fail -X PUT "${BASE_URL}?channels=EMAIL&email=${EMAIL}&status=true" \
            -H "X-OFB-TOKEN:${TOKEN}" || fail=1
    done
    return $fail
}

step_whitelist_mobiles() {
    local fail=0
    for MOBILE in "${MOBILE_NUMBERS[@]}"; do
        echo "Processing mobile: $MOBILE"
        curl --fail -X PUT "${BASE_URL}?channels=SMS&mobile=${MOBILE}&status=true"      -H "X-OFB-TOKEN:${TOKEN}" || fail=1
        curl --fail -X PUT "${BASE_URL}?channels=WHATSAPP&mobile=${MOBILE}&status=true" -H "X-OFB-TOKEN:${TOKEN}" || fail=1
        curl --fail -X PUT "${BASE_URL}?channels=ANDROID&mobile=${MOBILE}&status=true"  -H "X-OFB-TOKEN:${TOKEN}" || fail=1
    done
    return $fail
}

step_branch_deployed_ofb() {
    local v=$(curl -s -X GET 'http://localhost:7000/status/active' | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
    [ -n "$v" ] && echo "OFB branch: $v"
}

step_branch_deployed_notification() {
    local v=$(curl -s -X GET 'http://localhost:8191/status/detailed' -H "X-OFB-TOKEN: ${TOKEN}" \
                | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
    [ -n "$v" ] && echo "Notification branch: $v"
}

step_branch_deployed_fileserver() {
    local v=$(curl -s -X GET 'http://localhost:8080/status' | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
    [ -n "$v" ] && echo "File Server branch: $v"
}

step_branch_deployed_scheduler() {
    local v=$(curl -s -X GET 'http://localhost:8090/status' | grep -oP '"Branch Deployed"\s*:\s*"\K[^"]+')
    [ -n "$v" ] && echo "Scheduler branch: $v"
}

step_duplicate_po_fix() {
    redis-cli HKEYS poSupplierCounter | xargs -I {} redis-cli HSET poSupplierCounter {} 1000
}

step_delete_bkalert() {
    redis-cli del BKALERT 7166
}

step_mongo_consumer_access_key() {
    mongosh --eval 'use informer; db.consumerAccessKey.remove({}); db.consumerAccessKey.insertOne({ host: "OFB", accessKey: "990783347078729731", active: true });'
}

step_update_user_roles() {
    [ -n "$machineName" ] || { echo "machineName empty"; return 1; }
    local fail=0
    local ACCOUNT_IDS=(
        "6238589171162681781"
        "1141828336121551101"
        "978054312255034071"
        "978054650731173476"
        "1183885017202301687"
        "975504741243032517"
        "1137827966831565841"
    )
    local ROLE_IDS='["753448627875093653","715296915872291137","6097201248748967261","1073151533970889804"]'
    local URL="https://${machineName}-api.ofbusiness.co.in/api/v1/internal/updateroles?key=1"
    for ACCOUNT_ID in "${ACCOUNT_IDS[@]}"; do
        echo "Account: ${ACCOUNT_ID}"
        curl --fail --silent --location --request POST "${URL}" \
            --header "X-OFB-TOKEN: ${HARDCODED_TOKEN}" \
            --header "Content-Type: application/json" \
            --data "{\"accountId\":\"${ACCOUNT_ID}\",\"roleIds\":${ROLE_IDS}}" || fail=1
    done
    return $fail
}

step_sunion_jvsr_companies() {
    redis-cli SUNIONSTORE jvsrCompanyNameSpaces:ofb groupCompanyNameSpaces:ofb
}

# -------------------------
# Execute all steps (continue on failure — summary captures each one)
# -------------------------

run_step "Redis: DEVELOPER_KEY_VALUE"            step_set_developer_key
run_step "Redis: VERIFY_LINK_MAX_RETRY_COUNT"    step_set_verify_link_retry
run_step "testLogin"                              step_test_login
run_step "Whitelist: Emails"                      step_whitelist_emails
run_step "Whitelist: Mobiles (SMS/WA/Android)"   step_whitelist_mobiles
run_step "Branch Deployed: OFB"                   step_branch_deployed_ofb
run_step "Branch Deployed: Notification"          step_branch_deployed_notification
run_step "Branch Deployed: File Server"           step_branch_deployed_fileserver
run_step "Branch Deployed: Scheduler"             step_branch_deployed_scheduler
run_step "Redis: poSupplierCounter -> 1000"      step_duplicate_po_fix
run_step "Redis: del BKALERT 7166"                step_delete_bkalert
run_step "Mongo: informer.consumerAccessKey"      step_mongo_consumer_access_key
run_step "Update user roles"                      step_update_user_roles
run_step "Redis: SUNIONSTORE jvsrCompanyNameSpaces:ofb" step_sunion_jvsr_companies

write_summary

if [ "$HAS_FAILURE" -ne 0 ]; then
    echo -e "\nOne or more post-clone steps FAILED — see ${SUMMARY_FILE}"
    exit 1
fi
echo -e "\nAll post-clone steps completed successfully."
exit 0
