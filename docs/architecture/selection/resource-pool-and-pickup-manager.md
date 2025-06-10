# Resource Pool & Pickup Manager

The Resource Pool (RP) is implemented as a collection of Amazon SQS (Simple Queue Service) queues. Each distinct "runner class" (e.g., based on operating system, available software, or instance size) has its own dedicated SQS queue. When an EC2 runner instance becomes `idle` after completing a workflow, a message representing it is sent to the appropriate resource class queue.

The Pickup Manager (PM) is an in-process component within the control-plane's Provision mode. It is instantiated per workflow selection attempt and is responsible for efficiently retrieving and filtering these idle instance messages from the SQS queues to find suitable warm runners for the current workflow's requirements.

The Pickup Manager's core responsibilities are:

1. **Dequeueing Candidate Messages**: Retrieving messages from the relevant SQS resource pool queue.
2. **Filtering**: Evaluating the dequeued message against the requesting workflow’s specific compute requirements (e.g., instance type, usage class, CPU, memory).
3. **Dispatching or Re-queuing**:
    * If a message represents a suitable instance, it's passed to a Claim Worker for an attempt to claim the instance.
    * If unsuitable for the current request, the message is returned to the SQS queue for other workflows.
    * If the message represents an invalid or malformed entry, it may be discarded.

## 1. Interfacing with SQS: The Pickup Lifecycle

The Pickup Manager interacts with SQS in a tight loop designed for low latency and efficient message handling, as implemented in `src/provision/selection/pool-pickup-manager.ts` and `src/services/sqs/operations/resource-class-operations.ts`.

| Step | Action by Pickup Manager                      | SQS Operation (Conceptual via `resource-class-operations.ts`) | Purpose & Notes                                                                                                                                                                                             |
| :--- | :-------------------------------------------- | :-------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Request a message from the specific SQS queue. | `ReceiveMessage` (within `receiveAndDeleteResourceFromPool`)    | A short poll is typically used to minimize latency in discovering available idle runners.                                                                                                                   |
| 2    | Delete the message from SQS.                   | `DeleteMessage` (within `processAndDeleteMessage` helper, called by `receiveAndDeleteResourceFromPool`) | The message is deleted from the SQS queue **immediately after successful receipt and basic validation (e.g., presence of a body and receipt handle)**, but *before* full content parsing or filtering. This minimizes contention for the same message by multiple concurrent Provision processes or workers. The message effectively lives only in the Pickup Manager's memory for the filtering stage. |
| 3    | Filter the message content in-memory.         | N/A (Local operation)                                           | The deserialized message (see format below) is checked against the workflow’s provision inputs (e.g., `allowedInstanceTypes`, `usageClass`, required CPU/memory). No network round-trips occur during this filtering. |
| 4a   | **Pass-On (Match Found)**                     | N/A (Dispatch to Claim Worker)                                  | If the message's attributes match the workflow's requirements, the `InstanceMessage` object is handed to a waiting Claim Worker. The Claim Worker will then attempt to atomically transition the instance's state in DynamoDB from `idle` to `claimed`. |
| 4b   | **Re-queue (Filter Mismatch)**                | `SendMessage` (via `sendResourceToPool`)                        | If the message does not match the *current* workflow's constraints (e.g., wrong instance type for this job, but potentially suitable for another), it is sent back to the same SQS queue. A short `DelaySeconds` can be applied to this `SendMessage` operation (an SQS feature) to prevent the Pickup Manager from immediately re-picking and re-evaluating the same unsuitable message in a tight loop for the *same* workflow request. |
| 4c   | **Discard (Invalid/Malformed Message)**       | N/A (Already deleted)                                           | If the message is found to be fundamentally invalid during parsing or pre-filter checks (e.g., wrong resource class for the queue it was in, insufficient CPU/memory compared to its own class definition), it is discarded. Since it was already deleted from SQS in Step 2, no further action is needed on the queue. |

## 2. SQS Message Format Example

The following JSON structure represents the payload of an SQS message for an idle instance, corresponding to the `InstanceMessage` interface in `src/services/sqs/operations/resource-class-operations.ts`:

```json
{
  "id": "i-12345678abcdef0",
  "resourceClass": "medium-linux",
  "instanceType": "c6i.large",
  "cpu": 2,
  "mmem": 4096,
  "usageClass": "on-demand"
}
```

| Field           | Type                     | Purpose & How It's Used by Pickup Manager                                                                                                                                 |
| :-------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | string                   | The EC2 Instance ID. Primary key for subsequent DynamoDB lookups by the Claim Worker. Also used by the Pickup Manager for local exhaustion tracking (see Pool Exhaustion). |
| `resourceClass` | string                   | The specific resource class this instance belongs to (e.g., "medium-linux"). The Pickup Manager targets a queue for a specific resource class. This field is validated.    |
| `instanceType`  | string                   | The concrete EC2 instance type (e.g., "c6i.large"). This is pattern-matched against the workflow's `allowedInstanceTypes` input.                                         |
| `cpu`           | number                   | The number of vCPUs of the instance. Used for strict matching against the resource class definition.                                                                    |
| `mmem`          | number                   | The memory (in MiB) of the instance. Checked to ensure it meets or exceeds the minimum specified in the resource class definition.                                        |
| `usageClass`    | enum (`spot`\|`on-demand`) | Indicates if the instance is Spot or On-Demand. Must match the `usageClass` requested by the workflow.                                                                     |

*Note: The actual SQS message might contain additional SQS-specific attributes (like `MessageId`, `ReceiptHandle`, or even an SQS message `threshold`/timer for its own lifecycle), but the payload above is what the application logic in the Pickup Manager primarily interacts with.*

## 3. Message Handling and Classification Logic

The `classifyMessage` method within `src/provision/selection/pool-pickup-manager.ts` determines the fate of a dequeued message:

* **OK (Pass-On)**:
    1. The message's `resourceClass` is valid and matches the target pool.
    2. Its `cpu` and `mmem` meet the specifications of its `resourceClass`.
    3. Its `instanceType` matches the workflow's `allowedInstanceTypes` (supports wildcard patterns).
    4. Its `usageClass` matches the workflow's requested `usageClass`.
    5. **Action**: The Pickup Manager returns this `InstanceMessage` to the Provision orchestrator, which then dispatches it to a Claim Worker.

* **Re-queue (Filter Mismatch for Current Workflow)**:
    1. The message is valid in itself (correct `resourceClass`, `cpu`, `mmem`) but does not meet the current workflow's specific criteria (e.g., `instanceType` not in `allowedInstanceTypes`, or a `usageClass` mismatch).
    2. **Action**: The Pickup Manager uses `sqsOps.sendResourceToPool()` to send the exact message payload back to its original SQS queue. This allows other workflows with different constraints to potentially claim this instance.

* **Delete (Discard Invalid Message)**:
    1. The message is malformed or represents an inconsistent state (e.g., `resourceClass` in the message doesn't match the queue it came from, or `cpu`/`mmem` are fundamentally incorrect for its stated `resourceClass`).
    2. **Action**: The message is logged and effectively discarded (it was already deleted from SQS in the initial dequeue step). The Pickup Manager then attempts to pick another message.

## 4. Pool Exhaustion Detection

The Pickup Manager can determine that a resource pool is "exhausted" for the current workflow's request through two main heuristics, as implemented in `src/provision/selection/pool-pickup-manager.ts`:

* **Globally Exhausted (Queue Empty)**:
  * The `sqsOps.receiveAndDeleteResourceFromPool()` call returns `null`, indicating that the SQS queue for the target `resourceClass` is currently empty.
  * **Outcome**: The Pickup Manager returns `null`, signaling to the Provision orchestrator that no idle instances are available in this pool.

* **Locally Exhausted (Repetitive Unsuitable Messages)**:
  * To prevent an infinite loop where the Pickup Manager continuously picks, re-queues, and re-picks the same set of messages that are unsuitable for the *current* workflow's specific constraints, it maintains an internal frequency count for each `instanceId` it encounters during its current operational lifecycle (`instanceFreq` map).
  * If the same `instanceId` is dequeued more than a defined `FREQ_TOLERANCE` (default is 5 times), the Pickup Manager considers the pool locally exhausted *for the current request*.
  * **Outcome**: The message is still re-queued (so it's available for other workflows), but the Pickup Manager returns `null` for *this specific pickup attempt*, effectively suspending pickups for this workflow from this pool to avoid unproductive cycling.

---

This SQS-based resource pool and the described Pickup Manager logic allow the Provision mode to efficiently scan for and reuse warm, idle runner instances. It prioritizes reuse by quickly filtering available instances, only falling back to provisioning fresh EC2 capacity when the pool is genuinely exhausted or no suitable candidates can be found.
