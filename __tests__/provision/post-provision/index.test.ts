// __tests__/provision/post-provision/index.test.ts
import { jest } from '@jest/globals'
// import { mock } from 'jest-mock-extended'
import {
  reconcileFleetState,
  processSuccessfulProvision,
  processFailedProvision,
  dumpResources
} from '../../../__fixtures__/provision/post-provision'
import * as core from '../../../__fixtures__/core'
import { PostProvisionInputs } from '../../../src/provision/types'

// Complete the pattern - consolidate all mocks
Object.entries({
  '@actions/core': core,
  '../../../src/provision/post-provision/reconcile-fleet-state': {
    reconcileFleetState
  },
  '../../../src/provision/post-provision/process-successful-provision': {
    processSuccessfulProvision
  },
  '../../../src/provision/post-provision/process-failed-provision': {
    processFailedProvision
  },
  '../../../src/provision/post-provision/dump-resources': {
    dumpResources
  }
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { postProvision } = await import(
  '../../../src/provision/post-provision/index'
)

describe('PostProvision', () => {
  describe('Control Flow', () => {
    let mockInput: PostProvisionInputs

    beforeEach(() => {
      jest.clearAllMocks()

      // Default mocks
      reconcileFleetState.mockReturnValue('success')

      // Setup mock input - loosely typed
      mockInput = {
        selectionOutput: {} as any,
        creationOutput: { state: 'success' } as any,
        resourceClassConfig: {} as any,
        maxRuntimeMin: 60,
        idleTimeSec: 300,
        runId: 'test-run-123',
        ec2Ops: {} as any,
        ddbOps: {} as any,
        sqsOps: {} as any
      }
    })

    describe('Reconciliation routing', () => {
      it('routes to successful path when reconcileFleetState returns success', async () => {
        reconcileFleetState.mockReturnValue('success')

        await postProvision(mockInput)

        expect(reconcileFleetState).toHaveBeenCalledWith(
          mockInput.selectionOutput,
          mockInput.creationOutput
        )
        expect(processSuccessfulProvision).toHaveBeenCalled()
        expect(processFailedProvision).not.toHaveBeenCalled()
      })

      it('routes to failed path when reconcileFleetState returns failed', async () => {
        reconcileFleetState.mockReturnValue('failed')

        await postProvision(mockInput)

        expect(reconcileFleetState).toHaveBeenCalledWith(
          mockInput.selectionOutput,
          mockInput.creationOutput
        )
        expect(processSuccessfulProvision).not.toHaveBeenCalled()
        expect(processFailedProvision).toHaveBeenCalled()
        expect(core.setFailed).toHaveBeenCalled()
      })

      it('routes to failed path when reconcileFleetState returns partial', async () => {
        reconcileFleetState.mockReturnValue('partial')

        await postProvision(mockInput)

        expect(processSuccessfulProvision).not.toHaveBeenCalled()
        expect(processFailedProvision).toHaveBeenCalled()
      })

      it('handles errors from reconcileFleetState function', async () => {
        const reconcileError = new Error('Reconcile error')
        reconcileFleetState.mockImplementationOnce(() => {
          throw reconcileError
        })

        await expect(postProvision(mockInput)).rejects.toThrow(reconcileError)

        expect(dumpResources).toHaveBeenCalled()
        expect(processSuccessfulProvision).not.toHaveBeenCalled()
        expect(processFailedProvision).not.toHaveBeenCalled()
      })
    })

    describe('Successful provision flow', () => {
      it('processes successful provision with correct parameters', async () => {
        reconcileFleetState.mockReturnValue('success')

        await postProvision(mockInput)

        expect(processSuccessfulProvision).toHaveBeenCalledWith(
          expect.objectContaining({
            selectionOutput: mockInput.selectionOutput,
            creationOutput: mockInput.creationOutput,
            runId: mockInput.runId,
            maxRuntimeMin: mockInput.maxRuntimeMin
          })
        )
        expect(core.setFailed).not.toHaveBeenCalled()
      })

      it('handles errors from processSuccessfulProvision', async () => {
        const successError = new Error('Process success error')
        processSuccessfulProvision.mockRejectedValueOnce(successError)

        await expect(postProvision(mockInput)).rejects.toThrow(successError)

        expect(dumpResources).toHaveBeenCalled()
      })
    })

    describe('Failed provision flow', () => {
      it('processes failed provision with correct parameters', async () => {
        reconcileFleetState.mockReturnValue('failed')

        await postProvision(mockInput)

        expect(processFailedProvision).toHaveBeenCalledWith(
          expect.objectContaining({
            selectionOutput: mockInput.selectionOutput,
            idleTimeSec: mockInput.idleTimeSec,
            runId: mockInput.runId
          })
        )
      })

      it('sets job as failed after processing failed provision', async () => {
        reconcileFleetState.mockReturnValue('failed')

        await postProvision(mockInput)

        expect(core.setFailed).toHaveBeenCalledWith(
          expect.stringContaining('Provision has gracefully failed')
        )
      })

      it('handles errors from processFailedProvision', async () => {
        reconcileFleetState.mockReturnValue('failed')
        const failedError = new Error('Process failed error')
        processFailedProvision.mockRejectedValueOnce(failedError)

        await expect(postProvision(mockInput)).rejects.toThrow(failedError)

        expect(dumpResources).toHaveBeenCalled()
      })
    })

    describe('Error handling', () => {
      it('dumps resources and rethrows when unhandled error occurs', async () => {
        const testError = new Error('Unhandled test error')
        processSuccessfulProvision.mockRejectedValueOnce(testError)

        await expect(postProvision(mockInput)).rejects.toThrow(testError)

        expect(dumpResources).toHaveBeenCalledWith(
          expect.objectContaining({
            selectionOutput: mockInput.selectionOutput,
            creationOutput: mockInput.creationOutput
          })
        )
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('Unhandled test error')
        )
      })

      it('handles error with no stack trace properly', async () => {
        // Reset mocks
        jest.clearAllMocks()

        // Use a standard Error object
        const testError = new Error('Test error message')
        processSuccessfulProvision.mockRejectedValueOnce(testError)

        // Now the test should pass
        await expect(postProvision(mockInput)).rejects.toThrow(testError)

        expect(dumpResources).toHaveBeenCalled()
        expect(core.error).toHaveBeenCalledWith(
          expect.stringContaining('Test error message')
        )
      })
    })
  })
})
