# 技術紀錄

開發過程中的實測資料、資料來源調查、驗證結果、參數調整經過與踩過的坑。系統**目前如何運作**見 [DESIGN.md](DESIGN.md)；開發指令與工作規則見 [CLAUDE.md](../CLAUDE.md)。

新增紀錄時放在對應主題下，註明日期與使用的日誌。

## 測試資料

| 用途 | 我的日誌 | 參考（高階玩家） | 備註 |
|---|---|---|---|
| **武士比較基準**（使用者指定） | `FXLkqaK32PhQH8Ac` #1，席德（source 6），Howling Blade 擊殺 13:50 | `pwTF16cgnB9G7fWM` #29，安祖卡（source 13），13:56 | 驗證功能時必測 |
| **騎士比較基準**（使用者指定） | `hqNYDGK9A4pmWVXB` #18，神曲莊園（source 40），Howling Blade 擊殺 13:53 | `khNfTaMtYwKBd36b` #10，Lavid（source 5），12:52 | 參考快 61 秒，可測大幅時間差與坦克技能 |
| 黑魔道士驗證（非使用者指定） | `bX97vBapCPwKndL6` #3，春風醒（source 2），13:40 | `h6gRJZ2pfDFYMPjX` #13，Nana七（source 28），13:01 | |
| 暗黑騎士（驗證用） | `FXLkqaK32PhQH8Ac` #1，倉鼠教徒（source 4） | `pwTF16cgnB9G7fWM` #29，穎嵐（source 71） | 驗證坦姿不紀錄與減傷建議 |
| 同隊滅團 vs 擊殺、冒煙測試 | `WATKBdHRh7m8PNQt` #10（Sugar Riot 滅團，Risen／Viper source 34） | 同報告 #11（擊殺） | 冒煙測試固定使用這份報告 |
| 不同隊伍的對齊測試 | `pwTF16cgnB9G7fWM` #29 | `bX97vBapCPwKndL6` #3（13:40）、`h6gRJZ2pfDFYMPjX` #13（13:01） | 後者為同一玩家安祖卡 |

已排除的連結：`bX97vBapCPwKndL6` #3 沒有武士參戰（報告中的武士 瓏系莉亞 未參與任何一場戰鬥）；`h6gRJZ2pfDFYMPjX` #4 是 Dancing Green，與 Howling Blade 不同 Boss。

## FFLogs 資料特性

- **時間**：事件 `timestamp` 相對於整份報告開始；需減去 fight 的 `startTime`。
- **連結格式**：`fight`、`source` 可能在 hash（`#fight=5`）或 query string（`?fight=29`）；`fight=last` 代表最後一場；區域子網域（`tw.`、`cn.`）也會出現在網址中；匿名報告代碼以 `a:` 開頭。
- **玩家清單**：`masterData.actors` 中 type 為 `Player` 的包含極限技假角色（subType `LimitBreak`，名稱 `Limit Break`、`Multiple Players`）與 subType `Unknown` 的重複項。`fights[].friendlyPlayers` 列出參戰者；報告中可能有角色沒有參與任何戰鬥。
- **事件量**（單一玩家整場，約 13 分鐘）：
  | 查詢 | 位置取樣 | 中位間隔 | 最大間隔 | 大小 |
  |---|---|---|---|---|
  | `dataType=Casts&source=玩家` | 0.62 筆/秒 | 1.4 秒 | 47 秒 | 213 KB |
  | `dataType=DamageDone` | 0.90 筆/秒 | 0.9 秒 | 48 秒 | 798 KB |
  | `dataType=All&source=玩家` | 1.80 筆/秒 | 0.4 秒 | 3.7 秒 | 1.7 MB |

  `limit: 10000` 時一頁通常就能取完。`Buffs` 沒有位置資料。
- **位置**：`sourceResources`／`targetResources` 的 `x`、`y`（1/100 yalm，場地中心約 (10000, 10000)）、`facing`；需要 `includeResources: true`。
- **施放事件**：有詠唱條的技能先有 `begincast`、詠唱結束才有 `cast`；被打斷的只有 `begincast`。開場在戰鬥開始前就開始的預詠唱（例如黑魔的 Fire III）沒有 `begincast`。
- **普通攻擊**：`dataType=All` 中每場約 300 次 `cast`（Attack #7；遠程為 Shot #8），`dataType=Casts` 中沒有。
- **技能與道具 ID**：技能即遊戲的 Action ID；道具以大 ID 表示（例如藥水 Grade 3 Gemdraught of Strength = 34600427、Intelligence = 34600430），不在 Action 表。
- **圖示**：`masterData.abilities[].icon`（如 `003000-003729.png`），網址 `https://assets.rpglogs.com/img/ff/abilities/<icon>`（`/icons/` 路徑會 403）。
- **Boss**：敵方施放中施放最多次的敵人為主 Boss（Howling Blade 有多個同名 actor）。部分 Boss 技能在 FFLogs 沒有名稱（例如 42672 顯示為 `unknown_a6b0`）。
- **隨機機制**：同一機制的隨機變化使用不同技能 ID，甚至同名不同 ID。Howling Blade 實例：Windfang／Stonefang、Eminent Reign／Revolutionary Reign、Wolves' Reign（#41880/#43369 vs #42927/#43370 等方向）、Hero's Blow（#42079/#42080 vs #42081/#42082）、Sand Surge（#43138 vs #43520）。
- **語系**：FFLogs 有 `cn.`、`ja.` 等子網域，**沒有 `tw.fflogs.com`**；API 的 `translate` 只翻成英文。

## 外部資料來源調查：技能繁中名稱（2026-09-25）

| 來源 | 結果 |
|---|---|
| FFLogs | 沒有繁中（見上） |
| XIVAPI v2（`v2.xivapi.com`） | 只有國際版語言 en、ja、de、fr |
| Boilmaster 鏡像（`xivapi-v2.xivcdn.com`） | 支援 `language=chs`（簡中）與 `language=tc`（繁中）；`cht`、`zh`、`zh-TW` 回 400。`/api/sheet/Action?rows=1,2,3&fields=Name,Icon&language=tc` 可批次查詢 |

`tc` 實測：
| 技能 | en | ja | chs | tc |
|---|---|---|---|---|
| 7490 | Hissatsu: Shinten | 必殺剣・震天 | 必杀剑·震天 | 必殺劍·震天 |
| 34606 | Steel Fangs | 壱の牙【咬創】 | 咬噬尖齿 | 壹之牙【咬創】（與簡中用詞不同，不能用簡轉繁代替） |
| 36921 | Imperator | インペラトル | 绝对统治 | 絕對統治 |
| 41880（Boss，較舊） | Wolves' Reign | 群狼剣 | 群狼剑 | 群狼劍 |
| 42079（Boss，新版本） | Hero's Blow | 鎧袖一触 | 摧枯拉朽 | `_rsv_42079_-1_7_0_0_…`（佔位） |
| 42672（Boss） | （空白） | （空白） | （空白） | （空白） |

新內容的名稱在客戶端資料中以 `_rsv_` 佔位、由伺服器提供，資料挖掘拿不到。簡轉繁使用 opencc-js（`opencc-js/cn2t`，`from: 'cn', to: 'tw'`），打包後 Worker 2 MB（gzip 503 KB），免費方案上限 3 MB。

## 職業與技能 ID 查證（2026-09-25）

- **職業繁中名稱**（ClassJob 表 `language=tc`）：騎士、戰士、暗黑騎士、絕槍戰士、白魔道士、學者、占星術師、賢者、武僧、龍騎士、忍者、武士、奪魂者、毒蛇劍士、吟遊詩人、機工士、舞者、黑魔道士、召喚士、赤魔道士、繪靈法師、青魔道士。先前自行翻譯的「黑魔法師」「蝰蛇劍士」與官方不符，已改正。FFLogs 的 subType 等於英文職業名稱去空白（例如 `BlackMage`、`DarkKnight`）。
- **坦克姿態與職能技能 ID**（以 `sheet/Action?rows=...` 查證）：Provoke 7533、Shirk 7537、Iron Will 28、**Release Iron Will 32065**、Defiance 48、Release Defiance 32066、Grit 3629、Release Grit 32067、Royal Guard 16142、Release Royal Guard 32068、Rampart 7531、Reprisal 7535、Feint 7549、Addle 7560、Sprint 3、Third Eye 7498、Tengentsu 36962。**ID 38 是戰士的 Berserk**，先前騎士模組誤把它當成 Release Iron Will。
- 查證方法：`https://xivapi-v2.xivcdn.com/api/sheet/Action?rows=<ids>&fields=Name,ClassJob.Abbreviation&language=en`（或 `tc`）。憑記憶寫入的技能 ID 都應先查證。

## 實測結果

### 時間軸對齊
| 比較 | 錨點 | 時間差 | 觀察 |
|---|---|---|---|
| 同隊 Sugar Riot 滅團 vs 擊殺（`WATKBdHRh7m8PNQt` #10／#11） | 107 | -0.1～+0.3 秒 | 腳本幾乎完全一致 |
| 不同隊伍 Howling Blade（`pwTF16cgnB9G7fWM` #29／`bX97vBapCPwKndL6` #3，13:56 vs 13:40） | 197 | -4.3～+0.2 秒 | 時間差呈階梯狀（0 → -2.6 → -4 秒），對應轉場提前 |
| 參考快 55 秒（`pwTF16cgnB9G7fWM` #29／`h6gRJZ2pfDFYMPjX` #13） | 175 | -16.5～+0.7 秒 | 0～206 秒為 0，之後 -3.5、-5.6，約 400 秒起穩定 -16.4 秒 |
| 武士比較基準 | 194 | -6.8～+0.2 秒 | |
| 騎士比較基準 | 171 | -9.3～+1.4 秒 | |
| 黑魔驗證 | 161 | -12.5～+0.7 秒 | |

原型比較：不限制施放次數時，高頻的 42672（50 次以上）造成錯誤配對（出現假的 3.8～6.9 秒時間差）並把正確錨點擠掉；限制 ≤ 8 次後時間差回到 -0.1～+0.3 秒。最大無錨點區間 56 秒（402～459 秒，Howling Blade 轉場）。

### 比較範圍
騎士（我長 61 秒）排除我最後 52.2 秒後，GCD 差距從 -5 變為 -25（多出的戰鬥時間掩蓋了差距）；武士排除參考最後 13.5 秒，GCD 差距從 -18 變為 -12。

### 通用指標（比較基準）
| | 武士（席德／安祖卡） | 騎士（神曲莊園／Lavid） | 黑魔（春風醒／Nana七） |
|---|---|---|---|
| GCD 數（比較範圍內） | 342／354 | 260／285 | 315／311 |
| GCD 間隔 | 2.175／2.141 秒 | 2.497／2.500 秒（Lavid 原始中位數 2.505，受上限） | 2.443／2.408 秒 |
| 空檔總計 | 80.7／62.4 秒 | 122.7／58.5 秒 | 52.4／52.7 秒 |
| 少打 GCD 的時段 | 4 段共 6 個（最大 8:01 停手 9.1 秒） | 13 段共 19 個 | 1 段共 2 個 |
| 普通攻擊 | 294／298 | 296／293 | |

武士的 GCD 差距中，約 14 秒（36 毫秒 × 約 380 次）來自 GCD 較慢。

### 站位
武士比較基準：15 段差異，11 段標示可能對稱。7:29 起（第二階段平台）兩人持續相距約 33 yalm。30 秒平均座標（參考時間約早 6.8 秒）：

| 我的時間 | 我 | 我的 Boss | 參考 | 參考的 Boss |
|---|---|---|---|---|
| 450 秒 | (113, 107) | (100, 102) | (88, 103) | (100, 101) |
| 570 秒 | (110, 92) | (93, 93) | (89, 91) | (108, 93) |
| 600 秒 | (115, 105) | (113, 101) | (99, 118) | (87, 100) |
| 810 秒 | (83, 105) | (87, 95) | (116, 106) | (114, 98) |

兩隊東西相反，連 Boss 也相反；同時段 Boss 機制差異顯示 Hero's Blow 方向不同，很可能是機制造成。第一階段的對稱標示尚未驗證。

### Boss 機制差異
- 武士比較基準：13 處，12 處為隨機變化；另有 6:39 Extraplanar Pursuit 只有我。
- 騎士比較基準：20 處，11 處為隨機變化；其餘多為只有我（Moonbeam's Bite ×4、Fanged Charge、Fanged Maw，參考快 61 秒跳過）。

### 職業模組驗證（以 `begincast` 為起點的相鄰 GCD 間隔）
| 職業 | 日誌 | 間隔分布 | 異常間隔 |
|---|---|---|---|
| 武士 | 比較基準兩份 | 集中 2.0～2.25 秒；約 1.33 秒者皆在居合術／奧義斬浪等詠唱技能之後（以 `cast` 計時時） | 無 < 1.25 秒 |
| 騎士 | 比較基準兩份，560 多個 GCD | 集中 2.45～2.5 秒 | 1 個 1.52 秒（Holy Spirit → Fast Blade） |
| 黑魔 | 黑魔驗證兩份 | 集中 2.04～2.5 秒 | 各 1 個約 0.6 秒，皆為開場預詠唱 Fire III → High Thunder |

毒蛇劍士：技能 ID 34606–34633 為 GCD、34634–34647 為 oGCD（依 ID 排列推得）。

### GCD 判斷規則與全職業驗證（2026-09-25）

- **規則**：Action 表 `CooldownGroup` 或 `AdditionalCooldownGroup` 為 58。以 37 個已人工分類的技能核對（18 GCD、19 oGCD）全部相符，包括 ClassJob 為空的變形技能（Midare Setsugekka、`IsPlayerAction` 為 false）與有充能的 GCD（Vicewinder：`CooldownGroup` 15、`AdditionalCooldownGroup` 58）。唯一不同是 **Meditate（7497）**：類別是 Ability、60 秒冷卻，但 `AdditionalCooldownGroup` 58 會觸發公共冷卻，占一個 GCD，資料的判斷才正確，人工分類錯了。
- 產生結果：735 個 GCD 技能 ID；自動集合涵蓋手寫的四個職業全部 95 個 GCD。
- **全職業驗證**（以 begincast 為起點的相鄰 GCD 間隔，6 場 Howling Blade 戰鬥、55 位玩家、19 個職業；沒有奪魂者的日誌）：

  | 結果 | 職業 |
  |---|---|
  | 沒有小於 1.5 秒的間隔 | 騎士、戰士、暗黑騎士、絕槍戰士、白魔道士、學者、龍騎士、武士、毒蛇劍士、吟遊詩人、繪靈法師 |
  | 短間隔是 GCD 本身較短（分類正確） | 舞者 舞步約 1.0 秒；忍者 結印約 0.5 秒；賢者 Eukrasia 約 1.0 秒；武僧 Forbidden Meditation 約 1.0 秒；機工士 Blazing Shot 約 1.5 秒；召喚士 Emerald Rite 約 1.5 秒；赤魔道士 近戰連擊約 1.5 秒 |
  | 開場預詠唱 | 黑魔道士 Fire III → High Thunder 約 0.6 秒；赤魔道士 Veraero III → Verthunder III 約 0.6 秒 |
  | 負的間隔（資料處理錯誤，已修正） | 占星術師、赤魔道士：詠唱被取消後殘留的 begincast 配對到之後瞬發的同一技能 |

- 各職業 GCD 間隔中位數：多數約 2.41～2.50 秒；武士 2.14～2.18、毒蛇劍士 2.10～2.14、忍者 2.10、武僧 1.93、黑魔道士 2.15～2.44（依黑魔紋）。

## 參數調整與錯誤修正經過

- **平均時機配對**：初版第 n 次對第 n 次，次數不同時後面全部錯位，出現「Feint 晚 164.8 秒」「Hagakure 早 434.9 秒」；改為可跳過的動態規劃配對、30 秒窗口後合理（Tengentsu 早 0.8 秒、Feint 晚 2.3 秒）。
- **Boss 機制差異窗口**：初版同技能 1.5 秒內才算相同，把轉場附近差 2～3 秒的同一機制（Moonbeam's Bite）列成「只有我」＋「只有參考」；放寬為 5 秒後武士從 18 處降為 13 處。
- **對稱站位判斷**：只以 Boss 為中心時，第二階段連 Boss 都相反的情況判斷不出來；加入場地中心後 13／15 段被標示，太寬鬆；要求同一種對稱解釋過半時間、對稱後 ≤ 6 yalm 後為 11／15。
- **Boss 位置內插**：Boss 位置只來自 Boss 施放、取樣稀疏，沿用玩家的 4 秒內插限制時大多取不到位置，改為 30 秒／10 秒。
- **建議清單**：初版把連擊 GCD（Shifu、Jinpu…）的次數差列為「冷卻好就用」、把坦克減傷（Intervention、Reprisal、Provoke…）列為少用，是錯誤建議；改為只比較 oGCD、加入防禦／輔助分類並合併次要項目，武士從 27 則減為 15 則。
- **GCD 上限**：使用者指出 GCD 最長 2.5 秒；實測間隔受延遲影響略長（2.505 秒），改為取樣到 2.6 秒、推估上限 2.5 秒。
- **普通攻擊**：改抓全部事件後出現約 300 個 Attack 圖示塞滿 oGCD 列；改為不畫在時間軸但列入技能次數（使用者要求保留次數差）。
- **減傷與輔助技能分類**：原本把坦克減傷、挑釁、衝刺都歸為低優先的「職能與防禦技能」；使用者指出挑釁、退避、坦姿開關無須紀錄，但減傷與衝刺是重要的學習課題，改為四類分類與專屬建議。騎士比較基準改版後的減傷建議：干預少用 5 次、雪仇少用 3 次、壁壘少用 3 次、衝刺少用 3 次、鐵壁有 2 次時機不同、極致防禦平均晚 9.4 秒；武士：天眼通少用 6 次、衝刺 0 vs 6 次、牽制少用 5 次。

## 部署與開發踩過的坑

- **GitHub Pages 重複部署**：Pages Source 設成 Deploy from a branch 時，GitHub 另外跑 `pages build and deployment` 把原始碼（未建置的 `index.html`）發布上去，與 Actions 的部署互相覆蓋；需改為 GitHub Actions。冒煙測試會檢查頁面是否引用 `/src/` 原始碼。
- **Actions 變數未生效**：原本以 repo variable `API_BASE` 注入 Worker 網址，建置時讀到空值導致正式站連 `localhost:8787`；網址非機密，改寫在 `src/config.ts`。
- **Cloudflare Secret 未部署的版本**：在儀表板刪除 Secret 而未按 Deploy 時，會產生未部署的新版本；下次 `wrangler deploy` 會以最新設定為準而使 Secret 消失。用 `npx wrangler secret list`、`versions list`、`deployments status` 檢查。
- **wrangler login**：自動開啟瀏覽器失敗時，用 `npx wrangler login --browser=false` 取得網址讓使用者手動開啟。
- **GitHub SSH**：本機 `known_hosts` 有 GitHub 2023 年前的舊 RSA 金鑰導致警告；使用者需自行把 SSH 金鑰加到 GitHub。
- **npm 安裝腳本**：npm 11 預設阻擋 esbuild、workerd 的 postinstall（allow-scripts 警告），實際不影響建置與 `wrangler dev`。
- **瀏覽器平滑捲動**：同時對頁面（`scrollIntoView` smooth）與內層容器（`scrollTo` smooth）平滑捲動時，瀏覽器會中斷內層捲動；內層改為立即設定 `scrollLeft`。
- **React 19 `ref` prop**：元件 prop 命名為 `ref` 會被當成保留 prop（lint 報 Cannot access refs during render），改名為 `reference`。
- **瀏覽器快取**：推送後正式站可能仍顯示舊版，加查詢字串（例如 `?v=<commit>`）或重新整理即可。
- **技能名稱查詢延遲**：`/abilities` 快取未命中時要向 Boilmaster 鏡像查兩種語言，實測約 8 秒；在瀏覽器驗證繁中名稱時要等比較載入後再多等幾秒，否則會先看到英文名稱。
- **PowerShell 5.1 寫檔**：`Set-Content -Encoding utf8` 會在檔案開頭加 BOM；改用 Edit／Write 工具或 Node 寫檔。
