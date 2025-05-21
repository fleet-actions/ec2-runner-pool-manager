import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'
import { heredocAndchmod } from './helper.js'

// This script polls the Instance parition waiting for a valid runId to be assigned to
// this instance. The script blocks (continues looping) until a non-empty, non-"None"
// runId is found. Once a valid runId is detected, it writes this ID to the provided
// output file and releases (breaks the loop), indicating the runner has been
// successfully registered and claimed.
export function blockRegistrationSpinnerScript(filename: string) {
  const ent = InstanceOperations.ENTITY_TYPE
  const script = `#!/bin/bash

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
    echo "[$_localdate] unable to fetch runId, retrying..."
    sleep $_sleep
    continue
  fi

  # Do not accept None as runId (empty output of "--output text")
  if [ -n "$_runid" ] && [ "$_runid" != "None" ]; then
    echo "[$_localdate] found _runid ($_runid) - writing to $_file. runner is registered/claimed. completing..."
    echo "$_runid" > $_file
    break
  else
    echo "[$_localdate] invalid _runid ($_runid) found. runner is not registered/claimed. retrying..."
    sleep $_sleep
    continue
  fi  
done
`

  return heredocAndchmod({ filename, script })
}
