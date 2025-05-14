// github-client.ts
import * as github from '@actions/github'
import { GitHubContext } from '../types.js'

export class GitHubClient {
  private octokit: ReturnType<typeof github.getOctokit>
  private context: GitHubContext

  constructor(token: string, context: GitHubContext) {
    this.octokit = github.getOctokit(token)
    this.context = context
  }

  getClient(): ReturnType<typeof github.getOctokit> {
    return this.octokit
  }

  getContext(): GitHubContext {
    return this.context
  }
}
