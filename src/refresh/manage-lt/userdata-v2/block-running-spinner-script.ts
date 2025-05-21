import { LeaderSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'

// looks for valid runId in #LS. If found, release
export function blockRunningSpinnerScript() {
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
  _tmpfile=$(mktemp /tmp/ddb-item-key-block-running.XXXXXX.json)
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
    echo "[$_localdate] Unable to fetch runId from accepted partition, retrying..."
    sleep $_sleep
    continue    
  fi

  # None is defined as output of '--output text'
  if [ -n "$_acceptedid" ] && [ "$_inputid" == "$_acceptedid" ]; then
    echo "[$_localdate] Accepted ID ($_acceptedid) matches input id ($_inputid). Runner confirmed accepted..."
    break
  else
    echo "[$_localdate] Accepted ID ($_acceptedid) does not match input id ($_inputid). Retrying..."
    sleep $_sleep
    continue
  fi
done
`
}
