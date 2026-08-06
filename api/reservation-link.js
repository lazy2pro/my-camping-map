// api/reservation-link.js
// 캠핑장 이름으로 네이버 검색(웹문서) API를 통해 캠핏/땡큐캠핑의 실제 페이지를 찾고,
// 그 페이지에 캠핑장 이름이 실제로 들어있는지 확인(검증)한 뒤에만 링크를 돌려줍니다.
//
// (참고: 구글 Custom Search JSON API는 2026년 기준 신규 프로젝트에 더 이상 발급되지 않아
//  네이버 API HUB로 대체했습니다. 네이버도 2026년에 옛 개발자센터 방식에서
//  NAVER Cloud Platform의 통합 API HUB 방식으로 이전했습니다.)
//
// 필요 환경변수 (NAVER API HUB에서 "웹문서" API를 선택해 발급받은 값):
//   NAVER_CLIENT_ID     - Application key의 Client ID (X-NCP-APIGW-API-KEY-ID)
//   NAVER_CLIENT_SECRET - Application key의 Client Secret (X-NCP-APIGW-API-KEY)

const TARGET_SITES = {
  // pattern: 해당 도메인 매칭 / detailPath: "개별 캠핑장 상세페이지"로 보이는 URL 패턴
  // (봇 차단으로 내용 검증이 불가능할 때, 이 패턴이면 신뢰하고 통과시킴)
  //
  // 주의: "땡큐캠핑"의 실제 도메인은 thankyoucamping.com이 아니라 thankqcamping.com("Thank Q")임.
  // (실사용자 확인 결과로 발견 - 이전 버전은 잘못된 도메인을 찾고 있어서 항상 못 찾았음)
  camfit: { pattern: /camfit\.co\.kr/i, detailPath: /\/camp\/[a-z0-9]+/i },
  thankyoucamping: { pattern: /thankqcamping\.com/i, detailPath: /cseq=\d+/i },
};

export default async function handler(req, res) {
  try {
    const { name, officialUrl, region } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'name 파라미터가 필요합니다.' });
    }

    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 설정되어 있지 않습니다.',
      });
    }

    // 검색어를 두 번(예약/캠핑) 돌려서 후보군을 넓힘 - 병렬로 동시 실행해서 속도 개선
    const headers = {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
    };
    const queries = [`${name} 예약`, `${name} 캠핑`];
    const searchResults = await Promise.all(
      queries.map(async (q) => {
        const searchUrl = `https://naverapihub.apigw.ntruss.com/search/v1/webkr?query=${encodeURIComponent(q)}&display=30&format=json`;
        const searchRes = await fetch(searchUrl, { headers });
        const searchData = await searchRes.json();
        return { ok: searchRes.ok, data: searchData };
      })
    );
    const failed = searchResults.find((r) => !r.ok);
    if (failed) {
      return res.status(502).json({ error: '네이버 검색 API 오류', detail: failed.data });
    }
    const allItems = searchResults.flatMap((r) => r.data.items || []);

    const items = allItems.map((it) => ({ ...it, link: (it.link || '').replace(/&amp;/g, '&') }));

    const debug = req.query.debug === '1';
    const result = { camfit: null, thankyoucamping: null };
    const candidateFound = { camfit: false, thankyoucamping: false }; // 검증 여부와 무관하게, 후보 링크 자체가 있었는지
    const debugInfo = { allLinks: [...new Set(items.map((it) => it.link))] };

    // 주소에서 넘어온 지역명(예: "경기 하남시")을 토큰으로 분리 - 검색결과 스니펫에
    // 이 지역명이 언급되는지로 "이름만 비슷한 다른 지역 캠핑장"을 걸러내는 데 씀
    // (예: "따봄"(경기 하남) 검색 시 이름이 겹치는 "따봄스테이"(충북 괴산)를 오인하는 걸 방지)
    const regionTokens = (region || '').split(/\s+/).filter((t) => t.length >= 2);
    const normalizeText = (s) => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').toLowerCase();
    const snippetMatchesRegion = (it) => {
      if (!regionTokens.length) return null; // 지역 정보 자체가 없으면 판단 보류(null)
      const snippet = normalizeText(it.title) + normalizeText(it.description);
      return regionTokens.some((t) => snippet.includes(normalizeText(t)));
    };

    // 캠핏/땡큐캠핑 검증과, 고캠핑 API가 준 공식 예약링크(officialUrl) 생존 확인을 모두 병렬 실행
    const [, officialValid] = await Promise.all([
      Promise.all(
        Object.entries(TARGET_SITES).map(async ([key, cfg]) => {
          const domainMatches = items.filter((it) => cfg.pattern.test(it.link));
          if (!domainMatches.length) {
            if (debug) debugInfo[key] = { candidateFound: false };
            return;
          }

          // 지역명이 스니펫에 언급된 후보를 최우선으로 선택 (없으면 그냥 첫 후보)
          const regionMatched = domainMatches.find((it) => snippetMatchesRegion(it) === true);
          const found = regionMatched || domainMatches[0];
          const regionOk = snippetMatchesRegion(found); // true/false/null(정보없음)

          candidateFound[key] = true;
          const verifyResult = await pageContainsName(found.link, name);
          const isDetailPage = cfg.detailPath.test(found.link);
          // 내용 검증 성공 -> 확실히 신뢰
          // 봇 차단(403 등)으로 검증 자체가 불가능했는데, URL이 "개별 캠핑장 상세페이지" 패턴이고
          // + (지역 정보가 없거나, 있다면 스니펫의 지역명도 일치)하면 신뢰하고 통과시킴.
          // 지역명이 확실히 불일치(regionOk === false)하면 절대 통과시키지 않음 (오매칭 방지)
          const trustedFallback = !verifyResult.checked && isDetailPage && regionOk !== false;

          // 지역명이 확실히 다르면(regionOk === false), 내용 검증(verified)에 통과했더라도
          // 신뢰하지 않음 - 이름이 부분적으로 겹치는 다른 지역 캠핑장일 가능성이 높음
          if (regionOk !== false && (verifyResult.verified || trustedFallback)) {
            result[key] = found.link;
          }
          if (debug) {
            debugInfo[key] = {
              candidateFound: true,
              candidateLink: found.link,
              isDetailPage,
              regionOk,
              trustedFallback,
              ...verifyResult,
            };
          }
        })
      ),
      checkUrlAlive(officialUrl),
    ]);

    // 참고: 네이버예약 자동감지는 시도했으나, 네이버지도의 비공식 검색 API가
    // 캡차(ncaptcha)로 자동화된 요청을 차단해서 서버에서는 확인이 불가능함을 확인.
    // 프론트엔드에서 "네이버지도에서 보기" 링크는 검증 없이 그대로 제공.

    // 같은 캠핑장 이름은 7일간 캐시 (여러 사용자가 같은 캠핑장을 눌러도 API 재호출 안 함)
    // 디버그 요청은 캐시하지 않음
    if (!debug) {
      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');
    }
    return res.status(200).json(
      debug
        ? { ...result, candidateFound, officialValid, debug: debugInfo }
        : { ...result, candidateFound, officialValid }
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// 고캠핑 API가 준 공식 예약링크가 실제로 살아있는지 확인 (404 등 죽은 링크 감지용)
// officialUrl이 없으면 null(확인 대상 아님)을 돌려줌 - false(죽음)와 구분하기 위함
async function checkUrlAlive(officialUrl) {
  if (!officialUrl || !officialUrl.startsWith('http')) return null;
  const commonHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  try {
    const headRes = await fetch(officialUrl, { method: 'HEAD', headers: commonHeaders });
    if (headRes.status === 405 || headRes.status === 501) {
      // HEAD를 지원 안 하는 서버는 GET으로 재시도
      const getRes = await fetch(officialUrl, { method: 'GET', headers: commonHeaders });
      return getRes.ok;
    }
    return headRes.ok;
  } catch (e) {
    return false; // 요청 자체가 실패해도 죽은 링크로 간주
  }
}

// 후보 페이지를 실제로 가져와서, 캠핑장 이름이 그 안에 진짜 들어있는지 확인
// (검색결과 1위가 항상 정확한 페이지라는 보장이 없어서 하는 검증 단계)
async function pageContainsName(url, name) {
  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (!pageRes.ok) {
      // checked:false -> 봇 차단 등으로 애초에 내용을 확인 못한 상태 (검증 실패와는 구분)
      return { verified: false, checked: false, reason: `페이지 응답 실패 (status ${pageRes.status})` };
    }

    const html = await pageRes.text();
    const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();
    const found = normalize(html.slice(0, 30000)).includes(normalize(name));

    return {
      verified: found,
      checked: true,
      reason: found ? '이름 확인됨' : '페이지는 열렸지만 이름을 못 찾음 (JS 렌더링 페이지일 가능성)',
      htmlLength: html.length,
    };
  } catch (e) {
    return { verified: false, checked: false, reason: `페이지 요청 자체 실패: ${e.message}` };
  }
}

// 네이버지도 자동감지는 캡차 차단으로 서버에서 확인이 불가능해 제거함
// (map.naver.com의 비공식 검색 API가 자동화된 요청을 감지하면 결과 대신
//  ncaptcha 확인을 요구해서, 서버 코드로는 우회할 수 없음)
