/* eslint-disable no-useless-escape */
import * as core from '@actions/core'
import sha256 from 'crypto-js/sha256.js'
import { LTDatav2 } from '../../../services/types.js'
import { GitHubContext } from '../../../services/types.js'
import { emitSignalScript } from './emit-signal-script.js'
import { fetchGHTokenScript } from './fetch-gh-token-script.js'
import { heartbeatScript } from './heartbeat-script.js'
import { selfTerminationScript } from './self-termination-script.js'
import { userScript } from './user-script.js'
import { downloadRunnerArtifactScript } from './download-runner-artifact-script.js'
import { blockRegistrationSpinnerScript } from './block-registration-spinner-script.js'
import { blockRunSpinnerScript } from './block-running-spinner-script.js'
import { blockInvalidationSpinnerScript } from './block-invalidation-spinner-script.js'

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

  // NOTE: see mixing of single/double quotes for INSTANCE_ID (https://stackoverflow.com/a/48470195)
  const WRAPPER_SCRIPT = `#!/bin/bash

### INITIAL STEPS:
# .redirect all logs to user-data.log
# .create actions directory
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
mkdir -p actions-runner && cd actions-runner

### INPUTS FROM JS
export TABLE_NAME="${tableName}"
export GH_OWNER="${context.owner}"
export GH_REPO="${context.repo}"

### REMAINING INITIALIZATION 
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
export INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)

echo "Building reusable scripts (are chmod +x); TABLE_NAME and INSTANCE_ID must be available"
${emitSignalScript('emit-signal.sh')}
${fetchGHTokenScript('fetch-gh-token.sh')}
${heartbeatScript('heartbeat.sh')}
${selfTerminationScript('self-termination.sh')}
${userScript('user-script.sh', input.userData)}
${downloadRunnerArtifactScript('download-runner-artifact.sh', RUNNER_VERSION)}
${blockRegistrationSpinnerScript('block-registration-spinner.sh')}
${blockRunSpinnerScript('block-run-spinner.sh')}
${blockInvalidationSpinnerScript('block-invalidation-spinner.sh')}

### USERDATA ###
### ... ###

### REGISTRATION ROUTINE
### ... ###





export RUNNER_ALLOW_RUNASROOT=1
# EC2 Instance ID Uniqueness - https://serverfault.com/questions/58401/is-the-amazon-ec2-instance-id-unique-forever
START_TIME=$(date +%s)
./config.sh --url https://github.com/$GH_OWNER/$GH_REPO --name $INSTANCE_ID --token $GH_REGISTRATION_TOKEN --no-default-labels --labels $INSTANCE_ID
CONFIG_EXIT_CODE=$?
END_TIME=$(date +%s)
DELTA=$((END_TIME - START_TIME))
echo "config.sh execution time: $DELTA seconds"

if [ $CONFIG_EXIT_CODE -ne 0 ]; then
  echo "Error: GitHub Actions Runner config.sh failed with exit code $CONFIG_EXIT_CODE." >&2
  exit $CONFIG_EXIT_CODE
fi

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
