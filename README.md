# 🚧 Experimental / Archived

> **Status — Proof-of-Concept (June 2025)**  
> Native resource-scheduler prototype for self-hosted GitHub Actions runners.  
> **No longer under active development.**

### What this means

- No roadmap or official support — use at your own risk.
- Issues and pull-requests are welcome but handled **best-effort**.
- Feel free to **fork and evolve** the idea.

### Why it exists

This repo explores whether a lightweight, Kubernetes-style scheduler can live
_inside_ GitHub Actions itself—spinning, pooling, and retiring EC2 runners on
demand. It showcases:

- Dynamic fleet provisioning & cleanup
- Runner lifecycle orchestration
- Spot vs. on-demand cost optimisation

### Looking for a production-ready solution?

Consider:

- [actions-runner-controller](https://github.com/actions-runner-controller/actions-runner-controller)
- [terraform-aws-github-runner](https://github.com/philips-labs/terraform-aws-github-runner)

Full documentation remains available at
<https://fleet-actions.github.io/ec2-runner-pool-manager/>.

---

# Fleet Actions: EC2 Runner Pool Manager 🚀♻️

![Sample Workflow](./docs/assets/sample-workflow-light.png)

Provision, scale, and reuse a pool of self-hosted EC2 runners directly within
your GitHub Actions workflows, all with a simple, embedded control plane.

## ⚡️ Motivation

This project was born from a desire to simplify the management of self-hosted
runners. The goal was to dynamically provision, pool, and reuse runners directly
within GitHub Actions, avoiding the complexities of:

- Deploying and managing separate control planes (e.g., Kubernetes, Terraform).
- Configuring webhooks and serverless runtimes.
- Sifting through logs in external cloud providers instead of keeping them in
  one place.

Inspired by powerful tools like `actions-runner-controller` and
`terraform-aws-github-runner`, this action provides a streamlined, YAML-centric
approach to runner lifecycle management.

## ✨ Features

- **Embedded Control Plane**: No separate infrastructure to manage. The logic
  lives entirely within the action.
- **Resource Pooling & Reuse**: Minimize cold-starts and costs by reusing warm,
  idle runners from a shared pool.
- **Simple Targeting**: Use a single, consistent `runs-on: ${{ github.run_id }}`
  syntax for all your jobs.
- **Integrated Logging**: Runner lifecycle logs (creation, selection,
  termination) appear directly in your workflow logs.
- **Declarative Lifecycles**: Define how long runners should live when idle or
  actively running.

## 🔍 How It Works

The core architectural principle is that the control plane is **embedded within
the GitHub Action itself**. Instead of a separate, continuously running service,
the action's different modes (`provision`, `release`, `refresh`) are called
directly from your workflows to manage the runner lifecycle.

![Simplified Architecture](./docs/assets/simplified-architecture.png)

![](./docs/assets/mode-and-workflows.png)

## 📖 Full Documentation

**For a complete guide, including installation, advanced configuration, and
architectural details, the
[Github Pages Site](https://fleet-actions.github.io/ec2-runner-pool-manager/)**

> To get to it, start with the:
> **[Quickstart Guide](https://fleet-actions.github.io/ec2-runner-pool-manager/#getting-started)**.

## 🚀 Quickstart Example

Here’s a taste of how you can provision and release runners within a single
workflow.

```yaml
# .github/workflows/ci.yml
name: CI

on: [push]

jobs:
  provision_runners:
    name: Provision Runners
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - uses: fleet-actions/ec2-runner-pool-manager@v1
        with:
          mode: provision
          instance-count: 2

  test_job:
    name: Run Job on EC2
    needs: provision_runners
    runs-on: ${{ github.run_id }} # Target the provisioned runners
    steps:
      - run:
          echo "This job is running on a dynamically provisioned EC2 instance!"

  release_runners:
    name: Release Runners
    runs-on: ubuntu-latest
    needs: [test_job] # Runs after your CI jobs
    if: ${{ always() }} # Important: Always release runners
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - uses: fleet-actions/ec2-runner-pool-manager@v1
        with:
          mode: release
```

## 📋 Inputs & Permissions

A comprehensive list of all action inputs and the required IAM policies are
available in our full documentation.

- [**Action Inputs Reference**](https://fleet-actions.github.io/ec2-runner-pool-manager/getting-started/advanced-configuration/)
- [**IAM Permissions Guide**](https://fleet-actions.github.io/ec2-runner-pool-manager/getting-started/prerequisites/#3-iam-user-for-github-actions-workflow)

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## 📜 License

This project is licensed under the [MIT License](LICENSE).
