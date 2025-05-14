import * as core from '@actions/core'
import { PoolPickUpManager } from './pool-pickup-manager.js'
import { Instance } from '../types.js'
import { InstanceOperations } from '../../services/dynamodb/operations/instance-operations.js'
import { HeartbeatOperations } from '../../services/dynamodb/operations/heartbeat-operations.js'

export interface ClaimWorkerInput {
  workerNumber: number // purely for logging
  resourceClass: string
  poolPickupManager: PoolPickUpManager
  ddbOps: {
    instanceOperations: InstanceOperations
    heartbeatOperations: HeartbeatOperations
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
      core.info(
        `[CLAIM WORKER ${workerNum}] The following instance is unhealthy (${id}). Retrying...`
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
  ddbOps: InstanceOperations
}

export async function attemptToClaimInstance(
  input: AttemptToClaimInstanceInput
): Promise<boolean> {
  const { id, runId, ddbOps } = input
  try {
    const now = Date.now()
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
