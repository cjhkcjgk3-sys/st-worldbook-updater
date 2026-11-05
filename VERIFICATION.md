# v1.1.0 检查记录

日期：2026-11-05。基线为 v1.0.0，本次加入条目融合及批量操作完整性改进。

| 检查项 | 结果与证据范围 |
| --- | --- |
| 清单与语法 | manifest 验证通过，无错误或弃用字段警告；运行模块与测试脚本通过语法检查 |
| 数据与异常测试 | 46 项 Node.js 测试通过，含原有更新与备份回归、融合、编号避让、重复来源、导出表示、容量与失败保护 |
| 浏览器交互 | Chromium 153.0.8010.0，本地模拟酒馆宿主，23 组检查通过，记录见 tests/browser-result.json |
| 八组尺寸 | 320×568、360×720、390×844、768×1024、1280×900、600×360、640×360、740×360 |
| 可视区域变化 | 模拟搜索键盘压缩可视视口到 380px，列表和底部操作保持可见 |
| 真实酒馆与手机 | 用户的安装、真实宿主事件和设备触摸仍待试用验证 |

## 本次操作完整性检查

| 功能 | 已检查的行为 |
| --- | --- |
| 批量勾选 | 全选、部分勾选后直接全部取消；左右复选框同步 |
| 分组勾选 | 融合时可只选更新或只选新增，均在同一菜单内完成 |
| 搜索后的全选 | 对整组数据生效，包含搜索隐藏项，界面明确提示范围 |
| 模式切换 | 保留勾选意图，全部取消后切换完整范围也不会偷偷恢复勾选 |
| 配对批量入口 | 所选配对、解除所选、解除全部和重新自动匹配集中在一个菜单 |
| 新条目处理 | 独有条目可勾选；待处理项可标记新增并取消；重复项跳过 |
| 正文查看 | 已配对对照及单侧新条目查看共用原入口 |
| 空数据 | 空原书可以融合新增；空来源明确提示并禁止无内容执行 |
| 确认取消 | 不写入目标书、不覆盖备份，保留当前选择 |
| 融合执行 | 更新与新增一次提交，新增编号不碰撞，保留原书独有条目 |
| 重复操作 | 保存后重新载入相同来源，不重复追加，不移动已有条目列表位置 |
| 备份恢复 | 可撤销本次更新及新增，网页刷新后仍能恢复 |
| 失败保护 | 备份失败不写入；保存 HTTP 失败不误报成功；断线后重新核验，不盲目重试 |
| 界面精简 | 没有独立融合按钮；范围下拉框和原主按钮复用；配对工具栏仅保留一个菜单及正文查看按钮 |

## 接口依据

官方 SillyTavern 1.18.0、1.19.0 上下文及世界书接口。1.19.0 固定提交：`7e8663cd9c184a550b37238218bdd32c6efc68e9`。

- [上下文接口](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/st-context.js)：getRequestHeaders、loadWorldInfo、saveWorldInfo、reloadWorldInfoEditor、accountStorage。
- [世界书及编号分配](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/world-info.js)：保存、缓存、未占用编号、Character Book 导出字段对应关系。本次重新核对了条目创建和转换逻辑。
- [服务器接口](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/endpoints/worldinfo.js)：list、get、edit。
- [扩展生命周期](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/extensions.js)及[账号存储](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/util/AccountStorage.js)。

读写沿用原生能力，保存后从服务器回读。原生保存函数可能在 HTTP 失败时正常返回，因此仅凭 Promise 完成不能认定保存成功。v1.1 的新增与更新共同进入原有备份、变更检测、单次保存和核验流程，未新增远程服务或运行依赖。

## 尚待实机验收

浏览器自动检查使用真实 Chromium 与 IndexedDB、本地模拟酒馆接口；尚未取得用户实际安装版本与能力快照，真实宿主检查仍按 capability-contract.json 进行。

安装后用 examples 完成一轮更新，再选择“融合 · 仅正文”试新增；检查全选/全部取消与仅选新增；重新载入确认不重复追加；最后恢复备份并检查原书、绑定和原生编辑器显示。

用户真实酒馆安装及真实手机操作验收与上述自动检查分别记录。
