import { RegistrationTokenOperations } from '../../../services/dynamodb/operations/metadata-operations.js'

// $TABLE_NAME
export function fetchGHTokenScript() {
  const ent = RegistrationTokenOperations.ENTITY_TYPE
  const id = 'gh_registration_token' // NOTE: fix magic string
  const col = RegistrationTokenOperations.VALUE_COLUMN_NAME

  return `#!/bin/bash

localtoken=$(aws dynamodb get-item \
  --table-name $TABLE_NAME \
  --key '{"PK":{"S":"TYPE#${ent}}"},"SK":{"S":"ID#${id}"}}' \
  --query "Item.${col}.M.token.S" \
  --output text)

echo "$localtoken"
`
}
