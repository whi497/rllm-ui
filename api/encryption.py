"""Symmetric encryption for user settings (e.g. API keys stored at rest).

Derives a Fernet key from JWT_SECRET via PBKDF2 so we don't need a second secret.
"""

import base64
import os

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

_SALT = b"rllm-ui-settings-v1"  # fixed salt — key uniqueness comes from JWT_SECRET


def _get_fernet() -> Fernet:
    jwt_secret = os.environ.get("JWT_SECRET", "")
    if not jwt_secret:
        raise RuntimeError("JWT_SECRET must be set for encryption")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_SALT,
        iterations=480_000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(jwt_secret.encode()))
    return Fernet(key)


def encrypt_value(plaintext: str) -> str:
    """Encrypt a string and return a URL-safe base64-encoded ciphertext."""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_value(ciphertext: str) -> str:
    """Decrypt a URL-safe base64-encoded ciphertext back to the original string."""
    return _get_fernet().decrypt(ciphertext.encode()).decode()
