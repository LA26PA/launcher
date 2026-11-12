const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

// jdk-21.0.3 -> 21 | jdk1.8.0_401 -> 8 | jre-1.8 -> 8 | zulu25.30-ca-jdk25 -> 25
function mayorDeNombre(nombre) {
  const m = /(?:1\.)?(\d+)/.exec(nombre);
  return m ? Number(m[1]) : 0;
}

// Versión mayor real de un java.exe (0 si no existe o no responde).
function mayorDeExe(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8' });
    const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr || ''}${r.stdout || ''}`);
    if (!m) return 0;
    return Number(m[1]) === 1 ? Number(m[2] || 0) : Number(m[1]);
  } catch { return 0; }
}

// Java 8 tiene que ser exactamente el 8 (1.7.10 + Forge no arranca en Java más nuevos). El resto: esa versión o mayor.
const cumple = (mayor, requerido) => (requerido <= 8 ? mayor === 8 : mayor >= requerido);

function buscarJava(requerido, javaPathCfg) {
  const candidatos = [];
  if (javaPathCfg) candidatos.push(javaPathCfg);
  if (process.env.JAVA_HOME) candidatos.push(path.join(process.env.JAVA_HOME, 'bin', EXE));
  const bases = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);
  const marcas = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru', 'Eclipse Foundation'];
  for (const base of bases) {
    for (const marca of marcas) {
      const dir = path.join(base, marca);
      let carpetas = [];
      try { carpetas = fs.readdirSync(dir); } catch { continue; }
      for (const c of carpetas) {
        if (cumple(mayorDeNombre(c), requerido)) candidatos.push(path.join(dir, c, 'bin', EXE));
      }
    }
  }
  return candidatos.find((c) => { try { return fs.existsSync(c) && cumple(mayorDeExe(c), requerido); } catch { return false; } }) || null;
}

// Descarga un archivo siguiendo redirecciones. alProgreso(bytesHechos, bytesTotales).
function descargar(url, destino, alProgreso = () => {}, redirecciones = 0) {
  return new Promise((resolve, reject) => {
    if (redirecciones > 6) return reject(new Error('Demasiadas redirecciones al descargar.'));
    const cliente = url.startsWith('http:') ? http : https;
    cliente.get(url, { headers: { 'User-Agent': 'La26-Launcher' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(descargar(new URL(res.headers.location, url).toString(), destino, alProgreso, redirecciones + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`No se pudo descargar (error ${res.statusCode}): ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let hecho = 0;
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      const salida = fs.createWriteStream(destino);
      res.on('data', (trozo) => { hecho += trozo.length; alProgreso(hecho, total); });
      res.on('error', reject);
      salida.on('error', reject);
      salida.on('finish', () => resolve());
      res.pipe(salida);
    }).on('error', reject);
  });
}

// Busca bin/java.exe en la carpeta (o en una subcarpeta, como jdk-21.x-jre/).
function exeEnCarpeta(dir) {
  const directo = path.join(dir, 'bin', EXE);
  try { if (fs.existsSync(directo)) return directo; } catch { /* sigue */ }
  try {
    for (const c of fs.readdirSync(dir)) {
      const p = path.join(dir, c, 'bin', EXE);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* la carpeta no existe todavía */ }
  return null;
}

function descomprimir(zip, destino) {
  fs.mkdirSync(destino, { recursive: true });
  // tar.exe viene con Windows 10/11 y es rápido; si falla, PowerShell.
  let r = spawnSync('tar', ['-xf', zip, '-C', destino], { encoding: 'utf8' });
  if (r.status === 0) return;
  const q = (t) => t.replace(/'/g, "''");
  r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(destino)}' -Force`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`No se pudo descomprimir Java: ${(r.stderr || '').trim()}`);
}

// Devuelve la ruta de un Java que sirva para la versión pedida. Si la PC no tiene ninguno, lo descarga (solo la primera vez).
async function asegurarJava({ requerido, base, javaPathCfg, enviar }) {
  const instalado = buscarJava(requerido, javaPathCfg);
  if (instalado) return instalado;

  const carpeta = path.join(base, 'java' + requerido);
  const propio = exeEnCarpeta(carpeta);
  if (propio) return propio;
  if (cumple(mayorDeExe('java'), requerido)) return 'java';

  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`No encontré Java ${requerido}. Instalalo desde https://adoptium.net y volvé a abrir el launcher.`);
  }
  const url = `https://api.adoptium.net/v3/binary/latest/${requerido}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  fs.mkdirSync(carpeta, { recursive: true });
  const zip = path.join(carpeta, `java${requerido}.zip`);
  try {
    enviar('estado', `Descargando Java ${requerido} (solo la primera vez)...`);
    await descargar(url, zip, (hecho, total) => { if (total) enviar('progreso', { tarea: hecho, total, tipo: 'java' }); });
    enviar('estado', `Instalando Java ${requerido}...`);
    descomprimir(zip, carpeta);
  } catch (err) {
    fs.rmSync(carpeta, { recursive: true, force: true });   // que el próximo intento empiece limpio
    throw err;
  }
  fs.rmSync(zip, { force: true });
  const exe = exeEnCarpeta(carpeta);
  if (!exe) throw new Error(`Java ${requerido} se descargó pero no encontré java.exe. Probá de nuevo o instalalo desde https://adoptium.net`);
  return exe;
}

// Para mostrar en el launcher si Java ya está listo o se va a descargar (no descarga nada).
function estadoJava({ requerido, base, javaPathCfg }) {
  if (buscarJava(requerido, javaPathCfg)) return { listo: true, origen: 'sistema' };
  if (exeEnCarpeta(path.join(base, 'java' + requerido))) return { listo: true, origen: 'launcher' };
  if (cumple(mayorDeExe('java'), requerido)) return { listo: true, origen: 'sistema' };
  return { listo: false, origen: process.platform === 'win32' && process.arch === 'x64' ? 'descarga' : 'manual' };
}

module.exports = { estadoJava, asegurarJava, descargar, mayorDeNombre, mayorDeExe, cumple, buscarJava };
