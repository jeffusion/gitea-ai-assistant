# [1.1.0](https://github.com/Jeffusion/gitea-ai-assistant/compare/v1.0.0...v1.1.0) (2026-03-24)


### Bug Fixes

* **agent:** fix rg args ordering in function reference search tool ([f410373](https://github.com/Jeffusion/gitea-ai-assistant/commit/f410373f7b1b935047fb5f50fad7c95a870704a8))
* **agent:** improve specialist agent JSON resilience and finding schema ([2587576](https://github.com/Jeffusion/gitea-ai-assistant/commit/2587576514b353ff3a1314b54cf85c977a66f62e))
* **ci:** stabilize visual regression environment ([9887504](https://github.com/Jeffusion/gitea-ai-assistant/commit/98875044d6b514d253a90cfcc445ac2f5253b278))
* **config:** make persistOverrides resilient to read-only filesystems ([3f2817d](https://github.com/Jeffusion/gitea-ai-assistant/commit/3f2817d6c306c024a7200f36e087dd15c97bcad8))
* **config:** silently skip readonly fields on save instead of rejecting ([12425d1](https://github.com/Jeffusion/gitea-ai-assistant/commit/12425d147f3ec0c202b2d9a347836d5515e9b702))
* **docker:** add git, ca-certificates, and ripgrep to production image ([ba26635](https://github.com/Jeffusion/gitea-ai-assistant/commit/ba2663552d77321bb91ef112fa4bbebb65a5585c))
* **frontend:** standardize favicon/title, 401 redirect, SPA root route, and theme switching ([5bb1c3a](https://github.com/Jeffusion/gitea-ai-assistant/commit/5bb1c3a2d182dcde65667c39f2a61eaf1d43b706))
* **k8s:** extract Secret to separate file to fix kustomize apply ([e3b8365](https://github.com/Jeffusion/gitea-ai-assistant/commit/e3b8365ea2992162b2f575bb84af73352ef375ca))
* **k8s:** remove stale GITEA_ACCESS_TOKEN/GITEA_API_URL/QDRANT_URL from k8s config ([9b063af](https://github.com/Jeffusion/gitea-ai-assistant/commit/9b063afba0046d50ba691efe1f45159b97c2149e))
* **k8s:** use writable emptyDir volume for config overrides ([98e5048](https://github.com/Jeffusion/gitea-ai-assistant/commit/98e5048f2c898966ab59c2c806477bac2e443869))
* **lint:** resolve biome violations across src modules ([3c1d616](https://github.com/Jeffusion/gitea-ai-assistant/commit/3c1d616dc180d53232eccca05255ca853084ab23))
* make all config consumers read dynamically instead of caching at module load ([9a356a2](https://github.com/Jeffusion/gitea-ai-assistant/commit/9a356a228f11c07495e5d60eb6c6554a42ec4434))
* make FEISHU_WEBHOOK_URL optional to prevent startup crash ([d84a0ed](https://github.com/Jeffusion/gitea-ai-assistant/commit/d84a0ed95614fc954fdf7b7f6725ede4e32d76f3))
* remove isDev branches that caused production to use mock test data ([f3ba9de](https://github.com/Jeffusion/gitea-ai-assistant/commit/f3ba9de06f5f51ebf44e13a7e1db8f9d264d9034))
* **test:** update specialist-agent-react tests for LLMGateway API ([824564d](https://github.com/Jeffusion/gitea-ai-assistant/commit/824564dac6bddd7439ef40f3c0da946d9634201f))
* **ui:** align card headers and stabilize themed layout polish ([28d86af](https://github.com/Jeffusion/gitea-ai-assistant/commit/28d86aff16f954cd18c0e46b86325a13fc6c0949))


### Features

* **config:** add Codex engine configuration fields ([129094a](https://github.com/Jeffusion/gitea-ai-assistant/commit/129094a39e77b0bb66b052ed19bb8969d1757503))
* **config:** add global prompt setting injected into all LLM calls ([afd5685](https://github.com/Jeffusion/gitea-ai-assistant/commit/afd568588d1722206314009cd0b9060125fac883))
* **config:** migrate all runtime settings from env vars to SQLite DB ([4c32a46](https://github.com/Jeffusion/gitea-ai-assistant/commit/4c32a460d39e277b1ee59fec31a171f162c83f22))
* **db:** add SQLite database layer with encrypted secret storage ([21fef99](https://github.com/Jeffusion/gitea-ai-assistant/commit/21fef999fbca56c07b93cd9109d8e7dfd50bbf31))
* **frontend:** update config UI for DB-first config architecture ([9c9ef05](https://github.com/Jeffusion/gitea-ai-assistant/commit/9c9ef05d13962586cbd0decb2377d003a8901679))
* **llm:** add LLM config REST API controller ([c6c8e20](https://github.com/Jeffusion/gitea-ai-assistant/commit/c6c8e2068331bdfe344f92f53cd6fffc7758cfac))
* **llm:** add pluggable multi-provider LLM architecture ([c9a2db3](https://github.com/Jeffusion/gitea-ai-assistant/commit/c9a2db3df2c73ef22cb2c32fd80bdf36bfa1e697))
* **llm:** add resilience layer with rate limiting and retry ([839d4a8](https://github.com/Jeffusion/gitea-ai-assistant/commit/839d4a89bfd763d7fe693c00c3aa9b1becd34c58))
* **review/codex:** add Codex review engine with MCP tools ([614f66c](https://github.com/Jeffusion/gitea-ai-assistant/commit/614f66c433a93fc2373a9bf8d2319bd5cb35473b))
* **review:** add incremental review with snapshot refs ([9308c60](https://github.com/Jeffusion/gitea-ai-assistant/commit/9308c60aa014c0dd016d984a6b3d1cfb1e3a9379))
* **review:** add token-aware context control with tokenlens ([ec2029a](https://github.com/Jeffusion/gitea-ai-assistant/commit/ec2029a94261169832477f9c7aaa4ee1ad1adefc))
* **review:** add triage agent for smart specialist routing ([86480de](https://github.com/Jeffusion/gitea-ai-assistant/commit/86480dec076661315f725b286e65d57092ceb30b))
* **review:** add workspace cleanup on PR close and scheduled stale cleanup ([792ed7f](https://github.com/Jeffusion/gitea-ai-assistant/commit/792ed7faa2b89bb0f4c84dcf032e30a34286b77b))
* **review:** remove legacy mode and harden agent/codex pipeline ([1c0c9af](https://github.com/Jeffusion/gitea-ai-assistant/commit/1c0c9afd1779a15e55edc7a854924e86cbb50cf3))
* **ui:** add frontend test infrastructure with vitest ([bc7616d](https://github.com/Jeffusion/gitea-ai-assistant/commit/bc7616df424e26d6b20105f6401329e63e9013ef))
* **ui:** add LLM provider management frontend ([c45cb34](https://github.com/Jeffusion/gitea-ai-assistant/commit/c45cb34a358393a0b6e0523fd282ee3d49fbff82))
* **ui:** add review config page with engine selector ([ae0dfce](https://github.com/Jeffusion/gitea-ai-assistant/commit/ae0dfceba1e626fddf75d60e982f81c953aaddd6))
* **ui:** replace hardcoded model lists with dynamic tokenlens API ([71bd310](https://github.com/Jeffusion/gitea-ai-assistant/commit/71bd310459901ed665eb1337d17bb4bec9ca9c3e))

# 1.0.0 (2026-03-03)


### Bug Fixes

* remove trailing comma in package.json ([c1d3077](https://github.com/jeffusion/gitea-ai-assistant/commit/c1d3077654e075e6d75e2963b196c8fe2641d10e))
* 修复E2E测试基础设施 ([e91ebdc](https://github.com/jeffusion/gitea-ai-assistant/commit/e91ebdc974edbfc33f029a0f8befa7fbaf59a77c))


### Features

* **admin:** 添加后台管理界面和Webhook管理功能 ([3a0cb36](https://github.com/jeffusion/gitea-ai-assistant/commit/3a0cb36f028ee5581ddc44a19f89037a3c1220f1))
* **api:** add config management REST endpoints ([d375a4c](https://github.com/jeffusion/gitea-ai-assistant/commit/d375a4c82dfb61aaec0330734dcad24c829114fa))
* **config:** add runtime config manager with 3-layer priority ([d946423](https://github.com/jeffusion/gitea-ai-assistant/commit/d946423d4554f816100c2b3e7157d11c00e0a029))
* **frontend:** add config management page with UI components ([f223e35](https://github.com/jeffusion/gitea-ai-assistant/commit/f223e35cbbdb8bcc7bc5259d4522ed246cf401c2))
* **frontend:** add react-router and refactor app routing ([0b5cbfd](https://github.com/jeffusion/gitea-ai-assistant/commit/0b5cbfd5ba97129e498f02fb4c31cdb414d34925))
* 增加pr提醒,支持飞书机器人消息通知 ([e9d4f67](https://github.com/jeffusion/gitea-ai-assistant/commit/e9d4f6776c5750367785757224f6aa03c77972aa))
* 添加Agent审查引擎核心类型和Schema定义 ([4c90bf0](https://github.com/jeffusion/gitea-ai-assistant/commit/4c90bf0b9c17adf4994bd6f40b3b2c97347ee61b))
* 添加Agent审查相关配置项和依赖 ([611fcf3](https://github.com/jeffusion/gitea-ai-assistant/commit/611fcf39d51654b90b8047cc31e2ca119249990f))
* 添加发布策略和文件审查存储 ([5ddd858](https://github.com/jeffusion/gitea-ai-assistant/commit/5ddd8587858785daccce7789371cdb262581cc99))
* 添加向量记忆和学习系统 ([956a84a](https://github.com/jeffusion/gitea-ai-assistant/commit/956a84acc11beffb0d64abd4098e6e319ec51ea7))
* 添加四个分类专家Agent定义 ([4b58f15](https://github.com/jeffusion/gitea-ai-assistant/commit/4b58f158fc9fc59f0eac04616593b2061121e119))
* 添加多Agent审查代理(specialist/reflexion/judge/critic/debate) ([1d9ed3d](https://github.com/jeffusion/gitea-ai-assistant/commit/1d9ed3d969ddead2384a35d884a59c6269e1639f))
* 添加审查编排器和引擎入口 ([25d4f56](https://github.com/jeffusion/gitea-ai-assistant/commit/25d4f56bded0fd86caa2671f36f1e713ea8bbe88))
* 添加工具注册表和代码搜索工具 ([6186210](https://github.com/jeffusion/gitea-ai-assistant/commit/6186210b4e41cea67f04ea8619924449e953dbb8))
* 添加沙箱执行和本地仓库管理器 ([d1e1e2f](https://github.com/jeffusion/gitea-ai-assistant/commit/d1e1e2f33cc3e49d10bc0119af89f7ba4068a1f8))
* 集成Agent审查引擎到应用入口和控制器 ([2ce2a5f](https://github.com/jeffusion/gitea-ai-assistant/commit/2ce2a5f6a6140ed4d3222363fd261735d3f295f2))
* 项目更名并调整接口 ([b8e5c5e](https://github.com/jeffusion/gitea-ai-assistant/commit/b8e5c5eb41738c7d9b14325da0c8524e7e38e662))
