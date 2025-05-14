import { DynamoDBClient as AwsDynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

export class DynamoDBClient {
  private client: DynamoDBDocumentClient
  private tableName: string

  constructor(
    region: string,
    tableName: string,
    testTableName: string = 'testing-table' // 🔍 this needs to be consistent with testing/jest-dynalite-config.cjs
  ) {
    const config = {
      region,
      endpoint: `https://dynamodb.${region}.amazonaws.com`
    }

    // https://github.com/freshollie/jest-dynalite?tab=readme-ov-file#update-your-sourcecode
    const testConfig = {} as {
      endpoint: string
      sslEnabled: boolean
      region: string
    }
    if (process.env.MOCK_DYNAMODB_ENDPOINT) {
      testConfig.endpoint = process.env.MOCK_DYNAMODB_ENDPOINT
      testConfig.sslEnabled = false
      testConfig.region = 'local'
    }

    // console.log('Creating client with config:', { ...config, ...testConfig })
    const ddbClient = new AwsDynamoDBClient({ ...config, ...testConfig })

    // Create the document client with marshalling/unmarshalling
    this.client = DynamoDBDocumentClient.from(ddbClient, {
      marshallOptions: { removeUndefinedValues: true }
    })

    if (process.env.MOCK_DYNAMODB_ENDPOINT) {
      this.tableName = testTableName
    } else {
      this.tableName = tableName
    }
  }

  getClient() {
    return this.client
  }

  getTableName() {
    return this.tableName
  }
}
