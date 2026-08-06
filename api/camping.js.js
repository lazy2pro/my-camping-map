// api/camping.js
export default async function handler(req, res) {
  try {
    const { type, mapX, mapY, radius, keyword, pageNo } = req.query;

    let serviceKey = process.env.GOCAMPING_SERVICE_KEY;
    if (!serviceKey) {
      return res.status(500).json({
        error: 'GOCAMPING_SERVICE_KEY 환경변수가 설정되어 있지 않습니다.',
      });
    }

    // 인코딩된 키가 입력되었을 경우를 대비한 안전 수식
    try {
      if (serviceKey.includes('%')) {
        serviceKey = decodeURIComponent(serviceKey);
      }
    } catch (e) {}

    const baseUrl = 'https://apis.data.go.kr/B551011/GoCamping';
    const params = new URLSearchParams({
      serviceKey,
      numOfRows: '500',
      pageNo: pageNo || '1',
      MobileOS: 'ETC',
      MobileApp: 'MyCampingMap',
      _type: 'json',
    });

    let endpoint;
    if (type === 'keyword') {
      if (!keyword) {
        return res.status(400).json({ error: 'keyword 파라미터가 필요합니다.' });
      }
      endpoint = 'searchList';
      params.set('keyword', keyword.trim());
    } else {
      if (!mapX || !mapY) {
        return res.status(400).json({ error: 'mapX, mapY 파라미터가 필요합니다.' });
      }
      endpoint = 'locationBasedList';
      params.set('mapX', mapX);
      params.set('mapY', mapY);
      params.set('radius', radius || '20000');
    }

    const url = `${baseUrl}/${endpoint}?${params.toString()}`;

    let apiRes;
    let rawText;
    let lastError;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        apiRes = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        rawText = await apiRes.text();
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (lastError) {
      return res.status(502).json({
        error: '고캠핑 API 서버 연결에 실패했습니다.',
        detail: lastError.message,
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({
        error: '고캠핑 API 응답을 해석할 수 없습니다 (XML 응답 또는 서비스키 문제).',
        raw: rawText.slice(0, 300),
      });
    }

    const body = data?.response?.body;
    if (!body) {
      return res.status(502).json({ error: '고캠핑 API 응답 구조가 올바르지 않습니다.' });
    }

    let items = body.items?.item || [];
    if (!Array.isArray(items)) items = [items];

    const CORP_PATTERN = /(주식회사|㈜|\(주\))/;
    const isLikelyNotACampsite = (camp) => {
      const isCorpName = CORP_PATTERN.test(camp.name || '');
      const hasNoContactInfo = !camp.tel && !camp.homepage && !camp.resveUrl && !camp.image;
      return isCorpName && hasNoContactInfo;
    };

    const camps = items
      .filter((it) => it.mapX && it.mapY)
      .map((it) => ({
        id: it.contentId,
        name: (it.facltNm || '').trim(),
        category: it.induty || '',
        address: [it.addr1, it.addr2].filter(Boolean).join(' '),
        lat: parseFloat(it.mapY),
        lng: parseFloat(it.mapX),
        tel: (it.tel || '').trim(),
        homepage: (it.homepage || '').replace(/<[^>]*>/g, '').trim(),
        resveUrl: (it.resveUrl || '').replace(/<[^>]*>/g, '').trim(),
        resveCl: it.resveCl || '',
        image: (it.firstImageUrl || '').trim(),
      }))
      .filter((camp) => !isLikelyNotACampsite(camp));

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({ count: camps.length, camps });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}