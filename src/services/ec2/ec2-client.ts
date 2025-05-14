// services/ec2/ec2-client.ts
import { EC2Client as AwsEC2Client } from '@aws-sdk/client-ec2'

export class EC2Client {
  private client: AwsEC2Client

  constructor(region: string) {
    this.client = new AwsEC2Client({ region })
  }

  public getClient(): AwsEC2Client {
    return this.client
  }
}
