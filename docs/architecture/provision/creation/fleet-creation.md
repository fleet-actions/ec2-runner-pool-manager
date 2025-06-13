# Fleet Creation

## AWS API Used — `CreateFleet (type =instant)`

Provision issues a single [`CreateFleet` call with Type=instant](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-ec2-fleet.html), which tells AWS to indicate to us if at this moment in time, there's enough in their capacity pools to fulfill our request or or fail fast. This keeps the controlplane responsive.

??? note "Simplified Create Fleet Call Input"
    Say 3 on-demand instances
    ```json
    {
      "Type": "instant",
      "TargetCapacitySpecification": {
        "TotalTargetCapacity": 3,
        "DefaultTargetCapacityType": "on-demand",
        "OnDemandTargetCapacity": 3
      },
      "LaunchTemplateConfigs": [ … ],
    }
    ```

If AWS cannot fulfil every requested instance (e.g., InsufficientInstaceCapacity), Provision aborts the fleet, cleans up any partial capacity, and surfaces an error back to the workflow. We also clean up the partial capacity by sending TerminateInstances just in case.

## Attribute-Based Instance Type Selection

Instead of hard-coding instance types, the fleet uses attribute-based filters so AWS can pick any instance family that satisfies the request, dramatically improving hit rates in constrained regions.

??? note "Distilled example of the Launch Template overrides within Provision"
    ```json
    "LaunchTemplateConfigs": [
      {
        "LaunchTemplateSpecification": { "LaunchTemplateId": "lt-abc123", "Version": "$Default" },
        "Overrides": [
          {
            "InstanceRequirements": {
              "VCpuCount":   { "Min": 4, "Max": 4 },
              "MemoryMiB":   { "Min": 4096 },
              "IncludedInstanceTypes": ["c*", "m*"],
            },
            "SubnetId": "subnet-aaa…",
          }
        ]
      }
    ]
    ```
    How this maps to the Provision interface:

    | Workflow Input | Fleet Mapping  |
    ||----|
    | `allowed-instance-types: "c* m*"` | `IncludedInstanceTypes` mapped directly |
    | `resource-class: large`    | Populates `VCpuCount` & `MemoryMiB` ranges |

## Why attribute-based matters

- Maximises success probability: any size-compatible c* family (e.g., c6i, c7g) can be chosen.
- Reduces operator toil: no need to update docs every time AWS launches a new generation.
- Access to Multi-AZ Capacity Pools: Provision populates one override per subnet, so the fleet can pull capacity from whichever AZ still has it.

Once AWS returns the instance IDs, each new runner is inserted into DynamoDB like so:

```json
{
  "instanceId": "i-0abc12345",
  "state": "created",
  "runId": "run-7890",
  "threshold": "2025-05-31T12:00:00Z"
}
```

From here, the Instance Initialization & Fleet Validation logic (described in the next subsection) takes over, ensuring every newly created runner is healthy, registered, and transitioned to running.

## Handling Insufficient Capacity

If **any** part of the request fails (including partial fulfilment):

1. Provision logs the `CreateFleet` error.  
2. Immediately issues a single `TerminateInstances` for every ID returned.  
3. Surfaces a clear failed error to the workflow.

:sunny:
