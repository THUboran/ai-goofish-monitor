# dsh-xianyu-monitor — DeepSeek Harness 插件

这是给 [ai-goofish-monitor](../README.md)（上游 `Usagi-org/ai-goofish-monitor`）配套的 **DeepSeek Harness (DSH) 工具插件**，把本地闲鱼监控后端的三个能力暴露成 AI 可直接调用的工具：`xianyu_search` / `xianyu_results` / `xianyu_service`。

## 与上游的关系

- 后端本体完全来自上游 `Usagi-org/ai-goofish-monitor`，本 Fork 未改动其源码。
- `dsh-plugin/` 是本项目新增的目录，用于把后端接入 DSH。

## 安装

前提：后端已在 `http://127.0.0.1:8000` 运行（见仓库根目录 `run.sh`）。

把本目录放到 DSH profile 的 `node_modules/dsh-xianyu-monitor`，并在 profile 的 Cordis 补丁中启用该 loader 条目（见 `cordis.patch.yml`）。

## 工具说明

| 工具 | 作用 |
|---|---|
| `xianyu_search` | 按关键词 + 自然语言需求跑一次搜索 + AI 捡漏判定（耗时数分钟） |
| `xianyu_results` | 查已抓取结果，不重新爬 |
| `xianyu_service` | 后端/账号/任务状态自检，排查「为什么搜不了」 |

## 已知契约

`output.render` 必须返回 DSH 的 content block 数组 `[{ type: "text", text: "…" }]`，不能直接返回字符串——否则框架层会报 `content.some is not a function`。

## 许可

继承上游 MIT License。
