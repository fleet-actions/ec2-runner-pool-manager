import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'

// Looks for runID for instance id. If one is found, then releases
export function blockReleaseSpinnerScript() {
  const ent = InstanceOperations.ENTITY_TYPE
  return `#!/bin/bash

if [ $# -ne 2 ]; then
  echo "Usage: $0 <id> <spin-period>" >&2
  exit 1
fi

INPUTID="$1"
SLEEP="$2"

while true; do
  _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  _tmpfile=$(mktemp /tmp/ddb-item-key-block-release.XXXXXX.json)
  cat <<JSON > "$_tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" }
}
JSON

  if ! RUNID=$(aws dynamoddb get-item --key { "PK": { "S": "TYPE#INSTANCE" } }... --consistent-read --output text --query 'Item.runId.S'); then
    echo "[$DATE] Unable to fetch runId, retrying..."
    sleep $SLEEP
    continue
  fi  

  # NOTE: '-z "$RUNID"' is not incl. OK to have empty RUNID
  if [ "$RUNID" != "$INPUTID" ]; then
    echo "[$DATE] Found RUNID ($RUNID) is not equal to input id ($INPUTID). Runner has been released. Completing is_released_spinner..."
    echo "$RUNID" > $FILE
    break
  else
    echo "[$DATE] Invalid RUNID ($RUNID) found. Retrying..."
    sleep $SLEEP
    continue
  fi    
done
`
}
