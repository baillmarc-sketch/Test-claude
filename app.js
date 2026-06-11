/* WeatherWear — learns your wardrobe from daily outfit logs + comfort feedback,
   then recommends clothes for today's weather. All data stays in localStorage. */

(() => {
  "use strict";

  // ======================= storage =======================

  const LS = {
    entries: "ww_entries",   // [{id,date,photo,items:[id],weather,comfort,wet}]
    wardrobe: "ww_wardrobe", // [{id,name,category}]
    location: "ww_location", // {lat,lon,name}
  };

  const load = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  let entries = load(LS.entries, []);
  let wardrobe = load(LS.wardrobe, null);
  let location = load(LS.location, null);

  // Starter wardrobe so the chip list isn't empty on day one.
  if (!wardrobe) {
    wardrobe = [
      ["T-shirt", "top"], ["Long-sleeve shirt", "top"], ["Sweater", "top"],
      ["Hoodie", "top"], ["Shorts", "bottom"], ["Jeans", "bottom"],
      ["Light jacket", "outer"], ["Rain jacket", "outer"], ["Winter coat", "outer"],
      ["Sneakers", "footwear"], ["Boots", "footwear"], ["Sandals", "footwear"],
      ["Umbrella", "accessory"], ["Scarf", "accessory"], ["Hat", "accessory"],
    ].map(([name, category], i) => ({ id: "w" + i, name, category }));
    save(LS.wardrobe, wardrobe);
  }

  const CATEGORIES = ["top", "bottom", "outer", "footwear", "accessory"];
  const CATEGORY_LABEL = {
    top: "Tops", bottom: "Bottoms", outer: "Outerwear",
    footwear: "Footwear", accessory: "Accessories",
  };
  const CATEGORY_ICON = {
    top: "👕", bottom: "👖", outer: "🧥", footwear: "👟", accessory: "🧣",
  };

  const itemById = (id) => wardrobe.find((w) => w.id === id);
  const $ = (sel) => document.querySelector(sel);
  const todayStr = () => new Date().toISOString().slice(0, 10);

  // ======================= weather =======================

  let currentWeather = null; // {temp,feels,humidity,rainProb,precip,code,hi,lo}

  const WMO_ICONS = [
    [[0], "☀️"], [[1, 2], "🌤️"], [[3], "☁️"], [[45, 48], "🌫️"],
    [[51, 53, 55, 61, 63, 65, 80, 81, 82], "🌧️"], [[56, 57, 66, 67], "🌨️"],
    [[71, 73, 75, 77, 85, 86], "❄️"], [[95, 96, 99], "⛈️"],
  ];
  const weatherIcon = (code) =>
    (WMO_ICONS.find(([codes]) => codes.includes(code)) || [null, "🌡️"])[1];

  async function fetchWeather(lat, lon) {
    const url = "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lat}&longitude=${lon}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      "&timezone=auto&forecast_days=1";
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather service unavailable");
    const data = await res.json();
    return {
      temp: data.current.temperature_2m,
      feels: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      precip: data.current.precipitation,
      code: data.current.weather_code,
      hi: data.daily.temperature_2m_max[0],
      lo: data.daily.temperature_2m_min[0],
      rainProb: data.daily.precipitation_probability_max[0] ?? 0,
    };
  }

  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch(
        "https://api.bigdatacloud.net/data/reverse-geocode-client" +
        `?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      const data = await res.json();
      return data.city || data.locality || data.principalSubdivision || null;
    } catch { return null; }
  }

  async function searchCity(query) {
    const res = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search" +
      `?name=${encodeURIComponent(query)}&count=6&language=en`);
    const data = await res.json();
    return data.results || [];
  }

  function setLocation(lat, lon, name) {
    location = { lat, lon, name };
    save(LS.location, location);
    $("#location-pill").textContent = "📍 " + name;
    refreshWeather();
  }

  async function locateViaGPS() {
    if (!navigator.geolocation) return false;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lon } = pos.coords;
          const name = (await reverseGeocode(lat, lon)) ||
            `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
          setLocation(lat, lon, name);
          resolve(true);
        },
        () => resolve(false),
        { timeout: 10000 },
      );
    });
  }

  async function refreshWeather() {
    if (!location) return;
    $("#weather-loading").classList.remove("hidden");
    $("#weather-error").classList.add("hidden");
    try {
      currentWeather = await fetchWeather(location.lat, location.lon);
      renderWeather();
      renderRecommendation();
      renderLogWeatherNote();
    } catch (err) {
      $("#weather-loading").classList.add("hidden");
      const el = $("#weather-error");
      el.textContent = "Couldn't fetch weather: " + err.message;
      el.classList.remove("hidden");
    }
  }

  function renderWeather() {
    const w = currentWeather;
    $("#weather-loading").classList.add("hidden");
    $("#weather-display").classList.remove("hidden");
    $("#w-icon").textContent = weatherIcon(w.code);
    $("#w-temp").textContent = Math.round(w.temp) + "°C";
    $("#w-feels").textContent = Math.round(w.feels) + "°C";
    $("#w-humidity").textContent = Math.round(w.humidity) + "%";
    $("#w-rain").textContent = Math.round(w.rainProb) + "%";
    $("#w-hilo").textContent = `${Math.round(w.hi)}° / ${Math.round(w.lo)}°`;
  }

  // ======================= learning engine =======================

  // If an outfit felt too cold, it was dressed for warmer weather than the
  // actual temperature — shift its "comfort temperature" up; too hot, down.
  const COMFORT_SHIFT = { cold: 4, good: 0, hot: -4 };

  // Entries the engine can learn from: comfort feedback given, weather known.
  const trainingEntries = () =>
    entries.filter((e) => e.comfort && e.weather);

  // Effective temperature an entry's outfit was comfortable at.
  const comfortTemp = (e) => e.weather.feels + COMFORT_SHIFT[e.comfort];

  // Gaussian similarity between today and a past day (temp dominates,
  // humidity refines, rain matters for matching rain-day outfits).
  function entryWeight(e, w) {
    const dTemp = comfortTemp(e) - w.feels;
    const dHum = (e.weather.humidity - w.humidity) / 25;
    const eWet = e.weather.rainProb >= 50 || e.weather.precip > 0 ? 1 : 0;
    const tWet = w.rainProb >= 50 || w.precip > 0 ? 1 : 0;
    let weight = Math.exp(-(dTemp * dTemp) / (2 * 4 * 4)) *
                 Math.exp(-(dHum * dHum) / 2);
    if (eWet === tWet) weight *= 1.25;
    if (e.comfort === "good") weight *= 1.5; // proven outfits count extra
    return weight;
  }

  // Per-item comfort range learned from history (for the Wardrobe view and
  // for sanity-checking recommendations).
  function itemStats(itemId) {
    const temps = trainingEntries()
      .filter((e) => e.items.includes(itemId))
      .map(comfortTemp);
    if (!temps.length) return null;
    const min = Math.min(...temps), max = Math.max(...temps);
    return { count: temps.length, min: min - 2, max: max + 2 };
  }

  // Rule-based fallback for the cold start, by feels-like temperature.
  function fallbackRecommendation(w) {
    const t = w.feels;
    const rec = { top: [], bottom: [], outer: [], footwear: [], accessory: [] };
    if (t >= 24) {
      rec.top.push("T-shirt"); rec.bottom.push("Shorts"); rec.footwear.push("Sandals");
    } else if (t >= 18) {
      rec.top.push("T-shirt"); rec.bottom.push("Jeans"); rec.footwear.push("Sneakers");
    } else if (t >= 12) {
      rec.top.push("Long-sleeve shirt"); rec.bottom.push("Jeans");
      rec.outer.push("Light jacket"); rec.footwear.push("Sneakers");
    } else if (t >= 5) {
      rec.top.push("Sweater"); rec.bottom.push("Jeans");
      rec.outer.push("Light jacket"); rec.footwear.push("Boots");
    } else {
      rec.top.push("Sweater"); rec.bottom.push("Jeans");
      rec.outer.push("Winter coat"); rec.footwear.push("Boots");
      rec.accessory.push("Scarf", "Hat");
    }
    return rec;
  }

  // Main recommender: score every wardrobe item across weather-similar past
  // days, pick the best per category, fall back to rules where data is thin.
  function recommend(w) {
    const training = trainingEntries();
    const scores = new Map(); // itemId -> score
    let totalWeight = 0;

    for (const e of training) {
      const weight = entryWeight(e, w);
      totalWeight += weight;
      for (const id of e.items) {
        scores.set(id, (scores.get(id) || 0) + weight);
      }
    }

    const learnedEnough = training.length >= 3 && totalWeight > 0.15;
    const fallback = fallbackRecommendation(w);
    const result = { groups: {}, learned: learnedEnough, notes: [] };

    for (const cat of CATEGORIES) {
      const ranked = [...scores.entries()]
        .map(([id, score]) => ({ item: itemById(id), score }))
        .filter((x) => x.item && x.item.category === cat && x.score > 0.05)
        .sort((a, b) => b.score - a.score);

      if (learnedEnough && ranked.length) {
        const top = ranked.filter((x) => x.score >= ranked[0].score * 0.55)
          .slice(0, cat === "accessory" ? 3 : 2);
        result.groups[cat] = top.map((x) => ({ name: x.item.name, learned: true }));
      } else if (fallback[cat].length) {
        result.groups[cat] = fallback[cat].map((name) => ({ name, learned: false }));
      }
    }

    // Outerwear is optional in warm weather — drop low-confidence suggestions.
    if (w.feels >= 21 && result.groups.outer?.every((g) => !g.learned)) {
      delete result.groups.outer;
    }

    // Rain advice: prefer rain gear the user actually owns/wears.
    if (w.rainProb >= 40 || w.precip > 0.2) {
      const rainGear = wardrobe.filter((it) =>
        /rain|umbrella|waterproof|poncho/i.test(it.name));
      const names = rainGear.length ? rainGear.map((g) => g.name) : ["Umbrella"];
      result.notes.push(`☔ ${Math.round(w.rainProb)}% chance of rain — bring: ${names.join(", ")}.`);
    }
    if (w.humidity >= 80 && w.feels >= 22) {
      result.notes.push("💧 High humidity — favor light, breathable fabrics.");
    }
    if (w.hi - w.lo >= 10) {
      result.notes.push(`🌗 Big temperature swing today (${Math.round(w.lo)}°–${Math.round(w.hi)}°) — layers you can shed will help.`);
    }
    return result;
  }

  function renderRecommendation() {
    if (!currentWeather) return;
    const rec = recommend(currentWeather);
    const container = $("#recommendation");
    container.innerHTML = "";

    for (const cat of CATEGORIES) {
      const group = rec.groups[cat];
      if (!group || !group.length) continue;
      const div = document.createElement("div");
      div.className = "rec-group";
      div.innerHTML = `<div class="rec-group-title">${CATEGORY_ICON[cat]} ${CATEGORY_LABEL[cat]}</div>`;
      const items = document.createElement("div");
      items.className = "rec-items";
      for (const g of group) {
        const span = document.createElement("span");
        span.className = "rec-item" + (g.learned ? " learned" : "");
        span.textContent = g.name;
        items.appendChild(span);
      }
      div.appendChild(items);
      container.appendChild(div);
    }

    for (const note of rec.notes) {
      const div = document.createElement("div");
      div.className = "rec-note";
      div.textContent = note;
      container.appendChild(div);
    }

    const n = trainingEntries().length;
    $("#rec-basis").textContent = rec.learned
      ? `Personalized from ${n} day${n === 1 ? "" : "s"} of your feedback. Highlighted items come from outfits that worked for you in similar weather.`
      : `General guidance for now — log your outfits and comfort daily, and recommendations will adapt to your wardrobe (${n}/3 feedback days so far).`;
  }

  // ======================= comfort check-in =======================

  function pendingCheckin() {
    return entries.find((e) => !e.comfort);
  }

  function renderCheckin() {
    const entry = pendingCheckin();
    const card = $("#checkin-card");
    if (!entry) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    card.dataset.entryId = entry.id;

    const isToday = entry.date === todayStr();
    card.querySelector("h2").textContent =
      isToday ? "How is today's outfit?" : "How was your outfit on " + entry.date + "?";
    const names = entry.items.map((id) => itemById(id)?.name).filter(Boolean);
    $("#checkin-summary").textContent =
      `${Math.round(entry.weather.temp)}°C, ${Math.round(entry.weather.humidity)}% humidity` +
      (names.length ? ` — you wore: ${names.join(", ")}.` : ".");
    const photo = $("#checkin-photo");
    if (entry.photo) { photo.src = entry.photo; photo.classList.remove("hidden"); }
    else photo.classList.add("hidden");
    $("#checkin-wet").checked = false;
  }

  function submitCheckin(comfort) {
    const id = $("#checkin-card").dataset.entryId;
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.comfort = comfort;
    entry.wet = $("#checkin-wet").checked;
    save(LS.entries, entries);
    renderCheckin();
    renderRecommendation();
    renderHistory();
    renderWardrobe();
  }

  // ======================= log outfit =======================

  let logPhoto = null;
  let logSelected = new Set();
  let logComfort = null;

  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 480;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(img.src);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function renderItemChips() {
    const container = $("#item-chips");
    container.innerHTML = "";
    for (const item of wardrobe) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (logSelected.has(item.id) ? " selected" : "");
      chip.innerHTML = `<span class="cat-dot">${CATEGORY_ICON[item.category]}</span>${item.name}`;
      chip.onclick = () => {
        logSelected.has(item.id) ? logSelected.delete(item.id) : logSelected.add(item.id);
        chip.classList.toggle("selected");
      };
      container.appendChild(chip);
    }
  }

  function renderLogWeatherNote() {
    if (!currentWeather) return;
    const w = currentWeather;
    $("#log-weather-note").textContent =
      `Will be saved with today's weather: ${Math.round(w.temp)}°C (feels ${Math.round(w.feels)}°), ` +
      `${Math.round(w.humidity)}% humidity, ${Math.round(w.rainProb)}% rain chance.`;
  }

  function saveLog() {
    const status = $("#log-status");
    if (!currentWeather) {
      status.textContent = "Waiting for weather data — set your location first.";
      return;
    }
    if (logSelected.size === 0) {
      status.textContent = "Select at least one clothing item.";
      return;
    }
    const existing = entries.find((e) => e.date === todayStr());
    const entry = {
      id: existing?.id || "e" + Date.now(),
      date: todayStr(),
      photo: logPhoto || existing?.photo || null,
      items: [...logSelected],
      weather: { ...currentWeather },
      comfort: logComfort,
      wet: false,
    };
    entries = entries.filter((e) => e.date !== todayStr());
    entries.unshift(entry);
    try {
      save(LS.entries, entries);
    } catch {
      // localStorage full — drop oldest photos and retry.
      for (let i = entries.length - 1; i >= 0 && entries[i].photo; i--) entries[i].photo = null;
      save(LS.entries, entries);
    }
    status.textContent = existing
      ? "Updated today's outfit ✓"
      : "Saved! " + (logComfort ? "Thanks for the feedback." : "We'll ask how it felt later.");
    logPhoto = null; logSelected = new Set(); logComfort = null;
    $("#photo-preview").classList.add("hidden");
    $("#photo-hint").classList.remove("hidden");
    document.querySelectorAll("#log-comfort .comfort").forEach((b) => b.classList.remove("selected"));
    renderItemChips();
    renderCheckin();
    renderHistory();
    renderRecommendation();
    renderWardrobe();
  }

  // ======================= history =======================

  const COMFORT_BADGE = {
    cold: ["cold", "🥶 Too cold"], good: ["good", "😌 Comfortable"],
    hot: ["hot", "🥵 Too hot"],
  };

  function renderHistory() {
    const list = $("#history-list");
    list.innerHTML = "";
    if (!entries.length) {
      list.innerHTML = '<p class="muted">No outfits logged yet. Start on the "Log Outfit" tab!</p>';
      return;
    }
    for (const e of entries) {
      const div = document.createElement("div");
      div.className = "history-entry";
      const names = e.items.map((id) => itemById(id)?.name).filter(Boolean).join(", ");
      const [cls, label] = e.comfort
        ? COMFORT_BADGE[e.comfort]
        : ["pending", "⏳ Awaiting feedback"];
      div.innerHTML = `
        ${e.photo ? `<img class="history-photo" src="${e.photo}" alt="Outfit on ${e.date}">`
                  : '<div class="history-photo"></div>'}
        <div class="history-meta">
          <div class="history-date">${e.date}</div>
          <div class="history-weather">${weatherIcon(e.weather.code)}
            ${Math.round(e.weather.temp)}°C · ${Math.round(e.weather.humidity)}% humidity ·
            ${Math.round(e.weather.rainProb)}% rain${e.wet ? " · got wet ☔" : ""}</div>
          <div class="history-items">${names || "<i>no items recorded</i>"}</div>
          <span class="comfort-badge ${cls}">${label}</span>
        </div>
        <button class="delete-entry" title="Delete entry">🗑️</button>`;
      div.querySelector(".delete-entry").onclick = () => {
        if (!confirm(`Delete the entry from ${e.date}?`)) return;
        entries = entries.filter((x) => x.id !== e.id);
        save(LS.entries, entries);
        renderHistory(); renderCheckin(); renderRecommendation(); renderWardrobe();
      };
      list.appendChild(div);
    }
  }

  // ======================= wardrobe view =======================

  // Map a temperature to a 0–100% position on the -10°…40° range bar.
  const tempPos = (t) => Math.max(0, Math.min(100, ((t + 10) / 50) * 100));

  function renderWardrobe() {
    const list = $("#wardrobe-list");
    list.innerHTML = "";
    for (const cat of CATEGORIES) {
      const items = wardrobe.filter((w) => w.category === cat);
      if (!items.length) continue;
      const title = document.createElement("div");
      title.className = "rec-group-title";
      title.style.marginTop = "14px";
      title.textContent = `${CATEGORY_ICON[cat]} ${CATEGORY_LABEL[cat]}`;
      list.appendChild(title);

      for (const item of items) {
        const stats = itemStats(item.id);
        const div = document.createElement("div");
        div.className = "wardrobe-item";
        let rangeHtml = '<span class="wardrobe-range muted">not worn yet</span>';
        if (stats) {
          const left = tempPos(stats.min);
          const width = Math.max(4, tempPos(stats.max) - left);
          rangeHtml = `
            <div class="range-bar"><div class="range-window" style="left:${left}%;width:${width}%"></div></div>
            <span class="wardrobe-range">${Math.round(stats.min)}°–${Math.round(stats.max)}°C · worn ${stats.count}×</span>`;
        }
        div.innerHTML = `<span class="wardrobe-name">${item.name}</span>${rangeHtml}`;
        list.appendChild(div);
      }
    }
  }

  // ======================= import / export / reset =======================

  function exportData() {
    const blob = new Blob(
      [JSON.stringify({ entries, wardrobe, location }, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `weatherwear-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.entries) || !Array.isArray(data.wardrobe)) {
          throw new Error("not a WeatherWear backup");
        }
        entries = data.entries; wardrobe = data.wardrobe;
        save(LS.entries, entries); save(LS.wardrobe, wardrobe);
        if (data.location) setLocation(data.location.lat, data.location.lon, data.location.name);
        renderItemChips(); renderHistory(); renderWardrobe();
        renderCheckin(); renderRecommendation();
        alert("Data imported ✓");
      } catch (err) {
        alert("Import failed: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ======================= UI wiring =======================

  // Tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("#tab-" + btn.dataset.tab).classList.add("active");
    };
  });

  // Check-in buttons
  document.querySelectorAll("#checkin-card .comfort").forEach((btn) => {
    btn.onclick = () => submitCheckin(btn.dataset.comfort);
  });

  // Log form
  $("#photo-drop").onclick = () => $("#photo-input").click();
  $("#photo-input").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    logPhoto = await resizePhoto(file);
    const preview = $("#photo-preview");
    preview.src = logPhoto;
    preview.classList.remove("hidden");
    $("#photo-hint").classList.add("hidden");
  };

  document.querySelectorAll("#log-comfort .comfort").forEach((btn) => {
    btn.onclick = () => {
      const wasSelected = btn.classList.contains("selected");
      document.querySelectorAll("#log-comfort .comfort").forEach((b) => b.classList.remove("selected"));
      logComfort = wasSelected ? null : btn.dataset.comfort;
      if (!wasSelected) btn.classList.add("selected");
    };
  });

  $("#add-item-btn").onclick = () => {
    const name = $("#new-item-name").value.trim();
    if (!name) return;
    if (wardrobe.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
      $("#new-item-name").value = "";
      return;
    }
    const item = { id: "w" + Date.now(), name, category: $("#new-item-category").value };
    wardrobe.push(item);
    save(LS.wardrobe, wardrobe);
    logSelected.add(item.id);
    $("#new-item-name").value = "";
    renderItemChips();
    renderWardrobe();
  };
  $("#new-item-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#add-item-btn").click();
  });

  $("#save-log-btn").onclick = saveLog;

  // Location dialog
  const dialog = $("#location-dialog");
  $("#location-pill").onclick = () => dialog.showModal();
  $("#close-location-btn").onclick = () => dialog.close();
  $("#use-gps-btn").onclick = async () => {
    dialog.close();
    $("#location-pill").textContent = "📍 Locating…";
    if (!(await locateViaGPS())) {
      $("#location-pill").textContent = "📍 Set location";
      dialog.showModal();
    }
  };

  let searchTimer = null;
  $("#city-input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $("#city-input").value.trim();
      const box = $("#city-results");
      box.innerHTML = "";
      if (q.length < 2) return;
      try {
        for (const r of await searchCity(q)) {
          const div = document.createElement("div");
          div.className = "city-result";
          div.textContent = `${r.name}${r.admin1 ? ", " + r.admin1 : ""}, ${r.country}`;
          div.onclick = () => {
            setLocation(r.latitude, r.longitude, r.name);
            dialog.close();
          };
          box.appendChild(div);
        }
      } catch { /* network hiccup — user can retype */ }
    }, 350);
  });

  // Data buttons
  $("#export-btn").onclick = exportData;
  $("#import-btn").onclick = () => $("#import-input").click();
  $("#import-input").onchange = (e) => e.target.files[0] && importData(e.target.files[0]);
  $("#reset-btn").onclick = () => {
    if (!confirm("Delete ALL outfits, feedback and wardrobe data? This cannot be undone.")) return;
    Object.values(LS).forEach((k) => localStorage.removeItem(k));
    window.location.reload();
  };

  // ======================= boot =======================

  renderItemChips();
  renderHistory();
  renderWardrobe();
  renderCheckin();

  if (location) {
    $("#location-pill").textContent = "📍 " + location.name;
    refreshWeather();
  } else {
    locateViaGPS().then((ok) => {
      if (!ok) {
        $("#location-pill").textContent = "📍 Set location";
        dialog.showModal();
      }
    });
  }
})();
