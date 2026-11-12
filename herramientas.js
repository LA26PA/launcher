// Herramientas del launcher: backups de mundos, reparación, logs y reporte de errores.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const MAX_LOG = 2 * 1024 * 1024;          // el log se recorta cuando pasa de 2 MB
const BACKUPS_A_GUARDAR = 5;              // por versión + loader

const existe = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const dosDigitos = (n) => String(n).padStart(2, '0');

function correr(cmd, args, opciones = {}) {
  return new Promise((ok, fallo) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...opciones }, (err, _out, errOut) => {
      if (err) { err.detalle = String(errOut || '').trim(); fallo(err); } else ok();
    });
  });
}

// ---------- Logs ----------
const archivoLog = (gameDir) => path.join(gameDir, 'launcher.log');

function agregarLog(gameDir, texto) {
  try {
    fs.mkdirSync(gameDir, { recursive: true });
    fs.appendFileSync(archivoLog(gameDir), texto + '\n');
  } catch { /* el log es opcional */ }
}

// Si el log creció demasiado, se queda con la última parte (así no ocupa cada vez más).
function recortarLog(gameDir) {
  const f = archivoLog(gameDir);
  try {
    if (fs.statSync(f).size <= MAX_LOG) return;
    const buf = fs.readFileSync(f);
    fs.writeFileSync(f, buf.subarray(buf.length - Math.floor(MAX_LOG / 2)));
  } catch { /* no hay log todavía */ }
}

// Últimas "lineas" líneas de un archivo (lee solo el final, así no carga logs enormes).
function ultimasLineas(archivo, lineas = 250, bytes = 256 * 1024) {
  try {
    const fd = fs.openSync(archivo, 'r');
    const tam = fs.fstatSync(fd).size;
    const largo = Math.min(tam, bytes);
    const buf = Buffer.alloc(largo);
    fs.readSync(fd, buf, 0, largo, tam - largo);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).slice(-lineas).join('\n').trim();
  } catch { return ''; }
}

// Archivo de log que conviene abrir: el del launcher, o el log propio de Minecraft.
function logParaAbrir(gameDir) {
  const candidatos = [archivoLog(gameDir), path.join(gameDir, 'logs', 'latest.log')];
  return candidatos.find((c) => existe(c)) || null;
}

// Texto para pegar en Discord / WhatsApp cuando algo falla.
function armarReporte({ gameDir, cabecera }) {
  const partes = [cabecera.join('\n')];
  const log = ultimasLineas(archivoLog(gameDir));
  if (log) partes.push('--- launcher.log (final) ---\n' + log);
  const latest = ultimasLineas(path.join(gameDir, 'logs', 'latest.log'), 80);
  if (latest) partes.push('--- logs/latest.log (final) ---\n' + latest);
  if (!log && !latest) partes.push('(todavía no hay logs: probá abrir el juego una vez)');
  return partes.join('\n\n');
}

function infoSistema() {
  return `SO: ${os.type()} ${os.release()} (${os.arch()}) · RAM total: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`;
}

// ---------- Backups de mundos ----------
async function zipear(carpetaBase, nombreCarpeta, destino) {
  if (process.platform === 'win32') {
    try {   // tar.exe viene con Windows 10/11 y también sabe hacer .zip
      await correr('tar', ['-a', '-c', '-f', destino, '-C', carpetaBase, nombreCarpeta]);
      return;
    } catch { fs.rmSync(destino, { force: true }); }
    const q = (t) => t.replace(/'/g, "''");
    await correr('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath '${q(path.join(carpetaBase, nombreCarpeta))}' -DestinationPath '${q(destino)}' -Force`]);
    return;
  }
  await correr('zip', ['-r', '-q', destino, nombreCarpeta], { cwd: carpetaBase });
}

function tamanoMB(archivo) {
  try { return Math.max(0.1, fs.statSync(archivo).size / 1024 / 1024); } catch { return 0; }
}

// Copia comprimida de la carpeta saves/ de esta versión. Guarda solo las últimas BACKUPS_A_GUARDAR.
async function respaldarMundos({ root, gameDir, etiqueta }) {
  const saves = path.join(gameDir, 'saves');
  let mundos = [];
  try { mundos = fs.readdirSync(saves); } catch { /* no existe */ }
  if (!mundos.length) return { ok: false, error: 'Todavía no hay mundos guardados en esta versión.' };

  const carpeta = path.join(root, 'backups');
  fs.mkdirSync(carpeta, { recursive: true });
  const d = new Date();
  const fecha = `${d.getFullYear()}-${dosDigitos(d.getMonth() + 1)}-${dosDigitos(d.getDate())}_${dosDigitos(d.getHours())}-${dosDigitos(d.getMinutes())}`;
  const segura = etiqueta.replace(/[^A-Za-z0-9._-]/g, '_');
  const destino = path.join(carpeta, `${segura}_${fecha}.zip`);

  try {
    await zipear(gameDir, 'saves', destino);
  } catch (err) {
    fs.rmSync(destino, { force: true });
    return { ok: false, error: 'No se pudo crear el backup' + (err.detalle ? ': ' + err.detalle : '.') };
  }
  if (!existe(destino)) return { ok: false, error: 'No se pudo crear el backup.' };

  // Borra los más viejos de esta misma versión
  try {
    const propios = fs.readdirSync(carpeta).filter((f) => f.startsWith(segura + '_') && f.endsWith('.zip')).sort();
    for (const f of propios.slice(0, Math.max(0, propios.length - BACKUPS_A_GUARDAR))) fs.rmSync(path.join(carpeta, f), { force: true });
  } catch { /* limpiar es opcional */ }

  return { ok: true, ruta: destino, nombre: path.basename(destino), mb: tamanoMB(destino), mundos: mundos.length };
}

// ---------- Reparar ----------
const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Borra lo que se vuelve a descargar solo al darle Jugar. NO toca mundos, opciones, skins ni configuración.
async function repararInstalacion({ root, gameDir, mc, javaRequerido }) {
  const borrado = [];
  const sacar = async (p, nombre) => {
    if (!existe(p)) return;
    await fs.promises.rm(p, { recursive: true, force: true });
    borrado.push(nombre);
  };

  // Mods (.jar): se vuelven a bajar de Modrinth / del manifest
  const mods = path.join(gameDir, 'mods');
  if (existe(mods)) {
    let jars = 0;
    for (const f of fs.readdirSync(mods)) {
      if (/\.(jar|tmp)$/i.test(f)) { fs.rmSync(path.join(mods, f), { force: true }); jars++; }
    }
    if (jars) borrado.push(`${jars} mods`);
  }

  // Instalación de esta versión de Minecraft + loader (Fabric / Forge)
  const versiones = path.join(root, 'versions');
  if (existe(versiones)) {
    const patron = new RegExp(`(^|-)${escapar(mc)}($|-)`);
    for (const d of fs.readdirSync(versiones)) {
      if (patron.test(d)) await sacar(path.join(versiones, d), `versión ${d}`);
    }
  }

  await sacar(path.join(root, 'libraries'), 'librerías');
  if (javaRequerido) await sacar(path.join(root, 'java' + javaRequerido), `Java ${javaRequerido} descargado`);
  return { ok: true, borrado };
}

module.exports = {
  agregarLog, recortarLog, logParaAbrir, armarReporte, infoSistema,
  respaldarMundos, repararInstalacion, existe,
};
