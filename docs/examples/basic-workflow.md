# Basic Workflow Examples

## Using a Matrix Strategy (Example: for Ruby Versions)

Prerequisites: Ensure you have completed the setup described in the [Quickstart](../getting-started/quickstart.md)

??? note "Refresh Configuration"
    ```yaml
    # .github/workflows/refresh.yml
    name: Refresh Runner Pool

    on:
      workflow_dispatch: # Allows manual triggering
      schedule:
        - cron: "*/15 * * * *" # Runs every 15 minutes

    jobs:
      refresh_job:
        runs-on: ubuntu-latest # This job runs on a GitHub-hosted runner
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
              iam-instance-profile: YourInstanceProfileName # Your EC2 instance profile
              security-group-ids: sg-xxxxxxxxxxxxxxxxx # Your security group
              subnet-ids: subnet-xxxxxxxxxxxxxxxxx subnet-yyyyyyyyyyyyyyyyy # Your subnets
    ```

??? note "Basic Ruby Matrix Workflow (`ci-ruby-matrix.yml`)"
    ```yaml
    # .github/workflows/ci-ruby-matrix.yml
    name: CI Ruby Matrix Test

    on:
      pull_request:
      push:
        branches: [main]

    jobs:
      provision_runners:
        runs-on: ubuntu-latest
        steps:
          - name: Configure AWS Credentials
            uses: aws-actions/configure-aws-credentials@main
            with:
              aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
              aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
              aws-region: us-east-1 # Or your desired region
          - name: Provision Runners for Matrix
            id: provision_step
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: provision
              # Adjust 'instance-count' based on your matrix size.
              instance-count: 3


      test_ruby_versions:
        needs: provision_runners
        runs-on: ${{ github.run_id }} # Uses runners provisioned for this workflow run
        strategy:
          matrix:
            ruby-version: ['2.7', '3.0', '3.1'] # Define the Ruby versions to test against
        steps:
          - name: Checkout code
            uses: actions/checkout@v4 

          - name: Set up Ruby ${{ matrix.ruby-version }}
            uses: ruby/setup-ruby@v1
            with:
              ruby-version: ${{ matrix.ruby-version }}

          - name: Install dependencies 
            run: bundle install

          - name: Run RSpec tests (or your test command)
            run: bundle exec rspec

      release_runners:
        needs: [provision_runners, test_ruby_versions]
        runs-on: ubuntu-latest 
        if: ${{ always() }} # Important: Always release runners
        steps:
          - name: Configure AWS Credentials
            uses: aws-actions/configure-aws-credentials@main
            with:
              aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY }}
              aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
              aws-region: us-east-1
          - name: Release EC2 Runners
            uses: fleet-actions/ec2-runner-pool-manager@main
            with:
              mode: release
    ```
