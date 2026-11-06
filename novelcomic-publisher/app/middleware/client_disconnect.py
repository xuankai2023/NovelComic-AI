"""客户端已经断开时，不再把“没有响应”当成服务端错误。"""

from starlette.requests import Request

NO_RESPONSE_RETURNED_ERROR = "No response returned."


async def is_no_response_returned_for_disconnected_client(
    request: Request, exc: RuntimeError
) -> bool:
    if str(exc) != NO_RESPONSE_RETURNED_ERROR:
        return False

    try:
        return await request.is_disconnected()
    except Exception:
        return False
