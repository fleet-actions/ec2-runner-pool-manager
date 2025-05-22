import * as core from '@actions/core'
import type { FleetResult, FleetStates } from '../types.js'
import type { HeartbeatOperations } from '../../services/dynamodb/operations/heartbeat-operations.js'
import { WorkerSignalOperations } from '../../services/dynamodb/operations/signal-operations.js'

export interface FleetValidationInputs {
  fleetResult: FleetResult
  runId: string
  ddbOps: {
    // bootstrapOperations: BootstrapOperations
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
    // currentStatus = await checkBootstrapStatus(
    //   currentStatus,
    //   instanceIds,
    //   bootstrapOperations
    // )

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

// export async function checkBootstrapStatus(
//   currentStatus: FleetStates,
//   instanceIds: string[],
//   bootstrapOperations: BootstrapOperations
// ): Promise<FleetStates> {
//   // 🔍 Guard Clause to exit early if already in failed state
//   if (currentStatus !== 'success') {
//     core.warning(
//       `fleet validation status is not currently success (${currentStatus}), returning failed`
//     )
//     return 'failed'
//   }

//   const bStatus = await bootstrapOperations.areAllInstancesCompletePoll(
//     instanceIds,
//     3 * 60, // check for 3 mins, to determine reasonable timeout, define your ami startup time
//     10 // check every 10s
//   )

//   if (!bStatus.state) {
//     core.error(
//       `fleet validation failed: not all instances have bootstrapped successfully. See message: ${bStatus.message}\n`
//     )
//     currentStatus = 'failed'
//   }

//   return currentStatus
// }

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

  const wsstatus = await workerOperations.pollUntilAllInstancesComplete(
    instanceIds,
    runId,
    3 * 60, // check for 3 mins, to determine reasonable timeout, dependent on inputted userdata + ami OS loading
    10 // check every 10s
  )

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
