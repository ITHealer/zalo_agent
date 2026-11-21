import html

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse

from app.api.dependencies import get_container, require_admin_token
from app.container import Container

router = APIRouter(prefix="/api/zalo", tags=["zalo"], dependencies=[Depends(require_admin_token)])


@router.get("/status")
async def get_gateway_status(container: Container = Depends(get_container)) -> dict:
    """Trạng thái kết nối Zalo do gateway công bố (null = gateway không chạy)."""
    gateway_status = await container.gateway_status_reader.get_status()
    return {"gateway": gateway_status}


@router.get("/qr", response_class=HTMLResponse)
async def show_login_qr_code(container: Container = Depends(get_container)) -> HTMLResponse:
    """Trang hiển thị QR đăng nhập (tự làm mới mỗi 15s). Mở bằng trình duyệt: /api/zalo/qr?token=..."""
    qr_code = await container.gateway_status_reader.get_qr_code()
    if not qr_code or not qr_code.get("image"):
        current_status = html.escape((qr_code or {}).get("status", "không cần đăng nhập"))
        body = f"<p>Hiện không có QR (trạng thái: {current_status}).</p>"
    else:
        image_base64 = qr_code["image"].removeprefix("data:image/png;base64,")
        generated_at = html.escape(str(qr_code.get("generatedAt", "")))
        current_status = html.escape(str(qr_code.get("status", "")))
        body = (
            "<h3>Quét bằng app Zalo của SỐ BOT</h3>"
            f'<img src="data:image/png;base64,{image_base64}" width="300"/>'
            f"<p>Tạo lúc {generated_at} - trạng thái: {current_status}</p>"
        )

    page = (
        '<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"></head>'
        f'<body style="font-family:sans-serif;text-align:center">{body}</body></html>'
    )
    return HTMLResponse(page)
