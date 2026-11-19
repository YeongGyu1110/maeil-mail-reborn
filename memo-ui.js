// 질문 화면의 메모 보기와 메모 편집기. 저장·불러오기는 memo-core.js가 하고, 여기서는 화면만 다룬다.
// - createMemoView: 메모를 마크다운으로 그리고, 길면 접어 두었다가 펼치고 접을 수 있게 한다
// - createMemoEditor: 작성 / 미리보기 / 나란히 보기, 서식 버튼, 단축키, 목록 이어 쓰기를 갖춘 편집기
import { MEMO_MAX, loadMarkdown, renderMarkdown, readStore, writeStore } from './memo-core.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

const icon = (body, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CHEVRON = icon('<polyline points="6 9 12 15 18 9"></polyline>', 15);

// 마크다운을 그린다. 파서를 받지 못하면 원문을 줄바꿈 그대로 보여준다
async function paint(container, text) {
  try {
    await loadMarkdown();
    renderMarkdown(container, text);
    container.classList.remove('is-plain');
  } catch (err) {
    console.error(err);
    container.textContent = text;
    container.classList.add('is-plain');
  }
}

// ---------- 메모 보기 ----------

const COLLAPSED_HEIGHT = 300; // 접었을 때 보이는 높이
const COLLAPSE_OVER = 440; // 이보다 길 때만 접는다 (몇 줄 더 보자고 펼치게 하지 않도록)
const LINE_HEIGHT = 27; // 메모 본문 한 줄 높이 (남은 분량을 '약 n줄'로 알려줄 때 쓴다)

export function createMemoView(text, { id }) {
  const el = document.createElement('div');
  el.className = 'memo-view';
  el.style.setProperty('--memo-collapsed', `${COLLAPSED_HEIGHT}px`);
  el.innerHTML = `
    <div class="memo-view-content memo-md" id="memo-content-${id}"></div>
    <div class="memo-view-more" hidden>
      <button type="button" class="memo-view-toggle" aria-expanded="false" aria-controls="memo-content-${id}">
        <span class="memo-view-toggle-label">전체 보기</span>
        <span class="memo-view-toggle-sub"></span>
        ${CHEVRON}
      </button>
    </div>`;
  const content = el.querySelector('.memo-view-content');
  const more = el.querySelector('.memo-view-more');
  const toggle = el.querySelector('.memo-view-toggle');
  const label = toggle.querySelector('.memo-view-toggle-label');
  const sub = toggle.querySelector('.memo-view-toggle-sub');

  let expanded = false;
  let animating = false;
  let cleanup = 0;

  // 길이를 재서 접을지 정한다. 폭이 바뀌거나 이미지가 늦게 들어와 높이가 바뀌면 다시 잰다
  function measure() {
    if (animating) return;
    const full = content.scrollHeight;
    const collapsible = full > COLLAPSE_OVER;
    more.hidden = !collapsible;
    el.classList.toggle('is-collapsed', collapsible && !expanded);
    const hiddenLines = Math.max(1, Math.round((full - COLLAPSED_HEIGHT) / LINE_HEIGHT));
    sub.textContent = expanded ? '' : `약 ${hiddenLines}줄 더`;
    sub.hidden = expanded;
  }

  // max-height를 from에서 to로 옮기며 펼치거나 접는다. switchClass는 시작 높이를 고정한 뒤에 접힘 표시를 바꾼다
  function animate(from, to, switchClass) {
    clearTimeout(cleanup);
    animating = true;
    content.style.maxHeight = `${from}px`;
    switchClass();
    content.getBoundingClientRect(); // 시작 높이를 먼저 그리게 한다
    el.classList.add('is-animating');
    content.style.maxHeight = `${to}px`;
    const finish = () => {
      clearTimeout(cleanup);
      content.removeEventListener('transitionend', finish);
      el.classList.remove('is-animating');
      content.style.maxHeight = '';
      animating = false;
      measure();
    };
    content.addEventListener('transitionend', finish);
    cleanup = setTimeout(finish, 450); // 움직임을 줄인 환경 등에서 transitionend가 오지 않을 때
  }

  function setExpanded(next, { instant = false } = {}) {
    if (next === expanded) return;
    expanded = next;
    toggle.setAttribute('aria-expanded', String(expanded));
    label.textContent = expanded ? '접기' : '전체 보기';
    const switchClass = () => el.classList.toggle('is-collapsed', !expanded);

    if (expanded) {
      if (instant) switchClass();
      else animate(COLLAPSED_HEIGHT, content.scrollHeight, switchClass);
    } else {
      // 접으면 메모가 위로 줄어들어, 읽던 자리가 화면 밖으로 밀려나지 않게 메모 머리를 화면 안으로 데려온다
      const navBottom = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-height')) || 52) + 16;
      const top = el.getBoundingClientRect().top;
      if (top < navBottom) window.scrollBy({ top: top - navBottom, behavior: 'instant' });
      if (instant) switchClass();
      else animate(content.scrollHeight, COLLAPSED_HEIGHT, switchClass);
    }
    measure();
  }

  toggle.addEventListener('click', () => setExpanded(!expanded));

  // 접힌 부분의 링크로 키보드 포커스가 들어가면 펼쳐서 보이게 한다
  content.addEventListener('focusin', () => {
    if (!expanded && el.classList.contains('is-collapsed')) setExpanded(true, { instant: true });
  });

  const observer = new ResizeObserver(() => measure());
  observer.observe(content);

  const ready = paint(content, text).then(measure);

  return {
    el,
    ready,
    expand: () => setExpanded(true, { instant: true }),
    destroy() {
      observer.disconnect();
      clearTimeout(cleanup);
    },
  };
}

// ---------- 메모 편집기 ----------

const MODE_KEY = 'maeil-memo-mode'; // 마지막으로 고른 보기 (이 브라우저에만 기억)
const SPLIT_MIN_WIDTH = 600; // 나란히 보기를 쓸 수 있는 편집기 폭 (양옆 여백까지 넓힌 폭으로 잰다)
// 나란히 보기에서는 칸 하나가 지면 폭의 절반이라 긴 메모의 줄이 너무 짧아진다. 그래서 편집기를 양옆 여백으로 똑같이 넓힌다.
// 지면이 화면 가운데에 있으므로 한쪽으로만 넓히면 넓은 화면에서 편집기가 한쪽으로 쏠려 지면을 빠져나간 것처럼 보인다.
// 가운데를 지면과 맞춰 양옆으로 나가면 글 사이에 넓게 넣은 그림처럼 의도한 모양으로 읽힌다
const SPLIT_MAX_WIDTH = 1000; // 넓혀도 이 폭까지 (칸 하나에 한글 약 30자)
const SPLIT_EDGE_GAP = 24; // 넓힌 편집기와 화면 끝 사이
// 지면 끝에 조금만 걸치면 실수처럼 보인다. 지면 밖으로 이만큼 나가지 못하면 지면 안쪽(끝에서 SPLIT_SHEET_INSET)에서 멈춘다
const SPLIT_MIN_OVERHANG = 48;
const SPLIT_SHEET_INSET = 16;
const INPUT_MIN_HEIGHT = 240;
const PREVIEW_DELAY = 120;

const FORMATS = [
  { name: 'heading', label: '제목', icon: icon('<path d="M6 4v16"></path><path d="M18 4v16"></path><path d="M6 12h12"></path>') },
  { name: 'bold', label: `굵게 (${MOD}+B)`, icon: icon('<path d="M6 4h8a4 4 0 0 1 0 8H6z"></path><path d="M6 12h9a4 4 0 0 1 0 8H6z"></path>') },
  { name: 'code', label: '인라인 코드', icon: icon('<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>') },
  { name: 'link', label: `링크 (${MOD}+K)`, icon: icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>') },
  null,
  { name: 'ul', label: '글머리 목록', icon: icon('<line x1="9" y1="6" x2="21" y2="6"></line><line x1="9" y1="12" x2="21" y2="12"></line><line x1="9" y1="18" x2="21" y2="18"></line><circle cx="4" cy="6" r="1"></circle><circle cx="4" cy="12" r="1"></circle><circle cx="4" cy="18" r="1"></circle>') },
  { name: 'ol', label: '번호 목록', icon: icon('<line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><path d="M4 6h1v4"></path><path d="M4 10h2"></path><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path>') },
  { name: 'task', label: '할 일 목록', icon: icon('<rect x="3" y="5" width="6" height="6" rx="1"></rect><path d="m3 17 2 2 4-4"></path><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path>') },
  { name: 'quote', label: '인용', icon: icon('<path d="M17 6H3"></path><path d="M21 12H8"></path><path d="M21 18H8"></path><path d="M3 12v6"></path>') },
  { name: 'codeblock', label: '코드 블록', icon: icon('<path d="m10 9-3 3 3 3"></path><path d="m14 15 3-3-3-3"></path><rect x="3" y="3" width="18" height="18" rx="2"></rect>') },
];

const TRASH = icon('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>', 14);

// 줄 앞 기호: 들여쓰기, 할 일, 글머리, 번호, 인용
const LIST_ITEM = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/;
const LINE_PREFIX = {
  heading: { match: /^#{1,6}\s+/, strip: /^#{1,6}\s+/ },
  ul: { match: /^[-*+]\s+(?!\[[ xX]\])/, strip: /^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/ },
  ol: { match: /^\d+[.)]\s+/, strip: /^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/ },
  task: { match: /^[-*+]\s+\[[ xX]\]\s+/, strip: /^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/ },
  quote: { match: /^>\s?/, strip: null },
};

// 편집기의 바깥 동작(저장, 취소, 삭제, 입력할 때)은 화면이 넘겨준다
export function createMemoEditor({
  text = '',
  canDelete = false,
  commitNote = '',
  draftRestored = false,
  ariaLabel = '메모',
  onInput = () => {},
  onSave = () => {},
  onCancel = () => {},
  onDelete = () => {},
} = {}) {
  const el = document.createElement('div');
  el.className = 'memo-editor';
  el.innerHTML = `
    <div class="memo-toolbar">
      <div class="memo-modes" role="group" aria-label="편집 보기">
        <button type="button" class="memo-mode" data-mode="write" aria-pressed="true">작성</button>
        <button type="button" class="memo-mode" data-mode="preview" aria-pressed="false">미리보기</button>
        <button type="button" class="memo-mode" data-mode="split" aria-pressed="false" title="작성하면서 바로 옆에서 미리보기">나란히</button>
      </div>
      <div class="memo-format" role="toolbar" aria-label="마크다운 서식">
        ${FORMATS.map((f) => f
          ? `<button type="button" class="memo-format-btn" data-format="${f.name}" title="${f.label}" aria-label="${f.label}">${f.icon}</button>`
          : '<span class="memo-format-sep" aria-hidden="true"></span>').join('')}
      </div>
    </div>
    <div class="memo-panes">
      <textarea class="memo-input" spellcheck="false"
        placeholder="이 질문을 내 언어로 정리해보세요.&#10;&#10;## 핵심&#10;- 한 문장으로 답하면?&#10;- 헷갈렸던 점, 나만의 예시"></textarea>
      <div class="memo-pane-preview">
        <div class="memo-preview memo-md" aria-label="미리보기"></div>
      </div>
    </div>
    <div class="memo-editor-foot">
      <div class="memo-editor-info">
        <span class="memo-count"></span>
        <span class="memo-draft-state"></span>
        <span class="memo-hint">${MOD}+Enter로 저장 · Esc로 취소</span>
      </div>
      <div class="memo-editor-buttons">
        <button type="button" class="btn btn-sm memo-delete" data-action="delete" title="메모 삭제">${TRASH}<span>삭제</span></button>
        <button type="button" class="btn btn-sm" data-action="cancel">취소</button>
        <button type="button" class="btn btn-sm btn-primary" data-action="save" title="저장 (${MOD}+Enter)">저장</button>
      </div>
    </div>
    <p class="memo-commit-note"></p>`;

  const input = el.querySelector('.memo-input');
  const preview = el.querySelector('.memo-preview');
  const count = el.querySelector('.memo-count');
  const draftState = el.querySelector('.memo-draft-state');
  const saveButton = el.querySelector('[data-action="save"]');
  const deleteButton = el.querySelector('[data-action="delete"]');
  const splitButton = el.querySelector('[data-mode="split"]');
  const commit = el.querySelector('.memo-commit-note');

  input.maxLength = MEMO_MAX;
  input.value = text;
  input.setAttribute('aria-label', ariaLabel);
  deleteButton.hidden = !canDelete;
  commit.textContent = commitNote;
  commit.hidden = !commitNote;
  if (draftRestored) draftState.textContent = '저장하지 않은 초안을 불러왔어요';

  let preferred = ['write', 'preview', 'split'].includes(readStore('localStorage', MODE_KEY)) ? readStore('localStorage', MODE_KEY) : 'split';
  let wide = false;
  let previewTimer = 0;
  let previewRun = 0;
  let busy = false;
  let shiftEnter = false;

  const mode = () => (preferred === 'split' && !wide ? 'write' : preferred);

  // ----- 보기 전환 -----

  function applyMode({ focus = false } = {}) {
    const current = mode();
    el.dataset.mode = current;
    splitButton.hidden = !wide;
    for (const button of el.querySelectorAll('.memo-mode')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === current));
    }
    if (current !== 'preview') autosize();
    if (current !== 'write') renderPreview();
    if (focus && current !== 'preview') input.focus();
  }

  function setMode(next) {
    preferred = next;
    writeStore('localStorage', MODE_KEY, next);
    applyMode({ focus: true });
  }

  // 나란히 보기에서 양옆으로 한쪽에 얼마씩 넓힐지(--memo-extend), 넓힌 폭으로 나란히 보기를 쓸 수 있는지 정한다.
  // 편집기는 평소 놓인 칸(부모)을 꽉 채우므로, 지금 보기와 상관없이 부모의 폭과 위치로 잰다
  function layout() {
    const parent = el.parentElement;
    if (!parent) return;
    const base = parent.clientWidth;
    const box = parent.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    let side = Math.min((SPLIT_MAX_WIDTH - base) / 2, box.left - SPLIT_EDGE_GAP, viewport - box.right - SPLIT_EDGE_GAP);
    const sheet = el.closest('.doc-container')?.getBoundingClientRect();
    // 지면 안쪽 여백(편집기 끝에서 지면 끝까지): 양옆 중 좁은 쪽
    const padding = sheet ? Math.min(box.left - sheet.left, sheet.right - box.right) : 0;
    if (sheet && side > padding - SPLIT_SHEET_INSET && side < padding + SPLIT_MIN_OVERHANG) {
      side = padding - SPLIT_SHEET_INSET;
    }
    const extend = Math.max(0, Math.floor(side));
    el.style.setProperty('--memo-extend', `${extend}px`);
    el.classList.toggle('can-extend', extend > 0);
    el.classList.toggle('is-overhang', extend > 0 && (!sheet || extend > padding));
    const nextWide = base + extend * 2 >= SPLIT_MIN_WIDTH;
    if (nextWide === wide) return;
    wide = nextWide;
    applyMode();
  }

  const resizeObserver = new ResizeObserver(layout);

  // ----- 미리보기 -----

  async function renderPreview() {
    if (mode() === 'write') return;
    const value = input.value;
    if (!value.trim()) {
      const note = document.createElement('p');
      note.className = 'memo-preview-note';
      note.textContent = '미리 볼 내용이 없어요. 작성 칸에 마크다운으로 써보세요.';
      preview.replaceChildren(note);
      return;
    }
    const run = ++previewRun;
    try {
      await loadMarkdown();
    } catch (err) {
      console.error(err);
      if (run !== previewRun) return;
      const note = document.createElement('p');
      note.className = 'memo-preview-note';
      note.textContent = '미리보기를 불러오지 못했어요. 연결을 확인하고 다시 시도해주세요.';
      preview.replaceChildren(note);
      return;
    }
    if (run !== previewRun || mode() === 'write') return; // 그사이 더 나중에 그리기 시작했으면 그대로 둔다
    renderMarkdown(preview, value);
    syncScroll();
  }

  function schedulePreview() {
    if (mode() === 'write') return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, PREVIEW_DELAY);
  }

  // 나란히 보기에서 작성 칸을 넘긴 만큼 미리보기도 같은 비율로 넘긴다
  function syncScroll() {
    if (mode() !== 'split') return;
    const range = input.scrollHeight - input.clientHeight;
    const ratio = range > 0 ? input.scrollTop / range : 0;
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  }

  // ----- 작성 칸 높이: 글 길이에 맞춰 늘리되 화면 높이의 65%까지만 (넘으면 칸 안에서 넘긴다) -----

  function autosize() {
    if (mode() === 'preview') return;
    const scrollY = window.scrollY;
    const scrollTop = input.scrollTop;
    input.style.height = 'auto';
    const max = Math.max(INPUT_MIN_HEIGHT, Math.min(window.innerHeight * 0.65, 640));
    input.style.height = `${Math.min(Math.max(input.scrollHeight + 2, INPUT_MIN_HEIGHT), max)}px`;
    input.scrollTop = scrollTop;
    if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY, behavior: 'instant' });
  }

  function updateCount() {
    const length = input.value.length;
    count.textContent = `${length.toLocaleString()} / ${MEMO_MAX.toLocaleString()}`;
    count.dataset.level = length >= MEMO_MAX ? 'full' : length >= MEMO_MAX * 0.9 ? 'near' : '';
  }

  // ----- 글 고치기: 되돌리기(Ctrl+Z)가 되도록 브라우저 입력 명령으로 바꾼다 -----

  function replaceRange(start, end, replacement, selStart, selEnd = selStart) {
    input.focus();
    if (start === end && !replacement) {
      input.setSelectionRange(selStart, selEnd);
      return;
    }
    input.setSelectionRange(start, end);
    const done = replacement
      ? document.execCommand('insertText', false, replacement)
      : document.execCommand('delete');
    if (!done || input.value.slice(start, start + replacement.length) !== replacement) {
      input.setRangeText(replacement, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.setSelectionRange(selStart, selEnd);
  }

  // 선택한 글자를 기호로 감싼다. 이미 감싸져 있으면 벗긴다
  function wrap(before, after, placeholder) {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const selected = value.slice(s, e);
    if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
      replaceRange(s - before.length, e + after.length, selected, s - before.length, e - before.length);
      return;
    }
    const inner = selected || placeholder;
    replaceRange(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
  }

  function link() {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const selected = value.slice(s, e);
    if (/^https?:\/\/\S+$/.test(selected)) {
      const label = '링크 이름';
      replaceRange(s, e, `[${label}](${selected})`, s + 1, s + 1 + label.length);
    } else {
      const label = selected || '링크 이름';
      const url = 'https://';
      const start = s + label.length + 3;
      replaceRange(s, e, `[${label}](${url})`, selected ? start : s + 1, selected ? start + url.length : s + 1 + label.length);
    }
  }

  // 선택한 줄들 앞에 기호를 붙인다. 모든 줄에 이미 있으면 뗀다 (목록끼리는 서로 바꾼다)
  function prefixLines(kind) {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    // 다음 줄 맨 앞까지 선택했으면 그 줄은 빼고 센다
    const endAt = e > s && value[e - 1] === '\n' ? e - 1 : e;
    const lineEndIndex = value.indexOf('\n', endAt);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const rule = LINE_PREFIX[kind];
    const filled = lines.filter((line) => line.trim());
    const remove = filled.length > 0 && filled.every((line) => rule.match.test(line.trimStart()));

    let n = 0;
    const next = lines.map((line) => {
      if (!line.trim() && lines.length > 1) return line;
      const [, indent, rest] = line.match(/^(\s*)(.*)$/);
      if (remove) return indent + rest.replace(rule.match, '');
      n++;
      const bare = rule.strip ? rest.replace(rule.strip, '') : rest;
      const prefix = { heading: '## ', ul: '- ', ol: `${n}. `, task: '- [ ] ', quote: '> ' }[kind];
      return indent + prefix + bare;
    }).join('\n');

    if (lines.length === 1) {
      // 한 줄이면 커서를 글자와 함께 옮기되, 새로 붙인 기호 앞에 남지 않게 한다
      const shifted = s + next.length - (lineEnd - lineStart);
      const prefixEnd = lineStart + (next.match(/^\s*(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/)[0].length);
      replaceRange(lineStart, lineEnd, next, remove ? Math.max(shifted, lineStart) : Math.max(shifted, prefixEnd));
    } else {
      replaceRange(lineStart, lineEnd, next, lineStart, lineStart + next.length);
    }
  }

  function codeBlock() {
    const { selectionStart: s, selectionEnd: e, value } = input;
    const selected = value.slice(s, e);
    const lead = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
    const tail = e < value.length && value[e] !== '\n' ? '\n' : '';
    const block = `${lead}\`\`\`\n${selected}\n\`\`\`${tail}`;
    const innerStart = s + lead.length + 4;
    replaceRange(s, e, block, innerStart, innerStart + selected.length);
  }

  function applyFormat(name) {
    if (mode() === 'preview') return;
    if (name === 'bold') wrap('**', '**', '굵은 글씨');
    else if (name === 'code') wrap('`', '`', '코드');
    else if (name === 'link') link();
    else if (name === 'codeblock') codeBlock();
    else prefixLines(name);
  }

  // 목록 안에서 Enter를 누르면 다음 항목 기호를 붙여 준다. 빈 항목에서 누르면 목록을 끝낸다.
  // 한글 입력 중에 누른 Enter도 글자가 확정된 뒤에 오는 beforeinput에서 처리한다
  function continueList(e) {
    if (e.inputType !== 'insertLineBreak' || shiftEnter) return;
    const { selectionStart: s, selectionEnd: end, value } = input;
    if (s !== end) return;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const before = value.slice(lineStart, s);
    const match = before.match(LIST_ITEM);
    if (!match) return;
    const lineEndIndex = value.indexOf('\n', s);
    const after = value.slice(s, lineEndIndex === -1 ? value.length : lineEndIndex);

    e.preventDefault();
    if (!before.slice(match[0].length).trim() && !after.trim()) {
      replaceRange(lineStart, s, '', lineStart);
      return;
    }
    let marker = match[2];
    if (match[3]) marker = `${Number(match[3]) + 1}${match[4]} `;
    else if (/\[[ xX]\]/.test(marker)) marker = marker.replace(/\[[ xX]\]/, '[ ]');
    const insert = `\n${match[1]}${marker}`;
    replaceRange(s, s, insert, s + insert.length);
  }

  // ----- 이벤트 -----

  el.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target || busy) return;
    if (target.dataset.mode) setMode(target.dataset.mode);
    else if (target.dataset.format) applyFormat(target.dataset.format);
    else if (target.dataset.action === 'save') onSave();
    else if (target.dataset.action === 'cancel') onCancel();
    else if (target.dataset.action === 'delete') onDelete();
  });

  // 서식 버튼을 눌러도 작성 칸의 선택이 풀리지 않게 한다
  el.querySelector('.memo-format').addEventListener('mousedown', (e) => e.preventDefault());

  input.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') shiftEnter = e.shiftKey;
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중인 키는 입력기에 맡긴다
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      if (!busy) onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      applyFormat('bold');
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      applyFormat('link');
    }
  });

  // 미리보기 중에도 Esc로 취소, Ctrl+Enter로 저장한다
  el.addEventListener('keydown', (e) => {
    if (e.target === input || busy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave();
    }
  });

  input.addEventListener('beforeinput', continueList);

  input.addEventListener('input', () => {
    autosize();
    updateCount();
    schedulePreview();
    onInput(input.value);
  });

  input.addEventListener('scroll', syncScroll, { passive: true });

  // 창 폭이 바뀌면 지면은 그대로여도 오른쪽 여백이 달라진다
  const onWindowResize = () => {
    layout();
    autosize();
  };
  window.addEventListener('resize', onWindowResize);

  updateCount();

  return {
    el,
    // 붙인 뒤에 불러야 폭과 높이를 잴 수 있다
    mount() {
      if (el.parentElement) resizeObserver.observe(el.parentElement);
      layout();
      applyMode();
    },
    focus() {
      if (mode() === 'preview') {
        el.querySelector('.memo-mode[aria-pressed="true"]').focus();
        return;
      }
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollTop = input.scrollHeight;
    },
    getText: () => input.value,
    setText(value) {
      input.value = value;
      autosize();
      updateCount();
      renderPreview();
    },
    setDraftState(textValue) {
      draftState.textContent = textValue;
    },
    setBusy(value) {
      busy = value;
      saveButton.disabled = value;
      saveButton.textContent = value ? '저장 중…' : '저장';
      input.readOnly = value;
    },
    destroy() {
      resizeObserver.disconnect();
      window.removeEventListener('resize', onWindowResize);
      clearTimeout(previewTimer);
    },
  };
}
