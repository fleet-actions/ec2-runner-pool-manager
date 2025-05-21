export function downloadRunnerArtifactScript(runnerVersion: string) {
  return `#!/bin/bash
case $(uname -m) in
  aarch64|arm64) ARCH="arm64";;
  amd64|x86_64)  ARCH="x64";;
esac && export RUNNER_ARCH=$ARCH

GH_RUNNER_VERSION=${runnerVersion}
curl -O -L https://github.com/actions/runner/releases/download/v$GH_RUNNER_VERSION/actions-runner-linux-$RUNNER_ARCH-$GH_RUNNER_VERSION.tar.gz
tar xzf ./actions-runner-linux-$RUNNER_ARCH-$GH_RUNNER_VERSION.tar.gz
`
}
