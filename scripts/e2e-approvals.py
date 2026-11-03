"""True-browser OA smoke test through xb CLI; never opens existing application data.

Requires the configured xbrowser skill and a completed frontend build.
All credentials/data are temporary, every xb result is checked before continuing.
"""
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time

XB = Path(os.environ.get('APPROVAL_E2E_XB', str(Path.home() / '.codex/skills/xbrowser/scripts/xb.cjs')))
BROWSER = os.environ.get('APPROVAL_E2E_BROWSER', 'cft')


def command(*args: str) -> dict:
    result = subprocess.run(['node', str(XB), *args], capture_output=True, text=True, encoding='utf-8', timeout=45)
    payload = json.loads(result.stdout)
    if payload.get('awaits_user_input') or payload.get('data', {}).get('awaits_user_input'):
        raise RuntimeError('xbrowser requires user configuration; no choice was made automatically')
    if not payload.get('ok'):
        raise RuntimeError(f"xb command failed: {args[0:2]}: {payload.get('error', 'unknown failure')}")
    return payload


def xb(*args: str) -> dict:
    return command('run', '--browser', BROWSER, *args)


def inspect() -> str:
    xb('wait', '--load', 'networkidle')
    return json.dumps(xb('snapshot', '-i'), ensure_ascii=False)


def navigate(url: str) -> str:
    xb('open', url)
    return inspect()


def click(role: str, name: str) -> str:
    xb('find', 'role', role, 'click', '--name', name)
    return inspect()


def login(origin: str, account: str, password: str) -> None:
    state = navigate(f'{origin}/login')
    if '内部账号' not in state or '密码' not in state:
        raise RuntimeError('Expected the rendered login form')
    xb('find', 'label', '内部账号', 'fill', account)
    xb('find', 'label', '密码', 'fill', password)
    login_name = '登 录' if '登 录' in state else '登录'
    click('button', login_name)
    xb('wait', '--url', '**/app')


def browser_test(origin: str, password: str) -> None:
    command('init')
    # Open a dedicated task tab, without clearing any existing browser cookies.
    xb('tab', 'new', f'{origin}/login')
    try:
        inspect()
        login(origin, 'e2e-applicant', password)
        state = navigate(f'{origin}/app/applications/new')
        for label in ['标题', '主题', '事项说明', '保存草稿']:
            if label not in state:
                raise RuntimeError(f'Missing rendered application form field: {label}')
        xb('find', 'label', '标题', 'fill', '隔离浏览器审批闭环')
        xb('find', 'label', '主题', 'fill', '办公事务')
        xb('find', 'label', '事项说明', 'fill', '这是仅用于隔离浏览器验证的行政事务内容')
        click('button', '保存草稿')
        url_payload = xb('get', 'url')
        urls = re.findall(re.escape(origin) + r'/app/applications/[a-zA-Z0-9-]+', json.dumps(url_payload))
        if not urls or urls[0].endswith('/new'):
            raise RuntimeError('Draft was not created through the rendered form')
        application_url = urls[0]
        state = click('button', '提交审批')
        if '确认提交' not in state:
            raise RuntimeError('Submission confirmation was not rendered')
        click('button', '确 定' if '确 定' in state else 'OK')
        xb('wait', '--text', '审批中')
        print('PASS: applicant browser created and submitted a general application', flush=True)
        state = inspect()
        click('button', '退出登录' if '退出登录' in state else '退出')
        login(origin, 'e2e-approver', password)
        state = navigate(application_url)
        click('button', '通 过' if '通 过' in state else '通过')
        state = inspect()
        xb('find', 'label', '审批意见或原因', 'fill', '已核对申请材料，同意办理')
        click('button', '确 定' if '确 定' in state else 'OK')
        xb('wait', '--text', '已通过')
        xb('wait', '--text', '已核对申请材料，同意办理')
        print('PASS: a second browser-authenticated account approved and saw the immutable history', flush=True)
        state = inspect()
        click('button', '退出登录' if '退出登录' in state else '退出')
        login(origin, 'e2e-applicant', password)
        navigate(application_url)
        xb('wait', '--text', '已通过')
        xb('wait', '--text', '已核对申请材料，同意办理')
        print('PASS: applicant reopened the completed application and approval timeline', flush=True)
    finally:
        xb('tab', 'close')


def main() -> None:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    password = 'Ephemeral!' + secrets.token_hex(16)
    with tempfile.TemporaryDirectory(prefix='collab-e2e-approval-') as data_dir:
        env = dict(os.environ, DATA_DIR=data_dir, HOST='127.0.0.1', PORT=str(port), WEB_ORIGIN=origin, NODE_ENV='production', APPROVAL_E2E_PASSWORD=password)
        subprocess.run(['node', '--import', 'tsx', 'scripts/e2e-approvals-seed.ts'], env=env, check=True, timeout=30)
        server = subprocess.Popen(['node', '--import', 'tsx', 'app/backend/src/server.ts'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(150):
                if server.poll() is not None:
                    raise RuntimeError('Isolated server exited before becoming ready')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError('Isolated server did not become ready')
            browser_test(origin, password)
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
