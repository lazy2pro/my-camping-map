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
  camfit: /camfit\.co\.kr/i,
  thankyoucamping: /thankyoucamping\.com/i,
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

    const query = encodeURIComponent(`${name} 예약`);
    const searchUrl = `https://naverapihub.apigw.ntruss.com/search/v1/webkr?query=${query}&display=20&format=json`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY': clientSecret,
      },
    });
    const searchData = await searchRes.json();

    if (!searchRes.ok) {
      return res.status(502).json({ error: '네이버 검색 API 오류', detail: searchData });
    }

    const items = (searchData.items || []).map((it) => ({
      ...it,
      link: (it.link || '').replace(/&amp;/g, '&'),
    }));

    const result = { camfit: null, thankyoucamping: null };

    for (const [key, pattern] of Object.entries(TARGET_SITES)) {
      const found = items.find((it) => pattern.test(it.link));
      if (!found) continue;

      const verified = await pageContainsName(found.link, name);
      if (verified) {
        result[key] = found.link;
      }
    }

    // 같은 캠핑장 이름은 7일간 캐시 (여러 사용자가 같은 캠핑장을 눌러도 API 재호출 안 함)
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// 후보 페이지를 실제로 가져와서, 캠핑장 이름이 그 안에 진짜 들어있는지 확인
// (검색결과 1위가 항상 정확한 페이지라는 보장이 없어서 하는 검증 단계)
async function pageContainsName(url, name) {
  try {
    const pageRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyCampingMapBot/1.0)' },
    });
    if (!pageRes.ok) return false;

    const html = await pageRes.text();
    const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();

    return normalize(html.slice(0, 30000)).includes(normalize(name));
  } catch (e) {
    return false; // 페이지를 못 가져오면 검증 실패로 처리 (안전하게 링크 제공 안 함)
  }
}
