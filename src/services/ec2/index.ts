// services/ec2/index.ts
import { EC2Client } from './ec2-client.js'
import { LaunchTemplateOperations } from './operations/launch-template-operations.js'
import { FleetOperations } from './operations/fleet-operations.js'
import { InstanceOperations } from './operations/instance-operations.js'

export class EC2Service {
  constructor(private client: EC2Client) {}

  /**
   * Returns an instance of LaunchTemplateOperations to manage launch templates.
   */
  getLaunchTemplateOperations() {
    return new LaunchTemplateOperations(this.client)
  }

  getFleetOperations() {
    return new FleetOperations(this.client)
  }

  getInstanceOperations() {
    return new InstanceOperations(this.client)
  }
}

/**
 * Helper function to create an EC2Service instance.
 * @param region - AWS region in which to instantiate the EC2 client.
 */
export function createEC2Service(region: string): EC2Service {
  const client = new EC2Client(region)
  return new EC2Service(client)
}
