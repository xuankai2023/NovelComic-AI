"""飞书事件订阅相关数据模型。"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class FeishuEventHeader(BaseModel):
    event_id: str = Field(description="事件 ID")
    event_type: str = Field(description="事件类型")
    create_time: str = Field(description="事件创建时间戳")
    token: str = Field(description="验证 token")
    app_id: str = Field(description="应用 ID")
    tenant_key: str = Field(description="租户 key")


class FeishuMessageSender(BaseModel):
    sender_id: dict[str, Any] = Field(default_factory=dict, description="发送者 ID 信息")
    sender_type: str = Field(default="", description="发送者类型")
    tenant_key: str = Field(default="", description="租户 key")


class FeishuMessageMention(BaseModel):
    key: str = Field(description="@ 的 key")
    id: dict[str, Any] = Field(default_factory=dict, description="被 @ 的用户 ID")
    name: str = Field(description="被 @ 的用户名称")
    tenant_key: str = Field(default="", description="租户 key")


class FeishuMessage(BaseModel):
    message_id: str = Field(description="消息 ID")
    root_id: str | None = Field(default=None, description="根消息 ID")
    parent_id: str | None = Field(default=None, description="父消息 ID")
    create_time: str = Field(description="消息创建时间戳")
    update_time: str | None = Field(default=None, description="消息更新时间戳")
    chat_id: str = Field(description="群聊 ID")
    chat_type: str = Field(description="聊天类型")
    message_type: str = Field(description="消息类型")
    content: str = Field(description="消息内容 JSON 字符串")
    mentions: list[FeishuMessageMention] | None = Field(default=None, description="@ 信息列表")


class FeishuMessageEvent(BaseModel):
    sender: FeishuMessageSender = Field(description="发送者信息")
    message: FeishuMessage = Field(description="消息信息")


class FeishuEventCallback(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    schema_field: str | None = Field(default=None, alias="schema", description="数据格式版本")
    header: FeishuEventHeader | None = Field(default=None, description="事件头部")
    event: dict[str, Any] | None = Field(default=None, description="事件内容")
    challenge: str | None = Field(default=None, description="URL 验证 challenge")
    token: str | None = Field(default=None, description="验证 token")
    type: str | None = Field(default=None, description="请求类型")


class UpdatePlanCommand(BaseModel):
    email: str = Field(description="用户邮箱")
    plan: Literal["starter", "creator", "pro"] = Field(description="目标套餐")


class AddCreditsCommand(BaseModel):
    email: str = Field(description="用户邮箱")
    credits: int = Field(gt=0, description="积分数量")
    remark: str = Field(min_length=1, description="备注")
