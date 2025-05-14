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
  ids: string[]
  runId: string
  ddbOps: InstanceOperations
}

export async function handleUnhealthyClaimedInstances(
  inputs: HandleUnhealthyClaimedInstancesInput
) {
  const { ids, runId, ddbOps } = inputs
  const now = Date.now()
  // TODO: Claimed state duration needs to be an input as this is dependent startup of created instances
  const past = new Date(now + -1 * 60 * 1000).toISOString()

  core.info(`Marking unhealthy claimed instances for termination: (${ids})`)
  await Promise.allSettled(
    ids.map((id) =>
      ddbOps.instanceStateTransition({
        id,
        expectedRunID: runId,
        newRunID: '', // important so that refresh does not pick this up
        expectedState: 'claimed',
        newState: 'claimed',
        newThreshold: past, // this allows the refresh grounding mechanism to pickup this id for termination
        conditionSelectsUnexpired: true
      })
    )
  )
  core.info(
    `Successfully marked unhealthy claimed instances for termination...`
  )
}
