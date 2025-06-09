# Resource Pool & Pickup Manager

The Resource Pool (RP) is implemented as a family of SQS queues—one queue per runner class.
Each idle runner is represented by exactly one JSON message in the queue.
The Pickup Manager (PM) is an in-process singleton inside the control-plane that does three jobs:

 1. Dequeue a candidate message from the RP.
 2. Filter the message against the requesting workflow’s compute requirements.
 3. Dispatch the message to a Claim Worker (or re-queue it if unsuitable).

## 1. Interfacing with SQS

| Step | SQS Call  | Purpose  | Notes   |
|------|--|-|---------|
| 1    | `ReceiveMessage` | Pull one message off the RP queue. | A short poll keeps latency low. |
| 2    | *Immediate* DeleteMessage  | Remove the message from the queue to minimise contention with other PMs. | The message lives only in memory until we decide to re-queue.|
| 3    | Filter in-memory  | Check static attributes (usageClass, instanceType, CPU, memory, resourceClass, etc.) against the workflow’s provision inputs.| No network round-trips during filtering.|
| 4a   | Pass-On -> Claim Worker| If the message matches, hand it to the requesting Claim Worker for final health & registration checks.| Claim Worker now owns this instance.    |
| 4b   | Re-queue -> SendMessage| If the message doesn’t match, push it straight back onto the RP queue.  | Uses the original body; a short `DelaySeconds` (e.g., 3 s) prevents the PM from hot-looping the same bad message. |

## 2. Message Format Example

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

## 3. Message Handling Logic

Pass-On (happy path)

1. Message matches all workflow constraints.
2. PM hands it to the waiting Claim Worker.
3. Claim Worker performs atomic idle → claimed transition in DynamoDB.
4. On success, the instance proceeds to health/registration checks.

Re-queue (filter miss)

1. Message fails any constraint check (e.g., wrong usageClass, CPU too small).
2. PM immediately SendMessages the exact payload back to SQS with a short DelaySeconds.
3. Other workflows (with different constraints) can now claim the instance.

## 4. Pool Exhaustion

When the PM deems the pool as exhausted, it returns `null` to any requesting claim workers. The PM determines that a pool is exhausted via two means - Globally exhausted & Locally Exhausted

**Globally Exhausted**
This is fairly simply, the SQS queue does not give back any messages after a `ReceiveMessage` call. Meaning that the queue is empty and there are no available idle instances (atleast that we know about)

**Locally Exhausted**
This is more of a mitigation to prevent infinite looping due to the requeueing messages that do not fit the current workflow's constraints. If the singleton PM sees the same instanceId reappear N times (default 5), it considers the queue “exhausted” for this workflow and returns null to any calling Claim Worker.

---

Overall - this tight, stateless loop lets Provision chew through dozens of SQS messages per second, favouring warm-runner reuse while falling back to fresh EC2 capacity only when necessary.
