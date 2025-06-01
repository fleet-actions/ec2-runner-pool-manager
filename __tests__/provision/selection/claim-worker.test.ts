// __tests__/provision/selection/claim-worker.test.ts
import { jest } from '@jest/globals'
import * as core from '../../../__fixtures__/core' // Mock for @actions/core
import { mock, MockProxy } from 'jest-mock-extended'

// Import types and classes to be mocked or used
import { PoolPickUpManager } from '../../../src/provision/selection/pool-pickup-manager'
import { InstanceOperations as DDBInstanceOpeerations } from '../../../src/services/dynamodb/operations/instance-operations'
import { InstanceOperations as EC2InstanceOperations } from '../../../src/services/ec2/operations/instance-operations'
import { HeartbeatOperations } from '../../../src/services/dynamodb/operations/heartbeat-operations'
import { WorkerSignalOperations } from '../../../src/services/dynamodb/operations/signal-operations'
import { Instance } from '../../../src/provision/types'

// Import the function to test and its input type
import type { ClaimWorkerInput } from '../../../src/provision/selection/claim-worker'
import { GenericInstance } from '../../../__fixtures__/generic'

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
  let mockDDBInstanceOps: MockProxy<DDBInstanceOpeerations>
  let mockHeartbeatOps: MockProxy<HeartbeatOperations>
  let mockWorkerSignalOps: MockProxy<WorkerSignalOperations>
  let mockEC2InstanceOps: MockProxy<EC2InstanceOperations>
  let claimWorkerInput: ClaimWorkerInput

  const sampleRunId = 'test-run-id-123'
  const sampleResourceClass = 'test-rc'
  const workerNum = 1

  const createMockInstance = (id: string): Instance => ({
    ...GenericInstance,
    id,
    resourceClass: sampleResourceClass
    // instanceType: 'm5.large',
    // cpu: 4,
    // mmem: 8192
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
    mockDDBInstanceOps = mock<DDBInstanceOpeerations>()
    mockHeartbeatOps = mock<HeartbeatOperations>()
    mockWorkerSignalOps = mock<WorkerSignalOperations>()
    mockEC2InstanceOps = mock<EC2InstanceOperations>()

    claimWorkerInput = {
      workerNumber: workerNum,
      resourceClass: sampleResourceClass,
      poolPickupManager: mockPoolPickupManager,
      ddbOps: {
        instanceOperations: mockDDBInstanceOps,
        heartbeatOperations: mockHeartbeatOps,
        workerSignalOperations: mockWorkerSignalOps
      },
      ec2Ops: {
        instanceOperations: mockEC2InstanceOps
      },
      runId: sampleRunId
    }

    // Default successful mocks
    mockDDBInstanceOps.instanceStateTransition.mockResolvedValue(undefined) // Simulates successful claim
    mockWorkerSignalOps.pollOnSignal.mockResolvedValue({
      state: true,
      message: 'all ok on ws!'
    })
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
    expect(mockDDBInstanceOps.instanceStateTransition).not.toHaveBeenCalled()
    expect(mockHeartbeatOps.isInstanceHealthy).not.toHaveBeenCalled()
  })

  it('should claim and return instance if pickup, claim, and health check are successful on first try', async () => {
    const mockInstance = createMockInstance('i-success1')
    mockPoolPickupManager.pickup.mockResolvedValueOnce(mockInstance)

    const result = await claimWorker(claimWorkerInput)

    expect(result.payload).toEqual(mockInstance)
    expect(result.message).toContain('claimed, healthy and registered')
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('claimed, healthy and registered')
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(1)
    expect(mockDDBInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
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
    mockDDBInstanceOps.instanceStateTransition
      .mockRejectedValueOnce(new Error('DynamoDB conditional check failed')) // For instanceFailClaim
      .mockResolvedValueOnce(undefined) // For instanceSuccess

    const result = await claimWorker(claimWorkerInput)

    expect(result.payload).toEqual(instanceSuccess)
    expect(result.message).toContain('claimed, healthy and registered')

    expect(core.info).toHaveBeenCalledWith(
      `[CLAIM WORKER ${workerNum}] Unable to claim instance (${instanceFailClaim.id}). Retrying...`
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('claimed, healthy and registered')
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(2)
    expect(mockDDBInstanceOps.instanceStateTransition).toHaveBeenCalledTimes(2)
    expect(mockDDBInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceFailClaim.id })
    )
    expect(mockDDBInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
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
      `Instance (${instanceHealthy.id}) is claimed, healthy and registered`
    )

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('unhealthy'))
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('claimed, healthy and registered')
    )
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(2)
    expect(mockDDBInstanceOps.expireInstance).toHaveBeenCalledTimes(1) // expires unhealthy instance
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledTimes(2)
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledWith(
      instanceUnhealthy.id
    )
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledWith(
      instanceHealthy.id
    )
  })

  it('should expire instance if the instance is unhealthy', async () => {
    const instanceUnhealthy = createMockInstance('i-unhealthy')
    mockPoolPickupManager.pickup.mockResolvedValueOnce(instanceUnhealthy)
    mockHeartbeatOps.isInstanceHealthy.mockResolvedValueOnce({
      state: ActualHeartbeatOperations.UNHEALTHY
    } as any) // For instanceUnhealthy

    const result = await claimWorker(claimWorkerInput)
    expect(result.payload).toEqual(null) // returns none

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(`following instance is unhealthy`)
    )

    // expect initial transition
    expect(mockDDBInstanceOps.instanceStateTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRunID: '', // pickup from pool
        expectedState: 'idle',
        newState: 'claimed'
      })
    )
    // expect following expiry
    expect(mockDDBInstanceOps.expireInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: instanceUnhealthy.id,
        runId: sampleRunId,
        state: 'claimed'
      })
    )
  })

  it('should terminate and expire instance if healthy but ws signal fails, then succeed with next instance', async () => {
    const instanceHealthyButBadWs = createMockInstance('i-healthy-no-ws')
    const instanceSuccess = createMockInstance('i-success-with-ws')

    mockPoolPickupManager.pickup
      .mockResolvedValueOnce(instanceHealthyButBadWs)
      .mockResolvedValueOnce(instanceSuccess)

    // First instance is healthy
    mockHeartbeatOps.isInstanceHealthy.mockResolvedValue({
      state: ActualHeartbeatOperations.HEALTHY
    } as any)

    // First instance fails WebSocket registration check
    mockWorkerSignalOps.pollOnSignal
      .mockResolvedValueOnce({
        state: false,
        message: 'WebSocket registration timed out'
      })
      // Second instance succeeds WebSocket registration
      .mockResolvedValueOnce({
        state: true,
        message: 'WebSocket registered successfully'
      })

    // Set up the promise for EC2 termination to resolve successfully
    mockEC2InstanceOps.terminateInstances.mockResolvedValue(undefined as any)

    const result = await claimWorker(claimWorkerInput)

    // Assertions for the final successful result
    expect(result.payload).toEqual(instanceSuccess)
    expect(result.message).toContain('claimed, healthy and registered')

    // Verify the first instance was terminated and expired
    expect(mockEC2InstanceOps.terminateInstances).toHaveBeenCalledWith([
      instanceHealthyButBadWs.id
    ])
    expect(mockDDBInstanceOps.expireInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: instanceHealthyButBadWs.id,
        runId: sampleRunId,
        state: 'claimed'
      })
    )

    // Verify appropriate logging occurred
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `does not have required wssignal in time (${instanceHealthyButBadWs.id})`
      )
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `Instance (${instanceSuccess.id}) is claimed, healthy and registered`
      )
    )

    // Verify both instances went through the full process
    expect(mockPoolPickupManager.pickup).toHaveBeenCalledTimes(2)
    expect(mockDDBInstanceOps.instanceStateTransition).toHaveBeenCalledTimes(2)
    expect(mockHeartbeatOps.isInstanceHealthy).toHaveBeenCalledTimes(2)
    expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenCalledTimes(2)

    // Verify the WebSocket check was attempted for both instances with correct parameters
    expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        instanceIds: [instanceHealthyButBadWs.id],
        runId: sampleRunId
      })
    )
    expect(mockWorkerSignalOps.pollOnSignal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        instanceIds: [instanceSuccess.id],
        runId: sampleRunId
      })
    )
  })

  it('should only call EC2 termination when healthy instance fails ws signal check', async () => {
    // Create three instances with different scenarios
    const instanceUnhealthy = createMockInstance('i-unhealthy')
    const instanceHealthyButBadWs = createMockInstance('i-healthy-bad-ws')
    const instanceFailClaim = createMockInstance('i-fail-claim')

    // Setup pickup to return each instance in sequence
    mockPoolPickupManager.pickup
      .mockResolvedValueOnce(instanceUnhealthy) // First: unhealthy instance
      .mockResolvedValueOnce(instanceHealthyButBadWs) // Second: healthy but bad WS
      .mockResolvedValueOnce(instanceFailClaim) // Third: claim will fail
      .mockResolvedValueOnce(null) // Fourth: no more instances

    // Unhealthy instance
    mockHeartbeatOps.isInstanceHealthy
      .mockResolvedValueOnce({
        state: ActualHeartbeatOperations.UNHEALTHY
      } as any)
      // Healthy instance with bad WS
      .mockResolvedValueOnce({
        state: ActualHeartbeatOperations.HEALTHY
      } as any)

    // WS signal fails for the healthy instance
    mockWorkerSignalOps.pollOnSignal.mockResolvedValueOnce({
      state: false,
      message: 'ws registration failed'
    })

    // Claim fails for the third instance
    mockDDBInstanceOps.instanceStateTransition
      .mockResolvedValueOnce(undefined) // Successful claim for unhealthy instance
      .mockResolvedValueOnce(undefined) // Successful claim for healthy-bad-ws instance
      .mockRejectedValueOnce(new Error('Claim failed')) // Failed claim for third instance

    // EC2 termination resolves successfully
    mockEC2InstanceOps.terminateInstances.mockResolvedValue(undefined as any)

    const result = await claimWorker(claimWorkerInput)

    // Final result should be null since we ran out of instances
    expect(result.payload).toBeNull()

    // EC2 termination should only be called ONCE - for the healthy instance with bad WS
    expect(mockEC2InstanceOps.terminateInstances).toHaveBeenCalledTimes(1)
    expect(mockEC2InstanceOps.terminateInstances).toHaveBeenCalledWith([
      instanceHealthyButBadWs.id
    ])

    // Verify expireInstance was called for both unhealthy and bad-ws instances (but not claim-fail)
    expect(mockDDBInstanceOps.expireInstance).toHaveBeenCalledTimes(2)
    expect(mockDDBInstanceOps.expireInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceUnhealthy.id })
    )
    expect(mockDDBInstanceOps.expireInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: instanceHealthyButBadWs.id })
    )
  })
})
