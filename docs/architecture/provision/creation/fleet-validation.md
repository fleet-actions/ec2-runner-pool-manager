# Fleet Validation

After the control-plane successfully requests new EC2 instances from AWS, a critical validation process must confirm that every new instance has successfully bootstrapped, registered with GitHub, and is healthy before it can be used.

This process is governed by a strict, **all-or-nothing** principle: if even a single instance in the newly created fleet fails its validation checks, the *entire fleet* is considered compromised and is terminated. This ensures that only fully operational and reliable sets of runners are introduced into the active pool.

## The Validation Handshake 🤝

Validation relies on a handshake between the control-plane and the new instances, using DynamoDB as the coordination point. This avoids direct communication and creates a robust, event-driven process.

The sequence is as follows:

1. **Control-Plane Initiates & Assigns `runId`**: For each new EC2 instance, the control-plane creates a record in DynamoDB. This initial record has its state set to `created` and, most importantly, includes the `runId` of the workflow that requested it.

    ```json
    // Initial record created by control-plane in DynamoDB
    {
      "instanceId": "i-abcdef123456",
      "state": "created",
      "runId": "workflow-run-789", // Assigned by control-plane
      "threshold": "2025-06-01T10:05:00Z"
    }
    ```

2. **Instance Acts on `runId`**: The bootstrap script on the new instance (detailed in [Instance Initialization](../../instance-initialization.md)) polls its DynamoDB record. Once it detects the `runId`, it uses that ID to register itself as a GitHub Actions runner. This `runId` becomes the runner's label, ensuring it is targeted by the correct workflow jobs.

3. **Instance Signals Back**: Upon successful registration with GitHub, the instance writes a registration signal (e.g., `UD_REG_OK`) back to its DynamoDB record. In parallel, a `heartbeat.sh` agent sends periodic pings to DynamoDB to signal its liveness.

4. **Control-Plane Observes**: The control-plane's fleet validation routine polls DynamoDB, waiting for the expected registration and heartbeat signals from *every* instance in the fleet.

!!! note "Sequence Diagram: Successful Fleet Validation"
    ```mermaid
    sequenceDiagram
        participant CP as "ControlPlane"
        participant DDB as "DynamoDB"
        participant Instance1
        participant Instance2

        Note over CP, Instance2: Fleet Creation successfully creates Instance1 & Instance2
        Note over DDB, Instance2: Instance1 & Instance2 periodically write heartbeat soon after startup ♻️ 
        CP->>DDB: Create record for Instance 1 & Instance 2<br>(state: created, runId: 123)
        CP->>+DDB: Poll for signals from all instances

        Instance1->>+DDB: Poll for runId
        DDB-->>-Instance1: Found runId: 123
        Instance1->>DDB: Write Registration Signal (UD_REG_OK) 👌

        Instance2->>+DDB: Poll for runId
        DDB-->>-Instance2: Found runId: 123
        Instance2->>DDB: Write Registration Signal (UD_REG_OK) 👌

        DDB-->>-CP: All signals and heartbeats are OK<br>(within timeout)

        CP->>DDB: Update Instance 1 & Instance 2<br>(state: created -> running)
        Note right of CP: Fleet is validated as successful ✅
    ```

## Validation Logic & Outcomes

The control-plane's validation process waits for two conditions to be met for the entire fleet before a validation timeout expires.

* **Success**: If all instances pass both registration and heartbeat checks, the control-plane transitions their state in DynamoDB from `created` to `running`, and the fleet is ready for use.

    ```json
    // Record updated by control-plane after successful validation
    {
      "instanceId": "i-abcdef123456",
      "state": "running", // <-- Updated
      "runId": "workflow-run-789",
      "threshold": "2025-06-01T12:00:00Z" // New threshold for running state
    }
    ```

* **Failure**: If any instance fails a check or the validation timeout is reached, the control-plane terminates **every instance** in the fleet. The creation process is marked as failed, preventing a partially-healthy or unreliable fleet from being used.

!!! note "Sequence Diagram: 1 out of 2 Instances Fail to Register"
    ```mermaid
        sequenceDiagram
            participant CP as "ControlPlane"
            participant DDB as "DynamoDB"
            participant Instance1
            participant Instance2
            participant AWS

            Note over CP, AWS: Fleet Creation successfully creates Instance 1 & Instance 2
            Note over DDB, Instance2: Instance1 & Instance2 periodically write heartbeat soon after startup ♻️ 
            CP->>DDB: Create record for Instance 1 & 2 (state: created, runId: 123)

            CP->>+DDB: Poll for signals from all instances (Validation Timeout Starts)

            Instance1->>+DDB: Poll for runId
            DDB-->>-Instance1: Found runId: 123
            Instance1->>DDB: Write Registration Signal (UD_REG_OK) 👌

            Note over Instance2: Fails to boot or register.<br>Never signals `UD_REG_OK`.

            loop Until Validation Timeout
                DDB-->>CP: Still waiting for signal from Instance 2...
            end

            DDB-->>-CP: Final response: Polling timed out.

            Note right of CP: Instance 2 failed the check.<br>Terminating fleet.

            CP->>AWS: TerminateInstances(Instance1, Instance2)
            AWS->>Instance1: Terminate
            AWS->>Instance2: Terminate

            Note right of CP: Fleet is validated as failed ❌
    ```

:sunny: