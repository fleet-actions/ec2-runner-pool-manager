// __tests__/provision/post-provision/reconcile-fleet-state.test.ts
import { jest } from '@jest/globals'
import * as core from '../../../__fixtures__/core.js'
import {
  CreationOuput,
  Instance,
  SelectionOutput
} from '../../../src/provision/types'
import { GenericInstance } from '../../../__fixtures__/generic.js'

Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { reconcileFleetState } = await import(
  '../../../src/provision/post-provision/reconcile-fleet-state'
)

describe('ReconcileFleetState', () => {
  describe('Control Flow', () => {
    let mockSelectionOutput: SelectionOutput
    let mockCreationOutput: CreationOuput
    const generic: Instance = GenericInstance

    beforeEach(() => {
      jest.clearAllMocks()

      mockSelectionOutput = {
        numInstancesRequired: 2,
        numInstancesSelected: 3,
        instances: [
          { ...generic, id: 'i-123' },
          { ...generic, id: 'i-456' },
          { ...generic, id: 'i-999' }
        ],
        labels: []
      }

      mockCreationOutput = {
        state: 'success',
        numInstancesCreated: 2,
        instances: [
          { ...generic, id: 'i-789' },
          { ...generic, id: 'i-012' }
        ],
        labels: []
      }
    })

    it('returns success when creation state is success and instance counts match', () => {
      const result = reconcileFleetState(
        mockSelectionOutput,
        mockCreationOutput
      )
      expect(result).toBe('success')
    })

    it('returns failed when creation state is not success', () => {
      mockCreationOutput.state = 'partial'
      const result = reconcileFleetState(
        mockSelectionOutput,
        mockCreationOutput
      )

      expect(result).toBe('failed')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Creation status is partial')
      )
    })

    it('returns failed when instance counts do not match', () => {
      mockCreationOutput.numInstancesCreated = 1
      const result = reconcileFleetState(
        mockSelectionOutput,
        mockCreationOutput
      )

      expect(result).toBe('failed')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Not all instances required instances were created'
        )
      )
    })

    it('returns failed when no instances are selected or created', () => {
      mockSelectionOutput.numInstancesSelected = 0
      mockCreationOutput.numInstancesCreated = 0

      const result = reconcileFleetState(
        mockSelectionOutput,
        mockCreationOutput
      )

      expect(result).toBe('failed')
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('No instances are selected or created')
      )
    })
  })
})
