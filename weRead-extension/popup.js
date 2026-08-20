// popup.js —— 扩展图标弹窗，配置 API 和 Vault 路径
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(["weread_api_url", "weread_vault_path"], (result) => {
    document.getElementById("api-url").value = result.weread_api_url || "http://localhost:8001";
    document.getElementById("vault-path").value = result.weread_vault_path || "";
  });

  document.getElementById("save-btn").addEventListener("click", () => {
    const apiUrl = document.getElementById("api-url").value.trim();
    const vaultPath = document.getElementById("vault-path").value.trim();
    chrome.storage.sync.set({ weread_api_url: apiUrl, weread_vault_path: vaultPath }, () => {
      document.getElementById("status").textContent = "✅ 已保存";
      setTimeout(() => { document.getElementById("status").textContent = ""; }, 2000);
    });
  });
});
