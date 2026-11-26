// 질문 화면의 메모 보기와 메모 편집기. 저장·불러오기는 memo-core.js가 하고, 여기서는 화면만 다룬다.
// - createMemoView: 메모를 마크다운으로 그리고, 길면 접어 두었다가 펼치고 접을 수 있게 한다
// - createMemoEditor: 작성 / 미리보기 / 나란히 보기, 서식 버튼, 단축키, 목록 이어 쓰기를 갖춘 편집기
import { MEMO_MAX, loadMarkdown, renderMarkdown, readStore, writeStore } from './memo-core.js';
import { joinParts } from './memo-merge.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl'; // 단축키 안내에 쓰는 이름 (질문 화면의 확인 창도 쓴다)

// Ctrl(맥은 Cmd)+글자 단축키인지. 한글 입력 상태에서는 key가 'ㄴ'처럼 자모로 오므로 눌린 자판 자리(code)로도 본다
const isShortcut = (e, letter, { shift = false } = {}) => (e.ctrlKey || e.metaKey) && e.shiftKey === shift && !e.altKey
  && (e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`);
const isPreviewToggle = (e) => isShortcut(e, 'p', { shift: true });
const isToolbarKey = (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'F10' || e.code === 'F10');

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

let editorCount = 0; // 편집기마다 다른 id를 붙이려고 센다

const HINT = `${MOD}+S 초안 저장 · ${MOD}+Enter로 저장 · Esc로 닫기`;
// 저장된 메모가 있는데 작성 칸을 비우면 안내 자리에 띄운다 (메모는 비운 채 저장해서 지운다. 따로 삭제 버튼을 두지 않는다)
const HINT_CLEARING = '비운 채 저장하면 메모를 지워요';

// 줄 앞 기호: 들여쓰기, 할 일, 글머리, 번호, 인용
const LIST_ITEM = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/;
const LINE_PREFIX = {
  heading: { match: /^#{1,6}\s+/, strip: /^#{1,6}\s+/ },
  ul: { match: /^[-*+]\s+(?!\[[ xX]\])/, strip: /^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/ },
  ol: { match: /^\d+[.)]\s+/, strip: /^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/ },
  task: { match: /^[-*+]\s+\[[ xX]\]\s+/, strip: /^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/ },
  quote: { match: /^>\s?/, strip: null },
};

// 편집기의 바깥 동작(저장, 초안 저장, 닫기, 더보기, 입력할 때)은 화면이 넘겨준다.
// 메모를 지우는 것도 저장이다: 비운 채 저장하면 화면이 지울지 묻고 지운다
export function createMemoEditor({
  text = '',
  hasMemo = false, // 저장된 메모가 있는지 (비우면 지워진다고 알린다)
  commitNote = '',
  ariaLabel = '메모',
  onInput = () => {},
  onSave = () => {}, // 저장 버튼은 onSave(), Ctrl+Enter는 onSave({ shortcut: true })로 부른다
  onSaveDraft = () => {}, // Ctrl+S: 메모는 그대로 두고 초안만 저장한다. 편집기는 열어 둔다
  onCancel = () => {}, // 닫기 버튼, Esc
  onMore = () => {}, // 더보기 버튼 (누른 버튼을 넘긴다. 펼칠 목록은 화면이 그린다)
} = {}) {
  const el = document.createElement('div');
  el.className = 'memo-editor';
  const uid = ++editorCount;
  // 도구 모음(보기 전환 + 서식)은 WAI-ARIA 도구 모음 패턴을 따른다: Tab으로는 한 번만 멈추고, 안에서는 화살표로 옮긴다.
  // 작성 칸에서는 Tab이 들여쓰기라 Alt+F10으로 도구 모음에 가고(웹 편집기 TinyMCE·CKEditor의 관례), Esc로 작성 칸에 돌아온다
  el.innerHTML = `
    <div class="memo-toolbar" role="toolbar" aria-label="메모 편집 도구" aria-keyshortcuts="Alt+F10">
      <div class="memo-modes" role="group" aria-label="편집 보기">
        <button type="button" class="memo-mode" data-mode="write" aria-pressed="true">작성</button>
        <button type="button" class="memo-mode" data-mode="preview" aria-pressed="false" title="미리보기 켜고 끄기 (${MOD}+Shift+P)">미리보기</button>
        <button type="button" class="memo-mode" data-mode="split" aria-pressed="false" title="작성하면서 바로 옆에서 미리보기">나란히</button>
      </div>
      <div class="memo-format" role="group" aria-label="마크다운 서식">
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
        <span class="memo-hint" aria-live="polite"></span>
      </div>
      <div class="memo-editor-buttons">
        <button type="button" class="btn btn-sm btn-icon memo-more-btn" data-action="more" aria-label="더보기" aria-haspopup="menu" aria-expanded="false" title="더보기">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3.5" y="10.5" width="3" height="3" rx="0.6"></rect><rect x="10.5" y="10.5" width="3" height="3" rx="0.6"></rect><rect x="17.5" y="10.5" width="3" height="3" rx="0.6"></rect></svg>
        </button>
        <button type="button" class="btn btn-sm" data-action="cancel" title="닫기 (Esc)">닫기</button>
        <button type="button" class="btn btn-sm btn-primary" data-action="save" title="저장 (${MOD}+Enter)">저장</button>
      </div>
    </div>
    <p class="memo-commit-note"></p>
    <span class="sr-only" id="memo-keys-${uid}">Tab은 들여쓰기, Shift+Tab은 내어쓰기입니다. Alt+F10을 누르면 서식 도구 모음으로 가고, 도구 모음에서 Esc를 누르면 작성 칸으로 돌아옵니다.</span>`;

  const input = el.querySelector('.memo-input');
  const preview = el.querySelector('.memo-preview');
  const count = el.querySelector('.memo-count');
  const draftState = el.querySelector('.memo-draft-state');
  const saveButton = el.querySelector('[data-action="save"]');
  const hint = el.querySelector('.memo-hint');
  const splitButton = el.querySelector('[data-mode="split"]');
  const commit = el.querySelector('.memo-commit-note');
  const toolbar = el.querySelector('.memo-toolbar');

  // ----- 도구 모음: Tab으로 한 번만 멈추는 자리(tabIndex 0)는 마지막으로 머문 버튼 하나다 -----
  let toolbarCurrent = el.querySelector('.memo-format-btn'); // 처음 Alt+F10은 서식 버튼으로 간다

  // 지금 누를 수 있는 도구 버튼 (좁아서 숨긴 '나란히', 미리보기에서 숨긴 서식 버튼은 뺀다)
  function toolbarItems() {
    return [...toolbar.querySelectorAll('button')]
      .filter((button) => button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden');
  }

  function updateToolbarStop() {
    const items = toolbarItems();
    if (items.length && !items.includes(toolbarCurrent)) {
      toolbarCurrent = items.find((button) => button.getAttribute('aria-pressed') === 'true') || items[0];
    }
    for (const button of toolbar.querySelectorAll('button')) button.tabIndex = button === toolbarCurrent ? 0 : -1;
  }

  // 브라우저는 Alt·Ctrl을 함께 누른 단축키를 키보드 이동으로 치지 않아, 마우스로 작성 칸을 눌렀다면
  // 그냥 focus()로 옮긴 버튼에는 포커스 테두리를 그리지 않는다. 키보드로 옮긴 것이니 테두리를 보이라고 알려준다
  function focusToolbar() {
    updateToolbarStop();
    toolbarCurrent?.focus({ focusVisible: true });
  }

  toolbar.addEventListener('focusin', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    toolbarCurrent = button;
    updateToolbarStop();
  });

  toolbar.addEventListener('keydown', (e) => {
    // 도구 모음에서 Esc는 작성 칸으로 돌아간다 (작성 칸이 없는 미리보기에서는 전처럼 편집 취소)
    if (e.key === 'Escape' && mode() !== 'preview') {
      e.preventDefault();
      e.stopPropagation();
      input.focus();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = toolbarItems();
    const index = items.indexOf(document.activeElement);
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: items.length - 1 }[e.key];
    if (index === -1 || next === undefined) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  });

  updateToolbarStop(); // 붙이기 전이라 보이는 버튼을 잴 수 없으니 일단 첫 서식 버튼에 자리를 둔다 (mount 때 다시 정한다)

  input.maxLength = MEMO_MAX;
  input.value = text;
  input.setAttribute('aria-label', ariaLabel);
  input.setAttribute('aria-describedby', `memo-keys-${uid}`); // 화면 읽기 도구에 작성 칸의 키를 알린다 (화면에는 보이지 않는다)
  commit.textContent = commitNote;
  commit.hidden = !commitNote;

  let preferred = ['write', 'preview', 'split'].includes(readStore('localStorage', MODE_KEY)) ? readStore('localStorage', MODE_KEY) : 'split';
  let wide = false;
  let previewTimer = 0;
  let previewRun = 0;
  let busy = false;
  let shiftEnter = false;
  let pendingTab = null; // 한글 조합 중에 누른 Tab (true면 Shift+Tab)
  let pendingDraftSave = false; // 한글 조합 중에 누른 Ctrl+S
  let pendingPreviewToggle = false; // 한글 조합 중에 누른 Ctrl+Shift+P
  let savedMemo = hasMemo; // 저장된 메모가 있는지 (비우고 저장하면 지워진다고 알린다)
  // 미리보기를 끄면 돌아갈 보기 (작성 또는 나란히). 사용자가 고른 보기를 기억한다
  let lastEditMode = preferred === 'preview' ? 'write' : preferred;

  const mode = () => (preferred === 'split' && !wide ? 'write' : preferred);

  // ----- 보기 전환 -----

  // focusVisible: 단축키로 바꿨을 때 옮겨 간 보기 버튼에 포커스 테두리를 보인다 (focusToolbar와 같은 이유)
  function applyMode({ focus = false, focusVisible = false } = {}) {
    const current = mode();
    el.dataset.mode = current;
    splitButton.hidden = !wide;
    for (const button of el.querySelectorAll('.memo-mode')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === current));
    }
    if (current !== 'preview') autosize();
    if (current !== 'write') renderPreview();
    updateToolbarStop(); // 보기에 따라 숨는 버튼이 달라진다
    if (!focus) return;
    // 미리보기에서는 작성 칸이 숨으므로 눌린 보기 버튼에 포커스를 둔다 (Esc, Ctrl+Enter, Ctrl+Shift+P가 계속 편집기에 닿게)
    if (current === 'preview') el.querySelector('.memo-mode[aria-pressed="true"]').focus({ focusVisible });
    else input.focus();
  }

  function setMode(next, { focusVisible = false } = {}) {
    preferred = next;
    if (next !== 'preview') lastEditMode = next;
    writeStore('localStorage', MODE_KEY, next);
    applyMode({ focus: true, focusVisible });
  }

  // Ctrl+Shift+P (맥은 Cmd+Shift+P): 미리보기를 켜고 끈다. GitHub 편집기의 작성·미리보기 전환과 같은 키다.
  // Firefox는 이 키를 사생활 보호 창 열기로 예약해 페이지에 전달하지 않으므로, Firefox에서는 사생활 보호 창이 열린다
  function togglePreview() {
    setMode(mode() === 'preview' ? lastEditMode : 'preview', { focusVisible: true });
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

  // 안내 자리: 평소에는 단축키, 저장된 메모를 다 비우면 지워진다는 경고 (휴대폰에서도 경고는 보인다)
  function updateHint() {
    const clearing = savedMemo && !input.value.trim();
    hint.textContent = clearing ? HINT_CLEARING : HINT;
    hint.classList.toggle('is-warning', clearing);
  }

  function updateCount() {
    const length = input.value.length;
    count.textContent = `${length.toLocaleString()} / ${MEMO_MAX.toLocaleString()}`;
    count.dataset.level = length >= MEMO_MAX ? 'full' : length >= MEMO_MAX * 0.9 ? 'near' : '';
  }

  // ----- 글 고치기: 되돌리기(Ctrl+Z)가 되도록 브라우저 입력 명령으로 바꾼다 -----

  // 글자 수 제한(maxLength)은 직접 입력할 때만 브라우저가 막는다. 편집기가 넣는 글(Tab, 서식, 목록 이어 쓰기)도
  // 제한을 넘기면 넣지 않고 글자 수 표시를 살짝 흔들어 알린다. 고친 글을 넣었으면 true
  function replaceRange(start, end, replacement, selStart, selEnd = selStart) {
    input.focus();
    if (start === end && !replacement) {
      input.setSelectionRange(selStart, selEnd);
      return true;
    }
    const nextLength = input.value.length - (end - start) + replacement.length;
    if (nextLength > MEMO_MAX && nextLength > input.value.length) { // 이미 넘친 글을 줄이는 고침은 막지 않는다
      count.classList.remove('is-bump');
      void count.offsetWidth; // 연달아 눌러도 다시 흔들리게 한다
      count.classList.add('is-bump');
      return false;
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
    return true;
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

  // ----- Tab 들여쓰기 · Shift+Tab 내어쓰기 -----
  // 마크다운의 하위 목록은 위 항목의 글이 시작하는 자리까지 들여써야 한다 ("- a" 밑은 2칸, "1. a" 밑은 3칸, " - a" 밑은 3칸).
  // 칸 수를 고정하면 번호 목록에서 하위 목록이 되지 않으므로, 목록 줄은 위 항목에 맞춰 들여쓴다. 그 밖의 줄은 2칸씩

  const INDENT_UNIT = 2;
  const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])( +|$)/;

  // 줄의 들여쓰기 폭(탭은 4칸으로 센다)과, 목록 줄이면 그 항목의 글이 시작하는 자리
  function lineInfo(line) {
    const lead = line.match(/^[ \t]*/)[0];
    const indent = lead.replace(/\t/g, '    ').length;
    const list = line.match(LIST_LINE);
    const content = list ? indent + list[2].length + Math.min(Math.max(list[3].length, 1), 4) : null;
    return { lead: lead.length, indent, content };
  }

  // 목록 줄 하나를 들여쓰거나(바로 위 같은 수준 항목의 하위로) 내어쓸(한 수준 위로) 들여쓰기 폭
  function listTarget(lines, index, outdent) {
    const current = lineInfo(lines[index]);
    for (let i = index - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (/^\s*(#{1,6}\s|```|~~~)/.test(line)) break; // 제목이나 코드 블록을 넘어서는 찾지 않는다
      const info = lineInfo(line);
      if (info.content === null) continue; // 목록 항목에 이어 쓴 줄은 건너뛴다
      if (outdent) {
        if (info.indent < current.indent) return info.indent;
      } else if (info.indent === current.indent) {
        return info.content;
      } else if (info.indent < current.indent) {
        break;
      }
    }
    // 위에 기준이 될 항목이 없으면 2칸씩 옮긴다
    return outdent ? Math.max(0, current.indent - INDENT_UNIT) : current.indent + INDENT_UNIT;
  }

  // Tab과 Shift+Tab은 언제나 줄 단위로 움직여, Shift+Tab이 방금 누른 Tab을 그대로 되돌린다.
  // 커서가 줄 어디에 있든 줄 맨 앞의 들여쓰기만 바꾸고, 목록 항목이면 그 아래 하위 항목도 함께 옮긴다
  function indentLines(outdent) {
    if (mode() === 'preview') return;
    const { selectionStart: s, selectionEnd: e, value } = input;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const endAt = e > s && value[e - 1] === '\n' ? e - 1 : e;
    const lineEndIndex = value.indexOf('\n', endAt);
    const selectedEnd = lineEndIndex === -1 ? value.length : lineEndIndex;

    // 글 전체에서 줄을 나눠, 위쪽 목록 항목도 보고 들여쓰기 폭을 정한다
    const allLines = value.split('\n');
    const firstLine = value.slice(0, lineStart).split('\n').length - 1;
    const selected = value.slice(lineStart, selectedEnd).split('\n');
    let lead = selected.findIndex((line) => line.trim());
    // 빈 줄 하나(공백만 있는 줄 포함)에서 누르면 그 줄의 들여쓰기를 바꾼다 (코드 블록에서 새 줄을 들여쓰고 쓸 때)
    if (lead === -1 && selected.length === 1) lead = 0;
    if (lead === -1) return;
    const leadInfo = lineInfo(selected[lead]);
    const isList = leadInfo.content !== null;
    const target = isList
      ? listTarget(allLines, firstLine + lead, outdent)
      : outdent ? Math.max(0, leadInfo.indent - INDENT_UNIT) : leadInfo.indent + INDENT_UNIT;
    // 여러 줄은 첫 줄과 같은 폭만큼 함께 옮겨, 줄 사이의 들여쓰기 관계를 지킨다
    const delta = target - leadInfo.indent;
    if (!delta) return;

    // 목록 항목이면 바로 아래에 더 깊이 들여쓴 줄(하위 항목, 항목 안의 코드 등)까지 함께 옮긴다. 사이의 빈 줄도 포함한다
    let lastLine = firstLine + selected.length - 1;
    if (isList) {
      for (let i = lastLine + 1; i < allLines.length; i++) {
        if (!allLines[i].trim()) continue;
        if (lineInfo(allLines[i]).indent <= leadInfo.indent) break;
        lastLine = i;
      }
    }
    const lines = allLines.slice(firstLine, lastLine + 1);
    const lineEnd = lineStart + lines.join('\n').length;
    const only = lines.length === 1;
    // 이어 쓰기로 붙여 준 빈 항목을 들여쓰거나 내어써도, Enter로 목록을 끝낼 수 있는 항목으로 계속 기억한다
    const movingAutoItem = autoItem && autoItem.start === lineStart && lines[0] === autoItem.text;

    const changes = lines.map((line) => {
      if (!line.trim() && !only) return { line, oldLead: 0, newLead: 0 };
      const info = lineInfo(line);
      const newLead = Math.max(0, info.indent + delta);
      return { line: ' '.repeat(newLead) + line.slice(info.lead), oldLead: info.lead, newLead };
    });
    const next = changes.map((change) => change.line).join('\n');

    // 커서와 선택이 글자와 함께 움직이게 옮긴다. 줄 맨 앞에서 시작한 여러 줄 선택은 줄 맨 앞에 둔다
    const mapPosition = (position, keepLineStart) => {
      let offset = lineStart;
      for (let i = 0; i < lines.length; i++) {
        const lineLength = lines[i].length;
        if (position <= offset + lineLength || i === lines.length - 1) {
          const column = position - offset;
          const { oldLead, newLead } = changes[i];
          const before = changes.slice(0, i).reduce((sum, change) => sum + change.line.length + 1, 0);
          if (keepLineStart && column === 0) return lineStart + before;
          const newColumn = column >= oldLead ? column - oldLead + newLead : Math.min(column, newLead);
          return lineStart + before + newColumn;
        }
        offset += lineLength + 1;
      }
      return position;
    };
    const keep = s !== e;
    const done = replaceRange(lineStart, lineEnd, next, mapPosition(s, keep), s === e ? mapPosition(s, false) : mapPosition(e, false));
    if (done && movingAutoItem) autoItem = { start: lineStart, text: changes[0].line };
  }

  function applyFormat(name) {
    if (mode() === 'preview') return;
    if (name === 'bold') wrap('**', '**', '굵은 글씨');
    else if (name === 'code') wrap('`', '`', '코드');
    else if (name === 'link') link();
    else if (name === 'codeblock') codeBlock();
    else prefixLines(name);
  }

  // 목록 안에서 Enter를 누르면 다음 항목 기호를 붙여 준다.
  // 그렇게 붙여 준 빈 항목에서 한 번 더 누르면, 하위 항목이면 한 수준 밖으로 꺼내고 맨 바깥이면 목록을 끝낸다 (기호를 지운다).
  // 직접 입력한 기호("- ")는 지우지 않고 그냥 줄을 바꾼다.
  // 한글 입력 중에 누른 Enter도 글자가 확정된 뒤에 오는 beforeinput에서 처리한다
  let autoItem = null; // 이어 쓰기로 붙여 준 빈 항목 { start: 줄 시작 위치, text: 들여쓰기 + 기호 }

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

    if (!before.slice(match[0].length).trim() && !after.trim()) {
      const auto = autoItem && autoItem.start === lineStart && before === autoItem.text;
      if (!auto) {
        autoItem = null;
        return; // 직접 입력한 빈 항목: 브라우저가 줄만 바꾼다
      }
      e.preventDefault();
      if (match[1]) {
        indentLines(true); // 하위의 빈 항목: 한 수준 밖으로 (빈 항목으로 계속 기억된다)
        return;
      }
      autoItem = null;
      replaceRange(lineStart, s, '', lineStart);
      return;
    }
    e.preventDefault();
    let marker = match[2];
    if (match[3]) marker = `${Number(match[3]) + 1}${match[4]} `;
    else if (/\[[ xX]\]/.test(marker)) marker = marker.replace(/\[[ xX]\]/, '[ ]');
    const insert = `\n${match[1]}${marker}`;
    if (replaceRange(s, s, insert, s + insert.length)) autoItem = { start: s + 1, text: match[1] + marker };
  }

  // ----- 이벤트 -----

  el.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target || busy) return;
    if (target.dataset.mode) setMode(target.dataset.mode);
    else if (target.dataset.format) applyFormat(target.dataset.format);
    else if (target.dataset.action === 'save') onSave();
    else if (target.dataset.action === 'more') onMore(target);
    else if (target.dataset.action === 'cancel') onCancel();
  });

  // 서식 버튼을 눌러도 작성 칸의 선택이 풀리지 않게 한다
  el.querySelector('.memo-format').addEventListener('mousedown', (e) => e.preventDefault());

  input.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') shiftEnter = e.shiftKey;
    // Alt+F10: 서식 도구 모음으로 (작성 칸의 선택은 그대로 남아, 도구를 누르면 그 선택에 적용하고 작성 칸으로 돌아온다)
    if (isToolbarKey(e)) {
      e.preventDefault();
      focusToolbar();
      return;
    }
    // Tab은 다음 버튼으로 넘어가지 않고 들여쓴다 (작성 칸을 떠날 때는 Ctrl+Enter 저장, Esc 취소).
    // 한글 조합 중에 누른 Tab은 조합이 끝나 글자가 확정된 뒤에 들여쓴다 (조합 중에는 key가 'Process'라 code로 본다)
    if ((e.key === 'Tab' || e.code === 'Tab') && !mod && !e.altKey) {
      e.preventDefault();
      if (busy) return;
      if (e.isComposing || e.keyCode === 229) pendingTab = e.shiftKey;
      else indentLines(e.shiftKey);
      return;
    }
    // Ctrl+S: 브라우저의 '페이지 저장' 대신 초안 저장. 한글 조합 중이면 글자가 확정된 뒤에 저장한다
    if (isShortcut(e, 's')) {
      e.preventDefault();
      if (busy) return;
      if (e.isComposing || e.keyCode === 229) pendingDraftSave = true;
      else onSaveDraft();
      return;
    }
    // Ctrl+Shift+P: 미리보기로. 한글 조합 중이면 글자가 확정된 뒤에 바꾼다 (작성 칸을 숨기기 전에 마지막 글자를 넣는다)
    if (isPreviewToggle(e)) {
      e.preventDefault();
      if (e.isComposing || e.keyCode === 229) pendingPreviewToggle = true;
      else togglePreview();
      return;
    }
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중인 키는 입력기에 맡긴다
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      if (!busy) onSave({ shortcut: true });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
    } else if (isShortcut(e, 'b')) {
      e.preventDefault();
      applyFormat('bold');
    } else if (isShortcut(e, 'k')) {
      e.preventDefault();
      applyFormat('link');
    }
  });

  // 미리보기 중이나 버튼에 포커스가 있을 때도 Esc로 닫기, Ctrl+Enter로 저장, Ctrl+S로 초안 저장, Ctrl+Shift+P로 미리보기 전환을 한다
  el.addEventListener('keydown', (e) => {
    if (e.target === input) return;
    if (isToolbarKey(e)) {
      e.preventDefault();
      focusToolbar();
      return;
    }
    if (isPreviewToggle(e)) {
      e.preventDefault();
      togglePreview();
      return;
    }
    if (isShortcut(e, 's')) e.preventDefault(); // 저장 중에도 브라우저의 '페이지 저장' 창은 띄우지 않는다
    if (busy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave({ shortcut: true });
    } else if (isShortcut(e, 's')) {
      onSaveDraft();
    }
  });

  input.addEventListener('beforeinput', continueList);

  input.addEventListener('compositionend', () => {
    if (pendingDraftSave) {
      pendingDraftSave = false;
      setTimeout(onSaveDraft);
    }
    if (pendingPreviewToggle) {
      pendingPreviewToggle = false;
      setTimeout(togglePreview);
    }
    if (pendingTab === null) return;
    const outdent = pendingTab;
    pendingTab = null;
    setTimeout(() => indentLines(outdent));
  });

  input.addEventListener('input', () => {
    autosize();
    updateCount();
    updateHint();
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
  updateHint();

  return {
    el,
    // 붙인 뒤에 불러야 폭과 높이를 잴 수 있다
    mount() {
      if (el.parentElement) resizeObserver.observe(el.parentElement);
      layout();
      applyMode();
    },
    // keepSelection: 확인 창에서 '계속 쓰기'로 돌아올 때처럼, 커서를 끝으로 옮기지 않고 쓰던 자리로 돌아간다
    focus({ keepSelection = false } = {}) {
      if (mode() === 'preview') {
        el.querySelector('.memo-mode[aria-pressed="true"]').focus();
        return;
      }
      input.focus({ preventScroll: true });
      if (keepSelection) return;
      input.setSelectionRange(input.value.length, input.value.length);
      input.scrollTop = input.scrollHeight;
    },
    getText: () => input.value,
    setText(value) {
      input.value = value;
      autosize();
      updateCount();
      updateHint();
      renderPreview();
    },
    setDraftState(textValue) {
      draftState.textContent = textValue;
    },
    // 저장된 메모가 생기거나 없어지면 알린다 (비우면 지워진다는 안내를 바꾼다)
    setHasMemo(value) {
      savedMemo = value;
      updateHint();
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

// ---------- 겹친 곳 고르기 ----------
// 같은 글을 다른 곳에서도 고쳐 서로 겹친 곳(memo-merge.js의 충돌)마다, 남길 글을 고르게 한다.
// GitHub 웹의 충돌 편집기를 한 줄로 줄인 것이다: 겹친 곳마다 '이 기기에서 쓴 글 / 다른 곳의 글 / 둘 다'를 고르고,
// 다 고르면 합친 글을 편집기에 넣는다. 저장은 하지 않는다 (편집기에서 다듬은 뒤 다시 저장한다).
// parts: mergeMemo의 parts, theirsLabel: 다른 쪽 글의 이름 (예: 다른 곳에서 저장한 초안)
let conflictCount = 0;

export function createConflictView({ parts, theirsLabel, onDone = () => {}, onCancel = () => {} }) {
  const conflicts = parts.filter((part) => part.kind === 'conflict');
  const picks = new Array(conflicts.length).fill(null);
  const uid = ++conflictCount;
  const el = document.createElement('section');
  el.className = 'memo-conflict';
  el.setAttribute('aria-labelledby', `memo-conflict-title-${uid}`);
  el.innerHTML = `
    <div class="memo-conflict-head">
      <h4 class="memo-conflict-title" id="memo-conflict-title-${uid}" tabindex="-1">다른 곳에서 고친 부분과 겹쳐요</h4>
      <p class="memo-conflict-desc">겹친 곳마다 남길 글을 골라 주세요. 고르면 합친 글이 편집기에 들어가고, 다듬은 뒤 다시 저장하면 돼요.</p>
    </div>
    <ol class="memo-conflict-list"></ol>
    <div class="memo-conflict-foot">
      <span class="memo-conflict-left" aria-live="polite"></span>
      <div class="memo-conflict-buttons">
        <button type="button" class="btn btn-sm" data-action="conflict-cancel">취소</button>
        <button type="button" class="btn btn-sm btn-primary" data-action="conflict-done">편집기에 넣기</button>
      </div>
    </div>`;
  const list = el.querySelector('.memo-conflict-list');
  const left = el.querySelector('.memo-conflict-left');
  const done = el.querySelector('[data-action="conflict-done"]');

  // 겹친 곳 바로 앞의 같은 줄 하나를 보여 어디인지 알게 한다
  const contextOf = (part) => {
    const before = parts[parts.indexOf(part) - 1];
    return before?.kind === 'same' ? before.lines.filter((line) => line.trim()).at(-1) || '' : '';
  };

  const option = (pick, label, text, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'memo-conflict-choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');
    button.dataset.pick = pick;
    button.dataset.index = String(index);
    const name = document.createElement('span');
    name.className = 'memo-conflict-label';
    name.textContent = label;
    const body = document.createElement('span');
    body.className = 'memo-conflict-text';
    body.textContent = text;
    if (!text) body.classList.add('is-empty');
    if (!text) body.textContent = '이 부분을 지웠어요';
    button.append(name, body);
    return button;
  };

  conflicts.forEach((part, index) => {
    const item = document.createElement('li');
    item.className = 'memo-conflict-item';
    const head = document.createElement('p');
    head.className = 'memo-conflict-num';
    head.textContent = conflicts.length > 1 ? `겹친 곳 ${index + 1} / ${conflicts.length}` : '겹친 곳';
    const context = contextOf(part);
    if (context) {
      const hint = document.createElement('span');
      hint.className = 'memo-conflict-context';
      hint.textContent = `${context} 다음`;
      head.append(hint);
    }
    const choices = document.createElement('div');
    choices.className = 'memo-conflict-choices';
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', `${head.firstChild.textContent}에 남길 글`);
    choices.append(
      option('mine', '이 기기에서 쓴 글', part.mine, index),
      option('theirs', theirsLabel, part.theirs, index),
    );
    const both = document.createElement('button');
    both.type = 'button';
    both.className = 'memo-conflict-both';
    both.setAttribute('role', 'radio');
    both.setAttribute('aria-checked', 'false');
    both.dataset.pick = 'both';
    both.dataset.index = String(index);
    both.textContent = '둘 다 남기기 (이 기기의 글 다음에 다른 곳의 글)';
    choices.append(both);
    item.append(head, choices);
    list.append(item);
  });

  function render() {
    const remaining = picks.filter((pick) => !pick).length;
    left.textContent = remaining ? `${conflicts.length}곳 중 ${remaining}곳이 남았어요` : '모두 골랐어요';
    done.disabled = remaining > 0;
    for (const button of el.querySelectorAll('[data-pick]')) {
      button.setAttribute('aria-checked', String(picks[Number(button.dataset.index)] === button.dataset.pick));
    }
  }

  el.addEventListener('click', (e) => {
    const choice = e.target.closest('[data-pick]');
    if (choice) {
      picks[Number(choice.dataset.index)] = choice.dataset.pick;
      render();
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'conflict-cancel') onCancel();
    else if (action === 'conflict-done' && !done.disabled) onDone(joinParts(parts, (_, index) => picks[index]));
  });

  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  });

  render();
  return {
    el,
    focus() {
      el.querySelector('.memo-conflict-title').focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  };
}
