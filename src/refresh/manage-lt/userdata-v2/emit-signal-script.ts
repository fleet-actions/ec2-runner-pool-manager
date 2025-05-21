import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'
import { heredocAndchmod } from './helper.js'

// $TABLE_NAME, #INSTANCE_ID
export function emitSignalScript(filename: string): string {
  const ent = WorkerSignalOperations.ENTITY_TYPE
  const col = WorkerSignalOperations.VALUE_COLUMN_NAME
  const script = `#!/bin/bash

if [ $# -ne 2 ]; then
  echo "Usage: $0 <id> <signal>" >&2
  exit 1
fi

_localid="$1"
_localsignal="$2"
_localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

_tmpfile=$(mktemp /tmp/emit-signal.XXXXXX.json)
cat <<JSON > "$_tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "${ent}" },
  "identifier": { "S": "$INSTANCE_ID" },
  "${col}": { "M": { "state": { "S": "$_localsignal" }, "runId": { "S": "$_localid" } } },
  "updatedAt": { "S": "$_localdate" }
}
JSON
aws dynamodb put-item \\
  --table-name "$TABLE_NAME" \\
  --item file://"$_tmpfile"
rm -f "$_tmpfile"
echo "[$_localdate] $_localsignal for $_localid communicated to DDB..."
`

  return heredocAndchmod({ filename, script })
}
