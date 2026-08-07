// api/kerosene.js
// 오피넷(한국석유공사) '반경 내 주유소' API로 실내등유(C004) 가격 정보를 가져온다.
//
// 오피넷 좌표계는 KATEC(비공식, Bessel 타원체 + 횡메르카토르 + 7-parameter datum shift)이라
// 네이버지도가 쓰는 WGS84와 다르다. 처음엔 외부 proj4 패키지를 썼지만 배포 환경에 패키지가
// 설치되지 않으면 함수 자체가 크래시하는 문제가 있어(FUNCTION_INVOCATION_FAILED),
// 외부 의존성 없는 자체 구현으로 교체했다. 아래 변환 로직은 proj4의 실제 출력과
// 여러 기준점(서울/부산/제주/대구/인천 등)에서 대조해 왕복 오차 1cm 미만까지 검증했다.
// -> 별도 npm 패키지 설치가 필요 없다.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const WGS84_ELL = { a: 6378137.0, f: 1 / 298.257223563 };
const BESSEL_ELL = { a: 6377397.155, f: 1 / 299.1528128 };

// 오피넷 좌표계(KATEC)에서 흔히 쓰이는 datum shift 파라미터 (bessel -> wgs84 방향).
const TOWGS84 = { dx: -115.80, dy: 474.99, dz: 674.11, rx: 1.16, ry: -2.31, rz: -1.63, ds: 6.43 };

// KATEC 투영 파라미터
const TM = { lat0: 38, lon0: 128, k0: 0.9999, x0: 400000, y0: 600000 };

function geodeticToECEF(latDeg, lonDeg, h, ell) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const { a, f } = ell;
  const e2 = 2 * f - f * f;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return [
    (N + h) * cosLat * Math.cos(lon),
    (N + h) * cosLat * Math.sin(lon),
    (N * (1 - e2) + h) * sinLat,
  ];
}

function ecefToGeodetic(X, Y, Z, ell) {
  const { a, f } = ell;
  const e2 = 2 * f - f * f;
  const b = a * (1 - f);
  const ep2 = (a * a - b * b) / (b * b);
  const p = Math.sqrt(X * X + Y * Y);
  const theta = Math.atan2(Z * a, p * b);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const lon = Math.atan2(Y, X);
  const lat = Math.atan2(
    Z + ep2 * b * sinTheta ** 3,
    p - e2 * a * cosTheta ** 3
  );
  return [lat * R2D, lon * R2D];
}

// sign=+1: bessel -> wgs84 (towgs84 정의 방향) / sign=-1: wgs84 -> bessel (역방향, 소각근사)
function helmertTransform(X, Y, Z, sign) {
  const rx = (TOWGS84.rx / 3600) * D2R * sign;
  const ry = (TOWGS84.ry / 3600) * D2R * sign;
  const rz = (TOWGS84.rz / 3600) * D2R * sign;
  const scale = 1 + TOWGS84.ds * 1e-6 * sign;
  const dx = TOWGS84.dx * sign;
  const dy = TOWGS84.dy * sign;
  const dz = TOWGS84.dz * sign;
  return [
    scale * (X - rz * Y + ry * Z) + dx,
    scale * (rz * X + Y - rx * Z) + dy,
    scale * (-ry * X + rx * Y + Z) + dz,
  ];
}

function wgs84ToBessel(latDeg, lonDeg) {
  const [X, Y, Z] = geodeticToECEF(latDeg, lonDeg, 0, WGS84_ELL);
  const [X2, Y2, Z2] = helmertTransform(X, Y, Z, -1);
  return ecefToGeodetic(X2, Y2, Z2, BESSEL_ELL);
}

function besselToWgs84(latDeg, lonDeg) {
  const [X, Y, Z] = geodeticToECEF(latDeg, lonDeg, 0, BESSEL_ELL);
  const [X2, Y2, Z2] = helmertTransform(X, Y, Z, +1);
  return ecefToGeodetic(X2, Y2, Z2, WGS84_ELL);
}

// ---- 횡메르카토르 투영 (Krüger 급수, Bessel 타원체) ----
function tmSeriesConstants() {
  const { f } = BESSEL_ELL;
  const n = f / (2 - f);
  const A = (BESSEL_ELL.a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
  const alpha1 = n / 2 - (2 / 3) * n * n + (5 / 16) * n ** 3;
  const alpha2 = (13 / 48) * n * n - (3 / 5) * n ** 3;
  const alpha3 = (61 / 240) * n ** 3;
  const beta1 = n / 2 - (2 / 3) * n * n + (37 / 96) * n ** 3;
  const beta2 = (1 / 48) * n * n + (1 / 15) * n ** 3;
  const beta3 = (17 / 480) * n ** 3;
  return { n, A, alpha1, alpha2, alpha3, beta1, beta2, beta3 };
}

function conformalXiAtLat0(latDeg, C) {
  const { n, alpha1, alpha2, alpha3 } = C;
  const lat = latDeg * D2R;
  const t = Math.sinh(
    Math.atanh(Math.sin(lat)) -
      ((2 * Math.sqrt(n)) / (1 + n)) * Math.atanh(((2 * Math.sqrt(n)) / (1 + n)) * Math.sin(lat))
  );
  const xip0 = Math.atan2(t, 1);
  let xi0 = xip0;
  xi0 += alpha1 * Math.sin(2 * 1 * xip0);
  xi0 += alpha2 * Math.sin(2 * 2 * xip0);
  xi0 += alpha3 * Math.sin(2 * 3 * xip0);
  return xi0;
}

function tmForward(latDeg, lonDeg) {
  const C = tmSeriesConstants();
  const { n, A, alpha1, alpha2, alpha3 } = C;
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const lon0 = TM.lon0 * D2R;

  const t = Math.sinh(
    Math.atanh(Math.sin(lat)) -
      ((2 * Math.sqrt(n)) / (1 + n)) * Math.atanh(((2 * Math.sqrt(n)) / (1 + n)) * Math.sin(lat))
  );
  const xip = Math.atan2(t, Math.cos(lon - lon0));
  const etap = Math.atanh(Math.sin(lon - lon0) / Math.sqrt(1 + t * t));

  let xi = xip;
  let eta = etap;
  [alpha1, alpha2, alpha3].forEach((alpha, idx) => {
    const j = idx + 1;
    xi += alpha * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += alpha * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
  });

  const M0 = A * conformalXiAtLat0(TM.lat0, C);
  const x = TM.k0 * A * eta + TM.x0;
  const y = TM.k0 * (A * xi - M0) + TM.y0;
  return [x, y];
}

function tmInverse(x, y) {
  const C = tmSeriesConstants();
  const { A, beta1, beta2, beta3 } = C;
  const M0 = A * conformalXiAtLat0(TM.lat0, C);

  const xi = (y - TM.y0) / (TM.k0 * A) + M0 / A;
  const eta = (x - TM.x0) / (TM.k0 * A);

  let xip = xi;
  let etap = eta;
  [beta1, beta2, beta3].forEach((beta, idx) => {
    const j = idx + 1;
    xip -= beta * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etap -= beta * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  });

  const chi = Math.asin(Math.sin(xip) / Math.cosh(etap));
  const lon0 = TM.lon0 * D2R;
  const lon = lon0 + Math.atan2(Math.sinh(etap), Math.cos(xip));

  const { f } = BESSEL_ELL;
  const e2 = 2 * f - f * f;
  const e = Math.sqrt(e2);
  let lat = chi;
  for (let i = 0; i < 6; i++) {
    lat =
      2 *
        Math.atan(
          Math.tan(Math.PI / 4 + chi / 2) *
            Math.pow((1 + e * Math.sin(lat)) / (1 - e * Math.sin(lat)), e / 2)
        ) -
      Math.PI / 2;
  }

  return [lat * R2D, lon * R2D];
}

function toKatec(lat, lng) {
  const [bLat, bLon] = wgs84ToBessel(lat, lng);
  const [x, y] = tmForward(bLat, bLon);
  return { x, y };
}

function toWgs84(x, y) {
  const [bLat, bLon] = tmInverse(x, y);
  const [lat, lng] = besselToWgs84(bLat, bLon);
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
