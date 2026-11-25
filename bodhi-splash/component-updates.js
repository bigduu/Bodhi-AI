const get = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const i18n = window.bodhiI18n;
const componentNames = { bamboo: "Bamboo", lotus: "Lotus Next" };
const busyPhases = ["checking", "preparing", "downloading", "starting", "saving", "shuttingDown", "restarting"];
const offerPhases = ["current", "available", "skipped", "verified"];
const downloadPhases = ["downloading", "downloadFailed", "saveFailed"];
const componentViews = [...document.querySelectorAll("[data-update-kind]")].map((panel) => {
  panel.querySelector("[data-part=controls]").append(get("component-controls").content.cloneNode(true));
  return {
    panel,
    kind: panel.dataset.updateKind,
    part: (name) => panel.querySelector(`[data-part=${name}]`),
  };
});
let currentSnapshot = null;
let actionPending = false;
let actionError = null;
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

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function offerKey({ sequence, identity }) {
  return `${sequence}:${identity}`;
}

function offerLabel({ kind, versions }) {
  if (kind !== "pair") return versions[kind];
  return Object.keys(componentNames).map((key) => `${componentNames[key]} ${versions[key]}`).join(" · ");
}

function selectedOffer(view) {
  const key = view.part("offer").value;
  return currentSnapshot?.offers.find((offer) => offer.kind === view.kind && offerKey(offer) === key);
}

function renderOfferSelection(view, offers, busy) {
  const offerSelect = view.part("offer");
  const offer = selectedOffer(view) || offers.find((item) => item.downloaded) || offers[0];
  const options = offers.map((item) => ({ value: offerKey(item), label: offerLabel(item) }));
  if (options.length !== offerSelect.options.length || options.some(({ value, label }, index) => {
    const option = offerSelect.options[index];
    return option.value !== value || option.textContent !== label;
  })) {
    offerSelect.replaceChildren(...options.map(({ value, label }) => new Option(label, value)));
  }
  if (offer && offerSelect.value !== offerKey(offer)) offerSelect.value = offerKey(offer);
  offerSelect.disabled = busy;
  view.part("offer-field").hidden = !offer;
  return offer;
}

function renderPanelActions(view, offer, snapshot, phase, busy) {
  const canSkip = snapshot.running && snapshot.queued == null && !!offer;
  const canDownload = canSkip && !offer.skipped && !offer.downloaded;
  const canApply = canSkip && !offer.skipped && offer.downloaded;
  const download = view.part("download");
  const apply = view.part("apply");
  const skip = view.part("skip");
  view.part("actions").hidden = !canSkip;
  download.hidden = !canDownload;
  download.disabled = busy;
  setText(download, i18n.text(
    phase === "downloadFailed" ? "updates.retryDownload" : "updates.download",
  ));
  apply.hidden = !canApply;
  apply.disabled = busy;
  setText(apply, i18n.text("updates.confirmApply"));
  skip.hidden = !canSkip;
  skip.disabled = busy;
  setText(skip, i18n.text(offer?.skipped ? "updates.undoSkip" : "updates.skipVersion"));
  return canApply;
}

function renderNotes(view, offer, active) {
  const lines = [];
  if (offer) {
    const kinds = view.kind === "pair" ? Object.keys(componentNames) : [view.kind];
    for (const kind of kinds) {
      if (view.kind === "pair") {
        lines.push(`${componentNames[kind]} ${active?.[kind] || "—"} → ${offer.versions[kind]}`);
      }
      const changes = offer.changes[kind];
      lines.push(...(changes.length ? changes : [i18n.text("updates.noNotes")]));
    }
  }
  const list = view.part("changes");
  if (lines.length !== list.children.length
      || lines.some((line, index) => line !== list.children[index].textContent)) {
    list.replaceChildren();
    for (const line of lines) append(list, line);
  }
  view.part("notes").hidden = !offer;
}

function renderPanel(view, snapshot, busy) {
  const { active, display, queued, running } = snapshot;
  const offers = snapshot.offers.filter((offer) => offer.kind === view.kind);
  view.panel.hidden = view.kind === "pair" && offers.length === 0;
  const offer = renderOfferSelection(view, offers, actionPending || queued != null);
  const downloadIsHere = offer && display.downloadSequence === offer.sequence
    && downloadPhases.includes(display.phase);
  const phase = downloadIsHere ? display.phase
    : offer?.skipped ? "skipped"
    : offer?.downloaded ? "verified"
    : offer ? "available" : "";
  const status = phase ? i18n.text(`phase.${phase}`)
    : running && queued == null && offerPhases.includes(display.phase)
      ? i18n.text("updates.noCompatibleUpdate") : "";
  setText(view.part("phase"), status);
  const error = (offer && actionError?.identity === offer.identity && actionError.message)
    || (downloadIsHere && display.error) || "";
  view.part("error").hidden = !error;
  setText(view.part("error"), error);
  renderNotes(view, offer, active);
  return renderPanelActions(view, offer, snapshot, phase, busy);
}

function renderUpdates(snapshot) {
  const { display, queued, running, offers } = snapshot;
  const busy = actionPending || busyPhases.includes(display.phase);
  const canApply = componentViews.map((view) => renderPanel(view, snapshot, busy)).some(Boolean);
  const pendingRestart = running && queued != null;
  get("retry-restart").hidden = !pendingRestart;
  get("retry-restart").disabled = busy;
  get("restart-hint").hidden = !(canApply || pendingRestart);

  const check = get("check");
  setText(check, i18n.text(running ? "updates.check" : "updates.retry"));
  check.disabled = busy || (running ? pendingRestart : display.phase !== "startupFailed");

  const scopedDownload = downloadPhases.includes(display.phase)
    && offers.some((offer) => offer.sequence === display.downloadSequence);
  const scopedAction = actionError && offers.some((offer) => offer.identity === actionError.identity);
  const globalPhase = !scopedDownload && !offerPhases.includes(display.phase)
    && (display.phase !== "ready" || !running);
  setText(get("phase"), globalPhase ? i18n.text(`phase.${display.phase}`) : "");
  const error = (!scopedAction && actionError?.message) || (!scopedDownload && display.error) || "";
  get("error").hidden = !error;
  setText(get("error"), error);
}

function render(snapshot) {
  currentSnapshot = snapshot;
  const { active, display, history } = snapshot;
  get("bodhi").textContent = snapshot.bodhi;
  get("bamboo").textContent = active?.bamboo || "—";
  get("lotus").textContent = active?.lotus || "—";
  renderSettings(snapshot.settings);
  renderUpdates(snapshot);
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
  actionError = null;
  renderUpdates(currentSnapshot);
  try {
    await invoke(command, args);
  } catch (error) {
    actionError = { identity: args?.identity, message: String(error) };
  } finally {
    actionPending = false;
  }
}

get("check").addEventListener("click", () => {
  void runAction(currentSnapshot?.running ? "check_components" : "retry_component_startup");
});

get("retry-restart").addEventListener("click", () => {
  const queued = currentSnapshot?.queued;
  if (queued != null) void runAction("apply_component_update", { sequence: queued });
});

for (const view of componentViews) {
  view.part("offer").addEventListener("change", () => {
    if (currentSnapshot) renderUpdates(currentSnapshot);
  });
  for (const [part, command] of [
    ["download", "download_component_update"],
    ["apply", "apply_component_update"],
    ["skip", "set_component_version_skipped"],
  ]) {
    view.part(part).addEventListener("click", () => {
      const offer = selectedOffer(view);
      if (!offer || currentSnapshot.queued != null) return;
      const args = { sequence: offer.sequence, identity: offer.identity };
      if (part === "skip") args.skipped = !offer.skipped;
      void runAction(command, args);
    });
  }
}

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
