import { RegistrationTokenOperations } from '../../../services/dynamodb/operations/metadata-operations.js'
import { heredocAndchmod } from './helper.js'

// $TABLE_NAME
export function fetchGHTokenScript(filename: string) {
  const ent = RegistrationTokenOperations.ENTITY_TYPE
  const id = 'gh_registration_token' // NOTE: fix magic string
  const col = RegistrationTokenOperations.VALUE_COLUMN_NAME

  const script = `#!/bin/bash

_localtoken=$(aws dynamodb get-item \
  --table-name $TABLE_NAME \
  --key '{ "PK": { "S" : "TYPE#${ent}" } }, "SK" : { "S" : "ID#${id}" } }' \
  --query "Item.${col}.M.token.S" \
  --output text)

echo "$_localtoken"
`

  return heredocAndchmod({ filename, script })
}

export function downloadRunnerArtifactScript(
  filename: string,
  runnerVersion: string
) {
  const script = `#!/bin/bash
case $(uname -m) in
  aarch64|arm64) ARCH="arm64";;
  amd64|x86_64)  ARCH="x64";;
esac && export RUNNER_ARCH=$ARCH

GH_RUNNER_VERSION=${runnerVersion}
curl -O -L https://github.com/actions/runner/releases/download/v$GH_RUNNER_VERSION/actions-runner-linux-$RUNNER_ARCH-$GH_RUNNER_VERSION.tar.gz
tar xzf ./actions-runner-linux-$RUNNER_ARCH-$GH_RUNNER_VERSION.tar.gz
`

  return heredocAndchmod({ filename, script })
}

export function userScript(
  filename: string,
  userScript: string = "echo 'Hello world'"
) {
  const script = `${userScript}

echo "UserData execution completed successfully at $(date)" >> /var/log/user-data-completion.log
cat /var/log/user-data-completion.log
`

  return heredocAndchmod({ filename, script })
}
