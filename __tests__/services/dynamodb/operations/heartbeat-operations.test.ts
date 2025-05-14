// __tests__/services/dynamodb/operations/heartbeat-operations.test.ts
import { jest } from '@jest/globals'
import { DynamoDBClient } from '../../../../src/services/dynamodb/dynamo-db-client'
import { startDb, stopDb, createTables, deleteTables } from 'jest-dynalite'
import * as core from '../../../../__fixtures__/core.js'

// Mock @actions/core
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { HeartbeatOperations } = await import(
  '../../../../src/services/dynamodb/operations/heartbeat-operations'
)

describe('HeartbeatOperations', () => {
  let client: DynamoDBClient
  let heartbeat: InstanceType<typeof HeartbeatOperations>

  // Setup DynamoDB Local
  beforeAll(startDb)
  beforeEach(createTables)
  afterEach(deleteTables)
  afterAll(stopDb)

  beforeEach(() => {
    jest.clearAllMocks()
    client = new DynamoDBClient('us-east-1', 'main-table', 'testing-table')
    heartbeat = new HeartbeatOperations(client)
  })

  describe('isInstanceHealthy', () => {
    it('should classify instance as missing when not in database', async () => {
      const result = await heartbeat.isInstanceHealthy('non-existent-id')
      expect(result.state).toBe(HeartbeatOperations.MISSING)
      expect(result.ageMs).toBeNull()
    })

    it('should classify instance as healthy when heartbeat is fresh', async () => {
      // Insert a fresh heartbeat (no time has passed between insertion of value and checking)
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy')

      const result = await heartbeat.isInstanceHealthy('i-healthy')
      expect(result.state).toBe(HeartbeatOperations.HEALTHY)
      expect(result.ageMs).toBeDefined()
      expect(result.ageMs).toBeGreaterThanOrEqual(0)
    })

    it('should classify instance as unhealthy when heartbeat is outdated', async () => {
      // Create a heartbeat with an outdated timestamp (30 minutes ago)
      const thirtyMinutesAgo = new Date(
        Date.now() - 30 * 60 * 1000
      ).toISOString()

      // Use the parent class method to override the updatedAt attribute
      await heartbeat.updateGenericItem('i-unhealthy', {
        value: HeartbeatOperations.STATUS.PING,
        updatedAt: thirtyMinutesAgo // overriding attribute
      })

      const result = await heartbeat.isInstanceHealthy('i-unhealthy')
      expect(result.state).toBe(HeartbeatOperations.UNHEALTHY)
    })
  })

  it('should classify an instance as healthy from missing to fresh', async () => {
    const id = 'i-eventually-fresh'
    let result = await heartbeat.isInstanceHealthy(id)
    expect(result.state).toBe(HeartbeatOperations.MISSING)

    // Insert a fresh heartbeat (no time has passed between insertion of value and checking)
    await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, id)

    result = await heartbeat.isInstanceHealthy(id)
    expect(result.state).toBe(HeartbeatOperations.HEALTHY)
  })

  it('should classify an instance as healthy from missing to unhealthy to fresh', async () => {
    const id = 'i-eventually-fresh'
    let result = await heartbeat.isInstanceHealthy(id)
    expect(result.state).toBe(HeartbeatOperations.MISSING)

    // Create a heartbeat with an outdated timestamp (30 minutes ago)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()

    // Use the parent class method to override the updatedAt attribute
    await heartbeat.updateGenericItem(id, {
      value: HeartbeatOperations.STATUS.PING,
      updatedAt: thirtyMinutesAgo // overriding attribute
    })

    result = await heartbeat.isInstanceHealthy(id)
    expect(result.state).toBe(HeartbeatOperations.UNHEALTHY)

    // Insert a fresh heartbeat (no time has passed between insertion of value and checking)
    await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, id)

    result = await heartbeat.isInstanceHealthy(id)
    expect(result.state).toBe(HeartbeatOperations.HEALTHY)
  })

  describe('areAllInstancesHealthyPoll', () => {
    it('should timeout on non-existent instances', async () => {
      const result = await heartbeat.areAllInstancesHealthyPoll(
        ['i-dont-exist'],
        0.5, // 0.5 second timeout
        0.1 // 100ms interval
      )

      expect(result.state).toBe(false)
      expect(result.message).toContain('⌛️')
    })

    it('should still timeout if some instances are unhealthy', async () => {
      // Insert a healthy instance
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy')

      // Insert an unhealthy instance with outdated timestamp
      const outdatedTimestamp = new Date(
        Date.now() - 30 * 60 * 1000
      ).toISOString()
      await heartbeat.updateGenericItem('i-unhealthy', {
        value: HeartbeatOperations.STATUS.PING,
        updatedAt: outdatedTimestamp
      })

      const result = await heartbeat.areAllInstancesHealthyPoll(
        ['i-healthy', 'i-unhealthy'],
        0.5, // 0.5 second timeout
        0.1 // 100ms interval
      )

      expect(result.state).toBe(false)
      expect(result.message).toContain('⌛️')
    })

    it('should return success when all instances are healthy', async () => {
      // Insert healthy instances
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy1')
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy2')

      const result = await heartbeat.areAllInstancesHealthyPoll(
        ['i-healthy1', 'i-healthy2'],
        0.5, // 0.5 second timeout
        0.1 // 100ms interval
      )

      expect(result.state).toBe(true)
      expect(result.message).toContain('🎉')
    })
  })

  describe('areAllInstancesHealthy', () => {
    it('should recognize when all instances are healthy', async () => {
      // Insert healthy instances
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy1')
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy2')

      // Register these instances for health tracking
      await heartbeat['registerInstancesForHealthCheck']([
        'i-healthy1',
        'i-healthy2'
      ])

      const result = await heartbeat.areAllInstancesHealthy()
      expect(result).toBe(true)
    })

    it('should recognize when some instances are unhealthy', async () => {
      // Insert one healthy instance
      await heartbeat.updateValue(HeartbeatOperations.STATUS.PING, 'i-healthy')

      // Insert an unhealthy instance with outdated timestamp
      const outdatedTimestamp = new Date(
        Date.now() - 30 * 60 * 1000
      ).toISOString()
      await heartbeat['updateGenericItem']('i-unhealthy', {
        value: HeartbeatOperations.STATUS.PING,
        updatedAt: outdatedTimestamp
      })

      // Register both for health tracking
      await heartbeat['registerInstancesForHealthCheck']([
        'i-healthy',
        'i-unhealthy'
      ])

      const result = await heartbeat.areAllInstancesHealthy()
      expect(result).toBe(false)
    })
  })

  describe('inherited behavior', () => {
    it('should handle basic value operations', async () => {
      // Verify we can use methods from parent class
      await heartbeat.updateValue('test-value', 'some-id')
      const value = await heartbeat.getValue('some-id')
      expect(value).toBe('test-value')
    })
  })
})
