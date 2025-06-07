# Detailed Design

## 🔍 Detailed Architecture Overview

Below is the detailed architecture diagram showcasing all components:

![Overall Architecture](../assets/overall-architecture.png)

The core components in more detail:

- **Controlplane**: Orchestrates instance management via distinct operational modes.
- **Resource Pool (SQS Queue)**: Manages idle instances ready for reuse.
- **Central State Store (DynamoDB)**: Maintains current instance state, signaling indirectly between controlplane and instances.
- **Instances/Runners**: EC2 machines executing the actual CI jobs.

## 🔑 Core Concepts Expanded

Let's clearly expand the foundational concepts briefly introduced in [index.md](../index.md):

### Controlplane Operational Modes

The controlplane operates in three distinct modes:

- **Provision**: Acquires EC2 resources either by claiming from the resource pool or provisioning new instances.
- **Release**: Returns instances to the resource pool after workflows complete, resetting instance state.
- **Refresh**: Periodically validates instance health and lifecycle thresholds, initiating termination of unhealthy or expired instances.

These modes interact through a shared state mechanism stored in DynamoDB, enabling indirect signaling between runners and the controlplane.

### **Instances and Runners**

EC2 Instances—also called runners—are dynamically managed resources executing CI workflows. They maintain minimal agents installed at instance startup for:

- Initializing runner environments via custom scripts (`pre-runner-script`).
- Registering and deregistering with GitHub Actions runner APIs.
- Sending periodic health signals (heartbeats) to the shared state store.
- Observing state changes (e.g., claim attempts, runId assignments) for timely registration.

### **Instance States and Transition Mechanisms**

Each instance has a clearly defined lifecycle managed through distinct states stored in DynamoDB:

| State        | Precise Technical Definition                                           |
|--------------|------------------------------------------------------------------------|
| **created**  | Instance created; initialization pending (waiting on runner registration & scripts). |
| **running**  | Runner initialized and actively accepting CI jobs.                     |
| **idle**     | Instance healthy and available in the resource pool for reuse.         |
| **claimed**  | Instance reserved by a workflow, undergoing final validation checks.   |
| **terminated**| Instance terminated following expiration, unhealthy status, or explicit shutdown.|

These states allow the controlplane to track and manage instances seamlessly.

**Detailed State Transition Diagram:**

```bash
(created) ───▶ (running) ──▶ (idle) ────▶ (claimed)
    │              │           │              │
    ▼              ▼           ▼              ▼
                   (terminated) 
```

- created → running: Initialization completes successfully.
- running → idle: CI job completes, instance returns to the pool.
- idle → claimed: Instance is selected by a new workflow.
- all → terminated: Triggered by threshold expiration or health failures.

This precise state management underpins the controlplane’s ability to reuse runners effectively and terminate them automatically when no longer viable.

## Lifecycle of an Instance

To gain a better understanding with how the controlplane manages runner, we’ll walk step-by-step through the journey of a single instance—from creation, through initialization, running jobs, reuse, and eventually its termination. Along the way, we’ll clearly introduce the critical concepts of indirect signaling, workflow identifiers (runId), runner labels, and thresholds.

### Creation of an Instance

Imagine a workflow kicks off, requiring compute resources to execute CI jobs. Via `provision`, the controlplane first looks to reuse resources and checks the resource pool (implemented as an SQS queue) for idle instances.

- If a suitable instance is found, it gets immediately claimed.
- If not, the controlplane creates a new EC2 instance.

As soon as an instance is created, it enters the created state in our central database (e.g., DynamoDB):

```json
// new record in DB
{
  "instanceId": "i-123456",
  "state": "created",
  "runId": "run-7890",
  "threshold": "2025-05-31T12:00:00Z" // timeout for 'created' state (details below)
}
```

!!! note "What is `runId` for?"
    `runId` uniquely associates this instance with the workflow, ensuring it only runs the intended jobs.

!!! note "What is `threshold` for?"
    `threshold` here defines a timeout for how long this instance can remain in the state; we’ll explain this fully in the Expiration section below.

### Initialization and Indirect Signaling

After creation, the instance begins initializing itself. Since the controlplane and the instances cannot communicate directly, they use indirect signaling through a shared database.

The instance performs two essential initialization steps:

- Pre-runner Script: Runs environment setup tasks on the instance.
- Runner Registration: The instance registers itself as a GitHub Actions runner using the workflow’s unique runId.

Once both steps complete successfully, the instance signals readiness (via a separate data structure), and the controlplane updates the state to running in the database:

```json
// state created->running, new threshold assigned
{
  "instanceId": "i-123456",
  "state": "running", 
  "runId": "run-7890",
  "threshold": "2025-05-31T12:10:00Z"
}
```

!!! note "Indirect Signaling"
    Due to network and security constraints - the controlplane can’t communicate directly with the instances. They rely instead on regularly reading and writing their state in a shared central database (DynamoDB).

### Running CI Jobs

With initialization complete, the instance is now ready to execute CI jobs. Your GitHub Actions workflow specifically targets this instance by referencing the workflow’s unique ID (runId) in its job definition:

```yaml
runs-on: ${{ github.run_id }}
```

Since the instance registered itself with exactly this runId, it guarantees that these jobs run only on the correct, assigned instance. Jobs run smoothly without interference from other workflows.

### Releasing an Instance Back to the Resource Pool

When all CI jobs finish running on a runner instance, the workflow explicitly signals completion, prompting the controlplane’s release component to return the runner to the resource pool.

The release component ensures the instance is safely reset and ready for future workflows. Behind the scenes, the controlplane and the runner instance coordinate via the shared state store to facilitate a clean transition. This coordination includes clearing workflow-specific identifiers, safely deregistering from GitHub Actions, and confirming readiness for reuse.

Here’s how the instance state updates in the database to reflect successful release:

!!! note "Who does what?"
    - **Controlplane**: Updates instance state, monitors signaling, places instance back into pool.
    - **Instance**: Detects state change, deregisters from GitHub Actions, signals completion.

Here’s how this transition appears in the database:

```json
// state running->idle, runId: "run-7890"->"", new threshold assigned
{
  "instanceId": "i-123456",
  "state": "idle",
  "runId": "", 
  "threshold": "2025-05-31T12:20:00Z"
}
```

The instance is now in the resource pool and ready for another workflow.

??? note "A peek at the resource pool :mag:"
    ```json
    {
      "instanceId": "i-123456",
      "usageClass": "on-demand",
      "instanceType": "c6i.large",
    }
    ```
    Simplified view of a resource pool entry. See below at how this is used.

### Reusing Instances (Selection & Claiming)

Reusing Instances (Selection & Claiming)

With the released instance now available in the resource pool, let’s imagine another workflow triggers, requesting compute resources. The controlplane first consults the resource pool to check if existing idle resources match the workflow’s requirements.

The controlplane evaluates key attributes from resource pool messages, specifically:

- usageClass (spot or on-demand) to align with cost or availability needs.
- instanceType to satisfy performance constraints.

For example, a workflow request might look like:

```yaml
# provision inputs
with:
  usage-class: on-demand
  allowed-instance-types: "c*" # Matches any instance type starting with 'c'
```

Matching against our resource pool entry:

```json
{
  "instanceId": "i-123456",
  "usageClass": "on-demand",
  "instanceType": "c6i.large"
}
```

Since our previously released instance (i-123456) matches these requirements exactly, the controlplane attempts to claim it.

If the claim is successful (no other workflow has claimed it first):

```json
// state idle->claimed, runId: ""->"run-9999", new threshold assigned
{
  "instanceId": "i-123456",
  "state": "claimed",
  "runId": "run-9999", 
  "threshold": "2025-05-31T12:30:00Z"
}
```

!!! note "Racing against other Workflows"
    Claims might fail if a race condition occurs (another workflow claiming simultaneously). In such cases, the controlplane either selects another idle instance or provisions a new one.

After successful claiming, the instance detects the state change and registers itself with GitHub Actions using the new workflow’s runId. Shortly thereafter, the controlplane transitions the instance from `claimed` to `running`, indicating it is now ready to execute CI jobs.

This reuse cycle repeats smoothly as long as instances remain healthy, continue matching workflow requirements, and remain within configured operational lifetimes.

??? note "Requiring more instances than the pool?"
    Say that the workflow request requires more resources than what the pool can provide? See request:
    ```yaml
    # provision inputs
    with:
      instance-count: 10 # <---
      usage-class: on-demand
      allowed-instance-types: "c*"
    ```
    This is expected, the controlplane simply creates new resources to satisfy the requirements. After successful creation, selected and created instances are transtitioned to `running`.

### Expiration, Thresholds, and Termination

Instances cannot run indefinitely. To prevent instances from getting stuck or running longer than intended, each state (created, running, idle) carries a threshold—a timestamp indicating how long an instance may safely remain in its current state.

If the instance surpasses this timestamp, it’s considered expired:

```json
{
  "instanceId": "i-123456",
  "state": "running",
  "runId": "run-7890",
  "threshold": "2025-05-31T12:10:00Z" // timestamp expired
}
```

When the refresh worker which executes via cron sees an expired instance, it issues a termination command directly to AWS (TerminateInstances API call) and transitions it to terminated.

```json
{
  "instanceId": "i-123456",
  "state": "terminated",
  "runId": "",
  "threshold": ""
}
```

For redundancy, the instance itself observes its own lifetime. If it sees that it has expired, it and issues a termination command directly to AWS to terminate itself.

These mechanisms cleans up expired resources. They ensure the infrastructure remains healthy, efficient, and cost-effective by automatically cleaning up unused or problematic instances.
