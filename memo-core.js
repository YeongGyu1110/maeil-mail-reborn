// 학습 기록 공용 코드: 질문 목록(index.html)과 질문 화면(questions/index.html)이 같이 쓴다.
// 학습 기록 저장(이 브라우저 / Firestore), 저장 실패 재시도, GitHub 커밋, 메모 마크다운 그리기, 메모·초안 저장을 담는다.
// 메모 보기·편집기 화면은 memo-ui.js가 맡는다 (질문 화면만 쓴다).
// 두 화면이 같은 저장 코드와 같은 브라우저 저장소 키를 쓰므로, 한 화면에서 저장한 기록을 다른 화면이 그대로 이어 읽는다.
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.14.1';
export const MEMO_MAX = 3000;
// 저장할 메모의 모양: 앞의 빈 줄과 끝의 공백만 걷어 낸다. 첫 줄의 들여쓰기(" - 항목", 들여쓴 코드)는 글의 일부라 남긴다.
// 저장된 메모와 편집 중인 글을 비교할 때도 이 모양으로 맞춘다
export const normalizeMemo = (text) => text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
// 메모는 기본 문서와 따로 묶음 문서 4개(users/{uid}/memos/0~3)에 나눠 담는다. 개수를 바꾸면 firestore.rules도 같이 바꾼다
const MEMO_SHARDS = 4;
// memoUncommitted: 계정에는 저장했지만 GitHub에는 아직 올리지 않은 메모(커밋 실패, 예전의 임시저장)면 true
const MEMO_FIELDS = ['memo', 'memoAt', 'memoUncommitted'];
// 초안: 메모를 고치는 작업본. 메모와 따로 두어, 초안을 저장해도 메모는 그대로다. 질문마다 하나다.
// { text: 초안 글, at: 초안을 저장한 시각, base: 초안을 시작할 때의 메모 (그사이 메모가 바뀌었는지 비교하고 합치는 기준) }
// Firestore에서는 질문마다 문서 하나(users/{uid}/drafts/{id})에 둔다. 메모 묶음 문서에 같이 두면 문서 크기 한도(1 MiB)를 넘을 수 있다
const DRAFT_FIELD = 'draft';
const RETRY_BASE = 5000; // 저장 실패 시 5초부터 두 배씩, 최대 10분 간격으로 다시 시도한다
const RETRY_MAX = 10 * 60 * 1000;
const CACHE_TTL = 10 * 60 * 1000; // 화면을 오갈 때마다 Firestore를 다시 읽지 않도록 탭 단위 캐시
export const STALE_AFTER = 5 * 60 * 1000; // 이만큼 자리를 비웠다 돌아오면 다른 기기의 변경을 보려고 다시 읽는다
// 새로고침은 최신 상태를 보려는 것이므로 세션 캐시를 건너뛴다
const PAGE_RELOADED = performance.getEntriesByType('navigation')[0]?.type === 'reload';
const LOCAL_KEY = 'maeil-study-v1';

// 로그인 상태. mode: unconfigured | unavailable | guest | user | error | denied
export const account = { user: null, mode: 'unconfigured' };

// 화면마다 다르게 보여줄 것: 알림, 저장 상태 표시, 실패했던 저장을 다시 보내는 데 성공했을 때 할 일
export const hooks = {
  toast() {},
  renderSaveState() {},
  afterRetry() {},
};

// ---------- 브라우저 저장소 (사생활 보호 모드 등에서 실패해도 동작하도록) ----------

export function readStore(type, key) {
  try { return JSON.parse(window[type].getItem(key)); } catch { return null; }
}

// 저장 공간이 부족하거나 저장소를 쓸 수 없으면 false를 돌려준다
export function writeStore(type, key, value) {
  try {
    window[type].setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeStore(type, key) {
  try { window[type].removeItem(key); } catch { /* 저장소를 쓸 수 없는 환경 */ }
}

// ---------- 학습 기록 저장 ----------
// items: { "fe-1": { level: "review" | "done", starred: true, memo: "...", memoAt: 1761379200000, draft: { text, at, base } } }
// memoRepo: { id, fullName: "owner/name" } (GitHub 로그인 사용자만)
// 미학습은 level이 없고, 별표가 없으면 starred가 없다. patch의 null은 해당 필드를 지운다는 뜻이다.
// 화면에서는 메모까지 한 items로 다루고, Firestore에 쓸 때만 메모를 묶음 문서로 나눈다 (createFirestoreBackend).
// 백엔드의 changeKey는 기록을 쓸 때마다 바뀌는 브라우저 저장소 키다. 다른 탭이 이 키의 storage 이벤트로 변경을 알아챈다 (watchOtherTabs).

// 브라우저 저장소에 쓰지 못했을 때 (게스트 기록 저장)
const storageFullError = () => Object.assign(new Error('브라우저 저장 공간이 부족해요'), { code: 'storage-full' });

function applyPatch(items, patch) {
  for (const [id, fields] of Object.entries(patch)) {
    const item = { ...items[id] };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete item[key];
      else item[key] = value;
    }
    if (Object.keys(item).length) items[id] = item;
    else delete items[id];
  }
}

// 저장소에서 읽은 초안을 정해진 모양으로 맞춘다 (모양이 다르면 없는 것으로 본다)
export function cleanDraft(draft) {
  if (!draft || typeof draft.text !== 'string') return null;
  return { text: draft.text, at: Number(draft.at) || 0, base: typeof draft.base === 'string' ? draft.base : '' };
}

// 계정에 저장할 수 있는 초안인지 (firestore.rules의 초안 규칙과 같다: 글과 기준 글은 MEMO_MAX자까지, 시각은 정수).
// 규칙에 어긋난 초안이 저장 대기열에 들어가면 같은 쓰기로 묶인 다른 변경까지 모두 거부되어 저장이 멈추므로, 대기열에 넣기 전에 거른다.
// 글자 수는 규칙(문자 수)보다 엄격하게 UTF-16 단위(length)로 센다 (편집기의 글자 수 제한과 같은 단위)
export const isStorableDraft = (draft) => Boolean(draft)
  && typeof draft.text === 'string' && draft.text.length <= MEMO_MAX
  && typeof draft.base === 'string' && draft.base.length <= MEMO_MAX
  && Number.isInteger(draft.at);

export const localBackend = {
  changeKey: LOCAL_KEY,
  async load() {
    return { items: readStore('localStorage', LOCAL_KEY) || {}, memoRepo: null };
  },
  // 저장 직전에 다른 탭에서 바뀌었는지 보려고 이 질문의 메모와 초안을 새로 읽는다
  async latest(id) {
    const item = (readStore('localStorage', LOCAL_KEY) || {})[id] || {};
    return { memo: item.memo || '', draft: cleanDraft(item.draft) };
  },
  async write(patch) {
    const items = readStore('localStorage', LOCAL_KEY) || {};
    applyPatch(items, patch);
    if (!writeStore('localStorage', LOCAL_KEY, items)) throw storageFullError();
  },
  clear() {
    removeStore('localStorage', LOCAL_KEY);
  },
};

// 메모가 들어갈 묶음 문서: 질문 번호를 묶음 수로 나눈 나머지 (fe-17 → 17 % 4 → memos/1)
function memoShard(id) {
  return String(Number(id.match(/\d+$/)?.[0] ?? 0) % MEMO_SHARDS);
}

const isMemoField = (key) => MEMO_FIELDS.includes(key);

// Firestore: 학습 수준·별표는 기본 문서(users/{uid}), 메모는 묶음 문서(users/{uid}/memos/0~3)에 둔다.
// 문서 하나의 최대 크기(1 MiB)를 메모가 다 쓰지 않도록 나눈 것이다.
// → 접속 시 읽기는 기본 문서 1회 + 메모 묶음 조회(있는 묶음 수만큼, 최대 4회). 변경은 필드 단위 merge 쓰기를 한 번에(batch) 보낸다
export function createFirestoreBackend(uid) {
  const ref = fb.fs.doc(fb.db, 'users', uid);
  const memosRef = fb.fs.collection(ref, 'memos');
  const memoRef = (shard) => fb.fs.doc(memosRef, shard);
  const draftsRef = fb.fs.collection(ref, 'drafts');
  const draftRef = (id) => fb.fs.doc(draftsRef, id);
  const cacheKey = `maeil-cache-${uid}`;
  const snapshotKey = `maeil-snapshot-${uid}`; // 불러오기에 실패했을 때 보여줄 마지막 기록
  const pendingKey = `maeil-pending-${uid}`; // 아직 쓰지 못한 변경 (새로고침해도 남아 다음 접속 때 보낸다)
  const changeKey = `maeil-changed-${uid}`; // 마지막으로 기록을 쓴 시각 (다른 탭에 알리는 용도)
  // 묶음으로 옮기지 못하고 기본 문서에 남아 있는 예전 메모의 질문 ID (그 메모를 바꿀 때 기본 문서에서도 지운다)
  const legacy = new Set();
  const remember = (snapshot) => {
    // 저장 공간이 부족해 새 사본을 쓰지 못하면, 오래된 사본이 최신 기록처럼 보이지 않게 지운다
    if (!writeStore('sessionStorage', cacheKey, { at: Date.now(), ...snapshot })) removeStore('sessionStorage', cacheKey);
    if (!writeStore('localStorage', snapshotKey, snapshot)) removeStore('localStorage', snapshotKey);
  };
  const announce = () => writeStore('localStorage', changeKey, Date.now());

  // 묶음 문서를 쓰기 전에는 메모가 기본 문서의 items에 있었다. 불러올 때 남아 있으면 묶음으로 옮긴다.
  // memos에는 질문마다 이긴 쪽(더 나중에 저장한 메모)이 들어 있어, 기본 문서 쪽이 이긴 메모만 묶음에 쓴다.
  async function moveLegacyMemos(legacyMemos, memos) {
    const batch = fb.fs.writeBatch(fb.db);
    const shards = {};
    const cleared = {};
    for (const [id, memo] of Object.entries(legacyMemos)) {
      cleared[id] = { memo: fb.fs.deleteField(), memoAt: fb.fs.deleteField() };
      if (memos[id] === memo) (shards[memoShard(id)] ??= {})[id] = memo;
    }
    for (const [shard, fields] of Object.entries(shards)) batch.set(memoRef(shard), fields, { merge: true });
    batch.set(ref, { items: cleared }, { merge: true });
    await batch.commit();
    for (const id of Object.keys(legacyMemos)) legacy.delete(id);
  }

  return {
    changeKey,
    async load({ fresh = false } = {}) {
      const cached = readStore('sessionStorage', cacheKey);
      if (!fresh && !PAGE_RELOADED && cached && Date.now() - cached.at < CACHE_TTL) {
        return { items: cached.items, memoRepo: cached.memoRepo || null };
      }

      // 초안을 읽지 못해도(초안 규칙을 배포하기 전 등) 다른 기록은 보여준다
      const [snap, memoDocs, draftDocs] = await Promise.all([
        fb.fs.getDoc(ref),
        fb.fs.getDocs(memosRef),
        fb.fs.getDocs(draftsRef).catch((err) => {
          console.error(err);
          return { docs: [] };
        }),
      ]);
      const doc = snap.exists() ? snap.data() : {};

      const memos = {};
      for (const memoDoc of memoDocs.docs) {
        for (const [id, memo] of Object.entries(memoDoc.data())) {
          if (memo && Object.keys(memo).length) memos[id] = memo;
        }
      }

      const items = {};
      const legacyMemos = {};
      for (const [id, item] of Object.entries(doc.items || {})) {
        const rest = {};
        const memo = {};
        for (const [key, value] of Object.entries(item)) (isMemoField(key) ? memo : rest)[key] = value;
        if (Object.keys(rest).length) items[id] = rest;
        if (!Object.keys(memo).length) continue;
        legacyMemos[id] = memo;
        legacy.add(id);
        if (!memos[id] || (memo.memoAt || 0) > (memos[id].memoAt || 0)) memos[id] = memo;
      }
      for (const [id, memo] of Object.entries(memos)) items[id] = { ...items[id], ...memo };
      for (const draftDoc of draftDocs.docs) {
        const draft = cleanDraft(draftDoc.data());
        if (draft) items[draftDoc.id] = { ...items[draftDoc.id], [DRAFT_FIELD]: draft };
      }

      // 옮기지 못해도 기록은 그대로 보여주고, 다음에 불러올 때 다시 옮긴다
      if (Object.keys(legacyMemos).length) {
        await moveLegacyMemos(legacyMemos, memos).catch((err) => console.error(err));
      }

      const loaded = { items, memoRepo: doc.memoRepo || null };
      remember(loaded);
      return loaded;
    },
    async write(patch, snapshot) {
      const main = {};
      const shards = {};
      const drafts = {}; // 질문 ID → 초안(지우면 null)
      const memoIds = [];
      for (const [id, fields] of Object.entries(patch)) {
        for (const [key, value] of Object.entries(fields)) {
          if (key === DRAFT_FIELD) {
            drafts[id] = value;
            continue;
          }
          const target = isMemoField(key) ? (shards[memoShard(id)] ??= {}) : main;
          (target[id] ??= {})[key] = value === null ? fb.fs.deleteField() : value;
        }
        if (!Object.keys(fields).some(isMemoField)) continue;
        memoIds.push(id);
        // 메모를 지우면 묶음에서 질문 항목째 지운다 (빈 항목이 남지 않게)
        if (MEMO_FIELDS.every((key) => fields[key] === null)) shards[memoShard(id)][id] = fb.fs.deleteField();
        // 기본 문서에 남은 예전 메모가 다음에 불러올 때 되살아나지 않게 같이 지운다
        if (legacy.has(id)) main[id] = { ...main[id], memo: fb.fs.deleteField(), memoAt: fb.fs.deleteField() };
      }

      const batch = fb.fs.writeBatch(fb.db);
      if (Object.keys(main).length) batch.set(ref, { items: main }, { merge: true });
      for (const [shard, memos] of Object.entries(shards)) batch.set(memoRef(shard), memos, { merge: true });
      for (const [id, draft] of Object.entries(drafts)) {
        if (draft) batch.set(draftRef(id), draft);
        else batch.delete(draftRef(id));
      }
      await batch.commit();
      for (const id of memoIds) legacy.delete(id);
      remember(snapshot);
      announce();
    },
    // 저장 직전에 다른 기기에서 바뀌었는지 보려고 이 질문의 메모(묶음 문서)와 초안을 새로 읽는다 (읽기 2회)
    async latest(id) {
      const [shardSnap, draftSnap] = await Promise.all([fb.fs.getDoc(memoRef(memoShard(id))), fb.fs.getDoc(draftRef(id))]);
      const memo = shardSnap.exists() ? shardSnap.data()[id]?.memo : '';
      return { memo: memo || '', draft: draftSnap.exists() ? cleanDraft(draftSnap.data()) : null };
    },
    async saveMemoRepo(repo, snapshot) {
      await fb.fs.setDoc(ref, { memoRepo: repo }, { mergeFields: ['memoRepo'] });
      remember(snapshot);
      announce();
    },
    loadSnapshot() {
      return readStore('localStorage', snapshotKey) || { items: {}, memoRepo: null };
    },
    loadPending() {
      return readStore('localStorage', pendingKey) || {};
    },
    // 이 기기에 보관하지 못하면(저장 공간 부족 등) false
    savePending(pending) {
      if (Object.keys(pending).length) return writeStore('localStorage', pendingKey, pending);
      removeStore('localStorage', pendingKey);
      return true;
    },
    // 다른 탭이 기록을 바꿨을 때: 이 탭에서 화면을 옮겨도 낡은 사본을 읽지 않게 캐시를 버린다
    dropCache() {
      removeStore('sessionStorage', cacheKey);
    },
    // 로그아웃할 때 기록 사본을 지운다. 쓰지 못한 변경(pending)은 다음 로그인 때 보내려고 남긴다.
    forget() {
      removeStore('sessionStorage', cacheKey);
      removeStore('localStorage', snapshotKey);
    },
  };
}

export const store = {
  backend: localBackend,
  items: {},
  memoRepo: null,
  pending: {},
  pendingKept: true, // 쓰지 못한 변경을 이 기기에 보관했는지 (저장 공간이 부족하면 페이지를 닫는 순간 사라진다)
  saving: null,
  timer: 0,
  loadedAt: 0,

  item(id) {
    return this.items[id] || {};
  },

  level(id) {
    return this.item(id).level || 'new';
  },

  async use(backend) {
    clearTimeout(this.timer);
    this.backend = backend;
    this.setLoaded(await backend.load());
  },

  // 불러오기에 실패했을 때: 마지막으로 확인한 기록을 보여주고, 변경은 모아 두었다가 나중에 쓴다
  useOffline(backend) {
    clearTimeout(this.timer);
    this.backend = backend;
    this.setLoaded(backend.loadSnapshot());
    this.loadedAt = 0; // 탭으로 돌아오면 바로 다시 불러온다
  },

  // 저장 중인 쓰기가 없을 때만 부른다. fresh가 아니면 탭 단위 캐시가 있을 때 그것을 읽는다
  async refresh({ fresh = true } = {}) {
    this.setLoaded(await this.backend.load({ fresh }));
  },

  // 아직 쓰지 못한 변경은 이 기기에서 더 나중에 바꾼 것이므로 불러온 기록 위에 덮는다
  setLoaded({ items, memoRepo }) {
    this.pending = this.backend.loadPending?.() || {};
    this.pendingKept = true; // 이 기기에서 읽어 온 대기열이다
    applyPatch(items, this.pending);
    this.items = items;
    this.memoRepo = memoRepo;
    this.loadedAt = Date.now();
  },

  async setMemoRepo(repo) {
    await this.backend.saveMemoRepo(repo, { items: this.items, memoRepo: repo });
    this.memoRepo = repo;
  },

  update(id, fields) {
    applyPatch(this.items, { [id]: fields });
    this.pending[id] = { ...this.pending[id], ...fields };
    this.keepPending();
  },

  keepPending() {
    this.pendingKept = this.backend.savePending?.(this.pending) !== false;
  },

  async flush() {
    clearTimeout(this.timer);
    while (this.saving) await this.saving;

    const patch = this.pending;
    if (!Object.keys(patch).length) return;
    this.pending = {};

    const writing = this.backend.write(patch, { items: this.items, memoRepo: this.memoRepo });
    this.saving = writing.catch(() => {}).finally(() => { this.saving = null; });
    try {
      await writing;
    } catch (err) {
      // 실패한 변경은 대기열로 되돌린다. 그사이 생긴 더 새로운 변경이 우선한다.
      for (const [id, fields] of Object.entries(patch)) {
        this.pending[id] = { ...fields, ...this.pending[id] };
      }
      throw err;
    } finally {
      this.keepPending();
    }
  },

  get busy() {
    return this.saving !== null || Object.keys(this.pending).length > 0;
  },

  // 다시 불러와도 되는지: 쓰는 중이 아니고, 이 브라우저에만 저장할 때는 대기열도 없어야 한다
  // (이 브라우저 저장은 대기열을 따로 보관하지 않아, 다시 불러오면 쓰지 못한 변경이 사라진다)
  get canReload() {
    return !this.saving && !(this.backend === localBackend && this.busy);
  },
};

// 다른 탭에서 기록을 쓰면 이 탭의 기록이 낡았다고 표시한다 (storage 이벤트는 쓴 탭이 아닌 다른 탭에만 온다).
// 기록을 바로 바꾸지 않고, 각 화면이 다음에 탭으로 돌아올 때 다시 불러오게 한다 (onStale). 고치던 메모를 덮지 않기 위해서다.
export function watchOtherTabs(onStale) {
  addEventListener('storage', (e) => {
    if (!e.key || e.key !== store.backend.changeKey) return;
    store.loadedAt = 0;
    store.backend.dropCache?.();
    onStale();
  });
}

// ---------- 저장 실패 처리 ----------

export let saveErrorShown = false;
let retryDelay = RETRY_BASE;

export const SAVE_STATE_TEXT = {
  pending: '저장 중…',
  saved: '저장됨',
  failed: '저장 실패 · 이 기기에 보관하고 다시 시도하는 중',
  unkept: '저장 실패 · 다시 시도하는 중 (저장 공간이 부족해 이 기기에 보관 못 함)',
  held: '저장 거부됨 · 이 기기에 보관 중',
  full: '저장 실패 · 브라우저 저장 공간 부족',
};

// 다시 보내도 소용없는 오류(규칙 거부, 문서 크기 초과 등)는 자동 재시도를 멈추고 다음 접속 때 다시 보낸다
const isPermanentError = (err) => ['permission-denied', 'invalid-argument', 'failed-precondition'].includes(err?.code);

function saveErrorMessage(err) {
  // 동기화는 소유자 계정만 되므로(firestore.rules) 로그인하라고 권하지 않는다
  if (err?.code === 'storage-full') return '브라우저 저장 공간이 부족해 저장하지 못했어요. 브라우저의 사이트 데이터를 정리한 뒤 다시 저장해주세요.';
  if (!store.pendingKept) return '저장하지 못했고, 브라우저 저장 공간이 부족해 이 기기에도 보관하지 못했어요. 저장될 때까지 페이지를 닫지 말아주세요.';
  if (err?.code === 'resource-exhausted') return '오늘 저장 한도를 넘었어요. 바꾼 내용은 이 기기에 보관했다가 한도가 풀리면 저장할게요.';
  if (isPermanentError(err)) return `저장이 거부됐어요(${err.code}). 바꾼 내용은 이 기기에 보관해 두었어요.`;
  return '저장하지 못했어요. 바꾼 내용은 이 기기에 보관했다가 연결되면 저장할게요.';
}

// 실패한 저장을 알리고, 일시적인 오류면 간격을 늘려 가며 다시 시도한다
export function handleSaveError(err) {
  console.error(err);
  if (!saveErrorShown) hooks.toast(saveErrorMessage(err), 'error', 5000);
  saveErrorShown = true;
  // 게스트 기록을 브라우저에 쓰지 못함: 다시 시도해도 같으니 다음 변경 때 다시 쓴다
  if (err?.code === 'storage-full') {
    hooks.renderSaveState('full');
    return;
  }
  if (isPermanentError(err)) {
    hooks.renderSaveState('held');
    return;
  }
  hooks.renderSaveState(store.pendingKept ? 'failed' : 'unkept');
  clearTimeout(store.timer);
  store.timer = setTimeout(flushInBackground, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
}

function resetSaveErrors() {
  saveErrorShown = false;
  retryDelay = RETRY_BASE;
}

export function flushInBackground() {
  store.flush()
    .then(() => {
      resetSaveErrors();
      hooks.renderSaveState(store.busy ? 'pending' : 'saved');
      hooks.afterRetry();
    })
    .catch(handleSaveError);
}

// ---------- Firebase ----------

export let fb = null;
export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

export async function loadFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [app, auth, fs] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore-lite.js`),
  ]);
  const instance = app.initializeApp(firebaseConfig);
  fb = { auth, fs, authInstance: auth.getAuth(instance), db: fs.getFirestore(instance) };
  return fb;
}

// ---------- GitHub ----------

export const githubTokenKey = (uid) => `maeil-github-token-${uid}`;

// Firebase는 GitHub 토큰을 로그인하는 순간에만 넘겨주므로 이 기기에 보관해 둔다
export function rememberGithubToken(result) {
  const token = fb.auth.GithubAuthProvider.credentialFromResult(result)?.accessToken || null;
  if (token) writeStore('localStorage', githubTokenKey(result.user.uid), token);
  return token;
}

// 이미 승인한 계정이면 GitHub 동의 화면 없이 바로 돌아온다
export async function connectGithub() {
  const result = await fb.auth.reauthenticateWithPopup(fb.authInstance.currentUser, new fb.auth.GithubAuthProvider());
  return rememberGithubToken(result);
}

function getGithubToken() {
  const token = readStore('localStorage', githubTokenKey(account.user.uid));
  return token ? Promise.resolve(token) : connectGithub();
}

export async function githubApi(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    cache: 'no-store', // 커밋 직후 다시 읽을 때 오래된 sha를 받지 않도록
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401) {
    removeStore('localStorage', githubTokenKey(account.user.uid));
    throw Object.assign(new Error('GitHub 토큰이 만료됐어요.'), { code: 'github/unauthorized' });
  }
  if (!res.ok) {
    const { message } = await res.json().catch(() => ({}));
    throw Object.assign(new Error(message || `GitHub API ${res.status}`), { status: res.status });
  }
  return res.json();
}

function toBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// 메모를 선택한 저장소의 기본 브랜치에 {id}.md로 커밋한다. 커밋 작성자는 토큰 주인(사용자)이다.
// 잔디는 기본 브랜치 커밋만 집계되므로 브랜치를 지정하지 않는다 (빈 저장소면 첫 커밋이 기본 브랜치를 만든다).
async function commitMemo(token, id, text, title) {
  const path = `/repos/${store.memoRepo.fullName}/contents/${id}.md`;

  for (let attempt = 0; ; attempt++) {
    let sha = null;
    try {
      ({ sha } = await githubApi(token, path));
    } catch (err) {
      if (err.status !== 404) throw err; // 새 파일이거나 빈 저장소
    }

    try {
      await githubApi(token, path, {
        method: 'PUT',
        body: {
          message: `${sha ? '메모 수정' : '메모 추가'}: ${id.toUpperCase()} ${title}`.trim(),
          content: toBase64(`${text}\n`),
          ...(sha && { sha }),
        },
      });
      return;
    } catch (err) {
      // 다른 기기에서 그사이 커밋해 sha가 바뀌었으면 한 번 더 시도한다
      if (err.status !== 409 || attempt > 0) throw err;
    }
  }
}

// 메모를 지우면 저장소의 {id}.md 파일도 지운다. 지난 커밋은 저장소 기록에 남는다 (잔디도 그대로).
// 파일이 없으면(커밋한 적 없는 메모) 할 일이 없으므로 false를 돌려준다
async function deleteMemoFile(token, id, title) {
  const path = `/repos/${store.memoRepo.fullName}/contents/${id}.md`;

  for (let attempt = 0; ; attempt++) {
    let sha;
    try {
      ({ sha } = await githubApi(token, path));
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }

    try {
      await githubApi(token, path, {
        method: 'DELETE',
        body: { message: `메모 삭제: ${id.toUpperCase()} ${title}`.trim(), sha },
      });
      return true;
    } catch (err) {
      // 다른 기기에서 그사이 커밋해 sha가 바뀌었으면 한 번 더 시도한다
      if (err.status !== 409 || attempt > 0) throw err;
    }
  }
}

function githubErrorMessage(err) {
  if (err.code === 'github/unauthorized') return 'GitHub 연결이 만료됐어요. 다시 저장하면 다시 연결해요.';
  if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return 'GitHub 연결을 취소했어요.';
  if (err.code === 'auth/popup-blocked') return '팝업이 차단됐어요. 다시 저장해주세요.';
  if (err.status === 429 || /rate limit/i.test(err.message)) return 'GitHub 요청 한도에 걸렸어요. 잠시 후 다시 저장해주세요.';
  if (err.status === 403 || err.status === 404) return '저장소에 접근할 수 없어요. 앱에 저장소가 추가돼 있는지 확인해주세요.';
  return `(${err.message})`;
}

// GitHub 커밋은 Firestore와 별개라, 계정 기록을 못 불러온 상태(error)에서도 한다
const canCommit = () => (account.mode === 'user' || account.mode === 'error') && Boolean(store.memoRepo);

// ---------- 메모 마크다운 ----------
// 질문 화면과 같은 파일·버전·integrity를 쓴다 (브라우저 캐시를 같이 쓰고, CDN 파일이 바뀌면 실행하지 않는다).
// 질문 화면은 본문을 그리려고 이미 불러와 두었으니 다시 받지 않는다 (페이지에 없을 때만 받는다).
// jsx는 javascript 뒤, tsx는 jsx와 typescript 뒤에 와야 한다.
const MARKDOWN_SCRIPTS = [
  ['https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js', 'sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js', 'sha384-06z5D//U/xpvxZHuUz92xBvq3DqBBFi7Up53HRrbV7Jlv7Yvh/MZ7oenfUe9iCEt'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js', 'sha384-D44bgYYKvaiDh4cOGlj1dbSDpSctn2FSUj118HZGmZEShZcO2v//Q5vvhNy206pp'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js', 'sha384-PeOqKNW/piETaCg8rqKFy+Pm6KEk7e36/5YZE5XO/OaFdO+/Aw3O8qZ9qDPKVUgx'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-jsx.min.js', 'sha384-nnKpKrv4RkNTjD3hNwkWsmHW8LBti5JWyAWAgeo8iC4QkFQn2Yn2Kj4mOTTNoI9V'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-tsx.min.js', 'sha384-ZzE8Y/KUKzSD+AEsQQvM2PdJSEVs/T/6LE/nSetJ0ReWEE/ZgpKNBSUkTRI3Dc7E'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js', 'sha384-RhrmFFMb0ZCHImjFMpR/UE3VEtIVTCtNrtKQqXCzqXZNJala02N3UbVhi+qzw3CY'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js', 'sha384-9WmlN8ABpoFSSHvBGGjhvB3E/D8UkNB9HpLJjBQFC2VSQsM1odiQDv4NbEo+7l15'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-graphql.min.js', 'sha384-CfAKPApbQPXLiw2NZvvX89i+xd8VKHk+TfWhnWgmUXxl8Ct6qPN7u30+ATfxibjS'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-sql.min.js', 'sha384-/MKWdycCDliku23mP5sYXbZNuXrzgmQO/jsVxwPFn99dVOaXRyKsqDjarqpueGAp'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-java.min.js', 'sha384-DioAMZB4yk91W6LuFit5wJDh8c5Ov09f/MBvja94y0PodMqTpTZeBeejqpRUru7D'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-yaml.min.js', 'sha384-AKAiycghK0jDCjD+aavMHzDkLzRR7Yzcwh3+xL/295cvyVMe+cxQfyQC8xxGGcI8'],
  ['https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-sass.min.js', 'sha384-vtpsGXKlAgv7RZuBJVa1roUNFN9110ZNgbj9o6S42DEC9jn43k4IHYtkqaoOODTS'],
];
const loadedScripts = new Set();
let markdownLoading = null;
let memoMarked = null;

// 이 함수로 받았거나, 페이지에 처음부터 있던 스크립트 (실패한 스크립트는 loadScript가 지운다)
const hasScript = (src) => loadedScripts.has(src) || [...document.scripts].some((script) => script.src === src && !('memo' in script.dataset));

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.async = false; // 받는 건 동시에, 실행은 넣은 순서대로
    script.dataset.memo = '';
    script.onload = () => {
      loadedScripts.add(src);
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`스크립트를 불러오지 못했어요: ${src}`));
    };
    document.head.append(script);
  });
}

// 실패하면 다음에 부를 때 아직 못 받은 파일만 다시 받는다
export function loadMarkdown() {
  if (window.marked && MARKDOWN_SCRIPTS.every(([src]) => hasScript(src))) return Promise.resolve();
  markdownLoading ??= (async () => {
    // Prism이 불러오자마자 페이지의 모든 코드를 스스로 칠하지 않게 한다 (메모 안에서만 칠한다)
    window.Prism ??= { manual: true };
    const pending = MARKDOWN_SCRIPTS.filter(([src]) => !hasScript(src));
    const results = await Promise.allSettled(pending.map(([src, integrity]) => loadScript(src, integrity)));
    // 코드 색칠(Prism)이 일부 빠져도 마크다운 자체는 보여준다
    if (!window.marked) throw results.find((r) => r.status === 'rejected')?.reason || new Error('marked를 불러오지 못했어요');
  })().finally(() => {
    markdownLoading = null;
  });
  return markdownLoading;
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// 링크·이미지 주소는 http(s)·mailto와 상대 주소만 남긴다 (javascript: 같은 주소로 코드가 실행되지 않게)
function isSafeUrl(url) {
  const scheme = url.replace(/[\u0000- \u007f]/g, '').match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return !scheme || ['http', 'https', 'mailto'].includes(scheme);
}

function sanitizeMarkdown(root) {
  for (const el of root.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      if (name.startsWith('on') || ((name === 'href' || name === 'src') && !isSafeUrl(value))) el.removeAttribute(name);
    }
    // 링크를 누르면 새 탭으로 연다 (쓰던 메모가 있는 이 페이지를 떠나지 않게)
    if (el.matches('a[href]')) {
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
  }
}

// GitHub에서 .md 파일을 보여주는 방식(GFM, 한 줄 바꿈은 이어 붙임)에 맞춰 그린다
export function renderMarkdown(container, text) {
  memoMarked ??= new window.marked.Marked({
    gfm: true,
    // 메모 안의 HTML 태그는 실행하지 않고 글자 그대로 보여준다
    renderer: { html: ({ text: html }) => escapeHtml(html) },
  });
  const template = document.createElement('template');
  template.innerHTML = memoMarked.parse(text);
  sanitizeMarkdown(template.content);
  container.replaceChildren(template.content);
  window.Prism?.highlightAllUnder?.(container);
}

// ---------- 학습 수준·별표 저장 ----------

const LEVEL_SAVE_DELAY = 1200; // 학습 수준·별표 변경을 모아 한 번에 쓴다

// store.update로 바꾼 학습 수준·별표를 곧 저장한다
export function saveSoon() {
  // 거부된 계정은 보내 봐야 거부되니 요청하지 않는다 (변경은 이 기기에 보관돼 있다)
  if (account.mode === 'denied') {
    hooks.renderSaveState('held');
    return;
  }
  hooks.renderSaveState('pending');
  clearTimeout(store.timer);
  // 이 브라우저에만 저장할 때는 비용이 없으니 바로 쓴다
  if (store.backend === localBackend) flushInBackground();
  else store.timer = setTimeout(flushInBackground, LEVEL_SAVE_DELAY);
}

// ---------- 메모 저장 ----------
// 편집기 모양은 질문 화면이 정하고, 여기서는 글자를 받아 기록에 쓰고 GitHub에 커밋하는 일만 한다.

// 계정에는 저장했지만 GitHub에는 아직 올리지 않은 메모인지 (커밋에 실패했거나 예전 임시저장으로 저장했다).
// 메모와 함께 계정에 남으므로 새로고침하거나 다른 기기에서 열어도 알 수 있다
export const isUncommitted = (id) => store.item(id).memoUncommitted === true;

// 저장할 때 GitHub에도 커밋하는지
export const canCommitMemo = canCommit;

// 편집기 꼬리에 보여줄 GitHub 안내 (커밋하지 않으면 빈 문자열)
export function memoCommitNote(id) {
  if (!canCommit()) return '';
  return `저장하면 ${store.memoRepo.fullName}의 ${id}.md로 커밋돼요`;
}

// 메모를 저장한다. 빈 글이면 메모를 지우고, GitHub에 커밋하는 계정이면 저장소의 {id}.md 파일도 지운다.
// dropDraft: 이 질문의 초안도 같은 쓰기로 지운다 (초안을 메모로 저장했거나, 메모와 함께 지울 때).
//   이 기기의 기록에 초안이 없어도 지운다. 다른 곳에서 저장한 초안을 편집기에서 합쳤을 수 있기 때문이다 (없는 초안을 지워도 오류가 아니다).
//   메모만 다시 올릴 때(GitHub 재커밋)는 주지 않는다. 쓰던 초안은 그대로 둔다.
// GitHub 토큰이 없으면 팝업을 열어야 하므로, 저장 버튼을 누른 직후(브라우저가 팝업을 허락하는 몇 초 안에) 불러야 한다.
// title은 GitHub 커밋 메시지에 붙일 질문 제목이다. 돌려주는 saved는 계정(또는 이 브라우저)에 쓰는 데 성공했는지,
// committed는 GitHub에 올렸는지(올리지 않았으면 null)다. 쓰지 못해도 메모는 이미 기록에 들어가 이 기기에 보관되고, 연결되면 다시 보낸다.
export async function saveMemo(id, rawText, { title = '', dropDraft = false } = {}) {
  const text = normalizeMemo(rawText);
  const changed = text !== (store.item(id).memo || '');
  const shouldCommit = Boolean(text) && canCommit() && (changed || isUncommitted(id));
  const shouldRemoveFile = !text && changed && canCommit();
  if (!changed && !shouldCommit && !dropDraft) return { saved: true, changed: false, committed: null };

  const write = changed || dropDraft;
  if (changed) {
    // 커밋할 때는 성공했다고 보고 표시를 지워 둔다 (실패하면 아래에서 다시 켠다)
    store.update(id, text ? { memo: text, memoAt: Date.now(), memoUncommitted: null } : { memo: null, memoAt: null, memoUncommitted: null });
  }
  if (dropDraft) store.update(id, { [DRAFT_FIELD]: null });
  if (write) hooks.renderSaveState('pending');

  // 토큰이 없으면 클릭 직후 팝업을 열어야 하므로 Firestore 저장과 GitHub 커밋(또는 파일 삭제)을 함께 시작한다
  let github = Promise.resolve();
  if (shouldCommit) github = getGithubToken().then((token) => commitMemo(token, id, text, title));
  else if (shouldRemoveFile) github = getGithubToken().then((token) => deleteMemoFile(token, id, title));
  const [saved, committed] = await Promise.allSettled([write ? store.flush() : Promise.resolve(), github]);

  // 커밋 결과를 계정에 남긴다 (바뀔 때만 쓴다)
  let flagged = Promise.resolve();
  if (shouldCommit) {
    const pending = committed.status === 'rejected';
    if (pending !== isUncommitted(id)) {
      store.update(id, { memoUncommitted: pending || null });
      flagged = store.flush();
    }
  }
  const [flagResult] = await Promise.allSettled([flagged]);

  if (write && saved.status === 'fulfilled') hooks.renderSaveState(store.busy ? 'pending' : 'saved');

  if (saved.status === 'rejected' || flagResult.status === 'rejected') {
    saveErrorShown = false; // 메모는 직접 누른 저장이라 매번 알린다
    handleSaveError(saved.status === 'rejected' ? saved.reason : flagResult.reason);
  } else if (committed.status === 'rejected') {
    console.error(committed.reason);
    // 지운 메모는 다시 올릴 자리가 없으므로, GitHub 파일을 못 지우면 알리기만 한다 (저장소에 옛 내용이 남는다)
    hooks.toast(shouldRemoveFile
      ? `메모는 지웠지만 GitHub의 ${id}.md 파일을 지우지 못했어요. ${githubErrorMessage(committed.reason)}`
      : `메모는 저장했지만 GitHub에 올리지 못했어요. ${githubErrorMessage(committed.reason)}`, 'error', 5000);
  } else {
    resetSaveErrors();
    let message = text ? '메모를 저장했어요.' : '메모를 지웠어요.';
    if (shouldCommit) message = `메모를 저장하고 ${store.memoRepo.fullName}에 커밋했어요.`;
    else if (shouldRemoveFile && committed.value) message = `메모를 지우고 ${store.memoRepo.fullName}의 ${id}.md 파일도 삭제했어요.`;
    hooks.toast(message);
  }

  return {
    saved: saved.status === 'fulfilled',
    changed,
    committed: shouldCommit || shouldRemoveFile ? committed.status === 'fulfilled' : null,
  };
}

// ---------- 초안 ----------
// 초안 저장은 사용자가 직접 한다 (Ctrl+S, 더보기의 '초안 저장', 닫을 때 묻는 창). 저절로 저장하지 않는다.

export const draftOf = (id) => cleanDraft(store.item(id)[DRAFT_FIELD]);

// 초안을 저장한다. base는 이 초안을 시작할 때의 메모다. 쓰지 못해도 초안은 이 기기에 보관되고, 연결되면 다시 보낸다.
// 돌려주는 값: { saved: 계정(또는 이 브라우저)에 썼는지, draft: 저장한 초안 }.
// 계정에 저장할 수 없는 초안(글이나 기준 글이 MEMO_MAX자를 넘음)은 대기열에 넣지 않고 draft: null을 돌려준다 (isStorableDraft)
export async function saveDraft(id, rawText, base) {
  const draft = { text: normalizeMemo(rawText), at: Date.now(), base };
  if (!isStorableDraft(draft)) return { saved: false, draft: null };
  store.update(id, { [DRAFT_FIELD]: draft });
  return { saved: await writeNow(), draft };
}

// 초안을 지운다. 메모는 그대로다
export async function deleteDraft(id) {
  store.update(id, { [DRAFT_FIELD]: null });
  return { saved: await writeNow() };
}

// 직접 누른 저장이라 기다렸다가 결과를 알린다 (실패는 매번 알린다)
async function writeNow() {
  if (account.mode === 'denied') {
    hooks.renderSaveState('held');
    return false;
  }
  hooks.renderSaveState('pending');
  try {
    await store.flush();
    resetSaveErrors();
    hooks.renderSaveState(store.busy ? 'pending' : 'saved');
    return true;
  } catch (err) {
    saveErrorShown = false;
    handleSaveError(err);
    return false;
  }
}

// 저장 직전에 이 질문의 메모와 초안을 새로 읽는다 (다른 기기나 탭에서 바뀌었는지 보려고).
// 이 기기에서 아직 보내지 못한 변경은 이 기기에서 더 나중에 한 것이므로 읽은 값 위에 덮는다. 읽지 못하면 null
export async function fetchLatest(id) {
  if (!store.backend.latest) return null;
  try {
    const latest = await store.backend.latest(id);
    const pending = store.pending[id] || {};
    if ('memo' in pending) latest.memo = pending.memo || '';
    if (DRAFT_FIELD in pending) latest.draft = cleanDraft(pending[DRAFT_FIELD]);
    return latest;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// 예전에는 쓰던 메모를 이 브라우저에 저절로 보관했다 (maeil-memo-draft-{id}). 남아 있으면 초안으로 옮긴다.
// 이미 초안이 있거나 저장된 메모와 같은 글이면 옮기지 않고 지운다. 계정에 저장할 수 없는 글(MEMO_MAX자 초과)은
// 옮기지도 지우지도 않는다 (지우면 쓰던 글이 사라지고, 옮기면 규칙에 거부되어 다른 저장까지 막는다). 옮긴 수를 돌려준다
const OLD_DRAFT_PREFIX = 'maeil-memo-draft-';

export function moveOldDrafts() {
  if (account.mode === 'denied') return 0;
  let keys = [];
  try {
    keys = Object.keys(localStorage).filter((key) => key.startsWith(OLD_DRAFT_PREFIX));
  } catch {
    return 0;
  }
  let moved = 0;
  for (const key of keys) {
    const id = key.slice(OLD_DRAFT_PREFIX.length);
    const old = readStore('localStorage', key);
    const text = typeof old?.text === 'string' ? normalizeMemo(old.text) : '';
    const memo = store.item(id).memo || '';
    const draft = { text, at: Math.trunc(Number(old?.at)) || Date.now(), base: memo };
    const wanted = /^(fe|be)-\d+$/.test(id) && text && text !== memo && !draftOf(id);
    if (wanted && !isStorableDraft(draft)) continue;
    if (wanted) {
      store.update(id, { [DRAFT_FIELD]: draft });
      moved++;
    }
    removeStore('localStorage', key);
  }
  if (moved) flushInBackground();
  return moved;
}
