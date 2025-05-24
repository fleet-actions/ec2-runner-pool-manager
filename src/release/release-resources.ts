import * as core from '@actions/core'
import { transitionToIdle } from './transition-to-idle.js'
import {
  InstanceOperations,
  InstanceStates,
  InstanceItem
} from '../services/dynamodb/operations/instance-operations.js'
import type { ResourceClassConfigOperations as SQSRcc } from '../services/sqs/operations/resource-class-operations.js'
import { ResourceClassConfig } from '../services/types.js'
import { releaseWorker } from './release-workers.js'
import { WorkerSignalOperations } from '../services/dynamodb/operations/signal-operations.js'

// 🔍 Release routine.
// 1. Get all instance ids under run id
// 2. Release instances (transition from 'running' to 'idle') + isolation checks
// 3. For successful transitions - we call the release worker on them
// 4. For unsuccessful transitions - we DO NOT call the release worker on them (ignored)
// 5. core.error - only on idle instances do we call core.error
// 📝 More graceful handling of instances found with runId but are claimed
// 📝 More graceful handling of instances that were not transitioned correctly (ie. failed on the instance transition)
// 📝 By this, I mean that sucessful resources should still be released, but that we collect messages and if those messages are not empty, we core.setFailed to make them visible

export interface ReleaseResourcesInput {
  resourceClassConfig: ResourceClassConfig
  runId: string
  idleTimeSec: number
  ddbOps: {
    instanceOperations: InstanceOperations
    workerSignalOperations: WorkerSignalOperations
  }
  sqsOps: SQSRcc
}

// Refactored main function
export async function releaseResources(input: ReleaseResourcesInput) {
  core.info('Starting release resources routine...')
  const { runId, idleTimeSec, resourceClassConfig, ddbOps, sqsOps } = input
  const errorMessages: string[] = []

  // Get and classify instances
  const instances = await ddbOps.instanceOperations.getInstancesByRunId(runId)
  const classified = classifyInstancesByState(instances)

  if (instances.length === 0) {
    core.warning(`No instances were found to release...`)
    core.debug(`No instances were found with runId: ${runId}`)
    return
  }

  core.info(
    `See classified instances:\n${Object.entries(classified)
      .map(([k, v]) => {
        return `- ${k}: ${v.map((v) => v.identifier)}`
      })
      .join('\n')}`
  )

  // GATHER FOR REPORTING
  const invalidStates: InstanceStates[] = ['idle']
  for (const state of invalidStates) {
    if (classified[state].length > 0) {
      const ids = classified[state].map((i) => i.identifier)
      const message = `Found instances with runId ${runId} that are in '${state}' state: ${ids.join(', ')}`
      errorMessages.push(message)
      core.warning(message)
    }
  }

  // Process ONLY 'running' instances
  const { successful, unsuccessful } = await transitionToIdle(
    classified.running,
    runId,
    idleTimeSec,
    ddbOps.instanceOperations
  )

  // Handle unsuccessful transitions
  if (unsuccessful.length > 0) {
    const successfulIds = successful.map((i) => i.identifier)
    const unsuccessfulIds = unsuccessful.map((i) => i.identifier)
    const message = `The ids: (${unsuccessfulIds}) failed to transition from running to idle. We are only releasing the following ids: (${successfulIds})`
    errorMessages.push(message)
    core.warning(message)
  }

  // Continue with releasing successful instances even if there were errors
  if (successful.length > 0) {
    core.info(
      `Releasing ${successful.length} successfully transitioned instances. Now performing safe release...`
    )
    await Promise.allSettled(
      successful.map((instance, ind) => {
        return releaseWorker({
          instanceItem: instance,
          resourceClassConfig,
          runId,
          ddbOps,
          sqsOps,
          workerNum: ind
        })
      })
    )
  }

  // Instead of setting failures on presence of failures, I think OK with just setting release to always 'succeed'
  if (errorMessages.length > 0) {
    core.error(`Release completed with errors 😬:\n${errorMessages.join('\n')}`)
  } else {
    core.info('Release completed successfully 🎉')
  }
}

// Extract instance classification to a separate function
function classifyInstancesByState(
  instances: InstanceItem[]
): Record<InstanceStates, InstanceItem[]> {
  const classified: Record<InstanceStates, InstanceItem[]> = {
    idle: [],
    running: [],
    claimed: [],
    terminated: [],
    created: []
  }

  instances.forEach((instance) => {
    classified[instance.state].push(instance)
    logInstanceState(instance)
  })

  return classified
}

// Extract logging logic
function logInstanceState(instance: InstanceItem): void {
  const { identifier: id, state } = instance
  core.info(`Informative Log: ID (${id}) has a state of ${state}...`)

  if (state === 'running') {
    core.info(
      `✅ Found as 'running' - this is as expected and marked for release`
    )
  } else if (state === 'terminated') {
    core.info(`✅ Found as 'terminated' - this is OK, no further actions `)
  } else if (state === 'created') {
    core.info(
      `✅ Found as 'created' - This could indicate failed 'created' instances on provision-creation. That is OK - no further actions.`
    )
  } else if (state === 'claimed') {
    core.warning(
      `✅ Found as 'claimed' - This could indicate failed 'claimed' instances on provision-selection. That is OK - no further actions.`
    )
  } else if (state === 'idle') {
    core.info(
      `❌ Found as 'idle' - idle instances should not be found with a runId. Release will be marked for warning`
    )
  }
}
