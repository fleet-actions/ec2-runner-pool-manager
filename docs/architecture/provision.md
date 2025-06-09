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

    | Workflow Input     | Fleet Mapping          |
    |----------|--------------|
    | `allowed-instance-types: "c* m*"` | `IncludedInstanceTypes` mapped directly     |
    | `resource-class: large`        | Populates `VCpuCount` & `MemoryMiB` ranges     |

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

### Handling Insufficient Capacity

If **any** part of the request fails (including partial fulfilment):

1. Provision logs the `CreateFleet` error.  
2. Immediately issues a single `TerminateInstances` for every ID returned.  
3. Surfaces a clear `provision_failed` error to the workflow.

Because AWS already retries internally across capacity pools, a second identical request is unlikely to succeed; failing fast and alerts operators to widen constraints or retry later.

### Fleet Validation & Interactions

Once instances have been created, they immediately execute the user data script that the controlplane configures for the instance. To see the details of this user data, see the [instances page](../todo.md).

But at a high level, this the instance to send various signals to the controlplane after:

- The pre-runner-script has been executed
- And the isntance has been registered against the runId (as picked up from the `created` record as above)

On the controlplane side, fleet validation is essentially a routine which validates fleet initialization. For a specified period of time , it looks for these signals. In addition to a final healthcheck, the fleet is considered valid if registration signals are seen by the controlplane from the created instances within the specified timeout!

Then the fleet validation routine concludes.

## Post-Provision

The **Post-Provision** component is responsible for gracefully handling successful/unsuccessful provisioning in addition to a routine which dumps any provisioned resources when if something unexpected happens.

### Successful Provisioning

We reach this sub-component in provision if all prior components have played nicely with all the compute requirements that the workflow demands. The job of successful provisioning is fairly simple! Simply transition all created and selected instances to `running` as they are now ready to pickup ci jobs!

### Unsuccessful Provisioning

The purpose of this sub-component is to gracefully handle unsuccessful instance creation (ie. InsufficientCapacity, etc.) This component essentially re-releases any selected instances back to the RP for reuse - that is, the selected instances are transitioned from claimed to idle, then placed in the RP

### Something went wrong: Dumping Resources

The purpose of this subcomponent is a hard dump of any selected and created resources in case provision encounters any unhandled errors. This is more of a safety mechanism to ensure that the operator is not left with orphaned instances and to make provision more transparent in its ability to output errors.

This sub component sends TerminateInstances signals to AWS in addition to deletion from internal state.
