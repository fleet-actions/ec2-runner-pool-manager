import { jest } from '@jest/globals'

export const refresh =
  jest.fn<typeof import('../../src/refresh/index.js').refresh>()

export const manageIdleTime =
  jest.fn<
    typeof import('../../src/refresh/manage-idempotent-states.js').manageIdleTime
  >()

export const manageRegistrationToken =
  jest.fn<
    typeof import('../../src/refresh/manage-rt/index.js').manageRegistrationToken
  >()

export const dataIsUptoDate =
  jest.fn<
    typeof import('../../src/refresh/manage-rt/index.js').dataIsUptoDate
  >()

export const manageSubnetIds =
  jest.fn<
    typeof import('../../src/refresh/manage-idempotent-states.js').manageSubnetIds
  >()

export const manageMaxRuntimeMin =
  jest.fn<
    typeof import('../../src/refresh/manage-idempotent-states.ts').manageMaxRuntimeMin
  >()

export const manageResourceClassConfiguration =
  jest.fn<
    typeof import('../../src/refresh/manage-idempotent-states.ts').manageResourceClassConfiguration
  >()

export const manageTerminations =
  jest.fn<
    typeof import('../../src/refresh/manage-terminations.ts').manageTerminations
  >()
