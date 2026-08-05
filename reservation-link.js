// api/reservation-link.js
// 캠핑장 이름으로 구글 Custom Search API를 통해 캠핏/땡큐캠핑의 실제 페이지를 찾고,
// 그 페이지에 캠핑장 이름이 실제로 들어있는지 확인(검증)한 뒤에만 링크를 돌려줍니다.
//
// 필요 환경변수:
//   GOOGLE_CSE_API_KEY - Google Cloud Console에서 발급한 Custom Search API 키
//   GOOGLE_CSE_CX       - Programmable Search Engine의 검색엔진 ID (전체 웹 검색으로 설정)
//
// 무료 쿼터가 하루 100회로 작아서, 같은 캠핑장은 7일간 캐시해서 재사용합니다.

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

    const apiKey = process.env.GOOGLE_CSE_API_KEY;
    const cx = process.env.GOOGLE_CSE_CX;
    if (!apiKey || !cx) {
      return res.status(500).json({
        error: 'GOOGLE_CSE_API_KEY / GOOGLE_CSE_CX 환경변수가 설정되어 있지 않습니다.',
      });
    }

    const q = encodeURIComponent(`${name} 예약`);
    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${q}&num=6`;

    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchRes.ok) {
      // 쿼터 초과(하루 100회)인 경우도 여기로 옴
      return res.status(502).json({ error: '구글 검색 API 오류', detail: searchData.error || searchData });
    }

    const items = searchData.items || [];
    const result = { camfit: null, thankyoucamping: null };

    for (const [key, pattern] of Object.entries(TARGET_SITES)) {
      const found = items.find((it) => pattern.test(it.link));
      if (!found) continue;

      const verified = await pageContainsName(found.link, name);
      if (verified) {
        result[key] = found.link;
      }
    }

    // 같은 캠핑장 이름은 7일간 캐시 (쿼터 절약 - 여러 사용자가 같은 캠핑장을 눌러도 API 재호출 안 함)
    res.setHeader('Cache-Control', 's-maxage=604800, stale-while-revalidate=86400');
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// 후보 페이지를 실제로 가져와서, 캠핑장 이름이 그 안에 진짜 들어있는지 확인
// (구글 검색결과 1위가 항상 정확한 페이지라는 보장이 없어서 하는 검증 단계)
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
