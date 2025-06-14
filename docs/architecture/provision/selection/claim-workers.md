# Claim Workers

Claim Workers are asynchronous tasks that run in parallel to secure idle runners for a workflow. Each worker executes a loop to pick up, claim, and verify an instance from the resource pool.
The core responsibilities are:

* **Atomic Claim**: Perform a conditional update in DynamoDB to transition an instance's state from idle to claimed, guaranteeing exclusive ownership.
* **Health Verification**: Check the instance's heartbeat in DynamoDB to ensure it's responsive.
* **Registration Check**: Wait for a signal from the instance's agent confirming it's registered and ready for work.

If an instance fails any of these checks, the worker discards it-terminating it if necessary-and attempts to claim a new one from the pool. This ensures that only fully validated runners are provisioned.

<!-- :sun: -->

!!! note "Sequence Diagram: Successful Claim and Checks"
    ```mermaid
    sequenceDiagram
        participant CW as "Claim Worker"
        participant DDB as "DynamoDB"
        participant Instance
        participant GitHub

        Note right of CW: Receives candidate_instance_id<br>from Pickup Manager
        Instance-->DDB: Periodically emit Heartbeat ♻️

        CW->>+DDB: Attempt Atomic Claim: Update instance_id<br>(idle->claimed, set run_id)
        DDB-->>-CW: Claim Successful
        
        Note over Instance, DDB: Instance polls DB, detects new run_id
        CW->>+DDB: Poll for Registration Signal<br>(instance_id, expected run_id, UD_REG_OK)

        Instance->>+GitHub: Register with run_id
        GitHub-->>-Instance: Registration OK

        Instance->>DDB: Write Worker Signal (UD_REG_OK, run_id)

        Instance-->GitHub: Able to pickup CI Jobs ♻️ 
        
        DDB-->>-CW: Signal OK
        CW->>+DDB: Poll for Heartbeat (instance_id)
        DDB-->>-CW: Heartbeat OK (recent)

        Note right of CW: Instance claimed, healthy, and registered ✅
        Note right of CW: Instance details handed to post-provision
    ```

## Instance Claiming Process

1. **Receive Candidate Instance**: A Claim Worker receives a candidate instance message from the [Pickup Manager](./pickup-manager.md). The controlplane expects this message to describe an idle instance.
2. **Attempt Atomic State Update in DynamoDB**: The worker attempts a single,
    atomic conditional write operation in DynamoDB.
    - **Condition**: The operation only succeeds if the instance is currently in an `idle` state and has no `runId` associated with it.
    - **Mutation**: If the condition is met, the instance's state is updated to `claimed`, a new `runId`, and a `threshold` (claimTimeout) is set.
    * **Significance of `runId` Assignment**: This `runId` assignment is the primary trigger for the instance to register itself against Github. This id is used as its label in order to properly associate the workflow's CI jobs to the instance (see [Instance Initialization](../../instance-initialization.md)).
3. **Collision Handling**: If the conditional write to DynamoDB fails (ie. another Claim Worker claimed the instance), the worker simply requests another candidate from the Pickup Manager to try again.

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

!!! note "Claim Lifetime (`threshold`) versus Registration & Health Checks"
    The `threshold` set during the claim limits how long the instance can remain in the `claimed` state without successfully completing its registration and health checks. This ensures that if an instance gets stuck during this phase, the claim will eventually self-expire and will be terminated by the controlplane.

## Post-Claim Checks: Verifying Health and Registration

Once an instance is successfully marked as `claimed` in DynamoDB, the Claim Worker polls for two key signals that the instance writes into DynamoDB. This indirect signaling mechanism means that we do not need to directly call AWS/GitHub APIs for these checks, mitigating potential API rate limit issues.

Before the worker considers the claim fully successful and resolves its promise, it verifies:

| Check | Verification Method | Pass Condition   | Timeout |
|--|--|--|--|
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

This record is continuously updated by the `heartbeat.sh` agent running on the instance, as described in [Instance Initialization](../../instance-initialization.md).

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

This signal is emitted by the instance itself after it successfully completes its GitHub registration process using the assigned `runId`. This entire registration sequence by the instance is detailed in [Instance Initialization](../../instance-initialization.md).

!!! note "Health Timeout and Signal Timeouts"
    Currently, the specific timeout values for heartbeat validation and registration signal polling are internal to the control-plane and not externally tunable.

### Process Outcomes

The claiming process concludes in one of two ways:

* **Success:** When both heartbeat and registration checks pass, the Claim Worker returns the verified instance details to the Provision orchestrator. The orchestrator then transitions the instance's state to `running`, making it ready for workflow jobs.

* **Failure:** If either check fails, the worker deems the instance non-viable. It expires the instance's DynamoDB record (marking it for cleanup) and may directly terminate the EC2 instance. The worker then signals failure to the orchestrator, which can either instruct a retry with a new candidate or, if the pool is exhausted, trigger the provisioning of new capacity (ie. [Creation](../creation/fleet-creation.md)).

!!! note "Sequence Diagram: Successful Claim but Failed Checks"
    ```mermaid
    sequenceDiagram
        participant CW as "Claim Worker"
        participant DDB as "DynamoDB"
        
        participant Instance
        participant AWS

        Note right of CW: Receives candidate_instance_id<br>from Pickup Manager

        CW->>+DDB: Attempt Atomic Claim (idle -> claimed, set run_id)
        DDB-->>-CW: Claim Successful

        Note over Instance, DDB: Instance detects new run_id<br>but fails to register with GitHub<br>or crashes.

        CW->>+DDB: Poll for Registration Signal (UD_REG_OK)

        loop For ~10 seconds
            DDB-->>CW: Signal not found...
        end

        DDB-->>-CW: Final response: Polling timed out ❌

        Note right of CW: Instance is non-viable. Terminating.

        CW->>AWS: Terminate Instance (instance_id)
        AWS->>Instance: Terminate Instance
        Note over Instance: Shutdown

        CW->>DDB: Mark instance as expired in DB

        Note right of CW: Retry process with <br>new candidate from Pickup Manager
    ```

:sun: