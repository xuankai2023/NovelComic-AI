"""飞书加密事件解密。"""

import base64
import hashlib
import json
import logging
from typing import Any

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

from app.config import get_settings

log = logging.getLogger(__name__)

_IV_LENGTH = 16


def decrypt_feishu_payload(encrypt_str: str) -> dict[str, Any] | None:
    """解密飞书 body["encrypt"]，失败时返回 None。"""
    encrypt_key = get_settings().feishu_encrypt_key
    if not encrypt_key:
        log.error("FEISHU_ENCRYPT_KEY is not configured, cannot decrypt Feishu payload")
        return None

    try:
        raw = base64.b64decode(encrypt_str)
    except Exception as error:
        log.error("Failed to decode Feishu encrypted payload: %s", error)
        return None

    if len(raw) < _IV_LENGTH:
        log.error("Feishu encrypted payload is too short to contain an IV")
        return None

    try:
        key = hashlib.sha256(encrypt_key.encode("utf-8")).digest()
        iv = raw[:_IV_LENGTH]
        ciphertext = raw[_IV_LENGTH:]

        cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()
        padded_plaintext = decryptor.update(ciphertext) + decryptor.finalize()

        unpadder = PKCS7(algorithms.AES.block_size).unpadder()
        plaintext = unpadder.update(padded_plaintext) + unpadder.finalize()
        payload = json.loads(plaintext.decode("utf-8"))
    except Exception as error:
        log.error("Failed to decrypt Feishu payload: %s", error)
        return None

    if not isinstance(payload, dict):
        log.error("Feishu decrypted payload is not a JSON object")
        return None
    return payload
