// 메모 세 갈래 합치기: 같은 글을 두 곳에서 따로 고쳤을 때, 갈라지기 전의 글(base)을 기준으로 두 쪽의 변경을 합친다.
// git의 diff3와 같은 방식이다: 줄 단위로 비교하고, 한쪽만 고친 곳은 그 변경을 받고, 두 쪽이 같은 곳(또는 바로 붙은 곳)을
// 서로 다르게 고쳤으면 충돌로 남긴다. 바로 붙은 변경까지 충돌로 보는 것도 git과 같다 (잘못 합치는 것보다 묻는 편이 낫다).
// 화면이나 저장소에 기대지 않는 순수한 함수만 둔다 (웹과 앱이 같은 파일을 쓴다).

const toLines = (text) => (text === '' ? [] : text.split('\n'));

// a를 b로 바꾸는 변경 묶음: a[aStart, aEnd)를 b[bStart, bEnd)로 바꾼다. 가장 긴 공통 줄(LCS)을 남기고 나머지를 변경으로 본다
function diffLines(a, b) {
  // 앞뒤로 같은 줄은 비교에서 뺀다 (메모는 대개 일부만 바뀌므로 표가 크게 줄어든다)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];

  // lcs[i * width + j]: a[start+i..endA)와 b[start+j..endB)의 가장 긴 공통 줄 수 (뒤에서부터 채운다)
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[start + i] === b[start + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const hunks = [];
  let i = 0;
  let j = 0;
  let open = null; // 지금 모으는 변경의 시작 { i, j }
  const close = () => {
    if (!open) return;
    hunks.push({ aStart: start + open.i, aEnd: start + i, bStart: start + open.j, bEnd: start + j });
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { i, j };
      if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) j++;
      else i++;
    }
  }
  close();
  return hunks;
}

// 한 묶음(base[start, end)) 안에서 한쪽의 변경만 적용한 줄들과, 줄마다 그 쪽에서 바꾼 줄인지(mark) 아니면 그대로인 줄('')인지
function applySide(base, side, hunks, start, end, mark) {
  const lines = [];
  const marks = [];
  const keep = (from, to) => {
    for (const line of base.slice(from, to)) {
      lines.push(line);
      marks.push('');
    }
  };
  let at = start;
  for (const h of hunks) {
    keep(at, h.aStart);
    for (const line of side.slice(h.bStart, h.bEnd)) {
      lines.push(line);
      marks.push(mark);
    }
    at = h.aEnd;
  }
  keep(at, end);
  return { lines, marks };
}

/**
 * base: 두 쪽이 갈라지기 전의 글, mine: 이 기기에서 쓴 글, theirs: 그사이 다른 곳에서 저장한 글.
 * 돌려주는 값:
 *   clean: 충돌 없이 합쳐졌는지
 *   text: 합친 글 (충돌이 있으면 충돌 자리에 내 글을 넣은 글. 충돌은 대개 parts로 사람이 고르게 한다)
 *   parts: 차례대로 { kind: 'same', lines, marks } 또는 { kind: 'conflict', base, mine, theirs, mineLines, theirLines }
 *          (base·mine·theirs는 충돌 자리의 글, 지운 쪽이면 빈 문자열)
 *          marks는 같은 조각의 줄마다 어디서 온 줄인지다: '' (갈라지기 전 그대로) | 'mine' (이 기기에서 고친 줄)
 *          | 'theirs' (다른 곳에서 고친 줄) | 'both' (두 쪽이 똑같이 고친 줄). 저절로 합쳐진 줄을 화면에 표시하는 데 쓴다
 */
export function mergeMemo(base, mine, theirs) {
  const o = toLines(base);
  const a = toLines(mine);
  const b = toLines(theirs);
  const hunks = [
    ...diffLines(o, a).map((h) => ({ ...h, side: 'mine' })),
    ...diffLines(o, b).map((h) => ({ ...h, side: 'theirs' })),
  ].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd);

  // 겹치거나 바로 붙은 변경을 한 묶음으로 모은다
  const groups = [];
  for (const h of hunks) {
    const last = groups.at(-1);
    if (last && h.aStart <= last.end) {
      last.end = Math.max(last.end, h.aEnd);
      last.hunks.push(h);
    } else {
      groups.push({ start: h.aStart, end: h.aEnd, hunks: [h] });
    }
  }

  const parts = [];
  const pushSame = (lines, marks = lines.map(() => '')) => {
    if (!lines.length) return;
    const last = parts.at(-1);
    if (last?.kind === 'same') {
      last.lines.push(...lines);
      last.marks.push(...marks);
    } else {
      parts.push({ kind: 'same', lines: [...lines], marks: [...marks] });
    }
  };
  let at = 0;
  for (const g of groups) {
    pushSame(o.slice(at, g.start));
    const mineHunks = g.hunks.filter((h) => h.side === 'mine');
    const theirHunks = g.hunks.filter((h) => h.side === 'theirs');
    const mineSide = applySide(o, a, mineHunks, g.start, g.end, 'mine');
    const theirSide = applySide(o, b, theirHunks, g.start, g.end, 'theirs');
    const mineLines = mineSide.lines;
    const theirLines = theirSide.lines;
    if (!theirHunks.length) pushSame(mineLines, mineSide.marks);
    else if (!mineHunks.length) pushSame(theirLines, theirSide.marks);
    else if (mineLines.join('\n') === theirLines.join('\n') && mineLines.length === theirLines.length) {
      // 두 쪽이 똑같이 고쳤다
      pushSame(mineLines, mineSide.marks.map((m, i) => (m || theirSide.marks[i] ? 'both' : '')));
    } else {
      parts.push({
        kind: 'conflict',
        base: o.slice(g.start, g.end).join('\n'),
        mine: mineLines.join('\n'),
        theirs: theirLines.join('\n'),
        mineLines,
        theirLines,
      });
    }
    at = g.end;
  }
  pushSame(o.slice(at));

  return {
    clean: parts.every((p) => p.kind === 'same'),
    text: joinParts(parts, () => 'mine'),
    parts,
  };
}

/**
 * 충돌마다 고른 것으로 글을 만든다. choose(part, index)는 'mine' | 'theirs' | 'both'를 돌려준다 (both는 내 글 다음에 다른 곳의 글).
 */
export function joinParts(parts, choose) {
  let conflict = 0;
  const lines = [];
  for (const part of parts) {
    if (part.kind === 'same') {
      lines.push(...part.lines);
      continue;
    }
    const pick = choose(part, conflict++);
    if (pick === 'theirs') lines.push(...part.theirLines);
    else if (pick === 'both') lines.push(...part.mineLines, ...part.theirLines);
    else lines.push(...part.mineLines);
  }
  return lines.join('\n');
}
