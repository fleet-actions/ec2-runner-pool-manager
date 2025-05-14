import { ApplicationOperations } from './application-operations.js'
import {
  DescribeInstancesCommandInput,
  TerminateInstancesCommand,
  TerminateInstancesCommandInput,
  TerminateInstancesCommandOutput,
  paginateDescribeInstances
} from '@aws-sdk/client-ec2'

export class InstanceOperations extends ApplicationOperations {
  /**
   * Retrieves EC2 instance IDs grouped by their state.
   * @returns Promise resolving to a record mapping instance state names to arrays of InstanceId strings.
   */
  async classifyAllInstancesByState(): Promise<Record<string, string[]>> {
    // paginateDescribeInstances (wraps) describeInstances
    const paginator = paginateDescribeInstances(
      { client: this.client.getClient() },
      {} as DescribeInstancesCommandInput
    )
    const result: Record<string, string[]> = {}
    for await (const page of paginator) {
      for (const reservation of page.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          const stateName = instance.State?.Name || 'unknown'
          if (!result[stateName]) {
            result[stateName] = []
          }
          if (instance.InstanceId) {
            result[stateName].push(instance.InstanceId)
          }
        }
      }
    }
    return result
  }
  /**
   * Retrieves all EC2 instance IDs in the configured region.
   * Uses the DescribeInstances paginator under the hood.
   *
   * @returns Promise resolving to an array of InstanceId strings
   */
  async getAllInstanceIds(): Promise<string[]> {
    const classified = await this.classifyAllInstancesByState()
    return Object.values(classified).flat()
  }

  /**
   * Terminates the specified EC2 instances.
   *
   * @param instanceIds - array of EC2 InstanceIds to terminate
   * @returns Promise resolving to the AWS SDK TerminateInstancesCommandOutput
   */
  async terminateInstances(
    instanceIds: string[]
  ): Promise<TerminateInstancesCommandOutput> {
    const params: TerminateInstancesCommandInput = { InstanceIds: instanceIds }
    const command = new TerminateInstancesCommand(params)
    return this.client.getClient().send(command)
  }
}
