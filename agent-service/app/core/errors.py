class AgentServiceError(Exception):
    """Lỗi nghiệp vụ. is_retryable cho biết có nên thử lại job hay không."""

    is_retryable = True


class RetryableError(AgentServiceError):
    is_retryable = True


class PermanentError(AgentServiceError):
    is_retryable = False


class OpenWebUIError(AgentServiceError):
    def __init__(self, message: str, is_retryable: bool = True):
        super().__init__(message)
        self.is_retryable = is_retryable
