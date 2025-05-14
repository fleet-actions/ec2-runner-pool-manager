import { EC2Client } from '../ec2-client.js'

export class ApplicationOperations {
  protected client: EC2Client

  constructor(client: EC2Client) {
    this.client = client
  }
}
