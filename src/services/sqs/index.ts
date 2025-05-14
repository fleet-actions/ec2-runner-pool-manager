import { SQSClient } from './sqs-client.js'
import { ResourceClassConfigOperations } from './operations/resource-class-operations.js'

export class SQSService {
  constructor(private client: SQSClient) {}

  getResourceClassConfigOperations() {
    return new ResourceClassConfigOperations(this.client)
  }
}

/**
 * Helper function to create an EC2Service instance.
 * @param region - AWS region in which to instantiate the EC2 client.
 */
export function createSQSService(region: string): SQSService {
  const client = new SQSClient(region)
  return new SQSService(client)
}
