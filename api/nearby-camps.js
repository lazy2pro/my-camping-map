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
    // 'OO캠핑장 제2지구' 같은 이름은 접미어를 잘라 'OO캠핑장'으로 정리하되(여러 구역을 하나로 통합),
    // '관악산 제2야영장'처럼 잘라낸 결과에 '캠핑장/야영장' 정체성이 아예 안 남는 경우(산 이름만 남는 등)는
    // 오히려 무엇인지 알아볼 수 없게 되므로 자르지 않고 원래 이름 그대로 둔다.
    const normalizeName = (s) => {
      const original = strip(s);
      const stripped = original.replace(/제\s?\d+\s?(캠핑장|야영장|캠핑존|지구|존|사이트|캠핑구역|구역)$/, '').trim();
      if (stripped !== original && !/캠핑장|야영장|글램핑/.test(stripped)) {
        return original;
      }
      return stripped;
    };
    const skipCampFilter = req.query.raw === '1';

    // '캠핑'이라는 단어만 보고 거르면, 캠핑용품점·카라반 판매/렌탈업체·캠핑카 딜러,
    // 협회/단체 사무실, 캠핑장 안의 부속시설(예: 'OO캠핑장족구장')처럼 실제 야영지가
    // 아닌 곳까지 걸린다. 그래서 실제 야영지 카테고리 표현만 허용하고,
    // 판매/렌탈/용품/협회/부속시설 등은 명시적으로 제외한다.
    //
    // 단순 부분 문자열 매칭은 또 다른 문제가 있다: '캠핑장비'(camping gear) 안에
    // '캠핑장'이 그대로 들어있어서('캠핑장'+'비') 부분 문자열로만 검사하면 캠핑장비
    // 판매업체까지 통과해버린다(예: '스마트락'이 '캠핑장비' 카테고리로 분류된 경우).
    // 그래서 '캠핑장/야영장' 뒤에 한글이 곧바로 더 이어지면(=다른 단어의 일부라는 뜻)
    // 매칭하지 않도록 부정형 전방탐색을 추가해 단어 경계를 지킨다.
    const CAMPSITE_PATTERN = /(야영장|캠핑장|글램핑장|글램핑존|오토캠핑장|카라반\s*파크)(?![가-힣])/;
    const NON_CAMPSITE_PATTERN = /(용품|장비|판매|렌탈|대여|매매|수리|정비|딜러|대리점|전문점|제작|시공|설치|캠핑카|트레일러|협회|연합회|조합|사무국|본부|지회|단체|법인|공단|진흥원|재단|족구장|화장실|샤워장|취사장|정자|야외무대|물놀이장|주차장|관리사무소|안내소|매표소|체육시설|운동장|놀이터|정문|후문|입구|매점)/;

    const pickAddress = (it) => {
      const road = strip(it.roadAddress);
      const jibun = strip(it.address);
      if (road && /\d/.test(road)) return road;
      return jibun || road;
    };

    const items = (data.items || [])
      .filter((it) => {
        if (skipCampFilter) return true;
        const category = strip(it.category);
        const title = strip(it.title);
        if (NON_CAMPSITE_PATTERN.test(category) || NON_CAMPSITE_PATTERN.test(title)) return false;
        return CAMPSITE_PATTERN.test(category) || CAMPSITE_PATTERN.test(title);
      })
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

    // 30분 -> 60분: 네이버 지역검색 결과도 자주 바뀌지 않으므로 캐시를 늘려 호출 빈도를 낮춘다.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({ items: dedupedItems });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}