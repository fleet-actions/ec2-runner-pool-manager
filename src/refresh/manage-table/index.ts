import { ApplicationOperations } from '../../services/dynamodb/operations/application-operations.js'

export async function manageTable(ddbOps: ApplicationOperations) {
  await ddbOps.createTable()
}
