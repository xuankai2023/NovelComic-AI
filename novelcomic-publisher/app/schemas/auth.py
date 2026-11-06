"""登录与 JWT 接口模型。"""

from pydantic import BaseModel, Field, field_validator


def _normalize_email(value: str) -> str:
    email = value.strip().lower()
    if "@" not in email:
        raise ValueError("Invalid email")
    return email


class SendCodeRequest(BaseModel):
    email: str
    fp_hash: str
    fp_time: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return _normalize_email(value)


class SendCodeResponse(BaseModel):
    email: str
    code_type: str
    expires_in: int


class LoginWithCodeRequest(BaseModel):
    email: str
    code: str = Field(min_length=6, max_length=6)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return _normalize_email(value)


class LoginResponse(BaseModel):
    ticket: str
    user_id: str


class RegisterWithCodeRequest(BaseModel):
    email: str
    code: str = Field(min_length=6, max_length=6)
    source: str | None = None
    invite_code: str | None = None

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return _normalize_email(value)


class RegisterResponse(BaseModel):
    sign_in_token: str
    expires_in: int
    user_id: str


class LoginWithPasswordRequest(BaseModel):
    email: str
    password: str = Field(min_length=1)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return _normalize_email(value)


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8)


class ChangePasswordResponse(BaseModel):
    success: bool = True
    message: str = "密码修改成功"
