import { LeaderSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'

// This script polls the LeaderSignal partition checking if the instance's ID exists
// and if the value matches the provided input ID. The script blocks (continues looping)
// until both conditions are true, at which point it releases (breaks the loop).
// Used to confirm a runner has been accepted with the correct runId.
export function blockRunSpinnerScript() {
  const ent = LeaderSignalOperations.ENTITY_TYPE
  const col = LeaderSignalOperations.VALUE_COLUMN_NAME

  return `#!/bin/bash

if [ $# -ne 2 ]; then
  echo "Usage: $0 <id> <spin-period>" >&2
  exit 1
fi

_inputid="$1"
_sleep="$2"

while true; do
  _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  _tmpfile=$(mktemp /tmp/ddb-item-key-block-run.XXXXXX.json)
  cat <<JSON > "$_tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" }
}
JSON  

  if ! _acceptedid=$(aws dynamodb get-item \
        --key file://$_tmpfile \
        --consistent-read \
        --output text \
        --query 'Item.${col}.S'); then
    echo "[$_localdate] unable to fetch runId, retrying..."
    sleep $_sleep
    continue    
  fi

  if [ -n "$_acceptedid" ] && [ "$_inputid" == "$_acceptedid" ]; then
    echo "[$_localdate] accepted ID ($_acceptedid) == input id ($_inputid). runner confirmed accepted. completing..."
    break
  else
    echo "[$_localdate] accepted ID ($_acceptedid) != input id ($_inputid). runner not yet accepted. retrying..."
    sleep $_sleep
    continue
  fi
done
`
}
