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
