# Claim Workers

Claim Workers are lightweight async tasks - implemented as JavaScript `Promises` and launched in parallel with `Promise.allSettled()` - that attempt to turn idle runners into ready-to-run resources for the current workflow. For a workflow requesting N instances, the control-plane spawns `N` Claim Workers concurrently.

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

- Parallelism  — workers race to secure runners
- Atomic state transitions  — each worker performs a conditional idle->claimed update to guarantee exclusive ownership.
- Liveness & health — before handing the instance to the workflow, the worker validates heartbeats and registration status.

## Instance Claiming

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

## Post-Claim Checks (Health + Registration)

Once an instance is claimed, the Claim Worker enters a polling loop that watches two lightweight signals written by the instance itself into DynamoDB. Because the instance publishes its own health and registration state, the control-plane never needs to call the EC2 or GitHub APIs which mitigates any API rate limits.

Before the worker resolves as fulfilled, it verifies that the claimed instance is genuinely ready:

| Check         | Stored in                         | Pass Condition                                   | Timeout |
|---------------|-----------------------------------|--------------------------------------------------|---------|
| Heartbeat     | HB item (`TYPE#Heartbeat`)        | `now - updatedAt ≤ HEARTBEAT_HEALTH_TIMEOUT`       | ~15 s   |
| Registration  | WS item (`TYPE#WS`)               | signal == `"UD_REG_OK"` AND runId matches workflow | ~10 s   |

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

!!! note "Health Timeout and Signal Timeouts"
    At the moment, these timeouts are not tunable and entirely internal within the controlplane

!!! note "How the instance knows what to signal"
    The runner’s internal registration loop detects the new runId, registers with GitHub, then writes the WorkerSignal record shown above.

### Success path

- Both checks pass before their respective timeouts.
- Claim Worker resolves its promise, and returns the instance ID and instance details back to the Provision orchestrator.

### Failure Path

- Missing or stale heartbeat or no registration signal within registrationTimeout →
- Claim Worker expires and terminates the instance and logs the reason, and retries with a new candidate.
- If the pool is exhausted, the claim worker exits with no instance details (instance creation soon follows)

---

This fully internal, signal-driven health check keeps the control-plane stateless, and API-independent while guaranteeing health and correctly registered runners.
