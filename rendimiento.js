const os = require('os');
const fs = require('fs');
const path = require('path');

// RAM según la compu: ni tan poca que se trabe, ni tanta que Windows se quede sin memoria.
function ramAutomatica() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb <= 4.5) return '2G';
  if (gb <= 6.5) return '3G';
  if (gb <= 9) return '4G';
  return '5G';
}

// Ajustes de Java para que el recolector de basura no genere tirones.
const JVM_POR_DEFECTO = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=100',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:G1NewSizePercent=30',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapRegionSize=8M',
];

// Opciones gráficas livianas. Solo se escriben la primera vez (si ya existe options.txt, no se toca).
const OPCIONES_INICIALES = [
  'renderDistance:8',
  'simulationDistance:8',
  'maxFps:60',
  'particles:1',
  'entityShadows:false',
  'entityDistanceScaling:0.75',
  'mipmapLevels:2',
  'biomeBlendRadius:1',
  'renderClouds:"false"',
  'fancyGraphics:false',
  'graphicsMode:0',
  'onboardAccessibility:false',
  'skipMultiplayerWarning:true',
  'joinedFirstServer:true',
  'tutorialStep:none',
];

function escribirOpcionesIniciales(root) {
  const archivo = path.join(root, 'options.txt');
  if (fs.existsSync(archivo)) return false;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(archivo, OPCIONES_INICIALES.join('\n') + '\n');
  return true;
}

module.exports = { ramAutomatica, JVM_POR_DEFECTO, OPCIONES_INICIALES, escribirOpcionesIniciales };
