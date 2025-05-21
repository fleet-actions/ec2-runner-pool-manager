import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'

// Looks for runID for instance id. If one is found, then releases
export function blockRegistrationSpinnerScript() {
  const ent = InstanceOperations.ENTITY_TYPE
  return `#!/bin/bash

if [ $# -ne 2 ]; then
  echo "Usage: $0 <output-file> <spin-period>" >&2
  exit 1
fi

_file="$1"
_sleep="$2"

while true; do
  _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  _tmpfile=$(mktemp /tmp/ddb-item-key-block-registration.XXXXXX.json)
  cat <<JSON > "$_tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" }
}
JSON

  if ! _runid=$(aws dynamodb get-item \
    --key file://$_tmpfile \
    --consistent-read \
    --output text \
    --query 'Item.runId.S'); then
    echo "[$_localdate] Unable to fetch runId, retrying..."
    sleep $_sleep
    continue
  fi

  # None is defined as output of "--output text"
  if [ -n "$_runid" ] && [ "$_runid" != "None" ]; then
    echo "[$_localdate] Found _runid ($_runid). Successfully fetched run id..."
    echo "$_runid" > $_file
    break
  else
    echo "[$_localdate] Invalid _runid ($_runid) found. Retrying..."
    sleep $_sleep
    continue
  fi  
done
`
}
