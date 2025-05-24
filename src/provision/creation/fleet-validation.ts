import * as core from '@actions/core'
import type { FleetResult, FleetStates } from '../types.js'
import type { HeartbeatOperations } from '../../services/dynamodb/operations/heartbeat-operations.js'
import { WorkerSignalOperations } from '../../services/dynamodb/operations/signal-operations.js'

export interface FleetValidationInputs {
  fleetResult: FleetResult
  runId: string
  ddbOps: {
    heartbeatOperations: HeartbeatOperations
    workerSignalOperations: WorkerSignalOperations
  }
}

export async function fleetValidation(
  input: FleetValidationInputs
): Promise<FleetStates> {
  core.info('starting fleet validation routine...')
  core.debug(`See fleet validation input: ${JSON.stringify(input.fleetResult)}`)

  const { fleetResult, runId } = input
  const { heartbeatOperations, workerSignalOperations } = input.ddbOps

  let currentStatus = fleetResult.status

  // early invalidation if state is anything but a success
  if (currentStatus !== 'success') {
    core.error(`fleet validation failed: found input.status ${currentStatus}`)
    return 'failed'
  }

  const instanceIds = input.fleetResult.instances.map((instance) => instance.id)

  try {
    currentStatus = await checkWSStatus(
      currentStatus,
      runId,
      instanceIds,
      workerSignalOperations
    )

    currentStatus = await checkHeartbeatStatus(
      currentStatus,
      instanceIds,
      heartbeatOperations
    )

    if (currentStatus !== 'success') {
      currentStatus = 'failed'
    }

    core.info('completed fleet validation routine...')
    return currentStatus
  } catch (error) {
    core.warning(`Error encountered in fleet validation, see error: ${error}`)
    return 'failed'
  }
}

export async function checkWSStatus(
  currentStatus: FleetStates,
  runId: string,
  instanceIds: string[],
  workerOperations: WorkerSignalOperations
): Promise<FleetStates> {
  // 🔍 Guard Clause to exit early if already in failed state
  if (currentStatus !== 'success') {
    core.warning(
      `fleet validation status is not currently success (${currentStatus}), returning failed`
    )
    return 'failed'
  }

  const wsstatus = await workerOperations.pollOnSignal({
    instanceIds,
    runId,
    signal: WorkerSignalOperations.OK_STATUS.UD_REG,
    timeoutSeconds: 3 * 60, // timeout after
    intervalSeconds: 10 // check every
  })

  if (!wsstatus.state) {
    core.error(
      `fleet validation failed: not all instances have booted up to an OK state. See message: ${wsstatus.message}\n`
    )
    currentStatus = 'failed'
  }

  return currentStatus
}

export async function checkHeartbeatStatus(
  currentStatus: FleetStates,
  instanceIds: string[],
  heartbeatOperations: HeartbeatOperations
): Promise<FleetStates> {
  // 🔍 Guard Clause to exit early if already in failed state
  if (currentStatus !== 'success') {
    core.warning(
      `fleet validation status is not currently success (${currentStatus}), returning failed`
    )
    return 'failed'
  }

  const hStatus =
    await heartbeatOperations.areAllInstancesHealthyPoll(instanceIds)

  if (!hStatus.state) {
    core.error(
      `fleet validation failed: not all instances are found healthy within the allocated timeout. See message: ${hStatus.message}\n`
    )
    currentStatus = 'failed'
  }

  return currentStatus
}
