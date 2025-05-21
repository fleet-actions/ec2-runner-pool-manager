import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'
import { LeaderSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'

// This function polls the Instance partition waiting for a valid runId to be assigned to
// this instance. It blocks (continues looping) until a non-empty, non-"None"
// runId is found. Once a valid runId is detected, it writes this ID to the provided
// output file and releases (breaks the loop), indicating the runner has been
// successfully registered and claimed.
export function blockRegistrationSpinner() {
  const ent = InstanceOperations.ENTITY_TYPE
  const functionName = 'blockRegistrationSpinner'

  const script = `
# Function to wait for runner registration
${functionName}() {
  if [ $# -ne 2 ]; then
    echo "Usage: $0 <output-file> <spin-period>" >&2
    return 1
  fi

  local _file="$1"
  local _sleep="$2"

  while true; do
    local _localdate
    _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local _runid

    if ! _runid=$(aws dynamodb get-item \\
          --table-name "$TABLE_NAME" \\
          --key '{ "PK": { "S": { "TYPE#${ent}" } }, "SK": { "S": "ID#'"$INSTANCE_ID"'" } }' \\
          --consistent-read \\
          --output text \\
          --query 'Item.runId.S'); then
      echo "[$_localdate] unable to fetch runId, retrying..."
      sleep "$_sleep"
      continue
    fi

    # Do not accept None as runId (empty output of "--output text")
    if [ -n "$_runid" ] && [ "$_runid" != "None" ]; then
      echo "[$_localdate] found _runid ($_runid) - writing to $_file. runner is registered/claimed. completing..."
      echo "$_runid" > "$_file"
      break
    else
      echo "[$_localdate] invalid _runid ($_runid) found. runner is not registered/claimed. retrying..."
      sleep "$_sleep"
      continue
    fi  
  done
}
`

  return script.trim()
}

// This function polls the LeaderSignal partition checking if the instance's ID exists
// and if the value matches the provided input ID. It blocks (continues looping)
// until both conditions are true, at which point it releases (breaks the loop).
// Used to confirm a runner has been accepted with the correct runId.
export function blockRunSpinner() {
  const ent = LeaderSignalOperations.ENTITY_TYPE
  const col = LeaderSignalOperations.VALUE_COLUMN_NAME
  const functionName = 'blockRunSpinner'

  const script = `
# Function to wait for runner acceptance
${functionName}() {
  if [ $# -ne 2 ]; then
    echo "Usage: $0 <id> <spin-period>" >&2
    return 1
  fi

  local _inputid="$1"
  local _sleep="$2"

  while true; do
    local _localdate
    _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local _acceptedid

    if ! _acceptedid=$(aws dynamodb get-item \\
          --table-name "$TABLE_NAME" \\
          --key '{ "PK": { "S": { "TYPE#${ent}" } }, "SK": { "S": "ID#'"$INSTANCE_ID"'" } }' \\
          --consistent-read \\
          --output text \\
          --query 'Item.${col}.S'); then
      echo "[$_localdate] unable to fetch runId, retrying..."
      sleep "$_sleep"
      continue    
    fi

    if [ -n "$_acceptedid" ] && [ "$_inputid" == "$_acceptedid" ]; then
      echo "[$_localdate] accepted ID ($_acceptedid) == input id ($_inputid). runner confirmed accepted. completing..."
      break
    else
      echo "[$_localdate] accepted ID ($_acceptedid) != input id ($_inputid). runner not yet accepted. retrying..."
      sleep "$_sleep"
      continue
    fi
  done
}
`

  return script.trim()
}

// This function polls the Instance partition checking if the runId associated with
// this instance differs from the provided input ID. It blocks (continues looping)
// as long as the runId matches the input ID, and releases (breaks the loop) when
// they differ or when the runId is removed, indicating the runner has been released.
export function blockInvalidationSpinner() {
  const ent = InstanceOperations.ENTITY_TYPE
  const functionName = 'blockInvalidationSpinner'

  const script = `
# Function to wait for runner invalidation
${functionName}() {
  if [ $# -ne 2 ]; then
    echo "Usage: $0 <id> <spin-period>" >&2
    return 1
  fi

  local _inputid="$1"
  local _sleep="$2"

  while true; do
    local _localdate
    _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local _runid

    if ! _runid=$(aws dynamodb get-item \\
          --table-name "$TABLE_NAME" \\
          --key '{ "PK": { "S": { "TYPE#${ent}" } }, "SK": { "S": "ID#'"$INSTANCE_ID"'" } }' \\
          --consistent-read \\
          --output text \\
          --query 'Item.runId.S'); then
      echo "[$_localdate] unable to fetch runId, retrying..."
      sleep "$_sleep"
      continue
    fi

    # NOTE: OK to have empty _runid - so not checking for -z
    if [ "$_runid" != "$_inputid" ]; then
      echo "[$_localdate] found _runid ($_runid) is != input id ($_inputid). runner released. completing..."
      break
    else
      echo "[$_localdate] found _runid ($_runid) is == input id ($_inputid). runner still not released. Retrying..."
      sleep "$_sleep"
      continue
    fi    
  done
}
`

  return script.trim()
}
