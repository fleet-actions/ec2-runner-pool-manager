import * as core from '@actions/core'
import dayjs from 'dayjs'
import { RegistrationTokenOperations as ghRegTokenOps } from '../../services/github/operations/registration-token-operations.js'
import { RegistrationTokenOperations as ddbRegTokenOps } from '../../services/dynamodb/operations/metadata-operations.js'
import { RegistrationTokenData } from '../../services/types.js'

export async function manageRegistrationToken(
  githubTokenRefreshMins: number,
  ghRegTokenOps: ghRegTokenOps,
  ddbRegTokenOps: ddbRegTokenOps
) {
  const currentData = await ddbRegTokenOps.getValue()
  const isUptoDate = dataIsUptoDate(currentData, githubTokenRefreshMins)

  if (!isUptoDate) {
    core.info('Registration token not up to date, fetching a new token...')
    const newTokenData = await ghRegTokenOps.getRegistrationToken()
    const token = newTokenData.token
    // Set to: UTC time, ISO 8601 format.
    // https://docs.github.com/en/rest/using-the-rest-api/timezones-and-the-rest-api?apiVersion=2022-11-28
    const expiresAtISOZ = new Date(newTokenData.expires_at).toISOString()
    const nowISOZ = new Date(Date.now()).toISOString()
    core.info('Registration token fetched, storing to ddb...')
    await ddbRegTokenOps.updateValue({
      token: token,
      timestamp: nowISOZ,
      expires_at: expiresAtISOZ
    })
    core.info('Registration token successfully stored to ddb...')
  } else {
    core.info('Registration token is up to date...')
  }
}

export function dataIsUptoDate(
  data: RegistrationTokenData | null,
  refreshMins: number
): boolean {
  let isUptoDate = true

  if (!data) {
    core.info('No Registration Token data found ...')
    isUptoDate = false
  } else {
    // currentData available, now more sophisticated expiry
    const nowDt = new Date(Date.now())
    const expiryDt = new Date(data.expires_at)
    const refreshDt = dayjs(data.timestamp).add(refreshMins, 'minute').toDate() // dt marked for safe refresh

    // check expiry
    if (expiryDt.getTime() <= nowDt.getTime()) {
      const minutesAgo = Math.round(
        (nowDt.getTime() - expiryDt.getTime()) / (1000 * 60)
      )
      core.warning(
        `Registration token has already expired ${minutesAgo} minutes ago! (expiry: ${expiryDt.toISOString()})...`
      )
      core.warning(
        'Will refresh, but some runners may have picked up an EXPIRED token, check your runners...'
      )
      isUptoDate = false
    } else if (refreshDt.getTime() <= nowDt.getTime()) {
      core.info('Registration token has not expired but will be refreshed...')
      isUptoDate = false
    }
  }

  return isUptoDate
}
