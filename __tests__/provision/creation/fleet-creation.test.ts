// __tests__/provision/creation/fleet-creation.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { FleetOperations } from '../../../src/services/ec2/operations/fleet-operations'
import { InstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations' // Ensure this is imported
import {
  buildFleetCreationInput,
  processFleetResponse
} from '../../../__fixtures__/provision/creation/index'

// Mock dependencies
Object.entries({
  '@actions/core': core,
  '../../../src/provision/creation/utils/build-fleet-creation-input': {
    buildFleetCreationInput
  },
  '../../../src/provision/creation/utils/process-fleet-reponse': {
    processFleetResponse
  }
}).forEach(([path, mockModule]) => {
  // Renamed 'mock' to 'mockModule' to avoid conflict
  jest.unstable_mockModule(path, () => mockModule)
})

const { fleetCreation } = await import(
  // Removed makeFleetAttempt if not directly tested here
  '../../../src/provision/creation/fleet-creation'
)

describe('FleetCreation', () => {
  describe('Control Flow', () => {
    let mockInput: any
    let mockFleetOps: MockProxy<FleetOperations>
    let mockDdbOps: MockProxy<InstanceOperations>

    beforeEach(() => {
      jest.clearAllMocks()
      // No more jest.useFakeTimers() or jest.setSystemTime()

      mockFleetOps = mock<FleetOperations>()
      mockFleetOps.createFleet.mockResolvedValue('mock-aws-response' as any)

      mockDdbOps = mock<InstanceOperations>()

      const mockSuccessfulFleetResult = {
        status: 'success',
        instances: [
          {
            id: 'i-123',
            resourceClass: 'test-rc',
            instanceType: 't3.micro'
          },
          {
            id: 'i-456',
            resourceClass: 'test-rc',
            instanceType: 't3.small'
          }
        ]
      }
      processFleetResponse.mockReturnValue(mockSuccessfulFleetResult as any)
      buildFleetCreationInput.mockReturnValue('mock-fleet-input' as any)

      mockInput = {
        launchTemplate: { name: 'test-template' },
        ec2Ops: mockFleetOps,
        ddbOps: mockDdbOps,
        subnetIds: ['subnet-1'],
        resourceSpec: { cpu: 1, mmem: 1024 },
        allowedInstanceTypes: ['t3.micro', 't3.small'],
        resourceClass: 'test-rc',
        numInstancesRequired: 2,
        runId: 'test-run-123'
      }
    })

    // No more afterEach for jest.useRealTimers()

    it('propagates the processFleetResponse result as its own result when registration succeeds', async () => {
      const expectedSuccessfulFleetResult = {
        status: 'success',
        instances: [
          {
            id: 'i-success-1',
            resourceClass: 'test-rc-succ',
            instanceType: 't3.medium'
          }
        ]
      }
      processFleetResponse.mockReturnValue(expectedSuccessfulFleetResult as any)
      mockDdbOps.instanceCreatedRegistration.mockResolvedValue(true)

      const result = await fleetCreation(mockInput)
      expect(result).toEqual(expectedSuccessfulFleetResult)
      expect(result.status).toBe('success')
    })

    describe('Instance Registration', () => {
      const mockInstances = [
        { id: 'i-reg-1', resourceClass: 'rc1', instanceType: 't3.nano' },
        { id: 'i-reg-2', resourceClass: 'rc1', instanceType: 't3.micro' }
      ]

      it('calls instanceCreatedRegistration for each instance on successful fleet creation', async () => {
        processFleetResponse.mockReturnValue({
          status: 'success',
          instances: mockInstances
        } as any)
        mockDdbOps.instanceCreatedRegistration.mockResolvedValue(true)

        await fleetCreation(mockInput)

        expect(mockDdbOps.instanceCreatedRegistration).toHaveBeenCalledTimes(
          mockInstances.length
        )
        for (const instance of mockInstances) {
          expect(mockDdbOps.instanceCreatedRegistration).toHaveBeenCalledWith({
            id: instance.id,
            runId: mockInput.runId,
            resourceClass: instance.resourceClass,
            instanceType: instance.instanceType,
            threshold: expect.any(String) // Verify it's a string, but not the exact value
          })
        }
      })

      it('updates status to "failed" if any instance registration fails', async () => {
        processFleetResponse.mockReturnValue({
          status: 'success',
          instances: mockInstances
        } as any)
        mockDdbOps.instanceCreatedRegistration
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false)

        const result = await fleetCreation(mockInput)

        expect(mockDdbOps.instanceCreatedRegistration).toHaveBeenCalledTimes(
          mockInstances.length
        )
        expect(result.status).toBe('failed')
        expect(core.debug).toHaveBeenCalledWith(
          `Failed to register instances: ${mockInstances[1].id}`
        )
      })

      it('updates status to "failed" if all instance registrations fail', async () => {
        processFleetResponse.mockReturnValue({
          status: 'success',
          instances: mockInstances
        } as any)
        mockDdbOps.instanceCreatedRegistration.mockResolvedValue(false)

        const result = await fleetCreation(mockInput)

        expect(mockDdbOps.instanceCreatedRegistration).toHaveBeenCalledTimes(
          mockInstances.length
        )
        expect(result.status).toBe('failed')
        expect(core.debug).toHaveBeenCalledWith(
          `Failed to register instances: ${mockInstances.map((i) => i.id).join(', ')}`
        )
      })

      it('does not attempt registration if makeFleetAttempt returns failed status', async () => {
        processFleetResponse.mockReturnValue({
          status: 'failed',
          instances: []
        } as any)

        await fleetCreation(mockInput)
        expect(mockDdbOps.instanceCreatedRegistration).not.toHaveBeenCalled()
      })
    })

    describe('Error handling', () => {
      it('validates launch template name before making any API calls', async () => {
        mockInput.launchTemplate.name = undefined
        await expect(fleetCreation(mockInput)).rejects.toThrow(
          'launch template name not set'
        )
        expect(mockInput.ec2Ops.createFleet).not.toHaveBeenCalled()
      })

      it('catches and handles API errors from makeFleetAttempt without throwing', async () => {
        // Simulate an error during the makeFleetAttempt phase (e.g., ec2Ops.createFleet fails)
        // This is implicitly tested by processFleetResponse returning a 'failed' status
        // if makeFleetAttempt itself throws an error which is caught by its internal try/catch.

        // To be more direct for makeFleetAttempt's own error:
        mockFleetOps.createFleet.mockRejectedValueOnce(
          new Error('Direct API failure from createFleet')
        )
        // processFleetResponse will not be called if createFleet throws directly in makeFleetAttempt's try block
        // Instead, makeFleetAttempt's catch block will engage.

        // Let's ensure processFleetResponse is NOT what causes the 'failed' status here for clarity.
        // So we mock it to return success, to see if the earlier error in makeFleetAttempt is caught.
        const successfulFleetResult = {
          status: 'success',
          instances: [{ id: 'i-should-not-appear' }]
        }
        processFleetResponse.mockReturnValue(successfulFleetResult as any)

        const result = await fleetCreation(mockInput)

        expect(result.status).toBe('failed') // Because makeFleetAttempt caught the createFleet error
        expect(result.instances).toEqual([])
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'Fleet attempt 1 API error: Error: Direct API failure from createFleet'
          )
        )
        // processFleetResponse should not have been called if createFleet threw.
        // The result of makeFleetAttempt would be { instances: [], status: 'failed' }
        // so the registration block in fleetCreation would be skipped.
        expect(processFleetResponse).not.toHaveBeenCalled() // If createFleet fails, processFleetResponse in makeFleetAttempt is skipped.
        expect(mockDdbOps.instanceCreatedRegistration).not.toHaveBeenCalled()
      })

      it('handles errors from buildFleetCreationInput by returning failed status from makeFleetAttempt', async () => {
        buildFleetCreationInput.mockImplementationOnce(() => {
          throw new Error('Build error')
        })
        // processFleetResponse will not be called if buildFleetCreationInput throws.
        processFleetResponse.mockReturnValue({
          status: 'success',
          instances: []
        } as any)

        const result = await fleetCreation(mockInput)

        expect(result.status).toBe('failed')
        expect(result.instances).toEqual([])
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'Fleet attempt 1 API error: Error: Build error'
          )
        )
        expect(processFleetResponse).not.toHaveBeenCalled()
        expect(mockDdbOps.instanceCreatedRegistration).not.toHaveBeenCalled()
      })

      it('handles errors from processFleetResponse by returning failed status from makeFleetAttempt', async () => {
        processFleetResponse.mockImplementationOnce(() => {
          throw new Error('Process error')
        })

        const result = await fleetCreation(mockInput)

        expect(result.status).toBe('failed')
        expect(result.instances).toEqual([])
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'Fleet attempt 1 API error: Error: Process error'
          )
        )
        expect(mockDdbOps.instanceCreatedRegistration).not.toHaveBeenCalled()
      })
    })
  })
})
