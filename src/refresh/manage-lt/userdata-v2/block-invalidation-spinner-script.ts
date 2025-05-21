import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'
import { heredocAndchmod } from './helper.js'

// This script polls the Instance parition checking if the runId associated with
// this instance differs from the provided input ID. The script blocks (continues looping)
// as long as the runId matches the input ID, and releases (breaks the loop) when
// they differ or when the runId is removed, indicating the runner has been released.
export function blockInvalidationSpinnerScript(filename: string) {
  const ent = InstanceOperations.ENTITY_TYPE
  const script = `#!/bin/bash

if [ $# -ne 2 ]; then
  echo "Usage: $0 <id> <spin-period>" >&2
  exit 1
fi

_inputid="$1"
_sleep="$2"

while true; do
  _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  _tmpfile=$(mktemp /tmp/ddb-item-key-block-invalidation.XXXXXX.json)
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

  # NOTE: OK to have empty _runid - so not checking for -z
  if [ "$_runid" != "$_inputid" ]; then
    echo "[$_localdate] found _runid ($_runid) is != input id ($_inputid). runner released. completing..."
    break
  else
    echo "[$_localdate] found _runid ($_runid) is == input id ($_inputid). runner still not released. Retrying..."
    sleep $_sleep
    continue
  fi    
done
`

  return heredocAndchmod({ filename, script })
}
