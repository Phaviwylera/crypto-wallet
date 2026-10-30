# Private EC2 deployment: setup guide

This runs the **static Seedlab website** on one EC2 instance. Every push to `main` (therefore, every merge to `main` when branch protection is enabled) triggers a GitHub Actions build and deploy. GitHub gets short-lived AWS credentials using OIDC, stores a versioned build in a private S3 bucket, then asks Systems Manager (SSM) to deploy it. There is no inbound SSH, public S3 bucket, or public compute API.

## Read this first: what EC2 will compute

The present app is a static browser app. BIP-39 generation and the bounded candidate checker run **in the visitor's browser**. EC2 only serves HTML, CSS, and JavaScript; deploying it does not speed up those calculations or use EC2 CPU for them. Do not send recovery phrases or seeds to a server. The complete BIP-39 phrase space is not practically searchable, even on EC2.

This plan treats the stated **US $85 as a total spending ceiling**, not as guaranteed purchasing power. If you meant $85 every month, use that as a recurring budget instead. AWS prices vary by region, usage, storage, public IPv4, and data transfer. The AWS budget feature sends alerts; it does not guarantee a hard stop. Use AWS Pricing Calculator for your selected region before launch and check Cost Explorer frequently.

## 1. Create cost guardrails before launching anything

1. In AWS Billing and Cost Management, create a **$85 total budget** (or the actual period you intend) with email alerts at $20, $40, $60, and $75. Enable a billing alarm / Cost Anomaly Detection alert as a second warning.
2. Start with just **one On-Demand `t3.small` Linux EC2 instance** and a **20 GiB `gp3` EBS volume**. No load balancer, NAT Gateway, reserved instance, or autoscaling group. This is adequate for serving this static learning app.
3. Check the estimate in AWS Pricing Calculator for your chosen region first. Include EBS, public IPv4 (if assigned), data transfer, and S3. A budget alert is not a spending cap: stop the instance if costs approach your limit.
4. The app does not need continuous server-side computation. Leave the compute budget for later until a bounded, reviewed workload exists. Do not use a burstable T3 for sustained CPU work. For future batch jobs, use a separately launched, time-limited worker with an explicit job cap and shutdown; Spot can be cheaper but may interrupt work.
5. Stopping an instance stops most compute charges, but EBS storage persists and may still cost money; an attached public IPv4 or other services can also incur charges. Terminate the instance and delete unneeded volumes to stop those costs. Avoid NAT Gateway; it can consume the budget even when compute is idle.

## 2. Launch one EC2 instance with no inbound access

1. Pick a region near you where `t3.small` is available and compare its calculator estimate. Create/use a VPC with a public subnet and Internet Gateway so the instance can make outbound HTTPS connections to SSM and S3.
2. Launch **Ubuntu Server 24.04 LTS**, `t3.small`, 20 GiB `gp3`. Do not create/download an SSH key pair for this setup.
3. Create an EC2 instance role/profile named, for example, `seedlab-ec2-instance-role`. Attach AWS managed policy `AmazonSSMManagedInstanceCore`, plus the narrowly-scoped S3 read policy in section 4. Attach it during launch.
4. For the security group, leave **all inbound rules empty**. Allow outbound HTTPS (TCP 443) so SSM and the AWS CLI can reach AWS endpoints. Never open SSH port 22. The instance may have a public IPv4 to make outbound connectivity simple; no inbound rules means the public address still does not serve the app to Internet clients.
5. Launch, then check Systems Manager → Fleet Manager / Managed nodes. Wait for the instance to show Online. If it is offline, verify its instance role, SSM Agent, DNS, and outbound HTTPS.

This guide intentionally keeps the site private. A public IPv4 is not a requirement for users to visit it, and its address will not load the site with this security group. If you explicitly want an Internet-facing site later, plan a domain, TLS, access controls, and a separate security review; do not expose any search/compute API publicly.

## 3. Install Nginx and configure the site

Use Systems Manager → Run Command → `AWS-RunShellScript` on the instance (or an SSM shell session) and run:

```bash
sudo apt-get update
sudo apt-get install -y nginx awscli
sudo install -d -o www-data -g www-data /var/www/seedlab/releases
sudo tee /etc/nginx/sites-available/seedlab >/dev/null <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/seedlab/current;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location ~* \.(?:js|css|svg|png|jpg|woff2?)$ {
        try_files $uri =404;
        expires 1h;
        add_header X-Content-Type-Options nosniff always;
    }
}
NGINX
sudo ln -sfn /etc/nginx/sites-available/seedlab /etc/nginx/sites-enabled/seedlab
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
```

The pipeline installs versioned releases under `/var/www/seedlab/releases/` and atomically switches the `/var/www/seedlab/current` symlink.

### View the site privately

On your own computer, configure AWS CLI credentials for your own AWS user/role with permission to start an SSM session, then run:

```bash
aws ssm start-session \
  --target i-REPLACE_WITH_INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["80"],"localPortNumber":["8080"]}' \
  --region REPLACE_WITH_REGION
```

Keep the terminal open and visit **http://localhost:8080**. The SSM tunnel is authenticated by AWS; no inbound web port is open. `localhost` is a secure browser context for the browser cryptography used by this educational app.

## 4. Create a private S3 bucket and EC2 read permissions

1. Create an S3 bucket in the same Region. Enable **Block all public access**, bucket-owner-enforced object ownership, and default encryption. Do not enable S3 static website hosting. Record the bucket name.
2. Add this inline policy to the EC2 instance role, replacing `YOUR_BUCKET`. It permits reads only from release objects; the EC2 instance cannot upload releases.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::YOUR_BUCKET","Condition":{"StringLike":{"s3:prefix":["releases/*"]}}},
    {"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::YOUR_BUCKET/releases/*"}
  ]
}
```

The instance role also needs `AmazonSSMManagedInstanceCore` so SSM can run deploy commands. Do not grant it broad administrator access.

## 5. Configure GitHub Actions → AWS without static AWS keys

### Create the GitHub OIDC provider and deploy role

1. In IAM → Identity providers, add `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` (only if the provider is not already present).
2. Create a role for web identity. Replace `YOUR_ACCOUNT_ID`; this trust allows only this repository's `main` branch to assume the role:

```json
{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Principal":{"Federated":"arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
    "Action":"sts:AssumeRoleWithWebIdentity",
    "Condition":{"StringEquals":{
      "token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub":"repo:Phaviwylera/crypto-wallet:ref:refs/heads/main"
    }}
  }]
}
```

3. Attach this permissions policy to the GitHub deploy role. Replace the bucket, region, account ID, and instance ID:

```json
{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::YOUR_BUCKET","Condition":{"StringLike":{"s3:prefix":["releases/*"]}}},
    {"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::YOUR_BUCKET/releases/*"},
    {"Effect":"Allow","Action":"ssm:SendCommand","Resource":[
      "arn:aws:ec2:YOUR_REGION:YOUR_ACCOUNT_ID:instance/YOUR_INSTANCE_ID",
      "arn:aws:ssm:YOUR_REGION::document/AWS-RunShellScript"
    ]},
    {"Effect":"Allow","Action":"ssm:GetCommandInvocation","Resource":"*"}
  ]
}
```

`GetCommandInvocation` requires wildcard resource scope in IAM. If AWS IAM rejects `SendCommand`, check the Systems Manager service authorization reference for required resources in your account/region; do not work around it by granting `ssm:*` or broad `Resource: "*"`.

### Set GitHub repository variables and secret

In GitHub → repository Settings → Secrets and variables → Actions, add:

- **Secret** `AWS_DEPLOY_ROLE_ARN`: the IAM deploy role ARN.
- **Variables** `AWS_REGION`: the selected region; `EC2_INSTANCE_ID`: the instance ID; `DEPLOY_BUCKET`: the private bucket name.

Enable branch protection for `main`: require PRs and checks, and disallow direct pushes. `.github/workflows/deploy-ec2.yml` listens for pushes to `main`; thus every merge to `main` triggers a build and deployment. It can also be started manually in Actions. No SSH keys or AWS access keys are stored in GitHub.

## 6. Validate and monitor

1. Merge a small reviewed change to `main`.
2. In GitHub Actions, confirm “Deploy Seedlab to private EC2” succeeds. It builds with `npm ci && npm run build`, uploads an immutable S3 release, and asks SSM to switch Nginx to it.
3. Start the SSM port-forwarding command from section 3 and open `http://localhost:8080` to verify the page.
4. If the workflow fails, inspect its logs and Systems Manager → Run Command output. A prior version remains in S3 for redeploying.
5. Add an S3 lifecycle rule to expire `releases/` objects after a short retention period (for example 14–30 days) and abort incomplete multipart uploads; preserve a few recent releases for rollback.
6. Check AWS Cost Explorer after the first day and week. Stop the EC2 instance when not needed; remember storage can still bill.

## Safety checklist

- No inbound EC2 rules, SSH, public S3, or public compute/search API.
- AWS budget alert configured before launch; alerts are not a hard cap.
- GitHub OIDC trust is limited to the exact `main` branch.
- The app does not send phrase/seed values to EC2; do not put secrets in logs, S3, or GitHub Actions.
- Current candidate checking still runs in the browser; EC2 serves static content only.
