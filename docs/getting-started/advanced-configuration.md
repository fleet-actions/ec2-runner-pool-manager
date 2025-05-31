# Advanced Configuration & Optimization Strategies

## 1. Introduction

Welcome to the Advanced Configuration guide for the EC2 Runner Pool Manager! This document explores strategies and settings that go beyond the initial setup covered in the [Prerequisites](./prerequisites.md) and [Quickstart](./quickstart.md) guides.

## 2. Fine-Tuning Runner Lifecycle and Resource Management

Careful management of runner lifecycles and AWS resources is key to an efficient and cost-effective self-hosted runner system.

### Understanding Runner Timeouts & Refresh Intervals

Several inputs in the `refresh` mode control how long runners live and how often their configurations or tokens are refreshed. Finding the right balance is crucial:

* **`github-reg-token-refresh-min`** (e.g., default `30` minutes):
  * **What it does:** Determines how frequently the action fetches new GitHub registration tokens for runners. GitHub tokens for registering new runners typically expire after 60 minutes.
  * **Considerations:** Set this to a value safely below 60 minutes (e.g., 30-45 minutes) to ensure there's always a fresh token available for new instances. If this is too long and a token expires, new runners might fail to register.

* **`idle-time-sec`** (e.g., default `300` seconds / 5 minutes):
  * **What it does:** Specifies how long a provisioned runner instance will remain idle in the pool waiting for a new job before it considers itself eligible for self-termination.
  * **Considerations:**
    * **Shorter `idle-time-sec`:** Reduces costs by terminating idle instances sooner. However, it might lead to more "cold starts" if subsequent jobs arrive just after an instance terminated, increasing wait times.
    * **Longer `idle-time-sec`:** Increases runner availability and reduces cold starts, but can lead to higher costs due to instances sitting idle for longer.
    * Align this with your typical job arrival patterns. If jobs are infrequent, a shorter idle time might be better. If jobs are frequent, a longer idle time can improve CI/CD pipeline speed.

* **`max-runtime-min`** (e.g., default `30` minutes for `refresh` mode, can be overridden by `provision`):
  * **What it does:** Defines the absolute maximum time an EC2 instance can run, regardless of whether it's idle or busy. This acts as a safety net to prevent runaway instances and ensure instances are periodically recycled (e.g., to pick up AMI updates if not using a more sophisticated AMI update strategy).
  * **Considerations:**
    * Set this longer than your longest expected job duration, plus any `idle-time-sec` and provisioning overhead.
    * If set too short, jobs might be terminated prematurely.
    * Regularly recycling instances can be good for security and stability.

**Strategy:**
Start with the defaults. If you notice frequent cold starts and your budget allows, consider increasing `idle-time-sec`. If cost is a primary concern, shorten `idle-time-sec` but monitor workflow queue times. Ensure `max-runtime-min` accommodates your longest jobs.

### Instance Purchasing Options (`provision` mode)

The `provision` mode offers ways to control the type and cost of EC2 instances:

* **`usage-class`** (e.g., `spot` or `on-demand`, default `spot`):
  * **`spot`:**
    * **Pros:** Significant cost savings (up to 90% off On-Demand prices).
    * **Cons:** Spot instances can be interrupted by AWS with a two-minute warning if AWS needs the capacity back. This can cause job failures if not handled gracefully (though GitHub Actions jobs are generally resumable on another runner).
    * **Best for:** Cost-sensitive workloads, fault-tolerant jobs, development/testing environments.
  * **`on-demand`:**
    * **Pros:** Guaranteed availability for the duration you pay for. No interruptions.
    * **Cons:** Higher cost compared to Spot.
    * **Best for:** Critical production jobs, long-running tasks that cannot tolerate interruption, or when Spot capacity is constrained.

* **`allowed-instance-types`** (e.g., `c* m* r*`, `m5.large t3.medium`, default `c* m* r*`):
  * **What it does:** Specifies a space-separated list of EC2 instance types or families that the action can choose from when provisioning. Wildcards (`*`) can be used.
  * **Considerations with Spot:** When using `spot`, providing a diverse list of instance types (e.g., across different families and sizes like `m5.large m5a.large m5n.large c5.large c5a.large`) increases the likelihood of obtaining Spot capacity at your desired price and reduces the chance of interruptions. The action will typically use the cheapest available instance type from this list that meets any resource class requirements.
  * **Considerations with On-Demand:** You might specify one or a few preferred instance types.

### Overriding Pool Defaults in `provision` Mode

The `provision` mode can override certain settings established by the `refresh` mode for the specific set of runners it's provisioning.

* **Example: `max-runtime-min` in `provision` mode:**
  * Your `refresh` mode might set a default `max-runtime-min` of, say, 60 minutes for general pool health.
  * However, for a specific workflow that has a very long-running job (e.g., an end-to-end test suite that takes 120 minutes), you can specify `max-runtime-min: 130` (allowing some buffer) in the `provision` step of that workflow. This ensures those specific runners won't self-terminate prematurely based on the pool's default.

**Strategy:**
Use `refresh` to set sensible defaults for the entire pool. Use `provision` mode overrides for exceptional workflows that have different lifecycle or resource requirements.

## 3. Advanced AMI and `pre-runner-script` Strategies

Optimizing your Amazon Machine Images (AMIs) and leveraging the `pre-runner-script` can significantly improve runner startup times and flexibility.

### Building and Using Custom AMIs

While the `pre-runner-script` is great for dynamic setup, a custom AMI "bakes in" dependencies.

* **Benefits:**
  * **Faster Startup Times:** Eliminates the time taken to download and install software on every new instance via `pre-runner-script`.
  * **Reduced Complexity in `pre-runner-script`:** The script can be simpler or even unnecessary.
  * **Improved Reliability:** Less prone to failures from package repository outages or transient network issues during instance boot.
  * **Security Hardening:** AMIs can be pre-hardened according to your security baselines.
* **Tools & Considerations:**
  * **Packer by HashiCorp:** A popular open-source tool for creating identical machine images for multiple platforms from a single source configuration.
  * **AWS EC2 Image Builder:** A fully managed AWS service for automating the creation, management, and deployment of customized, secure, and up-to-date "golden" server images.
  * **Process:** Define a base OS, install all necessary software (Git, Docker, language runtimes, specific testing tools, AWS CLI, etc.), configure settings, and then capture it as an AMI. Update this AMI periodically.
* **`pre-runner-script` with Custom AMIs:** Even with a custom AMI, the `pre-runner-script` can still be useful for:
  * Pulling the latest version of a specific tool not baked into the AMI.
  * Setting dynamic environment variables based on workflow inputs.
  * Performing instance-specific registration or health checks.

### Complex `pre-runner-script` Examples

The `pre-runner-script` (an input for `refresh` mode, defining the default script for instances) can be powerful:

* **Installing Multiple Packages:**

    ```bash
    #!/bin/bash
    sudo yum update -y
    sudo yum install -y jq git docker tree
    sudo systemctl start docker
    sudo systemctl enable docker
    # Add docker user to group if needed
    # sudo usermod -aG docker ec2-user
    ```

* **Configuring Services or Fetching Dynamic Configurations:**

    ```bash
    #!/bin/bash
    # Example: Fetch a configuration file from S3
    # aws s3 cp s3://my-bucket/runner-config.json /etc/runner-config.json

    # Example: Set environment variables based on instance metadata
    # INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
    # echo "RUNNER_INSTANCE_ID=$INSTANCE_ID" >> /etc/environment 
    ```

* **Error Handling:**

    ```bash
    #!/bin.bash
    set -e # Exit immediately if a command exits with a non-zero status.
    echo "Starting pre-runner script..."
    # Your commands here
    sudo yum install -y my-required-package || { echo "Failed to install my-required-package"; exit 1; }
    echo "Pre-runner script completed successfully."
    ```

* **Managing Script Versions:**
  * For complex scripts, consider storing them in your repository and fetching the script during instance boot using `curl` or `aws s3 cp` within a very short inline `pre-runner-script`. This allows versioning the script with your code.

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

### Secrets Management for `pre-runner-script`

If your `pre-runner-script` needs sensitive information (API keys, database passwords):

* **AWS Secrets Manager or AWS Systems Manager Parameter Store (SecureString type):**
  * Store secrets securely in these services.
  * Grant the EC2 Instance Profile IAM role permission to read these specific secrets.
  * In your `pre-runner-script`, use the AWS CLI to fetch the secrets:

        ```bash
        #!/bin/bash
        API_KEY=$(aws secretsmanager get-secret-value --secret-id your/secret/arn --query SecretString --output text | jq -r .YourApiKey)
        # Or for Parameter Store:
        # DB_PASSWORD=$(aws ssm get-parameter --name "/your/db/password" --with-decryption --query Parameter.Value --output text)
        
        # Now use $API_KEY or $DB_PASSWORD in your script
        ```