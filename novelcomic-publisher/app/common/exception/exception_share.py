"""Share domain exceptions."""


class ShareError(Exception):
    status_code = 400
    response_code = 1003


class ShareSourceNotFoundError(ShareError):
    status_code = 404
    response_code = 1042


class ShareNotFoundError(ShareError):
    status_code = 404
    response_code = 1040


class ShareEmailNotAllowedError(ShareError):
    status_code = 403
    response_code = 1041
