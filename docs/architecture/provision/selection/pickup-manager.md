# Pickup Manager

The Pickup Manager (PM) is an in-process component instantiated per workflow selection attempt. It is responsible for retrieving and filtering idle instance messages from the SQS-based [Resource Pool](../../resource-pool.md) to find suitable warm runners for the requestors ([Claim Workers](./claim-workers.md)) to fulfill the current workflow's requirements.

The Pickup Manager's core responsibilities are:

1. **Dequeueing Candidate Messages**: Retrieving messages from the relevant SQS resource pool queue.
2. **Filtering**: Evaluating the dequeued message (whose format is detailed in the [Resource Pool documentation](../../resource-pool.md)) against the requesting workflow’s specific compute requirements (e.g., instance type, usage class, CPU, memory).
3. **Dispatching or Re-queuing**:
    * ✅ If a message represents a suitable instance, it's passed to a Claim Worker for an attempt to claim the instance.
    * ♻️ If unsuitable for the current request, the message is returned to the SQS queue for other workflows.
    * ❌ If the message represents an invalid or malformed entry, it may be discarded.

!!! note "Sequence Diagram: Valid Message"
    ```mermaid
    sequenceDiagram
        participant ClaimWorker
        participant PM as "Pickup Manager"
        participant SQS_Pool as "Resource Pool (SQS)"

        Note over PM: Intitialized with workflow's compute requirements <br>(resource class, usage class, etc.)
        Note over PM, SQS_Pool: Reference a specific queue from pool. <br> Dedicated queue per resource class
        ClaimWorker->>+PM: Request Instance
        
        %% Start of the conceptual "loop" for a single successful attempt
        PM->>+SQS_Pool: Dequeue Message
        SQS_Pool-->>-PM: instance_message_data (with instance_id)
        
        PM->>PM: Check Pickup Frequency (for instance_id)
        %% Happy Path: Frequency is OK
                
        PM->>PM: Compare instance_message_data.payload vs compute requirements
        %% Happy Path: Message is OK (Suitable)
                    
        PM-->>-ClaimWorker: Return InstanceMessage <br> (instance_message_data.payload)
        Note over ClaimWorker: Begin Claiming routine <br> Will re-request from pool if needed
    ```

## 1. Interfacing with SQS: The Pickup Lifecycle

The Pickup Manager interacts with SQS in a tight loop designed for low latency and efficient message handling. This process involves several conceptual SQS operations:

| Action by Pickup Manager | Conceptual SQS Operation | Purpose & Notes|
| :--| :-| :--|
| 1 Request a message from the resource class-specific SQS queue. | `ReceiveMessage`| A short poll used for discovering available idle runners. |
| 2 Delete the message from SQS. | `DeleteMessage` | As soon as received, delete the message from the queue to minimize contention by multiple concurrent Provision processes or workers |
| 3 Filter the message content in-memory.| N/A (Local operation) | The contents of message checked against the workflow’s provision inputs (e.g., `allowedInstanceTypes`, `usageClass`, etc.) |
| 4a :white_check_mark: **Pass-On (Match Found)**| N/A (Dispatch to Claim Worker) | If check is OK - PM hands to requesting [Claim Worker](./claim-workers.md) |
| 4b :recycle: **Re-queue (Filter Mismatch)** | `SendMessage`| If mismatching *current* workflow's compute constraints - message is requeued with a [short delay](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-delay-queues.html) to minimize contention |
| 4c :x: **Discard (Invalid/Malformed Message)** | N/A (Already deleted) | Something is wrong with the message (ie. parsing, unexpected attributes), it is discarded |

## 2. Message Handling and Classification Logic

The Pickup Manager evaluates each message using these decision paths:

* **OK (Pass-On)** ✅ When:
    * Message has valid `resourceClass`, matching CPU/memory specifications
    * Instance type matches workflow's allowed patterns
    * Usage class (spot/on-demand) matches workflow's requirement
    * **Action**: Forward to Claim Worker for instance claiming

* **Re-queue** ♻️ When:
    * Message is valid but doesn't match current workflow's specific needs
    * **Action**: Return to queue for other workflows that might need it

* **Discard** ❌ When:
    * Message contains invalid/inconsistent data (wrong resource class, insufficient CPU/memory)
    * **Action**: Drop the message (already deleted from SQS)

## 3. Pool Exhaustion Detection

The Pickup Manager can determine that a resource pool is "exhausted" for the current workflow's request through two main heuristics:

* **Globally Exhausted (Queue Empty)**:
    * If an attempt to receive a message from the SQS queue indicates that the queue for the target `resourceClass` is currently empty.
    * **Outcome**: The Pickup Manager signals to the Provision orchestrator that no idle instances are available in this pool at this moment.

!!! note "Sequence Diagram: Global Exhaustion"
    ```mermaid
    sequenceDiagram
        participant ClaimWorker
        participant PM as "Pickup Manager"
        participant SQS_Pool as "SQS Resource Pool"

        ClaimWorker->>+PM: Attempt Pickup (workflow_requirements)
    
        PM->>+SQS_Pool: Request Message
        SQS_Pool-->>-PM: No message 🤷
                    
        PM-->>-ClaimWorker: Return Null (Locally Exhausted for this workflow)
    ```

* **Locally Exhausted (Repetitive Unsuitable Messages)**:
    * To prevent an infinite loop where the Pickup Manager continuously picks, re-queues, and re-picks the same set of messages that are unsuitable for the *current* workflow's specific constraints, it maintains an internal frequency count for each unique `instanceId` it encounters during its current operational cycle.
    * If the same `instanceId` is dequeued more than a defined tolerance threshold (e.g., 5 times) within the context of a single pickup attempt for a workflow, the Pickup Manager considers the pool locally exhausted *for the current request*.
    * **Outcome**: The message that triggered this tolerance is still re-queued (so it remains available for other, potentially different, workflow requests). However, the Pickup Manager signals `null` for *this specific pickup attempt*, effectively suspending pickups for this workflow from this pool to avoid unproductive cycling on the same set of unsuitable instances.

!!! note "Sequence Diagram: Local Exhaustion"
    ```mermaid
    sequenceDiagram
        participant ClaimWorker
        participant PM as "Pickup Manager"
        participant SQS_Pool as "Resource Pool (SQS)"

        ClaimWorker->>+PM: Request Instance
        
        Note over PM: Initialize frequency counter for instances

        rect rgb(240, 240, 240)
            Note right of PM: Loop: First instance pickup attempt
            PM-->SQS_Pool: Dequeue instance_A Message
            
            Note over PM: Register instance_A (freq=1)<br>But unsuitable
            PM-->SQS_Pool: Re-queue instance_A
            
        end

        Note over PM: Additional cycles (truncated)

        rect rgb(240, 240, 240)
            Note right of PM: Loop: Later pickup attempts <br> imagine only instance_A is in Pool
            PM-->SQS_Pool: Dequeue instance_A Message (again)
            
            Note over PM: Register instance_A (freq=n)<br>Still unsuitable
            Note over PM: Frequency exceeds tolerance
            PM-->SQS_Pool: Re-queue instance_A
        end

        PM-->>-ClaimWorker: Return Null (Locally Exhausted)
        Note over ClaimWorker: Claim worker informs <br>controlplane of exhaustion
    ```

---

:sunny:
