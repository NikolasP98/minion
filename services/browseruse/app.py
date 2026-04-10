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


@app.post("/browse", response_model=BrowseResponse)
async def browse(req: BrowseRequest) -> BrowseResponse:
    """Execute a browser automation task using BrowserUse + claude-haiku-4-5.

    Security:
    - url_hint host is checked against private/internal IP ranges.
    - max_steps capped at _MAX_STEPS (env: BROWSERUSE_MAX_STEPS, default 10).
    - Hard timeout via asyncio.wait_for (env: BROWSERUSE_TIMEOUT_SECONDS, default 30).
    """
    from anthropic import Anthropic
    from browser_use import Agent, Browser, BrowserConfig

    # Validate url_hint host before doing anything
    if req.url_hint:
        from urllib.parse import urlparse

        parsed = urlparse(req.url_hint if "://" in req.url_hint else f"https://{req.url_hint}")
        host = parsed.hostname or ""
        if not host or _is_blocked_host(host):
            raise HTTPException(
                status_code=400,
                detail=f"url_hint host '{host}' is blocked (internal/private address).",
            )

    max_steps = min(req.max_steps or _MAX_STEPS, _MAX_STEPS)
    timeout_secs = min(req.timeout_seconds or _HARD_TIMEOUT_SECONDS, _HARD_TIMEOUT_SECONDS)

    browser = _playwright_ctx["browser"]

    llm_client = Anthropic(api_key=_ANTHROPIC_API_KEY)

    steps_log: list[BrowseStep] = []

    async def _run() -> BrowseResponse:
        context = await browser.new_context()
        page = await context.new_page()

        # Intercept requests to block internal hosts at the network level
        async def _handle_route(route, request):
            from urllib.parse import urlparse as _up
            host = _up(request.url).hostname or ""
            if _is_blocked_host(host):
                await route.abort()
                return
            await route.continue_()

        await page.route("**/*", _handle_route)

        if req.url_hint:
            url = req.url_hint if "://" in req.url_hint else f"https://{req.url_hint}"
            await page.goto(url)

        agent = Agent(
            task=req.task,
            llm=llm_client,
            model="claude-haiku-4-5-20251001",
            browser=Browser(config=BrowserConfig(browser=browser)),
            max_steps=max_steps,
        )

        step_counter = 0

        async def _on_step(step_info):
            nonlocal step_counter
            step_counter += 1
            steps_log.append(
                BrowseStep(
                    step=step_counter,
                    action=str(step_info.get("action", "")),
                    url=page.url,
                )
            )

        agent.register_step_callback(_on_step)

        result = await agent.run()

        # Capture final screenshot
        screenshot_bytes = await page.screenshot(type="png")
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode()

        final_url = page.url
        content = result.final_result() if hasattr(result, "final_result") else str(result)

        await context.close()

        return BrowseResponse(
            success=True,
            final_url=final_url,
            content=content,
            screenshot=screenshot_b64,
            steps=steps_log,
        )

    try:
        return await asyncio.wait_for(_run(), timeout=timeout_secs)
    except asyncio.TimeoutError:
        return BrowseResponse(
            success=False,
            final_url="",
            content="",
            screenshot="",
            steps=steps_log,
            error=f"Task timed out after {timeout_secs}s",
        )
    except Exception as exc:
        return BrowseResponse(
            success=False,
            final_url="",
            content="",
            screenshot="",
            steps=steps_log,
            error=str(exc),
        )
