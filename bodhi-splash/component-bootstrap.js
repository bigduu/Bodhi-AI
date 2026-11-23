const transfer = document.getElementById("component-download");
if (window.__TAURI_INTERNALS__) {
  const meter = transfer.querySelector("progress");
  const detail = document.getElementById("component-download-detail");
  const labels = { github: "GitHub 官方", "gh-proxy": "gh-proxy.com", "gh-fast": "ghfast.top" };
  let unavailable = 0;
  async function refresh() {
    try {
      const { display } = await window.__TAURI_INTERNALS__.invoke("component_snapshot");
      const progress = display.progress;
      transfer.hidden = !progress;
      if (progress) {
        const total = progress.total;
        const amount = `${(progress.received / 1024 ** 2).toFixed(1)} MiB`;
        if (total > 0) {
          meter.max = total;
          meter.value = progress.received;
        } else {
          meter.removeAttribute("value");
        }
        const percent = total > 0 ? ` · ${Math.floor(100 * progress.received / total)}%` : "";
        detail.textContent = `${progress.file} · ${labels[progress.source] || "npm"} · ${amount}${percent}`;
      }
      setTimeout(refresh, 600);
    } catch {
      if (++unavailable < 4) setTimeout(refresh, 600);
    }
  }
  refresh();
}
