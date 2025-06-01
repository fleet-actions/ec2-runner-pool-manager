import * as core from '@actions/core'
import { buildFleetCreationInput } from './utils/build-fleet-creation-input.js' // Import the utility functions
import { processFleetResponse } from './utils/process-fleet-reponse.js'
import type { FleetResult } from '../types.js'
import type { LTDatav2, ResourceSpec } from '../../services/types.js'
import type { FleetOperations } from '../../services/ec2/operations/fleet-operations.js'
import { InstanceOperations } from '../../services/dynamodb/operations/instance-operations.js'
import { UsageClassType } from '@aws-sdk/client-ec2'

export interface FleetCreationInput {
  launchTemplate: LTDatav2
  subnetIds: string[]
  resourceSpec: ResourceSpec
  resourceClass: string
  allowedInstanceTypes: string[]
  numInstancesRequired: number
  ec2Ops: FleetOperations
  ddbOps: InstanceOperations
  runId: string
  usageClass: UsageClassType
}

export type MakeFleetAttemptInput = Omit<
  FleetCreationInput,
  'numInstancesRequired'
>

/**
 * Makes a single fleet creation attempt.
 * This function focuses ONLY on making the API call with proper parameters.
 */
export async function makeFleetAttempt(
  input: MakeFleetAttemptInput,
  targetCapacity: number,
  attemptNumber: number = 1
): Promise<FleetResult> {
  const {
    launchTemplate,
    resourceClass,
    subnetIds,
    resourceSpec,
    allowedInstanceTypes,
    runId,
    usageClass
  } = input

  if (!launchTemplate.name)
    throw new Error(
      'launch template name not set, abandoning fleet creation attempt...'
    )
  core.info(
    `Making fleet attempt ${attemptNumber} for ${targetCapacity} instances...`
  )

  try {
    // 1. Build the fleet request parameters
    const uniqueId = Date.now().toString()
    const fleetInput = buildFleetCreationInput({
      launchTemplateName: launchTemplate.name,
      subnetIds,
      resourceSpec,
      allowedInstanceTypes,
      targetCapacity,
      uniqueId,
      usageClass,
      runId // still sending initialRunId to ec2 instance tags. This for WS UD signals
    })

    core.debug(
      `Fleet attempt ${attemptNumber} input: ${JSON.stringify(fleetInput)}`
    )

    // 2. Use FleetOperations to make the API call
    // Assuming ec2Client is available from input or a service provider
    const response = await input.ec2Ops.createFleet(fleetInput)

    core.info(`Fleet attempt ${attemptNumber} response received`)
    core.info(`Response: ${JSON.stringify(response)}`)

    // 3. Process the response
    const fleetResponse = processFleetResponse({
      ...resourceSpec, // cpu, mmem
      usageClass,
      response,
      resourceClass,
      targetCapacity
    })

    return fleetResponse
  } catch (error) {
    core.error(`Fleet attempt ${attemptNumber} API error: ${error}`)
    return {
      instances: [],
      status: 'failed'
    }
  }
}

/**
 * Main fleet creation function.
 * This can be expanded to include retry logic later.
 */

export async function fleetCreation(
  input: FleetCreationInput
): Promise<FleetResult> {
  core.info('Starting fleet creation routine...')
  // 📝 Logical space allowed for fleet creation retries; 1 for now
  // .If retries are implemented, num instances required can be changed as needed
  const attemptNumber = 1
  const result = await makeFleetAttempt(
    input,
    input.numInstancesRequired,
    attemptNumber
  )

  if (result.status === 'success') {
    core.info('creation is a success, registering creation on db...')

    const now = Date.now()
    const millisecondsToAdd = 10 * 60 * 1000 // 🔍 s to ms
    const threshold = new Date(now + millisecondsToAdd).toISOString()

    const values = await Promise.all(
      result.instances.map((instance) => {
        return input.ddbOps.instanceCreatedRegistration({
          id: instance.id,
          runId: input.runId,
          resourceClass: instance.resourceClass,
          instanceType: instance.instanceType,
          usageClass: instance.usageClass,
          threshold
        })
      })
    )

    // Check if any registrations failed
    const failedInstances = result.instances.filter(
      (_, index) => !values[index]
    )

    if (failedInstances.length > 0) {
      // Update status to failed if any registrations failed
      result.status = 'failed'

      // Log the failed instance IDs
      core.debug(
        `Failed to register instances: ${failedInstances.map((instance) => instance.id).join(', ')}`
      )
    }
  }

  core.info('Completed fleet creation routine.')
  return result
}
