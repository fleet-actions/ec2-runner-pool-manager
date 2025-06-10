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

**High‑level flow**

1. **Pickup Manager** dequeues messages from the SQS‑backed Resource Pool and filters by static attributes (`usageClass`, `instanceType`, CPU/Memory).
2. Invalid messages are generally requeued, valid messages are handed to **Claim Workers** (spawned in parallel, one per requested runner).
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

If the resource pool simply can’t meet the workflow’s needs - provision falls back to Creation. Here's a high‑level flow

1. **Determine unmet capacity**  
   Provision calculates how many additional runners are still required after Selection has finished, based on the workflow’s `instance-count` and resource specs.

2. **Launch fleet request**  
   A single `CreateFleet` (or `RunInstances` fallback) call asks AWS for the exact number and mix of instance types that satisfy CPU, memory, and `usageClass` constraints.

3. **Seed the state store**  
   As soon as AWS returns instance IDs, each one is recorded in DynamoDB with `state=created`, an initial `runId`, and a short `threshold` so Refresh can reap stalled boots.

4. **Fleet‑validation loop**  
   Provision continuously polls for two signals:  
      - **UD_REG** – the runner has completed user‑data bootstrap and registered with GitHub Actions.  
      - **Heartbeat** – the runner is emitting heartbeats.  
   All targets must report healthy within `FLEET_VALIDATION_TIMEOUT`; otherwise creation is marked **failed** and cleanup begins.

See linked pages for more detail

- [Fleet Creation](./creation/fleet-creation.md)
- [Fleet Validation](./creation/fleet-validation.md)

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
