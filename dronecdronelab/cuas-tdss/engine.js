/* ============================================================
   C-UAS Threat Assessment Engine  v3.0
   설계서 3장(산출 모델), 4장(등급 결정), 2.3(지수 결합) 구현
   순수 함수 + 히스테리시스 상태를 갖는 ThreatEngine 클래스
   브라우저(window.CUAS) / Node(module.exports) 겸용
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CUAS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- 기본 설정 (부록 B) ---------- */
  const DEFAULT_CONFIG = {
    profile: "urban_vip_outdoor",
    x_min: 0.05,
    ttti_weights: { I: 0.30, C: 0.20, U: 0.35, V: 0.15 },
    asti_weights: { P: 0.35, Ce: 0.40, Venv: 0.25 },
    urgency: { T_th_s: 90, k_pre: 0.7, k_post: 1.5 },
    mod_I: { multi_sensor: 1.0, single_sensor: 0.85 },
    grades: { notice: 30, caution: 50, warning: 70, critical: 85 },
    asti_shift: { normal: 0, notice: 0, caution: -5, warning: -10, critical: -15 },
    asti_I_boost: { normal: 1.0, notice: 1.0, caution: 1.05, warning: 1.10, critical: 1.15 },
    hysteresis_s: { default: 10, critical_to_warning: 15 },
    gates: {
      ttc_boundary_critical_s: 30,
      r1_warning_m: 1000,
      swarm_min_count: 3,
      dive_rate_mps: -5.0,
      boundary_radius_m: 300,
    },
    options: {
      jammer:      { label: "재머",   deploy_s: 4,    exec_s: 0,  requires: ["jam_permitted"] },
      spoof:       { label: "기만",   deploy_s: 8,    exec_s: 15, requires: ["spoof_permitted"] },
      netgun:      { label: "넷건",   deploy_s: null, exec_s: 5,  range_m: 100, approach_mps: 4 },
      interceptor: { label: "요격기", deploy_s: 12,   exec_s: 60, requires: ["launch_approved"] },
      shelter:     { label: "대피",   deploy_s: 0,    exec_s: 60 },
    },
    decision_time_s: 10,
    tentative_min_detections: 3,
    /* 보호대상·작전 설정 */
    asset: { value: 0.85, crowd_density: 0.7, shelter_available: true },
    permissions: { jam_permitted: true, spoof_permitted: false, launch_approved: true },
    /* 상황지수 징후 반감기(시간) */
    indicator_half_life_h: {
      missile: 72, artillery: 48, recon_drone: 24, gps_jam: 6,
      nk_media: 24, adf_activity: 12, illegal_flight: 48, osint: 12,
      /* 현장 사건(트랙 게이트에서 역전파) */
      inc_attack: 0.75, inc_intrusion: 0.75, inc_swarm: 0.5, inc_payload: 1.0, inc_illegal: 0.25,
    },
    /* 현장 사건 가중치: 게이트 사실에서만 생성(등급·ASTI 보정과 무관 → 순환 방지) */
    incident_weight: { inc_attack: 1.0, inc_intrusion: 0.9, inc_swarm: 0.7, inc_payload: 0.8, inc_illegal: 0.3 },
    payload_weight: { unknown: 0.4, camera: 0.2, cargo: 0.6, explosive: 1.0, cbrn: 1.0 },
  };

  const GRADES = ["normal", "notice", "caution", "warning", "critical"];
  const GRADE_KO = { normal: "정상", notice: "관심", caution: "주의", warning: "경계", critical: "심각" };
  const GRADE_COLOR = { normal: "#3b82f6", notice: "#22c55e", caution: "#eab308", warning: "#f97316", critical: "#ef4444" };

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const floor = (x, m) => Math.max(m, clamp01(x));
  const gi = (g) => GRADES.indexOf(g);

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k in over || {}) {
      if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && base && typeof base[k] === "object")
        out[k] = deepMerge(base[k], over[k]);
      else out[k] = over[k];
    }
    return out;
  }

  /* ---------- 3.3 가중 기하평균 ---------- */
  function geometricMean(values, weights, xmin) {
    let logsum = 0, wsum = 0;
    for (const k in weights) {
      const x = floor(values[k], xmin);
      logsum += weights[k] * Math.log(x);
      wsum += weights[k];
    }
    return 100 * Math.exp(logsum / wsum);
  }

  /* ---------- 3.4 긴급성 U(t) ---------- */
  function urgency(ttc_s, insideBoundary, cfg) {
    const u = cfg.urgency;
    if (ttc_s == null || !isFinite(ttc_s) || ttc_s <= 0 && !insideBoundary) {
      return insideBoundary ? 1 : 0.05;
    }
    const k = insideBoundary ? u.k_post : u.k_pre;
    const ttc = Math.max(ttc_s, 1);
    return clamp01(1 - Math.exp(-k * (u.T_th_s / ttc)));
  }

  /* ---------- 3.1 트랙 → I, C, V 정규화 (기여 요인 포함) ---------- */
  function intent(track, cfg, astiGrade) {
    const f = [];
    const b = track.behavior || {};
    const add = (name, w, cond) => { if (cond) f.push({ name, w }); };
    add("보호대상 지향 벡터", 0.30, track.geo && track.geo.heading_to_asset);
    add("급강하 기동", 0.25, b.dive);
    add("배회/선회", 0.15, b.loiter);
    add("RID 미응답", 0.15, !(track.rid && track.rid.present));
    add("RID 정보 불일치", 0.10, track.rid && track.rid.present && track.rid.matched === false);
    add("비행승인 없음", 0.10, !(track.approval && track.approval.found));
    add("승인 항로 이탈", 0.10, track.approval && track.approval.found && track.approval.deviation_m > 200);
    add("통신두절 후 자율비행", 0.10, b.autonomous_after_loss);
    add("회피 기동", 0.05, b.zigzag);
    let raw = f.reduce((s, x) => s + x.w, 0);
    /* 우호 드론 화이트리스트 → 의도성 대폭 감소 */
    if (track.whitelisted) { raw *= 0.15; f.push({ name: "화이트리스트(우호)", w: -0.5 }); }
    const multi = (track.sources || []).length >= 2 || (track.sources || []).includes("eoir");
    const mod = multi ? cfg.mod_I.multi_sensor : cfg.mod_I.single_sensor;
    const boost = cfg.asti_I_boost[astiGrade] || 1;
    return { value: clamp01(raw * mod * boost), factors: f, mod, multi };
  }

  function consequence(track, cfg, typeEst) {
    const f = [];
    const a = cfg.asset;
    const pl = (track.payload && track.payload.class) || "unknown";
    const plw = cfg.payload_weight[pl] != null ? cfg.payload_weight[pl] : 0.4;
    let mass = track.payload && track.payload.mass_kg_est;
    let massSrc = "";
    if (!mass && pl === "unknown" && typeEst && typeEst.confidence >= 0.3) { mass = typeEst.est_payload_kg; massSrc = " (추정 " + typeEst.candidates[0].name + ")"; }
    const massw = mass ? clamp01(mass / 5) : 0;
    const payloadScore = Math.max(plw, massw);
    if (massSrc) f.push({ name: "추정 기종 페이로드 " + mass + "kg" + massSrc, w: massw * 0.30 - plw * 0.30 > 0 ? massw * 0.30 - plw * 0.30 : 0 });
    f.push({ name: "보호자산 가치", w: a.value * 0.35 });
    f.push({ name: "군중 밀집도", w: a.crowd_density * 0.25 });
    f.push({ name: pl === "unknown" ? "페이로드 미확인" : "페이로드: " + pl, w: payloadScore * 0.30 });
    if (track.swarm_size >= 2) f.push({ name: "군집 " + track.swarm_size + "기", w: Math.min(0.1 + 0.05 * track.swarm_size, 0.25) });
    if (!a.shelter_available) f.push({ name: "대피시설 없음", w: 0.1 });
    return { value: clamp01(f.reduce((s, x) => s + x.w, 0)), factors: f, payloadConfirmed: pl !== "unknown" && (track.payload.confidence || 0) >= 0.6, harmfulPayload: ["cargo", "explosive", "cbrn"].includes(pl) };
  }

  function vulnerability(track, cfg, env) {
    const f = [];
    const g = track.geo || {};
    if (g.in_dead_zone) f.push({ name: "대응 음영구역 진입", w: 0.35 });
    if (g.in_no_jam_zone) f.push({ name: "전파차단 불가 구역", w: 0.25 });
    if (env && env.detection_degradation > 0) f.push({ name: "기상 탐지성능 저하", w: 0.25 * env.detection_degradation });
    if (env && env.team_coverage != null) f.push({ name: "대응팀 배치 공백", w: 0.20 * (1 - env.team_coverage) });
    const single = (track.sources || []).length < 2;
    if (single) f.push({ name: "단일 센서 추적", w: 0.15 });
    f.push({ name: "기본 취약성", w: 0.15 });
    return { value: clamp01(f.reduce((s, x) => s + x.w, 0)), factors: f };
  }

  /* ---------- 기종 추정 (센서 특성 기반, 규칙형) ---------- */
  /* track.sensor: { rcs_class, rf_signature, hover_observed, min_speed_observed, max_speed_observed } */
  function estimateType(track, db, prior) {
    if (!db || !db.DRONES) return null;
    const sn = track.sensor || {};
    const spd = (track.vel && track.vel.speed_mps) || 0;
    const vmax = sn.max_speed_observed != null ? Math.max(sn.max_speed_observed, spd) : spd;
    const vmin = sn.min_speed_observed != null ? Math.min(sn.min_speed_observed, spd) : spd;
    const alt = (track.pos && track.pos.alt_m) || 0;
    const hover = !!sn.hover_observed || !!(track.behavior && track.behavior.loiter && spd < 6);
    const rcsIdx = db.RCS_ORDER.indexOf(sn.rcs_class);
    const rfObs = sn.rf_signature || "unknown";
    const scored = db.DRONES.map((d) => {
      const why = [];
      let s = 1;
      // 속도 포락선
      if (vmax > d.max_speed * 1.1) { s *= 0.03; why.push("최고속 초과"); }
      else { const sig = Math.max(d.max_speed - d.cruise, 4); const z = (vmax - d.cruise) / sig; s *= Math.exp(-0.5 * z * z) * 0.8 + 0.2; }
      // 실속속도(고정익) / 정지비행
      const rotor = !!db.ROTOR[d.cls];
      if (!rotor && (hover || vmin < d.stall * 0.8)) { s *= 0.05; why.push("정지·저속비행 관측"); }
      if (rotor && hover) { s *= 1.15; why.push("정지비행 일치"); }
      // 레이더 크기 등급
      if (rcsIdx >= 0) { const diff = Math.abs(db.RCS_ORDER.indexOf(d.rcs) - rcsIdx); s *= diff === 0 ? 1 : diff === 1 ? 0.3 : 0.05; if (diff === 0) why.push("RCS 등급 일치"); }
      // RF 시그니처
      if (rfObs !== "unknown") {
        if (rfObs === d.rf) { s *= 1.3; why.push("RF 시그니처 일치"); }
        else if (rfObs === "none") s *= (d.rf === "none" ? 1 : 0.35);
        else s *= 0.08;
      }
      // 고도
      if (alt > d.ceiling_m) { s *= 0.1; why.push("실용상승한도 초과"); }
      // EO/IR 시각 식별 (기체 형상 계열)
      if (sn.eoir_class) { if (sn.eoir_class === d.cls) { s *= 3.0; why.push("EO/IR 형상 일치"); } else if (!!db.ROTOR[sn.eoir_class] === !!db.ROTOR[d.cls]) s *= 0.4; else s *= 0.05; }
      return { id: d.id, name: d.name, cls: d.cls, score: s, like: s, why, payload_kg: d.payload_kg, mtow_kg: d.mtow_kg, max_speed: d.max_speed };
    });
    /* 베이지안 누적: 사후 ∝ 사전^λ × 우도  (λ=0.75 망각계수: 누적 수렴하되 새 증거에 적응) */
    if (prior) for (const c of scored) c.score = Math.exp(0.75 * Math.log(Math.max(prior[c.id] || 0.1, 1e-4)) + Math.log(Math.max(c.like, 1e-6)));
    const total = scored.reduce((a, b) => a + b.score, 0) || 1;
    scored.forEach((c) => (c.p = 0.94 * c.score / total + 0.06 / scored.length)); // 상한 ≈ 95%: 센서 추정은 확정이 아님
    scored.sort((a, b) => b.p - a.p);
    const top = scored[0];
    // 클래스 확률 합
    const clsP = {};
    for (const c of scored) clsP[c.cls] = (clsP[c.cls] || 0) + c.p;
    const topCls = Object.entries(clsP).sort((a, b) => b[1] - a[1])[0];
    // 일치성 경고
    const notes = [];
    const quadMax = Math.max(...db.DRONES.filter((d) => db.ROTOR[d.cls]).map((d) => d.max_speed));
    if (vmax > quadMax) notes.push("관측 속도 " + vmax.toFixed(0) + "m/s: 상용 회전익 한계 초과 → 고정익/자폭형 가능성");
    if (hover && !db.ROTOR[top.cls]) notes.push("정지비행 관측과 고정익 추정 불일치 → 센서 확인 필요");
    if (top.p < 0.35) notes.push("후보 분산 — 추정 신뢰도 낮음, EO/IR 식별 요망");
    if (rfObs === "none" && db.ROTOR[top.cls]) notes.push("RF 무방사 회전익: 자율비행 개조 가능성");
    const evidence = {
      radar_hits: track.detect_count || 0,
      rcs: !!sn.rcs_class, rf: rfObs !== "unknown", rf_scanning: rfObs === "unknown" && !!sn.rf_scanning,
      speed_samples: sn.speed_samples || 0, hover: hover, eoir: !!sn.eoir_class,
    };
    const stage = evidence.eoir && top.p >= 0.6 ? "confirmed" : top.p >= 0.6 ? "narrowed" : evidence.rcs || evidence.rf ? "estimating" : "observing";
    return {
      candidates: scored.slice(0, 3), all: Object.fromEntries(scored.map((c) => [c.id, c.p])),
      cls: topCls[0], cls_p: topCls[1], cls_ko: db.CLASS_KO[topCls[0]],
      confidence: top.p, est_payload_kg: top.payload_kg, notes, evidence, stage,
      observed: { speed: spd, vmax, vmin, alt, hover, rcs: sn.rcs_class || null, rf: rfObs },
    };
  }

  /* ---------- 3.6 대응 옵션별 결심 한계시간 ---------- */
  function optionTimes(track, cfg) {
    const g = track.geo || {};
    const ttc = g.ttc_boundary_s;
    const out = [];
    for (const id in cfg.options) {
      const o = cfg.options[id];
      let permitted = true, why = null;
      for (const r of o.requires || []) if (!cfg.permissions[r]) { permitted = false; why = "권한 외"; }
      if (id === "jammer" && g.in_no_jam_zone) { permitted = false; why = "차단불가 구역"; }
      if (id === "jammer" && track.behavior && track.behavior.autonomous_after_loss) { permitted = false; why = "RF 침묵 기체"; }
      let deploy = o.deploy_s;
      if (id === "netgun") {
        const gap = Math.max(0, (g.dist_to_asset_m || 0) - (o.range_m || 100));
        deploy = gap / (o.approach_mps || 4);
      }
      const need = cfg.decision_time_s + (deploy || 0) + (o.exec_s || 0);
      const t = (ttc == null || !isFinite(ttc)) ? Infinity : ttc - need;
      let status = "available";
      if (!permitted) status = "blocked";
      else if (t <= 0) status = "expired";
      out.push({ id, label: o.label, t_decision_s: t, status, reason: why, need_s: need, kinetic: id !== "shelter" });
    }
    return out;
  }

  /* ---------- 4.2 규칙 게이트 ---------- */
  function gates(track, cfg, parts, opts) {
    const g = track.geo || {};
    const b = track.behavior || {};
    const G = cfg.gates;
    const hits = [];
    const kineticAll = opts.filter((o) => o.kinetic);
    const allExpired = kineticAll.length > 0 && kineticAll.every((o) => o.status !== "available");
    if (allExpired || (g.ttc_boundary_s != null && g.ttc_boundary_s <= G.ttc_boundary_critical_s))
      hits.push({ grade: "critical", name: "골든타임 소진" });
    if (g.dist_to_asset_m != null && g.dist_to_asset_m <= G.boundary_radius_m && g.heading_to_asset)
      hits.push({ grade: "critical", name: "경계선 내 직할 침투" });
    if (b.dive && g.heading_to_asset)
      hits.push({ grade: "critical", name: "공격 기동(급강하)" });
    const identified = (track.rid && track.rid.present && track.rid.matched !== false) && (track.approval && track.approval.found);
    if (parts.C.payloadConfirmed && parts.C.harmfulPayload)
      hits.push({ grade: "warning", name: "위해 페이로드 확인" });
    if (g.dist_to_asset_m != null && g.dist_to_asset_m <= G.r1_warning_m && !identified)
      hits.push({ grade: "warning", name: "R1 반경 진입(미식별)" });
    if (track.swarm_size >= G.swarm_min_count)
      hits.push({ grade: "warning", name: "군집 형성" });
    if (!(track.approval && track.approval.found) && !(track.rid && track.rid.present) && g.in_controlled_airspace)
      hits.push({ grade: "caution", name: "불법 비행" });
    if (track.whitelisted) return hits.filter((h) => h.grade === "critical"); // 우호 드론은 심각 게이트만 유효
    return hits;
  }

  function gradeFromScore(score, cfg, shift) {
    const g = cfg.grades; const s = score - (shift || 0); // shift가 음수(임계값 하향)이면 점수 상향과 동일
    if (s >= g.critical) return "critical";
    if (s >= g.warning) return "warning";
    if (s >= g.caution) return "caution";
    if (s >= g.notice) return "notice";
    return "normal";
  }

  /* ---------- 2.1 상황 위협지수 ASTI ---------- */
  const INCIDENT_KO = { inc_attack: "현장: 공격 기동", inc_intrusion: "현장: 경계선 침투", inc_swarm: "현장: 군집 출현", inc_payload: "현장: 위해 페이로드", inc_illegal: "현장: 불법비행" };
  function computeASTI(sit, cfg, now, incidents) {
    /* sit.indicators: [{type, ts, weight(0~1)}], sit.event: {importance, outdoor, motorcade, crowd},
       sit.weather: {wind_mps, rain_mmh, visibility_km}, sit.notam_active, sit.illegal_history(0~1)
       incidents: 트랙 게이트에서 역전파된 현장 사건 [{type, ts, weight, track_id}] */
    const hl = cfg.indicator_half_life_h;
    let P = 0; const pf = [];
    const byType = {};
    const all = (sit.indicators || []).concat(incidents || []);
    for (const ind of all) {
      const ageH = Math.max(0, (now - new Date(ind.ts).getTime()) / 3.6e6);
      const life = hl[ind.type] || 12;
      const decayed = (ind.weight || 0.5) * Math.pow(0.5, ageH / life);
      byType[ind.type] = Math.max(byType[ind.type] || 0, decayed);
    }
    const types = Object.keys(byType);
    for (const t of types) { P += byType[t] * 0.35; pf.push({ name: INCIDENT_KO[t] || ("징후: " + t), w: byType[t] * 0.35, incident: !!INCIDENT_KO[t] }); }
    /* 시간 결합: 2종 이상 동시 활성 시 승수 */
    if (types.length >= 2) { const m = 1 + 0.15 * (types.length - 1); P *= m; pf.push({ name: "다수 징후 시간 결합 ×" + m.toFixed(2), w: 0 }); }
    if (sit.illegal_history) { P += 0.2 * sit.illegal_history; pf.push({ name: "과거 불법비행", w: 0.2 * sit.illegal_history }); }
    P = clamp01(P);

    const e = sit.event || {};
    const Ce = clamp01(0.4 * (e.importance || 0.5) + 0.2 * (e.outdoor ? 1 : 0.3) + 0.2 * (e.motorcade ? 1 : 0.2) + 0.2 * (e.crowd || 0.5));

    const w = sit.weather || {};
    const flight = clamp01(1 - 0.5 * clamp01((w.wind_mps || 0) / 12) - 0.5 * clamp01((w.rain_mmh || 0) / 10));       // 비행 가능성
    const detect = clamp01(0.5 * clamp01((w.rain_mmh || 0) / 10) + 0.4 * clamp01(1 - (w.visibility_km == null ? 10 : w.visibility_km) / 10) + 0.2 * clamp01((w.wind_mps || 0) / 15)); // 탐지 성능 저하
    const Venv = clamp01(0.5 * detect + 0.3 * (sit.notam_active ? 0.2 : 0.6) + 0.2 * (1 - (sit.team_coverage == null ? 0.7 : sit.team_coverage)));

    const score = geometricMean({ P, Ce, Venv }, cfg.asti_weights, cfg.x_min);
    let grade = gradeFromScore(score, cfg, 0);
    /* 상황지수 규칙 게이트: 현장에서 공격이 확인되면 지역 태세는 점수와 무관하게 상향 */
    let gate = null;
    const strength = (t) => byType[t] || 0;
    if (strength("inc_attack") >= 0.5 || strength("inc_intrusion") >= 0.5) { if (gi(grade) < gi("warning")) { grade = "warning"; gate = "현장 공격·침투 확인"; } }
    else if (strength("inc_swarm") >= 0.5 || strength("inc_payload") >= 0.5) { if (gi(grade) < gi("caution")) { grade = "caution"; gate = "현장 군집·페이로드 확인"; } }
    const active = (incidents || []).map((i) => Object.assign({}, i, { label: INCIDENT_KO[i.type], age_min: Math.round((now - new Date(i.ts).getTime()) / 6e4) }));
    return { score: Math.round(score), grade, gate, P, Ce, Venv, flight_feasibility: flight, detection_degradation: detect, factors: pf, incidents: active };
  }

  /* ---------- 엔진 (히스테리시스 상태 보유) ---------- */
  class ThreatEngine {
    constructor(config, droneDb) {
      this.cfg = deepMerge(DEFAULT_CONFIG, config || {});
      this.db = droneDb || null;
      this.state = new Map(); // track_id → {grade, since, pendingGrade, pendingSince}
      this.typePost = new Map(); // track_id → {post:{id:p}, history:[{t, p, id}]}
      this.incidents = []; // 현장 사건 [{type, ts, weight, track_id}] — ASTI로 역전파
      this.log = [];
      this.overrides = new Map(); // track_id → {grade, reason, until}
    }
    setConfig(patch) { this.cfg = deepMerge(this.cfg, patch); }

    evaluateTrack(track, asti, now, env) {
      const cfg = this.cfg;
      const astiGrade = (asti && asti.grade) || "normal";
      const I = intent(track, cfg, astiGrade);
      const typeEst = this._updateType(track, now);
      const C = consequence(track, cfg, typeEst);
      const g = track.geo || {};
      const inside = g.dist_to_asset_m != null && g.dist_to_asset_m <= cfg.gates.boundary_radius_m;
      const Uv = urgency(g.ttc_boundary_s, inside, cfg);
      const V = vulnerability(track, cfg, env || { detection_degradation: asti ? asti.detection_degradation : 0 });
      const parts = { I, C, U: { value: Uv, factors: [{ name: "도달시간 " + (g.ttc_boundary_s != null ? Math.round(g.ttc_boundary_s) + "s" : "-"), w: Uv }] }, V };
      const values = { I: I.value, C: C.value, U: Uv, V: V.value };
      const score = geometricMean(values, cfg.ttti_weights, cfg.x_min);
      const opts = optionTimes(track, cfg);
      const gateHits = gates(track, cfg, parts, opts);
      const shift = cfg.asti_shift[astiGrade] || 0;
      const scoreGrade = gradeFromScore(score, cfg, shift);
      let gateGrade = "normal";
      for (const h of gateHits) if (gi(h.grade) > gi(gateGrade)) gateGrade = h.grade;
      /* 단일 센서 + 점수 ≥ notice → 정상으로 내리지 않음 */
      if (!I.multi && score >= cfg.grades.notice && gi(gateGrade) < gi("notice")) gateGrade = "notice";
      let target = gi(gateGrade) > gi(scoreGrade) ? gateGrade : scoreGrade;
      const tentative = (track.detect_count || 0) < cfg.tentative_min_detections || track.status === "tentative";
      if (tentative) target = "normal";

      /* 운용관 오버라이드 */
      const ov = this.overrides.get(track.track_id);
      let overridden = null;
      if (ov && ov.until > now) { target = ov.grade; overridden = ov; }
      else if (ov) this.overrides.delete(track.track_id);

      const grade = this._hysteresis(track.track_id, target, now, gateHits.length ? "gate" : "score");

      /* 기여 요인 상위 3 */
      const wts = cfg.ttti_weights;
      const contrib = [];
      for (const k of ["I", "C", "U", "V"]) for (const f of parts[k].factors) contrib.push({ axis: k, name: f.name, w: f.w * wts[k] });
      contrib.sort((a, b) => b.w - a.w);
      const kinetic = opts.filter((o) => o.kinetic && o.status === "available");
      const minT = kinetic.length ? Math.min(...kinetic.map((o) => o.t_decision_s)) : Infinity;

      return {
        track_id: track.track_id, ts: track.ts, score: Math.round(score), grade, grade_ko: GRADE_KO[grade], color: GRADE_COLOR[grade],
        score_grade: scoreGrade, gate_grade: gateGrade, gates: gateHits, asti_shift: shift, tentative,
        axes: values, parts, confidence: I.multi ? (track.track_quality > 0.8 ? 3 : 2) : 1,
        kinetic_gate_ok: I.multi, options: opts, min_t_decision_s: minT, top_factors: contrib.slice(0, 3), overridden, track, type_est: typeEst,
      };
    }

    _updateType(track, now) {
      const st = this.typePost.get(track.track_id);
      const te = estimateType(track, this.db, st ? st.post : null);
      if (!te) return null;
      const rec = st || { post: null, history: [], top: null };
      rec.post = te.all;
      if (!rec.history.length || now - rec.history[rec.history.length - 1].t >= 1000) { rec.history.push({ t: now, p: te.confidence, id: te.candidates[0].id }); if (rec.history.length > 60) rec.history.shift(); }
      if (rec.top && rec.top !== te.candidates[0].id && te.confidence >= 0.4 && track.status !== "tentative") this.log.push({ ts: now, type: "type", track_id: track.track_id, from: rec.top, to: te.candidates[0].id, p: te.confidence });
      rec.top = te.candidates[0].id;
      this.typePost.set(track.track_id, rec);
      te.history = rec.history; te.frames = rec.history.length;
      return te;
    }
    _hysteresis(id, target, now, reason) {
      const st = this.state.get(id) || { grade: "normal", since: now, pendingGrade: null, pendingSince: null };
      if (!this.state.has(id)) this.state.set(id, st);
      const h = this.cfg.hysteresis_s;
      if (gi(target) > gi(st.grade)) { // 상승 즉시
        this._logGrade(id, st.grade, target, reason, now); st.grade = target; st.since = now; st.pendingGrade = null; return st.grade;
      }
      if (target === st.grade) { st.pendingGrade = null; return st.grade; }
      // 하강: 유지시간 후 반영
      const hold = (st.grade === "critical" && target === "warning") ? h.critical_to_warning : h.default;
      if (st.pendingGrade !== target) { st.pendingGrade = target; st.pendingSince = now; return st.grade; }
      if ((now - st.pendingSince) / 1000 >= hold) { this._logGrade(id, st.grade, target, "release", now); st.grade = target; st.since = now; st.pendingGrade = null; }
      return st.grade;
    }
    _logGrade(id, from, to, reason, now) {
      this.log.push({ ts: now, type: "grade", track_id: id, from, to, reason });
      if (this.log.length > 2000) this.log.shift();
    }
    override(track_id, grade, reason, operator, now, ttl_s) {
      this.overrides.set(track_id, { grade, reason, until: now + (ttl_s || 300) * 1000, operator });
      this.log.push({ ts: now, type: "override", track_id, to: grade, reason, operator });
    }
    confirmAction(track_id, option, operator, now) {
      this.log.push({ ts: now, type: "action_confirm", track_id, option, operator });
    }
    dropTrack(id) { this.state.delete(id); this.typePost.delete(id); }

    /* 프레임 단위 평가: 군집 묶기 + 정렬 */
    /* 트랙 게이트 사실 → 현장 사건 등록 (같은 트랙·유형은 갱신, 반감기로 자연 소멸) */
    _recordIncidents(results, now) {
      const map = { "공격 기동(급강하)": "inc_attack", "경계선 내 직할 침투": "inc_intrusion", "군집 형성": "inc_swarm", "위해 페이로드 확인": "inc_payload", "불법 비행": "inc_illegal" };
      for (const r of results) {
        if (r.tentative) continue;
        for (const g of r.gates) {
          const type = map[g.name]; if (!type) continue;
          const ex = this.incidents.find((i) => i.type === type && i.track_id === r.track_id);
          if (ex) ex.ts = new Date(now).toISOString();
          else { this.incidents.push({ type, ts: new Date(now).toISOString(), weight: this.cfg.incident_weight[type], track_id: r.track_id }); this.log.push({ ts: now, type: "incident", track_id: r.track_id, to: type }); }
        }
      }
      /* 반감기 3배 경과 → 제거 */
      this.incidents = this.incidents.filter((i) => (now - new Date(i.ts).getTime()) / 3.6e6 < 3 * (this.cfg.indicator_half_life_h[i.type] || 1));
    }
    evaluateFrame(tracks, situation, now, env) {
      let asti = computeASTI(situation || {}, this.cfg, now, this.incidents);
      /* 군집 크기 부여 */
      const swarmCount = {};
      for (const t of tracks) if (t.swarm_id) swarmCount[t.swarm_id] = (swarmCount[t.swarm_id] || 0) + 1;
      const results = tracks.map((t) => this.evaluateTrack(Object.assign({}, t, { swarm_size: t.swarm_id ? swarmCount[t.swarm_id] : 1 }), asti, now, env));
      /* 군집 엔티티: 대표 = 최소 T결심/최고 등급 */
      const groups = {};
      const queue = [];
      for (const r of results) {
        const sid = r.track.swarm_id;
        if (!sid) { queue.push(r); continue; }
        if (!groups[sid]) { groups[sid] = Object.assign({}, r, { is_swarm: true, swarm_id: sid, members: [] }); }
        const gr = groups[sid]; gr.members.push(r);
        if (gi(r.grade) > gi(gr.grade) || (r.grade === gr.grade && r.min_t_decision_s < gr.min_t_decision_s)) {
          Object.assign(gr, r, { is_swarm: true, swarm_id: sid, members: gr.members });
        }
      }
      for (const sid in groups) queue.push(groups[sid]);
      queue.sort(sortQueue);
      /* 현장 사건 역전파: 이번 프레임의 게이트 사실로 ASTI 재산출 (트랙 등급에는 다음 프레임부터 반영) */
      this._recordIncidents(results, now);
      asti = computeASTI(situation || {}, this.cfg, now, this.incidents);
      const confirmed = queue.filter((q) => !q.tentative);
      const tentative = queue.filter((q) => q.tentative);
      return { asti, results, queue: confirmed, tentative, now };
    }
  }

  /* 6.2 정렬: 등급 ↓ → 최소 T결심 ↑ → 점수 ↓ */
  function sortQueue(a, b) {
    const d = gi(b.grade) - gi(a.grade);
    if (d) return d;
    const ta = isFinite(a.min_t_decision_s) ? a.min_t_decision_s : 1e9;
    const tb = isFinite(b.min_t_decision_s) ? b.min_t_decision_s : 1e9;
    if (ta !== tb) return ta - tb;
    return b.score - a.score;
  }

  return {
    DEFAULT_CONFIG, GRADES, GRADE_KO, GRADE_COLOR, ThreatEngine,
    geometricMean, urgency, intent, consequence, vulnerability, estimateType, INCIDENT_KO, optionTimes, gates, gradeFromScore, computeASTI, sortQueue, deepMerge,
  };
});
