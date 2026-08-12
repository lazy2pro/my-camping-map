// api/nearby-restaurants.js
// 네이버 지역검색 API로 '맛집' 키워드 주변 음식점을 찾는다.
// nearby-camps.js와 같은 네이버 지역검색 API를 쓰되, 카테고리를 음식점으로 필터링한다.
export default async function handler(req, res) {
  try {
    const { keyword } = req.query;
    if (!keyword) {
      return res.status(400).json({ error: 'keyword 파라미터가 필요합니다.' });
    }

    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 설정되어 있지 않습니다.',
      });
    }

    const cleanKeyword = keyword.trim();
    const url = `https://naverapihub.apigw.ntruss.com/search/v1/local?query=${encodeURIComponent(cleanKeyword)}&display=15&sort=comment`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const searchRes = await fetch(url, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY': clientSecret,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await searchRes.json();

    if (!searchRes.ok) {
      return res.status(502).json({ error: '네이버 지역검색 API 오류', detail: data });
    }

    const strip = (s) => (s || '').replace(/<[^>]*>/g, '').trim();

    // 음식점/카페 계열 카테고리만 남기고, 캠핑장·마트 등 검색어에 우연히 걸린
    // 비음식점 결과는 제외한다.
    const FOOD_CATEGORY_PATTERN = /(음식점|한식|중식|일식|양식|분식|고기|카페|디저트|베이커리|치킨|주점|포장마차)/;

    const pickAddress = (it) => {
      const road = strip(it.roadAddress);
      const jibun = strip(it.address);
      if (road && /\d/.test(road)) return road;
      return jibun || road;
    };

    const items = (data.items || [])
      .filter((it) => FOOD_CATEGORY_PATTERN.test(strip(it.category)))
      .map((it) => ({
        name: strip(it.title),
        category: strip(it.category),
        address: pickAddress(it),
        tel: strip(it.telephone),
      }))
      .filter((it) => it.name && it.address);

    const seenNames = new Set();
    const dedupedItems = items.filter((it) => {
      if (seenNames.has(it.name)) return false;
      seenNames.add(it.name);
      return true;
    });

    // 맛집 목록도 자주 바뀌지 않으므로 60분 캐시로 API 호출 빈도를 낮춘다.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({ items: dedupedItems });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
