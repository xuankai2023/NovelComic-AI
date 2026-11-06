"""Verification code email sender (Aliyun DirectMail / AWS SES / local dev log)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import urllib.parse
import uuid
from datetime import UTC, datetime

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

DOMESTIC_DOMAINS = {
    "qq.com",
    "163.com",
    "126.com",
    "yeah.net",
    "foxmail.com",
    "sina.com",
    "sina.cn",
    "sohu.com",
    "139.com",
    "189.cn",
    "aliyun.com",
}


class EmailService:
    @classmethod
    def is_domestic_email(cls, email: str) -> bool:
        parts = email.strip().lower().split("@")
        if len(parts) != 2:
            return False
        domain = parts[1]
        return domain in DOMESTIC_DOMAINS or domain.endswith(".cn")

    @classmethod
    async def send_verification_code(
        cls,
        email: str,
        code: str,
        code_type: str = "login",
    ) -> bool:
        settings = get_settings()
        subject = (
            f"【{settings.aliyun_dm_from_alias or 'NovelComic'}】您的登录验证码：{code}"
            if code_type == "login"
            else f"【{settings.aliyun_dm_from_alias or 'NovelComic'}】您的注册验证码：{code}"
        )
        html_body = (
            f"<div style='font-family:sans-serif;padding:24px;'>"
            f"<h2>验证码：{code}</h2>"
            f"<p>您正在进行{'登录' if code_type == 'login' else '注册'}操作，验证码 5 分钟内有效，请勿泄露给他人。</p>"
            f"</div>"
        )

        if (
            settings.aliyun_dm_access_key_id
            and settings.aliyun_dm_access_key_secret
            and settings.aliyun_dm_account_name
        ):
            return await cls._send_via_aliyun_dm(
                email=email,
                subject=subject,
                html_body=html_body,
                access_key_id=settings.aliyun_dm_access_key_id,
                access_key_secret=settings.aliyun_dm_access_key_secret,
                account_name=settings.aliyun_dm_account_name,
                from_alias=settings.aliyun_dm_from_alias or "NovelComic",
                region=settings.aliyun_dm_region or "cn-hangzhou",
            )

        log.info(
            "Email provider not configured; logged verification code locally: email=%s code=%s type=%s",
            email,
            code,
            code_type,
        )
        return True

    @classmethod
    async def _send_via_aliyun_dm(
        cls,
        *,
        email: str,
        subject: str,
        html_body: str,
        access_key_id: str,
        access_key_secret: str,
        account_name: str,
        from_alias: str,
        region: str,
    ) -> bool:
        params = {
            "Action": "SingleSendMail",
            "AccountName": account_name,
            "AddressType": "1",
            "ReplyToAddress": "false",
            "ToAddress": email,
            "FromAlias": from_alias,
            "Subject": subject,
            "HtmlBody": html_body,
            "Format": "JSON",
            "Version": "2015-11-23",
            "AccessKeyId": access_key_id,
            "SignatureMethod": "HMAC-SHA1",
            "Timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "SignatureVersion": "1.0",
            "SignatureNonce": str(uuid.uuid4()),
            "RegionId": region,
        }
        sorted_query = "&".join(
            f"{cls._percent_encode(k)}={cls._percent_encode(v)}"
            for k, v in sorted(params.items())
        )
        string_to_sign = f"POST&%2F&{cls._percent_encode(sorted_query)}"
        digest = hmac.new(
            f"{access_key_secret}&".encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha1,
        ).digest()
        params["Signature"] = base64.b64encode(digest).decode("utf-8")

        endpoint = "https://dm.aliyuncs.com/"
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(endpoint, data=params)
            if response.status_code >= 400:
                log.error(
                    "Aliyun DirectMail failed: status=%s body=%s",
                    response.status_code,
                    response.text,
                )
                return False
        return True

    @staticmethod
    def _percent_encode(value: str) -> str:
        return urllib.parse.quote(str(value), safe="~")
