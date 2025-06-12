# Instance Initialization

Every newly‑launched EC2 runner instance executes a **bootstrap script** upon startup. This script is responsible for initializing the instance, preparing the operating system, managing the GitHub Actions runner lifecycle (including registration and deregistration for multiple jobs), maintaining health signals, and enabling safe reuse of the instance across different workflows.

## 1. Environment & Metadata Initialization

The script begins by setting up the execution environment:

* **Logging**: Standard output and error streams are redirected to `/var/log/user-data.log` for debugging and audit.
* **Working Directory**: A dedicated directory (e.g., `~/actions-runner`) is created for runner operations.
* **EC2 Metadata**: Essential instance metadata is fetched from the EC2 metadata service, including:
  * `INSTANCE_ID`: The unique identifier of the EC2 instance.
  * `InitialRunId`: A run ID tag set by the control-plane during instance creation, used for initial setup signaling.
* **Configuration Variables**: Key variables required for interacting with AWS services and GitHub are set (e.g., `TABLE_NAME` for DynamoDB, `GH_OWNER`, `GH_REPO`).
* **Helper Functions**: A suite of Bash helper functions is defined to encapsulate common operations like:
  * `emitSignal`: Sending status signals to a central DynamoDB table.
  * `fetchGHToken`: Retrieving the GitHub Actions registration token from DynamoDB.
  * `blockRegistration`: Pausing execution until a workflow `runId` is assigned to the instance in DynamoDB.
  * `blockInvalidation`: Pausing execution until the instance is released from its current `runId` in DynamoDB.
  * `tokenlessDeregistration`: Handling the GitHub Actions runner deregistration process and cleanup.

## 2. Operator Pre‑Runner Script Execution

* The script executes a user-supplied **pre‑runner script** (e.g., `user-script.sh`).
* This allows operators to perform custom setup tasks such as pre-installing software, warming caches, or configuring secrets before the GitHub Actions runner software starts or registers.
* **Outcome Signaling**:
  * Success of the pre-runner script is signaled to DynamoDB (e.g., as `UD_OK` associated with the `InitialRunId`).
  * Failure is signaled (e.g., as `UD_FAILED`), and the bootstrap script typically exits to prevent a misconfigured runner.

## 3. GitHub Actions Runner Artifacts & Background Agents

* **Runner Artifacts**: The script downloads and extracts the specified version of the GitHub Actions runner software.
* **Background Agents Launch**: Two critical background scripts are launched to run for the lifetime of the instance:
  * `heartbeat.sh`: This agent periodically writes a "PING" record (including a timestamp) to a specific DynamoDB table. This allows the control-plane to monitor the instance's health and liveness.
  * `self-termination.sh`: This agent periodically checks a `threshold` timestamp associated with the instance's record in DynamoDB. If the current time exceeds this threshold (plus a small buffer), the agent initiates self-termination of the EC2 instance via an AWS API call. This prevents orphaned or runaway instances.

## 4. Main Registration & Job Execution Loop

After initialization, the script enters an indefinite loop, enabling the instance to be reused for multiple distinct CI workflows. Each iteration of the loop typically involves:

1. **Wait for Assignment (`blockRegistration`)**:
    * The script pauses and polls DynamoDB, waiting for the control-plane to assign a specific `runId` to this instance's record. This indicates the instance has been claimed for a new workflow or was created for one.

2. **Register with GitHub Actions**:
    * Once a `runId` (referred to as `LOOP_ID` within the loop) is detected:
        * A short-lived GitHub Actions registration token is fetched from DynamoDB (via `fetchGHToken`).
        * The GitHub Actions runner software is configured (`./config.sh`) using this token. Crucially, the instance registers itself with the unique `LOOP_ID` as its sole label. This ensures that only jobs from the workflow corresponding to `LOOP_ID` can run on this instance.
        * The outcome of this registration (success or failure) is signaled to DynamoDB (e.g., `UD_REG_OK` or `UD_REG_FAILED`). Failures typically cause the script to exit.

3. **Execute CI Jobs**:
    * The GitHub Actions runner is started (`./run.sh &`) in the background. It connects to GitHub and begins executing any CI jobs targeted to its `LOOP_ID` label.

4. **Wait for Release (`blockInvalidation`)**:
    * While the runner executes jobs, the main script pauses and polls DynamoDB, waiting for the `runId` associated with the instance to change or be cleared by the control-plane. This signals that the current workflow has completed and the instance should be released.

5. **Deregister from GitHub Actions & Cleanup (`tokenlessDeregistration`)**:
    * Once release is detected:
        * The script performs a "tokenless" deregistration of the runner (`./config.sh remove`).
        * The outcome of deregistration is signaled to DynamoDB (e.g., `UD_REMOVE_REG_OK` or `UD_REMOVE_REG_FAILED`).
        * The script ensures the `run.sh` process (and its listener) are properly terminated.
        * A final signal (e.g., `UD_REMOVE_REG_REMOVE_RUN_OK`) may be emitted to indicate full cleanup completion.

6. **Repeat**: The loop then returns to Step 1, waiting for a new `runId` assignment.

> **Job Isolation**: Using the workflow’s unique `runId` as the instance's GitHub Actions runner label is fundamental. It guarantees that CI jobs only land on the intended runner instance, even when that instance is reused across many different workflows.

## 5. Self‑Termination (Ultimate Fail‑Safe)

As mentioned in Section 3, the `self-termination.sh` background agent continuously monitors the instance's lifecycle `threshold` in DynamoDB. If this deadline (plus a buffer) is passed at any point, the agent will independently command the EC2 instance to terminate itself. This acts as a crucial fail-safe against instances becoming unresponsive or exceeding their allocated operational lifetime, helping to control costs and maintain a healthy pool.

## Signal Cheat‑Sheet (Key Signals to DynamoDB)

The bootstrap script uses signals written to DynamoDB to communicate its status and key lifecycle events to the control-plane. Key signals include:

| Signal Group                               | Emitted When...                                                                  |
| :----------------------------------------- | :------------------------------------------------------------------------------- |
| `UD_OK` / `UD_FAILED`                      | Operator pre‑runner script execution completes (successfully / with failure).      |
| `UD_REG_OK` / `UD_REG_FAILED`              | GitHub Actions runner registration completes (successfully / with failure).        |
| `UD_REMOVE_REG_OK` / `UD_REMOVE_REG_FAILED`  | GitHub Actions runner deregistration from GitHub completes (successfully / with failure). |
| `UD_REMOVE_REG_REMOVE_RUN_OK`              | Runner process fully shut down and deregistration complete.                      |
| Continuous `heartbeat` records             | Instance is alive, healthy, and the `heartbeat.sh` agent is functioning.         |

The control‑plane monitors these signals (and the absence of heartbeats) to make decisions regarding instance health, readiness for workflows, and safe release or termination.
