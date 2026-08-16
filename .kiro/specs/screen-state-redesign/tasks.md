# Implementation Plan

`design.md` の承認を待たずに実装に着手した（ユーザー指示による）。以下は実際に行った変更の記録。

- [x] `startingRecording` transient state を追加（`src/store/appStore.ts`: `AppState` フィールド・初期値・`capabilitiesOf`、`src/store/capabilities.ts`: `CapabilityInputs`/`selectCapabilities`、`src/store/capabilities.test.ts`: 追加テスト）
- [x] `src/components/RecordStartPanel.tsx` を新規作成（hero `RecordButton` + `MicPicker` + `TargetAppPicker` + 録音のみトグル。`TitleBarControls.tsx` から移設、`locked` ガードは削除）
- [x] `src/components/TitleBarControls.tsx` をサイドバー表示切替ボタンのみに縮小（`recordingPhase === "stopped"` の間だけ描画）
- [x] `src/components/ActiveRecordingScreen.tsx` を新規作成（`starting`/`recording・paused` の2サブ状態、`ThemeToggle` を追加）
- [x] `src/App.tsx` をトップレベルで Home／Active の2分岐に再構成。FAB 録音ボタンを削除
- [x] `src/components/TranscriptPanel.tsx` に履歴表示中の閉じる（×）ボタンを追加（`deselectHistoryEntry()` を呼ぶ。行の再クリックによる解除は従来通り併存）
- [x] `npm run build`（tsc + vite）／`npm run lint`（oxlint）／`npx vitest run` がすべて通過することを確認（100テスト）

## 追加修正（実装後のユーザーフィードバックによる）

- [x] 録音停止後、精度向上パス完了を待たずに履歴へ即時登録（`src/store/recordingPipeline.ts`: `refineRecording` 冒頭で `liveTakeSnapshot` を使った暫定 `persistTake` 呼び出しを追加。ライブ文字起こしの内容で先に保存し、精度向上パス完了後に本来の `persistTake` で上書き。`finishCancelledTake` も同じヘルパーを共有するようリファクタ）
- [x] `TranscriptPanel.tsx` の閉じる（×）ボタンを `recordingHistory` の反映待ちに依存しないよう修正（`viewedRecording` ではなく `recordingPhase === "stopped"` でゲート。上記の即時登録修正と合わせて、停止直後から閉じるボタンが使えるようになった）
- [x] バックエンド無し（`npm run dev` をプレーンブラウザで開いた場合）でも画面遷移を確認できるモックレイヤーを追加
  - `src/lib/env.ts`（新規）: `@tauri-apps/api/core` の `isTauri()` を使い、Tauri 外 + dev ビルドの時だけ `useMockBackend` を true にする
  - `src/components/TitleBar.tsx`: `getCurrentWindow()` が Tauri 外でクラッシュしていたのを `runningInTauri` でガード
  - `src/lib/asr/capture.ts`（`RecordingCapture`）: `start_capture`/`append_capture`/`finish_capture` をモック（経過時間から仮の `durationSec` を生成）
  - `src/lib/asr/client.ts`（`AsrClient`）: `init_model`/`transcribe_window`/`transcribe_recording`/`begin_analysis`/`cancel_analysis`/`diarize_recording`/`detect_audio_events`/`detect_events_window` をモック。`transcribeRecording` は `onRefineProgress` を段階的に呼び進捗バーも確認できるようにし、`cancelAnalysis` 呼び出しで実際に `ANALYSIS_CANCELLED` を投げてキャンセルフローも再現
  - `src/lib/history.ts`: 4つの永続化関数をメモリ内 `Map` にフォールバック（`saveRecordingHistory`/`listRecordings`/`loadRecording`/`deleteRecording`/`wavPath`）
  - `src/lib/asr/capture.test.ts`: 新規 `isTauri` インポートに対応するモックを追加（既存テストは実バックエンド経路のままにするため `isTauri: () => true` を返す）
- [x] `npm run build`／`npm run lint`／`npx vitest run` 再確認（全通過）

## 未検証

- 上記モックレイヤーは実際のブラウザでの目視確認ができていない（このセッションのブラウザプレビューツールが `localhost:1420`（ユーザー自身の `npm run dev` プロセス）にネットワーク到達できず、コンソール確認・スクリーンショットとも失敗した）。ユーザー自身のブラウザで `npm run dev` → `http://localhost:1420` を開いての確認が必要
- Tauri ネイティブウィンドウでの実際の目視確認（`npm run tauri dev`）
- モンキーテストで報告された2つの不具合（ゴミ画面フラッシュ、録音開始の遷移遅延）が実機で解消されているかの再現確認
- 保存（.txt/.srt エクスポート）ボタンはモック未対応（`saveTranscript.ts` は非対象 -- クリックすると失敗するが画面遷移には影響しない）

---
**STATUS**: 実装済み（レビュー・実機確認待ち）
