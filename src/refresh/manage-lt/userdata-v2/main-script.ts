/* eslint-disable no-useless-escape */
import * as core from '@actions/core'
import sha256 from 'crypto-js/sha256.js'
import { Timing } from '../../../services/constants.js'
import { LTDatav2 } from '../../../services/types.js'
import { GitHubContext } from '../../../services/types.js'
import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'
import { emitSignal } from './emit-signal.js'
import { fetchGHToken } from './fetch-token.js'
import { userScript, downloadRunnerArtifactScript } from './minor-scripts.js'
import { blockRegistration, blockInvalidation } from './blockers.js'
import { heartbeatScript, selfTerminationScript } from './background-scripts.js'
import { tokenlessDeregistration } from './deregistration.js'

// DDB cli examples: https://docs.aws.amazon.com/cli/v1/userguide/cli_dynamodb_code_examples.html
// CLI examples: https://github.com/machulav/ec2-github-runner/blob/main/src/aws.js

// USE:
// $ tail -f /var/log/user-data.log
// $ journalctl -t user-data

export function addBuiltInScript(
  tableName: string,
  actionsRunnerVersion: string,
  context: GitHubContext,
  input: LTDatav2
): LTDatav2 {
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
${tokenlessDeregistration()}

echo "Scripts (are chmod +x)"
${heartbeatScript('heartbeat.sh')}
${selfTerminationScript('self-termination.sh')}
${userScript('user-script.sh', input.userData)}
${downloadRunnerArtifactScript('download-runner-artifact.sh', actionsRunnerVersion)}

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

_counter=0

while true; do
  _counter=$(( _counter + 1 ))
  echo "[$_counter] starting registration loop, ..."

  # PART 0: Confirmation of new pool (! -z RECORDED)
  _tmpfile=$(mktemp /tmp/ddb-item-runid.XXXXXX.json)  
  blockRegistration "$_tmpfile" "${Timing.BLOCK_REGISTRATION_INTERVAL}"
  LOOP_ID=$(cat "$_tmpfile")
  rm -f "$_tmpfile"

  # PART 2: Register to worker GH with valid token & emit
  _gh_reg_token=$(fetchGHToken)
    
  START_TIME=$(date +%s)
  
  # Disable auto-updates of runner. Auto-updates MAY (not confirmed) causes further time to kill run.sh on kill -TERM runner_pid. 
  # .TODO - consider either: parameterize gh runner version or metadata ddb fetch to avoid deprecations
  # Adding counter to --name to avoid api call to --replace
  if ! ./config.sh \\
    --url https://github.com/$GH_OWNER/$GH_REPO \\
    --name "$INSTANCE_ID-$_counter" \\
    --token "$_gh_reg_token" \\
    --disableupdate \\
    --unattended \\
    --no-default-labels \\
    --labels "$LOOP_ID"; then
    
    emitSignal "$LOOP_ID" "${WorkerSignalOperations.FAILED_STATUS.UD_REG}" 
    >&2 echo "Unable to register worker to gh"
    exit 1
  fi
  
  END_TIME=$(date +%s)
  DELTA=$((END_TIME - START_TIME))
  echo "config.sh execution time: $DELTA seconds"  

  emitSignal "$LOOP_ID" "${WorkerSignalOperations.OK_STATUS.UD_REG}" 
  echo "Successfully registered worker to gh"

  # PART 2.1: Start up Runner
  ./run.sh &
  LOOP_RUN_PID=$!

  # PART 3: Wait for leader to indicate all jobs done (flipped runId)
  blockInvalidation "$LOOP_ID" "${Timing.BLOCK_INVALIDATION_INTERVAL}"

  # PART 4: Deregistration 
  # NOTE: Use properDeregistration issues encountered, but will half capacity (1000->500 runner/hr)
  # https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/usage-limits-for-self-hosted-runners
  tokenlessDeregistration
  
  # EMIT OK SIGNAL HERE
  echo "Runner removed, emitting signal..."
  emitSignal "$LOOP_ID" "${WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG_REMOVE_RUN}"

  echo "Runner can safely re-register..."
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
  actionsRunnerVersion: string
  context: GitHubContext
  ltInput: LTDatav2
}

export function composeUserData(input: ComposeUserDataInput) {
  // Append UD
  core.info('appending UD...')
  let ltInput = addBuiltInScript(
    input.tableName,
    input.actionsRunnerVersion,
    input.context,
    input.ltInput
  )
  // Add on hash/base64
  core.info('adding UD base64 and UD hash...')
  ltInput = addUDWithBaseAndHash(ltInput)

  core.info('successfully composed UD...')
  return ltInput
}
