"""Isolated browser smoke test. Builds are managed separately; never use existing data."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import re

from playwright.sync_api import expect, sync_playwright

HELPER = Path.home() / '.codex/skills/webapp-testing/scripts/with_server.py'


def browser_test(origin: str) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(f'{origin}/login')
            page.wait_for_load_state('networkidle')
            expect(page.get_by_role('heading', name='设置首个管理员')).to_be_visible()
            page.get_by_label('管理员姓名').fill('测试管理员')
            page.get_by_label('内部账号').fill('isolated-admin')
            page.get_by_label('管理员密码').fill('OnlyForTesting123!')
            page.get_by_label('确认密码').fill('OnlyForTesting123!')
            page.get_by_role('button', name='创建管理员').click()
            expect(page.get_by_role('button', name=re.compile(r'登\s*录'))).to_be_visible()
            page.get_by_label('内部账号').fill('isolated-admin')
            page.get_by_label('密码', exact=True).fill('OnlyForTesting123!')
            page.get_by_role('button', name=re.compile(r'登\s*录')).click()
            expect(page.get_by_role('link', name='项目与任务')).to_be_visible()
            print('PASS: first administrator and login', flush=True)

            page.get_by_role('link', name='项目与任务').click()
            page.get_by_role('button', name='新建项目').click()
            modal = page.get_by_role('dialog', name='新建项目')
            modal.get_by_label('项目名称').fill('隔离测试项目')
            modal.get_by_label('项目短键').fill('E2E')
            modal.get_by_role('button', name=re.compile(r'确定|OK')).click()
            page.get_by_role('button', name='隔离测试项目').click()
            page.get_by_role('button', name='进行中').click()
            page.get_by_role('dialog', name='项目进行中').get_by_role('button', name=re.compile(r'确定|OK')).click()
            expect(page.get_by_role('button', name='新建任务')).to_be_visible()
            page.get_by_role('button', name='新建任务').click()
            modal = page.get_by_role('dialog', name='新建任务')
            modal.get_by_label('任务名称').fill('隔离测试任务')
            modal.get_by_role('button', name=re.compile(r'确定|OK')).click()
            expect(page.get_by_text('E2E-1', exact=True)).to_be_visible()
            page.get_by_role('button', name='更新状态').click()
            modal = page.get_by_role('dialog', name='更新任务')
            modal.locator('.ant-select').click()
            page.get_by_title('已完成', exact=True).last.click()
            modal.get_by_label('进度（%）').fill('100')
            modal.get_by_role('button', name=re.compile(r'确定|OK')).click()
            expect(page.get_by_text('100%', exact=True)).to_be_visible()
            print('PASS: project creation, start, task creation and completion', flush=True)

            page.get_by_role('link', name='组织架构').click()
            page.get_by_role('button', name='新建部门').click()
            modal = page.get_by_role('dialog', name='新建部门')
            modal.get_by_label('部门名称').fill('隔离测试部门')
            modal.get_by_label('部门编码').fill('E2EDEP')
            modal.get_by_role('button', name=re.compile(r'确定|OK')).click()
            expect(page.get_by_text('隔离测试部门', exact=True)).to_be_visible()
            print('PASS: department creation', flush=True)
        finally:
            browser.close()


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == '--browser':
        browser_test(sys.argv[2])
        return
    with socket.socket() as port_probe:
        port_probe.bind(('127.0.0.1', 0))
        port = port_probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='collab-e2e-') as data_dir:
        env = dict(os.environ, DATA_DIR=data_dir, HOST='127.0.0.1', PORT=str(port), WEB_ORIGIN=origin, NODE_ENV='production')
        # The bundled helper leaves its shell child alive on Windows. Start the
        # Node process directly so the exact PID and LMDB handles are closed.
        server = subprocess.Popen(['node', '--import', 'tsx', 'app/backend/src/server.ts'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(150):
                if server.poll() is not None:
                    raise RuntimeError('isolated server exited before becoming ready')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError('isolated server did not become ready')
            browser_test(origin)
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
