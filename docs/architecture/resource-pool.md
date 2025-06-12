# Resource Pool

The Resource Pool is a central component responsible for holding idle EC2 runner instances that are ready for reuse by incoming CI workflows. This mechanism is key to providing "warm" runners, reducing the latency associated with provisioning new instances from scratch.

## Implementation

The Resource Pool is implemented as a collection of Amazon SQS (Simple Queue Service) queues. Each distinct "runner class" (e.g., based on operating system, available software, or instance size) has its own dedicated SQS queue. This segregation ensures that workflows can request and receive instances that match their specific environmental and hardware requirements.

The definition and management of these SQS queues, including their creation and association with specific resource classes, are handled as part of the system's configuration and refresh mechanisms.

## Interaction with the Pool

### Producers (Adding Instances to the Pool)

When an EC2 runner instance completes its assigned CI jobs and is successfully processed by the **Release** mechanism, a message representing this now-idle instance is sent to the SQS queue corresponding to its resource class.

### Consumers (Retrieving Instances from the Pool)

The primary consumer of the Resource Pool is the **Pickup Manager**, which operates during the **Provision** mode. It attempts to find a suitable warm runner from the pool before resorting to creating a new EC2 instance. The Pickup Manager dequeues messages, filters them, and passes suitable candidates to a Claim Worker. (For more details, see [Pickup Manager](./provision/selection/resource-pool-and-pickup-manager.md)).

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

| Field           | Type                     | Purpose & Notes                                                                                                                              |
| :-------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | string                   | The EC2 Instance ID. Primary key for subsequent DynamoDB lookups by the Claim Worker.                                                        |
| `resourceClass` | string                   | The specific resource class this instance belongs to (e.g., "medium-linux"). Ensures the instance is in the correct pool.                      |
| `instanceType`  | string                   | The concrete EC2 instance type (e.g., "c6i.large"). Used for matching against workflow requirements.                                          |
| `cpu`           | number                   | The number of vCPUs of the instance.                                                                                                       |
| `mmem`          | number                   | The memory (in MiB) of the instance.                                                                                                         |
| `usageClass`    | enum (`spot`\|`on-demand`) | Indicates if the instance is Spot or On-Demand. Must match the `usageClass` requested by the workflow.                                       |

The Pickup Manager deletes messages from the SQS queue immediately after successful receipt and basic validation to minimize contention if multiple Provision processes are looking for runners simultaneously.
