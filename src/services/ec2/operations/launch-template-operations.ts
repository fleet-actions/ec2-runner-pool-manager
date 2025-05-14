// services/ec2/operations/launch-template-operations.ts
import {
  DescribeLaunchTemplateVersionsCommand,
  DescribeLaunchTemplateVersionsCommandInput,
  DescribeLaunchTemplateVersionsCommandOutput,
  CreateLaunchTemplateCommand,
  CreateLaunchTemplateCommandInput,
  CreateLaunchTemplateCommandOutput,
  CreateLaunchTemplateVersionCommand,
  CreateLaunchTemplateVersionCommandInput,
  CreateLaunchTemplateVersionCommandOutput,
  ModifyLaunchTemplateCommand,
  ModifyLaunchTemplateCommandInput,
  ModifyLaunchTemplateCommandOutput,
  RequestLaunchTemplateData,
  DeleteLaunchTemplateCommand,
  DeleteLaunchTemplateCommandInput,
  DeleteLaunchTemplateCommandOutput,
  DescribeLaunchTemplatesCommand,
  DescribeLaunchTemplatesCommandInput,
  DescribeLaunchTemplatesCommandOutput
} from '@aws-sdk/client-ec2'
import { ApplicationOperations } from './application-operations.js'
import { LTDatav2 } from '../../types.js'

export class LaunchTemplateOperations extends ApplicationOperations {
  /**
   * Checks if a launch template exists.
   * @param launchTemplateName The name of the launch template to check
   * @returns Promise<boolean> True if the template exists, false otherwise
   */
  async launchTemplateExists(launchTemplateName: string): Promise<boolean> {
    try {
      const response = await this.describeLaunchTemplate({
        LaunchTemplateNames: [launchTemplateName]
      })
      return response.LaunchTemplates?.length === 1
    } catch (error: any) {
      // If the template doesn't exist, AWS throws an InvalidLaunchTemplateName.NotFoundException error
      if (error.name === 'InvalidLaunchTemplateName.NotFoundException') {
        return false
      }
      // Re-throw any other errors
      throw error
    }
  }

  /**
   * Describes a single launch template.
   * @param params The describe launch templates parameters
   * @returns Promise with the describe operation result
   */
  async describeLaunchTemplate(
    params: DescribeLaunchTemplatesCommandInput
  ): Promise<DescribeLaunchTemplatesCommandOutput> {
    const command = new DescribeLaunchTemplatesCommand(params)
    const response = await this.client.getClient().send(command)
    return response
  }

  // https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ec2/command/DescribeLaunchTemplateVersionsCommand/
  async describeLaunchTemplateVersions(
    params: DescribeLaunchTemplateVersionsCommandInput
  ): Promise<DescribeLaunchTemplateVersionsCommandOutput> {
    const command = new DescribeLaunchTemplateVersionsCommand(params)
    const response = await this.client.getClient().send(command)
    return response
  }

  // convenience method to only look at the default version
  async describeDefaultLaunchTempalteVersion(
    params: DescribeLaunchTemplateVersionsCommandInput
  ): Promise<DescribeLaunchTemplateVersionsCommandOutput> {
    const defaultParams = {
      ...params,
      Versions: ['$Default']
    }
    return await this.describeLaunchTemplateVersions(defaultParams)
  }

  /**
   * Creates a new launch template.
   */
  async createLaunchTemplate(
    data: LTDatav2
  ): Promise<CreateLaunchTemplateCommandOutput> {
    const params: CreateLaunchTemplateCommandInput =
      LaunchTemplateOperations.transformParams(data)
    const command = new CreateLaunchTemplateCommand(params)
    const response = await this.client.getClient().send(command)
    return response
  }

  /**
   * Creates a new version of an existing launch template.
   * Use this to update the launch template (e.g., new user data, new security groups).
   */
  async createLaunchTemplateVersion(
    data: LTDatav2
  ): Promise<CreateLaunchTemplateVersionCommandOutput> {
    const params: CreateLaunchTemplateVersionCommandInput =
      LaunchTemplateOperations.transformParams(data)
    const command = new CreateLaunchTemplateVersionCommand(params)
    const response = await this.client.getClient().send(command)
    return response
  }

  /**
   * Modifies the launch template, for example to set a new default version.
   */
  async modifyLaunchTemplate(
    params: ModifyLaunchTemplateCommandInput
  ): Promise<ModifyLaunchTemplateCommandOutput> {
    const command = new ModifyLaunchTemplateCommand(params)
    const response = await this.client.getClient().send(command)
    return response
  }

  public static transformParams(data: LTDatav2): {
    LaunchTemplateName: string
    LaunchTemplateData: RequestLaunchTemplateData
  } {
    if (!data.name) throw new Error('LT name required...')
    if (!data.userDataBase64) throw new Error('User Data (Base64) required ...')

    const transformed = {
      LaunchTemplateName: data.name,
      LaunchTemplateData: {
        ImageId: data.ami,
        IamInstanceProfile: {
          Name: data.iamInstanceProfile
        },
        SecurityGroupIds: data.securityGroupIds,
        UserData: data.userDataBase64, // NOT RAW USERDATA

        // Inject these params to the base launch template
        // LT config allows access to instance metadata when instance is created from this
        //
        MetadataOptions: {
          // LaunchTemplateInstanceMetadataOptionsRequest
          HttpTokens: 'required' as const,
          HttpPutResponseHopLimit: 10,
          HttpEndpoint: 'enabled' as const, // hard requirement for remotely predicting runner labels!
          HttpProtocolIpv6: 'disabled' as const,
          InstanceMetadataTags: 'enabled' as const // self-access to tags may be useful
        }
      }
    }

    return transformed
  }

  /**
   * Deletes a launch template.
   * @param params The delete launch template parameters
   * @returns Promise with the delete operation result
   */
  async deleteLaunchTemplate(
    params: DeleteLaunchTemplateCommandInput
  ): Promise<DeleteLaunchTemplateCommandOutput> {
    const command = new DeleteLaunchTemplateCommand(params)
    const response = await this.client.getClient().send(command)
    return response
  }
}
