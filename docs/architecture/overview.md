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

Great! Now that we have a basic understanding of the internal states that the controlplane uses, ill take you on a journey of a single instance across workflows as its initially created and eventually reused!

**Creation**:

Say that the resource pool is empty and the workflow needs one instance. The `provision` component then instantiates an instance for use. We then immediately register its id in our database and we assign it a `created` state. Then, once created, `provision` wants to assign it a `running` state BUT it cant until the instance emits various signals indicating proper initialization - ie. successful execution of `pre-runner-script` and successful registration of the instance as a runner for workflow_a.

Once these signals have been emitted by the instance, `provision` assigns a `running` state to instance_a and `provision` concludes. Ill see if I can assign q small diagram below

```
->created
::Receives OK signals
created->running
```

(TODO: Small diagram)

**Running the CI Jobs**

Great! Now that the provision has completed. Remember that we assigned 

**Selection**: 

Imagine that we have a handful of instances currenty idling in the resource pool. With a workflow that only needs one instance, it picks instance_a. Once picked up, the workflow tries to claim the instance to ensure that no other workflows have claimed this instance already. This then looks something like:

```
idle->claimed
```

The basic logic here is that if the id that's been picked up from the resource pool already has an internal representation of claimed, then its already been picked up by another workflow! This actually works in our favour as the resource pool is backed by standard SQS which only guarantees atleast once delivery, not exactly once. As such, if workflow_a and workflow_b both pickup instance_a, then only one workflow succeeds in claiming the 
