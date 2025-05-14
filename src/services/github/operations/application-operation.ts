import { GitHubClient } from '../github-client.js'
import { GitHubContext } from '../../types.js'

export class ApplicationOperations {
  protected client: GitHubClient
  protected context: GitHubContext

  constructor(client: GitHubClient) {
    this.client = client
    this.context = this.client.getContext()
  }
}
