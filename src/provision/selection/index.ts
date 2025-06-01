import * as core from '@actions/core'
import { claimWorker } from './claim-worker.js'
import { PoolPickUpManager } from './pool-pickup-manager.js'
import type { Instance, SelectionInput, SelectionOutput } from '../types.js'

export async function selection(
  input: SelectionInput
): Promise<SelectionOutput> {
  core.info('starting selection routine...')
  core.debug(
    `recieved: ${JSON.stringify({ ...input, ddbOps: '', sqsOps: '' })}`
  )

  const {
    allowedInstanceTypes,
    resourceClass,
    resourceClassConfig,
    sqsOps,
    ddbOps,
    ec2Ops,
    usageClass,
    runId
  } = input

  // create ONE pickup manager for all
  const poolPickupManager = new PoolPickUpManager({
    allowedInstanceTypes,
    resourceClass,
    resourceClassConfig,
    sqsOps,
    usageClass
  })

  const requiredCount = input.instanceCount
  const placeholderAry = Array(requiredCount).fill(0)
  const responses = await Promise.allSettled(
    placeholderAry.map((_, ind) => {
      return claimWorker({
        workerNumber: ind,
        poolPickupManager,
        resourceClass,
        ddbOps: {
          instanceOperations: ddbOps.instanceOperations,
          heartbeatOperations: ddbOps.heartbeatOperations,
          workerSignalOperations: ddbOps.workerSignalOperations
        },
        ec2Ops: {
          instanceOperations: ec2Ops.instanceOperations
        },
        runId
      })
    })
  )

  const claimedInstances: Array<Instance> = []
  responses
    .filter((response) => response.status === 'fulfilled')
    .forEach((f) => {
      const payload = f.value.payload
      if (payload) {
        claimedInstances.push(payload)
      }
    })

  const claimedCount = claimedInstances.length
  const numRequired = requiredCount - claimedCount

  core.info('completed selection routine')
  return {
    numInstancesSelected: claimedCount,
    // directly pass instance count for now
    numInstancesRequired: numRequired,
    instances: claimedInstances,
    labels: claimedInstances.map((c) => c.id)
  }
}
