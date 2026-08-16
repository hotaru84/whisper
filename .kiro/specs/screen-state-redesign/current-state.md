# WhisperScribe 画面仕様書（現状分析）

## 1. はじめに

### 1.1 目的

モンキーテストで以下の不具合が確認された。

- 状態遷移の際に、一瞬だけ本来出ないはずの「ゴミ」の画面が見える
- 録音ボタンを押してもすぐに録音中の画面に遷移しないことがある

これらは個別のバグというより、**画面表示（React コンポーネント側の見た目）と内部状態（Zustand ストア、およびそれ以外の非リアクティブな可変状態）の不一致を処理しきれていないこと**が根本原因と推測される。対症療法で個々のケースを直す前に、まず現状の画面仕様（どの内部状態でどの画面が出て、何が押せて、それを何が決めているか）を正確に文書化し、その上で改めて設計を見直す。本書はその第一段階の成果物であり、**現状の仕様の記録**であって、修正方針そのものではない（修正方針は本 spec の `design.md` で別途扱う）。

### 1.2 スコープ

- 対象: `src/`（React フロントエンド）
- 非対象: `src-tauri/`（Rust バックエンド）の実装詳細。ただし「フロントエンドから見て非同期境界になる箇所（Tauri IPC 呼び出し）」は言及する
- 非対象: 修正案・再設計案そのもの（次フェーズ）

### 1.3 用語

| 用語 | 意味 |
|---|---|
| ストア | `src/store/appStore.ts` の Zustand ストア（`useAppStore`） |
| モジュール状態 | ストア（React の再レンダーをトリガーする仕組み）の外側にある、モジュールスコープの `let` 変数。値が変わっても誰にも通知されない |
| 画面 | `App.tsx` 以下で条件分岐によって出し分けられる、ユーザーから見て意味のある表示のまとまり |

---

## 2. 内部状態モデル

このアプリの「今何が表示されているべきか」を決める状態は、**3つの独立した置き場所**に分散している。Zustand ストアだけが React の再レンダーをトリガーする「見える」状態で、残り2つは値が変わっても誰にも通知されない「見えない」状態である。

### 2.1 Zustand ストア（`src/store/appStore.ts`）

`useAppStore` の全フィールド（`AppState` インターフェース、`appStore.ts:88-241`）:

| フィールド | 型 | 意味 | 主な書き込み元 |
|---|---|---|---|
| `recordingPhase` | `"stopped" \| "recording" \| "paused"` | 録音自体が今どの状態か。**全ての土台になる一次状態** | `startRecording`/`stopRecording`/`pauseRecording`/`resumeRecording` |
| `processing` | `"transcribing" \| "refining" \| "saving" \| "cancelling" \| null` | 録音停止後のパイプラインの状態。`recordingPhase` とは意図的に直交する軸 | `stopRecording`, `refineRecording`, `finishRecordOnly`, `rerunHistoryEntry`, `cancelAnalysis` |
| `modelStatus` | `"idle" \| "loading" \| "ready" \| "error"` | 音声認識モデルの読み込み状態 | `initModel`, `clients.ts` の `onModelReady`/`onError` イベントハンドラ |
| `segments` | `TranscriptSegment[]` | 画面に出ている文字起こし本文 | 多数（下記参照） |
| `audioEvents` | `AudioEvent[]` | 画面に出ている音響イベント（`segments` と同じグローバルタイムライン） | 多数 |
| `recordingHistory` | `RecordingHistoryMeta[]` | 左パネルの履歴一覧（メタデータのみ） | `refreshRecordingHistory` |
| `viewedRecordingId` | `string \| null` | `segments`/`audioEvents`/`playback` が**今どの保存済み録音を表しているか**。`null` はライブ/未保存セッション | `markRecordingViewed`/`resetToBlankSession`/`viewLoadedRecording`（後述） |
| `errorMessage` | `string \| null` | 致命的エラーメッセージ | 各所 |
| `refineNotice` | `string \| null` | 「文字起こし自体はできているが一部の追加処理は失敗/未実施」系の非致命通知 | 各所 |
| `refineProgress` | `number \| null` | `processing === "refining"` の間だけ意味を持つ 0-100 の進捗 | `refineRecording`, `rerunHistoryEntry`, `clients.ts` の `onRefineProgress` イベント（Tauri バックエンドイベント経由、Promise チェーンの外） |
| `processingRecordingId` | `string \| null` | `processing` が今どの録音に対して走っているか。`viewedRecordingId` とは**意図的に独立** | `refineRecording`, `rerunHistoryEntry` |
| `settings`/`diarizeSettings`/`vadSettings`/`audioEventSettings` | 各設定型 | 文字起こし/精度向上パスの設定 | `updateSettings` 等（**`recordingPhase` によるガード無し**、2.4節参照） |
| `recordingMode` | `RecordingModeSettings` | `recordOnly` フラグを含む | `updateRecordingMode` |
| `sidebar` | `SidebarSettings` | 左パネルの幅・表示/非表示 | `setSidebarWidth`, `toggleSidebar` |
| `levelMeter` | `AudioLevelMeter \| null` | レベルメーター用のオブジェクト（クラスインスタンス、プレーンデータではない） | `startRecording`（作成）, `stopRecording`（`dispose()`） |
| `audioInputDevices`/`appAudioApps`/`appAudioTargetPid` | — | デバイス/アプリ音声ターゲット選択 | 各 `refresh*`/`setAppAudioTarget` |
| `playback` | `PlaybackState`（2.2節） | 再生中の録音の状態 | `loadPlayback`/`unloadPlayback`（`src/store/playback.ts`） |

#### ストア自身が明記する「同時に変わるべきフィールドのクラスタ」

`appStore.ts:244-271` に、ストアの著者自身によるコメントが存在する。これは今回の調査結果そのものを裏付ける、最も重要な一次資料である（要約せず該当部分を引用する）:

> Fields above that must change *together*, and where that's enforced. Every bug found in this store so far (see git history around `viewedRecordingId`, `resetToBlankSession`, `markRecordingViewed`) was one of these clusters drifting out of sync because a call site updated only some of its members.

明記されているクラスタ:

1. **`segments` / `audioEvents` / `viewedRecordingId` / `playback.recordingId`** — 合わせて「今画面に出ている録音は何か」を表す。書き込みは `resetToBlankSession`（離脱）・`viewLoadedRecording`（履歴を開く）・`markRecordingViewed`（録音直後に確定させる）の3関数を経由する規約になっている（3.10節）
2. **`recordingPhase` / `processing` / `modelStatus`** — 直交する3軸だが、2つ以上が同時に変わる遷移は必ず1回の `set()` にまとめる
3. **`refineProgress`** — `processing === "refining"` の間だけ意味を持つ。バックエンドイベント（`clients.ts` の `onRefineProgress`）はフロントエンドが `processing` を切り替えた後も届き得るため、書き込み側で毎回 `processing === "refining"` をチェックするガードが必須
4. **`processingRecordingId`** — `processing !== null` の間だけ意味を持つ。`viewedRecordingId` と一致している必要は**ない**（3.4節で詳述）

この規約が守られている箇所と、守られてはいるが**内部的には複数 `set()` に分かれている**箇所（＝ `await` を挟むタイミング次第で不整合が観測されうる箇所）を 4章・5章で個別に検証する。

### 2.2 `PlaybackState`（`src/store/playback.ts`）

ストアの `playback` フィールドの型。`src/store/playback.ts:11-42`:

```ts
interface PlaybackState {
  recordingId: string | null;
  loading: boolean;
  isPlaying: boolean;
  currentTimeSec: number;    // 読み込んだ WAV 自身の 0 起点タイムライン上の秒数
  durationSec: number;
  rate: number;
  timelineOffsetSec: number; // 読み込んだ WAV が segments のグローバルタイムライン上のどこに位置するか
  seekSeq: number;           // 明示的なシークのたびに +1（再生の自然な経過では増えない）
}
```

`IDLE_PLAYBACK`（`recordingId: null` 他すべて初期値）がリセット値。

`loadPlayback`（`playback.ts:64-87`）の要点:

```ts
export async function loadPlayback(recordingId, path, timelineOffsetSec = 0) {
  const { getState, setState } = useAppStore;
  if (getState().playback.recordingId === recordingId) return; // 同一なら何もしない
  playbackController?.dispose();
  playbackController = null;
  setState({ playback: { ...IDLE_PLAYBACK, recordingId, timelineOffsetSec, loading: true } }); // ここは同期
  try {
    const url = await wavToBlobUrl(path); // Tauri fs プラグイン経由の IPC、ここが非同期境界
    if (getState().playback.recordingId !== recordingId) { // 呼び出し中に切り替わっていたら破棄
      URL.revokeObjectURL(url);
      return;
    }
    playbackController = createPlaybackController(url, (snapshot) => { ... });
    setState((s) => (s.playback.recordingId === recordingId ? { playback: { ...s.playback, loading: false } } : {}));
  } catch (err) {
    setState((s) => (s.playback.recordingId === recordingId ? { playback: IDLE_PLAYBACK } : {}));
  }
}
```

`recordingId` の設定自体は呼び出しの同期部分（`await` の前）で即座に行われる。この関数のほぼ全ての呼び出し元は `void loadPlayback(...)` の形（fire-and-forget）で呼ばれており、呼び出し元自身はこの関数の完了を待たない。

### 2.3 Zustand の外側にある「隠れた」可変状態

React が関知しない、モジュールスコープの `let` 変数。**値が変わっても誰も再レンダーされない** — これが今回の不具合調査で最も重要な着眼点である。

#### `src/store/timeline.ts`（モジュール全体が非リアクティブな状態）

```ts
let segmentId = 1;               // 次に作る transcript segment の連番 id
let timelineBaseSec = 0;         // 次の録音がセッション全体のタイムライン上のどこから始まるか
let recordingBaseSec = 0;        // 今の録音がどこから始まるか（グローバル/segments 両方の意味で）
let segmentsBeforeRecording = 0; // 今の録音が始まる前に何個 segment があったか
```

`startRecording`（開始時）、`viewLoadedRecording`（履歴を開いた時）、`resetTimeline`（離脱時）、および `recordingPipeline.ts` の精度向上パスから読み書きされる。**Zustand の外にあるため、この4値がストアの `segments`/`viewedRecordingId` と矛盾した状態になっていても、画面上には何のエラーも出ない** — 次に segment を追加しようとした瞬間に、誤ったオフセットで静かに書き込まれる（5.3節で実トレースを示す）。

#### `src/store/playback.ts` の `playbackController`

```ts
let playbackController: PlaybackController | null = null;
```
再生中の `<audio>` ラッパー。ストアの `playback.recordingId` と対応しているはずだが、対応関係はコード規約で保たれているだけで、型システムには表れない。

#### `src/store/appStore.ts` のモジュール変数（`appStore.ts:363-384`）

```ts
let activeRecorder: PcmRecorderController | null = null;
let activeStreamer: StreamingTranscriber | null = null;
let activeCapture: RecordingCapture | null = null;
let activeEventStreamer: AudioEventStreamer | null = null;
let appAudioActive = false;
let recordingPaused = false;      // recordingPhase === "paused" のミラー（音声コールバック用、頻度が高すぎてストアを読めない）
let recordingRecordOnly = false;  // 録音開始時点の recordOnly を凍結（取り違え防止）
```
これらは録音中のマイク/キャプチャ配線そのものを保持する。`recordingPhase` と論理的に対応しているが、やはり型システムには表れない。

### 2.4 コンポーネントのローカル state 一覧

Zustand の外側にあるという意味では、以下も「隠れた状態」の一種である。**特に独自のタイマー/アニメーションループを持つものは、ストアの状態遷移と非同期に切り離れて動くため要注意。**

| コンポーネント/フック | ローカル state | 目的 | ストアとの同期方法 | リスク |
|---|---|---|---|---|
| `TitleBar.tsx` | `isMaximized`（`useState`） | 最大化/元に戻すアイコンの出し分け | `onResized` イベント→非同期 `isMaximized()` 呼び出し→`setIsMaximized`。**クリック時に楽観的更新しない** | OS 側の実際のウィンドウ状態に対して最大1往復分遅延する（アプリの状態とは無関係、実害は小さい） |
| `TitleBarStatus.tsx`（`useElapsedRecordingSec`） | `elapsed`（`useState`）、`activeSecRef`（`useRef`） | 録音経過時間の表示 | `recordingPhase` が変わるたびに `useEffect` で `setInterval`（500ms）を張り直す | エフェクトのクリーンアップと `setInterval` のコールバックの実行順序はブラウザ/React の内部スケジューリング依存のため、`recordingPhase` が既に切り替わった後に古い `spanStart` を使ったティックが1回だけ発火しうる（最大500ms未満のズレ） |
| `LevelMeter.tsx` | `barRefs`/`history`（両方 `useRef`、React state ではなく直接 DOM 操作） | 波形バーの描画（60fps を避けるため意図的に非 state） | `recordingPhase !== "recording"` になったら `useEffect` のクリーンアップで `cancelAnimationFrame` | `requestAnimationFrame` のコールバックと React のコミット/エフェクトのフラッシュは厳密には順序保証されないため、`recordingPhase` が既に `"paused"`/`"stopped"` に変わった後に最後の `tick()` が1回だけ発火しうる。`stopRecording` は同じ `set()` の中で `levelMeter: null` にする一方 `.dispose()` 自体はその**前**に呼んでいるため、その1回の `tick()` が既に `dispose()` 済みのオブジェクトに対して `.getLevel()` を呼ぶ可能性がある（5章 finding LM-1） |
| `useTranscriptScrollTracking.ts` | `autoScroll`（`useState`）、`prevPhaseRef`/`lastSeekSeqRef`（`useRef`） | 自動スクロール追従のオン/オフ | 4つの独立した `useEffect`（`recordingPhase` の `stopped→recording` エッジ検出、ネイティブ `scroll` イベント、新規 segment 追従、`seekSeq` 変化での強制ジャンプ）が同じ `autoScroll` を奪い合う | `stopped→recording` の境界で「新しい録音だから自動スクロールを再開」する効果と、ネイティブ scroll イベントリスナーがその直後に古い `scrollHeight` を読んで `autoScroll` を再び false に戻してしまう効果が競合しうる（5章 finding TS-1） |
| `useConfirmClick.ts` | `confirming`（`useState`）、`timerRef`（`useRef`） | 削除ボタンの2クリック確認（3秒でタイムアウト） | ストアを一切参照しない。呼び出し側が `key={meta.id}` 等で対象が変わった時にコンポーネントごと再マウントさせる前提 | フックそのものは無害だが、**呼び出し側がキー付けを怠ると**、確認待ち状態のまま裏で対象データが変わった場合に古いクロージャの id に対して `onConfirm` が飛ぶ余地がある（本アプリでは `HistorySidebar.tsx`/`TranscriptToolbar.tsx` とも `key={meta.id}`/`key={deleteHistory.id}` を付けており、現状は安全と確認済み） |
| `HistorySidebar.tsx` の `HistoryRow` | 独自 state なし（全て props/ストア由来） | — | — | — |
| `SettingsDialog.tsx` | 開閉状態は **Radix 内部の非制御 state**（ストアに対応フィールド無し） | ダイアログの開閉 | ストアと対応するフィールドが存在しないため、定義上「不一致」は起こり得ない。ただし裏を返すと、ストア側から強制的に閉じることもできない | 実害は小さいが、`z-50` を共有する他のポータル（`DropdownMenuContent` 等）との重なりで過去に実際に不具合が出た経緯が `TitleBar.tsx` のコメントに明記されている（2.5節） |
| `SettingsPanel.tsx` | 独自 state なし（全フィールドがストア直結） | — | `locked = recordingPhase !== "stopped"` を**この関数内で独自に再計算**（`capabilities.ts` の `editSettings` を使っていない） | 値としては現状 `editSettings` と一致しているが、実装が2箇所に分かれている。またロックは `pointer-events-none`（CSS のみ）で、`disabled` 属性ではないため、**録音開始前からフォーカスが当たっていたフィールドはロック後もキーボード操作で編集できてしまう**（5章 finding SP-1） |
| `RecordingTimeline.tsx` | 独自 state なし | — | `!stopped \|\| playback.recordingId == null` で **`return null`（アンマウント）**、CSS ロックではない | `SettingsPanel` と対照的に、こちらはキーボードすり抜けの問題が構造的に起きない |
| `RecordButton.tsx` | **独自 state 一切なし** | — | 4つのストア selector＋`selectCapabilities` を毎レンダー計算するだけの純粋関数 | このコンポーネント自体に起因する不整合は無い。問題があるとすればストア側の設計（5章 finding SR-1） |

---

## 3. 画面/コンポーネント別仕様

### 3.1 `App.tsx` トップレベルレイアウト

```ts
const takeOpen = recordingPhase !== "stopped";
const idleEmpty = !takeOpen && processing === null && segmentCount === 0 && playbackRecordingId == null;
```

`takeOpen` は `recordingPhase` 一本槍の単純な派生値なので、それ単体でフレーム内不整合は起きない。`idleEmpty` は **4つのストアフィールドの合成条件**であり、5章で詳述する残存レースの震源地。

| `idleEmpty` | `takeOpen` | 表示 |
|---|---|---|
| `true` | （常に `false`） | 中央に `<RecordButton />`（hero サイズ）＋案内文のみ |
| `false` | `true` | 上部に `<RecordButton />`（hero）＋`<LevelMeter />`、その下に `<RecordingTimeline />`＋`<TranscriptPanel />`。FAB 無し |
| `false` | `false` | `<RecordingTimeline />`＋`<TranscriptPanel />`、右下に浮動 `<RecordButton placement="fab" />` |

`idleEmpty` のコメント（`App.tsx:66-74`）は、**この4フィールド構成自体が過去のフラッシュ不具合の修正結果**であることを明記している: 以前は `viewedRecordingId == null` を条件にしていたが、それだと録音直後の「`segments`/`playback.recordingId` は既に埋まっているが `viewedRecordingId` の確定だけがまだ追いついていない」窓でヒーローボタンが一瞬映ってしまっていた。現在の4条件への変更でその特定のケースは塞がれているが、**別の非同期経路同士のレース（5.2節）は残っている**。

### 3.2 `RecordButton.tsx`（録音トランスポート）

ローカル state なし。`recordingPhase`/`processing`/`modelStatus`/`recordOnly` の4値と `selectCapabilities` だけで完全に決まる純粋な表示。

| `recordingPhase` | 表示 | アイコン | ラベル | `disabled` |
|---|---|---|---|---|
| `"stopped"`, `processing === null` | 1ボタン | `Mic` | 録音を開始 | `!can.startRecording` |
| `"stopped"`, `processing !== null` | 1ボタン | `Loader2`（回転） | 処理中です | `!can.startRecording` |
| `"recording"` | 2ボタン | 主: `Pause` / 副: `Square` | 一時停止 / 停止して保存 | **どちらも disabled 属性なし** |
| `"paused"` | 2ボタン | 主: `Mic` / 副: `Square` | 録音を再開 / 停止して保存 | **どちらも disabled 属性なし** |

**「押せる/押せない」の見た目が実際の許可条件と一致していない箇所**: `recordingPhase !== "stopped"` の分岐（2ボタン表示）では、`can.pause`/`can.resume`/`can.stop` を一切参照していない。3つの操作の可否はストアのアクション内部のガード（`capabilitiesOf(get()).pause` 等）だけで守られており、ボタン自体は常にクリック可能に見える。

クリックハンドラは3つとも `void 非同期関数()` の形で結果を捨てるだけで、連打を防ぐローカルなデバウンス/pending フラグは無い（4.1節・5.1節）。

### 3.3 `TranscriptPanel.tsx` / `TranscriptToolbar.tsx`（右パネル）

*このセッション内の直前の変更（解析中止トグルの実装）を反映した最新仕様。*

主な派生値:
```ts
const currentRecordingId = playback.recordingId;
const isRefining = processing === "refining";
const isCancelable = can.cancelAnalysis && currentRecordingId === processingRecordingId;
const isLive = recordingPhase !== "stopped" || processing === "transcribing";
```

`TranscriptToolbar` の「再解析」ボタン（`reanalyze` prop）は現在1つのボタンが2つの役割をトグルする:

| 条件 | 表示 | `onClick` | `disabled` |
|---|---|---|---|
| `currentRecordingId` が無い | ボタン非表示 | — | — |
| `isCancelable`（=表示中の録音がまさに解析実行中の対象） | 「解析中止」（`XCircle`） | `cancelAnalysis()` | `false` |
| それ以外（`currentRecordingId` はあるが対象外、または `processing==="cancelling"`） | 「再解析」（`RotateCw`） | `rerunHistoryEntry(currentRecordingId)` | `!can.reanalyze` |

「削除」ボタンは `viewedRecordingId` の有無で表示/非表示、`!can.browseHistory` で disabled。

`isRefining` の間は本文の上に注記テキストが出て（キャンセル操作は上記トグルボタンへ一本化済み、本文側に別ボタンは無い）、`ScrollArea` に `pointer-events-none opacity-60` が掛かる。

### 3.4 `HistorySidebar.tsx` / `HistoryRow`（左パネル）

*同じくこのセッションで解析中止トグル＋進捗バーを実装済みの最新仕様。*

行ごとの派生値:
```ts
const isProcessing = processingRecordingId === meta.id;      // この録音に対して何らかの processing が走っている
const isRefiningThis = isProcessing && can.cancelAnalysis;    // かつ "refining"（"cancelling" ではない）
const browsable = recordingPhase === "stopped";                // クリック可能かどうか（processing は見ていない）
const selected = viewedRecordingId === meta.id;
```

| 状態 | 見出し行右側 | 進捗バー | アクションボタン |
|---|---|---|---|
| `isRefiningThis` | `解析中… NN%`（`Loader2` 回転） | あり（`refineProgress` を幅%に反映） | 「解析中止」（`XCircle`、常時表示・ホバー不要） |
| `isProcessing && !isRefiningThis`（＝cancelling） | `中止中…` | なし | ボタン非表示 |
| `!isProcessing && !meta.transcribed` | 通常の長さ表示 | なし | 「解析」（`Wand2`、ホバー時のみ表示、`disabled={!can.reanalyze}`） |
| `!isProcessing && meta.transcribed` | 通常の長さ表示 | なし | ボタンなし（削除・その他メニューのみ） |

行自体（クリックで `loadHistoryEntry`/`deselectHistoryEntry`）は `browsable = recordingPhase === "stopped"` のみでガードされ、`processing` の値には一切依存しない — **「他の録音の解析が裏で走っていても、別の履歴行はクリックできる」ことが仕様として意図されている**（`processingRecordingId` のドキュメントコメントにも明記、4.6節）。削除ボタンだけは `disabled={!browsable || isProcessing}` で、この行自身が解析中の間は保護される。

### 3.5 `TitleBar.tsx` / `TitleBarStatus.tsx` / `TitleBarControls.tsx`

- `TitleBar` は `z-[60]` に固定され、`ModelLoadingOverlay`（`z-40`）や `Dialog`（`z-50`）より常に手前に来る。**設定ダイアログを開いている間もウィンドウの最小化/最大化/閉じるとタイトルバー左の操作（サイドバー開閉・マイク選択・対象アプリ選択・録音のみトグル）は生きたまま**、という設計上の意図がコメントに明記されている
- `TitleBarStatus` は `recordingPhase`/`processing` の値によって最大5つの表示（録音中/一時停止中/文字起こし処理中/保存中/精度向上パス実行中＋進捗％/キャンセル中/録音のみアイドル表示）を排他的に切り替える、1スロット構成。現在は解析中止ボタンをここに置いていない（3.3節のトグルへ統合済み）
- `TitleBarControls` の `MicPicker`/`TargetAppPicker` は `recordingPhase !== "stopped"` で `disabled`、録音のみトグルは `locked || processing !== null` で `disabled`。サイドバー開閉トグルだけは意図的にロック対象外

### 3.6 `ModelLoadingOverlay.tsx`

`modelStatus` 1フィールドのみに依存する純粋関数。`"ready"`/`"idle"` で非表示、それ以外は `z-40` の全画面ブロッカー。ローカル state 無し。

### 3.7 `SettingsDialog.tsx` / `SettingsPanel.tsx`

- `SettingsDialog` は Radix `Dialog` を非制御のまま使用。開閉状態に対応するストアフィールドは存在しない
- `SettingsPanel` の全フォーム項目はストア直結（ローカル state 0）。ロックは `recordingPhase !== "stopped"` を再計算した `locked` による `pointer-events-none opacity-60`（CSS のみ、`disabled` 属性ではない）
- ストア側の `updateSettings`/`updateDiarizeSettings`/`updateVadSettings`/`updateAudioEventSettings`（`appStore.ts:893-919`）は**4つとも無条件の `set()`** — `recordingPhase` によるガードは一切無い。録音中に設定が変わらないことの担保は現状 `SettingsPanel` の CSS ロックのみに依存している

### 3.8 `LevelMeter.tsx`

`recordingPhase` 1フィールドのみを React state として購読し、実際の波形データは `useAppStore.getState().levelMeter?.getLevel()` を `requestAnimationFrame` ループの中で毎フレーム命令的に読む（2.4節）。

### 3.9 `RecordingTimeline.tsx`

`playback`/`audioEvents`/`recordingPhase` に依存。`!stopped || playback.recordingId == null` で `return null`。ロード中（`playback.loading`）は各トランスポートボタンに `disabled` 属性が付く（`SettingsPanel` と異なり本物の `disabled`）。Space/←/→ のキーボードショートカットは `loaded` の間だけ `window` に張られ、`loaded` が false になった瞬間にエフェクトのクリーンアップで確実に外れる。

### 3.10 「今画面に出ている録音」を切り替える3つの関数（`appStore.ts`）

3.1節のクラスタ1（`segments`/`audioEvents`/`viewedRecordingId`/`playback.recordingId`）を書き込む唯一の正規ルートとされている3関数:

- **`resetToBlankSession`**（離脱、`appStore.ts:299-312`）— `resetTimeline()` → `unloadPlayback()`（内部で `setState({playback: IDLE_PLAYBACK})`）→ `set({segments: [], ...})`。**2回の `setState`/`set` に分かれている**（`await` を挟まない限り React 18 の自動バッチングで1フレームにまとまるが、関数自体はアトミックではない）
- **`viewLoadedRecording`**（履歴を開く、`appStore.ts:327-339`）— `timeline.ts` の4値を書き換えた後、`set({segments: entry.segments, ..., viewedRecordingId: entry.id})` を1回。`playback` はここでは触らず、呼び出し元が別途 `loadPlayback` を呼ぶ前提
- **`markRecordingViewed`**（録音直後の確定、`appStore.ts:358-361`）— `playback.recordingId === id` の場合のみ `viewedRecordingId` を書く、というガード付き関数。ガードの理由はドキュメントコメントに明記: 呼び出し元（`refineRecording`/`finishRecordOnly` の `persistTake`）は `await` を挟んで**この関数を呼ぶ前に既に `loadPlayback` を呼んでいる**ため、その間に別の録音へブラウズが進んでいた場合に古い呼び出しが新しい選択を巻き戻さないようにするため

---

## 4. 状態遷移一覧

各アクションについて「ガード条件（いつ実行を止めるか）」「`set()` の回数と順序」「`await` の位置（＝そこで画面が中間状態のまま止まりうる区間）」を記す。全て `src/store/appStore.ts` および `src/store/recordingPipeline.ts` から直接読み取った内容。

### 4.1 `startRecording`（`appStore.ts:634-796`）

- **ガード**: `capabilitiesOf(get()).startRecording`（`idle && (recordOnly || modelStatus==="ready")`）を**関数冒頭で1回だけ**評価
- 冒頭同期部分: `viewedRecordingId !== null` なら `resetToBlankSession` を呼ぶ（**ここは `await` の前なので安全**）
- その後 **3段の `await`**: `capture.start()` → `appAudioClient.startCapture()`（対象アプリ指定時のみ）→ `startPcmRecording()`
- `recordingPhase` が `"recording"` になるのは、この3段の `await` が**全て終わった後の最後の1回の `set()`**（`appStore.ts:776`）のみ
- **この間、`recordingPhase` は `"stopped"` のまま、`processing` も変化しない** → ガード条件が実行中ずっと `true` のままになる。2回目のクリックがこの区間に入ると、ガードを素通りしてもう一つの `startRecording()` が並走を始める（5.1節）
- 失敗時は `catch` で `activeRecorder` 等のモジュール変数をクリアし、`set({recordingPhase: "stopped", errorMessage: ...})`

### 4.2 `pauseRecording`（`appStore.ts:798-820`）

- ガード: `capabilitiesOf(get()).pause`（`recordingPhase === "recording"`）
- `set({recordingPhase: "paused"})` は **`await` の前、同期的に**実行（正しいパターン）
- その後 `await streamer?.finish()` で表示用の flush（失敗しても握りつぶすのみ）

### 4.3 `resumeRecording`（`appStore.ts:822-829`）

- 完全に同期。`await` 無し。ガード: `recordingPhase === "paused"`

### 4.4 `stopRecording`（`appStore.ts:831-891`）

- ガード: モジュール変数 `activeRecorder`（`controller`）が非 `null` であること。この変数は**関数の最初に同期的に `null` へ落とす**ため、連打しても2回目は安全に無視される
- `await appAudioClient.stopCapture()`（対象アプリ音声を使っていた場合）の**後**に `set({recordingPhase: "stopped", processing: recordOnly ? "saving" : "transcribing", levelMeter: null})` を1回（3フィールドを1回の `set()` にまとめており、クラスタ2の規約に沿っている）
- 続けて `await controller.stop()` → `await streamer?.finish()` → `await eventStreamer?.finish()` → `capture` が無ければ `set({processing: null})`
- 最後に `capture` があれば `await finishRecordOnly(capture)` または `await refineRecording(capture)` に委譲（4.5/4.6節）

### 4.5 `refineRecording`（`recordingPipeline.ts:288-491`）

- `await capture.finish()` → `recordingId` 確定
- `void useAppStore.getState().loadPlayback(recordingId, path, baseSec)` — **fire-and-forget**。この呼び出しの同期部分だけが即座に走り、`playback.recordingId` がここで埋まる
- `set({processing: "refining", refineProgress: 0, processingRecordingId: recordingId})` を1回
- `await runAccuracyPipeline(...)` — 最も長い区間（文字起こし・話者分離・音響イベント検出、いずれも Tauri IPC）
- キャンセルされていれば `finishCancelledTake` へ、そうでなければ結果を `segments`/`audioEvents` に反映し `persistTake`（`await saveRecordingHistory` → `await refreshRecordingHistory` → `markRecordingViewed`）
- `finally` で `set({processing: null, refineProgress: null, processingRecordingId: null})`

### 4.6 `loadHistoryEntry`（`appStore.ts:466-484`）

- ガード: `capabilitiesOf(get()).browseHistory`（`recordingPhase === "stopped"`）を**関数冒頭で1回だけ**評価、**`await` の後に再チェックしない**
- `await loadRecording(id)`（履歴 JSON の読み込み、Tauri fs IPC）
- 解決後: `viewLoadedRecording(set, entry)` を同期的に実行（`segments`/`audioEvents`/`viewedRecordingId` と `timeline.ts` の4値をまとめて書き換え）
- `void get().loadPlayback(id, await wavPath(id))` — こちらも fire-and-forget
- ガードが一度しか効かないため、この関数の `await` 中に別の操作（別の履歴行クリック、録音開始）が割り込める（5.3節で3パターンのトレースを示す）

### 4.7 `deselectHistoryEntry` / `deleteHistoryEntry`（`appStore.ts:486-513`）

- `deselectHistoryEntry` は完全に同期、ガードのみで `resetToBlankSession` を呼ぶ
- `deleteHistoryEntry` は `await deleteRecording(id)` の後に `wasShown`（`viewedRecordingId === id || playback.recordingId === id`）を判定し、`recordingHistory` を更新する `set()` → 該当すれば `resetToBlankSession`。このコメント自体が、`refineRecording`/`finishRecordOnly` の `loadPlayback` と `markRecordingViewed` の間の非同期窓を明示的に警戒して書かれている

### 4.8 `rerunHistoryEntry`（`appStore.ts:515-602`）

- ガード: `capabilitiesOf(get()).reanalyze`（`idle`）を**関数冒頭で1回だけ**評価
- `await ensureModelReady()`（録音のみモードで初回はモデル読み込みそのもの、長時間になりうる）と `await wavPath(id)` の**両方が、`processing` を `"refining"` にセットする前に**実行される — この間もガードは再チェックされないため、別の `rerunHistoryEntry`/`refineRecording` がこの窓に割り込むと2つの精度向上パイプラインが並走しうる（5.4節）
- 結果が空なら履歴を上書きせず通知のみ。成功時は `saveRecordingHistory` → `refreshRecordingHistory` → （`viewedRecordingId === id` なら）画面の `segments`/`audioEvents` も更新
- `finally` で `processing`/`refineProgress`/`processingRecordingId` をまとめて `null` に戻す

### 4.9 `cancelAnalysis`（`appStore.ts:604-622`）

- ガード: `capabilitiesOf(get()).cancelAnalysis`（`processing === "refining"`、`"cancelling"` は除外）
- `set({processing: "cancelling", refineProgress: null})` を同期的に実行（**あえて `processing: null` にはしない** — 実際のパイプライン停止は 4.5/4.8 節の `finally` 任せ）
- `await asrClient.cancelAnalysis()` はバックエンドへの通知のみ。失敗しても `refineNotice` を出すだけでパイプラインはそのまま継続

---

## 5. 既知の不整合パターン一覧

ユーザー報告の2症状それぞれに対応する最有力候補を先に示し、続けて調査中に見つかった（ユーザーはまだ報告していない）同根の潜在バグを列挙する。全て今回のセッションでソースコードを直接開いて確認済み。

### 5.1 「録音ボタンを押してもすぐに録音中の画面に遷移しない」 → `startRecording` の設計

**該当**: `RecordButton.tsx:44-58`、`appStore.ts:634-796`（4.1節）

`recordingPhase === "stopped"` の間のボタン表示は、`startRecording` の非同期本体（`capture.start()` → `appAudioClient.startCapture()` → `startPcmRecording()` の3段 `await`、実機の権限確認やデバイスネゴシエーションを含みうる）が終わるまで**一切変化しない**。「開始中…」に相当する中間表示が存在しないため、ユーザーから見ると「押したのに何も起きていない」ように見える待ち時間が生じる。

さらに、`startRecording` 冒頭のガード（`appStore.ts:639`）は「2回目の呼び出しを防ぐため」という趣旨のコメント（`appStore.ts:635-638`）付きで書かれているにもかかわらず、実際にはこの3段 `await` の間 `recordingPhase`/`processing` のどちらも変化しないため、**ガード条件がこの区間ずっと `true` のまま**になる。連打された場合、2回目の `startRecording()` 呼び出しはガードを素通りし、`activeRecorder`/`activeStreamer`/`activeCapture` 等のモジュール変数（2.3節）を2つの並行した呼び出しが奪い合う形になる。最後に解決した方が勝ち残り、もう一方のマイクストリーム/キャプチャは静かに孤児化する。

対照的に `pauseRecording`（4.2節）は `set()` を `await` の前に置く安全なパターン、`stopRecording`（4.4節）はガード対象のモジュール変数を関数の最初に同期的に潰す安全なパターンになっており、**この3つの中で `startRecording` だけがどちらの安全策も採っていない**。

### 5.2 「状態遷移の際に一瞬ゴミ画面が見える」 → `App.tsx` の `idleEmpty` レース

**該当**: `App.tsx:66-74`（3.1節）、`recordingPipeline.ts:318,484-490`、`playback.ts:64-87`

`idleEmpty = !takeOpen && processing === null && segmentCount === 0 && playbackRecordingId == null` の4条件は、それぞれ別々の非同期経路から埋まる:

- `processing` が `null` に戻るのは `refineRecording`/`finishRecordOnly` の **`finally`**（精度向上パイプライン全体、または履歴保存の完了後）
- `playback.recordingId` が埋まるのは `void loadPlayback(...)` という**別の fire-and-forget 呼び出し**の中で、実体は `await wavToBlobUrl(path)`（Tauri fs IPC でのファイル読み込み）が絡む

この2つの非同期チェーンの間に、**互いを待ち合わせる仕組みは存在しない**。通常はファイル読み込みの方が精度向上パイプラインより速く終わるため実害が出にくいが、これは偶然の順序であって保証ではない。もし `loadPlayback` 側が何らかの理由で遅延・失敗（失敗時は `playback` が `IDLE_PLAYBACK` に戻る、`playback.ts:83-86`）し、かつ `segments` が空のまま（無音の録音・録音のみモードで文字起こしが無い等）だった場合、`processing` が先に `null` になった一瞬、4条件が全て揃って `idleEmpty` が `true` になり、**本来出ないはずのヒーロー画面（中央の大きな録音ボタン）が一瞬映り込む**。

`App.tsx` のコメント自体が「以前は `viewedRecordingId` を条件にしていて、それが原因のフラッシュがあった」ことを明記しており、現在の4条件はその**修正済みバージョン**である。しかし修正は特定の1レース（`viewedRecordingId` の確定タイミング）を塞いだだけで、`playback.recordingId` を巻き込む今回のレースは構造的に残っている。

**同じ症状のもう一つの原因候補**: `LevelMeter.tsx` の `requestAnimationFrame` ループ（2.4節）。`recordingPhase` が `"recording"` から変わった直後に、既にスケジュール済みだった最後の1フレーム分の `tick()` が発火し、`stopRecording` が `levelMeter.dispose()` した直後のオブジェクトに対して `.getLevel()` を呼ぶ可能性がある。バーが古い/不正な値のまま1フレームだけ描画される、という形で「ゴミ画面」の症状に合致しうる。

### 5.3 履歴操作中の競合（ユーザー未報告・同根の潜在バグ）

**該当**: `appStore.ts:466-484`（`loadHistoryEntry`、4.6節）

`loadHistoryEntry` のガードは関数冒頭で1回しか評価されない。以下3パターンで実際に不整合が生じることをコードトレースで確認した:

1. **履歴 A をクリック直後、精度向上パス実行中の録音 B が裏で走っている状態で別の履歴行を触る**: `refineRecording`（対象 B）の `await runAccuracyPipeline(...)` 実行中に履歴 A をクリックすると、`loadHistoryEntry(A)` が `browseHistory`（`recordingPhase === "stopped"` のみ、`processing` は見ない）を通過して実行される。`viewLoadedRecording` が `timeline.ts` の4値を A 用に書き換えた**後**で `runAccuracyPipeline` が解決すると、`refineRecording` はクロージャに閉じ込めていた B 用の `keptSegments`（`getSegmentsBeforeRecording()` の戻り値、既に A 用の値に上書きされている）を使って `segments` をスライスし直す — **A の文字起こしが B 用のオフセットで静かに壊れる**、最も深刻な実害を伴うケース
2. **同じ履歴行を素早く2回クリック**: `loadHistoryEntry` に再入防止ガードが無いため、`await loadRecording(id)` が2回独立に走る。データ自体は同じなので実害は小さいが、`segments`/`audioEvents` の配列参照が2回差し替わり、それをキーにした副作用が余分に走る
3. **履歴クリック直後に録音開始ボタンを押す**: `loadHistoryEntry(A)` の `await loadRecording(A)` が解決する前に `startRecording()` が完了すると、`startRecording` は `viewedRecordingId` がまだ `null`（`loadHistoryEntry` がまだ書き込んでいない）なので `resetToBlankSession` をスキップし、既存の `segments` を保持したまま録音を開始する。その後 `loadHistoryEntry(A)` の `await` が解決すると、**録音が実際に進行中（`recordingPhase === "recording"`）にもかかわらず** `viewedRecordingId` が `A` に、`segments` が A の保存済み内容に、`timeline.ts` の4値も A 基準に書き換わる — 「録音は生きている（マイクは動いている）のに画面は履歴 A を閲覧中」という直接的な矛盾状態になる

`rerunHistoryEntry`（4.8節）にも同型の窓がある: `await ensureModelReady()`/`await wavPath(id)` の間、`processing` はまだ `null` のままなので `capabilitiesOf(get()).reanalyze` のガードを別の呼び出しが素通りできる。

### 5.4 設定変更が録音中でもストア側では無条件に書き込める

**該当**: `SettingsPanel.tsx:91,105-109`、`appStore.ts:893-919`

`SettingsPanel` の録音中ロックは `pointer-events-none opacity-60` という CSS のみで、個々の `<Switch>`/`<Input>`/`<Textarea>` に `disabled` は付いていない。録音開始前からフォーカスが当たっていたフィールドは、ロック後もキーボード操作（Tab で移動済みの要素への Space/Enter、フォーカス済み `Textarea` への入力）で変更できてしまう。加えてストア側の `updateSettings`/`updateDiarizeSettings`/`updateVadSettings`/`updateAudioEventSettings` はいずれも `recordingPhase` を一切チェックしない無条件の `set()` であるため、**UI 側のロックが唯一の防御線**になっている。ストリーミング文字起こしは毎ウィンドウ `settings` を読み直す実装（`recordingPipeline.ts`）のため、これが実際に起きると「録音の前半と後半で異なる設定が使われる」という文字起こし精度上の実害に直結する。

### 5.5 その他の観測事項（軽微 / 参考情報）

- **`TitleBar.tsx` の `isMaximized`**: OS のウィンドウ状態を非同期イベント経由でミラーしており、クリックから実際のアイコン切り替えまで1往復分ラグがある。アプリの内部状態とは無関係
- **`useTranscriptScrollTracking.ts` の `autoScroll` 自己競合**: `stopped→recording` エッジでの強制リセットと、ネイティブ `scroll` イベントリスナーによる古い `scrollHeight` 読み取りが同一 tick 内で競合しうる。症状としては「新しい録音が始まったのに自動スクロール追従が効かない」という形で現れる可能性がある
- **`resetToBlankSession`/`persistTake` 等、規約上の「単一の遷移」が内部的には複数 `set()` に分かれているヘルパー**: 現状把握している呼び出し元は全て `await` を挟まず同期的にこれらへ到達しているため React 18 の自動バッチングで実害は出ていないが、将来新しい呼び出し元が `await` の後からこれらを呼ぶと、クラスタ内の一部フィールドだけが先に反映される1フレームが生まれうる（ストア自身のコメントが将来の実装者へ向けて警告している内容と一致）
- **`useConfirmClick.ts` の3秒タイムアウトはストアを一切見ない**: 現状の呼び出し元（`HistorySidebar`/`TranscriptToolbar`）はいずれもキー付けで安全を確保しているため実害は確認されていないが、フック自体には対象データが裏で変わったことを検知する仕組みが無い

---

## 6. 付録

### 6.1 状態フィールド早見表

| 場所 | 名前 | リアクティブ | 主な用途 |
|---|---|---|---|
| ストア | `recordingPhase`/`processing`/`modelStatus` | ○ | 3軸の一次状態 |
| ストア | `segments`/`audioEvents`/`viewedRecordingId`/`playback.recordingId` | ○ | 「今画面に何の録音が出ているか」クラスタ |
| ストア | `processingRecordingId`/`refineProgress` | ○ | 精度向上パスの対象と進捗 |
| `timeline.ts` | `segmentId`/`timelineBaseSec`/`recordingBaseSec`/`segmentsBeforeRecording` | **×** | セグメントのタイムライン計算 |
| `playback.ts` | `playbackController` | **×** | 再生中の `<audio>` ラッパー実体 |
| `appStore.ts` | `activeRecorder`/`activeStreamer`/`activeCapture`/`activeEventStreamer`/`appAudioActive`/`recordingPaused`/`recordingRecordOnly` | **×** | 録音中のマイク/キャプチャ配線 |
| 各コンポーネント | 2.4節参照 | ○（React state 部分のみ） | 表示専用の派生状態 |

### 6.2 関連ファイル一覧

- `src/store/appStore.ts` — Zustand ストア本体
- `src/store/capabilities.ts` — 状態→操作可否の純粋関数
- `src/store/recordingPipeline.ts` — 精度向上パイプライン（`refineRecording`/`finishRecordOnly`/`runAccuracyPipeline`）
- `src/store/timeline.ts` / `src/store/playback.ts` / `src/store/clients.ts`
- `src/App.tsx`
- `src/components/RecordButton.tsx` / `TranscriptPanel.tsx` / `TranscriptToolbar.tsx` / `HistorySidebar.tsx`
- `src/components/TitleBar.tsx` / `TitleBarStatus.tsx` / `TitleBarControls.tsx`
- `src/components/ModelLoadingOverlay.tsx` / `SettingsDialog.tsx` / `SettingsPanel.tsx`
- `src/components/LevelMeter.tsx` / `RecordingTimeline.tsx`
- `src/components/useConfirmClick.ts` / `useTranscriptScrollTracking.ts`
