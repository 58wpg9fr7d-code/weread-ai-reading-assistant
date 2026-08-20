// background.js — 持久化状态管理 + 与 API 通信的桥梁

// API 默认地址（用户可以在 popup 中修改）
const DEFAULT_API = "http://localhost:8001";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["weread_api_url"], (result) => {
    if (!result.weread_api_url) {
      chrome.storage.sync.set({ weread_api_url: DEFAULT_API });
    }
  });
});

// 接收来自 content.js 和 sidebar 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "get_api_url":
      chrome.storage.sync.get(["weread_api_url"], (result) => {
        sendResponse({ url: result.weread_api_url || DEFAULT_API });
      });
      return true; // 异步 sendResponse

    case "get_book_nodes":
      // 获取一本书缓存的章节节点
      chrome.storage.local.get([`nodes_${msg.bookId}`], (result) => {
        sendResponse({ nodes: result[`nodes_${msg.bookId}`] || null });
      });
      return true;

    case "save_book_nodes":
      // 缓存章节节点（AI 生成后保存，或用户编辑后保存）
      chrome.storage.local.set({ [`nodes_${msg.bookId}`]: msg.nodes }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case "get_reading_history":
      // 获取某本书的阅读历史
      chrome.storage.local.get([`history_${msg.bookId}`], (result) => {
        sendResponse({ history: result[`history_${msg.bookId}`] || [] });
      });
      return true;

    case "save_reading_session":
      // 保存一次阅读记录
      const historyKey = `history_${msg.bookId}`;
      chrome.storage.local.get([historyKey], (result) => {
        const history = result[historyKey] || [];
        history.push({
          timestamp: Date.now(),
          startPercent: msg.startPercent,
          endPercent: msg.endPercent,
          startCfi: msg.startCfi || "",
          endCfi: msg.endCfi || "",
        });
        // 只保留最近 50 条
        if (history.length > 50) history.shift();
        chrome.storage.local.set({ [historyKey]: history }, () => {
          sendResponse({ ok: true });
        });
      });
      return true;
  }
});
