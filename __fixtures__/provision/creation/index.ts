import { jest } from '@jest/globals'

export const buildFleetCreationInput =
  jest.fn<
    typeof import('../../../src/provision/creation/utils/build-fleet-creation-input.js').buildFleetCreationInput
  >()

export const processFleetResponse =
  jest.fn<
    typeof import('../../../src/provision/creation/utils/process-fleet-reponse.js').processFleetResponse
  >()

export const fleetCreation =
  jest.fn<
    typeof import('../../../src/provision/creation/fleet-creation.js').fleetCreation
  >()

export const fleetValidation =
  jest.fn<
    typeof import('../../../src/provision/creation/fleet-validation.js').fleetValidation
  >()
