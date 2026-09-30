from __future__ import annotations


class ApplianceConfigError(ValueError):
    """Raised when an appliance config is invalid.

    ``path`` addresses the failing field inside the config document (e.g.
    ``devices.consumers[0].controls``) so the editor can point at it.
    """

    def __init__(self, path: str, detail: str) -> None:
        super().__init__(f"{path} {detail}")
        self.path = path
