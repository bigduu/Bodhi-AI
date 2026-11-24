const get = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const i18n = window.bodhiI18n;
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

function render(snapshot) {
  const { active, queued, display, history } = snapshot;
  get("bodhi").textContent = snapshot.bodhi;
  get("bamboo").textContent = active?.bamboo || "—";
  get("lotus").textContent = active?.lotus || "—";
  renderSettings(snapshot.settings);
  get("check").textContent = i18n.text(snapshot.running ? "updates.check" : "updates.retry");
  get("check").disabled = (snapshot.running && !!queued) || !!display.progress || ["checking", "starting"].includes(display.phase);
  get("phase").textContent = i18n.text(queued && snapshot.running ? "updates.queued" : `phase.${display.phase}`);
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
  get("notes").hidden = !display.offer;
  if (display.offer) {
    const offer = display.offer;
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

get("check").addEventListener("click", async () => {
  actionError = "";
  try { await invoke("check_components"); } catch (error) { actionError = String(error); }
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
