import base64
import os
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def _key() -> bytes:
    seed = os.environ["ENCRYPTION_KEY"].encode()
    return base64.urlsafe_b64encode(
        HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"cloudpilot-repo-token",
            info=b"repo-token-encryption",
        ).derive(seed)
    )


_fernet = Fernet(_key())


def encrypt_token(plain: str) -> str:
    return _fernet.encrypt(plain.encode()).decode()


def decrypt_token(cipher: str) -> str:
    return _fernet.decrypt(cipher.encode()).decode()