import * as core from '@actions/core'
import {
  InstanceItem,
  InstanceOperations
} from '../services/dynamodb/operations/instance-operations.js'
import { WorkerSignalOperations } from '../services/dynamodb/operations/signal-operations.js'
import {
  InstanceMessage,
  ResourceClassConfigOperations
} from '../services/sqs/operations/resource-class-operations.js'
import { ResourceClassConfig } from '../services/types.js'

export interface ReleaseWorkerInputs {
  instanceItem: InstanceItem
  resourceClassConfig: ResourceClassConfig
  runId: string
  ddbOps: {
    instanceOperations: InstanceOperations
    workerSignalOperations: WorkerSignalOperations
  } // for marking instance for termination
  sqsOps: ResourceClassConfigOperations // for releasing singular id to the pool
  workerNum: number
}

// release worker for safe sending to pool!
export async function releaseWorker(inputs: ReleaseWorkerInputs) {
  const {
    instanceItem,
    resourceClassConfig,
    runId,
    ddbOps,
    sqsOps,
    workerNum
  } = inputs
  const instanceId = instanceItem.identifier
  core.info(
    `[WORKER ${workerNum}]Starting release worker routine. Responsible for safely releasing id ${instanceId}...`
  )

  // Firstly, observe a specific ws signal (removal of registration)
  const demandedSignal = WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG
  const result = await ddbOps.workerSignalOperations.pollOnSignal({
    instanceIds: [instanceId],
    runId,
    signal: demandedSignal,
    timeoutSeconds: 60, // allow for 1min, this is long so that on the job get-item for blockInvalidation is long as well (cpu usage minimal when running jobs)
    intervalSeconds: 5
  })

  if (result.state === true) {
    // still OK, hence OK to be placed in the pool
    const instanceMessage: InstanceMessage = {
      id: instanceId,
      resourceClass: instanceItem.resourceClass,
      instanceType: instanceItem.instanceType,
      cpu: resourceClassConfig[instanceItem.resourceClass].cpu,
      mmem: resourceClassConfig[instanceItem.resourceClass].mmem
    }
    await sqsOps.sendResourceToPool(instanceMessage, resourceClassConfig)
    core.info(
      `[WORKER ${workerNum}] Has now safely sent ${instanceId} to ${instanceItem.resourceClass} pool`
    )
  } else {
    core.warning(
      `[WORKER ${workerNum}] Unable to find the demanded signal ${demandedSignal} for ${instanceId}. See reason: ${result.message}`
    )
    core.warning(`[WORKER ${workerNum}] Marking ${instanceId} for expiration`)
    await ddbOps.instanceOperations.expireInstance({
      id: instanceId,
      runId,
      state: null
    })
  }

  core.info(`[WORKER ${workerNum}] Release worker routine completed.`)
}
