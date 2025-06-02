# Overview :books:

This page aims to provide a more detailed look under the hood of the action. In this section, we will look at how the controlplane is divided allowing us to dynamically provision and reuse EC2 instances easily across diffrent workflows.

In comparison to the simplfied architecture found in [Home Page](../index.md), a more complete look at the components and interactions are as follows:

![Overall Architecture](../assets/overall-architecture.png)

As covered in the [Home Page](../index.md) - there are three modes of operation for the action. These include `refresh`, `provision` and `release`. In each of these modes of operations, the instance itself has its own responsibilities in order for the controlplane to handle an instance safely.

As such, we will introduce what each component does in detail - at a high level, these are the high level components. if you would permit me, I would like to tell this like a story :)

Okay, so I think the first question that you would like to ask is, well, what do each components do?

- What do each components do? (Message: Still cover this at a high level)

Okay, that kinda make sense, but how do they really tie in together?




## Refresh - Initialization and Maintenance :sunflower:

The primary resposibilities of refresh mode is to:

- Initialize Infrastructure
- Enrich the DynamoDB Table with metadata

### Refresh as an Initializer

### Refresh as a Propagator

### Refresh as a Maintainer
