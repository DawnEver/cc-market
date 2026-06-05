"""Alert dispatch — email (Resend API or SMTP) and webhook (HTTP POST)."""

from __future__ import annotations

import json
import os
import smtplib
import urllib.request
from email.mime.text import MIMEText


def send_email(subject: str, body: str, config: dict,
               dry_run: bool = False) -> bool:
    cfg = config.get('alerts', {}).get('email', {})
    if not cfg.get('enabled') and not dry_run:
        return False

    to = cfg.get('to', '')
    if not to:
        return False

    prefix = cfg.get('subject_prefix', '[watch]')

    if dry_run:
        print(f'[DRYRUN] Email to={to} subject={prefix} {subject}')
        print(body[:200])
        return True

    method = cfg.get('method', 'smtp')
    if method == 'resend':
        return _send_resend(subject, body, cfg, prefix)
    return _send_smtp(subject, body, cfg, prefix)


def _send_resend(subject: str, body: str, cfg: dict, prefix: str) -> bool:
    """Send via Resend SDK (preferred) or HTTP API fallback."""
    api_key = os.environ.get('RESEND_API_KEY', cfg.get('api_key', ''))
    if not api_key:
        print('RESEND_API_KEY not set')
        return False

    params = {
        'from': cfg.get('from', 'watch@localhost'),
        'to': [cfg['to']],
        'subject': f'{prefix} {subject}',
        'html': body,
    }

    try:
        import resend
        resend.api_key = api_key
        result = resend.Emails.send(params)
        print(f'Email sent to {cfg["to"]} (resend: {result.get("id", "?")})')
        return True
    except ImportError:
        print('Resend SDK not installed (pip install resend)')
        return False
    except Exception as e:
        print(f'Resend send failed: {e}')
        return False


def _send_smtp(subject: str, body: str, cfg: dict, prefix: str) -> bool:
    """Send via SMTP."""
    host = cfg.get('host', 'localhost')
    port = cfg.get('port', 25)

    msg = MIMEText(body, 'html', 'utf-8')
    msg['Subject'] = f'{prefix} {subject}'
    msg['From'] = cfg.get('from', 'watch@localhost')
    msg['To'] = cfg['to']

    try:
        if cfg.get('use_tls'):
            s = smtplib.SMTP(host, port, timeout=15)
            s.starttls()
        else:
            s = smtplib.SMTP(host, port, timeout=15)
        if cfg.get('username'):
            s.login(cfg['username'], cfg.get('password', ''))
        s.sendmail(cfg['from'], [cfg['to']], msg.as_string())
        s.quit()
        print(f'Email sent to {cfg["to"]} (SMTP)')
        return True
    except Exception as e:
        print(f'SMTP send failed: {e}')
        return False


def send_webhook(config: dict, payload: dict, dry_run: bool = False) -> bool:
    cfg = config.get('alerts', {}).get('webhook', {})
    if not cfg.get('enabled') and not dry_run:
        return False

    url = cfg.get('url', '')
    if not url:
        return False

    if dry_run:
        print(f'[DRYRUN] Webhook {url}: {payload}')
        return True

    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(url, data=data, method='POST')
        req.add_header('Content-Type', 'application/json')
        headers = cfg.get('headers', {})
        if isinstance(headers, dict):
            for k, v in headers.items():
                req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f'Webhook sent: {resp.status}')
        return True
    except Exception as e:
        print(f'Webhook failed: {e}')
        return False
