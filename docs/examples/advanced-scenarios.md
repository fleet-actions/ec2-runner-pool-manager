# Advanced Workflow Scenarios

This page showcases advanced scenarios using `fleet-actions/ec2-runner-pool-manager` by combining various configuration options, emphasizing how different runner characteristics are managed through separate workflow files. Runners are provisioned for a specific `github.run_id`, so jobs within that workflow run share the same pool of runners.

## 1. Cost Optimization: On-Demand for Releases, Spot for CI

To use different purchasing options (e.g., `on-demand` for critical release workflows and `spot` for regular CI), you'll typically define these in separate workflow files. Each workflow will provision runners with its specified `usage-class`.

### Refresh Configuration (`.github/workflows/refresh.yml`)

Your `refresh.yml` remains standard. It manages the overall pool and AWS resources.

```yaml
# .github/workflows/refresh.yml
name: Refresh Runner Pool
# ... (standard refresh configuration as in previous examples) ...
on:
  workflow_dispatch:
  schedule:
    - cron: "*/15 * * * *"

jobs:
  refresh_job:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1 # Or your desired region
      - name: Refresh EC2 Runner Pool
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          github-token: ${{ secrets.GH_PAT }}
          ami: ami-xxxxxxxxxxxxxxxxx # Your chosen AMI ID
          iam-instance-profile: YourInstanceProfileName
          security-group-ids: sg-xxxxxxxxxxxxxxxxx
          subnet-ids: subnet-xxxxxxxxxxxxxxxxx subnet-yyyyyyyyyyyyyyyyy
          # allowed-instance-types: "c* m* r* t*" # Optional: Broadly define if not overriding
          # max-runtime-min: 60 # Optional: Default max runtime
```

### CI Workflow with Spot Instances (`.github/workflows/main-ci.yml`)

This workflow provisions cost-effective `spot` instances for routine CI tasks.

```yaml
# .github/workflows/main-ci.yml
name: Main CI (Spot Instances)

on:
  pull_request:
  push:
    branches: [main, develop]

jobs:
  provision_spot_runners:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        # ... (AWS credentials configuration) ...
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Provision Spot Runners for CI
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          instance-count: 3 # Number of spot runners for parallel jobs
          usage-class: spot
          allowed-instance-types: "c* m* t*" # Flexible, cost-effective types

  build_and_test:
    needs: provision_spot_runners
    runs-on: ${{ github.run_id }} # Uses runners provisioned for this workflow run
    strategy:
      matrix:
        node-version: [18, 20]
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      - name: Use Node.js ${{ matrix.node-version }}
        # ... (setup node) ...
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: ${{ matrix.ruby-version }}
      - name: Build and Test
        run: |
          echo "Running CI on spot instances..."
          # Your build and test commands

  release_spot_runners:
    needs: [provision_spot_runners, build_and_test]
    runs-on: ubuntu-latest
    if: ${{ always() }}
    steps:
      - name: Configure AWS Credentials
        # ... (AWS credentials configuration) ...
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Release Spot Runners
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: release
```

### Release Workflow with On-Demand Instances (`.github/workflows/release.yml`)

This workflow provisions reliable `on-demand` instances for critical release tasks.

```yaml
# .github/workflows/release.yml
name: Release Workflow (On-Demand)

on:
  workflow_dispatch: # Manual trigger for releases
  push:
    tags:
      - 'v*' # Trigger on version tags

jobs:
  provision_ondemand_runners:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        # ... (AWS credentials configuration) ...
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Provision On-Demand Runners for Release
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          instance-count: 1
          usage-class: on-demand
          allowed-instance-types: "m5.large" # Specific, reliable type
          max-runtime-min: 120 # Potentially longer timeout for deployments

  deploy_production:
    needs: provision_ondemand_runners
    runs-on: ${{ github.run_id }} # Uses on-demand runner from this workflow's pool
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      - name: Deploy to Production
        run: echo "Deploying to production using an on-demand runner..."
        # Your deployment script

  release_ondemand_runners:
    needs: [provision_ondemand_runners, deploy_production]
    runs-on: ubuntu-latest
    if: ${{ always() }}
    steps:
      - name: Configure AWS Credentials
        # ... (AWS credentials configuration) ...
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Release On-Demand Runners
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: release
```

## 2. Specialized Environments: Custom CPU Resource Classes

To use runners with different CPU/memory profiles for various tasks (e.g., standard builds vs. CPU-intensive computations), you can define custom resource classes and provision them in separate workflow files.

### Refresh Configuration with Custom Resource Classes (`.github/workflows/refresh.yml`)

Define `resource-class-config` in your `refresh.yml` to specify your custom CPU and memory configurations.

```yaml
# .github/workflows/refresh.yml
name: Refresh Runner Pool with Custom CPU Classes

on:
  workflow_dispatch:
  schedule:
    - cron: "*/15 * * * *"

jobs:
  refresh_job:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Refresh EC2 Runner Pool
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: refresh
          github-token: ${{ secrets.GH_PAT }}
          ami: ami-general-purpose-xxxxxxxx # A general-purpose AMI suitable for all tasks
          iam-instance-profile: YourInstanceProfileName
          security-group-ids: sg-xxxxxxxxxxxxxxxxx
          subnet-ids: subnet-xxxxxxxxxxxxxxxxx
          resource-class-config: |
            {
              "standard-compute": { "cpu": 2, "mmem": 4096 },
              "high-cpu-compute": { "cpu": 8, "mmem": 16384 }
            }
          # Broad allowed-instance-types; specific workflows can refine this
          allowed-instance-types: "c* m* r*"
```

### Standard Compute Workflow (`.github/workflows/ci-standard.yml`)

This workflow provisions `standard-compute` runners for general CI tasks.

```yaml
# .github/workflows/ci-standard.yml
name: Standard Compute CI

on:
  pull_request:

jobs:
  provision_standard_runners:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Provision Standard Compute Runners
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          instance-count: 2
          resource-class: "standard-compute"
          # Optional: Refine instance types if needed, e.g., general purpose
          allowed-instance-types: "m6* m5*"

  run_standard_tasks:
    needs: provision_standard_runners
    runs-on: ${{ github.run_id }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      - name: Execute standard build and test
        run: echo "Running standard CI tasks on 'standard-compute' runners..."

  release_standard_runners:
    needs: [provision_standard_runners, run_standard_tasks]
    runs-on: ubuntu-latest
    if: ${{ always() }}
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Release Standard Compute Runners
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: release
```

### High CPU Compute Workflow (`.github/workflows/ci-high-cpu.yml`)

This workflow provisions `high-cpu-compute` runners specifically targeting CPU-optimized instance families for intensive tasks.

```yaml
# .github/workflows/ci-high-cpu.yml
name: High CPU Compute Workflow

on:
  workflow_dispatch: # e.g., for nightly computationally intensive jobs

jobs:
  provision_high_cpu_runners:
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Provision High CPU Runners
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: provision
          instance-count: 1
          resource-class: "high-cpu-compute"
          # Target CPU-optimized instance families
          allowed-instance-types: "c6a.2xlarge c7g.2xlarge c5.2xlarge"

  run_intensive_computation:
    needs: provision_high_cpu_runners
    runs-on: ${{ github.run_id }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      - name: Execute CPU-intensive task
        run: |
          echo "Starting CPU-intensive computation on 'high-cpu-compute' runner..."
          # Your computationally demanding script or program

  release_high_cpu_runners:
    needs: [provision_high_cpu_runners, run_intensive_computation]
    runs-on: ubuntu-latest
    if: ${{ always() }}
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@main
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - name: Release High CPU Runners
        uses: fleet-actions/ec2-runner-pool-manager@main
        with:
          mode: release
```
