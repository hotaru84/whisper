# WhisperScribe

録音した音声を完全オフラインで文字起こしする Windows デスクトップアプリ。Tauri (Rust) + React/TypeScript + [`whisper-rs`](https://github.com/tazz4843/whisper-rs)（[whisper.cpp](https://github.com/ggml-org/whisper.cpp) の Rust バインディング、`large-v3-turbo` モデル）で構成。文字起こし推論は Rust バックエンドで実行し、Vulkan 経由で GPU アクセラレーションする。

## 前提環境

- [Node.js](https://nodejs.org/)（v22 系で動作確認）
- [Rust](https://www.rust-lang.org/tools/install) と Cargo
- [CMake](https://cmake.org/download/)（`whisper-rs` が内部で whisper.cpp を CMake ビルドする）
- **LLVM** — `winget install LLVM.LLVM`。`whisper-rs-sys` の bindgen が `libclang` を必要とする。
  既定の `C:\Program Files\LLVM\bin` にあればビルドスクリプトが自動検出するので、環境変数の設定は不要。
- **Vulkan SDK** — `winget install KhronosGroup.VulkanSDK`。GPU 推論のビルドに必要。
  既定の `C:\VulkanSDK\<version>` にあればビルドスクリプトが自動検出するので、環境変数の設定は不要
  （別の場所に入れた場合のみ `VULKAN_SDK` を自分で設定する）。実行時に必要なのは GPU ドライバ同梱の
  `vulkan-1.dll` だけで、配布先に SDK は不要。
- Windows: WebView2 ランタイム（通常は Windows に同梱済み）
- Windows: Visual Studio Build Tools（「C++ によるデスクトップ開発」ワークロード）
  - リソースコンパイラ `rc.exe` が `PATH` に含まれていない環境がある。含まれていない場合、`tauri build`/`tauri dev` が
    `RC.EXE failed to compile specified resource file` で失敗する。その場合は Windows SDK の `bin\<version>\x64` ディレクトリ
    （例: `C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64`）をユーザー環境変数 `PATH` に追加する。

GPU が Vulkan に対応しているかは `vulkaninfo --summary` で確認できる（`Devices:` に GPU が出れば可）。

### ビルドは必ず npm スクリプト経由で

`npm run tauri ...` は [`scripts/win-build-env.bat`](scripts/win-build-env.bat) を経由してビルド環境を整えてから
Tauri CLI を呼ぶ。**`cargo build` を直接叩くと CMake の段階で失敗する。** ラッパーがやっているのは以下:

- `vswhere` で Visual Studio を検出し `vcvars64` を実行して `cl.exe` を `PATH` に載せる
- VS 同梱の **Ninja** を `PATH` に追加する（追加インストール不要）
- `LIBCLANG_PATH` の自動検出と、`VULKAN_SDK` の存在チェック

なぜこれが要るかというと、ggml は Vulkan シェーダーを生成する `vulkan-shaders-gen` を**入れ子の CMake
ExternalProject** としてビルドするが、非クロスコンパイル時はそこにコンパイラ設定を一切渡さない実装になっている
（`ggml/src/ggml-vulkan/CMakeLists.txt`）。そのため `cl.exe` が環境から見つかる必要があり、かつ Visual Studio
ジェネレータでは入れ子の configure が `No CMAKE_C_COMPILER could be found` で失敗するため Ninja が必須になる。

ビルド設定のうち宣言的に書けるもの（Ninja ジェネレータの指定、`MAX_PATH` 回避のための短いターゲット
ディレクトリ `C:/wsbuild`）は [`.cargo/config.toml`](.cargo/config.toml) にある。**リポジトリ直下に置くこと。**
Cargo は設定をマニフェストではなく*カレントディレクトリ*から上位に向かって探すため、`src-tauri/` 配下に置くと
リポジトリルートから実行したコマンドが黙って設定を読み飛ばす。

**特に `CMAKE_GENERATOR` の指定を外してはいけない。** 指定が無いと `cmake` クレートが whisper.cpp の
最適化フラグ（`/O2`）を消してしまい、推論が約8倍遅くなる（実測: エンコーダ 27秒 → 223秒）。詳細は当該ファイルのコメント参照。

## セットアップ

```powershell
npm install
```

### Whisper モデルファイルの配置（初回のみ）

モデルの GGUF ファイルはサイズが大きい（約 574MB）ためリポジトリには含めていない。初回ビルド前に
`src-tauri/resources/models/whisper-large-v3-turbo/model.gguf` として以下を配置する。

```powershell
$dest = "src-tauri/resources/models/whisper-large-v3-turbo"
New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" -OutFile "$dest/model.gguf"
```

- `q5_0` 量子化版（約574MB）を既定として使用する。fp16 に近い精度を保ちつつ CPU 推論速度とサイズのバランスが良い。
  より高精度な `q8_0`（約874MB）や無量子化の `f16`（約1.62GB）を試したい場合は、同じ Hugging Face リポジトリから
  該当ファイルをダウンロドし、同じパス（`model.gguf`）に配置し直せばよい（ランタイムでの切替はサポートしていない）。
- whisper.cpp は語彙・トークナイザーを GGUF ファイル自体に内包しているため、旧構成のような複数ファイル
  （tokenizer/config JSON、`onnx/` サブフォルダ）は不要。

## 開発

```powershell
npm run tauri dev
```

Vite の dev サーバー（`http://localhost:1420`）と Tauri ネイティブウィンドウが同時に起動する。文字起こし推論は
Rust バックエンド（Tauri コマンド）経由で行われるため、ブラウザで `http://localhost:1420` を直接開いた場合は
UI の確認はできるが文字起こし機能は動作しない（`invoke()`/`listen()` は Tauri ランタイム内でのみ有効）。

## ビルド

### ポータブル exe のみ（インストーラなし、動作確認に最適）

```powershell
npm run tauri build -- --no-bundle
```

`C:\wsbuild\release\whisper-scribe.exe` が生成される。`resources/` フォルダが同じ階層に必要なので、
配布する場合は exe と `resources/` フォルダをまとめてコピーする。

### インストーラ（NSIS）付きフルビルド

```powershell
npm run tauri build
```

`C:\wsbuild\release\bundle\nsis\` に生成される。モデル（q5_0、約574MB）を同梱するためインストーラサイズは
600〜650MB 程度になる。

`tauri.conf.json` の `bundle.targets` は `["nsis"]` に絞ってある。既定の `"all"` は MSI も作るため WiX
ツールセットのダウンロードが走るが、ここでは NSIS で用が足りる。日常的な動作確認には上の `--no-bundle` を使う。

## 用語集（固有名詞・専門用語のプリセット）

設定パネルの「用語集」に、聞き間違えられやすい語を「、」区切りで並べておくと、認識がその語に寄る。
whisper の `initial_prompt` として毎ウィンドウ渡している。設定は localStorage に保存され、再起動しても残る。

```
議事録、稟議書、与信管理、東京海上日動、リクルートホールディングス
```

制約を理解した上で使うこと。

- **約200文字まで。** `initial_prompt` の上限は `min(n_max_text_ctx, n_text_ctx / 2)` = このモデルでは **224トークン**。
  日本語は実測でほぼ1文字=1トークン（「議事録」3字=3トークン、「与信管理」4字=5トークン）。超えた分は**先頭から黙って捨てられる**
  ので、重要な語ほど後ろに置く。トークン数は `cargo run --release --example tokens -- "<文字列>"` で実測できる。
- **強制ではなく誘導。** 用語集に入れても必ず正しく認識されるわけではない。
- **まれに用語集の文字列がそのまま出力に混ざる**ことがある（プロンプトのエコー）。
- **温度フォールバックが 0.5 を超えると無視される**（`WHISPER_HISTORY_CONDITIONING_TEMP_CUTOFF`）。
  つまり認識が既に苦しい場面では効かなくなる。
- **ここに渡してよいのはユーザーが書いた固定テキストだけ。** モデルの出力を次のウィンドウへ戻す実装は一度試して撤回した
  （下記「やってはいけないこと」参照）。静的なテキストは自己増幅しないので安全だが、生成結果の差し戻しは別物。

効果の測定は CER ハーネスの `--prompt` / `--prompt-file` で A/B できる。

## 精度の測定

デコード設定やモデルを変えたときに、それが改善なのか改悪なのかを数値で判定するためのハーネスがある。

```powershell
scripts\win-build-env.bat cargo run --release --example cer
```

`src-tauri/fixtures/` に置いた `<name>.wav`（16kHz mono）と `<name>.txt`（正解の書き起こし）のペアを順に文字起こしし、
**CER（文字誤り率）** を表示する。日本語は単語境界が無く WER が意味を成さないため、文字単位の編集距離で測る。
フィクスチャの作り方は [`src-tauri/fixtures/README.md`](src-tauri/fixtures/README.md) を参照。

- **アプリと同じ設定で測る。** デコード設定は `asr::DecodeSettings` / `asr::build_full_params` に集約してあり、
  Tauri コマンドとハーネスが同じ関数を呼ぶ。ここが分岐すると測定値がアプリの実態を表さなくなる。
- **再ビルドせずに A/B できる。** `--beam` `--entropy-thold` `--suppress-nst` `--language` `--model` でその実行だけ
  設定を上書きできる。変更前後で実行して CER を比較する。
- **比較は一度に一項目だけ。** まとめて変えると寄与が分離できない。
- 既定では比較前に約物（、。「」等）を除去する。whisper の句読点は文体的なブレが大きく、そのままでは本体の
  誤りが埋もれるため。`--keep-punct` で残せる。`ー` や `々` は語の一部なので除去対象に含めていない。
- `--json <path>` で結果を保存でき、実行間の diff が取れる。
- CER は 100% で頭打ちにならない。幻覚で長い文が挿入されると、参照より誤りが多くなる。

CER の計算そのもの（正規化と編集距離）は `src-tauri/src/cer.rs` にありユニットテスト済み。`cargo test --lib` で走る。

**フィクスチャは自分で録音したものをそのまま使える。** アプリは録音中の音声をキャッシュディレクトリ配下の
`recordings/rec-YYYYMMDD-HHMMSS.wav` に 16kHz mono で保存している（上記「録音中の音声は WAV として…」参照）。
これを `src-tauri/fixtures/` にコピーし、同名の `.txt` に正解の書き起こしを書けばフィクスチャになる。WAV の
読み込みは本体・第2パス・ハーネスすべてが `src-tauri/src/wav.rs` を共有するので、測った値と本番の挙動が食い違わない。

## アーキテクチャ上の注意点

- **モデルは Rust バックエンドが直接ロードする。** `src-tauri/src/asr.rs` の `init_model` コマンドが
  Tauri の `resource_dir()` から GGUF ファイルパスを解決し、`whisper-rs`（`WhisperContext::new_with_params`）で
  ロードする。ロード完了/失敗は `asr:model-ready`/`asr:model-error` イベントとしてフロントエンドへ通知される
  （`src/lib/asr/client.ts` が `listen()` で受け取る）。フロントエンド側でモデルファイルのバイト列を扱う処理は
  不要になった。
- **録音は生PCMをストリーミングし、逐次文字起こしする。** マイク入力は `MediaRecorder`（WebM/Opus）ではなく
  `AudioContext({ sampleRate: 16000 })` + AudioWorklet（`public/pcm-capture-worklet.js`、`src/lib/audio/pcmRecorder.ts`）で
  16kHz mono の生 PCM として取り込む。録音全体をメモリに保持せず、フレームは `StreamingTranscriber`
  (`src/lib/asr/streaming.ts`) に流し込み、15秒たまるごとにウィンドウを文字起こしして「確定した部分だけコミット・
  末尾は次ウィンドウへ持ち越し（chunk-and-commit）」する。**ウィンドウ長はそのまま「最初の文字が出るまでの
  待ち時間」になる**（それ未満の録音は停止時にまとめて処理される）。Whisper は常に30秒分をエンコードし短い音声は
  無音でパディングするので、15秒でも30秒でも GPU コストは同じ約2秒。スループットだけなら30秒が効率的だが、
  録音開始から半分近く何も表示されないため15秒にしている。これにより長時間録音でもメモリはほぼ一定で、録音中に
  結果が逐次表示される。各ウィンドウの音声は JSON ではなく Tauri の生バイナリ IPC（`tauri::ipc::Request`）で
  Rust 側へ転送し、言語/タスク設定は HTTP ヘッダーで渡す（`transcribe_window` コマンド）。worklet は
  CSP `script-src 'self'` を満たすため `public/` から同一オリジンで配信する（`data:` へインライン化されると
  CSP に弾かれる）。
- **文字起こしはセグメントの配列で、録音のたびに追記される。** `appStore` の `segments` (`src/lib/transcript.ts` の
  `TranscriptSegment[]`) は開始→停止→開始で累積し、各セグメントは通しタイムライン上の `startOffsetSec` を持つ。
  リセットは UI の「新規」ボタン（`clearTranscript`）で行う。
- **録音は2パスで文字起こしする。逐次パスは「待たせないため」、停止後の第2パスは「精度のため」。**
  逐次パスの15秒ウィンドウは互いに独立してデコードされるため、ウィンドウ境界をまたぐ文はどちらの側でも
  文脈を欠いたまま推測される。録音が終われば急ぐ理由が無くなるので、**録音全体を1回の `full()` に渡す**
  （`asr::transcribe_recording`）。whisper.cpp が内部で30秒チャンクに割り、直前のチャンクのトークン列を次へ
  引き継ぐ（context conditioning）ため、逐次パスには原理的に持てない文脈が効く。結果は逐次パスのセグメントを
  差し替える形で反映され、進捗は `asr:refine-progress` イベントで届く。GPU で概ね30秒あたり2秒なので、
  1時間の会議で約4分。
  - **第2パスの間もユーザーは逐次パスの結果を読める。** 第2パスが失敗しても逐次パスの結果は保持し、
    `refineNotice` として理由だけを添える（`src/store/appStore.ts`）。既に手元にある文字起こしを、
    改善のために失うことがあってはならない。
- **録音中の音声は WAV としてディスクに追記する。** 16kHz f32 は1時間で約230MB あり、全体をメモリに置けない。
  `src/lib/asr/capture.ts` が5秒ぶんずつバッファして Rust 側 (`src-tauri/src/capture.rs`) へ生バイナリ IPC で送り、
  `wav::Writer` が16bit PCM で追記する。書き込みに失敗しても録音と逐次文字起こしは続行する（失うのは第2パスだけ）。
  - ヘッダのサイズ欄は **追記のたびに書き直す**ので、ファイルはどの瞬間でも再生可能な WAV になっている。
    クラッシュや電源断で録音を丸ごと失わないため。
  - 保存先はアプリのキャッシュディレクトリ配下 `recordings/rec-YYYYMMDD-HHMMSS.wav`。ファイル名はフロントエンドが
    生成する（Rust だけではローカル時刻を整形できないため）ので、Rust 側で `[A-Za-z0-9_-]` 以外を落として
    パス外への脱出を防いでいる。**自動削除はしない** ので、溜まったら手動で消すこと。
- **第2パスは無音区間のセグメントを音声側の根拠で落とす。** 逐次パスは無音ウィンドウを入口で弾けるが、
  第2パスは会議中の「間」を含む全体を1本で処理するため入口で塞げない。そこでデコード後に、各セグメントの
  区間（前後1秒の余裕込み）の RMS が `SILENCE_RMS` 未満ならそのセグメントを捨てる
  (`asr::drop_silent_segments`)。**判定材料はテキストではなく音声**なので、「はいはいはい」のような正当な発話を
  文面の見た目で消すことがない。前後1秒の余裕は whisper のタイムスタンプが粗いこと（Part 3 の DTW で改善予定）
  への保険。なお `no_speech_thold` は 0.6 / 0.3 / 0.1 のいずれでもこの幻覚を抑えられないことを実測で確認済み。
- **言語は既定で日本語。** whisper.cpp は `"auto"` 指定で真の言語自動検出をサポートする（設定パネルの
  「自動検出」）。既定言語は `src/store/appStore.ts` で ISO 639-1 コード `"ja"` に設定している。
- **精度のための設定。** デコードはビームサーチ（`beam_size` 5、whisper.cpp CLI と同じ既定）。温度が既定の 0.0 では
  greedy の `best_of` は効かず単なる argmax になるため、ここは明確な差になる。`suppress_nst` で「(音楽)」等の
  非音声トークンも抑制している。
- **無音のウィンドウはモデルに渡さない。** `StreamingTranscriber` は RMS が `SILENCE_RMS`（`src/lib/asr/diagnostics.ts`）
  を下回るウィンドウを文字起こしせず読み飛ばす。whisper に無音を渡すと定型句（「ご視聴ありがとうございました」）を
  でっち上げたり「なぜなぜなぜ…」のような反復ループに陥る。**特に録音停止時に頻発する** — 停止ボタンを押すまでの
  間が端数ウィンドウとして強制的に文字起こしされるため。出力側でテキストを見て弾く方法は「はいはいはい」のような
  正当な発話を消す危険があるので、入力側で塞いでいる。閾値は保守的に設定してあり、それでも幻覚が残る場合は
  `logPcmStats` が毎ウィンドウ出力する `rms=` を静かな区間で確認し、その直下まで上げること（当て推量で上げない）。
- **反復ループ対策に `entropy_thold` を 2.8 へ引き上げている（既定 2.4）。ただし短い反復には効かない。**
  判定が `result_len > 32 && entropy < entropy_thold`（whisper.cpp:7527）とトークン数で足切りされているため、
  「なぜ」×13 程度の短いループは**判定自体が実行されない**。短い反復は上記の無音ゲートで入口を塞ぐ方が確実。 Whisper は同じ語句を延々と出力し続ける
  degenerate loop に陥ることがある。移行前の transformers.js 実装は `no_repeat_ngram_size: 3` でこれを抑えていたが、
  whisper.cpp に同等のパラメータは無い。代わりに `result_len > 32 && entropy < entropy_thold` で高温度リトライへ
  フォールバックする仕組みがあるので、その閾値を上げている（実測で entropy 2.60 のループが既定値 2.4 を素通りした）。
- **やってはいけないこと: 確定済みテキストを `initial_prompt` として次ウィンドウに渡す。** 表記の一貫性という点では
  魅力的だが、生成結果を入力に戻す構造は反復ループを自己増幅させる。実際に試したところ同じ語句が繰り返し出力される
  不具合が再現したため撤去した。**ユーザーが書いた固定の用語集を渡すのは別物で、これは安全**（自己増幅しない）。
  `initial_prompt` そのものが危険なのではなく、モデルの出力を自分の入力に戻す閉ループが危険という区別。
- **推論は Vulkan で GPU 実行する。** `whisper-rs` の `vulkan` feature を有効にしている。これは連動して
  内部の `_gpu` feature を立て、`WhisperContextParameters::default()` の `use_gpu` を `true` にするため、
  コード側で GPU を明示する必要はない。CUDA/HIP ではなく Vulkan を選んだのは、ベンダーを問わず動くため
  （このマシンは Intel Arc 内蔵 GPU）。起動ログに `whisper_backend_init_gpu: using Vulkan0 backend` が出れば
  GPU で動いている。`no GPU found` なら CPU にフォールバックしている。
  実測（30秒ウィンドウあたりのエンコーダ処理時間、Core Ultra 7 155H + Intel Arc 内蔵 GPU）:

  | 構成 | 時間 |
  |---|---|
  | CPU・最適化フラグ欠落時 | 223 秒 |
  | CPU・最適化修正後 | 27 秒 |
  | **Vulkan GPU** | **約 2 秒** |

  30秒の音声を約2秒で処理できるため、録音しながらの逐次文字起こしが十分な余裕を持って成立する。
- **whisper.cpp / ggml のネイティブログは既定で抑制している。** 放っておくとモデル情報の羅列に加え、
  ウィンドウごとに `whisper_init_state:` が7行ずつ出て有用な情報が埋もれる。`whisper_rs::install_logging_hooks()`
  で `log`/`tracing` 側へ流しており、どちらのバックエンド feature も有効にしていないので実質破棄される。
  モデルのロードや GPU バックエンドの問題を調べるときは環境変数 `WHISPER_VERBOSE=1` を設定すると元に戻る。
- **WebView2 のキャッシュ破損に注意。** 開発中にプロセスを強制終了すると、WebView2 のディスクキャッシュに
  不完全なレスポンスが残り、後続の起動で予期しないエラーが再発することがある。発生した場合は
  `%LOCALAPPDATA%\com.hiroo.whisper-scribe\EBWebView` を削除してから再起動する。

## 推奨 IDE 設定

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
