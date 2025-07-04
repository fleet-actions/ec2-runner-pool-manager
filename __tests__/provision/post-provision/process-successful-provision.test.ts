// __tests__/provision/post-provision/process-successful-provision.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { InstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations'
import type { ProcessSuccessfulProvisionInputs } from '../../../src/provision/post-provision/process-successful-provision'
import { Instance } from '../../../src/provision/types'
import { GenericInstance } from '../../../__fixtures__/generic'

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
  let mockInstanceOperations: MockProxy<InstanceOperations>
  const generic: Instance = GenericInstance

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mock for DynamoDB operations
    mockInstanceOperations = mock<InstanceOperations>()

    // Setup default mock behaviors
    mockInstanceOperations.instanceRunningRegistration.mockResolvedValue(
      undefined as any
    )
    mockInstanceOperations.instanceStateTransition.mockResolvedValue(undefined)

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
      ddbOps: { instanceOperations: mockInstanceOperations }
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
      expect(
        mockInstanceOperations.instanceRunningRegistration
      ).toHaveBeenCalledTimes(1)
      expect(
        mockInstanceOperations.instanceRunningRegistration
      ).toHaveBeenCalledWith({
        id: 'i-created1',
        runId: 'test-run-123',
        threshold: expectedThreshold
      })

      // Verify selected instances are transitioned
      expect(
        mockInstanceOperations.instanceStateTransition
      ).toHaveBeenCalledTimes(2)
      expect(
        mockInstanceOperations.instanceStateTransition
      ).toHaveBeenCalledWith({
        id: 'i-selected1',
        expectedRunID: 'test-run-123',
        newRunID: 'test-run-123',
        expectedState: 'claimed',
        newState: 'running',
        newThreshold: expectedThreshold,
        conditionSelectsUnexpired: true
      })
      expect(
        mockInstanceOperations.instanceStateTransition
      ).toHaveBeenCalledWith({
        id: 'i-selected2',
        expectedRunID: 'test-run-123',
        newRunID: 'test-run-123',
        expectedState: 'claimed',
        newState: 'running',
        newThreshold: expectedThreshold,
        conditionSelectsUnexpired: true
      })
    })

    it('handles empty created instances gracefully', async () => {
      mockInput.creationOutput.instances = []

      await processSuccessfulProvision(mockInput)

      expect(
        mockInstanceOperations.instanceRunningRegistration
      ).not.toHaveBeenCalled()

      // Should still process selected instances
      expect(
        mockInstanceOperations.instanceStateTransition
      ).toHaveBeenCalledTimes(2)
    })

    it('handles empty selected instances gracefully', async () => {
      mockInput.selectionOutput.instances = []
      mockInput.selectionOutput.numInstancesSelected = 0

      await processSuccessfulProvision(mockInput)

      // Should still process created instances
      expect(
        mockInstanceOperations.instanceRunningRegistration
      ).toHaveBeenCalledTimes(1)

      expect(
        mockInstanceOperations.instanceStateTransition
      ).not.toHaveBeenCalled()
    })
  })

  describe('Error Handling', () => {
    it('propagates DynamoDB registration errors', async () => {
      const error = new Error('DynamoDB registration failed')
      mockInstanceOperations.instanceRunningRegistration.mockRejectedValue(
        error
      )

      await expect(processSuccessfulProvision(mockInput)).rejects.toThrow(error)
    })

    it('propagates DynamoDB state transition errors', async () => {
      const error = new Error('DynamoDB transition failed')
      mockInstanceOperations.instanceStateTransition.mockRejectedValue(error)

      await expect(processSuccessfulProvision(mockInput)).rejects.toThrow(error)
    })

    it('still attempts to process selected instances if created instances fail', async () => {
      mockInstanceOperations.instanceRunningRegistration.mockRejectedValueOnce(
        new Error('Registration failed')
      )

      await expect(processSuccessfulProvision(mockInput)).rejects.toThrow(
        'Registration failed'
      )

      // Should not attempt to process selected instances or output IDs
      expect(
        mockInstanceOperations.instanceStateTransition
      ).not.toHaveBeenCalled()
    })
  })
})
