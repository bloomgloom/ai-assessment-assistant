# Assignment 개발 README

`assignment`는 수행평가 시간에 학생이 같은 LAN에서 교사 PC로 접속해 안내 사항을 보고 파일을 제출하는 전용 앱으로 만들 예정입니다. `assessment`와 코드, DB, 저장소를 분리합니다.

## 기술 스택

아직 구현 전입니다. 구현 시 `assessment`와 같은 TypeScript 기반 웹 서버/클라이언트 구조를 사용하되, 채점·AI·설정 기능은 포함하지 않습니다.

## 개발 실행

예정 명령:

```bash
npm install
npm run dev
```

서버 프로세스 하나가 용도별 포트 세 개를 엽니다.

```text
수행 진행: http://127.0.0.1:3002       (localhost-only)
교사 뷰어: http://<교사 PC IP>:3003   (LAN 공개)
학생 화면: http://<교사 PC IP>:10000  (LAN 공개)
```

## 환경변수 / 설정

항목:

- `ADMIN_PORT`: 수행 진행 화면 포트. 항상 `127.0.0.1`에만 바인딩
- `TEACHER_PORT`: 교사 뷰어 포트
- `STUDENT_PORT`: 학생 화면 포트
- `HOST`: 교사 뷰어와 학생 화면 바인딩 주소. 운영 시 `0.0.0.0`
- `APP_STORAGE_DIR`: Electron에서 주입하는 저장 루트

## DB / 저장소

Electron 앱에서는 아래 경로를 사용합니다.

```text
<userData>/storage/
  data/assignment.db
  data/assessment.db
  templates/
  uploads/
    artifacts/
    submissions/
```

`assignment`는 `assessment` DB에 접근하지 않습니다. DB 파일은 분리하되, 제출 산출물은 `assessment`에서 바로 볼 수 있도록 같은 storage 루트의 업로드 영역을 공유합니다.

## 주요 라우트 개요

- 수행 진행 포트 `/`: 수행 시작/종료 및 제출 현황 관리
- 교사 뷰어 포트 `/`: 외부 교사용 제출 현황
- 학생 화면 포트 `/`: 학생 안내 사항 및 제출 화면

## Electron 통합 메모

- 수행평가 모드는 학생 접속을 위해 `0.0.0.0`에 바인딩합니다.
- 학생 접속 주소는 `http://<교사 PC IP>:<포트>` 형태로 앱에 표시합니다.
- 파일 서빙은 id 기반으로만 처리하고, 학생 입력에서 파일 경로 문자열을 받지 않습니다.
- 파일명을 저장할 때 `..`, `/`, `\`를 제거합니다.
- 경로 처리가 필요한 경우 `resolve` 후 기준 디렉터리 containment 검사를 수행합니다.
- 채점 기준, 점수, 피드백, AI 프롬프트, API 키는 이 앱에 포함하지 않습니다.
