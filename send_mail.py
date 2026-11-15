import argparse
import html
import json
import os
import random
import re
import smtplib
from datetime import date, datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# 설정
PROGRESS_FILE = 'progress.json'
TEMPLATE_FILE = 'mail_template.html'

# 영역별 목차와 이름. 질문 ID 접두어(fe, be)로 영역을 구분한다.
AREAS = {
    'fe': {'toc': 'frontend/toc.md', 'name': '프론트엔드'},
    'be': {'toc': 'backend/toc.md', 'name': '백엔드'},
}
# 두 영역 모두 남은 질문이 있을 때 백엔드 질문을 보낼 확률
BACKEND_PROBABILITY = 0.2
# 앞으로 보낼 질문을 발송일 몇 번만큼 미리 정해 둘지.
# 앱은 미리 정해 둔 질문으로 알림을 띄우므로, Actions가 늦거나 하루 이틀 빠져도 알림은 제때 온다.
DAYS_AHEAD = 3
# 날짜는 모두 한국 시간 기준이다. Actions 서버는 UTC로 돌아서 그대로 쓰면 하루 전 날짜가 나온다.
# 한국은 서머타임이 없어 고정된 +9시간으로 충분하다.
KST = timezone(timedelta(hours=9))


def area_of(question_id):
    return question_id.split('-')[0]


def get_questions(area):
    content = Path(AREAS[area]['toc']).read_text(encoding='utf-8')
    # - [질문](contents/fe-1.md) 매칭
    pattern = re.compile(rf'-\s*\[(.*?)\]\(contents/({area}-\d+)\.md\)')
    # 제목의 마크다운 이스케이프(\<a> 등)를 벗긴다
    return [(re.sub(r'\\([!-/:-@\[-`{-~])', r'\1', title), file_id)
            for title, file_id in pattern.findall(content)]  # [ (질문제목, "fe-1"), ... ]


def get_titles():
    """{질문 ID: 제목}"""
    return {file_id: title for area in AREAS for title, file_id in get_questions(area)}


# ---------- progress.json ----------
# {
#   "sent": ["fe-1", ...],                          지금까지 보낸 질문 ID (보낸 순서대로)
#   "today": {"date": "2026-11-17", "id": "fe-77"}, 가장 최근에 보낸 질문과 그 발송일
#   "next": {"2026-11-18": "be-22", ...}            앞으로 보낼 질문 (발송일 DAYS_AHEAD번만큼)
# }
# 웹과 앱은 next와 today로 오늘의 질문을 찾고, 앱은 next로 알림을 미리 예약한다.

def load_progress():
    data = {}
    if Path(PROGRESS_FILE).exists():
        data = json.loads(Path(PROGRESS_FILE).read_text(encoding='utf-8'))
    return {
        'sent': data.get('sent', []),
        'today': data.get('today'),
        'next': data.get('next', {}),
    }


def save_progress(progress):
    data = {
        'sent': progress['sent'],
        'today': progress['today'],
        'next': dict(sorted(progress['next'].items())),
    }
    Path(PROGRESS_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def pick_question(progress):
    """보낸 적도 없고 앞으로 보낼 예정도 아닌 질문 중 하나를 무작위로 골라 ID를 돌려준다.
    이번 바퀴에 남은 질문이 없으면 다음 바퀴(처음부터 다시) 질문을 고른다.
    sent는 다음 바퀴의 첫 질문을 실제로 보낼 때 비운다 (record_sent)."""
    upcoming = set(progress['next'].values())
    if progress['today']:
        upcoming.add(progress['today']['id'])  # 다시 시작하자마자 방금 보낸 질문이 또 나오지 않도록

    for taken in (set(progress['sent']) | upcoming, upcoming):
        remaining = {
            area: [file_id for _, file_id in get_questions(area) if file_id not in taken]
            for area in AREAS
        }

        if remaining['fe'] and remaining['be']:
            area = 'be' if random.random() < BACKEND_PROBABILITY else 'fe'
        elif remaining['fe']:
            area = 'fe'
        elif remaining['be']:
            area = 'be'
        else:
            continue

        return random.choice(remaining[area])
    return None  # 질문이 DAYS_AHEAD개보다 적을 때만 생긴다


def record_sent(progress, file_id, all_ids):
    """보낸 질문을 sent에 더한다. 모든 질문을 이미 보냈다면 sent를 비우고 처음부터 다시 센다."""
    if set(all_ids) <= set(progress['sent']):
        print("모든 질문을 보냈습니다. 처음부터 다시 시작합니다.")
        progress['sent'] = []
    progress['sent'].append(file_id)


def next_mail_dates(after, count):
    """after 다음 날부터 발송일 count개"""
    return [after + timedelta(days=i) for i in range(1, count + 1)]


def run(progress, today, no_mail=False):
    """오늘 보낼 질문을 보내고, 앞으로 보낼 질문을 다시 정한다."""
    key = today.isoformat()
    titles = get_titles()

    # 정해 둔 오늘 질문도 없고 오늘 보낸 질문도 없으면 (새 방식으로 처음 실행하는 날 등) 지금 정한다
    sent_today = progress['today'] and progress['today']['date'] == key
    if key not in progress['next'] and not sent_today:
        picked = pick_question(progress)
        if picked:
            progress['next'][key] = picked

    # 오늘까지 보낼 질문을 날짜 순서대로 보낸다. 실행이 빠진 날의 질문도 함께 보낸다.
    for day in sorted(d for d in progress['next'] if d <= key):
        file_id = progress['next'].pop(day)
        if file_id not in titles:
            print(f"[{file_id.upper()}] 목차에 없는 질문이라 건너뜁니다.")
            continue
        send_mail(file_id, titles[file_id], no_mail=no_mail)
        record_sent(progress, file_id, titles)
        progress['today'] = {'date': day, 'id': file_id}
        save_progress(progress)  # 다음 메일이 실패해도 여기까지 보낸 기록은 남긴다

    # 앞으로 보낼 질문을 다시 정한다.
    # 가장 가까운 발송일 질문은 앱이 이미 알림으로 예약했을 수 있으므로 그대로 두고, 나머지만 새로 뽑는다.
    if progress['next']:
        fixed = min(progress['next'])
        progress['next'] = {fixed: progress['next'][fixed]}
        dates = next_mail_dates(date.fromisoformat(fixed), DAYS_AHEAD - 1)
    else:
        dates = next_mail_dates(today, DAYS_AHEAD)

    for day in dates:
        picked = pick_question(progress)
        if picked is None:
            print("남은 질문이 없어 더 정하지 못했습니다.")
            break
        progress['next'][day.isoformat()] = picked

    save_progress(progress)


def send_mail(file_id, title, no_mail=False):
    """질문 하나를 메일로 보낸다. no_mail이면 보내지 않고 보낼 내용만 출력한다."""
    if no_mail:
        print(f"[{file_id.upper()}] (메일 보내지 않음) {title}")
        return

    # 환경변수로부터 읽어올 값들 (발송할 때만 필요하다)
    email_user = os.environ['EMAIL_USER']
    email_password = os.environ['EMAIL_PASSWORD']
    receiver_email = os.environ['RECEIVER_EMAIL']
    pages_url = os.environ.get('PAGES_URL', '').rstrip('/')  # 예: https://your-id.github.io/your-repo

    area_name = AREAS[area_of(file_id)]['name']
    viewer_url = f"{pages_url}/questions/?q={file_id}" if pages_url else "#"

    # HTML 템플릿 치환
    template = Path(TEMPLATE_FILE).read_text(encoding='utf-8')
    html_body = template.replace('{{question_area}}', area_name)
    html_body = html_body.replace('{{question_id}}', file_id.upper())  # 예: FE-46
    html_body = html_body.replace('{{question_title}}', html.escape(title))
    html_body = html_body.replace('{{viewer_url}}', viewer_url)

    # 이메일 메시지 생성
    msg = MIMEMultipart('alternative')
    msg['Subject'] = f"[매일메일] {title}"
    msg['From'] = f"매일메일 <{email_user}>"
    msg['To'] = receiver_email
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    # 발송
    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(email_user, email_password)
        server.sendmail(email_user, receiver_email, msg.as_string())

    print(f"[{file_id.upper()}] 발송 성공: {title}")


def main():
    parser = argparse.ArgumentParser(description='오늘의 면접 질문을 메일로 보내고 progress.json을 갱신한다.')
    parser.add_argument('--no-mail', action='store_true',
                        help='메일은 보내지 않고 보낼 내용만 출력한다. progress.json은 그대로 갱신한다 (확인용)')
    parser.add_argument('--date', type=date.fromisoformat,
                        help='오늘을 이 날짜(YYYY-MM-DD, 한국 시간)로 보고 실행한다 (확인용)')
    args = parser.parse_args()

    today = args.date or datetime.now(KST).date()
    run(load_progress(), today, no_mail=args.no_mail)


if __name__ == '__main__':
    main()
