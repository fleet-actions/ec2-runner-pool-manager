/* eslint-disable no-useless-escape */
import * as core from '@actions/core'
import sha256 from 'crypto-js/sha256.js'
import { LTDatav2 } from '../../../services/types.js'
import { GitHubContext } from '../../../services/types.js'
import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'
import { emitSignal } from './emit-signal.js'
import { fetchGHToken } from './fetch-token.js'
import { userScript, downloadRunnerArtifactScript } from './minor-scripts.js'
import { blockRegistration, blockInvalidation } from './blockers.js'
import {
  heartbeatScript,
  selfTerminationScript,
  keepRunnerAliveScript
} from './background-scripts.js'

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
  const RUNNER_VERSION = '2.323.0' // NOTE: parameterizing directly may cause multi-lt versions being hit faster. Consider as metadata
  const longS = 5
  const shortS = 0.5

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

export INSTANCE_ID

echo "Building reusables (are chmod +x); TABLE_NAME and INSTANCE_ID must be available"
${emitSignal()}
${fetchGHToken()}
${blockRegistration()}
${blockInvalidation()}

echo "Scripts (are chmod +x)"
${heartbeatScript('heartbeat.sh')}
${selfTerminationScript('self-termination.sh')}
${keepRunnerAliveScript('keep-runner-alive.sh')}
${userScript('user-script.sh', input.userData)}
${downloadRunnerArtifactScript('download-runner-artifact.sh', RUNNER_VERSION)}

### SOME INITIALIZATION ###
if echo "$INITIAL_RUN_ID" | grep -q 'Not Found'; then
  >&2 echo "InitialRunId not added to instance tag, exiting..."
  # TODO: Consider emitting a signal here for more info, although this is likely not to cause an issue
  exit 1
fi

### USERDATA ###
if ! ./user-script.sh; then
  >&2 echo "user-defined userdata unable to execute correctly. emitting signal..."
  emitSignal "$INITIAL_RUN_ID" "${WorkerSignalOperations.FAILED_STATUS.UD}"
  exit 1
fi

echo "user-defined userdata OK. emitting signal..."
emitSignal "$INITIAL_RUN_ID" "${WorkerSignalOperations.OK_STATUS.UD}"

### FETCH ARTIFACTS ###
./download-runner-artifact.sh

### SETUP BACKGROUND SCRIPTS ###
./heartbeat.sh &
./self-termination.sh &

### REGISTRATION LOOP ###
export RUNNER_ALLOW_RUNASROOT=1 
export RUNNER_MANUALLY_TRAP_SIG=1
./keep-runner-alive.sh &

while true; do
  echo "Starting registration loop..."

  # PART 0: Confirmation of new pool (! -z RECORDED)
  _tmpfile=$(mktemp /tmp/ddb-item-runid.XXXXXX.json)  
  blockRegistration "$_tmpfile" "${shortS}"
  _loop_id=$(cat "$_tmpfile")
  rm -f "$_tmpfile"

  # PART 2: Register to worker GH with valid token & emit
  _gh_reg_token=$(fetchGHToken)
    
  START_TIME=$(date +%s)
  
  # Disable auto-updates of runner. Auto-updates MAY (not confirmed) causes further time to kill run.sh on kill -TERM runner_pid. 
  # .TODO - consider either: parameterize gh runner version or metadata ddb fetch to avoid deprecations
  if ! ./config.sh \\
    --url https://github.com/$GH_OWNER/$GH_REPO \\
    --name "$INSTANCE_ID" \\
    --replace \\
    --token "$_gh_reg_token" \\
    --disableupdate \\
    --unattended \\
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

  # PART 6: Wait for leader to indicate all jobs done (flipped runId)
  blockInvalidation "$_loop_id" "${longS}"

  # PART 7: Remove .runner if found and perform general removal  
  if [ -f .runner ]; then
    echo "Found .runner removing..."
    rm .runner
  else
    echo "no .runner found. following tokenless ./config.sh remove may fail..."
  fi

  echo "Performing tokenless config.sh remove..."
  if ./config.sh remove; then
    echo "Successfully removed registration files, emitting signal..."
    emitSignal "$_loop_id" "${WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG}"
  else
    echo "Unsuccessfully removed registration files, emitting signal..."
    emitSignal "$_loop_id" "${WorkerSignalOperations.FAILED_STATUS.UD_REMOVE_REG}"
    exit 1
  fi
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
