"""
Pluggable storage for Terraform state and generated .tf files.

This is the PLATFORM's storage, not a customer's cloud account.
- Use "minio" or "s3" for S3-compatible backends
- Use "gcs" for Google Cloud Storage
- Use "azure" for Azure Blob Storage
"""
import os


class S3Storage:
    def __init__(self):
        import boto3
        self.bucket = os.environ["STORAGE_BUCKET"]
        self.client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("STORAGE_ENDPOINT"),
            aws_access_key_id=os.environ["STORAGE_ACCESS_KEY"],
            aws_secret_access_key=os.environ["STORAGE_SECRET_KEY"],
            region_name=os.environ.get("STORAGE_REGION", "us-east-1"),
        )

    def put(self, key: str, body: bytes):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body)

    def get(self, key: str) -> bytes:
        obj = self.client.get_object(Bucket=self.bucket, Key=key)
        return obj["Body"].read()

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError:
            return False

    def list_prefix(self, prefix: str) -> list[str]:
        out = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                out.append(obj["Key"])
        return out


class GCSStorage:
    def __init__(self):
        from google.cloud import storage
        self.bucket_name = os.environ["STORAGE_BUCKET"]
        self.client = storage.Client()
        self.bucket = self.client.bucket(self.bucket_name)

    def put(self, key: str, body: bytes):
        self.bucket.blob(key).upload_from_string(body)

    def get(self, key: str) -> bytes:
        return self.bucket.blob(key).download_as_bytes()

    def exists(self, key: str) -> bool:
        return self.bucket.blob(key).exists()

    def list_prefix(self, prefix: str) -> list[str]:
        return [b.name for b in self.client.list_blobs(self.bucket_name, prefix=prefix)]


class AzureBlobStorage:
    def __init__(self):
        from azure.storage.blob import BlobServiceClient
        conn_str = os.environ["STORAGE_CONNECTION_STRING"]
        self.service = BlobServiceClient.from_connection_string(conn_str)
        self.container = self.service.get_container_client(os.environ["STORAGE_BUCKET"])

    def put(self, key: str, body: bytes):
        self.container.upload_blob(name=key, data=body, overwrite=True)

    def get(self, key: str) -> bytes:
        return self.container.download_blob(key).readall()

    def exists(self, key: str) -> bool:
        return self.container.get_blob_client(key).exists()

    def list_prefix(self, prefix: str) -> list[str]:
        return [b.name for b in self.container.list_blobs(name_starts_with=prefix)]


def get_storage():
    backend = os.environ.get("STORAGE_BACKEND", "s3").lower()
    if backend in ("s3", "minio"):
        return S3Storage()
    if backend == "gcs":
        return GCSStorage()
    if backend == "azure":
        return AzureBlobStorage()
    raise ValueError(f"unknown STORAGE_BACKEND: {backend}")


# Module-level singleton so every import gets the same client
storage = get_storage()