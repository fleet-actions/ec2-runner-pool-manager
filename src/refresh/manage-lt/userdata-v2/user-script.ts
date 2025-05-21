export function userScript(userScript: string = "echo 'Hello world'") {
  return `${userScript}

echo "UserData execution completed successfully at $(date)" >> /var/log/user-data-completion.log
cat /var/log/user-data-completion.log
`
}
