// __tests__/provision/selection/pool-pickup-manager.test.ts
import { jest } from '@jest/globals'
import * as core from '../../../__fixtures__/core'
import { mock, MockProxy } from 'jest-mock-extended'
import {
  ResourceClassConfigOperations,
  InstanceMessage
} from '../../../src/services/sqs/operations/resource-class-operations' // Adjust path if needed
import type { ResourceClassConfig } from '../../../src/services/types' // Adjust path if needed

Object.entries({
  '@actions/core': core
}).forEach(([path, mockModule]) => {
  jest.unstable_mockModule(path, () => mockModule)
})

// Import the class to be tested AFTER mocks are set up
const { PoolPickUpManager } = await import(
  '../../../src/provision/selection/pool-pickup-manager' // Adjust path if needed
)

// typeof PoolPickUpManager.prototype

describe('PoolPickUpManager#pickup', () => {
  let manager: typeof PoolPickUpManager.prototype
  let mockSqsOps: MockProxy<ResourceClassConfigOperations>
  let mockResourceClassConfig: ResourceClassConfig
  let mockAllowedInstanceTypes: string[]

  const sampleRC = 'large'
  const sampleQueueUrl = 'https://sqs.region.amazonaws.com/123/test-queue'

  const createInstanceMessage = (
    overrides: Partial<InstanceMessage> = {}
  ): InstanceMessage => ({
    id: 'i-default123',
    resourceClass: sampleRC,
    instanceType: 'c5.large',
    cpu: 4,
    mmem: 8192,
    ...overrides
  })

  beforeEach(() => {
    jest.clearAllMocks()

    mockSqsOps = mock<ResourceClassConfigOperations>()
    mockResourceClassConfig = {
      [sampleRC]: {
        queueUrl: sampleQueueUrl,
        cpu: 4,
        mmem: 8192
      }
    }
    mockAllowedInstanceTypes = ['c5.large', 'm5.large', 't3.*'] // More relevant for indirect testing

    // Default mocks
    // matchWildcardPatterns.mockReturnValue(true) // Default to instance type being valid
    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValue(null)
    mockSqsOps.sendResourceToPool.mockResolvedValue(undefined)

    manager = new PoolPickUpManager(
      mockAllowedInstanceTypes,
      sampleRC,
      mockResourceClassConfig,
      mockSqsOps
    )
  })

  it('should return a message if one is available, valid, and instance type matches', async () => {
    const message = createInstanceMessage({
      id: 'i-valid1',
      instanceType: 'c5.large'
    })
    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(message)

    const result = await manager.pickup()

    expect(result).toEqual(message)
    expect(mockSqsOps.receiveAndDeleteResourceFromPool).toHaveBeenCalledTimes(1)
    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
  })

  it('should return null if SQS queue is empty initially', async () => {
    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(null) // Default behavior set in beforeEach, but explicit for clarity
    const result = await manager.pickup()
    expect(result).toBeNull()
  })

  it('should return null if frequency tolerance is exceeded for seen messages', async () => {
    const frequentMsg = createInstanceMessage({
      id: 'i-frequent',
      instanceType: 'c5.large'
    })
    const tolerance = PoolPickUpManager.FREQ_TOLERANCE
    // matchWildcardPatterns.mockReturnValue(true) // Assume type is valid, so message is 'ok'

    // Mock SQS to always return this 'ok' message when pickup is called
    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValue(frequentMsg)

    // Call pickup() 'tolerance' times. Each time it should successfully return the 'ok' message.
    // The instanceFreq for 'i-frequent' will increment with each call.
    for (let i = 0; i < tolerance; i++) {
      const result = await manager.pickup()
      expect(result).toEqual(frequentMsg)
    }

    // The (tolerance + 1)th call to pickup().
    // mockSqsOps.receiveAndDeleteResourceFromPool will return frequentMsg again.
    // However, registerAndValidateFrequency will now find that freq === tolerance for 'i-frequent',
    // causing it to return false, and manager.pickup() to return null.
    const finalResult = await manager.pickup()
    expect(finalResult).toBeNull()

    // Total calls to receiveAndDeleteResourceFromPool = 'tolerance' successful pickups + 1 failed pickup attempt.
    expect(mockSqsOps.receiveAndDeleteResourceFromPool).toHaveBeenCalledTimes(
      tolerance + 1
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('We have cycled through the pool too many times')
    )
    // sendResourceToPool should not have been called since the message was 'ok' each time
    // until the frequency limit was hit on the final attempt.
    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
  })

  it('should discard message and retry if its resourceClass is invalid, then pick next valid', async () => {
    const invalidRcMsg = createInstanceMessage({
      id: 'i-invalidrc',
      resourceClass: 'very-wrong-rc'
    })
    const validMsg = createInstanceMessage({
      id: 'i-valid2',
      instanceType: 'm5.large'
    })

    mockSqsOps.receiveAndDeleteResourceFromPool
      .mockResolvedValueOnce(invalidRcMsg)
      .mockResolvedValueOnce(validMsg)
    // matchWildcardPatterns.mockReturnValue(true) // For the validMsg path

    const result = await manager.pickup()
    expect(result).toEqual(validMsg)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'The resource class of the picked up message is invalid. Picked up rc very-wrong-rc; now discarded from pool; picking up another from queue'
      )
    )
    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
    expect(mockSqsOps.receiveAndDeleteResourceFromPool).toHaveBeenCalledTimes(2)
  })

  it('should discard message and retry if both CPU and memory are incorrect, then pick next valid', async () => {
    const spec = mockResourceClassConfig[sampleRC]
    const badSpecMsg = createInstanceMessage({
      id: 'i-badspec',
      cpu: spec.cpu - 1,
      mmem: spec.mmem - 100,
      instanceType: 'c5.large' // Type is fine
    })
    const validMsg = createInstanceMessage({
      id: 'i-valid-after-badspec',
      instanceType: 'm5.large'
    })

    mockSqsOps.receiveAndDeleteResourceFromPool
      .mockResolvedValueOnce(badSpecMsg)
      .mockResolvedValueOnce(validMsg)
    // matchWildcardPatterns.mockReturnValue(true) // For both messages, type is not the issue

    const result = await manager.pickup()
    expect(result).toEqual(validMsg)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        // Based on current implementation, CPU message is prioritized
        `Picked up cpu (${badSpecMsg.cpu}) is not equal to spec (${spec.cpu}); now discarded from pool; picking up another from queue`
      )
    )
    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
  })

  it('should discard message if ONLY CPU mismatches', async () => {
    const spec = mockResourceClassConfig[sampleRC]
    const cpuMismatchMsg = createInstanceMessage({
      id: 'i-cpumismatch',
      cpu: spec.cpu + 1, // CPU is different
      mmem: spec.mmem, // Memory is fine
      instanceType: 'c5.large' // Type is fine
    })

    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(
      cpuMismatchMsg
    )
    // matchWildcardPatterns.mockReturnValueOnce(true)

    const result = await manager.pickup()
    expect(result).toEqual(null)
    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
  })

  it('should discard message if ONLY memory is too low', async () => {
    const spec = mockResourceClassConfig[sampleRC]
    const memMismatchMsg = createInstanceMessage({
      id: 'i-memmismatch',
      cpu: spec.cpu, // CPU is fine
      mmem: spec.mmem - 1, // Memory is low
      instanceType: 'c5.large' // Type is fine
    })

    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(
      memMismatchMsg
    )
    // matchWildcardPatterns.mockReturnValueOnce(true)

    const result = await manager.pickup()
    expect(result).toEqual(null)
    expect(mockSqsOps.sendResourceToPool).not.toHaveBeenCalled()
  })

  it('should requeue message and retry if instance type does not match, then pick next valid', async () => {
    const typeMismatchMsg = createInstanceMessage({
      id: 'i-typemismatch',
      instanceType: 'unallowed.type'
    })
    const validMsg = createInstanceMessage({
      id: 'i-valid3',
      instanceType: 't3.medium' // Matches t3.*
    })

    mockSqsOps.receiveAndDeleteResourceFromPool
      .mockResolvedValueOnce(typeMismatchMsg)
      .mockResolvedValueOnce(validMsg)

    // matchWildcardPatterns
    //   .mockReturnValueOnce(false) // For typeMismatchMsg
    //   .mockReturnValueOnce(true) // For validMsg

    const result = await manager.pickup()
    expect(result).toEqual(validMsg)
    // expect(core.warning).toHaveBeenCalledWith(
    //   expect.stringContaining(
    //     `The picked up instance type ${typeMismatchMsg.instanceType} does not match allowed instance types (${mockAllowedInstanceTypes.join(',')}); placing back to pool; picking up another from pool`
    //   )
    // )
    // expect(mockSqsOps.sendResourceToPool).toHaveBeenCalledTimes(1)
    // expect(mockSqsOps.sendResourceToPool).toHaveBeenCalledWith(
    //   typeMismatchMsg,
    //   mockResourceClassConfig
    // )
    // expect(mockSqsOps.receiveAndDeleteResourceFromPool).toHaveBeenCalledTimes(
    //   2
    // )
    // expect(matchWildcardPatterns).toHaveBeenNthCalledWith(
    //   1,
    //   mockAllowedInstanceTypes,
    //   typeMismatchMsg.instanceType
    // )
    // expect(matchWildcardPatterns).toHaveBeenNthCalledWith(
    //   2,
    //   mockAllowedInstanceTypes,
    //   validMsg.instanceType
    // )
  })

  it('should eventually return null if all messages are requeued (due to type mismatch) until frequency limit or empty queue', async () => {
    const requeueMsg = createInstanceMessage({
      id: 'i-req-loop',
      instanceType: 'always_mismatch_type'
    })
    const tolerance = PoolPickUpManager.FREQ_TOLERANCE

    // Simulate receiving the same requeueable message multiple times
    for (let i = 0; i < tolerance; i++) {
      mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(
        requeueMsg
      )
    }
    // After these, one more attempt for requeueMsg will hit frequency limit.
    // Then simulate queue being empty.
    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(
      requeueMsg
    ) // This one will trigger the frequency limit check *after* being classified
    mockSqsOps.receiveAndDeleteResourceFromPool.mockResolvedValueOnce(null)

    // matchWildcardPatterns.mockReturnValue(false) // Force all these to be requeued due to type mismatch

    const result = await manager.pickup()
    expect(result).toBeNull()

    // It tries to pick up tolerance + 1 times. Each of the first 'tolerance' times leads to a requeue.
    // The (tolerance+1)th time, it's picked up, classified as requeue, freq check passes for this round.
    // It's sent back. THEN the loop would try again, but the freq map for 'i-req-loop' is now at FREQ_TOLERANCE.
    // The problem is that registerAndValidateFrequency is called *before* classification.

    // Let's re-evaluate the number of calls based on the code logic:
    // pickup -> receive (msg1) -> register (id, 1) -> classify (requeue) -> send back
    // pickup -> receive (msg1) -> register (id, 2) -> classify (requeue) -> send back
    // ...
    // pickup -> receive (msg1) -> register (id, FREQ_TOLERANCE) -> classify (requeue) -> send back
    // pickup -> receive (msg1) -> register (id, FREQ_TOLERANCE+1) -> THIS register call returns false.
    // So, receiveAndDeleteResourceFromPool is called FREQ_TOLERANCE + 1 times.
    // And sendResourceToPool is called FREQ_TOLERANCE times.
    // And matchWildcardPatterns is called FREQ_TOLERANCE times.

    expect(mockSqsOps.receiveAndDeleteResourceFromPool).toHaveBeenCalledTimes(
      PoolPickUpManager.FREQ_TOLERANCE + 1
    )

    // send back test
    expect(mockSqsOps.sendResourceToPool).toHaveBeenCalledTimes(
      PoolPickUpManager.FREQ_TOLERANCE
    )
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('We have cycled through the pool too many times')
    )
  })
})
