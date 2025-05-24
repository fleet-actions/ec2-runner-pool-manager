import { jest } from '@jest/globals'

export const release =
  jest.fn<typeof import('../../src/release/index.js').release>()

export const transitionToIdle =
  jest.fn<
    typeof import('../../src/release/transition-to-idle.js').transitionToIdle
  >()

export const releaseWorker =
  jest.fn<typeof import('../../src/release/release-workers.js').releaseWorker>()
