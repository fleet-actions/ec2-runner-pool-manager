# Simple, Scalable & Reusable EC2 Runners for GitHub Actions

![Sample-Workflow](assets/sample-workflow-light.png)

This Action enables you to run a pool of self-hosted EC2 runners directly within the GitHub Actions runtime. Resource pooling, scale-in/scale-out, and the entire runner lifecycle are all managed by the action itself - no external control plane or infrastructure-as-code required.

## :zap: Motivation: YAML-first control

This action was explicitly designed to **embed** the control plane within GitHub Actions, avoiding the complexity of separate infrastructure or specialized expertise in Kubernetes or Terraform. While existing solutions either require external control planes or sacrifice performance for simplicity, this project combines the best of both worlds.

The key benefits of this embedded approach are:

- **Zero-Infrastructure Control Plane**: No deploying and managing separate services or webhooks.
- **Integrated Logging**: Runner logs are readily accessible within your [workflow run logs](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-workflow-run-logs).
- **Resource Pooling**: Workflows first try to reuse warm, idle runners from a shared pool, minimizing cold-starts and optimizing costs.

## :building_construction: How It Works: An Embedded Lifecycle Manager

This action operates using three distinct modes (`provision`, `release`, `refresh`) that you call from different jobs within your own workflows. This allows you to control, share, and scale runners directly from your YAML files.

![Modes In Workflows](assets/mode-and-workflows.png)

- The `provision` step is called at the start of a workflow to acquire runners.
- Your jobs run on the newly provisioned runners.
- The `release` step is called at the end to return the runners to the pool.
- A separate, scheduled workflow uses the `refresh` mode to perform system-wide maintenance.

This model provides a powerful, YAML-centric approach to runner management, inspired by tools like `actions-runner-controller` and `terraform-aws-github-runner`.

## :star: Getting Started

Ready to try it out? Follow our step-by-step guides to get up and running in minutes.

**[Prerequisites](getting-started/prerequisites.md) :arrow_right: [Quickstart](getting-started/quickstart.md) :arrow_right: [Advanced Configuration](getting-started/advanced-configuration.md)**

## :mag: Digging Deeper

For a more detailed look at the internal design and advanced use cases:

- **:compass: Architectural Overview**: Learn how the different components work together in our [How It Works](architecture/overview.md) guide.
- **:clipboard: Workflow Examples**: See complete, practical examples for different CI/CD scenarios in our [Examples](examples/basic-workflow.md) section. (See [advanced examples](./examples/advanced-scenarios.md) too)
