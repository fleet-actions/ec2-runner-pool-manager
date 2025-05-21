import { HeartbeatOperations } from '../../../services/dynamodb/operations/heartbeat-operations.js'
import { heredocAndchmod } from './helper.js'

export function heartbeatScript(filename: string) {
  const ent = HeartbeatOperations.ENTITY_TYPE
  const col = HeartbeatOperations.VALUE_COLUMN_NAME
  const state = HeartbeatOperations.STATUS.PING
  const period = HeartbeatOperations.PERIOD_SECONDS

  const script = `#!/bin/bash

while true; do
  _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
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
  if ! aws dynamodb put-item \
    --table-name "$TABLE_NAME" \
    --item file://"$_tmpfile"; then
    rm -f "$_tmpfile"
    echo "[$_localdate] heartbeat failed, retrying in [${period}]s..." >&2
    sleep ${period}
    continue
  fi
  rm -f "$_tmpfile"
  sleep ${period}
done
`

  return heredocAndchmod({ filename, script })
}
