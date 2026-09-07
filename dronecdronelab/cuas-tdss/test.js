const E = require("./engine.js");
const eng = new E.ThreatEngine();
const now = Date.now();
let fail = 0;
const ok = (name, cond, info) => { console.log((cond ? "PASS " : "FAIL ") + name + (info ? "  (" + info + ")" : "")); if (!cond) fail++; };

// 부록 C: 지표값 직접 대입 → 68
const s = E.geometricMean({ I: 0.82, C: 0.60, U: 0.79, V: 0.45 }, E.DEFAULT_CONFIG.ttti_weights, 0.05);
ok("기하평균 부록C 예시 ≈ 68", Math.abs(s - 68) < 1.5, s.toFixed(1));

// 절벽 효과: V=0이어도 0점이 되지 않음
const s2 = E.geometricMean({ I: 0.9, C: 0.8, U: 0.95, V: 0 }, E.DEFAULT_CONFIG.ttti_weights, 0.05);
ok("하한 0.05로 절벽 효과 제거", s2 > 50, s2.toFixed(1));

// U(t)
ok("U(TTC=52, 경계 밖) ≈ 0.70", Math.abs(E.urgency(52, false, E.DEFAULT_CONFIG) - 0.70) < 0.05, E.urgency(52, false, E.DEFAULT_CONFIG).toFixed(2));
ok("U(TTC=600) 낮음", E.urgency(600, false, E.DEFAULT_CONFIG) < 0.15);
ok("U 경계 통과 후 급상승", E.urgency(20, true, E.DEFAULT_CONFIG) > 0.99);

// Track D-07 (부록 A)
const D07 = {
  track_id: "D-07", ts: new Date(now).toISOString(), status: "confirmed",
  pos: { lat: 37.5665, lon: 126.978, alt_m: 120 }, vel: { speed_mps: 18.4, heading_deg: 212, climb_mps: -6.1 },
  sources: ["radar", "eoir"], track_quality: 0.87, detect_count: 41,
  rid: { present: false }, approval: { found: false }, est_type: "quad_small",
  payload: { class: "unknown", confidence: 0 }, swarm_id: null,
  geo: { dist_to_asset_m: 1180, cpa_m: 95, ttc_boundary_s: 52, heading_to_asset: true, in_dead_zone: false, in_no_jam_zone: false, in_controlled_airspace: true },
  behavior: { loiter: false, dive: true, zigzag: false, autonomous_after_loss: false },
};
const sit = { indicators: [{ type: "gps_jam", ts: new Date(now - 2 * 3.6e6).toISOString(), weight: 0.7 }, { type: "recon_drone", ts: new Date(now - 10 * 3.6e6).toISOString(), weight: 0.6 }],
  event: { importance: 0.9, outdoor: true, motorcade: true, crowd: 0.7 }, weather: { wind_mps: 5, rain_mmh: 0, visibility_km: 8 }, notam_active: true, illegal_history: 0.5 };
const fr = eng.evaluateFrame([D07], sit, now);
const r = fr.results[0];
console.log("  D-07 axes", JSON.stringify(Object.fromEntries(Object.entries(r.axes).map(([k, v]) => [k, +v.toFixed(2)]))), "score", r.score, "grade", r.grade, "gates", r.gates.map((g) => g.name).join("/"));
ok("D-07 게이트로 심각 강제", r.grade === "critical");
ok("D-07 점수 구간은 심각 미만(점수와 등급 분리)", r.score < 85, r.score);
const opt = Object.fromEntries(r.options.map((o) => [o.id, o]));
ok("재머 T결심 = 38s", Math.abs(opt.jammer.t_decision_s - 38) < 0.01, opt.jammer.t_decision_s);
ok("요격기 만료(−30s)", opt.interceptor.status === "expired" && Math.abs(opt.interceptor.t_decision_s + 30) < 0.01, opt.interceptor.t_decision_s);
ok("넷건 만료(근접 이동 필요)", opt.netgun.status === "expired", opt.netgun.t_decision_s.toFixed(1));
ok("기만: 권한 외", opt.spoof.status === "blocked");
ok("신뢰도 배지 3 (Radar+EO/IR, 품질 0.87)", r.confidence === 3);
ok("Top factors 3개", r.top_factors.length === 3, r.top_factors.map((f) => f.name).join(", "));
console.log("  ASTI", fr.asti.score, fr.asti.grade, "shift", r.asti_shift);

// 단일 센서 RF-침묵 드론: 점수 유지 + 무력화 게이트 차단 + 등급 미감축
const RFS = JSON.parse(JSON.stringify(D07)); RFS.track_id = "D-08"; RFS.sources = ["radar"]; RFS.behavior.autonomous_after_loss = true;
const r2 = eng.evaluateFrame([RFS], sit, now).results[0];
ok("단일센서 점수 감축 ≤ 15%", r2.score >= r.score * 0.85, r2.score + " vs " + r.score);
ok("단일센서 여전히 심각(게이트)", r2.grade === "critical");
ok("단일센서 무력화 집행 게이트 차단", r2.kinetic_gate_ok === false);
ok("RF 침묵 → 재머 blocked", Object.fromEntries(r2.options.map((o) => [o.id, o])).jammer.status === "blocked");

// 히스테리시스: 심각 → 경계 하강은 15초 유지 후
const eng2 = new E.ThreatEngine();
eng2.evaluateFrame([D07], sit, now);
const calm = JSON.parse(JSON.stringify(D07)); calm.behavior.dive = false; calm.geo.ttc_boundary_s = 200; calm.geo.dist_to_asset_m = 3500; calm.geo.heading_to_asset = false;
const g1 = eng2.evaluateFrame([calm], sit, now + 1000).results[0].grade;
const g2 = eng2.evaluateFrame([calm], sit, now + 16000).results[0].grade;
ok("하강 즉시 반영 안 됨", g1 === "critical", g1);
ok("15초 후 하강 반영", g2 !== "critical", g2);

// 정렬: 70점·15초 vs 88점·180초 (같은 등급)
const a = { grade: "warning", min_t_decision_s: 15, score: 70 }, b = { grade: "warning", min_t_decision_s: 180, score: 88 };
ok("큐 정렬: 결심시간 짧은 표적 우선", [b, a].sort(E.sortQueue)[0] === a);

// 후보 트랙은 큐 제외
const tent = JSON.parse(JSON.stringify(D07)); tent.track_id = "T-1"; tent.detect_count = 2;
const fr3 = new E.ThreatEngine().evaluateFrame([tent, D07], sit, now);
ok("후보 트랙 큐 제외", fr3.queue.length === 1 && fr3.tentative.length === 1);

// 군집
const sw = [1, 2, 3].map((i) => { const t = JSON.parse(JSON.stringify(D07)); t.track_id = "S-" + i; t.swarm_id = "SW1"; t.behavior.dive = false; t.geo.ttc_boundary_s = 150; t.geo.dist_to_asset_m = 2500; return t; });
const fr4 = new E.ThreatEngine().evaluateFrame(sw, sit, now);
ok("군집 1개 엔티티로 큐 진입", fr4.queue.length === 1 && fr4.queue[0].is_swarm && fr4.queue[0].members.length === 3);
ok("군집 게이트 → 경계 이상", fr4.queue[0].gates.some((g) => g.name === "군집 형성"));

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
