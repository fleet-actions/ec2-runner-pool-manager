import { UsageClassType } from '@aws-sdk/client-ec2'

export type ValidMode = 'provision' | 'refresh' | 'release'

export interface BaseInputs {
  mode: string // application validates mode value
  tableName: string
  awsRegion: string
  githubRepoOwner: string
  githubRepoName: string
  githubRunId: string
}

// export type UsageClass = 'spot' | 'on-demand'

export interface ProvisionInputs extends BaseInputs {
  // overrides base
  mode: 'provision'
  // provision-specific
  instanceCount: number
  allowedInstanceTypes: string[]
  resourceClass: string
  usageClass: UsageClassType
  maxRuntimeMin: number
}

export interface ReleaseInputs extends BaseInputs {
  // overrides base
  mode: 'release'
  // release-specific
  // instanceIds: string[]
  // labels: string[]
}

export type ResourceSpecInput = {
  cpu: number
  mmem: number
}

export type ResourceClassConfigInput = {
  [key: string]: ResourceSpecInput
}

export interface RefreshInputs extends BaseInputs {
  // overrides base
  mode: 'refresh'
  // refresh-specific
  idleTimeSec: number
  maxRuntimeMin: number
  githubToken: string
  githubRegTokenRefreshMins: number
  ami: string
  iamInstanceProfile: string
  securityGroupIds: string[]
  preRunnerScript: string
  subnetIds: string[]
  resourceClassConfig: ResourceClassConfigInput
}

export type ActionInputs = ProvisionInputs | ReleaseInputs | RefreshInputs
