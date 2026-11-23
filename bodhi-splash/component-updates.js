const get = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
const labels = { github: "GitHub 官方", "gh-proxy": "gh-proxy.com", "gh-fast": "ghfast.top" };
let actionError = "";

function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
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
  if (document.activeElement !== get("source")) get("source").value = snapshot.source;
  get("check").textContent = snapshot.running ? "检查更新" : "重试加载";
  get("check").disabled = (snapshot.running && !!queued) || !!display.progress || ["正在检查组件更新", "正在启动组件"].includes(display.phase);
  get("phase").textContent = queued && snapshot.running ? "下次启动时升级" : display.phase || "正在准备组件";
  get("error").hidden = !(actionError || display.error);
  get("error").textContent = actionError || display.error || "";
  get("last-check").textContent = snapshot.lastCheck ? `上次检查 ${new Date(snapshot.lastCheck).toLocaleString()}` : "";

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
    const counter = total > 0
      ? `${bytes(transfer.received)} / ${bytes(total)} · ${Math.floor(100 * transfer.received / total)}%`
      : bytes(transfer.received);
    get("download-detail").textContent = `${transfer.file} · ${labels[transfer.source] || "npm"} · ${counter}`;
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
      if (offer.changes[key].length === 0) append(changes, "发布说明暂不可用");
    }
  }

  const historyList = get("history");
  historyList.replaceChildren();
  get("history-empty").hidden = history.length > 0;
  for (const item of [...history].reverse()) {
    const from = item.from ? `Bamboo ${item.from.bamboo} / Lotus Next ${item.from.lotus} → ` : "";
    const to = `Bamboo ${item.to.bamboo} / Lotus Next ${item.to.lotus}`;
    const effective = item.effective ? `Bamboo ${item.effective.bamboo} / Lotus Next ${item.effective.lotus}` : "—";
    const outcome = item.error ? `失败 · 生效版本 ${effective} · ${item.error}` : "已生效";
    append(historyList, `${new Date(item.at).toLocaleString()} · ${from}${to} · ${outcome}`);
  }
}

async function refresh() {
  try {
    render(await invoke("component_snapshot"));
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

get("source").addEventListener("change", async (event) => {
  actionError = "";
  try { await invoke("set_component_source", { source: event.target.value }); }
  catch (error) { actionError = String(error); }
});

refresh();
