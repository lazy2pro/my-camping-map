// api/nearby-camps.js
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
    const url = `https://naverapihub.apigw.ntruss.com/search/v1/local?query=${encodeURIComponent(cleanKeyword)}&display=15`;
    
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
    const normalizeName = (s) =>
      strip(s).replace(/제\s?\d+\s?(캠핑장|야영장|캠핑존|지구|존|사이트|캠핑구역|구역)$/, '').trim();
    const skipCampFilter = req.query.raw === '1';

    const pickAddress = (it) => {
      const road = strip(it.roadAddress);
      const jibun = strip(it.address);
      if (road && /\d/.test(road)) return road;
      return jibun || road;
    };

    const items = (data.items || [])
      .filter((it) => skipCampFilter || strip(it.category).includes('캠핑') || strip(it.title).includes('캠핑'))
      .map((it) => ({
        name: normalizeName(it.title) || strip(it.title),
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

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ items: dedupedItems });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}