"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};
const requestCounts = new Map();
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT = 12;

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function readJson(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", chunk => {
      if (tooLarge) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        tooLarge = true;
        body = "";
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request too large"), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function allowedByRateLimit(key) {
  const now = Date.now();
  if (requestCounts.size > 5000) {
    for (const [entryKey, value] of requestCounts) {
      if (now - value.startedAt >= RATE_WINDOW_MS) requestCounts.delete(entryKey);
    }
  }
  const current = requestCounts.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requestCounts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

async function authenticate(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || "");
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!match || !url || !anonKey) return null;
  const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${match[1]}` }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user.id === "string" ? user : null;
}

async function handleAssistant(request, response) {
  if (!isSameOrigin(request)) return sendJson(response, 403, { error: "Origem não permitida." });
  const apiKey = process.env.AI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!apiKey || !supabaseUrl || !process.env.SUPABASE_ANON_KEY) {
    return sendJson(response, 503, { error: "O assistente ainda não está configurado neste servidor." });
  }

  let user;
  try {
    user = await authenticate(request);
  } catch (error) {
    console.error("Falha ao validar a sessão do Supabase.", error.message);
    return sendJson(response, 502, { error: "Não foi possível validar sua sessão." });
  }
  if (!user) return sendJson(response, 401, { error: "Entre na sua conta para usar o assistente." });

  const rateKey = `${user.id}:${request.socket.remoteAddress || "unknown"}`;
  if (!allowedByRateLimit(rateKey)) {
    return sendJson(response, 429, { error: "Muitas mensagens. Aguarde alguns minutos e tente novamente." });
  }

  let body;
  try {
    body = await readJson(request, 12 * 1024);
  } catch (error) {
    if (error.statusCode === 413) return sendJson(response, 413, { error: "A mensagem é grande demais." });
    return sendJson(response, 400, { error: "Envie uma mensagem válida." });
  }
  if (!body || typeof body.message !== "string" || !body.message.trim() || body.message.length > 4000) {
    return sendJson(response, 400, { error: "A mensagem deve ter entre 1 e 4.000 caracteres." });
  }

  const endpoint = process.env.AI_API_URL || "https://api.openai.com/v1/chat/completions";
  const model = process.env.AI_MODEL || "gpt-4o-mini";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const aiResponse = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Você é o assistente pessoal do MyLife. Responda em português, com empatia e de forma clara e prática. Ajude a organizar ideias e sugerir próximos passos pequenos. Não se apresente como profissional de saúde e não substitua ajuda profissional."
          },
          { role: "user", content: body.message.trim() }
        ],
        max_tokens: 500,
        temperature: 0.7
      })
    });
    if (!aiResponse.ok) {
      console.error("O provedor de IA retornou status", aiResponse.status);
      return sendJson(response, 502, { error: "O assistente está temporariamente indisponível. Tente novamente." });
    }
    const result = await aiResponse.json();
    const reply = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
    if (typeof reply !== "string" || !reply.trim()) {
      console.error("O provedor de IA retornou uma resposta vazia ou inválida.");
      return sendJson(response, 502, { error: "O assistente não retornou uma resposta válida." });
    }
    return sendJson(response, 200, { reply: reply.trim() });
  } catch (error) {
    console.error("Falha ao consultar o provedor de IA.", error.name);
    return sendJson(response, 502, { error: "Não foi possível conectar ao assistente. Tente novamente." });
  } finally {
    clearTimeout(timeout);
  }
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const resolved = path.resolve(root, `.${requestedPath}`);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== path.join(root, "index.html")) {
    return sendJson(response, 403, { error: "Acesso negado." });
  }
  fs.readFile(resolved, (error, content) => {
    if (error) return sendJson(response, 404, { error: "Arquivo não encontrado." });
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  } catch {
    return sendJson(response, 400, { error: "Endereço inválido." });
  }

  if (request.method === "GET" && pathname === "/api/config") {
    return sendJson(response, 200, {
      supabaseUrl: process.env.SUPABASE_URL || "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
    });
  }
  if (request.method === "POST" && pathname === "/api/assistant") {
    return handleAssistant(request, response);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson(response, 405, { error: "Método não permitido." });
  }
  return serveStatic(request, response, pathname);
});

server.listen(port, () => {
  console.log(`MyLife disponível em http://localhost:${port}`);
});
