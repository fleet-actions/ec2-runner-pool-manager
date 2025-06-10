# Claim Workers

Claim Workers are lightweight asynchronous tasks—implemented as JavaScript `Promises` and launched in parallel using `Promise.allSettled()`—that attempt to turn idle runners into ready-to-run resources for the current workflow. For a workflow requesting N instances, the control-plane spawns N Claim Workers concurrently.

Their primary function is to race to secure available idle instances from the SQS resource pool, update their state in DynamoDB to `claimed` for a specific workflow, and then verify the instance is healthy and correctly registered before handing it off.

Key responsibilities can be visualized as:
A Pickup Message from SQS (representing an idle instance) is processed by a Claim Worker. This worker executes a promise chain. If successful, the instance transitions from an `idle` state, to `claimed`, and finally to `running`.

- **Parallelism**: Multiple workers operate concurrently, racing to secure available runners from the pool.
- **Atomic State Transitions**: Each worker performs a conditional update in DynamoDB (from `idle` to `claimed`) to guarantee exclusive ownership of an instance for a specific workflow.
- **Liveness & Health Verification**: Before an instance is considered fully claimed and ready for the workflow, the worker validates its heartbeat and registration status by observing signals written by the instance itself into DynamoDB.

## Instance Claiming Process

1. **Receive Candidate Instance**: A Claim Worker receives a candidate instance message from the Pickup Manager (which reads from the SQS resource pool). This message describes an idle instance.
2. **Attempt Atomic State Update in DynamoDB**: The worker attempts a single,
    atomic conditional write operation in DynamoDB.
    - **Condition**: The operation only succeeds if the instance is currently in an `idle` state and has no `runId` associated with it.
    - **Mutation**: If the condition is met, the instance's state is updated to `claimed`, the unique `workflow-runId` is assigned to it, and a new `threshold` (claimTimeout) is set.
    - **Significance of `runId` Assignment**: This assignment of the `workflow-runId` is the primary trigger for the EC2 instance. As detailed in the [User-Data Bootstrap Script's 'Registration & Deregistration Loop' (user-data.md#4-registration--deregistration--loop)](../user-data.md#4-registration--deregistration--loop), the instance's `blockRegistration` function actively polls DynamoDB until this `runId` is populated. Upon detecting the new `runId`, the instance initiates its registration process with GitHub.
3. **Collision Handling**: If the conditional write to DynamoDB fails (e.g., because another Claim Worker claimed the instance fractions of a second earlier), the worker's promise rejects. The calling orchestrator (Provision) will then typically request another candidate instance from the Pickup Manager for this worker to try again.

Example record transition in DynamoDB:

**BEFORE (idle state):**

```json
{
  "instanceId": "i-123456",
  "state": "idle",
  "runId": "",
  "threshold": "2025-05-31T12:20:00Z"
}
```

**AFTER (claimed state):**

```json
{
  "instanceId": "i-123456",
  "state": "claimed",
  "runId": "run-9999",
  "threshold": "2025-05-31T12:30:00Z"
}
```

!!! note "Claim Lifetime"
    The `threshold` set during the claim limits how long the instance can remain in the `claimed` state without successfully completing its registration and health checks. This ensures that if an instance gets stuck during this phase, the claim will eventually self-expire, and the instance can be re-evaluated by the `refresh` process.

## Post-Claim Checks: Verifying Health and Registration

Once an instance is successfully marked as `claimed` in DynamoDB, the Claim Worker enters a polling loop. It watches for two key signals that the instance writes into DynamoDB. This indirect signaling mechanism, where the instance publishes its own health and registration status, means the control-plane (and thus the Claim Worker) does not need to directly call EC2 or GitHub APIs for these checks, mitigating potential API rate limit issues.

Before the worker considers the claim fully successful and resolves its promise, it verifies:

| Check        | Verification Method                                    | Pass Condition                                      | Timeout |
|--------------|--------------------------------------------------------|-----------------------------------------------------|---------|
| **Heartbeat** | Checks the `HB` item for the instance in DynamoDB.     | The `updatedAt` timestamp of the heartbeat must be within the `HEARTBEAT_HEALTH_TIMEOUT`. | ~15 s   |
| **Registration** | Checks the `WS` (Worker Signal) item for the instance in DynamoDB. | The signal value must be `UD_REG_OK`, and the `runId` in the signal must match the current workflow's `runId`. | ~10 s   |

**Heartbeat Record in DynamoDB (Example):**
(Primary Key: `TYPE#Heartbeat`, Sort Key: `ID#i-123`)

```json
{
  "value": "PING",
  "updatedAt": "2025-05-31T12:27:05Z"
}
```

This record is continuously updated by the `heartbeat.sh` agent running on the instance, as described in the [User-Data Bootstrap Script under 'Background Agents' (user-data.md#3-background-agents)](../user-data.md#3-background-agents).

**Registration Signal Record in DynamoDB (Example):**
(Primary Key: `TYPE#WS`, Sort Key: `ID#i-123`)

```json
{
  "value": {
    "signal": "UD_REG_OK",
    "runId": "run-9999"
  }
}
```

This signal is emitted by the instance itself after it successfully completes its GitHub registration process using the assigned `runId`. This entire registration sequence by the instance is detailed in the [User-Data Bootstrap Script under 'Registration & Deregistration Loop' (user-data.md#4-registration--deregistration--loop)](../user-data.md#4-registration--deregistration--loop).

!!! note "Health Timeout and Signal Timeouts"
    Currently, the specific timeout values for heartbeat validation and registration signal polling are internal to the control-plane and not externally tunable.

!!! note "How the instance knows what to signal and when"
    The EC2 runner's internal registration loop, as detailed in the [User-Data Bootstrap Script (user-data.md#4-registration--deregistration--loop)](../user-data.md#4-registration--deregistration--loop), is designed to:
    1.  Detect the new `runId` (set by this Claim Worker during the "Instance Claiming Process").
    2.  Use this `runId` to register with GitHub Actions, ensuring it's associated with the correct workflow.
    3.  After successful registration, write the `UD_REG_OK` signal along with the `runId` into its WorkerSignal (`WS`) record in DynamoDB.

### Coordination Handshake Summary

The claiming process relies on this clear handshake:

1. **Claim Worker (Controlplane):** Atomically updates the instance state to `claimed` and assigns the `workflow-runId` in DynamoDB.
2. **Instance (per `user-data.md`):** Its `blockRegistration` function detects this newly assigned `runId`.
3. **Instance (per `user-data.md`):** Proceeds to register with GitHub using this `runId`.
4. **Instance (per `user-data.md`):** After successful registration, emits the `UD_REG_OK` signal (including the `runId`) into its `WS` item in DynamoDB.
5. **Instance (per `user-data.md`):** The separate `heartbeat.sh` agent continues to update its `HB` item in DynamoDB with a "PING" and current timestamp.
6. **Claim Worker (Controlplane):** Polls DynamoDB and verifies both the `UD_REG_OK` signal (matching the expected `runId`) from the `WS` item and a recent timestamp from the `HB` item.

### Success Path

- Both the heartbeat check and the registration signal check pass before their respective timeouts.
- The Claim Worker successfully resolves its promise. It returns the instance ID and other relevant instance details back to the Provision orchestrator, indicating the instance is claimed, healthy, registered, and ready for the workflow. The Provision orchestrator will then transition the instance's state from `claimed` to `running`.

### Failure Path

- If a recent heartbeat is missing (stale or non-existent), or if the correct registration signal (`UD_REG_OK` with the matching `runId`) is not observed within the `registrationTimeout`:
  - The Claim Worker determines the instance is not viable.
  - It will typically expire the instance in DynamoDB (marking it for termination by the `refresh` process) or directly initiate termination of the EC2 instance.
  - The worker logs the reason for the failure.
  - The worker's promise rejects, signaling to the Provision orchestrator that this attempt failed. The orchestrator may then instruct the worker to retry with a new candidate instance from the pool.
- If the resource pool is exhausted and no more candidates are available, the Claim Worker exits without providing instance details. This signals to the Provision orchestrator that new EC2 instances may need to be created.

---

This fully internal, signal-driven health and registration check mechanism allows the control-plane (and its Claim Workers) to remain stateless and API-independent for these critical verification steps, while still guaranteeing that only healthy and correctly registered runners are provided to workflows.
