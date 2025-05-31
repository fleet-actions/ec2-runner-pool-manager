import { FleetOperations } from '../services/ec2/operations/fleet-operations.js'
import { HeartbeatOperations } from '../services/dynamodb/operations/heartbeat-operations.js'
import type {
  ResourceSpec,
  LTDatav2,
  ResourceClassConfig
} from '../services/types.js'
import type { InstanceMessage } from '../services/sqs/operations/resource-class-operations.js'
import { InstanceOperations as EC2InstanceOperations } from '../services/ec2/operations/instance-operations.js'
import { InstanceOperations as DDBInstanceOperations } from '../services/dynamodb/operations/instance-operations.js'
import { ResourceClassConfigOperations } from '../services/sqs/operations/resource-class-operations.js'
import { WorkerSignalOperations } from '../services/dynamodb/operations/signal-operations.js'
import { UsageClassType } from '@aws-sdk/client-ec2'

// NOTE: Allow for 'partial' when we decide to allow for multiple fleet attempts
export type FleetStates = 'success' | 'partial' | 'failed'

export type Instance = InstanceMessage

export interface FleetResult {
  instances: Instance[]
  status: FleetStates
}

export interface CreationInput {
  numInstancesRequired: number // exit if 0
  usageClass: UsageClassType //spot - Assume 'spot' for this implementation
  resourceClass: string
  resourceSpec: ResourceSpec // { cpu, mmem, queueUrl }
  allowedInstanceTypes: string[] // [ "c*", "m*", "r5.large" ]
  subnetIds: string[] // array of overrides created
  launchTemplate: LTDatav2 // refrenced launchTemplateName

  runId: string // passing as initial id for instance to register against

  // Service objects
  // (creation) ec2 for creating fleets
  ec2Ops: {
    fleetOperations: FleetOperations
    instanceOperations: EC2InstanceOperations
  }

  // (creation) ddb for validation
  ddbOps: {
    heartbeatOperations: HeartbeatOperations
    workerSignalOperations: WorkerSignalOperations
    instanceOperations: DDBInstanceOperations
  }

  // (creation) no need for sqs, keep creation focused
  // - termination for post/finalize provision
  // - rcc for selection & post/finalize provision
}

export interface CreationOuput {
  // cannot accept 'partial' fleet creation state
  state: FleetStates
  numInstancesCreated: number
  instances: Instance[]
  labels: string[]
}

export interface SelectionInput {
  instanceCount: number
  resourceClass: string // which sqs(as pool) to look in to
  usageClass: UsageClassType
  // 🔍 For aiding resource release
  resourceClassConfig: ResourceClassConfig
  allowedInstanceTypes: string[]
  sqsOps: ResourceClassConfigOperations
  ddbOps: {
    instanceOperations: DDBInstanceOperations
    heartbeatOperations: HeartbeatOperations
    workerSignalOperations: WorkerSignalOperations
  }
  ec2Ops: { instanceOperations: EC2InstanceOperations }
  runId: string
}

export interface SelectionOutput {
  numInstancesSelected: number
  numInstancesRequired: number
  instances: Instance[]
  labels: string[]
}

export type PostProvisionInputs = {
  runId: string
  maxRuntimeMin: number // for instance registration & selection to running transition
  idleTimeSec: number
  resourceClassConfig: ResourceClassConfig
  selectionOutput: SelectionOutput
  creationOutput: CreationOuput
  ec2Ops: EC2InstanceOperations // for dumping resources
  ddbOps: {
    instanceOperations: DDBInstanceOperations
  } // instance-operations
  sqsOps: ResourceClassConfigOperations // resource class config (requeueing selected to pool)
}
