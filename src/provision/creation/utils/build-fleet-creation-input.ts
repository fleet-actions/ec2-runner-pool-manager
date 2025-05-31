import type {
  CreateFleetCommandInput,
  FleetLaunchTemplateOverridesRequest,
  FleetLaunchTemplateSpecificationRequest,
  InstanceRequirementsRequest,
  SpotOptionsRequest,
  TagSpecification,
  Tag,
  TargetCapacitySpecificationRequest,
  UsageClassType
} from '@aws-sdk/client-ec2'

// --- Build Helper Functions ---

/**
 * Builds the instance requirements for EC2 Fleet based on CPU and memory specs.
 */
export function buildInstanceRequirements(
  resourceSpec: { cpu: number; mmem: number },
  allowedInstanceTypes: string[]
): InstanceRequirementsRequest {
  return {
    VCpuCount: {
      Min: resourceSpec.cpu,
      Max: resourceSpec.cpu // Exact vCPU match
    },
    MemoryMiB: {
      Min: resourceSpec.mmem // Minimum memory in MiB
    },
    AllowedInstanceTypes: allowedInstanceTypes,
    BurstablePerformance: 'excluded'
  }
}

/**
 * Builds the fleet overrides list with instance requirements for each subnet.
 */
export function buildFleetOverrides(
  subnetIds: string[],
  resourceSpec: { cpu: number; mmem: number },
  allowedInstanceTypes: string[]
): FleetLaunchTemplateOverridesRequest[] {
  const requirements = buildInstanceRequirements(
    resourceSpec,
    allowedInstanceTypes
  )
  return subnetIds.map((subnetId) => ({
    SubnetId: subnetId,
    InstanceRequirements: requirements
  }))
}

/**
 * Builds the target capacity specification for the fleet.
 */
export function buildTargetCapacitySpecification({
  instanceCount,
  usageClass
}: {
  instanceCount: number
  usageClass: UsageClassType
}): TargetCapacitySpecificationRequest {
  if (usageClass === 'on-demand') {
    return {
      TotalTargetCapacity: instanceCount,
      DefaultTargetCapacityType: 'on-demand',
      OnDemandTargetCapacity: instanceCount
    }
  } else if (usageClass === 'spot') {
    return {
      TotalTargetCapacity: instanceCount,
      DefaultTargetCapacityType: 'spot',
      SpotTargetCapacity: instanceCount
    }
  } else {
    throw new Error(`invalid usage class ${usageClass}`)
  }
}

/**
 * Configures Spot instance options for the fleet.
 */
export function buildSpotOptions(): SpotOptionsRequest {
  // https://aws.amazon.com/blogs/compute/introducing-price-capacity-optimized-allocation-strategy-for-ec2-spot-instances/
  // 📝 'lowest-price' ideal esp for testing spot-terminated instances
  // 📝 'price-capacity-optimized' for release
  return {
    AllocationStrategy: 'price-capacity-optimized'
  }
}

/**
 * Creates tag specifications for the fleet resources.
 */
export function buildFleetTagSpecifications({
  uniqueId,
  runId
}: {
  uniqueId: string
  runId: string
}): TagSpecification[] {
  const fleetTags: Tag[] = [
    { Key: 'Name', Value: `ec2-runner-pool-fleet-${uniqueId}` },
    { Key: 'Purpose', Value: 'RunnerPoolProvisioning' }
  ]
  const instanceTags: Tag[] = [
    { Key: 'AllowSelfTermination', Value: 'true' },
    { Key: 'InitialRunId', Value: runId }
  ]
  return [
    { ResourceType: 'fleet', Tags: fleetTags },
    { ResourceType: 'instance', Tags: instanceTags }
  ]
}

/**
 * Assembles the complete CreateFleetCommandInput with all necessary parameters.
 */
export interface BuildFleetCreationInput {
  launchTemplateName: string
  subnetIds: string[]
  resourceSpec: { cpu: number; mmem: number }
  allowedInstanceTypes: string[]
  targetCapacity: number
  uniqueId: string
  runId: string
  usageClass: UsageClassType
}

export function buildFleetCreationInput(
  input: BuildFleetCreationInput
): CreateFleetCommandInput {
  const {
    launchTemplateName,
    subnetIds,
    resourceSpec,
    allowedInstanceTypes,
    targetCapacity,
    uniqueId,
    runId,
    usageClass
  } = input
  // https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-ec2/Interface/FleetLaunchTemplateSpecificationRequest/
  const launchTemplateSpecification: FleetLaunchTemplateSpecificationRequest = {
    LaunchTemplateName: launchTemplateName,
    Version: '$Default'
  }

  const overrides = buildFleetOverrides(
    subnetIds,
    resourceSpec,
    allowedInstanceTypes
  )

  const targetCapacitySpec = buildTargetCapacitySpecification({
    instanceCount: targetCapacity,
    usageClass
  })
  const tagSpecifications = buildFleetTagSpecifications({ uniqueId, runId })

  const fleetInput: CreateFleetCommandInput = {
    LaunchTemplateConfigs: [
      {
        LaunchTemplateSpecification: launchTemplateSpecification,
        Overrides: overrides
      }
    ],
    TargetCapacitySpecification: targetCapacitySpec,
    Type: 'instant', // 'instant' for synchronous response with instance IDs
    TagSpecifications: tagSpecifications,
    ClientToken: uniqueId // For idempotency
  }

  if (usageClass !== 'on-demand') {
    fleetInput.SpotOptions = buildSpotOptions()
  }

  return fleetInput
}
