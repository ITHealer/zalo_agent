from fastapi import APIRouter, Depends, Response, status

from app.api.dependencies import get_container
from app.container import Container
from app.schemas.responses import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def check_health(response: Response, container: Container = Depends(get_container)) -> HealthResponse:
    """Không cần token. Trả 503 nếu Postgres hoặc Redis không dùng được."""
    database_is_ok = True
    try:
        await container.database_pool.fetchval("SELECT 1")
    except Exception:
        database_is_ok = False

    redis_is_ok = True
    gateway_status = None
    try:
        await container.redis_client.ping()
        gateway_status = await container.gateway_status_reader.get_status()
    except Exception:
        redis_is_ok = False

    gateway_state = ((gateway_status or {}).get("zalo") or {}).get("state")
    is_healthy = database_is_ok and redis_is_ok
    if not is_healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return HealthResponse(
        status="ok" if is_healthy else "error",
        database=database_is_ok,
        redis=redis_is_ok,
        gateway_connected=gateway_state == "connected",
        gateway=gateway_status,
    )
