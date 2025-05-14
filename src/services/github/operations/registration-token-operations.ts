import * as core from '@actions/core'
import { Endpoints } from '@octokit/types'
import { ApplicationOperations } from './application-operation.js'

// Define a type alias for the registration token response
type GetRegistrationTokenResponse =
  Endpoints['POST /repos/{owner}/{repo}/actions/runners/registration-token']['response']['data']

export class RegistrationTokenOperations extends ApplicationOperations {
  /**
   * Retrieves a GitHub registration token for self-hosted runners.
   */
  async getRegistrationToken(): Promise<GetRegistrationTokenResponse> {
    try {
      const octokit = this.client.getClient()
      const response = await octokit.request(
        'POST /repos/{owner}/{repo}/actions/runners/registration-token',
        { ...this.context }
      )
      core.info('GitHub Registration Token is received')
      // The response.data should conform to GetRegistrationTokenResponse, which includes a "token" property.
      const tokenResponse = response.data as GetRegistrationTokenResponse
      return tokenResponse // caller can use .token and .expires_at
    } catch (error) {
      core.error(`Error retrieving registration token: ${error}`)
      throw error
    }
  }
}
