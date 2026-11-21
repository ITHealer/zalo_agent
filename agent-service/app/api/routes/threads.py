from fastapi import APIRouter, Depends, Query

from app.api.dependencies import get_container, require_admin_token
from app.container import Container
from app.schemas.responses import MessageResponse, ThreadResponse

router = APIRouter(prefix="/api/threads", tags=["threads"], dependencies=[Depends(require_admin_token)])


@router.get("", response_model=list[ThreadResponse])
async def list_threads(container: Container = Depends(get_container)) -> list[ThreadResponse]:
    """Các nhóm/hội thoại bot đã ghi nhận. Dùng để lấy group id cấu hình REPLY_GROUP_ALLOWLIST."""
    records = await container.thread_repository.list_all()
    return [ThreadResponse(**dict(record)) for record in records]


@router.get("/{thread_id}/messages", response_model=list[MessageResponse])
async def list_thread_messages(
    thread_id: str,
    limit: int = Query(default=50, ge=1, le=500),
    container: Container = Depends(get_container),
) -> list[MessageResponse]:
    records = await container.message_repository.list_by_thread(thread_id, limit)
    return [MessageResponse(**dict(record)) for record in records]
