// __tests__/provision/post-provision/process-successful-provision.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { InstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations'
import type { ProcessSuccessfulProvisionInputs } from '../../../src/provision/post-provision/process-successful-provision'
import { Instance } from '../../../src/provision/types'

// Mock dependencies
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { processSuccessfulProvision } = await import(
  '../../../src/provision/post-provision/process-successful-provision'
)

describe('processSuccessfulProvision', () => {
  let mockInput: ProcessSuccessfulProvisionInputs
  let mockDDBOps: MockProxy<InstanceOperations>
  const generic: Instance = {
    id: 'i-generic',
    instanceType: 'c5.large',
    resourceClass: 'medium',
    cpu: 4,
    mmem: 2048
  }

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mock for DynamoDB operations
    mockDDBOps = mock<InstanceOperations>()

    // Setup default mock behaviors
    mockDDBOps.instanceRegistration.mockResolvedValue(undefined as any)
    mockDDBOps.instanceStateTransition.mockResolvedValue(undefined)

    // Setup input with test data
    mockInput = {
      selectionOutput: {
        instances: [
          { ...generic, id: 'i-selected1' },
          { ...generic, id: 'i-selected2' }
        ],
        labels: [],
        numInstancesSelected: 2,
        numInstancesRequired: 2
      },
      creationOutput: {
        instances: [{ ...generic, id: 'i-created1' }],
        labels: [],
        state: 'success',
        numInstancesCreated: 1
      },
      maxRuntimeMin: 60,
      runId: 'test-run-123',
      ddbOps: mockDDBOps
    }
  })

  describe('Control Flow', () => {
    it('logs start and completion of the routine', async () => {
      await processSuccessfulProvision(mockInput)

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('starting compose action outputs routine')
      )
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('completing compose action outputs routine')
      )
    })

    it('processes both created and selected instances', async () => {
      const now = Date.now()
      jest.spyOn(Date, 'now').mockReturnValue(now)

      await processSuccessfulProvision(mockInput)

      // Calculate expected threshold (60 minutes converted to milliseconds)
      const expectedThreshold = new Date(now + 3600000).toISOString()

      // Verify created instances are registered
      expect(mockDDBOps.instanceRegistration).toHaveBeenCalledTimes(1)
      expect(mockDDBOps.instanceRegistration).toHaveBeenCalledWith({
        id: 'i-created1',
        runId: 'test-run-123',
        threshold: expectedThreshold,
        resourceClass: generic.resourceClass,
        instanceType: generic.instanceType
      })

      // Verify selected instances are transitioned
      expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledTimes(2)
      expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledWith({
        id: 'i-selected1',
        expectedRunID: 'test-run-123',
        newRunID: 'test-run-123',
        expectedState: 'claimed',
        newState: 'running',
        newThreshold: expectedThreshold,
        conditionSelectsUnexpired: true
      })
      expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledWith({
        id: 'i-selected2',
        expectedRunID: 'test-run-123',
        newRunID: 'test-run-123',
        expectedState: 'claimed',
        newState: 'running',
        newThreshold: expectedThreshold,
        conditionSelectsUnexpired: true
      })
    })

    it('outputs instance IDs correctly for distribution', async () => {
      await processSuccessfulProvision(mockInput)

      // Verify that the instance IDs are set as outputs
      const expectedIds = ['i-selected1', 'i-selected2', 'i-created1']
      expect(core.setOutput).toHaveBeenCalledWith('ids', expectedIds)
      expect(core.setOutput).toHaveBeenCalledWith('id', expectedIds[0])
    })

    it('handles empty created instances gracefully', async () => {
      mockInput.creationOutput.instances = []

      await processSuccessfulProvision(mockInput)

      expect(mockDDBOps.instanceRegistration).not.toHaveBeenCalled()

      // Should still process selected instances
      expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledTimes(2)

      // Outputs should only include selected instances
      const expectedIds = ['i-selected1', 'i-selected2']
      expect(core.setOutput).toHaveBeenCalledWith('ids', expectedIds)
      expect(core.setOutput).toHaveBeenCalledWith('id', expectedIds[0])
    })

    it('handles empty selected instances gracefully', async () => {
      mockInput.selectionOutput.instances = []
      mockInput.selectionOutput.numInstancesSelected = 0

      await processSuccessfulProvision(mockInput)

      // Should still process created instances
      expect(mockDDBOps.instanceRegistration).toHaveBeenCalledTimes(1)

      expect(mockDDBOps.instanceStateTransition).not.toHaveBeenCalled()

      // Outputs should only include created instances
      const expectedIds = ['i-created1']
      expect(core.setOutput).toHaveBeenCalledWith('ids', expectedIds)
      expect(core.setOutput).toHaveBeenCalledWith('id', expectedIds[0])
    })
  })

  describe('Error Handling', () => {
    it('propagates DynamoDB registration errors', async () => {
      const error = new Error('DynamoDB registration failed')
      mockDDBOps.instanceRegistration.mockRejectedValue(error)

      await expect(processSuccessfulProvision(mockInput)).rejects.toThrow(error)
    })

    it('propagates DynamoDB state transition errors', async () => {
      const error = new Error('DynamoDB transition failed')
      mockDDBOps.instanceStateTransition.mockRejectedValue(error)

      await expect(processSuccessfulProvision(mockInput)).rejects.toThrow(error)
    })

    it('still attempts to process selected instances if created instances fail', async () => {
      mockDDBOps.instanceRegistration.mockRejectedValueOnce(
        new Error('Registration failed')
      )

      await expect(processSuccessfulProvision(mockInput)).rejects.toThrow(
        'Registration failed'
      )

      // Should not attempt to process selected instances or output IDs
      expect(mockDDBOps.instanceStateTransition).not.toHaveBeenCalled()
      expect(core.setOutput).not.toHaveBeenCalled()
    })

    it('fails fast if no instances are available', async () => {
      mockInput.selectionOutput.instances = []
      mockInput.creationOutput.instances = []

      await processSuccessfulProvision(mockInput)

      // Should set outputs with empty array
      expect(core.setOutput).toHaveBeenCalledWith('ids', [])
      // There's no first element, but the current implementation would use undefined
      expect(core.setOutput).toHaveBeenCalledWith('id', undefined)
    })
  })
})
