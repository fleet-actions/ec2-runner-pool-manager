# Prerequisites :octicons-checklist-16:

Before [Quickstart](quickstart.md), we need to sort out the inputs for `mode: refresh` in order to initialize everything. Once done, these inputs are used in `.github/workflows/refresh.yml` - like so:

??? example "Example - `.github/workflows/refresh.yml`"
    ```yaml
    jobs:
      refresh_job:
        runs-on: ubuntu-latest
        steps:
          - name: Configure AWS Credentials
            uses: aws-actions/configure-aws-credentials@main
            with:
              # IAM User credentials for GH Runner
              aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
              aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
              aws-region: us-east-1
          - name: Refresh Mode
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: refresh
              # Github Personal Access Token
              github-token: ${{ secrets.GH_PAT }}
              # EC2 Machine Image
              ami: ami-123
              # Profile passed on to the EC2 instance for permissions
              iam-instance-profile: your-instance-profile
              # Security group assigned to EC2 instances
              security-group-ids: sg-123
              # Subnets where EC2s are placed
              subnet-ids: subnet-123 subnet-456 subnet-789
              # AWS region (default: us-east-1)
              aws-region: us-east-1
              # Injected script, install additional packages here, see Machine Image section below
              pre-runner-script: |
                echo "hello world"
    ```

Here's your checklist:

- [x] GitHub Personal Access Token (PAT)
- [x] Networking: VPC, Subnet and Security Group
- [x] IAM User & Permissions for GitHub Actions Workflow
- [x] IAM Role & Instance Profile for EC2 Instances
- [x] Machine Image: EC2 AMI image

## 1. GitHub Personal Access Token (PAT)

A [GitHub Personal Access Token (PAT)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) is required for the action to manage self-hosted runners. This will be used for the `refresh` mode creates temporary tokens to handles runner registration with GitHub.

1. **Create the PAT** with `repo` scope
2. **Store as a secret** named `GH_PAT`. We access this as `github-token: ${{ secrets.GH_PAT }}`

```yaml
# used here ...
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          github-token: ${{ secrets.GH_PAT }} # <----
```

## 2. Networking

For this action to work, we need an available VPC, Subnet and Security group

- VPC: Create a new VPC or use an existing one
- Subnet: Ensure that the subnet can reach the internet (public subnet, or private subnet with a NAT Gateway)
- Security Group: When getting started, I recommend creating a permissive security groups and narrow down from there. If you need more restriction, see [github's recommendation](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/communicating-with-self-hosted-runners)

```yaml
# used here ...
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          security-group-ids: sg-123 # <-----
          subnet-ids: subnet-123 subnet-456 subnet-789 # <-----
```

!!! tip "Recommendation: 1 VPC with a subnet per AWS Region's availability zones"
    While atleast one subnet is required. I recommend creating and inputting a subnet for each of the availability zones to ensure that for however many instances is required for a workflow, AWS can quickly and cheaply provide them.

!!! note "Note: Accessibility to DynamoDB"
    The created instances polls the dynamodb service for various functionalities (safe self-termination, liveliness, etc.). When hardening access, just ensure that dynamodb is still accessible for the instances.

## 3. IAM User for GitHub Actions Workflow

For the GitHub Actions workflow to interact with your AWS account (to manage EC2 instances, DynamoDB, SQS, Launch Templates, etc.), it needs an IAM identity with appropriate permissions. We will be using [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)

To quickly get started, we will be using an IAM User with credentials stored secrets with names: `AWS_ACCESS_KEY_ID` & `AWS_SECRET_ACCESS_KEY`. Consider using [OIDC](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) for further hardening.

??? example "Policy for GitHub Actions Workflow"
    This policy grants the GitHub Actions workflow the necessary permissions. The `iam:PassRole` permission is crucial for allowing the workflow to pass an IAM role to the EC2 instances it creates (the EC2 Instance Profile).
    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "ec2:CreateFleet",
            "ec2:RunInstances",
            "ec2:TerminateInstances",
            "ec2:CreateTags",
            "ec2:*LaunchTemplate*",
            "ec2:Describe*"
          ],
          "Resource": "*"
        },
        {
          "Effect": "Allow",
          "Action": ["iam:PassRole"],
          "Resource": "arn:aws:iam::*:role/*"
        },
        {
          "Effect": "Allow",
          "Action": [
            "dynamodb:*Item",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:DescribeTable",
            "dynamodb:CreateTable",
            "dynamodb:ListTables"
          ],
          "Resource": "arn:aws:dynamodb:*:*:table/*"
        },
        {
          "Effect": "Allow",
          "Action": ["sqs:*Queue*", "sqs:*Message"],
          "Resource": "arn:aws:sqs:*:*:*"
        },
        {
          "Effect": "Allow",
          "Action": "iam:CreateServiceLinkedRole",
          "Resource": "*",
          "Condition": {
            "StringEquals": {
              "iam:AWSServiceName": ["spotfleet.amazonaws.com", "ec2.amazonaws.com"]
            }
          }
        }
      ]
    }
    ```

```yaml
# used here ...
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }} # <---
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }} # <---
          aws-region: us-east-1
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          # ...
```

## 4. IAM Role & Instance Profile for EC2 Instances

The EC2 instances launched by this action need their own set of permissions to perform tasks (see: [instance agent](../architecture/instance-initialization.md)) These permissions are granted via an IAM Role -> attached to the instances through an EC2 Instance Profile.

To quickly get started, **use the AWS console** to [create an IAM Role](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html). When you select “EC2” as the trusted service during role creation, the console automagically generates a [matching EC2 Instance Profile](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html) (with the same name). Once the role and its instance profile exist, attach the following policies :arrow_down:

??? example "Policy for EC2 Instance Profile"
    This policy allows the EC2 instances to interact with DynamoDB and terminate themselves if they carry a specific tag.
    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Action": ["dynamodb:*Item"],
          "Effect": "Allow",
          "Resource": "*"
        },
        {
          "Action": "ec2:TerminateInstances",
          "Condition": {
            "StringEquals": {
              "ec2:ResourceTag/AllowSelfTermination": "true"
            }
          },
          "Effect": "Allow",
          "Resource": "*"
        }
      ]
    }
    ```

```yaml
# used here...
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          iam-instance-profile: your-instance-profile # <---
```

The example policies above are provided as a guide - See [Advanced Configuration](./advanced-configuration.md#iam-least-privilege) for hardening!

## 5. Machine Image

### :zap: Quickstart Recommendation: Runs On Community AMI Images

To get up and running, I recommend using [run-on's AWS AMI images](https://github.com/runs-on/runner-images-for-aws). This will get you started quickly as they graciously keep an EC2-compatible machine image up to date with the packages used by [the official Github Runner images](https://github.com/actions/runner-images).

```yaml
# used here...
      - name: Refresh Mode
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          ami: ami-123 # <---
```

### Other Images (Amazon Linux/Ubuntu)

If you want to get started with other machine images, see prescriptions at [Advanced Configuration - custom AMIs and pre runner scripts](./advanced-configuration.md#3-advanced-ami-and-pre-runner-script-strategies)
