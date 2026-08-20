"""
WeRead AI API 服务 —— 为微信读书插件提供后端支持。
启动: python weread_api.py
端口: 8001
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── 常量 ──
# 使用 Gemini REST API，避免把密钥放进 URL；密钥只从运行环境读取。
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# ── FastAPI ──
app = FastAPI(title="WeRead AI API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 请求/响应模型 ──
class ChapterItem(BaseModel):
    index: int
    title: str

class AnalyzeRequest(BaseModel):
    bookId: str
    bookTitle: str
    chapters: list[ChapterItem]

class ChapterNode(BaseModel):
    id: str
    title: str
    percent: float
    color: str = "#2563EB"

class AnalyzeResponse(BaseModel):
    nodes: list[ChapterNode]

class ReviewRequest(BaseModel):
    bookId: str
    bookTitle: str
    scope: str  # "last" or "all"
    lastSession: dict | None = None
    allSessions: list[dict] | None = None

class ReviewResponse(BaseModel):
    summary: str

class HighlightItem(BaseModel):
    pass  # 使用动态 dict

class ExportNotesRequest(BaseModel):
    bookId: str
    bookTitle: str
    highlights: list[str]
    vaultPath: str = ""

class ExportNotesResponse(BaseModel):
    file: str
    path: str

class ExportSummaryRequest(BaseModel):
    bookId: str
    bookTitle: str
    nodes: list[dict]
    vaultPath: str = ""

class ExportSummaryResponse(BaseModel):
    file: str
    path: str


# ── LLM 调用 ──
def call_llm(system_prompt: str, user_prompt: str, temperature: float = 0.3) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY 未设置")

    r = requests.post(
        GEMINI_URL,
        headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
        json={
            "systemInstruction": {
                "parts": [{"text": system_prompt}],
            },
            "contents": [{
                "role": "user",
                "parts": [{"text": user_prompt}],
            }],
            "generationConfig": {
                "temperature": temperature,
            },
        },
        timeout=60,
    )
    if not r.ok:
        detail = r.text[:800].replace(GEMINI_API_KEY, "[REDACTED]")
        raise RuntimeError(f"Gemini 请求失败 ({r.status_code}): {detail}")
    data = r.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Gemini 返回内容格式异常: {data}") from exc


# ── API: 章节分析 ──
@app.post("/api/analyze-chapters", response_model=AnalyzeResponse)
def analyze_chapters(req: AnalyzeRequest):
    """分析一本书的章节目录，返回关键情节节点（标注在进度条上）。"""
    if len(req.chapters) < 3:
        raise HTTPException(status_code=400, detail="章节数量太少，至少需要 3 章")

    # 拼接章节信息
    chapter_list = "\n".join(
        f"{ch.index + 1}. {ch.title}" for ch in req.chapters
    )

    system = """你是一个文学编辑。根据一本书的章节目录，找出最重要的情节转折点 / 关键章节。

要求：
1. 选出 5-10 个最关键的章节节点（不要所有章节都标注）
2. 每个节点包含：章节标题（精简到 15 字以内）、大约在全书进度的百分比位置
3. 节点应该覆盖开头、发展、高潮、结局，形成完整的故事弧线
4. 只返回 JSON 数组，不要任何解释文字

返回格式：
[{"title": "节点名称", "percent": 数字}, ...]"""

    user = f"""书名：{req.bookTitle}

章节目录：
{chapter_list}

请选出 5-10 个关键情节节点，按时间顺序排列。"""

    try:
        result = call_llm(system, user)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {exc}")

    # 解析 JSON
    try:
        # 提取 JSON 数组
        json_match = re.search(r"\[.*\]", result, re.DOTALL)
        if not json_match:
            raise ValueError("未找到 JSON 数组")
        import json
        raw_nodes = json.loads(json_match.group())
    except Exception:
        raise HTTPException(status_code=500, detail=f"解析 AI 返回失败: {result[:200]}")

    # 规范化
    nodes = []
    colors = ["#2563EB", "#7C3AED", "#059669", "#D97706", "#DC2626", "#0891B2", "#4F46E5", "#B45309"]
    for i, n in enumerate(raw_nodes):
        nodes.append(ChapterNode(
            id=f"node_{i}",
            title=str(n.get("title", f"节点{i+1}"))[:20],
            percent=max(1, min(99, float(n.get("percent", (i + 1) * 100 / len(raw_nodes))))),
            color=colors[i % len(colors)],
        ))

    return AnalyzeResponse(nodes=nodes)


# ── API: 阅读回顾 ──
@app.post("/api/review", response_model=ReviewResponse)
def review_reading(req: ReviewRequest):
    """生成阅读回顾：上次内容 or 全部已读内容。"""

    if req.scope == "last" and req.lastSession:
        system = "你是一个阅读助手。根据用户上次阅读的进度范围，简洁地总结那段内容的核心情节和关键信息。如果有悬念或伏笔，请特别指出。用 3-5 句话，中文。"
        user = f"""书名：{req.bookTitle}
上次阅读范围：全书的 {req.lastSession.get('startPercent', '?')}% 到 {req.lastSession.get('endPercent', '?')}%

请总结用户上次读的这一段内容。"""

    elif req.scope == "all" and req.allSessions:
        sessions_desc = "\n".join(
            f"第{i+1}次：{s.get('startPercent','?')}% → {s.get('endPercent','?')}% ({s.get('timestamp','?')})"
            for i, s in enumerate(req.allSessions[-10:])
        )
        system = "你是一个阅读助手。根据用户的多次阅读记录，生成一份全书的阅读总结。按时间线梳理核心情节发展，指出重要的伏笔和转折。最后给出一条阅读建议（接下来该关注什么）。中文。"
        user = f"""书名：{req.bookTitle}
阅读记录（最近 10 次）：
{sessions_desc}

请生成全书的阅读总结。"""

    else:
        raise HTTPException(status_code=400, detail="请提供有效的阅读记录")

    try:
        result = call_llm(system, user, temperature=0.4)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {exc}")

    return ReviewResponse(summary=result)


# ── API: 导出笔记 ──
@app.post("/api/export-notes")
def export_notes(req: ExportNotesRequest):
    """将划线笔记整理成结构化 markdown，写入 Obsidian vault。"""

    if not req.highlights:
        raise HTTPException(status_code=400, detail="没有可导出的划线内容")

    highlights_text = "\n".join(f"- {h}" for h in req.highlights)

    system = """你是一个知识管理助手。将用户的读书划线内容整理成结构化的笔记。

要求：
1. 按主题分类（不是按时间顺序），每类 3-5 条
2. 每个主题加一个 ## 标题
3. 关键观点用 **加粗**
4. 最后加一个「#核心收获」区域，列出 3 条最重要的 takeaway
5. 纯 Markdown 格式，不要其他解释文字"""

    user = f"""书名：{req.bookTitle}

划线内容：
{highlights_text}

请整理成结构化笔记。"""

    try:
        markdown = call_llm(system, user, temperature=0.3)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {exc}")

    # 添加 frontmatter
    full_md = f"""---
title: "{req.bookTitle}"
source: 微信读书
type: reading-note
---

{markdown}
"""

    # 写入文件
    filepath = write_to_vault(req.vaultPath, req.bookTitle, full_md)

    return {"file": f"{req.bookTitle}.md", "path": str(filepath)}


# ── API: 导出 AI 总结 ──
@app.post("/api/export-summary")
def export_summary(req: ExportSummaryRequest):
    """导出全书的 AI 生成总结（基于章节节点）。"""

    nodes_desc = "\n".join(
        f"- [{n.get('title', '?')}] ({n.get('percent', '?')}%)" for n in (req.nodes or [])
    )

    system = """你是一个书评作者。基于一本书的关键章节节点，写一份结构化的书评/总结。

包含以下板块：
## 故事概要（3-4 句）
## 关键转折点（按时间线）
## 主题分析（这本书在探讨什么）
## 值得记住的句子（如果有的话，推测 3 条）

纯 Markdown 格式。"""

    user = f"""书名：{req.bookTitle}

关键章节节点：
{nodes_desc or '暂无节点信息'}"""

    try:
        markdown = call_llm(system, user, temperature=0.5)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {exc}")

    full_md = f"""---
title: "{req.bookTitle} · AI 总结"
source: WeRead AI
type: book-summary
---

{markdown}
"""

    filepath = write_to_vault(req.vaultPath, f"{req.bookTitle}-总结", full_md)

    return {"file": f"{req.bookTitle}-总结.md", "path": str(filepath)}


# ── API: 健康检查 ──
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "llm": "gemini" if GEMINI_API_KEY else "unconfigured",
        "model": GEMINI_MODEL,
        "version": "1.0",
    }


# ── 文件写入 ──
def write_to_vault(vault_path: str, filename: str, content: str) -> Path:
    """写入 Obsidian vault 文件夹。"""
    # 清理文件名
    safe_name = re.sub(r'[\\/:*?"<>|]', "-", filename)
    filepath = Path(safe_name + ".md")

    if vault_path:
        vault = Path(vault_path).expanduser().resolve()
        if vault.exists() and vault.is_dir():
            filepath = vault / (safe_name + ".md")
        else:
            # vault 路径无效，回退到当前目录
            filepath = Path(safe_name + ".md")
    else:
        # 没有设置 vault，写到当前目录
        filepath = Path(safe_name + ".md")

    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(content, encoding="utf-8")
    return filepath


if __name__ == "__main__":
    print("🚀 WeRead AI API 启动: http://localhost:8001")
    print("   - POST /api/analyze-chapters  → 章节节点分析")
    print("   - POST /api/review            → 阅读回顾")
    print("   - POST /api/export-notes      → 导出划线笔记")
    print("   - POST /api/export-summary    → 导出 AI 总结")
    print("   - GET  /api/health            → 健康检查")
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8001")))
