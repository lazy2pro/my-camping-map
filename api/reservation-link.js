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
  camfit: { pattern: /camfit\.co\.kr/i, detailPath: /\/camp\/[a-z0-9]+/i },
  thankyoucamping: { pattern: /thankyoucamping\.com/i, detailPath: /\/(place|camp|site)\/[a-z0-9]+/i },
};

export default async function handler(req, res) {
  try {
    const { name } = req.query;
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

    // 검색어를 두 번(예약/캠핑) 돌려서 후보군을 넓힘 - 플랫폼마다 어떤 단어와 잘 걸리는지 달라서
    const headers = {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
    };
    const queries = [`${name} 예약`, `${name} 캠핑`];
    const allItems = [];
    for (const q of queries) {
      const searchUrl = `https://naverapihub.apigw.ntruss.com/search/v1/webkr?query=${encodeURIComponent(q)}&display=30&format=json`;
      const searchRes = await fetch(searchUrl, { headers });
      const searchData = await searchRes.json();
      if (!searchRes.ok) {
        return res.status(502).json({ error: '네이버 검색 API 오류', detail: searchData });
      }
      allItems.push(...(searchData.items || []));
    }

    const items = allItems.map((it) => ({ ...it, link: (it.link || '').replace(/&amp;/g, '&') }));

    const debug = req.query.debug === '1';
    const result = { _codeVersion: 'naver-allsearch-v1', camfit: null, thankyoucamping: null };
    const debugInfo = { allLinks: [...new Set(items.map((it) => it.link))] };

    for (const [key, cfg] of Object.entries(TARGET_SITES)) {
      const found = items.find((it) => cfg.pattern.test(it.link));
      if (!found) {
        if (debug) debugInfo[key] = { candidateFound: false };
        continue;
      }

      const verifyResult = await pageContainsName(found.link, name);
      const isDetailPage = cfg.detailPath.test(found.link);
      // 내용 검증 성공 -> 확실히 신뢰
      // 봇 차단(403 등)으로 검증 자체가 불가능했는데, URL이 "개별 캠핑장 상세페이지" 패턴이면
      // 신뢰도가 충분히 높다고 보고 통과시킴 (완전 미확인 상태로 링크 주는 것보단 안전한 절충)
      const trustedFallback = !verifyResult.checked && isDetailPage;

      if (verifyResult.verified || trustedFallback) {
        result[key] = found.link;
      }
      if (debug) {
        debugInfo[key] = { candidateFound: true, candidateLink: found.link, isDetailPage, trustedFallback, ...verifyResult };
      }
    }

    // 네이버지도 자체에 "네이버예약"이 연동된 캠핑장인지 확인
    // (지도 엔진과 무관하게, 네이버지도의 비공식 검색 API로 예약 연동 여부만 감지)
    const naverMapUrl = `https://map.naver.com/p/search/${encodeURIComponent(name)}`;
    const naverReserveResult = await pageHasNaverReservation(name, debug);
    result.naverReservation = naverReserveResult.hasReservation ? naverMapUrl : null;
    if (debug) debugInfo.naverReservation = naverReserveResult;

    // 같은 캠핑장 이름은 7일간 캐시 (여러 사용자가 같은 캠핑장을 눌러도 API 재호출 안 함)
    // 디버그 요청은 캐시하지 않음
    if (!debug) {
      res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');
    }
    return res.status(200).json(debug ? { ...result, debug: debugInfo } : result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
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

// 네이버지도가 자체적으로 쓰는 (비공식) 검색 API를 통해 이 캠핑장이 네이버예약과
// 연동되어 있는지 확인. 공식 문서화된 API가 아니라서 언제든 바뀌거나 막힐 수 있음.
async function pageHasNaverReservation(name, debug) {
  try {
    const query = encodeURIComponent(name);
    const url = `https://map.naver.com/p/api/search/allSearch?query=${query}&type=all&searchCoord=127.9784;36.5&boundary=`;

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: `https://map.naver.com/p/search/${query}`,
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!res.ok) {
      return { hasReservation: false, checked: false, reason: `allSearch API 응답 실패 (status ${res.status})` };
    }

    const data = await res.json();
    const raw = JSON.stringify(data);

    // 장소 결과 목록을 최대한 유연하게 찾음 (응답 구조가 바뀔 수 있어서 여러 경로 시도)
    const places =
      data?.result?.place?.list ||
      data?.result?.place?.items ||
      data?.place?.list ||
      [];

    // 이름이 일치하는 장소를 찾고, 그 장소 데이터 안에 예약 관련 필드가 있는지 확인
    const normalize = (s) => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').toLowerCase();
    const target = normalize(name);
    const matched = places.find((p) => normalize(p.name || p.title).includes(target)) || places[0];

    const matchedRaw = matched ? JSON.stringify(matched) : '';
    const hasReservation =
      /bookingBusinessId/i.test(matchedRaw) ||
      /"booking"\s*:\s*(true|\{)/i.test(matchedRaw) ||
      (matched && matched.visitorReservationUrl) ||
      (matched && matched.reservation);

    return {
      hasReservation: !!hasReservation,
      checked: true,
      placesFound: places.length,
      matchedName: matched ? matched.name || matched.title : null,
      reason: hasReservation ? '예약 관련 필드 확인됨' : '예약 관련 필드 못 찾음',
      ...(debug ? { rawSample: raw.slice(0, 4000), matchedRaw: matchedRaw.slice(0, 2000) } : {}),
    };
  } catch (e) {
    return { hasReservation: false, checked: false, reason: `요청 자체 실패: ${e.message}` };
  }
}
