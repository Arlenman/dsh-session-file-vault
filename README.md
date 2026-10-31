# dsh-session-file-vault（会话文件库）

把 DSH 会话里**模型主动展示（present）过的文件**归集起来，按 **文件类型 / 内容标签 / 日期** 三个维度分组浏览。

侧边栏新增「文件库」入口，主面板同时提供列表视图与三维筛选；点击任意一行在下方展开详情（路径、体积、模型当初写下的描述、出现过的会话）。

> 只读会话日志，不改写、不上传。索引文件落在本机 `$DSH_HOME/session-file-vault/`。

## 数据从哪来

采集源只有一个事件：

```json
{"type":"deliverables/presented","time":1699999999999,
 "data":{"turn":3,"callId":"…","files":[{"path":"…","description":"…"}]}}
```

它来自 `$DSH_HOME/sessions/<projectSlug>/<sessionId>/session.v4.jsonl.zstd`（多帧 zstd，按魔数 `28 B5 2F FD` 逐帧解压）。

设计取舍：**只统计模型主动展示的交付物**。不扫描文件系统、不猜工具调用的写入路径——那样会把中间产物、缓存、临时文件全都卷进来，反而找不到真正想交付的东西。

去重键 = 规范化后的绝对路径（Windows 下统一小写盘符、正斜杠），重复交付合并成一条记录并累计 `presentCount`。

## 三维模型

| 维度 | 怎么来的 | 能否手改 |
| --- | --- | --- |
| 文件类型 | 扩展名映射到 10 个类别：`doc/web/image/pdf/sheet/data/code/archive/app/other` | 可以（`userTags.type` 覆盖） |
| 内容标签 | 优先用模型交付时写的一行描述做规则匹配（约 30 条正则），再用本机可读文本补充；图片/PDF 等不读正文 | 可以（`userTags.content` 追加） |
| 日期 | `lastPresentedAt` 的本地日期（`YYYY-MM-DD`），详情里另给首次交付日期 | 可以（`userTags.date` 覆盖） |

**自动标签与手动标签分两处存**（`autoTags` / `userTags`），重建索引只刷新 `autoTags`，永不覆盖手动编辑。

## 已实现（M1 + M2 + M3 + M4）

- M1 宿主半边：全量扫描 + 增量存在性校验 + 打标 + 原子落盘索引 + 10 条 HTTP 路由
- M2 客户端半边：侧边栏入口、主面板列表、类型 chip / 内容标签多选 / 日期区间 / 文本搜索 / 4 种排序、行内详情
- M3 脑图视图：列表 / 脑图一键切换；两种聚合（内容标签 → 文件、文件类型 → 文件）；手写 SVG 手算布局，无图表库、无 D3；点维度圆按该组筛选，点文件圆跳回列表并展开详情；长尾维度过密时自动交替到内轨；**按住拖拽平移、滚轮以指针为焦点缩放**（0.45×–5×，工具条带 缩放百分比 / ± 按钮 / 复位），拖到边缘会留 20% 内容在画布内，不会把图拖丢
- M4 列表可读性与本地同步：
  - **标签按内容配色**：每个标签用 FNV-1a 哈希出一个固定色相（同一标签永远同色、跨刷新稳定），文件类型用固定色相；只上背景不上文字色，所以浅色 / 深色主题都对
  - **1 / 2 / 3 列**：工具栏一键切换，窄屏自动降级（三列→两列→一列），选择记在 localStorage
  - **左侧时间轴**：每行左侧显示具体时间（`10-31` + `19:48` 两行，title 给 `2026-10-31 19:48` 全量），配竖线与节点；不再用「3 天前」这类相对时间
  - **收藏 + 本地同步**：右上角「⚙ 设置」可填一个本地目录，同步范围支持 **全部文件 / 按类型 / 手动收藏**；手动模式下每行右侧出现空心 `♡`，点一下变红底 `♥`，被收藏的文件才会被复制过去

## 同步（把散落文件复制一份到本地目录）

设置路径：右上角「⚙ 设置」→ 填同步目录（必须是绝对路径）→ 选同步范围 → 「保存设置」→「立即同步」。宿主的设置接口也返回上次同步时间与本次结果（复制 / 更新 / 跳过 / 失败）。

几条刻意的取舍：

- **只复制，不移动**，源文件一个字节都不改。
- **不同文件重名不覆盖**：目标目录里已有同名但不是这条记录上次写的那份时，自动让开成 `名字 (2).ext`；同一条记录再次同步会覆盖自己上次那份，所以名字是稳定的，不会越同步越多副本。
- **没变就跳过**：体积与 mtime 都对得上就计数为「跳过」，不重复写盘。
- **源文件不在磁盘上只记账**：这一条算失败并给出原因，不影响其它文件。
- **收藏按 record id 存**（id = 归一化路径的 sha1），所以重建索引不会丢收藏。
- 删除目标目录里的副本、取消同步，都需要你自己动手 —— 插件不会删任何文件。

## HTTP API

全部挂在 `/api/session-file-vault` 下，走 DSH 连接层鉴权（Electron 桌面端与浏览器同源请求自动带 cookie）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 主面板一次拿全：`records` 全量瘦身记录 + `meta`（统计与类型目录）。载荷约 196 KB / 144 条 |
| GET | `/status` | 扁平状态：`ready / rebuilding / progress / stale / recordCount / existsCount / missingCount / paths` |
| POST | `/rebuild` | 全量重建索引（异步，进度走 `/status`）；body 可带 `{persist:false}` 只算不落盘 |
| POST | `/rescan` | 只重算存在性与体积，不重新解析会话日志 |
| POST | `/tags` | 三维手工修正，body `{id, userTags:{type,content,date}}`；`userTags` 必填，缺字段 = 清空该维度 |
| GET | `/detail?id=` | 单条详情（含 `sessions` 与 `descriptions` 全量） |
| GET | `/settings` | 同步设置：`{syncDir, syncMode, syncTypes, updatedAt}` |
| POST | `/settings` | 局部更新设置（PATCH 语义：只处理请求体里出现的字段） |
| POST | `/favorite` | 收藏 / 取消收藏，body `{id, fav}`；返回最新 `favorites` |
| POST | `/sync` | 按当前设置执行一次复制，返回 `report`（`matched / copied / updated / skipped / failed / errors`） |

错误统一 `{ok:false,error:{code,message}}`，code 取值：`bad-id / bad-type / bad-date / bad-user-tags / bad-json / bad-settings / bad-sync-dir / bad-sync-mode / bad-sync-types / no-sync-dir / not-found / no-index / internal`。

## 存储

```
$DSH_HOME/session-file-vault/
  index.json         # 索引（原子写：写临时文件再 rename）
  settings.json      # 同步设置 + 收藏 + 已同步文件名映射（原子写）
  scan-state.json    # 扫描状态（供后续增量轮询使用）
```

`index.json` 与 `settings.json` **互不覆盖**：重建索引只写前者，收藏与同步设置永远保留在后者。

settings.json 字段：

```
syncDir     同步目标目录（绝对路径，空串 = 未设置）
syncMode    all | type | manual
syncTypes   syncMode=type 时要同步的类型 key 列表
favorites   收藏的 record id 列表（syncMode=manual 时就是同步集合）
syncLog     { "<id>": { name, size, mtimeMs, at } }  # 已同步到哪个文件名，保证重复同步不撞名
updatedAt
```

索引字段：

```
id / path / name / dir / ext / sizeBytes / mtimeMs / exists / checkedAt
firstPresentedAt / lastPresentedAt / presentCount / descriptions[]
sessions[{ sessionId, project, projectLabel, cwd, title, time }]
autoTags{ type, content[], localTitle, sources, extractedAt, contentHash }
userTags{ type, content[], date }
```

`id = sha1(规范化小写路径).slice(0,16)`。

## 安装

```bash
# 1) 从 npm 装（推荐）
dsh plugin --profile web add dsh-session-file-vault

# 2) 从 GitHub 装（锁 tag）
dsh plugin --profile web add github:Arlenman/dsh-session-file-vault#v0.2.0

# 3) 本地开发（link: 安装，改客户端半边刷新页面即生效；宿主半边改动需重启 DSH）
dsh plugin --profile <profile> add /绝对路径/to/dsh-session-file-vault
```

桌面端（Electron）只能在应用内「设置 → 插件 → 添加插件」里装（CLI 会报 `managed exclusively`），可填包名、`github:...` 或本地绝对路径。

装完**必须重启一次 DSH**：宿主半边（索引、路由）不热重载；客户端半边刷新页面即可。

`package.json` 不声明 `peerDependencies`，因此不受内核预发布版本范围校验影响；`dsh.client.inject` 为空数组，客户端不引入任何核心模块依赖。

## 开发

```bash
npm test              # 宿主半边：vault / routes / apply / sync，39 项
npm run test:client   # 客户端半边离线渲染 + 事件真调用，126 项
npm run test:style    # 样式注入（含「标签在但内容为空」回归），26 项
npm run test:graph    # 脑图布局与渲染（几何 / 确定性 / 内外轨 / 筛选联动 / 平移缩放），117 项
npm run test:features # 标签配色 / 分列 / 时间轴 / 爱心 / 设置弹窗与真实请求，94 项
npm run test:all      # 上面五套一起跑
npm run build-index   # 直接扫本机会话日志并落盘索引（排障用）
```

`npm run test:client` 串跑四套客户端脚本（126 + 26 + 117 + 94 = 363）。

`test-features.mjs` 里有两套载入通道：一套用**真 React** 做静态渲染断言；另一套用**假 React**（`useState` 按调用序位置化）+ 可编程 `fetch`，把「保存设置 / 立即同步」真的点一次，断言发出的 URL 与请求体 —— 静态渲染永远触发不了按钮，光看 HTML 会把 handler 接错这类 bug 全漏掉。

客户端半边是手写 CJS：整个文件包在 `window.__ModuleLoader__.load({ id, factory })` 里，`factory` 只 `require('react')`，不依赖任何 `@deepseek-ai/*` 模块。侧边栏 `sidebar.panellist` 与主面板 `main` 两个槽位用同一个字符串 id 配对；重复注册会抛错，因此 apply 里每处注册都独立 try/catch 并遵循 HMR 世代纪律。

## 隐私

- 只读会话日志，不写入会话、不发起网络请求
- 索引里存的是本机文件路径与模型写的一行描述，不外发
- 扫描范围 = `$DSH_HOME/sessions` 下全部项目目录

## 已知环境行为：DSH 启动后可能把面板切回会话视图（非本插件问题）

现象：打开「文件库」面板后约 1~3 秒，面板整棵树消失、回到会话视图；侧边栏入口仍在，点一下即可恢复。**每次 DSH 启动后最多发生一次。**

定性（2026-10-31 真机阶梯实验，证据 `D:\dsh-work\session-file-vault\ladder1.log`）：

- 来源是 DSH 内核 `dsh-client-ui-workspace` 的 `watchNavigation()`：每次 sessions / workspaces 快照变化都会先跑 `clearArchivedCurrent()`，一旦 `mainReference` 指向的会话进了 `archivedSessionIds`，就 `clearMain()` → 最后一句 `ctx.layout.selectPanel(null)`，把 `main` 槽位从当前面板切走 → 任意第三方 `main` 面板都会被卸载。
- 与之同时，内核会在页面启动时用**持久化的陈旧 selection** 调一次 `landOn → openSession → replaceMain → sessions.retain`，抛出 `sessions.retain: unknown session <id>`（page-level unhandled rejection）。这两件事同源：DSH 手里存着一个已不存在的 session id。
- 只发生一次的原因：`clearMain()` 会把 `mainReference` 置为 `undefined`，之后 `clearArchivedCurrent()` 的 `current === void 0` 判定恒为 false，不再触发。

阶梯实验判据（同一页面连续 5 个阶段，每阶段 6~9 秒）：`S0-idle`（**完全不输入**）→ 面板在 1518 ms 消失；`S1-wheel` / `S2-press-release-noMove` / `S3-drag-real` / `S4-drag-synth` 全部整段存活、零新异常、事件 `composedPath` 全程不越出 `.sfv-graph-wrap`。**证明与拖拽、点击、滚轮都无关。**

对使用的影响：无。面板被切走后点侧边栏入口即恢复，且此后不再复发。`main` 槽位的第三方插件（含备份同步面板）都会遇到同样的行为。

真机验收脚本 `probe-panzoom.mjs` 已内置「预热」：主动等这次自愈发生并 reopen 一次，再开始断言，避免把 DSH 行为误记成插件缺陷。

## License

MIT
