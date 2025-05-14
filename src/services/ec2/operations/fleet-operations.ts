import { ApplicationOperations } from './application-operations.js'
import {
  CreateFleetCommandInput,
  CreateFleetCommand,
  CreateFleetCommandOutput
} from '@aws-sdk/client-ec2'

export class FleetOperations extends ApplicationOperations {
  /**
   * Creates an EC2 Fleet with the specified parameters.
   * Uses the 'instant' type for synchronous response including instance IDs.
   *
   * @param params The CreateFleetCommandInput parameters
   * @returns The CreateFleetCommandOutput response
   */
  async createFleet(
    params: CreateFleetCommandInput
  ): Promise<CreateFleetCommandOutput> {
    const command = new CreateFleetCommand(params)
    return this.client.getClient().send(command)
  }
}
