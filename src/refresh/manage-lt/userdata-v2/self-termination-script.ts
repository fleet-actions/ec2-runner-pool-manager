import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'

export function selfTerminationScript(period = 15) {
  const ent = InstanceOperations.ENTITY_TYPE
  const col = 'threshold' // NOTE: magic string
  return `#!/bin/bash
_period=${period}

while true; do
  _localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  _tmpfile=$(mktemp /tmp/ddb-item-instance.XXXXXX.json)
  cat <<JSON > "$_tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" }
}
JSON

  # 1) Try fetching threshold, retry on API error
  if ! _threshold=$(
      aws dynamodb get-item \
        --table-name "$TABLE_NAME" \
        --key file://"$_tmpfile" \
        --query 'Item.${col}.S' \
        --consistent-read \
        --output text
    ); then
    echo "[$_localdate] DynamoDB get-item failed; retrying in $_period s…" >&2
    rm -f "$_tmpfile"
    sleep $_period
    continue
  fi
  rm -f "$_tmpfile"

  echo "[$_localdate] Fetched _threshold: $_threshold"

  # 2) No data yet?
  if [ -z "$_threshold" ] || [ "$_threshold" = "None" ]; then
    echo "[$_localdate] No _threshold recorded yet or item not available; sleeping $_period s…" >&2
    sleep $_period
    continue
  fi

  # 3) Add buffer and compare
  _buffer=$(date -u -d "$_threshold + 1 minute" +"%Y-%m-%dT%H:%M:%SZ")
  _now_s=$(date -u +%s)
  _tsb_s=$(date -u -d "$_buffer" +%s)
  _delta_s=$(( _tsb_s - _now_s ))
  echo "[$_localdate] Difference: $_delta_s seconds (_threshold+_buffer vs now)"

  # 4) Self-terminate when due
  if [ "$_tsb_s" -lt "$_now_s" ]; then
    echo "[$_localdate] Deadline passed; initiating self-termination…"
    if aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"; then
      echo "[$_localdate] Termination API call succeeded; exiting."
      break
    else
      echo "[$_localdate] Termination call failed; retrying in $_period s…" >&2
      sleep $_period
      continue
    fi
  fi

  echo "[$_localdate] Not yet due; sleeping $_period s…"
  sleep $_period
done
`
}
