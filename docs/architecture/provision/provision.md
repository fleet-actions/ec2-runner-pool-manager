# Provision

Provision is a core operational mode of the controlplane designed to ensure GitHub Actions workflows always have suitable the EC2 instances required to execute CI jobs. Provision achieves these goals through two sub-components:

1. **Selection**: Prioritizes reuse by selecting suitable idle runners from the resource pool.
2. **Creation**: Provisioning new EC2 resources on-demand.

<!-- ☀️ -->

## Selection

Selection is the *reuse-first* branch of **Provision**.  
Its sole mission is to satisfy a workflow’s compute request **without launching new EC2 capacity**.  
It does this by rapidly scanning the [**Resource Pool**](../resource-pool.md), filtering messages that match the workflow’s constraints, and atomically **claiming** (locking) any suitable idle runners.

**High‑level flow**

1. **Pickup Manager** dequeues messages from the SQS‑backed **Resource Pool** and filters by static attributes (`usageClass`, etc.).
2. Invalid messages are generally requeued, valid messages are handed to **Claim Workers** (spawned in parallel, one per requested runner).
3. Each Claim Worker performs an atomic *idle->claimed* transition in DynamoDB.  
    - On success: runs final health + registration checks and hands the instance to *Post-Provision*.  
    - On failure: the worker asks the Pickup Manager for another candidate.
4. If workers report **pool exhausted** before compute is fulfilled, **Creation** sub‑component,is the fallback to launch fresh instances.

!!! note "Distilled Interaction Between Resource Pool, Pickup Manager and Claim Worker(s)"
      ```mermaid
      sequenceDiagram
         participant ResourcePool as "Resource Pool (SQS)"
         participant PickupManager
         participant ClaimWorker as "Claim Worker(s)"
         participant DynamoDB

         Note over PickupManager, ClaimWorker: Pickup Manager and Claim Workers Initialized
         ClaimWorker->>PickupManager: Request for an instance
         PickupManager->>ResourcePool: Request Instance Message
         ResourcePool-->>PickupManager: Pickup Instance Message
         PickupManager->>PickupManager: Filter messages (by usageClass, etc.)
         PickupManager->>ClaimWorker: Assign valid instance candidate
         ClaimWorker->>DynamoDB: Attempt atomic claim <br> (idle->claimed)
         alt Claim Successful
            DynamoDB-->>ClaimWorker: Claim successful ✅
            ClaimWorker->>ClaimWorker: Run health & registration checks ✅
            Note over ClaimWorker: Hand over claimed instance to Post Provision
         else Claim Fails or Pool Exhausted
            DynamoDB-->>ClaimWorker: Claim fails ❌
            ClaimWorker->>PickupManager: Request new candidate ♻️
            PickupManager->>ResourcePool: Request for Instance Message
            ResourcePool-->>PickupManager: Queue is empty
            PickupManager-->>ClaimWorker: Return null 
            Note over ClaimWorker: With pool exhausted with no claimed compute, fallback to Creation
         end
      ```

With that context, we'll cover the interfaces used by the Resource Pool, Pickup Manager and Claim Workers.

See linked pages:

- [Pickup Manager](./selection/pickup-manager.md)
- [Claim Workers](./selection/claim-workers.md)

<!-- ☀️ -->

## Creation (Provisioning New Instances)

If the resource pool simply can’t meet the workflow’s needs - provision falls back to **Creation**. Here's a high‑level flow

1. **Determine unmet capacity**  
   Provision calculates how many additional runners are still required after Selection has finished, based on the workflow’s `instance-count` and resource specs.

2. **Launch fleet request**  
   A single `CreateFleet` call asks AWS for the exact number and mix of instance types that satisfy CPU, memory, and `usageClass` constraints.

3. **Seed the state store**  
   As soon as AWS returns instance IDs, each one is recorded in DynamoDB with `state=created`, an initial `runId`, and a short `threshold` to set a reasonable lifetime.

4. **Fleet‑validation**  
   Provision waits for two signals:  
      - **Successful Registration** – the runner has completed user‑data bootstrap and registered with GitHub Actions (see [Instance Initialization](../instance-initialization.md)).  
      - **Heartbeat** – the runner is emitting heartbeats.  
   All targets must report healthy within a timeout; otherwise creation is marked **failed** and cleanup begins (ie. all or nothing)

!!! note "Distilled interaction with Fleet Creation/Validation and Instance via Indirect Signalling"
      ```mermaid
      sequenceDiagram
         participant AWS
         participant Provision
         participant DynamoDB
         participant Instance as "Instance(s)"

         Note over Provision: Resource pool exhausted
         Provision->>Provision: Determine unmet capacity (required vs. claimed)
         Provision->>AWS: CreateFleet request
         AWS-->>Provision: Return instance IDs
         Provision->>DynamoDB: Seed state store <br> (state=created, runId, threshold)
         Provision->>+DynamoDB: Wait for Signals <br> (Successful Registration, Heartbeat)

         Note over Instance: Instance boots
         Instance->>Instance: Run user-data bootstrap
         Instance-->DynamoDB: Begin emitting heartbeats ♻️ 
         Note over Instance: Register with Github
         Instance->>DynamoDB: Signal successful registration
         Note over Instance: Await for CI Jobs ♻️
         
         alt All signals received within timeout
            DynamoDB->>-Provision: Signals found within timeout
            Provision->>DynamoDB: Update state (created->running)
            Note over Provision: Provisioning successful ✅
         else Timeout or failure
            DynamoDB-->>Provision: Missing signals
            Provision->>AWS: Cleanup/terminate instances
            Note over Provision: Provisioning failed ❌
         end
      ```

See linked pages for more detail

- [Fleet Creation](./creation/fleet-creation.md)
- [Fleet Validation](./creation/fleet-validation.md)

<!-- ☀️ -->

## Post-Provisioning Actions

The **Post-Provision** component is the final gate before the workflow can start running jobs (on success) — or before the control-plane rolls everything back (on failure).  

See linked page for more detail:

- [Post Provision](./post-provision.md)

:sunny: