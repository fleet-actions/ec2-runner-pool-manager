import * as core from '@actions/core'
import sha256 from 'crypto-js/sha256.js'
import { LTDatav2 } from '../../services/types.js'
import { GitHubContext } from '../../services/types.js'
import { BootstrapOperations as BootstrapConstants } from '../../services/dynamodb/operations/bootstrap-operations.js'
import { HeartbeatOperations as HeartbeatConstants } from '../../services/dynamodb/operations/heartbeat-operations.js'

// in this file, we will take the current (user-inputted) userdata and append
// .metadata query
// .ddb state update (ud-completed)
// .gh registration
// .ddb state update (ud-gh-completed)

// DDB cli examples: https://docs.aws.amazon.com/cli/v1/userguide/cli_dynamodb_code_examples.html
// CLI examples: https://github.com/machulav/ec2-github-runner/blob/main/src/aws.js

// USE:
// $ tail -n 50 /var/log/user-data.log
// $ journalctl -t user-data

export function addBuiltInScript(
  tableName: string,
  context: GitHubContext,
  input: LTDatav2
): LTDatav2 {
  const {
    VALUE_COLUMN_NAME: BOOTSTRAP_COLUMN_NAME,
    ENTITY_TYPE: BOOTSTRAP_ENTITY,
    STATUS: BOOTSTRAP_STATUS
  } = BootstrapConstants

  const {
    VALUE_COLUMN_NAME: HEARTBEAT_COLUMN_NAME,
    ENTITY_TYPE: HEARTBEAT_ENTITY,
    STATUS: HEARTBEAT_STATUS,
    PERIOD_SECONDS: HEARTBEAT_PERIOD_SECONDS
  } = HeartbeatConstants

  // NOTE: see mixing of single/double quotes for INSTANCE_ID (https://stackoverflow.com/a/48470195)
  const WRAPPER_SCRIPT = `#!/bin/bash

### INITIAL STEPS:
# .redirect all logs to user-data.log
# .create actions directory
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
mkdir -p actions-runner && cd actions-runner

### USER-DEFINED METADATA
echo "starting user data..."
echo "${input.userData}" > pre-runner-script.sh
source pre-runner-script.sh

### INPUTS FROM JS
TABLE_NAME="${tableName}"
GH_OWNER="${context.owner}"
GH_REPO="${context.repo}"
BOOTSTRAP_ENTITY="${BOOTSTRAP_ENTITY}"
BOOTSTRAP_COLUMN_NAME="${BOOTSTRAP_COLUMN_NAME}"
USERDATA_COMPLETED="${BOOTSTRAP_STATUS.USERDATA_COMPLETED}"
USERDATA_REGISTRATION_COMPLETED="${BOOTSTRAP_STATUS.USERDATA_REGISTRATION_COMPLETED}"
HEARTBEAT_COLUMN_NAME="${HEARTBEAT_COLUMN_NAME}"
HEARTBEAT_ENTITY="${HEARTBEAT_ENTITY}"
HEARTBEAT_STATE="${HEARTBEAT_STATUS.PING}"
HEARTBEAT_PERIOD_SECONDS=${HEARTBEAT_PERIOD_SECONDS}

### TEST INPUTS
# TABLE_NAME="ci-test-partial-ci-test-partial-ec2-runner-pool-table-test"
# BOOTSTRAP_ENTITY="BOOTSTRAP"
# BOOTSTRAP_COLUMN_NAME="value"
# USERDATA_COMPLETED="USERDATA_COMPLETED"
# USERDATA_REGISTRATION_COMPLETED="USERDATA_REGISTRATION_COMPLETED"
# HEARTBEAT_COLUMN_NAME="value"
# HEARTBEAT_ENTITY="HEARTHBEAT"
# HEARTBEAT_STATE="PING"
# HEARTBEAT_PERIOD_SECONDS=5

### FETCHING METADATA
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)

echo "Successfully initialized info..."

### UPDATING DDB WITH UD-COMPLETE
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMPFILE=$(mktemp /tmp/ddb-item-udcomplete.XXXXXX.json)
cat <<JSON > "$TMPFILE"
{
  "PK": { "S": "TYPE#$BOOTSTRAP_ENTITY" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "$BOOTSTRAP_ENTITY" },
  "identifier": { "S": "$INSTANCE_ID" },
  "$BOOTSTRAP_COLUMN_NAME": { "S": "$USERDATA_COMPLETED" },
  "updatedAt": { "S": "$DATE" }
}
JSON
aws dynamodb put-item \
  --table-name "$TABLE_NAME" \
  --item file://"$TMPFILE"
rm -f "$TMPFILE"
echo "UD completed communicated to DDB..."

### REGISTRATION ROUTINE
GH_REGISTRATION_TOKEN=$(aws dynamodb get-item \
  --table-name $TABLE_NAME \
  --key '{"PK":{"S":"TYPE#METADATA"},"SK":{"S":"ID#gh_registration_token"}}' \
  --query "Item.value.M.token.S" \
  --output text)

echo "Registering to GH..."
case $(uname -m) in
  aarch64|arm64) ARCH="arm64";;
  amd64|x86_64)  ARCH="x64";;
esac && export RUNNER_ARCH=$ARCH

GH_RUNNER_VERSION=2.323.0
curl -O -L https://github.com/actions/runner/releases/download/v$GH_RUNNER_VERSION/actions-runner-linux-$RUNNER_ARCH-$GH_RUNNER_VERSION.tar.gz
tar xzf ./actions-runner-linux-$RUNNER_ARCH-$GH_RUNNER_VERSION.tar.gz

export RUNNER_ALLOW_RUNASROOT=1
# EC2 Instance ID Uniqueness - https://serverfault.com/questions/58401/is-the-amazon-ec2-instance-id-unique-forever
./config.sh --url https://github.com/$GH_OWNER/$GH_REPO --name $INSTANCE_ID --token $GH_REGISTRATION_TOKEN --no-default-labels --labels $INSTANCE_ID
CONFIG_EXIT_CODE=$?
if [ $CONFIG_EXIT_CODE -ne 0 ]; then
  echo "Error: GitHub Actions Runner config.sh failed with exit code $CONFIG_EXIT_CODE." >&2
  exit $CONFIG_EXIT_CODE
fi

echo "GH Registration script completed..."
export TABLE_NAME HEARTBEAT_COLUMN_NAME HEARTBEAT_ENTITY HEARTBEAT_STATE HEARTBEAT_PERIOD_SECONDS INSTANCE_ID

### UPDATING DDB WITH UD-REG COMPLETE
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMPFILE=$(mktemp /tmp/ddb-item-udreg.XXXXXX.json)
cat <<JSON > "$TMPFILE"
{
  "PK": { "S": "TYPE#$BOOTSTRAP_ENTITY" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "$BOOTSTRAP_ENTITY" },
  "identifier": { "S": "$INSTANCE_ID" },
  "$BOOTSTRAP_COLUMN_NAME": { "S": "$USERDATA_REGISTRATION_COMPLETED" },
  "updatedAt": { "S": "$DATE" }
}
JSON
aws dynamodb put-item \
  --table-name "$TABLE_NAME" \
  --item file://"$TMPFILE"
rm -f "$TMPFILE"
echo "UD-Registration completed communicated to DDB..."

echo "Writing heartbeat script..."
cat <<'EOF' > heartbeat.sh
#!/bin/bash
while true; do
  DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  TMPFILE=$(mktemp /tmp/ddb-item-heartbeat.XXXXXX.json)
  cat <<JSON > "$TMPFILE"
{
  "PK": { "S": "TYPE#$HEARTBEAT_ENTITY" },
  "SK": { "S": "ID#$INSTANCE_ID" },
  "entityType": { "S": "$HEARTBEAT_ENTITY" },
  "identifier": { "S": "$INSTANCE_ID" },
  "$HEARTBEAT_COLUMN_NAME": { "S": "$HEARTBEAT_STATE" },
  "updatedAt": { "S": "$DATE" }
}
JSON
  if ! aws dynamodb put-item \
    --table-name "$TABLE_NAME" \
    --item file://"$TMPFILE"; then
    rm -f "$TMPFILE"
    echo "[$DATE] heartbeat failed, retrying in [$HEARTBEAT_PERIOD_SECONDS]s..." >&2
    sleep $HEARTBEAT_PERIOD_SECONDS
    continue
  fi
  rm -f "$TMPFILE"
  sleep $HEARTBEAT_PERIOD_SECONDS
done
EOF

echo "Executing heartbeat in background..."
chmod +x heartbeat.sh
./heartbeat.sh &

### STARTING RUNNER
# echo "Running run.sh"
./run.sh
`

  return { ...input, userData: WRAPPER_SCRIPT }
}

export function addUDWithBaseAndHash(ltInput: LTDatav2): LTDatav2 {
  if (!ltInput.userData) {
    throw new Error('User Data must be provided')
  }
  const hash = sha256(ltInput.userData).toString()
  const base64 = Buffer.from(ltInput.userData).toString('base64')

  const ltReturn = { ...ltInput, userDataBase64: base64, userDataHash: hash }

  return ltReturn
}

export interface ComposeUserDataInput {
  tableName: string
  context: GitHubContext
  ltInput: LTDatav2
}

export function composeUserData(input: ComposeUserDataInput) {
  // Append UD
  core.info('appending UD...')
  let ltInput = addBuiltInScript(input.tableName, input.context, input.ltInput)
  // Add on hash/base64
  core.info('adding UD base64 and UD hash...')
  ltInput = addUDWithBaseAndHash(ltInput)

  core.info('successfully composed UD...')
  return ltInput
}
