import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'

// $TABLE_NAME, #INSTANCE_ID
export function emitSignalScript(): string {
  const ent = WorkerSignalOperations.ENTITY_TYPE
  return `#!/bin/bash

if [ $# -ne 3 ]; then
  echo "Usage: $0 <id> <signal>" >&2
  exit 1
fi

localid="$1"
localsignal="$2"
localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

tmpfile=$(mktemp /tmp/emit-signal.XXXXXX.json)
cat <<JSON > "$tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "${ent}" },
  "identifier": { "S": "$INSTANCE_ID" },
  "$WS_COLUMN_NAME": { "M": { "state": { "S": "$localsignal" }, "runId": { "S": "$localid" } },
  "updatedAt": { "S": "$localdate" }
}
JSON
aws dynamodb put-item \
  --table-name "$TABLE_NAME" \
  --item file://"$tmpfile"
rm -f "$tmpfile"
echo "[$localdate] $localsignal for $localid communicated to DDB..."
`
}
