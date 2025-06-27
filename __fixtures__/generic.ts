import type { Instance } from '../src/provision/types'
import type { InstanceMessage } from '../src/services/sqs/operations/resource-class-operations'

export const GenericInstance: Instance = {
  id: 'i-generic',
  instanceType: 'c5.large',
  resourceClass: 'medium',
  cpu: 4,
  mmem: 2048,
  usageClass: 'on-demand',
  threshold: new Date(Date.now() + 1000 * 3600).toISOString() // 1 hr future
}

export const GenericInstanceMessage: InstanceMessage = GenericInstance
