# Design Document — 稼働モード／ホーム画面への再設計

## Overview

`current-state.md` で文書化した現状仕様と、モンキーテストで見つかった2つの不具合（状態遷移時のゴミ画面フラッシュ、録音ボタン押下後の遷移遅延）を踏まえ、画面を「録音開始・中断を行う稼働モード」と「履歴データを閲覧・操作するホーム画面」に明確に分割する。

設計にあたり、類似プロダクト（Apple Voice Memos、Google Recorder、Otter.ai、Descript、Riverside.fm）の実例調査と、一般的な UI パターン（マスター・ディテール、詳細パネルの閉じ方の慣習）の調査を行い、その知見を反映している（各節で出典を明記）。

**本書はまだ人間によるレビュー・承認前の設計案である**（`spec.json` の `approvals.design.approved` は `false`）。実装（コード変更）は承認後に着手する。

---

## 1. 画面構成

### 1.1 なぜ2画面なのか（3画面ではなく）

ユーザーの当初案は「稼働モード」「履歴閲覧モード」「その2つを切り替えるホーム画面」という3つの言葉で語られていたが、実際に必要な**独立したレイアウト**は2つだけだと判断した。

- 「ホーム画面（未選択）」と「履歴閲覧（選択中）」は、左パネル（履歴一覧）・右パネルという同じ器を共有し、右パネルの中身が変わるだけである。これを別画面として分離するメリットは無い。**Google Recorder が「録音画面とライブラリを同一画面」として扱っている**のと同じ考え方を採用し、1つの画面（以下「Home」と呼ぶ）に統合する
- 一方「稼働モード（録音中）」は、左パネルが消え、右パネルの中身も操作の性質からして別物（トランスポート主体）になる。これは **Apple Voice Memos が録音中に一覧を完全に隠し、Descript/Riverside.fm がプロジェクト一覧と編集画面/収録画面を別ルートとして扱っている**のと同じ考え方で、独立した画面（以下「Active」と呼ぶ）として扱う

### 1.2 画面一覧

| 画面 | 左パネル | 右パネル | 表示条件 |
|---|---|---|---|
| **Home** | 履歴一覧（常時表示・スクロール可） | サブ状態Aまたは B（1.3節） | `recordingPhase === "stopped"` |
| **Active** | **非表示**（コンポーネントごとアンマウント。折りたたみアイコンレールにはしない — 1.1節の Voice Memos の前例と、"アイコンレールは通常アプリ全体のナビゲーション用で、録音中の一覧抑制に使われた前例は見つからなかった" という調査結果による） | サブ状態 C または D（1.4節） | `recordingPhase !== "stopped"` または `startingRecording === true`（2.1節） |

### 1.3 Home のサブ状態

- **A. 未選択（CTA）**: 履歴が何も選択されていない状態。右パネルに録音開始ボタン（hero サイズ）と、マイク選択・アプリ音声選択・「録音のみ」トグルをまとめた `RecordStartPanel`（3.1節）を表示する
- **B. 履歴選択中**: 履歴一覧から1件選択している状態。右パネルにその録音の文字起こし本文と操作（保存・再解析/解析中止トグル・削除）を表示する。現行の `TranscriptPanel`/`TranscriptToolbar` がそのまま使える

**録音開始ボタンは A にのみ存在する。** B では録音開始ボタンを表示しない — これはユーザーからの明示的な指示（「履歴閲覧モードから稼働モードには直接遷移させない」）であり、新しい録音を始めるには一旦 B から A に戻る（×ボタンまたは選択中の行を再クリック）操作を挟む。現行の FAB 録音ボタン（`App.tsx:169-173`、"stopped かつ何か画面にある" なら常時表示されていたもの）はこの設計で廃止する。

### 1.4 Active のサブ状態

- **C. starting**: 録音ボタンを押した直後、マイク/デバイスの準備が完了するまでの状態。左パネルは既に非表示、右パネルには不確定（パーセンテージを伴わない）進捗インジケータと「マイクを準備しています…」等のラベルを表示する。ここでは一時停止・停止ボタンは意味を持たない（まだ何も録れていない）ため表示しない。**中断ボタンは設けない**（ユーザー確認済み — 準備完了かエラーになるまで待つのみで実装をシンプルに保つ）
- **D. recording / paused**: 現行の `RecordButton`（2ボタン: 一時停止⇄再開／停止）＋`LevelMeter`＋ライブ文字起こしプレビュー。中身は現行のまま、C から自動的に切り替わる

一時停止・再開は C/D 間の遷移ではなく D 内部の状態変化であり、画面は変わらない（`App.tsx` の既存コメントが「pausing は take を終えないのでレイアウトを変えてはいけない」と明記している方針を維持）。

---

## 2. 状態モデルの変更

### 2.1 新規 transient フィールド `startingRecording: boolean`

画面の切り替えを「マイクが実際に使える状態になったか」から切り離し、「録音ボタンを押した」という**ユーザーの意図**に即座に追従させるための唯一の新規ステートである。

```ts
// appStore.ts の AppState に追加
startingRecording: boolean; // 初期値 false
```

`startRecording()` の実装変更点（既存コードは `current-state.md` 4.1節参照）:

- 関数の**冒頭、`capabilitiesOf(get()).startRecording` のガードを通過した直後、最初の `await` より前**に `set({ startingRecording: true })` を同期的に実行する
- 現状 `capture.start()` → `appAudioClient.startCapture()` → `startPcmRecording()` という3段の `await` を経て初めて `recordingPhase: "recording"` になっていた最後の `set()` に、`startingRecording: false` を同じ呼び出しでまとめる
- `catch` 節（失敗時に `recordingPhase: "stopped"` へ戻す既存の `set()`）にも同様に `startingRecording: false` を含める

これにより Active 画面のマウント条件は `recordingPhase !== "stopped" || startingRecording` となり、**クリックした瞬間に真になる**。マイク準備の3段 `await` の間は C（starting）が表示され、成功すれば D（recording）へ、失敗すれば自動的に Home へ戻る。

**副次効果（現状分析5.1節の不具合修正）**: `capabilities.ts` の `startRecording` 判定に `!startingRecording` を追加することで、連打時に2つ目の `startRecording()` 呼び出しがガードを素通りしてしまう既存の不具合（`activeRecorder` 等のモジュール変数を2つの呼び出しが奪い合う）も同時に閉じる。画面遷移用に導入した1フィールドが、UX 要求と過去に特定した不具合の両方を1つの変更で解決する。

**なぜ `RecordingPhase` の列挙値を増やさないか**: `RecordingPhase`（`stopped`/`recording`/`paused` の3値）は `capabilities.ts` の `selectCapabilities` をはじめ随所で網羅的にパターンマッチされている（`capabilities.test.ts` はこの関数を「1つの状態追加が `===` チェーンをすり抜けないことが存在理由」と明記するほど徹底的にテストされている）。ここに `"starting"` を4値目として割り込ませると、既存の全分岐を洗い出して更新する必要が生じ、変更範囲が本来の目的（画面遷移のタイミング調整）に対して不釣り合いに大きくなる。`startRecording`/`stopped` とは独立した transient boolean にすることで、影響範囲を `App.tsx` の画面分岐と `capabilities.ts` の `startRecording` 判定の2箇所に限定できる。

### 2.2 `sidebar.visible` の扱い

ストアのフィールド自体・永続化（`persistedSettings.ts` の `SidebarSettings`、`loadSidebarSettings`/`saveSidebarSettings`）は変更しない。これは引き続き「Home 画面でのユーザーの好み」を表す。

変更するのは `App.tsx` の描画ゲートのみ:

```diff
- {sidebar.visible && (
+ {sidebar.visible && recordingPhase === "stopped" && (
    <HistorySidebar ... />
  )}
```

Active 突入時は保存値に関わらず強制的に非表示になり、Home に戻れば保存されていた値がそのまま復元される。サイドバー表示切替ボタン（現行 `TitleBarControls.tsx` 内）も `recordingPhase === "stopped"` の間だけ描画する — Active 中は切り替え先のパネル自体が存在しないため、disabled のまま見せ続けるより非表示にする方が誠実である。

### 2.3 変更しないもの

- `processing`／`viewedRecordingId`／`processingRecordingId` のセマンティクスは無変更
- `capabilities.ts` の `reanalyze`/`cancelAnalysis`/`browseHistory` 等の判定ロジックも無変更（Home 画面内の履歴選択・再解析まわりの挙動はそのまま）

---

## 3. コンポーネントの再配置

### 3.1 新規 `RecordStartPanel.tsx`

Home のサブ状態 A（未選択）の右パネルの中身。以下を内包する:

- `RecordButton`（hero サイズ、現行のまま）
- `MicPicker`（`TitleBarControls.tsx` から移設）
- `TargetAppPicker`（同上）
- 「録音のみ」トグル（同上）

`App.tsx` の現行 `idleEmpty` 分岐（139-147行目）をこのコンポーネントに置き換える。

**移設に伴う簡略化**: `MicPicker`/`TargetAppPicker`/録音のみトグルは現在 `locked`/`modeLocked`（`recordingPhase !== "stopped"` や `processing !== null` を見て disabled にする）というガードを個別に持っている（`TitleBarControls.tsx:21,67,134-138`）。`RecordStartPanel` はそもそもサブ状態 A（`recordingPhase === "stopped"` かつ `processing === null` かつ何も選択されていない）でしかマウントされないため、このガードは到達不能になる。**移設と同時に削除する**（disabled 状態を残す必要はない — マウントされていない = 存在しない、という状態遷移そのものがガードの役割を果たす）。

### 3.2 `TitleBarControls.tsx` の縮小

上記3コントロールが抜けた後に残るのはサイドバー表示切替ボタン1つ（`recordingPhase === "stopped"` 限定、2.2節）。1つのボタンのために独立ファイルを残すか `TitleBar.tsx` に直接畳み込むかは実装時の裁量とする（見た目には影響しない実装詳細）。

### 3.3 Active 画面へのテーマ切替の追加

`HistorySidebar.tsx` フッターにある `ThemeToggle`＋`SettingsDialog` は、左パネルごと Active 画面から消える。`SettingsDialog` の中身（`SettingsPanel.tsx`）はどのみち録音中は自己ロックされる（`pointer-events-none opacity-60`、`SettingsPanel.tsx:91`）ため入口が無くなっても実害は無いが、`ThemeToggle` は録音状態と無関係な操作であり、録音中に「部屋が暗くなったのでダークモードにしたい」という要求は現実的にありうる。**ユーザー確認の結果、Active 画面にも小さくテーマ切替を残す**（既存の `ThemeToggle` コンポーネントをそのまま再利用、配置は右パネルの隅を想定・実装時に調整）。

### 3.4 変更不要なコンポーネント

- `RecordingTimeline.tsx` — 既に `!stopped || playback.recordingId == null` で自己非表示（187行目）のため無変更
- `TranscriptPanel.tsx`/`TranscriptToolbar.tsx` の本体ロジック — 無変更（3.5節の追加ボタンのみ）
- `RecordButton.tsx`／ストアの `pauseRecording`/`resumeRecording`/`stopRecording` — 無変更

### 3.5 `TranscriptPanel.tsx` への閉じるボタン追加

Home のサブ状態 B（履歴選択中）に、明示的な ×（閉じる）ボタンを追加する。位置は現行の「履歴を表示中 — `<日時>`」の行と同じ並び。押下すると既存の `deselectHistoryEntry()` を呼ぶだけで、新規ストアアクションは不要。

調査で確認した「詳細/ピークパネルを閉じる操作は × ボタンが確立された慣習（Linear の Esc=Peek を閉じる、一般的な X=モード解除の慣習）」という知見を踏まえた追加。既存の「選択中の行をもう一度クリックすると解除」という暗黙の操作（`HistorySidebar.tsx:126-128`）は**そのまま併存させる**（× ボタンは発見しやすさのための追加であり、置き換えではない）。

---

## 4. 画面遷移一覧

| # | 操作 | 遷移前 | 遷移後 | 実装 |
|---|---|---|---|---|
| 1 | Home（A: 未選択）で録音ボタンをクリック | Home / A | **即座に** Active / C（starting） | `startRecording()` 冒頭で同期的に `startingRecording: true`（2.1節） |
| 2 | マイク/デバイス準備が完了 | Active / C | Active / D（recording） | `startRecording()` 末尾の既存 `set()` に `startingRecording: false` を追加 |
| 3 | 一時停止／再開 | Active / D（recording⇄paused） | 画面は変わらない | `pauseRecording`/`resumeRecording` 無変更 |
| 4 | 停止ボタン | Active | Home / B（直前に録音した内容を選択済み表示） | `stopRecording()` 無変更。`processing` が非 null の間は A（CTA）には戻らない — 既存の `idleEmpty` 相当の条件（`processing===null && segmentCount===0 && playback.recordingId==null`）をそのまま再利用するため |
| 5 | 履歴行をクリック | Home（A または B） | Home / B（その履歴を選択） | `loadHistoryEntry(id)` 無変更 |
| 6 | 新規×ボタン、または選択中の行を再クリック | Home / B | Home / A | `deselectHistoryEntry()` 無変更 |
| 7 | 履歴削除（表示中のものを削除） | Home / B | Home / A | `deleteHistoryEntry(id)` 無変更（内部で `resetToBlankSession`） |
| 8 | 履歴選択中に新しい録音を始めたい | Home / B | （録音ボタンが存在しないため）まず #6 で A に戻り、その後 #1 | 新規ルール。ストア側の変更は不要 — `RecordStartPanel` が A にしか無いという配置だけで実現する |
| 9 | 別の録音の再解析（解析中止トグル含む）が裏で走っている間の Home 操作 | Home（常時。Active とは絶対に共存しない） | 変化なし、Home 内で完結 | `capabilities.ts` の `idle = stopped && processing === null` により、`processing !== null` の間は `startRecording` 自体が false になる。したがって「再解析中に録音を開始して Active へ抜ける」という遷移は構造的に発生しない（現状分析5.4節で検証済み） |

失敗時（起動2で権限エラー等）は `startRecording()` の `catch` が `recordingPhase: "stopped"` と `startingRecording: false` を同じ `set()` で戻すため、Active（C）から Home（A）へ自動的に戻り、`errorMessage` がバナー表示される。

---

## 5. エッジケース

- **録音のみモードでの停止**: `finishRecordOnly` も `refineRecording` と同様に `markRecordingViewed` を呼ぶため、停止後は Home / B に「未解析（録音のみ）」状態の当該履歴が選択された状態で戻る。既存の `TranscriptPanel`/`HistoryRow` の未解析表示がそのまま使える
- **初回起動（履歴が1件も無い）**: 左パネルは既存の空状態メッセージ（「録音履歴はまだありません。」）、右パネルは A（CTA）。無変更で成立する
- **Active 中に何らかのエラーで録音が落ちた場合**（例: `stopRecording` を待たずにデバイスが切断される等）: 本設計の対象外（現行のエラー処理をそのまま踏襲する。将来的な検討事項として `design.md` の範囲外に置く）

---

## 6. 実装への申し送り事項（設計判断ではなく実装時の裁量）

- `RecordStartPanel.tsx` という名前は仮称。実装時に別名でも良い
- ×（閉じる）ボタンの正確なピクセル位置・アイコンサイズはモックアップ/実装時に調整
- `TitleBarControls.tsx` を1ボタンのまま残すか `TitleBar.tsx` に畳み込むかは見た目に影響しない実装判断
- Active 画面のテーマ切替の正確な配置（右上/左上/フッター相当の位置）は実装時に決定

---

## 7. 未対応・スコープ外（今回のユーザー指示で明示的に決定済み・変更不要）

- 稼働モード中の履歴一覧は「折りたたみアイコンレール」ではなく完全非表示とする（1.2節の根拠により決定済み、追加の意思確認は不要）
- 録音準備中（starting）に中断ボタンは設けない（ユーザー確認済み）
