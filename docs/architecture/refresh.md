# Refresh: System State Reconciliation

The Refresh process is a periodic, idempotent background operation, executed by a scheduled GitHub Actions workflow (e.g., via `cron`), that acts as the system's central reconciler. Unlike the event-driven `provision` and `release` modes which are tied to workflows, `refresh` operates on the entire system to ensure the live infrastructure and configuration in AWS align with a centrally defined *desired state*.

Its core purpose is to continuously converge the *actual state* of the system (what exists in AWS and DynamoDB) with the *desired state* (your input configurations).

## The Reconciliation Model: Desired vs. Actual State

The entire Refresh process is built on this model:

* **Desired State**: The configuration you provide as input. This includes the AMI for runners, resource class definitions, maximum instance lifetimes, and approved subnets. This is your "source of truth."
* **Actual State**: The resources and records that currently exist, such as EC2 Launch Templates, SQS queues, and instance state records in DynamoDB.
* **Reconciliation**: The Refresh process is the engine that compares the desired state to the actual state and makes the necessary API calls to AWS and DynamoDB to bring them into alignment.

## Core Reconciliation Tasks

The Refresh process performs two primary architectural functions:

### 1. Converging Infrastructure and Configuration

This task ensures that the foundational AWS resources and operational parameters match the desired state defined in your configuration. Each row in the table below represents an independent reconciliation task performed during the `refresh` run.

| Component | Desired State (Input) | Reconciliation Action | Architectural Purpose |
| :--- | :--- | :--- | :--- |
| 🚀 **EC2 Launch Template** | AMI ID, IAM Profile, User Data script, Security Groups, etc. | Creates or updates the EC2 Launch Template. Stores its ID in DynamoDB. | Decouples instance `provisioning` from the details of instance configuration, allowing for easy AMI or script updates. |
| 📥 **Resource Pools** | A list of `resourceClass` definitions. | For each `resourceClass`, it ensures a corresponding SQS queue exists. Stores the queue URLs in the configuration record in DynamoDB. | Provides a discoverable, central endpoint for the idle runner pools used by the `provision` and `release` processes. |
| 🔧 **Operational Parameters** | Values for `max-idle-time`, `subnet-ids`, etc. | Updates the corresponding key-value records in DynamoDB. | Allows for dynamic, centralized tuning of the system's operational behavior without requiring a code deployment. |
| 🔑 **GitHub Auth** | A GitHub PAT with `repo` scope. | Periodically uses the PAT to generate a new, short-lived GitHub Actions registration token. Stores this token in DynamoDB. | Ensures new instances have ready access to a valid short-lived credential on registration. |

### 2. Enforcing Instance Lifetimes (`threshold`)

This task acts as the system's garbage collector, enforcing the defined lifecycle rules to prevent orphaned or expired resources.

* **Identifying Expired Instances**: The primary policy is the `threshold` timestamp on each instance record in DynamoDB. The reconciler scans for any `idle`, `claimed`, or `running` instances that have lived past their expiration time.
* **Artifact Cleanup**: After confirming termination, it removes associated data for the terminated instances (like heartbeat and worker signal records) from DynamoDB to keep the state store clean.
* **Resilient Termination Process**: To prevent race conditions (e.g., trying to terminate an instance that was just re-claimed), it uses a safe, two-phase commit process:
    1. **Phase 1: Mark for Termination (in DynamoDB)**: It first attempts a conditional update in DynamoDB to change the instance's state to `terminated`. This "locks" the instance from being used by other processes.
    2. **Phase 2: Terminate Instance (in EC2)**: Only after an instance is successfully marked as `terminated` in the database does the reconciler issue the `TerminateInstances` command to the AWS EC2 API.

!!! note "Sequence Diagram: Resilient Termination"
    ```mermaid
        sequenceDiagram
            participant Reconciler
            participant DDB as "DynamoDB"
            participant EC2

            Reconciler->>+DDB: Find instances where state is 'idle'/'running'<br>and threshold is expired
            DDB-->>-Reconciler: Return list of expired instances

            loop For each expired instance
                Reconciler->>+DDB: Conditionally update state to 'terminated'
                DDB-->>-Reconciler: Update OK
            end
            Note right of Reconciler: Now we have a locked list<br>of instances to terminate.

            Reconciler->>+EC2: Terminate instances by ID
            EC2-->>-Reconciler: Termination initiated

            Reconciler->>+DDB: Delete associated artifacts<br>(heartbeats, worker signals)
            DDB-->>-Reconciler: Cleanup OK
    ```

## Centralized Config and Decoupling

By framing the `refresh` process as a reconciliation loop rather than a simple script, we gain general decoupling:

* **Centralized Configuration**: All major changes to the runner environment (like updating the AMI) can be done by changing a single configuration value and letting the reconciler handle the rollout.
* **Decoupling of Concerns**: The `provision` logic doesn't need to know how to build an instance; it just needs to know which Launch Template to use. The `refresh` process handles the "how," keeping concerns cleanly separated.

:sunny: