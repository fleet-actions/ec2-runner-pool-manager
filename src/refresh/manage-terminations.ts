import * as core from '@actions/core'
import {
  InstanceOperations as DDBInstanceOperations,
  InstanceItem
} from '../services/dynamodb/operations/instance-operations.js'
import { InstanceOperations as EC2InstanceOperations } from '../services/ec2/operations/instance-operations.js'
import { HeartbeatOperations } from '../services/dynamodb/operations/heartbeat-operations.js'
import { BootstrapOperations } from '../services/dynamodb/operations/bootstrap-operations.js'

export interface ManageTerminationsInputs {
  ddbOps: {
    instanceOperations: DDBInstanceOperations
    heartbeatOperations: HeartbeatOperations
    bootstrapOperations: BootstrapOperations
  }
  ec2Ops: EC2InstanceOperations
}

/**
 * GET ALL EXPIRED INSTANCES OF NON-TERMINATED STATES
 * -> TRY TO TRANSITION THEM TO TERMINATED
 * -> ANY SUCCESSFUL TRANSITIONS ARE AWS EC2 TERMINATED
 */
export async function manageTerminations(input: ManageTerminationsInputs) {
  core.info('Performing instance terminations...')

  const { ddbOps, ec2Ops } = input
  const { instanceOperations, heartbeatOperations, bootstrapOperations } =
    ddbOps

  // 🔍 Only fetch non-terminated instances
  const items = await instanceOperations.getExpiredInstancesByStates([
    'idle',
    'claimed',
    'running'
  ])

  // With fetched items, we can then perform state transitions (state expected-any => terminated; runId expected-any => '')
  const { successfulItems, unsuccessfulItems } =
    await performTerminationTransitions(items, instanceOperations)

  logInstanceTerminationDiagnostics(items, successfulItems, unsuccessfulItems)

  const ids = successfulItems.map((item) => item.identifier)

  if (ids.length > 0) {
    await sendTerminationSignals(ids, ec2Ops)

    const timeoutSeconds = process.env.NODE_ENV === 'test' ? 1 : 10
    core.info(`Awaiting for ${timeoutSeconds}s before cleaning up db`)
    await new Promise((resolve) => setTimeout(resolve, timeoutSeconds * 1000))

    core.info(`Cleaning artifacts in db for ids terminated ids`)
    await performArtifactCleanup({
      ids,
      heartbeatOperations,
      bootstrapOperations
    })
  } else {
    core.info(`No instances marekd for termination`)
  }

  core.info('Completed instance terminations...')
}

export async function performTerminationTransitions(
  instanceItems: InstanceItem[],
  ddbOps: DDBInstanceOperations
): Promise<{
  successfulItems: InstanceItem[]
  unsuccessfulItems: InstanceItem[]
}> {
  const response = await Promise.allSettled(
    instanceItems.map((item) =>
      ddbOps.instanceTermination({
        id: item.identifier,
        // 🔍 These are to guard against concurrent operations
        expectedState: item.state,
        expectedRunID: item.runId
      })
    )
  )

  const successfulItems: InstanceItem[] = []
  const unsuccessfulItems: InstanceItem[] = []

  response.forEach((resp, ind) => {
    if (resp.status === 'fulfilled') {
      successfulItems.push(instanceItems[ind])
    } else {
      unsuccessfulItems.push(instanceItems[ind])
    }
  })

  return { successfulItems, unsuccessfulItems }
}

export function logInstanceTerminationDiagnostics(
  allItems: InstanceItem[],
  successfulItems: InstanceItem[],
  unsuccessfulItems: InstanceItem[]
): void {
  // Count instances by state
  const stateCount = allItems.reduce((acc: Record<string, number>, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1
    return acc
  }, {})

  core.info('--- Instance Termination Diagnostics ---')
  core.info(
    `Num of instances initially marked for termination: ${allItems.length}`
  )
  core.info(`By state: ${JSON.stringify(stateCount)}`)
  core.info(`Successful transitions: ${successfulItems.length}`)
  core.info(`Failed transitions: ${unsuccessfulItems.length}`)

  // Log detailed information about successful items
  if (successfulItems.length > 0) {
    core.info('Detailed information about successful transitions:')
    for (const item of successfulItems) {
      core.info(
        `  - ID: ${item.identifier}, State: ${item.state}, RunID: ${item.runId || 'none'}`
      )
    }
  }

  // Log detailed information about unsuccessful items if any
  if (unsuccessfulItems.length > 0) {
    core.info('Detailed information about failed transitions:')
    for (const item of unsuccessfulItems) {
      core.info(
        `  - ID: ${item.identifier}, State: ${item.state}, RunID: ${item.runId || 'none'}`
      )
    }
  }
  core.info('---------------------------------------')
}

export interface PerformArtifactCleanupInput {
  ids: string[]
  heartbeatOperations: HeartbeatOperations
  bootstrapOperations: BootstrapOperations
}

export async function performArtifactCleanup(
  inputs: PerformArtifactCleanupInput
) {
  const { ids, heartbeatOperations, bootstrapOperations } = inputs
  core.info(`Performing artifact cleanup (heartbeat; bootstrap) for ${ids}`)
  await Promise.allSettled(ids.map((id) => heartbeatOperations.deleteItem(id)))
  await Promise.allSettled(
    ids.map(async (id) => bootstrapOperations.deleteItem(id))
  )
  core.info(`Completed artifact cleanup`)
}

// NOTE: on high usage, this may be subject to API rate limits
// This separation is needed to guarantee that termination signals are sent to all picked up instances
// It is possible that some instance ids picked up from the db are invalidated due to time picked up.
// This is because if a refresh is highly delayed (say hours), the aws ec2 terminate-instances API does not send ANY signals
// For instances with ids registered for your account.
// But this guarantees proper refresh for all instances
export async function sendTerminationSignals(
  ids: string[],
  ec2Ops: EC2InstanceOperations
) {
  try {
    // TRY: single termination signal for multiple ids
    core.info(`Sending termination signals to the following instances: ${ids}`)
    await ec2Ops.terminateInstances(ids)
  } catch (error) {
    // IF: that fails, send termination signals separately
    core.warning(`See error: ${(error as Error).message}`)
    core.warning(
      `Unable to send termination signals to ids in a batch. Sending one by one...`
    )
    const responses = await Promise.allSettled(
      ids.map((id) => ec2Ops.terminateInstances([id]))
    )
    responses.forEach((response, ind) => {
      if (response.status === 'fulfilled') {
        core.info(
          `Successfully sent indiviual termination signal to: ${ids[ind]}`
        )
      } else {
        core.info(
          `Failed to send signal to: ${ids[ind]}; Instance likely no longer exist in aws account`
        )
      }
    })
  } finally {
    core.info(`Termination signals sent...`)
  }
}
