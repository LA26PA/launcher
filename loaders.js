const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { descargar } = require('./java');

const CABECERAS = { 'User-Agent': 'La26Launcher/1.0 (launcher privado para un server de amigos)' };
const MANIFEST_MC = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function leerTexto(url) {
  const r = await fetch(url, { headers: CABECERAS });
  if (!r.ok) throw new Error(`No se pudo leer ${url} (HTTP ${r.status})`);
  return r.text();
}

const versionesDeMaven = (xml) => [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);

// Compara versiones por sus números: 10.13.4.1614 < 10.13.4.1614.1
function comparar(a, b) {
  const x = a.split(/\D+/).filter(Boolean).map(Number);
  const y = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return x.length - y.length;
}
const masNueva = (lista) => lista.slice().sort(comparar).pop();

// Busca el instalador más nuevo de Forge / NeoForge para esa versión de Minecraft.
async function resolverInstalador(tipo, mc) {
  if (tipo === 'forge') {
    const xml = await leerTexto('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
    const lista = versionesDeMaven(xml).filter((v) => v.startsWith(mc + '-'));
    if (!lista.length) throw new Error(`Todavía no existe Forge para Minecraft ${mc}.`);
    const v = masNueva(lista);
    return { version: v, url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar` };
  }
  if (tipo === 'neoforge') {
    const xml = await leerTexto('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const prefijo = (mc.startsWith('1.') ? mc.slice(2) : mc) + '.';   // 1.21.11 -> 21.11. | 26.3 -> 26.3.
    const todas = versionesDeMaven(xml).filter((v) => v.startsWith(prefijo));
    if (!todas.length) throw new Error(`Todavía no existe NeoForge para Minecraft ${mc}.`);
    const estables = todas.filter((v) => !v.includes('-'));
    const v = masNueva(estables.length ? estables : todas);
    return { version: v, url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar` };
  }
  throw new Error(`Loader desconocido: ${tipo}`);
}

// Los instaladores de Forge/NeoForge necesitan que la versión base de Minecraft ya esté descargada.
async function asegurarVanilla(root, mc) {
  const dir = path.join(root, 'versions', mc);
  const json = path.join(dir, `${mc}.json`);
  const jar = path.join(dir, `${mc}.jar`);
  if (fs.existsSync(json) && fs.existsSync(jar)) return;

  const lista = JSON.parse(await leerTexto(MANIFEST_MC));
  const v = (lista.versions || []).find((x) => x.id === mc);
  if (!v) throw new Error(`Minecraft ${mc} no figura en el listado de Mojang.`);
  const meta = JSON.parse(await leerTexto(v.url));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(json, JSON.stringify(meta));
  await descargar(meta.downloads.client.url, jar);
}

function correrInstalador(javaExe, jar, root, alLog) {
  return new Promise((resolve, reject) => {
    const p = spawn(javaExe, ['-jar', jar, '--installClient', root], { windowsHide: true });
    let cola = [];
    const manejar = (d) => {
      for (const l of String(d).split(/\r?\n/)) {
        if (!l.trim()) continue;
        cola = [...cola.slice(-4), l.trim()];
        alLog(l.trim());
      }
    };
    p.stdout.on('data', manejar);
    p.stderr.on('data', manejar);
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`El instalador falló (código ${c}): ${cola.join(' | ')}`))));
  });
}

const carpetasDeVersiones = (root) => {
  try { return fs.readdirSync(path.join(root, 'versions')); } catch { return []; }
};

// Instala Forge o NeoForge una sola vez y devuelve el id de la versión para usarla como "custom".
async function prepararForge({ tipo, root, mc, javaExe, onEstado = () => {}, onLog = () => {} }) {
  const marca = path.join(root, `loader-${tipo}-${mc}.json`);
  try {
    const { id } = JSON.parse(fs.readFileSync(marca, 'utf8'));
    if (id && fs.existsSync(path.join(root, 'versions', id, `${id}.json`))) return id;
  } catch { /* hay que instalarlo */ }

  const nombre = tipo === 'neoforge' ? 'NeoForge' : 'Forge';
  onEstado(`Buscando ${nombre} para Minecraft ${mc}...`);
  const inst = await resolverInstalador(tipo, mc);

  onEstado(`Preparando Minecraft ${mc}...`);
  await asegurarVanilla(root, mc);
  const perfiles = path.join(root, 'launcher_profiles.json');
  if (!fs.existsSync(perfiles)) fs.writeFileSync(perfiles, JSON.stringify({ profiles: {} }));

  const jar = path.join(root, 'instaladores', `${tipo}-${inst.version}-installer.jar`);
  if (!fs.existsSync(jar)) {
    onEstado(`Descargando ${nombre} ${inst.version}...`);
    await descargar(inst.url, jar);
  }

  onEstado(`Instalando ${nombre} (puede tardar unos minutos la primera vez)...`);
  const antes = new Set(carpetasDeVersiones(root));
  await correrInstalador(javaExe, jar, root, (l) => { onLog(l); onEstado(`Instalando ${nombre}: ${l.slice(0, 80)}`); });

  const esDelTipo = (d) => (tipo === 'neoforge' ? /neoforge/i.test(d) : /forge/i.test(d) && !/neoforge/i.test(d));
  const despues = carpetasDeVersiones(root);
  const id = despues.find((d) => !antes.has(d) && esDelTipo(d))
    || despues.find((d) => esDelTipo(d) && d.includes(inst.version.split('-').pop()));
  if (!id) throw new Error(`${nombre} se instaló pero no encontré su versión en la carpeta del juego.`);

  fs.writeFileSync(marca, JSON.stringify({ id }));
  return id;
}

module.exports = { prepararForge, resolverInstalador, versionesDeMaven, comparar, masNueva };
