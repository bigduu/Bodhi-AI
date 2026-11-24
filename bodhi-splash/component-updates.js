const get = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const i18n = window.bodhiI18n;
let currentSnapshot = null;
let actionPending = false;
let actionError = "";
let mirrorUrl = null;
let dirty = false;
let saving = false;
let settingsMessage = "";
let settingsError = "";

function showSettingsState() {
  const custom = get("source").value === "custom";
  get("mirror-settings").hidden = !custom;
  get("mirror-url").disabled = !custom;
  get("mirror-url").required = custom;
  get("settings-fields").disabled = saving;
  get("save-settings").disabled = !dirty;
  const status = get("settings-status");
  const message = settingsError || (settingsMessage && i18n.text(settingsMessage));
  status.classList.toggle("error", !!settingsError);
  if (status.textContent !== message) status.textContent = message;
}

function renderSettings(settings) {
  if (!dirty && !saving) {
    mirrorUrl = settings.mirrorUrl;
    get("source").value = settings.source;
    get("mirror-url").value = mirrorUrl || "";
    get("proxy-url").value = settings.proxyUrl || "";
  }
  showSettingsState();
}

function append(list, value) {
  const item = document.createElement("li");
  item.textContent = value;
  list.append(item);
}

function renderActions({ running, queued, offer, display }) {
  const busy = actionPending || [
    "checking", "preparing", "downloading", "starting", "saving", "shuttingDown", "restarting",
  ].includes(display.phase);
  const pendingRestart = queued != null;
  const canSkip = running && !pendingRestart && !!offer;
  const canDownload = canSkip && !offer.skipped && !offer.downloaded;
  const canApply = running && (pendingRestart || (!!offer?.downloaded && !offer.skipped));
  get("check").textContent = i18n.text(running ? "updates.check" : "updates.retry");
  get("check").disabled = busy || (running ? pendingRestart : display.phase !== "startupFailed");
  get("update-actions").hidden = !(canSkip || canApply);
  get("download-update").hidden = !canDownload;
  get("download-update").disabled = busy;
  get("download-update").textContent = i18n.text(
    display.phase === "downloadFailed" ? "updates.retryDownload" : "updates.download",
  );
  get("apply-update").hidden = !canApply;
  get("apply-update").disabled = busy;
  get("apply-update").textContent = i18n.text(pendingRestart ? "updates.retryRestart" : "updates.confirmApply");
  get("skip-version").hidden = !canSkip;
  get("skip-version").disabled = busy;
  get("skip-version").textContent = i18n.text(offer?.skipped ? "updates.undoSkip" : "updates.skipVersion");
  get("restart-hint").hidden = !canApply;
}

function render(snapshot) {
  currentSnapshot = snapshot;
  const { active, display, history, offer } = snapshot;
  get("bodhi").textContent = snapshot.bodhi;
  get("bamboo").textContent = active?.bamboo || "—";
  get("lotus").textContent = active?.lotus || "—";
  renderSettings(snapshot.settings);
  renderActions(snapshot);
  get("phase").textContent = i18n.text(`phase.${display.phase}`);
  get("error").hidden = !(actionError || display.error);
  get("error").textContent = actionError || display.error || "";
  get("last-check").textContent = snapshot.lastCheck
    ? i18n.text("updates.lastCheck", { date: i18n.date(snapshot.lastCheck) })
    : "";

  const transfer = display.progress;
  get("download").hidden = !transfer;
  if (transfer) {
    const meter = get("progress");
    const total = transfer.total;
    if (total > 0) {
      meter.max = total;
      meter.value = transfer.received;
    } else {
      meter.removeAttribute("value");
    }
    get("download-detail").textContent = i18n.transferText(transfer);
  }

  const changes = get("changes");
  changes.replaceChildren();
  get("notes").hidden = !offer;
  if (offer) {
    for (const [key, name] of [["bamboo", "Bamboo"], ["lotus", "Lotus Next"]]) {
      if (active?.[key] === offer.versions[key]) continue;
      append(changes, `${name} ${active?.[key] || "—"} → ${offer.versions[key]}`);
      for (const line of offer.changes[key]) append(changes, line);
      if (offer.changes[key].length === 0) append(changes, i18n.text("updates.noNotes"));
    }
  }

  const historyList = get("history");
  historyList.replaceChildren();
  get("history-empty").hidden = history.length > 0;
  for (const item of [...history].reverse()) {
    const from = item.from ? `Bamboo ${item.from.bamboo} / Lotus Next ${item.from.lotus} → ` : "";
    const to = `Bamboo ${item.to.bamboo} / Lotus Next ${item.to.lotus}`;
    const effective = item.effective ? `Bamboo ${item.effective.bamboo} / Lotus Next ${item.effective.lotus}` : "—";
    const outcome = item.error
      ? i18n.text("updates.failed", { effective }) + " " + item.error
      : i18n.text("updates.applied");
    append(historyList, `${i18n.date(item.at)} · ${from}${to} · ${outcome}`);
  }
}

async function refresh() {
  try {
    const snapshot = await invoke("component_snapshot");
    await i18n.sync(snapshot.locale);
    render(snapshot);
  } catch (error) {
    get("error").hidden = false;
    get("error").textContent = String(error);
  } finally {
    setTimeout(refresh, 650);
  }
}

async function runAction(command, args) {
  if (actionPending || !currentSnapshot) return;
  actionPending = true;
  actionError = "";
  renderActions(currentSnapshot);
  try {
    await invoke(command, args);
  } catch (error) {
    actionError = String(error);
  } finally {
    actionPending = false;
  }
}

get("check").addEventListener("click", () => {
  void runAction(currentSnapshot?.running ? "check_components" : "retry_component_startup");
});

get("download-update").addEventListener("click", () => {
  const sequence = currentSnapshot?.offer?.sequence;
  if (sequence != null) void runAction("download_component_update", { sequence });
});

get("apply-update").addEventListener("click", () => {
  const sequence = currentSnapshot?.queued ?? currentSnapshot?.offer?.sequence;
  if (sequence != null) void runAction("apply_component_update", { sequence });
});

get("skip-version").addEventListener("click", () => {
  const offer = currentSnapshot?.offer;
  if (offer && currentSnapshot.queued == null) {
    void runAction("set_component_version_skipped", {
      sequence: offer.sequence,
      identity: offer.identity,
      skipped: !offer.skipped,
    });
  }
});

function editSettings() {
  dirty = true;
  settingsMessage = "";
  settingsError = "";
  showSettingsState();
}

get("download-settings").addEventListener("input", editSettings);
get("source").addEventListener("change", editSettings);

get("download-settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !dirty) return;
  const source = get("source").value;
  const settings = {
    source,
    proxyUrl: get("proxy-url").value.trim() || null,
    mirrorUrl: source === "custom" ? get("mirror-url").value.trim() || null : mirrorUrl,
  };
  saving = true;
  settingsMessage = "";
  settingsError = "";
  showSettingsState();
  try {
    await invoke("set_component_download_settings", { settings });
    dirty = false;
    settingsMessage = "source.saved";
  } catch (error) {
    settingsError = String(error);
  } finally {
    saving = false;
    showSettingsState();
  }
});

void i18n.sync().then(refresh);
