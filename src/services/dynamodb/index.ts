import { DynamoDBClient } from './dynamo-db-client.js'
import {
  IdleTimeOperations,
  RegistrationTokenOperations,
  SubnetOperations,
  MaxRuntimeMinOperations,
  ResourceClassConfigOperations,
  LaunchTemplateOperations,
  GeneralMetadataOperations
} from './operations/metadata-operations.js'
import { BootstrapOperations } from './operations/bootstrap-operations.js'
import { HeartbeatOperations } from './operations/heartbeat-operations.js'
import { InstanceOperations } from './operations/instance-operations.js'
import { ApplicationOperations } from './operations/application-operations.js'
import { WorkerSignalOperations } from './operations/signal-operations.js'

export class DynamoDBService {
  // 🔍 client made public for testing
  constructor(public client: DynamoDBClient) {}

  getApplicationOperations() {
    return new ApplicationOperations(this.client)
  }

  getSubnetOperations() {
    return new SubnetOperations(this.client)
  }

  getIdleTimeOperations() {
    return new IdleTimeOperations(this.client)
  }

  getRegistrationTokenOperations() {
    return new RegistrationTokenOperations(this.client)
  }

  getLaunchTemplateOperations() {
    return new LaunchTemplateOperations(this.client)
  }

  getMaxRuntimeMinOperations() {
    return new MaxRuntimeMinOperations(this.client)
  }

  getResourceClassConfigOperations() {
    return new ResourceClassConfigOperations(this.client)
  }

  getGeneralMetadataOperations() {
    return new GeneralMetadataOperations(this.client)
  }

  // fleet creation
  getBootstrapOperations() {
    return new BootstrapOperations(this.client)
  }

  getWorkerSignalOperations() {
    return new WorkerSignalOperations(this.client)
  }

  // getLeaderSignalOperations() {
  //   return new LeaderSignalOperations(this.client)
  // }

  // fleet selection/creation
  getHeartbeatOperations() {
    return new HeartbeatOperations(this.client)
  }

  // instance state transitioner
  getInstanceOperations() {
    return new InstanceOperations(this.client)
  }
}

// function to be imported by other files to leverage operations
export function createDynamoDBService(awsRegion: string, tableName: string) {
  const client = new DynamoDBClient(awsRegion, tableName)
  return new DynamoDBService(client)
}
