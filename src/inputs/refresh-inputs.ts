import { parseBaseInputs } from './base-inputs.js'
import { RefreshInputs, ResourceClassConfigInput } from './types.js'
import { getNumber, getString, getStringArray, getGeneric } from './helpers.js'

import { REFRESH_DEFAULTS } from './defaults.js'

export function parseRefreshInputs(): RefreshInputs {
  const baseInputs = parseBaseInputs()

  return {
    // universally required
    ...baseInputs,
    mode: 'refresh',
    // mode-specific required
    ami: getString('ami', true),
    githubToken: getString('github-token', true),
    iamInstanceProfile: getString('iam-instance-profile', true),
    securityGroupIds: getStringArray('security-group-ids', true),
    subnetIds: getStringArray('subnet-ids', true),
    // optionally provided - set to true - this will depend on action.yml (documented) defaults
    githubRegTokenRefreshMins: getGithubRegTokenRefreshMins(),
    idleTimeSec: getNumber('idle-time-sec', false, REFRESH_DEFAULTS),
    maxRuntimeMin: getNumber('max-runtime-min', false, REFRESH_DEFAULTS),
    preRunnerScript: getString('pre-runner-script', false, REFRESH_DEFAULTS),
    resourceClassConfig: getResourceClassConfig()
  }
}

export function getGithubRegTokenRefreshMins(): number {
  const githubRegTokenRefreshMins = getNumber(
    'github-reg-token-refresh-min',
    false,
    REFRESH_DEFAULTS
  )
  if (githubRegTokenRefreshMins >= 60) {
    throw new Error(
      'github-reg-token-refresh-min must be less than 60 mins (suggested: 30 mins or less)'
    )
  }

  return githubRegTokenRefreshMins
}

export function getResourceClassConfig(): ResourceClassConfigInput {
  // account for entries:
  // { "large": { "cpu": 4, "mmem": 1024 } }
  const converterCB = (raw: string): ResourceClassConfigInput => {
    // JSON.parse will throw its own errors ok 👌
    const basicParse: ResourceClassConfigInput = JSON.parse(raw)

    const errorMessages: string[] = []
    // clean attribute values to be numbers, should allow for the following inputs:
    // .{ "large": { "cpu": 4, "mmem": 1024 } } OR quoted numbers
    // .{ "large": { "cpu": "4", "mmem": "1024" } }
    const numParse: ResourceClassConfigInput = {}
    Object.entries(basicParse).forEach(([name, attrs]) => {
      // Check for missing attributes first
      if (attrs.cpu === undefined) {
        errorMessages.push(`For ${name}: cpu attribute is missing`)
      }
      if (attrs.mmem === undefined) {
        errorMessages.push(`For ${name}: mmem attribute is missing`)
      }

      const cpu = Number(attrs.cpu)
      const mmem = Number(attrs.mmem)
      numParse[name] = { cpu, mmem }

      if (!cpu) {
        errorMessages.push(`For ${name}: cpu value "${attrs.cpu}" is invalid`)
      }
      if (!mmem) {
        errorMessages.push(`For ${name}: mmem value "${attrs.mmem}" is invalid`)
      }
    })

    if (errorMessages.length !== 0) {
      throw new Error(
        `Encountered error when parsing. See errors ${errorMessages.join('\n')}`
      )
    }

    return numParse
  }

  const config = getGeneric<ResourceClassConfigInput>(
    'resource-class-config',
    converterCB,
    false,
    REFRESH_DEFAULTS
  )

  // Validate that all CPU values are unique.
  const cpuValues = Object.values(config).map((attrs) => attrs.cpu)
  const uniqueCPUs = new Set(cpuValues)
  if (uniqueCPUs.size !== cpuValues.length) {
    throw new Error('Duplicate CPU values detected in resource class config')
  }

  // Validate that minimum memory strictly increases as CPU increases.
  // First, map each resource to an object containing its name, cpu, and mmem.
  const rca = Object.entries(config)
    .map(([name, attrs]) => ({ name, cpu: attrs.cpu, mmem: attrs.mmem }))
    .sort((a, b) => a.cpu - b.cpu)

  // Iterate over adjacent pairs to ensure that mmem of the higher cpu is greater than that of the lower.
  for (let i = 0; i < rca.length - 1; i++) {
    if (rca[i + 1].mmem <= rca[i].mmem) {
      throw new Error(
        `Invalid resource class config: Memory for resource class "${rca[i + 1].name}" (mmem=${rca[i + 1].mmem}) must be greater than memory for "${rca[i].name}" (mmem=${rca[i].mmem}) because CPU increased from ${rca[i].cpu} to ${rca[i + 1].cpu}.`
      )
    }
  }

  return config
}
