# Refresh Process: System Maintenance and Configuration

The Refresh process is a critical background component of the EC2 runner pool manager. Unlike Provision and Release modes, which are directly tied to individual workflow lifecycles, Refresh operates periodically (e.g., via a scheduled CRON job) to perform essential system-wide maintenance, configuration updates, and cleanup tasks. Its primary goal is to ensure the health, integrity, and optimal configuration of the entire runner ecosystem.

## Core Responsibilities & Orchestration

The `refresh` function in `src/refresh/index.ts` orchestrates a sequence of operations to manage various aspects of the system. These can be broadly categorized into: initial infrastructure and configuration setup, shared resource management, and instance lifecycle enforcement.

The typical sequence of operations during a refresh cycle includes:

1. **DynamoDB Table Management (`manageTable`)**:
    * Ensures the primary DynamoDB table used by the application is correctly set up and accessible. This might involve validation or, on a very first run, initial schema setup if not handled by external IaC. (Details depend on the implementation within `manage-table/index.js`).

2. **Core Metadata Configuration (via `manage-idempotent-states.ts`)**:
    * **`manageIdleTime`**: Updates the configured idle time (seconds an instance can stay in the `idle` state before being considered for termination) in DynamoDB.
    * **`manageSubnetIds`**: Updates the list of approved subnet IDs (for EC2 instance placement) in DynamoDB.
    * **`manageMaxRuntimeMin`**: Updates the maximum runtime (minutes an instance can exist, regardless of state, before forced termination) in DynamoDB.

3. **GitHub Registration Token Management (`manageRegistrationToken` from `manage-rt/`)**:
    * Manages the lifecycle of the GitHub Actions registration token used by new instances to register themselves.
    * It uses a provided GitHub Personal Access Token (PAT) to generate a new, short-lived registration token.
    * This token is then stored securely (likely in DynamoDB) for bootstrapping instances to fetch.
    * The token is refreshed based on the `githubRegTokenRefreshMins` input, ensuring a rotation policy.

4. **EC2 Launch Template Management (`manageLT` from `manage-lt/`)**:
    * Manages the EC2 Launch Template(s) used for provisioning new runner instances.
    * This includes configuring details like the AMI ID, IAM instance profile, security group IDs, and the user-data script.
    * The Launch Template details (like its ID or version) are stored in DynamoDB for the Provision mode to use.

5. **Resource Class Configuration & SQS Queue Management (`manageResourceClassConfiguration` from `manage-idempotent-states.ts`)**:
    * Takes the defined resource class configurations (which specify instance types, CPU, memory, etc.) as input.
    * For each resource class, it ensures the corresponding SQS queue (which acts as the pool of idle instances for that class) exists. If not, it creates the SQS queue.
    * The function then populates the resource class configuration data with the actual SQS Queue URLs.
    * This enriched resource class configuration (including queue URLs) is then stored in DynamoDB. This is crucial for both Provision (to find idle instances) and Release (to return instances to the correct pool).

6. **Instance Lifecycle Enforcement & Termination (`manageTerminations`)**:
    * This is a key cleanup task focused on enforcing instance lifecycle policies.
    * It scans DynamoDB for instances in `idle`, `claimed`, or `running` states that have exceeded their defined `threshold` (i.e., they are expired).
    * For these expired instances, it attempts to transition their state to `terminated` in DynamoDB.
    * Successfully transitioned instances are then actually terminated in EC2 via AWS API calls.
    * Finally, it cleans up associated artifacts (like heartbeat records and worker signals) from DynamoDB for the terminated instances.

## Detailed Breakdown of Key Operations

### A. Infrastructure and Metadata Setup

The initial part of the Refresh cycle focuses on ensuring the foundational AWS resources and core operational parameters are correctly configured in DynamoDB.

* **DynamoDB Table (`manageTable`)**: Confirms the primary application table is operational.
* **Core Parameters (`manageIdleTime`, `manageSubnetIds`, `manageMaxRuntimeMin`)**: These functions from `manage-idempotent-states.ts` take input values (e.g., from environment variables or deployment configurations) and update corresponding items in a metadata section of DynamoDB. This allows dynamic adjustment of these key operational settings without code changes. For example, `manageIdleTime` ensures the system knows how long an instance can remain idle before `manageTerminations` considers it expired.
* **Resource Class & SQS Queues (`manageResourceClassConfiguration`)**:
  * **Input**: Definitions of various resource classes (e.g., `small-linux`, `large-windows`), potentially including desired instance types, CPU/memory, etc.
  * **SQS Queue Creation**: For each defined resource class, this function checks if an SQS queue exists. If not, it creates one, tagging it appropriately (e.g., with the repository and resource class name). This queue will hold messages representing idle instances of that class.

        ```typescript
        // Conceptual: sqsRCOps.populateWithQueueUrls in manageResourceClassConfiguration
        // For each resource class in rccInput:
        //   queueName = generateQueueName(mode, githubRepoName, githubRepoOwner, resourceClassName)
        //   queueUrl = sqs.createQueue(queueName)
        //   newRCC[resourceClassName].queueUrl = queueUrl 
        ```

  * **DynamoDB Storage**: The complete resource class configuration, now including the SQS queue URLs, is saved to DynamoDB. This allows other components (Provision, Release) to discover and use the correct queues.

### B. GitHub Registration Token Management (`manage-rt/`)

Instances need a token to register with GitHub Actions. To avoid using long-lived PATs directly on instances, Refresh manages this:

* **Input**: A GitHub PAT (with appropriate permissions) and a refresh interval (`githubRegTokenRefreshMins`).
* **Action**: The `manageRegistrationToken` function uses the GitHub service to request a short-lived registration token from the GitHub API for the specified repository.
* **Storage**: This newly generated token is written to a specific location in DynamoDB (e.g., a metadata item). Bootstrapping instances will fetch this token (as seen in `user-data.md` flow) to complete their GitHub Actions runner registration.
* **Rotation**: The token is refreshed/rotated based on the `githubRegTokenRefreshMins` setting to enhance security.

### C. EC2 Launch Template Management (`manage-lt/`)

Standardizing instance creation is achieved via EC2 Launch Templates:

* **Inputs**: Configuration for the launch template, including AMI ID, IAM instance profile, security group IDs, and the user-data script (which bootstraps the instance).
* **Action**: The `manageLT` function interacts with the EC2 service to create a new version of the launch template or update an existing one with the provided configuration.
* **Storage**: The ID and/or version of the active launch template is stored in DynamoDB. The Provision mode reads this when it needs to create new EC2 instances, ensuring all new instances are launched with the correct, centrally-managed configuration.

### D. Instance Termination (`manage-terminations.ts`)

This is the primary cleanup mechanism for enforcing instance lifecycle policies:

1. **Identify Expired Instances**:
    * `instanceOperations.getExpiredInstancesByStates(['idle', 'claimed', 'running'])` queries DynamoDB for instances in these active/intermediate states whose `threshold` timestamp has passed.
2. **Attempt State Transition to `terminated`**:
    * `performTerminationTransitions` iterates through the identified expired instances.
    * For each, it attempts an atomic conditional update in DynamoDB to change its `state` to `terminated`, clear its `runId`, and nullify its `threshold`. This ensures that an instance is only marked for EC2 termination if its state transition in the database is successful.
    * This step produces lists of `successfulItems` (state successfully changed to `terminated`) and `unsuccessfulItems` (state transition failed, e.g., due to a concurrent update).
3. **Actual EC2 Instance Termination**:
    * `sendTerminationSignals` takes the list of `successfulItems` (those now marked as `terminated` in DynamoDB).
    * It calls `ec2Ops.terminateInstances(ids)` to command AWS EC2 to terminate these instances.
    * Includes error handling to attempt individual terminations if batch termination fails.
4. **Artifact Cleanup**:
    * After signaling termination, `performArtifactCleanup` removes associated data for the terminated instances from DynamoDB, such as their heartbeat records (`heartbeatOperations.deleteItem`) and worker signal records (`workerSignalOperations.deleteItem`). This keeps the database clean.

## Idempotency and Reliability

* **Configuration Updates**: Functions within `manage-idempotent-states.ts` (like `manageIdleTime`, `manageResourceClassConfiguration`) are designed to be idempotent. They typically fetch the current value and then update it, meaning they can be run repeatedly with the same input without causing unintended side effects. `manageResourceClassConfiguration` will create SQS queues if they don't exist but won't fail if they already do (though it will update the DynamoDB record with current queue URLs).
* **Terminations**: The termination process is designed for robustness. By first transitioning state in DynamoDB conditionally, it reduces the chances of attempting to terminate an instance that has since been re-claimed or has changed state. Logging (`logInstanceTerminationDiagnostics`) provides visibility into successful and failed transitions.

The Refresh process, through these orchestrated steps, ensures that the runner pool manager remains healthy, configured according to the desired state, and does not accumulate orphaned or expired resources.
