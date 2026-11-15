import argparse
import html
import json
import os
import random
import re
import smtplib
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


def area_of(question_id):
    return question_id.split('-')[0]


def get_questions(area):
    content = Path(AREAS[area]['toc']).read_text(encoding='utf-8')
    # - [질문](contents/fe-1.md) 매칭
    pattern = re.compile(rf'-\s*\[(.*?)\]\(contents/({area}-\d+)\.md\)')
    # 제목의 마크다운 이스케이프(\<a> 등)를 벗긴다
    return [(re.sub(r'\\([!-/:-@\[-`{-~])', r'\1', title), file_id)
            for title, file_id in pattern.findall(content)]  # [ (질문제목, "fe-1"), ... ]


def load_sent():
    """지금까지 보낸 질문 ID 목록을 보낸 순서대로 돌려준다."""
    if Path(PROGRESS_FILE).exists():
        return json.loads(Path(PROGRESS_FILE).read_text(encoding='utf-8'))['sent']
    return []


def save_sent(sent):
    data = {'sent': sent}
    Path(PROGRESS_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def pick_question(sent):
    """아직 보내지 않은 질문 중 하나를 무작위로 고른다."""
    sent_ids = set(sent)
    remaining = {
        area: [q for q in get_questions(area) if q[1] not in sent_ids]
        for area in AREAS
    }

    if remaining['fe'] and remaining['be']:
        area = 'be' if random.random() < BACKEND_PROBABILITY else 'fe'
    elif remaining['fe']:
        area = 'fe'
    elif remaining['be']:
        area = 'be'
    else:
        return None

    return random.choice(remaining[area])


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
    args = parser.parse_args()

    sent = load_sent()
    picked = pick_question(sent)

    if picked is None:
        print("모든 질문 발송을 완료했습니다!")
        return

    title, file_id = picked
    send_mail(file_id, title, no_mail=args.no_mail)
    save_sent(sent + [file_id])


if __name__ == '__main__':
    main()
