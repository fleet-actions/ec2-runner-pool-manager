import * as core from '@actions/core'
import { buildFleetCreationInput } from './utils/build-fleet-creation-input.js' // Import the utility functions
import { processFleetResponse } from './utils/process-fleet-reponse.js'
import type { FleetResult } from '../types.js'
import type { LTDatav2, ResourceSpec } from '../../services/types.js'
import type { FleetOperations } from '../../services/ec2/operations/fleet-operations.js'

export interface FleetCreationInput {
  launchTemplate: LTDatav2
  subnetIds: string[]
  resourceSpec: ResourceSpec
  resourceClass: string
  allowedInstanceTypes: string[]
  numInstancesRequired: number
  ec2Ops: FleetOperations
  runId: string
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
    runId
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
      runId
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
      ...input.resourceSpec, // cpu, mmem
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

  core.info('Completed fleet creation routine.')
  return result
}
