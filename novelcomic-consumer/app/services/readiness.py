from app.database.connections import Connections
from app.schemas.health import ReadinessResponse


async def get_readiness(connections: Connections) -> tuple[ReadinessResponse, int]:
    checks = await connections.checks()
    ready = all(checks.values())
    return (
        ReadinessResponse(status="ready" if ready else "not_ready", checks=checks),
        200 if ready else 503,
    )
