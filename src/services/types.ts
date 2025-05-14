import type { ResourceSpecInput } from '../inputs/types.js'

export interface GitHubContext {
  owner: string
  repo: string
}

export interface LTDatav2 {
  name?: string
  ami: string
  iamInstanceProfile: string
  securityGroupIds: string[]
  userDataHash?: string
  userData?: string
  userDataBase64?: string
}

export interface Metadata {
  idleTimeSec: number
  subnetIds: string[]
  ghRegistrationToken: RegistrationTokenData
  maxRuntimeMin: number
  resourceClassConfig: ResourceClassConfig
  launchTemplate: LTDatav2
}

export interface RegistrationTokenData {
  token: string
  timestamp: string
  expires_at: string
}

export type ResourceSpec = ResourceSpecInput & {
  queueUrl: string
}

export type ResourceClassConfig = {
  [key: string]: ResourceSpec
}
