/* ============================================================
   C-UAS Scenario Simulator  v3.0
   보호대상을 원점(0,0)으로 하는 평면 좌표(m)에서 표적을 기동시키고
   부록 A 형식의 트랙 메시지를 500ms 주기로 생성한다.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CUAS_SIM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DEG = Math.PI / 180;
  const DB = (typeof module === "object" && module.exports) ? require("./drones.js") : (typeof self !== "undefined" ? self.CUAS_DRONES : null);
  const ASSET_LATLON = { lat: 37.5665, lon: 126.978 };

  /* 작전 구역 정의 */
  const ZONES = {
    boundary_m: 300,
    r1_m: 1000,
    controlled_m: 5000,
    detect_range_m: 5000,
    radar: { x: -700, y: -900, range_m: 5000, sweep_dps: 45 },      // 회전 레이더
    eoir: { x: 850, y: 450, range_m: 2500, fov_deg: 12, slew_dps: 60 }, // EO/IR 추적 카메라
    dead_zones: [{ from_deg: 330, to_deg: 20, r_min: 400, r_max: 1600 }],   // 북측 고층건물 차폐
    no_jam_zones: [{ from_deg: 80, to_deg: 130, r_min: 0, r_max: 1800 }],   // 동측 병원·통신시설
    jammer: { x: -450, y: 300, range_m: 1500 },
    team: { x: 600, y: -520 },
    motorcade: [{ x: -1800, y: -900 }, { x: 0, y: 0 }],
  };

  function bearingOf(x, y) { return ((Math.atan2(x, y) / DEG) + 360) % 360; } // 북=0, 동=90
  function inSector(x, y, z) {
    const r = Math.hypot(x, y); if (r < z.r_min || r > z.r_max) return false;
    const b = bearingOf(x, y);
    return z.from_deg <= z.to_deg ? (b >= z.from_deg && b <= z.to_deg) : (b >= z.from_deg || b <= z.to_deg);
  }

  /* ---------- 표적 기동 모델 ---------- */
  function makeDrone(opt) {
    return Object.assign({
      id: "D-00", x: 0, y: 0, alt: 100, speed: 12, heading: 0, climb: 0,
      sources: ["radar"], quality: 0.8, rid: false, ridMatched: null, approval: false, deviation: null,
      model: "dji-mavic", payload: "unknown", payloadConf: 0, massEst: null, swarm: null, whitelisted: false, minSpd: Infinity, maxSpd: 0, hoverSeen: false,
      loiter: false, dive: false, zigzag: false, autonomous: false, detect: 0, t0: 0, script: null, alive: true, lostAt: null,
      history: [],
    }, opt);
  }

  const SCENARIOS = {
    approach_dive: {
      name: "직진 접근 → 급강하 (D-07)",
      desc: "남서 4.5km에서 보호대상 직진, 600m부터 급강하. RID·승인 없음, EO/IR 카메라 고정 시 형상 식별.",
      build: () => [makeDrone({ id: "D-07", x: -2700, y: -3600, alt: 120, speed: 18.4, heading: 37, model: "dji-m300", sources: ["radar", "rf"], script: "dive" })],
    },
    loiter_camera: {
      name: "촬영 드론 배회",
      desc: "북동 900m 상공 선회. RID 일치·승인 有, 카메라 페이로드. 등급이 과도하게 오르지 않아야 정상.",
      build: () => [makeDrone({ id: "D-12", x: 640, y: 640, alt: 80, speed: 8, heading: 180, rid: true, ridMatched: true, approval: true, deviation: 40, payload: "camera", payloadConf: 0.8, sources: ["radar", "rf", "rid"], model: "dji-mavic", script: "loiter" })],
    },
    rf_silent: {
      name: "RF 침묵 자율비행 (단일 센서)",
      desc: "북측 5km에서 레이더에만 포착(고속 고정익). 차폐 구역 통과 후 접근. 재머 무효, 점수는 감축되지 않아야 함.",
      build: () => [makeDrone({ id: "D-21", x: 400, y: 4900, alt: 60, speed: 30, heading: 186, autonomous: true, sources: ["radar"], quality: 0.62, model: "kyb", script: "straight" })],
    },
    swarm: {
      name: "군집 3기 동측 접근",
      desc: "동측 4.8km에서 3기 분산 접근. 군집 엔티티로 큐에 묶여야 하며 넷건은 조기 만료.",
      build: () => [0, 1, 2].map((i) => makeDrone({ id: "S-" + (i + 1), x: 4700 + i * 120, y: -300 + i * 300, alt: 90 + i * 15, speed: 12, heading: 270 + (i - 1) * 4, swarm: "SW1", sources: ["radar", "rf"], quality: 0.75, model: "autel-evo", script: "straight" })),
    },
    press_whitelist: {
      name: "언론 드론 (화이트리스트)",
      desc: "승인·RID 有, 운용관이 화이트리스트 지정. 심각 게이트 외에는 등급 상승 억제.",
      build: () => [makeDrone({ id: "P-03", x: -400, y: 500, alt: 60, speed: 3, heading: 90, rid: true, ridMatched: true, approval: true, deviation: 20, payload: "camera", payloadConf: 0.9, sources: ["radar", "rf", "rid", "eoir"], quality: 0.92, whitelisted: true, model: "anafi-usa", script: "hover" })],
    },
    composite: {
      name: "복합 상황 (전 시나리오 동시)",
      desc: "우선순위 큐 정렬·군집·후보 트랙·게이트 동작을 한 화면에서 검증.",
      build: () => [
        ...SCENARIOS.loiter_camera.build(),
        ...SCENARIOS.press_whitelist.build(),
        ...SCENARIOS.approach_dive.build().map((d) => Object.assign(d, { t0: 20 })),
        ...SCENARIOS.rf_silent.build().map((d) => Object.assign(d, { t0: 45 })),
        ...SCENARIOS.swarm.build().map((d) => Object.assign(d, { t0: 70 })),
        makeDrone({ id: "F-99", x: -2900, y: 1800, alt: 50, speed: 6, heading: 120, sources: ["rf"], quality: 0.3, model: "dji-mavic", script: "flicker", t0: 5 }),
      ],
    },
  };

  /* ---------- 시뮬레이터 ---------- */
  class Simulator {
    constructor(scenarioKey, opts) {
      this.dt = 0.5; this.t = 0; this.tick = 0;
      this.startEpoch = Date.now();
      this.eoirLock = null; this.eoirLockSince = {}; // UI가 카메라 고정 표적을 알려줌
      this.load(scenarioKey);
      this.frames = [];
    }
    load(key) {
      this.key = key; this.drones = SCENARIOS[key].build(); this.t = 0; this.tick = 0; this.frames = [];
      this.startEpoch = Date.now();
    }
    /* 한 스텝 진행 후 트랙 메시지 배열 반환 */
    step() {
      const dt = this.dt; this.t += dt; this.tick++;
      const msgs = [];
      for (const d of this.drones) {
        if (!d.alive || this.t < d.t0) continue;
        this._advance(d, dt);
        if (Math.hypot(d.x, d.y) > ZONES.detect_range_m) { d.detect = 0; d.history.length = 0; continue; } // 탐지 범위 밖
        // EO/IR 카메라 고정 → 일정 시간 후 시각 식별 증거 + 센서 출처 추가
        if (this.eoirLock === d.id) { d.lockTicks = (d.lockTicks || 0) + 1; } else d.lockTicks = 0;
        const m = this._message(d);
        if (m) msgs.push(m);
      }
      const frame = { t: this.t, ts: this.startEpoch + this.t * 1000, tracks: msgs };
      this.frames.push(frame);
      return frame;
    }
    _advance(d, dt) {
      const r = Math.hypot(d.x, d.y);
      const toAsset = bearingOf(-d.x, -d.y);
      switch (d.script) {
        case "dive":
          d.heading = toAsset;
          if (r < 600 && !d.dive) { d.dive = true; d.climb = -6.1; d.speed = 22; }
          if (d.dive) d.alt = Math.max(5, d.alt + d.climb * dt);

          if (r < 40) d.alive = false;
          break;
        case "straight":
          d.heading = toAsset + (d.swarm ? Math.sin(this.t / 7 + d.x) * 6 : 0);
          if (r < 60) d.alive = false;
          break;
        case "loiter":
          d.loiter = true; d.heading = (d.heading + 25 * dt) % 360; // 반경 ≈ 8/(25°/s) → 약 18m 반경 선회 + 드리프트
          d.heading += (Math.random() - 0.5) * 4;
          break;
        case "hover":
          d.heading = (d.heading + 40 * dt) % 360; d.speed = 2;
          break;
        case "flicker": // 불안정 RF 단일 탐지 → 후보 트랙만 유지
          d.heading += (Math.random() - 0.5) * 30;
          d.detect = Math.random() < 0.6 ? d.detect + 1 : 0;
          break;
      }
      const vx = Math.sin(d.heading * DEG) * d.speed, vy = Math.cos(d.heading * DEG) * d.speed;
      d.x += vx * dt; d.y += vy * dt;
      if (d.script !== "flicker") d.detect++;
      d.minSpd = Math.min(d.minSpd, d.speed); d.maxSpd = Math.max(d.maxSpd, d.speed); if (d.speed < 3) d.hoverSeen = true;
      d.history.push([d.x, d.y]); if (d.history.length > 60) d.history.shift();
    }
    _message(d) {
      const r = Math.hypot(d.x, d.y);
      const vx = Math.sin(d.heading * DEG) * d.speed, vy = Math.cos(d.heading * DEG) * d.speed;
      const closing = -(d.x * vx + d.y * vy) / Math.max(r, 1); // 보호대상 방향 접근 속도(m/s)
      const angToAsset = Math.abs(((bearingOf(-d.x, -d.y) - d.heading + 540) % 360) - 180);
      const headingToAsset = angToAsset < 20 && closing > 1;
      const distToBoundary = Math.max(0, r - ZONES.boundary_m);
      const ttc = closing > 0.5 ? distToBoundary / closing : null;
      // CPA: 현재 진행 방향 직선과 원점 거리
      const cpa = Math.abs(d.x * vy - d.y * vx) / Math.max(d.speed, 0.1);
      const tentative = d.detect < 3;
      const spec = DB ? DB.byId[d.model] : null;
      const hasRf = d.sources.includes("rf") || d.sources.includes("rid");
      const sources = d.sources.filter((x) => x !== "eoir");
      const eoirLocked = (d.lockTicks || 0) >= 4;                 // 2초 이상 고정
      if (eoirLocked || d.sources.includes("eoir") && d.whitelisted) sources.push("eoir");
      const sensor = {
        rcs_class: d.detect >= 6 && spec ? spec.rcs : null,        // 레이더 6회 이상 누적 후 RCS 등급 산출
        rf_signature: hasRf ? (d.detect >= 4 && spec ? spec.rf : "unknown") : (d.detect >= 16 ? "none" : "unknown"), // RF 무방사는 8초 스캔 후 판정
        rf_scanning: !hasRf && d.detect < 16,
        hover_observed: d.hoverSeen, min_speed_observed: +d.minSpd.toFixed(1), max_speed_observed: +d.maxSpd.toFixed(1),
        speed_samples: d.detect,
        eoir_class: (d.lockTicks || 0) >= 8 && spec ? spec.cls : null, // 4초 고정 후 형상 계열 식별
        eoir_locked: eoirLocked,
      };
      return {
        track_id: d.id, ts: new Date(this.startEpoch + this.t * 1000).toISOString(),
        status: tentative ? "tentative" : "confirmed",
        pos: { lat: ASSET_LATLON.lat + d.y / 111320, lon: ASSET_LATLON.lon + d.x / (111320 * Math.cos(ASSET_LATLON.lat * DEG)), alt_m: Math.round(d.alt), x: d.x, y: d.y },
        vel: { speed_mps: +d.speed.toFixed(1), heading_deg: Math.round((d.heading + 360) % 360), climb_mps: d.climb },
        sources, track_quality: Math.min(0.95, d.quality + (eoirLocked ? 0.1 : 0)), detect_count: d.detect,
        rid: { present: d.rid, matched: d.rid ? d.ridMatched : null, operator_id: d.rid ? "KR-OP-" + d.id : null },
        approval: { found: d.approval, deviation_m: d.approval ? d.deviation : null },
        est_type: null, truth_model: d.model,
        sensor,
        payload: { class: d.payload, mass_kg_est: d.massEst, confidence: d.payloadConf },
        swarm_id: d.swarm, whitelisted: d.whitelisted,
        geo: {
          dist_to_asset_m: Math.round(r), cpa_m: Math.round(Math.min(cpa, r)),
          ttc_boundary_s: ttc == null ? null : +ttc.toFixed(1), heading_to_asset: headingToAsset,
          in_dead_zone: ZONES.dead_zones.some((z) => inSector(d.x, d.y, z)),
          in_no_jam_zone: ZONES.no_jam_zones.some((z) => inSector(d.x, d.y, z)),
          in_controlled_airspace: r <= ZONES.controlled_m,
          closing_mps: +closing.toFixed(1), bearing_deg: Math.round(bearingOf(d.x, d.y)),
        },
        behavior: { loiter: d.loiter, dive: d.dive, zigzag: d.zigzag, autonomous_after_loss: d.autonomous },
        history: d.history.slice(),
      };
    }
  }

  /* ---------- 상황지수 입력 기본값 ---------- */
  function defaultSituation(now) {
    return {
      indicators: [
        { type: "gps_jam", ts: new Date(now - 2 * 3.6e6).toISOString(), weight: 0.7, label: "GPS 전파교란(2h 전)" },
        { type: "recon_drone", ts: new Date(now - 10 * 3.6e6).toISOString(), weight: 0.6, label: "정찰드론 전개(10h 전)" },
      ],
      event: { importance: 0.9, outdoor: true, motorcade: true, crowd: 0.7 },
      weather: { wind_mps: 5, rain_mmh: 0, visibility_km: 8 },
      notam_active: true, illegal_history: 0.5, team_coverage: 0.7,
      freshness: {
        "기상청 초단기실황": { age_min: 7, valid_min: 30 },
        "기상특보 / NOTAM": { age_min: 120, valid_min: 720 },
        "드론원스톱 승인": { age_min: 40, valid_min: 1440 },
        "OSINT / 대북 징후": { age_min: 12, valid_min: 60 },
        "대응자산 위치": { age_min: 0.5, valid_min: 2 },
        "행사 계획 / 동선": { age_min: 300, valid_min: 900 },
      },
    };
  }

  const INDICATOR_LABEL = { missile: "미사일 발사", artillery: "방사포 발사", recon_drone: "정찰드론 전개", gps_jam: "GPS 전파교란", nk_media: "北 매체 위협 논평", adf_activity: "방공부대 활동 증가", illegal_flight: "불법비행 발생", osint: "OSINT 징후" };

  return { Simulator, SCENARIOS, ZONES, defaultSituation, INDICATOR_LABEL, ASSET_LATLON };
});
