import * as core from '@actions/core'
import { DynamoDBClient } from '../dynamo-db-client.js'
import {
  DescribeTableCommand,
  CreateTableCommand,
  waitUntilTableExists
} from '@aws-sdk/client-dynamodb'

export class ApplicationOperations {
  protected client: DynamoDBClient
  protected tableName: string

  constructor(client: DynamoDBClient) {
    this.client = client
    this.tableName = this.client.getTableName()
  }

  async createTable() {
    try {
      await this.client
        .getClient()
        .send(new DescribeTableCommand({ TableName: this.tableName }))
      core.info(`The table ${this.tableName} already exists...`)
      return
    } catch (err: any) {
      // Only create if table does not exist
      if (err.name !== 'ResourceNotFoundException') {
        throw err
      }
      core.info(`The table ${this.tableName} does not exist, creating table...`)
      await this.client.getClient().send(
        new CreateTableCommand({
          TableName: this.tableName,
          AttributeDefinitions: [
            { AttributeName: 'PK', AttributeType: 'S' },
            { AttributeName: 'SK', AttributeType: 'S' }
          ],
          KeySchema: [
            { AttributeName: 'PK', KeyType: 'HASH' },
            { AttributeName: 'SK', KeyType: 'RANGE' }
          ],
          BillingMode: 'PAY_PER_REQUEST'
        })
      )

      await waitUntilTableExists(
        {
          client: this.client.getClient(),
          maxWaitTime: 60 // timeout in seconds
        },
        {
          TableName: this.tableName
        }
      )
      core.info(`Successfully created the table: ${this.tableName}...`)
    }
  }
}
