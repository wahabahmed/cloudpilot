# 1. Start infrastructure
brew services start postgresql@16
createdb cloudpilot 2>/dev/null || true
redis-server --daemonize yes
minio server ~/minio-data --console-address ":9001" &
python3 -c "import boto3; s3=boto3.client('s3',endpoint_url='http://localhost:9000',aws_access_key_id='minio',aws_secret_access_key='minio123'); s3.create_bucket(Bucket='cloudpilot-tf')" 2>/dev/null || true

# 2. Start backend
cd ~/CloudPilot/backend
source venv/bin/activate
uvicorn app.main:app --reload

# 3. In another terminal, start the worker
cd ~/CloudPilot/backend
source venv/bin/activate
python -m app.worker

# 4. In a third terminal, test the flow
# Bootstrap tenant + admin
curl -X POST "http://127.0.0.1:8000/tenants?name=acme&admin_email=admin@acme.com&admin_password=changeme"

# Login
TOKEN=$(curl -s -X POST "http://127.0.0.1:8000/auth/login?email=admin@acme.com&password=changeme" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# Create team
curl -X POST "http://127.0.0.1:8000/tenants/1/teams?name=Platform" -H "Authorization: Bearer $TOKEN"

# Store AWS credential
curl -X POST "http://127.0.0.1:8000/tenants/1/credentials?provider=aws&env=DEV" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"role_arn":"arn:aws:iam::123456789012:role/CloudPilot","external_id":"ext","region":"us-east-1"}'

# Verify it
curl -X POST "http://127.0.0.1:8000/tenants/1/credentials/1/verify" -H "Authorization: Bearer $TOKEN"

# Add account
curl -X POST "http://127.0.0.1:8000/tenants/1/accounts?provider=aws&account_ref=acme-dev&env=DEV&credential_id=1" -H "Authorization: Bearer $TOKEN"

# Submit request
curl -X POST "http://127.0.0.1:8000/tenants/1/requests?account_id=1&nlp_text=create%20a%20vpc%20with%20cidr%2010.0.0.0/16" -H "Authorization: Bearer $TOKEN"

# Approve
curl -X POST "http://127.0.0.1:8000/requests/1/approve" -H "Authorization: Bearer $TOKEN"

# Inventory
curl "http://127.0.0.1:8000/tenants/1/inventory" -H "Authorization: Bearer $TOKEN"

# Finance trend
curl "http://127.0.0.1:8000/tenants/1/finance/trend?days