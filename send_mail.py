import os
import re
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

# 설정
PROGRESS_FILE = 'progress.txt'
TOC_FILE = 'frontend/toc.md'
TEMPLATE_FILE = 'mail_template.html'

# 환경변수로부터 읽어올 값들
EMAIL_USER = os.environ['EMAIL_USER']
EMAIL_PASSWORD = os.environ['EMAIL_PASSWORD']
RECEIVER_EMAIL = os.environ['RECEIVER_EMAIL']
GITHUB_PAGES_URL = os.environ.get('PAGES_URL', '').rstrip('/') 
# 예: https://your-id.github.io/your-repo

def get_questions():
    content = Path(TOC_FILE).read_text(encoding='utf-8')
    # - [질문](contents/fe-1.md) 매칭
    pattern = re.compile(r'-\s*\[(.*?)\]\(contents/(fe-\d+)\.md\)')
    return pattern.findall(content)  # [ (질문제목, "fe-1"), ... ]

def get_current_index():
    if not Path(PROGRESS_FILE).exists():
        return 0
    try:
        return int(Path(PROGRESS_FILE).read_text().strip())
    except ValueError:
        return 0

def save_current_index(index):
    Path(PROGRESS_FILE).write_text(str(index))

def main():
    questions = get_questions()
    idx = get_current_index()

    if idx >= len(questions):
        print("모든 질문 발송을 완료했습니다!")
        return

    title, file_id = questions[idx]
    viewer_url = f"{GITHUB_PAGES_URL}/?q={file_id}" if GITHUB_PAGES_URL else "#"

    # HTML 템플릿 치환
    template = Path(TEMPLATE_FILE).read_text(encoding='utf-8')
    html_body = template.replace('{{question_num}}', str(idx + 1))
    html_body = html_body.replace('{{question_title}}', title)
    html_body = html_body.replace('{{viewer_url}}', viewer_url)

    # 이메일 메시지 생성
    msg = MIMEMultipart('alternative')
    msg['Subject'] = f"[매일메일] #{idx + 1}. {title}"
    msg['From'] = f"매일메일 <{EMAIL_USER}>"
    msg['To'] = RECEIVER_EMAIL
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    # 발송
    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(EMAIL_USER, EMAIL_PASSWORD)
        server.sendmail(EMAIL_USER, RECEIVER_EMAIL, msg.as_string())

    print(f"[{idx + 1}/{len(questions)}] 발송 성공: {title}")
    save_current_index(idx + 1)

if __name__ == '__main__':
    main()