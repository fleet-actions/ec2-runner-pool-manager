import * as core from '@actions/core'
import { Endpoints } from '@octokit/types'
import { ApplicationOperations } from './application-operation.js'

// Define a type alias for the response from listing runners
type ListRunnersResponse =
  Endpoints['GET /repos/{owner}/{repo}/actions/runners']['response']['data']
// Extract the type for a single runner from the runners array in the response
type SelfHostedRunner = ListRunnersResponse['runners'][number]

export class RunnerOperations extends ApplicationOperations {
  /**
   * Retrieves a self-hosted runner by label.
   */
  async getRunner(label: string): Promise<SelfHostedRunner | null> {
    try {
      const octokit = this.client.getClient()
      // Using paginate to get all runners; type asserted to ListRunnersResponse
      const runnersResponse = (await octokit.paginate(
        'GET /repos/{owner}/{repo}/actions/runners',
        { ...this.context }
      )) as ListRunnersResponse

      // Filter runners that have a label matching the provided value
      const foundRunners = runnersResponse.runners.filter(
        (runner: SelfHostedRunner) =>
          runner.labels && runner.labels.some((lbl) => lbl.name === label)
      )
      return foundRunners.length > 0 ? foundRunners[0] : null
    } catch (error) {
      core.error(`Error fetching runner by label: ${error}`)
      return null
    }
  }

  /**
   * Removes a self-hosted runner by label.
   */
  async removeRunner(label: string): Promise<void> {
    const runner = await this.getRunner(label)
    if (!runner) {
      core.info(`No runner found with label ${label}; skipping removal.`)
      return
    }

    try {
      const octokit = this.client.getClient()
      await octokit.request(
        'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}',
        {
          ...this.context,
          runner_id: runner.id
        }
      )
      core.info(`Runner ${runner.name} removed successfully.`)
    } catch (error) {
      core.error(`Error removing runner: ${error}`)
      throw error
    }
  }
}
