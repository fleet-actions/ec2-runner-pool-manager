import * as core from '@actions/core'
import { LaunchTemplateOperations as ec2ltOps } from '../../services/ec2/operations/launch-template-operations.js'
import { LaunchTemplateOperations as ddbltOps } from '../../services/dynamodb/operations/metadata-operations.js'
import { hasLTChanged, populateLTName } from './helpers.js'
import { composeUserData } from './userdata.js'
import { LTDatav2, GitHubContext } from '../../services/types.js'

// class exported for testability
export class LaunchTemplateManager {
  constructor(
    private tableName: string,
    private githubContext: GitHubContext,
    private ec2Ops: ec2ltOps,
    private ddbOps: ddbltOps,
    private ltName = 'ci-launch-template'
  ) {
    this.ltName = `${this.githubContext.owner}-${this.githubContext.repo}-${ltName}`
  }

  async manage(ltInput: LTDatav2) {
    if (!ltInput.userData) {
      throw new Error('User Data must be provided')
    }

    // 1. Populate missing fields
    ltInput = populateLTName(ltInput, this.ltName)
    ltInput = composeUserData({
      tableName: this.tableName,
      context: this.githubContext,
      ltInput
    })

    // 2. Check for existing data in DDB
    const storedData = await this.ddbOps.getLaunchTemplateData()
    if (!storedData) {
      core.info('No launch template found; creating a new one...')
      await this.createNewLaunchTemplate(ltInput)
      await this.ddbOps.updateLaunchTemplateData(ltInput)
    } else if (hasLTChanged(ltInput, storedData)) {
      core.info(`Launch template has changed. Updating...`)
      await this.updateLaunchTemplate(ltInput)
      await this.ddbOps.updateLaunchTemplateData(ltInput)
    } else {
      core.info('No changes detected in launch template.')
    }
  }

  // Following methods made public for testability
  public async createNewLaunchTemplate(ltInput: LTDatav2) {
    const name: string = ltInput.name || this.ltName
    const exists = await this.ec2Ops.launchTemplateExists(name)
    if (exists) {
      core.info(
        `Launch template: ${name} already exists, deleting to be recreated...`
      )
      await this.ec2Ops.deleteLaunchTemplate({ LaunchTemplateName: name })
      core.info(`Launch template: ${name} deleted...`)
    }

    // now, should be clear to create a fresh lt
    const response = await this.ec2Ops.createLaunchTemplate(ltInput)
    const errors = response.Warning?.Errors
    if (errors && errors.length > 0) {
      core.error('Failed to create a new launch template.')
      throw new Error(errors.map((e: any) => e.Message).join(' '))
    }
  }

  public async updateLaunchTemplate(ltInput: LTDatav2): Promise<void> {
    const { name } = ltInput
    core.info(`Creating a new version for LT: ${name}`)
    const newVersionResponse =
      await this.ec2Ops.createLaunchTemplateVersion(ltInput)
    const newVersionNumber =
      newVersionResponse.LaunchTemplateVersion?.VersionNumber

    if (!newVersionNumber) {
      core.error('Failed to create a new launch template version.')
      throw new Error('Failed to create a new LT version')
    }

    core.info(`Setting default version to ${newVersionNumber}`)
    await this.ec2Ops.modifyLaunchTemplate({
      LaunchTemplateName: name,
      DefaultVersion: newVersionNumber.toString()
    })
    core.info(
      `Launch template ${name} updated to default version ${newVersionNumber}`
    )
  }
}

export async function manageLT(
  tableName: string,
  githubContext: GitHubContext,
  data: LTDatav2,
  ec2ltOps: ec2ltOps,
  ddbltOps: ddbltOps
) {
  const manager = new LaunchTemplateManager(
    tableName,
    githubContext,
    ec2ltOps,
    ddbltOps
  )
  await manager.manage(data)
}
