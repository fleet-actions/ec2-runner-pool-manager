import { jest } from '@jest/globals'

// Mocking a class!
export const DynamoDBService = jest.fn() as jest.Mocked<
  typeof import('../../../src/services/dynamodb').DynamoDBService
>

export const createDynamoDBService =
  jest.fn<
    typeof import('../../../src/services/dynamodb').createDynamoDBService
  >()
