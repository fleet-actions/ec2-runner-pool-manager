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

## Creation

Creation is a sub-component of `provision` that is designed to work with AWS to create any instances if the RP cannot fulfill the workflow's compute requirements. This section should be vastly simpler then selection.

### Fleet Creation

When creating the instance, we use the EC2 CreateFleet API which leverages [*attribute-based instance type selection*](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-fleet-attribute-based-instance-type-selection.html). The major attributes defined here essentially dictated a lot of the exposed interface for provision. That is defining the usage-class (on-demand v spot), allowed-instance-types (filtering by instance types with pattern matching), resource-class (cpu and mmem demands).

Internally, all we do is launch fleets with `type: instant` to immediately determine if AWS has enough resources to fulfill our request. AWS has this idea of [capacity pools](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-fleet-allocation-strategy.html) - which is why in [advanced configruation](../getting-started/advanced-configuration.md), I recommend inputting a subnet per availability zone and as generous `allowed-instance-types` as possible - especially if your compute requirements are quite high.

!!! note "Accounting for Insufficient Capacity Errors"
    If, for some reason, the fleet request is only able to a part of the requested fleet - the AWS api throws the [InsufficientInstanceCapacity error](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-ec2-fleet.html#create-ec2-fleet-procedure). In this case, we consider the fleet as "partially" fulfilled which immediately prompts provision to terminate any created instances to ensure no orphaned instances.

!!! note "No retries"
    If, for some reason, AWS tells us that there's insufficient capacity - no retry mechanism to provision remaning instances. This rarely happens if the user is generous with allowed-instance-types and have configured refresh to reference as many subnets as there are availability zones (so that the fleet request has access to the largest amount of capacity pool for that aws region)

Straight after the fleet has been created, we get the instance ids from AWS. This allows us to then register the instances straight away in our internal database with a `created` state and specified threshold (thus now giving it a lifetime). This initially looks like:

```json
// new record in DB
{
  "instanceId": "i-123456",
  "state": "created",
  "runId": "run-7890",
  "threshold": "2025-05-31T12:00:00Z" // timeout for 'created' state
}
```

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
