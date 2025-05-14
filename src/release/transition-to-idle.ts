import * as core from '@actions/core'
import type {
  InstanceItem,
  InstanceOperations
} from '../services/dynamodb/operations/instance-operations.js'

// 🔍 Extract state transition logic
export async function transitionToIdle(
  instances: InstanceItem[],
  runId: string,
  idleTimeSec: number,
  ddbOps: InstanceOperations
): Promise<{ successful: InstanceItem[]; unsuccessful: InstanceItem[] }> {
  const threshold = new Date(Date.now() + idleTimeSec * 1000).toISOString()

  const response = await Promise.allSettled(
    instances.map((instance) => {
      return ddbOps.instanceStateTransition({
        id: instance.identifier,
        expectedRunID: runId,
        newRunID: '', // 🔍 Being released
        expectedState: 'running',
        newState: 'idle',
        newThreshold: threshold,
        conditionSelectsUnexpired: true
      })
    })
  )

  const successful: InstanceItem[] = []
  const unsuccessful: InstanceItem[] = []

  response.forEach((resp, index) => {
    if (resp.status === 'fulfilled') {
      successful.push(instances[index])
    } else {
      core.warning(resp.reason)
      unsuccessful.push(instances[index])
    }
  })

  return { successful, unsuccessful }
}
