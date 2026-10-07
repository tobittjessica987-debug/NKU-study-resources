# S6 文档一致性盘点与本地修正

2026-10-07。盘点基线 `6c17f679fb5dbb8591466240377ca9cd1b13f762`。先阅读 DOC-18/GOV-16/S6 要求、C-08/C-13/C-14/C-17 及 S4/S5 验收、政策和运维说明，再核对下列源码。本子任务独占 README、API、public-api、data-schema、SOP；未切分支、提交、推送、部署、发送消息/资料、读取生产个人数据或改共享验收总账。

## 基线差异及实际修正

| 基线文档差异 | 修正及代码依据 |
|---|---|
| README 写评价一律先审、举报需手机号、S3/S4/S5 整改已落地 | 改为评价配置规则自动公开/待审、新普通反馈默认待审、匿名私密投诉始终私密、C-14 历史实际公开及回复保持；明确生产未部署。依据 `review-submission-service.mjs:107`、`moderation-model.mjs:61`、`admin-server.mjs:handleFeedbackSubmit`、API 的 S3 处置契约及 S4/S5 验收。 |
| README 写 law.manage 独立门槛、批量处置、全部保存都构建 | 改为所有有效管理员查询/导出、对外另走受控交付；单条 CAS 与设置/页面构建分别说明，批量/合并/条目删除未交付。依据 `admin-server.mjs:2871–2918`、`admin-route-permissions.mjs:law-*` 和 `moderation-service.mjs`。 |
| README/API 写 8h/30min 会话、旧 Cookie 名/签名身份和“无自定义 header” | 服务入口实际分别传 7 天绝对/空闲期限；Cookie 为 `__Host-nkustudy_admin` 随机令牌，HMAC 摘要存库；写请求需要 Origin 和固定 `X-NKUStudy-Admin-Request`。说明类自身默认不能冒充入口值、Cookie Max-Age 固定 7 天与服务端期限分别生效，并补调用示例请求头。依据 `admin-server.mjs:157–161,971,2618–2654`、`admin-session-store.mjs:6–7,84–96`。 |
| API 写数据库不存 OpenID、个人主体手机号假设、已实现登录/收藏仍列“未开放” | 区分服务器原 OpenID/手机号、普通用户白名单、管理列表掩码及受控账号查询原值；删除旧未实现断言，补网页会话/本人/收藏/注销契约及兼容说明。依据 `user-identity.mjs:27`、`mp-auth-service.mjs:102–135,286–319,364–389`、`public-api-router.mjs:164–365`、`law-query-service.mjs:publicAccount`、`mp-favorites-service.mjs:resolveCourse`。 |
| data-schema 只写频控，不存原 IP、旧访客会去 IP、收藏 UID 为未来、guide 旧四分类 runtime 数据源 | 补账号/头像/email/收藏/支付/日志/备份/账本盘点；频控摘要与原始 IP 日志分开；近期访客保存原 IP，24h/5000 清理与400日期键统计分开。收藏实际列名 course_id 储 UID、兼容旧输入；guide 实际为版本化学习指南针快照。依据 `admin-server.mjs:1185,1242–1266`、`user-security-log-store.mjs:55`、`admin-accounts-store.mjs:293`、`learning-compass-service.mjs:16–34`。 |
| README/API 未完整表达 S5 受理/清理/历史例外，SOP 仍称 D-01 未决 | 明确 C-17 保留内容并清业务身份已决定；200 deleted=true 和202 pending区别；私密内容及原公开状态保持、正文自述信息不自动消除、必要付款事实保留、无键旧昵称人工核对、源头像与旧缓存区别；最小账本/作业、受限日志及历史加密备份例外与隔离恢复明确。依据 `account-content-cleanup.mjs:7–11,53–75`、`account-deletion-service.mjs:36–102`、`deletion-ledger.mjs:12–13,51`、`runtime-backup.mjs:76–119`、`restore-reconciliation.mjs:20–21,166–169`、S5_POLICY/OPERATIONS。 |
| README 固定旧测试/路由数、全量 ETag、生产安全/备份通过泛化 | 以当前权威验收链接代替易漂移的数字与大范围通过断言，正确区分 no-store/ETag、运行备份范围和实际私密远端待验；路由131对通过仅证明登记一致。 |
| SOP 缺 S5 分类、现实公司/值守/保留/生产事实待办 | 补独立章节及现实待确认表，不编造公司全称/地址、人员排班、响应或法定期限。公司运营主体事实采用现有确认；缺完整信息明确待负责人核实。 |

`docs/public-api.md` 基线已经合并为主文档入口，保留该结构，并补有用调用兼容要点与主体契约链接，没有恢复第二份路由表。未改 `server/default-privacy.mjs` 或 `src/pages/privacy.astro`：现有 S5 文案使用“本平台运营主体”、涵盖身份/注销例外；主窗口确认先保留已验运行文案。已知旧默认精确升级、自定义保留并提示复核、现行规则先展示的机制不能被文档修正当作生产 HTML 已读回。

## 检查与边界

- `node scripts/check-api-docs.mjs`：退出0，131个 method/path 一致，见 `api-route-check.log`。
- 本子任务5份文档 `git diff --check`：退出0，见 `diff-check.log`。
- 相对本地 Markdown 链接目标存在检查：0缺失，见 `local-links.json`；不检验外网可达性或全部锚点。
- 人工按业务语义对照身份/会话、公开gate、S4范围/权限、S5逐类策略、日志与备份；源码/文档采样 SHA-256 见 `summary.json`。

未跑应用全套、全库类型检查、新浏览器/生产政策读回、真实远端存储/缓存验证；没有外部法律调研，也没有新增法定期限。此次通过不是 GOV-16/DOC-18 生产闭环或全部整改通过。

## 尚缺的运营决定或事实

1. 公司完整名称、适用地址和现有公开联系渠道及正式政策/申报版本，均待负责人核实填写。
2. 真实投诉值守、代班、私密受理及异常升级渠道和交接记录；不编造法定/承诺响应期限。
3. 业务内容、私密投诉、支付事实、法定/受限日志、最小注销账本/作业、案件档案、历史本地/远端备份的分类期限、依据和实际到期处理；已有400天工程配置继续保留，不拿它概括所有数据。
4. 真正受控对外交付的核验/批准、最终文件私密权限及哈希、传递和同文件接收确认；S4合成演练及内部下载不能代替。
5. 固定候选生产迁移、入口日志拓扑/窗口/容量、私密远端读回、S4实际角色/落盘、S5最新账本恢复、远端头像/旧缓存/无归属旧记录、自定义隐私及最终发布 HTML 的回执。

上述缺项不阻塞已能修正的本地文档；共有总账/计划由主窗口统筹。
