// __tests__/provision/creation/index.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import {
  fleetCreation,
  fleetValidation
} from '../../../__fixtures__/provision/creation'
import * as core from '../../../__fixtures__/core'
import { CreationInput, Instance } from '../../../src/provision/types'
import { InstanceOperations } from '../../../src/services/ec2/operations/instance-operations'
import { GenericInstance } from '../../../__fixtures__/generic'

Object.entries({
  '@actions/core': core,
  '../../../src/provision/creation/fleet-creation': { fleetCreation },
  '../../../src/provision/creation/fleet-validation': { fleetValidation }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

// Import after mocking
const { creation } = await import('../../../src/provision/creation/index')

describe('Creation', () => {
  let mockInput: CreationInput
  let instanceOperations: MockProxy<InstanceOperations>
  const generic: Instance = GenericInstance

  beforeEach(() => {
    jest.clearAllMocks()
    instanceOperations = mock<InstanceOperations>()

    // Setup base input
    mockInput = {
      launchTemplate: { name: 'test-template' } as any,
      subnetIds: ['subnet-123'],
      resourceSpec: {} as any,
      resourceClass: 'medium',
      usageClass: 'spot',
      allowedInstanceTypes: ['c5.xlarge'],
      numInstancesRequired: 2,
      ec2Ops: {
        fleetOperations: {} as any,
        instanceOperations
      },
      ddbOps: {} as any,
      runId: '777'
    }

    // Default mocked returns
    fleetCreation.mockResolvedValue({
      status: 'success',
      instances: [
        { ...generic, id: 'i-123' },
        { ...generic, id: 'i-456' }
      ]
    })

    fleetValidation.mockResolvedValue('success')
  })

  it('throws error if fleet state is partial', async () => {
    // Mock partial fleet validation result
    fleetValidation.mockResolvedValueOnce('partial')

    await expect(creation(mockInput)).rejects.toThrow(
      'Invalid Fleet State: partial not allowed'
    )
    expect(instanceOperations.terminateInstances).not.toHaveBeenCalled()
  })

  it('calls termination if fleet state is not success and instances exist', async () => {
    // Mock failed validation but with instances
    fleetValidation.mockResolvedValueOnce('failed')

    await creation(mockInput)

    expect(instanceOperations.terminateInstances).toHaveBeenCalledWith([
      'i-123',
      'i-456'
    ])
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Termination signals')
    )
  })

  it('does not call termination if fleet state is success', async () => {
    // Default setup is success state
    await creation(mockInput)

    expect(instanceOperations.terminateInstances).not.toHaveBeenCalled()
  })

  it('does not call termination if no instances exist - even if failed', async () => {
    // Mock failed validation but with no instances
    fleetCreation.mockResolvedValueOnce({
      status: 'failed',
      instances: []
    })
    fleetValidation.mockResolvedValueOnce('failed')

    await creation(mockInput)

    expect(instanceOperations.terminateInstances).not.toHaveBeenCalled()
  })

  it('returns expected output format with instances and labels', async () => {
    const result = await creation(mockInput)

    expect(result).toEqual({
      state: 'success',
      numInstancesCreated: 2,
      instances: [
        { ...generic, id: 'i-123' },
        { ...generic, id: 'i-456' }
      ],
      labels: ['i-123', 'i-456']
    })
  })
})
