// node --test tests/ 로 돌린다 (설치할 것 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMemo, joinParts } from '../memo-merge.js';

const L = (...lines) => lines.join('\n');
const base = L('## 핵심', '함수가 선언될 때의 스코프를 기억한다', '', '## 예시', '카운터', '', '## 헷갈린 점', 'var와 let');

test('한쪽만 고치면 그 변경을 받는다', () => {
  const mine = base.replace('카운터', '카운터, 모듈 패턴');
  assert.deepEqual(mergeMemo(base, mine, base), { ...mergeMemo(base, mine, base), clean: true, text: mine });
  assert.equal(mergeMemo(base, base, mine).text, mine);
});

test('두 쪽이 서로 다른 곳을 고치면 둘 다 들어간다', () => {
  const mine = base.replace('카운터', '카운터, 모듈 패턴');
  const theirs = base.replace('var와 let', 'var와 let의 차이: 반복마다 새 환경');
  const r = mergeMemo(base, mine, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.text, base.replace('카운터', '카운터, 모듈 패턴').replace('var와 let', 'var와 let의 차이: 반복마다 새 환경'));
});

test('두 쪽이 같은 줄을 다르게 고치면 충돌로 남긴다', () => {
  const mine = base.replace('카운터', '카운터 (내 글)');
  const theirs = base.replace('카운터', '카운터 (다른 곳)');
  const r = mergeMemo(base, mine, theirs);
  assert.equal(r.clean, false);
  const conflicts = r.parts.filter((p) => p.kind === 'conflict');
  assert.equal(conflicts.length, 1);
  assert.deepEqual([conflicts[0].base, conflicts[0].mine, conflicts[0].theirs], ['카운터', '카운터 (내 글)', '카운터 (다른 곳)']);
  assert.equal(joinParts(r.parts, () => 'theirs'), theirs);
  assert.equal(joinParts(r.parts, () => 'mine'), mine);
  assert.equal(joinParts(r.parts, () => 'both'), base.replace('카운터', '카운터 (내 글)\n카운터 (다른 곳)'));
});

test('두 쪽이 똑같이 고쳤으면 충돌이 아니다', () => {
  const same = base.replace('카운터', '카운터, 모듈 패턴');
  assert.deepEqual([mergeMemo(base, same, same).clean, mergeMemo(base, same, same).text], [true, same]);
});

test('바로 붙은 줄을 따로 고치면 충돌로 본다 (git과 같다)', () => {
  const mine = base.replace('## 예시', '## 예시 코드');
  const theirs = base.replace('카운터', '카운터 함수');
  assert.equal(mergeMemo(base, mine, theirs).clean, false);
});

test('한쪽이 지우고 다른 쪽이 고친 곳은 충돌이고, 지운 쪽을 고르면 빈 줄을 남기지 않는다', () => {
  const mine = L('## 핵심', '함수가 선언될 때의 스코프를 기억한다', '', '## 예시', '', '## 헷갈린 점', 'var와 let');
  const theirs = base.replace('카운터', '카운터 함수');
  const r = mergeMemo(base, mine, theirs);
  assert.equal(r.clean, false);
  assert.equal(joinParts(r.parts, () => 'mine'), mine);
});

test('끝에 각자 덧붙이면 충돌이고, 둘 다 고르면 내 글 다음에 다른 곳의 글', () => {
  const mine = `${base}\n- 내가 덧붙임`;
  const theirs = `${base}\n- 다른 곳에서 덧붙임`;
  const r = mergeMemo(base, mine, theirs);
  assert.equal(r.clean, false);
  assert.equal(joinParts(r.parts, () => 'both'), `${base}\n- 내가 덧붙임\n- 다른 곳에서 덧붙임`);
});

test('빈 글에서 두 곳이 따로 쓰기 시작하면 충돌, 같으면 그대로', () => {
  assert.equal(mergeMemo('', '내 글', '다른 글').clean, false);
  assert.deepEqual([mergeMemo('', '같은 글', '같은 글').clean, mergeMemo('', '같은 글', '같은 글').text], [true, '같은 글']);
  assert.equal(mergeMemo('', '', '').text, '');
});

test('다른 곳에서 다 지웠는데 나는 고쳤으면 충돌', () => {
  const r = mergeMemo(base, base.replace('카운터', '카운터!'), '');
  assert.equal(r.clean, false);
  assert.equal(joinParts(r.parts, () => 'theirs'), '');
});

test('빈 줄만 있는 같은 부분도 그대로 남는다', () => {
  const b = L('a', '', 'b');
  const r = mergeMemo(b, L('a', '', 'b', 'c'), L('z', 'a', '', 'b'));
  assert.deepEqual([r.clean, r.text], [true, L('z', 'a', '', 'b', 'c')]);
});

test('긴 메모(3,000자 한 줄씩)도 금방 끝난다', () => {
  const big = Array.from({ length: 3000 }, (_, i) => String(i % 7)).join('\n');
  const t = Date.now();
  const r = mergeMemo(big, `${big}\nx`, `y\n${big}`);
  assert.equal(r.clean, true);
  assert.ok(Date.now() - t < 2000);
});

// 위 테스트는 앞뒤의 같은 줄을 잘라 내는 데서 끝난다. 앞쪽과 뒤쪽을 함께 고치면 가운데 전체를 비교 표(LCS)로 비교한다
test('긴 메모의 앞뒤를 함께 고쳐 가운데 전체를 비교해도 금방 끝나고 바르게 합친다', () => {
  const lines = Array.from({ length: 1500 }, (_, i) => `줄 ${i}`);
  const mine = [...lines];
  mine[10] = '내가 고친 줄 10';
  mine[1490] = '내가 고친 줄 1490';
  const theirs = [...lines];
  theirs[700] = '다른 곳에서 고친 줄 700';
  const t = Date.now();
  const r = mergeMemo(lines.join('\n'), mine.join('\n'), theirs.join('\n'));
  assert.ok(Date.now() - t < 2000);
  const expected = [...mine];
  expected[700] = theirs[700];
  assert.deepEqual([r.clean, r.text], [true, expected.join('\n')]);
});

test('충돌 자리에서 빈 줄로 바꾼 것([""])과 지운 것([])을 줄 목록으로 구분한다', () => {
  const blanked = mergeMemo(L('a', 'b', 'c'), L('a', '', 'c'), L('a', 'x', 'c')).parts.find((p) => p.kind === 'conflict');
  assert.deepEqual([blanked.mine, blanked.mineLines], ['', ['']]);
  const removed = mergeMemo(L('a', 'b', 'c'), L('a', 'c'), L('a', 'x', 'c')).parts.find((p) => p.kind === 'conflict');
  assert.deepEqual([removed.mine, removed.mineLines], ['', []]);
});

test('어느 쪽을 이 기기의 글로 넣어도 합친 결과가 같다 (무작위 2,000건)', () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pool = ['a', 'b', '', 'c'];
  const edit = (lines) => {
    const out = [...lines];
    for (let k = rand(4); k > 0; k--) {
      const at = rand(out.length + 1);
      const op = rand(3);
      if (op === 0) out.splice(at, 0, pool[rand(pool.length)]);
      else if (out.length && op === 1) out.splice(Math.min(at, out.length - 1), 1);
      else if (out.length) out[Math.min(at, out.length - 1)] = `x${rand(5)}`;
    }
    return out;
  };
  for (let i = 0; i < 2000; i++) {
    const base = Array.from({ length: rand(8) }, () => pool[rand(pool.length)]);
    const o = base.join('\n');
    const a = edit(base).join('\n');
    const b = edit(base).join('\n');
    const ab = mergeMemo(o, a, b);
    const ba = mergeMemo(o, b, a);
    assert.equal(ab.clean, ba.clean, JSON.stringify({ o, a, b }));
    if (ab.clean) assert.equal(ab.text, ba.text, JSON.stringify({ o, a, b }));
  }
});
