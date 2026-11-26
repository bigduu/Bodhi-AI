const get = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const i18n = window.bodhiI18n;
const importBambooCommand = "import_local_bamboo_update";
const githubTokenErrors = {
  "invalid-token": "githubToken.invalid",
  "token-missing": "githubToken.missing",
  "token-rejected": "githubToken.rejected",
  "token-rate-limited": "githubToken.rateLimited",
  "github-api-refused": "githubToken.refused",
  "github-api-unavailable": "githubToken.unavailable",
  "credential-store-unavailable": "githubToken.storeUnavailable",
};
const componentNames = { bamboo: "Bamboo", lotus: "Lotus Next" };
const switchPhases = ["shuttingDown", "starting", "reconnecting", "restoringSessions"];
const busyPhases = ["checking", "preparing", "downloading", "saving", "restarting", ...switchPhases];
const offerPhases = ["current", "available", "skipped", "verified"];
const downloadPhases = ["downloading", "downloadFailed", "saveFailed"];
const componentViews = [...document.querySelectorAll("[data-update-kind]")].map((panel) => {
  panel.querySelector("[data-part=controls]").append(get("component-controls").content.cloneNode(true));
  const kind = panel.dataset.updateKind;
  const part = (name) => panel.querySelector(`[data-part=${name}]`);
  const warning = part("force-warning");
  warning.id = `force-warning-${kind}`;
  const help = kind === "bamboo" ? "bamboo-restart-hint" : "restart-hint";
  part("apply").setAttribute("aria-describedby", help);
  part("force").setAttribute("aria-describedby", `${warning.id} ${help}`);
  return { panel, kind, part };
});
let currentSnapshot = null;
let renderedHistory = null;
let refreshTimer;
let refreshing = false;
let actionPending = false;
let actionError = null;
let rollbackAttempt = null;
let mirrorUrl = null;
let dirty = false;
let saving = false;
let settingsMessage = "";
let settingsError = "";
let checkIntervalDirty = false;
let checkIntervalSaving = false;
let githubTokenPending = false;
let githubTokenFeedback = null;


function showCheckIntervalState() {
  get("check-interval-fields").disabled = checkIntervalSaving;
  get("save-check-interval").disabled = !checkIntervalDirty;
}

function renderCheckInterval(hours) {
  if (!checkIntervalDirty && !checkIntervalSaving) {
    get("auto-check-hours").value = hours ?? 3;
  }
  showCheckIntervalState();
}

function showSettingsState() {
  const custom = get("source").value === "custom";
  get("mirror-settings").hidden = !custom;
  get("mirror-url").disabled = !custom;
  get("mirror-url").required = custom;
  get("settings-fields").disabled = saving || !!currentSnapshot?.lotusRollback?.shutdownStarted;
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

function renderGithubToken() {
  const state = currentSnapshot?.githubUpdateTokenState;
  const configured = state === "stored" || state === "session";
  const unavailable = state === "unavailable";
  const knownState = configured || unavailable || state === "none";
  const disabled = !currentSnapshot?.running || !knownState || githubTokenPending;
  const input = get("github-token");
  get("github-token-fields").disabled = disabled;
  get("save-github-token").disabled = disabled || !input.value.trim();
  get("test-github-token").disabled = disabled || !configured;
  get("remove-github-token").disabled = disabled || !(configured || unavailable);
  const stateKey = unavailable ? "githubToken.storeUnreadable" : `githubToken.${state}`;
  setText(get("github-token-state"), knownState ? i18n.text(stateKey) : "");
  const status = get("github-token-status");
  const statusKey = githubTokenPending ? "githubToken.pending" : githubTokenFeedback?.key;
  status.hidden = !statusKey;
  status.classList.toggle("error", !!githubTokenFeedback?.error);
  setText(status, statusKey ? i18n.text(statusKey) : "");
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

function canForceUpdate(snapshot, offer) {
  return snapshot.running && snapshot.queued == null && !snapshot.lotusRollback?.shutdownStarted
    && offer?.downloaded && !offer.skipped
    && snapshot.forceUpdate?.sequence === offer.sequence
    && snapshot.forceUpdate?.identity === offer.identity;
}

function updateShutdownStarted(snapshot) {
  return !!(snapshot.forceUpdate?.shutdownStarted || snapshot.lotusRollback?.shutdownStarted);
}

function renderPanelActions(view, offer, snapshot, phase, busy) {
  const canSkip = snapshot.running && snapshot.queued == null
    && !snapshot.bambooRecoveryPending && !updateShutdownStarted(snapshot) && !!offer;
  const canDownload = canSkip && !offer.skipped && !offer.downloaded;
  const canApply = canSkip && !offer.skipped && offer.downloaded;
  const canForce = canForceUpdate(snapshot, offer);
  const isBamboo = view.kind === "bamboo";
  const download = view.part("download");
  const apply = view.part("apply");
  const force = view.part("force");
  const skip = view.part("skip");
  view.part("actions").hidden = !(canSkip || canForce);
  download.hidden = !canDownload;
  download.disabled = busy;
  setText(download, i18n.text(
    phase === "downloadFailed" ? "updates.retryDownload" : "updates.download",
  ));
  apply.hidden = !canApply;
  apply.disabled = busy;
  setText(apply, i18n.text(isBamboo ? "updates.confirmBamboo" : "updates.confirmApply"));
  force.hidden = !canForce;
  force.disabled = busy;
  if (canForce) {
    const checkpointed = snapshot.forceUpdate.checkpointed;
    const label = isBamboo
      ? (checkpointed ? "updates.forceBamboo" : "updates.legacyForceBamboo")
      : (checkpointed ? "updates.forceUpdate" : "updates.legacyForceUpdate");
    setText(force, i18n.text(label));
    const checkpointWarning = isBamboo ? "updates.bambooCheckpointWarning" : "updates.checkpointWarning";
    setText(view.part("force-warning"), i18n.text(
      checkpointed ? checkpointWarning : "updates.forceWarning",
    ));
  }
  view.part("force-warning").hidden = !canForce;
  skip.hidden = !canSkip;
  skip.disabled = busy;
  setText(skip, i18n.text(offer?.skipped ? "updates.undoSkip" : "updates.skipVersion"));
  return canApply || canForce;
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
  const offer = renderOfferSelection(view, offers,
    actionPending || queued != null || updateShutdownStarted(snapshot));
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
  const localImportError = view.kind === "bamboo" && actionError?.command === importBambooCommand;
  const error = (localImportError && actionError.message)
    || (offer && actionError?.identity === offer.identity && actionError.message)
    || (downloadIsHere && display.error) || "";
  view.part("error").hidden = !error;
  setText(view.part("error"), error);
  renderNotes(view, offer, active);
  return renderPanelActions(view, offer, snapshot, phase, busy);
}

function renderLotusRollbackActions(snapshot, busy) {
  const { lotusRollback, lotusUpdateSuppressed, display, running, queued, forceUpdate, restoring } = snapshot;
  const canChangeLotus = running && queued == null && !forceUpdate?.shutdownStarted && !restoring;
  const available = canChangeLotus && !!lotusRollback;
  const showVersion = get("show-rolled-back-lotus");
  showVersion.hidden = !(canChangeLotus && lotusUpdateSuppressed && !lotusRollback?.shutdownStarted && !busy);
  get("lotus-rollback").hidden = !available;
  const button = get("rollback-lotus");
  button.disabled = !available || busy;
  if (!available) return;

  let label = "updates.rollbackLotus";
  if (lotusRollback.shutdownStarted || rollbackAttempt === lotusRollback.identity) {
    if (actionPending || ["shuttingDown", "restarting"].includes(display.phase)) {
      label = "updates.rollingBackLotus";
    } else if (lotusRollback.shutdownStarted || ["restartFailed", "saveFailed"].includes(display.phase)
        || actionError?.identity === rollbackAttempt) {
      label = "updates.retryRollbackLotus";
    }
  }
  setText(button, i18n.text(label, { version: lotusRollback.versions.lotus }));
}

function renderUpdates(snapshot) {
  const { display, queued, running, offers } = snapshot;
  const busy = actionPending || busyPhases.includes(display.phase);
  const applicable = componentViews.map((view) =>
    renderPanel(view, snapshot, busy) ? view.kind : null);
  renderLotusRollbackActions(snapshot, busy);
  const bambooPending = snapshot.bambooRestartPending === true;
  const recoveryPending = snapshot.bambooRecoveryPending === true;
  const pendingRestart = queued != null && (running || bambooPending);
  get("bamboo-import").hidden = !running;
  get("import-local-bamboo").disabled = busy || !running || pendingRestart
    || recoveryPending || updateShutdownStarted(snapshot);
  const retry = get("retry-restart");
  retry.hidden = !pendingRestart;
  retry.disabled = busy;
  retry.setAttribute("aria-describedby", bambooPending ? "bamboo-restart-hint" : "restart-hint");
  setText(retry, i18n.text(bambooPending ? "updates.retryBamboo" : "updates.retryRestart"));
  get("restart-hint").hidden = !(applicable.some((kind) => kind && kind !== "bamboo") || (pendingRestart && !bambooPending));
  get("bamboo-restart-hint").hidden = !(applicable.includes("bamboo") || (pendingRestart && bambooPending));

  const check = get("check");
  setText(check, i18n.text(running ? "updates.check" : "updates.retry"));
  check.disabled = busy || (running
    ? pendingRestart || recoveryPending || updateShutdownStarted(snapshot)
    : pendingRestart || display.phase !== "startupFailed");

  const scopedDownload = downloadPhases.includes(display.phase)
    && offers.some((offer) => offer.sequence === display.downloadSequence);
  const scopedAction = actionError && (actionError.command === importBambooCommand
    || offers.some((offer) => offer.identity === actionError.identity));
  const globalPhase = !scopedDownload && !offerPhases.includes(display.phase)
    && (display.phase !== "ready" || !running);
  const status = get("phase");
  status.toggleAttribute("data-switching", globalPhase && switchPhases.includes(display.phase));
  setText(status, globalPhase ? i18n.text(`phase.${display.phase}`) : "");
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
  renderCheckInterval(snapshot.autoCheckHours);
  renderSettings(snapshot.settings);
  renderGithubToken();
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

  const historyKey = JSON.stringify([snapshot.locale, history]);
  if (renderedHistory === historyKey) return;
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
  renderedHistory = historyKey;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const snapshot = await invoke("component_snapshot");
    await i18n.sync(snapshot.locale);
    render(snapshot);
  } catch (error) {
    get("error").hidden = false;
    get("error").textContent = String(error);
  } finally {
    refreshing = false;
    refreshTimer = setTimeout(refresh, document.hidden ? 2_500 : 650);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearTimeout(refreshTimer);
    void refresh();
  }
});

async function runAction(command, args) {
  if (actionPending || !currentSnapshot) return;
  actionPending = true;
  actionError = null;
  rollbackAttempt = command === "rollback_lotus_component" ? args.identity : null;
  renderUpdates(currentSnapshot);
  try {
    await invoke(command, args);
  } catch (error) {
    actionError = { command, identity: args?.identity, message: String(error) };
  } finally {
    actionPending = false;
  }
}

get("check").addEventListener("click", () => {
  if (get("check").disabled) return;
  void runAction(currentSnapshot?.running ? "check_components" : "retry_component_startup");
});

get("import-local-bamboo").addEventListener("click", () => {
  if (get("import-local-bamboo").disabled) return;
  void runAction(importBambooCommand);
});

get("retry-restart").addEventListener("click", () => {
  const queued = currentSnapshot?.queued;
  if (queued != null && !get("retry-restart").disabled) {
    void runAction("apply_component_update", { sequence: queued, identity: null });
  }
});

get("rollback-lotus").addEventListener("click", () => {
  const rollback = currentSnapshot?.lotusRollback;
  if (!rollback || get("rollback-lotus").disabled) return;
  void runAction("rollback_lotus_component", { identity: rollback.identity });
});

get("show-rolled-back-lotus").addEventListener("click", () => {
  if (get("show-rolled-back-lotus").hidden) return;
  void runAction("resume_lotus_updates");
});

for (const view of componentViews) {
  view.part("offer").addEventListener("change", () => {
    if (currentSnapshot) renderUpdates(currentSnapshot);
  });
  for (const [part, command] of [
    ["download", "download_component_update"],
    ["apply", "apply_component_update"],
    ["force", "force_component_update"],
    ["skip", "set_component_version_skipped"],
  ]) {
    const button = view.part(part);
    button.addEventListener("click", () => {
      const offer = selectedOffer(view);
      if (button.hidden || button.disabled || !offer || currentSnapshot.queued != null) return;
      if (part === "force" && !canForceUpdate(currentSnapshot, offer)) return;
      const args = { sequence: offer.sequence, identity: offer.identity };
      if (part === "force") args.checkpointed = !!currentSnapshot.forceUpdate.checkpointed;
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
  if (saving || !dirty || currentSnapshot?.lotusRollback?.shutdownStarted) return;
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

const checkIntervalStatus = get("check-interval-status");
get("auto-check-hours").addEventListener("input", () => {
  checkIntervalDirty = true;
  checkIntervalStatus.textContent = "";
  checkIntervalStatus.classList.remove("error");
  showCheckIntervalState();
});

get("check-interval-settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!checkIntervalDirty || checkIntervalSaving) return;
  const interval = get("auto-check-hours");
  if (!interval.reportValidity()) return;
  checkIntervalSaving = true;
  checkIntervalStatus.textContent = "";
  checkIntervalStatus.classList.remove("error");
  showCheckIntervalState();
  try {
    await invoke("set_component_check_interval", { hours: interval.valueAsNumber });
    checkIntervalDirty = false;
    checkIntervalStatus.textContent = i18n.text("updates.checkIntervalSaved");
  } catch (error) {
    checkIntervalStatus.textContent = String(error);
    checkIntervalStatus.classList.add("error");
  } finally {
    checkIntervalSaving = false;
    showCheckIntervalState();
  }
});

async function runGithubTokenAction(command, successKey, args) {
  githubTokenPending = true;
  githubTokenFeedback = null;
  renderGithubToken();
  try {
    await invoke(command, args);
    githubTokenFeedback = { key: successKey };
  } catch (error) {
    const key = typeof error === "string" && Object.hasOwn(githubTokenErrors, error)
      ? githubTokenErrors[error] : "githubToken.operationFailed";
    githubTokenFeedback = { key, error: true };
  } finally {
    githubTokenPending = false;
    renderGithubToken();
  }
}

const githubTokenInput = get("github-token");
githubTokenInput.addEventListener("input", () => {
  githubTokenFeedback = null;
  renderGithubToken();
});

get("github-token-settings").addEventListener("submit", (event) => {
  event.preventDefault();
  if (get("save-github-token").disabled) return;
  const token = githubTokenInput.value.trim();
  githubTokenInput.value = "";
  void runGithubTokenAction("save_github_update_token", "githubToken.saved", { token });
});

get("test-github-token").addEventListener("click", () => {
  if (get("test-github-token").disabled) return;
  void runGithubTokenAction("test_github_update_token", "githubToken.tested");
});

get("remove-github-token").addEventListener("click", () => {
  if (get("remove-github-token").disabled) return;
  githubTokenInput.value = "";
  void runGithubTokenAction("remove_github_update_token", "githubToken.removed");
});

void i18n.sync().then(refresh);
