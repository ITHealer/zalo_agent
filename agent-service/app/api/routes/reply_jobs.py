from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.dependencies import get_container, require_admin_token
from app.container import Container
from app.core.contracts import ReplyStatus, Streams
from app.schemas.responses import (
    ActionResponse,
    OutboxItemResponse,
    ReplyJobDetailResponse,
    ReplyJobResponse,
    ReplyJobSummaryResponse,
)

router = APIRouter(prefix="/api/reply-jobs", tags=["reply-jobs"], dependencies=[Depends(require_admin_token)])


@router.get("", response_model=ReplyJobSummaryResponse)
async def list_reply_jobs(
    status_filter: ReplyStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=500),
    container: Container = Depends(get_container),
) -> ReplyJobSummaryResponse:
    jobs = await container.reply_job_repository.list_jobs(status_filter, limit)
    counts = await container.reply_job_repository.count_by_status()
    return ReplyJobSummaryResponse(
        counts_by_status=counts,
        jobs=[ReplyJobResponse(**asdict(job)) for job in jobs],
    )


@router.get("/{msg_id}", response_model=ReplyJobDetailResponse)
async def get_reply_job(msg_id: str, container: Container = Depends(get_container)) -> ReplyJobDetailResponse:
    job = await container.reply_job_repository.find_by_id(msg_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy reply job")
    outbox_records = await container.outbox_repository.list_by_reply(msg_id)
    return ReplyJobDetailResponse(
        **asdict(job),
        outbox=[OutboxItemResponse(**dict(record)) for record in outbox_records],
    )


@router.post("/{msg_id}/retry", response_model=ActionResponse)
async def retry_reply_job(msg_id: str, container: Container = Depends(get_container)) -> ActionResponse:
    """Thử lại job đã failed/skipped: hỏi lại agent từ đầu và gửi lại."""
    was_reset = await container.reply_job_repository.reset_for_manual_retry(msg_id)
    if not was_reset:
        raise HTTPException(status.HTTP_409_CONFLICT, "Chỉ thử lại được job ở trạng thái failed hoặc skipped")
    await container.outbox_repository.delete_unsent(msg_id)
    await container.stream_publisher.publish(Streams.REPLY_REQUESTS, {"msg_id": msg_id})
    return ActionResponse(ok=True, message="Đã đưa job vào hàng xử lý lại")
