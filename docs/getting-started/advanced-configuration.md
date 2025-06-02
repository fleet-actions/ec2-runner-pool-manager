# Advanced Configuration :construction_site:

## 1. Introduction

This document explores the additional optional inputs given opened up to the controlplane via inputs to `provision` and `refresh` in order to give the operator the ability to better control the lifecycles of the instances beyond initial defaults. See the [Prerequisites](./prerequisites.md) and [Quickstart](./quickstart.md) for the initial setup guides.

!!! note
    Hopefully this page can stand by itself, but feel free to read through the [Architecture](../todo.md) to see this from a wider context.

## 2. Fine-Tuning Runner Lifecycle and Resource Management

### Understanding Runner Timeouts

Several inputs in the `refresh` mode control how long runners live and how often their configurations. Finding the right balance is crucial:

!!! tip "**Strategy** :straight_ruler:"
    Start with the defaults. If you notice frequent cold starts and your budget allows, consider increasing `idle-time-sec`. If cost is a primary concern, shorten `idle-time-sec` but monitor workflow times. Ensure `max-runtime-min` accommodates your longest jobs.

#### `idle-time-sec`: Lifetime in Resource Pool :person_swimming:

Defined at the `refresh` level with a default of 300s/5m. This defines how long the instance lives in the resource pool for following workflows to pickup! If in the pool for too long, the instance will be terminated by `refresh` or will undergo self-termination.

```yaml
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          # idle-time-sec: 300 # <---- (Default: 300 seconds)
```

??? note "`idle-time-sec` - Shorter or Longer :thinking:"
    * **Shorter:** Reduces costs by terminating idle instances sooner. However, it might lead to more "cold starts" if subsequent jobs arrive just after an instance terminated, increasing wait times.
    * **Longer:** Increases runner availability and reduces cold starts, but can lead to higher costs due to instances sitting idle for longer.
    * Align this with your typical job arrival patterns. If jobs are infrequent, a shorter idle time might be better. If jobs are frequent, a longer idle time can improve CI/CD pipeline speed.

#### `max-runtime-min`: Expected Max Job Duration :person_running:

Defined at the `refresh` level (default: 30 minutes) and overridable at the `provision` level, this parameter sets the maximum active duration for an instance *between its assignment to a workflow and its release back to the pool*.

It acts as a **critical safeguard**, enabling the control plane to safely terminate instances. This prevents them from being stranded due to misconfigured `release` jobs or other unforeseen issues that would otherwise leave resources unreleased.

```yaml
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          # max-runtime-min: 30 # <---- (Default: 30m)
```

Overriding at the `provision` level. The operator can set some expectations for the controlplane to say how long a specific workflow can take from `provision` to `release` and control this timeouts at a workflow level instead of at the repo level.

```yaml
      - name: Provision Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          # max-runtime-min: 30 # <---- (overrides refresh input if provided)
```

??? note "`max-runtime-min` - Shorter or Longer :thinking:"
    * **Recommendation** Be conservative. Whatever your longest running job is at a workflow, add 10-15 minutes to it to avoid pre-mature termination.
    * This can be set at either the `refresh` or `provision` level to set per-workflow expectations.

### Instance Purchasing Options (`provision` mode)

The `provision` mode offers ways to control the type and cost of EC2 instances provisioned for specific workflows.

#### `usage-class`: On-Demand or Spot Instances

You can specify whether to provision `on-demand` or `spot` instances at the workflow level using the `usage-class` input in `provision` mode. The default is `on-demand`. It's generally recommended to use `on-demand` instances for critical workflows and `spot` instances for non-critical CI tasks.

```yaml
      - name: Provision Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          # usage-class: on-demand # <---- (Default: on-demand)
```

!!! success " The Right Match: On-Demand vs. Spot :handshake:"
    The controlplane is able to discriminate between instances which have `on-demand` or `spot` lifecycles. If none available, the contolplane creates specific instances faithful to the `usage-class` constraint.

#### `allowed-instance-types`: Instance Family types by wildcards

This input accepts a space-separated list of EC2 instance types (e.g., `m5.large c6i* r*`) or family wildcards (e.g., `c*`, `m*`, `r*`) that the workflow should use. Instances matching these patterns will be selected from the existing resource pool or provisioned if new ones are needed. This capability aligns with the [AWS AllowedInstanceTypes](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-ec2fleet-instancerequirementsrequest.html) specification.

The default is `c* m* r*`. This setting allows the control plane to choose from a wide array of [instance types](https://aws.amazon.com/ec2/instance-types/).

```yaml
      - name: Provision Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          # allowed-instance-types: "c* m* r*" # <---- (Default: "c* m* r*")
```

!!! tip "Be generous with `usage-class: spot` :fish:"
    Telling the controlplane to use spot instances for the workflow? Cast your net wide! Defer to the generous `c* m* r*` defaults to ensure that AWS always has capacities for your instances when your workflow asks for these instances.

!!! success "The Right Match: `allowed-instance-types`"
    Similar to `usage-class`, the controlplane is able to discriminate instances from the shared resource pool given the patterns and instance types specified in `allowed-instance-types`.

## 3. Advanced AMI and `pre-runner-script` Strategies

Bake as much in to the AMI image as you can to ensure timely startup times. As per [Quickstart](../getting-started/quickstart.md), feel free to use Runs-On's machine images to not worry about any of this. However if you do decide to roll your own, there are a couple of hard requirements to ensure proper functionality:

- [x] `git` & `docker`: Checking out code and running containers
- [x] `aws cli`: Controlplane communication via dynamodb
- [x] `libicu`: Configuring instances against github actions as a self-hosted runner

### `pre-runner-script`

Here are some recommended scripts when using various bare AMI images.

!!! info "Refining recommended scripts"
    If any of these scripts do not work to initialize the runners, feel free to raise a pull request! It would be much appreciated ~ 🙏

??? example "Amazon Linux 2023"
    ```yaml
          - name: Provision Mode
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: provision
              ami: ami-123 # <--- AL2023 image
              pre-runner-script: |
                #!/bin/bash
                sudo yum update -y && \
                sudo yum install docker -y && \
                sudo yum install git -y && \
                sudo yum install libicu -y && \
                sudo systemctl enable docker
    ```

??? example "Ubuntu 24"
    ```yaml
          - name: Provision Mode
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: provision
              ami: ami-123 # <--- Ubuntu 24
              pre-runner-script: |
                #!/bin/bash
                sudo apt update && sudo apt upgrade -y
                sudo apt install -y docker.io git libicu-dev unzip curl

                # AWS CLI v2 --> x86_64
                curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
                unzip awscliv2.zip
                sudo ./aws/install
                rm -rf awscliv2.zip aws

                sudo systemctl enable docker
                sudo systemctl start docker
    ```

## 4. Resource Classes for Varied Workloads

The operator can control the size of the instances at the level of the workflow (ie. `provision`) - with sizes defined at the level of the repo (ie. `refresh`). The former is specifies the resource class of the instance for the workflow (via `resource-class`), and the latter specifies the valid resource classes (via `resource-class-config`).

### Pre-Defined Resource Classes & Usage

The controlplane provides a comprehensive set of resource classes that can be used at a workflow level. At the time of this writing. the defaults are the following:

| Resource Class | CPU (cores) | Minimum Memory (MB) |
|---------------|------------|-------------|
| large         | 2          | 4,096       |
| xlarge        | 4          | 8,192       |
| 2xlarge       | 8          | 16,384      |
| 4xlarge       | 16         | 32,768      |
| 8xlarge       | 32         | 65,536      |
| 12xlarge      | 48         | 98,304      |
| 16xlarge      | 64         | 131,072     |

And to use these pre-defined resource classes, simply specify the `resource-class` attribute at the `provision` level

```yaml
      - name: Provision Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          resource-class: "xlarge" # <---- (Default: "large")
```

!!! tip "Greater control with `allowed-instance-types`"
    Say that for a specific workflow, you have specified the following:
    ```yaml
          - name: Provision Mode
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: provision
              resource-class: "xlarge"
              allowed-instance-types: "c6* m5*"
    ```
    Then the controlplane will only pick up resources tagged with `xlarge` given that their instance types match with the `c6` and `m5` families. If none available from the pool, then only instances which fulfill these requirements will be provisioned.

!!! success "The Right Match: `resource-class`"
    Similar to `usage-class` and `allowed-instance-types` - the controlplane is able to discriminate instances from the shared resource pool given the specified `resource-class`.


??? note "Keeping consistent with AWS 📚"
    - **Naming Convention**: Resource class names align with [AWS EC2 instance type naming](https://aws.amazon.com/ec2/instance-types/) (e.g., `large` = 2 CPU cores, `xlarge` = 4 CPU cores, etc.)
    - **Memory Allocation**: Memory values represent minimum requirements and are set at approximately 2GB per CPU core. This ensures compatibility across the mainstream instance families:
        - Compute-optimized instances (`c` family): ~2GB per core
        - General-purpose instances (`m` family): ~4GB per core
        - Memory-optimized instances (`r` family): ~8GB per core

### Custom Resource Classes

If you have custom requiremetns - here's an example. Note that this this overrides the pre-defined resource classes.

```yaml
# in refresh.yml
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          resource-class-config: '{ "custom-large": { "cpu": 4, "mmem": 8000 }, "custom-extra-large": { "cpu": 8, "mmem": 16000 } }'
```

```yaml
# in ci.yml
      - name: Provision Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          resource-class: "custom-large"
```

## 5. Permission & Network Hardening

Beyond the basic IAM policies in [Prerequisites](./prerequisites.md), feel free to further harden IAM Policies and the Networking around the provided subnets.

### IAM Least Privilege

#### IAM Entity for the ControlPlane

- When configuring credentials with `aws-actions/configure-aws-credentials`, it is recommended to use [OIDC](https://github.com/aws-actions/configure-aws-credentials?tab=readme-ov-file#oidc) to prevent the usage of permanent credentials within CI.
- `iam:PassRole` - Once you know the exact role the controlplane is passing on to the instances, I highly recommend adding its ARN to the

    ```json
    "Effect": "Allow",
    "Action": ["iam:PassRole"],
    "Resource": // <--- arn of the role
    ```

- SQS & DynamoDB - These resources are created with a repo-specific prefix which we can use to harden the IAM policy further `fleet-actions-ec2-runner-pool-manager`

    ```json
    // DDB
    "Resource": "arn:aws:dynamodb:*:*:table/{repo-owner}-{repo-name}-*"
    // SQS
    "Resource": "arn:aws:sqs:*:*:{repo-owner}-{repo-name}-*"
    ```

#### IAM Entity for the EC2 Instance Profile

At a minimum, the role given to the instance needs to be able to self-terminate and read-write from a ddb table. As such, we can explore two avenues of hardening the role handed to the ec2 instance beyond the minimum defined in the [Prerequisites](./prerequisites.md#4-iam-role--instance-profile-for-ec2-instances):

- **Self-Termination**: Can use [Self referencial ARNs](https://www.reddit.com/r/aws/comments/6tnuxw/selfreferential_arns/) to ensure that `aws ec2 terminate-instances` can only be really delivered to the instance that calls it.
- **Read & Write DynamoDB Table**: As above, restrict the resource to an arn that follows the repo-owner and repo-name `"arn:aws:dynamodb:*:*:table/{repo-owner}-{repo-name}-*"`

!!! warning "Interacting with other AWS Services ☁️"
    If your self-hosted runner needs to communicate with other AWS services (ie. `s3`), feel free to expand the EC2 instance profile - but always ensure that the minimum permissions specified here are included.

??? tip "Add `AmazonSSMManagedInstanceCore` - connect to your self-hosted runners ⭐"
    [Session Manager](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-systems-manager-session-manager.html) is my favourite way to connect to instances as they do not require bastion hosts or managing SSH keys. I recommend expanding your EC2 instance profile with AWS Managed Policy [AmazonSSMManagedInstanceCore](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-instance-profile.html). When used with Machine Images built on Amazon Linux 2023 and Ubuntu - Session Manager should work out of the box as the [SSM Agent is pre-installed](https://docs.aws.amazon.com/systems-manager/latest/userguide/manually-install-ssm-agent-linux.html) 🤩


### Network Security

#### Security Groups

Only allow outbound traffic necessary. Outbound traffic can be further restricted as per Github's prescription [self-hosted runner communication](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/communicating-with-self-hosted-runners).

#### Subnets and VPC Endpoints

We recommend adding [VPC endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/create-interface-endpoint.html) to your VPC's route tables if you prefer to keep AWS service calls off the public internet. The self-hosted runners already make calls to DynamoDB in the background so a Gateway Endpoints will bring those network costs to zero. Furthermore, if you need to pull container images from ECR or access artifacts in S3, consider adding the S3 Gateway Endpoint as well.
