# Social Comic Generator

把主题、观点或现成故事转成完整的 3:4 社交条漫生产包：传播角度、剧情、角色圣经、动态分页分格、完整漫画页、视觉验收、问题归因和发布文案。支持六种内置风格、自定义风格、系列角色锚点、原生文字和确定性后排版。

版本：`v0.3.7` · 运行时：Node.js 20+ · 许可证：AGPL-3.0-only

## 六种风格

| 风格 | 预览 |
| --- | --- |
| 极简涂鸦拟人 | ![极简涂鸦拟人](assets/previews/social-comic-style-01.webp) |
| 温暖日系教育漫画 | ![温暖日系教育漫画](assets/previews/social-comic-style-02.webp) |
| 韩式彩色网漫 | ![韩式彩色网漫](assets/previews/social-comic-style-03.webp) |
| 极简扁平信息漫画 | ![极简扁平信息漫画](assets/previews/social-comic-style-04.webp) |
| 黑白网点漫画 | ![黑白网点漫画](assets/previews/social-comic-style-05.webp) |
| 复古双色孔版印刷 | ![复古双色孔版印刷](assets/previews/social-comic-style-06.webp) |

证据边界：第 1 张来自正式 preset 的 reviewed + Eval pass 运行；第 2 张是最接近该风格的旧 custom 示例；第 3–6 张是已验收、视觉匹配的 custom matrix 示例。后五张用于风格展示，不等于相应正式 preset 已完成独立验收。完整哈希和来源记录见 `assets/previews/provenance.json`。

## 给 Codex 的安装指令

```text
请安装并使用这个固定版本的 Skill：
https://github.com/xuanqing-95/xuanqing-XHS-comic/releases/tag/v0.3.7

安装依赖并运行 npm run verify。优先使用 Codex 自带的 ImageGen；
如果当前环境没有生图工具，再提醒我配置自己的图片 API。
不要读取或复用其他项目里的 API Key。

安装完成后，使用 $social-comic-generator，
把“为什么越催孩子越慢”制作成一组完整的 3:4 社交条漫。
```

## 手动安装

仓库采用扁平 Skill 结构，`SKILL.md` 位于根目录。

```bash
git clone --branch v0.3.7 --depth 1 \
  https://github.com/xuanqing-95/xuanqing-XHS-comic.git \
  "$HOME/.agents/skills/social-comic-generator"
cd "$HOME/.agents/skills/social-comic-generator"
npm ci
npm run verify
```

Claude Code 可安装到 `$HOME/.claude/skills/social-comic-generator`。其他支持根目录 `SKILL.md` 的 Agent 环境也可使用同一份包。

`post-layout` 中文排版使用随包提供的 Noto Sans CJK SC 字体，并要求系统存在 `fc-query`（Fontconfig）。`npm run preflight` 会检查 Node、Sharp、字体文件、字体哈希和 Fontconfig。

## 两种生图方式

### Codex 自带 ImageGen

无需单独配置 API Key。按 `references/adapters/codex-builtin.md` 生成调用计划，再把宿主返回的原始 PNG 导入运行目录。宿主不暴露精确尺寸控制时，Skill 会如实测量和验收，不会通过裁剪、拉伸、补边或自动重画伪造通过。

### 自己的模型 API

为 planner、image 和 evaluator 提供兼容的非敏感路由 JSON，并用路由中的 `apiKeyEnv` 指向你自己的环境变量。任何供应商请求都必须显式传入 `--authorize-model-calls`；这类调用可能产生费用。不要把密钥写入 JSON、运行产物或 Git。

relay 是可选的宿主能力。声明 `relayTokenEnv` 且路由指向兼容 relay 时，大图会在请求体内压缩为 WebP 以满足 4 MiB JSON 上限；直连供应商路径仍保留原始输入字节和 multipart 行为。

## 自动执行

```bash
node scripts/run.mjs \
  --input /absolute/path/input.json \
  --run-dir /absolute/path/run \
  --stage all \
  --planner-route-json /absolute/path/planner-route.json \
  --image-route-json /absolute/path/image-route.json \
  --compositor-route-json /absolute/path/compositor-route.json \
  --evaluator-route-json /absolute/path/evaluator-route.json \
  --authorize-model-calls
```

不传 `--authorize-model-calls` 时不会发起模型请求。完整输入、运行阶段、产物和验收规则见 `SKILL.md` 及 `references/`。

## 本地验证

```bash
npm ci
npm run verify
```

验证覆盖根 Skill 结构、全部 JavaScript 语法、固定依赖与字体、六张预览哈希、适配器契约、交付清单、使用量收据、路由能力、Codex 交互适配、native/post-layout 执行器，以及 relay 压缩和直连字节保真。回环测试只监听本机，不调用真实模型。

运行产物默认写入使用者指定的目录。`.gitignore` 已排除 `.env`、`runs/`、`output/`、日志和 `node_modules/`。

## License

代码、工作流、提示词、文档和项目自产预览图采用 GNU Affero General Public License v3.0 only，详见 `LICENSE` 与 `NOTICE.md`。内置字体采用 SIL Open Font License 1.1；Sharp 是安装时获取的外部 npm 依赖。第三方说明见 `THIRD_PARTY_NOTICES.md`。
