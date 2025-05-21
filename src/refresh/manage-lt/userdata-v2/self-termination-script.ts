import { InstanceOperations } from '../../../services/dynamodb/operations/instance-operations.js'

export function selfTerminationScript(period = 15) {
  const ent = InstanceOperations.ENTITY_TYPE
  const col = 'threshold' // NOTE: magic string
  return `#!/bin/bash
period=${period}

while true; do
  localdate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmpfile=$(mktemp /tmp/ddb-item-instance.XXXXXX.json)
  cat <<JSON > "$tmpfile"
{
  "PK": { "S": "TYPE#${ent}" },
  "SK": { "S": "ID#$INSTANCE_ID" }
}
JSON

  # 1) Try fetching threshold, retry on API error
  if ! threshold=$(
      aws dynamodb get-item \
        --table-name "$TABLE_NAME" \
        --key file://"$tmpfile" \
        --query 'Item.${col}.S' \
        --consistent-read \
        --output text
    ); then
    echo "[$localdate] DynamoDB get-item failed; retrying in $period s…" >&2
    rm -f "$tmpfile"
    sleep $period
    continue
  fi
  rm -f "$tmpfile"

  echo "[$localdate] Fetched threshold: $threshold"

  # 2) No data yet?
  if [ -z "$threshold" ] || [ "$threshold" = "None" ]; then
    echo "[$localdate] No threshold recorded yet or item not available; sleeping $period s…" >&2
    sleep $period
    continue
  fi

  # 3) Add buffer and compare
  buffer=$(date -u -d "$threshold + 1 minute" +"%Y-%m-%dT%H:%M:%SZ")
  now_s=$(date -u +%s)
  tsb_s=$(date -u -d "$buffer" +%s)
  delta_s=$(( tsb_s - now_s ))
  echo "[$localdate] Difference: $delta_s seconds (threshold+buffer vs now)"

  # 4) Self-terminate when due
  if [ "$tsb_s" -lt "$now_s" ]; then
    echo "[$localdate] Deadline passed; initiating self-termination…"
    if aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"; then
      echo "[$localdate] Termination API call succeeded; exiting."
      break
    else
      echo "[$localdate] Termination call failed; retrying in $period s…" >&2
      sleep $period
      continue
    fi
  fi

  echo "[$localdate] Not yet due; sleeping $period s…"
  sleep $period
done
`
}
