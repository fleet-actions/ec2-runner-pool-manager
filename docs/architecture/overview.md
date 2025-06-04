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

The controlplane uses an internal record of states to keep track of whether the instance is running a job, in the resource pool, etc. These include idle, claimed, running and terminated. I hope these state names are intuitive enough, but to be more explicit, lets see what it means to assign each instance with this state:

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

Say that the resource pool is empty and the workflow needs one instance. The `provision` component then talks to AWS to standup the instance gives us the instanceid that it uses to identify the VM. We then immediately register the instanceid in our database and we assign it a `created` state and with an accomanying identifier that is the workflow's `runId`.

Then, once created, `provision` wants to assign it a `running` state as soon as possible BUT it cant until the instance emits various signals indicating proper initialization. What does that initialization look like? Let's look at that quickly.

Callout::Instance Initialization
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
# MINIMAL YAML configuration
# ...
```

As we can see here, the ci jobs (ie: test/lint) have a very specific parameter defined on them `runs_on: ${{ github.run_id }}`. This means that these CI jobs are only going to be run on machines which are labeled against the workflow's run id. Luckily, this is exactly what we do in our initialization!

As such, we can view the workflow's run id as THE critical connection between the jobs which require execution and the compute that is able to run said jobs! With this in mind, our instance is able to execute CI Jobs as they are needed! Voila! :star:

(TODO: Small Diagram)

**Release**:

Phew! Now that all the CI jobs have been executed to completion - remember again how we have structured our ci.yml file. We have made it so that the `release` job only exectutes after all jobs within the workflow have concluded. So, by executing the `release` within that workflow, the controlplane is able to determine which instances are registered against THAT run id. Then the controlplane, sends a signal to the database that this specific instance is ready for deregistration.

From the perspective of the `release` component of the controlplane, it wants to transition `running` instances to `idle` as quickly as possible.

Callout::Instance Deregistration
As we recall above, shortly after creation, the instance registers itself against github under the label of the workflow's run id. That is until, by proxy of the database, it gets an indication that it is safe to deregister (signal sent by the controlplane to the database). As such, it undergoes deregistration which is an internal routine that prompts the instance to deregister itself from github actions. Once this is successful, it sends a signal to the database which the controlplane is able to observe :ok:

Once `release` has gotten an indication of successful deregistration, it transitions the instance' state from `running` to `idle` with an empty runId. Then places the instance id in addition to some metadata to the resource pool for other workflows to pick this instance up

```
running->idle
```

(TODO: Small Diagram)

**Selection and Reuse**

Say that shortly after the instanceid has been placed in the resource pool, another workflow is able to see this instance id. Now selection has a few components to it so lets try to through it one by one.

Once the instanceid is picked up, firstly - `provision` observes if the instance is fit for the workflow according to various constraints. As per [advanced configuation](), these criteria are determined by the usage-class, allowed-instance-type. Thankfully, the resourcepool is already partioned by resource-class, so we dont have to filter by that.

```
# MINIMAL YAML showing the parameters
```

Nevertheless, if the accompanying metadata of the instance id does not fulfill the workflow's defined criteria on `provision`, then the message is requeued for other workflows to pickup :ok: - that's completely fine. However, if the pickedup instance satisfies all the constraints, then the filtering phase of selection is all good and `provision` attempts to put a `claim` on the instance.
