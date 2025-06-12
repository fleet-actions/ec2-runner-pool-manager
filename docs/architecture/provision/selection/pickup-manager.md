# Pickup Manager

The Pickup Manager (PM) is an in-process component within the control-plane's Provision mode. It is instantiated per workflow selection attempt and is responsible for efficiently retrieving and filtering idle instance messages from the SQS-based [Resource Pool](../../resource-pool.md) to find suitable warm runners for the current workflow's requirements.

The Pickup Manager's core responsibilities are:

1. **Dequeueing Candidate Messages**: Retrieving messages from the relevant SQS resource pool queue.
2. **Filtering**: Evaluating the dequeued message (whose format is detailed in the [Resource Pool documentation](../../resource-pool.md)) against the requesting workflow’s specific compute requirements (e.g., instance type, usage class, CPU, memory).
3. **Dispatching or Re-queuing**:
    * If a message represents a suitable instance, it's passed to a Claim Worker for an attempt to claim the instance.
    * If unsuitable for the current request, the message is returned to the SQS queue for other workflows.
    * If the message represents an invalid or malformed entry, it may be discarded.

!!! note "[DRAFT] Happy Path Sequence Diagram"
    ```mermaid
    sequenceDiagram
        participant Orchestrator as "Provision Orchestrator"
        participant PM as "Pickup Manager"
        participant SQS_Pool as "SQS Resource Pool"

        Orchestrator->>+PM: Attempt Pickup (workflow_requirements)
        PM->>PM: Initialize
        
        %% Start of the conceptual "loop" for a single successful attempt
        PM->>+SQS_Pool: Request Message (for target_resource_class)
        SQS_Pool-->>-PM: instance_message_data (with instance_id)
        
        PM->>+SQS_Pool: Delete Message (instance_message_data.receipt_handle)
        SQS_Pool-->>-PM: Delete Confirmed
                
        PM->>PM: Check Pickup Frequency (for instance_id)
        %% Happy Path: Frequency is OK
                
        PM->>PM: Classify Message (instance_message_data.payload vs workflow_requirements)
        %% Happy Path: Message is OK (Suitable)
                    
        PM-->>-Orchestrator: Return InstanceMessage (instance_message_data.payload)
        %% End of the conceptual "loop" for a single successful attempt
        
    ```

!!! note "[DRAFT] Un Happy Path Sequence Diagram"
    ```mermaid
    sequenceDiagram
        participant Orchestrator as "Provision Orchestrator"
        participant PM as "Pickup Manager"
        participant SQS_Pool as "SQS Resource Pool"

        Orchestrator->>+PM: Attempt Pickup (workflow_requirements)
        PM->>PM: Initialize (e.g., reset internal frequency counts)
        
        %% Simulating a few attempts leading to local exhaustion
        %% Attempt 1 (or N) - Message received, frequency incremented, but eventually tolerance is hit
        PM->>+SQS_Pool: Request Message (for target_resource_class)
        SQS_Pool-->>-PM: instance_message_data_X (with instance_id_A)
        
        PM->>+SQS_Pool: Delete Message (instance_message_data_X.receipt_handle)
        SQS_Pool-->>-PM: Delete Confirmed
                
        PM->>PM: Check Pickup Frequency (for instance_id_A)
        %% Assume frequency for instance_id_A is now at tolerance limit
        Note over PM: Frequency for instance_id_A has reached tolerance!

        PM->>PM: Classify Message (instance_message_data_X.payload vs workflow_requirements)
        %% Even if message itself is OK or Mismatch, frequency takes precedence for local exhaustion

        PM->>+SQS_Pool: Re-queue Message (instance_message_data_X.payload)
        SQS_Pool-->>-PM: Re-queue Confirmed
                    
        PM-->>-Orchestrator: Return Null (Locally Exhausted for this workflow)
    ```

## 1. Interfacing with SQS: The Pickup Lifecycle

The Pickup Manager interacts with SQS in a tight loop designed for low latency and efficient message handling. This process involves several conceptual SQS operations:

| Step | Action by Pickup Manager                      | Conceptual SQS Operation                                     | Purpose & Notes                                                                                                                                                                                             |
| :--- | :-------------------------------------------- | :----------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Request a message from the specific SQS queue. | `ReceiveMessage`                                             | A short poll is typically used to minimize latency in discovering available idle runners.                                                                                                                   |
| 2    | Delete the message from SQS.                   | `DeleteMessage`                                              | The message is deleted from the SQS queue **immediately after successful receipt and basic validation (e.g., presence of a body and receipt handle)**, but *before* full content parsing or filtering. This minimizes contention for the same message by multiple concurrent Provision processes or workers. The message effectively lives only in the Pickup Manager's memory for the filtering stage. |
| 3    | Filter the message content in-memory.         | N/A (Local operation)                                        | The deserialized message is checked against the workflow’s provision inputs (e.g., `allowedInstanceTypes`, `usageClass`, required CPU/memory). No network round-trips occur during this filtering. |
| 4a   | **Pass-On (Match Found)**                     | N/A (Dispatch to Claim Worker)                               | If the message's attributes match the workflow's requirements, the `InstanceMessage` object is handed to a waiting Claim Worker. The Claim Worker will then attempt to atomically transition the instance's state in DynamoDB from `idle` to `claimed`. |
| 4b   | **Re-queue (Filter Mismatch)**                | `SendMessage`                                                | If the message does not match the *current* workflow's constraints (e.g., wrong instance type for this job, but potentially suitable for another), it is sent back to the same SQS queue. A short `DelaySeconds` can be applied to this `SendMessage` operation (an SQS feature) to prevent the Pickup Manager from immediately re-picking and re-evaluating the same unsuitable message in a tight loop for the *same* workflow request. |
| 4c   | **Discard (Invalid/Malformed Message)**       | N/A (Already deleted)                                        | If the message is found to be fundamentally invalid during parsing or pre-filter checks (e.g., wrong resource class for the queue it was in, insufficient CPU/memory compared to its own class definition), it is discarded. Since it was already deleted from SQS in Step 2, no further action is needed on the queue. |

## 2. Message Handling and Classification Logic

A core piece of logic within the Pickup Manager determines the fate of each dequeued message based on its content and the current workflow's requirements:

* **OK (Pass-On)**: This outcome occurs if all the following conditions are met:
    1. The message's `resourceClass` is valid and matches the target pool.
    2. Its `cpu` and `mmem` (memory) attributes meet the specifications defined for its `resourceClass`.
    3. Its `instanceType` matches the workflow's `allowedInstanceTypes` (which can include wildcard patterns).
    4. Its `usageClass` (e.g., `on-demand` or `spot`) matches the workflow's requested `usageClass`.
    5. **Action**: The Pickup Manager identifies this `InstanceMessage` as suitable. It is then passed to the Provision orchestrator, which dispatches it to a Claim Worker to attempt the actual claiming of the instance.

* **Re-queue (Filter Mismatch for Current Workflow)**: This outcome is chosen if:
    1. The message represents a valid, healthy instance (e.g., correct `resourceClass`, `cpu`, `mmem` for its type).
    2. However, it does not meet the *specific* criteria of the *current* workflow (e.g., the `instanceType` is not in the `allowedInstanceTypes` for this particular job, or there's a `usageClass` mismatch).
    3. **Action**: The Pickup Manager sends the exact message payload back to its original SQS queue. This makes the instance available for other workflows that might have different constraints and for which this instance could be a perfect match.

* **Delete (Discard Invalid Message)**: An instance message is effectively discarded if:
    1. The message is found to be malformed, contains inconsistent data (e.g., the `resourceClass` listed in the message doesn't align with the queue it was pulled from), or describes an instance with `cpu`/`mmem` attributes that are fundamentally incorrect for its stated `resourceClass`.
    2. **Action**: The problematic message is logged. Since it was already deleted from SQS during the initial dequeue step (Step 2 in the lifecycle table), no further action is needed on the queue itself. The Pickup Manager then moves on to attempt picking another message.

## 3. Pool Exhaustion Detection

The Pickup Manager can determine that a resource pool is "exhausted" for the current workflow's request through two main heuristics:

* **Globally Exhausted (Queue Empty)**:
  * If an attempt to receive a message from the SQS queue indicates that the queue for the target `resourceClass` is currently empty.
  * **Outcome**: The Pickup Manager signals to the Provision orchestrator that no idle instances are available in this pool at this moment.

* **Locally Exhausted (Repetitive Unsuitable Messages)**:
  * To prevent an infinite loop where the Pickup Manager continuously picks, re-queues, and re-picks the same set of messages that are unsuitable for the *current* workflow's specific constraints, it maintains an internal frequency count for each unique `instanceId` it encounters during its current operational cycle.
  * If the same `instanceId` is dequeued more than a defined tolerance threshold (e.g., 5 times) within the context of a single pickup attempt for a workflow, the Pickup Manager considers the pool locally exhausted *for the current request*.
  * **Outcome**: The message that triggered this tolerance is still re-queued (so it remains available for other, potentially different, workflow requests). However, the Pickup Manager signals `null` for *this specific pickup attempt*, effectively suspending pickups for this workflow from this pool to avoid unproductive cycling on the same set of unsuitable instances.

---

This SQS-based resource pool and the described Pickup Manager logic allow the Provision mode to efficiently scan for and reuse warm, idle runner instances. It prioritizes reuse by quickly filtering available instances, only falling back to provisioning fresh EC2 capacity when the pool is genuinely exhausted or no suitable candidates can be found.
