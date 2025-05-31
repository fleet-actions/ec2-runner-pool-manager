# QuickStart :zap:

Once you've completed the [Prerequisites](./prerequisites.md), you can set up a basic workflow as illustrated below:

![Sample-Workflow](../assets/sample-workflow-light.png)

For details on fine-tuning timeouts and other settings, please refer to the [Advanced Configuration](advanced-configuration.md) guide.

## Let's get started! (follow in order)

1. Create the `refresh.yml` file (see below) with inputs the pre-requisites:
    - AMI Security Group & Subnets
    - EC2 AMI
    - EC2 instance profile & IAM permissions for github runner.
    - Github PAT
    - Then push to create the refresh workflow.
2. Manually run the refresh workflow with [workflow dispatch](https://docs.github.com/en/actions/.managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow) (*or wait for the cron to execute*)
3. If refresh is OK -> create `ci.yml` and push :fingers_crossed:

!!! note "Resource Pooling - reruns are faster :recycle:"
    On your first run, your provision step may take 30 to 90s due to OS startup and any pre-runner-scripts (if any). But, as we reuse runners between workflows, the instances are picked up from the pool instead :heart_eyes:

## Files to Create

??? example "Create - `.github/workflows/refresh.yml`"
    ```yaml
    # in .github/workflows/refresh.yml
    name: Refresh Workflow

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
          - name: Refresh Mode
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: refresh
              github-token: ${{ secrets.GH_PAT }}
              ami: ami-123
              iam-instance-profile: your-instance-profile
              security-group-ids: sg-123
              subnet-ids: subnet-123 subnet-456 subnet-789
              aws-region: us-east-1
    ```

??? example "Create - `.github/workflows/ci.yml`"
    ```yaml
    # in .github/workflows/ci.yml
    name: CI

    on:
      pull_request:
        branches: ["*"]
      push:
        branches: [main]

    jobs:
      provision: ### Picks up resources from pool OR creates if not available
        runs-on: ubuntu-latest
        steps:
          - name: Configure AWS Credentials
            uses: aws-actions/configure-aws-credentials@main
            with:
              aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
              aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
              aws-region: us-east-1
          - name: Provision
            id: provision_step
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: provision
              instance-count: 2

      lint:
        needs: provision
        runs-on: ${{ github.run_id }}
        steps:
          - name: run hello matrix
            run: |
              echo "hello matrix"
              pwd
              aws --version
              docker --version
              sleep 20

      test:
        needs: provision
        runs-on: ${{ github.run_id }}
        steps:
          - name: run hello matrix
            run: |
              echo "hello matrix"
              pwd
              aws --version
              docker --version
              sleep 20

      release: ### Releases used resources to pool
        needs:
          - provision
          - lint
          - test
        runs-on: ubuntu-latest
        if: ${{ always() }} # always release resources for reuse
        steps:
          - name: Configure AWS Credentials
            uses: aws-actions/configure-aws-credentials@main
            with:
              aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
              aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
              aws-region: us-east-1
          - name: Release
            id: release_mode
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: release
    ```
