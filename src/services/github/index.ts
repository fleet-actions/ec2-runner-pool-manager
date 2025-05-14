import { GitHubClient } from './github-client.js'
import { RunnerOperations } from './operations/runner-operations.js'
import { RegistrationTokenOperations } from './operations/registration-token-operations.js'
import { GitHubContext } from '../types.js'

export class GitHubService {
  constructor(private client: GitHubClient) {}

  // 📝 This might not be used due to proxies
  getRunnerOperations() {
    return new RunnerOperations(this.client)
  }

  getRegistrationTokenOperations() {
    return new RegistrationTokenOperations(this.client)
  }

  // NOTE: Insert here additional GitHub-related operations as needed.
}

// Helper function to create a GitHubService instance.
// This will allow you to easily instantiate the service using your GitHub token.
export function createGitHubService(
  githubToken: string,
  context: GitHubContext
) {
  const client = new GitHubClient(githubToken, context)
  return new GitHubService(client)
}
