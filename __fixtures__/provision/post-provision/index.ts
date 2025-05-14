import { jest } from '@jest/globals'

// COMPLETE THE PATTERN
export const reconcileFleetState =
  jest.fn<
    typeof import('../../../src/provision/post-provision/reconcile-fleet-state').reconcileFleetState
  >()

export const processSuccessfulProvision =
  jest.fn<
    typeof import('../../../src/provision/post-provision/process-successful-provision').processSuccessfulProvision
  >()

export const processFailedProvision =
  jest.fn<
    typeof import('../../../src/provision/post-provision/process-failed-provision').processFailedProvision
  >()

export const dumpResources =
  jest.fn<
    typeof import('../../../src/provision/post-provision/dump-resources').dumpResources
  >()
