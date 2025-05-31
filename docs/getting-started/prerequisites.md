# Let's get up and running :pray:

Here's what you need:

1. Networking: VPC, subnet and security group
2. IAM: Permissions for the Github Runners and Instance Profile for the instances
3. Machine Image: EC2 AMI image

## 1. Networking

For this action to work, we need an available VPC, Subnet and Security group

- VPC: Create a new VPC or use an existing one
- Subnet: Ensure that the subnet can reach the internet (public subnet, or private subnet with a NAT Gateway)
- Security Group: When getting started, I recommend creating a permissive security groups and narrow down from there. If you need more restriction, see [github's recommendation](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/communicating-with-self-hosted-runners)

!!! note "Recommendation: 1 VPC with a subnet per AWS Region's availability zones"
    While atleast one subnet is required. I recommend creating and inputting a subnet for each of the availability zones to ensure that for however many instances is required for a workflow, AWS can quickly and cheaply provide them.

!!! note "Note: Accessibility to DynamoDB"
    The created instances polls the dynamodb service for various functionalities (safe self-termination, liveliness, etc.). When hardening access, just ensure that dynamodb is still accessible for the instances.

## 2. IAM

For this action to work, we need two IAM entities. One for the gihub runners themselves, and one for the EC2 instances. The latter is delivered via EC2 instance profiles. See the minimum permission policies below.

??? example "1. Github Runner Permissions (EC2/DynamoDB/SQS/Spot)"
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
              "iam:AWSServiceName": "spotfleet.amazonaws.com"
            }
          }
        }
      ]
    }
    ```

??? example "2. EC2 Instance Profile (DynamoDB, Self-Termination)"
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



!!! note "Note: Further Hardening"
    These example policies above are provided as a guide. They can and most likely should be limited even more by specifying the resources you use.

## 3. Machine Image

### :zap: Quickstart Recommendation: Runs On AWS AMI Images

To get up and running, I recommend using [run-on's AWS AMI images](https://github.com/runs-on/runner-images-for-aws). This will get you started quickly as they graciously keep an EC2-compatible machine image up to date with the packages used by [the official Github Runner images](https://github.com/actions/runner-images).

### Amazon Linux 2023

If you chose to use a bare Amazon Linux 2023 image, an additional script is required. This is supplied via the pre-runner-script input for mode: `refresh`

```yaml
## in refresh.yml

## other configurations ...
  with: 
    mode: refresh
    uses: fleet-actions/ec2-runner-pool-manager@main 
    pre-runner-script: |
      sudo yum update -y && \
      sudo yum install docker -y && \
      sudo yum install git -y && \
      sudo yum install libicu -y && \
      sudo systemctl enable docker
    # and other refresh inputs ... 
```

### Other images

If you chose to use other AMI images, for the instances to function properly you need:

- AWS CLI
- Depedencies for running the github actions artifacts.

These can be supplied via the `pre-runner-script` or built in your custom AMI image.
