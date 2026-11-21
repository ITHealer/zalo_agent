import secrets

from fastapi import Header, HTTPException, Query, Request, status

from app.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container


def require_admin_token(
    request: Request,
    x_api_token: str | None = Header(default=None),
    token: str | None = Query(default=None, description="Dùng khi mở bằng trình duyệt, vd trang QR"),
) -> None:
    """Bảo vệ /api/*: so khớp ADMIN_API_TOKEN qua header X-API-Token hoặc query ?token=."""
    expected_token = get_container(request).settings.admin_api_token
    if not expected_token:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Chưa cấu hình ADMIN_API_TOKEN")

    provided_token = x_api_token or token or ""
    if not secrets.compare_digest(provided_token, expected_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sai hoặc thiếu API token")
