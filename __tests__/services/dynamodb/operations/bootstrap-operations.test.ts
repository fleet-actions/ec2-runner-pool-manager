// __tests__/services/dynamodb/operations/bootstrap-operations.test.ts
import { jest } from '@jest/globals'
import { DynamoDBClient } from '../../../../src/services/dynamodb/dynamo-db-client'
// import { BootstrapOperations } from '../../../../src/services/dynamodb/operations/bootstrap-operations'
import { startDb, stopDb, createTables, deleteTables } from 'jest-dynalite'
import * as core from '../../../../__fixtures__/core.js'

// Mock @actions/core
Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

const { BootstrapOperations } = await import(
  '../../../../src/services/dynamodb/operations/bootstrap-operations'
)

describe('BootstrapOperations', () => {
  let client: DynamoDBClient
  let bootstrap: InstanceType<typeof BootstrapOperations>

  // Setup DynamoDB Local
  beforeAll(startDb)
  beforeEach(createTables)
  afterEach(deleteTables)
  afterAll(stopDb)

  beforeEach(() => {
    jest.clearAllMocks()
    client = new DynamoDBClient('us-east-1', 'main-table', 'testing-table')
    bootstrap = new BootstrapOperations(client)
  })

  describe('instance tracking', () => {
    it('should register instances for tracking', async () => {
      const instanceIds = ['i-123', 'i-456', 'i-789']
      await bootstrap.registerInstancesForTracking(instanceIds)

      // Can't directly test private property, but we can verify through behavior
      const result = await bootstrap.areAllInstancesComplete()
      expect(result).toBe(false)

      // registration of 3 instances
      expect(bootstrap._totalInstanceCount).toBe(3)
    })

    it('should track instance state changes', async () => {
      // Step 1: Register instances
      const instanceIds = ['i-123', 'i-456']
      await bootstrap.registerInstancesForTracking(instanceIds)

      // Step 2: Verify initial state (should be incomplete)
      expect(await bootstrap.areAllInstancesComplete()).toBe(false)

      // Step 3: Update instance states to USERDATA_COMPLETED
      await bootstrap.updateValue(
        BootstrapOperations.STATUS.USERDATA_COMPLETED,
        'i-123'
      )

      // Step 4: Still incomplete (one is only USERDATA_COMPLETED)
      expect(await bootstrap.areAllInstancesComplete()).toBe(false)

      // Step 5: Update both to USERDATA_REGISTRATION_COMPLETED
      await bootstrap.updateValue(
        BootstrapOperations.STATUS.USERDATA_REGISTRATION_COMPLETED,
        'i-123'
      )
      await bootstrap.updateValue(
        BootstrapOperations.STATUS.USERDATA_REGISTRATION_COMPLETED,
        'i-456'
      )

      // Step 6: Now all should be complete
      expect(await bootstrap.areAllInstancesComplete()).toBe(true)
    })
  })

  describe('polling functionality', () => {
    it('should timeout on non-existent instance', async () => {
      // Run the real poll with minimal timeout/interval
      const result = await bootstrap.areAllInstancesCompletePoll(
        ['i-dont-exist'],
        0.5, // 1 second timeout
        0.1 // 100ms interval
      )

      expect(result.state).toBe(false)
      expect(result.message).toContain('⌛️')
    })

    it('should still timeout if only some instances have the correct state', async () => {
      await bootstrap.updateValue(
        BootstrapOperations.STATUS.USERDATA_REGISTRATION_COMPLETED,
        'i-exist'
      )
      await bootstrap.updateValue(
        BootstrapOperations.STATUS.USERDATA_COMPLETED,
        'i-didnt-bootstrap-intime'
      )

      const result = await bootstrap.areAllInstancesCompletePoll(
        ['i-exist', 'i-didnt-bootstrap-intime'],
        0.5, // 1 second timeout
        0.1 // 100ms interval
      )

      expect(result.state).toBe(false)
      expect(result.message).toContain('⌛️')
    })

    it('should return success when all instances have transitioned to the correct state', async () => {
      await bootstrap.updateValue(
        BootstrapOperations.STATUS.USERDATA_REGISTRATION_COMPLETED,
        'i-exist'
      )
      const result = await bootstrap.areAllInstancesCompletePoll(
        ['i-exist'],
        0.5, // 1 second timeout
        0.1 // 100ms interval
      )

      expect(result.state).toBe(true)
      expect(result.message).toContain('🎉')
    })
  })

  describe('inherited behavior', () => {
    it('should handle basic value operations', async () => {
      // Verify we can use methods from parent class
      await bootstrap.updateValue('test-value', 'some-id')
      const value = await bootstrap.getValue('some-id')
      expect(value).toBe('test-value')
    })
  })
})
