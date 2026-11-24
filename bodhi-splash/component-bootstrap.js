const transfer = document.getElementById("component-download");
if (window.__TAURI_INTERNALS__) {
  const i18n = window.bodhiI18n;
  const meter = transfer.querySelector("progress");
  const detail = document.getElementById("component-download-detail");
  let unavailable = 0;
  async function refresh() {
    try {
      const { display, locale } = await window.__TAURI_INTERNALS__.invoke("component_snapshot");
      await i18n.sync(locale);
      const progress = display.progress;
      transfer.hidden = !progress;
      if (progress) {
        const total = progress.total;
        if (total > 0) {
          meter.max = total;
          meter.value = progress.received;
        } else {
          meter.removeAttribute("value");
        }
        detail.textContent = i18n.transferText(progress);
      }
      setTimeout(refresh, 600);
    } catch {
      if (++unavailable < 4) setTimeout(refresh, 600);
    }
  }
  void i18n.sync().then(refresh);
}
