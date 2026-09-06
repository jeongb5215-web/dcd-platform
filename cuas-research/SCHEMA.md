# cuas-research/data.json 스키마 & 작성 규칙

이 파일은 `cuas-research/index.html`이 그대로 읽어서 렌더링하는 데이터 소스다.
자동화 에이전트(일일/주간 스캔)는 이 문서의 규칙을 따라 `data.json`만 수정하고 커밋·푸시한다.

## 핵심 원칙 (반드시 지킬 것)

1. **"뉴스가 나왔다"가 아니라 "변화"만 기록한다.** 신규 자료가 기존 베이스라인과 동일한 내용을 반복할 뿐이면 아무것도 추가하지 않는다.
2. 다음 경우에만 `log`/`daily`/entries에 항목을 추가한다:
   - 기존 베이스라인 수치·사실과 **다른 값**이 신뢰도 있는 출처에서 제시됨 (제원 변경, 신규 변종 등)
   - **완전히 새로운 항목**의 최초 등장 (신형 드론, 신규 요격체계, 신규 논문 등)
   - 기존에 없던 **전술/기술적 전환점** (예: 새로운 요격 방식 실전 적용, 방어체계 통합 변경)
3. 매일 실행하되, 그날 해당 카테고리에 의미 있는 변화가 없으면 **그 카테고리는 건드리지 않는다** (빈 날은 정상).
4. 모든 항목에는 **출처 URL과 날짜**를 반드시 포함한다. 출처가 불명확하거나 1차 출처를 찾을 수 없으면 `confidence: "낮음"`으로 표시하고 `status: "검증 필요"`로 남긴다. 베이스라인은 신뢰도 "낮음" 출처만으로는 갱신하지 않는다 (log에는 기록하되 baseline.value는 유지).
5. 상충되는 수치가 나오면 어느 쪽이 맞는지 단정하지 말고 두 출처를 모두 언급하며 `status: "검증 필요"`로 표시한다.

## 파일 구조

```json
{
  "meta": {
    "last_daily_run": "2026-09-07T22:00:00Z",   // 실행할 때마다 UTC ISO 타임스탬프로 갱신
    "last_weekly_run": "2026-09-08T22:00:00Z",
    "schema_version": 1
  },

  "geran_drones": {
    // 기종별 현재까지 확인된 최신 제원 (신뢰도 높은 출처만 반영)
    "baseline": {
      "Geran-2": {
        "warhead_kg":  { "value": 50, "source": "https://...", "source_name": "The War Zone", "date": "2026-08-01", "confidence": "높음" },
        "range_km":    { "value": 1800, "source": "...", "source_name": "...", "date": "...", "confidence": "높음" },
        "engine":      { "value": "MD-550 피스톤 계열", "source": "...", "source_name": "...", "date": "...", "confidence": "중간" }
      },
      "Geran-3": { ... }
    },
    // 변경 감지 로그 (시간순, 배열 뒤에 추가 = 최신)
    "log": [
      {
        "date": "2026-09-06",
        "variant": "Geran-2",
        "field": "warhead_kg",
        "old_value": 50,
        "new_value": 40,
        "new_source": "https://...",
        "new_source_name": "Defense Express",
        "confidence": "중간",
        "status": "검증 필요",   // "검증 필요" | "확인됨" | "반영완료"
        "note": "기존 연구자료(50kg)와 상이한 수치 제시 — 교차검증 필요"
      }
    ]
  },

  "attack_stats": {
    "daily": [
      {
        "date": "2026-09-05",
        "attacks_total": 120,
        "by_type": { "Geran-2": 80, "Lancet": 30 },
        "launch_areas": ["Kursk", "Bryansk"],
        "target_areas": ["Kyiv", "Odesa"],
        "intercepted": 95,
        "intercept_rate": 0.79,
        "sources": ["https://..."]
      }
    ],
    // 월별 집계는 daily가 쌓이면 에이전트가 매월 초 자동 계산해 추가
    "monthly": [
      { "month": "2026-08", "attacks_total": 3400, "intercepted_total": 2700, "intercept_rate": 0.79 }
    ]
  },

  "cuas_tech": {
    "log": [
      {
        "date": "2026-09-06",
        "system": "STING",              // STING/BAGNET/YOLKA/음향센서/RF-Radar/EO-IR/AI Vision/C4I/델타체계 등
        "event_type": "신규 시험",       // 신규 시험 | 실전 배치 | 기술 개선 | 체계 구축
        "detail": "구체적 내용 1~2문장",
        "source": "https://...",
        "source_name": "...",
        "significance": "왜 연구적으로 의미 있는지 1문장"
      }
    ]
  },

  "research_papers": {
    "log": [
      {
        "date": "2026-09-06",
        "title": "논문/보고서 제목",
        "authors": "저자",
        "venue": "arXiv / IEEE / 기관보고서 등",
        "topic": "AI Vision",           // C-UAS 일반 | AI Vision | 음향탐지 | 자율요격 | RF/Radar 등
        "summary": "핵심 내용 2~3문장",
        "link": "https://...",
        "significance": "기존 연구 대비 무엇이 새로운지 1문장"
      }
    ]
  }
}
```

## 에이전트 작업 순서 (매 실행)

1. `cuas-research/data.json`을 읽어 기존 베이스라인/로그를 파악한다.
2. 담당 카테고리(일일 실행: ①②③ / 주간 실행: ③ 심층 + ④)에 대해 웹 검색으로 최신 정보를 수집한다.
3. 기존 데이터와 비교해 "의미 있는 변화"만 선별한다 (핵심 원칙 참조).
4. 변화가 있으면 해당 카테고리에만 항목을 추가하고, `meta.last_daily_run` 또는 `meta.last_weekly_run`을 현재 UTC 시각으로 갱신한다.
5. 변화가 없는 카테고리는 그대로 둔다 (억지로 항목을 만들지 않는다).
6. `attack_stats.daily`가 갱신되어 새 달이 시작되었으면 지난달 `monthly` 집계를 자동 계산해 추가한다.
7. `data.json`만 수정한다 (스키마를 벗어나지 않는 범위에서). `index.html`은 수정하지 않는다.
8. 변경 사항을 커밋(`feat: C-UAS 연구 자동화 - YYYY-MM-DD 일일/주간 스캔`)하고 `main`에 푸시한다.
9. 변화가 하나도 없었으면 커밋하지 않고 종료한다 (빈 커밋 금지).
