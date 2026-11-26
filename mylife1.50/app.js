"use strict";

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const syncIndicator = document.querySelector("#sync-indicator");
const syncLabel = document.querySelector("#sync-label");
const menuButton = document.querySelector("#menu-button");
const sideMenu = document.querySelector("#side-menu");
const menuBackdrop = document.querySelector("#menu-backdrop");
const importFile = document.querySelector("#import-file");
const categories = ["Alimentação", "Transporte", "Moradia", "Saúde", "Lazer", "Compras", "Salário", "Trabalho extra", "Investimentos", "Educação", "Contas", "Assinaturas", "Outros"];
const paymentMethods = ["Cartão", "Transferência", "Dinheiro", "Débito direto", "Outro"];
const moodOptions = [
  { value: "ótimo", emoji: "😄", label: "Ótimo" },
  { value: "bem", emoji: "🙂", label: "Bem" },
  { value: "mais ou menos", emoji: "😐", label: "Assim" },
  { value: "cansado", emoji: "😮‍💨", label: "Cansado" },
  { value: "difícil", emoji: "🌧️", label: "Difícil" }
];
const databaseName = "mylife-private-data";
const databaseVersion = 1;
const stateStore = "profiles";

let state = emptyData();
let activePage = "inicio";
let editingId = null;
let financePeriod = "month";
let financeDate = localDate();
let calendarCursor = new Date();
let selectedCalendarDate = localDate();
let supabase = null;
let currentUser = null;
let userId = null;
let cloudLoadedForUser = null;
let toastTimeout;
let dbPromise;
let localSaveQueue = Promise.resolve();
let syncQueue = Promise.resolve();
let reminderTimer;
let chatMessages = [
  { role: "assistant", content: "Oi! Sou seu espaço para pensar com calma. O que está passando pela sua cabeça hoje?" }
];

function emptyData() {
  return {
    transactions: [],
    commitments: [],
    tasks: [],
    goals: [],
    payables: [],
    receivables: [],
    shopping: [],
    notes: [],
    piggyBanks: [],
    subscriptions: [],
    habits: [],
    journal: [],
    mood: null,
    budgets: { monthlyLimit: 0, weeklyLimit: 0, savingsTarget: 0, categoryLimits: {} },
    settings: {
      appName: "MyLife",
      theme: "dark",
      palette: "mint",
      layout: "comfortable",
      chartType: "bars",
      currency: "EUR",
      initialBalance: 0,
      notifications: false
    }
  };
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeData(value) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = emptyData();
  const asArray = (key, legacyKey) => Array.isArray(source[key]) ? source[key] : Array.isArray(source[legacyKey]) ? source[legacyKey] : [];
  const normalizeList = (items, mapper) => items.filter(item => item && typeof item === "object").map(item => mapper(item)).filter(Boolean);
  const normalizeAmount = value => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 && amount <= 100000000 ? Math.round(amount * 100) / 100 : 0;
  };

  defaults.transactions = normalizeList(asArray("transactions"), item => {
    const type = item.type === "income" ? "income" : item.type === "expense" ? "expense" : null;
    if (!type || !cleanText(item.title, 140)) return null;
    const amount = normalizeAmount(item.amount);
    if (!amount) return null;
    return {
      id: String(item.id || makeId()),
      title: cleanText(item.title, 140),
      amount,
      type,
      category: cleanText(item.category, 60) || "Outros",
      date: validDate(item.date) ? new Date(item.date).toISOString() : validDate(item.createdAt) ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
      paymentMethod: cleanText(item.paymentMethod, 50) || "Outro",
      account: cleanText(item.account, 80),
      sourceKey: typeof item.sourceKey === "string" ? item.sourceKey : ""
    };
  });

  defaults.commitments = normalizeList(asArray("commitments", "appointments"), item => {
    const title = cleanText(item.title, 140);
    const oldDate = item.when;
    const date = typeof item.date === "string" ? item.date : validDate(oldDate) ? new Date(oldDate).toISOString().slice(0, 10) : "";
    if (!title || !date) return null;
    return {
      id: String(item.id || makeId()),
      title,
      date,
      time: cleanText(item.time, 5) || (validDate(oldDate) ? new Date(oldDate).toTimeString().slice(0, 5) : ""),
      location: cleanText(item.location, 160),
      notes: cleanText(item.notes, 1000),
      category: cleanText(item.category, 60) || "Pessoal",
      reminder: Math.max(0, Number(item.reminder) || 0),
      done: Boolean(item.done)
    };
  });

  defaults.tasks = normalizeList(asArray("tasks"), item => {
    const title = cleanText(item.title, 140);
    if (!title) return null;
    return {
      id: String(item.id || makeId()),
      title,
      description: cleanText(item.description, 1000),
      dueDate: typeof item.dueDate === "string" ? item.dueDate : "",
      dueTime: cleanText(item.dueTime, 5),
      priority: ["low", "medium", "high"].includes(item.priority) ? item.priority : "medium",
      category: cleanText(item.category, 60) || "Pessoal",
      done: Boolean(item.done),
      priorityToday: Boolean(item.priorityToday)
    };
  });

  defaults.goals = normalizeList(asArray("goals"), item => {
    const title = cleanText(item.title, 140);
    if (!title) return null;
    const legacyProgress = Number.isFinite(Number(item.progress)) ? Number(item.progress) : 0;
    return {
      id: String(item.id || makeId()),
      title,
      target: normalizeAmount(item.target) || 100,
      current: normalizeAmount(item.current) || legacyProgress,
      deadline: typeof item.deadline === "string" ? item.deadline : "",
      linkedPiggyId: typeof item.linkedPiggyId === "string" ? item.linkedPiggyId : ""
    };
  });

  for (const [key, statusKey] of [["payables", "paid"], ["receivables", "received"]]) {
    defaults[key] = normalizeList(asArray(key), item => {
      const title = cleanText(item.title, 140);
      const amount = normalizeAmount(item.amount);
      if (!title || !amount) return null;
      return {
        id: String(item.id || makeId()),
        title,
        amount,
        dueDate: typeof item.dueDate === "string" ? item.dueDate : "",
        category: cleanText(item.category, 60) || "Outros",
        [statusKey]: Boolean(item[statusKey]),
        transactionId: typeof item.transactionId === "string" ? item.transactionId : ""
      };
    });
  }

  defaults.shopping = normalizeList(asArray("shopping"), item => {
    const title = cleanText(item.title, 140);
    if (!title) return null;
    return {
      id: String(item.id || makeId()),
      title,
      quantity: Math.max(1, Number(item.quantity) || 1),
      price: normalizeAmount(item.price),
      category: cleanText(item.category, 60) || "Outros",
      bought: Boolean(item.bought)
    };
  });

  defaults.notes = normalizeList(asArray("notes"), item => {
    const title = cleanText(item.title, 140);
    if (!title) return null;
    return {
      id: String(item.id || makeId()),
      title,
      body: cleanText(item.body, 5000),
      category: cleanText(item.category, 60) || "Pessoal",
      updatedAt: validDate(item.updatedAt) ? new Date(item.updatedAt).toISOString() : new Date().toISOString()
    };
  });

  defaults.piggyBanks = normalizeList(asArray("piggyBanks"), item => {
    const title = cleanText(item.title, 140);
    if (!title) return null;
    const history = normalizeList(Array.isArray(item.history) ? item.history : [], entry => {
      const amount = normalizeAmount(entry.amount);
      if (!amount || !["deposit", "withdrawal"].includes(entry.type)) return null;
      return { id: String(entry.id || makeId()), amount, type: entry.type, date: validDate(entry.date) ? new Date(entry.date).toISOString() : new Date().toISOString() };
    });
    return {
      id: String(item.id || makeId()),
      title,
      target: normalizeAmount(item.target),
      current: normalizeAmount(item.current),
      deadline: typeof item.deadline === "string" ? item.deadline : "",
      description: cleanText(item.description, 1000),
      linkedGoalId: typeof item.linkedGoalId === "string" ? item.linkedGoalId : "",
      history
    };
  });

  defaults.subscriptions = normalizeList(asArray("subscriptions"), item => {
    const title = cleanText(item.title, 140);
    const amount = normalizeAmount(item.amount);
    if (!title || !amount || !["weekly", "monthly", "quarterly", "annual"].includes(item.frequency)) return null;
    return {
      id: String(item.id || makeId()),
      title,
      amount,
      billingDate: typeof item.billingDate === "string" ? item.billingDate : localDate(),
      frequency: item.frequency,
      paymentMethod: cleanText(item.paymentMethod, 50) || "Cartão",
      status: item.status === "cancelled" ? "cancelled" : "active",
      payments: Array.isArray(item.payments) ? item.payments.filter(date => typeof date === "string") : []
    };
  });

  defaults.habits = normalizeList(asArray("habits"), item => {
    const title = cleanText(item.title, 140);
    if (!title) return null;
    return {
      id: String(item.id || makeId()),
      title,
      category: cleanText(item.category, 60) || "Saúde",
      frequency: item.frequency === "weekly" ? "weekly" : "daily",
      time: cleanText(item.time, 5),
      targetPerWeek: Math.max(1, Math.min(7, Number(item.targetPerWeek) || 7)),
      history: Array.isArray(item.history) ? item.history.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)) : []
    };
  });

  defaults.journal = normalizeList(asArray("journal"), item => {
    const text = cleanText(item.text, 3000);
    if (!text) return null;
    return { id: String(item.id || makeId()), text, createdAt: validDate(item.createdAt) ? new Date(item.createdAt).toISOString() : new Date().toISOString() };
  });

  const oldBudgets = source.budgets && typeof source.budgets === "object" ? source.budgets : {};
  defaults.budgets = {
    monthlyLimit: normalizeAmount(oldBudgets.monthlyLimit),
    weeklyLimit: normalizeAmount(oldBudgets.weeklyLimit),
    savingsTarget: normalizeAmount(oldBudgets.savingsTarget),
    categoryLimits: oldBudgets.categoryLimits && typeof oldBudgets.categoryLimits === "object"
      ? Object.fromEntries(Object.entries(oldBudgets.categoryLimits).map(([name, amount]) => [cleanText(name, 60), normalizeAmount(amount)]).filter(([name]) => name))
      : {}
  };
  const oldSettings = source.settings && typeof source.settings === "object" ? source.settings : {};
  defaults.settings = {
    appName: cleanText(oldSettings.appName, 36) || "MyLife",
    theme: oldSettings.theme === "light" ? "light" : "dark",
    palette: ["mint", "ocean", "violet", "sunset", "rose"].includes(oldSettings.palette) ? oldSettings.palette : "mint",
    layout: ["compact", "comfortable", "spacious"].includes(oldSettings.layout) ? oldSettings.layout : "comfortable",
    chartType: ["bars", "donut"].includes(oldSettings.chartType) ? oldSettings.chartType : "bars",
    currency: ["EUR", "BRL", "USD"].includes(oldSettings.currency) ? oldSettings.currency : "EUR",
    initialBalance: normalizeAmount(oldSettings.initialBalance),
    notifications: Boolean(oldSettings.notifications)
  };
  defaults.mood = moodOptions.some(option => option.value === source.mood) ? source.mood : null;
  return defaults;
}

function localDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function openDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB indisponível."));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(stateStore)) request.result.createObjectStore(stateStore, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento local."));
      request.onblocked = () => reject(new Error("O armazenamento local está bloqueado por outra aba."));
    });
  }
  return dbPromise;
}

function storageKey(accountId) {
  return `mylife-v2:${accountId || "guest"}`;
}

function mergeAccountData(localData, cloudData) {
  const local = normalizeData(localData);
  const cloud = normalizeData(cloudData);
  const collections = [
    "transactions", "commitments", "tasks", "goals", "payables", "receivables",
    "shopping", "notes", "piggyBanks", "subscriptions", "habits", "journal"
  ];
  const merged = { ...local, ...cloud };
  for (const collection of collections) {
    const records = new Map();
    for (const item of local[collection]) records.set(item.id, item);
    for (const item of cloud[collection]) records.set(item.id, item);
    merged[collection] = [...records.values()];
  }
  merged.settings = { ...local.settings, ...cloud.settings };
  merged.budgets = {
    ...local.budgets,
    ...cloud.budgets,
    categoryLimits: { ...local.budgets.categoryLimits, ...cloud.budgets.categoryLimits }
  };
  merged.mood = cloud.mood || local.mood;
  return normalizeData(merged);
}

function readLegacyState(accountId) {
  for (const key of [storageKey(accountId), `mylife-v1:${accountId || "guest"}`]) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return normalizeData(JSON.parse(raw));
    } catch (error) {
      console.error("Não foi possível migrar dados antigos.", error);
    }
  }
  return null;
}

async function loadLocalState(accountId) {
  try {
    const db = await openDatabase();
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction(stateStore, "readonly").objectStore(stateStore).get(storageKey(accountId));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (record && record.data) return normalizeData(record.data);
    const legacy = readLegacyState(accountId);
    if (legacy) await saveLocalState(accountId, legacy);
    return legacy;
  } catch (error) {
    console.warn("Usando armazenamento local alternativo.", error.message);
    return readLegacyState(accountId);
  }
}

async function saveLocalState(accountId, data) {
  const key = storageKey(accountId);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(stateStore, "readwrite");
      transaction.objectStore(stateStore).put({ key, data });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Falha ao salvar no IndexedDB."));
      transaction.onabort = () => reject(transaction.error || new Error("O salvamento local foi cancelado."));
    });
  } catch (error) {
    console.warn("IndexedDB indisponível; usando armazenamento alternativo.", error.message);
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (fallbackError) {
      throw new Error(`Não foi possível salvar neste aparelho: ${fallbackError.message}`);
    }
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", Boolean(isError));
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function setSyncStatus(status, label) {
  syncIndicator.classList.toggle("syncing", status === "syncing");
  syncIndicator.classList.toggle("sync-error", status === "error");
  syncLabel.textContent = label;
}

function currencyFormatter() {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: state.settings.currency });
}

function money(amount) {
  return currencyFormatter().format(Number(amount) || 0);
}

function formatDate(value, options = { day: "2-digit", month: "short", year: "numeric" }) {
  if (!value) return "Sem data";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (!Number.isFinite(date.getTime())) return "Sem data";
  return new Intl.DateTimeFormat("pt-BR", options).format(date);
}

function dateTime(value, time) {
  if (!value) return "Sem data";
  const date = new Date(`${value}T${time || "12:00"}`);
  return formatDate(date.toISOString(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function todayTitle() {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
}

function currentBalance() {
  const income = state.transactions.filter(item => item.type === "income").reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  const expenses = state.transactions.filter(item => item.type === "expense").reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  const saved = state.piggyBanks.reduce((sum, item) => sum + Math.round(item.current * 100), 0);
  return (Math.round(state.settings.initialBalance * 100) + income - expenses - saved) / 100;
}

function monthTransactions(date = new Date()) {
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return state.transactions.filter(item => item.date.slice(0, 7) === month);
}

function totalTransactions(items, type) {
  return items.filter(item => item.type === type).reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
}

function persist() {
  const snapshot = normalizeData(state);
  const accountId = userId;
  localSaveQueue = localSaveQueue.then(() => saveLocalState(accountId, snapshot)).catch(error => {
    console.error("Falha ao salvar no aparelho.", error);
    showToast(error.message || "Não foi possível salvar neste aparelho.", true);
  });
  if (!currentUser || !supabase || cloudLoadedForUser !== currentUser.id) {
    setSyncStatus("saved", "Salvo neste aparelho");
    return;
  }
  setSyncStatus("syncing", "Sincronizando…");
  const cloudUserId = currentUser.id;
  syncQueue = syncQueue.then(async () => {
    if (!currentUser || currentUser.id !== cloudUserId) return;
    const { error } = await supabase.from("mylife_data").upsert({
      user_id: cloudUserId,
      data: snapshot,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    if (currentUser && currentUser.id === cloudUserId) {
      await removeLocalState("guest");
    }
    setSyncStatus("saved", "Sincronizado");
  }).catch(error => {
    console.error("Falha ao sincronizar com o Supabase.", error);
    setSyncStatus("error", "Falha na sincronização");
    showToast("Seus dados continuam salvos neste aparelho. A sincronização falhou.", true);
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.palette = state.settings.palette;
  document.documentElement.dataset.layout = state.settings.layout;
  document.querySelector('meta[name="theme-color"]').content = state.settings.theme === "light" ? "#f4f7f5" : "#050706";
  document.title = `${state.settings.appName} — seu espaço pessoal`;
  document.querySelector("#app-name").textContent = state.settings.appName;
  const menuName = document.querySelector(".side-menu-heading span");
  if (menuName) menuName.textContent = state.settings.appName;
}

function loadCloudClient() {
  return new Promise((resolve, reject) => {
    if (window.supabase && window.supabase.createClient) return resolve(window.supabase);
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    script.onload = () => window.supabase && window.supabase.createClient
      ? resolve(window.supabase)
      : reject(new Error("Cliente do Supabase indisponível."));
    script.onerror = () => reject(new Error("Não foi possível carregar o cliente do Supabase."));
    document.head.appendChild(script);
  });
}

async function applySession(user) {
  const nextId = user ? user.id : null;
  if (nextId === userId && Boolean(user) === Boolean(currentUser)) return;
  userId = nextId;
  currentUser = user || null;
  cloudLoadedForUser = null;
  if (user && supabase) {
    setSyncStatus("syncing", "Carregando nuvem…");
    try {
      const { data, error } = await supabase.from("mylife_data").select("data").eq("user_id", user.id).maybeSingle();
      if (userId !== user.id) return;
      if (error) throw error;
      const accountLocal = await loadLocalState(user.id);
      const guestLocal = await loadLocalState("guest");
      const cloudData = data && data.data ? data.data : emptyData();
      state = mergeAccountData(guestLocal || emptyData(), mergeAccountData(accountLocal || emptyData(), cloudData));
      cloudLoadedForUser = user.id;
      await saveLocalState(user.id, state);
      if (guestLocal) await saveLocalState("guest", guestLocal);

      const localDataExists = Boolean(accountLocal || guestLocal);
      const mergedHasLocalRecords = localDataExists && JSON.stringify(state) !== JSON.stringify(normalizeData(cloudData));
      if (!data || mergedHasLocalRecords) {
        persist();
      } else {
        setSyncStatus("saved", "Sincronizado");
      }
    } catch (error) {
      if (userId !== user.id) return;
      console.error("Falha ao carregar os dados da nuvem.", error);
      state = await loadLocalState(user.id) || await loadLocalState("guest") || emptyData();
      setSyncStatus("error", "Falha na sincronização");
      showToast("Não foi possível carregar os dados da nuvem. Seus dados locais foram mantidos; entre novamente quando a conexão voltar.", true);
    }
  } else {
    state = await loadLocalState("guest") || emptyData();
    setSyncStatus("saved", "Salvo neste aparelho");
  }
  applyTheme();
  render();
}

async function configureSupabase() {
  try {
    const response = await fetch("./api/config");
    if (!response.ok) return;
    const config = await response.json();
    if (!config.supabaseUrl || !config.supabaseAnonKey) return;
    const sdk = await loadCloudClient();
    supabase = sdk.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session ? session.user : null);
    });
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    await applySession(data.session ? data.session.user : null);
  } catch (error) {
    console.error("Não foi possível conectar ao Supabase.", error);
    if (error.name !== "TypeError") showToast("A nuvem está indisponível. Seus dados continuam locais.", true);
  }
}

function renderField(field, value) {
  const current = value === undefined || value === null ? "" : value;
  const required = field.required === false ? "" : "required";
  if (field.type === "textarea") {
    return `<label class="form-field">${escapeHtml(field.label)}<textarea class="text-area" name="${field.key}" maxlength="${field.maxlength || 1000}" ${required}>${escapeHtml(current)}</textarea></label>`;
  }
  if (field.type === "select") {
    const options = typeof field.options === "function" ? field.options() : field.options;
    return `<label class="form-field">${escapeHtml(field.label)}<select class="text-input" name="${field.key}" ${required}>
      ${options.map(option => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(current || field.default || "") ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
    </select></label>`;
  }
  const inputValue = field.type === "datetime-local" && current
    ? toLocalDateTime(current)
    : field.type === "date" && current
      ? String(current).slice(0, 10)
      : current;
  const defaultValue = inputValue || field.default || "";
  return `<label class="form-field">${escapeHtml(field.label)}<input class="text-input" type="${field.type || "text"}" name="${field.key}" ${field.type === "number" ? `min="${field.min || 0}" max="${field.max || 100000000}" step="${field.step || "0.01"}"` : ""} ${field.type === "text" ? `maxlength="${field.maxlength || 140}"` : ""} value="${escapeHtml(defaultValue)}" ${required}></label>`;
}

function toLocalDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fieldValue(field, value) {
  if (field.type === "number") {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
  }
  if (field.type === "datetime-local" && value) return new Date(value).toISOString();
  return String(value || "").trim();
}

const commonCategoryOptions = () => categories.map(category => ({ value: category, label: category }));
const moduleConfigs = {
  financas: {
    title: "Controle financeiro", intro: "Registre entradas e saídas; o saldo é atualizado automaticamente.", collection: "transactions",
    fields: [
      { key: "title", label: "Descrição", type: "text" },
      { key: "type", label: "Tipo", type: "select", default: "expense", options: [{ value: "expense", label: "Saída" }, { value: "income", label: "Entrada" }] },
      { key: "amount", label: "Valor", type: "number", min: 0.01, step: "0.01" },
      { key: "category", label: "Categoria", type: "select", default: "Outros", options: commonCategoryOptions },
      { key: "date", label: "Data", type: "date", default: localDate() },
      { key: "paymentMethod", label: "Forma de pagamento", type: "select", default: "Cartão", options: paymentMethods.map(value => ({ value, label: value })) },
      { key: "account", label: "Conta utilizada", type: "text", required: false }
    ]
  },
  compromissos: {
    title: "Compromissos", intro: "Organize seus encontros e lembretes por data.", collection: "commitments",
    fields: [
      { key: "title", label: "Nome ou descrição", type: "text" },
      { key: "date", label: "Data", type: "date", default: localDate() },
      { key: "time", label: "Horário", type: "time", required: false },
      { key: "location", label: "Local", type: "text", required: false },
      { key: "notes", label: "Observações", type: "textarea", required: false },
      { key: "category", label: "Categoria", type: "select", default: "Pessoal", options: ["Pessoal", "Trabalho", "Saúde", "Viagem", "Outro"].map(value => ({ value, label: value })) },
      { key: "reminder", label: "Lembrete (minutos antes)", type: "number", min: 0, max: 10080, step: "1", default: 30, required: false }
    ]
  },
  tarefas: {
    title: "Tarefas", intro: "Acompanhe prazos, prioridades e o que já concluiu.", collection: "tasks",
    fields: [
      { key: "title", label: "Nome da tarefa", type: "text" },
      { key: "description", label: "Descrição", type: "textarea", required: false },
      { key: "dueDate", label: "Data limite", type: "date", required: false },
      { key: "dueTime", label: "Horário", type: "time", required: false },
      { key: "priority", label: "Prioridade", type: "select", default: "medium", options: [{ value: "low", label: "Baixa" }, { value: "medium", label: "Média" }, { value: "high", label: "Alta" }] },
      { key: "category", label: "Categoria", type: "select", default: "Pessoal", options: ["Pessoal", "Trabalho", "Casa", "Saúde", "Outro"].map(value => ({ value, label: value })) }
    ]
  },
  metas: {
    title: "Metas pessoais", intro: "Defina um objetivo e acompanhe quanto já alcançou.", collection: "goals",
    fields: [
      { key: "title", label: "Nome da meta", type: "text" },
      { key: "target", label: "Valor desejado", type: "number", min: 0.01, step: "0.01" },
      { key: "current", label: "Valor já alcançado", type: "number", min: 0, step: "0.01", required: false },
      { key: "deadline", label: "Prazo", type: "date", required: false },
      { key: "linkedPiggyId", label: "Cofrinho vinculado", type: "select", required: false, default: "", options: () => [{ value: "", label: "Nenhum" }, ...state.piggyBanks.map(item => ({ value: item.id, label: item.title }))] }
    ]
  },
  "contas-pagar": {
    title: "Contas a pagar", intro: "Acompanhe vencimentos e marque contas como pagas.", collection: "payables",
    fields: [
      { key: "title", label: "Nome da conta", type: "text" },
      { key: "amount", label: "Valor", type: "number", min: 0.01, step: "0.01" },
      { key: "dueDate", label: "Vencimento", type: "date", default: localDate() },
      { key: "category", label: "Categoria", type: "select", default: "Contas", options: commonCategoryOptions }
    ]
  },
  "contas-receber": {
    title: "Contas a receber", intro: "Registre valores previstos e acompanhe os recebimentos.", collection: "receivables",
    fields: [
      { key: "title", label: "Nome ou origem", type: "text" },
      { key: "amount", label: "Valor", type: "number", min: 0.01, step: "0.01" },
      { key: "dueDate", label: "Data prevista", type: "date", default: localDate() },
      { key: "category", label: "Categoria", type: "select", default: "Outros", options: commonCategoryOptions }
    ]
  },
  compras: {
    title: "Lista de compras", intro: "Marque o que já comprou e acompanhe o total estimado.", collection: "shopping",
    fields: [
      { key: "title", label: "Produto", type: "text" },
      { key: "quantity", label: "Quantidade", type: "number", min: 1, step: "1", default: 1 },
      { key: "price", label: "Preço estimado por unidade", type: "number", min: 0, step: "0.01", required: false },
      { key: "category", label: "Categoria", type: "select", default: "Outros", options: commonCategoryOptions }
    ]
  },
  anotacoes: {
    title: "Anotações", intro: "Registre e pesquise suas notas pessoais.", collection: "notes",
    fields: [
      { key: "title", label: "Título", type: "text" },
      { key: "body", label: "Anotação", type: "textarea", maxlength: 5000, required: false },
      { key: "category", label: "Categoria", type: "select", default: "Pessoal", options: ["Pessoal", "Trabalho", "Ideias", "Casa", "Outro"].map(value => ({ value, label: value })) }
    ]
  },
  assinaturas: {
    title: "Minhas Assinaturas", intro: "Veja as próximas cobranças e marque pagamentos sem duplicar despesas.", collection: "subscriptions",
    fields: [
      { key: "title", label: "Serviço", type: "text" },
      { key: "amount", label: "Valor por cobrança", type: "number", min: 0.01, step: "0.01" },
      { key: "billingDate", label: "Próxima data de cobrança", type: "date", default: localDate() },
      { key: "frequency", label: "Frequência", type: "select", default: "monthly", options: [{ value: "weekly", label: "Semanal" }, { value: "monthly", label: "Mensal" }, { value: "quarterly", label: "Trimestral" }, { value: "annual", label: "Anual" }] },
      { key: "paymentMethod", label: "Forma de pagamento", type: "select", default: "Cartão", options: paymentMethods.map(value => ({ value, label: value })) },
      { key: "status", label: "Status", type: "select", default: "active", options: [{ value: "active", label: "Ativa" }, { value: "cancelled", label: "Cancelada" }] }
    ]
  }
};

function isOverdue(date, done = false) {
  return Boolean(date && date < localDate() && !done);
}

function recordSummary(collection, item) {
  if (collection === "transactions") {
    return `<span class="record-amount ${item.type}">${item.type === "income" ? "+" : "−"} ${escapeHtml(money(item.amount))}</span><small>${escapeHtml(item.category)} · ${escapeHtml(formatDate(item.date))}${item.paymentMethod ? ` · ${escapeHtml(item.paymentMethod)}` : ""}</small>`;
  }
  if (collection === "commitments") {
    return `<small>${escapeHtml(dateTime(item.date, item.time))}${item.location ? ` · ${escapeHtml(item.location)}` : ""}</small>${item.done ? '<span class="status-pill success">Concluído</span>' : ""}`;
  }
  if (collection === "tasks") {
    return `<small>${escapeHtml(item.category)} · ${escapeHtml(item.priority === "high" ? "Prioridade alta" : item.priority === "low" ? "Prioridade baixa" : "Prioridade média")}${item.dueDate ? ` · ${escapeHtml(formatDate(item.dueDate))}` : ""}</small>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}${item.priorityToday ? '<span class="status-pill today-priority">Prioridade de hoje</span>' : ""}`;
  }
  if (collection === "goals") {
    const progress = item.target ? Math.min(100, Math.round(item.current / item.target * 100)) : 0;
    return `<small>${escapeHtml(money(item.current))} de ${escapeHtml(money(item.target))}${item.deadline ? ` · até ${escapeHtml(formatDate(item.deadline))}` : ""}</small><div class="goal-track"><div class="goal-fill" style="width:${progress}%"></div></div><small>${progress}% concluído</small>`;
  }
  if (collection === "payables" || collection === "receivables") {
    const settled = collection === "payables" ? item.paid : item.received;
    const overdue = isOverdue(item.dueDate, settled);
    return `<small>${escapeHtml(item.category)} · ${escapeHtml(formatDate(item.dueDate))}</small><span class="record-amount ${overdue ? "overdue" : ""}">${escapeHtml(money(item.amount))}</span><span class="status-pill ${settled ? "success" : overdue ? "warning" : ""}">${settled ? collection === "payables" ? "Paga" : "Recebida" : overdue ? "Vencida" : "Pendente"}</span>`;
  }
  if (collection === "shopping") {
    const total = item.price * item.quantity;
    return `<small>${item.quantity} un. · ${escapeHtml(item.category)} · ${escapeHtml(money(total))}</small>`;
  }
  if (collection === "notes") return `<small>${escapeHtml(item.category)} · Atualizada ${escapeHtml(formatDate(item.updatedAt))}</small>${item.body ? `<p class="record-body">${escapeHtml(item.body)}</p>` : ""}`;
  if (collection === "subscriptions") {
    const next = nextSubscriptionCharge(item);
    const frequency = { weekly: "semanal", monthly: "mensal", quarterly: "trimestral", annual: "anual" }[item.frequency];
    const payments = [...item.payments].sort().slice(-3).reverse();
    return `<small>${escapeHtml(frequency)} · próxima cobrança: ${escapeHtml(formatDate(next))} · ${escapeHtml(item.paymentMethod)}</small><span class="record-amount expense">${escapeHtml(money(item.amount))}</span><span class="status-pill ${item.status === "active" ? "success" : ""}">${item.status === "active" ? "Ativa" : "Cancelada"}</span><small>${escapeHtml(money(monthlySubscriptionAmount(item)))} / mês estimado</small><small>${payments.length ? `Pagamentos registrados: ${payments.map(date => escapeHtml(formatDate(date))).join(", ")}` : "Nenhum pagamento registrado"}</small>`;
  }
  return "";
}

function recordActions(collection, item) {
  let action = "";
  if (collection === "tasks") {
    action += `<label class="inline-check"><input type="checkbox" data-toggle-record="${collection}|${escapeHtml(item.id)}|done" ${item.done ? "checked" : ""} aria-label="Concluir ${escapeHtml(item.title)}"><span>${item.done ? "Concluída" : "Pendente"}</span></label>`;
  } else if (collection === "commitments") {
    action += `<label class="inline-check"><input type="checkbox" data-toggle-record="${collection}|${escapeHtml(item.id)}|done" ${item.done ? "checked" : ""} aria-label="Marcar ${escapeHtml(item.title)} como concluído"><span>Concluído</span></label>`;
  } else if (collection === "shopping") {
    action += `<label class="inline-check"><input type="checkbox" data-toggle-record="${collection}|${escapeHtml(item.id)}|bought" ${item.bought ? "checked" : ""} aria-label="Marcar ${escapeHtml(item.title)} como comprado"><span>Comprado</span></label>`;
  } else if (collection === "payables" && !item.paid) {
    action += `<button class="small-action" type="button" data-action="settle-payable" data-id="${escapeHtml(item.id)}">Marcar paga</button>`;
  } else if (collection === "receivables" && !item.received) {
    action += `<button class="small-action" type="button" data-action="settle-receivable" data-id="${escapeHtml(item.id)}">Marcar recebida</button>`;
  } else if (collection === "subscriptions" && item.status === "active") {
    action += `<button class="small-action" type="button" data-action="pay-subscription" data-id="${escapeHtml(item.id)}" data-charge-date="${escapeHtml(nextSubscriptionCharge(item))}">Registrar cobrança</button>`;
  }
  action += `<button class="icon-action" type="button" data-action="edit-record" data-collection="${collection}" data-id="${escapeHtml(item.id)}" aria-label="Editar ${escapeHtml(item.title)}">✎</button>`;
  action += `<button class="icon-action danger-action" type="button" data-action="delete-record" data-collection="${collection}" data-id="${escapeHtml(item.id)}" aria-label="Excluir ${escapeHtml(item.title)}">×</button>`;
  return action;
}

function renderRecordCard(collection, item) {
  const completed = (collection === "tasks" && item.done) || (collection === "shopping" && item.bought);
  const overdue = (collection === "payables" && isOverdue(item.dueDate, item.paid)) || (collection === "receivables" && isOverdue(item.dueDate, item.received));
  return `<article class="record-card ${completed ? "record-completed" : ""} ${overdue ? "record-overdue" : ""}">
    <div class="record-main"><strong>${escapeHtml(item.title)}</strong>${recordSummary(collection, item)}</div>
    <div class="record-actions">${recordActions(collection, item)}</div>
  </article>`;
}

function defaultForCollection(collection) {
  if (collection === "tasks") return { done: false, priorityToday: false };
  if (collection === "commitments") return { done: false };
  if (collection === "payables") return { paid: false, transactionId: "" };
  if (collection === "receivables") return { received: false, transactionId: "" };
  if (collection === "shopping") return { bought: false };
  if (collection === "subscriptions") return { status: "active", payments: [] };
  if (collection === "notes") return { updatedAt: new Date().toISOString() };
  if (collection === "piggyBanks") return { current: 0, history: [] };
  if (collection === "goals") return { current: 0, linkedPiggyId: "" };
  if (collection === "habits") return { history: [] };
  if (collection === "transactions") return { sourceKey: "" };
  return {};
}

function filteredFinanceRecords(records) {
  const target = financeDate || localDate();
  return records.filter(item => {
    const date = item.date.slice(0, 10);
    if (financePeriod === "day") return date === target;
    if (financePeriod === "year") return date.slice(0, 4) === target.slice(0, 4);
    if (financePeriod === "week") {
      const start = new Date(`${target}T12:00:00`);
      const weekday = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - weekday);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const candidate = new Date(`${date}T12:00:00`);
      return candidate >= start && candidate < end;
    }
    return date.slice(0, 7) === target.slice(0, 7);
  });
}

function renderCollectionPage(page) {
  const config = moduleConfigs[page];
  const collection = config.collection;
  const records = state[collection];
  const editing = editingId ? records.find(item => item.id === editingId) : null;
  let visible = [...records];
  let filterTools = "";
  if (collection === "transactions") {
    visible = filteredFinanceRecords(visible);
    filterTools = `<div class="filter-row">
      <label>Período<select class="text-input" id="finance-period"><option value="day" ${financePeriod === "day" ? "selected" : ""}>Dia</option><option value="week" ${financePeriod === "week" ? "selected" : ""}>Semana</option><option value="month" ${financePeriod === "month" ? "selected" : ""}>Mês</option><option value="year" ${financePeriod === "year" ? "selected" : ""}>Ano</option></select></label>
      <label>Data de referência<input class="text-input" id="finance-date" type="date" value="${escapeHtml(financeDate)}"></label>
    </div>`;
  } else if (collection === "tasks") {
    filterTools = `<label class="filter-label">Mostrar<select class="text-input" id="task-filter"><option value="all">Todas</option><option value="pending">Pendentes</option><option value="done">Concluídas</option><option value="overdue">Atrasadas</option></select></label>`;
    const filter = document.querySelector("#task-filter") ? document.querySelector("#task-filter").value : "all";
    if (filter === "pending") visible = visible.filter(item => !item.done);
    else if (filter === "done") visible = visible.filter(item => item.done);
    else if (filter === "overdue") visible = visible.filter(item => isOverdue(item.dueDate, item.done));
  } else if (collection === "notes") {
    const search = document.querySelector("#note-search");
    const query = search ? search.value.trim().toLocaleLowerCase() : "";
    visible = visible.filter(item => !query || `${item.title} ${item.body} ${item.category}`.toLocaleLowerCase().includes(query));
    filterTools = `<label class="filter-label">Pesquisar<input class="text-input" id="note-search" type="search" value="${escapeHtml(query)}" placeholder="Buscar notas…"></label>`;
  }
  if (collection === "transactions") visible.sort((a, b) => new Date(b.date) - new Date(a.date));
  else if (collection === "commitments") visible.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  else if (collection === "payables" || collection === "receivables") visible.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  else if (collection === "notes") visible.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const items = visible.length ? visible.map(item => renderRecordCard(collection, item)).join("") : `<div class="empty-state">${collection === "transactions" ? "Não há movimentações neste período." : collection === "notes" ? "Nenhuma anotação encontrada." : "Ainda não há itens. Adicione o primeiro usando o formulário."}</div>`;
  const transactionTotals = collection === "transactions" ? `<div class="summary-strip"><span>Saldo atual <strong>${escapeHtml(money(currentBalance()))}</strong></span><span>Entradas no período <strong class="income-text">${escapeHtml(money(totalTransactions(visible, "income")))}</strong></span><span>Saídas no período <strong>${escapeHtml(money(totalTransactions(visible, "expense")))}</strong></span></div>` : "";
  const shoppingTotal = collection === "shopping" ? `<div class="summary-strip"><span>Total estimado <strong>${escapeHtml(money(records.filter(item => !item.bought).reduce((sum, item) => sum + item.quantity * item.price, 0)))}</strong></span></div>` : "";
  const billsSummary = collection === "payables" ? `<div class="summary-strip"><span>Em aberto <strong>${escapeHtml(money(records.filter(item => !item.paid).reduce((sum, item) => sum + item.amount, 0)))}</strong></span></div>` : "";
  const subscriptionsSummary = collection === "subscriptions" ? `<div class="summary-strip"><span>Gasto mensal estimado <strong>${escapeHtml(money(records.filter(item => item.status === "active").reduce((sum, item) => sum + monthlySubscriptionAmount(item), 0)))}</strong></span></div>` : "";
  const naturalInput = collection === "transactions" ? `<form class="natural-entry-form" id="natural-entry-form"><label>Registro rápido<input class="text-input" name="sentence" placeholder="Ex.: Gastei 35 euros no supermercado" required></label><button class="secondary-button" type="submit">Interpretar</button></form>` : "";
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">MyLife</p><h1>${escapeHtml(config.title)}</h1><p>${escapeHtml(config.intro)}</p></div>
      ${transactionTotals}${shoppingTotal}${billsSummary}${subscriptionsSummary}
      ${naturalInput}
      <form class="entry-form record-form" id="record-form" data-collection="${collection}">
        <h2>${editing ? "Editar" : "Adicionar"} ${escapeHtml(config.title.toLocaleLowerCase())}</h2>
        <div class="form-grid">${config.fields.map(field => renderField(field, editing ? editing[field.key] : undefined)).join("")}</div>
        <div class="form-actions"><button class="primary-button" type="submit">${editing ? "Salvar alterações" : "Adicionar"}</button>${editing ? '<button class="secondary-button" type="button" data-action="cancel-edit">Cancelar</button>' : ""}</div>
      </form>
      ${filterTools}
      <div class="record-list">${items}</div>
    </section>`;
}

function parseAmountToken(value) {
  let text = value.replace(/\s/g, "");
  if (text.includes(",") && text.includes(".")) text = text.replace(/\./g, "").replace(",", ".");
  else if (text.includes(",")) text = text.replace(",", ".");
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  return Number(text);
}

function parseNaturalTransaction(sentence) {
  const amountMatch = sentence.match(/\d[\d.,]*(?:\s*(?:€|euros?|eur))?/i);
  if (!amountMatch) return null;
  const amount = parseAmountToken(amountMatch[0].replace(/\s*(?:€|euros?|eur)$/i, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const isIncome = /\b(recebi|recebido|ganhei|entrada|sal[aá]rio|reembolso)\b/i.test(sentence);
  let title = sentence.replace(amountMatch[0], "").replace(/\b(recebi|recebido|ganhei|gastei|paguei|comprei|euros?|eur)\b/gi, "").replace(/[€]/g, "").trim();
  title = title.replace(/^(de|do|da|no|na|em|um|uma)\s+/i, "").replace(/\s+/g, " ") || "Lançamento";
  const category = categories.find(item => sentence.toLocaleLowerCase().includes(item.toLocaleLowerCase())) || "Outros";
  return { title: title.charAt(0).toLocaleUpperCase() + title.slice(1), amount, type: isIncome ? "income" : "expense", category };
}

function nextSubscriptionCharge(subscription) {
  let date = new Date(`${subscription.billingDate}T12:00:00`);
  if (!Number.isFinite(date.getTime())) date = new Date();
  const anchorDay = date.getDate();
  const today = localDate();
  const payments = new Set(subscription.payments || []);
  for (let count = 0; count < 500; count += 1) {
    const key = localDate(date);
    if (!payments.has(key)) return key;
    date = advanceDate(date, subscription.frequency, anchorDay);
    if (key >= today) continue;
  }
  return localDate(date);
}

function advanceDate(date, frequency, anchorDay = date.getDate()) {
  const next = new Date(date);
  if (frequency === "weekly") next.setDate(next.getDate() + 7);
  else {
    next.setDate(1);
    if (frequency === "quarterly") next.setMonth(next.getMonth() + 3);
    else if (frequency === "annual") next.setFullYear(next.getFullYear() + 1);
    else next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(anchorDay, lastDay));
  }
  return next;
}

function monthlySubscriptionAmount(item) {
  const multiplier = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, annual: 1 / 12 }[item.frequency] || 0;
  return item.amount * multiplier;
}

function sumMoney(items, getValue) {
  return items.reduce((total, item) => total + Math.round((getValue ? getValue(item) : item.amount) * 100), 0) / 100;
}

function createTransaction(data) {
  const previousCategorySpend = {};
  const transactionDay = (data.date || new Date().toISOString()).slice(0, 10);
  const transactionMonth = transactionDay.slice(0, 7);
  const previousMonthSpend = sumMoney(state.transactions.filter(item => item.type === "expense" && item.date.slice(0, 7) === transactionMonth));
  for (const category of Object.keys(state.budgets.categoryLimits)) {
    previousCategorySpend[category] = sumMoney(state.transactions.filter(item => item.type === "expense" && item.category === category && item.date.slice(0, 7) === transactionMonth));
  }
  const weekStart = new Date(`${transactionDay}T12:00:00`);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const weekStartKey = localDate(weekStart);
  const previousWeekSpend = sumMoney(state.transactions.filter(item => item.type === "expense" && item.date.slice(0, 10) >= weekStartKey && item.date.slice(0, 10) <= transactionDay));
  state.transactions.unshift({
    id: makeId(),
    title: cleanText(data.title, 140),
    amount: Math.round(Number(data.amount) * 100) / 100,
    type: data.type,
    category: cleanText(data.category, 60) || "Outros",
    date: data.date || localDate(),
    paymentMethod: cleanText(data.paymentMethod, 50) || "Outro",
    account: cleanText(data.account, 80),
    sourceKey: data.sourceKey || ""
  });
  return data.type === "expense"
    ? notifyBudget(previousMonthSpend, previousCategorySpend, previousWeekSpend, transactionDay)
    : false;
}

function notifyBudget(previousMonthExpenses, previousCategoryExpenses, previousWeekExpenses, transactionDay) {
  const monthKey = transactionDay.slice(0, 7);
  const monthSpent = sumMoney(state.transactions.filter(item => item.type === "expense" && item.date.slice(0, 7) === monthKey));
  const limit = state.budgets.monthlyLimit;
  if (limit) {
    for (const threshold of [1, 0.8, 0.5]) {
      if (previousMonthExpenses < limit * threshold && monthSpent >= limit * threshold) {
        showToast(threshold === 1 ? "Você atingiu o limite mensal de gastos." : `Você usou ${threshold * 100}% do orçamento mensal.`, threshold === 1);
        return true;
      }
    }
  }
  for (const [category, categoryLimit] of Object.entries(state.budgets.categoryLimits)) {
    if (!categoryLimit) continue;
    const categorySpent = sumMoney(state.transactions.filter(item => item.type === "expense" && item.category === category && item.date.slice(0, 7) === monthKey));
    for (const threshold of [1, 0.8, 0.5]) {
      if ((previousCategoryExpenses[category] || 0) < categoryLimit * threshold && categorySpent >= categoryLimit * threshold) {
        showToast(`${category}: você usou ${threshold * 100}% do limite mensal.`, threshold === 1);
        return true;
      }
    }
  }
  const weekLimit = state.budgets.weeklyLimit;
  if (!weekLimit) return;
  const date = new Date(`${transactionDay}T12:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const start = localDate(date);
  const weekSpent = sumMoney(state.transactions.filter(item => item.type === "expense" && item.date.slice(0, 10) >= start && item.date.slice(0, 10) <= transactionDay));
  for (const threshold of [1, 0.8, 0.5]) {
    if (previousWeekExpenses < weekLimit * threshold && weekSpent >= weekLimit * threshold) {
      showToast(threshold === 1 ? "Você atingiu o limite semanal de gastos." : `Você usou ${threshold * 100}% do orçamento semanal.`, threshold === 1);
      return true;
    }
  }
}

function settleBill(item, kind) {
  const isPayable = kind === "payables";
  const statusKey = isPayable ? "paid" : "received";
  if (item[statusKey]) return;
  const type = isPayable ? "expense" : "income";
  const sourceKey = `${kind}:${item.id}`;
  let budgetAlert = false;
  if (!state.transactions.some(transaction => transaction.sourceKey === sourceKey)) {
    budgetAlert = createTransaction({
      title: item.title,
      amount: item.amount,
      type,
      category: item.category || "Contas",
      date: localDate(),
      paymentMethod: "Outro",
      sourceKey
    });
  }
  item[statusKey] = true;
  item.transactionId = state.transactions.find(transaction => transaction.sourceKey === sourceKey).id;
  persist();
  render();
  if (!budgetAlert) showToast(isPayable ? "Conta paga e despesa registrada." : "Recebimento confirmado e registrado.");
}

function recordSubscriptionPayment(item, expectedChargeDate) {
  if (item.status !== "active") return;
  const chargeDate = nextSubscriptionCharge(item);
  if (expectedChargeDate && expectedChargeDate !== chargeDate) {
    showToast(`Esta cobrança já foi registrada. A próxima está prevista para ${formatDate(chargeDate)}.`, true);
    return;
  }
  const sourceKey = `subscription:${item.id}:${chargeDate}`;
  let budgetAlert = false;
  if (!state.transactions.some(transaction => transaction.sourceKey === sourceKey)) {
    budgetAlert = createTransaction({
      title: item.title,
      amount: item.amount,
      type: "expense",
      category: "Assinaturas",
      date: localDate(),
      paymentMethod: item.paymentMethod,
      sourceKey
    });
  }
  item.payments = [...new Set([...(item.payments || []), chargeDate])];
  persist();
  render();
  if (!budgetAlert) showToast("Cobrança registrada uma única vez nas despesas.");
}

function refreshLinkedGoals() {
  for (const goal of state.goals) {
    const piggy = state.piggyBanks.find(item => item.id === goal.linkedPiggyId);
    if (piggy) goal.current = piggy.current;
  }
}

function dateEvents(dateKey) {
  const events = [];
  for (const item of state.commitments) {
    if (item.date === dateKey) events.push({ time: item.time || "23:59", title: item.title, type: "Compromisso", page: "compromissos", done: item.done });
  }
  for (const item of state.tasks) {
    if (item.dueDate === dateKey) events.push({ time: item.dueTime || "23:59", title: item.title, type: "Tarefa", page: "tarefas", done: item.done });
  }
  for (const item of state.payables) {
    if (item.dueDate === dateKey) events.push({ time: "12:00", title: item.title, type: "Conta a pagar", page: "contas-pagar", done: item.paid });
  }
  for (const item of state.receivables) {
    if (item.dueDate === dateKey) events.push({ time: "12:00", title: item.title, type: "Conta a receber", page: "contas-receber", done: item.received });
  }
  for (const item of state.subscriptions) {
    if (item.status === "active" && nextSubscriptionCharge(item) === dateKey) events.push({ time: "09:00", title: item.title, type: "Assinatura", page: "assinaturas", done: false });
  }
  for (const item of state.habits) {
    if (item.history.includes(dateKey)) events.push({ time: item.time || "23:59", title: item.title, type: "Hábito concluído", page: "habitos", done: true });
  }
  return events.sort((a, b) => a.time.localeCompare(b.time));
}

function renderDashboard() {
  const monthItems = monthTransactions();
  const income = totalTransactions(monthItems, "income");
  const expenses = totalTransactions(monthItems, "expense");
  const futureCommitments = state.commitments
    .filter(item => item.date >= localDate() && !item.done)
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .slice(0, 3);
  const pendingTasks = state.tasks.filter(item => !item.done).slice(0, 3);
  const dueBills = [...state.payables.filter(item => !item.paid), ...state.receivables.filter(item => !item.received)]
    .filter(item => !item.dueDate || item.dueDate >= localDate())
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
    .slice(0, 3);
  const goals = state.goals.filter(item => item.target > item.current).slice(0, 3);
  const subscriptionCost = state.subscriptions.filter(item => item.status === "active").reduce((sum, item) => sum + monthlySubscriptionAmount(item), 0);
  const cards = [
    ["financas", "↗", "Controle financeiro", "Entradas e saídas"],
    ["compromissos", "▣", "Compromissos", `${futureCommitments.length} próximos`],
    ["tarefas", "☑", "Tarefas", `${state.tasks.filter(item => !item.done).length} pendentes`],
    ["metas", "◎", "Metas pessoais", `${state.goals.length} em andamento`],
    ["contas-pagar", "↓", "Contas a pagar", `${state.payables.filter(item => !item.paid).length} pendentes`],
    ["compras", "□", "Lista de compras", `${state.shopping.filter(item => !item.bought).length} produtos`]
  ];
  const rows = (items, empty, renderItem) => items.length ? items.map(renderItem).join("") : `<p class="muted-copy">${empty}</p>`;
  app.innerHTML = `
    <section class="view dashboard-view">
      <header class="dashboard-heading">
        <p class="eyebrow">${escapeHtml(todayTitle())}</p>
        <h1>Olá! <span aria-hidden="true">👋</span></h1>
      </header>
      <div class="summary-grid">
        <button class="balance-card" type="button" data-page="financas"><span>Saldo disponível</span><strong>${escapeHtml(money(currentBalance()))}</strong><small>Saldo inicial + entradas − saídas − reservas</small></button>
        <div class="summary-card"><span>Recebido este mês</span><strong class="income-text">${escapeHtml(money(income))}</strong></div>
        <div class="summary-card"><span>Gasto este mês</span><strong>${escapeHtml(money(expenses))}</strong></div>
        <div class="summary-card"><span>Assinaturas / mês</span><strong>${escapeHtml(money(subscriptionCost))}</strong></div>
      </div>
      <div class="dashboard-grid">
        ${cards.map(([page, icon, title, caption]) => `<button class="dashboard-card" type="button" data-page="${page}"><span class="dashboard-card-icon">${icon}</span><span class="dashboard-card-title">${title}</span><span class="dashboard-card-subtitle">${caption}</span></button>`).join("")}
      </div>
      <form class="quick-transaction-form" id="quick-transaction-form">
        <div><strong>Ação rápida</strong><small>Registrar uma entrada ou saída</small></div>
        <select class="text-input" name="type" aria-label="Tipo de movimentação"><option value="expense">Saída</option><option value="income">Entrada</option></select>
        <input class="text-input" name="title" maxlength="140" placeholder="Descrição" aria-label="Descrição" required>
        <input class="text-input" name="amount" type="number" min="0.01" step="0.01" placeholder="Valor" aria-label="Valor" required>
        <button class="primary-button" type="submit">Adicionar</button>
      </form>
      <div class="dashboard-sections">
        <section class="dashboard-section"><div class="section-heading"><h2>Próximos compromissos</h2><button class="text-action" type="button" data-page="compromissos">Ver todos</button></div>
          ${rows(futureCommitments, "Nenhum compromisso próximo.", item => `<button class="mini-row" type="button" data-page="compromissos"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(dateTime(item.date, item.time))}</small></button>`)}
        </section>
        <section class="dashboard-section"><div class="section-heading"><h2>Tarefas pendentes</h2><button class="text-action" type="button" data-page="tarefas">Ver todas</button></div>
          ${rows(pendingTasks, "Nenhuma tarefa pendente.", item => `<button class="mini-row" type="button" data-page="tarefas"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.dueDate ? formatDate(item.dueDate) : "Sem prazo")}</small></button>`)}
        </section>
        <section class="dashboard-section"><div class="section-heading"><h2>Contas próximas</h2><button class="text-action" type="button" data-page="contas-pagar">Ver contas</button></div>
          ${rows(dueBills, "Nenhuma conta pendente.", item => `<div class="mini-row"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(formatDate(item.dueDate))} · ${escapeHtml(money(item.amount))}</small></div>`)}
        </section>
        <section class="dashboard-section"><div class="section-heading"><h2>Metas em andamento</h2><button class="text-action" type="button" data-page="metas">Ver metas</button></div>
          ${rows(goals, "Adicione uma meta para começar.", item => `<div class="mini-row"><span>${escapeHtml(item.title)}</span><small>${Math.min(100, Math.round(item.current / Math.max(1, item.target) * 100))}% · ${escapeHtml(money(item.current))}</small></div>`)}
        </section>
      </div>
      <div class="dashboard-chart-card"><div class="section-heading"><h2>Este mês</h2><button class="text-action" type="button" data-page="relatorios">Relatórios</button></div>${renderMonthlyBars()}</div>
    </section>`;
}

function renderMonthlyBars() {
  const values = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const transactions = state.transactions.filter(item => item.date.slice(0, 7) === key);
    values.push({
      label: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(date).replace(".", ""),
      income: totalTransactions(transactions, "income"),
      expense: totalTransactions(transactions, "expense")
    });
  }
  if (state.settings.chartType === "donut") {
    const palette = ["--chart-income", "--chart-expense"];
    return `<div class="monthly-donuts">${values.map(item => {
      const total = item.income + item.expense;
      const incomeShare = total ? Math.round(item.income / total * 100) : 0;
      const background = total
        ? `conic-gradient(var(${palette[0]}) 0% ${incomeShare}%, var(${palette[1]}) ${incomeShare}% 100%)`
        : "conic-gradient(var(--panel-soft) 0% 100%)";
      return `<div class="donut-month" aria-label="${escapeHtml(item.label)}: ${escapeHtml(money(item.income))} recebidos e ${escapeHtml(money(item.expense))} gastos"><div class="donut-chart small-donut" style="background:${background}"><span>${incomeShare}%</span></div><small>${escapeHtml(item.label)}</small></div>`;
    }).join("")}</div><div class="chart-legend"><span class="income-key">Receitas</span><span class="expense-key">Despesas</span></div>`;
  }
  const maximum = Math.max(1, ...values.flatMap(item => [item.income, item.expense]));
  return `<div class="chart-bars">${values.map(item => `<div class="chart-column" aria-label="${escapeHtml(item.label)}: ${escapeHtml(money(item.income))} recebidos e ${escapeHtml(money(item.expense))} gastos"><div class="bar-pair"><span class="bar income-bar" style="height:${Math.max(3, item.income / maximum * 100)}%"></span><span class="bar expense-bar" style="height:${Math.max(3, item.expense / maximum * 100)}%"></span></div><small>${escapeHtml(item.label)}</small></div>`).join("")}</div><div class="chart-legend"><span class="income-key">Receitas</span><span class="expense-key">Despesas</span></div>`;
}

function renderCategoryExpenses(byCategory) {
  if (!byCategory.length) return '<p class="muted-copy">Sem despesas registradas neste mês.</p>';
  if (state.settings.chartType !== "donut") {
    const maximum = Math.max(1, ...byCategory.map(item => item.total));
    return byCategory.map(item => `<div class="category-bar"><div><span>${escapeHtml(item.category)}</span><strong>${escapeHtml(money(item.total))}</strong></div><div class="goal-track"><div class="goal-fill" style="width:${Math.round(item.total / maximum * 100)}%"></div></div></div>`).join("");
  }
  const colors = ["#5fe0a2", "#58a6ff", "#b58cff", "#ffab70", "#ff7297", "#f4d35e", "#6ed6cf", "#a4c95d", "#e987c6", "#7895ff", "#ef8354", "#91c7b1", "#d0a6ff"];
  const total = byCategory.reduce((sum, item) => sum + item.total, 0);
  let cursor = 0;
  const segments = byCategory.map((item, index) => {
    const start = cursor;
    cursor += item.total / total * 100;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  });
  return `<div class="category-donut-layout"><div class="donut-chart category-donut" style="background:conic-gradient(${segments.join(",")})" role="img" aria-label="Distribuição de despesas por categoria"><span>${escapeHtml(money(total))}</span></div><div class="donut-legend">${byCategory.map((item, index) => `<div><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(item.category)}</span><strong>${escapeHtml(money(item.total))} · ${Math.round(item.total / total * 100)}%</strong></div>`).join("")}</div></div>`;
}

function balanceAtDate(dateKey) {
  const transactions = state.transactions.filter(item => item.date.slice(0, 10) <= dateKey);
  const income = totalTransactions(transactions, "income");
  const expenses = totalTransactions(transactions, "expense");
  const reserved = sumMoney(state.piggyBanks.flatMap(item => item.history.filter(entry => entry.date.slice(0, 10) <= dateKey)), entry => entry.type === "deposit" ? entry.amount : -entry.amount);
  return state.settings.initialBalance + income - expenses - reserved;
}

function renderBalanceTrend() {
  const values = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - offset);
    const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    values.push({
      label: new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(date).replace(".", ""),
      balance: balanceAtDate(localDate(endOfMonth))
    });
  }
  const maxBalance = Math.max(1, ...values.map(item => Math.abs(item.balance)));
  return values.map(item => `<div class="balance-trend-row"><span>${escapeHtml(item.label)}</span><div class="goal-track"><div class="goal-fill ${item.balance < 0 ? "negative-balance" : ""}" style="width:${Math.min(100, Math.abs(item.balance) / maxBalance * 100)}%"></div></div><strong>${escapeHtml(money(item.balance))}</strong></div>`).join("");
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const offset = firstDay.getDay();
  const days = [];
  for (let index = 0; index < offset; index += 1) days.push("");
  for (let day = 1; day <= daysInMonth; day += 1) days.push(String(day).padStart(2, "0"));
  const monthTitle = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(firstDay);
  const grid = days.map(day => {
    if (!day) return '<span class="calendar-blank"></span>';
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${day}`;
    const count = dateEvents(key).length;
    return `<button type="button" class="calendar-day ${key === selectedCalendarDate ? "selected" : ""} ${key === localDate() ? "today" : ""}" data-calendar-date="${key}" aria-label="${escapeHtml(formatDate(key, { day: "numeric", month: "long" }))}${count ? `, ${count} eventos` : ""}"><span>${Number(day)}</span>${count ? '<i></i>' : ""}</button>`;
  }).join("");
  const events = dateEvents(selectedCalendarDate);
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Agenda integrada</p><h1>Calendário</h1><p>Compromissos, tarefas e vencimentos em um só lugar.</p></div>
      <div class="calendar-card">
        <div class="calendar-toolbar"><button class="icon-action" type="button" data-action="calendar-prev" aria-label="Mês anterior">‹</button><strong>${escapeHtml(monthTitle)}</strong><button class="icon-action" type="button" data-action="calendar-next" aria-label="Próximo mês">›</button><button class="text-action" type="button" data-action="calendar-today">Hoje</button></div>
        <div class="calendar-grid calendar-weekdays">${["D", "S", "T", "Q", "Q", "S", "S"].map((day, index) => `<span aria-label="${["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"][index]}">${day}</span>`).join("")}</div>
        <div class="calendar-grid">${grid}</div>
      </div>
      <div class="section-heading"><h2>${escapeHtml(formatDate(selectedCalendarDate, { weekday: "long", day: "numeric", month: "long" }))}</h2><span class="section-note">${events.length} eventos</span></div>
      <div class="record-list">${events.length ? events.map(item => `<button class="calendar-event" type="button" data-page="${item.page}"><span class="event-time">${escapeHtml(item.time)}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.type)}${item.done ? " · concluído" : ""}</small></span></button>`).join("") : '<div class="empty-state">Nenhum evento para este dia. Use Compromissos ou Tarefas para adicionar.</div>'}</div>
      <form class="entry-form" id="calendar-event-form">
        <h2>Adicionar compromisso neste dia</h2>
        <label>Nome ou descrição<input class="text-input" name="title" maxlength="140" required></label>
        <div class="form-pair"><label>Data<input class="text-input" type="date" name="date" value="${escapeHtml(selectedCalendarDate)}" required></label><label>Horário<input class="text-input" type="time" name="time"></label></div>
        <div class="form-pair"><label>Local<input class="text-input" name="location" maxlength="160"></label><label>Lembrete (minutos antes)<input class="text-input" type="number" name="reminder" min="0" max="10080" step="1" value="30"></label></div>
        <button class="primary-button" type="submit">Adicionar ao calendário</button>
      </form>
    </section>`;
}

function renderMyDay() {
  const today = localDate();
  const events = dateEvents(today);
  const habits = state.habits.filter(item => item.frequency === "daily" || weeklyHabitCount(item) < item.targetPerWeek);
  const priorityTasks = state.tasks.filter(item => item.priorityToday);
  const dueBills = state.payables.filter(item => !item.paid && item.dueDate === today);
  const dueSubscriptions = state.subscriptions.filter(item => item.status === "active" && nextSubscriptionCharge(item) === today);
  const upcomingSubscriptions = state.subscriptions.filter(item => item.status === "active" && nextSubscriptionCharge(item) > today)
    .map(item => ({ ...item, nextCharge: nextSubscriptionCharge(item) }))
    .sort((a, b) => a.nextCharge.localeCompare(b.nextCharge))
    .slice(0, 3);
  const goals = state.goals.filter(item => item.current < item.target);
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><p class="eyebrow">${escapeHtml(todayTitle())}</p><h1>Meu Dia</h1><p>Olá! Escolha o que merece sua atenção hoje.</p></div>
      <section class="dashboard-section"><div class="section-heading"><h2>Prioridades de Hoje</h2><span class="section-note">${priorityTasks.length}/3</span></div>
        <div class="record-list">${priorityTasks.length ? priorityTasks.map(item => `<div class="mini-row"><span>${escapeHtml(item.title)}</span><button class="icon-action danger-action" type="button" data-action="remove-priority" data-id="${escapeHtml(item.id)}" aria-label="Remover prioridade">×</button></div>`).join("") : '<p class="muted-copy">Escolha até três tarefas importantes na lista de tarefas.</p>'}
        ${state.tasks.filter(item => !item.done && !item.priorityToday).length ? `<div class="priority-picker">${state.tasks.filter(item => !item.done && !item.priorityToday).map(item => `<button class="small-action" type="button" data-action="add-priority" data-id="${escapeHtml(item.id)}">＋ ${escapeHtml(item.title)}</button>`).join("")}</div>` : ""}</div>
      </section>
      <section class="dashboard-section"><div class="section-heading"><h2>Compromissos e tarefas</h2><span class="section-note">${events.length}</span></div><div class="record-list">${events.length ? events.map(item => `<div class="mini-row ${item.done ? "is-done" : ""}"><span>${escapeHtml(item.time)} · ${escapeHtml(item.title)}</span><small>${escapeHtml(item.type)}</small></div>`).join("") : '<p class="muted-copy">Nada agendado para hoje.</p>'}</div></section>
      <section class="dashboard-section"><div class="section-heading"><h2>Hábitos de hoje</h2><button class="text-action" type="button" data-page="habitos">Gerenciar</button></div><div class="record-list">${habits.length ? habits.map(item => habitCard(item)).join("") : '<p class="muted-copy">Adicione hábitos para acompanhar sua rotina.</p>'}</div></section>
      <section class="dashboard-section"><div class="section-heading"><h2>Contas e cobranças</h2></div><div class="record-list">${[...dueBills.map(item => ({ title: item.title, amount: item.amount, type: "Conta a pagar" })), ...dueSubscriptions.map(item => ({ title: item.title, amount: item.amount, type: "Assinatura" }))].length ? [...dueBills.map(item => ({ title: item.title, amount: item.amount, type: "Conta a pagar" })), ...dueSubscriptions.map(item => ({ title: item.title, amount: item.amount, type: "Assinatura" }))].map(item => `<div class="mini-row"><span>${escapeHtml(item.title)} · ${escapeHtml(item.type)}</span><small>${escapeHtml(money(item.amount))}</small></div>`).join("") : '<p class="muted-copy">Nenhuma cobrança vence hoje.</p>'}</div></section>
      <section class="dashboard-section"><div class="section-heading"><h2>Próximas cobranças</h2><button class="text-action" type="button" data-page="assinaturas">Ver assinaturas</button></div><div class="record-list">${upcomingSubscriptions.length ? upcomingSubscriptions.map(item => `<div class="mini-row"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(formatDate(item.nextCharge))} · ${escapeHtml(money(item.amount))}</small></div>`).join("") : '<p class="muted-copy">Nenhuma cobrança futura cadastrada.</p>'}</div></section>
      <section class="dashboard-section"><div class="section-heading"><h2>Metas em andamento</h2></div><div class="record-list">${goals.length ? goals.map(item => `<div class="mini-row"><span>${escapeHtml(item.title)}</span><small>${Math.min(100, Math.round(item.current / Math.max(1, item.target) * 100))}%</small></div>`).join("") : '<p class="muted-copy">Nenhuma meta pendente.</p>'}</div></section>
    </section>`;
}

function habitDoneToday(habit) {
  return habit.history.includes(localDate());
}

function weeklyHabitCount(habit) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return habit.history.filter(date => date >= localDate(start) && date <= localDate(end)).length;
}

function habitStreak(habit) {
  const completed = new Set(habit.history);
  let date = new Date();
  if (!completed.has(localDate(date))) date.setDate(date.getDate() - 1);
  let streak = 0;
  while (completed.has(localDate(date)) && streak < 366) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

function habitCard(habit) {
  const done = habitDoneToday(habit);
  const weeklyCount = weeklyHabitCount(habit);
  return `<div class="habit-row"><div><strong>${escapeHtml(habit.title)}</strong><small>${escapeHtml(habit.category)}${habit.time ? ` · ${escapeHtml(habit.time)}` : ""} · sequência ${habitStreak(habit)} dias · semana ${weeklyCount}/${habit.targetPerWeek}</small></div><button class="small-action ${done ? "success-action" : ""}" type="button" data-action="toggle-habit" data-id="${escapeHtml(habit.id)}">${done ? "Concluído ✓" : "Marcar hoje"}</button></div>`;
}

function renderHabits() {
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Rotina e consistência</p><h1>Meus Hábitos</h1><p>Acompanhe sua sequência e sua meta semanal.</p></div>
      <form class="entry-form" id="habit-form">
        <label>Hábito<input class="text-input" name="title" maxlength="140" placeholder="Ex.: caminhar" required></label>
        <div class="form-pair"><label>Categoria<select class="text-input" name="category">${["Saúde", "Estudo", "Casa", "Bem-estar", "Outro"].map(item => `<option>${item}</option>`).join("")}</select></label><label>Frequência<select class="text-input" name="frequency"><option value="daily">Diária</option><option value="weekly">Semanal</option></select></label></div>
        <div class="form-pair"><label>Horário desejado<input class="text-input" name="time" type="time"></label><label>Meta semanal<input class="text-input" name="targetPerWeek" type="number" min="1" max="7" step="1" value="7" required></label></div>
        <button class="primary-button" type="submit">Adicionar hábito</button>
      </form>
      <div class="section-heading"><h2>Hoje</h2><span class="section-note">${state.habits.filter(habitDoneToday).length}/${state.habits.length} concluídos</span></div>
      <div class="record-list">${state.habits.length ? state.habits.map(item => `<div class="habit-manage-row">${habitCard(item)}<button class="icon-action danger-action" type="button" data-action="delete-habit" data-id="${escapeHtml(item.id)}" aria-label="Excluir hábito">×</button></div>`).join("") : '<div class="empty-state">Adicione seu primeiro hábito para começar a acompanhar sua rotina.</div>'}</div>
    </section>`;
}

function renderPiggyBanks() {
  const saved = state.piggyBanks.reduce((sum, item) => sum + item.current, 0);
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Reservas pessoais</p><h1>Meus Cofrinhos</h1><p>Reservas são transferências internas: não contam como nova receita nem como despesa.</p></div>
      <div class="summary-strip"><span>Reservado<strong>${escapeHtml(money(saved))}</strong></span><span>Disponível fora dos cofrinhos<strong>${escapeHtml(money(currentBalance()))}</strong></span></div>
      <form class="entry-form" id="piggy-form">
        <label>Nome do cofrinho<input class="text-input" name="title" maxlength="140" placeholder="Ex.: viagem" required></label>
        <div class="form-pair"><label>Valor desejado<input class="text-input" type="number" name="target" min="0.01" step="0.01" required></label><label>Data limite<input class="text-input" type="date" name="deadline"></label></div>
        <label>Descrição<input class="text-input" name="description" maxlength="300" placeholder="Opcional"></label>
        <label>Meta vinculada<select class="text-input" name="linkedGoalId"><option value="">Nenhuma</option>${state.goals.map(goal => `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</option>`).join("")}</select></label>
        <button class="primary-button" type="submit">Criar cofrinho</button>
      </form>
      <div class="record-list">${state.piggyBanks.length ? state.piggyBanks.map(item => {
        const progress = item.target ? Math.min(100, Math.round(item.current / item.target * 100)) : 0;
        const history = [...item.history].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 3);
        return `<article class="piggy-card">
          <div class="goal-heading"><strong>${escapeHtml(item.title)}</strong><span>${progress}%</span><button class="icon-action danger-action" type="button" data-action="delete-piggy" data-id="${escapeHtml(item.id)}" aria-label="Excluir cofrinho">×</button></div>
          <div class="goal-track"><div class="goal-fill" style="width:${progress}%"></div></div>
          <div class="piggy-totals"><strong>${escapeHtml(money(item.current))}</strong><span>de ${escapeHtml(money(item.target))}${item.deadline ? ` · até ${escapeHtml(formatDate(item.deadline))}` : ""}</span></div>
          ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
          <form class="piggy-transfer-form" data-id="${escapeHtml(item.id)}"><input class="text-input" type="number" name="amount" min="0.01" step="0.01" placeholder="Valor da movimentação" required><button class="small-action" type="submit" name="direction" value="deposit">Depositar</button><button class="small-action" type="submit" name="direction" value="withdrawal">Retirar</button></form>
          <details class="piggy-history"><summary>Histórico (${item.history.length})</summary>${history.length ? history.map(entry => `<small>${entry.type === "deposit" ? "Depósito" : "Retirada"} · ${escapeHtml(money(entry.amount))} · ${escapeHtml(formatDate(entry.date))}</small>`).join("") : "<small>Ainda sem movimentações.</small>"}</details>
        </article>`;
      }).join("") : '<div class="empty-state">Crie um cofrinho para separar dinheiro para um objetivo.</div>'}</div>
    </section>`;
}

function renderBudget() {
  const monthExpenses = totalTransactions(monthTransactions(), "expense");
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStartKey = localDate(weekStart);
  const weekExpenses = sumMoney(state.transactions.filter(item => item.type === "expense" && item.date.slice(0, 10) >= weekStartKey && item.date.slice(0, 10) <= localDate()));
  const monthlyProgress = state.budgets.monthlyLimit ? Math.min(100, Math.round(monthExpenses / state.budgets.monthlyLimit * 100)) : 0;
  const weeklyProgress = state.budgets.weeklyLimit ? Math.min(100, Math.round(weekExpenses / state.budgets.weeklyLimit * 100)) : 0;
  const monthlyThreshold = monthlyProgress >= 100 ? "Limite mensal atingido" : monthlyProgress >= 80 ? "Atenção: você já usou 80% do limite mensal" : monthlyProgress >= 50 ? "Você já usou 50% do limite mensal" : "";
  const expenseCategories = categories.filter(item => !["Salário", "Trabalho extra", "Investimentos"].includes(item));
  const categoryRows = expenseCategories.map(category => {
    const spent = sumMoney(monthTransactions().filter(item => item.type === "expense" && item.category === category));
    const limit = state.budgets.categoryLimits[category] || 0;
    const percent = limit ? Math.min(100, Math.round(spent / limit * 100)) : 0;
    return `<div class="budget-row"><div><strong>${escapeHtml(category)}</strong><small>${escapeHtml(money(spent))} / ${escapeHtml(limit ? money(limit) : "sem limite")}</small></div>${limit ? `<div class="goal-track"><div class="goal-fill ${percent >= 100 ? "over-budget" : ""}" style="width:${percent}%"></div></div>` : ""}</div>`;
  }).join("");
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Planejamento financeiro</p><h1>Orçamento Mensal</h1><p>Defina seus limites e acompanhe os gastos registrados.</p></div>
      <div class="summary-grid"><div class="summary-card"><span>Gasto este mês</span><strong>${escapeHtml(money(monthExpenses))}</strong></div><div class="summary-card"><span>Restante no mês</span><strong>${escapeHtml(state.budgets.monthlyLimit ? money(Math.max(0, state.budgets.monthlyLimit - monthExpenses)) : "Sem limite")}</strong></div><div class="summary-card"><span>Gasto esta semana</span><strong>${escapeHtml(money(weekExpenses))}</strong></div><div class="summary-card"><span>Limite semanal</span><strong>${escapeHtml(state.budgets.weeklyLimit ? money(Math.max(0, state.budgets.weeklyLimit - weekExpenses)) : "Sem limite")}</strong></div></div>
      ${state.budgets.monthlyLimit ? `<div class="budget-row"><div><strong>Limite total do mês</strong><small>${escapeHtml(money(monthExpenses))} / ${escapeHtml(money(state.budgets.monthlyLimit))} · ${monthlyProgress}%</small></div><div class="goal-track"><div class="goal-fill ${monthlyProgress >= 100 ? "over-budget" : ""}" style="width:${monthlyProgress}%"></div></div></div>` : ""}
      ${state.budgets.weeklyLimit ? `<div class="budget-row"><div><strong>Limite desta semana</strong><small>${escapeHtml(money(weekExpenses))} / ${escapeHtml(money(state.budgets.weeklyLimit))} · ${weeklyProgress}%</small></div><div class="goal-track"><div class="goal-fill ${weeklyProgress >= 100 ? "over-budget" : ""}" style="width:${weeklyProgress}%"></div></div></div>` : ""}
      ${monthlyThreshold ? `<p class="notice">${monthlyThreshold}.</p>` : ""}
      <form class="entry-form" id="budget-form">
        <label>Limite total mensal (${state.settings.currency})<input class="text-input" name="monthlyLimit" type="number" min="0" step="0.01" value="${state.budgets.monthlyLimit}" required></label>
        <div class="form-pair"><label>Limite semanal (${state.settings.currency})<input class="text-input" name="weeklyLimit" type="number" min="0" step="0.01" value="${state.budgets.weeklyLimit}" required></label><label>Meta de economia (${state.settings.currency})<input class="text-input" name="savingsTarget" type="number" min="0" step="0.01" value="${state.budgets.savingsTarget}" required></label></div>
        <h2>Limite por categoria</h2>
        <div class="form-grid">${expenseCategories.map((category, index) => `<label class="form-field">${escapeHtml(category)} (€)<input class="text-input" type="number" min="0" step="0.01" name="categoryLimit${index}" value="${state.budgets.categoryLimits[category] || 0}"></label>`).join("")}</div>
        <button class="primary-button" type="submit">Salvar orçamento</button>
      </form>
      <div class="section-heading"><h2>Progresso por categoria</h2></div><div class="budget-list">${categoryRows}</div>
    </section>`;
}

function renderReports() {
  const selectedMonth = document.querySelector("#report-month") ? document.querySelector("#report-month").value : localDate().slice(0, 7);
  const selected = state.transactions.filter(item => item.date.slice(0, 7) === selectedMonth);
  const income = totalTransactions(selected, "income");
  const expenses = totalTransactions(selected, "expense");
  const previousDate = new Date(`${selectedMonth}-01T12:00:00`);
  previousDate.setMonth(previousDate.getMonth() - 1);
  const previousKey = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, "0")}`;
  const previous = state.transactions.filter(item => item.date.slice(0, 7) === previousKey);
  const byCategory = categories.map(category => ({
    category,
    total: sumMoney(selected.filter(item => item.type === "expense" && item.category === category))
  })).filter(item => item.total > 0).sort((a, b) => b.total - a.total);
  const expenseCount = selected.filter(item => item.type === "expense").length;
  const savingsRate = income > 0 ? Math.round((income - expenses) / income * 100) : 0;
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Visão geral</p><h1>Relatórios</h1><p>Veja como suas receitas, despesas e economias evoluem.</p></div>
      <label class="filter-label">Mês do relatório<input class="text-input" type="month" id="report-month" value="${escapeHtml(selectedMonth)}"></label>
      <div class="summary-grid"><div class="summary-card"><span>Receitas</span><strong class="income-text">${escapeHtml(money(income))}</strong></div><div class="summary-card"><span>Despesas</span><strong>${escapeHtml(money(expenses))}</strong></div><div class="summary-card"><span>Economia líquida</span><strong>${escapeHtml(money(income - expenses))}</strong></div><div class="summary-card"><span>Taxa de economia</span><strong>${savingsRate}%</strong></div><div class="summary-card"><span>Movimentações</span><strong>${selected.length}</strong></div><div class="summary-card"><span>Média por despesa</span><strong>${escapeHtml(money(expenseCount ? expenses / expenseCount : 0))}</strong></div></div>
      <section class="dashboard-chart-card"><div class="section-heading"><h2>Comparação mensal</h2></div>${renderMonthlyBars()}</section>
      <section class="dashboard-chart-card"><div class="section-heading"><h2>Evolução estimada do saldo</h2></div><p class="muted-copy">Saldo inicial + movimentações + transferências registradas nos cofrinhos até o fim de cada mês.</p><div class="balance-trend">${renderBalanceTrend()}</div></section>
      <section class="dashboard-chart-card"><div class="section-heading"><h2>Gastos por categoria</h2></div>${renderCategoryExpenses(byCategory)}</section>
      <div class="summary-strip"><span>Mês anterior (${previousKey})<strong>Receitas ${escapeHtml(money(totalTransactions(previous, "income")))} · Despesas ${escapeHtml(money(totalTransactions(previous, "expense")))}</strong></span><span>Categoria com maior gasto<strong>${escapeHtml(byCategory[0] ? byCategory[0].category : "Sem dados")}</strong></span></div>
      <button class="secondary-button" type="button" data-action="export-csv">Exportar relatório do mês (CSV)</button>
    </section>`;
}

function renderSettings() {
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Preferências pessoais</p><h1>Configurações</h1><p>Personalize seu espaço e cuide dos seus dados.</p></div>
      <form class="entry-form" id="settings-form">
        <label>Nome do aplicativo<input class="text-input" name="appName" maxlength="36" value="${escapeHtml(state.settings.appName)}" required></label>
        <div class="form-pair"><label>Tema<select class="text-input" name="theme"><option value="dark" ${state.settings.theme === "dark" ? "selected" : ""}>Escuro</option><option value="light" ${state.settings.theme === "light" ? "selected" : ""}>Claro</option></select></label><label>Paleta de cores<select class="text-input" name="palette">${[["mint", "Verde menta"], ["ocean", "Azul oceano"], ["violet", "Violeta"], ["sunset", "Pôr do sol"], ["rose", "Rosa"]].map(([value, label]) => `<option value="${value}" ${state.settings.palette === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
        <div class="form-pair"><label>Modelo da interface<select class="text-input" name="layout">${[["comfortable", "Confortável"], ["compact", "Compacto"], ["spacious", "Espaçoso"]].map(([value, label]) => `<option value="${value}" ${state.settings.layout === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Gráficos<select class="text-input" name="chartType"><option value="bars" ${state.settings.chartType === "bars" ? "selected" : ""}>Barras</option><option value="donut" ${state.settings.chartType === "donut" ? "selected" : ""}>Círculos</option></select></label></div>
        <label>Moeda<select class="text-input" name="currency">${["EUR", "BRL", "USD"].map(currency => `<option ${state.settings.currency === currency ? "selected" : ""}>${currency}</option>`).join("")}</select></label>
        <label>Saldo inicial (${state.settings.currency})<input class="text-input" name="initialBalance" type="number" min="0" step="0.01" value="${state.settings.initialBalance}" required></label>
        <label class="setting-check"><input name="notifications" type="checkbox" ${state.settings.notifications ? "checked" : ""}>Ativar lembretes enquanto o aplicativo estiver aberto</label>
        <div class="form-actions"><button class="primary-button" type="submit">Salvar configurações</button><button class="secondary-button" type="button" data-action="randomize-look">Sortear cores e modelo</button></div>
      </form>
      <div class="account-card"><h2>Backup e privacidade</h2><p>Exporte uma cópia JSON ou importe registros para combinar com os dados atuais. Para apagar seus dados locais e sincronizados, confirme a ação abaixo.</p><div class="form-actions"><button class="secondary-button" type="button" data-action="export-json">Exportar backup</button><button class="secondary-button" type="button" data-action="import-json">Importar backup</button><button class="danger-button" type="button" data-action="clear-data">Apagar todos os dados</button></div></div>
      <p class="notice">As notificações do navegador aparecem enquanto o app estiver aberto. Lembretes em segundo plano dependem do suporte de notificações da plataforma.</p>
    </section>`;
}

    function render() {
      applyTheme();
      if (activePage === "inicio") renderDashboard();
      else if (activePage === "meu-dia") renderMyDay();
      else if (activePage === "calendario") renderCalendar();
      else if (activePage === "habitos") renderHabits();
      else if (activePage === "cofrinhos") renderPiggyBanks();
      else if (activePage === "orcamento") renderBudget();
      else if (activePage === "relatorios") renderReports();
      else if (activePage === "configuracoes") renderSettings();
      else if (activePage === "diario") renderJournal();
      else if (activePage === "assistente") renderAssistant();
      else if (activePage === "conta") renderAccount();
      else if (moduleConfigs[activePage]) renderCollectionPage(activePage);
      else {
        activePage = "inicio";
        renderDashboard();
      }
      document.querySelectorAll("[data-page]").forEach(button => {
        const active = button.dataset.page === activePage;
        button.classList.toggle("active", active && button.classList.contains("nav-item"));
        if (button.classList.contains("nav-item")) {
          if (active) button.setAttribute("aria-current", "page");
          else button.removeAttribute("aria-current");
        }
      });
    }

    function setPage(page) {
      if (!page) return;
      activePage = page;
      editingId = null;
      if (sideMenu) sideMenu.hidden = true;
      if (menuBackdrop) menuBackdrop.hidden = true;
      if (menuButton) menuButton.setAttribute("aria-expanded", "false");
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function downloadFile(filename, content, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportBackup() {
      const backup = { format: "mylife-backup", version: 2, exportedAt: new Date().toISOString(), data: normalizeData(state) };
      downloadFile(`mylife-backup-${localDate()}.json`, JSON.stringify(backup, null, 2), "application/json");
      showToast("Backup exportado.");
    }

    function exportTransactionsCsv(monthKey) {
      const columns = ["data", "tipo", "descricao", "valor", "categoria", "forma_pagamento", "conta"];
      const transactions = monthKey ? state.transactions.filter(item => item.date.slice(0, 7) === monthKey) : state.transactions;
      const rows = transactions.map(item => [
        item.date.slice(0, 10),
        item.type === "income" ? "entrada" : "saída",
        item.title,
        item.amount.toFixed(2),
        item.category,
        item.paymentMethod,
        item.account
      ]);
      const csv = [columns, ...rows].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(";")).join("\r\n");
      downloadFile(`mylife-movimentacoes-${localDate()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
    }

    async function removeLocalState(accountId) {
      const key = storageKey(accountId);
      if ("indexedDB" in window) {
        try {
          const db = await openDatabase();
          await new Promise((resolve, reject) => {
            const transaction = db.transaction(stateStore, "readwrite");
            transaction.objectStore(stateStore).delete(key);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error || new Error("Falha ao apagar dados locais."));
            transaction.onabort = () => reject(transaction.error || new Error("A exclusão local foi cancelada."));
          });
        } catch (error) {
          throw new Error(`Não foi possível apagar os dados locais: ${error.message}`);
        }
      }
      try {
        localStorage.removeItem(`mylife-v1:${accountId || "guest"}`);
        localStorage.removeItem(key);
      } catch (error) {
        throw new Error(`Não foi possível apagar os dados antigos: ${error.message}`);
      }
    }

    async function importBackup(file) {
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("O arquivo não contém um JSON válido.");
      }
      const source = parsed && parsed.format === "mylife-backup" ? parsed.data : parsed;
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new Error("O arquivo não tem o formato de backup do MyLife.");
      }
      if (!window.confirm("Os registros do backup serão combinados com os dados atuais. Quando um registro tiver o mesmo ID, será mantida a versão atual. Continuar?")) return;
      const currentData = normalizeData(state);
      const backupData = normalizeData(source);
      const currentHasRecords = [
        "transactions", "commitments", "tasks", "goals", "payables", "receivables",
        "shopping", "notes", "piggyBanks", "subscriptions", "habits", "journal"
      ].some(collection => currentData[collection].length > 0);
      state = mergeAccountData(backupData, currentData);
      if (!currentHasRecords) {
        state.settings = backupData.settings;
        state.budgets = backupData.budgets;
        state.mood = backupData.mood || state.mood;
      }
      refreshLinkedGoals();
      applyTheme();
      persist();
      render();
      showToast("Backup importado.");
    }

    async function clearAllData() {
      if (!window.confirm("Apagar todos os dados do MyLife neste aparelho e na conta conectada? Esta ação não pode ser desfeita.")) return;
      try {
        await Promise.all([localSaveQueue, syncQueue]);
        if (currentUser && supabase) {
          const { error } = await supabase.from("mylife_data").delete().eq("user_id", currentUser.id);
          if (error) throw error;
        }
        await removeLocalState(userId);
        if (userId) await removeLocalState("guest");
        state = emptyData();
        setSyncStatus("saved", currentUser ? "Conta sem dados" : "Salvo neste aparelho");
        render();
        showToast("Todos os dados foram apagados.");
      } catch (error) {
        console.error("Não foi possível apagar todos os dados.", error);
        showToast(`Não foi possível concluir a exclusão: ${error.message}`, true);
      }
    }

    function handleAction(button) {
      const action = button.dataset.action;
      const id = button.dataset.id;
      if (action === "edit-record") {
        editingId = id;
        render();
      } else if (action === "cancel-edit") {
        editingId = null;
        render();
      } else if (action === "delete-record") {
        const collection = button.dataset.collection;
        const record = state[collection].find(item => item.id === id);
        if (record && window.confirm(`Excluir “${record.title}”?`)) {
          state[collection] = state[collection].filter(item => item.id !== id);
          persist();
          render();
          showToast("Item excluído.");
        }
      } else if (action === "settle-payable" || action === "settle-receivable") {
        const kind = action === "settle-payable" ? "payables" : "receivables";
        const record = state[kind].find(item => item.id === id);
        if (record) settleBill(record, kind);
      } else if (action === "pay-subscription") {
        const record = state.subscriptions.find(item => item.id === id);
        if (record && window.confirm(`Registrar a cobrança de ${record.title} (${formatDate(button.dataset.chargeDate)}) como despesa?`)) recordSubscriptionPayment(record, button.dataset.chargeDate);
      } else if (action === "calendar-prev" || action === "calendar-next") {
        calendarCursor.setMonth(calendarCursor.getMonth() + (action === "calendar-prev" ? -1 : 1));
        render();
      } else if (action === "calendar-today") {
        calendarCursor = new Date();
        selectedCalendarDate = localDate();
        render();
      } else if (action === "add-priority" || action === "remove-priority") {
        const task = state.tasks.find(item => item.id === id);
        if (!task) return;
        if (action === "add-priority") {
          if (state.tasks.filter(item => item.priorityToday).length >= 3) {
            showToast("Você pode escolher até três prioridades.", true);
            return;
          }
          task.priorityToday = true;
        } else task.priorityToday = false;
        persist();
        render();
      } else if (action === "toggle-habit") {
        const habit = state.habits.find(item => item.id === id);
        if (!habit) return;
        const today = localDate();
        habit.history = habit.history.includes(today) ? habit.history.filter(date => date !== today) : [...habit.history, today];
        persist();
        render();
      } else if (action === "delete-habit") {
        const habit = state.habits.find(item => item.id === id);
        if (habit && window.confirm(`Excluir o hábito “${habit.title}”?`)) {
          state.habits = state.habits.filter(item => item.id !== id);
          persist();
          render();
        }
      } else if (action === "delete-piggy") {
        const piggy = state.piggyBanks.find(item => item.id === id);
        if (piggy && window.confirm(`Excluir o cofrinho “${piggy.title}”? O valor reservado voltará ao saldo disponível.`)) {
          state.piggyBanks = state.piggyBanks.filter(item => item.id !== id);
          state.goals.forEach(goal => {
            if (goal.linkedPiggyId === id) goal.linkedPiggyId = "";
          });
          persist();
          render();
          showToast("Cofrinho excluído; o valor foi liberado do saldo reservado.");
        }
      } else if (action === "export-json") exportBackup();
      else if (action === "export-csv") {
        const reportMonth = document.querySelector("#report-month");
        exportTransactionsCsv(reportMonth ? reportMonth.value : "");
      } else if (action === "randomize-look") {
        const palettes = ["mint", "ocean", "violet", "sunset", "rose"];
        const layouts = ["comfortable", "compact", "spacious"];
        const pick = (options, current) => {
          const available = options.filter(option => option !== current);
          return available[Math.floor(Math.random() * available.length)];
        };
        state.settings.palette = pick(palettes, state.settings.palette);
        state.settings.theme = pick(["dark", "light"], state.settings.theme);
        state.settings.layout = pick(layouts, state.settings.layout);
        state.settings.chartType = pick(["bars", "donut"], state.settings.chartType);
        applyTheme();
        persist();
        render();
        showToast("Novo tema e modelo aplicados.");
      }
      else if (action === "import-json") importFile.click();
      else if (action === "clear-data") void clearAllData();
      else if (action === "delete-journal") {
        state.journal = state.journal.filter(entry => entry.id !== id);
        persist();
        render();
      } else if (action === "signout") {
        if (supabase) void supabase.auth.signOut().then(({ error }) => {
          if (error) throw error;
        }).catch(error => {
          console.error("Falha ao sair da conta.", error);
          showToast("Não foi possível sair da conta.", true);
        });
      }
    }

    document.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target : null;
      const pageButton = target && target.closest("[data-page]");
      if (pageButton) {
        event.preventDefault();
        setPage(pageButton.dataset.page);
        return;
      }
      const actionButton = target && target.closest("[data-action]");
      if (actionButton) {
        handleAction(actionButton);
        return;
      }
      const calendarDay = target && target.closest("[data-calendar-date]");
      if (calendarDay) {
        selectedCalendarDate = calendarDay.dataset.calendarDate;
        render();
      }
    });

    document.addEventListener("change", event => {
      const target = event.target;
      if (target.id === "finance-period") {
        financePeriod = target.value;
        render();
      } else if (target.id === "finance-date") {
        financeDate = target.value || localDate();
        render();
      } else if (target.id === "report-month") {
        render();
      } else if (target.id === "task-filter") {
        render();
      } else if (target.matches("[data-toggle-record]")) {
        const [collection, id, key] = target.dataset.toggleRecord.split("|");
        const record = state[collection].find(item => item.id === id);
        if (record) {
          record[key] = target.checked;
          persist();
          render();
        }
      }
    });

    document.addEventListener("input", event => {
      const target = event.target;
      if (target.id === "note-search") {
        const value = target.value;
        const selection = value.length;
        render();
        const updatedSearch = document.querySelector("#note-search");
        if (updatedSearch) {
          updatedSearch.focus();
          updatedSearch.setSelectionRange(selection, selection);
        }
      }
    });

    document.addEventListener("submit", async event => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());

      if (form.id === "record-form") {
        const collection = form.dataset.collection;
        const config = moduleConfigs[activePage];
        if (!config || config.collection !== collection) return;
        const itemData = Object.fromEntries(config.fields.map(field => [field.key, fieldValue(field, values[field.key])]));
        const existingIndex = state[collection].findIndex(item => item.id === editingId);
        const existing = existingIndex >= 0 ? state[collection][existingIndex] : null;
        if (collection === "transactions" && itemData.amount <= 0) return showToast("Informe um valor maior que zero.", true);
        if (collection === "subscriptions" && itemData.amount <= 0) return showToast("Informe um valor maior que zero.", true);
        if (collection === "goals" && !itemData.target) return showToast("Informe o valor desejado para a meta.", true);
        const record = { ...defaultForCollection(collection), ...(existing || {}), ...itemData, id: existing ? existing.id : makeId() };
        if (collection === "transactions" && !record.date) record.date = new Date().toISOString();
        if (collection === "notes") record.updatedAt = new Date().toISOString();
        let budgetAlert = false;
        if (collection === "transactions" && !existing) budgetAlert = createTransaction(itemData);
        else if (existing) state[collection][existingIndex] = record;
        else state[collection].unshift(record);
        if (collection === "goals") refreshLinkedGoals();
        editingId = null;
        persist();
        render();
        if (!budgetAlert) showToast(existing ? "Alterações salvas." : "Item adicionado.");
      } else if (form.id === "natural-entry-form") {
        const parsed = parseNaturalTransaction(values.sentence || "");
        if (!parsed) return showToast("Não identifiquei um valor. Tente, por exemplo: “Gastei 35 euros no supermercado”.", true);
        const budgetAlert = createTransaction({ ...parsed, date: localDate(), paymentMethod: "Outro" });
        persist();
        render();
        if (!budgetAlert) showToast("Movimentação registrada.");
      } else if (form.id === "quick-transaction-form") {
        const amount = Number(values.amount);
        if (!Number.isFinite(amount) || amount <= 0) return showToast("Informe um valor maior que zero.", true);
        const budgetAlert = createTransaction({ title: values.title, amount, type: values.type, category: "Outros", date: localDate(), paymentMethod: "Outro" });
        persist();
        render();
        if (!budgetAlert) showToast("Movimentação registrada.");
      } else if (form.id === "habit-form") {
        const title = cleanText(values.title, 140);
        if (!title) return;
        state.habits.unshift({
          id: makeId(),
          title,
          category: cleanText(values.category, 60) || "Outro",
          frequency: values.frequency === "weekly" ? "weekly" : "daily",
          time: values.time || "",
          targetPerWeek: Math.max(1, Math.min(7, Number(values.targetPerWeek) || 7)),
          history: []
        });
        persist();
        render();
        showToast("Hábito adicionado.");
      } else if (form.id === "piggy-form") {
        const target = Number(values.target);
        if (!Number.isFinite(target) || target <= 0) return showToast("Informe um objetivo maior que zero.", true);
        state.piggyBanks.unshift({
          id: makeId(),
          title: cleanText(values.title, 140),
          target,
          current: 0,
          deadline: values.deadline || "",
          description: cleanText(values.description, 1000),
          linkedGoalId: values.linkedGoalId || "",
          history: []
        });
        refreshLinkedGoals();
        persist();
        render();
        showToast("Cofrinho criado.");
      } else if (form.matches(".piggy-transfer-form")) {
        const piggy = state.piggyBanks.find(item => item.id === form.dataset.id);
        const amount = Number(values.amount);
        const direction = event.submitter && event.submitter.value;
        if (!piggy || !Number.isFinite(amount) || amount <= 0) return showToast("Informe um valor válido.", true);
        const cents = Math.round(amount * 100);
        if (direction === "deposit" && cents > Math.round(currentBalance() * 100)) return showToast("O saldo disponível não é suficiente para esse depósito.", true);
        if (direction === "withdrawal" && cents > Math.round(piggy.current * 100)) return showToast("O cofrinho não tem saldo suficiente para essa retirada.", true);
        if (!["deposit", "withdrawal"].includes(direction)) return showToast("Escolha depositar ou retirar.", true);
        piggy.current = Math.round(piggy.current * 100 + (direction === "deposit" ? cents : -cents)) / 100;
        piggy.history.unshift({ id: makeId(), type: direction, amount: cents / 100, date: new Date().toISOString() });
        refreshLinkedGoals();
        persist();
        render();
        showToast(direction === "deposit" ? "Depósito registrado." : "Retirada registrada.");
      } else if (form.id === "budget-form") {
        const expenseCategories = categories.filter(item => !["Salário", "Trabalho extra", "Investimentos"].includes(item));
        state.budgets = {
          monthlyLimit: Math.max(0, Number(values.monthlyLimit) || 0),
          weeklyLimit: Math.max(0, Number(values.weeklyLimit) || 0),
          savingsTarget: Math.max(0, Number(values.savingsTarget) || 0),
          categoryLimits: Object.fromEntries(expenseCategories.map((category, index) => [category, Math.max(0, Number(values[`categoryLimit${index}`]) || 0)]))
        };
        persist();
        render();
        showToast("Orçamento atualizado.");
      } else if (form.id === "settings-form") {
        const notificationsEnabled = form.elements.notifications.checked
          ? await requestNotifications()
          : false;
        state.settings = {
          ...state.settings,
          appName: cleanText(values.appName, 36) || "MyLife",
          theme: values.theme === "light" ? "light" : "dark",
          palette: ["mint", "ocean", "violet", "sunset", "rose"].includes(values.palette) ? values.palette : "mint",
          layout: ["compact", "comfortable", "spacious"].includes(values.layout) ? values.layout : "comfortable",
          chartType: ["bars", "donut"].includes(values.chartType) ? values.chartType : "bars",
          currency: ["EUR", "BRL", "USD"].includes(values.currency) ? values.currency : "EUR",
          initialBalance: Math.max(0, Number(values.initialBalance) || 0),
          notifications: notificationsEnabled
        };
        persist();
        render();
        showToast("Configurações salvas.");
      } else if (form.id === "journal-form") {
        const text = cleanText(values.entry, 3000);
        if (!text) return;
        state.journal.unshift({ id: makeId(), text, createdAt: new Date().toISOString() });
        persist();
        render();
        showToast("Registro guardado.");
      } else if (form.id === "calendar-event-form") {
        const date = values.date || selectedCalendarDate;
        state.commitments.unshift({
          id: makeId(),
          title: cleanText(values.title, 140),
          date,
          time: values.time || "",
          location: cleanText(values.location, 160),
          notes: "",
          category: "Pessoal",
          reminder: Math.max(0, Math.min(10080, Number(values.reminder) || 0)),
          done: false
        });
        selectedCalendarDate = date;
        calendarCursor = new Date(`${date}T12:00:00`);
        persist();
        render();
        showToast("Compromisso adicionado ao calendário.");
      } else if (form.id === "auth-form") {
        if (!supabase) return showToast("Configure o Supabase para habilitar contas.", true);
        try {
          const submitter = event.submitter;
          const method = submitter && submitter.value === "signup" ? "signUp" : "signInWithPassword";
          const { data, error } = await supabase.auth[method]({ email: values.email, password: values.password });
          const message = document.querySelector("#auth-message");
          if (error) {
            console.error("Falha na autenticação.", error);
            if (message) message.textContent = error.message;
            return;
          }
          if (method === "signUp" && !data.session && message) message.textContent = "Conta criada. Verifique seu e-mail para confirmar o cadastro.";
          else if (message) message.textContent = "Login realizado.";
        } catch (error) {
          console.error("Falha na autenticação.", error);
          showToast("Não foi possível concluir a autenticação.", true);
        }
      } else if (form.id === "chat-form") {
        if (!supabase || !currentUser) return showToast("Entre na sua conta para usar o assistente.", true);
        const message = cleanText(values.message, 4000);
        if (!message) return;
        chatMessages.push({ role: "user", content: message });
        render();
        const input = document.querySelector('#chat-form input[name="message"]');
        const sendButton = document.querySelector('#chat-form button[type="submit"]');
        if (input) input.disabled = true;
        if (sendButton) sendButton.disabled = true;
        try {
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          if (!data.session) throw new Error("Sua sessão expirou. Entre novamente.");
          const response = await fetch("./api/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
            body: JSON.stringify({ message })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "O assistente não conseguiu responder.");
          chatMessages.push({ role: "assistant", content: result.reply });
        } catch (error) {
          console.error("Falha ao enviar mensagem ao assistente.", error);
          chatMessages.push({ role: "assistant", content: `Não consegui enviar sua mensagem: ${error.message}` });
        }
        render();
        const chat = document.querySelector("#chat-messages");
        if (chat) chat.scrollTop = chat.scrollHeight;
      }
    });

    if (menuButton && sideMenu && menuBackdrop) {
      menuButton.addEventListener("click", () => {
        sideMenu.hidden = !sideMenu.hidden;
        menuBackdrop.hidden = sideMenu.hidden;
        menuButton.setAttribute("aria-expanded", String(!sideMenu.hidden));
      });
      document.querySelector("#close-menu").addEventListener("click", () => {
        sideMenu.hidden = true;
        menuBackdrop.hidden = true;
        menuButton.setAttribute("aria-expanded", "false");
      });
      menuBackdrop.addEventListener("click", () => {
        sideMenu.hidden = true;
        menuBackdrop.hidden = true;
        menuButton.setAttribute("aria-expanded", "false");
      });
    }

    if (importFile) {
      importFile.addEventListener("change", async () => {
        const [file] = importFile.files || [];
        importFile.value = "";
        if (!file) return;
        try {
          await importBackup(file);
        } catch (error) {
          console.error("Falha ao importar backup.", error);
          showToast(error.message || "Não foi possível importar o backup.", true);
        }
      });
    }

    async function initialize() {
      try {
        state = await loadLocalState("guest") || emptyData();
      } catch (error) {
        console.error("Falha ao carregar os dados locais.", error);
        showToast(error.message || "Não foi possível carregar os dados locais.", true);
      }
      applyTheme();
      render();
      if ("serviceWorker" in navigator && location.protocol !== "file:") {
        navigator.serviceWorker.register("./sw.js").catch(error => console.error("Não foi possível ativar o modo PWA.", error));
      }
      clearInterval(reminderTimer);
      reminderTimer = setInterval(checkReminders, 60 * 1000);
      checkReminders();
      await configureSupabase();
    }

    void initialize();

function deliverReminder(key, title, body) {
  if (!state.settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const storageKey = `mylife-notified:${key}`;
  try {
    if (sessionStorage.getItem(storageKey)) return;
    new Notification(title, { body, icon: new URL("./icon-180.png", document.baseURI).href });
    sessionStorage.setItem(storageKey, "1");
  } catch (error) {
    console.warn("Não foi possível exibir o lembrete.", error);
  }
}

function checkReminders() {
  if (!state.settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  for (const item of state.commitments) {
    if (item.done || !item.date || !item.time) continue;
    const eventAt = new Date(`${item.date}T${item.time}`).getTime();
    const reminderAt = eventAt - item.reminder * 60 * 1000;
    if (now >= reminderAt && now <= eventAt + 60 * 1000) {
      deliverReminder(`commitment:${item.id}:${item.date}:${item.time}`, "Compromisso próximo", item.title);
    }
  }
}

async function requestNotifications() {
  if (!("Notification" in window)) {
    showToast("Este navegador não oferece suporte a notificações.", true);
    return false;
  }
  try {
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") {
      showToast("Permissão de notificações não concedida.", true);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Não foi possível solicitar permissão para notificações.", error);
    showToast("Não foi possível ativar as notificações.", true);
    return false;
  }
}

function renderJournal() {
  const entries = state.journal.length
    ? state.journal.map(entry => `<article class="journal-card"><p class="journal-date">${escapeHtml(formatDate(entry.createdAt, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}</p><p class="journal-text">${escapeHtml(entry.text)}</p><button class="icon-action danger-action" type="button" data-action="delete-journal" data-id="${escapeHtml(entry.id)}" aria-label="Excluir anotação">×</button></article>`).join("")
    : '<div class="empty-state">Seus registros vão aparecer aqui. Escreva sem se preocupar em encontrar as palavras perfeitas.</div>';
  app.innerHTML = `
    <section class="view">
      <div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Seu espaço seguro</p><h1>Diário</h1><p>Uma pausa para notar o que você está sentindo.</p></div>
      <form class="journal-form" id="journal-form"><textarea class="text-area" name="entry" maxlength="3000" placeholder="O que está na sua cabeça hoje?" aria-label="Escreva no seu diário" required></textarea><button class="primary-button" type="submit">Guardar registro</button></form>
      <div class="section-heading"><h2>Seus registros</h2><span class="section-note">${state.journal.length}</span></div><div class="journal-list">${entries}</div>
    </section>`;
}

function renderAssistant() {
  const configured = Boolean(supabase && currentUser);
  app.innerHTML = `
    <section class="view"><div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Uma conversa sem julgamentos</p><h1>Assistente IA</h1><p>Organize ideias, pense em próximos passos ou simplesmente converse.</p></div>
      ${configured ? "" : '<div class="notice"><strong>Conecte sua conta para conversar.</strong> Por segurança, o assistente funciona com login e envia mensagens ao serviço de IA configurado no backend.</div>'}
      <div class="assistant-card"><div class="assistant-header"><div class="assistant-orb" aria-hidden="true">✳</div><div><h2>MyLife Assistente</h2><p>Um espaço para pensar junto</p></div></div>
        <div class="chat-messages" id="chat-messages" aria-live="polite">${chatMessages.map(message => `<div class="chat-bubble ${message.role === "user" ? "user" : ""}">${escapeHtml(message.content)}</div>`).join("")}</div>
        <form class="chat-form" id="chat-form"><input class="text-input" name="message" maxlength="4000" placeholder="${configured ? "Escreva uma mensagem…" : "Faça login para começar…"}" aria-label="Mensagem para o assistente" ${configured ? "" : "disabled"} required><button class="primary-button" type="submit" aria-label="Enviar mensagem" ${configured ? "" : "disabled"}>↑</button></form>
      </div><p class="section-note assistant-disclaimer">O assistente oferece apoio geral e não substitui orientação profissional.</p>
    </section>`;
}

function renderAccount() {
  const signedIn = Boolean(currentUser);
  app.innerHTML = `
    <section class="view"><div class="page-heading"><button class="back-button" type="button" data-page="inicio">← Início</button><p class="eyebrow">Seus dados, no seu controle</p><h1>Conta e sincronização</h1><p>Use uma conta para sincronizar seus dados em outros dispositivos.</p></div>
      <div class="notice">${supabase ? "Os dados são salvos no IndexedDB e sincronizados com sua conta Supabase." : "O modo local está disponível. Configure Supabase no servidor para habilitar a sincronização em nuvem."}</div>
      ${signedIn ? `<div class="account-card"><h2>Conta conectada</h2><p>${escapeHtml(currentUser.email || "")}</p><button class="secondary-button" type="button" data-action="signout">Sair da conta</button></div>` : `<div class="account-card"><h2>${supabase ? "Entre ou crie sua conta" : "Armazenamento local"}</h2><form class="auth-form" id="auth-form"><label>E-mail<input class="text-input" type="email" name="email" autocomplete="email" required ${supabase ? "" : "disabled"}></label><label>Senha<input class="text-input" type="password" name="password" minlength="6" autocomplete="current-password" required ${supabase ? "" : "disabled"}></label><div class="form-actions"><button class="primary-button" name="action" value="signin" ${supabase ? "" : "disabled"}>Entrar</button><button class="secondary-button" name="action" value="signup" ${supabase ? "" : "disabled"}>Criar conta</button></div></form><p id="auth-message" class="auth-message" aria-live="polite"></p></div>`}
      <div class="account-card"><h2>Privacidade</h2><p>Os dados locais permanecem no dispositivo até você ativar uma conta. A chave secreta da IA é mantida apenas no backend.</p></div>
    </section>`;
}
