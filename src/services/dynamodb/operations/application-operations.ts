import { DynamoDBClient } from '../dynamo-db-client.js'

export class ApplicationOperations {
  protected client: DynamoDBClient
  protected tableName: string

  constructor(client: DynamoDBClient) {
    this.client = client
    this.tableName = this.client.getTableName()
  }
}
