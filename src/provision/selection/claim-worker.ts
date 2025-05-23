import * as core from '@actions/core'
import { PoolPickUpManager } from './pool-pickup-manager.js'
import { Instance } from '../types.js'
import { InstanceOperations as DDBInstanceOperations } from '../../services/dynamodb/operations/instance-operations.js'
import { HeartbeatOperations } from '../../services/dynamodb/operations/heartbeat-operations.js'
import { WorkerSignalOperations } from '../../services/dynamodb/operations/signal-operations.js'
import { InstanceOperations as EC2InstanceOperations } from '../../services/ec2/operations/instance-operations.js'

export interface ClaimWorkerInput {
  workerNumber: number // purely for logging
  resourceClass: string
  poolPickupManager: PoolPickUpManager
  ddbOps: {
    instanceOperations: DDBInstanceOperations
    heartbeatOperations: HeartbeatOperations
    workerSignalOperations: WorkerSignalOperations
  }
  ec2Ops: {
    instanceOperations: EC2InstanceOperations
  }
  runId: string
}

export type ClaimWorkerOutput = Promise<{
  message: string
  payload: Instance | null
}>

export async function claimWorker(input: ClaimWorkerInput): ClaimWorkerOutput {
  const {
    workerNumber: workerNum,
    resourceClass, // for logging
    poolPickupManager,
    ddbOps,
    ec2Ops,
    runId
  } = input

  while (true) {
    const instance: Instance | null = await poolPickupManager.pickup()
    if (!instance) {
      core.info(
        `[CLAIM WORKER ${workerNum}] No instance picked up, returning null...`
      )
      return {
        // ends while loop; ends routine
        message: `Pool (${resourceClass}) found to be "empty". Returning null`,
        payload: null
      }
    }

    // attempt claim, then determine health
    const { id } = instance
    const claimAttempt = await attemptToClaimInstance({
      id,
      runId,
      ddbOps: ddbOps.instanceOperations
    })

    if (!claimAttempt) {
      core.info(
        `[CLAIM WORKER ${workerNum}] Unable to claim instance (${id}). Retrying...`
      )
      continue
    }

    const instanceHealth =
      await ddbOps.heartbeatOperations.isInstanceHealthy(id)
    if (instanceHealth.state !== HeartbeatOperations.HEALTHY) {
      await handleClaimedInstanceExpiry({
        id,
        runId,
        ddbOps: ddbOps.instanceOperations
      })
      core.info(
        `[CLAIM WORKER ${workerNum}] The following instance is unhealthy (${id}). Marked expired. Now retrying...`
      )
      continue
    }

    const instanceWsState = await demandWsRegisteredStatus({
      id,
      runId,
      ddbOps: ddbOps.workerSignalOperations,
      workerNum
    })

    if (!instanceWsState) {
      // nah, straight termination to prevent race conditions (ie. instance picking up job without being accounted for)
      // simply expiring instance would invoke async termination from refresh OR self-termination agent
      // but, both are still too delayed (former happens every ~13-45m, latter every 15s)
      // EC2 TERMINATION && EXPIRY
      await Promise.allSettled([
        ec2Ops.instanceOperations.terminateInstances([id]),
        handleClaimedInstanceExpiry({
          id,
          runId,
          ddbOps: ddbOps.instanceOperations
        })
      ])
      core.info(
        `[CLAIM WORKER ${workerNum}] The following instance does not have required wssignal in time (${id}). Marked expired. Now retrying...`
      )
      continue
    }

    // if reaches end of while condition, return
    core.info(
      `[CLAIM WORKER ${workerNum}] Instance (${id}) is claimed and healthy`
    )
    return {
      message: `Instance (${id}) is claimed and healthy`,
      payload: instance
    }
  }
}

export interface AttemptToClaimInstanceInput {
  id: string
  runId: string
  ddbOps: DDBInstanceOperations
}

export async function attemptToClaimInstance(
  input: AttemptToClaimInstanceInput
): Promise<boolean> {
  const { id, runId, ddbOps } = input
  try {
    const now = Date.now()
    // TODO: Claimed state duration needs to be an input as this is dependent startup of created instances
    const millisecondsToAdd = 5 * 60 * 1000 // (say, claim valid for 5 mins)
    const threshold = new Date(now + millisecondsToAdd).toISOString()

    // then if it fails any any here, that's OK, will recycle
    await ddbOps.instanceStateTransition({
      id,
      expectedRunID: '',
      newRunID: runId,
      expectedState: 'idle',
      newState: 'claimed',
      newThreshold: threshold,
      conditionSelectsUnexpired: true // only unexpired records
    })

    return true
  } catch (e) {
    core.warning(`Failed to claim instance ${id}; See error in transition ${e}`)
    return false
  }
}

// This is done by modifying the threshold to be in the past (say 1 min in past)
// Leaving the claimed state, but emptying the run id
export interface HandleUnhealthyClaimedInstancesInput {
  id: string
  runId: string
  ddbOps: DDBInstanceOperations
}

export async function handleClaimedInstanceExpiry(
  inputs: HandleUnhealthyClaimedInstancesInput
) {
  const { id, runId, ddbOps } = inputs
  try {
    core.info(`Marking claimed instance for termination: (${id})`)

    await ddbOps.expireInstance({
      id,
      runId,
      state: 'claimed'
    })

    core.info(`Successfully marked claimed instance for termination (${id})...`)
  } catch (e) {
    core.warning(
      `Failed to mark instance ${id} for termination. Expect error on release mode - ${e}`
    )
    return false
  }
}

export async function demandWsRegisteredStatus({
  id,
  runId,
  ddbOps,
  workerNum
}: {
  id: string
  runId: string
  ddbOps: WorkerSignalOperations
  workerNum: number
}) {
  const result = await ddbOps.pollOnSignal({
    instanceIds: [id],
    runId,
    signal: WorkerSignalOperations.OK_STATUS.UD_REG,
    timeoutSeconds: 5, // watch this closely if this is too tight
    intervalSeconds: 1
  })

  core.info(
    `[CLAIM WORKER ${workerNum}] For id:(${id}) runId:(${runId}) - ${result.message}`
  )
  return result.state
}
