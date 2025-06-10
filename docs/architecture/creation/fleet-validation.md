# Instance Initialization & Fleet Validation

Once AWS confirms the creation of new EC2 instances and returns their IDs, the Provision component's task is only partially complete. The control-plane must then rigorously verify that every newly launched EC2 runner has successfully completed its bootstrapping process, registered itself with GitHub Actions using the correct workflow identifier, and is emitting healthy heartbeats. Only after these confirmations can the runners be safely handed over to the requesting workflow.

This critical validation responsibility is divided between two cooperating elements:

1. The **user-data bootstrap script**, which executes within each newly launched EC2 instance.
2. The **fleet-validation routine**, a control-plane process orchestrated by the provision worker.

## 1. User-Data Bootstrap Flow (Instance-Side)

The bootstrap script, detailed comprehensively in [User-Data Bootstrap Script](../user-data.md), runs automatically inside every new runner upon launch. For the fleet validation phase, the relevant sequence of actions performed by this script is:

1. **Pre-Runner Script Execution**: Executes any operator-defined pre-runner scripts (e.g., for installing tools, warming caches). Success or failure of this script is signaled.
2. **Background Agent Initialization**: Starts the `heartbeat.sh` and `self-termination.sh` agents. The `heartbeat.sh` agent immediately begins sending periodic "PING" signals to DynamoDB, as described in [User-Data Background Agents](../user-data.md#3-background-agents).
3. **Registration Loop Entry**: The script enters its main registration and job execution loop.
    * **Waiting for `runId`**: A key function, `blockRegistration` (see [User-Data Registration & Deregistration Loop](../user-data.md#4-registration--deregistration--loop)), pauses the script. It polls DynamoDB, waiting for the control-plane to associate a `runId` with the instance.
    * **Control-Plane Provides `runId`**: When the control-plane launches instances, it immediately creates a corresponding record in DynamoDB for each new instance. This record is set to a `created` state and, crucially, includes the `runId` of the workflow for which the instance was provisioned. For example:

        ```json
        // Initial record created by control-plane in DynamoDB
        {
          "instanceId": "i-abcdef123456",
          "state": "created",
          "runId": "workflow-run-789", // Assigned by control-plane
          "threshold": "2025-06-01T10:05:00Z"
        }
        ```

    * **Instance Registration**: Once the `blockRegistration` function detects the `runId` in its DynamoDB record, the instance proceeds to register itself as a GitHub Actions runner, using this specific `runId` as its label. This ensures job isolation.
    * **Signaling Registration Success**: Upon successful registration with GitHub, the instance emits a registration success signal (e.g., `UD_REG_OK` or simply `UD_REG`) to DynamoDB. This signal is what the control-plane's fleet-validation routine will be looking for. See [User-Data Signal Cheat-Sheet](../user-data.md#signal-cheat-sheet).

## 2. Fleet‑Validation Routine (Control-Plane Side)

After initiating the launch of a fleet of EC2 instances, the provision worker in the control-plane executes a short-lived but critical **fleet-validation loop**. This loop's purpose is to ensure that *every single instance* in the newly launched fleet is both correctly registered with GitHub Actions (as indicated by its signal) and actively sending healthy heartbeats.

This validation is an **all-or-nothing** process. If any instance fails these checks within the predefined timeouts, the entire fleet is considered compromised, and the control-plane will initiate termination for all instances in that fleet, providing a clear error back to the workflow.

The validation routine sequentially performs checks, as implemented in `src/provision/creation/fleet-validation.ts`:

| Step                      | Control-Plane Waits For                                    | Success Criteria (for the entire fleet)                                  | Failure Action (for the entire fleet)   | Relevant Code Function (`fleet-validation.ts`) |
| :------------------------ | :--------------------------------------------------------- | :----------------------------------------------------------------------- | :-------------------------------------- | :------------------------------------------- |
| **1. Registration Check** | Instance emits its registration success signal (e.g., `UD_REG`) with the correct `runId`. | All instances in the fleet emit this signal.                             | Abort: Terminate the entire fleet.      | `checkWSStatus`                            |
| **2. Heartbeat Check**    | Fresh heartbeat ("PING") signals in DynamoDB.              | All instances have recent heartbeats (within `HEARTBEAT_HEALTH_TIMEOUT`). | Abort: Terminate the entire fleet.      | `checkHeartbeatStatus`                     |
| **3. Global Timeout**     | An overall timer (`Timing.FLEET_VALIDATION_TIMEOUT`, default ~180s). | All above checks for all instances must pass before this global timeout expires. | Abort: Terminate the entire fleet.      | Implicit in `checkWSStatus`              |

**Detailed Check Logic (from `src/provision/creation/fleet-validation.ts`):**

* **Initial Status Check**: The `fleetValidation` function first checks if the input `fleetResult.status` is already not `'success'`. If so, it fails early.
* **Worker Signal Status (`checkWSStatus`)**:
  * Polls DynamoDB for the `WorkerSignalOperations.OK_STATUS.UD_REG` signal from *all* specified `instanceIds`, ensuring the signal is associated with the correct `runId`.
  * This polling continues for a duration up to `Timing.FLEET_VALIDATION_TIMEOUT`, with checks at `Timing.FLEET_VALIDATION_INTERVAL`.
  * If not all instances emit the required signal within the timeout, the fleet status is set to `failed`.
* **Heartbeat Status (`checkHeartbeatStatus`)**:
  * If the registration check passed, this function then calls `heartbeatOperations.areAllInstancesHealthyPoll(instanceIds)`.
  * This polls to verify that all instances in the fleet have sent a heartbeat recently (i.e., their last heartbeat's `updatedAt` timestamp is within an acceptable window like `HEARTBEAT_HEALTH_TIMEOUT`).
  * If not all instances are found healthy, the fleet status is set to `failed`.

**Outcome of Validation:**

* **If ALL instances satisfy both registration and heartbeat checks before the global timeout expires:**
    1. The control-plane updates the DynamoDB record for each instance, transitioning its `state` from `created` to `running`. For example:

        ```json
        // Record updated by control-plane after successful validation
        {
          "instanceId": "i-abcdef123456",
          "state": "running", // <-- Updated
          "runId": "workflow-run-789",
          "threshold": "2025-06-01T12:00:00Z" // New threshold for running state
        }
        ```

    2. The overall creation process for this batch of instances is marked as successful.
    3. Control is returned to the workflow dispatcher, and the instances are now ready to accept CI jobs.

* **If ANY instance fails any check, or if the global timeout (`Timing.FLEET_VALIDATION_TIMEOUT`) expires before all checks pass:**
    1. The control-plane calls the `TerminateInstances` AWS API for *every instance ID* in that newly launched fleet.
    2. The overall creation process is marked as failed.
    3. An error is propagated, preventing the workflow from attempting to use potentially unhealthy or misconfigured runners.

---

This strict, all-or-nothing validation policy is crucial for maintaining a healthy and reliable runner pool. It prevents "half-healthy" fleets, where some instances are operational while others are problematic, from entering production use and causing difficult-to-diagnose issues for CI workflows.
