// __tests__/provision/post-provision/process-failed-provision.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { InstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations'
import {
  ResourceClassConfigOperations,
  SendResourcesToPoolsOutput
} from '../../../src/services/sqs/operations/resource-class-operations'
import { ProcessFailedProvisionInput } from '../../../src/provision/post-provision/process-failed-provision'
import { Instance } from '../../../src/provision/types'
import { GenericInstance } from '../../../__fixtures__/generic'

// Mock dependencies
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { processFailedProvision } = await import(
  '../../../src/provision/post-provision/process-failed-provision'
)

describe('processFailedProvision', () => {
  let mockInput: ProcessFailedProvisionInput
  let mockDDBOps: MockProxy<InstanceOperations>
  let mockSQSOps: MockProxy<ResourceClassConfigOperations>
  const generic: Instance = GenericInstance

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mocks for operations
    mockDDBOps = mock<InstanceOperations>()
    mockSQSOps = mock<ResourceClassConfigOperations>()

    // Setup default mock behaviors
    mockDDBOps.instanceStateTransition.mockResolvedValue(undefined)
    mockSQSOps.sendResourcesToPools.mockResolvedValue({
      successful: [],
      failed: []
    })

    // Setup input with test data
    mockInput = {
      selectionOutput: {
        instances: [
          { ...generic, id: 'i-test1' },
          { ...generic, id: 'i-test2' }
        ],
        labels: [],
        numInstancesSelected: 2,
        numInstancesRequired: 2
      },
      idleTimeSec: 300,
      runId: 'test-run-123',
      resourceClassConfig: [] as any,
      ddbOps: mockDDBOps,
      sqsOps: mockSQSOps
    }
  })

  describe('Control Flow', () => {
    describe('State Transition', () => {
      it('transitions all selected instances from CLAIMED to IDLE state with proper threshold', async () => {
        const now = Date.now()
        jest.spyOn(Date, 'now').mockReturnValue(now)

        await processFailedProvision(mockInput)

        // Calculate expected threshold
        const expectedThreshold = new Date(now + 300000).toISOString()

        // Verify DDB state transitions for each instance
        expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledTimes(2)
        expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledWith({
          id: 'i-test1',
          expectedRunID: 'test-run-123',
          newRunID: '',
          expectedState: 'claimed',
          newState: 'idle',
          newThreshold: expectedThreshold,
          conditionSelectsUnexpired: true
        })
        expect(mockDDBOps.instanceStateTransition).toHaveBeenCalledWith({
          id: 'i-test2',
          expectedRunID: 'test-run-123',
          newRunID: '',
          expectedState: 'claimed',
          newState: 'idle',
          newThreshold: expectedThreshold,
          conditionSelectsUnexpired: true
        })
      })
    })

    it('logs start and completion of release resources routine', async () => {
      await processFailedProvision(mockInput)

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('starting process failed provision routine...')
      )
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('compled process failed provision routine...')
      )
    })

    it('requeues all instances back to their respective pools', async () => {
      mockSQSOps.sendResourcesToPools.mockResolvedValue({
        successful: [
          { id: 'i-test1', resourceClass: 'medium' },
          { id: 'i-test2', resourceClass: 'medium' }
        ],
        failed: []
      } as SendResourcesToPoolsOutput)

      await processFailedProvision(mockInput)

      expect(mockSQSOps.sendResourcesToPools).toHaveBeenCalledWith(
        [
          {
            ...generic,
            id: 'i-test1'
          },
          {
            ...generic,
            id: 'i-test2'
          }
        ],
        mockInput.resourceClassConfig
      )
    })

    it('throws error when any instance fails to be requeued', async () => {
      mockSQSOps.sendResourcesToPools.mockResolvedValue({
        successful: [{ id: 'i-test1', resourceClass: 'medium' }],
        failed: [
          { id: 'i-test2', resourceClass: 'medium', error: 'Queue error' }
        ]
      } as SendResourcesToPoolsOutput)

      await expect(processFailedProvision(mockInput)).rejects.toThrow(
        'Failed to send selected resources back to pool'
      )

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'failed to gracefully redistribute certain instances'
        )
      )
    })

    it('handles DDB state transition failures by failing the entire operation', async () => {
      mockDDBOps.instanceStateTransition.mockRejectedValueOnce(
        new Error('DDB transition failed')
      )

      await expect(processFailedProvision(mockInput)).rejects.toThrow(
        'DDB transition failed'
      )

      // Should not attempt to requeue when state transition fails
      expect(mockSQSOps.sendResourcesToPools).not.toHaveBeenCalled()
    })

    it('handles empty selection inputs gracefully', async () => {
      mockInput.selectionOutput.instances = []
      mockInput.selectionOutput.numInstancesSelected = 0

      await processFailedProvision(mockInput)

      // No operations should be attempted
      expect(mockDDBOps.instanceStateTransition).not.toHaveBeenCalled()
      expect(mockSQSOps.sendResourcesToPools).not.toHaveBeenCalled()
    })
  })

  describe('Error Handling', () => {
    it('propagates DynamoDB errors', async () => {
      const error = new Error('DynamoDB service unavailable')
      mockDDBOps.instanceStateTransition.mockRejectedValue(error)

      await expect(processFailedProvision(mockInput)).rejects.toThrow(error)
    })

    it('logs appropriate warnings when SQS requeuing fails', async () => {
      mockSQSOps.sendResourcesToPools.mockResolvedValue({
        successful: [],
        failed: [
          { id: 'i-test1', resourceClass: 'medium', error: 'Queue error' },
          { id: 'i-test2', resourceClass: 'medium', error: 'Queue error' }
        ]
      })

      await expect(processFailedProvision(mockInput)).rejects.toThrow(
        'Failed to send selected resources back to pool :('
      )
    })

    it('throws error even when some resources are successfully enqueued', async () => {
      mockSQSOps.sendResourcesToPools.mockResolvedValue({
        successful: [{ id: 'i-test1', resourceClass: 'medium' }], // successful
        failed: [
          { id: 'i-test2', resourceClass: 'medium', error: 'Queue error' } // unsuccessful
        ]
      })

      await expect(processFailedProvision(mockInput)).rejects.toThrow(
        'Failed to send selected resources back to pool :('
      )
    })
  })
})
