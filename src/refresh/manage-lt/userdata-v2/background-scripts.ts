import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'
import { HeartbeatOperations } from '../../../services/dynamodb/operations/heartbeat-operations.js'

export function heredocAndchmod({
  filename,
  script
}: {
  filename: string
  script: string
}): string {
  return `cat <<'EOF'> ${filename}
${script}
EOF
chmod +x ${filename}
`
}

const SELF_TERMINATION_FN_NAME = 'selfTermination'
const HEARTBEAT_FN_NAME = 'heartbeat'

function selfTermination() {
  const ent = InstanceOperations.ENTITY_TYPE
  const col = 'threshold' // NOTE: magic string
  const functionName = SELF_TERMINATION_FN_NAME
  const period = HeartbeatOperations.HEALTH_TIMEOUT

  const script = `
# Function to monitor and self-terminate when threshold is reached
${functionName}() {
  local _period=${period}

  while true; do
    local _localdate
    _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # 1) Try fetching threshold, retry on API error
    local _threshold
    if ! _threshold=$(
        aws dynamodb get-item \\
          --table-name "$TABLE_NAME" \\
          --key '{ "PK": { "S": "TYPE#${ent}" }, "SK": { "S": "ID#'"$INSTANCE_ID"'" } }' \\
          --query 'Item.${col}.S' \\
          --consistent-read \\
          --output text
      ); then
      echo "[$_localdate ($$)] DynamoDB get-item failed; retrying in $_period s…" >&2
      sleep $_period
      continue
    fi

    echo "[$_localdate ($$)] Fetched _threshold: $_threshold"

    # 2) No data yet?
    if [ -z "$_threshold" ] || [ "$_threshold" = "None" ]; then
      echo "[$_localdate ($$)] No _threshold recorded yet or item not available; sleeping $_period s…" >&2
      sleep $_period
      continue
    fi

    # 3) Add buffer and compare
    local _buffer _now_s _tsb_s _delta_s
    _buffer=$(date -u -d "$_threshold + 1 minute" +"%Y-%m-%dT%H:%M:%SZ")
    _now_s=$(date -u +%s)
    _tsb_s=$(date -u -d "$_buffer" +%s)
    _delta_s=$(( _tsb_s - _now_s ))
    echo "[$_localdate ($$)] Difference: $_delta_s seconds (_threshold+_buffer vs now)"

    # 4) Self-terminate when due
    if [ "$_tsb_s" -lt "$_now_s" ]; then
      echo "[$_localdate ($$)] Deadline passed; initiating self-termination…"
      if aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"; then
        echo "[$_localdate ($$)] Termination API call succeeded; exiting."
        break
      else
        echo "[$_localdate ($$)] Termination call failed; retrying in $_period s…" >&2
        sleep $_period
        continue
      fi
    fi

    echo "[$_localdate ($$)] Not yet due; sleeping $_period s…"
    sleep $_period
  done
}
`

  return script.trim()
}

function heartbeat() {
  const ent = HeartbeatOperations.ENTITY_TYPE
  const col = HeartbeatOperations.VALUE_COLUMN_NAME
  const state = HeartbeatOperations.STATUS.PING
  const period = HeartbeatOperations.POLL_INTERVAL
  const functionName = HEARTBEAT_FN_NAME

  const script = `
# Function to emit periodic heartbeat signals
${functionName}() {
  while true; do
    local _localdate
    _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local _tmpfile
    _tmpfile=$(mktemp /tmp/ddb-item-heartbeat.XXXXXX.json) 

    cat <<JSON > "$_tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "${ent}" },
  "identifier": { "S": "$INSTANCE_ID" },
  "${col}": { "S": "${state}" },
  "updatedAt": { "S": "$_localdate" }
}
JSON
    if ! aws dynamodb put-item \\
      --table-name "$TABLE_NAME" \\
      --item file://"$_tmpfile"; then
      rm -f "$_tmpfile"
      echo "[$_localdate ($$)] heartbeat failed, retrying in [${period}]s..." >&2
      sleep ${period}
      continue
    fi
    rm -f "$_tmpfile"
    sleep ${period}
  done
}
`

  return script.trim()
}

export function keepRunnerAliveScript(filename: string, period = 5) {
  const script = `#!/bin/bash
set +e
while true; do
  ./run.sh 
  sleep ${period} # this appears to be OK
done
`

  return heredocAndchmod({ filename, script })
}

// NOTE: wrapping in executable scripts so that we can grep in ps -aux

export function selfTerminationScript(filename: string) {
  const script = `
${selfTermination()}

# execute function
${SELF_TERMINATION_FN_NAME}
`.trim()

  return heredocAndchmod({ filename, script })
}

export function heartbeatScript(filename: string) {
  const script = `
${heartbeat()}

# execute function
${HEARTBEAT_FN_NAME}
`.trim()

  return heredocAndchmod({ filename, script })
}
