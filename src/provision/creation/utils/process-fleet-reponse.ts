import * as core from '@actions/core'
import type { CreateFleetCommandOutput } from '@aws-sdk/client-ec2'
import type { FleetResult, Instance } from '../../types.js'

/**
 * Processes a fleet response, extracting instance IDs and determining status.
 * Handles error logging and status determination.
 */
export interface ProcessFleetResponseInput {
  response: CreateFleetCommandOutput
  resourceClass: string
  cpu: number
  mmem: number
  targetCapacity: number
}

export function processFleetResponse(
  input: ProcessFleetResponseInput
): FleetResult {
  const { response, resourceClass, targetCapacity } = input
  const UNKNOWN_TYPE = 'UKNOWN_TYPE'
  const instances: Instance[] = []

  // Pair instance ids with with instance types
  if (response.Instances?.length) {
    response.Instances.forEach((instanceSet) => {
      const instanceType = instanceSet.InstanceType || UNKNOWN_TYPE
      const instancesIds = instanceSet.InstanceIds
        ? [...instanceSet.InstanceIds]
        : []

      if (instanceType === UNKNOWN_TYPE && instancesIds.length > 0)
        core.warning(
          `Warning: Instance ids have been launched with unknown type: ${instancesIds}`
        )

      instances.push(
        ...instancesIds.map((id) => ({
          id,
          instanceType,
          resourceClass,
          cpu: input.cpu,
          mmem: input.mmem
        }))
      )
    })
  }

  const numLaunched = instances.length

  // Log any errors
  if (response.Errors?.length) {
    core.warning(`Fleet attempt encountered ${response.Errors.length} errors:`)
    response.Errors.forEach((error) => {
      // Extract useful override details if available
      const overrideInfo = error.LaunchTemplateAndOverrides?.Overrides
        ? ` [SubnetId: ${error.LaunchTemplateAndOverrides.Overrides.SubnetId}]`
        : ''
      core.warning(
        `Error: ${error.ErrorCode} - ${error.ErrorMessage}${overrideInfo}`
      )
    })
  }

  // Determine status
  let status: 'success' | 'partial' | 'failed'
  if (numLaunched === targetCapacity) {
    status = 'success'
    core.info(`Successfully launched all ${targetCapacity} instances`)
  } else if (numLaunched > 0) {
    status = 'partial'
    core.warning(
      `Partially launched ${numLaunched}/${targetCapacity} instances`
    )
  } else {
    status = 'failed'
    core.error(`Failed to launch any instances`)
  }

  if (numLaunched > 0) {
    core.info(`${JSON.stringify(instances, null, ' ')}`)

    // 📝 More gracefully handle UNKNOWN_TYPE launches in the future. For simplicity, fail the fleet launch
    const anyUnknown = instances.some(
      (instance) => instance.instanceType === UNKNOWN_TYPE
    )
    if (anyUnknown) {
      core.warning(
        'As atleast once instance launched with an unknown instance type, the fleet is marked for a failed launch'
      )
      status = 'failed'
    }
  }

  return {
    instances,
    status
  }
}
