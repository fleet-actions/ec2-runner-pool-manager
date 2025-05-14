import { jest } from '@jest/globals'

// import { matchWildcardPatterns } from '../../../src/provision/selection/utils/match-wildcard-patterns'

export const claimWorker =
  jest.fn<
    typeof import('../../../src/provision/selection/claim-worker').claimWorker
  >()

export const matchWildcardPatterns =
  jest.fn<
    typeof import('../../../src/provision/selection/utils/match-wildcard-patterns').matchWildcardPatterns
  >()
