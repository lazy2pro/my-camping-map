// api/camping.js
// Vercel 서버리스 함수: 브라우저 대신 고캠핑 API를 호출해서 넘겨줍니다.
// - CORS 문제 회피 (브라우저 -> 고캠핑 API 직접 호출은 대부분 막혀 있음)
// - serviceKey를 프론트엔드 코드에 노출하지 않기 위함

export default async function handler(req, res) {
  try {
    const { type, mapX, mapY, radius, keyword, pageNo } = req.query;

    const serviceKey = process.env.GOCAMPING_SERVICE_KEY;
    if (!serviceKey) {
      return res
        .status(500)
        .json({ error: 'GOCAMPING_SERVICE_KEY 환경변수가 설정되어 있지 않습니다. Vercel 프로젝트 설정 > Environment Variables 에서 등록하세요.' });
    }

    const baseUrl = 'https://apis.data.go.kr/B551011/GoCamping';

    const params = new URLSearchParams({
      serviceKey, // 공공데이터포털에서 발급받은 "디코딩" 키를 그대로 넣어야 함 (이미 인코딩된 키를 넣으면 이중 인코딩되어 인증 실패)
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
      params.set('keyword', keyword);
    } else {
      if (!mapX || !mapY) {
        return res.status(400).json({ error: 'mapX, mapY 파라미터가 필요합니다.' });
      }
      endpoint = 'locationBasedList';
      params.set('mapX', mapX); // 경도
      params.set('mapY', mapY); // 위도
      params.set('radius', radius || '20000'); // meter 단위, 최대 20000 (고캠핑 API 제한)
    }

    const url = `${baseUrl}/${endpoint}?${params.toString()}`;

    // 고캠핑 API 서버와의 연결이 가끔 일시적으로 실패하는 경우가 있어, 한 번 자동 재시도함
    let apiRes;
    let rawText;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        apiRes = await fetch(url);
        rawText = await apiRes.text();
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) {
      return res.status(502).json({
        error: '고캠핑 API 서버 연결에 실패했습니다 (일시적인 문제일 수 있습니다. 잠시 후 다시 시도해주세요).',
        detail: lastError.message,
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      // 서비스키 오류 등의 경우 고캠핑 API가 JSON이 아닌 XML 에러메시지를 줄 때가 있음
      return res.status(502).json({
        error: '고캠핑 API 응답을 해석할 수 없습니다. 서비스키가 올바른지, 트래픽 제한에 걸리지 않았는지 확인하세요.',
        raw: rawText.slice(0, 500),
      });
    }

    const body = data && data.response && data.response.body;
    if (!body) {
      return res.status(502).json({ error: '고캠핑 API 응답 형식이 예상과 다릅니다.', raw: data });
    }

    let items = (body.items && body.items.item) || [];
    if (!Array.isArray(items)) items = [items]; // 결과가 1건이면 배열이 아니라 객체로 옴

    // 고캠핑 원본에도 운영 사무실·식당·안내소처럼 숙박 사이트가 아닌 부속 장소가
    // 섞일 수 있다. 이름에 시설 용도가 명확히 드러나는 경우에는 지도에서 제외한다.
    const CORP_PATTERN = /(주식회사|㈜|\(주\))/;
    const NON_CAMPSITE_FACILITY_PATTERN = /(사무실|사무소|관리사무소|본사|지사|영업소|예약센터|고객센터|콜센터|여행사|관광안내소|안내센터|매표소|입구|주차장|정문|후문|식당|음식점|레스토랑|카페|베이커리|주점|포장마차|휴게소|매점)/;
    const isLikelyNotACampsite = (camp) => {
      if (NON_CAMPSITE_FACILITY_PATTERN.test(camp.name || '')) return true;
      const isCorpName = CORP_PATTERN.test(camp.name || '');
      // trim/정제까지 끝난 값 기준으로 판단 (원본 필드에 공백만 있는 경우 등의 오탐 방지)
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
        homepage: (it.homepage || '').replace(/<[^>]*>/g, '').trim(), // 종종 <a> 태그로 옴
        resveUrl: (it.resveUrl || '').replace(/<[^>]*>/g, '').trim(), // 예약 페이지 (캠핏/땡큐캠핑 등으로 연결되는 경우 많음)
        resveCl: it.resveCl || '', // 예약 구분 (예: 온라인실시간예약)
        image: (it.firstImageUrl || '').trim(),
      }))
      .filter((camp) => !isLikelyNotACampsite(camp));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ count: camps.length, camps });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
