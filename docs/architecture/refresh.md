# Refresh: System Initialization & Maintenance ⚙️

The Refresh process is a periodic, idempotent background operation, executed by a scheduled GitHub Actions workflow (e.g., via `cron`), that acts as the system's central initializer and maintainer. Unlike the event-driven `provision` and `release` modes which are tied to workflows, `refresh` operates on the entire system to ensure the live infrastructure and configuration in AWS align with a centrally defined *desired state*.

Its core purpose is to initialize foundational infrastructure and to perform routine maintenance, ensuring the system remains healthy and configured as intended.

## The Refresh Model: Desired vs. Actual State

The entire Refresh process is built on this model: it compares a **Desired State** (the configuration you provide) with the **Actual State** (the resources that exist in AWS) and performs the necessary actions to align them.

* **Desired State**: The configuration you provide as input. This includes the AMI for runners, resource class definitions, maximum instance lifetimes, and approved subnets. This is your "source of truth."
* **Actual State**: The resources and records that currently exist, such as EC2 Launch Templates, SQS queues, and instance state records in DynamoDB.

This model makes the process inherently **idempotent**—it can be run repeatedly with the same desired state, and it will only make changes if a drift is detected.

## Core Refresh Tasks

The Refresh process performs two primary architectural functions: initialization and maintenance.

### 1. System Initialization 🏗️

This task handles the setup and configuration of foundational AWS resources. It ensures the system has the necessary infrastructure and parameters in place before the `provision` and `release` processes need them. Each row in the table represents an independent initialization task.

| Component | Desired State (Input) | Initialization Action | Architectural Purpose |
| :--- | :--- | :--- | :--- |
| 🚀 **EC2 Launch Template** | AMI ID, IAM Profile, User Data script, etc. | Creates or updates the EC2 Launch Template. Stores its ID in DynamoDB. | Decouples instance `provisioning` from the details of instance configuration. |
| 📥 **Resource Pools** | A list of `resourceClass` definitions. | For each `resourceClass`, it ensures a corresponding SQS queue exists. Stores the queue URLs in DynamoDB. | Provides a discoverable, central endpoint for the idle runner pools. |
| 🔧 **Operational Parameters** | Values for `max-idle-time`, `subnet-ids`, etc. | Updates the corresponding key-value records in DynamoDB. | Allows for dynamic, centralized tuning of the system's operational behavior. |
| 🔑 **GitHub Auth** | A GitHub PAT with `repo` scope. | Periodically generates a new, short-lived GitHub Actions registration token and stores it in DynamoDB. | Enhances security by ensuring new instances register with a temporary token. |

### 2. Instance Lifecycle Maintenance 🗑️

This task acts as the system's garbage collector, enforcing the defined lifecycle rules to prevent orphaned or expired resources.

* **Identifying Expired Instances**: The primary policy is the `threshold` timestamp on each instance record in DynamoDB. The maintainer scans for any `idle`, `claimed`, or `running` instances that have lived past their expiration time.
* **Resilient Termination Process**: To prevent race conditions, it uses a safe, two-phase commit process:
    1. **Phase 1: Mark for Termination (in DynamoDB)**: It first attempts to "lock" the instance by changing its state to `terminated`.
    2. **Phase 2: Terminate Instance (in EC2)**: Only after an instance is successfully marked in the database does it issue the `TerminateInstances` command to AWS.
* **Artifact Cleanup**: After confirming termination, it removes associated data for the terminated instances (like heartbeat records) from DynamoDB.

!!! note "Sequence Diagram: Resilient Termination"
    ```mermaid
        sequenceDiagram
            participant Maintainer as "Refresh Maintainer"
            participant DDB as "DynamoDB"
            participant EC2

            Maintainer->>+DDB: Find instances where state is 'idle'/'running'<br>and threshold is expired
            DDB-->>-Maintainer: Return list of expired instances

            loop For each expired instance
                Maintainer->>+DDB: Conditionally update state to 'terminated'
                DDB-->>-Maintainer: Update OK
            end
            Note right of Maintainer: Now we have a locked list<br>of instances to terminate.

            Maintainer->>+EC2: Terminate instances by ID
            EC2-->>-Maintainer: Termination initiated

            Maintainer->>+DDB: Delete associated artifacts<br>(heartbeats, worker signals)
            DDB-->>-Maintainer: Cleanup OK
    ```

## The Power of a Centralized Refresh Process ✨

This centralized `refresh` approach provides advantages to decoupling:

* **Centralized Configuration**: All major changes to the runner environment (like updating the AMI) can be done by changing a single configuration value and letting the initializer handle the rollout.
* **Decoupling of Concerns**: The `provision` logic doesn't need to know how to build an instance; it just needs to know which Launch Template to use. The `refresh` process handles the "how," keeping concerns cleanly separated.
