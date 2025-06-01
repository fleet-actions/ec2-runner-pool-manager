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

!!! tip " The Right Match: On-Demand vs. Spot :handshake:"
    The control plane intelligently manages `on-demand` and `spot` instances. Since `usage-class` is defined during `provision`, workflows requesting `on-demand` instances will only be assigned available `on-demand` runners from the shared resource pool, and the same logic applies to `spot` requests. This allows you to mix and match instance types across different workflows. For example, you can explicitly set some workflows to use `spot` while others default to or are set to `on-demand`.

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

## 3. Advanced AMI and `pre-runner-script` Strategies

Bake as much in to the AMI image as you can to ensure timely startup times. As per [Quickstart](../getting-started/quickstart.md), feel free to use Runs-On's machine images to not worry about any of this. However if you do decide to roll your own, there are a couple of hard requirements to ensure proper functionality:

- [x] `git` & `docker`: For checking out code and running containers
- [x] `aws cli`: Instances to send and receive signals from the controlplane via dynamodb
- [x] `libicu`: For configuring instances against github actions as a self-hosted runner

### `pre-runner-script`

Here are some recommended scripts when using various bare AMI images.

!!! tip "Refining recommended scripts"
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

If your action supports the `resource-class-config` input (as indicated in the `README.md`), you can define different "flavors" of runners.

* **`resource-class-config` JSON Input (for `refresh` mode):**
  * This input typically takes a JSON string defining named resource classes with specific CPU and memory (and potentially other) requirements.
  * **Example:**

        ```json
        {
          "default": {"cpu": 2, "mem_mb": 4096},
          "large": {"cpu": 4, "mem_mb": 8192, "disk_gb": 100},
          "xlarge-mem": {"cpu": 8, "mem_mb": 32768}
        }
        ```

        *(Adjust the structure based on your action's specific implementation of resource classes.)*

* **Use Cases:**
  * **Standard Builds:** Use a `default` or `medium` class.
  * **Memory-Intensive Jobs:** (e.g., large compilations, data processing) Use an `xlarge-mem` class.
  * **CPU-Intensive Jobs:** (e.g., complex tests, simulations) Use a `large` or `xlarge-cpu` class.

* **Specifying a Resource Class in `provision` Mode:**
  * The `provision` mode would then typically have an input like `resource-class: large` to request a runner matching that profile.
  * If no `resource-class` is specified, a default class (e.g., the one named "default" or the first one defined) might be used.

* **Interaction with `allowed-instance-types`:**
  * The action would use the resource class requirements (CPU, memory) to filter the list of `allowed-instance-types` to find suitable and cost-effective EC2 instances. For example, if `resource-class: large` requests 4 CPUs and 8GB RAM, the action will look for instance types in `allowed-instance-types` that meet or exceed these requirements.

## 5. Security Hardening In-Depth

Beyond the basic IAM policies in `prerequisites.md`, further hardening is crucial for production environments.

### IAM Least Privilege

Always grant only the permissions necessary.

* **Specific ARNs:**
  * Instead of `Resource: "*"` in IAM policies, use specific ARNs where possible:
    * DynamoDB: `arn:aws:dynamodb:REGION:ACCOUNT_ID:table/YOUR_TABLE_NAME`
    * SQS: `arn:aws:sqs:REGION:ACCOUNT_ID:YOUR_QUEUE_NAME`
    * `iam:PassRole`: `arn:aws:iam::ACCOUNT_ID:role/YOUR_EC2_INSTANCE_PROFILE_ROLE_NAME` (This is highly recommended for the action's IAM role).
* **OpenID Connect (OIDC) for Keyless Authentication:**
  * Instead of long-lived IAM user access keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), use OIDC with `aws-actions/configure-aws-credentials`. This allows your GitHub Actions workflows to assume an IAM role using short-lived credentials.
  * **Setup Steps (High-Level):**
        1. In AWS IAM, create an Identity Provider for GitHub.
        2. Create an IAM Role that trusts this GitHub OIDC provider (with conditions to restrict which repositories/branches can assume it).
        3. Attach the "Policy for GitHub Actions Workflow" (from `prerequisites.md`, but with resource ARNs tightened) to this OIDC role.
        4. In your GitHub workflow, use `aws-actions/configure-aws-credentials` with the `role-to-assume`:

            ```yaml
            - name: Configure AWS Credentials
              uses: aws-actions/configure-aws-credentials@vX # use latest version
              with:
                role-to-assume: arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_GITHUB_OIDC_ROLE_NAME
                aws-region: YOUR_AWS_REGION
            ```

### Network Security

* **Restrictive Security Groups:**
  * For EC2 runner instances, only allow outbound traffic necessary (e.g., HTTPS to GitHub, package repositories, AWS services).
  * Avoid overly permissive inbound rules (e.g., `0.0.0.0/0` for SSH). If SSH is needed, restrict it to specific bastion host IPs or your corporate IP range.
* **VPC Endpoints (AWS PrivateLink):**
  * For services like DynamoDB, SQS, EC2 API, ECR, and S3, consider using VPC Endpoints.
  * **Benefits:**
    * Traffic between your EC2 runners and these AWS services stays within the AWS network, not traversing the public internet. This enhances security.
    * Can potentially reduce data transfer costs and reliance on NAT Gateways for private subnets.
  * **Considerations:** Adds some complexity to network setup. Ensure your subnets' route tables and security groups are configured correctly for endpoints.
