# Scale & Reuse Self-Hosted EC2 Runners inside GitHub Actions 🚀♻️

<img width="1225" alt="Screenshot 2025-05-26 at 6 30 07 PM" src="https://github.com/user-attachments/assets/e6ed55e0-a890-4c63-a05f-50cd343d52aa" />

[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

This GitHub Action enables you to provision and reuse self-hosted EC2 runners
with a simple/native controlplane.

## ⚡️ Motivation

This project was born from a desire to simplify the management of self-hosted
runners. The goal was to dynamically provision, pool, reuse, and safely control
runner lifetimes directly within GitHub Actions, avoiding the complexities of:

- Deploying and managing separate control planes.
- Configuring webhooks.
- Sifting through logs in external cloud providers, when GitHub Actions offers
  far more accessible runner logs.

Inspired by powerful tools like
[Actions Runner Controller](https://github.com/actions/actions-runner-controller),
[terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner),
and [machulav/ec2-github-runner](https://github.com/machulav/ec2-github-runner),
this action explores streamlined, YAML-centric approach to runner pooling and
lifecycle management.

## ✨ Features

- Declaratively specify number of runners to provision for a workflow.
- Any provisioned runners are placed in a shared pool for other workflows to
  pick up.
- Minimize paying for cold-starts by reusing existing runners
- Single runs_on syntax for all tests `runs_on: ${{ github.run_id }}`
- Native Control Plane in Github Actions for transparent runner logs:
  - See which instances are terminated, selected or created for a workflow.
- Declaratively specify lifetimes of runners
  - i.e., how long should a runner keep itself alive when put in the shared
    pool?

## 🔍 How does it work?

<img width="1225" alt="image" src="https://github.com/user-attachments/assets/edac8c92-2118-4c73-bb9d-49e7b210dd29" />

## 🛠️ Modes of Operation

The action operates in THREE distinct modes (`provision`/`release`/`refresh`):

1. **`provision`**: Allocates EC2 instances from the pool (or creates new ones
   if needed) workflow jobs.
   - ✏️ Simply specify amount of instances required for workflow (ex.
     `instance-count: 10`)
   - ✏️ Use runners with: `runs-on: ${{ github.run_id }}`.
2. **`release`**: Returns the used EC2 instances to the pool for re-use.
3. **`refresh`**: Manages general configuration of the EC2 runner pool. This
   mode is intended to be run on a schedule (e.g., via cron) to:
   - ☁️ Create infrastructure (DynamoDB, SQS) & initialize shared metadata
   - ♻️ Continually propagate any changes to the Launch Template (AMI, SG,
     user-data) or shared metadata (subnets, lifetimes)
   - ♻️ Refresh GitHub registration tokens.
   - ⚡ Cleanup any long-living instances - just in case instances fail to
     safely self-terminate and become orphaned

<img width="1225" alt="image" src="https://github.com/user-attachments/assets/f70bd492-1638-44c4-96bd-957d8e2529c0" />

## ⚙️ Prerequisites

- **AWS Credentials:** Configure AWS credentials (e.g., via
  `aws-actions/configure-aws-credentials`) with permissions to manage EC2
  instances, Launch Templates, IAM roles, SQS, DynamoDB. (See below for minimum
  credentials)
- **GitHub Personal Access Token (for `refresh` mode):** A GitHub PAT with
  `repo` scope is required for the `refresh` mode to register runners with
  GitHub.
- **AWS Infrastructure:** Need ec2 instance profile, subnet/s and security
  group/s.

## 🚀 QuickStart

### 1. Provision and Release Runners in a Workflow

This example demonstrates provisioning runners that subsequent jobs can use by
targeting `github.run_id`.

```yaml
name: CI

on: [push]

jobs:
  provision_runners:
    name: Pickup Or Create
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Provision
        id: provision_step
        uses: fleet-actions/ec2-runner-pool-manager@v1
        with:
          mode: provision
          instance-count: 2

  matrix_job_on_ec2:
    name: Run Matrix Job on EC2
    needs: provision_runners
    runs-on: ${{ github.run_id }} # pickup compute via runId
    strategy:
      matrix:
        task_id: [1, 2]
    steps:
      - run: |
          echo "Running task ${{ matrix.task_id }}..."
          sleep 20 # Simulate work for this task

  release_runners:
    name: Release For Reuse
    runs-on: ubuntu-latest
    needs: [provision_runners, matrix_job]
    if: ${{ always() }}
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Release
        uses: fleet-actions/ec2-runner-pool-manager@v1
        with:
          mode: release
```

### 2. Scheduled Refresh for the Runner Pool

Create a separate workflow file (e.g., `.github/workflows/refresh-runners.yml`):

```yaml
name: Refresh EC2 Runner Pool

on:
  schedule:
    - cron: '*/15 * * * *' # OK as long as cron exeuctes 2-3x an hour
  workflow_dispatch: # Manually trigger whenever to get started

jobs:
  refresh_pool:
    name: Initialize Infra & Keep Tokens Fresh
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v1
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID_FOR_REFRESH }}
          aws-secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY_FOR_REFRESH }}
          aws-region: us-east-1
      - name: Refresh EC2 Runner Pool
        uses: fleet-actions/ec2-runner-pool-manager@v1
        with:
          mode: refresh
          github-token: ${{ secrets.GH_PAT_FOR_RUNNERS }}
          ami: ami-123 # Specify your latest AMI ID
          iam-instance-profile: YourInstanceProfileName
          security-group-ids: sg-123
          subnet-ids: subnet-123 subnet-456
          # Add other refresh-specific inputs as needed
          # See👇
```

## 📋 Inputs

The following inputs are available for the action. Some are common, while others
are mode-specific.

### Common Inputs (All Modes - `provision`/`release`/`refresh`)

| Input        | Description                                       | Required | Default     |
| ------------ | ------------------------------------------------- | -------- | ----------- |
| `mode`       | Operation mode: `provision`, `release`, `refresh` | Yes      |             |
| `aws-region` | AWS region for resources.                         | No       | `us-east-1` |

### `refresh` Mode Inputs

**Required for `refresh`:**

| Input                  | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `ami`                  | AMI ID for the EC2 launch template.                   |
| `github-token`         | GitHub PAT (`repo` scope) for runner registration.    |
| `iam-instance-profile` | IAM instance profile name for runner AWS permissions. |
| `security-group-ids`   | Space-separated security group IDs for EC2 runners.   |
| `subnet-ids`           | Space-separated subnet IDs for launching EC2 runners. |

**Optional for `refresh` (with sensible defaults):**

| Input                          | Description                                                                                   | Default       |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------- |
| `github-reg-token-refresh-min` | GitHub registration token refresh interval (min, must be < 60).                               | `30` minutes  |
| `idle-time-sec`                | Idle time (seconds) before a runner is considered for refresh/termination.                    | `300` seconds |
| `max-runtime-min`              | Max runner runtime (min); `provision` mode can override.                                      | `30` minutes  |
| `pre-runner-script`            | Script executed on EC2 before runner starts. (A default script is provided if not specified). | `''`          |
| `resource-class-config`        | JSON config for resource classes (CPU, memory). Ex: `{"large": {"cpu": 4, "mmem": 1024}}`.    | `''`          |

### `provision` Mode Inputs

**Optional for `provision` (with sensible defaults):**

| Input                    | Description                                                                    | Default        |
| ------------------------ | ------------------------------------------------------------------------------ | -------------- |
| `instance-count`         | Number of EC2 instances to provision.                                          | `1`            |
| `usage-class`            | Usage class for EC2 instances (`spot` or `on-demand`).                         | `spot`         |
| `allowed-instance-types` | Space-separated list of allowed EC2 instance type patterns (e.g., `c* m* r*`). | `c* m* r*`     |
| `max-runtime-min`        | Override `refresh` mode's max runtime for provisioned instances.               | (from refresh) |

### `release` Mode Inputs

No inputs required - this is by design to minimize YAML! Releases resources
based on workflow's runId.

## 🔑 Minimum Permissions

There are two main iam entities that you need to create. Here are the minimum
required permissions for:

1. Three Actions modes: `refresh`/`provision`/`release`
2. ec2 instance profile

### Permission for the Three Action Modes

TODO: this needs to be refined

- DynamoDB: Need to describe, create, read and write
- SQS: Need to describe, create, read and write
- EC2: Create fleet, terminate intances, create tags
- Launch Templates: Create and update launch templates
- IAM: Pass instance profile to LaunchTemplate

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

### Permission for ec2 instance profile

EC2 instances themselves need minimum permissions to work correctly within the
self-hosted framework:

- EC2(TerminateInstances): instances need to have a mechanism to perform
  self-termination
- DynamoDB (Read and Write): Need to send or detect state changes a database

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

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## 📜 License

This project is licensed under the [MIT License](LICENSE).

<!-- Add a LICENSE file if you have one -->
