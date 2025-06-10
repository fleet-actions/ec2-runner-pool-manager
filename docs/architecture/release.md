# Release Process: Returning Instances to the Pool

The release process is a critical phase in the instance lifecycle, ensuring that EC2 runner instances, once their assigned CI jobs are complete, are safely and efficiently returned to the resource pool for potential reuse. This minimizes cold starts for new workflows and optimizes resource utilization.

## 1. Introduction to the Release Phase

- **Core Objective**: To transition an active EC2 runner instance from a `running` state (actively executing or having just completed CI jobs for a specific `runId`) to an `idle` state, making it available in the resource pool (SQS queue) for other workflows.
- **Importance**: A well-orchestrated release process is fundamental for:
  - **Instance Reuse**: Maximizing the reuse of already warmed-up instances, reducing latency for subsequent job runs.
  - **Cost Efficiency**: Minimizing the number of new EC2 instances that need to be provisioned.
  - **System Stability**: Ensuring instances are cleanly reset and do not carry over state from previous jobs.

## 2. Initiation of the Release Cycle

The release cycle for an instance or a set of instances is typically initiated when:

- **Workflow Completion**: A GitHub Actions workflow signals that it has finished using the runner(s) associated with its `runId`. This signal is the primary trigger for the controlplane's release component.

Upon receiving this trigger, the controlplane, specifically the logic encapsulated within the `releaseResources` function (as seen in `src/release/release-resources.ts`), begins the process of reclaiming the specified instances.

## 3. Orchestrating the Release: Controlplane and Instance Coordination

The release process involves a coordinated effort between the controlplane and the EC2 instance itself, mediated primarily through state changes in the Central State Store (DynamoDB). Direct communication is avoided; instead, both components observe and react to state updates in DynamoDB.

### 3.1. Controlplane's Role in Release

The controlplane takes the lead in orchestrating the release. Key responsibilities and actions, primarily driven by `src/release/release-resources.ts` and `src/release/release-workers.ts`, include:

1. **Instance Identification**:
    - The `releaseResources` function begins by fetching all instance items from DynamoDB that are associated with the completed workflow's `runId` (using `ddbOps.instanceOperations.getInstancesByRunId(runId)`).

2. **State Classification and Validation**:
    - Instances are classified by their current state (`running`, `idle`, `claimed`, `terminated`, `created`).
    - The system primarily expects to find instances in the `running` state.
    - It logs warnings for instances found in unexpected states. For example, an instance already in an `idle` state but still associated with the `runId` would be flagged, though the process attempts to continue for valid candidates (`release-resources.ts`).

3. **Transition to Idle State (Triggering Instance Deregistration)**:
    - For instances correctly identified as `running`, the controlplane invokes a process to change their state to `idle`. This is handled by the `transitionToIdle` function (referenced in `src/release/release-resources.ts` and conceptually similar to `src/release/transition-to-idle.ts`).
    - This step involves updating the instance's record in DynamoDB:
        - Setting `state` to `idle`.
        - **Crucially, clearing the `runId`**. This action serves as the primary trigger for the instance to begin its own deregistration and cleanup procedures, as detailed in the [User-Data Bootstrap Script's Registration & Deregistration Loop](./user-data.md#4-registration--deregistration-loop).
        - Assigning a new `threshold` appropriate for the `idle` state, defining how long it can remain in the pool before being considered for termination by the `refresh` process.
    - The `releaseResources` function tracks successful and unsuccessful transitions.

4. **Orchestrating Safe Release to Pool (via `releaseWorker`)**:
    - For each instance successfully transitioned to `idle` by `transitionToIdle`, the `releaseResources` function delegates the final steps to a `releaseWorker` (from `src/release/release-workers.ts`).
    - The `releaseWorker` performs a critical safety check:
        - It polls DynamoDB for a specific signal from the instance: `WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG_REMOVE_RUN`. This signal indicates that the instance has successfully deregistered its GitHub Actions runner and performed any necessary self-cleanup in response to the `runId` being cleared.
        - Polling occurs for a defined timeout (`Timing.WORKER_RELEASE_TIMEOUT`).

5. **Pool Placement or Expiration**:
    - **If the signal is received**: The `releaseWorker` constructs an `InstanceMessage` (containing `id`, `resourceClass`, `instanceType`, `cpu`, `mmem`, `usageClass`) and sends it to the appropriate SQS queue (the resource pool) using `sqsOps.sendResourceToPool`. The instance is now officially available for reuse.
    - **If the signal is NOT received within the timeout**: The `releaseWorker` considers the instance unable to be safely pooled. It then marks the instance for expiration by updating its state in DynamoDB (e.g., setting its threshold to an expired value via `ddbOps.instanceOperations.expireInstance`), ensuring it will be cleaned up by the `refresh` process.

### 3.2. Instance's Role in Release

While the controlplane drives the release, the EC2 instance has active responsibilities, primarily managed by its bootstrap script (see [User-Data Bootstrap Script](./user-data.md)):

1. **Detect Release Trigger**: The agent running on the instance, specifically its `blockInvalidation` routine (as detailed in the [User-Data Bootstrap Script](./user-data.md#4-registration--deregistration-loop)), actively monitors its `runId` in its DynamoDB record. When the controlplane clears or changes this `runId` (as part of the `running` → `idle` transition), this acts as the signal for the instance to proceed with deregistration.
2. **Perform Cleanup**: This includes:
    - Removing any workflow-specific configurations or data.
    - Resetting its environment to a clean state.
3. **Deregister from GitHub Actions**: Triggered by the cleared `runId`, the instance executes its `tokenlessDeregistration` process. This involves making API calls to GitHub to remove its current runner registration. This is crucial to prevent GitHub from attempting to assign new jobs to an instance that is being prepared for the idle pool.
4. **Signal Readiness**: After successful deregistration and cleanup, the instance updates its status in DynamoDB by emitting a success signal (such as `UD_REMOVE_REG_OK`, as described in the [User-Data Signal Cheat-Sheet](./user-data.md#signal-cheat-sheet)). This signal, or a composite status like `UD_REMOVE_REG_REMOVE_RUN` that the controlplane's `releaseWorker` polls for, confirms that the instance has completed its part and is safe to be returned to the pool.

## 4. State Transition to Idle

The transition from `running` to `idle` is a pivotal step managed by the controlplane, facilitated by a dedicated function/module (conceptually `transition-to-idle.ts`, invoked within `release-resources.ts`).

- **Mechanism**: This involves an atomic update to the instance's item in DynamoDB.
  - The `state` attribute is changed from `"running"` to `"idle"`.
  - The `runId` attribute is cleared (set to `""` or removed). As highlighted earlier, this change is the key signal for the instance to initiate its deregistration sequence (see [User-Data Bootstrap Script's section on waiting for release](./user-data.md#4-registration--deregistration-loop)).
  - A new `threshold` timestamp is calculated and set. This timestamp defines the maximum duration the instance can remain in the `idle` state within the resource pool before being considered stale by the `refresh` process. The `idleTimeSec` input to `releaseResources` is used here.

The `overview.md` illustrates this database transition:

```json
// state running->idle, runId: "run-7890"->"", new threshold assigned
{
  "instanceId": "i-123456",
  "state": "idle",
  "runId": "", 
  "threshold": "2025-05-31T12:20:00Z" // New threshold for idle state
}
```

Only instances that are successfully updated to this `idle` state by `transitionToIdle` are then passed to the `releaseWorker` for the final steps of verification and SQS queuing.

## 5. Finalizing Release: Placing the Instance in the Resource Pool

Once an instance has been transitioned to `idle` and the `releaseWorker` has successfully verified the instance's `UD_REMOVE_REG_REMOVE_RUN` signal (confirming self-cleanup and GitHub Actions runner deregistration, which was triggered by the `runId` change), the final step is to make it available in the SQS-based resource pool.

- **Process**:
    1. The `releaseWorker` (from `src/release/release-workers.ts`) assembles an `InstanceMessage`.
    2. This message contains key details about the instance necessary for the `provision` phase to make informed decisions when looking for reusable resources. As defined in `release-workers.ts`, this includes:
        - `id`: The EC2 instance ID.
        - `resourceClass`: The category of the instance.
        - `instanceType`: The specific EC2 instance type (e.g., `c6i.large`).
        - `cpu`, `mmem`: CPU and memory specifications (derived from `resourceClassConfig`).
        - `usageClass`: e.g., `on-demand` or `spot`.
    3. This `InstanceMessage` is then sent to the SQS queue that represents the resource pool for its specific `resourceClass` using `sqsOps.sendResourceToPool(instanceMessage, resourceClassConfig)`.

- **SQS Message Structure (Conceptual Example based on `overview.md` and `release-workers.ts`)**:

    ```json
    // Message in SQS resource pool queue
    {
      "id": "i-123456",
      "resourceClass": "default-runners",
      "instanceType": "c6i.large",
      "cpu": 2048,
      "mmem": 4096,
      "usageClass": "on-demand"
    }
    ```

With the message successfully sent to SQS, the instance is now officially part of the idle resource pool, ready to be claimed by a new workflow.

## 6. Ensuring Robustness and Reliability

The release process incorporates several mechanisms to handle potential issues and ensure system stability:

- **Handling Transition Failures**:
  - The `releaseResources` function explicitly handles cases where `transitionToIdle` might fail for some instances. It logs these failures and collects error messages. Importantly, it proceeds to attempt the release of any instances that *were* successfully transitioned, rather than failing the entire batch (`release-resources.ts`).
- **Instance Signal Timeout**:
  - The `releaseWorker` employs a timeout (`Timing.WORKER_RELEASE_TIMEOUT`) when polling for the instance's `UD_REMOVE_REG_REMOVE_RUN` signal. If the instance fails to send this signal (e.g., due to an error in its cleanup or deregistration process detailed in [user-data.md](./user-data.md)), the `releaseWorker` will not add it to the SQS pool. Instead, it marks the instance for expiration in DynamoDB (`ddbOps.instanceOperations.expireInstance`). This prevents problematic instances from re-entering the pool.
- **Readiness Verification**:
  - The explicit polling for the `UD_REMOVE_REG_REMOVE_RUN` signal acts as a crucial readiness verification step. It ensures the instance has completed its necessary shutdown procedures (triggered by `runId` change, see [user-data.md](./user-data.md)) before being considered available.
- **Idempotency (Assumed Design Goal)**:
  - While not explicitly detailed, release operations should ideally be designed to be idempotent. If a release process is interrupted and retried for the same `runId`, it should not lead to adverse effects (e.g., attempting to release an already released instance). State checking at the beginning of `releaseResources` (e.g. not processing `idle` instances again for release to SQS) contributes to this.

Error messages are collected throughout the `releaseResources` process, and if any errors occurred, they are reported at the end, even if some instances were successfully released.

## 7. Summary of Interactions

The release process highlights the decoupled yet coordinated nature of the system components:

- **DynamoDB (Central State Store)**:
  - Used by the controlplane to track and update instance states (e.g., `running` -> `idle`) and critically, to clear the `runId` which signals the instance.
  - Used by the instance (as per [user-data.md](./user-data.md)) to detect the `runId` change and to report its readiness for pooling (via signals like `UD_REMOVE_REG_OK`).
  - Stores instance metadata and `thresholds` critical for lifecycle management.
- **SQS (Resource Pool)**:
  - The destination for successfully released instances. Messages containing instance details are queued here, making them discoverable by the `provision` process.
- **GitHub Actions API**:
  - Used by the instance to deregister itself as an active runner, a process initiated after observing the `runId` change in DynamoDB.
- **Controlplane Scripts (`release-resources.ts`, `release-workers.ts`, `transition-to-idle.ts`)**:
  - Orchestrate the overall flow, interact with DynamoDB and SQS, and implement the business logic for instance state transitions and safety checks.
- **Instance Bootstrap Script ([user-data.md](./user-data.md))**:
  - Defines the instance's behavior, including how it responds to the `runId` being cleared by the controlplane to initiate deregistration and signal its completion.

This multi-step, signal-based approach, with the `runId` change as a key trigger for instance-side actions, ensures that instances are returned to the pool in a clean and verified state, ready for efficient reuse.
