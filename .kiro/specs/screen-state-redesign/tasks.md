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

## 追加修正2（実機テストのフィードバックによる）

- [x] 録音停止後、履歴リストへの登録がまだ遅い問題を修正。原因は `stopRecording` が `streamer.finish()`/`eventStreamer.finish()`（実際に文字起こしモデルを呼ぶ、数秒かかりうる処理）の完了を待ってから `capture.finish()`＋暫定 `persistTake` を実行していたこと。`refineRecording` を `fileTakeProvisionally`（WAV クローズ＋暫定履歴登録）と `refineRecording`（精度向上パス本体）に分割し、`stopRecording` から `fileTakeProvisionally` をライブ文字起こしのフラッシュより**前**に呼ぶよう順序を入れ替えた（`src/store/recordingPipeline.ts`, `src/store/appStore.ts`）。暫定エントリがライブ文字起こしの最後の1ウィンドウ分を含まない可能性があるが、精度向上パス完了後にどのみち上書きされるため許容
- [x] 閉じるボタンの位置を変更: サイドバー表示切替ボタン（`toggleSidebar`）を廃止し、サイドバーは Home 画面で常時表示に変更。そのボタンがあった位置（タイトルバー左）に「戻る」ボタンを新設し、`TranscriptPanel.tsx` 内にあった小さな×ボタンを置き換えた（`src/components/TitleBarControls.tsx` 全面書き換え、`src/App.tsx`、`src/store/appStore.ts`／`src/store/persistedSettings.ts` から `sidebar.visible`/`toggleSidebar` を削除）
- [x] `npm run build`／`npm run lint`／`npx vitest run` 再確認（全通過、100テスト）

## 追加修正3（モックレイヤーがブラウザで実際には動いていなかった件）

上記モックレイヤーは未検証のままで、実際にブラウザで開くと途中から無言で死んでいた。原因と対処:

- [x] dev サーバに到達できない: `vite.config.ts` の `server.host` が `false`（127.0.0.1 のみ bind）で `allowedHosts` 未設定だったため、コンテナ/リモートのプレビュープロキシ経由では届かなかった。`host: host || true` + `allowedHosts: true` に変更（dev サーバのみ。`TAURI_DEV_HOST` の優先は維持、`devUrl` は `localhost:1420` のまま）
- [x] 依存が入っていない環境で `npm run dev` が起動しない: `.claude/hooks/session-start.sh` + `.claude/settings.json`（SessionStart hook）で `npm install` するようにした（web セッションのみ、`CLAUDE_CODE_REMOTE` でガード）
- [x] 再生が常に 0:00: `audio/playback.ts` の `readFile`（plugin-fs）が未モックだった。録音長ぶんの**無音 WAV**（8kHz/8bit/mono）を合成して blob URL にする分岐を追加。`createPlaybackController` は無変更のまま、シーク・速度変更・`ended` が実機と同じ挙動になる
- [x] エクスポートが未処理 rejection: `saveTranscript.ts` は `false`（キャンセル扱い）を返すようにし、`TranscriptToolbar.tsx`／`HistorySidebar.tsx` の .txt/.srt 項目自体を disabled に（ネイティブ保存ダイアログが必要なため、ブラウザでは非対応で確定）
- [x] アプリ音声ピッカーが常に空: `audio/appAudio.ts` の3メソッドをモック（ダミー2件、キャプチャは no-op）
- [x] 精度向上パスの結果が常に1行 `[0,3]` 固定だった: 録音の実長に沿って複数チャンクに分割（`mockRefinedResult`）。行クリックのシーク・アクティブ行ハイライト・話者ラベル・SRT 出力が確認できるようになった
- [x] 音響イベントが常に空: 10秒ごとのダミーイベントを返すように変更
- [x] 履歴が起動時に空: サンプル2件（解析済み＋録音のみ）をシード（`seedMockRecordings`）
- [x] モックデータを `src/lib/mock/fixtures.ts` に集約、`TitleBar.tsx` に `MOCK` バッジを追加
- [x] Chromium（Playwright）で実際に目視・自動確認: バッジ表示、履歴2件、行選択→文字起こし5行＋話者ラベル、再生の時間進行（1.7s→シークで90.2s、duration 184s）、アプリ音声2件、保存メニューの disabled、録音開始→ライブ文字起こし→停止→精度向上パス→履歴追加（19.2s, transcribed=true）まで通し。`pageerror`・console error/warning ともに 0

## 未検証

- Tauri ネイティブウィンドウでの実際の目視確認（`npm run tauri dev`）。上記の変更のうちネイティブ経路に触れるのは `vite.config.ts` の bind 先と Host 検査のみで、モック分岐はすべて `isTauri() === true` で無効になる
- モンキーテストで報告された2つの不具合（ゴミ画面フラッシュ、録音開始の遷移遅延）が実機で解消されているかの再現確認

---
**STATUS**: 実装済み（レビュー・実機確認待ち）
