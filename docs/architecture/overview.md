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

**Release: To the Resource Pool**:

Phew! Now that all the CI jobs have been executed to completion - remember again how we have structured our ci.yml file. We have made it so that the `release` job only exectutes after all jobs within the workflow have concluded. So, by executing the `release` within that workflow, the controlplane is able to determine which instances are registered against THAT run id. Then the controlplane, sends a signal to the database that this specific instance is ready for deregistration.

From the perspective of the `release` component of the controlplane, it wants to transition `running` instances to `idle` as quickly as possible.

Callout::Instance Deregistration
As we recall above, shortly after creation, the instance registers itself against github under the label of the workflow's run id. That is until, by proxy of the database, it gets an indication that it is safe to deregister (signal sent by the controlplane to the database). As such, it undergoes deregistration which is an internal routine that prompts the instance to deregister itself from github actions. Once this is successful, it sends a signal to the database which the controlplane is able to observe :ok:

Once `release` has gotten an indication of successful deregistration, it transitions the instance' state from `running` to `idle` with an empty runId. Then places the instance id in addition to some metadata to the resource pool for other workflows to pick this instance up

```
running->idle
```

(TODO: Small Diagram)

**Selection Part 1: From the Resource Pool**

Say that shortly after the instanceid has been placed in the resource pool, another workflow requires a resource and sees this instance id. Now selection has a few components to it so lets try to through it one by one.

Once the instanceid is picked up, `provision` observes if the instance is fit for the workflow according to various constraints. As per [advanced configuation](), these criteria are determined by the usage-class, allowed-instance-type. Thankfully, the resourcepool is already partioned by resource-class, so we dont have to filter by that.

```
# MINIMAL YAML showing the parameters
```

Nevertheless, if the accompanying metadata of the instance id does not fulfill the workflow's defined criteria on `provision`, then the message is requeued for other workflows to pickup :ok: - that's completely fine. However, if the pickedup instance satisfies all the constraints, then the filtering phase of selection is all good and `provision` attempts to put a `claim` on the instance.

Remember that the act of releasing an instance assigns it a state of being `idle`. This attempt to `idle->claim` is important as this where resource contention is very much expected to occur. The resource pool is backed by standard SQS queues which only guarantees atleast-once delivery. Meaning a message in the queue can theoretically be pickedup by multiple workflows at the same time.

Furthermore, due to the distributed nature of the workflows and controlplane, it was easier for me to build the resource pooling mechanism knowing that sometimes some instance ids may be duplicated. Internally, this leverages dynamodb's conditional updates. In that, if n amount of workflows tries to claim 1 instance, only one is guaranteed to succeed in the `idle->claim` attempt.

```
idle->claimed
```

As such, for whichever instance is able to transition the state of the instance, it is guaranteed that it is only this workflow holds this instance until release :ok:.

**Selection Part 2: Is the instance Ok?**

We're not done in "selection" thought! An internal representation of being `claimed` does not actually mean that the instance is alive. :sweat: This is where post claim checks come in. These checks include:

- [x] is the instance healthy?
- [x] is the instance able to register itself against the workflow successfully?

For the first check, this health goes a level deeper than just pinging the AWS API to describe the instance, the controlplane adds a heartbeat probe in each of the created instances which sends signals to the database indicating that it is still alive. The controlplane sees the recency of these signals and makes a call if it is healthy or not.

For the latter check, registeration against the new workflow is critical. See when whenever we transition from one state to another, we also assign the runId which transitions it. So the internal state actually looks more like this:

```
{state: idle, runId: ''}->{state: claimed, runId: 123}
```

As the runId changes, while the instance is `idle`, it observes the database intently for this exact piece of information. Once it sees this runId, it essentially gets an all clear to register itself against github actions under this label :ok:. As per **creation**, we know that successful registration leads to a signal emission from the instance itself which the controlplane then sees as confirmation of that second checklist ---> thus completing the selection process for this instance!

Callout::But what if the instance does not fulfill the checklist?
If any of these checks fail, then the message is ultimately discarded from the resource pool and the instance is internally "expired" which leads to termination. In the following sections, we will look at how this is done

Great! Now that the instance has been fully selected through the high level criteria and the following status checks. The selection routine within the provision portion of the controlplane. At a high level, these selected instances remain in the `claimed` state until after we have also created any new instances as well just in case the resource pool is not able to satify the requirements of the workflow.

Nevertheless, since in this example only one instance is required and one instance is successfully selected from the resource pool, then the transition to `running` occurs shortly thereafter and `provision` concludes to make way for the ci jobs allowing for the instance to be reused.

```
claimed->running
```

## Instance Expirations, Thresholds and Terminations

So now that we have covered how an instance is created, picks up ci jobs, released in to the resource pool and selected for reuse in subsequent workflows, I would like to look at the mechanisms that the controlplane uses to safely teminate our instances.

### Instance Threshold Timestamp

So I would have a look at our state diagram again. When the controlplane assigns a state from one to another, it also assigns it a `threshold` attribute. This attribute defines a timestamp sometime in the future at the time the state transition happened.

With this, we get something quite cool. We essentially get state-lifetimes for each state transition. Remember that as soon as the instance is created we give it a state of `created`. With thresholds, the controlplane also gives it a lifetime in which the instance remains in that state.

Expiry example: Say that, for some reason, a ci job runs far longer than it should. (ie. longer than the default or defined `max-runtime-min`). Then the threshold timestamp that is defined along with the `running` ticks over to the past. Internally, this tells us that the instance has been at this state longer than it probably should. As such, is thought of internally in the controlplane as "expired".

So the question is ... who looks at these thresholds?

### Who looks at this threshold?

Good question! These thresholds exists so that they can be observed. On instance transitions, one of the questions that needs to be answered is whether the instance has expired (ie. how does the threshold timestamp compare to the system timestamp that is viewing the instance threshold?).

Then if the instance has already expired, then the transition fails and the controlplane (hopefully) handles this gracefully.

For example, if selection picks up an expired instance from the pool, then it just discards of the instance from the pool and looks for another instance in the resource pool for pickup.

If for some reason  

So let's imagine this. We have configured our controlplane correctly. Now that our instance is being reused, let's look at some of the ways that this instance can fall through the cracks. We'll get an insight on various mechanisms in the controlplane that causes an instance to get safely terminated (or atleast as safe as we can make it to be).

Aight so its now running one of your ci jobs. Say that in this workflow, you're generally expecting a quick ci job turnaround. So you se the `max-runtime-min` to say 10 mins on the provision level. Say that your workflow looks somethink like:

```
provision(max-runtime-min: 10)->test->release
```

Then test takes way more than 10minutes. What happens then? Well from the perspective of the contolpane, this instance is determined as "expired". This is because for each state transition, we also add a `threshold`. This is a timestamp sometime in the future

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
