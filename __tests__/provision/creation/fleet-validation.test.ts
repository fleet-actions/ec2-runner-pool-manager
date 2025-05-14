import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { HeartbeatOperations } from '../../../src/services/dynamodb/operations/heartbeat-operations'
import { BootstrapOperations } from '../../../src/services/dynamodb/operations/bootstrap-operations'
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
    let mockBootstrapOps: MockProxy<BootstrapOperations>
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
      mockBootstrapOps = mock<BootstrapOperations>()
      mockHeartbeatOps = mock<HeartbeatOperations>()

      // Setup default success states
      mockBootstrapOps.areAllInstancesCompletePoll.mockResolvedValue({
        state: true,
        message: 'all instances bootstrapped'
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
          bootstrapOperations: mockBootstrapOps,
          heartbeatOperations: mockHeartbeatOps
        }
      }
    })

    it('returns success when all validations pass', async () => {
      const result = await fleetValidation(mockInput)
      expect(result).toBe('success')
    })

    // Add a new test for ordering
    it('always calls bootstrap check before heartbeat check', async () => {
      // Use mockImplementation to track call order
      const callOrder: string[] = []

      mockBootstrapOps.areAllInstancesCompletePoll.mockImplementation(
        async () => {
          callOrder.push('bootstrap')
          return { state: true, message: 'all good' }
        }
      )

      mockHeartbeatOps.areAllInstancesHealthyPoll.mockImplementation(
        async () => {
          callOrder.push('heartbeat')
          return { state: true, message: 'all good' }
        }
      )

      await fleetValidation(mockInput)

      expect(callOrder).toEqual(['bootstrap', 'heartbeat'])
      expect(mockBootstrapOps.areAllInstancesCompletePoll).toHaveBeenCalled()
      expect(mockHeartbeatOps.areAllInstancesHealthyPoll).toHaveBeenCalled()
    })

    it('handles exceptions from bootstrap operations', async () => {
      mockBootstrapOps.areAllInstancesCompletePoll.mockRejectedValue(
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
      mockBootstrapOps.areAllInstancesCompletePoll.mockResolvedValue({
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
      // bootstrap polling still called
      expect(mockBootstrapOps.areAllInstancesCompletePoll).toHaveBeenCalled()
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
          expect(
            mockBootstrapOps.areAllInstancesCompletePoll
          ).not.toHaveBeenCalled()
          expect(
            mockHeartbeatOps.areAllInstancesHealthyPoll
          ).not.toHaveBeenCalled()
          expect(core.error).toHaveBeenCalled()
        }
      })

      // POLLLING ERRORS
      // Change the existing bootstrap test to be more explicit
      it('fails if bootstrap check returns false and skips heartbeat check', async () => {
        mockBootstrapOps.areAllInstancesCompletePoll.mockResolvedValue({
          state: false,
          message: 'bootstrap timeout'
        })

        const result = await fleetValidation(mockInput)

        expect(result).toBe('failed')
        expect(mockBootstrapOps.areAllInstancesCompletePoll).toHaveBeenCalled()
        expect(
          mockHeartbeatOps.areAllInstancesHealthyPoll
        ).not.toHaveBeenCalled()
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('bootstrap')
        )
      })

      // Add test to show heartbeat failure but bootstrap still called
      it('calls bootstrap even if heartbeat check will fail', async () => {
        mockHeartbeatOps.areAllInstancesHealthyPoll.mockResolvedValue({
          state: false,
          message: 'heartbeat timeout'
        })

        const result = await fleetValidation(mockInput)

        expect(result).toBe('failed')
        expect(mockBootstrapOps.areAllInstancesCompletePoll).toHaveBeenCalled()
        expect(mockHeartbeatOps.areAllInstancesHealthyPoll).toHaveBeenCalled()
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('healthy')
        )
      })
    })
  })
})
