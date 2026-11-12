const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const config = require('./config.json');
const { sincronizarMods, prepararFabric } = require('./mods');
const { asegurarJava, estadoJava } = require('./java');
const act = require('./actualizador');
const herr = require('./herramientas');
const { prepararForge } = require('./loaders');
const { ramAutomatica, JVM_POR_DEFECTO, escribirOpcionesIniciales } = require('./rendimiento');


// ---------- Versiones disponibles ----------
// config.versiones: lista de versiones; cada una tiene sus loaders (fabric / forge / neoforge).
function listaVersiones() {
  if (Array.isArray(config.versiones) && config.versiones.length) return config.versiones;
  // Compatibilidad con el config viejo (una sola versión)
  return [{
    id: config.version, mc: config.version, etiqueta: config.nombre, java: 21, servidor: true, carpeta: '',
    loaders: { [(config.loader || {}).tipo || 'fabric']: { manifestUrl: (config.mods || {}).manifestUrl, modrinth: (config.mods || {}).modrinth || [], borrarExtras: (config.mods || {}).borrarExtras } },
  }];
}

function resolverSeleccion(idSel, loaderSel) {
  const versiones = listaVersiones();
  const v = versiones.find((x) => x.id === idSel) || versiones[0];
  const disponibles = Object.keys(v.loaders || { fabric: {} });
  const loader = disponibles.includes(loaderSel) ? loaderSel : disponibles[0];
  return { v, loader, cfgLoader: (v.loaders || {})[loader] || {} };
}

// RAM: 'auto', un número en GB (lo que manda el slider, ej. 4 o 4.5) o un texto tipo "4G".
function resolverRam(r) {
  if (typeof r === 'number' && Number.isFinite(r) && r >= 1) return `${Math.round(r * 1024)}M`;
  if (typeof r === 'string' && r && r !== 'auto') return r;
  return ramAutomatica();
}

// Carpeta compartida (root) y carpeta propia de cada versión + loader (gameDir: mods, mundos, opciones).
function carpetaDeJuego(v, loader) {
  const root = path.join(app.getPath('appData'), config.carpetaJuego);
  const instancia = v.carpeta !== undefined ? v.carpeta : path.join('instancias', `${v.id}-${loader}`);
  return { root, gameDir: instancia ? path.join(root, instancia) : root };
}

// Todo lo que hace falta saber de la versión + loader elegidos en el launcher.
function seleccion({ version, loader } = {}) {
  const { v, loader: l, cfgLoader } = resolverSeleccion(version, loader);
  const { root, gameDir } = carpetaDeJuego(v, l);
  return { v, loader: l, cfgLoader, root, gameDir, mc: v.mc || v.id, etiqueta: `${v.id}-${l}` };
}

let win;
let jugando = false;
let actualizacionHallada = null;   // última versión nueva que encontró el actualizador

// ---------- Estado guardado (último usuario, modo, sesión Microsoft) ----------
const rutaEstado = () => path.join(app.getPath('userData'), 'estado.json');

function leer() {
  try { return JSON.parse(fs.readFileSync(rutaEstado(), 'utf8')); }
  catch { return {}; }
}

function guardar(datos) {
  fs.writeFileSync(rutaEstado(), JSON.stringify({ ...leer(), ...datos }, null, 2));
}

// ---------- Cuenta NO premium (offline) ----------
// UUID determinístico: así el server siempre reconoce al mismo jugador por su nombre.
function uuidOffline(nombre) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + nombre).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function authOffline(nombre) {
  const uuid = uuidOffline(nombre);
  return {
    access_token: uuid,
    client_token: uuid,
    uuid,
    name: nombre,
    user_properties: '{}',
    meta: { type: 'mojang', demo: false },
  };
}

// ---------- Cuenta premium (Microsoft) ----------
async function authPremium() {
  const auth = new Auth('select_account');
  const guardada = leer().sesionMs;
  let xbox = null;

  if (guardada) {
    try { xbox = await auth.refresh(guardada); } catch { xbox = null; }
  }
  if (!xbox) xbox = await auth.launch('electron'); // abre la ventana de login de Microsoft

  const token = await xbox.getMinecraft();
  const perfil = perfilDe(token);
  guardar({ sesionMs: xbox.save(), perfilMs: perfil });
  return { auth: token.mclc(), perfil };
}

// Nombre, uuid y skin activa de la cuenta Microsoft (para mostrarlos en el launcher).
function perfilDe(token) {
  const p = token.profile || {};
  const mc = token.mclc();
  const skins = p.skins || [];
  const activa = skins.find((s) => s.state === 'ACTIVE') || skins[0] || {};
  return {
    name: p.name || mc.name || 'Jugador',
    uuid: String(p.id || mc.uuid || '').replace(/-/g, ''),
    skin: activa.url || null,
    variant: activa.variant || 'CLASSIC',
  };
}


// ---------- Sección Cosméticos (se maneja desde un JSON en internet, sin tocar el launcher) ----------
const esHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const texto = (t, max) => (typeof t === 'string' ? t.trim().slice(0, max) : '');

// Baja una imagen y la devuelve como data URI (el launcher solo permite imágenes embebidas).
async function imagenComoDataUri(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const tipo = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(tipo)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 1.5 * 1024 * 1024) return null;
    return `data:${tipo};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function leerCosmeticos() {
  const proximamente = { activo: false };
  if (!config.remoto) return proximamente;
  try {
    const r = await fetch(config.remoto, { cache: 'no-store', headers: { 'User-Agent': 'La26Launcher/1.0' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return proximamente;
    const c = (await r.json()).cosmeticos;
    if (!c || c.activo !== true) return { activo: false, mensaje: texto(c && c.mensaje, 200) };

    const items = [];
    for (const it of (Array.isArray(c.items) ? c.items.slice(0, 24) : [])) {
      items.push({
        nombre: texto(it.nombre, 40),
        tipo: texto(it.tipo, 20),
        descripcion: texto(it.descripcion, 120),
        imagen: esHttps(it.imagen) ? await imagenComoDataUri(it.imagen) : null,
        enlace: esHttps(it.enlace) ? it.enlace : null,
        textoEnlace: texto(it.textoEnlace, 20) || 'Ver',
      });
    }
    return { activo: true, titulo: texto(c.titulo, 40), mensaje: texto(c.mensaje, 200), items };
  } catch { return proximamente; }
}

// ---------- Skins (para mostrar la cabeza del jugador en el launcher) ----------
const cacheSkins = new Map();   // clave -> data URI (solo se guardan los aciertos)
const hex32 = (u) => (typeof u === 'string' && /^[0-9a-f]{32}$/i.test(u.replace(/-/g, '')) ? u.replace(/-/g, '') : null);

async function jsonDe(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'La26Launcher/1.0' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function uuidDeNombre(nombre) {
  const bases = [
    'https://api.minecraftservices.com/minecraft/profile/lookup/name/',
    'https://api.mojang.com/users/profiles/minecraft/',
  ];
  for (const base of bases) {
    try {
      const d = await jsonDe(base + encodeURIComponent(nombre));
      if (d && d.id) return d.id;
    } catch { /* no existe o no responde: probamos con el siguiente */ }
  }
  return null;
}

async function urlSkinDeUuid(uuid) {
  const d = await jsonDe(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
  const prop = (d.properties || []).find((x) => x.name === 'textures');
  if (!prop) return null;
  const t = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
  return (t.textures && t.textures.SKIN && t.textures.SKIN.url) || null;
}

// Devuelve la skin como data URI (el launcher solo permite imágenes embebidas), o null si no se pudo.
async function skinComoDataUri({ nombre, uuid, url } = {}) {
  let skinUrl = typeof url === 'string' && /^https?:\/\/textures\.minecraft\.net\//.test(url) ? url.replace(/^http:/, 'https:') : null;
  const id = hex32(uuid);
  const nombreOk = typeof nombre === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(nombre);
  const clave = skinUrl || id || (nombreOk ? 'n:' + nombre.toLowerCase() : null);
  if (!clave) return null;
  if (cacheSkins.has(clave)) return cacheSkins.get(clave);

  let data = null;
  try {
    if (!skinUrl) {
      const u = id || (nombreOk ? await uuidDeNombre(nombre) : null);
      if (u) skinUrl = await urlSkinDeUuid(u);
      // Mojang devuelve la url con http://; la pasamos a https y solo aceptamos su servidor de texturas.
      if (skinUrl) skinUrl = /^https?:\/\/textures\.minecraft\.net\//.test(skinUrl) ? skinUrl.replace(/^http:/, 'https:') : null;
    }
    if (skinUrl) data = await imagenComoDataUri(skinUrl);
  } catch { data = null; }
  if (data) cacheSkins.set(clave, data);
  return data;
}

// ---------- Customizar skin (solo cuentas Microsoft: la skin se cambia en la cuenta de Mojang) ----------
const URL_SKINS = 'https://api.minecraftservices.com/minecraft/profile/skins';
let skinPendiente = null;   // { buf, nombre } del archivo elegido, todavía sin subir

function dimensionesPng(buf) {
  const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(firma) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20) };
}

function errorSkin(status) {
  if (status === 400) return 'Mojang rechazó la skin. Tiene que ser un PNG de 64x64 (o 64x32).';
  if (status === 401 || status === 403) return 'Tu sesión de Microsoft venció o no tiene permiso. Cerrá sesión y volvé a entrar.';
  if (status === 429) return 'Mojang pide esperar un rato antes de cambiar la skin otra vez. Probá en unos minutos.';
  return `Mojang no pudo cambiar la skin (error ${status}).`;
}

// Sube el PNG a la cuenta de Minecraft y devuelve el perfil actualizado que responde Mojang.
async function subirSkinAMojang(buf, variant, accessToken) {
  const form = new FormData();
  form.append('variant', variant === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
  const r = await fetch(URL_SKINS, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'User-Agent': 'La26Launcher/1.0' },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(errorSkin(r.status));
  return r.json().catch(() => ({}));
}

// ---------- Ventana ----------
function crearVentana() {
  win = new BrowserWindow({
    width: 960,
    height: 600,
    useContentSize: true,
    resizable: false,
    title: `${config.nombre} Client`,
    backgroundColor: '#0a0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
}

// ---------- Arranque: si hay una versión nueva, se actualiza sola antes de abrir (como Lunar) ----------
let ventanaActualizando = null;

function crearVentanaActualizando() {
  const w = new BrowserWindow({
    width: 420, height: 270, resizable: false, minimizable: false, maximizable: false, frame: false,
    center: true, show: false, backgroundColor: '#0a0d12', title: `${config.nombre} Launcher`,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  w.loadFile('actualizando.html');
  w.once('ready-to-show', () => w.show());
  // Mismo logo que el launcher (se saca del index.html para no repetirlo)
  w.webContents.once('did-finish-load', () => {
    try {
      const logo = /--logo:\s*(url\("data:image\/[^"]+"\))/.exec(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
      if (logo) w.webContents.executeJavaScript(`document.documentElement.style.setProperty('--logo', ${JSON.stringify(logo[1])})`).catch(() => {});
    } catch { /* sin logo se ve igual */ }
  });
  return w;
}

// Devuelve true si la actualización quedó en marcha (el launcher se cierra solo y se reabre con la versión nueva).
async function actualizarConVentana(info) {
  const w = crearVentanaActualizando();
  ventanaActualizando = w;
  const pintar = (n, t) => { if (!w.isDestroyed()) w.webContents.executeJavaScript(`setP(${n === null ? 'null' : Math.round(n)}, ${JSON.stringify(t || '')})`).catch(() => {}); };
  pintar(null, `Descargando la versión ${info.version}...`);
  try {
    await act.prepararReemplazo(info, (hecho, total) => pintar((hecho / total) * 100, `Descargando la versión ${info.version}... ${Math.round((hecho / total) * 100)}%`));
    pintar(100, 'Listo. Reiniciando...');
    setTimeout(() => app.quit(), 900);
    return true;
  } catch (err) {
    // Sin internet, sin permisos, etc.: se abre el launcher normal con la versión que ya tiene.
    actualizacionHallada = info;
    return false;
  }
}

async function arrancar() {
  act.limpiarRestos();
  const cfgAct = config.actualizaciones || {};
  if (cfgAct.automatica !== false && act.exeActual() && act.repoConfigurado(cfgAct.repo)) {
    try {
      const info = await act.buscarActualizacion({ repo: cfgAct.repo, actual: app.getVersion(), timeout: 4000 });
      if (info && await actualizarConVentana(info)) return;
    } catch { /* sin internet: se sigue sin actualizar */ }
  }
  crearVentana();
  // Recién ahora se cierra la ventanita de actualización (si no, "todas las ventanas cerradas" apagaría el launcher)
  if (ventanaActualizando && !ventanaActualizando.isDestroyed()) ventanaActualizando.destroy();
}

app.whenReady().then(arrancar);
let ventanaCerradaAProposito = false;
app.on('window-all-closed', () => {
  if (!ventanaCerradaAProposito) app.quit();
});

// ---------- IPC ----------
ipcMain.handle('config', () => ({
  ...config,
  guardado: leer(),
  ramTotalGB: os.totalmem() / 1024 ** 3,
  ramAutoGB: parseInt(ramAutomatica(), 10),
  appVersion: app.getVersion(),
  actualizacionesActivas: act.repoConfigurado((config.actualizaciones || {}).repo),
  esPortable: !!act.exeActual(),
}));

ipcMain.handle('cosmeticos', () => leerCosmeticos());

ipcMain.handle('abrir-enlace', (_e, url) => { if (esHttps(url)) shell.openExternal(url); });

// Engranaje: abre la carpeta de mods de la versión elegida (la crea si todavía no existe).
ipcMain.handle('abrir-mods', async (_e, { version, loader } = {}) => {
  try {
    const { v, loader: l } = resolverSeleccion(version, loader);
    const { gameDir } = carpetaDeJuego(v, l);
    const mods = path.join(gameDir, 'mods');
    fs.mkdirSync(mods, { recursive: true });
    const error = await shell.openPath(mods); // devuelve '' si salió bien
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});


// ---------- Herramientas (sección del launcher) ----------
const CARPETAS = { mods: 'mods', mundos: 'saves', capturas: 'screenshots' };

// Abre una carpeta de la versión elegida (la crea si todavía no existe).
ipcMain.handle('abrir-carpeta', async (_e, { tipo, version, loader } = {}) => {
  try {
    const { gameDir, root } = seleccion({ version, loader });
    const carpeta = tipo === 'backups' ? path.join(root, 'backups') : CARPETAS[tipo] && path.join(gameDir, CARPETAS[tipo]);
    if (!carpeta) return { ok: false, error: 'Carpeta desconocida.' };
    fs.mkdirSync(carpeta, { recursive: true });
    const error = await shell.openPath(carpeta);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('backup-mundos', async (_e, datos) => {
  if (jugando) return { ok: false, error: 'Esperá a que el juego termine de abrir.' };
  try {
    const s = seleccion(datos);
    return await herr.respaldarMundos({ root: s.root, gameDir: s.gameDir, etiqueta: s.etiqueta });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('abrir-log', async (_e, datos) => {
  try {
    const archivo = herr.logParaAbrir(seleccion(datos).gameDir);
    if (!archivo) return { ok: false, error: 'Todavía no hay log: abrí el juego una vez.' };
    const error = await shell.openPath(archivo);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Copia al portapapeles un reporte (versión, sistema y final de los logs) para mandárselo al admin.
ipcMain.handle('copiar-reporte', (_e, datos) => {
  try {
    const s = seleccion(datos);
    const cabecera = [
      `${config.nombre} Launcher ${app.getVersion()}`,
      `Minecraft ${s.mc} · ${s.loader}`,
      herr.infoSistema(),
    ];
    clipboard.writeText(herr.armarReporte({ gameDir: s.gameDir, cabecera }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('reparar', async (_e, datos) => {
  if (jugando) return { ok: false, error: 'Esperá a que el juego termine de abrir.' };
  try {
    const s = seleccion(datos);
    const r = await herr.repararInstalacion({ root: s.root, gameDir: s.gameDir, mc: s.mc, javaRequerido: s.v.java || 21 });
    herr.agregarLog(s.gameDir, `[launcher] Reparación: se borró ${r.borrado.join(', ') || 'nada'}.`);
    return r;
  } catch (err) {
    return { ok: false, error: 'No se pudo reparar: ' + (err.message || err) };
  }
});

ipcMain.handle('estado-java', (_e, datos) => {
  try {
    const s = seleccion(datos);
    const req = s.v.java || 21;
    return { requerido: req, ...estadoJava({ requerido: req, base: s.root, javaPathCfg: req === 21 ? config.javaPath : null }) };
  } catch (err) {
    return { requerido: null, listo: false, origen: 'error' };
  }
});

// ---------- Actualización del launcher ----------
ipcMain.handle('buscar-actualizacion', async () => {
  try {
    actualizacionHallada = await act.buscarActualizacion({ repo: (config.actualizaciones || {}).repo, actual: app.getVersion() });
  } catch { actualizacionHallada = null; }
  const a = actualizacionHallada;
  return a ? { version: a.version, notas: a.notas, tam: a.tam } : null;
});

ipcMain.handle('actualizar', async () => {
  if (jugando) return { ok: false, error: 'Esperá a que el juego termine de abrir.' };
  if (!actualizacionHallada) return { ok: false, error: 'No hay ninguna actualización pendiente.' };
  try {
    await act.prepararReemplazo(actualizacionHallada, (hecho, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('actualizando', { hecho, total });
    });
    setTimeout(() => app.quit(), 400);   // al cerrarse, el script reemplaza el .exe y lo vuelve a abrir
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Engranaje: guarda la RAM elegida para cada versión + loader.
ipcMain.handle('guardar-ram', (_e, { key, valor } = {}) => {
  const valida = valor === 'auto' || (typeof valor === 'number' && valor >= 1 && valor <= 64);
  if (typeof key !== 'string' || !key || key.length > 60 || !valida) return false;
  guardar({ ramPorVersion: { ...(leer().ramPorVersion || {}), [key]: valor } });
  return true;
});

// Cuenta (arriba a la derecha): entrar con Microsoft sin tener que darle INICIAR.
ipcMain.handle('iniciar-sesion-ms', async () => {
  if (jugando) return { ok: false, error: 'Esperá a que el juego termine de abrir.' };
  try {
    const { perfil } = await authPremium();
    return { ok: true, perfil };
  } catch (err) {
    const t = String((err && err.message) || err);
    return { ok: false, error: /closed/i.test(t) ? 'Cerraste la ventana de Microsoft antes de terminar.' : 'No se pudo iniciar sesión con Microsoft: ' + t };
  }
});

// Guarda qué cuenta está usando (premium / no premium) y el nick.
ipcMain.handle('guardar-cuenta', (_e, { modo, usuario } = {}) => {
  const datos = {};
  if (modo === 'premium' || modo === 'no-premium') datos.modo = modo;
  if (typeof usuario === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(usuario)) datos.usuario = usuario;
  guardar(datos);
  return true;
});

ipcMain.handle('skin', (_e, datos) => skinComoDataUri(datos || {}));

// Customizar skin: abre el selector de archivos y valida que sea un PNG de skin.
ipcMain.handle('elegir-skin', async () => {
  try {
    const opciones = { title: 'Elegí tu skin', filters: [{ name: 'Skin (PNG)', extensions: ['png'] }], properties: ['openFile'] };
    const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opciones) : await dialog.showOpenDialog(opciones);
    if (r.canceled || !r.filePaths.length) return { ok: false, cancelado: true };
    const archivo = r.filePaths[0];
    if (fs.statSync(archivo).size > 1024 * 1024) return { ok: false, error: 'Ese archivo es muy grande para ser una skin.' };
    const buf = fs.readFileSync(archivo);
    const dim = dimensionesPng(buf);
    if (!dim) return { ok: false, error: 'Ese archivo no es un PNG válido.' };
    if (dim.ancho !== 64 || (dim.alto !== 64 && dim.alto !== 32)) {
      return { ok: false, error: `La skin tiene que medir 64x64 (o 64x32). Esta mide ${dim.ancho}x${dim.alto}.` };
    }
    skinPendiente = { buf, nombre: path.basename(archivo) };
    return { ok: true, nombre: skinPendiente.nombre, data: 'data:image/png;base64,' + buf.toString('base64') };
  } catch (err) {
    return { ok: false, error: 'No se pudo leer el archivo: ' + (err.message || err) };
  }
});

// Customizar skin: sube la skin elegida a la cuenta de Microsoft (se ve en el juego y en cualquier server).
ipcMain.handle('aplicar-skin', async (_e, { variant } = {}) => {
  if (!skinPendiente) return { ok: false, error: 'Primero elegí un archivo de skin.' };
  if (jugando) return { ok: false, error: 'Esperá a que el juego termine de abrir.' };
  try {
    const { auth, perfil: actual } = await authPremium();   // renueva la sesión (si venció, vuelve a pedir el login)
    const res = await subirSkinAMojang(skinPendiente.buf, variant, auth.access_token);
    const skins = res.skins || [];
    const activa = skins.find((s) => s.state === 'ACTIVE') || skins[0] || {};
    const perfil = { ...actual, skin: activa.url || actual.skin, variant: activa.variant || (variant === 'slim' ? 'SLIM' : 'CLASSIC') };
    guardar({ perfilMs: perfil });
    const skinData = 'data:image/png;base64,' + skinPendiente.buf.toString('base64');
    skinPendiente = null;
    return { ok: true, perfil, skinData };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('cerrar-sesion', () => {
  guardar({ sesionMs: null, perfilMs: null });
  return true;
});

let gameDirLog = null;   // para dejar los errores del launcher en launcher.log

ipcMain.handle('play', async (_e, { modo, usuario, ram, version: idSel, loader: loaderSel }) => {
  if (jugando) return { ok: false, error: 'El juego ya se está abriendo.' };
  const enviar = (canal, datos) => win && !win.isDestroyed() && win.webContents.send(canal, datos);

  try {
    jugando = true;
    let authorization;
    gameDirLog = null;

    if (modo === 'premium') {
      enviar('estado', 'Iniciando sesión con Microsoft...');
      const ms = await authPremium();
      authorization = ms.auth;
      enviar('cuenta', ms.perfil);   // el launcher actualiza el nombre y la skin de arriba a la derecha
    } else {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(usuario || '')) {
        throw new Error('Nombre inválido: de 3 a 16 caracteres, solo letras, números y _');
      }
      authorization = authOffline(usuario);
    }

    const { v, loader, cfgLoader } = resolverSeleccion(idSel, loaderSel);
    guardar({ modo, usuario, version: v.id, loader });

    // root = librerías y assets compartidos. gameDir = mods, mundos y opciones de ESTA versión + loader.
    const { root, gameDir } = carpetaDeJuego(v, loader);
    fs.mkdirSync(gameDir, { recursive: true });
    gameDirLog = gameDir;
    herr.recortarLog(gameDir);
    herr.agregarLog(gameDir, `\n===== ${new Date().toLocaleString()} · ${config.nombre} Launcher ${app.getVersion()} · Minecraft ${v.mc || v.id} (${loader}) =====`);

    const version = { number: v.mc || v.id, type: 'release' };
    const javaRequerido = v.java || 21;

    // Java de esta versión (1.7.10 -> 8, 1.21.x -> 21, 26.x -> 25). Si la PC no lo tiene, se descarga solo.
    const javaExe = await asegurarJava({
      requerido: javaRequerido,
      base: root,
      javaPathCfg: javaRequerido === 21 ? config.javaPath : null,
      enviar,
    });

    // Loader
    if (loader === 'fabric') {
      enviar('estado', 'Preparando Fabric...');
      version.custom = await prepararFabric({
        root,
        mc: version.number,
        loader: (config.loader || {}).version || 'latest',
        onEstado: (t) => enviar('estado', t),
      });
    } else {
      version.custom = await prepararForge({
        tipo: loader,
        root,
        mc: version.number,
        javaExe,
        onEstado: (t) => enviar('estado', t),
        onLog: (l) => enviar('log', l),
      });
    }

    // Mods: se actualizan antes de abrir el juego. Si falla, no se entra con mods desactualizados.
    const modrinth = cfgLoader.modrinth || [];
    if (cfgLoader.manifestUrl || modrinth.length > 0) {
      try {
        const r = await sincronizarMods({
          manifestUrl: cfgLoader.manifestUrl,
          carpetaJuego: gameDir,
          borrarExtras: cfgLoader.borrarExtras !== false,
          modrinth,
          mc: version.number,
          loader,
          onEstado: (t) => enviar('estado', t),
          onProgreso: (hechos, total) => enviar('progreso', { tarea: hechos, total, tipo: 'mods' }),
        });
        r.avisos.forEach((a) => enviar('log', 'AVISO: ' + a));
      } catch (err) {
        throw new Error('No se pudieron actualizar los mods: ' + (err.message || err));
      }
    }

    const launcher = new Client();
    const opciones = {
      authorization,
      root,
      version,
      memory: { max: resolverRam(ram || config.ramPorDefecto), min: '1G' },
      customArgs: config.jvmArgs || JVM_POR_DEFECTO,
      detached: true,
    };
    if (gameDir !== root) opciones.overrides = { gameDirectory: gameDir };
    // Entrar directo al server (solo en las versiones que tienen server)
    if (config.entrarDirecto !== false && v.servidor) {
      opciones.customLaunchArgs = ['--quickPlayMultiplayer', `${config.server.host}:${config.server.port}`];
    }
    opciones.javaPath = javaExe;
    if ((config.optimizacion || {}).opcionesIniciales !== false) escribirOpcionesIniciales(gameDir);

    launcher.on('progress', (e) => {
      if (e.total) enviar('progreso', { tarea: e.task, total: e.total, tipo: e.type });
    });
    launcher.on('package-extract', () => enviar('estado', 'Extrayendo archivos...'));
    let ventanaCerrada = false;
    launcher.on('data', (linea) => {
      const texto = String(linea);
      enviar('log', texto);
      herr.agregarLog(gameDir, texto);
      // Cuando el juego ya está creando su ventana, cerramos la del launcher para liberar memoria
      if (!ventanaCerrada && config.cerrarVentanaAlJugar !== false && /LWJGL|Backend library/.test(texto) && win && !win.isDestroyed()) {
        ventanaCerrada = true;
        ventanaCerradaAProposito = true;
        win.destroy();
      }
    });
    launcher.on('debug', (linea) => enviar('log', String(linea)));
    launcher.on('close', (codigo) => {
      jugando = false;
      enviar('cerrado', codigo);
      if (ventanaCerradaAProposito) app.quit();
    });

    enviar('estado', 'Descargando y preparando el juego...');
    const proceso = await launcher.launch(opciones);
    if (!proceso) throw new Error('No se pudo iniciar Minecraft. Revisá el log en la carpeta del juego (launcher.log).');

    enviar('estado', '¡Jugando!');
    return { ok: true };
  } catch (err) {
    jugando = false;
    if (gameDirLog) herr.agregarLog(gameDirLog, `[launcher] ERROR: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  }
});