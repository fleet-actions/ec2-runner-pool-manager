import { HeartbeatOperations } from '../../../services/dynamodb/operations/heartbeat-operations.js'

export function heartbeatScript() {
  const ent = HeartbeatOperations.ENTITY_TYPE
  const col = HeartbeatOperations.VALUE_COLUMN_NAME
  const state = HeartbeatOperations.STATUS.PING
  const period = HeartbeatOperations.PERIOD_SECONDS

  return `#!/bin/bash

while true; do
  localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmpfile=$(mktemp /tmp/ddb-item-heartbeat.XXXXXX.json)

  cat <<JSON > "$tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "${ent}" },
  "identifier": { "S": "$INSTANCE_ID" },
  "${col}": { "S": "${state}" },
  "updatedAt": { "S": "$localdate" }
}
JSON
  if ! aws dynamodb put-item \
    --table-name "$TABLE_NAME" \
    --item file://"$tmpfile"; then
    rm -f "$tmpfile"
    echo "[$localdate] heartbeat failed, retrying in [${period}]s..." >&2
    sleep ${period}
    continue
  fi
  rm -f "$tmpfile"
  sleep ${period}
done
`
}
