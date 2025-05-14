import * as core from '@actions/core'
import { SelectionOutput, CreationOuput } from '../types.js'
import { InstanceOperations } from '../../services/dynamodb/operations/instance-operations.js'

export interface ProcessSuccessfulProvisionInputs {
  selectionOutput: SelectionOutput
  creationOutput: CreationOuput
  maxRuntimeMin: number
  runId: string
  ddbOps: InstanceOperations
}

// 🔍 Creates the output interface th t other jobs are able to pick up
// 🔍 Also, registers created instances (as-locked) in to ddb
export async function processSuccessfulProvision(
  input: ProcessSuccessfulProvisionInputs
) {
  core.info('starting compose action outputs routine...')
  core.debug(`received ${JSON.stringify({ ...input, ddbOps: '' })}`)

  await processCreatedInstances(input)
  await processSelectedInstances(input)
  await outputIdsForDistribution(input)

  // ✅ OK to proceed to next job from here
  core.info('completing compose action outputs routine...')
}

export interface ProcessCreatedInstancesInput {
  creationOutput: CreationOuput
  maxRuntimeMin: number
  runId: string
  ddbOps: InstanceOperations
}

// 🔍 Register created instances as running
export async function processCreatedInstances(
  input: ProcessCreatedInstancesInput
) {
  core.info('Processing created instances...')
  core.debug(`Recevied: ${JSON.stringify({ ...input, ddbOps: '' })}`)
  const { creationOutput, maxRuntimeMin, runId, ddbOps } = input

  const now = Date.now()
  const millisecondsToAdd = maxRuntimeMin * 60 * 1000
  const threshold = new Date(now + millisecondsToAdd).toISOString()

  // 🔍 usage of .all here to throw
  await Promise.all(
    creationOutput.instances.map(async (instance) => {
      return ddbOps.instanceRegistration({
        id: instance.id,
        runId,
        threshold,
        resourceClass: instance.resourceClass,
        instanceType: instance.instanceType
      })
    })
  )

  core.info('Finished processing created instances...')
}

export interface ProcessSelectedInstancesInput {
  selectionOutput: SelectionOutput
  maxRuntimeMin: number
  runId: string
  ddbOps: InstanceOperations
}

// 🔍 Selected instances transitioned from claimed to running
export async function processSelectedInstances(
  input: ProcessSelectedInstancesInput
) {
  core.info('Processing selected instances...')
  core.debug(`Recevied: ${JSON.stringify({ ...input, ddbOps: '' })}`)
  const { selectionOutput, maxRuntimeMin, runId, ddbOps } = input

  const now = Date.now()
  const millisecondsToAdd = maxRuntimeMin * 60 * 1000
  const threshold = new Date(now + millisecondsToAdd).toISOString()

  // transition instances from claimed to running
  await Promise.all(
    selectionOutput.instances.map(async (instance) => {
      return ddbOps.instanceStateTransition({
        id: instance.id,
        expectedRunID: runId,
        newRunID: runId,
        expectedState: 'claimed',
        newState: 'running',
        newThreshold: threshold,
        conditionSelectsUnexpired: true
      })
    })
  )

  core.info('Finished processing selected instances...')
}

export interface OutputIdsForDistributionInput {
  selectionOutput: SelectionOutput
  creationOutput: CreationOuput
}

// 🔍 Instances are outputted from job, omg finally
export async function outputIdsForDistribution(
  input: OutputIdsForDistributionInput
) {
  core.info('Outputting any selected & created instances...')
  const { selectionOutput, creationOutput } = input
  const instanceIds = selectionOutput.instances
    .map((i) => i.id)
    .concat(creationOutput.instances.map((i) => i.id))

  // 🔍 ids for arrayed output (multiple instance usage)
  // 🔍 id for convenience (single instance usage)
  core.setOutput('ids', instanceIds)
  core.setOutput('id', instanceIds[0])
  core.info(`Completed! Ids now accessible. See ids: ${instanceIds}`)
}
