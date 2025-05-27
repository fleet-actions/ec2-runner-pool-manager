# Scale & Reuse Self-Hosted EC2 Runners for GitHub Actions

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
and [ec2-github-runner](https://github.com/machulav/ec2-github-runner), this
action explores streamlined, YAML-centric approach to runner pooling and
lifecycle management.

## ✨ Features

- Declaratively specify number of runners to provision for a workflow.
- Any provisioned runners are placed in a shared pool for other workflows to
  pick up.
- Minimize paying for cold-starts by reusing existing runners
- Native Control Plane in Github Actions for transparent runner logs:
  - See which instances are terminated, selected or created for a workflow.
- Declaratively specify lifetimes of runners
  - i.e., how long should a runner keep itself alive when put in the shared
    pool?

## 🔍 How does it work?

## 🛠️ Modes of Operation

The action operates in three distinct modes:

1. **`provision`**: Allocates EC2 instances from the pool (or creates new ones
   if needed) workflow jobs. Use runners with: `runs-on: ${{ github.run_id }}`.
2. **`release`**: Returns the used EC2 instances to the pool for re-use.
3. **`refresh`**: Manages general configuration of the EC2 runner pool. This
   mode is intended to be run on a schedule (e.g., via cron) to:
   - Update the Launch Template with the latest AMI or configuration.
   - Refresh GitHub registration tokens.
   - Terminate instances that have exceeded maximum runtime or idle time.
   - Ensure a minimum number of idle runners are available

## ⚙️ Prerequisites

- **AWS Credentials:** Configure AWS credentials (e.g., via
  `aws-actions/configure-aws-credentials`) with permissions to manage EC2
  instances, Launch Templates, IAM roles, SQS, DynamoDB.
- **GitHub Personal Access Token (for `refresh` mode):** A GitHub PAT with
  `repo` scope is required for the `refresh` mode to register runners with
  GitHub.
- **AWS Infrastructure:** Need available ec2 instance profile, subnet/s and
  security group/s.

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
        uses: <your-github-username>/ec2-runner-pool-manager@v1
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
        uses: <your-github-username>/ec2-runner-pool-manager@v1
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
        uses: <your-github-username>/ec2-runner-pool-manager@v1
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

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## 📜 License

This project is licensed under the [MIT License](LICENSE).

<!-- Add a LICENSE file if you have one -->
