// api/nearby-camps.js
// "고캠핑 미등록 캠핑장" 보완 검색용 엔드포인트.
// 네이버 지역검색(local) API로 이름/주소/전화번호만 가져오고,
// 좌표(mapx/mapy)는 신뢰하지 않습니다 (구버전 API가 KATEC 좌표계를 쓰는 경우가 있어서
// 위경도로 오인하면 마커 위치가 틀어질 수 있음). 실제 좌표는 프론트엔드에서
// 네이버 지오코더로 주소를 다시 변환해서 구합니다.
//
// 필요 환경변수 (검색 앱과 동일한 키 재사용):
//   NAVER_CLIENT_ID
//   NAVER_CLIENT_SECRET

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

    const url = `https://naverapihub.apigw.ntruss.com/search/v1/local?query=${encodeURIComponent(keyword)}&display=15`;
    const searchRes = await fetch(url, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY': clientSecret,
      },
    });
    const data = await searchRes.json();

    if (!searchRes.ok) {
      return res.status(502).json({ error: '네이버 지역검색 API 오류', detail: data });
    }

    const strip = (s) => (s || '').replace(/<[^>]*>/g, '').trim();
    // 네이버 지역검색은 "OO캠핑장" 안의 구역을 "OO캠핑장제1캠핑장"처럼 별도 상호로
    // 쪼개 놓은 경우가 있음. 이 구역명 접미사를 잘라내야 지도 검색/캠핏 매칭이 잘 됨.
    const normalizeName = (s) =>
      strip(s).replace(/제\s?\d+\s?(캠핑장|야영장|캠핑존|지구|존|사이트|캠핑구역|구역)$/, '').trim();
    const skipCampFilter = req.query.raw === '1';

    // 도로명 주소는 있어도 번지/건물번호 없이 "OO면"까지만 끊겨있는 경우가 있어서
    // (예: "강원 강릉시 연곡면"), 그대로 지오코딩하면 그 행정구역 중심점으로 튐.
    // 도로명에 숫자가 없으면 "끊긴" 주소로 보고 지번 주소를 우선함.
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
      .filter((it) => it.name && it.address); // 지오코딩할 주소가 있는 것만

    // 이름 정규화로 인해 같은 캠핑장의 여러 구역("제1캠핑장", "제2캠핑장" 등)이
    // 같은 이름이 되는 경우 중복 제거 (첫 번째 것만 남김)
    const seenNames = new Set();
    const dedupedItems = items.filter((it) => {
      if (seenNames.has(it.name)) return false;
      seenNames.add(it.name);
      return true;
    });

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ items: dedupedItems });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
