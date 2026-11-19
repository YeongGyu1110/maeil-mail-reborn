// 배포 직후 캐시가 섞여 페이지 스크립트가 멈추는 것을 한 번 자동으로 고친다.
//
// 페이지(HTML)와 공용 모듈(memo-core.js 등)은 브라우저가 따로 캐시한다 (GitHub Pages: 10분).
// 배포 직후에는 새 HTML과 옛 모듈(또는 그 반대)이 섞일 수 있고, 가져오려는 이름이 없으면
// 브라우저는 페이지 모듈을 한 줄도 실행하지 않는다 (목록이 뜨지 않고, 학습 기록이 '불러오는 중'에 멈춘다).
//
// 페이지 모듈은 시작하자마자 window.maeilModuleReady를 켠다. 문서를 다 읽은 뒤(DOMContentLoaded, 모듈 실행이 끝난 뒤)
// 이 표시가 없으면, 이 페이지가 불러온 같은 사이트의 JS를 캐시를 건너뛰고 다시 받아 한 번 새로고침한다.
// 1분 안에 또 실패하면 다시 새로고침하지 않고 알린다 (무한 새로고침 방지).
// 이 파일은 모듈이 아닌 보통 스크립트라 다른 파일과 버전이 섞여도 멈추지 않는다. 오류 문구에 기대지 않아 브라우저마다 같게 동작한다.
(function () {
  var RETRY_KEY = 'maeil-module-retry';
  var RETRY_GAP = 60 * 1000;

  function readRetry() {
    try {
      return Number(sessionStorage.getItem(RETRY_KEY)) || 0;
    } catch (e) {
      return null; // 기록할 수 없으면 새로고침이 되풀이되지 않게 다시 시도하지 않는다
    }
  }

  function showFailure() {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = '페이지를 새로 불러오지 못했어요. 잠시 뒤 새로고침해주세요.';
    toast.dataset.tone = 'error';
    toast.classList.add('show');
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.maeilModuleReady) {
      try { sessionStorage.removeItem(RETRY_KEY); } catch (e) { /* 저장소를 쓸 수 없는 환경 */ }
      return;
    }

    var last = readRetry();
    if (last === null || Date.now() - last < RETRY_GAP) {
      showFailure();
      return;
    }
    try {
      sessionStorage.setItem(RETRY_KEY, String(Date.now()));
    } catch (e) {
      showFailure();
      return;
    }

    // 이 페이지가 불러온 같은 사이트의 JS (공용 모듈과 그 모듈이 다시 불러온 파일)
    var urls = [];
    performance.getEntriesByType('resource').forEach(function (entry) {
      var url = new URL(entry.name, location.href);
      if (url.origin === location.origin && /\.js$/.test(url.pathname) && urls.indexOf(url.href) === -1) urls.push(url.href);
    });

    // 캐시를 건너뛰고 다시 받아 캐시를 새 파일로 바꾼 뒤 새로고침한다 (페이지 HTML은 새로고침할 때 서버에 다시 확인한다)
    Promise.all(urls.map(function (url) {
      return fetch(url, { cache: 'reload' }).catch(function () {});
    })).then(function () {
      location.reload();
    });
  });
})();
