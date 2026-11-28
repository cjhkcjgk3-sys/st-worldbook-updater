# AI 协作说明

本文件写给所有参与本仓库开发的 AI（Codex、GPT、Gemini、Claude、Grok 等）。

<!-- ai-dev-lessons:start -->

## 开工前必读：AI 经验仓库

> 本段是 [ai-dev-lessons](https://github.com/cjhkcjgk3-sys/ai-dev-lessons) 的共享入口。本文件其余内容补充本项目专属约定；适用范围、规则效力和冲突按[仓库规范](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/仓库规范.md#规则优先级与冲突裁决)判断。

1. **按任务查阅**：先读[仓库规范](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/仓库规范.md)和[总索引](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/总索引.md)，再读适用的正式正文。软件开发同时阅读[工作流程](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/工作流程.md)、[通用准则](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/通用准则.md)和相关[检查清单](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/检查清单.md)。不默认通读整个 `正式/`、其他模型专项或历史；关键要求读不到就如实说明。开工汇报写明适用条目及具体做法。
2. **先查能不能复用**：本仓库已有代码、SillyTavern 自带功能、兄弟插件，汇报里写明查了哪些。
3. **大改先提方案**：改布局、改交互方式、改数据格式、删功能前，按[方案确认](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/方案确认.md)取得用户授权；同一范围已经授权的不重复确认。
4. **第三次就停**：同一问题修到第 3 次还没好，停止打补丁，按[重新设计](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/重新设计.md)交方案，等用户确认。
5. **边做边记，分清通用和专门**：只在本插件出现的专门问题记在本仓库 [docs/问题记录.md](docs/问题记录.md)；可跨项目复用的经验经授权公开后，按[待审条目](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/待审条目.md)交到 ai-dev-lessons 的 `待审/`，本仓库只留一行链接；拿不准的先记本仓库并标“可能通用”。小问题写清原因、解决、状态，大问题写完整（[小](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/问题记录-小.md)／[大](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/问题记录-大.md)）。
6. **版本更新要署名**：谁做正式的版本更新或合并，谁就在 `CHANGELOG.md` 对应版本标题下写一行 `更新人：家族名`（Grok、GPT、Gemini、Claude、DeepSeek，用户自己改的写 human），只写家族名不写型号。只读、查看、审查不用署名；从下一次版本更新开始执行，以前的版本不补。
7. **主动完成交付**：在已授权范围内，按[仓库规范](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/仓库规范.md#主动交付与持续授权)完成必要检查、提交、推送及需要的合并，核对远端结果。常规可恢复操作不等重复指令；按[交付汇报](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/模板/交付汇报.md)说明结果、未验证项和同一问题的修复次数。
8. **按证据继承验证**：遵循[跨模型验证互认与继承](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/仓库规范.md#跨模型验证互认与继承)，适用且有效的记录可跨会话、跨模型复用；只复核因正文、版本、环境变化或反例而受影响的内容，不能替代当前任务必需的验收。`待审/` 不是正式规则；经验内容的修订、公开范围与留痕按[仓库规范](https://github.com/cjhkcjgk3-sys/ai-dev-lessons/blob/main/正式/仓库规范.md)执行。

<!-- ai-dev-lessons:end -->
