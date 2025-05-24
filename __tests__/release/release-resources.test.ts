// __tests__/release/release-resources.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../__fixtures__/core' // Assuming you have a similar mock for @actions/core
import { transitionToIdle, releaseWorker } from '../../__fixtures__/release'
import {
  InstanceOperations,
  InstanceItem,
  InstanceStates
} from '../../src/services/dynamodb/operations/instance-operations'
import type { ResourceClassConfigOperations } from '../../src/services/sqs/operations/resource-class-operations'
import { ResourceClassConfig } from '../../src/services/types'
import type { ReleaseResourcesInput } from '../../src/release/release-resources'
import { WorkerSignalOperations } from '../../src/services/dynamodb/operations/signal-operations'

// Mock @actions/core and other modules
Object.entries({
  '@actions/core': core,
  '../../src/release/transition-to-idle.js': {
    transitionToIdle
  },
  '../../src/release/release-workers': { releaseWorker }
}).forEach(([path, mockModule]) => {
  jest.unstable_mockModule(path, () => mockModule)
})

const { releaseResources } = await import('../../src/release/release-resources')

describe('releaseResources', () => {
  let mockInstanceOperations: MockProxy<InstanceOperations>
  let mockWorkerSignalOps: MockProxy<WorkerSignalOperations>
  let mockSqsOps: MockProxy<ResourceClassConfigOperations>
  let releaseResourcesInput: ReleaseResourcesInput

  const sampleResourceClass = 'large'
  const sampleInstanceType = 'c5.large'
  const sampleRunId = 'test-run-id-release-123'
  const sampleIdleTimeSec = 300
  const sampleResourceClassConfig: ResourceClassConfig = {
    large: { cpu: 2, mmem: 4096, queueUrl: 'queueurl.com' }
  }

  // Corrected helper function based on the InstanceItem definition
  const createMockInstanceItem = (
    identifier: string,
    state: InstanceStates,
    runIdInput?: string // Renamed to avoid conflict with InstanceItem.runId
  ): InstanceItem => {
    const nowISO = new Date().toISOString()
    return {
      // Properties from BasicItem (these would be set by DynamoDB operations)
      // For mocking purposes, we might not need all of them if the functions
      // under test (transitionToIdle, releaseWorker mocks) don't rely on them.
      // However, for completeness if they were needed:
      PK: `INSTANCE#${sampleResourceClassConfig.resourceClass}`, // Example PK
      SK: identifier, // Example SK
      entityType: 'INSTANCE',
      updatedAt: nowISO,

      // InstanceItem specific properties
      identifier,
      state,
      threshold: nowISO, // Added: Important for state transitions, using current time as a default
      runId: runIdInput || sampleRunId, // Uses input or a default sampleRunId
      resourceClass: sampleResourceClass, // From config
      instanceType: sampleInstanceType // Added: From config
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockInstanceOperations = mock<InstanceOperations>()
    mockWorkerSignalOps = mock<WorkerSignalOperations>()
    mockSqsOps = mock<ResourceClassConfigOperations>()

    releaseResourcesInput = {
      resourceClassConfig: sampleResourceClassConfig,
      runId: sampleRunId,
      idleTimeSec: sampleIdleTimeSec,
      ddbOps: {
        instanceOperations: mockInstanceOperations,
        workerSignalOperations: mockWorkerSignalOps
      },
      sqsOps: mockSqsOps
    }

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue([])
    transitionToIdle.mockResolvedValue({ successful: [], unsuccessful: [] })
    releaseWorker.mockResolvedValue(undefined) // successful return
  })

  it('should warn but complete successfully when no instances are found', async () => {
    await releaseResources(releaseResourcesInput)

    expect(mockInstanceOperations.getInstancesByRunId).toHaveBeenCalledWith(
      sampleRunId
    )
    expect(transitionToIdle).not.toHaveBeenCalled()
    expect(releaseWorker).not.toHaveBeenCalled()
    expect(core.error).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('No instances were found to release')
    )
  })

  it('should process running instances and release them successfully', async () => {
    // Create mock running instances
    const runningInstances = [
      createMockInstanceItem('i-123', 'running'),
      createMockInstanceItem('i-456', 'running')
    ]

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue(
      runningInstances
    )
    transitionToIdle.mockResolvedValue({
      successful: runningInstances,
      unsuccessful: []
    })

    await releaseResources(releaseResourcesInput)

    expect(transitionToIdle).toHaveBeenCalledWith(
      runningInstances,
      sampleRunId,
      sampleIdleTimeSec,
      mockInstanceOperations
    )
    expect(releaseWorker).toHaveBeenCalledTimes(2)
    expect(core.error).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith('Release completed successfully 🎉')
  })

  it('should handle instances with transition failures', async () => {
    // Create mock running instances
    const runningInstances = [
      createMockInstanceItem('i-123', 'running'),
      createMockInstanceItem('i-456', 'running'),
      createMockInstanceItem('i-789', 'running')
    ]

    const successfulInstances = [runningInstances[0], runningInstances[1]]
    const unsuccessfulInstances = [runningInstances[2]]

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue(
      runningInstances
    )
    transitionToIdle.mockResolvedValue({
      successful: successfulInstances,
      unsuccessful: unsuccessfulInstances
    })

    await releaseResources(releaseResourcesInput)

    // Verify transition was attempted
    expect(transitionToIdle).toHaveBeenCalledWith(
      runningInstances,
      sampleRunId,
      sampleIdleTimeSec,
      mockInstanceOperations
    )

    // Verify only successful transitions were released
    expect(releaseWorker).toHaveBeenCalledTimes(2)
    expect(core.warning).toHaveBeenCalled()
    expect(core.error).toHaveBeenCalled()
  })

  it('should handle instances in various states', async () => {
    // Create mock instances in different states
    const instances = [
      createMockInstanceItem('i-123', 'running'),
      createMockInstanceItem('i-456', 'idle'),
      createMockInstanceItem('i-789', 'claimed'),
      createMockInstanceItem('i-abc', 'terminated'),
      createMockInstanceItem('i-def', 'created')
    ]

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue(instances)

    // Only the running instance should be processed
    const runningInstances = [instances[0]]
    transitionToIdle.mockResolvedValue({
      successful: runningInstances,
      unsuccessful: []
    })

    await releaseResources(releaseResourcesInput)

    // Verify only running instances were processed
    expect(transitionToIdle).toHaveBeenCalledWith(
      [instances[0]], // Only the running instance
      sampleRunId,
      sampleIdleTimeSec,
      mockInstanceOperations
    )

    // Verify release was called for the successful transitions
    expect(releaseWorker).toHaveBeenCalledTimes(1)

    // Verify warning was generated for idle instances
    expect(core.warning).toHaveBeenCalled()
    expect(core.error).toHaveBeenCalled()
  })

  it('should generate warnings for instances in idle state', async () => {
    // Create mock instances including idle ones
    const instances = [
      createMockInstanceItem('i-123', 'running'),
      createMockInstanceItem('i-456', 'idle'),
      createMockInstanceItem('i-789', 'idle')
    ]

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue(instances)

    // Only the running instance should be processed
    const runningInstances = [instances[0]]
    transitionToIdle.mockResolvedValue({
      successful: runningInstances,
      unsuccessful: []
    })

    await releaseResources(releaseResourcesInput)

    // Verify warnings were generated for idle instances
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Found instances with runId test-run-id-release-123 that are in 'idle' state"
      )
    )
    expect(core.error).toHaveBeenCalled()
  })

  it('should collect and report all error messages', async () => {
    // Create mock instances with various issues
    const runningInstances = [
      createMockInstanceItem('i-123', 'running'),
      createMockInstanceItem('i-456', 'running')
    ]
    const idleInstances = [createMockInstanceItem('i-789', 'idle')]

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue([
      ...runningInstances,
      ...idleInstances
    ])

    // Simulate transition failure for one instance
    transitionToIdle.mockResolvedValue({
      successful: [runningInstances[0]],
      unsuccessful: [runningInstances[1]]
    })

    await releaseResources(releaseResourcesInput)

    // Verify only successful transitions were released
    expect(releaseWorker).toHaveBeenCalledTimes(1)

    // Verify error messages were collected and reported
    expect(core.warning).toHaveBeenCalledTimes(2) // One for idle, one for unsuccessful
    expect(core.error).toHaveBeenCalledWith(
      expect.stringContaining('Release completed with errors')
    )
  })

  it('should continue processing successful transitions even with errors', async () => {
    // Create mock instances with issues
    const instances = [
      createMockInstanceItem('i-123', 'running'),
      createMockInstanceItem('i-456', 'running'),
      createMockInstanceItem('i-789', 'idle')
    ]

    mockInstanceOperations.getInstancesByRunId.mockResolvedValue(instances)

    // Simulate partial success in transitions
    const runningInstances = [instances[0], instances[1]]
    transitionToIdle.mockResolvedValue({
      successful: [runningInstances[0]],
      unsuccessful: [runningInstances[1]]
    })

    await releaseResources(releaseResourcesInput)

    // Verify only successful transitions were released
    expect(releaseWorker).toHaveBeenCalledTimes(1)
    expect(releaseWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceItem: runningInstances[0],
        resourceClassConfig: sampleResourceClassConfig,
        runId: sampleRunId,
        workerNum: 0
      })
    )

    // Verify error reporting
    expect(core.error).toHaveBeenCalled()
  })
})
