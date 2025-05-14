import { jest } from '@jest/globals'

// Mocking a class!
export const GitHubService = jest.fn() as jest.Mocked<
  typeof import('../../../src/services/github').GitHubService
>

export const createGitHubService =
  jest.fn<typeof import('../../../src/services/github').createGitHubService>()
