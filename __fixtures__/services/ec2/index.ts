import { jest } from '@jest/globals'

// Mocking a class!
export const EC2Service = jest.fn() as jest.Mocked<
  typeof import('../../../src/services/ec2').EC2Service
>

export const createEC2Service =
  jest.fn<typeof import('../../../src/services/ec2').createEC2Service>()
