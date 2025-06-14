# Resource Pool

The Resource Pool is a critical component responsible for holding information about idle EC2 runner instances that are ready for reuse by CI workflows. This mechanism is key to providing "warm" runners, reducing the latency associated with provisioning new instances from scratch.

## Implementation

The Resource Pool is implemented as a collection of SQS queues. Each distinct "runner class" (ie. based on cpu and memory) is partitioned to have its own dedicated SQS queue. This segregation ensures that workflows can request and receive instances that match their specific hardware requirements quickly.

The definition and management of these SQS queues, including their creation and association with specific resource classes, are handled within [refresh](./refresh.md)

## Interaction with the Pool

!!! note "Graph for Release and Reuse via Resource Pool"
    ```mermaid
    graph LR
        subgraph Previous Workflow
            A[Running Instance <br> state: running]
        end

        subgraph Resource Pool
            B(SQS Resource Pool <br> idle runners)
        end

        subgraph Next Workflow
            C[Claimed Instance <br> state: claimed]
        end

        A -- "Release Process" --> B;
        B -- "Provision Process <br> (Pickup Manager)" --> C;
    ```

### Producers (Adding Instances to the Pool)

When an EC2 runner instance completes its assigned CI jobs and is successfully processed by the [**Release** mechanism](./release.md), a message representing this now-idle instance is sent to the SQS queue corresponding to its resource class.

### Consumers (Retrieving Instances from the Pool)

The primary consumer of the Resource Pool is the **Pickup Manager**, which operates during the **Provision** mode. The Pickup Manager dequeues messages, filters them, and passes suitable candidates to a requesting [Claim Worker](./provision/selection/claim-workers.md). (For more details, see [Pickup Manager](./provision/selection/pickup-manager.md)).

## SQS Message Format

When an instance is added to a resource pool queue, the SQS message payload contains details about the instance necessary for the Pickup Manager to evaluate its suitability for a workflow.

**Example Distilled Payload:**

```json
{
  "id": "i-123",
  "resourceClass": "large",
  "instanceType": "c6i.large",
  "cpu": 2,
  "mmem": 4096,
  "usageClass": "on-demand"
}
```

**Field Descriptions:**

| Field | Type | Purpose & Notes  |
| :-- | :-- | :-- |
| `id`  | string | The EC2 Instance ID. Primary key for subsequent DynamoDB lookups by the Claim Worker.  |
| `resourceClass` | string | The specific resource class this instance belongs to (e.g., "medium-linux"). Ensures the instance is in the correct pool.  |
| `instanceType`  | string | The concrete EC2 instance type (e.g., "c6i.large"). Used for matching against workflow requirements.  |
| `cpu`/`mmem` | number | The number of vCPUs and minimum memory (in MiB) of the instance    |
| `usageClass`| enum (`spot`\|`on-demand`) | Indicates if the instance is Spot or On-Demand. Must match the `usageClass` requested by the workflow. |

:sunny: