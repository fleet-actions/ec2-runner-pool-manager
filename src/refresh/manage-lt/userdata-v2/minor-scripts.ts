export function heredocAndchmod({
  filename,
  script
}: {
  filename: string
  script: string
}): string {
  return `cat <<'EOF'> ${filename}
${script}
EOF
chmod +x ${filename}
`
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
