# Post-Provision: Finalizing and Committing Resources

The Post-Provision phase serves as the crucial concluding stage of the Provision operation. It acts upon the combined outcomes of the **Instance Selection** phase (which attempts to reuse idle runners from the pool) and the **Instance Creation** phase (which attempts to launch new EC2 runners). The primary goal of Post-Provision is to definitively determine if the requested compute capacity has been successfully acquired and validated, and then to take appropriate actions to either commit these resources to the workflow or to gracefully roll back the operation.

This phase is orchestrated by the main post-provisioning logic (`src/provision/post-provision/index.ts`).

## 1. Overall State Reconciliation

Before committing any resources or initiating rollbacks, a reconciliation step occurs. This step evaluates the results from both the selection and creation efforts to make a unified decision on the overall success of the provisioning attempt.

* **Core Responsibility**: To determine if the full complement of healthy, requested runners is available for the workflow.
* **Evaluation Criteria**:
  * **Creation Success**: All new instances requested from the Instance Creation phase must have been successfully launched and passed their initial health and registration validations (as reported by the Creation phase itself).
  * **Sufficient Capacity**: The total number of instances—combining those successfully selected and validated from the pool with those successfully created and validated—must meet the original demand of the workflow. Any shortfall means the overall provisioning goal was not met.
* **Outcome**: This reconciliation yields a simple binary status: overall `'success'` or overall `'failure'`. This status dictates the control flow into one of the distinct processing paths described below.

## 2. Path 1: Successful Provisioning

This path is executed if the reconciliation step determines an overall `'success'`, meaning all requested runners are healthy, registered, and ready.

* **Core Responsibility**: To formally transition all successfully acquired runners (both selected and newly created) into an operational `running` state and make them available to the workflow.
* **Key Actions**:
    * **Finalize Runner State**: Instances that were successfully selected from the pool (and were in a `claimed` state) and instances that were newly created (and were in a `created` state after passing their initial validations) have their status updated to `running` in the central DynamoDB store.
    * **Set Operational Lifetime**: Each of these `running` instances is assigned a new operational lifetime threshold. This threshold defines how long the instance can execute jobs before the `Refresh` process considers it for cleanup, ensuring instances don't run indefinitely.
    * **Confirm Workflow Association**: The instances are already correctly associated with the requesting workflow's unique `runId` (this was handled during their claim or initial registration). This step solidifies this association with the now `running` state.
    * **Output Runner Identifiers**: The unique EC2 Instance IDs of all these `running` runners are collected and made available as an output. This allows the workflow dispatch mechanism to specifically target these validated instances for executing CI jobs.

This success path is designed to be efficient, primarily involving updates to the central state store to reflect the new operational status of the runners.

## 3. Path 2: Unsuccessful Provisioning (Graceful Rollback)

This path is taken if the reconciliation step determines an overall `'failure'`, indicating that the system could not secure the full requested number of healthy runners.

* **Core Responsibility**: To safely roll back any resources that were partially acquired (specifically, instances selected from the pool and `claimed`) but cannot be used due to the overall provisioning failure. The goal is to return these instances to the pool for other workflows and ensure the current workflow fails cleanly.
* **Key Actions**:
    * **Release Selected Instances**: Any instances that were successfully selected from the pool and put into a `claimed` state specifically for this workflow are:
        * Reverted to an `idle` state in the DynamoDB store.
        * Disassociated from the current workflow's `runId`.
        * Assigned a new `idle` lifetime threshold.
        * Returned to the SQS resource pool via a new message, making them immediately available for other incoming workflow requests.
    * **Handle Newly Created Instances**: Instances that were part of the *creation* attempt but failed their initial validation (as determined by the Instance Creation phase itself) are assumed to have already been terminated by that earlier phase. No additional cleanup action for these newly created (but failed) instances is typically needed in this specific rollback path.
    * **Report Failure to Workflow**: The overall provisioning attempt for the workflow is definitively marked as failed, and a clear error message is surfaced to the GitHub Actions environment. This ensures the workflow fails quickly and informs the operator about the capacity shortfall, rather than hanging or attempting to run with insufficient resources.

This ensures system stability by preventing `claimed` instances from becoming orphaned and makes resources available for reuse promptly.

## 4. Path 3: Unhandled Error Cleanup (Aggressive Safety Net)

This is a critical safety mechanism invoked if an unexpected or unhandled error occurs during the main post-provisioning logic (i.e., not a predictable failure handled by the "Unsuccessful Provisioning" path).

* **Core Responsibility**: To aggressively clean up *all* resources potentially involved in the current provisioning attempt, regardless of their state, to prevent any orphaned EC2 instances or inconsistent records in DynamoDB. This is a "last resort" to maintain system integrity and control costs.
* **Key Actions**:
    * **Identify All Involved Instances**: Gathers the IDs of all instances that were either successfully selected from the pool or were part of the new creation attempt for the current workflow.
    * **Aggressive EC2 Termination**: Issues `TerminateInstances` commands to AWS EC2 for all identified instances.
    * **State Purging in DynamoDB**: Attempts to delete the DynamoDB records for these instances or definitively mark them as `terminated`. For instances that were *selected* from the pool, this cleanup in DynamoDB might involve an isolation check (e.g., ensuring the `runId` still matches the current workflow) to minimize the risk of inadvertently affecting an instance that might have been *extremely* quickly released and re-assigned to a concurrent workflow (a rare but considered edge case).
    * **Propagate Original Error**: The original unhandled error that triggered this aggressive cleanup is re-thrown. This ensures the workflow fails with a clear indication of the root cause of the unexpected issue, aiding in diagnostics.

!!! note
    The "Successful Provisioning" path is the desired and most frequent outcome. The "Unsuccessful Provisioning" path handles expected operational scenarios like temporary resource unavailability. The "Unhandled Error Cleanup" is a vital guardrail against unforeseen issues, prioritizing resource safety and system stability above all else for that specific failed operation.
