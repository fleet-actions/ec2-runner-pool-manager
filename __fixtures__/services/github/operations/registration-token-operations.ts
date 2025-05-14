import { jest } from '@jest/globals'

// Mocking a class!
export const RegistrationTokenOperations = jest.fn() as jest.Mocked<
  typeof import('../../../../src/services/github/operations/registration-token-operations.js').RegistrationTokenOperations
>
