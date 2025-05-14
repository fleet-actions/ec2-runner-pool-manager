import { jest } from '@jest/globals'

export const hasLTChanged =
  jest.fn<
    typeof import('../../../src/refresh/manage-lt/helpers.js').hasLTChanged
  >()

export const populateLTName =
  jest.fn<
    typeof import('../../../src/refresh/manage-lt/helpers.js').populateLTName
  >()
