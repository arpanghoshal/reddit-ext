"""
Cryptographic utilities for secure data storage
Uses AES-256-GCM for authenticated encryption
"""

import os
import logging
import secrets
import hashlib
import hmac
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

# Encryption key from environment (32 bytes for AES-256)
# Generate with: secrets.token_hex(32)
ENCRYPTION_KEY = os.getenv("COOKIE_ENCRYPTION_KEY") or os.getenv("ENCRYPTION_KEY")
IV_LENGTH = 16  # AES block size (128 bits / 16 bytes for GCM)
AUTH_TAG_LENGTH = 16


def is_encryption_configured() -> bool:
    """Check if encryption is properly configured"""
    if not ENCRYPTION_KEY:
        return False
    # Key should be 64 hex characters (32 bytes)
    return len(ENCRYPTION_KEY) == 64


def encrypt(plaintext: str) -> str:
    """
    Encrypt a string using AES-256-GCM

    Args:
        plaintext: Data to encrypt

    Returns:
        Encrypted data in format: iv:ciphertext (hex encoded)
        The auth tag is appended to ciphertext by AESGCM
    """
    if not ENCRYPTION_KEY:
        env = os.getenv("ENVIRONMENT", "development")
        if env == "production":
            raise ValueError("ENCRYPTION_KEY must be configured in production - cannot store data unencrypted")
        logger.warning("Encryption key not configured - storing data unencrypted (NOT SAFE FOR PRODUCTION)")
        encoded = base64.b64encode(plaintext.encode()).decode()
        return f"unencrypted:{encoded}"

    try:
        key = bytes.fromhex(ENCRYPTION_KEY)
        iv = secrets.token_bytes(IV_LENGTH)

        aesgcm = AESGCM(key)
        # AESGCM.encrypt returns ciphertext + auth tag
        ciphertext = aesgcm.encrypt(iv, plaintext.encode(), None)

        # Return in format: iv:ciphertext (auth tag is part of ciphertext)
        return f"{iv.hex()}:{ciphertext.hex()}"
    except Exception as e:
        logger.error(f"Encryption error: {type(e).__name__}")
        raise ValueError("Failed to encrypt data")


def decrypt(encrypted_data: str) -> str:
    """
    Decrypt a string encrypted with AES-256-GCM

    Args:
        encrypted_data: Data in format: iv:ciphertext

    Returns:
        Decrypted plaintext
    """
    if not encrypted_data:
        raise ValueError("No data to decrypt")

    # Handle unencrypted fallback
    if encrypted_data.startswith("unencrypted:"):
        base64_data = encrypted_data[len("unencrypted:"):]
        return base64.b64decode(base64_data).decode()

    if not ENCRYPTION_KEY:
        raise ValueError("Encryption key not configured")

    try:
        parts = encrypted_data.split(":")

        # Handle both old format (iv:authTag:ciphertext) and new format (iv:ciphertext)
        if len(parts) == 3:
            # Old Node.js format: iv:authTag:ciphertext
            iv_hex, auth_tag_hex, ciphertext_hex = parts
            iv = bytes.fromhex(iv_hex)
            auth_tag = bytes.fromhex(auth_tag_hex)
            ciphertext = bytes.fromhex(ciphertext_hex)
            # Combine ciphertext + auth_tag for AESGCM
            ciphertext_with_tag = ciphertext + auth_tag
        elif len(parts) == 2:
            # New format: iv:ciphertext (with auth tag appended)
            iv_hex, ciphertext_hex = parts
            iv = bytes.fromhex(iv_hex)
            ciphertext_with_tag = bytes.fromhex(ciphertext_hex)
        else:
            raise ValueError("Invalid encrypted data format")

        key = bytes.fromhex(ENCRYPTION_KEY)
        aesgcm = AESGCM(key)

        plaintext = aesgcm.decrypt(iv, ciphertext_with_tag, None)
        return plaintext.decode()
    except Exception as e:
        logger.error(f"Decryption error: {type(e).__name__}")
        raise ValueError("Failed to decrypt data - invalid key or corrupted data")


def generate_encryption_key() -> str:
    """
    Generate a new encryption key

    Returns:
        32-byte key as hex string
    """
    return secrets.token_hex(32)


def hash_data(data: str) -> str:
    """
    Hash a string using SHA-256
    Useful for comparing values without storing originals

    Args:
        data: Data to hash

    Returns:
        Hash as hex string
    """
    return hashlib.sha256(data.encode()).hexdigest()


def generate_token(length: int = 32) -> str:
    """
    Generate a secure random token

    Args:
        length: Length of token in bytes (default 32)

    Returns:
        Random token as hex string
    """
    return secrets.token_hex(length)


def secure_compare(a: str, b: str) -> bool:
    """
    Constant-time string comparison to prevent timing attacks

    Args:
        a: First string
        b: Second string

    Returns:
        True if strings are equal
    """
    if not isinstance(a, str) or not isinstance(b, str):
        return False

    return hmac.compare_digest(a.encode(), b.encode())
