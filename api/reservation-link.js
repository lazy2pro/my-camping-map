// api/reservation-link.js
const TARGET_SITES = {
  camfit: { pattern: /camfit\.co\.kr/i, detailPath: /\/camp\/[a-z0-9]+/i },
  thankyoucamping: { pattern: /thankqcamping\.com/i, detailPath: /cseq=\d+/i },
};

// 캠핑장 이름 끝에 흔히 붙는 접미어. 검색엔진 상 실제 업체명 표기가
// ('갈기산캠핑장' 검색 -> 실제 '갈기산펜션캠핑장') 이 접미어들만 다른 경우가 많아,
// 후보 선택과 최종 검증 양쪽에서 이 접미어를 뗀 핵심 키워드로도 완화 매칭한다.
const CAMP_SUFFIX_PATTERN = /(캠핑장|야영장|펜션|글램핑|캠핑존|리조트)+$/;
function stripCampSuffix(normalizedName) {
  return normalizedName.replace(CAMP_SUFFIX_PATTERN, '');
}

// 백엔드 외부 요청 타임아웃 Helper (Vercel Serverless 무한 대기 방지)
async function fetchWithTimeout(resource, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

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

    const headers = {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
    };
    
    const cleanName = name.trim();
    const hasCampSuffix = /(캠핑장|야영장)$/.test(cleanName);
    const fullName = hasCampSuffix ? cleanName : `${cleanName}캠핑장`;

    // 검색 전략을 2단계로 나눈다: 대부분의 캠핑장은 1차 질의(가장 구체적인 것)만으로
    // camfit/땡큐캠핑 도메인이 모두 검색되므로, 그 경우 2차(폴백) 질의는 생략해
    // 네이버 검색 API 호출 횟수(쿼터)를 절반 가까이 줄인다.
    const primaryQueries = [];
    if (region) primaryQueries.push(`${region} ${fullName}`);
    if (!hasCampSuffix) {
      primaryQueries.push(`${fullName} 예약`);
      // 실제 업체명에 '캠핑장' 접미어가 없는 곳(예: '휘게포레스트')도 있어,
      // 접미어를 붙이지 않은 원래 이름으로도 함께 검색해 검색 결과 누락을 줄인다.
      if (region) primaryQueries.push(`${region} ${cleanName}`);
    }
    if (primaryQueries.length === 0) primaryQueries.push(`${fullName} 예약`);

    const fallbackQueries = [`${cleanName} 예약`, `${cleanName} 캠핑`].filter(
      (q) => !primaryQueries.includes(q)
    );

    async function runQueries(queryList) {
      const searchResults = await Promise.all(
        queryList.map(async (q) => {
          try {
            const searchUrl = `https://naverapihub.apigw.ntruss.com/search/v1/webkr?query=${encodeURIComponent(q)}&display=20&format=json`;
            const searchRes = await fetchWithTimeout(searchUrl, { headers }, 3000);
            const searchData = await searchRes.json();
            return { ok: searchRes.ok, data: searchData };
          } catch (e) {
            return { ok: false, data: { error: e.message } };
          }
        })
      );
      const validResults = searchResults.filter((r) => r.ok && r.data && r.data.items);
      const allItems = validResults.flatMap((r) => r.data.items || []);
      return allItems.map((it) => ({ ...it, link: (it.link || '').replace(/&amp;/g, '&') }));
    }

    let items = await runQueries(primaryQueries);

    const hasDomainMatch = (siteKey) => items.some((it) => TARGET_SITES[siteKey].pattern.test(it.link));
    const needsFallback =
      fallbackQueries.length > 0 && (!hasDomainMatch('camfit') || !hasDomainMatch('thankyoucamping'));

    if (needsFallback) {
      const fallbackItems = await runQueries(fallbackQueries);
      items = items.concat(fallbackItems);
    }

    const debug = req.query.debug === '1';
    const result = { camfit: null, thankyoucamping: null };
    const candidateFound = { camfit: false, thankyoucamping: false };
    const debugInfo = { allLinks: [...new Set(items.map((it) => it.link))] };

    // 행정구역 접미어(도/시/군/구/읍/면 등) 표기가 사이트마다 다를 수 있어
    // ('경기도' vs '경기', '양평군' vs '양평') 원본과 축약형을 모두 후보로 둔다.
    const ADMIN_SUFFIX = /(특별자치도|특별자치시|광역시|특별시|도|시|군|구|읍|면|동|리)$/;
    const regionTokens = (region || '')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .flatMap((t) => {
        const stripped = t.replace(ADMIN_SUFFIX, '');
        return stripped.length >= 2 && stripped !== t ? [t, stripped] : [t];
      });
    const normalizeText = (s) => (s || '').replace(/<[^>]*>/g, '').toLowerCase().replace(/\s+/g, '');
    
    const snippetMatchesRegion = (it) => {
      if (!regionTokens.length) return null;
      const snippet = normalizeText(it.title) + normalizeText(it.description);
      return regionTokens.some((t) => snippet.includes(normalizeText(t)));
    };

    const fullCampName = hasCampSuffix ? normalizeText(cleanName) : normalizeText(cleanName + '캠핑장');
    const fullCampNameAlt = hasCampSuffix ? null : normalizeText(cleanName + '야영장');
    const coreCampName = stripCampSuffix(fullCampName);

    const snippetMatchesFullName = (it) => {
      const snippet = normalizeText(it.title) + normalizeText(it.description);
      if (snippet.includes(fullCampName) || (fullCampNameAlt && snippet.includes(fullCampNameAlt))) return true;
      // 완전일치 실패 시, 접미어를 뗀 핵심 키워드만이라도 있으면 후보로 인정한다
      // (예: '갈기산캠핑장' 검색 -> 스니펫엔 '갈기산펜션캠핑장'만 있는 경우).
      return coreCampName.length >= 2 && snippet.includes(coreCampName);
    };

    const [, officialValid] = await Promise.all([
      Promise.all(
        Object.entries(TARGET_SITES).map(async ([key, cfg]) => {
          const domainMatches = items.filter((it) => cfg.pattern.test(it.link));
          if (!domainMatches.length) {
            if (debug) debugInfo[key] = { candidateFound: false };
            return;
          }

          const nameAndRegionMatched = domainMatches.find(
            (it) => snippetMatchesFullName(it) && snippetMatchesRegion(it) === true
          );
          const fullNameMatched = domainMatches.find((it) => snippetMatchesFullName(it));
          const regionMatched = domainMatches.find((it) => snippetMatchesRegion(it) === true);
          const found = nameAndRegionMatched || fullNameMatched || regionMatched || domainMatches[0];
          const nameConfirmed = snippetMatchesFullName(found);
          const regionOk = snippetMatchesRegion(found);

          candidateFound[key] = true;
          const verifyResult = await pageContainsName(found.link, cleanName);
          const isDetailPage = cfg.detailPath.test(found.link);
          // camfit/땡큐캠핑 상세페이지가 클라이언트 렌더링(SPA)이라 실제 이름 텍스트가
          // 정적 HTML엔 없을 수 있다(verifyResult.checked=true인데 verified=false인 경우).
          //
          // 예전엔 "지역명이 검색 스니펫에 없으면(regionOk===false) 무조건 후보 탈락"으로
          // 처리했는데, 실제로는 스니펫이 지역명을 아예 언급하지 않는 경우가 흔해서
          // 정확히 이름이 일치하는 캠핑장까지 구글 검색으로 잘못 넘어가는 문제가 있었다.
          // 이름 일치는 그 자체로 지역 일치보다 강한 신호이므로, 상세페이지 URL이면서
          // 이름이 스니펫과 일치하면 지역 언급 여부와 무관하게 신뢰한다.
          const trustedByName = isDetailPage && nameConfirmed;
          const trustedByRegion = isDetailPage && regionOk === true && (!verifyResult.checked || verifyResult.verified);

          if (verifyResult.verified || trustedByName || trustedByRegion) {
            result[key] = found.link;
          }

          if (debug) {
            debugInfo[key] = {
              candidateFound: true,
              candidateLink: found.link,
              isDetailPage,
              nameConfirmed,
              regionOk,
              trustedByName,
              trustedByRegion,
              ...verifyResult,
            };
          }
        })
      ),
      checkUrlAlive(officialUrl),
    ]);

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

async function checkUrlAlive(officialUrl) {
  if (!officialUrl || !officialUrl.startsWith('http')) return null;
  const commonHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  try {
    const headRes = await fetchWithTimeout(officialUrl, { method: 'HEAD', headers: commonHeaders }, 2500);
    if (headRes.status === 405 || headRes.status === 501) {
      const getRes = await fetchWithTimeout(officialUrl, { method: 'GET', headers: commonHeaders }, 2500);
      return getRes.ok;
    }
    return headRes.ok;
  } catch (e) {
    return false;
  }
}

async function pageContainsName(url, name) {
  try {
    const pageRes = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
      },
      3000
    );

    if (!pageRes.ok) {
      return { verified: false, checked: false, reason: `status ${pageRes.status}` };
    }

    const html = await pageRes.text();
    const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();
    const normalizedHtml = normalize(html.slice(0, 25000));
    const normalizedName = normalize(name);

    let found = normalizedHtml.includes(normalizedName);
    let reason = found ? '이름 완전일치' : '';

    if (!found) {
      // 검색에 쓰인 이름과 실제 업체 표기가 접미어만 다른 경우
      // (예: '갈기산캠핑장' 검색 -> 실제 페이지는 '갈기산펜션캠핑장')
      // 완전일치가 실패해도 핵심 키워드가 페이지에 있으면 같은 곳으로 간주한다.
      const core = stripCampSuffix(normalizedName);
      if (core.length >= 2 && normalizedHtml.includes(core)) {
        found = true;
        reason = '핵심 키워드 일치 (접미어 차이 허용)';
      }
    }

    return {
      verified: found,
      checked: true,
      reason: reason || '페이지 내 미검출',
    };
  } catch (e) {
    return { verified: false, checked: false, reason: e.message };
  }
}