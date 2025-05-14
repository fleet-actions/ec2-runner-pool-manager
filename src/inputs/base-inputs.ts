import * as github from '@actions/github'
import { BaseInputs } from './types.js'
import { getString } from './helpers.js'

export function parseBaseInputs(): BaseInputs {
  // NOTE: will throw exception if GITHUB_REPOSITORY not provided, no need to provide own checks
  // Ex: ::error::context.repo requires a GITHUB_REPOSITORY environment variable like 'owner/repo'
  const githubRepoOwner = github.context.repo.owner
  const githubRepoName = github.context.repo.repo
  const githubRunId = isNaN(github.context.runId)
    ? process.env.RUN_ID || 'LOCAL_ID'
    : github.context.runId.toString()

  return {
    mode: getString('mode', true),
    tableName: getString('table-name', true),
    awsRegion: getString('aws-region', true),
    githubRunId: githubRunId,
    githubRepoName: githubRepoName,
    githubRepoOwner: githubRepoOwner
  }
}
