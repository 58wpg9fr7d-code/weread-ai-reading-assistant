// content.js —— 注入微信读书 web reader 的主逻辑
// 功能：进度条章节节点、阅读回顾、笔记导出、进度追踪

(function () {
  "use strict";

  // ── 状态 ──
  let bookId = null;
  let bookTitle = "";
  let chapterNodes = []; // { id, title, percent, editable }
  let currentPercent = 0;
  let lastSaveTime = 0;
  const SAVE_INTERVAL = 30000; // 30 秒保存一次进度

  // ── API 地址 ──
  let apiUrl = "http://localhost:8001";

  // ── UI 容器 ──
  let sidebarContainer = null;
  let nodeBarContainer = null;

  // ── 初始化 ──
  function init() {
    detectBook();
    if (!bookId) return setTimeout(init, 1000); // 还没加载完，等 1 秒再试

    chrome.runtime.sendMessage({ type: "get_api_url" }, (resp) => {
      if (resp?.url) apiUrl = resp.url;
    });

    // 加载已缓存的节点
    chrome.runtime.sendMessage(
      { type: "get_book_nodes", bookId },
      (resp) => {
        if (resp?.nodes) {
          chapterNodes = resp.nodes;
          renderNodeBar();
        } else {
          // 首次打开这本书 —— 自动分析章节节点
          analyzeBookChapters();
        }
      }
    );

    injectSidebar();
    injectNodeBar();
    startProgressTracking();
    trackLeaving();
  }

  // ── 检测书本信息 ──
  function detectBook() {
    // 从 URL 提取 bookId：weread.qq.com/web/reader/xxx
    const match = location.pathname.match(/\/web\/reader\/([a-zA-Z0-9]+)/);
    if (match) bookId = match[1];

    // 尝试从页面提取书名
    const titleEl =
      document.querySelector(".readerTopBar_title") ||
      document.querySelector('[class*="readerTitle"]') ||
      document.querySelector("title");
    if (titleEl) {
      bookTitle = titleEl.textContent?.replace(/[-–—].*/, "").trim() || "";
    }
    if (!bookTitle) bookTitle = "未知书名";
  }

  // ── AI 分析章节节点 ──
  async function analyzeBookChapters() {
    // 抓取章节目录
    const chapters = extractChapters();
    if (!chapters || chapters.length < 4) return; // 章节太少不值得分析

    try {
      const resp = await fetch(`${apiUrl}/api/analyze-chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, bookTitle, chapters }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) return;

      const data = await resp.json();
      chapterNodes = data.nodes || [];

      // 缓存到本地
      chrome.runtime.sendMessage({
        type: "save_book_nodes",
        bookId,
        nodes: chapterNodes,
      });

      renderNodeBar();
    } catch (e) {
      console.warn("WeRead AI: 章节分析失败", e.message);
    }
  }

  // ── 从 DOM 抓取章节目录 ──
  function extractChapters() {
    // 微信读书的目录结构：点击目录按钮后展开的列表
    // 尝试常见的 DOM 结构
    const selectors = [
      '[class*="chapterItem"]',
      '[class*="catalog"] [class*="chapter"]',
      '.readerCatalog_item',
      '[class*="catalogItem"]',
    ];

    for (const sel of selectors) {
      const items = document.querySelectorAll(sel);
      if (items.length > 0) {
        return Array.from(items)
          .slice(0, 80) // 最多 80 章，够 AI 分析了
          .map((el, i) => ({
            index: i,
            title: (el.textContent || "").trim().substring(0, 60),
          }))
          .filter((c) => c.title.length > 1);
      }
    }

    // Fallback：从目录面板读取（需要用户先点开目录按钮）
    return [];
  }

  // ── 注入侧边栏 ──
  function injectSidebar() {
    if (document.getElementById("weread-ai-sidebar")) return;

    sidebarContainer = document.createElement("div");
    sidebarContainer.id = "weread-ai-sidebar";
    sidebarContainer.className = "wai-hidden";  // 默认隐藏，点按钮才打开
    sidebarContainer.innerHTML = `
      <div class="wai-sidebar-inner">
        <div class="wai-sidebar-header">
          <span class="wai-logo">📖 WeRead AI</span>
          <button class="wai-close-btn" id="wai-close-sidebar">×</button>
        </div>

        <div class="wai-section">
          <div class="wai-section-title">阅读回顾</div>
          <div class="wai-btn-group">
            <button class="wai-btn wai-btn-primary" id="wai-review-last">📌 回顾上次内容</button>
            <button class="wai-btn wai-btn-outline" id="wai-review-all">📚 总结全部已读</button>
          </div>
          <div class="wai-review-result" id="wai-review-result" style="display:none;">
            <div class="wai-loading" id="wai-review-loading">⏳ 分析中...</div>
            <div class="wai-result-text" id="wai-review-text"></div>
          </div>
        </div>

        <div class="wai-section">
          <div class="wai-section-title">笔记导出</div>
          <div class="wai-btn-group">
            <button class="wai-btn wai-btn-primary" id="wai-export-notes">📝 导出划线笔记到 Obsidian</button>
            <button class="wai-btn wai-btn-outline" id="wai-export-summary">💡 导出 AI 总结</button>
          </div>
          <div class="wai-status" id="wai-export-status"></div>
        </div>

        <div class="wai-section">
          <div class="wai-section-title">章节节点</div>
          <div class="wai-node-list" id="wai-node-list">
            <div class="wai-empty">打开书籍后自动分析章节节点</div>
          </div>
          <button class="wai-btn wai-btn-outline wai-btn-sm" id="wai-reanalyze">🔄 重新分析</button>
          <button class="wai-btn wai-btn-outline wai-btn-sm" id="wai-toggle-edit">✏️ 编辑节点</button>
        </div>

        <div class="wai-section">
          <div class="wai-section-title">设置</div>
          <label class="wai-label">Obsidian Vault 路径</label>
          <input class="wai-input" id="wai-vault-path" type="text" placeholder="/Users/xxx/Obsidian/我的笔记" />
          <button class="wai-btn wai-btn-outline wai-btn-sm" id="wai-save-settings">保存设置</button>
        </div>
      </div>
    `;

    document.body.appendChild(sidebarContainer);

    // 绑定事件
    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    document.getElementById("wai-close-sidebar")?.addEventListener("click", toggleSidebar);
    document.getElementById("wai-review-last")?.addEventListener("click", () => reviewReading("last"));
    document.getElementById("wai-review-all")?.addEventListener("click", () => reviewReading("all"));
    document.getElementById("wai-export-notes")?.addEventListener("click", exportNotes);
    document.getElementById("wai-export-summary")?.addEventListener("click", exportSummary);
    document.getElementById("wai-reanalyze")?.addEventListener("click", analyzeBookChapters);
    document.getElementById("wai-toggle-edit")?.addEventListener("click", toggleNodeEdit);
    document.getElementById("wai-save-settings")?.addEventListener("click", saveSettings);

    // 加载设置
    chrome.storage.sync.get(["weread_vault_path"], (result) => {
      if (result.weread_vault_path) {
        const input = document.getElementById("wai-vault-path");
        if (input) input.value = result.weread_vault_path;
      }
    });
  }

  function toggleSidebar() {
    sidebarContainer?.classList.toggle("wai-hidden");
  }

  function showSidebar() {
    sidebarContainer?.classList.remove("wai-hidden");
  }

  // ── 注入进度条上的节点标记 ──
  function injectNodeBar() {
    // 移除旧的
    if (nodeBarContainer) nodeBarContainer.remove();

    nodeBarContainer = document.createElement("div");
    nodeBarContainer.id = "wai-node-bar";
    nodeBarContainer.className = "wai-node-bar";
    document.body.appendChild(nodeBarContainer);
  }

  function renderNodeBar() {
    if (!chapterNodes || chapterNodes.length === 0) {
      updateNodeList();
      return;
    }

    // 在进度条上渲染节点
    const progressBar = findProgressBar();
    if (!progressBar) return setTimeout(renderNodeBar, 500);

    // 移除旧节点
    progressBar.querySelectorAll(".wai-progress-node").forEach((n) => n.remove());

    chapterNodes.forEach((node) => {
      const dot = document.createElement("div");
      dot.className = "wai-progress-node";
      dot.title = node.title;
      dot.style.left = `${node.percent}%`;

      // 点击节点跳转
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        jumpToPercent(node.percent);
        // 高亮当前节点
        progressBar
          .querySelectorAll(".wai-progress-node")
          .forEach((n) => n.classList.remove("wai-active"));
        dot.classList.add("wai-active");
      });

      progressBar.appendChild(dot);
    });

    updateNodeList();
  }

  function findProgressBar() {
    // 微信读书底部进度条
    const selectors = [
      '[class*="readerProgress"]',
      '[class*="progressBar"]',
      '[class*="readingProgress"]',
      '[class*="footerProgress"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function updateNodeList() {
    const list = document.getElementById("wai-node-list");
    if (!list) return;

    if (!chapterNodes || chapterNodes.length === 0) {
      list.innerHTML = '<div class="wai-empty">点击"重新分析"生成章节节点</div>';
      return;
    }

    list.innerHTML = chapterNodes
      .map(
        (n, i) => `
      <div class="wai-node-item ${n.editable ? 'wai-editing' : ''}" data-index="${i}">
        <span class="wai-node-dot" style="background:${n.color || '#2563EB'}"></span>
        <span class="wai-node-title">${n.title}</span>
        <span class="wai-node-pct">${n.percent}%</span>
      </div>`
      )
      .join("");
  }

  function toggleNodeEdit() {
    const editing = chapterNodes.some((n) => n.editable);
    chapterNodes.forEach((n) => (n.editable = !editing));
    updateNodeList();

    if (!editing) {
      // 代编辑模式 —— 让节点标题可编辑
      setTimeout(() => {
        document.querySelectorAll(".wai-node-title").forEach((el) => {
          el.contentEditable = "true";
          el.addEventListener("blur", saveNodeEdits);
        });
      }, 100);
    } else {
      saveNodeEdits();
    }
  }

  function saveNodeEdits() {
    document.querySelectorAll(".wai-node-item").forEach((item) => {
      const idx = parseInt(item.dataset.index);
      const titleEl = item.querySelector(".wai-node-title");
      if (titleEl && chapterNodes[idx]) {
        chapterNodes[idx].title = titleEl.textContent.trim();
      }
    });
    chapterNodes.forEach((n) => (n.editable = false));
    chrome.runtime.sendMessage({
      type: "save_book_nodes",
      bookId,
      nodes: chapterNodes,
    });
    updateNodeList();
    renderNodeBar();
    showToast("节点已保存");
  }

  // ── 进度追踪 ──
  function startProgressTracking() {
    let sessionStartPercent = getCurrentPercent();

    // 每 5 秒更新一次当前进度
    setInterval(() => {
      currentPercent = getCurrentPercent();
    }, 5000);

    // 离开页面时保存阅读记录
    const saveSession = () => {
      const endPercent = getCurrentPercent();
      if (Math.abs(endPercent - sessionStartPercent) < 0.5) return; // 没什么变化就不存了

      chrome.runtime.sendMessage({
        type: "save_reading_session",
        bookId,
        startPercent: sessionStartPercent,
        endPercent: endPercent,
        startCfi: getCfi(),
        endCfi: getCfi(),
      });
    };

    window.addEventListener("beforeunload", saveSession);
    window.addEventListener("pagehide", saveSession);

    // 定期自动保存
    setInterval(() => {
      const now = Date.now();
      if (now - lastSaveTime > SAVE_INTERVAL && currentPercent > 0) {
        const endPercent = getCurrentPercent();
        if (Math.abs(endPercent - sessionStartPercent) > 0.5) {
          chrome.runtime.sendMessage({
            type: "save_reading_session",
            bookId,
            startPercent: sessionStartPercent,
            endPercent: endPercent,
            startCfi: getCfi(),
            endCfi: getCfi(),
          });
          sessionStartPercent = endPercent;
          lastSaveTime = now;
        }
      }
    }, SAVE_INTERVAL);
  }

  function getCurrentPercent() {
    // 从微信读书的 DOM 或 URL 获取当前阅读进度
    // 微信读书 URL 可能包含进度信息
    const hash = location.hash;
    const pctMatch = hash.match(/pct=(\d+)/);
    if (pctMatch) return parseFloat(pctMatch[1]);

    // 从进度相关 DOM 元素读取
    const el = document.querySelector(
      '[class*="readerProgress"] span, [class*="progress"] span, [class*="percentage"]'
    );
    if (el) {
      const num = parseFloat(el.textContent?.replace("%", ""));
      if (!isNaN(num)) return num;
    }

    // 估算：当前滚动位置 / 总高度
    const scrollEl =
      document.querySelector('[class*="readerContent"]') ||
      document.querySelector('[class*="app_content"]') ||
      document.documentElement;
    if (scrollEl) {
      const total = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (total > 0) return Math.round((scrollEl.scrollTop / total) * 100);
    }

    return 0;
  }

  function getCfi() {
    // 简化版位置标记：使用 URL hash
    return location.hash || "";
  }

  function jumpToPercent(pct) {
    // 模拟微信读书的章节跳转
    const scrollEl =
      document.querySelector('[class*="readerContent"]') ||
      document.querySelector('[class*="app_content"]');
    if (scrollEl) {
      const total = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = (pct / 100) * total;
    }
  }

  function trackLeaving() {
    // 在 sidebar 添加一个始终可见的触发按钮
    const trigger = document.createElement("div");
    trigger.id = "wai-trigger";
    trigger.innerHTML = "📖";
    trigger.title = "打开 WeRead AI";
    trigger.addEventListener("click", () => {
      sidebarContainer?.classList.toggle("wai-hidden");
    });
    document.body.appendChild(trigger);
  }

  // ── 阅读回顾 ──
  async function reviewReading(scope) {
    const resultDiv = document.getElementById("wai-review-result");
    const loadingEl = document.getElementById("wai-review-loading");
    const textEl = document.getElementById("wai-review-text");

    if (!resultDiv || !loadingEl || !textEl) return;
    resultDiv.style.display = "block";
    loadingEl.style.display = "block";
    textEl.textContent = "";
    showSidebar();

    // 获取阅读历史
    chrome.runtime.sendMessage(
      { type: "get_reading_history", bookId },
      async (resp) => {
        const history = resp?.history || [];
        if (history.length === 0 && scope === "last") {
          loadingEl.style.display = "none";
          textEl.innerHTML =
            '<span class="wai-hint">还没有阅读记录。开始读几页，系统会自动追踪进度。</span>';
          return;
        }

        const lastSession = history[history.length - 1];

        try {
          const resp = await fetch(`${apiUrl}/api/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bookId,
              bookTitle,
              scope, // "last" or "all"
              lastSession: scope === "last" ? lastSession : null,
              allSessions: scope === "all" ? history : null,
            }),
            signal: AbortSignal.timeout(60000),
          });

          loadingEl.style.display = "none";

          if (!resp.ok) {
            textEl.innerHTML =
              '<span class="wai-error">回顾生成失败，请确保 API 服务已启动</span>';
            return;
          }

          const data = await resp.json();
          textEl.innerHTML = formatMarkdown(data.summary);
        } catch (e) {
          loadingEl.style.display = "none";
          textEl.innerHTML = `<span class="wai-error">连接 API 失败：${e.message}</span>`;
        }
      }
    );
  }

  // ── 导出笔记 ──
  async function exportNotes() {
    const statusEl = document.getElementById("wai-export-status");
    if (!statusEl) return;
    statusEl.textContent = "⏳ 抓取划线笔记中...";

    // 抓取微信读书的划线数据
    const highlights = extractHighlights();

    if (!highlights || highlights.length === 0) {
      statusEl.textContent = "⚠️ 当前页面没有找到划线内容。去笔记页面试试。";
      return;
    }

    statusEl.textContent = `⏳ 已抓取 ${highlights.length} 条划线，正在整理...`;

    try {
      const resp = await fetch(`${apiUrl}/api/export-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId,
          bookTitle,
          highlights,
          vaultPath: document.getElementById("wai-vault-path")?.value || "",
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        statusEl.textContent = `❌ 导出失败：${err.detail || resp.status}`;
        return;
      }

      const data = await resp.json();
      statusEl.textContent = `✅ 已保存到 Obsidian：${data.file || bookTitle}.md`;
      showToast("笔记已导出到 Obsidian ✨");
    } catch (e) {
      statusEl.textContent = `❌ 连接失败：${e.message}`;
    }
  }

  function extractHighlights() {
    // 在当前页面抓取划线内容
    const highlights = [];
    // 微信读书划线标记
    const marks = document.querySelectorAll(
      '[class*="highlight"], [class*="underline"], [class*="mark"], .wr_underline'
    );
    marks.forEach((el) => {
      const text = el.textContent?.trim();
      if (text && text.length > 2) highlights.push(text);
    });

    // 如果当前页面没有，引导用户去笔记本页面
    if (highlights.length === 0) {
      return [];
    }

    // 去重 + 限制长度
    return [...new Set(highlights)]
      .slice(0, 200)
      .map((h) => h.substring(0, 500));
  }

  async function exportSummary() {
    const statusEl = document.getElementById("wai-export-status");
    if (!statusEl) return;
    statusEl.textContent = "⏳ 生成 AI 总结中...";

    try {
      const resp = await fetch(`${apiUrl}/api/export-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId,
          bookTitle,
          nodes: chapterNodes,
          vaultPath: document.getElementById("wai-vault-path")?.value || "",
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        statusEl.textContent = `❌ 导出失败：${err.detail || resp.status}`;
        return;
      }

      const data = await resp.json();
      statusEl.textContent = `✅ 已保存：${data.file || bookTitle}-总结.md`;
      showToast("AI 总结已导出 ✨");
    } catch (e) {
      statusEl.textContent = `❌ 连接失败：${e.message}`;
    }
  }

  function saveSettings() {
    const vaultPath = document.getElementById("wai-vault-path")?.value || "";
    chrome.storage.sync.set({ weread_vault_path: vaultPath }, () => {
      showToast("设置已保存 ✓");
    });
  }

  // ── 工具函数 ──
  function showToast(msg) {
    let toast = document.getElementById("wai-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "wai-toast";
      toast.className = "wai-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add("wai-toast-show");
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove("wai-toast-show"), 2500);
  }

  function formatMarkdown(text) {
    if (!text) return "";
    // 简单 markdown → HTML
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/^### (.*$)/gm, "<h4>$1</h4>")
      .replace(/^## (.*$)/gm, "<h3>$1</h3>")
      .replace(/^# (.*$)/gm, "<h2>$1</h2>")
      .replace(/^- (.*$)/gm, "<li>$1</li>")
      .replace(/\n\n/g, "</p><p>")
      .replace(/^(.+)$/gm, (m) => (m.startsWith("<") ? m : `<p>${m}</p>`));
  }

  // ── 启动 ──
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
