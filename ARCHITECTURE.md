# soma 架構與規劃

soma 是一個個人助理核心：它接收各種介面傳來的話，調派本地的 coding agent 去做事，等待期間不花 token，最後把結果整理成報告。

名字取自神經元的細胞體：它從樹突收集訊號、整合之後，再經軸突送出去。

狀態：M0 到 M3.5 的程式碼已在 main（2026-10-18），真模型、Telegram 手機端與 Google 帳號的驗收待憑證到位後再跑，見各 obw 任務卡的 Notes。本文件的外部事實查證於 2026-10-18，並經三份獨立複核（Pi 原始碼、cc-mobile 原始碼、外部文件）修正過引用。

出處縮寫：

- **Pi 的路徑** 指 [earendil-works/pi](https://github.com/earendil-works/pi) commit c268154 的 `packages/` 底下。`spec` 是 `durable/docs/spec.md`，`README` 是 `durable/README.md`。單寫 `types.ts`、`scheduler.ts` 時，分別指 `durable/src/types.ts` 和 `durable/src/harness/scheduler.ts`。
- **cc-mobile 的路徑** 指 `~/workspace/cc-mobile` commit d9f0690。

## 要解決的問題

1. **agent 給的訊息太原始。** cc-mobile 轉給手機的是 agent 自己說的話，使用者要的是跨工作整理過的報告。
2. **讓 agent 自己定時監控太貴。** 每一輪輪詢都是一次模型呼叫，還得一直保留一個 session。
3. **介面各自長大腦。** shikigami 有自己的大腦（`brain.rs`、`backend*.rs`、`tools.rs`、`memory.rs`），cc-mobile 沒有。再加上 Telegram，就會出現第三套。

## 整體形狀

```
           人類側介面                         agent 側介面
  ┌──────────────────────┐            ┌──────────────────────┐
  │ Telegram（程序內）     │            │ herdr（主力）          │
  │ cc-mobile（客戶端）    │──▶ soma ──▶│ ACP（之後）            │
  │ shikigami（客戶端）    │   核心      │ HTTP（之後）           │
  │ 終端機（開發用）        │            └──────────────────────┘
  └──────────────────────┘
```

- **核心是一個常駐程序。** 它以 [Pi Durable](https://earendil.com/posts/pi-durable/) 為 harness，用 SQLite 儲存。同一份儲存只能由一個程序擁有，這是約定而不是鎖（README:688）；chord 的 node 後端另有 `processLock`（`chord/src/manager.ts:82`）可以借用。
- **啟動順序。** 重啟後排程器不會自動恢復，要先呼叫 `harness.resume()`，否則背景任務和排隊中的輸入都不會動（`durable/src/harness/types.ts:716-720`）。接著事件橋做一次對帳：抓 herdr `agent.list` 和派工清單比對，補上核心停掉期間發生的狀態變化。M1 和 M2 的驗收都靠這一步。
- **所有介面共用一個根對話（`harness.root()`）。** 在 Telegram 交代的事，回到桌面問也接得上。每則輸入用 `entry.kind` 標記來源，例如 `chat.telegram`、`voice.shikigami`。模型看不到 `entry.kind`，只看得到 `content`（spec:2318-2320、README:427），所以來源若要讓模型知道，得寫進內容。
- **核心只產出一份回答，怎麼呈現由介面卡決定。** shikigami 念短版，Telegram 傳文字，cc-mobile 顯示完整報告。
- **回答怎麼分送。** 根對話共用，每個介面卡都看得到所有輪次。規則是：介面卡只送出由自己的 `requestId` 啟動的那一輪回答；報告經 `notice` 紀錄分送；其他輪次只當歷史。這條規則寫在介面卡裡，不寫在提示裡。

### 分層與依賴方向

採 ports and adapters（shikigami 已經是這個形狀）。目標只有一個：新接一種介面時，只新增一個介面卡模組，不改核心。

```
  人類側介面卡 ──▶ HumanPort ──▶ 核心（領域 + Pi Durable extension）──▶ AgentPort ◀── agent 側介面卡
  telegram/ cc-mobile-socket/ shikigami-socket/ terminal/          herdr/ cc-mobile-launch/ acp/ http/
```

- **核心只依賴兩個 port 的型別**，不 import 任何介面卡；介面卡只依賴 port，不互相 import，也不碰 Pi Durable 的型別。Pi Durable 的 `Conversation`、`Entry`、`Harness` 只出現在核心內部。
- **HumanPort** 就是「人類側契約」那三個動作：送出、訂閱、通知。核心暴露的是 soma 自己的事件型別（回答、失敗、通知、派工狀態、根對話這一輪是否在跑），不是 Pi 的 `watch()` 原始事件；程序內和程序外的介面卡拿到的是同一套型別，差別只在中間多一條 socket。
- **AgentPort** 就是「agent 側契約」那六個動作，狀態用 OSC 7501 的詞彙。「呼叫 cc-mobile `/api/launch`」是其中一個實作，和未來直連 herdr 或 ACP 的實作可以互換。
- **領域物件在核心**：派工清單、工作狀態機、報告。它們是純 TypeScript，不知道 Pi Durable 的存在；Pi Durable extension 是把它們掛進 harness 的那一層。
- **測試縫**：M1 的 `kill -9` 驗收用真 herdr；其餘單元測試用記憶體內的假 AgentPort 和假 HumanPort，不碰 socket。

不做的是通用的外掛框架：沒有介面卡註冊表、沒有動態載入、沒有為尚不存在的介面預留的設定格式。port 是兩個 TypeScript interface，介面卡是直接 import 進 `main.ts` 組裝的模組。

### 兩種互動不能混在一起

- **跟助理對話**：派工、問進度、看報告。這部分由 soma 負責。
- **直接操作某個工作 agent**：鏡像 session、按權限提示。這部分維持 cc-mobile 現有的 herdr 直通，不經過 soma 的 LLM。否則按一下核准也要先跑一輪模型推理。

## 核心的組成

用 Pi Durable 的元件來對應，每個元件都是一個 extension。

| 元件 | Pi Durable 機制 | 說明 |
|---|---|---|
| 派工清單 | document（對話層級） | 記錄每件工作的卡片、agent 名稱、session id 和狀態，和對話紀錄在同一筆提交裡更新 |
| 派工工具 | tool，`replay: "safe"` | agent 名稱取卡片名，啟動前先查派工清單和同名 agent 是否存在，崩潰後重跑也不會重複啟動；詳見「派工的冪等」 |
| 查詢與讀取工具 | tool，`replay: "safe"` | 列出 agent、讀對話紀錄 |
| 回應工具 | tool，不可重跑 | `respond` 回答卡住的 agent，`escalate` 轉給人；兩者都把判斷和理由寫進派工清單。崩潰中斷時會告知模型，不會自動重送（spec:2944、3393-3397） |
| 事件橋 | 主機端程式碼，不是 LLM | 見下節 |
| 排程 | tool + 背景任務 | `schedule(at, instruction)` 建一個睡到 `at` 的背景任務，時間到送一則 input（`requestId: schedule:<id>`）；定時彙報是它的一個固定實例。見「定時彙報」 |
| 記憶 | section + document + tool | 移植 shikigami 的設計，見下節 |
| 外部工具 | pi-mcp 轉接層 | email、行事曆等能力以 MCP server 接入，核心不為任何一種服務寫專用碼。見「助理基本能力」 |

### 事件橋：監控不花 token

事件橋放在 harness 外面，訂閱 herdr 的事件，用規則決定怎麼處理，不呼叫模型：

| 事件 | 處理方式 | 叫醒模型嗎 |
|---|---|---|
| agent 卡住（blocked） | 送一則 `input` 進根對話，`requestId` 為 `herdr:<agent>:<state_change_seq>` | 會。模型自行判斷要代答還是轉給人。`kind=auth` 例外：不叫醒模型，事件橋在提交 seq 的同一筆 commit 裡寫一筆 `notice`（question）給人，並記一筆 escalated 判斷。每次判斷連同理由寫進派工清單，彙報時一併列出，讓人事後能檢查它的判斷 |
| agent 做完（進入 idle 或 done） | 用 `conversation.commit` 寫進派工清單並追加紀錄 | 不會 |
| 使用者主動詢問 | 由介面卡送出 `input` | 會 |

事件橋和 harness 在同一個程序裡，只是不在 LLM 迴圈裡；它需要直接呼叫 `conversation.commit`。

已查證的依據：

- **`write` 和 `commit` 都不會啟動一輪推理。** 出處是 pi `packages/durable` 的規格 spec:2343-2355 與 README:421。例外是對話閒置、收件匣卻還有排隊項目、而且這筆 write 不是純顯示用時，才會補跑一輪（spec:2363-2367）。
- **`requestId` 在整個對話範圍內去重**（spec:2358）。根對話共用，所以每個來源要有自己的前綴：`herdr:<agent>:<seq>`、`telegram:<msgid>`、`digest:<until>`。
- **光靠 herdr 的事件流不可靠。** cc-mobile 另外用 `session.snapshot` 補洞，靠 `state_change_seq` 判斷狀態是否真的變過。計時器每秒一拍，但 snapshot 的頻率依聽眾分級，每 1、3、5 或 30 拍一次（`server/herdr/pane-events.ts:77, 94-98, 436-458`）。事件橋要照做。所以監控不花 token 是靠程式輪詢，而不是單靠事件推送。
- **派工的第一則提示由事件橋送出，不在 `agent.start` 之後立刻送。** 2026-10-18 對 herdr 0.9.5 實測：`agent.start` 剛回應時 `agent.prompt` 回 `agent_not_ready`；把提示放進 claude 的啟動參數，herdr 以 `invalid_agent_argument` 拒絕；新 repo 的 claude 先停在資料夾信任對話框（herdr 回報 blocked）。所以派工工具只把提示（cc-mobile `server/launch-prompt.ts` 的規則加卡片內容）存進該筆工作，事件橋第一次看到 agent 進入 idle 時才送出。看到 working 或 done 就丟掉沒送的提示，因為那表示已經有人給了它工作，這也避免崩潰重啟後重送。
- **每次觀察都先比對 `state_change_seq`。** 派工清單記下每筆工作最後處理過的 seq；同一個 seq 再來（重複的 snapshot、重啟後的對帳）就什麼都不做。叫醒模型的 input 在提交 seq 之前送出，崩潰在兩者之間時，重啟會以同一個 `requestId` 再送一次，被去重。

### 派工的冪等

派工走 herdr 介面卡（待決事項 1 的決定），agent 名稱就是卡片名。2026-10-18 對 herdr 0.9.5 實測：`agent.start` 一回應，`agent.list` 就列出這個名稱（`launch_pending: true`）；同名的第二次 `agent.start` 會被 herdr 以 `agent_name_taken` 拒絕。因此：

- session id 由派工工具先用 `api.memo` 存下再交給 `agent.start`，因為 claude 回報 `agent_session` 之前，herdr 讀不到它。
- 重跑時先查派工清單有沒有這張卡，再查 `agent.list` 有沒有同名 agent。兩處都沒有才啟動。
- 派工清單在工具結果之前另用一筆 `api.commit` 寫入；工具結果的提交由 harness 負責，無法合併。殘餘的空窗是「`agent.start` 已回應、派工清單還沒寫」，重跑會在 `agent.list` 找到同名 agent 而不重啟。`npm run smoke:dispatch` 就打在這個空窗。
- 「`worktree.create` 之後、`agent.start` 之前」崩潰，重跑時改用 `worktree.open` 開回同一個 worktree。

### 定時彙報

用一個背景任務實作，以 `tx.createTask(T, input, { ownership: { kind: "conversation" }, background: true })` 建立。它每十分鐘醒一次，先讀派工清單：自上次彙報以來沒有新完成的工作，就只推進 checkpoint、不叫醒模型；有，才送一則 input 請模型寫一份短報告。所以做完的工作最晚十分鐘內會被回報，而模型只在有東西可報時才被叫醒。

- **`sleep(until)` 本身不會被儲存。** 它只是記憶體裡的計時器。等待之所以能撐過重啟，是因為 `until` 寫在 checkpoint 裡：重開後任務回到 pending，phase 重跑，時間已過就立刻返回（types.ts:240、scheduler.ts:1816-1827、spec:1930）。
- **每輪都必須推進 checkpoint，否則任務會被判定故障**（spec:1919-1921）。同一個 phase 內只要 checkpoint 內容有變就算推進，所以單一個 `tick` phase 每輪把 `next` 往後推、計數加一就夠了，不必拆成兩個 phase（`durable/test/examples/13-recovery.ts:21-47` 就是這樣寫）。
- **時間到才叫醒模型。** 任務送一則 input 到根對話（`runtime.conversation(id).submit`），帶 `requestId: "digest:<until>"`，否則在送出和 checkpoint 之間崩潰會送兩次。背景任務可以對閒置中的自家對話啟動一輪，範例在 `durable/test/examples/23-subagent-background.ts:108-116`。模型讀派工清單裡這段時間做完的工作，寫成一份報告。
- **「新完成」以事件橋的完成紀錄為準。** 任務讀根對話裡 `soma.dispatch.done` 紀錄，checkpoint 存最後一筆已報過的紀錄 id。不用派工清單的 `seq` 判斷，因為 done 轉 idle 的收尾也會換新 seq，會重報。
- **送出前先釘住範圍。** 送 input 之前，先把這次涵蓋到哪一筆紀錄寫進 checkpoint。否則崩潰後重跑時，中間新完成的工作會被算進範圍，但重送被去重，報告裡沒有它，它就漏報了。
- **報告和下一個 checkpoint 同一個 commit。** 任務等這一輪答完，把回答寫成 `notice` 紀錄，和推進的 checkpoint 一起提交，所以崩潰在哪裡都只會有一份通知。模型這一輪失敗時（例如沒有 API key），通知改放原始的工作清單，這段時間的工作不會因此沒人看到。
- **沒有內建的 cron。** `sleep(until)` 是唯一的計時原語（types.ts:240）。

一天叫醒模型的次數約為「卡住次數 + 有新完成工作的十分鐘區間數 + 使用者主動詢問次數」，和工作跑多久無關。每次叫醒是一輪（run），一輪內會有多次模型請求，因為工具呼叫會多繞幾回（spec:2335-2338）。

### 報告的資料來源

報告讀工作 agent 的對話紀錄，不抓終端機畫面。

- **找得到紀錄檔。** 派工時以 `--session-id <uuid>` 啟動 claude，紀錄檔位置就是 `~/.claude/projects/<cwd 非英數字元換成 '-'>/<uuid>.jsonl`（cc-mobile `server/transcript/path.ts:56-58`）。編碼路徑沒命中時，`path.ts:90-101` 會掃整個 projects 目錄找。
- **讀取邏輯可以沿用。** cc-mobile 的 `server/transcript/reader.ts` 以位元組偏移量增量讀取；`records.ts:96-123` 只留下 user 和 assistant 兩種紀錄。
- **要自己寫「取出最終回答」。** cc-mobile 沒有這個函式（未全庫搜尋確認）。做法是取 agent 做完後的最後一則助理訊息。cc-mobile 的派工提示（`server/launch-prompt.ts`）要求回覆第一行寫「結果：完成／需要你／失敗」，soma 可以直接解析這一行來分類。

### 助理基本能力

soma 除了調派 agent，本身也要有助理的基本能力：讀 email、看行事曆、記憶、在指定時間處理工作。原則是不為任何一種能力在核心寫專用碼：

- **排程。** 「指定時間處理工作」和定時彙報用同一個機制：模型呼叫 `schedule` 工具，核心建一個背景任務睡到指定時間，到時把指令當成一則 input 送回根對話。等待期間不佔 session、不花 token；週期任務靠每輪推進 checkpoint。排程清單存在 document 裡，模型可以列出和取消。
- **email 與行事曆。** 經 pi-mcp 轉接層接 MCP server，soma 只負責把 MCP 工具掛進 harness。Gmail 與 Google Calendar 用 workspace-mcp，憑證放在 repo 外的 `~/.config/soma/`（待決事項 5 的決定）。對模型來說，這些和派工工具一樣都是工具，差別只在它們不可重跑（寄信不能 replay）。
- **記憶。** 見下節。因為報告和排程都會用到，記憶要提前到 M2。

### 記憶：移植 shikigami 的設計

照 shikigami `ARCHITECTURE.md`「Persistent state」一節的規則，用 Pi Durable 的元件重做：

- **策展層** 對應一個 section，每次請求前渲染進系統提示。信任程度逐行決定：使用者寫的行直接信任；模型寫的行要加稽核前綴，並放在圍欄內，標成未確認。超過預算就拒絕寫入，不截斷任何內容。
- **策展層可以修訂。** 這是行為層，soma 可以直接改（2026-10-18 使用者的決定）；要改程式碼時則開 obw 卡派進 fleet，soma 自己不能合併。每一行有一個由計數器發的編號，渲染成 `[#編號]`，刪掉的編號不會重發。模型用 `revise_memory` 改寫、`forget_memory` 刪除、`restore_memory` 還原成 `memory_history` 列出的任一版。規則如下：
  - 每次修訂都要附理由和至少一個證據 id，否則拒絕，拒絕原因當工具結果回給模型。只檢查格式，不檢查證據是否存在，因為 Pi Durable 沒有依 id 讀 submission 的 API。
  - 修改前的原文、修訂時間、理由和證據存在同一份文件的 `history` 裡，和改動同一個 commit。歷史不進系統提示，也不算進容量上限；容量上限只算現存的行。
  - 模型改寫過的行一律算模型寫的，即使原文是使用者寫的，所以會加稽核前綴並放進圍欄。還原則照存下來的原樣放回，使用者的原文還原後仍算使用者的。
  - 每次修訂都在同一個 commit 寫一筆 `data.kind: "report"` 的 `notice` 給人，內容寫明改了哪一條、改前改後、理由和證據。不併進十分鐘彙報，因為改錯的記憶從下一輪起就會影響回答，人應該立刻看到。
- **證據 id。** 自我檢視工具回傳的每一筆和記憶修訂引用的證據用同一種格式：`entry:<EntryId>`、`submission:<SubmissionId>`、`task:<TaskId>`，或 `document:<DocumentId>@<Seq>` 表示某份文件在某個 commit 的那一版（Pi Durable 沒有獨立的文件修訂紀錄，一版由文件 id 和 commit 序號決定），或 `decision:<卡片>#<序號>` 表示派工清單裡某張卡的第幾個代答或轉人決定（從 0 起算）。派工清單是 `history: "latest"`，舊版本讀不回來，所以決定不能用 `document:` 引用；決定只會追加，序號不會變。數字都是 Pi Durable 的 id（`durable/src/types.ts:27-36`）。檢查用的正規式是 `src/core/domain/memory.ts` 的 `EVIDENCE_ID`。
- **事實層** 對應一份 document，由程式寫入，不經模型萃取。
- **`recall`** 是一個搜尋舊對話紀錄的工具，不呼叫就不花成本。
- **`inspect`** 讓模型唯讀查自己的執行軌跡：失敗的輪次、每輪 token 與成本、代答與轉人、每張派工卡的最後狀態，回傳的每一筆都帶可引用的 id，超過筆數上限只回最新的幾筆並註明總數。
  - pi-durable 1.3.0 的 `Tx` 和 `Session` 都不能掃 submission，所以這個工具拿 Harness 自己的 `Storage` 來掃，而且只在 `api.commit` 的回呼裡掃：回呼占住 Session 的提交線，讀不到提交到一半的狀態，和 `Tx` 的讀取一樣。
  - 派工清單是 `history: "latest"`，舊版本無法經公開 API 讀回，所以代答與轉人的 id 是「卡片#序號」。決定只會追加，序號不會變。

## 兩份契約

### 人類側（介面卡 → 核心）

- **送出**：`submit({ type: "input", content, entry: { kind: "<來源>", data }, requestId })`。`requestId` 用該平台的訊息 id，重送也只會處理一次。終端機沒有訊息 id，用 `terminal:<毫秒時間戳>`：`requestId` 在整個對話內去重，重啟後從 1 重新計數會把新輸入當成重送吞掉。
- **訂閱**：程序內的介面卡經 `src/core/human-port.ts` 的 HumanPort 訂閱，它把 `watchEvents()` 和派工清單的 `watchDoc()` 轉成 soma 的事件型別；派工狀態取自派工清單，所以誰寫進清單，介面卡就看得到。程序外的客戶端改經客戶端 socket 連入。
- **通知**：核心要主動找人時（卡住或報告寫好），寫一筆帶 `kind: "notice"` 的紀錄，`data.kind` 是 `question`（卡住要人回答）或 `report`（報告寫好），各介面卡自己決定要不要推播。由 `schedule:` 開頭的 `requestId` 啟動的那一輪回答，介面卡也當成通知推給人。`digest:` 那一輪不推，因為彙報任務會把它的回答寫成 `data.kind: "report"` 的 `notice` 紀錄，再推一次就重複了。
- **失敗**：一輪的 input 在 Pi Durable 裡結束成 `unanswered`（`model_error`、`no_model`、`aborted`、`faulted` 或孤兒化的原因，見 durable spec 8.3）時，HumanPort 發 `failure` 事件，帶 `requestId` 和人看得懂的原因，`model_error` 附上供應商的錯誤文字。介面卡把自己那一輪的失敗當回答送回；`schedule:` 和 `herdr:` 開頭（`src/ports/human.ts` 的 `PUSHED_FAILURES`）是核心自己發起的輪次，沒有人在等，所以每個介面卡都把它們的失敗當通知推給人。`digest:` 那一輪的失敗不推，因為彙報任務已經把失敗原因和原始工作清單寫成通知。終端機的 7501 根紀錄在失敗後報 `error`，直到人再輸入。事件快照不含 submission，所以重啟後不會再發一次已經發過的失敗。
- **Telegram 只認一個聊天室。** bot token 和聊天室 id 都設了才啟動（見「設定」），其他聊天室的訊息一律丟掉，因為找到這個 bot 的任何人都能派 agent 在這台機器上跑。訊息 id 只在同一聊天室內唯一，所以只認一個聊天室也讓 `telegram:<message id>` 不會撞號。介面卡以 `telegram:` 前綴認自己的輪次，不記送過哪些 id，所以核心在重啟後才答完的那一輪仍會送回手機。

客戶端 socket 的現況：

- **Pi Durable 沒有任何伺服器、傳輸層或 RPC。** `durable/src` 裡沒有任何伺服器程式碼；規格只說「Transport backpressure and disconnect policy belong to the consumer」（spec:4773）。
- **Chord 有相關的積木。** 伺服端 `acceptWebSockets`（`chord/src/websocket.ts:18`）要自備 ws server 和一個 principal 驗證器（`websocket.ts:5, 14`）；客戶端 `webSocketLink` 在 `chord/src/link.ts:414`，狀態變更用 `@earendil-works/chord/delta` 套用。
- **遠端送訊息要自己寫。** 需要一個包住 `Conversation.submit` 的方法。

### agent 側（核心 → agent 介面卡）

每種 agent 介面卡實作同一組動作：

| 動作 | herdr 的實作（出處皆為 cc-mobile commit d9f0690） |
|---|---|
| 開始 | `workspace.create` → 等 shell 就緒 → `agent.start{name,kind,pane_id,args}`，args 帶 `--session-id` → 輪詢 `agent.get` 直到 `interactive_ready`（`server/herdr/registry.ts:140-215`） |
| 送出提示 | 確認狀態是 idle 或 done 且輸入框為空（`send-routing.ts:62`） → `pane.send_text` → `pane.send_keys Enter` → 可選的確認啟動，沒動就補按 Enter（`server/herdr/send-routing.ts:207-266`，只有 `/api/launch` 打開這個選項） |
| 狀態事件 | 原生狀態有 idle、working、blocked、done、unknown；前四種對應成 idle、running、requires_action，unknown 直接丟棄（`server/herdr/agent-state.ts:20-30`）。soma 內部改用 OSC 7501 的詞彙，見下節 |
| 讀結果 | 讀對話紀錄（見上一節） |
| 回應卡住 | `pane.read source:detection` 解析提示（`native-permission.ts:172`） → 比對指紋 → 送出前再讀一次畫面比對 → `pane.send_keys`（`server/herdr/permission/native-permission.ts:334-440`）。soma 在 blocked 時讀畫面補上 `kind` 和指紋，指紋隨叫醒模型的 input 交給模型，模型回答時帶回來比對 |
| 停止 | `workspace.close`（`server/herdr/backend.ts:477`、`registry.ts:252`） |

soma 和 cc-mobile 都把工作派進同一個 herdr 機庫 session。機庫名稱來自 `ecosystem.config.cjs:48` 的環境變數，目前是 `fleet`，程式裡沒有預設值（`server/config.ts:131-138`）。並發上限的算法是效能核心數減 2、最少 1，讀不到核心數時預設 4，可用 `CC_MOBILE_HANGAR_CAP` 覆寫（`server/hangar-cap.ts:1, 52`）。cc-mobile 的佔用數取自機庫裡實際在跑的 agent 數（`server/sided-backend.ts:168-171`），所以 soma 直接派進機庫的 agent 也會被它算到；反過來 soma 若自己派工，也要用同樣的算法。

herdr 的連線方式不是 JSON-RPC 2.0。每次呼叫開一條新的 unix socket 連線，送出 `{id,method,params}` 加換行；目前釘住的協定版本是 22（`server/herdr/transport.ts`、`client.ts:64`；herdr 0.9.5 的 `src/protocol/wire.rs:20` 也是 22）。

### agent 狀態模型：採用 OSC 7501 的詞彙

[OSC 7501（Program Status Protocol）](https://www.superlogical.com/rex/docs/build/program-status)是一個終端機跳脫序列，讓程式自己回報 `idle`、`working`、`blocked`（`kind` 為 `permission`、`question`、`auth`）、`done`、`error`，可帶 base64 的 `msg`，並能用 `id` 回報多筆階層式紀錄。背景見 [Mitchell Hashimoto 的文章](https://mitchellh.com/writing/program-status-osc7501)。

soma 要支援它，分成兩邊：

- **內部狀態模型直接用 7501 的詞彙。** herdr 的 idle／working／blocked／done 對應過來，`blocked` 的 `kind` 由權限解析補上，cc-mobile 的 idle／running／requires_action 不再沿用。這樣 herdr 對應和未來的 7501 來源餵進同一個形狀，事件橋的「`kind=auth` 一律轉人」規則也直接寫在 `kind` 上。
- **發送：soma 的終端機客戶端回報自己的狀態。** 根紀錄是 soma 本身（有一輪在跑是 `working`，助理要問人是 `blocked:kind=question`，報告寫好是 `done`），每件派出去的工作一筆子紀錄 `id=job/<task>`。Pi 的 emitter 可以直接沿用（`tui/src/program-status.ts`，53 行，只支援根紀錄，要補 `id` 和 `title`），Pi 自己的狀態對應表在 `coding-agent/docs/terminal-setup.md:221-233`。這是 M1 的一部分，成本約一打行。
- **接收：pty 是 herdr 的，soma 不自己讀。** 7501 要到 soma，得等 herdr 把它當成狀態來源。herdr 0.9.5 的文件和 release notes 都沒提 7501；對應的提案 [herdrdev/herdr#5069](https://github.com/herdrdev/herdr/issues/5069) 於 2026-10-08 被關掉並導向 discussions。Claude Code 2.1.295 起會送 7501，但只在終端機先回應探測時才送（[anthropics/claude-code#103022](https://github.com/anthropics/claude-code/issues/103022) 在要求一個不用探測的開關）。因此「在 herdr 裡的 Claude Code 目前不會送 7501」是推論，未實測。如果之後 soma 自己用 pty 跑 agent（ACP 路線），就要在那一層回應探測並解析 7501。

ACP 是第二種 agent 介面，等有具體需求才做。依據 [agentclientprotocol.com](https://agentclientprotocol.com) 的文件：

- **stdio 是唯一的穩定連線方式**，由客戶端把 agent 當子程序啟動。客戶端死掉時 agent 會怎樣，規格沒寫。
- **斷線後能否接回要看 agent 有沒有實作。** `session/load` 和 `session/resume` 都是選配功能。
- **權限請求是結構化的**（`session/request_permission`），比 herdr 解析螢幕畫面乾淨。
- **穩定版沒有 blocked 狀態**，要到 v2 草案的 `requires_action` 才有。
- **Claude 要透過介面卡** `@agentclientprotocol/claude-agent-acp`（0.93.0），它包的是 Claude Agent SDK，不是 Claude Code CLI 本體（[agents 清單](https://agentclientprotocol.com/get-started/agents)）；Gemini CLI 以 `--acp` 原生支援。SDK 是 `@agentclientprotocol/sdk` 1.9.0。

結論：herdr 是主力，因為核心重啟時 agent 仍由 herdr 託管，人也能隨時切進 pane 親手接手。ACP 適合核心自己開、跑完就收的短工作。

## 可以沿用的現有程式碼

cc-mobile `server/` 裡有 2,971 行（含註解與空行）只在清單內互相匯入，外部依賴只有 zod 和 node 內建模組。這些模組有注入縫，但預設實作會直接讀寫檔案和 socket，不算純函式：

- **herdr**（`server/herdr/`）：`transport.ts`、`client.ts`、`subscribe.ts`、`schema.ts`、`errors.ts`、`sides.ts`、`agent-state.ts`、`readiness.ts`、`prompt-box.ts`。
- **權限解析**（`server/herdr/permission/`）：`prompt-parse.ts`、`claude-question.ts`、`omp-prompt.ts`。
- **對話紀錄**（`server/transcript/`）：`path.ts`、`reader.ts`、`records.ts`、`epoch.ts`。以上 16 檔共 2,679 行。
- **派工**（`server/` 根目錄）：`hangar-cap.ts`、`launch-queue.ts`、`launch-binding.ts`，共 292 行。

這些檔案用到三個 Bun 專屬 API，改用 Node 時都要換：`transport.ts:47` 的 `Bun.connect`（經注入縫傳入）、`reader.ts:53, 62` 的 `Bun.file`、`hangar-cap.ts:52` 的 `Bun.spawnSync`。沒有用到 `bun:sqlite` 或 `Bun.serve`。

`pane-events.ts`、`delivery.ts`、`native-permission.ts` 把結果直接寫成手機協定的訊息格式，抽出來時要改成一般回呼。`launch.ts`、`ws.ts`、`protocol.ts` 和 cc-mobile 緊密耦合，不沿用。

## 外部依賴

- **Pi 套件。** `@earendil-works/pi-durable`、`pi-ai`、`chord`、`pi-mcp` 目前都是 1.3.0，要求 Node >=22.19.0。pi-durable README 第 3 行寫明「Experimental. The API changes without notice between releases.」，版本要釘死。
- **Bun 沒有現成的儲存介面卡。** README:688 說核心可以在 Bun 上跑，但要自備 `SqliteDatabase` facade。這個抽象層定義在 chord（`chord/src/sqlite/database.ts:2-38`），共六個非同步方法：`exec`、`run`、`get`、`all`、`transaction`、`close`。Node 版 `chord/src/sqlite/node.ts` 有 201 行，`bun:sqlite` 版的行數未驗證。conformance suite 是 `registerStorageConformance`，從 `@earendil-works/pi-durable/testing` 匯出，但它只測儲存層，不測整個 harness 在 Bun 上跑。
- **模型供應商。** pi-ai 支援 Anthropic API key，也支援 Claude Pro/Max 訂閱的 OAuth（`ai/src/providers/anthropic.ts:19-90`）。走 OAuth 時它會偽裝成 Claude Code：送出 `user-agent: claude-cli/...` 和 `x-app: cli`（`ai/src/api/anthropic-messages.ts:1059-1062`）、加上 Claude Code 的 beta 標頭（`:1142`）、注入「You are Claude Code」系統提示（`:1227-1232`），原始碼自己稱之為「Stealth mode」（`:95`）。Anthropic 的官方立場是不允許的：[Claude Code 法律合規頁](https://code.claude.com/docs/en/legal-and-compliance)寫明訂閱 OAuth「is designed to support ordinary use of Claude Code and other native Anthropic applications」，且「Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials」；[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) 禁止以 API key 以外、未經明示許可的自動化方式存取服務。所以 soma 預設用 API key。
- **MCP。** `@earendil-works/pi-mcp` 是獨立的客戶端，支援 stdio、Streamable HTTP 和 OAuth。接到 pi-durable 的轉接層是 `src/core/extensions/mcp/index.ts`，目前只接 stdio server。shikigami-bridge 的瀏覽器與 macOS 控制就經由這條路接進來。

## 設定

soma 啟動時讀一次 `~/.config/soma/config.json`。每個值先看環境變數，再看設定檔，最後用預設值；欄位、對應的環境變數和預設值都在 `src/config.ts` 的 `resolveConfig`。檔案不存在就只用環境變數和預設值。JSON 壞掉、欄位型別不對或有不認得的欄位時，soma 印出檔案路徑和欄位名稱後以狀態 1 結束，不帶著部分設定跑。範例：

```json
{
  "herdrSocket": "/Users/me/.config/herdr/sessions/fleet/herdr.sock",
  "mcpConfig": "/Users/me/.config/soma/mcp.json",
  "db": "/Users/me/.local/share/soma/soma.sqlite",
  "model": "claude-opus-5-5",
  "hangarCap": 4,
  "programStatus": true,
  "anthropic": { "apiKey": "sk-ant-..." },
  "telegram": { "botToken": "123456:ABC...", "chatId": 123456789 }
}
```

- **路徑不展開 `~`。** 請寫絕對路徑；`db` 寫相對路徑時以啟動時的目錄為準。
- **模型 key 不寫進 `process.env`。** `anthropic.apiKey` 經 pi-ai 的 `createModels({ authContext })` 傳進去：soma 的 `env()` 先問 pi-ai 預設的環境變數查詢，`ANTHROPIC_API_KEY` 沒設時才回設定檔的 key。provider 依序找 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`，所以任何一個環境變數都蓋過設定檔。沒有用 pi-ai 的 credential store，因為存進去的憑證會蓋過環境變數（pi-ai README 的 Credential Store 一節），優先順序就反了。
- **權限。** 設定檔裡有 key 或 token，而且群組或其他人可讀時，啟動會印出警告，請 `chmod 600`。
- **`mcp.json` 仍是獨立的檔案**，格式見待決事項第 5 點。

## 里程碑

每個里程碑都只有一個可觀察的結果。

- **M0 Node 冒煙測試。** 在 Node 上跑一個最小 durable 任務：`sleep` 到時、`kill -9`、重開、`resume()`、任務續跑。沿用程式碼的三個 Bun API 換成 `node:net`、`node:fs`、`node:child_process`。這一步同時產出 M2 要用的骨架。
- **M1 派工能撐過崩潰。** 只做核心、herdr 介面卡和終端機客戶端（含 OSC 7501 發送）。驗收：派出兩件工作、`kill -9` 核心、重開；其中一件在核心停掉期間做完，重開後仍會被回報，而且沒有重複啟動 agent。`kill -9` 要包含「派工已送出、agent 尚未列出」的空窗。
- **M2 排程、彙報與記憶。** 驗收：`schedule` 排一件兩分鐘後的事，核心中途重啟，時間到仍只執行一次；十分鐘彙報有新完成的工作才叫醒模型，等待期間重啟不漏報、不重複報；記憶 section 在下一輪請求出現在系統提示裡。
- **M3 Telegram。** 這是最小的人類介面，在手機上驗證報告的品質。
- **M3.5 email 與行事曆。** pi-mcp 轉接層加上選定的 MCP server。驗收：在 Telegram 問「今天有什麼會」得到正確答案。
- **M4 客戶端 socket。** 給程序外的介面卡用。
- **延後：cc-mobile 助理分頁、shikigami 改成客戶端。** 2026-10-18 決定先做 soma 本身的能力；這兩個專案的修改延後，或之後把它們的功能直接移植進 soma。
- **之後** 再視需要做 ACP 和 HTTP 兩種 agent 介面。

先不做的事：一開始就把三種 agent 介面寫齊、做通用的外掛框架（port 要有，註冊表和動態載入不要）、上雲。

## 已決事項

2026-10-18 決定：

- **執行環境先用 Node。** Pi 官方只支援 Node，沿用程式碼的三個 Bun API 各一行可換，也不必自己維護儲存介面卡。之後要轉 Bun 的評估如下。
  - 好處：工具鏈和 cc-mobile 一致；啟動快；可以打包成單一執行檔。
  - 代價：要寫並維護 `bun:sqlite` 介面卡（Node 版 201 行）；pi-durable 整個 harness 和 pi-ai 的串流在 Bun 上都未驗證；pi-durable 是實驗版，每次升版都要在兩個執行環境各驗一次。
  - 轉換要動的地方：加一個 SQLite 介面卡、把三個 node 呼叫換回 Bun API、重跑 M0 的冒煙測試和 M1 的 `kill -9` 驗收。
  - 重新評估的時機：M2 做完、harness 用到的 API 面積已知之後。
- **模型認證用 Anthropic API key。** 理由見「外部依賴」。
- **卡住時由模型判斷要不要轉給人**，`kind=auth` 除外；判斷和理由記進派工清單。
- **完成回報走每十分鐘的定時檢查**，有新完成的工作才叫醒模型寫短報告。

## 待決事項

1. **（已決，2026-10-18）派工要怎麼接 herdr。** 有三條路：
   - **(建議 M1 採用) 呼叫 cc-mobile 現成的 `POST /api/launch`。** 這條路由依序做驗證 bearer token、檢查、進佇列、建 worktree（`launch.ts:196`）、重新檢查（`:212`）、建 session、寫綁定檔、送提示（`server/launch.ts:196-349`）。好處是 soma 不用複製任何程式碼，並發上限自然共用，obw 回寫掛鉤應照常運作（未追查）。代價有兩個：soma 依賴 cc-mobile 程序在線，而 M4 又讓 cc-mobile 成為 soma 的客戶端，兩個程序都不能把啟動卡在對方身上；派工以 obw 卡片為單位，沒有卡片的臨時工作走不了這條路。
   - **把純函式複製進 soma**，註明來源 commit。代價是兩份程式碼會分岔，並發上限也要另外協調。
   - **抽成共用套件**，由兩邊共同依賴。這最乾淨，但要先改 cc-mobile，適合留到 M4。

   讀狀態和讀對話紀錄不經過派工路由，所以 M1 的事件橋仍然需要 herdr 的連線與訂閱程式碼。

   2026-10-18 決定：M1 改由 herdr 介面卡直接派進 `fleet` 機庫 session，用 herdr 自己的 `worktree.create` 開 `fleet/<card>` 分支，再 `agent.start` 帶 `--session-id`。理由是 `/api/launch` 要 soma 持有 cc-mobile 的 launch token 並依賴 cc-mobile 在線，而 herdr 介面卡本來就要寫；並發上限照 cc-mobile 的算法計算機庫裡在跑的 agent 數，兩邊算到的是同一批。`/api/launch` 留作 AgentPort 的另一個實作。
2. **shikigami 跑在哪台機器。** 如果和核心同一台，就在本機直接連；如果在筆電上，就經 Tailscale 連，和 cc-mobile 被手機連的方式一樣。
3. **報告存放位置，以及要不要另有一份每日總結。** 十分鐘短報告寫進 `notice` 紀錄由介面卡分送；是否再寫進 Obsidian vault 的日記或對應的 obw 卡片，待定。
4. **沒有 obw 卡片的臨時工作怎麼派。** `POST /api/launch` 以卡片為單位；要嘛 soma 先替臨時工作建卡，要嘛走自己的派工路徑。
5. **（已決，2026-10-18）email 與行事曆用哪個 MCP server，憑證放哪裡。**

   2026-10-18 決定：用 [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp)（MIT，未封存，v2.1.0 於 2026-10-09 發布），一個 stdio server 同時提供 Gmail 與 Calendar，以 Google OAuth 登入個人帳號。啟動指令是 `uvx workspace-mcp@2.1.0 --single-user --permissions gmail:readonly calendar:readonly`；2026-10-18 經 soma 的轉接層實際啟動，`tools/list` 只列出讀取類工具，其中有 `search_gmail_messages`（`query` 直接交給 Gmail，可用 `is:unread is:important`）和 `get_events`（`time_min`、`time_max`）。每個工具都有 `user_google_email` 參數。只加 `--single-user` 時這個參數仍是必填，而且帶了憑證目錄裡沒有的帳號就直接失敗、不會改用別的憑證（workspace-mcp 2.1.0 `auth/google_auth.py` 的 single-user 分支）；所以 `env` 還要設 `USER_GOOGLE_EMAIL`，server 會把參數改成選填並自動填入這個帳號（`core/server.py` 的 `USER_GOOGLE_EMAIL` 處理，2026-10-18 經轉接層實測 `tools/list` 的 `required` 已不含它）。

   憑證不進 repo。soma 讀 `~/.config/soma/mcp.json`（環境變數 `SOMA_MCP_CONFIG` 或設定檔的 `mcpConfig` 可覆寫路徑），格式是 `{"servers": {"<名稱>": {"command", "args", "env"}}}`。server 自己的憑證路徑寫在 `env` 裡：OAuth client 用 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`（或 `GOOGLE_CLIENT_SECRET_PATH` 指向 client_secret.json），token 目錄用 `WORKSPACE_MCP_CREDENTIALS_DIR`，建議設為 `~/.config/soma/google`；帳號用 `USER_GOOGLE_EMAIL`。Google OAuth app 停在 Testing 模式時 refresh token 七天後失效（[google-calendar-mcp README](https://github.com/nspady/google-calendar-mcp)），要發布成 production 才不用每週重新授權。

   沒選的候選：
   - Google 官方的 [Gmail](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) 與 [Calendar](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server) MCP server 還在 Developer Preview，只有 Streamable HTTP，個人帳號能否加入未驗證。正式發布後可以改用，轉接層要先加 HTTP 與 OAuth。
   - [@cocal/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) 加 [@klodr/gmail-mcp](https://github.com/klodr/gmail-mcp) 是兩個 Node server，要分開設定憑證；後者只有一位維護者。
   - [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) 已封存。
