# WeRead AI · 微信读书智能阅读助手

一个嵌入微信读书阅读场景的本地 AI 阅读记忆工具，帮助用户标记关键情节、回顾阅读进度，并把划线和总结沉淀到 Obsidian。

展示入口：[产品页面与 MVP Demo](https://58wpg9fr7d-code.github.io/weread-ai-reading-assistant/) · [GitHub 源码](https://github.com/58wpg9fr7d-code/weread-ai-reading-assistant)

## 项目定位

这是一个个人 AI 工具型项目，重点解决长篇阅读中的进度断裂、重点难回顾和划线难沉淀问题。项目采用“浏览器扩展 + 本地 API + 本地知识库出口”的方式，保留用户对节点、阅读历史和导出路径的控制权。

## 核心功能

| 功能 | 说明 |
|---|---|
| 情节节点 | AI 根据章节目录提取关键转折点，在阅读进度条上标记，并支持手动编辑 |
| 阅读回顾 | 根据最近一次或全部阅读记录生成回顾 |
| 笔记导出 | 将划线整理为结构化 Markdown，写入用户指定的 Obsidian Vault |
| 全书总结 | 根据章节节点生成书籍总结，并导出为 Markdown |

## 文件结构

```text
weRead-extension/
├── manifest.json       # Chrome 扩展配置
├── background.js       # 持久化状态与消息桥接
├── content.js          # 阅读页侧边栏、进度节点和 API 调用
├── content.css         # 扩展界面样式
├── popup.html          # 配置页
└── popup.js            # API 地址和 Vault 路径配置
weread_api.py           # FastAPI 本地服务
docs/                   # 项目案例、架构和验证记录
demo/                   # 无需 API Key 的静态产品体验 Demo
```

## 本地运行

### 1. 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. 配置模型服务

```bash
export GEMINI_API_KEY='你的 key'
export GEMINI_MODEL='gemini-3.5-flash-lite'
```

API Key 只从环境变量读取，不能写入代码、扩展文件或 GitHub。

### 3. 启动 API

```bash
python weread_api.py
```

服务默认运行在 `http://localhost:8001`，可用下面的地址检查：

```bash
curl --noproxy '*' http://localhost:8001/api/health
```

### 4. 加载 Chrome 扩展

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目的 `weRead-extension/` 文件夹。
5. 打开微信读书网页版的阅读页面，在扩展弹窗中确认 API 地址和 Obsidian Vault 路径。

## API

| 端点 | 用途 |
|---|---|
| `GET /api/health` | 检查服务和模型配置状态 |
| `POST /api/analyze-chapters` | 根据章节目录生成关键情节节点 |
| `POST /api/review` | 生成最近一次或全部已读内容的回顾 |
| `POST /api/export-notes` | 整理划线并写入 Obsidian |
| `POST /api/export-summary` | 导出基于节点的全书总结 |

## 验证与边界

当前已验证服务可启动、健康检查和 OpenAPI 可访问；未配置 Key 时会明确返回配置错误。由于扩展依赖微信读书页面 DOM，真实页面兼容性需要在 Chrome 登录后继续验证。由于导出目标是本机 Obsidian 路径，当前项目以本地运行验证和 GitHub 源码展示为主，不直接宣称公开部署。

更多材料见：

- [产品 PRD](PRD.md)
- [静态 MVP 体验 Demo](demo/index.html)
- [项目案例说明](docs/PROJECT_CASE.md)
- [架构说明](docs/architecture.md)
- [验证记录](docs/verification.md)
