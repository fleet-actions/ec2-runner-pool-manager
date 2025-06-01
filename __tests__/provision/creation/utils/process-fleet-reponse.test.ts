// __tests__/provision/creation/utils/process-fleet-reponse.test.ts
import { jest } from '@jest/globals'
import * as core from '../../../../__fixtures__/core'
import type { CreateFleetCommandOutput } from '@aws-sdk/client-ec2'
import type { ProcessFleetResponseInput } from '../../../../src/provision/creation/utils/process-fleet-reponse'

// Mock dependencies
jest.unstable_mockModule('@actions/core', () => core)

const { processFleetResponse } = await import(
  '../../../../src/provision/creation/utils/process-fleet-reponse'
)

describe('processFleetResponse', () => {
  let defaultResponse: CreateFleetCommandOutput
  let defaultInputParams: ProcessFleetResponseInput

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup default response to simulate successful launch
    defaultResponse = {
      Instances: [
        {
          InstanceType: 'c5.xlarge',
          InstanceIds: ['i-123', 'i-456']
        }
      ],
      $metadata: {}
    }

    // Setup default input parameters
    defaultInputParams = {
      response: defaultResponse,
      resourceClass: 'default-class',
      targetCapacity: 2,
      cpu: 4,
      mmem: 2048,
      usageClass: 'on-demand'
    }
  })

  it('should be "success" if target capacity matches amount of instances created', () => {
    const result = processFleetResponse(defaultInputParams)

    expect(result.status).toBe('success')
    expect(result.instances).toHaveLength(2)
    expect(result.instances[0].instanceType).toBe('c5.xlarge')
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Successfully launched all 2 instances')
    )
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.error).not.toHaveBeenCalled()
  })

  it('should be "partial" if target capacity is not reached but some instances created', () => {
    // Modify the default response for this test
    defaultInputParams.response = {
      ...defaultResponse,
      Instances: [
        {
          InstanceType: 'c5.xlarge',
          InstanceIds: ['i-123']
        }
      ],
      Errors: [
        {
          ErrorCode: 'InsufficientInstanceCapacity',
          ErrorMessage: 'Not enough capacity'
        }
      ]
    }
    defaultInputParams.targetCapacity = 3

    const result = processFleetResponse(defaultInputParams)

    expect(result.status).toBe('partial')
    expect(result.instances).toHaveLength(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Partially launched')
    )
  })

  it('should be "failed" when no instances were created', () => {
    // Modify for complete failure
    defaultInputParams.response = {
      ...defaultResponse,
      Instances: [],
      Errors: [
        {
          ErrorCode: 'InsufficientInstanceCapacity',
          ErrorMessage: 'Not enough capacity'
        }
      ]
    }

    const result = processFleetResponse(defaultInputParams)

    expect(result.status).toBe('failed')
    expect(result.instances).toHaveLength(0)
    expect(core.error).toHaveBeenCalled()
  })

  it('should log detailed error information with subnet details', () => {
    defaultInputParams.response = {
      ...defaultResponse,
      Instances: [],
      Errors: [
        {
          ErrorCode: 'InsufficientInstanceCapacity',
          ErrorMessage: 'Not enough capacity',
          LaunchTemplateAndOverrides: {
            Overrides: {
              SubnetId: 'subnet-123'
            }
          }
        }
      ]
    }

    processFleetResponse(defaultInputParams)

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('subnet-123')
    )
  })

  it('should handle unknown instance types and mark as failed', () => {
    defaultInputParams.response = {
      ...defaultResponse,
      Instances: [
        {
          // No InstanceType provided
          InstanceIds: ['i-123', 'i-456']
        }
      ]
    }

    const result = processFleetResponse(defaultInputParams)

    expect(result.status).toBe('failed')
    expect(result.instances[0].instanceType).toBe('UKNOWN_TYPE')
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('unknown type')
    )
  })

  it('should handle mixed instance types correctly', () => {
    defaultInputParams.response = {
      ...defaultResponse,
      Instances: [
        { InstanceType: 'c5.large', InstanceIds: ['i-123'] },
        { InstanceType: 'm5.large', InstanceIds: ['i-456', 'i-abc'] },
        { InstanceType: 'r5.large', InstanceIds: ['i-789'] }
      ]
    }
    defaultInputParams.targetCapacity = 4

    const result = processFleetResponse(defaultInputParams)

    expect(result.status).toBe('success')
    expect(result.instances).toHaveLength(4)
    expect(result.instances.map((i) => i.instanceType).sort()).toEqual(
      ['c5.large', 'm5.large', 'm5.large', 'r5.large'].sort()
    )
  })

  it('should assign the provided resource class to all instances', () => {
    defaultInputParams.resourceClass = 'custom-class'

    const result = processFleetResponse(defaultInputParams)

    result.instances.forEach((instance) => {
      expect(instance.resourceClass).toBe('custom-class')
    })
  })

  it('should handle empty response gracefully', () => {
    defaultInputParams.response = { $metadata: {} }

    const result = processFleetResponse(defaultInputParams)

    expect(result.status).toBe('failed')
    expect(result.instances).toHaveLength(0)
  })
})
