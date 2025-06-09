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

With that context, let’s dive into the concrete interfaces used by the Pickup Manager and Claim Workers.

### Resource Pool & Pickup Manager

The Resource Pool (RP) is implemented as a family of SQS queues—one queue per runner class.
Each idle runner is represented by exactly one JSON message in the queue.
The Pickup Manager (PM) is an in-process singleton inside the control-plane that does three jobs:

 1. Dequeue a candidate message from the RP.
 2. Filter the message against the requesting workflow’s compute requirements.
 3. Dispatch the message to a Claim Worker (or re-queue it if unsuitable).

#### 1. Interfacing with SQS

| Step | SQS Call  | Purpose  | Notes   |
|------|--|-|---------|
| 1    | `ReceiveMessage` | Pull one message off the RP queue. | A short poll keeps latency low. |
| 2    | *Immediate* DeleteMessage  | Remove the message from the queue to minimise contention with other PMs. | The message lives only in memory until we decide to re-queue.|
| 3    | Filter in-memory  | Check static attributes (usageClass, instanceType, CPU, memory, resourceClass, etc.) against the workflow’s provision inputs.| No network round-trips during filtering.|
| 4a   | Pass-On -> Claim Worker| If the message matches, hand it to the requesting Claim Worker for final health & registration checks.| Claim Worker now owns this instance.    |
| 4b   | Re-queue -> SendMessage| If the message doesn’t match, push it straight back onto the RP queue.  | Uses the original body; a short `DelaySeconds` (e.g., 1 s) prevents the PM from hot-looping the same bad message. |

#### 2. Message Format Example

This is the representation of an idle instance within the SQS-backed RP

```json
{
  "instanceId": "i-12345678",
  "usageClass": "on-demand",
  "instanceType": "c6i.large",
  "cpu": 2,
  "mem": 4096,
  "resourceClass": "medium",
  "threshold": "2025-05-31T12:20:00Z"
}
```

| Field  | Type   | Purpose  |
|-------|--------|-|
| `instanceId`   | string | EC2 ID, primary key for subsequent DynamoDB look-ups  |
| `usageClass`   | enum   | `spot` \| `on-demand` — must match workflow request    |
| `instanceType` | string | Concrete EC2 type; pattern-matched by `allowed-instance-types` |
| `cpu` / `mem`  | int    | Sizing hints for workflows that specify minimum resources  |
| `resourceClass`| string | Coarse label (small / medium / large) for quick filtering  |
| `threshold`    | ISO8601| When the RP entry itself expires; prevents zombie messages     |

#### 3. Message Handling Logic

Pass-On (happy path)

1. Message matches all workflow constraints.
2. PM hands it to the waiting Claim Worker.
3. Claim Worker performs atomic idle → claimed transition in DynamoDB.
4. On success, the instance proceeds to health/registration checks.

Re-queue (filter miss)

1. Message fails any constraint check (e.g., wrong usageClass, CPU too small).
2. PM immediately SendMessages the exact payload back to SQS with a short DelaySeconds.
3. Other workflows (with different constraints) can now claim the instance.

#### 4. Pool Exhaustion

!!! note "Pool Exhaustion"
    If the PM sees the same instanceId reappear N times (default 5) during a single Provision attempt, it considers the queue “exhausted” for this workflow and returns null to the caller—triggering the Creation sub-component.

Overall - this tight, stateless loop lets Provision chew through dozens of SQS messages per second, favouring warm-runner reuse while falling back to fresh EC2 capacity only when necessary.

### Claim Workers

Claim Workers are lightweight async tasks—implemented as JavaScript Promises and launched in parallel with `Promise.allSettled()` - that attempt to turn idle runners into ready-to-run resources for the current workflow. For a workflow requesting N instances, the control-plane spawns `N` Claim Workers concurrently.

Key responsibilities:

```
┌─────────────┐    claim(N)     ┌─────────────────┐
│ Pickup Msg  │ ─────────────▶ │ Claim Worker[N] │
│ (from SQS)  │                │  Promise chain  │
└─────────────┘                └─────────────────┘
           ▲                          │
           │                          ▼
           └─────── success → state: idle → claimed → running
```

- Parallelism  — workers race to secure runners; slow or ineligible candidates drop out without blocking others.
- Atomic state transitions  — each worker performs a conditional idle->claimed update to guarantee exclusive ownership.
- Liveness & health  — before handing the instance to the workflow, the worker validates heartbeats and registration status.

#### Instance Claiming

1. Receive candidate from the Pickup Manager (an SQS message describing an idle instance).
2. Conditional update in DynamoDB (single, atomic write):
Condition state == "idle" && runId == ""
Mutation state = "claimed", runId = `<workflow-runId>`, threshold = now + claimTimeout
3. Collision handling — if the conditional write fails (another worker claimed first) the Promise rejects; the caller simply asks the Pickup Manager for another candidate.

Example record transition

```json
// BEFORE (idle)
{
  "instanceId": "i-123456",
  "state": "idle",
  "runId": "",
  "threshold": "2025-05-31T12:20:00Z"
}
```

```json
// AFTER (claimed)
{
  "instanceId": "i-123456",
  "state": "claimed",
  "runId": "run-9999",
  "threshold": "2025-05-31T12:30:00Z"
}
```

!!! note "Claim Lifetime"
    Threshold limits how long the instance may remain claimed without finishing registration, ensuring hung claims self-expire.

#### Post-Claim Checks (Health + Registration)

Once an instance is claimed, the Claim Worker enters a short polling loop that watches two lightweight signals written by the instance itself into DynamoDB. Because the instance publishes its own health and registration state, the control-plane never needs to call the EC2 or GitHub APIs.

Before the worker resolves as fulfilled, it verifies that the claimed instance is genuinely ready:

| Check | Where it’s stored | Pass condition | Timeout |
|------|-------|----------|--------|
| Heartbeat | Heartbeat item – one row per instance | `now - updatedAt ≤ HEARTBEAT_HEALTH_TIMEOUT`  | about ~15s   |
| Registration  | WorkerSignal item – produced when instance intends to send any bespoke signals    | `signal` is indicates successful registration **and** `runId` matches workflow’s `runId` | about ~10s    |

??? note "Representations in DynamoDB"
    Heartbeat
    ```json
    // Heartbeat record  (PK: TYPE#Heartbeat  SK: ID#i-123)
    {
      "value": "PING",
      "updatedAt": "2025-05-31T12:27:05Z"
    }
    ```
    Registration signals
    ```json
    // Registration signal  (PK: TYPE#WS  SK: ID#i-123)
    {
      value: {
        "signal": "UD_REG_OK",
        "runId": "run-9999",
      }
    }
    ```

**Success Path**
All checks pass → the worker flips the instance claimed → running, resolves its Promise with the instance ID, and exits.

**Failure Path**
Any check fails or the threshold expires →

- If any failures are encountered with an instance within the claim worker, it is intentionally expired and terminated.
- logs the reason for observability,
- rejects its Promise so the orchestrator can decide to retry or fall back to instance creation.

Using async Promise chains keeps Claim Workers simple and parallel while enforcing isolation and health guarantees.

### Claim Worker

As before, we internally create as many claim workers as the amount of resources that the workflow needs. These claim workers interact with the PM to get a valid instance. Theres a few things that the claim worker does to further evaluate the validity of the instance for the workflow:

**Claiming**

The first thing that the worker does is to claim the instance. At a lower level, this is a state transition backed by DDB's conditional update. The condition being, at the time of update, the record has to be of:

- The following state `idle`
- The following runId `""` (empty runId)

This conditional update functions to solve the problem where multiple workflows are trying to claim the same resource, only one instance can succeed. If a claim is successful, this internal record guarantees isolation. This is claiming looks like:

```json
// state idle->claimed, runId: ""->"run-9999", new threshold assigned
{
  "instanceId": "i-123456",
  "state": "claimed",
  "runId": "run-9999", 
  "threshold": "2025-05-31T12:30:00Z"
}
```

Again, the new runId is the workflow runId that provision is running in.

**Post Claim Checks**

After being claimed, our instance undergoes final checks before the worker considers it valid. Finally we do some checks on the instance itself. First of all, we check if the instance is still healthy. The way that we do this is via checking time in which the heartbeat record was updated (see the [instance page](../todo.md) to see what exactly this looks like). The evaluation of whether an instance is healthy is defined by the heartbeat period multiplied by 3.

So for example, if the heartbeat period is 5s, an instance is only healthy if the heartbeat came in to the database within the last 15s.

Finally, if healthy, we then look for the registration signal.

See, then we transition changes the `runId`, an internal system within instance detects this change `runId` and starts a registration routine (see the [instance page](../todo.md) to see how this works exactly). Anyway, this registers the instance against the `runId` allowing it to pickup jobs for the workflow.

Once this registration is successful, it sends a registration signal to the database which our controlplane detects. (see the [instance page](../todo.md) to see what this looks like exactly). After seeing this registration signal, the claim worker deems the instance fit for running and effectively hands it off to the `post-provision` routine for the final state transition (see this below).

### Problem: How can the Pickup Manager know the Resource Pool is "Exhausted"

**Single Invalid Message**

Now theres a problem here. Imagine this scenario - you have one workflow that needs a very specific instance type. Say `r6*`. But the resource in the pool has a type `c6i.large`. As before, the PM picks this up, inspects it, and requeues it - then the PM re-inspects the queue again and gets the same instance! We're stuck in a loop!

So to solve this problem, the PM singleton has an internal criteria of evaluating if a queue is exhausted. What it does it that it keeps tabs of how many times it has encountered a specific id. If it has encountered it a handle of times (about 5 times), then it consideres the queue as "exhausted" - and returns a `null` to any requesting claim worker - indicating pool exhaustion.

!!! note "Relative exhaustion"
    As such, we can see that a RP can still have messages in it while being classified as exhausted. This brings us to another nice side effect. RP exhaustion is not a global thing, its relative to the workflow level. IE one can see a workflow and see it as exhausted whereas another can view is as not exhausted.

**Many Invalid Messages**

BUT ... we still have a problem here. Imagine again that we have MANY `"c*"` instances in the pool BUT the workflow is picky (still needs a specific `r6*` instance)! As per our overview of [resource pool](../todo.md), the designed partitioning does not help here, so what will happen?

Well, the PM will have to cycle through the resource pool a few times to recognize that it has been exhausted. In this worst case scenario, the time for selection grows in proportion to the amount of invalid messages in the queue.

Thankfully, from my testing, the PM is able to go through ~50 SQS messages per second, so I dont think this could be too much of an issue until you're running 100s of machines with really diverse and specific needs for CI.

!!! bug "Need to Add Thresholds to Messages"
    For the PM to safely disregard messages, there needs to be a threshold attribute in the messages. Likely the same as the state threshold at the time that it is enqueued in the pool. This also means that we dont need to put the heartbeat check in the PM but can remain in the worker

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
