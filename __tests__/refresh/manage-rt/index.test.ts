import { jest } from '@jest/globals'
import { mock, MockProxy } from 'jest-mock-extended'
import { RegistrationTokenOperations as ddbRegTokenOps } from '../../../src/services/dynamodb/operations/metadata-operations.js'
import { RegistrationTokenData } from '../../../src/services/types.js'
import { RegistrationTokenOperations as ghRegTokenOps } from '../../../src/services/github/operations/registration-token-operations.js'
import * as core from '../../../__fixtures__/core.js'

Object.entries({
  '@actions/core': core
}).forEach(([path, mock]) => {
  jest.unstable_mockModule(path, () => mock)
})

// actual imports
const { dataIsUptoDate, manageRegistrationToken } = await import(
  '../../../src/refresh/manage-rt/index.js'
)

// NOTE: `manageRegistrationToken` does not achieve full isolation
// .will need to place dataIsUptoDate in another file for ease of testing
// ..and more isolation. This should be OK for now
describe('refresh/manage-registration-token.ts#manageRegistrationToken', () => {
  const NOW = 1234567890000 // Some fixed timestamp
  const REFRESH_MINS = 15
  const REFRESH_MSEC = REFRESH_MINS * 60 * 1000
  const ONE_HOUR_MSEC = 3600000
  let ghOps: MockProxy<ghRegTokenOps>
  let ddbOps: MockProxy<ddbRegTokenOps>

  beforeEach(() => {
    jest.clearAllMocks()
    ghOps = mock<ghRegTokenOps>()
    ddbOps = mock<ddbRegTokenOps>()
    // Mock Date.now() for consistent timestamps
    jest.spyOn(Date, 'now').mockImplementation(() => NOW)
  })

  it('does not fetch new token when current token is up to date', async () => {
    // Setup

    ddbOps.getValue.mockResolvedValue({
      token: 'current-token',
      timestamp: new Date().toISOString(),
      expires_at: new Date(Date.now() + ONE_HOUR_MSEC).toISOString() // expires in 1 hour
    })

    // Execute
    await manageRegistrationToken(REFRESH_MINS, ghOps, ddbOps)

    // Verify
    expect(ddbOps.getValue).toHaveBeenCalledTimes(1)
    expect(ghOps.getRegistrationToken).not.toHaveBeenCalled()
    expect(ddbOps.updateValue).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      'Registration token is up to date...'
    )
  })

  it('handles null current token data by fetching new token', async () => {
    // Setup
    ddbOps.getValue.mockResolvedValue(null)
    ghOps.getRegistrationToken.mockResolvedValue({
      token: 'new-token',
      expires_at: new Date(Date.now() + ONE_HOUR_MSEC * 2).toISOString() // expires in 2 hours
    })

    // Execute
    await manageRegistrationToken(REFRESH_MINS, ghOps, ddbOps)

    // Verify
    expect(ddbOps.getValue).toHaveBeenCalledTimes(1)
    expect(ghOps.getRegistrationToken).toHaveBeenCalledTimes(1)
    expect(ddbOps.updateValue).toHaveBeenCalledTimes(1)
  })

  describe('finding expired stored tokens from db', () => {
    beforeEach(() => {
      // Setup
      ddbOps.getValue.mockResolvedValue({
        token: 'old-token',
        timestamp: new Date(Date.now() - REFRESH_MSEC * 2).toISOString(), // created past 2 refreshs periods ago
        expires_at: new Date(Date.now() - REFRESH_MSEC).toISOString() // hard expiry past 1 refresh period ago
      })
    })

    it('fetches from gh and stores new token when current token needs refresh', async () => {
      // isolated setup
      ghOps.getRegistrationToken.mockResolvedValue({
        token: 'new-token',
        expires_at: new Date(Date.now() + REFRESH_MSEC * 2).toISOString() // expires in 2 refresh periods from now
      })
      // Execute
      await manageRegistrationToken(REFRESH_MINS, ghOps, ddbOps)

      // Verify
      expect(ddbOps.getValue).toHaveBeenCalledTimes(1)
      expect(ghOps.getRegistrationToken).toHaveBeenCalledTimes(1)
      expect(ddbOps.updateValue).toHaveBeenCalledTimes(1)
      expect(ddbOps.updateValue).toHaveBeenCalledWith({
        token: 'new-token',
        timestamp: expect.any(String),
        expires_at: expect.any(String)
      })
      expect(core.info).toHaveBeenCalledWith(
        'Registration token not up to date, fetching a new token...'
      )
      expect(core.info).toHaveBeenCalledWith(
        'Registration token fetched, storing to ddb...'
      )
      expect(core.info).toHaveBeenCalledWith(
        'Registration token successfully stored to ddb...'
      )
    })

    it('handles various non ISOZ timestamp formats and converts them to ISO 8601 UTC', async () => {
      // isolated setup
      const mockDateUTC = new Date(Date.now() + REFRESH_MSEC * 2).toUTCString()
      const mockDateISOZ = new Date(Date.now() + REFRESH_MSEC * 2).toISOString()
      ghOps.getRegistrationToken.mockResolvedValue({
        token: 'new-token',
        expires_at: mockDateUTC
      })

      // Execute
      await manageRegistrationToken(REFRESH_MINS, ghOps, ddbOps)

      expect(ddbOps.updateValue).toHaveBeenCalledWith({
        token: 'new-token',
        timestamp: expect.stringMatching(/Z$/),
        expires_at: mockDateISOZ
      })
    })
  })
})

describe('refresh/manage-registration-token.ts#dataIsUptoDate', () => {
  const NOW = 1234567890000 // Some fixed timestamp
  const REFRESH_MINS = 15
  beforeEach(() => {
    jest.clearAllMocks()
    // Mock Date.now() to return our fixed timestamp
    jest.spyOn(Date, 'now').mockImplementation(() => NOW)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns false when data is null', () => {
    const result = dataIsUptoDate(null, REFRESH_MINS)
    expect(result).toBe(false)
    expect(core.info).toHaveBeenCalledWith(
      'No Registration Token data found ...'
    )
  })

  it('returns false when token is expired', () => {
    const data: RegistrationTokenData = {
      token: 'some-token',
      timestamp: new Date(NOW - REFRESH_MINS * 2 * 60 * 1000).toISOString(), // 120 mins ago
      expires_at: new Date(NOW - REFRESH_MINS * 60 * 1000).toISOString() // 60 mins ago
    }

    const result = dataIsUptoDate(data, REFRESH_MINS)

    expect(result).toBe(false)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(`has already expired ${REFRESH_MINS} minutes ago`)
    )
  })

  it('returns false when token needs refresh based on refresh time', () => {
    const data: RegistrationTokenData = {
      token: 'some-token',
      timestamp: new Date(NOW - REFRESH_MINS * 2 * 60 * 1000).toISOString(), // expired past refresh threshold
      expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() // but not expired past hard expiry (ie. still in future)
    }

    const result = dataIsUptoDate(data, REFRESH_MINS) // refresh after 60 mins

    expect(result).toBe(false)
    expect(core.info).toHaveBeenCalledWith(
      'Registration token has not expired but will be refreshed...'
    )
  })

  it('returns true when token is valid and not due for refresh', () => {
    const data: RegistrationTokenData = {
      token: 'some-token',
      timestamp: new Date(NOW - REFRESH_MINS * 0.5 * 60 * 1000).toISOString(), // still to soft expire (half past of refresh duration)
      expires_at: new Date(NOW + 10 * 60 * 1000).toISOString() // still to expire (10 mins from now)
    }

    const result = dataIsUptoDate(data, REFRESH_MINS) // refresh after 60 mins

    expect(result).toBe(true)
    // No warning or info messages should be called
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.info).not.toHaveBeenCalled()
  })
})

describe('placeholder.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes the placeholder test', () => {
    expect(1).toEqual(1)
  })
})
