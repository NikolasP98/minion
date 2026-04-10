"""BrowserUse microservice — headless browser automation via LLM step planner."""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import os
import re
import socket
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from playwright.async_api import async_playwright
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
_MAX_STEPS = int(os.environ.get("BROWSERUSE_MAX_STEPS", "10"))
_HARD_TIMEOUT_SECONDS = int(os.environ.get("BROWSERUSE_TIMEOUT_SECONDS", "30"))

# Deny patterns: private/loopback ranges + cluster-internal patterns
_BLOCKED_PATTERNS: list[str] = [
    r"^localhost$",
    r"^127\.",
    r"^10\.",
    r"^172\.(1[6-9]|2[0-9]|3[01])\.",
    r"^192\.168\.",
    r"^::1$",
    r"\.svc\.cluster\.local$",
    r"\.cluster\.local$",
    r"^0\.0\.0\.0$",
    r"^169\.254\.",  # link-local
    r"^fc[0-9a-f][0-9a-f]:",  # IPv6 ULA
    r"^fd[0-9a-f][0-9a-f]:",  # IPv6 ULA
]
_BLOCKED_REGEXES = [re.compile(p, re.IGNORECASE) for p in _BLOCKED_PATTERNS]


# ---------------------------------------------------------------------------
# Domain guard
# ---------------------------------------------------------------------------


def _is_blocked_host(host: str) -> bool:
    """Return True if host resolves to or looks like a private/internal address."""
    for rx in _BLOCKED_REGEXES:
        if rx.search(host):
            return True
    # Also resolve and check the IP
    try:
        ip_str = socket.gethostbyname(host)
        ip = ipaddress.ip_address(ip_str)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return True
    except (socket.gaierror, ValueError):
        pass
    return False


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------


class BrowseRequest(BaseModel):
    task: str
    url_hint: Optional[str] = None
    max_steps: Optional[int] = None
    timeout_seconds: Optional[int] = None


class BrowseStep(BaseModel):
    step: int
    action: str
    url: str


class BrowseResponse(BaseModel):
    success: bool
    final_url: str
    content: str
    screenshot: str  # base64-encoded PNG
    steps: list[BrowseStep]
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Lifespan (Playwright startup)
# ---------------------------------------------------------------------------

_playwright_ctx: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    pw = await async_playwright().start()
    browser = await pw.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )
    _playwright_ctx["pw"] = pw
    _playwright_ctx["browser"] = browser
    yield
    await browser.close()
    await pw.stop()


app = FastAPI(title="browseruse-service", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/healthz")
def health() -> dict:
    return {"status": "ok"}
