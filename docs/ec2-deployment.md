# Private EC2 deployment and cost-controlled setup

This guide deploys the static Seedlab site to one EC2 instance after every push to `main` (configure GitHub branch protection so changes reach `main` only by merge). GitHub Actions authenticates to AWS with short-lived OIDC credentials, uploads a versioned build to a private S3 bucket, then asks Systems Manager (SSM) to deploy it. **No inbound SSH, public S3 bucket, or public compute API is used.**

## Important: what will and will not run on EC2

The current app is a static browser app. Its phrase generation and bounded candidate checking happen in the visitor's browser; EC2 only serves the built files. Deploying it to EC2 will not accelerate those calculations. Do not send real phrases or seeds to a server. The BIP-39 full phrase search is not feasible; an EC2 instance does not make a 2^128 search practical.

This plan assumes **US $85 is a maximum monthly budget**. If $85 is a one-time total, use the same small instance but stop/terminate it promptly and check the bill daily. AWS prices vary by region, OS, storage, IPv4, and data transfer. Before launch, use the AWS Pricing Calculator for your chosen region and set a billing budget. Budget notifications are alerts, **not a hard spending cap**.

## 1. Set cost guardrails first

1. In AWS Billing and Cost Management, create an AWS Budget for **$85/month** (or your actual period) and email alerts at $25, $50, $70, and $80.
2. Enable a billing alarm / Cost Anomaly Detection alert as an additional warning. Alerts can arrive after usage; they do not stop resources.
3. Start with **one On-Demand `t3.small` Linux instance**, 20 GiB `gp3` disk, no load balancer, no NAT Gateway, and no reserved capacity. This is enough to serve this static demo. Verify its exact regional estimate in the calculator before accepting.
4. This app does not need an always-on CPU worker. Keep the compute budget unspent until there is a separately designed, bounded workload. Later CPU-heavy experiments should use short-lived, explicitly launched workers with per-job caps and an automatic shutdown; Spot can be cheaper but may interrupt a job. Do not use a burstable `t3` instance for sustained CPU workloads.
5. Stop the instance when not needed. Stopping removes most instance compute charges but **does not** stop EBS storage charges; public IPv4 and other resources may also continue to cost money. Terminate and delete unneeded volumes when finished.

## 2. Create the EC2 instance privately

1. Choose a nearby AWS Region where `t3.small` is available; region prices differ. Create/choose a VPC with a public subnet and Internet Gateway so the instance can make outbound HTTPS connections to AWS SSM/S3. Assign a public IPv4 only if needed for outbound connectivity; the security group below still blocks unsolicited inbound traffic.
2. Launch Ubuntu Server 24.04 LTS, `t3.small`, 20 GiB `gp3`. Do not create/download an SSH key pair for this workflow.
3. Create an EC2 instance role (instance profile) and attach `AmazonSSMManagedInstanceCore` plus the S3 read policy from section 4. Attach the role at launch. Confirm the SSM Agent is installed and online in Systems Manager → Fleet Manager / Managed nodes.
4. Create a security group with **no inbound rules**. Keep outbound HTTPS (TCP 443) so the SSM agent and AWS CLI can reach AWS endpoints. Do not open port 22, 80, or 443 to `0.0.0.0/0`.
5. Confirm in Systems Manager that the instance is a managed node. If it is not online, check its instance profile, SSM Agent, DNS, and outbound HTTPS connectivity before proceeding.

A public IPv4 address is routable, but with no inbound security-group rules the site is **not reachable at that address**. This guide intentionally uses a private SSM tunnel for viewing. If you later want a public website, decide that explicitly and add HTTPS, a domain/certificate, request controls, and a hardened security review. Do not expose a search/computation endpoint publicly.

## 3. Install Nginx and configure the private site

Use Systems Manager → Run Command → `AWS-RunShellScript` on the instance, or an SSM shell session, to run:

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

The deploy process will create `/var/www/seedlab/current` as an atomic symlink to the latest release.

### Open the site without making it public

On your own computer, install/configure AWS CLI credentials with permission to start an SSM session, then run:

```bash
aws ssm start-session \
  --target i-REPLACE_WITH_INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["80"],"localPortNumber":["8080"]}' \
  --region REPLACE_WITH_REGION
```

Keep that terminal open and visit **http://localhost:8080** in your browser. Localhost is treated as a secure browser context for Web Crypto. The SSM tunnel is private to your AWS identity; the EC2 public IP does not serve the page to the Internet.

## 4. Create the private release bucket and instance permissions

1. Create an S3 bucket in the same Region. Enable **Block all public access**, bucket-owner-enforced object ownership, and default encryption. Do not enable static website hosting. Record the bucket name.
2. Add an inline policy to the EC2 instance role, substituting your actual account and bucket names. It lets the instance read only deployed release files:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::YOUR_BUCKET","Condition":{"StringLike":{"s3:prefix":["releases/*"]}}},
    {"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::YOUR_BUCKET/releases/*"}
  ]
}
```

The instance role also needs `AmazonSSMManagedInstanceCore`. It does not need S3 write access.

## 5. Let GitHub Actions deploy without long-lived AWS keys

Use GitHub OIDC, not AWS access keys stored in GitHub:

1. In IAM → Identity providers, add provider `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` (skip if it already exists).
2. Create an IAM role for web identity, trusted only for this repository's `main` branch. Replace the account/repository values if they differ. Trust policy:

```json
{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Principal":{"Federated":"arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
    "Action":"sts:AssumeRoleWithWebIdentity",
    "Condition":{
      "StringEquals":{
        "token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub":"repo:Phaviwylera/crypto-wallet:ref:refs/heads/main"
      }
    }
  }]
}
```

3. Attach this deploy policy to the role. Replace region, account ID, bucket, and instance ID:

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

If AWS IAM reports a resource-level permission issue for `SendCommand`, check the Systems Manager service authorization reference for the exact resources required in your region; do not solve it by granting `ssm:*` or `Resource: "*"` broadly.

4. In GitHub repository Settings → Secrets and variables → Actions, add:
   - **Secret** `AWS_DEPLOY_ROLE_ARN`: the IAM role ARN created above.
   - **Variables** `AWS_REGION`, `EC2_INSTANCE_ID`, and `DEPLOY_BUCKET`: your actual region, instance ID, and private bucket name.
5. Protect `main`: require pull requests and checks, and disallow direct pushes. The workflow `.github/workflows/deploy-ec2.yml` runs on each push to `main`, which means each merge to `main` deploys the built site. It can also be run manually from the Actions tab.
6. Open Actions → “Deploy Seedlab to private EC2”. On a successful run, the release is installed under `/var/www/seedlab/releases/<commit>` and Nginx switches to it. If it fails, inspect the action logs and Systems Manager Run Command output. The previous release remains in S3 and can be restored by redeploying its commit.

## 6. Budget and security checklist

- [ ] Budget and alert emails are configured before starting compute.
- [ ] EC2 inbound security group has no rules; no SSH key or inbound SSH is used.
- [ ] The S3 bucket blocks all public access.
- [ ] GitHub uses OIDC with a trust condition limited to this repo's `main` branch.
- [ ] The app's expensive work remains client-side; no secret phrase or seed is sent to EC2.
- [ ] EC2 is stopped when idle if continuous availability is unnecessary.
- [ ] Review Cost Explorer after the first day and week; budgets alert but do not enforce a cap.
- [ ] Never put seed phrases, private keys, AWS credentials, or user candidate lists in GitHub Actions logs or S3.
