import express from "express";
import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3001);
const WATCHER_API_KEY = process.env.WATCHER_API_KEY || "";

const ELIFE_URL = process.env.ELIFE_URL || "https://elifelimo.com/fleet/";
const ELIFE_EMAIL = process.env.ELIFE_EMAIL || "";
const ELIFE_PASSWORD = process.env.ELIFE_PASSWORD || "";

const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() === "true";
const BASELINE_ON_FIRST_RUN =
  String(process.env.BASELINE_ON_FIRST_RUN || "true").toLowerCase() === "true";

const SEEN_RIDES_FILE = process.env.SEEN_RIDES_FILE || "/app/data/seen-rides.json";
const USER_DATA_DIR = process.env.USER_DATA_DIR || "/app/data/browser";
const DEBUG_SCREENSHOT_FILE =
  process.env.DEBUG_SCREENSHOT_FILE || "/app/data/last-screenshot.png";
const DEBUG_HTML_FILE = process.env.DEBUG_HTML_FILE || "/app/data/last-page.html";

let isChecking = false;

app.use(express.json());

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function createRideId(text) {
  return crypto
    .createHash("sha256")
    .update(normalizeText(text).toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

async function ensureDirectoryForFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function removePath(targetPath) {
  await fs.rm(targetPath, {
    recursive: true,
    force: true
  });
}

async function fileInfo(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      exists: true,
      path: filePath,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString()
    };
  } catch {
    return {
      exists: false,
      path: filePath
    };
  }
}

async function loadSeenState() {
  try {
    const content = await fs.readFile(SEEN_RIDES_FILE, "utf8");
    const parsed = JSON.parse(content);

    return {
      existed: true,
      ids: new Set(Array.isArray(parsed.seenRideIds) ? parsed.seenRideIds : [])
    };
  } catch {
    return {
      existed: false,
      ids: new Set()
    };
  }
}

async function saveSeenState(seenRideIds) {
  await ensureDirectoryForFile(SEEN_RIDES_FILE);

  const payload = {
    updatedAt: new Date().toISOString(),
    seenRideIds: Array.from(seenRideIds)
  };

  await fs.writeFile(SEEN_RIDES_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function saveDebugFiles(page) {
  try {
    await ensureDirectoryForFile(DEBUG_SCREENSHOT_FILE);
    await ensureDirectoryForFile(DEBUG_HTML_FILE);

    await page.screenshot({
      path: DEBUG_SCREENSHOT_FILE,
      fullPage: true
    });

    const html = await page.content();
    await fs.writeFile(DEBUG_HTML_FILE, html, "utf8");
  } catch (error) {
    console.error("No se pudieron guardar archivos debug:", error.message);
  }
}

function parseRideFromText(rawText) {
  const text = normalizeText(rawText);

  const lines = text
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const priceMatch = text.match(/USD\s*\d+(?:\.\d+)?/i);
  const dateMatch = text.match(
    /\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/i
  );

  const cleanedLines = lines.filter((line) => {
    const lower = line.toLowerCase();

    if (!line) return false;
    if (lower === "accept") return false;
    if (lower.includes("available")) return false;
    if (lower.includes("pending")) return false;
    if (lower.includes("ride pool")) return false;
    if (lower.includes("no more items")) return false;
    if (lower.includes("this list is visible")) return false;
    if (lower.includes("ride id")) return false;
    if (/^usd\s*\d+/i.test(line)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(line)) return false;

    return true;
  });

  return {
    id: createRideId(text),
    vehicle: cleanedLines[0] || "",
    date: dateMatch ? dateMatch[0] : "",
    from: cleanedLines[1] || "",
    to: cleanedLines[2] || "",
    price: priceMatch ? priceMatch[0].toUpperCase() : "",
    rawText: text
  };
}

async function waitSoft(page, ms) {
  await page.waitForTimeout(ms).catch(() => {});
}

async function safeBodyText(page) {
  return normalizeText(await page.locator("body").innerText().catch(() => ""));
}

async function detectLoggedOut(page) {
  const currentUrl = page.url().toLowerCase();
  const bodyText = (await safeBodyText(page)).toLowerCase();

  const passwordInputs = await page.locator('input[type="password"]').count().catch(() => 0);

  return (
    passwordInputs > 0 ||
    currentUrl.includes("login") ||
    bodyText.includes("sign in") ||
    bodyText.includes("log in") ||
    bodyText.includes("login")
  );
}

async function fillFirstAvailable(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.fill("");
      await locator.fill(value);
      return true;
    }
  }

  return false;
}

async function clickFirstAvailable(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.click({ timeout: 10000, force: true });
      return true;
    }
  }

  return false;
}

async function clickSignInRobust(page) {
  const selectors = [
    'button[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Submit")',
    '[role="button"]:has-text("Sign in")',
    '[role="button"]:has-text("Login")',
    'input[type="submit"]',
    'text=/^\\s*Sign\\s*in\\s*$/i',
    'text=/^\\s*Login\\s*$/i'
  ];

  const clickedBySelector = await clickFirstAvailable(page, selectors);

  if (clickedBySelector) {
    return {
      clicked: true,
      method: "selector"
    };
  }

  const clickedByEvaluate = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("button, [role='button'], input, div, span, a"));

    const target = elements.find((element) => {
      const text = (element.innerText || element.textContent || element.value || "").trim().toLowerCase();
      return text === "sign in" || text === "login" || text === "log in";
    });

    if (!target) {
      return false;
    }

    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }).catch(() => false);

  if (clickedByEvaluate) {
    return {
      clicked: true,
      method: "evaluate"
    };
  }

  await page.keyboard.press("Enter");

  return {
    clicked: true,
    method: "enter"
  };
}

async function maybeLogin(page) {
  const loggedOut = await detectLoggedOut(page);

  if (!loggedOut) {
    return {
      attempted: false,
      success: true,
      message: "La sesión parece estar activa"
    };
  }

  if (!ELIFE_EMAIL || !ELIFE_PASSWORD) {
    return {
      attempted: false,
      success: false,
      message: "Faltan ELIFE_EMAIL o ELIFE_PASSWORD en variables de entorno"
    };
  }

  console.log("Sesión no detectada. Intentando iniciar sesión...");

  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]',
    'input[autocomplete="username"]',
    'input[type="text"]'
  ];

  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="password" i]',
    'input[autocomplete="current-password"]'
  ];

  const emailFilled = await fillFirstAvailable(page, emailSelectors, ELIFE_EMAIL);
  const passwordFilled = await fillFirstAvailable(page, passwordSelectors, ELIFE_PASSWORD);

  if (!emailFilled || !passwordFilled) {
    return {
      attempted: true,
      success: false,
      message: "No se encontraron los campos de usuario y contraseña"
    };
  }

  console.log("Credenciales escritas. Intentando presionar Sign in...");

  const clickResult = await clickSignInRobust(page);
  console.log(`Click login ejecutado con método: ${clickResult.method}`);

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await waitSoft(page, 8000);

  const bodyTextAfter = (await safeBodyText(page)).toLowerCase();

  if (
    bodyTextAfter.includes("invalid") ||
    bodyTextAfter.includes("incorrect") ||
    bodyTextAfter.includes("wrong password") ||
    bodyTextAfter.includes("forgot my password")
  ) {
    await saveDebugFiles(page);
    return {
      attempted: true,
      success: false,
      message:
        "Elife parece indicar credenciales inválidas o login no completado. Revisa correo/password en variables de entorno."
    };
  }

  const stillLoggedOut = await detectLoggedOut(page);

  if (stillLoggedOut) {
    await saveDebugFiles(page);
    return {
      attempted: true,
      success: false,
      message:
        "Se intentó iniciar sesión, pero parece que no entró. Puede haber captcha, 2FA o el botón de login requiere otro ajuste."
    };
  }

  return {
    attempted: true,
    success: true,
    message: "Login realizado correctamente"
  };
}

async function goToRidePool(page) {
  await page.goto(ELIFE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await waitSoft(page, 3000);

  const loginResult = await maybeLogin(page);

  if (!loginResult.success) {
    await saveDebugFiles(page);
    throw new Error(loginResult.message);
  }

  await page.goto(ELIFE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await waitSoft(page, 3000);

  const ridePoolText = page.locator("text=/Ride\\s*Pool/i").first();

  if ((await ridePoolText.count().catch(() => 0)) > 0) {
    await ridePoolText.click({ force: true }).catch(() => {});
    await waitSoft(page, 2000);
  }

  const availableText = page.locator("text=/Available/i").first();

  if ((await availableText.count().catch(() => 0)) > 0) {
    await availableText.click({ force: true }).catch(() => {});
    await waitSoft(page, 2000);
  }
}

async function extractRideBlocksFromAcceptButtons(page) {
  return await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], a, div, span")
    ).filter((element) => {
      const text = element.textContent || "";
      return /accept/i.test(text);
    });

    const blocks = [];

    for (const candidate of candidates) {
      let current = candidate;

      for (let level = 0; level < 10 && current; level++) {
        const text = current.innerText || current.textContent || "";

        if (/USD\s*\d+/i.test(text) && text.length > 20 && text.length < 2500) {
          blocks.push(text);
          break;
        }

        current = current.parentElement;
      }
    }

    return blocks;
  });
}

async function extractRides(page) {
  await waitSoft(page, 2000);

  const ridesById = new Map();

  const blocks = await extractRideBlocksFromAcceptButtons(page).catch(() => []);

  for (const block of blocks) {
    const cleaned = normalizeText(block);

    if (!cleaned) continue;
    if (!/USD\s*\d+/i.test(cleaned)) continue;

    const ride = parseRideFromText(block);
    ridesById.set(ride.id, ride);
  }

  if (ridesById.size === 0) {
    const bodyText = await safeBodyText(page);

    const fallbackBlocks = bodyText
      .split(/Accept/i)
      .map((chunk) => chunk.trim())
      .filter((chunk) => /USD\s*\d+/i.test(chunk));

    for (const block of fallbackBlocks) {
      const ride = parseRideFromText(block);
      ridesById.set(ride.id, ride);
    }
  }

  return Array.from(ridesById.values());
}

async function checkElife() {
  const checkedAt = new Date().toISOString();

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    viewport: {
      width: 1600,
      height: 1000
    },
    locale: "en-US",
    timezoneId: "America/Costa_Rica",
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await goToRidePool(page);

    const rides = await extractRides(page);

    await saveDebugFiles(page);

    const seenState = await loadSeenState();
    const seenRideIds = seenState.ids;

    let newRides = rides.filter((ride) => !seenRideIds.has(ride.id));

    if (!seenState.existed && BASELINE_ON_FIRST_RUN) {
      newRides = [];
    }

    for (const ride of rides) {
      seenRideIds.add(ride.id);
    }

    await saveSeenState(seenRideIds);

    return {
      ok: true,
      checkedAt,
      totalRidesVisible: rides.length,
      newRides: newRides.length > 0,
      newRideCount: newRides.length,
      rides: newRides,
      allVisibleRides: rides
    };
  } finally {
    await context.close();
  }
}

function requireApiKey(req, res, next) {
  if (!WATCHER_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "WATCHER_API_KEY no está configurado"
    });
  }

  const providedKey = req.headers["x-api-key"] || req.query.token;

  if (providedKey !== WATCHER_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado"
    });
  }

  next();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "elife-watcher",
    time: new Date().toISOString()
  });
});

app.get("/check", requireApiKey, async (req, res) => {
  if (isChecking) {
    return res.status(409).json({
      ok: false,
      error: "Ya hay un chequeo en proceso. Intenta de nuevo en unos segundos."
    });
  }

  isChecking = true;

  try {
    const result = await checkElife();
    return res.json(result);
  } catch (error) {
    console.error("Error en /check:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
      checkedAt: new Date().toISOString(),
      debug: {
        screenshot: DEBUG_SCREENSHOT_FILE,
        html: DEBUG_HTML_FILE
      }
    });
  } finally {
    isChecking = false;
  }
});

app.get("/debug/status", requireApiKey, async (req, res) => {
  res.json({
    ok: true,
    screenshot: await fileInfo(DEBUG_SCREENSHOT_FILE),
    html: await fileInfo(DEBUG_HTML_FILE),
    seenRides: await fileInfo(SEEN_RIDES_FILE),
    userDataDir: USER_DATA_DIR
  });
});

app.get("/debug/html", requireApiKey, async (req, res) => {
  try {
    await fs.access(DEBUG_HTML_FILE);
    res.type("html").sendFile(DEBUG_HTML_FILE);
  } catch {
    res.status(404).json({
      ok: false,
      error: "No existe last-page.html todavía. Ejecuta /check primero."
    });
  }
});

app.get("/debug/screenshot", requireApiKey, async (req, res) => {
  try {
    await fs.access(DEBUG_SCREENSHOT_FILE);
    res.type("png").sendFile(DEBUG_SCREENSHOT_FILE);
  } catch {
    res.status(404).json({
      ok: false,
      error: "No existe last-screenshot.png todavía. Ejecuta /check primero."
    });
  }
});

app.post("/debug/clear-browser", requireApiKey, async (req, res) => {
  if (isChecking) {
    return res.status(409).json({
      ok: false,
      error: "Hay un chequeo en proceso. Intenta limpiar el navegador en unos segundos."
    });
  }

  await removePath(USER_DATA_DIR);
  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  res.json({
    ok: true,
    message: "Sesión del navegador eliminada correctamente",
    userDataDir: USER_DATA_DIR
  });
});

app.post("/reset-seen", requireApiKey, async (req, res) => {
  await saveSeenState(new Set());

  res.json({
    ok: true,
    message: "Historial de viajes vistos reiniciado"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`elife-watcher corriendo en puerto ${PORT}`);
});
