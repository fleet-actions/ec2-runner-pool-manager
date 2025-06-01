// __tests__/provision/post-provision/dump-resources.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../../__fixtures__/core'
import { InstanceOperations as DDBInstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations'
import { InstanceOperations as EC2InstanceOperations } from '../../../src/services/ec2/operations/instance-operations'
import { DumpResourcesInput } from '../../../src/provision/post-provision/dump-resources'
import { Instance } from '../../../src/provision/types'
import { GenericInstance } from '../../../__fixtures__/generic'

// Mock dependencies
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { dumpResources } = await import(
  '../../../src/provision/post-provision/dump-resources'
)

describe('dumpResources', () => {
  let mockInput: DumpResourcesInput
  let mockDDBOps: MockProxy<DDBInstanceOperations>
  let mockEC2Ops: MockProxy<EC2InstanceOperations>

  const generic: Instance = GenericInstance

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mocks for operations
    mockDDBOps = mock<DDBInstanceOperations>()
    mockEC2Ops = mock<EC2InstanceOperations>()

    // Setup default mock behaviors
    mockDDBOps.deleteInstanceItems.mockResolvedValue([])
    mockEC2Ops.terminateInstances.mockResolvedValue(undefined as any)

    // Setup input with empty arrays by default
    mockInput = {
      selectionOutput: {
        instances: [],
        labels: [],
        numInstancesSelected: 0,
        numInstancesRequired: 0
      },
      creationOutput: {
        state: 'success',
        instances: [],
        labels: [],
        numInstancesCreated: 0
      },
      runId: 'test-run-123',
      ec2Ops: mockEC2Ops,
      ddbOps: mockDDBOps
    }
  })

  describe('Control Flow', () => {
    it('logs start and completion of resource cleanup process', async () => {
      await dumpResources(mockInput)

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting resource dump routine')
      )
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Resource dump routine completed')
      )
    })

    it('handles empty instance arrays gracefully', async () => {
      await dumpResources(mockInput)

      // Since both arrays are empty, deleteInstanceItems and terminateInstances should not be called
      expect(mockDDBOps.deleteInstanceItems).not.toHaveBeenCalled()
      expect(mockEC2Ops.terminateInstances).not.toHaveBeenCalled()
    })

    it('logs that there are no selected instances to dump when selection is empty', async () => {
      // Ensure selection output is empty
      mockInput.selectionOutput.instances = []

      // But creation output has instances
      mockInput.creationOutput.instances = [{ ...generic, id: 'i-created1' }]

      await dumpResources(mockInput)

      // Verify the appropriate message was logged
      expect(core.info).toHaveBeenCalledWith(
        'There are no selected instances to dump'
      )
    })

    it('logs that there are no created instances to dump when creation is empty', async () => {
      // Ensure creation output is empty
      mockInput.creationOutput.instances = []

      // But selection output has instances
      mockInput.selectionOutput.instances = [{ ...generic, id: 'i-sel1' }]

      await dumpResources(mockInput)

      // Verify the appropriate message was logged
      expect(core.info).toHaveBeenCalledWith(
        'There are no created instances to dump'
      )
    })

    it('processes selected instances with proper isolation', async () => {
      // Add selected instances
      mockInput.selectionOutput.instances = [
        { ...generic, id: 'i-sel1' },
        { ...generic, id: 'i-sel2' }
      ]

      // Mock successful isolation for one instance
      mockDDBOps.deleteInstanceItems.mockImplementation((_, runId) => {
        if (runId === 'test-run-123') {
          return Promise.resolve([{ status: 'fulfilled', value: 'i-sel1' }])
        }
        return Promise.resolve([])
      })
      await dumpResources(mockInput)

      // Verify deletion was attempted with runId for isolation
      expect(mockDDBOps.deleteInstanceItems).toHaveBeenCalledWith(
        ['i-sel1', 'i-sel2'],
        'test-run-123'
      )

      // Verify only isolated instance is terminated
      expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith(['i-sel1'])
    })

    it('processes created instances without isolation check', async () => {
      // Add created instances
      mockInput.creationOutput.instances = [
        { ...generic, id: 'i-created1' },
        { ...generic, id: 'i-created2' }
      ]

      await dumpResources(mockInput)

      // Verify deletion was attempted without runId (no isolation)
      expect(mockDDBOps.deleteInstanceItems).toHaveBeenCalledWith([
        'i-created1',
        'i-created2'
      ])

      // Verify all created instances are terminated
      expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith([
        'i-created1',
        'i-created2'
      ])
    })

    it('processes both selected and created instances', async () => {
      // Add both selected and created instances
      mockInput.selectionOutput.instances = [{ ...generic, id: 'i-sel1' }]
      mockInput.creationOutput.instances = [{ ...generic, id: 'i-created1' }]

      // Mock successful isolation
      mockDDBOps.deleteInstanceItems.mockImplementation((_, runId) => {
        if (runId === 'test-run-123') {
          return Promise.resolve([{ status: 'fulfilled', value: 'i-sel1' }])
        }
        return Promise.resolve([])
      })

      await dumpResources(mockInput)

      // Verify both sets of operations were called
      expect(mockDDBOps.deleteInstanceItems).toHaveBeenCalledWith(
        ['i-sel1'],
        'test-run-123'
      )
      expect(mockDDBOps.deleteInstanceItems).toHaveBeenCalledWith([
        'i-created1'
      ])
      expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith(['i-sel1'])
      expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith(['i-created1'])
    })

    it('only terminates selected instances with successful deletion responses', async () => {
      // Add selected instances
      mockInput.selectionOutput.instances = [
        { ...generic, id: 'i-success' },
        { ...generic, id: 'i-fail' },
        { ...generic, id: 'i-rejected' }
      ]

      // Mock a mix of successful and rejected deletion responses
      mockDDBOps.deleteInstanceItems.mockResolvedValue([
        { status: 'fulfilled', value: 'i-success' },
        { status: 'rejected', reason: 'DB error' },
        { status: 'fulfilled', value: 'i-fail' }
      ])

      await dumpResources(mockInput)

      // Verify only the successfully deleted instances are terminated
      expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith([
        'i-success',
        'i-fail'
      ])

      // Verify we logged the correct count
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Successfully verified and deleted 2/3 selected instances'
        )
      )
    })

    it('continues execution even if operations fail', async () => {
      mockInput.selectionOutput.instances = [{ ...generic, id: 'i-sel1' }]
      mockInput.creationOutput.instances = [{ ...generic, id: 'i-created1' }]

      // Mock failures
      mockDDBOps.deleteInstanceItems.mockRejectedValue(new Error('DB error'))
      mockEC2Ops.terminateInstances.mockRejectedValue(new Error('EC2 error'))

      // Should not throw
      await dumpResources(mockInput)

      // Should still complete the process
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining('Resource dump routine completed')
      )
    })
  })
})
