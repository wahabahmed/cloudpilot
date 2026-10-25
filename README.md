# CloudPilot


https://github.com/user-attachments/assets/c7e8e6d6-f118-4e95-ba79-62dfff485361



**Your co-pilot for multi-cloud infrastructure.**

CloudPilot is a self-hosted platform that turns natural-language requests into reviewed, approved, and audited Terraform changes across AWS, GCP, Azure, Oracle Cloud, IBM Cloud, Alibaba Cloud, and Databricks. It gives platform teams a single control plane for provisioning, cost visibility, and policy enforcement — without giving up Terraform.

---

## Why CloudPilot

Most organizations end up with the same set of problems when they try to scale multi-cloud operations:

- **Provisioning is a bottleneck.** Every VPC, RDS instance, or IAM role requires a ticket to the platform team, and every ticket takes days.
- **Approvals are inconsistent.** Some teams have PR reviews, some have Slack threads, some have no gate at all. Auditors want one answer.
- **State is scattered.** Every team keeps its own Terraform backend. Nobody has a unified view of what exists in any account.
- **Cost is invisible.** Finance sees one cloud bill per provider, engineering sees none, and nobody can attribute spend to a team or an account.
- **Nobody can self-serve safely.** Giving developers raw cloud credentials is unacceptable. Giving them a web UI that provisions directly is worse.

CloudPilot solves these by putting a controlled, audited, approval-driven layer **on top of** Terraform and the cloud provider APIs.

---

## What CloudPilot Does

### 1. Natural-language infrastructure requests

Users describe what they need — *"Create a VPC in us-east-1 with two private subnets and a NAT gateway"* — and CloudPilot:

- Converts the request to Terraform HCL using an LLM (DeepSeek).
- Runs `terraform plan` against the **target sub-account** (not a shared account).
- Shows the plan diff to admins for approval.
- Runs `terraform apply` after approval, recording who approved what and when.

Plans are reviewed like a PR, and the same request can go through any workflow an admin defines — including multiple sequential approvals.

### 2. Multi-account, multi-provider credential management

CloudPilot never stores long-lived cloud credentials for end users. Instead:

- **One root credential per (provider, environment)** is configured by an admin.
- Sub-accounts are created or registered under that root.
- Every action CloudPilot takes — provisioning, importing, verification, cost queries — is performed **as that specific sub-account** via role assumption (`sts:AssumeRole`, workload identity federation, service principal impersonation, or provider-specific STS).

AWS, GCP, Azure, Oracle Cloud, IBM Cloud, Alibaba Cloud, and Databricks each have their own account model, and CloudPilot handles the differences.

### 3. Approval workflows

Admins define workflows as ordered sequences of steps. A workflow can be as simple as:
