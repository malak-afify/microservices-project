# 3-Tier ATM App on AWS

A 3-tier ATM web application containerized with Docker and deployed on Kubernetes (Amazon EKS), with images stored in Amazon ECR and data stored in Amazon RDS (PostgreSQL).

I built this project to put everything I learned in my DevOps course into one real, end-to-end project: Linux, Git, Docker, Kubernetes, and AWS.

![Architecture](docs/architecture.png)

## Architecture

| Tier | Component | Technology | Runs on |
|------|-----------|------------|---------|
| 1. Presentation | ATM frontend (HTML/JS) | Nginx | Pods on EKS |
| 2. Application | REST API (balance, deposit, withdraw) | Python Flask | Pods on EKS |


## Kubernetes Objects

- `Deployment` for the Nginx and Flask pods
- `Service` (ClusterIP) to connect the tiers
- `Ingress` to expose the frontend through the ALB
- `ConfigMap` and `Secret` for app settings and database credentials

## Security Notes

- The database and the application pods live in private subnets.
- Only the load balancer and the admin host sit in the public subnet.
- Database credentials are stored in Kubernetes Secrets, not in the code or the images.
- SSH access uses a key pair (`.pem`), with port 22 limited to my IP in the security group.

## Project Structure

> Adjust the names to match your repo.

```
.
├── frontend/        # HTML/JS + Nginx Dockerfile
├── backend/         # Flask API + Dockerfile
├── k8s/             # Kubernetes manifests (Deployments, Services, Ingress, ConfigMap, Secret)
├── docs/            # Architecture diagram
└── README.md
