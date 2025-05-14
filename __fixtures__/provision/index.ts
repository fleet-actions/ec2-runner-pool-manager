import { jest } from '@jest/globals'

export const provision =
  jest.fn<typeof import('../../src/provision/index.js').provision>()
