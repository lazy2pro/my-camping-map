// api/kerosene.js
// 오피넷(한국석유공사) '반경 내 주유소' API로 실내등유(C004) 가격 정보를 가져온다.
// 오피넷 좌표계는 KATEC(비공식, Bessel 타원체 + TM)이라 네이버지도가 쓰는 WGS84와 다르다.
// 정확한 변환을 위해 손으로 짜지 않고 검증된 proj4 라이브러리를 사용한다.
// -> 배포 전 프로젝트에 `proj4` 패키지를 추가해야 한다: package.json dependencies에 "proj4" 추가 후 npm install.
import proj4 from 'proj4';

const KATEC_DEF =
  '+proj=tmerc +lat_0=38 +lon_0=128 +k=0.9999 +x_0=400000 +y_0=600000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43';
const WGS84_DEF = 'EPSG:4326';

function toKatec(lat, lng) {
  const [x, y] = proj4(WGS84_DEF, KATEC_DEF, [lng, lat]);
  return { x, y };
}

function toWgs84(x, y) {
  const [lng, lat] = proj4(KATEC_DEF, WGS84_DEF, [x, y]);
  return { lat, lng };
}

const BRAND_NAMES = {
  SKE: 'SK에너지',
  GSC: 'GS칼텍스',
  HDO: '현대오일뱅크',
  SOL: 'S-OIL',
  RTE: '자영알뜰',
  RTX: '고속도로알뜰',
  NHO: '농협알뜰',
  ETC: '자가상표',
  E1G: 'E1',
  SKG: 'SK가스',
};

// 응답 키 대소문자가 문서와 다를 가능성에 대비한 대소문자 무관 탐색 헬퍼.
function getCI(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[name] !== undefined) return obj[name];
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? obj[key] : undefined;
}

function extractItems(data) {
  const resultObj = getCI(data, 'RESULT') || data;
  const raw = getCI(resultObj, 'OIL');
  if (!raw) return { items: [], resultObj };
  return { items: Array.isArray(raw) ? raw : [raw], resultObj };
}

export default async function handler(req, res) {
  try {
    const { lat, lng, radius, debug } = req.query;
    const isDebug = debug === '1';
    if (!lat || !lng) {
      return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
    }

    const certkey = process.env.OPINET_API_KEY;
    if (!certkey) {
      return res.status(500).json({
        error: 'OPINET_API_KEY 환경변수가 설정되어 있지 않습니다.',
      });
    }

    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ error: 'lat, lng 값이 올바르지 않습니다.' });
    }

    const { x, y } = toKatec(latNum, lngNum);
    // 오피넷 반경내주유소 API는 반경 최대 5000m(5km)까지만 허용한다.
    const safeRadius = Math.min(parseInt(radius, 10) || 5000, 5000);

    const params = new URLSearchParams({
      out: 'json',
      x: x.toFixed(2),
      y: y.toFixed(2),
      radius: String(safeRadius),
      sort: '2', // 거리순
      prodcd: 'C004', // 실내등유
      certkey,
      // 일부 문서/예제는 'code' 파라미터명을 쓰기도 해 호환을 위해 함께 보낸다(있어도 무해).
      code: certkey,
    });
    const url = `https://www.opinet.co.kr/api/aroundAll.do?${params.toString()}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    let apiRes;
    let rawText;
    try {
      apiRes = await fetch(url, { signal: controller.signal });
      rawText = await apiRes.text();
    } finally {
      clearTimeout(timeoutId);
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({
        error: '오피넷 API 응답을 해석할 수 없습니다 (인증키 문제일 수 있습니다).',
        raw: rawText.slice(0, 500),
      });
    }

    const { items, resultObj } = extractItems(data);

    const stations = items
      .map((it) => {
        const gx = parseFloat(getCI(it, 'GIS_X_COOR'));
        const gy = parseFloat(getCI(it, 'GIS_Y_COOR'));
        if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
        const coord = toWgs84(gx, gy);
        return {
          id: getCI(it, 'UNI_ID'),
          name: getCI(it, 'OS_NM'),
          brand: BRAND_NAMES[getCI(it, 'POLL_DIV_CO')] || getCI(it, 'POLL_DIV_CO') || '',
          price: Number(getCI(it, 'PRICE')),
          distance: Number(getCI(it, 'DISTANCE')),
          lat: coord.lat,
          lng: coord.lng,
        };
      })
      .filter(Boolean);

    const payload = { stations };
    if (isDebug) {
      payload.debug = {
        requestUrl: url.replace(certkey, '***'),
        katecXY: { x, y },
        upstreamStatus: apiRes.status,
        rawItemCount: items.length,
        resultKeys: resultObj ? Object.keys(resultObj) : [],
        rawSample: rawText.slice(0, 800),
      };
    }

    // 유가는 하루 몇 차례 갱신되는 수준이라 30분 캐시로 오피넷 호출(일일 쿼터)을 아낀다.
    // 디버그 요청은 캐시하지 않는다.
    if (!isDebug) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

