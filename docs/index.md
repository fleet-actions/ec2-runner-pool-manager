# Scale & Reuse Self-Hosted EC2 Runners inside GitHub Actions 🚀♻️

![Sample-Workflow](assets/sample-workflow-light.png)

This Action enables you to run a pool of self-hosted EC2 runners within the
Github Actions runtime. No separate controlplane with Kubernettes/Terraform/CDK.
Resource pooling, scale-in/scale-out, termination of the runners are all handled
by the action.

![Architecture](assets/simplified-architecture.png)

## ⚡️ Motivation

This action was explicitly designed to **embed** the controlplane within Github
Actions. This allows the operator immediately see the logs of the controlplane!
:mag:. As such, this project aims to dramatically simplify the management of
self-hosted runners while retaining the ability to scale-in/scale-out and share
runners with minimal external infrastructure. With this, we get the following
benefits:

- **Embedded Controlplane** - No deploying and managing separate control planes.
  No webhook configuration.
- **Runner Logs** - Logs are readily accessible within the
  [workflow run logs](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-workflow-run-logs).
  Sifting through logs in external cloud providers is minimized when you can
  just access the runner logs.
- **Resource Pooling** - When provisioning for a workflow, this action first
  interrogates the shared pool of resources for reuse. This optimizes costs by
  efficiently reusing runner instances across workflows

Inspired by powerful tools like
[Actions Runner Controller](https://github.com/actions/actions-runner-controller),
[terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner),
and [machulav/ec2-github-runner](https://github.com/machulav/ec2-github-runner),
this action explores streamlined, YAML-centric approach to runner pooling and
lifecycle management.

## 🔍 Overview

This action operates using three distinct modes (`provision`, `release`, `refresh`) to control, share, and scale self-hosted EC2 runners directly within GitHub Actions. The diagram below illustrates how these modes fit into your GitHub Actions workflow files:

![Modes In Workflows](assets/mode-and-workflows.png)

!!! note
    To see how this fits in your Github Actions code and get started, see: [prerequisites](getting-started/prerequisites.md) & [quickstart](getting-started/quickstart.md)

Here’s a closer look at each operational mode:

### Mode: `provision`

Allocates existing EC2 instances from the shared pool or creates new ones if needed for your active workflow jobs.

- Simply specify the number of instances required (e.g., `instance-count: 10`)
- Target these runners in workflow (e.g, `runs-on: ${{ github.run_id }}`)

### Mode: `release`

Returns the EC2 instances used by a workflow back to the shared pool, making them available for reuse by other jobs.

- This mode typically requires no additional configuration, aiming for YAML simplicity.
- It automatically handles the release based on the workflow's unique `github.run_id`.

### Mode: `refresh`

Manages the overall configuration and health of the EC2 runner pool. This mode is designed to be run on a schedule (e.g., via a cron job) to perform ongoing maintenance tasks:

- Create or update essential AWS infrastructure (like DynamoDB tables & SQS queues) and initialize shared metadata.
- Continuously propagate changes to the EC2 Launch Template (e.g., new AMIs, security group updates, user-data scripts) or other shared pool configurations (like instance lifetime settings or subnet IDs).
- Refresh GitHub registration tokens to ensure new EC2 instances can successfully register as runners.
- Clean up any long-living or orphaned instances that may have failed to self-terminate.

## ⚙️ How It Works (Detailed Design)

To see how this works internally - see [how-it-works](architecture/overview.md)
