import { jest } from '@jest/globals'
import * as core from '../../../__fixtures__/core' // Assuming a similar fixture setup
import { claimWorker } from '../../../__fixtures__/provision/selection'
import { mock, MockProxy } from 'jest-mock-extended'
import type { Instance, SelectionInput } from '../../../src/provision/types'
import type { ResourceClassConfig } from '../../../src/services/types'
import type { InstanceOperations as DDBInstanceOperations } from '../../../src/services/dynamodb/operations/instance-operations'
import type { InstanceOperations as EC2InstanceOperations } from '../../../src/services/ec2/operations/instance-operations'
import type { HeartbeatOperations } from '../../../src/services/dynamodb/operations/heartbeat-operations'
import type { ResourceClassConfigOperations } from '../../../src/services/sqs/operations/resource-class-operations'
import { WorkerSignalOperations } from '../../../src/services/dynamodb/operations/signal-operations'

// Mock dependencies
Object.entries({
  '@actions/core': core,
  // Ensure this path correctly points to the actual claim-worker module
  '../../../src/provision/selection/claim-worker.js': { claimWorker }
}).forEach(([path, mockModule]) => {
  jest.unstable_mockModule(path, () => mockModule)
})

// Dynamically import the module to be tested after mocks are set up
const { selection } = await import('../../../src/provision/selection/index')

describe('selection', () => {
  let mockInput: SelectionInput
  let mockDdbInstanceOps: MockProxy<DDBInstanceOperations>
  let mockDdbHeartbeatOps: MockProxy<HeartbeatOperations>
  let mockSqsOps: MockProxy<ResourceClassConfigOperations>
  let mockResourceClassConfig: MockProxy<ResourceClassConfig>
  let mockWorkerSignalOperations: MockProxy<WorkerSignalOperations>
  let mockEc2InstanceOperations: MockProxy<EC2InstanceOperations>

  const genericInstance: Instance = {
    id: 'i-1234567890abcdef0',
    instanceType: 'm5.large',
    resourceClass: 'default',
    cpu: 2,
    mmem: 8192
  }

  beforeEach(() => {
    jest.clearAllMocks() // Clears all mocks including core and the fixture claimWorker

    mockDdbInstanceOps = mock<DDBInstanceOperations>()
    mockDdbHeartbeatOps = mock<HeartbeatOperations>()
    mockWorkerSignalOperations = mock<WorkerSignalOperations>()
    mockEc2InstanceOperations = mock<EC2InstanceOperations>()
    mockSqsOps = mock<ResourceClassConfigOperations>()
    mockResourceClassConfig = mock<ResourceClassConfig>()

    mockInput = {
      allowedInstanceTypes: ['m5.large', 'c5.large'],
      resourceClass: 'default',
      resourceClassConfig: mockResourceClassConfig,
      sqsOps: mockSqsOps,
      ddbOps: {
        instanceOperations: mockDdbInstanceOps,
        heartbeatOperations: mockDdbHeartbeatOps,
        workerSignalOperations: mockWorkerSignalOperations
      },
      ec2Ops: { instanceOperations: mockEc2InstanceOperations },
      runId: 'test-run-id-selection',
      instanceCount: 2
    }

    claimWorker.mockResolvedValue({
      message: '',
      payload: genericInstance
    })
  })

  it('logs start and completion of selection routine', async () => {
    await selection(mockInput)
    expect(core.info).toHaveBeenCalledWith('starting selection routine...')
    expect(core.info).toHaveBeenCalledWith('completed selection routine')
  })

  it('should select all required instances when claimWorker succeeds for all', async () => {
    mockInput.instanceCount = 2
    const instance1 = { ...genericInstance, id: 'i-instance1' }
    const instance2 = { ...genericInstance, id: 'i-instance2' }

    claimWorker
      .mockResolvedValueOnce({
        message: 'Instance 1 claimed',
        payload: instance1
      })
      .mockResolvedValueOnce({
        message: 'Instance 2 claimed',
        payload: instance2
      })

    const output = await selection(mockInput)

    expect(claimWorker).toHaveBeenCalledTimes(2)
    expect(output.numInstancesSelected).toBe(2)
    expect(output.numInstancesRequired).toBe(0)
    expect(output.instances).toEqual([instance1, instance2])
    expect(output.labels).toEqual(['i-instance1', 'i-instance2'])
  })

  it('should handle partial success when some claimWorker calls return no payload or reject', async () => {
    mockInput.instanceCount = 3
    const instance1 = { ...genericInstance, id: 'i-success1' }

    claimWorker
      .mockResolvedValueOnce({
        message: 'Instance i-success1 claimed',
        payload: instance1
      }) // Worker 1: Success with payload
      .mockResolvedValueOnce({
        message: 'Pool empty for this worker',
        payload: null
      }) // Worker 2: Success, no payload (pool empty for worker)
      .mockRejectedValueOnce(new Error('Simulated worker failure')) // Worker 3: Failure

    const output = await selection(mockInput)

    expect(claimWorker).toHaveBeenCalledTimes(3)
    expect(output.numInstancesSelected).toBe(1)
    expect(output.numInstancesRequired).toBe(2) // 3 required - 1 claimed
    expect(output.instances).toEqual([instance1])
    expect(output.labels).toEqual(['i-success1'])
  })

  it('should handle zero instances selected when all claimWorker calls return no payload or reject', async () => {
    mockInput.instanceCount = 2
    claimWorker
      .mockResolvedValueOnce({
        message: 'Pool empty, no payload for worker 1',
        payload: null
      })
      .mockRejectedValueOnce(new Error('Simulated worker 2 failure'))

    const output = await selection(mockInput)

    expect(claimWorker).toHaveBeenCalledTimes(2)
    expect(output.numInstancesSelected).toBe(0)
    expect(output.numInstancesRequired).toBe(2)
    expect(output.instances).toEqual([])
    expect(output.labels).toEqual([])
  })

  it('should handle instanceCount of 0 gracefully', async () => {
    mockInput.instanceCount = 0
    const output = await selection(mockInput)

    expect(claimWorker).not.toHaveBeenCalled()
    expect(output.numInstancesSelected).toBe(0)
    expect(output.numInstancesRequired).toBe(0)
    expect(output.instances).toEqual([])
    expect(output.labels).toEqual([])
    expect(core.info).toHaveBeenCalledWith('starting selection routine...')
    expect(core.info).toHaveBeenCalledWith('completed selection routine')
  })

  it('should pass unique workerNumber to each claimWorker call', async () => {
    mockInput.instanceCount = 3
    const instance1 = { ...genericInstance, id: 'i-w1' }
    const instance2 = { ...genericInstance, id: 'i-w2' }
    const instance3 = { ...genericInstance, id: 'i-w3' }

    claimWorker
      .mockResolvedValueOnce({ message: 'w1', payload: instance1 })
      .mockResolvedValueOnce({ message: 'w2', payload: instance2 })
      .mockResolvedValueOnce({ message: 'w3', payload: instance3 })

    await selection(mockInput)

    expect(claimWorker).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workerNumber: 0 })
    )
    expect(claimWorker).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workerNumber: 1 })
    )
    expect(claimWorker).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ workerNumber: 2 })
    )
  })
})
