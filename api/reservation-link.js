// api/reservation-link.js
const TARGET_SITES = {
  camfit: { pattern: /camfit\.co\.kr/i, detailPath: /\/camp\/[a-z0-9]+/i },
  thankyoucamping: { pattern: /thankqcamping\.com/i, detailPath: /cseq=\d+/i },
};

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

    const queries = [];
    if (region) queries.push(`${region} ${fullName}`);
    if (!hasCampSuffix) queries.push(`${fullName} 예약`);
    queries.push(`${cleanName} 예약`, `${cleanName} 캠핑`);

    const searchResults = await Promise.all(
      queries.map(async (q) => {
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
    const items = allItems.map((it) => ({ ...it, link: (it.link || '').replace(/&amp;/g, '&') }));

    const debug = req.query.debug === '1';
    const result = { camfit: null, thankyoucamping: null };
    const candidateFound = { camfit: false, thankyoucamping: false };
    const debugInfo = { allLinks: [...new Set(items.map((it) => it.link))] };

    const regionTokens = (region || '').split(/\s+/).filter((t) => t.length >= 2);
    const normalizeText = (s) => (s || '').replace(/<[^>]*>/g, '').toLowerCase().replace(/\s+/g, '');
    
    const snippetMatchesRegion = (it) => {
      if (!regionTokens.length) return null;
      const snippet = normalizeText(it.title) + normalizeText(it.description);
      return regionTokens.some((t) => snippet.includes(normalizeText(t)));
    };

    const fullCampName = hasCampSuffix ? normalizeText(cleanName) : normalizeText(cleanName + '캠핑장');
    const fullCampNameAlt = hasCampSuffix ? null : normalizeText(cleanName + '야영장');
    
    const snippetMatchesFullName = (it) => {
      const snippet = normalizeText(it.title) + normalizeText(it.description);
      return snippet.includes(fullCampName) || (fullCampNameAlt && snippet.includes(fullCampNameAlt));
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
          const trustedFallback = !verifyResult.checked && isDetailPage && regionOk !== false;

          if (regionOk !== false && (verifyResult.verified || trustedFallback)) {
            result[key] = found.link;
          }

          if (debug) {
            debugInfo[key] = {
              candidateFound: true,
              candidateLink: found.link,
              isDetailPage,
              nameConfirmed,
              regionOk,
              trustedFallback,
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
    const found = normalize(html.slice(0, 25000)).includes(normalize(name));

    return {
      verified: found,
      checked: true,
      reason: found ? '이름 확인됨' : '페이지 내 미검출',
    };
  } catch (e) {
    return { verified: false, checked: false, reason: e.message };
  }
}