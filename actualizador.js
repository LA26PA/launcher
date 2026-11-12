// Actualización automática del launcher desde GitHub Releases.
//
// OJO: electron-updater NO funciona con el formato "portable" (el .exe suelto), así que acá hay un actualizador
// propio: mira la última Release del repo, baja el .exe nuevo al lado del actual y, al cerrar el launcher, un
// script lo reemplaza y lo vuelve a abrir. Los datos del jugador (nick, sesión, RAM) no se tocan: viven en %APPDATA%.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CABECERAS = { 'User-Agent': 'La26Launcher', Accept: 'application/vnd.github+json' };
const REPO_OK = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// 1 si a > b, -1 si a < b, 0 si son iguales. Acepta "v1.2.3".
function comparar(a, b) {
  const partes = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = partes(a);
  const y = partes(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const repoConfigurado = (repo) => typeof repo === 'string' && REPO_OK.test(repo) && !/TU_|TU-/i.test(repo);

// Devuelve { version, notas, url, nombre, tam, sha256 } si hay una versión más nueva, o null si no.
async function buscarActualizacion({ repo, actual, timeout = 8000 }) {
  if (!repoConfigurado(repo)) return null;
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: CABECERAS, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) return null;   // 404 = todavía no hay ninguna Release
  const rel = await r.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  if (!version || comparar(version, actual) <= 0) return null;

  const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name || '') && !/blockmap/i.test(a.name));
  if (!asset || !/^https:\/\/github\.com\//.test(asset.browser_download_url || '')) return null;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  return {
    version,
    notas: String(rel.body || '').trim().slice(0, 500),
    url: asset.browser_download_url,
    nombre: asset.name,
    tam: asset.size || 0,
    sha256: sha ? sha[1].toLowerCase() : null,
  };
}

// Baja el archivo a "destino" con progreso. Verifica el sha256 si GitHub lo informa.
async function descargarExe({ url, destino, sha256, onProgreso }) {
  const r = await fetch(url, { headers: { 'User-Agent': 'La26Launcher' }, redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`No se pudo descargar la actualización (error ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const salida = fs.createWriteStream(destino);
  let hecho = 0;
  try {
    for await (const trozo of r.body) {
      hash.update(trozo);
      hecho += trozo.length;
      if (!salida.write(trozo)) await new Promise((ok) => salida.once('drain', ok));
      if (total) onProgreso(hecho, total);
    }
    await new Promise((ok, fallo) => { salida.on('error', fallo); salida.end(ok); });
  } catch (err) {
    salida.destroy();
    fs.rmSync(destino, { force: true });
    throw err;
  }
  if (sha256 && hash.digest('hex') !== sha256) {
    fs.rmSync(destino, { force: true });
    throw new Error('La actualización llegó dañada (no coincide el hash). Probá de nuevo.');
  }
  const cabecera = Buffer.alloc(2);
  const fd = fs.openSync(destino, 'r');
  fs.readSync(fd, cabecera, 0, 2, 0);
  fs.closeSync(fd);
  if (hecho < 1024 * 1024 || cabecera.toString('latin1') !== 'MZ') {
    fs.rmSync(destino, { force: true });
    throw new Error('El archivo descargado no es un .exe válido.');
  }
}

// Ruta del .exe portable que está corriendo (null si no es el .exe: modo desarrollo o instalado).
const exeActual = () => (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) || null;

// Borra restos de una actualización que quedó a medias.
function limpiarRestos() {
  const exe = exeActual();
  if (exe) { try { fs.rmSync(exe + '.nuevo', { force: true }); } catch { /* da igual */ } }
}

// Descarga la versión nueva y deja programado el reemplazo. Después hay que cerrar el launcher (app.quit()).
async function prepararReemplazo(info, onProgreso) {
  const exe = exeActual();
  if (!exe) throw new Error('La actualización automática solo funciona desde el .exe (no con npm start).');
  const nuevo = exe + '.nuevo';
  try {
    await descargarExe({ url: info.url, destino: nuevo, sha256: info.sha256, onProgreso });
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      throw new Error('No tengo permiso para escribir en la carpeta donde está el launcher. Movelo a otra carpeta (por ejemplo el Escritorio).');
    }
    throw err;
  }

  // Espera a que el launcher cierre, reemplaza el .exe y lo vuelve a abrir (hasta ~90 s de intentos).
  const script = path.join(os.tmpdir(), `la26-actualizar-${process.pid}.cmd`);
  const q = (p) => p.replace(/"/g, '');
  fs.writeFileSync(script, [
    '@echo off',
    'set /a n=0',
    ':reintentar',
    'set /a n+=1',
    'if %n% gtr 90 exit /b 1',
    'ping -n 2 127.0.0.1 >nul',
    `move /Y "${q(nuevo)}" "${q(exe)}" >nul 2>&1`,
    'if errorlevel 1 goto reintentar',
    `start "" "${q(exe)}"`,
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n'));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(PORTABLE_EXECUTABLE|ELECTRON_)/.test(k)) delete env[k];
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
}

module.exports = { descargarExe, buscarActualizacion, prepararReemplazo, limpiarRestos, comparar, exeActual, repoConfigurado };
