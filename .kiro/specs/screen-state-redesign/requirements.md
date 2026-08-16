# Requirements Document

## Project Overview
WhisperScribe の画面状態管理（録音/処理/履歴閲覧/再生の各状態と、それらが駆動する画面表示）を再設計する。モンキーテストで見つかった「状態遷移時のゴミ画面フラッシュ」「録音開始ボタンを押してもすぐに遷移しない」といった不具合の根本原因は、画面表示と内部状態（Zustand ストア、および `timeline.ts`/`playback.ts`/`appStore.ts` のモジュールスコープ変数といった非リアクティブな可変状態）の不一致にあると推測されている。

## Project Description (User Input)
解析実行中のキャンセルボタンの UI 統合を経て、モンキーテストで複数の状態遷移バグ（ゴミ画面の一瞬表示、録音開始ボタン押下後の遷移遅延）が見つかった。これらは画面状態と内部状態の不一致が原因と考えられるため、まず現状の画面仕様を正確に定義し、その上で状態管理の設計を見直したい。

## 現状分析
現状の画面仕様・内部状態モデル・確認済みの不整合パターン（レースコンディション等）は [`current-state.md`](./current-state.md) にまとめてある。要件定義（本ファイル）はこの内容を前提知識として使う。

## Requirements
<!-- Detailed user stories will be generated in /spec-requirements phase -->

---
**STATUS**: Ready for requirements generation
**NEXT STEP**: Run `/kiro:spec-requirements screen-state-redesign` to generate detailed requirements
