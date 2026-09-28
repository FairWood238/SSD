let bleDevice, gattServer;
let epdService, epdCharacteristic;
let startTime, msgIndex, appVersion;
let canvas, ctx, textDecoder;

const EpdCmd = {
  SET_PINS: 0x00,
  INIT: 0x01,
  CLEAR: 0x02,
  SEND_CMD: 0x03,
  SEND_DATA: 0x04,
  REFRESH: 0x05,
  SLEEP: 0x06,

  SET_TIME: 0x20,

  WRITE_IMG: 0x30, // v1.6

  SET_CONFIG: 0x90,
  SYS_RESET: 0x91,
  SYS_SLEEP: 0x92,
  CFG_ERASE: 0x99,
};

function resetVariables() {
  gattServer = null;
  epdService = null;
  epdCharacteristic = null;
  msgIndex = 0;
  document.getElementById("log").value = '';
}

async function write(cmd, data, withResponse=true) {
  if (!epdCharacteristic) {
    addLog("Service unavailable, please check Bluetooth connection");
    return false;
  }
  let payload = [cmd];
  if (data) {
    if (typeof data == 'string') data = hex2bytes(data);
    if (data instanceof Uint8Array) data = Array.from(data);
    payload.push(...data)
  }
  addLog(bytes2hex(payload), '⇑');
  try {
    if (withResponse)
      await epdCharacteristic.writeValueWithResponse(Uint8Array.from(payload));
    else
      await epdCharacteristic.writeValueWithoutResponse(Uint8Array.from(payload));
  } catch (e) {
    console.error(e);
    if (e.message) addLog("write: " + e.message);
    return false;
  }
  return true;
}

async function epdWrite(cmd, data) {
  const chunkSize = document.getElementById('mtusize').value - 1;
  const interleavedCount = document.getElementById('interleavedcount').value;
  const count = Math.round(data.length / chunkSize);
  let chunkIdx = 0;
  let noReplyCount = interleavedCount;

  if (typeof data == 'string') data = hex2bytes(data);

  await write(EpdCmd.SEND_CMD, [cmd]);
  for (let i = 0; i < data.length; i += chunkSize) {
    let currentTime = (new Date().getTime() - startTime) / 1000.0;
    setStatus(`Command: 0x${cmd.toString(16)}, Data chunk: ${chunkIdx+1}/${count+1}, Total time: ${currentTime}s`);
    if (noReplyCount > 0) {
      await write(EpdCmd.SEND_DATA, data.slice(i, i + chunkSize), false);
      noReplyCount--;
    } else {
      await write(EpdCmd.SEND_DATA, data.slice(i, i + chunkSize), true);
      noReplyCount = interleavedCount;
    }
    chunkIdx++;
  }
}

async function epdWriteImage(step = 'bw') {
  const data = canvas2bytes(canvas, step);
  const chunkSize = document.getElementById('mtusize').value - 2;
  const interleavedCount = document.getElementById('interleavedcount').value;
  const count = Math.round(data.length / chunkSize);
  let chunkIdx = 0;
  let noReplyCount = interleavedCount;

  for (let i = 0; i < data.length; i += chunkSize) {
    let currentTime = (new Date().getTime() - startTime) / 1000.0;
    setStatus(`${step == 'bw'? 'BW' : 'Red'} chunk: ${chunkIdx+1}/${count+1}, Total time: ${currentTime}s`);
    const payload = [
      (step == 'bw'? 0x0F : 0x00) | ( i == 0? 0x00 : 0xF0),
     ...data.slice(i, i + chunkSize),
    ];
    if (noReplyCount > 0) {
      await write(EpdCmd.WRITE_IMG, payload, false);
      noReplyCount--;
    } else {
      await write(EpdCmd.WRITE_IMG, payload, true);
      noReplyCount = interleavedCount;
    }
    chunkIdx++;
  }
}

async function setDriver() {
  await write(EpdCmd.SET_PINS, document.getElementById("epdpins").value);
  await write(EpdCmd.INIT, document.getElementById("epddriver").value);
}

async function syncTime(mode) {
  const timestamp = new Date().getTime() / 1000;
  const data = new Uint8Array([
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF,
    -(new Date().getTimezoneOffset() / 60),
    mode
  ]);
  if(await write(EpdCmd.SET_TIME, data)) {
    addLog("Time synchronized!");
    addLog("Please do not operate before the screen refresh is complete.");
  }
}

async function clearScreen() {
  if(confirm('Confirm clear screen content?')) {
    await write(EpdCmd.CLEAR);
    addLog("Clear screen command sent!");
    addLog("Please do not operate before the screen refresh is complete.");
  }
}

async function sendcmd() {
  const cmdTXT = document.getElementById('cmdTXT').value;
  if (cmdTXT == '') return;
  const bytes = hex2bytes(cmdTXT);
  await write(bytes[0], bytes.length > 1? bytes.slice(1) : null);
}

async function sendimg() {
  const status = document.getElementById("status");
  const driver = document.getElementById("epddriver").value;
  const mode = document.getElementById('dithering').value;

  startTime = new Date().getTime();
  status.parentElement.style.display = "block";

  if (appVersion < 0x16) {
    if (mode.startsWith('bwr')) {
      await epdWrite(driver === "02"? 0x24 : 0x10, canvas2bytes(canvas, 'bw'));
      await epdWrite(driver === "02"? 0x26 : 0x13, canvas2bytes(canvas, 'red', driver === '02'));
    } else {
      await epdWrite(driver === "04"? 0x24 : 0x13, canvas2bytes(canvas, 'bw'));
    }
  } else {
    await epdWriteImage('bw');
    if (mode.startsWith('bwr')) await epdWriteImage('red');
  }

  await write(EpdCmd.REFRESH);

  const sendTime = (new Date().getTime() - startTime) / 1000.0;
  addLog(`Transmission complete! Time elapsed: ${sendTime}s`);
  setStatus(`Transmission complete! Time elapsed: ${sendTime}s`);
  addLog("Please do not operate before the screen refresh is complete.");
  setTimeout(() => {
    status.parentElement.style.display = "none";
  }, 5000);
}

function updateButtonStatus() {
  const connected = gattServer!= null && gattServer.connected;
  const status = connected? null : 'disabled';
  document.getElementById("reconnectbutton").disabled = (gattServer == null || gattServer.connected)? 'disabled' : null;
  document.getElementById("sendcmdbutton").disabled = status;
  document.getElementById("calendarmodebutton").disabled = status;
  document.getElementById("clockmodebutton").disabled = status;
  document.getElementById("clearscreenbutton").disabled = status;
  document.getElementById("sendimgbutton").disabled = status;
  document.getElementById("setDriverbutton").disabled = status;
}

function disconnect() {
  updateButtonStatus();
  resetVariables();
  addLog('Disconnected.');
  document.getElementById("connectbutton").innerHTML = 'Connect';
}

async function preConnect() {
  if (gattServer!= null && gattServer.connected) {
    if (bleDevice!= null && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
  }
  else {
    //... (original device request / filter logic remains here, no Chinese in this section)
    resetVariables();
    try {
      bleDevice = await navigator.bluetooth.requestDevice({
        optionalServices: ['62750001-d828-918d-fb46-b6c11c675aec'],
        acceptAllDevices: true
      });
    } catch (e) {
      console.error(e);
      if (e.message) addLog("requestDevice: " + e.message);
      addLog("Please ensure Bluetooth is turned on and supported by your browser. Recommended browsers:");
      addLog("• Computer: Chrome/Edge");
      addLog("• Android: Chrome/Edge");
      addLog("• iOS: Bluefy browser");
      return;
    }

    await bleDevice.addEventListener('gattserverdisconnected', disconnect);
    setTimeout(async function () { await connect(); }, 300);
  }
}
async function reConnect() {
  if (bleDevice != null && bleDevice.gatt.connected)
    bleDevice.gatt.disconnect();
  resetVariables();
  addLog("Reconnecting");
  setTimeout(async function () { await connect(); }, 300);
}

// --- handleNotify section ---
function handleNotify(data, idx) {
  data = new Uint8Array(data.buffer);
  if (idx == 0) {
    addLog(`Received config: ${bytes2hex(data)}`);
    const epdpins = document.getElementById("epdpins");
    const epddriver = document.getElementById("epddriver");
    epdpins.value = bytes2hex(data.slice(0, 7));
    if (data.length > 10) epdpins.value += bytes2hex(data.slice(10, 11));
    epddriver.value = bytes2hex(data.slice(7, 8));
    filterDitheringOptions();
  } else {
    if (textDecoder == null) textDecoder = new TextDecoder();
    addLog(textDecoder.decode(data), '⇓');
  }
}

async function connect() {
  if (bleDevice == null || epdCharacteristic!= null) return;

  try {
    addLog("Connecting to: " + bleDevice.name);
    gattServer = await bleDevice.gatt.connect();
    addLog(' Found GATT Server');
    epdService = await gattServer.getPrimaryService('62750001-d828-918d-fb46-b6c11c675aec');
    addLog(' Found EPD Service');
    epdCharacteristic = await epdService.getCharacteristic('62750002-d828-918d-fb46-b6c11c675aec');
    addLog(' Found Characteristic');
  } catch (e) {
    console.error(e);
    if (e.message) addLog("connect: " + e.message);
    disconnect();
    return;
  }

  try {
    const versionCharacteristic = await epdService.getCharacteristic('62750003-d828-918d-fb46-b6c11c675aec');
    const versionData = await versionCharacteristic.readValue();
    appVersion = versionData.getUint8(0);
    addLog(`Firmware version: 0x${appVersion.toString(16)}`);
  } catch (e) {
    console.error(e);
    appVersion = 0x15;
  }

  try {
    await epdCharacteristic.startNotifications();
    epdCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      handleNotify(event.target.value, msgIndex++);
    });
  } catch (e) {
    console.error(e);
    if (e.message) addLog("startNotifications: " + e.message);
  }

  await write(EpdCmd.INIT);

  document.getElementById("connectbutton").innerHTML = 'Disconnect';
  updateButtonStatus();
}

function setStatus(statusText) {
  document.getElementById("status").innerHTML = statusText;
}

function addLog(logTXT, action = '') {
  const log = document.getElementById("log");
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ":" +
         String(now.getMinutes()).padStart(2, '0') + ":" +
         String(now.getSeconds()).padStart(2, '0') + " ";

  const logEntry = document.createElement('div');
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  logEntry.appendChild(timeSpan);

  if (action!== '') {
    const actionSpan = document.createElement('span');
    actionSpan.className = 'action';
    actionSpan.innerHTML = action;
    logEntry.appendChild(actionSpan);
  }
  logEntry.appendChild(document.createTextNode(logTXT));

  log.appendChild(logEntry);
  log.scrollTop = log.scrollHeight;

  while (log.childNodes.length > 20) {
    log.removeChild(log.firstChild);
  }
}

function clearLog() {
  document.getElementById("log").innerHTML = '';
}

function hex2bytes(hex) {
  for (var bytes = [], c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}

function bytes2hex(data) {
  return new Uint8Array(data).reduce(
    function (memo, i) {
      return memo + ("0" + i.toString(16)).slice(-2);
    }, "");
}

function intToHex(intIn) {
  let stringOut = ("0000" + intIn.toString(16)).substr(-4)
  return stringOut.substring(2, 4) + stringOut.substring(0, 2);
}

async function update_image(clear = false) {
  const image_file = document.getElementById('image_file');
  if (image_file.files.length == 0) return;

  if (clear) clear_canvas();

  const file = image_file.files[0];
  let image = new Image();;
  image.src = URL.createObjectURL(file);
  image.onload = function(event) {
    URL.revokeObjectURL(this.src);
    ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);
    convert_dithering()
  }
}

function clear_canvas() {
  if (confirm('Clear existing canvas content?')) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return true;
  }
  return false;
}

function convert_dithering() {
  const mode = document.getElementById('dithering').value;
  if (mode === '') return;

  if (mode.startsWith('bwr')) {
    ditheringCanvasByPalette(canvas, bwrPalette, mode);
  } else {
    dithering(ctx, canvas.width, canvas.height, parseInt(document.getElementById('threshold').value), mode);
  }
}

function filterDitheringOptions() {
  const driver = document.getElementById('epddriver').value;
  const dithering = document.getElementById('dithering');
  let currentOptionStillValid = false;
  let lastValidOptionValue = null;

  for (let optgroup of dithering.getElementsByTagName('optgroup')) {
    const drivers = optgroup.getAttribute('data-driver').split('|');
    const show = drivers.includes(driver);
    for (option of optgroup.getElementsByTagName('option')) {
      if (show) {
        option.removeAttribute('disabled');
        if (option.value == dithering.value) currentOptionStillValid = true;
        lastValidOptionValue = option.value;
      } else {
        option.setAttribute('disabled', 'disabled');
      }
    }
  }
  if (!currentOptionStillValid) dithering.value = lastValidOptionValue;
}

function checkDebugMode() {
  const link = document.getElementById('debug-toggle');
  const urlParams = new URLSearchParams(window.location.search);
  const debugMode = urlParams.get('debug');

  if (debugMode === 'true') {
      document.body.classList.add('debug-mode');
      link.innerHTML = 'Normal mode';
      link.setAttribute('href', window.location.pathname);
      addLog("Note: Developer mode is enabled! Do not modify arbitrarily if you don't understand, otherwise you are responsible for the consequences!");
  } else {
      document.body.classList.remove('debug-mode');
      link.innerHTML = 'Developer mode';
      link.setAttribute('href', window.location.pathname + '?debug=true');
  }
}

document.body.onload = () => {
  textDecoder = null;
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext("2d");

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  updateButtonStatus();
  checkDebugMode();
}
