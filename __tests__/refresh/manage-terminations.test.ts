// __tests__/refresh/manage-terminations/manage-terminations.test.ts
import { jest } from '@jest/globals'
import * as core from '../../__fixtures__/core' // Mock for @actions/core
import { mock, MockProxy } from 'jest-mock-extended'

// Import types and classes to be mocked or used
import {
  InstanceOperations as DDBInstanceOperations,
  InstanceItem
} from '../../src/services/dynamodb/operations/instance-operations'
import { InstanceOperations as EC2InstanceOperations } from '../../src/services/ec2/operations/instance-operations'
// import { BootstrapOperations } from '../../src/services/dynamodb/operations/bootstrap-operations'
import { WorkerSignalOperations } from '../../src/services/dynamodb/operations/signal-operations'
import { HeartbeatOperations } from '../../src/services/dynamodb/operations/heartbeat-operations'

// Import the function to test and its input type
import type { ManageTerminationsInputs } from '../../src/refresh/manage-terminations'

// Mock @actions/core
Object.entries({
  '@actions/core': core
}).forEach(([path, mockModule]) => {
  jest.unstable_mockModule(path, () => mockModule)
})

const { manageTerminations } = await import(
  '../../src/refresh/manage-terminations'
)

describe('manageTerminations', () => {
  let mockDDBInstanceOperations: MockProxy<DDBInstanceOperations>
  let mockDDBHeartbeatOperations: MockProxy<HeartbeatOperations>
  let mockWorkerSignalOperations: MockProxy<WorkerSignalOperations>
  let mockEC2Ops: MockProxy<EC2InstanceOperations>
  let manageTerminationsInput: ManageTerminationsInputs

  // Adjusted createMockInstanceItem based on the provided InstanceItem type
  const createMockInstanceItem = (
    id: string,
    state: 'idle' | 'claimed' | 'running', // These are the states manageTerminations queries for
    runId: string = `test-run-id-${id}`, // Default to a string as per InstanceItem
    threshold?: string // ISO string for the threshold
  ): InstanceItem => {
    return {
      PK: '',
      SK: '',
      entityType: '',
      updatedAt: '',
      identifier: id,
      resourceClass: 'test-rc', // Included as per InstanceItem
      instanceType: 'm5.large', // Included as per InstanceItem
      state,
      runId,
      threshold: threshold || new Date(Date.now() - 3600 * 1000).toISOString() // Expired an hour ago by default
    }
  }

  beforeEach(() => {
    jest.clearAllMocks() // Clear all mocks including core.info

    mockDDBInstanceOperations = mock<DDBInstanceOperations>()
    mockDDBHeartbeatOperations = mock<HeartbeatOperations>()
    mockWorkerSignalOperations = mock<WorkerSignalOperations>()
    mockEC2Ops = mock<EC2InstanceOperations>()

    manageTerminationsInput = {
      ddbOps: {
        instanceOperations: mockDDBInstanceOperations,
        heartbeatOperations: mockDDBHeartbeatOperations,
        workerSignalOperations: mockWorkerSignalOperations
      },
      ec2Ops: mockEC2Ops
    }

    // Default successful mocks
    mockEC2Ops.terminateInstances.mockResolvedValue(undefined as any)
    mockWorkerSignalOperations.deleteItem.mockResolvedValue(undefined)
    mockWorkerSignalOperations.deleteItem.mockResolvedValue(undefined)
  })

  it('should log "No instances marked for termination" and not call EC2 terminate if no expired instances are found', async () => {
    mockDDBInstanceOperations.getExpiredInstancesByStates.mockResolvedValue([])

    await manageTerminations(manageTerminationsInput)

    expect(core.info).toHaveBeenCalledWith(
      'Performing instance terminations...'
    )
    expect(
      mockDDBInstanceOperations.getExpiredInstancesByStates
    ).toHaveBeenCalledWith(['idle', 'claimed', 'running'])
    expect(core.info).toHaveBeenCalledWith(
      '--- Instance Termination Diagnostics ---'
    )
    expect(core.info).toHaveBeenCalledWith(
      'Num of instances initially marked for termination: 0'
    )
    expect(core.info).toHaveBeenCalledWith('By state: {}')
    expect(core.info).toHaveBeenCalledWith('Successful transitions: 0')
    expect(core.info).toHaveBeenCalledWith('Failed transitions: 0')
    expect(core.info).toHaveBeenCalledWith(
      'No instances marekd for termination' // Note: "marekd" is a typo in the original code
    )
    expect(core.info).toHaveBeenCalledWith('Completed instance terminations...')
    expect(
      mockDDBInstanceOperations.instanceStateTransition
    ).not.toHaveBeenCalled()
    expect(mockEC2Ops.terminateInstances).not.toHaveBeenCalled()
  })

  it('should terminate instances that are successfully transitioned in DDB', async () => {
    const instance1 = createMockInstanceItem('i-123', 'idle')
    const instance2 = createMockInstanceItem('i-456', 'running')
    const expiredInstances = [instance1, instance2]

    mockDDBInstanceOperations.getExpiredInstancesByStates.mockResolvedValue(
      expiredInstances
    )

    // Mock DDB instanceStateTransition for instance1
    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(
        expect.objectContaining({
          id: instance1.identifier,
          expectedState: instance1.state,
          expectedRunID: instance1.runId
        })
      )
      .mockResolvedValue({ Attributes: {} } as any)

    // Mock DDB instanceStateTransition for instance2
    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(
        expect.objectContaining({
          id: instance2.identifier,
          expectedState: instance2.state,
          expectedRunID: instance2.runId
        })
      )
      .mockResolvedValue({ Attributes: {} } as any)

    await manageTerminations(manageTerminationsInput)

    expect(core.info).toHaveBeenCalledWith(
      'Performing instance terminations...'
    )
    expect(
      mockDDBInstanceOperations.getExpiredInstancesByStates
    ).toHaveBeenCalledWith(['idle', 'claimed', 'running'])
    expect(
      mockDDBInstanceOperations.instanceStateTransition
    ).toHaveBeenCalledTimes(2)
    expect(
      mockDDBInstanceOperations.instanceStateTransition
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: instance1.identifier,
        expectedState: instance1.state,
        expectedRunID: instance1.runId
      })
    )
    expect(
      mockDDBInstanceOperations.instanceStateTransition
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: instance2.identifier,
        expectedState: instance2.state,
        expectedRunID: instance2.runId
      })
    )

    expect(core.info).toHaveBeenCalledWith(
      '--- Instance Termination Diagnostics ---'
    )
    expect(core.info).toHaveBeenCalledWith(
      `Num of instances initially marked for termination: ${expiredInstances.length}`
    )
    expect(core.info).toHaveBeenCalledWith(
      `By state: {"${instance1.state}":1,"${instance2.state}":1}` // More specific state check
    )
    expect(core.info).toHaveBeenCalledWith(
      `Successful transitions: ${expiredInstances.length}`
    )
    expect(core.info).toHaveBeenCalledWith(`Failed transitions: 0`)

    expect(core.info).toHaveBeenCalledWith(
      `Sending termination signals to the following instances: ${instance1.identifier},${instance2.identifier}`
    )
    expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith([
      instance1.identifier,
      instance2.identifier
    ])
    expect(core.info).toHaveBeenCalledWith(`Termination signals sent...`)
    expect(core.info).toHaveBeenCalledWith('Completed instance terminations...')
  })

  it('should only terminate instances that successfully transition, and log failures', async () => {
    const instanceSuccess = createMockInstanceItem('i-success', 'claimed')
    const instanceFail = createMockInstanceItem('i-fail', 'idle')
    const expiredInstances = [instanceSuccess, instanceFail]

    mockDDBInstanceOperations.getExpiredInstancesByStates.mockResolvedValue(
      expiredInstances
    )

    // Simulate instanceSuccess succeeding
    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(
        expect.objectContaining({
          id: instanceSuccess.identifier,
          expectedState: instanceSuccess.state,
          expectedRunID: instanceSuccess.runId
        })
      )
      .mockResolvedValue({ Attributes: {} } as any)

    // Simulate instanceFail failing
    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(
        expect.objectContaining({
          id: instanceFail.identifier,
          expectedState: instanceFail.state,
          expectedRunID: instanceFail.runId
        })
      )
      .mockRejectedValue(new Error('DDB conditional check failed'))

    await manageTerminations(manageTerminationsInput)

    expect(
      mockDDBInstanceOperations.instanceStateTransition
    ).toHaveBeenCalledTimes(2)
    expect(core.info).toHaveBeenCalledWith(
      '--- Instance Termination Diagnostics ---'
    )
    expect(core.info).toHaveBeenCalledWith(
      `Num of instances initially marked for termination: ${expiredInstances.length}`
    )
    expect(core.info).toHaveBeenCalledWith(
      `By state: {"${instanceSuccess.state}":1,"${instanceFail.state}":1}`
    )
    expect(core.info).toHaveBeenCalledWith(`Successful transitions: 1`)
    expect(core.info).toHaveBeenCalledWith(`Failed transitions: 1`)
    expect(core.info).toHaveBeenCalledWith(
      'Detailed information about successful transitions:'
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`ID: ${instanceSuccess.identifier}`)
    )
    expect(core.info).toHaveBeenCalledWith(
      'Detailed information about failed transitions:'
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`ID: ${instanceFail.identifier}`)
    )

    expect(core.info).toHaveBeenCalledWith(
      `Sending termination signals to the following instances: ${instanceSuccess.identifier}`
    )
    expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith([
      instanceSuccess.identifier
    ])
    expect(mockEC2Ops.terminateInstances).toHaveBeenCalledTimes(1)
  })

  it('should not call EC2 terminate if all DDB transitions fail', async () => {
    const instance1 = createMockInstanceItem('i-fail1', 'idle')
    const instance2 = createMockInstanceItem('i-fail2', 'running')
    const expiredInstances = [instance1, instance2]

    mockDDBInstanceOperations.getExpiredInstancesByStates.mockResolvedValue(
      expiredInstances
    )
    // All instanceStateTransition calls will fail due to this general mock
    mockDDBInstanceOperations.instanceStateTransition.mockRejectedValue(
      new Error('DDB conditional check failed')
    )

    await manageTerminations(manageTerminationsInput)

    expect(
      mockDDBInstanceOperations.instanceStateTransition
    ).toHaveBeenCalledTimes(expiredInstances.length)
    expect(core.info).toHaveBeenCalledWith(
      '--- Instance Termination Diagnostics ---'
    )
    expect(core.info).toHaveBeenCalledWith(
      `Num of instances initially marked for termination: ${expiredInstances.length}`
    )
    expect(core.info).toHaveBeenCalledWith(
      `By state: {"${instance1.state}":1,"${instance2.state}":1}`
    )
    expect(core.info).toHaveBeenCalledWith(`Successful transitions: 0`)
    expect(core.info).toHaveBeenCalledWith(
      `Failed transitions: ${expiredInstances.length}`
    )
    expect(core.info).toHaveBeenCalledWith(
      'Detailed information about failed transitions:'
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`ID: ${instance1.identifier}`)
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`ID: ${instance2.identifier}`)
    )

    expect(core.info).toHaveBeenCalledWith(
      'No instances marekd for termination' // Typo from original
    )
    expect(mockEC2Ops.terminateInstances).not.toHaveBeenCalled()
  })

  it('should correctly log instance details for successful and failed transitions including empty runId', async () => {
    const idleInstance = createMockInstanceItem(
      'i-idle-success',
      'idle',
      'run-idle'
    )
    // Create an instance with an empty string for runId to test `|| 'none'`
    const claimedInstanceEmptyRunId = createMockInstanceItem(
      'i-claimed-fail',
      'claimed',
      ''
    )
    const runningInstance = createMockInstanceItem(
      'i-running-success',
      'running',
      'run-running'
    )
    const expiredInstances = [
      idleInstance,
      claimedInstanceEmptyRunId,
      runningInstance
    ]

    mockDDBInstanceOperations.getExpiredInstancesByStates.mockResolvedValue(
      expiredInstances
    )

    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(expect.objectContaining({ id: idleInstance.identifier }))
      .mockResolvedValue({ Attributes: {} } as any)
    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(
        expect.objectContaining({ id: claimedInstanceEmptyRunId.identifier })
      )
      .mockRejectedValue(new Error('DDB error'))
    mockDDBInstanceOperations.instanceStateTransition
      .calledWith(expect.objectContaining({ id: runningInstance.identifier }))
      .mockResolvedValue({ Attributes: {} } as any)

    await manageTerminations(manageTerminationsInput)

    // Check logs for successful items
    expect(core.info).toHaveBeenCalledWith(
      'Detailed information about successful transitions:'
    )
    expect(core.info).toHaveBeenCalledWith(
      `  - ID: ${idleInstance.identifier}, State: ${idleInstance.state}, RunID: ${idleInstance.runId}`
    )
    expect(core.info).toHaveBeenCalledWith(
      `  - ID: ${runningInstance.identifier}, State: ${runningInstance.state}, RunID: ${runningInstance.runId}`
    )

    // Check logs for failed items
    expect(core.info).toHaveBeenCalledWith(
      'Detailed information about failed transitions:'
    )
    // For claimedInstanceEmptyRunId, runId is "", so (item.runId || 'none') becomes 'none'
    expect(core.info).toHaveBeenCalledWith(
      `  - ID: ${claimedInstanceEmptyRunId.identifier}, State: ${claimedInstanceEmptyRunId.state}, RunID: none`
    )

    // Check summary logs
    expect(core.info).toHaveBeenCalledWith(
      'By state: {"idle":1,"claimed":1,"running":1}'
    )
    expect(core.info).toHaveBeenCalledWith('Successful transitions: 2')
    expect(core.info).toHaveBeenCalledWith('Failed transitions: 1')

    expect(mockEC2Ops.terminateInstances).toHaveBeenCalledWith([
      idleInstance.identifier,
      runningInstance.identifier
    ])
  })
})
