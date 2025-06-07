# Overview :books:

This page aims to provide a more detailed look under the hood of the action. In this section, we will look at how the controlplane is divided allowing us to dynamically provision and reuse EC2 instances easily across diffrent workflows.

In comparison to the simplfied architecture found in [Home Page](../index.md), a more complete look at the components and interactions are as follows:

![Overall Architecture](../assets/overall-architecture.png)

As covered in the [Home Page](../index.md) - there are three modes of operation for the action. These include `refresh`, `provision` and `release`. In each of these modes of operations, the instance itself has its own responsibilities  to aid the controlplane in its operations.

But before we cover each of the components in detail, we first have to cover how the controlplane sees each instance - how the "state" of each instances is represented from the purview of the controlplane. With this, we can see how the controlplane manages the lifecycle of each instance which gives it a easy ability to answer certain questions like:

- Is the instance currently running a job?
- Is it in the resource pool?
- Has an instance already been picked up by another workflow?

## Instance States

The controlplane uses an internal record of states to keep track of whether the instance is running a job, in the resource pool, etc. These include idle, claimed, running and terminated. Internally, the datastructure that allows for this looks something like this:

```json
{ "instanceId": "i-123", "state": "running" }
```

I hope these state names are intuitive enough, but to be more explicit, lets see what it means to assign each instance with this state:

- idle: an instance is idling in the resource pool, yet to be claimed
- created: an instance has been created by a workflow in preparation for running
- claimed: an instance has been claimed by a workflow to prepare for running
- running: an instance is safe to pickup a ci job
- terminated: an instance has been terminated (consistent with [aws' definition of terminated](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/terminating-instances.html))

With these states, I have made a diagram below to see how each states can transition from one to another. I made some annotations too to help out:

(TODO: Display a simple version state transition diagram)

Great! So now, that we have this diagram, let's go through the each states in more detail:

idle
:    idle is a state that is assigned to an instance once its been placed the controlplane has placed an instance to the resource pool for other workflows to pick up from. This state should only be reached after we have `released` which, from the way that we prescribe to structure a workflow, means that all jobs in that workflow has been completed.

running
:    running is a state that is assigned to an instance when its been confirmed to be ready and able to pikc up a CI job. This state is typically reached shortly after being created. Or if picked up from the resource pool, shortly after being claimed.

claimed
:    claimed is a state that is assigned to an instance once an instance has been picked up from the resource pool and is confirmed to not have been picked up by other workflows.

created
:    created is a state assigned to an instance shortly after the controlplane has confirmed with AWS of successful EC2 instantiation. The controlplane waits for this instance initialize successfully prior to being transitioned to running

terminated
:    terminated is a state that is assigned to an instance once its been confirmed to have been terminated. The controlplane employs a couple of mechanisms to reach this state.

With this in mind, we can look at the general state transitions that the controlplane uses for each of the instances. Keep in mind that these states are an internal representation of the instances at all times, not exactly how they are, but how we think that they are. With this in mind, we can look at some of the general mechanisms required for a functional controlplane.

### Imaginary Lifetime of a Single Instance

Great! Now that we have a basic understanding of the internal states that the controlplane uses to represent an instance, now we have enough mental tools to further understand the lifetime of a single instance! From creation, reuse, and termination.

**Creation**:

Say that the resource pool is empty and the workflow needs one instance. The `provision` component then talks to AWS to standup the instance gives us the instanceid that it uses to identify the VM. We then immediately register the instanceid in our database and we assign it a `created` state and with an accomanying identifier that is the workflow's `runId`. So internally, it looks something like this:

```json
{ "instanceId": "i-123", "state": "created", "runId": "456789" }
```

Then, once created, `provision` wants to assign it a `running` state as soon as possible BUT it cant until the instance emits various signals indicating proper initialization. How signals from the worker reach the controlplane from various workers at a later section, let us focus on what does that initialization look like?

!!! note "Instance Initialization"
    When stood up by AWS, the controlplane deems an instance ready to pickup ci jobs via a couple of criterias:

    - The instance has successfully executed the operator's injected `pre-runner-script`
    - The instance has successfuly registered itself on github actions as a runner with a very specific label. In our case, the workflow's `runId`. We'll see shortly why this is important.

After these two things have been completed, the instance modifies some state in the database which `provision` detects and then transitions the instance from a state of `claimed` to a state of `running`. Shortly after this, `provision` completes!

```
->created
::Receives OK signals
created->running
```

(TODO: Small diagram maybe)

**Running the CI Jobs**

Great! Now that `provision` has completed - let's have a short look at how we configure our CI jobs. Refer to the configuration defined in quickstart for more context.

```
(provision) -> (test/lint) -> (release)
```

As we can see here, the ci jobs (ie: test/lint) have a very specific parameter defined on them `runs_on: ${{ github.run_id }}`. This means that these CI jobs are only going to be run on machines which are labeled against the workflow's run id. Luckily, this is exactly what we do in our initialization! Recall above that we store the workflow's runId via `"runId"` as an attribute accompanying the instanceId.

The runner itself, being aware of its own instanceId knows which internal record to look at, and sees the accompanying runId and registers itself as a self-hosted runner with that label.

As such, we can view the workflow's run id as THE critical connection between the jobs which require execution and the compute that is able to run said jobs! With this in mind, our instance is able to execute CI Jobs as they are needed! Voila! :star:

(TODO: Small Diagram)

**Release: To the Resource Pool**:

Phew! Now that all the CI jobs have been executed to completion. As per the structure of our worfklow, we have made it so that the `release` job. The structure makes it so that once `release` is executed, we know all jobs within the workflow have concluded.

Within `release`, scan the database of instances that has that specific `runId` - then the controlplane internally undertakes the following transitions:

```json
{
  "instanceId": "i-123",
  "state": "running", // -> "idle"
  "runId": "456789"   // -> ""
}
```

By changing the value of the `runId`, instance agent sees this change and undergoes an internal deregistration routine which is just a set of steps that  prevents the instance from being able to pickup other ci jobs and allows the instance to be re-registered faster under a different `runId`. Critical if the instance is ever assigned for another workflow.

Once deregistration is successful, the worker sends a signal to the controlplane to indicate success. Then `release` registers the `instanceId` in to the resource pool. Since the resource pool is backed by SQS, it really just enqueues it. This information is packed with additional attributes like so - we'll see soon what these attributes are for:

```json
{
  "instanceId": "i-123",
  "instanceType": "c6i.large",
  "usageClass": "spot",
  "cpu": 2,
  "mmem": 4096  
}
```

As you know, these messages, when placed in SQS can be pickedup by any actor. In our case - other workflows.

(TODO: Small Diagram)

**Selection Part 1: Filtering From the Resource Pool**

Say that another workflow is executed. As we know with how we configure the workflow that it is `provision` that executes first and it is also where define the amount of resource required via `instance-count`.

To maximize resource utilization, the first task for `provision` is to look for a viable resource in the resource pool before it can even think about creating a new instance. Keeping this simple again, lets say that the workflow finds the resource we have just placed in the reosource pool. The first thing that it does is it determines if the attributes of the resource that's been picked up fit the workflow requirements (ie. must be 2CPU, is `spot` etc.).

```yaml
# MINIMAL YAML showing the parameters
with: 
  mode: provision
  usage-class: 'spot'
  allowed-instance-types: "c* m*"
  resource-class: large # (ie. 2CPU)
```

If those constraints are not satisfied, the resource is placed back to the pool for others to use, otherwise this workflow tries to claim the instance and perform final checks which leads us to the second portion of the selection routine.

**Selection Part 2: Claiming**

Great, an instance seems qualified for the workflow, `provision` then tries to put a `claim` on the instance! :star:

Remember that the act of releasing an instance assigns it a state of being `idle`. This attempt to `idle->claim` is important as this where resource contention is very much expected to occur. The resource pool is backed by standard SQS queues which only guarantees atleast-once delivery. Meaning a message in the queue can theoretically be pickedup by multiple workflows at the same time.

Furthermore, due to the distributed nature of the workflows and controlplane, it was easier for me to build the resource pooling mechanism knowing that sometimes some instance ids may be duplicated. Internally, this leverages dynamodb's conditional updates. In that, if n amount of workflows tries to claim 1 instance, only one is guaranteed to succeed in the `idle->claim` attempt.

```
idle->claimed
```

As such, for whichever instance is able to transition the state of the instance, it is guaranteed that it is only this workflow holds this instance until release :ok:.

**Selection Part 3: Final Checks**

We're nearly there! At this point we know a couple of things now: firstly the instance picked up is qualified for the workflow, and secondly no other workflow is looking at this instance for usage in their own workflow (ie. `claimed`). This final portion of selection checks if the instance is ready to be a self-hosted runner. :sweat: These checks include:

- [x] is the instance healthy?
- [x] is the instance able to register itself against the workflow successfully?

For the first check, this health goes a level deeper than just pinging the AWS API to describe the instance, the controlplane adds a heartbeat probe in each of the created instances which sends signals to the database indicating that it is still alive. The controlplane sees the recency of these signals and makes a call if it is healthy or not.

For the latter check, the transition `idle->claimed` is fairly critical as well. It looks something like this:

```json
{
  "instanceId": "i-123",
  "state": "idle", // -> "claimed"
  "runId": ""   // -> "90123546"
}
```

Basically, for the time that the instance is at the resource pool, it continually polls the database to see if it has been assigned a new `runId` that it can register itself against.

As the runId changes, while the instance is `idle`, it observes the database intently for this exact piece of information. Once it sees this runId, it essentially gets an all clear to register itself against github actions under this label :ok:. As per **creation**, we know that successful registration leads to a signal emission from the instance itself which the controlplane then sees as confirmation of that second checklist ---> thus completing the selection process for this instance!

!!! note "But what if the instance does not fulfill the checklist?"
    If any of these checks fail OR does not fulfill them in time (as selection needs to be timely) then the message is ultimately discarded from the resource pool and the instance undergoes immediate termination.

Great! At this stage, it seems this instance is ready to pickup ci jobs. To keep this simple, say that the workflow only needed one resource and it got it :check: Shortly after this the transition to `running` occurs shortly thereafter and `provision` concludes to make way for the ci jobs allowing for the instance to be reused.

```
claimed->running
```

## Instance Expirations, Thresholds, and Terminations

Now that we’ve covered how an instance is created, picks up CI jobs, is released into the resource pool, and is reclaimed, let’s examine how the control plane detects—and safely terminates—“stale” or expired instances.

### Instance Threshold Timestamp

Any time the control plane transitions an instance from one state to another, it attaches a **threshold** timestamp—a deadline indicating how long the instance should remain in its current state. For example:

```json
{
  "instanceId": "i-123",
  "state": "created",
  "runId": "90123546",
  "threshold": "2025-05-31T21:31:44.242Z"
}
```

Under this scheme, each state has a finite lifetime:

- created: If an instance never finishes initialization (e.g., the pre-runner script or GitHub Actions registration never completes), its “created” threshold will expire.
- running: If a CI job exceeds its allotted runtime (say you set max-runtime-min: 10), the instance’s “running” threshold (now + 10 minutes) will expire.
- idle: If an instance sits in the resource pool longer than expected (no new workflows claiming it), its “idle” threshold will expire.

Thresholds help the control plane spot “orphaned” or misconfigured instances:

- No workflow reuse: If a workflow never calls release (or release fails), an instance might stay in running indefinitely. Once its “running” threshold passes, it’s marked expired.
- Hung CI jobs: A job that vastly exceeds max-runtime-min also causes the “running” threshold to elapse, marking the instance as expired.
- Low CI activity: If CI traffic drops and instances linger idle in the pool, their “idle” thresholds eventually expire.

### Who Observes These Thresholds?

Thresholds only do any good if some component constantly compares them against the current time. Observation of the threshold generally happens in three places within the controlplane.

1. Any State Transitions: Whenever we change the internal represented state of an instance from state to another, it is predicated on a condition that the `threshold` indicates that the instance has not yet expired. Otherwise the state transition fails and the controlplane handles this gracefully (ie. if it picks up an instance from the resource pool that's been there for too long, the `idle->claimed` transition can also fail when the internal record says that the threshold is already at some point in the past)
2. Refresh: Recall how we configure `refresh` at start - it executes with cron as a standalone workflow. One of the jobs of running the controlplane in refresh mode is to reap any instances that have expired state-lifetimes. Essentially, it transitions these instances in to `any->terminated` with the condition that they have thresholds indicating expired. Then for any successful transitions, a termination signal to AWS is sent.
3. Self-termination: The controlplane adds an agent within the instance itself to periodically observe its own threshold. Once the fetched threshold is indicated to be in the past (ie. expired), then the instance itself sends a termination signal to AWS. So this is pretty sick, instances are able self terminate.

All these components help to safely terminate instances in a timely manner.

## Controlplane - A deeper dive in to modes of operation

Now that we have a better idea around instance states and lifetimes of an instance, I think this is a good time to look deeper in to each of the controlplane modes and subcomponents and how they work together.

## Provision

As we have covered in the lifetime of the instance, what we can see is that provision does ALOT of heavy lifting! To be able to cover this mode properly, ill have to separate it in various chunks. Ill prep a small diagram here just to cover the structure of Provision.

(TOOD: Components of Provision Diagram + Interface with resource pool & Interface with AWS)

However, as covered above, we can see that Provision has two main components, selection and creation. At a high level, the former interfaces with the resource pool, and the latter interfaces with aws to demand any resource requirements not satisfied by selection. We'll go through each one by one.

### Resource Pool and Selection

Okay, okay. So, when we first define provision, we actually have some relevant parameters which dictate how selection should behave. See in the yaml below:

```yaml
mode: provision
with:
  instance-count: 5
  usage-class: spot/on-demand
  allowed-instance-types: "c* r*"
  resource-class: "xlarge"
```

Okay, so first of all, the thing that stands out is the instance count. Essentially informing the controlplane how many runners the workflow needs. With this, the way the selection is structured, internally, the controlplane creates an equal amount of "claim-workers" each who interfaces with the resource pool via a single and shared "pickup manager". See below how this is structured.

(TODO: Diagram Resource Pool -> Pickup Manager => Claim Workers)

At first, when the pickup manager gets a request for an instance from the resource pool, it first looks if it receives any messages. If so, we quickly check the accompanying attributes to see if they have the usage-class, allowed-instance-types and the CPU and memory (as implicitly defined by the resource class config in `refresh`) compatible with the workflow's needs.

If they don't then they are placed back to the resource pool by the pickup manager, and retries again until the pool is deemed empty - and the requesting claim worker gets the indication that there's no more resources to pickup from the pool.

If the pickup manager encounters a valid message from the pool, then the pickup manager hands this to the claim worker that requested to begin with. In that case, we go in to the following section of the selection routine!

### Selection - Claiming

Great! Now that the pickup manager hands a valid instance to the claim worker, the claim worker then:

1. Attempts to claim the instance `idle->claimed` and with a new `runId`.
2. Observes states from the db if the instance is still healthy (is the heartbeat signal recent?)
3. Observes states from the db if the instance has registered against github successfully with `runId`.

As before, #1 is a guard to guarantee that the instance has not been pickedup and claimed by any other concurrent workflow.

# 2 gives us a quick observation if the instance itself has not been terminated

Claiming an instance

If the claim is unsuccessful, we know that it has been taken by another workflow or has somehow been invalidated. That's OK.

 take it to the second phase of selection.

### Selection - Part 2
