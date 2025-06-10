# Instance Initialization & Fleet Validation

Once AWS returns the brand-new instance IDs, Provision’s job is only half-done. The control-plane must make sure every EC2 runner has finished bootstrapping, registered itself with GitHub Actions, and is sending healthy heartbeats before it hands the runner over to the workflow.
That responsibility is split between two cooperating pieces:

1. User-data bootstrap script that runs inside the instance.
2. Fleet-validation routine that runs in the control-plane worker.

## 1. User-Data Bootstrap Flow

The bootstrap script runs **inside every new runner**. To see the full functionality of this script, please see [user-data](./user-data.md). We'll cover whats relevant here. In sequence, this script:

1. Executes the operator's pre-runner-script.
2. Initializes the heartbeat and self-termination agents.
3. Enters the registration loop.

Within the registration loop, `blockRegistration` blocks the runner from registering itself against Github until a `runId` has been registered against the runner in the Database.

Fortunately, we immediately create a `created` record in the database shortly after we get the instance ids from AWS along with the `runId`. The instance sees this and registers with that label.

On successful registration, it emits a successful registration signal which the controlplane picks up.

## 2. Fleet‑Validation Routine

After launching a fleet, the provision worker runs a short‑lived **validation loop** to be sure every brand‑new runner is *both* registered with GitHub **and** sending heartbeats.  
If any instance fails these checks within the timeout, the whole fleet is torn down and the workflow receives a clear error.

| Step | What the worker is waiting for | Success criteria | Failure action |
|------|--------------------------------|------------------|----------------|
| **1. Registration check** | Instance emits `UD_REG_OK` | All instances emit the signal | Abort: terminate the entire fleet |
| **2. Heartbeat check** | Fresh heartbeat rows every ≤ `HEARTBEAT_PERIOD` | All instances meet the threshold | Abort: terminate the entire fleet |
| **3. Global timeout** | Timer ≤ `FLEET_VALIDATION_TIMEOUT` (default = ~180s) | All checks pass before timeout | Abort: terminate the entire fleet |

When *all* instances satisfy steps 1 & 2 before the global timeout:

1. Update each record from `created->running`.  
2. We determine the creation to be of status 'success' for post-provisioning
3. Return control to the workflow dispatcher—jobs can begin immediately.

If **any** instance misses a check or the timeout expires:

- Call `TerminateInstances` on *every* new instance ID.  
- We determine the creation to be of status 'failed' for post-provisioning

---

This all‑or‑nothing policy keeps the fleet in a known‑good state and prevents half‑healthy capacity from slipping into production use.
