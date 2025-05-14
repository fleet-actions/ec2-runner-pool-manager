// __tests__/provision/creation/fleet-creation.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { FleetOperations } from '../../../src/services/ec2/operations/fleet-operations'
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
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { fleetCreation } = await import(
  '../../../src/provision/creation/fleet-creation'
)

// 📝 Types are relaxed in this test as we are simply testing the control flow
describe('FleetCreation', () => {
  // Testing only the orchestration/control flow, not implementation details
  describe('Control Flow', () => {
    let mockInput: any
    let mockFleetOps: MockProxy<FleetOperations>

    beforeEach(() => {
      jest.clearAllMocks()

      // Mocked EC2 operations - simply returns a mock value
      mockFleetOps = mock<FleetOperations>()
      mockFleetOps.createFleet.mockResolvedValue('mock-aws-response' as any)

      // Mock response processor - returns a predetermined result
      const mockResult = {
        status: 'success',
        instances: ['mock-instance']
      } as any
      processFleetResponse.mockReturnValue(mockResult)

      // Simple mock for build input - just passes through
      buildFleetCreationInput.mockReturnValue('mock-fleet-input' as any)

      mockInput = {
        launchTemplate: { name: 'test-template' },
        ec2Ops: mockFleetOps,
        // Other required fields with simple values
        subnetIds: ['subnet-1'],
        resourceSpec: {},
        allowedInstanceTypes: [],
        resourceClass: 'test',
        numInstancesRequired: 1
      }
    })

    it('propagates the processFleetResponse result as its own result', async () => {
      // Setup a specific mock result
      const expectedResult = {
        status: 'mock-status',
        instances: ['mock-instance-id']
      }
      processFleetResponse.mockReturnValue(expectedResult as any)

      const result = await fleetCreation(mockInput)

      // Verify the final result is exactly what processFleetResponse returned
      expect(result).toBe(expectedResult)
    })

    describe('Error handling', () => {
      it('validates launch template name before making any API calls', async () => {
        // Remove launch template name
        mockInput.launchTemplate.name = undefined

        // Should throw immediately without calling any mocks
        await expect(fleetCreation(mockInput)).rejects.toThrow(
          'launch template name not set'
        )

        // Verify no API calls were attempted
        expect(mockInput.ec2Ops.createFleet).not.toHaveBeenCalled()
      })

      it('catches and handles API errors without throwing', async () => {
        // Force an API error
        mockInput.ec2Ops.createFleet.mockRejectedValueOnce(
          new Error('API failure')
        )

        const result = await fleetCreation(mockInput)

        // Should return a failed status but not throw
        expect(result.status).toBe('failed')
        expect(result.instances).toEqual([])
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('API error')
        )
      })

      it('handles errors from buildFleetCreationInput by returning failed status', async () => {
        // Force build function to throw
        buildFleetCreationInput.mockImplementationOnce(() => {
          throw new Error('Build error')
        })

        const result = await fleetCreation(mockInput)

        expect(result.status).toBe('failed')
        expect(result.instances).toEqual([])
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('Build error')
        )
      })

      it('handles errors from processFleetResponse by returning failed status', async () => {
        // Force process function to throw
        processFleetResponse.mockImplementationOnce(() => {
          throw new Error('Process error')
        })

        const result = await fleetCreation(mockInput)

        expect(result.status).toBe('failed')
        expect(result.instances).toEqual([])
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('Process error')
        )
      })
    })
  })
})
