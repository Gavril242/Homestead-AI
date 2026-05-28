#!/usr/bin/env python3
"""
Browser automation via browser-use.
Modes:
  python3 browser_task.py "task description"          → run a browser task, return JSON result
  python3 browser_task.py --screenshot "http://url"   → capture a screenshot of a URL, return base64
  python3 browser_task.py --compare before.b64 "task" → run task, then compare before/after screenshots

Env: LLM_API_KEY, LLM_BASE_URL (optional), LLM_MODEL (optional)
Output: JSON to stdout
Install: pip install browser-use && playwright install chromium
"""
import asyncio, json, sys, os, traceback, base64

async def capture_screenshot(url: str) -> dict:
    """Capture a screenshot of a URL without running an agent task."""
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": 1280, "height": 800})
            await page.goto(url, wait_until="networkidle", timeout=15000)
            screenshot_bytes = await page.screenshot(full_page=False)
            await browser.close()
            return {
                "success": True,
                "screenshot_b64": base64.b64encode(screenshot_bytes).decode(),
                "url": url,
            }
    except ImportError:
        return {"success": False, "error": "playwright not installed. Run: playwright install chromium"}
    except Exception:
        return {"success": False, "error": traceback.format_exc()}


async def run_task(task: str) -> dict:
    """Run an AI-driven browser task."""
    try:
        import httpx
        from browser_use import Agent
        from browser_use.browser.profile import BrowserProfile
        from browser_use.browser.session import BrowserSession
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            base_url=os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1"),
            api_key=os.environ["LLM_API_KEY"],
            model=os.environ.get("LLM_MODEL", "gpt-4o"),
            http_client=httpx.Client(verify=False),
            http_async_client=httpx.AsyncClient(verify=False),
        )
        profile = BrowserProfile(headless=True)
        session = BrowserSession(browser_profile=profile)
        agent = Agent(task=task, llm=llm, browser=session)
        history = await agent.run(max_steps=20)

        screenshots = history.screenshots() if hasattr(history, 'screenshots') else []
        last_screenshot = screenshots[-1] if screenshots else None

        return {
            "success": history.is_successful() if hasattr(history, 'is_successful') else None,
            "done": history.is_done() if hasattr(history, 'is_done') else True,
            "result": history.final_result() if hasattr(history, 'final_result') else str(history),
            "steps": len(history.history) if hasattr(history, 'history') else 0,
            "screenshot_b64": last_screenshot,
            "errors": [],
        }
    except ImportError as e:
        return {
            "success": False, "done": False, "result": None,
            "error": f"browser-use not installed: {e}. Run: pip install browser-use && playwright install chromium",
        }
    except Exception:
        return {"success": False, "done": False, "result": None, "error": traceback.format_exc()}


if __name__ == "__main__":
    args = sys.argv[1:]

    if not args:
        print(json.dumps({"error": "Usage: browser_task.py <task> | --screenshot <url>"}))
        sys.exit(1)

    if args[0] == "--screenshot" and len(args) >= 2:
        # Capture screenshot mode: return base64 PNG
        output = asyncio.run(capture_screenshot(args[1]))
    else:
        # Standard task mode
        task = args[0]
        output = asyncio.run(run_task(task))

    print(json.dumps(output))
