# AI Assessment Assistant

**나이스(NEIS)의 작업 형식을 유지하는 수행평가·채점·세특 작성 앱입니다.**  
나이스에서 내려받은 성취기준, 반영비율/만점관리, 수행평가 채점 파일, 과목세특 파일을 한곳에 모아 평가 기준 정리부터 학생별 기록 작성까지 이어서 작업할 수 있습니다.

## 주요 기능
 
- 나이스 기반 성취 기준 및 평가 영역 자동 관리
- 나이스 기반 수업별 학생 명단 자동 정리 및 학생별 채점, 활동 기록, 세특 동시 관리

## AI 기능

- 평가 영역 및 채점/세특 기준 생성
- 학생 산출물 기반 채점, 활동 기록, 세특 생성
- 세특 맞춤법/문장 교정
- AI 요청 시 학생 식별 정보 노출 최소화

## 작업 흐름

나이스에서 엑셀 파일을 내려 받아 앱에서 작업한 뒤, 다시 나이스 업로드용 엑셀 파일로 저장할 수 있습니다.

| 단계 | 나이스 엑셀 다운로드 | 앱에서 정리/작성 | 나이스 엑셀 업로드 |
| --- | --- | --- | --- |
| 기준 준비 | 성취기준/평가기준 | 성취 기준 확인, 평가 영역과 연결 |  |
|   | | ↓ |  |
| 영역 준비 | 반영비율/만점관리 | 수행평가 영역, 만점, 반영 여부 정리 |  |
|   | | ↓ |  |
| 채점 및 세특  | 수행평가 채점/과목 세특 파일 | 학생 명단 자동 관리, 학생별 점수 입력, AI 보조 채점, 교사 검토 | 채점 결과/세특 엑셀 파일 생성 (나이스 용) |


## 주요 화면

### 성취 기준 관리

![성취 기준 관리](assessment/docs/screenshots/criteria.png)

### 평가 영역 관리

![평가 영역 관리](assessment/docs/screenshots/domains.png)

### 채점 기록 관리

![채점 기록 관리](assessment/docs/screenshots/records.png)

## 다운로드 / 설치

- [Windows 다운로드 (.exe)](https://github.com/bloomgloom/ai-assessment-assistant/releases/download/v0.1.0/AI%20Assessment%20Assistant%20Setup%200.1.0.exe)
- [macOS 다운로드 (.dmg)](https://github.com/bloomgloom/ai-assessment-assistant/releases/download/v0.1.0/AI%20Assessment%20Assistant-0.1.0-arm64.dmg)

macOS에서 “확인되지 않은 개발자” 경고가 나오면 Finder에서 앱을 우클릭한 뒤 `열기`를 선택합니다.

Windows에서 SmartScreen 경고가 나오면 배포자를 확인한 뒤 `추가 정보 > 실행`을 선택합니다.

## 개발자용

Node.js와 Python 3.11~3.13이 필요합니다. 처음 내려받은 저장소에서는 플랫폼별 최초 준비를 한 번 실행합니다.

### macOS

최초 준비:

```bash
npm install --no-audit --no-fund
npm install --prefix assessment --no-audit --no-fund
npm install --prefix assignment --no-audit --no-fund
npm run python:setup
```

일반 앱 빌드:

```bash
npm run build:mac:app
```

결과물은 `release/mac-arm64/AI Assessment Assistant.app`에 생성됩니다. Intel Mac에서는 `release/mac-x64`에 생성됩니다.

DMG까지 만들려면 `create-dmg`가 설치된 환경에서 앱 빌드 후 다음 명령을 실행합니다.

```bash
npm run build:mac:dmg
```

### Windows

최초 준비와 앱 빌드를 한 번에 실행:

```powershell
.\scripts\build-windows.ps1
```

의존성과 Python 환경이 이미 준비된 이후의 일반 빌드:

```powershell
npm run build:windows
```

Windows 결과물은 `release` 폴더에 생성됩니다.

## TODO

- [ ] 수행평가 실시 이력 보기
- [ ] 학생별 산출물 이력 보기
