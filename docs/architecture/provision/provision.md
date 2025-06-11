# Provision

Provision is one of the core operational modes of the controlplane, specifically designed to ensure GitHub Actions workflows always have suitable EC2 instances ready to execute CI jobs promptly and reliably. Provision achieves these goals through two sub-components:

 1. Selection: Prioritizes reuse by selecting suitable idle runners from the resource pool.
 2. Creation: Provisioning new EC2 resources on-demand, using AWS fleet management.

In the following sections, we’ll detail precisely how each of these sub-components operates internally.

## Selection

### Overview of Selection

Selection is the *reuse-first* branch of **Provision**.  
Its sole mission is to satisfy a workflow’s compute request **without launching new EC2 capacity**.  
It does this by rapidly scanning the **Resource Pool**, filtering messages that match the workflow’s constraints, and atomically **claiming** (locking) any suitable idle runners.

**High‑level flow**

1. **Pickup Manager** dequeues messages from the SQS‑backed **Resource Pool** and filters by static attributes (`usageClass`, `instanceType`, etc.).
2. Invalid messages are generally requeued, valid messages are handed to **Claim Workers** (spawned in parallel, one per requested runner).
3. Each Claim Worker performs an atomic *idle->claimed* transition in DynamoDB.  
    - On success: runs final health + registration checks and hands the instance to *Post-Provision*.  
    - On failure: instance is released/requeued and the worker asks the Pickup Manager for another candidate.
4. If all workers report **pool exhausted** before compute is fulfilled, **Creation** sub‑component,is the fallback to launch fresh instances.

With that context, we'll cover the interfaces used by the Resource Pool, Pickup Manager and Claim Workers.

See linked pages:

- [Resource Pool and Pickup Manager](./selection/resource-pool-and-pickup-manager.md)
- [Claim Workers](./selection/claim-workers.md)

## Creation (Provisioning New Instances)

### Overview of Creation

If the resource pool simply can’t meet the workflow’s needs - provision falls back to **Creation**. Here's a high‑level flow

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

See linked page for more detail:

- [Post Provision](./post-provision.md)
