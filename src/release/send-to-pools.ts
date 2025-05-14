import {
  InstanceMessage,
  ResourceClassConfigOperations
} from '../services/sqs/operations/resource-class-operations.js'
import { ResourceClassConfig } from '../services/types.js'
import { InstanceItem } from '../services/dynamodb/operations/instance-operations.js'

// Extract SQS notification logic
export async function sendToPools(
  instances: InstanceItem[],
  resourceClassConfig: ResourceClassConfig,
  sqsOps: ResourceClassConfigOperations
): Promise<void> {
  // NOTE: this is translating what was picked up from ddb to what is sendable to sqs
  const instanceMessages: InstanceMessage[] = instances.map((instance) => ({
    id: instance.identifier,
    resourceClass: instance.resourceClass,
    instanceType: instance.instanceType,
    cpu: resourceClassConfig[instance.resourceClass].cpu,
    mmem: resourceClassConfig[instance.resourceClass].mmem
  }))

  await sqsOps.sendResourcesToPools(instanceMessages, resourceClassConfig)
}
