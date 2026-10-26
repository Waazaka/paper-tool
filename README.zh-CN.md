# paper-tool · 文献工作台

一个长在编辑器侧边栏里的文献工具。导入 PDF，用中文和英文做全文检索，读它们，
再把读到的内容变成一篇**可溯源**的综述——每一条引文都带着它来自哪篇论文、哪一页、
哪一段字符，一路带进导出的 Markdown。

它是 [DSH](https://github.com/deepseek-ai) 的插件。不需要 Zotero，不需要外部软件，
不需要 API key。

[English README](README.md)

## 它解决什么问题

用 `grep` 也能搜一堆 PDF。真正做不到的是：记住**哪篇论文的哪一页的哪句话**支撑了
**哪一个论点**——而这恰好是写综述的全部工作量。这个插件把这条对应关系变成一等公民，
而不是让你重新敲进一个笔记文件里然后忘掉。

具体来说：

- 一条搜索结果是一**页**，不是一个文件。你拿到页码和片段，而不是一个要滚 40 页的 PDF。
- 存下的证据锚定在**论文 + 页码 + 字符偏移**上，所以它被挪进 Markdown、被换个视图看，
  都还能指回原处。
- 导出时会告诉你**有多少条能定位、多少条不得不排除**，而不是悄悄给你一条指向空处的引文。

## 它做什么

| 环节 | 能力 |
|---|---|
| 文献库 | 导入 PDF；正文按页抽取并建索引 |
| 文献库 | **扫描版 PDF（无文本层）在导入时 OCR，之后可搜索** |
| 检索 | 中英文全文检索，带页码和片段 |
| 文献库 | 不必搜索也能浏览已导入论文；编辑元数据；带确认的删除 |
| 阅读器 | PDF 画布 + 可选中文本层：跳页、翻页、缩放、适应宽度 |
| 证据 | 保存选中文字（或按主题批量收集），锚定到论文 + 页码 + 偏移 |
| 综述 | 证据大纲、论点 × 论文矩阵（支持 / 冲突 / 未提及 / 无证据） |
| 引用 | CSL 渲染：APA、IEEE、MLA、Chicago、GB/T 7714（顺序编码制 + 著者出版年制） |
| 导出 | 写出 `review.md` + `references.bib`，并做锚点校验 |
| 外部 | 检索 OpenAlex / Crossref / arXiv 找新候选 |
| 知网 | 人工登录一次，之后自动检索与 PDF 下载 |

侧边栏分三个视图：**文献库**、**证据**、**综述**。阅读器把 PDF 文本层叠在画布之上；
当文本层建不起来时，降级为一个可选中的文本面板，而不是静默地把选中功能关掉。

## 环境要求

- **DSH** 桌面端（插件宿主）。本包是一个 DSH 的 client + host 打包体。
- **Windows**，仅 OCR 路径需要。其余部分跨平台。OCR 用的是系统自带的
  `Windows.Media.Ocr`——这就是为什么它什么都不用装，也是为什么在 macOS 和 Linux 上
  OCR 不可用。
- **Node 22+**，用于跑门禁（用到 `node:sqlite` 和 `node:test`）。

依赖刻意只有三个：`pdfjs-dist`（渲染 + 文本抽取）、`citeproc`（引用格式化）、
`@napi-rs/canvas`（OCR 用的页面栅格化）。

## 扫描版 PDF 的 OCR

没有文本层的 PDF 过去只能存成「仅元数据」——在库里看得见，但搜不到也引不了。
`importPdf` 现在会识别这种情况，用 pdf.js 把每页渲染成图，再交给 `Windows.Media.Ocr`。

存的是**三种**状态而不是两种，因为它们不是同一个承诺：

| `material` | `textSource` | 含义 |
|---|---|---|
| `fulltext` | `text-layer` | 文字来自 PDF 自带文本层 |
| `ocr` | `ocr` | 文字从页面图像识别而来——**字可能是错的** |
| `metadata` | `text-layer` | 完全没有文字，只有书目字段 |

这个区分一路带到底：库里的徽标、证据行、导出 `review.md` 里每一条引文（标注 `（OCR）`）、
以及模型从 `paper_read` 拿到的文本，都会说明某句话是「猜的」还是「读到的」。

已知限制，写出来而不是藏起来：

- **仅 Windows。** 引擎是 `Windows.Media.Ocr`；其他平台上 OCR 会报告不可用，论文保持
  「仅元数据」。其它功能不受影响。
- **单次导入上限 40 页。** 识别大约每页一秒，且在导入过程中同步跑。更长的扫描件会被
  明确拒绝并说明原因，而不是中途超时。
- **不做版面还原。** 表格、公式、多栏文字出来是一整条流。这是 OCR 的固有限制，
  不是这里能修的 bug。
- **不做拼写纠正。** 认错的字就按认错的原样保留。悄悄「修正」会把引文变成编造。
- **读不出来的页就是空，不猜。** 纯噪点图像返回空文本；论文仍标记为 `ocr`，
  让使用者知道要去核对那一页。

本机用 `zh-Hans-CN` 实测：清晰的中文扫描件几乎完全正确（错一个字：「济」→「冫齐」），
浅淡的扫描件正确，严重模糊的退化成 `庶游贡虱诟关究`，纯噪点图返回空。
中日韩字符是逐字出 token 的（`旅 游 经 济`），入库前会去掉字间空格，
否则中文检索永远匹配不上。

## 界面约定

页签渲染在通常只有 320–420 px 宽的侧边栏里，所以下面三条是承重的，不是风格偏好：

- **颜色只能来自宿主别名 token。** 早期版本引用了五个宿主包里并不存在的
  `--dsw-alias-*` 名字，于是每个 `var()` 都落到字面量兜底，主按钮和当前视图页签
  在深色模式下直接看不见。`test/wiring.mjs` 现在会对任何未知 token、任何字面量十六进制
  颜色、任何 `dangerouslySetInnerHTML` 报错。
- **前景背景必须成对设置**（`background` + `color`），只设一个会继承宿主正文色，
  可能变成白底白字。`.pt-pre` 就是这个 bug：大纲、文中引用和整个参考文献在深色模式下
  全都读不了。
- **布局响应容器宽度，不是视口宽度**，用 `@container pt (max-width: 340px)`。
  侧边栏会独立于窗口变窄，所以视口媒体查询永远不会触发。

文本片段用 React 节点拼（`snippetNodes`），所以 PDF 里的文字永远不会被当作标记解析。

## 安装

```powershell
git clone <本仓库> paper-tool
cd paper-tool
pnpm install
```

插件以 bundle 形式载入 DSH 的 `desktop` profile，所以 DSH 必须在 `node_modules` 下
看得到它。开发时用目录 junction，好处是仓库保持「活的」——改文件、刷页面、立刻看到：

```powershell
mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\paper-tool" (Get-Location)
```

然后在 profile 里注册这个 bundle，重启 DSH 一次。host 侧改动需要重启 DSH；
client 侧改动会以新的内容版本号下发，只需刷新页面。

注意 `@napi-rs/canvas` 按平台分发预编译原生二进制，`pnpm install` 会挑对的那个。
在不支持的平台上，OCR 不可用，但插件其它部分照常工作。

## 当前状态

核心闭环已在真实 DSH 界面里走通：导入、中文全文检索、跳页、画布 + 文本层、选中、
证据保存/删除、矩阵、元数据编辑、APA/GB-T 引用、Markdown + BibTeX 导出、
大纲插入对话、以及重启后持久化。

插件经过架构、代码正确性、安全、数据层、QA、UI/UX、React、产品等专项角色评审，
外加一名对抗性 UI 测试员；发现的问题已分级并修复。其中四个是使用者几分钟内就会撞上的崩溃：

| 缺陷 | 原因 |
|---|---|
| 切换页签后侧边栏白屏 | 整棵组件树没有任何 React 错误边界 |
| 关闭阅读器报 `doc.destroy is not a function` | PDF.js 6 把 `destroy` 从 document 移到了 loading task |
| `null` 被传给 `page.render()` | `canvas.getContext("2d")` 可能失败（GPU 重启、上下文耗尽） |
| 中文搜索静默返回空 | 迁移里残留的 `DROP TABLE` 删掉了 trigram 索引 |

已知缺口，写出来而不是藏起来：

- **知网需要人工登录一次**，且未做线上复测。
- **PDF 元数据是猜的，只是猜得比较准。** 标题/期刊/年份依次取自 XMP、PDF Info 字典、
  第一页字号实测。**认错比留空更糟**，所以抽取器现在宁可留空；凡是推断出来的字段，
  界面上都标 **待核对**。引用前请用 **编辑元数据** 修正。
- **文字输入没有门禁覆盖。** DOM 桩目前送不进按键到 React 的 `onChange`；
  这是已登记的缺陷，不是静默放过。

## 给智能体用的工具

六个，刻意做得少：schema 文本每次请求都要付费，所以相关操作合并进同一个工具。

| 工具 | 用途 |
|---|---|
| `paper_search` | `scope=library` 搜本地；`scope=external` 查 OpenAlex/Crossref/arXiv；`scope=cnki` 搜知网 |
| `paper_import` | 把外部候选存成「仅元数据」条目 |
| `paper_read` | 读已抽取的页面文本，并如实报告覆盖范围 |
| `paper_evidence` | `action=collect` 查找并存储段落；`action=list` 列出 |
| `paper_review` | `action=outline` / `matrix` / `citations` / `export` |
| `paper_status` | 库覆盖情况、证据条数、可用引用样式 |

## 诚实性约束

这些是不变量，不是偏好：

- 没有文本层的论文存成 `material: "metadata"`，永远不会被当作可搜索全文。
- `paper_read` 报告它实际返回了多少页，并强制带 `truncated` 标志，
  所以一次被截断的读取无法伪装成完整。
- 证据矩阵把 `not_found`（查过了，这篇没提这个论点）和 `no_evidence`
  （这篇根本没存过证据）分开报。只显示「同意」的综述不是综述。
- 只有当引文确实在已存储的页面文本里定位到时，证据才记录 `charStart` / `charEnd`；
  否则两者都是 `-1`，界面标 **仅记录页码**。导出只用已定位的证据，
  并说明排除了多少条。
- 重复导入同一个 PDF 报告为 `duplicates`，绝不报告为 `imported`。
- 引用只用已存储的元数据渲染。不编造任何东西。
- 知网：插件从不破解验证码、从不绕过付费墙、从不保存凭证。人工登录一次，然后自动化。

## 知网细节

直接 HTTP 访问 `kns.cnki.net` 会返回一个 2146 字节的「安全验证」页——这是实测的，
不是假设的。滑块验证码不做绕过。做法是：

1. 点 **连接知网**，Chrome 用一个专用 profile 打开
   （`%LOCALAPPDATA%\dsh-paper-tool\cnki-profile`）。
2. 通过你所在机构的正常途径登录一次。
3. 会话 cookie 大约能撑 30 天；之后检索、翻页、下载、入库都是自动的。

如果知网弹出验证挑战，插件会如实说明，而不是假装成功。

## 存储

| 路径 | 内容 |
|---|---|
| `%DSH_HOME%\paper-tool\library.sqlite` | 索引：papers、pages、evidence、claims |
| `%DSH_HOME%\paper-tool\files\` | 导入的 PDF 原始字节 |
| `%LOCALAPPDATA%\dsh-paper-tool\cnki-profile` | 知网浏览器会话 |

`DSH_HOME` 是 DSH 的 profile 目录（Windows 上是 `~/.dsh-desktop`）。全局只有一个
文献库，所有工作区共用：文献库是个人资产、跨项目使用，而按工作区各存一份会让在 A 目录
导入的论文在 B 目录里完全看不到，看起来就像数据丢了。旧位置上已有的库
（`<workspace>/.dsh/paper-tool/library.sqlite`）会在首次启动时复制过来，但只在共享库
还不存在时复制，所以永远不会覆盖更新的数据。

插件配置里设 `dbPath` 可指定库文件位置，设 `shared: false` 可退回到按工作区各存一份。

直接用 `node:sqlite` 的 FTS5——不引 SQLite 包。索引有两个，因为一个分词器伺候不了
两种文字：

| 索引 | 分词器 | 负责 |
|---|---|---|
| `pages_fts` | `unicode61` | 拉丁词 |
| `pages_cjk` | `trigram` | 中文，任意 ≥3 字的子串 |

`unicode61` 把一整串中文当成一个 token，所以匹配不了其中的子串；`trigram` 可以，
但至少要三个字。因此一到两个汉字的查询回退到 `LIKE` 扫描——结果正确但更慢，
实测 2 400 页时 10 ms，在这个量级上仍是划算的。到 24 000 页时索引明显占优：
一个生僻词走 `MATCH` 比走 `LIKE` 快约 **1848 倍**。

Schema 用 `PRAGMA user_version` 版本化，只向前迁移（`SCHEMA_VERSION = 5`）。
每次迁移都在打开库时自动、幂等地执行，所以已有库是原地升级的：

| 版本 | 变更 |
|---|---|
| v2 | 显式的证据偏移（`charStart` / `charEnd`） |
| v3 | `metadataSource`——记录每个字段来自哪个通道 |
| v4 | `claims` 表 |
| v5 | 恢复 `pages_cjk` trigram 索引，并回填 |

> v2 当初还顺手删掉了 `pages_cjk`，为的是把每页写入成本减半。v5 把中文搜索加回来时，
> 那行遗留的 `DROP TABLE` 把新 schema 刚建好的索引删掉了——中文搜索返回空。
> 现在的门禁会断言该表存在，并且插入和删除触发器都把它同步上。

搜索结果按论文截断（`ROW_NUMBER() OVER (PARTITION BY paperId)`，每篇最多
`min(cap, 20)` 页），这样一篇长论文不会因为一个常见词而占满结果列表。
中文路径分两趟做——先排名，再只为存活的行取正文——因为把 `text` join 进窗口查询
会让 SQLite 把所有命中行都物化出来：272 ms 降到 76 ms。

## 浏览器里怎么渲染 PDF

侧边栏无法从 node_modules `import` `pdfjs-dist`：client bundle 只提供已注册的模块。
所以由 Host 流式送过去：

1. `getPdfRuntime` 发送 `pdf.js` + `pdf.worker.mjs` 源码；client 把它们变成 Blob URL
   并从那里导入模块。
2. `GlobalWorkerOptions.workerSrc` 指向 worker Blob。（不要把 `Worker` 当作
   `PDFWorker.create({ port })` 传进去——那个字段要的是 `MessagePort`，会抛异常。）
3. CMaps 和标准字体通过 `getPdfAsset` 一个一个取。**中文 PDF 没有 CMaps 会渲染成空白**，
   而 Blob URL 模块没有基准路径让 pdfjs 去解析 `cmaps/`，所以 client 继承
   `DOMBinaryDataFactory`，让 Host 提供字节。资源名在读取任何文件前都做遍历校验。

## 测试

一条命令跑全部：

```powershell
node test\all.mjs "$env:USERPROFILE\Zotero\storage"
```

参数可以是任意一个装 PDF 的目录，指到你自己的库上即可。它每个门禁打一行，
只有全部通过才退出 0。需要 PDF 语料的门禁在没有语料时会**跳过**（并明确标注）——
跳过不是通过。

| 门禁 | 验证什么 |
|---|---|
| `s1-library` | 导入、按页存储、中英文检索 |
| `s2-host` | host 服务契约与错误形状 |
| `s3-evidence` | 证据锚定、矩阵、CSL 引用 |
| `s4-tools` | 工具注册与外部检索 |
| `s5-export` | 元数据编辑与导出包 |
| `s3-real-protocol` | 对真实 typert 协议的行为 |
| `s6-ocr` | 扫描件 → 可搜文本；退化扫描件；超大渲染 |
| `s7-functional` | 真实 PDF 上的完整工作流 |
| `s9-metadata` | 真实论文的标题/作者/期刊/年份抽取 |
| `s10-anchoring` | 引文偏移能扛住空白字符变化 |
| `s11-search` | 中文分词、AND 语义、trigram 索引同步 |
| `wiring` | client RPC ↔ host 方法；主题 token；无字面量颜色、无原始 HTML |
| `ui-render` | 每个视图都能渲染；字典一致；徽标状态互不相同 |
| `s8-ui-a11y` | 可访问名称、页签状态、覆盖声明的诚实性 |
| `s11-interaction` | 挂载真实面板，点遍页签，扛住快速连点 |
| `s12-reader-lifecycle` | 阅读器挂载/卸载、快速翻页、文档释放 |
| `s13-resilience` | 某个视图抛异常时面板仍存活且可恢复 |
| `s14-pdf-api` | 关闭逻辑用的 API 与真实装着的 PDF.js 一致 |
| `s15-teardown` | 哪些卸载路径接得住抛异常，哪些接不住 |

单个门禁也能独立跑，例如 `node test\s6-ocr.mjs`。

### 关于这套测试，两件值得知道的事

**UI 门禁挂载的是真实组件树。** `react-dom/server` 从不执行 `useEffect`，
所以发生在 effect 里的崩溃对它是隐形的。`s11`–`s13` 用 `react-dom/client`
打在一个手写的 DOM 桩上——白屏缺陷就是这么才终于复现出来的。

**`s14` 读的是真实装着的 `pdfjs-dist`，不信桩。** 早先有个门禁断言
`doc.destroy()` 被调用，因为它的假 PDF.js *有*这个方法。真实的 PDF.js 6 没有——
于是门禁一路绿灯，而真实环境每次关闭都崩。`s14` 现在对着真实的包断言，
另有 `node test\prove-s14.mjs` 在内存里把修复改回去、断言门禁**必须**失败，
因为一个不会失败的门禁不算门禁。

## 没有测到的部分

把这一点说清楚，比门禁数量更重要：

- **打字。** DOM 桩送不进按键到 React 的 `onChange`。一次专门排查找出三个桩缺陷、
  修好了其中两个，然后确认了 React 的 change 插件**根本没查值追踪器**（实测调用次数为 0）。
  `test/s16-typing.mjs` 就是那次排查，留成一个可运行的脚本。它在失败期间
  **刻意不注册进 `test/all.mjs`**，好让整套测试只为它能真正辩护的理由变绿——
  但这也意味着套件没有覆盖打字。在它通过之前，请把「搜索框能用」视为
  **本套件未验证**。
- **渲染出的像素。** 门禁能证明渲染路径被执行且不抛异常，无法证明画面是对的。
- **真实浏览器。** 开发沙箱禁止无头 Chrome（crashpad 访问被拒），
  所以这里每一条 UI 断言跑的都是手写 DOM，不是 Chromium。

## 许可

MIT，见 [LICENSE](LICENSE)。
