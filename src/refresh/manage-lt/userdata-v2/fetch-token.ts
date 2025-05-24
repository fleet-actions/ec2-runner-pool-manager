import { RegistrationTokenOperations } from '../../../services/dynamodb/operations/metadata-operations.js'

// $TABLE_NAME
export function fetchGHToken() {
  const ent = RegistrationTokenOperations.ENTITY_TYPE
  const id = 'gh_registration_token' // NOTE: fix magic string
  const col = RegistrationTokenOperations.VALUE_COLUMN_NAME
  const functionName = 'fetchGHToken'

  const script = `
# Function to fetch GitHub registration token from DynamoDB
${functionName}() {
  local _localtoken

  _localtoken=$(aws dynamodb get-item \\
    --table-name "$TABLE_NAME" \\
    --key '{ "PK": { "S" : "TYPE#${ent}" }, "SK" : { "S" : "ID#${id}" } }' \\
    --query "Item.${col}.M.token.S" \\
    --output text)

  echo "$_localtoken"
}
`

  return script.trim()
}
