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
ディレクトリ `C:/wsbuild`）は [`src-tauri/.cargo/config.toml`](src-tauri/.cargo/config.toml) にある。
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

`src-tauri/target/release/whisper-scribe.exe` が生成される。`resources/` フォルダが同じ階層に必要なので、
配布する場合は exe と `resources/` フォルダをまとめてコピーする。

### インストーラ（MSI / NSIS）付きフルビルド

```powershell
npm run tauri build
```

`src-tauri/target/release/bundle/msi/` と `src-tauri/target/release/bundle/nsis/` にそれぞれ生成される。
モデル（q5_0、約574MB）を同梱するためインストーラサイズは 600〜650MB 程度になる。

## アーキテクチャ上の注意点

- **モデルは Rust バックエンドが直接ロードする。** `src-tauri/src/asr.rs` の `init_model` コマンドが
  Tauri の `resource_dir()` から GGUF ファイルパスを解決し、`whisper-rs`（`WhisperContext::new_with_params`）で
  ロードする。ロード完了/失敗は `asr:model-ready`/`asr:model-error` イベントとしてフロントエンドへ通知される
  （`src/lib/asr/client.ts` が `listen()` で受け取る）。フロントエンド側でモデルファイルのバイト列を扱う処理は
  不要になった。
- **録音は生PCMをストリーミングし、逐次文字起こしする。** マイク入力は `MediaRecorder`（WebM/Opus）ではなく
  `AudioContext({ sampleRate: 16000 })` + AudioWorklet（`public/pcm-capture-worklet.js`、`src/lib/audio/pcmRecorder.ts`）で
  16kHz mono の生 PCM として取り込む。録音全体をメモリに保持せず、フレームは `StreamingTranscriber`
  (`src/lib/asr/streaming.ts`) に流し込み、30秒たまるごとにウィンドウを文字起こしして「確定した部分だけコミット・
  末尾は次ウィンドウへ持ち越し（chunk-and-commit）」する。ウィンドウ長が30秒なのは、Whisper が常に30秒分の
  コンテキストをエンコードし、短い音声は無音でパディングするため。25秒などにしても処理コストは30秒と同じで、
  モデルに渡せる情報だけが減る。これにより長時間録音でもメモリはほぼ一定で、録音中に
  結果が逐次表示される。各ウィンドウの音声は JSON ではなく Tauri の生バイナリ IPC（`tauri::ipc::Request`）で
  Rust 側へ転送し、言語/タスク設定は HTTP ヘッダーで渡す（`transcribe_window` コマンド）。worklet は
  CSP `script-src 'self'` を満たすため `public/` から同一オリジンで配信する（`data:` へインライン化されると
  CSP に弾かれる）。
- **文字起こしはセグメントの配列で、録音のたびに追記される。** `appStore` の `segments` (`src/lib/transcript.ts` の
  `TranscriptSegment[]`) は開始→停止→開始で累積し、各セグメントは通しタイムライン上の `startOffsetSec` を持つ。
  リセットは UI の「新規」ボタン（`clearTranscript`）で行う。
- **言語は既定で日本語。** whisper.cpp は `"auto"` 指定で真の言語自動検出をサポートする（設定パネルの
  「自動検出」）。既定言語は `src/store/appStore.ts` で ISO 639-1 コード `"ja"` に設定している。
- **精度のための設定。** デコードはビームサーチ（`beam_size` 5、whisper.cpp CLI と同じ既定）。温度が既定の 0.0 では
  greedy の `best_of` は効かず単なる argmax になるため、ここは明確な差になる。`suppress_nst` で「(音楽)」等の
  非音声トークンも抑制している。
- **反復ループ対策に `entropy_thold` を 2.8 へ引き上げている（既定 2.4）。** Whisper は同じ語句を延々と出力し続ける
  degenerate loop に陥ることがある。移行前の transformers.js 実装は `no_repeat_ngram_size: 3` でこれを抑えていたが、
  whisper.cpp に同等のパラメータは無い。代わりに `result_len > 32 && entropy < entropy_thold` で高温度リトライへ
  フォールバックする仕組みがあるので、その閾値を上げている（実測で entropy 2.60 のループが既定値 2.4 を素通りした）。
- **確定済みテキストを `initial_prompt` として次ウィンドウに渡してはいけない。** 表記の一貫性という点では魅力的だが、
  生成結果を入力に戻す構造は反復ループを自己増幅させる。実際に試したところ同じ語句が繰り返し出力される不具合が
  再現したため撤去した。
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
- **WebView2 のキャッシュ破損に注意。** 開発中にプロセスを強制終了すると、WebView2 のディスクキャッシュに
  不完全なレスポンスが残り、後続の起動で予期しないエラーが再発することがある。発生した場合は
  `%LOCALAPPDATA%\com.hiroo.whisper-scribe\EBWebView` を削除してから再起動する。

## 推奨 IDE 設定

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
