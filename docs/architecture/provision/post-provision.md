# Post-Provision: Finalizing and Committing Resources

The Post-Provision phase concludes the provisioning operation. It evaluates the combined results from **Instance Selection** and **Instance Creation** to determine if the requested compute capacity was successfully acquired. Based on this outcome, it either commits the resources to the workflow or performs a graceful rollback.

## 1. Overall State Reconciliation

This initial step reconciles the results from the selection and creation phases to determine if the full request for healthy runners was met. The evaluation requires that all newly created instances passed their validation and that the total number of ready instances (selected + created) meets the workflow's demand. The outcome is a simple `'success'` or `'failure'` status, which dictates the next action.

!!! note "Sequence Diagram: Post-Provision Outcomes"
    ```mermaid
    sequenceDiagram
    participant Orchestrator as "Post-Provision<br>Orchestrator"
    participant DDB as "DynamoDB"
    participant SQS as "SQS Pool"
    participant AWS

    Note over Orchestrator: Reconcile status of selection/creation<br>overallStatus ('success' 👌 or 'failure' 🚫)

    alt overallStatus is 'success' 👌
        Note right of Orchestrator: Path A: Commit Resources
        Orchestrator->>+DDB: Update all instances to 'running' + threshold
        DDB-->>-Orchestrator: OK
    else overallStatus is 'failure' 🚫
        Note right of Orchestrator: Path B: Graceful Rollback
        Orchestrator->>+DDB: Revert 'claimed' instances to 'idle'
        DDB-->>-Orchestrator: OK
        Orchestrator->>SQS: Return instances to pool
    end

    rect
        Note right of Orchestrator: Path C (Emergency Cleanup): If an unexpected error occurs,<br>all involved instances are terminated<br>and their DDB records are purged. This is the safety net.
        Orchestrator->>DDB: Delete instance records
        Orchestrator->>AWS: Sent termination signals to selected & created instances
    end
    ```

## 2. Path A: Successful Provisioning

Taken when the overall status is `'success'`. This path transitions all acquired runners into an operational state for the workflow.

* **Core Responsibility**: Formally commit all acquired runners to the workflow.
* **Key Actions**:
    * **Update State to `running`**: Transitions all `claimed` (from selection). All created instances already `running` at this point (as per [fleet validation](./creation/fleet-validation.md))
    * **Set Operational Lifetime**: Assigns a new lifetime threshold to each `running` instance, defining how long it can execute jobs before being considered for cleanup.

## 3. Path B: Unsuccessful Provisioning (Graceful Rollback)

Taken when the overall status is `'failure'` due to insufficient capacity. This path safely rolls back partially acquired resources to ensure the system remains clean and the workflow fails quickly.

* **Core Responsibility**: Return any `claimed` but now unused instances to the resource pool.
* **Key Actions**:
    * **Release Claimed Instances**: Any instances `claimed` from the pool are reverted to an `idle` state, disassociated from the workflow's `runId`, and returned to the SQS resource pool, making them available for other workflows.
    * **Report Failure**: The overall provisioning attempt is marked as failed, surfacing a clear error to the GitHub Actions workflow.
    * *Note: Newly created instances that failed validation are assumed to be terminated by the previous phase - see [fleet validation](./creation/fleet-validation.md).*

## 4. Path C: Unhandled Error Cleanup (Aggressive Safety Net)

This is a safety net. Invoked by an unexpected error during the post-provisioning logic itself. Its goal is to aggressively clean up all potentially involved resources to prevent orphaned instances or inconsistent data.

* **Core Responsibility**: Force-terminate all involved resources to guarantee a clean state after an unexpected error.
* **Key Actions**:
    * **Force-Terminate EC2 Instances**: Issues `TerminateInstances` commands to AWS for all identified instances.
    * **Purge DynamoDB State**: Deletes or marks the corresponding DynamoDB records as `terminated`.
    * **Propagate Original Error**: The error that triggered the cleanup is re-thrown for visibility.

!!! note
    The "Successful Provisioning" path is the desired outcome. The "Unsuccessful Provisioning" path handles expected capacity shortfalls. The "Unhandled Error Cleanup" is a guardrail against unforeseen issues.

:sunny: