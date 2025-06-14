# Release Process: Returning Runners to the Pool

The release process ensures that the EC2 runner instances are safely returned to the resource pool once their assigned CI jobs are complete in order to be potentially reused.

## The Core Design: An Asynchronous Handshake 🤝

The release process is built on an asynchronous handshake mediated by DynamoDB. The Control Plane and the EC2 instance coordinate their actions by observing and modifying a shared state record.

!!! note "Sequence Diagram: Successful Release"
    ```mermaid
    sequenceDiagram
        participant CP as "Release<br>(Control Plane)"
        participant DDB as "DynamoDB"
        participant Instance

        Note right of CP: Workflow completion triggers release ⚡
        CP->>+DDB: Update instance state: set to 'idle', clear 'runId'
        DDB-->>-CP: Update successful
        CP->>+DDB: Polls for 'UD_REMOVE_REG_OK' signal

        Instance->>+DDB: Polls its record, detects 'runId' is cleared
        DDB-->>-Instance: State change confirmed

        Note over Instance: Conduct deregistration from Github

        Instance->>DDB: Write 'UD_REMOVE_REG_OK' signal<br>on successful deregistration 👌
        
        DDB-->>-CP: Signal found 👌

        Instance-->DDB: Polls its record for<br>new runId to register against ♻️
        Note right of CP: Instance mesage sent to pool 👌
    ```

## The Release Lifecycle: Step-by-Step

The entire lifecycle revolves around this coordinated state-driven handshake.

### 1. Initiation: Control Plane Identifies Runners 

The process begins when a GitHub Actions workflow finishes, triggering the Control Plane to start the release for all runners associated with that workflow's `runId`.

### 2. The Trigger: The `runId` is Cleared

This is the most critical step. For each `running` instance, the Control Plane performs an atomic update on its record in DynamoDB. It sets the `state` to `idle` and, most importantly, **clears the `runId`**. This change is the key signal that the instance is no longer needed for its current job and must begin the release process.

**BEFORE (running state):**

```json
{
  "instanceId": "i-123456",
  "state": "running",
  "runId": "run-9999",
  "threshold": "2025-05-31T12:30:00Z"
}
```

**AFTER (idle state trigger):**

```json
{
  "instanceId": "i-123456",
  "state": "idle",
  "runId": "", // This is the trigger
  "threshold": "2025-05-31T12:50:00Z"
}
```

### 3. Reaction: The Instance Deregisters Itself

The agent running on the EC2 instance constantly monitors its own record in DynamoDB. When it detects that the `runId` has been cleared, it initiates its self-cleanup procedure. Overall, deregistration prevents GitHub from attempting to send new jobs to an instance that is being retired.

### 4. Confirmation: The Instance Signals Readiness

After successfully deregistering from GitHub and completing its cleanup, the instance agent writes a confirmation signal (e.g., `UD_REMOVE_REG_OK`) back to its DynamoDB record. This signal serves as a receipt, informing the Control Plane that the instance has completed its responsibilities and is ready to be pooled.

### 5. Completion: The Control Plane Pools the Runner

The Control Plane, which has been polling for the instance's confirmation signal, now verifies that the signal has been received. Once confirmed, it constructs a message containing the instance's details (ID, instance type, resource class, etc.) and sends it to the appropriate SQS queue. The instance is now officially in the resource pool.

## Failure Handling and Resilience

To account for instance failures, the Control Plane does not wait indefinitely for the instance's confirmation signal.

If an instance fails to write its readiness signal to DynamoDB within a predefined timeout, the Control Plane assumes the instance is faulty or has crashed. Instead of adding a potentially corrupted runner to the pool, the Control Plane will **mark the instance for termination**. This ensures that only healthy, verified runners are reused, maintaining the overall health and reliability of the fleet.

!!! note "Sequence Diagram: Release Failure (Instance Timeout)"
    ```mermaid
    sequenceDiagram
        participant CP as "Release<br>(Control Plane)"
        participant DDB as "DynamoDB"
        participant Instance

        Note right of CP: Workflow completion triggers release ⚡
        CP->>+DDB: Update instance state: set to 'idle', clear 'runId'
        DDB-->>-CP: Update successful

        Instance->>+DDB: Polls its record, detects 'runId' is cleared
        DDB-->>-Instance: State change confirmed
        Note over Instance: Instance crashes or fails to<br>deregister from GitHub. It never<br>writes the confirmation signal. ❌

        CP->>+DDB: Polls for 'UD_REMOVE_REG_OK' signal

        loop For a defined timeout
            DDB-->>CP: Signal not found...
        end

        DDB-->>-CP: Final response: Polling timed out.

        Note right of CP: Instance is faulty. Marking for termination.
        CP->>DDB: Update instance record - expire threshold
        Note right of DDB: Expired threshold later seen by<br>other components of controlplane<br>is terminated asynchronously
        Note right of CP: Instance will NOT be sent to SQS pool.
    ```

## Final State: A Reusable Runner

The successful outcome of the release process is a message in an SQS queue. This message represents a clean, idle, and fully-vetted EC2 runner, ready to be picked up by the [Provision Process](./provision/selection/pickup-manager.md) for the next incoming workflow.

:sunny: