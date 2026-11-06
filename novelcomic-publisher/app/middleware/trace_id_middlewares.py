"""每个 HTTP 请求新造一张 trace id，写进响应头。不读入站头。"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.common.context.request_context import RequestContext
from app.middleware.client_disconnect import is_no_response_returned_for_disconnected_client


class TraceIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        from app.utils.id_utils import generate_trace_id

        trace_id = generate_trace_id()
        request.state.trace_id = trace_id
        RequestContext.set_trace_id(trace_id)

        # SDK 还没安装或还没初始化时，这次请求仍然要成功。
        try:
            import sentry_sdk

            sentry_sdk.set_tag("trace_id", trace_id)
            sentry_sdk.set_context("request_trace", {"trace_id": trace_id})
        except Exception:
            pass

        try:
            response = await call_next(request)
        except RuntimeError as exc:
            if await is_no_response_returned_for_disconnected_client(request, exc):
                return Response(status_code=204)
            raise

        response.headers["X-Trace-ID"] = trace_id
        return response
