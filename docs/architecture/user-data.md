# User‑Data Bootstrap Script

Every newly‑launched EC2 runner executes the **bootstrap script** (see `scripts/bootstrap.sh`).  
The script prepares the OS, registers the runner with GitHub Actions, maintains heart‑beats, and
allows the same instance to be safely reused across many workflows.

## 1. Environment & Metadata Initialization

* Redirects stdout/stderr to `/var/log/user-data.log` for easy debugging.  
* Creates a working directory `~/actions-runner` and switches into it.  
* Queries the EC2 metadata service for:  
  * `INSTANCE_ID` – the EC2 identifier.  
  * `InitialRunId` – tag set by the control‑plane on launch.  
* Exports repo / table variables (`TABLE_NAME`, `GH_OWNER`, `GH_REPO`).  
* Defines helper Bash functions (`emitSignal`, `blockRegistration`, `blockInvalidation`,
  `tokenlessDeregistration`) used later in the loop.

## 2. Operator Pre‑Runner Script

* Executes the user‑supplied **pre‑runner‑script**.  
  * Success → emits `UD_OK`.  
  * Failure → emits `UD_FAILED` and exits.  
* Allows operators to pre‑install tool‑chains, caches, secrets, etc., before the runner is ever
  registered.

## 3. Background Agents

| Agent            | Purpose                                                     | Cadence |
|------------------|-------------------------------------------------------------|---------|
| `heartbeat.sh`   | Writes a **PING** row to DynamoDB so the control‑plane knows the box is alive. | 5 s |
| `self‑termination.sh` | Monitors the instance’s `threshold`; if the deadline passes, calls `ec2 terminate-instances` to avoid zombie capacity. | 15 s |

These agents start **once** and live for the lifetime of the instance.

## 4. Registration & Deregistration Loop

This loop repeats indefinitely, enabling seamless reuse across workflows.

1. **Wait for claim/creation**  
    `blockRegistration` polls DynamoDB until the control‑plane assigns a non‑empty `runId`.
2. **Register with GitHub**  
    * Downloads a registration token from DynamoDB.  
    * Runs `./config.sh` with the **`runId` as the only label** — guaranteeing job isolation.  
    * Emits `UD_REG_OK` or `UD_REG_FAILED`.
3. **Run jobs**  
    Launches `./run.sh` in the background; the runner pulls CI jobs for this workflow.
4. **Wait for release**  
    `blockInvalidation` blocks until the control‑plane clears or changes the `runId`(transition `running → idle`).
5. **Deregister**  
    `tokenlessDeregistration` removes the runner registration and emits
    `UD_REMOVE_REG_OK` / `UD_REMOVE_REG_FAILED`.
6. **Repeat**  
    The loop restarts, ready for the next workflow.

> **Why this matters** – Using the workflow’s `runId` as the label (`runs-on: ${{ github.run_id }}`)
> guarantees that jobs only ever land on the intended runner, even when the instance is reused.

## 5. Self‑Termination (Fail‑Safe)

When the instance’s state **threshold expires**, the watchdog in `self‑termination.sh` shuts down the EC2 instance.  

This prevents runaway costs and keeps the pool healthy without operator intervention.

## Signal Cheat‑Sheet

| Signal                     | Emitted When ...                          |
|----------------------------|-------------------------------------------|
| `UD_OK` / `UD_FAILED`      | Operator pre‑runner script succeeded / failed |
| `UD_REG_OK` / `UD_REG_FAILED` | GitHub registration succeeded / failed   |
| `UD_REMOVE_REG_OK` / `UD_REMOVE_REG_FAILED` | Deregistration succeeded / failed |
| Continuous `heartbeat` rows | Instance is alive and healthy             |

The control‑plane watches these signals during various parts of the instance lifeclce to decide whether an instance is at a good place to use for a workflow, or if it is safe to be released.
