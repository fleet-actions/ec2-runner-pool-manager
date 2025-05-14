import { jest } from '@jest/globals'

// Mocking a class!
// OMG, this works somehow T_T
export const RegistrationTokenOperations = Object.assign(
  jest.fn()
) as jest.Mocked<
  typeof import('../../../../src/services/dynamodb/operations/metadata-operations.js').RegistrationTokenOperations
>

// AUTHORS NOTES: If we want to override properties with mocked the static values/methods
// .we need to wrap jest.fn IN Object.assign
/*
export const RegistrationTokenOperations = Object.assign(jest.fn(), {
  // static method: jest.fn()
  // static value: <some value>
  validateValue: jest.fn()
}) as jest.Mocked<
  typeof import('../../../../src/services/dynamodb/operations/metadata-operations.js').RegistrationTokenOperations
>
*/

///////////
// LEFT OVER AUTHORS NOTES (WITH FRUSTRATION): Simply jest.fn() as jest.Mocked<typeof ...> does not work
// .if the class that is being imported now has static properties (values/methods)
/*

export const Foo = Object.assign(jest.fn(), {
  validateValue: jest.fn()
}) as jest.Mocked<
  typeof import('../../../../src/services/dynamodb/operations/metadata-operations.js').RegistrationTokenOperations
>

### ERROR ENCOUNTERED
Conversion of type 'Mock<(client: DynamoDBClient) => MockedObject<RegistrationTokenOperations>>' to type
  'MockedClass<typeof RegistrationTokenOperations>' may be a mistake because neither type sufficiently
  overlaps with the other. If this was intentional, convert the expression to 'unknown' first.

Property 'validateValue' is missing in type
  'Mock<(client: DynamoDBClient) => MockedObject<RegistrationTokenOperations>>'
  but required in type '{ prototype: MockedObject<RegistrationTokenOperations>;
  validateValue: MockedFunction<(input: RegistrationTokenData | null) => RegistrationTokenData>; }'.ts(2352)

*/
