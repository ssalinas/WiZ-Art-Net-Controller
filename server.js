const express = require('express');
const path = require('path');
const storage = require('./storage');
const { discoverWizFixtures } = require('./wiz-discovery');
const { spawn } = require('child_process');
const dgram = require('dgram');

const app = express();
const PORT = process.env.PORT || 3000;

// Art-Net daemon management
let artnetDaemon = null;
let restartCount = 0;
let lastRestartTime = null;
const MAX_RESTART_DELAY = 60000; // 60 seconds max backoff

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes

// Get all devices
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await storage.readAll();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a device by MAC address
app.get('/api/devices/:macAddress', async (req, res) => {
  try {
    const device = await storage.read(req.params.macAddress);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new device
app.post('/api/devices', async (req, res) => {
  try {
    const { macAddress, ipAddress, name, type, channel } = req.body;

    // Validation
    if (!macAddress || !ipAddress || !name || !type || channel === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const device = await storage.create({
      macAddress,
      ipAddress,
      name,
      type,
      channel
    });

    res.status(201).json(device);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update a device
app.put('/api/devices/:macAddress', async (req, res) => {
  try {
    const { ipAddress, name, type, channel } = req.body;

    const updates = {};
    if (ipAddress !== undefined) updates.ipAddress = ipAddress;
    if (name !== undefined) updates.name = name;
    if (type !== undefined) updates.type = type;
    if (channel !== undefined) updates.channel = channel;

    const device = await storage.update(req.params.macAddress, updates);
    res.json(device);
  } catch (err) {
    if (err.message === 'Device not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// Delete a device
app.delete('/api/devices/:macAddress', async (req, res) => {
  try {
    const deleted = await storage.remove(req.params.macAddress);
    if (!deleted) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discover WiZ fixtures
app.post('/api/discover', async (req, res) => {
  try {
    const timeout = req.body.timeout || 3000;
    const devices = await discoverWizFixtures(timeout);
    res.json({ discovered: devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Art-Net daemon status
app.get('/api/artnet/status', (req, res) => {
  res.json({
    running: artnetDaemon !== null && !artnetDaemon.killed,
    restartCount,
    lastRestartTime
  });
});

// Start Art-Net daemon
app.post('/api/artnet/start', (req, res) => {
  if (artnetDaemon && !artnetDaemon.killed) {
    return res.status(400).json({ error: 'Art-Net daemon already running' });
  }
  startArtNetDaemon();
  res.json({ message: 'Art-Net daemon started' });
});

// Stop Art-Net daemon
app.post('/api/artnet/stop', (req, res) => {
  if (!artnetDaemon || artnetDaemon.killed) {
    return res.status(400).json({ error: 'Art-Net daemon not running' });
  }
  stopArtNetDaemon();
  res.json({ message: 'Art-Net daemon stopped' });
});

// Identify a device by flashing it red
app.post('/api/devices/:macAddress/identify', async (req, res) => {
  try {
    const device = await storage.read(req.params.macAddress);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Start identify process (non-blocking)
    identifyDevice(device).catch(err => {
      console.error(`Error during identify for ${device.name}:`, err.message);
    });

    res.json({ message: `Identifying ${device.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper functions for WiZ communication

// Send getPilot to retrieve current state
function sendGetPilot(ipAddress, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const message = JSON.stringify({
      method: 'getPilot',
      params: {}
    });

    let responseReceived = false;

    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== ipAddress) {
        return;
      }

      try {
        const response = JSON.parse(msg.toString());
        if (response.method === 'getPilot' && response.result) {
          responseReceived = true;
          socket.close();
          resolve(response.result);
        }
      } catch (err) {
        // Ignore parse errors
      }
    });

    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });

    socket.send(message, 0, message.length, 38899, ipAddress, (err) => {
      if (err) {
        socket.close();
        reject(err);
      }
    });

    setTimeout(() => {
      if (!responseReceived) {
        socket.close();
        reject(new Error('getPilot timeout'));
      }
    }, timeout);
  });
}

// Send setPilot to control light
function sendSetPilot(ipAddress, params) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const message = JSON.stringify({
      id: 1,
      method: 'setPilot',
      params: params
    });

    socket.send(message, 0, message.length, 38899, ipAddress, (err) => {
      socket.close();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Identify device by flashing it red
async function identifyDevice(device) {
  try {
    console.log(`Starting identify for ${device.name} (${device.ipAddress})`);

    // Get current state
    const currentState = await sendGetPilot(device.ipAddress);
    console.log(`Current state for ${device.name}:`, currentState);

    // Flash red at full brightness
    await sendSetPilot(device.ipAddress, {
      r: 255,
      g: 0,
      b: 0,
      dimming: 100,
      state: true
    });

    console.log(`${device.name} flashing red...`);

    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Restore original state
    const restoreParams = {
      state: currentState.state || false
    };

    // Restore color settings if they exist
    if (currentState.r !== undefined) restoreParams.r = currentState.r;
    if (currentState.g !== undefined) restoreParams.g = currentState.g;
    if (currentState.b !== undefined) restoreParams.b = currentState.b;
    if (currentState.c !== undefined) restoreParams.c = currentState.c;
    if (currentState.w !== undefined) restoreParams.w = currentState.w;
    if (currentState.dimming !== undefined) restoreParams.dimming = currentState.dimming;
    if (currentState.temp !== undefined) restoreParams.temp = currentState.temp;
    if (currentState.sceneId !== undefined) restoreParams.sceneId = currentState.sceneId;

    await sendSetPilot(device.ipAddress, restoreParams);

    console.log(`${device.name} restored to original state`);
  } catch (err) {
    console.error(`Failed to identify ${device.name}:`, err.message);
    throw err;
  }
}

// Art-Net daemon management functions
function startArtNetDaemon() {
  artnetDaemon = spawn('node', ['artnet-daemon.js'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  artnetDaemon.stdout.on('data', (data) => {
    console.log(`[Art-Net Daemon] ${data.toString().trim()}`);
  });

  artnetDaemon.stderr.on('data', (data) => {
    console.error(`[Art-Net Daemon Error] ${data.toString().trim()}`);
  });

  artnetDaemon.on('exit', (code) => {
    console.log(`Art-Net daemon exited with code ${code}`);
    artnetDaemon = null;

    // Calculate backoff delay: exponential backoff with max limit
    const now = Date.now();
    if (lastRestartTime && (now - lastRestartTime) < 60000) {
      restartCount++;
    } else {
      restartCount = 0;
    }
    lastRestartTime = now;

    const delay = Math.min(Math.pow(2, restartCount) * 1000, MAX_RESTART_DELAY);
    console.log(`Restarting Art-Net daemon in ${delay}ms (restart count: ${restartCount})`);

    setTimeout(() => {
      startArtNetDaemon();
    }, delay);
  });

  console.log('Art-Net daemon started');
}

function stopArtNetDaemon() {
  if (artnetDaemon) {
    artnetDaemon.kill();
    artnetDaemon = null;
    restartCount = 0;
    console.log('Art-Net daemon stopped');
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Auto-start Art-Net daemon
  startArtNetDaemon();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  stopArtNetDaemon();
  process.exit(0);
});
