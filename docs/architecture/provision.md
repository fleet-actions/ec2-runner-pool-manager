# Provision

Provision guarantees that each GitHub Actions workflow receives exactly the compute resources it needs—either by efficiently reusing existing idle instances or by quickly creating new EC2 runners on-demand.

## Overview and Goals

Provision is one of the core operational modes of the controlplane, specifically designed to ensure GitHub Actions workflows always have suitable EC2 instances ready to execute CI jobs promptly and reliably.

The primary objectives of Provision are:

- Resource Efficiency: Maximize the reuse of existing idle runners, reducing costs and startup latency.
- Scalability: Provision new instances from AWS if no suitable idle runners are available, ensuring workflows never wait unnecessarily.
- Isolation: Ensure safe, isolated assignment of resources to workflows, preventing conflicts or resource contention.

Provision achieves these goals through two sub-components:

 1. Selection: Prioritizes reuse by selecting suitable idle runners from the resource pool.
 2. Creation: Provisioning new EC2 resources on-demand, using AWS fleet management.

In the following sections, we’ll detail precisely how each of these sub-components operates internally.

## Selection

### Overview of Selection

Selection is the *reuse-first* branch of **Provision**.  
Its sole mission is to satisfy a workflow’s compute request **without launching new EC2 capacity**.  
It does this by rapidly scanning the **Resource Pool**, filtering messages that match the workflow’s constraints, and atomically **claiming** (locking) any suitable idle runners.

**Why it exists**

- **Cost & latency:** Reusing a warm runner is cheaper and 10‑20× faster than cold‑starting a new instance.  
- **Isolation:** Conditional updates in DynamoDB ensure that even when many workflows race for the same runner, only one can claim it.  
- **Safety:** Health, heartbeat‑recency, and registration checks prevent unhealthy or mis‑registered instances from being reused.

**High‑level flow**

1. **Pickup Manager** dequeues messages from the SQS‑backed Resource Pool and filters by static attributes (`usageClass`, `instanceType`, CPU/Memory).
2. Valid messages are handed to **Claim Workers** (spawned in parallel, one per requested runner).
3. Each Claim Worker performs an atomic *idle->claimed* transition in DynamoDB.  
   - On success: runs final health + registration checks and hands the instance to *Post-Provision*.  
   - On failure: instance is released/requeued and the worker asks the Pickup Manager for another candidate.
4. If all workers report **pool exhausted**, control passes to the **Creation** sub‑component to launch fresh instances.

With that context, let’s dive into the concrete interfaces used by the Resource Pool, Pickup Manager and Claim Workers.

See linked pages:

- [Resource Pool and Pickup Manager](./selection/resource-pool-and-pickup-manager.md)
- [Claim Workers](./selection/claim-workers.md)

## Creation (Provisioning New Instances)

### Overview of Creation

Sometimes the resource pool simply can’t meet the workflow’s constraints (instance type, CPU, memory, usage-class, or sheer quantity). When that happens, provision falls back to Creation:

 1. Pool Exhausted or No Match: The Pickup Manager signals that no suitable idle instances are available.
 2. Provision Escalates: Provision switches from reuse to create mode for any still-unmet capacity.
 3. Fresh Capacity in Seconds: A short-lived “fleet request” asks AWS for exactly the mix of instances that satisfy the remaining workflow requirements.
 4. Records Seeded: As soon as AWS returns the new instance IDs, each one recorded with `created` state, beginning its normal lifecycle.

Creation is therefore the safety net that guarantees every workflow has compute, even when the pool is empty or under-provisioned.

### EC2 Fleet Creation

#### AWS API Used — `CreateFleet (type =instant)`

Provision issues a single [`CreateFleet` call with Type=instant](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-ec2-fleet.html), which tells AWS to indicate to us if at this moment in time, there's enough in their capacity pools to fulfill our request or or fail fast. This keeps the controlplane responsive.

??? note "Simplified Create Fleet Call Input"
    Say 3 on-demand instances
    ```json
    {
      "Type": "instant",
      "TargetCapacitySpecification": {
        "TotalTargetCapacity": 3,
        "DefaultTargetCapacityType": "on-demand",
        "OnDemandTargetCapacity": 3
      },
      "LaunchTemplateConfigs": [ … ],
    }
    ```

If AWS cannot fulfil every requested instance (e.g., InsufficientInstaceCapacity), Provision aborts the fleet, cleans up any partial capacity, and surfaces an error back to the workflow. We also clean up the partial capacity by sending TerminateInstances just in case.

#### Attribute-Based Instance Type Selection

Instead of hard-coding instance types, the fleet uses attribute-based filters so AWS can pick any instance family that satisfies the request, dramatically improving hit rates in constrained regions.

??? note "Distilled example of the Launch Template overrides within Provision"
    ```json
    "LaunchTemplateConfigs": [
      {
        "LaunchTemplateSpecification": { "LaunchTemplateId": "lt-abc123", "Version": "$Default" },
        "Overrides": [
          {
            "InstanceRequirements": {
              "VCpuCount":   { "Min": 4, "Max": 4 },
              "MemoryMiB":   { "Min": 4096 },
              "IncludedInstanceTypes": ["c*", "m*"],
            },
            "SubnetId": "subnet-aaa…",
          }
        ]
      }
    ]
    ```
    How this maps to the Provision interface:

    | Workflow Input | Fleet Mapping  |
    ||----|
    | `allowed-instance-types: "c* m*"` | `IncludedInstanceTypes` mapped directly |
    | `resource-class: large`    | Populates `VCpuCount` & `MemoryMiB` ranges |

#### Why attribute-based matters

- Maximises success probability: any size-compatible c* family (e.g., c6i, c7g) can be chosen.
- Reduces operator toil: no need to update docs every time AWS launches a new generation.
- Access to Multi-AZ Capacity Pools: Provision populates one override per subnet, so the fleet can pull capacity from whichever AZ still has it.

Once AWS returns the instance IDs, each new runner is inserted into DynamoDB like so:

```json
{
  "instanceId": "i-0abc12345",
  "state": "created",
  "runId": "run-7890",
  "threshold": "2025-05-31T12:00:00Z"
}
```

From here, the Instance Initialization & Fleet Validation logic (described in the next subsection) takes over, ensuring every newly created runner is healthy, registered, and transitioned to running.

#### Handling Insufficient Capacity

If **any** part of the request fails (including partial fulfilment):

1. Provision logs the `CreateFleet` error.  
2. Immediately issues a single `TerminateInstances` for every ID returned.  
3. Surfaces a clear `provision_failed` error to the workflow.

Because AWS already retries internally across capacity pools, a second identical request is unlikely to succeed; failing fast and alerts operators to widen constraints or retry later.

### Instance Initialization & Fleet Validation

Once AWS returns the brand-new instance IDs, Provision’s job is only half-done. The control-plane must make sure every EC2 runner has finished bootstrapping, registered itself with GitHub Actions, and is sending healthy heartbeats before it hands the runner over to the workflow.
That responsibility is split between two cooperating pieces:

1. User-data bootstrap script that runs inside the instance.
2. Fleet-validation routine that runs in the control-plane worker.

#### 1. User-Data Bootstrap Flow

The bootstrap script runs **inside every new runner**. To see the full functionality of this script, please see [user-data](./user-data.md). We'll cover whats relevant here. In sequence, this script:

1. Executes the operator's pre-runner-script.
2. Initializes the heartbeat and self-termination agents.
3. Enters the registration loop.

Within the registration loop, `blockRegistration` blocks the runner from registering itself against Github until a `runId` has been registered against the runner in the Database.

Fortunately, we immediately create a `created` record in the database shortly after we get the instance ids from AWS along with the `runId`. The instance sees this and registers with that label.

On successful registration, it emits a successful registration signal which the controlplane picks up.

#### 2. Fleet‑Validation Routine

After launching a fleet, the provision worker runs a short‑lived **validation loop** to be sure every brand‑new runner is *both* registered with GitHub **and** sending heartbeats.  
If any instance fails these checks within the timeout, the whole fleet is torn down and the workflow receives a clear error.

| Step | What the worker is waiting for | Success criteria | Failure action |
|------|--------------------------------|------------------|----------------|
| **1. Registration check** | Instance emits `UD_REG_OK` | All instances emit the signal | Abort: terminate the entire fleet |
| **2. Heartbeat check** | Fresh heartbeat rows every ≤ `HEARTBEAT_PERIOD` | All instances meet the threshold | Abort: terminate the entire fleet |
| **3. Global timeout** | Timer ≤ `FLEET_VALIDATION_TIMEOUT` (default = ~180s) | All checks pass before timeout | Abort: terminate the entire fleet |

When *all* instances satisfy steps 1 & 2 before the global timeout:

1. Update each record from `created->running`.  
2. We determine the creation to be of status 'success' for post-provisioning
3. Return control to the workflow dispatcher—jobs can begin immediately.

If **any** instance misses a check or the timeout expires:

- Call `TerminateInstances` on *every* new instance ID.  
- We determine the creation to be of status 'failed' for post-provisioning

This all‑or‑nothing policy keeps the fleet in a known‑good state and prevents half‑healthy capacity from slipping into production use.

## Post-Provisioning Actions

The **Post-Provision** component is the final gate before the workflow can start running jobs (on success) — or before the control-plane rolls everything back (on failure).  

It receives the aggregated results of **Selection** and **Creation**, reconciles them (`reconcileFleetState`), and then executes one of three clear paths.

### Successful Provisioning

When **all** requested capacity is healthy — meaning:

1. Every selected runner is healthy and registered during claim validation.
2. Every newly created runner passed registration + heartbeat checks within the fleet-validation timeout.

... the component routes to `processSuccessfulProvision`.

**What happens next**

| Step | Action | Detail |
|------|--------|--------|
| 1 | **Idle → Running** | Each runner’s DynamoDB record is updated from `claimed`/`created` to `running` with a fresh `threshold` (`now + maxRuntimeMin`). |
| 2 | **Runner label confirmed** | The instance already registered itself with GitHub using the workflow’s `runId`; no further action required. |
| 3 | **Return control** | The provision worker returns the list of runner IDs to the workflow dispatcher so jobs can start immediately. |

Successful path is intentionally lightweight: just a couple of conditional writes and you’re in business.

### Unsuccessful Provisioning

If **any** part of the fleet fails validation — for example:

- AWS couldn’t supply all requested instances  
- A new runner skipped heartbeat  
- A selected runner failed final health checks  

... `reconcileFleetState` returns **failure**, and the code enters `processFailedProvision`.

**Graceful rollback logic**

| Step | Action | Purpose |
|------|--------|---------|
| 1 | **Release selected runners** | Transition `claimed → idle`, publish each back onto the resource-pool (SQS). |
| 2 | **No-op for failed creations** | Newly created runners already received `TerminateInstances` inside the Creation step. |
| 3 | **Surface clear error** | The Action is marked `failed` with a descriptive message so operators know capacity was unavailable, rather than masking the issue. |

This leaves the pool intact, avoids orphaned claims, and makes the workflow fail fast instead of hanging.

### Error Handling & Resource Cleanup (Safety Mechanism)

If, at any point in provision, we encounter an unhandled exception - execution drops to the outer `catch` block and invokes `dumpResources`.

**DumpResources routine**

1. **Terminate EVERYTHING**  
   *Both* selected (`instanceIds` still in memory) **and** newly created instances are terminated via a bulk `TerminateInstances` call.  
2. **Purge state**  
   Corresponding DynamoDB items are deleted to prevent zombie references.
3. **Re-throw**  
   The original error is re-thrown so the job fails visibly.

This “nuclear option” guarantees you never leak capacity, even in the face of unhandled exceptions.

!!! note
    Success should be the 99 % path. Failed-but-graceful rollbacks cover expected scarcity or health problems.  
    The dump-resources path is a last-resort guardrail, rarely exercised but critical for cost safety.
