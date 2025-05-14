// __tests__/provision/selection/claim-worker.test.ts
import { jest } from '@jest/globals'
import * as core from '../../../__fixtures__/core' // Mock for @actions/core
import { mock, MockProxy } from 'jest-mock-extended'

// Import types and classes to be mocked or used
import { PoolPickUpManager } from '../../../src/provision/selection/pool-pickup-manager'
import { InstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations'
import { HeartbeatOperations } from '../../../src/services/dynamodb/operations/heartbeat-operations'
import { Instance } from '../../../src/provision/types'

// Import the function to test and its input type
import type { ClaimWorkerInput } from '../../../src/provision/selection/claim-worker'

// Mock @actions/core
Object.entries({
  '@actions/core': core
}).forEach(([path, mockModule]) => {
  jest.unstable_mockModule(path, () => mockModule)
})

// Dynamically import HeartbeatOperations to access its static members after mocks
let ActualHeartbeatOperations: typeof HeartbeatOperations

const { claimWorker } = await import(
  '../../../src/provision/selection/claim-worker'
)

describe('claimWorker', () => {
  let mockPoolPickupManager: MockProxy<PoolPickUpManager>
  let mockInstanceOps: MockProxy<InstanceOperations>
  let mockHeartbeatOps: MockProxy<HeartbeatOperations>
  let claimWorkerInput: ClaimWorkerInput

  const sampleRunId = 'test-run-id-123'
  const sampleResourceClass = 'test-rc'
  const workerNum = 1

  const createMockInstance = (id: string): Instance => ({
    id,
    resourceClass: sampleResourceClass,
    instanceType: 'm5.large',
    cpu: 4,
    mmem: 8192
    // Add other necessary Instance properties if needed by claimWorker's logic directly
    // For these tests, only 'id' is directly used from the instance by claimWorker itself.
  })

  beforeAll(async () => {
    // Import the real HeartbeatOperations to access the static properties
    const hoModule = await import(
      '../../../src/services/dynamodb/operations/heartbeat-operations'
    )
    ActualHeartbeatOperations = hoModule.HeartbeatOperations
  })

  beforeEach(() => {
    jest.clearAllMocks()

    mockPoolPickupManager = mock<PoolPickUpManager>()
    mockInstanceOps = mock<InstanceOperations>()
    mockHeartbeatOps = mock<HeartbeatOperations>()

    claimWorkerInput = {
      workerNumber: workerNum,
      resourceClass: sampleResourceClass,
      poolPickupManager: mockPoolPickupManager,
      ddbOps: {
        instanceOperations: mockInstanceOps,
        heartbeatOperations: mockHeartbeatOps
      },
      runId: sampleRunId
    }

    // Default successful mocks
    mockInstanceOps.instanceStateTransition.mockResolvedValue(undefined) // Simulates successful claim
    mockHeartbeatOps.isInstanceHealthy.mockResolvedValue({
      state: ActualHeartbeatOperations.HEALTHY
    } as any)
  })

  it('should return null if poolPickupManager.pickup() returns null (pool empty)', async () => {
    mockPoolPickupManager.pickup.mockResolvedValueOnce(null)

    const result = await claimWorker(claimWorkerInput)

    expect(result.payload).toBeNull()
    expect(result.message).toContain('Pool (test-rc) found to be "empty"')
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`No instance picked up`)
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(1)
    expect(mockInstanceOps.instanceStateTransition).not.toHaveBeenCalled()
    expect(mockHeartbeatOps.isInstanceHealthy).not.toHaveBeenCalled()
  })

  it('should claim and return instance if pickup, claim, and health check are successful on first try', async () => {
    const mockInstance = createMockInstance('i-success1')
    mockPoolPickupManager.pickup.mockResolvedValueOnce(mockInstance)

    const result = await claimWorker(claimWorkerInput)

    expect(result.payload).toEqual(mockInstance)
    expect(result.message).toContain(
      `Instance (${mockInstance.id}) is claimed and healthy`
    )
    expect(core.info).toHaveBeenCalledWith(
      `[CLAIM WORKER ${workerNum}] Instance (${mockInstance.id}) is claimed and healthy`
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(1)
    expect(mockInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockInstance.id,
        newRunID: sampleRunId,
        expectedState: 'idle',
        newState: 'claimed'
      })
    )
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledWith(
      mockInstance.id
    )
  })

  it('should retry if instance claim fails, then succeed with next instance', async () => {
    const instanceFailClaim = createMockInstance('i-failclaim')
    const instanceSuccess = createMockInstance('i-success2')

    mockPoolPickupManager.pickup
      .mockResolvedValueOnce(instanceFailClaim)
      .mockResolvedValueOnce(instanceSuccess)

    // Mock attemptToClaimInstance failure for the first instance
    // This is done by making instanceStateTransition throw for the first instance
    mockInstanceOps.instanceStateTransition
      .mockRejectedValueOnce(new Error('DynamoDB conditional check failed')) // For instanceFailClaim
      .mockResolvedValueOnce(undefined) // For instanceSuccess

    const result = await claimWorker(claimWorkerInput)

    expect(result.payload).toEqual(instanceSuccess)
    expect(result.message).toContain(
      `Instance (${instanceSuccess.id}) is claimed and healthy`
    )

    expect(core.info).toHaveBeenCalledWith(
      `[CLAIM WORKER ${workerNum}] Unable to claim instance (${instanceFailClaim.id}). Retrying...`
    )
    expect(core.info).toHaveBeenCalledWith(
      `[CLAIM WORKER ${workerNum}] Instance (${instanceSuccess.id}) is claimed and healthy`
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(2)
    expect(mockInstanceOps.instanceStateTransition).toHaveBeenCalledTimes(2)
    expect(mockInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceFailClaim.id })
    )
    expect(mockInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceSuccess.id })
    )
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledTimes(1) // Only called for the successfully claimed instance
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledWith(
      instanceSuccess.id
    )
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to claim instance ${instanceFailClaim.id}`
      )
    )
  })

  it('should retry if instance is unhealthy, then succeed with next healthy instance', async () => {
    const instanceUnhealthy = createMockInstance('i-unhealthy')
    const instanceHealthy = createMockInstance('i-healthy2')

    mockPoolPickupManager.pickup
      .mockResolvedValueOnce(instanceUnhealthy)
      .mockResolvedValueOnce(instanceHealthy)

    mockHeartbeatOps.isInstanceHealthy
      .mockResolvedValueOnce({
        state: ActualHeartbeatOperations.UNHEALTHY
      } as any) // For instanceUnhealthy
      .mockResolvedValueOnce({
        state: ActualHeartbeatOperations.HEALTHY
      } as any) // For instanceHealthy

    const result = await claimWorker(claimWorkerInput)

    expect(result.payload).toEqual(instanceHealthy)
    expect(result.message).toContain(
      `Instance (${instanceHealthy.id}) is claimed and healthy`
    )

    expect(core.info).toHaveBeenCalledWith(
      `[CLAIM WORKER ${workerNum}] The following instance is unhealthy (${instanceUnhealthy.id}). Retrying...`
    )
    expect(core.info).toHaveBeenCalledWith(
      `[CLAIM WORKER ${workerNum}] Instance (${instanceHealthy.id}) is claimed and healthy`
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(2)
    expect(mockInstanceOps.instanceStateTransition).toHaveBeenCalledTimes(2) // Claim attempted for both
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledTimes(2)
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledWith(
      instanceUnhealthy.id
    )
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledWith(
      instanceHealthy.id
    )
  })
})
