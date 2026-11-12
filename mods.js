const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_MODRINTH = 'https://api.modrinth.com/v2';
const CABECERAS = { 'User-Agent': 'La26Launcher/1.0 (launcher privado para un server de amigos)' };

// Solo se permite escribir dentro de estas carpetas/archivos del juego.
const RAICES_PERMITIDAS = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'options.txt'];

// ---------- Utilidades ----------
async function leerJSON(url) {
  const r = await fetch(url, { cache: 'no-store', headers: CABECERAS });
  if (!r.ok) throw new Error(`No se pudo leer ${url} (HTTP ${r.status})`);
  return r.json();
}

function sha1De(archivo) {
  return new Promise((ok, fallo) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(archivo)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fallo);
  });
}

async function descargar(url, destino, sha1Esperado) {
  const r = await fetch(url, { headers: CABECERAS });
  if (!r.ok) throw new Error(`No se pudo descargar ${path.basename(destino)} (HTTP ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());

  if (sha1Esperado) {
    const real = crypto.createHash('sha1').update(buf).digest('hex');
    if (real !== sha1Esperado.toLowerCase()) {
      throw new Error(`El archivo ${path.basename(destino)} llegó dañado (no coincide el sha1).`);
    }
  }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino + '.tmp', buf);
  fs.renameSync(destino + '.tmp', destino); // así nunca queda un archivo a medio bajar
}

async function enParalelo(items, limite, fn) {
  let i = 0;
  const obreros = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(obreros);
}

function rutaSegura(ruta) {
  if (typeof ruta !== 'string' || ruta.includes('\\')) return false;
  const partes = ruta.split('/');
  if (partes.some((p) => p === '' || p === '.' || p === '..' || p.includes(':'))) return false;
  return RAICES_PERMITIDAS.includes(partes[0]);
}

const urlValida = (u) => typeof u === 'string' && /^https?:\/\//.test(u);
const nombreJarValido = (n) => typeof n === 'string' && path.basename(n) === n && n.endsWith('.jar');

// ---------- Modrinth: busca la última versión compatible de cada mod (con sus dependencias) ----------
async function resolverModrinth({ slugs, mc, loader, api = API_MODRINTH, avisos = [] }) {
  const resultado = new Map(); // project_id -> { archivo, url, sha1 }
  const vistos = new Set();
  const filtro = `?loaders=${encodeURIComponent(JSON.stringify([loader]))}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;

  async function agregar(clave) {
    if (vistos.has(clave)) return;
    vistos.add(clave);

    let versiones;
    try {
      versiones = await leerJSON(`${api}/project/${encodeURIComponent(clave)}/version${filtro}`);
    } catch (err) {
      avisos.push(`Modrinth: no se pudo consultar "${clave}" (${err.message})`);
      return;
    }
    if (!Array.isArray(versiones) || versiones.length === 0) {
      avisos.push(`Modrinth: "${clave}" no tiene versión para ${loader} ${mc}`);
      return;
    }

    const v = versiones.find((x) => x.version_type === 'release') || versiones[0];
    const archivos = v.files || [];
    const f = archivos.find((x) => x.primary) || archivos[0];
    if (!f || !f.hashes || !f.hashes.sha1 || !urlValida(f.url) || !nombreJarValido(f.filename)) {
      avisos.push(`Modrinth: la respuesta para "${clave}" no tiene un archivo válido`);
      return;
    }

    vistos.add(v.project_id);
    resultado.set(v.project_id, { archivo: f.filename, url: f.url, sha1: f.hashes.sha1 });

    for (const d of v.dependencies || []) {
      if (d.dependency_type === 'required' && d.project_id) await agregar(d.project_id);
    }
  }

  for (const s of slugs) await agregar(s);
  return [...resultado.values()];
}

// ---------- Sincronización ----------
// manifest.json:
// {
//   "mods":     [ { "archivo": "x.jar", "url": "https://...", "sha1": "..." } ],
//   "archivos": [ { "ruta": "config/fancymenu/...", "url": "https://...", "sha1": "...", "soloSiNoExiste": false } ]
// }
async function sincronizarMods({
  manifestUrl,
  carpetaJuego,
  borrarExtras = true,
  modrinth = [],
  mc,
  loader = 'fabric',
  modrinthApi = API_MODRINTH,
  onEstado = () => {},
  onProgreso = () => {},
}) {
  const entradas = []; // { ruta, url, sha1, soloSiNoExiste }
  const avisos = [];

  if (manifestUrl) {
    onEstado('Buscando actualizaciones de mods...');
    const manifest = await leerJSON(manifestUrl);
    if (!manifest || !Array.isArray(manifest.mods)) {
      throw new Error('La lista de mods (manifest) no tiene el formato correcto.');
    }

    for (const m of manifest.mods) {
      if (!nombreJarValido(m.archivo) || !urlValida(m.url)) {
        throw new Error(`Entrada de mod inválida en el manifest: ${JSON.stringify(m)}`);
      }
      entradas.push({ ruta: 'mods/' + m.archivo, url: m.url, sha1: m.sha1 });
    }
    for (const a of manifest.archivos || []) {
      if (!rutaSegura(a.ruta) || !urlValida(a.url)) {
        throw new Error(`Entrada de archivo inválida en el manifest: ${JSON.stringify(a)}`);
      }
      entradas.push({ ruta: a.ruta, url: a.url, sha1: a.sha1, soloSiNoExiste: !!a.soloSiNoExiste });
    }
  }

  // Mods de optimización desde Modrinth. Si Modrinth falla, se sigue con lo que ya hay instalado.
  let modrinthOk = true;
  if (modrinth.length > 0) {
    onEstado('Buscando mods de rendimiento...');
    const avisosModrinth = [];
    const extra = await resolverModrinth({ slugs: modrinth, mc, loader, api: modrinthApi, avisos: avisosModrinth });
    modrinthOk = avisosModrinth.length === 0;
    avisos.push(...avisosModrinth);
    for (const e of extra) {
      if (!entradas.some((x) => x.ruta === 'mods/' + e.archivo)) {
        entradas.push({ ruta: 'mods/' + e.archivo, url: e.url, sha1: e.sha1 });
      }
    }
  }

  const dirMods = path.join(carpetaJuego, 'mods');
  fs.mkdirSync(dirMods, { recursive: true });
  const local = (ruta) => path.join(carpetaJuego, ...ruta.split('/'));

  // Sacar los .jar que ya no están en la lista (solo si la lista está completa)
  let borrados = 0;
  if (borrarExtras && modrinthOk) {
    const esperados = new Set(entradas.filter((e) => e.ruta.startsWith('mods/')).map((e) => e.ruta.slice(5)));
    for (const f of fs.readdirSync(dirMods)) {
      if (f.endsWith('.jar') && !esperados.has(f)) {
        fs.unlinkSync(path.join(dirMods, f));
        borrados++;
      }
    }
  }

  // Ver cuáles faltan o cambiaron
  const pendientes = [];
  for (const e of entradas) {
    const destino = local(e.ruta);
    if (fs.existsSync(destino)) {
      if (e.soloSiNoExiste || !e.sha1) continue;
      if ((await sha1De(destino)) === e.sha1.toLowerCase()) continue;
    }
    pendientes.push(e);
  }

  let hechos = 0;
  await enParalelo(pendientes, 4, async (e) => {
    await descargar(e.url, local(e.ruta), e.sha1);
    hechos++;
    onEstado(`Descargando archivos (${hechos}/${pendientes.length})...`);
    onProgreso(hechos, pendientes.length);
  });

  return { total: entradas.length, descargados: pendientes.length, borrados, avisos };
}

// ---------- Fabric ----------
// Baja el perfil de Fabric y lo deja como una "versión" que el launcher puede iniciar.
async function prepararFabric({ root, mc, loader = 'latest', onEstado = () => {} }) {
  const meta = `https://meta.fabricmc.net/v2/versions/loader/${mc}`;
  let version = loader;

  if (!version || version === 'latest') {
    const lista = await leerJSON(meta);
    if (!Array.isArray(lista) || lista.length === 0) throw new Error(`Fabric no soporta Minecraft ${mc}.`);
    version = (lista.find((x) => x.loader && x.loader.stable) || lista[0]).loader.version;
  }

  const id = `fabric-loader-${version}-${mc}`;
  const json = path.join(root, 'versions', id, `${id}.json`);

  if (!fs.existsSync(json)) {
    onEstado('Instalando Fabric...');
    const perfil = await leerJSON(`${meta}/${version}/profile/json`);
    fs.mkdirSync(path.dirname(json), { recursive: true });
    fs.writeFileSync(json, JSON.stringify(perfil, null, 2));
  }
  return id;
}

module.exports = { sincronizarMods, prepararFabric, resolverModrinth };
