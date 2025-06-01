import { buildFleetCreationInput } from '../../../../src/provision/creation/utils/build-fleet-creation-input'
import type { BuildFleetCreationInput } from '../../../../src/provision/creation/utils/build-fleet-creation-input'
import type { CreateFleetCommandInput } from '@aws-sdk/client-ec2'

describe('buildFleetCreationInput fn', () => {
  let defaultInput: BuildFleetCreationInput

  beforeEach(() => {
    // Setup default test input that will be used in all tests
    defaultInput = {
      launchTemplateName: 'runner-template',
      subnetIds: ['subnet-123', 'subnet-456'],
      resourceSpec: { cpu: 4, mmem: 8192 },
      allowedInstanceTypes: ['c5.xlarge', 'm5.xlarge'],
      targetCapacity: 3,
      uniqueId: 'test-fleet-123',
      runId: '777',
      usageClass: 'on-demand'
    }
  })

  // 📝 Comment out if too brittle
  it('creates a fully valid CreateFleetCommandInput for on-demand usageClass', () => {
    // Use default input as is (on-demand)
    const result = buildFleetCreationInput(defaultInput)

    // performs ts type checking
    const expectedConfig: CreateFleetCommandInput = {
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateName: 'runner-template',
            Version: '$Default'
          },
          Overrides: [
            {
              SubnetId: 'subnet-123',
              InstanceRequirements: {
                VCpuCount: { Min: 4, Max: 4 },
                MemoryMiB: { Min: 8192 },
                AllowedInstanceTypes: ['c5.xlarge', 'm5.xlarge'],
                BurstablePerformance: 'excluded'
              }
            },
            {
              SubnetId: 'subnet-456',
              InstanceRequirements: {
                VCpuCount: { Min: 4, Max: 4 },
                MemoryMiB: { Min: 8192 },
                AllowedInstanceTypes: ['c5.xlarge', 'm5.xlarge'],
                BurstablePerformance: 'excluded'
              }
            }
          ]
        }
      ],
      TargetCapacitySpecification: {
        TotalTargetCapacity: 3,
        DefaultTargetCapacityType: 'on-demand', // Changed for on-demand
        OnDemandTargetCapacity: 3 // Changed for on-demand
      },
      // SpotOptions should be undefined for on-demand
      Type: 'instant',
      TagSpecifications: [
        {
          ResourceType: 'fleet',
          Tags: [
            { Key: 'Name', Value: 'ec2-runner-pool-fleet-test-fleet-123' },
            { Key: 'Purpose', Value: 'RunnerPoolProvisioning' }
          ]
        },
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'AllowSelfTermination', Value: 'true' },
            { Key: 'InitialRunId', Value: '777' }
          ]
        }
      ],
      ClientToken: 'test-fleet-123'
    }

    // match object structure
    // https://jestjs.io/docs/using-matchers
    expect(result).toEqual(expectedConfig)
  })

  it('creates a fully valid CreateFleetCommandInput for spot usageClass', () => {
    const spotInput = { ...defaultInput, usageClass: 'spot' as const }
    const result = buildFleetCreationInput(spotInput)

    const expectedConfig: CreateFleetCommandInput = {
      LaunchTemplateConfigs: [
        {
          LaunchTemplateSpecification: {
            LaunchTemplateName: 'runner-template',
            Version: '$Default'
          },
          Overrides: [
            {
              SubnetId: 'subnet-123',
              InstanceRequirements: {
                VCpuCount: { Min: 4, Max: 4 },
                MemoryMiB: { Min: 8192 },
                AllowedInstanceTypes: ['c5.xlarge', 'm5.xlarge'],
                BurstablePerformance: 'excluded'
              }
            },
            {
              SubnetId: 'subnet-456',
              InstanceRequirements: {
                VCpuCount: { Min: 4, Max: 4 },
                MemoryMiB: { Min: 8192 },
                AllowedInstanceTypes: ['c5.xlarge', 'm5.xlarge'],
                BurstablePerformance: 'excluded'
              }
            }
          ]
        }
      ],
      TargetCapacitySpecification: {
        TotalTargetCapacity: 3,
        DefaultTargetCapacityType: 'spot',
        SpotTargetCapacity: 3
      },
      SpotOptions: {
        AllocationStrategy: 'price-capacity-optimized'
      },
      Type: 'instant',
      TagSpecifications: [
        {
          ResourceType: 'fleet',
          Tags: [
            { Key: 'Name', Value: 'ec2-runner-pool-fleet-test-fleet-123' },
            { Key: 'Purpose', Value: 'RunnerPoolProvisioning' }
          ]
        },
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'AllowSelfTermination', Value: 'true' },
            { Key: 'InitialRunId', Value: '777' }
          ]
        }
      ],
      ClientToken: 'test-fleet-123'
    }
    expect(result).toEqual(expectedConfig)
  })

  it('creates valid fleet creation input with all parameters for on-demand', () => {
    // Use default input (on-demand)
    const result = buildFleetCreationInput(defaultInput)

    // Verify structure and important fields
    expect(
      result.LaunchTemplateConfigs?.[0]?.LaunchTemplateSpecification
    ).toEqual({
      LaunchTemplateName: 'runner-template',
      Version: '$Default'
    })
    expect(result.LaunchTemplateConfigs?.[0].Overrides).toHaveLength(2)
    expect(result.TargetCapacitySpecification?.TotalTargetCapacity).toBe(3)
    expect(result.SpotOptions).toBeUndefined() // Changed for on-demand
    expect(result.Type).toBe('instant')
    expect(result.ClientToken).toBe('test-fleet-123')
  })

  it('creates valid fleet creation input with SpotOptions for spot', () => {
    const spotInput = { ...defaultInput, usageClass: 'spot' as const }
    const result = buildFleetCreationInput(spotInput)
    expect(result.SpotOptions?.AllocationStrategy).toBe(
      'price-capacity-optimized'
    )
  })

  it('should only use the default launch template', () => {
    const result = buildFleetCreationInput(defaultInput)

    expect(
      result.LaunchTemplateConfigs?.[0].LaunchTemplateSpecification?.Version
    ).toBe('$Default')
    expect(
      result.LaunchTemplateConfigs?.[0].LaunchTemplateSpecification
        ?.LaunchTemplateName
    ).toBe('runner-template')
  })

  it('should only use type=instant on fleet creation', () => {
    const result = buildFleetCreationInput(defaultInput)

    expect(result.Type).toBe('instant')
  })

  describe('Compute Provisioning', () => {
    it('should in vcpu where max and min are always the same', () => {
      const cpuValue = 6
      defaultInput.resourceSpec.cpu = cpuValue

      const result = buildFleetCreationInput(defaultInput)
      const vcpuConfig =
        result.LaunchTemplateConfigs?.[0].Overrides?.[0].InstanceRequirements
          ?.VCpuCount

      expect(vcpuConfig?.Min).toBe(cpuValue)
      expect(vcpuConfig?.Max).toBe(cpuValue)
    })

    it('should translate input memory as minimum only with no max defined', () => {
      const memoryValue = 12288
      defaultInput.resourceSpec.mmem = memoryValue

      const result = buildFleetCreationInput(defaultInput)
      const memConfig =
        result.LaunchTemplateConfigs?.[0].Overrides?.[0].InstanceRequirements
          ?.MemoryMiB

      expect(memConfig?.Min).toBe(memoryValue)
      expect(memConfig?.Max).toBeUndefined()
    })

    it('should always exclude burstable instances in overrides', () => {
      const result = buildFleetCreationInput(defaultInput)

      result.LaunchTemplateConfigs?.[0].Overrides?.forEach((override) => {
        expect(override.InstanceRequirements?.BurstablePerformance).toBe(
          'excluded'
        )
      })
    })

    it('includes all allowed instance types in requirements', () => {
      // Modify just the instance types and CPU/memory
      defaultInput.allowedInstanceTypes = [
        'c5.2xlarge',
        'm5.2xlarge',
        'r5.2xlarge'
      ]
      defaultInput.resourceSpec = { cpu: 8, mmem: 16384 }

      const result = buildFleetCreationInput(defaultInput)

      const instanceReqs =
        result.LaunchTemplateConfigs?.[0].Overrides?.[0].InstanceRequirements
      expect(instanceReqs?.AllowedInstanceTypes).toEqual([
        'c5.2xlarge',
        'm5.2xlarge',
        'r5.2xlarge'
      ])
      expect(instanceReqs?.VCpuCount).toEqual({ Min: 8, Max: 8 })
      expect(instanceReqs?.MemoryMiB).toEqual({ Min: 16384 })
    })

    it('should commit all target capacity to on-demand when usageClass is on-demand', () => {
      // Modify just the capacity
      defaultInput.targetCapacity = 5
      const result = buildFleetCreationInput(defaultInput) // defaultInput is on-demand

      expect(result.TargetCapacitySpecification?.TotalTargetCapacity).toBe(5)
      expect(result.TargetCapacitySpecification?.OnDemandTargetCapacity).toBe(5)
      expect(
        result.TargetCapacitySpecification?.SpotTargetCapacity
      ).toBeUndefined()
    })

    it('should commit all target capacity to spot when usageClass is spot', () => {
      const spotInput = {
        ...defaultInput,
        targetCapacity: 5,
        usageClass: 'spot' as const
      }
      const result = buildFleetCreationInput(spotInput)

      expect(result.TargetCapacitySpecification?.TotalTargetCapacity).toBe(5)
      expect(result.TargetCapacitySpecification?.SpotTargetCapacity).toBe(5)
      expect(
        result.TargetCapacitySpecification?.OnDemandTargetCapacity
      ).toBeUndefined()
    })
  })

  describe('Subnets', () => {
    it('should have a single override for a single subnet', () => {
      // Modify just the subnet aspect
      defaultInput.subnetIds = ['subnet-abc']

      const result = buildFleetCreationInput(defaultInput)

      expect(result.LaunchTemplateConfigs?.[0].Overrides).toHaveLength(1)
      expect(result.LaunchTemplateConfigs?.[0].Overrides?.[0].SubnetId).toBe(
        'subnet-abc'
      )
    })

    it('should control the amount of overrides', () => {
      // Modify just the subnet aspect
      defaultInput.subnetIds = ['subnet-abc', 'subnet-123', 'subnet-iii']

      let result = buildFleetCreationInput(defaultInput)
      expect(result.LaunchTemplateConfigs?.[0].Overrides).toHaveLength(3)

      defaultInput.subnetIds = ['subnet-abc']
      result = buildFleetCreationInput(defaultInput)
      expect(result.LaunchTemplateConfigs?.[0].Overrides).toHaveLength(1)
    })

    it('should correctly configure for on-demand instances when usageClass is on-demand', () => {
      const result = buildFleetCreationInput(defaultInput) // defaultInput is on-demand

      expect(
        result.TargetCapacitySpecification?.DefaultTargetCapacityType
      ).toBe('on-demand')
      expect(result.TargetCapacitySpecification?.OnDemandTargetCapacity).toBe(
        defaultInput.targetCapacity
      )
      expect(
        result.TargetCapacitySpecification?.SpotTargetCapacity
      ).toBeUndefined()
      expect(result.SpotOptions).toBeUndefined()
    })

    it('should correctly configure for spot instances when usageClass is spot', () => {
      const spotInput = { ...defaultInput, usageClass: 'spot' as const }
      const result = buildFleetCreationInput(spotInput)

      expect(
        result.TargetCapacitySpecification?.DefaultTargetCapacityType
      ).toBe('spot')
      expect(result.TargetCapacitySpecification?.SpotTargetCapacity).toBe(
        spotInput.targetCapacity
      )
      expect(
        result.TargetCapacitySpecification?.OnDemandTargetCapacity
      ).toBeUndefined()
      expect(result.SpotOptions).toBeDefined()
      expect(result.SpotOptions?.AllocationStrategy).toBe(
        'price-capacity-optimized'
      )
    })
  })

  describe('Tagging and Client tokens', () => {
    it('uses uniqueId for client token', () => {
      defaultInput.uniqueId = 'client-token-123'
      const result = buildFleetCreationInput(defaultInput)
      expect(result.ClientToken).toBe('client-token-123')
    })

    it('includes uniqueId in fleet name tag', () => {
      defaultInput.uniqueId = 'tag-prefix-456'
      const result = buildFleetCreationInput(defaultInput)
      expect(result.TagSpecifications?.[0].Tags?.[0].Value).toContain(
        'tag-prefix-456'
      )
    })
  })
})
