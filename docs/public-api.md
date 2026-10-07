# Public mini-program API

The authoritative route, authentication, DTO, pagination and error contract is [API.md](API.md). This page remains as a navigation entry for existing links; it no longer maintains a second route list or release-status table.

- API base: `https://nkustudy.top/api/v1`.
- [Route registry](API.md#接口总表): checked against source by `npm run check:api-docs`.
- [Response, cache and transport conventions](API.md#通用约定).
- [Public data and endpoint contracts](API.md#公共小程序-apiapiv1).
- [WeChat login and identity](API.md#小程序微信登录).
- [Web sessions, account DTO and favorites](API.md#网页用户会话与本人接口).
- [Account deletion](API.md#post-apiv1medelete-account).
- [Deployment and legal-domain configuration](DEPLOYMENT.md).

Content administration stays in the website's `/admin-api/*` interface. There is no public `/api/v1/admin*` compatibility surface. Course identifiers are immutable manifest `uid` values; resource downloads use the returned `download_url` at the configured public resource origin.

Existing callers should retain these distinctions: v1 returns `{code:0,data}`, while website legacy routes return `{ok,...}`; user Bearer and `nkustudy_web_session` credentials share the account store, and an explicit invalid Authorization header never falls back to a Cookie. New favorites use course UID; the favorites service accepts a legacy manifest `id` input and normalizes it, without making that editable key stable. The old `/api/v1/auth/phone` and proposed public report/resource-submission routes are not aliases; the registered phone endpoint is `/api/v1/auth/phone-verify`, and anonymous private complaints use `/feedback-api/report` or its documented legacy feedback alias.

Review submission may be pending or automatically public under the configured rules. New ordinary feedback requires an explicit publication approval; private complaints stay private, including after account deletion. For deletion, only `200` with `data.deleted=true` confirms necessary cleanup; `202` is accepted/disabled with cleanup pending. Neither a submission receipt nor an initiated download proves public visibility or external delivery. Current S3/S4/S5 source contracts are not production-deployment receipts.

Guides are served from the versioned `server/data/learning-compass-snapshot.json`, loaded by `server/learning-compass-service.mjs`. They are not read from an optional runtime `guides.json`. Use the API's category facets and detail/variant contracts, without hard-coding counts or copying the retired guide schema.

Before release, run `npm run check:api-docs` and the isolated `npm run smoke:public-api` checks documented in the [S2 acceptance report](compliance/S2_ACCEPTANCE.md). After an authorized deployment, `npm run baseline:search -- 化学` can collect the live public search version and expected recall. Local fixture checks do not establish production acceptance.
