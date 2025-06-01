import * as core from '@actions/core'
import { Instance, SelectionOutput } from '../types.js'
import { InstanceOperations } from '../../services/dynamodb/operations/instance-operations.js'
import { ResourceClassConfigOperations } from '../../services/sqs/operations/resource-class-operations.js'
import { ResourceClassConfig } from '../../services/types.js'

export interface ProcessFailedProvisionInput {
  selectionOutput: SelectionOutput
  // creationOutput: CreationOuput, // 🔍 Excluded as creation outputs are not needed here; Already terminated
  idleTimeSec: number
  resourceClassConfig: ResourceClassConfig
  runId: string
  ddbOps: InstanceOperations // 🔍 state transition (claimed -> idle) for selected resources
  sqsOps: ResourceClassConfigOperations // 🔍 re-queue to respective pools
}

// 🔍 release any locked resources from the selection stage for usage by other jobs
export async function processFailedProvision(
  input: ProcessFailedProvisionInput
) {
  core.info('starting process failed provision routine...')
  core.warning(
    `received: ${JSON.stringify({ ...input, resourceClassConfig: '', ddbOps: '', sqsOps: '' })}`
  )

  const {
    selectionOutput,
    idleTimeSec,
    runId,
    ddbOps,
    sqsOps,
    resourceClassConfig
  } = input

  if (selectionOutput.instances.length === 0) {
    core.info('Completed; no selected instances to proess')
    return
  }

  await attemptToReleaseInstances({
    instances: selectionOutput.instances,
    runId,
    idleTimeSec,
    ddbOps
  })

  // .(💡 Ideally sqs termination for queue termination testing and cleanup - ie. sqs interaction)
  // 🔍 Here, it means all intance ids have been state transitioned, time to re-distribute selected instances in to the pool

  const response = await sqsOps.sendResourcesToPools(
    selectionOutput.instances.map((instance) => ({
      id: instance.id,
      resourceClass: instance.resourceClass,
      instanceType: instance.instanceType,
      cpu: instance.cpu,
      mmem: instance.mmem,
      usageClass: instance.usageClass
    })),
    resourceClassConfig
  )

  if (response.failed.length !== 0) {
    core.warning('failed to gracefully redistribute certain instances to queue')
    core.warning(`See failed: ${JSON.stringify(response.failed, null, ' ')}`)
    throw new Error('Failed to send selected resources back to pool :(')
  }

  core.info('compled process failed provision routine...')
}

export interface AttemptToReleaseInstancesInput {
  idleTimeSec: number
  runId: string
  instances: Instance[]
  ddbOps: InstanceOperations
}

// throws exception as needed
export async function attemptToReleaseInstances(
  input: AttemptToReleaseInstancesInput
) {
  const { idleTimeSec, runId, instances, ddbOps } = input
  const now = Date.now()
  const millisecondsToAdd = idleTimeSec * 1000 // 🔍 s to ms
  const threshold = new Date(now + millisecondsToAdd).toISOString()

  // 🔍 selection release: ddb-release & sqs-repool (📝 NOTE: revalidation is done on pickup anyway)
  // 🔍 will error out on any failures
  await Promise.all(
    instances.map((instance) => {
      return ddbOps.instanceStateTransition({
        id: instance.id,
        expectedRunID: runId,
        newRunID: '', // On release, ins belongs to no run
        expectedState: 'claimed',
        newState: 'idle',
        newThreshold: threshold,
        conditionSelectsUnexpired: true
      })
    })
  )
}
