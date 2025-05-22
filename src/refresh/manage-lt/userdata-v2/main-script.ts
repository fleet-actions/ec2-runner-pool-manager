/* eslint-disable no-useless-escape */
import * as core from '@actions/core'
import sha256 from 'crypto-js/sha256.js'
import { LTDatav2 } from '../../../services/types.js'
import { GitHubContext } from '../../../services/types.js'
import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'
import { emitSignal } from './emit-signal.js'
import { fetchGHToken } from './fetch-token.js'
import { userScript, downloadRunnerArtifactScript } from './minor-scripts.js'
import {
  blockRegistrationSpinner,
  blockRunSpinner,
  blockInvalidationSpinner
} from './spinners.js'
import { heartbeat, selfTermination } from './background.js'

// in this file, we will take the current (user-inputted) userdata and append
// .metadata query
// .ddb state update (ud-completed)
// .gh registration
// .ddb state update (ud-gh-completed)

// DDB cli examples: https://docs.aws.amazon.com/cli/v1/userguide/cli_dynamodb_code_examples.html
// CLI examples: https://github.com/machulav/ec2-github-runner/blob/main/src/aws.js

// USE:
// $ tail -f /var/log/user-data.log
// $ journalctl -t user-data

export function addBuiltInScript(
  tableName: string,
  context: GitHubContext,
  input: LTDatav2
): LTDatav2 {
  const RUNNER_VERSION = '2.323.0'
  const longS = 1
  const shortS = 0.1

  // NOTE: see mixing of single/double quotes for INSTANCE_ID (https://stackoverflow.com/a/48470195)
  const WRAPPER_SCRIPT = `#!/bin/bash

### INITIAL STEPS:
# .redirect all logs to user-data.log
# .create actions directory
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
mkdir -p actions-runner && cd actions-runner || exit

### INPUTS FROM JS
export TABLE_NAME="${tableName}"
export GH_OWNER="${context.owner}"
export GH_REPO="${context.repo}"

### REMAINING INITIALIZATION 
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
INITIAL_RUN_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/tags/instance/InitialRunId)

if echo "$INITIAL_RUN_ID" | grep -q 'Not Found'; then
  >&2 echo "InitialRunId not added to instance tag, exiting..."
  exit 1
fi

export INSTANCE_ID

echo "Building reusable scripts (are chmod +x); TABLE_NAME and INSTANCE_ID must be available"
${emitSignal()}
${fetchGHToken()}
${heartbeat()}
${selfTermination()}
${blockRegistrationSpinner()}
${blockRunSpinner()}
${blockInvalidationSpinner()}

${userScript('user-script.sh', input.userData)}
${downloadRunnerArtifactScript('download-runner-artifact.sh', RUNNER_VERSION)}

### USERDATA ###
if ! ./user-script.sh; then
  >&2 echo "user-defined userdata unable to execute correctly. emitting signal..."
  emitSignal "" "${WorkerSignalOperations.FAILED_STATUS.UD}"
  exit 1
fi

echo "user-defined userdata OK. emitting signal..."
emitSignal "" "${WorkerSignalOperations.OK_STATUS.UD}"

### FETCH ARTIFACTS ###
./download-runner-artifact.sh

### SETUP BACKGROUND SCRIPTS ###
heartbeat &
selfTermination &

### REGISTRATION LOOP ###
while true; do
  echo "Starting registration loop..."

  # PART 1: Confirmation of new pool (! -z RECORDED), use initial id if not empty. Empty soon after.
  if [ -n "$INITIAL_RUN_ID" ]; then
    _loop_id=$INITIAL_RUN_ID
    INITIAL_RUN_ID="" 
  else
    _tmpfile=$(mktemp /tmp/ddb-item-runid.XXXXXX.json)  
    blockRegistrationSpinner "$_tmpfile" "${longS}"
    _loop_id=$(cat "$_tmpfile")
    rm -f "$_tmpfile"    
  fi 

  # PART 2: Register to worker GH with valid token & emit
  _gh_reg_token=$(fetchGHToken)
    
  START_TIME=$(date +%s)
  
  if ! ./config.sh \\
    --url https://github.com/$GH_OWNER/$GH_REPO \\
    --name "$INSTANCE_ID" \\
    --replace true \\
    --token "$_gh_reg_token" \\
    --no-default-labels \\
    --labels "$_loop_id"; then
    
    emitSignal "$_loop_id" "${WorkerSignalOperations.FAILED_STATUS.UD_REG}" 
    >&2 echo "Unable to register worker to gh"
    exit 1
  fi
  
  END_TIME=$(date +%s)
  DELTA=$((END_TIME - START_TIME))
  echo "config.sh execution time: $DELTA seconds"  

  emitSignal "$_loop_id" "${WorkerSignalOperations.OK_STATUS.UD_REG}" 
  echo "Successfully registered worker to gh"

  # PART 3 ACK from leader of OK reg signal
  blockRunSpinner "$_loop_id" "${shortS}"

  # PART 4: Allow runner to listen (manual mode for deterministic/better control)
  # https://github.com/actions/runner/blob/main/src/Misc/layoutroot/run.sh
  RUNNER_MANUALLY_TRAP_SIG=1 ./run.sh > runner.log 2>&1 & 
  _runner_pid=$!

  # PART 5: IF NEEDED - monitor status of run.sh. 
  # ... For now, be optimistic of run.sh runtime

  # PART 6: Wait for leader worker no longer needs to listen
  blockInvalidationSpinner "$_loop_id" "${longS}"

  # PART 7: Send kill signal to listener pid and deregister
  echo "Initiating invalidation..."
  if kill -TERM $_runner_pid; then
    wait $_runner_pid  
  fi 

  # CONSIDER: emission of signal on unsuccessful removal (ie. so we can mark for termination)
  _gh_reg_token=$(fetchGHToken)
  ./config.sh remove --token "$_gh_reg_token"

  echo "Worker now should not be able to pickup jobs..."
done
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
