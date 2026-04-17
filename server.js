require("dotenv").config();
const express = require("express");
const https = require("node:https");
const { URL } = require("node:url");

const app = express();
const port = process.env.PORT || 3000;
const ROBLOX_ASSET_URL = "https://assetdelivery.roblox.com/v1/asset/?id=";
const REQUEST_TIMEOUT_MS = 15000;
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";
const ROBLOX_COOKIE_FULL = process.env.ROBLOX_COOKIE_FULL || "";

app.use(express.static("public"));

function getTemplateIdFromXml(xml) {
  const match = xml.match(
    /<url>\s*https?:\/\/(?:www\.)?roblox\.com\/asset\/\?id=(\d+)\s*<\/url>/i
  );
  return match ? match[1] : null;
}

function buildHeaders() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Referer: "https://www.roblox.com/",
  };

  if (ROBLOX_COOKIE_FULL) {
    headers.Cookie = ROBLOX_COOKIE_FULL;
  } else if (ROBLOX_COOKIE) {
    headers.Cookie = `.ROBLOSECURITY=${ROBLOX_COOKIE}`;
  }

  return headers;
}

function httpsGet(url, timeoutMs, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method: "GET",
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || 443,
      headers: buildHeaders(),
    };

    const req = https.request(options, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location && maxRedirects > 0) {
        res.resume();
        const nextUrl = new URL(location, url).toString();
        httpsGet(nextUrl, timeoutMs, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }

      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: res.headers,
        stream: res,
        contentType: (res.headers["content-type"] || "").toLowerCase(),
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("AbortError"));
    });
    req.end();
  });
}

async function readText(response) {
  const chunks = [];
  for await (const chunk of response.stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

app.get("/api/download/:id", async (req, res) => {
  const inputId = String(req.params.id || "").trim();

  if (!/^\d+$/.test(inputId)) {
    return res.status(400).json({ error: "El ID debe ser numerico." });
  }

  if (!ROBLOX_COOKIE && !ROBLOX_COOKIE_FULL) {
    return res.status(500).json({
      error: "Falta ROBLOX_COOKIE o ROBLOX_COOKIE_FULL en variables de entorno.",
    });
  }

  try {
    const firstResponse = await httpsGet(
      `${ROBLOX_ASSET_URL}${inputId}`,
      REQUEST_TIMEOUT_MS
    );

    if (!firstResponse.ok) {
      let details = "";
      try {
        const text = await readText(firstResponse);
        const payload = JSON.parse(text);
        details = payload?.errors?.[0]?.message || "";
      } catch {
        details = "";
      }
      const statusCode = firstResponse.status === 401 ? 401 : 404;
      const baseMessage =
        firstResponse.status === 401
          ? "No autorizado para acceder al asset inicial"
          : "No se pudo obtener el asset inicial";
      return res.status(statusCode).json({
        error: details
          ? `${baseMessage}: ${details}.`
          : `${baseMessage}. El ID puede ser invalido, privado o no disponible.`,
      });
    }

    if (firstResponse.contentType.includes("image/")) {
      res.setHeader("Content-Type", firstResponse.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="roblox-${inputId}.png"`);
      res.setHeader("Cache-Control", "no-store");
      return firstResponse.stream.pipe(res);
    }

    const xmlText = await readText(firstResponse);
    const templateId = getTemplateIdFromXml(xmlText);

    if (!templateId) {
      return res.status(422).json({
        error:
          "No se encontro un ID de plantilla valido en la respuesta. Verifica que el ID sea de Shirt/Pants clasico.",
      });
    }

    const imageResponse = await httpsGet(
      `${ROBLOX_ASSET_URL}${templateId}`,
      REQUEST_TIMEOUT_MS
    );

    if (!imageResponse.ok) {
      return res.status(404).json({ error: "No se pudo obtener el PNG final." });
    }

    res.setHeader("Content-Type", imageResponse.contentType || "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="roblox-${templateId}.png"`);
    res.setHeader("Cache-Control", "no-store");

    imageResponse.stream.pipe(res);
  } catch (error) {
    if (error?.message === "AbortError") {
      return res.status(504).json({ error: "Tiempo de espera agotado al consultar Roblox." });
    }
    return res.status(500).json({ error: "Error interno al procesar la descarga." });
  }
});

app.get("/api/diag/:id", async (req, res) => {
  if (process.env.ENABLE_DIAG !== "1") {
    return res.status(404).json({ error: "Not found" });
  }
  const inputId = String(req.params.id || "").trim();
  const headersPreview = buildHeaders();
  const cookieSent = headersPreview.Cookie || "";
  const diagnostics = {
    inputId,
    cookieLoaded: Boolean(ROBLOX_COOKIE),
    cookieLength: ROBLOX_COOKIE.length,
    cookieFullLoaded: Boolean(ROBLOX_COOKIE_FULL),
    cookieFullLength: ROBLOX_COOKIE_FULL.length,
    sentCookieHeaderLength: cookieSent.length,
    sentCookieStart: cookieSent.slice(0, 40),
    sentCookieHasRoblosecurity: cookieSent.includes(".ROBLOSECURITY="),
    step: "init",
  };

  if (!/^\d+$/.test(inputId)) {
    return res.status(400).json({
      ...diagnostics,
      step: "validation",
      ok: false,
      error: "El ID debe ser numerico.",
    });
  }

  if (!ROBLOX_COOKIE && !ROBLOX_COOKIE_FULL) {
    return res.status(500).json({
      ...diagnostics,
      step: "env",
      ok: false,
      error: "Falta ROBLOX_COOKIE o ROBLOX_COOKIE_FULL en variables de entorno.",
    });
  }

  try {
    diagnostics.step = "auth_check";
    const authCheck = await httpsGet(
      "https://users.roblox.com/v1/users/authenticated",
      REQUEST_TIMEOUT_MS
    );
    let authBody = "";
    try {
      authBody = await readText(authCheck);
    } catch {
      authBody = "";
    }
    diagnostics.authCheck = {
      status: authCheck.status,
      ok: authCheck.ok,
      body: authBody.slice(0, 200),
    };

    diagnostics.step = "first_asset_request";
    const firstResponse = await httpsGet(
      `${ROBLOX_ASSET_URL}${inputId}`,
      REQUEST_TIMEOUT_MS
    );

    diagnostics.firstResponse = {
      status: firstResponse.status,
      ok: firstResponse.ok,
      contentType: firstResponse.contentType,
    };

    if (!firstResponse.ok) {
      let details = "";
      try {
        const text = await readText(firstResponse);
        const payload = JSON.parse(text);
        details = payload?.errors?.[0]?.message || "";
      } catch {
        details = "";
      }
      return res.status(200).json({
        ...diagnostics,
        step: "first_asset_request",
        ok: false,
        robloxStatus: firstResponse.status,
        error: details || "Fallo al obtener asset inicial.",
      });
    }

    if (firstResponse.contentType.includes("image/")) {
      firstResponse.stream.resume();
      return res.status(200).json({
        ...diagnostics,
        step: "first_asset_image",
        ok: true,
        message: "El asset inicial ya es imagen, no requiere segundo fetch.",
      });
    }

    diagnostics.step = "xml_parse";
    const xmlText = await readText(firstResponse);
    const templateId = getTemplateIdFromXml(xmlText);

    if (!templateId) {
      return res.status(200).json({
        ...diagnostics,
        step: "xml_parse",
        ok: false,
        error: "No se encontro templateId en XML.",
      });
    }

    diagnostics.templateId = templateId;
    diagnostics.step = "second_asset_request";
    const imageResponse = await httpsGet(
      `${ROBLOX_ASSET_URL}${templateId}`,
      REQUEST_TIMEOUT_MS
    );

    diagnostics.secondResponse = {
      status: imageResponse.status,
      ok: imageResponse.ok,
      contentType: imageResponse.contentType,
    };
    imageResponse.stream.resume();

    if (!imageResponse.ok) {
      return res.status(200).json({
        ...diagnostics,
        step: "second_asset_request",
        ok: false,
        robloxStatus: imageResponse.status,
        error: "Fallo al obtener PNG final.",
      });
    }

    return res.status(200).json({
      ...diagnostics,
      step: "done",
      ok: true,
      message: "Diagnostico completado. El flujo de descarga deberia funcionar.",
    });
  } catch (error) {
    return res.status(500).json({
      ...diagnostics,
      ok: false,
      step: diagnostics.step,
      error: error?.message === "AbortError" ? "Timeout consultando Roblox." : "Error interno.",
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor listo en puerto ${port}`);
});
