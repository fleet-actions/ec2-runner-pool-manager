// __tests__/release/release-workers.test.ts
import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import * as core from '../../__fixtures__/core' // Assuming a mock for @actions/core
import {
  InstanceItem,
  InstanceOperations
} from '../../src/services/dynamodb/operations/instance-operations'
import { WorkerSignalOperations } from '../../src/services/dynamodb/operations/signal-operations'
import {
  ResourceClassConfigOperations,
  InstanceMessage
} from '../../src/services/sqs/operations/resource-class-operations'
import { ResourceClassConfig } from '../../src/services/types'
import { Timing } from '../../src/services/constants'
import { ReleaseWorkerInputs } from '../../src/release/release-workers'

// Mock @actions/core
jest.unstable_mockModule('@actions/core', () => core)

// Import the function to test AFTER mocks are set up
const { releaseWorker } = await import('../../src/release/release-workers')

describe('releaseWorker', () => {
  let mockInstanceOperations: MockProxy<InstanceOperations>
  let mockWorkerSignalOperations: MockProxy<WorkerSignalOperations>
  let mockSqsOps: MockProxy<ResourceClassConfigOperations>
  let baseInputs: ReleaseWorkerInputs

  const sampleInstanceId = 'i-testWorker123'
  const sampleResourceClass = 'gpu-medium'
  const sampleInstanceType = 'g4dn.xlarge'
  const sampleRunId = 'run-id-for-worker-release'
  const sampleWorkerNum = 1 // workerNum is still logged, but we won't assert the log
  const sampleCpu = 4
  const sampleMmem = 16384

  const sampleResourceClassConfig: ResourceClassConfig = {
    [sampleResourceClass]: {
      cpu: sampleCpu,
      mmem: sampleMmem,
      queueUrl: 'https://sqs.example.com/test-queue'
    }
  }

  const sampleInstanceItem: InstanceItem = {
    identifier: sampleInstanceId,
    resourceClass: sampleResourceClass,
    instanceType: sampleInstanceType,
    PK: `INSTANCE#${sampleResourceClass}`,
    SK: sampleInstanceId,
    entityType: 'INSTANCE',
    updatedAt: new Date().toISOString(),
    state: 'running',
    threshold: new Date().toISOString(),
    runId: sampleRunId
  }

  beforeEach(() => {
    jest.clearAllMocks() // Clears all mocks, including core

    mockInstanceOperations = mock<InstanceOperations>()
    mockWorkerSignalOperations = mock<WorkerSignalOperations>()
    mockSqsOps = mock<ResourceClassConfigOperations>()

    baseInputs = {
      instanceItem: sampleInstanceItem,
      resourceClassConfig: sampleResourceClassConfig,
      runId: sampleRunId,
      ddbOps: {
        instanceOperations: mockInstanceOperations,
        workerSignalOperations: mockWorkerSignalOperations
      },
      sqsOps: mockSqsOps,
      workerNum: sampleWorkerNum
    }
  })

  it('should successfully release a worker when the signal is found', async () => {
    mockWorkerSignalOperations.pollOnSignal.mockResolvedValue({
      state: true,
      message: 'Signal found'
    })

    await releaseWorker(baseInputs)

    expect(mockWorkerSignalOperations.pollOnSignal).toHaveBeenCalledWith({
      instanceIds: [sampleInstanceId],
      runId: sampleRunId,
      signal: WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG_REMOVE_RUN,
      timeoutSeconds: Timing.WORKER_RELEASE_TIMEOUT,
      intervalSeconds: Timing.WORKER_RELEASE_INTERVAL
    })

    const expectedInstanceMessage: InstanceMessage = {
      id: sampleInstanceId,
      resourceClass: sampleResourceClass,
      instanceType: sampleInstanceType,
      cpu: sampleCpu,
      mmem: sampleMmem
    }
    expect(mockSqsOps.sendResourceToPool).toHaveBeenCalledWith(
      expectedInstanceMessage,
      sampleResourceClassConfig
    )
    expect(mockInstanceOperations.expireInstance).not.toHaveBeenCalled()
  })

  it('should mark instance for expiration if the signal is not found', async () => {
    const failureMessage = 'Timeout waiting for UD_REMOVE_REG_REMOVE_RUN'
    mockWorkerSignalOperations.pollOnSignal.mockResolvedValue({
      state: false,
      message: failureMessage
    })

    await releaseWorker(baseInputs)

    expect(mockWorkerSignalOperations.pollOnSignal).toHaveBeenCalledWith({
      instanceIds: [sampleInstanceId],
      runId: sampleRunId,
      signal: WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG_REMOVE_RUN,
      timeoutSeconds: Timing.WORKER_RELEASE_TIMEOUT,
      intervalSeconds: Timing.WORKER_RELEASE_INTERVAL
    })

    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
    expect(mockInstanceOperations.expireInstance).toHaveBeenCalledWith({
      id: sampleInstanceId,
      runId: '',
      state: null
    })
  })
})
