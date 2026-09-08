/* ============================================================
   드론 기종 참조 DB  v1  (기존 시뮬레이터 10기종)
   제원은 공개 자료 기준 참고치. image 필드에 사진 URL을 넣으면
   HUD 기종 카드에 실루엣 대신 표시된다.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CUAS_DRONES = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  /* class: quad_small | quad_mid | flying_wing | delta_lm | tube_lm | male_fixed
     rcs: micro(<2kg) small(2~25) medium(25~150) large(>150)
     rf: ocusync | skylink | wifi | datalink | none    speeds m/s */
  const DRONES = [
    { id: "dji-m300", name: "DJI M300 RTK", maker: "DJI", origin: "중국", cls: "quad_mid", role: "산업용 촬영/측량", mtow_kg: 9.0, payload_kg: 2.7, max_speed: 23, cruise: 12, stall: 0, ceiling_m: 5000, endurance_min: 55, size_m: 0.81, rcs: "small", rf: "ocusync", nav: "GNSS+RTK, 조종 링크 필수", threat: "촬영·투하 개조 가능", image: "" },
    { id: "dji-m30", name: "DJI M30", maker: "DJI", origin: "중국", cls: "quad_mid", role: "산업용 촬영", mtow_kg: 4.0, payload_kg: 2.0, max_speed: 23, cruise: 12, stall: 0, ceiling_m: 5000, endurance_min: 41, size_m: 0.59, rcs: "small", rf: "ocusync", nav: "GNSS, 조종 링크 필수", threat: "촬영·소형 투하", image: "" },
    { id: "dji-mavic", name: "DJI Mavic 3", maker: "DJI", origin: "중국", cls: "quad_small", role: "소비자 촬영", mtow_kg: 0.9, payload_kg: 0.5, max_speed: 21, cruise: 10, stall: 0, ceiling_m: 6000, endurance_min: 46, size_m: 0.38, rcs: "micro", rf: "ocusync", nav: "GNSS, 조종 링크 필수", threat: "촬영·정찰, 불법비행 최다 기종군", image: "" },
    { id: "autel-evo", name: "Autel EVO II", maker: "Autel", origin: "중국/미국", cls: "quad_small", role: "소비자/전문 촬영", mtow_kg: 1.2, payload_kg: 1.0, max_speed: 20, cruise: 10, stall: 0, ceiling_m: 7000, endurance_min: 40, size_m: 0.42, rcs: "micro", rf: "skylink", nav: "GNSS, 조종 링크 필수", threat: "촬영·정찰", image: "" },
    { id: "anafi-usa", name: "Parrot ANAFI USA", maker: "Parrot", origin: "프랑스/미국", cls: "quad_small", role: "공공·군경 정찰", mtow_kg: 0.5, payload_kg: 0.6, max_speed: 14.7, cruise: 8, stall: 0, ceiling_m: 6000, endurance_min: 32, size_m: 0.28, rcs: "micro", rf: "wifi", nav: "GNSS, Wi-Fi 링크", threat: "정찰(우호 기관 사용 다수)", image: "" },
    { id: "tb2", name: "Bayraktar TB2", maker: "Baykar", origin: "튀르키예", cls: "male_fixed", role: "중고도 장기체공 무장 정찰", mtow_kg: 700, payload_kg: 150, max_speed: 61, cruise: 36, stall: 20, ceiling_m: 8200, endurance_min: 1620, size_m: 12.0, rcs: "large", rf: "datalink", nav: "GNSS+INS, 가시선 데이터링크", threat: "정밀유도탄 투발", image: "" },
    { id: "shahed-136", name: "Shahed-136", maker: "HESA", origin: "이란", cls: "delta_lm", role: "장거리 자폭 드론", mtow_kg: 200, payload_kg: 50, max_speed: 51, cruise: 41, stall: 25, ceiling_m: 4000, endurance_min: 720, size_m: 2.5, rcs: "large", rf: "none", nav: "GNSS+INS 자율, 링크 없음", threat: "탄두 50kg 자폭", image: "" },
    { id: "kyb", name: "ZALA KYB", maker: "ZALA Aero", origin: "러시아", cls: "flying_wing", role: "소형 배회 자폭", mtow_kg: 12, payload_kg: 3.0, max_speed: 36, cruise: 25, stall: 15, ceiling_m: 4000, endurance_min: 30, size_m: 1.2, rcs: "small", rf: "none", nav: "GNSS+INS 자율, 발사 후 링크 선택적", threat: "탄두 3kg 자폭", image: "" },
    { id: "switchblade-600", name: "Switchblade 600", maker: "AeroVironment", origin: "미국", cls: "tube_lm", role: "튜브발사 배회 자폭", mtow_kg: 54, payload_kg: 22.7, max_speed: 51, cruise: 31, stall: 18, ceiling_m: 4500, endurance_min: 40, size_m: 2.0, rcs: "medium", rf: "datalink", nav: "GNSS+INS, 데이터링크 종말유도", threat: "대전차 탄두", image: "" },
    { id: "hero-400", name: "UVision Hero-400EC", maker: "UVision", origin: "이스라엘", cls: "tube_lm", role: "튜브발사 배회 자폭", mtow_kg: 40, payload_kg: 10, max_speed: 42, cruise: 28, stall: 17, ceiling_m: 5400, endurance_min: 120, size_m: 2.3, rcs: "medium", rf: "datalink", nav: "GNSS+INS, 데이터링크", threat: "탄두 10kg", image: "" },
  ];
  const CLASS_KO = { quad_small: "소형 쿼드콥터", quad_mid: "중형 쿼드콥터", flying_wing: "소형 전익기", delta_lm: "델타익 자폭 드론", tube_lm: "튜브발사 배회형", male_fixed: "중고도 고정익" };
  const RCS_ORDER = ["micro", "small", "medium", "large"];
  const RCS_KO = { micro: "초소형(<2kg)", small: "소형(2~25kg)", medium: "중형(25~150kg)", large: "대형(>150kg)" };
  const RF_KO = { ocusync: "DJI OcuSync", skylink: "Autel SkyLink", wifi: "Wi-Fi", datalink: "군용 데이터링크", none: "RF 무방사" };
  const ROTOR = { quad_small: true, quad_mid: true };

  /* 클래스별 실루엣 (원본 도해, 100×60 viewBox) */
  const SILHOUETTE = {
    quad_small: '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M50 30 L30 16 M50 30 L70 16 M50 30 L30 44 M50 30 L70 44"/><circle cx="50" cy="30" r="5" fill="currentColor"/><ellipse cx="30" cy="16" rx="9" ry="3"/><ellipse cx="70" cy="16" rx="9" ry="3"/><ellipse cx="30" cy="44" rx="9" ry="3"/><ellipse cx="70" cy="44" rx="9" ry="3"/></g>',
    quad_mid: '<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M50 30 L24 12 M50 30 L76 12 M50 30 L24 48 M50 30 L76 48"/><rect x="42" y="24" width="16" height="12" rx="2" fill="currentColor"/><path d="M46 36 v8 M54 36 v8" stroke-width="2"/><ellipse cx="24" cy="12" rx="12" ry="3.5"/><ellipse cx="76" cy="12" rx="12" ry="3.5"/><ellipse cx="24" cy="48" rx="12" ry="3.5"/><ellipse cx="76" cy="48" rx="12" ry="3.5"/></g>',
    flying_wing: '<g fill="currentColor"><path d="M50 14 L92 42 L78 44 L50 34 L22 44 L8 42 Z"/><path d="M47 34 h6 l-3 12 z"/></g>',
    delta_lm: '<g fill="currentColor"><path d="M50 8 L90 46 L80 46 L50 36 L20 46 L10 46 Z"/><path d="M47 32 h6 v14 h-6 z"/><path d="M12 40 v10 M88 40 v10" stroke="currentColor" stroke-width="2.5"/></g>',
    tube_lm: '<g fill="currentColor"><rect x="20" y="26" width="60" height="9" rx="4.5"/><path d="M45 26 L10 12 L16 26 Z M55 26 L90 12 L84 26 Z"/><path d="M40 35 L28 46 L46 35 Z M60 35 L72 46 L54 35 Z"/><path d="M76 20 h5 v20 h-5 z"/></g>',
    male_fixed: '<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 26 H96" stroke-width="3.5"/><rect x="42" y="22" width="16" height="9" rx="3" fill="currentColor"/><path d="M36 30 L34 50 M64 30 L66 50 M34 50 H66 M40 50 L50 42 L60 50"/></g>',
  };

  const byId = Object.fromEntries(DRONES.map((d) => [d.id, d]));
  return { DRONES, byId, CLASS_KO, RCS_ORDER, RCS_KO, RF_KO, ROTOR, SILHOUETTE };
});
