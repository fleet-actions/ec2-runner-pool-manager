import { heredocAndchmod } from './helper.js'

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
