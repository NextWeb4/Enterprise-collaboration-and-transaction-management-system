"""Browser smoke against an empty, isolated data directory.

The caller starts the SPA/API pair, sets ``PORT`` to the API port and
``WEB_PORT`` to the SPA port.  The test
uses the browser for first-deployment administrator setup, so it validates the
internal-account flow without printing any credentials.
"""

import os
import re
import secrets
import subprocess
import time
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


base_url = f"http://127.0.0.1:{os.environ.get('WEB_PORT', '5173')}"
api_url = f"http://127.0.0.1:{os.environ.get('PORT', '3000')}"
repo_root = Path(__file__).resolve().parents[1]
server_entry = repo_root / "app" / "backend" / "dist" / "server.js"
login_button_name = re.compile(r"^\s*登\s*录\s*$")
greeting_heading = re.compile(r"^(早上好|中午好|下午好|晚上好)，浏览器验收管理员$")
admin_account = f"smokeadmin{int(time.time())}{secrets.token_hex(3)}"
member_account = f"smokemember{int(time.time())}{secrets.token_hex(3)}"
admin_password = f"{secrets.token_urlsafe(18)}Aa1!"
member_password = f"{secrets.token_urlsafe(18)}Bb2!"
updated_member_password = f"{secrets.token_urlsafe(18)}Cc3!"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    page.goto(base_url, wait_until="networkidle")
    try:
        page.get_by_role("heading", name="设置首个管理员").wait_for()
    except Exception:
        print(json.dumps({
            "url": page.url,
            "headings": page.locator("h1,h2,h3").all_text_contents(),
            "alerts": page.locator("[role=alert]").all_text_contents(),
            "pageErrors": page_errors,
            "setupStatus": page.evaluate(
                """async (url) => {
                  try {
                    const response = await fetch(url);
                    return { status: response.status, body: await response.text() };
                  } catch (error) { return { error: String(error) }; }
                }""",
                f"{api_url}/api/v1/setup/status",
            ),
        }, ensure_ascii=True))
        raise
    assert page.get_by_label("内部账号").count() == 1
    assert page.get_by_label("工作邮箱").count() == 0
    page.get_by_label("管理员姓名").fill("浏览器验收管理员")
    page.get_by_label("内部账号").fill(admin_account)
    page.get_by_label("管理员密码").fill(admin_password)
    page.get_by_label("确认密码").fill(admin_password)
    page.get_by_role("button", name="创建管理员").click()

    page.get_by_role("heading", name="企业协同与事务管理平台").wait_for()
    assert page.url.endswith("/login"), page.url
    health = page.request.get(f"{api_url}/health/ready")
    assert health.status == 200, f"ready status={health.status}, body={health.text()}"
    assert health.json()["data"]["ok"] is True, health.text()

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_load_state("networkidle")
    assert not page.evaluate("document.documentElement.scrollWidth > window.innerWidth"), "login page overflows at 390px"

    page.set_viewport_size({"width": 1280, "height": 900})
    page.get_by_label("内部账号").fill(admin_account)
    page.get_by_label("密码").fill(admin_password)
    page.get_by_role("button", name=login_button_name).click()
    page.get_by_role("heading", name=greeting_heading).wait_for()

    page.locator(".header-profile").click()
    page.get_by_role("heading", name="个人设置").wait_for()
    page.get_by_text(admin_account, exact=True).wait_for()

    page.get_by_role("link", name="文档中心").click()
    page.get_by_role("heading", name="文档中心").wait_for()
    page.get_by_role("link", name="内部账号").click()
    page.get_by_role("heading", name="内部账号").wait_for()
    page.get_by_label("姓名").fill("浏览器验收成员")
    page.get_by_label("内部账号").fill(member_account)
    page.get_by_label("初始密码", exact=True).fill(member_password)
    page.get_by_label("确认初始密码").fill(member_password)
    page.get_by_role("button", name="创建账号").click()
    page.get_by_text(f"账号 {member_account} 已创建", exact=True).wait_for()
    page.get_by_text(member_account, exact=True).wait_for()

    page.get_by_role("button", name="退出登录").click()
    page.get_by_role("heading", name="企业协同与事务管理平台").wait_for()
    page.get_by_label("内部账号").fill(member_account)
    page.get_by_label("密码").fill(member_password)
    page.get_by_role("button", name=login_button_name).click()
    page.get_by_role("heading", name="请先修改密码").wait_for()
    page.get_by_label("当前密码").fill(member_password)
    page.get_by_label("新密码", exact=True).fill(updated_member_password)
    page.get_by_label("确认新密码", exact=True).fill(updated_member_password)
    page.get_by_role("button", name="修改密码").click()
    page.get_by_role("heading", name=re.compile(r"^(早上好|中午好|下午好|晚上好)，浏览器验收成员$")).wait_for()

    assert not page_errors, page_errors
    browser.close()

second = subprocess.run(
    ["node", str(server_entry)],
    cwd=repo_root,
    env=os.environ.copy(),
    capture_output=True,
    text=True,
    encoding="utf-8",
    errors="replace",
    timeout=20,
    check=False,
)
assert second.returncode != 0, "second server process unexpectedly started"
second_output = (second.stdout or "") + (second.stderr or "")
assert "已有实例正在运行" in second_output, second_output
print("browser setup, internal-account login, forced password change, document entry, responsive layout, ready API, and second-instance rejection passed")
