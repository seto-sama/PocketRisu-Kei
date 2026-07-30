<p align="center">
  <img src="../assets/pocketrisu-banner-1024.png" alt="PocketRisu Kei" width="900" />
</p>

<h1 align="center">PocketRisu Kei</h1>

<p align="center">
  PocketRisu를 기반으로 기능과 사용성을 확장한 셀프 호스팅 AI 롤플레잉 채팅 프론트엔드
</p>

<p align="center">
  <a href="../README.md">English</a> | <strong>한국어</strong> | <a href="README.de.md">Deutsch</a> | <a href="README.cn.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-Hant.md">繁體中文</a>
</p>

> [!CAUTION]
> **이 프로젝트는 nightly 빌드입니다.** 기능과 데이터 구조가 예고 없이 바뀌거나 일부 기능이 정상적으로 작동하지 않을 수 있습니다. 업데이트 전에는 반드시 백업을 만들어 주세요.

PocketRisu Kei는 [PocketRisu](https://github.com/PocketRisu/PocketRisu)의 `v1.8.1` / `63832a13`을 기준으로 개인 사용을 위해 시작한 개조판입니다. 안정판이나 공식 지원을 전제로 하지 않습니다.

프로젝트 링크: [저장소](https://github.com/seto-sama/PocketRisu-Kei) · [릴리스](https://github.com/seto-sama/PocketRisu-Kei/releases) · [이슈](https://github.com/seto-sama/PocketRisu-Kei/issues)

## 원본 PocketRisu에서의 변경사항

- 패키지·워크스페이스·TypeScript·Vite·Vitest 도구 구성 리팩토링.
- 공용 UI 컨트롤과 설정 래퍼 통합.
- 프리셋 폴더 기능 및 정렬 가능한 선택기 추가.
- 프롬프트 역할과 프리셋 동작 정리.
- 모델 프리셋 런타임 및 어댑터 확장.
- `models.dev` 기반 모델 목록 카탈로그.
- 모델 프리셋 및 인증 정보 관리 화면 변경.
- 플러그인 및 모듈 탭 통합.
- 모델 프리셋에 플러그인 모델 추가 가능.
- HypaMemory 관리·수동 요약·검색 기능 추가.
- 번역 캐시 관리 및 번역 중 취소 기능 추가.
- 채팅 스트리밍 및 렌더링 안정성 개선.
- 메시지 부분 편집 방식 개선.
- 채팅 탐색·단축키·모바일 뒤로 가기 동작 개선.
- 테마와 채팅 텍스트 표시·스타일 설정 개선.
- 이미지·TTS·인레이 관련 설정 정리.
- 캐릭터 목록 및 사이드바 UI 변경.
- 정규식·로어북 편집 기능을 개선.
- 원격 접속 시 채팅·폴더 필터링 및 다중 기기 동기화 기능 추가.
- 스냅샷·자동 백업·에셋 복구 기능 추가.
- 리퀘스트 로그 보존 기능 추가.
- 사용량 기록 및 비용 추정 기능 추가.
- 채팅 생성 기능을 서버 측으로 일부 이전.
- UI·설정 구조 통합 및 레거시 정리.

## 주요 기능

- OpenAI, Claude, Gemini, OpenRouter, Ollama 등 여러 AI 제공자 지원
- PC·태블릿·스마트폰에서 사용할 수 있는 셀프 호스팅 서버
- SQLite 기반 캐릭터·채팅·설정·에셋 통합 저장
- 서버 백업·복원, 스냅샷 및 자동 백업
- 로어북, HypaMemoryV3, 번역, 정규식 스크립트와 플러그인
- 요청 로그, 토큰 사용량 및 예상 비용 확인
- TTS와 채팅 내 이미지·오디오·비디오 지원
- 그 외는 [PocketRisu](https://github.com/PocketRisu/PocketRisu)를 참고하세요.

## 문서

- [설치 가이드](../docs/ko/install.md)
- [RisuAI 마이그레이션 가이드](../docs/ko/migration.md)
- [원격 접속 가이드](../docs/ko/remote.md)
- [Android Termux 설치 가이드](../docs/ko/termux.md)

영문 문서는 [`docs/en`](../docs/en)에서 확인할 수 있습니다.

## RisuAI 호환성

PocketRisu Kei는 RisuAI 생태계와의 호환성을 유지합니다. 기존 RisuAI 데이터와 캐릭터 카드, 모듈, 로어북, 프리셋 및 백업 파일을 가져오거나 내보낼 수 있습니다. 자세한 내용은 [마이그레이션 가이드](../docs/ko/migration.md)를 확인해 주세요.

## 라이선스

[GPL-3.0](../LICENSE)
