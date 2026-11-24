const transfer = document.getElementById("component-download");
if (window.__TAURI_INTERNALS__) {
  const i18n = window.bodhiI18n;
  const get = (id) => document.getElementById(id);
  const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command);
  let actionError = "";
  const meter = transfer.querySelector("progress");
  const detail = get("component-download-detail");
  let unavailable = 0;
  async function refresh() {
    try {
      const { display, locale } = await invoke("component_snapshot");
      await i18n.sync(locale);
      const failed = display.phase === "startupFailed";
      const title = get("startup-title");
      title.dataset.i18n = failed ? "startup.failed" : "startup.title";
      title.textContent = i18n.text(title.dataset.i18n);
      get("startup-hint").hidden = failed;
      get("startup-spinner").hidden = failed;
      get("component-actions").hidden = false;
      get("retry-startup").hidden = !failed;
      const error = actionError || display.error;
      get("component-error").hidden = !error;
      get("component-error").textContent = error || "";
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
  async function run(command) {
    actionError = "";
    try { await invoke(command); }
    catch (error) { actionError = String(error); }
  }

  get("open-download-settings").addEventListener("click", () => run("open_component_updates"));
  get("retry-startup").addEventListener("click", () => run("retry_component_startup"));
  void i18n.sync().then(refresh);
}
