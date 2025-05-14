// __tests__/services/dynamodb/operations/basic-value-operations.test.ts
import { DynamoDBClient } from '../../../../src/services/dynamodb/dynamo-db-client'
import { startDb, stopDb, createTables, deleteTables } from 'jest-dynalite'

const { BasicValueOperations } = await import(
  '../../../../src/services/dynamodb/operations/basic-operations'
)

describe('BasicValueOperations', () => {
  // Create a concrete test class
  class TestValueOps<T> extends BasicValueOperations<T> {
    constructor(client: DynamoDBClient, identifier: string | null = 'test-id') {
      super('TEST_ENTITY', identifier, client)
    }
  }

  let client: DynamoDBClient
  let valueOps: TestValueOps<string>

  // Setup DynamoDB Local
  beforeAll(startDb)
  beforeEach(createTables)
  afterEach(deleteTables)
  afterAll(stopDb)

  beforeEach(() => {
    client = new DynamoDBClient('us-east-1', 'not used table')
  })

  describe('With existing identifier', () => {
    beforeEach(() => {
      valueOps = new TestValueOps<string>(client)
    })

    describe('updateValue and getValue', () => {
      it('should store and retrieve a string value', async () => {
        const testValue = 'test string value'

        await valueOps.updateValue(testValue)
        const result = await valueOps.getValue()

        expect(result).toBe(testValue)
      })

      it('should store and retrieve a complex object value', async () => {
        const objOps = new TestValueOps<{ name: string; count: number }>(client)
        const testObj = { name: 'test object', count: 42 }

        await objOps.updateValue(testObj)
        const result = await objOps.getValue()

        expect(result).toEqual(testObj)
      })

      it('should handle null values correctly', async () => {
        // Initial test for null retrieval
        const result = await valueOps.getValue()
        expect(result).toBeNull()
      })

      it('should update existing values', async () => {
        await valueOps.updateValue('initial value')
        await valueOps.updateValue('updated value')

        const result = await valueOps.getValue()
        expect(result).toBe('updated value')
      })
    })

    it('should error out when providing a custom id to an item', async () => {
      await expect(
        valueOps.updateValue('value for id1', 'id1')
      ).rejects.toThrow()
    })
  })

  describe('With a non-existent initial identifier', () => {
    beforeEach(() => {
      valueOps = new TestValueOps<string>(client, null)
    })

    it('should error out when providing no custom id', async () => {
      await expect(valueOps.updateValue('hello')).rejects.toThrow()
    })

    describe('newId parameter', () => {
      it('should store and retrieve values with different IDs', async () => {
        await valueOps.updateValue('value for id1', 'id1')
        await valueOps.updateValue('value for id2', 'id2')

        const result1 = await valueOps.getValue('id1')
        const result2 = await valueOps.getValue('id2')

        expect(result1).toBe('value for id1')
        expect(result2).toBe('value for id2')
      })
    })

    describe('multiple values', () => {
      it('should retrieve multiple items', async () => {
        await valueOps.updateValue('value1', 'id1')
        await valueOps.updateValue('value2', 'id2')

        const values = await valueOps.getValues(['id1', 'id2'])
        expect(values).toEqual(['value1', 'value2'])
      })

      it('should handle missing items in bulk operations', async () => {
        await valueOps.updateValue('exists', 'exists')

        const values = await valueOps.getValues(['exists', 'missing'])
        expect(values).toEqual(['exists', null])
      })
    })

    describe('getItem', () => {
      it('should retrieve the full item with metadata', async () => {
        const now = new Date()
        await valueOps.updateValue('test value', 'some-id')
        const item = await valueOps.getItem('some-id')

        expect(item).toMatchObject({
          PK: 'TYPE#TEST_ENTITY',
          SK: 'ID#some-id',
          entityType: 'TEST_ENTITY',
          identifier: 'some-id',
          value: 'test value'
        })

        // Check that updatedAt is correctly formatted
        expect(item?.updatedAt).toBe(now.toISOString().split('.')[0] + 'Z')
      })
    })
  })
})
