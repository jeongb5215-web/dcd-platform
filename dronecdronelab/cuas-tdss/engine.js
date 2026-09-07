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
    },
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

  function consequence(track, cfg) {
    const f = [];
    const a = cfg.asset;
    const pl = (track.payload && track.payload.class) || "unknown";
    const plw = cfg.payload_weight[pl] != null ? cfg.payload_weight[pl] : 0.4;
    const mass = track.payload && track.payload.mass_kg_est;
    const massw = mass ? clamp01(mass / 5) : 0;
    const payloadScore = Math.max(plw, massw);
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
  function computeASTI(sit, cfg, now) {
    /* sit.indicators: [{type, ts, weight(0~1)}], sit.event: {importance, outdoor, motorcade, crowd},
       sit.weather: {wind_mps, rain_mmh, visibility_km}, sit.notam_active, sit.illegal_history(0~1) */
    const hl = cfg.indicator_half_life_h;
    let P = 0; const pf = [];
    const byType = {};
    for (const ind of sit.indicators || []) {
      const ageH = Math.max(0, (now - new Date(ind.ts).getTime()) / 3.6e6);
      const life = hl[ind.type] || 12;
      const decayed = (ind.weight || 0.5) * Math.pow(0.5, ageH / life);
      byType[ind.type] = Math.max(byType[ind.type] || 0, decayed);
    }
    const types = Object.keys(byType);
    for (const t of types) { P += byType[t] * 0.35; pf.push({ name: "징후: " + t, w: byType[t] * 0.35 }); }
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
    const grade = gradeFromScore(score, cfg, 0);
    return { score: Math.round(score), grade, P, Ce, Venv, flight_feasibility: flight, detection_degradation: detect, factors: pf };
  }

  /* ---------- 엔진 (히스테리시스 상태 보유) ---------- */
  class ThreatEngine {
    constructor(config) {
      this.cfg = deepMerge(DEFAULT_CONFIG, config || {});
      this.state = new Map(); // track_id → {grade, since, pendingGrade, pendingSince}
      this.log = [];
      this.overrides = new Map(); // track_id → {grade, reason, until}
    }
    setConfig(patch) { this.cfg = deepMerge(this.cfg, patch); }

    evaluateTrack(track, asti, now, env) {
      const cfg = this.cfg;
      const astiGrade = (asti && asti.grade) || "normal";
      const I = intent(track, cfg, astiGrade);
      const C = consequence(track, cfg);
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
        kinetic_gate_ok: I.multi, options: opts, min_t_decision_s: minT, top_factors: contrib.slice(0, 3), overridden, track,
      };
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
    dropTrack(id) { this.state.delete(id); }

    /* 프레임 단위 평가: 군집 묶기 + 정렬 */
    evaluateFrame(tracks, situation, now, env) {
      const asti = computeASTI(situation || {}, this.cfg, now);
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
    geometricMean, urgency, intent, consequence, vulnerability, optionTimes, gates, gradeFromScore, computeASTI, sortQueue, deepMerge,
  };
});
