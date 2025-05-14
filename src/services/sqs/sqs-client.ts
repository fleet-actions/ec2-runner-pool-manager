import { SQSClient as AWSSQSClient } from '@aws-sdk/client-sqs'

export class SQSClient {
  private client: AWSSQSClient

  constructor(region: string) {
    this.client = new AWSSQSClient({ region })
  }

  public getClient(): AWSSQSClient {
    return this.client
  }
}
