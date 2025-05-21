import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'

// $TABLE_NAME, #INSTANCE_ID
export function emitSignal(): string {
  const ent = WorkerSignalOperations.ENTITY_TYPE
  const col = WorkerSignalOperations.VALUE_COLUMN_NAME
  const functionName = 'emitSignal'

  const script = `
# Function to emit signal to DynamoDB
${functionName}() {
  local _localid="$1"
  local _localsignal="$2"
  local _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local _tmpfile

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
}
`
  return script.trim()
}
