import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { HeartbeatOperations } from '../../../src/services/dynamodb/operations/heartbeat-operations'
import { WorkerSignalOperations } from '../../../src/services/dynamodb/operations/signal-operations'
import { FleetValidationInputs } from '../../../src/provision/creation/fleet-validation'
import { Instance } from '../../../src/provision/types'

Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { fleetValidation } = await import(
  '../../../src/provision/creation/fleet-validation'
)

describe('FleetValidation', () => {
  describe('Control Flow', () => {
    let mockInput: FleetValidationInputs
    let mockWorkerSignalOps: MockProxy<WorkerSignalOperations>
    let mockHeartbeatOps: MockProxy<HeartbeatOperations>
    const generic: Instance = {
      id: 'i-generic',
      instanceType: 'c5.large',
      resourceClass: 'medium',
      cpu: 4,
      mmem: 2048
    }

    beforeEach(() => {
      jest.clearAllMocks()

      // Create mocks for external dependencies
      mockWorkerSignalOps = mock<WorkerSignalOperations>()
      mockHeartbeatOps = mock<HeartbeatOperations>()

      // Setup default success states
      mockWorkerSignalOps.pollOnSignal.mockResolvedValue({
        state: true,
        message: 'all instances completed'
      })

      mockHeartbeatOps.areAllInstancesHealthyPoll.mockResolvedValue({
        state: true,
        message: 'all instances healthy'
      })

      // Create base input with success state
      mockInput = {
        fleetResult: {
          status: 'success',
          instances: [{ ...generic, id: 'i-123' }]
        },
        ddbOps: {
          workerSignalOperations: mockWorkerSignalOps,
          heartbeatOperations: mockHeartbeatOps
        },
        runId: 'some-run-id'
      }
    })

    it('returns success when all validations pass', async () => {
      const result = await fleetValidation(mockInput)
      expect(result).toBe('success')
    })

    // Add a new test for ordering
    it('always calls ws check before heartbeat check', async () => {
      // Use mockImplementation to track call order
      const callOrder: string[] = []

      mockWorkerSignalOps.pollOnSignal.mockImplementation(async () => {
        callOrder.push('ws')
        return { state: true, message: 'all good' }
      })

      mockHeartbeatOps.areAllInstancesHealthyPoll.mockImplementation(
        async () => {
          callOrder.push('heartbeat')
          return { state: true, message: 'all good' }
        }
      )

      await fleetValidation(mockInput)

      expect(callOrder).toEqual(['ws', 'heartbeat'])
      expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenCalled()
      expect(mockHeartbeatOps.areAllInstancesHealthyPoll).toHaveBeenCalled()
    })

    it('handles exceptions from ws operations', async () => {
      mockWorkerSignalOps.pollOnSignal.mockRejectedValue(
        new Error('DB connection error')
      )

      const result = await fleetValidation(mockInput)

      expect(result).toBe('failed')
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Error encountered')
      )
      // heartbeat not called
      expect(mockHeartbeatOps.areAllInstancesHealthyPoll).not.toHaveBeenCalled()
    })

    it('handles exceptions from heartbeat operations', async () => {
      mockWorkerSignalOps.pollOnSignal.mockResolvedValue({
        state: true,
        message: 'all good'
      })

      mockHeartbeatOps.areAllInstancesHealthyPoll.mockRejectedValue(
        new Error('Network error')
      )

      const result = await fleetValidation(mockInput)

      expect(result).toBe('failed')
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Error encountered')
      )
      // ws polling still called
      expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenCalled()
    })

    describe('Scenarios for successive failures', () => {
      it('fails early if initial fleet status is anything but success', async () => {
        // Test both non-success states in a loop
        for (const status of ['partial', 'failed']) {
          // Reset mocks between iterations
          jest.clearAllMocks()

          mockInput.fleetResult.status = status as any
          const result = await fleetValidation(mockInput)

          expect(result).toBe('failed')
          expect(mockWorkerSignalOps.pollOnSignal).not.toHaveBeenCalled()
          expect(
            mockHeartbeatOps.areAllInstancesHealthyPoll
          ).not.toHaveBeenCalled()
          expect(core.error).toHaveBeenCalled()
        }
      })

      // POLLLING ERRORS
      // Change the existing ws test to be more explicit
      it('fails if ws check returns false and skips heartbeat check', async () => {
        mockWorkerSignalOps.pollOnSignal.mockResolvedValue({
          state: false,
          message: 'ws timeout'
        })

        const result = await fleetValidation(mockInput)

        expect(result).toBe('failed')
        expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenCalled()
        expect(
          mockHeartbeatOps.areAllInstancesHealthyPoll
        ).not.toHaveBeenCalled()
        expect(core.error).toHaveBeenCalledWith(expect.stringContaining('ws'))
      })

      // Add test to show heartbeat failure but ws still called
      it('calls ws even if heartbeat check will fail', async () => {
        mockHeartbeatOps.areAllInstancesHealthyPoll.mockResolvedValue({
          state: false,
          message: 'heartbeat timeout'
        })

        const result = await fleetValidation(mockInput)

        expect(result).toBe('failed')
        expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenCalled()
        expect(mockHeartbeatOps.areAllInstancesHealthyPoll).toHaveBeenCalled()
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('healthy')
        )
      })
    })
  })
})
