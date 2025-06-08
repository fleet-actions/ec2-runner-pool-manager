# Provision

When running a github actions workflow, `provision` is the controlplane component that is responsible for ensuring that the required resources for a workflow is available prior to running ci jobs. This page covers the major sub-components of provision which makes this possible.

## Selection

Selection is a sub-component of `provision` that is designed to pickup and reuse any idle instances from the resource pool. This section covers what makes up selection in order to ensure that the instances are picked up, claimed and validated in a timely manner.

### Resource Pool <---> Pickup Manager <---> Claim Workers

Within selection, the bit that interfaces with the resource pool is the pickup manager. A bunch of claim workers receives instances to inspect from this pickup manager which then are used to facilitate the actual claiming and checking of health and registration. The claim workers work in parallel to ensure that selection is done in a timely manner (we want to know as soon as possible if the resourcepool can or cannot fulfill the workflow's requirements). The amount of claim workers defined to be equal to the amount of resources `provision` requires (ie. `instance-count` parameter).

To better see this interation, see below:

```mermaid
flowchart LR
    RP["Resource Pools"] <--> PM[Pickup Manager]
    PM --> CW1[Claim Worker 1]
    PM --> CW2[Claim Worker 2]
    PM --> CW3[Claim Worker 3]
```

### Resource Pool <---> Pickup Manager

Lets look at the resource pool to Pickup manager interface. When a claim worker requests a resource, the pickup manager interfaces directly with SQS. It gets the message from SQS which generally looks something like this (note that the message is immediately deleted from SQS to reduce resource contention):

```json
{
  "instanceId": "i-123456",
  "usageClass": "on-demand",
  "instanceType": "c6i.large",
  "cpu": 2,
  "mmem": 4096
}
```

There are two actions that the pickup manager can do once a message has been picked up from the pools - Requeue the message or Pass on to Claim Workers. Lets look at each in detail:

- Requeue to Pool: Given the message above. Imagine that your provision configuration is something like this:

    ```yaml
    with:
      mode: provision
      allowed-instance-types: "m* r*" # <--- not c*
    ```

    What we can see is that the instance is not valid for the workflow due to the mismatch in instance types. As such, the message is simply requeued or put back to the resource pool for others to inspect. Keep in mind that this is the same for when we define other attributes like the usage-class and the resource-class.

- Passed to Claim Worker: Say that the message fits the constraints of the provision, then the pickup manager simply passes the message to the requesting claim worker!

### Problem: How can the Pickup Manager know the Resource Pool is "Exhausted"

**Single Invalid Message**

Now theres a problem here. Imagine this scenario - you have one workflow that needs a very specific instance type. Say `r6*`. But the resource in the pool has a type `c6i.large`. As before, the PM picks this up, inspects it, and requeues it - then the PM re-inspects the queue again and gets the same instance! We're stuck in a loop!

So to solve this problem, the PM singleton has an internal criteria of evaluating if a queue is exhausted. What it does it that it keeps tabs of how many times it has encountered a specific id. If it has encountered it a handle of times (about 5 times), then it consideres the queue as "exhausted" - and returns a `null` to any requesting claim worker - indicating pool exhaustion.

**Many Invalid Messages**

BUT ... we still have a problem here. Imagine again that we have MANY `"c*"` instances in the pool BUT the workflow is picky (still needs a specific `r6*` instance)! As per our overview of [resource pool](../todo.md), the designed partitioning does not help here, so what will happen?

Well, the PM will have to cycle through the resource pool a few times to recognize that it has been exhausted. In this worst case scenario, the time for selection grows in proportion to the amount of invalid messages in the queue.

Thankfully, from my testing, the PM is able to go through ~50 SQS messages per second, so I dont think this could be too much of an issue until you're running 100s of machines with really diverse and specific needs for CI.

### Post Claim Checks

## Creation

Component responsible for creating the required resources unfulfilled by selection.

### Fleet Creation

### Fleet Validation & Interactions

## Post-Provision

The **Post-Provision** component is responsible for gracefully handling successful/unsuccessful provisioning in addition to a routine which dumps any provisioned resources when if something unexpected happens.

### Successful Provisioning

### Unsuccessful Provisioning

### Something went wrong: Dumping Resources
