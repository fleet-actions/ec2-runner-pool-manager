# Case Study :books:

`fleet-actions/ec2-runner-pool-manager` is a GitHub Action that enables running a pool of self-hosted EC2 runners directly within GitHub Actions workflows, eliminating the need for separate control planes while providing efficient resource pooling and lifecycle management.

## CICD and SelfHosting

CI/CD pipelines are essential for modern software development, allowing teams to efficiently test and deploy code. While many organizations initially turn to third-party CI/CD providers for convenience and ease of setup, these solutions come with significant drawbacks.

Third-party providers typically charge premium rates based on build minutes or concurrent jobs, which can become prohibitively expensive at scale. Additionally, these services offer limited compute profiles that constrain performance - fixed memory/CPU configurations, lack of specialized hardware options, and restricted network capabilities.

Self-hosting runners provides organizations complete control over their CI/CD infrastructure, enabling cost optimization through tailored EC2 instance selection and customized hardware configurations that precisely match workload requirements.

## GitHub and GitHub Actions

GitHub has become the central platform for source code collaboration, making it a natural place for teams to integrate their CI/CD workflows via GitHub Actions.

For many teams, GitHub Actions is the obvious starting point for automating builds, tests, and deployments. Its convenience and tight integration with the GitHub ecosystem allow organizations to move quickly without managing separate CI/CD infrastructure.

However, as usage grows, teams often encounter two major challenges with GitHub Actions' default hosted runners:

- Escalating Costs: GitHub-hosted runners are billed at premium rates, which can become unsustainable for organizations with large or frequent workloads.
- Limited Compute Flexibility: The available runner types are fixed, restricting teams who need specialized hardware, more memory, or custom environments.

These limitations drive many organizations to explore self-hosted runners for GitHub Actions.

## Existing Solutions and Their Limitations

Self-hosting GitHub Actions Runners has been addressed by several established solutions, which typically fall into two categories:

### 1. Comprehensive Control Plane Solutions

Tools like [Actions Runner Controller](https://github.com/actions/actions-runner-controller) and [terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner) provide robust scaling capabilities through dedicated control systems.

However, these solutions:

- Require separate infrastructure to deploy and maintain
- Demand specialized expertise in Kubernetes or Terraform
- Force operators to consult separate logging systems when troubleshooting

### 2. Workflow-Embedded Solutions

Simpler approaches like [machulav/ec2-github-runner](https://github.com/machulav/ec2-github-runner) and [related-sciences/gce-github-runner](https://github.com/related-sciences/gce-github-runner) embed instance provisioning directly in workflows, improving maintainability and access to logs.

While more straightforward, these solutions face critical limitations:

- Limited to one instance per job, reducing parallelization capabilities
- Require wrapping each job in provision-release pairs, increasing YAML complexity
- Introduce GitHub Actions minutes overhead, defeating cost-saving purposes
- Lack resource pooling, resulting in consistent cold-start penalties
- Trade performance for simplicity

## Bridging the Gap: `fleet-actions/ec2-runner-pool-manager`

The `fleet-actions/ec2-runner-pool-manager` addresses these limitations by providing the best of both approaches:

- **Embedded Control Plane**: Operates entirely within GitHub Actions, eliminating separate infrastructure
- **Resource Pooling**: Intelligently reuses runners across workflows, minimizing cold-starts
- **Simplified Operations**: Keeps logs directly accessible in workflow runs
- **Efficient Scaling**: Manages multiple instances per job without complex wrapper patterns
- **Cost Optimization**: Minimizes both AWS compute costs and GitHub Actions minutes

By embedding the control plane within GitHub Actions while maintaining sophisticated pooling capabilities, this solution delivers the simplicity developers need with the performance and cost efficiency organizations require.
