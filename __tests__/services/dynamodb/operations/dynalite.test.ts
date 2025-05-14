import { createDynamoDBService } from '../../../../src/services/dynamodb'
import { BasicValueOperations } from '../../../../src/services/dynamodb/operations/basic-operations'
// At the beginning of your test or setup
import { startDb, stopDb, createTables, deleteTables } from 'jest-dynalite'

beforeAll(startDb)
beforeEach(createTables)
afterEach(deleteTables)
afterAll(stopDb)

describe('DynamoDB Jest-Dynalite Test', () => {
  it('should write and read a value', async () => {
    // Regular service creation works in tests thanks to your client implementation
    const service = createDynamoDBService('us-east-1', 'doesnt-matter')

    // Create a test operation
    class TestOp extends BasicValueOperations<string> {
      constructor(client: typeof service.client) {
        super('TEST_ENTITY', 'test-id', client)
      }
    }

    const testOp = new TestOp(service['client'])

    // Write a value
    await testOp.updateValue('test-value')

    // Read it back
    const value = await testOp.getValue()

    expect(value).toBe('test-value')
  })
})
